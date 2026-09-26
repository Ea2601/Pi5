import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import { promises as dnsPromises } from 'dns';
import sqlite3 from 'sqlite3';
import { shq } from './util';

const execAsync = promisify(exec);
export const isLinux = os.platform() === 'linux';

// systemd unit names: letters, digits, and @ . _ - only. Blocks shell metacharacters.
const VALID_UNIT = /^[A-Za-z0-9@._-]+$/;

// Safe exec — returns stdout or empty string on error. Never returns fake data.
async function run(cmd: string, timeout: number = 10000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  } catch {
    return '';
  }
}

// Ayrıntılı çalıştırma: run() sıfır olmayan çıkışta stdout'u da atar (ör. `systemctl status` 3 ile çıkar); başarı/durum
// bilgisi gereken yerler bunu kullanır. Asla fırlatmaz. code: 0 başarı; null → öldürüldü, çıktı sınırı ya da başlatılamadı.
export interface RunResult { stdout: string; stderr: string; code: number | null; signal: string | null; timedOut: boolean; truncated: boolean }
export async function runResult(cmd: string, timeout = 10000, maxBuffer = 1024 * 1024): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer });
    return { stdout: String(stdout), stderr: String(stderr), code: 0, signal: null, timedOut: false, truncated: false };
  } catch (e: any) {
    const truncated = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const code = typeof e?.code === 'number' ? e.code : null;
    const timedOut = e?.killed === true && !truncated;
    let stderr = String(e?.stderr ?? '');
    if (!stderr && code === null && !timedOut && !truncated) stderr = String(e?.message ?? '');
    return { stdout: String(e?.stdout ?? ''), stderr, code, signal: e?.signal ?? null, timedOut, truncated };
  }
}

// ─── Pi-hole v6 (FTL) direct-DB access ───
// Pi-hole v6 removed the legacy admin/api.php; its REST API needs the embedded FTL
// webserver + auth (which collides with our nginx on :80). Reading the FTL SQLite DB
// directly is version-proof and needs no webserver/port/auth. Backend runs as root.
export const FTL_DB = '/etc/pihole/pihole-FTL.db';
const GRAVITY_DB = '/etc/pihole/gravity.db';
// FTL query status codes that mean "blocked" (gravity/blacklist/regex/upstream/special).
const BLOCKED_STATUS = [1, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16];
const FORWARDED_STATUS = [2, 14];
const CACHED_STATUS = [3, 17];
// FTL numeric query types → labels.
const FTL_TYPE_MAP: Record<number, string> = {
  1: 'A', 2: 'AAAA', 3: 'ANY', 4: 'SRV', 5: 'SOA', 6: 'PTR', 7: 'TXT',
  8: 'NAPTR', 9: 'MX', 10: 'DS', 11: 'RRSIG', 12: 'DNSKEY', 13: 'NS',
  14: 'OTHER', 15: 'SVCB', 16: 'HTTPS',
};

// Read-only query against an external SQLite DB. Returns [] on any error (missing file,
// locked, schema mismatch) so callers can transparently fall back.
function readOnlyQuery(dbPath: string, sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve) => {
    if (!fs.existsSync(dbPath)) return resolve([]);
    const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve([]);
      d.all(sql, params, (e, rows) => {
        d.close(() => {});
        resolve(e ? [] : (rows || []));
      });
    });
  });
}

const startOfTodayEpoch = () => Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

// ─── 1. System Stats ───
// Always real on Linux. On non-Linux returns zeros (frontend handles empty state).
let lastDiskReading: { time: number; read: number; write: number } | null = null;

export async function getSystemStats() {
  if (!isLinux) {
    return {
      cpuTemp: 0, cpuUsage: 0, memoryTotal: 0, memoryUsed: 0,
      diskTotal: 0, diskUsed: 0, disks: [], uptime: 0, loadAvg: [0, 0, 0],
      diskRead: 0, diskWrite: 0, fanSpeed: 0,
    };
  }

  let cpuTemp = 0;
  try {
    const t = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    cpuTemp = Math.round(parseInt(t.trim(), 10) / 100) / 10;
  } catch { /* */ }

  let cpuUsage = 0;
  try {
    const readStat = async () => {
      const s = await fs.promises.readFile('/proc/stat', 'utf8');
      const parts = s.split('\n')[0].split(/\s+/).slice(1).map(Number);
      return { idle: parts[3] + (parts[4] || 0), total: parts.reduce((a, b) => a + b, 0) };
    };
    const s1 = await readStat();
    await new Promise(r => setTimeout(r, 200));
    const s2 = await readStat();
    const dt = s2.total - s1.total;
    cpuUsage = dt > 0 ? Math.round((1 - (s2.idle - s1.idle) / dt) * 1000) / 10 : 0;
  } catch { /* */ }

  let memoryTotal = 0, memoryUsed = 0;
  try {
    const m = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const g = (k: string) => { const r = m.match(new RegExp(`${k}:\\s+(\\d+)`)); return r ? parseInt(r[1]) : 0; };
    const totalKb = g('MemTotal'), availKb = g('MemAvailable');
    memoryTotal = Math.round(totalKb / 1024);
    memoryUsed = Math.round((totalKb - availKb) / 1024);
  } catch { /* */ }

  // Disk — tüm fiziksel diskleri topla (SD kart + SSD/NVMe)
  let diskTotal = 0, diskUsed = 0;
  const disks: { mount: string; device: string; total: number; used: number }[] = [];
  try {
    const df = await run('df -B1 --output=source,size,used,target -x tmpfs -x devtmpfs -x squashfs');
    for (const line of df.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 4 && p[0].startsWith('/dev/')) {
        const t = Math.round(parseInt(p[1]) / 1073741824);
        const u = Math.round(parseInt(p[2]) / 1073741824);
        disks.push({ device: p[0], total: t, used: u, mount: p.slice(3).join(' ') });
        diskTotal += t;
        diskUsed += u;
      }
    }
  } catch { /* */ }

  let uptime = 0;
  try { uptime = Math.floor(parseFloat((await fs.promises.readFile('/proc/uptime', 'utf8')).split(' ')[0])); } catch { /* */ }

  let loadAvg: number[] = [0, 0, 0];
  try {
    const l = (await fs.promises.readFile('/proc/loadavg', 'utf8')).split(' ');
    loadAvg = [parseFloat(l[0]), parseFloat(l[1]), parseFloat(l[2])];
  } catch { /* */ }

  // Disk I/O (MB/s) — delta of sectors read/written across physical disks
  let diskRead = 0, diskWrite = 0;
  try {
    const now = Date.now();
    const content = await fs.promises.readFile('/proc/diskstats', 'utf8');
    let sectorsRead = 0, sectorsWritten = 0;
    for (const line of content.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const dev = f[2];
      if (!/^(mmcblk\d+|nvme\d+n\d+|sd[a-z])$/.test(dev)) continue; // whole disks only
      sectorsRead += parseInt(f[5]) || 0;   // sectors read
      sectorsWritten += parseInt(f[9]) || 0; // sectors written
    }
    if (lastDiskReading) {
      const elapsed = (now - lastDiskReading.time) / 1000;
      if (elapsed > 0) {
        diskRead = Math.max(0, ((sectorsRead - lastDiskReading.read) * 512) / 1048576 / elapsed);
        diskWrite = Math.max(0, ((sectorsWritten - lastDiskReading.write) * 512) / 1048576 / elapsed);
      }
    }
    lastDiskReading = { time: now, read: sectorsRead, write: sectorsWritten };
  } catch { /* */ }

  // Fan speed (RPM) — Pi5 cooling fan hwmon, best-effort
  let fanSpeed = 0;
  try {
    const hwmonDirs = await fs.promises.readdir('/sys/class/hwmon');
    for (const d of hwmonDirs) {
      try {
        const rpm = await fs.promises.readFile(`/sys/class/hwmon/${d}/fan1_input`, 'utf8');
        const v = parseInt(rpm.trim(), 10);
        if (!isNaN(v)) { fanSpeed = v; break; }
      } catch { /* */ }
    }
  } catch { /* */ }

  return {
    cpuTemp, cpuUsage, memoryTotal, memoryUsed, diskTotal, diskUsed, disks, uptime, loadAvg,
    diskRead: Math.round(diskRead * 100) / 100, diskWrite: Math.round(diskWrite * 100) / 100, fanSpeed,
  };
}

// ─── 1b. Metric History Sampler ───
// One backend snapshot per tick, stored to disk (see index.ts recorder) so the dashboard
// chart survives page refreshes. Network/disk rates use their OWN counter baselines here so
// they stay consistent regardless of how often the live /system/stats & /bandwidth/live
// endpoints are polled (those keep separate baselines).
export interface MetricSample {
  cpuTemp: number; cpuUsage: number; memoryUsage: number;
  networkIn: number; networkOut: number; diskRead: number; diskWrite: number; fanSpeed: number;
}
let samplerNet: { time: number; rx: number; tx: number } | null = null;
let samplerDisk: { time: number; read: number; write: number } | null = null;

export async function sampleMetrics(): Promise<MetricSample | null> {
  if (!isLinux) return null;
  const stats = await getSystemStats(); // cpuTemp/cpuUsage/mem/fan (self-contained deltas)

  // Network throughput (Mbps) — sum of all non-lo interfaces, sampler-local baseline.
  let networkIn = 0, networkOut = 0;
  try {
    const c = await fs.promises.readFile('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of c.split('\n').slice(2)) {
      const m = line.trim().match(/^(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (m && m[1] !== 'lo') { rx += parseInt(m[2]); tx += parseInt(m[3]); }
    }
    const now = Date.now();
    if (samplerNet) {
      const el = (now - samplerNet.time) / 1000;
      if (el > 0) {
        networkIn = Math.max(0, Math.round(((rx - samplerNet.rx) * 8 / 1e6 / el) * 100) / 100);
        networkOut = Math.max(0, Math.round(((tx - samplerNet.tx) * 8 / 1e6 / el) * 100) / 100);
      }
    }
    samplerNet = { time: now, rx, tx };
  } catch { /* */ }

  // Disk I/O (MB/s) — sampler-local baseline.
  let diskRead = 0, diskWrite = 0;
  try {
    const content = await fs.promises.readFile('/proc/diskstats', 'utf8');
    let sr = 0, sw = 0;
    for (const line of content.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      if (!/^(mmcblk\d+|nvme\d+n\d+|sd[a-z])$/.test(f[2])) continue;
      sr += parseInt(f[5]) || 0; sw += parseInt(f[9]) || 0;
    }
    const now = Date.now();
    if (samplerDisk) {
      const el = (now - samplerDisk.time) / 1000;
      if (el > 0) {
        diskRead = Math.max(0, ((sr - samplerDisk.read) * 512) / 1048576 / el);
        diskWrite = Math.max(0, ((sw - samplerDisk.write) * 512) / 1048576 / el);
      }
    }
    samplerDisk = { time: now, read: sr, write: sw };
  } catch { /* */ }

  const memoryUsage = stats.memoryTotal > 0 ? Math.round((stats.memoryUsed / stats.memoryTotal) * 1000) / 10 : 0;
  return {
    cpuTemp: stats.cpuTemp, cpuUsage: stats.cpuUsage, memoryUsage,
    networkIn, networkOut,
    diskRead: Math.round(diskRead * 100) / 100, diskWrite: Math.round(diskWrite * 100) / 100,
    fanSpeed: stats.fanSpeed || 0,
  };
}

// ─── 2. Service Status ───
// Panelin yönettiği servisler — TEK kaynak ve izin listesi (DB adı → systemd birimi). Eskiden dört ayrı kopya vardı ve
// `|| name` geri dönüşü her birimi (ssh, nginx, pi5-backend…) API'ye açıyordu. 'wireguard' tek bir birim değil:
// Pi'deki wg_vps<ID> tünellerinin toplamı (wg0 Pi'de yoktur).
export type ServiceName = 'pihole' | 'unbound' | 'zapret' | 'fail2ban' | 'nftables' | 'wireguard';
export type ServiceStatusValue = 'running' | 'stopped' | 'error' | 'restarting' | 'not_installed';
export const MANAGED_SERVICE_UNITS: Readonly<Record<ServiceName, string | null>> = Object.freeze({
  pihole: 'pihole-FTL', unbound: 'unbound', zapret: 'zapret', fail2ban: 'fail2ban', nftables: 'nftables', wireguard: null,
});
export const MANAGED_SERVICE_NAMES = Object.keys(MANAGED_SERVICE_UNITS) as ServiceName[];
// Aç/kapa yalnız arayüzün gönderdiği 4 servis: nftables'ı durdurmak `nft flush ruleset` ile tüm firewall'u (+ routing,
// cihaz engeli, fail2ban tabloları) siler; WireGuard tünelleri VPS sayfasından yönetilir. Yeniden başlatma: 6'sı da.
export const TOGGLEABLE_SERVICES: readonly ServiceName[] = ['pihole', 'unbound', 'zapret', 'fail2ban'];
export const isManagedService = (n: unknown): n is ServiceName =>
  typeof n === 'string' && Object.prototype.hasOwnProperty.call(MANAGED_SERVICE_UNITS, n);
// pihole-FTL süreleri routing kuyruğuyla aynı (withFtlStopped / waitFtlHealthy): durdurma ya da başlatma 90 sn'ye,
// DNS'in gelmesi 120 sn'ye kadar sürebilir (FTL :53'ü son 24 saatin sorgularını yükledikten sonra açar).
export const FTL_SYSTEMCTL_TIMEOUT = 90000;
export const FTL_SETTLE_TIMEOUT = 120000;

export interface UnitState {
  unit: string; load: string; active: string; sub: string; fileState: string; restarts: number;
  bootEnabled: boolean; status: ServiceStatusValue; probeFailed: boolean; detail: string;
}
// systemd durumu → panel durumu. 'error' = çöktü (failed) ya da yeniden başlatma döngüsü (auto-restart[-queued]).
export function mapUnitStatus(load: string, active: string, sub: string): ServiceStatusValue {
  if (load === 'not-found') return 'not_installed';
  if (!load || load === 'error' || load === 'bad-setting') return 'error';
  if (active === 'active' || active === 'reloading') return 'running';
  if (active === 'failed') return 'error';
  if (active === 'activating') return /^auto-restart/.test(sub) ? 'error' : 'restarting';
  if (active === 'deactivating') return 'restarting';
  return 'stopped'; // inactive (masked dahil)
}

// `systemctl show` ile toplu okuma (tek süreç, her zaman 0 ile çıkar; is-active durmuşta 3 ile çıkıp run()'da kayboluyordu).
// Komutun kendisi başarısızsa birimler probeFailed işaretlenir: "durum okunamadı" demektir, "servis çöktü" değil.
export async function getUnitStates(units: string[]): Promise<Record<string, UnitState>> {
  const out: Record<string, UnitState> = {};
  const blank = (unit: string, detail: string, probeFailed: boolean): UnitState => ({
    unit, load: '', active: '', sub: '', fileState: '', restarts: 0, bootEnabled: false, status: 'error', probeFailed, detail,
  });
  const valid = [...new Set(units)].filter(u => VALID_UNIT.test(u));
  for (const u of units) if (!VALID_UNIT.test(u)) out[u] = blank(u, 'geçersiz birim adı', false);
  if (!valid.length) return out;
  const r = await runResult(`systemctl show -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p NRestarts -p Job ${valid.join(' ')}`);
  if (r.code !== 0 || r.timedOut) {
    for (const u of valid) out[u] = blank(u, r.stderr.trim() || 'durum okunamadı', true);
    return out;
  }
  const byId = new Map<string, Record<string, string>>();
  const blocks = r.stdout.trim().split(/\n\s*\n/).map(b => {
    const kv: Record<string, string> = {};
    for (const line of b.split('\n')) { const k = line.indexOf('='); if (k > 0) kv[line.slice(0, k)] = line.slice(k + 1).trim(); }
    if (kv.Id) byId.set(kv.Id.replace(/\.service$/, ''), kv);
    return kv;
  });
  valid.forEach((u, i) => {
    const kv = byId.get(u.replace(/\.service$/, '')) || blocks[i] || {};
    const load = kv.LoadState || '';
    const active = kv.ActiveState || '';
    const sub = kv.SubState || '';
    const fileState = kv.UnitFileState || '';
    // Bekleyen başlatma işi (ör. açılışta network-online'ı bekleyen birim) iş çalışana dek 'inactive' görünür → durmuş değil.
    const queued = active === 'inactive' && Number(kv.Job) > 0;
    out[u] = {
      unit: u, load, active, sub, fileState, restarts: Number(kv.NRestarts) || 0,
      bootEnabled: ['enabled', 'enabled-runtime', 'generated'].includes(fileState),
      status: queued ? 'restarting' : mapUnitStatus(load, active, sub), probeFailed: !load,
      detail: queued ? 'başlatma sırada bekliyor' : load === 'masked' ? 'masked' : '',
    };
  });
  return out;
}

// Pi'deki WireGuard tünelleri: /etc/wireguard/wg_vps<ID>.conf + arayüz (panel bağlantısı wg-quick'i doğrudan çalıştırdığı
// için birim 'inactive' kalabilir — ayakta olup olmadığı arayüzden okunur).
export interface WgTunnel { iface: string; unit: string; up: boolean; state: UnitState }
export async function listWireguardTunnels(): Promise<WgTunnel[]> {
  let ifaces: string[] = [];
  try {
    ifaces = fs.readdirSync('/etc/wireguard').map(f => /^(wg_vps\d+)\.conf$/.exec(f)?.[1]).filter((x): x is string => !!x);
  } catch { /* dizin yok */ }
  if (!ifaces.length) return [];
  const units = ifaces.map(i => `wg-quick@${i}`);
  const st = await getUnitStates(units);
  return ifaces.map((iface, k) => ({ iface, unit: units[k], up: fs.existsSync(`/sys/class/net/${iface}`), state: st[units[k]] }));
}

export interface ServiceState {
  name: ServiceName; status: ServiceStatusValue; unit: string; active_state: string; sub_state: string;
  boot_enabled: boolean; restarts: number; detail: string; probe_failed: boolean;
  tunnels?: { iface: string; up: boolean; status: ServiceStatusValue; active_state: string; sub_state: string; boot_enabled: boolean }[];
}
export async function getServiceStates(names: ServiceName[]): Promise<Partial<Record<ServiceName, ServiceState>>> {
  const res: Partial<Record<ServiceName, ServiceState>> = {};
  const unitNames = names.filter(n => MANAGED_SERVICE_UNITS[n]);
  const st = await getUnitStates(unitNames.map(n => MANAGED_SERVICE_UNITS[n]!));
  for (const n of unitNames) {
    const u = st[MANAGED_SERVICE_UNITS[n]!];
    let status = u.status;
    let detail = u.detail;
    // Routing değişikliğinde FTL bilerek durdurulup başlatılır (withFtlStopped) — o pencere "çöktü" değil.
    if (n === 'pihole' && status !== 'running' && fs.existsSync(FTL_RESTART_INPROGRESS)) { status = 'restarting'; detail = 'DNS yeniden başlatılıyor'; }
    // Firewall kurulumu birimi yalnız enable eder, kuralları `nft -f` ile yükler: kurallar yüklüyse çalışıyor sayılır.
    if (n === 'nftables' && status === 'stopped' && (await runResult('nft list table inet pi5_filter', 5000)).code === 0) {
      status = 'running'; detail = 'kurallar yüklü (birim pasif)';
    }
    res[n] = { name: n, status, unit: u.unit, active_state: u.active, sub_state: u.sub, boot_enabled: u.bootEnabled,
      restarts: u.restarts, detail, probe_failed: u.probeFailed };
  }
  if (names.includes('wireguard')) {
    const tunnels = await listWireguardTunnels();
    let status: ServiceStatusValue = 'not_installed';
    let detail = 'tünel yapılandırması yok';
    if (tunnels.length) {
      const up = tunnels.filter(t => t.up).length;
      if (up) { status = 'running'; detail = `${up}/${tunnels.length} tünel ayakta`; }
      else if (tunnels.some(t => t.state.status === 'error' && !t.state.probeFailed)) { status = 'error'; detail = 'tünel başlatılamadı'; }
      else if (tunnels.some(t => t.state.status === 'restarting')) { status = 'restarting'; detail = 'tünel açılıyor'; }
      else { status = 'stopped'; detail = `0/${tunnels.length} tünel ayakta`; }
    }
    res.wireguard = {
      name: 'wireguard', status, unit: 'wg-quick@wg_vps*', active_state: '', sub_state: '',
      boot_enabled: tunnels.some(t => t.state.bootEnabled), restarts: 0, detail,
      probe_failed: tunnels.some(t => t.state.probeFailed),
      tunnels: tunnels.map(t => ({ iface: t.iface, up: t.up, status: t.state.status, active_state: t.state.active, sub_state: t.state.sub, boot_enabled: t.state.bootEnabled })),
    };
  }
  return res;
}

// Eski imza korunur ('' = Linux değil). Bilinmeyen ad kabuk komutuna hiç ulaşmaz.
export async function getServiceStatus(name: string): Promise<string> {
  if (!isLinux) return '';
  if (!isManagedService(name)) return 'not_installed';
  return (await getServiceStates([name]))[name]?.status || 'error';
}

// Aç/kapa/yeniden başlat sonrası servisin oturmasını bekler (Type=simple birimde `systemctl start` 0 dönmesi ayakta
// kaldığını kanıtlamaz). 'running' için stableMs boyunca kesintisiz çalışmalı, NRestarts artarsa döngü sayılır;
// Pi-hole'da ayrıca DNS'in gerçekten cevap vermesi beklenir (FTL :53'ü veritabanını yükledikten sonra açar).
export async function waitServiceSettled(name: ServiceName, expect: 'running' | 'stopped', timeoutMs: number, stableMs = 3000): Promise<ServiceState> {
  const deadline = Date.now() + timeoutMs;
  let baseRestarts: number | null = null;
  let runningSince = 0;
  let st = (await getServiceStates([name]))[name]!;
  for (;;) {
    if (expect === 'stopped') {
      if (st.status !== 'running' && st.status !== 'restarting') return st;
    } else {
      if (st.status === 'error' || st.status === 'not_installed') return st;
      if (st.status === 'running') {
        if (baseRestarts === null) baseRestarts = st.restarts;
        else if (st.restarts > baseRestarts) return { ...st, status: 'error', detail: 'yeniden başlatma döngüsü' };
        if (!runningSince) runningSince = Date.now();
        if (Date.now() - runningSince >= stableMs) {
          if (name !== 'pihole' || await waitLocalDns(Math.max(1000, deadline - Date.now()))) return st;
          return { ...st, status: 'error', detail: 'Pi-hole çalışıyor ama DNS cevap vermiyor' };
        }
      } else {
        runningSince = 0;
      }
    }
    if (Date.now() >= deadline) return st;
    await new Promise(r => setTimeout(r, 1000));
    st = (await getServiceStates([name]))[name]!;
  }
}

// ─── 3. Pi-hole Stats ───
// Returns null if Pi-hole is not installed/accessible.
export interface PiholeStats {
  domainsBlocked: number; dnsQueriesToday: number; adsBlockedToday: number;
  adsPercentageToday: number; uniqueClients: number; queriesForwarded: number;
  queriesCached: number; topBlockedDomains: { domain: string; count: number }[];
  queryTypes: Record<string, number>;
}

// Primary: read the Pi-hole v6 FTL SQLite DB directly (version-proof, no webserver/auth).
// Falls back to the legacy v5 admin/api.php only if the DB is unavailable.
export async function getPiholeStats(): Promise<PiholeStats | null> {
  if (!isLinux) return null;

  const midnight = startOfTodayEpoch();
  const summaryRows = await readOnlyQuery(FTL_DB,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN (${BLOCKED_STATUS.join(',')}) THEN 1 ELSE 0 END) AS blocked,
       SUM(CASE WHEN status IN (${FORWARDED_STATUS.join(',')}) THEN 1 ELSE 0 END) AS forwarded,
       SUM(CASE WHEN status IN (${CACHED_STATUS.join(',')}) THEN 1 ELSE 0 END) AS cached,
       COUNT(DISTINCT client) AS clients
     FROM queries WHERE timestamp >= ?`, [midnight]);

  if (summaryRows.length && summaryRows[0].total !== null && summaryRows[0].total !== undefined) {
    const s = summaryRows[0];
    const total = s.total || 0;
    const blocked = s.blocked || 0;

    const gravityRows = await readOnlyQuery(GRAVITY_DB, 'SELECT COUNT(*) AS c FROM gravity');
    const topRows = await readOnlyQuery(FTL_DB,
      `SELECT domain, COUNT(*) AS c FROM queries
       WHERE timestamp >= ? AND status IN (${BLOCKED_STATUS.join(',')})
       GROUP BY domain ORDER BY c DESC LIMIT 5`, [midnight]);
    const typeRows = await readOnlyQuery(FTL_DB,
      'SELECT type, COUNT(*) AS c FROM queries WHERE timestamp >= ? GROUP BY type', [midnight]);

    const queryTypes: Record<string, number> = {};
    for (const r of typeRows) queryTypes[FTL_TYPE_MAP[r.type] || `TYPE${r.type}`] = r.c;

    return {
      domainsBlocked: gravityRows[0]?.c || 0,
      dnsQueriesToday: total,
      adsBlockedToday: blocked,
      adsPercentageToday: total > 0 ? Math.round((blocked / total) * 1000) / 10 : 0,
      uniqueClients: s.clients || 0,
      queriesForwarded: s.forwarded || 0,
      queriesCached: s.cached || 0,
      topBlockedDomains: topRows.map(r => ({ domain: r.domain, count: r.c })),
      queryTypes,
    };
  }

  return getPiholeStatsViaLegacyApi();
}

// Legacy Pi-hole v5 API (admin/api.php). Returns null on v6/headless installs.
async function getPiholeStatsViaLegacyApi(): Promise<PiholeStats | null> {
  let summary: any = null;
  try {
    const r = await fetch('http://127.0.0.1/admin/api.php?summaryRaw');
    if (r.ok) summary = await r.json();
  } catch { /* */ }
  if (!summary) return null;

  let topBlockedDomains: { domain: string; count: number }[] = [];
  try {
    const r = await fetch('http://127.0.0.1/admin/api.php?topItems=5');
    if (r.ok) {
      const d = await r.json();
      if (d.top_ads) topBlockedDomains = Object.entries(d.top_ads).map(([domain, count]) => ({ domain, count: count as number }));
    }
  } catch { /* */ }

  let queryTypes: Record<string, number> = {};
  try {
    const r = await fetch('http://127.0.0.1/admin/api.php?getQueryTypes');
    if (r.ok) {
      const d = await r.json();
      if (d.querytypes) for (const [k, v] of Object.entries(d.querytypes)) queryTypes[k.replace(/\s*\(.*\)/, '')] = Math.round(v as number);
    }
  } catch { /* */ }

  return {
    domainsBlocked: summary.domains_being_blocked ?? 0,
    dnsQueriesToday: summary.dns_queries_today ?? 0,
    adsBlockedToday: summary.ads_blocked_today ?? 0,
    adsPercentageToday: parseFloat(summary.ads_percentage_today ?? 0),
    uniqueClients: summary.unique_clients ?? 0,
    queriesForwarded: summary.queries_forwarded ?? 0,
    queriesCached: summary.queries_cached ?? 0,
    topBlockedDomains,
    queryTypes,
  };
}

// ─── 4. Network Devices ───
export async function getNetworkDevices(): Promise<{ ip: string; mac: string }[]> {
  if (!isLinux) return [];
  const out = await run('ip neigh show') || await run('arp -an');
  if (!out) return [];
  const devices: { ip: string; mac: string }[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/(\d+\.\d+\.\d+\.\d+).*?([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
    if (m) devices.push({ ip: m[1], mac: m[2].toLowerCase() });
  }
  return devices;
}

// ─── 5. Bandwidth Live ───
let lastNetReading: { time: number; data: Record<string, { rx: number; tx: number }> } | null = null;

export async function getBandwidthLive() {
  if (!isLinux) return { interfaces: [] };
  try {
    const readDev = async () => {
      const c = await fs.promises.readFile('/proc/net/dev', 'utf8');
      const r: Record<string, { rx: number; tx: number }> = {};
      for (const line of c.split('\n').slice(2)) {
        const m = line.trim().match(/^(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (m && m[1] !== 'lo') r[m[1]] = { rx: parseInt(m[2]), tx: parseInt(m[3]) };
      }
      return r;
    };
    const now = Date.now();
    const current = await readDev();
    const prev = lastNetReading;
    lastNetReading = { time: now, data: current };
    const elapsed = prev ? (now - prev.time) / 1000 : 0;
    return {
      interfaces: Object.entries(current).map(([name, { rx, tx }]) => ({
        name, rx_bytes: rx, tx_bytes: tx,
        rx_speed_bps: prev?.data[name] && elapsed > 0 ? Math.max(0, Math.round((rx - prev.data[name].rx) / elapsed)) : 0,
        tx_speed_bps: prev?.data[name] && elapsed > 0 ? Math.max(0, Math.round((tx - prev.data[name].tx) / elapsed)) : 0,
      })),
    };
  } catch {
    return { interfaces: [] };
  }
}

// ─── 6. WireGuard Status ───
export async function getWireguardStatus() {
  if (!isLinux) return null;
  const out = await run('wg show');
  if (!out) return null;
  let iface = '', publicKey = '', listeningPort = 0;
  const peers: { publicKey: string; endpoint: string; latestHandshake: string; transferRx: string; transferTx: string }[] = [];
  let cur: any = null;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t.startsWith('interface:')) iface = t.split(':')[1].trim();
    else if (t.startsWith('public key:') && !cur) publicKey = t.split(':').slice(1).join(':').trim();
    else if (t.startsWith('listening port:')) listeningPort = parseInt(t.split(':')[1].trim());
    else if (t.startsWith('peer:')) {
      if (cur) peers.push(cur);
      cur = { publicKey: t.split(':').slice(1).join(':').trim(), endpoint: '', latestHandshake: '', transferRx: '', transferTx: '' };
    } else if (cur) {
      if (t.startsWith('endpoint:')) cur.endpoint = t.split(':').slice(1).join(':').trim();
      else if (t.startsWith('latest handshake:')) cur.latestHandshake = t.split(':').slice(1).join(':').trim();
      else if (t.startsWith('transfer:')) {
        const m = t.replace('transfer:', '').match(/([\d.]+\s+\S+)\s+received,\s+([\d.]+\s+\S+)\s+sent/);
        if (m) { cur.transferRx = m[1]; cur.transferTx = m[2]; }
      }
    }
  }
  if (cur) peers.push(cur);
  return { interface: iface, publicKey, listeningPort, peers };
}

// ─── 7. Fail2Ban Status ───
export async function getFail2banStatus() {
  if (!isLinux) return null;
  const out = await run('fail2ban-client status');
  if (!out) return null;
  const jailMatch = out.match(/Jail list:\s*(.*)/);
  if (!jailMatch) return null;
  const names = jailMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  const jails = [];
  for (const name of names) {
    const j = await run(`fail2ban-client status ${name}`);
    const cur = j.match(/Currently banned:\s*(\d+)/);
    const tot = j.match(/Total banned:\s*(\d+)/);
    const ips = j.match(/Banned IP list:\s*(.*)/);
    jails.push({
      name,
      currentlyBanned: cur ? parseInt(cur[1]) : 0,
      totalBanned: tot ? parseInt(tot[1]) : 0,
      bannedIps: ips && ips[1].trim() ? ips[1].trim().split(/\s+/) : [],
    });
  }
  return { jails };
}

// ─── 8. DNS Queries ───
export async function getDnsQueries(limit: number = 50, filters?: { device?: string; blocked?: string; domain?: string }) {
  if (!isLinux) return [];

  // Primary: Pi-hole v6 FTL DB (direct read — version-proof, no webserver needed).
  const dbRows = await readOnlyQuery(FTL_DB,
    'SELECT timestamp, type, status, domain, client FROM queries ORDER BY timestamp DESC LIMIT ?',
    [Math.min(limit * 4, 1000)]);
  if (dbRows.length) {
    let queries = dbRows.map((r: any, idx: number) => ({
      id: idx + 1,
      timestamp: new Date(r.timestamp * 1000).toISOString(),
      client_ip: r.client, domain: r.domain,
      type: FTL_TYPE_MAP[r.type] || `TYPE${r.type}`,
      status: BLOCKED_STATUS.includes(r.status) ? 'blocked' : 'allowed',
      response_time_ms: 0,
    }));
    if (filters?.device) queries = queries.filter((q: any) => q.client_ip === filters.device);
    if (filters?.blocked === 'true') queries = queries.filter((q: any) => q.status === 'blocked');
    else if (filters?.blocked === 'false') queries = queries.filter((q: any) => q.status === 'allowed');
    if (filters?.domain) queries = queries.filter((q: any) => q.domain?.includes(filters.domain!));
    return queries.slice(0, limit);
  }

  // Fallback: legacy Pi-hole v5 API (admin/api.php)
  try {
    const r = await fetch(`http://127.0.0.1/admin/api.php?getAllQueries=${Math.min(limit * 4, 500)}`);
    if (r.ok) {
      const d = await r.json();
      if (d.data && Array.isArray(d.data)) {
        let queries = d.data.map((row: any[], idx: number) => {
          const sc = parseInt(row[4]);
          return {
            id: idx + 1,
            timestamp: new Date(parseInt(row[0]) * 1000).toISOString(),
            client_ip: row[3], domain: row[2], type: row[1],
            status: [1, 4, 5, 9, 10, 11].includes(sc) ? 'blocked' : 'allowed',
            response_time_ms: 0,
          };
        });
        if (filters?.device) queries = queries.filter((q: any) => q.client_ip === filters.device);
        if (filters?.blocked === 'true') queries = queries.filter((q: any) => q.status === 'blocked');
        else if (filters?.blocked === 'false') queries = queries.filter((q: any) => q.status === 'allowed');
        if (filters?.domain) queries = queries.filter((q: any) => q.domain.includes(filters.domain!));
        return queries.slice(0, limit);
      }
    }
  } catch { /* */ }

  // Fallback: pihole.log
  try {
    const log = await run(`tail -n ${limit * 5} /var/log/pihole/pihole.log`);
    if (log) {
      let queries: any[] = [];
      let id = 1;
      for (const line of log.split('\n')) {
        const m = line.match(/(\w+\s+\d+\s+[\d:]+).*query\[(\w+)]\s+(\S+)\s+from\s+(\S+)/);
        if (m) queries.push({ id: id++, timestamp: m[1], client_ip: m[4], domain: m[3], type: m[2], status: 'allowed', response_time_ms: 0 });
      }
      if (filters?.device) queries = queries.filter(q => q.client_ip === filters.device);
      if (filters?.blocked === 'true') queries = queries.filter(q => q.status === 'blocked');
      if (filters?.domain) queries = queries.filter(q => q.domain.includes(filters.domain!));
      return queries.slice(0, limit);
    }
  } catch { /* */ }

  return [];
}

// ─── 9. External IP ───
export async function getCurrentExternalIp(): Promise<{ ip: string; provider: string }> {
  if (!isLinux) return { ip: '', provider: 'unavailable' };
  let ip = await run('curl -s --max-time 5 https://api.ipify.org');
  if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return { ip, provider: 'ipify' };
  ip = await run('curl -s --max-time 5 https://ifconfig.me');
  if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return { ip, provider: 'ifconfig.me' };
  return { ip: '', provider: 'unavailable' };
}

// ─── 10. Speed Test ───
// Real speedtest — takes 30-60 seconds. Returns null if speedtest-cli not installed.
export async function runSpeedTest(): Promise<{
  download_mbps: number; upload_mbps: number; ping_ms: number;
  jitter_ms: number; packet_loss: number; server: string; isp: string;
} | null> {
  if (!isLinux) return null;

  // Check if speedtest-cli is installed
  const which = await run('which speedtest-cli');
  if (!which) return null;

  try {
    const out = await run('speedtest-cli --json', 90000); // 90 second timeout
    if (!out) return null;
    const d = JSON.parse(out);
    return {
      download_mbps: Math.round((d.download / 1000000) * 10) / 10,
      upload_mbps: Math.round((d.upload / 1000000) * 10) / 10,
      ping_ms: Math.round(d.ping * 10) / 10,
      jitter_ms: Math.round((d.server?.latency || d.ping) * 10) / 10,
      packet_loss: d.packetLoss != null ? Math.round(d.packetLoss * 100) / 100 : 0,
      server: d.server?.sponsor ? `${d.server.sponsor} - ${d.server.name}` : 'Unknown',
      isp: d.client?.isp || 'Unknown',
    };
  } catch {
    return null;
  }
}

// ─── 11. Terminal (unrestricted) ───
export interface TerminalResult {
  output: string; command: string; timestamp: string;
  stdout?: string; stderr?: string; exitCode?: number | null; signal?: string | null; timedOut?: boolean; truncated?: boolean;
}
export async function executeCommand(cmd: string): Promise<TerminalResult> {
  const trimmed = cmd.trim();
  const timestamp = new Date().toISOString();

  if (!isLinux) {
    return { output: 'Terminal sadece Pi5 uzerinde calisir.', command: trimmed, timestamp };
  }

  if (trimmed === 'clear') {
    return { output: '', command: trimmed, timestamp };
  }

  // Eskiden sıfır olmayan çıkışta tüm çıktı kayboluyor ve '(bos cikti)' görünüyordu (ör. `systemctl status` → 3).
  // Artık stdout + stderr + tek satırlık durum; baştaki boşluklar korunur (tablo hizası), sondakiler kırpılır.
  const r = await runResult(trimmed, 120000);
  const parts: string[] = [];
  const out = r.stdout.replace(/\s+$/, '');
  const err = r.stderr.replace(/\s+$/, '');
  if (out) parts.push(out);
  if (err) parts.push(err);
  if (r.timedOut) parts.push('[zaman aşımı: 120 sn — komut sonlandırıldı; alt süreçler arka planda sürebilir]');
  else if (r.truncated) parts.push('[çıktı 1 MB sınırında kesildi — komut sonlandırıldı]');
  else if (r.code !== null && r.code !== 0) parts.push(`[çıkış kodu: ${r.code}]`);
  else if (r.code === null && r.signal) parts.push(`[sinyal: ${r.signal}]`);
  return {
    output: parts.join('\n') || '(bos cikti)', command: trimmed, timestamp,
    stdout: r.stdout, stderr: r.stderr, exitCode: r.code, signal: r.signal, timedOut: r.timedOut, truncated: r.truncated,
  };
}

// ─── Health Check ───
export async function checkDnsHealth(): Promise<boolean> {
  if (!isLinux) return true;
  const r = await run('dig +time=2 +tries=1 google.com @127.0.0.1 -p 53');
  return r.includes('NOERROR') || r.includes('ANSWER SECTION');
}

// ─── Device Blocking (real nftables enforcement) ───
// Maintains a dedicated `inet pi5_block` table with a forward-hook drop rule per blocked MAC.
export async function applyBlockedDevices(macs: string[]): Promise<void> {
  if (!isLinux) return;
  const clean = macs.filter(m => /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(m));
  // Idempotent (boş-tanımla → sil → yeniden-tanımla): boot'ta include ile güvenli, reload'da çoğaltmaz.
  const lines = [
    'table inet pi5_block {}',
    'delete table inet pi5_block',
    'table inet pi5_block {',
    '  chain forward {',
    '    type filter hook forward priority -10; policy accept;',
    ...clean.map(m => `    ether saddr ${m} drop`),
    '  }',
    '}',
  ];
  try { fs.mkdirSync('/etc/nftables.d', { recursive: true }); } catch { /* */ }
  try { fs.writeFileSync('/etc/nftables.d/device-block.conf', lines.join('\n') + '\n'); } catch { /* */ }
  await run('nft -f /etc/nftables.d/device-block.conf 2>/dev/null || true');
}

// ─── Service Control ───
// Başarısızlıkta systemd'nin mesajıyla FIRLATIR (eskiden her durumda "tamamlandi" dönüyordu).
type SystemctlAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'enable-now' | 'disable-now' | 'reset-failed';
const SYSTEMCTL_ARGV: Record<SystemctlAction, string> = {
  start: 'start', stop: 'stop', restart: 'restart', enable: 'enable', disable: 'disable',
  'enable-now': 'enable --now', 'disable-now': 'disable --now', 'reset-failed': 'reset-failed',
};
export async function systemctlAction(action: SystemctlAction, service: string, timeoutMs?: number): Promise<string> {
  if (!isLinux) throw new Error(`systemctl sadece Pi5 üzerinde çalışır: ${action} ${service}`);
  if (!Object.prototype.hasOwnProperty.call(SYSTEMCTL_ARGV, action)) throw new Error(`Geçersiz systemctl aksiyonu: ${action}`);
  if (!VALID_UNIT.test(service)) throw new Error(`Geçersiz servis adı: ${service}`);
  const argv = SYSTEMCTL_ARGV[action];
  const timeout = timeoutMs ?? (action === 'enable' || action === 'disable' || action === 'reset-failed' ? 20000 : 60000);
  const r = await runResult(`systemctl ${argv} ${service}`, timeout);
  if (r.timedOut) throw new Error(`systemctl ${argv} ${service} ${timeout / 1000} sn içinde tamamlanmadı (iş arka planda sürebilir)`);
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim() || `systemctl ${argv} ${service} başarısız`;
    throw new Error(`${msg}${r.code !== null ? ` (çıkış kodu ${r.code})` : ''}`);
  }
  return r.stdout.trim() || `${argv} ${service} tamamlandi`;
}

// ─── Interface / IP detection (supports both eth0=WAN and wlan0=WAN topologies) ───
export async function detectInterfaces(): Promise<{ wan: string; lan: string }> {
  const wan = (await run(`ip -o -4 route show to default | awk '{print $5}' | head -1`)).trim() || 'eth0';
  const links = (await run('ls /sys/class/net 2>/dev/null')).split(/\s+/).filter(Boolean);
  const lan = links.find(l =>
    l !== 'lo' && l !== wan && !l.startsWith('wg') && !l.startsWith('docker') && !l.startsWith('veth') && !l.startsWith('br-')
  ) || (wan === 'eth0' ? 'wlan0' : 'eth0');
  return { wan, lan };
}

// Pi5'in LAN tarafındaki IP'si (redirect hedefi için). Bulunamazsa boş döner.
export async function getPi5LanIp(): Promise<string> {
  const { lan } = await detectInterfaces();
  const ip = (await run(`ip -o -4 addr show ${lan} 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1`)).trim();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  const first = (await run(`hostname -I 2>/dev/null | awk '{print $1}'`)).trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(first) ? first : '';
}

// ─── Domain-Based Routing ───
// dnsmasq kernel ipset + iptables mangle (fwmark) + ip rule ile domain bazlı yönlendirme.
// ÖNEMLI: marklama iptables `-m set` ile yapılır çünkü nft `@set` kernel ipset'lerini OKUYAMAZ.
// Pi-hole is ALWAYS global (not a routing option).
// Each rule has two independent parameters: exit_node (isp or a vps_id) and dpi_bypass (boolean).
interface DomainRoute {
  domain: string;
  exit_node: string;   // 'isp' or a vps id (e.g. '1', '2')
  dpi_bypass: number;  // 0 or 1
  enabled: number;
  redirect_url?: string; // if set, DNS-redirect domain to Pi5 IP → HTTP redirect to this URL
}

// Dosyayı yalnız içerik değiştiyse yazar; değişip değişmediğini döner (DNS gereksiz yere yeniden başlamasın).
function writeIfChanged(file: string, content: string): boolean {
  let old: string | null = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* dosya yok */ }
  if (old === content) return false;
  try { fs.writeFileSync(file, content); } catch { return false; }
  return true;
}

const DNSMASQ_D_FILES = ['/etc/dnsmasq.d/05-domain-routing.conf', '/etc/dnsmasq.d/06-domain-redirect.conf'];
// /etc/dnsmasq.d açılıp DNS gelmeyince geri alındığında bırakılan işaret: varken anahtar yeniden açılmaz
// (her uygulamada aç → DNS'siz bekle → geri al döngüsü olmasın). Dosya silinirse sonraki uygulamada yeniden denenir.
const DNSMASQ_D_REVERTED = '/opt/pi5-gateway/core/.etc_dnsmasq_d_reverted';
// Pi-hole v6 unit'i 60 sn'de en fazla 5 başlatmaya izin verir (StartLimitBurst=5); aşılırsa FTL durmuş kalır.
const DNS_RESTART_MIN_GAP_MS = 15000;
// FTL durdurulup yeniden başlatılırken yazılır, başlatınca silinir: backend arada ölürse (güncelleme restart'ı,
// çökme) açılışta görülür ve FTL başlatılır — aksi halde bilerek durdurulmuş FTL'i kimse geri açmaz.
const FTL_RESTART_INPROGRESS = '/opt/pi5-gateway/core/.ftl_restart_inprogress';
// dnsmasq geçersiz bir satırda (ör. 63+ karakterlik etiket, ASCII dışı ad) tüm FTL'i düşürür → tüm ağın DNS'i
// gider. Bu kalıba uymayan domainler dnsmasq dosyalarına hiç yazılmaz.
export const VALID_DNSMASQ_DOMAIN = /^(\*\.)?(?=.{1,253}$)[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})*$/i;
// Boşaltılması bekleyen setler: FTL eski ipset= satırlarıyla çalışırken boşaltılırsa eski domainlerin IP'leri
// hemen geri dolar ve kalıcı olur → boşaltma FTL durmuşken (yeni yapılandırmayla başlamadan hemen önce) yapılır.
const pendingFlush = new Set<string>();

// Pi-hole v6 (FTL) /etc/dnsmasq.d'yi varsayılan olarak OKUMAZ (misc.etc_dnsmasq_d = false); routing (05-)
// ve redirect (06-) dosyalarımız oradan yüklenir. Değer: 'true' | 'false'; v5'te `--config` yoktur → başka
// çıktı → dokunulmaz (v5 dnsmasq.d'yi zaten okur).
async function readDnsmasqDirKey(): Promise<string> {
  return (await run('pihole-FTL --config misc.etc_dnsmasq_d 2>/dev/null || true')).split('\n').pop()!.trim();
}

const ftlUnitExists = async () => (await run('systemctl cat pihole-FTL >/dev/null 2>&1 && echo y')) === 'y';
// ActiveState/SubState/NRestarts. `systemctl is-active` inactive/failed'da 3 ile çıkar ve run() o durumda stdout'u
// atar → durum her zaman `show` (0 ile çıkar) üzerinden okunur.
async function ftlUnitState(): Promise<{ active: string; sub: string; restarts: number }> {
  const out = await run('systemctl show -p ActiveState -p SubState -p NRestarts pihole-FTL 2>/dev/null || true');
  const get = (k: string) => (out.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').trim();
  return { active: get('ActiveState'), sub: get('SubState'), restarts: Number(get('NRestarts')) || 0 };
}

async function flushPendingSets(): Promise<void> {
  for (const s of pendingFlush) await run(`ipset flush ${s} 2>/dev/null || true`);
  pendingFlush.clear();
}

// FTL başlatma sınırına takılıp 'failed' kaldıysa kurtarır. Kullanıcının temiz durdurması (inactive) ve
// 'activating' durumuna dokunulmaz.
async function ensureFtlActive(): Promise<void> {
  if ((await ftlUnitState()).active !== 'failed') return;
  console.error('[routing] pihole-FTL failed (başlatma sınırı?) — reset-failed + start');
  await run('systemctl reset-failed pihole-FTL 2>/dev/null; systemctl start pihole-FTL 2>/dev/null || true', 90000);
}

// FTL'i durdurur, işi yapar, yeniden başlatır. İşaret dosyası backend arada ölürse FTL'in durmuş kalmamasını sağlar.
async function withFtlStopped<T>(work: () => Promise<T>): Promise<T> {
  try { fs.writeFileSync(FTL_RESTART_INPROGRESS, new Date().toISOString() + '\n'); } catch { /* */ }
  await run('systemctl stop pihole-FTL 2>/dev/null || true', 90000);
  try {
    return await work();
  } finally {
    await run('systemctl reset-failed pihole-FTL 2>/dev/null; systemctl start pihole-FTL 2>/dev/null || true', 90000);
    try { fs.unlinkSync(FTL_RESTART_INPROGRESS); } catch { /* */ }
  }
}

// FTL başlatıldıktan sonra DNS'in gelmesini bekler; yavaş açılışı (FTL port 53'ü açmadan önce son 24 saatin
// sorgularını DB'den yükler) çökmeden ayırır. Süreç aktif ve kendiliğinden yeniden başlamamışsa 120 sn'ye kadar
// beklemeye devam eder. true = DNS geldi; false = çöktü / çökme döngüsünde / 120 sn'de hiç yanıt yok.
// restartsBefore, BİZİM başlatmamızdan SONRA okunmalı (elle start NRestarts'ı sıfırlayabilir).
async function waitFtlHealthy(restartsBefore: number): Promise<boolean> {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await waitLocalDns(10000)) return true;
    const s = await ftlUnitState();
    if (s.active === 'failed' || s.sub === 'auto-restart' || s.restarts > restartsBefore) return false;
  }
  return false;
}

// Backend açılışında çağrılır: önceki süreç FTL'i durdurup yeniden başlatamadan öldüyse FTL'i başlatır.
export async function recoverInterruptedFtlRestart(): Promise<void> {
  if (!isLinux || !fs.existsSync(FTL_RESTART_INPROGRESS)) return;
  console.error('[routing] Yarım kalmış FTL yeniden başlatması bulundu — pihole-FTL başlatılıyor');
  await run('systemctl reset-failed pihole-FTL 2>/dev/null; systemctl start pihole-FTL 2>/dev/null || true', 90000);
  try { fs.unlinkSync(FTL_RESTART_INPROGRESS); } catch { /* */ }
}

// DNS'i yeniden başlatır. v6'da `pihole restartdns` KALDIRILDI (yardım basıp 0 ile çıkar → `||` zinciri sahte
// başarıyla durur) ve SIGHUP (reload) *.conf dosyalarını yeniden OKUMAZ → servis doğrudan yeniden başlatılır.
// v5/saf dnsmasq yedekleri yalnız pihole-FTL unit'i yoksa kullanılır (restart hatasını gizlemesinler).
// Son güvenlik ağı: yeniden başlatma sonrası DNS gelmezse routing/redirect dosyalarımız boşaltılır (tüm ağın
// DNS'i routing'den önemlidir); sonraki kural uygulaması onları yeniden yazar.
async function restartFtlNow(): Promise<void> {
  if (!(await ftlUnitExists())) {
    await flushPendingSets();
    await run('pihole restartdns 2>/dev/null || systemctl restart dnsmasq 2>/dev/null || true', 30000);
    return;
  }
  await withFtlStopped(flushPendingSets);
  await ensureFtlActive();
  if (await waitFtlHealthy((await ftlUnitState()).restarts)) return;
  console.error('[routing] FTL yeniden başlatıldıktan sonra yerel DNS yanıt vermiyor — 05/06 dnsmasq dosyaları boşaltılıyor');
  for (const f of DNSMASQ_D_FILES) writeIfChanged(f, '');
  await withFtlStopped(async () => {});
  await ensureFtlActive();
}

// /etc/dnsmasq.d okumasını FTL DURMUŞKEN açar: çalışan FTL pihole.toml değişikliğini inotify ile görüp kendini
// yeniden başlatır (FLAG_RESTART_FTL) ve bizim restart'ımızla çakışırdı. DNS gelmezse anahtarı aynı şekilde
// geri alır ve işaret bırakır.
async function enableDnsmasqDirNow(): Promise<void> {
  const flipped = await withFtlStopped(async () => {
    await flushPendingSets();
    await run('pihole-FTL --config misc.etc_dnsmasq_d true 2>/dev/null');
    return (await readDnsmasqDirKey()) === 'true';
  });
  if (flipped && await waitFtlHealthy((await ftlUnitState()).restarts)) {
    console.log('[routing] Pi-hole v6: misc.etc_dnsmasq_d açıldı — /etc/dnsmasq.d routing/redirect dosyaları yükleniyor');
    return;
  }
  if (flipped) {
    // /etc/dnsmasq.d'deki bir dosya FTL'i düşürdüyse tüm ağın DNS'i gider → anahtarı geri al.
    console.error('[routing] /etc/dnsmasq.d açıldıktan sonra yerel DNS yanıt vermiyor — misc.etc_dnsmasq_d geri alınıyor');
    await withFtlStopped(() => run('pihole-FTL --config misc.etc_dnsmasq_d false 2>/dev/null'));
  } else {
    console.error('[routing] pihole-FTL misc.etc_dnsmasq_d açmayı reddetti (dnsmasq.d içeriği geçersiz olabilir)');
  }
  try { fs.writeFileSync(DNSMASQ_D_REVERTED, new Date().toISOString() + '\n'); } catch { /* */ }
}

// Dosyalarımızda yüklenecek bir satır var mı? Yoksa /etc/dnsmasq.d anahtarına hiç dokunulmaz.
function hasDnsmasqEntries(): boolean {
  return DNSMASQ_D_FILES.some(f => {
    try { return fs.readFileSync(f, 'utf8').split('\n').some(l => l.trim() && !l.startsWith('#')); } catch { return false; }
  });
}

async function dnsmasqDirNeedsEnable(): Promise<boolean> {
  if (fs.existsSync(DNSMASQ_D_REVERTED) || !hasDnsmasqEntries()) return false;
  return (await readDnsmasqDirKey()) === 'false';
}

// Çalışan FTL, dosyalarımızın son yazılışından ÖNCE mi başladı? (Yazılıp restart'ı kaçırılan dosya — ör. eski
// sürümün v6'da no-op restartdns'i ya da restart'tan önce kapanan backend — FTL'de eski içerikle kalır.)
// Başlama anı monotonik saatten hesaplanır (tarih ayrıştırma / saat dilimi sorunu olmasın).
async function ftlStartedBeforeFiles(): Promise<boolean> {
  if ((await run('systemctl is-active pihole-FTL 2>/dev/null')) !== 'active') return false;
  const mono = Number(await run('systemctl show -p ActiveEnterTimestampMonotonic --value pihole-FTL 2>/dev/null'));
  let uptime = 0;
  try { uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]); } catch { /* */ }
  if (!mono || !uptime) return false;
  const startedAt = Date.now() / 1000 - uptime + mono / 1e6;
  let newest = 0;
  for (const f of DNSMASQ_D_FILES) {
    try { newest = Math.max(newest, fs.statSync(f).mtimeMs / 1000); } catch { /* */ }
  }
  return newest > startedAt;
}

// DNS yeniden başlatma arka planda birleştirilir: art arda gelen kural değişiklikleri tek restart'a iner, HTTP
// yanıtı FTL'i beklemez ve iki restart arasında en az DNS_RESTART_MIN_GAP_MS bırakılır. İşler sırayla çalışır.
let dnsJobPending = false;
let dnsJobChain: Promise<void> = Promise.resolve();
// Backend açılışı "son restart" sayılır: boot'ta DB'den sorgu yükleyen FTL'i hemen (2 sn'de) durdurmayalım.
let lastDnsRestartAt = Date.now();
function scheduleDnsRestart(): void {
  if (dnsJobPending) return; // bekleyen iş, çalıştığı anda en güncel dosyaları yükleyecek
  dnsJobPending = true;
  dnsJobChain = dnsJobChain.then(async () => {
    await new Promise(res => setTimeout(res, Math.max(2000, DNS_RESTART_MIN_GAP_MS - (Date.now() - lastDnsRestartAt))));
    dnsJobPending = false; // bundan sonraki değişiklikler yeni bir iş planlar
    lastDnsRestartAt = Date.now();
    try {
      if ((await ftlUnitState()).active === 'inactive' && await ftlUnitExists()) {
        // Kullanıcı Pi-hole'u durdurmuş: başlatma. Setler boşaltılır; FTL bir sonraki açılışında dosyaları yükler.
        await flushPendingSets();
        return;
      }
      if (await dnsmasqDirNeedsEnable()) await enableDnsmasqDirNow();
      else await restartFtlNow();
    } catch (e: any) {
      console.error('[routing] DNS yeniden başlatılamadı:', e?.message);
    }
  });
}

// Yerel DNS (127.0.0.1:53) bir yanıt dönüyor mu? NXDOMAIN/SERVFAIL de yanıttır; yalnız bağlantı reddi /
// zaman aşımı "ayakta değil" sayılır. dig'e bağımlı değildir (kurulu olmayabilir). FTL açılışı için bekler.
async function waitLocalDns(maxMs: number = 15000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = new dnsPromises.Resolver({ timeout: 1500, tries: 1 });
    r.setServers(['127.0.0.1']);
    try { await r.resolve4('pi.hole'); return true; } catch (e: any) {
      if (!['ECONNREFUSED', 'ETIMEOUT', 'ECANCELLED'].includes(e?.code)) return true;
    }
    await new Promise(res => setTimeout(res, 1000));
  }
  return false;
}

// Pi'yi ağ geçidi yapan LAN istemcilerinin ağları/arayüzleri ve Pi'nin kendi adresleri (çekirdek rotalarından;
// wg_* ve lo hariç). nft anonim setinde iç içe aralık hata verir → başka bir ağın içinde kalan ağ elenir.
const GW_NFT = '/opt/pi5-gateway/core/pi5-gw.nft';
async function detectGatewayLan(): Promise<{ nets: string[]; ifaces: string[]; selfIps: string[] }> {
  const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const within = (net: string, outer: string) => {
    const [a, pa] = net.split('/');
    const [b, pb] = outer.split('/');
    const div = 2 ** (32 - Number(pb));
    return Number(pb) <= Number(pa) && Math.floor(ipNum(a) / div) === Math.floor(ipNum(b) / div);
  };
  const nets = new Set<string>();
  const ifaces = new Set<string>();
  const selfIps = new Set<string>();
  for (const line of (await run('ip -4 -o route show proto kernel scope link 2>/dev/null')).split('\n')) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+\/\d+)\s+dev\s+([A-Za-z0-9_.-]{1,15})\s/);
    if (!m || /^(wg|lo)/.test(m[2])) continue;
    nets.add(m[1]);
    ifaces.add(m[2]);
  }
  for (const m of (await run('ip -4 -o addr show 2>/dev/null')).matchAll(/\sinet\s(\d+\.\d+\.\d+\.\d+)\//g)) selfIps.add(m[1]);
  const all = [...nets];
  return { nets: all.filter(n => !all.some(o => o !== n && within(n, o))), ifaces: [...ifaces], selfIps: [...selfIps] };
}

export async function applyDomainRouting(domains?: DomainRoute[]): Promise<void> {
  if (!isLinux) return;
  if (!domains) return;

  const enabledDomains = domains.filter(d => d.enabled).filter(d => {
    if (VALID_DNSMASQ_DOMAIN.test(d.domain)) return true;
    console.warn(`[routing] Geçersiz domain atlandı (dnsmasq'ı düşürebilir): ${JSON.stringify(d.domain)}`);
    return false;
  });

  // Separate redirect rules from routing rules
  const redirectDomains = enabledDomains.filter(d => d.redirect_url);
  const routingDomains = enabledDomains.filter(d => !d.redirect_url);

  // FTL diskteki (bu uygulamadan ÖNCEKİ) dosyalardan eski mi — ör. önceki restart başarısız oldu? Dosyalar YAZILMADAN
  // önce ölçülür: yazdıktan sonra her değişiklikte doğru döner ve salt eklemede de tüm setleri boşalttırırdı.
  const ftlStale = await ftlStartedBeforeFiles();

  // Generate dnsmasq address= lines for redirect domains (point to Pi5 local IP — detected, not hardcoded)
  // LAN IPv4 henüz yoksa (boot'ta DHCP bitmeden) ve redirect kuralı varsa dosyaya dokunma: tahmini bir IP
  // (eskiden 192.168.1.1 — çoğu evde modemin kendisi) yazılırsa redirect'ler yanlış hosta gider ve düzelmez.
  const pi5Ip = await getPi5LanIp();
  let redirectChanged = false;
  if (pi5Ip || redirectDomains.length === 0) {
    const addressLines: string[] = [];
    for (const d of redirectDomains) {
      const domain = d.domain.startsWith('*.') ? d.domain.replace('*.', '') : d.domain;
      // Point domain to Pi5 IP — nginx (:80) serves the redirect via /etc/nginx redirect map
      addressLines.push(`address=/${domain}/${pi5Ip}`);
    }

    // Write redirect config (separate from routing config) — fs.writeFileSync, no shell interpolation
    const redirectConf = addressLines.length > 0
      ? '# Auto-generated redirect rules\n' + addressLines.join('\n') + '\n'
      : '';
    redirectChanged = writeIfChanged('/etc/dnsmasq.d/06-domain-redirect.conf', redirectConf);
  } else {
    console.warn('[routing] Pi5 LAN IPv4 bulunamadı — 06-domain-redirect.conf korunuyor');
  }

  // Write redirect URL map for the HTTP redirect server (backward-compat / diagnostics)
  const redirectMap: Record<string, string> = {};
  for (const d of redirectDomains) {
    const domain = d.domain.startsWith('*.') ? d.domain.replace('*.', '') : d.domain;
    redirectMap[domain] = d.redirect_url!;
  }
  try {
    fs.mkdirSync('/opt/pi5-gateway/core', { recursive: true });
    fs.writeFileSync('/opt/pi5-gateway/core/redirect-map.json', JSON.stringify(redirectMap, null, 2));
  } catch { /* may fail on non-Linux */ }

  // Redirect'i DOĞRU katmanda yap: nginx (:80). dnsmasq domaini Pi5'e yönlendirir, nginx 302 döner.
  // (Backend'in eski 302 middleware'ine nginx trafiği hiç ulaşmıyordu — C1.)
  const mapLines = ['map $host $pi5_redirect {', '    default "";'];
  for (const [domain, url] of Object.entries(redirectMap)) {
    const safeHost = domain.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeUrl = String(url).replace(/["\r\n\\]/g, '').trim();
    if (safeHost && /^https?:\/\//i.test(safeUrl)) mapLines.push(`    "${safeHost}" "${safeUrl}";`);
  }
  mapLines.push('}');
  try {
    fs.writeFileSync('/etc/nginx/conf.d/pi5-redirect-map.conf', mapLines.join('\n') + '\n');
    await run('nginx -t 2>/dev/null && (nginx -s reload 2>/dev/null || systemctl reload nginx 2>/dev/null) || true');
  } catch { /* */ }

  // fwmark scheme:
  //   exit_node='isp', dpi_bypass=0 → mark 0 (default, no special routing)
  //   exit_node='isp', dpi_bypass=1 → mark 200 (DPI bypass via zapret nfqueue)
  //   exit_node=vps_id, dpi_bypass=0 → mark 100 + vps_id (route through VPS tunnel)
  //   exit_node=vps_id, dpi_bypass=1 → mark 300 + vps_id (VPS tunnel + DPI bypass)
  function getFwmark(exit_node: string, dpi_bypass: number): number {
    const isVps = exit_node !== 'isp';
    const vpsId = isVps ? parseInt(exit_node, 10) || 0 : 0;
    if (!isVps && !dpi_bypass) return 0; // default route, nothing to do
    if (!isVps && dpi_bypass) return 200; // DPI bypass only
    if (isVps && !dpi_bypass) return 100 + vpsId; // VPS exit only
    return 300 + vpsId; // VPS exit + DPI bypass
  }

  // 1. dnsmasq ipset config — Pi-hole/dnsmasq, çözülen IP'leri kernel ipset'lerine yazar.
  const ipsetLines: string[] = [];
  const markSets = new Map<number, string>(); // mark → ipset name

  for (const d of routingDomains) {
    const mark = getFwmark(d.exit_node, d.dpi_bypass);
    if (mark === 0) continue; // default route, no special routing needed
    const setName = `rt_m${mark}`;
    if (!markSets.has(mark)) markSets.set(mark, setName);
    // Keyword (nokta yok) ve *.example.com → dnsmasq suffix eşleşmesi (substring DEĞİL — dnsmasq sınırı).
    const base = d.domain.startsWith('*.') ? d.domain.slice(2) : d.domain;
    ipsetLines.push(`ipset=/${base}/${setName}`);
  }

  // Önceki satırlar: bir satır ÇIKARILDIYSA (domain silindi / başka sete taşındı) o setteki eski IP'ler bayat kalır →
  // yalnız o set boşaltılır. Salt eklemede bayat içerik yoktur; boşaltmak tüm açık tünel bağlantılarını koparırdı.
  let oldRoutingLines: string[] = [];
  try { oldRoutingLines = fs.readFileSync('/etc/dnsmasq.d/05-domain-routing.conf', 'utf8').split('\n').filter(Boolean); } catch { /* ilk kurulum */ }
  const routingChanged = writeIfChanged('/etc/dnsmasq.d/05-domain-routing.conf', ipsetLines.join('\n') + '\n');
  const newRoutingLines = new Set(ipsetLines);
  const setsWithRemovals = new Set<string>();
  const oldSets = new Set<string>();
  for (const line of oldRoutingLines) {
    const m = line.match(/^ipset=\/[^/]+\/(rt_m\d+)$/);
    if (!m) continue;
    oldSets.add(m[1]);
    if (!newRoutingLines.has(line)) setsWithRemovals.add(m[1]);
  }

  // Eski nft tabanlı (bozuk) marklama dosyasını temizle
  await run('rm -f /etc/nftables.d/domain-routing.conf 2>/dev/null || true');
  await run('nft delete table inet domain_routing 2>/dev/null || true');

  // run() hata yuttuğu için araç yoksa aşağıdaki adımların hepsi sessizce boşa gider — en azından günlükte görünsün.
  if (markSets.size > 0) {
    const missing: string[] = [];
    for (const bin of ['ipset', 'iptables']) if (!(await run(`command -v ${bin} 2>/dev/null`))) missing.push(bin);
    if (missing.length) {
      console.error(`[routing] ${missing.join(' + ')} kurulu değil — domain/uygulama yönlendirmesi çalışmaz (Ayarlar → Güncelle kurar)`);
    }
  }

  // 2. Kernel ipset'lerini oluştur (dnsmasq doldurur). Boşaltılacak olarak işaretlenenler (boşaltma DNS işinde FTL
  //    durmuşken yapılır): sete ait bir satır çıkarıldıysa, set eski dosyada hiç yoksa (yeniden kullanılan setin
  //    önceki domainlerden kalan IP'leri) ya da FTL diskteki eski dosyalardan önce başladıysa. Salt eklemede içerik
  //    hâlâ geçerlidir, boşaltılmaz — boşaltmak açık tünel bağlantılarını koparırdı.
  const existingSets = new Set((await run('ipset list -n 2>/dev/null')).split('\n').map(s => s.trim()));
  let setCreated = false;
  for (const [, setName] of markSets) {
    if (!existingSets.has(setName)) setCreated = true;
    await run(`ipset create ${setName} hash:ip family inet -exist`);
    if (ftlStale || setsWithRemovals.has(setName) || !oldSets.has(setName)) pendingFlush.add(setName);
  }
  // Son domaini de çıkarılan (artık kullanılmayan) setler de boşaltılır: yeniden kullanılırlarsa eski IP'ler taşınmasın.
  for (const s of setsWithRemovals) pendingFlush.add(s);

  // 3. iptables mangle ile marklama — `-m set` kernel ipset'lerini DOĞRU okur (nft @set okuyamaz).
  await run('iptables -t mangle -N PI5_ROUTING 2>/dev/null || true');
  await run('iptables -t mangle -F PI5_ROUTING 2>/dev/null || true');
  await run('iptables -t mangle -C PREROUTING -j PI5_ROUTING 2>/dev/null || iptables -t mangle -A PREROUTING -j PI5_ROUTING');
  await run('iptables -t mangle -C OUTPUT -j PI5_ROUTING 2>/dev/null || iptables -t mangle -A OUTPUT -j PI5_ROUTING');
  for (const [mark, setName] of markSets) {
    await run(`iptables -t mangle -A PI5_ROUTING -m set --match-set ${setName} dst -j CONNMARK --restore-mark`);
    await run(`iptables -t mangle -A PI5_ROUTING -m set --match-set ${setName} dst -j MARK --set-mark ${mark}`);
    await run(`iptables -t mangle -A PI5_ROUTING -m set --match-set ${setName} dst -j CONNMARK --save-mark`);
  }

  // 3b. Tünel çıkışına SNAT. VPS, Pi peer'ından yalnız 10.66.66.2 kaynaklı paketi kabul eder (AllowedIPs);
  //     NAT'sız giren LAN kaynaklı (192.168.x.x) paketleri sessizce düşürür. iptables yerine kendi nft
  //     tablomuz: eski kurulumlardan kalan yerli `table ip nat`, iptables-nft'nin aynı adlı tablosuyla çakışabilir.
  //     Firewall kurulumundaki nft pi5_nat masquerade'i ile çakışmaz (ilk eşleşen NAT uygulanır, sonuç aynı).
  //     Boş-tanımla → sil → yeniden-tanımla: her uygulamada idempotent; firewall'un include'u boot'ta da yükler.
  //     Tek bacaklı ağ geçidi: Pi'yi ağ geçidi yapan LAN istemcilerinin modeme (aynı LAN'a) geri iletilen trafiği
  //     de Pi'ye SNAT'lanır — aksi halde cevaplar modemden istemciye doğrudan döner (asimetrik) ve modem, Pi'nin
  //     istemci adına gönderdiği paketleri düşürür (canlıda doğrulandı). Pi'nin kendi trafiği ve LAN içi hariç.
  const gw = await detectGatewayLan();
  const nftSet = (xs: string[], quote = false) => `{ ${xs.map(x => (quote ? `"${x}"` : x)).join(', ')} }`;
  const lanClient = gw.nets.length
    ? `ip saddr ${nftSet(gw.nets)}${gw.selfIps.length ? ` ip saddr != ${nftSet(gw.selfIps)}` : ''}`
    : '';
  const wgNat = [
    'table ip pi5_wgnat {}',
    'delete table ip pi5_wgnat',
    'table ip pi5_wgnat {',
    '  chain postrouting {',
    '    type nat hook postrouting priority 100; policy accept;',
    '    oifname "wg_vps*" masquerade',
    ...(lanClient && gw.ifaces.length
      ? [`    oifname ${nftSet(gw.ifaces, true)} ${lanClient} ip daddr != ${nftSet(gw.nets)} masquerade`]
      : []),
    '  }',
    '}',
  ];
  try { fs.mkdirSync('/etc/nftables.d', { recursive: true }); } catch { /* */ }
  try {
    fs.writeFileSync('/etc/nftables.d/pi5-wgnat.conf', wgNat.join('\n') + '\n');
    await execAsync('nft -f /etc/nftables.d/pi5-wgnat.conf', { timeout: 10000 });
  } catch (e: any) {
    console.error(`[routing] tünel/ağ geçidi NAT'ı (pi5_wgnat) yüklenemedi: ${String(e?.stderr || e?.message || e).trim()}`);
  }

  // 3c. Eski (v2.0–v2.5) firewall'un `inet filter` forward zinciri `policy drop` ve yalnız eth0→wlan0'a (iki kartlı
  //     router varsayımı) izin veriyor; tek bacaklı topolojide istemci trafiği (LAN→modem, LAN→wg_vps*) düşüyordu.
  //     Panele ait `pi5_gw` zinciri her uygulamada boşaltılıp doldurulur, forward'ın başına bir kez `jump pi5_gw`
  //     eklenir; tek nft dosyası → hata olursa hiçbir kural değişmez. Dosya /etc/nftables.d dışında: firewall
  //     include'u boot'ta eski tablo yokken hata vermesin. Forward politikası accept ise (ya da tablo yoksa) dokunulmaz.
  const fwdChain = await run('nft list chain inet filter forward 2>/dev/null');
  if (/policy drop/.test(fwdChain) && lanClient && gw.ifaces.length) {
    const lanIfs = nftSet(gw.ifaces, true);
    const gwRules = [
      'add chain inet filter pi5_gw',
      'flush chain inet filter pi5_gw',
      // Tünel MTU'su (1420) LAN'dan küçük: SYN'de MSS'i rota MTU'suna indir (yalnız küçültür).
      'add rule inet filter pi5_gw oifname "wg_vps*" tcp flags syn tcp option maxseg size set rt mtu',
      'add rule inet filter pi5_gw ct state established,related accept',
      `add rule inet filter pi5_gw iifname ${lanIfs} ${lanClient} oifname "wg_vps*" accept`,
      // LAN → modem (tek bacak): ct state'e bakılmaz — SNAT kurulamazsa akış asimetrik kalır, sonraki paketler 'invalid' olur.
      `add rule inet filter pi5_gw iifname ${lanIfs} ${lanClient} ip daddr != ${nftSet(gw.nets)} oifname ${lanIfs} accept`,
      ...(/jump pi5_gw/.test(fwdChain) ? [] : ['insert rule inet filter forward jump pi5_gw']),
    ];
    try {
      fs.mkdirSync('/opt/pi5-gateway/core', { recursive: true });
      fs.writeFileSync(GW_NFT, gwRules.join('\n') + '\n');
      await execAsync(`nft -f ${GW_NFT}`, { timeout: 10000 });
    } catch (e: any) {
      console.error(`[routing] ağ geçidi izni (inet filter pi5_gw) kurulamadı: ${String(e?.stderr || e?.message || e).trim()}`);
    }
  }

  // 4. VPS-çıkış markları (≥100) için ip rule + routing tablosu.
  //    mark 200 (yalnız DPI bypass) ISP ana tablosunu kullanır — zapret trafiği kendi hook'uyla işler.
  //    `ip rule add` varlık kontrolü yapmaz, her uygulamada yeni kopya ekler → mevcut "fwmark N lookup N"
  //    (100–999) kurallarını say: istenen marklarda fazlayı sil (biri hep kalır, trafik ISP'ye kaçmaz),
  //    artık kullanılmayan markların kurallarını tamamen kaldır, eksikse bir kez ekle.
  const ruleCounts = new Map<number, number>();
  for (const line of (await run('ip rule show 2>/dev/null')).split('\n')) {
    const m = line.match(/fwmark (0x[0-9a-f]+|\d+) lookup (\d+)/i);
    if (!m) continue;
    const mark = Number(m[1]);
    if (mark !== Number(m[2]) || mark < 100 || mark > 999) continue;
    ruleCounts.set(mark, (ruleCounts.get(mark) || 0) + 1);
  }
  for (const [mark, count] of ruleCounts) {
    const extra = markSets.has(mark) ? count - 1 : count;
    for (let i = 0; i < extra; i++) await run(`ip rule del fwmark ${mark} table ${mark} 2>/dev/null || true`);
  }
  for (const [mark] of markSets) {
    if (mark < 100) continue;
    const vpsId = mark >= 300 ? mark - 300 : mark - 100;
    const iface = `wg_vps${vpsId}`;
    if (!ruleCounts.has(mark)) await run(`ip rule add fwmark ${mark} table ${mark} 2>/dev/null || true`);
    const ifaceCheck = await run(`ip link show ${iface} 2>/dev/null`);
    if (ifaceCheck) {
      await run(`ip route replace default dev ${iface} table ${mark} 2>/dev/null || true`);
      // Tünelden dönen yanıtlar işaretsiz gelir; katı rp_filter (1) onları düşürür → bu arayüzde gevşek (2).
      await run(`sysctl -q -w net.ipv4.conf.${iface}.rp_filter=2 2>/dev/null || true`);
    }
  }

  // 5. dnsmasq/FTL'i yeniden başlat (ipset config'i alsın) — yalnız gerektiğinde ve arka planda birleştirerek:
  //    dnsmasq dosyaları değiştiyse, yeni set oluştuysa (boot sonrası FTL önbelleğindeki adlar sete eklenmez),
  //    /etc/dnsmasq.d okuması açılmalıysa (v6) ya da FTL dosyaların son halinden önce başladıysa.
  if (routingChanged || redirectChanged || setCreated || ftlStale || await dnsmasqDirNeedsEnable()) {
    scheduleDnsRestart();
  }
}

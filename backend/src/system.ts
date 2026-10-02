import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import { promises as dnsPromises } from 'dns';
import sqlite3 from 'sqlite3';
import { shq } from './util';
import { recordEventOnce } from './events';
import { encodeRouteMark, decodeVpsMark, decodeLegacyVpsMark, isManagedRuleMark, normFallback, DPI_ONLY_MARK, LEGACY_DPI_ONLY_MARK, ISP_FALLBACK_BIT, ROUTE_MARK_MASK, LEARN_MARK_BIT, type VpsMark } from './routeMarks';
import { planListRouting, configureListDns, listSetForName, parseUpstreams, type ListRoute } from './listDns';
import { collapsedList } from './categoryLists';

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
// Sorgu veritabanının yeri Pi-hole'un files.database ayarından okunur: Depolama sayfası veri diski hazırlayınca onu
// /var/lib/klyrix/pihole/pihole-FTL.db'ye (diske bağlı klasör) taşır. Taşıma işi panel servisini yeniden başlattığı için
// açılışta bir kez okumak yeter; okunamazsa (Pi-hole yok / v5) varsayılan yol kalır.
export let FTL_DB = '/etc/pihole/pihole-FTL.db';
export async function refreshFtlDbPath(): Promise<void> {
  if (!isLinux) return;
  const v = (await run('pihole-FTL --config files.database', 5000)).split('\n').pop()?.trim().replace(/^"|"$/g, '') || '';
  if (v.startsWith('/') && fs.existsSync(v)) FTL_DB = v;
  const g = (await run('pihole-FTL --config files.gravity', 5000)).split('\n').pop()?.trim().replace(/^"|"$/g, '') || '';
  if (g.startsWith('/') && fs.existsSync(g)) GRAVITY_DB = g;
}
void refreshFtlDbPath();
let GRAVITY_DB = '/etc/pihole/gravity.db';
// FTL v6 sorgu durumları. Engellenen: gravity / regex / kara liste (+ CNAME), üst sunucunun engellediği (IP, NULL, NXRA,
// EDE 15), veritabanı meşgul, özel alan adı. İletilen: yanıt bekleyen ve yeniden denenen (DNSSEC dahil) de.
const BLOCKED_STATUS = [1, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 18];
const FORWARDED_STATUS = [2, 12, 13, 14];
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
// DNS'in gelmesi 120 sn'ye kadar beklenir (v6.5 :53'ü sorgu içe aktarımından önce açar; pay yavaş kart/prestart için).
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
// Pi-hole'da ayrıca DNS'in gerçekten cevap vermesi beklenir (süreç ayakta olsa da :53 henüz bağlanmamış olabilir).
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
// queryTypes: kayıt türü → bugünkü sorgu ADEDİ (yüzde değil; arayüz yüzdeyi toplamdan hesaplar).
export interface PiholeStats {
  domainsBlocked: number; dnsQueriesToday: number; adsBlockedToday: number;
  adsPercentageToday: number; uniqueClients: number; queriesForwarded: number;
  queriesCached: number; topBlockedDomains: { domain: string; count: number }[];
  queryTypes: Record<string, number>;
}

// Pi-hole v6 FTL SQLite veritabanından doğrudan (web sunucusu / oturum gerekmez). Veritabanı okunamazsa null — v5'in
// admin/api.php'si v6'da yok (80'de panelin nginx'i yanıt verir), eski yedek yolu kaldırıldı.
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

    // Engellenen alan adı sayısı Pi-hole'unki gibi TEKİL: gravity_count (gravity çalışınca yazılır). Ham satır sayısı aynı
    // alan adını her listede ayrı sayıyordu; yoksa (eski veritabanı) DISTINCT.
    let gravityRows = await readOnlyQuery(GRAVITY_DB, "SELECT CAST(value AS INTEGER) AS c FROM info WHERE property = 'gravity_count'");
    if (!gravityRows.length || !(gravityRows[0].c > 0)) gravityRows = await readOnlyQuery(GRAVITY_DB, 'SELECT COUNT(DISTINCT domain) AS c FROM gravity');
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
  return null;
}

// ─── 4. Network Devices ───
export async function getNetworkDevices(): Promise<{ ip: string; mac: string }[]> {
  if (!isLinux) return [];
  const out = await run('ip neigh show') || await run('arp -an');
  if (!out) return [];
  // İnternet kartı ve yedek hat tarafındaki komşular (operatörün / 4G modemin ağ geçidi) ev ağının cihazı değildir.
  const ns = readNetModeState();
  const wanIfs = uplinkIfaces(ns);
  // Wi-Fi köprüsü (aynı ağ): modem ve üst ağdaki cihazlar (Wi-Fi tarafı) Pi'nin ev tarafı değildir — yalnız ev tarafı kartı.
  const onlyDev = ns && sameNetActive(ns) ? ns.repLan : '';
  const devices: { ip: string; mac: string }[] = [];
  for (const line of out.split('\n')) {
    const dev = /\bdev\s+(\S+)/.exec(line)?.[1];
    if (dev && wanIfs.includes(dev)) continue;
    if (onlyDev && dev !== onlyDev) continue;
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

  // Pi-hole v6 FTL veritabanı. Süzgeçler sorguda: önce süzülür sonra sınırlanır (eskiden son 1000 satır alınıp sonra
  // süzülüyordu — seyrek bir cihazın ya da engellenenlerin sorguları az / hiç görünmüyordu).
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters?.device) { where.push('client = ?'); args.push(filters.device); }
  if (filters?.blocked === 'true') where.push(`status IN (${BLOCKED_STATUS.join(',')})`);
  else if (filters?.blocked === 'false') where.push(`status NOT IN (${BLOCKED_STATUS.join(',')})`);
  if (filters?.domain) { where.push('instr(domain, ?) > 0'); args.push(filters.domain); }
  const dbRows = await readOnlyQuery(FTL_DB,
    `SELECT timestamp, type, status, domain, client FROM queries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY timestamp DESC LIMIT ?`,
    [...args, Math.min(Math.max(1, limit), 1000)]);
  if (dbRows.length) {
    const queries = dbRows.map((r: any, idx: number) => ({
      id: idx + 1,
      timestamp: new Date(r.timestamp * 1000).toISOString(),
      client_ip: r.client, domain: r.domain,
      type: FTL_TYPE_MAP[r.type] || `TYPE${r.type}`,
      status: BLOCKED_STATUS.includes(r.status) ? 'blocked' : 'allowed',
      response_time_ms: 0,
    }));
    return queries.slice(0, limit);
  }

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
// backend/src/speedtest.ts (Ookla Speedtest CLI; yoksa speedtest-cli).

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
  fs.mkdirSync('/etc/nftables.d', { recursive: true });
  fs.writeFileSync('/etc/nftables.d/device-block.conf', lines.join('\n') + '\n');
  // Hata artık yutulmaz: engel uygulanamadıysa panel "engellendi" demesin. Dosya açılışta pi5-gw-restore ile de yüklenir.
  const r = await runResult('nft -f /etc/nftables.d/device-block.conf', 10000);
  if (r.code !== 0) throw new Error(`cihaz engeli uygulanamadı: ${r.stderr.trim() || `nft çıkış kodu ${r.code}`}`);
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

// ─── Interface / IP detection ───
const ipv4ToNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const sameSubnet = (a: string, b: string, prefix: number) => {
  const div = 2 ** (32 - prefix);
  return Math.floor(ipv4ToNum(a) / div) === Math.floor(ipv4ToNum(b) / div);
};
// ip + önek → ağ adresi ("192.168.0.1", 24 → "192.168.0.0/24"; çekirdek rotalarındaki yazımla aynı).
const networkOf = (ip: string, prefix: number) => {
  const div = 2 ** (32 - prefix);
  const netNum = Math.floor(ipv4ToNum(ip) / div) * div;
  return [24, 16, 8, 0].map(s => Math.floor(netNum / 2 ** s) % 256).join('.') + `/${prefix}`;
};
const VALID_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIpv4 = (s: string) => { const m = s.match(VALID_IPV4); return !!m && m.slice(1).every(o => Number(o) <= 255); };
// "192.168.0.1/24" → { ip, prefix, network }; biçim dışıysa null (değerler nft kurallarına yazılır).
function parseCidr(s: string): { ip: string; prefix: number; network: string } | null {
  const [ip, p, extra] = String(s || '').split('/');
  if (extra !== undefined || !isIpv4(ip) || !/^\d{1,2}$/.test(p || '') || Number(p) > 32) return null;
  return { ip, prefix: Number(p), network: networkOf(ip, Number(p)) };
}

// Sabit adres modu (scripts/net-mode.sh) durumu: eth0'da tek profil, iki adres — TRANSIT (modem tarafı, varsayılan rota)
// ve CLIENT (Pi DHCP'sinin dağıttığı ağ, ör. 192.168.0.1/24). Dosyayı yalnız betik yazar (root, 0700 dizin); yine de
// değerler nft kurallarına girdiği için biçim dışı olan alan boş sayılır. Dosya yoksa null.
// Kurulum Wi-Fi'ı (net-mode.sh `ap`, aynı dosyada ap_stage/ap_iface): Pi'nin dahili Wi-Fi'ı yalnız yönetim için bir erişim
// noktası yayar (internet yok). eth0 aşamasından bağımsızdır; biçim dışı değer 'none' / '' sayılır.
// Ev Wi-Fi'ı (net-mode.sh `home`, aynı dosyada home_stage/home_iface/lan_if): eth0 ve Wi-Fi kartı tek köprüde (br0)
// birleşir, iki sabit adres köprüye taşınır; lanIf = cihaz ağının arayüzü (köprü açıkken br0, değilse boş).
// İnternet kartı (WAN router, R3; aynı dosyada wan_*): ikinci Ethernet kartı internete bağlanır. wanPort = kartın
// kendisi, wanDev = adresin ve varsayılan rotanın olduğu arayüz (kart / VLAN wan.<ID> / PPPoE pppwan). wanLan = ev ağı
// profilleri yalnız ev ağına çevrildi (eth0 / br0'da yalnız client adresi; transit ve gw eski düzen için saklanır).
export interface NetModeState {
  stage: 'none' | 'trial' | 'static'; iface: string; transit: string; client: string; gw: string;
  apStage: 'none' | 'trial' | 'on'; apIface: string;
  homeStage: 'none' | 'trial' | 'on'; homeIface: string; lanIf: string;
  wanStage: 'none' | 'trial' | 'on'; wanPort: string; wanDev: string; wanType: '' | 'dhcp' | 'static' | 'pppoe';
  wanVlan: string; wanLan: boolean;
  // Tek port (R3b): internet ev ağı kartının üzerindeki VLAN'dan (wanPort = iface) — kartın kendisi EV AĞIDIR.
  wanSingle: boolean;
  wanMtu: number; // kayıtlı MTU (0 = varsayılan); PPPoE'de Ev VPN'i tünel MTU'su buna göre
  // Repeater (R4 A): internet kartı Wi-Fi istemci ise üst ağın adı (boş = kablolu kart).
  wanSsid: string;
  // Yedek hat (failover; aynı dosyada bak_*): ikinci internet bağlantısı. bakKind: eth (kart / VLAN bak.<ID>, PPPoE
  // pppbak), usb (USB 4G modem / telefon paylaşımı: adı değişebilir, arayüz grubu 77), wifi (telefon hotspot'u).
  bakStage: 'none' | 'on'; bakKind: '' | 'eth' | 'usb' | 'wifi'; bakType: '' | 'dhcp' | 'static' | 'pppoe';
  bakPort: string; bakDev: string; bakVlan: string; bakMtu: number;
  // Wi-Fi köprüsü (aynı ağ, R4 C): Pi üst Wi-Fi'a istemci (repPort), ev tarafı kartı (repLan) üst ağla AYNI ağda — ARP
  // vekili, NAT yok. Ağ düzeni yalnız kalıcıyken (on) değişir: denemede ev tarafı kartı eski profilindedir.
  repStage: 'none' | 'trial' | 'on'; repPort: string; repLan: string; repSsid: string; repDhcp: 'relay' | 'pi';
}
// Kurulum Wi-Fi'ının Pi adresi ve ağı (net-mode.sh AP_ADDR/AP_NET ile aynı; istemciler 192.168.50.20–200 alır).
export const AP_ADDR = '192.168.50.1';
export const AP_NET = '192.168.50.0/24';
// Ev Wi-Fi'ı köprüsünün adı (net-mode.sh BR_IF ile aynı).
export const HOME_BRIDGE = 'br0';
const NET_MODE_STATE = '/etc/pi5-gateway/net/state';
export function readNetModeState(): NetModeState | null {
  let text: string;
  try { text = fs.readFileSync(NET_MODE_STATE, 'utf8'); } catch { return null; }
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const stage = kv.stage === 'trial' || kv.stage === 'static' ? kv.stage : 'none';
  const apStage = kv.ap_stage === 'trial' || kv.ap_stage === 'on' ? kv.ap_stage : 'none';
  const homeStage = kv.home_stage === 'trial' || kv.home_stage === 'on' ? kv.home_stage : 'none';
  const ifName = (s: string | undefined) => (/^[A-Za-z0-9_.-]{1,15}$/.test(s || '') ? s! : '');
  // /8'den geniş bir ağ (bozuk dosya, ör. /0) iç içe ağ elemesinde diğer tüm LAN ağlarını silerdi.
  const cidrOk = (s: string) => (parseCidr(s)?.prefix ?? 0) >= 8;
  return {
    stage,
    iface: /^[A-Za-z0-9_.-]{1,15}$/.test(kv.iface || '') ? kv.iface : '',
    transit: cidrOk(kv.transit || '') ? kv.transit : '',
    client: cidrOk(kv.client || '') ? kv.client : '',
    gw: isIpv4(kv.gw || '') ? kv.gw : '',
    apStage,
    apIface: /^[A-Za-z0-9_.-]{1,15}$/.test(kv.ap_iface || '') ? kv.ap_iface : '',
    homeStage,
    homeIface: ifName(kv.home_iface),
    lanIf: ifName(kv.lan_if),
    wanStage: kv.wan_stage === 'trial' || kv.wan_stage === 'on' ? kv.wan_stage : 'none',
    wanPort: ifName(kv.wan_port),
    wanDev: ifName(kv.wan_dev),
    wanType: kv.wan_type === 'dhcp' || kv.wan_type === 'static' || kv.wan_type === 'pppoe' ? kv.wan_type : '',
    wanVlan: /^\d{1,4}$/.test(kv.wan_vlan || '') ? kv.wan_vlan : '',
    wanLan: kv.wan_lan === '1',
    wanSingle: !!kv.wan_port && kv.wan_port === kv.iface && ifName(kv.wan_port) !== '',
    wanMtu: /^\d{3,4}$/.test(kv.wan_mtu || '') ? Number(kv.wan_mtu) : 0,
    wanSsid: /^[^\x00-\x1f\x7f]{1,32}$/.test(kv.wan_ssid || '') ? kv.wan_ssid : '',
    bakStage: kv.bak_stage === 'on' && ['eth', 'usb', 'wifi'].includes(kv.bak_kind) ? 'on' : 'none',
    bakKind: kv.bak_kind === 'eth' || kv.bak_kind === 'usb' || kv.bak_kind === 'wifi' ? kv.bak_kind : '',
    bakType: kv.bak_type === 'dhcp' || kv.bak_type === 'static' || kv.bak_type === 'pppoe' ? kv.bak_type : '',
    bakPort: ifName(kv.bak_port),
    bakDev: ifName(kv.bak_dev),
    bakVlan: /^\d{1,4}$/.test(kv.bak_vlan || '') ? kv.bak_vlan : '',
    bakMtu: /^\d{3,4}$/.test(kv.bak_mtu || '') ? Number(kv.bak_mtu) : 0,
    repStage: (kv.rep_stage === 'trial' || kv.rep_stage === 'on') && !!ifName(kv.rep_port) && !!ifName(kv.rep_lan) ? kv.rep_stage : 'none',
    repPort: ifName(kv.rep_port),
    repLan: ifName(kv.rep_lan),
    repSsid: /^[^\x00-\x1f\x7f]{1,32}$/.test(kv.rep_ssid || '') ? kv.rep_ssid : '',
    repDhcp: kv.rep_dhcp === 'pi' ? 'pi' : 'relay',
  };
}
const netModeActive = (s: NetModeState | null): s is NetModeState => !!s && (s.stage === 'trial' || s.stage === 'static');
// İnternet kartı deneme ya da kalıcı (kart adı geçerli).
export const wanActive = (s: NetModeState | null): s is NetModeState =>
  !!s && (s.wanStage === 'trial' || s.wanStage === 'on') && !!s.wanPort && !!s.wanDev;
// Wi-Fi köprüsü (aynı ağ) kalıcı: ev tarafı kartı NetworkManager dışında, cihazları üst ağla aynı ağda (net-mode.sh rep).
export const sameNetActive = (s: NetModeState | null): boolean => !!s && s.repStage === 'on' && !!s.repPort && !!s.repLan;
// İnternet tarafı arayüzleri: kart + (varsa) VLAN + (varsa) PPPoE — net-mode.sh wan_ifset ile aynı küme. Tek portta
// kart ev ağıdır: listeye girmez (yoksa ev ağı cihazları, NAT'ı ve güvenlik duvarı "internet tarafı" sayılırdı).
export function wanIfaces(s: NetModeState | null): string[] {
  if (!wanActive(s)) return [];
  return [...new Set([...(s.wanSingle ? [] : [s.wanPort]), ...(s.wanVlan ? [`wan.${s.wanVlan}`] : []), s.wanDev])];
}
// Yedek hattın arayüzleri — net-mode.sh bak_devs ile aynı küme: kart (ev ağı kartındaki VLAN'da kart ev ağıdır, girmez) +
// VLAN + PPPoE, Wi-Fi kartı ya da USB türünde arayüz grubu 77'deki arayüzler (adı her takışta değişebilir).
export const BAK_GROUP = '77';
export const BAK_PPP_IF = 'pppbak';
export function backupIfaces(s: NetModeState | null): string[] {
  if (!s || s.bakStage !== 'on') return [];
  if (s.bakKind === 'usb') {
    const out: string[] = [];
    try {
      for (const n of fs.readdirSync('/sys/class/net')) {
        try { if (fs.readFileSync(`/sys/class/net/${n}/netdev_group`, 'utf8').trim() === BAK_GROUP) out.push(n); } catch { /* arayüz gitti */ }
      }
    } catch { /* /sys yok */ }
    return out;
  }
  const onLanCard = s.bakKind === 'eth' && !!s.bakPort && s.bakPort === s.iface;
  return [...new Set([...(s.bakPort && !onLanCard ? [s.bakPort] : []), ...(s.bakVlan ? [`bak.${s.bakVlan}`] : []),
    ...(s.bakType === 'pppoe' ? [BAK_PPP_IF] : [])])];
}
// İnternet tarafı arayüzlerinin tamamı (ana hat + yedek hat): ev ağı cihazı, ev ağı ağı ve NAT listelerinin dışında kalır.
export function uplinkIfaces(s: NetModeState | null): string[] {
  return [...new Set([...wanIfaces(s), ...backupIfaces(s)])];
}
// Yedek hat izleyicisinin durumu (net-mode.sh backup watch → /run/pi5-gateway/failover.status). active: hangi hattan
// çıkılıyor; switches: açılıştan beri geçiş sayısı.
export interface FailoverStatus {
  active: 'primary' | 'backup'; since: number; switches: number; reason: string; primaryOk: boolean | null;
  backupOk: boolean | null; backupDev: string; checked: number; forceUntil: number;
}
const FAILOVER_STATUS = '/run/pi5-gateway/failover.status';
export function readFailoverStatus(): FailoverStatus | null {
  let text: string;
  try { text = fs.readFileSync(FAILOVER_STATUS, 'utf8'); } catch { return null; }
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const num =(v: string | undefined) => (/^\d+$/.test(v || '') ? Number(v) : 0);
  const bool = (v: string | undefined) => (v === '1' ? true : v === '0' ? false : null);
  return {
    active: kv.active === 'backup' ? 'backup' : 'primary', since: num(kv.since), switches: num(kv.switches),
    reason: (kv.reason || '').slice(0, 200), primaryOk: bool(kv.primary_ok), backupOk: bool(kv.backup_ok),
    backupDev: /^[A-Za-z0-9_.-]{1,15}$/.test(kv.backup_dev || '') ? kv.backup_dev : '', checked: num(kv.checked),
    forceUntil: num(kv.force_until),
  };
}
// Wi-Fi köprüsünün (aynı ağ) ev tarafı durumu: izleyicinin (net-mode.sh rep watch) 5 sn'de bir yazdığı dosya. state:
// active (vekil + DHCP çalışıyor) | modem (eth0 kablosu hâlâ modemde) | no_carrier | no_uplink (üst Wi-Fi'da adres yok) |
// missing (ev tarafı kartı yok). checked: son tur (eskiyse izleyici çalışmıyor).
export interface RepLanStatus { state: string; since: number; clients: number; checked: number }
export function readRepLanStatus(): RepLanStatus | null {
  let text: string;
  try { text = fs.readFileSync('/run/pi5-gateway/rep.status', 'utf8'); } catch { return null; }
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const num = (v: string | undefined) => (/^\d+$/.test(v || '') ? Number(v) : 0);
  return {
    state: /^(active|modem|no_carrier|no_uplink|missing)$/.test(kv.state || '') ? kv.state : '',
    since: num(kv.since), clients: num(kv.clients), checked: num(kv.checked),
  };
}
// Ev ağının arayüzü (internet kartı modunda): köprü açıkken br0, değilse sabit adresin kartı.
function lanIfaceOf(s: NetModeState): string {
  return s.lanIf && fs.existsSync(`/sys/class/net/${s.lanIf}`) ? s.lanIf : s.iface;
}
// Özel (NAT arkası) adres: RFC1918, CGNAT (100.64/10), link-local.
export function isPrivateIpv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
    || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || (o[0] === 169 && o[1] === 254);
}
// Kurulum Wi-Fi'ı deneme ya da kalıcı. Arayüz adı geçersizse apIface '' kalır: arayüze bağlı kurallar (giriş izni,
// 07 DHCP dosyası) yazılmaz, AP_NET yine de ağ geçidi listelerinden çıkarılır.
const apActive = (s: NetModeState | null): s is NetModeState => !!s && (s.apStage === 'trial' || s.apStage === 'on');

// Pi'nin LAN kimliği: en düşük metrikli varsayılan rotanın arayüzü ve adresi. Pi tek bacaklı ağ geçididir (modem aynı
// LAN'da); aynı alt ağda ikinci bir bacak (ör. eth0 .153 + wlan0 .144) varsa `secondary`'de döner. Eskiden LAN,
// /sys/class/net sırasındaki "diğer" arayüz sayılıyordu → çift bacakta wlan0'ın .144'ü redirect hedefi oluyordu.
// Sabit adres modunda aynı kartta iki ağ olur: `transit` modem tarafı (varsayılan rotanın adresi), `client` Pi DHCP'sinin
// ağı. ip/prefix/network her zaman CLIENT tarafıdır (arayüzde gösterilen, DHCP router/DNS); tek ağda client = transit.
// DNS redirect hedefi ve panel adresi örneği buradan değil getPi5LanIp'ten (transit) gelir.
// İnternet kartı modunda (wan): iface = EV AĞI arayüzü (eth0 / br0), transit = client (eth0'da modem tarafı adres
// yoktur), gateway = internet kartının ağ geçidi (PPPoE'de karşı uç); `wan` internet kartını anlatır. `wan.public`:
// internet kartının adresi açık IP (modem / CGNAT arkasında değil — ör. PPPoE).
export interface LanIdentity {
  iface: string; ip: string; prefix: number; gateway: string; network: string;
  secondary: { iface: string; ip: string; net?: 'transit' | 'client' }[];
  transit: { ip: string; prefix: number; network: string };
  client: { ip: string; prefix: number; network: string; source: 'config' | 'transit' };
  dualSubnet: boolean;
  wan?: { dev: string; port: string; type: string; ip: string; prefix: number; gateway: string; public: boolean };
}
export async function getLanIdentity(): Promise<LanIdentity | null> {
  if (!isLinux) return null;
  let routes: any[] = [];
  let addrs: any[] = [];
  try { routes = JSON.parse((await run('ip -j -4 route show default 2>/dev/null')) || '[]'); } catch { routes = []; }
  try { addrs = JSON.parse((await run('ip -j -4 addr show 2>/dev/null')) || '[]'); } catch { addrs = []; }
  const v4 = (ifname: string) => (addrs.find(a => a.ifname === ifname)?.addr_info || [])
    .filter((x: any) => x.family === 'inet' && x.local) as { local: string; prefixlen: number; address?: string }[];
  const ns = readNetModeState();
  // İnternet kartı modu: ev ağı eth0 / br0'da yalnız client adresidir; varsayılan rota (internet kartı) LAN değildir.
  // İnternet kartı düşse de (varsayılan rota yok) ev ağı kimliği döner.
  if (wanActive(ns) && ns.wanLan) {
    const cfg = parseCidr(ns.client);
    const lanIf = lanIfaceOf(ns);
    const live = cfg ? v4(lanIf).find(x => x.local === cfg.ip) : undefined;
    if (live) {
      const net = { ip: live.local, prefix: live.prefixlen, network: networkOf(live.local, live.prefixlen) };
      const wa = v4(ns.wanDev)[0];
      const wr = routes.find(r => r && r.dev === ns.wanDev);
      // PPPoE: varsayılan rotada "via" yoktur; karşı uç adres kaydında (address) durur.
      const wgw = wr?.gateway || (wa?.address && wa.address !== wa.local ? wa.address : '');
      return {
        iface: lanIf, ip: net.ip, prefix: net.prefix, gateway: wgw, network: net.network, secondary: [],
        transit: net, client: { ...net, source: 'config' }, dualSubnet: false,
        wan: {
          dev: ns.wanDev, port: ns.wanPort, type: ns.wanType, ip: wa?.local || '', prefix: wa?.prefixlen || 0,
          gateway: wgw, public: !!wa?.local && !isPrivateIpv4(wa.local),
        },
      };
    }
  }
  // Yedek hat LAN kimliği olamaz: yedek hatta geçilmişken (metrik 10) de ana hattın (modem) rotası seçilir.
  const bakIfs = backupIfaces(ns);
  const route = routes
    .filter(r => r && r.dev && !/^(wg|lo|docker|veth)/.test(r.dev) && !bakIfs.includes(r.dev))
    .sort((a, b) => (a.metric || 0) - (b.metric || 0))[0];
  if (!route) return null;
  const own = v4(route.dev);
  // Statik profilin varsayılan rotasında `src` yoktur → modemi içeren alt ağın adresi transit sayılır.
  const main = own.find(x => x.local === route.prefsrc)
    || (route.gateway ? own.find(x => sameSubnet(x.local, route.gateway, x.prefixlen)) : undefined)
    || own[0];
  if (!main) return null;
  const transit = { ip: main.local, prefix: main.prefixlen, network: networkOf(main.local, main.prefixlen) };
  // CLIENT: sabit adres modunda (deneme/kalıcı) durum dosyasındaki adres bu kartta gerçekten varsa; yoksa transit.
  let client: LanIdentity['client'] = { ...transit, source: 'transit' };
  const cfg = netModeActive(ns) ? parseCidr(ns.client) : null;
  const live = cfg ? own.find(x => x.local === cfg.ip) : undefined;
  if (live) client = { ip: live.local, prefix: live.prefixlen, network: networkOf(live.local, live.prefixlen), source: 'config' };
  const dualSubnet = client.network !== transit.network;
  const secondary: LanIdentity['secondary'] = [];
  for (const a of addrs) {
    if (!a.ifname || a.ifname === route.dev || /^(wg|lo|docker|veth)/.test(a.ifname)) continue;
    for (const x of v4(a.ifname)) {
      const inTransit = sameSubnet(x.local, transit.ip, transit.prefix);
      const inClient = sameSubnet(x.local, client.ip, client.prefix);
      if (!inTransit && !inClient) continue;
      // Tek ağda eski biçim korunur (net alanı yok).
      secondary.push(dualSubnet ? { iface: a.ifname, ip: x.local, net: inTransit ? 'transit' : 'client' } : { iface: a.ifname, ip: x.local });
    }
  }
  return {
    iface: route.dev, ip: client.ip, prefix: client.prefix, gateway: route.gateway || '', network: client.network,
    secondary, transit, client, dualSubnet,
  };
}

// wan = varsayılan rotanın arayüzü. Tek bacaklı ağ geçidinde (LAN'a açılan başka bir alt ağ yok) lan = wan: istemciler
// aynı arayüzden gelip aynı arayüzden modeme çıkar. Farklı alt ağlı ikinci bir kart (ör. Pi'nin Wi-Fi yayını) varsa
// o kart lan olur (eski iki kartlı davranış). Sabit adres modunda transit ve client ağları aynı karttadır: başka bir
// kart ancak ikisinin de dışında bir adresi varsa ayrı LAN sayılır. Kurulum Wi-Fi'ı (yalnız panel, iletim yok) LAN
// sayılmaz: yoksa firewall kurulumu iki kartlı yola sapıp NAT'ı yanlış karta yazardı.
// Etkin internet çıkışı: yedek hatta geçilmişse yedek hattın arayüzü ve adresi, değilse ana hat (internet kartı modunda
// kart, tek kollu modda modem tarafı). public: adres açık IP (modem / CGNAT arkasında değil).
export interface ActiveUplink { via: 'primary' | 'backup'; dev: string; ip: string; gateway: string; public: boolean }
export async function activeUplink(): Promise<ActiveUplink | null> {
  if (!isLinux) return null;
  const ns = readNetModeState();
  const fo = ns?.bakStage === 'on' ? readFailoverStatus() : null;
  if (fo?.active === 'backup' && fo.backupDev) {
    let ip = '', gateway = '';
    try {
      const a: any[] = JSON.parse((await run(`ip -j -4 addr show dev ${fo.backupDev} 2>/dev/null`)) || '[]');
      const inet = (a[0]?.addr_info || []).find((x: any) => x.family === 'inet' && x.local);
      ip = inet?.local || '';
      const r: any[] = JSON.parse((await run(`ip -j -4 route show default dev ${fo.backupDev} 2>/dev/null`)) || '[]');
      // PPPoE: varsayılan rotada "via" yoktur; karşı uç adres kaydında (address) durur.
      gateway = r.find(x => x?.gateway)?.gateway || (inet?.address && inet.address !== inet.local ? inet.address : '');
    } catch { /* arayüz gitti */ }
    return { via: 'backup', dev: fo.backupDev, ip, gateway, public: !!ip && !isPrivateIpv4(ip) };
  }
  const id = await getLanIdentity().catch(() => null);
  if (!id) return null;
  if (id.wan) return { via: 'primary', dev: id.wan.dev, ip: id.wan.ip, gateway: id.wan.gateway, public: id.wan.public };
  return { via: 'primary', dev: id.iface, ip: id.transit.ip, gateway: id.gateway, public: !isPrivateIpv4(id.transit.ip) };
}

// Sanal arayüz: çekirdekte /sys/devices/virtual altında (tailscale0, virbr0, tun*, zt*, podman / lxc köprüleri …). Adres
// taşısa da ev ağı kartı sayılmaz — yoksa güvenlik duvarı iki kartlı yola sapıp NAT'ı yanlış karta yazardı. Ev Wi-Fi'ı
// köprüsü (br0) ev ağının kendisidir: sanal sayılmaz. Okunamazsa sanal sayılmaz (eski, ad önekli davranış sürer).
// Fiziksel bir kartın üstündeki sanal aygıt (VLAN enp1s0.10, bond0, macvlan, fiziksel portlu köprü: sysfs lower_<kart>
// bağı, zincir de olabilir — VLAN → bond → kart) gerçek bir ev ağıdır: sanal sayılmaz.
function isVirtualIface(name: string, depth = 0): boolean {
  if (name === HOME_BRIDGE) return false;
  const dir = `/sys/class/net/${name}`;
  try { if (!fs.realpathSync(dir).includes('/devices/virtual/')) return false; } catch { return false; }
  if (depth >= 4) return true;
  let lowers: string[] = [];
  try { lowers = fs.readdirSync(dir).filter(e => e.startsWith('lower_')).map(e => e.slice('lower_'.length)); } catch { /* kart gitti */ }
  return !lowers.some(l => !isVirtualIface(l, depth + 1));
}

export async function detectInterfaces(): Promise<{ wan: string; lan: string }> {
  const ns = readNetModeState();
  // İnternet kartı modu: iki ayrı kart — internet tarafı adres/rota arayüzü (kart / VLAN / PPPoE), ev ağı eth0 / br0.
  if (wanActive(ns) && ns.wanLan) return { wan: ns.wanDev, lan: lanIfaceOf(ns) };
  // Wi-Fi köprüsü (aynı ağ): üst Wi-Fi internet tarafı, ev tarafı kartı (adresi önek rotasız kopyadır) ev ağı.
  if (ns && sameNetActive(ns)) return { wan: ns.repPort, lan: ns.repLan };
  const id = await getLanIdentity();
  // Yedek hat arayüzleri ne LAN ne "diğer kart" sayılır (tek kollu algı bozulmasın: ikinci ağlı kart = LAN sanılırdı).
  const bakIfs = backupIfaces(ns);
  const wan = id?.iface || (await run(`ip -o -4 route show to default | awk '{print $5}'`)).split('\n').map(x => x.trim())
    .find(d => d && !bakIfs.includes(d)) || 'eth0';
  const apIface = apActive(ns) ? ns.apIface : '';
  let other = '';
  try {
    const addrs: any[] = JSON.parse((await run('ip -j -4 addr show 2>/dev/null')) || '[]');
    for (const a of addrs) {
      if (!a.ifname || a.ifname === wan || (apIface && a.ifname === apIface) || /^(wg|lo|docker|veth|br-)/.test(a.ifname)
        || bakIfs.includes(a.ifname) || isVirtualIface(a.ifname)) continue;
      const ips = (a.addr_info || []).filter((x: any) => x.family === 'inet' && x.local).map((x: any) => x.local);
      const outside = (ip: string) => !!id
        && !sameSubnet(ip, id.transit.ip, id.transit.prefix) && !sameSubnet(ip, id.client.ip, id.client.prefix);
      if (ips.length && (!id || ips.some(outside))) { other = a.ifname; break; }
    }
  } catch { /* ip -j yok */ }
  if (other) return { wan, lan: other };
  if (id) return { wan, lan: wan };
  const links = (await run('ls /sys/class/net 2>/dev/null')).split(/\s+/).filter(Boolean);
  const lan = links.find(l =>
    l !== 'lo' && l !== wan && !l.startsWith('wg') && !l.startsWith('docker') && !l.startsWith('veth') && !l.startsWith('br-')
    && !isVirtualIface(l)
  ) || (wan === 'eth0' ? 'wlan0' : 'eth0');
  return { wan, lan };
}

// Pi5'in her istemcinin ulaşabildiği LAN IP'si (DNS redirect hedefi, panel adresi örneği). Bulunamazsa boş döner.
// Sabit adres modunda TRANSIT (modem tarafı, ör. .153) döner: geçişte modemden hâlâ 192.168.1.x alan cihazlar client
// adresine (192.168.0.1) ulaşamaz, 192.168.0.x cihazlar ise .153'e ağ geçitleri olan Pi üzerinden ulaşır. Tek ağda
// transit = client (eski davranış). Pi DHCP'sinin router/DNS değeri buradan değil, net-mode durumundaki client'tan gelir.
export async function getPi5LanIp(): Promise<string> {
  const id = await getLanIdentity();
  if (id?.transit.ip) return id.transit.ip;
  const first = (await run(`hostname -I 2>/dev/null | awk '{print $1}'`)).trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(first) ? first : '';
}

// Engellenmemesi gereken MAC'ler: Pi'nin kendi kartları ve varsayılan ağ geçidi (modem) — modem engellenirse tek bacaklı
// ağ geçidinde dönüş trafiği düşer, Pi'nin kendisi engellenirse kendi trafiği.
export async function protectedMacs(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    for (const n of fs.readdirSync('/sys/class/net')) {
      try { const m = fs.readFileSync(`/sys/class/net/${n}/address`, 'utf8').trim().toLowerCase(); if (m && m !== '00:00:00:00:00:00') out.add(m); } catch { /* */ }
    }
  } catch { /* */ }
  const gw = (await getLanIdentity())?.gateway;
  if (gw && /^\d+\.\d+\.\d+\.\d+$/.test(gw)) {
    let m = (await run(`ip neigh show ${gw} 2>/dev/null`)).match(/lladdr ([0-9a-f:]{17})/i);
    if (!m) {
      // Komşu önbelleğinde yok / FAILED (bağlantı yeni kalktı): bir ping ile çözdür, sonra yeniden bak.
      await run(`ping -c1 -W1 ${gw} >/dev/null 2>&1`, 3000);
      m = (await run(`ip neigh show ${gw} 2>/dev/null`)).match(/lladdr ([0-9a-f:]{17})/i);
    }
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
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
  vps_fallback?: string; // VPS çıkışında tünel düşerse: 'block' (varsayılan) | 'isp'
}
// IP aralığı kuralı (bkz. ipRanges.ts): DNS'e dayanmayan trafik (ör. WhatsApp aramaları) için. prefixes normalize edilmiş
// IPv4 CIDR'lardır; excludeWeb → 443 (tcp/udp) yönlendirilmez (aynı sunuculardaki web trafiği yerel kalır).
export interface RangeRoute { exit_node: string; dpi_bypass: number; prefixes: string[]; excludeWeb: boolean; vps_fallback?: string }
// Statik IP aralığı seti (hash:net; dnsmasq doldurmaz): rt_n<mark> tüm portlar, rt_x<mark> 443 hariç.
type NetSet = { mark: number; excludeWeb: boolean; prefixes: Set<string> };
const CIDR_LINE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

// Dosyayı yalnız içerik değiştiyse yazar; değişip değişmediğini döner (DNS gereksiz yere yeniden başlamasın).
function writeIfChanged(file: string, content: string): boolean {
  let old: string | null = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* dosya yok */ }
  if (old === content) return false;
  try {
    fs.writeFileSync(file, content);
  } catch (e: any) {
    // Yazılacak kural yoksa (boş dosya; ör. Pi-hole henüz kurulmadı, dizin yok) kayıp da yok — uyarı gereksiz
    if (!content.trim()) return false;
    // Disk dolu / salt okunur: kural kaydedildi ama DNS'e uygulanmadı — sessiz kalmasın
    console.error(`[routing] ${file} yazılamadı:`, e?.message || e);
    void recordEventOnce('routing', `DNS yönlendirme dosyası yazılamadı (${file.split('/').pop()}): ${e?.code || e?.message || e} — disk dolu ya da salt okunur olabilir; kurallar uygulanmadı`, 'warning', 60);
    return false;
  }
  return true;
}

// Kurulum Wi-Fi'ı DHCP'si (07): Pi-hole'un dnsmasq'ı AP ağına adres dağıtır. Listede olduğu için DNS güvenlik ağı
// (yeniden başlatma sonrası DNS gelmezse) onu da 05/06 ile birlikte boşaltır; sonraki uygulama yeniden yazar.
const AP_DNSMASQ = '/etc/dnsmasq.d/07-pi5-ap.conf';
// Güvenli arama (09; safeSearch.ts yazar): yalnız açıkken vardır. Güvenlik ağı onu da boşaltır, /etc/dnsmasq.d okumasını o da açtırır.
export const SAFESEARCH_DNSMASQ = '/etc/dnsmasq.d/09-pi5-safesearch.conf';
const DNSMASQ_D_FILES = ['/etc/dnsmasq.d/05-domain-routing.conf', '/etc/dnsmasq.d/06-domain-redirect.conf', AP_DNSMASQ, SAFESEARCH_DNSMASQ];
// İşletim sistemlerinin bağlantı denetimi adları (Android, Apple, Windows, Firefox, GNOME): kurulum Wi-Fi'ı açıkken nginx
// bunları giriş sayfasına yönlendirir → telefon "ağa giriş yap" sayfasını kendiliğinden açar. www.google.com ve
// www.apple.com bilerek yok (sıradan siteler; denetim için yukarıdakiler yeter).
const CAPTIVE_CHECK_HOSTS = [
  'connectivitycheck.gstatic.com', 'connectivitycheck.android.com', 'clients3.google.com', 'captive.apple.com',
  'www.msftconnecttest.com', 'www.msftncsi.com', 'detectportal.firefox.com', 'nmcheck.gnome.org',
];
const AP_PORTAL_URL = `http://${AP_ADDR}/portal.html`;
// dnsmasq'ın derlemedeki varsayılan kira dosyası: Pi DHCP'si kapalıyken (FTL dhcp-leasefile yazmaz) kurulum Wi-Fi'ının
// kiraları buraya yazılır. /var/lib/misc root'un olduğundan FTL kullanıcısı dosyayı kendisi oluşturamaz.
const DNSMASQ_DEFAULT_LEASES = '/var/lib/misc/dnsmasq.leases';
async function ensureDnsmasqLeaseFile(): Promise<boolean> {
  const user = (await run('systemctl show -p User --value pihole-FTL 2>/dev/null')).trim();
  if (!user || user === 'root') return true; // root olarak çalışan FTL dosyayı kendisi oluşturur
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return false;
  // run() hatada boş döner ve Number('') = 0 (root) olurdu → dosya root'a devredilir, FTL açamaz, DNS düşerdi.
  // Yalnız gerçek sayısal kimlik kabul edilir; sorgu başarısızsa dosyaya hiç dokunulmaz.
  const uidS = (await run(`id -u ${user} 2>/dev/null`)).trim();
  const gidS = (await run(`id -g ${user} 2>/dev/null`)).trim();
  if (!/^\d+$/.test(uidS) || !/^\d+$/.test(gidS)) return false;
  const uid = Number(uidS);
  const gid = Number(gidS);
  try {
    fs.mkdirSync('/var/lib/misc', { recursive: true });
    if (!fs.existsSync(DNSMASQ_DEFAULT_LEASES)) fs.writeFileSync(DNSMASQ_DEFAULT_LEASES, '', { mode: 0o644 });
    const st = fs.statSync(DNSMASQ_DEFAULT_LEASES);
    if (!st.isFile()) return false;
    if (st.uid !== uid) fs.chownSync(DNSMASQ_DEFAULT_LEASES, uid, gid);
    fs.chmodSync(DNSMASQ_DEFAULT_LEASES, 0o644);
    return fs.statSync(DNSMASQ_DEFAULT_LEASES).uid === uid;
  } catch {
    return false;
  }
}
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
// Değer = işaretlenme sırası: yeniden kurulum, kendisi başladıktan sonra yeniden işaretlenen seti listeden düşmez
// (arada gelen uygulamanın isteği kaybolmasın).
const pendingFlush = new Map<string, number>();
let pendingFlushSeq = 0;
const markPendingFlush = (s: string) => { pendingFlush.set(s, ++pendingFlushSeq); };
// Eski işaret şemasının zincirde takma ad olarak bekleyen setleri (bkz. applyDomainRouting 1c).
let legacyHeld = new Set<string>();

// Pi-hole v6 (FTL) /etc/dnsmasq.d'yi varsayılan olarak OKUMAZ (misc.etc_dnsmasq_d = false); routing (05-)
// ve redirect (06-) dosyalarımız oradan yüklenir. Değer: 'true' | 'false'; v5'te `--config` yoktur → başka
// çıktı → dokunulmaz (v5 dnsmasq.d'yi zaten okur).
// Dışa açık: güvenli arama (safeSearch.ts) açarken okumanın önceki durumunu kaydeder (ftlConfigGet "_" içeren anahtarı kabul etmez)
export async function readDnsmasqDirKey(): Promise<string> {
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
  for (const s of pendingFlush.keys()) await run(`ipset flush ${s} 2>/dev/null || true`);
  pendingFlush.clear();
}

// ─── Routing uygulama durumu (panel "uygulanıyor… / hazır" bandı) ───
// Yalnız bellekte; GET /api/routing/status bunu döner (ipset/systemctl çağırmaz — yoklama swap'ı meşgul etmesin).
// Hazır = phase 'idle' ve restart_done_seq >= restart_needed_seq (DNS yenilemesi gerektiren her uygulama yüklendi).
export type RoutingPhase = 'idle' | 'queued' | 'waiting' | 'restarting' | 'warming' | 'failed';
interface PrewarmResult { kind: 'add' | 'restart'; at: number; names: number; ips: number; error: string }
const routingStatus = {
  phase: 'idle' as RoutingPhase, apply_seq: 0, restart_needed_seq: 0, restart_done_seq: 0,
  restart_at: 0, updated_at: Date.now(), error: '', prewarm: null as PrewarmResult | null,
};
function setRoutingPhase(phase: RoutingPhase, extra: { restart_at?: number; error?: string } = {}): void {
  routingStatus.phase = phase;
  routingStatus.restart_at = extra.restart_at ?? 0;
  routingStatus.error = extra.error ?? '';
  routingStatus.updated_at = Date.now();
}
export function getRoutingApplyStatus() {
  return { ...routingStatus, prewarm: routingStatus.prewarm && { ...routingStatus.prewarm }, now: Date.now() };
}

// ─── Tünel setlerini önceden doldurma ───
// dnsmasq bir adresi sete YALNIZ yukarıdan (Unbound) gelen cevapta ekler, kendi önbelleğinden cevaplarken eklemez
// (FTL v6.5: rfc1035.c extract_addresses ← forward.c process_reply). Telefon eski cevabı önbellekte tuttukça (TTL,
// Cloudflare'de 300 sn) yeni kuralın adresleri sete girmez ve trafik modemden çıkar. Bu yüzden kural değişince Pi
// adları kendisi çözüp adresleri doğrudan sete ekler. Adlar kabuğa hiç ulaşmaz: Node çözücü + dosyadan `ipset restore`.
// list: hazır listeli satırın işareti ("# klyrix-list:adult/rt_m…", listDns.ts) — tabanı boş, hiçbir adla eşleşmez; setin
// boşaltılması / doldurulmasında o listenin son sorulan adları da işlenir (namesForLines, resolveToSets).
export interface RoutingLine { base: string; set: string; list?: string }
export function parseRoutingLines(lines: string[]): RoutingLine[] {
  const out: RoutingLine[] = [];
  for (const l of lines) {
    const m = /^ipset=\/([^/]+)\/(rt_m\d+)$/.exec(l.trim());
    if (m) { out.push({ base: m[1].toLowerCase(), set: m[2] }); continue; }
    const k = /^# klyrix-list:([a-z]+)\/(rt_m\d+)$/.exec(l.trim());
    if (k) out.push({ base: '', set: k[2], list: k[1] });
  }
  return out;
}
// dnsmasq domain_find_sets ile aynı (forward.c): büyük/küçük harf duyarsız, etiket sınırında son ek eşleşmesi; en
// uzun taban kazanır, eşitlikte sonraki satır.
export function setForName(name: string, lines: RoutingLine[]): string | null {
  const n = name.toLowerCase().replace(/\.$/, '');
  let best: RoutingLine | null = null;
  for (const l of lines) {
    if (l.list) continue;
    if ((n === l.base || n.endsWith(`.${l.base}`)) && (!best || l.base.length >= best.base.length)) best = l;
  }
  return best ? best.set : null;
}
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// 0.0.0.0/8 (engellenen adın NULL cevabı), 127/8 ve çok noktaya yayın/ayrılmış aralık sete yazılmaz: çekirdek 0.0.0.0'ı
// reddeder ve `ipset restore` ilk hatada durup kalan satırları atlar.
const isRoutableV4 = (ip: string) => {
  if (!IPV4_RE.test(ip)) return false;
  const a = Number(ip.split('.')[0]);
  return a !== 0 && a !== 127 && a < 224;
};
const ROUTING_SET_RE = /^(rt|pi5n)_m\d+$/;
const ROUTING_CONF = '/etc/dnsmasq.d/05-domain-routing.conf';
const IPSET_RESTORE_FILE = '/opt/pi5-gateway/core/pi5-prewarm.ipset';
const currentRoutingLines = (): RoutingLine[] => {
  try { return parseRoutingLines(fs.readFileSync(ROUTING_CONF, 'utf8').split('\n')); } catch { return []; }
};

// Son maxAgeS saniyede sorulan adlar (en yeniden eskiye), FTL DB'den salt okunur. Görünüm yerine tablolar: `queries`
// görünümü adı her satırda alt sorguyla çözer. Hata / süre aşımı → [] (doldurma yalnız kurallardaki adlarla sürer).
async function ftlRecentNames(maxAgeS: number, limit: number, timeoutMs: number): Promise<string[]> {
  if (!fs.existsSync(FTL_DB)) return [];
  let db: sqlite3.Database | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  try {
    db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const d = new sqlite3.Database(FTL_DB, sqlite3.OPEN_READONLY, e => (e ? reject(e) : resolve(d)));
    });
    const conn = db;
    conn.configure('busyTimeout', 3000);
    const deadline = Date.now() + timeoutMs;
    timer = setInterval(() => { if (Date.now() >= deadline) conn.interrupt(); }, 200);
    const since = Math.floor(Date.now() / 1000) - maxAgeS;
    const rows = await new Promise<any[]>((resolve, reject) => conn.all(
      `SELECT d.domain AS domain FROM (SELECT domain AS id, MAX(timestamp) AS t FROM query_storage
         WHERE timestamp > ? AND typeof(domain) = 'integer' GROUP BY domain) q
       JOIN domain_by_id d ON d.id = q.id ORDER BY q.t DESC LIMIT ?`,
      [since, limit], (e, r) => (e ? reject(e) : resolve(r))));
    return rows.map(r => String(r.domain || '').toLowerCase()).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (timer) clearInterval(timer);
    db?.close();
  }
}

// Adları kural setlerine göre çözer (A kayıtları; CNAME zinciri çözücüde izlenir). Pi-hole'un yukarısı Unbound ise
// doğrudan ona sorulur: FTL dururken / eski yapılandırmayla çalışırken de çalışır, sorgu günlüğüne düşmez ve FTL'in
// telefona ilettiği önbellekteki kaydı döner. Değilse FTL'e (127.0.0.1) sorulur. Süre dolunca eldekiyle döner.
async function resolveToSets(names: string[], lines: RoutingLine[], deadline: number): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const upstreams = await run('pihole-FTL --config dns.upstreams 2>/dev/null', 5000);
  const resolver = new dnsPromises.Resolver({ timeout: 1500, tries: 1 });
  let viaUnbound = /127\.0\.0\.1#5335/.test(upstreams);
  resolver.setServers([viaUnbound ? '127.0.0.1:5335' : '127.0.0.1']);
  const cancel = setTimeout(() => resolver.cancel(), Math.max(0, deadline - Date.now()));
  let next = 0;
  const worker = async () => {
    while (next < names.length && Date.now() < deadline) {
      const name = names[next++];
      const set = setForName(name, lines) ?? (lines.some(l => l.list) ? listSetForName(name) : null);
      if (!set) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          for (const ip of await resolver.resolve4(name)) {
            if (!isRoutableV4(ip)) continue;
            if (!out.has(set)) out.set(set, new Set());
            out.get(set)!.add(ip);
          }
        } catch (e: any) {
          // Unbound kapalıysa FTL'e düş ve bu adı bir kez daha dene (aynı anda reddedilen tüm işçiler de); diğer hatalar
          // (NXDOMAIN, zaman aşımı) adı atlar.
          if (e?.code === 'ECONNREFUSED' && attempt === 0) {
            if (viaUnbound) { viaUnbound = false; resolver.setServers(['127.0.0.1']); }
            continue;
          }
        }
        break;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: 16 }, worker));
  } finally {
    clearTimeout(cancel);
  }
  return out;
}

// Kurala ait adlar: tabanlar (+ www.) ve son 24 saatte sorulmuş, bu satırlardan birine düşen adlar (en yeniden).
async function namesForLines(only: RoutingLine[], maxNames: number, dbTimeoutMs: number): Promise<string[]> {
  const names = new Set<string>();
  for (const l of only) {
    if (!l.base.includes('.')) continue; // anahtar kelime tabanı (ör. "youtube") çözülebilir bir ad değil
    names.add(l.base);
    names.add(`www.${l.base}`);
  }
  const listSets = new Set(only.filter(l => l.list).map(l => l.set));
  for (const n of await ftlRecentNames(86400, 20000, dbTimeoutMs)) {
    if (names.size >= maxNames) break;
    const hit = setForName(n, only) || (listSets.size > 0 && listSets.has(listSetForName(n) || ''));
    if (hit && VALID_DNSMASQ_DOMAIN.test(n) && !n.startsWith('*.')) names.add(n);
  }
  return [...names].slice(0, maxNames);
}

// `ipset restore` ile toplu yazım (adresler ve set adları doğrulanmış; dosya kabuğa girmez). true = başarılı.
// Her çağrı kendi dosyasını kullanır: uygulama kuyruğu ile DNS işi eşzamanlı çağırabilir.
let ipsetRestoreSeq = 0;
async function ipsetRestore(lines: string[]): Promise<boolean> {
  if (!lines.length) return true;
  const file = `${IPSET_RESTORE_FILE}.${process.pid}.${++ipsetRestoreSeq}`;
  try {
    fs.mkdirSync('/opt/pi5-gateway/core', { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch {
    return false;
  }
  try {
    const r = await runResult(`ipset -exist -file ${file} restore`, 10000);
    if (r.code !== 0) console.error(`[routing] ipset restore başarısız: ${r.stderr.trim() || r.code}`);
    return r.code === 0;
  } finally {
    try { fs.unlinkSync(file); } catch { /* */ }
  }
}
// Statik IP aralığı setini (hash:net) atomik günceller: içerik geçici sete yazılır, gerçek setle takas edilir — arada
// setin boş kaldığı an olmaz (açık aramalar kopmaz). Ad ve aralıklar çağıranda doğrulanmıştır. true = başarılı.
async function syncNetSet(name: string, prefixes: string[]): Promise<boolean> {
  const tmp = `${name}_t`;
  const ok = await ipsetRestore([
    `create ${name} hash:net family inet`,
    `create ${tmp} hash:net family inet`,
    `flush ${tmp}`,
    ...prefixes.map(p => `add ${tmp} ${p}`),
  ]);
  let swapped = false;
  if (ok) swapped = (await runResult(`ipset swap ${tmp} ${name}`, 5000)).code === 0;
  await run(`ipset destroy ${tmp} 2>/dev/null || true`);
  return swapped;
}
// Adres setinin (hash:ip) içeriğini yeni ada kopyalar; kaynak yerinde kalır (ona başvuran zincir çalışmaya devam eder).
async function copyHashIpSet(from: string, to: string): Promise<boolean> {
  if (!ROUTING_SET_RE.test(from) || !ROUTING_SET_RE.test(to)) return false;
  const r = await runResult(`ipset save ${from}`, 10000, 16 * 1024 * 1024);
  if (r.code !== 0) return false;
  const ips = r.stdout.split('\n').map(l => l.trim().split(/\s+/))
    .filter(f => f[0] === 'add' && f[1] === from && isRoutableV4(f[2] || '')).map(f => f[2]);
  return ipsetRestore([`create ${to} hash:ip family inet`, ...ips.map(ip => `add ${to} ${ip}`)]);
}
const addLines = (target: (set: string) => string, map: Map<string, Set<string>>): string[] => {
  const out: string[] = [];
  for (const [set, ips] of map) {
    const t = target(set);
    if (!ROUTING_SET_RE.test(t)) continue;
    for (const ip of ips) if (isRoutableV4(ip)) out.push(`add ${t} ${ip}`);
  }
  return out;
};

// only: yalnız bu satırlara düşen adlar çözülür; adresin gideceği set tüm satırlara göre (en uzun eşleşme) seçilir.
// Yalnız ekler (-exist): eski FTL çalışırken de güvenlidir. Hiç hata fırlatmaz; sonuç durum bandına yazılır.
async function prewarmSets(opts: {
  kind: 'add' | 'restart'; lines: RoutingLine[]; only?: RoutingLine[]; deadlineMs: number; maxNames: number; dbTimeoutMs: number;
}): Promise<void> {
  const result: PrewarmResult = { kind: opts.kind, at: Date.now(), names: 0, ips: 0, error: '' };
  try {
    const deadline = Date.now() + opts.deadlineMs;
    const names = await namesForLines(opts.only || opts.lines, opts.maxNames, opts.dbTimeoutMs);
    result.names = names.length;
    const bySet = await resolveToSets(names, opts.lines, deadline);
    const adds = addLines(s => s, bySet);
    if (await ipsetRestore(adds)) result.ips = adds.length;
    else result.error = 'ipset restore başarısız';
  } catch (e: any) {
    result.error = String(e?.message || e);
  }
  routingStatus.prewarm = result;
}

// Boşaltılacak setler için yenisini FTL DURMADAN hazırlar (pi5n_m<mark>, betiklerin `^rt_m` listesine girmez): kalan
// kuralların adları çözülüp doldurulur. FTL dururken `ipset swap` ile tek hamlede yer değiştirir — iptables ve dnsmasq
// set'e adıyla/sırasıyla bağlı olduğundan yeni içeriği anında görür; silinen kuralın adresleri düşer, kalan siteler
// setten hiç çıkmaz (eskiden boşaltılıp telefonun yeniden sormasına kadar modemden çıkıyordu).
interface StagedSets { gens: Map<string, number>; ips: Map<string, Set<string>>; ok: boolean }
async function stageRebuild(lines: RoutingLine[]): Promise<StagedSets> {
  const gens = new Map(pendingFlush);
  const staged: StagedSets = { gens, ips: new Map(), ok: false };
  if (!gens.size) return staged;
  try {
    const only = lines.filter(l => gens.has(l.set));
    const names = await namesForLines(only, 300, 3000);
    const resolved = await resolveToSets(names, lines, Date.now() + 8000);
    for (const s of gens.keys()) staged.ips.set(s, resolved.get(s) || new Set<string>());
    const cmds: string[] = [];
    for (const s of gens.keys()) {
      const tmp = s.replace(/^rt_/, 'pi5n_');
      if (!ROUTING_SET_RE.test(tmp)) continue;
      cmds.push(`create ${tmp} hash:ip family inet`, `flush ${tmp}`);
    }
    cmds.push(...addLines(s => s.replace(/^rt_/, 'pi5n_'), staged.ips));
    staged.ok = await ipsetRestore(cmds);
  } catch (e: any) {
    console.error('[routing] set yeniden kurulumu hazırlanamadı:', e?.message || e);
  }
  return staged;
}

// FTL durmuşken çağrılır; yalnız hazırlık anındaki (anlık görüntüdeki) setler işlenir. Hazırlanan set swap edilir
// (meşgulse birkaç kez denenir, olmazsa boşalt + doldur); hazırlık başarısızsa eskisi gibi boşaltılır. Hazırlıktan sonra
// işaretlenen setler (araya giren uygulama) listede kalır — o uygulamanın planladığı sonraki iş onları işler.
async function swapStagedSets(staged: StagedSets): Promise<void> {
  for (const s of staged.gens.keys()) {
    let swapped = false;
    if (staged.ok) {
      for (let i = 0; i < 5 && !swapped; i++) {
        swapped = (await runResult(`ipset swap ${s.replace(/^rt_/, 'pi5n_')} ${s}`, 5000)).code === 0;
        if (!swapped) await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!swapped) {
      await run(`ipset flush ${s} 2>/dev/null || true`);
      if (staged.ok) await ipsetRestore(addLines(x => x, new Map([[s, staged.ips.get(s) || new Set<string>()]])));
    }
    if (pendingFlush.get(s) === staged.gens.get(s)) pendingFlush.delete(s);
  }
}
async function destroyStagedSets(staged: StagedSets): Promise<void> {
  if (!staged.ok) return;
  for (const s of staged.gens.keys()) await run(`ipset destroy ${s.replace(/^rt_/, 'pi5n_')} 2>/dev/null || true`);
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

// FTL başlatıldıktan sonra DNS'in gelmesini bekler; yavaş açılışı (prestart betiği, DB kurulumu — v6.5'te 24 saatlik
// sorgu içe aktarımı :53'ü bekletmez, arka planda sürer) çökmeden ayırır. Süreç aktif ve kendiliğinden yeniden başlamamışsa 120 sn'ye kadar
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
// Boşaltılacak setler FTL durmadan hazırlanır, dururken swap edilir; açılınca tüm kuralların adları yeniden doldurulur
// (açılışta setler boştur; swap yarışında kaçan adresler de geri gelir). true = DNS geldi.
async function restartFtlNow(): Promise<boolean> {
  if (!(await ftlUnitExists())) {
    await flushPendingSets();
    await run('pihole restartdns 2>/dev/null || systemctl restart dnsmasq 2>/dev/null || true', 30000);
    return true;
  }
  const staged = await stageRebuild(currentRoutingLines());
  await withFtlStopped(() => swapStagedSets(staged));
  await destroyStagedSets(staged);
  setRoutingPhase('warming');
  // Doldurma, FTL başladıktan SONRA okunan satırlarla: arada silinen kuralın adresleri geri eklenmesin.
  const warm = prewarmSets({ kind: 'restart', lines: currentRoutingLines(), deadlineMs: 10000, maxNames: 300, dbTimeoutMs: 3000 });
  await ensureFtlActive();
  const healthy = await waitFtlHealthy((await ftlUnitState()).restarts);
  await warm;
  if (healthy) return true;
  console.error('[routing] FTL yeniden başlatıldıktan sonra yerel DNS yanıt vermiyor — 05/06/07/09 dnsmasq dosyaları boşaltılıyor');
  // Yalnız güvenli arama dosyasında satır vardıysa yönlendirme kuralı kaybolmadı: hata onu söyler (stickyRoutingError)
  clearedOnlySafeSearch = fileHasEntries(SAFESEARCH_DNSMASQ) && !DNSMASQ_D_FILES.some(f => f !== SAFESEARCH_DNSMASQ && fileHasEntries(f));
  for (const f of DNSMASQ_D_FILES) writeIfChanged(f, '');
  routingFilesCleared = true;
  await withFtlStopped(async () => {});
  await ensureFtlActive();
  // Dosyası boşaltılan modüller (SafeSearch askıya alınır: sonraki yeniden başlatmalarda 09'u yeniden yazmasın)
  for (const fn of dnsFilesCleared) await fn().catch((e: any) => console.error('[routing] güvenlik ağı kancası:', e?.message || e));
  return false;
}
// Güvenlik ağı dosyaları boşalttığında haber alan modüller (SafeSearch — safeSearch.ts)
const dnsFilesCleared: (() => Promise<void>)[] = [];
export function onDnsFilesCleared(fn: () => Promise<void>): void { dnsFilesCleared.push(fn); }

// Eski şema takma adları bekliyor ve FTL artık güncel dosyalarla çalışıyor (DNS işi bitti): yeniden uygulama takma adları
// kaldırır, eski setleri siler. İzleyici (index.ts) sorar ve routing kuyruğunda uygular.
export async function legacyRoutingCleanupDue(): Promise<boolean> {
  if (!legacyHeld.size || dnsJobPending || dnsJobRunning) return false;
  if (routingStatus.restart_done_seq < routingStatus.restart_needed_seq) return false;
  return !(await ftlStartedBeforeFiles());
}

// Güvenlik ağı 05/06'yı boşalttı ve o günden beri hiçbir uygulama dosyaları DB'den yeniden yazmadı: routing kapalı.
// Sonraki işler (boş dosyalarla sağlıklı açılsa da) 'Hazır' değil hata bildirir; uygulama dosyayı yazınca temizlenir.
let routingFilesCleared = false;
// Boşaltmada yalnız güvenli arama dosyası (09) doluydu: yönlendirme kuralı kaybolmadı — hata güvenli aramayı söyler ve sonraki
// sağlıklı yeniden başlatma kaldırır (güvenli arama kendini askıya alır, kullanıcı oradan yeniden uygular).
let clearedOnlySafeSearch = false;
// Kalıcı routing hatası (bu durumlar sürdükçe panel 'Hazır' demez): dosyalar boşaltılmış ya da Pi-hole /etc/dnsmasq.d'yi
// okumuyor (açma denemesi DNS'i düşürdüğü için geri alınmış).
async function stickyRoutingError(): Promise<string> {
  if (routingFilesCleared) {
    if (clearedOnlySafeSearch) {
      return 'DNS yenilemesinden sonra yanıt gelmediği için güvenli arama dosyası boşaltıldı ve güvenli arama askıya alındı — Koruma Şablonları → Güvenli arama → «Şimdi uygula» ile yeniden deneyin';
    }
    return 'DNS yenilemesinden sonra yanıt gelmediği için yönlendirme kuralları geçici olarak kapatıldı — kuralı yeniden kaydedin';
  }
  if (fs.existsSync(DNSMASQ_D_REVERTED) && hasDnsmasqEntries() && (await readDnsmasqDirKey()) === 'false') {
    return "Pi-hole /etc/dnsmasq.d dosyalarını okumuyor (açma denemesi DNS'i düşürdüğü için geri alındı) — yönlendirme kuralları DNS'e yüklenmiyor";
  }
  return '';
}

// /etc/dnsmasq.d okumasını FTL DURMUŞKEN açar: çalışan FTL pihole.toml değişikliğini inotify ile görüp kendini
// yeniden başlatır (FLAG_RESTART_FTL) ve bizim restart'ımızla çakışırdı. DNS gelmezse anahtarı aynı şekilde
// geri alır ve işaret bırakır.
// Dönen metin: '' = açıldı; değilse panelde gösterilecek hata.
async function enableDnsmasqDirNow(): Promise<string> {
  const flipped = await withFtlStopped(async () => {
    await flushPendingSets();
    await run('pihole-FTL --config misc.etc_dnsmasq_d true 2>/dev/null');
    return (await readDnsmasqDirKey()) === 'true';
  });
  if (flipped && await waitFtlHealthy((await ftlUnitState()).restarts)) {
    console.log('[routing] Pi-hole v6: misc.etc_dnsmasq_d açıldı — /etc/dnsmasq.d routing/redirect dosyaları yükleniyor');
    await prewarmSets({ kind: 'restart', lines: currentRoutingLines(), deadlineMs: 10000, maxNames: 300, dbTimeoutMs: 3000 });
    return '';
  }
  let error: string;
  if (flipped) {
    // /etc/dnsmasq.d'deki bir dosya FTL'i düşürdüyse tüm ağın DNS'i gider → anahtarı geri al.
    console.error('[routing] /etc/dnsmasq.d açıldıktan sonra yerel DNS yanıt vermiyor — misc.etc_dnsmasq_d geri alınıyor');
    await withFtlStopped(() => run('pihole-FTL --config misc.etc_dnsmasq_d false 2>/dev/null'));
    error = "Pi-hole /etc/dnsmasq.d dosyalarını yükleyince DNS yanıt vermedi — okuma geri kapatıldı, yönlendirme kuralları DNS'e yüklenmiyor";
  } else {
    console.error('[routing] pihole-FTL misc.etc_dnsmasq_d açmayı reddetti (dnsmasq.d içeriği geçersiz olabilir)');
    error = "Pi-hole /etc/dnsmasq.d okumasını açmayı reddetti (oradaki bir dosya geçersiz olabilir) — yönlendirme kuralları DNS'e yüklenmiyor";
  }
  try { fs.writeFileSync(DNSMASQ_D_REVERTED, new Date().toISOString() + '\n'); } catch { /* */ }
  return error;
}

// Dosyalarımızda yüklenecek bir satır var mı? Yoksa /etc/dnsmasq.d anahtarına hiç dokunulmaz.
function fileHasEntries(f: string): boolean {
  try { return fs.readFileSync(f, 'utf8').split('\n').some(l => l.trim() && !l.startsWith('#')); } catch { return false; }
}
function hasDnsmasqEntries(): boolean {
  return DNSMASQ_D_FILES.some(fileHasEntries);
}

// Güvenli arama kapatılırken (safeSearch.ts): okumayı o açtırdıysa geri kapatılabilir mi — /etc/dnsmasq.d'nin HİÇBİR
// dosyasında (kullanıcınınkiler dahil) yüklenecek satır yok ve okuma açık.
export async function dnsmasqDirOffRestorable(): Promise<boolean> {
  if (!isLinux) return false;
  let any = false;
  try { any = fs.readdirSync('/etc/dnsmasq.d').some(f => f.endsWith('.conf') && fileHasEntries(`/etc/dnsmasq.d/${f}`)); } catch { /* dizin yok */ }
  return !any && (await readDnsmasqDirKey()) === 'true';
}
// /etc/dnsmasq.d okumasını FTL DURMUŞKEN geri kapatır (açarken olduğu gibi: çalışan FTL pihole.toml değişikliğinde kendini
// yeniden başlatırdı). Yalnız güvenli arama kapatılırken ve okumayı o açtırdıysa (Pi-hole açmadan önceki yapılandırmasına döner).
async function disableDnsmasqDirNow(): Promise<string> {
  await withFtlStopped(async () => {
    await flushPendingSets();
    await run('pihole-FTL --config misc.etc_dnsmasq_d false 2>/dev/null');
  });
  await ensureFtlActive();
  if (await waitFtlHealthy((await ftlUnitState()).restarts)) {
    console.log('[routing] Pi-hole v6: misc.etc_dnsmasq_d geri kapatıldı (güvenli arama kapandı, /etc/dnsmasq.d boş)');
    return '';
  }
  return "Pi-hole /etc/dnsmasq.d okuması kapatıldıktan sonra DNS yanıt vermedi";
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
// İş beklemeyi bitirip FTL'i yeniden başlatırken true (pending ile aynı tikte değişir): bu sürede yapılan uygulamada
// "FTL dosyalardan eski" ölçümü anlamsızdır (dosya zaten bu işten önce yazıldı) ve tüm setleri boşalttırırdı.
let dnsJobRunning = false;
let dnsJobChain: Promise<void> = Promise.resolve();
// Backend açılışı "son restart" sayılır: açılışta yeni başlamış FTL'i hemen (2 sn'de) yeniden başlatmayalım.
let lastDnsRestartAt = Date.now();
function scheduleDnsRestart(): void {
  routingStatus.restart_needed_seq = routingStatus.apply_seq;
  if (dnsJobPending) return; // bekleyen iş, çalıştığı anda en güncel dosyaları yükleyecek
  dnsJobPending = true;
  if (dnsJobRunning) setRoutingPhase('queued');
  dnsJobChain = dnsJobChain.then(async () => {
    const delay = Math.max(2000, DNS_RESTART_MIN_GAP_MS - (Date.now() - lastDnsRestartAt));
    setRoutingPhase('waiting', { restart_at: Date.now() + delay });
    await new Promise(res => setTimeout(res, delay));
    dnsJobPending = false; // bundan sonraki değişiklikler yeni bir iş planlar
    dnsJobRunning = true;
    const jobSeq = routingStatus.restart_needed_seq; // bu işin yükleyeceği dosyalar bu sıraya kadar yazıldı
    lastDnsRestartAt = Date.now();
    let error = '';
    try {
      if ((await ftlUnitState()).active === 'inactive' && await ftlUnitExists()) {
        // Kullanıcı Pi-hole'u durdurmuş: başlatma. Setler boşaltılır; FTL bir sonraki açılışında dosyaları yükler.
        await flushPendingSets();
        error = 'Pi-hole kapalı — kural Pi-hole açılınca etkinleşir';
        return;
      }
      setRoutingPhase('restarting');
      // Diğer modüllerin dosyaları (SafeSearch 09) bu yeniden başlatmada güncel çakışmalarla yüklensin
      for (const fn of beforeDnsRestart) await fn().catch((e: any) => console.error('[routing] DNS öncesi kanca:', e?.message || e));
      // Güvenli arama kapandı ve okumayı o açtırmıştı: /etc/dnsmasq.d hâlâ boşsa okuma bu yeniden başlatmada geri kapatılır
      const restoreOff = restoreDirOffWanted;
      restoreDirOffWanted = false;
      if (restoreOff && await dnsmasqDirOffRestorable()) error = await disableDnsmasqDirNow();
      else if (await dnsmasqDirNeedsEnable()) error = await enableDnsmasqDirNow();
      else if (await restartFtlNow() && clearedOnlySafeSearch) { routingFilesCleared = false; clearedOnlySafeSearch = false; }
      if (!error) error = await stickyRoutingError();
    } catch (e: any) {
      error = `DNS yeniden başlatılamadı: ${e?.message || e}`;
      console.error('[routing] DNS yeniden başlatılamadı:', e?.message);
    } finally {
      dnsJobRunning = false;
      routingStatus.restart_done_seq = Math.max(routingStatus.restart_done_seq, jobSeq);
      // Hata, sırada iş olsa da yayımlanır (panel görsün); sıradaki iş kendi aşamalarını yazar.
      if (error) setRoutingPhase('failed', { error });
      else if (!dnsJobPending) setRoutingPhase('idle');
    }
  });
}

// /etc/dnsmasq.d'ye kendi dosyasını yazan başka modül (SafeSearch 09 — safeSearch.ts): dosya değişince aynı birleştirilmiş
// yeniden başlatma işi (aralık, /etc/dnsmasq.d okumasını açma, DNS gelmezse dosyaları boşaltan güvenlik ağı). Kanca, iş FTL'i
// yeniden başlatmadan hemen önce çağrılır: modül dosyasını güncel duruma göre yeniden yazar (ör. kullanıcı aynı ad için
// Routing'de yönlendirme ekledi) — ayrı bir yeniden başlatma gerekmez.
const beforeDnsRestart: (() => Promise<void>)[] = [];
export function onBeforeDnsRestart(fn: () => Promise<void>): void { beforeDnsRestart.push(fn); }
// opts.restoreDnsmasqDirOff: güvenli arama kapandı, okumayı (misc.etc_dnsmasq_d) o açtırmıştı — iş anında hâlâ boşsa geri kapat
let restoreDirOffWanted = false;
export function requestDnsRestart(opts: { restoreDnsmasqDirOff?: boolean } = {}): void {
  if (!isLinux) return;
  if (opts.restoreDnsmasqDirOff) restoreDirOffWanted = true;
  routingStatus.apply_seq++;
  scheduleDnsRestart();
}

// FTL'i kendisi durdurup başlatan dış işler (ör. Pi DHCP betiği: pihole.toml yalnız FTL durmuşken yazılır) aynı zincire
// girer: bekleyen/çalışan DNS yeniden başlatması bitince çalışır, sonraki işler onu bekler (iki taraf FTL'i aynı anda
// durdurup başlatmasın). Önceki işin sonucu ne olursa olsun çalışır; zincir bu işin hatasıyla kırılmaz (hata çağırana
// döner). Bitince "son restart" sayılır: sıradaki yeniden başlatma en az DNS_RESTART_MIN_GAP_MS bekler.
export function runExclusiveDnsTask<T>(fn: () => Promise<T>): Promise<T> {
  const job = async () => {
    try { return await fn(); } finally { lastDnsRestartAt = Date.now(); }
  };
  const task = dnsJobChain.then(job, job);
  dnsJobChain = task.then(() => undefined, () => undefined);
  return task;
}

// Pi-hole ayarı (pihole.toml) okuma: `pihole-FTL --config <anahtar>` (FTL çalışmasa da). Okunamazsa null.
export async function ftlConfigGet(key: string): Promise<string | null> {
  if (!isLinux || !/^[a-zA-Z][a-zA-Z0-9.]*$/.test(key)) return null;
  const r = await runResult(`pihole-FTL --config ${shq(key)}`, 10000);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Pi-hole ayarlarını (Pi-hole → Ayarlar) yazar: pi-dhcp.sh gibi FTL DURURKEN (çalışan FTL'e yazılan DNS çekirdeği ayarları
// kendini yeniden başlatır; birkaç anahtarda üst üste başlatma olurdu). DNS birkaç saniye kesilir. Önceki değerler okunur;
// yazma reddedilirse (pihole-FTL değeri doğrular) ya da FTL yeni değerlerle sağlıklı açılmazsa geri yazılır. Panelin DNS iş
// kuyruğunda sırayla (routing / Pi DHCP yeniden başlatmalarıyla çakışmaz).
export async function applyFtlConfig(pairs: [string, string][]): Promise<{ ok: boolean; error?: string }> {
  if (!isLinux) return { ok: false, error: 'Yalnız Pi üzerinde' };
  if (!pairs.length) return { ok: true };
  for (const [k] of pairs) if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(k)) return { ok: false, error: `Geçersiz ayar: ${k}` };
  return runExclusiveDnsTask(async () => {
    const old: [string, string][] = [];
    for (const [k] of pairs) {
      const v = await ftlConfigGet(k);
      if (v === null) return { ok: false, error: `Pi-hole ayarı okunamadı: ${k} (Pi-hole kurulu mu?)` };
      old.push([k, v]);
    }
    const write = async (ps: [string, string][]): Promise<string> => {
      for (const [k, v] of ps) {
        const r = await runResult(`umask 022; pihole-FTL --config ${shq(k)} ${shq(v)}`, 20000);
        if (r.code !== 0) return `${k}: ${(r.stderr || r.stdout).trim().split('\n').pop() || `çıkış ${r.code}`}`.slice(0, 200);
      }
      return '';
    };
    let err = '';
    await withFtlStopped(async () => {
      err = await write(pairs);
      if (err) await write(old);
    });
    if (err) {
      await waitFtlHealthy((await ftlUnitState()).restarts);
      return { ok: false, error: `Pi-hole ayarı reddetti — ${err}` };
    }
    if (await waitFtlHealthy((await ftlUnitState()).restarts)) return { ok: true };
    await withFtlStopped(async () => { await write(old); });
    await waitFtlHealthy((await ftlUnitState()).restarts);
    return { ok: false, error: 'Pi-hole yeni ayarlarla açılmadı — önceki ayarlar geri yüklendi' };
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
// Sabit adres modunda (deneme/kalıcı) durum dosyasındaki transit ve client ağları, kart ve iki adres de eklenir: kablo
// o an çıkmışken ya da profil yeniden kalkarken uygulanan kurallar client ağını düşürmesin.
// Kurulum Wi-Fi'ı açıkken (deneme/kalıcı) AP kartı ve AP_NET listelere girmez: o ağın istemcileri NAT/iletim izni almaz,
// yalnız Pi'nin kendisine (panel, DNS, DHCP) ulaşır — iletimi ayrıca net-mode.sh'nin pi5_ap tablosu düşürür.
// 192.168.50.1 Pi'nin kendi adresi olarak selfIps'te kalır (AP o an kalkmamış olsa da eklenir).
// Sabit adres modunda ev Wi-Fi köprüsü (br0) de listeye önceden girer: ev Wi-Fi'ı açılınca adresler ve istemci trafiği
// eth0'dan br0'a geçer; kurallar geçişten önce ve sonra (köprü kurulamayıp eth0'a dönülse de) eşleşsin. Köprü yokken
// `iifname "br0"` hiçbir pakete uymaz.
const GW_NFT = '/opt/pi5-gateway/core/pi5-gw.nft';
const IN_NFT = '/opt/pi5-gateway/core/pi5-in.nft';
// İnternet kartı modunda (R3) kart / VLAN / PPPoE arayüzleri ve ağları LAN sayılmaz (wanIfs ayrı döner): internet
// tarafından gelen trafik ev ağı gibi iletilmez, maskelemesi ve korumasını net-mode.sh'nin pi5_wan tabloları yapar.
// Modem tarafı ağ (transit) o modda ev ağında değildir: LAN ağlarına eklenmez.
// Wi-Fi köprüsünde (aynı ağ) ev tarafı kartı da LAN'dır (önek rotası olmadığı için çekirdek rotalarında görünmez);
// sameNet dolu döner: istemci trafiği maskelenmez (modem cihazları kendi adresleriyle görür), iki yön de iletilir.
async function detectGatewayLan(ns: NetModeState | null = readNetModeState()): Promise<{ nets: string[]; ifaces: string[]; selfIps: string[]; wanIfs: string[]; sameNet: { lan: string; up: string } | null }> {
  const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const within = (net: string, outer: string) => {
    const [a, pa] = net.split('/');
    const [b, pb] = outer.split('/');
    const div = 2 ** (32 - Number(pb));
    return Number(pb) <= Number(pa) && Math.floor(ipNum(a) / div) === Math.floor(ipNum(b) / div);
  };
  const apOn = apActive(ns);
  const apIf = apActive(ns) ? ns.apIface : '';
  const isApIface = (dev: string) => !!apIf && dev === apIf;
  const inApNet = (net: string) => apOn && within(net, AP_NET);
  const wanIfs = uplinkIfaces(ns); // internet kartı + yedek hat: ağları ev ağı listesine girmez
  const wanLan = wanActive(ns) && ns.wanLan;
  const nets = new Set<string>();
  const ifaces = new Set<string>();
  const selfIps = new Set<string>();
  for (const line of (await run('ip -4 -o route show proto kernel scope link 2>/dev/null')).split('\n')) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+\/\d+)\s+dev\s+([A-Za-z0-9_.-]{1,15})\s/);
    if (!m || /^(wg|lo)/.test(m[2]) || isApIface(m[2]) || inApNet(m[1]) || wanIfs.includes(m[2])) continue;
    nets.add(m[1]);
    ifaces.add(m[2]);
  }
  for (const m of (await run('ip -4 -o addr show 2>/dev/null')).matchAll(/\sinet\s(\d+\.\d+\.\d+\.\d+)\//g)) selfIps.add(m[1]);
  if (apOn) selfIps.add(AP_ADDR);
  const sameNet = ns && sameNetActive(ns) ? { lan: ns.repLan, up: ns.repPort } : null;
  if (sameNet) ifaces.add(sameNet.lan);
  if (netModeActive(ns)) {
    if (ns.iface && !/^(wg|lo)/.test(ns.iface) && !isApIface(ns.iface)) ifaces.add(ns.iface);
    ifaces.add(HOME_BRIDGE);
    for (const c of [wanLan ? null : parseCidr(ns.transit), parseCidr(ns.client)]) {
      if (!c) continue;
      if (!inApNet(c.network)) nets.add(c.network);
      selfIps.add(c.ip);
    }
  }
  const all = [...nets];
  return { nets: all.filter(n => !all.some(o => o !== n && within(n, o))), ifaces: [...ifaces], selfIps: [...selfIps], wanIfs, sameNet };
}

// opts.staleVps: izleyicinin "yanıt vermiyor" onayladığı VPS'ler — tünel rotaları tablolara konmaz (bkz. syncMarkTable).
export async function applyDomainRouting(domains?: DomainRoute[], ranges: RangeRoute[] = [], opts: { staleVps?: ReadonlySet<number>; lists?: ListRoute[] } = {}): Promise<void> {
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
  // Bekleyen ya da çalışan bir DNS işi varken ölçülmez: önceki uygulamanın yazdığı dosya o işi bekliyor (art arda iki
  // eklemede ikincisi tüm setleri boşalttırıyordu); iş FTL'i zaten bu dosyalardan sonra başlatır.
  const ftlStale = !(dnsJobPending || dnsJobRunning) && await ftlStartedBeforeFiles();

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

  // Kurulum Wi-Fi'ı (net-mode.sh durumu; tek okuma — 07 dosyası, yönlendirme haritası, ağ geçidi listeleri ve giriş izni
  // aynı anlık görüntüyü kullanır). Deneme/kalıcıyken Pi-hole'un dnsmasq'ı AP ağına adres dağıtır: router ve DNS Pi'nin
  // AP adresi, 114 (RFC 8910) telefona giriş sayfasının yerini söyler. Seçenekler pi5ap etiketli: yalnız bu aralığa gider,
  // Pi DHCP'sinin cihaz ağıyla karışmaz. Kapalıyken dosya boş; değişiklik DNS yenilemesi planlar (aşağıda, 5. adım).
  const netState = readNetModeState();
  const apOn = apActive(netState);
  let apIf = apOn ? netState.apIface : '';
  // Pi DHCP'si kapalıyken FTL, dnsmasq'a kira dosyası yolu vermez → dnsmasq varsayılan kira dosyasını kullanır ve FTL
  // kullanıcısı (pihole) onu oluşturamaz: dnsmasq başlamaz, TÜM EVİN DNS'İ gider (gerçek FTL 6.5 ile görüldü). Dosya
  // önceden FTL kullanıcısına ait açılır; açılamazsa 07 yazılmaz (kurulum Wi-Fi'ı adres dağıtamaz ama DNS korunur).
  if (apIf && !(await ensureDnsmasqLeaseFile())) {
    console.error(`[routing] ${DNSMASQ_DEFAULT_LEASES} hazırlanamadı — kurulum Wi-Fi'ı DHCP'si (07) yazılmadı, DNS korunuyor`);
    apIf = '';
  }
  // dhcp-authoritative: Pi DHCP'si kapalıyken FTL bunu yazmaz; yoksa bilinmeyen kirayla yeniden bağlanan telefon
  // yanıtsız bekler (dhclient 22 sn). Aralığı olmayan ağlara (eth0 / ev ağı) etkisi yok — oradaki isteklere yanıt verilmez.
  const apConf = apIf
    ? [
      "# Klyrix Gate kurulum Wi-Fi'ı — backend yazar (net-mode.sh durumu), elle düzenlemeyin",
      'dhcp-range=set:pi5ap,192.168.50.20,192.168.50.200,255.255.255.0,1h',
      `dhcp-option=tag:pi5ap,option:router,${AP_ADDR}`,
      `dhcp-option=tag:pi5ap,option:dns-server,${AP_ADDR}`,
      `dhcp-option=tag:pi5ap,114,"http://${AP_ADDR}/api/captive"`,
      'dhcp-authoritative',
    ].join('\n') + '\n'
    : '';
  const apChanged = writeIfChanged(AP_DNSMASQ, apConf);

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
  const mappedHosts = new Set<string>(); // nginx map anahtarları büyük/küçük harf duyarsız
  for (const [domain, url] of Object.entries(redirectMap)) {
    const safeHost = domain.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeUrl = String(url).replace(/["\r\n\\]/g, '').trim();
    if (safeHost && /^https?:\/\//i.test(safeUrl)) {
      mapLines.push(`    "${safeHost}" "${safeUrl}";`);
      mappedHosts.add(safeHost.toLowerCase());
    }
  }
  // Kurulum Wi-Fi'ı açıkken bağlantı denetimi adları giriş sayfasına: bu adlarla Pi'nin nginx'ine yalnız AP istemcileri
  // gelir (80. port trafikleri pi5_ap ile Pi'ye DNAT'lanır; LAN istemcileri internete gider). `return 302` rewrite
  // aşamasında, auth_basic'ten önce çalışır. dnsmasq address= satırlarına eklenmez. Aynı ad için kullanıcı kuralı varsa o
  // kalır: map'te yinelenen anahtar ("conflicting parameter") nginx yapılandırmasını bozar.
  if (apOn) {
    for (const host of CAPTIVE_CHECK_HOSTS) if (!mappedHosts.has(host)) mapLines.push(`    "${host}" "${AP_PORTAL_URL}";`);
  }
  mapLines.push('}');
  // nginx kurulu değilse (dizin yok) harita yazılmaz — eskisi gibi sessiz
  if (fs.existsSync('/etc/nginx/conf.d')) try {
    fs.writeFileSync('/etc/nginx/conf.d/pi5-redirect-map.conf', mapLines.join('\n') + '\n');
    // Sınamadan geçmezse yüklenmez (çalışan yapılandırma kalır) ama sessiz de kalmaz: yönlendirme kuralları çalışmaz
    const t = await run('command -v nginx >/dev/null 2>&1 || { echo none; exit 0; }; nginx -t >/dev/null 2>&1 && echo ok || echo fail');
    if (t === 'ok') await run('nginx -s reload 2>/dev/null || systemctl reload nginx 2>/dev/null || true');
    else if (t === 'fail') {
      console.error('[routing] nginx yapılandırma sınaması geçmedi — yönlendirme haritası yüklenmedi');
      void recordEventOnce('routing', 'Alan adı yönlendirme haritası nginx sınamasından geçmedi, yüklenmedi — yönlendirme kuralları çalışmıyor (Sistem Logları)', 'warning', 60);
    }
  } catch (e: any) {
    console.error('[routing] nginx yönlendirme haritası yazılamadı:', e?.message || e);
  }

  // İşaret şeması: routeMarks.ts — ISP (0), yalnız DPI (200), VPS tüneli 0x8000|id (+DPI, +tünel düşerse operatörden
  // devam). Geçersiz çıkış (VPS kimliği sayı değil / 8191'den büyük) ISP sayılır ve günlüğe yazılır.
  const badExits = new Set<string>();
  function getFwmark(exit_node: string, dpi_bypass: number, vps_fallback?: string): number {
    const m = encodeRouteMark(String(exit_node || 'isp'), !!dpi_bypass, normFallback(vps_fallback));
    if (m !== null) return m;
    badExits.add(String(exit_node));
    return dpi_bypass ? DPI_ONLY_MARK : 0;
  }

  // 1. dnsmasq ipset config — Pi-hole/dnsmasq, çözülen IP'leri kernel ipset'lerine yazar.
  const ipsetLines: string[] = [];
  const markSets = new Map<number, string>(); // mark → ipset name

  for (const d of routingDomains) {
    const mark = getFwmark(d.exit_node, d.dpi_bypass, d.vps_fallback);
    if (mark === 0) continue; // default route, no special routing needed
    const setName = `rt_m${mark}`;
    if (!markSets.has(mark)) markSets.set(mark, setName);
    // Keyword (nokta yok) ve *.example.com → dnsmasq suffix eşleşmesi (substring DEĞİL — dnsmasq sınırı).
    const base = d.domain.startsWith('*.') ? d.domain.slice(2) : d.domain;
    ipsetLines.push(`ipset=/${base}/${setName}`);
  }

  // 1a. Hazır listeli satırlar (Yetişkin / Kumar — listDns.ts): işaretliyse (VPS çıkışı ya da yalnız DPI) liste adları
  //     server= ile panelin ileticisine gider, iletici adresleri kuralın setine ekler (ipset= ile 83 bin satır her
  //     sorguyu yavaşlatırdı). Yalnız DPI'da set 0x4000 işaretini verir, Zapret o işarete bakar. İşaret satırı setin
  //     değişimini izletir.
  const listPlan = planListRouting(opts.lists || [], r => getFwmark(r.exit_node, r.dpi_bypass, r.vps_fallback),
    collapsedList, d => VALID_DNSMASQ_DOMAIN.test(d));
  for (const [mark, set] of listPlan.marks) if (!markSets.has(mark)) markSets.set(mark, set);
  ipsetLines.push(...listPlan.markers);
  if (listPlan.skipped.length) console.error(`[routing] hazır liste yüklenemedi, satır uygulanmadı: ${listPlan.skipped.join(', ')}`);
  configureListDns(listPlan.sets, listPlan.sets.size ? parseUpstreams(await run('pihole-FTL --config dns.upstreams 2>/dev/null', 5000)) : []);

  // 1b. IP aralığı setleri (kuralın çıkışına göre): aynı çıkış + aynı kip (tüm portlar / 443 hariç) tek sette birleşir.
  const netSets = new Map<string, NetSet>();
  for (const r of ranges) {
    const mark = getFwmark(r.exit_node, r.dpi_bypass, r.vps_fallback);
    if (mark === 0) continue;
    const name = `${r.excludeWeb ? 'rt_x' : 'rt_n'}${mark}`;
    const e = netSets.get(name) || { mark, excludeWeb: r.excludeWeb, prefixes: new Set<string>() };
    for (const p of r.prefixes) if (CIDR_LINE.test(p)) e.prefixes.add(p);
    netSets.set(name, e);
  }
  for (const [name, e] of netSets) if (!e.prefixes.size) netSets.delete(name);
  if (badExits.size) console.error(`[routing] geçersiz VPS çıkışı ISP sayıldı: ${[...badExits].join(', ')}`);

  // Önceki satırlar: bir satır ÇIKARILDIYSA (domain silindi / başka sete taşındı) o setteki eski IP'ler bayat kalır →
  // yalnız o set boşaltılır. Salt eklemede bayat içerik yoktur; boşaltmak tüm açık tünel bağlantılarını koparırdı.
  let oldRoutingLines: string[] = [];
  try { oldRoutingLines = fs.readFileSync('/etc/dnsmasq.d/05-domain-routing.conf', 'utf8').split('\n').filter(Boolean); } catch { /* ilk kurulum */ }

  // 1c. Eski işaret şemasından (100+id / 300+id) geçiş: eski setin adresleri yeni adına KOPYALANIR ve eski set, FTL yeni
  //     dosyayla yeniden başlayana dek zincirde yeni işaretin TAKMA ADI olarak kalır — o arada dnsmasq yeni çözdüğü adresleri
  //     hâlâ eski sete yazar, zincir onları da yeni işaretle işaretler (geçişte sızıntı yok, çözülmüş adresler kaybolmaz).
  //     Eski satırlar yeni adlarla eşlenir: geçiş "satır çıkarıldı" / "yeni set" sayılmaz, kopya boşaltılmaz. Eski kurallar
  //     "engelle" (sütunun varsayılanı) sayılır. Karşılığı istenmeyen eski setler zincir yenilendikten hemen sonra silinir;
  //     takma adlar FTL güncel dosyaları yükledikten sonraki uygulamada kalkar (izleyici tetikler: legacyRoutingCleanupDue).
  const existingSets = new Set((await run('ipset list -n 2>/dev/null')).split('\n').map(s => s.trim()).filter(Boolean));
  const legacySets: string[] = [];
  const legacyAlias = new Map<string, number>(); // eski set → yeni işaret (hedefi istenenler)
  const migrated = new Map<string, string>(); // bu uygulamada kopyalananlar
  const wantedSets = new Set(markSets.values());
  for (const s of existingSets) {
    const lm = /^rt_m(\d+)$/.exec(s);
    const n = lm ? Number(lm[1]) : NaN;
    // v2.24.75: yalnız-DPI işareti 200 → 0x4000 (rt_m200 → rt_m16384) — aynı geçiş yolundan
    const legacyDpi = n === LEGACY_DPI_ONLY_MARK;
    const legacy = lm && !legacyDpi ? decodeLegacyVpsMark(n) : null;
    if (!legacy && !legacyDpi) continue;
    legacySets.push(s);
    const mark = legacyDpi ? DPI_ONLY_MARK : legacy ? encodeRouteMark(String(legacy.vpsId), legacy.dpi, 'block') : null;
    if (mark === null || !wantedSets.has(`rt_m${mark}`)) continue;
    legacyAlias.set(s, mark);
    if (!existingSets.has(`rt_m${mark}`) && await copyHashIpSet(s, `rt_m${mark}`)) migrated.set(s, `rt_m${mark}`);
  }
  if (legacyAlias.size) {
    oldRoutingLines = oldRoutingLines.map(l => l.replace(/\/(rt_m\d+)$/, (all, set: string) => (legacyAlias.has(set) ? `/rt_m${legacyAlias.get(set)}` : all)));
  }
  if (migrated.size) console.log(`[routing] eski işaret şemasından geçiş: ${[...migrated].map(([a, b]) => `${a} → ${b}`).join(', ')}`);
  const routingChanged = writeIfChanged('/etc/dnsmasq.d/05-domain-routing.conf', [...ipsetLines, ...listPlan.serverLines].join('\n') + '\n');
  // Takma adlar FTL güncel dosyayı yükleyene dek kalır: dosya bu uygulamada değiştiyse, DNS işi bekliyor / sürüyorsa ya da
  // FTL dosyalardan önce başladıysa.
  const aliases = legacyAlias.size && (routingChanged || dnsJobPending || dnsJobRunning || ftlStale) ? legacyAlias : new Map<string, number>();
  legacyHeld = new Set(aliases.keys());
  routingFilesCleared = false; // dosya artık DB'deki kuralları yansıtıyor
  clearedOnlySafeSearch = false;
  const newRoutingLines = new Set(ipsetLines);
  const setsWithRemovals = new Set<string>();
  const oldSets = new Set<string>();
  for (const line of oldRoutingLines) {
    const m = line.match(/^(?:ipset=\/[^/]+|# klyrix-list:[a-z]+)\/(rt_m\d+)$/);
    if (!m) continue;
    oldSets.add(m[1]);
    if (!newRoutingLines.has(line)) setsWithRemovals.add(m[1]);
  }

  // Eski nft tabanlı (bozuk) marklama dosyasını temizle
  await run('rm -f /etc/nftables.d/domain-routing.conf 2>/dev/null || true');
  await run('nft delete table inet domain_routing 2>/dev/null || true');

  // run() hata yuttuğu için araç yoksa aşağıdaki adımların hepsi sessizce boşa gider — en azından günlükte görünsün.
  if (markSets.size > 0 || netSets.size > 0) {
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
  let setCreated = false;
  for (const [, setName] of markSets) {
    if (!existingSets.has(setName)) setCreated = true;
    await run(`ipset create ${setName} hash:ip family inet -exist`);
    if (ftlStale || setsWithRemovals.has(setName) || !oldSets.has(setName)) markPendingFlush(setName);
  }
  // Son domaini de çıkarılan (artık kullanılmayan) setler de boşaltılır: yeniden kullanılırlarsa eski IP'ler taşınmasın.
  for (const s of setsWithRemovals) markPendingFlush(s);

  // 2b. IP aralığı setleri zincirden ÖNCE güncellenir (zincir var olan sete başvurmalı); içerik atomik takasla değişir.
  //     Güncellenemeyen set zincire alınmaz (olmayan sete başvuran iptables-restore tüm zinciri reddederdi).
  for (const [name, e] of netSets) {
    if (!(await syncNetSet(name, [...e.prefixes]))) {
      console.error(`[routing] IP aralığı seti ${name} güncellenemedi — bu aralıklar bu uygulamada yönlendirilmiyor`);
      netSets.delete(name);
    }
  }

  // 3a. VPS tabloları ve "fwmark N lookup N" kuralları zincirden ÖNCE hazırlanır: yeni işaret alan paket kuralsız kalıp
  //     ana tablodan (ISP) çıkmasın. Tablo içeriği tünel durumuna göre (syncMarkTable); kullanılmayanlar 4. adımda.
  const rulePrefs = await readManagedRules();
  const allMarks = new Set<number>([...markSets.keys(), ...[...netSets.values()].map(e => e.mark)]);
  const staleVps = opts.staleVps || new Set<number>();
  const localRules = await readLocalRules();
  for (const mark of allMarks) {
    const v = decodeVpsMark(mark);
    if (!v) continue;
    if (!(rulePrefs.get(mark) || []).some(p => p > LOCAL_MAIN_PREF)) await run(`ip rule add pref ${VPS_RULE_PREF} fwmark ${mark} table ${mark} 2>/dev/null || true`);
    await syncMarkTable(mark, v, staleVps);
    // "Engelle": Pi'nin kendi trafiği ikiz tabloya (yalnız tünel rotası) bakar — tünel yokken operatörden devam eder.
    if (v.ispFallback) continue;
    const twin = mark | ISP_FALLBACK_BIT;
    await syncMarkTable(twin, { ...v, ispFallback: true }, staleVps);
    if (!localRules.twin.has(mark)) await run(`ip rule add pref ${LOCAL_RULE_PREF} fwmark ${mark} iif lo table ${twin} 2>/dev/null || true`);
    if (!localRules.main.has(mark)) await run(`ip rule add pref ${LOCAL_MAIN_PREF} fwmark ${mark} iif lo table main 2>/dev/null || true`);
  }

  // 3. iptables mangle ile marklama — `-m set` kernel ipset'lerini DOĞRU okur (nft @set okuyamaz).
  //    Zincir tek iptables-restore işlemiyle (atomik) yeniden kurulur: eski yöntemde -F ile -A'lar arasındaki boşlukta
  //    işaretsiz kalan tünel paketleri, masquerade arayüz değişimi yüzünden çekirdekçe kesiliyordu (her kural
  //    değişikliğinde açık tünel bağlantıları sıfırlanıyordu). Olmazsa eski adım adım yönteme düşülür (aynı kurallar).
  if (!(await rebuildRoutingChainAtomic(markSets, netSets, aliases))) {
    await run('iptables -t mangle -N PI5_ROUTING 2>/dev/null || true');
    await run('iptables -t mangle -F PI5_ROUTING 2>/dev/null || true');
    for (const line of buildRoutingChainRestore(markSets, netSets, aliases).split('\n')) {
      if (line.startsWith('-A PI5_ROUTING ')) await run(`iptables -t mangle ${line}`);
    }
  }
  // Artık kullanılmayan IP aralığı setleri (zincir onlara artık başvurmuyor) ve yarım kalmış geçici setler kaldırılır.
  for (const s of existingSets) {
    if ((/^rt_[nx]\d+$/.test(s) && !netSets.has(s)) || /^rt_[nx]\d+_t$/.test(s)) await run(`ipset destroy ${s} 2>/dev/null || true`);
  }
  await run('iptables -t mangle -C PREROUTING -j PI5_ROUTING 2>/dev/null || iptables -t mangle -A PREROUTING -j PI5_ROUTING');
  await run('iptables -t mangle -C OUTPUT -j PI5_ROUTING 2>/dev/null || iptables -t mangle -A OUTPUT -j PI5_ROUTING');
  // Eski şemanın setleri (takma ad olarak bekleyenler hariç): zincir artık onlara başvurmuyor.
  for (const s of legacySets) {
    if (aliases.has(s)) continue;
    pendingFlush.delete(s);
    await run(`ipset destroy ${s} 2>/dev/null || true`);
  }

  // 3b. Tünel çıkışına SNAT. VPS, Pi peer'ından yalnız 10.66.66.2 kaynaklı paketi kabul eder (AllowedIPs);
  //     NAT'sız giren LAN kaynaklı (192.168.x.x) paketleri sessizce düşürür. iptables yerine kendi nft
  //     tablomuz: eski kurulumlardan kalan yerli `table ip nat`, iptables-nft'nin aynı adlı tablosuyla çakışabilir.
  //     Firewall kurulumundaki nft pi5_nat masquerade'i ile çakışmaz (ilk eşleşen NAT uygulanır, sonuç aynı).
  //     Boş-tanımla → sil → yeniden-tanımla: her uygulamada idempotent; firewall'un include'u boot'ta da yükler.
  //     Tek bacaklı ağ geçidi: Pi'yi ağ geçidi yapan LAN istemcilerinin modeme (aynı LAN'a) geri iletilen trafiği
  //     de Pi'ye SNAT'lanır — aksi halde cevaplar modemden istemciye doğrudan döner (asimetrik) ve modem, Pi'nin
  //     istemci adına gönderdiği paketleri düşürür (canlıda doğrulandı). Pi'nin kendi trafiği ve LAN içi hariç.
  //     Kural ağ başınadır: istemci KENDİ ağının dışına giderken SNAT'lanır. Sabit adres modunda (aynı kartta iki ağ)
  //     192.168.0.x → modem 192.168.1.1 Pi'nin transit adresine (.153) SNAT'lanır; 0.x → 0.x'e hiç dokunulmaz.
  //     (Tek birleşik "daddr != tüm ağlar" kuralı 0.x → modem trafiğini hariç tutuyordu.) Tek ağda sonuç eskisiyle aynı.
  const gw = await detectGatewayLan(netState);
  const nftSet = (xs: string[], quote = false) => `{ ${xs.map(x => (quote ? `"${x}"` : x)).join(', ')} }`;
  const notSelf = gw.selfIps.length ? ` ip saddr != ${nftSet(gw.selfIps)}` : '';
  const lanClient = gw.nets.length ? `ip saddr ${nftSet(gw.nets)}${notSelf}` : '';
  // N ağının istemcisi, N dışına giden (N içi hariç).
  const leavesNet = (n: string) => `ip saddr ${nftSet([n])}${notSelf} ip daddr != ${nftSet([n])}`;
  const wgNat = [
    'table ip pi5_wgnat {}',
    'delete table ip pi5_wgnat',
    'table ip pi5_wgnat {',
    '  chain postrouting {',
    '    type nat hook postrouting priority 100; policy accept;',
    '    oifname "wg_vps*" masquerade',
    // Wi-Fi köprüsünde (aynı ağ) istemci trafiği maskelenmez: modem cihazları kendi adresleriyle görür ve onlara döner.
    ...(lanClient && gw.ifaces.length && !gw.sameNet
      ? gw.nets.map(n => `    oifname ${nftSet(gw.ifaces, true)} ${leavesNet(n)} masquerade`)
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
      // Ağ başına (NAT kuralıyla aynı): 192.168.0.x → modem tarafı da iletilir.
      ...gw.nets.map(n => `add rule inet filter pi5_gw iifname ${lanIfs} ${leavesNet(n)} oifname ${lanIfs} accept`),
      // Wi-Fi köprüsü (aynı ağ): ev tarafı ↔ üst Wi-Fi iki yönde (aynı ağ içi; üst ağdaki cihazlar da ev tarafına ulaşır).
      ...(gw.sameNet
        ? [
          `add rule inet filter pi5_gw iifname "${gw.sameNet.lan}" oifname "${gw.sameNet.up}" accept`,
          `add rule inet filter pi5_gw iifname "${gw.sameNet.up}" oifname "${gw.sameNet.lan}" accept`,
        ]
        : []),
      // İnternet kartı modu: ev ağı → internet kartı; internetten yalnız panelde açılan port yönlendirmeleri (DNAT).
      ...(gw.wanIfs.length
        ? [
          `add rule inet filter pi5_gw iifname ${lanIfs} ${lanClient} oifname ${nftSet(gw.wanIfs, true)} accept`,
          `add rule inet filter pi5_gw iifname ${nftSet(gw.wanIfs, true)} ct status dnat accept`,
        ]
        : []),
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

  // 3d. Aynı eski firewall'un `inet filter` input zinciri de `policy drop` olabilir: Pi DHCP sunucusuna (udp 67)
  //     gelen istekler ve istemci testindeki ping düşer. Panele ait `pi5_in` zinciri pi5_gw gibi her uygulamada
  //     boşaltılıp doldurulur, input'un başına bir kez `jump pi5_in` eklenir (açılışta pi5-gw-restore da yükler).
  //     Input politikası accept ise (ya da tablo yoksa) dokunulmaz.
  //     Kurulum Wi-Fi'ı açıkken AP kartına DNS (53), DHCP (67) ve panel (80) izni de eklenir; LAN kartı yoksa zincir
  //     yalnız bunun için de kurulur.
  const inChain = await run('nft list chain inet filter input 2>/dev/null');
  if (/policy drop/.test(inChain) && (gw.ifaces.length || apIf)) {
    const inRules = [
      'add chain inet filter pi5_in',
      'flush chain inet filter pi5_in',
      ...(gw.ifaces.length ? [`add rule inet filter pi5_in iifname ${nftSet(gw.ifaces, true)} udp dport 67 accept`] : []),
      'add rule inet filter pi5_in icmp type echo-request accept',
      ...(apIf
        ? [
          `add rule inet filter pi5_in iifname "${apIf}" udp dport { 53, 67 } accept`,
          `add rule inet filter pi5_in iifname "${apIf}" tcp dport { 53, 80 } accept`,
        ]
        : []),
      ...(/jump pi5_in\b/.test(inChain) ? [] : ['insert rule inet filter input jump pi5_in']),
    ];
    try {
      fs.mkdirSync('/opt/pi5-gateway/core', { recursive: true });
      fs.writeFileSync(IN_NFT, inRules.join('\n') + '\n');
      await execAsync(`nft -f ${IN_NFT}`, { timeout: 10000 });
    } catch (e: any) {
      console.error(`[routing] giriş izni (inet filter pi5_in) kurulamadı: ${String(e?.stderr || e?.message || e).trim()}`);
    }
  }

  // 4. Kullanılmayan "fwmark N lookup N" kuralları (eski şemanın 100–999 işaretleri, yalnız DPI'nin 200'ü — ISP ana
  //    tablosunu kullanır, Zapret kendi kancasıyla işler — ve silinen / değişen kuralların işaretleri) zincir yenilendikten
  //    sonra tamamen kaldırılır, tabloları boşaltılır. `ip rule add` varlık kontrolü yapmaz (trixie iproute2 her uygulamada
  //    kopya ekliyordu) → istenen işarette Pi'nin kendi trafiği kurallarından SONRA gelen tek kural kalır (3a'da eksikse
  //    1200 önceliğiyle eklendi); fazla kopyalar ve önde kalmış eski kurallar önceliğiyle silinir. Trafik ISP'ye kaçmaz.
  for (const [mark, prefs] of rulePrefs) {
    const wanted = allMarks.has(mark) && decodeVpsMark(mark) !== null;
    const keep = wanted ? (prefs.includes(VPS_RULE_PREF) ? VPS_RULE_PREF : prefs.find(p => p > LOCAL_MAIN_PREF)) : undefined;
    let kept = false;
    for (const p of prefs) {
      if (p === keep && !kept) { kept = true; continue; }
      await run(`ip rule del pref ${p} fwmark ${mark} table ${mark} 2>/dev/null || true`);
    }
    if (!wanted) await run(`ip route flush table ${mark} 2>/dev/null || true`);
  }
  // Pi'nin kendi trafiği kuralları: işaret artık "engelle" değilse kaldırılır, ikiz tablo (başka kural kullanmıyorsa) boşaltılır.
  const localWanted = (mark: number) => allMarks.has(mark) && decodeVpsMark(mark)?.ispFallback === false;
  for (const [mark, count] of localRules.twin) {
    const twin = mark | ISP_FALLBACK_BIT;
    const wanted = localWanted(mark);
    for (let i = 0; i < (wanted ? count - 1 : count); i++) await run(`ip rule del pref ${LOCAL_RULE_PREF} fwmark ${mark} iif lo table ${twin} 2>/dev/null || true`);
    if (!wanted && !allMarks.has(twin)) await run(`ip route flush table ${twin} 2>/dev/null || true`);
  }
  for (const [mark, count] of localRules.main) {
    const wanted = localWanted(mark);
    for (let i = 0; i < (wanted ? count - 1 : count); i++) await run(`ip rule del pref ${LOCAL_MAIN_PREF} fwmark ${mark} iif lo table main 2>/dev/null || true`);
  }

  // 4b. Yeni eklenen kuralların adresleri HEMEN sete: FTL yeni satırları ancak yeniden başlayınca yükler (2-15 sn) ve
  //     önbellekten verdiği cevapları hiç eklemez; telefon da eski cevabı dakikalarca kullanır. En çok 4 sn sürer,
  //     yalnız ekler; açılış ve tünel yeniden uygulamalarında (dosya değişmediği için) çalışmaz.
  const addedLines = parseRoutingLines(ipsetLines.filter(l => !oldRoutingLines.includes(l)));
  if (addedLines.length) {
    await prewarmSets({ kind: 'add', lines: parseRoutingLines(ipsetLines), only: addedLines, deadlineMs: 4000, maxNames: 40, dbTimeoutMs: 1500 });
  }

  // 5. dnsmasq/FTL'i yeniden başlat (ipset config'i alsın) — yalnız gerektiğinde ve arka planda birleştirerek:
  //    dnsmasq dosyaları (05/06/07) değiştiyse, yeni set oluştuysa (boot sonrası FTL önbelleğindeki adlar sete eklenmez),
  //    /etc/dnsmasq.d okuması açılmalıysa (v6) ya da FTL dosyaların son halinden önce başladıysa.
  routingStatus.apply_seq++;
  if (routingChanged || redirectChanged || apChanged || setCreated || ftlStale || await dnsmasqDirNeedsEnable()) {
    scheduleDnsRestart();
  } else if (!dnsJobPending && !dnsJobRunning && routingStatus.phase === 'failed') {
    // DNS yenilemesi gerekmeyen değişiklik: önceki işin geçici hatası bu değişikliğe ait değil; kalıcıysa yeniden yazılır.
    const sticky = await stickyRoutingError();
    setRoutingPhase(sticky ? 'failed' : 'idle', { error: sticky });
  }
}

// Panelin "fwmark N lookup N" kuralları (N = tablo; routeMarks.isManagedRuleMark): işaret → her kopyanın önceliği.
async function readManagedRules(): Promise<Map<number, number[]>> {
  const prefs = new Map<number, number[]>();
  for (const line of (await run('ip rule show 2>/dev/null')).split('\n')) {
    const m = line.match(/^(\d+):\s+from all fwmark (0x[0-9a-f]+|\d+) lookup (\d+)/i);
    if (!m) continue;
    const mark = Number(m[2]);
    if (mark !== Number(m[3]) || !isManagedRuleMark(mark)) continue;
    prefs.set(mark, [...(prefs.get(mark) || []), Number(m[1])]);
  }
  return prefs;
}

// Pi'nin kendi trafiği (kullanıcı kararı: kill-switch evdeki cihazlar için): "engelle" işareti M'de yerelden çıkan paket
// (`iif lo`) ikiz tabloya M|0x2000 bakar — yalnız tünel rotası; tünel yokken / yanıt vermezken kural eşleşmez, ana tablo
// (operatör). Panel güncellemesi, DDNS, hız testi tünel kapalıyken de çalışır. Sabit öncelikler, fwmark kurallarından önce:
// 1100 ikiz tablo; 1101 ana tablo — ikizde rota yoksa sonraki kural "engelle" tablosu olurdu (unreachable).
const LOCAL_RULE_PREF = 1100;
const LOCAL_MAIN_PREF = 1101;
// VPS "fwmark N lookup N" kuralları da sabit öncelikle: öncelik verilmeden eklenen kural mevcut en küçüğün bir altına girer
// (Pi kuralları varken 1099; Ev VPN'i erişim testi sürerken 49) ve Pi'nin kendi trafiğini engel tablosuna düşürürdü.
const VPS_RULE_PREF = 1200;
// "1100: fwmark M iif lo lookup M|0x2000" (twin) ve "1101: fwmark M iif lo lookup main" (main) kuralları: M → kopya sayısı.
async function readLocalRules(): Promise<{ twin: Map<number, number>; main: Map<number, number> }> {
  const twin = new Map<number, number>();
  const main = new Map<number, number>();
  for (const line of (await run('ip rule show 2>/dev/null')).split('\n')) {
    const m = line.match(/^(\d+):\s+from all fwmark (0x[0-9a-f]+|\d+) iif lo lookup (\w+)/i);
    if (!m) continue;
    const pref = Number(m[1]);
    const mark = Number(m[2]);
    if (!decodeVpsMark(mark)) continue;
    if (pref === LOCAL_RULE_PREF && Number(m[3]) === (mark | ISP_FALLBACK_BIT)) twin.set(mark, (twin.get(mark) || 0) + 1);
    else if (pref === LOCAL_MAIN_PREF && m[3] === 'main') main.set(mark, (main.get(mark) || 0) + 1);
  }
  return { twin, main };
}

// VPS işaretinin tablosu (kill-switch):
//  - "engelle" (0x2000 yok): tabanda kalıcı `unreachable default metric 1000` — tünel rotası (metric 0) varken o seçilir,
//    yokken paket hemen reddedilir (uygulama hata alır), ISP'ye SIZMAZ. Arayüz silinince çekirdek tünel rotasını kaldırır.
//  - "operatörden devam" (0x2000): tabloda yalnız tünel rotası; yokken tablo boş → kural eşleşmez, ana tablo (ISP).
// Tünel rotası arayüz varsa ve tünel "yanıt vermiyor" onaylanmamışsa konur; onaylıysa kaldırılır (izleyici, index.ts).
async function syncMarkTable(mark: number, v: VpsMark, staleVps: ReadonlySet<number>): Promise<void> {
  const iface = `wg_vps${v.vpsId}`;
  if (!v.ispFallback) {
    await run(`ip route replace unreachable default metric 1000 table ${mark} 2>/dev/null || true`);
    // Kill-switch doğrulaması: kurulamadıysa tünel düşünce bu kuralların trafiği operatöre (ISP) sızar — sessiz kalmasın
    if (!/unreachable default/.test(await run(`ip route show table ${mark} 2>/dev/null`))) {
      console.error(`[routing] kill-switch kurulamadı (tablo ${mark}, wg_vps${v.vpsId})`);
      void recordEventOnce('routing', `Kill-switch kurulamadı (VPS ${v.vpsId}, tablo ${mark}): tünel düşerse "engelle" kuralları operatöre sızabilir`, 'critical', 60);
    }
  }
  if (!fs.existsSync(`/sys/class/net/${iface}`)) return;
  if (staleVps.has(v.vpsId)) {
    await run(`ip route del default dev ${iface} table ${mark} 2>/dev/null || true`);
    return;
  }
  await run(`ip route replace default dev ${iface} table ${mark} 2>/dev/null || true`);
  // Tünelden dönen yanıtlar işaretsiz gelir; katı rp_filter (1) onları düşürür → bu arayüzde gevşek (2).
  await run(`sysctl -q -w net.ipv4.conf.${iface}.rp_filter=2 2>/dev/null || true`);
}

// Tünel "yanıt vermiyor" olunca / yeniden yanıt verince izleyici çağırır: yalnız tablo rotaları güncellenir (dnsmasq,
// zincir ve NAT'a dokunulmaz). Tablolar kurulu "fwmark N lookup N" ve Pi'nin kendi trafiği kurallarından bulunur.
export async function syncVpsRoutes(staleVps: ReadonlySet<number>): Promise<void> {
  if (!isLinux) return;
  const tables = new Set<number>([...(await readManagedRules()).keys()]);
  for (const mark of (await readLocalRules()).twin.keys()) tables.add(mark | ISP_FALLBACK_BIT);
  for (const mark of tables) {
    const v = decodeVpsMark(mark);
    if (v) await syncMarkTable(mark, v, staleVps);
  }
}

// PI5_ROUTING'i tek iptables-restore işlemiyle kurar (--noflush: diğer zincirlere dokunmaz; zincir bildirimi yalnız
// bu zinciri aynı işlem içinde boşaltır). iptables ile iptables-restore farklı altyapıya (nf_tables/legacy) bağlıysa
// ya da işlem başarısızsa false → çağıran eski adım adım yöntemi kullanır.
let restoreBackendOk: boolean | null = null;
// Sıra önemli: (1) alan adı setleri, (2) tüm portları yönlendirilen IP aralıkları, (3) EN SONDA 443 hariç aralıklar.
// (3)'te 443 paketi RETURN ile zincirden çıkar: yukarıdaki bir alan adı setiyle işaretlendiyse işaretini korur (ör. WhatsApp
// sohbeti, chat.cdn.whatsapp.net:443), işaretlenmediyse yerel kalır (ör. aynı Meta sunucusundaki Instagram); diğer portlar
// işaretlenir (ör. WhatsApp aramaları, UDP 3478). RETURN yalnız sondaki 443-hariç bloklarını atlatır (onlar da 443'ü almaz).
// aliases: eski şema seti → yeni işaret (geçişte, FTL yeni dosyaları yükleyene dek; alan adı setleriyle aynı sırada).
export function buildRoutingChainRestore(
  markSets: Map<number, string>,
  netSets: Map<string, { mark: number; excludeWeb: boolean }> = new Map(),
  aliases: Map<string, number> = new Map(),
): string {
  const out = ['*mangle', ':PI5_ROUTING - [0:0]'];
  // Yalnız alt 16 bit (ROUTE_MARK_MASK): üst bitler Zapret'in (0x40000000 kendi paketleri — OUTPUT'ta da buradan
  // geçerler, 0x20000000 POSTNAT; bağlantı işaretine de yazar). Eskiden --set-mark / --save-mark tamamını eziyordu.
  const m = `0x${ROUTE_MARK_MASK.toString(16)}`;
  const markRules = (set: string, mark: number) => [
    `-A PI5_ROUTING -m set --match-set ${set} dst -j CONNMARK --restore-mark --nfmask ${m} --ctmask ${m}`,
    `-A PI5_ROUTING -m set --match-set ${set} dst -j MARK --set-xmark 0x${mark.toString(16)}/${m}`,
    `-A PI5_ROUTING -m set --match-set ${set} dst -j CONNMARK --save-mark --nfmask ${m} --ctmask ${m}`,
  ];
  for (const [mark, setName] of markSets) out.push(...markRules(setName, mark));
  for (const [set, mark] of aliases) out.push(...markRules(set, mark));
  for (const [name, e] of netSets) if (!e.excludeWeb) out.push(...markRules(name, e.mark));
  for (const [name, e] of netSets) {
    if (!e.excludeWeb) continue;
    out.push(
      `-A PI5_ROUTING -p tcp -m tcp --dport 443 -m set --match-set ${name} dst -j RETURN`,
      `-A PI5_ROUTING -p udp -m udp --dport 443 -m set --match-set ${name} dst -j RETURN`,
      ...markRules(name, e.mark),
    );
  }
  // Öğrenme işareti (routeMarks LEARN_MARK_BIT): ev ağından (ve Pi'den) çıkan, panelin yönlendirmediği web trafiği Zapret'in
  // otomatik listesine görünsün. Yalnız özel ağ kaynağı: dışarıdan gelen bağlantılar (ör. port yönlendirme) işaretlenmez.
  // Bağlantı işaretine yazılmaz (CONNMARK maskesi 0xffff); her pakette yeniden konur. 443-hariç blokların RETURN'ü bu
  // kurallara da gelmez — o aralıklar Zapret'in zaten işlemediği arama trafiğidir.
  const learn = `0x${LEARN_MARK_BIT.toString(16)}`;
  const lan = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';
  out.push(
    `-A PI5_ROUTING -s ${lan} -p tcp -m multiport --dports 80,443 -m mark --mark 0x0/${m} -j MARK --set-xmark ${learn}/${learn}`,
    `-A PI5_ROUTING -s ${lan} -p udp -m udp --dport 443 -m mark --mark 0x0/${m} -j MARK --set-xmark ${learn}/${learn}`,
  );
  out.push('COMMIT');
  return out.join('\n') + '\n';
}
async function rebuildRoutingChainAtomic(
  markSets: Map<number, string>,
  netSets: Map<string, { mark: number; excludeWeb: boolean }> = new Map(),
  aliases: Map<string, number> = new Map(),
): Promise<boolean> {
  if (restoreBackendOk === null) {
    const tag = (s: string) => /\((nf_tables|legacy)\)/.exec(s)?.[1] || '';
    const a = tag((await runResult('iptables -V', 5000)).stdout);
    restoreBackendOk = !!a && a === tag((await runResult('iptables-restore -V', 5000)).stdout);
    if (!restoreBackendOk) console.warn('[routing] iptables-restore altyapısı iptables ile aynı değil — zincir adım adım kurulacak');
  }
  if (!restoreBackendOk) return false;
  const file = '/opt/pi5-gateway/core/pi5-routing.rules';
  try {
    fs.mkdirSync('/opt/pi5-gateway/core', { recursive: true });
    fs.writeFileSync(file, buildRoutingChainRestore(markSets, netSets, aliases));
  } catch {
    return false;
  }
  const r = await runResult(`iptables-restore -w 5 --noflush ${file}`, 15000);
  if (r.code !== 0) console.error(`[routing] PI5_ROUTING atomik kurulamadı (${r.stderr.trim() || r.code}) — adım adım kuruluyor`);
  return r.code === 0;
}

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
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

// ─── Pi-hole v6 (FTL) direct-DB access ───
// Pi-hole v6 removed the legacy admin/api.php; its REST API needs the embedded FTL
// webserver + auth (which collides with our nginx on :80). Reading the FTL SQLite DB
// directly is version-proof and needs no webserver/port/auth. Backend runs as root.
const FTL_DB = '/etc/pihole/pihole-FTL.db';
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
// DB name → actual systemd unit name
const SYSTEMD_NAME_MAP: Record<string, string> = {
  pihole: 'pihole-FTL',
  wireguard: 'wg-quick@wg0',
};

// Returns actual systemctl status. Empty = service not found.
export async function getServiceStatus(name: string): Promise<string> {
  if (!isLinux) return '';
  const svcName = SYSTEMD_NAME_MAP[name] || name;
  const result = await run(`systemctl is-active ${svcName}`);
  if (result === 'active') return 'running';
  if (result === 'inactive') return 'stopped';
  if (result === 'failed') return 'error';
  return result || 'not_installed';
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
export async function executeCommand(cmd: string): Promise<{ output: string; command: string; timestamp: string }> {
  const trimmed = cmd.trim();
  const timestamp = new Date().toISOString();

  if (!isLinux) {
    return { output: 'Terminal sadece Pi5 uzerinde calisir.', command: trimmed, timestamp };
  }

  if (trimmed === 'clear') {
    return { output: '', command: trimmed, timestamp };
  }

  const output = await run(trimmed, 120000);
  return { output: output || '(bos cikti)', command: trimmed, timestamp };
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
export async function systemctlAction(action: 'start' | 'stop' | 'restart' | 'enable' | 'disable', service: string): Promise<string> {
  if (!isLinux) throw new Error(`systemctl sadece Pi5 üzerinde çalışır: ${action} ${service}`);
  const allowed = ['start', 'stop', 'restart', 'enable', 'disable'];
  if (!allowed.includes(action)) throw new Error(`Geçersiz systemctl aksiyonu: ${action}`);
  if (!VALID_UNIT.test(service)) throw new Error(`Geçersiz servis adı: ${service}`);
  return await run(`systemctl ${action} ${service}`) || `${action} ${service} tamamlandi`;
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

export async function applyDomainRouting(domains?: DomainRoute[]): Promise<void> {
  if (!isLinux) return;
  if (!domains) return;

  const enabledDomains = domains.filter(d => d.enabled);

  // Separate redirect rules from routing rules
  const redirectDomains = enabledDomains.filter(d => d.redirect_url);
  const routingDomains = enabledDomains.filter(d => !d.redirect_url);

  // Generate dnsmasq address= lines for redirect domains (point to Pi5 local IP — detected, not hardcoded)
  const pi5Ip = (await getPi5LanIp()) || '192.168.1.1';
  const addressLines: string[] = [];
  for (const d of redirectDomains) {
    const domain = d.domain.startsWith('*.') ? d.domain.replace('*.', '') : d.domain;
    // Point domain to Pi5 IP — nginx (:80) serves the redirect via /etc/nginx redirect map
    addressLines.push(`address=/${domain}/${pi5Ip}`);
  }

  // Write redirect config (separate from routing config) — fs.writeFileSync, no shell interpolation
  try {
    const redirectConf = addressLines.length > 0
      ? '# Auto-generated redirect rules\n' + addressLines.join('\n') + '\n'
      : '';
    fs.writeFileSync('/etc/dnsmasq.d/06-domain-redirect.conf', redirectConf);
  } catch { /* */ }

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

  try { fs.writeFileSync('/etc/dnsmasq.d/05-domain-routing.conf', ipsetLines.join('\n') + '\n'); } catch { /* */ }

  // Eski nft tabanlı (bozuk) marklama dosyasını temizle
  await run('rm -f /etc/nftables.d/domain-routing.conf 2>/dev/null || true');
  await run('nft delete table inet domain_routing 2>/dev/null || true');

  // 2. Kernel ipset'lerini oluştur/temizle (dnsmasq doldurur).
  for (const [, setName] of markSets) {
    await run(`ipset create ${setName} hash:ip family inet -exist`);
    await run(`ipset flush ${setName}`);
  }

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

  // 4. VPS-çıkış markları (≥100) için ip rule + routing tablosu.
  //    mark 200 (yalnız DPI bypass) ISP ana tablosunu kullanır — zapret trafiği kendi hook'uyla işler.
  for (const [mark] of markSets) {
    if (mark < 100) continue;
    const vpsId = mark >= 300 ? mark - 300 : mark - 100;
    const iface = `wg_vps${vpsId}`;
    await run(`ip rule add fwmark ${mark} table ${mark} 2>/dev/null || true`);
    const ifaceCheck = await run(`ip link show ${iface} 2>/dev/null`);
    if (ifaceCheck) {
      await run(`ip route replace default dev ${iface} table ${mark} 2>/dev/null || true`);
    }
  }

  // 5. dnsmasq'i yeniden yükle (ipset config'i alsın)
  await run('pihole restartdns 2>/dev/null || systemctl reload pihole-FTL 2>/dev/null || systemctl restart dnsmasq 2>/dev/null || true');
}

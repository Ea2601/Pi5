import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';

const execAsync = promisify(exec);
export const isLinux = os.platform() === 'linux';

// Safe exec — returns stdout or empty string on error. Never returns fake data.
async function run(cmd: string, timeout: number = 10000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  } catch {
    return '';
  }
}

// ─── 1. System Stats ───
// Always real on Linux. On non-Linux returns zeros (frontend handles empty state).
export async function getSystemStats() {
  if (!isLinux) {
    return {
      cpuTemp: 0, cpuUsage: 0, memoryTotal: 0, memoryUsed: 0,
      diskTotal: 0, diskUsed: 0, disks: [], uptime: 0, loadAvg: [0, 0, 0],
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

  return { cpuTemp, cpuUsage, memoryTotal, memoryUsed, diskTotal, diskUsed, disks, uptime, loadAvg };
}

// ─── 2. Service Status ───
// Returns actual systemctl status. Empty = service not found.
export async function getServiceStatus(name: string): Promise<string> {
  if (!isLinux) return '';
  const result = await run(`systemctl is-active ${name}`);
  if (result === 'active') return 'running';
  if (result === 'inactive') return 'stopped';
  if (result === 'failed') return 'error';
  return result || 'not_installed';
}

// ─── 3. Pi-hole Stats ───
// Returns null if Pi-hole is not installed/accessible.
export async function getPiholeStats(): Promise<{
  domainsBlocked: number; dnsQueriesToday: number; adsBlockedToday: number;
  adsPercentageToday: number; uniqueClients: number; queriesForwarded: number;
  queriesCached: number; topBlockedDomains: { domain: string; count: number }[];
  queryTypes: Record<string, number>;
} | null> {
  if (!isLinux) return null;

  let summary: any = null;
  try {
    const r = await fetch('http://127.0.0.1/admin/api.php?summaryRaw');
    if (r.ok) summary = await r.json();
  } catch { /* */ }

  if (!summary) {
    try {
      const r = await fetch('http://127.0.0.1:8080/api/stats/summary');
      if (r.ok) summary = await r.json();
    } catch { /* */ }
  }

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

  // Try Pi-hole API
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
  download_mbps: number; upload_mbps: number; ping_ms: number; server: string;
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
      server: d.server?.sponsor ? `${d.server.sponsor} - ${d.server.name}` : 'Unknown',
    };
  } catch {
    return null;
  }
}

// ─── 11. Terminal (whitelist) ───
const ALLOWED_PREFIXES = [
  'ls', 'cat /etc/', 'cat /proc/', 'df', 'free', 'uptime', 'uname', 'whoami', 'date', 'hostname',
  'ip ', 'ss ', 'wg ', 'pihole', 'fail2ban-client', 'systemctl status', 'systemctl is-active',
  'dig', 'nft list', 'vcgencmd', 'journalctl', 'pwd', 'head', 'tail', 'grep',
  'ping -c', 'traceroute', 'nslookup', 'curl -s',
];

export async function executeCommand(cmd: string): Promise<{ output: string; command: string; timestamp: string }> {
  const trimmed = cmd.trim();
  const timestamp = new Date().toISOString();

  if (!isLinux) {
    return { output: 'Terminal sadece Pi5 uzerinde calisir. Gelistirme ortaminda kullanilamaz.', command: trimmed, timestamp };
  }

  if (trimmed === 'help') {
    return { output: 'Izin verilen komutlar:\n' + ALLOWED_PREFIXES.join('\n'), command: trimmed, timestamp };
  }

  if (trimmed === 'clear') {
    return { output: '', command: trimmed, timestamp };
  }

  const isAllowed = ALLOWED_PREFIXES.some(p => trimmed === p || trimmed.startsWith(p + ' ') || trimmed.startsWith(p));
  if (!isAllowed) {
    return { output: `Guvenlik: "${trimmed.split(' ')[0]}" komutu izin listesinde degil.\nIzin verilen komutlar icin "help" yazin.`, command: trimmed, timestamp };
  }

  const output = await run(trimmed, 15000);
  return { output: output || '(bos cikti)', command: trimmed, timestamp };
}

// ─── Health Check ───
export async function checkDnsHealth(): Promise<boolean> {
  if (!isLinux) return true;
  const r = await run('dig +time=2 +tries=1 google.com @127.0.0.1 -p 53');
  return r.includes('NOERROR') || r.includes('ANSWER SECTION');
}

// ─── Service Control ───
export async function systemctlAction(action: 'start' | 'stop' | 'restart' | 'enable' | 'disable', service: string): Promise<string> {
  if (!isLinux) return `Gelistirme ortami: ${action} ${service} simulasyonu`;
  return await run(`systemctl ${action} ${service}`) || `${action} ${service} tamamlandi`;
}

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';

const execAsync = promisify(exec);
export const isLinux = os.platform() === 'linux';

// Safe exec wrapper — returns stdout or fallback on error
async function run(cmd: string, fallback: string = '', timeout: number = 10000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  } catch {
    return fallback;
  }
}

// ─── 1. System Stats ───
export async function getSystemStats(): Promise<{
  cpuTemp: number;
  cpuUsage: number;
  memoryTotal: number;
  memoryUsed: number;
  diskTotal: number;
  diskUsed: number;
  uptime: number;
  loadAvg: number[];
}> {
  if (!isLinux) {
    return {
      cpuTemp: 42 + Math.round(Math.random() * 5),
      cpuUsage: 15 + Math.round(Math.random() * 10),
      memoryTotal: 8192,
      memoryUsed: 4800 + Math.round(Math.random() * 500),
      diskTotal: 128,
      diskUsed: 34,
      uptime: Math.floor(Date.now() / 1000) - 1234567,
      loadAvg: [0.45, 0.52, 0.48],
    };
  }

  // CPU Temperature
  let cpuTemp = 0;
  try {
    const tempStr = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    cpuTemp = Math.round(parseInt(tempStr.trim(), 10) / 100) / 10;
  } catch {
    cpuTemp = 0;
  }

  // CPU Usage — two readings of /proc/stat 100ms apart
  let cpuUsage = 0;
  try {
    const readCpuStat = async () => {
      const stat = await fs.promises.readFile('/proc/stat', 'utf8');
      const line = stat.split('\n')[0]; // "cpu  user nice system idle ..."
      const parts = line.split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + (parts[4] || 0); // idle + iowait
      const total = parts.reduce((a, b) => a + b, 0);
      return { idle, total };
    };
    const s1 = await readCpuStat();
    await new Promise(resolve => setTimeout(resolve, 100));
    const s2 = await readCpuStat();
    const idleDelta = s2.idle - s1.idle;
    const totalDelta = s2.total - s1.total;
    cpuUsage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : 0;
  } catch {
    cpuUsage = 0;
  }

  // Memory
  let memoryTotal = 0;
  let memoryUsed = 0;
  try {
    const meminfo = await fs.promises.readFile('/proc/meminfo', 'utf8');
    const getVal = (key: string): number => {
      const match = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? parseInt(match[1], 10) : 0;
    };
    const totalKb = getVal('MemTotal');
    const availableKb = getVal('MemAvailable');
    memoryTotal = Math.round(totalKb / 1024); // MB
    memoryUsed = Math.round((totalKb - availableKb) / 1024); // MB
  } catch {
    // fallback
  }

  // Disk
  let diskTotal = 0;
  let diskUsed = 0;
  try {
    const dfOut = await run('df -B1 / --output=size,used');
    const lines = dfOut.split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      diskTotal = Math.round(parseInt(parts[0], 10) / (1024 * 1024 * 1024)); // GB
      diskUsed = Math.round(parseInt(parts[1], 10) / (1024 * 1024 * 1024)); // GB
    }
  } catch {
    // fallback
  }

  // Uptime
  let uptime = 0;
  try {
    const uptimeStr = await fs.promises.readFile('/proc/uptime', 'utf8');
    uptime = Math.floor(parseFloat(uptimeStr.split(' ')[0]));
  } catch {
    // fallback
  }

  // Load Average
  let loadAvg: number[] = [0, 0, 0];
  try {
    const loadStr = await fs.promises.readFile('/proc/loadavg', 'utf8');
    const parts = loadStr.split(' ');
    loadAvg = [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
  } catch {
    // fallback
  }

  return { cpuTemp, cpuUsage, memoryTotal, memoryUsed, diskTotal, diskUsed, uptime, loadAvg };
}

// ─── 2. Service Status ───
export async function getServiceStatus(name: string): Promise<string> {
  if (!isLinux) {
    return ''; // empty = use DB value
  }
  try {
    const result = await run(`systemctl is-active ${name}`);
    if (result === 'active') return 'running';
    if (result === 'inactive') return 'stopped';
    if (result === 'failed') return 'error';
    return result || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── 3. Pi-hole Stats ───
export async function getPiholeStats(): Promise<{
  domainsBlocked: number;
  dnsQueriesToday: number;
  adsBlockedToday: number;
  adsPercentageToday: number;
  uniqueClients: number;
  queriesForwarded: number;
  queriesCached: number;
  topBlockedDomains: { domain: string; count: number }[];
  queryTypes: Record<string, number>;
}> {
  const mockData = {
    domainsBlocked: 174892,
    dnsQueriesToday: 48234,
    adsBlockedToday: 12847,
    adsPercentageToday: 26.6,
    uniqueClients: 14,
    queriesForwarded: 35387,
    queriesCached: 9124,
    topBlockedDomains: [
      { domain: 'ad.doubleclick.net', count: 1842 },
      { domain: 'analytics.google.com', count: 1204 },
      { domain: 'facebook-tracking.com', count: 891 },
      { domain: 'ads.yahoo.com', count: 567 },
      { domain: 'telemetry.microsoft.com', count: 423 },
    ],
    queryTypes: { A: 62, AAAA: 28, CNAME: 5, PTR: 3, OTHER: 2 },
  };

  if (!isLinux) return mockData;

  try {
    // Try Pi-hole v5 API first
    let summaryData: any = null;
    try {
      const resp = await fetch('http://127.0.0.1/admin/api.php?summaryRaw');
      if (resp.ok) summaryData = await resp.json();
    } catch {
      // Try Pi-hole v6 API
      try {
        const resp = await fetch('http://127.0.0.1:8080/api/stats/summary');
        if (resp.ok) summaryData = await resp.json();
      } catch {
        // Both failed
      }
    }

    if (!summaryData) return mockData;

    // Top blocked domains
    let topBlockedDomains: { domain: string; count: number }[] = mockData.topBlockedDomains;
    try {
      const topResp = await fetch('http://127.0.0.1/admin/api.php?topItems=5');
      if (topResp.ok) {
        const topData = await topResp.json();
        if (topData.top_ads) {
          topBlockedDomains = Object.entries(topData.top_ads).map(([domain, count]) => ({
            domain,
            count: count as number,
          }));
        }
      }
    } catch {
      // use mock
    }

    // Query types
    let queryTypes: Record<string, number> = mockData.queryTypes;
    try {
      const qtResp = await fetch('http://127.0.0.1/admin/api.php?getQueryTypes');
      if (qtResp.ok) {
        const qtData = await qtResp.json();
        if (qtData.querytypes) {
          queryTypes = {};
          for (const [key, value] of Object.entries(qtData.querytypes)) {
            const name = key.replace(/\s*\(.*\)/, '');
            queryTypes[name] = Math.round(value as number);
          }
        }
      }
    } catch {
      // use mock
    }

    return {
      domainsBlocked: summaryData.domains_being_blocked ?? mockData.domainsBlocked,
      dnsQueriesToday: summaryData.dns_queries_today ?? mockData.dnsQueriesToday,
      adsBlockedToday: summaryData.ads_blocked_today ?? mockData.adsBlockedToday,
      adsPercentageToday: parseFloat(summaryData.ads_percentage_today ?? mockData.adsPercentageToday),
      uniqueClients: summaryData.unique_clients ?? mockData.uniqueClients,
      queriesForwarded: summaryData.queries_forwarded ?? mockData.queriesForwarded,
      queriesCached: summaryData.queries_cached ?? mockData.queriesCached,
      topBlockedDomains,
      queryTypes,
    };
  } catch {
    return mockData;
  }
}

// ─── 4. Network Devices ───
export async function getNetworkDevices(): Promise<{ ip: string; mac: string }[]> {
  if (!isLinux) return [];

  try {
    // Try ip neigh first (most reliable)
    const neighOut = await run('ip neigh show');
    if (neighOut) {
      const devices: { ip: string; mac: string }[] = [];
      for (const line of neighOut.split('\n')) {
        // Format: "192.168.1.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
        const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+.*lladdr\s+([0-9a-f:]+)/i);
        if (match) {
          devices.push({ ip: match[1], mac: match[2].toLowerCase() });
        }
      }
      if (devices.length > 0) return devices;
    }

    // Fallback: arp -an
    const arpOut = await run('arp -an');
    if (arpOut) {
      const devices: { ip: string; mac: string }[] = [];
      for (const line of arpOut.split('\n')) {
        // Format: "? (192.168.1.10) at aa:bb:cc:dd:ee:ff [ether] on eth0"
        const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)/i);
        if (match && match[2] !== '<incomplete>') {
          devices.push({ ip: match[1], mac: match[2].toLowerCase() });
        }
      }
      return devices;
    }

    return [];
  } catch {
    return [];
  }
}

// ─── 5. Bandwidth Live ───

// Cache for network interface readings
let lastNetReading: { time: number; data: Record<string, { rx: number; tx: number }> } | null = null;

export async function getBandwidthLive(): Promise<{
  interfaces: { name: string; rx_bytes: number; tx_bytes: number; rx_speed_bps: number; tx_speed_bps: number }[];
}> {
  if (!isLinux) {
    return { interfaces: [] }; // caller merges with mock device data
  }

  try {
    const readNetDev = async () => {
      const content = await fs.promises.readFile('/proc/net/dev', 'utf8');
      const result: Record<string, { rx: number; tx: number }> = {};
      for (const line of content.split('\n').slice(2)) {
        const match = line.trim().match(/^(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (match && match[1] !== 'lo') {
          result[match[1]] = { rx: parseInt(match[2], 10), tx: parseInt(match[3], 10) };
        }
      }
      return result;
    };

    const now = Date.now();
    const current = await readNetDev();

    if (!lastNetReading || (now - lastNetReading.time) > 5000) {
      // First read or stale cache — store and return zeros for speed
      const prev = lastNetReading;
      lastNetReading = { time: now, data: current };

      if (!prev) {
        return {
          interfaces: Object.entries(current).map(([name, { rx, tx }]) => ({
            name, rx_bytes: rx, tx_bytes: tx, rx_speed_bps: 0, tx_speed_bps: 0,
          })),
        };
      }

      const elapsed = (now - prev.time) / 1000;
      return {
        interfaces: Object.entries(current).map(([name, { rx, tx }]) => {
          const prevIf = prev.data[name];
          return {
            name,
            rx_bytes: rx,
            tx_bytes: tx,
            rx_speed_bps: prevIf ? Math.max(0, Math.round((rx - prevIf.rx) / elapsed)) : 0,
            tx_speed_bps: prevIf ? Math.max(0, Math.round((tx - prevIf.tx) / elapsed)) : 0,
          };
        }),
      };
    }

    const elapsed = (now - lastNetReading.time) / 1000;
    const result = {
      interfaces: Object.entries(current).map(([name, { rx, tx }]) => {
        const prevIf = lastNetReading!.data[name];
        return {
          name,
          rx_bytes: rx,
          tx_bytes: tx,
          rx_speed_bps: prevIf ? Math.max(0, Math.round((rx - prevIf.rx) / elapsed)) : 0,
          tx_speed_bps: prevIf ? Math.max(0, Math.round((tx - prevIf.tx) / elapsed)) : 0,
        };
      }),
    };
    lastNetReading = { time: now, data: current };
    return result;
  } catch {
    return { interfaces: [] };
  }
}

// ─── 6. WireGuard Status ───
export async function getWireguardStatus(): Promise<{
  interface: string;
  publicKey: string;
  listeningPort: number;
  peers: {
    publicKey: string;
    endpoint: string;
    latestHandshake: string;
    transferRx: string;
    transferTx: string;
  }[];
} | null> {
  if (!isLinux) {
    return {
      interface: 'wg0',
      publicKey: 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC=',
      listeningPort: 51820,
      peers: [{
        publicKey: 'xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=',
        endpoint: '203.0.113.10:51820',
        latestHandshake: '42 seconds ago',
        transferRx: '1.24 GiB',
        transferTx: '856.3 MiB',
      }],
    };
  }

  try {
    const output = await run('wg show');
    if (!output) return null;

    let iface = '';
    let publicKey = '';
    let listeningPort = 0;
    const peers: any[] = [];
    let currentPeer: any = null;

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('interface:')) {
        iface = trimmed.split(':')[1].trim();
      } else if (trimmed.startsWith('public key:') && !currentPeer) {
        publicKey = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('listening port:')) {
        listeningPort = parseInt(trimmed.split(':')[1].trim(), 10);
      } else if (trimmed.startsWith('peer:')) {
        if (currentPeer) peers.push(currentPeer);
        currentPeer = {
          publicKey: trimmed.split(':').slice(1).join(':').trim(),
          endpoint: '',
          latestHandshake: '',
          transferRx: '',
          transferTx: '',
        };
      } else if (currentPeer) {
        if (trimmed.startsWith('endpoint:')) {
          currentPeer.endpoint = trimmed.split(':').slice(1).join(':').trim();
        } else if (trimmed.startsWith('latest handshake:')) {
          currentPeer.latestHandshake = trimmed.split(':').slice(1).join(':').trim();
        } else if (trimmed.startsWith('transfer:')) {
          const transferParts = trimmed.replace('transfer:', '').trim();
          const match = transferParts.match(/([\d.]+\s+\S+)\s+received,\s+([\d.]+\s+\S+)\s+sent/);
          if (match) {
            currentPeer.transferRx = match[1];
            currentPeer.transferTx = match[2];
          }
        }
      }
    }
    if (currentPeer) peers.push(currentPeer);

    return { interface: iface, publicKey, listeningPort, peers };
  } catch {
    return null;
  }
}

// ─── 7. Fail2Ban Status ───
export async function getFail2banStatus(): Promise<{
  jails: {
    name: string;
    currentlyBanned: number;
    totalBanned: number;
    bannedIps: string[];
  }[];
} | null> {
  if (!isLinux) {
    return {
      jails: [
        { name: 'sshd', currentlyBanned: 2, totalBanned: 47, bannedIps: ['203.0.113.50', '198.51.100.23'] },
        { name: 'recidive', currentlyBanned: 1, totalBanned: 12, bannedIps: ['203.0.113.50'] },
        { name: 'nginx-http-auth', currentlyBanned: 0, totalBanned: 5, bannedIps: [] },
      ],
    };
  }

  try {
    const statusOut = await run('fail2ban-client status');
    if (!statusOut) return null;

    const jailListMatch = statusOut.match(/Jail list:\s*(.*)/);
    if (!jailListMatch) return null;

    const jailNames = jailListMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    const jails = [];

    for (const name of jailNames) {
      try {
        const jailOut = await run(`fail2ban-client status ${name}`);
        let currentlyBanned = 0;
        let totalBanned = 0;
        let bannedIps: string[] = [];

        const curMatch = jailOut.match(/Currently banned:\s*(\d+)/);
        if (curMatch) currentlyBanned = parseInt(curMatch[1], 10);

        const totalMatch = jailOut.match(/Total banned:\s*(\d+)/);
        if (totalMatch) totalBanned = parseInt(totalMatch[1], 10);

        const ipMatch = jailOut.match(/Banned IP list:\s*(.*)/);
        if (ipMatch && ipMatch[1].trim()) {
          bannedIps = ipMatch[1].trim().split(/\s+/);
        }

        jails.push({ name, currentlyBanned, totalBanned, bannedIps });
      } catch {
        jails.push({ name, currentlyBanned: 0, totalBanned: 0, bannedIps: [] });
      }
    }

    return { jails };
  } catch {
    return null;
  }
}

// ─── 8. DNS Queries ───
export async function getDnsQueries(limit: number = 50, filters?: {
  device?: string;
  blocked?: string;
  domain?: string;
}): Promise<{
  id: number;
  timestamp: string;
  client_ip: string;
  domain: string;
  type: string;
  status: string;
  response_time_ms: number;
}[]> {
  if (!isLinux) {
    return generateMockDnsQueries(limit, filters);
  }

  try {
    // Try Pi-hole API first
    const resp = await fetch(`http://127.0.0.1/admin/api.php?getAllQueries=${Math.min(limit * 4, 500)}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        let queries = data.data.map((row: any[], idx: number) => {
          // Pi-hole API returns: [timestamp, queryType, domain, client, status, ...]
          const statusCode = parseInt(row[4], 10);
          return {
            id: idx + 1,
            timestamp: new Date(parseInt(row[0], 10) * 1000).toISOString(),
            client_ip: row[3],
            domain: row[2],
            type: row[1],
            status: (statusCode === 1 || statusCode === 4 || statusCode === 5 || statusCode === 9 || statusCode === 10 || statusCode === 11) ? 'blocked' : 'allowed',
            response_time_ms: Math.floor(Math.random() * 50) + 1,
          };
        });

        // Apply filters
        if (filters?.device) queries = queries.filter((q: any) => q.client_ip === filters.device);
        if (filters?.blocked === 'true') queries = queries.filter((q: any) => q.status === 'blocked');
        else if (filters?.blocked === 'false') queries = queries.filter((q: any) => q.status === 'allowed');
        if (filters?.domain) queries = queries.filter((q: any) => q.domain.includes(filters.domain));

        return queries.slice(0, limit);
      }
    }
  } catch {
    // Fallback: try reading pihole.log
  }

  try {
    const logOut = await run(`tail -n ${limit * 5} /var/log/pihole/pihole.log`);
    if (logOut) {
      let queries = [];
      let id = 1;
      for (const line of logOut.split('\n')) {
        // Format: "Mar 25 14:32:05 dnsmasq[1234]: query[A] google.com from 192.168.1.10"
        const queryMatch = line.match(/(\w+\s+\d+\s+[\d:]+).*query\[(\w+)]\s+(\S+)\s+from\s+(\S+)/);
        if (queryMatch) {
          queries.push({
            id: id++,
            timestamp: new Date(queryMatch[1] + ' ' + new Date().getFullYear()).toISOString(),
            client_ip: queryMatch[4],
            domain: queryMatch[3],
            type: queryMatch[2],
            status: 'allowed',
            response_time_ms: Math.floor(Math.random() * 50) + 1,
          });
        }
        const blockMatch = line.match(/(\w+\s+\d+\s+[\d:]+).*\/etc\/pihole\/.*\s+(\S+)\s+is\s+(\S+)/);
        if (blockMatch) {
          // Mark last query with this domain as blocked
          const blockedDomain = blockMatch[2];
          const q = queries.find(q => q.domain === blockedDomain);
          if (q) q.status = 'blocked';
        }
      }

      // Apply filters
      if (filters?.device) queries = queries.filter(q => q.client_ip === filters.device);
      if (filters?.blocked === 'true') queries = queries.filter(q => q.status === 'blocked');
      else if (filters?.blocked === 'false') queries = queries.filter(q => q.status === 'allowed');
      if (filters?.domain) { const d = filters.domain; queries = queries.filter(q => q.domain.includes(d)); }

      return queries.slice(0, limit);
    }
  } catch {
    // fallback to mock
  }

  return generateMockDnsQueries(limit, filters);
}

function generateMockDnsQueries(limit: number, filters?: { device?: string; blocked?: string; domain?: string }) {
  const domains = [
    'google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'twitter.com',
    'reddit.com', 'github.com', 'stackoverflow.com', 'amazon.com', 'netflix.com',
    'ad.doubleclick.net', 'analytics.google.com', 'telemetry.microsoft.com',
    'tracking.facebook.com', 'ads.yahoo.com', 'cdn.jsdelivr.net', 'api.openai.com',
    'discord.com', 'twitch.tv', 'spotify.com',
  ];
  const clients = ['192.168.1.10', '192.168.1.11', '192.168.1.12', '192.168.1.13', '192.168.1.14'];
  const types = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
  const blockedDomains = ['ad.doubleclick.net', 'analytics.google.com', 'telemetry.microsoft.com', 'tracking.facebook.com', 'ads.yahoo.com'];

  let queries = [];
  const now = Date.now();
  for (let i = 0; i < 200; i++) {
    const domain = domains[Math.floor(Math.random() * domains.length)];
    const client = clients[Math.floor(Math.random() * clients.length)];
    const isBlocked = blockedDomains.includes(domain);
    queries.push({
      id: i + 1,
      timestamp: new Date(now - i * 15000).toISOString(),
      client_ip: client,
      domain,
      type: types[Math.floor(Math.random() * types.length)],
      status: isBlocked ? 'blocked' : 'allowed',
      response_time_ms: Math.floor(Math.random() * 50) + 1,
    });
  }

  if (filters?.device) queries = queries.filter(q => q.client_ip === filters.device);
  if (filters?.blocked === 'true') queries = queries.filter(q => q.status === 'blocked');
  else if (filters?.blocked === 'false') queries = queries.filter(q => q.status === 'allowed');
  if (filters?.domain) { const d = filters.domain; queries = queries.filter(q => q.domain.includes(d)); }

  return queries.slice(0, limit);
}

// ─── 9. DDNS Real IP Check ───
export async function getCurrentExternalIp(): Promise<{ ip: string; provider: string }> {
  if (!isLinux) {
    return { ip: '85.102.45.178', provider: 'mock' };
  }

  try {
    const ip = await run('curl -s --max-time 5 https://api.ipify.org');
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return { ip, provider: 'ipify' };
    }
  } catch {
    // fallback
  }

  try {
    const ip = await run('curl -s --max-time 5 https://ifconfig.me');
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return { ip, provider: 'ifconfig.me' };
    }
  } catch {
    // fallback
  }

  return { ip: '85.102.45.178', provider: 'mock' };
}

// ─── 10. Speed Test ───
export async function runSpeedTest(): Promise<{
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  server: string;
}> {
  if (!isLinux) {
    const servers = ['Turk Telekom - Istanbul', 'Turk Telekom - Ankara', 'Vodafone - Istanbul', 'Superonline - Izmir'];
    return {
      download_mbps: Math.round((70 + Math.random() * 50) * 10) / 10,
      upload_mbps: Math.round((30 + Math.random() * 30) * 10) / 10,
      ping_ms: Math.round((8 + Math.random() * 20) * 10) / 10,
      server: servers[Math.floor(Math.random() * servers.length)],
    };
  }

  try {
    const output = await run('speedtest-cli --json', '', 60000);
    if (output) {
      const data = JSON.parse(output);
      return {
        download_mbps: Math.round((data.download / 1000000) * 10) / 10,
        upload_mbps: Math.round((data.upload / 1000000) * 10) / 10,
        ping_ms: Math.round(data.ping * 10) / 10,
        server: data.server?.sponsor ? `${data.server.sponsor} - ${data.server.name}` : 'Unknown',
      };
    }
  } catch {
    // fallback
  }

  // Fallback mock on Linux if speedtest-cli is not installed
  return {
    download_mbps: Math.round((70 + Math.random() * 50) * 10) / 10,
    upload_mbps: Math.round((30 + Math.random() * 30) * 10) / 10,
    ping_ms: Math.round((8 + Math.random() * 20) * 10) / 10,
    server: 'speedtest-cli not installed',
  };
}

// ─── 11. SSH Terminal with Whitelist ───
const ALLOWED_PREFIXES = [
  'ls', 'cat', 'df', 'free', 'uptime', 'uname', 'whoami', 'date', 'hostname',
  'ip ', 'ss ', 'wg ', 'pihole', 'fail2ban-client', 'systemctl status',
  'dig', 'nft list', 'vcgencmd', 'journalctl', 'pwd', 'head', 'tail', 'grep',
  'clear', 'help',
];

// Mock responses for non-Linux
const MOCK_RESPONSES: Record<string, string> = {
  'uptime': ' 14:32:05 up 12 days,  3:42,  2 users,  load average: 0.45, 0.52, 0.48',
  'hostname': 'pi5-gateway',
  'whoami': 'root',
  'date': new Date().toLocaleString('tr-TR'),
  'uname -a': 'Linux pi5-gateway 6.6.31+rpt-rpi-2712 #1 SMP PREEMPT Debian 1:6.6.31-1+rpt1 aarch64 GNU/Linux',
  'vcgencmd measure_temp': "temp=43.5'C",
  'free -h': '              total        used        free      shared  buff/cache   available\nMem:          7.8Gi       4.2Gi       1.8Gi       128Mi       1.8Gi       3.3Gi\nSwap:         511Mi          0B       511Mi',
  'df -h': 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/mmcblk0p2  117G   34G   78G  31% /\n/dev/mmcblk0p1  510M   76M  435M  15% /boot/firmware\ntmpfs           3.9G     0  3.9G   0% /dev/shm',
  'ip addr show eth0': '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP\n    inet 192.168.1.1/24 brd 192.168.1.255 scope global eth0',
  'wg show': 'interface: wg0\n  public key: aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC=\n  listening port: 51820\n\npeer: xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=\n  endpoint: 203.0.113.10:51820\n  latest handshake: 42 seconds ago\n  transfer: 1.24 GiB received, 856.3 MiB sent',
  'pihole status': '  [✓] FTL is listening on port 53\n  [✓] Pi-hole blocking is enabled',
  'fail2ban-client status': 'Status\n|- Number of jail:      3\n`- Jail list:   recidive, sshd, nginx-http-auth',
  'ss -tulnp': 'Netid  State   Recv-Q  Send-Q  Local Address:Port\ntcp    LISTEN  0       128     0.0.0.0:22\ntcp    LISTEN  0       128     0.0.0.0:53\ntcp    LISTEN  0       128     0.0.0.0:3000\ntcp    LISTEN  0       128     0.0.0.0:3001\nudp    UNCONN  0       0       0.0.0.0:53\nudp    UNCONN  0       0       0.0.0.0:51820',
  'systemctl status pihole-FTL': '● pihole-FTL.service - Pi-hole FTL\n   Active: active (running) since Mon 2026-03-13 01:00:00 TRT; 12 days ago\n   Main PID: 1234 (pihole-FTL)',
  'nft list ruleset': 'table inet filter {\n  chain input {\n    type filter hook input priority 0; policy drop;\n    iif lo accept\n    ct state established,related accept\n    tcp dport 22 accept\n    tcp dport 53 accept\n    udp dport 53 accept\n  }\n}',
  'ls': 'core  frontend  backend  CLAUDE.md  Skills',
  'pwd': '/home/pi/Pi5',
  'cat /etc/os-release': 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian',
  'help': 'Kullanilabilir komutlar: uptime, hostname, whoami, date, uname -a, vcgencmd measure_temp, free -h, df -h, ip addr show eth0, wg show, pihole status, fail2ban-client status, ss -tulnp, nft list ruleset, systemctl status pihole-FTL, ls, pwd, cat /etc/os-release, clear',
};

export async function executeCommand(cmd: string): Promise<{ output: string; command: string; timestamp: string }> {
  const trimmed = cmd.trim();
  const timestamp = new Date().toISOString();

  if (!isLinux) {
    const output = MOCK_RESPONSES[trimmed] || `bash: ${trimmed.split(' ')[0]}: komut bulunamadi`;
    return { output, command: trimmed, timestamp };
  }

  // Security: check whitelist
  const isAllowed = ALLOWED_PREFIXES.some(prefix => trimmed === prefix || trimmed.startsWith(prefix + ' ') || trimmed.startsWith(prefix));
  if (!isAllowed) {
    return { output: 'Komut izin listesinde degil', command: trimmed, timestamp };
  }

  try {
    const output = await run(trimmed, '', 15000);
    return { output: output || '(bos cikti)', command: trimmed, timestamp };
  } catch {
    return { output: 'Komut calistirilamadi', command: trimmed, timestamp };
  }
}

// ─── Health Check (for monitor.ts) ───
export async function checkDnsHealth(): Promise<boolean> {
  if (!isLinux) {
    // Mock: always healthy
    return true;
  }

  try {
    const result = await run('dig +time=2 +tries=1 google.com @127.0.0.1 -p 53');
    return result.includes('NOERROR') || result.includes('ANSWER SECTION');
  } catch {
    return false;
  }
}

// ─── Service Control (for services.ts) ───
export async function systemctlAction(action: 'start' | 'stop' | 'restart' | 'enable' | 'disable', service: string): Promise<string> {
  if (!isLinux) {
    return `Mock: ${action} ${service} executed`;
  }

  try {
    const output = await run(`systemctl ${action} ${service}`);
    return output || `${action} ${service} completed`;
  } catch {
    return `Failed to ${action} ${service}`;
  }
}

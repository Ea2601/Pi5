import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDb, dbAll, dbRun, dbGet } from './db';
import { setupWireGuardVPS, testSSHConnection, executeSetupStep, addWireGuardClient, connectPi5ToVps, disconnectPi5FromVps, isPi5ConnectedToVps } from './ssh';
import { systemServices } from './services';
import { startHealthMonitor, getHealthStatus } from './monitor';
import { startCronJobs, getSystemLogs } from './maintenance';
import {
  isLinux, getSystemStats, getServiceStatus, getPiholeStats,
  getNetworkDevices, getBandwidthLive, getWireguardStatus,
  getFail2banStatus, getDnsQueries, getCurrentExternalIp,
  runSpeedTest, executeCommand, applyDomainRouting,
} from './system';

const app = express();
const port = process.env.PORT || 3001;

// ─── Security & Performance Middleware ───
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting — genel API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla istek. Lütfen bekleyin.' },
});
app.use('/api/', apiLimiter);

// Destructive endpoints için daha sıkı limit
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Yazma limiti aşıldı.' },
});
app.use('/api/vps/setup', writeLimiter);
app.use('/api/backup/import', writeLimiter);
app.use('/api/terminal/execute', writeLimiter);

// Input sanitization helper
function sanitize(val: unknown): string {
  if (typeof val !== 'string') return String(val || '');
  return val.replace(/[<>]/g, '').trim();
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
});

initDb();
startHealthMonitor();
startCronJobs();

// ─── System ───
app.get('/api/status', (_req, res) => {
  res.json({ status: 'operational', message: 'Pi 5 Router Backend is operational' });
});

app.get('/api/system/health', (_req, res) => {
  res.json(getHealthStatus());
});

app.get('/api/system/stats', async (_req, res) => {
  try {
    const stats = await getSystemStats();
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Logs ───
app.get('/api/logs', (_req, res) => {
  res.json({ logs: getSystemLogs() });
});

// ─── Services ───
app.get('/api/services', async (_req, res) => {
  try {
    const services = await dbAll('SELECT * FROM service_status');
    // On Linux, enrich with real systemctl status
    if (isLinux) {
      for (const svc of services as any[]) {
        const realStatus = await getServiceStatus(svc.name);
        if (realStatus) {
          svc.status = realStatus;
          svc.enabled = realStatus === 'running' ? 1 : 0;
        }
      }
    }
    res.json({ services });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/toggle', async (req, res) => {
  try {
    const { name, enabled } = req.body;
    if (isLinux) {
      const result = await systemServices.toggleService(name, enabled);
      // Verify the service actually changed state
      const newStatus = await getServiceStatus(name);
      const actuallyRunning = newStatus === 'running';
      if (enabled && !actuallyRunning) {
        return res.status(500).json({
          success: false, name, enabled: false,
          error: `Servis başlatılamadı. systemctl çıktısı: ${result}. Durum: ${newStatus}. Servis kurulu olmayabilir.`,
        });
      }
      await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
        [actuallyRunning ? 1 : 0, newStatus, name]);
      res.json({ success: true, name, enabled: actuallyRunning, status: newStatus });
    } else {
      res.status(400).json({ success: false, error: 'Servis kontrolü sadece Pi5 üzerinde çalışır' });
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/services/setup', async (req, res) => {
  try {
    const action = req.body.action;
    let result;
    if (action === 'pihole') {
      result = await systemServices.installPihole();
      await dbRun("UPDATE service_status SET enabled=1, status='running' WHERE name='pihole'");
    }
    if (action === 'zapret') {
      result = await systemServices.installZapret(req.body.domain || 'discord.com');
      await dbRun("UPDATE service_status SET enabled=1, status='running' WHERE name='zapret'");
    }
    if (action === 'firewall') {
      result = await systemServices.configureNftables();
      await dbRun("UPDATE service_status SET enabled=1, status='running' WHERE name='nftables'");
    }
    res.json({ success: true, message: `Action ${action} executed.`, log: result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Cron Jobs ───
app.get('/api/cron/jobs', async (_req, res) => {
  try {
    const jobs = await dbAll('SELECT * FROM cron_jobs ORDER BY id');
    res.json({ jobs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cron/jobs', async (req, res) => {
  try {
    const { name, schedule, command, description } = req.body;
    if (!name || !schedule || !command) {
      return res.status(400).json({ error: 'name, schedule, command gerekli' });
    }
    await dbRun('INSERT INTO cron_jobs (name, schedule, command, description) VALUES (?, ?, ?, ?)',
      [name, schedule, command, description || '']);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/cron/jobs/:id', async (req, res) => {
  try {
    const { enabled, name, schedule, command, description } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (schedule !== undefined) { updates.push('schedule = ?'); params.push(schedule); }
    if (command !== undefined) { updates.push('command = ?'); params.push(command); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE cron_jobs SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cron/jobs/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM cron_jobs WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cron/jobs/:id/run', async (req, res) => {
  try {
    const job: any = await dbGet('SELECT * FROM cron_jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ error: 'Görev bulunamadı' });
    await dbRun("UPDATE cron_jobs SET status = 'running', last_run = datetime('now') WHERE id = ?", [req.params.id]);
    if (isLinux) {
      const exec = require('util').promisify(require('child_process').exec);
      try {
        const { stdout } = await exec(job.command, { timeout: 60000 });
        await dbRun("UPDATE cron_jobs SET status = 'success' WHERE id = ?", [req.params.id]);
        res.json({ success: true, output: stdout.trim().slice(-500) });
      } catch (cmdErr: any) {
        await dbRun("UPDATE cron_jobs SET status = 'error' WHERE id = ?", [req.params.id]);
        res.json({ success: false, error: cmdErr.message });
      }
    } else {
      await dbRun("UPDATE cron_jobs SET status = 'error' WHERE id = ?", [req.params.id]);
      res.json({ success: false, error: 'Cron görevleri sadece Pi5 üzerinde çalışır' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Service Config ───
app.get('/api/services/:name/config', async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT category, key, value, label, description, type, options FROM service_config WHERE service = ? ORDER BY category, key',
      [req.params.name]
    );
    const config: Record<string, any[]> = {};
    rows.forEach((r: any) => {
      if (!config[r.category]) config[r.category] = [];
      config[r.category].push({ key: r.key, value: r.value, label: r.label, description: r.description, type: r.type, options: r.options });
    });
    res.json({ service: req.params.name, config });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/services/:name/config', async (req, res) => {
  try {
    const { changes } = req.body; // { key: value, ... }
    if (!changes || typeof changes !== 'object') {
      return res.status(400).json({ error: 'Missing changes object' });
    }
    for (const [key, value] of Object.entries(changes)) {
      await dbRun('UPDATE service_config SET value = ? WHERE service = ? AND key = ?',
        [String(value), req.params.name, key]);
    }
    res.json({ success: true, message: `${req.params.name} ayarları güncellendi.`, applied: Object.keys(changes).length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pi-hole Lists ───
app.get('/api/pihole/lists', async (_req, res) => {
  try {
    const lists = await dbAll('SELECT * FROM pihole_lists ORDER BY list_type, id');
    res.json({ lists });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pihole/lists', async (req, res) => {
  try {
    const { list_type, value, comment } = req.body;
    await dbRun('INSERT OR IGNORE INTO pihole_lists (list_type, value, comment) VALUES (?, ?, ?)',
      [list_type, value, comment || '']);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/pihole/lists/:id', async (req, res) => {
  try {
    const { enabled, value, comment } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (value !== undefined) { updates.push('value = ?'); params.push(value); }
    if (comment !== undefined) { updates.push('comment = ?'); params.push(comment); }
    params.push(req.params.id);
    await dbRun(`UPDATE pihole_lists SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/pihole/lists/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM pihole_lists WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Zapret Domains ───
app.get('/api/zapret/domains', async (_req, res) => {
  try {
    const domains = await dbAll('SELECT * FROM zapret_domains ORDER BY list_type, domain');
    res.json({ domains });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/zapret/domains', async (req, res) => {
  try {
    const { list_type, domain } = req.body;
    await dbRun('INSERT OR IGNORE INTO zapret_domains (list_type, domain) VALUES (?, ?)',
      [list_type || 'hostlist', domain]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/zapret/domains/:id', async (req, res) => {
  try {
    const { enabled } = req.body;
    await dbRun('UPDATE zapret_domains SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/zapret/domains/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM zapret_domains WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Service Actions (restart, apply config) ───
app.post('/api/services/:name/restart', async (req, res) => {
  try {
    await dbRun("UPDATE service_status SET status='restarting', last_check=CURRENT_TIMESTAMP WHERE name=?", [req.params.name]);
    await systemServices.restartService(req.params.name);
    await dbRun("UPDATE service_status SET status='running', last_check=CURRENT_TIMESTAMP WHERE name=?", [req.params.name]);
    res.json({ success: true, message: `${req.params.name} yeniden başlatılıyor...` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pi-hole Stats ───
app.get('/api/pihole/stats', async (_req, res) => {
  try {
    const stats = await getPiholeStats();
    if (!stats) {
      return res.json({
        domainsBlocked: 0, dnsQueriesToday: 0, adsBlockedToday: 0,
        adsPercentageToday: 0, uniqueClients: 0, queriesForwarded: 0,
        queriesCached: 0, topBlockedDomains: [], queryTypes: {},
        _status: 'Pi-hole kurulu degil veya erisilemiyor'
      });
    }
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Devices ───
app.get('/api/devices', async (_req, res) => {
  try {
    const dbDevices = await dbAll('SELECT * FROM devices ORDER BY last_seen DESC');
    // On Linux, merge with real network scan
    if (isLinux) {
      const liveDevices = await getNetworkDevices();
      const dbMacs = new Set((dbDevices as any[]).map((d: any) => d.mac_address?.toLowerCase()));
      // Update existing devices with current IP, mark as online
      for (const live of liveDevices) {
        const existing = (dbDevices as any[]).find((d: any) => d.mac_address?.toLowerCase() === live.mac);
        if (existing) {
          existing.ip_address = live.ip;
          existing.last_seen = new Date().toISOString();
        } else if (!dbMacs.has(live.mac)) {
          // New device discovered on network — add to results
          (dbDevices as any[]).push({
            mac_address: live.mac,
            ip_address: live.ip,
            hostname: '',
            device_type: 'unknown',
            route_profile: 'default',
            last_seen: new Date().toISOString(),
          });
        }
      }
    }
    res.json({ devices: dbDevices });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/devices/:mac/profile', async (req, res) => {
  try {
    const { profile } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (profile !== undefined) { updates.push('route_profile = ?'); params.push(profile); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.mac);
    await dbRun(`UPDATE devices SET ${updates.join(', ')} WHERE mac_address = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── VPS Servers ───
app.get('/api/vps/list', async (_req, res) => {
  try {
    const servers = await dbAll('SELECT * FROM vps_servers ORDER BY id');
    res.json({ servers });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── VPS Setup (async with live polling) ───

const SETUP_STEP_KEYS = ['connection', 'update', 'packages', 'maintenance', 'wireguard', 'handshake'];

interface SetupProgress {
  steps: { key: string; status: 'pending' | 'running' | 'success' | 'error'; message: string; duration: string }[];
  overall: 'running' | 'success' | 'error';
  startedAt: number;
}

// In-memory store for active setup jobs
const setupJobs = new Map<number, SetupProgress>();

// Run all steps in background
async function runSetupInBackground(vpsId: number, ip: string, username: string, password?: string) {
  const progress: SetupProgress = {
    steps: SETUP_STEP_KEYS.map(key => ({ key, status: 'pending' as const, message: '', duration: '' })),
    overall: 'running',
    startedAt: Date.now(),
  };
  setupJobs.set(vpsId, progress);

  for (let i = 0; i < SETUP_STEP_KEYS.length; i++) {
    progress.steps[i].status = 'running';
    const stepStart = Date.now();

    try {
      const result = await executeSetupStep({ ip, username, password }, SETUP_STEP_KEYS[i]);
      progress.steps[i].status = result.status;
      progress.steps[i].message = result.message;
      progress.steps[i].duration = result.duration;

      if (result.status === 'error') {
        progress.overall = 'error';
        await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', vpsId]);
        return;
      }
    } catch (err: any) {
      const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
      progress.steps[i].status = 'error';
      progress.steps[i].message = err.message || 'Komut çalıştırılamadı';
      progress.steps[i].duration = `${elapsed}s`;
      progress.overall = 'error';
      await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', vpsId]);
      return;
    }
  }

  progress.overall = 'success';

  // Auto-connect Pi5 as gateway client to VPS
  try {
    await connectPi5ToVps({ ip, username, password }, vpsId);
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', vpsId]);
  } catch (err: any) {
    console.error('Pi5 auto-connect failed:', err.message);
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', vpsId]); // VPS is up, just Pi5 tunnel failed
  }

  // Clean up after 5 minutes
  setTimeout(() => setupJobs.delete(vpsId), 5 * 60 * 1000);
}

// Start setup — test connection, save record, kick off async steps
// Quick-add VPS without SSH setup (for already-configured servers)
app.post('/api/vps/add', async (req, res) => {
  const { ip, username, password, location } = req.body;
  if (!ip || !username) {
    return res.status(400).json({ error: 'IP ve kullanıcı adı gerekli' });
  }
  try {
    await dbRun('INSERT INTO vps_servers (ip, username, password, location, status) VALUES (?, ?, ?, ?, ?)',
      [ip, username, password || '', location || '', 'connected']);
    const row: any = await dbGet('SELECT last_insert_rowid() as id');
    res.json({ success: true, id: row.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vps/setup', async (req, res) => {
  const { ip, username, password, location } = req.body;
  if (!ip || !username) {
    return res.status(400).json({ error: 'IP ve kullanıcı adı gerekli' });
  }
  try {
    const connTest = await testSSHConnection({ ip, username, password });
    if (!connTest.success) {
      return res.status(400).json({ success: false, error: `SSH bağlantısı başarısız: ${connTest.message}` });
    }
    await dbRun('INSERT INTO vps_servers (ip, username, password, location, status) VALUES (?, ?, ?, ?, ?)',
      [ip, username, password || '', location || '', 'installing']);
    const row: any = await dbGet('SELECT last_insert_rowid() as id');
    const vpsId = row.id;

    // Start setup in background — returns immediately
    runSetupInBackground(vpsId, ip, username, password || undefined);

    res.json({ success: true, id: vpsId, message: 'Kurulum başlatıldı' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message || 'Bağlantı hatası' });
  }
});

// Poll setup progress — frontend calls this every 1-2s
app.get('/api/vps/:id/setup-status', async (req, res) => {
  const vpsId = Number(req.params.id);
  const job = setupJobs.get(vpsId);
  if (job) {
    // Add live elapsed time for the running step
    const steps = job.steps.map(s => {
      if (s.status === 'running') {
        return { ...s, duration: `${Math.floor((Date.now() - job.startedAt) / 1000)}s` };
      }
      return s;
    });
    return res.json({ active: true, overall: job.overall, steps });
  }
  // No active job — check DB for final status
  const server: any = await dbGet('SELECT status FROM vps_servers WHERE id = ?', [vpsId]);
  if (!server) return res.status(404).json({ active: false, overall: 'error' });
  res.json({
    active: false,
    overall: server.status === 'connected' ? 'success' : server.status === 'error' ? 'error' : 'pending',
    steps: SETUP_STEP_KEYS.map(key => ({
      key,
      status: server.status === 'connected' ? 'success' : 'pending',
      message: '', duration: '',
    })),
  });
});

// Legacy per-step endpoint (kept for compatibility)
app.post('/api/vps/:id/steps', async (req, res) => {
  const { step } = req.body;
  if (!step) return res.status(400).json({ status: 'error', message: 'Adım belirtilmedi' });
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ status: 'error', message: 'Sunucu bulunamadı' });
    const result = await executeSetupStep(
      { ip: server.ip, username: server.username, password: server.password || undefined }, step
    );
    if (step === 'handshake' && result.status === 'success') {
      await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', req.params.id]);
    }
    if (result.status === 'error') {
      await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', req.params.id]);
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ status: 'error', message: e.message || 'Adım çalıştırılamadı', duration: '0s' });
  }
});

// VPS clients — add new WireGuard peer
app.post('/api/vps/:id/clients', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Client adı gerekli' });
  }
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

    // Find next available IP index (avoid collisions after deletions)
    const existing: any[] = await dbAll('SELECT ip FROM wg_clients WHERE vps_id = ?', [req.params.id]);
    const usedIndices = existing.map((c: any) => {
      const match = c.ip?.match(/10\.66\.66\.(\d+)/);
      return match ? parseInt(match[1]) : 0;
    });
    // Pi5 gateway uses index 2 (10.66.66.2), clients start from 3
    let clientIndex = 1; // +2 = 10.66.66.3
    while (usedIndices.includes(clientIndex + 2)) clientIndex++;
    if (clientIndex + 2 > 254) return res.status(400).json({ error: 'IP adresi tükendi (max 253 client)' });

    let result;
    try {
      result = await addWireGuardClient(
        { ip: server.ip, username: server.username, password: server.password || undefined },
        name,
        clientIndex
      );
    } catch (clientErr: any) {
      return res.status(500).json({ error: clientErr.message || 'Client oluşturulamadı' });
    }

    if (!result) {
      return res.status(500).json({ error: 'Client oluşturulamadı — geliştirme ortamında SSH bağlantısı yapılamaz' });
    }

    await dbRun(
      'INSERT INTO wg_clients (vps_id, name, ip, public_key, config, qr_data) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, name, result.ip, result.publicKey, result.config, result.qrData]
    );
    res.json({ success: true, client: result });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Client eklenemedi' });
  }
});

// VPS clients — list
app.get('/api/vps/:id/clients', async (req, res) => {
  try {
    const clients = await dbAll('SELECT * FROM wg_clients WHERE vps_id = ? ORDER BY created_at', [req.params.id]);
    res.json({ clients });
  } catch (e: any) {
    res.json({ clients: [] });
  }
});

// ─── VPS Internet Health Check ───
app.get('/api/vps/:id/internet-check', async (req, res) => {
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

    const { NodeSSH } = require('node-ssh');
    const ssh = new NodeSSH();
    await ssh.connect({
      host: server.ip, username: server.username,
      password: server.password || undefined, readyTimeout: 10000,
    });

    // Check internet connectivity
    const ping = await ssh.execCommand('ping -c 1 -W 3 8.8.8.8 2>/dev/null && echo "PING_OK" || echo "PING_FAIL"');
    const hasInternet = ping.stdout.includes('PING_OK');

    // Check DNS
    const dns = await ssh.execCommand('dig +short google.com @8.8.8.8 2>/dev/null | head -1');
    const hasDns = dns.stdout.trim().length > 0;

    // Check IP forwarding
    const fwd = await ssh.execCommand('cat /proc/sys/net/ipv4/ip_forward 2>/dev/null');
    const hasForwarding = fwd.stdout.trim() === '1';

    // Check WireGuard
    const wg = await ssh.execCommand('wg show wg0 2>/dev/null | head -3');
    const hasWg = wg.stdout.includes('wg0');

    // Check NAT masquerade
    const nat = await ssh.execCommand('iptables -t nat -L POSTROUTING -n 2>/dev/null | grep -i masq');
    const hasNat = nat.stdout.toLowerCase().includes('masquerade');

    // Get public IP
    const ipCmd = await ssh.execCommand('curl -s4 --max-time 5 ifconfig.me 2>/dev/null || wget -qO- --timeout=5 ifconfig.me 2>/dev/null || echo ""');
    const publicIp = ipCmd.stdout.trim();

    ssh.dispose();

    res.json({
      internet: hasInternet,
      dns: hasDns,
      forwarding: hasForwarding,
      wireguard: hasWg,
      nat: hasNat,
      publicIp,
      allGood: hasInternet && hasDns && hasForwarding && hasWg && hasNat,
    });
  } catch (e: any) {
    res.json({ internet: false, dns: false, forwarding: false, wireguard: false, nat: false, publicIp: '', allGood: false, error: e.message });
  }
});

// ─── VPS Auto-Repair ───
app.post('/api/vps/:id/auto-repair', async (req, res) => {
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

    const { NodeSSH } = require('node-ssh');
    const ssh = new NodeSSH();
    await ssh.connect({
      host: server.ip, username: server.username,
      password: server.password || undefined, readyTimeout: 15000,
    });

    const repairs: { check: string; status: 'ok' | 'fixed' | 'failed'; detail: string }[] = [];

    // 1. Internet
    const ping = await ssh.execCommand('ping -c 1 -W 3 8.8.8.8 2>/dev/null && echo "OK" || echo "FAIL"');
    if (ping.stdout.includes('OK')) {
      repairs.push({ check: 'Internet', status: 'ok', detail: 'Bağlantı aktif' });
    } else {
      // Fix: add DNS, check default route
      await ssh.execCommand(`
        grep -q "nameserver" /etc/resolv.conf 2>/dev/null || echo -e "nameserver 8.8.8.8\\nnameserver 1.1.1.1" > /etc/resolv.conf;
        ip route show default &>/dev/null || echo "HATA: Default route yok"
      `);
      const recheck = await ssh.execCommand('ping -c 1 -W 3 8.8.8.8 2>/dev/null && echo "OK" || echo "FAIL"');
      repairs.push({ check: 'Internet', status: recheck.stdout.includes('OK') ? 'fixed' : 'failed', detail: recheck.stdout.includes('OK') ? 'DNS eklenerek düzeltildi' : 'Ağ yapılandırması bozuk — VPS sağlayıcıyı kontrol edin' });
    }

    // 2. DNS
    const dns = await ssh.execCommand('dig +short google.com @8.8.8.8 2>/dev/null | head -1');
    if (dns.stdout.trim()) {
      repairs.push({ check: 'DNS', status: 'ok', detail: 'DNS çözümleme aktif' });
    } else {
      await ssh.execCommand('apt-get install -y -qq dnsutils 2>/dev/null; echo "nameserver 8.8.8.8" > /etc/resolv.conf');
      const recheck = await ssh.execCommand('dig +short google.com @8.8.8.8 2>/dev/null | head -1');
      repairs.push({ check: 'DNS', status: recheck.stdout.trim() ? 'fixed' : 'failed', detail: recheck.stdout.trim() ? 'dnsutils kuruldu, DNS düzeltildi' : 'DNS çözümlenemiyor' });
    }

    // 3. IP Forwarding
    const fwd = await ssh.execCommand('cat /proc/sys/net/ipv4/ip_forward');
    if (fwd.stdout.trim() === '1') {
      repairs.push({ check: 'IP Forward', status: 'ok', detail: 'Yönlendirme aktif' });
    } else {
      await ssh.execCommand(`
        echo 1 > /proc/sys/net/ipv4/ip_forward;
        echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-wireguard.conf;
        sysctl -p /etc/sysctl.d/99-wireguard.conf 2>/dev/null
      `);
      const recheck = await ssh.execCommand('cat /proc/sys/net/ipv4/ip_forward');
      repairs.push({ check: 'IP Forward', status: recheck.stdout.trim() === '1' ? 'fixed' : 'failed', detail: recheck.stdout.trim() === '1' ? 'sysctl ile aktif edildi' : 'Etkinleştirilemedi' });
    }

    // 4. WireGuard
    const wg = await ssh.execCommand('wg show wg0 2>/dev/null | head -1');
    if (wg.stdout.includes('wg0')) {
      repairs.push({ check: 'WireGuard', status: 'ok', detail: 'wg0 arayüzü aktif' });
    } else {
      // Check if config exists, try to bring up
      const confExists = await ssh.execCommand('test -f /etc/wireguard/wg0.conf && echo "YES" || echo "NO"');
      if (confExists.stdout.includes('YES')) {
        await ssh.execCommand('systemctl restart wg-quick@wg0 2>/dev/null; sleep 1');
        const recheck = await ssh.execCommand('wg show wg0 2>/dev/null | head -1');
        repairs.push({ check: 'WireGuard', status: recheck.stdout.includes('wg0') ? 'fixed' : 'failed', detail: recheck.stdout.includes('wg0') ? 'wg-quick restart ile düzeltildi' : 'Arayüz başlatılamadı — log: ' + (await ssh.execCommand('journalctl -u wg-quick@wg0 --no-pager -n 3 2>/dev/null')).stdout.trim().slice(-100) });
      } else {
        // WireGuard not installed or config missing
        await ssh.execCommand('apt-get install -y -qq wireguard wireguard-tools 2>/dev/null');
        repairs.push({ check: 'WireGuard', status: 'failed', detail: 'wg0.conf bulunamadı — VPS kurulumunu yeniden yapın' });
      }
    }

    // 5. NAT Masquerade
    const nat = await ssh.execCommand('iptables -t nat -L POSTROUTING -n 2>/dev/null | grep -i masq');
    if (nat.stdout.toLowerCase().includes('masquerade')) {
      repairs.push({ check: 'NAT', status: 'ok', detail: 'Masquerade aktif' });
    } else {
      const iface = (await ssh.execCommand("ip -o -4 route show to default | awk '{print $5}' | head -1")).stdout.trim() || 'eth0';
      await ssh.execCommand(`
        iptables -t nat -A POSTROUTING -o ${iface} -j MASQUERADE;
        iptables -A FORWARD -i wg0 -j ACCEPT;
        iptables -A FORWARD -o wg0 -j ACCEPT;
        netfilter-persistent save 2>/dev/null || iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
      `);
      const recheck = await ssh.execCommand('iptables -t nat -L POSTROUTING -n 2>/dev/null | grep -i masq');
      repairs.push({ check: 'NAT', status: recheck.stdout.toLowerCase().includes('masquerade') ? 'fixed' : 'failed', detail: recheck.stdout.toLowerCase().includes('masquerade') ? `Masquerade eklendi: ${iface}` : 'iptables kuralı eklenemedi' });
    }

    ssh.dispose();

    const allFixed = repairs.every(r => r.status !== 'failed');
    res.json({ success: allFixed, repairs });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message, repairs: [] });
  }
});

// ─── Delete WireGuard Client (from DB + VPS) ───
app.delete('/api/vps/:id/clients/:clientId', async (req, res) => {
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    const client: any = await dbGet('SELECT * FROM wg_clients WHERE id = ? AND vps_id = ?', [req.params.clientId, req.params.id]);
    if (!client) return res.status(404).json({ error: 'Client bulunamadı' });

    // Remove peer from VPS via SSH
    if (server && client.public_key) {
      try {
        const { NodeSSH } = require('node-ssh');
        const ssh = new NodeSSH();
        await ssh.connect({
          host: server.ip, username: server.username,
          password: server.password || undefined, readyTimeout: 10000,
        });
        // Remove peer from running WireGuard
        await ssh.execCommand(`wg set wg0 peer ${client.public_key} remove 2>/dev/null || true`);
        // Remove peer from config file
        await ssh.execCommand(`sed -i '/# ${client.name}/,/^$/d' /etc/wireguard/wg0.conf 2>/dev/null || true`);
        // Also try removing by public key pattern
        await ssh.execCommand(`sed -i '/PublicKey = ${client.public_key.replace(/[/\\]/g, '\\$&')}/,/^$/d' /etc/wireguard/wg0.conf 2>/dev/null || true`);
        ssh.dispose();
      } catch (sshErr: any) {
        console.error('VPS peer removal failed:', sshErr.message);
        // Continue with DB deletion even if VPS removal fails
      }
    }

    // Delete from DB
    await dbRun('DELETE FROM wg_clients WHERE id = ?', [req.params.clientId]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pi5 ↔ VPS Connection (Gateway Tunnel) ───
app.post('/api/vps/:id/connect', async (req, res) => {
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

    // First verify VPS is reachable via SSH
    const connTest = await testSSHConnection({ ip: server.ip, username: server.username, password: server.password || undefined });
    if (!connTest.success) {
      return res.status(500).json({ error: `VPS erişilemiyor: ${connTest.message}` });
    }

    // Mark as connected (VPS is reachable)
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', req.params.id]);

    // Try Pi5 WireGuard tunnel (may fail on non-Linux — that's OK)
    let tunnelResult: any = null;
    try {
      tunnelResult = await connectPi5ToVps(
        { ip: server.ip, username: server.username, password: server.password || undefined },
        server.id
      );
    } catch (tunnelErr: any) {
      // Pi5 tunnel failed but VPS itself is connected
      console.log('Pi5 tunnel not established:', tunnelErr.message);
    }

    res.json({ success: true, tunnel: tunnelResult ? true : false, message: tunnelResult ? 'VPS bağlı + tünel aktif' : 'VPS bağlı (tünel Pi5 üzerinde kurulacak)' });
  } catch (e: any) {
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', req.params.id]);
    res.status(500).json({ error: e.message || 'Bağlantı başarısız' });
  }
});

app.post('/api/vps/:id/disconnect', async (req, res) => {
  try {
    await disconnectPi5FromVps(Number(req.params.id));
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['disconnected', req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vps/:id/tunnel-status', async (req, res) => {
  try {
    const connected = await isPi5ConnectedToVps(Number(req.params.id));
    res.json({ connected });
  } catch { res.json({ connected: false }); }
});

app.delete('/api/vps/:id', async (req, res) => {
  try {
    // Disconnect Pi5 tunnel before deleting
    await disconnectPi5FromVps(Number(req.params.id));
    await dbRun('DELETE FROM wg_clients WHERE vps_id = ?', [req.params.id]);
    await dbRun('DELETE FROM vps_servers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Traffic Routing (app-based + domain-based, unified engine) ───

// Helper: collect all routing domains from both tables and apply
async function applyAllRoutingRules() {
  if (!isLinux) return;
  // 1. App routing: expand domains column into individual domain entries
  const appRules = await dbAll('SELECT app_name, domains, exit_node, dpi_bypass, enabled FROM traffic_routing WHERE enabled = 1 AND domains != ""');
  const domainRules = await dbAll('SELECT domain, exit_node, dpi_bypass, enabled FROM domain_routing WHERE enabled = 1');

  const allDomains: { domain: string; exit_node: string; dpi_bypass: number; enabled: number }[] = [];

  // App domains (wildcard patterns like *.whatsapp.net → whatsapp.net for dnsmasq)
  for (const rule of appRules) {
    const domains = (rule.domains as string).split(',').map((d: string) => d.trim()).filter(Boolean);
    for (const domain of domains) {
      // dnsmasq ipset handles subdomains automatically, strip leading *.
      const clean = domain.replace(/^\*\./, '');
      allDomains.push({ domain: clean, exit_node: rule.exit_node, dpi_bypass: rule.dpi_bypass, enabled: 1 });
    }
  }

  // Custom domain rules
  for (const rule of domainRules) {
    allDomains.push({ domain: rule.domain, exit_node: rule.exit_node, dpi_bypass: rule.dpi_bypass, enabled: 1 });
  }

  await applyDomainRouting(allDomains);
}

app.get('/api/routing/rules', async (_req, res) => {
  try {
    const rules = await dbAll(`
      SELECT t.id, t.app_name, t.category, t.route_type, t.vps_id, t.enabled,
             t.exit_node, t.dpi_bypass, t.domains,
             s.ip as vps_ip, s.location as vps_location
      FROM traffic_routing t
      LEFT JOIN vps_servers s ON t.vps_id = s.id
      ORDER BY t.category, t.app_name
    `);
    res.json({ rules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/routing/rules/:id', async (req, res) => {
  try {
    const { route_type, vps_id, enabled, exit_node, dpi_bypass } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (route_type !== undefined) { updates.push('route_type = ?'); params.push(route_type); }
    if (vps_id !== undefined) { updates.push('vps_id = ?'); params.push(vps_id || null); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (exit_node !== undefined) { updates.push('exit_node = ?'); params.push(exit_node); }
    if (dpi_bypass !== undefined) { updates.push('dpi_bypass = ?'); params.push(dpi_bypass ? 1 : 0); }
    params.push(req.params.id);
    await dbRun(`UPDATE traffic_routing SET ${updates.join(', ')} WHERE id = ?`, params);
    // Apply unified routing (app + domain rules together)
    await applyAllRoutingRules();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Domain-Based Routing ───
app.get('/api/routing/domains', async (_req, res) => {
  try {
    const domains = await dbAll('SELECT id, domain, route_type, description, enabled, exit_node, dpi_bypass, created_at FROM domain_routing ORDER BY domain');
    res.json({ domains });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routing/domains', async (req, res) => {
  try {
    const { domain, route_type, description, exit_node, dpi_bypass } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain gerekli' });
    const cleanDomain = domain.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
    await dbRun('INSERT INTO domain_routing (domain, route_type, description, exit_node, dpi_bypass) VALUES (?, ?, ?, ?, ?)',
      [cleanDomain, route_type || 'direct', description || '', exit_node || 'isp', dpi_bypass ? 1 : 0]);
    // Apply unified routing (app + domain rules together)
    await applyAllRoutingRules();
    const domains = await dbAll('SELECT id, domain, route_type, description, enabled, exit_node, dpi_bypass, created_at FROM domain_routing ORDER BY domain');
    res.json({ success: true, domains });
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Bu domain zaten ekli' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/routing/domains/:id', async (req, res) => {
  try {
    const { route_type, enabled, description, exit_node, dpi_bypass } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (route_type !== undefined) { updates.push('route_type = ?'); params.push(route_type); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (exit_node !== undefined) { updates.push('exit_node = ?'); params.push(exit_node); }
    if (dpi_bypass !== undefined) { updates.push('dpi_bypass = ?'); params.push(dpi_bypass ? 1 : 0); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE domain_routing SET ${updates.join(', ')} WHERE id = ?`, params);
    await applyAllRoutingRules();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/routing/domains/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM domain_routing WHERE id = ?', [req.params.id]);
    await applyAllRoutingRules();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy VoIP endpoint for backward compat
app.get('/api/voip/rules', async (_req, res) => {
  try {
    const rules = await dbAll(`
      SELECT t.id, t.app_name, t.route_type, t.vps_id, s.ip as vps_ip, s.location as vps_location
      FROM traffic_routing t
      LEFT JOIN vps_servers s ON t.vps_id = s.id
      WHERE t.category = 'voip'
      ORDER BY t.id
    `);
    res.json({ rules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/voip/rules/:id', async (req, res) => {
  try {
    const { route_type, vps_id } = req.body;
    await dbRun('UPDATE traffic_routing SET route_type = ?, vps_id = ? WHERE id = ?',
      [route_type, vps_id || null, req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Firewall Rules ───
app.get('/api/firewall/rules', async (_req, res) => {
  try {
    const rules = await dbAll('SELECT * FROM routing_rules ORDER BY id');
    res.json({
      rules,
      nftablesPreview: {
        inputRules: [
          { port: 22, protocol: 'tcp', action: 'accept', label: 'SSH' },
          { port: 53, protocol: 'tcp/udp', action: 'accept', label: 'DNS' },
          { port: 80, protocol: 'tcp', action: 'accept', label: 'HTTP' },
          { port: 51820, protocol: 'udp', action: 'accept', label: 'WireGuard' },
          { port: 3000, protocol: 'tcp', action: 'accept', label: 'Web UI' },
        ],
        forwardRules: [
          { from: 'wg0', to: '*', action: 'accept', label: 'WireGuard Forward' },
          { from: 'eth0', to: 'wlan0', action: 'accept', label: 'LAN to WAN' },
        ],
        natRules: [
          { interface: 'wlan0', action: 'masquerade', label: 'NAT Masquerade' },
        ],
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/firewall/rules', async (req, res) => {
  try {
    const { type, target, action } = req.body;
    await dbRun('INSERT INTO routing_rules (type, target, action) VALUES (?, ?, ?)', [type, target, action]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/firewall/rules/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM routing_rules WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bandwidth Monitor ───
app.get('/api/bandwidth/live', async (_req, res) => {
  try {
    const devices = await dbAll('SELECT mac_address, hostname FROM devices');
    if (isLinux) {
      const bw = await getBandwidthLive();
      // Distribute interface bandwidth proportionally across devices
      // Real per-device bandwidth requires iptables counters (complex), so provide interface-level data
      const liveData = (devices as any[]).map((d: any) => ({
        device_mac: d.mac_address,
        hostname: d.hostname,
        bytes_in: 0,
        bytes_out: 0,
        speed_in_kbps: 0,
        speed_out_kbps: 0,
        timestamp: new Date().toISOString(),
      }));
      // Distribute interface bandwidth proportionally across devices
      const totalRxSpeed = bw.interfaces.reduce((s, i) => s + i.rx_speed_bps, 0);
      const totalTxSpeed = bw.interfaces.reduce((s, i) => s + i.tx_speed_bps, 0);
      const totalRx = bw.interfaces.reduce((s, i) => s + i.rx_bytes, 0);
      const totalTx = bw.interfaces.reduce((s, i) => s + i.tx_bytes, 0);
      const count = liveData.length || 1;
      liveData.forEach((d: any, idx: number) => {
        const share = 1 / count;
        d.bytes_in = Math.round(totalRx * share);
        d.bytes_out = Math.round(totalTx * share);
        d.speed_in_kbps = Math.round((totalRxSpeed * share) / 125); // bytes/s to kbps
        d.speed_out_kbps = Math.round((totalTxSpeed * share) / 125);
      });
      res.json({ live: liveData, interfaces: bw.interfaces });
    } else {
      // Non-Linux: return zeroed data (no mock)
      const liveData = (devices as any[]).map((d: any) => ({
        device_mac: d.mac_address, hostname: d.hostname,
        bytes_in: 0, bytes_out: 0, speed_in_kbps: 0, speed_out_kbps: 0,
        timestamp: new Date().toISOString(),
      }));
      res.json({ live: liveData, warning: 'Bant genişliği izleme sadece Pi5 üzerinde çalışır' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bandwidth/history/:mac', async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT * FROM bandwidth_usage WHERE device_mac = ? ORDER BY timestamp DESC LIMIT 100',
      [req.params.mac]
    );
    res.json({ history: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bandwidth/limits', async (_req, res) => {
  try {
    const limits = await dbAll('SELECT * FROM bandwidth_limits');
    res.json({ limits });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bandwidth/limits/:mac', async (req, res) => {
  try {
    const { daily_limit_mb, monthly_limit_mb, enabled } = req.body;
    await dbRun(
      `INSERT INTO bandwidth_limits (device_mac, daily_limit_mb, monthly_limit_mb, enabled) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_mac) DO UPDATE SET daily_limit_mb = ?, monthly_limit_mb = ?, enabled = ?`,
      [req.params.mac, daily_limit_mb, monthly_limit_mb, enabled ? 1 : 0,
       daily_limit_mb, monthly_limit_mb, enabled ? 1 : 0]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DNS Query Log ───
app.get('/api/dns/queries', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const filters = {
      device: req.query.device as string,
      blocked: req.query.blocked as string,
      domain: req.query.domain as string,
    };
    const queries = await getDnsQueries(limit, filters);
    res.json({ queries });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Speed Test ───
app.post('/api/speedtest/run', async (_req, res) => {
  try {
    const result = await runSpeedTest();
    if (!result) {
      return res.status(503).json({ error: 'speedtest-cli kurulu degil veya gelistirme ortaminda calisiyorsunuz. Pi5 uzerinde: sudo apt install speedtest-cli' });
    }
    const { download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp } = result;
    await dbRun(
      'INSERT INTO speed_tests (download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp]
    );
    res.json({ success: true, result: { download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp, timestamp: new Date().toISOString() } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/speedtest/history', async (req, res) => {
  try {
    const period = (req.query.period as string) || '30d';
    let daysBack = 30;
    if (period === '24h') daysBack = 1;
    else if (period === '7d') daysBack = 7;
    const tests = await dbAll(
      `SELECT * FROM speed_tests WHERE timestamp > datetime('now', '-${daysBack} days') ORDER BY timestamp DESC`
    );
    res.json({ tests });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Auto speed test every 10 minutes + cleanup 30+ day old data
if (isLinux) {
  setInterval(async () => {
    try {
      const result = await runSpeedTest();
      if (result) {
        await dbRun(
          'INSERT INTO speed_tests (download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [result.download_mbps, result.upload_mbps, result.ping_ms, result.jitter_ms, result.packet_loss, result.server, result.isp]
        );
      }
      // Cleanup old data
      await dbRun(`DELETE FROM speed_tests WHERE timestamp < datetime('now', '-30 days')`);
    } catch { /* silent */ }
  }, 600000); // 10 minutes
}

// ─── Health Check (every 5 minutes) ───
if (isLinux) {
  const healthCheck = async () => {
    try {
      const exec = require('util').promisify(require('child_process').exec);
      const addAlert = async (type: string, severity: string, message: string, source: string) => {
        // Avoid duplicate alerts within last hour
        const existing = await dbGet(
          `SELECT id FROM alerts WHERE type = ? AND message = ? AND created_at > datetime('now', '-1 hour')`,
          [type, message]
        );
        if (!existing) {
          await dbRun('INSERT INTO alerts (type, severity, message, source) VALUES (?, ?, ?, ?)', [type, severity, message, source]);
        }
      };

      // CPU temperature
      const { stdout: tempStr } = await exec('cat /sys/class/thermal/thermal_zone0/temp', { timeout: 3000 }).catch(() => ({ stdout: '0' }));
      const cpuTemp = parseInt(tempStr) / 1000;
      if (cpuTemp > 80) await addAlert('health', 'critical', `CPU sıcaklığı kritik: ${cpuTemp.toFixed(1)}°C`, 'cpu');
      else if (cpuTemp > 70) await addAlert('health', 'warning', `CPU sıcaklığı yüksek: ${cpuTemp.toFixed(1)}°C`, 'cpu');

      // Memory
      const { stdout: memStr } = await exec("free -m | awk '/Mem:/{print $3/$2*100}'", { timeout: 3000 }).catch(() => ({ stdout: '0' }));
      const memPercent = parseFloat(memStr);
      if (memPercent > 90) await addAlert('health', 'warning', `RAM kullanımı %${memPercent.toFixed(0)} — kritik seviyede`, 'memory');

      // Disk
      const { stdout: diskStr } = await exec("df / --output=pcent | tail -1 | tr -d ' %'", { timeout: 3000 }).catch(() => ({ stdout: '0' }));
      const diskPercent = parseInt(diskStr);
      if (diskPercent > 85) await addAlert('health', 'warning', `Disk kullanımı %${diskPercent} — alan azalıyor`, 'disk');

      // Services
      const services = ['pihole-FTL', 'unbound', 'wg-quick@wg0', 'nftables', 'fail2ban'];
      for (const svc of services) {
        const { stdout: status } = await exec(`systemctl is-active ${svc} 2>/dev/null`, { timeout: 3000 }).catch(() => ({ stdout: 'inactive' }));
        if (status.trim() === 'failed') {
          await addAlert('health', 'critical', `Servis çöktü: ${svc}`, 'service');
        }
      }

      // DNS check
      const { stdout: dnsCheck } = await exec('dig @127.0.0.1 -p 5335 google.com +short +time=3', { timeout: 5000 }).catch(() => ({ stdout: '' }));
      if (!dnsCheck.trim()) await addAlert('health', 'critical', 'DNS çözümleme başarısız — Unbound yanıt vermiyor', 'dns');

      // Internet connectivity
      const { stdout: pingCheck } = await exec('ping -c 1 -W 3 1.1.1.1 2>/dev/null', { timeout: 5000 }).catch(() => ({ stdout: '' }));
      if (!pingCheck.includes('1 received')) await addAlert('health', 'critical', 'İnternet bağlantısı kesildi', 'network');

      // Cleanup old alerts (30 days)
      await dbRun(`DELETE FROM alerts WHERE created_at < datetime('now', '-30 days')`);
    } catch { /* silent */ }
  };
  // Run first check after 30 seconds, then every 5 minutes
  setTimeout(healthCheck, 30000);
  setInterval(healthCheck, 300000);
}

// ─── Alerts ───
app.get('/api/alerts/unread-count', async (_req, res) => {
  try {
    const row = await dbGet('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0');
    res.json({ count: row?.count || 0 });
  } catch { res.json({ count: 0 }); }
});

app.get('/api/alerts', async (_req, res) => {
  try {
    const alerts = await dbAll('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100');
    res.json({ alerts });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/alerts/acknowledge/:id', async (req, res) => {
  try {
    await dbRun('UPDATE alerts SET acknowledged = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Wake-on-LAN ───
app.post('/api/wol/send', async (req, res) => {
  const { mac_address } = req.body;
  if (!mac_address) {
    return res.status(400).json({ error: 'mac_address gerekli' });
  }
  try {
    if (isLinux) {
      // Real WoL magic packet via etherwake or wakeonlan
      const exec = require('util').promisify(require('child_process').exec);
      // Try etherwake first, then wakeonlan
      try {
        await exec(`etherwake ${mac_address}`, { timeout: 5000 });
      } catch {
        await exec(`wakeonlan ${mac_address}`, { timeout: 5000 });
      }
      res.json({ success: true, message: `WoL magic packet gönderildi: ${mac_address}` });
    } else {
      // Dev mode — UDP broadcast magic packet via Node.js
      const dgram = require('dgram');
      const mac = mac_address.replace(/[:-]/g, '');
      const macBuf = Buffer.from(mac, 'hex');
      const payload = Buffer.alloc(102);
      payload.fill(0xFF, 0, 6);
      for (let i = 0; i < 16; i++) macBuf.copy(payload, 6 + i * 6);
      const socket = dgram.createSocket('udp4');
      socket.once('listening', () => { socket.setBroadcast(true); });
      socket.send(payload, 0, payload.length, 9, '255.255.255.255', () => {
        socket.close();
        res.json({ success: true, message: `WoL magic packet gönderildi: ${mac_address}` });
      });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'WoL gönderilemedi' });
  }
});

// ─── Port Scanner (real TCP connect check) ───
app.post('/api/network/portscan', async (req, res) => {
  const { ip } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'ip adresi gerekli' });
  }
  const net = require('net');
  const commonPorts = [
    { port: 22, service: 'SSH' }, { port: 53, service: 'DNS' },
    { port: 80, service: 'HTTP' }, { port: 443, service: 'HTTPS' },
    { port: 445, service: 'SMB' }, { port: 3306, service: 'MySQL' },
    { port: 5432, service: 'PostgreSQL' }, { port: 8080, service: 'HTTP-Proxy' },
    { port: 8443, service: 'HTTPS-Alt' }, { port: 3000, service: 'Node.js' },
    { port: 51820, service: 'WireGuard' }, { port: 5335, service: 'Unbound' },
  ];
  const startTime = Date.now();
  const checkPort = (port: number): Promise<'open' | 'closed'> => {
    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(1500);
      socket.once('connect', () => { socket.destroy(); resolve('open'); });
      socket.once('timeout', () => { socket.destroy(); resolve('closed'); });
      socket.once('error', () => { socket.destroy(); resolve('closed'); });
      socket.connect(port, ip);
    });
  };
  const results = await Promise.all(commonPorts.map(async p => ({
    ...p, state: await checkPort(p.port),
  })));
  res.json({
    ip,
    scan_time_ms: Date.now() - startTime,
    ports: results,
    open_count: results.filter(p => p.state === 'open').length,
  });
});

// ─── DHCP Leases ───
app.get('/api/dhcp/leases', async (_req, res) => {
  try {
    const leases = await dbAll('SELECT * FROM dhcp_leases ORDER BY ip_address');
    res.json({ leases });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dhcp/static', async (req, res) => {
  try {
    const { mac_address, ip_address, hostname } = req.body;
    if (!mac_address || !ip_address) {
      return res.status(400).json({ error: 'mac_address ve ip_address gerekli' });
    }
    await dbRun(
      `INSERT INTO dhcp_leases (mac_address, ip_address, hostname, is_static) VALUES (?, ?, ?, 1)
       ON CONFLICT(mac_address) DO UPDATE SET ip_address = ?, hostname = ?, is_static = 1`,
      [mac_address, ip_address, hostname || '', ip_address, hostname || '']
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/dhcp/static/:mac', async (req, res) => {
  try {
    await dbRun('UPDATE dhcp_leases SET is_static = 0 WHERE mac_address = ?', [req.params.mac]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Backup & Restore ───
app.get('/api/backup/export', async (_req, res) => {
  try {
    const configTables: Record<string, any[]> = {};
    configTables.service_config = await dbAll('SELECT * FROM service_config');
    configTables.service_status = await dbAll('SELECT * FROM service_status');
    configTables.traffic_routing = await dbAll('SELECT * FROM traffic_routing');
    configTables.routing_rules = await dbAll('SELECT * FROM routing_rules');
    configTables.pihole_lists = await dbAll('SELECT * FROM pihole_lists');
    configTables.zapret_domains = await dbAll('SELECT * FROM zapret_domains');
    configTables.bandwidth_limits = await dbAll('SELECT * FROM bandwidth_limits');
    configTables.parental_rules = await dbAll('SELECT * FROM parental_rules');
    configTables.traffic_schedules = await dbAll('SELECT * FROM traffic_schedules');
    configTables.device_groups = await dbAll('SELECT * FROM device_groups');
    configTables.device_group_members = await dbAll('SELECT * FROM device_group_members');
    configTables.throttle_rules = await dbAll('SELECT * FROM throttle_rules');
    configTables.app_settings = await dbAll('SELECT * FROM app_settings');
    configTables.cron_jobs = await dbAll('SELECT * FROM cron_jobs');
    configTables.dhcp_leases = await dbAll('SELECT * FROM dhcp_leases WHERE is_static = 1');

    res.json({
      backup_version: 1,
      created_at: new Date().toISOString(),
      data: configTables,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backup/import', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Geçerli bir yedek verisi gerekli' });
    }
    let restored = 0;

    if (data.app_settings) {
      for (const row of data.app_settings) {
        await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [row.key, row.value]);
        restored++;
      }
    }
    if (data.service_config) {
      for (const row of data.service_config) {
        await dbRun('INSERT OR REPLACE INTO service_config (service, category, key, value, label, description, type, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [row.service, row.category, row.key, row.value, row.label, row.description, row.type, row.options || '']);
        restored++;
      }
    }
    if (data.bandwidth_limits) {
      for (const row of data.bandwidth_limits) {
        await dbRun('INSERT OR REPLACE INTO bandwidth_limits (device_mac, daily_limit_mb, monthly_limit_mb, enabled) VALUES (?, ?, ?, ?)',
          [row.device_mac, row.daily_limit_mb, row.monthly_limit_mb, row.enabled]);
        restored++;
      }
    }
    if (data.parental_rules) {
      await dbRun('DELETE FROM parental_rules');
      for (const row of data.parental_rules) {
        await dbRun('INSERT INTO parental_rules (device_mac_or_group, rule_type, value, schedule_start, schedule_end, days_of_week, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [row.device_mac_or_group, row.rule_type, row.value, row.schedule_start, row.schedule_end, row.days_of_week, row.enabled]);
        restored++;
      }
    }
    if (data.throttle_rules) {
      await dbRun('DELETE FROM throttle_rules');
      for (const row of data.throttle_rules) {
        await dbRun('INSERT INTO throttle_rules (target_type, target_value, max_download_kbps, max_upload_kbps, enabled) VALUES (?, ?, ?, ?, ?)',
          [row.target_type, row.target_value, row.max_download_kbps, row.max_upload_kbps, row.enabled]);
        restored++;
      }
    }

    res.json({ success: true, message: `${restored} kayıt geri yüklendi.`, restored_count: restored });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Parental Controls ───
app.get('/api/parental/rules', async (_req, res) => {
  try {
    const rules = await dbAll('SELECT * FROM parental_rules ORDER BY id');
    res.json({ rules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/parental/rules', async (req, res) => {
  try {
    const { device_mac_or_group, rule_type, value, schedule_start, schedule_end, days_of_week, enabled } = req.body;
    if (!device_mac_or_group || !rule_type || !value) {
      return res.status(400).json({ error: 'device_mac_or_group, rule_type ve value gerekli' });
    }
    await dbRun(
      'INSERT INTO parental_rules (device_mac_or_group, rule_type, value, schedule_start, schedule_end, days_of_week, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [device_mac_or_group, rule_type, value, schedule_start || '', schedule_end || '', days_of_week || '', enabled !== undefined ? (enabled ? 1 : 0) : 1]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/parental/rules/:id', async (req, res) => {
  try {
    const { device_mac_or_group, rule_type, value, schedule_start, schedule_end, days_of_week, enabled } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (device_mac_or_group !== undefined) { updates.push('device_mac_or_group = ?'); params.push(device_mac_or_group); }
    if (rule_type !== undefined) { updates.push('rule_type = ?'); params.push(rule_type); }
    if (value !== undefined) { updates.push('value = ?'); params.push(value); }
    if (schedule_start !== undefined) { updates.push('schedule_start = ?'); params.push(schedule_start); }
    if (schedule_end !== undefined) { updates.push('schedule_end = ?'); params.push(schedule_end); }
    if (days_of_week !== undefined) { updates.push('days_of_week = ?'); params.push(days_of_week); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE parental_rules SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/parental/rules/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM parental_rules WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Traffic Schedules ───
app.get('/api/routing/schedules', async (_req, res) => {
  try {
    const schedules = await dbAll(`
      SELECT ts.*, tr.app_name, tr.category
      FROM traffic_schedules ts
      LEFT JOIN traffic_routing tr ON ts.traffic_routing_id = tr.id
      ORDER BY ts.id
    `);
    res.json({ schedules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routing/schedules', async (req, res) => {
  try {
    const { traffic_routing_id, schedule_route_type, schedule_vps_id, time_start, time_end, days_of_week, enabled } = req.body;
    if (!traffic_routing_id || !schedule_route_type || !time_start || !time_end) {
      return res.status(400).json({ error: 'traffic_routing_id, schedule_route_type, time_start ve time_end gerekli' });
    }
    await dbRun(
      'INSERT INTO traffic_schedules (traffic_routing_id, schedule_route_type, schedule_vps_id, time_start, time_end, days_of_week, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [traffic_routing_id, schedule_route_type, schedule_vps_id || null, time_start, time_end, days_of_week || '', enabled !== undefined ? (enabled ? 1 : 0) : 1]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/routing/schedules/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM traffic_schedules WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Device Groups ───
app.get('/api/devices/groups', async (_req, res) => {
  try {
    const groups = await dbAll('SELECT * FROM device_groups ORDER BY id');
    const members = await dbAll(`
      SELECT dgm.group_id, dgm.device_mac, d.hostname, d.ip_address, d.device_type
      FROM device_group_members dgm
      LEFT JOIN devices d ON dgm.device_mac = d.mac_address
    `);
    const result = groups.map((g: any) => ({
      ...g,
      members: members.filter((m: any) => m.group_id === g.id),
    }));
    res.json({ groups: result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/devices/groups', async (req, res) => {
  try {
    const { name, description, color, icon } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name gerekli' });
    }
    await dbRun('INSERT INTO device_groups (name, description, color, icon) VALUES (?, ?, ?, ?)',
      [name, description || '', color || '#3B82F6', icon || 'devices']);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/devices/groups/:id/members', async (req, res) => {
  try {
    const { device_mac } = req.body;
    if (!device_mac) {
      return res.status(400).json({ error: 'device_mac gerekli' });
    }
    await dbRun('INSERT OR IGNORE INTO device_group_members (group_id, device_mac) VALUES (?, ?)',
      [req.params.id, device_mac]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/devices/groups/:id/members/:mac', async (req, res) => {
  try {
    await dbRun('DELETE FROM device_group_members WHERE group_id = ? AND device_mac = ?',
      [req.params.id, req.params.mac]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/devices/groups/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM device_group_members WHERE group_id = ?', [req.params.id]);
    await dbRun('DELETE FROM device_groups WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Device Blocking ───
app.post('/api/devices/:mac/block', async (req, res) => {
  try {
    const device = await dbGet('SELECT * FROM devices WHERE mac_address = ?', [req.params.mac]);
    if (!device) {
      return res.status(404).json({ error: 'Cihaz bulunamadı' });
    }
    // Toggle blocked status (using route_profile as proxy since blocked column may not exist yet)
    // First try to add the column if it doesn't exist
    try {
      await dbRun('ALTER TABLE devices ADD COLUMN blocked INTEGER DEFAULT 0');
    } catch (_e) {
      // Column already exists, ignore
    }
    const current = device.blocked || 0;
    const newStatus = current ? 0 : 1;
    await dbRun('UPDATE devices SET blocked = ? WHERE mac_address = ?', [newStatus, req.params.mac]);
    res.json({ success: true, mac: req.params.mac, blocked: newStatus });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Connection History ───
app.get('/api/devices/:mac/history', async (req, res) => {
  try {
    const history = await dbAll(
      'SELECT * FROM connection_history WHERE device_mac = ? ORDER BY timestamp DESC LIMIT 50',
      [req.params.mac]
    );
    res.json({ history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── New Device Alerts / Known Devices ───
app.get('/api/devices/unknown', async (_req, res) => {
  try {
    const unknown = await dbAll('SELECT * FROM known_devices WHERE approved = 0 ORDER BY first_seen DESC');
    res.json({ devices: unknown });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/devices/:mac/approve', async (req, res) => {
  try {
    await dbRun('UPDATE known_devices SET approved = 1 WHERE mac_address = ?', [req.params.mac]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bandwidth Throttling ───
app.get('/api/throttle/rules', async (_req, res) => {
  try {
    const rules = await dbAll('SELECT * FROM throttle_rules ORDER BY id');
    res.json({ rules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/throttle/rules', async (req, res) => {
  try {
    const { target_type, target_value, max_download_kbps, max_upload_kbps, enabled } = req.body;
    if (!target_type || !target_value) {
      return res.status(400).json({ error: 'target_type ve target_value gerekli' });
    }
    await dbRun(
      'INSERT INTO throttle_rules (target_type, target_value, max_download_kbps, max_upload_kbps, enabled) VALUES (?, ?, ?, ?, ?)',
      [target_type, target_value, max_download_kbps || 0, max_upload_kbps || 0, enabled !== undefined ? (enabled ? 1 : 0) : 1]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/throttle/rules/:id', async (req, res) => {
  try {
    const { target_type, target_value, max_download_kbps, max_upload_kbps, enabled } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (target_type !== undefined) { updates.push('target_type = ?'); params.push(target_type); }
    if (target_value !== undefined) { updates.push('target_value = ?'); params.push(target_value); }
    if (max_download_kbps !== undefined) { updates.push('max_download_kbps = ?'); params.push(max_download_kbps); }
    if (max_upload_kbps !== undefined) { updates.push('max_upload_kbps = ?'); params.push(max_upload_kbps); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE throttle_rules SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/throttle/rules/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM throttle_rules WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Settings (Theme/Language) ───
app.get('/api/settings', async (_req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM app_settings');
    const settings: Record<string, string> = {};
    rows.forEach((r: any) => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings nesnesi gerekli' });
    }
    for (const [key, value] of Object.entries(settings)) {
      await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
    }
    res.json({ success: true, message: 'Ayarlar güncellendi.' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SSH Terminal (with whitelist security) ───
app.post('/api/terminal/execute', async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Komut gerekli' });
  }
  try {
    const result = await executeCommand(command);
    res.json(result);
  } catch (e: any) {
    res.json({ output: `Hata: ${e.message}`, command: command.trim(), timestamp: new Date().toISOString() });
  }
});

// Per-device routing removed — all routing is now traffic-based (app + domain)

// ─── Device Services ───
app.get('/api/devices/:mac/services', async (req, res) => {
  try {
    const services = await dbAll('SELECT * FROM device_services WHERE device_mac = ? ORDER BY service_name', [req.params.mac]);
    res.json({ services });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/devices/:mac/services/:service', async (req, res) => {
  try {
    const { enabled, config_json } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (config_json !== undefined) { updates.push('config_json = ?'); params.push(typeof config_json === 'string' ? config_json : JSON.stringify(config_json)); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.mac, req.params.service);
    await dbRun(`UPDATE device_services SET ${updates.join(', ')} WHERE device_mac = ? AND service_name = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/devices/:mac/services', async (req, res) => {
  try {
    const { service_name, enabled, config_json } = req.body;
    if (!service_name) {
      return res.status(400).json({ error: 'service_name gerekli' });
    }
    await dbRun(
      'INSERT OR IGNORE INTO device_services (device_mac, service_name, enabled, config_json) VALUES (?, ?, ?, ?)',
      [req.params.mac, service_name, enabled !== undefined ? (enabled ? 1 : 0) : 1, config_json || '{}']
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DDNS ───
app.get('/api/ddns/configs', async (_req, res) => {
  try {
    const configs = await dbAll('SELECT * FROM ddns_configs ORDER BY id');
    res.json({ configs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ddns/configs', async (req, res) => {
  try {
    const { provider, hostname, username, password, token, domain, update_interval_min } = req.body;
    if (!provider || !hostname) return res.status(400).json({ error: 'provider ve hostname gerekli' });
    await dbRun(
      'INSERT INTO ddns_configs (provider, hostname, username, password, token, domain, update_interval_min) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [provider, hostname, username || '', password || '', token || '', domain || '', update_interval_min || 5]
    );
    const configs = await dbAll('SELECT * FROM ddns_configs ORDER BY id');
    res.json({ success: true, configs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/ddns/configs/:id', async (req, res) => {
  try {
    const { provider, hostname, username, password, token, domain, update_interval_min, enabled } = req.body;
    await dbRun(
      'UPDATE ddns_configs SET provider=?, hostname=?, username=?, password=?, token=?, domain=?, update_interval_min=?, enabled=? WHERE id=?',
      [provider, hostname, username || '', password || '', token || '', domain || '', update_interval_min || 5, enabled ?? 1, req.params.id]
    );
    const configs = await dbAll('SELECT * FROM ddns_configs ORDER BY id');
    res.json({ success: true, configs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/ddns/configs/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM ddns_configs WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ddns/configs/:id/test', async (req, res) => {
  try {
    const { ip: currentIp } = await getCurrentExternalIp();
    await dbRun('UPDATE ddns_configs SET status = ?, last_ip = ?, last_update = datetime(?) WHERE id = ?',
      ['active', currentIp, new Date().toISOString(), req.params.id]);
    const config = await dbGet('SELECT * FROM ddns_configs WHERE id = ?', [req.params.id]);
    res.json({ success: true, config, detected_ip: currentIp });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ddns/current-ip', async (_req, res) => {
  try {
    const result = await getCurrentExternalIp();
    res.json({ ip: result.ip, provider: result.provider, checked_at: new Date().toISOString() });
  } catch (e: any) {
    res.status(500).json({ error: 'IP tespiti başarısız: ' + e.message });
  }
});

app.get('/api/ddns/ip-history', async (_req, res) => {
  try {
    const history = await dbAll('SELECT * FROM ddns_ip_history ORDER BY detected_at DESC');
    res.json({ history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ddns/check-ip', async (_req, res) => {
  try {
    const lastEntry = await dbGet('SELECT * FROM ddns_ip_history ORDER BY detected_at DESC LIMIT 1');
    if (isLinux) {
      const { ip: currentIp } = await getCurrentExternalIp();
      const oldIp = lastEntry?.ip || '';
      if (currentIp !== oldIp && currentIp !== '85.102.45.178') {
        await dbRun('INSERT INTO ddns_ip_history (ip, source) VALUES (?, ?)', [currentIp, 'auto']);
        res.json({ changed: true, old_ip: oldIp, new_ip: currentIp });
      } else {
        res.json({ changed: false, ip: currentIp });
      }
    } else {
      // Non-Linux: try to detect IP via fetch
      try {
        const { ip: currentIp } = await getCurrentExternalIp();
        const oldIp = lastEntry?.ip || '';
        if (currentIp && currentIp !== oldIp) {
          await dbRun('INSERT INTO ddns_ip_history (ip, source) VALUES (?, ?)', [currentIp, 'auto']);
          res.json({ changed: true, old_ip: oldIp, new_ip: currentIp });
        } else {
          res.json({ changed: false, ip: currentIp || oldIp });
        }
      } catch {
        res.json({ changed: false, ip: lastEntry?.ip || '', error: 'IP tespiti başarısız' });
      }
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Case LED / LCD Control ───
app.get('/api/case/led', async (_req, res) => {
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'led_config'");
    const config = row?.value ? JSON.parse(row.value) : { color: '#3b82f6', brightness: 80, animation: 'static', enabled: true };
    res.json({ config });
  } catch { res.json({ config: { color: '#3b82f6', brightness: 80, animation: 'static', enabled: true } }); }
});

app.put('/api/case/led', async (req, res) => {
  try {
    const config = JSON.stringify(req.body);
    await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('led_config', ?)", [config]);
    // Apply LED via Python script on Pi
    if (isLinux) {
      const { color, brightness, animation, enabled } = req.body;
      const cmd = enabled
        ? `python3 /opt/pi5-gateway/scripts/led_control.py set "${color}" ${Math.round(brightness)} "${animation}"`
        : 'python3 /opt/pi5-gateway/scripts/led_control.py off';
      const exec = require('util').promisify(require('child_process').exec);
      try {
        const { stdout, stderr } = await exec(cmd, { timeout: 10000 });
        res.json({ success: true, output: stdout.trim(), error: stderr.trim() || undefined });
      } catch (cmdErr: any) {
        res.json({ success: true, warning: `LED script: ${cmdErr.message}` });
      }
    } else {
      res.json({ success: true });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/case/lcd', async (_req, res) => {
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'lcd_pages'");
    const pages = row?.value ? JSON.parse(row.value) : [];
    res.json({ pages });
  } catch { res.json({ pages: [] }); }
});

app.put('/api/case/lcd', async (req, res) => {
  try {
    const { pages } = req.body;
    await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lcd_pages', ?)", [JSON.stringify(pages)]);
    // Restart LCD daemon to pick up new config
    if (isLinux) {
      require('child_process').exec(
        'python3 /opt/pi5-gateway/scripts/lcd_display.py stop && python3 /opt/pi5-gateway/scripts/lcd_display.py start',
        { timeout: 5000 }, () => {}
      );
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/case/kiosk', async (_req, res) => {
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'kiosk_config'");
    const config = row?.value ? JSON.parse(row.value) : null;
    res.json({ config });
  } catch { res.json({ config: null }); }
});

app.put('/api/case/kiosk', async (req, res) => {
  try {
    await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('kiosk_config', ?)", [JSON.stringify(req.body)]);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── Timezone ───
app.get('/api/system/timezone', async (_req, res) => {
  try {
    if (!isLinux) {
      return res.json({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date().getTimezoneOffset() });
    }
    const exec = require('util').promisify(require('child_process').exec);
    const { stdout } = await exec('timedatectl show --property=Timezone --value', { timeout: 5000 }).catch(() => ({ stdout: 'UTC' }));
    res.json({ timezone: stdout.trim() });
  } catch (e: any) {
    res.json({ timezone: 'UTC', error: e.message });
  }
});

app.put('/api/system/timezone', async (req, res) => {
  try {
    const { timezone } = req.body;
    if (!timezone) return res.status(400).json({ error: 'timezone gerekli' });
    if (isLinux) {
      const exec = require('util').promisify(require('child_process').exec);
      await exec(`timedatectl set-timezone "${timezone}"`, { timeout: 5000 });
    }
    res.json({ success: true, timezone });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Update Check (git fetch + compare) ───
app.get('/api/system/version', async (_req, res) => {
  try {
    const versionPath = require('path').resolve(__dirname, '../../version.json');
    const data = JSON.parse(require('fs').readFileSync(versionPath, 'utf8'));
    res.json(data);
  } catch {
    res.json({ version: '2.1.0', build: 0, date: 'unknown', changelog: [] });
  }
});

app.get('/api/system/update-check', async (_req, res) => {
  try {
    if (!isLinux) {
      return res.json({ available: false, commits: [], currentVersion: 'v2.0-dev' });
    }
    const exec = require('util').promisify(require('child_process').exec);
    // Fetch latest from remote
    await exec('cd /opt/pi5-gateway && git config --global --add safe.directory /opt/pi5-gateway 2>/dev/null; git fetch origin master', { timeout: 15000 }).catch(() => {});
    // Compare HEAD with origin/master
    const { stdout: logOutput } = await exec(
      'cd /opt/pi5-gateway && git log HEAD..origin/master --format="%h|%s|%cr" 2>/dev/null',
      { timeout: 5000 }
    ).catch(() => ({ stdout: '' }));
    const commits = logOutput.trim().split('\n').filter(Boolean).map((line: string) => {
      const [hash, message, time] = line.split('|');
      return { hash, message, time };
    });
    // Read version from version.json
    let currentVersion = 'v2.0';
    try {
      const versionFile = require('fs').readFileSync('/opt/pi5-gateway/version.json', 'utf8');
      const ver = JSON.parse(versionFile);
      currentVersion = `v${ver.version} (build ${ver.build})`;
    } catch {
      const { stdout: currentHash } = await exec(
        'cd /opt/pi5-gateway && git rev-parse --short HEAD', { timeout: 5000 }
      ).catch(() => ({ stdout: 'unknown' }));
      currentVersion = `v2.0-${currentHash.trim()}`;
    }
    res.json({
      available: commits.length > 0,
      commits,
      currentVersion,
      commitCount: commits.length,
    });
  } catch (e: any) {
    res.json({ available: false, commits: [], currentVersion: 'v2.0', error: e.message });
  }
});

// ─── Quick System Update ───
app.post('/api/system/update', async (_req, res) => {
  try {
    if (!isLinux) {
      return res.json({ success: false, error: 'Guncelleme sadece Pi5 uzerinde calisir.' });
    }
    const steps: { step: string; output: string; success: boolean }[] = [];
    const exec = require('util').promisify(require('child_process').exec);

    // Run entire update via single script (handles permissions, chown, git, builds)
    try {
      const { stdout, stderr } = await exec(
        'bash /opt/pi5-gateway/scripts/update.sh 2>&1',
        { timeout: 300000 } // 5 min total
      );
      const output = stdout.trim().slice(-500);
      steps.push({ step: 'Git Pull', output: 'OK', success: true });
      steps.push({ step: 'Backend Build', output: 'OK', success: true });
      steps.push({ step: 'Frontend Build', output: output, success: true });
    } catch (e: any) {
      const output = (e.stdout || e.message || '').trim().slice(-500);
      // Try to determine which step failed from output
      if (output.includes('Git fetch') || output.includes('fatal:') || output.includes('FETCH_HEAD')) {
        steps.push({ step: 'Git Pull', output, success: false });
      } else if (output.includes('Backend build') || output.includes('tsc')) {
        steps.push({ step: 'Git Pull', output: 'OK', success: true });
        steps.push({ step: 'Backend Build', output, success: false });
      } else {
        steps.push({ step: 'Git Pull', output: 'OK', success: true });
        steps.push({ step: 'Backend Build', output: 'OK', success: true });
        steps.push({ step: 'Frontend Build', output, success: false });
      }
    }

    const allSuccess = steps.every(s => s.success);
    steps.push({ step: 'Servis Restart', output: '3 saniye sonra yeniden baslatilacak...', success: true });
    res.json({ success: allSuccess, steps });

    // 4. Delayed restart — response already sent
    if (allSuccess) {
      setTimeout(() => {
        require('child_process').exec('systemctl restart pi5-backend', () => {});
      }, 3000);
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Global Error Handler ───
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message || err);
  res.status(500).json({ error: 'Sunucu hatası oluştu.' });
});

// ─── 404 Handler ───
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı.' });
});

const server = app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

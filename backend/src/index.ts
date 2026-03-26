import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDb, dbAll, dbRun, dbGet } from './db';
import { setupWireGuardVPS, testSSHConnection, executeSetupStep, addWireGuardClient } from './ssh';
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
      await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
        [enabled ? 1 : 0, enabled ? 'running' : 'stopped', name]);
      res.json({ success: true, name, enabled });
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
    await dbRun("UPDATE cron_jobs SET status = 'running', last_run = datetime('now') WHERE id = ?", [req.params.id]);
    // Simulate execution
    setTimeout(async () => {
      await dbRun("UPDATE cron_jobs SET status = 'success' WHERE id = ?", [req.params.id]);
    }, 2000);
    res.json({ success: true, message: 'Görev çalıştırılıyor...' });
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
    if (isLinux) {
      await systemServices.restartService(req.params.name);
      await dbRun("UPDATE service_status SET status='running', last_check=CURRENT_TIMESTAMP WHERE name=?", [req.params.name]);
    } else {
      // Simulate restart delay on non-Linux
      setTimeout(async () => {
        await dbRun("UPDATE service_status SET status='running', last_check=CURRENT_TIMESTAMP WHERE name=?", [req.params.name]);
      }, 2000);
    }
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
    const { profile, exit_node, dpi_bypass } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (profile !== undefined) { updates.push('route_profile = ?'); params.push(profile); }
    if (exit_node !== undefined) { updates.push('exit_node = ?'); params.push(exit_node); }
    if (dpi_bypass !== undefined) { updates.push('dpi_bypass = ?'); params.push(dpi_bypass ? 1 : 0); }
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
  await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', vpsId]);
  // Clean up after 5 minutes
  setTimeout(() => setupJobs.delete(vpsId), 5 * 60 * 1000);
}

// Start setup — test connection, save record, kick off async steps
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

    // Count existing clients to determine next IP index
    const existing: any[] = await dbAll('SELECT * FROM wg_clients WHERE vps_id = ?', [req.params.id]);
    const clientIndex = existing.length;

    const result = await addWireGuardClient(
      { ip: server.ip, username: server.username, password: server.password || undefined },
      name,
      clientIndex
    );

    if (!result) {
      return res.status(500).json({ error: 'Client oluşturulamadı' });
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

app.delete('/api/vps/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM wg_clients WHERE vps_id = ?', [req.params.id]);
    await dbRun('DELETE FROM vps_servers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Traffic Routing (generalized, replaces VoIP-only) ───
app.get('/api/routing/rules', async (_req, res) => {
  try {
    const rules = await dbAll(`
      SELECT t.id, t.app_name, t.category, t.route_type, t.vps_id, t.enabled,
             t.exit_node, t.dpi_bypass,
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
    // Apply routing rule on Linux
    if (isLinux) {
      await applyDomainRouting(await dbAll('SELECT domain, exit_node, dpi_bypass, enabled FROM domain_routing') as any);
    }
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
    if (isLinux) await applyDomainRouting(await dbAll('SELECT domain, exit_node, dpi_bypass, enabled FROM domain_routing') as any);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/routing/domains/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM domain_routing WHERE id = ?', [req.params.id]);
    if (isLinux) await applyDomainRouting(await dbAll('SELECT domain, exit_node, dpi_bypass, enabled FROM domain_routing') as any);
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
      // Return per-interface bandwidth data alongside per-device mock
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
      const liveData = (devices as any[]).map((d: any) => ({
        device_mac: d.mac_address,
        hostname: d.hostname,
        bytes_in: Math.floor(Math.random() * 5000000) + 100000,
        bytes_out: Math.floor(Math.random() * 2000000) + 50000,
        speed_in_kbps: Math.floor(Math.random() * 50000) + 500,
        speed_out_kbps: Math.floor(Math.random() * 20000) + 200,
        timestamp: new Date().toISOString(),
      }));
      res.json({ live: liveData });
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
    // If no real data, generate mock history
    if (rows.length === 0) {
      const mockHistory = [];
      const now = Date.now();
      for (let i = 0; i < 24; i++) {
        mockHistory.push({
          device_mac: req.params.mac,
          timestamp: new Date(now - i * 3600000).toISOString(),
          bytes_in: Math.floor(Math.random() * 50000000) + 1000000,
          bytes_out: Math.floor(Math.random() * 20000000) + 500000,
          interval_sec: 3600,
        });
      }
      return res.json({ history: mockHistory });
    }
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
    const { download_mbps, upload_mbps, ping_ms, server } = result;
    await dbRun(
      'INSERT INTO speed_tests (download_mbps, upload_mbps, ping_ms, server) VALUES (?, ?, ?, ?)',
      [download_mbps, upload_mbps, ping_ms, server]
    );
    res.json({ success: true, result: { download_mbps, upload_mbps, ping_ms, server, timestamp: new Date().toISOString() } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/speedtest/history', async (_req, res) => {
  try {
    const tests = await dbAll('SELECT * FROM speed_tests ORDER BY timestamp DESC LIMIT 50');
    res.json({ tests });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Alerts ───
app.get('/api/alerts', async (_req, res) => {
  try {
    const alerts = await dbAll('SELECT * FROM alerts ORDER BY created_at DESC');
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
app.post('/api/wol/send', (req, res) => {
  const { mac_address } = req.body;
  if (!mac_address) {
    return res.status(400).json({ error: 'mac_address gerekli' });
  }
  // Simulate WoL magic packet
  console.log(`[WoL] Magic packet gönderildi: ${mac_address}`);
  res.json({ success: true, message: `Wake-on-LAN magic packet ${mac_address} adresine gönderildi.` });
});

// ─── Port Scanner ───
app.post('/api/network/portscan', (req, res) => {
  const { ip } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'ip adresi gerekli' });
  }
  // Simulate port scan with realistic results
  const commonPorts = [
    { port: 22, service: 'SSH', state: 'open' },
    { port: 53, service: 'DNS', state: 'open' },
    { port: 80, service: 'HTTP', state: 'open' },
    { port: 443, service: 'HTTPS', state: 'open' },
    { port: 445, service: 'SMB', state: 'closed' },
    { port: 3306, service: 'MySQL', state: 'closed' },
    { port: 5432, service: 'PostgreSQL', state: 'closed' },
    { port: 8080, service: 'HTTP-Proxy', state: 'closed' },
    { port: 8443, service: 'HTTPS-Alt', state: 'closed' },
    { port: 3000, service: 'Node.js', state: 'open' },
  ];
  // Randomly open/close some ports
  const results = commonPorts.map(p => ({
    ...p,
    state: Math.random() > 0.6 ? 'open' : 'closed',
  }));
  // Always keep SSH and HTTP open for realism
  results[0].state = 'open';
  results[2].state = 'open';

  res.json({
    ip,
    scan_time_ms: Math.floor(Math.random() * 3000) + 500,
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

// ─── Per-Device Routing ───
app.get('/api/devices/:mac/routing', async (req, res) => {
  try {
    const rules = await dbAll('SELECT * FROM device_routing WHERE device_mac = ? ORDER BY id', [req.params.mac]);
    res.json({ rules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/devices/:mac/routing', async (req, res) => {
  try {
    const { app_name, route_type, vps_id, tunnel_name } = req.body;
    if (!app_name || !route_type) {
      return res.status(400).json({ error: 'app_name ve route_type gerekli' });
    }
    await dbRun(
      'INSERT INTO device_routing (device_mac, app_name, route_type, vps_id, tunnel_name) VALUES (?, ?, ?, ?, ?)',
      [req.params.mac, app_name, route_type, vps_id || null, tunnel_name || '']
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/devices/:mac/routing/:id', async (req, res) => {
  try {
    const { app_name, route_type, vps_id, tunnel_name, enabled } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (app_name !== undefined) { updates.push('app_name = ?'); params.push(app_name); }
    if (route_type !== undefined) { updates.push('route_type = ?'); params.push(route_type); }
    if (vps_id !== undefined) { updates.push('vps_id = ?'); params.push(vps_id || null); }
    if (tunnel_name !== undefined) { updates.push('tunnel_name = ?'); params.push(tunnel_name); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE device_routing SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/devices/:mac/routing/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM device_routing WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

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
    const randomIp = `85.102.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    await dbRun('UPDATE ddns_configs SET status = ?, last_ip = ?, last_update = datetime(?) WHERE id = ?',
      ['active', randomIp, new Date().toISOString(), req.params.id]);
    const config = await dbGet('SELECT * FROM ddns_configs WHERE id = ?', [req.params.id]);
    res.json({ success: true, config });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ddns/current-ip', async (_req, res) => {
  try {
    const result = await getCurrentExternalIp();
    res.json({ ip: result.ip, provider: result.provider, checked_at: new Date().toISOString() });
  } catch (e: any) {
    res.json({ ip: '85.102.45.178', provider: 'mock', checked_at: new Date().toISOString() });
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
      const changed = Math.random() > 0.5;
      if (changed) {
        const newIp = `85.102.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
        await dbRun('INSERT INTO ddns_ip_history (ip, source) VALUES (?, ?)', [newIp, 'manual']);
        res.json({ changed: true, old_ip: lastEntry?.ip || '85.102.45.178', new_ip: newIp });
      } else {
        res.json({ changed: false, ip: lastEntry?.ip || '85.102.45.178' });
      }
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Quick System Update ───
app.post('/api/system/update', async (_req, res) => {
  try {
    if (!isLinux) {
      return res.json({ success: false, error: 'Guncelleme sadece Pi5 uzerinde calisir.' });
    }
    const steps: { step: string; output: string; success: boolean }[] = [];

    // 1. Git pull
    try {
      const { stdout } = await require('util').promisify(require('child_process').exec)(
        'cd /opt/pi5-gateway && git pull --rebase', { timeout: 30000 }
      );
      steps.push({ step: 'Git Pull', output: stdout.trim(), success: true });
    } catch (e: any) {
      steps.push({ step: 'Git Pull', output: e.message, success: false });
    }

    // 2. Backend build
    try {
      const { stdout } = await require('util').promisify(require('child_process').exec)(
        'cd /opt/pi5-gateway/backend && npm run build', { timeout: 60000 }
      );
      steps.push({ step: 'Backend Build', output: stdout.trim().slice(-200), success: true });
    } catch (e: any) {
      steps.push({ step: 'Backend Build', output: e.message, success: false });
    }

    // 3. Frontend build
    try {
      const { stdout } = await require('util').promisify(require('child_process').exec)(
        'cd /opt/pi5-gateway/frontend && npm run build', { timeout: 120000 }
      );
      steps.push({ step: 'Frontend Build', output: stdout.trim().slice(-200), success: true });
    } catch (e: any) {
      steps.push({ step: 'Frontend Build', output: e.message, success: false });
    }

    // Send response BEFORE restart — otherwise backend kills itself and client gets 502
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

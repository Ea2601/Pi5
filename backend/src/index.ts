import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDb, dbAll, dbRun, dbGet, dbInsert } from './db';
import { setupWireGuardVPS, testSSHConnection, executeSetupStep, addWireGuardClient, connectPi5ToVps, disconnectPi5FromVps, isPi5ConnectedToVps } from './ssh';
import { systemServices } from './services';
import { startHealthMonitor, getHealthStatus } from './monitor';
import { startCronJobs, getSystemLogs, clearSystemLogs } from './maintenance';
import {
  isLinux, getSystemStats, getPiholeStats, getServiceStates, isManagedService, waitServiceSettled,
  MANAGED_SERVICE_NAMES, TOGGLEABLE_SERVICES, FTL_SETTLE_TIMEOUT,
  getNetworkDevices, getBandwidthLive, getWireguardStatus,
  getFail2banStatus, getDnsQueries, getCurrentExternalIp,
  runSpeedTest, executeCommand, applyDomainRouting, applyBlockedDevices,
  sampleMetrics, detectInterfaces, recoverInterruptedFtlRestart, VALID_DNSMASQ_DOMAIN, getRoutingApplyStatus,
  getLanIdentity, protectedMacs, getPi5LanIp, readNetModeState, runExclusiveDnsTask, AP_ADDR, AP_NET,
} from './system';
import type { RangeRoute } from './system';
import { ASN_TOKEN, getAsnPrefixes, normalizeCidr, refreshAsnIfStale } from './ipRanges';
import { getRoutingSuggestions, MAX_HOURS as SUGGEST_MAX_HOURS } from './domainSuggest';
import {
  shq, sedEscape, isValidMac, isValidDomain, isValidTimezone,
  isValidHexColor, normalizeAnimation, sanitizeName,
} from './util';
import { promisify } from 'util';
import { execFile as _execFile, spawn as _spawn } from 'child_process';
const execFileP = promisify(_execFile);

const app = express();
const port = process.env.PORT || 3001;
// Tek yerel nginx arkasında: yalnız loopback'ten gelen X-Forwarded-For'a güvenilir (istemci IP'si = gerçek LAN adresi;
// rate limit istemci başına ayrılır). `true` sahtelenebilir ve express-rate-limit tarafından reddedilir.
app.set('trust proxy', 'loopback');

// Not: DNS-redirect edilen domain'ler için 302 yönlendirme artık NGINX (:80) katmanında yapılır
// (bkz. /etc/nginx/conf.d/pi5-redirect-map.conf + applyDomainRouting). Backend'e o trafik hiç ulaşmıyordu.

// ─── Security & Performance Middleware ───
app.use(helmet({ contentSecurityPolicy: false }));
// Uygulama same-origin sunulur (nginx :80 statik + /api proxy; dev'de vite /api proxy).
// origin=false → cross-origin tarayıcı yanıtı OKUYAMAZ ve JSON POST'lar preflight'ta bloklanır (CSRF savunması).
// Belirli bir origin gerekiyorsa CORS_ORIGIN env ile verilir.
app.use(cors({
  origin: process.env.CORS_ORIGIN || false,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '1mb' }));

// CSRF: başka bir sitenin tarayıcı üzerinden gövdesiz POST atmasını engeller — CORS yalnız yanıtın okunmasını engeller,
// form POST'u preflight'a girmez ve tarayıcı kayıtlı Basic kimliğini ekler. Yazma isteklerinde Origin varsa ana makine
// adı Host ile aynı olmalı (port karşılaştırılmaz); Origin yoksa (curl, Pi'deki betikler) geçer. DNS rebinding'de
// Origin ve Host aynı saldırgan adıdır — bu kontrol onu DURDURMAZ; koruma açıkken Basic Auth, panel koruması
// işlemlerinde ise trustedPanelHost durdurur.
const urlHostname = (u: string) => {
  try { return new URL(u).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'); } catch { return ''; }
};
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin === undefined) return next();
  const originHost = origin === 'null' ? '' : urlHostname(origin);
  const host = urlHostname(`http://${String(req.headers.host || '').trim()}`);
  if (originHost && host && originHost === host) return next();
  res.status(403).json({ error: 'İstek başka bir siteden geldi — reddedildi (paneli kendi adresinden kullanın)' });
});
// Panel koruması işlemleri yalnız IP adresi ya da Pi'nin kendi adlarıyla açılmış panelden kabul edilir: DNS rebinding
// sayfası (koruma henüz kapalıyken) kendi şifresini koyup korumayı açarak sahibini kilitleyemesin.
const trustedPanelHost = (hostHeader: string) => {
  const h = urlHostname(`http://${hostHeader.trim()}`);
  if (!h) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return true; // IPv4 / IPv6 sabit adres
  const me = require('os').hostname().toLowerCase();
  return ['localhost', 'pi.hole', me, `${me}.local`, `${me}.lan`, `${me}.home`].includes(h);
};
// trustedPanelHost reddinin mesajı: örnek adres getPi5LanIp (sabit adreste modem tarafı .153 — iki ağdan da ulaşılır), bulunamazsa genel metin.
const ipPanelHint = async () => {
  const ip = await getPi5LanIp().catch(() => '');
  return ip ? `Bu işlem için paneli IP adresiyle açın (ör. http://${ip})` : 'Bu işlem için paneli Pi\'nin IP adresiyle açın';
};

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

// Persisted metric history — backend samples every ~5s to disk (see recorder below), so the
// dashboard chart survives page refreshes and shows the last N minutes read from the DB.
app.get('/api/system/metrics/history', async (req, res) => {
  try {
    const minutes = Math.min(60, Math.max(1, Number(req.query.minutes) || 10));
    const since = Date.now() - minutes * 60 * 1000;
    const rows = await dbAll('SELECT ts, cpu_temp, cpu_usage, memory_usage, network_in, network_out, disk_read, disk_write, fan_speed FROM metric_history WHERE ts >= ? ORDER BY ts ASC', [since]);
    res.json({
      history: rows.map((r: any) => ({
        ts: r.ts,
        cpuTemp: r.cpu_temp ?? 0, cpuUsage: r.cpu_usage ?? 0, memoryUsage: r.memory_usage ?? 0,
        networkIn: r.network_in ?? 0, networkOut: r.network_out ?? 0,
        diskRead: r.disk_read ?? 0, diskWrite: r.disk_write ?? 0, fanSpeed: r.fan_speed ?? 0,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message, history: [] });
  }
});

// ─── Logs ───
app.get('/api/logs', (_req, res) => {
  res.json({ logs: getSystemLogs() });
});

app.post('/api/logs/clear', (_req, res) => {
  clearSystemLogs();
  res.json({ success: true });
});

// ─── Reboot ───
app.post('/api/system/reboot', (_req, res) => {
  if (!isLinux) {
    return res.status(400).json({ success: false, error: 'Yeniden başlatma sadece Pi5 üzerinde çalışır' });
  }
  res.json({ success: true, message: 'Pi 5 yeniden başlatılıyor...' });
  // Respond first, then reboot after a short delay
  setTimeout(() => { _execFile('reboot', [], () => {}); }, 1500);
});

// ─── Services ───
// Servis listesi: yalnız izin listesindeki satırlar (yedekten enjekte edilmiş adlar kabuğa hiç ulaşmaz); durum tek
// `systemctl show` çağrısıyla okunur. enabled = şu an çalışıyor (1/0) — anlamı değişmedi; ek alanlar geriye uyumlu.
app.get('/api/services', async (_req, res) => {
  try {
    const services = (await dbAll('SELECT * FROM service_status') as any[]).filter(r => isManagedService(r.name));
    if (isLinux && services.length) {
      const states = await getServiceStates(services.map(s => s.name));
      const checked_at = new Date().toISOString();
      for (const svc of services) {
        const st = states[svc.name as keyof typeof states];
        if (!st) continue;
        Object.assign(svc, {
          status: st.status, enabled: st.status === 'running' ? 1 : 0, unit: st.unit, active_state: st.active_state,
          sub_state: st.sub_state, boot_enabled: st.boot_enabled, restarts: st.restarts, detail: st.detail, checked_at,
          ...(st.tunnels ? { tunnels: st.tunnels } : {}),
        });
      }
    }
    res.json({ services });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kalıcı aç/kapa. Sonuç, servis oturduktan sonra ölçülen GERÇEK durumdur; her iki yönde başarısızlık 500 döner.
app.post('/api/services/toggle', async (req, res) => {
  try {
    const { name, enabled } = req.body ?? {};
    if (!isLinux) return res.status(400).json({ success: false, error: 'Servis kontrolü sadece Pi5 üzerinde çalışır' });
    if (!isManagedService(name) || !TOGGLEABLE_SERVICES.includes(name)) {
      const error = name === 'wireguard' ? 'WireGuard tünelleri VPS sayfasından (Bağla/Kes) yönetilir'
        : name === 'nftables' ? 'nftables aç/kapa ile yönetilmez (durdurmak tüm firewall kurallarını siler); Firewall sayfasını kullanın'
        : `Geçersiz servis: ${name}`;
      return res.status(400).json({ success: false, name, error });
    }
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, name, error: 'enabled alanı true/false olmalı' });
    // Pi-hole evin DHCP sunucusuyken kapatılırsa ev DNS'siz ve DHCP'siz kalır.
    if (name === 'pihole' && !enabled && await piDhcpActive()) return res.status(409).json({ success: false, name, error: PI_DHCP_BUSY_MSG });
    let actionError = '';
    try { await systemServices.toggleService(name, enabled); } catch (e: any) { actionError = e.message; }
    const timeout = actionError ? 3000 : enabled ? (name === 'pihole' ? FTL_SETTLE_TIMEOUT : 15000) : 10000;
    const st = await waitServiceSettled(name, enabled ? 'running' : 'stopped', timeout);
    const ok = !actionError && (enabled ? st.status === 'running' : st.status !== 'running' && st.status !== 'restarting');
    await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
      [st.status === 'running' ? 1 : 0, st.status, name]);
    if (!ok) {
      const why = actionError || `durum ${st.status}${st.detail ? ` — ${st.detail}` : ''} (${st.active_state || '?'}/${st.sub_state || '?'})`;
      return res.status(500).json({ success: false, name, enabled: st.status === 'running', status: st.status,
        error: `${name} ${enabled ? 'başlatılamadı' : 'durdurulamadı'}: ${why}` });
    }
    res.json({ success: true, name, enabled: st.status === 'running', status: st.status });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Özel firewall kurallarını (routing_rules) GÜVENLİ nft satırlarına çevirir.
// KRİTİK: target kullanıcı girdisidir → nft dosyasına girmeden önce katı doğrulama (enjeksiyon önleme).
function buildCustomFwRules(rows: any[]): string[] {
  const out: string[] = [];
  const ACTIONS: Record<string, string> = { accept: 'accept', drop: 'drop', reject: 'reject' };
  for (const r of rows || []) {
    const action = ACTIONS[String(r.action || '').toLowerCase()];
    if (!action) continue;
    const type = String(r.type || '').toLowerCase();
    const target = String(r.target || '').trim();
    if (type === 'tcp' || type === 'udp') {
      const n = Number(target);
      if (/^\d{1,5}$/.test(target) && n >= 1 && n <= 65535) out.push(`${type} dport ${n} ${action}`);
    } else if (type === 'ip') {
      // IPv4 veya IPv4/CIDR — yalnızca rakam, nokta, /; başka karakter kabul edilmez
      if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(target)) out.push(`ip saddr ${target} ${action}`);
    }
  }
  return out;
}

app.post('/api/services/setup', async (req, res) => {
  try {
    const action = req.body.action;
    let result;
    // Kurulum sonrası DB'ye zorla 'running' yazılmaz; ölçülen durum yazılır (kurulum ve blockcheck davranışı: Faz 5).
    const recordState = async (svc: 'pihole' | 'zapret' | 'nftables') => {
      if (!isLinux) return undefined;
      const st = (await getServiceStates([svc]))[svc];
      if (!st) return undefined;
      await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
        [st.status === 'running' ? 1 : 0, st.status, svc]);
      return st.status;
    };
    let status: string | undefined;
    // Yeniden kurulum FTL'i durdurup ayarlarını yazar — Pi-hole evin DHCP sunucusuyken yapılmaz.
    if (action === 'pihole' && await piDhcpActive()) return res.status(409).json({ success: false, error: PI_DHCP_BUSY_MSG });
    if (action === 'pihole') {
      result = await systemServices.installPihole();
      status = await recordState('pihole');
    }
    if (action === 'zapret') {
      const domain = req.body.domain || 'discord.com';
      if (!isValidDomain(domain)) {
        return res.status(400).json({ success: false, error: 'Geçersiz domain' });
      }
      result = await systemServices.installZapret(domain);
      status = await recordState('zapret');
    }
    if (action === 'firewall') {
      const cfg = await dbAll("SELECT key, value FROM service_config WHERE service = 'nftables' AND key IN ('lan_iface', 'wan_iface')");
      const m: Record<string, string> = {};
      (cfg as any[]).forEach(r => { m[r.key] = r.value; });
      // Özel kuralları DB'den al, doğrula, nftables input zincirine uygula
      const customRows = await dbAll('SELECT type, target, action FROM routing_rules');
      const custom = buildCustomFwRules(customRows);
      result = await systemServices.configureNftables({ lan: m.lan_iface, wan: m.wan_iface }, custom);
      status = await recordState('nftables');
    }
    res.json({ success: true, message: `Action ${action} executed.`, log: result, status });
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
    if (updates.length === 0) return res.json({ success: true });
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
// Yeniden başlat: yanıt servis oturduktan sonra gelir ve GERÇEK durumu taşır (eskiden hata olsa da 'running' yazılıyordu).
app.post('/api/services/:name/restart', async (req, res) => {
  try {
    const name = req.params.name;
    if (!isLinux) return res.status(400).json({ success: false, error: 'Servis kontrolü sadece Pi5 üzerinde çalışır' });
    if (!isManagedService(name)) return res.status(400).json({ success: false, error: `Geçersiz servis: ${name}` });
    await dbRun("UPDATE service_status SET status='restarting', last_check=CURRENT_TIMESTAMP WHERE name=?", [name]);
    let actionError = '';
    try {
      await systemServices.restartService(name);
    } catch (e: any) {
      actionError = e.message;
    }
    // nftables restart `nft flush ruleset` çalıştırır (routing zinciri ve NAT silinir); tünel yeniden kurulunca tablo
    // rotaları kaybolur → başarısızlıkta da yeniden uygulanır (idempotent, sıralı kuyruk).
    if (name === 'nftables' || name === 'wireguard') {
      await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    }
    // nftables restart `flush ruleset` ile cihaz engeli tablosunu da siler → yeniden uygula.
    if (name === 'nftables') await reapplyBlockedDevices();
    const st = await waitServiceSettled(name, 'running', actionError ? 3000 : name === 'pihole' ? FTL_SETTLE_TIMEOUT : 15000);
    await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
      [st.status === 'running' ? 1 : 0, st.status, name]);
    if (actionError || st.status !== 'running') {
      const why = actionError || `yeniden başlatıldı ama çalışmıyor: ${st.status}${st.detail ? ` — ${st.detail}` : ''} (${st.active_state || '?'}/${st.sub_state || '?'})`;
      return res.status(500).json({ success: false, status: st.status, error: `${name}: ${why}` });
    }
    res.json({ success: true, message: `${name} yeniden başlatıldı`, status: 'running' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
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
    // On Linux, persist the live scan into the DB so profile/block updates target real rows.
    if (isLinux) {
      const liveDevices = await getNetworkDevices();
      for (const live of liveDevices) {
        // Bağlantı geçmişi: cihaz yeni ya da >5dk görünmüyorduysa 'connected' olayı kaydet.
        // Kontrol upsert'ten ÖNCE yapılır (last_seen henüz tazelenmemişken); sürekli görünen
        // cihaz sadece bir kez loglanır, uzun aradan sonra dönerse yeniden loglanır.
        // NOT: alias 'returning' KULLANMA — SQLite ayrılmış kelimesi (RETURNING) → syntax error.
        const prev: any = await dbGet(
          "SELECT (last_seen IS NULL OR last_seen < datetime('now','-5 minutes')) AS is_returning FROM devices WHERE mac_address = ?",
          [live.mac]
        );
        const shouldLogConnect = !prev || prev.is_returning === 1;
        // Upsert into devices (keep existing hostname/profile/blocked; refresh ip + last_seen)
        await dbRun(
          `INSERT INTO devices (mac_address, ip_address, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(mac_address) DO UPDATE SET ip_address = excluded.ip_address, last_seen = CURRENT_TIMESTAMP`,
          [live.mac, live.ip]
        );
        if (shouldLogConnect) {
          await dbRun(
            "INSERT INTO connection_history (device_mac, event_type, timestamp) VALUES (?, 'connected', CURRENT_TIMESTAMP)",
            [live.mac]
          );
        }
        // Track first-seen for the "unknown devices" alert (approved defaults to 0)
        await dbRun('INSERT OR IGNORE INTO known_devices (mac_address) VALUES (?)', [live.mac]);
      }
    }
    const dbDevices = await dbAll('SELECT * FROM devices ORDER BY last_seen DESC');
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
    const servers = await dbAll('SELECT id, ip, username, location, status, created_at FROM vps_servers ORDER BY id');
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

  // Auto-connect Pi5 as gateway client to VPS.
  // 'success' tünel denemesinden SONRA yazılır: kurulum ekranı bunu görünce kartı yeniler ve kart
  // tunnel-status'u okur — önce yazılırsa tünel henüz yokken "Tünel kapalı" görünür.
  let tunnelOk = false;
  try {
    await connectPi5ToVps({ ip, username, password }, vpsId);
    tunnelOk = true;
  } catch (err: any) {
    console.error('Pi5 auto-connect failed:', err.message);
  }
  await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', vpsId]); // VPS is up (Pi5 tüneli başarısız olsa da)
  progress.overall = 'success';
  // Tünel artık var → bu VPS'e yönlenen kuralların tablo rotası kurulsun.
  if (tunnelOk) await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));

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
    const id = await dbInsert('INSERT INTO vps_servers (ip, username, password, location, status) VALUES (?, ?, ?, ?, ?)',
      [ip, username, password || '', location || '', 'connected']);
    res.json({ success: true, id });
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
    const vpsId = await dbInsert('INSERT INTO vps_servers (ip, username, password, location, status) VALUES (?, ?, ?, ?, ?)',
      [ip, username, password || '', location || '', 'installing']);

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
  const name = sanitizeName(req.body.name);
  if (!name) {
    return res.status(400).json({ error: 'Client adı gerekli (yalnızca harf, rakam, boşluk, . _ -)' });
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

    // Run all checks in a single script for speed and reliability
    const checkScript = `
      echo "---INTERNET---"
      ping -c 1 -W 3 8.8.8.8 &>/dev/null && echo "OK" || echo "FAIL"
      echo "---DNS---"
      ping -c 1 -W 3 google.com &>/dev/null && echo "OK" || echo "FAIL"
      echo "---FORWARD---"
      cat /proc/sys/net/ipv4/ip_forward 2>/dev/null
      echo "---WG---"
      wg show wg0 2>/dev/null | head -1 || echo "FAIL"
      echo "---NAT---"
      iptables -t nat -L POSTROUTING -n 2>/dev/null | grep -ci masq || echo "0"
      echo "---IP---"
      curl -s4 --max-time 3 ifconfig.me 2>/dev/null || wget -qO- --timeout=3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}' || echo ""
    `;
    const result = await ssh.execCommand(checkScript, { execOptions: { timeout: 20000 } });
    ssh.dispose();

    const out = result.stdout;
    const section = (tag: string) => {
      const re = new RegExp(`---${tag}---\\n(.*)`, 'm');
      return re.exec(out)?.[1]?.trim() || '';
    };

    const hasInternet = section('INTERNET') === 'OK';
    const hasDns = section('DNS') === 'OK';
    const hasForwarding = section('FORWARD') === '1';
    const hasWg = section('WG').includes('wg0') || section('WG').includes('interface');
    const natCount = parseInt(section('NAT')) || 0;
    const hasNat = natCount > 0;
    const publicIp = section('IP');
    const allGood = hasInternet && hasDns && hasForwarding && hasWg && hasNat;

    // Auto-update DB status based on check results
    if (allGood) {
      await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', req.params.id]);
    } else if (hasInternet) {
      // VPS reachable but some services down
      await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['connected', req.params.id]);
    } else {
      await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', req.params.id]);
    }

    res.json({ internet: hasInternet, dns: hasDns, forwarding: hasForwarding, wireguard: hasWg, nat: hasNat, publicIp, allGood });
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
    const dnsCheck = await ssh.execCommand('ping -c 1 -W 2 google.com 2>/dev/null && echo "DNS_OK" || echo "DNS_FAIL"');
    if (dnsCheck.stdout.includes('DNS_OK')) {
      repairs.push({ check: 'DNS', status: 'ok', detail: 'DNS çözümleme aktif' });
    } else {
      // Fix: write proper resolv.conf, install dnsutils, disable systemd-resolved if it conflicts
      await ssh.execCommand(`
        # Stop systemd-resolved if it's blocking port 53
        systemctl stop systemd-resolved 2>/dev/null || true;
        systemctl disable systemd-resolved 2>/dev/null || true;
        # Remove symlink if exists
        rm -f /etc/resolv.conf 2>/dev/null || true;
        # Write fresh resolv.conf
        echo "nameserver 8.8.8.8" > /etc/resolv.conf;
        echo "nameserver 1.1.1.1" >> /etc/resolv.conf;
        echo "nameserver 8.8.4.4" >> /etc/resolv.conf;
        # Protect from being overwritten
        chattr +i /etc/resolv.conf 2>/dev/null || true;
        # Install dig/nslookup
        export DEBIAN_FRONTEND=noninteractive;
        apt-get install -y -qq dnsutils 2>/dev/null || true;
      `);
      const recheck = await ssh.execCommand('ping -c 1 -W 3 google.com 2>/dev/null && echo "DNS_OK" || echo "DNS_FAIL"');
      repairs.push({ check: 'DNS', status: recheck.stdout.includes('DNS_OK') ? 'fixed' : 'failed', detail: recheck.stdout.includes('DNS_OK') ? 'resolv.conf düzeltildi, systemd-resolved devre dışı' : 'DNS hâlâ çözümlenemiyor — resolv.conf: ' + (await ssh.execCommand('cat /etc/resolv.conf 2>/dev/null')).stdout.trim().slice(0, 80) });
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
    // Update DB status
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', [allFixed ? 'connected' : 'error', req.params.id]);
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
        // Remove peer from running WireGuard (public key is base64 — shell-quote it)
        await ssh.execCommand(`wg set wg0 peer ${shq(client.public_key)} remove 2>/dev/null || true`);
        // Remove peer from config file — shell-quote the whole sed script, sed-escape the interpolated values
        await ssh.execCommand(`sed -i ${shq(`/# ${sedEscape(sanitizeName(client.name))}/,/^$/d`)} /etc/wireguard/wg0.conf 2>/dev/null || true`);
        // Also try removing by public key pattern
        await ssh.execCommand(`sed -i ${shq(`/PublicKey = ${sedEscape(client.public_key)}/,/^$/d`)} /etc/wireguard/wg0.conf 2>/dev/null || true`);
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
    let tunnelError = '';
    try {
      tunnelResult = await connectPi5ToVps(
        { ip: server.ip, username: server.username, password: server.password || undefined },
        server.id
      );
    } catch (tunnelErr: any) {
      // Pi5 tunnel failed but VPS itself is connected
      console.log('Pi5 tunnel not established:', tunnelErr.message);
      tunnelError = tunnelErr.message || String(tunnelErr);
    }

    // wg-quick down/up arayüzün tablo rotalarını siler → routing'i yeniden uygula (tünel yoksa rota eklenmez).
    if (tunnelResult) await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));

    res.json({ success: true, tunnel: tunnelResult ? true : false, tunnelError: tunnelError || undefined, message: tunnelResult ? 'VPS bağlı + tünel aktif' : 'VPS bağlı (tünel Pi5 üzerinde kurulacak)' });
  } catch (e: any) {
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', req.params.id]);
    res.status(500).json({ error: e.message || 'Bağlantı başarısız' });
  }
});

app.post('/api/vps/:id/disconnect', async (req, res) => {
  try {
    await disconnectPi5FromVps(Number(req.params.id));
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['disconnected', req.params.id]);
    await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
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
    await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Traffic Routing (app-based + domain-based, unified engine) ───

// Çağrılar sıraya alınır: eşzamanlı iki uygulama PI5_ROUTING'i birbirinin ortasında boşaltıp eski kuralları
// bırakabilir. Her sıradaki çalışma DB'yi kendi başında okur → en güncel durumu uygular.
let routingQueue: Promise<void> = Promise.resolve();
function applyAllRoutingRules(): Promise<void> {
  const next = routingQueue.then(applyAllRoutingRulesNow, applyAllRoutingRulesNow);
  routingQueue = next.catch(() => {});
  return next;
}

// Helper: collect all routing domains from both tables and apply
async function applyAllRoutingRulesNow() {
  if (!isLinux) return;
  // 1. App routing: expand domains column into individual domain entries
  const appRules = await dbAll('SELECT app_name, domains, exit_node, dpi_bypass, enabled FROM traffic_routing WHERE enabled = 1 AND domains != ""');
  const domainRules = await dbAll('SELECT domain, exit_node, dpi_bypass, enabled, redirect_url FROM domain_routing WHERE enabled = 1');

  const allDomains: { domain: string; exit_node: string; dpi_bypass: number; enabled: number; redirect_url?: string }[] = [];
  // IP aralığı girdileri (ipRanges.ts): @asn:<n>[!443] ve a.b.c.d[/nn] — DNS'siz trafik (ör. WhatsApp aramaları) için.
  const ranges: RangeRoute[] = [];

  // App domains (wildcard patterns like *.whatsapp.net → whatsapp.net for dnsmasq)
  for (const rule of appRules) {
    const domains = (rule.domains as string).split(',').map((d: string) => d.trim()).filter(Boolean);
    for (const domain of domains) {
      const asn = ASN_TOKEN.exec(domain);
      if (asn) {
        const r = await getAsnPrefixes(Number(asn[1]));
        if (r.prefixes.length) ranges.push({ exit_node: rule.exit_node, dpi_bypass: rule.dpi_bypass, prefixes: r.prefixes, excludeWeb: !!asn[2] });
        continue;
      }
      const cidr = normalizeCidr(domain);
      if (cidr) {
        ranges.push({ exit_node: rule.exit_node, dpi_bypass: rule.dpi_bypass, prefixes: [cidr], excludeWeb: false });
        continue;
      }
      // dnsmasq ipset handles subdomains automatically, strip leading *.
      const clean = domain.replace(/^\*\./, '');
      allDomains.push({ domain: clean, exit_node: rule.exit_node, dpi_bypass: rule.dpi_bypass, enabled: 1 });
    }
  }

  // Custom domain rules — redirect_url dahil (yoksa DNS-redirect kuralları kaybolur)
  for (const rule of domainRules) {
    allDomains.push({ domain: rule.domain, exit_node: rule.exit_node, dpi_bypass: rule.dpi_bypass, enabled: 1, redirect_url: rule.redirect_url || undefined });
  }

  await applyDomainRouting(allDomains, ranges);
}

// Etkin kurallardaki AS aralıkları (ör. WhatsApp → Meta AS32934) 6 saatte bir denetlenir; önbellek 24 saatten eskiyse
// RIPE'den yenilenir ve liste değiştiyse kurallar yeniden uygulanır (Meta yeni aralık ilan ettiğinde aramalar kaçmasın).
async function refreshAsnRanges() {
  if (!isLinux) return;
  try {
    const rows = await dbAll('SELECT domains FROM traffic_routing WHERE enabled = 1 AND domains != ""');
    const asns = new Set<number>();
    for (const r of rows as any[]) {
      for (const d of String(r.domains).split(',')) { const m = ASN_TOKEN.exec(d.trim()); if (m) asns.add(Number(m[1])); }
    }
    let changed = false;
    for (const asn of asns) if (await refreshAsnIfStale(asn)) changed = true;
    if (changed) await applyAllRoutingRules();
  } catch (e: any) {
    console.error('[routing] AS aralıkları yenilenemedi:', e?.message || e);
  }
}

// Boot/restart sonrası Pi tünellerini (wg_vps*) ve routing çekirdek durumunu geri kurar: ipset, mangle,
// ip rule ve tablo rotaları kalıcı değildir. Kullanıcı niyeti systemd enable durumundan okunur
// (Bağla → enable, Kes → disable); status alanı internet-check ile kendiliğinden 'connected' olabildiği için
// kullanılmaz. Eski kurulumlar (unit enable edilmemiş ama tünel ayakta) kalıcı hale getirilir.
async function restoreTunnelsAndRouting() {
  if (!isLinux) return;
  const fs = require('fs');
  try {
    // Önceki süreç FTL'i durdurup yeniden başlatamadan öldüyse (güncelleme restart'ı, çökme) DNS'i geri aç.
    await recoverInterruptedFtlRestart();
    const servers: any[] = await dbAll('SELECT id FROM vps_servers');
    for (const s of servers) {
      const iface = `wg_vps${Number(s.id)}`;
      if (!fs.existsSync(`/etc/wireguard/${iface}.conf`)) continue;
      const up = fs.existsSync(`/sys/class/net/${iface}`);
      const enabled = (await execFileP('systemctl', ['is-enabled', `wg-quick@${iface}`], { timeout: 5000 })
        .then(r => r.stdout.trim()).catch(() => '')) === 'enabled';
      if (up && !enabled) {
        await execFileP('systemctl', ['enable', `wg-quick@${iface}`], { timeout: 10000 }).catch(() => {});
      } else if (!up && enabled) {
        // Boot'ta systemd zaten başlatıyor olabilir; start o işi bekler → aşağıdaki routing tünel varken uygulanır.
        const unit = `wg-quick@${iface}`;
        const started = await execFileP('systemctl', ['start', unit], { timeout: 20000 }).then(() => true, () => false);
        if (!started) {
          // wg-quick@ network-online'ı bekler; ağ geç gelirse arka planda beklemeye devam et, tünel gelince
          // routing'i yeniden uygula (yoksa tablo rotası eksik kalır ve trafik sessizce ISP'ye düşer).
          console.error(`${iface} 20 sn içinde kalkmadı — arka planda bekleniyor`);
          void execFileP('systemctl', ['start', unit], { timeout: 180000 })
            .then(() => applyAllRoutingRules())
            .catch((e: any) => console.error(`${iface} başlatılamadı:`, e.message));
        }
      }
    }
    await applyAllRoutingRules();
  } catch (e: any) {
    console.error('Tünel/routing geri yüklenemedi:', e.message);
  }
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
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE traffic_routing SET ${updates.join(', ')} WHERE id = ?`, params);
    // Apply unified routing (app + domain rules together)
    await applyAllRoutingRules();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kural değişikliğinin uygulanma durumu (panel bandı yoklar). Yalnız bellekteki durum — sistem komutu çalıştırmaz.
app.get('/api/routing/status', (_req, res) => {
  res.json(getRoutingApplyStatus());
});

// ─── Domain-Based Routing ───
app.get('/api/routing/domains', async (_req, res) => {
  try {
    const domains = await dbAll('SELECT id, domain, route_type, description, enabled, exit_node, dpi_bypass, redirect_url, created_at FROM domain_routing ORDER BY domain');
    res.json({ domains });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routing/domains', async (req, res) => {
  try {
    const { domain, route_type, description, exit_node, dpi_bypass, redirect_url } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain gerekli' });
    const cleanDomain = domain.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
    await dbRun('INSERT INTO domain_routing (domain, route_type, description, exit_node, dpi_bypass, redirect_url) VALUES (?, ?, ?, ?, ?, ?)',
      [cleanDomain, route_type || 'direct', description || '', exit_node || 'isp', dpi_bypass ? 1 : 0, redirect_url || '']);
    // Apply unified routing (app + domain rules together)
    await applyAllRoutingRules();
    const domains = await dbAll('SELECT id, domain, route_type, description, enabled, exit_node, dpi_bypass, redirect_url, created_at FROM domain_routing ORDER BY domain');
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
    const { route_type, enabled, description, exit_node, dpi_bypass, redirect_url } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (route_type !== undefined) { updates.push('route_type = ?'); params.push(route_type); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (exit_node !== undefined) { updates.push('exit_node = ?'); params.push(exit_node); }
    if (dpi_bypass !== undefined) { updates.push('dpi_bypass = ?'); params.push(dpi_bypass ? 1 : 0); }
    if (redirect_url !== undefined) { updates.push('redirect_url = ?'); params.push(redirect_url); }
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

// ─── Routing önerileri: yönlendirilen siteyle birlikte açılan alan adları (öner → tek tıkla ekle / yoksay) ───
// /api/routing/domains/... altında DEĞİL: PUT/DELETE /:id rotaları o yolu yakalar.
const DOMAIN_ROUTING_COLUMNS = 'id, domain, route_type, description, enabled, exit_node, dpi_bypass, redirect_url, created_at';
// Öneri adları sunucunun ürettiği hedeflerdir: yalnız kırpılır/küçültülür. POST /api/routing/domains'teki gibi 'www.'
// SİLİNMEZ — tek görülen 'www.x.com' önerisi 'x.com' (tüm alt adresler) olarak kaydedilirse onaylanandan geniş olurdu.
const cleanSuggestedDomain = (d: unknown) => (typeof d === 'string' ? d.trim().toLowerCase() : '');
const isSuggestableDomain = (d: string) => d.includes('.') && !d.startsWith('*.') && VALID_DNSMASQ_DOMAIN.test(d);

app.get('/api/routing/suggestions', async (req, res) => {
  try {
    const h = Number.parseInt(String(req.query.hours ?? '24'), 10);
    const hours = Number.isFinite(h) ? Math.min(Math.max(h, 1), SUGGEST_MAX_HOURS) : 24;
    // Başlangıç kuralları: etkin, özel çıkışlı (VPS ya da DPI), redirect değil, öneriden eklenmemiş.
    const anchors = await dbAll(`SELECT id, domain FROM domain_routing WHERE enabled = 1
      AND COALESCE(redirect_url, '') = '' AND (COALESCE(exit_node, 'isp') != 'isp' OR dpi_bypass = 1) AND parent_id IS NULL`);
    // Kapsananlar: TÜM domain kuralları (kapalılar da — yoksa Ekle 'zaten ekli' hatası verir) ve yalnız etkin + gerçekten
    // yönlendirilen uygulama kuralları (ISP/DPI kapalı uygulama adları normal hattan gider; önerilebilmeleri gerekir).
    const domainRows = await dbAll('SELECT domain FROM domain_routing');
    const appRows = await dbAll(`SELECT domains FROM traffic_routing WHERE enabled = 1
      AND (COALESCE(exit_node, 'isp') != 'isp' OR dpi_bypass = 1)`);
    const covered = [
      ...domainRows.map((r: any) => String(r.domain)),
      ...appRows.flatMap((r: any) => String(r.domains || '').split(',')),
    ];
    const dismissed = (await dbAll('SELECT domain FROM domain_suggestion_dismissed')).map((r: any) => String(r.domain));
    res.json(await getRoutingSuggestions({ anchors, covered, dismissed, hours }));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Tekli "Ekle" ve "Tümünü ekle" aynı yoldan: çıkış (exit_node/dpi) sunucuda ana kuraldan kopyalanır, tek uygulama → tek DNS restart.
app.post('/api/routing/suggestions/accept', async (req, res) => {
  try {
    const ruleId = Number(req.body?.rule_id);
    const list = req.body?.domains;
    if (!Number.isInteger(ruleId) || !Array.isArray(list) || list.length < 1 || list.length > 20) {
      return res.status(400).json({ error: 'Geçersiz istek' });
    }
    const parent = await dbGet('SELECT id, domain, exit_node, dpi_bypass, redirect_url, parent_id FROM domain_routing WHERE id = ?', [ruleId]);
    if (!parent) return res.status(404).json({ error: 'Kural bulunamadı' });
    if (parent.redirect_url || ((parent.exit_node || 'isp') === 'isp' && !parent.dpi_bypass)) {
      return res.status(400).json({ error: 'Bu kural özel bir çıkış kullanmıyor' });
    }
    const clean = [...new Set(list.map(cleanSuggestedDomain))];
    const bad = clean.filter(d => !isSuggestableDomain(d));
    if (bad.length) return res.status(400).json({ error: `Geçersiz alan adı: ${bad.join(', ') || '(boş)'}` });
    const added: string[] = [];
    const skipped: string[] = [];
    for (const d of clean) {
      // Düz INSERT: eşzamanlı iki istekte ikincisi UNIQUE hatasıyla 'zaten ekli'ye düşer (yanlışlıkla 'eklendi' sayılmaz).
      try {
        await dbRun(`INSERT INTO domain_routing (domain, route_type, description, exit_node, dpi_bypass, redirect_url, parent_id)
          VALUES (?, 'direct', ?, ?, ?, '', ?)`,
          [d, `Öneri: ${parent.domain}`, parent.exit_node || 'isp', parent.dpi_bypass ? 1 : 0, parent.parent_id ?? parent.id]);
        added.push(d);
      } catch (e: any) {
        if (!String(e?.message).includes('UNIQUE')) throw e;
        skipped.push(d);
      }
    }
    if (added.length) await applyAllRoutingRules();
    const domains = await dbAll(`SELECT ${DOMAIN_ROUTING_COLUMNS} FROM domain_routing ORDER BY domain`);
    res.json({ success: true, added, skipped, domains });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routing/suggestions/dismiss', async (req, res) => {
  try {
    const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim().toLowerCase() : '';
    if (!isSuggestableDomain(domain)) return res.status(400).json({ error: 'Geçersiz alan adı' });
    const ruleDomain = typeof req.body?.rule_domain === 'string' ? req.body.rule_domain.slice(0, 253) : '';
    await dbRun('INSERT OR IGNORE INTO domain_suggestion_dismissed (domain, rule_domain) VALUES (?, ?)', [domain, ruleDomain]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/routing/suggestions/dismissed', async (_req, res) => {
  try {
    const dismissed = await dbAll('SELECT id, domain, rule_domain, created_at FROM domain_suggestion_dismissed ORDER BY created_at DESC, id DESC');
    res.json({ dismissed });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/routing/suggestions/dismissed/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM domain_suggestion_dismissed WHERE id = ?', [req.params.id]);
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

// ─── Otomatik hız testi zamanlayıcı ───────────────────────────────────────
// Varsayılan 6 saatte bir. 10 dk çok agresifti: tam speedtest hattı her seferinde
// ~30-60sn doyurur; gateway olduğu için 10 dk'da bir bunu yapmak üzerinden geçen tüm
// trafiği sürekli aksatır. Aralık Ayarlar'dan gelir (app_settings.speedtest_interval_min,
// dakika; 0 = kapalı); yoksa SPEEDTEST_INTERVAL_MIN env; yoksa 360. Ayar değişince
// PUT /api/settings rescheduleSpeedtest()'i çağırır → restart gerekmeden uygulanır.
let speedtestTimer: ReturnType<typeof setTimeout> | null = null;

async function getSpeedtestIntervalMin(): Promise<number> {
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'speedtest_interval_min'");
    if (row && row.value != null && row.value !== '') {
      const v = Number(row.value);
      if (Number.isFinite(v)) return Math.max(0, Math.round(v)); // 0 = kapalı
    }
  } catch { /* yoksay */ }
  return Number(process.env.SPEEDTEST_INTERVAL_MIN) || 360;
}

async function runAutoSpeedtest(): Promise<void> {
  try {
    const result = await runSpeedTest();
    if (result) {
      await dbRun(
        'INSERT INTO speed_tests (download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [result.download_mbps, result.upload_mbps, result.ping_ms, result.jitter_ms, result.packet_loss, result.server, result.isp]
      );
      console.log(`[SpeedTest] Otomatik ölçüm kaydedildi: ${result.download_mbps}↓ / ${result.upload_mbps}↑ Mbps, ping ${result.ping_ms}ms`);
    } else {
      console.warn('[SpeedTest] Otomatik ölçüm atlandı — speedtest-cli yok. Kur: sudo apt install speedtest-cli');
    }
    // Retention temizliği
    await dbRun(`DELETE FROM speed_tests WHERE timestamp < datetime('now', '-30 days')`);
    await dbRun(`DELETE FROM ddns_ip_history WHERE detected_at < datetime('now', '-90 days')`);
    await dbRun(`DELETE FROM connection_history WHERE timestamp < datetime('now', '-30 days')`);
  } catch (e: any) {
    console.error('[SpeedTest] Otomatik ölçüm hatası:', e?.message || e);
  }
}

// Aralığı DB'den okuyup bir sonraki çalıştırmayı planlar (self-rescheduling).
// Ayar değişince tekrar çağrılır → aralık restart'sız güncellenir. 0/negatif = kapalı.
async function rescheduleSpeedtest(): Promise<void> {
  if (speedtestTimer) { clearTimeout(speedtestTimer); speedtestTimer = null; }
  if (!isLinux) return;
  const min = await getSpeedtestIntervalMin();
  if (min <= 0) {
    console.log('[SpeedTest] Otomatik ölçüm kapalı (aralık = 0).');
    return;
  }
  speedtestTimer = setTimeout(async () => {
    await runAutoSpeedtest();
    rescheduleSpeedtest();
  }, min * 60 * 1000);
}

if (isLinux) {
  // Başlangıç yakalaması: ilk periyodik ölçüm ancak `min` dk SONRA düşer; backend sık yeniden
  // başlarsa (güncelleme vb.) sayaç sürekli sıfırlanıp hiç çalışmayabilir. Bu yüzden boot'tan
  // ~2 dk sonra, son ölçüm interval'den eskiyse (ya da hiç yoksa) bir kez çalıştır.
  setTimeout(async () => {
    try {
      const min = await getSpeedtestIntervalMin();
      if (min > 0) {
        const recent = await dbGet(
          `SELECT COUNT(*) AS n FROM speed_tests WHERE timestamp > datetime('now', '-${min} minutes')`
        );
        if (!recent || recent.n === 0) await runAutoSpeedtest();
      }
    } catch { /* yoksay */ }
  }, 120000);
  rescheduleSpeedtest();
}

// ─── Metric history recorder — sample every 5s, keep ~11 min (10-min window + margin) ───
// Runs independent of any client so history accumulates continuously; the dashboard reads it
// from /api/system/metrics/history and no longer resets on page refresh.
if (isLinux) {
  const METRIC_SAMPLE_MS = 5000;
  const METRIC_RETENTION_MS = 11 * 60 * 1000;
  const recordMetric = async () => {
    try {
      const s = await sampleMetrics();
      if (!s) return;
      await dbRun(
        'INSERT INTO metric_history (ts, cpu_temp, cpu_usage, memory_usage, network_in, network_out, disk_read, disk_write, fan_speed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [Date.now(), s.cpuTemp, s.cpuUsage, s.memoryUsage, s.networkIn, s.networkOut, s.diskRead, s.diskWrite, s.fanSpeed]
      );
      await dbRun('DELETE FROM metric_history WHERE ts < ?', [Date.now() - METRIC_RETENTION_MS]);
    } catch { /* silent */ }
  };
  setTimeout(recordMetric, 2000);
  setInterval(recordMetric, METRIC_SAMPLE_MS);
}

// ─── Health Check (every 5 minutes) ───
if (isLinux) {
  // Servis uyarıları DURUM DEĞİŞİMİNE göre: aynı kaynağın son satırı aynı önemdeyse yeniden yazılmaz (eskiden saatlik
  // tekrar). Düzelme, 2 ardışık sağlıklı ölçümden sonra bir kez ve okunmuş (acknowledged=1) bilgi satırı olarak düşülür —
  // okunmamış sayacını şişirmez, dalgalanan servis her 5 dk'da uyarı+düzelme çifti üretmez.
  // 'warning' (durmuş / tünel kapalı) ancak 2 ardışık ölçümde sürerse yazılır — tek ölçümlük pencere (açılışta sırası
  // gelmemiş birim, Bağla/yeniden başlatma arası) uyarı üretmez. Çökme ('critical') hemen yazılır.
  const healthyStreak = new Map<string, number>();
  const badStreak = new Map<string, number>();
  const lastRestarts = new Map<string, number>();
  const lastServiceAlert = (source: string) =>
    dbGet(`SELECT severity FROM alerts WHERE type = 'health' AND source = ? ORDER BY id DESC LIMIT 1`, [source]);
  const serviceAlert = async (source: string, severity: 'critical' | 'warning', message: string) => {
    healthyStreak.set(source, 0);
    const n = (badStreak.get(source) || 0) + 1;
    badStreak.set(source, n);
    if (severity === 'warning' && n < 2) return;
    const last = await lastServiceAlert(source);
    if (last && last.severity === severity) return;
    await dbRun(`INSERT INTO alerts (type, severity, message, source) VALUES ('health', ?, ?, ?)`, [severity, message, source]);
  };
  const serviceHealthy = async (source: string, message: string) => {
    badStreak.set(source, 0);
    const n = (healthyStreak.get(source) || 0) + 1;
    healthyStreak.set(source, n);
    if (n !== 2) return;
    const last = await lastServiceAlert(source);
    if (last && (last.severity === 'critical' || last.severity === 'warning')) {
      await dbRun(`INSERT INTO alerts (type, severity, message, source, acknowledged) VALUES ('health', 'info', ?, ?, 1)`, [message, source]);
    }
  };
  const checkServiceHealth = async () => {
    const states = await getServiceStates(MANAGED_SERVICE_NAMES);
    // Eski aç/kapa yalnız `systemctl stop` yapıyordu (birim açılışta etkin kaldı) ve durmuş servisi 'not_installed'
    // yazıyordu: kurulu birimde bu iz = kullanıcı bilerek kapatmış. Yeni aç/kapa satırı gerçek durumla ezer.
    const legacyOff = new Set((await dbAll(`SELECT name FROM service_status WHERE enabled = 0 AND status = 'not_installed'`) as any[]).map(r => r.name));
    for (const name of MANAGED_SERVICE_NAMES) {
      const st = states[name];
      if (!st || st.probe_failed) continue; // durum okunamadı: "çöktü" değil, bu tur uyarı yok
      if (name === 'wireguard') {
        for (const t of st.tunnels || []) {
          const src = `service:wireguard:${t.iface}`;
          if (t.up) { await serviceHealthy(src, `WireGuard tüneli yeniden ayakta: ${t.iface}`); continue; }
          // Açılışta etkin olmayan (bilerek kesilmiş) ya da hâlâ açılmakta olan (başlatma işi sırada dahil) tünel için uyarı yok.
          if (!t.boot_enabled || t.status === 'restarting' || t.active_state === 'activating') { badStreak.set(src, 0); continue; }
          await serviceAlert(src, t.active_state === 'failed' ? 'critical' : 'warning', `WireGuard tüneli kapalı: ${t.iface}`);
        }
        continue;
      }
      const src = `service:${name}`;
      // Yeniden başlatma sayacı iki kontrol arasında arttıysa, anlık görüntü 'running' olsa da çökme döngüsüdür.
      const prev = lastRestarts.get(name);
      lastRestarts.set(name, st.restarts);
      const looping = prev !== undefined && st.restarts > prev;
      if (st.status === 'error' || looping) {
        const extra = looping ? `, ${st.restarts - (prev as number)} yeniden başlatma` : '';
        await serviceAlert(src, 'critical', `Servis çöktü: ${name} (${st.unit}: ${st.active_state}/${st.sub_state}${extra})`);
      } else if (st.status === 'stopped' && st.boot_enabled && !legacyOff.has(name)) {
        await serviceAlert(src, 'warning', `Servis beklenmedik şekilde durmuş: ${name} (${st.unit})`);
      } else if (st.status === 'running') {
        await serviceHealthy(src, `Servis yeniden çalışıyor: ${name}`);
      } else {
        badStreak.set(src, 0); // restarting / not_installed / bilerek kapatılmış (açılışta devre dışı) → sessiz
      }
    }
  };
  let dhcpProbeTick = 0; // Pi DHCP açıkken başka sunucu taraması her 3. turda
  const healthCheck = async () => {
    try {
      const exec = require('util').promisify(require('child_process').exec);
      const addAlert = async (type: string, severity: string, message: string, source: string) => {
        // "info" (normal durum) alertleri kalıcılaştırma — her 5 dk değişen mesajla tabloyu şişiriyor,
        // dedup çalışmıyor ve okunmamış sayacı sürekli artıyordu. Yalnızca warning/critical kaydedilir.
        if (severity === 'info') return;
        // Aynı kaynak+tip için 1 saat içindeki tekrarları önle (mesaj değişse bile, örn. sıcaklık değeri)
        const existing = await dbGet(
          `SELECT id FROM alerts WHERE type = ? AND source = ? AND severity = ? AND created_at > datetime('now', '-1 hour')`,
          [type, source, severity]
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
      else if (cpuTemp > 0) await addAlert('health', 'info', `CPU sıcaklığı normal: ${cpuTemp.toFixed(1)}°C`, 'cpu');

      // Memory
      const { stdout: memStr } = await exec("free -m | awk '/Mem:/{print $3/$2*100}'", { timeout: 3000 }).catch(() => ({ stdout: '0' }));
      const memPercent = parseFloat(memStr);
      if (memPercent > 90) await addAlert('health', 'warning', `RAM kullanımı %${memPercent.toFixed(0)} — kritik seviyede`, 'memory');
      else if (memPercent > 0) await addAlert('health', 'info', `RAM kullanımı normal: %${memPercent.toFixed(0)}`, 'memory');

      // Disk
      const { stdout: diskStr } = await exec("df / --output=pcent | tail -1 | tr -d ' %'", { timeout: 3000 }).catch(() => ({ stdout: '0' }));
      const diskPercent = parseInt(diskStr);
      if (diskPercent > 85) await addAlert('health', 'warning', `Disk kullanımı %${diskPercent} — alan azalıyor`, 'disk');
      else if (diskPercent > 0) await addAlert('health', 'info', `Disk kullanımı normal: %${diskPercent}`, 'disk');

      // Services — kendi try'ı: bir hata sonraki DNS/İnternet kontrollerini ve temizliği atlatmasın.
      try {
        await checkServiceHealth();
      } catch (e: any) {
        console.error('[health] servis kontrolü başarısız:', e?.message || e);
      }

      // DNS check
      const { stdout: dnsCheck } = await exec('dig @127.0.0.1 -p 5335 google.com +short +time=3', { timeout: 5000 }).catch(() => ({ stdout: '' }));
      if (!dnsCheck.trim()) await addAlert('health', 'critical', 'DNS çözümleme başarısız — Unbound yanıt vermiyor', 'dns');
      else await addAlert('health', 'info', 'DNS çözümleme çalışıyor', 'dns');

      // Internet connectivity
      const { stdout: pingCheck } = await exec('ping -c 1 -W 3 1.1.1.1 2>/dev/null', { timeout: 5000 }).catch(() => ({ stdout: '' }));
      if (!pingCheck.includes('1 received')) await addAlert('health', 'critical', 'İnternet bağlantısı kesildi', 'network');
      else await addAlert('health', 'info', 'İnternet bağlantısı aktif', 'network');

      // Pi DHCP sunucusu ve sabit adres — kendi try'ı. Modemin DHCP'si kendiliğinden geri açılırsa (sıfırlama, güncelleme)
      // ev ikiye bölünür: 3 turda bir (15 dk) keşif paketiyle başka sunucu aranır.
      try {
        const fs = require('fs');
        if (fs.existsSync(PI_DHCP_SCRIPT)) {
          const d = await runKvScript(PI_DHCP_SCRIPT, ['status'], 30000);
          if (d.code === 0 && d.kv.stage === 'on') {
            if (d.kv.port67 !== '1') await addAlert('health', 'critical', 'DHCP sunucusu (Pi-hole) dinlemiyor — cihazlar adres alamayabilir', 'dhcp');
            if (dhcpProbeTick++ % 3 === 0) {
              // Betik kilidi 60 sn bekleyebilir (o an bir DHCP işlemi sürüyorsa): süre ona göre.
              const p = await runKvScript(PI_DHCP_SCRIPT, ['probe'], 90000);
              const others = splitList(p.kv.servers);
              if (p.code === 0 && others.length) {
                await addAlert('health', 'critical', `Başka bir DHCP sunucusu yanıt veriyor (${others.join(', ')}) — modemin DHCP'si yeniden açılmış olabilir`, 'dhcp-rogue');
              } else if (p.code !== 0 && !/başka bir DHCP işlemi sürüyor/.test(p.kv.error || '')) {
                // Çalışmayan tarama "başka sunucu yok" sayılmaz (kilit meşgulse yalnız bu tur atlanır).
                const msg = kvError(p, 'bilinmeyen hata');
                await addAlert('health', 'warning', /^DHCP taraması/.test(msg) ? msg : `DHCP taraması çalışmadı: ${msg}`, 'dhcp-probe');
              }
            }
          } else {
            dhcpProbeTick = 0;
          }
        }
        // Kurulum Wi-Fi'ı kalıcıyken yayın düşmüşse uyarı (ev için kritik değil; Pi açılışta ve NetworkManager yeniden
        // başlayınca yayını yeniden açmayı dener).
        const ns = readNetModeState();
        if (fs.existsSync(NET_MODE_SCRIPT) && (ns?.stage === 'static' || ns?.apStage === 'on')) {
          const n = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
          if (n.code === 0 && ns?.stage === 'static' && n.kv.guard_result === 'emergency') {
            await addAlert('health', 'critical', 'Sabit IP profili yüklenemedi — Pi adresini acil modda tutuyor (menü → Pi-hole DNS → DHCP Ayarları)', 'netmode');
          }
          if (n.code === 0 && n.kv.ap_stage === 'on' && n.kv.ap_active !== '1') {
            await addAlert('health', 'warning', 'Kurulum Wi-Fi yayını kapalı — Pi bir sonraki açılışta ya da NetworkManager yeniden başlayınca yeniden açmayı dener', 'netmode-ap');
          }
        }
      } catch (e: any) {
        console.error('[health] DHCP/sabit adres kontrolü başarısız:', e?.message || e);
      }

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
  if (!isValidMac(mac_address)) {
    return res.status(400).json({ error: 'Geçersiz MAC adresi formatı' });
  }
  try {
    if (isLinux) {
      // Real WoL magic packet via etherwake or wakeonlan — execFile (no shell), arg passed safely
      try {
        await execFileP('etherwake', [mac_address], { timeout: 5000 });
      } catch {
        await execFileP('wakeonlan', [mac_address], { timeout: 5000 });
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
// Canlı kiralar Pi-hole FTL'in dosyasından (/etc/pihole/dhcp.leases); satır: "bitiş mac ip ad [client-id]". "duid"
// satırı (DHCPv6) atlanır. DB'den yalnız statik rezervasyonlar gelir (is_static=0 hayalet satırlar dönmez).
app.get('/api/dhcp/leases', async (_req, res) => {
  try {
    const staticLeases = await dbAll('SELECT * FROM dhcp_leases WHERE is_static = 1 ORDER BY ip_address');
    const dynamic: any[] = [];
    if (isLinux) {
      try {
        const fs = require('fs');
        const p = '/etc/pihole/dhcp.leases';
        if (fs.existsSync(p)) {
          const staticMacs = new Set((staticLeases as any[]).map(l => String(l.mac_address).toLowerCase()));
          const txt: string = fs.readFileSync(p, 'utf8');
          for (const line of txt.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] === 'duid') continue;
            if (parts.length < 4 || !/^\d+$/.test(parts[0])) continue;
            const [exp, mac, ip, host] = parts;
            if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac) || staticMacs.has(mac.toLowerCase())) continue; // statikler tekrar eklenmez
            dynamic.push({
              mac_address: mac,
              ip_address: ip,
              hostname: host && host !== '*' ? host : '',
              lease_end: exp && exp !== '0' ? new Date(Number(exp) * 1000).toISOString() : null,
              is_static: 0,
            });
          }
        }
      } catch { /* lease dosyası okunamadı — yalnız statikleri döndür */ }
    }
    res.json({ leases: [...staticLeases, ...dynamic] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Gerçek DHCP / ağ geçidi durumu (panelin DHCP kartı): Pi-hole DHCP'si açık mı, Pi'nin LAN kimliği, kira sayısı.
// Salt okunur. (Panelin eski DHCP ayar alanları yalnız veritabanına yazıyordu; bunlar arayüzden kaldırıldı.)
// pi = pi-dhcp.sh durumu (sihirbaz: deneme/açık/kapalı, 67 portu, kira sayısı); betik yoksa null.
app.get('/api/dhcp/status', async (_req, res) => {
  try {
    if (!isLinux) return res.json({ supported: false });
    const fs = require('fs');
    const key = async (k: string) => {
      try { return (await execFileP('pihole-FTL', ['--config', k], { timeout: 5000 })).stdout.trim(); } catch { return ''; }
    };
    const piStatus = async () => {
      if (!fs.existsSync(PI_DHCP_SCRIPT)) return null;
      const r = await runKvScript(PI_DHCP_SCRIPT, ['status'], 30000);
      return r.code === 0 ? kvTyped(r.kv, PI_DHCP_NUMS, PI_DHCP_BOOLS) : { error: kvError(r, 'Pi DHCP durumu okunamadı') };
    };
    const [[active, start, end, router, leaseTime], pi] = await Promise.all([
      Promise.all(['dhcp.active', 'dhcp.start', 'dhcp.end', 'dhcp.router', 'dhcp.leaseTime'].map(key)), piStatus()]);
    let leases = 0;
    try {
      leases = String(fs.readFileSync('/etc/pihole/dhcp.leases', 'utf8')).split('\n').filter((l: string) => /^\d+\s/.test(l)).length;
    } catch { /* dosya yok */ }
    res.json({
      supported: true, pi_dhcp_active: active === 'true', start, end, router, lease_time: leaseTime, leases,
      lan: await getLanIdentity(), pi, netmode_stage: readNetModeState()?.stage || 'none',
    });
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

// ─── Faz 2: Pi'nin sabit adresi (scripts/net-mode.sh) ve Pi-hole DHCP sunucusu (scripts/pi-dhcp.sh) ───
// Riskli her adım denemedir: betik geri alma zamanlayıcısını değişiklikten ÖNCE kurar; "Kalıcı yap" gelmezse Pi kendi
// başına eski duruma döner (panel kapalı olsa da). Betikler kendi kilitleriyle sıralanır; Pi-hole'a yazan DHCP işleri
// ayrıca runExclusiveDnsTask ile panelin FTL yeniden başlatmalarının arasına girmez.
const NET_MODE_SCRIPT = '/opt/pi5-gateway/scripts/net-mode.sh';
const PI_DHCP_SCRIPT = '/opt/pi5-gateway/scripts/pi-dhcp.sh';
const NET_TRIAL_S = 180;
const NET_CLIENT_CIDR = '192.168.0.1/24';
const DHCP_TRIAL_S = 300;
const PI_DHCP_BUSY_MSG = 'Pi-hole şu an evin DHCP sunucusu — kapatılırsa cihazlar adres alamaz. Önce modemin DHCP\'sini açıp Pi DHCP\'sini kapatın';
// exited: betiğin gerçekten bittiği an (zaman aşımında yanıt önce döner, betik arka planda sürebilir).
type KvResult = { code: number | null; kv: Record<string, string>; exited?: Promise<void> };
// runPanelAuth deseni (key=value satırları, üst sınırlı çıktı), betik ve süre parametreli. Anahtarlar yalnız stdout'tan
// okunur; betik error= yazmadan düşerse stderr'in son satırı ayrıntı olur (araç uyarıları anahtarların üstüne yazmasın).
// Zaman aşımında yalnız salt okunur komutlar (status/probe) öldürülür: değişiklik yapan komut yarıda kesilirse Pi yarım
// ayarda (ör. FTL durmuş) kalabilir — o zaman beklemeyi bırakıp hata döneriz, betik işini kendi bitirir.
function runKvScript(script: string, args: string[], timeoutMs: number, input = ''): Promise<KvResult> {
  const name = script.split('/').pop() || script;
  const readOnly = args[0] === 'status' || args[0] === 'probe';
  let markExited: () => void = () => {};
  const exited = new Promise<void>(r => { markExited = r; });
  return new Promise(resolve => {
    const child = _spawn('bash', [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      if (readOnly) child.kill('SIGKILL');
      resolve({ code: null, exited, kv: {
        error: `${name} ${args[0] || ''} ${Math.round(timeoutMs / 1000)} sn içinde bitmedi${readOnly ? '' : ' (iş arka planda sürüyor — birazdan durumu yenileyin)'}`,
      } });
    }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 16384) out += d; });
    child.stderr.on('data', d => { if (err.length < 16384) err += d; });
    child.on('error', () => { clearTimeout(timer); markExited(); resolve({ code: -1, exited, kv: { error: `${name} çalıştırılamadı` } }); });
    child.on('close', code => {
      clearTimeout(timer);
      markExited();
      const kv: Record<string, string> = {};
      for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      if (code === null && !kv.error) kv.error = `${name} ${args[0] || ''} yarıda kesildi`;
      if (code !== 0 && !kv.error && !kv.detail) {
        const last = err.trim().split('\n').pop()?.trim();
        if (last) kv.detail = last.slice(0, 300);
      }
      resolve({ code, exited, kv });
    });
    // Betik stdin'i okumadan çıkarsa yazma EPIPE verir; dinleyicisiz 'error' olayı tüm backend'i düşürürdü. Sonuç yine
    // 'close' ile (çıkış kodu + çıktı) bildirilir.
    child.stdin.on('error', () => { /* betik stdin'i okumadan çıktı */ });
    child.stdin.end(input);
  });
}
// FTL'e dokunan pi-dhcp.sh işleri DNS zincirinde çalışır. HTTP yanıtı zaman aşımında dönse bile zincir betik gerçekten
// bitene kadar bekler: panelin FTL yeniden başlatması betiğin "FTL durdurulmuş" penceresine girmesin.
const runPiDhcpExclusive = (args: string[], timeoutMs: number) => new Promise<KvResult>((resolve, reject) => {
  runExclusiveDnsTask(async () => {
    const r = await runKvScript(PI_DHCP_SCRIPT, args, timeoutMs);
    resolve(r);
    await r.exited;
  }).catch(reject);
});
const kvError = (r: KvResult, fallback: string) => [r.kv.error || fallback, r.kv.detail].filter(Boolean).join(' — ');
// Betik çıktısı → JSON: sayı ve bayrak alanları dönüştürülür, diğerleri metin kalır.
const kvTyped = (kv: Record<string, string>, nums: string[], bools: string[]) => {
  const out: Record<string, string | number | boolean> = { ...kv };
  for (const k of nums) out[k] = Number(kv[k]) || 0;
  for (const k of bools) out[k] = kv[k] === '1' || kv[k] === 'true';
  if ('now' in out && !out.now) out.now = Math.floor(Date.now() / 1000);
  return out;
};
const NET_NUMS = ['trial_ends', 'now', 'guard_at', 'lease_until', 'ap_trial_ends'];
const NET_BOOLS = ['nm', 'carrier', 'profile_ok', 'pi_dhcp', 'wifi_off', 'ap_capable', 'ap_active'];
const PI_DHCP_NUMS = ['trial_ends', 'now', 'leases', 'modem_warn'];
const PI_DHCP_BOOLS = ['active', 'ipv6', 'port67', 'input_ok'];
const splitList = (s?: string) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
// Pi-hole şu an evin DHCP sunucusu mu (pihole.toml'dan okunur; FTL durmuşken de çalışır). Okunamazsa false.
async function piDhcpActive(): Promise<boolean> {
  if (!isLinux) return false;
  try { return (await execFileP('pihole-FTL', ['--config', 'dhcp.active'], { timeout: 5000 })).stdout.trim() === 'true'; } catch { return false; }
}
// Betik yoksa (eski kurulum / Pi dışı) isteği yanıtlayıp true döner.
const scriptMissing = (script: string, res: express.Response) => {
  if (isLinux && require('fs').existsSync(script)) return false;
  res.status(400).json({ error: isLinux ? `${script.split('/').pop()} bulunamadı — paneli güncelleyin` : 'Yalnız Pi5 üzerinde çalışır' });
  return true;
};
// Sabit adresin cihaz tarafı (ör. 192.168.0.1/24) → Pi DHCP planı: havuz <ağ>.20–<ağ>.139, ağ geçidi/DNS = Pi, maske.
// Havuz .139'a kadar uzandığı için ağ en az /24 olmalı.
const ipv4Num = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const numIpv4 = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
function dhcpPlanFromClient(cidr: string) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m || m[1].split('.').some(o => Number(o) > 255)) return null;
  const prefix = Number(m[2]);
  if (prefix < 16 || prefix > 24) return null;
  const size = 2 ** (32 - prefix);
  const net = Math.floor(ipv4Num(m[1]) / size) * size;
  return {
    ip: m[1], size, network: `${numIpv4(net)}/${prefix}`,
    start: numIpv4(net + 20), end: numIpv4(net + 139), netmask: numIpv4(2 ** 32 - size),
    contains: (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && Math.floor(ipv4Num(ip) / size) * size === net,
  };
}
// Bu adres Pi-hole'dan kira almış mı (/etc/pihole/dhcp.leases: "bitiş mac ip ad [client-id]").
const hasPiLease = (ip: string) => {
  try {
    return String(require('fs').readFileSync('/etc/pihole/dhcp.leases', 'utf8')).split('\n')
      .some((l: string) => { const p = l.trim().split(/\s+/); return /^\d+$/.test(p[0]) && p[2] === ip; });
  } catch { return false; }
};
// Adres bu IPv4 ağının (ör. 192.168.50.0/24) içinde mi.
const inIpv4Net = (ip: string, cidr: string) => {
  const [net, p] = cidr.split('/');
  const size = 2 ** (32 - Number(p));
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && Math.floor(ipv4Num(ip) / size) === Math.floor(ipv4Num(net) / size);
};
// Ağ değişikliğinden sonra kurallar güncel adreslere göre yeniden yazılır; betik zaman aşımına uğrayıp arka planda
// sürüyorsa bittiğinde yazılır.
const routingAfterNetChange = async (r: KvResult) => {
  const apply = () => applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
  if (r.code === null && r.exited) { void r.exited.then(apply); return; }
  await apply();
};

// Yazma işlemleri yalnız IP adresi / Pi'nin adlarıyla açılmış panelden (DNS rebinding sayfası ağı değiştiremesin).
const netAdminGuard = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && !trustedPanelHost(String(req.headers.host || ''))) {
    res.status(403).json({ error: await ipPanelHint() });
    return;
  }
  next();
};
app.use('/api/netmode', netAdminGuard);
app.use('/api/dhcp/pi', netAdminGuard);

app.get('/api/netmode/status', async (_req, res) => {
  if (!isLinux || !require('fs').existsSync(NET_MODE_SCRIPT)) return res.json({ supported: false });
  const r = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
  if (r.code !== 0) return res.json({ supported: true, error: kvError(r, 'sabit adres durumu okunamadı') });
  res.json({ ...kvTyped(r.kv, NET_NUMS, NET_BOOLS), supported: true });
});

// 3 dk'lık deneme: eth0'a tek profilde iki adres (modem tarafı + cihaz tarafı). Başarısız denemede betik eski profili
// geri getirmiştir; kurallar her iki durumda da güncel adreslere göre yeniden yazılır (idempotent, sıralı kuyruk).
app.post('/api/netmode/static', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['static', '--trial', String(NET_TRIAL_S), '--client', NET_CLIENT_CIDR], 120000);
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'sabit adres verilemedi') });
  res.json({ success: true, trial_ends: Number(r.kv.trial_ends) || 0 });
});

app.post('/api/netmode/confirm', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (isLoopbackClient(req.ip)) {
    return res.status(403).json({ error: 'Onayı başka bir cihazdan (PC/telefon) verin — Pi\'nin kendi ekranı ağ bağlantısını kanıtlamaz' });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['confirm'], 90000);
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  await routingAfterNetChange(r);
  res.json({ success: true });
});

app.post('/api/netmode/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['rollback'], 150000);
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Bilinçli olarak otomatik adrese (modemden DHCP) dönüş; Pi DHCP sunucusu açıkken betik reddeder.
app.post('/api/netmode/dhcp', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['dhcp'], 150000);
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'otomatik adrese dönülemedi') });
  res.json({ success: true });
});

// Pi'nin Wi-Fi'sini modem ağından ayırır / geri bağlar (Pi DHCP açıkken geri bağlama reddedilir).
app.post('/api/netmode/wifi', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled alanı true/false olmalı' });
  const r = await runKvScript(NET_MODE_SCRIPT, ['wifi', enabled ? 'on' : 'off'], 90000);
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, enabled ? 'Wi-Fi açılamadı' : 'Wi-Fi kapatılamadı') });
  res.json({ success: true });
});

// ─── Kurulum Wi-Fi'ı: Pi'nin kendi Wi-Fi kartından yayınlanan yönetim ağı (net-mode.sh ap …) ───
// Pi 192.168.50.1, telefonlar 192.168.50.20–200 alır; bu ağda internet YOK (yalnız panel). Telefon bağlanınca işletim
// sisteminin "ağa giriş yap" sayfası kendiliğinden /portal.html'i açar — modemin DHCP'si kapalıyken de panele ulaşma yolu.
// Açma her zaman 5 dk'lık denemedir; "Kalıcı yap" yalnız o ağa bağlı telefondan kabul edilir. Her değişiklikten sonra
// kurallar (07 DHCP dosyası, pi5_in, giriş sayfası yönlendirmesi, FTL yeniden başlatma) güncel duruma göre yazılır.
const AP_TRIAL_S = 300;
const AP_DEFAULT_SSID = 'Klyrix-Kurulum';
const AP_PORTAL_URL = `http://${AP_ADDR}/portal.html`;
// Betikle (net-mode.sh ap on) birebir aynı kurallar: ağ adı harf/rakam/boşluk/_.- (1–32); WPA2 şifresi 8–63 yazdırılabilir
// ASCII, ters bölü yok; ikisinde de başta/sonda boşluk yok.
const validApSsid = (s: string) => /^[A-Za-z0-9 _.-]{1,32}$/.test(s) && !/^ | $/.test(s);
const validApPassword = (s: string) => /^[\x20-\x5b\x5d-\x7e]{8,63}$/.test(s) && !/^ | $/.test(s);
// Şifre yalnız stdin'den verilir (argv/log'a girmez); bir araç hata metninde yine de yazarsa yanıtta maskelenir.
const maskSecret = (msg: string, secret: string) => (secret ? msg.split(secret).join('***') : msg);

// 5 dk'lık deneme: Pi'nin Wi-Fi'si ev ağından ayrılıp kurulum Wi-Fi'ını yayınlar. Başarısız denemede betik eski Wi-Fi
// ayarını geri getirmiştir; kurallar her iki durumda da yeniden yazılır.
app.post('/api/netmode/ap', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const rawSsid = req.body?.ssid;
  const ssid = rawSsid === undefined || rawSsid === null || rawSsid === '' ? AP_DEFAULT_SSID : rawSsid;
  const password = req.body?.password;
  if (typeof ssid !== 'string' || !validApSsid(ssid)) {
    return res.status(400).json({ error: 'Ağ adı 1-32 karakter olmalı: harf (Türkçe harf olmadan), rakam, boşluk, _ . - ; başta/sonda boşluk olmadan' });
  }
  if (typeof password !== 'string' || !validApPassword(password)) {
    return res.status(400).json({ error: 'Wi-Fi şifresi 8-63 karakter olmalı: Türkçe harf (ç ğ ı ö ş ü) ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['ap', 'on', '--trial', String(AP_TRIAL_S), '--ssid', ssid], 180000, `${password}\n`);
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(500).json({ error: maskSecret(kvError(r, 'kurulum Wi-Fi\'ı açılamadı'), password) });
  res.json({ success: true, ap_trial_ends: Number(r.kv.ap_trial_ends) || 0 });
});

// "Kalıcı yap" yalnız kurulum Wi-Fi'ına bağlı bir cihazdan kabul edilir — yayının, DHCP'nin ve giriş sayfasının gerçekten
// çalıştığının kanıtı (Pi'nin kendi ekranı ya da ev ağındaki bir bilgisayar bunu kanıtlamaz).
app.post('/api/netmode/ap/confirm', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (!inIpv4Net(ip, AP_NET)) {
    const st = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
    const ssid = (st.code === 0 && st.kv.ap_ssid) || AP_DEFAULT_SSID;
    return res.status(403).json({ error: `Onayı kurulum Wi-Fi'ına bağlı telefondan verin: telefonu '${ssid}' ağına bağlayın, açılan sayfadan panele girip bu karttan 'Kalıcı yap'a basın` });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['ap', 'confirm'], 90000);
  // Onay reddedildiyse deneme o an geri alınmış olabilir: kurallar her durumda güncel duruma göre yazılır.
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  res.json({ success: true });
});

app.post('/api/netmode/ap/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['ap', 'rollback'], 150000);
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Bilinçli kapatma (kalıcı ya da deneme): yayın kalkar, Pi'nin Wi-Fi'si kapalı kalır (ev ağına kendiliğinden dönmez).
app.post('/api/netmode/ap/off', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['ap', 'off'], 150000);
  await routingAfterNetChange(r);
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'kurulum Wi-Fi\'ı kapatılamadı') });
  // Yayın kalktı ama Wi-Fi kapatılamadıysa (warning=…) arayüz bunu gösterir: Pi'nin Wi-Fi'si ev ağına dönebilir.
  res.json({ success: true, warning: r.kv.warning || undefined });
});

// RFC 8908 giriş sayfası API'si: kurulum Wi-Fi'ının DHCP yanıtı (seçenek 114) bu adresi verir; telefon ağın giriş
// istediğini ve sayfanın adresini buradan öğrenir. nginx bu yolu şifresiz bırakır (salt okunur, sabit yanıt).
app.get('/api/captive', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/captive+json');
  res.json({ captive: true, 'user-portal-url': AP_PORTAL_URL });
});

// Ağda başka DHCP sunucusu var mı: keşif paketi gönderilir, kira alınmaz. own = Pi'nin kendi yanıtı.
app.post('/api/dhcp/pi/probe', async (_req, res) => {
  if (scriptMissing(PI_DHCP_SCRIPT, res)) return;
  const r = await runKvScript(PI_DHCP_SCRIPT, ['probe'], 30000);
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'DHCP taraması yapılamadı') });
  res.json({ servers: splitList(r.kv.servers), own: splitList(r.kv.own) });
});

// 5 dk'lık deneme (kira 5 dk): havuz ve ağ geçidi sabit adresin cihaz tarafından türetilir.
app.post('/api/dhcp/pi/enable', async (_req, res) => {
  if (scriptMissing(PI_DHCP_SCRIPT, res)) return;
  try {
    const st = readNetModeState();
    if (!st || st.stage !== 'static') return res.status(409).json({ error: 'Önce Pi\'ye sabit adres verin ve "kalıcı yap" ile onaylayın' });
    const plan = dhcpPlanFromClient(st.client);
    if (!plan) return res.status(409).json({ error: `Cihaz tarafı adresi DHCP havuzu için uygun değil (${st.client || '?'}) — /16–/24 bir ağ gerekli` });
    const r = await runPiDhcpExclusive([
      'enable', '--trial', String(DHCP_TRIAL_S), '--start', plan.start, '--end', plan.end, '--router', plan.ip,
      '--netmask', plan.netmask, '--lease', '5m',
    ], 240000);
    // warning=modem_dhcp: deneme başladıktan sonra düştü (ayarlar geri yüklendi) → modemin DHCP'si hemen açılmalı.
    if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'Pi DHCP açılamadı'), warning: r.kv.warning || undefined });
    res.json({ success: true, trial_ends: Number(r.kv.trial_ends) || 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// "Kalıcı yap" ancak Pi'den gerçekten kira almış bir cihazdan gelirse kabul edilir — DHCP'nin çalıştığının kanıtı.
app.post('/api/dhcp/pi/confirm', async (req, res) => {
  if (scriptMissing(PI_DHCP_SCRIPT, res)) return;
  try {
    const st = readNetModeState();
    const plan = st && st.stage === 'static' ? dhcpPlanFromClient(st.client) : null;
    if (!plan) return res.status(409).json({ error: 'Pi\'nin sabit adresi yok — önce 1. adımı tamamlayın' });
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!plan.contains(ip) || !hasPiLease(ip)) {
      // Kurulum Wi-Fi'ındaki telefon da Pi'den adres alır ama ev ağında değildir: evdeki DHCP'nin çalıştığını kanıtlamaz.
      if (!plan.contains(ip) && inIpv4Net(ip, AP_NET)) {
        return res.status(403).json({ error: `Bu onay ev ağından verilmeli: telefonu kurulum Wi-Fi'ından çıkarıp ev Wi-Fi'ına bağlayın, sonra http://${plan.ip}/#dhcp adresini (menü → Pi-hole DNS → DHCP Ayarları) açıp onaylayın` });
      }
      return res.status(403).json({ error: `Onayı Pi'den adres almış bir cihazdan verin: telefonun Wi-Fi'ını kapatıp açın, sonra http://${plan.ip}/#dhcp adresini (menü → Pi-hole DNS → DHCP Ayarları) açıp onaylayın` });
    }
    const r = await runPiDhcpExclusive(['confirm', '--lease', '12h'], 240000);
    // Onay başarısız olup deneme hemen geri alındıysa (warning=modem_dhcp) arayüz "modemin DHCP'sini geri açın" der.
    if (r.code !== 0) {
      return res.status(409).json({ error: kvError(r, 'onaylanamadı'), warning: r.kv.warning || undefined, rolled_back: r.kv.rolled_back === '1' });
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Geri al: dhcp.active önce kapatılır, diğer ayarlar ilk hâline döner. warning=modem_dhcp → arayüz "modemin DHCP'sini
// hemen geri açın" der.
app.post('/api/dhcp/pi/rollback', async (_req, res) => {
  if (scriptMissing(PI_DHCP_SCRIPT, res)) return;
  try {
    const r = await runPiDhcpExclusive(['rollback'], 240000);
    if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
    res.json({ success: true, rolled_back: r.kv.rolled_back === '1', warning: r.kv.warning || undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Modeme geri dönüş: force olmadan betik önce modemin DHCP'sinin yanıt verdiğini doğrular.
app.post('/api/dhcp/pi/disable', async (req, res) => {
  if (scriptMissing(PI_DHCP_SCRIPT, res)) return;
  try {
    const force = req.body?.force === true;
    const r = await runPiDhcpExclusive(force ? ['disable', '--force'] : ['disable'], 240000);
    if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'Pi DHCP kapatılamadı') });
    res.json({ success: true, warning: r.kv.warning || undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// "Modemin DHCP'sini geri açın" uyarısı (Pi'de kalıcı, modem_warn) — kullanıcı modemi açtığını onaylayınca kalkar.
app.post('/api/dhcp/pi/ack', async (_req, res) => {
  if (scriptMissing(PI_DHCP_SCRIPT, res)) return;
  const r = await runKvScript(PI_DHCP_SCRIPT, ['ack'], 90000);
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'uyarı kaldırılamadı') });
  res.json({ success: true });
});

// ─── Backup & Restore ───
// Tek kaynak: hem export hem import bu listeyi kullanır (import/export uyuşmazlığı = veri kaybı).
// Sır içeren tablolar (vps_servers/wg_clients — SSH parolası, WG özel anahtarı) kasıtlı hariç.
const BACKUP_TABLES = [
  'service_config', 'service_status', 'traffic_routing', 'domain_routing', 'routing_rules',
  'pihole_lists', 'zapret_domains', 'bandwidth_limits', 'parental_rules', 'traffic_schedules',
  'device_groups', 'device_group_members', 'throttle_rules', 'app_settings', 'cron_jobs', 'dhcp_leases',
  'domain_suggestion_dismissed',
];
const BACKUP_TABLE_SET = new Set(BACKUP_TABLES);

async function restoreTable(table: string, rows: any[]): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let n = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const cols = Object.keys(row).filter(c => /^[a-zA-Z0-9_]+$/.test(c));
    if (!cols.length) continue;
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    await dbRun(sql, cols.map(c => row[c]));
    n++;
  }
  return n;
}

app.get('/api/backup/export', async (_req, res) => {
  try {
    const configTables: Record<string, any[]> = {};
    for (const t of BACKUP_TABLES) {
      configTables[t] = t === 'dhcp_leases'
        ? await dbAll('SELECT * FROM dhcp_leases WHERE is_static = 1')
        : await dbAll(`SELECT * FROM ${t}`);
    }

    res.json({
      backup_version: 2,
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

    // Export edilen TÜM tabloları tek transaction içinde geri yükle (kısmi hata = rollback).
    let restored = 0;
    await dbRun('BEGIN');
    try {
      for (const table of BACKUP_TABLES) {
        if (!BACKUP_TABLE_SET.has(table)) continue; // whitelist güvencesi
        if (!data[table]) continue;
        restored += await restoreTable(table, data[table]);
      }
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      throw err;
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
    // exit_node/dpi_bypass modeli (frontend bunları gönderir); route_type geriye-uyum için opsiyonel.
    const { traffic_routing_id, schedule_exit_node, schedule_dpi_bypass, schedule_route_type, schedule_vps_id, time_start, time_end, days_of_week, enabled } = req.body;
    if (!traffic_routing_id || !time_start || !time_end) {
      return res.status(400).json({ error: 'traffic_routing_id, time_start ve time_end gerekli' });
    }
    const exitNode = schedule_exit_node ?? schedule_route_type ?? 'isp';
    const vpsId = schedule_vps_id ?? (exitNode !== 'isp' && exitNode !== 'blocked' ? Number(exitNode) || null : null);
    await dbRun(
      `INSERT INTO traffic_schedules
         (traffic_routing_id, schedule_route_type, schedule_exit_node, schedule_dpi_bypass, schedule_vps_id, time_start, time_end, days_of_week, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [traffic_routing_id, schedule_route_type ?? exitNode, exitNode, schedule_dpi_bypass ? 1 : 0, vpsId, time_start, time_end, days_of_week || '', enabled !== undefined ? (enabled ? 1 : 0) : 1]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/routing/schedules/:id', async (req, res) => {
  try {
    const { enabled, schedule_exit_node, schedule_dpi_bypass, time_start, time_end, days_of_week } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (schedule_exit_node !== undefined) { updates.push('schedule_exit_node = ?'); params.push(schedule_exit_node); }
    if (schedule_dpi_bypass !== undefined) { updates.push('schedule_dpi_bypass = ?'); params.push(schedule_dpi_bypass ? 1 : 0); }
    if (time_start !== undefined) { updates.push('time_start = ?'); params.push(time_start); }
    if (time_end !== undefined) { updates.push('time_end = ?'); params.push(time_end); }
    if (days_of_week !== undefined) { updates.push('days_of_week = ?'); params.push(days_of_week); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE traffic_schedules SET ${updates.join(', ')} WHERE id = ?`, params);
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
    const id = await dbInsert('INSERT INTO device_groups (name, description, color, icon) VALUES (?, ?, ?, ?)',
      [name, description || '', color || '#3B82F6', icon || 'devices']);
    res.json({ success: true, id });
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
// Engellenemeyecek MAC'ler: Pi'nin kartları + modem. Modemin MAC'i komşu önbelleğinden gelmezse (bağlantı yeni kalktı)
// cihaz tablosunda IP'si ağ geçidi ya da Pi olan satırlar da korunur — koruma "bilinmiyor" durumunda açık kalmasın.
async function blockProtectedMacs(): Promise<Set<string>> {
  const set = await protectedMacs();
  const id = await getLanIdentity();
  // Sabit adres modunda Pi'nin iki adresi (modem tarafı + cihaz tarafı) de korunur.
  const ips = [...new Set([id?.gateway, id?.ip, id?.transit?.ip, ...(id?.secondary || []).map(s => s.ip)].filter(Boolean))] as string[];
  if (ips.length) {
    const rows = await dbAll(`SELECT mac_address FROM devices WHERE ip_address IN (${ips.map(() => '?').join(',')})`, ips);
    for (const r of rows as any[]) set.add(String(r.mac_address).toLowerCase());
  }
  return set;
}
// Uygulanacak engel listesi: DB'deki engelliler, korunan MAC'ler çıkarılarak (eski sürümde modem engellenmiş olsa bile
// açılışta tüm evin internetini kesmesin). override: bu isteğin yeni durumu (DB'ye ancak uygulama başarılıysa yazılır).
async function blockList(override?: { mac: string; blocked: boolean }): Promise<string[]> {
  const rows = await dbAll('SELECT mac_address FROM devices WHERE blocked = 1');
  const macs = new Set((rows as any[]).map(d => String(d.mac_address).toLowerCase()));
  if (override) { if (override.blocked) macs.add(override.mac.toLowerCase()); else macs.delete(override.mac.toLowerCase()); }
  const prot = await blockProtectedMacs();
  const skipped = [...macs].filter(m => prot.has(m));
  if (skipped.length) console.warn(`[devices] korunan MAC engellenmedi (modem/Pi): ${skipped.join(', ')}`);
  return [...macs].filter(m => !prot.has(m));
}
// DB'deki engelli cihazları nft'ye yeniden yükler (açılış, nftables restart). Hata loglanır, açılışı durdurmaz.
async function reapplyBlockedDevices(): Promise<void> {
  if (!isLinux) return;
  try {
    await applyBlockedDevices(await blockList());
  } catch (e: any) {
    console.error('[devices] engeller yeniden uygulanamadı:', e?.message || e);
  }
}

// İstemci istenen durumu ({ blocked: true|false }) gönderir; gönderilmezse eski davranış (tersine çevir). Engel yalnız
// internete Pi üzerinden çıkan cihazlarda etkilidir (nft forward). Modem ve Pi'nin kendi kartları engellenemez.
app.post('/api/devices/:mac/block', async (req, res) => {
  try {
    const device = await dbGet('SELECT * FROM devices WHERE mac_address = ?', [req.params.mac]);
    if (!device) {
      return res.status(404).json({ error: 'Cihaz bulunamadı' });
    }
    const want = typeof req.body?.blocked === 'boolean' ? req.body.blocked : !device.blocked;
    if (want && (await blockProtectedMacs()).has(String(device.mac_address).toLowerCase())) {
      return res.status(400).json({ error: 'Modem ya da Pi\'nin kendisi engellenemez (tüm ağın interneti kesilir)' });
    }
    const newStatus = want ? 1 : 0;
    // Önce nft'ye uygula, başarılıysa DB'ye yaz: uygulanamayan engel panelde "engelli" görünmesin.
    await applyBlockedDevices(await blockList({ mac: String(device.mac_address), blocked: want }));
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
    res.json({ events: history });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── New Device Alerts / Known Devices ───
app.get('/api/devices/unknown', async (_req, res) => {
  try {
    const unknown = await dbAll(`
      SELECT k.mac_address, k.first_seen, k.approved,
             d.ip_address, d.hostname, d.last_seen
      FROM known_devices k
      LEFT JOIN devices d ON k.mac_address = d.mac_address
      WHERE k.approved = 0
      ORDER BY k.first_seen DESC
    `);
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
    // Hız testi aralığı değiştiyse zamanlayıcıyı restart'sız yeniden planla
    if (Object.prototype.hasOwnProperty.call(settings, 'speedtest_interval_min')) {
      rescheduleSpeedtest().catch(() => {});
    }
    res.json({ success: true, message: 'Ayarlar güncellendi.' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SSH Terminal (unrestricted — login will be added at app level) ───
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

// ─── Fail2Ban Status ───
app.get('/api/fail2ban/status', async (_req, res) => {
  try {
    const status = await getFail2banStatus();
    if (!status) return res.json({ jails: [], recentBans: [] });

    // Get recent bans from fail2ban log
    const recentBans: { ip: string; jail: string; time: string }[] = [];
    if (isLinux) {
      const exec = require('util').promisify(require('child_process').exec);
      try {
        const { stdout } = await exec(
          "grep 'Ban ' /var/log/fail2ban.log 2>/dev/null | tail -20 | awk '{print $1\" \"$2, $6, $NF}'",
          { timeout: 5000 }
        );
        stdout.trim().split('\n').filter(Boolean).reverse().forEach((line: string) => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const time = parts[0] || '';
            const jail = (parts[1] || '').replace(/[[\]]/g, '');
            const ip = parts[parts.length - 1] || '';
            if (ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
              recentBans.push({ ip, jail, time });
            }
          }
        });
      } catch { /* log may not exist */ }
    }

    res.json({ ...status, recentBans });
  } catch (e: any) {
    res.json({ jails: [], recentBans: [], error: e.message });
  }
});

// ─── Unbound Status ───
app.get('/api/unbound/status', async (_req, res) => {
  try {
    if (!isLinux) return res.json({ stats: null, security: [] });
    const exec = require('util').promisify(require('child_process').exec);

    // Get unbound stats
    let stats: any = {};
    try {
      const { stdout } = await exec('unbound-control stats_noreset 2>/dev/null', { timeout: 5000 });
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const [key, val] = line.split('=');
        if (key && val) stats[key.trim()] = val.trim();
      }
    } catch { /* unbound-control may not be available */ }

    // Get listening address from config
    let listenAddr = '127.0.0.1:5335';
    try {
      const { stdout } = await exec("grep -E '^\\s*(interface|port):' /etc/unbound/unbound.conf 2>/dev/null | head -4", { timeout: 3000 });
      const ifMatch = stdout.match(/interface:\s*(\S+)/);
      const portMatch = stdout.match(/port:\s*(\d+)/);
      if (ifMatch) listenAddr = ifMatch[1] + ':' + (portMatch ? portMatch[1] : '5335');
    } catch { /* */ }

    // Check security features from config
    const security: { label: string; status: boolean }[] = [];
    try {
      const { stdout: conf } = await exec('cat /etc/unbound/unbound.conf /etc/unbound/unbound.conf.d/*.conf 2>/dev/null', { timeout: 3000 });
      security.push({ label: 'DNSSEC Doğrulama', status: /auto-trust-anchor-file|trust-anchor-file/.test(conf) });
      security.push({ label: 'Kimlik Gizleme', status: /hide-identity:\s*yes/.test(conf) });
      security.push({ label: 'Sürüm Gizleme', status: /hide-version:\s*yes/.test(conf) });
      security.push({ label: 'Glue Sıkılaştırma', status: /harden-glue:\s*yes/.test(conf) });
      security.push({ label: 'Caps-for-ID (0x20)', status: /use-caps-for-id:\s*yes/.test(conf) });
      security.push({ label: 'Ek Kayıt Temizleme', status: /harden-additional-queries:\s*yes|aggressive-nsec:\s*yes/.test(conf) });
    } catch {
      // Default: unknown
      ['DNSSEC Doğrulama', 'Kimlik Gizleme', 'Sürüm Gizleme', 'Glue Sıkılaştırma', 'Caps-for-ID (0x20)', 'Ek Kayıt Temizleme']
        .forEach(label => security.push({ label, status: false }));
    }

    // Thread count and cache
    const threads = stats['num.threads'] || '1';
    const cacheCount = stats['msg.cache.count'] || '0';
    const cacheMax = stats['msg.cache.max_collisions'] || '';

    res.json({
      listenAddr,
      threads,
      cacheEntries: cacheCount,
      totalQueries: stats['total.num.queries'] || '0',
      security,
    });
  } catch (e: any) {
    res.json({ stats: null, security: [], error: e.message });
  }
});

// ─── DDNS ───
// Sırlar (parola, token; özel sağlayıcıda sır içerebilen URL) yanıtlarda maskelenir. Düzenleme formu maskeyi geri
// gönderirse "değişmedi" sayılır ve saklı değer korunur; sağlayıcıya giden değer her zaman DB'den okunur.
const DDNS_MASK = '••••••••';
const DDNS_SECRET_FIELDS = ['password', 'token'] as const;
function publicDdns(row: any) {
  if (!row) return row;
  const out: any = { ...row };
  for (const f of DDNS_SECRET_FIELDS) {
    out[`has_${f}`] = !!row[f];
    out[f] = row[f] ? DDNS_MASK : '';
  }
  // Özel sağlayıcının URL'si (ya da sağlayıcı değiştirilse de alanda kalan herhangi bir URL) sır içerebilir.
  if (row.domain && (String(row.provider || '').toLowerCase() === 'custom' || String(row.domain).includes('://'))) {
    let host = '';
    try { host = new URL(String(row.domain)).hostname; } catch { /* geçersiz URL */ }
    out.domain = DDNS_MASK;
    out.domain_display = host || 'özel URL';
  }
  return out;
}
const ddnsList = async () => (await dbAll('SELECT * FROM ddns_configs ORDER BY id')).map(publicDdns);
app.use('/api/ddns', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/ddns/configs', async (_req, res) => {
  try {
    res.json({ configs: await ddnsList() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ddns/configs', async (req, res) => {
  try {
    const { provider, hostname, username, password, token, domain, update_interval_min } = req.body;
    if (!provider || !hostname) return res.status(400).json({ error: 'provider ve hostname gerekli' });
    const unmask = (v: unknown) => (v === DDNS_MASK ? '' : v || '');
    await dbRun(
      'INSERT INTO ddns_configs (provider, hostname, username, password, token, domain, update_interval_min) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [provider, hostname, username || '', unmask(password), unmask(token), unmask(domain), update_interval_min || 5]
    );
    res.json({ success: true, configs: await ddnsList() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/ddns/configs/:id', async (req, res) => {
  try {
    // Partial-merge: yalnızca gönderilen alanları güncelle (toggle'ın kimlik bilgilerini silmesini önler).
    // Maskeli değer = "değişmedi" (saklı sır korunur); boş dize alanı siler.
    const body = req.body || {};
    const updates: string[] = [];
    const params: any[] = [];
    for (const field of ['provider', 'hostname', 'username', 'password', 'token', 'domain', 'update_interval_min']) {
      if (body[field] === undefined || body[field] === DDNS_MASK) continue;
      updates.push(`${field} = ?`); params.push(body[field]);
    }
    if (body.enabled !== undefined) { updates.push('enabled = ?'); params.push(body.enabled ? 1 : 0); }
    if (updates.length > 0) {
      params.push(req.params.id);
      await dbRun(`UPDATE ddns_configs SET ${updates.join(', ')} WHERE id = ?`, params);
    }
    res.json({ success: true, configs: await ddnsList() });
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

// ─── DDNS Provider Update Functions ───
// curl kabuksuz çalışır ve URL/başlıklar/gövde argv'ye DEĞİL stdin'den config olarak (-K -) verilir: token ve Basic
// kimlik /proc/<pid>/cmdline'da ve Node'un "Command failed: …" hata mesajında (→ journald, test yanıtı) görünmez.
// Hata mesajı yalnız curl çıkış kodunu taşır. URL sorgu değerleri percent-encoded.
interface CurlRequest { url: string; headers?: string[]; method?: string; data?: string }
const curlQuote = (v: string) => `"${v.replace(/[\r\n]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
function curlGet(req: CurlRequest): Promise<string> {
  const config = [
    `url = ${curlQuote(req.url)}`,
    ...(req.headers || []).map(h => `header = ${curlQuote(h)}`),
    ...(req.method ? [`request = ${curlQuote(req.method)}`] : []),
    ...(req.data !== undefined ? [`data = ${curlQuote(req.data)}`] : []),
  ].join('\n') + '\n';
  return new Promise((resolve, reject) => {
    const child = _spawn('curl', ['-s', '--max-time', '10', '-K', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
    child.stdout.on('data', d => { if (out.length < 65536) out += d; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('curl çalıştırılamadı')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('zaman aşımı'));
      if (code !== 0) return reject(new Error(`bağlantı hatası (curl çıkış kodu ${code})`));
      resolve(out.trim());
    });
    child.stdin.end(config);
  });
}

async function updateDdnsProvider(config: any, ip: string): Promise<{ success: boolean; message: string }> {
  const provider = (config.provider || '').toLowerCase();
  const enc = encodeURIComponent;

  try {
    if (provider === 'duckdns') {
      // DuckDNS: https://www.duckdns.org/spec.jsp
      const subdomain = String(config.hostname || '').replace('.duckdns.org', '');
      const url = `https://www.duckdns.org/update?domains=${enc(subdomain)}&token=${enc(config.token || '')}&ip=${enc(ip)}`;
      const result = await curlGet({ url });
      if (result === 'OK') return { success: true, message: 'DuckDNS güncellendi' };
      return { success: false, message: `DuckDNS yanıtı: ${result}` };

    } else if (provider === 'noip' || provider === 'no-ip') {
      const url = `https://dynupdate.no-ip.com/nic/update?hostname=${enc(config.hostname || '')}&myip=${enc(ip)}`;
      const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
      const result = await curlGet({ url, headers: [`Authorization: Basic ${auth}`] });
      if (result.startsWith('good') || result.startsWith('nochg')) return { success: true, message: `No-IP: ${result}` };
      return { success: false, message: `No-IP yanıtı: ${result}` };

    } else if (provider === 'cloudflare') {
      const zoneId = enc(config.domain || ''); // Zone ID stored in domain field
      const listOut = await curlGet({
        url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${enc(config.hostname || '')}`,
        headers: [`Authorization: Bearer ${config.token}`, 'Content-Type: application/json'],
      });
      const listData = JSON.parse(listOut);
      if (!listData.success || !listData.result?.[0]) return { success: false, message: 'Cloudflare DNS kaydı bulunamadı' };
      const recordId = enc(listData.result[0].id);
      const body = JSON.stringify({ type: 'A', name: config.hostname, content: ip, ttl: 300 });
      const updateOut = await curlGet({
        url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
        method: 'PUT', headers: [`Authorization: Bearer ${config.token}`, 'Content-Type: application/json'], data: body,
      });
      const updateData = JSON.parse(updateOut);
      if (updateData.success) return { success: true, message: 'Cloudflare güncellendi' };
      return { success: false, message: `Cloudflare hatası: ${JSON.stringify(updateData.errors)}` };

    } else if (provider === 'dynu') {
      const url = `https://api.dynu.com/nic/update?hostname=${enc(config.hostname || '')}&myip=${enc(ip)}`;
      const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
      const result = await curlGet({ url, headers: [`Authorization: Basic ${auth}`] });
      if (result.startsWith('good') || result.startsWith('nochg')) return { success: true, message: `Dynu: ${result}` };
      return { success: false, message: `Dynu yanıtı: ${result}` };

    } else if (provider === 'custom') {
      // Custom URL with placeholders
      let url = String(config.domain || '');
      url = url.replace('{ip}', ip).replace('{hostname}', String(config.hostname || ''));
      if (!/^https?:\/\//i.test(url)) return { success: false, message: 'Custom URL http(s):// ile başlamalı' };
      const headers = (config.username && config.password)
        ? [`Authorization: Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`]
        : [];
      // URL config'te tırnaklı `url =` satırı: "-" ile başlasa da seçenek sayılmaz
      const out = await curlGet({ url, headers });
      return { success: true, message: `Custom: ${out.slice(0, 100)}` };

    } else {
      return { success: false, message: `Bilinmeyen provider: ${provider}` };
    }
  } catch (e: any) {
    // curlGet hataları sır taşımaz; JSON.parse gibi diğerleri sağlayıcı cevabından gelir. Yine de ek güvence olarak maskelenir.
    return { success: false, message: redactSecrets(e.message || 'Bağlantı hatası') };
  }
}

// Günlüğe / yanıta gidecek metinde URL'deki token=…, Authorization başlığı ve kullanıcı:şifre@ biçimlerini maskeler.
function redactSecrets(s: string): string {
  return String(s)
    .replace(/((?:token|key|password|pass|secret|api_key|apikey)=)[^&\s"']+/gi, '$1***')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi, '$1***')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@');
}

// DDNS auto-update: check IP and update all enabled configs
async function ddnsAutoUpdate(): Promise<void> {
  try {
    const configs: any[] = await dbAll('SELECT * FROM ddns_configs WHERE enabled = 1');
    if (configs.length === 0) return;

    const { ip: currentIp } = await getCurrentExternalIp();
    if (!currentIp) return;

    // Track IP changes
    const lastEntry: any = await dbGet('SELECT * FROM ddns_ip_history ORDER BY detected_at DESC LIMIT 1');
    if (lastEntry?.ip !== currentIp) {
      await dbRun('INSERT INTO ddns_ip_history (ip, source) VALUES (?, ?)', [currentIp, 'auto']);
    }

    const now = new Date();
    for (const config of configs) {
      // Check if update interval has elapsed
      const lastUpdate = config.last_update ? new Date(config.last_update) : new Date(0);
      const intervalMs = (config.update_interval_min || 5) * 60 * 1000;
      if (now.getTime() - lastUpdate.getTime() < intervalMs && config.last_ip === currentIp) continue;

      // IP changed or interval elapsed — update provider
      const result = await updateDdnsProvider(config, currentIp);
      await dbRun(
        'UPDATE ddns_configs SET status = ?, last_ip = ?, last_update = datetime(?) WHERE id = ?',
        [result.success ? 'active' : 'error', currentIp, now.toISOString(), config.id]
      );
      console.log(`[DDNS] ${config.provider}/${config.hostname}: ${result.message}`);
    }
  } catch (e: any) {
    console.error('[DDNS] Auto-update hatası:', e.message);
  }
}

// Start DDNS cron: every 5 minutes
setInterval(ddnsAutoUpdate, 5 * 60 * 1000);
// Run once at startup after 30s
setTimeout(ddnsAutoUpdate, 30000);

app.post('/api/ddns/configs/:id/test', async (req, res) => {
  try {
    const { ip: currentIp } = await getCurrentExternalIp();
    const config = await dbGet('SELECT * FROM ddns_configs WHERE id = ?', [req.params.id]);
    if (!config) return res.status(404).json({ error: 'Config bulunamadı' });

    // Actually call the provider
    const result = await updateDdnsProvider(config, currentIp);
    await dbRun('UPDATE ddns_configs SET status = ?, last_ip = ?, last_update = datetime(?) WHERE id = ?',
      [result.success ? 'active' : 'error', currentIp, new Date().toISOString(), req.params.id]);
    const updated = await dbGet('SELECT * FROM ddns_configs WHERE id = ?', [req.params.id]);
    res.json({ success: result.success, message: result.message, config: publicDdns(updated), detected_ip: currentIp });
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
    const { ip: currentIp } = await getCurrentExternalIp();
    const lastEntry = await dbGet('SELECT * FROM ddns_ip_history ORDER BY detected_at DESC LIMIT 1');
    const oldIp = lastEntry?.ip || '';
    const changed = currentIp && currentIp !== oldIp;

    if (changed) {
      await dbRun('INSERT INTO ddns_ip_history (ip, source) VALUES (?, ?)', [currentIp, 'manual']);
    }

    // Trigger provider updates for all enabled configs
    await ddnsAutoUpdate();

    res.json({ changed: !!changed, old_ip: oldIp, new_ip: currentIp || oldIp });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Case LED / LCD Control ───

// SunFounder's Pironman software runs a service that continuously drives the case OLED + RGB.
// When active, our one-shot LED/LCD writes get overwritten. Detect it so the UI can warn.
async function detectPironmanConflict(): Promise<string> {
  if (!isLinux) return '';
  try {
    const exec = require('util').promisify(require('child_process').exec);
    const { stdout } = await exec('systemctl is-active pironman5 pironman pm_auto 2>/dev/null || true', { timeout: 3000 }).catch(() => ({ stdout: '' }));
    if (String(stdout).split('\n').some((s: string) => s.trim() === 'active')) {
      return 'SunFounder Pironman servisi (pironman5) kasa RGB\'sini sürüyor ve modülü otomatik bırakılamadı; panel ayarlarının üzerine yazabilir. Elle deneyin: "sudo pironman5 -re 0" (RGB modülünü bırakır, fan/güç yönetimi pironman5\'te kalır). Çare olmazsa "sudo systemctl stop pironman5".';
    }
  } catch { /* */ }
  return '';
}

// SunFounder pironman5'in tek bir donanım modülünü bırakmasını sağlar; ayar SunFounder
// config'ine kalıcı yazılır, fan/güç yönetimi pironman5'te kalır. OLED için bunu pi5-lcd
// unit'i ExecStartPre ile yapıyor; RGB için LED'e yazmadan hemen önce burada yapılır —
// yoksa pironman5 bizim yazdığımız rengin üzerine kendi animasyonunu bindirir.
// pironman5 kurulu değilse / bayrak desteklenmiyorsa false döner (davranış değişmez).
async function releasePironmanModule(): Promise<boolean> {
  if (!isLinux) return false;
  try {
    const exec = require('util').promisify(require('child_process').exec);
    // Script config'i yazar ve gerçekten değiştiyse pironman5'i yeniler — yalnızca
    // dosyaya yazmak yetmiyor, çalışan servis config'i başlangıçta okuyor.
    await exec('/bin/sh /opt/pi5-gateway/scripts/pironman_release.sh', { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// Ensure the persistent LCD systemd service exists (self-heals already-deployed installs). The
// daemon runs `lcd_display.py run` in the foreground and restarts on failure, so the case OLED
// keeps cycling across reboots and backend restarts instead of dying after a single apply.
async function ensureLcdService(): Promise<void> {
  if (!isLinux) return;
  const fs = require('fs');
  const exec = require('util').promisify(require('child_process').exec);
  const UNIT = '/etc/systemd/system/pi5-lcd.service';
  const content = `[Unit]
Description=Pi5 Gateway Case LCD
After=pi5-backend.service
Wants=pi5-backend.service

[Service]
Type=simple
# SunFounder pironman5 aynı OLED'i / RGB'yi sürerse iki proses çakışır (ekran üst üste
# biner, LED rengi ezilir). Script modülleri bıraktırır ve gerekiyorsa pironman5'i
# yeniler; ayrıntı scripts/pironman_release.sh içinde. '-' öneki: script yoksa hata yut.
ExecStartPre=-/bin/sh /opt/pi5-gateway/scripts/pironman_release.sh
ExecStart=/usr/bin/python3 /opt/pi5-gateway/scripts/lcd_display.py run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
  try {
    let existing = '';
    try { existing = fs.readFileSync(UNIT, 'utf8'); } catch { /* */ }
    if (existing !== content) {
      fs.writeFileSync(UNIT, content);
      await exec('systemctl daemon-reload', { timeout: 5000 });
    }
    await exec('systemctl enable pi5-lcd.service 2>/dev/null || true', { timeout: 5000 });
  } catch { /* */ }
}

app.get('/api/case/led', async (_req, res) => {
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'led_config'");
    const config = row?.value ? JSON.parse(row.value) : { color: '#3b82f6', brightness: 80, animation: 'static', enabled: true };
    // Eski kayıtlarda desteklenmeyen ad olabilir ('solid'); panelde hiçbir animasyon
    // seçili görünmemesine yol açıyordu.
    config.animation = normalizeAnimation(config.animation);
    res.json({ config });
  } catch { res.json({ config: { color: '#3b82f6', brightness: 80, animation: 'static', enabled: true } }); }
});

// LED'i donanıma uygula. Hem PUT hem backend açılışı bu yolu kullanır; açılışta çağrılması
// kullanıcının seçimini reboot / servis restart sonrası korur. Aksi halde tek seferlik bir
// yazma kalıyordu ve pironman5 RGB'yi ilk fırsatta geri açıyordu.
async function applyLedConfig(cfg: any): Promise<{ applied: boolean; output?: string; error?: string; warning?: string }> {
  if (!isLinux) return { applied: false, warning: 'LED kontrolü sadece Pi5 üzerinde çalışır' };
  const enabled = cfg?.enabled !== false;
  const script = '/opt/pi5-gateway/scripts/led_control.py';
  const args = enabled
    ? [script, 'set', String(cfg?.color ?? '#3b82f6'),
       String(Math.round(Number(cfg?.brightness) || 0)), normalizeAnimation(cfg?.animation)]
    : [script, 'off'];
  // Önce SunFounder'ın RGB modülünü bırak, sonra yaz — sırası tersse rengimiz eziliyor.
  const released = await releasePironmanModule();
  try {
    const { stdout, stderr } = await execFileP('python3', args, { timeout: 10000 });
    const warning = released ? '' : await detectPironmanConflict();
    return { applied: !warning, output: stdout.trim(), error: stderr.trim() || undefined, warning: warning || undefined };
  } catch (cmdErr: any) {
    return { applied: false, error: `LED script hatası: ${cmdErr.message}. WS2812 kasa (Pironman 5) için 'pip3 install spidev' + SPI etkin olmalı.` };
  }
}

// Açılışta kayıtlı LED ayarını geri yükle (bloklamadan; hata sessizce yutulur).
async function restoreLedConfig(): Promise<void> {
  if (!isLinux) return;
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'led_config'");
    if (!row?.value) return;
    await applyLedConfig(JSON.parse(row.value));
  } catch { /* LED donanımı yoksa sorun değil */ }
}

app.put('/api/case/led', async (req, res) => {
  try {
    const { color, enabled } = req.body;
    // Doğrulama DB yazımından ÖNCE: geçersiz ayar kaydedilip donanıma hiç uygulanmasın.
    if (enabled && !isValidHexColor(color)) {
      return res.status(400).json({ error: 'Geçersiz renk (hex) değeri' });
    }
    // Desteklenmeyen animasyon adı reddedilmek yerine 'static'e indirilir (eski 'solid' kayıtları).
    const cfg = { ...req.body, animation: normalizeAnimation(req.body?.animation) };
    await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('led_config', ?)", [JSON.stringify(cfg)]);
    res.json({ success: true, ...(await applyLedConfig(cfg)) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Kasa OLED motor ayarları (scripts/lcd_display.py DEFAULT_SETTINGS ile aynı şema).
// Değerler PI5_LCD_* env'lerine yazılır; panelden gelen her alan burada doğrulanır.
const LCD_DEFAULT_SETTINGS = {
  wan_if: 'eth0',
  temp_alarm: 75,
  fps: 10,   // 100 kHz I2C'nin taşıyabildiği üst sınır; 400 kHz'de yükseltilebilir
  anim: true,
  i2c_addr: '0x3C',
  i2c_port: 1,
  mounts: [{ name: 'ROOT', path: '/' }, { name: 'BOOT', path: '/boot/firmware' }],
};

function sanitizeLcdSettings(input: any) {
  const s: any = { ...LCD_DEFAULT_SETTINGS, mounts: [...LCD_DEFAULT_SETTINGS.mounts] };
  if (!input || typeof input !== 'object') return s;
  const num = (v: any, min: number, max: number, dflt: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
  };
  // Arayüz adı: Linux IFNAMSIZ 15 karakter; kabuk metakarakteri kabul edilmez.
  if (typeof input.wan_if === 'string' && /^[A-Za-z0-9_.@-]{1,15}$/.test(input.wan_if)) s.wan_if = input.wan_if;
  s.temp_alarm = num(input.temp_alarm, 40, 110, LCD_DEFAULT_SETTINGS.temp_alarm);
  s.fps = num(input.fps, 1, 60, LCD_DEFAULT_SETTINGS.fps);
  s.anim = input.anim !== false;
  const addr = typeof input.i2c_addr === 'string' ? input.i2c_addr.trim() : '';
  if (/^0x[0-9a-fA-F]{2}$/.test(addr)) s.i2c_addr = '0x' + addr.slice(2).toUpperCase();
  s.i2c_port = num(input.i2c_port, 0, 9, LCD_DEFAULT_SETTINGS.i2c_port);
  if (Array.isArray(input.mounts)) {
    const seen = new Set<string>();
    s.mounts = input.mounts
      .map((m: any) => ({
        name: String(m?.name ?? '').trim().toUpperCase().slice(0, 6),
        path: String(m?.path ?? '').trim(),
      }))
      // Yol mutlak olmalı; ad/yol motorun "AD=yol" listesine girdiği için ',' ve '=' yasak.
      .filter((m: any) => m.name && /^[A-Z0-9_-]+$/.test(m.name)
        && /^\/[^,=\s]*$/.test(m.path) && !seen.has(m.name) && seen.add(m.name))
      .slice(0, 8);
  }
  return s;
}

app.get('/api/case/lcd', async (_req, res) => {
  try {
    const row = await dbGet("SELECT value FROM app_settings WHERE key = 'lcd_pages'");
    const ctrlRow = await dbGet("SELECT value FROM app_settings WHERE key = 'lcd_controller'");
    const setRow = await dbGet("SELECT value FROM app_settings WHERE key = 'lcd_settings'");
    const pages = row?.value ? JSON.parse(row.value) : [];
    const settings = sanitizeLcdSettings(setRow?.value ? JSON.parse(setRow.value) : null);
    // Panelin arayüz seçimi ve mount önerileri için ipuçları (Pi5 dışında boş döner).
    const hints: { interfaces: string[]; wan: string; mounts: { name: string; path: string }[] } =
      { interfaces: [], wan: settings.wan_if, mounts: [] };
    if (isLinux) {
      try {
        const bw = await getBandwidthLive();
        hints.interfaces = bw.interfaces.map(i => i.name);
        hints.wan = (await detectInterfaces()).wan;
      } catch { /* ipuçları isteğe bağlı */ }
      try {
        const exec = require('util').promisify(require('child_process').exec);
        // GNU coreutils: -P (--portability) ile --output birlikte kullanılamaz ("mutually
        // exclusive") — ikisi bir aradayken komut hataya düşüp liste boş kalıyordu.
        const { stdout } = await exec(
          "(df --output=target 2>/dev/null || df -P 2>/dev/null | awk '{print $NF}') | tail -n +2",
          { timeout: 4000 });
        hints.mounts = String(stdout).split('\n').map(t => t.trim()).filter(Boolean)
          .filter(t => t === '/' || (!t.startsWith('/dev') && !t.startsWith('/sys') && !t.startsWith('/proc') && !t.startsWith('/run')))
          .slice(0, 20)
          .map(path => ({ path, name: (path === '/' ? 'ROOT' : path.split('/').filter(Boolean).pop() || 'VOL').toUpperCase().slice(0, 6) }));
      } catch { /* ipuçları isteğe bağlı */ }
    }
    res.json({ pages, controller: ctrlRow?.value || 'auto', settings, hints });
  } catch {
    res.json({ pages: [], controller: 'auto', settings: sanitizeLcdSettings(null), hints: { interfaces: [], wan: 'eth0', mounts: [] } });
  }
});

app.put('/api/case/lcd', async (req, res) => {
  try {
    const { pages, controller, settings } = req.body;
    await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lcd_pages', ?)", [JSON.stringify(pages)]);
    if (controller && ['auto', 'ssd1306', 'sh1106'].includes(String(controller))) {
      await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lcd_controller', ?)", [String(controller)]);
    }
    if (settings !== undefined) {
      await dbRun("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lcd_settings', ?)",
        [JSON.stringify(sanitizeLcdSettings(settings))]);
    }
    // LCD is a persistent systemd service (pi5-lcd) — restart it so new pages/controller apply.
    if (isLinux) {
      const exec = require('util').promisify(require('child_process').exec);
      const LCD = '/opt/pi5-gateway/scripts/lcd_display.py';
      try {
        await ensureLcdService();
        // Detect a REAL display (detect exits 2 / prints display=console when only the console
        // fallback exists → the physical OLED would stay dark).
        let noDisplay = false;
        try {
          await exec(`python3 ${LCD} detect`, { timeout: 12000 });
        } catch (dErr: any) {
          const out = String(dErr.stdout || '') + String(dErr.message || '');
          if (dErr.code === 2 || /display=console/.test(out)) noDisplay = true;
        }
        // pi5-lcd servisi ExecStartPre ile SunFounder OLED'ini bıraktığı için restart yeterli;
        // OLED çakışması yapısal olarak önlenir (ayrı bir pironman uyarısına gerek yok).
        await exec('systemctl restart pi5-lcd.service', { timeout: 15000 });
        if (noDisplay) {
          return res.json({ success: true, applied: false, error: 'Fiziksel ekran bulunamadı. Kurulum: pip3 install --break-system-packages luma.oled luma.core Pillow; I2C açık olmalı (raspi-config). Detay: /tmp/lcd_display.log' });
        }
        res.json({ success: true, applied: true });
      } catch (cmdErr: any) {
        res.json({ success: true, applied: false, error: `LCD servisi hatası: ${cmdErr.message}` });
      }
    } else {
      res.json({ success: true, applied: false, warning: 'LCD kontrolü sadece Pi5 üzerinde çalışır' });
    }
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
    if (isLinux) {
      const exec = require('util').promisify(require('child_process').exec);
      if (req.body.enabled) {
        try {
          // Enable and start kiosk systemd service (handles X11 + Chromium)
          await exec('systemctl enable pi5-kiosk.service 2>/dev/null', { timeout: 5000 });
          await exec('systemctl start pi5-kiosk.service 2>/dev/null', { timeout: 10000 });
          res.json({ success: true, applied: true, message: 'Kiosk modu etkinleştirildi. HDMI çıkışında dashboard görünecek.' });
        } catch (e: any) {
          res.json({ success: true, applied: false, error: `Kiosk servisi başlatılamadı: ${e.message}. install.sh çalıştırıldığından emin olun.` });
        }
      } else {
        try {
          await exec('systemctl stop pi5-kiosk.service 2>/dev/null', { timeout: 5000 }).catch(() => {});
          await exec('systemctl disable pi5-kiosk.service 2>/dev/null', { timeout: 5000 }).catch(() => {});
          res.json({ success: true, applied: true, message: 'Kiosk modu kapatıldı. HDMI çıkışı terminale dönecek.' });
        } catch (e: any) {
          res.json({ success: true, applied: false, error: e.message });
        }
      }
    } else {
      res.json({ success: true, applied: false, warning: 'Kiosk modu sadece Pi5 üzerinde çalışır' });
    }
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
    if (!isValidTimezone(timezone)) return res.status(400).json({ error: 'Geçersiz zaman dilimi' });
    if (isLinux) {
      await execFileP('timedatectl', ['set-timezone', timezone], { timeout: 5000 });
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
    // Servis ortamında HOME yok → ~/.gitconfig'teki safe.directory görünmez ("dubious ownership"); her çağrıda
    // --global --add yeni kopya ekliyordu. Güvenli dizin komut satırından verilir (git ≥ 2.36).
    const git = 'git -c safe.directory=/opt/pi5-gateway -C /opt/pi5-gateway';
    await exec(`${git} fetch origin master`, { timeout: 15000 }).catch(() => {});
    // Compare HEAD with origin/master
    const { stdout: logOutput } = await exec(
      `${git} log HEAD..origin/master --format="%h|%s|%cr" 2>/dev/null`,
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
        `${git} rev-parse --short HEAD`, { timeout: 5000 }
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
    const steps: { step: string; output: string; success: boolean; warning?: boolean }[] = [];
    const exec = require('util').promisify(require('child_process').exec);
    // update.sh düşülen adımı '@@STEP_FAILED=<adım> rc=N', post-update çıkış kodunu '@@POSTUPDATE_RC=N' ile bildirir
    // (eskiden çıktıdaki kelimelerden tahmin ediliyordu; 'Git OK: unknown' gibi durumlar görünmüyordu).
    const STEP_LABEL: Record<string, string> = { hazirlik: 'Hazırlık', git: 'Git Pull', backend: 'Backend Build', frontend: 'Frontend Build' };
    const STEP_ORDER = ['hazirlik', 'git', 'backend', 'frontend'];

    // Run entire update via single script (handles permissions, chown, git, builds)
    try {
      const { stdout } = await exec(
        'bash /opt/pi5-gateway/scripts/update.sh 2>&1',
        { timeout: 300000 } // 5 min total
      );
      const head = /Git OK: (\S+)/.exec(stdout)?.[1];
      const viaSudo = /Normal fetch başarısız/.test(stdout) ? ' — sudo ile' : '';
      steps.push({ step: 'Git Pull', output: head ? `OK (${head})${viaSudo}` : 'OK', success: true });
      const pu = /@@POSTUPDATE_RC=(\d+)/.exec(stdout);
      if (pu) steps.push({ step: 'Post-Update', output: `çıkış kodu ${pu[1]} — ayrıntı: core/update.log`, success: true, warning: true });
      steps.push({ step: 'Backend Build', output: 'OK', success: true });
      steps.push({ step: 'Frontend Build', output: stdout.trim().slice(-500), success: true });
    } catch (e: any) {
      const full = String(e?.stdout || '');
      const tail = (full || String(e?.message || '')).trim().slice(-500);
      const failed = /@@STEP_FAILED=(\w+) rc=(\d+)/.exec(full);
      if (failed && STEP_ORDER.includes(failed[1])) {
        for (const s of STEP_ORDER.slice(1, STEP_ORDER.indexOf(failed[1]))) steps.push({ step: STEP_LABEL[s], output: 'OK', success: true });
        steps.push({ step: STEP_LABEL[failed[1]], output: tail, success: false });
      } else if (e?.killed) {
        steps.push({ step: 'Zaman aşımı', output: 'Güncelleme 5 dk içinde bitmedi; işlem arka planda sürebilir — ayrıntı: core/update.log', success: false });
      } else {
        steps.push({ step: 'Güncelleme', output: tail, success: false });
      }
    }

    const allSuccess = steps.every(s => s.success);
    if (allSuccess) steps.push({ step: 'Servis Restart', output: '3 saniye sonra yeniden baslatilacak...', success: true });
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

// ─── Panel erişim koruması (nginx Basic Auth) — scripts/panel-auth.sh ───
// Şifreyi kullanıcı belirler; stdin'den verilir (argv/log/SQLite'a girmez), Pi yalnız SHA-512 crypt özetini saklar.
// Açma her zaman 5 dk'lık denemedir: tarayıcı şifreyle girip "Kalıcı yap" (confirm) demezse zamanlayıcı geri alır.
// Koruma açıkken bu uçlara yalnız şifreyle girmiş tarayıcı ulaşır — confirm, girişin gerçekten çalıştığının kanıtıdır.
const PANEL_AUTH_SCRIPT = '/opt/pi5-gateway/scripts/panel-auth.sh';
const PANEL_AUTH_TRIAL_S = 300;
function runPanelAuth(args: string[], input = ''): Promise<{ code: number | null; kv: Record<string, string> }> {
  return new Promise(resolve => {
    const child = _spawn('bash', [PANEL_AUTH_SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', d => { if (out.length < 16384) out += d; });
    child.stderr.on('data', d => { if (out.length < 16384) out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, kv: { error: 'panel-auth.sh çalıştırılamadı' } }); });
    child.on('close', code => {
      clearTimeout(timer);
      const kv: Record<string, string> = {};
      for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      resolve({ code, kv });
    });
    child.stdin.end(input);
  });
}
const panelAuthError = (r: { code: number | null; kv: Record<string, string> }, fallback: string) =>
  [r.kv.error || fallback, r.kv.detail].filter(Boolean).join(' — ');
app.use('/api/panel-auth', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && !trustedPanelHost(String(req.headers.host || ''))) {
    res.status(403).json({ error: await ipPanelHint() });
    return;
  }
  next();
});
// Pi'nin kendisi (kiosk tarayıcısı) şifresiz girer — onun "Kalıcı yap"ı şifrenin çalıştığını kanıtlamaz.
const isLoopbackClient = (ip: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || ''));

app.get('/api/panel-auth/status', async (_req, res) => {
  if (!isLinux) return res.json({ state: 'unsupported' });
  const r = await runPanelAuth(['status']);
  if (r.code !== 0) return res.json({ state: 'error', error: panelAuthError(r, 'durum okunamadı') });
  res.json({
    state: r.kv.state || 'pending', user: r.kv.user || 'admin', password_set: r.kv.password_set === '1',
    trial_ends: Number(r.kv.trial_ends) || 0, now: Number(r.kv.now) || Math.floor(Date.now() / 1000),
  });
});

app.post('/api/panel-auth/password', async (req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  const pw = req.body?.password;
  const chars = typeof pw === 'string' ? [...pw].length : 0;
  if (typeof pw !== 'string' || /[\r\n\0]/.test(pw) || chars < 12 || chars > 128 || Buffer.byteLength(pw, 'utf8') > 512) {
    return res.status(400).json({ error: 'Şifre 12-128 karakter olmalı ve satır sonu içermemeli' });
  }
  const r = await runPanelAuth(['set-password'], `${pw}\n`);
  if (r.code !== 0) return res.status(500).json({ error: panelAuthError(r, 'şifre kaydedilemedi') });
  res.json({ success: true });
});

app.post('/api/panel-auth/activate', async (_req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  const r = await runPanelAuth(['on', '--trial', String(PANEL_AUTH_TRIAL_S)]);
  if (r.code !== 0) return res.status(500).json({ error: panelAuthError(r, 'koruma açılamadı') });
  res.json({ success: true, trial_ends: Number(r.kv.trial_ends) || 0 });
});

app.post('/api/panel-auth/confirm', async (req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  if (isLoopbackClient(req.ip)) {
    return res.status(403).json({ error: 'Onayı, şifreyle girdiğin başka bir cihazdan (PC/telefon) ver — Pi\'nin kendi ekranı şifre sormaz' });
  }
  const r = await runPanelAuth(['confirm']);
  if (r.code !== 0) return res.status(409).json({ error: panelAuthError(r, 'onaylanamadı') });
  res.json({ success: true });
});

app.post('/api/panel-auth/rollback', async (_req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  const r = await runPanelAuth(['rollback']);
  if (r.code !== 0) return res.status(500).json({ error: panelAuthError(r, 'geri alınamadı') });
  res.json({ success: true });
});

// ─── Global Error Handler ───
// Gövde ayrıştırma hataları (bozuk JSON / çok büyük gövde) 400/413 döner ve mesajları loglanmaz: body-parser mesajı
// gövdenin ilk baytlarını içerir (elle gönderilmiş bir istekteki sır parçası loga düşebilirdi).
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    console.error(`İstek gövdesi reddedildi: ${err.type}`);
    return res.status(status).json({ error: status === 413 ? 'İstek gövdesi çok büyük.' : 'Geçersiz JSON gövdesi.' });
  }
  console.error('Unhandled error:', err.message || err);
  res.status(500).json({ error: 'Sunucu hatası oluştu.' });
});

// ─── 404 Handler ───
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı.' });
});

// Yalnız localhost'a bağlan: dış erişim NGINX (:80) üzerinden olmalı (Basic Auth'u atlamayı önler).
const bindHost = process.env.BIND_HOST || '127.0.0.1';
const server = app.listen(Number(port), bindHost, () => {
  console.log(`Backend server running on http://${bindHost}:${port}`);
  // Kayıtlı kasa LED ayarını geri yükle — boot/restart sonrası kullanıcının seçimi
  // korunsun (aksi halde pironman5 RGB'yi kendi varsayılanıyla geri açıyor).
  void restoreLedConfig();
  // Önce yarım kalmış denemeler: Pi deneme sırasında yeniden başladıysa (zamanlayıcı kalıcı değil) sabit adres ve Pi DHCP
  // denemesi geri alınır — kurallar ondan sonra güncel adreslere göre yazılır. Sonra VPS tünelleri + domain/app routing
  // kuralları (kernel durumu reboot'ta sıfırlanır).
  void (async () => {
    if (isLinux) {
      const fs = require('fs');
      for (const [script, tag] of [[NET_MODE_SCRIPT, 'net-mode'], [PI_DHCP_SCRIPT, 'pi-dhcp']]) {
        if (!fs.existsSync(script)) continue;
        const r = await runKvScript(script, ['ensure'], 300000);
        if (r.code !== 0) console.error(`[${tag}]`, kvError(r, 'ensure başarısız'));
        else if (r.kv.warning) console.error(`[${tag}] uyarı:`, r.kv.warning);
      }
    }
    await restoreTunnelsAndRouting();
  })();
  // AS aralıkları (ör. WhatsApp aramaları için Meta) 6 saatte bir denetlenir; ilk denetim açılıştan 2 dk sonra.
  setTimeout(() => { void refreshAsnRanges(); }, 120000);
  setInterval(() => { void refreshAsnRanges(); }, 6 * 3600 * 1000);
  // Cihaz engelleri (nft tablosu açılışta yoktur; pi5-gw-restore da yükler — burada DB'deki güncel liste yazılır).
  void reapplyBlockedDevices();
  // Panel koruması: deneme sırasında Pi yeniden başladıysa (zamanlayıcı kalıcı değil) süresi geçen deneme geri alınır.
  if (isLinux && require('fs').existsSync(PANEL_AUTH_SCRIPT)) {
    void runPanelAuth(['ensure']).then(r => { if (r.code !== 0 || r.kv.warning) console.error('[panel-auth]', r.kv.error || r.kv.warning); });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

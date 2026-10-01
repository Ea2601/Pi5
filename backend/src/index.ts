import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDb, dbAll, dbRun, dbGet, dbInsert } from './db';
import { setupWireGuardVPS, testSSHConnection, executeSetupStep, addWireGuardClient, connectPi5ToVps, disconnectPi5FromVps, removeWireGuardClient, removeWireGuardClients } from './ssh';
import { readVpsTunnels, readTunnelTransfer, validVpsId, staleTunnels, setTunnelStale } from './vpsTunnel';
import { validateFwRule, fwRuleToNft, accessCheck, isPanelLockoutForAll, blocksWholeLan, describeRule } from './firewall';
import { fail2banSettingsView, validateFail2banSettings, applyFail2banSettings, ensureFail2ban, recentBans, unbanIp, lanNetworks } from './fail2ban';
import { normFallback } from './routeMarks';
import { systemServices } from './services';
import { startHealthMonitor, getHealthStatus } from './monitor';
import { startCronJobs, getSystemLogs, clearSystemLogs } from './maintenance';
import {
  isLinux, getSystemStats, getPiholeStats, getServiceStates, isManagedService, waitServiceSettled,
  MANAGED_SERVICE_NAMES, TOGGLEABLE_SERVICES, FTL_SETTLE_TIMEOUT,
  getNetworkDevices, getBandwidthLive, getWireguardStatus,
  getFail2banStatus, getDnsQueries, getCurrentExternalIp,
  executeCommand, applyDomainRouting, applyBlockedDevices,
  sampleMetrics, detectInterfaces, recoverInterruptedFtlRestart, VALID_DNSMASQ_DOMAIN, getRoutingApplyStatus,
  getLanIdentity, protectedMacs, getPi5LanIp, readNetModeState, runExclusiveDnsTask, AP_ADDR, AP_NET, HOME_BRIDGE,
  wanActive, uplinkIfaces, readFailoverStatus, activeUplink, sameNetActive, readRepLanStatus, syncVpsRoutes,
  legacyRoutingCleanupDue,
} from './system';
import type { RangeRoute } from './system';
import { listForwards, addForward, setForwardEnabled, deleteForward, applyPortForwards } from './wan';
import { runSpeedTest, SpeedtestUnavailable, type SpeedResult } from './speedtest';
import { ASN_TOKEN, getAsnPrefixes, normalizeCidr, refreshAsnIfStale } from './ipRanges';
import { getRoutingSuggestions, MAX_HOURS as SUGGEST_MAX_HOURS } from './domainSuggest';
import { startUpdate, getUpdateStatus } from './update';
import { sampleBandwidth, neighborMacs, buildLive } from './bandwidth';
import { buildTopology, readNeighbors, readNeighbors6, readHandshakes, readDefaultRoute, readIfaces, readLocalIps, noteActivity, inCidr, readPeerHandshakes } from './topology';
import { startLinkProbe, probeSamples, probeBaseline, noteTopologyView, type ProbeTarget } from './linkProbe';
import { startTrafficRecorder, usageSummary, appActivity, appDefsFrom } from './trafficHistory';
import { qosStatus, validateLimit, saveLimit, deleteLimit, resetQuota, normMac, runQos, migrateThrottleRules, startQos, isProtectedMac, normalizeLimitMacs } from './qos';
import { readHardware, evaluateRoles } from './hardware';
import { readHomeStations } from './homeWifi';
import { STARTUP_ROLE, isSatellite, readRole, writeRole, type DeviceRole } from './role';
import {
  createPairing, cancelPairing, pairingState, pairSatellite, syncSatellite, listSatellites, removeSatellite, satelliteStations,
  checkOfflineSatellites, setMainWireless, mainMeshState, joinMain, syncOnce, leaveMain, satelliteState, startSatelliteAgent,
  readSatState, MeshError, validSatId, removePeerKeys,
} from './mesh';
import { authGate, registerAuthRoutes } from './auth';
import { validateSchedule, validateCommand, syncCronJobs, readJobStatuses, readSystemCron, syncCronOnStartup, runningJobs, jobOutput, startJobNow } from './cronSync';
import { validateListValue, normalizeListValue, syncPiholeLists, lastListSync, externalPiholeEntries } from './piholeLists';
import { applyZapret, zapretStatus, startBlockcheck, blockcheckRunning, zapretInstalled, zapretInstallIssue, zapretBrief, cleanDpiDomain } from './zapret';
import type { ZapretApplyResult } from './zapret';
import { unboundStatus, applyUnboundSettings, validateUnboundSettings, savedUnboundSettings } from './unbound';
import { recordEvent, recordEventOnce, recordVersionChange, serviceLabel } from './events';
import { wgServerStatus, setServerEnabled, addPeer, updatePeerRole, deletePeer, peerConfig, reapplyWgServer,
  validatePeerName, validRole, WG_PORT, WG_IFACE, reachabilityTest } from './wgServer';
import { startReachWatch, noteReachResult, reachWatchState, REACH_WATCH_INTERVAL_H } from './wgWatch';
import { storageStatus, storageJob, noteStorageJob, startArchive, startPrepare, startMigrate, startStorageWatch } from './storage';
import { applyKiosk } from './kiosk';
import { shareStatus, enableShare, disableShare, setSharePassword, addUsbShare, removeUsbShare, startShareWatch } from './share';
import { rulesWithStatus as parentalRulesWithStatus, createRule as createParentalRule, updateRule as updateParentalRule,
  deleteRule as deleteParentalRule, startParental, CATEGORIES as PARENTAL_CATEGORIES } from './parental';
import { noteContentView, contentForClients, contentStatus } from './contentActivity';
import { LIST_TOKEN, LIST_IDS, ensureList, ensureLists, listInfo, type ListId } from './categoryLists';
import { listDnsStats, type ListRoute } from './listDns';
import type { ListSyncResult } from './piholeLists';
import {
  shq, isValidMac, isValidDomain, isValidTimezone,
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
// Gövde sınırı 1 MB; yedek içe aktarma 20 MB (dışa aktarmanın sınırı yok — büyük yedek geri yüklenebilsin).
const jsonSmall = express.json({ limit: '1mb' });
const jsonBackup = express.json({ limit: '20mb' });
app.use((req, res, next) => (req.path === '/api/backup/import' ? jsonBackup : jsonSmall)(req, res, next));

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
  // klyrix.local: Wi-Fi köprüsünde avahi'nin yayınladığı ad (net-mode.sh REP_MDNS); .local yalnız yerel ağda (mDNS) çözülür.
  return ['localhost', 'pi.hole', 'klyrix.local', me, `${me}.local`, `${me}.lan`, `${me}.home`].includes(h);
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

// Panel giriş ekranı (panel-auth.sh "mode form"): tüm uçlardan önce /api kapısı + giriş uçları (bkz. auth.ts). Mod
// "basic" ya da tanımsızken kapı hiçbir şey yapmaz — koruma nginx Basic Auth'tadır.
app.use('/api', authGate);
// Root komutu çalıştıran ya da sistemi değiştiren uçlar: yazma istekleri yalnız panelin IP adresi / Pi'nin adıyla gelirse
// (netAdminGuard, DNS rebinding'e karşı — koruma kapalıyken başka bir sitenin sayfası Pi'nin adresine yeniden bağlanıp
// terminali çalıştıramasın). Ağ uçlarındaki (netmode, wan …) denetimin aynısı; localhost (kiosk) ve IP güvenilir.
// netAdminGuard aşağıda tanımlı: istek anında çağrılır.
app.use(['/api/terminal', '/api/cron', '/api/backup', '/api/system', '/api/services', '/api/storage', '/api/firewall',
  '/api/fail2ban', '/api/unbound', '/api/bandwidth'], (req, res, next) => { void netAdminGuard(req, res, next); });
registerAuthRoutes(app);

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
    // Eksik kurulu Zapret açılamaz (systemctl "Unit zapret.service does not exist" derdi); ne yapılacağı söylenir.
    const zapretIssue = name === 'zapret' && enabled ? zapretInstallIssue() : null;
    if (zapretIssue) return res.status(409).json({ success: false, name, error: zapretIssue });
    // Zapret açılmadan önce listesi ve ayarları yazılır (zapret.ts); sonuç (ör. "liste boş" uyarısı) yanıtla döner.
    const zapret: ZapretApplyResult | undefined = name === 'zapret' && enabled ? await applyZapret() : undefined;
    let actionError = '';
    try { await systemServices.toggleService(name, enabled); } catch (e: any) { actionError = e.message; }
    const timeout = actionError ? 3000 : enabled ? (name === 'pihole' ? FTL_SETTLE_TIMEOUT : 15000) : 10000;
    const st = await waitServiceSettled(name, enabled ? 'running' : 'stopped', timeout);
    const ok = !actionError && (enabled ? st.status === 'running' : st.status !== 'running' && st.status !== 'restarting');
    await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
      [st.status === 'running' ? 1 : 0, st.status, name]);
    if (!ok) {
      const why = actionError || `durum ${st.status}${st.detail ? ` — ${st.detail}` : ''} (${st.active_state || '?'}/${st.sub_state || '?'})`;
      await recordEvent(`service:${name}`, `${serviceLabel(name)} ${enabled ? 'başlatılamadı' : 'durdurulamadı'}: ${why}`, 'warning');
      return res.status(500).json({ success: false, name, enabled: st.status === 'running', status: st.status,
        error: `${name} ${enabled ? 'başlatılamadı' : 'durdurulamadı'}: ${why}` });
    }
    await recordEvent(`service:${name}`, `${serviceLabel(name)} ${enabled ? 'açıldı' : 'kapatıldı'}`);
    res.json({ success: true, name, enabled: st.status === 'running', status: st.status, ...(zapret ? { zapret } : {}) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Uygulanmayan kural: panele herkesin (TCP 80) ya da tüm ev ağının erişimini keser (eski sürümde kaydedilmiş olabilir).
const fwRuleIgnored = (r: any, lan: string[]) => isPanelLockoutForAll(r) || blocksWholeLan(r, lan);
// Özel firewall kurallarını (routing_rules) GÜVENLİ nft satırlarına çevirir (firewall.ts: katı doğrulama — target / port
// kullanıcı girdisidir; enjeksiyon önleme). Yalnız etkin kurallar, eklenme sırasıyla; uygulanmayan kurallar atlanır.
function buildCustomFwRules(rows: any[], lan: string[]): string[] {
  const out: string[] = [];
  for (const r of rows || []) {
    if (fwRuleIgnored(r, lan)) {
      console.warn(`[firewall] panele herkesin / tüm ev ağının erişimini kesen kural uygulanmadı: ${JSON.stringify({ type: r.type, target: r.target, port: r.port, action: r.action })}`);
      continue;
    }
    const line = fwRuleToNft(r);
    if (line) out.push(line);
  }
  return out;
}
const FW_RULES_SQL = 'SELECT id, type, target, port, proto, action, enabled FROM routing_rules ORDER BY id';
// Güvenlik duvarı değişiklikleri sırayla: iki uygulama aynı anda yapılandırma yazmasın, bir isteğin "DB değişikliği →
// uygula → başarısızsa geri al" adımları başka bir uygulamayla iç içe geçmesin.
let fwQueue: Promise<unknown> = Promise.resolve();
function withFwLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = fwQueue.then(fn, fn);
  fwQueue = next.catch(() => {});
  return next;
}
// Panelin güvenlik duvarı: DB'deki arayüzler + özel kurallar → doğrulamalı uygulama (services.ts); pi5_filter yeniden
// kurulduğu için Ev VPN'i izin zincirleri (ve ona bağlı kancalar) geri eklenir. Kilitsiz (withFwLock içinden çağrılır).
async function applyPanelFirewallNow() {
  const cfg = await dbAll("SELECT key, value FROM service_config WHERE service = 'nftables' AND key IN ('lan_iface', 'wan_iface')");
  const m: Record<string, string> = {};
  (cfg as any[]).forEach(r => { m[r.key] = r.value; });
  const lan = await lanNetworks();
  const result = await systemServices.configureNftables({ lan: m.lan_iface, wan: m.wan_iface }, buildCustomFwRules(await dbAll(FW_RULES_SQL), lan));
  await reapplyWgServer(); // pi5_filter yeniden kuruldu: Ev VPN'i izin zincirleri (politika drop) geri eklensin
  return result;
}
const applyPanelFirewall = () => withFwLock(applyPanelFirewallNow);
// Panelin güvenlik duvarı bu Pi'de kurulu mu (Deploy Et en az bir kez yapıldı)? Kurulu değilse "yeniden uygula" ilk kurulum
// yapmaz (politika drop'lu duvarı kullanıcı bilmeden açmasın).
const panelFirewallDeployed = () => {
  try { return require('fs').readFileSync('/etc/nftables.conf', 'utf8').includes('table inet pi5_filter'); } catch { return false; }
};
const fwClientIp = (req: express.Request) => String(req.ip || '').replace(/^::ffff:/, '');
// Değişiklikten SONRAKİ kural kümesiyle (ekle / aç / kapat / sil / yeniden uygula): isteği yapan cihaz panele erişebilecek
// mi (hayırsa hata), SSH'ı kaybedecek mi (uyarı). IPv6 ile bağlanan cihazın IPv4 adresi bilinmez → IP kuralında uyarı.
// Pi evin DHCP sunucusuyken UDP 67'yi kapatmak tüm evin adresini keser (hata); DNS'i kapatmak uyarı.
const blocking = (r: any) => Number(r?.enabled ?? 1) !== 0 && String(r?.action) !== 'accept';
async function fwAccessVerdict(rows: any[], req: express.Request): Promise<{ error?: string; warning?: string }> {
  const ip = fwClientIp(req);
  const lan = await lanNetworks();
  const live = rows.filter(r => !fwRuleIgnored(r, lan)); // uygulanmayacak kurallar hesaba katılmaz
  const a = accessCheck(live, ip);
  if (a.panel) return { error: `Bu kural panele eriştiğiniz cihazı (${ip}) dışarıda bırakır: ${describeRule(a.panel)} — değişiklik uygulanmadı. Başka bir cihazı engellemek için onun adresini girin.` };
  if (live.some(r => blocking(r) && r.type === 'udp' && Number(r.target) === 67) && await piDhcpActive()) {
    return { error: "Pi evin DHCP sunucusu: UDP 67'yi kapatmak tüm cihazların adres almasını keser — değişiklik uygulanmadı." };
  }
  const warnings: string[] = [];
  if (a.ssh) warnings.push(`Bu cihaz (${ip}) SSH'a (22) bağlanamayacak: ${describeRule(a.ssh)}. Panel ve terminali açık kalır.`);
  if (live.some(r => blocking(r) && (r.type === 'udp' || r.type === 'tcp') && Number(r.target) === 53)) {
    warnings.push("DNS (53) kapalı: Pi-hole'u kullanan cihazların interneti gider.");
  }
  const loopback = ip === '' || ip === '::1' || ip.startsWith('127.');
  if (!loopback && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && live.some(r => blocking(r) && r.type === 'ip')) {
    warnings.push(`Bu cihaz IPv6 ile bağlı (${ip}): IPv4 adresi denetlenemedi — engellediğiniz adres bu cihazınsa panele IPv4 ile erişemezsiniz.`);
  }
  return warnings.length ? { warning: warnings.join(' ') } : {};
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
      // Özel kurallar artık sabit izinlerden önce: kuralları uygulayan cihaz panele erişimini kaybedecekse uygulanmaz.
      const verdict = await fwAccessVerdict(await dbAll(FW_RULES_SQL), req);
      if (verdict.error) return res.status(409).json({ success: false, error: verdict.error });
      result = await applyPanelFirewall();
      status = await recordState('nftables');
    }
    res.json({ success: true, message: `Action ${action} executed.`, log: result, status });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Cron Jobs ───
// Görevler Pi'nin zamanlayıcısına (/etc/cron.d/pi5-panel) yazılır — bkz. cronSync.ts. Her değişiklikten sonra eşitlenir;
// yazılamazsa değişiklik kayıtlı kalır ve hata bildirilir.
const syncCronError = async (): Promise<string | null> => {
  try { await syncCronJobs(); return null; } catch (e: any) { return `kaydedildi ama zamanlayıcıya yazılamadı: ${e?.message || e}`; }
};

app.get('/api/cron/jobs', async (_req, res) => {
  try {
    const jobs = await dbAll('SELECT * FROM cron_jobs ORDER BY id') as any[];
    // Son çalıştırma (zamanlayıcı ya da "Şimdi çalıştır") cron-run.sh'nin sonuç dosyasından; "Çalışıyor" çalışan cron-run.sh
    // (runningJobs) — veritabanındaki eski 'running' değeri takılı kalabiliyordu, yok sayılır.
    const statuses = readJobStatuses();
    const running = runningJobs();
    for (const j of jobs) {
      const st = statuses.get(Number(j.id));
      const manualAt = j.last_run ? Date.parse(String(j.last_run).replace(' ', 'T') + 'Z') : 0;
      if (j.status === 'running') j.status = 'idle';
      if (st && st.at * 1000 > (Number.isFinite(manualAt) ? manualAt : 0)) {
        j.last_run = new Date(st.at * 1000).toISOString().replace('T', ' ').slice(0, 19);
        j.status = st.rc === 0 ? 'success' : 'error';
      }
      if (running.has(Number(j.id))) j.status = 'running';
    }
    res.json({ jobs, system: readSystemCron() });
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
    const bad = validateSchedule(schedule) || validateCommand(command);
    if (bad) return res.status(400).json({ error: bad });
    await dbRun('INSERT INTO cron_jobs (name, schedule, command, description) VALUES (?, ?, ?, ?)',
      [name, String(schedule).trim(), command, description || '']);
    const err = await syncCronError();
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/cron/jobs/:id', async (req, res) => {
  try {
    const { enabled, name, schedule, command, description } = req.body;
    const bad = (schedule !== undefined && validateSchedule(schedule)) || (command !== undefined && validateCommand(command));
    if (bad) return res.status(400).json({ error: bad });
    const updates: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (schedule !== undefined) { updates.push('schedule = ?'); params.push(String(schedule).trim()); }
    if (command !== undefined) { updates.push('command = ?'); params.push(command); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE cron_jobs SET ${updates.join(', ')} WHERE id = ?`, params);
    const err = await syncCronError();
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cron/jobs/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM cron_jobs WHERE id = ?', [req.params.id]);
    const err = await syncCronError();
    if (err) return res.status(500).json({ error: err });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Şimdi çalıştır: panelin dışında başlatılır (cronSync.startJobNow), istek hemen döner; sonuç ve çıktı /output'tan.
// Komut yeniden doğrulanır (yedekten gelen görev POST denetiminden geçmemiş olabilir).
app.post('/api/cron/jobs/:id/run', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const job: any = await dbGet('SELECT * FROM cron_jobs WHERE id = ?', [id]);
    if (!job) return res.status(404).json({ error: 'Görev bulunamadı' });
    if (!isLinux) return res.status(400).json({ error: 'Cron görevleri sadece Pi5 üzerinde çalışır' });
    const bad = validateCommand(job.command);
    if (bad) return res.status(400).json({ error: `Görev komutu geçersiz: ${bad}` });
    if (runningJobs().has(id)) return res.status(409).json({ error: 'Görev zaten çalışıyor' });
    const err = await syncCronError(); // görev betiği güncel olsun
    if (err) return res.status(500).json({ error: err });
    await startJobNow(id);
    res.json({ success: true, started: true });
  } catch (e: any) {
    res.status(500).json({ error: `Görev başlatılamadı: ${e.message}` });
  }
});
app.get('/api/cron/jobs/:id/output', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz görev' });
  res.json({ running: runningJobs().has(id), ...jobOutput(id) });
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
// Kayıtlar Pi-hole'a gerçekten uygulanır (piholeLists.ts): her değişiklikten sonra eşitlenir; yanıttaki `sync` sonucu
// (ok / errors / gravity) arayüzde gösterilir. Kayıt veritabanında kalır — Pi-hole'a ulaşılamazsa sonraki eşitlemede uygulanır.
const PIHOLE_LIST_TYPES = new Set(['adlist', 'whitelist', 'blacklist', 'localdns']);
const PIHOLE_LIST_LABEL: Record<string, string> = { adlist: 'Bloklisteleri', whitelist: 'Beyaz liste', blacklist: 'Kara liste', localdns: 'Yerel DNS' };
// Liste değişikliği + Pi-hole'a uygulama sonucu olay geçmişine.
const piholeEvent = (what: string, sync: ListSyncResult) => recordEvent('pihole',
  sync.ok ? `${what}${sync.gravity ? ' — liste indiriliyor' : ''}` : `${what} — Pi-hole'a uygulanamadı: ${sync.errors.join('; ') || 'bilinmeyen hata'}`,
  sync.ok ? 'info' : 'warning');
app.get('/api/pihole/lists', async (req, res) => {
  try {
    const lists = await dbAll('SELECT * FROM pihole_lists ORDER BY list_type, id');
    const external = req.query.external === '1' ? await externalPiholeEntries() : undefined;
    res.json({ lists, sync: lastListSync(), external });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pihole/lists', async (req, res) => {
  try {
    const { list_type, value, comment } = req.body;
    if (!PIHOLE_LIST_TYPES.has(list_type)) return res.status(400).json({ error: 'Geçersiz liste türü' });
    const bad = validateListValue(list_type, value);
    if (bad) return res.status(400).json({ error: bad });
    await dbRun('INSERT OR IGNORE INTO pihole_lists (list_type, value, comment) VALUES (?, ?, ?)',
      [list_type, normalizeListValue(list_type, value), String(comment || '').slice(0, 200)]);
    const sync = await syncPiholeLists();
    await piholeEvent(`${PIHOLE_LIST_LABEL[list_type]}: eklendi ${normalizeListValue(list_type, value)}`, sync);
    res.json({ success: true, sync });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/pihole/lists/:id', async (req, res) => {
  try {
    const { enabled, value, comment } = req.body;
    const row: any = await dbGet('SELECT list_type, value FROM pihole_lists WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Kayıt bulunamadı' });
    if (value !== undefined) {
      const bad = validateListValue(row.list_type, value);
      if (bad) return res.status(400).json({ error: bad });
    }
    const updates: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (value !== undefined) { updates.push('value = ?'); params.push(normalizeListValue(row.list_type, value)); }
    if (comment !== undefined) { updates.push('comment = ?'); params.push(String(comment).slice(0, 200)); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE pihole_lists SET ${updates.join(', ')} WHERE id = ?`, params);
    const sync = await syncPiholeLists();
    const what = enabled !== undefined ? (enabled ? 'etkinleştirildi' : 'devre dışı bırakıldı') : 'düzenlendi';
    await piholeEvent(`${PIHOLE_LIST_LABEL[row.list_type]}: ${what} ${value !== undefined ? normalizeListValue(row.list_type, value) : row.value}`, sync);
    res.json({ success: true, sync });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/pihole/lists/:id', async (req, res) => {
  try {
    const row: any = await dbGet('SELECT list_type, value FROM pihole_lists WHERE id = ?', [req.params.id]);
    await dbRun('DELETE FROM pihole_lists WHERE id = ?', [req.params.id]);
    const sync = await syncPiholeLists();
    if (row) await piholeEvent(`${PIHOLE_LIST_LABEL[row.list_type]}: silindi ${row.value}`, sync);
    res.json({ success: true, sync });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Elle yeniden eşitleme (panelde "Pi-hole'a uygula")
app.post('/api/pihole/lists/sync', async (_req, res) => {
  try {
    const sync = await syncPiholeLists();
    await piholeEvent('Pi-hole listeleri yeniden uygulandı', sync);
    res.json({ success: true, sync });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Zapret (DPI atlatma) ───
// Zapret Routing'in DPI işaretine bakar (zapret.ts): ek siteler Routing'de ISP + DPI alan adı gibi işaretlenir, hariç
// liste Zapret'e yazılır; her değişiklikten sonra uygulanır, yanıttaki `zapret` sonucu (ok / warnings / error)
// arayüzde gösterilir. Liste değişikliği + Zapret'e uygulama sonucu olay geçmişine.
const zapretEvent = (what: string, z: ZapretApplyResult) => recordEvent('zapret',
  z.ok ? `${what}${z.installed ? '' : ' (Zapret kurulu değil — yalnız kaydedildi)'}` : `${what} — Zapret'e uygulanamadı: ${z.error || 'bilinmeyen hata'}`,
  z.ok ? 'info' : 'warning');
const ZAPRET_LIST_LABEL = (t: string) => (t === 'exclude' ? 'hariç tutulanlar' : 'ek DPI siteleri');
// Ek site işaretle çalışır → Routing yeniden uygulanır (sonunda Zapret de); hariç liste yalnız Zapret'in dosyasında.
async function applyZapretList(type: unknown): Promise<ZapretApplyResult> {
  if (type === 'hostlist') await applyAllRoutingRules();
  return applyZapret();
}
// DPI'ı açılan kural (ya da ek site) Zapret çalışmıyorsa hiçbir trafiğe dokunmaz: Zapret kurulu ama kapalıysa
// kendiliğinden açılır (kullanıcı kararı, 2026-10-01). Yalnız DPI'ın açıldığı değişiklikte çağrılır, her routing
// uygulamasında değil — Zapret sayfasındaki anahtarla kapatan kullanıcının kararı bir sonraki DPI açılışına dek geçerli.
// Hata isteği düşürmez; sonuç olay geçmişine.
async function autoStartZapret(): Promise<void> {
  try {
    if (!isLinux || !zapretInstalled() || zapretInstallIssue()) return;
    if ((await zapretBrief()).active) return;
    await applyZapret(); // NFQWS_ENABLE + FILTER_MARK açılıştan önce yazılmış olsun
    let why = '';
    try { await systemServices.toggleService('zapret', true); } catch (e: any) { why = e.message; }
    const st = await waitServiceSettled('zapret', 'running', why ? 3000 : 15000);
    await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
      [st.status === 'running' ? 1 : 0, st.status, 'zapret']);
    if (st.status === 'running') await recordEvent('service:zapret', "Zapret açıldı (Routing'de DPI açılan kural için)");
    else await recordEvent('service:zapret', `Zapret kendiliğinden açılamadı: ${why || `durum ${st.status}`}`, 'warning');
  } catch (e: any) {
    console.error('[zapret] kendiliğinden açılamadı:', e?.message || e);
  }
}
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
    const { list_type, domain } = req.body ?? {};
    const type = list_type || 'hostlist';
    if (type !== 'hostlist' && type !== 'exclude') return res.status(400).json({ error: 'Geçersiz liste türü' });
    const clean = cleanDpiDomain(domain);
    if (!clean) return res.status(400).json({ error: 'Geçersiz alan adı (ör. discord.com ya da *.discord.com)' });
    await dbRun('INSERT OR IGNORE INTO zapret_domains (list_type, domain) VALUES (?, ?)', [type, clean]);
    const zapret = await applyZapretList(type);
    if (type === 'hostlist') await autoStartZapret();
    await zapretEvent(`Zapret ${ZAPRET_LIST_LABEL(type)}: eklendi ${clean}`, zapret);
    res.json({ success: true, zapret });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/zapret/domains/:id', async (req, res) => {
  try {
    const { enabled } = req.body;
    await dbRun('UPDATE zapret_domains SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, req.params.id]);
    const row: any = await dbGet('SELECT list_type, domain FROM zapret_domains WHERE id = ?', [req.params.id]);
    const zapret = await applyZapretList(row?.list_type);
    if (row?.list_type === 'hostlist' && enabled) await autoStartZapret();
    if (row) await zapretEvent(`Zapret ${ZAPRET_LIST_LABEL(row.list_type)}: ${enabled ? 'etkinleştirildi' : 'devre dışı bırakıldı'} ${row.domain}`, zapret);
    res.json({ success: true, zapret });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/zapret/domains/:id', async (req, res) => {
  try {
    const row: any = await dbGet('SELECT list_type, domain FROM zapret_domains WHERE id = ?', [req.params.id]);
    await dbRun('DELETE FROM zapret_domains WHERE id = ?', [req.params.id]);
    const zapret = await applyZapretList(row?.list_type);
    if (row) await zapretEvent(`Zapret ${ZAPRET_LIST_LABEL(row.list_type)}: silindi ${row.domain}`, zapret);
    res.json({ success: true, zapret });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Canlı durum: servis, nfqws süreci, Zapret config değerleri, strateji, liste sayıları, blockcheck günlüğü.
app.get('/api/zapret/status', async (_req, res) => {
  try {
    res.json(await zapretStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Elle yeniden uygulama (panelde "Zapret'e uygula")
app.post('/api/zapret/apply', async (_req, res) => {
  try {
    const zapret = await applyZapret();
    await zapretEvent(`Zapret yeniden uygulandı (${zapret.dpiRules} DPI kuralı${zapret.manual ? `, ${zapret.manual} ek site` : ''})`, zapret);
    res.json({ success: true, zapret });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Blockcheck arka planda (systemd-run → scripts/zapret-blockcheck.sh): birkaç dakika sürer, günlük /api/zapret/status'ta.
app.post('/api/zapret/blockcheck', async (req, res) => {
  try {
    if (!zapretInstalled()) return res.status(400).json({ error: 'Zapret bu cihazda kurulu değil' });
    const issue = zapretInstallIssue(); // blockcheck stratejileri nfqws ile dener
    if (issue) return res.status(409).json({ error: issue });
    const domain = cleanDpiDomain(req.body?.domain || 'discord.com');
    if (!domain) return res.status(400).json({ error: 'Geçersiz alan adı' });
    if (await blockcheckRunning()) return res.status(409).json({ error: 'Blockcheck zaten çalışıyor' });
    await startBlockcheck(domain);
    await recordEvent('zapret', `Blockcheck başlatıldı: ${domain}`);
    res.json({ success: true, domain });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.stderr || e?.message || e).trim() });
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
      // nftables: `systemctl restart` /etc/nftables.conf'u yükler ve Debian'ın dosyası `flush ruleset` ile başlar — Fail2Ban
      // yasakları, Zapret ve panelin tüm tabloları silinir (kısa süre VPS kuralları ISP'ye düşer). Artık yeniden
      // başlatılmaz: panelin güvenlik duvarı kuruluysa doğrulamalı yeniden uygulanır, öbür panel kuralları aşağıda yüklenir.
      if (name === 'nftables') {
        if (panelFirewallDeployed()) {
          const verdict = await fwAccessVerdict(await dbAll(FW_RULES_SQL), req);
          if (verdict.error) throw new Error(verdict.error);
          await applyPanelFirewall();
        }
      } else {
        await systemServices.restartService(name);
      }
    } catch (e: any) {
      actionError = e.message;
    }
    // WireGuard yeniden başlayınca tünel arayüzleri yeniden kurulur, tablo rotaları kaybolur → routing yeniden uygulanır;
    // nftables "yeniden uygula"da da (idempotent, sıralı kuyruk).
    if (name === 'nftables' || name === 'wireguard') {
      await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    }
    // nftables "yeniden uygula": cihaz engeli, Ev VPN'i, internet kartı güvenlik duvarı ve port yönlendirmeleri de yüklenir.
    if (name === 'nftables') await reapplyBlockedDevices();
    if (name === 'nftables') await runQos({ notify: false, force: true }).catch((e: any) => console.error('Kota / hız sınırları yeniden uygulanamadı:', e.message));
    if (name === 'nftables') await reapplyWgServer();
    if (name === 'nftables') { await wanFirewallReload(); await applyPortForwards(); }
    const st = await waitServiceSettled(name, 'running', actionError ? 3000 : name === 'pihole' ? FTL_SETTLE_TIMEOUT : 15000);
    await dbRun('UPDATE service_status SET enabled = ?, status = ?, last_check = CURRENT_TIMESTAMP WHERE name = ?',
      [st.status === 'running' ? 1 : 0, st.status, name]);
    if (actionError || st.status !== 'running') {
      const why = actionError || `yeniden başlatıldı ama çalışmıyor: ${st.status}${st.detail ? ` — ${st.detail}` : ''} (${st.active_state || '?'}/${st.sub_state || '?'})`;
      await recordEvent(`service:${name}`, `${serviceLabel(name)} yeniden başlatılamadı: ${why}`, 'warning');
      return res.status(500).json({ success: false, status: st.status, error: `${name}: ${why}` });
    }
    await recordEvent(`service:${name}`, `${serviceLabel(name)} yeniden başlatıldı`);
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
// Cihaz adı kaynakları: statik DHCP rezervasyonları (panelde verilen ad) ve Pi-hole'un kira dosyası (cihazın DHCP'de
// bildirdiği ad; "*" = ad yok). Komşu tablosu (ip neigh) ad vermez — bu yapılmadan tüm cihazlar "Bilinmeyen" görünüyordu.
// Yalnız elle ad verilmemiş (name_manual=0) satırlar güncellenir.
async function fillDeviceNames(): Promise<void> {
  const names = new Map<string, string>();
  try {
    const txt = String(require('fs').readFileSync('/etc/pihole/dhcp.leases', 'utf8'));
    for (const line of txt.split('\n')) {
      const [exp, mac, , host] = line.trim().split(/\s+/);
      if (!/^\d+$/.test(exp || '') || !isValidMac(mac) || !host || host === '*') continue;
      names.set(mac.toLowerCase(), host.slice(0, 63));
    }
  } catch { /* kira dosyası yok (Pi DHCP kapalı) */ }
  const statics = await dbAll("SELECT mac_address, hostname FROM dhcp_leases WHERE is_static = 1 AND COALESCE(hostname, '') <> ''");
  for (const r of statics as any[]) names.set(String(r.mac_address).toLowerCase(), String(r.hostname).slice(0, 63));
  for (const [mac, name] of names) {
    await dbRun(
      "UPDATE devices SET hostname = ? WHERE lower(mac_address) = ? AND COALESCE(name_manual, 0) = 0 AND COALESCE(hostname, '') <> ?",
      [name, mac, name],
    );
  }
}

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
      await fillDeviceNames();
    }
    const dbDevices = await dbAll('SELECT * FROM devices ORDER BY last_seen DESC');
    res.json({ devices: dbDevices });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Elle cihaz adı. Boş ad elle adı kaldırır (ad yeniden DHCP kiralarından dolar).
app.put('/api/devices/:mac/name', async (req, res) => {
  try {
    const mac = String(req.params.mac || '').toLowerCase();
    if (!isValidMac(mac)) return res.status(400).json({ error: 'Geçersiz MAC adresi' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if ([...name].length > 40 || /[\x00-\x1f\x7f<>]/.test(name)) {
      return res.status(400).json({ error: 'Ad en fazla 40 karakter olmalı ve < > ya da kontrol karakteri içermemeli' });
    }
    const row = await dbGet('SELECT mac_address FROM devices WHERE lower(mac_address) = ?', [mac]);
    if (!row) return res.status(404).json({ error: 'Cihaz bulunamadı' });
    await dbRun('UPDATE devices SET hostname = ?, name_manual = ? WHERE lower(mac_address) = ?', [name, name ? 1 : 0, mac]);
    if (!name && isLinux) await fillDeviceNames();
    res.json({ success: true });
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
// status: VPS'in kendisi (kurulum / erişilebilirlik — DB). tunnel: Pi ↔ VPS tünelinin canlı durumu (el sıkışma yaşı;
// Linux değilse null).
app.get('/api/vps/list', async (_req, res) => {
  try {
    const servers = await dbAll('SELECT id, ip, username, location, status, created_at FROM vps_servers ORDER BY id') as any[];
    const tunnels = await readVpsTunnels(servers.map(s => Number(s.id))).catch(() => new Map());
    res.json({ servers: servers.map(s => {
      const t = tunnels.get(Number(s.id));
      return { ...s, tunnel: t ? { state: t.state, handshakeAge: t.handshakeAge } : null };
    }) });
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
    // Aynı IP'ye yeniden kurulum aynı kaydı kullanır (eskiden her deneme yeni kayıt açıyordu: başarısız denemeler panelde
    // "hata" durumunda ayrı VPS kartları olarak kalıyordu). Kurulum sürüyorsa ikinci deneme başlatılmaz.
    const existing: any = await dbGet('SELECT id FROM vps_servers WHERE ip = ? ORDER BY id LIMIT 1', [ip]);
    if (existing && setupJobs.get(Number(existing.id))?.overall === 'running') {
      return res.status(409).json({ success: false, error: 'Bu VPS için kurulum zaten sürüyor' });
    }
    let vpsId: number;
    if (existing) {
      vpsId = Number(existing.id);
      await dbRun(`UPDATE vps_servers SET username = ?, password = ?, location = CASE WHEN ? <> '' THEN ? ELSE location END, status = ? WHERE id = ?`,
        [username, password || '', location || '', location || '', 'installing', vpsId]);
    } else {
      vpsId = await dbInsert('INSERT INTO vps_servers (ip, username, password, location, status) VALUES (?, ?, ?, ?, ?)',
        [ip, username, password || '', location || '', 'installing']);
    }

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
// VPS'te açık anahtarla silinir (ssh.ts removeWireGuardClient: yedekli, doğrulamalı — ad eşleşmesi yok: "Pi" adlı istemci
// silinirken Pi5-Gateway eşi gitmesin). VPS'e ulaşılamaz ya da doğrulama tutmazsa kayıt SİLİNMEZ (VPS'te eş kalırdı);
// ?force=1 → VPS'e dokunulamasa da yalnız listeden silinir (ör. VPS artık yok).
app.delete('/api/vps/:id/clients/:clientId', async (req, res) => {
  const force = req.query.force === '1';
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    const client: any = await dbGet('SELECT * FROM wg_clients WHERE id = ? AND vps_id = ?', [req.params.clientId, req.params.id]);
    if (!client) return res.status(404).json({ error: 'Client bulunamadı' });
    const vpsLabel = server ? `${server.location || 'VPS'} (${server.ip})` : `#${req.params.id}`;
    let warning = '';
    if (server && client.public_key) {
      let why = '';
      try {
        const r = await removeWireGuardClient(
          { ip: server.ip, username: server.username, password: server.password || undefined }, client.public_key);
        if (r.result === 'failed') why = `VPS yapılandırması (wg0.conf) güncellenemedi: ${r.detail}`;
      } catch (sshErr: any) {
        why = `VPS'e ulaşılamadı: ${sshErr?.message || sshErr}`;
      }
      if (why && !force) {
        await recordEvent('vps', `VPS istemcisi silinemedi: ${client.name} — ${vpsLabel}: ${why}`, 'warning');
        return res.status(502).json({ error: `${why} — istemci listede bırakıldı`, canForce: true });
      }
      if (why) warning = `${why} — yalnız listeden silindi; VPS'te eş kalmış olabilir`;
    }

    await dbRun('DELETE FROM wg_clients WHERE id = ?', [req.params.clientId]);
    await recordEvent('vps', `VPS istemcisi silindi: ${client.name} — ${vpsLabel}${warning ? ` (${warning})` : ''}`, warning ? 'warning' : 'info');
    res.json({ success: true, warning: warning || undefined });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Ev VPN'i: Pi üzerinde WireGuard sunucusu (wgServer.ts) ───
// Dışarıdaki cihazlar QR ile Pi'ye bağlanır; trafikleri Pi'den çıkar ve yönlendirme kurallarına tabi olur. Roller: yönetici
// (ev ağı + panel) / misafir (yalnız internet). Yapılandırma ve QR her istendiğinde güncel DDNS adıyla üretilir.
const roleLabel = (r: string) => (r === 'admin' ? 'yönetici' : 'misafir');
app.get('/api/wg-server', async (_req, res) => {
  try {
    const st = await wgServerStatus();
    // piLanIp: modemde yönlendirmenin hedefi. İnternet kartı modunda Pi'nin modeme bakan adresi internet kartınınkidir.
    const wanIp = isLinux ? (await getLanIdentity().catch(() => null))?.wan?.ip || '' : '';
    res.json({ ...st, piLanIp: wanIp || (isLinux ? await getPi5LanIp().catch(() => '') : '') });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/wg-server/enable', async (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled alanı true/false olmalı' });
    const r = await setServerEnabled(enabled);
    if (!r.ok) {
      await recordEvent('vpn', `Ev VPN'i ${enabled ? 'açılamadı' : 'kapatılamadı'}: ${r.error || 'bilinmeyen hata'}`, 'warning');
      return res.status(500).json({ error: r.error || 'Uygulanamadı', result: r });
    }
    await recordEvent('vpn', enabled ? `Ev VPN'i açıldı (UDP ${WG_PORT})` : "Ev VPN'i kapatıldı");
    await wanFirewallReload(); // internet kartı açıksa Ev VPN'i portu güvenlik duvarında açılır / kapanır
    res.json({ success: true, result: r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/wg-server/peers', async (req, res) => {
  try {
    const name = validatePeerName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Ad 1-40 karakter olmalı: harf, rakam, boşluk, . _ -' });
    const role = req.body?.role ?? 'guest';
    if (!validRole(role)) return res.status(400).json({ error: 'Rol yönetici ya da misafir olmalı' });
    const r = await addPeer(name, role);
    if (r.apply && !r.apply.ok) {
      await recordEvent('vpn', `Ev VPN'i istemcisi eklendi ama Pi'ye uygulanamadı: ${name} — ${r.apply.error}`, 'warning');
      return res.status(500).json({ error: `İstemci kaydedildi ama Pi'ye uygulanamadı: ${r.apply.error}`, id: r.id });
    }
    await recordEvent('vpn', `Ev VPN'i istemcisi eklendi: ${name} (${roleLabel(role)}, ${r.ip})`);
    res.json({ success: true, id: r.id, ip: r.ip });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/wg-server/peers/:id', async (req, res) => {
  try {
    const role = req.body?.role;
    if (!validRole(role)) return res.status(400).json({ error: 'Rol yönetici ya da misafir olmalı' });
    const r = await updatePeerRole(Number(req.params.id), role);
    if (!r) return res.status(404).json({ error: 'İstemci bulunamadı' });
    if (r.apply && !r.apply.ok) return res.status(500).json({ error: `Kaydedildi ama Pi'ye uygulanamadı: ${r.apply.error}` });
    await recordEvent('vpn', `Ev VPN'i istemcisinin rolü değişti: ${r.name} → ${roleLabel(role)}`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/wg-server/peers/:id', async (req, res) => {
  try {
    const r = await deletePeer(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'İstemci bulunamadı' });
    if (r.apply && !r.apply.ok) return res.status(500).json({ error: `Silindi ama Pi'ye uygulanamadı: ${r.apply.error}` });
    await recordEvent('vpn', `Ev VPN'i istemcisi silindi: ${r.name}`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// İstemcinin gizli anahtarını içerir: önbelleğe alınmaz.
app.get('/api/wg-server/peers/:id/config', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const c = await peerConfig(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'İstemci bulunamadı' });
    res.json(c);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Dışarıdan erişim testi (wgServer.ts reachabilityTest): dış IP + DDNS, evden çıkış durakları (kaç cihaz / CGNAT) ve bağlı
// VPS tüneli üzerinden evin adresine gönderilen deneme paketleri. Arayüz sonuca göre adım adım rehberi gösterir. ~10-15 sn.
app.post('/api/wg-server/reachability', async (_req, res) => {
  try {
    const r = await reachabilityTest();
    await noteReachResult(r, 'manual');
    const ext = r.external.status === 'reachable' ? 'dışarıdan ulaşılıyor'
      : r.external.status === 'unreachable' ? 'dışarıdan ulaşılamıyor' : `dış deneme yapılamadı (${r.external.reason})`;
    await recordEvent('vpn', `Ev VPN'i erişim testi: ${ext}; evdeki cihazlar: ${r.routers.join(' → ') || 'bilinmiyor'}`,
      r.external.status === 'unreachable' ? 'warning' : 'info');
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Otomatik erişim denetimi (wgWatch.ts): Ev VPN'i açıkken 6 saatte bir; bozulunca / düzelince zile yazar. Arayüz son
// denetimi kartta gösterir.
app.get('/api/wg-server/watch', async (_req, res) => {
  res.json({ ...(await reachWatchState()), intervalH: REACH_WATCH_INTERVAL_H });
});
startReachWatch();

// ─── Pi5 ↔ VPS Connection (Gateway Tunnel) ───
app.post('/api/vps/:id/connect', async (req, res) => {
  try {
    const server: any = await dbGet('SELECT * FROM vps_servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: 'Sunucu bulunamadı' });

    // First verify VPS is reachable via SSH
    const connTest = await testSSHConnection({ ip: server.ip, username: server.username, password: server.password || undefined });
    const vpsLabel = `${server.location || 'VPS'} (${server.ip})`;
    if (!connTest.success) {
      await recordEvent('vps', `VPS'e bağlanılamadı: ${vpsLabel} — ${connTest.message}`, 'warning');
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
    await recordEvent('vps', tunnelResult ? `VPS tüneli bağlandı: ${vpsLabel}`
      : `VPS'e ulaşıldı ama Pi tüneli kurulamadı: ${vpsLabel}${tunnelError ? ` — ${tunnelError}` : ''}`, tunnelResult ? 'info' : 'warning');

    res.json({ success: true, tunnel: tunnelResult ? true : false, tunnelError: tunnelError || undefined, message: tunnelResult ? 'VPS bağlı + tünel aktif' : 'VPS bağlı (tünel Pi5 üzerinde kurulacak)' });
  } catch (e: any) {
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['error', req.params.id]);
    await recordEvent('vps', `VPS bağlantısı başarısız (#${req.params.id}): ${e.message || 'bilinmeyen hata'}`, 'warning');
    res.status(500).json({ error: e.message || 'Bağlantı başarısız' });
  }
});

app.post('/api/vps/:id/disconnect', async (req, res) => {
  try {
    await disconnectPi5FromVps(Number(req.params.id));
    await dbRun('UPDATE vps_servers SET status = ? WHERE id = ?', ['disconnected', req.params.id]);
    await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    const server: any = await dbGet('SELECT ip, location FROM vps_servers WHERE id = ?', [req.params.id]);
    const usage = await vpsRuleUsage(req.params.id).catch(() => null);
    const effect = usage ? routeEffectText(usage) : '';
    await recordEvent('vps', `VPS tüneli kesildi: ${server ? `${server.location || 'VPS'} (${server.ip})` : `#${req.params.id}`}${effect ? ` — ${effect}` : ''}`,
      usage?.block.length ? 'warning' : 'info');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// connected: wg_vps<ID> arayüzü var (Tünel Kes / Bağla düğmesi buna göre); state: el sıkışmaya göre up / connecting /
// stale (yanıt yok) / down; handshakeAge: son el sıkışmanın yaşı (sn; null = hiç). rx / tx: tünelin toplam baytları (kart
// iki okumanın farkından anlık hızı hesaplar; tünel yoksa null), at: okuma anı (ms).
app.get('/api/vps/:id/tunnel-status', async (req, res) => {
  const down = { connected: false, state: 'down', handshakeAge: null, rx: null, tx: null, at: Date.now() };
  const id = validVpsId(req.params.id);
  if (id === null) return res.json(down);
  try {
    const t = (await readVpsTunnels([id])).get(id);
    if (!t) return res.json(down);
    const x = t.state !== 'down' ? await readTunnelTransfer(t.iface) : null;
    res.json({ connected: t.state !== 'down', state: t.state, handshakeAge: t.handshakeAge, rx: x?.rx ?? null, tx: x?.tx ?? null, at: Date.now() });
  } catch { res.json(down); }
});

// "Tünel Kes" / "VPS Sil" onay metni: bu VPS'e yönlenen etkin kurallar (engellenecek / operatörden devam edecek).
app.get('/api/vps/:id/routing-usage', async (req, res) => {
  const id = validVpsId(req.params.id);
  if (id === null) return res.json({ block: [], isp: [] });
  try {
    res.json(await vpsRuleUsage(id));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/vps/:id', async (req, res) => {
  try {
    const server: any = await dbGet('SELECT ip, username, password, location FROM vps_servers WHERE id = ?', [req.params.id]);
    // Disconnect Pi5 tunnel before deleting
    await disconnectPi5FromVps(Number(req.params.id));
    // Panelden eklenen istemciler VPS'ten de kaldırılır (kayıtları aşağıda silinir; kalsalar panelde görünmeden bağlanmayı
    // sürdürürlerdi). VPS'e ulaşılamazsa silme yine yapılır, olaya yazılır.
    const clients = (await dbAll('SELECT name, public_key FROM wg_clients WHERE vps_id = ?', [req.params.id]) as any[]).filter(c => c.public_key);
    let clientNote = '';
    if (server && clients.length) {
      try {
        const rs = await removeWireGuardClients(
          { ip: server.ip, username: server.username, password: server.password || undefined }, clients.map(c => String(c.public_key)));
        const failed = rs.find(r => r.result === 'failed');
        clientNote = failed
          ? `${clients.length - rs.length + 1} istemci VPS'ten silinemedi (${failed.detail}) — VPS'te kalmış olabilir`
          : `${clients.length} istemci VPS'ten de silindi`;
      } catch (e: any) {
        clientNote = `VPS'e ulaşılamadı (${e?.message || e}) — ${clients.length} istemci VPS'te kalmış olabilir`;
      }
    }
    // Bu VPS'e yönlenen kurallar operatöre (ISP) çevrilir: "engelle" kuralları sahipsiz kalıcı engele dönmesin.
    const usage = await vpsRuleUsage(req.params.id);
    await dbRun(`UPDATE traffic_routing SET exit_node = 'isp' WHERE exit_node = ?`, [String(req.params.id)]);
    await dbRun(`UPDATE domain_routing SET exit_node = 'isp' WHERE exit_node = ?`, [String(req.params.id)]);
    await dbRun('DELETE FROM wg_clients WHERE vps_id = ?', [req.params.id]);
    await dbRun('DELETE FROM vps_servers WHERE id = ?', [req.params.id]);
    await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    const moved = [...usage.block, ...usage.isp];
    if (server) {
      const notes = [
        ...(moved.length ? [`${moved.length} kural operatöre (ISP) çevrildi: ${nameList(moved)}`] : []),
        ...(clientNote ? [clientNote] : []),
      ];
      await recordEvent('vps', `VPS silindi: ${server.location || 'VPS'} (${server.ip})${notes.length ? ` — ${notes.join('; ')}` : ''}`,
        moved.length || clientNote.includes('kalmış') ? 'warning' : 'info');
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Traffic Routing (app-based + domain-based, unified engine) ───

// Çağrılar sıraya alınır: eşzamanlı iki uygulama PI5_ROUTING'i birbirinin ortasında boşaltıp eski kuralları
// bırakabilir. Her sıradaki çalışma DB'yi kendi başında okur → en güncel durumu uygular.
let routingQueue: Promise<void> = Promise.resolve();
function runInRoutingQueue(fn: () => Promise<void>): Promise<void> {
  const next = routingQueue.then(fn, fn);
  routingQueue = next.catch(() => {});
  return next;
}
// Sırada bekleyen (henüz BAŞLAMAMIŞ) bir tam uygulama varsa yeni çağrı ona katılır: o çalışma DB'yi başladığında okuyacağı
// için bu çağrıdan önce yazılan değişikliği de uygular. Panelde arka arkaya basılan N düğme eskiden N tam uygulama
// (her biri Pi'de birkaç saniye) bekliyordu; artık en çok iki (sürmekte olan + bir sonraki). Başlamış çalışmaya katılınmaz.
let queuedFullApply: Promise<void> | null = null;
function applyAllRoutingRules(): Promise<void> {
  if (queuedFullApply) return queuedFullApply;
  const run = runInRoutingQueue(async () => {
    queuedFullApply = null;
    await applyAllRoutingRulesNow();
  });
  queuedFullApply = run;
  return run;
}

// Bir VPS'e yönlenen etkin kurallar, tünel düşünce ne olacağına göre (uygulama adı / alan adı).
async function vpsRuleUsage(vpsId: string | number): Promise<{ block: string[]; isp: string[] }> {
  const id = String(vpsId);
  const apps = await dbAll(`SELECT app_name AS name, vps_fallback FROM traffic_routing WHERE enabled = 1 AND exit_node = ? AND domains != ''`, [id]) as any[];
  const doms = await dbAll(`SELECT domain AS name, vps_fallback FROM domain_routing WHERE enabled = 1 AND exit_node = ? AND COALESCE(redirect_url, '') = ''`, [id]) as any[];
  const out = { block: [] as string[], isp: [] as string[] };
  for (const r of [...apps, ...doms]) out[normFallback(r.vps_fallback)].push(String(r.name));
  return out;
}
const nameList = (names: string[], max = 5) => names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '');
function routeEffectText(u: { block: string[]; isp: string[] }): string {
  const parts: string[] = [];
  if (u.block.length) parts.push(`${u.block.length} kural engellendi (${nameList(u.block)})`);
  if (u.isp.length) parts.push(`${u.isp.length} kural operatörden devam ediyor (${nameList(u.isp)})`);
  return parts.join('; ');
}

// Helper: collect all routing domains from both tables and apply
async function applyAllRoutingRulesNow() {
  if (!isLinux) return;
  // 1. App routing: expand domains column into individual domain entries
  const appRules = await dbAll('SELECT app_name, domains, exit_node, dpi_bypass, vps_fallback, enabled FROM traffic_routing WHERE enabled = 1 AND domains != ""');
  const domainRules = await dbAll('SELECT domain, exit_node, dpi_bypass, vps_fallback, enabled, redirect_url FROM domain_routing WHERE enabled = 1');
  // Kayıtlı olmayan VPS'e yönlenen kural (silinmiş VPS'in eski kaydı) ISP sayılır: "engelle" tablosu sahipsiz kalıcı
  // engele dönmesin.
  const vpsIds = (await dbAll('SELECT id FROM vps_servers') as any[]).map(r => Number(r.id));
  const known = new Set(vpsIds.map(String));
  const exitOf = (e: unknown) => { const x = String(e ?? 'isp'); return known.has(x) ? x : 'isp'; };
  // Yeniden açılan / yeni kurulan tünel "yanıt vermiyor" sayılmaz (izleyicinin sonraki ölçümünü beklemeden rota geri gelir).
  for (const t of (await readVpsTunnels(vpsIds).catch(() => new Map())).values()) {
    if (t.state === 'up' || t.state === 'connecting') setTunnelStale(t.vpsId, false);
  }

  const allDomains: { domain: string; exit_node: string; dpi_bypass: number; enabled: number; redirect_url?: string; vps_fallback?: string }[] = [];
  // IP aralığı girdileri (ipRanges.ts): @asn:<n>[!443] ve a.b.c.d[/nn] — DNS'siz trafik (ör. WhatsApp aramaları) için.
  const ranges: RangeRoute[] = [];
  // Hazır liste girdileri (categoryLists.ts): @list:adult / @list:gambling — işaretliyse (VPS çıkışı ya da yalnız DPI)
  // listDns.ts yolundan; yalnız DPI'da işaret 0x4000, Zapret ona bakar. Liste önbellekte yoksa indirilir (ilk açılışta birkaç sn).
  const lists: ListRoute[] = [];

  // App domains (wildcard patterns like *.whatsapp.net → whatsapp.net for dnsmasq)
  for (const rule of appRules) {
    const domains = (rule.domains as string).split(',').map((d: string) => d.trim()).filter(Boolean);
    for (const domain of domains) {
      const lt = LIST_TOKEN.exec(domain);
      if (lt) {
        if (exitOf(rule.exit_node) === 'isp' && !rule.dpi_bypass) continue; // işaretsiz: yönlendirilecek bir şey yok
        const id = lt[1] as ListId;
        await ensureList(id, Infinity);
        const info = listInfo().find(l => l.id === id);
        if (!info?.count) {
          void recordEventOnce('routing-list', `${rule.app_name} yönlendirilemedi: ${info?.error || 'hazır liste yüklenemedi'}`, 'warning', 60);
          continue;
        }
        lists.push({ id, exit_node: exitOf(rule.exit_node), dpi_bypass: rule.dpi_bypass, vps_fallback: rule.vps_fallback });
        continue;
      }
      const asn = ASN_TOKEN.exec(domain);
      if (asn) {
        const r = await getAsnPrefixes(Number(asn[1]));
        if (r.prefixes.length) ranges.push({ exit_node: exitOf(rule.exit_node), dpi_bypass: rule.dpi_bypass, prefixes: r.prefixes, excludeWeb: !!asn[2], vps_fallback: rule.vps_fallback });
        continue;
      }
      const cidr = normalizeCidr(domain);
      if (cidr) {
        ranges.push({ exit_node: exitOf(rule.exit_node), dpi_bypass: rule.dpi_bypass, prefixes: [cidr], excludeWeb: false, vps_fallback: rule.vps_fallback });
        continue;
      }
      // dnsmasq ipset handles subdomains automatically, strip leading *.
      const clean = domain.replace(/^\*\./, '');
      allDomains.push({ domain: clean, exit_node: exitOf(rule.exit_node), dpi_bypass: rule.dpi_bypass, enabled: 1, vps_fallback: rule.vps_fallback });
    }
  }

  // Custom domain rules — redirect_url dahil (yoksa DNS-redirect kuralları kaybolur)
  for (const rule of domainRules) {
    allDomains.push({ domain: rule.domain, exit_node: exitOf(rule.exit_node), dpi_bypass: rule.dpi_bypass, enabled: 1, redirect_url: rule.redirect_url || undefined, vps_fallback: rule.vps_fallback });
  }
  // Zapret sayfasının ek DPI siteleri: ISP + DPI alan adı gibi işaretlenir (Zapret işarete bakar). Aynı alan adının
  // Routing kuralı varsa o geçerli (çıkışı ve DPI'ı kural belirler).
  const ruled = new Set(allDomains.map(d => d.domain.replace(/^\*\./, '')));
  for (const z of await dbAll("SELECT domain FROM zapret_domains WHERE enabled = 1 AND list_type = 'hostlist'") as any[]) {
    const d = cleanDpiDomain(z.domain);
    if (d && !ruled.has(d)) allDomains.push({ domain: d, exit_node: 'isp', dpi_bypass: 1, enabled: 1 });
  }

  try {
    await applyDomainRouting(allDomains, ranges, { staleVps: staleTunnels(), lists });
  } finally {
    // Routing'deki "DPI" kurallarının alan adları Zapret listesine de yazılır (zapret.ts); routing'i bekletmez.
    void applyZapret().then(r => {
      if (r.ok) return;
      console.error('[zapret] uygulanamadı:', r.error);
      void recordEventOnce('zapret', `Zapret'e uygulanamadı: ${r.error || 'bilinmeyen hata'}`, 'warning', 60);
    });
  }
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

// Hazır listeler (Yetişkin / Kumar) saatte bir denetlenir, 24 saatten eskiyse indirilir. İçerik değiştiyse ve bir Routing
// satırı kullanıyorsa (VPS ya da DPI) yeniden uygulanır — VPS satırı Pi-hole'u yeniden başlattığı için (DNS ~1-2 sn) yalnız
// gece 03-06 arasında; gündüz gelen değişiklik geceye kalır (arada başka bir kural değişikliği zaten güncel listeyi uygular).
let listApplyPending = false;
async function refreshRoutingLists() {
  if (!isLinux) return;
  try {
    const rows = await dbAll(`SELECT domains FROM traffic_routing WHERE enabled = 1 AND domains LIKE '%@list:%'
      AND (COALESCE(exit_node, 'isp') != 'isp' OR dpi_bypass = 1)`) as any[];
    const used = new Set<ListId>();
    for (const r of rows) for (const d of String(r.domains).split(',')) { const m = LIST_TOKEN.exec(d.trim()); if (m) used.add(m[1] as ListId); }
    if (!used.size) return;
    if ((await ensureLists([...used])).length) listApplyPending = true;
    const h = new Date().getHours();
    if (listApplyPending && h >= 3 && h < 6) {
      listApplyPending = false;
      await applyAllRoutingRules();
    }
  } catch (e: any) {
    console.error('[routing] hazır listeler yenilenemedi:', e?.message || e);
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
             t.exit_node, t.dpi_bypass, t.domains, COALESCE(t.vps_fallback, 'block') AS vps_fallback,
             s.ip as vps_ip, s.location as vps_location
      FROM traffic_routing t
      LEFT JOIN vps_servers s ON t.vps_id = s.id
      ORDER BY t.category, t.app_name
    `);
    // Hazır listeli satırların bilgisi (ad sayısı, güncellenme): önbellekten yüklenir, yoksa arka planda indirilir.
    void ensureLists(LIST_IDS, Infinity).catch(() => undefined);
    // zapret: DPI kuralı açık ama Zapret çalışmıyorsa Routing kartında uyarı için
    res.json({ rules, lists: listInfo(), listDns: listDnsStats(), zapret: await zapretBrief() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/routing/rules/:id', async (req, res) => {
  try {
    const { route_type, vps_id, enabled, exit_node, dpi_bypass, vps_fallback } = req.body;
    if (vps_fallback !== undefined && vps_fallback !== 'block' && vps_fallback !== 'isp') {
      return res.status(400).json({ error: "vps_fallback 'block' ya da 'isp' olmalı" });
    }
    const updates: string[] = [];
    const params: any[] = [];
    if (route_type !== undefined) { updates.push('route_type = ?'); params.push(route_type); }
    if (vps_id !== undefined) { updates.push('vps_id = ?'); params.push(vps_id || null); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (exit_node !== undefined) { updates.push('exit_node = ?'); params.push(exit_node); }
    if (dpi_bypass !== undefined) { updates.push('dpi_bypass = ?'); params.push(dpi_bypass ? 1 : 0); }
    if (vps_fallback !== undefined) { updates.push('vps_fallback = ?'); params.push(vps_fallback); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE traffic_routing SET ${updates.join(', ')} WHERE id = ?`, params);
    // Apply unified routing (app + domain rules together)
    await applyAllRoutingRules();
    if (dpi_bypass || enabled) {
      const r: any = await dbGet('SELECT enabled, dpi_bypass FROM traffic_routing WHERE id = ?', [req.params.id]);
      if (r?.enabled && r.dpi_bypass) await autoStartZapret();
    }
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
    const domains = await dbAll(`SELECT ${DOMAIN_ROUTING_COLUMNS} FROM domain_routing ORDER BY domain`);
    res.json({ domains, zapret: await zapretBrief() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routing/domains', async (req, res) => {
  try {
    const { domain, route_type, description, exit_node, dpi_bypass, redirect_url, vps_fallback } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain gerekli' });
    const cleanDomain = domain.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
    await dbRun('INSERT INTO domain_routing (domain, route_type, description, exit_node, dpi_bypass, redirect_url, vps_fallback) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cleanDomain, route_type || 'direct', description || '', exit_node || 'isp', dpi_bypass ? 1 : 0, redirect_url || '', normFallback(vps_fallback)]);
    // Apply unified routing (app + domain rules together)
    await applyAllRoutingRules();
    if (dpi_bypass && !redirect_url) await autoStartZapret();
    const domains = await dbAll(`SELECT ${DOMAIN_ROUTING_COLUMNS} FROM domain_routing ORDER BY domain`);
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
    const { route_type, enabled, description, exit_node, dpi_bypass, redirect_url, vps_fallback } = req.body;
    if (vps_fallback !== undefined && vps_fallback !== 'block' && vps_fallback !== 'isp') {
      return res.status(400).json({ error: "vps_fallback 'block' ya da 'isp' olmalı" });
    }
    const updates: string[] = [];
    const params: any[] = [];
    if (route_type !== undefined) { updates.push('route_type = ?'); params.push(route_type); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (exit_node !== undefined) { updates.push('exit_node = ?'); params.push(exit_node); }
    if (dpi_bypass !== undefined) { updates.push('dpi_bypass = ?'); params.push(dpi_bypass ? 1 : 0); }
    if (redirect_url !== undefined) { updates.push('redirect_url = ?'); params.push(redirect_url); }
    if (vps_fallback !== undefined) { updates.push('vps_fallback = ?'); params.push(vps_fallback); }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await dbRun(`UPDATE domain_routing SET ${updates.join(', ')} WHERE id = ?`, params);
    await applyAllRoutingRules();
    if (dpi_bypass || enabled) {
      const r: any = await dbGet('SELECT enabled, dpi_bypass, redirect_url FROM domain_routing WHERE id = ?', [req.params.id]);
      if (r?.enabled && r.dpi_bypass && !r.redirect_url) await autoStartZapret();
    }
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
const DOMAIN_ROUTING_COLUMNS = "id, domain, route_type, description, enabled, exit_node, dpi_bypass, redirect_url, COALESCE(vps_fallback, 'block') AS vps_fallback, created_at";
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
    const parent = await dbGet('SELECT id, domain, exit_node, dpi_bypass, redirect_url, parent_id, vps_fallback FROM domain_routing WHERE id = ?', [ruleId]);
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
        await dbRun(`INSERT INTO domain_routing (domain, route_type, description, exit_node, dpi_bypass, redirect_url, parent_id, vps_fallback)
          VALUES (?, 'direct', ?, ?, ?, '', ?, ?)`,
          [d, `Öneri: ${parent.domain}`, parent.exit_node || 'isp', parent.dpi_bypass ? 1 : 0, parent.parent_id ?? parent.id, normFallback(parent.vps_fallback)]);
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
// Özel kurallar + GERÇEK önizleme: yüklenecek yapılandırmayla aynı üreticiden (services.ts buildNftables); kuralların
// yüklü olup olmadığı ve diskteki dosyanın güncel olup olmadığı (pending: Deploy Et gerekli).
app.get('/api/firewall/rules', async (_req, res) => {
  try {
    const rules = await dbAll(FW_RULES_SQL);
    const lan = await lanNetworks().catch(() => [] as string[]);
    let preview: any = null;
    if (isLinux) {
      try {
        const cfg = await dbAll("SELECT key, value FROM service_config WHERE service = 'nftables' AND key IN ('lan_iface', 'wan_iface')");
        const m: Record<string, string> = {};
        (cfg as any[]).forEach(r => { m[r.key] = r.value; });
        const b = await systemServices.buildNftables({ lan: m.lan_iface, wan: m.wan_iface }, buildCustomFwRules(rules as any[], lan));
        const loaded = (await execFileP('nft', ['list', 'table', 'inet', 'pi5_filter'], { timeout: 10000 }).then(() => true, () => false));
        let onDisk = '';
        try { onDisk = require('fs').readFileSync('/etc/nftables.conf', 'utf8'); } catch { /* yok */ }
        preview = { input: b.input, forward: b.forward, nat: b.nat, mode: b.mode, lanIfs: b.lanIfs, wanIfs: b.wanIfs,
          deployed: onDisk.includes('table inet pi5_filter'), loaded, pending: onDisk !== b.config };
      } catch (e: any) {
        preview = { error: String(e?.message || e) };
      }
    }
    // ignored: panele herkesin / tüm ev ağının erişimini kestiği için uygulanmayan (eski sürümde kaydedilmiş) kural.
    res.json({ rules: (rules as any[]).map(r => ({ ...r, ignored: fwRuleIgnored(r, lan) })), preview });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kural ekle: doğrulanır, isteği yapan cihazın panel erişimi denetlenir, kaydedilir ve (panelin güvenlik duvarı kuruluysa)
// hemen uygulanır — uygulanamazsa kayıt geri alınır (DB ile yüklü kurallar ayrışmasın).
app.post('/api/firewall/rules', async (req, res) => {
  try {
    const v = validateFwRule(req.body);
    if ('error' in v) return res.status(400).json({ error: v.error });
    if (isPanelLockoutForAll(v.rule)) return res.status(400).json({ error: 'Bu kural panele herkesin erişimini keser (TCP 80) — eklenmedi' });
    if (blocksWholeLan(v.rule, await lanNetworks())) return res.status(400).json({ error: 'Bu kural panele tüm ev ağının erişimini keser — eklenmedi' });
    const out = await withFwLock(async () => {
      const verdict = await fwAccessVerdict([...(await dbAll(FW_RULES_SQL) as any[]), v.rule], req);
      if (verdict.error) return { code: 409, body: { error: verdict.error } };
      const id = await dbInsert('INSERT INTO routing_rules (type, target, port, proto, action, enabled) VALUES (?, ?, ?, ?, ?, 1)',
        [v.rule.type, v.rule.target, v.rule.port, v.rule.proto, v.rule.action]);
      let applied = false;
      if (isLinux && panelFirewallDeployed()) {
        try {
          await applyPanelFirewallNow();
          applied = true;
        } catch (e: any) {
          await dbRun('DELETE FROM routing_rules WHERE id = ?', [id]);
          return { code: 500, body: { error: `Kural uygulanamadı, eklenmedi: ${e?.message || e}` } };
        }
      }
      await recordEvent('firewall', `Güvenlik duvarı kuralı eklendi: ${describeRule(v.rule)} → ${v.rule.action}${applied ? '' : ' (güvenlik duvarı henüz uygulanmadı)'}`);
      return { code: 200, body: { success: true, id, applied, warning: verdict.warning } };
    });
    res.status(out.code).json(out.body);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kuralı aç / kapat (aynı denetim ve geri alma).
// Aç / kapat: kapatmak da denetlenir (ör. yöneticinin "izin" kuralını kapatmak arkasındaki "engelle"yi açığa çıkarır).
app.put('/api/firewall/rules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const enabled = req.body?.enabled ? 1 : 0;
    const out = await withFwLock(async () => {
      const row: any = await dbGet('SELECT id, type, target, port, proto, action, enabled FROM routing_rules WHERE id = ?', [id]);
      if (!row) return { code: 404, body: { error: 'Kural bulunamadı' } };
      const rows = (await dbAll(FW_RULES_SQL) as any[]).map(r => (r.id === id ? { ...r, enabled } : r));
      const verdict = await fwAccessVerdict(rows, req);
      if (verdict.error) return { code: 409, body: { error: verdict.error } };
      await dbRun('UPDATE routing_rules SET enabled = ? WHERE id = ?', [enabled, id]);
      let applied = false;
      if (isLinux && panelFirewallDeployed()) {
        try {
          await applyPanelFirewallNow();
          applied = true;
        } catch (e: any) {
          await dbRun('UPDATE routing_rules SET enabled = ? WHERE id = ?', [row.enabled, id]);
          return { code: 500, body: { error: `Kural uygulanamadı, değişmedi: ${e?.message || e}` } };
        }
      }
      return { code: 200, body: { success: true, applied, warning: verdict.warning } };
    });
    res.status(out.code).json(out.body);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Sil: silme de denetlenir (izin kuralını silmek arkasındaki "engelle"yi açığa çıkarabilir); uygulanamazsa geri eklenir.
app.delete('/api/firewall/rules/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const out = await withFwLock(async () => {
      const row: any = await dbGet('SELECT id, type, target, port, proto, action, enabled FROM routing_rules WHERE id = ?', [id]);
      if (!row) return { code: 404, body: { error: 'Kural bulunamadı' } };
      const verdict = await fwAccessVerdict((await dbAll(FW_RULES_SQL) as any[]).filter(r => r.id !== id), req);
      if (verdict.error) return { code: 409, body: { error: verdict.error } };
      await dbRun('DELETE FROM routing_rules WHERE id = ?', [id]);
      let applied = false;
      if (isLinux && panelFirewallDeployed()) {
        try {
          await applyPanelFirewallNow();
          applied = true;
        } catch (e: any) {
          await dbRun('INSERT INTO routing_rules (id, type, target, port, proto, action, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [row.id, row.type, row.target, row.port ?? '', row.proto ?? '', row.action, row.enabled]);
          return { code: 500, body: { error: `Kural silinemedi (güvenlik duvarı yeniden uygulanamadı): ${e?.message || e}` } };
        }
      }
      const d = validateFwRule(row);
      await recordEvent('firewall', `Güvenlik duvarı kuralı silindi: ${'rule' in d ? describeRule(d.rule) : `${row.type} ${row.target}`}`);
      return { code: 200, body: { success: true, applied, warning: verdict.warning } };
    });
    res.status(out.code).json(out.body);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Bandwidth Monitor ───
app.get('/api/bandwidth/live', async (_req, res) => {
  try {
    const devices = await dbAll('SELECT mac_address, hostname, ip_address FROM devices');
    if (isLinux) {
      // Cihaz başı gerçek ölçüm (bandwidth.ts: nftables sayaçları). Eskiden arayüz toplamı cihaz sayısına eşit bölünüyordu.
      // interfaces: kiosk sayfası arayüz toplamlarını buradan okur (değişmedi).
      const bw = await getBandwidthLive();
      const [{ counters, rates }, macs] = await Promise.all([sampleBandwidth(), neighborMacs()]);
      res.json({ live: buildLive(devices as any[], counters, rates, macs), interfaces: bw.interfaces });
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

// Ağ haritası: cihaz → Pi → çıkış (yerel / DPI / VPS tüneli) ve her bağlantının canlı hızı (topology.ts). Sayaçlar
// okunamazsa (nft yok/hata) harita yine çizilir, accounting=false ile hızlar sıfırdır. ?content=1 (yalnız panelin haritası;
// kiosk istemez): cihaz başına anlık içerik rozetleri (contentActivity.ts, Pi-hole sorgu kaydı).
app.get('/api/topology/live', async (req, res) => {
  try {
    const [devices, vps] = await Promise.all([
      dbAll('SELECT mac_address, ip_address, hostname, device_type, blocked FROM devices'),
      dbAll('SELECT id, ip, location, status FROM vps_servers ORDER BY id'),
    ]);
    let accounting = false;
    let markCounters = new Map<string, { down: number; up: number }>();
    let markRates = new Map<string, { downBps: number; upBps: number }>();
    if (isLinux) {
      try {
        ({ markCounters, markRates } = await sampleBandwidth());
        accounting = true;
      } catch (e: any) {
        console.warn(`[topology] sayaçlar okunamadı: ${String(e?.stderr || e?.message || e).trim()}`);
      }
    }
    // Pi'nin adresi: cihazların ağ geçidi olarak kullandığı (sabit adres modunda 192.168.0.1), yoksa modem tarafı.
    const [neighbors, handshakes, modem, localIps, lan] = isLinux
      ? await Promise.all([readNeighbors(), readHandshakes(), readDefaultRoute(), readLocalIps(), getLanIdentity()])
      : [new Map(), new Map(), null, new Set<string>(), null];
    const lanIp = lan?.client.ip || lan?.transit.ip || '';
    // Ev Wi-Fi'ı açıkken Pi'nin kendi yayınına bağlı cihazlar kesin bilinir (istasyon listesi).
    const ns = isLinux ? readNetModeState() : null;
    const piWifi = ns && ns.homeStage !== 'none' && ns.homeIface ? await readHomeStations(ns.homeIface, HOME_BRIDGE) : new Set<string>();
    // Uyduların (R2) yayınına bağlı cihazlar da kesin Wi-Fi (uydunun dakikalık bildiriminden).
    if (isLinux) for (const m of await satelliteStations()) piWifi.add(m);
    // Ev VPN'i istemcileri: panelin kaydı (ad, rol) + el sıkışma (topology.ts VpnPeer). Tablo yoksa (hiç kurulmadıysa) boş.
    const [peerRows, peerHs] = isLinux
      ? await Promise.all([dbAll('SELECT ip, name, role FROM wg_server_peers').catch(() => []), readPeerHandshakes(WG_IFACE)])
      : [[], new Map<string, number>()];
    const vpnPeers = (peerRows as { ip: string; name: string; role: string }[]).map(p => ({
      ip: String(p.ip), name: String(p.name), role: p.role === 'admin' ? 'admin' as const : 'guest' as const, handshake: peerHs.get(String(p.ip)) || 0,
    }));
    const now = Date.now();
    noteTopologyView(); // harita açıkken bağlantı türü ölçümü sıklaşır
    // İçerik: Pi-hole istemciyi IP'siyle kaydeder; DNS'i IPv6'dan soran cihazın adresleri MAC'le bulunur.
    const wantContent = req.query.content === '1';
    if (wantContent) noteContentView();
    const v6OfMac = new Map<string, string[]>();
    if (wantContent && isLinux) for (const [ip, n] of await readNeighbors6()) v6OfMac.set(n.mac, [...(v6OfMac.get(n.mac) || []), ip]);
    const topo = buildTopology({
      devices: devices as any[], vps: vps as any[], neighbors, markCounters, markRates,
      recentIps: noteActivity(markRates, now), handshakes, ifacesUp: isLinux ? readIfaces() : new Set(),
      lanIp, hostname: require('os').hostname(), modem, localIps, accounting, nowS: Math.floor(now / 1000),
      probe: probeSamples, probeBaseMs: probeBaseline(), onSetupWifi: ip => inCidr(ip, AP_NET),
      onPiWifi: mac => piWifi.has(mac), vpnPeers,
      content: wantContent ? (ip, mac) => contentForClients([ip, ...(v6OfMac.get(mac) || [])], now / 1000) : undefined,
    });
    if (wantContent) topo.content = contentStatus();
    res.json(topo);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Trafik Kontrol → Trafik Analizi: 5 dk'lık cihaz × yol (yerel / DPI / VPS) bayt kayıtları (trafficHistory.ts) ve
// Pi-hole sorgularından uygulama kullanımı (sorgu sayısı; bayt değil). range: 24h (saatlik) | 7d.
app.get('/api/traffic/analytics', async (req, res) => {
  try {
    const range = req.query.range === '7d' ? '7d' : '24h';
    const [usage, devices, appRows, vps] = await Promise.all([
      usageSummary(range),
      dbAll('SELECT mac_address, ip_address, hostname, device_type FROM devices'),
      dbAll('SELECT app_name, category, domains FROM traffic_routing'),
      dbAll('SELECT id, ip, location FROM vps_servers ORDER BY id'),
    ]);
    const macOfIp = new Map<string, string>();
    for (const d of devices as any[]) if (d.ip_address) macOfIp.set(String(d.ip_address), String(d.mac_address).toLowerCase());
    if (isLinux) for (const [ip, n] of await readNeighbors()) macOfIp.set(ip, n.mac);
    let apps: any = { available: false, apps: [], matchedQueries: 0, totalQueries: 0 };
    if (isLinux) {
      try { apps = await appActivity(range, appDefsFrom(appRows as any[]), ip => macOfIp.get(ip)); }
      catch (e: any) { apps = { ...apps, error: `Pi-hole sorgu kayıtları okunamadı: ${String(e?.message || e)}` }; }
    }
    res.json({
      range, recording: isLinux, now: Math.floor(Date.now() / 1000), ...usage, apps,
      deviceInfo: (devices as any[]).map(d => ({ mac: String(d.mac_address).toLowerCase(), ip: d.ip_address, hostname: d.hostname, type: d.device_type })),
      vps,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Cihaz Rolleri (R0, salt okunur): takılı Ethernet / Wi-Fi donanımı ve her ağ rolünün uygunluğu (hardware.ts).
app.get('/api/system/hardware', async (_req, res) => {
  try {
    if (!isLinux) return res.json({ supported: false });
    let piDhcp = false;
    try { piDhcp = (await execFileP('pihole-FTL', ['--config', 'dhcp.active'], { timeout: 5000 })).stdout.trim() === 'true'; } catch { /* FTL yok */ }
    const ns = readNetModeState();
    const hw = await readHardware({
      netStage: ns?.stage || 'none', apStage: ns?.apStage || 'none', apIface: ns?.apIface || null, piDhcp,
      homeStage: ns?.homeStage || 'none', homeIface: ns?.homeIface || null,
      role: STARTUP_ROLE, satellites: isSatellite() ? 0 : (await listSatellites().catch(() => [])).length,
      paired: isSatellite() && !!readSatState(), meshConfigured: (await mainMeshState().catch(() => null))?.configured || false,
      wanStage: ns?.wanStage || 'none', wanPort: ns?.wanPort || null, wanDev: ns?.wanDev || null, wanSingle: !!ns?.wanSingle, wanSsid: ns?.wanSsid || '',
      bakStage: ns?.bakStage || 'none', bakDev: ns?.bakStage === 'on' ? (readFailoverStatus()?.backupDev || ns.bakDev || null) : null,
      bakActive: ns?.bakStage === 'on' && readFailoverStatus()?.active === 'backup',
      repStage: ns?.repStage || 'none', repPort: ns?.repPort || null, repSsid: ns?.repSsid || '', repDhcp: ns?.repDhcp || 'relay',
      repLanState: ns?.repStage === 'on' ? (readRepLanStatus()?.state || '') : '',
    });
    res.json({ supported: true, ...hw, roles: evaluateRoles(hw) });
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

// ─── Kota ve hız sınırları (qos.ts): cihaz başına hız (indirme / yükleme) ve günlük / aylık kota, Pi'de uygulanır ───
// Eskiden yalnız veritabanına yazılıyordu (ekleme de yoktu). Hız kbps, kota MB; boş / 0 = sınırsız.
app.get('/api/bandwidth/limits', async (_req, res) => {
  try {
    res.json(await qosStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bandwidth/limits/:mac', async (req, res) => {
  try {
    const v = validateLimit(req.params.mac, req.body);
    if ('error' in v) return res.status(400).json({ error: v.error });
    if (await isProtectedMac(v.limit.device_mac)) {
      return res.status(400).json({ error: "Bu MAC modemin ya da Pi'nin: sınır konamaz (tüm evin internet trafiği bu adresten geçer)" });
    }
    await saveLimit(v.limit);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/bandwidth/limits/:mac', async (req, res) => {
  try {
    if (!await deleteLimit(normMac(req.params.mac))) return res.status(404).json({ error: 'Bu cihaz için sınır yok' });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Kotayı sıfırla: seçilen dönemin sayacı bu andan başlar (kota dolmuşsa sınır hemen kalkar).
app.post('/api/bandwidth/limits/:mac/reset', async (req, res) => {
  try {
    const period = req.body?.period;
    if (period !== 'daily' && period !== 'monthly') return res.status(400).json({ error: 'Dönem günlük ya da aylık olmalı' });
    if (!await resetQuota(normMac(req.params.mac), period)) return res.status(404).json({ error: 'Bu cihaz için sınır yok' });
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
// Ölçüm (speedtest.ts) + kayıt tek işlemdir: manuel test otomatik ölçüm sürerken gelirse ikinci ölçüm başlatılmaz, aynı
// sonucu alır (eskiden iki ölçüm aynı anda hattı paylaşıp ikisi de düşük çıkabilirdi) ve sonuç bir kez kaydedilir.
let speedtestRun: Promise<SpeedResult> | null = null;
function measureAndStore(): Promise<SpeedResult> {
  if (!speedtestRun) {
    speedtestRun = runSpeedTest().then(async r => {
      await dbRun(
        'INSERT INTO speed_tests (download_mbps, upload_mbps, ping_ms, jitter_ms, packet_loss, server, isp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [r.download_mbps, r.upload_mbps, r.ping_ms, r.jitter_ms, r.packet_loss, r.server, r.isp]
      );
      return r;
    }).finally(() => { speedtestRun = null; });
  }
  return speedtestRun;
}

app.post('/api/speedtest/run', async (_req, res) => {
  try {
    const result = await measureAndStore();
    res.json({ success: true, result: { ...result, timestamp: new Date().toISOString() } });
  } catch (e: any) {
    res.status(e instanceof SpeedtestUnavailable ? 503 : 500).json({ error: e.message });
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
    try {
      const result = await measureAndStore();
      console.log(`[SpeedTest] Otomatik ölçüm kaydedildi: ${result.download_mbps}↓ / ${result.upload_mbps}↑ Mbps, ping ${result.ping_ms}ms, ${result.server}`);
    } catch (e: any) {
      if (e instanceof SpeedtestUnavailable) console.warn(`[SpeedTest] Otomatik ölçüm atlandı — ${e.message}`);
      else console.error('[SpeedTest] Otomatik ölçüm hatası:', e?.message || e);
    }
    // Retention temizliği (ölçüm başarısız olsa da yapılır)
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
        if (fs.existsSync(NET_MODE_SCRIPT) && (ns?.stage === 'static' || ns?.apStage === 'on' || ns?.wanStage === 'on' || ns?.repStage === 'on')) {
          const n = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
          if (n.code === 0 && ns?.stage === 'static' && n.kv.guard_result === 'emergency') {
            await addAlert('health', 'critical', 'Sabit IP profili yüklenemedi — Pi adresini acil modda tutuyor (menü → DHCP Ayarları)', 'netmode');
          }
          if (n.code === 0 && n.kv.ap_stage === 'on' && n.kv.ap_active !== '1') {
            await addAlert('health', 'warning', 'Kurulum Wi-Fi yayını kapalı — Pi bir sonraki açılışta ya da NetworkManager yeniden başlayınca yeniden açmayı dener', 'netmode-ap');
          }
          // Ev Wi-Fi'ı kalıcıyken köprü ya da yayın düşmüşse (köprü kurulamadıysa Pi köprüsüz çalışır, ev ağı kablodan sürer).
          if (n.code === 0 && n.kv.home_stage === 'on' && (n.kv.home_active !== '1' || n.kv.br_active !== '1')) {
            await addAlert('health', 'warning', n.kv.br_active !== '1'
              ? "Ev Wi-Fi köprüsü kurulamadı — Pi köprüsüz çalışıyor, ev Wi-Fi'ı yayında değil (Cihaz Rolleri)"
              : "Ev Wi-Fi yayını kapalı — Pi bir sonraki açılışta ya da NetworkManager yeniden başlayınca yeniden açmayı dener", 'netmode-home');
          }
          // İnternet kartı kalıcıyken bağlantı yok ya da güvenlik duvarı yüklü değil (ev ağı çalışır, internet yok).
          if (n.code === 0 && n.kv.wan_stage === 'on' && (n.kv.wan_up !== '1' || n.kv.wan_fw !== '1')) {
            const why = n.kv.wan_fw !== '1' ? 'güvenlik duvarı yüklü değil'
              : n.kv.wan_carrier !== '1' ? `kartta (${n.kv.wan_port}) kablo yok` : 'bağlantı kurulamadı';
            // Yedek hatta geçilmişse ev ağı internette: kritik değil.
            if (n.kv.bak_active === 'backup') {
              await addAlert('health', 'warning', `İnternet kartı çalışmıyor: ${why} — yedek hat devrede, ev ağı internette (Cihaz Rolleri → WAN router)`, 'netmode-wan');
            } else {
              await addAlert('health', 'critical', `İnternet kartı çalışmıyor: ${why} — ev ağı çalışıyor, internet yok (Cihaz Rolleri → WAN router)`, 'netmode-wan');
            }
          }
          // Yedek hat kalıcıyken korumasız / izleyicisiz ya da kendisi çalışmıyor (ana hat düşerse geçiş yapılamaz).
          if (n.code === 0 && n.kv.bak_stage === 'on') {
            if (n.kv.bak_fw !== '1' || n.kv.bak_watch !== '1') {
              await addAlert('health', 'warning', n.kv.bak_fw !== '1'
                ? 'Yedek hat güvenlik duvarı yüklü değil — Pi bir sonraki açılışta yükler (Cihaz Rolleri → Yedek hat)'
                : 'Yedek hat izleyicisi çalışmıyor — ana hat düşerse yedek hatta geçilemez (Cihaz Rolleri → Yedek hat)', 'netmode-bak-health');
            } else if (n.kv.bak_kind === 'eth' && n.kv.bak_active !== 'backup' && n.kv.bak_backup_ok === '0') {
              // Telefon hotspot'u / USB paylaşımı çoğu zaman kapalı tutulur: yalnız sürekli bağlı Ethernet yedek hatta uyarılır.
              await addAlert('health', 'warning', `Yedek hat yanıt vermiyor (${n.kv.bak_dev || 'arayüz yok'}) — ana hat düşerse geçiş yapılamaz; modemi / telefonu denetleyin`, 'netmode-bak-health');
            }
          }
          // Wi-Fi köprüsü (aynı ağ) kalıcıyken: üst Wi-Fi kopuk (ev tarafının interneti yok), izleyici durmuş ya da eth0
          // kablosu hâlâ modemde (ev tarafı kapalı).
          if (n.code === 0 && n.kv.rep_stage === 'on') {
            const lan = readRepLanStatus();
            if (n.kv.rep_up !== '1') {
              await addAlert('health', 'critical', `Wi-Fi köprüsü: üst Wi-Fi'a (${n.kv.rep_ssid || '?'}) bağlı değil — ev tarafındaki cihazların interneti yok; modem açık mı, Pi sinyal alıyor mu (Cihaz Rolleri → Wi-Fi köprüsü)`, 'netmode-rep');
            } else if (!lan || Date.now() / 1000 - lan.checked > 60) {
              await addAlert('health', 'warning', 'Wi-Fi köprüsü izleyicisi çalışmıyor — ev tarafı (ARP vekili, DHCP) denetlenmiyor; Pi yeniden başlatılınca açılır', 'netmode-rep');
            } else if (lan.state === 'modem') {
              await addAlert('health', 'warning', `Wi-Fi köprüsü: ${n.kv.rep_lan || 'eth0'} kablosu hâlâ modeme bağlı — ev tarafı kapalı; kabloyu arkadaki cihaza / anahtara takın`, 'netmode-rep');
            }
          }
        }
      } catch (e: any) {
        console.error('[health] DHCP/sabit adres kontrolü başarısız:', e?.message || e);
      }

      // Fail2Ban: ev ağı değiştiyse (sabit adres, internet kartı, Wi-Fi köprüsü) muaf liste yeniden yazılır — kendi try'ı.
      try {
        const f2b = await ensureFail2ban();
        if (f2b && !f2b.ok) await recordEventOnce('fail2ban', `Fail2Ban ayarları uygulanamadı: ${f2b.error || 'bilinmeyen hata'}`, 'warning', 360);
      } catch (e: any) {
        console.error('[fail2ban] denetim başarısız:', e?.message || e);
      }

      // Olay geçmişi: arka planda gerçekleşen hatalar (Cron görevi, panel güncellemesi) — kendi try'ı.
      try {
        await recordBackgroundFailures();
      } catch (e: any) {
        console.error('[olay] arka plan denetimi başarısız:', e?.message || e);
      }

      // Cleanup old alerts (30 days)
      await dbRun(`DELETE FROM alerts WHERE created_at < datetime('now', '-30 days')`);
    } catch { /* silent */ }
  };
  // Run first check after 30 seconds, then every 5 minutes
  setTimeout(healthCheck, 30000);
  setInterval(healthCheck, 300000);
}

// ─── VPS tünel izleyicisi (30 sn) ───
// Arayüz ayakta ama VPS el sıkışmaya yanıt vermiyorsa (VPS kapalı, UDP 51820 kesik) bu VPS'e yönlenen trafik karşıya
// ulaşmaz. Uyarı yalnız DURUM DEĞİŞİNCE yazılır: 'yanıt yok' iki ardışık ölçümde (≥30 sn) sürerse bir kez; tünel yeniden
// yanıt verince okunmuş bilgi satırı. Arayüz yoksa (kesilmiş / açılamamış) 5 dk'lık sağlık denetimi uyarır (service:wireguard).
if (isLinux) {
  const staleTicks = new Map<number, number>();
  let routesDirty = false; // rota senkronu başarısız olduysa sonraki turda yeniden denenir
  let lastWatchError = ''; // aynı hata her 30 sn'de günlüğe yazılmasın
  const lastTunnelAlert = (source: string) =>
    dbGet(`SELECT severity FROM alerts WHERE type = 'health' AND source = ? ORDER BY id DESC LIMIT 1`, [source]);
  const fmtAge = (s: number) => (s < 120 ? `${s} sn` : s < 7200 ? `${Math.floor(s / 60)} dk` : `${Math.floor(s / 3600)} sa`);
  const watchVpsTunnels = async () => {
    try {
      const servers = await dbAll('SELECT id, ip, location FROM vps_servers') as any[];
      const tunnels = await readVpsTunnels(servers.map(s => Number(s.id)));
      let changed = false;
      for (const s of servers) {
        const t = tunnels.get(Number(s.id));
        if (!t) continue;
        const src = `vps-tunnel:${t.iface}`;
        const label = `${s.location || 'VPS'} (${s.ip})`;
        if (t.state === 'stale') {
          const n = (staleTicks.get(t.vpsId) || 0) + 1;
          staleTicks.set(t.vpsId, n);
          if (n < 2) continue;
          // Onaylandı: tünel rotası bu VPS'in tablolarından çıkar (engelle → hemen hata, operatörden devam → ISP).
          if (setTunnelStale(t.vpsId, true)) changed = true;
          const last = await lastTunnelAlert(src);
          if (last && last.severity === 'warning') continue;
          const age = t.handshakeAge === null ? 'hiç el sıkışma olmadı' : `son el sıkışma ${fmtAge(t.handshakeAge)} önce`;
          const effect = routeEffectText(await vpsRuleUsage(t.vpsId));
          await dbRun(`INSERT INTO alerts (type, severity, message, source) VALUES ('health', 'warning', ?, ?)`,
            [`VPS tüneli yanıt vermiyor: ${label} — ${age}; VPS kapalı ya da UDP 51820 erişilemiyor olabilir (VPS Yönetimi → internet kontrolü)${effect ? `. ${effect}` : ''}`, src]);
          continue;
        }
        staleTicks.set(t.vpsId, 0);
        // Açık / yeni kuruluyor / kapalı: onay düşer (kapalıda çekirdek tünel rotasını zaten kaldırmıştır).
        if (setTunnelStale(t.vpsId, false)) changed = true;
        if (t.state !== 'up') continue; // connecting / down → uyarı yok
        const last = await lastTunnelAlert(src);
        if (last && last.severity === 'warning') {
          await dbRun(`INSERT INTO alerts (type, severity, message, source, acknowledged) VALUES ('health', 'info', ?, ?, 1)`,
            [`VPS tüneli yeniden yanıt veriyor: ${label} — yönlendirilen trafik yeniden tünelden`, src]);
        }
      }
      if (changed || routesDirty) {
        routesDirty = true;
        await runInRoutingQueue(() => syncVpsRoutes(staleTunnels()));
        routesDirty = false;
      }
      // Eski işaret şemasından geçiş: FTL güncel dosyaları yükleyince takma adlar kalkar, eski setler silinir.
      if (await legacyRoutingCleanupDue()) await applyAllRoutingRules();
      lastWatchError = '';
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg !== lastWatchError) console.error('[vps-tunnel] izleyici başarısız:', msg);
      lastWatchError = msg;
    }
  };
  setTimeout(watchVpsTunnels, 20000);
  setInterval(watchVpsTunnels, 30000);
}

// Cron görevlerinin ve panel güncellemesinin hatası panelin dışında olur (zamanlayıcı / arka plan işi): 5 dk'lık sağlık
// denetiminde durum dosyalarından okunur, her hata bir kez yazılır (kaynak + mesaj tekrar önleme; mesajda çalışma zamanı).
async function recordBackgroundFailures() {
  const statuses = readJobStatuses();
  if (statuses.size) {
    const names = new Map((await dbAll('SELECT id, name FROM cron_jobs') as any[]).map(j => [Number(j.id), String(j.name)]));
    for (const [id, st] of statuses) {
      if (st.rc === 0 || !names.has(id) || Date.now() / 1000 - st.at > 29 * 86400) continue;
      await recordEventOnce(`cron:${id}`, `Cron görevi hata verdi: ${names.get(id)} (çıkış kodu ${st.rc}, ${new Date(st.at * 1000).toLocaleString('tr-TR')}) — çıktısı Sistem Logları'nda`, 'warning', 0);
    }
  }
  const up = await getUpdateStatus();
  if (up.state === 'failed' && up.id) {
    const step = up.steps?.find(s => !s.success)?.step || 'bilinmeyen adım';
    await recordEventOnce(`update:${up.id}`, `Panel güncellemesi başarısız: ${step}`, 'warning', 0);
  }
}

// ─── Alerts ───
app.get('/api/alerts/unread-count', async (_req, res) => {
  try {
    const row = await dbGet('SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0');
    res.json({ count: row?.count || 0 });
  } catch { res.json({ count: 0 }); }
});

// Uyarılar + olay geçmişi, en yeni önce. Süzgeç: severity=critical|warning|info, unread=1; sayfalama: before=<id> (daha
// eskiler), limit (en çok 200). hasMore: daha eski kayıt var.
app.get('/api/alerts', async (req, res) => {
  try {
    const where: string[] = [];
    const params: any[] = [];
    const sev = String(req.query.severity || '');
    if (['critical', 'warning', 'info'].includes(sev)) { where.push('severity = ?'); params.push(sev); }
    if (req.query.unread === '1') where.push('acknowledged = 0');
    const before = Number(req.query.before);
    if (Number.isInteger(before) && before > 0) { where.push('id < ?'); params.push(before); }
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 100, 1), 200);
    const rows = await dbAll(`SELECT id, type, severity, message, source, acknowledged, created_at FROM alerts
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, [...params, limit + 1]);
    res.json({ alerts: rows.slice(0, limit), hasMore: rows.length > limit });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/alerts/acknowledge-all', async (_req, res) => {
  try {
    await dbRun('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0');
    res.json({ success: true });
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
    await recordEvent('dhcp', `Sabit IP ataması: ${hostname || mac_address} → ${ip_address}`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/dhcp/static/:mac', async (req, res) => {
  try {
    await dbRun('UPDATE dhcp_leases SET is_static = 0 WHERE mac_address = ?', [req.params.mac]);
    await recordEvent('dhcp', `Sabit IP ataması kaldırıldı: ${req.params.mac}`);
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
const NET_NUMS = ['trial_ends', 'now', 'guard_at', 'lease_until', 'ap_trial_ends', 'home_trial_ends', 'home_channel'];
const NET_BOOLS = ['nm', 'carrier', 'profile_ok', 'pi_dhcp', 'wifi_off', 'ap_capable', 'ap_active', 'home_capable', 'home_active', 'br_active'];
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
// Ağ modu / DHCP işleminin sonucu olay geçmişine (başarısızlıkta betiğin hata metniyle). okMsg boşsa başarı yazılmaz.
const kvEvent = (source: string, r: KvResult, okMsg: string, failMsg: string, secret = '') =>
  r.code === 0 ? (okMsg ? recordEvent(source, okMsg) : Promise.resolve())
    : recordEvent(source, maskSecret(`${failMsg}: ${kvError(r, 'bilinmeyen hata')}`, secret), 'warning');
app.use('/api/dhcp/pi', netAdminGuard);

app.get('/api/netmode/status', async (_req, res) => {
  if (!isLinux || !require('fs').existsSync(NET_MODE_SCRIPT)) return res.json({ supported: false });
  const r = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
  if (r.code !== 0) return res.json({ supported: true, error: kvError(r, 'sabit adres durumu okunamadı') });
  res.json({ ...kvTyped(r.kv, NET_NUMS, NET_BOOLS), supported: true });
});

// 3 dk'lık deneme: eth0'a tek profilde iki adres (modem tarafı + cihaz tarafı). Başarısız denemede betik eski profili
// geri getirmiştir; kurallar her iki durumda da güncel adreslere göre yeniden yazılır (idempotent, sıralı kuyruk).
// Wi-Fi köprüsü (aynı ağ) açıkken Pi modemin ağındadır: sabit adres, kurulum / ev Wi-Fi'ı, internet kartı, yedek hat ve
// Pi DHCP'si o düzenle çakışır (betikler de reddeder; burada anlaşılır yanıt).
const repBlocked = (res: express.Response): boolean => {
  const ns = readNetModeState();
  if (!ns || ns.repStage === 'none') return false;
  res.status(409).json({ error: 'Wi-Fi köprüsü (aynı ağ) açık — önce Cihaz Rolleri → Wi-Fi köprüsü\'nden kapatın' });
  return true;
};
app.post('/api/netmode/static', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (repBlocked(res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['static', '--trial', String(NET_TRIAL_S), '--client', NET_CLIENT_CIDR], 120000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, `Sabit adres denemesi başladı (${NET_TRIAL_S / 60} dk içinde "Kalıcı yap" gelmezse geri alınır)`, 'Sabit adres verilemedi');
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'sabit adres verilemedi') });
  res.json({ success: true, trial_ends: Number(r.kv.trial_ends) || 0 });
});

app.post('/api/netmode/confirm', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (isLoopbackClient(req.ip)) {
    return res.status(403).json({ error: 'Onayı başka bir cihazdan (PC/telefon) verin — Pi\'nin kendi ekranı ağ bağlantısını kanıtlamaz' });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['confirm'], 90000);
  await kvEvent('netmode', r, 'Sabit adres kalıcı yapıldı', 'Sabit adres onaylanamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  await routingAfterNetChange(r);
  res.json({ success: true });
});

app.post('/api/netmode/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['rollback'], 150000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, r.kv.rolled_back === '1' ? 'Sabit adres denemesi geri alındı' : '', 'Sabit adres geri alınamadı');
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Bilinçli olarak otomatik adrese (modemden DHCP) dönüş; Pi DHCP sunucusu açıkken betik reddeder.
app.post('/api/netmode/dhcp', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['dhcp'], 150000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, 'Pi otomatik adrese döndü (modemden DHCP)', 'Otomatik adrese dönülemedi');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'otomatik adrese dönülemedi') });
  res.json({ success: true });
});

// Pi'nin Wi-Fi'sini modem ağından ayırır / geri bağlar (Pi DHCP açıkken geri bağlama reddedilir).
app.post('/api/netmode/wifi', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled alanı true/false olmalı' });
  const r = await runKvScript(NET_MODE_SCRIPT, ['wifi', enabled ? 'on' : 'off'], 90000);
  await kvEvent('netmode', r, enabled ? 'Pi\'nin Wi-Fi\'si ev ağına bağlandı' : 'Pi\'nin Wi-Fi\'si ev ağından ayrıldı',
    enabled ? 'Wi-Fi açılamadı' : 'Wi-Fi kapatılamadı');
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
  if (repBlocked(res)) return;
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
  await kvEvent('netmode', r, `Kurulum Wi-Fi'ı denemesi başladı: ${ssid}`, 'Kurulum Wi-Fi\'ı açılamadı', password);
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
  await kvEvent('netmode', r, 'Kurulum Wi-Fi\'ı kalıcı yapıldı', 'Kurulum Wi-Fi\'ı onaylanamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  res.json({ success: true });
});

app.post('/api/netmode/ap/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['ap', 'rollback'], 150000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, r.kv.rolled_back === '1' ? 'Kurulum Wi-Fi\'ı denemesi geri alındı' : '', 'Kurulum Wi-Fi\'ı geri alınamadı');
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Bilinçli kapatma (kalıcı ya da deneme): yayın kalkar, Pi'nin Wi-Fi'si kapalı kalır (ev ağına kendiliğinden dönmez).
app.post('/api/netmode/ap/off', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['ap', 'off'], 150000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, `Kurulum Wi-Fi'ı kapatıldı${r.kv.warning ? ` — ${r.kv.warning}` : ''}`, 'Kurulum Wi-Fi\'ı kapatılamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'kurulum Wi-Fi\'ı kapatılamadı') });
  // Yayın kalktı ama Wi-Fi kapatılamadıysa (warning=…) arayüz bunu gösterir: Pi'nin Wi-Fi'si ev ağına dönebilir.
  res.json({ success: true, warning: r.kv.warning || undefined });
});

// ─── Ev Wi-Fi'ı: erişim noktası rolü (net-mode.sh home …) ───
// eth0 ve Pi'nin Wi-Fi kartı tek köprüde (br0) birleşir; kablosuz cihazlar kablolularla aynı ağa katılır (adresi evin
// DHCP sunucusu — modem ya da Pi — verir; ayrı ağ / NAT yok). Açma her zaman 5 dk'lık denemedir; "Kalıcı yap" yalnız bu
// yayına bağlı bir cihazdan kabul edilir. Ağ geçidi kuralları br0'ı sabit adres modunda önceden içerir (detectGatewayLan);
// her değişiklikten sonra yine güncel duruma göre yazılır.
const HOME_TRIAL_S = 300;
const HOME_CHANNELS: Record<'bg' | 'a', number[]> = { bg: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], a: [36, 40, 44, 48] };
// Güvenlik duvarı (Kurulum → firewall eylemiyle aynı: DB'deki arayüzler + özel kurallar) uygulanmış ve forward politikası
// drop ise kuralları köprüyü (br0) içermeli; önceki sürümle uygulanmışsa aynı ayarlarla yeniden uygulanır. Hata → mesaj.
async function firewallCoversBridge(): Promise<string | null> {
  const fwd = await execFileP('nft', ['list', 'chain', 'inet', 'pi5_filter', 'forward'], { timeout: 10000 }).then(r => r.stdout, () => '');
  if (!/policy drop/.test(fwd) || fwd.includes(`"${HOME_BRIDGE}"`)) return null;
  try {
    await applyPanelFirewall();
  } catch (e: any) {
    return `Güvenlik duvarı köprüyü kapsayacak şekilde yeniden uygulanamadı: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`;
  }
  const after = await execFileP('nft', ['list', 'chain', 'inet', 'pi5_filter', 'forward'], { timeout: 10000 }).then(r => r.stdout, () => '');
  return /policy drop/.test(after) && !after.includes(`"${HOME_BRIDGE}"`) ? 'Güvenlik duvarı kuralları köprüyü (br0) kapsamıyor' : null;
}

app.post('/api/netmode/home', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (repBlocked(res)) return;
  const { ssid, password } = req.body || {};
  const band = req.body?.band === undefined || req.body?.band === 'bg' ? 'bg' : req.body?.band === 'a' ? 'a' : null;
  const rawCh = req.body?.channel;
  const channel = rawCh === undefined || rawCh === null || rawCh === '' ? (band === 'a' ? 36 : 6) : Number(rawCh);
  if (typeof ssid !== 'string' || !validApSsid(ssid)) {
    return res.status(400).json({ error: 'Ağ adı 1-32 karakter olmalı: harf (Türkçe harf olmadan), rakam, boşluk, _ . - ; başta/sonda boşluk olmadan' });
  }
  if (typeof password !== 'string' || !validApPassword(password)) {
    return res.status(400).json({ error: 'Wi-Fi şifresi 8-63 karakter olmalı: Türkçe harf (ç ğ ı ö ş ü) ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
  }
  if (!band) return res.status(400).json({ error: 'Bant 2,4 GHz (bg) ya da 5 GHz (a) olmalı' });
  if (!HOME_CHANNELS[band].includes(channel)) {
    return res.status(400).json({ error: band === 'a' ? '5 GHz kanalı 36, 40, 44 ya da 48 olmalı' : '2,4 GHz kanalı 1-13 arasında olmalı' });
  }
  const fwErr = await firewallCoversBridge();
  if (fwErr) return res.status(409).json({ error: fwErr });
  // Ağ geçidi / giriş / NAT kuralları köprüyü geçişten ÖNCE içersin (önceki sürümle yazılmışsa br0 yoktur).
  await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
  const r = await runKvScript(NET_MODE_SCRIPT,
    ['home', 'on', '--trial', String(HOME_TRIAL_S), '--ssid', ssid, '--band', band, '--channel', String(channel)], 180000, `${password}\n`);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, `Ev Wi-Fi'ı denemesi başladı: ${ssid} (${band === 'a' ? '5 GHz' : '2,4 GHz'}, kanal ${channel})`, 'Ev Wi-Fi\'ı açılamadı', password);
  if (r.code !== 0) return res.status(500).json({ error: maskSecret(kvError(r, 'ev Wi-Fi\'ı açılamadı'), password) });
  res.json({ success: true, home_trial_ends: Number(r.kv.home_trial_ends) || 0 });
});

// "Kalıcı yap" yalnız Pi'nin ev Wi-Fi yayınına bağlı bir cihazdan kabul edilir (istasyon listesi): yayının, köprünün ve
// adres dağıtımının gerçekten çalıştığının kanıtı. Kablolu bilgisayar ya da Pi'nin kendi ekranı bunu kanıtlamaz.
app.post('/api/netmode/home/confirm', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const ns = readNetModeState();
  if (!ns || ns.homeStage !== 'trial') return res.status(409).json({ error: 'Ev Wi-Fi\'ı denemesi sürmüyor (süre dolduysa geri alınmıştır)' });
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  const mac = isLoopbackClient(req.ip) ? '' : (await readNeighbors()).get(ip)?.mac || '';
  const stations = ns.homeIface ? await readHomeStations(ns.homeIface, HOME_BRIDGE) : new Set<string>();
  if (!mac || !stations.has(mac)) {
    const st = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
    const ssid = (st.code === 0 && st.kv.home_ssid) || 'ev Wi-Fi\'ı';
    return res.status(403).json({ error: `Onayı ev Wi-Fi'ına bağlı bir telefondan verin: telefonu '${ssid}' ağına bağlayın, panelde Cihaz Rolleri → Erişim noktası kartından 'Kalıcı yap'a basın` });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['home', 'confirm'], 90000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, 'Ev Wi-Fi\'ı kalıcı yapıldı', 'Ev Wi-Fi\'ı onaylanamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  res.json({ success: true });
});

app.post('/api/netmode/home/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['home', 'rollback'], 150000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, r.kv.rolled_back === '1' ? 'Ev Wi-Fi\'ı denemesi geri alındı' : '', 'Ev Wi-Fi\'ı geri alınamadı');
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Bilinçli kapatma (kalıcı ya da deneme): köprü ve yayın kalkar, Pi köprüsüz sabit adrese döner.
app.post('/api/netmode/home/off', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['home', 'off'], 150000);
  await routingAfterNetChange(r);
  await kvEvent('netmode', r, `Ev Wi-Fi'ı kapatıldı${r.kv.warning ? ` — ${r.kv.warning}` : ''}`, 'Ev Wi-Fi\'ı kapatılamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'ev Wi-Fi\'ı kapatılamadı') });
  res.json({ success: true, warning: r.kv.warning || undefined });
});

// ─── İnternet kartı: WAN router rolü (R3, net-mode.sh wan …) ───
// İkinci Ethernet kartı internete bağlanır (DHCP / sabit / PPPoE, isteğe bağlı VLAN, MAC kopyalama, MTU); eth0 / br0
// yalnız ev ağı olur. Açma her zaman 5 dk'lık denemedir; "Kalıcı yap" Pi'nin kendi ekranından kabul edilmez. Ev ağı
// adresi hiç kalkmadığı için panel geçiş boyunca açıktır. Her değişiklikten sonra ağ geçidi kuralları (internet kartı
// artık LAN sayılmaz), port yönlendirmeleri ve — panelin güvenlik duvarı kuruluysa — o da güncel kartlarla yazılır.
const WAN_TRIAL_S = 300;
const WAN_NUMS = ['wan_trial_ends', 'now', 'wan_signal'];
const WAN_BOOLS = ['wan_lan', 'wan_carrier', 'wan_up', 'wan_fw', 'ppp_ok', 'pi_dhcp', 'wan_single'];
app.use('/api/wan', netAdminGuard);
// Panelin güvenlik duvarı (pi5_filter, politika drop) kuruluysa internet kartı arayüzleriyle yeniden yazılır: DB'deki eski
// iki kartlı tohumlar yerine net-mode durumu kullanılır (services.ts), port yönlendirmesine iletim izni eklenir.
async function firewallFollowsWan(): Promise<void> {
  const fwd = await execFileP('nft', ['list', 'chain', 'inet', 'pi5_filter', 'forward'], { timeout: 10000 }).then(r => r.stdout, () => '');
  if (!/policy drop/.test(fwd)) return;
  try {
    await applyPanelFirewall();
  } catch (e: any) {
    console.error('[wan] güvenlik duvarı internet kartına göre yeniden yazılamadı:', String(e?.stderr || e?.message || e).trim());
  }
}
const wanAfterChange = async (r: KvResult) => {
  const apply = async () => {
    await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    await applyPortForwards();
    await firewallFollowsWan();
    await reapplyWgServer(); // Ev VPN'i açıksa: PPPoE'ye geçişte / çıkışta tünel MTU'su (wgServer.ts)
  };
  if (r.code === null && r.exited) { void r.exited.then(apply); return; }
  await apply();
};
// Ev VPN'i açıldı / kapandı: internet kartı (ve yedek hat) güvenlik duvarı portunu buna göre açar / kapar.
async function wanFirewallReload(): Promise<void> {
  if (!isLinux || !require('fs').existsSync(NET_MODE_SCRIPT)) return;
  const ns = readNetModeState();
  if (wanActive(ns)) {
    const r = await runKvScript(NET_MODE_SCRIPT, ['wan', 'fw'], 60000);
    if (r.code !== 0) console.error('[wan] güvenlik duvarı yeniden yüklenemedi:', kvError(r, 'bilinmeyen hata'));
  }
  if (ns?.bakStage === 'on') {
    const r = await runKvScript(NET_MODE_SCRIPT, ['backup', 'fw'], 60000);
    if (r.code !== 0) console.error('[yedek hat] güvenlik duvarı yeniden yüklenemedi:', kvError(r, 'bilinmeyen hata'));
  }
}
const IFNAME_RE = /^[A-Za-z0-9_.-]{1,15}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

app.get('/api/wan', async (_req, res) => {
  if (!isLinux || !require('fs').existsSync(NET_MODE_SCRIPT)) return res.json({ supported: false });
  const r = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
  if (r.code !== 0) return res.json({ supported: true, error: kvError(r, 'internet kartı durumu okunamadı') });
  const keep = Object.fromEntries(Object.entries(r.kv).filter(([k]) =>
    k.startsWith('wan_') || ['ppp_ok', 'now', 'stage', 'home_stage', 'sat_stage', 'pi_dhcp', 'iface', 'lan_if', 'client', 'wifi_roles'].includes(k)));
  const id = await getLanIdentity().catch(() => null);
  const forwards = await listForwards().catch(() => []);
  res.json({ ...kvTyped(keep, WAN_NUMS, WAN_BOOLS), supported: true, satellite: isSatellite(), wan_public: !!id?.wan?.public, forwards });
});

app.post('/api/wan', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (repBlocked(res)) return;
  if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — internet kartı ana cihaz içindir' });
  const b = req.body || {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const port = str(b.port), type = str(b.type);
  if (!IFNAME_RE.test(port)) return res.status(400).json({ error: 'İnternet kartını seçin' });
  if (!['dhcp', 'static', 'pppoe'].includes(type)) return res.status(400).json({ error: 'Bağlantı türü DHCP, sabit adres ya da PPPoE olmalı' });
  const args = ['wan', 'on', '--trial', String(WAN_TRIAL_S), '--port', port, '--type', type];
  const opt = (flag: string, v: string, re: RegExp, msg: string): string | null => {
    if (!v) return null;
    if (!re.test(v)) return msg;
    args.push(flag, v);
    return null;
  };
  const errs = [
    opt('--vlan', str(b.vlan), /^\d{1,4}$/, 'VLAN numarası 1-4094 olmalı'),
    opt('--prio', str(b.prio), /^[0-7]$/, 'VLAN önceliği 0-7 olmalı'),
    opt('--mac', str(b.mac), /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'MAC adresi 00:11:22:33:44:55 biçiminde olmalı'),
    opt('--mtu', str(b.mtu), /^\d{3,4}$/, 'MTU 576-9000 arasında olmalı'),
    ...(type === 'static' ? [
      opt('--addr', str(b.addr), /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'Sabit adres 203.0.113.10/24 biçiminde olmalı'),
      opt('--gw', str(b.gw), IPV4_RE, 'Ağ geçidi geçersiz'),
      opt('--dns', str(b.dns).replace(/\s+/g, ''), /^(\d{1,3}(\.\d{1,3}){3})(,\d{1,3}(\.\d{1,3}){3}){0,2}$/, 'DNS en çok 3 adres, virgülle'),
    ] : []),
    ...(type === 'pppoe' ? [opt('--user', str(b.user), /^[!-~]{1,64}$/, 'PPPoE kullanıcı adı 1-64 karakter, boşluksuz olmalı')] : []),
    // Operatörün beklediği DHCP kimlikleri (üretici sınıfı / istemci kimliği / cihaz adı) — yalnız DHCP'de anlamlı.
    ...(type === 'dhcp' ? [
      opt('--dhcp-vendor', str(b.dhcp_vendor), /^(?!.*\\)[ -~]{1,64}$/, 'Üretici sınıfı 1-64 karakter olmalı (Türkçe harf ve ters bölü olmadan)'),
      opt('--dhcp-client-id', str(b.dhcp_client_id), /^(?!.*\\)[ -~]{1,64}$/, 'İstemci kimliği 1-64 karakter olmalı (Türkçe harf ve ters bölü olmadan)'),
      opt('--dhcp-hostname', str(b.dhcp_hostname), /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/, 'Cihaz adı harf / rakamla başlamalı; yalnız harf, rakam, nokta, tire'),
    ] : []),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs[0] });
  if (type === 'static' && (!b.addr || !b.gw)) return res.status(400).json({ error: 'Sabit adres ve ağ geçidi gerekli' });
  const password = typeof b.password === 'string' ? b.password : '';
  if (type === 'pppoe' && (!b.user || !password)) return res.status(400).json({ error: 'PPPoE kullanıcı adı ve şifresi gerekli' });
  if (type === 'pppoe' && (/[\r\n\\]/.test(password) || password.length > 128 || password !== password.trim())) {
    return res.status(400).json({ error: 'PPPoE şifresi 1-128 karakter olmalı: ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
  }
  // Repeater (R4 A): Wi-Fi kartı üst Wi-Fi'a istemci olarak bağlanır (ağ adı + WPA parolası; PPPoE / VLAN yok).
  const fsm = require('fs');
  const wifiPort = fsm.existsSync(`/sys/class/net/${port}/wireless`) || fsm.existsSync(`/sys/class/net/${port}/phy80211`);
  const ssid = typeof b.ssid === 'string' ? b.ssid : '';
  if (wifiPort || ssid) {
    if (!wifiPort) return res.status(400).json({ error: `${port} bir Wi-Fi kartı değil — Wi-Fi ağ adı yalnız Wi-Fi kartıyla verilir` });
    if (type === 'pppoe' || b.vlan) return res.status(400).json({ error: 'Wi-Fi bağlantısında PPPoE ve VLAN kullanılmaz — bunları üst modem / router yapar' });
    if (!/^[^\x00-\x1f\x7f]{1,32}$/.test(ssid) || Buffer.byteLength(ssid, 'utf8') > 32) return res.status(400).json({ error: "Üst Wi-Fi'ın adı 1-32 karakter olmalı" });
    if (!/^[ -~]{8,63}$/.test(password) || password.includes('\\') || password !== password.trim()) {
      return res.status(400).json({ error: 'Wi-Fi parolası 8-63 karakter olmalı: Türkçe harf ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
    }
    args.push('--ssid', ssid);
  }
  const single = readNetModeState()?.iface === port; // ev ağı kartı: aynı porttan VLAN ile internet (tek port)
  const r = await runKvScript(NET_MODE_SCRIPT, args, 240000, type === 'pppoe' || wifiPort ? `${password}\n` : '');
  await wanAfterChange(r);
  const how = wifiPort ? `Wi-Fi: ${ssid}${type === 'static' ? ', sabit adres' : ''}` : `${type === 'pppoe' ? 'PPPoE' : type === 'static' ? 'sabit adres' : 'DHCP'}${b.vlan ? `, VLAN ${b.vlan}` : ''}`;
  await kvEvent('netmode', r, `İnternet kartı denemesi başladı: ${port}${single ? ' — tek port' : ''} (${how}) — ${WAN_TRIAL_S / 60} dk içinde "Kalıcı yap" gelmezse geri alınır`, 'İnternet kartı açılamadı', password);
  if (r.code !== 0) return res.status(500).json({ error: maskSecret(kvError(r, 'internet kartı açılamadı'), password), rolled_back: r.kv.rolled_back === '1' });
  res.json({ success: true, wan_trial_ends: Number(r.kv.wan_trial_ends) || 0, wan_ip: r.kv.wan_ip || '', wan_gateway: r.kv.wan_gateway || '' });
});

app.post('/api/wan/confirm', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (isLoopbackClient(req.ip)) {
    return res.status(403).json({ error: 'Onayı ev ağındaki bir cihazdan (PC/telefon) verin — Pi\'nin kendi ekranı ev ağının çalıştığını kanıtlamaz' });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['wan', 'confirm'], 90000);
  await kvEvent('netmode', r, 'İnternet kartı kalıcı yapıldı', 'İnternet kartı onaylanamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  await wanAfterChange(r);
  void ddnsAutoUpdate();
  res.json({ success: true });
});

app.post('/api/wan/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['wan', 'rollback'], 150000);
  await wanAfterChange(r);
  await kvEvent('netmode', r, r.kv.rolled_back === '1' ? 'İnternet kartı denemesi geri alındı' : '', 'İnternet kartı geri alınamadı');
  if (r.code !== 0) return res.status(500).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Bilinçli kapatma: internet kartı kalkar, eth0 / br0 eski (tek kablolu) düzene döner. Modem kablosu eth0'dan internet
// kartına taşındıysa Pi'nin interneti kablo geri takılana kadar yoktur; ev ağı ve panel çalışır.
app.post('/api/wan/off', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['wan', 'off'], 150000);
  await wanAfterChange(r);
  await kvEvent('netmode', r, `İnternet kartı kapatıldı; tek kablolu düzene dönüldü${r.kv.warning ? ` — ${r.kv.warning}` : ''}`, 'İnternet kartı kapatılamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'internet kartı kapatılamadı') });
  res.json({ success: true, warning: r.kv.warning || undefined });
});

// ─── Yedek hat (failover; net-mode.sh backup …) ───
// İkinci internet bağlantısı: Ethernet kartı / VLAN (ikinci modem, 4G router, ikinci operatör; DHCP / sabit / PPPoE), USB
// 4G modem ya da telefon USB paylaşımı, telefon hotspot'u. Açma deneme süresizdir (ana hat ve ev ağı değişmez): hemen
// sınanır, olmazsa geri alınır. İzleyici (pi5-wan-failover) ana hat düşünce yedek hatta geçer, 60 sn sağlam kalınca döner.
// Uç adı /api/failover: /api/backup/* sistem yedeklemesine (dışa / içe aktarma) aittir.
const BAK_NUMS = ['bak_since', 'bak_switches', 'bak_checked', 'bak_force_until', 'bak_rx', 'bak_tx', 'now'];
const BAK_BOOLS = ['bak_up', 'bak_fw', 'bak_watch', 'bak_primary_ok', 'bak_backup_ok', 'bak_conntrack', 'pi_dhcp', 'wan_lan'];
const BAK_KIND_TEXT: Record<string, string> = { eth: 'Ethernet', usb: 'USB modem / telefon', wifi: 'telefon hotspot\'u' };
app.use('/api/failover', netAdminGuard);
// Yedek hat açılınca / kapanınca: port yönlendirme ve panel güvenlik duvarı arayüz kümeleri, Ev VPN'i MTU'su.
const backupAfterChange = async () => {
  await applyPortForwards();
  await firewallFollowsWan();
  await reapplyWgServer();
};

app.get('/api/failover', async (_req, res) => {
  if (!isLinux || !require('fs').existsSync(NET_MODE_SCRIPT)) return res.json({ supported: false });
  const r = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
  if (r.code !== 0) return res.json({ supported: true, error: kvError(r, 'yedek hat durumu okunamadı') });
  const keep = Object.fromEntries(Object.entries(r.kv).filter(([k]) => k.startsWith('bak_')
    || ['now', 'stage', 'home_stage', 'sat_stage', 'ap_stage', 'wan_stage', 'wan_dev', 'wan_port', 'wan_ip', 'pi_dhcp', 'iface', 'lan_if',
      'client', 'wan_lan', 'ap_iface', 'home_iface', 'wifi_roles'].includes(k)));
  const uplink = await activeUplink().catch(() => null);
  res.json({ ...kvTyped(keep, BAK_NUMS, BAK_BOOLS), supported: true, satellite: isSatellite(), uplink });
});

app.post('/api/failover', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (repBlocked(res)) return;
  if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — yedek hat ana cihaz içindir' });
  const b = req.body || {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const kind = str(b.kind), type = str(b.type) || 'dhcp';
  if (!['eth', 'usb', 'wifi'].includes(kind)) return res.status(400).json({ error: 'Yedek hat türünü seçin (Ethernet, USB modem / telefon, hotspot)' });
  if (!['dhcp', 'static', 'pppoe'].includes(type)) return res.status(400).json({ error: 'Bağlantı türü DHCP, sabit adres ya da PPPoE olmalı' });
  if (kind !== 'eth' && type !== 'dhcp') return res.status(400).json({ error: 'USB modem / telefon ve hotspot yedek hattı yalnız otomatik adresle (DHCP) çalışır' });
  const args = ['backup', 'on', '--kind', kind, '--type', type];
  const opt = (flag: string, v: string, re: RegExp, msg: string): string | null => {
    if (!v) return null;
    if (!re.test(v)) return msg;
    args.push(flag, v);
    return null;
  };
  const errs = [
    ...(kind !== 'usb' ? [opt('--port', str(b.port), IFNAME_RE, 'Kart adı geçersiz')] : []),
    ...(kind === 'eth' ? [
      opt('--vlan', str(b.vlan), /^\d{1,4}$/, 'VLAN numarası 1-4094 olmalı'),
      opt('--mtu', str(b.mtu), /^\d{3,4}$/, 'MTU 576-9000 arasında olmalı'),
    ] : []),
    ...(type === 'static' ? [
      opt('--addr', str(b.addr), /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'Sabit adres 203.0.113.10/24 biçiminde olmalı'),
      opt('--gw', str(b.gw), IPV4_RE, 'Ağ geçidi geçersiz'),
      opt('--dns', str(b.dns).replace(/\s+/g, ''), /^(\d{1,3}(\.\d{1,3}){3})(,\d{1,3}(\.\d{1,3}){3}){0,2}$/, 'DNS en çok 3 adres, virgülle'),
    ] : []),
    ...(type === 'pppoe' ? [opt('--user', str(b.user), /^[!-~]{1,64}$/, 'PPPoE kullanıcı adı 1-64 karakter, boşluksuz olmalı')] : []),
    // Hotspot adı: telefon adlarında Türkçe harf / kesme işareti olabilir (1-32 bayt, denetim karakteri yok).
    ...(kind === 'wifi' ? [opt('--ssid', typeof b.ssid === 'string' ? b.ssid : '', /^[^\x00-\x1f\x7f]{1,32}$/, 'Hotspot adı 1-32 karakter olmalı')] : []),
  ].filter(Boolean);
  if (errs.length) return res.status(400).json({ error: errs[0] });
  if (kind === 'eth' && !b.port) return res.status(400).json({ error: 'Yedek hat kartını seçin' });
  if (kind === 'wifi' && Buffer.byteLength(String(b.ssid || ''), 'utf8') > 32) return res.status(400).json({ error: 'Hotspot adı en çok 32 bayt olabilir' });
  if (type === 'static' && (!b.addr || !b.gw)) return res.status(400).json({ error: 'Sabit adres ve ağ geçidi gerekli' });
  const secret = typeof b.password === 'string' ? b.password : '';
  if (type === 'pppoe') {
    if (!b.user || !secret) return res.status(400).json({ error: 'PPPoE kullanıcı adı ve şifresi gerekli' });
    if (!/^[!-~]([ -~]{0,126}[!-~])?$/.test(secret) || secret.includes('\\')) {
      return res.status(400).json({ error: 'PPPoE şifresi 1-128 karakter olmalı: Türkçe harf ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
    }
  }
  if (kind === 'wifi' && (!/^[ -~]{8,63}$/.test(secret) || secret.includes('\\') || secret !== secret.trim())) {
    return res.status(400).json({ error: 'Hotspot parolası 8-63 karakter olmalı: Türkçe harf ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, args, 240000, secret ? `${secret}\n` : '');
  await backupAfterChange();
  const what = `${BAK_KIND_TEXT[kind]}${type === 'pppoe' ? ', PPPoE' : type === 'static' ? ', sabit adres' : ''}${b.vlan ? `, VLAN ${b.vlan}` : ''}`;
  await kvEvent('netmode-bak', r, `Yedek hat açıldı: ${what} — ${r.kv.bak_dev || ''} ${r.kv.bak_ip || ''}`.trim(), 'Yedek hat açılamadı', secret);
  if (r.code !== 0) return res.status(500).json({ error: maskSecret(kvError(r, 'yedek hat açılamadı'), secret), rolled_back: r.kv.rolled_back === '1' });
  res.json({ success: true, bak_dev: r.kv.bak_dev || '', bak_ip: r.kv.bak_ip || '', bak_gateway: r.kv.bak_gateway || '', warning: r.kv.warning || undefined });
});

app.post('/api/failover/off', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['backup', 'off'], 120000);
  await backupAfterChange();
  await kvEvent('netmode-bak', r, 'Yedek hat kapatıldı', 'Yedek hat kapatılamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'yedek hat kapatılamadı') });
  res.json({ success: true, warning: r.kv.warning || undefined });
});

// Geçiş denemesi: izleyici SN saniye yedek hatta kalır (0 = bitir); ev ağındaki bir cihazdan internetin yedek hattan
// çalıştığı görülür.
app.post('/api/failover/test', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const s = Number(req.body?.seconds ?? 60);
  if (!Number.isInteger(s) || s < 0 || s > 600) return res.status(400).json({ error: 'Süre 0-600 sn olmalı' });
  const r = await runKvScript(NET_MODE_SCRIPT, ['backup', 'test', String(s)], 15000);
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'geçiş denemesi başlatılamadı') });
  if (s > 0) await recordEvent('netmode-bak', `Yedek hat geçiş denemesi: ${s} sn yedek hattan çıkılıyor`);
  res.json({ success: true, force_until: Number(r.kv.force_until) || 0 });
});

// Wi-Fi köprüsü (aynı ağ, R4 C): Pi üst Wi-Fi'a istemci olarak bağlanır; kalıcı yapılınca ev tarafı kartındaki (eth0)
// cihazlar üst ağla aynı ağda olur (ARP vekili, NAT yok), adresi modem (aktarma) ya da Pi (modem ağında ayrı aralık)
// dağıtır, DNS Pi-hole'a çekilir. Deneme yalnız üst Wi-Fi'ı sınar (eth0 eski profilinde, panel açık kalır); kalıcı yap
// Pi'nin YENİ (Wi-Fi) adresinden gelmeli: tarayıcı o adrese ulaşabildiğini böyle kanıtlar, yanıt da kesilmeden döner.
const REP_TRIAL_S = 600;
const REP_NUMS = ['rep_trial_ends', 'rep_lan_since', 'rep_clients', 'rep_signal', 'now'];
const REP_BOOLS = ['rep_up', 'pi_dhcp'];
app.use('/api/repeater', netAdminGuard);
// Kalıcı / kapatma sonrası: DNS yönlendirme hedefi ve ağ geçidi NAT'ı (pi5_wgnat) yeni düzene, panel güvenlik duvarı
// (kuruluysa) ev tarafı / üst Wi-Fi kartlarına, Ev VPN'i izin zincirleri yeniden.
const repeaterAfterChange = async (r: KvResult) => {
  const apply = async () => {
    await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
    await firewallFollowsWan();
    await reapplyWgServer();
  };
  if (r.code === null && r.exited) { void r.exited.then(apply); return; }
  await apply();
};

app.get('/api/repeater', async (_req, res) => {
  if (!isLinux || !require('fs').existsSync(NET_MODE_SCRIPT)) return res.json({ supported: false });
  const r = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
  if (r.code !== 0) return res.json({ supported: true, error: kvError(r, 'Wi-Fi köprüsü durumu okunamadı') });
  const keep = Object.fromEntries(Object.entries(r.kv).filter(([k]) => k.startsWith('rep_')
    || ['now', 'stage', 'pi_dhcp', 'iface', 'sat_stage', 'ap_stage', 'home_stage', 'wan_stage', 'bak_stage', 'wifi_roles'].includes(k)));
  // Pi'nin şu anki ağı (modem tarafı): "Pi dağıtır" kipinin aralık önerisi ve kurulum ön koşulu (kablo modemde) için.
  const id = await getLanIdentity().catch(() => null);
  res.json({
    ...kvTyped(keep, REP_NUMS, REP_BOOLS), supported: true, satellite: isSatellite(),
    lan: id ? { iface: id.iface, ip: id.transit.ip, prefix: id.transit.prefix, network: id.transit.network, gateway: id.gateway } : null,
  });
});

app.post('/api/repeater', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — Wi-Fi köprüsü ana cihaz içindir' });
  const b = req.body || {};
  const port = typeof b.port === 'string' ? b.port.trim() : '';
  const ssid = typeof b.ssid === 'string' ? b.ssid : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const dhcp = b.dhcp === undefined || b.dhcp === 'relay' ? 'relay' : b.dhcp === 'pi' ? 'pi' : '';
  const range = typeof b.range === 'string' ? b.range.trim() : '';
  if (!dhcp) return res.status(400).json({ error: 'Adres dağıtımı modemden (aktarma) ya da Pi\'den olmalı' });
  if (port && !IFNAME_RE.test(port)) return res.status(400).json({ error: 'Wi-Fi kartı geçersiz' });
  if (!/^[^\x00-\x1f\x7f]{1,32}$/.test(ssid) || Buffer.byteLength(ssid, 'utf8') > 32) return res.status(400).json({ error: "Üst Wi-Fi'ın adı 1-32 karakter olmalı" });
  if (!/^[ -~]{8,63}$/.test(password) || password.includes('\\') || password !== password.trim()) {
    return res.status(400).json({ error: 'Wi-Fi parolası 8-63 karakter olmalı: Türkçe harf ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan' });
  }
  if (dhcp === 'pi' && !/^\d{1,3}(\.\d{1,3}){3}-\d{1,3}(\.\d{1,3}){3}$/.test(range)) {
    return res.status(400).json({ error: 'Pi dağıtır kipinde adres aralığı gerekli (ör. 192.168.1.200-192.168.1.249)' });
  }
  const args = ['rep', 'on', '--trial', String(REP_TRIAL_S), '--ssid', ssid, '--dhcp', dhcp,
    ...(port ? ['--port', port] : []), ...(dhcp === 'pi' ? ['--range', range] : [])];
  const r = await runKvScript(NET_MODE_SCRIPT, args, 240000, `${password}\n`);
  await kvEvent('netmode', r, `Wi-Fi köprüsü denemesi başladı: "${ssid}" — Pi'nin yeni adresi ${String(r.kv.rep_ip || '?').split('/')[0]}; ${REP_TRIAL_S / 60} dk içinde yeni adresten "Kalıcı yap" gelmezse geri alınır`,
    'Wi-Fi köprüsü açılamadı', password);
  if (r.code !== 0) return res.status(500).json({ error: maskSecret(kvError(r, 'Wi-Fi köprüsü açılamadı'), password), rolled_back: r.kv.rolled_back === '1' });
  res.json({ success: true, rep_trial_ends: Number(r.kv.rep_trial_ends) || 0, rep_ip: r.kv.rep_ip || '', rep_gw: r.kv.rep_gw || '' });
});

app.post('/api/repeater/confirm', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  if (isLoopbackClient(req.ip)) {
    return res.status(403).json({ error: 'Onayı ev ağındaki bir cihazdan (PC/telefon) verin — Pi\'nin kendi ekranı yeni adrese ulaşıldığını kanıtlamaz' });
  }
  const st = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
  if (st.kv.rep_stage !== 'trial') return res.status(409).json({ error: 'Wi-Fi köprüsü denemesi sürmüyor (süre dolduysa geri alınmıştır)' });
  const repIp = String(st.kv.rep_ip || '').split('/')[0];
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!repIp || host !== repIp) {
    return res.status(409).json({ error: `Kalıcı yapmayı Pi'nin yeni adresinden yapın: http://${repIp || '?'} — bu sayfa ${host || 'başka bir adres'} üzerinden açık`, rep_ip: repIp });
  }
  const r = await runKvScript(NET_MODE_SCRIPT, ['rep', 'confirm'], 90000);
  const lanTxt = r.kv.rep_lan_state === 'active' ? 'ev tarafı açık'
    : r.kv.rep_lan_state === 'modem' ? 'kablo hâlâ modemde: arkadaki cihaza takılınca ev tarafı açılır' : `ev tarafı: ${r.kv.rep_lan_state || '?'}`;
  await kvEvent('netmode', r, `Wi-Fi köprüsü kalıcı: "${st.kv.rep_ssid}" — Pi ${repIp} (${st.kv.rep_lan || 'eth0'}: ${lanTxt})`, 'Wi-Fi köprüsü onaylanamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'onaylanamadı') });
  await repeaterAfterChange(r);
  res.json({ success: true, rep_lan_state: r.kv.rep_lan_state || '', warning: r.kv.warning || undefined });
});

app.post('/api/repeater/rollback', async (_req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const r = await runKvScript(NET_MODE_SCRIPT, ['rep', 'rollback'], 120000);
  await kvEvent('netmode', r, r.kv.rolled_back === '1' ? 'Wi-Fi köprüsü denemesi geri alındı' : '', 'Wi-Fi köprüsü geri alınamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'geri alınamadı') });
  res.json({ success: true, rolled_back: r.kv.rolled_back === '1' });
});

// Kapatma: ev tarafı kartı eski profiline (modem) döner. Pi yalnız Wi-Fi ile erişiliyorsa kapatınca erişim kesilir:
// betik eth0 modeme bağlı değilse reddeder; force (panelde "Pi'yi kabloyla modeme bağladım" onayı olmadan) gönderilmez.
app.post('/api/repeater/off', async (req, res) => {
  if (scriptMissing(NET_MODE_SCRIPT, res)) return;
  const force = req.body?.force === true;
  const r = await runKvScript(NET_MODE_SCRIPT, ['rep', 'off', ...(force ? ['--force'] : [])], 180000);
  await kvEvent('netmode', r, 'Wi-Fi köprüsü kapatıldı — ev tarafı kartı eski profiline döndü', 'Wi-Fi köprüsü kapatılamadı');
  if (r.code !== 0) return res.status(409).json({ error: kvError(r, 'kapatılamadı') });
  await repeaterAfterChange(r);
  res.json({ success: true, warning: r.kv.warning || undefined });
});

// Port yönlendirme (wan.ts): kayıtlar her zaman düzenlenebilir, yalnız internet kartı açıkken uygulanır.
app.get('/api/wan/forwards', async (_req, res) => {
  try { res.json({ forwards: await listForwards() }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});
app.post('/api/wan/forwards', async (req, res) => {
  try {
    const f = await addForward(req.body || {});
    await recordEvent('netmode', `Port yönlendirme eklendi: ${f.proto.toUpperCase()} ${f.ext_from}${f.ext_to !== f.ext_from ? `-${f.ext_to}` : ''} → ${f.dest_ip}${f.dest_port ? `:${f.dest_port}` : ''}${f.name ? ` (${f.name})` : ''}`);
    res.json({ success: true, forward: f });
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/wan/forwards/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Geçersiz istek' });
  try { await setForwardEnabled(id, req.body.enabled); res.json({ success: true }); } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/wan/forwards/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Geçersiz kayıt' });
  try {
    await deleteForward(id);
    await recordEvent('netmode', `Port yönlendirme silindi (#${id})`);
    res.json({ success: true });
  } catch (e: any) { res.status(e.status || 500).json({ error: e.message }); }
});

// ─── Cihaz rolü (R2): ana cihaz ↔ uydu ───
// Rol dosyası yazılır, backend yeniden başlatılır (açılış işleri role göre seçilir). Uyduya geçişte ana cihaz ağ ayarları
// (sabit adres, ev Wi-Fi'ı, kurulum Wi-Fi'ı, Pi DHCP, eşleşmiş uydular) kapalı olmalı; Ev VPN'i ve kablosuz mesh kapatılır.
// Ana cihaza geçişte uydu yayını ve eşleşmesi kaldırılır.
app.get('/api/system/role', (_req, res) => {
  res.json({ role: STARTUP_ROLE, file_role: readRole() });
});
app.post('/api/system/role', netAdminGuard, async (req, res) => {
  const role = req.body?.role as DeviceRole;
  if (role !== 'main' && role !== 'satellite') return res.status(400).json({ error: "Rol 'main' ya da 'satellite' olmalı" });
  try {
    if (role === readRole()) return res.json({ success: true, restart: false });
    if (role === 'satellite') {
      const ns = readNetModeState();
      if (ns && ns.stage !== 'none') return res.status(409).json({ error: 'Önce menü → DHCP Ayarları\'ndan otomatik adrese dönün (sabit adres ana cihaz içindir)' });
      if (ns && ns.homeStage !== 'none') return res.status(409).json({ error: "Önce ev Wi-Fi'ını kapatın (Cihaz Rolleri → Ev Wi-Fi'ı)" });
      if (ns && ns.apStage !== 'none') return res.status(409).json({ error: "Önce kurulum Wi-Fi'ını kapatın (DHCP Ayarları, 3. adım)" });
      if (ns && ns.repStage !== 'none') return res.status(409).json({ error: 'Önce Wi-Fi köprüsünü kapatın (Cihaz Rolleri → Wi-Fi köprüsü)' });
      if (await piDhcpActive()) return res.status(409).json({ error: PI_DHCP_BUSY_MSG });
      if ((await listSatellites()).length) return res.status(409).json({ error: 'Bu cihaza eşleşmiş uydular var — önce onları kaldırın' });
      const wg = await wgServerStatus().catch(() => null);
      if (wg && 'enabled' in wg && wg.enabled) await setServerEnabled(false);
      if ((await mainMeshState()).configured) await setMainWireless(false, 0);
    } else {
      await leaveMain();
    }
    writeRole(role);
    // Eşleşmiş uydu yok: peers/ altında yalnız kaldırılmış uyduların (mezar taşı) anahtarları kalabilir. Rol yazıldıktan
    // sonra silinir — önceki bir adım düşerse cihaz ana cihaz kalır ve bekleyen imzalı "kaldırıldı" yanıtları verilebilir.
    if (role === 'satellite') { try { removePeerKeys(); } catch { /* yalnız mezar taşı anahtarları */ } }
    await recordEvent('mesh', role === 'satellite' ? 'Cihaz rolü: uydu — panel yeniden başlıyor' : 'Cihaz rolü: ana cihaz — panel yeniden başlıyor');
    res.json({ success: true, restart: true });
    // spawn hatası (systemctl yok) dinlenmezse süreç düşerdi; yeniden başlatma olmazsa rol bir sonraki açılışta geçerli olur.
    if (isLinux) setTimeout(() => {
      const c = _spawn('systemctl', ['restart', 'pi5-backend'], { detached: true, stdio: 'ignore' });
      c.on('error', e => console.error('[rol] backend yeniden başlatılamadı:', e.message));
      c.unref();
    }, 1500);
  } catch (e: any) {
    res.status(e instanceof MeshError ? e.status : 500).json({ error: e.message });
  }
});

// ─── Mesh (R2) ───
// /pair ve /sync uydudan gelir: panel şifresinden muaf (auth.ts EXEMPT, panel-auth.sh), kimliği kod / anahtar kanıtlar;
// Host denetimi de uygulanmaz (uydu ana cihaza IP ile gelir). Diğer yazma uçları panel içindir (netAdminGuard).
app.use('/api/mesh', (req, res, next) => (req.path === '/pair' || req.path === '/sync' ? next() : netAdminGuard(req, res, next)));
const meshFail = (res: express.Response, e: any) => res.status(e instanceof MeshError ? e.status : 500).json({ error: e?.message || 'mesh hatası' });
const clientIp = (req: express.Request) => String(req.ip || '').replace(/^::ffff:/, '');

app.get('/api/mesh/state', async (_req, res) => {
  try {
    if (isSatellite()) return res.json({ role: 'satellite', satellite: await satelliteState() });
    const st = await runKvScript(NET_MODE_SCRIPT, ['status'], 30000);
    const lan = await getLanIdentity();
    res.json({
      role: 'main', satellites: await listSatellites(), pairing: pairingState(), mesh: await mainMeshState(),
      wifi: st.code === 0 ? { stage: st.kv.home_stage || 'none', ssid: st.kv.home_ssid || '', band: st.kv.home_band || 'bg', channel: Number(st.kv.home_channel) || null } : null,
      addresses: [...new Set([lan?.transit.ip, lan?.client.ip].filter(Boolean))],
    });
  } catch (e: any) { meshFail(res, e); }
});
app.post('/api/mesh/pairing', async (_req, res) => {
  if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — uydu eklemek ana cihazdan yapılır' });
  try { res.json(await createPairing()); } catch (e: any) { meshFail(res, e); }
});
app.delete('/api/mesh/pairing', (_req, res) => { cancelPairing(); res.json({ success: true }); });
app.post('/api/mesh/pair', async (req, res) => {
  if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz ana cihaz değil' });
  try { res.json(await pairSatellite(req.body, clientIp(req))); } catch (e: any) { meshFail(res, e); }
});
app.post('/api/mesh/sync', async (req, res) => {
  if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz ana cihaz değil' });
  try { res.json(await syncSatellite(req.headers.authorization, req.body, clientIp(req))); } catch (e: any) { meshFail(res, e); }
});
app.delete('/api/mesh/satellites/:id', async (req, res) => {
  if (!validSatId(req.params.id)) return res.status(400).json({ error: 'Geçersiz uydu kimliği' });
  try { res.json({ success: await removeSatellite(req.params.id) }); } catch (e: any) { meshFail(res, e); }
});
app.post('/api/mesh/wireless', async (req, res) => {
  if (isSatellite()) return res.status(409).json({ error: 'Kablosuz mesh ana cihazdan açılır; uydu ayarı senkronla alır' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled alanı true/false olmalı' });
  try {
    await setMainWireless(enabled, Number(req.body?.channel) || 36);
    await recordEvent('mesh', enabled ? 'Kablosuz mesh açıldı' : 'Kablosuz mesh kapatıldı');
    res.json({ success: true, mesh: await mainMeshState() });
  } catch (e: any) { meshFail(res, e); }
});
// Uydu tarafı: ana cihaza katılma / ayrılma / hemen senkron.
app.post('/api/mesh/join', async (req, res) => {
  if (!isSatellite()) return res.status(409).json({ error: 'Bu cihaz ana cihaz — önce rolünü uyduya çevirin' });
  try {
    const r = await joinMain(String(req.body?.main || '').trim(), String(req.body?.code || '').trim());
    res.json({ success: true, applied: r.applied, state: await satelliteState() });
  } catch (e: any) { meshFail(res, e); }
});
app.post('/api/mesh/leave', async (_req, res) => {
  if (!isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu değil' });
  try { await leaveMain(); res.json({ success: true }); } catch (e: any) { meshFail(res, e); }
});
app.post('/api/mesh/sync-now', async (_req, res) => {
  if (!isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu değil' });
  try { await syncOnce(); res.json({ success: true, state: await satelliteState() }); } catch (e: any) { meshFail(res, e); }
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
  if (repBlocked(res)) return;
  try {
    const st = readNetModeState();
    if (!st || st.stage !== 'static') return res.status(409).json({ error: 'Önce Pi\'ye sabit adres verin ve "kalıcı yap" ile onaylayın' });
    const plan = dhcpPlanFromClient(st.client);
    if (!plan) return res.status(409).json({ error: `Cihaz tarafı adresi DHCP havuzu için uygun değil (${st.client || '?'}) — /16–/24 bir ağ gerekli` });
    const r = await runPiDhcpExclusive([
      'enable', '--trial', String(DHCP_TRIAL_S), '--start', plan.start, '--end', plan.end, '--router', plan.ip,
      '--netmask', plan.netmask, '--lease', '5m',
    ], 240000);
    await kvEvent('dhcp', r, `Pi DHCP denemesi başladı (${DHCP_TRIAL_S / 60} dk içinde "Kalıcı yap" gelmezse geri alınır)`, 'Pi DHCP açılamadı');
    if (r.kv.warning === 'modem_dhcp') await recordEvent('dhcp', 'Modemin DHCP\'sini hemen geri açın — Pi DHCP denemesi düştü', 'critical');
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
        return res.status(403).json({ error: `Bu onay ev ağından verilmeli: telefonu kurulum Wi-Fi'ından çıkarıp ev Wi-Fi'ına bağlayın, sonra http://${plan.ip}/#dhcp adresini (menü → DHCP Ayarları) açıp onaylayın` });
      }
      return res.status(403).json({ error: `Onayı Pi'den adres almış bir cihazdan verin: telefonun Wi-Fi'ını kapatıp açın, sonra http://${plan.ip}/#dhcp adresini (menü → DHCP Ayarları) açıp onaylayın` });
    }
    const r = await runPiDhcpExclusive(['confirm', '--lease', '12h'], 240000);
    await kvEvent('dhcp', r, 'Pi DHCP kalıcı yapıldı — evin adres dağıtıcısı artık Pi', 'Pi DHCP onaylanamadı');
    if (r.kv.warning === 'modem_dhcp') await recordEvent('dhcp', 'Modemin DHCP\'sini hemen geri açın — Pi DHCP onayı başarısız, deneme geri alındı', 'critical');
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
    await kvEvent('dhcp', r, r.kv.rolled_back === '1' ? 'Pi DHCP denemesi geri alındı' : '', 'Pi DHCP geri alınamadı');
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
    await kvEvent('dhcp', r, 'Pi DHCP kapatıldı — adres dağıtımı modeme döndü', 'Pi DHCP kapatılamadı');
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
// Ayar tabloları birleştirilir (yedekte olmayan anahtar kalır: rol, eşleştirme, sürüm gibi çalışma anahtarları eski bir
// yedekle silinmesin); kural ve liste tabloları yedektekiyle DEĞİŞTİRİLİR (yedekten sonra eklenen kural kalmaz — geri
// yükleme beklenen budur; eskiden birleştiriliyordu). Statik DHCP kayıtlarında yalnız statikler değişir.
const BACKUP_MERGE_TABLES = new Set(['service_config', 'service_status', 'app_settings']);
// Yedekten geri gelmeyen çalışma kayıtları (panelin kendi defteri): eski değer geri gelirse ör. panelin Pi-hole'a yazdığı
// yerel DNS kayıtları "dışarıdan eklenmiş" sayılıp hiç silinmez, "Panel güncellendi" olayı yinelenir, bildirilmiş uyarı
// yeniden çıkar.
const BACKUP_SKIP_SETTINGS = new Set(['last_seen_version', 'pihole_hosts_managed', 'storage_job_notified', 'wg_reach_watch',
  'cron_defaults_seeded', 'accent_gray_migrated']);

async function restoreTable(table: string, rows: any[]): Promise<number> {
  if (!Array.isArray(rows)) return 0;
  // Bilinmeyen sütunlar atlanır (eski / yeni sürümün yedeği de yüklenir; eskiden tek sütun tüm geri yüklemeyi bozuyordu).
  const known = new Set((await dbAll(`PRAGMA table_info(${table})`) as any[]).map(c => String(c.name)));
  if (!BACKUP_MERGE_TABLES.has(table)) {
    await dbRun(table === 'dhcp_leases' ? 'DELETE FROM dhcp_leases WHERE is_static = 1' : `DELETE FROM ${table}`);
  }
  let n = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (table === 'app_settings' && BACKUP_SKIP_SETTINGS.has(String(row.key))) continue;
    const cols = Object.keys(row).filter(c => /^[a-zA-Z0-9_]+$/.test(c) && known.has(c));
    if (!cols.length) continue;
    const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    await dbRun(sql, cols.map(c => row[c]));
    n++;
  }
  return n;
}

// Güvenlik duvarı kuralları geri yüklenmeden ÖNCE: her satır doğrulanır (geçmeyen atlanır), panele herkesin ya da tüm ev
// ağının erişimini kesen kural atlanır, port sütunundan önceki yedeğin (v2.24.58 öncesi) "düşür / reddet" kuralları kapalı
// gelir (db.ts taşımasıyla aynı: eskiden hiç işlemiyorlardı). Kalan küme geri yükleyen cihazı panelden kesecekse kurallar
// hiç geri yüklenmez, mevcutlar kalır — sonradan başka bir uygulamayla (köprü, internet kartı) denetimsiz devreye girmesinler.
async function prepareFwRestore(rows: any[], req: express.Request): Promise<{ rows: any[]; skipped: number; disabled: number; error?: string }> {
  const lan = await lanNetworks();
  const out: any[] = [];
  let skipped = 0;
  let disabled = 0;
  for (const row of rows) {
    const v = row && typeof row === 'object' ? validateFwRule(row) : null;
    if (!v || 'error' in v || fwRuleIgnored(v.rule, lan)) { skipped++; continue; }
    const on = Number(row.enabled ?? 1) !== 0;
    const legacyBlock = !('port' in row) && v.rule.action !== 'accept';
    if (on && legacyBlock) disabled++;
    out.push({ ...(Number.isInteger(row.id) && row.id > 0 ? { id: row.id } : {}), ...v.rule, enabled: on && !legacyBlock ? 1 : 0 });
  }
  const verdict = await fwAccessVerdict(out, req);
  return { rows: out, skipped, disabled, ...(verdict.error ? { error: verdict.error } : {}) };
}

// Geri yüklenen ayarlar Pi'ye uygulanır (eskiden yalnız veritabanına yazılıyordu: bir kısmı ancak yeniden başlatmada,
// güvenlik duvarı ve Unbound hiç uygulanmıyordu). Yalnız yedekte bulunan bölümler; her birinin sonucu ayrı bildirilir.
async function applyRestored(tables: Set<string>, keys: Set<string>, req: express.Request): Promise<{ item: string; ok: boolean; detail?: string }[]> {
  const out: { item: string; ok: boolean; detail?: string }[] = [];
  const step = async (item: string, fn: () => Promise<string | void>) => {
    try {
      const d = await fn();
      out.push({ item, ok: true, ...(d ? { detail: d } : {}) });
    } catch (e: any) {
      out.push({ item, ok: false, detail: String(e?.message || e).slice(0, 300) });
    }
  };
  if (!isLinux) return out;
  if (tables.has('cron_jobs')) {
    await step('Cron görevleri', async () => {
      // Eski yedeklerde aynı görevin kopyaları olabilir (tohumlar yinelenirdi): aynı ad + zamanlama + komut teke iner.
      await dbRun('DELETE FROM cron_jobs WHERE id NOT IN (SELECT MIN(id) FROM cron_jobs GROUP BY name, schedule, command)');
      const err = await syncCronError();
      if (err) throw new Error(err);
    });
  }
  if (tables.has('traffic_routing') || tables.has('domain_routing') || tables.has('zapret_domains')) {
    await step('Yönlendirme kuralları', () => applyAllRoutingRules());
  }
  if (tables.has('pihole_lists')) {
    await step('Pi-hole listeleri', async () => {
      const r = await syncPiholeLists();
      if (!r.ok) throw new Error(r.errors.join('; '));
    });
  }
  if (tables.has('routing_rules')) {
    await step('Güvenlik duvarı', async () => {
      if (!panelFirewallDeployed()) return 'kurulu değil — kurallar kaydedildi, Deploy Et ile uygulanır';
      const verdict = await fwAccessVerdict(await dbAll(FW_RULES_SQL), req);
      if (verdict.error) throw new Error(`uygulanmadı: ${verdict.error}`);
      await applyPanelFirewall();
    });
  }
  if (keys.has('fail2ban_settings')) {
    await step('Fail2Ban', async () => {
      const r = await ensureFail2ban();
      if (r && !r.ok) throw new Error(r.error || 'uygulanamadı');
    });
  }
  if (keys.has('unbound_settings')) {
    await step('Unbound', async () => {
      const s = await savedUnboundSettings();
      if (!s) return 'kayıtlı ayar yok';
      const r = await applyUnboundSettings(s);
      if (!r.ok) throw new Error(r.error || 'uygulanamadı');
    });
  }
  if (tables.has('bandwidth_limits') || tables.has('throttle_rules')) {
    await step('Kota ve hız sınırları', async () => {
      await normalizeLimitMacs(); // eski yedekte büyük harfli MAC olabilir
      await migrateThrottleRules(); // eski yedekteki Hız Limitleme kuralları
      await runQos({ force: true });
    });
  }
  return out;
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
    const { data, backup_version } = req.body || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Geçerli bir yedek verisi gerekli' });
    }
    if (backup_version !== undefined && !(Number.isInteger(backup_version) && backup_version >= 1)) {
      return res.status(400).json({ error: 'Yedek dosyası tanınmadı (backup_version)' });
    }
    let present = BACKUP_TABLES.filter(t => Array.isArray(data[t]));
    if (!present.length) return res.status(400).json({ error: 'Yedekte geri yüklenecek tablo yok' });

    // Güvenlik duvarı kuralları önce denetlenir (prepareFwRestore); geri yükleyeni panelden keserse tablo geri yüklenmez.
    const notes: { item: string; ok: boolean; detail?: string }[] = [];
    if (present.includes('routing_rules')) {
      const fw = await prepareFwRestore(data.routing_rules, req);
      if (fw.error) {
        present = present.filter(t => t !== 'routing_rules');
        notes.push({ item: 'Güvenlik duvarı kuralları', ok: false, detail: `geri yüklenmedi, mevcut kurallar kaldı — ${fw.error}` });
      } else {
        data.routing_rules = fw.rows;
        const parts = [
          fw.skipped ? `${fw.skipped} kural atlandı (geçersiz ya da panele herkesin / tüm ev ağının erişimini keser)` : '',
          fw.disabled ? `eski sürümün ${fw.disabled} engelle kuralı kapalı geldi — Güvenlik Duvarı sayfasında gözden geçirip açın` : '',
        ].filter(Boolean);
        if (parts.length) notes.push({ item: 'Güvenlik duvarı kuralları', ok: true, detail: parts.join('; ') });
      }
    }

    // Tüm tablolar tek işlemde (kısmi hata = geri alma).
    let restored = 0;
    const perTable: Record<string, number> = {};
    await dbRun('BEGIN');
    try {
      for (const table of present) {
        if (!BACKUP_TABLE_SET.has(table)) continue; // whitelist güvencesi
        perTable[table] = await restoreTable(table, data[table]);
        restored += perTable[table];
      }
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      throw err;
    }

    const keys = new Set<string>(Array.isArray(data.app_settings) ? data.app_settings.map((r: any) => String(r?.key || '')) : []);
    const applied = [...notes, ...await applyRestored(new Set(present), keys, req)];
    const failed = applied.filter(a => !a.ok);
    await recordEvent('backup', `Yedek geri yüklendi: ${restored} kayıt (${present.length} tablo)${applied.length
      ? ` — uygulandı: ${applied.filter(a => a.ok).map(a => a.item).join(', ') || 'yok'}${failed.length ? `; uygulanamadı: ${failed.map(a => `${a.item} (${a.detail})`).join(', ')}` : ''}` : ''}`,
      failed.length ? 'warning' : 'info');
    res.json({ success: true, message: `${restored} kayıt geri yüklendi.`, restored_count: restored, tables: perTable, applied,
      ignored: Object.keys(data).filter(k => !BACKUP_TABLE_SET.has(k)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Depolama (storage.ts): takılı diskler, bölümler, doluluk ve verilerin hangi diskte durduğu ───
app.get('/api/storage', async (_req, res) => {
  try {
    res.json(await storageStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Veri diski işleri (scripts/storage.sh, pi5-storage birimi): hemen döner, panel ilerlemeyi /api/storage/job'dan izler.
// Hazırlama ve taşıma panel servisini bir süre durdurur; sayfa bu sırada bağlantıyı bekler.
app.get('/api/storage/job', async (_req, res) => {
  try {
    const j = await storageJob();
    if (j.state === 'done' || j.state === 'failed') void noteStorageJob();
    res.json(j);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/storage/archive', async (req, res) => {
  try {
    res.json(await startArchive(req.body?.src));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/storage/prepare', async (req, res) => {
  try {
    res.json(await startPrepare(req.body || {}));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/storage/migrate', async (_req, res) => {
  try {
    res.json(await startMigrate());
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
startStorageWatch();

// Ağ paylaşımı (share.ts → scripts/share.sh): açma paket kurduğu için depolama işi olarak koşar (/api/storage/job ile
// izlenir); kapatma, şifre ve USB paylaşımları kısa komutlardır. Şifre yanıtta ve günlükte hiç yer almaz.
app.get('/api/storage/share', async (_req, res) => {
  try {
    res.json(await shareStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
const shareRoute = (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
  try {
    res.json({ success: true, ...((await fn(req)) as object || {}) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
};
app.post('/api/storage/share/enable', shareRoute(req => enableShare(req.body || {})));
app.post('/api/storage/share/disable', shareRoute(() => disableShare().then(() => ({}))));
app.post('/api/storage/share/password', shareRoute(req => setSharePassword(req.body?.password).then(() => ({}))));
app.post('/api/storage/share/usb', shareRoute(req => addUsbShare(req.body?.part).then(name => ({ name }))));
app.post('/api/storage/share/usb/remove', shareRoute(req => removeUsbShare(req.body?.name).then(() => ({}))));
startShareWatch();

// ─── Parental Controls ───
// Ebeveyn kontrolleri (parental.ts): kural = kime (cihaz / grup) × neyi (tüm internet | kategori + site) × ne zaman. Kurallar
// uygulanır (nft inet pi5_parental + Pi-hole grupları), zamanlayıcı 30 sn'de bir. Liste yanıtı her kuralın şu anki durumunu
// ve sıradaki değişim zamanını taşır. Bir cihazın internetini kesebildiği için yazma istekleri netAdminGuard'dan geçer.
app.use('/api/parental', netAdminGuard);
app.get('/api/parental/rules', async (_req, res) => {
  try {
    const catalog = Object.entries(PARENTAL_CATEGORIES).map(([id, c]) => ({ id, label: c.label, desc: c.desc, list: !!c.lists }));
    res.json({ ...(await parentalRulesWithStatus()), catalog });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/parental/rules', async (req, res) => {
  try {
    res.json({ success: true, rule: await createParentalRule(req.body) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/parental/rules/:id', async (req, res) => {
  try {
    await updateParentalRule(Number(req.params.id), req.body);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/parental/rules/:id', async (req, res) => {
  try {
    await deleteParentalRule(Number(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
startParental({ protectedMacs: blockProtectedMacs });

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
    const who = `${device.hostname || device.mac_address}${device.ip_address ? ` (${device.ip_address})` : ''}`;
    await recordEvent('device', want ? `Cihaz engellendi: ${who}` : `Cihazın engeli kaldırıldı: ${who}`);
    res.json({ success: true, mac: req.params.mac, blocked: newStatus });
  } catch (e: any) {
    await recordEvent('device', `Cihaz engeli uygulanamadı (${req.params.mac}): ${e.message}`, 'warning');
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

// Trafik Kontrol → Hız Limitleme (throttle_rules) kaldırıldı: kurallar yalnız veritabanındaydı, hiç uygulanmıyordu.
// Cihaz hız sınırı artık Bant Genişliği → Kota ve Hız'da (qos.ts, /api/bandwidth/limits); eski kurallar açılışta taşınır.

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
    // Son yasaklar Fail2Ban'ın kendi günlüğünden (dosya ya da journal; fail2ban.ts). Eskiden saat jail adı, tarih saat
    // olarak gösteriliyordu ve IPv6 yasakları düşüyordu.
    res.json({ ...status, recentBans: await recentBans(20).catch(() => []) });
  } catch (e: any) {
    res.json({ jails: [], recentBans: [], error: e.message });
  }
});

// Ayarlar (fail2ban.ts): /etc/fail2ban/jail.d/klyrix-panel.local'e yazılır, sınanır, yeniden yüklenir; ev ağı muaf listesi.
app.get('/api/fail2ban/settings', async (_req, res) => {
  try {
    res.json(await fail2banSettingsView());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/fail2ban/settings', async (req, res) => {
  try {
    const s = validateFail2banSettings(req.body?.settings);
    if (typeof s === 'string') return res.status(400).json({ error: s });
    const r = await applyFail2banSettings(s);
    if (!r.ok) {
      await recordEvent('fail2ban', `Fail2Ban ayarları uygulanamadı${r.rolledBack ? ' — eski ayarlar geçerli' : ''}: ${r.error || 'bilinmeyen hata'}`, 'warning');
      return res.status(500).json({ error: r.error, rolledBack: !!r.rolledBack });
    }
    const on = (b: boolean) => (b ? 'açık' : 'kapalı');
    await recordEvent('fail2ban', `Fail2Ban ayarları uygulandı: SSH koruması ${on(s.sshd_enabled)} (${s.sshd_maxretry} deneme, ${s.sshd_bantime} sn), varsayılan ${s.maxretry} deneme / ${s.findtime} sn → ${s.bantime} sn, ev ağı muaf ${on(s.lan_exempt)}, tekrarlayanlara 1 hafta ${on(s.recidive)}${s.extra_ignore.length ? `, ek muaf: ${s.extra_ignore.join(' ')}` : ''}`);
    res.json({ success: true, ...(await fail2banSettingsView()) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/fail2ban/unban', async (req, res) => {
  try {
    const ip = String(req.body?.ip || '').trim();
    const r = await unbanIp(ip);
    if (!r.ok) return res.status(400).json({ error: r.error });
    await recordEvent('fail2ban', `Fail2Ban yasağı kaldırıldı: ${ip}`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Unbound ───
// Gerçek durum ve ayarlar (unbound.ts): etkin yapılandırma unbound-checkconf'tan, sayaçlar unbound-control'den okunur.
app.get('/api/unbound/status', async (_req, res) => {
  try {
    res.json(await unboundStatus());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Ayarları Unbound'a uygular: doğrular, yeniden başlatır, yanıt vermezse eski ayarlara döner (DNS ~1-2 sn kesilir).
app.post('/api/unbound/settings', async (req, res) => {
  try {
    const s = validateUnboundSettings(req.body?.settings);
    if (typeof s === 'string') return res.status(400).json({ error: s });
    const r = await applyUnboundSettings(s);
    if (!r.ok) {
      await recordEvent('unbound', `Unbound ayarları uygulanamadı${r.rolledBack ? ' — eski ayarlar geri yüklendi' : ''}: ${r.error || 'bilinmeyen hata'}`, 'warning');
      return res.status(500).json({ error: r.error || 'Uygulanamadı', result: r });
    }
    if (r.changed) {
      const yn = (b: boolean) => (b ? 'açık' : 'kapalı');
      await recordEvent('unbound', `Unbound ayarları uygulandı: önbellek ${s.cache_mb} MB, iş parçacığı ${s.num_threads}, en kısa önbellek süresi ${s.cache_min_ttl} sn, önceden yenileme ${yn(s.prefetch)}, süresi dolmuş kayıt ${yn(s.serve_expired)}, kimlik/sürüm gizleme ${yn(s.hide_identity)}/${yn(s.hide_version)}`);
    }
    res.json({ success: true, result: r });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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

// Start DDNS cron: every 5 minutes. Uyduda (R2) çalışmaz: evin genel adresi ana cihazda güncellenir.
if (!isSatellite()) {
  setInterval(ddnsAutoUpdate, 5 * 60 * 1000);
  // Run once at startup after 30s
  setTimeout(ddnsAutoUpdate, 30000);
}

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
  try {
    // Tek kaynak: scripts/systemd/pi5-lcd.service (install.sh ve post-update.sh de onu kopyalar). Eskiden burada ayrı
    // bir kopya vardı; yorum farkı yüzünden her LCD kaydında birim yeniden yazılıp daemon-reload yapılıyordu.
    const content = fs.readFileSync(require('path').resolve(__dirname, '../../scripts/systemd/pi5-lcd.service'), 'utf8');
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
  wan_if: 'auto',   // 'auto': varsayılan rotanın arayüzü (internet kartı / Wi-Fi / yedek hat değişse de doğru kart)
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
      { interfaces: [], wan: settings.wan_if === 'auto' ? '' : settings.wan_if, mounts: [] };
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
      // kiosk.ts: "açıldı" ancak Chromium gerçekten çalışıyorsa; açılmazsa nedeni (kiosk betiğinin günlüğü)
      res.json({ success: true, ...(await applyKiosk(!!req.body?.enabled)) });
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

// Panel dakikada bir sorar (eskiden saatte bir: yeni güncelleme ancak sayfa yenilenince görünüyordu). GitHub'a yapılan
// git fetch en çok 60 sn'de bir çalışır; aynı anda gelen istekler tek denetimi paylaşır (açık sekme sayısı yükü artırmaz).
let updateCheckCache: { at: number; data: unknown } | null = null;
let updateCheckRun: Promise<unknown> | null = null;
app.get('/api/system/update-check', async (_req, res) => {
  if (!isLinux) return res.json({ available: false, commits: [], currentVersion: 'v2.0-dev' });
  if (updateCheckCache && Date.now() - updateCheckCache.at < 60000) return res.json(updateCheckCache.data);
  if (!updateCheckRun) {
    updateCheckRun = computeUpdateCheck()
      .then(data => { updateCheckCache = { at: Date.now(), data }; return data; })
      .finally(() => { updateCheckRun = null; });
  }
  res.json(await updateCheckRun);
});

async function computeUpdateCheck(): Promise<unknown> {
  try {
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
    return {
      available: commits.length > 0,
      commits,
      currentVersion,
      commitCount: commits.length,
    };
  } catch (e: any) {
    return { available: false, commits: [], currentVersion: 'v2.0', error: e.message };
  }
}

// ─── Quick System Update ───
// İş systemd-run ile backend'in DIŞINDA koşar (update.ts → scripts/update-job.sh): istek hemen döner, panel ilerlemeyi
// /api/system/update/status'tan izler; başarılı işin sonunda backend'i iş yeniden başlatır. Eskiden update.sh bu isteğin
// içinde 5 dk'ya kadar bekletiliyordu — bağlantı kopunca panel "Failed to fetch" gösteriyordu.
app.post('/api/system/update', async (_req, res) => {
  try {
    if (!isLinux) {
      return res.json({ success: false, error: 'Guncelleme sadece Pi5 uzerinde calisir.' });
    }
    const r = await startUpdate();
    if (r.started) await recordEvent('update', 'Panel güncellemesi başlatıldı');
    // steps: bu sürümden önce açılmış sayfa (eski arayüz) yalnız success/steps okur — sayfayı yenilemesi söylenir.
    res.json({ ...r, steps: [{ step: 'Güncelleme arka planda sürüyor — sayfayı yenileyin (Ctrl+Shift+R)', output: '', success: false }] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/system/update/status', async (_req, res) => {
  try {
    if (!isLinux) return res.json({ state: 'idle' });
    res.json(await getUpdateStatus());
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
    // Betik şifreyi okumadan çıkarsa yazma EPIPE verir; dinleyicisiz 'error' olayı tüm backend'i düşürürdü (runKvScript
    // ile aynı). Sonuç yine 'close' ile bildirilir.
    child.stdin.on('error', () => { /* betik stdin'i okumadan çıktı */ });
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
    mode: r.kv.mode === 'form' ? 'form' : 'basic', mode_trial_ends: Number(r.kv.mode_trial_ends) || 0,
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

// Giriş yöntemi: "form" = panelin kendi giriş ekranı (her zaman 5 dk'lık deneme), "basic" = tarayıcının şifre penceresi.
// Onay, yeni giriş ekranından oturum açmış bir tarayıcıdan gelmeli (Pi'nin kendi ekranı şifre sormaz, onayı sayılmaz).
app.post('/api/panel-auth/mode', async (req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  const mode = req.body?.mode;
  if (mode !== 'form' && mode !== 'basic') return res.status(400).json({ error: "mod 'form' ya da 'basic' olmalı" });
  const r = await runPanelAuth(mode === 'form' ? ['mode', 'form', '--trial', String(PANEL_AUTH_TRIAL_S)] : ['mode', 'basic']);
  if (r.code !== 0) return res.status(500).json({ error: panelAuthError(r, 'giriş yöntemi değiştirilemedi') });
  res.json({ success: true, mode_trial_ends: Number(r.kv.mode_trial_ends) || 0 });
});

app.post('/api/panel-auth/mode/confirm', async (req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  if (isLoopbackClient(req.ip)) {
    return res.status(403).json({ error: 'Onayı, yeni giriş ekranından girdiğin başka bir cihazdan (PC/telefon) ver' });
  }
  if (!res.locals.pi5User) {
    return res.status(403).json({ error: 'Önce yeni giriş ekranından giriş yapın (sayfayı yenileyin), sonra onaylayın' });
  }
  const r = await runPanelAuth(['mode-confirm']);
  if (r.code !== 0) return res.status(409).json({ error: panelAuthError(r, 'onaylanamadı') });
  res.json({ success: true });
});

app.post('/api/panel-auth/mode/rollback', async (_req, res) => {
  if (!isLinux) return res.status(400).json({ error: 'Yalnız Pi5 üzerinde çalışır' });
  const r = await runPanelAuth(['mode-rollback']);
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
      // Fail2Ban panel dosyası (ev ağı muaf): eski kurulumlarda güncellemeyle gelir; ağ modu ensure'dan sonra (güncel ağ).
      const f2b = await ensureFail2ban().catch((e: any) => ({ ok: false, changed: false, error: String(e?.message || e) }));
      if (f2b && !f2b.ok) await recordEventOnce('fail2ban', `Fail2Ban ayarları uygulanamadı: ${f2b.error || 'bilinmeyen hata'}`, 'warning', 360);
    }
    if (!isSatellite()) {
      await restoreTunnelsAndRouting();
      await applyPortForwards(); // internet kartı açıksa port yönlendirmeleri (nft tablosu açılışta yoktur)
    }
  })();
  // Uydu (R2): ağ geçidi işleri (yönlendirme kuralları, tüneller, cihaz engelleri, AS aralıkları, ağ haritası ölçümü,
  // trafik kaydı, Pi-hole listeleri, Ev VPN'i) çalışmaz — onlar ana cihazındır. Uydu ana cihazla senkron kalır.
  if (isSatellite()) {
    console.log('[rol] uydu — ağ geçidi işleri kapalı, ana cihazla senkron');
    startSatelliteAgent();
  } else {
  // Uydular: çevrimdışı uyarısı 5 dk'da bir.
  setInterval(() => { void checkOfflineSatellites(); }, 5 * 60 * 1000);
  // İnternet kartı: kartın adresi değişince (PPPoE yeniden bağlandı, operatör yeni adres verdi) DDNS 5 dk beklemeden
  // güncellenir (Ev VPN'i istemcileri yeni adrese hemen ulaşsın).
  let lastWanIp = '';
  setInterval(() => {
    void (async () => {
      const ns = readNetModeState();
      if (!wanActive(ns) || ns.wanStage !== 'on') { lastWanIp = ''; return; }
      const ip = (await getLanIdentity().catch(() => null))?.wan?.ip || '';
      if (ip && lastWanIp && ip !== lastWanIp) void ddnsAutoUpdate();
      if (ip) lastWanIp = ip;
    })();
  }, 60000);
  // Wi-Fi köprüsü (aynı ağ): Pi'nin adresi (modemden) değişince DNS yönlendirme hedefi ve ağ geçidi kuralları yeni adrese
  // yazılır, DDNS güncellenir; panel adresi değiştiği için zile yazılır (modemde Pi'ye adres ayırma önerisiyle).
  let lastRepIp = '';
  setInterval(() => {
    void (async () => {
      const ns = readNetModeState();
      if (!ns || !sameNetActive(ns)) { lastRepIp = ''; return; }
      const ip = (await getLanIdentity().catch(() => null))?.transit.ip || '';
      if (ip && lastRepIp && ip !== lastRepIp) {
        await recordEvent('netmode', `Wi-Fi köprüsü: Pi'nin adresi değişti (${lastRepIp} → ${ip}) — panel artık http://${ip} ya da http://klyrix.local; adres değişmesin diye modemde Pi'ye adres ayırın (Ev VPN'i yönlendirmesi de yeni adrese)`, 'warning');
        await applyAllRoutingRules().catch((e: any) => console.error('Routing yeniden uygulanamadı:', e.message));
        void ddnsAutoUpdate();
      }
      if (ip) lastRepIp = ip;
    })().catch(() => { /* olay yazılamadı */ });
  }, 60000);
  // Yedek hat: izleyici hat değiştirince (durum dosyasındaki geçiş sayısı) olay geçmişine / zile yazılır ve DDNS etkin
  // hattın dış adresine hemen güncellenir (Ev VPN'i istemcileri yeni adrese ulaşsın — yedek hat açık IP'liyse).
  let lastFo: { switches: number } | null = null;
  setInterval(() => {
    void (async () => {
      if (readNetModeState()?.bakStage !== 'on') { lastFo = null; return; }
      const fo = readFailoverStatus();
      if (!fo) return;
      const changed = !!lastFo && fo.switches !== lastFo.switches;
      lastFo = { switches: fo.switches };
      if (!changed) return;
      if (fo.active === 'backup') {
        await recordEvent('netmode-bak', `Ana hat çalışmıyor — yedek hatta geçildi (${fo.backupDev || 'yedek hat'}): ${fo.reason}. Ev ağı internette; yedek hat kotalıysa büyük indirmelerden kaçının`, 'warning');
      } else {
        await recordEvent('netmode-bak', `Ana hatta dönüldü: ${fo.reason}`);
      }
      void ddnsAutoUpdate();
    })().catch(() => { /* olay yazılamadı */ });
  }, 15000);
  // AS aralıkları (ör. WhatsApp aramaları için Meta) 6 saatte bir denetlenir; ilk denetim açılıştan 2 dk sonra.
  setTimeout(() => { void refreshAsnRanges(); }, 120000);
  setInterval(() => { void refreshAsnRanges(); }, 6 * 3600 * 1000);
  setTimeout(() => { void refreshRoutingLists(); }, 180000);
  setInterval(() => { void refreshRoutingLists(); }, 3600 * 1000);
  // Cihaz engelleri (nft tablosu açılışta yoktur; pi5-gw-restore da yükler — burada DB'deki güncel liste yazılır).
  void reapplyBlockedDevices();
  // Ağ haritası: cihazların kablolu / Wi-Fi ayrımı için arka planda ARP yanıt süresi ölçümü (linkProbe.ts). Taban çizgisi
  // Pi'nin kabloyla bağlı olduğu ağ geçidi; Pi'nin çıkışı kablosuzsa taban çizgisi alınmaz. Kurulum Wi-Fi'ı istemcileri
  // ölçülmez (kesin bilinir), modem ve Pi'nin kendisi de.
  if (isLinux) {
    startLinkProbe(async () => {
      const fs = require('fs');
      const [neighbors, modem, own] = await Promise.all([readNeighbors(), readDefaultRoute(), readLocalIps()]);
      // İnternet kartı modu: kart tarafındaki komşular (operatörün modemi) ev ağı cihazı değildir; modem ayrı kartta
      // olduğundan ev ağı ölçümü için taban çizgisi olamaz.
      const wanIfs = uplinkIfaces(readNetModeState()); // internet kartı + yedek hat
      const targets: ProbeTarget[] = [];
      for (const [ip, n] of neighbors) {
        if (['FAILED', 'INCOMPLETE'].includes(n.state) || !n.dev || /^(wg|lo|docker|veth)/.test(n.dev)) continue;
        if (own.has(ip) || ip === modem?.ip || inCidr(ip, AP_NET) || wanIfs.includes(n.dev)) continue;
        targets.push({ ip, mac: n.mac, dev: n.dev });
      }
      const gwN = modem ? neighbors.get(modem.ip) : undefined;
      const wiredUplink = !!modem?.dev && !fs.existsSync(`/sys/class/net/${modem.dev}/wireless`) && !wanIfs.includes(modem.dev);
      return { targets, gateway: modem && gwN && wiredUplink ? { ip: modem.ip, mac: gwN.mac, dev: modem.dev } : null };
    });
    // Trafik analizi: cihaz × yol bayt kayıtları, 5 dk'da bir (saat sınırlarına hizalı).
    startTrafficRecorder();
    // Cihaz hız sınırı ve kota (Bant Genişliği → Kota ve Hız): açılıştan 15 sn sonra, sonra dakikada bir.
    startQos({ protectedMacs: blockProtectedMacs });
  }
  } // !isSatellite
  // Cron: panel görevleri zamanlayıcıya yazılır, ancak bu başarılıysa eski pi5-maintenance satırları çıkarılır (önce yeni
  // dosya). Veritabanı ilk kurulum işleri bitsin diye kısa gecikmeyle.
  setTimeout(() => {
    void (async () => {
      try { await syncCronOnStartup(); }
      catch (e: any) { console.error('[cron] zamanlayıcı eşitlenemedi:', e?.message || e); }
    })();
  }, 5000);
  // Pi-hole listeleri: panel kayıtları Pi-hole'a uygulanır (FTL açılışta geç hazır olabilir → 30 sn sonra; açılıştaki DNS
  // yeniden başlatmasına denk gelirse 2 dk'ya kadar yeniden denenir). Uyduda yok.
  if (!isSatellite()) setTimeout(() => {
    void syncPiholeLists({ waitMs: 120000 }).then(r => {
      if (r.ok) return;
      console.error('[pihole-lists] eşitleme:', r.errors.join('; '));
      void recordEventOnce('pihole', `Pi-hole listeleri açılışta uygulanamadı: ${r.errors.join('; ')}`, 'warning', 60);
    });
  }, 30000);
  // Olay geçmişi: sürüm değiştiyse (elle ya da gece otomatik güncellemesiyle) "Panel güncellendi" bir kez yazılır.
  void recordVersionChange();
  // Ev VPN'i: açıksa yapılandırma ve kurallar güncel hâle getirilir (arayüz açılışta kendi PostUp'ıyla kuralları yükler).
  // Uyduda uygulanmaz (rol geçişinde kapatılır: /api/system/role).
  if (!isSatellite()) setTimeout(() => { void reapplyWgServer(); }, 15000);
  // Panel koruması: deneme sırasında Pi yeniden başladıysa (zamanlayıcı kalıcı değil) süresi geçen deneme geri alınır.
  if (isLinux && require('fs').existsSync(PANEL_AUTH_SCRIPT)) {
    void runPanelAuth(['ensure']).then(r => { if (r.code !== 0 || r.kv.warning) console.error('[panel-auth]', r.kv.error || r.kv.warning); });
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

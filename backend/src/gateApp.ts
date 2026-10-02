// Klyrix/Gate yönetim uygulaması (Pi tarafı): telefondaki uygulama Pi'yi panelin kendisiyle yönetir — evde de evin dışında
// da. Telefon ile Pi arasında şifreli, kalıcı bağlantı; telefonda VPN açılmaz.
//  - Eşleşme (POST /api/app/pair, oturumsuz — auth.ts EXEMPT, panel-auth.sh): telefon kendi WireGuard anahtar çiftini
//    üretir, gizli anahtar telefondan çıkmaz; yalnız genel anahtarını verir. Sahipliği panel şifresi ya da paneldeki
//    eşleştirme kodu (10 dk, tek kullanımlık; QR'da Pi'nin adresleri ve sunucu anahtarı) kanıtlar. Pi telefonu Ev VPN'i
//    arayüzüne (wg_pi) uygulama eşi olarak ekler (wgServer.ts registerAppPeers). Kayıt kendi tablosunda (gate_app_devices),
//    tünel adresi 10.77.77.254'ten aşağı doğru. Eşleşme kaldırılana dek geçerli; kaldırma panelden ya da uygulamadan.
//  - VPN değil: WireGuard telefonda uygulamanın içinde, kullanıcı alanında çalışır (sistem VPN'i / izni yok) ve yalnız
//    uygulamanın kendi trafiğini taşır. Pi'de uygulama eşi yalnız uygulama kapısına ulaşır; ev ağı, internet ve Pi'nin
//    diğer servisleri (DNS dahil) kapalı (wgServer.ts renderNft).
//  - Uygulama kapısı: yalnız WG_SERVER_IP:APP_PORT'ta dinleyen ayrı HTTP sunucusu (Ev VPN'i açıkken ve en az bir eşli
//    telefon varken). Kimlik bağlantının kaynak adresidir: WireGuard bir eşin paketini yalnız onun /32 adresiyle kabul eder,
//    güvenlik duvarı bu portu wg_pi dışından düşürür. İstek o telefonun kimliğiyle panelin kendisine (Express) verilir —
//    panel şifresi / giriş ekranı sorulmaz (auth.ts isGateAppRequest). /api dışı yollar panelin dosyalarıdır (nginx gibi).
//  - Ev VPN'i kapalıyken eşleşme, uygulama açılmasını istemişse yapılır (enableTunnel — uygulama kullanıcıya sorar).
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux, getLanIdentity } from './system';
import { recordEvent } from './events';
import {
  WG_IFACE, WG_PORT, WG_SERVER_IP, APP_PORT, registerAppPeers, onWgRulesChanged, applyWgServer, setServerEnabled,
  serverEnabled, serverPublicKey, serverEndpoint, freePeerIp, validWgKey, type WgApplyResult,
} from './wgServer';
import { readPeerHandshakes } from './topology';
import { GATE_APP, verifyPanelPassword, panelPasswordSet } from './auth';
import { deviceId } from './mesh';
import { isSatellite, STARTUP_ROLE } from './role';
import { qrDataUrl } from './sync';

const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_FAILS = 10;
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // mobile.ts ile aynı: karışmayan harf / rakamlar (0/O, 1/I/L yok)
// Panelin dosyaları (nginx'in kökü): backend/dist/../../frontend/dist
const DIST = path.resolve(__dirname, '../../frontend/dist');

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;
interface DeviceRow { id: number; name: string; platform: string; public_key: string; ip: string; created_at: string; last_seen: string }
export interface GateDevice { id: number; name: string }
export interface AppPairResult {
  device: { id: number; name: string };
  pi: { id: string; name: string };
  // Uygulamanın tünel ayarı: kendi adresi, Pi'nin sunucu anahtarı ve portu, kapı adresi; uç adres evde ev ağı adreslerinden
  // biri (lan), dışarıda remote (DDNS adı ya da dış IP; bulunamazsa boş)
  tunnel: { address: string; serverPublicKey: string; port: number; gate: string; lan: string[]; remote: string };
}

const httpError = (status: number, msg: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { status, extra });
const safeDeviceId = () => { try { return deviceId(); } catch { return ''; } };

// ── kayıtlar ────────────────────────────────────────────────────────────────
let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  tablesReady ??= dbRun(`CREATE TABLE IF NOT EXISTS gate_app_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', public_key TEXT NOT NULL UNIQUE,
    ip TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen TEXT NOT NULL DEFAULT '')`)
    .catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}

// Tünel adresi → telefon (uygulama kapısı her bağlantıda ve istekte buna bakar). Her okumada yenilenir: Ev VPN'i her
// uygulandığında (registerAppPeers) ve her eşleşme / kaldırmada.
let byIp = new Map<string, GateDevice>();
async function loadDevices(): Promise<DeviceRow[]> {
  await ensureTables();
  const rows = await dbAll('SELECT * FROM gate_app_devices ORDER BY id') as DeviceRow[];
  byIp = new Map(rows.map(r => [r.ip, { id: r.id, name: r.name }]));
  return rows;
}

const seenAt = new Map<number, number>();
function touch(d: GateDevice): void {
  const now = Date.now();
  if (now - (seenAt.get(d.id) || 0) < 60_000) return;
  seenAt.set(d.id, now);
  void dbRun('UPDATE gate_app_devices SET last_seen = ? WHERE id = ?', [new Date(now).toISOString(), d.id]).catch(() => {});
}

// ── eşleşme ─────────────────────────────────────────────────────────────────
let pairing: { code: string; expires: number; fails: number } | null = null;
function newCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const liveCode = () => (pairing && pairing.expires > Date.now() ? pairing : null);

// Kod doğru mu (tüketmez: Ev VPN'i onayı istenirse kod geçerli kalır). Yanlış kod sayılır; 10 yanlışta kod düşer.
function checkCode(raw: unknown): void {
  const p = liveCode();
  if (!p) throw httpError(403, 'Eşleştirme kodu yok ya da süresi doldu — panelde yeni kod alın');
  const got = Buffer.from(typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
  const want = Buffer.from(p.code.replace('-', ''));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    if (++p.fails >= PAIR_MAX_FAILS) pairing = null; // kaba kuvvet: kod düşer
    throw httpError(403, 'Eşleştirme kodu yanlış');
  }
}

// Pi'nin ev ağı adresleri (iki bacakta ikisi de): eşleşme isteği ve evdeyken tünelin uç adresi
async function lanHosts(): Promise<string[]> {
  const lan = await getLanIdentity().catch(() => null);
  return [...new Set([lan?.ip, lan?.transit?.ip, lan?.client?.ip].filter((x): x is string => !!x))];
}

// Panel: eşleştirme kodu + QR. at: üretildiği an (panel eşleşmeyi lastPair.at > at ile anlar)
export async function startAppPairing(): Promise<{ code: string; expires: number; qr: string; payload: string; hosts: string[]; at: number }> {
  if (!isLinux) throw httpError(400, 'Yalnız Pi üzerinde çalışır');
  const hosts = await lanHosts();
  if (!hosts.length) throw new Error("Pi'nin ev ağı adresi okunamadı");
  const key = await serverPublicKey();
  pairing = { code: newCode(), expires: Date.now() + PAIR_TTL_MS, fails: 0 };
  // QR içeriği: t = tür, v = sürüm, h = Pi'nin ev ağı adresleri, p = panel portu (eşleşme isteği), c = kod, n = Pi'nin adı,
  // i = cihaz kimliği (keşifteki id), k = sunucu anahtarı (uygulama eşleşme yanıtındakini bununla doğrular: ev ağındaki
  // sahte bir yanıt telefonu başka bir cihaza eşleyemez)
  const payload = JSON.stringify({ t: 'klyrix-gate-app', v: 1, h: hosts, p: 80, c: pairing.code, n: os.hostname(), i: safeDeviceId(), k: key });
  const qr = await qrDataUrl(payload).catch(() => '');
  return { code: pairing.code, expires: pairing.expires, qr, payload, hosts, at: Date.now() };
}
export function cancelAppPairing(): void { pairing = null; }

const deviceName = (raw: unknown): string => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '');
const devicePlatform = (raw: unknown): string => (raw === 'ios' || raw === 'android' ? raw : '');
const platformLabel = (p: string) => (p === 'ios' ? ' (iOS)' : p === 'android' ? ' (Android)' : '');
const NEED_TUNNEL = "Pi'de Ev VPN'i kapalı — uygulama bağlantısı onun kanalını kullanır; açılmasına izin verin";

let lastPair: { id: number; name: string; at: number } | null = null;
let pairChain: Promise<unknown> = Promise.resolve();

// body: { name, platform, publicKey, code | password, enableTunnel? }
export async function pairApp(body: any, ip: string, onTunnelEnabled: () => Promise<void>): Promise<AppPairResult> {
  if (!isLinux) throw httpError(503, 'Yalnız Pi üzerinde çalışır');
  if (isSatellite()) throw httpError(409, 'Bu cihaz uydu — uygulamayı ana cihazla eşleştirin (uydular ana cihazdan yönetilir)');
  const name = deviceName(body?.name);
  if (!name) throw httpError(400, 'Cihaz adı gerekli');
  const publicKey: unknown = body?.publicKey;
  if (!validWgKey(publicKey)) throw httpError(400, 'Geçersiz genel anahtar');
  // Sahiplik kanıtı: paneldeki kod ya da panel şifresi (giriş ekranıyla aynı deneme sınırı)
  let code: string | null = null;
  if (typeof body?.code === 'string' && body.code) {
    checkCode(body.code);
    code = body.code;
  } else if (typeof body?.password === 'string' && body.password) {
    const r = await verifyPanelPassword(body.password, ip);
    if (r === 'none') throw httpError(409, "Panelde şifre koruması kurulu değil — panelde Ev VPN'i → Klyrix/Gate uygulaması → Telefon ekle'den kod alın");
    if (r === 'bad') throw httpError(403, 'Panel şifresi yanlış');
    if (typeof r === 'object') throw httpError(429, `Çok fazla hatalı deneme — ${Math.ceil(r.wait / 60)} dk sonra yeniden deneyin`, { retry_after: r.wait });
  } else {
    throw httpError(400, 'Eşleştirme kodu ya da panel şifresi gerekli');
  }
  if (!(await serverEnabled()) && body?.enableTunnel !== true) throw httpError(409, NEED_TUNNEL, { needTunnel: true });
  // Sıralı: iki istek aynı kodu ya da aynı tünel adresini alamaz
  const run = pairChain.then(() => commitPair({
    name, platform: devicePlatform(body?.platform), publicKey, code, allowEnable: body?.enableTunnel === true, onTunnelEnabled,
  }));
  pairChain = run.catch(() => {});
  return run;
}

async function commitPair(o: {
  name: string; platform: string; publicKey: string; code: string | null; allowEnable: boolean; onTunnelEnabled: () => Promise<void>;
}): Promise<AppPairResult> {
  if (o.code !== null) {
    checkCode(o.code); // bu arada başka bir istek kullandıysa ya da panel yenisini aldıysa geçersiz
    pairing = null;
  }
  await ensureTables();
  const serverKey = await serverPublicKey();
  if (o.publicKey === serverKey) throw httpError(400, 'Geçersiz genel anahtar');
  const vpn = await dbAll('SELECT public_key FROM wg_server_peers').catch(() => []) as { public_key: string }[];
  if (vpn.some(v => v.public_key === o.publicKey)) throw httpError(409, "Bu anahtar bir Ev VPN'i istemcisinde kullanılıyor — uygulamada yeniden deneyin");
  const off = !(await serverEnabled());
  if (off && !o.allowEnable) throw httpError(409, NEED_TUNNEL, { needTunnel: true });
  // Aynı telefon yeniden eşleşiyorsa (ör. ilk yanıt ona ulaşmadı) kaydı güncellenir, tünel adresi aynı kalır
  const existing = await dbGet('SELECT * FROM gate_app_devices WHERE public_key = ?', [o.publicKey]) as DeviceRow | undefined;
  let id: number;
  let ip: string;
  if (existing) {
    await dbRun('UPDATE gate_app_devices SET name = ?, platform = ? WHERE id = ?', [o.name, o.platform, existing.id]);
    id = existing.id;
    ip = existing.ip;
  } else {
    ip = await freePeerIp(true);
    id = await dbInsert('INSERT INTO gate_app_devices (name, platform, public_key, ip) VALUES (?, ?, ?, ?)', [o.name, o.platform, o.publicKey, ip]);
  }
  await loadDevices();
  const r = off ? await setServerEnabled(true) : await applyWgServer();
  if (!r.ok) {
    // Geri al: yeni kayıt silinir, Ev VPN'i önceki durumuna döner
    if (!existing) {
      await dbRun('DELETE FROM gate_app_devices WHERE id = ?', [id]).catch(() => {});
      await loadDevices().catch(() => {});
    }
    const back = off ? await setServerEnabled(false).catch(() => null) : await applyWgServer();
    if (back && !back.ok) console.error('[gate-app] geri alınamadı:', back.error);
    await recordEvent('vpn', `Klyrix/Gate uygulaması eşleşemedi: ${o.name} — ${r.error || 'bilinmeyen hata'}`, 'warning');
    throw httpError(500, `Pi'ye uygulanamadı: ${r.error || 'bilinmeyen hata'}`);
  }
  if (off) {
    await recordEvent('vpn', `Ev VPN'i açıldı (UDP ${WG_PORT}) — Klyrix/Gate uygulaması eşleşmesi için`);
    await o.onTunnelEnabled().catch((e: any) => console.error('[gate-app] internet kartı güvenlik duvarı:', e?.message || e));
  }
  await reconcileGate();
  lastPair = { id, name: o.name, at: Date.now() };
  await recordEvent('vpn', `Klyrix/Gate uygulaması eşleşti: ${o.name}${platformLabel(o.platform)} — ${ip}, ${o.code !== null ? 'panel kodu' : 'panel şifresi'}${existing ? ' (yeniden)' : ''}`);
  return {
    device: { id, name: o.name },
    pi: { id: safeDeviceId(), name: os.hostname() },
    tunnel: {
      address: ip, serverPublicKey: serverKey, port: WG_PORT, gate: `${WG_SERVER_IP}:${APP_PORT}`, lan: await lanHosts(),
      remote: (await serverEndpoint().catch(() => ({ host: '' }))).host,
    },
  };
}

// Kimlik yanıtı (GET /api/app/pair, oturumsuz): uygulama keşfettiği cihazın eşleşme seçeneklerini bununla gösterir.
// code: panelde şu an açık bir kod var mı; password: panel şifresi kurulu mu; tunnel: Ev VPN'i açık mı. Sürüm yok.
export async function gateAppHello() {
  const main = !isSatellite();
  return {
    app: 'klyrix-gate', v: 1, id: safeDeviceId(), name: os.hostname(), role: STARTUP_ROLE,
    code: main && !!liveCode(), password: panelPasswordSet(), tunnel: main && await serverEnabled().catch(() => false),
  };
}

// ── uygulama kapısı ─────────────────────────────────────────────────────────
let mainApp: express.Express | null = null;
let staticApp: express.Express | null = null;
let gate: http.Server | null = null;
let gateError = '';
const conns = new Map<net.Socket, string>(); // açık bağlantı → telefonun tünel adresi
const plainIp = (a: string | undefined) => String(a || '').replace(/^::ffff:/, '');

// Panelin dosyaları: nginx'teki gibi (try_files $uri $uri/ /index.html + aynı güvenlik başlıkları)
function makeStaticApp(): express.Express {
  const s = express();
  s.disable('x-powered-by');
  s.use((_req, res, next) => {
    res.set({
      'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Type-Options': 'nosniff', 'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });
  s.use(express.static(DIST));
  s.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end(); return; }
    res.sendFile(path.join(DIST, 'index.html'), err => {
      if (err && !res.headersSent) res.status(404).type('text/plain').send('Panel dosyaları bulunamadı');
    });
  });
  return s;
}

function onGateRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const dev = byIp.get(plainIp(req.socket.remoteAddress));
  if (!dev || !mainApp || !staticApp) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Bu telefon Pi ile eşleşmemiş — uygulamada yeniden eşleştirin' }));
    return;
  }
  // İşaret istek nesnesinin sembol alanıdır: istemci başlıkla koyamaz (auth.ts isGateAppRequest)
  (req as unknown as Record<symbol, unknown>)[GATE_APP] = dev;
  touch(dev);
  const u = req.url || '/';
  if (u === '/api' || u.startsWith('/api/') || u.startsWith('/api?')) mainApp(req, res);
  else staticApp(req, res);
}

async function listenGate(): Promise<void> {
  if (gate) return;
  const s = http.createServer(onGateRequest);
  s.headersTimeout = 30_000;
  s.requestTimeout = 300_000; // nginx proxy_read_timeout ile aynı: uzun süren panel işlemleri (erişim testi, güncelleme)
  s.keepAliveTimeout = 65_000;
  // Eşli olmayan adresten gelen bağlantı HTTP'ye bile geçmeden kapanır (Ev VPN'i istemcileri de kapıya gelemez)
  s.on('connection', (sock: net.Socket) => {
    const ip = plainIp(sock.remoteAddress);
    if (!byIp.has(ip)) { sock.destroy(); return; }
    conns.set(sock, ip);
    sock.on('close', () => conns.delete(sock));
  });
  await new Promise<void>(resolve => {
    s.once('error', (e: any) => {
      gateError = e?.code === 'EADDRINUSE' ? `Port ${APP_PORT} başka bir uygulamada`
        : e?.code === 'EADDRNOTAVAIL' ? `Ev VPN'i arayüzü henüz ${WG_SERVER_IP} adresini almadı` : String(e?.message || e);
      console.error('[gate-app] uygulama kapısı açılamadı:', gateError);
      resolve();
    });
    s.listen(APP_PORT, WG_SERVER_IP, () => {
      gate = s;
      gateError = '';
      // Dinlerken çıkan hata (ör. accept: EMFILE) dinleyicisiz kalırsa panel servisi çökerdi
      s.on('error', (e: any) => console.error('[gate-app] uygulama kapısı:', e?.message || e));
      resolve();
    });
  });
}

async function closeGate(): Promise<void> {
  gateError = '';
  if (!gate) return;
  const s = gate;
  gate = null;
  for (const sock of conns.keys()) sock.destroy();
  await new Promise<void>(resolve => s.close(() => resolve()));
}

// Kapı açık olmalı mı: ana cihaz + Ev VPN'i arayüzü ayakta + en az bir eşli telefon. Kaldırılan telefonun bağlantıları kesilir.
let reconcileRun: Promise<void> | null = null;
export function reconcileGate(): Promise<void> {
  if (reconcileRun) return reconcileRun.then(() => reconcileGate());
  reconcileRun = (async () => {
    if (!isLinux || isSatellite()) return;
    const rows = await loadDevices().catch((e: any) => { console.error('[gate-app] kayıtlar okunamadı:', e?.message || e); return null; });
    if (!rows) return;
    if (rows.length && fs.existsSync(`/sys/class/net/${WG_IFACE}`)) await listenGate();
    else await closeGate();
    for (const [sock, ip] of conns) if (!byIp.has(ip)) sock.destroy();
  })().finally(() => { reconcileRun = null; });
  return reconcileRun;
}

// ── panel ───────────────────────────────────────────────────────────────────
export async function gateAppStatus() {
  const rows = isLinux ? await loadDevices() : [];
  const hs = isLinux ? await readPeerHandshakes(WG_IFACE) : new Map<string, number>();
  // Buluttan geri yüklenen bir Ev VPN'i istemcisi telefonun adresini / anahtarını taşıyorsa telefon tünele yazılmaz (wgServer.ts)
  const vpn = await dbAll('SELECT ip, public_key FROM wg_server_peers').catch(() => []) as { ip: string; public_key: string }[];
  const vpnIps = new Set(vpn.map(v => v.ip));
  const vpnKeys = new Set(vpn.map(v => v.public_key));
  const p = liveCode();
  return {
    supported: isLinux,
    tunnel: { enabled: await serverEnabled().catch(() => false), running: isLinux && fs.existsSync(`/sys/class/net/${WG_IFACE}`) },
    gate: { listening: !!gate, error: gateError, address: `${WG_SERVER_IP}:${APP_PORT}` },
    passwordSet: panelPasswordSet(),
    devices: rows.map(r => ({
      id: r.id, name: r.name, platform: r.platform, ip: r.ip, created_at: r.created_at, last_seen: r.last_seen,
      handshake: hs.get(r.ip) || 0, conflict: vpnIps.has(r.ip) || vpnKeys.has(r.public_key),
    })),
    pairing: p ? { code: p.code, expires: p.expires } : null,
    lastPair,
  };
}

async function removeDevice(raw: unknown): Promise<DeviceRow> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Geçersiz cihaz');
  await ensureTables();
  const d = await dbGet('SELECT * FROM gate_app_devices WHERE id = ?', [id]) as DeviceRow | undefined;
  if (!d) throw httpError(404, 'Cihaz bulunamadı');
  await dbRun('DELETE FROM gate_app_devices WHERE id = ?', [id]);
  await loadDevices(); // kapı bu telefonun yeni isteklerini artık reddeder
  seenAt.delete(id);
  return d;
}
// Açık bağlantıları kesilir, tünel eşi düşer (Ev VPN'i açıksa; kapalıysa açılınca zaten yazılmaz)
async function dropDevice(d: DeviceRow): Promise<WgApplyResult | null> {
  for (const [sock, ip] of conns) if (ip === d.ip) sock.destroy();
  const apply = (await serverEnabled().catch(() => false)) ? await applyWgServer() : null;
  if (!apply) await reconcileGate(); // uygulandıysa kanca (onWgRulesChanged) zaten çalıştırır
  const failed = !!apply && !apply.ok;
  await recordEvent('vpn', `Klyrix/Gate uygulaması kaldırıldı: ${d.name}${failed ? ` — Pi'ye uygulanamadı: ${apply!.error}` : ''}`, failed ? 'warning' : 'info');
  return apply;
}

const fail = (res: express.Response, e: any) => {
  const status = Number(e?.status) || 500;
  if (status >= 500) console.error('[gate-app]', e?.message || e);
  if (e?.extra?.retry_after) res.set('Retry-After', String(e.extra.retry_after));
  res.status(status).json({ error: String(e?.message || e), ...(e?.extra || {}) });
};

// Uçlar: GET/POST /api/app/pair (telefon; oturumsuz, Host denetimi yok — telefon Pi'ye IP ile gelir, kimliği kod / şifre
// kanıtlar), GET /api/app (durum), POST /api/app/pair/code ve /pair/cancel, DELETE /api/app/devices/:id. Panel yazma
// uçları: yazma sınırı + netAdminGuard; uyduda 409. Uygulama kapısından gelen telefon da (aynı panel) kullanabilir.
export function registerGateAppRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw; onTunnelEnabled: () => Promise<void> }): void {
  mainApp = app;
  staticApp = makeStaticApp();
  // Ev VPN'i her uygulandığında (yapılandırma + kurallar) uygulama eşleri buradan okunur — rol ne olursa olsun kayıtlı
  registerAppPeers(async () => (await loadDevices()).map(r => ({ id: r.id, ip: r.ip, public_key: r.public_key })));

  app.use('/api/app', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.path === '/pair') return req.method === 'GET' ? next() : deps.writeLimiter(req, res, next);
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — Klyrix/Gate uygulaması ana cihazla eşleşir' });
    if (req.method === 'GET') return next();
    deps.writeLimiter(req, res, () => deps.guard(req, res, next));
  });

  app.get('/api/app/pair', async (_req, res) => {
    try { res.json(await gateAppHello()); } catch (e) { fail(res, e); }
  });
  app.post('/api/app/pair', async (req, res) => {
    try { res.json(await pairApp(req.body, String(req.ip || ''), deps.onTunnelEnabled)); } catch (e) { fail(res, e); }
  });
  app.get('/api/app', async (_req, res) => {
    try { res.json(await gateAppStatus()); } catch (e) { fail(res, e); }
  });
  app.post('/api/app/pair/code', async (_req, res) => {
    try { res.json(await startAppPairing()); } catch (e) { fail(res, e); }
  });
  app.post('/api/app/pair/cancel', (_req, res) => {
    cancelAppPairing();
    res.json({ success: true });
  });
  app.delete('/api/app/devices/:id', async (req, res) => {
    try {
      const d = await removeDevice(req.params.id);
      const self = (req as unknown as Record<symbol, GateDevice | undefined>)[GATE_APP]?.id === d.id;
      if (self) {
        // Telefon kendini kaldırıyor: önce yanıt (tünel eşi düşünce yanıt ona ulaşamaz), sonra kesilir
        res.on('finish', () => { setTimeout(() => { void dropDevice(d).catch((e: any) => console.error('[gate-app]', e?.message || e)); }, 1000); });
        res.json({ success: true });
        return;
      }
      const apply = await dropDevice(d);
      if (apply && !apply.ok) return res.status(500).json({ error: `Kaldırıldı ama Pi'ye uygulanamadı: ${apply.error}` });
      res.json({ success: true });
    } catch (e) { fail(res, e); }
  });
}

// Açılışta (ana cihaz): kapı Ev VPN'i her uygulandığında ve dakikada bir yeniden değerlendirilir
export function startGateApp(): void {
  if (!isLinux || isSatellite()) return;
  onWgRulesChanged(() => reconcileGate());
  setInterval(() => { void reconcileGate().catch(() => {}); }, 60_000);
  void reconcileGate().catch(() => {});
}

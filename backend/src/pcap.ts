// Paket kaydı (G2.2, Ağ Araçları → Paket Kaydı): seçilen cihazın 10 / 30 / 60 sn trafiği .pcap (Wireshark) olarak indirilir.
//  - Gizlilik (KVKK — başkasının trafiği): yalnız panel koruması kalıcı açıkken (remoteAccess.ts panelAuthOn) çalışır; kapalıyken
//    uçlar 403, var olan kayıt silinir. Yasal uyarı onayı zorunlu (consent: true). Varsayılan yalnız başlıklar (paket başına
//    ilk 128 bayt); tam paket ayrıca seçilir. Her kayıt, indirme ve silme Bildirimler'e denetim izi olarak yazılır (kaynak
//    'pcap': kim, hangi cihaz, süre, kip, istemci IP'si); başlatma olayı kayıttan ÖNCE yazılır, yazılamazsa kayıt başlamaz.
//    Dosya bir kez indirilince ya da en geç 10 dk sonra silinir: 10 dk silmesi panel servisinden bağımsız bir systemd
//    zamanlayıcısıyla da kurulur (pi5-pcap-expire; panel servisi kapalıyken de çalışır).
//  - Varsayılan: hiçbir şey çalışmaz. Kayıt başlatılmadıkça dizin, zamanlayıcı, birim yoktur; ağ, nft ve arayüzler değişmez
//    (tcpdump kartı karışık kipe almaz: -p).
//  - Çalıştırma: scripts/pcap-run.sh, pi5-backend'in DIŞINDA tekil geçici birimde (systemd-run --unit=pi5-pcap,
//    RuntimeMaxSec=90, MemoryMax, Nice=10). Panel servisi yeniden başlasa da (güncelleme, depolama işi) kayıt sürer; durum
//    /run/pi5-pcap/state'te kalır, açılışta temizlik zamanlayıcısı yeniden kurulur. Argümanlar argv ile verilir ve betik
//    onları yeniden doğrular; süzgeç yalnız "ether host <MAC>" ya da "host <IPv4>".
//  - Kayıt RAM'de (/run/pi5-pcap 0700, dosyalar 0600); boyut tavanı profile göre (standard 50 MB, lite / bilinmiyor 8 MB),
//    /run'daki boş yer azsa ona göre küçülür (RAM diski sıfıra kadar dolmasın). Aynı anda tek kayıt: süren ya da
//    indirilmeyi bekleyen kayıt varken yenisi 409. Başlatma, silme ve temizlik sırayla çalışır (serial).
//  - Arayüz: cihazın komşu tablosundaki kartı (eth0 / br0 / Kurulum Wi-Fi'ı / Wi-Fi köprüsünün ev tarafı); Ev VPN istemcisi
//    (10.77.77.x) wg_pi'de adresiyle. İnternet tarafı kartları (internet kartı, yedek hat, Wi-Fi köprüsünün üst bağlantısı),
//    Pi'nin kendisi ve korunan cihazlar (modem / üst router, Pi'nin kartları — index.ts blockProtectedMacs) reddedilir.
//    '-i any' kullanılmaz (köprüde aynı paketi iki kez yakalar).
//  - Uyduda kapalı (uçlar 409, açılış '!isSatellite'); HA'da düğüm yerel.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type express from 'express';
import { dbAll, dbRun } from './db';
import { recordEvent } from './events';
import { isSatellite } from './role';
import { isLinux, readNetModeState, uplinkIfaces } from './system';
import { readNeighbors, readNeighbors6, readLocalIps, inCidr } from './topology';
import { panelAuthOn } from './remoteAccess';
import { readPlatform, type Platform } from './hardware';
import { WG_IFACE, WG_NET, WG_SERVER_IP } from './wgServer';
import { isLoopbackIp } from './auth';
import { parseKv } from './update';

const execFileP = promisify(execFile);

const UNIT = 'pi5-pcap';
const EXPIRE_UNIT = 'pi5-pcap-expire';   // 10 dk silme zamanlayıcısı (panel servisinden bağımsız)
const DIR = '/run/pi5-pcap';
const STATE = `${DIR}/state`;
const SCRIPT = path.resolve(__dirname, '../../scripts/pcap-run.sh');
export const PCAP_SECONDS = [10, 30, 60];
export type PcapMode = 'headers' | 'full';
const SNAPLEN: Record<PcapMode, number> = { headers: 128, full: 0 };
const CAP_STANDARD = 50 * 1024 * 1024;
const CAP_LITE = 8 * 1024 * 1024;
const RUNTIME_MAX_S = 90;   // en uzun kayıt 60 sn; birim takılırsa systemd durdurur
// Birim bellek sınırı: süreçlere 64 MB + kayıt dosyası. /run RAM diskidir ve dosyanın sayfaları birimin cgroup'una yazılır
// (50 MB tavanda birim ~58 MB ölçüldü — düz 64M'de dosya büyüdükçe OOM payı kalmıyordu).
const memoryMax = (maxBytes: number) => `${64 + Math.ceil(maxBytes / 1048576)}M`;
const KEEP_S = 600;         // kayıt başlangıcından en geç 10 dk sonra silinir
const START_GRACE_S = 5;    // bu süre içinde birim henüz görünmüyorsa kayıt "yarıda kesildi" sayılmaz
// /run (RAM diski) başka hizmetlere de lazım: kayıt bu kadarını boş bırakır; bundan az yer kalırsa (1 MB) kayıt başlamaz.
const RUN_RESERVE = 16 * 1024 * 1024;
const RUN_MIN = 1024 * 1024;
const ID_RE = /^[0-9a-f]{32}$/;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4_RE = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IFNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}$/;
const TCPDUMP_PATHS = ['/usr/bin/tcpdump', '/usr/sbin/tcpdump', '/bin/tcpdump', '/sbin/tcpdump'];

const AUTH_MSG = 'Paket kaydı yalnız panel koruması (panel şifresi) kalıcı açıkken kullanılabilir — başkasının trafiğini kaydetmek '
  + 'hassastır. Üstteki banttan korumayı açıp kalıcı yapın.';
const PI_SELF = "Bu, Pi'nin kendi adresi — paket kaydı ev ağındaki cihazlar içindir";
const PROTECTED = "Modem / üst router ve Pi'nin kartları korunur — bu cihazın paket kaydı alınamaz";

export interface PcapTarget { key: string; mac: string; ip: string; name: string; iface: string; vpn: boolean }
interface Job {
  id: string; started: number; seconds: number; mode: PcapMode; iface: string; kind: 'ether' | 'host'; addr: string;
  mac: string; ip: string; label: string; maxBytes: number;
}
export interface PcapJobView {
  id: string; state: 'running' | 'done' | 'failed';
  target: { label: string; mac: string; ip: string; iface: string; vpn: boolean };
  seconds: number; mode: PcapMode; startedAt: number; expiresAt: number; maxBytes: number;
  bytes: number; packets: number | null; dropped: number | null; capped: boolean; note: string; error: string;
}
class PcapError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const tcpdumpInstalled = () => TCPDUMP_PATHS.some(p => fs.existsSync(p));
const capFor = (p: Platform | null) => (p?.profile === 'standard' ? CAP_STANDARD : CAP_LITE);
const nowS = () => Math.floor(Date.now() / 1000);
const numOrNull = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : null);
const fileSize = (p: string): number | null => { try { return fs.statSync(p).size; } catch { return null; } };
// Olay metni ve durum dosyası satır tabanlı: denetim karakterleri boşluk olur, ad kısalır (DHCP adı cihazdan gelir).
const cleanLabel = (s: unknown) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const fmtBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const modeText = (m: PcapMode) => (m === 'full' ? 'tam paket' : 'yalnız başlıklar');

// Kim istedi: giriş ekranı kipinde oturumun kullanıcısı; şifre penceresi kipinde nginx kimliği doğrulamıştır (panel-auth.sh'nin
// tek kullanıcısı). Pi'nin kendi ekranı (kiosk) şifresiz girer.
function requester(req: express.Request, res: express.Response): string {
  const ip = String(req.ip || '').replace(/^::ffff:/, '') || 'bilinmeyen adres';
  if (isLoopbackIp(req.ip)) return `Pi'nin kendi ekranı (${ip})`;
  const user = typeof res.locals.pi5User === 'string' ? cleanLabel(res.locals.pi5User) : '';
  return `${user || 'panel yöneticisi'}, ${ip}`;
}

// ─── Durum dosyası (backend yazar, systemd-run'dan ÖNCE; betik yalnız <id>.rc / .part / .pcap yazar) ───
function readState(): Job | null {
  let kv: Record<string, string>;
  try { kv = parseKv(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
  const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : NaN);
  const j: Job = {
    id: kv.id || '', started: n(kv.started), seconds: n(kv.seconds), mode: kv.mode === 'full' ? 'full' : 'headers',
    iface: kv.iface || '', kind: kv.kind === 'host' ? 'host' : 'ether', addr: kv.addr || '', mac: kv.mac || '', ip: kv.ip || '',
    label: cleanLabel(kv.label), maxBytes: n(kv.max),
  };
  if (!ID_RE.test(j.id) || !Number.isFinite(j.started) || !PCAP_SECONDS.includes(j.seconds) || !IFNAME_RE.test(j.iface)
    || !Number.isFinite(j.maxBytes)) return null;
  return j;
}
function writeState(j: Job): void {
  const text = [`id=${j.id}`, `started=${j.started}`, `seconds=${j.seconds}`, `mode=${j.mode}`, `iface=${j.iface}`, `kind=${j.kind}`,
    `addr=${j.addr}`, `mac=${j.mac}`, `ip=${j.ip}`, `label=${cleanLabel(j.label)}`, `max=${j.maxBytes}`].join('\n') + '\n';
  const tmp = `${STATE}.b${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}

// systemctl okunamazsa 'unknown': süren kaydı yanlışlıkla "yarıda kesildi" saymayalım, ikinci kayıt da başlatmayalım.
async function unitState(): Promise<'active' | 'inactive' | 'unknown'> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', '-p', 'ActiveState', '--value', `${UNIT}.service`], { timeout: 5000 });
    return /^(active|activating|deactivating|reloading)$/.test(stdout.trim()) ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

async function jobView(j: Job): Promise<PcapJobView> {
  const base = {
    id: j.id, target: { label: j.label, mac: j.mac, ip: j.ip, iface: j.iface, vpn: j.iface === WG_IFACE },
    seconds: j.seconds, mode: j.mode, startedAt: j.started, expiresAt: j.started + KEEP_S, maxBytes: j.maxBytes,
    bytes: 0, packets: null, dropped: null, capped: false, note: '', error: '',
  };
  let rc: Record<string, string> | null = null;
  try { rc = parseKv(fs.readFileSync(`${DIR}/${j.id}.rc`, 'utf8')); } catch { rc = null; }
  if (!rc) {
    if (j.id === launchingId || nowS() - j.started < START_GRACE_S || (await unitState()) !== 'inactive') {
      return { ...base, state: 'running', bytes: fileSize(`${DIR}/${j.id}.part`) ?? 0 };
    }
    return { ...base, state: 'failed', error: 'Kayıt yarıda kesildi (süre sınırı ya da sistem durdurdu)' };
  }
  const size = fileSize(`${DIR}/${j.id}.pcap`);
  if (rc.rc === '0' && size !== null) {
    return { ...base, state: 'done', bytes: size, packets: numOrNull(rc.packets), dropped: numOrNull(rc.dropped), capped: rc.capped === '1', note: rc.note || '' };
  }
  return { ...base, state: 'failed', error: rc.rc === '0' ? 'Kayıt dosyası bulunamadı' : rc.error || 'Kayıt alınamadı' };
}

// ─── Sıralama: başlatma, silme ve temizlik aynı anda çalışmaz (söz zinciri). Başlatma sürerken gelen silme / temizlik
// başlatmanın bitmesini bekler — yoksa birim açılmadan silinen kayıt ardından açılır, API'de görünmeden sürerdi. ───
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
let launching = false;                  // başlatma isteği sürüyor (ikinci başlatma hemen 409)
let launchingId: string | null = null;  // başlatılan kaydın kimliği: birim açılana dek "sürüyor" sayılır
let downloading: string | null = null;  // indirilen kaydın kimliği: aynı anda ikinci indirme 409

// ─── Temizlik: indirilince, silinince, 10 dk dolunca ya da panel koruması kapanınca. Birim sürüyorsa önce durdurulur. ───
// Zamanlayıcılar yalnız bir kayıt varken kurulur: süreç içi (durum dosyası + birim) ve panel servisinden bağımsız systemd
// zamanlayıcısı (pi5-pcap-expire: panel servisi depolama işi / başarısız güncelleme yüzünden kapalıyken de 10 dk'da siler).
let expiryTimer: NodeJS.Timeout | null = null;
function armExpiry(j: Job): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  // Yalnız bu kayıt hâlâ duruyorsa silinir (arada indirilip yenisi başladıysa yenisine dokunulmaz).
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    void serial(async () => { const s = readState(); if (!s || s.id === j.id) await purge(); });
  }, Math.max(0, (j.started + KEEP_S) * 1000 - Date.now()));
}
async function stopExpireTimer(): Promise<void> {
  const units = [`${EXPIRE_UNIT}.timer`, `${EXPIRE_UNIT}.service`];
  await execFileP('systemctl', ['stop', ...units], { timeout: 15000 }).catch(() => { /* yok / zaten durdu */ });
  await execFileP('systemctl', ['reset-failed', ...units], { timeout: 15000 }).catch(() => { /* yok */ });
}
// Yalnız serial() içinden çağrılır.
async function purge(): Promise<void> {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
  if ((await unitState()) !== 'inactive') {
    await execFileP('systemctl', ['stop', `${UNIT}.service`], { timeout: 30000 }).catch(() => { /* birim yok / zaten durdu */ });
  }
  await stopExpireTimer();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e: any) { console.error('[paket kaydı] silinemedi:', e?.message || e); }
}

// /run'daki kullanılabilir yer (bayt); okunamazsa sınırsız sayılır (tavan profilden gelir).
function runRoom(): number {
  try { const f = fs.statfsSync('/run'); return f.bavail * f.bsize; } catch { return Number.MAX_SAFE_INTEGER; }
}

// Açılış (uyduda çağrılmaz): kayıt yoksa hiçbir şey yapılmaz. Panel servisi kayıt sürerken yeniden başladıysa birim sürer;
// durum dosyasından temizlik zamanlayıcısı yeniden kurulur (systemd zamanlayıcısı zaten kuruludur). Süresi geçmiş ya da
// sahipsiz artık silinir.
export function startPcap(): void {
  if (!isLinux || !fs.existsSync(DIR)) return;
  const j = readState();
  if (!j || nowS() >= j.started + KEEP_S) { void serial(purge); return; }
  armExpiry(j);
}

// ─── Hedef çözümleme ───
// Kayda kapalı kartlar: internet tarafı (internet kartı + yedek hat; net-mode.sh ile aynı küme) ve Wi-Fi köprüsünün üst
// bağlantısı (R4 C: Pi üst Wi-Fi'a istemci). Konteyner / tünel / loopback kartları da cihaz kartı değildir.
function rejectedIfaces(): Set<string> {
  const s = readNetModeState();
  const out = new Set(uplinkIfaces(s));
  if (s && s.repStage !== 'none' && s.repPort) out.add(s.repPort);
  return out;
}
const usableDev = (dev: string, reject: Set<string>) =>
  IFNAME_RE.test(dev) && !reject.has(dev) && !/^(lo|docker|veth|wg)/.test(dev) && fs.existsSync(`/sys/class/net/${dev}`);
const LIVE_NEIGH = (state: string) => state !== 'FAILED' && state !== 'INCOMPLETE';

async function deviceNames(): Promise<Map<string, string>> {
  const rows = await dbAll("SELECT lower(mac_address) AS mac, hostname FROM devices WHERE COALESCE(hostname, '') <> ''").catch(() => []);
  return new Map((rows as { mac: string; hostname: string }[]).map(r => [r.mac, cleanLabel(r.hostname)]));
}
async function vpnPeers(): Promise<{ name: string; ip: string }[]> {
  const rows = await dbAll('SELECT name, ip FROM wg_server_peers ORDER BY id').catch(() => []);
  return (rows as { name: string; ip: string }[]).filter(p => IPV4_RE.test(String(p.ip)) && inCidr(p.ip, WG_NET) && p.ip !== WG_SERVER_IP);
}

type ProtectedMacs = () => Promise<Set<string>>;

async function listTargets(protectedMacs: ProtectedMacs): Promise<PcapTarget[]> {
  const reject = rejectedIfaces();
  const [n4, own, prot, names] = await Promise.all([readNeighbors(), readLocalIps(), protectedMacs().catch(() => new Set<string>()), deviceNames()]);
  const byMac = new Map<string, PcapTarget>();
  for (const [ip, n] of n4) {
    if (!LIVE_NEIGH(n.state) || !MAC_RE.test(n.mac) || !usableDev(n.dev, reject) || own.has(ip) || prot.has(n.mac) || byMac.has(n.mac)) continue;
    byMac.set(n.mac, { key: n.mac, mac: n.mac, ip, name: names.get(n.mac) || '', iface: n.dev, vpn: false });
  }
  const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + (Number(o) || 0), 0);
  const out = [...byMac.values()].sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  if (fs.existsSync(`/sys/class/net/${WG_IFACE}`)) {
    for (const p of await vpnPeers()) out.push({ key: `vpn:${p.ip}`, mac: '', ip: p.ip, name: cleanLabel(p.name), iface: WG_IFACE, vpn: true });
  }
  return out;
}

type Resolved = Pick<Job, 'iface' | 'kind' | 'addr' | 'mac' | 'ip' | 'label'>;
async function resolveTarget(mac: string, ip: string, protectedMacs: ProtectedMacs): Promise<Resolved> {
  const own = await readLocalIps();
  // Ev VPN istemcisi: komşu tablosunda yoktur (katman 3 tünel) — wg_pi'de adresiyle.
  if (!mac && inCidr(ip, WG_NET)) {
    if (ip === WG_SERVER_IP || own.has(ip)) throw new PcapError(409, PI_SELF);
    const peer = (await vpnPeers()).find(p => p.ip === ip);
    if (!peer) throw new PcapError(404, `${ip} kayıtlı bir Ev VPN istemcisi değil`);
    if (!fs.existsSync(`/sys/class/net/${WG_IFACE}`)) throw new PcapError(409, "Ev VPN'i kapalı — istemcinin trafiği Pi'den geçmiyor");
    return { iface: WG_IFACE, kind: 'host', addr: ip, mac: '', ip, label: cleanLabel(peer.name) || ip };
  }
  if (ip && own.has(ip)) throw new PcapError(409, PI_SELF);
  const reject = rejectedIfaces();
  const [n4, n6, prot] = await Promise.all([readNeighbors(), readNeighbors6(), protectedMacs().catch(() => null)]);
  // Korunan MAC listesi okunamazsa kayıt alınmaz (koruma "bilinmiyor" durumunda açık kalmasın).
  if (!prot) throw new PcapError(503, 'Korunan cihaz listesi okunamadı — birazdan yeniden deneyin');
  let m = mac;
  if (!m) {
    const n = n4.get(ip);
    if (!n || !LIVE_NEIGH(n.state)) throw new PcapError(404, `${ip} şu an ağda görünmüyor — cihazı uyandırıp yeniden deneyin`);
    m = n.mac;
  }
  if (prot.has(m)) throw new PcapError(409, PROTECTED);
  const entries = [...n4, ...n6].filter(([, n]) => n.mac === m && LIVE_NEIGH(n.state));
  if (!entries.length) throw new PcapError(404, 'Cihaz şu an ağda görünmüyor — cihazı uyandırıp yeniden deneyin');
  const hit = entries.find(([, n]) => usableDev(n.dev, reject));
  if (!hit) {
    const dev = entries[0][1].dev;
    throw new PcapError(409, reject.has(dev)
      ? `Bu cihaz internet tarafında (${dev}) — paket kaydı yalnız ev ağındaki cihazlar içindir`
      : `Bu cihazın kartı (${dev}) kayda uygun değil`);
  }
  const iface = hit[1].dev;
  const ip4 = (ip && n4.get(ip)?.mac === m ? ip : '') || [...n4].find(([a, n]) => n.mac === m && n.dev === iface && IPV4_RE.test(a))?.[0] || '';
  if (ip4 && own.has(ip4)) throw new PcapError(409, PI_SELF);
  const label = (await deviceNames()).get(m) || ip4 || m;
  return { iface, kind: 'ether', addr: m, mac: m, ip: ip4, label };
}

// İndirilen dosyanın adı: klyrix-<ad>-<YYYYMMDD-HHMMSS>.pcap (yalnız güvenli karakterler; "Ayşe'nin" → "Ayse-nin").
function downloadName(j: Job): string {
  const slug = j.label.replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '').slice(0, 32)
    || j.addr.replace(/[^0-9a-f]/gi, '');
  const d = new Date(j.started * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `klyrix-${slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.pcap`;
}

const strictMac = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/.test(v)) return '';
  return v.toLowerCase().replace(/-/g, ':');
};

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export function registerPcapRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw; protectedMacs: ProtectedMacs }): void {
  app.use('/api/pcap', (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — paket kaydı ana cihazdadır' });
    deps.guard(req, res, next);
  });

  app.get('/api/pcap/status', async (_req, res) => {
    try {
      const auth = isLinux && panelAuthOn();
      let j = isLinux ? readState() : null;
      // Koruma kapandıysa bekleyen kayıt hemen silinir (kayıt yalnız korumalı panelde yaşar; başlatma sürüyorsa bitince).
      if (j && !auth) { await serial(purge); j = null; }
      const platform = isLinux ? await readPlatform() : null;
      res.json({
        supported: isLinux, panelAuth: auth, tcpdump: isLinux && tcpdumpInstalled(), profile: platform?.profile ?? null,
        maxBytes: capFor(platform), seconds: PCAP_SECONDS, keepSeconds: KEEP_S, now: nowS(), job: j ? await jobView(j) : null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Kaydı alınabilecek cihazlar (komşu tablosu + Ev VPN istemcileri); reddedilecekler (modem, Pi, internet tarafı) listede yok.
  app.get('/api/pcap/targets', async (_req, res) => {
    try {
      res.json({ targets: isLinux ? await listTargets(deps.protectedMacs) : [] });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/pcap/start', async (req, res) => {
    if (!isLinux) return res.status(400).json({ error: 'Paket kaydı yalnız Pi üzerinde çalışır' });
    if (!panelAuthOn()) return res.status(403).json({ error: AUTH_MSG });
    const b = req.body || {};
    if (typeof b.seconds !== 'number' || !PCAP_SECONDS.includes(b.seconds)) return res.status(400).json({ error: 'Süre 10, 30 ya da 60 sn olmalı' });
    if (b.mode !== 'headers' && b.mode !== 'full') return res.status(400).json({ error: "Kip 'headers' (yalnız başlıklar) ya da 'full' (tam paket) olmalı" });
    if (b.consent !== true) {
      return res.status(400).json({ error: 'Yasal uyarıyı okuyup onaylayın — başkasının trafiğini kaydetmek KVKK kapsamında hassastır' });
    }
    const hasMac = b.mac !== undefined && b.mac !== null && b.mac !== '';
    const hasIp = b.ip !== undefined && b.ip !== null && b.ip !== '';
    const mac = hasMac ? strictMac(b.mac) : '';
    if (hasMac && !mac) return res.status(400).json({ error: 'Geçersiz MAC adresi' });
    if (hasIp && (typeof b.ip !== 'string' || !IPV4_RE.test(b.ip))) return res.status(400).json({ error: 'Geçersiz IPv4 adresi' });
    const ip = hasIp ? String(b.ip) : '';
    if (!mac && !ip) return res.status(400).json({ error: 'Cihaz seçin (MAC ya da IP adresi)' });
    if (!tcpdumpInstalled()) return res.status(409).json({ error: 'tcpdump kurulu değil — panel güncellemesi kurar (Ayarlar → Güncelle)' });
    if (!fs.existsSync(SCRIPT)) return res.status(409).json({ error: 'scripts/pcap-run.sh bulunamadı — paneli güncelleyin' });
    if (launching) return res.status(409).json({ error: 'Bir paket kaydı başlatılıyor' });
    launching = true;
    try {
      await serial(async () => {
        // Başarısız kayıt yenisine yer açar; süren ya da indirilmeyi bekleyen kayıt açmaz.
        const prev = readState();
        if (prev) {
          if ((await jobView(prev)).state !== 'failed') {
            throw new PcapError(409, 'Bir paket kaydı zaten var (sürüyor ya da indirilmeyi bekliyor) — önce indirin ya da silin');
          }
          await purge();
        }
        const unit = await unitState();
        if (unit === 'unknown') throw new PcapError(409, 'Kayıt durumu okunamadı (systemctl) — birazdan yeniden deneyin');
        if (unit === 'active') throw new PcapError(409, 'Bir paket kaydı zaten sürüyor');
        const t = await resolveTarget(mac, ip, deps.protectedMacs);
        // Boyut tavanı /run'daki boş yere göre küçülür: dolu RAM diski kaydı (ve /run'a yazan her hizmeti) bozmasın.
        const room = runRoom() - RUN_RESERVE;
        if (room < RUN_MIN) throw new PcapError(409, 'RAM diski (/run) dolu — paket kaydı için yer yok');
        const job: Job = {
          ...t, id: crypto.randomBytes(16).toString('hex'), started: nowS(), seconds: b.seconds, mode: b.mode,
          maxBytes: Math.min(capFor(await readPlatform()), Math.floor(room)),
        };
        // Denetim izi kayıttan ÖNCE ve hatası yutulmadan (recordEvent ile aynı satır): yazılamazsa kayıt başlamaz.
        const audit = `Paket kaydı başlatıldı: ${job.label} (${job.mac || job.ip}, ${job.iface}), ${job.seconds} sn, `
          + `${modeText(job.mode)} — isteyen ${requester(req, res)}`;
        try {
          await dbRun('INSERT INTO alerts (type, severity, message, source, acknowledged) VALUES (?, ?, ?, ?, ?)',
            ['event', 'info', audit.slice(0, 500), 'pcap', 1]);
        } catch (e: any) {
          console.error('[paket kaydı] denetim kaydı yazılamadı:', e?.message || e);
          throw new PcapError(503, 'Denetim kaydı (Bildirimler) yazılamadı — paket kaydı başlatılmadı');
        }
        launchingId = job.id;
        try {
          fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
          fs.chmodSync(DIR, 0o700);
          writeState(job);
          // Önce silme zamanlayıcısı: kurulamazsa kayıt hiç başlamaz (10 dk sözü panel servisine bağlı kalmasın).
          await stopExpireTimer();
          await execFileP('systemd-run', [
            '--quiet', '--collect', `--unit=${EXPIRE_UNIT}`, `--on-active=${Math.max(1, job.started + KEEP_S - nowS())}`,
            '--timer-property=AccuracySec=1s', '--description=Klyrix Gate paket kaydı silme',
            '/bin/bash', SCRIPT, '--expire', job.id,
          ], { timeout: 15000 });
          await execFileP('systemd-run', [
            '--quiet', '--collect', `--unit=${UNIT}`, '--service-type=exec', '--description=Klyrix Gate paket kaydı',
            '-p', `RuntimeMaxSec=${RUNTIME_MAX_S}`, '-p', `MemoryMax=${memoryMax(job.maxBytes)}`, '-p', 'Nice=10',
            '/bin/bash', SCRIPT, job.iface, job.kind, job.addr, String(job.seconds), String(SNAPLEN[job.mode]), String(job.maxBytes), job.id,
          ], { timeout: 15000 });
        } catch (e: any) {
          await purge();
          const msg = String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'systemd-run hatası';
          await recordEvent('pcap', `Paket kaydı başlatılamadı: ${job.label} — ${msg}`);
          throw new PcapError(500, `Paket kaydı başlatılamadı: ${msg}`);
        }
        armExpiry(job);
        res.json({ success: true, job: await jobView(job) });
      });
    } catch (e: any) {
      if (e instanceof PcapError) return res.status(e.status).json({ error: e.message });
      res.status(500).json({ error: e?.message || String(e) });
    } finally {
      launching = false;
      launchingId = null;
    }
  });

  // İndirme: akış (nginx geçici dosyası SD karta yazılmasın: X-Accel-Buffering: no); tek indirme — aynı anda ikinci istek
  // 409, tamamı gönderilince dosya ve durum hemen (eşzamanlı) silinir, sonraki istek 404. Yarıda kalan indirme dosyayı
  // silmez (10 dk içinde yeniden denenebilir). HEAD yalnız başlıkları döner.
  app.get('/api/pcap/download/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!panelAuthOn()) {
      if (readState()) await serial(purge);
      return res.status(403).json({ error: AUTH_MSG });
    }
    const j = ID_RE.test(id) ? readState() : null;
    if (!j || j.id !== id) return res.status(404).json({ error: 'Kayıt bulunamadı — indirilmiş ya da süresi (10 dk) dolmuş olabilir' });
    const v = await jobView(j);
    if (v.state === 'running') return res.status(409).json({ error: 'Kayıt sürüyor — bitince indirin' });
    if (v.state === 'failed') return res.status(409).json({ error: v.error });
    const file = `${DIR}/${id}.pcap`;
    const size = fileSize(file);
    if (size === null) return res.status(404).json({ error: 'Kayıt bulunamadı — indirilmiş ya da süresi (10 dk) dolmuş olabilir' });
    // Buradan sona dek await yok: sahiplenme eşzamanlıdır, iki istekten yalnız biri akışı alır.
    if (req.method !== 'HEAD' && downloading === id) return res.status(409).json({ error: 'Kayıt şu an indiriliyor' });
    res.set({
      'Content-Type': 'application/vnd.tcpdump.pcap',
      'Content-Disposition': `attachment; filename="${downloadName(j)}"`,
      'Content-Length': String(size),
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') return res.end();
    downloading = id;
    const who = requester(req, res);
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => { if (downloading === id) downloading = null; });
    res.on('finish', () => {
      // Tamamı gönderildi: dosya ve durum hemen silinir (sonraki istek 404); birim / zamanlayıcı / dizin sırayla temizlenir.
      try { fs.rmSync(file, { force: true }); fs.rmSync(STATE, { force: true }); } catch { /* purge yine siler */ }
      void serial(async () => {
        const s = readState();
        if (!s || s.id === id) await purge();
      }).catch(() => undefined)
        .then(() => recordEvent('pcap', `Paket kaydı indirildi ve silindi: ${j.label} (${fmtBytes(size)}) — isteyen ${who}`));
    });
    stream.pipe(res);
  });

  // Silme / durdurma: süren kayıt durdurulup silinir; biten kayıt silinir. Başlatma sürüyorsa bitmesi beklenir.
  app.delete('/api/pcap/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) return res.status(404).json({ error: 'Kayıt bulunamadı' });
    try {
      await serial(async () => {
        const j = readState();
        if (!j || j.id !== id) throw new PcapError(404, 'Kayıt bulunamadı');
        const v = await jobView(j);
        await purge();
        await recordEvent('pcap', `Paket kaydı ${v.state === 'running' ? 'durduruldu ve silindi' : 'silindi'}: ${j.label} — isteyen ${requester(req, res)}`);
      });
      res.json({ success: true });
    } catch (e: any) {
      if (e instanceof PcapError) return res.status(e.status).json({ error: e.message });
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}

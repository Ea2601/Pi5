// Cihaz yedekleme (Syncthing): scripts/sync.sh'nin panel tarafı. Bilgisayar / telefon / tabletlerdeki Syncthing uygulaması
// seçilen klasörleri Pi'ye gönderir; Pi yalnız alır (receiveonly) ve değişen / silinen dosyaların eski sürümlerini N gün
// saklar (staggered sürümleme). Yedekler veri diskinin paylaşım bölümüne (/mnt/klyrix-share/Yedekler) ya da Depolama'da
// "Ağda paylaş" denen USB disklere (/mnt/klyrix-usb/<AD>/Klyrix-Yedekler) yazılır — SD karta asla (sync.sh başlığı).
//  - Syncthing REST API'si yalnız 127.0.0.1:8384; anahtar Syncthing'in kendi ayar dosyasında (config.xml, 0600) kalır.
//    app_settings'e (yedek dışa aktarımı, /api/settings) hiçbir şey yazılmaz.
//  - Yeni cihaz panelde onaylanmadan bağlanamaz (Syncthing'in karşılıklı TLS cihaz kimliği); cihazın paylaştığı klasör
//    panelde hedef disk seçilerek kabul edilir. Genel keşif, aktarıcılar, NAT/UPnP ve raporlar kapalı: sync.sh ilk açılıştan
//    önce yazar, enforceOptions açılışta ve arada bir denetler.
//  - Erişim: ev ağı + Ev VPN yöneticileri. Güvenlik duvarı: politikası drop olan giriş zincirlerine pi5_sync_in (share.ts
//    deseni, aynı jump yerleşimi); Ev VPN misafirleri wgServer.ts'teki pi5_wgsrv ile 22000/21027'den düşürülür; WAN'dan
//    pi5_wan düşürür. Güvenlik duvarı yeniden kurulunca Ev VPN'inin kural kancası (onWgRulesChanged) zinciri geri ekler.
//  - Disk çıkarılınca o diskteki klasörler duraklatılır (kendiliğinden duraklatılanlar listesi), takılınca sürdürülür;
//    kullanıcının elle duraklattığı klasöre dokunulmaz.
// Açma paket kurduğu için depolama işi olarak koşar (storage.ts, pi5-storage birimi, iş türü 'sync').
import fs from 'fs';
import dns from 'dns';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { isLinux, getLanIdentity } from './system';
import { recordEvent, recordEventOnce } from './events';
import { launchStorageJob, onStorageJobDone } from './storage';
import { onWgRulesChanged } from './wgServer';
import { registerHostsProvider } from './piholeLists';
import { shareJumpPlan } from './share';
import { isSatellite } from './role';

const execFileP = promisify(execFile);
const SCRIPT = path.resolve(__dirname, '../../scripts/sync.sh');
const CONF = process.env.PI5_SYNC_CONF || '/etc/pi5-gateway/sync.conf';
const ST_XML = process.env.PI5_SYNC_XML || '/var/lib/klyrix-sync/config/config.xml';
const AUTOPAUSE_FILE = process.env.PI5_SYNC_AUTOPAUSE || '/etc/pi5-gateway/sync.autopaused';
const API = 'http://127.0.0.1:8384';
const FSTAB = '/etc/fstab';
const USB_MARK = '# klyrix-usb';
const SHARE_MNT = '/mnt/klyrix-share';
const INTERNAL_ROOT = `${SHARE_MNT}/Yedekler`;
const USB_MNT = '/mnt/klyrix-usb';
const USB_DIR = 'Klyrix-Yedekler';
export const SYNC_PORT = 22000;
// Sabit ad (Pi-hole yerel DNS): cihazlarda Pi'nin adresi tcp://yedek.lan:22000 — Pi'nin adresi değişse de aynı kalır
export const SYNC_DNS_NAME = 'yedek.lan';
const PRIVATE = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16';
// Syncthing TCP + QUIC 22000, yerel keşif UDP 21027. VPS tünelleri (wg_vps*) ev ağı değildir.
const FW_RULES = [
  'iifname "wg_vps*" return',
  `ip saddr { ${PRIVATE} } tcp dport ${SYNC_PORT} accept`,
  `ip saddr { ${PRIVATE} } udp dport { ${SYNC_PORT}, 21027 } accept`,
];
const FW_TABLES = ['filter', 'pi5_filter'];
const FW_CHAIN = 'pi5_sync_in';
const DEVICE_ID = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;
const DAYS_MIN = 1;
const DAYS_MAX = 365;
export const DEFAULT_DAYS = 30;
// Gizlilik ve ağ: Pi yalnız ev ağında / Ev VPN'inde doğrudan bağlantı kabul eder
const WANT_OPTIONS = {
  globalAnnounceEnabled: false, relaysEnabled: false, natEnabled: false, urAccepted: -1, crashReportingEnabled: false,
  autoUpgradeIntervalH: 0, startBrowser: false, localAnnounceEnabled: true,
  listenAddresses: [`tcp://0.0.0.0:${SYNC_PORT}`, `quic://0.0.0.0:${SYNC_PORT}`],
} as const;

export interface SyncTarget {
  key: string; kind: 'internal' | 'usb'; name: string; mounted: boolean; fstype: string; free: number | null; size: number | null;
}
export interface SyncDevice {
  id: string; name: string; connected: boolean; address: string; clientVersion: string; lastSeen: string | null; paused: boolean;
}
export interface SyncFolder {
  id: string; label: string; deviceId: string; deviceName: string; path: string; target: string; targetMounted: boolean;
  state: string; error: string; paused: boolean; autoPaused: boolean; days: number;
  globalBytes: number; localBytes: number; needBytes: number; localFiles: number; changedLocally: number;
}
export interface SyncPendingDevice { id: string; name: string; address: string; time: string }
export interface SyncPendingFolder { id: string; label: string; deviceId: string; deviceName: string; time: string }
export interface SyncStatus {
  supported: boolean; installed: boolean; enabled: boolean; active: boolean; version: string; apiOk: boolean; apiError: string;
  deviceId: string; qr: string; name: string; nameOk: boolean; ip: string; port: number;
  devices: SyncDevice[]; folders: SyncFolder[]; pendingDevices: SyncPendingDevice[]; pendingFolders: SyncPendingFolder[];
  targets: SyncTarget[];
}

// ── sync.sh ──────────────────────────────────────────────────────────────────
// Çıktı KEY=VALUE satırları; betik hata verirse (error=...) fırlatır.
async function run(args: string[], timeout = 60000): Promise<Record<string, string>> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('/bin/bash', [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('cihaz yedekleme komutu zaman aşımına uğradı')); }, timeout);
    p.stdout.on('data', d => { so += d; });
    p.stderr.on('data', d => { se += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      const err = /^error=(.*)$/m.exec(so)?.[1];
      if (err) reject(new Error(err));
      else if (code !== 0) reject(new Error(se.trim().split('\n').pop() || `sync.sh çıkış kodu ${code}`));
      else resolve(so);
    });
  });
  const kv: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

function confEnabled(): boolean {
  let txt = '';
  try { txt = fs.readFileSync(CONF, 'utf8'); } catch { return false; }
  const vals = txt.split('\n').filter(l => l.startsWith('enabled=')).map(l => l.slice('enabled='.length).trim());
  return vals.pop() === '1'; // sync.sh conf_get gibi son satır geçerli
}

// ── Syncthing REST API ───────────────────────────────────────────────────────
let keyCache: { mtime: number; key: string } | null = null;
function apiKey(): string {
  let st: fs.Stats;
  try { st = fs.statSync(ST_XML); } catch { throw new Error('Syncthing ayarı bulunamadı — cihaz yedeklemeyi yeniden açın'); }
  if (keyCache && keyCache.mtime === st.mtimeMs) return keyCache.key;
  const key = /<apikey>([^<]+)<\/apikey>/.exec(fs.readFileSync(ST_XML, 'utf8'))?.[1]?.trim();
  if (!key) throw new Error('Syncthing API anahtarı okunamadı');
  keyCache = { mtime: st.mtimeMs, key };
  return key;
}

async function api<T>(method: string, p: string, body?: unknown, timeoutMs = 10000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${p}`, {
      method,
      headers: { 'X-API-Key': apiKey(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    if (/API anahtarı|ayarı bulunamadı/.test(String(e?.message))) throw e;
    throw new Error('Syncthing yanıt vermiyor (hizmet çalışıyor mu?)');
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`Syncthing: ${text.trim().slice(0, 200) || `HTTP ${r.status}`}`);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}
const enc = encodeURIComponent;

interface StDevice { deviceID: string; name: string; paused?: boolean; addresses?: string[] }
interface StFolder {
  id: string; label: string; path: string; type: string; paused: boolean; devices: { deviceID: string }[];
  versioning?: { type: string; params?: Record<string, string> };
}
interface StConfig { devices: StDevice[]; folders: StFolder[] }
interface StDbStatus {
  state?: string; error?: string; globalBytes?: number; localBytes?: number; needBytes?: number; localFiles?: number;
  receiveOnlyChangedFiles?: number;
}
type StPendingDevices = Record<string, { time: string; name: string; address: string }>;
type StPendingFolders = Record<string, { offeredBy: Record<string, { time: string; label: string }> }>;

let myIdCache = '';
async function myId(): Promise<string> {
  if (!myIdCache) myIdCache = (await api<{ myID: string }>('GET', '/rest/system/status')).myID || '';
  return myIdCache;
}

// Gizlilik seçenekleri (sync.sh'nin ilk açılıştan önce yazdıklarının aynısı): biri değiştiyse geri alınır.
export async function enforceOptions(): Promise<boolean> {
  const cur = await api<Record<string, unknown>>('GET', '/rest/config/options');
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(WANT_OPTIONS)) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(v)) patch[k] = v;
  }
  if (!Object.keys(patch).length) return false;
  await api('PATCH', '/rest/config/options', patch);
  console.warn('[cihaz-yedekleme] Syncthing seçenekleri düzeltildi:', Object.keys(patch).join(', '));
  return true;
}

// ── hedefler (disk) ──────────────────────────────────────────────────────────
function mountTable(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [, mp, fst] = line.split(' ');
      if (mp) m.set(mp.replace(/\\040/g, ' '), fst || '');
    }
  } catch { /* okunamadı: hiçbiri bağlı değil sayılır */ }
  return m;
}
function usbNames(): string[] {
  let fstab = '';
  try { fstab = fs.readFileSync(FSTAB, 'utf8'); } catch { return []; }
  const out: string[] = [];
  for (const line of fstab.split('\n')) {
    if (!line.includes(USB_MARK)) continue;
    const mp = line.split(/\s+/)[1] || '';
    if (mp.startsWith(`${USB_MNT}/`)) out.push(mp.slice(USB_MNT.length + 1));
  }
  return out;
}
function space(p: string): { free: number | null; size: number | null } {
  try {
    const s = fs.statfsSync(p);
    return { free: s.bavail * s.bsize, size: s.blocks * s.bsize };
  } catch {
    return { free: null, size: null };
  }
}
export function listTargets(mounts = mountTable()): SyncTarget[] {
  const out: SyncTarget[] = [];
  const im = mounts.has(SHARE_MNT);
  out.push({ key: 'internal', kind: 'internal', name: 'Dahili disk', mounted: im, fstype: mounts.get(SHARE_MNT) || '', ...(im ? space(SHARE_MNT) : { free: null, size: null }) });
  for (const n of usbNames()) {
    const mp = `${USB_MNT}/${n}`;
    const m = mounts.has(mp);
    out.push({ key: `usb:${n}`, kind: 'usb', name: n, mounted: m, fstype: mounts.get(mp) || '', ...(m ? space(mp) : { free: null, size: null }) });
  }
  return out;
}
// Klasör yolunun hedefi (yalnız bizim yerleşimimiz; başka bir yol "bilinmiyor" — duraklatma ona dokunmaz)
export function targetOf(p: string): { key: string; mountpoint: string } | null {
  if (p === INTERNAL_ROOT || p.startsWith(`${INTERNAL_ROOT}/`)) return { key: 'internal', mountpoint: SHARE_MNT };
  const m = new RegExp(`^${USB_MNT}/([A-Za-z0-9_-]{1,40})/${USB_DIR}(/|$)`).exec(p);
  return m ? { key: `usb:${m[1]}`, mountpoint: `${USB_MNT}/${m[1]}` } : null;
}

// Klasör adı: cihaz adı ve klasör etiketi diskte dizin olur. Türkçe harfler kalır; Windows / FAT'ın yasakladıkları,
// denetim karakterleri, baştaki / sondaki nokta ve boşluklar atılır.
export function safeName(s: string, fallback: string): string {
  const t = String(s || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 60).replace(/[\s.]+$/g, '');
  return t || fallback;
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
// Yeni klasörün yolu: <hedef kökü>/<cihaz>/<klasör>; başka bir klasörle çakışırsa klasöre -2, -3 ... (kullanılan bir yol
// cihaz dizinini kapsıyorsa klasör eki çözmez: cihaz dizinine ek).
export function folderPath(root: string, device: string, label: string, used: string[]): string {
  const dev = safeName(device, 'Cihaz');
  const leaf = safeName(label, 'Klasor');
  const free = (p: string) => !used.some(u => overlaps(u, p));
  for (let i = 1; i < 100; i++) {
    const p = path.posix.join(root, dev, i > 1 ? `${leaf}-${i}` : leaf);
    if (free(p)) return p;
  }
  for (let i = 2; i < 100; i++) {
    const p = path.posix.join(root, `${dev}-${i}`, leaf);
    if (free(p)) return p;
  }
  throw new Error('Hedef klasör başka bir yedek klasörüyle çakışıyor');
}
export function checkDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < DAYS_MIN || n > DAYS_MAX) throw new Error(`Eski sürüm saklama süresi ${DAYS_MIN}-${DAYS_MAX} gün olmalı`);
  return n;
}
const daysOf = (f: StFolder) => {
  const s = Number(f.versioning?.params?.maxAge || 0);
  return f.versioning?.type === 'staggered' && s > 0 ? Math.round(s / 86400) : 0;
};
const versioning = (days: number) => ({ type: 'staggered', params: { maxAge: String(days * 86400), cleanInterval: '3600' } });

// ── kendiliğinden duraklatılan klasörler (disk çıkarıldı) ────────────────────
function readAutoPaused(): Set<string> {
  try { return new Set(fs.readFileSync(AUTOPAUSE_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)); } catch { return new Set(); }
}
function writeAutoPaused(s: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(AUTOPAUSE_FILE), { recursive: true });
    const tmp = `${AUTOPAUSE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, [...s].join('\n') + (s.size ? '\n' : ''));
    fs.renameSync(tmp, AUTOPAUSE_FILE);
  } catch (e: any) {
    console.error('[cihaz-yedekleme] duraklatma listesi yazılamadı:', e?.message || e);
  }
}

// ── sabit ad: Pi-hole yerel DNS kaydı ───────────────────────────────────────
async function syncHosts(): Promise<string[]> {
  if (!confEnabled()) return [];
  const lan = await getLanIdentity().catch(() => null);
  if (!lan) throw new Error('Pi\'nin ev ağı adresi okunamadı'); // geçici: önceki kayıt kalır
  return [...new Set([lan.ip, lan.transit.ip].filter(Boolean))].map(ip => `${ip} ${SYNC_DNS_NAME}`);
}
async function nameResolves(): Promise<boolean> {
  const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
  r.setServers(['127.0.0.1']);
  try { return (await r.resolve4(SYNC_DNS_NAME)).length > 0; } catch { return false; }
}

// Cihaz kimliği QR kodu (Syncthing uygulamaları "QR kodu tara" ile okur): qrencode, sync.sh enable kurar
let qrCache: { id: string; data: string } | null = null;
async function deviceQr(id: string): Promise<string> {
  if (qrCache?.id === id) return qrCache.data;
  const png = await new Promise<Buffer>((resolve, reject) => {
    const p = spawn('qrencode', ['-t', 'PNG', '-s', '6', '-m', '2', '-o', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('qrencode zaman aşımı')); }, 5000);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', c => { clearTimeout(t); if (c === 0) resolve(Buffer.concat(out)); else reject(new Error(`qrencode ${c}`)); });
    p.stdin.end(id);
  });
  qrCache = { id, data: `data:image/png;base64,${png.toString('base64')}` };
  return qrCache.data;
}

// ── durum ────────────────────────────────────────────────────────────────────
let cache: { at: number; data: SyncStatus } | null = null;
export async function syncStatus(fresh = false): Promise<SyncStatus> {
  const empty: SyncStatus = {
    supported: false, installed: false, enabled: false, active: false, version: '', apiOk: false, apiError: '', deviceId: '', qr: '',
    name: SYNC_DNS_NAME, nameOk: false, ip: '', port: SYNC_PORT, devices: [], folders: [], pendingDevices: [], pendingFolders: [], targets: [],
  };
  if (!isLinux || !fs.existsSync(SCRIPT)) return empty;
  if (!fresh && cache && Date.now() - cache.at < 3000) return cache.data;
  const kv = await run(['status'], 15000);
  const mounts = mountTable();
  const data: SyncStatus = {
    ...empty, supported: true, installed: kv.installed === '1', enabled: kv.enabled === '1', active: kv.active === '1',
    version: kv.version || '', targets: listTargets(mounts), ip: (await getLanIdentity().catch(() => null))?.ip || '',
  };
  if (data.enabled && data.active) {
    try {
      const [cfg, pd, pf, conns, stats] = await Promise.all([
        api<StConfig>('GET', '/rest/config'),
        api<StPendingDevices>('GET', '/rest/cluster/pending/devices'),
        api<StPendingFolders>('GET', '/rest/cluster/pending/folders'),
        api<{ connections: Record<string, { connected: boolean; address: string; clientVersion: string; paused: boolean }> }>('GET', '/rest/system/connections'),
        api<Record<string, { lastSeen: string }>>('GET', '/rest/stats/device'),
      ]);
      data.deviceId = await myId();
      data.qr = await deviceQr(data.deviceId).catch(() => '');
      const devs = cfg.devices.filter(d => d.deviceID !== data.deviceId);
      const nameOf = (id: string) => devs.find(d => d.deviceID === id)?.name || id.slice(0, 7);
      // Syncthing hiç görmediği tarihi 1970 yazar
      const seen = (t?: string) => (t && !t.startsWith('1970') ? t : null);
      data.devices = devs.map(d => {
        const c = conns.connections?.[d.deviceID];
        return {
          id: d.deviceID, name: d.name || d.deviceID.slice(0, 7), connected: !!c?.connected, address: c?.connected ? c.address : '',
          clientVersion: c?.clientVersion || '', lastSeen: seen(stats[d.deviceID]?.lastSeen), paused: !!d.paused,
        };
      });
      const auto = readAutoPaused();
      const dbs = await Promise.all(cfg.folders.map(f => api<StDbStatus>('GET', `/rest/db/status?folder=${enc(f.id)}`).catch(() => ({} as StDbStatus))));
      data.folders = cfg.folders.map((f, i) => {
        const db = dbs[i];
        const owner = f.devices.find(d => d.deviceID !== data.deviceId)?.deviceID || '';
        const t = targetOf(f.path);
        return {
          id: f.id, label: f.label || f.id, deviceId: owner, deviceName: owner ? nameOf(owner) : '', path: f.path,
          target: t?.key || '', targetMounted: t ? mounts.has(t.mountpoint) : true, state: f.paused ? 'paused' : db.state || '',
          error: db.error || '', paused: f.paused, autoPaused: f.paused && auto.has(f.id), days: daysOf(f),
          globalBytes: db.globalBytes || 0, localBytes: db.localBytes || 0, needBytes: db.needBytes || 0, localFiles: db.localFiles || 0,
          changedLocally: db.receiveOnlyChangedFiles || 0,
        };
      });
      data.pendingDevices = Object.entries(pd || {}).map(([id, v]) => ({ id, name: v.name || '', address: v.address || '', time: v.time || '' }));
      const configured = new Set(cfg.folders.map(f => f.id));
      data.pendingFolders = Object.entries(pf || {}).flatMap(([id, v]) => Object.entries(v.offeredBy || {})
        .filter(([dev]) => devs.some(d => d.deviceID === dev) && !configured.has(id))
        .map(([dev, o]) => ({ id, label: o.label || '', deviceId: dev, deviceName: nameOf(dev), time: o.time || '' })));
      data.apiOk = true;
    } catch (e: any) {
      data.apiError = e?.message || String(e);
    }
    data.nameOk = await nameResolves();
  }
  cache = { at: Date.now(), data };
  return data;
}

// ── erişim: güvenlik duvarı zinciri ─────────────────────────────────────────
async function nft(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('nft', ['-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let se = '';
    p.stderr.on('data', d => { se += d; });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error(se.trim() || `nft çıkış ${c}`))));
    p.stdin.end(script);
  });
}

// Politikası drop olan giriş zincirlerine izin zinciri (share.ts syncShareFirewall ile aynı yerleşim): açıksa ekle / tazele
// (yanlış yerdeki jump taşınır), kapalıysa kaldır. Tablo yoksa dokunulmaz.
export async function syncSyncFirewall(enable: boolean): Promise<void> {
  for (const table of FW_TABLES) {
    const listing = await execFileP('nft', ['-a', 'list', 'chain', 'inet', table, 'input'], { timeout: 5000 }).then(r => r.stdout, () => null);
    if (listing === null) continue;
    const policyDrop = /policy drop;/.test(listing);
    const plan = shareJumpPlan(listing, FW_CHAIN);
    const exists = await execFileP('nft', ['list', 'chain', 'inet', table, FW_CHAIN], { timeout: 5000 }).then(() => true, () => false);
    let script = '';
    if (enable && policyDrop) {
      script += `add chain inet ${table} ${FW_CHAIN}\nflush chain inet ${table} ${FW_CHAIN}\n`;
      for (const r of FW_RULES) script += `add rule inet ${table} ${FW_CHAIN} ${r}\n`;
      if (plan.jump && plan.misplaced) script += `delete rule inet ${table} input handle ${plan.jump}\n`;
      if (!plan.jump || plan.misplaced) {
        script += plan.terminal
          ? `insert rule inet ${table} input position ${plan.terminal} jump ${FW_CHAIN}\n`
          : `add rule inet ${table} input jump ${FW_CHAIN}\n`;
      }
    } else {
      if (plan.jump) script += `delete rule inet ${table} input handle ${plan.jump}\n`;
      if (exists) script += `delete chain inet ${table} ${FW_CHAIN}\n`;
    }
    if (script) await nft(script);
  }
}

let accessRun: Promise<void> | null = null;
export function applySyncAccess(): Promise<void> {
  if (accessRun) return accessRun.then(() => applySyncAccess());
  accessRun = (async () => {
    if (!isLinux || !fs.existsSync(SCRIPT)) return;
    await syncSyncFirewall(confEnabled());
  })().finally(() => { accessRun = null; });
  return accessRun;
}

// ── işlemler ─────────────────────────────────────────────────────────────────
function needActive(): void {
  if (!isLinux) throw new Error('Cihaz yedekleme yalnız Pi üzerinde çalışır');
  if (!confEnabled()) throw new Error('Önce cihaz yedeklemeyi açın');
}
function checkDeviceId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!DEVICE_ID.test(id)) throw new Error('Geçersiz cihaz kimliği');
  return id;
}
function checkName(raw: unknown): string {
  const n = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!n || n.length > 40) throw new Error('Cihaz adı 1-40 karakter olmalı');
  return n;
}
function checkFolderId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw : '';
  if (!id || id.length > 100 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('Geçersiz klasör kimliği');
  return id;
}
const done = <T>(x: T) => { cache = null; return x; };

export async function enableSync(): Promise<{ id: string }> {
  if (!isLinux) throw new Error('Cihaz yedekleme yalnız Pi üzerinde çalışır');
  return launchStorageJob('sync', [], 'Cihaz yedekleme açılıyor', SCRIPT, 'enable');
}

export async function disableSync(): Promise<void> {
  await run(['disable'], 60000);
  myIdCache = '';
  await syncSyncFirewall(false).catch(() => {});
  await recordEvent('sync', 'Cihaz yedekleme kapatıldı (yedekler ve eşleşmeler kaldı)');
  done(null);
}

export async function acceptDevice(body: { id?: unknown; name?: unknown }): Promise<void> {
  needActive();
  const id = checkDeviceId(body.id);
  const name = checkName(body.name);
  const pd = await api<StPendingDevices>('GET', '/rest/cluster/pending/devices');
  if (!pd[id]) throw new Error('Bu cihaz bekleyenler arasında yok — cihazdan yeniden bağlanmayı deneyin');
  await api('PUT', `/rest/config/devices/${enc(id)}`, {
    deviceID: id, name, addresses: ['dynamic'], compression: 'metadata', introducer: false, autoAcceptFolders: false, paused: false,
  });
  await recordEvent('sync', `Cihaz yedeklemeye eklendi: ${name}`);
  done(null);
}

export async function rejectDevice(raw: unknown): Promise<void> {
  needActive();
  const id = checkDeviceId(raw);
  await api('DELETE', `/rest/cluster/pending/devices?device=${enc(id)}`);
  done(null);
}

// Cihazı kaldırır: klasörleri Syncthing ayarından çıkar (diskteki yedekler kalır), sonra cihazı siler.
export async function removeDevice(raw: unknown): Promise<{ folders: number }> {
  needActive();
  const id = checkDeviceId(raw);
  const cfg = await api<StConfig>('GET', '/rest/config');
  const dev = cfg.devices.find(d => d.deviceID === id);
  if (!dev) throw new Error('Cihaz bulunamadı');
  if (id === await myId()) throw new Error('Pi\'nin kendisi kaldırılamaz');
  const owned = cfg.folders.filter(f => f.devices.some(d => d.deviceID === id));
  const auto = readAutoPaused();
  for (const f of owned) {
    await api('DELETE', `/rest/config/folders/${enc(f.id)}`);
    auto.delete(f.id);
  }
  writeAutoPaused(auto);
  await api('DELETE', `/rest/config/devices/${enc(id)}`);
  await recordEvent('sync', `Cihaz yedeklemeden kaldırıldı: ${dev.name || id.slice(0, 7)}${owned.length ? ` (${owned.length} klasör; diskteki yedekler kaldı)` : ''}`);
  return done({ folders: owned.length });
}

export async function acceptFolder(body: { deviceId?: unknown; folderId?: unknown; target?: unknown; days?: unknown }): Promise<{ path: string }> {
  needActive();
  const deviceId = checkDeviceId(body.deviceId);
  const folderId = checkFolderId(body.folderId);
  const days = body.days === undefined ? DEFAULT_DAYS : checkDays(body.days);
  const target = typeof body.target === 'string' ? body.target : '';
  let args: string[];
  if (target === 'internal') args = ['target', '--internal'];
  else if (/^usb:[A-Za-z0-9_-]{1,40}$/.test(target)) args = ['target', '--usb', target.slice(4)];
  else throw new Error('Hedef disk seçin');
  const [cfg, pf] = await Promise.all([
    api<StConfig>('GET', '/rest/config'), api<StPendingFolders>('GET', '/rest/cluster/pending/folders'),
  ]);
  const dev = cfg.devices.find(d => d.deviceID === deviceId);
  if (!dev) throw new Error('Önce cihazı onaylayın');
  const offer = pf[folderId]?.offeredBy?.[deviceId];
  if (!offer) throw new Error('Bu klasör bekleyenler arasında yok — cihazda paylaşımı yeniden deneyin');
  if (cfg.folders.some(f => f.id === folderId)) throw new Error('Bu klasör zaten yedekleniyor');
  const root = (await run(args, 30000)).path;
  if (!root || !targetOf(path.posix.join(root, 'x'))) throw new Error('Hedef klasör hazırlanamadı');
  const p = folderPath(root, dev.name || deviceId.slice(0, 7), offer.label || folderId, cfg.folders.map(f => f.path));
  const label = `${dev.name || deviceId.slice(0, 7)} · ${offer.label || folderId}`;
  await api('PUT', `/rest/config/folders/${enc(folderId)}`, {
    id: folderId, label, path: p, type: 'receiveonly', devices: [{ deviceID: deviceId }],
    // FAT / exFAT / NTFS izin tutmaz; telefon ve Windows dosyalarında izin önemsiz
    ignorePerms: true, fsWatcherEnabled: true, rescanIntervalS: 3600, minDiskFree: { value: 5, unit: '%' },
    versioning: versioning(days), paused: false,
  });
  await recordEvent('sync', `Yedeklenen klasör eklendi: ${label} → ${p}`);
  return done({ path: p });
}

export async function rejectFolder(body: { deviceId?: unknown; folderId?: unknown }): Promise<void> {
  needActive();
  const deviceId = checkDeviceId(body.deviceId);
  const folderId = checkFolderId(body.folderId);
  await api('DELETE', `/rest/cluster/pending/folders?folder=${enc(folderId)}&device=${enc(deviceId)}`);
  done(null);
}

export async function removeFolder(raw: unknown): Promise<{ path: string }> {
  needActive();
  const id = checkFolderId(raw);
  const f = await api<StFolder>('GET', `/rest/config/folders/${enc(id)}`).catch(() => null);
  if (!f?.id) throw new Error('Klasör bulunamadı');
  await api('DELETE', `/rest/config/folders/${enc(id)}`);
  const auto = readAutoPaused();
  if (auto.delete(id)) writeAutoPaused(auto);
  await recordEvent('sync', `Yedeklenen klasör kaldırıldı: ${f.label || id} (diskteki yedekler kaldı: ${f.path})`);
  return done({ path: f.path });
}

export async function updateFolder(body: { id?: unknown; days?: unknown; paused?: unknown }): Promise<void> {
  needActive();
  const id = checkFolderId(body.id);
  const patch: Record<string, unknown> = {};
  if (body.days !== undefined) patch.versioning = versioning(checkDays(body.days));
  if (body.paused !== undefined) {
    if (typeof body.paused !== 'boolean') throw new Error('Geçersiz duraklatma değeri');
    if (!body.paused) {
      const f = await api<StFolder>('GET', `/rest/config/folders/${enc(id)}`);
      const t = targetOf(f.path);
      if (t && !mountTable().has(t.mountpoint)) throw new Error('Bu klasörün diski takılı değil — takınca kendiliğinden sürer');
    }
    patch.paused = body.paused;
  }
  if (!Object.keys(patch).length) throw new Error('Değişiklik yok');
  await api('PATCH', `/rest/config/folders/${enc(id)}`, patch);
  // Elle duraklatma / sürdürme: kendiliğinden duraklatılanlar listesinden çıkar (disk takılınca kendiliğinden sürmesin)
  if (body.paused !== undefined) {
    const auto = readAutoPaused();
    if (auto.delete(id)) writeAutoPaused(auto);
  }
  done(null);
}

// Uyduya geçişi engeller: cihaz yedekleme ana cihazdadır
export function syncBlocksSatellite(): string | null {
  return confEnabled() ? 'Cihaz yedekleme açık — önce kapatın (Yedekleme → Cihaz Yedekleme)' : null;
}

// ── izleme ───────────────────────────────────────────────────────────────────
// Dakikada bir: diski takılı olmayan klasörleri duraklatır (Syncthing hata durumunda kalmasın, yeniden deneme günlüğü
// dolmasın), disk geri gelince yalnız kendi duraklattıklarını sürdürür. Hata veren klasör için günde bir bildirim.
// Dışa açık: testler turu doğrudan çalıştırır.
let ticking = false;
let tickNo = 0;
export async function watchTick(): Promise<void> {
  if (ticking || !confEnabled()) return;
  ticking = true;
  try {
    if (tickNo++ % 10 === 0) await enforceOptions();
    const folders = await api<StFolder[]>('GET', '/rest/config/folders');
    const mounts = mountTable();
    const auto = readAutoPaused();
    let changed = false;
    for (const f of folders) {
      const t = targetOf(f.path);
      if (!t) continue;
      const mounted = mounts.has(t.mountpoint);
      if (!mounted && !f.paused) {
        await api('PATCH', `/rest/config/folders/${enc(f.id)}`, { paused: true });
        auto.add(f.id); changed = true;
        await recordEventOnce('sync', `Yedek diski takılı değil — «${f.label || f.id}» duraklatıldı; disk takılınca kendiliğinden sürer`, 'warning', 720);
      } else if (mounted && f.paused && auto.has(f.id)) {
        await api('PATCH', `/rest/config/folders/${enc(f.id)}`, { paused: false });
        auto.delete(f.id); changed = true;
        await recordEvent('sync', `Yedek diski geri geldi — «${f.label || f.id}» sürdürüldü`);
      } else if (mounted && !f.paused) {
        const db = await api<StDbStatus>('GET', `/rest/db/status?folder=${enc(f.id)}`).catch(() => null);
        if (db?.state === 'error' && db.error) await recordEventOnce('sync', `Cihaz yedekleme «${f.label || f.id}»: ${db.error}`, 'warning', 1440);
      }
    }
    // Ayardan silinmiş klasörler listeden düşer
    for (const id of [...auto]) if (!folders.some(f => f.id === id)) { auto.delete(id); changed = true; }
    if (changed) { writeAutoPaused(auto); cache = null; }
  } catch {
    /* hizmet kapalı / yeniden başlıyor: sonraki turda */
  } finally {
    ticking = false;
  }
}

async function afterEnable(): Promise<void> {
  myIdCache = '';
  await applySyncAccess().catch(e => console.error('[cihaz-yedekleme] güvenlik duvarı:', e?.message || e));
  await enforceOptions().catch(() => {});
  cache = null;
}

export function startSyncWatch(): void {
  if (!isLinux || isSatellite()) return;
  registerHostsProvider(syncHosts);
  onWgRulesChanged(() => applySyncAccess());
  onStorageJobDone(j => {
    if (j.state !== 'done') return;
    if (j.cmd === 'sync') { void afterEnable(); return; }
    // Paylaşım açıldı (USB disk grubu) ya da veri diski hazırlandı / veriler taşındı (dizin veritabanının yeri): birim yeniden
    if ((j.cmd === 'share' || j.cmd === 'prepare' || j.cmd === 'migrate') && confEnabled()) {
      run(['ensure'], 90000).then(() => { cache = null; }).catch(e => console.error('[cihaz-yedekleme] ensure:', e?.message || e));
    }
  });
  setInterval(() => { void watchTick(); }, 60000);
}

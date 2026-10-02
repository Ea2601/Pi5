// Mobil yedekleme (C3): Klyrix/Gate Sync uygulaması (iOS / Android, mobile/ klasörü) ile Pi arasındaki HTTP ucu.
//  - v2 (mobileStore.ts): kişi profilleri, uçtan uca şifreli nesneler ve anlık görüntüler (yedekler: liste, çöp, geri
//    yükleme). Pi'nin özel alanına yazılır (paylaşımların dışında); Cihaz Yedekleme'ye (Syncthing) gerek yoktur.
//  - v1 (uygulamanın eski sürümü, şifresiz): fotoğraf ve videoları Cihaz Yedekleme'nin (sync.ts) Yedekler klasörüne yükler
//    ve onun açık olmasını ister: aynı hedef diskler (sync.sh target — bağlama noktası denetimi, SD karta asla), aynı
//    sahiplik (klyrix-sync, 2750), salt okunur Yedekler paylaşımı ve Bulut Yedeği. Klasör düzeni:
//    <kök>/<cihaz>/Kamera/<yıl>/<ay>/<dosya>. Yeni sürüm yayılana dek kalır; panel bu cihazları "eski sürüm" diye gösterir.
//  - Ayrı HTTP dinleyicisi (MOBILE_PORT), yalnız açıkken. Güvenlik duvarı: politikası drop olan giriş zincirlerine
//    pi5_mobile_in (sync.ts / share.ts deseni, aynı jump yerleşimi) — ev ağı + Ev VPN yöneticileri; VPS tünelleri değil.
//    Ev VPN misafirleri wgServer.ts izin listesinde (yalnız DNS) zaten düşer. Dinleyici ayrıca özel olmayan adresi reddeder.
//  - Eşleştirme: panel bir kişi (yeni ya da var olan) için tek kullanımlık kod üretir (10 dk; QR'da Pi'nin adresleriyle);
//    uygulama kodu cihaz anahtarına çevirir. Veritabanında anahtarın yalnız SHA-256'sı. Cihaz kaldırılınca anahtar geçersiz.
//  - v1 uç YALNIZ YÜKLER: dosya içeriği okunamaz, silinemez, üzerine yazılamaz (aynı ad → yeni ad). Anahtar ele geçse bile
//    yedekler okunamaz; yalnız o cihazın klasörüne yeni dosya eklenebilir. HTTP (ev ağı), panelin kendisi gibi.
//  - Yükleme sürdürülebilir: parça parça (offset) ya da tek istekte bütün dosya (iOS arka plan yüklemesi); gövde akışla
//    diske yazılır (bellekte tutulmaz). Yarım dosya <cihaz>/.klyrix-part'ta bekler, tamamlanınca yerine taşınır.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux, getLanIdentity } from './system';
import { recordEvent, recordEventOnce } from './events';
import { onWgRulesChanged, WG_IFACE, WG_SERVER_IP } from './wgServer';
import { shareJumpPlan, onUsbRemove } from './share';
import { syncEnabled, prepareTargetRoot, listTargets, backupRoots, safeName, qrDataUrl, SYNC_DNS_NAME } from './sync';
import { isSatellite } from './role';
import {
  ensureStoreTables, getProfile, profileOut, setKeyCheck, checkObjects, objectState, putObject, sendObject, listSnapshots,
  createSnapshot, trashSnapshot, untrashSnapshot, usage, storeGc, abortStore, listProfiles, removeProfile, createProfile,
  checkNewPerson, targetProblem, prepareStoreRoot, storeProblem, type ProfileSummary,
} from './mobileStore';

const execFileP = promisify(execFile);

export const MOBILE_PORT = 8095;
const SETTINGS_KEY = 'mobile_backup';
const FW_CHAIN = 'pi5_mobile_in';
const FW_TABLES = ['filter', 'pi5_filter'];
const PRIVATE = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16';
const FW_RULES = ['iifname "wg_vps*" return', `ip saddr { ${PRIVATE} } tcp dport ${MOBILE_PORT} accept`];
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_FAILS = 10;
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // karışmayan harf / rakamlar (0/O, 1/I/L yok)
export const MAX_FILE = 64 * 2 ** 30;                 // tek dosya en çok 64 GB
const MAX_CHECK = 1000;
const KEY_RE = /^[A-Za-z0-9._:/-]{1,200}$/;          // uygulamanın verdiği dosya anahtarı (ör. iOS varlık kimliği + tarih)
const PART_DIR = '.klyrix-part';
const MEDIA_DIR = 'Kamera';
const RESERVE = 2 ** 30;                              // hedefte en az 1 GB (küçük diskte %5) boş kalsın
const SYNC_USER = 'klyrix-sync';

export interface MobileConf { enabled: boolean; target: string }
export interface MobileDevice { id: number; name: string; platform: string; created_at: string; last_seen: string; files: number; bytes: number }
export interface MobileStatus {
  supported: boolean;                 // Pi üzerinde
  enabled: boolean;
  listening: boolean;
  error: string;                      // dinleyici açılamadıysa (ör. port kullanımda)
  port: number;
  target: string;                     // yeni kişilerin yedek diski
  targets: (ReturnType<typeof listTargets>[number] & { problem: string | null })[];
  profiles: ProfileSummary[];         // kişiler (v2, şifreli)
  legacy: MobileDevice[];             // eski sürümle eşleştirilen telefonlar (v1, şifresiz, Yedekler klasörü)
  syncOn: boolean;                    // Cihaz Yedekleme açık (eski sürüm yalnız onunla yükler)
  lastDevice: { id: number; name: string; person: string } | null; // en son eşleştirilen (panel eşleşmeyi bundan anlar)
  pairing: { code: string; expires: number; person: string } | null;
  hosts: string[];
}
interface DeviceRow {
  id: number; name: string; platform: string; token_hash: string; dir: string; files: number; bytes: number; last_seen: string; profile_id: string;
}

// ── veritabanı ve ayar ──────────────────────────────────────────────────────
let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  tablesReady ??= (async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS mobile_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', token_hash TEXT NOT NULL UNIQUE,
      dir TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen TEXT NOT NULL DEFAULT '',
      files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS mobile_files (
      device_id INTEGER NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (device_id, key))`);
    await ensureStoreTables();
  })().catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}
export async function readMobileConf(): Promise<MobileConf> {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY]).catch(() => null);
  try {
    const j = JSON.parse(row?.value || '{}');
    return { enabled: j.enabled === true, target: checkTarget(j.target, 'internal') };
  } catch {
    return { enabled: false, target: 'internal' };
  }
}
async function writeConf(c: MobileConf): Promise<void> {
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(c)]);
}
function checkTarget(raw: unknown, fallback?: string): string {
  if (raw === 'internal' || (typeof raw === 'string' && /^usb:[A-Za-z0-9_-]{1,40}$/.test(raw))) return raw;
  if (fallback !== undefined) return fallback;
  throw new Error('Hedef disk seçin');
}
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const httpError = (status: number, msg: string) => Object.assign(new Error(msg), { status });

// ── eşleştirme ──────────────────────────────────────────────────────────────
// Kod bir kişiye bağlıdır: var olan kişi (profile) ya da telefon eşleşince oluşturulacak yeni kişi (person)
let pairing: { code: string; expires: number; fails: number; profile: string; person: string } | null = null;
function newCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const liveCode = () => (pairing && pairing.expires > Date.now() ? pairing : null);

// Uygulamanın deneyeceği adresler: ev ağı (iki bacakta ikisi de), sabit ad (Pi-hole kaydı, Cihaz Yedekleme açıkken) ve
// Ev VPN'i açıksa onun adresi (evden uzaktayken VPN'le)
async function piHosts(): Promise<string[]> {
  const lan = await getLanIdentity().catch(() => null);
  const out = [lan?.ip, lan?.transit?.ip, lan?.client?.ip].filter((x): x is string => !!x);
  if (syncEnabled()) out.push(SYNC_DNS_NAME);
  if (fs.existsSync(`/sys/class/net/${WG_IFACE}`)) out.push(WG_SERVER_IP);
  return [...new Set(out)];
}

// body: { profile: kişi kimliği } ya da { person: yeni kişinin adı }
export async function startPairing(body: { profile?: unknown; person?: unknown }): Promise<{ code: string; expires: number; qr: string; hosts: string[]; payload: string; person: string }> {
  const conf = await readMobileConf();
  needOn(conf);
  await ensureTables();
  let profile = '';
  let person = '';
  if (typeof body?.profile === 'string' && body.profile) {
    const p = await getProfile(body.profile);
    if (!p) throw new Error('Kişi bulunamadı');
    profile = p.id;
    person = p.name;
  } else {
    person = await checkNewPerson(body?.person);
    const bad = targetProblem(conf.target);
    if (bad) throw new Error(bad);
  }
  const hosts = await piHosts();
  if (!hosts.length) throw new Error("Pi'nin ev ağı adresi okunamadı");
  pairing = { code: newCode(), expires: Date.now() + PAIR_TTL_MS, fails: 0, profile, person };
  // QR içeriği uygulamanın tanıdığı biçim: t = tür, v = sürüm, h = adresler, p = port, c = kod, n = Pi'nin adı
  const payload = JSON.stringify({ t: 'klyrix-backup', v: 1, h: hosts, p: MOBILE_PORT, c: pairing.code, n: os.hostname() });
  const qr = await qrDataUrl(payload).catch(() => '');
  return { code: pairing.code, expires: pairing.expires, qr, hosts, payload, person };
}
export function cancelPairing(): void { pairing = null; }

// Kodu doğrular ve tüketir (tek kullanımlık; bekleme yok: iki telefon aynı kodu kullanamaz). Yanlış kod sayılır.
function takeCode(body: any): { profile: string; person: string } {
  const p = liveCode();
  if (!p) throw httpError(403, 'Eşleştirme kodu yok ya da süresi doldu — panelde yeni kod alın');
  const code = typeof body?.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (code !== p.code.replace('-', '')) {
    if (++p.fails >= PAIR_MAX_FAILS) pairing = null; // kaba kuvvet: kod düşer
    throw httpError(403, 'Eşleştirme kodu yanlış');
  }
  pairing = null;
  return { profile: p.profile, person: p.person };
}
const deviceName = (body: any): string => (typeof body?.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '');
const devicePlatform = (body: any): string => (body?.platform === 'ios' || body?.platform === 'android' ? body.platform : '');
const platformLabel = (p: string) => (p === 'ios' ? ' (iOS)' : p === 'android' ? ' (Android)' : '');

// v2: telefon kişiye eklenir (yeni kişiyse şimdi oluşturulur, yedekleri o anki hedef diskte durur)
async function pairDevice2(body: any): Promise<{ token: string; device: { id: number; name: string }; profile: unknown }> {
  const name = deviceName(body);
  if (!name) throw httpError(400, 'Cihaz adı gerekli');
  const spec = takeCode(body);
  await ensureTables();
  let p = spec.profile ? await getProfile(spec.profile) : undefined;
  if (spec.profile && !p) throw httpError(409, 'Bu kişi panelden kaldırılmış — panelde yeni kod alın');
  if (!p) {
    const conf = await readMobileConf();
    const bad = targetProblem(conf.target);
    if (bad) throw httpError(503, bad);
    p = await createProfile(spec.person || name, conf.target);
  }
  const platform = devicePlatform(body);
  const token = crypto.randomBytes(32).toString('base64url');
  const id = await dbInsert('INSERT INTO mobile_devices (name, platform, token_hash, dir, profile_id) VALUES (?, ?, ?, ?, ?)', [name, platform, sha256(token), '', p.id]);
  await recordEvent('sync', `Telefon / tablet eşleştirildi: ${name}${platformLabel(platform)} — ${p.name}, Klyrix/Gate Sync`);
  return { token, device: { id, name }, profile: await profileOut(p, id) };
}

// v1 (eski uygulama): kişisiz, şifresiz; dosyalar Yedekler klasörüne
async function pairDevice(body: any): Promise<{ token: string; device: { id: number; name: string } }> {
  const name = deviceName(body);
  if (!name) throw httpError(400, 'Cihaz adı gerekli');
  takeCode(body);
  const platform = devicePlatform(body);
  await ensureTables();
  const used = new Set((await dbAll('SELECT dir FROM mobile_devices') as { dir: string }[]).map(r => r.dir.toLowerCase()));
  const base = safeName(name, 'Telefon');
  let dir = base;
  for (let i = 2; used.has(dir.toLowerCase()); i++) dir = `${base}-${i}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const id = await dbInsert('INSERT INTO mobile_devices (name, platform, token_hash, dir) VALUES (?, ?, ?, ?)', [name, platform, sha256(token), dir]);
  await recordEvent('sync', `Telefon / tablet eşleştirildi: ${name}${platformLabel(platform)} — Klyrix/Gate Sync eski sürüm (şifresiz, Yedekler klasörü)`);
  return { token, device: { id, name } };
}

const seenAt = new Map<number, number>();
async function authDevice(req: http.IncomingMessage): Promise<DeviceRow | null> {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  await ensureTables();
  const d = await dbGet('SELECT * FROM mobile_devices WHERE token_hash = ?', [sha256(m[1])]) as DeviceRow | undefined;
  if (!d) return null;
  if (Date.now() - (seenAt.get(d.id) || 0) > 60_000) {
    seenAt.set(d.id, Date.now());
    await dbRun('UPDATE mobile_devices SET last_seen = ? WHERE id = ?', [new Date().toISOString(), d.id]).catch(() => {});
  }
  return d;
}

// ── yükleme ─────────────────────────────────────────────────────────────────
// Hedef kökü (sync.sh target: bağlama noktası + dizin sahipliği) bir dakika önbellekte; bağlılık her istekte yeniden denetlenir
let rootCache: { target: string; root: string; at: number } | null = null;
async function targetRoot(conf: MobileConf): Promise<{ root: string; mount: string; free: number | null; reserve: number }> {
  const t = listTargets().find(x => x.key === conf.target);
  if (!t || !t.mounted) throw httpError(503, 'Yedek diski bağlı değil — Pi\'de diski takın ya da panelden başka hedef seçin');
  if (!rootCache || rootCache.target !== conf.target || Date.now() - rootCache.at > 60_000) {
    rootCache = { target: conf.target, root: await prepareTargetRoot(conf.target), at: Date.now() };
  }
  const mount = t.kind === 'internal' ? '/mnt/klyrix-share' : `/mnt/klyrix-usb/${t.name}`;
  return { root: rootCache.root, mount, free: t.free, reserve: t.size ? Math.min(RESERVE, Math.round(t.size * 0.05)) : RESERVE };
}

// Sahiplik: Syncthing'in yazdıklarıyla aynı (klyrix-sync, Yedekler paylaşımı bu grupla okur). FAT / exFAT / NTFS
// sahiplik tutmaz (bağlama seçenekleri) — hata yok sayılır.
let syncIds: { uid: number; gid: number } | null | undefined;
async function owner(): Promise<{ uid: number; gid: number } | null> {
  if (syncIds !== undefined) return syncIds;
  const [u, g] = await Promise.all([
    execFileP('id', ['-u', SYNC_USER], { timeout: 5000 }).then(r => Number(r.stdout.trim()), () => NaN),
    execFileP('id', ['-g', SYNC_USER], { timeout: 5000 }).then(r => Number(r.stdout.trim()), () => NaN),
  ]);
  syncIds = Number.isInteger(u) && Number.isInteger(g) ? { uid: u, gid: g } : null;
  return syncIds;
}
// Kök (prepareTargetRoot) vardır: özyineleme en geç orada durur
async function mkdirOwned(dir: string): Promise<void> {
  if (fs.existsSync(dir)) return;
  await mkdirOwned(path.dirname(dir));
  fs.mkdirSync(dir, { mode: 0o2750 });
  const o = await owner();
  try { if (o) fs.chownSync(dir, o.uid, o.gid); fs.chmodSync(dir, 0o2750); } catch { /* FAT / exFAT */ }
}

// Dosya adı: yol parçası olmadan, Windows / FAT'ın yasakladıkları atılır, uzantı korunur
export function cleanFileName(raw: unknown): string {
  const n = path.posix.basename(String(raw || '').replace(/\\/g, '/')).normalize('NFC')
    .replace(/[:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '');
  const ext = path.extname(n).slice(0, 12);
  const stem = n.slice(0, n.length - path.extname(n).length).slice(0, 120);
  return (stem || 'dosya') + ext;
}
// Aynı adda dosya varsa üzerine yazılmaz: "ad (2).uzantı"
function freePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const p = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw httpError(409, 'Aynı adda çok fazla dosya');
}

interface Active { req: http.IncomingMessage; mount: string }
const active = new Map<string, Active>();
const partName = (key: string) => `${crypto.createHash('sha1').update(key).digest('hex')}.part`;
const intParam = (u: URL, k: string, min: number, max: number, def?: number): number => {
  const v = u.searchParams.get(k);
  if (v === null && def !== undefined) return def;
  const n = Number(v);
  if (v === null || !/^\d{1,15}$/.test(v) || n < min || n > max) throw httpError(400, `Geçersiz ${k}`);
  return n;
};
function checkKey(raw: unknown): string {
  const k = typeof raw === 'string' ? raw : '';
  if (!KEY_RE.test(k) || k.includes('..')) throw httpError(400, 'Geçersiz dosya anahtarı');
  return k;
}

async function uploadState(dev: DeviceRow, u: URL): Promise<{ received: number; done: boolean }> {
  const key = checkKey(u.searchParams.get('key'));
  const doneRow = await dbGet('SELECT size FROM mobile_files WHERE device_id = ? AND key = ?', [dev.id, key]);
  if (doneRow) return { received: Number(doneRow.size), done: true };
  const conf = await readMobileConf();
  needActive(conf);
  const { root } = await targetRoot(conf);
  const part = path.join(root, dev.dir, PART_DIR, partName(key));
  let received = 0;
  try { received = fs.statSync(part).size; } catch { /* yok */ }
  return { received, done: false };
}

async function upload(dev: DeviceRow, u: URL, req: http.IncomingMessage): Promise<{ received: number; done: boolean; duplicate?: boolean; path?: string }> {
  const key = checkKey(u.searchParams.get('key'));
  const size = intParam(u, 'size', 0, MAX_FILE);
  const offset = intParam(u, 'offset', 0, MAX_FILE, 0);
  const mtime = intParam(u, 'mtime', 0, 4102444800, 0); // saniye; 0 = şimdi
  const name = cleanFileName(u.searchParams.get('name'));
  const len = Number(req.headers['content-length']);
  if (req.headers['transfer-encoding'] || !Number.isInteger(len) || len < 0) throw httpError(411, 'Content-Length gerekli');
  if (offset + len > size) throw httpError(400, 'Parça bildirilen boyutu aşıyor');

  const doneRow = await dbGet('SELECT size FROM mobile_files WHERE device_id = ? AND key = ?', [dev.id, key]);
  if (doneRow) return { received: Number(doneRow.size), done: true, duplicate: true };
  const conf = await readMobileConf();
  needActive(conf);
  const id = `${dev.id}:${key}`;
  if (active.has(id)) throw httpError(409, 'Bu dosya zaten yükleniyor');
  const { root, mount, free, reserve } = await targetRoot(conf);
  const devDir = path.join(root, dev.dir);
  const partDir = path.join(devDir, PART_DIR);
  await mkdirOwned(partDir);
  const part = path.join(partDir, partName(key));
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* yok */ }
  // offset 0 her zaman kabul: yarım dosya baştan yazılır (iOS arka plan yüklemesi bütün dosyayı yeniden gönderir)
  if (offset === 0) have = 0;
  else if (offset !== have) throw Object.assign(httpError(409, 'Kaldığı yerden sürdürülmeli'), { received: have });
  if (free !== null && free - (size - have) < reserve) {
    await recordEventOnce('sync', `Yedek diski dolu: ${dev.name} telefonundan gelen dosyalar yazılamıyor (boş yer yetmiyor)`, 'warning', 720);
    throw httpError(507, 'Yedek diskinde yer yok');
  }

  active.set(id, { req, mount });
  let got = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (got > len) cb(new Error('Bildirilenden fazla veri')); else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(part, { flags: offset === 0 ? 'w' : 'a', mode: 0o640 }));
  } finally {
    active.delete(id);
  }
  const received = have + got;
  if (got !== len) throw Object.assign(httpError(400, 'Parça eksik geldi'), { received });
  if (received < size) return { received, done: false };

  // Tamam: <cihaz>/Kamera/<yıl>/<ay>/ad — tarih çekim zamanından (mtime), yoksa bugün
  const when = mtime ? new Date(mtime * 1000) : new Date();
  const dir = path.join(devDir, MEDIA_DIR, String(when.getFullYear()), String(when.getMonth() + 1).padStart(2, '0'));
  await mkdirOwned(dir);
  const dest = freePath(dir, name);
  fs.renameSync(part, dest);
  const o = await owner();
  try { if (o) fs.chownSync(dest, o.uid, o.gid); fs.chmodSync(dest, 0o640); } catch { /* FAT / exFAT */ }
  if (mtime) { try { fs.utimesSync(dest, when, when); } catch { /* */ } }
  await dbRun('INSERT OR IGNORE INTO mobile_files (device_id, key, path, size) VALUES (?, ?, ?, ?)', [dev.id, key, dest, size]);
  await dbRun('UPDATE mobile_devices SET files = files + 1, bytes = bytes + ? WHERE id = ?', [size, dev.id]);
  return { received, done: true, path: path.relative(root, dest) };
}

// Gövde bayt olarak toplanır, sonunda çözülür (çok baytlı harf parçalar arasında bölünse de bozulmaz)
async function readJson(req: http.IncomingMessage, max = 256 * 1024): Promise<any> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw httpError(413, 'İstek çok büyük');
    parts.push(c as Buffer);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw httpError(400, 'Geçersiz JSON'); }
}
const privateAddr = (a: string): boolean => {
  const ip = a.replace(/^::ffff:/, '');
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return ip === '::1';
  const [a1, a2] = [Number(m[1]), Number(m[2])];
  return a1 === 10 || a1 === 127 || (a1 === 172 && a2 >= 16 && a2 <= 31) || (a1 === 192 && a2 === 168);
};

// v2: kişinin şifreli deposu (mobileStore.ts). Cihaz yalnız kendi kişisinin nesnelerini ve yedeklerini görür.
const SNAPSHOT_BODY_MAX = 80 * 2 ** 20; // ~1 milyon nesne kimliği
async function handleV2(dev: DeviceRow, u: URL, req: http.IncomingMessage, res: http.ServerResponse, send: (code: number, body: unknown) => void): Promise<void> {
  if (!dev.profile_id) return send(409, { error: 'Bu telefon uygulamanın eski sürümüyle eşleştirilmiş — uygulamada yeniden eşleştirin' });
  needOn(await readMobileConf());
  const p = await getProfile(dev.profile_id);
  if (!p) return send(401, { error: 'Kişi panelden kaldırılmış — panelden yeniden eşleştirin' });
  const route = `${req.method} ${u.pathname}`;
  if (route === 'GET /v2/profile') return send(200, await profileOut(p, dev.id));
  if (route === 'PUT /v2/profile/keycheck') {
    await setKeyCheck(p, (await readJson(req, 4096))?.keyCheck);
    return send(200, {});
  }
  if (route === 'POST /v2/objects/check') return send(200, await checkObjects(p, (await readJson(req, 128 * 1024))?.ids));
  const om = /^\/v2\/objects\/([0-9a-f]{64})(\/state)?$/.exec(u.pathname);
  if (om && req.method === 'GET' && om[2]) return send(200, await objectState(p, om[1]));
  if (om && req.method === 'PUT' && !om[2]) return send(200, await putObject(p, om[1], u, req));
  if (om && req.method === 'GET' && !om[2]) return sendObject(p, om[1], req, res);
  if (route === 'GET /v2/snapshots') return send(200, { snapshots: await listSnapshots(p, u.searchParams.get('trash') === '1') });
  if (route === 'POST /v2/snapshots') return send(200, await createSnapshot(p, dev, await readJson(req, SNAPSHOT_BODY_MAX)));
  const sm = /^\/v2\/snapshots\/(\d{1,12})(\/restore)?$/.exec(u.pathname);
  if (sm && req.method === 'DELETE' && !sm[2]) {
    await trashSnapshot(p, dev, sm[1]);
    return send(200, {});
  }
  if (sm && req.method === 'POST' && sm[2]) {
    await untrashSnapshot(p, sm[1]);
    return send(200, {});
  }
  if (route === 'GET /v2/usage') return send(200, await usage(p));
  return send(404, { error: 'Bilinmeyen istek' });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const send = (code: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!privateAddr(req.socket.remoteAddress || '')) return send(403, { error: 'Yalnız ev ağından ya da Ev VPN\'inden' });
    const u = new URL(req.url || '/', 'http://pi');
    const route = `${req.method} ${u.pathname}`;
    if (route === 'GET /v1/hello') return send(200, { app: 'klyrix-gate', v: 1, v2: true, name: os.hostname() });
    if (route === 'POST /v1/pair') return send(200, await pairDevice(await readJson(req, 4096)));
    if (route === 'POST /v2/pair') return send(200, await pairDevice2(await readJson(req, 4096)));
    const dev = await authDevice(req);
    if (!dev) return send(401, { error: 'Cihaz tanınmadı — panelden yeniden eşleştirin' });
    if (u.pathname.startsWith('/v2/')) return await handleV2(dev, u, req, res, send);
    if (dev.profile_id) return send(409, { error: 'Bu telefon uygulamanın yeni sürümüyle eşleştirilmiş' });
    if (route === 'GET /v1/status') {
      const conf = await readMobileConf();
      const t = listTargets().find(x => x.key === conf.target);
      return send(200, {
        ok: conf.enabled && syncEnabled(), device: { name: dev.name, files: dev.files, bytes: dev.bytes },
        target: t ? { name: t.kind === 'internal' ? 'Dahili disk' : t.name, mounted: t.mounted, free: t.free, size: t.size } : null,
      });
    }
    if (route === 'POST /v1/check') {
      const body = await readJson(req);
      const keys: string[] = Array.isArray(body?.keys) ? body.keys.slice(0, MAX_CHECK).filter((k: unknown) => typeof k === 'string' && KEY_RE.test(k)) : [];
      const have: string[] = [];
      for (let i = 0; i < keys.length; i += 200) {
        const part = keys.slice(i, i + 200);
        const rows = await dbAll(`SELECT key FROM mobile_files WHERE device_id = ? AND key IN (${part.map(() => '?').join(',')})`, [dev.id, ...part]) as { key: string }[];
        have.push(...rows.map(r => r.key));
      }
      return send(200, { have });
    }
    if (route === 'GET /v1/upload') return send(200, await uploadState(dev, u));
    if (route === 'PUT /v1/upload') return send(200, await upload(dev, u, req));
    return send(404, { error: 'Bilinmeyen istek' });
  } catch (e: any) {
    const status = Number(e?.status) || 500;
    if (status >= 500 && status !== 503 && status !== 507) console.error('[mobil-yedek]', e?.message || e);
    if (!req.readableEnded) req.resume(); // okunmamış gövde bağlantıyı tıkamasın
    send(status, { error: String(e?.message || e), ...(typeof e?.received === 'number' ? { received: e.received } : {}) });
  }
}

// ── dinleyici + güvenlik duvarı ─────────────────────────────────────────────
let server: http.Server | null = null;
let listenError = '';
// v2 yalnız açık olmasını ister; v1 (eski sürüm, Yedekler klasörü) Cihaz Yedekleme'yi de
function needOn(conf: MobileConf): void {
  if (!isLinux) throw httpError(503, 'Mobil yedekleme yalnız Pi üzerinde çalışır');
  if (!conf.enabled) throw httpError(503, 'Mobil yedekleme kapalı — panelden açın');
}
function needActive(conf: MobileConf): void {
  needOn(conf);
  if (!syncEnabled()) throw httpError(503, 'Uygulamanın eski sürümü yalnız Cihaz Yedekleme açıkken yükler — uygulamayı güncelleyin');
}
async function listen(on: boolean): Promise<void> {
  if (on && !server) {
    const s = http.createServer((req, res) => { void handle(req, res); });
    s.requestTimeout = 0;          // büyük video tek istekte gelebilir
    s.headersTimeout = 30_000;
    s.keepAliveTimeout = 30_000;
    await new Promise<void>(resolve => {
      s.once('error', (e: any) => {
        listenError = e?.code === 'EADDRINUSE' ? `Port ${MOBILE_PORT} başka bir uygulamada` : String(e?.message || e);
        console.error('[mobil-yedek] dinleyici açılamadı:', listenError);
        resolve();
      });
      s.listen(MOBILE_PORT, '0.0.0.0', () => { server = s; listenError = ''; resolve(); });
    });
  } else if (!on && server) {
    const s = server;
    server = null;
    for (const a of active.values()) a.req.destroy();
    abortStore();
    await new Promise<void>(resolve => s.close(() => resolve()));
  }
}
async function nft(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('nft', ['-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let se = '';
    p.stderr.on('data', (d: Buffer) => { se += d; });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error(se.trim() || `nft çıkış ${c}`))));
    p.stdin.on('error', () => {}); // EPIPE: sonuç close'tan gelir
    p.stdin.end(script);
  });
}
export async function syncMobileFirewall(enable: boolean): Promise<void> {
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
// Açık olmalı mı (ayar + ana cihaz) → dinleyici ve güvenlik duvarı ona göre
let reconcileRun: Promise<void> | null = null;
export function reconcileMobile(): Promise<void> {
  if (reconcileRun) return reconcileRun.then(() => reconcileMobile());
  reconcileRun = (async () => {
    if (!isLinux) return;
    const want = (await readMobileConf()).enabled && !isSatellite();
    await listen(want);
    await syncMobileFirewall(want && !!server).catch(e => console.error('[mobil-yedek] güvenlik duvarı:', e?.message || e));
  })().finally(() => { reconcileRun = null; });
  return reconcileRun;
}

// ── panel ───────────────────────────────────────────────────────────────────
export async function mobileStatus(): Promise<MobileStatus> {
  const conf = await readMobileConf();
  await ensureTables().catch(() => {});
  const legacy = await dbAll("SELECT id, name, platform, created_at, last_seen, files, bytes FROM mobile_devices WHERE profile_id = '' ORDER BY id").catch(() => []) as MobileDevice[];
  const last = await dbGet(`SELECT d.id, d.name, COALESCE(p.name, '') AS person FROM mobile_devices d
    LEFT JOIN mobile_profiles p ON p.id = d.profile_id ORDER BY d.id DESC LIMIT 1`).catch(() => null);
  const p = liveCode();
  return {
    supported: isLinux, enabled: conf.enabled, listening: !!server, error: listenError, port: MOBILE_PORT,
    target: conf.target, targets: isLinux ? listTargets().map(t => ({ ...t, problem: storeProblem(t) })) : [],
    profiles: await listProfiles().catch(() => []), legacy, syncOn: isLinux && syncEnabled(),
    lastDevice: last ? { id: Number(last.id), name: last.name, person: last.person } : null,
    pairing: p ? { code: p.code, expires: p.expires, person: p.person } : null, hosts: isLinux ? await piHosts() : [],
  };
}
// Hedef: yeni kişilerin yedeklerinin yazılacağı disk (Linux dosya sistemi; özel alanın kökü burada oluşturulur)
export async function setMobile(body: { enabled?: unknown; target?: unknown }): Promise<void> {
  const conf = await readMobileConf();
  if (body.target !== undefined) {
    conf.target = checkTarget(body.target);
    prepareStoreRoot(conf.target);
    rootCache = null;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('Geçersiz değer');
    if (body.enabled && body.target === undefined) prepareStoreRoot(conf.target);
    conf.enabled = body.enabled;
  }
  await ensureTables();
  await writeConf(conf);
  await reconcileMobile();
  if (conf.enabled && !server) throw new Error(`Mobil yedekleme açılamadı: ${listenError || 'dinleyici başlamadı'}`);
  if (body.enabled !== undefined) await recordEvent('sync', conf.enabled ? `Mobil yedekleme açıldı (port ${MOBILE_PORT})` : 'Mobil yedekleme kapatıldı');
}
// Telefonu kaldırır (anahtarı geçersiz). Kişinin telefonuysa yedekler kişide kalır. Eski sürüm telefonunda files = true
// Yedekler klasörüne yüklediği dosyaları da siler (yalnız kayıtlı yollar, yalnız bağlı yedek köklerinin içinde).
export async function removeMobileDevice(raw: unknown, files = false): Promise<{ removed: number; kept: number }> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Geçersiz cihaz');
  await ensureTables();
  const d = await dbGet('SELECT name, dir, profile_id FROM mobile_devices WHERE id = ?', [id]) as { name: string; dir: string; profile_id: string } | undefined;
  if (!d) throw new Error('Cihaz bulunamadı');
  for (const [k, a] of active) if (k.startsWith(`${id}:`)) a.req.destroy();
  const out = files && !d.profile_id ? await deleteLegacyFiles(id, d.dir) : { removed: 0, kept: 0 };
  await dbRun('DELETE FROM mobile_files WHERE device_id = ?', [id]);
  await dbRun('DELETE FROM mobile_devices WHERE id = ?', [id]);
  seenAt.delete(id);
  const person = d.profile_id ? (await getProfile(d.profile_id))?.name : '';
  await recordEvent('sync', person
    ? `Telefon / tablet kaldırıldı: ${d.name} (${person} kişisinin yedekleri duruyor)`
    : files
      ? `Telefon / tablet kaldırıldı: ${d.name} — ${out.removed} dosyası silindi${out.kept ? `, ${out.kept} dosya silinemedi` : ''}`
      : `Telefon / tablet kaldırıldı: ${d.name} (yedeklenen dosyalar diskte kaldı)`);
  return out;
}
async function deleteLegacyFiles(id: number, dir: string): Promise<{ removed: number; kept: number }> {
  const rows = await dbAll('SELECT path FROM mobile_files WHERE device_id = ?', [id]) as { path: string }[];
  const roots = backupRoots();
  if (rows.length && !roots.length) throw new Error('Dosyaların bulunduğu yedek diski bağlı değil — diski takıp yeniden deneyin');
  let removed = 0;
  let kept = 0;
  const dirs = new Set<string>();
  for (const r of rows) {
    const root = roots.find(x => r.path.startsWith(`${x}/`));
    if (!root) { kept++; continue; }
    try {
      await fs.promises.unlink(r.path);
      removed++;
    } catch (e: any) {
      if (e?.code === 'ENOENT') removed++; else kept++;
    }
    dirs.add(path.dirname(r.path));
  }
  // Yarım yüklemeler ve boşalan Kamera/yıl/ay klasörleri (boş değilse durur; yedek kökünün üstüne çıkmaz)
  for (const root of roots) {
    if (dir && safeName(dir, '') === dir) {
      await fs.promises.rm(path.join(root, dir, PART_DIR), { recursive: true, force: true }).catch(() => {});
      dirs.add(path.join(root, dir, MEDIA_DIR));
    }
  }
  for (const start of [...dirs].sort((a, b) => b.length - a.length)) {
    let cur = start;
    while (roots.some(x => cur.startsWith(`${x}/`))) {
      try { await fs.promises.rmdir(cur); } catch { break; }
      cur = path.dirname(cur);
    }
  }
  return { removed, kept };
}
// Kişiyi (tüm telefonları ve şifreli yedekleriyle) kaldırır
export async function removeMobilePerson(raw: unknown): Promise<{ name: string; filesKept: boolean }> {
  await ensureTables();
  const r = await removeProfile(raw);
  seenAt.clear();
  return r;
}
export function mobileBlocksSatellite(): string | null {
  return server ? 'Mobil yedekleme açık — önce kapatın (Yedekleme → Cihaz Yedekleme)' : null;
}

export function startMobile(): void {
  if (!isLinux || isSatellite()) return;
  onWgRulesChanged(async () => { if (server) await syncMobileFirewall(true); });
  // USB disk ayrılırken o diske yazan / okuyan istekler kesilir (umount "kullanımda" olmasın); uygulama sonra kaldığı yerden sürer
  onUsbRemove(async name => {
    for (const a of active.values()) if (a.mount === `/mnt/klyrix-usb/${name}`) a.req.destroy();
    abortStore({ mount: `/mnt/klyrix-usb/${name}` });
    rootCache = null;
  });
  void reconcileMobile();
  // Ayar başka yoldan değişirse (yedekten geri yükleme) dinleyici ona uyar
  setInterval(() => { void reconcileMobile().catch(() => {}); }, 60_000);
  // Şifreli depo temizliği: çöpte 30 günü dolan yedekler, kullanılmayan nesneler (açılıştan 10 dk sonra, sonra 6 saatte bir)
  const gc = () => { void ensureTables().then(() => storeGc()).catch(e => console.error('[mobil-yedek] temizlik:', e?.message || e)); };
  setTimeout(gc, 10 * 60_000);
  setInterval(gc, 6 * 3600_000);
}

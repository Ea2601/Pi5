// Klyrix/Gate Sync v2 deposu (mobile.ts /v2 uçları): kişi profilleri, uçtan uca şifreli nesneler, anlık görüntüler (yedekler).
// Pi içerik görmez: uygulama her dosyayı kişinin anahtarıyla şifreler (mobile/src/core/crypto.ts); Pi yalnız opak nesne
// kimliği (HMAC), şifreli boyut ve zaman saklar. Anahtar Pi'ye hiç gelmez: key_check yalnız doğru anahtarın açabildiği bir
// sınamadır (yeni cihaz kurtarma anahtarını onunla doğrular).
//  - Yer: <disk>/.klyrix-mobil/<kişi>/o/<ab>/<nesne> — paylaşımların dışında, root 0700 (Samba, Yedekler, Bulut Yedeği
//    görmez; USB paylaşımında veto: share.sh). Yalnız Linux dosya sistemi (FAT / exFAT / NTFS izin tutmaz). SD karta asla:
//    kök klasör yalnız diskin bağlı olduğu doğrulanınca oluşturulur; alt klasörler kökün içinde.
//  - Her kişi bir diskte kalır (kişi oluşturulurken seçili hedef); hedef değişince yalnız yeni kişiler oraya yazılır.
//  - Yükleme sürdürülebilir (offset ≤ alınan; küçükse kesilip yeniden yazılır), gövde akışla diske. Tamamlanan nesne
//    değişmez. Okuma Range ile (geri yükleme parça parça).
//  - Anlık görüntünün nesne listesi diskte (<kişi>/s/<no>.ids, 32 baytlık kimlikler): panelin SD karttaki veritabanı
//    telefon başına on binlerce satırla büyümez.
//  - Seyreltme (cihaz başına): en yenisi hep; son 14 günde günün, son 8 haftada haftanın, son 12 ayda ayın en yenisi kalır.
//  - Silme çöpe: anlık görüntü 30 gün çöpte kalır (uygulamadan geri alınır), sonra silinir. Hiçbir anlık görüntünün
//    kullanmadığı ve 30 gündür dokunulmayan (yüklenmeyen / denetlenmeyen) nesneler diskten silinir. Diskte veritabanının
//    bilmediği hiçbir şeye dokunulmaz (veritabanı kaybolsa da yedekler diskte kalır).
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { dbAll, dbGet, dbRun, dbRunChanges, dbInsert } from './db';
import { recordEvent, recordEventOnce } from './events';
import { listTargets, type SyncTarget } from './sync';

export const STORE_DIR = '.klyrix-mobil';
const OBJ_DIR = 'o';
const SNAP_DIR = 's';
export const TRASH_DAYS = 30;
const ORPHAN_DAYS = 30;
const KEEP = { days: 14, weeks: 8, months: 12 };
const DAY = 86_400_000;
const OBJ_RE = /^[0-9a-f]{64}$/;
const PROFILE_RE = /^[0-9a-f]{12}$/;
const MAX_OBJECT = 65 * 2 ** 30;           // şifreli nesne: 64 GB dosya + parça başına 28 bayt
const MAX_SNAPSHOT_OBJECTS = 1_000_000;
const CHECK_MAX = 1000;
const RESERVE = 2 ** 30;                    // hedefte en az 1 GB (küçük diskte %5) boş kalsın
const LINUX_FS = new Set(['ext2', 'ext3', 'ext4', 'btrfs', 'xfs']);
const INTERNAL_MNT = '/mnt/klyrix-share';
const USB_MNT = '/mnt/klyrix-usb';

export interface ProfileRow { id: string; name: string; target: string; key_check: string | null; created_at: string }
export interface StoreDevice { id: number; name: string; profile_id: string }
export interface SnapshotOut {
  id: number; device: string; deviceId: number; createdAt: string; deletedAt: string | null; purgeAt: string | null;
  manifest: string; stats: Record<string, number>; bytes: number;
}
export interface ProfileSummary {
  id: string; name: string; target: string; targetLabel: string; problem: string | null; keySet: boolean; createdAt: string;
  devices: { id: number; name: string; platform: string; created_at: string; last_seen: string }[];
  snapshots: number; trash: number; lastBackup: string | null; bytes: number; objects: number;
}

const httpError = (status: number, msg: string) => Object.assign(new Error(msg), { status });
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const qs = (n: number) => Array(n).fill('?').join(', ');
function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return -1; }
}
function intParam(u: URL, k: string, min: number, max: number): number {
  const v = u.searchParams.get(k);
  const n = Number(v);
  if (v === null || !/^\d{1,15}$/.test(v) || n < min || n > max) throw httpError(400, `Geçersiz ${k}`);
  return n;
}
export const validObjectId = (s: unknown): s is string => typeof s === 'string' && OBJ_RE.test(s);

// ── tablolar (mobile.ts ensureTables mobile_devices'tan sonra çağırır) ─────────
export async function ensureStoreTables(): Promise<void> {
  await dbRun(`CREATE TABLE IF NOT EXISTS mobile_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, target TEXT NOT NULL, key_check TEXT, created_at TEXT NOT NULL)`);
  await dbRun(`ALTER TABLE mobile_devices ADD COLUMN profile_id TEXT NOT NULL DEFAULT ''`).catch(e => {
    if (!/duplicate column/i.test(String(e?.message))) throw e;
  });
  await dbRun(`CREATE TABLE IF NOT EXISTS mobile_objects (
    profile_id TEXT NOT NULL, id TEXT NOT NULL, size INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, touched_at TEXT NOT NULL, PRIMARY KEY (profile_id, id))`);
  await dbRun(`CREATE TABLE IF NOT EXISTS mobile_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, device_id INTEGER NOT NULL, device_name TEXT NOT NULL,
    created_at TEXT NOT NULL, deleted_at TEXT, manifest TEXT NOT NULL, stats TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
    ready INTEGER NOT NULL DEFAULT 0)`);
  await dbRun('CREATE INDEX IF NOT EXISTS mobile_snapshots_profile ON mobile_snapshots (profile_id)');
}

// ── disk ────────────────────────────────────────────────────────────────────
export const targetLabel = (t: SyncTarget) => (t.kind === 'internal' ? 'Dahili disk' : `USB: ${t.name}`);
const mountOf = (t: SyncTarget) => (t.kind === 'internal' ? INTERNAL_MNT : `${USB_MNT}/${t.name}`);
// Telefon yedekleri bu diske yazılabilir mi; değilse nedeni
export function storeProblem(t: SyncTarget | undefined): string | null {
  if (!t) return 'Yedek diski bulunamadı — panelden hedef disk seçin';
  if (!t.mounted) return `${targetLabel(t)} bağlı değil — diski takın`;
  if (!LINUX_FS.has(t.fstype)) {
    return `${targetLabel(t)} ${t.fstype || 'bilinmeyen'} biçimli — telefon yedekleri için ext4 gerekir (FAT / exFAT / NTFS dosya izni tutmaz, yedekler gizli kalamaz)`;
  }
  return null;
}
export const targetProblem = (key: string): string | null => storeProblem(listTargets().find(x => x.key === key));

interface Place { dir: string; mount: string; free: number | null; reserve: number }
// Kişinin klasörü (yoksa oluşturulur). Kök yalnız bağlama noktası doğrulanınca: disk ayrıyken SD karta yazılmaz.
function place(p: { id: string; target: string }): Place {
  if (!PROFILE_RE.test(p.id)) throw httpError(500, 'Geçersiz kişi kimliği');
  const t = listTargets().find(x => x.key === p.target);
  const bad = storeProblem(t);
  if (bad || !t) throw httpError(503, bad || 'Yedek diski yok');
  const mount = mountOf(t);
  const root = path.join(mount, STORE_DIR);
  if (!fs.existsSync(root)) {
    if (fs.statSync(mount).dev === fs.statSync(path.dirname(mount)).dev) throw httpError(503, `${targetLabel(t)} bağlı değil — diski takın`);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }
  const dir = path.join(root, p.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  return { dir, mount, free: t.free, reserve: t.size ? Math.min(RESERVE, Math.round(t.size * 0.05)) : RESERVE };
}
// Hedef seçilirken: özel alanın kökü oluşturulabiliyor mu (bağlı, Linux dosya sistemi)
export function prepareStoreRoot(target: string): void {
  const t = listTargets().find(x => x.key === target);
  const bad = storeProblem(t);
  if (bad || !t) throw new Error(bad || 'Yedek diski yok');
  const mount = mountOf(t);
  const root = path.join(mount, STORE_DIR);
  if (fs.existsSync(root)) return;
  if (fs.statSync(mount).dev === fs.statSync(path.dirname(mount)).dev) throw new Error(`${targetLabel(t)} bağlı değil`);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
}
const objPath = (dir: string, id: string) => path.join(dir, OBJ_DIR, id.slice(0, 2), id);
const snapPath = (dir: string, id: number) => path.join(dir, SNAP_DIR, `${id}.ids`);

// Süren yüklemeler / okumalar: USB disk ayrılırken, kişi ya da dinleyici kapanırken kesilir
interface Busy { stream: { destroy(): void }; mount: string; profile: string }
const busy = new Map<string, Busy>();
let readSeq = 0;
export function abortStore(f: { mount?: string; profile?: string } = {}): void {
  for (const b of busy.values()) {
    if ((f.mount === undefined || b.mount === f.mount) && (f.profile === undefined || b.profile === f.profile)) b.stream.destroy();
  }
}

// ── kişi ────────────────────────────────────────────────────────────────────
export async function getProfile(id: string): Promise<ProfileRow | undefined> {
  return await dbGet('SELECT * FROM mobile_profiles WHERE id = ?', [id]) as ProfileRow | undefined;
}
export function cleanPersonName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}
export async function checkNewPerson(raw: unknown): Promise<string> {
  const name = cleanPersonName(raw);
  if (!name) throw new Error('Kişinin adını yazın');
  const rows = await dbAll('SELECT name FROM mobile_profiles') as { name: string }[];
  if (rows.some(r => r.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'))) throw new Error(`${name} zaten var — o kişiye telefon ekleyin`);
  return name;
}
export async function createProfile(name: string, target: string): Promise<ProfileRow> {
  let id = '';
  do { id = crypto.randomBytes(6).toString('hex'); } while (await getProfile(id));
  const row: ProfileRow = { id, name, target, key_check: null, created_at: now() };
  await dbRun('INSERT INTO mobile_profiles (id, name, target, key_check, created_at) VALUES (?, ?, ?, NULL, ?)', [id, name, target, row.created_at]);
  return row;
}
export async function profileOut(p: ProfileRow, meId: number): Promise<{ id: string; name: string; keyCheck: string | null; devices: unknown[] }> {
  const devs = await dbAll('SELECT id, name, platform, last_seen FROM mobile_devices WHERE profile_id = ? ORDER BY id', [p.id]);
  return {
    id: p.id, name: p.name, keyCheck: p.key_check,
    devices: devs.map(d => ({ id: d.id, name: d.name, platform: d.platform, lastSeen: d.last_seen, me: d.id === meId })),
  };
}
// İlk cihaz anahtarı üretince sınamayı yazar; sonrakiler değiştiremez (anahtar kurtarma anahtarıyla alınır)
export async function setKeyCheck(p: ProfileRow, raw: unknown): Promise<void> {
  const kc = typeof raw === 'string' && /^[A-Za-z0-9+/]{40,200}={0,2}$/.test(raw) ? raw : '';
  if (!kc) throw httpError(400, 'Geçersiz anahtar sınaması');
  const n = await dbRunChanges('UPDATE mobile_profiles SET key_check = ? WHERE id = ? AND key_check IS NULL', [kc, p.id]);
  if (!n) throw httpError(409, 'Bu kişinin anahtarı başka bir cihazda oluşturuldu — kurtarma anahtarıyla bağlanın');
}

// ── nesneler ────────────────────────────────────────────────────────────────
// Pi'de tam olanlar (kimlik → şifreli boyut) ve yarımların alınmış baytı. Denetlenen nesneye günde bir "dokunulur" (temizlik
// onu 30 gün silmez: uzun süren ilk yedeklemede anlık görüntü yazılmadan yüklenenler korunur). Tam sanılan ama diskte
// olmayan / boyutu tutmayan nesne yeniden yüklenmek üzere düşürülür.
export async function checkObjects(p: ProfileRow, raw: unknown): Promise<{ have: Record<string, number>; partial: Record<string, number> }> {
  const ids = Array.isArray(raw) ? [...new Set(raw.filter(validObjectId))].slice(0, CHECK_MAX) : [];
  const have: Record<string, number> = {};
  const partial: Record<string, number> = {};
  if (!ids.length) return { have, partial };
  const { dir } = place(p);
  const t = now();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = await dbAll(`SELECT id, size, done FROM mobile_objects WHERE profile_id = ? AND id IN (${qs(part.length)})`, [p.id, ...part]);
    if (!rows.length) continue;
    await dbRun(`UPDATE mobile_objects SET touched_at = ? WHERE profile_id = ? AND id IN (${qs(part.length)}) AND touched_at < ?`, [t, p.id, ...part, ago(DAY)]);
    for (const r of rows) {
      const f = objPath(dir, r.id);
      if (r.done) {
        if (fileSize(f) === Number(r.size)) { have[r.id] = Number(r.size); continue; }
        await dbRun('UPDATE mobile_objects SET done = 0 WHERE profile_id = ? AND id = ?', [p.id, r.id]);
        continue;
      }
      const got = fileSize(`${f}.part`);
      if (got > 0) partial[r.id] = got;
    }
  }
  return { have, partial };
}
export async function objectState(p: ProfileRow, id: string): Promise<{ received: number; size: number; done: boolean }> {
  if (!validObjectId(id)) throw httpError(400, 'Geçersiz nesne');
  const r = await dbGet('SELECT size, done FROM mobile_objects WHERE profile_id = ? AND id = ?', [p.id, id]);
  if (!r) return { received: 0, size: 0, done: false };
  if (r.done) return { received: Number(r.size), size: Number(r.size), done: true };
  return { received: Math.max(0, fileSize(`${objPath(place(p).dir, id)}.part`)), size: Number(r.size), done: false };
}

// Şifreli parça: offset nesnedeki yer (alınandan büyük olamaz; küçükse fazlası kesilir), size nesnenin şifreli boyutu
export async function putObject(p: ProfileRow, id: string, u: URL, req: http.IncomingMessage): Promise<{ received: number; done: boolean }> {
  if (!validObjectId(id)) throw httpError(400, 'Geçersiz nesne');
  const size = intParam(u, 'size', 1, MAX_OBJECT);
  const offset = intParam(u, 'offset', 0, MAX_OBJECT);
  const len = Number(req.headers['content-length']);
  if (req.headers['transfer-encoding'] || !Number.isInteger(len) || len < 0) throw httpError(411, 'Content-Length gerekli');
  if (offset + len > size) throw httpError(400, 'Parça bildirilen boyutu aşıyor');
  const row = await dbGet('SELECT size, done FROM mobile_objects WHERE profile_id = ? AND id = ?', [p.id, id]);
  if (row?.done) {
    if (Number(row.size) !== size) throw httpError(409, 'Bu nesne Pi\'de başka boyutta var');
    return { received: size, done: true };
  }
  const key = `u:${p.id}:${id}`;
  if (busy.has(key)) throw httpError(409, 'Bu nesne zaten yükleniyor');
  const { dir, mount, free, reserve } = place(p);
  const file = objPath(dir, id);
  const part = `${file}.part`;
  let have = row ? Math.max(0, fileSize(part)) : 0;
  if (row && Number(row.size) !== size) {
    if (offset !== 0) throw Object.assign(httpError(409, 'Nesne baştan yüklenmeli'), { received: 0 });
    have = 0;
  }
  if (offset > have) throw Object.assign(httpError(409, 'Kaldığı yerden sürdürülmeli'), { received: have });
  if (free !== null && free - (size - offset) < reserve) {
    await recordEventOnce('sync', `Yedek diski dolu: ${p.name} kişisinin telefon yedekleri yazılamıyor (boş yer yetmiyor)`, 'warning', 720);
    throw httpError(507, 'Yedek diskinde yer yok');
  }
  const t = now();
  if (!row) await dbRun('INSERT OR IGNORE INTO mobile_objects (profile_id, id, size, done, created_at, touched_at) VALUES (?, ?, ?, 0, ?, ?)', [p.id, id, size, t, t]);
  else await dbRun('UPDATE mobile_objects SET size = ?, touched_at = ? WHERE profile_id = ? AND id = ?', [size, t, p.id, id]);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (offset > 0 && offset < have) fs.truncateSync(part, offset);

  busy.set(key, { stream: req, mount, profile: p.id });
  let got = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (got > len) cb(new Error('Bildirilenden fazla veri')); else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(part, { flags: offset === 0 ? 'w' : 'a', mode: 0o600 }));
  } finally {
    busy.delete(key);
  }
  const received = offset + got;
  if (got !== len) throw Object.assign(httpError(400, 'Parça eksik geldi'), { received });
  if (received < size) return { received, done: false };
  fs.renameSync(part, file);
  await dbRun('UPDATE mobile_objects SET done = 1, touched_at = ? WHERE profile_id = ? AND id = ?', [now(), p.id, id]);
  return { received, done: true };
}

// Tam nesneyi (ya da Range: bytes=a-b parçasını) gönderir
export async function sendObject(p: ProfileRow, id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!validObjectId(id)) throw httpError(400, 'Geçersiz nesne');
  const r = await dbGet('SELECT size, done FROM mobile_objects WHERE profile_id = ? AND id = ?', [p.id, id]);
  if (!r?.done) throw httpError(404, 'Nesne Pi\'de yok');
  const { dir, mount } = place(p);
  const file = objPath(dir, id);
  const size = fileSize(file);
  if (size !== Number(r.size)) throw httpError(404, 'Nesne diskte bulunamadı');
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(String(range));
    start = m ? Number(m[1]) : -1;
    end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!m || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  const s = fs.createReadStream(file, { start, end });
  const key = `r:${++readSeq}`;
  busy.set(key, { stream: s, mount, profile: p.id });
  try {
    await pipeline(s, res);
  } finally {
    busy.delete(key);
  }
}

// ── anlık görüntüler (yedekler) ──────────────────────────────────────────────
const STAT_KEYS = ['photos', 'videos', 'audio', 'files', 'contacts', 'events', 'items', 'bytes'];
function cleanStats(raw: any): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of STAT_KEYS) {
    const n = Number(raw?.[k]);
    o[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  return o;
}
function snapOut(r: any): SnapshotOut {
  let stats: Record<string, number> = {};
  try { stats = cleanStats(JSON.parse(r.stats)); } catch { stats = cleanStats({}); }
  return {
    id: Number(r.id), device: r.device_name, deviceId: Number(r.device_id), createdAt: r.created_at, deletedAt: r.deleted_at || null,
    purgeAt: r.deleted_at ? new Date(Date.parse(r.deleted_at) + TRASH_DAYS * DAY).toISOString() : null,
    manifest: r.manifest, stats, bytes: Number(r.bytes) || 0,
  };
}
export async function listSnapshots(p: ProfileRow, trash: boolean): Promise<SnapshotOut[]> {
  const rows = await dbAll(`SELECT * FROM mobile_snapshots WHERE profile_id = ? AND ready = 1 AND deleted_at IS ${trash ? 'NOT ' : ''}NULL
    ORDER BY id DESC LIMIT 1000`, [p.id]);
  return rows.map(snapOut);
}

// Kayıt: önce hazır değil (ready = 0) yazılır, nesne listesi diske (fsync), sonra hazır. Yarıda kalırsa listede görünmez;
// temizlik bir gün sonra siler.
let saving = 0;
let gcRun: Promise<void> | null = null;
export async function createSnapshot(p: ProfileRow, dev: StoreDevice, body: any): Promise<{ id: number }> {
  const manifest = validObjectId(body?.manifest) ? body.manifest : '';
  if (!manifest) throw httpError(400, 'Geçersiz içerik listesi');
  const raw: unknown[] | null = Array.isArray(body?.objects) ? body.objects : null;
  if (!raw || raw.length > MAX_SNAPSHOT_OBJECTS || !raw.every(validObjectId)) throw httpError(400, 'Geçersiz nesne listesi');
  const ids = [...new Set([...(raw as string[]), manifest])];
  saving++;
  try {
    if (gcRun) await gcRun.catch(() => {});
    let present = 0;
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const r = await dbGet(`SELECT COUNT(*) AS n FROM mobile_objects WHERE profile_id = ? AND done = 1 AND id IN (${qs(part.length)})`, [p.id, ...part]);
      present += Number(r?.n) || 0;
    }
    if (present !== ids.length) throw httpError(409, `Yedekteki ${ids.length - present} dosya Pi'de eksik — yedekleme yeniden denenecek`);
    const stats = cleanStats(body?.stats);
    const { dir } = place(p);
    const id = await dbInsert(`INSERT INTO mobile_snapshots (profile_id, device_id, device_name, created_at, manifest, stats, bytes, ready)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`, [p.id, dev.id, dev.name, now(), manifest, JSON.stringify(stats), stats.bytes]);
    const file = snapPath(dir, id);
    try {
      const buf = Buffer.alloc(ids.length * 32);
      ids.forEach((h, i) => buf.write(h, i * 32, 32, 'hex'));
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const fh = await fs.promises.open(file, 'w', 0o600);
      try {
        await fh.writeFile(buf);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await dbRun('UPDATE mobile_snapshots SET ready = 1 WHERE id = ?', [id]);
    } catch (e) {
      await fs.promises.rm(file, { force: true }).catch(() => {});
      await dbRun('DELETE FROM mobile_snapshots WHERE id = ?', [id]).catch(() => {});
      throw e;
    }
    return { id };
  } finally {
    saving--;
  }
}
const snapId = (raw: string): number => {
  const n = Number(raw);
  if (!/^\d{1,12}$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) throw httpError(400, 'Geçersiz yedek');
  return n;
};
export async function trashSnapshot(p: ProfileRow, dev: StoreDevice, raw: string): Promise<void> {
  const n = await dbRunChanges('UPDATE mobile_snapshots SET deleted_at = ? WHERE id = ? AND profile_id = ? AND ready = 1 AND deleted_at IS NULL',
    [now(), snapId(raw), p.id]);
  if (!n) throw httpError(404, 'Yedek bulunamadı');
  await recordEvent('sync', `Telefon yedeği çöpe taşındı: ${p.name} (${dev.name}) — ${TRASH_DAYS} gün içinde uygulamadan geri alınabilir`);
}
export async function untrashSnapshot(p: ProfileRow, raw: string): Promise<void> {
  const n = await dbRunChanges('UPDATE mobile_snapshots SET deleted_at = NULL WHERE id = ? AND profile_id = ? AND ready = 1 AND deleted_at IS NOT NULL',
    [snapId(raw), p.id]);
  if (!n) throw httpError(404, 'Çöpte böyle bir yedek yok');
}
export async function usage(p: ProfileRow): Promise<{ bytes: number; objects: number; free: number | null; size: number | null; target: string; mounted: boolean }> {
  const r = await dbGet('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM mobile_objects WHERE profile_id = ? AND done = 1', [p.id]);
  const t = listTargets().find(x => x.key === p.target);
  return { bytes: Number(r?.b) || 0, objects: Number(r?.n) || 0, free: t?.free ?? null, size: t?.size ?? null, target: t ? targetLabel(t) : p.target, mounted: !!t?.mounted };
}

// ── temizlik ────────────────────────────────────────────────────────────────
// Diski bağlı her kişide: 1) çöpte 30 günü dolan, kaydı yarıda kalan ve seyreltmede düşen anlık görüntüler; 2) hiçbir anlık
// görüntünün (çöptekiler dahil) kullanmadığı ve 30 gündür dokunulmayan nesneler. Bir anlık görüntünün listesi okunamazsa o
// kişide nesne silinmez. Disk bağlı değilse kişiye dokunulmaz. Anlık görüntü kaydedilirken çalışmaz.
const dayKey = (t: Date) => `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
const weekKey = (t: Date) => String(Math.floor((t.getTime() - t.getTimezoneOffset() * 60_000 - 4 * DAY) / (7 * DAY))); // pazartesi başlar
const monthKey = (t: Date) => `${t.getFullYear()}-${t.getMonth()}`;
// Seyreltmede düşecekler (cihaz başına): en yenisi hep kalır; son 14 günde günün, son 8 haftada haftanın, son 12 ayda ayın en yenisi
export function thinOut(rows: { id: number; device_id: number; created_at: string }[], at = Date.now()): number[] {
  const out: number[] = [];
  const byDev = new Map<number, { id: number; created_at: string }[]>();
  for (const r of rows) byDev.set(r.device_id, [...(byDev.get(r.device_id) || []), r]);
  for (const list of byDev.values()) {
    list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
    const seen = { d: new Set<string>(), w: new Set<string>(), m: new Set<string>() };
    list.forEach((r, i) => {
      const t = new Date(r.created_at);
      const age = at - t.getTime();
      let keep = i === 0;
      if (age < KEEP.days * DAY && !seen.d.has(dayKey(t))) { seen.d.add(dayKey(t)); keep = true; }
      if (age < KEEP.weeks * 7 * DAY && !seen.w.has(weekKey(t))) { seen.w.add(weekKey(t)); keep = true; }
      if (age < KEEP.months * 31 * DAY && !seen.m.has(monthKey(t))) { seen.m.add(monthKey(t)); keep = true; }
      if (!keep) out.push(r.id);
    });
  }
  return out;
}
export function storeGc(): Promise<void> {
  if (gcRun) return gcRun;
  if (saving > 0) return Promise.resolve();
  gcRun = (async () => {
    for (const p of await dbAll('SELECT * FROM mobile_profiles') as ProfileRow[]) {
      let dir: string;
      try { dir = place(p).dir; } catch { continue; }
      const snaps = await dbAll('SELECT id, device_id, created_at, deleted_at, ready FROM mobile_snapshots WHERE profile_id = ?', [p.id]) as
        { id: number; device_id: number; created_at: string; deleted_at: string | null; ready: number }[];
      const drop = new Set<number>([
        ...snaps.filter(s => (s.deleted_at && s.deleted_at < ago(TRASH_DAYS * DAY)) || (!s.ready && s.created_at < ago(DAY))).map(s => s.id),
        ...thinOut(snaps.filter(s => s.ready && !s.deleted_at)),
      ]);
      for (const id of drop) {
        await dbRun('DELETE FROM mobile_snapshots WHERE id = ?', [id]);
        await fs.promises.rm(snapPath(dir, id), { force: true });
      }
      const used = new Set<string>();
      let readable = true;
      for (const s of snaps) {
        if (drop.has(s.id) || !s.ready) continue;
        try {
          const b = await fs.promises.readFile(snapPath(dir, s.id));
          if (b.length % 32) throw new Error('liste bozuk');
          for (let i = 0; i < b.length; i += 32) used.add(b.toString('hex', i, i + 32));
        } catch (e: any) {
          readable = false;
          console.error(`[mobil-yedek] temizlik: ${p.name} kişisinin ${s.id} numaralı yedeğinin listesi okunamadı:`, e?.message || e);
          break;
        }
      }
      if (!readable) continue;
      const old = await dbAll('SELECT id FROM mobile_objects WHERE profile_id = ? AND touched_at < ?', [p.id, ago(ORPHAN_DAYS * DAY)]) as { id: string }[];
      const gone = old.map(r => r.id).filter(id => !used.has(id) && !busy.has(`u:${p.id}:${id}`));
      for (let i = 0; i < gone.length; i += 400) {
        const part = gone.slice(i, i + 400);
        for (const id of part) {
          const f = objPath(dir, id);
          await fs.promises.rm(f, { force: true });
          await fs.promises.rm(`${f}.part`, { force: true });
        }
        await dbRun(`DELETE FROM mobile_objects WHERE profile_id = ? AND id IN (${qs(part.length)})`, [p.id, ...part]);
      }
    }
  })().finally(() => { gcRun = null; });
  return gcRun;
}

// ── panel ───────────────────────────────────────────────────────────────────
export async function listProfiles(): Promise<ProfileSummary[]> {
  const profiles = await dbAll('SELECT * FROM mobile_profiles ORDER BY created_at') as ProfileRow[];
  if (!profiles.length) return [];
  const devs = await dbAll("SELECT id, name, platform, created_at, last_seen, profile_id FROM mobile_devices WHERE profile_id != '' ORDER BY id");
  const snaps = await dbAll(`SELECT profile_id, SUM(deleted_at IS NULL) AS live, SUM(deleted_at IS NOT NULL) AS trash,
    MAX(CASE WHEN deleted_at IS NULL THEN created_at END) AS last FROM mobile_snapshots WHERE ready = 1 GROUP BY profile_id`);
  const objs = await dbAll('SELECT profile_id, COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM mobile_objects WHERE done = 1 GROUP BY profile_id');
  const targets = listTargets();
  return profiles.map(p => {
    const t = targets.find(x => x.key === p.target);
    const s = snaps.find(x => x.profile_id === p.id);
    const o = objs.find(x => x.profile_id === p.id);
    return {
      id: p.id, name: p.name, target: p.target, targetLabel: t ? targetLabel(t) : p.target, problem: storeProblem(t), keySet: !!p.key_check,
      createdAt: p.created_at,
      devices: devs.filter(d => d.profile_id === p.id).map(({ profile_id: _p, ...d }) => d),
      snapshots: Number(s?.live) || 0, trash: Number(s?.trash) || 0, lastBackup: s?.last || null,
      bytes: Number(o?.b) || 0, objects: Number(o?.n) || 0,
    };
  });
}
// Kişiyi kaldırır: cihazlarının anahtarları geçersiz, kayıtlar silinir; disk bağlıysa şifreli yedekleri de silinir.
// Disk bağlı değilse dosyalar diskte kalır (anahtar olmadan okunamaz) — kaldırma yine yapılır, panel bunu söyler.
export async function removeProfile(raw: unknown): Promise<{ name: string; filesKept: boolean }> {
  const id = typeof raw === 'string' && PROFILE_RE.test(raw) ? raw : '';
  const p = id ? await getProfile(id) : undefined;
  if (!p) throw new Error('Kişi bulunamadı');
  abortStore({ profile: p.id });
  let dir: string | null = null;
  try { dir = place(p).dir; } catch { dir = null; }
  await dbRun('DELETE FROM mobile_devices WHERE profile_id = ?', [p.id]);
  await dbRun('DELETE FROM mobile_snapshots WHERE profile_id = ?', [p.id]);
  await dbRun('DELETE FROM mobile_objects WHERE profile_id = ?', [p.id]);
  await dbRun('DELETE FROM mobile_profiles WHERE id = ?', [p.id]);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  await recordEvent('sync', `Klyrix/Gate Sync kişisi kaldırıldı: ${p.name}${dir ? ' (şifreli yedekleri silindi)' : ' (disk bağlı değildi: şifreli dosyaları diskte kaldı)'}`);
  return { name: p.name, filesKept: !dir };
}

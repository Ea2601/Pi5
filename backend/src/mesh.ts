// Mesh (R2): ana cihaz ↔ uydular. Uydu ana cihazın ev Wi-Fi'ını (ağ adı, parola, bant) aynı ayarla, farklı kanalda
// yayınlar; kablosuz mesh (802.11s, scripts/mesh.sh) açıksa omurga ayarını da alır.
//  - Ana cihaz: "Uydu ekle" 6 haneli kod üretir (10 dk, tek kullanımlık, 5 hatalı denemede geçersiz). Uydu kodla
//    /api/mesh/pair'e gelir, uyduya özel uzun rastgele anahtar alır (ana cihazda yalnız SHA-256'sı saklanır). Uydu her
//    dakika /api/mesh/sync ile durumunu bildirir ve güncel ayarı alır. Bu iki uç panel şifresinden muaftır (auth.ts,
//    panel-auth.sh): kimliği kod / anahtar kanıtlar. Wi-Fi parolası yalnız eşleşmiş uyduya gider, günlüğe yazılmaz.
//  - Kanal v2 (yeni eşleşmeler): eşleşmede X25519 ile uyduya özel anahtar türetilir; ayar ve durum AES-256-GCM zarfında
//    gider (parolalar ağda açık metin değil), eşleşmeden sonra ana cihaz da kimliğini kanıtlar — uyduyu yalnız ana
//    cihazın anahtarıyla imzalı "kaldırıldı" yanıtı kapatır. Eşleşmenin kendisi ilk kullanımda güvendir (pairSatellite).
//    Eski (v1) eşleşmeler ve eski sürümlü cihazlar taşıyıcı anahtarla aynen çalışır.
//  - Uydu: eşleşme bilgisi /etc/pi5-gateway/mesh/satellite.json (0600). Ayar değişince net-mode.sh sat on / apply;
//    ilk açılış denemedir: köprü üzerinden ana cihaza yeniden ulaşınca "sat confirm", ulaşamazsa geri alınır.
//  - Keşif: her cihaz mDNS'te _klyrix-gate._tcp duyurur, GET /api/mesh/pair kimlik yanıtı verir; ağ geçidi + mDNS
//    adayları yalnız adres önerir (kod şart). v2 uydu, ana cihazın adresi değişirse onu kimliğiyle yeniden bulur.
//  - Uzaktan güncelleme (yalnız v2): ana cihaz isteği uyduya özel zarfın içinde gönderir; uydu güncellemeyi kendi
//    güncelleme yoluyla (update.ts → GitHub) başlatır — ana cihaz kod göndermez, yalnız "şimdi" der.
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { db, dbAll, dbGet, dbRun } from './db';
import { readHomeStations } from './homeWifi';
import { recordEvent, recordEventOnce } from './events';
import { getLanIdentity } from './system';
import { readDefaultRoute } from './topology';
import { getUpdateStatus, startUpdate, STORAGE_BUSY_MSG, UPDATE_MAX_RUNTIME_S, type UpdateStatus } from './update';

export const NET_MODE_SCRIPT = '/opt/pi5-gateway/scripts/net-mode.sh';
export const MESH_SCRIPT = '/opt/pi5-gateway/scripts/mesh.sh';
const MESH_DIR = '/etc/pi5-gateway/mesh';
const SAT_FILE = `${MESH_DIR}/satellite.json`;
const WPA_CONF = `${MESH_DIR}/wpa-mesh.conf`;
const BRIDGE = 'br0';
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_MAX_FAILS = 5;
export const SYNC_INTERVAL_MS = 60 * 1000;
export const OFFLINE_AFTER_S = 180;
const SAT_TRIAL_S = 180;
// Uzaktan güncelleme: istek kimliği (nonce) 32 hex; yanıtlanmayan istek 24 saatte silinir; uydu 10 dakikada en çok bir
// kez güncelleme başlatır (istek ne kadar gelirse gelsin).
const NONCE_RE = /^[0-9a-f]{32}$/;
export const UPDATE_REQ_TTL_S = 24 * 3600;
export const UPDATE_MIN_GAP_S = 10 * 60;

export type WifiConfig = { ssid: string; psk: string; band: 'bg' | 'a'; channel: number };
export type MeshConfig = { id: string; psk: string; channel: number };
export type SatConfig = { rev: string; wifi: WifiConfig | null; mesh: MeshConfig | null };
type KvResult = { code: number | null; kv: Record<string, string> };

// ─── Saf yardımcılar ───

const CH_24 = [1, 6, 11];
const CH_5 = [36, 40, 44, 48];
// Uydu kanalı: ana cihazın kanalı dışındaki örtüşmeyen kanallar sırayla (uydu sırası = eşleşme sırası).
export function planChannel(band: 'bg' | 'a', mainChannel: number, index: number): number {
  const pool = (band === 'a' ? CH_5 : CH_24).filter(c => c !== mainChannel);
  return pool[((index % pool.length) + pool.length) % pool.length];
}
export function configRev(wifi: WifiConfig | null, mesh: MeshConfig | null): string {
  return crypto.createHash('sha256').update(JSON.stringify({ wifi, mesh })).digest('hex').slice(0, 16);
}
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export const validMainAddr = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9.-]{1,63}(:\d{1,5})?$/.test(s);
export const validSatId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/.test(s);
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const cleanName = (s: unknown) => String(s || '').replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'uydu';

// ─── Kanal v2: X25519 + HKDF-SHA256 + AES-256-GCM (Node yerleşik crypto) ───
// Eşleşmede iki taraf da tek seferlik X25519 anahtarı üretir (açık anahtar: ham 32 bayt, base64url = JWK x); ortak sır
// HKDF ile uyduya özel K'ye çevrilir (tuz "uyduKimliği|anaCihazKimliği"). Zarf {iv, ct}: 12 bayt rastgele iv, ct =
// şifreli metin + 16 bayt etiket. AAD isteğin türünü, uyduyu ve sıra numarasını bağlar; açılamayan zarf hata fırlatır.
export type Box = { iv: string; ct: string };
const MESH_V2_INFO = 'klyrix-mesh-v2';
export const validPub = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
export function x25519Pair(): { privateKey: crypto.KeyObject; pub: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, pub: String(publicKey.export({ format: 'jwk' }).x) };
}
export function deriveKey(privateKey: crypto.KeyObject, peerPub: string, satId: string, mainId: string): Buffer {
  if (!validPub(peerPub)) throw new Error('geçersiz açık anahtar');
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peerPub }, format: 'jwk' });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  if (shared.length !== 32 || shared.every(b => b === 0)) throw new Error('geçersiz ortak sır');
  return Buffer.from(crypto.hkdfSync('sha256', shared, `${satId}|${mainId}`, MESH_V2_INFO, 32));
}
// Katı base64: yeniden kodlanınca aynı metin çıkmalı (fazladan / eksik karakter kabul edilmez).
function b64(s: unknown, min: number, max: number): Buffer {
  if (typeof s !== 'string' || s.length > max * 2) throw new Error('zarf biçimi geçersiz');
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64') !== s || b.length < min || b.length > max) throw new Error('zarf biçimi geçersiz');
  return b;
}
export function seal(key: Buffer, aad: string, obj: unknown): Box {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}
export function open(key: Buffer, aad: string, box: unknown): any {
  if (key.length !== 32 || !box || typeof box !== 'object') throw new Error('zarf yok');
  const iv = b64((box as Box).iv, 12, 12);
  const ct = b64((box as Box).ct, 16, 1024 * 1024);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const obj = JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('zarf içeriği geçersiz');
  return obj;
}

// ─── Kök betik çalıştırıcısı (key=value; parola yalnız stdin'den) ───

export function runKv(script: string, args: string[], timeoutMs: number, input = ''): Promise<KvResult> {
  return new Promise(resolve => {
    if (!fs.existsSync(script)) return resolve({ code: -1, kv: { error: `${script.split('/').pop()} bulunamadı` } });
    const child = spawn('bash', [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => resolve({ code: null, kv: { error: `${script.split('/').pop()} ${args[0] || ''} zaman aşımı` } }), timeoutMs);
    child.stdout.on('data', d => { if (out.length < 16384) out += d; });
    child.stderr.on('data', () => { /* ayrıntı stdout'taki error=/detail= satırlarında */ });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, kv: { error: 'çalıştırılamadı' } }); });
    child.on('close', code => {
      clearTimeout(timer);
      const kv: Record<string, string> = {};
      for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
      resolve({ code, kv });
    });
    child.stdin.on('error', () => { /* betik stdin'i okumadan çıktı */ });
    child.stdin.end(input);
  });
}
const kvErr = (r: KvResult, fb: string) => [r.kv.error || fb, r.kv.detail].filter(Boolean).join(' — ');

// ─── Ana cihaz ───

// v2 sütunları: proto (1 = taşıyıcı anahtar, 2 = şifreli kanal), last_seq (tekrar koruması), revoked_at (v2 mezar taşı:
// kaldırılan uydu bir sonraki senkronda imzalı "kaldırıldı" yanıtını alabilsin diye anahtar 30 gün tutulur), update_req
// (bekleyen güncelleme isteği, JSON {nonce, at}; uydu aldığını bildirince ya da 24 saatte silinir).
let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  tablesReady ??= (async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS mesh_satellites (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mac TEXT, token_hash TEXT NOT NULL, ip TEXT, last_seen INTEGER,
      status TEXT, created_at INTEGER NOT NULL)`);
    const cols = new Set((await dbAll('PRAGMA table_info(mesh_satellites)')).map((c: any) => c.name));
    if (!cols.has('proto')) await dbRun('ALTER TABLE mesh_satellites ADD COLUMN proto INTEGER DEFAULT 1');
    if (!cols.has('last_seq')) await dbRun('ALTER TABLE mesh_satellites ADD COLUMN last_seq INTEGER DEFAULT 0');
    if (!cols.has('revoked_at')) await dbRun('ALTER TABLE mesh_satellites ADD COLUMN revoked_at INTEGER');
    if (!cols.has('update_req')) await dbRun('ALTER TABLE mesh_satellites ADD COLUMN update_req TEXT');
  })().catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}
// Etkilenen satır sayısı (koşullu güncelleme / silme: tekrar koruması ve mezar taşı temizliği yarışsız olsun).
const dbChanges = (sql: string, params: any[]) => new Promise<number>((resolve, reject) => {
  db.run(sql, params, function (this: { changes: number }, err: Error | null) { if (err) reject(err); else resolve(this.changes); });
});

// Uyduya özel v2 anahtarı (ana cihaz): /etc/pi5-gateway/mesh/peers/<uydu>.key (dizin 0700, dosya 0600; SQLite'ta
// değil — veritabanı harici diske taşınabilir, yedeğe de girmez).
const PEERS_DIR = `${MESH_DIR}/peers`;
const peerKeyFile = (id: string) => `${PEERS_DIR}/${id}.key`;
// Anahtar / durum dosyası: tmp + fsync + rename + dizin fsync — elektrik kesilince boş ya da eski dosya kalmasın (ext4
// gecikmeli ayırma yeni adla yazılan dosyayı korumaz).
function writeFileDurable(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(file.slice(0, file.lastIndexOf('/')) || '/', 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* dizin fsync desteklenmiyor */ }
}
function writePeerKey(id: string, key: Buffer) {
  fs.mkdirSync(PEERS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(PEERS_DIR, 0o700);
  writeFileDurable(peerKeyFile(id), `${key.toString('hex')}\n`);
}
function readPeerKey(id: string): Buffer | null {
  try { const h = fs.readFileSync(peerKeyFile(id), 'utf8').trim(); return /^[0-9a-f]{64}$/.test(h) ? Buffer.from(h, 'hex') : null; } catch { return null; }
}
function removePeerKey(id: string) { try { fs.unlinkSync(peerKeyFile(id)); } catch { /* yok */ } }
// v2 satırı anahtarına bağlıdır: token_hash = sha256('klyrix-mesh-v2|<anahtar hex>'). Veritabanı anahtar dizininden geri
// kalırsa (veri diski yokken SD'deki anlık görüntüyle açılış, storage.sh) eski satır sonraki bir eşleşmenin anahtarıyla
// eşleşmez: o anahtarla "kaldırıldı" imzalanmaz, temizlik o anahtarı silmez. v1 Bearer bu özete hiç eşleşemez (jeton 64 hex).
const keyFp = (key: Buffer) => sha256(`${MESH_V2_INFO}|${key.toString('hex')}`);
const keyMatches = (key: Buffer | null, tokenHash: unknown): key is Buffer => !!key && typeof tokenHash === 'string' && safeEqualHex(keyFp(key), tokenHash);
// Rol uyduya dönerken (index.ts): geride yalnız mezar taşı anahtarları kalabilir.
export function removePeerKeys() { fs.rmSync(PEERS_DIR, { recursive: true, force: true }); }

type Pairing = { codeHash: string; expires: number; fails: number };
let pairing: Pairing | null = null;

async function mainWifi(): Promise<WifiConfig | null> {
  const r = await runKv(NET_MODE_SCRIPT, ['home', 'secret'], 15000);
  if (r.code !== 0 || !r.kv.ssid || !r.kv.psk) return null;
  const channel = Number(r.kv.channel) || (r.kv.band === 'a' ? 36 : 6);
  return { ssid: r.kv.ssid, psk: r.kv.psk, band: r.kv.band === 'a' ? 'a' : 'bg', channel };
}
// mesh.sh status. null = durum BİLİNMİYOR (betik yok / güncellemede değişiyor, zaman aşımı, çalıştırılamadı, sıfır
// olmayan çıkış, "configured=" satırı yok). Bilinmeyen durum "mesh kapalı" sayılmaz: ana cihaz uyduya mesh:null
// göndermez (uydu omurgasını kapatır, kablosuz bağlı uydu bir daha ulaşamazdı), uydu mesh'ine dokunmaz.
async function meshStatus(): Promise<Record<string, string> | null> {
  const r = await runKv(MESH_SCRIPT, ['status'], 15000);
  return r.code === 0 && 'configured' in r.kv ? r.kv : null;
}
function readMeshPsk(): string | null {
  try { return /^\s*psk="([^"\\]{8,63})"/m.exec(fs.readFileSync(WPA_CONF, 'utf8'))?.[1] || null; } catch { return null; }
}
const MESH_UNKNOWN = 'Kablosuz mesh durumu okunamadı';
// null = mesh kapalı (durum okundu: ayarlı değil ya da bu cihaz mesh'te ana cihaz değil). Durum okunamadıysa ya da
// ayarlı görünüp ağ adı / parola / kanal okunamıyorsa 503: uydu yalnız hata görür, mevcut mesh'iyle devam eder.
async function mainMesh(): Promise<MeshConfig | null> {
  const st = await meshStatus();
  if (!st) throw new MeshError(503, MESH_UNKNOWN);
  if (st.configured !== '1' || st.role !== 'main') return null;
  const psk = readMeshPsk();
  const channel = Number(st.channel);
  if (!psk || !st.id || !channel) throw new MeshError(503, MESH_UNKNOWN);
  return { id: st.id, psk, channel };
}

// Uydunun ayarı: ev Wi-Fi'ı (kanal uyduya göre planlanır) + kablosuz mesh omurgası. İki adım: ana cihazın durumu
// (betikler; mesh bilinmiyorsa 503) ve kanal planı (veritabanı) — eşleşme durumu kod harcanmadan ÖNCE okur.
type MainParts = { wifi0: WifiConfig | null; mesh: MeshConfig | null };
async function mainParts(): Promise<MainParts> {
  const [wifi0, mesh] = await Promise.all([mainWifi(), mainMesh()]);
  return { wifi0, mesh };
}
async function planConfig(satId: string, { wifi0, mesh }: MainParts): Promise<SatConfig> {
  let wifi: WifiConfig | null = null;
  if (wifi0) {
    const rows = await dbAll('SELECT id FROM mesh_satellites WHERE revoked_at IS NULL ORDER BY created_at, id');
    const idx = Math.max(0, rows.findIndex((r: any) => r.id === satId));
    wifi = { ...wifi0, channel: planChannel(wifi0.band, wifi0.channel, idx) };
  }
  return { rev: configRev(wifi, mesh), wifi, mesh };
}
async function configFor(satId: string): Promise<SatConfig> {
  return planConfig(satId, await mainParts());
}

export async function createPairing(): Promise<{ code: string; expires_at: number }> {
  if (!(await mainWifi())) throw new MeshError(409, "Önce bu cihazda ev Wi-Fi'ını açıp kalıcı yapın — uydular onun ağ adını ve şifresini yayınlar");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pairing = { codeHash: sha256(code), expires: Date.now() + PAIR_TTL_MS, fails: 0 };
  return { code, expires_at: Math.floor(pairing.expires / 1000) };
}
export function cancelPairing() { pairing = null; }
export function pairingState() {
  if (pairing && pairing.expires <= Date.now()) pairing = null;
  return pairing ? { active: true, expires_at: Math.floor(pairing.expires / 1000) } : null;
}

export class MeshError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// Uydunun eşleşme isteği (kimlik kodla kanıtlanır). proto 2 + açık anahtar gelirse şifreli kanal (v2): ana cihaz da tek
// seferlik anahtar üretir, uyduya özel anahtarı peers/ altına yazar, ayarı o anahtarla şifreli döner (taşıyıcı anahtar
// verilmez). Gelmezse (eski uydu) eski yanıt: taşıyıcı anahtar + düz ayar (+ main_id).
// Güven sınırı (ilk kullanımda güven): kod ve açık anahtarlar ağda açık gider, ana cihaz kodu bildiğini kanıtlamaz. 10
// dakikalık kod penceresinde araya giren etkin biri iki taraftan birini taklit edebilir ya da proto/pub'ı silip v1'e
// düşürebilir. Kimlik doğrulaması eşleşmeden SONRAKİ senkronlar içindir; ilk eşleştirmeyi aynı ağ kesiminde, kabloyla
// yapın. Düşürme iki panelde de görünür (Eşleşme: Şifreli / Eski eşleşme).
type PairV1 = { token: string; config: SatConfig; main_id?: string };
type PairV2 = { proto: 2; main_id: string; pub: string; box: Box };
export async function pairSatellite(body: any, ip: string): Promise<PairV1 | PairV2> {
  await ensureTables();
  const p = pairingState() ? pairing : null;
  if (!p) throw new MeshError(403, 'Etkin eşleştirme kodu yok — ana cihazda Cihaz Rolleri → Uydular → Uydu ekle');
  const code = String(body?.code || '');
  if (!/^\d{6}$/.test(code) || !safeEqualHex(sha256(code), p.codeHash)) {
    p.fails++;
    if (p.fails >= PAIR_MAX_FAILS) { pairing = null; throw new MeshError(403, 'Çok fazla hatalı deneme — ana cihazda yeni kod alın'); }
    throw new MeshError(403, 'Eşleştirme kodu yanlış');
  }
  if (!validSatId(body?.id)) throw new MeshError(400, 'Geçersiz uydu kimliği');
  let v2: { mainId: string; pub: string; key: Buffer } | null = null;
  if (body?.proto === 2 && validPub(body?.pub)) {
    let mainId: string;
    try { mainId = deviceId(); } catch { throw new MeshError(500, 'Cihaz kimliği okunamadı (/etc/pi5-gateway/mesh/id)'); }
    const eph = x25519Pair();
    try { v2 = { mainId, pub: eph.pub, key: deriveKey(eph.privateKey, body.pub, body.id, mainId) }; } catch { throw new MeshError(400, 'Geçersiz uydu anahtarı'); }
  }
  // Ana cihazın durumu kod harcanmadan, satır / anahtar yazılmadan ÖNCE: mesh durumu okunamazsa (503) kod geçerli kalır,
  // yarım eşleşme kalmaz — uydu aynı kodla yeniden dener.
  const parts = await mainParts();
  // Beklerken aynı kodla gelen başka bir istek kodu harcadıysa (ya da kod iptal edildi / yenilendi / süresi doldu) ikinci
  // eşleşme olmaz: kod yine tek kullanımlık.
  if (pairing !== p || p.expires <= Date.now()) throw new MeshError(403, 'Etkin eşleştirme kodu yok — ana cihazda Cihaz Rolleri → Uydular → Uydu ekle');
  pairing = null; // tek kullanımlık
  // v2'de taşıyıcı anahtar uyduya verilmez: sütuna anahtarın özeti (keyFp) yazılır — Bearer hiç eşleşmez.
  const token = crypto.randomBytes(32).toString('hex');
  const mac = typeof body?.mac === 'string' && MAC_RE.test(body.mac.toLowerCase()) ? body.mac.toLowerCase() : null;
  const name = cleanName(body?.name);
  const now = Math.floor(Date.now() / 1000);
  if (v2) writePeerKey(body.id, v2.key); else removePeerKey(body.id); // v1'e dönen uydunun eski v2 anahtarı kalmasın
  // Yeniden eşleşmede önceki eşleşmenin bekleyen güncelleme isteği (update_req) taşınmaz.
  await dbRun(`INSERT INTO mesh_satellites (id, name, mac, token_hash, ip, last_seen, status, created_at, proto, last_seq, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, mac = excluded.mac, token_hash = excluded.token_hash, ip = excluded.ip, last_seen = excluded.last_seen,
      proto = excluded.proto, last_seq = 0, revoked_at = NULL, update_req = NULL`,
  [body.id, name, mac, v2 ? keyFp(v2.key) : sha256(token), ip, now, now, v2 ? 2 : 1]);
  await recordEvent('mesh', `Uydu eklendi: ${name} (${ip})`);
  const config = await planConfig(body.id, parts); // kanal planı satır yazıldıktan sonra (yeni uydu sırada sonda)
  if (v2) return { proto: 2, main_id: v2.mainId, pub: v2.pub, box: seal(v2.key, `pair|${body.id}`, { config }) };
  let mainId = '';
  try { mainId = deviceId(); } catch { /* kimlik yazılamadı: eski yanıt aynen */ }
  return { token, config, ...(mainId ? { main_id: mainId } : {}) };
}

// Uydunun güncelleme durumu (bildirimde; günlük metni yok): running / done / failed + kısa neden + zaman (sn). req: bu iş
// ana cihazın son isteğinin işi (uydu başlattı ya da istek geldiğinde zaten sürüyordu) — gece güncellemesi değil.
export type UpdateState = { state: 'running' | 'done' | 'failed'; reason: string; at: number; req?: true };
const updateStateOf = (u: any): UpdateState | null => (u && typeof u === 'object' && (u.state === 'running' || u.state === 'done' || u.state === 'failed')
  ? { state: u.state, reason: String(u.reason || '').replace(/\s+/g, ' ').trim().slice(0, 80), at: Number.isSafeInteger(u.at) && u.at > 0 ? u.at : 0,
    ...(u.req === true ? { req: true as const } : {}) }
  : null);
const satStatusOf = (raw: any) => {
  const st = raw && typeof raw === 'object' ? raw : {};
  return {
    name: cleanName(st.name), version: String(st.version || '').slice(0, 20), sat_stage: String(st.sat_stage || '').slice(0, 10),
    active: !!st.active, bridge: !!st.bridge, band: st.band === 'a' ? 'a' : 'bg', channel: Number(st.channel) || null,
    backhaul: st.backhaul === 'mesh' ? 'mesh' : 'wired', mesh_peers: Number(st.mesh_peers) || 0,
    stations: Array.isArray(st.stations) ? st.stations.map((m: any) => String(m).toLowerCase()).filter((m: string) => MAC_RE.test(m)).slice(0, 256) : [],
    error: String(st.error || '').slice(0, 200),
    // Uzaktan güncelleme: update_cap (uydunun yazılımı isteği anlıyor; eski sürüm alanı hiç göndermez), son alınan istek ve
    // öncekiler (ana cihaz bunlarla isteği kapatır), güncelleme durumu, yeni isteğin en erken kabulüne kalan süre (sn;
    // uydunun 10 dk sınırı — panel düğmeyi o zamana dek kapatır, bildirim anına göre: last_seen + update_retry_in).
    update_cap: st.update_cap === 1,
    update_nonce: typeof st.update_nonce === 'string' && NONCE_RE.test(st.update_nonce) ? st.update_nonce : '',
    update_seen: Array.isArray(st.update_seen) ? st.update_seen.filter((n: unknown): n is string => typeof n === 'string' && NONCE_RE.test(n)).slice(0, 8) : [],
    update_state: updateStateOf(st.update_state),
    update_retry_in: Number.isSafeInteger(st.update_retry_in) && st.update_retry_in > 0 ? Math.min(st.update_retry_in, UPDATE_MIN_GAP_S) : 0,
  };
};

// ─── Uzaktan güncelleme (ana cihaz) ───
// İstek yalnız şifreli (v2) eşleşmeye: nonce uyduya özel zarfın içinde gider (sahte ya da araya giren bir yanıt uyduya
// güncelleme başlatamaz). v1 eşleşmeye istek yazılmaz, v1 yanıtında hiç yoktur. Uydu güncellemeyi kendi yoluyla GitHub'dan
// indirir (gece güncellemesinin aynısı); istek ancak "ne zaman"ı belirler.
type UpdateReq = { nonce: string; at: number };
function parseUpdateReq(raw: unknown): UpdateReq | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && NONCE_RE.test(o.nonce) && Number.isSafeInteger(o.at) ? { nonce: o.nonce, at: o.at } : null;
  } catch { return null; }
}
// Saat geri giderse (ileri tarihli istek) de 24 saat sınırı geçerli: istek süresiz kalmaz.
const updateReqExpired = (r: UpdateReq, now: number) => now - r.at >= UPDATE_REQ_TTL_S || r.at - now > UPDATE_REQ_TTL_S;
// Koşullu silme (satır o arada değişmediyse) + olay: aynı istek için tek kayıt.
async function clearUpdateReq(id: string, raw: string, event: string, severity: 'info' | 'warning' = 'info'): Promise<boolean> {
  if (!(await dbChanges('UPDATE mesh_satellites SET update_req = NULL WHERE id = ? AND update_req = ?', [id, raw]))) return false;
  if (event) await recordEvent('mesh', event, severity);
  return true;
}
const expiredText = (name: string) => `Uydu güncelleme isteği 24 saatte yanıtlanmadı: ${name} — istek silindi`;
// Kullanıcı isteği (panel): bekleyen istek varken aynısını döner (çift tıklama, iki sekme yeni istek açmaz). Uydunun son
// bildirimi isteği anladığını söylemiyorsa (bu özellikten önceki sürüm) istek yazılmaz: alan yok sayılır, istek 24 saat
// "gönderildi" görünür, uydu gece kendini güncelleyince de bekleyen istekle ikinci kez güncellenirdi.
export async function requestSatelliteUpdate(id: string): Promise<{ nonce: string; at: number; already: boolean }> {
  await ensureTables();
  const sel = () => dbGet('SELECT name, proto, status, update_req FROM mesh_satellites WHERE id = ? AND revoked_at IS NULL', [id]);
  const row = await sel();
  if (!row) throw new MeshError(404, 'Uydu bulunamadı (kaldırılmış olabilir)');
  if (row.proto !== 2) throw new MeshError(409, 'Eski eşleşme: güncelleme isteği yalnız şifreli kanalda — uyduyu yeniden eşleştirin');
  let cap = false;
  try { cap = JSON.parse(row.status || 'null')?.update_cap === true; } catch { /* durum yok / bozuk */ }
  if (!cap) {
    throw new MeshError(409, "Uydunun yazılımı uzaktan güncellemeyi desteklemiyor (bu özellikten eski sürüm) — uydunun kendi panelinden (Ayarlar → Sistem Güncellemesi) güncelleyin; gece güncellemesi de getirir");
  }
  const now = Math.floor(Date.now() / 1000);
  const raw: string | null = typeof row.update_req === 'string' && row.update_req ? row.update_req : null;
  const cur = parseUpdateReq(raw);
  if (cur && !updateReqExpired(cur, now)) return { ...cur, already: true };
  if (raw) await clearUpdateReq(id, raw, cur ? expiredText(row.name) : '', 'warning'); // süresi geçmiş / bozuk
  const req: UpdateReq = { nonce: crypto.randomBytes(16).toString('hex'), at: now };
  if (!(await dbChanges('UPDATE mesh_satellites SET update_req = ? WHERE id = ? AND revoked_at IS NULL AND proto = 2 AND update_req IS NULL',
    [JSON.stringify(req), id]))) {
    // Bu arada başka bir istek yazdı (ya da uydu kaldırıldı / yeniden eşleşti): geçerli olan döner.
    const again = await sel();
    const p = again?.proto === 2 ? parseUpdateReq(again.update_req) : null;
    if (p && !updateReqExpired(p, now)) return { ...p, already: true };
    throw new MeshError(409, 'Uydunun durumu bu arada değişti — sayfayı yenileyip yeniden deneyin');
  }
  await recordEvent('mesh', `Uydu güncellemesi istendi: ${row.name}`);
  return { ...req, already: false };
}
// req: isteğin işi başladı ve başarısız oldu; değilse istek iş başlatmadı (ret notu: sık istek, depolama işi …).
const updateStateText = (u: UpdateState | null) => !u ? '' : u.state === 'running' ? ' — güncelleme sürüyor'
  : u.state === 'done' ? ' — güncellendi' : ` — ${u.req ? 'güncelleme başarısız' : 'başlamadı'}${u.reason ? `: ${u.reason}` : ''}`;
// Senkronda (v2): uydu isteği aldıysa (update_nonce aynı) ya da istek 24 saati geçtiyse silinir; yoksa zarfa girecek nonce.
// Uydunun daha önce aldığı (update_seen) bir istek yeniden işlenmez — ör. veritabanı eski bir anlık görüntüden açıldıysa —
// o da silinir. acked: istek bu senkronda alındı (olay o anki durumu zaten yazdı).
async function pendingUpdate(id: string, raw: unknown, status: ReturnType<typeof satStatusOf>): Promise<{ update: string; acked: boolean }> {
  const none = { update: '', acked: false };
  if (typeof raw !== 'string' || !raw) return none;
  const req = parseUpdateReq(raw);
  if (!req) { await clearUpdateReq(id, raw, ''); return none; } // bozuk değer: sessizce silinir
  if (status.update_nonce === req.nonce) {
    const acked = await clearUpdateReq(id, raw, `Uydu güncelleme isteğini aldı: ${status.name}${updateStateText(status.update_state)}`,
      status.update_state?.state === 'failed' ? 'warning' : 'info');
    return { update: '', acked };
  }
  if (status.update_seen.includes(req.nonce)) {
    await clearUpdateReq(id, raw, `Uydu bu güncelleme isteğini daha önce almıştı: ${status.name} — istek silindi`);
    return none;
  }
  if (updateReqExpired(req, Math.floor(Date.now() / 1000))) { await clearUpdateReq(id, raw, expiredText(status.name), 'warning'); return none; }
  return { update: req.nonce, acked: false };
}
// İsteğin sonucu: uydunun bu istek için başlattığı (ya da istek geldiğinde zaten süren) iş bitti → ana cihazın olaylarına
// bir kez yazılır (satırdaki durum 24 saat sonra gizlenir; kullanıcı uydunun panelini izlemez). Önceki bildirimde aynı sonuç
// varsa yazılmaz (bir uydunun v2 senkronları sırayla gelir: uydu tarafında v2Chain + artan seq); istekle ilgisiz işler (gece
// güncellemesi: req yok) hiç yazılmaz.
async function recordUpdateOutcome(prevRaw: unknown, status: ReturnType<typeof satStatusOf>) {
  const u = status.update_state;
  if (!u?.req || u.state === 'running') return;
  let prev: UpdateState | null = null;
  try { prev = updateStateOf(JSON.parse(String(prevRaw || 'null'))?.update_state); } catch { /* durum yok / bozuk */ }
  if (prev?.req && prev.state === u.state && prev.at === u.at && prev.reason === u.reason) return;
  if (u.state === 'done') await recordEvent('mesh', `Uydu güncellendi: ${status.name}${status.version ? ` (${status.version})` : ''}`);
  else await recordEvent('mesh', `Uydu güncellemesi başarısız: ${status.name}${u.reason ? ` — ${u.reason}` : ''}`, 'warning');
}

// Uydunun dakikalık bildirimi (kimlik anahtarla kanıtlanır).
export async function syncSatellite(auth: string | undefined, body: any, ip: string): Promise<{ config: SatConfig } | { proto: 2; box: Box }> {
  await ensureTables();
  if (body?.proto === 2) return syncSatelliteV2(body, ip);
  const token = /^Bearer ([0-9a-f]{64})$/.exec(String(auth || ''))?.[1];
  if (!token || !validSatId(body?.id)) throw new MeshError(401, 'Uydu kimliği doğrulanamadı');
  // Mezar taşı (kaldırılmış satır) Bearer ile de ayar alamaz.
  const row = await dbGet('SELECT id, token_hash FROM mesh_satellites WHERE id = ? AND revoked_at IS NULL', [body.id]);
  if (!row || !safeEqualHex(sha256(token), row.token_hash)) throw new MeshError(401, 'Uydu eşleşmesi yok (kaldırılmış olabilir)');
  const status = satStatusOf(body?.status);
  await dbRun('UPDATE mesh_satellites SET ip = ?, last_seen = ?, status = ?, name = ? WHERE id = ?',
    [ip, Math.floor(Date.now() / 1000), JSON.stringify(status), status.name, body.id]);
  return { config: await configFor(body.id) };
}
// v2: zarf uyduya özel anahtarla açılır (açılamazsa kimlik yok); seq son kabul edilenden büyük olmalı (tekrar koruması).
// Yanıt aynı seq'e bağlı zarftır: ayar ya da (mezar taşıysa) imzalı "kaldırıldı". Anahtar yoksa ya da satır bu anahtara
// bağlı değilse (keyFp) 401 — uydu bunu eşleşmenin kaldırılması saymaz, yalnız hata olarak gösterir.
async function syncSatelliteV2(body: any, ip: string): Promise<{ proto: 2; box: Box }> {
  const seq = body?.seq;
  if (!validSatId(body?.id) || !Number.isSafeInteger(seq) || seq <= 0) throw new MeshError(401, 'Uydu kimliği doğrulanamadı');
  const row = await dbGet('SELECT id, proto, revoked_at, token_hash, update_req, status FROM mesh_satellites WHERE id = ?', [body.id]);
  const key = row && row.proto === 2 ? readPeerKey(body.id) : null;
  if (!keyMatches(key, row?.token_hash)) throw new MeshError(401, 'Uydu eşleşmesi yok (kaldırılmış olabilir)');
  let msg: any;
  try { msg = open(key, `sync|${body.id}|${seq}`, body.box); } catch { throw new MeshError(401, 'Uydu kimliği doğrulanamadı'); }
  if (!(await dbChanges('UPDATE mesh_satellites SET last_seq = ? WHERE id = ? AND COALESCE(last_seq, 0) < ?', [seq, body.id, seq]))) {
    throw new MeshError(409, 'yeniden oynatma — bu istek daha önce işlendi (sürerse uyduyu yeniden eşleştirin)');
  }
  // addrs: ana cihazın kendi (özel ağ) adresleri, zarfın içinde. Uydu yeniden keşifte yeni adresi ancak bu listede varsa
  // kaydeder: doğrulanmış yanıt ana cihazın ürettiğini kanıtlar, hangi adreste durduğunu değil (araya giren aktarıcı).
  const addrs = async () => [...new Set((await readIfaceNets()).map(n => n.ip).filter(isCandidateIp))];
  const reply = (obj: unknown) => ({ proto: 2 as const, box: seal(key, `resp|${body.id}|${seq}`, obj) });
  if (row.revoked_at) return reply({ revoked: true, addrs: await addrs() });
  const status = satStatusOf(msg.status);
  await dbRun('UPDATE mesh_satellites SET ip = ?, last_seen = ?, status = ?, name = ? WHERE id = ?',
    [ip, Math.floor(Date.now() / 1000), JSON.stringify(status), status.name, body.id]);
  // update: bekleyen güncelleme isteği (yalnız bu şifreli zarfın içinde; eski uydu alanı yok sayar).
  const { update, acked } = await pendingUpdate(body.id, row.update_req, status);
  if (!acked) await recordUpdateOutcome(row.status, status);
  const config = await configFor(body.id);
  return reply({ config, addrs: await addrs(), ...(update ? { update } : {}) });
}

// Mezar taşları (kaldırılmış v2 uydular) listede, sayımlarda ve kanal planında yoktur. update_req: bekleyen güncelleme
// isteği (var mı + ne zaman), süresi geçmişse yok sayılır.
export async function listSatellites() {
  await ensureTables();
  const now = Math.floor(Date.now() / 1000);
  const rows = await dbAll('SELECT id, name, mac, ip, last_seen, status, created_at, proto, update_req FROM mesh_satellites WHERE revoked_at IS NULL ORDER BY created_at, id');
  return rows.map((r: any) => {
    let status: any = null;
    try { status = r.status ? JSON.parse(r.status) : null; } catch { status = null; }
    const req = parseUpdateReq(r.update_req);
    return { id: r.id, name: r.name, mac: r.mac, ip: r.ip, last_seen: r.last_seen, created_at: r.created_at,
      online: !!r.last_seen && now - r.last_seen <= OFFLINE_AFTER_S, status, proto: r.proto === 2 ? 2 : 1,
      update_req: req && !updateReqExpired(req, now) ? { pending: true, at: req.at } : null };
  });
}
// v1: satır silinir (uydu sonraki senkronda 401 alır). v2: mezar taşı — anahtar kalır, uydu sonraki senkronda imzalı
// "kaldırıldı" yanıtını alıp yayınını kapatır (sahte bir yanıt bunu yapamaz). Kullanıcı bu uyduyu kaldırdı: mezar taşı
// elde olan anahtara (uydunun bu ana cihazla son eşleşmesi) bağlanır — veritabanı geride kalmış olsa da kaldırma yerine
// ulaşır; satırdaki eski v1 jetonu da böylece geçersizleşir.
export async function removeSatellite(id: string): Promise<boolean> {
  await ensureTables();
  const row = await dbGet('SELECT name, proto FROM mesh_satellites WHERE id = ? AND revoked_at IS NULL', [id]);
  if (!row) return false;
  const key = readPeerKey(id);
  if (key) {
    await dbRun('UPDATE mesh_satellites SET revoked_at = ?, token_hash = ?, proto = 2, update_req = NULL WHERE id = ?', [Math.floor(Date.now() / 1000), keyFp(key), id]);
  } else {
    await dbRun('DELETE FROM mesh_satellites WHERE id = ?', [id]);
    removePeerKey(id);
  }
  await recordEvent('mesh', `Uydu kaldırıldı: ${row.name}`);
  return true;
}
// Çevrimiçi uyduların Wi-Fi istasyonları (ağ haritası: bu cihazlar kesin Wi-Fi).
export async function satelliteStations(): Promise<Set<string>> {
  const out = new Set<string>();
  try { for (const s of await listSatellites()) if (s.online) for (const m of s.status?.stations || []) out.add(m); } catch { /* tablo yok */ }
  return out;
}
// Çevrimdışı uydu uyarısı (5 dk'da bir; aynı uydu için saatte bir). 30 günden eski mezar taşları anahtarlarıyla silinir;
// anahtar dosyası mezar taşına bağlı değilse (uydu bu arada yeniden eşleşti ya da veritabanı geride) kalır.
const TOMBSTONE_KEEP_S = 30 * 86400;
export async function checkOfflineSatellites() {
  try {
    const now = Math.floor(Date.now() / 1000);
    await ensureTables();
    const cutoff = now - TOMBSTONE_KEEP_S;
    for (const r of await dbAll('SELECT id, token_hash FROM mesh_satellites WHERE revoked_at IS NOT NULL AND revoked_at < ?', [cutoff])) {
      if (!(await dbChanges('DELETE FROM mesh_satellites WHERE id = ? AND revoked_at IS NOT NULL AND revoked_at < ?', [r.id, cutoff]))) continue;
      if (keyMatches(readPeerKey(r.id), r.token_hash)) removePeerKey(r.id);
    }
    // 24 saatte alınmayan güncelleme isteği (uydu çevrimdışı kaldı): silinir, olay yazılır.
    for (const r of await dbAll('SELECT id, name, update_req FROM mesh_satellites WHERE update_req IS NOT NULL')) {
      const req = parseUpdateReq(r.update_req);
      if (!req || updateReqExpired(req, now)) await clearUpdateReq(r.id, r.update_req, req ? expiredText(r.name) : '', 'warning');
    }
    for (const s of await listSatellites()) {
      if (!s.online && s.last_seen && now - s.last_seen > 600) {
        await recordEventOnce('mesh', `Uydu çevrimdışı: ${s.name} (son görülme ${new Date(s.last_seen * 1000).toLocaleString('tr-TR')})`, 'warning', 60);
      }
    }
  } catch { /* */ }
}

// Kablosuz mesh omurgası (ana cihaz): açılınca rastgele ağ adı + parola, mesh.sh configure --role main.
export async function setMainWireless(enabled: boolean, channel: number): Promise<void> {
  if (!enabled) {
    const r = await runKv(MESH_SCRIPT, ['disable'], 60000);
    if (r.code !== 0) throw new MeshError(500, kvErr(r, 'kablosuz mesh kapatılamadı'));
    return;
  }
  if (!CH_5.includes(channel)) throw new MeshError(400, 'Mesh kanalı 36, 40, 44 ya da 48 olmalı');
  const st = await meshStatus();
  // Durum bilinmiyorsa açılmaz: "kapalı" sayılıp yeni ağ adı + parola üretilirse kablosuz bağlı uydular kopardı.
  if (!st) throw new MeshError(503, `${MESH_UNKNOWN} — mevcut mesh ağ adı ve parolası korunsun diye değiştirilmedi; biraz sonra yeniden deneyin`);
  const id = st.role === 'main' && /^klyrix-[0-9a-f]{6}$/.test(st.id || '') ? st.id : `klyrix-${crypto.randomBytes(3).toString('hex')}`;
  const psk = (st.role === 'main' && readMeshPsk()) || crypto.randomBytes(24).toString('base64url');
  const r = await runKv(MESH_SCRIPT, ['configure', '--id', id, '--channel', String(channel), '--role', 'main'], 60000, `${psk}\n`);
  if (r.code !== 0) throw new MeshError(409, kvErr(r, 'kablosuz mesh açılamadı'));
}
// unknown: mesh.sh status okunamadı — diğer alanlar "kapalı" gibi görünür, ama kapalı sayılmamalı (rol değişimi, panel).
export async function mainMeshState() {
  const ms = await meshStatus();
  const st: Record<string, string> = ms || {};
  return {
    unknown: !ms,
    capable: (st.capable || '').split(',').filter(Boolean), configured: st.configured === '1' && st.role === 'main',
    id: st.role === 'main' ? st.id || '' : '', channel: Number(st.channel) || null, service: st.service || '',
    iface: st.iface === '1', wpa: st.wpa === '1', attached: st.attached === '1', peers: Number(st.peers) || 0,
  };
}

// ─── Uydu ───

// v1: token (taşıyıcı anahtar). v2: proto 2 + key (uyduya özel kanal anahtarı) + seq (son gönderilen sıra) + main_id.
// Uzaktan güncelleme (yalnız v2): update_nonce (son alınan istek), update_seen (öncekiler; eski istek yeniden işlenmez —
// ör. ana cihazın veritabanı eski bir anlık görüntüden açılırsa), last_update_start (10 dk sınırı, yeniden başlasa da
// geçerli), update_note + update_note_at (son isteğin iş başlatmama nedeni: sık istek, depolama işi … ya da iş başlarken
// kalan "başlatılıyor" işareti), update_job (son isteğin sonucunu verecek işin kimliği: ana cihaz bitişini olay yazar).
type SatState = {
  main: string; id: string; token?: string; name: string; paired_at: number;
  proto?: 2; key?: string; seq?: number; main_id?: string;
  last_sync?: number; last_error?: string; applied_wifi?: string; applied_mesh?: string; revoked?: boolean;
  update_nonce?: string; update_seen?: string[]; last_update_start?: number; update_note?: string; update_note_at?: number; update_job?: string;
};
type UpdFields = Pick<SatState, 'update_nonce' | 'update_seen' | 'last_update_start' | 'update_note' | 'update_note_at' | 'update_job'>;
const isV2 = (s: SatState) => s.proto === 2 && /^[0-9a-f]{64}$/.test(s.key || '');
export function readSatState(): SatState | null {
  try {
    const s = JSON.parse(fs.readFileSync(SAT_FILE, 'utf8'));
    return validMainAddr(s?.main) && validSatId(s?.id) && (/^[0-9a-f]{64}$/.test(s?.token || '') || isV2(s)) ? s : null;
  } catch { return null; }
}
// Aynı eşleşme mi (kimlik + v2 anahtarı / v1 jetonu)?
const samePairing = (a: SatState, b: SatState) => a.id === b.id && (isV2(a) ? isV2(b) && a.key === b.key : !isV2(b) && a.token === b.token);
// newMain: ana cihazın yeni adresi (yalnız doğrulanmış yeniden keşif, sendSyncV2). upd: güncelleme isteği alanları (yalnız
// acceptUpdateRequest).
function writeSatState(s: SatState, newMain?: string, upd?: UpdFields) {
  // seq hiç geri gitmez: aynı eşleşmede başka bir akış (ön sınama, "Şimdi eşitle") bu arada daha büyük seq göndermiş olabilir.
  const disk = isV2(s) ? readSatState() : null;
  if (disk && samePairing(disk, s) && (Number(disk.seq) || 0) > (Number(s.seq) || 0)) s.seq = disk.seq;
  // Ana cihazın adresi de aynı eşleşmede yalnız newMain ile değişir: bu arada başka bir akış ana cihazı yeni adreste
  // bulduysa eski adresli bellek kopyası onu geri almaz.
  if (disk && samePairing(disk, s)) s.main = newMain || disk.main;
  else if (newMain) s.main = newMain;
  // Güncelleme isteği alanları da aynı eşleşmede yalnız upd ile değişir: eski bellek kopyası alınmış isteği silip onun
  // ikinci kez işlenmesine yol açmasın.
  const src = upd || (disk && samePairing(disk, s) ? disk : null);
  if (src) {
    s.update_nonce = src.update_nonce; s.update_seen = src.update_seen; s.last_update_start = src.last_update_start;
    s.update_note = src.update_note; s.update_note_at = src.update_note_at; s.update_job = src.update_job;
  }
  fs.mkdirSync(MESH_DIR, { recursive: true, mode: 0o700 });
  writeFileDurable(SAT_FILE, JSON.stringify(s));
}
// Uzun süren senkron / uygulama bitince: kullanıcı bu arada eşleşmeyi kaldırdıysa, yeniden eşleştiyse ya da başka bir akış
// kaldırmayı işlediyse eski durum diske geri yazılmaz (kaldırılan eşleşme dirilmesin, yenisi ezilmesin).
function writeIfCurrent(s: SatState): boolean {
  const cur = readSatState();
  if (!cur || !samePairing(cur, s) || cur.revoked) return false;
  writeSatState(s);
  return true;
}
// Cihaz kimliği (iki rolde de): uydu eşleşmede bunu bildirir, ana cihaz v2 eşleşmede main_id olarak döner; keşif (mDNS,
// kimlik yanıtı) da bunu duyurur — bu yüzden ilk açılışta oluşur. Kimlik donanıma bağlıdır (id.hw: kartın seri numarasının
// özeti): kullanılmış bir SD kart başka bir cihaza kopyalanırsa ve kopyada eşleşme yoksa kopya kendi kimliğini üretir —
// iki cihaz aynı kimlikle görünmez, keşif birini "kendisi" sanıp atmaz, ana cihaz ikinci uyduyu birincinin üstüne
// yazmaz. Eşleşme varsa (uydu dosyası ya da peers/ anahtarları) kimlik korunur: uydular onu main_id olarak sabitledi.
// Seri numarası okunamazsa bağ yoktur (eskisi gibi); eski sürümden kalan kimlik bu cihazın sayılır ve bağlanır.
const ID_FILE = `${MESH_DIR}/id`;
const HW_FILE = `${MESH_DIR}/id.hw`;
let hwCache: string | null = null;
let serialCache: string | null = null;
// Donanım seri numarası (Pi: devicetree serial-number, x86: DMI product_uuid); geçerli değer yoksa ''. Ham değer yalnız
// özetlenerek kullanılır (mesh kimliği bağı: hwTag; lisans cihaz kodu: license.ts deviceCodeFor) — hiçbir yanıtta dışarı
// verilmez.
export function hwSerial(): string {
  if (serialCache !== null) return serialCache;
  serialCache = '';
  for (const f of ['/sys/firmware/devicetree/base/serial-number', '/sys/class/dmi/id/product_uuid']) {
    try {
      const v = fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim().toLowerCase();
      if (/^[0-9a-f-]{8,64}$/.test(v) && /[1-9a-f]/.test(v)) { serialCache = v; break; }
    } catch { /* yok / okunamadı */ }
  }
  return serialCache;
}
function hwTag(): string {
  if (hwCache !== null) return hwCache;
  const v = hwSerial();
  hwCache = v ? sha256(`klyrix-hw|${v}`).slice(0, 32) : '';
  return hwCache;
}
const holdsPairing = () => {
  if (fs.existsSync(SAT_FILE)) return true;
  try { return fs.readdirSync(PEERS_DIR).length > 0; } catch { return false; }
};
const writeHwTag = (hw: string) => { try { fs.writeFileSync(HW_FILE, `${hw}\n`, { mode: 0o600 }); } catch { /* bağ sonra yazılır */ } };
export function deviceId(): string {
  const s = readSatState();
  if (s) return s.id;
  const hw = hwTag();
  let id = '';
  try { id = fs.readFileSync(ID_FILE, 'utf8').trim(); } catch { /* ilk kez */ }
  if (validSatId(id)) {
    let tag = '';
    try { tag = fs.readFileSync(HW_FILE, 'utf8').trim(); } catch { /* eski sürüm: bağ yok */ }
    if (!hw || tag === hw || holdsPairing()) return id;
    if (!tag) { writeHwTag(hw); return id; }
    console.log('[mesh] cihaz kimliği başka bir donanımdan kopyalanmış (SD kart) ve eşleşme yok — bu cihaz için yeni kimlik');
  }
  id = crypto.randomUUID();
  fs.mkdirSync(MESH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ID_FILE, `${id}\n`, { mode: 0o600 });
  if (hw) writeHwTag(hw);
  return id;
}

// Süre mutlaktır (yalnız boşta kalma değil): baytı damla damla gönderen bir yanıt da isteği — ve arkasında sıradaki v2
// senkronları — süresiz tutamaz. 64 KiB'ı aşan yanıt kesilir.
export function postJson(main: string, path: string, body: unknown, token?: string, timeoutMs = 15000): Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    const [host, port] = main.split(':');
    const data = JSON.stringify(body);
    let done = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (r: { status: number; json: any }) => { if (done) return; done = true; clearTimeout(deadline); resolve(r); };
    const fail = (msg: string) => finish({ status: 0, json: { error: `ana cihaza ulaşılamadı: ${msg}` } });
    const req = http.request({ host, port: Number(port) || 80, path, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', d => { s += d; if (s.length > 65536) { fail('yanıt çok büyük'); req.destroy(); } });
      res.on('end', () => { let json: any = {}; try { json = JSON.parse(s); } catch { /* düz metin */ } finish({ status: res.statusCode || 0, json }); });
      res.on('error', e => fail(e.message));
      res.on('close', () => fail('bağlantı yarıda kesildi')); // 'end'den sonra gelirse etkisiz
    });
    deadline = setTimeout(() => { fail('zaman aşımı'); req.destroy(); }, timeoutMs);
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
    req.on('error', e => fail(e.message));
    req.end(data);
  });
}

// ─── Keşif (R2): ağda görünme (mDNS) + ağdaki Klyrix cihazları ───
// Keşif yalnız ADRES önerir: eşleşme yine 6 haneli kodla, rol yine her cihazın kendi panelinden değişir. mDNS kaydı ve
// kimlik yanıtı doğrulanmamıştır (aynı ağdaki herkes duyurabilir); kimliği yalnız eşleşmenin anahtarı kanıtlar.

// Kimlik yanıtı (GET /api/mesh/pair, oturumsuz): keşif adayları bununla doğrulanır. Sürüm yok (parmak izi çıkarılmasın).
// pairing: ana cihazda şu an açık bir eşleştirme kodu var mı; paired: uydu bir ana cihazla eşleşmiş mi (kaldırılmamış).
export function meshHello(role: 'main' | 'satellite') {
  let id = '';
  try { id = deviceId(); } catch { /* kimlik yazılamadı: keşif bu cihazı atlar */ }
  const s = role === 'satellite' ? readSatState() : null;
  return { klyrix: 1, proto: 2, id, role, name: os.hostname(), pairing: role === 'main' && !!pairingState(), paired: !!s && !s.revoked };
}

// mDNS yayını: avahi hizmet dosyası (share.sh'nin klyrix-smb.service'i gibi). Ad "Klyrix Gate on <makine adı>" (%h).
export const MDNS_TYPE = '_klyrix-gate._tcp';
const AVAHI_DIR = '/etc/avahi/services';
const AVAHI_SVC = `${AVAHI_DIR}/klyrix-gate.service`;
export function renderAvahiService(o: { id: string; role: 'main' | 'satellite'; proto: number }): string {
  if (!validSatId(o.id) || (o.role !== 'main' && o.role !== 'satellite') || !Number.isSafeInteger(o.proto) || o.proto < 1) throw new Error('geçersiz mDNS kaydı');
  return [
    '<?xml version="1.0" standalone=\'no\'?>',
    '<!DOCTYPE service-group SYSTEM "avahi-service.dtd">',
    '<!-- Klyrix Gate cihaz keşfi (backend/src/mesh.ts yazar, elle düzenlemeyin): diğer Klyrix cihazları bu cihazı ağda bulur -->',
    '<service-group>',
    '  <name replace-wildcards="yes">Klyrix Gate on %h</name>',
    '  <service>',
    `    <type>${MDNS_TYPE}</type>`,
    '    <port>80</port>',
    '    <txt-record>txtvers=1</txt-record>',
    `    <txt-record>id=${o.id}</txt-record>`,
    `    <txt-record>role=${o.role}</txt-record>`,
    `    <txt-record>proto=${o.proto}</txt-record>`,
    // Klyrix/Gate yönetim uygulaması bu cihazla eşleşebilir (gateApp.ts, POST /api/app/pair; uydu ana cihazdan yönetilir).
    // Keşif bilinmeyen alanı yok sayar.
    ...(o.role === 'main' ? ['    <txt-record>app=1</txt-record>'] : []),
    '  </service>',
    '</service-group>',
    '',
  ].join('\n');
}
// Açılışta bir kez (iki rolde de; rol yalnız backend yeniden başlayınca değişir). Dosya yalnız içerik değiştiyse yazılır
// (tmp + rename; tmp adı .service ile bitmez, avahi okumaz) ve avahi yeniden okur. avahi yoksa dizin yoktur: atlanır.
export async function publishMdns(role: 'main' | 'satellite'): Promise<'written' | 'unchanged' | 'skipped'> {
  if (!fs.existsSync(AVAHI_DIR)) return 'skipped';
  let xml: string;
  try { xml = renderAvahiService({ id: deviceId(), role, proto: 2 }); } catch { return 'skipped'; }
  let cur = '';
  try { cur = fs.readFileSync(AVAHI_SVC, 'utf8'); } catch { /* ilk kez */ }
  if (cur === xml) return 'unchanged';
  const tmp = `${AVAHI_DIR}/.klyrix-gate.tmp-${process.pid}`;
  fs.writeFileSync(tmp, xml, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644); // avahi-daemon kendi kullanıcısıyla okur
  fs.renameSync(tmp, AVAHI_SVC);
  await new Promise<void>(resolve => { execFile('avahi-daemon', ['--reload'], { timeout: 10000 }, () => resolve()); });
  return 'written';
}

// avahi-browse -p kaçışları: \DDD (ondalık bayt) ve \<karakter> (\. \\ \" ...). Baytlar UTF-8 olarak çözülür.
function avahiUnescape(s: string): string {
  const out: Buffer[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && /^\d{3}$/.test(s.slice(i + 1, i + 4))) { out.push(Buffer.from([Number(s.slice(i + 1, i + 4)) & 0xff])); i += 3; continue; }
    if (s[i] === '\\' && i + 1 < s.length) i++;
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out.push(Buffer.from(ch, 'utf8'));
    i += ch.length - 1;
  }
  return Buffer.concat(out).toString('utf8');
}
// TXT alanı: "a=1" "b=2" (her kayıt tırnakta; içte \" \\ \DDD). Anahtarlar küçük harfe çevrilir; ilk geçen kazanır.
function parseAvahiTxt(field: string): Record<string, string> {
  const txt: Record<string, string> = {};
  for (let i = 0; i < field.length; i++) {
    if (field[i] !== '"') continue;
    let raw = '';
    for (i++; i < field.length && field[i] !== '"'; i++) {
      if (field[i] === '\\' && i + 1 < field.length) { raw += field[i] + field[i + 1]; i++; } else raw += field[i];
    }
    const rec = avahiUnescape(raw);
    const eq = rec.indexOf('=');
    const k = (eq < 0 ? rec : rec.slice(0, eq)).toLowerCase();
    if (k && !(k in txt)) txt[k] = eq < 0 ? '' : rec.slice(eq + 1);
  }
  return txt;
}
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const v4num = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const inV4 = (ip: string, base: string, bits: number) => Math.floor(v4num(ip) / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits));
// Keşif adayı olabilecek adres: özel ağ (RFC 1918) ya da operatör NAT'ı (100.64/10). Bağlantı-yerel, döngü, genel yok.
export const isCandidateIp = (ip: string) => IPV4_RE.test(ip)
  && (inV4(ip, '10.0.0.0', 8) || inV4(ip, '172.16.0.0', 12) || inV4(ip, '192.168.0.0', 16) || inV4(ip, '100.64.0.0', 10));
// `avahi-browse -rpt` çıktısı: yalnız çözülmüş "=" satırları ve IPv4 adres (IPv6 satırında da IPv4 adres gelebilir —
// adrese bakılır), 169.254/16 ve döngü (127/8) atılır; aynı adres + ad bir kez. "+" / "-" satırları yok sayılır.
// "=;arayüz;protokol;ad;tür;alan;makine;adres;port;txt"
export type AvahiEntry = { iface: string; name: string; host: string; ip: string; port: number; txt: Record<string, string> };
export function parseAvahiBrowse(stdout: string): AvahiEntry[] {
  const out: AvahiEntry[] = [];
  for (const line of String(stdout || '').split('\n')) {
    const f = line.replace(/\r$/, '').split(';');
    if (f[0] !== '=' || f.length < 10) continue;
    const ip = f[7];
    if (!IPV4_RE.test(ip) || inV4(ip, '169.254.0.0', 16) || inV4(ip, '127.0.0.0', 8)) continue;
    const name = avahiUnescape(f[3]);
    if (out.some(e => e.ip === ip && e.name === name)) continue;
    out.push({ iface: f[1], name, host: f[6], ip, port: Number(f[8]) || 0, txt: parseAvahiTxt(f.slice(9).join(';')) });
  }
  return out;
}
// avahi-browse yoksa (paket yok), daemon çalışmıyorsa ya da hiçbir şey vermeden zaman aşımına uğrarsa: kullanılamaz.
function avahiBrowse(): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile('avahi-browse', ['-rpt', MDNS_TYPE], { timeout: 6000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      const out = String(stdout || '');
      resolve({ ok: !err || out.trim().length > 0, out });
    });
  });
}
// Keşif yoklaması: GET http://<ip>/api/mesh/pair (nginx, port 80). Süre mutlak, gövde küçük — yavaş ya da büyük yanıt
// veren bir aday (ör. modemin arayüzü) keşfi tutamaz.
function getJson(host: string, path: string, timeoutMs: number, maxBytes = 4096): Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    let done = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (status: number, json: any) => { if (done) return; done = true; clearTimeout(deadline); resolve({ status, json }); };
    const req = http.request({ host, port: 80, path, method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json' } }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', d => { s += d; if (s.length > maxBytes) { finish(0, null); req.destroy(); } });
      res.on('end', () => { let json: any = null; try { json = JSON.parse(s); } catch { /* JSON değil */ } finish(res.statusCode || 0, json); });
      res.on('error', () => finish(0, null));
      res.on('close', () => finish(0, null));
    });
    deadline = setTimeout(() => { finish(0, null); req.destroy(); }, timeoutMs);
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(0, null));
    req.end();
  });
}

// conflict: aynı kimlik birden çok adresten yanıt verdi. Cihazın kendisi birden çok adreste olabilir (ör. .153 +
// 192.168.0.1) ya da ağdaki biri onun (gizli olmayan) kimliğini kopyalıyor — kimlik yanıtı ikisini ayıramaz. Bu yüzden
// hiçbiri gizlenmez (ilk yanıt veren kazanmaz): panel hepsini uyarıyla gösterir, yeniden keşif hepsini dener.
export type KlyrixDevice = {
  id: string; name: string; ip: string; role: 'main' | 'satellite'; paired: boolean; pairing: boolean; proto: number; source: 'gateway' | 'mdns';
  conflict: boolean;
};
// mdns_blocked: bu cihazın güvenlik duvarı (Firewall → Deploy Et, /etc/nftables.conf) bu sürümden önce kurulmuş: gelen
// mDNS düşer (input policy drop, 5353 izni yeni), keşif yalnız ağ geçidini bulabilir — panel bunu söyler.
export type Discovery = { devices: KlyrixDevice[]; mdns: 'ok' | 'unavailable'; mdns_blocked: boolean };
const DISCOVER_MAX_CANDIDATES = 16; // sahte mDNS kayıtlarıyla yüzlerce adres yoklatılamasın
const DISCOVER_PROBE_MS = 2500;
const DISCOVER_CACHE_MS = 10000;
// Bu cihazın IPv4 adresleri kartlarıyla (ip -j -4 addr): kendi adresleri + "aynı bağlantıda mı" denetimi.
export type IfaceNet = { iface: string; ip: string; bits: number };
function readIfaceNets(): Promise<IfaceNet[]> {
  return new Promise(resolve => {
    execFile('ip', ['-j', '-4', 'addr', 'show'], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const out: IfaceNet[] = [];
      try {
        if (!err) for (const l of JSON.parse(String(stdout)) as any[]) for (const a of l?.addr_info || []) {
          if (IPV4_RE.test(String(a?.local)) && Number.isInteger(a?.prefixlen) && a.prefixlen >= 1 && a.prefixlen <= 32) out.push({ iface: String(l.ifname), ip: a.local, bits: a.prefixlen });
        }
      } catch { /* okunamadı: kendi adresi yok sayılır, mDNS adayı bağlantıda sayılmaz */ }
      resolve(out);
    });
  });
}
const onLink = (nets: IfaceNet[], ip: string, iface?: string) => nets.some(n => (iface === undefined || n.iface === iface) && inV4(ip, n.ip, n.bits));
// Yoklanacak adaylar (saf; birim testi). Önce varsayılan ağ geçidi (Pi DHCP / internet kartı / "Pi dağıtır": ana cihaz
// çoğunlukla odur; mDNS güvenlik duvarında kapalı olsa da TCP 80'den bulunur) — her zaman sınırın içinde. Sonra mDNS:
// yalnız kaydın duyulduğu kartın kendi ağındaki adres (avahi her adresi gösteren A kaydını geçirir — ağdaki biri bu cihazı
// varsayılan rotadan / tünelden başka ağlara yoklatamasın), bu cihazın adresi ve kimliği hariç. Sıra: TXT kimliği
// eşleşilen ana cihazınki (uydu, yeniden keşif), sonra TXT rolü ana cihaz, sonra diğerleri — kimlik taşımayan sahte
// kayıt seli ana cihazı 16'lık sınırın dışına itemesin.
export function pickCandidates(gw: string | null, entries: AvahiEntry[], o: { nets: IfaceNet[]; ownId: string; mainId: string }): { ip: string; source: KlyrixDevice['source'] }[] {
  const own = new Set(o.nets.map(n => n.ip));
  const cands: { ip: string; source: KlyrixDevice['source'] }[] = [];
  const add = (ip: string, source: KlyrixDevice['source']) => {
    if (isCandidateIp(ip) && !own.has(ip) && !cands.some(c => c.ip === ip) && cands.length < DISCOVER_MAX_CANDIDATES) cands.push({ ip, source });
  };
  if (gw) add(gw, 'gateway');
  const rank = (e: AvahiEntry) => (o.mainId && e.txt.id === o.mainId ? 0 : e.txt.role === 'main' ? 1 : 2);
  const ms = entries.filter(e => (!o.ownId || e.txt.id !== o.ownId) && onLink(o.nets, e.ip, e.iface)).map((e, i) => ({ e, i }));
  ms.sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i);
  for (const { e } of ms) add(e.ip, 'mdns');
  return cands;
}
function fwBlocksMdns(): boolean {
  try { const c = fs.readFileSync('/etc/nftables.conf', 'utf8'); return c.includes('table inet pi5_filter') && !c.includes('udp dport 5353'); } catch { return false; }
}
async function runDiscover(): Promise<Discovery> {
  let ownId = '';
  try { ownId = deviceId(); } catch { /* kimlik yok */ }
  const sat = readSatState();
  const mainId = sat && isV2(sat) && !sat.revoked && validSatId(sat.main_id) ? sat.main_id : '';
  const [gw, nets, av] = await Promise.all([readDefaultRoute(), readIfaceNets(), avahiBrowse()]);
  const cands = pickCandidates(gw?.ip || null, parseAvahiBrowse(av.out), { nets, ownId, mainId });
  const replies = await Promise.all(cands.map(async c => ({ c, r: await getJson(c.ip, '/api/mesh/pair', DISCOVER_PROBE_MS) })));
  const devices: KlyrixDevice[] = [];
  for (const { c, r } of replies) {
    const h = r.status === 200 && r.json && typeof r.json === 'object' ? r.json : null;
    if (!h || h.klyrix !== 1 || !validSatId(h.id) || h.id === ownId || (h.role !== 'main' && h.role !== 'satellite')) continue;
    devices.push({
      id: h.id, name: String(h.name || '').replace(/[^\w .-]/g, '').trim().slice(0, 63), ip: c.ip, role: h.role,
      paired: h.paired === true, pairing: h.pairing === true, proto: Number.isSafeInteger(h.proto) && h.proto > 0 ? h.proto : 1, source: c.source,
      conflict: false,
    });
  }
  for (const d of devices) d.conflict = devices.some(x => x.id === d.id && x.ip !== d.ip);
  return { devices, mdns: av.ok ? 'ok' : 'unavailable', mdns_blocked: fwBlocksMdns() };
}
// Aynı anda tek keşif; sonuç 10 sn saklanır (panel ve uydu ajanı aynı anda isteyebilir).
let discoverCache: { at: number; result: Discovery } | null = null;
let discoverRun: Promise<Discovery> | null = null;
export function discoverKlyrix(): Promise<Discovery> {
  if (discoverCache && Date.now() - discoverCache.at < DISCOVER_CACHE_MS) return Promise.resolve(discoverCache.result);
  discoverRun ??= runDiscover()
    .then(result => { discoverCache = { at: Date.now(), result }; return result; })
    .finally(() => { discoverRun = null; });
  return discoverRun;
}

// Senkron isteği (uydu → ana cihaz). ok = ana cihaz yanıtı geçerli; revoked = eşleşme kaldırıldı.
//  - v1: taşıyıcı anahtarla düz istek; 200 geçerli, 401 kaldırıldı (eskisi gibi).
//  - v2: şifreli zarf, Authorization yok. seq göndermeden ÖNCE kaydedilir (yeniden başlasa da aynı seq bir daha
//    gitmez). Yalnız bu seq'e bağlı, açılabilen yanıt kabul edilir; şifresiz, doğrulanamayan ya da 200 olmayan her yanıt
//    yalnız hatadır — v2 uydu düz yanıta hiç dönmez, kaldırılma yalnız imzalı "revoked" ile olur. İstekler sırayla gider.
//    Doğrulanmamış yanıtın metni gösterilmez (sahte bir yanıt panele yönlendirici yazı koyamasın): yalnız HTTP kodu.
//  - stale: eşleşme istek sürerken değişti (kaldırıldı / yeniden eşleşildi) — çağıran eski durumu diske yazmaz.
//  - addr (yalnız v2, yeniden keşif): istek kayıtlı adres yerine buraya gider (süre 8 sn). Ana cihazın adresi ANCAK
//    yanıt bu uydunun anahtarıyla açılırsa (doğrulanmış), ana cihaz zarfın içinde bu adresi kendi adresleri arasında
//    sayarsa (addrs) ve aynı eşleşme hâlâ diskteyse güncellenir → moved. Listede değilse (araya giren düz bir aktarıcı ya
//    da adres çevirisi) yanıt yine ana cihazındır ve işlenir, ama adres değişmez → mainAddrs (doğrulanmış liste).
//  - authed: yanıt bu uydunun anahtarıyla açıldı (gerçekten ana cihazdan).
//  - update (yalnız v2, doğrulanmış yanıt): ana cihazın güncelleme isteği (32 hex). v1 yanıtında hiç okunmaz; yalnız
//    syncOnce işler (ön sınama ve takip senkronları yok sayar).
type SyncResult = {
  ok: boolean; status: number; error: string; config?: SatConfig; revoked?: boolean; stale?: boolean; authed?: boolean; moved?: { from: string; to: string };
  mainAddrs?: string[]; update?: string;
};
const REDISCOVER_SYNC_MS = 8000;
let v2Chain: Promise<unknown> = Promise.resolve();
async function sendSync(s: SatState, status: unknown, addr?: string): Promise<SyncResult> {
  if (!isV2(s)) {
    const r = await postJson(s.main, '/api/mesh/sync', { id: s.id, status }, s.token);
    return { ok: r.status === 200, status: r.status, error: r.json?.error || '', config: r.json?.config, revoked: r.status === 401 };
  }
  const run = v2Chain.then(() => sendSyncV2(s, status, addr));
  v2Chain = run.catch(() => undefined);
  return run;
}
async function sendSyncV2(s: SatState, status: unknown, addr?: string): Promise<SyncResult> {
  const cur = readSatState();
  if (!cur || !isV2(cur) || cur.id !== s.id || cur.key !== s.key || cur.revoked) return { ok: false, status: 0, error: 'eşleşme bu arada değişti', stale: true };
  const seq = Math.max((Number(cur.seq) || 0) + 1, (Number(s.seq) || 0) + 1, Date.now());
  cur.seq = seq; s.seq = seq;
  writeSatState(cur);
  const key = Buffer.from(s.key!, 'hex');
  const r = await postJson(addr || cur.main, '/api/mesh/sync', { id: s.id, proto: 2, seq, box: seal(key, `sync|${s.id}|${seq}`, { status }) },
    undefined, addr ? REDISCOVER_SYNC_MS : undefined);
  if (r.status !== 200) {
    // status 0: yerel hata (postJson: ulaşılamadı / zaman aşımı) — metni bu cihazın.
    const error = r.status === 0 ? String(r.json?.error || 'ana cihaza ulaşılamadı')
      : r.status === 401 ? 'ana cihaz bu uyduyu tanımadı (HTTP 401, doğrulanmamış yanıt — eşleşme değişmedi; sürerse yeniden eşleştirin)'
        : r.status === 409 ? 'ana cihaz isteği yineleme saydı (HTTP 409, doğrulanmamış yanıt)'
          : `ana cihaz isteği reddetti (HTTP ${r.status}, doğrulanmamış yanıt)`;
    return { ok: false, status: r.status, error };
  }
  let msg: any;
  try { msg = open(key, `resp|${s.id}|${seq}`, r.json?.box); } catch {
    return { ok: false, status: 200, error: 'ana cihazın yanıtı doğrulanamadı (şifresiz ya da başka anahtarla) — yok sayıldı' };
  }
  // Yanıt bu uydunun anahtarıyla açıldı (gerçekten ana cihazdan). Yeni adres ana cihazın kendi adreslerindense kalıcı
  // (bellekteki s de, ki çağıranın sonraki yazımı eski adresi geri getirmesin); değilse yalnız doğrulanmış liste döner.
  let moved: SyncResult['moved'];
  let mainAddrs: string[] | undefined;
  if (addr && addr !== cur.main) {
    const listed: string[] = Array.isArray(msg.addrs) ? msg.addrs.filter((a: unknown): a is string => typeof a === 'string' && isCandidateIp(a)).slice(0, 32) : [];
    const now = readSatState();
    if (!listed.includes(addr)) mainAddrs = listed;
    else if (now && samePairing(now, s) && !now.revoked) {
      moved = { from: now.main, to: addr };
      writeSatState(now, addr);
      s.main = addr;
    }
  }
  // Doğrulanmış kaldırma: ok değil (v1'deki 401 gibi deneme yayını geri alınır); syncOnce önce revoked'a bakar.
  if (msg.revoked === true) return { ok: false, status: 200, error: 'ana cihaz bu uydunun eşleşmesini kaldırdı', revoked: true, authed: true, moved, mainAddrs };
  if (!msg.config || typeof msg.config !== 'object') return { ok: false, status: 200, error: 'ana cihazın yanıtında ayar yok', authed: true, moved, mainAddrs };
  const update = typeof msg.update === 'string' && NONCE_RE.test(msg.update) ? msg.update : undefined;
  return { ok: true, status: 200, error: '', config: msg.config, authed: true, moved, mainAddrs, update };
}

const versionOf = () => { try { return JSON.parse(fs.readFileSync('/opt/pi5-gateway/version.json', 'utf8')).version || ''; } catch { return ''; } };

// ─── Uzaktan güncelleme (uydu) ───
const UPD_NOTE_RUNNING = 'güncelleme zaten sürüyor';
const UPD_NOTE_RATE = 'çok sık istek — 10 dakikada en çok bir kez';
const UPD_NOTE_STORAGE = 'depolama işi sürüyor';
// Başlatma işareti: nonce ile aynı yazımda diske girer, iş başlayınca (ya da ret notuyla) silinir. Süreç arada ölürse
// (çökme, bellek, elle yeniden başlatma) işaret kalır: istek "yarıda kesildi" görünür ve 10 dk sınırına sayılmaz.
const UPD_NOTE_STARTING = 'başlatılıyor';
const UPD_NOTE_INTERRUPTED = 'yarıda kesildi — yeniden isteyin';
const UPDATE_SEEN_MAX = 8;
let updStarting = ''; // bu süreçte başlatılmakta olan isteğin nonce'u (işaret bu süreçteyse "yarıda kesildi" değildir)
const jobStatus = async (): Promise<UpdateStatus> => { try { return await getUpdateStatus(); } catch { return { state: 'idle' }; } };
const jobAtOf = (st: UpdateStatus) => (st.state === 'idle' ? 0 : st.startedAt || 0);
// İşaret kaldı, bu süreç başlatmıyor ve işaretten sonra başlamış iş yok: önceki süreç işi başlatamadan öldü.
const startInterrupted = (s: SatState, st: UpdateStatus) => s.update_note === UPD_NOTE_STARTING && updStarting !== s.update_nonce
  && jobAtOf(st) < (Number(s.update_note_at) || 0);
// Son gerçek başlatma (yarıda kalan sayılmaz) ve 10 dk sınırından kalan süre (sn). Saat geri gittiyse (son başlatma ileri
// tarihli) sınır uygulanmaz: istek süresiz engellenmesin.
const lastStart = (s: SatState | null, st: UpdateStatus) => (s && !startInterrupted(s, st) ? Number(s.last_update_start) || 0 : 0);
const gapLeft = (last: number, now: number) => (last > 0 && now >= last && now - last < UPDATE_MIN_GAP_S ? last + UPDATE_MIN_GAP_S - now : 0);
// Başarısız işin kısa nedeni (update.ts summarizeUpdate adım adları → ana cihazda gösterilecek Türkçe; tanınmayan ad
// olduğu gibi). Günlük metni gönderilmez; yalnız update.sh'nin kilit iletisi (çıkış 75) tanınır.
const FAIL_REASON: Record<string, string> = {
  'Hazırlık': 'hazırlık adımı başarısız', 'Git Pull': "kod indirilemedi (GitHub'a ulaşılamadı?)", 'Backend Build': 'backend derlenemedi',
  'Frontend Build': 'arayüz derlenemedi', 'Yeni derlemeye geçiş': 'yeni derlemeye geçilemedi', 'Servis Restart': 'panel yeniden başlatılamadı',
  'Güncelleme ertelendi': 'depolama işi sürüyordu — ertelendi', 'Güncelleme durduruldu': `${UPDATE_MAX_RUNTIME_S / 60} dk sınırı aşıldı ya da durduruldu`,
  'Güncelleme başlatılamadı': 'başlatılamadı', 'Güncelleme yarıda kesildi': 'yarıda kesildi',
};
function failReason(st: UpdateStatus): string {
  const f = st.steps?.find(x => !x.success);
  if (!f) return '';
  if (f.step === 'Güncelleme') return /Başka bir güncelleme sürüyor/.test(f.output) ? 'başka bir güncelleme sürüyordu — atlandı' : 'güncelleme başarısız';
  return FAIL_REASON[f.step] || f.step;
}
// Bu cihazın güncelleme durumu (update.ts; gece güncellemesi ve panel de aynı iştir) + ana cihazın son isteğinin ret
// nedeni. Ret, ondan sonra başlamış bir iş yoksa gösterilir ("zaten sürüyor" ise o işin kendi sonucu); sık istekte önceki
// başarısız işin nedeni korunur. Süren işte her zaman aşama gösterilir.
function deviceUpdateState(s: SatState | null, st: UpdateStatus): UpdateState | null {
  const note = s?.update_note || '';
  const noteAt = Number(s?.update_note_at) || 0;
  const jobAt = jobAtOf(st);
  if (s && note === UPD_NOTE_STARTING && jobAt < noteAt) {
    return startInterrupted(s, st) ? { state: 'failed', reason: UPD_NOTE_INTERRUPTED, at: noteAt } : { state: 'running', reason: UPD_NOTE_STARTING, at: noteAt };
  }
  const req = !!st.id && st.id === s?.update_job ? { req: true as const } : {};
  if (st.state === 'running') return { state: 'running', reason: st.phase || '', at: jobAt, ...req };
  const why = st.state === 'failed' ? failReason(st) : '';
  if (note && note !== UPD_NOTE_RUNNING && note !== UPD_NOTE_STARTING && noteAt >= jobAt) {
    return { state: 'failed', reason: note === UPD_NOTE_RATE && why ? `${why} — yeniden istek çok erken` : note, at: noteAt };
  }
  if (st.state === 'done') return { state: 'done', reason: '', at: st.finishedAt || jobAt, ...req };
  if (st.state === 'failed') return { state: 'failed', reason: why, at: st.finishedAt || jobAt, ...req };
  return null;
}
const sameLivePairing = (d: SatState | null, s: SatState): d is SatState => !!d && isV2(d) && samePairing(d, s) && !d.revoked;
const seenOf = (d: SatState) => (Array.isArray(d.update_seen) ? d.update_seen : []).filter(n => typeof n === 'string' && NONCE_RE.test(n));
const isNewNonce = (d: SatState, nonce: string) => nonce !== d.update_nonce && !seenOf(d).includes(nonce);
// Ana cihazın güncelleme isteği (yalnız syncOnce, yalnız doğrulanmış v2 yanıtı). Yeni nonce ÖNCE diske yazılır, başlatma
// işaretiyle birlikte (yeniden başlasa da aynı istek bir daha işlenmez; aynı anda iki senkron da tek iş başlatır — okuma
// + yazma arada beklemesiz; iş durumu bu yüzden önceden okunur), sonra son başlatmadan 10 dk geçtiyse bu cihazın kendi
// güncellemesi (startUpdate: systemd-run → update-job.sh → GitHub). true = yeni istek işlendi.
async function acceptUpdateRequest(s: SatState, nonce: string): Promise<boolean> {
  if (!isV2(s) || !NONCE_RE.test(nonce)) return false;
  const pre = readSatState();
  if (!sameLivePairing(pre, s) || !isNewNonce(pre, nonce)) return false; // bilinen istek: iş durumu hiç okunmaz
  const job = await jobStatus();
  const disk = readSatState();
  if (!sameLivePairing(disk, s) || !isNewNonce(disk, nonce)) return false;
  const now = Math.floor(Date.now() / 1000);
  const last = lastStart(disk, job);
  const limited = gapLeft(last, now) > 0;
  const upd: UpdFields = {
    update_nonce: nonce,
    update_seen: [...new Set([disk.update_nonce, ...seenOf(disk)].filter((n): n is string => !!n && NONCE_RE.test(n)))].slice(0, UPDATE_SEEN_MAX),
    last_update_start: limited ? last : now,
    update_note: limited ? UPD_NOTE_RATE : UPD_NOTE_STARTING,
    update_note_at: now,
    update_job: disk.update_job,
  };
  writeSatState(disk, undefined, upd);
  Object.assign(s, upd);
  if (limited) {
    await recordEvent('mesh', `Ana cihaz güncelleme istedi — başlatılmadı: ${UPD_NOTE_RATE}`, 'warning');
    return true;
  }
  let note = '';
  try {
    updStarting = nonce;
    let jobId = '';
    try {
      const r = await startUpdate();
      jobId = r.id || '';
      if (!r.started) note = UPD_NOTE_RUNNING;
    } catch (e: any) {
      const msg = String(e?.message || '');
      note = msg === STORAGE_BUSY_MSG ? UPD_NOTE_STORAGE : /okunamadı/.test(msg) ? 'güncelleme durumu okunamadı' : 'başlatılamadı';
    }
    // Sonuç (aynı istek hâlâ diskteyse) başlatma işaretinin yerine yazılır. İş başlamadıysa 10 dk sınırı bu denemeyi saymaz
    // (neden ortadan kalkınca yeni istek hemen çalışabilsin). update_job: bu isteğin sonucunu verecek iş — başlatılan ya da
    // istek geldiğinde zaten süren.
    const res: UpdFields = note
      ? { ...upd, last_update_start: last || undefined, update_note: note, update_note_at: Math.floor(Date.now() / 1000),
        update_job: note === UPD_NOTE_RUNNING && jobId ? jobId : upd.update_job }
      : { ...upd, update_note: '', update_job: jobId || upd.update_job };
    const cur = readSatState();
    if (sameLivePairing(cur, s) && cur.update_nonce === nonce) writeSatState(cur, undefined, res);
    Object.assign(s, res);
  } finally {
    updStarting = ''; // sonuç yazımıyla arada bekleme yok: işaret hiçbir an "yarıda kesildi" okunmaz
  }
  if (note) {
    await recordEvent('mesh', `Ana cihaz güncelleme istedi — başlatılmadı: ${note}`, note === UPD_NOTE_RUNNING ? 'info' : 'warning');
  } else {
    await recordEvent('mesh', 'Ana cihaz güncelleme istedi — güncelleme başlatıldı (GitHub)');
    await recordEvent('update', 'Panel güncellemesi başlatıldı (ana cihazın isteği)');
  }
  return true;
}

async function satStatusReport(err = '') {
  const [n, ms, job] = await Promise.all([runKv(NET_MODE_SCRIPT, ['status'], 30000), meshStatus(), jobStatus()]);
  // Eşleşme dosyası beklemelerden SONRA okunur ve hemen değerlendirilir: başlatma işareti ile bu süreçteki başlatma bilgisi
  // (updStarting) aynı anın — süren bir başlatma, işaret silinirken "yarıda kesildi" diye bildirilmez.
  const s = readSatState();
  const upd = deviceUpdateState(s, job);
  const kv = n.code === 0 ? n.kv : {};
  const m: Record<string, string> = ms || {}; // bildirim: durum okunamazsa eskisi gibi kablo / 0 komşu
  const stations = kv.sat_wifi && kv.sat_stage !== 'none' ? [...await readHomeStations(kv.sat_wifi, BRIDGE)] : [];
  return {
    name: os.hostname(), version: versionOf(), sat_stage: kv.sat_stage || 'none', active: kv.sat_active === '1', bridge: kv.sat_br === '1',
    band: kv.sat_band || 'bg', channel: Number(kv.sat_channel) || null, backhaul: m.attached === '1' ? 'mesh' : 'wired',
    mesh_peers: Number(m.peers) || 0, stations, error: err,
    update_cap: 1, update_nonce: s && !s.revoked && s.update_nonce ? s.update_nonce : '',
    update_seen: s && !s.revoked && Array.isArray(s.update_seen) ? s.update_seen.slice(0, UPDATE_SEEN_MAX) : [], update_state: upd,
    update_retry_in: s && !s.revoked ? gapLeft(lastStart(s, job), Math.floor(Date.now() / 1000)) : 0,
  };
}
const wifiKey = (w: WifiConfig) => sha256(`${w.ssid}\n${w.psk}\n${w.band}\n${w.channel}`).slice(0, 16);
const meshKey = (m: MeshConfig) => sha256(`${m.id}\n${m.psk}\n${m.channel}`).slice(0, 16);

let applying: Promise<string> | null = null;
// Ayarı uygular; sonuç metni ('' = sorun yok). Aynı anda tek uygulama.
async function applyConfig(s: SatState, cfg: SatConfig): Promise<string> {
  const errors: string[] = [];
  const st = await runKv(NET_MODE_SCRIPT, ['status'], 30000);
  const stage = st.kv.sat_stage || 'none';
  if (cfg.wifi) {
    const w = cfg.wifi;
    const key = wifiKey(w);
    const args = ['--ssid', w.ssid, '--band', w.band, '--channel', String(w.channel)];
    if (stage === 'none') {
      const r = await runKv(NET_MODE_SCRIPT, ['sat', 'on', '--trial', String(SAT_TRIAL_S), ...args], 150000, `${w.psk}\n`);
      if (r.code !== 0) errors.push(kvErr(r, 'uydu yayını açılamadı'));
      else {
        // Köprü üzerinden ana cihaza yeniden ulaşılabiliyorsa kalıcı; ulaşılamıyorsa geri al.
        const probe = await sendSync(s, await satStatusReport());
        if (probe.ok) {
          const c = await runKv(NET_MODE_SCRIPT, ['sat', 'confirm'], 60000);
          if (c.code !== 0) errors.push(kvErr(c, 'uydu kalıcı yapılamadı'));
          else { s.applied_wifi = key; void recordEvent('mesh', `Uydu yayında: ${w.ssid} (kanal ${w.channel})`); }
        } else {
          await runKv(NET_MODE_SCRIPT, ['sat', 'rollback'], 150000);
          errors.push(`köprü üzerinden ana cihaza ulaşılamadı (${probe.error || `HTTP ${probe.status}`}) — geri alındı`);
        }
      }
    } else if (stage === 'trial') {
      const c = await runKv(NET_MODE_SCRIPT, ['sat', 'confirm'], 60000);
      if (c.code === 0) s.applied_wifi = key; else errors.push(kvErr(c, 'uydu kalıcı yapılamadı'));
    } else if (s.applied_wifi !== key) {
      const r = await runKv(NET_MODE_SCRIPT, ['sat', 'apply', ...args], 90000, `${w.psk}\n`);
      if (r.code === 0) s.applied_wifi = key; else errors.push(kvErr(r, 'yayın ayarı güncellenemedi'));
    }
  }
  const ms = await meshStatus();
  if (!ms) {
    // Durum okunamadı: omurgaya dokunulmaz (kapatılmaz, "radyo yok" sayılmaz, yeniden kurulmaz); sonraki senkronda yeniden.
    if (cfg.mesh) errors.push('kablosuz mesh durumu okunamadı — mesh ayarı sonraki senkronda denenecek');
  } else if (cfg.mesh) {
    const key = meshKey(cfg.mesh);
    if (!(ms.capable || '')) {
      if (s.applied_mesh !== 'no_radio') { s.applied_mesh = 'no_radio'; }
    } else if (s.applied_mesh !== key || ms.configured !== '1') {
      const r = await runKv(MESH_SCRIPT, ['configure', '--id', cfg.mesh.id, '--channel', String(cfg.mesh.channel), '--role', 'satellite'], 60000, `${cfg.mesh.psk}\n`);
      if (r.code === 0) s.applied_mesh = key; else errors.push(kvErr(r, 'kablosuz mesh açılamadı'));
    }
  } else if (ms.configured === '1') {
    const r = await runKv(MESH_SCRIPT, ['disable'], 60000);
    if (r.code === 0) s.applied_mesh = ''; else errors.push(kvErr(r, 'kablosuz mesh kapatılamadı'));
  }
  return errors.join('; ');
}
function applyOnce(s: SatState, cfg: SatConfig): Promise<string> {
  if (applying) return applying;
  applying = applyConfig(s, cfg).finally(() => { applying = null; });
  return applying;
}

// Uydu → ana cihaz eşleşmesi (panel ya da install.sh; ana cihazın adresi + 6 haneli kod).
export async function joinMain(main: string, code: string): Promise<{ applied: string }> {
  if (!validMainAddr(main)) throw new MeshError(400, 'Ana cihazın adresi geçersiz (ör. 192.168.1.153)');
  if (!/^\d{6}$/.test(code)) throw new MeshError(400, 'Eşleştirme kodu 6 haneli olmalı');
  const id = deviceId();
  // Uydunun MAC'i (ana cihaz yalnız kaydeder): ev ağına bağlı kart (varsayılan rotanın kartı; adı cihaza göre değişir:
  // eth0, end0, enp1s0 …), okunamazsa ilk fiziksel Ethernet kartı, o da yoksa boş.
  const macOf = async (): Promise<string> => {
    const read = (n: string) => {
      try {
        const m = fs.readFileSync(`/sys/class/net/${n}/address`, 'utf8').trim().toLowerCase();
        return MAC_RE.test(m) && m !== '00:00:00:00:00:00' ? m : '';
      } catch { return ''; }
    };
    const lan = (await getLanIdentity().catch(() => null))?.iface || '';
    if (/^[A-Za-z0-9_.-]{1,15}$/.test(lan) && read(lan)) return read(lan);
    let names: string[] = [];
    try { names = fs.readdirSync('/sys/class/net').sort(); } catch { /* /sys yok */ }
    for (const n of names) {
      const b = `/sys/class/net/${n}`;
      let type = '';
      try { type = fs.readFileSync(`${b}/type`, 'utf8').trim(); } catch { /* kart gitti */ }
      if (type !== '1' || !fs.existsSync(`${b}/device`) || fs.existsSync(`${b}/wireless`) || fs.existsSync(`${b}/phy80211`)
        || fs.existsSync(`${b}/bridge`)) continue;
      if (read(n)) return read(n);
    }
    return '';
  };
  // Şifreli kanal (v2) teklifi; eski ana cihaz alanı yok sayar ve v1 yanıt döner. İlk kullanımda güven (pairSatellite
  // üstündeki not): eşleşme anında araya giren biri taklit / v1'e düşürme yapabilir — panel hangi kanalın kurulduğunu gösterir.
  const eph = x25519Pair();
  const r = await postJson(main, '/api/mesh/pair', { code, id, name: os.hostname(), mac: await macOf(), proto: 2, pub: eph.pub });
  let s: SatState;
  let config: SatConfig;
  if (r.status === 200 && r.json?.proto === 2) {
    // v2: anahtar türetilir, ayar zarftan açılır; açılamazsa eşleşme yazılmaz.
    try {
      if (!validSatId(r.json.main_id)) throw new Error('main_id');
      const key = deriveKey(eph.privateKey, r.json.pub, id, r.json.main_id);
      config = open(key, `pair|${id}`, r.json.box).config;
      if (!config || typeof config !== 'object') throw new Error('config');
      s = { main, id, name: os.hostname(), paired_at: Math.floor(Date.now() / 1000), proto: 2, key: key.toString('hex'), seq: 0, main_id: r.json.main_id };
    } catch {
      throw new MeshError(502, 'Ana cihazın şifreli yanıtı doğrulanamadı — ana cihazda yeni kod alıp yeniden deneyin');
    }
  } else {
    if (r.status !== 200 || !/^[0-9a-f]{64}$/.test(r.json?.token || '')) {
      throw new MeshError(r.status === 0 ? 502 : 409, r.json?.error || `ana cihaz eşleştirmeyi reddetti (HTTP ${r.status})`);
    }
    s = { main, id, token: r.json.token, name: os.hostname(), paired_at: Math.floor(Date.now() / 1000) };
    config = r.json.config;
  }
  writeSatState(s);
  await recordEvent('mesh', `Ana cihazla eşleşildi: ${main}`);
  const applied = await applyOnce(s, config);
  s.last_sync = Math.floor(Date.now() / 1000);
  s.last_error = applied;
  // Ana cihaz son durumu hemen görsün (ön sınama bildirimi onaydan önceydi: "deneme"). Eşleşme bu arada kaldırıldıysa yok.
  if (writeIfCurrent(s)) await sendSync(s, await satStatusReport(applied));
  return { applied };
}

// Yeniden keşif (yalnız v2): kayıtlı adresten art arda DOĞRULANMIŞ yanıt gelmeyince (ulaşılamadı, başka bir cihazın
// yanıtı — eski adres DHCP'yle başka bir cihaza geçmiş olabilir: 404 / 409 / 401 —, açılamayan 200 ya da ana cihazın
// kendi adresinde 503) ana cihaz ağda (ağ geçidi + mDNS) eşleşmede sabitlenen kimliğiyle (main_id) aranır. Kimliği
// taşıyan her adres sırayla denenir (ağ geçidi önce, en çok 4; her birine tek senkron): kimlik yanıtı doğrulanmamıştır ve
// main_id gizli değildir — kimliği kopyalayan bir cihaz gerçeğini gizleyemesin. Adres ancak yanıt bu uydunun anahtarıyla
// açılır VE ana cihaz zarfın içinde o adresi kendi adresi sayarsa değişir (sendSyncV2). Doğrulanmış yanıt başka bir
// adresten (aktarıcı) geldiyse ana cihazın zarftaki adreslerinden bu cihazın ağındakiler önce denenir; hiçbiri olmazsa
// o yanıt işlenir ama adres değişmez (sonraki senkronda yeniden). Sahte yanıt (401, şifresiz ayar, başka anahtar) yalnız
// hata olur, eşleşmeye ve yayına dokunmaz.
// v1 eşleşmelerde yok: ana cihaz kimliğini kanıtlayamaz (main_id yok, yanıt imzasız; 401 bile uyduyu kapatır) ve
// taşıyıcı anahtar ağdaki başka bir adrese gönderilmiş olurdu — v1 uydu yeniden eşleştirilir.
const REDISCOVER_AFTER = 3;
const REDISCOVER_MAX_TRIES = 4;
// Ardışık doğrulanmamış senkron sayısı (yalnız bellekte, eşleşmeye bağlı: yeniden eşleşince sıfırdan).
let missRuns = { pairing: '', n: 0 };
type Rediscovery = { result: SyncResult | null; tried: number; fails: string[] };
async function rediscoverMain(s: SatState, status: unknown): Promise<Rediscovery | null> {
  if (!isV2(s) || !validSatId(s.main_id)) return null;
  const cur = readSatState();
  if (!cur || !samePairing(cur, s) || cur.revoked) return null;
  const curHost = cur.main.replace(/:80$/, ''); // keşif adresi port 80 (nginx): "A:80" ile "A" aynı adres
  let queue: string[];
  try {
    // Keşif sırası korunur: ağ geçidi adayı başta, sonra TXT kimliği main_id olan mDNS kayıtları.
    queue = (await discoverKlyrix()).devices.filter(d => d.id === s.main_id && d.role === 'main' && d.ip !== curHost).map(d => d.ip);
  } catch { return null; }
  if (!queue.length) return null;
  const tried = new Set<string>();
  const fails: string[] = [];
  let relayed: SyncResult | null = null;
  let nets: IfaceNet[] | null = null;
  while (queue.length && tried.size < REDISCOVER_MAX_TRIES) {
    const ip = queue.shift()!;
    if (tried.has(ip)) continue;
    tried.add(ip);
    const r = await sendSync(s, status, ip);
    if (r.stale || (r.authed && !r.mainAddrs)) return { result: r, tried: tried.size, fails };
    if (r.authed) {
      // Ana cihazın yanıtı, ama ana cihaz bu adresi kendi saymıyor: onun (doğrulanmış) adreslerinden bu cihazın
      // ağındakiler sıranın başına.
      relayed ??= r;
      nets ??= await readIfaceNets();
      const direct = r.mainAddrs!.filter(a => a !== curHost && !tried.has(a) && onLink(nets!, a));
      queue = [...direct, ...queue.filter(q => !direct.includes(q))];
    } else fails.push(r.status ? `HTTP ${r.status}` : 'ulaşılamadı');
  }
  return { result: relayed, tried: tried.size, fails };
}

// Dakikalık senkron (uydu). Eşleşme kaldırıldıysa yayın kapatılır: eski şifreyle yayın sürmesin (v1: 401; v2: yalnız
// ana cihazın anahtarıyla imzalı "revoked" — sahte bir 401 ya da düz yanıt yalnız hata olarak görünür).
export async function syncOnce(): Promise<void> {
  const s = readSatState();
  if (!s || s.revoked) return;
  const report = await satStatusReport(s.last_error || '');
  let r = await sendSync(s, report);
  // Eşleşme istek sürerken değiştiyse (kaldırıldı / yeniden eşleşildi) bu sonuç artık geçerli eşleşmenin değil.
  if (r.stale) return;
  const pairing = isV2(s) ? sha256(`${s.id}|${s.key}`) : '';
  if (missRuns.pairing !== pairing) missRuns = { pairing, n: 0 };
  missRuns.n = r.authed ? 0 : missRuns.n + 1;
  let relayNote = '';
  if (pairing && missRuns.n >= REDISCOVER_AFTER) {
    const alt = await rediscoverMain(s, report);
    if (alt?.result?.stale) return;
    if (alt?.result?.authed) {
      // Doğrulanmış yanıt: sonuç normal senkron gibi işlenir (ayar uygulanır ya da imzalı kaldırma).
      r = alt.result;
      if (alt.result.moved) {
        missRuns.n = 0;
        await recordEvent('mesh', `Ana cihaz yeni adreste bulundu: ${alt.result.moved.from} → ${alt.result.moved.to}`);
      } else {
        // Adres değişmedi: sayaç sürer, sonraki senkronda kayıtlı adres yine denenir, olmazsa yeniden aranır.
        relayNote = 'kayıtlı adresten doğrulanmış yanıt yok; ana cihazın yanıtı başka bir adres üzerinden geldi — adres değiştirilmedi';
      }
    } else if (alt) {
      // Adayların adresi ve yanıt metni gösterilmez (sahte olabilir): yalnız yerel açıklama.
      const why = [...new Set(alt.fails)].join(', ') || 'yanıt yok';
      r = { ...r, error: `${r.error} — ağda ana cihaz kimliğiyle bulunan ${alt.tried === 1 ? 'bir' : alt.tried} adres denendi, yanıtı doğrulanamadı (${why}); kayıtlı adres değişmedi` };
    }
  }
  if (r.revoked) {
    s.revoked = true;
    s.last_error = 'ana cihaz bu uydunun eşleşmesini kaldırdı — yayın kapatıldı';
    if (!writeIfCurrent(s)) return;
    await runKv(NET_MODE_SCRIPT, ['sat', 'off'], 150000);
    await runKv(MESH_SCRIPT, ['disable'], 60000);
    await recordEvent('mesh', 'Ana cihaz eşleşmeyi kaldırdı — uydu yayını kapatıldı', 'warning');
    return;
  }
  if (!r.ok || !r.config) {
    s.last_error = r.error || `ana cihaz yanıt vermedi (HTTP ${r.status})`;
    writeIfCurrent(s);
    return;
  }
  s.last_sync = Math.floor(Date.now() / 1000);
  const before = `${s.applied_wifi}|${s.applied_mesh}`;
  s.last_error = [await applyOnce(s, r.config), relayNote].filter(Boolean).join('; ');
  if (!writeIfCurrent(s)) return;
  // Ana cihazın güncelleme isteği: yalnız bu senkronun doğrulanmış (v2) yanıtından — ön sınama, takip senkronu ve v1 hiç.
  const updated = r.authed && r.update ? await acceptUpdateRequest(s, r.update) : false;
  // Bir şey uygulandıysa ya da istek işlendiyse ana cihaz yeni durumu bir sonraki dakikayı beklemeden görsün (istek kapanır).
  if (updated || `${s.applied_wifi}|${s.applied_mesh}` !== before) {
    await sendSync(s, await satStatusReport(s.last_error || ''));
  }
}

export async function leaveMain(): Promise<void> {
  await runKv(NET_MODE_SCRIPT, ['sat', 'off'], 150000);
  await runKv(MESH_SCRIPT, ['disable'], 60000);
  try { fs.unlinkSync(SAT_FILE); } catch { /* yok */ }
  await recordEvent('mesh', 'Uydu eşleşmesi kaldırıldı — yayın kapatıldı');
}

export async function satelliteState() {
  const s = readSatState();
  const [n, ms] = await Promise.all([runKv(NET_MODE_SCRIPT, ['status'], 30000), meshStatus()]);
  const kv = n.code === 0 ? n.kv : {};
  const m: Record<string, string> = ms || {};
  return {
    paired: !!s, main: s?.main || '', name: os.hostname(), paired_at: s?.paired_at || 0, last_sync: s?.last_sync || 0,
    last_error: s?.last_error || '', revoked: !!s?.revoked, proto: s ? (isV2(s) ? 2 : 1) : 0, // 2 = şifreli kanal, 1 = eski eşleşme

    sat_stage: kv.sat_stage || 'none', ssid: kv.sat_ssid || '', band: kv.sat_band || 'bg', channel: Number(kv.sat_channel) || null,
    active: kv.sat_active === '1', bridge: kv.sat_br === '1', ip: kv.sat_ip || '', guard_result: kv.guard_result || '',
    mesh: { capable: (m.capable || '').split(',').filter(Boolean), configured: m.configured === '1', attached: m.attached === '1', peers: Number(m.peers) || 0, unknown: !ms },
  };
}

let agentTimer: NodeJS.Timeout | null = null;
export function startSatelliteAgent() {
  if (agentTimer) return;
  const tick = () => { void syncOnce().catch(e => console.error('[mesh] senkron:', e?.message || e)); };
  setTimeout(tick, 15000);
  agentTimer = setInterval(tick, SYNC_INTERVAL_MS);
}

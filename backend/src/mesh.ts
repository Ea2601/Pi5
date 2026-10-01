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
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import { spawn } from 'child_process';
import { db, dbAll, dbGet, dbRun } from './db';
import { readHomeStations } from './homeWifi';
import { recordEvent, recordEventOnce } from './events';
import { getLanIdentity } from './system';

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
// kaldırılan uydu bir sonraki senkronda imzalı "kaldırıldı" yanıtını alabilsin diye anahtar 30 gün tutulur).
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
async function meshStatus(): Promise<Record<string, string>> {
  const r = await runKv(MESH_SCRIPT, ['status'], 15000);
  return r.code === 0 ? r.kv : {};
}
function readMeshPsk(): string | null {
  try { return /^\s*psk="([^"\\]{8,63})"/m.exec(fs.readFileSync(WPA_CONF, 'utf8'))?.[1] || null; } catch { return null; }
}
async function mainMesh(): Promise<MeshConfig | null> {
  const st = await meshStatus();
  if (st.configured !== '1' || st.role !== 'main') return null;
  const psk = readMeshPsk();
  const channel = Number(st.channel);
  return psk && st.id && channel ? { id: st.id, psk, channel } : null;
}

// Uydunun ayarı: ev Wi-Fi'ı (kanal uyduya göre planlanır) + kablosuz mesh omurgası.
async function configFor(satId: string): Promise<SatConfig> {
  const [wifi0, mesh] = await Promise.all([mainWifi(), mainMesh()]);
  let wifi: WifiConfig | null = null;
  if (wifi0) {
    const rows = await dbAll('SELECT id FROM mesh_satellites WHERE revoked_at IS NULL ORDER BY created_at, id');
    const idx = Math.max(0, rows.findIndex((r: any) => r.id === satId));
    wifi = { ...wifi0, channel: planChannel(wifi0.band, wifi0.channel, idx) };
  }
  return { rev: configRev(wifi, mesh), wifi, mesh };
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
  pairing = null; // tek kullanımlık
  // v2'de taşıyıcı anahtar uyduya verilmez: sütuna anahtarın özeti (keyFp) yazılır — Bearer hiç eşleşmez.
  const token = crypto.randomBytes(32).toString('hex');
  const mac = typeof body?.mac === 'string' && MAC_RE.test(body.mac.toLowerCase()) ? body.mac.toLowerCase() : null;
  const name = cleanName(body?.name);
  const now = Math.floor(Date.now() / 1000);
  if (v2) writePeerKey(body.id, v2.key); else removePeerKey(body.id); // v1'e dönen uydunun eski v2 anahtarı kalmasın
  await dbRun(`INSERT INTO mesh_satellites (id, name, mac, token_hash, ip, last_seen, status, created_at, proto, last_seq, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, mac = excluded.mac, token_hash = excluded.token_hash, ip = excluded.ip, last_seen = excluded.last_seen,
      proto = excluded.proto, last_seq = 0, revoked_at = NULL`,
  [body.id, name, mac, v2 ? keyFp(v2.key) : sha256(token), ip, now, now, v2 ? 2 : 1]);
  await recordEvent('mesh', `Uydu eklendi: ${name} (${ip})`);
  const config = await configFor(body.id);
  if (v2) return { proto: 2, main_id: v2.mainId, pub: v2.pub, box: seal(v2.key, `pair|${body.id}`, { config }) };
  let mainId = '';
  try { mainId = deviceId(); } catch { /* kimlik yazılamadı: eski yanıt aynen */ }
  return { token, config, ...(mainId ? { main_id: mainId } : {}) };
}

const satStatusOf = (raw: any) => {
  const st = raw && typeof raw === 'object' ? raw : {};
  return {
    name: cleanName(st.name), version: String(st.version || '').slice(0, 20), sat_stage: String(st.sat_stage || '').slice(0, 10),
    active: !!st.active, bridge: !!st.bridge, band: st.band === 'a' ? 'a' : 'bg', channel: Number(st.channel) || null,
    backhaul: st.backhaul === 'mesh' ? 'mesh' : 'wired', mesh_peers: Number(st.mesh_peers) || 0,
    stations: Array.isArray(st.stations) ? st.stations.map((m: any) => String(m).toLowerCase()).filter((m: string) => MAC_RE.test(m)).slice(0, 256) : [],
    error: String(st.error || '').slice(0, 200),
  };
};

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
  const row = await dbGet('SELECT id, proto, revoked_at, token_hash FROM mesh_satellites WHERE id = ?', [body.id]);
  const key = row && row.proto === 2 ? readPeerKey(body.id) : null;
  if (!keyMatches(key, row?.token_hash)) throw new MeshError(401, 'Uydu eşleşmesi yok (kaldırılmış olabilir)');
  let msg: any;
  try { msg = open(key, `sync|${body.id}|${seq}`, body.box); } catch { throw new MeshError(401, 'Uydu kimliği doğrulanamadı'); }
  if (!(await dbChanges('UPDATE mesh_satellites SET last_seq = ? WHERE id = ? AND COALESCE(last_seq, 0) < ?', [seq, body.id, seq]))) {
    throw new MeshError(409, 'yeniden oynatma — bu istek daha önce işlendi (sürerse uyduyu yeniden eşleştirin)');
  }
  const reply = (obj: unknown) => ({ proto: 2 as const, box: seal(key, `resp|${body.id}|${seq}`, obj) });
  if (row.revoked_at) return reply({ revoked: true });
  const status = satStatusOf(msg.status);
  await dbRun('UPDATE mesh_satellites SET ip = ?, last_seen = ?, status = ?, name = ? WHERE id = ?',
    [ip, Math.floor(Date.now() / 1000), JSON.stringify(status), status.name, body.id]);
  return reply({ config: await configFor(body.id) });
}

// Mezar taşları (kaldırılmış v2 uydular) listede, sayımlarda ve kanal planında yoktur.
export async function listSatellites() {
  await ensureTables();
  const now = Math.floor(Date.now() / 1000);
  const rows = await dbAll('SELECT id, name, mac, ip, last_seen, status, created_at, proto FROM mesh_satellites WHERE revoked_at IS NULL ORDER BY created_at, id');
  return rows.map((r: any) => {
    let status: any = null;
    try { status = r.status ? JSON.parse(r.status) : null; } catch { status = null; }
    return { id: r.id, name: r.name, mac: r.mac, ip: r.ip, last_seen: r.last_seen, created_at: r.created_at,
      online: !!r.last_seen && now - r.last_seen <= OFFLINE_AFTER_S, status, proto: r.proto === 2 ? 2 : 1 };
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
    await dbRun('UPDATE mesh_satellites SET revoked_at = ?, token_hash = ?, proto = 2 WHERE id = ?', [Math.floor(Date.now() / 1000), keyFp(key), id]);
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
  const id = st.role === 'main' && /^klyrix-[0-9a-f]{6}$/.test(st.id || '') ? st.id : `klyrix-${crypto.randomBytes(3).toString('hex')}`;
  const psk = (st.role === 'main' && readMeshPsk()) || crypto.randomBytes(24).toString('base64url');
  const r = await runKv(MESH_SCRIPT, ['configure', '--id', id, '--channel', String(channel), '--role', 'main'], 60000, `${psk}\n`);
  if (r.code !== 0) throw new MeshError(409, kvErr(r, 'kablosuz mesh açılamadı'));
}
export async function mainMeshState() {
  const st = await meshStatus();
  return {
    capable: (st.capable || '').split(',').filter(Boolean), configured: st.configured === '1' && st.role === 'main',
    id: st.role === 'main' ? st.id || '' : '', channel: Number(st.channel) || null, service: st.service || '',
    iface: st.iface === '1', wpa: st.wpa === '1', attached: st.attached === '1', peers: Number(st.peers) || 0,
  };
}

// ─── Uydu ───

// v1: token (taşıyıcı anahtar). v2: proto 2 + key (uyduya özel kanal anahtarı) + seq (son gönderilen sıra) + main_id.
type SatState = {
  main: string; id: string; token?: string; name: string; paired_at: number;
  proto?: 2; key?: string; seq?: number; main_id?: string;
  last_sync?: number; last_error?: string; applied_wifi?: string; applied_mesh?: string; revoked?: boolean;
};
const isV2 = (s: SatState) => s.proto === 2 && /^[0-9a-f]{64}$/.test(s.key || '');
export function readSatState(): SatState | null {
  try {
    const s = JSON.parse(fs.readFileSync(SAT_FILE, 'utf8'));
    return validMainAddr(s?.main) && validSatId(s?.id) && (/^[0-9a-f]{64}$/.test(s?.token || '') || isV2(s)) ? s : null;
  } catch { return null; }
}
// Aynı eşleşme mi (kimlik + v2 anahtarı / v1 jetonu)?
const samePairing = (a: SatState, b: SatState) => a.id === b.id && (isV2(a) ? isV2(b) && a.key === b.key : !isV2(b) && a.token === b.token);
function writeSatState(s: SatState) {
  // seq hiç geri gitmez: aynı eşleşmede başka bir akış (ön sınama, "Şimdi eşitle") bu arada daha büyük seq göndermiş olabilir.
  const disk = isV2(s) ? readSatState() : null;
  if (disk && samePairing(disk, s) && (Number(disk.seq) || 0) > (Number(s.seq) || 0)) s.seq = disk.seq;
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
// Cihaz kimliği (iki rolde de): uydu eşleşmede bunu bildirir, ana cihaz v2 eşleşmede main_id olarak döner.
export function deviceId(): string {
  const s = readSatState();
  if (s) return s.id;
  try { const id = fs.readFileSync(`${MESH_DIR}/id`, 'utf8').trim(); if (validSatId(id)) return id; } catch { /* ilk kez */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(MESH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${MESH_DIR}/id`, `${id}\n`, { mode: 0o600 });
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

// Senkron isteği (uydu → ana cihaz). ok = ana cihaz yanıtı geçerli; revoked = eşleşme kaldırıldı.
//  - v1: taşıyıcı anahtarla düz istek; 200 geçerli, 401 kaldırıldı (eskisi gibi).
//  - v2: şifreli zarf, Authorization yok. seq göndermeden ÖNCE kaydedilir (yeniden başlasa da aynı seq bir daha
//    gitmez). Yalnız bu seq'e bağlı, açılabilen yanıt kabul edilir; şifresiz, doğrulanamayan ya da 200 olmayan her yanıt
//    yalnız hatadır — v2 uydu düz yanıta hiç dönmez, kaldırılma yalnız imzalı "revoked" ile olur. İstekler sırayla gider.
//    Doğrulanmamış yanıtın metni gösterilmez (sahte bir yanıt panele yönlendirici yazı koyamasın): yalnız HTTP kodu.
//  - stale: eşleşme istek sürerken değişti (kaldırıldı / yeniden eşleşildi) — çağıran eski durumu diske yazmaz.
type SyncResult = { ok: boolean; status: number; error: string; config?: SatConfig; revoked?: boolean; stale?: boolean };
let v2Chain: Promise<unknown> = Promise.resolve();
async function sendSync(s: SatState, status: unknown): Promise<SyncResult> {
  if (!isV2(s)) {
    const r = await postJson(s.main, '/api/mesh/sync', { id: s.id, status }, s.token);
    return { ok: r.status === 200, status: r.status, error: r.json?.error || '', config: r.json?.config, revoked: r.status === 401 };
  }
  const run = v2Chain.then(() => sendSyncV2(s, status));
  v2Chain = run.catch(() => undefined);
  return run;
}
async function sendSyncV2(s: SatState, status: unknown): Promise<SyncResult> {
  const cur = readSatState();
  if (!cur || !isV2(cur) || cur.id !== s.id || cur.key !== s.key || cur.revoked) return { ok: false, status: 0, error: 'eşleşme bu arada değişti', stale: true };
  const seq = Math.max((Number(cur.seq) || 0) + 1, (Number(s.seq) || 0) + 1, Date.now());
  cur.seq = seq; s.seq = seq;
  writeSatState(cur);
  const key = Buffer.from(s.key!, 'hex');
  const r = await postJson(cur.main, '/api/mesh/sync', { id: s.id, proto: 2, seq, box: seal(key, `sync|${s.id}|${seq}`, { status }) });
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
  // Doğrulanmış kaldırma: ok değil (v1'deki 401 gibi deneme yayını geri alınır); syncOnce önce revoked'a bakar.
  if (msg.revoked === true) return { ok: false, status: 200, error: 'ana cihaz bu uydunun eşleşmesini kaldırdı', revoked: true };
  if (!msg.config || typeof msg.config !== 'object') return { ok: false, status: 200, error: 'ana cihazın yanıtında ayar yok' };
  return { ok: true, status: 200, error: '', config: msg.config };
}

const versionOf = () => { try { return JSON.parse(fs.readFileSync('/opt/pi5-gateway/version.json', 'utf8')).version || ''; } catch { return ''; } };
async function satStatusReport(err = '') {
  const [n, m] = await Promise.all([runKv(NET_MODE_SCRIPT, ['status'], 30000), meshStatus()]);
  const kv = n.code === 0 ? n.kv : {};
  const stations = kv.sat_wifi && kv.sat_stage !== 'none' ? [...await readHomeStations(kv.sat_wifi, BRIDGE)] : [];
  return {
    name: os.hostname(), version: versionOf(), sat_stage: kv.sat_stage || 'none', active: kv.sat_active === '1', bridge: kv.sat_br === '1',
    band: kv.sat_band || 'bg', channel: Number(kv.sat_channel) || null, backhaul: m.attached === '1' ? 'mesh' : 'wired',
    mesh_peers: Number(m.peers) || 0, stations, error: err,
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
  if (cfg.mesh) {
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

// Dakikalık senkron (uydu). Eşleşme kaldırıldıysa yayın kapatılır: eski şifreyle yayın sürmesin (v1: 401; v2: yalnız
// ana cihazın anahtarıyla imzalı "revoked" — sahte bir 401 ya da düz yanıt yalnız hata olarak görünür).
export async function syncOnce(): Promise<void> {
  const s = readSatState();
  if (!s || s.revoked) return;
  const r = await sendSync(s, await satStatusReport(s.last_error || ''));
  // Eşleşme istek sürerken değiştiyse (kaldırıldı / yeniden eşleşildi) bu sonuç artık geçerli eşleşmenin değil.
  if (r.stale) return;
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
  s.last_error = await applyOnce(s, r.config);
  if (!writeIfCurrent(s)) return;
  // Bir şey uygulandıysa ana cihaz yeni durumu bir sonraki dakikayı beklemeden görsün.
  if (`${s.applied_wifi}|${s.applied_mesh}` !== before) {
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
  const [n, m] = await Promise.all([runKv(NET_MODE_SCRIPT, ['status'], 30000), meshStatus()]);
  const kv = n.code === 0 ? n.kv : {};
  return {
    paired: !!s, main: s?.main || '', name: os.hostname(), paired_at: s?.paired_at || 0, last_sync: s?.last_sync || 0,
    last_error: s?.last_error || '', revoked: !!s?.revoked, proto: s ? (isV2(s) ? 2 : 1) : 0, // 2 = şifreli kanal, 1 = eski eşleşme

    sat_stage: kv.sat_stage || 'none', ssid: kv.sat_ssid || '', band: kv.sat_band || 'bg', channel: Number(kv.sat_channel) || null,
    active: kv.sat_active === '1', bridge: kv.sat_br === '1', ip: kv.sat_ip || '', guard_result: kv.guard_result || '',
    mesh: { capable: (m.capable || '').split(',').filter(Boolean), configured: m.configured === '1', attached: m.attached === '1', peers: Number(m.peers) || 0 },
  };
}

let agentTimer: NodeJS.Timeout | null = null;
export function startSatelliteAgent() {
  if (agentTimer) return;
  const tick = () => { void syncOnce().catch(e => console.error('[mesh] senkron:', e?.message || e)); };
  setTimeout(tick, 15000);
  agentTimer = setInterval(tick, SYNC_INTERVAL_MS);
}

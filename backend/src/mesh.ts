// Mesh (R2): ana cihaz ↔ uydular. Uydu ana cihazın ev Wi-Fi'ını (ağ adı, parola, bant) aynı ayarla, farklı kanalda
// yayınlar; kablosuz mesh (802.11s, scripts/mesh.sh) açıksa omurga ayarını da alır.
//  - Ana cihaz: "Uydu ekle" 6 haneli kod üretir (10 dk, tek kullanımlık, 5 hatalı denemede geçersiz). Uydu kodla
//    /api/mesh/pair'e gelir, uyduya özel uzun rastgele anahtar alır (ana cihazda yalnız SHA-256'sı saklanır). Uydu her
//    dakika /api/mesh/sync ile durumunu bildirir ve güncel ayarı alır. Bu iki uç panel şifresinden muaftır (auth.ts,
//    panel-auth.sh): kimliği kod / anahtar kanıtlar. Wi-Fi parolası yalnız eşleşmiş uyduya gider, günlüğe yazılmaz.
//  - Uydu: eşleşme bilgisi /etc/pi5-gateway/mesh/satellite.json (0600). Ayar değişince net-mode.sh sat on / apply;
//    ilk açılış denemedir: köprü üzerinden ana cihaza yeniden ulaşınca "sat confirm", ulaşamazsa geri alınır.
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import { spawn } from 'child_process';
import { dbAll, dbGet, dbRun } from './db';
import { readHomeStations } from './homeWifi';
import { recordEvent, recordEventOnce } from './events';

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

let tablesReady = false;
async function ensureTables() {
  if (tablesReady) return;
  await dbRun(`CREATE TABLE IF NOT EXISTS mesh_satellites (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mac TEXT, token_hash TEXT NOT NULL, ip TEXT, last_seen INTEGER,
    status TEXT, created_at INTEGER NOT NULL)`);
  tablesReady = true;
}

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
    const rows = await dbAll('SELECT id FROM mesh_satellites ORDER BY created_at, id');
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

// Uydunun eşleşme isteği (kimlik kodla kanıtlanır).
export async function pairSatellite(body: any, ip: string): Promise<{ token: string; config: SatConfig }> {
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
  pairing = null; // tek kullanımlık
  const token = crypto.randomBytes(32).toString('hex');
  const mac = typeof body?.mac === 'string' && MAC_RE.test(body.mac.toLowerCase()) ? body.mac.toLowerCase() : null;
  const name = cleanName(body?.name);
  const now = Math.floor(Date.now() / 1000);
  await dbRun(`INSERT INTO mesh_satellites (id, name, mac, token_hash, ip, last_seen, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, mac = excluded.mac, token_hash = excluded.token_hash, ip = excluded.ip, last_seen = excluded.last_seen`,
  [body.id, name, mac, sha256(token), ip, now, now]);
  await recordEvent('mesh', `Uydu eklendi: ${name} (${ip})`);
  return { token, config: await configFor(body.id) };
}

// Uydunun dakikalık bildirimi (kimlik anahtarla kanıtlanır).
export async function syncSatellite(auth: string | undefined, body: any, ip: string): Promise<{ config: SatConfig }> {
  await ensureTables();
  const token = /^Bearer ([0-9a-f]{64})$/.exec(String(auth || ''))?.[1];
  if (!token || !validSatId(body?.id)) throw new MeshError(401, 'Uydu kimliği doğrulanamadı');
  const row = await dbGet('SELECT id, token_hash FROM mesh_satellites WHERE id = ?', [body.id]);
  if (!row || !safeEqualHex(sha256(token), row.token_hash)) throw new MeshError(401, 'Uydu eşleşmesi yok (kaldırılmış olabilir)');
  const st = body?.status && typeof body.status === 'object' ? body.status : {};
  const status = {
    name: cleanName(st.name), version: String(st.version || '').slice(0, 20), sat_stage: String(st.sat_stage || '').slice(0, 10),
    active: !!st.active, bridge: !!st.bridge, band: st.band === 'a' ? 'a' : 'bg', channel: Number(st.channel) || null,
    backhaul: st.backhaul === 'mesh' ? 'mesh' : 'wired', mesh_peers: Number(st.mesh_peers) || 0,
    stations: Array.isArray(st.stations) ? st.stations.map((m: any) => String(m).toLowerCase()).filter((m: string) => MAC_RE.test(m)).slice(0, 256) : [],
    error: String(st.error || '').slice(0, 200),
  };
  await dbRun('UPDATE mesh_satellites SET ip = ?, last_seen = ?, status = ?, name = ? WHERE id = ?',
    [ip, Math.floor(Date.now() / 1000), JSON.stringify(status), status.name, body.id]);
  return { config: await configFor(body.id) };
}

export async function listSatellites() {
  await ensureTables();
  const now = Math.floor(Date.now() / 1000);
  const rows = await dbAll('SELECT id, name, mac, ip, last_seen, status, created_at FROM mesh_satellites ORDER BY created_at, id');
  return rows.map((r: any) => {
    let status: any = null;
    try { status = r.status ? JSON.parse(r.status) : null; } catch { status = null; }
    return { id: r.id, name: r.name, mac: r.mac, ip: r.ip, last_seen: r.last_seen, created_at: r.created_at,
      online: !!r.last_seen && now - r.last_seen <= OFFLINE_AFTER_S, status };
  });
}
export async function removeSatellite(id: string): Promise<boolean> {
  await ensureTables();
  const row = await dbGet('SELECT name FROM mesh_satellites WHERE id = ?', [id]);
  if (!row) return false;
  await dbRun('DELETE FROM mesh_satellites WHERE id = ?', [id]);
  await recordEvent('mesh', `Uydu kaldırıldı: ${row.name}`);
  return true;
}
// Çevrimiçi uyduların Wi-Fi istasyonları (ağ haritası: bu cihazlar kesin Wi-Fi).
export async function satelliteStations(): Promise<Set<string>> {
  const out = new Set<string>();
  try { for (const s of await listSatellites()) if (s.online) for (const m of s.status?.stations || []) out.add(m); } catch { /* tablo yok */ }
  return out;
}
// Çevrimdışı uydu uyarısı (5 dk'da bir; aynı uydu için saatte bir).
export async function checkOfflineSatellites() {
  try {
    const now = Math.floor(Date.now() / 1000);
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

type SatState = {
  main: string; id: string; token: string; name: string; paired_at: number;
  last_sync?: number; last_error?: string; applied_wifi?: string; applied_mesh?: string; revoked?: boolean;
};
export function readSatState(): SatState | null {
  try {
    const s = JSON.parse(fs.readFileSync(SAT_FILE, 'utf8'));
    return validMainAddr(s?.main) && validSatId(s?.id) && /^[0-9a-f]{64}$/.test(s?.token || '') ? s : null;
  } catch { return null; }
}
function writeSatState(s: SatState) {
  fs.mkdirSync(MESH_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SAT_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, SAT_FILE);
}
function satId(): string {
  const s = readSatState();
  if (s) return s.id;
  try { const id = fs.readFileSync(`${MESH_DIR}/id`, 'utf8').trim(); if (validSatId(id)) return id; } catch { /* ilk kez */ }
  const id = crypto.randomUUID();
  fs.mkdirSync(MESH_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${MESH_DIR}/id`, `${id}\n`, { mode: 0o600 });
  return id;
}

export function postJson(main: string, path: string, body: unknown, token?: string, timeoutMs = 15000): Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    const [host, port] = main.split(':');
    const data = JSON.stringify(body);
    const req = http.request({ host, port: Number(port) || 80, path, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', d => { if (s.length < 65536) s += d; });
      res.on('end', () => { let json: any = {}; try { json = JSON.parse(s); } catch { /* düz metin */ } resolve({ status: res.statusCode || 0, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
    req.on('error', e => resolve({ status: 0, json: { error: `ana cihaza ulaşılamadı: ${e.message}` } }));
    req.end(data);
  });
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
        const probe = await postJson(s.main, '/api/mesh/sync', { id: s.id, status: await satStatusReport() }, s.token);
        if (probe.status === 200) {
          const c = await runKv(NET_MODE_SCRIPT, ['sat', 'confirm'], 60000);
          if (c.code !== 0) errors.push(kvErr(c, 'uydu kalıcı yapılamadı'));
          else { s.applied_wifi = key; void recordEvent('mesh', `Uydu yayında: ${w.ssid} (kanal ${w.channel})`); }
        } else {
          await runKv(NET_MODE_SCRIPT, ['sat', 'rollback'], 150000);
          errors.push(`köprü üzerinden ana cihaza ulaşılamadı (${probe.json?.error || `HTTP ${probe.status}`}) — geri alındı`);
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
  const id = satId();
  const macOf = () => { try { return fs.readFileSync('/sys/class/net/eth0/address', 'utf8').trim().toLowerCase(); } catch { return ''; } };
  const r = await postJson(main, '/api/mesh/pair', { code, id, name: os.hostname(), mac: macOf() });
  if (r.status !== 200 || !/^[0-9a-f]{64}$/.test(r.json?.token || '')) {
    throw new MeshError(r.status === 0 ? 502 : 409, r.json?.error || `ana cihaz eşleştirmeyi reddetti (HTTP ${r.status})`);
  }
  const s: SatState = { main, id, token: r.json.token, name: os.hostname(), paired_at: Math.floor(Date.now() / 1000) };
  writeSatState(s);
  await recordEvent('mesh', `Ana cihazla eşleşildi: ${main}`);
  const applied = await applyOnce(s, r.json.config);
  s.last_sync = Math.floor(Date.now() / 1000);
  s.last_error = applied;
  writeSatState(s);
  // Ana cihaz son durumu hemen görsün (ön sınama bildirimi onaydan önceydi: "deneme").
  await postJson(main, '/api/mesh/sync', { id, status: await satStatusReport(applied) }, s.token);
  return { applied };
}

// Dakikalık senkron (uydu). Eşleşme kaldırıldıysa yayın kapatılır: eski şifreyle yayın sürmesin.
export async function syncOnce(): Promise<void> {
  const s = readSatState();
  if (!s || s.revoked) return;
  const r = await postJson(s.main, '/api/mesh/sync', { id: s.id, status: await satStatusReport(s.last_error || '') }, s.token);
  if (r.status === 401) {
    s.revoked = true;
    s.last_error = 'ana cihaz bu uydunun eşleşmesini kaldırdı — yayın kapatıldı';
    writeSatState(s);
    await runKv(NET_MODE_SCRIPT, ['sat', 'off'], 150000);
    await runKv(MESH_SCRIPT, ['disable'], 60000);
    await recordEvent('mesh', 'Ana cihaz eşleşmeyi kaldırdı — uydu yayını kapatıldı', 'warning');
    return;
  }
  if (r.status !== 200 || !r.json?.config) {
    s.last_error = r.json?.error || `ana cihaz yanıt vermedi (HTTP ${r.status})`;
    writeSatState(s);
    return;
  }
  s.last_sync = Math.floor(Date.now() / 1000);
  const before = `${s.applied_wifi}|${s.applied_mesh}`;
  s.last_error = await applyOnce(s, r.json.config);
  writeSatState(s);
  // Bir şey uygulandıysa ana cihaz yeni durumu bir sonraki dakikayı beklemeden görsün.
  if (`${s.applied_wifi}|${s.applied_mesh}` !== before) {
    await postJson(s.main, '/api/mesh/sync', { id: s.id, status: await satStatusReport(s.last_error || '') }, s.token);
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
    last_error: s?.last_error || '', revoked: !!s?.revoked,
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

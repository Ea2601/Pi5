// Bulut yedeği (scripts/vault.sh'nin panel tarafı): restic ile kullanıcının KENDİ S3 uyumlu kovasına (Cloudflare R2,
// Backblaze B2, AWS S3, MinIO / özel) istemci tarafında şifreli yedek. Klyrix hiçbir hesabı ve anahtarı görmez; kullanıcı
// kendi kovasını bağlamadıkça cihazdan hiçbir şey çıkmaz.
//  - Yapılandırma /etc/pi5-gateway/vault/vault.conf (0600, KEY=VALUE, geçici dosya + rename). ASLA app_settings'te
//    değil: app_settings yedeğe (dışa aktarma) bütünüyle girer. Son sonuçlar ve bildirim kaydı da aynı klasörde (last).
//  - Kullanıcının parolası yalnız bağlanırken /run/pi5-vault/user.pass'e (0600) yazılır, iş siler; parola cihazda
//    saklanmaz, depoya rastgele cihaz anahtarıyla (device.key) erişilir. Erişim anahtarı (S3) vault.conf'tadır — ikisi de
//    yalnız root okur. Gizli değerler hiçbir yanıtta dönmez (anahtar kimliğinin son 4 hanesi görünür).
//  - İşler pi5-backend'in DIŞINDA koşar (systemd-run → pi5-vault birimi, storage.ts deseni): betik önce
//    /run/pi5-vault/vault-job.sh'ye kopyalanır (güncellemenin git reset'i çalışan betiği değiştiremesin), panel servisi
//    yeniden başlasa da iş sürer; açılışta startVaultWatch yeniden izler. Depolama işi (pi5-storage) ve panel güncellemesi
//    (pi5-update) sürerken başlamaz; depolama işi de bulut yedeği sürerken başlamaz (storage.ts). Güncelleme yedeği beklemez.
//  - Zamanlayıcı (yalnız ana cihaz): her gün HH:MM (varsayılan 04:30 — 03:30 güncellemesi ve 04:00 gravity'den sonra),
//    kaçırılan gün açılışta yakalanır (saat NTP ile eşitlendikten sonra), geçici bir hatada aynı gün 30 dk arayla en çok 3
//    kez yeniden denenir; Pazar günleri eski anlık görüntüler budanır. Yedek hattayken (failover) dosyalar atlanır,
//    ayarlar yine yedeklenir.
//  - Yedeklenen ayarlar = /api/backup/export'un AYNISI (index.ts buildBackupExport, startVaultWatch ile verilir — bu modül
//    index.ts'i içe aktarmaz); gizli anahtar paketi yalnız kullanıcı açarsa (varsayılan kapalı).
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { isLinux, readFailoverStatus } from './system';
import { dbAll, dbGet } from './db';
import { recordEvent, recordEventOnce } from './events';
import { parseKv } from './update';
import { STARTUP_ROLE, isSatellite } from './role';
import { holdJobGate, freeJobGate } from './storage';

const execFileP = promisify(execFile);

const VAULT_DIR = process.env.PI5_VAULT_DIR || '/etc/pi5-gateway/vault';
const CONF_FILE = `${VAULT_DIR}/vault.conf`;
const KEY_FILE = `${VAULT_DIR}/device.key`;
const LAST_FILE = `${VAULT_DIR}/last`;
const RUN_DIR = process.env.PI5_VAULT_RUN || '/run/pi5-vault';
const JOB_STATE = `${RUN_DIR}/state`;
const JOB_OUTPUT = `${RUN_DIR}/output`;
const JOB_SCRIPT = `${RUN_DIR}/vault-job.sh`;
const STAGE_DIR = `${RUN_DIR}/stage`;
const PASS_FILE = `${RUN_DIR}/user.pass`;
const PENDING_FILE = `${RUN_DIR}/pending.conf`;
const KEY_NEW = `${RUN_DIR}/device.key.new`;   // bağlanırken üretilen cihaz anahtarı (tmpfs; iş yerine koyar)
const JOB_LOCK = '/run/pi5-vault.lock';
const WG_DIR = process.env.PI5_VAULT_WG_DIR || '/etc/wireguard';
const BASE = path.resolve(__dirname, '../..');
const SCRIPT = path.join(BASE, 'scripts/vault.sh');
const UNIT = 'pi5-vault';
const START_GRACE_S = 15;
const RUNTIME_SHORT_S = 900;        // bağlanma, yalnız ayarlar, bağlantıyı kaldırma
const RUNTIME_FILES_S = 12 * 3600;  // dosyalar: kesilirse restic sonraki turda kaldığı yerden sürdürür
const STALE_WARN_DAYS = 3;
// "512 MB sınıfı" kartlar (Pi Zero 2 W, Pi 3A+): MemTotal fiziksel bellekten azdır (çekirdek + GPU payı) — 1 GB'lık bir
// kart ~0.9 GiB görünür, bu yüzden eşik 1 GiB değil 768 MiB.
const LOW_MEM_BYTES = 768 * 1024 ** 2;

// ── yapılandırma ─────────────────────────────────────────────────────────────
export const PROVIDERS = ['r2', 'b2', 'aws', 'custom'] as const;
export type Provider = typeof PROVIDERS[number];
export interface VaultConf {
  provider: Provider; endpoint: string; region: string; bucket: string; prefix: string; key_id: string; secret: string;
  host: string; schedule: string; include_secrets: boolean; folders: string[];
  keep_daily: number; keep_weekly: number; keep_monthly: number; upload_kbps: number;  // upload_kbps: KiB/s (0 = sınırsız)
}
export const DEFAULTS = { schedule: '04:30', keep_daily: 7, keep_weekly: 4, keep_monthly: 6, upload_kbps: 0, prefix: 'klyrix' };

const intOr = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
const numOf = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
export function parseConf(text: string): VaultConf | null {
  const kv = parseKv(text);
  if (!kv.endpoint || !kv.bucket || !kv.key_id || !kv.secret || !kv.host) return null;
  return {
    provider: (PROVIDERS as readonly string[]).includes(kv.provider) ? kv.provider as Provider : 'custom',
    endpoint: kv.endpoint, region: kv.region || '', bucket: kv.bucket, prefix: kv.prefix || '', key_id: kv.key_id,
    secret: kv.secret, host: kv.host, schedule: /^\d{2}:\d{2}$/.test(kv.schedule || '') ? kv.schedule : DEFAULTS.schedule,
    include_secrets: kv.include_secrets === '1', folders: (kv.folders || '').split('|').filter(Boolean),
    keep_daily: intOr(kv.keep_daily, DEFAULTS.keep_daily), keep_weekly: intOr(kv.keep_weekly, DEFAULTS.keep_weekly),
    keep_monthly: intOr(kv.keep_monthly, DEFAULTS.keep_monthly), upload_kbps: intOr(kv.upload_kbps, DEFAULTS.upload_kbps),
  };
}
export function serializeConf(c: VaultConf): string {
  const rows: [string, string | number][] = [
    ['provider', c.provider], ['endpoint', c.endpoint], ['region', c.region], ['bucket', c.bucket], ['prefix', c.prefix],
    ['key_id', c.key_id], ['secret', c.secret], ['host', c.host], ['schedule', c.schedule],
    ['include_secrets', c.include_secrets ? 1 : 0], ['folders', c.folders.join('|')], ['keep_daily', c.keep_daily],
    ['keep_weekly', c.keep_weekly], ['keep_monthly', c.keep_monthly], ['upload_kbps', c.upload_kbps],
  ];
  for (const [k, v] of rows) if (/[\r\n]/.test(String(v))) throw new Error(`Geçersiz değer: ${k}`);
  return `# Klyrix Gate bulut yedeği (panel yazar — elle düzenlemeyin)\n${rows.map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}
export const maskKeyId = (id: string) => (id.length > 4 ? `••••${id.slice(-4)}` : '••••');

function writeFile0600(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });  // yarım yazılmış parola / gizli anahtar kalmasın (ör. /run doldu)
    throw e;
  }
}
export function readConf(): VaultConf | null {
  try { return parseConf(fs.readFileSync(CONF_FILE, 'utf8')); } catch { return null; }
}
function writeConf(c: VaultConf): void {
  writeFile0600(CONF_FILE, serializeConf(c));
}
const configured = () => !!readConf() && fs.existsSync(KEY_FILE);
// Bu cihazda bulut yedeği bilgisi (erişim anahtarı ya da depoyu açan cihaz anahtarı) var mı — bağlantı yarım kalmış olsa da
export const vaultLeftover = () => [CONF_FILE, KEY_FILE].some(f => fs.existsSync(f));

// Son sonuçlar + bildirim kaydı (KEY=VALUE): attempt (zamanlayıcının son günü), ok_config / ok_files (zaman damgası),
// state / msg / error / finished / cmd (son iş), forget (son budama günü), connected, files_skipped, notified (iş kimliği).
type Last = Record<string, string>;
function readLast(): Last {
  try { return parseKv(fs.readFileSync(LAST_FILE, 'utf8')); } catch { return {}; }
}
function writeLast(l: Last): void {
  writeFile0600(LAST_FILE, Object.entries(l).filter(([, v]) => v !== '' && v !== undefined)
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n');
}

// ── doğrulama ────────────────────────────────────────────────────────────────
const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Uç nokta: https; http yalnız özel / yerel bir adreste (ev ağındaki MinIO) — internete şifresiz anahtar gitmesin.
export function checkEndpoint(provider: Provider, raw: unknown): { endpoint: string; region?: string } {
  const e = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '').toLowerCase() : '';
  const m = /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(e);
  if (!m) throw new Error('Uç nokta adresi https://ad[:port] biçiminde olmalı (yol yok)');
  const [, scheme, hostName, port] = m;
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error('Uç nokta portu geçersiz');
  if (provider === 'r2') {
    if (!/^[a-f0-9]{32}\.(eu\.|fedramp\.)?r2\.cloudflarestorage\.com$/.test(hostName) || scheme !== 'https' || port) {
      throw new Error('Cloudflare R2 uç noktası https://<HESAP_KİMLİĞİ>.r2.cloudflarestorage.com olmalı (32 haneli hesap kimliği)');
    }
    return { endpoint: e, region: 'auto' };
  }
  if (provider === 'b2') {
    const b = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(hostName);
    if (!b || scheme !== 'https' || port) throw new Error('Backblaze B2 uç noktası https://s3.<bölge>.backblazeb2.com olmalı');
    return { endpoint: e, region: b[1] };
  }
  if (provider === 'aws') {
    const a = /^s3\.([a-z0-9-]+)\.amazonaws\.com$/.exec(hostName);
    if (!a || scheme !== 'https' || port) throw new Error('AWS S3 uç noktası https://s3.<bölge>.amazonaws.com olmalı');
    return { endpoint: e, region: a[1] };
  }
  if (scheme === 'http' && !(hostName === 'localhost' || PRIVATE_V4.test(hostName))) {
    throw new Error('Şifresiz (http) uç nokta yalnız ev ağındaki bir adreste (ör. http://192.168.1.10:9000) kullanılabilir; internetteki depolar için https');
  }
  return { endpoint: e };
}
// S3 kova adı kuralları: 3-63, küçük harf / rakam / nokta / tire, harf ya da rakamla başlar ve biter, IP biçiminde değil.
export function checkBucket(raw: unknown): string {
  const b = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) || b.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(b) || b.startsWith('xn--')
    || b.endsWith('-s3alias')) {
    throw new Error('Kova adı 3-63 karakter olmalı: küçük harf, rakam, nokta ve tire; harf ya da rakamla başlayıp biter');
  }
  return b;
}
export function checkPrefix(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!p) return DEFAULTS.prefix;
  if (p.length > 64 || !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(p)) throw new Error('Ön ek yalnız küçük harf, rakam, tire ve / içerebilir (en çok 64)');
  return p;
}
export function checkKeys(keyId: unknown, secret: unknown): { key_id: string; secret: string } {
  const k = typeof keyId === 'string' ? keyId.trim() : '';
  const s = typeof secret === 'string' ? secret.trim() : '';
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(k)) throw new Error('Erişim anahtarı kimliği geçersiz (harf, rakam, . _ -)');
  if (!/^[A-Za-z0-9/+=._-]{8,128}$/.test(s)) throw new Error('Gizli erişim anahtarı geçersiz (8-128 karakter; harf, rakam, / + = . _ -)');
  return { key_id: k, secret: s };
}
// Parola yalnız bağlanırken kullanılır, saklanmaz. restic parola dosyasının sonundaki boşluğu siler: boşlukla
// başlayan / biten parola başka bir araçta açılmayabilir.
export function checkPassphrase(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 12 || raw.length > 256) throw new Error('Parola en az 12 karakter olmalı');
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error('Parola satır sonu ya da denetim karakteri içeremez');
  if (raw.trim() !== raw) throw new Error('Parola boşlukla başlayıp bitemez');
  return raw;
}
// Cihaz kimliği (restic --host): saklama grupları buna göre — ana bilgisayar adı + rastgele ek (aynı adlı iki cihaz
// birbirinin anlık görüntülerini budamasın).
export function makeHost(hostname = os.hostname()): string {
  const base = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'klyrix';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

// Klasör kökü izin listesi (gerçek yol; vault.sh aynısını yeniden denetler): paylaşım alanı, ağda paylaşılan USB
// diskler, ev dizinleri, /srv. /etc, /root, /var/log, panel verileri ve Pi-hole veritabanı dışarıda (ayarlar zaten
// config.json'da). Eski sistem arşivleri (storage.sh archive → /home/<kullanıcı>/eski-sistem-arsivi-*) eski sistemin
// /etc, /root ve /opt kopyalarını taşır (parola özetleri, SSH / WireGuard anahtarları, eski panelin veritabanı): arşiv ya
// da içindeki bir klasör kök olarak seçilemez; ev dizini seçilince vault.sh arşivin etc / root / opt'unu dışarıda bırakır.
const ARCHIVE_SEG = /\/eski-sistem-arsivi-[^/]*(\/|$)/;
export function folderAllowed(real: string): boolean {
  if (ARCHIVE_SEG.test(real)) return false;
  return /^\/mnt\/klyrix-share\/Paylasim(\/.*)?$/.test(real) || /^\/mnt\/klyrix-usb\/[^/]+(\/.*)?$/.test(real)
    || /^\/home\/[^/]+(\/.*)?$/.test(real) || /^\/srv\/[^/]+(\/.*)?$/.test(real);
}
export function checkFolders(raw: unknown, realpath: (p: string) => string = p => fs.realpathSync(p)): string[] {
  if (!Array.isArray(raw)) throw new Error('Klasör listesi gerekli');
  if (raw.length > 20) throw new Error('En çok 20 klasör seçilebilir');
  const out: string[] = [];
  let core = '';
  try { core = realpath(path.join(BASE, 'core')); } catch { /* yok */ }
  for (const p of raw) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 1024 || /[|\x00-\x1f\x7f]/.test(p)) throw new Error(`Geçersiz klasör yolu: ${String(p).slice(0, 80)}`);
    let real: string;
    try { real = realpath(p); } catch { throw new Error(`Klasör bulunamadı: ${p}`); }
    if (!folderAllowed(real) || (core && (real === core || real.startsWith(`${core}/`)))) {
      throw new Error(`Bu klasör yedeklenemez: ${p} — yalnız paylaşım alanı (/mnt/klyrix-share/Paylasim), ağda paylaşılan USB diskler (/mnt/klyrix-usb/…), ev dizinleri (/home/…) ve /srv/…; eski sistem arşivleri hariç`);
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}
export function checkSchedule(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error('Saat SS:DD biçiminde olmalı (ör. 04:30)');
  return s;
}

// ── zamanlayıcı kararları (saf) ──────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Bugünün saati geçtiyse ve bugün henüz denenmediyse (kaçırılan gün = açılışta yakalama)
export function scheduleDue(schedule: string, lastAttempt: string | undefined, now: Date): boolean {
  const [h, m] = schedule.split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m && lastAttempt !== ymd(now);
}
// Otomatik yedek geçici bir nedenle başarısız olduysa (saat henüz eşitlenmedi, depoya ulaşılamadı, kilit, yarıda kesildi —
// çoğu zaman elektrik kesintisinden sonra modem ve NTP gelmeden yakalanan yedek) aynı gün 30 dk arayla en çok 3 kez
// yeniden denenir; kalıcı hatada (parola, izin, kova) ertesi gün. last: attempt (günün denendiği tarih), retry_at (sn),
// retries (o gün yapılan yeniden deneme sayısı).
export const RETRY_MAX = 3;
export const RETRY_GAP_S = 30 * 60;
const TRANSIENT = /NTP|saati|ulaşılamadı|zamanında yanıt|kilitli|sertifika|yarıda kesildi|başlatılamadı/;
export function retryDue(last: Record<string, string>, now: Date): boolean {
  const at = numOf(last.retry_at);
  return last.attempt === ymd(now) && !!at && now.getTime() / 1000 >= at && (numOf(last.retries) ?? 0) < RETRY_MAX;
}
// Başarısız otomatik işten sonra: yeniden deneme zamanı (geçici neden, gün hakkı bitmediyse) ya da yok ('')
export function retryAfter(last: Record<string, string>, error: string, startedDay: string, nowS: number): string {
  if (last.attempt !== startedDay || !TRANSIENT.test(error) || (numOf(last.retries) ?? 0) >= RETRY_MAX) return '';
  return String(nowS + RETRY_GAP_S);
}
// Sonraki otomatik yedek (sn): bugün denenmediyse bugünün saati (geçtiyse şimdi), bekleyen yeniden deneme, yoksa yarın
export function nextAutoRun(schedule: string, last: Record<string, string>, now: Date): number {
  const [h, m] = schedule.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  const nowS = Math.floor(now.getTime() / 1000);
  if (last.attempt !== ymd(now)) return Math.max(Math.floor(at.getTime() / 1000), nowS);
  const retry = numOf(last.retry_at);
  if (retry && (numOf(last.retries) ?? 0) < RETRY_MAX) return Math.max(retry, nowS);
  at.setDate(at.getDate() + 1);
  return Math.floor(at.getTime() / 1000);
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
// Pazar günleri; Pazar kaçırıldıysa son budamadan 8 gün sonra
export function forgetDue(lastForget: string | undefined, now: Date): boolean {
  const today = ymd(now);
  if (lastForget === today) return false;
  return now.getDay() === 0 || (!!lastForget && dayDiff(lastForget, today) >= 8);
}

// ── gizli anahtar paketi (isteğe bağlı) ──────────────────────────────────────
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
// /etc/wireguard/wg_vps<N>.conf → yalnız alanlar (ham metin asla: PostUp / PreUp yedeğe girmez)
export function parseWgVpsConf(text: string): { privateKey: string; serverPub: string; endpoint: string } | null {
  let section = '';
  const f: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const k = `${section}.${m[1].toLowerCase()}`;
    if (!(k in f)) f[k] = m[2].trim();
  }
  const privateKey = f['interface.privatekey'] || '', serverPub = f['peer.publickey'] || '', endpoint = f['peer.endpoint'] || '';
  if (!WG_KEY.test(privateKey) || !WG_KEY.test(serverPub) || !/^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(endpoint)) return null;
  return { privateKey, serverPub, endpoint };
}
async function buildSecrets(): Promise<Record<string, unknown>> {
  const rows = (sql: string) => dbAll(sql).catch(() => [] as any[]);  // tablo hiç oluşmamış olabilir (Ev VPN'i kurulmamış)
  const vps = await rows('SELECT * FROM vps_servers');
  const tunnels: Record<string, unknown>[] = [];
  for (const v of vps) {
    const id = Number(v?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    try {
      const t = parseWgVpsConf(fs.readFileSync(path.join(WG_DIR, `wg_vps${id}.conf`), 'utf8'));
      if (t) tunnels.push({ vpsId: id, ...t });
    } catch { /* tünel kurulmamış */ }
  }
  return {
    vps_servers: vps, vps_tunnels: tunnels, wg_clients: await rows('SELECT * FROM wg_clients'),
    wg_server: (await rows('SELECT * FROM wg_server WHERE id = 1'))[0] || null,
    wg_server_peers: await rows('SELECT * FROM wg_server_peers'), ddns_configs: await rows('SELECT * FROM ddns_configs'),
  };
}

function boardModel(): string {
  for (const f of ['/proc/device-tree/model', '/sys/class/dmi/id/product_name']) {
    try {
      const v = fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim();
      if (v) return v;
    } catch { /* yok */ }
  }
  return '';
}
function panelVersion(): { version: string; build: string } {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(BASE, 'version.json'), 'utf8'));
    return { version: String(v.version || ''), build: String(v.build ?? '') };
  } catch {
    return { version: '', build: '' };
  }
}

let exportConfig: (() => Promise<object>) | null = null;
// Hazırlık klasörü (tmpfs, 0700; dosyalar 0600): config.json = /api/backup/export'un aynısı, meta.json, isteğe bağlı
// secrets.json. İş (vault.sh) bitince siler.
export async function writeStage(c: VaultConf, exp: () => Promise<object>, stage = STAGE_DIR): Promise<void> {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.chmodSync(stage, 0o700);
  const put = (name: string, data: unknown) => {
    fs.writeFileSync(path.join(stage, name), JSON.stringify(data), { mode: 0o600 });
    fs.chmodSync(path.join(stage, name), 0o600);
  };
  put('config.json', await exp());
  const v = panelVersion();
  put('meta.json', {
    panel_version: v.version, build: v.build, role: STARTUP_ROLE, hostname: os.hostname(), created_at: new Date().toISOString(),
    board_model: boardModel(), arch: process.arch, vault_host: c.host, include_secrets: c.include_secrets,
  });
  if (c.include_secrets) put('secrets.json', await buildSecrets());
}

// ── iş (pi5-vault birimi) ────────────────────────────────────────────────────
export type VaultCmd = 'connect' | 'backup' | 'disconnect';
export interface VaultJob {
  state: 'idle' | 'running' | 'done' | 'failed';
  id?: string; cmd?: VaultCmd; step?: string; pct?: number; msg?: string; error?: string;
  startedAt?: number; finishedAt?: number; log?: string[];
}
const CMD_LABEL: Record<VaultCmd, string> = { connect: 'Bulut deposuna bağlanma', backup: 'Bulut yedeği', disconnect: 'Bağlantıyı kaldırma' };

function readJobState(): Record<string, string> | null {
  try { return parseKv(fs.readFileSync(JOB_STATE, 'utf8')); } catch { return null; }
}
function writeJobState(text: string): void {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${JOB_STATE}.b${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, JOB_STATE);
}
function jobLog(lines = 40): string[] {
  try {
    const buf = fs.readFileSync(JOB_OUTPUT);
    // restic anahtar yazmaz; yine de günlükte gizli anahtar görünmesin (bağlanırken bekleyen yapılandırmadaki dahil)
    const secrets = [CONF_FILE, PENDING_FILE]
      .map(f => { try { return parseKv(fs.readFileSync(f, 'utf8')).secret || ''; } catch { return ''; } }).filter(Boolean);
    return buf.subarray(Math.max(0, buf.length - 65536)).toString('utf8').split('\n').filter(Boolean).slice(-lines)
      .map(l => secrets.reduce((acc, sec) => acc.split(sec).join('***'), l));
  } catch {
    return [];
  }
}

// systemctl okunamazsa 'unknown': süren bir işi yanlışlıkla "yarıda kesildi" saymayalım, ikinci iş de başlatmayalım.
async function unitState(unit: string): Promise<'active' | 'inactive' | 'unknown'> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', '-p', 'ActiveState', '--value', `${unit}.service`], { timeout: 5000 });
    return /^(active|activating|deactivating|reloading)$/.test(stdout.trim()) ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

const OOM_TEXT = 'Bellek yetmedi (restic) — klasör sayısını azaltın ya da yalnız ayarları yedekleyin';
// pi5-vault biriminin bu işe ait günlüğünde OOM öldürmesi var mı (systemd: "killed by the OOM killer"). Okunamazsa
// false: genel ileti gösterilir.
async function unitOomKilled(startedAt?: number): Promise<boolean> {
  if (!isLinux) return false;
  try {
    const since = startedAt && startedAt > 0 ? [`--since=@${startedAt}`] : [];
    const { stdout } = await execFileP('journalctl', ['-u', `${UNIT}.service`, ...since, '-o', 'cat', '--no-pager', '-n', '200'],
      { timeout: 5000, maxBuffer: 1 << 20 });
    return /killed by the OOM killer|Failed with result 'oom-kill'/.test(stdout);
  } catch {
    return false;
  }
}

export async function vaultJob(): Promise<VaultJob> {
  const kv = readJobState();
  if (!kv?.id) return { state: 'idle' };
  const base = {
    id: kv.id, cmd: kv.cmd as VaultCmd, step: kv.step || undefined, pct: numOf(kv.pct), msg: kv.msg || undefined,
    error: kv.error || undefined, startedAt: numOf(kv.started), finishedAt: numOf(kv.finished), log: jobLog(),
  };
  if (kv.state === 'running') {
    const young = Math.floor(Date.now() / 1000) - (base.startedAt ?? 0) < START_GRACE_S;
    if (young || (await unitState(UNIT)) !== 'inactive') return { ...base, state: 'running' };
    // Betik sonucu yazamadan öldüyse (bellek sınırında çekirdek restic'ten sonra betiğin kendisini de seçebilir) neden
    // birimin günlüğünden okunur: OOM ise "Bellek yetmedi", değilse genel ileti.
    const oom = await unitOomKilled(base.startedAt);
    return {
      ...base, state: 'failed',
      error: oom ? OOM_TEXT : 'İş yarıda kesildi — ayrıntı aşağıdaki günlükte',
    };
  }
  return { ...base, state: kv.state === 'done' ? 'done' : 'failed' };
}

// Bu işin dosyaları (parola, bekleyen bağlantı, yeni cihaz anahtarı, hazırlık) iş yoksa /run'da kalmasın (iş
// başlatılamadıysa / öldüyse — SIGKILL ya da bellek yetmezliğinde vault.sh'nin EXIT tuzağı çalışmaz).
function removeJobFiles(): void {
  for (const f of [PASS_FILE, PENDING_FILE, KEY_NEW]) fs.rmSync(f, { force: true });
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
}
// Yarım kalmış bağlanmanın / kaldırmanın artıkları (iş yokken): yapılandırma yokken cihaz anahtarı işe yaramaz ama depoyu
// açar ("bağlı değil" görünür, Bağlantıyı kaldır da silemezdi); yarım yazılmış geçici dosyalar gizli anahtar taşıyabilir.
function removeOrphanFiles(): void {
  let names: string[] = [];
  try { names = fs.readdirSync(VAULT_DIR); } catch { return; }
  for (const n of names) if (/^(vault\.conf|device\.key|last)\.(tmp|new)/.test(n)) fs.rmSync(path.join(VAULT_DIR, n), { force: true });
  if (!fs.existsSync(CONF_FILE)) fs.rmSync(KEY_FILE, { force: true });
}
// Biten işin artıkları: yalnız o iş hâlâ son işse ve yeni bir iş hazırlanmıyorsa (yeni işin parolası / hazırlığı silinmesin)
let launching = false;
function removeFinishedJobFiles(id: string): void {
  if (launching || readJobState()?.id !== id) return;
  removeJobFiles();
  removeOrphanFiles();
}

// Biten iş için bir kez: son sonuçlar (last) ve olay (Bildirimler). Kayıt app_settings'te DEĞİL (yedeğe girmesin).
let noting = false;
export async function noteVaultJob(): Promise<void> {
  if (noting) return;
  noting = true;
  try {
    const j = await vaultJob();
    if (!j.id || (j.state !== 'done' && j.state !== 'failed')) return;
    const last = readLast();
    if (last.notified === j.id) return;
    const kv = readJobState() || {};
    const fin = String(j.finishedAt ?? Math.floor(Date.now() / 1000));
    let next: Last = { ...last, notified: j.id, cmd: j.cmd || '', state: j.state, msg: j.msg || '', error: j.error || '', finished: fin };
    if (j.cmd === 'connect' && j.state === 'done') next = { notified: j.id, cmd: 'connect', state: 'done', msg: j.msg || '', finished: fin, connected: fin };
    if (j.cmd === 'disconnect' && j.state === 'done') next = { notified: j.id };
    if (j.cmd === 'backup') {
      if (kv.cfg_ok === '1') next.ok_config = fin;
      if (kv.files_ok === '1') next.ok_files = fin;
      if (kv.forget_ok === '1') next.forget = ymd(new Date(Number(fin) * 1000));
      next.files_skipped = kv.files_skipped || '';
      const startedDay = ymd(new Date((j.startedAt ?? Number(fin)) * 1000));
      // Günün otomatik yedeği: başarılıysa bekleyen yeniden deneme kalkar; geçici bir nedenle başarısızsa 30 dk sonra
      // yeniden denenir (retryAfter). Saatten sonra elle alınan tam yedek (slot=1) yalnız BAŞARILIYSA günün yedeği sayılır.
      if (j.state === 'done') {
        next.retry_at = '';
        if (kv.slot === '1') next.attempt = startedDay;
      } else if (kv.auto === '1') {
        next.retry_at = retryAfter(next, j.error || '', startedDay, Math.floor(Date.now() / 1000));
      }
    }
    writeLast(next);
    removeFinishedJobFiles(j.id);
    const label = j.cmd ? CMD_LABEL[j.cmd] : 'Bulut yedeği işi';
    let msg = j.msg || `${label} tamamlandı`;
    if (kv.files_skipped === 'backup' && !msg.includes('yedek hatt')) msg += ' · yedek hattayken dosyalar atlandı';
    if (j.state === 'done') await recordEvent('vault', msg, /okunamadı/.test(msg) ? 'warning' : 'info');
    else {
      const retry = numOf(next.retry_at);
      const when = retry ? ` — yeniden denenecek (${new Date(retry * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})` : '';
      await recordEvent('vault', `${label} başarısız: ${j.error || 'ayrıntı Yedekleme sayfasında'}${when}`, 'warning');
    }
  } catch (e: any) {
    console.error('[bulut yedeği] iş sonucu kaydedilemedi:', e?.message || e);
  } finally {
    noting = false;
  }
}

let watchTimer: NodeJS.Timeout | null = null;
function watchJob(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    vaultJob().then(j => {
      if (j.state === 'running') return;
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      return noteVaultJob();
    }).catch(() => { /* sonraki turda */ });
  }, 10000);
}

// Meşgul: başka bir iş sürüyor (zamanlayıcı bir sonraki turda yeniden dener).
class BusyError extends Error {}
async function launch(cmd: VaultCmd, args: string[], runtimeS: number, prepare: () => Promise<string>): Promise<{ id: string }> {
  if (!isLinux) throw new Error('Bulut yedeği yalnız Pi üzerinde çalışır');
  if (isSatellite()) throw new Error('Bu cihaz uydu — bulut yedeği ana cihazdadır');
  if (!fs.existsSync(SCRIPT)) throw new Error('scripts/vault.sh bulunamadı — paneli güncelleyin');
  if (launching) throw new BusyError('Bir bulut yedeği işi başlatılıyor');
  launching = true;
  try {
    // Depolama işiyle ortak kapı (storage.ts): birim denetiminden systemd-run'a kadar — arada ayar dökümü hazırlanırken
    // bir disk hazırlama / taşıma işi başlayıp paylaşım klasörlerini ayırmaya çalışmasın
    if (holdJobGate('vault')) throw new BusyError('Depolama işi başlatılıyor — bitince yeniden deneyin');
    const [vault, storage, update] = await Promise.all([unitState(UNIT), unitState('pi5-storage'), unitState('pi5-update')]);
    if (vault === 'unknown' || storage === 'unknown' || update === 'unknown') throw new BusyError('İş durumu okunamadı (systemctl) — birazdan yeniden deneyin');
    if (vault === 'active') throw new BusyError('Bir bulut yedeği işi zaten sürüyor');
    if (storage === 'active') throw new BusyError('Depolama işi sürüyor (disk hazırlama / taşıma / paylaşım) — bitince yeniden deneyin');
    if (update === 'active') throw new BusyError('Panel güncellemesi sürüyor — bitince yeniden deneyin');
    try {
      await execFileP('flock', ['-n', JOB_LOCK, 'true'], { timeout: 5000 });
    } catch {
      throw new BusyError('Başka bir bulut yedeği işlemi sürüyor — birazdan yeniden deneyin');
    }
    fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(RUN_DIR, 0o700);
    const id = String(Date.now());
    const started = Math.floor(Date.now() / 1000);
    try {
      const extra = await prepare();
      // Çalışan iş /run'daki kopyadan okur: güncellemenin git reset'i betiği iş ortasında değiştiremez
      fs.copyFileSync(SCRIPT, JOB_SCRIPT);
      fs.chmodSync(JOB_SCRIPT, 0o700);
      fs.writeFileSync(JOB_OUTPUT, '');
      writeJobState(`id=${id}\nstate=running\ncmd=${cmd}\nstarted=${started}\npct=0\nstep=Başlatılıyor\n${extra}`);
    } catch (e) {
      // Hazırlık ya da durum yazımı başarısız (ör. /run doldu): parola, bekleyen bağlantı ve hazırlık burada silinir —
      // bu kimlikle iş yazılmadığı için sonradan hiçbir iş onları temizlemezdi
      removeJobFiles();
      throw e;
    }
    const memMb = Math.max(128, Math.floor((os.totalmem() * 0.6) / 1048576));
    try {
      // OOMPolicy=continue: bellek yetmezse çekirdek yalnız restic'i öldürür, betik "Bellek yetmedi" der (varsayılan
      // stop tüm birimi durdurur, neden "durduruldu" görünürdü). MemorySwapMax=0: sınır gerçek olsun — restic SD karttaki
      // takas dosyasına taşıp yönlendiriciyi (DNS) yavaşlatmasın.
      await execFileP('systemd-run', [
        '--quiet', '--collect', `--unit=${UNIT}`, '--service-type=exec', '--description=Klyrix Gate bulut yedeği',
        '-p', `RuntimeMaxSec=${runtimeS}`, '-p', 'Nice=10', '-p', 'IOSchedulingClass=idle', '-p', 'CPUWeight=20',
        '-p', `MemoryMax=${memMb}M`, '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=continue',
        `--setenv=PI5_VAULT_ID=${id}`, `--setenv=PI5_BASE=${BASE}`,
        '/bin/bash', JOB_SCRIPT, cmd, ...args,
      ], { timeout: 15000 });
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'systemd-run hatası';
      removeJobFiles();
      fs.writeFileSync(JOB_OUTPUT, `İş başlatılamadı: ${msg}\n`);
      writeJobState(`id=${id}\nstate=failed\ncmd=${cmd}\nstarted=${started}\nfinished=${Math.floor(Date.now() / 1000)}\nerror=İş başlatılamadı: ${msg}\n`);
      throw new Error(`Bulut yedeği işi başlatılamadı: ${msg}`);
    }
    watchJob();
    return { id };
  } finally {
    freeJobGate('vault');
    launching = false;
  }
}

// ── işlemler ─────────────────────────────────────────────────────────────────
export interface ConnectBody {
  provider?: unknown; endpoint?: unknown; region?: unknown; bucket?: unknown; prefix?: unknown; keyId?: unknown;
  secret?: unknown; passphrase?: unknown; mode?: unknown; host?: unknown;
}
// Bağlanma isteğini doğrular, yapılandırmayı kurar (henüz yazmadan). Saf: testler için ayrı.
export function connectConf(body: ConnectBody): { conf: VaultConf; passphrase: string; mode: 'new' | 'existing' } {
  const provider = (PROVIDERS as readonly string[]).includes(String(body.provider)) ? body.provider as Provider : null;
  if (!provider) throw new Error('Sağlayıcı seçin (Cloudflare R2, Backblaze B2, AWS S3 ya da Özel)');
  const mode = body.mode === 'new' || body.mode === 'existing' ? body.mode : null;
  if (!mode) throw new Error('Kip «Yeni depo» ya da «Var olan depoya bağlan» olmalı');
  const ep = checkEndpoint(provider, body.endpoint);
  const regionRaw = typeof body.region === 'string' ? body.region.trim().toLowerCase() : '';
  if (regionRaw && !/^[a-z0-9-]{1,32}$/.test(regionRaw)) throw new Error('Bölge yalnız küçük harf, rakam ve tire içerebilir');
  const region = ep.region ?? regionRaw;
  const host = typeof body.host === 'string' && body.host ? body.host.trim() : makeHost();
  if (!HOST_RE.test(host)) throw new Error('Cihaz kimliği geçersiz');
  const keys = checkKeys(body.keyId, body.secret);
  const conf: VaultConf = {
    provider, endpoint: ep.endpoint, region, bucket: checkBucket(body.bucket), prefix: checkPrefix(body.prefix), ...keys, host,
    schedule: DEFAULTS.schedule, include_secrets: false, folders: [], keep_daily: DEFAULTS.keep_daily,
    keep_weekly: DEFAULTS.keep_weekly, keep_monthly: DEFAULTS.keep_monthly, upload_kbps: DEFAULTS.upload_kbps,
  };
  return { conf, passphrase: checkPassphrase(body.passphrase), mode };
}

export async function connectVault(body: ConnectBody): Promise<{ id: string; host: string }> {
  if (fs.existsSync(CONF_FILE)) throw new Error('Bulut yedeği zaten bağlı — önce bağlantıyı kaldırın');
  const { conf, passphrase, mode } = connectConf(body);
  // Parola betiğe dosyayla verilir (komut satırı ve ortam değişkenleri süreç listesinde / systemctl show'da görünür)
  const r = await launch('connect', ['--mode', mode], RUNTIME_SHORT_S, async () => {
    writeFile0600(PENDING_FILE, serializeConf(conf));
    writeFile0600(PASS_FILE, `${passphrase}\n`);
    return '';
  });
  await recordEvent('vault', `Bulut deposuna bağlanılıyor: ${conf.bucket}/${conf.prefix} (${mode === 'new' ? 'yeni depo' : 'var olan depo'})`);
  return { ...r, host: conf.host };
}

const lowMem = () => os.totalmem() < LOW_MEM_BYTES;
// Kartın satıldığı bellek boyutu (MemTotal'ın üstündeki ikinin kuvveti: ~430 MB → 512, ~906 MB → 1024)
const memClassMb = () => 2 ** Math.ceil(Math.log2(Math.max(1, os.totalmem() / 1048576)));
export async function startBackup(what: 'config' | 'all', auto = false): Promise<{ id: string; files: boolean; forget: boolean }> {
  const c = readConf();
  if (!c || !fs.existsSync(KEY_FILE)) throw new Error('Bulut yedeği bağlı değil');
  if (!exportConfig) throw new Error('Yedek verisi hazırlanamadı (panel yeniden başlatılıyor olabilir)');
  const exp = exportConfig;
  const onBackupLine = readFailoverStatus()?.active === 'backup';
  const wantFiles = what === 'all' && c.folders.length > 0;
  const files = wantFiles && !onBackupLine;
  const forget = auto && forgetDue(readLast().forget, new Date());
  const args = ['--config-dir', STAGE_DIR, ...(files ? ['--files'] : []), ...(forget ? ['--forget'] : [])];
  // Elle alınan tam yedek (ayarlar + seçili klasörler), bugünün saati geçtiyse ve BAŞARILI biterse günün otomatik
  // yedeğinin yerini tutar (slot=1 → noteVaultJob attempt'i yazar): birkaç dakika sonra aynısı yeniden çalışmasın; başarısız
  // olursa otomatik yedek yine çalışır. Saatten önceki elle yedek o saatteki otomatik yedeği engellemez.
  const slot = !auto && (what === 'all' || !c.folders.length) && scheduleDue(c.schedule, readLast().attempt, new Date());
  const r = await launch('backup', args, files ? RUNTIME_FILES_S : RUNTIME_SHORT_S, async () => {
    await writeStage(c, exp);
    return (wantFiles && onBackupLine ? 'files_skipped=backup\n' : '') + (auto ? 'auto=1\n' : '') + (slot ? 'slot=1\n' : '');
  });
  return { ...r, files, forget };
}

export interface SettingsBody {
  schedule?: unknown; folders?: unknown; includeSecrets?: unknown; keep?: unknown; uploadKbps?: unknown; allowLowMem?: unknown;
}
export function applySettings(c: VaultConf, body: SettingsBody, opts: { lowMem: boolean; realpath?: (p: string) => string }): VaultConf {
  const next = { ...c };
  if (body.schedule !== undefined) next.schedule = checkSchedule(body.schedule);
  if (body.folders !== undefined) {
    next.folders = checkFolders(body.folders, opts.realpath);
    if (opts.lowMem && next.folders.length && body.allowLowMem !== true && !c.folders.length) {
      throw new Error('Bu cihazın belleği az (512 MB sınıfı): klasör yedeği varsayılan olarak kapalı — «yine de aç» onayıyla açılabilir');
    }
  }
  if (body.includeSecrets !== undefined) {
    if (typeof body.includeSecrets !== 'boolean') throw new Error('includeSecrets true / false olmalı');
    next.include_secrets = body.includeSecrets;
  }
  if (body.keep !== undefined) {
    const k = body.keep as Record<string, unknown> | null;
    const n = (v: unknown, max: number, label: string) => {
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error(`${label} 0-${max} arasında olmalı`);
      return v as number;
    };
    if (!k || typeof k !== 'object') throw new Error('Saklama politikası gerekli');
    next.keep_daily = n(k.daily, 90, 'Günlük');
    next.keep_weekly = n(k.weekly, 52, 'Haftalık');
    next.keep_monthly = n(k.monthly, 120, 'Aylık');
    if (next.keep_daily + next.keep_weekly + next.keep_monthly === 0) throw new Error('En az bir anlık görüntü saklanmalı');
  }
  if (body.uploadKbps !== undefined) {
    const u = body.uploadKbps;
    if (!Number.isInteger(u) || (u as number) < 0 || (u as number) > 10_000_000) throw new Error('Yükleme sınırı 0 (sınırsız) ya da pozitif bir sayı (KiB/sn) olmalı');
    next.upload_kbps = u as number;
  }
  return next;
}
export async function saveSettings(body: SettingsBody): Promise<void> {
  const c = readConf();
  if (!c) throw new Error('Bulut yedeği bağlı değil');
  const next = applySettings(c, body, { lowMem: lowMem() });
  writeConf(next);
  if (next.include_secrets !== c.include_secrets) {
    // Kapatmak eski anlık görüntüleri değiştirmez: içlerindeki gizli anahtarlar saklama süresi dolana (forget) kadar kalır
    await recordEvent('vault', next.include_secrets ? 'Bulut yedeği: gizli anahtarlar da yedeklenecek (şifreli, kendi kovanızda)'
      : `Bulut yedeği: gizli anahtarlar artık yedeklenmeyecek — önceki anlık görüntülerde saklama süresi dolana kadar (en çok ${next.keep_monthly} ay) kalır`);
  }
}

// Kısa komut (snapshots): vault.sh'yi repo yolundan çalıştırır; hata satırı "error=..." (share.ts deseni).
function runShort(args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('/bin/bash', [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('Bulut deposu zamanında yanıt vermedi')); }, timeout);
    p.stdout.on('data', d => { so += d; });
    p.stderr.on('data', d => { se += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      const err = /^error=(.*)$/m.exec(so)?.[1];
      if (err) reject(new Error(err));
      else if (code !== 0) reject(new Error(se.trim().split('\n').pop() || `vault.sh çıkış kodu ${code}`));
      else resolve(so);
    });
  });
}
export interface VaultSnapshot { id: string; time: string; hostname: string; tags: string[]; paths: string[]; files?: number; bytes?: number; added?: number }
export async function listSnapshots(repo: unknown): Promise<{ snapshots: VaultSnapshot[] }> {
  if (repo !== 'config' && repo !== 'files') throw new Error('repo config ya da files olmalı');
  if (!isLinux) throw new Error('Bulut yedeği yalnız Pi üzerinde çalışır');
  if (!configured()) throw new Error('Bulut yedeği bağlı değil');
  const out = await runShort(['snapshots', '--repo', repo]);
  let list: any[];
  try { list = JSON.parse(out.trim() || '[]'); } catch { throw new Error('Anlık görüntü listesi okunamadı'); }
  const snapshots = (Array.isArray(list) ? list : []).map(s => ({
    id: String(s.short_id || String(s.id || '').slice(0, 8)), time: String(s.time || ''), hostname: String(s.hostname || ''),
    tags: Array.isArray(s.tags) ? s.tags.map(String) : [], paths: Array.isArray(s.paths) ? s.paths.map(String) : [],
    files: s.summary?.total_files_processed, bytes: s.summary?.total_bytes_processed, added: s.summary?.data_added_packed,
  })).sort((a, b) => b.time.localeCompare(a.time));
  return { snapshots };
}

// Bağlantıyı kaldır: yerel yapılandırma + cihaz anahtarı (+ restic önbelleği). removeKey: önce bu cihazın anahtarını
// depolardan siler (iş; kullanıcının parolası gerekir — restic kullanımdaki anahtarı silmez). Depodaki yedekler kalır.
// Uyduda da çağrılabilir (yalnız yerel silme; index.ts): uydu olarak yeniden kurulan eski ana cihazda anahtarlar kalmasın.
export async function disableVault(body: { removeKey?: unknown; passphrase?: unknown }): Promise<{ id?: string }> {
  if (!vaultLeftover()) throw new Error('Bulut yedeği bağlı değil');
  if (body.removeKey === true) {
    if (!readConf()) throw new Error('Bağlantı bilgisi eksik — anahtar depodan silinemez; yalnız bu cihazdaki bilgiler silinebilir');
    const passphrase = checkPassphrase(body.passphrase);
    return launch('disconnect', ['--remove-key'], RUNTIME_SHORT_S, async () => {
      writeFile0600(PASS_FILE, `${passphrase}\n`);
      return '';
    });
  }
  if ((await vaultJob()).state === 'running') throw new Error('Bir bulut yedeği işi sürüyor — bitince yeniden deneyin');
  const id = readJobState()?.id || '';
  for (const f of [CONF_FILE, KEY_FILE, KEY_NEW]) fs.rmSync(f, { force: true });
  removeOrphanFiles();
  writeLast(id ? { notified: id } : {});
  for (const d of ['/var/cache/klyrix-vault', '/mnt/klyrix-data/vault-cache']) fs.rmSync(d, { recursive: true, force: true });
  await recordEvent('vault', 'Bulut yedeği bağlantısı kaldırıldı (depodaki yedekler kaldı)');
  return {};
}

// ── durum ────────────────────────────────────────────────────────────────────
export async function vaultStatus(): Promise<Record<string, unknown>> {
  const c = readConf();
  const last = readLast();
  const up = await dbGet('SELECT upload_mbps FROM speed_tests WHERE upload_mbps > 0 ORDER BY id DESC LIMIT 1').catch(() => null);
  const restic = ['/usr/bin/restic', '/usr/local/bin/restic'].some(p => fs.existsSync(p));
  const n = (v?: string) => numOf(v) ?? null;
  return {
    supported: isLinux, configured: !!c && fs.existsSync(KEY_FILE), hostname: os.hostname(), now: Math.floor(Date.now() / 1000),
    lowMem: lowMem(), totalMemMb: Math.round(os.totalmem() / 1048576), memClassMb: memClassMb(), restic,
    backupLine: readFailoverStatus()?.active === 'backup', lastUploadMbps: typeof up?.upload_mbps === 'number' ? up.upload_mbps : null,
    defaults: DEFAULTS,
    conf: c ? {
      provider: c.provider, endpoint: c.endpoint, region: c.region, bucket: c.bucket, prefix: c.prefix,
      keyIdMasked: maskKeyId(c.key_id), host: c.host, schedule: c.schedule, includeSecrets: c.include_secrets,
      folders: c.folders, keep: { daily: c.keep_daily, weekly: c.keep_weekly, monthly: c.keep_monthly }, uploadKbps: c.upload_kbps,
    } : null,
    last: {
      attempt: last.attempt || null, okConfig: n(last.ok_config), okFiles: n(last.ok_files), state: last.state || null,
      cmd: last.cmd || null, msg: last.msg || null, error: last.error || null, finished: n(last.finished),
      forget: last.forget || null, connected: n(last.connected), filesSkipped: last.files_skipped || null,
      retryAt: n(last.retry_at), nextRun: c ? nextAutoRun(c.schedule, last, new Date()) : null,
    },
  };
}

// Rol geçişi (index.ts /api/system/role): uyduda bulut yedeği uçları 409 döner — bu cihazdaki erişim anahtarı ve cihaz
// anahtarı panelden yönetilemez kalır, süren bir yedek de izlenmez. Uyduya geçmeden önce bağlantı kaldırılmalı.
export async function vaultBlocksSatellite(): Promise<string | null> {
  if (vaultLeftover()) return 'Önce Yedekleme → Bulut Yedeği bağlantısını kaldırın (uyduda bulut yedeği yönetilemez; bu cihazdaki erişim anahtarı kalırdı)';
  if (isLinux && (await unitState(UNIT)) !== 'inactive') return 'Bir bulut yedeği işi sürüyor — bitince yeniden deneyin';
  return null;
}

// ── izleme + zamanlayıcı ─────────────────────────────────────────────────────
let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const c = readConf();
    if (!c || !fs.existsSync(KEY_FILE)) return;
    const j = await vaultJob();
    if (j.state === 'running') return;
    // Biten işin sonucu (elle alınan yedeğin günün yedeği sayılması, yeniden deneme zamanı) karar vermeden önce yazılsın
    if (j.id) await noteVaultJob();
    const now = new Date();
    const last = readLast();
    // 3 gündür başarılı ayar yedeği yok (bağlandıktan sonra): günde en çok bir uyarı
    const ref = numOf(last.ok_config) ?? numOf(last.connected);
    if (ref && Date.now() / 1000 - ref > STALE_WARN_DAYS * 86400) {
      const since = new Date(ref * 1000).toLocaleDateString('tr-TR');
      void recordEventOnce('vault', `Bulut yedeği ${STALE_WARN_DAYS} gündür alınamadı (son başarılı: ${since}) — Yedekleme sayfasından denetleyin`, 'warning', 24 * 60);
    }
    const due = scheduleDue(c.schedule, last.attempt, now);
    if (!due && !retryDue(last, now)) return;
    // Saat henüz internet saatiyle eşitlenmediyse (açılıştan hemen sonra; RTC yok) imzalı istekler reddedilir: gün
    // harcanmadan bir sonraki turda yeniden bakılır
    if (!(await clockSynced())) return;
    try {
      await startBackup('all', true);
      const l = readLast();
      writeLast(due ? { ...l, attempt: ymd(now), retries: '0', retry_at: '' }
        : { ...l, retries: String((numOf(l.retries) ?? 0) + 1), retry_at: '' });
    } catch (e: any) {
      if (e instanceof BusyError) return;  // depolama / güncelleme sürüyor: sonraki turda
      writeLast({ ...readLast(), attempt: ymd(now) });
      await recordEventOnce('vault', `Otomatik bulut yedeği başlatılamadı: ${e?.message || e}`, 'warning', 360);
    }
  } catch (e: any) {
    console.error('[bulut yedeği] zamanlayıcı:', e?.message || e);
  } finally {
    ticking = false;
  }
}

async function clockSynced(): Promise<boolean> {
  if (new Date().getFullYear() < 2025) return false;
  try {
    const { stdout } = await execFileP('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 });
    return stdout.trim() !== 'no';
  } catch {
    return true;  // timedatectl yok / okunamadı: vault.sh yine denetler
  }
}

// Açılışta: panel servisi bir iş sürerken yeniden başladıysa izlemeyi sürdür, bittiyse sonucu bildir; zamanlayıcıyı kur.
// exportConfig: index.ts buildBackupExport (bu modül index.ts'i içe aktarmaz — startParental deseni).
export function startVaultWatch(opts: { exportConfig: () => Promise<object> }): void {
  exportConfig = opts.exportConfig;
  if (!isLinux || isSatellite()) return;
  setTimeout(() => {
    vaultJob().then(j => {
      if (j.state === 'running') return watchJob();
      if (j.id) removeFinishedJobFiles(j.id);
      else if (!launching) {
        removeJobFiles();
        removeOrphanFiles();
      }
      return noteVaultJob();
    }).catch(() => {});
  }, 8000);
  setTimeout(() => { void tick(); setInterval(() => { void tick(); }, 60000); }, 30000);
}

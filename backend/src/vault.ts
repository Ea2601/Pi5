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
import { dbAll, dbGet, dbRun } from './db';
import { recordEvent, recordEventOnce } from './events';
import { parseKv } from './update';
import { STARTUP_ROLE, isSatellite } from './role';
import { holdJobGate, freeJobGate } from './storage';
import { renderPi5VpsConf } from './ssh';
import { renderStoredConf } from './wgConf';
import { restoreWgServerRows, validatePeerName, validRole, type PeerRole, type WgServerRestore, type WgPeerRestore } from './wgServer';
import type { Request } from 'express';

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
const SYS_NET = process.env.PI5_VAULT_SYS_NET || '/sys/class/net';  // geri yüklenen tünelin arayüzü açıldı mı
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
  // Geri yükleme kipi (yeni cihazda «Buluttan geri yükle» ile bağlanınca): otomatik yedek ve budama, kullanıcı «Bu cihazdan
  // yedeklemeye devam» diyene kadar çalışmaz — yeni cihazın boş ayarları iyi yedeklerin üstüne anlık görüntü olmasın
  schedule_paused: boolean;
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
    schedule_paused: kv.schedule_paused === '1',
  };
}
export function serializeConf(c: VaultConf): string {
  const rows: [string, string | number][] = [
    ['provider', c.provider], ['endpoint', c.endpoint], ['region', c.region], ['bucket', c.bucket], ['prefix', c.prefix],
    ['key_id', c.key_id], ['secret', c.secret], ['host', c.host], ['schedule', c.schedule],
    ['include_secrets', c.include_secrets ? 1 : 0], ['folders', c.folders.join('|')], ['keep_daily', c.keep_daily],
    ['keep_weekly', c.keep_weekly], ['keep_monthly', c.keep_monthly], ['upload_kbps', c.upload_kbps],
    ...(c.schedule_paused ? [['schedule_paused', 1] as [string, number]] : []),
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
  // Yedekler: cihaz yedekleri (sync.ts — Syncthing'in eski sürümleri .stversions vault.sh'de dışarıda kalır)
  return /^\/mnt\/klyrix-share\/(Paylasim|Yedekler)(\/.*)?$/.test(real) || /^\/mnt\/klyrix-usb\/[^/]+(\/.*)?$/.test(real)
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
      throw new Error(`Bu klasör yedeklenemez: ${p} — yalnız paylaşım alanı (/mnt/klyrix-share/Paylasim), cihaz yedekleri (/mnt/klyrix-share/Yedekler), ağda paylaşılan USB diskler (/mnt/klyrix-usb/…), ev dizinleri (/home/…) ve /srv/…; eski sistem arşivleri hariç`);
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
// Sonraki otomatik yedek (sn): bugün denenmediyse bugünün saati (geçtiyse şimdi), bekleyen yeniden deneme, yoksa yarın.
// Yeniden deneme yalnız denendiği gün yapılır (retryDue: attempt === bugün): gece yarısını aşan yeniden deneme saati
// geldiğinde gün değişmiştir, o an yedek alınmaz — sıradaki yedek yarının saatidir (yalnız gösterim; zamanlayıcı tick'tedir).
export function nextAutoRun(schedule: string, last: Record<string, string>, now: Date): number {
  const [h, m] = schedule.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  const nowS = Math.floor(now.getTime() / 1000);
  if (last.attempt !== ymd(now)) return Math.max(Math.floor(at.getTime() / 1000), nowS);
  const retry = numOf(last.retry_at);
  if (retry && (numOf(last.retries) ?? 0) < RETRY_MAX && (retry <= nowS || ymd(new Date(retry * 1000)) === last.attempt)) {
    return Math.max(retry, nowS);
  }
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
export type VaultCmd = 'connect' | 'backup' | 'disconnect' | 'restore-config' | 'restore-files' | 'key-remove';
export interface VaultJob {
  state: 'idle' | 'running' | 'done' | 'failed';
  id?: string; cmd?: VaultCmd; step?: string; pct?: number; msg?: string; error?: string;
  startedAt?: number; finishedAt?: number; log?: string[];
}
const CMD_LABEL: Record<VaultCmd, string> = {
  connect: 'Bulut deposuna bağlanma', backup: 'Bulut yedeği', disconnect: 'Bağlantıyı kaldırma',
  'restore-config': 'Ayar yedeğini getirme', 'restore-files': 'Dosyaları geri yükleme', 'key-remove': 'Eski cihaz anahtarını kaldırma',
};

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

// Bellek yetmezliği: geri yükleme işlerinde yedek önerisi (klasör azaltın) anlamsız — vault.sh explain ile aynı metinler
const oomText = (cmd?: string) => (cmd === 'restore-files' || cmd === 'restore-config'
  ? 'Bellek yetmedi (restic) — geri yükleme bu cihazın belleğine sığmadı; dosyaları daha çok belleği olan bir bilgisayarda kurtarma kitindeki restic komutlarıyla açın'
  : 'Bellek yetmedi (restic) — klasör sayısını azaltın ya da yalnız ayarları yedekleyin');
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
      error: oom ? oomText(kv.cmd) : 'İş yarıda kesildi — ayrıntı aşağıdaki günlükte',
    };
  }
  return { ...base, state: kv.state === 'done' ? 'done' : 'failed' };
}

// Bu işin dosyaları (parola, bekleyen bağlantı, yeni cihaz anahtarı, hazırlık, ayar yedeğini getirirken indirilen ham
// anlık görüntü — gizli anahtarlar olabilir) iş yoksa /run'da kalmasın (iş başlatılamadıysa / öldüyse — SIGKILL ya da
// bellek yetmezliğinde vault.sh'nin EXIT tuzağı çalışmaz).
function removeJobFiles(): void {
  for (const f of [PASS_FILE, PENDING_FILE, KEY_NEW]) fs.rmSync(f, { force: true });
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  try {
    for (const n of fs.readdirSync(RUN_DIR)) if (/^restore\.tmp\.\d+$/.test(n)) fs.rmSync(path.join(RUN_DIR, n), { recursive: true, force: true });
  } catch { /* klasör yok */ }
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
    if (j.state === 'done') await recordEvent('vault', msg, /okunamadı|geri yüklenemedi/.test(msg) ? 'warning' : 'info');
    else {
      // Yeniden deneme yalnız denendiği gün yapılır (retryDue): gece yarısını aşan saat duyurulmaz (nextAutoRun gibi)
      const retry = numOf(next.retry_at);
      const when = retry && ymd(new Date(retry * 1000)) === next.attempt ? ` — yeniden denenecek (${new Date(retry * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})` : '';
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
  secret?: unknown; passphrase?: unknown; mode?: unknown; host?: unknown; restoreMode?: unknown;
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
  // Geri yükleme kipi yalnız var olan depoya bağlanırken: otomatik yedek duraklatılmış olarak başlar (resumeVault açar)
  if (body.restoreMode !== undefined && typeof body.restoreMode !== 'boolean') throw new Error('restoreMode true / false olmalı');
  if (body.restoreMode === true && mode !== 'existing') throw new Error('Buluttan geri yükleme yalnız «Var olan depoya bağlan» ile yapılır');
  const conf: VaultConf = {
    provider, endpoint: ep.endpoint, region, bucket: checkBucket(body.bucket), prefix: checkPrefix(body.prefix), ...keys, host,
    schedule: DEFAULTS.schedule, include_secrets: false, folders: [], keep_daily: DEFAULTS.keep_daily,
    keep_weekly: DEFAULTS.keep_weekly, keep_monthly: DEFAULTS.keep_monthly, upload_kbps: DEFAULTS.upload_kbps,
    schedule_paused: body.restoreMode === true,
  };
  return { conf, passphrase: checkPassphrase(body.passphrase), mode };
}

export async function connectVault(body: ConnectBody): Promise<{ id: string; host: string }> {
  if (fs.existsSync(CONF_FILE)) throw new Error('Bulut yedeği zaten bağlı — önce bağlantıyı kaldırın');
  const { conf, passphrase, mode } = connectConf(body);
  // Parola betiğe dosyayla verilir (komut satırı ve ortam değişkenleri süreç listesinde / systemctl show'da görünür)
  const r = await launch('connect', ['--mode', mode], RUNTIME_SHORT_S, async () => {
    discardRestore();  // başka bir depodan (önceki bağlantı) getirilmiş yedek bu bağlantıyla uygulanmasın
    writeFile0600(PENDING_FILE, serializeConf(conf));
    writeFile0600(PASS_FILE, `${passphrase}\n`);
    return '';
  });
  await recordEvent('vault', `Bulut deposuna bağlanılıyor: ${conf.bucket}/${conf.prefix} (${mode === 'new' ? 'yeni depo' : 'var olan depo'}${conf.schedule_paused ? ' — geri yükleme kipi: otomatik yedek duraklatıldı' : ''})`);
  return { ...r, host: conf.host };
}

const lowMem = () => os.totalmem() < LOW_MEM_BYTES;
// Kartın satıldığı bellek boyutu (MemTotal'ın üstündeki ikinin kuvveti: ~430 MB → 512, ~906 MB → 1024)
const memClassMb = () => 2 ** Math.ceil(Math.log2(Math.max(1, os.totalmem() / 1048576)));
export async function startBackup(what: 'config' | 'all', auto = false): Promise<{ id: string; files: boolean; forget: boolean }> {
  const c = readConf();
  if (!c || !fs.existsSync(KEY_FILE)) throw new Error('Bulut yedeği bağlı değil');
  if (c.schedule_paused) throw new Error('Geri yükleme kipinde yedek alınmaz — geri yüklemeyi bitirip «Bu cihazdan yedeklemeye devam» deyin');
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

// Kısa komut (snapshots, keys): vault.sh'yi repo yolundan çalıştırır; hata satırı "error=..." (share.ts deseni). Aynı
// komut sürerken gelen istek onun sonucunu bekler (tek uçuş): GET uçları yazma sınırlayıcısından geçmez ve restic panel
// servisinin belleğinde çalışır — art arda istekler (iki sekme, yenileme) ayrı restic süreçleri açmasın. Komutlar sabit
// (snapshots config / files, keys): aynı anda en çok üç restic.
const shortInflight = new Map<string, Promise<string>>();
function runShort(args: string[], timeout = 60000): Promise<string> {
  const k = args.join('\0');
  const cur = shortInflight.get(k);
  if (cur) return cur;
  const p = runShortNow(args, timeout).finally(() => shortInflight.delete(k));
  shortInflight.set(k, p);
  return p;
}
function runShortNow(args: string[], timeout: number): Promise<string> {
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
      discardRestore();  // getirilmiş yedek (gizli anahtarlar olabilir) bağlantıdan sonra kalmasın
      writeFile0600(PASS_FILE, `${passphrase}\n`);
      return '';
    });
  }
  if ((await vaultJob()).state === 'running') throw new Error('Bir bulut yedeği işi sürüyor — bitince yeniden deneyin');
  const id = readJobState()?.id || '';
  for (const f of [CONF_FILE, KEY_FILE, KEY_NEW]) fs.rmSync(f, { force: true });
  discardRestore();
  if (!launching) removeJobFiles();  // iş yok: ölmüş bir işin /run artıkları (ham anlık görüntü dahil) uyduya geçişte kalmasın
  removeOrphanFiles();
  writeLast(id ? { notified: id } : {});
  for (const d of ['/var/cache/klyrix-vault', '/mnt/klyrix-data/vault-cache']) fs.rmSync(d, { recursive: true, force: true });
  await recordEvent('vault', 'Bulut yedeği bağlantısı kaldırıldı (depodaki yedekler kaldı)');
  return {};
}

// ── buluttan geri yükleme (yeni cihaza kurtarma) ─────────────────────────────
// Akış (yeni cihazda, panel kurulu): «Buluttan geri yükle» ile var olan depoya bağlan (geri yükleme kipi: otomatik yedek
// duraklatılır) → ayar deposunun anlık görüntüleri → «Getir» (iş: vault.sh restore-config → /run/pi5-vault/restore, tmpfs)
// → önizleme (sayılar, uyarılar; gizli değer hiç dönmez) → uygula: (i) indirilen yedek dosyasının AYNI yolu
// (index.ts importBackupData: doğrulama, bu isteğe göre güvenlik duvarı kilitlenme denetimi, tek işlem, Pi'ye uygulama);
// (ii) yalnız kullanıcı isterse ve «eski cihaz kapalı» onayıyla gizli anahtarlar (sıkı doğrulama, yalnız alanlar).
// Ağ kurulumu (sabit adres, Pi DHCP, internet kartı, Wi-Fi, NetworkManager profilleri), uydu eşleşmesi, panel ve ağ
// paylaşımı parolası HİÇ geri yüklenmez: eski donanımın arayüz adlarını / adreslerini taşırlar, pi5-net-guard açılışta onlara
// göre davranıp erişimi kesebilirdi — sihirbazlarla yeniden kurulur.
const RESTORE_DIR = `${RUN_DIR}/restore`;
const RESTORE_MAX_AGE_S = 6 * 3600;  // indirilen ayarlar (gizli anahtarlar olabilir) tmpfs'te en çok bu kadar kalır
const SNAP_RE = /^[0-9a-f]{8,64}$/;
const idMatch = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);  // restic 0.14 kısa, 0.16+ tam kimlik
export function checkSnapshotId(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!SNAP_RE.test(s)) throw new Error('Anlık görüntü kimliği geçersiz');
  return s;
}

export interface ImportResult {
  success: boolean; message: string; restored_count: number; tables: Record<string, number>;
  applied: { item: string; ok: boolean; detail?: string }[]; ignored: string[];
}
let importBackup: ((backup: unknown, req: Request) => Promise<ImportResult>) | null = null;
let restoreTunnels: (() => Promise<void>) | null = null;

// Ayar yedeğini getir (iş): kimlik ayar deposunda olmalı (kısa liste) — yoksa iş hiç başlamaz. Uygulama sürerken
// başlamaz (uygulama, önizlenenin yerine yenisini almasın); başlarken önceki getirilen yedek silinir — getirme başarısız
// olursa önizlemede eski anlık görüntü kalmasın (vault.sh de işin başında siler).
let fetchStarting = false;
export async function restoreFetch(body: { snapshot?: unknown }): Promise<{ id: string }> {
  if (!configured()) throw new Error('Bulut yedeği bağlı değil');
  const snap = checkSnapshotId(body.snapshot);
  if (applyingRestore) throw new Error('Geri yükleme uygulanıyor — bitince yeniden deneyin');
  fetchStarting = true;
  try {
    const { snapshots } = await listSnapshots('config');
    if (!snapshots.some(s => idMatch(s.id, snap))) throw new Error('Bu anlık görüntü ayar deposunda yok — listeyi yenileyin');
    return await launch('restore-config', ['--snapshot', snap], RUNTIME_SHORT_S, async () => {
      if (applyingRestore) throw new BusyError('Geri yükleme uygulanıyor — bitince yeniden deneyin');
      discardRestore();
      return '';
    });
  } finally {
    fetchStarting = false;
  }
}

export function discardRestore(): void {
  fs.rmSync(RESTORE_DIR, { recursive: true, force: true });
}
// Süresi geçmiş getirilen yedeği siler (true = silindi). Önizleme / uygulama / açılış ve dakikada bir (startVaultWatch —
// bağlantı, duraklatma ve rolden bağımsız) çağrılır: getirilip uygulanmayan yedek tmpfs'te en çok RESTORE_MAX_AGE_S kalır.
function expireStaged(): boolean {
  let st: fs.Stats;
  try { st = fs.statSync(RESTORE_DIR); } catch { return false; }
  if (Date.now() - st.mtimeMs <= RESTORE_MAX_AGE_S * 1000) return false;
  discardRestore();
  return true;
}
interface Staged { snapshotId: string; fetchedAt: number; config: any; meta: Record<string, any>; secrets: unknown }
// İndirilen yedek (vault.sh: klasör 0700, dosyalar 0600). Süresi geçmişse silinir. Okunamazsa açık nedenle fırlatır.
function readStaged(): Staged | null {
  if (expireStaged()) return null;
  let st: fs.Stats;
  try { st = fs.statSync(RESTORE_DIR); } catch { return null; }
  if (!st.isDirectory()) return null;
  const read = (name: string, max: number): string | null => {
    const f = path.join(RESTORE_DIR, name);
    let s: fs.Stats;
    try { s = fs.lstatSync(f); } catch { return null; }
    if (!s.isFile()) throw new Error(`${name} düz bir dosya değil`);
    if (s.size > max) throw new Error(`${name} çok büyük`);
    return fs.readFileSync(f, 'utf8');
  };
  const json = (name: string, max: number) => {
    const t = read(name, max);
    if (t === null) return null;
    try { return JSON.parse(t); } catch { throw new Error(`Getirilen yedek okunamadı (${name})`); }
  };
  const config = json('config.json', 20 * 1024 * 1024);
  const meta = json('meta.json', 64 * 1024);
  if (!config || typeof config !== 'object' || !meta || typeof meta !== 'object') throw new Error('Getirilen yedek eksik (config.json / meta.json)');
  return {
    snapshotId: (read('snapshot.id', 128) || '').trim(), fetchedAt: Math.floor(st.mtimeMs / 1000), config, meta,
    secrets: json('secrets.json', 4 * 1024 * 1024),
  };
}

const verParts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || []).slice(1).map(Number);
// a, b'den yeni mi (2.24.88 > 2.24.87); okunamazsa false
export function versionNewer(a: string, b: string): boolean {
  const x = verParts(a), y = verParts(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Yedekteki etkin kurallardan bu cihazda KAYITLI OLMAYAN bir VPS'e yönlenenler. index.ts applyAllRoutingRulesNow kayıtlı
// olmayan VPS'e yönlenen kuralı operatör hattından (ISP) çıkarır: yedek yolu «engelle» olsa da VPS yeniden eklenene kadar
// trafik VPS yerine doğrudan operatörden gider (engelle yalnız VPS kayıtlıyken, tüneli düşünce uygulanır).
// Yedekteki etkin, bir VPS numarasına yönlenen kurallar (ad, VPS numarası, yedek yolu)
function vpsRules(data: Record<string, unknown>): { name: string; id: number; fallback: unknown }[] {
  const rows = (t: string) => (Array.isArray(data?.[t]) ? data[t] as any[] : []);
  const out: { name: string; id: number; fallback: unknown }[] = [];
  const add = (name: unknown, exit: unknown, fallback: unknown) => {
    const x = String(exit ?? '');
    if (/^\d+$/.test(x)) out.push({ name: String(name ?? '').slice(0, 80), id: Number(x), fallback });
  };
  for (const r of rows('traffic_routing')) if (Number(r?.enabled) === 1 && String(r?.domains ?? '') !== '') add(r.app_name, r.exit_node, r.vps_fallback);
  for (const r of rows('domain_routing')) if (Number(r?.enabled) === 1 && !String(r?.redirect_url ?? '')) add(r.domain, r.exit_node, r.vps_fallback);
  return out;
}
export function vpsRuleWarning(data: Record<string, unknown>, vpsHere: number[]): { ids: number[]; block: string[]; isp: string[] } {
  const ids = new Set<number>();
  const out = { block: [] as string[], isp: [] as string[] };
  for (const r of vpsRules(data)) {
    if (vpsHere.includes(r.id)) continue;
    ids.add(r.id);
    (r.fallback === 'isp' ? out.isp : out.block).push(r.name);
  }
  return { ids: [...ids].sort((a, b) => a - b), ...out };
}
// Yedekteki kurallardan bu cihazda KAYITLI bir VPS numarasına yönlenenler: geri yüklenince o numaradaki BU cihazın VPS'inden
// çıkarlar (VPS numarası yalnız sıra numarasıdır — yeni cihazda önce eklenen VPS 1 olur). Yedekteki aynı numaralı VPS (gizli
// anahtar paketinden, varsa) başka bir sunucuysa differs: kurallar farklı bir sunucudan / ülkeden çıkar.
export interface VpsBinding { id: number; ip: string; location: string; backupIp: string | null; backupLocation: string | null; differs: boolean | null; rules: string[] }
export function vpsRuleBindings(data: Record<string, unknown>, here: { id: number; ip: string; location: string }[],
  backup: { id: number; ip: string; location: string | null }[] | null): VpsBinding[] {
  const out = new Map<number, VpsBinding>();
  for (const r of vpsRules(data)) {
    const h = here.find(v => v.id === r.id);
    if (!h) continue;
    let b = out.get(r.id);
    if (!b) {
      const bv = backup ? backup.find(v => v.id === r.id) || null : null;
      b = { id: r.id, ip: h.ip, location: h.location, backupIp: bv ? bv.ip : null, backupLocation: bv ? bv.location : null,
        differs: bv ? bv.ip !== h.ip : null, rules: [] };
      out.set(r.id, b);
    }
    b.rules.push(r.name);
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

// ── gizli anahtar paketi doğrulaması (sıkı şema, bölüm bölüm) ──
// Yalnız bilinen alanlar; bir anahtara, adrese ya da yapılandırma dosyasına giden her alan biçimiyle (kimlikler, VPS adresi,
// kullanıcı adı, WireGuard anahtarları, uç nokta, istemci / cihaz adı ve adresi, DDNS adı ve sağlayıcısı). Yapılandırma metni
// hiç alınmaz: tünel dosyası doğrulanmış alanlardan renderPi5VpsConf ile yazılır (yabancı PostUp / PreUp gelemez). Kimlikler
// pozitif tam sayı (yol / metin değil). Yalnız gösterilen alanlar (konum, durum, son güncelleme, tarih) ve DDNS aralığı
// reddedilmez, düzeltilir: panelin kendisinin kabul edip sakladığı bir değer yüzünden felaket anında gizli anahtarlar geri
// yüklenemez olmasın. Bölümler (VPS + tünelleri + VPS istemcileri / Ev VPN'i / DDNS) ayrı doğrulanır: geçersiz bir bölüm
// yalnız kendisini atlatır (checkSecretsBundle); paketin kendisi (üst alanlar) geçersizse hiçbiri kullanılmaz.
export interface SecretsBundle {
  // kind 'import': hazır WireGuard yapılandırmasıyla kurulan tünel (wgImport.ts; SSH bilgisi yok) — tünel dosyası wg_conf'tan
  // wgConf.renderStoredConf ile yeniden temizlenerek yazılır; 'ssh': panelin SSH ile kurduğu VPS (renderPi5VpsConf).
  vps_servers: { id: number; ip: string; username: string; password: string | null; location: string | null; status: string | null; created_at: string | null; kind: 'ssh' | 'import'; wg_conf: string }[];
  vps_tunnels: { vpsId: number; privateKey: string; serverPub: string; endpoint: string }[];
  wg_clients: { id: number; vps_id: number; name: string; ip: string; public_key: string; config: string; qr_data: string | null; panel_access: number; created_at: string | null }[];
  wg_server: WgServerRestore | null;
  wg_server_peers: WgPeerRestore[];
  ddns_configs: Record<string, string | number | null>[];
}
export type SecretsSection = 'vps' | 'homeVpn' | 'ddns';
export const SECRETS_SECTION_LABEL: Record<SecretsSection, string> = {
  vps: 'VPS sunucuları, tünelleri ve VPS istemcileri', homeVpn: "Ev VPN'i", ddns: 'DDNS',
};
export interface SecretsCheck { bundle: SecretsBundle; errors: { section: SecretsSection; label: string; error: string }[] }
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const TS = /^[0-9:. TZ+-]{0,40}$/;
const DDNS_PROVIDERS = /^(duckdns|noip|no-ip|cloudflare|dynu|custom)$/i;
// VPS SSH kullanıcı adı (node-ssh'e gider, kabuk komutuna girmez): harf, rakam, . _ -; - ile başlamaz (seçenek sanılmasın)
const VPS_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
export const DDNS_INTERVAL_MAX = 10080;  // dk (bir hafta): daha büyüğü setInterval sınırını aşardı
export function checkSecretsBundle(raw: unknown): SecretsCheck {
  const fail = (where: string, why: string): never => { throw new Error(`Gizli anahtar paketi geçersiz: ${where} — ${why}`); };
  const obj = (v: unknown, where: string, allowed: string[], required: string[] = []): Record<string, any> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, 'nesne değil');
    const o = v as Record<string, any>;
    for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `bilinmeyen alan «${k.slice(0, 40)}» (yedek daha yeni bir panelden olabilir — paneli güncelleyin)`);
    for (const k of required) if (!(k in o)) fail(where, `«${k}» eksik`);
    return o;
  };
  const arr = (v: unknown, where: string, max = 1000): any[] => {
    if (!Array.isArray(v)) fail(where, 'liste değil');
    if ((v as any[]).length > max) fail(where, 'çok fazla kayıt');
    return v as any[];
  };
  const id = (v: unknown, where: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > 1e9) fail(where, 'kimlik pozitif bir tam sayı olmalı');
    return v as number;
  };
  // Metin: denetim karakteri yok (çok satırlı yalnız istemci yapılandırmasında); null yalnız isteğe bağlı alanlarda
  const text = (v: unknown, where: string, max: number, opt = true, multiline = false): string | null => {
    if (v === null || v === undefined) { if (opt) return null; fail(where, 'boş olamaz'); }
    if (typeof v !== 'string' || v.length > max) fail(where, 'metin değil ya da çok uzun');
    if ((multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(v as string)) fail(where, 'denetim karakteri içeremez');
    return v as string;
  };
  // Yalnız gösterilen metin: denetim karakterleri boşluğa çevrilir, uzunsa kısaltılır (reddedilmez)
  const shown = (v: unknown, max: number): string | null => (v === null || v === undefined ? null
    : String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max));
  const flag = (v: unknown, where: string): number => {
    if (v === undefined || v === null) return 0;
    if (v !== 0 && v !== 1) fail(where, '0 ya da 1 olmalı');
    return v as number;
  };
  const key = (v: unknown, where: string): string => {
    if (typeof v !== 'string' || !WG_KEY.test(v)) fail(where, 'WireGuard anahtarı değil (44 karakter base64)');
    return v as string;
  };
  // Tarih yalnız gösterilir: biçimi tanınmazsa boş (geri yüklerken o anın zamanı yazılır)
  const ts = (v: unknown): string | null => (typeof v === 'string' && TS.test(v) ? v : null);
  const uniq = (vals: (string | number)[], where: string) => { if (new Set(vals).size !== vals.length) fail(where, 'yinelenen kayıt'); };

  const b = obj(raw, 'paket', ['vps_servers', 'vps_tunnels', 'wg_clients', 'wg_server', 'wg_server_peers', 'ddns_configs'],
    ['vps_servers', 'vps_tunnels', 'wg_clients', 'wg_server', 'wg_server_peers', 'ddns_configs']);
  const errors: SecretsCheck['errors'] = [];
  const section = <T>(name: SecretsSection, fn: () => T, empty: T): T => {
    try {
      return fn();
    } catch (e: any) {
      errors.push({ section: name, label: SECRETS_SECTION_LABEL[name], error: String(e?.message || e) });
      return empty;
    }
  };

  const vpsPart = section('vps', () => {
    const vps = arr(b.vps_servers, 'vps_servers', 100).map((r, i) => {
      const w = `vps_servers[${i}]`;
      const o = obj(r, w, ['id', 'ip', 'username', 'password', 'location', 'status', 'created_at', 'kind', 'wg_conf'], ['id', 'ip', 'username']);
      const kind = o.kind === undefined || o.kind === null || o.kind === '' || o.kind === 'ssh' ? 'ssh' : o.kind === 'import' ? 'import' : null;
      if (!kind) fail(`${w}.kind`, "'ssh' ya da 'import' olmalı");
      if (typeof o.ip !== 'string' || !(IPV4.test(o.ip) || HOSTNAME.test(o.ip))) fail(`${w}.ip`, 'IPv4 adresi ya da ana bilgisayar adı olmalı');
      // İçe aktarılan tünelde SSH kullanıcısı yoktur (boş); panelin kurduğu VPS'te zorunlu
      if (typeof o.username !== 'string' || !(VPS_USER.test(o.username) || (kind === 'import' && o.username === ''))) fail(`${w}.username`, 'geçersiz kullanıcı adı');
      let wgConf = '';
      if (kind === 'import') {
        // Yapılandırma metni yalnız içe aktarma temizleyicisinden geçerse kabul edilir (yabancı PostUp / PreUp / DNS atılır)
        if (typeof o.wg_conf !== 'string' || o.wg_conf.length > 16384 || renderStoredConf(o.wg_conf) === null) fail(`${w}.wg_conf`, 'içe aktarılmış WireGuard yapılandırması geçersiz');
        wgConf = o.wg_conf as string;
      }
      return {
        id: id(o.id, `${w}.id`), ip: o.ip as string, username: o.username as string, password: text(o.password, `${w}.password`, 1024),
        location: shown(o.location, 200), status: shown(o.status, 40), created_at: ts(o.created_at), kind: kind as 'ssh' | 'import', wg_conf: wgConf,
      };
    });
    const vpsIds = vps.map(v => v.id);
    uniq(vpsIds, 'vps_servers');
    const tunnels = arr(b.vps_tunnels, 'vps_tunnels', 100).map((r, i) => {
      const w = `vps_tunnels[${i}]`;
      const o = obj(r, w, ['vpsId', 'privateKey', 'serverPub', 'endpoint'], ['vpsId', 'privateKey', 'serverPub', 'endpoint']);
      const vpsId = id(o.vpsId, `${w}.vpsId`);
      if (!vpsIds.includes(vpsId)) fail(`${w}.vpsId`, 'bu kimlikte VPS kaydı yok');
      const m = typeof o.endpoint === 'string' ? /^(.+):(\d{1,5})$/.exec(o.endpoint) : null;
      const host = m?.[1] || '';
      if (!m || !(IPV4.test(host) || HOSTNAME.test(host) || /^\[[0-9a-fA-F:]{2,39}\]$/.test(host)) || Number(m[2]) < 1 || Number(m[2]) > 65535) {
        fail(`${w}.endpoint`, 'adres:port biçiminde olmalı');
      }
      return { vpsId, privateKey: key(o.privateKey, `${w}.privateKey`), serverPub: key(o.serverPub, `${w}.serverPub`), endpoint: o.endpoint as string };
    });
    uniq(tunnels.map(t => t.vpsId), 'vps_tunnels');
    const clients = arr(b.wg_clients, 'wg_clients').map((r, i) => {
      const w = `wg_clients[${i}]`;
      const o = obj(r, w, ['id', 'vps_id', 'name', 'ip', 'public_key', 'config', 'qr_data', 'created_at', 'panel_access'],
        ['id', 'vps_id', 'name', 'ip', 'public_key', 'config']);
      const vpsId = id(o.vps_id, `${w}.vps_id`);
      if (!vpsIds.includes(vpsId)) fail(`${w}.vps_id`, 'bu kimlikte VPS kaydı yok');
      const ip = /^10\.66\.66\.(\d{1,3})(\/32)?$/.exec(String(o.ip ?? ''));
      if (typeof o.ip !== 'string' || !ip || Number(ip[1]) < 3 || Number(ip[1]) > 254) fail(`${w}.ip`, '10.66.66.3–254 olmalı');
      const qr = text(o.qr_data, `${w}.qr_data`, 262144);
      if (qr && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr)) fail(`${w}.qr_data`, 'PNG verisi değil');
      return {
        id: id(o.id, `${w}.id`), vps_id: vpsId, name: text(o.name, `${w}.name`, 64, false) as string, ip: o.ip as string,
        public_key: key(o.public_key, `${w}.public_key`), config: text(o.config, `${w}.config`, 4096, false, true) as string, qr_data: qr,
        panel_access: flag(o.panel_access, `${w}.panel_access`), created_at: ts(o.created_at),
      };
    });
    uniq(clients.map(c => c.id), 'wg_clients');
    return { vps, tunnels, clients };
  }, { vps: [] as SecretsBundle['vps_servers'], tunnels: [] as SecretsBundle['vps_tunnels'], clients: [] as SecretsBundle['wg_clients'] });

  const home = section('homeVpn', () => {
    let server: WgServerRestore | null = null;
    if (b.wg_server !== null) {
      const o = obj(b.wg_server, 'wg_server', ['id', 'private_key', 'public_key', 'enabled', 'created_at'], ['private_key', 'public_key']);
      if (o.id !== undefined && o.id !== 1) fail('wg_server.id', '1 olmalı');
      server = { private_key: key(o.private_key, 'wg_server.private_key'), public_key: key(o.public_key, 'wg_server.public_key'),
        enabled: flag(o.enabled, 'wg_server.enabled'), created_at: ts(o.created_at) };
    }
    const peers = arr(b.wg_server_peers, 'wg_server_peers', 253).map((r, i) => {
      const w = `wg_server_peers[${i}]`;
      const o = obj(r, w, ['id', 'name', 'ip', 'public_key', 'private_key', 'role', 'created_at'], ['id', 'name', 'ip', 'public_key', 'private_key', 'role']);
      const ip = /^10\.77\.77\.(\d{1,3})$/.exec(String(o.ip ?? ''));
      if (typeof o.ip !== 'string' || !ip || Number(ip[1]) < 2 || Number(ip[1]) > 254) fail(`${w}.ip`, "Ev VPN'i ağında (10.77.77.2–254) olmalı");
      if (typeof o.name !== 'string' || validatePeerName(o.name) !== o.name) fail(`${w}.name`, 'geçersiz ad');
      if (!validRole(o.role)) fail(`${w}.role`, 'admin ya da guest olmalı');
      return { id: id(o.id, `${w}.id`), name: o.name as string, ip: o.ip as string, public_key: key(o.public_key, `${w}.public_key`),
        private_key: key(o.private_key, `${w}.private_key`), role: o.role as PeerRole, created_at: ts(o.created_at) };
    });
    if (peers.length && !server) fail('wg_server_peers', 'sunucu anahtarı olmadan istemci olamaz');
    uniq(peers.map(p => p.id), 'wg_server_peers');
    uniq(peers.map(p => p.ip), 'wg_server_peers.ip');
    return { server, peers };
  }, { server: null as WgServerRestore | null, peers: [] as WgPeerRestore[] });

  const ddns = section('ddns', () => {
    const rows = arr(b.ddns_configs, 'ddns_configs', 50).map((r, i) => {
      const w = `ddns_configs[${i}]`;
      const o = obj(r, w, ['id', 'provider', 'hostname', 'username', 'password', 'token', 'domain', 'update_interval_min', 'enabled',
        'last_update', 'last_ip', 'status', 'created_at'], ['id', 'provider', 'hostname']);
      if (typeof o.provider !== 'string' || !DDNS_PROVIDERS.test(o.provider)) fail(`${w}.provider`, 'bilinen bir DDNS sağlayıcısı değil');
      // Panel adı kırpmadan saklar (telefon klavyesinin sondaki boşluğu): kırpılıp denetlenir
      const hostname = typeof o.hostname === 'string' ? o.hostname.trim() : '';
      if (!HOSTNAME.test(hostname)) fail(`${w}.hostname`, 'geçersiz ad');
      // Aralık (dk): panel üst sınır koymaz, sayıyı metin olarak da saklayabilir — 1..DDNS_INTERVAL_MAX'a çekilir, okunamazsa 5
      const ivRaw = o.update_interval_min;
      const ivNum = typeof ivRaw === 'number' ? ivRaw : typeof ivRaw === 'string' && /^\s*\d+\s*$/.test(ivRaw) ? Number(ivRaw) : NaN;
      const iv = Number.isFinite(ivNum) ? Math.min(DDNS_INTERVAL_MAX, Math.max(1, Math.round(ivNum))) : 5;
      return {
        id: id(o.id, `${w}.id`), provider: o.provider as string, hostname,
        username: text(o.username, `${w}.username`, 256), password: text(o.password, `${w}.password`, 1024),
        token: text(o.token, `${w}.token`, 1024), domain: text(o.domain, `${w}.domain`, 2048), update_interval_min: iv,
        enabled: flag(o.enabled ?? 1, `${w}.enabled`), last_update: shown(o.last_update, 64),
        last_ip: shown(o.last_ip, 64), status: shown(o.status, 64), created_at: ts(o.created_at),
      };
    });
    uniq(rows.map(d => d.id as number), 'ddns_configs');
    return rows;
  }, [] as SecretsBundle['ddns_configs']);

  return {
    bundle: { vps_servers: vpsPart.vps, vps_tunnels: vpsPart.tunnels, wg_clients: vpsPart.clients, wg_server: home.server,
      wg_server_peers: home.peers, ddns_configs: ddns },
    errors,
  };
}
// Tam doğrulama (her bölüm geçerli olmalı): ilk hatayla fırlatır
export function validateSecretsBundle(raw: unknown): SecretsBundle {
  const r = checkSecretsBundle(raw);
  if (r.errors.length) throw new Error(r.errors[0].error);
  return r.bundle;
}

const secretCounts = (s: any) => {
  const n = (k: string) => (Array.isArray(s?.[k]) ? s[k].length : 0);
  return { vps: n('vps_servers'), tunnels: n('vps_tunnels'), clients: n('wg_clients'), homeVpn: !!s?.wg_server,
    homeVpnPeers: n('wg_server_peers'), ddns: n('ddns_configs') };
};
const countRows = async (sql: string) => Number((await dbGet(sql).catch(() => null))?.n || 0);  // tablo olmayabilir (Ev VPN'i kurulmamış)
// Gizli anahtar paketi: üst alanlar geçersizse hiç kullanılmaz (top); geçerli bölümler geri yüklenir
function secretsOf(raw: unknown): { check: SecretsCheck | null; top: string } {
  try { return { check: checkSecretsBundle(raw), top: '' }; } catch (e: any) { return { check: null, top: String(e?.message || e) }; }
}
const bundleHasContent = (b: SecretsBundle) => b.vps_servers.length > 0 || b.wg_clients.length > 0 || !!b.wg_server || b.ddns_configs.length > 0;

// Önizleme (getirilen yedekten): sayılar ve uyarılar — gizli değerler hiç dönmez (yalnız sayıları)
export async function restorePreview(): Promise<Record<string, unknown>> {
  const j = await vaultJob();
  const fetching = j.state === 'running' && j.cmd === 'restore-config';
  const staged = fetching ? null : readStaged();
  if (!staged) return { staged: false, fetching };
  const m = staged.meta;
  const running = panelVersion().version;
  const backupVer = String(m.panel_version || '');
  const vpsRows = await dbAll('SELECT id, ip, location FROM vps_servers').catch(() => [] as any[]);
  const vpsDevice = vpsRows.map(r => ({ id: Number(r.id), ip: String(r.ip ?? ''), location: String(r.location ?? '') }));
  const vpsHere = vpsDevice.map(v => v.id);
  const data = staged.config?.data && typeof staged.config.data === 'object' ? staged.config.data : {};
  const tables = Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([name, v]) => ({ name, rows: (v as unknown[]).length }));
  let secrets: Record<string, unknown> | null = null;
  let bundle: SecretsBundle | null = null;
  if (staged.secrets !== null) {
    const { check, top } = secretsOf(staged.secrets);
    bundle = check?.bundle || null;
    const errors = check?.errors || [];
    const firstError = top || errors[0]?.error || '';
    secrets = {
      counts: secretCounts(staged.secrets), valid: !top && !errors.length, ...(firstError ? { error: firstError } : {}),
      // Geçerli en az bir dolu bölüm varsa kullanılabilir (geçersiz bölüm atlanır, sonuçta bildirilir)
      usable: !!check && (!errors.length || bundleHasContent(check.bundle)), errors,
      // Bu cihazda olan ve gizli anahtarlar geri yüklenince değişecekler (önizleme uyarısı): Ev VPN'i her zaman yedektekiyle
      // değiştirilir; DDNS yalnız yedekte DDNS kaydı varsa ve bu cihazda VPS yokken
      vpsOnDevice: vpsHere.length, ddnsOnDevice: await countRows('SELECT COUNT(*) AS n FROM ddns_configs'),
      homeVpnOnDevice: { enabled: (await countRows('SELECT COUNT(*) AS n FROM wg_server WHERE enabled = 1')) > 0, peers: await countRows('SELECT COUNT(*) AS n FROM wg_server_peers') },
    };
  }
  const vps = vpsRuleWarning(data, vpsHere);
  // Gizli anahtarlar geri yüklenirse bu VPS'ler bu cihazda kayıtlı olur (bu cihazda henüz VPS yoksa)
  const covered = !!bundle && !vpsHere.length && vps.ids.every(id => bundle!.vps_servers.some(v => v.id === id));
  const cron = (Array.isArray(data.cron_jobs) ? data.cron_jobs : []).slice(0, 100).map((r: any) => ({
    name: String(r?.name ?? '').slice(0, 80), schedule: String(r?.schedule ?? '').slice(0, 40),
    command: String(r?.command ?? '').slice(0, 500), enabled: Number(r?.enabled ?? 1) !== 0,
  }));
  return {
    staged: true, fetching: false, snapshotId: staged.snapshotId, fetchedAt: staged.fetchedAt, expiresAt: staged.fetchedAt + RESTORE_MAX_AGE_S,
    meta: {
      createdAt: String(m.created_at || ''), panelVersion: backupVer, build: String(m.build ?? ''), role: String(m.role || ''),
      hostname: String(m.hostname || ''), vaultHost: String(m.vault_host || ''), board: String(m.board_model || ''), arch: String(m.arch || ''),
      includeSecrets: m.include_secrets === true,
    },
    version: { backup: backupVer, running, newer: versionNewer(backupVer, running) },
    backupVersion: staged.config?.backup_version ?? null, tables, secrets,
    warnings: {
      vps: { ...vps, coveredBySecrets: covered },
      // Bu cihazdaki VPS numaralarına bağlanacak kurallar (gizli anahtarlardan bağımsız; yedekteki sunucu biliniyorsa karşılaştırılır)
      vpsExisting: vpsRuleBindings(data, vpsDevice, bundle ? bundle.vps_servers : null),
      cron, satellite: m.role === 'satellite',
    },
  };
}

export interface RestorePart { item: string; ok: boolean; skipped?: boolean; detail?: string }
// Gizli anahtarlar (doğrulanmış bölümler). VPS + istemcileri + DDNS yalnız bu cihazda VPS kaydı YOKKEN (üzerine yazılmaz);
// tünel dosyaları yalnız o zaman. DDNS yalnız yedekte DDNS kaydı varsa değişir (yoksa bu cihazınki kalır). Geçersiz bölüm
// atlanır. Her bölümün sonucu ayrı bildirilir.
async function restoreSecrets(b: SecretsBundle, errors: SecretsCheck['errors']): Promise<RestorePart[]> {
  const parts: RestorePart[] = [];
  const step = async (item: string, fn: () => Promise<string | void>) => {
    try {
      const d = await fn();
      parts.push({ item, ok: true, ...(d ? { detail: d } : {}) });
    } catch (e: any) {
      parts.push({ item, ok: false, detail: String(e?.message || e).slice(0, 300) });
    }
  };
  for (const e of errors) parts.push({ item: e.label, ok: false, detail: `yedekteki veri geçersiz, atlandı — ${e.error}`.slice(0, 300) });
  let restoredVps: number[] = [];
  if (b.vps_servers.length || b.wg_clients.length || b.ddns_configs.length) {
    let skipped = false;
    await step('VPS sunucuları, VPS istemcileri ve DDNS', async () => {
      await dbRun('BEGIN');
      try {
        const here = Number((await dbGet('SELECT COUNT(*) AS n FROM vps_servers'))?.n || 0);
        if (here) {
          await dbRun('ROLLBACK');
          skipped = true;
          return `atlandı — bu cihazda zaten ${here} VPS kaydı var (üzerine yazılmaz); VPS istemcileri, DDNS ve tüneller de atlandı`;
        }
        const ddnsHere = Number((await dbGet('SELECT COUNT(*) AS n FROM ddns_configs'))?.n || 0);
        if (b.vps_servers.length || b.wg_clients.length) {
          await dbRun('DELETE FROM wg_clients');
          for (const v of b.vps_servers) {
            await dbRun(`INSERT INTO vps_servers (id, ip, username, password, location, status, created_at, kind, wg_conf)
              VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)`, [v.id, v.ip, v.username, v.password ?? '', v.location ?? '', v.status ?? 'disconnected', v.created_at, v.kind, v.wg_conf]);
          }
          for (const c of b.wg_clients) {
            await dbRun(`INSERT INTO wg_clients (id, vps_id, name, ip, public_key, config, qr_data, panel_access, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`, [c.id, c.vps_id, c.name, c.ip, c.public_key, c.config, c.qr_data ?? '', c.panel_access, c.created_at]);
          }
        }
        // DDNS yalnız yedekte kayıt varsa değişir: eski cihaz DDNS kullanmadıysa yeni cihazda kurulan DDNS (Ev VPN'i adresi) kalır
        if (b.ddns_configs.length) {
          await dbRun('DELETE FROM ddns_configs');
          for (const d of b.ddns_configs) {
            await dbRun(`INSERT INTO ddns_configs (id, provider, hostname, username, password, token, domain, update_interval_min, enabled,
              last_update, last_ip, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
            [d.id, d.provider, d.hostname, d.username ?? '', d.password ?? '', d.token ?? '', d.domain ?? '', d.update_interval_min, d.enabled,
              d.last_update ?? '', d.last_ip ?? '', d.status ?? 'idle', d.created_at]);
          }
        }
        await dbRun('COMMIT');
        restoredVps = b.vps_servers.map(v => v.id);
        return `${b.vps_servers.length} VPS, ${b.wg_clients.length} VPS istemcisi, ${b.ddns_configs.length} DDNS kaydı`
          + (b.ddns_configs.length && ddnsHere ? ` (bu cihazdaki ${ddnsHere} DDNS kaydının yerine)` : '')
          + (!b.ddns_configs.length && ddnsHere ? ` — bu cihazdaki ${ddnsHere} DDNS kaydı korundu` : '');
      } catch (e) {
        await dbRun('ROLLBACK').catch(() => {});
        throw e;
      }
    });
    if (skipped) parts[parts.length - 1].skipped = true;
  }
  const written: number[] = [];
  const importedIds = b.vps_servers.filter(v => v.kind === 'import' && restoredVps.includes(v.id)).map(v => v.id);
  if (importedIds.length && isLinux) {
    // İçe aktarılan tünelin PreUp'ı koruma dosyasını (pi5-wgext) yükler; dosya yoksa tünel bilerek açılmaz: önce koruma
    // wgImport.ts vault.ts'i içe aktarır (parseWgVpsConf): döngü olmasın diye çağrı anında yüklenir
    await step('İçe aktarılan tünellerin koruması (pi5_wgext)', async () => { await (await import('./wgImport')).syncImportGuard(); });
  }
  for (const v of b.vps_servers.filter(v => v.kind === 'import' && restoredVps.includes(v.id))) {
    await step(`İçe aktarılan tünel (wg_vps${v.id})`, async () => {
      if (!isLinux) return 'yalnız Pi üzerinde yazılır';
      const conf = renderStoredConf(v.wg_conf);
      if (!conf) throw new Error('yapılandırma okunamadı — WireGuard sayfasından yapılandırmayı yeniden içe aktarın');
      writeFile0600(path.join(WG_DIR, `wg_vps${v.id}.conf`), conf);
      await execFileP('systemctl', ['enable', `wg-quick@wg_vps${v.id}`], { timeout: 15000 });
      written.push(v.id);
      return 'temizlenmiş yapılandırma yazıldı (0600) ve açılışta başlayacak';
    });
  }
  for (const t of b.vps_tunnels.filter(t => restoredVps.includes(t.vpsId) && !importedIds.includes(t.vpsId))) {
    await step(`VPS tüneli (wg_vps${t.vpsId})`, async () => {
      if (!isLinux) return 'yalnız Pi üzerinde yazılır';
      const m = /^(.+):(\d{1,5})$/.exec(t.endpoint)!;
      const conf = renderPi5VpsConf({ privateKey: t.privateKey, serverPub: t.serverPub, endpointHost: m[1], endpointPort: Number(m[2]) });
      writeFile0600(path.join(WG_DIR, `wg_vps${t.vpsId}.conf`), conf);  // panelin yazdığıyla aynı bayt (connectPi5ToVps)
      // Açılışta ve aşağıdaki restoreTunnels ile başlasın (Bağla = enable; index.ts bringUpTunnelsAndRouting niyeti buradan okur)
      await execFileP('systemctl', ['enable', `wg-quick@wg_vps${t.vpsId}`], { timeout: 15000 });
      written.push(t.vpsId);
      return 'yapılandırma yazıldı (0600) ve açılışta başlayacak';
    });
  }
  const noTunnel = restoredVps.filter(id => !importedIds.includes(id) && !b.vps_tunnels.some(t => t.vpsId === id));
  if (noTunnel.length) {
    parts.push({ item: 'VPS tünelleri', ok: true, skipped: true,
      detail: `VPS ${noTunnel.join(', ')}: tünel anahtarı yedekte yok — WireGuard sayfasından tüneli yeniden kurun` });
  }
  if (b.wg_server) {
    const srv = b.wg_server;
    await step("Ev VPN'i", async () => {
      // Bu cihazda kurulmuş bir Ev VPN'i varsa yedektekiyle değişir: bu cihazda oluşturulan profiller artık çalışmaz
      const peersHere = await countRows('SELECT COUNT(*) AS n FROM wg_server_peers');
      const srvHere = peersHere > 0 || (await countRows('SELECT COUNT(*) AS n FROM wg_server WHERE enabled = 1')) > 0;
      const r = await restoreWgServerRows(srv, b.wg_server_peers);
      if (srv.enabled && !r.ok) throw new Error(`anahtarlar geri yüklendi ama arayüz açılamadı: ${r.error || 'bilinmeyen hata'}`);
      return `sunucu anahtarı + ${b.wg_server_peers.length} cihaz${srv.enabled ? ' (açık)' : ' (kapalı)'} — telefon / dizüstü profilleri geçerli; modemdeki UDP 51820 yönlendirmesini bu cihazın adresine çevirin`
        + (srvHere ? ` (bu cihazdaki Ev VPN'i — ${peersHere} cihaz — yedektekiyle değiştirildi)` : '');
    });
  }
  if (restoredVps.length) {
    await step('Tüneller ve yönlendirme', async () => {
      if (!restoreTunnels) throw new Error('hazır değil');
      await restoreTunnels();
      // wg-quick arayüzü kurduysa tünel açık (el sıkışma VPS'e ulaşınca); kurmadıysa (uç nokta adı çözülemedi, 20 sn'de
      // kalkmadı) yönlendirme o VPS için henüz operatörden ya da engelle ile çalışır — sonuçta görünsün
      const down = isLinux ? written.filter(id => !fs.existsSync(path.join(SYS_NET, `wg_vps${id}`))) : [];
      if (down.length) {
        throw new Error(`${down.map(id => `wg_vps${id}`).join(', ')} henüz açılmadı — VPS adresi çözülemiyor ya da tünel arka planda bekliyor olabilir; WireGuard sayfasından denetleyin`);
      }
      return written.length ? `${written.map(id => `wg_vps${id}`).join(', ')} açık; kurallar yeniden uygulandı` : 'kurallar yeniden uygulandı';
    });
  }
  return parts;
}

let applyingRestore = false;
// Uygula: (i) yedek dosyasıyla aynı yol (importBackupData — bu istek ile); (ii) gizli anahtarlar yalnız secrets +
// oldDeviceRetired ile ve pakette varsa; (iii) indirilen yedek silinir, olay yazılır. snapshot + fetchedAt önizlemedekiyle
// aynı olmalı: başka bir sekmede yeni bir anlık görüntü getirildiyse kullanıcının görmediği yedek uygulanmaz.
export async function applyRestore(body: { secrets?: unknown; oldDeviceRetired?: unknown; snapshot?: unknown; fetchedAt?: unknown }, req: Request): Promise<Record<string, unknown>> {
  if (!importBackup || !restoreTunnels) throw new Error('Geri yükleme hazır değil (panel yeniden başlatılıyor olabilir)');
  if (body.secrets !== undefined && typeof body.secrets !== 'boolean') throw new Error('secrets true / false olmalı');
  if (body.oldDeviceRetired !== undefined && typeof body.oldDeviceRetired !== 'boolean') throw new Error('oldDeviceRetired true / false olmalı');
  if (typeof body.snapshot !== 'string' || !Number.isInteger(body.fetchedAt)) throw new Error('Önizlenen anlık görüntü bilgisi eksik — önizlemeyi yenileyin');
  if (applyingRestore) throw new Error('Geri yükleme zaten sürüyor');
  if (fetchStarting) throw new Error('Bir ayar yedeği getiriliyor — bitince önizlemeyi yenileyin');
  applyingRestore = true;
  try {
    const j = await vaultJob();
    if (j.state === 'running' && j.cmd === 'restore-config') throw new Error('Ayar yedeği hâlâ getiriliyor — bitince yeniden deneyin');
    const staged = readStaged();
    if (!staged) throw new Error('Önce bir anlık görüntü getirin («Getir»)');
    if (staged.snapshotId !== body.snapshot || staged.fetchedAt !== body.fetchedAt) throw new Error('Getirilen yedek değişti — önizlemeyi yenileyin');
    const wantSecrets = body.secrets === true;
    let check: SecretsCheck | null = null;
    if (wantSecrets) {
      // Aynı WireGuard anahtarları iki cihazda olursa ikisinin de tünelleri bozulur
      if (body.oldDeviceRetired !== true) throw new Error('Gizli anahtarlar yalnız «Eski cihaz kapalı / artık kullanılmıyor» onayıyla geri yüklenir');
      if (staged.secrets === null) throw new Error('Bu anlık görüntüde gizli anahtar yok');
      const s = secretsOf(staged.secrets);
      if (!s.check) throw new Error(s.top);
      if (s.check.errors.length && !bundleHasContent(s.check.bundle)) throw new Error(s.check.errors[0].error);
      check = s.check;
    }
    const imported = await importBackup(staged.config, req);
    const secrets = check ? await restoreSecrets(check.bundle, check.errors) : null;
    discardRestore();
    const m = staged.meta;
    const failed = [...imported.applied, ...(secrets || [])].filter(a => !a.ok);
    const sx = secrets ? `; gizli anahtarlar: ${secrets.map(p => `${p.item} ${p.skipped ? 'atlandı' : p.ok ? 'tamam' : 'olmadı'}`).join(', ')}`
      : ' — gizli anahtarlar geri yüklenmedi';
    await recordEvent('vault', `Buluttan geri yüklendi (${staged.snapshotId.slice(0, 8)} · ${m.hostname || m.vault_host || '?'} · ${String(m.created_at || '').slice(0, 10)}): ${imported.message}${sx}`,
      failed.length ? 'warning' : 'info');
    // Geri yüklemeden sonra yapılacaklar listesi için (panel): hâlâ kayıtlı olmayan VPS'e yönlenen kurallar (operatörden
    // çıkar), Ev VPN'i geldi mi, eski cihazda gizli anahtar yedeği açık mıydı, güvenlik duvarı Deploy Et bekliyor mu
    // (index.ts applyRestored: «kurulu değil … Deploy Et ile uygulanır»)
    const vpsNow = (await dbAll('SELECT id FROM vps_servers').catch(() => [] as any[])).map(r => Number(r.id));
    const data = staged.config?.data && typeof staged.config.data === 'object' ? staged.config.data : {};
    const counts = staged.secrets !== null ? secretCounts(staged.secrets) : null;
    const followUp = {
      vps: vpsRuleWarning(data, vpsNow),
      homeVpnInBackup: !!counts?.homeVpn,
      homeVpnRestored: !!secrets?.some(p => p.item === "Ev VPN'i" && p.ok && !p.skipped),
      ddnsInBackup: counts?.ddns ?? 0,
      oldIncludeSecrets: m.include_secrets === true,
      firewallDeployPending: imported.applied.some(p => p.item === 'Güvenlik duvarı' && p.ok && /Deploy Et/.test(p.detail || '')),
    };
    return { imported, secrets, snapshot: staged.snapshotId, followUp };
  } finally {
    applyingRestore = false;
  }
}

// Dosya geri yükleme kökü (gerçek yol): bağlı paylaşım alanı ya da ağda paylaşılan bağlı bir USB disk (vault.sh aynısını
// findmnt ile yeniden denetler). Bağlı değilken klasör SD kartın üstündedir.
function mountPoints(): string[] {
  try {
    return fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').map(l => (l.split(' ')[1] || '').replace(/\\040/g, ' ')).filter(Boolean);
  } catch {
    return [];
  }
}
export function checkRestoreRoot(raw: unknown, realpath: (p: string) => string = p => fs.realpathSync(p), mounts: () => string[] = mountPoints): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 1024 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Hedef klasör geçersiz');
  let real: string;
  try { real = realpath(raw); } catch { throw new Error(`Hedef klasör bulunamadı: ${raw}`); }
  const mnt = real === '/mnt/klyrix-share/Paylasim' ? '/mnt/klyrix-share' : /^\/mnt\/klyrix-usb\/[^/]+$/.test(real) ? real : '';
  if (!mnt || !mounts().includes(mnt)) {
    throw new Error('Hedef yalnız bağlı paylaşım alanı (/mnt/klyrix-share/Paylasim) ya da ağda paylaşılan bağlı bir USB disk (/mnt/klyrix-usb/…) olabilir');
  }
  return real;
}
const gbText = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
// Dosyaları geri yükle (iş): kökün altında YENİ bir klasöre (vault.sh) — var olan hiçbir dosyanın üzerine yazılmaz
export async function restoreFiles(body: { snapshot?: unknown; root?: unknown }): Promise<{ id: string; root: string }> {
  if (!configured()) throw new Error('Bulut yedeği bağlı değil');
  const snap = checkSnapshotId(body.snapshot);
  const root = checkRestoreRoot(body.root);
  if (readFailoverStatus()?.active === 'backup') throw new Error('Yedek hattındasınız (kotalı olabilir) — ana hat dönünce yeniden deneyin');
  const { snapshots } = await listSnapshots('files');
  const s = snapshots.find(x => idMatch(x.id, snap));
  if (!s) throw new Error('Bu anlık görüntü dosya deposunda yok — listeyi yenileyin');
  // Boş yer: anlık görüntünün boyutu biliniyorsa (restic 0.17+ özeti) en az o kadar + %5
  if (s.bytes) {
    let free: number | null = null;
    try { const f = fs.statfsSync(root); free = f.bavail * f.bsize; } catch { /* okunamadı: restic dolunca durur */ }
    if (free !== null && free < s.bytes * 1.05) throw new Error(`Hedefte yer yetmez: yaklaşık ${gbText(s.bytes)} gerekli, ${gbText(free)} boş`);
  }
  const r = await launch('restore-files', ['--snapshot', snap, '--root', root], RUNTIME_FILES_S, async () => '');
  return { ...r, root };
}

// Anahtarlar (iki depo): aynı cihazın ayar ve dosya deposundaki anahtarları eşlenir (aynı host, ≤ 10 dk). Depoyu ilk
// oluşturan (en eski) anahtar büyük olasılıkla şifreleme parolasınındır — panel onu silmeyi önermez (vault.sh de reddeder).
export interface VaultKeyRow { id: string; configId: string | null; filesId: string | null; host: string; created: string; current: boolean; likelyPassphrase: boolean }
interface RawKey { current: boolean; id: string; hostName: string; created: string }
export function pairKeys(config: RawKey[], files: RawKey[] | null): VaultKeyRow[] {
  const t = (c: string) => Date.parse(String(c).replace(' ', 'T')) || 0;
  const used = new Set<string>();
  const oldest = [...config].sort((a, b) => t(a.created) - t(b.created))[0]?.id;
  const rows: VaultKeyRow[] = config.map(k => {
    let best: RawKey | null = null;
    for (const f of files || []) {
      if (used.has(f.id) || f.hostName !== k.hostName || f.current !== k.current) continue;
      const d = Math.abs(t(f.created) - t(k.created));
      if (d <= 600000 && (!best || d < Math.abs(t(best.created) - t(k.created)))) best = f;
    }
    if (best) used.add(best.id);
    return { id: k.id, configId: k.id, filesId: best?.id || null, host: k.hostName, created: k.created, current: k.current, likelyPassphrase: k.id === oldest };
  });
  for (const f of files || []) {
    if (!used.has(f.id)) rows.push({ id: f.id, configId: null, filesId: f.id, host: f.hostName, created: f.created, current: f.current, likelyPassphrase: false });
  }
  return rows.sort((a, b) => t(a.created) - t(b.created));
}
export async function listKeys(): Promise<{ keys: VaultKeyRow[]; filesMissing: boolean }> {
  if (!isLinux) throw new Error('Bulut yedeği yalnız Pi üzerinde çalışır');
  if (!configured()) throw new Error('Bulut yedeği bağlı değil');
  const out = await runShort(['keys']);
  let d: { config?: unknown; files?: unknown };
  try { d = JSON.parse(out.trim()); } catch { throw new Error('Anahtar listesi okunamadı'); }
  const norm = (v: unknown): RawKey[] => (Array.isArray(v) ? v : []).filter(k => k && typeof k.id === 'string' && /^[0-9a-f]{8,64}$/.test(k.id))
    .map(k => ({ current: k.current === true, id: k.id, hostName: String(k.hostName || ''), created: String(k.created || '') }));
  return { keys: pairKeys(norm(d.config), d.files === null ? null : norm(d.files)), filesMissing: d.files === null };
}
// Eski cihazın anahtarını kaldır (iş; kullanıcının parolası /run'daki 0600 dosyayla). Bu cihazın ve parolanın anahtarını
// vault.sh reddeder; iki depodan da siler, yeniden denemede zaten silinmiş olanı atlar.
export async function removeOldKey(body: { key?: unknown; passphrase?: unknown }): Promise<{ id: string }> {
  if (!configured()) throw new Error('Bulut yedeği bağlı değil');
  const key = typeof body.key === 'string' ? body.key.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8,64}$/.test(key)) throw new Error('Anahtar kimliği geçersiz');
  const passphrase = checkPassphrase(body.passphrase);
  return launch('key-remove', ['--key', key], RUNTIME_SHORT_S, async () => {
    writeFile0600(PASS_FILE, `${passphrase}\n`);
    return '';
  });
}

// «Bu cihazdan yedeklemeye devam»: geri yükleme kipi kalkar, otomatik yedek (saati geçtiyse birkaç dakika içinde) başlar
export async function resumeVault(): Promise<void> {
  const c = readConf();
  if (!c) throw new Error('Bulut yedeği bağlı değil');
  if (!c.schedule_paused) return;
  writeConf({ ...c, schedule_paused: false });
  // "N gündür alınamadı" uyarısı devamdan sayılır: geri yükleme kipinde yedek bilerek alınmadı (bağlanma tarihi eski olabilir)
  writeLast({ ...readLast(), resumed: String(Math.floor(Date.now() / 1000)) });
  await recordEvent('vault', 'Bulut yedeği: bu cihazdan yedeklemeye devam ediliyor (otomatik yedek yeniden açıldı)');
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
      paused: c.schedule_paused,
    } : null,
    last: {
      attempt: last.attempt || null, okConfig: n(last.ok_config), okFiles: n(last.ok_files), state: last.state || null,
      cmd: last.cmd || null, msg: last.msg || null, error: last.error || null, finished: n(last.finished),
      forget: last.forget || null, connected: n(last.connected), filesSkipped: last.files_skipped || null,
      retryAt: n(last.retry_at), nextRun: c && !c.schedule_paused ? nextAutoRun(c.schedule, last, new Date()) : null,
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
    // Geri yükleme kipi: otomatik yedek / budama yok, "alınamadı" uyarısı da yok (biten işin sonucu yine yazılır)
    if (c.schedule_paused) {
      if (j.id) await noteVaultJob();
      return;
    }
    // Biten işin sonucu (elle alınan yedeğin günün yedeği sayılması, yeniden deneme zamanı) karar vermeden önce yazılsın
    if (j.id) await noteVaultJob();
    const now = new Date();
    const last = readLast();
    // 3 gündür başarılı ayar yedeği yok (bağlandıktan ya da geri yükleme kipinden çıktıktan sonra): günde en çok bir uyarı
    const since0 = Math.max(numOf(last.connected) ?? 0, numOf(last.resumed) ?? 0);
    const ref = numOf(last.ok_config) ?? (since0 || undefined);
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
// exportConfig: index.ts buildBackupExport; importBackup: importBackupData (yedek dosyasıyla aynı geri yükleme yolu);
// restoreTunnels: bringUpTunnelsAndRouting — açılıştaki restoreTunnelsAndRouting'in FTL kurtarmasız hâli (bu modül index.ts'i
// içe aktarmaz — startParental deseni).
export function startVaultWatch(opts: {
  exportConfig: () => Promise<object>;
  importBackup: (backup: unknown, req: Request) => Promise<ImportResult>;
  restoreTunnels: () => Promise<void>;
}): void {
  exportConfig = opts.exportConfig;
  importBackup = opts.importBackup;
  restoreTunnels = opts.restoreTunnels;
  if (!isLinux) return;
  // Süresi geçmiş getirilen yedek (gizli anahtarlar olabilir) tmpfs'te kalmasın: açılışta ve dakikada bir — bağlantı,
  // duraklatma ve rolden bağımsız (uyduda /api/vault uçları 409 döner, oradan silinemezdi)
  const expire = () => { try { expireStaged(); } catch (e: any) { console.error('[bulut yedeği] getirilen yedek silinemedi:', e?.message || e); } };
  expire();
  setInterval(expire, 60000);
  if (isSatellite()) return;
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

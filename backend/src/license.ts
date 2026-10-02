// Lisans motoru (G3.2): Ed25519 ile imzalı, çevrimdışı doğrulanan, isteğe bağlı olarak cihaza bağlanan token.
//  - VARSAYILAN: lisans dosyası yoksa durum "Topluluk" (community). Bugün HER özellik community'dir (FEATURE_PLAN):
//    licenseAllows() her zaman true döner, hiçbir uç ya da arayüz lisansa bağlı değildir. Katman ataması Final fazında,
//    yalnız bu tablo değiştirilerek yapılır (veri güdümlü). Ret sözleşmesi 403 {code:'license_required'} (401 değil: 401 +
//    X-Pi5-Auth arayüzde giriş ekranını açar, auth.ts) — tanımlı ama bugün hiçbir uçta kullanılmıyor. Veri yolunda (DNS,
//    yönlendirme, nft, qos, mesh pair/sync, uydu, Ev VPN'i) ASLA çağrılmaz; lisans bitince çalışan hiçbir şey kesilmez.
//  - Token: KLX1.<base64url(JSON payload)>.<base64url(64 bayt Ed25519 imzası)>; imzalanan veri "KLX1.<payload>" ASCII
//    baytları. Payload {v:1, kid, lid, sub (opak), plan, feat[], hw? (cihaz kodu), iat, nbf, exp, grace_d, seat:1}; zamanlar
//    Unix saniyesi. Doğrulama Node'un yerleşik crypto.verify(null, …) — ek paket yok. Açık anahtarlar licenseKeys.ts'te.
//  - Cihaz kodu: sha256('klyrix-lic|' + seri).slice(0, 32) — seri mesh.ts hwSerial() (mesh kimliğinin okuduğu aynı seri,
//    ayrı önek). Ham seri dışarı verilmez. Seri okunamazsa kod boştur: cihaza bağsız token geçerli, bağlı token "doğrulanamadı".
//    Hızlı ve tuzsuz bir özettir: seri kısa / tahmin edilebilirse (ör. Pi 4 ve öncesi '10000000xxxxxxxx', 32 bit) koddan seri —
//    dolayısıyla mesh etiketi — kaba kuvvetle bulunabilir. Formül sabittir (değişirse verilmiş bağlı token'lar geçersizleşir).
//  - Saat: Pi'de RTC yok. license.seen "yüksek su işareti"dir. Saat eşitliyken (NTP, timedatectl açıkça 'yes') değerlendirme
//    gerçek saatle yapılır ve seen o zamana çekilir (eşitli sanılan yanlış bir saatin ileriye yazdığı değer de düzelir). Eşitli
//    değilken (açılışta, internet yokken) değerlendirme max(şimdi, seen) ile yapılır ve seen yazılmaz — geri alınmış saat
//    süreyi uzatmaz.
//  - Durum dosyaları /etc/pi5-gateway/license (token) ve license.seen; ikisi de 0600, atomik yazılır. app_settings'e ve
//    yedeğe girmez. Bu modül ağ çağrısı yapmaz ve alt süreç çalıştırmaz (fetch / http / child_process yok); saat eşitliği
//    ve seri dışarıdan verilir (licenseRoutes.ts).
//  - Dürüst sınır: depo herkese açık, kullanıcı cihazında root'tur. Denetim silinebilir, açık anahtar değiştirilebilir, seri
//    sahtelenebilir. Bu "kırılmaz" bir koruma değil; dürüst müşteriyi doğru katmana yönlendiren bir kapıdır.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { LICENSE_KEYS } from './licenseKeys';

export const LICENSE_DIR = '/etc/pi5-gateway';
export const LICENSE_FILE = `${LICENSE_DIR}/license`;
export const LICENSE_SEEN_FILE = `${LICENSE_DIR}/license.seen`;
export const TOKEN_PREFIX = 'KLX1';
export const MAX_TOKEN_LEN = 4096;
const DAY_S = 86400;
const NBF_SKEW_S = 300;     // imzalayanla cihaz arasındaki küçük saat farkı
const MAX_GRACE_D = 60;
export const WARN_DAYS = [14, 3] as const;

// ─── Katmanlar (veri güdümlü; Final fazında atanır) ───
export const COMMUNITY = 'community';
// Özellik kimliği → gereken katman. Bugün var olan HER özellik community (test bunu kilitler); tabloda olmayan kimlik de
// community sayılır (yazım hatası hiçbir şeyi kilitlemez).
export const FEATURE_PLAN: Readonly<Record<string, string>> = Object.freeze({
  dashboard: COMMUNITY, topology: COMMUNITY, routing: COMMUNITY, bandwidth: COMMUNITY, dnslog: COMMUNITY, visits: COMMUNITY,
  speedtest: COMMUNITY, 'wan-monitor': COMMUNITY, ddns: COMMUNITY, pihole: COMMUNITY, dhcp: COMMUNITY, zapret: COMMUNITY,
  firewall: COMMUNITY, geo: COMMUNITY, unbound: COMMUNITY, fail2ban: COMMUNITY, parental: COMMUNITY, devicecontrol: COMMUNITY,
  trafficcontrol: COMMUNITY, agenda: COMMUNITY, calendar: COMMUNITY, nettools: COMMUNITY, pcap: COMMUNITY, alerts: COMMUNITY,
  notify: COMMUNITY, vpn: COMMUNITY, vps: COMMUNITY, mesh: COMMUNITY, roles: COMMUNITY, failover: COMMUNITY,
  repeater: COMMUNITY, netmode: COMMUNITY, maintenance: COMMUNITY, cron: COMMUNITY, terminal: COMMUNITY,
  casecontrol: COMMUNITY, kiosk: COMMUNITY, storage: COMMUNITY, share: COMMUNITY, backup: COMMUNITY, vault: COMMUNITY,
  sync: COMMUNITY, mobile: COMMUNITY, settings: COMMUNITY, auth: COMMUNITY, docs: COMMUNITY,
});
// Katman sırası (üstteki alttakini kapsar). Bugün yalnız community; ücretli katmanlar Final'de eklenir.
export const PLAN_RANK: Readonly<Record<string, number>> = Object.freeze({ community: 0 });

export type LicenseState = 'none' | 'active' | 'grace' | 'expired' | 'invalid' | 'other-device' | 'unverified';
export type InvalidReason = 'format' | 'schema' | 'kid' | 'signature' | 'not-yet';
export interface LicensePayload {
  v: 1; kid: string; lid: string; sub: string; plan: string; feat: string[]; hw?: string;
  iat: number; nbf: number; exp: number; grace_d: number; seat: 1;
}
export interface LicenseStatus {
  plan: string;               // geçerli katman (lisans geçerli değilse 'community')
  state: LicenseState;
  reason: InvalidReason | null;
  licensedPlan: string | null; // token'daki katman (süresi bitmiş olsa da)
  lid: string | null;
  feat: string[];             // yalnız geçerliyken
  bound: boolean;             // token bir cihaz koduna bağlı mı
  nbf: number | null;
  exp: number | null;
  graceUntil: number | null;
  now: number;                // değerlendirmede kullanılan zaman (saat eşitli değilken yüksek su işaretiyle)
}

// ─── Ret sözleşmesi (bugün hiçbir uçta kullanılmıyor) ───
export const LICENSE_REQUIRED_STATUS = 403;
export const licenseRequiredBody = (featureId: string) =>
  ({ code: 'license_required', feature: featureId, error: 'Bu özellik için geçerli bir lisans gerekli (Altyapı → Lisans)' });

// ─── Saf çekirdek ───
const b64u = (b: Buffer) => b.toString('base64url');
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const KID_RE = /^[a-z0-9]{1,32}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PLAN_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FEAT_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const HW_RE = /^[0-9a-f]{32}$/;

export type ParseResult = { ok: true; payload: LicensePayload; head: string; sig: Buffer } | { ok: false; reason: InvalidReason };

function validPayload(p: any): p is LicensePayload {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (p.v !== 1 || p.seat !== 1) return false;
  if (typeof p.kid !== 'string' || !KID_RE.test(p.kid)) return false;
  if (typeof p.lid !== 'string' || !ID_RE.test(p.lid) || typeof p.sub !== 'string' || !ID_RE.test(p.sub)) return false;
  if (typeof p.plan !== 'string' || !PLAN_RE.test(p.plan)) return false;
  if (!Array.isArray(p.feat) || p.feat.length > 64 || !p.feat.every((f: unknown) => typeof f === 'string' && FEAT_RE.test(f))) return false;
  if (p.hw !== undefined && (typeof p.hw !== 'string' || !HW_RE.test(p.hw))) return false;
  if (![p.iat, p.nbf, p.exp, p.grace_d].every(isInt)) return false;
  if (p.nbf > p.exp || p.grace_d < 0 || p.grace_d > MAX_GRACE_D) return false;
  return true;
}

// Biçim + kurallı base64url + şema. İmzayı denetlemez (verifyToken).
export function parseToken(token: unknown): ParseResult {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t || t.length > MAX_TOKEN_LEN) return { ok: false, reason: 'format' };
  const m = /^KLX1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(t);
  if (!m) return { ok: false, reason: 'format' };
  const raw = Buffer.from(m[1], 'base64url');
  const sig = Buffer.from(m[2], 'base64url');
  // Kurallı olmayan kodlama (fazladan bit / dolgu) reddedilir: aynı imza tek bir metne karşılık gelsin.
  if (b64u(raw) !== m[1] || b64u(sig) !== m[2] || sig.length !== 64) return { ok: false, reason: 'format' };
  let payload: unknown;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: 'format' }; }
  if (!validPayload(payload)) return { ok: false, reason: 'schema' };
  return { ok: true, payload, head: `${TOKEN_PREFIX}.${m[1]}`, sig };
}

export type VerifyResult = { ok: true; payload: LicensePayload } | { ok: false; reason: InvalidReason };

// Geliştirme / test anahtarları (kid 'dev' ile başlar, ör. dev2026) yalnız HER özellik community iken kabul edilir. Final'de
// bir katman atanıp test anahtarı licenseKeys.ts'ten çıkarılması unutulursa, test anahtarıyla imzalı token yine hiçbir şey açmaz.
const DEV_KID_RE = /^dev/;
export const devKeysAllowed = (plan: Readonly<Record<string, string>> = FEATURE_PLAN) =>
  Object.values(plan).every(p => p === COMMUNITY);

// İmza payload'daki kid'in açık anahtarıyla doğrulanır; bilinmeyen kid reddedilir.
export function verifyToken(token: unknown, keys: Readonly<Record<string, string>> = LICENSE_KEYS,
  plan: Readonly<Record<string, string>> = FEATURE_PLAN): VerifyResult {
  const p = parseToken(token);
  if (!p.ok) return p;
  const pem = Object.prototype.hasOwnProperty.call(keys, p.payload.kid) ? keys[p.payload.kid] : undefined;
  if (!pem) return { ok: false, reason: 'kid' };
  if (DEV_KID_RE.test(p.payload.kid) && !devKeysAllowed(plan)) return { ok: false, reason: 'kid' };
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'kid' };
    if (!crypto.verify(null, Buffer.from(p.head, 'ascii'), key, p.sig)) return { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true, payload: p.payload };
}

export const deviceCodeFor = (serial: string) =>
  (serial ? crypto.createHash('sha256').update(`klyrix-lic|${serial}`).digest('hex').slice(0, 32) : '');

// Saat eşitli değilken değerlendirme zamanı: max(şimdi, yüksek su işareti) — geri alınmış saat süreyi uzatmaz.
export const effectiveNow = (now: number, seen: number) => Math.max(Math.floor(now), Math.floor(seen) || 0);

export interface EvalContext { now: number; seen: number; deviceCode: string; synced: boolean }
const BASE = (now: number): LicenseStatus => ({
  plan: COMMUNITY, state: 'none', reason: null, licensedPlan: null, lid: null, feat: [], bound: false,
  nbf: null, exp: null, graceUntil: null, now,
});

// v: verifyToken sonucu (token yoksa null).
export function evaluate(v: VerifyResult | null, ctx: EvalContext): LicenseStatus {
  // Eşitli saat doğrudur; yüksek su işareti yalnız eşitli değilken (açılış, internet yok) kullanılır.
  const now = ctx.synced ? Math.floor(ctx.now) : effectiveNow(ctx.now, ctx.seen);
  if (!v) return BASE(now);
  if (!v.ok) return { ...BASE(now), state: 'invalid', reason: v.reason };
  const p = v.payload;
  const graceUntil = p.exp + p.grace_d * DAY_S;
  const info = { ...BASE(now), licensedPlan: p.plan, lid: p.lid, bound: !!p.hw, nbf: p.nbf, exp: p.exp, graceUntil };
  if (p.hw) {
    if (!ctx.deviceCode) return { ...info, state: 'unverified' };
    if (ctx.deviceCode !== p.hw) return { ...info, state: 'other-device' };
  }
  if (now + NBF_SKEW_S < p.nbf) return { ...info, state: 'invalid', reason: 'not-yet' };
  if (now <= p.exp) return { ...info, state: 'active', plan: p.plan, feat: [...p.feat] };
  if (now <= graceUntil) return { ...info, state: 'grace', plan: p.plan, feat: [...p.feat] };
  return { ...info, state: 'expired' };
}

export const entitled = (s: LicenseStatus) => s.state === 'active' || s.state === 'grace';

// Son değerlendirilen durum (licenseRoutes.ts günceller). licenseAllows yalnız tabloda community dışı bir katman isteyen
// özellikte buna bakar — bugün hiçbiri yok.
let current: LicenseStatus = BASE(0);
export const setCurrentLicense = (s: LicenseStatus) => { current = s; };
export const currentLicense = () => current;

// Yeni ücretli özelliklerin YÖNETİM uçları çağırır (plan 0.7). Bugün her zaman true.
export function licenseAllows(featureId: string, status: LicenseStatus = current): boolean {
  const need = Object.prototype.hasOwnProperty.call(FEATURE_PLAN, featureId) ? FEATURE_PLAN[featureId] : COMMUNITY;
  if (need === COMMUNITY) return true;
  if (!entitled(status)) return false;
  if (status.feat.includes(featureId) || status.plan === need) return true;
  const have = PLAN_RANK[status.plan];
  const want = PLAN_RANK[need];
  return have !== undefined && want !== undefined && have >= want;
}

// ─── Durum dosyaları ───
function writeFile0600(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function readToken(file = LICENSE_FILE): string | null {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t ? t.slice(0, MAX_TOKEN_LEN + 1) : null;
  } catch {
    return null;
  }
}
export const hasToken = (file = LICENSE_FILE) => fs.existsSync(file);
export const writeToken = (token: string, file = LICENSE_FILE) => writeFile0600(file, `${token.trim()}\n`);
export const removeToken = (file = LICENSE_FILE) => fs.rmSync(file, { force: true });

export function readSeen(file = LICENSE_SEEN_FILE): number {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
// Yalnız saat eşitliyken yazılır: seen gerçek saate çekilir — normalde ileri gider; eşitli sanılan yanlış bir saatin ileriye
// yazdığı değer de böylece geri düzelir (yoksa geçerli lisans kalıcı olarak 'bitti' görünürdü). Eşitli değilken dokunulmaz.
// Yazılamazsa sessiz: değerlendirme yine bellekteki değerle yapılır.
export function bumpSeen(now: number, synced: boolean, file = LICENSE_SEEN_FILE): number {
  const seen = readSeen(file);
  const n = Math.floor(now);
  if (!synced || n === seen) return seen;
  try { writeFile0600(file, `${n}\n`); } catch { /* salt okunur kök / izin */ }
  return n;
}

export const maskToken = (t: string) => (t.length > 12 ? `${TOKEN_PREFIX}.••••••••${t.slice(-6)}` : '••••••••');

// Dosyadaki token'ı okur, (varsa) yüksek su işaretini günceller ve değerlendirir. Token yoksa hiçbir dosya yazılmaz.
export function licenseStatus(ctx: { now: number; synced: boolean; serial: string; file?: string; seenFile?: string; keys?: Readonly<Record<string, string>> }):
  LicenseStatus & { deviceCode: string; token: string | null } {
  const file = ctx.file ?? LICENSE_FILE;
  const deviceCode = deviceCodeFor(ctx.serial);
  const token = readToken(file);
  if (!token) return { ...evaluate(null, { now: ctx.now, seen: 0, deviceCode, synced: ctx.synced }), deviceCode, token: null };
  const seen = bumpSeen(ctx.now, ctx.synced, ctx.seenFile ?? LICENSE_SEEN_FILE);
  const s = evaluate(verifyToken(token, ctx.keys), { now: ctx.now, seen, deviceCode, synced: ctx.synced });
  return { ...s, deviceCode, token: maskToken(token) };
}

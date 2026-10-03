// Filo protokolü klx-fleet/1 (G4.1) — SAF modül: dosya, ağ, veritabanı yok (birim testleri doğrudan bunu çağırır).
// Belge: docs/fleet-protocol.md. Bulut denetleyici AYRI depodadır; bu dosya cihaz tarafının sözleşmesidir.
//  - Kanonik JSON: RFC 8785 (JCS) alt kümesi — anahtarlar UTF-16 kod birimine göre sıralı, boşluksuz; sayı yalnız sonlu.
//  - İmza: Ed25519 (Node yerleşik crypto, sign(null) — yeni paket yok). Açık anahtar = ham 32 bayt, base64url.
//  - Cihaz → sunucu isteği: X-Klx-Sig = imza("METHOD|yol|ts|sha256hex(gövde)") cihaz anahtarıyla.
//  - Sunucu → cihaz komutu: { cmd, sig } zarfı; sig = imza(kanonik(cmd)) kiracı anahtarıyla (kayıtta sabitlenir).
//  - İzin listesi KODDA SABİTTİR: report.inventory, update.start, policy.apply. Güvenlik duvarı, yönlendirme, rol, ağ ayarı,
//    terminal, panel koruması, kasa, mesh komutu YOKTUR — sunucu ne gönderirse göndersin cihaz reddeder.
import crypto from 'crypto';

export const FLEET_PROTO = 'klx-fleet/1';
export const COMMAND_TYPES = ['report.inventory', 'update.start', 'policy.apply'] as const;
export type CommandType = typeof COMMAND_TYPES[number];
export const isCommandType = (v: unknown): v is CommandType => (COMMAND_TYPES as readonly unknown[]).includes(v);
export const MAX_RESPONSE_BYTES = 256 * 1024;   // sunucu yanıtı en çok 256 KiB
export const MAX_COMMANDS_PER_POLL = 20;
export const MAX_CMD_LIFETIME_S = 7 * 86400;    // not_after en çok 7 gün ileride
export const CLOCK_SKEW_S = 300;                // saat kayması payı (not_before / issued_at)
export const POLL_DEFAULT_S = 120;
export const POLL_MIN_S = 60;
export const POLL_MAX_S = 900;
export const BACKOFF_MAX_S = 3600;
export const PIHOLE_POLICY_TYPES = ['adlist', 'whitelist', 'blacklist'] as const;   // localdns YOK (ad yönlendirme = DNS ele geçirme)
export const F2B_POLICY_KEYS = ['bantime', 'findtime', 'maxretry', 'sshd_maxretry', 'sshd_bantime', 'recidive'] as const;
export const MAX_POLICY_LIST_ITEMS = 200;
export const MAX_POLICY_UI_KEYS = 20;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

// ─── Kanonik JSON ───
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('Kanonik JSON: sonlu olmayan sayı');
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error('Kanonik JSON: düz nesne değil');
      const keys = Object.keys(v as object).filter(k => (v as any)[k] !== undefined).sort();
      return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
    }
    default: throw new Error(`Kanonik JSON: desteklenmeyen tür (${typeof v})`);
  }
}

// ─── Anahtarlar ve imza ───
export const b64url = (b: Buffer) => b.toString('base64url');
export const sha256hex = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

export function generateDeviceKey(): { privatePem: string; publicRaw: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicRaw: publicRawOf(publicKey) };
}
export function publicRawOf(key: crypto.KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Ed25519 açık anahtarı okunamadı');
  return jwk.x;
}
export function privateKeyFromPem(pem: string): crypto.KeyObject {
  const k = crypto.createPrivateKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('Cihaz anahtarı Ed25519 değil');
  return k;
}
// Ham 32 baytlık açık anahtar (base64url) → KeyObject; biçim bozuksa null.
export function publicKeyFromRaw(raw: unknown): crypto.KeyObject | null {
  if (typeof raw !== 'string' || raw.length !== 43 || !B64URL_RE.test(raw)) return null;
  try {
    const k = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
    return k.asymmetricKeyType === 'ed25519' ? k : null;
  } catch {
    return null;
  }
}
export const signBytes = (key: crypto.KeyObject, data: string | Buffer) => b64url(crypto.sign(null, Buffer.from(data), key));
export function verifyBytes(pub: crypto.KeyObject, data: string | Buffer, sig: unknown): boolean {
  if (typeof sig !== 'string' || sig.length !== 86 || !B64URL_RE.test(sig)) return false;
  try { return crypto.verify(null, Buffer.from(data), pub, Buffer.from(sig, 'base64url')); } catch { return false; }
}
// Cihaz isteğinin imzalanan dizgesi. path: isteğin URL yolu (temel adresin öneki dahil, sorgu yok).
export const requestSigningString = (method: string, path: string, ts: number, body: Buffer | string) =>
  `${method.toUpperCase()}|${path}|${ts}|${sha256hex(body)}`;
export function signRequest(key: crypto.KeyObject, deviceId: string, method: string, path: string, body: Buffer | string, ts: number): Record<string, string> {
  return {
    'x-klx-proto': FLEET_PROTO, 'x-klx-device': deviceId, 'x-klx-ts': String(ts),
    'x-klx-sig': signBytes(key, requestSigningString(method, path, ts, body)),
  };
}
export const fingerprint = (publicRaw: string) => sha256hex(Buffer.from(publicRaw, 'base64url')).slice(0, 16).replace(/(.{4})(?=.)/g, '$1:');

// ─── Sunucu adresi ───
// Yalnız https; kullanıcı:parola, sorgu, parça, localhost yok. Adres denetimi (loopback / Pi'nin kendisi / ev ağı) bağlanırken
// fleet.ts'te yapılır (DNS yeniden bağlama dahil). Döner: sonda eğik çizgisiz temel adres ya da hata.
export function checkBaseUrl(raw: unknown): { base: string } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 300 || /[\s\x00-\x1f\x7f]/.test(s)) return { error: 'Sunucu adresi geçersiz (en çok 300 karakter, boşluksuz)' };
  let u: URL;
  try { u = new URL(s); } catch { return { error: 'Sunucu adresi geçersiz' }; }
  if (u.protocol !== 'https:') return { error: 'Sunucu adresi https:// ile başlamalı (şifresiz bağlantı kabul edilmez)' };
  if (u.username || u.password) return { error: 'Adreste kullanıcı adı / parola olamaz' };
  if (u.search || u.hash) return { error: 'Adreste sorgu (?) ya da # bölümü olamaz' };
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return { error: "Sunucu Pi'nin kendisi olamaz" };
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

// ─── Yoklama aralığı ───
export const clampPoll = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(POLL_MAX_S, Math.max(POLL_MIN_S, n)) : POLL_DEFAULT_S;
};
// Sonraki yoklamaya kadar sn: ±%20 rastgele; ardışık hatada üstel (aralık × 2^hata). Rastgele sapma dahil en çok 1 saat.
// rand ∈ [0, 1).
export function nextDelayS(pollS: number, failures: number, rand: number): number {
  const base = failures > 0 ? Math.min(BACKOFF_MAX_S, clampPoll(pollS) * 2 ** Math.min(failures, 6)) : clampPoll(pollS);
  return Math.min(BACKOFF_MAX_S, Math.max(1, Math.round(base * (0.8 + 0.4 * Math.min(Math.max(rand, 0), 0.999999)))));
}

// ─── Komut zarfı ───
export interface FleetCommand {
  v: 1; id: string; seq: number; type: CommandType; tenant_id: string; device_id: string;
  issued_at: number; not_before?: number; not_after: number; params: Record<string, unknown>;
}
export interface PolicyParams {
  pihole_lists?: { add?: { list_type: string; value: string; comment?: string }[]; remove?: { list_type: string; value: string }[] };
  fail2ban?: Partial<Record<typeof F2B_POLICY_KEYS[number], number | boolean>>;
  ui_settings?: Record<string, string>;
}
export type RejectCode = 'malformed' | 'bad_sig' | 'wrong_target' | 'type_not_allowed' | 'seq_replay' | 'not_yet_valid' | 'expired' | 'bad_params';
// signed: ret imza doğrulandıktan SONRA (komut gerçekten kiracıdan) — cihaz seq'i ilerletir, sonuç bildirir.
export type VerifyResult = { ok: true; cmd: FleetCommand } | { ok: false; code: RejectCode; error: string; id?: string; seq?: number; signed?: boolean };
export interface VerifyCtx { tenantPub: crypto.KeyObject; tenantId: string; deviceId: string; lastSeq: number; nowS: number }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const BAD_TEXT = /[\x00-\x1f\x7f]/;

// Sıra: biçim → İMZA (imzasız alana güvenilmez) → hedef (kiracı + cihaz) → tür izin listesi → seq → süre → parametreler.
export function verifyEnvelope(env: unknown, ctx: VerifyCtx): VerifyResult {
  if (!isObj(env) || !isObj(env.cmd) || typeof env.sig !== 'string') return { ok: false, code: 'malformed', error: 'Zarf biçimi geçersiz' };
  const c = env.cmd;
  const id = typeof c.id === 'string' && ID_RE.test(c.id) ? c.id : undefined;
  const seq = isInt(c.seq) && c.seq > 0 ? c.seq : undefined;
  let canon: string;
  try { canon = canonicalJson(c); } catch { return { ok: false, code: 'malformed', error: 'Komut kanonik JSON değil', id, seq }; }
  if (!verifyBytes(ctx.tenantPub, canon, env.sig)) return { ok: false, code: 'bad_sig', error: 'İmza doğrulanamadı', id, seq };
  if (c.v !== 1 || !id || !seq || typeof c.type !== 'string' || !isInt(c.issued_at) || !isInt(c.not_after)
    || (c.not_before !== undefined && !isInt(c.not_before)) || !isObj(c.params)) {
    return { ok: false, code: 'malformed', error: 'Komut alanları eksik ya da geçersiz', id, seq, signed: true };
  }
  if (c.tenant_id !== ctx.tenantId || c.device_id !== ctx.deviceId) return { ok: false, code: 'wrong_target', error: 'Komut bu cihaz / kiracı için değil', id, seq, signed: true };
  if (!isCommandType(c.type)) return { ok: false, code: 'type_not_allowed', error: `İzin verilmeyen komut türü: ${String(c.type).slice(0, 40)}`, id, seq, signed: true };
  if (seq <= ctx.lastSeq) return { ok: false, code: 'seq_replay', error: `Sıra numarası geri gitti / yinelendi (${seq} ≤ ${ctx.lastSeq})`, id, seq, signed: true };
  const nb = (c.not_before as number | undefined) ?? (c.issued_at as number);
  if (nb - CLOCK_SKEW_S > ctx.nowS) return { ok: false, code: 'not_yet_valid', error: 'Komutun geçerlilik süresi henüz başlamadı', id, seq, signed: true };
  if (ctx.nowS > (c.not_after as number)) return { ok: false, code: 'expired', error: 'Komutun süresi dolmuş', id, seq, signed: true };
  if ((c.not_after as number) - ctx.nowS > MAX_CMD_LIFETIME_S || (c.not_after as number) < (c.issued_at as number)) {
    return { ok: false, code: 'malformed', error: 'Komutun süre penceresi geçersiz (en çok 7 gün)', id, seq, signed: true };
  }
  const bad = checkParams(c.type, c.params as Record<string, unknown>);
  if (bad) return { ok: false, code: 'bad_params', error: bad, id, seq, signed: true };
  return { ok: true, cmd: c as unknown as FleetCommand };
}

// Tür başına parametre şeması (yalnız yapı ve sınırlar; anlamsal denetim fleet.ts'te — liste değeri, Fail2Ban aralıkları,
// arayüz ayar anahtarları index.ts UI_SETTING_KEYS ile).
export function checkParams(type: CommandType, p: Record<string, unknown>): string {
  if (type !== 'policy.apply') return Object.keys(p).length ? 'Bu komut parametre almaz' : '';
  const keys = Object.keys(p);
  const extra = keys.filter(k => !['pihole_lists', 'fail2ban', 'ui_settings'].includes(k));
  if (extra.length) return `İzin verilmeyen politika bölümü: ${extra.slice(0, 3).join(', ').slice(0, 80)}`;
  if (!keys.length) return 'Politika boş';
  if (p.pihole_lists !== undefined) {
    const l = p.pihole_lists;
    if (!isObj(l) || Object.keys(l).some(k => k !== 'add' && k !== 'remove')) return 'pihole_lists yalnız add / remove içerir';
    const add = l.add ?? [], remove = l.remove ?? [];
    if (!Array.isArray(add) || !Array.isArray(remove)) return 'pihole_lists.add / remove dizi olmalı';
    if (add.length + remove.length === 0) return 'pihole_lists boş';
    if (add.length + remove.length > MAX_POLICY_LIST_ITEMS) return `En çok ${MAX_POLICY_LIST_ITEMS} liste kaydı`;
    for (const e of [...add, ...remove]) {
      if (!isObj(e) || !(PIHOLE_POLICY_TYPES as readonly unknown[]).includes(e.list_type)) return 'Liste türü adlist, whitelist ya da blacklist olmalı (yerel DNS kaydı filodan değişmez)';
      if (typeof e.value !== 'string' || !e.value || e.value.length > 500 || BAD_TEXT.test(e.value)) return 'Liste değeri geçersiz';
      if (e.comment !== undefined && (typeof e.comment !== 'string' || e.comment.length > 150 || BAD_TEXT.test(e.comment))) return 'Liste açıklaması geçersiz';
      if (Object.keys(e).some(k => !['list_type', 'value', 'comment'].includes(k))) return 'Liste kaydında bilinmeyen alan';
    }
  }
  if (p.fail2ban !== undefined) {
    const f = p.fail2ban;
    if (!isObj(f) || !Object.keys(f).length) return 'fail2ban bölümü boş ya da geçersiz';
    const badKey = Object.keys(f).find(k => !(F2B_POLICY_KEYS as readonly string[]).includes(k));
    if (badKey) return `Fail2Ban ayarı filodan değiştirilemez: ${badKey.slice(0, 40)}`;
    for (const [k, v] of Object.entries(f)) {
      if (k === 'recidive' ? typeof v !== 'boolean' : !isInt(v)) return `Geçersiz Fail2Ban değeri: ${k}`;
    }
  }
  if (p.ui_settings !== undefined) {
    const u = p.ui_settings;
    if (!isObj(u) || !Object.keys(u).length) return 'ui_settings boş ya da geçersiz';
    if (Object.keys(u).length > MAX_POLICY_UI_KEYS) return `En çok ${MAX_POLICY_UI_KEYS} arayüz ayarı`;
    for (const [k, v] of Object.entries(u)) {
      if (!/^[a-z_]{1,40}$/.test(k)) return 'Arayüz ayar adı geçersiz';
      if (typeof v !== 'string' || v.length > 500 || BAD_TEXT.test(v)) return `Arayüz ayar değeri geçersiz: ${k}`;
    }
  }
  return '';
}

// Komutun kısa Türkçe özeti (panelde ve olay geçmişinde). Sunucudan gelen metin kırpılır.
export function describeCommand(c: Pick<FleetCommand, 'type' | 'params'>): string {
  if (c.type === 'report.inventory') return 'Durum raporu iste';
  if (c.type === 'update.start') return 'Panel güncellemesini başlat';
  const p = c.params as PolicyParams;
  const parts: string[] = [];
  if (p.pihole_lists) parts.push(`DNS listeleri (+${p.pihole_lists.add?.length || 0} / −${p.pihole_lists.remove?.length || 0})`);
  if (p.fail2ban) parts.push(`Fail2Ban (${Object.keys(p.fail2ban).join(', ')})`);
  if (p.ui_settings) parts.push(`arayüz ayarları (${Object.keys(p.ui_settings).join(', ')})`);
  return `Politika uygula: ${parts.join('; ')}`.slice(0, 300);
}

// Onay kartı için politikanın AYRINTISI: eklenecek / çıkarılacak her kayıt (tür + değer, blokliste adresi tam), Fail2Ban ve
// arayüz ayarlarında şimdiki → yeni değer. Yönetici neyi onayladığını görür. cur: cihazdaki şimdiki değerler. Değer 120
// karakterde kırpılır; en çok max satır ("…ve N satır daha").
const LIST_LABEL: Record<string, string> = { adlist: 'Blokliste', whitelist: 'Beyaz liste', blacklist: 'Kara liste' };
const F2B_SECONDS = new Set(['bantime', 'findtime', 'sshd_bantime']);
export function policyLines(p: PolicyParams, cur: { f2b?: Record<string, unknown> | null; ui?: Record<string, string | null> | null } = {}, max = 40): string[] {
  const cut = (v: unknown) => { const t = String(v ?? ''); return t.length > 120 ? `${t.slice(0, 119)}…` : t; };
  const f2bVal = (k: string, v: unknown) => (typeof v === 'boolean' ? (v ? 'açık' : 'kapalı') : `${cut(v)}${F2B_SECONDS.has(k) ? ' sn' : ''}`);
  const out: string[] = [];
  for (const a of p.pihole_lists?.add || []) out.push(`+ ${LIST_LABEL[a.list_type] || cut(a.list_type)}: ${cut(a.value)}`);
  for (const r of p.pihole_lists?.remove || []) out.push(`− ${LIST_LABEL[r.list_type] || cut(r.list_type)}: ${cut(r.value)}`);
  for (const [k, v] of Object.entries(p.fail2ban || {})) {
    out.push(`Fail2Ban ${k}: ${cur.f2b && k in cur.f2b ? `${f2bVal(k, cur.f2b[k])} → ` : ''}${f2bVal(k, v)}`);
  }
  for (const [k, v] of Object.entries(p.ui_settings || {})) {
    out.push(`Arayüz ayarı ${k}: ${cur.ui && k in cur.ui ? `${cur.ui[k] === null ? '(ayarsız)' : cut(cur.ui[k])} → ` : ''}${cut(v)}`);
  }
  return out.length > max ? [...out.slice(0, max - 1), `…ve ${out.length - max + 1} satır daha`] : out;
}

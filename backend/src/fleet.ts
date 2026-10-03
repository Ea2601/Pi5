// Filo ajanı (G4.1, protokol klx-fleet/1 — docs/fleet-protocol.md): cihazı kullanıcının seçtiği yönetilen bulut denetleyicisine
// bağlar. Bulut sunucusu AYRI depodadır; burada yalnız cihaz tarafı.
//  - VARSAYILAN KAPALI: kayıt yokken hiçbir dosya, zamanlayıcı ya da ağ isteği yoktur (startFleetAgent hemen döner).
//  - YALNIZ DIŞA DOĞRU: cihaz sunucuyu yoklar (POST /v1/poll). Dinlenen port, ters tünel, 127.0.0.1'e aktarım YOK — panel
//    internete açılmaz. İstek Pi'nin kendi trafiği gibi çıkar (yönlendirme kuralı / yedek hat; yeni mekanizma yok).
//  - Komutlar kiracı anahtarıyla imzalı zarftır (fleetProto.ts): imza, sıra (seq), süre penceresi, KODDA SABİT izin listesi
//    (report.inventory, update.start, policy.apply). Güvenlik duvarı, yönlendirme, rol, ağ ayarı, terminal, panel koruması
//    buluttan ASLA değişmez. Yerelde tür başına "onay iste" (varsayılan: policy.apply onay ister).
//  - G4.2 (ZTP, ztp.ts): kayıt SD karttaki dosyayla ya da kayıt koduyla da yapılabilir (adoptEnrollment / claimStatusRequest;
//    enroll.json'da source). 'ztp.profile' policy.apply'ın takma adıdır — aynı izin listesi, yürütme yolu ve onay ayarı; ek
//    net_suggestion YALNIZ panelde kart (durum dosyasında), hiçbir ağ ayarı uygulanmaz.
//  - policy.apply yalnız: Pi-hole liste kayıtları (blokliste / beyaz / kara; yerel DNS yok) ekler, yalnız filonun eklediğini
//    çıkarır (kullanıcının hazır liste seçimi ve kendi kayıtları değişmez); Fail2Ban süre / deneme ayarları (ev ağı muafiyeti
//    ve muaf adresler değişmez); index.ts UI_SETTING_KEYS ile sınırlı arayüz ayarları. Filonun beyaz listesi ebeveyn
//    denetiminin ve şifreli DNS engelinin alan adlarını açamaz. Önce anlık görüntü (pending/, 0600), sonra uygulama; 10 dk
//    içinde (politikadan SONRA başlayan) başarılı yoklama + 127.0.0.1:53 DNS yanıtı gelmezse OTOMATİK geri yükleme — yalnız
//    filonun değiştirdiği ve pencerede yerelde yeniden değiştirilmemiş ayarlar geri alınır.
//  - Komut yürütme, yerel onay, sağlık penceresi ve ayrılma TEK SIRADAN geçer (serial): iki politika aynı anda uygulanmaz.
//  - Kopya kartta (hw_tag uyuşmaz), duraklatılmışken, sunucu cihazı kaldırmışken, HA'da etkin olmayan düğümde ve saat
//    eşitlenmeden sunucuya istek GİTMEZ (sonuçlar kuyrukta bekler); kopya kartta «Filodan ayrıl» yalnız bu kopyayı siler.
//  - Gizli değerler: cihaz anahtarı /etc/pi5-gateway/fleet/device.key (0600); kayıt anahtarı yalnız istek gövdesinde ve
//    bellekte. app_settings'e, yedeğe, argv / env / günlüğe girmez; yanıtlarda yalnız açık anahtarın parmak izi. Yedekte filo
//    durumu YOK: kimlik cihaza özgüdür (hw_tag bağı — SD kart kopyasında "yeniden kayıt gerekli", yoklama yapılmaz).
//  - Uyduda çalışmaz (uçlar 409, açılış '!isSatellite'); HA'da yalnız MASTER (fleetMayRun — kapı şimdi hep açık, G4.3 bağlar).
import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import https from 'https';
import net from 'net';
import path from 'path';
import os from 'os';
import type express from 'express';
import { dbAll, dbGet, dbRun } from './db';
import { recordEvent } from './events';
import { isSatellite, STARTUP_ROLE } from './role';
import { hwTag } from './mesh';
import { testEnv } from './notifyStore';
import { addrVerdict, guardedLookup, ownAddresses } from './notify';
import { clockSynced, vaultJob } from './vault';
import { jobGateHolder, storageJob } from './storage';
import { startUpdate, getUpdateStatus, STORAGE_BUSY_MSG } from './update';
import { readPlatform } from './hardware';
import { getHealthStatus } from './monitor';
import { validateListValue, normalizeListValue, syncPiholeLists, ADLIST_PRESETS } from './piholeLists';
import { readFail2banSettings, validateFail2banSettings, applyFail2banSettings, type Fail2banSettings } from './fail2ban';
import { CATEGORIES, DOH_DOMAINS, listRules } from './parental';
import { isLinux } from './system';
import {
  FLEET_PROTO, COMMAND_TYPES, isCommandType, MAX_RESPONSE_BYTES, MAX_COMMANDS_PER_POLL, POLL_DEFAULT_S, POLL_MIN_S, POLL_MAX_S,
  canonicalJson, generateDeviceKey, privateKeyFromPem, publicKeyFromRaw, publicRawOf, signRequest, fingerprint, checkBaseUrl,
  clampPoll, nextDelayS, verifyEnvelope, describeCommand, policyLines, type CommandType, type FleetCommand, type PolicyParams,
  isWireType, baseType, NET_SUGGESTION_TABS, suggestionTextOk, type NetSuggestion,
} from './fleetProto';

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

// ─── Dosyalar (yalnız kayıtla oluşur) ───
export const FLEET_DIR = testEnv('KLX_FLEET_DIR') || '/etc/pi5-gateway/fleet';
const KEY_FILE = path.join(FLEET_DIR, 'device.key');
const HW_FILE = path.join(FLEET_DIR, 'hw_tag');
const ENROLL_FILE = path.join(FLEET_DIR, 'enroll.json');
const STATE_FILE = path.join(FLEET_DIR, 'state.json');
const PENDING_DIR = path.join(FLEET_DIR, 'pending');
const CONFIRM_S = Number(testEnv('KLX_FLEET_CONFIRM_S')) || 600;   // politika onay penceresi (yalnız test kısaltır)
const DNS_TARGET = testEnv('KLX_FLEET_DNS') || '127.0.0.1:53';
const REQUEST_TIMEOUT_MS = 15000;
const HISTORY_MAX = 30;
const OUTBOX_MAX = 50;
const AWAITING_MAX = 20;
const PENDING_POLL_S = 15;    // sağlık penceresinde henüz başarılı yoklama yokken sonraki yoklama en geç (hata sürüyorsa 60 sn)
const FLEET_MARK = 'Filo:';   // filonun eklediği Pi-hole kaydının açıklama öneki (yalnız bunlar filodan çıkarılabilir)

export type Consent = 'minimal' | 'standard' | 'detailed';
const CONSENTS: Consent[] = ['minimal', 'standard', 'detailed'];
type ResultStatus = 'ok' | 'failed' | 'rejected' | 'expired' | 'awaiting_approval' | 'applied' | 'rolled_back';
// Kayıt yolu (G4.2): yazılmazsa panel (G4.1); 'ztp-file' = SD karttaki ZTP dosyası, 'code' = paneldeki kayıt kodu (ztp.ts).
export type EnrollSource = 'ztp-file' | 'code';
interface Enroll {
  v: 1; base: string; allow_private: boolean; device_id: string; tenant_id: string; tenant_name: string; tenant_pub: string;
  poll_s: number; site: string; enrolled_at: number; source?: EnrollSource;
}
interface Envelope { cmd: FleetCommand; sig: string }
interface HistItem { id: string; seq: number; type: string; summary: string; status: ResultStatus; detail: string; at: number }
interface Awaiting { env: Envelope; summary: string; received_at: number }
// type: ztp.profile ise sonuç o türle gider (yoksa policy.apply)
interface PendingPolicy { id: string; seq: number; applied_at: number; deadline: number; ok_poll: boolean; ok_dns: boolean; summary: string; type?: 'ztp.profile' }
// ztp.profile'ın ağ önerisi: YALNIZ panelde kart (hiçbir ağ ayarı uygulanmaz)
interface StoredSuggestion extends NetSuggestion { at: number; cmd: string }
interface FleetState {
  v: 1; enabled: boolean; last_seq: number; consent: Consent; approve: Record<CommandType, boolean>; poll_s: number | null;
  last_poll_at: number; last_ok_at: number; last_error: string; failures: number; revoked: boolean;
  awaiting: Awaiting[]; history: HistItem[]; pending_policy: PendingPolicy | null; outbox: Record<string, unknown>[];
  net_suggestion?: StoredSuggestion;
}
const DEFAULT_APPROVE: Record<CommandType, boolean> = { 'report.inventory': false, 'update.start': false, 'policy.apply': true };
const TYPE_LABEL: Record<CommandType, string> = {
  'report.inventory': 'Durum raporu', 'update.start': 'Panel güncellemesi', 'policy.apply': 'Politika (DNS listeleri / Fail2Ban / arayüz ayarları)',
};
const emptyState = (): FleetState => ({
  v: 1, enabled: true, last_seq: 0, consent: 'minimal', approve: { ...DEFAULT_APPROVE }, poll_s: null,
  last_poll_at: 0, last_ok_at: 0, last_error: '', failures: 0, revoked: false, awaiting: [], history: [], pending_policy: null, outbox: [],
});
const nowS = () => Math.floor(Date.now() / 1000);

function writeFile0600(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* geliştirme ortamı */ }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // yarım yazılmış sır kalmasın
    throw e;
  }
}
function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export const fleetEnrolled = (): boolean => fs.existsSync(ENROLL_FILE);
function readEnroll(): Enroll | null {
  const e = readJson(ENROLL_FILE);
  if (!e || typeof e !== 'object' || typeof e.base !== 'string' || typeof e.device_id !== 'string' || !publicKeyFromRaw(e.tenant_pub)) return null;
  return e as Enroll;
}
let stateCache: FleetState | null = null;
function readState(): FleetState {
  if (stateCache) return stateCache;
  const raw = readJson(STATE_FILE);
  const s = emptyState();
  if (raw && typeof raw === 'object') {
    s.enabled = raw.enabled !== false;
    s.last_seq = Number.isSafeInteger(raw.last_seq) && raw.last_seq > 0 ? raw.last_seq : 0;
    s.consent = CONSENTS.includes(raw.consent) ? raw.consent : 'minimal';
    for (const t of COMMAND_TYPES) if (typeof raw.approve?.[t] === 'boolean') s.approve[t] = raw.approve[t];
    s.poll_s = raw.poll_s == null ? null : clampPoll(raw.poll_s);
    for (const k of ['last_poll_at', 'last_ok_at', 'failures'] as const) s[k] = Number.isSafeInteger(raw[k]) ? raw[k] : 0;
    s.last_error = typeof raw.last_error === 'string' ? raw.last_error.slice(0, 300) : '';
    s.revoked = raw.revoked === true;
    if (Array.isArray(raw.awaiting)) s.awaiting = raw.awaiting.slice(0, AWAITING_MAX);
    if (Array.isArray(raw.history)) s.history = raw.history.slice(0, HISTORY_MAX);
    if (raw.pending_policy && typeof raw.pending_policy.id === 'string') s.pending_policy = raw.pending_policy;
    if (Array.isArray(raw.outbox)) s.outbox = raw.outbox.slice(-OUTBOX_MAX);
    const ns = raw.net_suggestion;
    if (ns && suggestionTextOk(ns.text) && (ns.tab === undefined || (NET_SUGGESTION_TABS as readonly unknown[]).includes(ns.tab))) {
      s.net_suggestion = { text: ns.text.slice(0, 300), ...(ns.tab ? { tab: ns.tab } : {}), at: Number(ns.at) || 0, cmd: String(ns.cmd || '').slice(0, 64) };
    }
  }
  stateCache = s;
  return s;
}
function saveState(s: FleetState): void {
  if (!fleetEnrolled()) return;   // ayrıldıktan sonra geç biten iş dosyayı yeniden yaratmasın
  stateCache = s;
  writeFile0600(STATE_FILE, JSON.stringify(s));
}
function saveEnroll(e: Enroll): void {
  if (!fleetEnrolled()) return;
  writeFile0600(ENROLL_FILE, JSON.stringify(e));
}

// ─── Tek sıra: komut yürütme, yerel onay, sağlık penceresi ve ayrılma birbirini bekler (iki politika aynı anda uygulanmaz,
// ayrılma uçuştaki uygulamayı bekler). Sıradaki işler serial() çağırmaz (kilitlenme olmaz). ───
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

// ─── Çalışma kapısı (HA: yalnız MASTER — G4.3 setFleetRunGate ile bağlar) ───
let runGate: () => boolean = () => true;
export function setFleetRunGate(fn: () => boolean): void { runGate = fn; }
export const fleetMayRun = (): boolean => !isSatellite() && runGate();

// ─── Bağımlılıklar (index.ts: arayüz ayarlarının tek kaynağı UI_SETTING_KEYS orada) ───
export interface FleetUiDeps {
  keys: () => Set<string>;
  check: (key: string, value: string) => string;   // boş = geçerli
  changed: (keys: string[]) => void;
}
let uiDeps: FleetUiDeps = { keys: () => new Set(), check: () => '', changed: () => {} };
// Arayüz ayarlarından ağ ile ilgili olan (DHCP sihirbazının test kaydı) filodan değişmez.
const UI_DENY = new Set(['dhcp_client_test']);

// ─── HTTPS istemcisi: mutlak 15 sn, yönlendirme izlenmez, yanıt ≤ 256 KiB, bağlanırken adres denetimi ───
export interface HttpResult { status: number; json: any; retryAfterS: number; error: string }
const redact = (s: string, secrets: string[]) => secrets.reduce((t, x) => (x ? t.split(x).join('••••') : t), s);
const clean = (s: unknown, n = 200) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n);
function errText(e: any): string {
  const code = String(e?.code || '');
  if (code === 'EKLXBLOCKED') return String(e.message);
  if (code === 'EKLXTIMEOUT') return 'Sunucu 15 sn içinde yanıt vermedi';
  if (code === 'EKLXTOOBIG') return 'Sunucu yanıtı çok büyük (256 KiB üstü)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Sunucu adı çözülemedi (DNS)';
  if (code === 'ECONNREFUSED') return 'Sunucu bağlantıyı reddetti';
  if (code === 'ECONNRESET') return 'Bağlantı koptu';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'Ağa ulaşılamıyor';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'Sunucunun TLS sertifikası doğrulanamadı';
  return clean(e?.message || e || 'bilinmeyen hata');
}
function fleetPost(base: string, allowPrivate: boolean, p: string, payload: Record<string, unknown>, key: crypto.KeyObject,
  deviceId: string, secrets: string[] = []): Promise<HttpResult> {
  let u: URL;
  try { u = new URL(`${base}${p}`); } catch { return Promise.resolve({ status: 0, json: null, retryAfterS: 0, error: 'Sunucu adresi geçersiz' }); }
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  const own = ownAddresses();
  if (net.isIP(host)) {
    const why = addrVerdict(host, allowPrivate, own);
    if (why) return Promise.resolve({ status: 0, json: null, retryAfterS: 0, error: why });
  }
  const body = Buffer.from(canonicalJson({ proto: FLEET_PROTO, ...payload }));
  const headers = {
    ...signRequest(key, deviceId, 'POST', u.pathname, body, nowS()),
    'content-type': 'application/json', 'content-length': String(body.length), 'user-agent': 'Klyrix-Gate', accept: 'application/json',
  };
  return new Promise(resolve => {
    let done = false;
    const finish = (r: HttpResult) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, error: redact(r.error, secrets) }); };
    const req = https.request({
      protocol: 'https:', hostname: host, port: u.port || 443, path: u.pathname, method: 'POST', headers,
      agent: false, lookup: guardedLookup(allowPrivate, own, false),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(Object.assign(new Error('büyük'), { code: 'EKLXTOOBIG' })); return; }
        chunks.push(c);
      });
      res.on('error', e => finish({ status: 0, json: null, retryAfterS: 0, error: errText(e) }));
      res.on('end', () => {
        const status = res.statusCode || 0;
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* metin */ }
        const ra = Number(String(res.headers['retry-after'] || '').trim());
        const retryAfterS = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 0;
        if (status >= 300 && status < 400) return finish({ status, json: null, retryAfterS, error: `Yönlendirme izlenmez (HTTP ${status})` });
        if (status >= 200 && status < 300) {
          if (!json || typeof json !== 'object') return finish({ status, json: null, retryAfterS, error: 'Sunucu yanıtı JSON değil' });
          return finish({ status, json, retryAfterS, error: '' });
        }
        // Gizli değer KESMEDEN önce maskelenir (sunucu yankıladıysa kesilen yarım parça maskeden kaçmasın)
        const code = clean(redact(String(json?.error?.code ?? ''), secrets), 40);
        finish({ status, json, retryAfterS, error: `HTTP ${status}${code ? ` (${code})` : ''}${json?.error?.message ? `: ${clean(redact(String(json.error.message), secrets), 160)}` : ''}` });
      });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('zaman aşımı'), { code: 'EKLXTIMEOUT' })), REQUEST_TIMEOUT_MS);
    req.on('error', e => finish({ status: 0, json: null, retryAfterS: 0, error: errText(e) }));
    req.end(body);
  });
}
function deviceKey(): crypto.KeyObject {
  return privateKeyFromPem(fs.readFileSync(KEY_FILE, 'utf8'));
}

// ─── Kayıt ───
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function versionInfo(): { version: string; build: number } {
  try {
    const v = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../version.json'), 'utf8'));
    return { version: String(v.version || ''), build: Number(v.build) || 0 };
  } catch {
    return { version: '', build: 0 };
  }
}
let enrolling = false;
export const fleetEnrollBusy = (): boolean => enrolling;
// Hata türü (G4.2 ZTP dosyası kesin / geçici ayrımı için; panel yolu yalnız status + message kullanır):
// kind 'enrolled' | 'busy' | 'clock' | 'http' (httpStatus + sunucunun hata kodu) | 'response' | 'local' (kayıt dosyaları
// yazılamadı; cleaned = yazılanlar silindi mi); kindsiz = girdi hatası.
const enrollError = (msg: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(msg), { status, ...extra });
// source: yazılmazsa panel (G4.1, istek gövdesi ve kayıt dosyası G4.1 ile bayt bayt aynı); 'ztp-file' = SD karttaki ZTP dosyası.
export async function enrollFleet(body: { server?: unknown; enroll_key?: unknown; allow_private?: unknown; site?: unknown }, source?: 'ztp-file'): Promise<{ tenant: string; device_id: string }> {
  if (fleetEnrolled()) throw enrollError('Cihaz zaten bir filoya kayıtlı — önce "Filodan ayrıl"', 409, { kind: 'enrolled' });
  const b = checkBaseUrl(body.server);
  if ('error' in b) throw Object.assign(new Error(b.error), { status: 400 });
  const key = typeof body.enroll_key === 'string' ? body.enroll_key.trim() : '';
  if (key.length < 8 || key.length > 256 || /[\s\x00-\x1f\x7f]/.test(key)) throw Object.assign(new Error('Kayıt anahtarı 8–256 karakter olmalı (boşluksuz)'), { status: 400 });
  if (body.allow_private !== undefined && typeof body.allow_private !== 'boolean') throw Object.assign(new Error("'allow_private' true ya da false olmalı"), { status: 400 });
  const site = typeof body.site === 'string' ? body.site.trim() : '';
  if ([...site].length > 40 || /[\x00-\x1f\x7f<>]/.test(site)) throw Object.assign(new Error('Konum etiketi en çok 40 karakter olmalı (< > olmadan)'), { status: 400 });
  if (enrolling) throw enrollError('Kayıt sürüyor — birazdan yeniden deneyin', 409, { kind: 'busy' });
  enrolling = true;
  try {
    if (!(await clockSynced())) throw enrollError("Pi'nin saati henüz internetle eşitlenmedi (RTC yok) — imzalı istek gönderilmez; birkaç dakika sonra yeniden deneyin", 409, { kind: 'clock' });
    const allowPrivate = body.allow_private === true;
    const pair = generateDeviceKey();
    const priv = privateKeyFromPem(pair.privatePem);
    const hw = hwTag();
    const { version, build } = versionInfo();
    const platform = await readPlatform().catch(() => null);
    const r = await fleetPost(b.base, allowPrivate, '/v1/enroll', {
      enroll_key: key, device_pub: pair.publicRaw, hw_tag: hw, version, build, profile: platform?.profile || null, site,
      ...(source ? { source } : {}),
    }, priv, 'enroll', [key]);
    if (r.error) {
      const code = clean(redact(String(r.json?.error?.code ?? ''), [key]), 40);   // önce maske, sonra kesme
      const msg = /^enroll_key_/.test(code) ? 'Kayıt anahtarı geçersiz, süresi dolmuş ya da kullanılmış — denetleyiciden yeni anahtar alın' : `Kayıt başarısız: ${r.error}`;
      throw enrollError(redact(msg, [key]), r.status >= 400 && r.status < 500 ? 400 : 502, { kind: 'http', httpStatus: r.status, code });
    }
    return await adoptEnrollment({ base: b.base, allowPrivate, site, privatePem: pair.privatePem, hw, source }, r.json);
  } finally {
    enrolling = false;
  }
}
// Kayıt tamamlanınca (her yolda) çağrılır — ztp.ts: başka yolla kayıtta SD karttaki ZTP dosyasını artık geçersiz sayar (G4.2).
let enrolledHook: ((source?: EnrollSource) => void) | null = null;
export function onFleetEnrolled(fn: (source?: EnrollSource) => void): void { enrolledHook = fn; }
// Sunucunun kayıt yanıtını doğrular ve kayıt dosyalarını yazar: /v1/enroll yanıtı (panel, ZTP dosyası) ya da /v1/claim-status
// 'claimed' yanıtı (kodla kayıt, ztp.ts). Doğrulama + yazma tek eşzamanlı adımdır (araya başka kayıt giremez; ilk yazan kazanır).
export async function adoptEnrollment(o: { base: string; allowPrivate: boolean; site: string; privatePem: string; hw: string; source?: EnrollSource },
  j: any): Promise<{ tenant: string; device_id: string }> {
  const tenantPub = publicKeyFromRaw(j?.tenant_pub);
  if (typeof j?.device_id !== 'string' || !ID_RE.test(j.device_id) || typeof j.tenant_id !== 'string' || !ID_RE.test(j.tenant_id) || !tenantPub) {
    throw enrollError('Sunucunun kayıt yanıtı geçersiz (device_id / tenant_id / tenant_pub)', 502, { kind: 'response' });
  }
  if (fleetEnrolled()) throw enrollError('Cihaz bu arada başka bir yolla filoya kaydoldu', 409, { kind: 'enrolled' });
  const e: Enroll = {
    v: 1, base: o.base, allow_private: o.allowPrivate, device_id: j.device_id, tenant_id: j.tenant_id,
    tenant_name: clean(j.tenant_name, 60).replace(/[<>]/g, '') || j.tenant_id, tenant_pub: j.tenant_pub,
    poll_s: clampPoll(j.poll_s ?? POLL_DEFAULT_S), site: o.site, enrolled_at: nowS(),
  };
  if (o.source) e.source = o.source;
  // Yarım kayıt kalmaz: yazımlardan biri başarısız olursa (dolu disk, salt okunur /etc) bu çağrının yazdığı dosyalar silinir
  // (ztp.done'a dokunulmaz); cleaned = silme başarılı mı.
  const written: string[] = [];
  const put = (f: string, t: string) => { writeFile0600(f, t); written.push(f); };
  try {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
    put(KEY_FILE, o.privatePem);
    put(HW_FILE, `${o.hw}\n`);
    put(STATE_FILE, JSON.stringify(emptyState()));
    put(ENROLL_FILE, JSON.stringify(e));   // son: kayıt dosyası varsa diğerleri de var
  } catch (x: any) {
    let cleaned = true;
    for (const f of written.reverse()) { try { fs.rmSync(f, { force: true }); } catch { cleaned = false; } }
    stateCache = null;
    throw enrollError(`Kayıt dosyaları yazılamadı: ${clean(x?.message || x)}`, 500, { kind: 'local', cleaned });
  }
  stateCache = null;
  const via = o.source === 'ztp-file' ? ' (SD karttaki ZTP dosyasıyla)' : o.source === 'code' ? ' (kayıt koduyla)' : '';
  await recordEvent('fleet', `Filoya kaydolundu${via}: ${new URL(o.base).host} — kiracı «${e.tenant_name}», cihaz ${e.device_id}. Rapor düzeyi: en az (IP / MAC / cihaz listesi gönderilmez)`);
  try { enrolledHook?.(o.source); } catch { /* ZTP kancası kaydı etkilemez */ }
  agentGen++;
  schedule(3000);
  return { tenant: e.tenant_name, device_id: e.device_id };
}
// Kodla kayıt (G4.2, ztp.ts): henüz kayıtsız cihazın /v1/claim-status isteği — bekleyen kodun anahtarıyla imzalı
// (X-Klx-Device: claim; sunucu imzayı gövdedeki device_pub ile doğrular). Gövde /v1/enroll'unkiyle aynı tanıtım alanları.
export async function claimStatusRequest(c: { base: string; allowPrivate: boolean; privatePem: string; pub: string; hw: string; site: string }): Promise<HttpResult> {
  const { version, build } = versionInfo();
  const platform = await readPlatform().catch(() => null);
  return fleetPost(c.base, c.allowPrivate, '/v1/claim-status', {
    device_pub: c.pub, hw_tag: c.hw, version, build, profile: platform?.profile || null, site: c.site,
  }, privateKeyFromPem(c.privatePem), 'claim');
}

// ─── Ayrılma: uçuştaki yoklama / komut beklenir, bekleyen politika geri yüklenir, sunucuya bildirilir (başarısız olsa da),
// klasör silinir. Kopya kartta (hw_tag uyuşmaz) sunucuya HİÇ istek gitmez: kimlik asıl cihazındır, yalnız bu kopya silinir. ───
let leaving = false;
export async function leaveFleet(): Promise<{ notified: boolean; clone?: boolean; error?: string }> {
  if (!fleetEnrolled()) throw Object.assign(new Error('Cihaz bir filoya kayıtlı değil'), { status: 409 });
  if (leaving) throw Object.assign(new Error('Ayrılma sürüyor'), { status: 409 });
  leaving = true;   // yeni yoklama / pencere zamanlayıcısı kurulmaz
  try {
    stopAgent();
    if (tickRun) await tickRun.catch(() => undefined);   // uçuştaki yoklama ve onun yürüttüğü komut bitsin
    return await serial(async () => {
      const e = readEnroll();
      if (!fleetEnrolled()) throw Object.assign(new Error('Cihaz bir filoya kayıtlı değil'), { status: 409 });
      const clone = hwMismatch();
      if (readState().pending_policy) await rollbackPolicy('Filodan ayrılındı');   // sonuç yalnız konuşulabiliyorsa gider
      let notified = false;
      let error = '';
      if (clone) error = 'Bu SD kart başka bir cihazdan kopyalanmış — sunucuya bildirilmedi; asıl cihazın filo kaydı sürüyor';
      else if (!(await clockSynced())) error = "Pi'nin saati eşitlenmedi — imzalı istek gönderilmedi";
      else if (e && fs.existsSync(KEY_FILE)) {
        try {
          const r = await fleetPost(e.base, e.allow_private, '/v1/leave', { reason: 'local' }, deviceKey(), e.device_id);
          notified = !r.error;
          error = r.error;
        } catch (x: any) {
          error = clean(x?.message || x);
        }
      }
      fs.rmSync(FLEET_DIR, { recursive: true, force: true });
      stateCache = null;
      const host = e ? ` (${new URL(e.base).host})` : '';
      if (clone) await recordEvent('fleet', `Kopya karttaki filo kaydı silindi${host}: sunucuya bildirilmedi, asıl cihazın kaydı etkilenmez. Bu cihaz yeni bir kayıt anahtarıyla kaydolabilir`, 'warning');
      else await recordEvent('fleet', `Filodan ayrılındı${host}: cihaz anahtarı silindi${notified ? '' : ` — sunucuya bildirilemedi${error ? ` (${error})` : ''}, denetleyicide cihazı elle kaldırın`}`,
        notified ? 'info' : 'warning');
      if (clone) return { notified, clone, error };
      return notified ? { notified } : { notified, error };
    });
  } finally {
    leaving = false;
  }
}

// ─── Yoklama döngüsü ───
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let tickRun: Promise<void> | null = null;
let agentGen = 0;
let confirmTimer: NodeJS.Timeout | null = null;
let status: 'off' | 'active' | 'paused' | 'clock' | 'rebind' | 'revoked' | 'error' | 'standby' = 'off';
function stopAgent(): void {
  agentGen++;
  if (timer) clearTimeout(timer);
  if (confirmTimer) clearTimeout(confirmTimer);
  timer = null;
  confirmTimer = null;
}
function schedule(ms: number): void {
  if (leaving) return;
  if (timer) clearTimeout(timer);
  const gen = agentGen;
  // Süren yoklama varken yenisi başlamaz (o, bitince kendisi planlar); tickRun hep süren yoklamayı tutar (ayrılma onu bekler)
  timer = setTimeout(() => { timer = null; if (gen === agentGen && !ticking) tickRun = tick(); }, ms);
}
const effectivePoll = (e: Enroll, s: FleetState) => clampPoll(s.poll_s ?? e.poll_s);
const hwMismatch = (): boolean => {
  let tag = '';
  try { tag = fs.readFileSync(HW_FILE, 'utf8').trim(); } catch { /* yok: bağ yok sayılmaz */ return true; }
  return tag !== hwTag();
};
// Sunucuyla konuşulabilir mi (sonuç gönderimi): HA'da etkin düğüm, kimlik bu donanımın, yoklama açık, cihaz kaldırılmamış,
// saat eşitli. Değilse sonuç kuyrukta bekler (kopya kartta hiç gönderilmez: kart ayrılınca kuyruk da silinir).
async function mayTalk(s: FleetState): Promise<boolean> {
  if (!fleetMayRun() || hwMismatch() || !s.enabled || s.revoked) return false;
  return clockSynced();
}

// Politika uygulanmadan panel durmuşsa pending/ altında sahipsiz anlık görüntü kalabilir (anlık görüntü → pending_policy →
// uygulama sırası: sahipsiz olan hiç uygulanmamıştır). Açılışta silinir.
async function cleanOrphanSnapshots(s: FleetState): Promise<void> {
  let files: string[] = [];
  try { files = fs.readdirSync(PENDING_DIR); } catch { return; }
  const keep = s.pending_policy ? `${s.pending_policy.id}.json` : '';
  const orphans = files.filter(f => f !== keep);
  for (const f of orphans) fs.rmSync(path.join(PENDING_DIR, f), { force: true });
  const n = orphans.filter(f => f.endsWith('.json')).length;
  if (n) await recordEvent('fleet', `Filo: uygulanmadan yarım kalmış ${n} politika anlık görüntüsü temizlendi`);
}

// Açılışta (index.ts '!isSatellite' bloğu): kayıt yoksa hiçbir şey yapmaz (dosya, zamanlayıcı, ağ yok).
export async function startFleetAgent(): Promise<void> {
  if (isSatellite() || !fleetEnrolled()) return;
  const s = readState();
  await cleanOrphanSnapshots(s);
  const clone = hwMismatch();
  if (clone) {
    status = 'rebind';
    await recordEvent('fleet', 'Filo: bu SD kart başka bir cihazdan kopyalanmış — sunucuyla hiç konuşulmuyor. Filo sayfasında «Filodan ayrıl» yalnız bu kopyadaki kaydı siler (asıl cihaz filoda kalır); sonra yeni bir kayıt anahtarıyla kaydolun', 'warning');
  }
  // Panel bekleyen politika sırasında yeniden başladı: pencere sürer (kopya kartta sonuç sunucuya gönderilmez, yalnız yerelde)
  if (s.pending_policy) scheduleConfirm(1000);
  if (clone) return;
  schedule(15000 + Math.floor(Math.random() * 15000));
}

async function tick(): Promise<void> {
  if (ticking || leaving) return;
  ticking = true;
  const gen = agentGen;
  try {
    let e = readEnroll();
    if (!e) { status = 'off'; return; }
    if (!fleetMayRun()) { status = 'standby'; schedule(30000); return; }   // HA: etkin düğüm değil — kapı açılınca sürer
    const s = readState();
    if (s.revoked) { status = 'revoked'; return; }
    if (!s.enabled) { status = 'paused'; return; }
    if (hwMismatch()) { status = 'rebind'; return; }
    if (!(await clockSynced())) { status = 'clock'; schedule(30000); return; }
    if (gen !== agentGen) return;
    const key = deviceKey();
    await flushOutbox(e);
    if (gen !== agentGen || !fleetEnrolled()) return;
    const { version, build } = versionInfo();
    const startedAt = nowS();
    const r = await fleetPost(e.base, e.allow_private, '/v1/poll', {
      last_seq: s.last_seq, version, build, awaiting: s.awaiting.length, pending_policy: s.pending_policy?.id || null,
    }, key, e.device_id);
    if (gen !== agentGen || !fleetEnrolled()) return;
    const cur = readState();
    cur.last_poll_at = nowS();
    // Kalıcı durma yalnız belgedeki kodlarla (§ 8): 401/403 device_revoked, 410 device_unknown. Aradaki bir WAF / CDN / proxy'nin
    // kodsuz 403'ü geçici hatadır (geri çekilme).
    const code = clean(r.json?.error?.code, 40);
    if (((r.status === 401 || r.status === 403) && code === 'device_revoked') || (r.status === 410 && code === 'device_unknown')) {
      cur.revoked = true;
      cur.last_error = r.error;
      cur.failures++;
      saveState(cur);
      status = 'revoked';
      await recordEvent('fleet', `Filo sunucusu bu cihazı tanımıyor ya da kaldırmış (${r.error}) — yoklama durdu; Filo sayfasından ayrılıp yeniden kaydolun`, 'warning');
      return;
    }
    if (r.error) {
      cur.failures++;
      cur.last_error = r.error;
      saveState(cur);
      status = 'error';
    } else {
      cur.failures = 0;
      cur.last_ok_at = nowS();
      cur.last_error = '';
      // Sağlık penceresi: yalnız politika uygulandıktan SONRA başlamış yoklama sayılır
      if (cur.pending_policy && cur.pending_policy.applied_at < startedAt) cur.pending_policy.ok_poll = true;
      saveState(cur);
      status = 'active';
      if (r.json.poll_s !== undefined) {   // sunucunun güncel aralık önerisi (yerel ayar yoksa geçerli)
        const p = clampPoll(r.json.poll_s);
        if (p !== e.poll_s) { e = { ...e, poll_s: p }; saveEnroll(e); }
      }
      // Zarflar seq'e göre artan sırada işlenir (sunucu sırasız gönderse de küçük seq "yineleme" sayılıp atlanmasın)
      const seqOf = (x: any) => (Number.isSafeInteger(x?.cmd?.seq) ? Number(x.cmd.seq) : 0);
      const cmds = Array.isArray(r.json.commands) ? [...r.json.commands].sort((a, b) => seqOf(a) - seqOf(b)).slice(0, MAX_COMMANDS_PER_POLL) : [];
      for (const env of cmds) {
        if (gen !== agentGen || !fleetEnrolled()) return;
        await handleEnvelope(e, env);
      }
      await pruneAwaiting();
    }
    const after = readState();
    // Üstel geri çekilme; Retry-After yalnız 429 / 503'te ve geri çekilmenin altına inmeden (belge § 5.2 / § 8)
    const backoff = nextDelayS(effectivePoll(e, after), after.failures, Math.random());
    const limited = (r.status === 429 || r.status === 503) && r.retryAfterS > 0;
    let wait = limited ? Math.max(backoff, r.retryAfterS) : backoff;
    // Sağlık penceresinde başarılı yoklama henüz yoksa sonraki yoklama yakında (yoksa uzun aralıkta pencere boşuna dolar)
    if (after.pending_policy && !after.pending_policy.ok_poll && !limited) wait = Math.min(wait, after.failures ? 60 : PENDING_POLL_S);
    if (gen === agentGen) schedule(wait * 1000);
  } catch (x: any) {
    console.error('[filo] yoklama:', clean(x?.message || x));
    status = 'error';
    if (gen === agentGen) schedule(POLL_DEFAULT_S * 1000);
  } finally {
    ticking = false;
  }
}

// ─── Sonuçlar ───
// Aynı komutun yeni durumu gelince "onay bekliyor" satırı düşer; özet boşsa aynı komutun önceki satırından alınır.
function pushHistory(s: FleetState, h: HistItem): void {
  if (!h.summary) h.summary = s.history.find(x => x.id === h.id && x.summary)?.summary || '';
  s.history = [h, ...s.history.filter(x => x.id !== h.id || (x.status !== h.status && x.status !== 'awaiting_approval'))].slice(0, HISTORY_MAX);
}
// Sonuç önce kuyruğa (sıra korunur: daha önce gidemeyen sonuçların arkasına), sonra konuşulabiliyorsa kuyruk gönderilir.
async function sendResult(e: Enroll, cmd: Pick<FleetCommand, 'id' | 'seq' | 'type'>, st: ResultStatus, detail: string, data?: Record<string, unknown>): Promise<void> {
  if (!fleetEnrolled()) return;
  const s = readState();
  pushHistory(s, { id: cmd.id, seq: cmd.seq, type: String(cmd.type), summary: '', status: st, detail: detail.slice(0, 300), at: nowS() });
  const body: Record<string, unknown> = { id: cmd.id, seq: cmd.seq, type: String(cmd.type), status: st, detail: detail.slice(0, 300), at: nowS() };
  if (data) body.data = data;
  s.outbox = [...s.outbox, body].slice(-OUTBOX_MAX);
  saveState(s);
  if (await mayTalk(s)) await flushOutbox(e);
}
// Kuyruğu baştan sırayla gönderir; gidemeyen ilk sonuçta durur (ardındakiler bekler). Kalıcı 4xx (408 / 429 dışı) düşer.
// Aynı anda tek gönderim: yoklama ve onay aynı kuyruğu iki kez göndermez, gönderim sırasında eklenen sonuç kaybolmaz.
let flushing: Promise<void> | null = null;
function flushOutbox(e: Enroll): Promise<void> {
  if (!flushing) flushing = sendOutbox(e).finally(() => { flushing = null; });
  return flushing;
}
async function sendOutbox(e: Enroll): Promise<void> {
  try {
    const key = deviceKey();
    for (;;) {
      if (!fleetEnrolled()) return;
      const body = readState().outbox[0];
      if (!body) return;
      const r = await fleetPost(e.base, e.allow_private, '/v1/result', body, key, e.device_id);
      if (r.error && !(r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) return;
      const cur = readState();
      cur.outbox = cur.outbox.filter(x => x !== body);
      saveState(cur);
    }
  } catch (x: any) {
    console.error('[filo] sonuç kuyruğu:', clean(x?.message || x));
  }
}
function setSummary(id: string, summary: string): void {
  const s = readState();
  for (const h of s.history) if (h.id === id && !h.summary) h.summary = summary;
  saveState(s);
}

// ─── Komut işleme ───
async function handleEnvelope(e: Enroll, env: unknown): Promise<void> {
  const tenantPub = publicKeyFromRaw(e.tenant_pub);
  if (!tenantPub) return;
  const s = readState();
  const v = verifyEnvelope(env, { tenantPub, tenantId: e.tenant_id, deviceId: e.device_id, lastSeq: s.last_seq, nowS: nowS() });
  if (!v.ok) {
    if (v.code === 'seq_replay') return;   // işlenmiş komut yeniden geldi (sonucu kuyrukta): sessizce atla
    if (v.signed && v.seq) {
      const cur = readState();
      cur.last_seq = Math.max(cur.last_seq, v.seq);
      saveState(cur);
    }
    const type = (env as any)?.cmd?.type;
    await recordEvent('fleet', `Filo komutu reddedildi${v.signed ? '' : ' (imzasız / imzası bozuk)'}: ${v.error}`, v.signed && v.code !== 'type_not_allowed' ? 'info' : 'warning');
    if (v.id && v.seq && v.signed) {
      await sendResult(e, { id: v.id, seq: v.seq, type: isWireType(type) ? type : 'report.inventory' }, v.code === 'expired' ? 'expired' : 'rejected', v.error);
      setSummary(v.id, `Reddedildi: ${clean(type, 40) || 'bilinmeyen tür'}`);
    }
    return;
  }
  const cmd = v.cmd;
  // Sıra numarası ÖNCE diske: yeniden başlatmada ya da aynı komut yeniden gelirse ikinci kez işlenmez
  const cur = readState();
  cur.last_seq = cmd.seq;
  saveState(cur);
  const summary = describeCommand(cmd);
  if (cur.approve[baseType(cmd.type)]) {   // ztp.profile: policy.apply'ın onay ayarı
    const s2 = readState();
    s2.awaiting = [...s2.awaiting.filter(a => a.env.cmd.id !== cmd.id), { env: env as Envelope, summary, received_at: nowS() }].slice(-AWAITING_MAX);
    saveState(s2);
    await recordEvent('fleet', `Filo komutu onay bekliyor: ${summary} — Filo sayfasından onaylayın ya da reddedin`, 'warning');
    await sendResult(e, cmd, 'awaiting_approval', 'Cihazda yerel onay bekleniyor');
    setSummary(cmd.id, summary);
    return;
  }
  await execute(e, cmd);
}

const execute = (e: Enroll, cmd: FleetCommand) => serial(() => executeNow(e, cmd));
// Yalnız sıranın İÇİNDEN çağrılır (execute ya da decide).
async function executeNow(e: Enroll, cmd: FleetCommand): Promise<{ status: ResultStatus; detail: string }> {
  if (!fleetEnrolled()) return { status: 'rejected', detail: 'Cihaz filodan ayrıldı' };   // ayrılma sırada önündeydi
  const summary = describeCommand(cmd);
  let r: { status: ResultStatus; detail: string; data?: Record<string, unknown> };
  try {
    if (cmd.type === 'report.inventory') {
      const consent = readState().consent;
      r = { status: 'ok', detail: `Rapor gönderildi (düzey: ${CONSENT_LABEL[consent]})`, data: await buildReport(consent) };
    } else if (cmd.type === 'update.start') {
      r = await runUpdate();
    } else {
      r = await applyPolicy(e, cmd);
    }
  } catch (x: any) {
    r = { status: 'failed', detail: clean(x?.message || x, 300) };
  }
  const sev = r.status === 'ok' || r.status === 'applied' ? 'info' : r.status === 'rejected' ? 'info' : 'warning';
  await recordEvent('fleet', `Filo komutu — ${summary}: ${STATUS_LABEL[r.status]}${r.detail ? ` (${r.detail})` : ''}`.slice(0, 500), sev);
  await sendResult(e, cmd, r.status, r.detail, r.data);
  setSummary(cmd.id, summary);
  return r;
}
const STATUS_LABEL: Record<ResultStatus, string> = {
  ok: 'tamam', failed: 'başarısız', rejected: 'reddedildi', expired: 'süresi doldu', awaiting_approval: 'onay bekliyor',
  applied: 'uygulandı — 10 dk sağlık denetimi', rolled_back: 'geri alındı',
};
const CONSENT_LABEL: Record<Consent, string> = { minimal: 'en az', standard: 'standart', detailed: 'ayrıntılı' };

// update.start: mevcut güncelleme akışı (startUpdate → systemd-run → update-job.sh → GitHub). Depolama / bulut yedeği işi
// sürerken reddedilir; zaten süren güncelleme yinelenmez.
async function runUpdate(): Promise<{ status: ResultStatus; detail: string }> {
  if (!isLinux) return { status: 'rejected', detail: 'Güncelleme yalnız Pi üzerinde çalışır' };
  if (jobGateHolder()) return { status: 'rejected', detail: 'Bir depolama / bulut yedeği işi başlatılıyor — sonra yeniden deneyin' };
  const [st, vj] = await Promise.all([storageJob().catch(() => null), vaultJob().catch(() => null)]);
  if (st?.state === 'running') return { status: 'rejected', detail: STORAGE_BUSY_MSG };
  if (vj?.state === 'running') return { status: 'rejected', detail: 'Bulut yedeği işi sürüyor — bitince yeniden deneyin' };
  try {
    const r = await startUpdate();
    if (!r.started) return { status: 'ok', detail: `Güncelleme zaten sürüyor${r.id ? ` (iş ${r.id})` : ''}` };
    return { status: 'ok', detail: `Güncelleme başlatıldı (iş ${r.id})` };
  } catch (x: any) {
    const msg = clean(x?.message || x, 300);
    return { status: msg === STORAGE_BUSY_MSG || /okunamadı/.test(msg) ? 'rejected' : 'failed', detail: msg };
  }
}

// ─── Rapor (rıza düzeyine göre) ───
async function buildReport(consent: Consent): Promise<Record<string, unknown>> {
  const { version, build } = versionInfo();
  const platform = await readPlatform().catch(() => null);
  const services = await dbAll('SELECT name, status FROM service_status ORDER BY name').catch(() => []) as { name: string; status: string }[];
  const alerts = await dbAll("SELECT severity, COUNT(*) AS n FROM alerts WHERE acknowledged = 0 AND severity IN ('warning', 'critical') GROUP BY severity").catch(() => []) as any[];
  const h = getHealthStatus();
  const report: Record<string, unknown> = {
    consent, version, build, role: STARTUP_ROLE, profile: platform?.profile || null, uptime_s: Math.floor(os.uptime()),
    health: {
      services_running: services.filter(s => s.status === 'running').length,
      services_problem: services.filter(s => s.status === 'error' || s.status === 'stopped').length,
      alerts_warning: Number(alerts.find(a => a.severity === 'warning')?.n || 0),
      alerts_critical: Number(alerts.find(a => a.severity === 'critical')?.n || 0),
      uptime_percent: h.uptimePercent,
    },
  };
  if (consent === 'minimal') return report;
  const upd = await getUpdateStatus().catch(() => null);
  const mem = os.totalmem();
  Object.assign(report, {
    board: platform?.board || null, cpus: os.cpus().length, mem_mib: Math.round(mem / 1048576),
    mem_used_pct: Math.round((1 - os.freemem() / mem) * 100), load1: Math.round(os.loadavg()[0] * 100) / 100,
    services: services.map(s => ({ name: s.name, status: s.status })), update_state: upd?.state || null,
  });
  if (consent === 'standard') return report;
  const ifaces = Object.entries(os.networkInterfaces())
    .filter(([n]) => !/^(lo|docker|veth)/.test(n))
    .map(([name, list]) => ({
      name, mac: (list || []).find(a => a.mac && a.mac !== '00:00:00:00:00:00')?.mac || null,
      ipv4: (list || []).filter(a => a.family === 'IPv4').map(a => `${a.address}/${a.netmask}`),
      ipv6: (list || []).filter(a => a.family === 'IPv6' && !a.address.startsWith('fe80')).map(a => a.address),
    }));
  const dev = await dbGet('SELECT COUNT(*) AS n FROM devices').catch(() => null);
  Object.assign(report, { hostname: os.hostname(), interfaces: ifaces, devices_known: Number(dev?.n || 0) });
  return report;
}

// ─── policy.apply: doğrula → anlık görüntü → uygula → 10 dk sağlık penceresi → onayla ya da geri yükle ───
interface ListRow { id?: number; list_type: string; value: string; comment: string; enabled: number }
// Geri yükleme yalnız filonun değiştirdiği anahtarlara ve yalnız değer hâlâ filonun yazdığıysa dokunur (pencerede yerelde
// yapılan değişiklik korunur; ev ağı muafiyeti / muaf adresler / SSH koruması hep güncel değerden alınır).
interface Snapshot {
  v: 2; id: string; seq: number; summary: string;
  lists: { added: { list_type: string; value: string }[]; removed: ListRow[] } | null;
  f2b: { keys: string[]; prev: Record<string, unknown>; applied: Record<string, unknown> } | null;
  ui: Record<string, { prev: string | null; applied: string }> | null;
}
const snapFile = (id: string) => path.join(PENDING_DIR, `${id}.json`);
const PRESET_URLS = new Set(ADLIST_PRESETS.map(p => p.url));

// Filodan eklenen blokliste adresi: gravity (root) bu adresi indirir — ev ağına, Pi'nin kendisine ya da yerel adlara işaret
// edemez, kullanıcı:parola içeremez (asıl sınır: uzaktan kiracı Pi'ye iç ağda istek attıramaz). Döner: hata ya da boş.
function adlistUrlProblem(v: string): string {
  let u: URL;
  try { u = new URL(v); } catch { return 'Blokliste adresi geçersiz'; }
  if (u.protocol !== 'https:') return 'Filodan eklenen blokliste https:// olmalı';
  if (u.username || u.password) return 'Blokliste adresinde kullanıcı adı / parola olamaz';
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  if (net.isIP(host)) {
    return addrVerdict(host, false, ownAddresses()) ? `Blokliste adresi ev ağına, Pi'nin kendisine ya da ayrılmış bir adrese işaret ediyor (${host}) — filodan eklenemez` : '';
  }
  if (!host.includes('.') || /(^|\.)(localhost|lan|local|home|internal|intranet|home\.arpa)$/.test(host)) {
    return `Blokliste adresi yerel ağ adı olamaz (${host.slice(0, 80)}) — filodan eklenemez`;
  }
  return '';
}
// Filonun beyaz listesi ebeveyn denetimini ve şifreli DNS engelini aşamaz: Pi-hole'da izin kaydı engeli ezer ve filo kaydı
// herkesin grubuna (Default) girer. Engelli alan adları: DoH / DoT adları + ebeveyn kurallarının (açık ya da kapalı)
// kategori alan adları ve siteleri. Kurallar okunamazsa beyaz liste kaydı uygulanmaz (güvenli taraf).
async function whitelistBlockers(): Promise<string[]> {
  const out = new Set<string>(DOH_DOMAINS);
  const rules = await listRules().catch(() => { throw new Error('Ebeveyn denetimi kuralları okunamadı — beyaz liste kaydı uygulanmadı'); });
  for (const r of rules) {
    for (const c of r.categories) for (const d of CATEGORIES[c]?.domains || []) out.add(d);
    for (const s of r.sites) out.add(s);
  }
  return [...out];
}
// "*.x" = x ve alt alan adları. Döner: çakışan engelli ad ya da boş.
function whitelistConflict(value: string, blocked: string[]): string {
  const wild = value.startsWith('*.');
  const d = value.replace(/^\*\./, '');
  return blocked.find(b => d === b || d.endsWith(`.${b}`) || (wild && b.endsWith(`.${d}`))) || '';
}

async function applyPolicy(e: Enroll, cmd: FleetCommand): Promise<{ status: ResultStatus; detail: string }> {
  const s = readState();
  if (s.pending_policy) return { status: 'rejected', detail: 'Önceki politika henüz onaylanmadı (10 dk sağlık penceresi) — sonra yeniden gönderin' };
  const p = cmd.params as PolicyParams;
  // 1) Anlamsal doğrulama — hiçbir şeye dokunmadan
  const listAdd: { list_type: string; value: string; comment: string }[] = [];
  const listRemove: ListRow[] = [];
  if (p.pihole_lists) {
    const have = await dbAll('SELECT id, list_type, value, comment, enabled FROM pihole_lists') as ListRow[];
    const key = (t: string, v: string) => `${t}\n${v}`;
    const byKey = new Map(have.map(r => [key(r.list_type, r.value), r]));
    const blocked = (p.pihole_lists.add || []).some(a => a.list_type === 'whitelist') ? await whitelistBlockers() : [];
    for (const a of p.pihole_lists.add || []) {
      const bad = validateListValue(a.list_type, a.value);
      if (bad) return { status: 'rejected', detail: `Liste kaydı geçersiz (${a.list_type}): ${bad}` };
      const v = normalizeListValue(a.list_type, a.value);
      if (a.list_type === 'adlist' && (PRESET_URLS.has(v) || /\/StevenBlack\/hosts\//i.test(v))) return { status: 'rejected', detail: 'Hazır blokliste seçimi filodan değiştirilemez (Pi-hole → Bloklisteleri)' };
      if (a.list_type === 'adlist') {
        const why = adlistUrlProblem(v);
        if (why) return { status: 'rejected', detail: why };
      }
      if (a.list_type === 'whitelist') {
        const hit = whitelistConflict(v, blocked);
        if (hit) return { status: 'rejected', detail: `Beyaz liste kaydı ebeveyn denetimini / şifreli DNS engelini aşar (${v.slice(0, 80)} ↔ ${hit}) — filodan eklenemez, gerekirse yerelde ekleyin` };
      }
      if (!byKey.has(key(a.list_type, v))) listAdd.push({ list_type: a.list_type, value: v, comment: `${FLEET_MARK} ${clean(a.comment, 150)}`.trim().slice(0, 200) });
    }
    for (const rm of p.pihole_lists.remove || []) {
      const v = normalizeListValue(rm.list_type, rm.value);
      const row = byKey.get(key(rm.list_type, v));
      if (!row) continue;   // zaten yok
      if (!String(row.comment || '').startsWith(FLEET_MARK)) return { status: 'rejected', detail: `Yalnız filonun eklediği kayıt çıkarılabilir: ${v.slice(0, 80)}` };
      listRemove.push(row);
    }
  }
  let f2bSnap: Snapshot['f2b'] = null;
  let f2bNext: Fail2banSettings | null = null;
  if (p.fail2ban) {
    const f2bPrev = await readFail2banSettings();
    const merged = validateFail2banSettings({ ...f2bPrev, ...p.fail2ban, lan_exempt: f2bPrev.lan_exempt, extra_ignore: f2bPrev.extra_ignore, sshd_enabled: f2bPrev.sshd_enabled });
    if (typeof merged === 'string') return { status: 'rejected', detail: `Fail2Ban: ${merged}` };
    f2bNext = merged;
    const keys = Object.keys(p.fail2ban);   // fleetProto F2B_POLICY_KEYS ile sınırlı
    const pick = (o: Record<string, unknown>) => Object.fromEntries(keys.map(k => [k, o[k]]));
    f2bSnap = { keys, prev: pick(f2bPrev as unknown as Record<string, unknown>), applied: pick(merged as unknown as Record<string, unknown>) };
  }
  let uiSnap: Snapshot['ui'] = null;
  if (p.ui_settings) {
    const keys = uiDeps.keys();
    const badKey = Object.keys(p.ui_settings).find(k => !keys.has(k) || UI_DENY.has(k));
    if (badKey) return { status: 'rejected', detail: `Bu ayar filodan değiştirilemez: ${badKey}` };
    for (const [k, v] of Object.entries(p.ui_settings)) {
      const why = uiDeps.check(k, v);
      if (why) return { status: 'rejected', detail: why };
    }
    uiSnap = {};
    for (const [k, v] of Object.entries(p.ui_settings)) {
      const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [k]);
      uiSnap[k] = { prev: row ? String(row.value) : null, applied: String(v).slice(0, 500) };
    }
  }
  // ztp.profile'ın ağ önerisi yalnız panel kartı olarak saklanır: hiçbir ağ betiği / komutu çağrılmaz (G4.2)
  const suggestion = cmd.type === 'ztp.profile' && p.net_suggestion ? p.net_suggestion : null;
  if (!listAdd.length && !listRemove.length && !f2bNext && !uiSnap) {
    if (suggestion) {
      saveSuggestion(cmd.id, suggestion);
      return { status: 'ok', detail: 'Ağ önerisi panelde kart olarak gösterildi — uygulanmadı' };
    }
    return { status: 'ok', detail: 'Değişiklik yok (kayıtlar zaten istenen durumda)' };
  }
  // 2) Anlık görüntü (uygulamadan ÖNCE diske)
  const summary = describeCommand(cmd);
  const snap: Snapshot = {
    v: 2, id: cmd.id, seq: cmd.seq, summary,
    lists: listAdd.length || listRemove.length ? { added: listAdd.map(a => ({ list_type: a.list_type, value: a.value })), removed: listRemove } : null,
    f2b: f2bSnap, ui: uiSnap,
  };
  writeFile0600(snapFile(cmd.id), JSON.stringify(snap));
  const cur = readState();
  cur.pending_policy = { id: cmd.id, seq: cmd.seq, applied_at: nowS(), deadline: nowS() + CONFIRM_S, ok_poll: false, ok_dns: false, summary };
  if (cmd.type === 'ztp.profile') cur.pending_policy.type = 'ztp.profile';
  saveState(cur);
  // 3) Uygula
  const notes: string[] = [];
  if (snap.lists) {
    for (const a of listAdd) await dbRun('INSERT OR IGNORE INTO pihole_lists (list_type, value, comment) VALUES (?, ?, ?)', [a.list_type, a.value, a.comment]);
    for (const r of listRemove) await dbRun('DELETE FROM pihole_lists WHERE id = ?', [r.id]);
    const sync = await syncPiholeLists();
    notes.push(`DNS listeleri +${listAdd.length} / −${listRemove.length}${sync.ok ? '' : ` (Pi-hole'a uygulanamadı: ${clean(sync.errors.join('; '), 120)})`}`);
  }
  if (f2bNext) {
    const r = await applyFail2banSettings(f2bNext);
    if (!r.ok) {
      await rollbackPolicy(`Fail2Ban uygulanamadı: ${r.error || 'bilinmeyen hata'}`, true);
      return { status: 'failed', detail: `Fail2Ban uygulanamadı (${clean(r.error, 160)}) — politikanın tamamı geri alındı` };
    }
    notes.push('Fail2Ban ayarları');
  }
  if (uiSnap) {
    for (const [k, u] of Object.entries(uiSnap)) await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [k, u.applied]);
    try { uiDeps.changed(Object.keys(uiSnap)); } catch { /* zamanlayıcı yeniden planlanamadı: günlükte */ }
    notes.push(`arayüz ayarları (${Object.keys(uiSnap).join(', ')})`);
  }
  if (suggestion) {
    saveSuggestion(cmd.id, suggestion);
    notes.push('ağ önerisi (yalnız panelde kart, uygulanmadı)');
  }
  scheduleConfirm(5000);
  schedule(5000);   // sağlık penceresinin ilk yoklaması hemen (yoklamanın içinde uygulandıysa tick sonu da ≤ 15 sn planlar)
  return { status: 'applied', detail: `${notes.join('; ')} — ${Math.round(CONFIRM_S / 60)} dk içinde yoklama + DNS yanıtı gelmezse otomatik geri alınır` };
}

// Ağ önerisi kartı (G4.2): düz metin + sabit sekme listesinden bağlantı; yalnız durum dosyasına yazılır.
function saveSuggestion(cmdId: string, n: NetSuggestion): void {
  const s = readState();
  s.net_suggestion = { text: n.text.trim().slice(0, 300), ...(n.tab ? { tab: n.tab } : {}), at: nowS(), cmd: cmdId };
  saveState(s);
}
export function clearNetSuggestion(): boolean {
  if (!fleetEnrolled()) return false;
  const s = readState();
  if (!s.net_suggestion) return false;
  delete s.net_suggestion;
  saveState(s);
  return true;
}

async function dnsHealthy(): Promise<boolean> {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  try {
    r.setServers([DNS_TARGET]);
    await r.resolve4('pi.hole');
    return true;
  } catch (x: any) {
    return x?.code === 'ENOTFOUND' || x?.code === 'ENODATA';   // NXDOMAIN / kayıt yok = DNS yanıt veriyor
  }
}
function scheduleConfirm(ms: number): void {
  if (leaving) return;
  if (confirmTimer) clearTimeout(confirmTimer);
  const gen = agentGen;
  confirmTimer = setTimeout(() => { confirmTimer = null; if (gen === agentGen) void serial(confirmTick); }, ms);
}
// Yalnız sıranın İÇİNDEN (scheduleConfirm). Konuşulamıyorsa (kopya kart, duraklatılmış, HA yedek) sonuç kuyrukta kalır;
// geri yükleme yine yerelde yapılır (sunucuya başarılı yoklama yoksa politika kalıcı olmaz).
async function confirmTick(): Promise<void> {
  const s = readState();
  const pp = s.pending_policy;
  if (!pp || !fleetEnrolled()) return;
  const dnsOk = await dnsHealthy();
  const cur = readState();
  if (!cur.pending_policy || cur.pending_policy.id !== pp.id) return;
  if (dnsOk) cur.pending_policy.ok_dns = true;
  saveState(cur);
  if (cur.pending_policy.ok_poll && dnsOk) {
    try { fs.rmSync(snapFile(pp.id), { force: true }); } catch { /* */ }
    const done = readState();
    done.pending_policy = null;
    saveState(done);
    await recordEvent('fleet', `Filo politikası kalıcı oldu: ${pp.summary} (yoklama ve DNS sağlıklı)`);
    const e = readEnroll();
    if (e) await sendResult(e, { id: pp.id, seq: pp.seq, type: pp.type || 'policy.apply' }, 'ok', 'Sağlık denetimi geçti — politika kalıcı');
    setSummary(pp.id, pp.summary);
    return;
  }
  if (nowS() >= pp.deadline) {
    await rollbackPolicy(`${Math.round(CONFIRM_S / 60)} dk içinde ${!cur.pending_policy.ok_poll ? 'başarılı yoklama' : ''}${!cur.pending_policy.ok_poll && !dnsOk ? ' ve ' : ''}${!dnsOk ? '127.0.0.1:53 DNS yanıtı' : ''} alınamadı`);
    return;
  }
  scheduleConfirm(15000);
}

// Anlık görüntüyü geri yükler — yalnız filonun yaptığını: eklediği kayıtlar silinir, çıkardıkları geri gelir; Fail2Ban ve
// arayüz ayarlarında yalnız filonun değiştirdiği anahtarlar ve yalnız değer hâlâ filonun yazdığıysa önceki değerine döner
// (pencerede yerelde yeniden değiştirilen ayar ve filonun hiç dokunamadığı alanlar — ev ağı muafiyeti, muaf adresler, SSH
// koruması — güncel hâliyle kalır). Yalnız sıranın İÇİNDEN. quiet: çağıran sonucu kendisi bildirir.
async function rollbackPolicy(reason: string, quiet = false): Promise<void> {
  const s = readState();
  const pp = s.pending_policy;
  if (!pp) return;
  const snap = readJson(snapFile(pp.id)) as Snapshot | null;
  const errs: string[] = [];
  const kept: string[] = [];
  if (snap?.lists) {
    try {
      for (const a of snap.lists.added) await dbRun('DELETE FROM pihole_lists WHERE list_type = ? AND value = ? AND comment LIKE ?', [a.list_type, a.value, `${FLEET_MARK}%`]);
      for (const r of snap.lists.removed) await dbRun('INSERT OR IGNORE INTO pihole_lists (list_type, value, comment, enabled) VALUES (?, ?, ?, ?)', [r.list_type, r.value, r.comment, r.enabled]);
      const sync = await syncPiholeLists();
      if (!sync.ok) errs.push(`Pi-hole'a uygulanamadı: ${clean(sync.errors.join('; '), 120)}`);
    } catch (x: any) { errs.push(`DNS listeleri: ${clean(x?.message || x, 120)}`); }
  }
  if (snap?.f2b && Array.isArray(snap.f2b.keys)) {
    try {
      const now = await readFail2banSettings();
      const back: Record<string, unknown> = { ...now };
      let change = false;
      for (const k of snap.f2b.keys) {
        const cur = (now as unknown as Record<string, unknown>)[k];
        if (cur === snap.f2b.prev[k]) continue;   // zaten önceki değerde (ör. uygulanamadan geri alınıyor)
        if (cur === snap.f2b.applied[k]) { back[k] = snap.f2b.prev[k]; change = true; } else kept.push(`Fail2Ban ${k}`);
      }
      const v = change ? validateFail2banSettings(back) : null;
      if (typeof v === 'string') errs.push(`Fail2Ban: ${v}`);
      else if (v) {
        const r = await applyFail2banSettings(v);
        if (!r.ok) errs.push(`Fail2Ban: ${clean(r.error, 120)}`);
      }
    } catch (x: any) { errs.push(`Fail2Ban: ${clean(x?.message || x, 120)}`); }
  }
  if (snap?.ui) {
    try {
      const back: string[] = [];
      for (const [k, u] of Object.entries(snap.ui)) {
        const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [k]);
        const cur = row ? String(row.value) : null;
        if (cur === u.prev) continue;
        if (cur !== u.applied) { kept.push(`arayüz ${k}`); continue; }
        if (u.prev === null) await dbRun('DELETE FROM app_settings WHERE key = ?', [k]);
        else await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [k, u.prev]);
        back.push(k);
      }
      if (back.length) uiDeps.changed(back);
    } catch (x: any) { errs.push(`arayüz ayarları: ${clean(x?.message || x, 120)}`); }
  }
  if (!snap) errs.push('anlık görüntü dosyası bulunamadı');
  try { fs.rmSync(snapFile(pp.id), { force: true }); } catch { /* */ }
  const cur = readState();
  cur.pending_policy = null;
  saveState(cur);
  const note = `${errs.length ? ` (sorun: ${errs.join('; ')})` : ''}${kept.length ? ` (pencerede yerelde değiştirildiği için dokunulmadı: ${kept.join(', ')})` : ''}`;
  await recordEvent('fleet', `Filo politikası geri alındı: ${pp.summary} — ${reason}${note}`.slice(0, 500), 'warning');
  if (quiet) return;
  const e = readEnroll();
  if (e && fleetEnrolled()) {
    await sendResult(e, { id: pp.id, seq: pp.seq, type: pp.type || 'policy.apply' }, 'rolled_back', `${reason}${note}`);
    setSummary(pp.id, pp.summary);
  }
}

// ─── Yerel onay (sıradan geçer: iki onay aynı anda iki politika uygulayamaz) ───
// Onay yalnız cihaz sunucuyla konuşabilirken: kopya kartta, duraklatılmışken, sunucu cihazı kaldırmışken ya da HA'da etkin
// olmayan düğümde komut uygulanmaz (duraklatılmışken uygulanan politika yoklama olmadığından pencere sonunda kesin geri
// alınırdı). Ret her durumda yerelde işlenir; sonucu konuşulabilir olunca gider.
const decide = (id: string, approve: boolean) => serial(() => decideNow(id, approve));
async function decideNow(id: string, approve: boolean): Promise<{ status: ResultStatus; detail: string }> {
  const e = readEnroll();
  if (!e) throw Object.assign(new Error('Cihaz bir filoya kayıtlı değil'), { status: 409 });
  const s = readState();
  const a = s.awaiting.find(x => x.env.cmd.id === id);
  if (!a) throw Object.assign(new Error('Bekleyen komut bulunamadı (süresi dolmuş ya da işlenmiş olabilir)'), { status: 404 });
  if (approve) {
    const why = hwMismatch() ? 'Bu SD kart başka bir cihazdan kopyalanmış — komut uygulanmaz; bu kopyadaki filo kaydını silip yeniden kaydolun'
      : s.revoked ? 'Sunucu bu cihazı kaldırmış — komut uygulanmaz'
        : !s.enabled ? 'Yoklama duraklatılmış — önce «Sürdür»; duraklatılmışken komut uygulanmaz'
          : !fleetMayRun() ? 'Bu cihaz şu an filo için etkin değil (HA yedek düğüm) — komut uygulanmaz' : '';
    if (why) throw Object.assign(new Error(why), { status: 409 });
  }
  s.awaiting = s.awaiting.filter(x => x.env.cmd.id !== id);
  saveState(s);
  const cmd = a.env.cmd;
  if (!approve) {
    await recordEvent('fleet', `Filo komutu yerelde reddedildi: ${a.summary}`);
    await sendResult(e, cmd, 'rejected', 'Cihaz yöneticisi yerelde reddetti');
    setSummary(cmd.id, a.summary);
    return { status: 'rejected', detail: 'Reddedildi' };
  }
  // Onay anında imza yeniden doğrulanır (dosya elle değiştirilmiş olabilir); seq zaten işlenmiş sayılır
  const tenantPub = publicKeyFromRaw(e.tenant_pub);
  const v = tenantPub ? verifyEnvelope(a.env, { tenantPub, tenantId: e.tenant_id, deviceId: e.device_id, lastSeq: cmd.seq - 1, nowS: nowS() }) : null;
  if (!v || !v.ok) {
    const why = v && !v.ok ? v.error : 'kiracı anahtarı okunamadı';
    await sendResult(e, cmd, v && !v.ok && v.code === 'expired' ? 'expired' : 'rejected', why);
    setSummary(cmd.id, a.summary);
    throw Object.assign(new Error(`Komut uygulanamadı: ${why}`), { status: 409 });
  }
  return executeNow(e, v.cmd);
}
async function pruneAwaiting(): Promise<void> {
  const e = readEnroll();
  if (!e) return;
  const s = readState();
  const old = s.awaiting.filter(a => nowS() > a.env.cmd.not_after);
  if (!old.length) return;
  s.awaiting = s.awaiting.filter(a => nowS() <= a.env.cmd.not_after);
  saveState(s);
  for (const a of old) {
    await sendResult(e, a.env.cmd, 'expired', 'Yerel onay süresinde verilmedi');
    setSummary(a.env.cmd.id, a.summary);
  }
}

// ─── Durum (panel) ───
export async function fleetStatus(): Promise<Record<string, unknown>> {
  const base = { supported: true, proto: FLEET_PROTO, types: COMMAND_TYPES.map(t => ({ id: t, label: TYPE_LABEL[t] })), pollRange: { min: POLL_MIN_S, max: POLL_MAX_S } };
  if (!fleetEnrolled()) return { ...base, enrolled: false };
  const e = readEnroll();
  const s = readState();
  let pub = '';
  try { pub = publicRawOf(crypto.createPublicKey(deviceKey())); } catch { /* okunamadı */ }
  const st = !e ? 'error' : hwMismatch() ? 'rebind' : s.revoked ? 'revoked' : !s.enabled ? 'paused' : status === 'off' ? 'starting' : status;
  // Onay kartı ayrıntısı: politikanın her kaydı ve ayarın şimdiki → yeni değeri (yönetici neyi onayladığını görür)
  const live = s.awaiting.filter(a => nowS() <= a.env.cmd.not_after);
  const policies = live.filter(a => baseType(a.env.cmd.type) === 'policy.apply').map(a => a.env.cmd.params as PolicyParams);
  const f2bNow = policies.some(p => p.fail2ban) ? await readFail2banSettings().catch(() => null) : null;
  const uiNow: Record<string, string | null> = {};
  for (const k of new Set(policies.flatMap(p => Object.keys(p.ui_settings || {})))) {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [k]).catch(() => undefined);
    uiNow[k] = row ? String(row.value) : null;
  }
  return {
    ...base, enrolled: true, state: st,
    server: e ? e.base : null, host: e ? new URL(e.base).host : null, allowPrivate: !!e?.allow_private,
    tenant: e ? { id: e.tenant_id, name: e.tenant_name } : null, deviceId: e?.device_id || null, site: e?.site || '',
    keyFingerprint: pub ? fingerprint(pub) : null, enrolledAt: e?.enrolled_at || null,
    pollS: e ? effectivePoll(e, s) : POLL_DEFAULT_S, pollOverride: s.poll_s, serverPollS: e?.poll_s || null,
    enabled: s.enabled, consent: s.consent, approve: s.approve, lastSeq: s.last_seq,
    lastPollAt: s.last_poll_at || null, lastOkAt: s.last_ok_at || null, lastError: s.last_error || null, failures: s.failures,
    awaiting: live.map(a => ({
      id: a.env.cmd.id, seq: a.env.cmd.seq, type: a.env.cmd.type, summary: a.summary, receivedAt: a.received_at, notAfter: a.env.cmd.not_after,
      details: baseType(a.env.cmd.type) === 'policy.apply' ? policyLines(a.env.cmd.params as PolicyParams, { f2b: f2bNow as unknown as Record<string, unknown> | null, ui: uiNow }) : [],
      // G4.2: yalnız ağ önerisi içeren ztp.profile — onaylanınca hiçbir ayar değişmez (anlık görüntü / sağlık penceresi yok)
      ...(a.env.cmd.type === 'ztp.profile' && Object.keys(a.env.cmd.params).join() === 'net_suggestion' ? { suggestionOnly: true } : {}),
    })),
    history: s.history,
    pendingPolicy: s.pending_policy ? { ...s.pending_policy } : null, outbox: s.outbox.length,
    // G4.2: yalnız ZTP / kodla kayıtta ve ağ önerisi varken (panelden kayıtlı cihazın yanıtı G4.1 ile aynı)
    ...(e?.source ? { source: e.source } : {}),
    ...(s.net_suggestion ? { netSuggestion: { text: s.net_suggestion.text, tab: s.net_suggestion.tab || null, at: s.net_suggestion.at } } : {}),
  };
}

async function saveSettings(body: any): Promise<void> {
  if (!fleetEnrolled()) throw Object.assign(new Error('Cihaz bir filoya kayıtlı değil'), { status: 409 });
  const s = readState();
  const notes: string[] = [];
  if (body.consent !== undefined) {
    if (!CONSENTS.includes(body.consent)) throw Object.assign(new Error("'consent' minimal, standard ya da detailed olmalı"), { status: 400 });
    if (body.consent !== s.consent) notes.push(`rapor düzeyi: ${CONSENT_LABEL[body.consent as Consent]}`);
    s.consent = body.consent;
  }
  if (body.approve !== undefined) {
    if (!body.approve || typeof body.approve !== 'object' || Object.entries(body.approve).some(([k, v]) => !isCommandType(k) || typeof v !== 'boolean')) {
      throw Object.assign(new Error("'approve' komut türü → true/false olmalı"), { status: 400 });
    }
    for (const [k, v] of Object.entries(body.approve as Record<CommandType, boolean>)) {
      if (s.approve[k as CommandType] !== v) notes.push(`${TYPE_LABEL[k as CommandType]}: ${v ? 'onay ister' : 'onaysız uygulanır'}`);
      s.approve[k as CommandType] = v;
    }
  }
  if (body.poll_s !== undefined) {
    if (body.poll_s !== null && (!Number.isInteger(body.poll_s) || body.poll_s < POLL_MIN_S || body.poll_s > POLL_MAX_S)) {
      throw Object.assign(new Error(`Yoklama aralığı ${POLL_MIN_S}–${POLL_MAX_S} sn olmalı`), { status: 400 });
    }
    s.poll_s = body.poll_s;
  }
  let resume = false;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw Object.assign(new Error("'enabled' true ya da false olmalı"), { status: 400 });
    if (body.enabled !== s.enabled) { notes.push(body.enabled ? 'yoklama sürdürüldü' : 'yoklama duraklatıldı'); resume = body.enabled; }
    s.enabled = body.enabled;
  }
  saveState(s);
  if (notes.length) await recordEvent('fleet', `Filo ayarları: ${notes.join(', ')}`);
  if (body.enabled === false) { if (timer) clearTimeout(timer); timer = null; status = 'paused'; }
  if (resume && fleetMayRun()) { status = 'off'; schedule(1000); }
}

// ─── Uçlar: /api/fleet — GET dışı yazma sınırı + netAdminGuard, uyduda 409 ───
export function registerFleetRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw; ui: FleetUiDeps }): void {
  uiDeps = deps.ui;
  app.use('/api/fleet', (req, res, next) => (req.method === 'GET' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — filo bağlantısı ana cihazdadır' });
    deps.guard(req, res, next);
  });
  const fail = (res: express.Response, e: any) => res.status(Number(e?.status) || 500).json({ error: String(e?.message || e) });
  app.get('/api/fleet', async (_req, res) => {
    try { res.json(await fleetStatus()); } catch (e: any) { fail(res, e); }
  });
  app.post('/api/fleet/enroll', async (req, res) => {
    try {
      const r = await enrollFleet(req.body || {});
      res.json({ success: true, ...r, ...(await fleetStatus()) });
    } catch (e: any) { fail(res, e); }
  });
  app.put('/api/fleet/settings', async (req, res) => {
    try {
      await saveSettings(req.body || {});
      res.json({ success: true, ...(await fleetStatus()) });
    } catch (e: any) { fail(res, e); }
  });
  app.post('/api/fleet/commands/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!ID_RE.test(id) || (action !== 'approve' && action !== 'reject')) return res.status(404).json({ error: 'Bilinmeyen işlem' });
    try {
      const r = await decide(id, action === 'approve');
      res.json({ success: true, result: r, ...(await fleetStatus()) });
    } catch (e: any) { fail(res, e); }
  });
  app.post('/api/fleet/leave', async (_req, res) => {
    try {
      const r = await leaveFleet();
      res.json({ success: true, ...r, ...(await fleetStatus()) });
    } catch (e: any) { fail(res, e); }
  });
}

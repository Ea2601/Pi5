// ZTP — SD karttaki dosyayla ya da kayıt koduyla filo kaydı (G4.2; G4.1 filo ajanı fleet.ts'in üzerine; protokol
// docs/fleet-protocol.md § 5.5, § 7, § 11). Kapsam yalnız KAYIT + ağ dışı profil (ztp.profile = policy.apply'ın takma adı,
// fleet.ts'te aynı yoldan yürür). Ağ ayarı, panel parolası / koruması ve rol buluttan GELMEZ; ağ önerisi yalnız panelde kart.
//  İKİ TETİK, ikisi de VARSAYILAN KAPALI: dosya yoksa ve düğmeye basılmadıysa hiçbir dosya, anahtar, zamanlayıcı ya da ağ
//  isteği yoktur (ztpCheck yalnız kayıt dosyasına ve ZTP dosyasının varlığına bakıp döner).
//  (1) Dosya: /boot/firmware/klyrix-ztp.json = { v: 1, base_url (yalnız https), claim (tek kullanımlık kayıt anahtarı),
//      site_label? }. Açılışta (index.ts: ensure'lardan sonra, yalnız ana cihazda ve G4.1 kaydı yokken) okunur: en çok 4 KiB,
//      normal dosya (sembolik bağ izlenmez), sıkı şema (bilinmeyen alan → ret). Kayıt G4.1 enrollFleet ile (kaynak 'ztp-file').
//      Dosya YALNIZ KESİN SONUÇTA silinir: başarı, sunucunun kesin reddi (kodlu 4xx), geçersiz dosya ya da cihazın başka yolla
//      (panel anahtarı / kayıt kodu) kayıtlı olması — dosya artık kullanılamaz; kartta kalırsa «Filodan ayrıl» + yeniden başlatma
//      onunla sessizce yeniden kayda yol açardı. Silmeden önce üzerine sıfır yazılır — FAT'ta kesin silme garanti değildir; asıl
//      koruma sunucudadır (anahtar tek kullanımlık, kısa ömürlü).
//      Geçici hatada (ağ yok, 5xx, kodsuz 4xx, saat eşitsiz, HA yedek) dosya yerinde kalır; üstel geri çekilme, en çok 30 dk.
//      Sonuç işareti /etc/pi5-gateway/fleet/ztp.done (0600): silinemeyen dosya (sıfırlamadan sonraki boyut + değişiklik zamanı
//      aynı) ya da içeriği zaten sıfırlanmış dosya yeniden işlenmez, yalnız silme yeniden denenir.
//  (2) Kod: panelde «Filoya kodla kaydol» → cihaz anahtarı YALNIZ BELLEKTE üretilir; kayıt kodu = base32(sha256(açık anahtar))
//      ilk 8 karakter (4-4). /v1/claim-status 15 sn'de bir, en çok 10 dk (mesh.ts createPairing / PAIR_TTL_MS deseni); yönetici
//      kodu konsola girince kiracı bilgisi gelir ve G4.1 kayıt dosyaları yazılır (kaynak 'code'). Süre dolunca, «İptal» ile ya da
//      backend yeniden başlayınca anahtar ve bekleyen durum yok olur (diske hiç yazılmamıştır — yarım anahtar kalmaz). Aynı anda
//      tek bekleyen kod.
//  - claim değeri günlüğe, olaya, app_settings'e, argv / env'e ve API yanıtına ASLA girmez (yalnız /v1/enroll gövdesinde gider);
//    sunucunun hata metni claim'den 8+ karakterlik bir parça bile taşıyorsa gösterilmez (yalnız HTTP durumu + hata kodu).
//  - Uyduda çalışmaz (uçlar G4.1 ara katmanından 409); HA'da yalnız etkin düğümde (fleetMayRun — G4.1'in tek kapısı).
//  - Sonuçlar 'fleet' olayı (yeni olay kaynağı yok). Ağ betiği / komutu (net-mode.sh, pi-dhcp.sh, panel-auth.sh, nft, ip) YOK.
import fs from 'fs';
import net from 'net';
import path from 'path';
import type express from 'express';
import { recordEvent } from './events';
import { isSatellite } from './role';
import { hwTag } from './mesh';
import { testEnv } from './notifyStore';
import { addrVerdict, ownAddresses } from './notify';
import { clockSynced } from './vault';
import {
  FLEET_DIR, fleetEnrolled, fleetMayRun, fleetEnrollBusy, enrollFleet, adoptEnrollment, claimStatusRequest, clearNetSuggestion,
  onFleetEnrolled, type HttpResult,
} from './fleet';
import { checkBaseUrl, generateDeviceKey, claimCode, fingerprint } from './fleetProto';

export const ZTP_FILE = testEnv('KLX_ZTP_FILE') || '/boot/firmware/klyrix-ztp.json';
const DONE_FILE = path.join(FLEET_DIR, 'ztp.done');
export const ZTP_MAX_BYTES = 4096;
const RETRY_BASE_S = Number(testEnv('KLX_ZTP_RETRY_S')) || 30;      // geçici hatada ilk bekleme (yalnız test kısaltır)
const RETRY_MAX_S = 1800;                                           // en çok 30 dk aralık
const CLOCK_MAX_S = 300;   // saat eşitlenmesini beklerken (yalnız yerel denetim, ağ isteği yok): ilk beklemeden üstel, en çok 5 dk
export const CLAIM_TTL_S = Number(testEnv('KLX_ZTP_CLAIM_TTL_S')) || 600;   // kayıt kodu ömrü (PAIR_TTL_MS gibi 10 dk)
export const CLAIM_POLL_S = Number(testEnv('KLX_ZTP_CLAIM_POLL_S')) || 15;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;   // Windows'ta (geliştirme) tanımsız
const nowS = () => Math.floor(Date.now() / 1000);
const clean = (s: unknown, n = 200) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, n);
const hide = (s: string, secret: string) => (secret ? s.split(secret).join('••••') : s);
// Metin claim'den 8+ karakterlik bir parça taşıyor mu (kesilmiş ya da kısmi yankı dahil)
const leaks = (s: string, secret: string) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (s.includes(secret.slice(i, i + 8))) return true;
  return false;
};
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,39}$/;
const safeCode = (code: string, secret: string) => (CODE_RE.test(code) && !leaks(code, secret) ? code : '••••');
// Panelde / olayda / ztp.done'da gösterilecek kayıt hatası: önce maske, sonra kesme; sunucunun metni claim'den parça taşıyorsa
// yalnız HTTP durumu + hata kodu. Adın ev ağına çözülmesi (geçici) ZTP'ye göre anlatılır (kanal onayı ZTP'de yok).
function safeText(e: any, secret: string): string {
  const t = clean(hide(String(e?.message ?? ''), secret), 240)
    .replace(/ — ev ağına göndermek için kanalda "Ev ağındaki hedefe izin ver" onayı gerekir/, ' — ZTP ile ev ağındaki sunucuya kaydolunmaz; sunucu adının çözümü düzelince yeniden denenir');
  if (!leaks(t, secret)) return t;
  const st = Number(e?.httpStatus) || 0;
  const code = clean(e?.code, 40);
  return st ? `HTTP ${st}${code ? ` (${safeCode(code, secret)})` : ''} — sunucunun hata metni kayıt anahtarından parça içerdiği için gösterilmiyor`
    : 'ayrıntı gizlendi (kayıt anahtarından parça içeriyordu)';
}
const httpError = (msg: string, status: number) => Object.assign(new Error(msg), { status });

// ─── Dosya şeması (sıkı) ───
export interface ZtpConfig { base: string; host: string; claim: string; site: string }
const ZTP_KEYS = new Set(['v', 'base_url', 'claim', 'site_label']);
// Hata metni dosyadan hiçbir parça içermez (JSON ayrıştırıcısının iletisi girdiden kesit taşır → yazılmaz).
export function parseZtpConfig(text: string): { cfg: ZtpConfig } | { error: string } {
  let j: unknown;
  try { j = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return { error: 'dosya geçerli JSON değil' }; }   // Windows Not Defteri BOM'u kabul
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'dosya bir JSON nesnesi değil' };
  const o = j as Record<string, unknown>;
  if (Object.keys(o).some(k => !ZTP_KEYS.has(k))) return { error: 'bilinmeyen alan var (izinli: v, base_url, claim, site_label)' };
  if (o.v !== 1) return { error: "'v' 1 olmalı" };
  const b = checkBaseUrl(o.base_url);
  if ('error' in b) return { error: `base_url — ${b.error}` };
  const u = new URL(b.base);
  // IP yazılmış adres ev ağı / Pi'nin kendisi / ayrılmış adresse kesin geçersiz (ZTP'de «ev ağına izin ver» yoktur, hiç
  // başaramazdı). Ad yazılmış adresin çözümü bağlanırken denetlenir: ev ağına çözülürse geçici hata (ad çözümü düzelebilir).
  const ip = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(ip) && addrVerdict(ip, false, ownAddresses())) {
    return { error: "base_url ev ağındaki, Pi'nin kendisine ait ya da ayrılmış bir IP adresi — ZTP dosyasında izin verilmez (internetteki sunucunun adresini yazın)" };
  }
  const claim = o.claim;
  if (typeof claim !== 'string' || claim.length < 8 || claim.length > 256 || /[\s\x00-\x1f\x7f]/.test(claim)) {
    return { error: "'claim' 8–256 karakter olmalı (boşluksuz)" };
  }
  let site = '';
  if (o.site_label !== undefined) {
    if (typeof o.site_label !== 'string') return { error: "'site_label' metin olmalı" };
    site = o.site_label.trim();
    if ([...site].length > 40 || /[\x00-\x1f\x7f<>]/.test(site)) return { error: "'site_label' en çok 40 karakter olmalı (< > olmadan)" };
  }
  return { cfg: { base: b.base, host: u.host, claim, site } };
}

// ─── Dosyayı güvenli okuma ve silme ───
type Probe =
  | { kind: 'none' }
  | { kind: 'unreadable' }                       // G/Ç hatası: geçici, dosyaya dokunulmaz
  | { kind: 'bad'; why: string; sig: string }    // kesin: geçersiz dosya
  | { kind: 'ok'; text: string; sig: string };
// Dosya kimliği (ztp.done'da): boyut + değişiklik zamanı — içerikten türetilmez (claim'in özeti bile yazılmaz).
const sigOf = (st: fs.Stats) => `${st.size}:${Math.floor(st.mtimeMs)}`;
const lexists = (f: string) => { try { fs.lstatSync(f); return true; } catch { return false; } };
export function probeZtpFile(file = ZTP_FILE): Probe {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e: any) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { kind: 'none' } : { kind: 'unreadable' }; }
  const sig = sigOf(st);
  if (st.isSymbolicLink()) return { kind: 'bad', why: 'dosya sembolik bağ (izlenmez)', sig };
  if (!st.isFile()) return { kind: 'bad', why: 'normal dosya değil', sig };
  // Birden çok sabit bağ (FAT'ta olmaz): aynı içerik başka bir adda da duruyor — okunmaz; silerken yalnız bu ad kaldırılır
  if (st.nlink > 1) return { kind: 'bad', why: 'dosyanın birden çok sabit bağı var', sig };
  if (st.size > ZTP_MAX_BYTES) return { kind: 'bad', why: `dosya ${ZTP_MAX_BYTES} bayttan (4 KiB) büyük`, sig };
  let fd: number;
  // O_NOFOLLOW + fstat: lstat ile açma arasında dosya bağa / başka türe çevrilse de izlenmez
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW); } catch (e: any) {
    return e?.code === 'ELOOP' ? { kind: 'bad', why: 'dosya sembolik bağ (izlenmez)', sig } : { kind: 'unreadable' };
  }
  const buf = Buffer.alloc(ZTP_MAX_BYTES + 1);
  try {
    const st2 = fs.fstatSync(fd);
    if (!st2.isFile()) return { kind: 'bad', why: 'normal dosya değil', sig };
    if (st2.nlink > 1) return { kind: 'bad', why: 'dosyanın birden çok sabit bağı var', sig };
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > ZTP_MAX_BYTES) return { kind: 'bad', why: `dosya ${ZTP_MAX_BYTES} bayttan (4 KiB) büyük`, sig };
    return { kind: 'ok', text: buf.subarray(0, n).toString('utf8'), sig: sigOf(st2) };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    buf.fill(0);
    fs.closeSync(fd);
  }
}
// Üzerine sıfır yazar (en çok 1 MiB) ve siler. Döner: yol artık boş mu. Sembolik bağsa yalnız bağın kendisi silinir (hedefe
// dokunulmaz); birden çok sabit bağı varsa üzerine yazılmaz (başka addaki içerik bozulmasın), yalnız bu ad silinir; normal dosya
// değilse (klasör vb.) dokunulmaz.
export function scrubZtpFile(file = ZTP_FILE): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e: any) { return e?.code === 'ENOENT'; }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(file); } catch { /* */ }
    return !lexists(file);
  }
  if (!st.isFile()) return false;
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | NOFOLLOW);
    try {
      const st2 = fs.fstatSync(fd);
      const n = st2.isFile() && st.nlink <= 1 && st2.nlink <= 1 ? Math.min(st2.size, 1 << 20) : 0;
      const zero = Buffer.alloc(Math.max(1, Math.min(n, 65536)));
      for (let off = 0; off < n; off += zero.length) fs.writeSync(fd, zero, 0, Math.min(zero.length, n - off), off);
      if (n) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* yazılamadı (ör. salt okunur): yine de silinmeye çalışılır */ }
  try { fs.unlinkSync(file); } catch { /* */ }
  const gone = !lexists(file);
  if (gone) {
    try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* */ }
  }
  return gone;
}

// ─── Sonuç işareti /etc/pi5-gateway/fleet/ztp.done (claim YOK) ───
// result 'superseded': cihaz başka yolla (panel anahtarı / kayıt kodu) kayıtlıyken duran dosya — kullanılmadan silindi.
type DoneResult = 'enrolled' | 'rejected' | 'superseded';
const DONE_RESULTS: readonly string[] = ['enrolled', 'rejected', 'superseded'];
interface Done { v: 1; result: DoneResult; at: number; host: string; reason: string; file_removed: boolean; file_sig: string }
function readDone(): Done | null {
  try {
    const d = JSON.parse(fs.readFileSync(DONE_FILE, 'utf8'));
    return d && typeof d === 'object' && DONE_RESULTS.includes(d.result) ? d as Done : null;
  } catch {
    return null;
  }
}
// Silinemeyen dosyanın imzası sıfırlamadan SONRAKİ hâlinden alınır (sıfır yazmak değişiklik zamanını değiştirir)
const sigNow = (fallback: string) => { try { return sigOf(fs.lstatSync(ZTP_FILE)); } catch { return fallback; } };
function writeDone(d: Done): void {
  fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(FLEET_DIR, 0o700); } catch { /* geliştirme ortamı */ }
  const tmp = `${DONE_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, DONE_FILE);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Kesin ret: kodlu 4xx (protokol § 8 hata gövdesi). 401 (imza / saat), 408, 425, 426 (cihazı güncelleyin), 429 ve kodsuz 4xx
// (araya giren WAF / vekil sunucu sayfası) geçicidir. Sunucu hata kodu olarak claim'i yankıladıysa kod maskelenmiştir (••••):
// yine kodlu ret sayılır.
const TRANSIENT_4XX = new Set([401, 408, 425, 426, 429]);
export const definitiveReject = (status: number, code: string): boolean =>
  status >= 400 && status < 500 && !TRANSIENT_4XX.has(status) && (CODE_RE.test(code) || code.includes('••••'));

// ─── (1) Dosya tetiği ───
type FilePhase = 'running' | 'retry' | 'clock' | 'standby' | 'busy';
let fileRun: { phase: FilePhase; host: string; failures: number; nextAt: number; lastError: string; waitS: number } | null = null;
let fileTimer: NodeJS.Timeout | null = null;
let fileBusy = false;
let fileNoted = false;   // geçici hata olayı açılış başına bir kez
const retryWait = (n: number) => Math.min(RETRY_MAX_S, Math.max(1, Math.round(RETRY_BASE_S * 2 ** Math.min(n - 1, 12) * (0.9 + 0.2 * Math.random()))));
// Saat beklenirken: ardışık beklemede aralık ikiye katlanır (30 sn → en çok 5 dk); saat eşitlenince ilk denemede istek gider.
const clockWait = () => (fileRun?.phase === 'clock' ? Math.min(CLOCK_MAX_S, Math.max(RETRY_BASE_S, fileRun.waitS * 2)) : RETRY_BASE_S);

function stopFile(): void {
  if (fileTimer) clearTimeout(fileTimer);
  fileTimer = null;
  fileRun = null;
}
function retryFile(phase: FilePhase, waitS: number, host: string, lastError = '', failures = fileRun?.failures || 0): void {
  if (fileTimer) clearTimeout(fileTimer);
  fileRun = { phase, host, failures, nextAt: nowS() + waitS, lastError, waitS };
  fileTimer = setTimeout(() => {
    fileTimer = null;
    void fileAttempt().catch((e: any) => console.error('[ztp]', clean(e?.message || e)));
  }, waitS * 1000);
}

// Açılışta (index.ts '!isSatellite' bloğu, ensure'lardan sonra). Dosya yoksa hemen döner. Cihaz kayıtlıysa dosya kullanılmaz:
// kayıt / ağ isteği olmadan kesin sonuç (supersedeFile).
export async function ztpCheck(): Promise<void> {
  if (isSatellite() || !lexists(ZTP_FILE)) return;
  if (fleetEnrolled()) { await supersedeFile(); return; }
  await fileAttempt();
}

// Daha önce kesin sonuçlanıp silinemeyen dosya (ztp.done'daki imza aynı) ya da içeriği zaten sıfırlanmış dosya: yeniden
// işlenmez (olay yinelenmez), yalnız silme yeniden denenir. Döner: bu durumdaydı mı.
async function retryLeftover(p: Probe): Promise<boolean> {
  if (p.kind !== 'ok' && p.kind !== 'bad') return false;
  const done = readDone();
  const pending = !!done && !done.file_removed;
  if (!(pending && done?.file_sig === p.sig) && !(p.kind === 'ok' && /^\0+$/.test(p.text))) return false;
  stopFile();
  const removed = scrubZtpFile();
  if (done && pending) {
    try {
      writeDone({ ...done, file_removed: removed, file_sig: removed ? done.file_sig : sigNow(done.file_sig) });
    } catch (e: any) {
      console.error('[ztp] ztp.done yazılamadı:', clean(e?.message || e));
    }
    if (removed) await recordEvent('fleet', 'Filo (ZTP): daha önce silinemeyen ZTP dosyasının üzerine sıfır yazıldı ve dosya silindi');
  }
  return true;
}

// Cihaz başka yolla (panel anahtarı / kayıt kodu) kayıtlıyken SD karttaki ZTP dosyası artık kullanılamaz (ZTP yalnız kayıtsız
// cihazda çalışır): kesin sonuç — üzerine sıfır yazılıp silinir, ztp.done 'superseded', 'fleet' olayı. Kayıt denenmez, ağ
// isteği yok. Kartta kalsaydı «Filodan ayrıl» + yeniden başlatma onunla sessizce yeniden kayda (belki başka kiracıya) yol açardı.
async function supersedeFile(): Promise<void> {
  stopFile();
  const p = probeZtpFile();
  if (p.kind === 'none' || p.kind === 'unreadable') return;
  if (await retryLeftover(p)) return;
  let host = '';
  if (p.kind === 'ok') {
    const c = parseZtpConfig(p.text);
    if ('cfg' in c) host = c.cfg.host;
  }
  await finishFile('superseded', host, 'cihaz başka bir yolla (panel anahtarı / kayıt kodu) kaydoldu — dosya kullanılmadı', p.sig);
}
// Panelden ya da kodla kayıt tamamlanınca duran / yeniden denenmeyi bekleyen ZTP dosyası geçersiz sayılır (ZTP dosyasıyla
// kayıtta sonucu finishFile yazar). Dosya yoksa yalnız varlığına bakılır.
onFleetEnrolled(source => {
  if (source === 'ztp-file' || isSatellite()) return;
  void supersedeFile().catch((e: any) => console.error('[ztp]', clean(e?.message || e)));
});

async function fileAttempt(): Promise<void> {
  if (fileBusy) return;
  fileBusy = true;
  try {
    if (isSatellite()) { stopFile(); return; }
    if (fleetEnrolled()) { await supersedeFile(); return; }   // bu arada panelden / kodla kaydolundu
    const p = probeZtpFile();
    if (p.kind === 'none') { stopFile(); return; }
    if (p.kind === 'unreadable') { retryFile('retry', retryWait((fileRun?.failures || 0) + 1), '', 'dosya okunamadı (G/Ç)', (fileRun?.failures || 0) + 1); return; }
    if (await retryLeftover(p)) return;
    if (p.kind === 'bad') { await finishFile('rejected', '', `geçersiz dosya — ${p.why}`, p.sig); return; }
    const parsed = parseZtpConfig(p.text);
    if ('error' in parsed) { await finishFile('rejected', '', `geçersiz dosya — ${parsed.error}`, p.sig); return; }
    const cfg = parsed.cfg;
    if (!fleetMayRun()) { retryFile('standby', 60, cfg.host); return; }   // HA: etkin düğüm değil
    if (!(await clockSynced())) { retryFile('clock', clockWait(), cfg.host); return; }
    if (fleetEnrollBusy() || claim || claimStarting || adopting) { retryFile('busy', RETRY_BASE_S, cfg.host); return; }   // başka kayıt sürüyor
    fileRun = { phase: 'running', host: cfg.host, failures: fileRun?.failures || 0, nextAt: 0, lastError: fileRun?.lastError || '', waitS: 0 };
    try {
      await enrollFleet({ server: cfg.base, enroll_key: cfg.claim, site: cfg.site, allow_private: false }, 'ztp-file');
      await finishFile('enrolled', cfg.host, '', p.sig);
    } catch (e: any) {
      const kind = String(e?.kind || '');
      const code = clean(e?.code, 40);
      if (kind === 'enrolled') { await supersedeFile(); return; }   // bu arada başka yolla kaydolundu
      if (kind === 'clock') { retryFile('clock', clockWait(), cfg.host); return; }
      if (kind === 'busy') { retryFile('busy', RETRY_BASE_S, cfg.host); return; }
      if (kind === 'http' && definitiveReject(Number(e.httpStatus), code)) {
        await finishFile('rejected', cfg.host, `sunucu reddetti — HTTP ${Number(e.httpStatus)} (${safeCode(code, cfg.claim)})`, p.sig);
        return;
      }
      if (!kind && Number(e?.status) === 400) {   // enrollFleet'in girdi denetimi (şema denetiminden kaçan): kesin
        await finishFile('rejected', cfg.host, `geçersiz dosya — ${safeText(e, cfg.claim).slice(0, 200)}`, p.sig);
        return;
      }
      // Kalan her şey geçicidir: ağ / TLS, 5xx, kodsuz ya da geçici 4xx, geçersiz kayıt yanıtı, beklenmeyen yerel hata (anahtar
      // sunucuda kullanıldıysa sonraki deneme kodlu 409 enroll_key_used ile kesin sonuçlanır).
      const n = (fileRun?.failures || 0) + 1;
      const err = safeText(e, cfg.claim);
      const wait = retryWait(n);
      retryFile('retry', wait, cfg.host, err, n);
      if (!fileNoted) {
        fileNoted = true;
        await recordEvent('fleet', `Filo (ZTP): SD karttaki ZTP dosyasıyla kayıt şimdilik yapılamadı (${cfg.host}: ${err}) — dosya yerinde kalıyor, yeniden denenecek (aralık en çok 30 dk)`, 'warning');
      }
    }
  } finally {
    fileBusy = false;
  }
}

async function finishFile(result: DoneResult, host: string, reason: string, sig: string): Promise<void> {
  stopFile();
  const removed = scrubZtpFile();
  try {
    writeDone({ v: 1, result, at: nowS(), host, reason, file_removed: removed, file_sig: removed ? sig : sigNow(sig) });
  } catch (e: any) {
    console.error('[ztp] ztp.done yazılamadı:', clean(e?.message || e));
  }
  const manual = 'kartı bir bilgisayara takıp klyrix-ztp.json dosyasını elle silin';
  if (result === 'enrolled') {
    await recordEvent('fleet', removed
      ? 'Filo (ZTP): SD karttaki ZTP dosyasıyla kaydolundu — dosyanın üzerine sıfır yazıldı ve dosya silindi'
      : `Filo (ZTP): SD karttaki ZTP dosyasıyla kaydolundu, ancak dosya SİLİNEMEDİ — ${manual} (kayıt anahtarı kullanıldığı için artık geçersiz)`, removed ? 'info' : 'warning');
  } else if (result === 'superseded') {
    const at = host ? ` (${host})` : '';
    await recordEvent('fleet', removed
      ? `Filo (ZTP): SD karttaki ZTP dosyası${at} kullanılmadı — cihaz başka bir yolla (panel anahtarı / kayıt kodu) kayıtlı; dosyanın üzerine sıfır yazıldı ve dosya silindi`
      : `Filo (ZTP): SD karttaki ZTP dosyası${at} kullanılmadı (cihaz başka bir yolla kayıtlı), ancak dosya SİLİNEMEDİ — ${manual}. İçindeki kayıt anahtarı kullanılmadı: gerekmiyorsa denetleyicide iptal edin`,
    removed ? 'info' : 'warning');
  } else {
    await recordEvent('fleet', `Filo (ZTP): SD karttaki ZTP dosyası reddedildi — ${reason}. Kayıt yapılmadı, yeniden denenmez; ${removed
      ? 'dosyanın üzerine sıfır yazıldı ve dosya silindi'
      : `dosya silinemedi — ${manual}`}. Düzeltilmiş yeni bir dosyayla yeniden başlatın ya da Filo sayfasından kaydolun`.slice(0, 500), 'warning');
  }
}

// ─── (2) Kod tetiği ───
interface Claim {
  gen: number; base: string; host: string; allowPrivate: boolean; site: string; privatePem: string; pub: string; hw: string;
  code: string; startedAt: number; expiresAt: number; polls: number; lastPollAt: number; lastError: string;
}
let claim: Claim | null = null;
let claimGen = 0;
let claimStarting = false;
let adopting: Claim | null = null;   // konsola girildi, kayıt dosyaları yazılıyor: panel sonuç gelene dek kodu göstermeyi sürdürür
let claimTimer: NodeJS.Timeout | null = null;
let claimLast: { state: 'claimed' | 'expired' | 'cancelled' | 'failed'; at: number; host: string; detail: string; keyKept?: true } | null = null;

function scheduleClaim(c: Claim, waitS: number): void {
  if (claimTimer) clearTimeout(claimTimer);
  // Süre sonu kaçırılmasın: bir sonraki adım en geç kodun bittiği an
  const s = Math.max(1, Math.min(waitS, c.expiresAt - nowS()));
  claimTimer = setTimeout(() => {
    claimTimer = null;
    void claimTick(c).catch((e: any) => console.error('[ztp] kod:', clean(e?.message || e)));
  }, s * 1000);
}
// Bekleyen kod biter: anahtar (yalnız bellekte) bırakılır, zamanlayıcı durur.
async function endClaim(c: Claim, state: 'expired' | 'cancelled' | 'failed', detail: string): Promise<void> {
  if (claim !== c) return;
  claim = null;
  c.privatePem = '';
  if (claimTimer) clearTimeout(claimTimer);
  claimTimer = null;
  claimLast = { state, at: nowS(), host: c.host, detail };
  const what = state === 'expired' ? 'süresi doldu' : state === 'cancelled' ? 'iptal edildi' : 'başarısız';
  await recordEvent('fleet', `Filoya kodla kayıt ${what} (${c.host}): ${detail} — bekleyen cihaz anahtarı silindi`.slice(0, 500), state === 'failed' ? 'warning' : 'info');
}
async function adoptClaim(c: Claim, j: any): Promise<void> {
  if (claim === c) {
    claim = null;
    if (claimTimer) clearTimeout(claimTimer);
    claimTimer = null;
  }
  adopting = c;
  const pem = c.privatePem;
  c.privatePem = '';
  try {
    const r = await adoptEnrollment({ base: c.base, allowPrivate: c.allowPrivate, site: c.site, privatePem: pem, hw: c.hw, source: 'code' }, j);
    claimLast = { state: 'claimed', at: nowS(), host: c.host, detail: `kiracı «${r.tenant}»` };
  } catch (e: any) {
    const detail = clean(e?.message || e);
    // Bellekteki anahtar her durumda bırakıldı; diske yarım yazılan kayıt dosyaları adoptEnrollment'ta silinir (cleaned)
    const kept = e?.cleaned === false;
    claimLast = { state: 'failed', at: nowS(), host: c.host, detail, ...(kept ? { keyKept: true as const } : {}) };
    await recordEvent('fleet', `Filoya kodla kayıt tamamlanamadı (${c.host}): ${detail} — ${kept
      ? 'yarım yazılan kayıt dosyaları silinemedi (/etc/pi5-gateway/fleet; sonraki kayıt üzerlerine yazar)'
      : 'bekleyen cihaz anahtarı silindi'}`, 'warning');
  } finally {
    adopting = null;
  }
}
async function claimTick(c: Claim): Promise<void> {
  if (claim !== c) return;
  if (nowS() >= c.expiresAt) { await endClaim(c, 'expired', `${Math.round(CLAIM_TTL_S / 60)} dk içinde denetleyicinin konsoluna girilmedi`); return; }
  if (fleetEnrolled()) { await endClaim(c, 'cancelled', 'cihaz bu arada başka bir yolla kaydoldu'); return; }
  if (!fleetMayRun()) { c.lastError = 'Bu cihaz şu an filo için etkin değil (HA yedek düğüm)'; scheduleClaim(c, CLAIM_POLL_S); return; }
  if (!(await clockSynced())) { c.lastError = "Pi'nin saati eşitlenmedi — imzalı istek gönderilmedi"; scheduleClaim(c, CLAIM_POLL_S); return; }
  if (claim !== c) return;
  const r: HttpResult = await claimStatusRequest(c).catch((e: any) => ({ status: 0, json: null, retryAfterS: 0, error: clean(e?.message || e) }));
  if (claim !== c) return;   // bu arada iptal edildi / süresi doldu: yanıt atılır
  c.polls++;
  c.lastPollAt = nowS();
  if (r.error) {
    const code = clean(r.json?.error?.code, 40);
    if (definitiveReject(r.status, code)) { await endClaim(c, 'failed', `sunucu kodu reddetti — HTTP ${r.status} (${code})`); return; }
    c.lastError = r.error;
    const ra = (r.status === 429 || r.status === 503) && r.retryAfterS > 0 ? Math.min(Math.max(r.retryAfterS, CLAIM_POLL_S), 60) : CLAIM_POLL_S;
    scheduleClaim(c, ra);
    return;
  }
  if (r.json.status === 'claimed') { await adoptClaim(c, r.json); return; }
  c.lastError = r.json.status === 'pending' ? '' : 'Sunucu yanıtı geçersiz (status: pending / claimed bekleniyordu)';
  scheduleClaim(c, CLAIM_POLL_S);
}

export async function startClaim(body: { server?: unknown; allow_private?: unknown; site?: unknown }): Promise<void> {
  if (isSatellite()) throw httpError('Bu cihaz uydu — filo bağlantısı ana cihazdadır', 409);
  if (fleetEnrolled()) throw httpError('Cihaz zaten bir filoya kayıtlı — önce "Filodan ayrıl"', 409);
  if (claim || claimStarting || adopting) throw httpError('Bekleyen bir kayıt kodu var — önce onu iptal edin', 409);
  if (fleetEnrollBusy()) throw httpError('Kayıt sürüyor — birazdan yeniden deneyin', 409);
  if (!fleetMayRun()) throw httpError('Bu cihaz şu an filo için etkin değil (HA yedek düğüm)', 409);
  const b = checkBaseUrl(body.server);
  if ('error' in b) throw httpError(b.error, 400);
  if (body.allow_private !== undefined && typeof body.allow_private !== 'boolean') throw httpError("'allow_private' true ya da false olmalı", 400);
  const site = typeof body.site === 'string' ? body.site.trim() : '';
  if ([...site].length > 40 || /[\x00-\x1f\x7f<>]/.test(site)) throw httpError('Konum etiketi en çok 40 karakter olmalı (< > olmadan)', 400);
  claimStarting = true;
  try {
    if (!(await clockSynced())) throw httpError("Pi'nin saati henüz internetle eşitlenmedi (RTC yok) — imzalı istek gönderilmez; birkaç dakika sonra yeniden deneyin", 409);
    const pair = generateDeviceKey();
    const t = nowS();
    const c: Claim = {
      gen: ++claimGen, base: b.base, host: new URL(b.base).host, allowPrivate: body.allow_private === true, site,
      privatePem: pair.privatePem, pub: pair.publicRaw, hw: hwTag(), code: claimCode(pair.publicRaw),
      startedAt: t, expiresAt: t + CLAIM_TTL_S, polls: 1, lastPollAt: t, lastError: '',
    };
    // İlk istek cihazı sunucuda tanıtır (kod ancak bundan sonra konsolda bulunur) ve adresi hemen sınar: başarısızsa kod gösterilmez
    const r = await claimStatusRequest(c);
    if (fleetEnrolled()) throw httpError('Cihaz bu arada başka bir yolla filoya kaydoldu', 409);
    if (r.error) throw httpError(`Kodla kayıt başlatılamadı: ${r.error}`, r.status >= 400 && r.status < 500 ? 400 : 502);
    if (r.json.status === 'claimed') { await adoptClaim(c, r.json); return; }
    if (r.json.status !== 'pending') throw httpError('Sunucunun yanıtı geçersiz (status: pending / claimed bekleniyordu) — sunucu kodla kaydı desteklemiyor olabilir', 502);
    claim = c;
    claimLast = null;
    await recordEvent('fleet', `Filoya kodla kayıt başladı: ${c.host} — kod ${Math.round(CLAIM_TTL_S / 60)} dk geçerli, denetleyicinin konsoluna girilince cihaz kaydolur`);
    if (claim === c) scheduleClaim(c, CLAIM_POLL_S);
  } finally {
    claimStarting = false;
  }
}
export async function cancelClaim(): Promise<void> {
  if (!claim) throw httpError('Bekleyen kayıt kodu yok', 409);
  await endClaim(claim, 'cancelled', 'panelden iptal edildi');
}

// ─── Durum (panel) — claim değeri hiçbir zaman yok ───
export function ztpStatus(): Record<string, unknown> {
  if (claim && nowS() >= claim.expiresAt) void endClaim(claim, 'expired', `${Math.round(CLAIM_TTL_S / 60)} dk içinde denetleyicinin konsoluna girilmedi`);
  // «Bağlandı» yalnız kayıt sürdükçe: «Filodan ayrıl»dan sonra eski kodla kayıt sonucu gösterilmez
  if (claimLast?.state === 'claimed' && !fleetEnrolled()) claimLast = null;
  const d = readDone();
  const c = claim || adopting;   // kayıt dosyaları yazılırken kod kartı sonuç gelene dek kalır (sonuçsuz kaybolmuş görünmez)
  return {
    file: fileRun ? { phase: fileRun.phase, host: fileRun.host || null, failures: fileRun.failures, nextAt: fileRun.nextAt || null, lastError: fileRun.lastError || null } : null,
    done: d ? { result: d.result, at: d.at, host: d.host || null, reason: d.reason || null, fileRemoved: d.file_removed === true } : null,
    claim: c ? {
      code: c.code, fingerprint: fingerprint(c.pub), host: c.host, startedAt: c.startedAt, expiresAt: c.expiresAt,
      polls: c.polls, lastPollAt: c.lastPollAt, lastError: c.lastError || null,
    } : null,
    // now: Pi'nin saati — panel geri sayımı tarayıcı saatine göre değil buna göre hesaplar (tarayıcı saati kayık olabilir)
    claimLast, ttlS: CLAIM_TTL_S, pollS: CLAIM_POLL_S, now: nowS(),
  };
}

// ─── Uçlar: /api/fleet önekinde. G4.1'in ara katmanı (registerFleetRoutes: GET dışı yazma sınırı + netAdminGuard, uyduda 409)
// bu uçlardan ÖNCE kayıtlıdır — index.ts registerZtpRoutes'u registerFleetRoutes'tan sonra çağırır. ───
export function registerZtpRoutes(app: express.Express): void {
  const fail = (res: express.Response, e: any) => res.status(Number(e?.status) || 500).json({ error: String(e?.message || e) });
  app.get('/api/fleet/ztp', (_req, res) => {
    try { res.json(ztpStatus()); } catch (e: any) { fail(res, e); }
  });
  app.post('/api/fleet/claim', async (req, res) => {
    try {
      await startClaim(req.body || {});
      res.json({ success: true, ...ztpStatus() });
    } catch (e: any) { fail(res, e); }
  });
  app.delete('/api/fleet/claim', async (_req, res) => {
    try {
      await cancelClaim();
      res.json({ success: true, ...ztpStatus() });
    } catch (e: any) { fail(res, e); }
  });
  app.delete('/api/fleet/suggestion', (_req, res) => {
    if (!clearNetSuggestion()) return res.status(404).json({ error: 'Gösterilen ağ önerisi yok' });
    res.json({ success: true });
  });
}

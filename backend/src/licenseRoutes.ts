// Lisans uçları ve süre denetimi (G3.2; çekirdek license.ts — orası saf kalsın diye saat eşitliği, seri, olay ve rol burada).
//  - GET /api/license: durum (Topluluk / plan / bitiş / cihaz kodu). Token maskeli döner; ham seri hiçbir zaman.
//  - PUT /api/license {token}: imza, şema, cihaz kodu ve süre doğrulanır; yalnız geçerliyse /etc/pi5-gateway/license'a
//    (0600, atomik) yazılır. Geçersizse 400 ve dosya değişmez.
//  - DELETE /api/license: token silinir → Topluluk. Yüksek su işareti (license.seen) kalır (geri alınmış saate karşı).
//  - GET dışı: writeLimiter + netAdminGuard; uyduda PUT/DELETE 409 (uydu yalnız bilgi gösterir). Aktivasyon çevrimdışıdır:
//    panel cihaz kodunu gösterir, kullanıcı aldığı token'ı yapıştırır. Çevrimiçi yenileme yok.
//  - Süre denetimi: yalnız token varken (açılışta varsa, PUT'tan sonra) günde bir; bitime 14 ve 3 gün kala, ek sürede ve
//    bitince bir kez olay (kaynak 'license'). Lisans bitince çalışan hiçbir şey kesilmez.
import type express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  COMMUNITY, FEATURE_PLAN, MAX_TOKEN_LEN, WARN_DAYS, evaluate, verifyToken, deviceCodeFor, readSeen, bumpSeen, writeToken,
  removeToken, hasToken, licenseStatus, setCurrentLicense, entitled, type InvalidReason, type LicenseStatus,
} from './license';
import { hwSerial } from './mesh';
import { recordEvent, recordEventOnce } from './events';
import { isSatellite } from './role';
import { isLinux } from './system';

const execFileP = promisify(execFile);
type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;
const DAY_S = 86400;
const nowS = () => Math.floor(Date.now() / 1000);
const ymd = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

// Saat eşitliği — lisans için SIKI: yalnız timedatectl açıkça 'yes' derse eşitli; hata / zaman aşımı / başka çıktı → eşitli
// değil. (vault.ts clockSynced bulut yedeği için hatada 'eşitli' sayar; burada eşitli sanılan yanlış saat gerçek saat
// yerine geçer ve yüksek su işaretini yazar.) Eşitli değilken değerlendirme max(şimdi, son görülen) ile yapılır.
async function licenseClockSynced(): Promise<boolean> {
  if (new Date().getFullYear() < 2025) return false;
  try {
    const { stdout } = await execFileP('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 });
    return stdout.trim() === 'yes';
  } catch {
    return false;
  }
}

export const REASON_TEXT: Record<InvalidReason, string> = {
  format: 'Lisans anahtarı biçimi tanınmadı (KLX1. ile başlamalı; eksiksiz yapıştırın)',
  schema: 'Lisans anahtarının içeriği geçersiz',
  kid: 'Lisans anahtarı bu panel sürümünün tanımadığı bir imza anahtarıyla üretilmiş (paneli güncelleyin)',
  signature: 'Lisans anahtarının imzası doğrulanamadı (değiştirilmiş ya da eksik yapıştırılmış)',
  'not-yet': 'Lisans henüz başlamadı — cihazın saatini denetleyin',
};
const allCommunity = () => Object.values(FEATURE_PLAN).every(p => p === COMMUNITY);

async function statusNow() {
  // Token yokken saat eşitliği sorulmaz (alt süreç yok) ve hiçbir dosya yazılmaz.
  const synced = hasToken() ? await licenseClockSynced() : null;
  const s = licenseStatus({ now: nowS(), synced: synced === true, serial: hwSerial() });
  setCurrentLicense(s);
  return { ...s, clockSynced: synced };
}

// ─── Süre denetimi ───
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
export function licenseNotice(s: LicenseStatus): { msg: string; severity: 'warning' } | null {
  const tag = `Lisans ${s.lid || ''} (${s.licensedPlan || ''})`;
  if (s.state === 'active' && s.exp !== null) {
    const left = (s.exp - s.now) / DAY_S;
    const d = [...WARN_DAYS].sort((a, b) => a - b).find(n => left <= n);
    if (d === undefined) return null;
    return { msg: `${tag} ${ymd(s.exp)} tarihinde bitiyor (${d} günden az kaldı) — yenilemek için yeni anahtarı Altyapı → Lisans'a yapıştırın`, severity: 'warning' };
  }
  if (s.state === 'grace' && s.graceUntil !== null) {
    return { msg: `${tag} süresi doldu; ek süre ${ymd(s.graceUntil)} tarihinde bitiyor — çalışan hiçbir şey kesilmez`, severity: 'warning' };
  }
  if (s.state === 'expired') return { msg: `${tag} süresi bitti — Topluluk sürümüne dönüldü; çalışan hiçbir şey kesilmedi`, severity: 'warning' };
  if (s.state === 'other-device') return { msg: `${tag} bu cihaza ait değil (cihaz kodu farklı) — Topluluk sürümü geçerli`, severity: 'warning' };
  if (s.state === 'unverified') return { msg: `${tag} cihaza bağlı ama bu cihazın kodu okunamadı — Topluluk sürümü geçerli`, severity: 'warning' };
  if (s.state === 'invalid') return { msg: `Kayıtlı lisans anahtarı geçersiz — Topluluk sürümü geçerli`, severity: 'warning' };
  return null;
}
async function checkExpiry(): Promise<void> {
  try {
    if (!hasToken()) { stopLicenseWatch(); return; }
    const n = licenseNotice(await statusNow());
    if (n) await recordEventOnce('license', n.msg, n.severity, 0);
  } catch (e: any) {
    console.error('[lisans] süre denetimi:', e?.message || e);
  }
}
function startWatch(delayMs: number): void {
  if (timer) return;
  firstRun = setTimeout(() => { firstRun = null; void checkExpiry(); }, delayMs);
  timer = setInterval(() => { void checkExpiry(); }, DAY_S * 1000);
}
function stopLicenseWatch(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
// Açılış ('!isSatellite' bloğu): yalnız token varsa denetim kurulur; yoksa hiçbir şey yapılmaz.
export function startLicense(): void {
  if (isLinux && hasToken()) startWatch(60_000);
}

export function registerLicenseRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw }): void {
  app.use('/api/license', (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && isSatellite()) {
      return res.status(409).json({ error: 'Bu cihaz uydu — lisans ana cihazda yönetilir' });
    }
    deps.guard(req, res, next);
  });

  app.get('/api/license', async (_req, res) => {
    try {
      res.json({ ...(await statusNow()), supported: isLinux, satellite: isSatellite(), allCommunity: allCommunity(), warnDays: WARN_DAYS });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/license', async (req, res) => {
    if (!isLinux) return res.status(400).json({ error: 'Lisans yalnız Pi üzerinde etkinleştirilir' });
    const raw = req.body?.token;
    const token = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
    if (!token || token.length > MAX_TOKEN_LEN) return res.status(400).json({ error: REASON_TEXT.format });
    try {
      const v = verifyToken(token);
      if (!v.ok) return res.status(400).json({ error: REASON_TEXT[v.reason], reason: v.reason });
      const synced = await licenseClockSynced();
      const now = nowS();
      const s = evaluate(v, { now, seen: readSeen(), deviceCode: deviceCodeFor(hwSerial()), synced });
      if (s.state === 'other-device') return res.status(400).json({ error: 'Bu lisans başka bir cihaz için üretilmiş (cihaz kodu farklı)', state: s.state });
      if (s.state === 'unverified') {
        return res.status(400).json({ error: 'Bu cihazın kodu okunamadı — cihaza bağlı lisans burada doğrulanamıyor', state: s.state });
      }
      if (s.state === 'invalid') return res.status(400).json({ error: REASON_TEXT[s.reason || 'format'], reason: s.reason });
      if (s.state === 'expired') {
        // Eşitsiz saatte son görülen zamana göre bitmiş görünüyorsa bunu söyle: saat eşitlenince yeniden denenebilir.
        const clock = !synced && s.now > now ? ' (cihazın saati eşitli değil — son görülen zamana göre değerlendirildi; saat eşitlenince yeniden deneyin)' : '';
        return res.status(400).json({ error: `Bu lisansın süresi ${ymd(s.graceUntil ?? 0)} tarihinde bitmiş${clock}`, state: s.state });
      }
      writeToken(token);
      bumpSeen(now, synced);
      const st = await statusNow();
      if (!entitled(st)) {
        // Yazılan token değerlendirmede geçmedi (ör. saat yarışta değişti): eski duruma dönülmez, durum yanıtta görünür.
        console.error('[lisans] yazılan token geçerli görünmüyor:', st.state);
      }
      await recordEvent('license', `Lisans etkinleştirildi: ${st.licensedPlan} (${st.lid}), bitiş ${ymd(st.exp ?? 0)}${st.bound ? ', bu cihaza bağlı' : ''}`);
      startWatch(60_000);
      res.json({ ...st, supported: isLinux, satellite: false, allCommunity: allCommunity(), warnDays: WARN_DAYS });
    } catch (e: any) {
      res.status(500).json({ error: `Lisans kaydedilemedi: ${e?.message || e}` });
    }
  });

  app.delete('/api/license', async (_req, res) => {
    try {
      const had = hasToken();
      removeToken();
      stopLicenseWatch();
      const st = await statusNow();
      if (had) await recordEvent('license', 'Lisans kaldırıldı — Topluluk sürümüne dönüldü');
      res.json({ ...st, supported: isLinux, satellite: false, allCommunity: allCommunity(), warnDays: WARN_DAYS });
    } catch (e: any) {
      res.status(500).json({ error: `Lisans kaldırılamadı: ${e?.message || e}` });
    }
  });
}

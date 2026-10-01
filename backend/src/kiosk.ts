// HDMI ekranı (kiosk) servisini aç / kapat. pi5-kiosk.service → xinit → openbox → scripts/kiosk.sh → Chromium
// (klyrix-kiosk kullanıcısı). "Açıldı" ancak Chromium gerçekten çalışıyorsa denir: eskiden `systemctl start` başarılı
// olduğu an (X ve openbox açılır açılmaz) "etkinleştirildi" deniyordu, Chromium hiç açılmasa da.
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readPlatform, type KioskSupport } from './hardware';

const execFileP = promisify(execFile);
const UNIT = 'pi5-kiosk.service';
const UNIT_FILE = '/etc/systemd/system/pi5-kiosk.service';
const KIOSK_USER = 'klyrix-kiosk';
const START_WAIT_MS = 30000;   // ExecStartPre 5 sn + X + openbox + Chromium'un ilk açılışı (Pi 5'te ~10 sn)

export interface KioskApply { applied: boolean; message?: string; error?: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function ok(cmd: string, args: string[], timeout = 5000): Promise<boolean> {
  try { await execFileP(cmd, args, { timeout }); return true; } catch { return false; }
}
const has = (bin: string) => ok('sh', ['-c', `command -v ${bin}`]);

// Chromium'un kiosk kullanıcısıyla çalışan ana süreci
export const chromiumRunning = () => ok('pgrep', ['-u', KIOSK_USER, '-f', '--', '--kiosk']);

async function unitActive(): Promise<boolean> {
  try {
    const { stdout } = await execFileP('systemctl', ['is-active', UNIT], { timeout: 5000 });
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

// Kiosk betiğinin günlükteki son satırları ("[kiosk] ..."): açılmadığında nedeni göstermek için
async function lastKioskLog(): Promise<string> {
  try {
    const { stdout } = await execFileP('journalctl', ['-u', UNIT, '-n', '60', '--no-pager', '-o', 'cat'], { timeout: 5000 });
    const lines = stdout.split('\n').filter(l => /\[kiosk\]|rror|cannot open display/i.test(l));
    return lines.slice(-2).join(' · ').replace(/\[kiosk\]\s*/g, '').slice(0, 300);
  } catch {
    return '';
  }
}

// Bu cihazda HDMI ekranı açılabilir mi (scripts/platform.sh: 512 MB sınıfında ya da elle seçilmiş Hafif profilde hayır,
// ekran çıkışı yoksa hayır, 1 GB sınıfında uyarı). forced: profil elle seçildi. active: ekran servisi şu an çalışıyor —
// açılamayan cihazda bu sürümden önce açılmış ekran panelde "açık" görünsün ve kapatılabilsin. Profil okunamazsa null:
// eski davranış (yalnız birim / paket denetimi).
export interface KioskSupportInfo { state: KioskSupport; memMiB: number; memClassMiB: number; forced: boolean; active: boolean }
export async function kioskSupport(): Promise<KioskSupportInfo | null> {
  const p = await readPlatform();
  return p ? { state: p.kiosk, memMiB: p.memMiB, memClassMiB: p.memClassMiB, forced: p.forced, active: await unitActive() } : null;
}

// Açmayı engelleyen neden (yoksa null). Elle seçilmiş Hafif profilde bellek suçlanmaz (8 GB'ta "en az 1 GB gerekir"
// kendisiyle çelişirdi). Metin arayüzde (KioskSettingsPanel) de aynıdır.
export function kioskBlockReason(s: Pick<KioskSupportInfo, 'state' | 'memMiB' | 'forced'> | null): string | null {
  if (s?.state === 'no') {
    return s.forced ? 'HDMI ekranı Hafif profilde kapalı (profil elle seçildi: /etc/pi5-gateway/profile)'
      : `HDMI ekranı bu cihazda açılamaz: ${s.memMiB} MB bellek (en az 1 GB gerekir)`;
  }
  if (s?.state === 'no-display') return 'Ekran çıkışı bulunamadı';
  return null;
}

async function preconditions(): Promise<string | null> {
  if (!fs.existsSync(UNIT_FILE)) return 'Kiosk servisi kurulu değil — paneli güncelleyin (Bakım → Güncelle)';
  if (!(await has('xinit')) || !(await has('openbox'))) return 'Ekran sunucusu kurulu değil: sudo apt install xserver-xorg xinit openbox x11-xserver-utils';
  if (!(await has('chromium')) && !(await has('chromium-browser'))) return 'Chromium kurulu değil: sudo apt install chromium';
  return null;
}

export async function applyKiosk(enabled: boolean): Promise<KioskApply> {
  if (!enabled) {
    await ok('systemctl', ['stop', UNIT], 15000);
    await ok('systemctl', ['disable', UNIT]);
    return { applied: true, message: 'Kiosk modu kapatıldı. HDMI çıkışı terminale dönecek.' };
  }
  const sup = await kioskSupport();
  const block = kioskBlockReason(sup);
  if (block) {
    // Açılamaz ama ekran bu sürümden önce açılmış ve çalışıyor: yalnız pano / tema kaydı (ekran 60 sn içinde alır);
    // etkinleştirme / yeniden başlatma yok. Kapatmak her zaman serbest (yukarıda).
    if (sup?.active && (await chromiumRunning())) {
      return { applied: true, message: 'Kiosk ayarları kaydedildi — ekran 60 sn içinde yeni ayarı alır. Kapatılırsa bu cihazda yeniden açılamaz.' };
    }
    return { applied: false, error: block };
  }
  const pre = await preconditions();
  if (pre) return { applied: false, error: pre };
  await ok('systemctl', ['enable', UNIT]);
  // Zaten açık ve Chromium çalışıyorsa (yalnız pano / tema ayarı kaydedildi) yeniden başlatılmaz
  if ((await unitActive()) && (await chromiumRunning())) {
    return { applied: true, message: 'Kiosk ayarları kaydedildi — ekran 60 sn içinde yeni ayarı alır.' };
  }
  if (!(await ok('systemctl', ['restart', UNIT], 15000))) {
    return { applied: false, error: `Kiosk servisi başlatılamadı. ${await lastKioskLog()}`.trim() };
  }
  for (let waited = 0; waited < START_WAIT_MS; waited += 1000) {
    await sleep(1000);
    if (await chromiumRunning()) return { applied: true, message: 'Kiosk modu açıldı. HDMI çıkışında gösterge paneli görünür.' };
    if (waited > 8000 && !(await unitActive())) break;   // servis düştü: beklemeye gerek yok
  }
  const why = await lastKioskLog();
  return { applied: false, error: `Kiosk açılamadı: ${why || 'Chromium başlamadı'} — ayrıntı: journalctl -u pi5-kiosk` };
}

// Sistem & Log → Cron: paneldeki görevler Pi'nin zamanlayıcısına gerçekten yazılır. Eskiden liste yalnız veritabanındaydı
// (açma/kapama ve saat değişikliği hiçbir şeyi etkilemiyordu); gerçek zamanlama install.sh'in yazdığı
// /etc/cron.d/pi5-maintenance'taydı.
//  - Etkin ve zamanlaması geçerli her görev /etc/cron.d/pi5-panel'e bir satır olarak yazılır; komut görev başına ayrı
//    betik dosyasındadır (core/cron-jobs/<id>.sh) ve scripts/cron-run.sh ile çalışır (çakışma kilidi, sonuç kaydı).
//  - Panelin kendi gece güncellemesi (pi5-maintenance) ve Pi-hole'un görevleri (/etc/cron.d/pihole) salt okunur gösterilir.
//  - Eski pi5-maintenance'taki apt ve log temizliği satırları panel görevlerine taşınmıştır: aynı iş iki kez çalışmasın diye
//    açılışta o dosyadan çıkarılır (03:30 panel güncellemesi yerinde kalır).
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { dbAll, dbRun } from './db';
import { isLinux } from './system';
import { recordEventOnce } from './events';

const CRON_FILE = '/etc/cron.d/pi5-panel';
const LEGACY_FILE = '/etc/cron.d/pi5-maintenance';
const PIHOLE_FILE = '/etc/cron.d/pihole';
const JOB_DIR = path.resolve(__dirname, '../../core/cron-jobs');
const RUNNER = path.resolve(__dirname, '../../scripts/cron-run.sh');
// Eski pi5-maintenance satırlarının panel karşılıkları (taşıma yalnız bu satırlar için yapılır).
const LEGACY_MOVED = [/apt update -qq && apt upgrade/, /journalctl --vacuum-time/];
const OLD_LOG_CMD = 'journalctl --vacuum-time=7d';
export const LOG_CLEANUP_CMD = 'journalctl --vacuum-time=7d && find /var/log -name "*.gz" -mtime +30 -delete';
// Gece gravity'si panelin liste indirme birimiyle (pi5-gravity — piholeLists.ts): panel o sırada liste indiriyorsa ikinci bir
// 'pihole -g' aynı veritabanına yazmaz (atlanır); --wait ile görevin sonucu gravity'nin gerçek sonucudur.
const OLD_GRAVITY_CMD = 'pihole -g';
export const GRAVITY_CMD = 'systemctl is-active --quiet pi5-gravity || systemd-run --quiet --collect --wait --unit=pi5-gravity pihole -g';

const FIELD_NAMES = ['dakika', 'saat', 'ayın günü', 'ay', 'haftanın günü'];
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MACROS = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually', '@midnight']);
// Debian cron (3.0pl1 entry.c get_number): sayı en çok 999 karakter (MAX_TEMPSTR); adım C atoi'siyle okunur — 64 bit long
// (Pi 5, arm64): 2^63−1'i aşan değer kırpılır, int'e çevrilince alt 32 bit kalır. Adım ≤ 0 çıkarsa ya da aralığın başına
// eklenince int taşarsa (get_range döngüsü "i += step") cron satırı reddeder.
const MAX_NUM_LEN = 999;
const INT_MAX = 2147483647;
const LONG_MAX = BigInt('9223372036854775807');
const cAtoi = (digits: string): number => {
  const v = BigInt(digits);
  return Number(BigInt.asIntN(32, v > LONG_MAX ? LONG_MAX : v));
};

// Hatalı bir satır cron'un bütün dosyayı yok saymasına yol açar (Debian user.c: "this crontab file will be ignored" — o
// dosyadaki hiçbir görev çalışmaz): yalnız Debian cron'un kabul ettiği sayısal biçim (ör. "*/10 * * * *") ve @daily gibi
// kısaltmalar kabul edilir. Hata metni döner, geçerliyse null.
//  - Adım yalnız '*' ya da aralığa verilir: "1/2" Debian'da "bad minute" (doğrusu "1-59/2" ya da "*/2").
//  - Alanlar boşluk / sekmeyle ayrılır: başka bir boşluk karakteri (kopyalanan metindeki bölünmez boşluk, satır sonu) cron'da
//    alanları kaydırır. Alanın SONUNDAKİ böyle bir karakteri cron atlar (satır sonu hariç) — eskisi gibi kabul edilir.
export function validateSchedule(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (MACROS.has(s)) return null;
  const fields = s.split(/[ \t]+/).map(f => f.replace(/[^\S\n]+$/, ''));
  if (fields.some(f => /\s/.test(f))) {
    return 'Zamanlamanın alanları yalnız boşlukla ayrılmalı — metinde bölünmez boşluk ya da satır sonu var (kopyalanmış olabilir), elle yeniden yazın';
  }
  if (fields.length !== 5) return 'Zamanlama 5 alandan oluşmalı: dakika saat gün ay haftanın_günü (ör. 0 3 * * *)';
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = RANGES[i];
    for (const part of fields[i].split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!m) return `Geçersiz ${FIELD_NAMES[i]} alanı: "${fields[i]}"`;
      if ([m[2], m[3], m[4]].some(v => v !== undefined && v.length > MAX_NUM_LEN)) return `${FIELD_NAMES[i]} alanında sayı çok uzun`;
      const nums = [m[2], m[3]].filter(v => v !== undefined).map(Number);
      if (nums.some(n => n < lo || n > hi)) return `${FIELD_NAMES[i]} ${lo}-${hi} arasında olmalı`;
      if (m[3] !== undefined && Number(m[3]) < Number(m[2])) return `${FIELD_NAMES[i]} aralığı ters: "${part}"`;
      if (m[4] !== undefined && Number(m[4]) < 1) return 'Adım (/n) en az 1 olmalı';
      if (m[4] !== undefined) {
        const step = cAtoi(m[4]);
        if (step < 1 || step > INT_MAX - (m[1] === '*' ? lo : Number(m[2]))) return `Adım çok büyük: "/${m[4]}" (cron bu değeri okuyamaz)`;
      }
      if (m[4] !== undefined && m[1] !== '*' && m[3] === undefined) {
        return `Adım yalnız * ya da aralığa verilebilir: ${FIELD_NAMES[i]} alanında "${part}" yerine "${m[2]}-${hi}/${m[4]}" ya da "*/${m[4]}" yazın`;
      }
    }
  }
  return null;
}

export function validateCommand(raw: unknown): string | null {
  const c = String(raw ?? '');
  if (!c.trim()) return 'Komut boş olamaz';
  if (/[\r\n\0]/.test(c)) return 'Komut tek satır olmalı';
  if (c.length > 2000) return 'Komut en fazla 2000 karakter olabilir';
  return null;
}

const oneLine = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120);

function writeAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Veritabanındaki görevleri zamanlayıcıya yazar. Yazılamazsa hata fırlatır (çağıran kullanıcıya bildirir). Zamanlaması
// geçersiz görev (eski sürümün kaydettiği "1/2", yedekten gelen satır) dosyaya YAZILMAZ — dosyanın geri kalanı çalışır —
// ve Bildirimler'e günde en çok bir kez (görev + zamanlama başına) uyarı düşer.
export async function syncCronJobs(): Promise<void> {
  if (!isLinux) return;
  const jobs = await dbAll('SELECT id, name, schedule, command, enabled FROM cron_jobs ORDER BY id') as any[];
  fs.mkdirSync(JOB_DIR, { recursive: true, mode: 0o700 });
  const keep = new Set<number>();
  const skipped: { id: number; name: string; schedule: string; error: string }[] = [];
  const lines = [
    '# Klyrix Gate — panelden yönetilen görevler (Sistem & Log → Cron). Elle düzenlemeyin: panel her değişiklikte yeniden yazar.',
    'SHELL=/bin/bash',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '',
  ];
  for (const j of jobs) {
    const id = Number(j.id);
    if (!Number.isInteger(id) || id <= 0 || validateCommand(j.command)) continue;
    keep.add(id);
    writeAtomic(path.join(JOB_DIR, `${id}.sh`), `# name: ${oneLine(j.name)}\n# Klyrix Gate cron görevi — panel yazar, elle düzenlemeyin\n${j.command}\n`, 0o700);
    if (!j.enabled) continue;
    const bad = validateSchedule(j.schedule);
    if (bad) {
      console.warn(`[cron] "${oneLine(j.name)}" zamanlaması geçersiz, zamanlayıcıya yazılmadı: ${j.schedule}`);
      skipped.push({ id, name: oneLine(j.name), schedule: oneLine(j.schedule).trim(), error: bad });
      continue;
    }
    lines.push(`# ${id}: ${oneLine(j.name)}`, `${String(j.schedule).trim()} root /bin/bash ${RUNNER} ${id}`);
  }
  // Silinmiş görevlerin betik / sonuç / kilit / çıktı dosyaları
  for (const f of fs.readdirSync(JOB_DIR)) {
    const m = /^(\d+)\.(sh|status|lock|out)$/.exec(f);
    if (m && !keep.has(Number(m[1]))) fs.rmSync(path.join(JOB_DIR, f), { force: true });
  }
  writeAtomic(CRON_FILE, lines.join('\n') + '\n', 0o644);
  for (const s of skipped) {
    await recordEventOnce(`cron:${s.id}`, `Cron görevi "${s.name}" geçersiz zamanlama ("${s.schedule}") nedeniyle atlandı; diğer görevler `
      + `çalışıyor — Sistem & Log → Cron görevleri'nden düzeltin: ${s.error}`, 'warning', 24 * 60);
  }
}

// Zamanlayıcının son çalıştırma sonuçları (cron-run.sh yazar): id → { rc, at (epoch sn) }.
export function readJobStatuses(): Map<number, { rc: number; at: number }> {
  const out = new Map<number, { rc: number; at: number }>();
  if (!isLinux) return out;
  let files: string[] = [];
  try { files = fs.readdirSync(JOB_DIR); } catch { return out; }
  for (const f of files) {
    const m = /^(\d+)\.status$/.exec(f);
    if (!m) continue;
    try {
      const [rc, at] = fs.readFileSync(path.join(JOB_DIR, f), 'utf8').trim().split(/\s+/).map(Number);
      if (Number.isFinite(rc) && Number.isFinite(at)) out.set(Number(m[1]), { rc, at });
    } catch { /* yarım yazım: sonraki okumada */ }
  }
  return out;
}

// Şu an çalışan görevler: süreç tablosundaki cron-run.sh süreçleri (bash …/cron-run.sh <id> [manual]); aynı görevin
// ikinci çalıştırması kilitte (flock) hemen çıkar. Kilidi denemek (flock -n) o anda başlayan zamanlanmış çalıştırmayı
// atlatabilirdi; /proc/locks da kullanılmaz (kilidi alan flock(1) süreci hemen çıkar, sahibi ölmüş kilit başka PID ad
// alanından bakınca listede görünmez). Arka uç ölse de doğru kalır (eskiden "Çalışıyor" veritabanında takılı kalabiliyordu).
export function runningJobs(): Set<number> {
  const out = new Set<number>();
  if (!isLinux) return out;
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    let argv: string[];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    const i = argv.findIndex(a => a === RUNNER || a.endsWith('/cron-run.sh'));
    if (i >= 0 && /^\d+$/.test(argv[i + 1] || '')) out.add(Number(argv[i + 1]));
  }
  return out;
}

// Son çalıştırmanın çıktısı (son 60 satır) ve sonucu.
export function jobOutput(id: number): { output: string; rc: number | null; at: number | null } {
  let output = '';
  try { output = fs.readFileSync(path.join(JOB_DIR, `${id}.out`), 'utf8'); } catch { /* henüz yok */ }
  const st = readJobStatuses().get(id);
  return { output, rc: st ? st.rc : null, at: st ? st.at : null };
}

// Panelden "Şimdi çalıştır": zamanlanmış çalıştırmayla aynı betik, kabuk (/bin/bash) ve kilit; panelin dışında (systemd-run)
// — eskiden istek içinde 60 sn'de öldürülüyordu (apt / dpkg yarıda kalabilirdi). Üst sınır 1 saat.
export async function startJobNow(id: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('systemd-run', ['--quiet', `--unit=pi5-cron-${id}-${Date.now()}`, '--collect', '--service-type=exec',
      '-p', 'RuntimeMaxSec=3600', '/bin/bash', RUNNER, String(id), 'manual'], { timeout: 15000 },
    (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim() || 'başlatılamadı')) : resolve()));
  });
}

export interface SystemCronEntry { source: string; schedule: string; command: string }

// Panelin değiştiremediği görevler: Klyrix Gate'in gece güncellemesi ve Pi-hole'un kendi görevleri.
export function readSystemCron(): SystemCronEntry[] {
  if (!isLinux) return [];
  const out: SystemCronEntry[] = [];
  for (const [file, source] of [[LEGACY_FILE, 'Klyrix Gate'], [PIHOLE_FILE, 'Pi-hole']] as const) {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || /^[A-Z_]+=/.test(line)) continue;
      const parts = line.split(/\s+/);
      const macro = parts[0].startsWith('@');
      const schedule = macro ? parts[0] : parts.slice(0, 5).join(' ');
      const command = parts.slice(macro ? 2 : 6).join(' ').replace(/^PATH="[^"]*"\s+/, '');
      out.push({ source, schedule, command });
    }
  }
  return out;
}

// Açılışta: panel görevleri zamanlayıcıya yazılır, ANCAK bu başarılıysa eski pi5-maintenance'taki apt / log temizliği
// satırları çıkarılır (aynı iş iki kez çalışmasın; yazım başarısızsa eski satırlar yerinde kalır, bakım durmaz). Eski
// varsayılan log komutu, taşınan satırın /var/log temizliğini de kapsayacak biçimde önce güncellenir.
export async function syncCronOnStartup(): Promise<void> {
  if (!isLinux) return;
  await dbRun('UPDATE cron_jobs SET command = ? WHERE name = ? AND command = ?', [LOG_CLEANUP_CMD, 'Log Temizligi', OLD_LOG_CMD]);
  await dbRun('UPDATE cron_jobs SET command = ? WHERE name = ? AND command = ?', [GRAVITY_CMD, 'Pi-hole Gravity', OLD_GRAVITY_CMD]);
  await syncCronJobs();
  let txt: string;
  try { txt = fs.readFileSync(LEGACY_FILE, 'utf8'); } catch { return; }
  const lines = txt.split('\n');
  const kept = lines.filter(l => l.trim().startsWith('#') || !LEGACY_MOVED.some(re => re.test(l)));
  if (kept.length === lines.length) return;
  writeAtomic(LEGACY_FILE, kept.join('\n').replace(/\n*$/, '\n'), 0o644);
  console.log('[cron] pi5-maintenance: apt ve log temizliği satırları panel görevlerine taşındı');
}

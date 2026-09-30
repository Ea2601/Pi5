import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Panel güncellemesi: iş pi5-backend'in DIŞINDA koşar (systemd-run → scripts/update-job.sh). Eskiden update.sh
// POST /api/system/update isteğinin içinde 5 dk'ya kadar bekletiliyordu: derleme sürerken tarayıcı ile Pi arasındaki
// bağlantı koparsa (telefon ekranı kapanır, Wi-Fi değişir) panel "Failed to fetch" gösteriyordu, güncelleme arka planda
// sürse bile. Şimdi istek hemen döner; panel ilerlemeyi /api/system/update/status'tan izler.

const execFileP = promisify(execFile);

const UPDATE_UNIT = 'pi5-update';
const JOB_SCRIPT = '/opt/pi5-gateway/scripts/update-job.sh';
const STATE_DIR = '/run/pi5-update';
const STATE_FILE = `${STATE_DIR}/state`;
const OUTPUT_FILE = `${STATE_DIR}/output`;
export const UPDATE_MAX_RUNTIME_S = 1800;
// Backend durumu systemd-run'dan ÖNCE yazar: bu süre içinde birim henüz görünmüyorsa iş "yarıda kesildi" sayılmaz.
const START_GRACE_S = 15;

export type UpdateStep = { step: string; output: string; success: boolean; warning?: boolean };
export type UpdateStatus = {
  state: 'idle' | 'running' | 'done' | 'failed';
  id?: string;
  phase?: string;
  startedAt?: number;
  finishedAt?: number;
  steps?: UpdateStep[];
};
export type UpdateStart = { started: boolean; running?: boolean; id?: string };

export function parseKv(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

// update.sh'nin günlük satırlarından o anki adım. Adımlar sırayla ilerler: listedeki ilk eşleşme en ileri adımdır.
// Bağımlılıklar derlemeden önce, kurulum adımları (post-update system) iki derleme de başarılıysa; eski update.sh
// post-update'i derlemeden önce tek parça çalıştırır ("Post-update çalıştırılıyor").
const PHASES: [RegExp, string][] = [
  [/=== Güncelleme tamamlandı ===/, 'Servis yeniden başlatılıyor'],
  [/Kurulum adımları çalıştırılıyor/, 'Kurulum adımları (paketler, ayarlar)'],
  [/Frontend build\.\.\./, 'Arayüz derleniyor'],
  [/Backend build\.\.\./, 'Backend derleniyor'],
  [/Post-update çalıştırılıyor/, 'Kurulum adımları (paketler, ayarlar)'],
  [/Bağımlılıklar denetleniyor/, 'Bağımlılıklar denetleniyor'],
  [/Git (fetch|reset)/, 'Kod indiriliyor (git)'],
];
export function updatePhase(output: string): string {
  for (const [re, label] of PHASES) if (re.test(output)) return label;
  return 'Başlatılıyor';
}

// update.sh düşülen adımı '@@STEP_FAILED=<adım> rc=N', post-update çıkış kodunu '@@POSTUPDATE_RC=N' ile bildirir
// (eskiden çıktıdaki kelimelerden tahmin ediliyordu; 'Git OK: unknown' gibi durumlar görünmüyordu).
// Derleme adımları geçici klasöre derler; başarısızsa kaynak önceki sürüme döner (update.sh) — çalışan panel değişmez.
const STEP_LABEL: Record<string, string> = { hazirlik: 'Hazırlık', git: 'Git Pull', backend: 'Backend Build', frontend: 'Frontend Build', swap: 'Yeni derlemeye geçiş' };
const STEP_ORDER = ['hazirlik', 'git', 'backend', 'frontend', 'swap'];

// Biten işin adımları (panelin önceki yanıtıyla aynı biçim). kv: durum dosyası (state, rc, reason, restart).
export function summarizeUpdate(output: string, kv: Record<string, string>): UpdateStep[] {
  const tail = output.trim().slice(-500);
  const steps: UpdateStep[] = [];
  if (kv.state === 'done' || kv.restart === 'failed') {
    const head = /Git OK: (\S+)/.exec(output)?.[1];
    const viaSudo = /Normal fetch başarısız/.test(output) ? ' — sudo ile' : '';
    steps.push({ step: 'Git Pull', output: head ? `OK (${head})${viaSudo}` : 'OK', success: true });
    steps.push({ step: 'Backend Build', output: 'OK', success: true });
    steps.push({ step: 'Frontend Build', output: tail, success: true });
    const pu = /@@POSTUPDATE_RC=(\d+)/.exec(output);
    if (pu) steps.push({ step: 'Post-Update', output: `çıkış kodu ${pu[1]} — ayrıntı: core/update.log`, success: true, warning: true });
    steps.push(kv.restart === 'failed'
      ? { step: 'Servis Restart', output: 'pi5-backend yeniden başlatılamadı — sudo systemctl restart pi5-backend', success: false }
      : { step: 'Servis Restart', output: 'pi5-backend yeniden başlatıldı', success: true });
    return steps;
  }
  if (kv.reason === 'stopped') {
    return [{ step: 'Güncelleme durduruldu', output: `${UPDATE_MAX_RUNTIME_S / 60} dk sınırı aşıldı ya da iş durduruldu — ayrıntı: core/update.log`, success: false }];
  }
  if (kv.reason === 'start') return [{ step: 'Güncelleme başlatılamadı', output: tail, success: false }];
  const failed = /@@STEP_FAILED=(\w+) rc=(\d+)/.exec(output);
  if (failed && STEP_ORDER.includes(failed[1])) {
    for (const s of STEP_ORDER.slice(1, STEP_ORDER.indexOf(failed[1]))) steps.push({ step: STEP_LABEL[s], output: 'OK', success: true });
    steps.push({ step: STEP_LABEL[failed[1]], output: tail, success: false });
  } else {
    steps.push({ step: 'Güncelleme', output: tail || 'çıktı yok — ayrıntı: core/update.log', success: false });
  }
  return steps;
}

function readState(): Record<string, string> | null {
  try { return parseKv(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(text: string) {
  const tmp = `${STATE_FILE}.b${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, STATE_FILE);
}

// Çıktının son 1 MB'ı (update.sh çıktısı küçüktür; sınır yalnız güvenlik için).
function readOutput(): string {
  try {
    const buf = fs.readFileSync(OUTPUT_FILE);
    return buf.subarray(Math.max(0, buf.length - 1048576)).toString('utf8');
  } catch {
    return '';
  }
}

// systemctl okunamazsa 'unknown': süren bir işi yanlışlıkla "yarıda kesildi" saymayalım, ikinci iş de başlatmayalım.
async function unitState(): Promise<'active' | 'inactive' | 'unknown'> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', '-p', 'ActiveState', '--value', `${UPDATE_UNIT}.service`], { timeout: 5000 });
    return /^(active|activating|deactivating|reloading)$/.test(stdout.trim()) ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const kv = readState();
  if (!kv?.id) return { state: 'idle' };
  const output = readOutput();
  const base = { id: kv.id, startedAt: num(kv.started), finishedAt: num(kv.finished) };
  if (kv.state === 'running') {
    const young = Math.floor(Date.now() / 1000) - (num(kv.started) ?? 0) < START_GRACE_S;
    if (young || (await unitState()) !== 'inactive') return { ...base, state: 'running', phase: updatePhase(output) };
    // Birim yok ama durum "sürüyor": iş sonucu yazamadan öldü (SIGKILL vb.).
    return { ...base, state: 'failed', steps: [{ step: 'Güncelleme yarıda kesildi', output: output.trim().slice(-500) || 'ayrıntı: core/update.log', success: false }] };
  }
  return { ...base, state: kv.state === 'done' ? 'done' : 'failed', steps: summarizeUpdate(output, kv) };
}

async function launch(): Promise<UpdateStart> {
  const unit = await unitState();
  if (unit === 'unknown') throw new Error('Güncelleme durumu okunamadı (systemctl) — birazdan yeniden deneyin');
  if (unit === 'active') return { started: false, running: true, id: readState()?.id };
  const id = String(Date.now());
  const started = Math.floor(Date.now() / 1000);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, '');
  writeState(`id=${id}\nstate=running\nstarted=${started}\n`);
  try {
    await execFileP('systemd-run', [
      '--quiet', '--collect', `--unit=${UPDATE_UNIT}`, '--service-type=exec',
      '--description=Klyrix Gate panel güncellemesi', '-p', `RuntimeMaxSec=${UPDATE_MAX_RUNTIME_S}`,
      '/bin/bash', JOB_SCRIPT, id,
    ], { timeout: 15000 });
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'systemd-run hatası';
    fs.writeFileSync(OUTPUT_FILE, `Güncelleme işi başlatılamadı: ${msg}\n`);
    writeState(`id=${id}\nstate=failed\nstarted=${started}\nfinished=${Math.floor(Date.now() / 1000)}\nreason=start\n`);
    throw new Error(`Güncelleme başlatılamadı: ${msg}`);
  }
  return { started: true, id };
}

// Aynı anda gelen ikinci istek yeni iş başlatmaz, başlatılan işin kimliğini alır.
let pending: Promise<UpdateStart> | null = null;
export function startUpdate(): Promise<UpdateStart> {
  if (pending) return pending.then(r => ({ ...r, started: false, running: true }));
  pending = launch().finally(() => { pending = null; });
  return pending;
}

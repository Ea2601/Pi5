import { getApi, postApi } from './hooks/useApi';
import { toast } from './toast';

// Panel güncellemesi (Ayarlar, üst çubuktaki güncelleme penceresi, Sistem Günlükleri). Pi işi backend'in dışında yürütür
// (scripts/update-job.sh); panel durumu /api/system/update/status'tan izler. İzleme sırasındaki ağ hataları yok sayılır:
// backend işin sonunda yeniden başlar, telefon ekranı kapanınca ya da Wi-Fi değişince istek düşebilir. Eskiden
// güncelleme tek isteğin içinde 5 dk'ya kadar sürüyordu ve bağlantı kopunca panel "Failed to fetch" gösteriyordu.

export type UpdateStep = { step: string; output: string; success: boolean; warning?: boolean };
export type UpdateStatus = {
  state: 'idle' | 'running' | 'done' | 'failed';
  id?: string;
  phase?: string;
  steps?: UpdateStep[];
};
type PhaseFn = (phase: string) => void;

const POLL_MS = 3000;
const MAX_WAIT_MS = 40 * 60 * 1000; // iş Pi'de en çok 30 dk sürebilir (RuntimeMaxSec)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function report(success: boolean, steps: UpdateStep[]) {
  if (success) {
    toast.success('Güncelleme tamamlandı! Servis yeniden başlatıldı, 8 sn sonra sayfa yenilenecek...');
    setTimeout(() => window.location.reload(), 8000);
  } else {
    const failed = steps.filter(s => !s.success).map(s => s.step).join(', ');
    toast.error(`Başarısız adımlar: ${failed || 'bilinmiyor'} — ayrıntı: core/update.log`);
  }
}

async function follow(id: string, onPhase: PhaseFn): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    let s: UpdateStatus;
    try {
      s = await getApi<UpdateStatus>('/system/update/status');
    } catch {
      continue; // backend yeniden başlıyor ya da bağlantı anlık koptu
    }
    if (!s.id) {
      // Durum dosyası /run'da: yalnız Pi yeniden başlayınca silinir.
      report(false, [{ step: 'Güncelleme durumu bulunamadı (Pi yeniden başlamış olabilir)', output: '', success: false }]);
      return;
    }
    if (s.id !== id) {
      if (Number(s.id) > Number(id)) id = s.id; // ardından yeni bir güncelleme başlatılmış: onu izle
      continue;
    }
    if (s.state === 'running') {
      if (s.phase) onPhase(s.phase);
      continue;
    }
    report(s.state === 'done', s.steps || []);
    return;
  }
  toast.error('Güncelleme 40 dk içinde bitmedi — sonucu birazdan Ayarlar → Sistemi Güncelle\'den kontrol edin');
}

// Aynı iş için ikinci çağrı yeni izleme başlatmaz (sonuç bir kez bildirilir); adım bilgisi tüm dinleyicilere gider.
const tracked = new Map<string, { done: Promise<void>; listeners: Set<PhaseFn> }>();

export function trackSystemUpdate(id: string, onPhase?: PhaseFn): Promise<void> {
  let t = tracked.get(id);
  if (!t) {
    const listeners = new Set<PhaseFn>();
    t = { listeners, done: follow(id, p => listeners.forEach(fn => fn(p))) };
    tracked.set(id, t);
  }
  if (onPhase) t.listeners.add(onPhase);
  return t.done;
}

// Güncellemeyi başlatır (ya da süren güncellemeye bağlanır) ve bitene kadar izler; sonucu bildirim olarak gösterir.
// Başlatma isteği düşerse hata fırlatır (çağıran gösterir).
export async function startSystemUpdate(onPhase?: PhaseFn): Promise<void> {
  const r = await postApi('/system/update', {});
  if (r.started === undefined) {
    // Bu sürümden eski backend: güncelleme isteğin içinde bitti, sonuç doğrudan geldi.
    if (Array.isArray(r.steps)) {
      report(!!r.success, r.steps);
      return;
    }
    throw new Error(r.error || 'Güncelleme başlatılamadı');
  }
  if (!r.id) throw new Error('Güncelleme başlatılamadı');
  return trackSystemUpdate(r.id, onPhase);
}

// Süren güncellemenin kimliği (sayfa güncelleme sırasında yenilendiyse izlemeye devam edilir); yoksa null.
export async function runningSystemUpdate(): Promise<string | null> {
  try {
    const s = await getApi<UpdateStatus>('/system/update/status');
    return s.state === 'running' && s.id ? s.id : null;
  } catch {
    return null;
  }
}

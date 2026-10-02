import { getApi } from './hooks/useApi';
import { toast } from './toast';

// Panel yeniden başlayınca sayfayı yenileme (saat dilimi, panel güncellemesi, cihaz rolü). Sayfa yeni süreç yanıt verince
// yenilenir: /api/status'taki açılış anı (started) öncekinden farklı olunca; ağ hataları yok sayılır (yeniden başlıyor).
// Körlemesine beklemede (eskiden 8 sn) yavaş açılışta sayfa backend kapalıyken yüklenip boş kalıyordu. Süre dolarsa sayfa
// yenilenmez, kullanıcıya bildirilir.
const POLL_MS = 1500;
const TRIES = 60;   // ~90 sn

// Şu an yanıt veren sürecin açılış anı (ms); okunamazsa undefined
export async function panelStarted(): Promise<number | undefined> {
  try {
    const s = await getApi<{ started?: number }>('/status');
    return typeof s.started === 'number' ? s.started : undefined;
  } catch {
    return undefined;
  }
}

// before: yeniden başlamadan önceki sürecin açılış anı (undefined: bilinmiyor — açılış anı veren ilk yanıtta yenilenir).
// message: beklerken gösterilen bildirim (kendiliğinden kapanmaz). true: sayfa yenileniyor; false: süre doldu (bildirildi).
export async function reloadWhenRestarted(before: number | undefined, message: string): Promise<boolean> {
  const tid = toast.info(message, { duration: 0 });
  for (let i = 0; i < TRIES; i++) {
    await new Promise(ok => setTimeout(ok, POLL_MS));
    try {
      if ((await getApi<{ started?: number }>('/status')).started !== before) {
        location.reload();
        return true;
      }
    } catch { /* yeniden başlıyor */ }
  }
  toast.dismiss(tid);
  toast.error('Panel henüz yeniden başlamadı — sayfayı birazdan yenileyin');
  return false;
}

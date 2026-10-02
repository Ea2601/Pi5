// Bir yedekleme turu (ön planda düğmeyle ya da arka plan görevinde): koşullar (eşleşme, anahtar, izin, Wi-Fi) → Pi'ye bağlan →
// tara → Pi'de olmayanları şifreleyip yükle → telefondaki durum değiştiyse anlık görüntü (yedek) yaz → özeti kaydet.
// Kaynaklar ayardan: fotoğraf (+ video, ses), klasörler, kişiler, takvim. Seçili bir kaynağa erişilemezse (izin düştü,
// klasör yok) tur durur — o tür eksik bir yedek yazılmaz. Aynı anda tek tur. Telefonda hiçbir şey silinmez ya da değişmez.
// Arka planda sürme: ön planda başlayan tur Android'de ön plan hizmetiyle (ilerleme bildirimi) uygulamadan çıkınca da biter;
// uygulama kapalıyken turları arka plan görevi başlatır (task.ts).
import { Platform } from 'react-native';
import * as Battery from 'expo-battery';
import * as Network from 'expo-network';
import { PiError } from './core/client.ts';
import { runSnapshot, type SnapshotProgress, type SnapshotResult } from './core/snapshot.ts';
import { calendarSource } from './platform/calendar.ts';
import { contactsSource } from './platform/contacts.ts';
import { folderSource } from './platform/folders.ts';
import { loadIdCache } from './platform/idcache.ts';
import { onKeepAliveStop, startKeepAlive, stopKeepAlive, updateKeepAlive } from './platform/keepalive.ts';
import { mediaAccess, mediaSource } from './platform/media.ts';
import { loadLastSnap, loadPairing, loadSettings, saveLast, saveLastSnap } from './platform/store.ts';
import { openSession, Skip } from './session.ts';

export { Skip } from './session.ts';
let running: Promise<SnapshotResult> | null = null;
let stopFlag = false;
export const requestStop = () => { stopFlag = true; };
// Bildirimdeki «Durdur» ya da Android 15'in günlük ön plan hizmeti sınırı: tur durur, sonraki turda kaldığı yerden sürer
onKeepAliveStop(requestStop);

// Süren turun durumu tek yerde: ekran sekme değişip yeniden açılsa da, tur arka plan görevinden başlasa da aynı turu
// (ve bittiğini) görür. Dinleyici abone olunca hemen son durumu alır. kept: tur ön plan hizmetiyle korunuyor (uygulamadan
// çıkılabilir).
export interface RunState { running: boolean; progress: SnapshotProgress | null; kept: boolean }
let state: RunState = { running: false, progress: null, kept: false };
const listeners = new Set<(s: RunState) => void>();
function publish(s: RunState): void {
  state = s;
  for (const l of listeners) l(s);
}
export function subscribeRun(l: (s: RunState) => void): () => void {
  listeners.add(l);
  l(state);
  return () => { listeners.delete(l); };
}

export function backupOnce(o: { deadline?: number; background?: boolean; onProgress?: (p: SnapshotProgress) => void } = {}): Promise<SnapshotResult> {
  if (running) return running;
  stopFlag = false;
  let kept = false;
  publish({ running: true, progress: null, kept });
  running = (async () => {
    if (!(await loadPairing())) throw new Skip('Pi ile eşleşmemiş');
    const s = await loadSettings();
    if (o.background && !s.auto) throw new Skip('Kendiliğinden yedekleme kapalı');
    if ((await mediaAccess(false)) === 'none') throw new Skip('Fotoğraflara erişim izni yok');
    if (s.wifiOnly) {
      const n = await Network.getNetworkStateAsync();
      if (n.type !== Network.NetworkStateType.WIFI && n.type !== Network.NetworkStateType.ETHERNET) throw new Skip('Yalnız Wi-Fi\'da yedeklenir');
    }
    if (o.background && s.chargingOnly && !(await charging())) throw new Skip('Kendiliğinden yedekleme yalnız şarjdayken');
    // Ön planda başlayan tur uygulamadan çıkınca / ekran kapanınca da sürsün (Android: ön plan hizmeti + ilerleme bildirimi)
    kept = !o.background && await startKeepAlive();
    publish({ running: true, progress: null, kept });
    const { pairing: pr, api, cipher } = await openSession();
    const ids = loadIdCache(pr.profileId);
    const last = await loadLastSnap();
    let phase: SnapshotProgress['phase'] = 'scan';
    try {
      const sources = [
        mediaSource({ videos: s.videos, audio: s.audio && Platform.OS === 'android' }),
        ...(s.folders.length ? [folderSource(s.folders)] : []),
        ...(s.contacts ? [contactsSource()] : []),
        ...(s.calendar ? [calendarSource()] : []),
      ];
      const r = await runSnapshot(api, cipher, sources, {
        device: pr.deviceName, platform: Platform.OS, deadline: o.deadline, shouldStop: () => stopFlag, ids,
        onProgress: p => { phase = p.phase; publish({ running: true, progress: p, kept }); updateKeepAlive(p); o.onProgress?.(p); },
        // Telefondaki durum bu telefonun son yedeğiyle aynıysa ve o yedek Pi'de duruyorsa yenisi yazılmaz
        unchanged: async h => !!last && last.profileId === pr.profileId && last.hash === h && (await api.snapshots()).some(x => x.id === last.snapshotId),
      });
      if (r.snapshotId && r.hash) await saveLastSnap({ profileId: pr.profileId, snapshotId: r.snapshotId, hash: r.hash });
      await saveLast({
        at: Date.now(), uploaded: r.uploaded, failed: r.failed, bytes: r.bytes, items: r.items, snapshotId: r.snapshotId,
        unchanged: r.unchanged, error: r.error, stopped: r.stopped,
      });
      return r;
    } catch (e) {
      await saveLast({ at: Date.now(), uploaded: 0, failed: 0, bytes: 0, error: e instanceof Error ? e.message : String(e) });
      if (e instanceof PiError && e.status === 401) throw new PiError(401, 'Pi bu telefonu tanımıyor — panelden yeniden eşleştirin');
      throw e;
    } finally {
      ids.save(phase !== 'scan');
    }
  })().finally(() => {
    if (kept) stopKeepAlive();
    running = null;
    publish({ running: false, progress: null, kept: false });
  });
  return running;
}

// Şarjda mı (dolu da sayılır); okunamazsa hayır
async function charging(): Promise<boolean> {
  const st = await Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN);
  return st === Battery.BatteryState.CHARGING || st === Battery.BatteryState.FULL;
}

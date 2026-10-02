// Bir yedekleme turu (ön planda düğmeyle ya da arka plan görevinde): koşullar (eşleşme, izin, Wi-Fi) → Pi'ye bağlan →
// tara → yükle → özeti kaydet. Aynı anda tek tur.
import * as Network from 'expo-network';
import { connect, PiError } from './core/client.ts';
import { runBackup, type Progress, type RunResult } from './core/engine.ts';
import { http } from './platform/http.ts';
import { media, mediaAccess } from './platform/media.ts';
import { loadPairing, loadSettings, saveLast, savePairing } from './platform/store.ts';

export class Skip extends Error {}
let running: Promise<RunResult> | null = null;
let stopFlag = false;
export const isRunning = () => running !== null;
export const requestStop = () => { stopFlag = true; };

export function backupOnce(o: { deadline?: number; background?: boolean; onProgress?: (p: Progress) => void } = {}): Promise<RunResult> {
  if (running) return running;
  stopFlag = false;
  running = (async () => {
    const pr = await loadPairing();
    if (!pr) throw new Skip('Pi ile eşleşmemiş');
    const s = await loadSettings();
    if (o.background && !s.auto) throw new Skip('Kendiliğinden yedekleme kapalı');
    if ((await mediaAccess(false)) === 'none') throw new Skip('Fotoğraflara erişim izni yok');
    if (s.wifiOnly) {
      const n = await Network.getNetworkStateAsync();
      if (n.type !== Network.NetworkStateType.WIFI && n.type !== Network.NetworkStateType.ETHERNET) throw new Skip('Yalnız Wi-Fi\'da yedeklenir');
    }
    const client = await connect(http, pr);
    if (client.host !== pr.host) await savePairing({ ...pr, host: client.host }); // bir dahaki sefere önce bu adres
    try {
      const r = await runBackup(client, media, { videos: s.videos, deadline: o.deadline, shouldStop: () => stopFlag, onProgress: o.onProgress });
      await saveLast({ at: Date.now(), uploaded: r.uploaded, failed: r.failed, skipped: r.skipped, bytes: r.bytes, error: r.error, stopped: r.stopped });
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await saveLast({ at: Date.now(), uploaded: 0, failed: 0, skipped: 0, bytes: 0, error: msg });
      if (e instanceof PiError && e.status === 401) throw new PiError(401, 'Pi bu telefonu tanımıyor — panelden yeniden eşleştirin');
      throw e;
    }
  })().finally(() => { running = null; });
  return running;
}

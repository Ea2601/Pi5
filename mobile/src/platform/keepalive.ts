// Yedekleme turu uygulamadan çıkınca ve ekran kapanınca da sürsün (Android): tur boyunca ön plan hizmeti + ilerleme bildirimi
// (modules/klyrix-keepalive). Hizmet yalnız uygulama öndeyken başlatılabilir — arka plan görevinin turu kendi süresiyle
// çalışır. iOS ve web'de modül yok: hiçbir şey yapmaz.
import { PermissionsAndroid, Platform } from 'react-native';
import KeepAlive from '../../modules/klyrix-keepalive/index.ts';
import type { SnapshotProgress } from '../core/snapshot.ts';

const TITLE = 'Klyrix/Gate Sync';
export const keepAliveSupported = !!KeepAlive;
let active = false;
let lastUpdate = 0;
let asked = false;

// Android 13+: bildirim izni (ilk turda bir kez sorulur). Verilmezse hizmet yine çalışır, yalnız bildirim görünmez.
async function askNotifications(): Promise<void> {
  if (asked || Platform.OS !== 'android' || Number(Platform.Version) < 33) return;
  asked = true;
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => null);
}

export async function startKeepAlive(): Promise<boolean> {
  if (!KeepAlive) return false;
  if (active) return true;
  await askNotifications();
  active = KeepAlive.start(TITLE, 'Yedekleme başlıyor…');
  lastUpdate = 0;
  return active;
}

// Bildirim saniyede en çok bir kez yenilenir
export function updateKeepAlive(p: SnapshotProgress): void {
  if (!KeepAlive || !active) return;
  const now = Date.now();
  if (now - lastUpdate < 1000) return;
  lastUpdate = now;
  if (p.phase === 'scan') KeepAlive.update(TITLE, `Taranıyor… ${p.scanned}`, 0, 0);
  else if (p.phase === 'upload') KeepAlive.update(TITLE, `Şifreleniyor ve yükleniyor ${p.done + p.failed} / ${p.pending}`, p.done + p.failed, p.pending);
  else KeepAlive.update(TITLE, 'Yedek kaydediliyor…', 0, 0);
}

export function stopKeepAlive(): void {
  if (!KeepAlive || !active) return;
  active = false;
  KeepAlive.stop();
}

// Bildirimdeki «Durdur» ya da Android 15'in günlük süre sınırı
export function onKeepAliveStop(cb: () => void): () => void {
  if (!KeepAlive) return () => {};
  const a = KeepAlive.addListener('onStopRequest', cb);
  const b = KeepAlive.addListener('onTimeout', cb);
  return () => { a.remove(); b.remove(); };
}

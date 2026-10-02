// Arka plan görevi: uygulama kapalıyken turları sistem başlatır — en sık ~15 dakikada bir, telefon uygun gördüğünde (Doze /
// pil optimizasyonu geciktirebilir; iOS çoğunlukla gece / şarjdayken). Android'de iş en çok 10 dk sürebilir (WorkManager):
// tur 8 dk'da durur, yarıda kalan bir sonraki turda kaldığı yerden sürer. iOS'ta arka plan süresi kısa (25 sn).
// Tanım uygulama yüklenirken (index.ts) yapılmalı — sistem görevi uygulama kapalıyken de başlatır.
import { Platform } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { backupOnce, Skip } from '../backup.ts';

export const TASK = 'klyrix-backup';
const INTERVAL_MIN = 15;
const BUDGET_MS = Platform.OS === 'android' ? 8 * 60_000 : 25_000;

TaskManager.defineTask(TASK, async () => {
  try {
    await backupOnce({ background: true, deadline: Date.now() + BUDGET_MS });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    return e instanceof Skip ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Açık: görev kayıtlı ve aralığı güncel olmalı (eski sürüm 60 dk ile kaydetmişti → yeniden kaydedilir)
export async function setAutoBackup(on: boolean): Promise<void> {
  const task = (await TaskManager.getRegisteredTasksAsync()).find(t => t.taskName === TASK);
  if (on && task && task.options?.minimumInterval !== INTERVAL_MIN) await BackgroundTask.unregisterTaskAsync(TASK);
  if (on && (!task || task.options?.minimumInterval !== INTERVAL_MIN)) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: INTERVAL_MIN });
  if (!on && task) await BackgroundTask.unregisterTaskAsync(TASK);
}

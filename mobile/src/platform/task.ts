// Arka plan görevi: sistem uygun gördüğünde (en sık 15 dakikada bir; iOS çoğunlukla gece / şarjdayken) kısa bir tur.
// Tanım uygulama yüklenirken (index.ts) yapılmalı — sistem görevi uygulama kapalıyken de başlatır.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { backupOnce, Skip } from '../backup.ts';

export const TASK = 'klyrix-backup';
const BUDGET_MS = 25_000; // iOS arka plan süresi kısa; yarıda kalan dosya sonraki turda sürer

TaskManager.defineTask(TASK, async () => {
  try {
    await backupOnce({ background: true, deadline: Date.now() + BUDGET_MS });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    return e instanceof Skip ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function setAutoBackup(on: boolean): Promise<void> {
  const has = await TaskManager.isTaskRegisteredAsync(TASK);
  if (on && !has) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 60 });
  if (!on && has) await BackgroundTask.unregisterTaskAsync(TASK);
}

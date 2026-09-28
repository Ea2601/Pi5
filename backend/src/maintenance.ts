import fs from 'fs';
import path from 'path';

// Core directory must exist
const coreDir = path.resolve(__dirname, '../../core');
if (!fs.existsSync(coreDir)) fs.mkdirSync(coreDir, { recursive: true });
const logPath = path.resolve(coreDir, 'system.log');

function writeLog(message: string) {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(logPath, entry); } catch { /* */ }
  console.log(message);
}

// NOT: Zamanlama işletim sisteminin cron'undadır: panel görevleri (Sistem & Log → Cron) /etc/cron.d/pi5-panel'e yazılır
// (cronSync.ts), panelin gece güncellemesi /etc/cron.d/pi5-maintenance'tadır. Buradaki eski `runMaintenance` sadece
// komutları `echo`layan bir stub'dı ve her gece 04:00'te gizlice `sudo reboot` çağırıyordu — kaldırıldı.
export function startCronJobs() {
  writeLog('CRON: Panel görevleri /etc/cron.d/pi5-panel, gece güncellemesi /etc/cron.d/pi5-maintenance üzerinden çalışır.');
}

export function getSystemLogs(): string[] {
  try {
    const logData = fs.readFileSync(logPath, 'utf8');
    return logData.split('\n').filter(line => line.trim() !== '').reverse(); // newest first
  } catch {
    return ['No logs available yet.'];
  }
}

export function clearSystemLogs(): void {
  try {
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] LOG: Loglar temizlendi\n`);
  } catch { /* */ }
}

// Write initial startup log
writeLog('SYSTEM: Node.js Backend Engine Started');

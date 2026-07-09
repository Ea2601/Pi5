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

// NOT: Gerçek bakım (apt update/upgrade, git pull, build, log temizliği) install.sh'in kurduğu
// /etc/cron.d/pi5-maintenance ile yapılır. Buradaki eski `runMaintenance` sadece komutları `echo`layan
// bir stub'dı (sahte "başarılı" logu üretiyordu) ve her gece 04:00'te gizlice `sudo reboot` çağırıyordu —
// ikisi de kaldırıldı. Cron zamanlaması tek noktada (cron.d) yönetilir.
export function startCronJobs() {
  writeLog('CRON: Bakım zamanlaması işletim sistemi cron.d üzerinden yönetiliyor (pi5-maintenance).');
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

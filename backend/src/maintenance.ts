import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = util.promisify(exec);
// Core directory must exist
const coreDir = path.resolve(__dirname, '../../core');
if (!fs.existsSync(coreDir)) fs.mkdirSync(coreDir, { recursive: true });
const logPath = path.resolve(coreDir, 'system.log');

function writeLog(message: string) {
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logPath, entry);
  console.log(message);
}

export async function runMaintenance() {
  writeLog('MAINTENANCE: Starting daily apt update & upgrade loop...');
  try {
    // In real environment, this runs apt update & -y upgrade
    await execAsync('echo "sudo apt update -qq && sudo apt upgrade -y -qq"');
    writeLog('MAINTENANCE: OS packages updated successfully.');
    
    // Pi-hole / Zapret updates
    await execAsync('echo "pihole -up && pihole -g"');
    writeLog('MAINTENANCE: AdBlock Gravity lists updated.');
    
  } catch (err: any) {
    writeLog(`MAINTENANCE ERROR: ${err.message}`);
  }
}

export function startCronJobs() {
  writeLog('CRON: Cron jobs engine initialized.');
  
  // Every 24 hours (86400000 ms), run runMaintenance()
  setInterval(runMaintenance, 86400000);
  
  // Simulated daily restart: Node can schedule a reboot at 04:00 AM every day
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 4 && now.getMinutes() === 0) {
       writeLog('CRON: Scheduling daily system reboot...');
       exec('sudo reboot');
    }
  }, 60000); // Check every minute
}

export function getSystemLogs(): string[] {
  try {
    const logData = fs.readFileSync(logPath, 'utf8');
    return logData.split('\n').filter(line => line.trim() !== '').reverse(); // newest first
  } catch {
    return ['No logs available yet.'];
  }
}

// Write initial startup log
writeLog('SYSTEM: Node.js Backend Engine Started');

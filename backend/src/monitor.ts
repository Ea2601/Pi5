import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

let isFailOpen = false;
let lastCheckTime = new Date().toISOString();
let lastCheckResult = 'pending';
let checksTotal = 0;
let checksFailed = 0;

export async function checkSystemHealth() {
  checksTotal++;
  lastCheckTime = new Date().toISOString();
  try {
    await execAsync('dig +time=2 +tries=1 google.com @127.0.0.1 -p 53');
    lastCheckResult = 'healthy';

    if (isFailOpen) {
      console.log('System recovered. Restoring secure nftables rules.');
      await execAsync('echo "Restoring strict routing"');
      isFailOpen = false;
    }
  } catch (error) {
    checksFailed++;
    lastCheckResult = 'failed';
    if (!isFailOpen) {
      console.warn('CRITICAL: DNS/Proxy Engine failed! Activating Fail-Open Bypass Mechanism.');
      await execAsync('echo "Applying emergency direct NAT routing bypassing dead services"');
      isFailOpen = true;
    }
  }
}

export function getHealthStatus() {
  return {
    isFailOpen,
    lastCheckTime,
    lastCheckResult,
    checksTotal,
    checksFailed,
    uptimePercent: checksTotal > 0 ? Math.round(((checksTotal - checksFailed) / checksTotal) * 100 * 10) / 10 : 100,
  };
}

export function startHealthMonitor() {
  console.log('Starting High Availability Health Monitor (10s interval)...');
  setInterval(checkSystemHealth, 10000);
}

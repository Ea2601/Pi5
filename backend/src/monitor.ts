import { checkDnsHealth } from './system';

// DNS sağlık izleme. Not: eski "fail-open bypass" mekanizması gerçekte hiçbir şey yapmayan bir stub'dı
// ve her toparlanmada `systemctl restart nftables` çağırıp kuralları yeniden yüklüyordu (çakışma kaynağı).
// Kaldırıldı — burada yalnızca sağlık durumu izlenir; gerçek bir HA bypass ileride eklenebilir.
let lastCheckTime = new Date().toISOString();
let lastCheckResult = 'pending';
let checksTotal = 0;
let checksFailed = 0;

export async function checkSystemHealth() {
  checksTotal++;
  lastCheckTime = new Date().toISOString();
  try {
    const healthy = await checkDnsHealth();
    lastCheckResult = healthy ? 'healthy' : 'failed';
    if (!healthy) checksFailed++;
  } catch {
    checksFailed++;
    lastCheckResult = 'failed';
  }
}

export function getHealthStatus() {
  return {
    isFailOpen: false,
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

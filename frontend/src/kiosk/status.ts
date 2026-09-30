// Kiosk başlık durumu ve ortak uç adları (panolar ve başlık aynı yoklamayı paylaşır).
import { usePoll, useOffline, type ServiceRow, type AlertRow, type TopologyLive } from './data';

export const TOPO = '/topology/live'; // 5 sn: hız ölçümü 10 sn'den eski örnekte 0 döner
export const SERVICES = '/services';
export const ALERTS = '/alerts?limit=8';
export const UNREAD = '/alerts/unread-count';
export const HEALTH = '/system/health';
export const WG = '/wg-server';
export const HW = '/system/hardware';

export const SERVICE_LABEL: Record<string, string> = {
  pihole: 'Pi-hole', unbound: 'Unbound', zapret: 'Zapret', fail2ban: 'Fail2Ban', nftables: 'Güvenlik duvarı', wireguard: 'VPS tünelleri',
};

// ── Üst çubuk durumu: en kötü durum öne çıkar ──
export function useStatus(): { level: 'ok' | 'warn' | 'bad'; text: string } {
  const svc = usePoll<{ services: ServiceRow[] }>(SERVICES, 15000);
  const health = usePoll<{ lastCheckResult?: string }>(HEALTH, 10000);
  const unread = usePoll<{ count: number }>(UNREAD, 15000);
  const alerts = usePoll<{ alerts: AlertRow[] }>(ALERTS, 15000);
  const offline = useOffline();
  if (offline) return { level: 'bad', text: "Panel API'sine ulaşılamıyor" };
  if (health?.lastCheckResult === 'failed') return { level: 'bad', text: 'DNS yanıt vermiyor' };
  const services = svc?.services || [];
  const broken = services.filter(s => s.status === 'error');
  if (broken.length) {
    return { level: 'bad', text: broken.length === 1 ? `${SERVICE_LABEL[broken[0].name] || broken[0].name} hatalı` : `${broken.length} servis hatalı` };
  }
  const critical = (alerts?.alerts || []).filter(a => a.severity === 'critical' && !a.acknowledged).length;
  if (critical) return { level: 'bad', text: `${critical} kritik uyarı` };
  const stopped = services.filter(s => s.status === 'stopped' && s.boot_enabled);
  if (stopped.length) {
    return { level: 'warn', text: stopped.length === 1 ? `${SERVICE_LABEL[stopped[0].name] || stopped[0].name} durmuş` : `${stopped.length} servis durmuş` };
  }
  if (unread?.count) return { level: 'warn', text: `${unread.count} okunmamış uyarı` };
  return { level: 'ok', text: 'Tüm sistemler normal' };
}

// Başlıktaki cihaz adı (topology'nin gateway.hostname'i; ayrı istek açmaz)
export function useHostname(): string {
  return usePoll<TopologyLive>(TOPO, 5000)?.gateway?.hostname || '';
}

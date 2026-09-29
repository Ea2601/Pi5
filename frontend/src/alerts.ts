// Uyarılar + olay geçmişi: Bildirimler sayfası (AlertsPanel) ve üst çubuktaki zil (NotificationBell) için ortak tipler ve
// yardımcılar. Backend: /api/alerts (events.ts). Bir yerde "okundu" yapılınca diğeri beklemeden yenilensin diye küçük bir
// olay yayını (pencere olayı) da buradadır.
import { AlertCircle, AlertTriangle, Info, type LucideIcon } from 'lucide-react';

export interface AlertItem {
  id: number;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  created_at: string;
  acknowledged: number | boolean;
  source: string;
}
export interface AlertsPage { alerts: AlertItem[]; hasMore?: boolean }

const SOURCE_LABEL: Record<string, string> = {
  cpu: 'İşlemci', memory: 'Bellek', disk: 'Disk', dns: 'DNS', network: 'İnternet', dhcp: 'DHCP', 'dhcp-rogue': 'DHCP',
  'dhcp-probe': 'DHCP', netmode: 'Ağ modu', 'netmode-ap': 'Ağ modu', service: 'Servis', update: 'Güncelleme',
  unbound: 'Unbound', zapret: 'Zapret', pihole: 'Pi-hole', vps: 'VPS', device: 'Cihaz', cron: 'Cron', vpn: 'Ev VPN',
};
export const sourceLabel = (s: string) => SOURCE_LABEL[(s || '').split(':')[0]] || s || 'Sistem';

export const parseAlertTime = (s: string) => new Date(s.replace(' ', 'T') + 'Z'); // SQLite CURRENT_TIMESTAMP = UTC

export function dayLabel(d: Date): string {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diff === 0) return 'Bugün';
  if (diff === 1) return 'Dün';
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
}

// "az önce", "5 dk önce", "3 sa önce", "Dün 14:05", "27 Eyl 09:12"
export function relativeTime(d: Date): string {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} sa önce`;
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const day = dayLabel(d);
  if (day === 'Bugün' || day === 'Dün') return `${day} ${hm}`;
  return `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${hm}`;
}

export const SEVERITY: Record<string, { label: string; badge: 'error' | 'warning' | 'info'; Icon: LucideIcon }> = {
  critical: { label: 'Kritik', badge: 'error', Icon: AlertCircle },
  warning: { label: 'Uyarı', badge: 'warning', Icon: AlertTriangle },
  info: { label: 'Bilgi', badge: 'info', Icon: Info },
};
export const severityMeta = (s: string) => SEVERITY[s] || SEVERITY.info;

// Okundu bilgisi değişti (sayfa ↔ zil): dinleyenler kendini yeniler. `read` = okundu sayılan kaydın numarası ya da 'all'.
const EVENT = 'klyrix-alerts-changed';
export type AlertsChange = number | 'all';
export const notifyAlertsChanged = (read: AlertsChange) => window.dispatchEvent(new CustomEvent<AlertsChange>(EVENT, { detail: read }));
export function onAlertsChanged(cb: (read: AlertsChange) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<AlertsChange>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
// Yerel listede okundu işareti (sayfanın "Daha fazla göster" ile eklediği eski kayıtlar için).
export const markRead = (items: AlertItem[], read: AlertsChange) =>
  items.map(a => (read === 'all' || a.id === read ? { ...a, acknowledged: 1 } : a));

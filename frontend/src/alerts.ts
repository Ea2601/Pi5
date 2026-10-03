// Uyarılar + olay geçmişi: Bildirimler sayfası (AlertsPanel) ve üst çubuktaki zil (NotificationBell) için ortak tipler ve
// yardımcılar. Backend: /api/alerts (events.ts). Bir yerde "okundu" yapılınca diğeri beklemeden yenilensin diye küçük bir
// olay yayını (pencere olayı) da buradadır.
import { AlertCircle, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import type { TabId } from './types';
import { NETTOOLS_TAB_KEY, NETTOOLS_TAB_EVENT } from './pcapLink';

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

// Eşi: backend/src/notify.ts SOURCE_LABEL (dış bildirim metni) — yeni kaynak iki haritaya birlikte eklenir.
const SOURCE_LABEL: Record<string, string> = {
  'netmode-bak': 'Yedek hat', 'netmode-bak-health': 'Yedek hat', 'netmode-wan': 'İnternet kartı', 'netmode-rep': 'Wi-Fi köprüsü',
  'netmode-home': "Ev Wi-Fi'ı", firewall: 'Güvenlik duvarı', fail2ban: 'Fail2Ban', 'routing-list': 'Yönlendirme listesi',
  'vps-tunnel': 'VPS tüneli', 'device-new': 'Yeni cihaz', notify: 'Dış bildirim', pcap: 'Paket kaydı', geo: 'Geo-IP',
  cpu: 'İşlemci', memory: 'Bellek', disk: 'Disk', dns: 'DNS', network: 'İnternet', dhcp: 'DHCP', 'dhcp-rogue': 'DHCP',
  'dhcp-probe': 'DHCP', netmode: 'Ağ modu', 'netmode-ap': 'Ağ modu', 'netmode-missing': 'Ağ modu', service: 'Servis', update: 'Güncelleme',
  unbound: 'Unbound', zapret: 'Zapret', pihole: 'Pi-hole', vps: 'VPS', device: 'Cihaz', cron: 'Cron', vpn: 'Ev VPN',
  mesh: 'Mesh', storage: 'Depolama', bandwidth: 'Bant genişliği', backup: 'Yedekleme', vault: 'Yedekleme',
  sync: 'Cihaz yedekleme', visits: 'Ziyaret Geçmişi', hotplug: 'Ağ kartı', 'wan-monitor': 'Hat kalitesi', calendar: 'Takvim',
  license: 'Lisans',
  templates: 'Koruma şablonları',
  fleet: 'Filo',
  sdwan: 'SD-WAN',
  apps: 'Uygulamalar',
};
export const sourceLabel = (s: string) => SOURCE_LABEL[(s || '').split(':')[0]] || s || 'Sistem';

// Bildirimin ilgili sayfası (ayrıntı penceresindeki "git" düğmesi). Kaynak backend'deki recordEvent / sağlık denetimi
// adıdır; servis uyarıları "service:<ad>[:<arayüz>]". Ağ modu (netmode) olayları birden çok sayfayı ilgilendirir: bağlantı yok.
// 'notify' (dış bildirim kanalı uyarısı) bağlantısız: zaten Bildirimler'de; metni "Dış kanallar" sekmesini söyler.
const SOURCE_TAB: Record<string, TabId> = {
  'netmode-bak': 'roles', 'netmode-bak-health': 'roles', 'netmode-wan': 'roles', 'netmode-rep': 'roles', 'netmode-home': 'roles',
  firewall: 'firewall', fail2ban: 'fail2ban', 'routing-list': 'routing', 'vps-tunnel': 'vps', 'device-new': 'devicecontrol',
  pcap: 'nettools', geo: 'geo',
  cpu: 'dashboard', memory: 'dashboard', disk: 'dashboard', network: 'dashboard', dns: 'unbound',
  dhcp: 'dhcp', 'dhcp-rogue': 'dhcp', 'dhcp-probe': 'dhcp', unbound: 'unbound', zapret: 'zapret', pihole: 'pihole',
  vps: 'vps', vpn: 'vps', device: 'devicecontrol', update: 'maintenance', cron: 'maintenance', mesh: 'roles',
  storage: 'storage', bandwidth: 'bandwidth', backup: 'backup', vault: 'backup', sync: 'backup', visits: 'visits',
  hotplug: 'roles',
  'wan-monitor': 'speedtest',
  calendar: 'agenda',
  license: 'license',
  templates: 'templates',
  fleet: 'fleet',
  sdwan: 'sdwan',
  apps: 'apps',
};
const SERVICE_TAB: Record<string, TabId> = {
  pihole: 'pihole', unbound: 'unbound', zapret: 'zapret', fail2ban: 'fail2ban', nftables: 'firewall', wireguard: 'vps',
};
export function alertTab(source: string): TabId | null {
  const [head, name] = (source || '').split(':');
  return (head === 'service' ? SERVICE_TAB[name] : SOURCE_TAB[head]) || null;
}
// Sayfanın alt sekmesi (Hız Testi → Hat Kalitesi): "git" düğmesi sayfayı o sekmede açar. Sayfanın hatırladığı sekme yazılır
// (sayfa yeni açılıyorsa) ve olay yayınlanır (sayfa zaten açıksa hash değişmez).
export const SPEEDTEST_TAB_KEY = 'pi5-speedtest-tab';
export const SPEEDTEST_TAB_EVENT = 'pi5-speedtest-tab';
export function openAlertSubTab(source: string): void {
  const head = (source || '').split(':')[0];
  // Paket kaydı olayı → Ağ Araçları'nın Paket Kaydı sekmesi (pcapLink.ts: sayfa açılınca bir kez okunur; zaten açıksa olayla)
  if (head === 'pcap') {
    if (window.location.hash !== '#nettools') { try { sessionStorage.setItem(NETTOOLS_TAB_KEY, 'pcap'); } catch { /* depolama yok */ } }
    else window.dispatchEvent(new CustomEvent(NETTOOLS_TAB_EVENT, { detail: 'pcap' }));
    return;
  }
  if (head !== 'wan-monitor') return;
  try { localStorage.setItem(SPEEDTEST_TAB_KEY, 'quality'); } catch { /* depolama yok */ }
  window.dispatchEvent(new CustomEvent(SPEEDTEST_TAB_EVENT, { detail: 'quality' }));
}

export const parseAlertTime = (s: string) => new Date(s.replace(' ', 'T') + 'Z'); // SQLite CURRENT_TIMESTAMP = UTC

// "29 Eylül 2026 Pazartesi 07:12"
export const fullTime = (d: Date) =>
  `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })} ${d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;

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

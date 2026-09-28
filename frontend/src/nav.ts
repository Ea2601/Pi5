import {
  LayoutDashboard, Network, Route, Terminal, Server,
  ShieldBan, Zap, Flame, Globe, ShieldAlert, BookOpen,
  Activity, Search, Gauge, Bell, Wrench, Users, Sliders,
  Database, Settings, MonitorSmartphone, TerminalSquare, Lightbulb, Monitor, Radio,
  type LucideIcon,
} from 'lucide-react';
import type { TabId } from './types';

// Menü tanımı — Sidebar (menü), Topbar (telefonda sayfa adı) ve App (adres çubuğundaki #sekme) aynı listeyi kullanır.
// sub: bir üstteki öğenin alt sayfası (menüde girintili gösterilir).
export interface NavTab {
  id: TabId;
  label: string;
  icon: LucideIcon;
  group?: string;
  sub?: boolean;
}

export const NAV_TABS: NavTab[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'topology', label: 'Ağ Haritası', icon: Network, group: 'Ağ Yönetimi' },
  { id: 'routing', label: 'Routing', icon: Route },
  { id: 'bandwidth', label: 'Bant Genisligi', icon: Activity },
  { id: 'dnslog', label: 'DNS Sorgu Logu', icon: Search },
  { id: 'speedtest', label: 'Hız Testi', icon: Gauge },
  { id: 'ddns', label: 'DDNS', icon: Globe },
  { id: 'pihole', label: 'Pi-hole DNS', icon: ShieldBan, group: 'Güvenlik' },
  { id: 'dhcp', label: 'DHCP Ayarları', icon: Radio, sub: true },
  { id: 'zapret', label: 'Zapret DPI', icon: Zap },
  { id: 'firewall', label: 'Firewall', icon: Flame },
  { id: 'unbound', label: 'Unbound DNS', icon: Globe },
  { id: 'fail2ban', label: 'Fail2Ban', icon: ShieldAlert },
  { id: 'parental', label: 'Ebeveyn Kontrol', icon: Users },
  { id: 'devicecontrol', label: 'Cihaz Yönetimi', icon: MonitorSmartphone, group: 'Cihaz & Trafik' },
  { id: 'trafficcontrol', label: 'Trafik Kontrol', icon: Sliders },
  { id: 'nettools', label: 'Ağ Araçları', icon: Wrench },
  { id: 'alerts', label: 'Bildirimler', icon: Bell },
  { id: 'vps', label: 'VPS WireGuard', icon: Server, group: 'Altyapı' },
  { id: 'maintenance', label: 'Sistem & Log', icon: Terminal },
  { id: 'terminal', label: 'SSH Terminal', icon: TerminalSquare },
  { id: 'casecontrol', label: 'Kasa LED', icon: Lightbulb },
  { id: 'kiosk', label: 'HDMI Ekran', icon: Monitor },
  { id: 'backup', label: 'Yedekleme', icon: Database },
  { id: 'settings', label: 'Ayarlar', icon: Settings },
  { id: 'docs', label: 'Dokümantasyon', icon: BookOpen, group: 'Yardım' },
];

const TAB_IDS = new Set<string>(NAV_TABS.map(t => t.id));

// Adres çubuğundaki #sekme (ör. http://192.168.0.1/#dhcp) → sekme; boş ya da tanınmayan değer Dashboard açar.
export function tabFromHash(hash: string): TabId {
  let id = hash.replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch { /* bozuk kodlama: olduğu gibi */ }
  return TAB_IDS.has(id) ? (id as TabId) : 'dashboard';
}

export function tabLabel(id: TabId): string {
  return NAV_TABS.find(t => t.id === id)?.label ?? '';
}

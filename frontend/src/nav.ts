import {
  LayoutDashboard, Network, Route, Terminal, Server,
  ShieldBan, Zap, Flame, Globe, ShieldAlert, BookOpen,
  Activity, Search, Gauge, Bell, Wrench, Users, Sliders,
  Database, Settings, MonitorSmartphone, TerminalSquare, Lightbulb, Monitor, Radio, Layers, HardDrive,
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
  // Yalnız ana cihazda anlamlı (ağ geçidi, DNS, DHCP, yönlendirme): mesh uydusunda (R2) menüde gösterilmez.
  mainOnly?: boolean;
}

export const NAV_TABS: NavTab[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'topology', label: 'Ağ Haritası', icon: Network, group: 'Ağ Yönetimi', mainOnly: true },
  { id: 'routing', label: 'Routing', icon: Route, mainOnly: true },
  { id: 'bandwidth', label: 'Bant Genisligi', icon: Activity, mainOnly: true },
  { id: 'dnslog', label: 'DNS Sorgu Logu', icon: Search, mainOnly: true },
  { id: 'speedtest', label: 'Hız Testi', icon: Gauge },
  { id: 'ddns', label: 'DDNS', icon: Globe, mainOnly: true },
  { id: 'pihole', label: 'Pi-hole DNS', icon: ShieldBan, group: 'Güvenlik', mainOnly: true },
  { id: 'dhcp', label: 'DHCP Ayarları', icon: Radio, mainOnly: true },
  { id: 'zapret', label: 'Zapret DPI', icon: Zap, mainOnly: true },
  { id: 'firewall', label: 'Firewall', icon: Flame, mainOnly: true },
  { id: 'unbound', label: 'Unbound DNS', icon: Globe, mainOnly: true },
  { id: 'fail2ban', label: 'Fail2Ban', icon: ShieldAlert, mainOnly: true },
  { id: 'parental', label: 'Ebeveyn Kontrol', icon: Users, mainOnly: true },
  { id: 'devicecontrol', label: 'Cihaz Yönetimi', icon: MonitorSmartphone, group: 'Cihaz & Trafik', mainOnly: true },
  { id: 'trafficcontrol', label: 'Trafik Kontrol', icon: Sliders, mainOnly: true },
  { id: 'nettools', label: 'Ağ Araçları', icon: Wrench },
  { id: 'alerts', label: 'Bildirimler', icon: Bell },
  { id: 'vps', label: 'VPS WireGuard', icon: Server, group: 'Altyapı', mainOnly: true },
  { id: 'roles', label: 'Cihaz Rolleri', icon: Layers },
  { id: 'maintenance', label: 'Sistem & Log', icon: Terminal },
  { id: 'terminal', label: 'SSH Terminal', icon: TerminalSquare },
  { id: 'casecontrol', label: 'Kasa LED', icon: Lightbulb },
  { id: 'kiosk', label: 'HDMI Ekran', icon: Monitor },
  { id: 'storage', label: 'Depolama', icon: HardDrive },
  { id: 'backup', label: 'Yedekleme', icon: Database },
  { id: 'settings', label: 'Ayarlar', icon: Settings },
  { id: 'docs', label: 'Dokümantasyon', icon: BookOpen, group: 'Yardım' },
];

const TAB_IDS = new Set<string>(NAV_TABS.map(t => t.id));

export type DeviceRole = 'main' | 'satellite';
// Rolün menüsü: uyduda ağ geçidi sayfaları gizli.
export const navTabsFor = (role: DeviceRole): NavTab[] => (role === 'satellite' ? NAV_TABS.filter(t => !t.mainOnly) : NAV_TABS);
export const isMainOnly = (id: TabId): boolean => !!NAV_TABS.find(t => t.id === id)?.mainOnly;

// Adres çubuğundaki #sekme (ör. http://192.168.0.1/#dhcp) → sekme; boş ya da tanınmayan değer Dashboard açar.
export function tabFromHash(hash: string): TabId {
  let id = hash.replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch { /* bozuk kodlama: olduğu gibi */ }
  return TAB_IDS.has(id) ? (id as TabId) : 'dashboard';
}

// Son açık sayfa tarayıcıda hatırlanır: adres çubuğunda #sekme yoksa (yer imi, elle yazılan adres) oradan devam edilir.
// localStorage kapalı/erişilemezse (gizli pencere vb.) sessizce Dashboard'a düşer.
const LAST_TAB_KEY = 'lastTab';

export function initialTab(): TabId {
  if (window.location.hash.replace(/^#/, '')) return tabFromHash(window.location.hash);
  try {
    const saved = localStorage.getItem(LAST_TAB_KEY);
    if (saved && TAB_IDS.has(saved)) return saved as TabId;
  } catch { /* depolama erişilemez */ }
  return 'dashboard';
}

export function rememberTab(tab: TabId): void {
  try { localStorage.setItem(LAST_TAB_KEY, tab); } catch { /* depolama erişilemez */ }
}

export function tabLabel(id: TabId): string {
  return NAV_TABS.find(t => t.id === id)?.label ?? '';
}

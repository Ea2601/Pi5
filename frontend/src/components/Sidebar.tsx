import {
  Shield, LayoutDashboard, Network, Route, Terminal, Server,
  ShieldBan, Zap, Flame, Globe, ShieldAlert, BookOpen,
  Activity, Search, Gauge, Bell, Wrench, Users, Sliders,
  Database, Settings, MonitorSmartphone, TerminalSquare, Lightbulb, Monitor
} from 'lucide-react';
import type { TabId } from '../types';

const tabs: { id: TabId; label: string; icon: React.ReactNode; group?: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={17} /> },
  { id: 'topology', label: 'Ağ Haritası', icon: <Network size={17} />, group: 'Ağ Yönetimi' },
  { id: 'routing', label: 'Routing', icon: <Route size={17} /> },
  { id: 'bandwidth', label: 'Bant Genisligi', icon: <Activity size={17} /> },
  { id: 'dnslog', label: 'DNS Sorgu Logu', icon: <Search size={17} /> },
  { id: 'speedtest', label: 'Hız Testi', icon: <Gauge size={17} /> },
  { id: 'ddns', label: 'DDNS', icon: <Globe size={17} /> },
  { id: 'pihole', label: 'Pi-hole DNS', icon: <ShieldBan size={17} />, group: 'Güvenlik' },
  { id: 'zapret', label: 'Zapret DPI', icon: <Zap size={17} /> },
  { id: 'firewall', label: 'Firewall', icon: <Flame size={17} /> },
  { id: 'unbound', label: 'Unbound DNS', icon: <Globe size={17} /> },
  { id: 'fail2ban', label: 'Fail2Ban', icon: <ShieldAlert size={17} /> },
  { id: 'parental', label: 'Ebeveyn Kontrol', icon: <Users size={17} /> },
  { id: 'devicecontrol', label: 'Cihaz Yönetimi', icon: <MonitorSmartphone size={17} />, group: 'Cihaz & Trafik' },
  { id: 'trafficcontrol', label: 'Trafik Kontrol', icon: <Sliders size={17} /> },
  { id: 'nettools', label: 'Ağ Araçları', icon: <Wrench size={17} /> },
  { id: 'alerts', label: 'Bildirimler', icon: <Bell size={17} /> },
  { id: 'vps', label: 'VPS WireGuard', icon: <Server size={17} />, group: 'Altyapı' },
  { id: 'maintenance', label: 'Sistem & Log', icon: <Terminal size={17} /> },
  { id: 'terminal', label: 'SSH Terminal', icon: <TerminalSquare size={17} /> },
  { id: 'casecontrol', label: 'Kasa LED', icon: <Lightbulb size={17} /> },
  { id: 'kiosk', label: 'HDMI Ekran', icon: <Monitor size={17} /> },
  { id: 'backup', label: 'Yedekleme', icon: <Database size={17} /> },
  { id: 'settings', label: 'Ayarlar', icon: <Settings size={17} /> },
  { id: 'docs', label: 'Dokümantasyon', icon: <BookOpen size={17} />, group: 'Yardım' },
];

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  let lastGroup = '';
  return (
    <nav className="glass-panel sidebar">
      <div className="logo">
        <div className="logo-shield"><Shield size={22} /></div>
        <div><h2>Pi5 Secure</h2><span className="logo-sub">Gateway Control</span></div>
      </div>
      <ul className="nav-links">
        {tabs.map(tab => {
          const showGroup = tab.group && tab.group !== lastGroup;
          if (tab.group) lastGroup = tab.group;
          return (
            <li key={tab.id}>
              {showGroup && <span className="nav-group">{tab.group}</span>}
              <button className={`nav-item ${activeTab === tab.id ? 'active' : ''}`} onClick={() => onTabChange(tab.id)}>
                {tab.icon}<span>{tab.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sidebar-footer"><div className="version-badge">Pi5 Router v2.1</div></div>
    </nav>
  );
}

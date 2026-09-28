import { useState, useEffect, useCallback } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Dashboard } from './components/Dashboard';
import { NetworkTopology } from './components/NetworkTopology';
import { PiholePanel } from './components/PiholePanel';
import { DhcpPanel } from './components/DhcpPanel';
import { ZapretPanel } from './components/ZapretPanel';
import { FirewallPanel } from './components/FirewallPanel';
import { RoutingPanel } from './components/RoutingPanel';
import { VpsSetup } from './components/VpsSetup';
import { UnboundPanel } from './components/UnboundPanel';
import { Fail2banPanel } from './components/Fail2banPanel';
import { SystemLogs } from './components/SystemLogs';
import { DocsPanel } from './components/DocsPanel';
import { BandwidthPanel } from './components/BandwidthPanel';
import { DnsQueryLog } from './components/DnsQueryLog';
import { SpeedTestPanel } from './components/SpeedTestPanel';
import { AlertsPanel } from './components/AlertsPanel';
import { NetworkToolsPanel } from './components/NetworkToolsPanel';
import { ParentalPanel } from './components/ParentalPanel';
import { DeviceControlPanel } from './components/DeviceControlPanel';
import { TrafficControlPanel } from './components/TrafficControlPanel';
import { BackupPanel } from './components/BackupPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SshTerminal } from './components/SshTerminal';
import { DdnsPanel } from './components/DdnsPanel';
import { CaseControlPanel } from './components/CaseControlPanel';
import { KioskSettingsPanel } from './components/KioskSettingsPanel';
import { PanelAuthBanner } from './components/PanelAuthBanner';
import type { TabId } from './types';
import { tabFromHash, tabLabel } from './nav';
import { seedThemeFromBackend } from './theme';
import { Toaster } from './toast';
import './index.css';
import './App.css';

function App() {
  // Açılış sekmesi adres çubuğundan: http://<pi>/#dhcp doğrudan DHCP sayfasını açar, yenileyince aynı sayfada kalınır.
  const [activeTab, setActiveTab] = useState<TabId>(() => tabFromHash(window.location.hash));
  const [navOpen, setNavOpen] = useState(false);

  // Sekme değişince: menü çekmecesi kapanır, adres #sekme olur (geçmişe kayıt eklemeden), sayfa başa döner.
  const goTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setNavOpen(false);
    const hash = tab === 'dashboard' ? '' : `#${tab}`;
    if (window.location.hash !== hash) {
      history.replaceState(null, '', hash || window.location.pathname + window.location.search);
    }
  }, []);

  // Sayfa içi bağlantılar (ör. Pi-hole → "DHCP Ayarları") ve elle yazılan #sekme
  useEffect(() => {
    const onHash = () => { setActiveTab(tabFromHash(window.location.hash)); setNavOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Telefonda içerik sayfanın kendisiyle kayar: yeni sekme en baştan açılsın.
  useEffect(() => { window.scrollTo(0, 0); }, [activeTab]);

  // Çekmece açıkken arka sayfa kaymaz; Esc kapatır.
  useEffect(() => {
    if (!navOpen) return;
    document.body.classList.add('nav-open');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.classList.remove('nav-open'); window.removeEventListener('keydown', onKey); };
  }, [navOpen]);

  // Load saved accent on start; theme localStorage'dan (main.tsx) gelir, yoksa backend'den tohumla
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        const s = data.settings || {};
        // Tema: localStorage birincil; localStorage boşsa backend değerini uygula + tohumla
        seedThemeFromBackend(s.theme);
        // Accent color
        const accent = s.accent_color || 'blue';
        if (accent !== 'blue') {
          document.documentElement.classList.add(`accent-${accent}`);
        }
      })
      .catch(() => {});
  }, []);

  const renderTab = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard />;
      case 'topology': return <NetworkTopology />;
      case 'routing': return <RoutingPanel />;
      case 'pihole': return <PiholePanel />;
      case 'dhcp': return <DhcpPanel />;
      case 'zapret': return <ZapretPanel />;
      case 'firewall': return <FirewallPanel />;
      case 'unbound': return <UnboundPanel />;
      case 'fail2ban': return <Fail2banPanel />;
      case 'vps': return <VpsSetup />;
      case 'maintenance': return <SystemLogs />;
      case 'docs': return <DocsPanel />;
      case 'bandwidth': return <BandwidthPanel />;
      case 'dnslog': return <DnsQueryLog />;
      case 'speedtest': return <SpeedTestPanel />;
      case 'ddns': return <DdnsPanel />;
      case 'alerts': return <AlertsPanel />;
      case 'nettools': return <NetworkToolsPanel />;
      case 'parental': return <ParentalPanel />;
      case 'devicecontrol': return <DeviceControlPanel />;
      case 'trafficcontrol': return <TrafficControlPanel />;
      case 'casecontrol': return <CaseControlPanel />;
      case 'kiosk': return <KioskSettingsPanel />;
      case 'backup': return <BackupPanel />;
      case 'settings': return <SettingsPanel />;
      case 'terminal': return <SshTerminal />;
    }
  };

  return (
    <ErrorBoundary>
      <div className="app-container">
        <Sidebar activeTab={activeTab} onTabChange={goTab} open={navOpen} onClose={() => setNavOpen(false)} />
        <main className="main-content">
          <Topbar
            onShowAlerts={() => goTab('alerts')}
            onMenu={() => setNavOpen(true)}
            menuOpen={navOpen}
            title={tabLabel(activeTab)}
          />
          <PanelAuthBanner />
          <div className="dashboard-content" key={activeTab}>
            <ErrorBoundary>
              {renderTab()}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <Toaster />
    </ErrorBoundary>
  );
}

export default App;

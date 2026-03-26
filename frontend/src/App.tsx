import { useState, useEffect } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Dashboard } from './components/Dashboard';
import { NetworkTopology } from './components/NetworkTopology';
import { PiholePanel } from './components/PiholePanel';
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
import { DeviceServicesPanel } from './components/DeviceServicesPanel';
import { BackupPanel } from './components/BackupPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SshTerminal } from './components/SshTerminal';
import { DdnsPanel } from './components/DdnsPanel';
import { CaseControlPanel } from './components/CaseControlPanel';
import { KioskSettingsPanel } from './components/KioskSettingsPanel';
import type { TabId } from './types';
import './index.css';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');

  // Load and apply saved theme/accent on app start
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        const s = data.settings || {};
        // Theme
        if (s.theme === 'light') {
          document.documentElement.classList.add('light-theme');
        }
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
      case 'deviceservices': return <DeviceServicesPanel />;
      case 'casecontrol': return <CaseControlPanel />;
      case 'kiosk': return <KioskSettingsPanel />;
      case 'backup': return <BackupPanel />;
      case 'settings': return <SettingsPanel />;
      case 'terminal': return <SshTerminal />;
    }
  };

  return (
    <div className="app-container">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      <main className="main-content">
        <Topbar />
        <div className="dashboard-content" key={activeTab}>
          <ErrorBoundary>
            {renderTab()}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

export default App;

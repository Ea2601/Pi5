import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { StoragePanel } from './components/StoragePanel';
import { PanelAuthBanner } from './components/PanelAuthBanner';
import { LoginScreen } from './components/LoginScreen';
import { NetworkBackdrop } from './components/NetworkBackdrop';
import { RolesPanel } from './components/RolesPanel';
import { LiveVersionNotice } from './components/LiveVersionNotice';
import { AUTH_REQUIRED_EVENT, fetchAuthStatus, logout, type AuthStatus } from './auth';
import type { TabId } from './types';
import { tabFromHash, tabLabel, initialTab, rememberTab, navTabsFor, isMainOnly, type DeviceRole } from './nav';
import { seedThemeFromBackend } from './theme';
import { Toaster } from './toast';
import './index.css';
import './App.css';

function App() {
  // Açılış sekmesi: adres çubuğundaki #sekme (http://<pi>/#dhcp doğrudan DHCP'yi açar), yoksa tarayıcının hatırladığı
  // son sayfa, o da yoksa Dashboard.
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [navOpen, setNavOpen] = useState(false);
  // Giriş ekranı (panel-auth "mode form"): undefined = durum soruluyor, null = eski arka uç / ulaşılamadı (panel açılır).
  const [auth, setAuth] = useState<AuthStatus | null | undefined>(undefined);
  const [needLogin, setNeedLogin] = useState(false);
  // Girişten sonra panel baştan kurulur (bütün veriler oturumla yeniden istenir).
  const [session, setSession] = useState(0);
  // Cihaz rolü (R2): mesh uydusunda menü sadeleşir (ağ geçidi sayfaları gizli). Eski arka uç / hata → ana cihaz.
  const [role, setRole] = useState<DeviceRole>('main');
  useEffect(() => {
    let alive = true;
    fetch('/api/system/role').then(r => (r.ok ? r.json() : null)).then(d => {
      if (alive && d?.role === 'satellite') setRole('satellite');
    }).catch(() => {});
    return () => { alive = false; };
  }, [session]);
  const navTabs = useMemo(() => navTabsFor(role), [role]);

  useEffect(() => {
    let alive = true;
    void fetchAuthStatus().then(st => {
      if (!alive) return;
      setAuth(st);
      if (st?.mode === 'form' && !st.authenticated) setNeedLogin(true);
    });
    // Durum 2 sn'de gelmezse panel açılır (giriş gerekiyorsa ilk API yanıtı giriş ekranını getirir).
    const fallback = setTimeout(() => { if (alive) setAuth(a => (a === undefined ? null : a)); }, 2000);
    const onRequired = () => setNeedLogin(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => { alive = false; clearTimeout(fallback); window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired); };
  }, []);

  const onLoggedIn = useCallback(async () => {
    setAuth(await fetchAuthStatus());
    setNeedLogin(false);
    setSession(n => n + 1);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setNavOpen(false);
    setNeedLogin(true);
  }, []);
  // Çıkış yalnız giriş ekranı modunda anlamlı (şifre penceresinde tarayıcı kimliği unutmaz; Pi'nin kendi ekranı muaf).
  const canLogout = auth?.mode === 'form' && !auth.loopback;

  // Sekme seçilince menü çekmecesi kapanır.
  const goTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setNavOpen(false);
  }, []);

  // Açık sayfa hatırlanır ve adres #sekme olur (geçmişe kayıt eklemeden): yenileyince ya da yeniden açınca aynı sayfa.
  useEffect(() => {
    rememberTab(activeTab);
    const hash = activeTab === 'dashboard' ? '' : `#${activeTab}`;
    if (window.location.hash !== hash) {
      history.replaceState(null, '', hash || window.location.pathname + window.location.search);
    }
  }, [activeTab]);

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
        // Gri = marka rengi = sınıfsız varsayılan (eski kayıtlı 'blue' backend'de bir kez 'gray'e çevrildi)
        const accent = s.accent_color || 'gray';
        if (accent !== 'gray') {
          document.documentElement.classList.add(`accent-${accent}`);
        }
      })
      .catch(() => {});
  }, [session]);

  const renderTab = () => {
    // Uyduda ağ geçidi sayfası (eski yer imi / elle yazılan #sekme): sayfa ana cihazda.
    if (role === 'satellite' && isMainOnly(activeTab)) {
      return (
        <div className="glass-panel sat-notice">
          <strong>Bu cihaz mesh uydusu</strong>
          <span>"{tabLabel(activeTab)}" ana cihazda yönetilir — uydu yalnız ana cihazın Wi-Fi'ını yayınlar.</span>
          <button className="btn-outline btn-sm" onClick={() => goTab('roles')}>Cihaz Rolleri → Uydular</button>
        </div>
      );
    }
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
      case 'roles': return <RolesPanel />;
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
      case 'storage': return <StoragePanel />;
      case 'backup': return <BackupPanel />;
      case 'settings': return <SettingsPanel />;
      case 'terminal': return <SshTerminal />;
    }
  };

  if (auth === undefined) return <div className="auth-splash" />;
  // Hata sınırı giriş ekranı / panel oturumu değişince sıfırlanır (panelde kalmış bir hata ekranı girişi örtmesin).
  if (needLogin) {
    return (
      <ErrorBoundary key="login">
        <LoginScreen onSuccess={onLoggedIn} />
        <Toaster />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary key={`app-${session}`}>
      <NetworkBackdrop variant="panel" />
      <div className="app-container">
        <Sidebar activeTab={activeTab} onTabChange={goTab} open={navOpen} onClose={() => setNavOpen(false)}
          onLogout={canLogout ? handleLogout : undefined} tabs={navTabs} />
        <main className="main-content">
          <Topbar
            onShowAlerts={() => goTab('alerts')}
            onMenu={() => setNavOpen(true)}
            menuOpen={navOpen}
            title={tabLabel(activeTab)}
            onLogout={canLogout ? handleLogout : undefined}
            userName={auth?.user}
          />
          <PanelAuthBanner />
          <div className="dashboard-content" key={activeTab}>
            <ErrorBoundary>
              {renderTab()}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <LiveVersionNotice />
      <Toaster />
    </ErrorBoundary>
  );
}

export default App;

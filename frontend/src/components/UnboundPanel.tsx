import { Globe, Server, Gauge, Shield, Settings, Activity, RefreshCw, Loader2 } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { ServiceStatus } from '../types';

type UnboundTab = 'overview' | 'settings';

interface SecurityCheck {
  label: string;
  status: boolean;
}

interface UnboundStatus {
  listenAddr: string;
  threads: string;
  cacheEntries: string;
  totalQueries: string;
  security: SecurityCheck[];
  error?: string;
}

export function UnboundPanel() {
  const [activeTab, setActiveTab] = useState<UnboundTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const { data: ubData, loading, refetch: refetchUb } = useApi<UnboundStatus>(
    '/unbound/status', { listenAddr: '-', threads: '-', cacheEntries: '-', totalQueries: '-', security: [] }
  );
  const unboundSvc = svcData.services.find(s => s.name === 'unbound');
  const isEnabled = unboundSvc?.enabled === 1;
  const [refreshing, setRefreshing] = useState(false);

  const handleToggle = async () => {
    try {
      await postApi('/services/toggle', { name: 'unbound', enabled: !isEnabled });
      await refetch();
    } catch { /* */ }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchUb();
    setRefreshing(false);
  };

  const tabs: { id: UnboundTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <Activity size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    server: 'Sunucu Ayarları',
    performance: 'Performans & Önbellek',
    security: 'Güvenlik Sıkılaştırma',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    server: <Server size={15} />,
    performance: <Gauge size={15} />,
    security: <Shield size={15} />,
  };

  return (
    <div className="fade-in">
      <Panel title="Unbound Recursive DNS" icon={<Globe size={20} style={{ marginRight: 8 }} />}
        subtitle="Özyinelemeli DNS çözücü — Pi-hole ile entegre, gizlilik odaklı"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn-outline btn-sm" onClick={handleRefresh} disabled={refreshing} title="Yenile">
              {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            </button>
            <button className={`toggle-btn ${isEnabled ? 'toggle-on' : 'toggle-off'}`} onClick={handleToggle} title={isEnabled ? 'Durdur' : 'Başlat'}>
              <div className="toggle-knob" />
            </button>
          </div>
        }>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'overview' && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<Globe size={20} />} label="Dinleme" value={loading ? '...' : ubData.listenAddr} color="blue" />
            <StatCard icon={<Shield size={20} />} label="Toplam Sorgu" value={loading ? '...' : ubData.totalQueries} color="green" />
            <StatCard icon={<Gauge size={20} />} label="Önbellek" value={loading ? '...' : `${ubData.cacheEntries} kayıt`} color="purple" />
            <StatCard icon={<Server size={20} />} label="Thread" value={loading ? '...' : ubData.threads} color="cyan" />
          </div>
          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="Nasıl Çalışır?" size="medium">
              <div className="info-list">
                <div className="info-item">
                  <span className="info-num">1</span>
                  <div><strong>Pi-hole → Unbound</strong><p>Pi-hole DNS sorgularını {ubData.listenAddr}'e yönlendirir</p></div>
                </div>
                <div className="info-item">
                  <span className="info-num">2</span>
                  <div><strong>Özyinelemeli Çözümleme</strong><p>Unbound root DNS sunucularından başlayarak sorguyu çözer</p></div>
                </div>
                <div className="info-item">
                  <span className="info-num">3</span>
                  <div><strong>Önbellekleme</strong><p>Sonuçlar yerel olarak önbelleklenir, tekrar sorgu gerektirmez</p></div>
                </div>
                <div className="info-item">
                  <span className="info-num">4</span>
                  <div><strong>Gizlilik</strong><p>Hiçbir üçüncü taraf DNS sağlayıcısına bağımlılık yoktur</p></div>
                </div>
              </div>
            </Panel>
            <Panel title="Güvenlik Durumu" size="medium">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}><Loader2 size={20} className="spin" /></div>
              ) : ubData.security.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>
                  {isEnabled ? 'Güvenlik bilgisi alınamadı' : 'Unbound pasif'}
                </div>
              ) : (
                <div className="security-checks">
                  {ubData.security.map(check => (
                    <div key={check.label} className="security-check-row">
                      <span className={`svc-dot ${check.status ? 'svc-on' : 'svc-off'}`} />
                      <span>{check.label}</span>
                      <Badge variant={check.status ? 'success' : 'neutral'}>{check.status ? 'Aktif' : 'Pasif'}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="unbound" categoryLabels={categoryLabels} categoryIcons={categoryIcons} />
        </div>
      )}
    </div>
  );
}

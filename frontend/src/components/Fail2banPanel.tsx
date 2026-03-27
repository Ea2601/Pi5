import { ShieldAlert, Settings, Activity, Lock, Ban, Users, AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { ServiceStatus } from '../types';

type F2bTab = 'overview' | 'settings';

interface Jail {
  name: string;
  currentlyBanned: number;
  totalBanned: number;
  bannedIps: string[];
}

interface RecentBan {
  ip: string;
  jail: string;
  time: string;
}

export function Fail2banPanel() {
  const [activeTab, setActiveTab] = useState<F2bTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const { data: f2bData, loading, refetch: refetchF2b } = useApi<{ jails: Jail[]; recentBans: RecentBan[] }>(
    '/fail2ban/status', { jails: [], recentBans: [] }
  );
  const f2bSvc = svcData.services.find(s => s.name === 'fail2ban');
  const isEnabled = f2bSvc?.enabled === 1;
  const [refreshing, setRefreshing] = useState(false);

  const handleToggle = async () => {
    try {
      await postApi('/services/toggle', { name: 'fail2ban', enabled: !isEnabled });
      await refetch();
    } catch { /* */ }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchF2b();
    setRefreshing(false);
  };

  const tabs: { id: F2bTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <Activity size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    default: 'Varsayılan Ayarlar',
    sshd: 'SSH Koruması',
    webserver: 'Web Sunucu Koruması',
    recidive: 'Tekrar Cezası (Recidive)',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    default: <Settings size={15} />,
    sshd: <Lock size={15} />,
    webserver: <ShieldAlert size={15} />,
    recidive: <AlertTriangle size={15} />,
  };

  const jails = f2bData.jails || [];
  const recentBans = f2bData.recentBans || [];
  const totalBanned = jails.reduce((sum, j) => sum + j.currentlyBanned, 0);
  const totalAllTime = jails.reduce((sum, j) => sum + j.totalBanned, 0);
  const activeJails = jails.length;

  return (
    <div className="fade-in">
      <Panel title="Fail2Ban Saldırı Koruması" icon={<ShieldAlert size={20} style={{ marginRight: 8 }} />}
        subtitle="SSH brute-force ve servis saldırılarına karşı otomatik IP engelleme"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn-outline btn-sm" onClick={handleRefresh} disabled={refreshing} title="Yenile">
              {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            </button>
            <button
              className={`toggle-btn ${isEnabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={handleToggle}
              title={isEnabled ? 'Durdur' : 'Başlat'}
            >
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
            <StatCard icon={<Ban size={20} />} label="Aktif Ban" value={loading ? '...' : String(totalBanned)} color="orange" />
            <StatCard icon={<ShieldAlert size={20} />} label="Toplam Ban" value={loading ? '...' : String(totalAllTime)} color="blue" />
            <StatCard icon={<Lock size={20} />} label="Aktif Jail" value={loading ? '...' : String(activeJails)} color="green" />
            <StatCard icon={<Users size={20} />} label="Son Engelleme" value={loading ? '...' : String(recentBans.length)} color="purple" />
          </div>

          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="Jail Durumları" size="medium">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}><Loader2 size={20} className="spin" /></div>
              ) : jails.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>
                  {isEnabled ? 'Aktif jail bulunamadı' : 'Fail2Ban pasif'}
                </div>
              ) : (
                <div className="jail-list">
                  {jails.map(jail => (
                    <div key={jail.name} className="jail-row">
                      <span className="svc-dot svc-on" />
                      <div className="jail-info">
                        <strong>{jail.name}</strong>
                        <span className="jail-stats">
                          {jail.currentlyBanned > 0 && <Badge variant="error">{jail.currentlyBanned} banned</Badge>}
                          <span className="text-muted">Toplam: {jail.totalBanned}</span>
                        </span>
                      </div>
                      {jail.bannedIps.length > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {jail.bannedIps.slice(0, 3).join(', ')}{jail.bannedIps.length > 3 ? ` +${jail.bannedIps.length - 3}` : ''}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Son Engellenen IP'ler" size="medium">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}><Loader2 size={20} className="spin" /></div>
              ) : recentBans.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>
                  Henüz engelleme kaydı yok
                </div>
              ) : (
                <div className="ban-list">
                  {recentBans.map((ban, i) => (
                    <div key={i} className="ban-row">
                      <span className="ban-ip">{ban.ip}</span>
                      <Badge variant={ban.jail === 'recidive' ? 'error' : 'info'}>{ban.jail}</Badge>
                      <span className="ban-time">{ban.time}</span>
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
          <ServiceSettings service="fail2ban" categoryLabels={categoryLabels} categoryIcons={categoryIcons} />
        </div>
      )}
    </div>
  );
}

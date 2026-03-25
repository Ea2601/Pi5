import { ShieldAlert, Play, Square, Settings, Activity, Lock, Ban, Users, AlertTriangle } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { ServiceStatus } from '../types';

type F2bTab = 'overview' | 'settings';

export function Fail2banPanel() {
  const [activeTab, setActiveTab] = useState<F2bTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const f2bSvc = svcData.services.find(s => s.name === 'fail2ban');
  const isEnabled = f2bSvc?.enabled === 1;

  const handleToggle = async () => {
    try {
      await postApi('/services/toggle', { name: 'fail2ban', enabled: !isEnabled });
      await refetch();
    } catch { /* */ }
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

  // Mock data for jail statuses
  const jails = [
    { name: 'sshd', active: true, banned: 3, totalBans: 47, lastBan: '2 saat önce' },
    { name: 'nginx-http-auth', active: false, banned: 0, totalBans: 12, lastBan: '3 gün önce' },
    { name: 'recidive', active: true, banned: 1, totalBans: 8, lastBan: '12 saat önce' },
  ];

  const recentBans = [
    { ip: '185.220.101.34', jail: 'sshd', time: '14:23', country: 'DE' },
    { ip: '45.148.10.92', jail: 'sshd', time: '12:01', country: 'RU' },
    { ip: '103.152.118.24', jail: 'recidive', time: '08:45', country: 'CN' },
    { ip: '192.241.216.17', jail: 'sshd', time: 'Dün 22:10', country: 'US' },
    { ip: '45.33.32.156', jail: 'sshd', time: 'Dün 18:30', country: 'US' },
  ];

  return (
    <div className="fade-in">
      <Panel title="Fail2Ban Saldırı Koruması" icon={<ShieldAlert size={20} style={{ marginRight: 8 }} />}
        subtitle="SSH brute-force ve servis saldırılarına karşı otomatik IP engelleme"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={
          <button className="icon-btn" onClick={handleToggle} title={isEnabled ? 'Durdur' : 'Başlat'}>
            {isEnabled ? <Square size={14} /> : <Play size={14} />}
          </button>
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
            <StatCard icon={<Ban size={20} />} label="Aktif Ban" value="4" color="orange" />
            <StatCard icon={<ShieldAlert size={20} />} label="Toplam Ban" value="67" color="blue" />
            <StatCard icon={<Lock size={20} />} label="Aktif Jail" value="2" color="green" />
            <StatCard icon={<Users size={20} />} label="Muaf IP" value="2" color="purple" />
          </div>

          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="Jail Durumları" size="medium">
              <div className="jail-list">
                {jails.map(jail => (
                  <div key={jail.name} className="jail-row">
                    <span className={`svc-dot ${jail.active ? 'svc-on' : 'svc-off'}`} />
                    <div className="jail-info">
                      <strong>{jail.name}</strong>
                      <span className="jail-stats">
                        {jail.banned > 0 && <Badge variant="error">{jail.banned} banned</Badge>}
                        <span className="text-muted">Toplam: {jail.totalBans}</span>
                      </span>
                    </div>
                    <span className="jail-last-ban">{jail.lastBan}</span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Son Engellenen IP'ler" size="medium">
              <div className="ban-list">
                {recentBans.map((ban, i) => (
                  <div key={i} className="ban-row">
                    <span className="ban-ip">{ban.ip}</span>
                    <Badge variant={ban.jail === 'recidive' ? 'error' : 'info'}>{ban.jail}</Badge>
                    <span className="ban-country">{ban.country}</span>
                    <span className="ban-time">{ban.time}</span>
                  </div>
                ))}
              </div>
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

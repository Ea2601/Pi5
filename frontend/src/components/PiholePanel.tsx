import { ShieldBan, Search, BarChart3, Globe, Users, ArrowRight, Settings, List, Plus, Trash2, Check, X, Server, Lock, Gauge, Radio } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { PiholeStats, ServiceStatus, PiholeListItem } from '../types';

type PiholeTab = 'overview' | 'settings' | 'blocklists' | 'whitelist' | 'blacklist' | 'localdns';

export function PiholePanel() {
  const [activeTab, setActiveTab] = useState<PiholeTab>('overview');
  const { data: stats } = useApi<PiholeStats>('/pihole/stats', {
    domainsBlocked: 0, dnsQueriesToday: 0, adsBlockedToday: 0,
    adsPercentageToday: 0, uniqueClients: 0, queriesForwarded: 0,
    queriesCached: 0, topBlockedDomains: [], queryTypes: {},
  }, 10000);
  const { data: svcData, refetch: refetchSvc } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const piholeSvc = svcData.services.find(s => s.name === 'pihole');
  const isEnabled = piholeSvc?.enabled === 1;
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState('');

  const handleToggle = async () => {
    setToggling(true);
    setToggleError('');
    try {
      const result = await postApi('/services/toggle', { name: 'pihole', enabled: !isEnabled });
      if (!result.success) {
        setToggleError(result.error || 'Servis değiştirilemedi');
      }
      await refetchSvc();
    } catch (e: any) {
      setToggleError(e.message || 'İstek başarısız');
    }
    setToggling(false);
  };

  const tabs: { id: PiholeTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <BarChart3 size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
    { id: 'blocklists', label: 'Bloklisteleri', icon: <ShieldBan size={14} /> },
    { id: 'whitelist', label: 'Beyaz Liste', icon: <Check size={14} /> },
    { id: 'blacklist', label: 'Kara Liste', icon: <X size={14} /> },
    { id: 'localdns', label: 'Yerel DNS', icon: <Globe size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    dns: 'DNS Ayarları',
    blocking: 'Engelleme',
    dhcp: 'DHCP Sunucu',
    privacy: 'Gizlilik & Kayıtlar',
    ratelimit: 'Hız Limitleme',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    dns: <Server size={15} />,
    blocking: <ShieldBan size={15} />,
    dhcp: <Radio size={15} />,
    privacy: <Lock size={15} />,
    ratelimit: <Gauge size={15} />,
  };

  return (
    <div className="fade-in">
      <Panel title="Pi-hole DNS Reklam Engelleme" icon={<ShieldBan size={20} style={{ marginRight: 8 }} />}
        subtitle="Headless Pi-hole + Unbound DNS — Reklam & tracker bloklama"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {toggleError && <span style={{ fontSize: 11, color: 'var(--danger-color)', maxWidth: 300 }}>{toggleError}</span>}
            <button className={isEnabled ? 'btn-outline btn-sm' : 'btn-primary btn-sm'} onClick={handleToggle} disabled={toggling}>
              {toggling ? 'İşleniyor...' : isEnabled ? 'Devre Dışı Bırak' : 'Etkinleştir'}
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
            <StatCard icon={<Globe size={20} />} label="Bloklistesi" value={stats.domainsBlocked.toLocaleString('tr-TR')} color="blue" />
            <StatCard icon={<Search size={20} />} label="DNS Sorguları" value={stats.dnsQueriesToday.toLocaleString('tr-TR')} color="green" />
            <StatCard icon={<ShieldBan size={20} />} label="Engellenen" value={stats.adsBlockedToday.toLocaleString('tr-TR')} color="orange" />
            <StatCard icon={<Users size={20} />} label="İstemciler" value={stats.uniqueClients} color="purple" />
          </div>
          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="En Çok Engellenen Domainler" size="medium">
              <div className="blocked-list">
                {stats.topBlockedDomains.map((item, i) => (
                  <div key={item.domain} className="blocked-item">
                    <span className="blocked-rank">#{i + 1}</span>
                    <span className="blocked-domain">{item.domain}</span>
                    <span className="blocked-count">{item.count.toLocaleString('tr-TR')}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Sorgu Dağılımı" icon={<BarChart3 size={16} style={{ marginRight: 6 }} />} size="medium">
              <div className="query-types">
                {Object.entries(stats.queryTypes).map(([type, pct]) => (
                  <div key={type} className="query-type-row">
                    <span className="qt-label">{type}</span>
                    <div className="progress-bar"><div className="progress-fill progress-cpu" style={{ width: `${pct}%` }} /></div>
                    <span className="qt-val">{pct}%</span>
                  </div>
                ))}
              </div>
              <div className="pihole-flow">
                <span>Forwarded: <strong>{stats.queriesForwarded.toLocaleString('tr-TR')}</strong></span>
                <ArrowRight size={14} />
                <span>Cached: <strong>{stats.queriesCached.toLocaleString('tr-TR')}</strong></span>
              </div>
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="pihole" categoryLabels={categoryLabels} categoryIcons={categoryIcons} />
        </div>
      )}

      {(activeTab === 'blocklists' || activeTab === 'whitelist' || activeTab === 'blacklist' || activeTab === 'localdns') && (
        <div style={{ marginTop: 14 }}>
          <PiholeListManager listType={activeTab === 'blocklists' ? 'adlist' : activeTab} />
        </div>
      )}
    </div>
  );
}

function PiholeListManager({ listType }: { listType: string }) {
  const { data, refetch } = useApi<{ lists: PiholeListItem[] }>('/pihole/lists', { lists: [] });
  const items = data.lists.filter(l => l.list_type === listType);
  const [newValue, setNewValue] = useState('');
  const [newComment, setNewComment] = useState('');
  const [adding, setAdding] = useState(false);

  const labels: Record<string, { title: string; placeholder: string; commentPh: string }> = {
    adlist: { title: 'Bloklisteleri', placeholder: 'https://example.com/hosts.txt', commentPh: 'Liste açıklaması' },
    whitelist: { title: 'Beyaz Liste (İzin Verilen)', placeholder: 'example.com', commentPh: 'Neden izin verildi?' },
    blacklist: { title: 'Kara Liste (Engellenen)', placeholder: 'tracking.example.com', commentPh: 'Neden engellendi?' },
    localdns: { title: 'Yerel DNS Kayıtları', placeholder: '192.168.1.100 myserver.lan', commentPh: 'Açıklama' },
  };

  const l = labels[listType] || labels.adlist;

  const handleAdd = async () => {
    if (!newValue.trim()) return;
    setAdding(true);
    try {
      await postApi('/pihole/lists', { list_type: listType, value: newValue.trim(), comment: newComment.trim() });
      setNewValue('');
      setNewComment('');
      await refetch();
    } catch { /* */ }
    setAdding(false);
  };

  const handleToggle = async (id: number, currentEnabled: number) => {
    await putApi(`/pihole/lists/${id}`, { enabled: currentEnabled ? 0 : 1 });
    await refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteApi(`/pihole/lists/${id}`);
    await refetch();
  };

  return (
    <Panel title={l.title} icon={<List size={18} style={{ marginRight: 8 }} />}>
      <div className="list-add-form">
        <div className="list-add-row">
          <input className="config-input list-input-main" type="text" placeholder={l.placeholder}
            value={newValue} onChange={e => setNewValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          <input className="config-input list-input-comment" type="text" placeholder={l.commentPh}
            value={newComment} onChange={e => setNewComment(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          <button className="btn-primary btn-sm" onClick={handleAdd} disabled={adding || !newValue.trim()}>
            <Plus size={14} /> Ekle
          </button>
        </div>
      </div>

      <div className="list-items">
        {items.length === 0 && <div className="empty-state" style={{ padding: '20px' }}>Bu listede henüz kayıt yok.</div>}
        {items.map(item => (
          <div key={item.id} className={`list-item ${!item.enabled ? 'list-item-disabled' : ''}`}>
            <button
              className={`toggle-btn toggle-sm ${item.enabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={() => handleToggle(item.id, item.enabled)}
            >
              <div className="toggle-knob" />
            </button>
            <div className="list-item-content">
              <span className="list-item-value">{item.value}</span>
              {item.comment && <span className="list-item-comment">{item.comment}</span>}
            </div>
            <button className="icon-btn icon-btn-sm list-delete" onClick={() => handleDelete(item.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </Panel>
  );
}

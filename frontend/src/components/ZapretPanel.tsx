import { Zap, Play, Square, Globe, Shield, Settings, List, Plus, Trash2, Search } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Badge, Alert } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { ServiceStatus, ZapretDomain } from '../types';

type ZapretTab = 'overview' | 'settings' | 'hostlist' | 'exclude';

export function ZapretPanel() {
  const [activeTab, setActiveTab] = useState<ZapretTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const zapretSvc = svcData.services.find(s => s.name === 'zapret');
  const isEnabled = zapretSvc?.enabled === 1;
  const [testDomain, setTestDomain] = useState('discord.com');
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const handleInstall = async () => {
    setInstalling(true); setResult(null);
    try {
      await postApi('/services/setup', { action: 'zapret', domain: testDomain });
      setResult({ type: 'success', msg: `Zapret DPI bypass ${testDomain} için yapılandırıldı.` });
      await refetch();
    } catch (e: any) { setResult({ type: 'error', msg: e.message }); }
    setInstalling(false);
  };

  const handleToggle = async () => {
    try { await postApi('/services/toggle', { name: 'zapret', enabled: !isEnabled }); await refetch(); } catch { /* */ }
  };

  const tabs: { id: ZapretTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <Zap size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
    { id: 'hostlist', label: 'Bypass Listesi', icon: <List size={14} /> },
    { id: 'exclude', label: 'Hariç Tutulanlar', icon: <Shield size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    general: 'Genel Ayarlar',
    nfqws: 'NFQWS Parametreleri',
    tproxy: 'TPROXY Ayarları',
    autohostlist: 'Otomatik Liste',
  };

  const bypassModes = [
    { name: 'NFQWS', desc: 'Netfilter Queue paket manipülasyonu', active: true },
    { name: 'TPROXY', desc: 'Transparent proxy yönlendirme', active: false },
    { name: 'Sing-box', desc: 'Gelişmiş protokol routing', active: false },
  ];

  return (
    <div className="fade-in">
      <Panel title="Zapret DPI Bypass Motoru" icon={<Zap size={20} style={{ marginRight: 8 }} />}
        subtitle="ISP DPI engellemelerini aşmak için nfqws paket manipülasyonu"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={<button className="icon-btn" onClick={handleToggle} title={isEnabled ? 'Durdur' : 'Başlat'}>{isEnabled ? <Square size={14} /> : <Play size={14} />}</button>}>
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
          <div style={{ marginTop: 14 }}>
            <Panel title="Bypass Modları">
              <div className="zapret-modes">
                {bypassModes.map(mode => (
                  <div key={mode.name} className={`zapret-mode ${mode.active ? 'zapret-mode-active' : ''}`}>
                    <div className="zapret-mode-header"><Shield size={16} /><strong>{mode.name}</strong>{mode.active && <Badge variant="success">Aktif</Badge>}</div>
                    <p>{mode.desc}</p>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <div style={{ marginTop: 14 }}>
            <Panel title="Blockcheck & Kurulum" subtitle="Belirli domain için DPI atlatma parametrelerini test et">
              <div className="form-group">
                <label><Globe size={14} /><span>Test Domaini</span></label>
                <input type="text" value={testDomain} onChange={e => setTestDomain(e.target.value)} placeholder="discord.com" disabled={installing} />
              </div>
              {result && <Alert type={result.type} message={result.msg} />}
              <button className="btn-primary btn-full" onClick={handleInstall} disabled={installing}>
                {installing ? 'Blockcheck çalışıyor...' : 'Blockcheck Başlat & Uygula'}
              </button>
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="zapret" categoryLabels={categoryLabels} />
        </div>
      )}

      {(activeTab === 'hostlist' || activeTab === 'exclude') && (
        <div style={{ marginTop: 14 }}>
          <ZapretDomainManager listType={activeTab} />
        </div>
      )}
    </div>
  );
}

function ZapretDomainManager({ listType }: { listType: string }) {
  const { data, refetch } = useApi<{ domains: ZapretDomain[] }>('/zapret/domains', { domains: [] });
  const items = data.domains.filter(d => d.list_type === listType);
  const [newDomain, setNewDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredItems = filter ? items.filter(d => d.domain.includes(filter)) : items;

  const handleAdd = async () => {
    if (!newDomain.trim()) return;
    setAdding(true);
    try {
      await postApi('/zapret/domains', { list_type: listType, domain: newDomain.trim() });
      setNewDomain('');
      await refetch();
    } catch { /* */ }
    setAdding(false);
  };

  const handleToggle = async (id: number, enabled: number) => {
    await putApi(`/zapret/domains/${id}`, { enabled: !enabled });
    await refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteApi(`/zapret/domains/${id}`);
    await refetch();
  };

  const title = listType === 'hostlist' ? 'Bypass Domain Listesi' : 'Hariç Tutulan Domainler';
  const subtitle = listType === 'hostlist'
    ? 'DPI bypass uygulanacak domainler'
    : 'Bypass uygulanmayacak domainler (direkt bağlantı)';

  return (
    <Panel title={title} subtitle={subtitle} icon={<List size={18} style={{ marginRight: 8 }} />}>
      <div className="list-add-form">
        <div className="list-add-row">
          <input className="config-input list-input-main" type="text" placeholder="example.com"
            value={newDomain} onChange={e => setNewDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          <button className="btn-primary btn-sm" onClick={handleAdd} disabled={adding || !newDomain.trim()}>
            <Plus size={14} /> Ekle
          </button>
        </div>
        {items.length > 5 && (
          <div className="list-filter">
            <Search size={13} />
            <input className="config-input" type="text" placeholder="Domain ara..."
              value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
        )}
      </div>

      <div className="list-items">
        {filteredItems.length === 0 && <div className="empty-state" style={{ padding: '20px' }}>Kayıt bulunamadı.</div>}
        {filteredItems.map(item => (
          <div key={item.id} className={`list-item ${!item.enabled ? 'list-item-disabled' : ''}`}>
            <button
              className={`toggle-btn toggle-sm ${item.enabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={() => handleToggle(item.id, item.enabled)}
            >
              <div className="toggle-knob" />
            </button>
            <div className="list-item-content">
              <span className="list-item-value">{item.domain}</span>
            </div>
            <button className="icon-btn icon-btn-sm list-delete" onClick={() => handleDelete(item.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="list-summary">
        <span>{items.filter(i => i.enabled).length} aktif</span>
        <span>{items.filter(i => !i.enabled).length} devre dışı</span>
        <span>{items.length} toplam</span>
      </div>
    </Panel>
  );
}

import {
  Route, Globe, Tv, Gamepad2, MessageCircle, Apple,
  Plus, Trash2, Check, X, Search, Link, Shield, Info
} from 'lucide-react';
import { useApi, putApi, postApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Badge } from './ui';
import { AppLogo } from './AppLogos';
import type { TrafficRule } from '../types';

type RoutingTab = 'apps' | 'domains';

const categoryMeta: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  voip: { label: 'VoIP & Mesajlaşma', icon: <MessageCircle size={16} />, color: 'badge-success' },
  streaming: { label: 'Streaming & Medya', icon: <Tv size={16} />, color: 'badge-info' },
  social: { label: 'Sosyal Medya', icon: <Globe size={16} />, color: 'badge-warning' },
  gaming: { label: 'Oyun', icon: <Gamepad2 size={16} />, color: 'badge-error' },
  web: { label: 'Web & Geliştirme', icon: <Globe size={16} />, color: 'badge-neutral' },
  apple: { label: 'Apple Servisleri', icon: <Apple size={16} />, color: 'badge-neutral' },
};

interface VpsServer { id: number; ip: string; location: string }

export function RoutingPanel() {
  const [activeTab, setActiveTab] = useState<RoutingTab>('apps');

  return (
    <div className="fade-in">
      <Panel title="Trafik Yönlendirme" icon={<Route size={20} style={{ marginRight: 8 }} />}
        subtitle="Tüm trafik yönlendirme kuralları — uygulamalar ve özel domain'ler">
        <div className="service-tabs">
          <button className={`service-tab ${activeTab === 'apps' ? 'service-tab-active' : ''}`}
            onClick={() => setActiveTab('apps')}>
            <Gamepad2 size={14} /><span>Uygulamalar</span>
          </button>
          <button className={`service-tab ${activeTab === 'domains' ? 'service-tab-active' : ''}`}
            onClick={() => setActiveTab('domains')}>
            <Link size={14} /><span>Özel Domain'ler</span>
          </button>
        </div>
      </Panel>

      {activeTab === 'apps' && <AppRoutingView />}
      {activeTab === 'domains' && <DomainRoutingView />}
    </div>
  );
}

// ─── App Routing — inline controls per row ───
function AppRoutingView() {
  const { data: rulesData, refetch } = useApi<{ rules: TrafficRule[] }>('/routing/rules', { rules: [] });
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [filterCat, setFilterCat] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const vpsList = vpsData.servers;
  const rules = rulesData.rules;
  const categories = [...new Set(rules.map(r => r.category))];
  const filtered = filterCat === 'all' ? rules : rules.filter(r => r.category === filterCat);

  const grouped: Record<string, TrafficRule[]> = {};
  filtered.forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  });

  const handleChange = async (id: number, field: string, value: any) => {
    try {
      await putApi(`/routing/rules/${id}`, { [field]: value });
      await refetch();
    } catch { /* */ }
  };

  const activeCount = rules.filter(r => r.enabled && r.exit_node !== 'isp').length;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3>Uygulama Bazlı Yönlendirme</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge variant="info">{rules.length} uygulama</Badge>
            <Badge variant="success">{activeCount} aktif VPS</Badge>
          </div>
        </div>

        <div className="routing-filters">
          <button className={`filter-btn ${filterCat === 'all' ? 'filter-active' : ''}`} onClick={() => setFilterCat('all')}>
            Tümü ({rules.length})
          </button>
          {categories.map(cat => {
            const meta = categoryMeta[cat] || { label: cat, icon: null, color: 'badge-neutral' };
            const count = rules.filter(r => r.category === cat).length;
            return (
              <button key={cat} className={`filter-btn ${filterCat === cat ? 'filter-active' : ''}`} onClick={() => setFilterCat(cat)}>
                {meta.icon} {meta.label} ({count})
              </button>
            );
          })}
        </div>

        {Object.entries(grouped).map(([category, catRules]) => {
          const meta = categoryMeta[category] || { label: category, icon: null, color: 'badge-neutral' };
          return (
            <div key={category} className="routing-category">
              <div className="routing-category-header">
                {meta.icon}
                <span>{meta.label}</span>
                <Badge variant={meta.color.replace('badge-', '') as any}>{catRules.length}</Badge>
              </div>

              {/* Column header */}
              <div className="routing-row routing-header-row">
                <span className="routing-col-icon"></span>
                <span className="routing-col-name">Uygulama</span>
                <span className="routing-col-vps">Çıkış Noktası</span>
                <span className="routing-col-dpi">DPI Bypass</span>
                <span className="routing-col-toggle">Durum</span>
              </div>

              {catRules.map(rule => {
                const exitNode = rule.exit_node || 'isp';
                const dpi = rule.dpi_bypass || 0;
                const isActive = rule.enabled && exitNode !== 'isp';
                const isExpanded = expandedId === rule.id;

                return (
                  <div key={rule.id}>
                    <div className={`routing-row ${!rule.enabled ? 'routing-row-disabled' : ''} ${isActive ? 'routing-row-active' : ''}`}>
                      <span className="routing-col-icon">
                        <div className="app-icon-sm">
                          <AppLogo name={rule.app_name} />
                        </div>
                      </span>

                      <span className="routing-col-name">
                        <strong>{rule.app_name}</strong>
                        <button className="info-btn" onClick={() => setExpandedId(isExpanded ? null : rule.id)} title="Domain'leri göster">
                          <Info size={12} />
                        </button>
                      </span>

                      <span className="routing-col-vps">
                        <select
                          className="config-select config-select-sm"
                          value={exitNode}
                          onChange={e => handleChange(rule.id, 'exit_node', e.target.value)}
                        >
                          <option value="isp">ISP (Direkt)</option>
                          {vpsList.map(v => (
                            <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                          ))}
                        </select>
                      </span>

                      <span className="routing-col-dpi">
                        <button
                          className={`btn-sm ${dpi ? 'btn-primary' : 'btn-outline'}`}
                          onClick={() => handleChange(rule.id, 'dpi_bypass', dpi ? 0 : 1)}
                          style={{ fontSize: 11, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                        >
                          <Shield size={11} />
                          {dpi ? 'ON' : 'OFF'}
                        </button>
                      </span>

                      <span className="routing-col-toggle">
                        <button
                          className={`toggle-btn toggle-sm ${rule.enabled ? 'toggle-on' : 'toggle-off'}`}
                          onClick={() => handleChange(rule.id, 'enabled', rule.enabled ? 0 : 1)}
                        >
                          <div className="toggle-knob" />
                        </button>
                      </span>
                    </div>

                    {isExpanded && rule.domains && (
                      <div className="routing-domains-info">
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Domain'ler:</span>
                        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>
                          {rule.domains}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Domain Routing — custom URL rules with inline controls ───
interface DomainRule {
  id: number;
  domain: string;
  exit_node: string;
  dpi_bypass: number;
  route_type: string;
  description: string;
  enabled: number;
  created_at: string;
}

function DomainRoutingView() {
  const { data, refetch } = useApi<{ domains: DomainRule[] }>('/routing/domains', { domains: [] });
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newExitNode, setNewExitNode] = useState('isp');
  const [newDpi, setNewDpi] = useState(0);
  const [newDesc, setNewDesc] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const vpsList = vpsData.servers;
  const domains = data.domains;
  const filtered = filter ? domains.filter(d => d.domain.includes(filter.toLowerCase())) : domains;

  const handleAdd = async () => {
    if (!newDomain.trim()) return;
    setError('');
    try {
      const result = await postApi('/routing/domains', {
        domain: newDomain.trim(),
        exit_node: newExitNode,
        dpi_bypass: newDpi,
        description: newDesc.trim(),
      });
      if (result.error) { setError(result.error); return; }
      setNewDomain(''); setNewDesc(''); setNewExitNode('isp'); setNewDpi(0); setShowAdd(false);
      await refetch();
    } catch (e: any) {
      setError(e.message || 'Eklenemedi');
    }
  };

  const handleChange = async (id: number, field: string, value: any) => {
    try {
      await putApi(`/routing/domains/${id}`, { [field]: value });
      await refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteApi(`/routing/domains/${id}`);
      await refetch();
    } catch { /* */ }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Link size={18} style={{ marginRight: 8 }} />Özel Domain Yönlendirme</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge variant="info">{domains.length} domain</Badge>
            <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
              <Plus size={14} /> Domain Ekle
            </button>
          </div>
        </div>
        <p className="subtitle">
          Belirli domain'leri farklı VPS'ler üzerinden yönlendirin
        </p>

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label><Globe size={14} /> Domain</label>
                <input className="config-input" type="text" placeholder="example.com"
                  value={newDomain} onChange={e => setNewDomain(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
              </div>
              <div className="form-group">
                <label><Route size={14} /> Çıkış Noktası</label>
                <select className="config-select" value={newExitNode} onChange={e => setNewExitNode(e.target.value)}>
                  <option value="isp">ISP (Direkt)</option>
                  {vpsList.map(v => (
                    <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label><Shield size={14} /> DPI Bypass</label>
                <button
                  className={`btn-sm ${newDpi ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setNewDpi(newDpi ? 0 : 1)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Shield size={12} /> DPI {newDpi ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="form-group">
                <label>Açıklama</label>
                <input className="config-input" type="text" placeholder="Neden bu rota?"
                  value={newDesc} onChange={e => setNewDesc(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
              </div>
            </div>
            {error && <div style={{ color: 'var(--danger-color)', fontSize: 12, marginTop: 6 }}>{error}</div>}
            <div className="cron-add-actions" style={{ marginTop: 10 }}>
              <button className="btn-primary btn-sm" onClick={handleAdd} disabled={!newDomain.trim()}>
                <Check size={13} /> Ekle
              </button>
              <button className="btn-outline btn-sm" onClick={() => { setShowAdd(false); setError(''); }}>
                <X size={13} /> İptal
              </button>
            </div>
          </div>
        )}

        {domains.length > 5 && (
          <div className="list-filter" style={{ marginTop: 12 }}>
            <Search size={13} />
            <input className="config-input" type="text" placeholder="Domain ara..."
              value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
        )}

        {/* Column header */}
        {filtered.length > 0 && (
          <div className="routing-row routing-header-row" style={{ marginTop: 8 }}>
            <span className="routing-col-toggle">Durum</span>
            <span className="routing-col-domain">Domain</span>
            <span className="routing-col-vps">Çıkış Noktası</span>
            <span className="routing-col-dpi">DPI</span>
            <span className="routing-col-delete"></span>
          </div>
        )}

        <div style={{ marginTop: 4 }}>
          {filtered.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Link size={32} />
              <p>{domains.length === 0 ? 'Henüz özel domain eklenmedi' : 'Aramayla eşleşen domain bulunamadı'}</p>
            </div>
          )}
          {filtered.map(d => {
            const exitNode = d.exit_node || 'isp';
            const dpi = d.dpi_bypass || 0;

            return (
              <div key={d.id} className={`routing-row ${!d.enabled ? 'routing-row-disabled' : ''} ${d.enabled && exitNode !== 'isp' ? 'routing-row-active' : ''}`}>
                <span className="routing-col-toggle">
                  <button
                    className={`toggle-btn toggle-sm ${d.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleChange(d.id, 'enabled', d.enabled ? 0 : 1)}
                  >
                    <div className="toggle-knob" />
                  </button>
                </span>

                <span className="routing-col-domain">
                  <span style={{ fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono, monospace)' }}>
                    {d.domain}
                  </span>
                  {d.description && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>— {d.description}</span>
                  )}
                </span>

                <span className="routing-col-vps">
                  <select
                    className="config-select config-select-sm"
                    value={exitNode}
                    onChange={e => handleChange(d.id, 'exit_node', e.target.value)}
                  >
                    <option value="isp">ISP (Direkt)</option>
                    {vpsList.map(v => (
                      <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                    ))}
                  </select>
                </span>

                <span className="routing-col-dpi">
                  <button
                    className={`btn-sm ${dpi ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => handleChange(d.id, 'dpi_bypass', dpi ? 0 : 1)}
                    style={{ fontSize: 11, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  >
                    <Shield size={11} />
                    {dpi ? 'ON' : 'OFF'}
                  </button>
                </span>

                <span className="routing-col-delete">
                  <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(d.id)} title="Sil">
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        {domains.length > 0 && (
          <div className="list-summary">
            <span>{domains.filter(d => d.enabled).length} aktif</span>
            <span>{domains.filter(d => !d.enabled).length} devre dışı</span>
            <span>{domains.length} toplam</span>
          </div>
        )}
      </div>
    </div>
  );
}

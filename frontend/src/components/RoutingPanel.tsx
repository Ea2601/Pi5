import {
  ArrowRightLeft, MessageCircle, Globe, Tv, Gamepad2, Route,
  Plus, Trash2, Check, X, Search, Link, Shield
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
};

interface VpsServer { id: number; ip: string; location: string }

function getRouteLabel(exitNode: string, dpiBypas: number, vpsList: VpsServer[]): string {
  const vps = exitNode !== 'isp' ? vpsList.find(v => String(v.id) === exitNode) : null;
  const base = vps ? `VPS ${vps.location}` : 'ISP (Direkt)';
  return dpiBypas ? `${base} + DPI` : base;
}

function getRouteBadgeVariant(exitNode: string, dpiBypas: number): 'neutral' | 'info' | 'warning' | 'error' {
  if (exitNode === 'isp') return dpiBypas ? 'warning' : 'neutral';
  return dpiBypas ? 'error' : 'info';
}

function ExitNodeSelect({ value, onChange, vpsList, style }: {
  value: string; onChange: (v: string) => void; vpsList: VpsServer[]; style?: React.CSSProperties;
}) {
  return (
    <select className="config-select" value={value} onChange={e => onChange(e.target.value)} style={style}>
      <option value="isp">ISP (Direkt)</option>
      {vpsList.map(v => (
        <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
      ))}
    </select>
  );
}

function DpiToggle({ value, onChange, style }: {
  value: number; onChange: (v: number) => void; style?: React.CSSProperties;
}) {
  return (
    <button
      className={`btn-sm ${value ? 'btn-primary' : 'btn-outline'}`}
      onClick={() => onChange(value ? 0 : 1)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', ...style }}
      title={value ? 'DPI Bypass aktif' : 'DPI Bypass kapalı'}
    >
      <Shield size={12} />
      DPI {value ? 'ON' : 'OFF'}
    </button>
  );
}

export function RoutingPanel() {
  const [activeTab, setActiveTab] = useState<RoutingTab>('apps');

  return (
    <div className="fade-in">
      <Panel title="Trafik Yönlendirme" icon={<Route size={20} style={{ marginRight: 8 }} />}
        subtitle="Uygulama ve domain bazlı trafik yönlendirme kuralları">
        <div className="service-tabs">
          <button className={`service-tab ${activeTab === 'apps' ? 'service-tab-active' : ''}`}
            onClick={() => setActiveTab('apps')}>
            <Gamepad2 size={14} /><span>Uygulamalar</span>
          </button>
          <button className={`service-tab ${activeTab === 'domains' ? 'service-tab-active' : ''}`}
            onClick={() => setActiveTab('domains')}>
            <Link size={14} /><span>Domain Routing</span>
          </button>
        </div>
      </Panel>

      {activeTab === 'apps' && <AppRoutingView />}
      {activeTab === 'domains' && <DomainRoutingView />}
    </div>
  );
}

// ─── App Routing (existing) ───
function AppRoutingView() {
  const { data: rulesData, refetch } = useApi<{ rules: TrafficRule[] }>('/routing/rules', { rules: [] });
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editExitNode, setEditExitNode] = useState('isp');
  const [editDpi, setEditDpi] = useState(0);
  const [filterCat, setFilterCat] = useState<string>('all');

  const vpsList = vpsData.servers;

  const handleRouteChange = async (id: number) => {
    try {
      await putApi(`/routing/rules/${id}`, { exit_node: editExitNode, dpi_bypass: editDpi });
      await refetch();
      setEditingId(null);
    } catch { /* */ }
  };

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      await putApi(`/routing/rules/${id}`, { enabled: !enabled });
      await refetch();
    } catch { /* */ }
  };

  const startEditing = (rule: TrafficRule) => {
    setEditingId(rule.id);
    setEditExitNode(rule.exit_node || 'isp');
    setEditDpi(rule.dpi_bypass || 0);
  };

  const rules = rulesData.rules;
  const categories = [...new Set(rules.map(r => r.category))];
  const filtered = filterCat === 'all' ? rules : rules.filter(r => r.category === filterCat);

  const grouped: Record<string, TrafficRule[]> = {};
  filtered.forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  });

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3>Uygulama Bazlı Yönlendirme</h3>
          <Badge variant="info">{rules.length} kural</Badge>
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
              <div className="voip-list">
                {catRules.map(rule => {
                  const exitNode = rule.exit_node || 'isp';
                  const dpi = rule.dpi_bypass || 0;
                  const label = getRouteLabel(exitNode, dpi, vpsList);
                  const badgeVariant = getRouteBadgeVariant(exitNode, dpi);
                  return (
                    <div key={rule.id} className={`voip-rule ${!rule.enabled ? 'rule-disabled' : ''}`}>
                      <div className="app-icon-logo">
                        <AppLogo name={rule.app_name} />
                      </div>
                      <div className="app-details">
                        <h4>{rule.app_name}</h4>
                        <p>
                          Rota: <strong>{label}</strong>
                          {dpi ? <span style={{ marginLeft: 6 }}><Badge variant="warning">DPI</Badge></span> : null}
                        </p>
                      </div>
                      <button className={`toggle-btn ${rule.enabled ? 'toggle-on' : 'toggle-off'}`}
                        onClick={() => handleToggle(rule.id, !!rule.enabled)} title={rule.enabled ? 'Devre dışı bırak' : 'Etkinleştir'}>
                        <span className="toggle-knob" />
                      </button>
                      {editingId === rule.id ? (
                        <div className="voip-edit" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <ExitNodeSelect value={editExitNode} onChange={setEditExitNode} vpsList={vpsList} />
                          <DpiToggle value={editDpi} onChange={setEditDpi} />
                          <button className="btn-primary btn-sm" onClick={() => handleRouteChange(rule.id)}>
                            <Check size={12} />
                          </button>
                          <button className="btn-outline btn-sm" onClick={() => setEditingId(null)}>
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <Badge variant={badgeVariant}>{label}</Badge>
                      )}
                      {editingId !== rule.id && (
                        <button className="btn-outline btn-sm" onClick={() => startEditing(rule)}>
                          <ArrowRightLeft size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Domain Routing (new) ───
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

  const handleRouteChange = async (id: number, exit_node: string, dpi_bypass: number) => {
    try {
      await putApi(`/routing/domains/${id}`, { exit_node, dpi_bypass });
      await refetch();
    } catch { /* */ }
  };

  const handleToggle = async (id: number, currentEnabled: number) => {
    try {
      await putApi(`/routing/domains/${id}`, { enabled: currentEnabled ? 0 : 1 });
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
          <h3><Link size={18} style={{ marginRight: 8 }} />Domain Bazlı Yönlendirme</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge variant="info">{domains.length} domain</Badge>
            <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
              <Plus size={14} /> Domain Ekle
            </button>
          </div>
        </div>
        <p className="subtitle">
          Belirli domain/URL'leri farklı rotalara yönlendirin — VPS, DPI bypass veya direkt ISP
        </p>

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label><Globe size={14} /> Domain</label>
                <input className="config-input" type="text" placeholder="netflix.com, discord.com..."
                  value={newDomain} onChange={e => setNewDomain(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
              </div>
              <div className="form-group">
                <label><Route size={14} /> Çıkış Noktası</label>
                <ExitNodeSelect value={newExitNode} onChange={setNewExitNode} vpsList={vpsList} />
              </div>
              <div className="form-group">
                <label><Shield size={14} /> DPI Bypass</label>
                <DpiToggle value={newDpi} onChange={setNewDpi} />
              </div>
              <div className="form-group">
                <label>Açıklama (isteğe bağlı)</label>
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

        <div className="list-items" style={{ marginTop: 8 }}>
          {filtered.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Link size={32} />
              <p>{domains.length === 0 ? 'Henüz domain routing kuralı eklenmedi' : 'Aramayla eşleşen domain bulunamadı'}</p>
            </div>
          )}
          {filtered.map(d => {
            const exitNode = d.exit_node || 'isp';
            const dpi = d.dpi_bypass || 0;
            const label = getRouteLabel(exitNode, dpi, vpsList);
            const badgeVariant = getRouteBadgeVariant(exitNode, dpi);
            return (
              <div key={d.id} className={`list-item ${!d.enabled ? 'list-item-disabled' : ''}`}>
                <button
                  className={`toggle-btn toggle-sm ${d.enabled ? 'toggle-on' : 'toggle-off'}`}
                  onClick={() => handleToggle(d.id, d.enabled)}>
                  <div className="toggle-knob" />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono, monospace)' }}>
                      {d.domain}
                    </span>
                    {d.description && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>— {d.description}</span>
                    )}
                  </div>
                </div>
                <ExitNodeSelect value={exitNode}
                  onChange={v => handleRouteChange(d.id, v, dpi)}
                  vpsList={vpsList}
                  style={{ fontSize: 12, padding: '2px 8px', width: 'auto', minWidth: 140 }} />
                <DpiToggle value={dpi} onChange={v => handleRouteChange(d.id, exitNode, v)} />
                <Badge variant={badgeVariant}>
                  {label}
                </Badge>
                <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(d.id)} title="Sil">
                  <Trash2 size={13} />
                </button>
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

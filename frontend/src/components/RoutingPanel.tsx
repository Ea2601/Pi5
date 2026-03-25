import {
  ArrowRightLeft, MessageCircle,
  Globe, Tv, Gamepad2, Route
} from 'lucide-react';
import { useApi, putApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Badge } from './ui';
import { AppLogo } from './AppLogos';
import type { TrafficRule } from '../types';

const categoryMeta: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  voip: { label: 'VoIP & Mesajlaşma', icon: <MessageCircle size={16} />, color: 'badge-success' },
  streaming: { label: 'Streaming & Medya', icon: <Tv size={16} />, color: 'badge-info' },
  social: { label: 'Sosyal Medya', icon: <Globe size={16} />, color: 'badge-warning' },
  gaming: { label: 'Oyun', icon: <Gamepad2 size={16} />, color: 'badge-error' },
  web: { label: 'Web & Geliştirme', icon: <Globe size={16} />, color: 'badge-neutral' },
};


const routeLabels: Record<string, { label: string; badge: string }> = {
  direct:      { label: 'Direkt ISP',       badge: 'neutral' },
  adblock:     { label: 'Reklamsız (Pi-hole + ISP)', badge: 'success' },
  vpn_only:    { label: 'Sadece VPN',                badge: 'info' },
  vpn:         { label: 'VPN (Pi-hole + VPN)',       badge: 'info' },
  dpi:         { label: 'DPI (Zapret)',              badge: 'warning' },
  adblock_dpi: { label: 'Reklamsız DPI (Pi-hole + Zapret)', badge: 'error' },
};

export function RoutingPanel() {
  const { data: rulesData, refetch } = useApi<{ rules: TrafficRule[] }>('/routing/rules', { rules: [] });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [filterCat, setFilterCat] = useState<string>('all');

  const handleRouteChange = async (id: number, route_type: string, vps_id: number | null) => {
    try {
      await putApi(`/routing/rules/${id}`, { route_type, vps_id });
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

  const rules = rulesData.rules;
  const categories = [...new Set(rules.map(r => r.category))];
  const filtered = filterCat === 'all' ? rules : rules.filter(r => r.category === filterCat);

  // Group by category
  const grouped: Record<string, TrafficRule[]> = {};
  filtered.forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  });

  return (
    <div className="fade-in">
      <Panel title="Trafik Yönlendirme" icon={<Route size={20} style={{ marginRight: 8 }} />}
        subtitle="Tüm uygulama ve protokol trafiğini yönetin — Direkt ISP, Reklamsız, VPN, DPI veya Reklamsız DPI profilleri"
        badge={<Badge variant="info">{rules.length} kural</Badge>}>

        {/* Category filter */}
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
                  const routeInfo = routeLabels[rule.route_type] || routeLabels.direct;
                  return (
                    <div key={rule.id} className={`voip-rule ${!rule.enabled ? 'rule-disabled' : ''}`}>
                      <div className="app-icon-logo">
                        <AppLogo name={rule.app_name} />
                      </div>
                      <div className="app-details">
                        <h4>{rule.app_name}</h4>
                        <p>
                          Rota: <strong>{routeInfo.label}</strong>
                          <span className={`route-status route-${rule.route_type}`}>
                            {routeInfo.label}
                          </span>
                        </p>
                      </div>
                      <button className={`toggle-btn ${rule.enabled ? 'toggle-on' : 'toggle-off'}`}
                        onClick={() => handleToggle(rule.id, !!rule.enabled)} title={rule.enabled ? 'Devre dışı bırak' : 'Etkinleştir'}>
                        <span className="toggle-knob" />
                      </button>
                      {editingId === rule.id ? (
                        <div className="voip-edit">
                          <select
                            defaultValue={rule.route_type}
                            onChange={e => handleRouteChange(rule.id, e.target.value, null)}
                          >
                            <option value="direct">Direkt ISP</option>
                            <option value="adblock">Reklamsız (Pi-hole + ISP)</option>
                            <option value="vpn_only">Sadece VPN</option>
                            <option value="vpn">VPN (Pi-hole + VPN)</option>
                            <option value="dpi">DPI (Zapret)</option>
                            <option value="adblock_dpi">Reklamsız DPI (Pi-hole + Zapret)</option>
                          </select>
                        </div>
                      ) : (
                        <button className="btn-outline btn-sm" onClick={() => setEditingId(rule.id)}>
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
      </Panel>
    </div>
  );
}

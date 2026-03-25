import { useState } from 'react';
import { GitBranch, Plus, Trash2, Check, X } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { AppLogo } from './AppLogos';
import type { Device, VpsServer } from '../types';

interface DeviceRoutingRule {
  id: number;
  device_mac: string;
  app_name: string;
  route_type: 'direct' | 'vps' | 'zapret' | 'blocked';
  vps_id: number | null;
  tunnel_name: string;
  enabled: number;
}

const ROUTE_TYPE_LABELS: Record<string, string> = {
  direct: 'Direkt',
  vps: 'VPS',
  zapret: 'Zapret',
  blocked: 'Engelli',
};

const ROUTE_TYPE_VARIANTS: Record<string, 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
  direct: 'success',
  vps: 'info',
  zapret: 'warning',
  blocked: 'error',
};

export function DeviceRoutingPanel() {
  const { data: devicesData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [selectedMac, setSelectedMac] = useState('');
  const selectedDevice = devicesData.devices.find(d => d.mac_address === selectedMac);

  // Auto-select first device
  if (!selectedMac && devicesData.devices.length > 0) {
    setSelectedMac(devicesData.devices[0].mac_address);
  }

  const { data: routingData, refetch } = useApi<{ rules: DeviceRoutingRule[] }>(
    selectedMac ? `/devices/${selectedMac}/routing` : '/devices/__none__/routing',
    { rules: [] },
  );

  const [showAdd, setShowAdd] = useState(false);
  const [newRule, setNewRule] = useState({
    app_name: '',
    route_type: 'direct' as string,
    vps_id: null as number | null,
    tunnel_name: '',
  });

  const handleAdd = async () => {
    if (!newRule.app_name.trim() || !selectedMac) return;
    try {
      await postApi(`/devices/${selectedMac}/routing`, {
        app_name: newRule.app_name,
        route_type: newRule.route_type,
        vps_id: newRule.vps_id,
        tunnel_name: newRule.tunnel_name,
      });
      setNewRule({ app_name: '', route_type: 'direct', vps_id: null, tunnel_name: '' });
      setShowAdd(false);
      await refetch();
    } catch { /* */ }
  };

  const handleToggle = async (rule: DeviceRoutingRule) => {
    try {
      await putApi(`/devices/${selectedMac}/routing/${rule.id}`, {
        enabled: rule.enabled ? 0 : 1,
      });
      await refetch();
    } catch { /* */ }
  };

  const handleRouteTypeChange = async (rule: DeviceRoutingRule, newType: string) => {
    try {
      await putApi(`/devices/${selectedMac}/routing/${rule.id}`, {
        route_type: newType,
      });
      await refetch();
    } catch { /* */ }
  };

  const handleVpsChange = async (rule: DeviceRoutingRule, vpsId: number | null) => {
    try {
      await putApi(`/devices/${selectedMac}/routing/${rule.id}`, {
        vps_id: vpsId,
      });
      await refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteApi(`/devices/${selectedMac}/routing/${id}`);
      await refetch();
    } catch { /* */ }
  };

  return (
    <div className="fade-in">
      <Panel
        title="Cihaz Bazli Routing"
        icon={<GitBranch size={20} style={{ marginRight: 8 }} />}
        subtitle="Her cihaz icin uygulama bazli yonlendirme kurallari"
      >
        <div style={{ marginTop: 8 }}>
          <select
            className="config-select"
            value={selectedMac}
            onChange={e => setSelectedMac(e.target.value)}
            style={{ width: '100%', maxWidth: 500 }}
          >
            <option value="">Cihaz secin...</option>
            {devicesData.devices.map(d => (
              <option key={d.mac_address} value={d.mac_address}>
                {d.hostname || d.ip_address} - {d.mac_address}
              </option>
            ))}
          </select>
        </div>
      </Panel>

      {selectedDevice && (
        <div style={{ marginTop: 14 }}>
          <Panel
            title={selectedDevice.hostname || selectedDevice.ip_address}
            subtitle={`IP: ${selectedDevice.ip_address} | MAC: ${selectedDevice.mac_address} | Profil: ${selectedDevice.route_profile}`}
            actions={
              <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
                <Plus size={14} /> Kural Ekle
              </button>
            }
          >
            {showAdd && (
              <div className="cron-add-form" style={{ marginBottom: 12 }}>
                <div className="cron-add-grid">
                  <div className="form-group">
                    <label>Uygulama Adi</label>
                    <input className="config-input" type="text" placeholder="Discord, YouTube..."
                      value={newRule.app_name}
                      onChange={e => setNewRule({ ...newRule, app_name: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Yonlendirme Tipi</label>
                    <select className="config-select" value={newRule.route_type}
                      onChange={e => setNewRule({ ...newRule, route_type: e.target.value })}>
                      <option value="direct">Direkt</option>
                      <option value="vps">VPS</option>
                      <option value="zapret">Zapret</option>
                      <option value="blocked">Engelli</option>
                    </select>
                  </div>
                  {newRule.route_type === 'vps' && (
                    <div className="form-group">
                      <label>VPS Sunucu</label>
                      <select className="config-select" value={newRule.vps_id ?? ''}
                        onChange={e => setNewRule({ ...newRule, vps_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">VPS secin...</option>
                        {vpsData.servers.map(s => (
                          <option key={s.id} value={s.id}>{s.location} ({s.ip})</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="form-group">
                    <label>Tunel Adi</label>
                    <input className="config-input" type="text" placeholder="wg0, tun0..."
                      value={newRule.tunnel_name}
                      onChange={e => setNewRule({ ...newRule, tunnel_name: e.target.value })} />
                  </div>
                </div>
                <div className="cron-add-actions" style={{ marginTop: 10 }}>
                  <button className="btn-primary btn-sm" onClick={handleAdd} disabled={!newRule.app_name.trim()}>
                    <Check size={13} /> Ekle
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => setShowAdd(false)}>
                    <X size={13} /> Iptal
                  </button>
                </div>
              </div>
            )}

            <div className="blocked-list">
              <div className="ban-row" style={{ opacity: 0.6, fontSize: 12 }}>
                <span style={{ width: 40 }}></span>
                <span style={{ flex: 2 }}>Uygulama</span>
                <span style={{ flex: 1.5 }}>Yonlendirme</span>
                <span style={{ flex: 1.5 }}>VPS / Tunel</span>
                <span style={{ width: 60 }}>Durum</span>
                <span style={{ width: 40 }}></span>
              </div>
              {routingData.rules.length === 0 && (
                <div className="empty-state" style={{ padding: 30 }}>
                  <GitBranch size={32} />
                  <p>Bu cihaz icin henuz routing kurali yok</p>
                </div>
              )}
              {routingData.rules.map(rule => (
                <div key={rule.id} className={`ban-row ${!rule.enabled ? 'cron-row-disabled' : ''}`}>
                  <span style={{ width: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <AppLogo name={rule.app_name} size={20} />
                    </div>
                  </span>
                  <span style={{ flex: 2, fontWeight: 500 }}>{rule.app_name}</span>
                  <span style={{ flex: 1.5 }}>
                    <select className="config-select" value={rule.route_type}
                      onChange={e => handleRouteTypeChange(rule, e.target.value)}
                      style={{ fontSize: 12, padding: '2px 6px' }}>
                      <option value="direct">Direkt</option>
                      <option value="vps">VPS</option>
                      <option value="zapret">Zapret</option>
                      <option value="blocked">Engelli</option>
                    </select>
                  </span>
                  <span style={{ flex: 1.5 }}>
                    {rule.route_type === 'vps' ? (
                      <select className="config-select" value={rule.vps_id ?? ''}
                        onChange={e => handleVpsChange(rule, e.target.value ? Number(e.target.value) : null)}
                        style={{ fontSize: 12, padding: '2px 6px' }}>
                        <option value="">Sec...</option>
                        {vpsData.servers.map(s => (
                          <option key={s.id} value={s.id}>{s.location}</option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant={ROUTE_TYPE_VARIANTS[rule.route_type] || 'neutral'}>
                        {rule.tunnel_name || ROUTE_TYPE_LABELS[rule.route_type] || rule.route_type}
                      </Badge>
                    )}
                  </span>
                  <span style={{ width: 60 }}>
                    <button
                      className={`toggle-btn toggle-sm ${rule.enabled ? 'toggle-on' : 'toggle-off'}`}
                      onClick={() => handleToggle(rule)}
                    >
                      <div className="toggle-knob" />
                    </button>
                  </span>
                  <span style={{ width: 40 }}>
                    <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(rule.id)} title="Sil">
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

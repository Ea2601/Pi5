import { useState } from 'react';
import { GitBranch, Plus, Trash2, Check, X, Shield } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel } from './ui';
import { AppLogo } from './AppLogos';
import type { Device } from '../types';

interface VpsServer { id: number; ip: string; location: string }

interface DeviceRoutingRule {
  id: number;
  device_mac: string;
  app_name: string;
  exit_node: string;
  dpi_bypass: number;
  route_type: string;
  vps_id: number | null;
  tunnel_name: string;
  enabled: number;
}

function getRouteLabel(exitNode: string, dpi: number, vpsList: VpsServer[]): string {
  if (exitNode === 'blocked') return 'Engelli';
  const vps = exitNode !== 'isp' ? vpsList.find(v => String(v.id) === exitNode) : null;
  const base = vps ? `VPS ${vps.location}` : 'ISP (Direkt)';
  return dpi ? `${base} + DPI` : base;
}

export function DeviceRoutingPanel() {
  const { data: devicesData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [selectedMac, setSelectedMac] = useState('');
  const selectedDevice = devicesData.devices.find(d => d.mac_address === selectedMac);
  const vpsList = vpsData.servers;

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
    exit_node: 'isp',
    dpi_bypass: 0,
  });

  const handleAdd = async () => {
    if (!newRule.app_name.trim() || !selectedMac) return;
    try {
      await postApi(`/devices/${selectedMac}/routing`, {
        app_name: newRule.app_name,
        exit_node: newRule.exit_node,
        dpi_bypass: newRule.dpi_bypass,
      });
      setNewRule({ app_name: '', exit_node: 'isp', dpi_bypass: 0 });
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

  const handleRouteChange = async (rule: DeviceRoutingRule, exit_node: string, dpi_bypass: number) => {
    try {
      await putApi(`/devices/${selectedMac}/routing/${rule.id}`, {
        exit_node,
        dpi_bypass,
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

  const deviceProfileLabel = selectedDevice
    ? getRouteLabel(selectedDevice.exit_node || 'isp', selectedDevice.dpi_bypass || 0, vpsList)
    : '';

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
            subtitle={`IP: ${selectedDevice.ip_address} | MAC: ${selectedDevice.mac_address} | Profil: ${deviceProfileLabel}`}
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
                    <label>Çıkış Noktası</label>
                    <select className="config-select" value={newRule.exit_node}
                      onChange={e => setNewRule({ ...newRule, exit_node: e.target.value })}>
                      <option value="isp">ISP (Direkt)</option>
                      {vpsList.map(v => (
                        <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                      ))}
                      <option value="blocked">Engelli</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label><Shield size={12} /> DPI Bypass</label>
                    <button
                      className={`btn-sm ${newRule.dpi_bypass ? 'btn-primary' : 'btn-outline'}`}
                      onClick={() => setNewRule({ ...newRule, dpi_bypass: newRule.dpi_bypass ? 0 : 1 })}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <Shield size={12} />
                      DPI {newRule.dpi_bypass ? 'ON' : 'OFF'}
                    </button>
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
                <span style={{ flex: 2 }}>Çıkış Noktası</span>
                <span style={{ width: 60 }}>DPI</span>
                <span style={{ width: 60 }}>Durum</span>
                <span style={{ width: 40 }}></span>
              </div>
              {routingData.rules.length === 0 && (
                <div className="empty-state" style={{ padding: 30 }}>
                  <GitBranch size={32} />
                  <p>Bu cihaz icin henuz routing kurali yok</p>
                </div>
              )}
              {routingData.rules.map(rule => {
                const exitNode = rule.exit_node || 'isp';
                const dpi = rule.dpi_bypass || 0;
                return (
                  <div key={rule.id} className={`ban-row ${!rule.enabled ? 'cron-row-disabled' : ''}`}>
                    <span style={{ width: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 28, height: 28, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <AppLogo name={rule.app_name} size={20} />
                      </div>
                    </span>
                    <span style={{ flex: 2, fontWeight: 500 }}>{rule.app_name}</span>
                    <span style={{ flex: 2 }}>
                      <select className="config-select" value={exitNode}
                        onChange={e => handleRouteChange(rule, e.target.value, dpi)}
                        style={{ fontSize: 12, padding: '2px 6px' }}>
                        <option value="isp">ISP (Direkt)</option>
                        {vpsList.map(v => (
                          <option key={v.id} value={String(v.id)}>VPS {v.location}</option>
                        ))}
                        <option value="blocked">Engelli</option>
                      </select>
                    </span>
                    <span style={{ width: 60 }}>
                      {exitNode !== 'blocked' && (
                        <button
                          className={`btn-sm ${dpi ? 'btn-primary' : 'btn-outline'}`}
                          onClick={() => handleRouteChange(rule, exitNode, dpi ? 0 : 1)}
                          style={{ fontSize: 10, padding: '2px 6px' }}
                        >
                          {dpi ? 'ON' : 'OFF'}
                        </button>
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
                );
              })}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

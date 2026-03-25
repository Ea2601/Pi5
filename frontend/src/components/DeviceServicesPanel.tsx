import { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck, ShieldBan, Globe, Zap, Server, ShieldAlert, Flame,
  ChevronDown, ChevronUp, Save, Loader2, CheckCircle
} from 'lucide-react';
import { useApi, putApi } from '../hooks/useApi';
import type { Device } from '../types';

interface DeviceService {
  id: number;
  device_mac: string;
  service_name: string;
  enabled: number;
  config_json: string;
}

const SERVICE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  pihole: { label: 'Pi-hole', icon: <ShieldBan size={18} />, color: 'var(--danger-color)' },
  unbound: { label: 'Unbound', icon: <Globe size={18} />, color: 'var(--accent-color)' },
  zapret: { label: 'Zapret', icon: <Zap size={18} />, color: 'var(--orange-color)' },
  wireguard: { label: 'WireGuard', icon: <Server size={18} />, color: 'var(--success-color)' },
  fail2ban: { label: 'Fail2Ban', icon: <ShieldAlert size={18} />, color: 'var(--purple-color)' },
  nftables: { label: 'nftables', icon: <Flame size={18} />, color: 'var(--cyan-color)' },
};

function parseConfig(json: string): Record<string, unknown> {
  try { return JSON.parse(json); } catch { return {}; }
}

function ConfigSummary({ service, config }: { service: string; config: Record<string, unknown> }) {
  const parts: string[] = [];
  if (service === 'pihole') {
    if (config.upstream) parts.push(`DNS: ${config.upstream}`);
    if (config.blocking !== undefined) parts.push(config.blocking ? 'Engelleme aktif' : 'Engelleme kapalı');
  } else if (service === 'zapret') {
    if (config.mode) parts.push(`Mod: ${config.mode}`);
    if (config.desync) parts.push(`Desync: ${config.desync}`);
  } else if (service === 'wireguard') {
    if (config.tunnel) parts.push(`Tünel: ${config.tunnel}`);
    if (config.vps_id) parts.push(`VPS #${config.vps_id}`);
  } else if (service === 'unbound') {
    if (config.port) parts.push(`Port: ${config.port}`);
  }
  if (parts.length === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Varsayılan yapılandırma</span>;
  return <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{parts.join(' | ')}</span>;
}

function ServiceCard({ svc, onUpdate }: { svc: DeviceService; onUpdate: () => void }) {
  const meta = SERVICE_META[svc.service_name] || { label: svc.service_name, icon: <Flame size={18} />, color: 'var(--text-muted)' };
  const config = parseConfig(svc.config_json);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(!!svc.enabled);
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(config);

  const handleToggle = async () => {
    const next = !localEnabled;
    setLocalEnabled(next);
    try {
      await putApi(`/devices/${svc.device_mac}/services/${svc.service_name}`, { enabled: next });
      onUpdate();
    } catch { setLocalEnabled(!next); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await putApi(`/devices/${svc.device_mac}/services/${svc.service_name}`, { config_json: JSON.stringify(localConfig) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onUpdate();
    } catch { /* */ }
    setSaving(false);
  };

  const updateField = (key: string, value: unknown) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid var(--panel-border)',
      borderRadius: 'var(--radius)',
      padding: 16,
      transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--radius-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${meta.color}15`, color: meta.color,
        }}>
          {meta.icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#f8fafc' }}>{meta.label}</div>
          <ConfigSummary service={svc.service_name} config={localConfig} />
        </div>
        <button className={`toggle-btn ${localEnabled ? 'toggle-on' : 'toggle-off'}`} onClick={handleToggle}>
          <span className="toggle-knob" />
        </button>
        <button className="icon-btn icon-btn-sm" onClick={() => setExpanded(!expanded)} style={{ marginLeft: 4 }}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--panel-border)' }}>
          {svc.service_name === 'pihole' && (
            <>
              <div className="form-group" style={{ marginBottom: 10 }}>
                <label>Upstream DNS</label>
                <select value={String(localConfig.upstream || 'unbound')} onChange={e => updateField('upstream', e.target.value)}>
                  <option value="unbound">Unbound (Yerel)</option>
                  <option value="cloudflare">Cloudflare (1.1.1.1)</option>
                  <option value="google">Google (8.8.8.8)</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                <span>Engelleme</span>
                <button className={`toggle-btn toggle-sm ${localConfig.blocking ? 'toggle-on' : 'toggle-off'}`}
                  onClick={() => updateField('blocking', !localConfig.blocking)}>
                  <span className="toggle-knob" />
                </button>
              </div>
            </>
          )}
          {svc.service_name === 'zapret' && (
            <>
              <div className="form-group" style={{ marginBottom: 10 }}>
                <label>Bypass Modu</label>
                <select value={String(localConfig.mode || 'nfqws')} onChange={e => updateField('mode', e.target.value)}>
                  <option value="nfqws">NFQWS</option>
                  <option value="tproxy">TPROXY</option>
                  <option value="singbox">Sing-box</option>
                </select>
              </div>
              <div className="form-group">
                <label>Desync Parametreleri</label>
                <input className="config-input" style={{ width: '100%' }}
                  value={String(localConfig.desync || '')} placeholder="fake,split2"
                  onChange={e => updateField('desync', e.target.value)} />
              </div>
            </>
          )}
          {svc.service_name === 'wireguard' && (
            <>
              <div className="form-group" style={{ marginBottom: 10 }}>
                <label>Tünel Adı</label>
                <input className="config-input" style={{ width: '100%' }}
                  value={String(localConfig.tunnel || '')} placeholder="wg0"
                  onChange={e => updateField('tunnel', e.target.value)} />
              </div>
              <div className="form-group">
                <label>VPS Sunucu</label>
                <select value={String(localConfig.vps_id || '')} onChange={e => updateField('vps_id', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Seçiniz</option>
                  <option value="1">VPS #1</option>
                  <option value="2">VPS #2</option>
                </select>
              </div>
            </>
          )}
          {svc.service_name === 'unbound' && (
            <div className="form-group">
              <label>Port</label>
              <input className="config-input" style={{ width: '100%' }} type="number"
                value={String(localConfig.port || '5335')}
                onChange={e => updateField('port', Number(e.target.value))} />
            </div>
          )}
          {(svc.service_name === 'fail2ban' || svc.service_name === 'nftables') && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Bu servis varsayılan yapılandırma ile çalışmaktadır.</p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 size={13} className="spin" /> : saved ? <><CheckCircle size={13} /> Kaydedildi</> : <><Save size={13} /> Kaydet</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DeviceServicesPanel() {
  const { data: devData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const [selectedMac, setSelectedMac] = useState('');
  const [services, setServices] = useState<DeviceService[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchServices = useCallback(async (mac: string) => {
    if (!mac) { setServices([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/devices/${mac}/services`);
      const json = await res.json();
      setServices(json.services || []);
    } catch { setServices([]); }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (devData.devices.length > 0 && !selectedMac) {
      setSelectedMac(devData.devices[0].mac_address);
    }
  }, [devData.devices, selectedMac]);

  useEffect(() => {
    if (selectedMac) fetchServices(selectedMac);
  }, [selectedMac, fetchServices]);

  const selectedDevice = devData.devices.find(d => d.mac_address === selectedMac);

  return (
    <div className="fade-in">
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><ShieldCheck size={20} style={{ marginRight: 8 }} />Cihaz Servis Yapılandırması</h3>
        </div>
        <p className="subtitle">Her cihaz için aktif servisleri ve yapılandırmalarını yönetin</p>

        <div className="form-group" style={{ maxWidth: 400, marginTop: 16 }}>
          <label>Cihaz Seçin</label>
          <select value={selectedMac} onChange={e => setSelectedMac(e.target.value)}>
            {devData.devices.map(d => (
              <option key={d.mac_address} value={d.mac_address}>
                {d.hostname} ({d.ip_address})
              </option>
            ))}
          </select>
        </div>

        {selectedDevice && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            <span className="badge badge-info">{selectedDevice.device_type}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{selectedDevice.mac_address}</span>
          </div>
        )}
      </div>

      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
            <Loader2 size={24} className="spin" />
          </div>
        ) : services.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck size={40} />
            <p>Bu cihaz için servis ataması bulunmuyor</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {services.map(svc => (
              <ServiceCard key={svc.id} svc={svc} onUpdate={() => fetchServices(selectedMac)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { Activity, ArrowDown, ArrowUp, Gauge, Settings, Wifi, Save } from 'lucide-react';
import { useApi, putApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';

type BandwidthTab = 'live' | 'limits';

interface LiveEntry {
  device_mac: string;
  hostname: string;
  bytes_in: number;
  bytes_out: number;
  speed_in_kbps: number;
  speed_out_kbps: number;
  timestamp: string;
}

interface LimitEntry {
  device_mac: string;
  daily_limit_mb: number;
  monthly_limit_mb: number;
  enabled: number;
  hostname?: string;
}

export function BandwidthPanel() {
  const [activeTab, setActiveTab] = useState<BandwidthTab>('live');
  const { data: liveData } = useApi<{ live: LiveEntry[] }>('/bandwidth/live', { live: [] }, 3000);
  const { data: limitsData, refetch: refetchLimits } = useApi<{ limits: LimitEntry[] }>('/bandwidth/limits', { limits: [] });
  const [editingLimits, setEditingLimits] = useState<Record<string, { daily: string; monthly: string }>>({});
  const [saving, setSaving] = useState(false);

  const tabs: { id: BandwidthTab; label: string; icon: React.ReactNode }[] = [
    { id: 'live', label: 'Canli Izleme', icon: <Activity size={14} /> },
    { id: 'limits', label: 'Kota Yonetimi', icon: <Settings size={14} /> },
  ];

  const formatSpeed = (kbps: number) => {
    if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} Mbps`;
    return `${kbps} kbps`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  };


  const totalIn = liveData.live.reduce((s, d) => s + d.speed_in_kbps, 0);
  const totalOut = liveData.live.reduce((s, d) => s + d.speed_out_kbps, 0);
  const activeDevices = liveData.live.filter(d => d.speed_in_kbps > 0 || d.speed_out_kbps > 0).length;
  const maxSpeed = Math.max(...liveData.live.map(d => Math.max(d.speed_in_kbps, d.speed_out_kbps)), 1);

  const handleLimitChange = (mac: string, field: 'daily' | 'monthly', value: string) => {
    setEditingLimits(prev => ({
      ...prev,
      [mac]: { ...prev[mac], [field]: value },
    }));
  };

  const handleSaveLimit = async (mac: string, current: LimitEntry) => {
    const edit = editingLimits[mac];
    if (!edit) return;
    setSaving(true);
    try {
      await putApi(`/bandwidth/limits/${mac}`, {
        daily_limit_mb: Number(edit.daily) || current.daily_limit_mb,
        monthly_limit_mb: Number(edit.monthly) || current.monthly_limit_mb,
        enabled: current.enabled,
      });
      setEditingLimits(prev => {
        const next = { ...prev };
        delete next[mac];
        return next;
      });
      await refetchLimits();
    } catch { /* */ }
    setSaving(false);
  };

  return (
    <div className="fade-in">
      <Panel title="Bant Genisligi Yonetimi" icon={<Gauge size={20} style={{ marginRight: 8 }} />}
        subtitle="Cihaz bazli bant genisligi izleme ve kota yonetimi">
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

      {activeTab === 'live' && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<ArrowDown size={20} />} label="Toplam Indirme" value={formatSpeed(totalIn)} color="blue" />
            <StatCard icon={<ArrowUp size={20} />} label="Toplam Yukleme" value={formatSpeed(totalOut)} color="green" />
            <StatCard icon={<Wifi size={20} />} label="Aktif Cihaz" value={activeDevices} color="purple" />
            <StatCard icon={<Activity size={20} />} label="Izlenen Cihaz" value={liveData.live.length} color="orange" />
          </div>

          <div style={{ marginTop: 14 }}>
            <Panel title="Cihaz Bazli Trafik">
              <div className="blocked-list">
                <div className="ban-row" style={{ opacity: 0.6 }}>
                  <span className="ban-ip" style={{ flex: 2 }}>Cihaz</span>
                  <span style={{ flex: 1 }}>Indirme</span>
                  <span style={{ flex: 1 }}>Yukleme</span>
                  <span style={{ flex: 1 }}>Toplam Veri</span>
                </div>
                {liveData.live.length === 0 && (
                  <div className="empty-state" style={{ padding: '20px' }}>Aktif cihaz bulunamadi.</div>
                )}
                {liveData.live.map(device => (
                  <div key={device.device_mac} className="ban-row">
                    <div style={{ flex: 2 }}>
                      <strong>{device.hostname || device.device_mac}</strong>
                      <br />
                      <span className="text-muted" style={{ fontSize: '0.75rem' }}>{device.device_mac}</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="query-type-row">
                        <div className="progress-bar">
                          <div className="progress-fill progress-cpu"
                            style={{ width: `${(device.speed_in_kbps / maxSpeed) * 100}%` }} />
                        </div>
                      </div>
                      <span style={{ fontSize: '0.75rem' }}>
                        <ArrowDown size={10} /> {formatSpeed(device.speed_in_kbps)}
                      </span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="query-type-row">
                        <div className="progress-bar">
                          <div className="progress-fill progress-mem"
                            style={{ width: `${(device.speed_out_kbps / maxSpeed) * 100}%` }} />
                        </div>
                      </div>
                      <span style={{ fontSize: '0.75rem' }}>
                        <ArrowUp size={10} /> {formatSpeed(device.speed_out_kbps)}
                      </span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Badge variant="info">{formatBytes(device.bytes_in + device.bytes_out)}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'limits' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Cihaz Kotalari" icon={<Settings size={18} style={{ marginRight: 8 }} />}>
            <div className="blocked-list">
              <div className="ban-row" style={{ opacity: 0.6 }}>
                <span style={{ flex: 2 }}>Cihaz (MAC)</span>
                <span style={{ flex: 1 }}>Gunluk Limit (MB)</span>
                <span style={{ flex: 1 }}>Aylik Limit (MB)</span>
                <span style={{ flex: 0.5 }}>Durum</span>
                <span style={{ flex: 0.5 }}></span>
              </div>
              {limitsData.limits.length === 0 && (
                <div className="empty-state" style={{ padding: '20px' }}>Kota tanimli cihaz yok.</div>
              )}
              {limitsData.limits.map(limit => {
                const editing = editingLimits[limit.device_mac];
                return (
                  <div key={limit.device_mac} className="ban-row">
                    <div style={{ flex: 2 }}>
                      <strong>{limit.hostname || limit.device_mac}</strong>
                      <br />
                      <span className="text-muted" style={{ fontSize: '0.75rem' }}>{limit.device_mac}</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <input className="config-input" type="number"
                        value={editing?.daily ?? limit.daily_limit_mb}
                        onChange={e => handleLimitChange(limit.device_mac, 'daily', e.target.value)} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <input className="config-input" type="number"
                        value={editing?.monthly ?? limit.monthly_limit_mb}
                        onChange={e => handleLimitChange(limit.device_mac, 'monthly', e.target.value)} />
                    </div>
                    <div style={{ flex: 0.5 }}>
                      <Badge variant={limit.enabled ? 'success' : 'neutral'}>
                        {limit.enabled ? 'Aktif' : 'Pasif'}
                      </Badge>
                    </div>
                    <div style={{ flex: 0.5 }}>
                      {editing && (
                        <button className="btn-primary btn-sm" onClick={() => handleSaveLimit(limit.device_mac, limit)} disabled={saving}>
                          <Save size={12} /> Kaydet
                        </button>
                      )}
                    </div>
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

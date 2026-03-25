import { useState } from 'react';
import {
  Clock, Gauge, BarChart3, Plus, Check, X, Trash2, Edit3,
  ArrowDown, ArrowUp, Activity
} from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import type { TrafficRule, TrafficSchedule, ThrottleRule } from '../types';

type TrafficTab = 'scheduler' | 'throttle' | 'analytics';

export function TrafficControlPanel() {
  const [activeTab, setActiveTab] = useState<TrafficTab>('scheduler');

  const tabs: { id: TrafficTab; label: string; icon: React.ReactNode }[] = [
    { id: 'scheduler', label: 'Zamanlayici', icon: <Clock size={14} /> },
    { id: 'throttle', label: 'Hiz Limitleme', icon: <Gauge size={14} /> },
    { id: 'analytics', label: 'Trafik Analizi', icon: <BarChart3 size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel
        title="Trafik Kontrolu"
        icon={<Activity size={20} style={{ marginRight: 8 }} />}
        subtitle="Zamanlama, hiz limitleme ve trafik analizi"
      >
        <div className="service-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'scheduler' && <SchedulerView />}
      {activeTab === 'throttle' && <ThrottleView />}
      {activeTab === 'analytics' && <AnalyticsView />}
    </div>
  );
}

const DAY_LABELS: { key: string; label: string }[] = [
  { key: 'mon', label: 'Pzt' }, { key: 'tue', label: 'Sal' }, { key: 'wed', label: 'Car' },
  { key: 'thu', label: 'Per' }, { key: 'fri', label: 'Cum' }, { key: 'sat', label: 'Cmt' },
  { key: 'sun', label: 'Paz' },
];

function SchedulerView() {
  const { data, refetch } = useApi<{ schedules: TrafficSchedule[] }>('/routing/schedules', { schedules: [] });
  const { data: rulesData } = useApi<{ rules: TrafficRule[] }>('/routing/rules', { rules: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [newSchedule, setNewSchedule] = useState({
    traffic_routing_id: 0,
    schedule_route_type: 'direct',
    time_start: '09:00',
    time_end: '17:00',
    days_of_week: '',
  });
  const [selectedDays, setSelectedDays] = useState<string[]>([]);

  const toggleDay = (day: string) => {
    setSelectedDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  };

  const handleAdd = async () => {
    if (!newSchedule.traffic_routing_id || selectedDays.length === 0) return;
    try {
      await postApi('/routing/schedules', {
        traffic_routing_id: newSchedule.traffic_routing_id,
        schedule_route_type: newSchedule.schedule_route_type,
        time_start: newSchedule.time_start,
        time_end: newSchedule.time_end,
        days_of_week: selectedDays.join(','),
      });
      setNewSchedule({ traffic_routing_id: 0, schedule_route_type: 'direct', time_start: '09:00', time_end: '17:00', days_of_week: '' });
      setSelectedDays([]);
      setShowAdd(false);
      await refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteApi(`/routing/schedules/${id}`);
      await refetch();
    } catch { /* */ }
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Clock size={18} style={{ marginRight: 8 }} />Zamanlayici Kurallari</h3>
          <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Yeni Zamanlama
          </button>
        </div>

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label>Trafik Kurali</label>
                <select className="config-select" value={newSchedule.traffic_routing_id}
                  onChange={e => setNewSchedule({ ...newSchedule, traffic_routing_id: Number(e.target.value) })}>
                  <option value={0}>Kural secin...</option>
                  {rulesData.rules.map(r => (
                    <option key={r.id} value={r.id}>{r.app_name} ({r.category})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Yonlendirme Tipi</label>
                <select className="config-select" value={newSchedule.schedule_route_type}
                  onChange={e => setNewSchedule({ ...newSchedule, schedule_route_type: e.target.value })}>
                  <option value="direct">Direkt ISP</option>
                  <option value="adblock">Reklamsız (Pi-hole + ISP)</option>
                  <option value="vpn">VPN (Pi-hole + VPN)</option>
                  <option value="dpi">DPI (Zapret)</option>
                  <option value="adblock_dpi">Reklamsız DPI (Pi-hole + Zapret)</option>
                  <option value="blocked">Engelle</option>
                </select>
              </div>
              <div className="form-group">
                <label>Baslangic Saati</label>
                <input className="config-input" type="time" value={newSchedule.time_start}
                  onChange={e => setNewSchedule({ ...newSchedule, time_start: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Bitis Saati</label>
                <input className="config-input" type="time" value={newSchedule.time_end}
                  onChange={e => setNewSchedule({ ...newSchedule, time_end: e.target.value })} />
              </div>
            </div>
            <div className="form-group" style={{ marginTop: 8 }}>
              <label>Gunler</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {DAY_LABELS.map(d => (
                  <button key={d.key}
                    className={`btn-sm ${selectedDays.includes(d.key) ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => toggleDay(d.key)}
                    style={{ minWidth: 42 }}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="cron-add-actions" style={{ marginTop: 10 }}>
              <button className="btn-primary btn-sm" onClick={handleAdd}
                disabled={!newSchedule.traffic_routing_id || selectedDays.length === 0}>
                <Check size={13} /> Ekle
              </button>
              <button className="btn-outline btn-sm" onClick={() => setShowAdd(false)}>
                <X size={13} /> Iptal
              </button>
            </div>
          </div>
        )}

        <div className="list-items">
          {data.schedules.map(schedule => {
            const days = schedule.days_of_week ? schedule.days_of_week.split(',') : [];
            const dayNames = days.map(d => DAY_LABELS.find(dl => dl.key === d)?.label || d).join(', ');
            return (
              <div key={schedule.id} className="list-item">
                <button
                  className={`toggle-btn toggle-sm ${schedule.enabled ? 'toggle-on' : 'toggle-off'}`}
                  onClick={() => { /* read-only toggle display */ }}
                >
                  <div className="toggle-knob" />
                </button>
                <div style={{ flex: 1 }}>
                  <strong>{schedule.app_name || `Kural #${schedule.traffic_routing_id}`}</strong>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    {schedule.time_start} - {schedule.time_end} &middot; {dayNames}
                  </div>
                </div>
                <Badge variant={
                  schedule.schedule_route_type === 'blocked' ? 'error' :
                  schedule.schedule_route_type === 'vpn' ? 'info' :
                  schedule.schedule_route_type === 'dpi' ? 'warning' :
                  schedule.schedule_route_type === 'adblock_dpi' ? 'error' :
                  schedule.schedule_route_type === 'adblock' ? 'success' : 'neutral'
                }>
                  {{
                    direct: 'Direkt ISP',
                    adblock: 'Reklamsız',
                    vpn: 'VPN',
                    dpi: 'DPI',
                    adblock_dpi: 'Reklamsız DPI',
                    blocked: 'Engelli',
                  }[schedule.schedule_route_type] || schedule.schedule_route_type}
                </Badge>
                <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(schedule.id)} title="Sil">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {data.schedules.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Clock size={32} />
              <p>Henuz zamanlama kurali olusturulmadi</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ThrottleView() {
  const { data, refetch } = useApi<{ rules: ThrottleRule[] }>('/throttle/rules', { rules: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [newRule, setNewRule] = useState({
    target_type: 'device' as 'device' | 'app' | 'group',
    target_value: '',
    max_download_kbps: 1000,
    max_upload_kbps: 500,
  });
  const [editData, setEditData] = useState({ target_value: '', max_download_kbps: 0, max_upload_kbps: 0 });

  const handleAdd = async () => {
    if (!newRule.target_value) return;
    try {
      await postApi('/throttle/rules', {
        target_type: newRule.target_type,
        target_value: newRule.target_value,
        max_download_kbps: newRule.max_download_kbps,
        max_upload_kbps: newRule.max_upload_kbps,
      });
      setNewRule({ target_type: 'device', target_value: '', max_download_kbps: 1000, max_upload_kbps: 500 });
      setShowAdd(false);
      await refetch();
    } catch { /* */ }
  };

  const handleToggle = async (rule: ThrottleRule) => {
    try {
      await putApi(`/throttle/rules/${rule.id}`, { enabled: rule.enabled ? 0 : 1 });
      await refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteApi(`/throttle/rules/${id}`);
      await refetch();
    } catch { /* */ }
  };

  const startEdit = (rule: ThrottleRule) => {
    setEditId(rule.id);
    setEditData({ target_value: rule.target_value, max_download_kbps: rule.max_download_kbps, max_upload_kbps: rule.max_upload_kbps });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    try {
      await putApi(`/throttle/rules/${editId}`, {
        target_value: editData.target_value,
        max_download_kbps: editData.max_download_kbps,
        max_upload_kbps: editData.max_upload_kbps,
      });
      setEditId(null);
      await refetch();
    } catch { /* */ }
  };

  const maxBandwidth = 10000;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Gauge size={18} style={{ marginRight: 8 }} />Hiz Limitleme Kurallari</h3>
          <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Yeni Kural
          </button>
        </div>

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label>Hedef Tipi</label>
                <select className="config-select" value={newRule.target_type}
                  onChange={e => setNewRule({ ...newRule, target_type: e.target.value as 'device' | 'app' | 'group' })}>
                  <option value="device">Cihaz</option>
                  <option value="app">Uygulama</option>
                  <option value="group">Grup</option>
                </select>
              </div>
              <div className="form-group">
                <label>Hedef</label>
                <input className="config-input" type="text" placeholder="Cihaz MAC, uygulama adi veya grup"
                  value={newRule.target_value} onChange={e => setNewRule({ ...newRule, target_value: e.target.value })} />
              </div>
              <div className="form-group">
                <label><ArrowDown size={12} /> Maks Indirme (kbps)</label>
                <input className="config-input" type="number" value={newRule.max_download_kbps}
                  onChange={e => setNewRule({ ...newRule, max_download_kbps: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label><ArrowUp size={12} /> Maks Yukleme (kbps)</label>
                <input className="config-input" type="number" value={newRule.max_upload_kbps}
                  onChange={e => setNewRule({ ...newRule, max_upload_kbps: Number(e.target.value) })} />
              </div>
            </div>
            <div className="cron-add-actions">
              <button className="btn-primary btn-sm" onClick={handleAdd} disabled={!newRule.target_value}>
                <Check size={13} /> Ekle
              </button>
              <button className="btn-outline btn-sm" onClick={() => setShowAdd(false)}>
                <X size={13} /> Iptal
              </button>
            </div>
          </div>
        )}

        <div className="list-items">
          {data.rules.map(rule => (
            <div key={rule.id} className={`list-item ${!rule.enabled ? 'cron-row-disabled' : ''}`}>
              {editId === rule.id ? (
                <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'center' }}>
                  <input className="config-input" value={editData.target_value}
                    onChange={e => setEditData({ ...editData, target_value: e.target.value })} />
                  <input className="config-input" type="number" value={editData.max_download_kbps}
                    onChange={e => setEditData({ ...editData, max_download_kbps: Number(e.target.value) })}
                    style={{ width: 100 }} />
                  <input className="config-input" type="number" value={editData.max_upload_kbps}
                    onChange={e => setEditData({ ...editData, max_upload_kbps: Number(e.target.value) })}
                    style={{ width: 100 }} />
                  <button className="btn-primary btn-sm" onClick={saveEdit}><Check size={13} /></button>
                  <button className="btn-outline btn-sm" onClick={() => setEditId(null)}><X size={13} /></button>
                </div>
              ) : (
                <>
                  <button
                    className={`toggle-btn toggle-sm ${rule.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleToggle(rule)}
                  >
                    <div className="toggle-knob" />
                  </button>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{rule.target_value}</strong>
                      <Badge variant="neutral">{rule.target_type === 'device' ? 'Cihaz' : rule.target_type === 'app' ? 'Uygulama' : 'Grup'}</Badge>
                    </div>
                    <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
                          <ArrowDown size={10} /> Indirme: {rule.max_download_kbps} kbps
                        </div>
                        <div style={{
                          height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden'
                        }}>
                          <div style={{
                            height: '100%', borderRadius: 3, background: '#3b82f6',
                            width: `${Math.min((rule.max_download_kbps / maxBandwidth) * 100, 100)}%`
                          }} />
                        </div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
                          <ArrowUp size={10} /> Yukleme: {rule.max_upload_kbps} kbps
                        </div>
                        <div style={{
                          height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden'
                        }}>
                          <div style={{
                            height: '100%', borderRadius: 3, background: '#8b5cf6',
                            width: `${Math.min((rule.max_upload_kbps / maxBandwidth) * 100, 100)}%`
                          }} />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="icon-btn icon-btn-sm" onClick={() => startEdit(rule)} title="Duzenle">
                      <Edit3 size={13} />
                    </button>
                    <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(rule.id)} title="Sil">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {data.rules.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Gauge size={32} />
              <p>Henuz hiz limitleme kurali olusturulmadi</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AnalyticsView() {
  const topDevices = [
    { name: 'MacBook Pro', bandwidth: 4200 },
    { name: 'iPhone 15', bandwidth: 2800 },
    { name: 'Smart TV', bandwidth: 2100 },
    { name: 'iPad Air', bandwidth: 1500 },
    { name: 'Raspberry Pi', bandwidth: 900 },
  ];

  const topApps = [
    { name: 'YouTube', bandwidth: 3500 },
    { name: 'Netflix', bandwidth: 2900 },
    { name: 'Steam', bandwidth: 1800 },
    { name: 'Spotify', bandwidth: 800 },
    { name: 'Discord', bandwidth: 400 },
  ];

  const hourlyTraffic = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    volume: Math.floor(Math.random() * 800 + (i >= 9 && i <= 23 ? 400 : 50))
  }));
  const maxHourly = Math.max(...hourlyTraffic.map(h => h.volume));

  const maxDeviceBw = Math.max(...topDevices.map(d => d.bandwidth));
  const maxAppBw = Math.max(...topApps.map(a => a.bandwidth));

  return (
    <div style={{ marginTop: 14 }}>
      <div className="stats-grid stats-grid-4" style={{ marginBottom: 14 }}>
        <div className="glass-panel stat-card">
          <ArrowDown size={20} style={{ color: '#3b82f6' }} />
          <div className="stat-value" style={{ fontSize: 20 }}>12.4 GB</div>
          <div className="stat-label">Toplam Indirme</div>
        </div>
        <div className="glass-panel stat-card">
          <ArrowUp size={20} style={{ color: '#8b5cf6' }} />
          <div className="stat-value" style={{ fontSize: 20 }}>3.2 GB</div>
          <div className="stat-label">Toplam Yukleme</div>
        </div>
        <div className="glass-panel stat-card">
          <Activity size={20} style={{ color: '#10b981' }} />
          <div className="stat-value" style={{ fontSize: 20 }}>48,291</div>
          <div className="stat-label">Toplam Sorgu</div>
        </div>
        <div className="glass-panel stat-card">
          <BarChart3 size={20} style={{ color: '#f59e0b' }} />
          <div className="stat-value" style={{ fontSize: 20 }}>14:00-16:00</div>
          <div className="stat-label">Pik Saat</div>
        </div>
      </div>

      <div className="panel-row">
        <div className="glass-panel widget-medium">
          <div className="widget-header">
            <h3><ArrowDown size={16} style={{ marginRight: 6 }} />En Cok Bant Genisligi Kullanan Cihazlar</h3>
          </div>
          <div style={{ padding: '12px 0' }}>
            {topDevices.map((device, i) => (
              <div key={device.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <span style={{ width: 20, textAlign: 'right', fontSize: 12, color: '#94a3b8' }}>{i + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 13 }}>
                    <span>{device.name}</span>
                    <span className="text-muted">{(device.bandwidth / 1000).toFixed(1)} GB</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 4, background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
                      width: `${(device.bandwidth / maxDeviceBw) * 100}%`, transition: 'width 0.5s ease'
                    }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel widget-medium">
          <div className="widget-header">
            <h3><BarChart3 size={16} style={{ marginRight: 6 }} />En Cok Bant Genisligi Kullanan Uygulamalar</h3>
          </div>
          <div style={{ padding: '12px 0' }}>
            {topApps.map((app, i) => (
              <div key={app.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <span style={{ width: 20, textAlign: 'right', fontSize: 12, color: '#94a3b8' }}>{i + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 13 }}>
                    <span>{app.name}</span>
                    <span className="text-muted">{(app.bandwidth / 1000).toFixed(1)} GB</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 4, background: 'linear-gradient(90deg, #8b5cf6, #a78bfa)',
                      width: `${(app.bandwidth / maxAppBw) * 100}%`, transition: 'width 0.5s ease'
                    }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        <div className="widget-header">
          <h3><Clock size={16} style={{ marginRight: 6 }} />Saatlik Trafik Dagilimi</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120, padding: '12px 0' }}>
          {hourlyTraffic.map(h => (
            <div key={h.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: '100%', borderRadius: '3px 3px 0 0',
                background: h.volume > maxHourly * 0.7 ? '#ef4444' : h.volume > maxHourly * 0.4 ? '#f59e0b' : '#10b981',
                height: `${(h.volume / maxHourly) * 100}%`, minHeight: 2,
                opacity: 0.8, transition: 'height 0.3s ease'
              }} />
              <span style={{ fontSize: 9, color: '#64748b' }}>{h.hour.toString().padStart(2, '0')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

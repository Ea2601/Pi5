import { useState } from 'react';
import {
  Clock, Gauge, BarChart3, Plus, Check, X, Trash2, Edit3,
  ArrowDown, ArrowUp, Activity, Shield
} from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import type { TrafficRule, TrafficSchedule, ThrottleRule } from '../types';

interface VpsServer { id: number; ip: string; location: string }

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

function getScheduleLabel(exitNode: string, dpi: number, vpsList: VpsServer[]): string {
  if (exitNode === 'blocked') return 'Engelli';
  const vps = exitNode !== 'isp' ? vpsList.find(v => String(v.id) === exitNode) : null;
  const base = vps ? `VPS ${vps.location}` : 'ISP (Direkt)';
  return dpi ? `${base} + DPI` : base;
}

function getScheduleBadgeVariant(exitNode: string, dpi: number): 'neutral' | 'info' | 'warning' | 'error' {
  if (exitNode === 'blocked') return 'error';
  if (exitNode === 'isp') return dpi ? 'warning' : 'neutral';
  return dpi ? 'error' : 'info';
}

function SchedulerView() {
  const { data, refetch } = useApi<{ schedules: TrafficSchedule[] }>('/routing/schedules', { schedules: [] });
  const { data: rulesData } = useApi<{ rules: TrafficRule[] }>('/routing/rules', { rules: [] });
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [newSchedule, setNewSchedule] = useState({
    traffic_routing_id: 0,
    schedule_exit_node: 'isp',
    schedule_dpi_bypass: 0,
    time_start: '09:00',
    time_end: '17:00',
    days_of_week: '',
  });
  const [selectedDays, setSelectedDays] = useState<string[]>([]);
  const vpsList = vpsData.servers;

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
        schedule_exit_node: newSchedule.schedule_exit_node,
        schedule_dpi_bypass: newSchedule.schedule_dpi_bypass,
        time_start: newSchedule.time_start,
        time_end: newSchedule.time_end,
        days_of_week: selectedDays.join(','),
      });
      setNewSchedule({ traffic_routing_id: 0, schedule_exit_node: 'isp', schedule_dpi_bypass: 0, time_start: '09:00', time_end: '17:00', days_of_week: '' });
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
                <label>Çıkış Noktası</label>
                <select className="config-select" value={newSchedule.schedule_exit_node}
                  onChange={e => setNewSchedule({ ...newSchedule, schedule_exit_node: e.target.value })}>
                  <option value="isp">ISP (Direkt)</option>
                  {vpsList.map(v => (
                    <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                  ))}
                  <option value="blocked">Engelle</option>
                </select>
              </div>
              <div className="form-group">
                <label><Shield size={12} /> DPI Bypass</label>
                <button
                  className={`btn-sm ${newSchedule.schedule_dpi_bypass ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setNewSchedule({ ...newSchedule, schedule_dpi_bypass: newSchedule.schedule_dpi_bypass ? 0 : 1 })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Shield size={12} />
                  DPI {newSchedule.schedule_dpi_bypass ? 'ON' : 'OFF'}
                </button>
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
            const exitNode = (schedule as any).schedule_exit_node || schedule.schedule_route_type || 'isp';
            const dpi = (schedule as any).schedule_dpi_bypass || 0;
            const label = getScheduleLabel(exitNode, dpi, vpsList);
            const badgeVariant = getScheduleBadgeVariant(exitNode, dpi);
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
                <Badge variant={badgeVariant}>
                  {label}
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
  return (
    <div style={{ marginTop: 14 }}>
      <div className="empty-state" style={{ padding: 50 }}>
        <BarChart3 size={40} />
        <p>Trafik analizi Pi5 gateway modunda aktif olduğunda gerçek verilerle doldurulacaktır.</p>
        <span className="text-muted" style={{ fontSize: 12 }}>
          Pi5 router olarak çalıştığında cihaz bazlı bant genişliği, uygulama trafiği ve saatlik dağılım burada gösterilecek.
        </span>
      </div>
    </div>
  );
}

import { useState } from 'react';
import {
  Clock, Gauge, BarChart3, Plus, Check, X, Trash2, Activity, Shield
} from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge, Select } from './ui';
import type { TrafficRule, TrafficSchedule } from '../types';
import { TrafficAnalytics } from './TrafficAnalytics';
import { openBandwidthLimits } from '../nav';

interface VpsServer { id: number; ip: string; location: string }

type TrafficTab = 'scheduler' | 'analytics';

export function TrafficControlPanel() {
  const [activeTab, setActiveTab] = useState<TrafficTab>('scheduler');

  // Hız Limitleme Bant Genişliği → Kota ve Hız'a taşındı (cihaz hız sınırı orada Pi'ye uygulanır; eskiden buradaki kurallar
  // yalnız veritabanına yazılıyordu): sekme oraya götürür.
  const tabs: { id: TrafficTab | 'speed'; label: string; icon: React.ReactNode }[] = [
    { id: 'scheduler', label: 'Zamanlayici', icon: <Clock size={14} /> },
    { id: 'speed', label: 'Hız Limitleme', icon: <Gauge size={14} /> },
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
              onClick={() => (tab.id === 'speed' ? openBandwidthLimits() : setActiveTab(tab.id))}
              title={tab.id === 'speed' ? 'Cihaz hız sınırı ve kota: Bant Genişliği → Kota ve Hız' : undefined}
            >
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'scheduler' && <SchedulerView />}
      {activeTab === 'analytics' && <TrafficAnalytics />}
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

  const handleToggle = async (schedule: TrafficSchedule) => {
    try {
      await putApi(`/routing/schedules/${schedule.id}`, { enabled: schedule.enabled ? 0 : 1 });
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
                <Select className="config-select" value={newSchedule.traffic_routing_id}
                  onChange={e => setNewSchedule({ ...newSchedule, traffic_routing_id: Number(e.target.value) })}>
                  <option value={0}>Kural secin...</option>
                  {rulesData.rules.map(r => (
                    <option key={r.id} value={r.id}>{r.app_name} ({r.category})</option>
                  ))}
                </Select>
              </div>
              <div className="form-group">
                <label>Çıkış Noktası</label>
                <Select className="config-select" value={newSchedule.schedule_exit_node}
                  onChange={e => setNewSchedule({ ...newSchedule, schedule_exit_node: e.target.value })}>
                  <option value="isp">ISP (Direkt)</option>
                  {vpsList.map(v => (
                    <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                  ))}
                  <option value="blocked">Engelle</option>
                </Select>
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
                  onClick={() => handleToggle(schedule)}
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

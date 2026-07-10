import { Shield, Clock, Globe, Ban, Plus, Trash2, Settings } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Badge } from './ui';
import type { Device, ParentalRule } from '../types';


const DAY_MAP: Record<string, string> = {
  mon: 'Pzt', tue: 'Sal', wed: 'Car', thu: 'Per', fri: 'Cum', sat: 'Cmt', sun: 'Paz',
};

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const RULE_TYPE_LABELS: Record<string, string> = {
  time_restrict: 'Zaman Kisitlamasi',
  category_block: 'Kategori Engelleme',
  site_block: 'Site Engelleme',
};

const CATEGORIES = [
  { value: 'adult_content', label: 'Yetiskin Icerik' },
  { value: 'gambling', label: 'Kumar' },
  { value: 'social_media', label: 'Sosyal Medya' },
  { value: 'gaming', label: 'Oyun' },
  { value: 'streaming', label: 'Video/Streaming' },
  { value: 'ads', label: 'Reklamlar' },
];

export function ParentalPanel() {
  const { data, refetch } = useApi<{ rules: ParentalRule[] }>('/parental/rules', { rules: [] });
  const { data: devicesData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });

  const [showForm, setShowForm] = useState(false);
  const [formTarget, setFormTarget] = useState('');
  const [formType, setFormType] = useState<string>('time_restrict');
  const [formValue, setFormValue] = useState('');
  const [formStartTime, setFormStartTime] = useState('22:00');
  const [formEndTime, setFormEndTime] = useState('08:00');
  const [formDays, setFormDays] = useState<string[]>([...ALL_DAYS]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setFormTarget('');
    setFormType('time_restrict');
    setFormValue('');
    setFormStartTime('22:00');
    setFormEndTime('08:00');
    setFormDays([...ALL_DAYS]);
    setShowForm(false);
    setError(null);
  };

  const handleAdd = async () => {
    if (!formTarget.trim()) return;
    setError(null);
    // category_block / site_block için değer zorunlu — boşsa backend 400 döner ve önceden sessiz kalıyordu
    if ((formType === 'category_block' || formType === 'site_block') && !formValue.trim()) {
      setError(formType === 'site_block' ? 'Lütfen engellenecek siteyi girin.' : 'Lütfen bir kategori seçin.');
      return;
    }
    setSaving(true);
    try {
      let value = formValue;
      if (formType === 'time_restrict' && !value) value = 'internet_access';

      await postApi('/parental/rules', {
        device_mac_or_group: formTarget,
        rule_type: formType,
        value,
        schedule_start: formType === 'time_restrict' ? formStartTime : '',
        schedule_end: formType === 'time_restrict' ? formEndTime : '',
        days_of_week: formType === 'time_restrict' ? formDays.join(',') : '',
      });
      resetForm();
      await refetch();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Kural eklenemedi.');
    }
    setSaving(false);
  };

  const handleToggle = async (rule: ParentalRule) => {
    try {
      await putApi(`/parental/rules/${rule.id}`, { enabled: rule.enabled ? 0 : 1 });
      await refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteApi(`/parental/rules/${id}`);
      await refetch();
    } catch { /* */ }
  };

  const toggleDay = (day: string) => {
    setFormDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  };

  const ruleTypeIcon = (type: string) => {
    switch (type) {
      case 'time_restrict': return <Clock size={14} />;
      case 'category_block': return <Ban size={14} />;
      case 'site_block': return <Globe size={14} />;
      default: return <Shield size={14} />;
    }
  };

  const formatDays = (daysStr: string) => {
    if (!daysStr) return '';
    return daysStr.split(',').map(d => DAY_MAP[d.trim()] || d).join(', ');
  };

  return (
    <div className="fade-in">
      <Panel title="Ebeveyn Kontrolleri" icon={<Shield size={20} style={{ marginRight: 8 }} />}
        subtitle="Internet erisim kisitlamalari ve icerik filtreleme"
        badge={<Badge variant="info">{data.rules.length} kural</Badge>}
        actions={
          <button className="btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
            <Plus size={14} /> Kural Ekle
          </button>
        }>
        <div />
      </Panel>

      {showForm && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Yeni Kural Olustur" icon={<Settings size={18} style={{ marginRight: 8 }} />}>
            <div className="list-add-form">
              <div className="list-add-row">
                <select className="config-input" value={formTarget}
                  onChange={e => setFormTarget(e.target.value)}
                  style={{ flex: 2 }}>
                  <option value="">Hedef secin...</option>
                  <optgroup label="Cihazlar">
                    {devicesData.devices.map(d => (
                      <option key={d.mac_address} value={d.mac_address}>
                        {d.hostname || d.ip_address} ({d.mac_address})
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Gruplar">
                    <option value="cocuklar">Cocuklar</option>
                    <option value="aile">Aile</option>
                  </optgroup>
                </select>
                <select className="config-input" value={formType}
                  onChange={e => setFormType(e.target.value)}
                  style={{ flex: 1 }}>
                  <option value="time_restrict">Zaman Kisitlamasi</option>
                  <option value="category_block">Kategori Engelleme</option>
                  <option value="site_block">Site Engelleme</option>
                </select>
              </div>

              {formType === 'time_restrict' && (
                <div style={{ marginTop: 12 }}>
                  <label className="text-muted" style={{ fontSize: '0.8rem', display: 'block', marginBottom: 6 }}>
                    <Clock size={12} /> Erisim Zamani
                  </label>
                  <div className="list-add-row">
                    <div style={{ flex: 1 }}>
                      <label className="text-muted" style={{ fontSize: '0.7rem' }}>Baslangic</label>
                      <input className="config-input" type="time"
                        value={formStartTime}
                        onChange={e => setFormStartTime(e.target.value)} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label className="text-muted" style={{ fontSize: '0.7rem' }}>Bitis</label>
                      <input className="config-input" type="time"
                        value={formEndTime}
                        onChange={e => setFormEndTime(e.target.value)} />
                    </div>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                    {ALL_DAYS.map(day => (
                      <button key={day}
                        className={`btn-sm ${formDays.includes(day) ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => toggleDay(day)}>
                        {DAY_MAP[day]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {formType === 'category_block' && (
                <div style={{ marginTop: 12 }}>
                  <label className="text-muted" style={{ fontSize: '0.8rem', display: 'block', marginBottom: 6 }}>
                    <Ban size={12} /> Engellenecek Kategori
                  </label>
                  <select className="config-input" value={formValue}
                    onChange={e => setFormValue(e.target.value)}>
                    <option value="">Kategori secin...</option>
                    {CATEGORIES.map(cat => (
                      <option key={cat.value} value={cat.value}>{cat.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {formType === 'site_block' && (
                <div style={{ marginTop: 12 }}>
                  <label className="text-muted" style={{ fontSize: '0.8rem', display: 'block', marginBottom: 6 }}>
                    <Globe size={12} /> Engellenecek Site
                  </label>
                  <input className="config-input" type="text"
                    placeholder="ornek.com"
                    value={formValue}
                    onChange={e => setFormValue(e.target.value)} />
                </div>
              )}

              {error && (
                <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', color: '#ef4444', fontSize: 12 }}>
                  {error}
                </div>
              )}
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn-outline btn-sm" onClick={resetForm}>Iptal</button>
                <button className="btn-primary btn-sm" onClick={handleAdd}
                  disabled={saving || !formTarget.trim()}>
                  {saving ? 'Kaydediliyor...' : 'Kaydet'}
                </button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Panel title="Aktif Kurallar">
          <div className="list-items">
            {data.rules.length === 0 && (
              <div className="empty-state" style={{ padding: '20px' }}>Henuz kural tanimlanmamis.</div>
            )}
            {data.rules.map(rule => (
              <div key={rule.id} className={`list-item ${!rule.enabled ? 'list-item-disabled' : ''}`}>
                <button
                  className={`toggle-btn toggle-sm ${rule.enabled ? 'toggle-on' : 'toggle-off'}`}
                  onClick={() => handleToggle(rule)}>
                  <div className="toggle-knob" />
                </button>
                <div className="list-item-content">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {ruleTypeIcon(rule.rule_type)}
                    <span className="list-item-value">{rule.device_mac_or_group}</span>
                    <Badge variant={rule.rule_type === 'time_restrict' ? 'info' : rule.rule_type === 'category_block' ? 'warning' : 'error'}>
                      {RULE_TYPE_LABELS[rule.rule_type] || rule.rule_type}
                    </Badge>
                  </div>
                  <span className="list-item-comment">
                    {rule.value}
                    {rule.rule_type === 'time_restrict' && rule.schedule_start && rule.schedule_end && (
                      <> &middot; {rule.schedule_start} - {rule.schedule_end}</>
                    )}
                    {rule.days_of_week && (
                      <> &middot; {formatDays(rule.days_of_week)}</>
                    )}
                  </span>
                </div>
                <button className="icon-btn icon-btn-sm list-delete" onClick={() => handleDelete(rule.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import {
  Settings, Palette, Globe, Bell, Zap, Info, Save, ChevronDown, ChevronRight,
  Sun, Moon, Volume2, VolumeX, Clock, RefreshCw, Download, Check, X, Loader2
} from 'lucide-react';
import { useApi, putApi, postApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';

interface AppSettings {
  theme: string;
  accentColor: string;
  language: string;
  notificationSound: boolean;
  desktopNotifications: boolean;
  autoRefresh: boolean;
  refreshInterval: number;
}

const defaultSettings: AppSettings = {
  theme: 'dark',
  accentColor: 'blue',
  language: 'tr',
  notificationSound: true,
  desktopNotifications: false,
  autoRefresh: true,
  refreshInterval: 5000,
};

// API key-value nesnesini AppSettings'e dönüştür
function parseApiSettings(raw: Record<string, string>): Partial<AppSettings> {
  return {
    theme: raw.theme || 'dark',
    accentColor: raw.accent_color || raw.accentColor || 'blue',
    language: raw.language || 'tr',
    notificationSound: raw.notification_sound === 'true',
    autoRefresh: raw.auto_refresh === 'true',
    refreshInterval: parseInt(raw.refresh_interval || '5000') || 5000,
  };
}

// AppSettings'i API formatına dönüştür
function toApiSettings(s: AppSettings): Record<string, unknown> {
  return {
    theme: s.theme,
    accent_color: s.accentColor,
    language: s.language,
    notification_sound: String(s.notificationSound),
    auto_refresh: String(s.autoRefresh),
    refresh_interval: String(s.refreshInterval),
  };
}

export function SettingsPanel() {
  const { data } = useApi<{ settings: Record<string, string> }>('/settings', { settings: {} });
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data.settings && Object.keys(data.settings).length > 0 && !loaded) {
      setSettings({ ...defaultSettings, ...parseApiSettings(data.settings) });
      setLoaded(true);
    }
  }, [data.settings, loaded]);

  const handleSave = async () => {
    setSaving(true);
    setResult(null);
    try {
      await putApi('/settings', { settings: toApiSettings(settings) });
      setResult({ type: 'success', msg: 'Ayarlar kaydedildi.' });
    } catch (e: unknown) {
      setResult({ type: 'error', msg: e instanceof Error ? e.message : 'Kaydetme başarısız.' });
    }
    setSaving(false);
  };

  const toggleCollapse = (cat: string) => {
    setCollapsed(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  // Apply theme/accent to DOM immediately
  const applyTheme = (theme: string) => {
    document.documentElement.classList.toggle('light-theme', theme === 'light');
  };

  const applyAccentColor = (color: string) => {
    document.documentElement.classList.remove('accent-green', 'accent-purple', 'accent-orange');
    if (color !== 'blue') {
      document.documentElement.classList.add(`accent-${color}`);
    }
  };

  // Apply settings on load
  useEffect(() => {
    if (loaded) {
      applyTheme(settings.theme);
      applyAccentColor(settings.accentColor);
    }
  }, [loaded]);

  const handleTheme = (theme: 'dark' | 'light') => {
    setSettings(prev => ({ ...prev, theme }));
    applyTheme(theme);
  };

  const requestDesktopNotifications = async () => {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      setSettings(prev => ({ ...prev, desktopNotifications: permission === 'granted' }));
    }
  };

  const accentColors = [
    { value: 'blue', label: 'Mavi', color: '#3b82f6' },
    { value: 'green', label: 'Yeşil', color: '#10b981' },
    { value: 'purple', label: 'Mor', color: '#8b5cf6' },
    { value: 'orange', label: 'Turuncu', color: '#f59e0b' },
  ];

  const categories: { key: string; label: string; icon: React.ReactNode; content: React.ReactNode }[] = [
    {
      key: 'appearance',
      label: 'Görünüm',
      icon: <Palette size={15} />,
      content: (
        <div className="config-items">
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Tema</span>
              <span className="config-item-desc">Arayüz renk temasını değiştir</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', gap: 6 }}>
              <button
                className={`btn-sm ${settings.theme === 'dark' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => handleTheme('dark')}
              >
                <Moon size={13} /> Koyu
              </button>
              <button
                className={`btn-sm ${settings.theme === 'light' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => handleTheme('light')}
              >
                <Sun size={13} /> Açık
              </button>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Vurgu Rengi</span>
              <span className="config-item-desc">Ana tema vurgu rengini seç</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', gap: 6 }}>
              {accentColors.map(c => (
                <button key={c.value}
                  style={{
                    width: 32, height: 32, borderRadius: 8, background: c.color,
                    border: settings.accentColor === c.value ? '2px solid #fff' : '2px solid transparent',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}
                  onClick={() => { setSettings(prev => ({ ...prev, accentColor: c.value })); applyAccentColor(c.value); }}
                  title={c.label}
                />
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'language',
      label: 'Dil',
      icon: <Globe size={15} />,
      content: (
        <div className="config-items">
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Arayüz Dili</span>
              <span className="config-item-desc">Panel arayüz dilini değiştir</span>
            </div>
            <div className="config-item-control">
              <select className="config-select" value={settings.language}
                onChange={e => setSettings(prev => ({ ...prev, language: e.target.value }))}>
                <option value="tr">Türkçe</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'timezone',
      label: 'Saat Dilimi',
      icon: <Clock size={15} />,
      content: <TimezoneSection />,
    },
    {
      key: 'notifications',
      label: 'Bildirimler',
      icon: <Bell size={15} />,
      content: (
        <div className="config-items">
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Bildirim Sesi</span>
              <span className="config-item-desc">Uyarı ve bildirimlerde ses çal</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {settings.notificationSound ? <Volume2 size={14} /> : <VolumeX size={14} />}
              <button
                className={`toggle-btn ${settings.notificationSound ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => setSettings(prev => ({ ...prev, notificationSound: !prev.notificationSound }))}
              >
                <div className="toggle-knob" />
              </button>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Masaüstü Bildirimleri</span>
              <span className="config-item-desc">Tarayıcı masaüstü bildirimlerini etkinleştir</span>
            </div>
            <div className="config-item-control">
              {settings.desktopNotifications ? (
                <Badge variant="success">Etkin</Badge>
              ) : (
                <button className="btn-outline btn-sm" onClick={requestDesktopNotifications}>
                  <Bell size={13} /> İzin Ver
                </button>
              )}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'performance',
      label: 'Performans',
      icon: <Zap size={15} />,
      content: (
        <div className="config-items">
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Otomatik Yenileme</span>
              <span className="config-item-desc">Verileri belirli aralıklarla otomatik güncelle</span>
            </div>
            <div className="config-item-control">
              <button
                className={`toggle-btn ${settings.autoRefresh ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => setSettings(prev => ({ ...prev, autoRefresh: !prev.autoRefresh }))}
              >
                <div className="toggle-knob" />
              </button>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Yenileme Aralığı</span>
              <span className="config-item-desc">Otomatik yenileme süresi (milisaniye)</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clock size={14} />
              <input className="config-input" type="number" value={settings.refreshInterval}
                onChange={e => setSettings(prev => ({ ...prev, refreshInterval: Number(e.target.value) }))}
                style={{ width: 100 }}
                min={1000} step={1000}
                disabled={!settings.autoRefresh} />
              <span className="text-muted" style={{ fontSize: 12 }}>ms</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'update',
      label: 'Sistem Güncellemesi',
      icon: <Download size={15} />,
      content: <UpdateSection />,
    },
    {
      key: 'about',
      label: 'Hakkında',
      icon: <Info size={15} />,
      content: <AboutSection />,
    },
  ];

  return (
    <div className="fade-in">
      <Panel
        title="Ayarlar"
        icon={<Settings size={20} style={{ marginRight: 8 }} />}
        subtitle="Uygulama geneli yapılandırma ve tercihler"
        actions={
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            <Save size={13} /> {saving ? 'Kaydediliyor...' : 'Kaydet'}
          </button>
        }
      >
        {result && (
          <div style={{
            padding: '8px 12px', borderRadius: 6, marginBottom: 10,
            background: result.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
            color: result.type === 'success' ? '#10b981' : '#ef4444', fontSize: 13
          }}>
            {result.msg}
          </div>
        )}

        <div className="service-settings">
          {categories.map(cat => (
            <div key={cat.key} className="config-category">
              <button className="config-category-header" onClick={() => toggleCollapse(cat.key)}>
                <span className="config-category-icon">{cat.icon}</span>
                <span className="config-category-title">{cat.label}</span>
                {collapsed[cat.key] ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              </button>
              {!collapsed[cat.key] && cat.content}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ─── Update Section ───
function UpdateSection() {
  const { data: versionData } = useApi<{ version: string; build: number }>('/system/version', { version: '2.1.0', build: 0 });
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleUpdate = async () => {
    setUpdating(true);
    setUpdateResult(null);
    try {
      const result = await postApi('/system/update', {});
      if (result.success) {
        setUpdateResult({ success: true, message: 'Güncelleme tamamlandı! Servis yeniden başlatılıyor, 8sn sonra sayfa yenilenecek...' });
        setTimeout(() => window.location.reload(), 8000);
      } else {
        const failed = result.steps?.filter((s: any) => !s.success).map((s: any) => s.step).join(', ');
        setUpdateResult({ success: false, message: `Başarısız adımlar: ${failed}` });
      }
    } catch (e: any) {
      setUpdateResult({ success: false, message: e.message || 'Güncelleme başarısız' });
    }
    setUpdating(false);
  };

  return (
    <div className="config-items">
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Mevcut Versiyon</span>
          <span className="config-item-desc">Pi5 Secure Gateway Panel</span>
        </div>
        <div className="config-item-control">
          <Badge variant="info">v{versionData.version} (build {versionData.build})</Badge>
        </div>
      </div>
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Sistemi Güncelle</span>
          <span className="config-item-desc">Git pull + build + servis yeniden başlat</span>
        </div>
        <div className="config-item-control">
          <button
            className={updating ? 'btn-outline btn-sm' : 'btn-primary btn-sm'}
            onClick={handleUpdate}
            disabled={updating}
          >
            {updating ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            <span>{updating ? 'Güncelleniyor...' : 'Güncelle'}</span>
          </button>
        </div>
      </div>
      {updateResult && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, marginTop: 8,
          background: updateResult.success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          color: updateResult.success ? '#10b981' : '#ef4444', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {updateResult.success ? <Check size={14} /> : <X size={14} />}
          {updateResult.message}
        </div>
      )}
    </div>
  );
}

// ─── About Section ───
function AboutSection() {
  const { data } = useApi<{ version: string; build: number; date: string; changelog: string[] }>(
    '/system/version', { version: '2.1.0', build: 0, date: '', changelog: [] }
  );

  return (
    <div className="config-items">
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Versiyon</span>
          <span className="config-item-desc">Pi5 Secure Gateway Panel</span>
        </div>
        <div className="config-item-control">
          <Badge variant="info">v{data.version}</Badge>
          <Badge variant="neutral" >Build {data.build}</Badge>
        </div>
      </div>
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Platform</span>
          <span className="config-item-desc">Raspberry Pi 5 — React 19 + Vite 8 + Express 5</span>
        </div>
        <div className="config-item-control">
          <Badge variant="neutral">Pi 5</Badge>
        </div>
      </div>
      {data.date && (
        <div className="config-item">
          <div className="config-item-info">
            <span className="config-item-label">Son Güncelleme</span>
            <span className="config-item-desc">{data.date}</span>
          </div>
        </div>
      )}
      {data.changelog.length > 0 && (
        <div className="config-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <div className="config-item-info">
            <span className="config-item-label">Değişiklik Geçmişi</span>
            <span className="config-item-desc">v{data.version} ile gelen özellikler</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
            {data.changelog.map((item, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 10px', borderRadius: 6,
                background: 'rgba(255,255,255,0.02)', border: '1px solid var(--panel-border)',
                fontSize: 12, color: 'var(--text-primary)',
              }}>
                <span style={{ color: 'var(--success-color)', flexShrink: 0 }}>+</span>
                {item}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Timezone Section ───
const TIMEZONES: { zone: string; label: string; gmt: string }[] = [
  { zone: 'Pacific/Midway', label: 'Midway Island', gmt: 'GMT-11' },
  { zone: 'Pacific/Honolulu', label: 'Hawaii', gmt: 'GMT-10' },
  { zone: 'America/Anchorage', label: 'Alaska', gmt: 'GMT-9' },
  { zone: 'America/Los_Angeles', label: 'Los Angeles', gmt: 'GMT-8' },
  { zone: 'America/Denver', label: 'Denver', gmt: 'GMT-7' },
  { zone: 'America/Chicago', label: 'Chicago', gmt: 'GMT-6' },
  { zone: 'America/New_York', label: 'New York', gmt: 'GMT-5' },
  { zone: 'America/Sao_Paulo', label: 'São Paulo', gmt: 'GMT-3' },
  { zone: 'Atlantic/Azores', label: 'Azores', gmt: 'GMT-1' },
  { zone: 'UTC', label: 'UTC', gmt: 'GMT+0' },
  { zone: 'Europe/London', label: 'Londra', gmt: 'GMT+0' },
  { zone: 'Europe/Berlin', label: 'Berlin', gmt: 'GMT+1' },
  { zone: 'Europe/Paris', label: 'Paris', gmt: 'GMT+1' },
  { zone: 'Europe/Athens', label: 'Atina', gmt: 'GMT+2' },
  { zone: 'Europe/Istanbul', label: 'İstanbul', gmt: 'GMT+3' },
  { zone: 'Europe/Moscow', label: 'Moskova', gmt: 'GMT+3' },
  { zone: 'Asia/Dubai', label: 'Dubai', gmt: 'GMT+4' },
  { zone: 'Asia/Karachi', label: 'Karaçi', gmt: 'GMT+5' },
  { zone: 'Asia/Kolkata', label: 'Mumbai', gmt: 'GMT+5:30' },
  { zone: 'Asia/Dhaka', label: 'Dakka', gmt: 'GMT+6' },
  { zone: 'Asia/Bangkok', label: 'Bangkok', gmt: 'GMT+7' },
  { zone: 'Asia/Shanghai', label: 'Şangay', gmt: 'GMT+8' },
  { zone: 'Asia/Singapore', label: 'Singapur', gmt: 'GMT+8' },
  { zone: 'Asia/Tokyo', label: 'Tokyo', gmt: 'GMT+9' },
  { zone: 'Australia/Sydney', label: 'Sidney', gmt: 'GMT+10' },
  { zone: 'Pacific/Auckland', label: 'Auckland', gmt: 'GMT+12' },
];

function TimezoneSection() {
  const { data } = useApi<{ timezone: string }>('/system/timezone', { timezone: '' });
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (data.timezone && !selected) setSelected(data.timezone);
  }, [data.timezone]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await putApi('/system/timezone', { timezone: selected });
      setResult('Saat dilimi güncellendi');
    } catch {
      setResult('Güncelleme başarısız');
    }
    setSaving(false);
  };

  return (
    <div className="config-items">
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Mevcut Saat Dilimi</span>
          <span className="config-item-desc">{data.timezone || 'Yükleniyor...'}</span>
        </div>
        <div className="config-item-control">
          <Badge variant="info">{TIMEZONES.find(t => t.zone === data.timezone)?.gmt || 'GMT+3'}</Badge>
        </div>
      </div>
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Şehir / Bölge</span>
          <span className="config-item-desc">Sistem saatini değiştir</span>
        </div>
        <div className="config-item-control" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="config-select" value={selected} onChange={e => setSelected(e.target.value)}
            style={{ minWidth: 200 }}>
            {TIMEZONES.map(tz => (
              <option key={tz.zone} value={tz.zone}>{tz.gmt} — {tz.label}</option>
            ))}
          </select>
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving || selected === data.timezone}>
            <Save size={12} /> Uygula
          </button>
        </div>
      </div>
      {result && (
        <div style={{ padding: '6px 10px', borderRadius: 6, fontSize: 12, color: '#10b981', background: 'rgba(16,185,129,0.1)', marginTop: 4 }}>
          {result}
        </div>
      )}
    </div>
  );
}

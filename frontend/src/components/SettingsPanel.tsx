import { useState, useEffect } from 'react';
import {
  Settings, Palette, Globe, Bell, Zap, Info, Save, ChevronDown, ChevronRight,
  Sun, Moon, Volume2, VolumeX, Monitor, Clock
} from 'lucide-react';
import { useApi, putApi } from '../hooks/useApi';
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

  const handleTheme = (theme: 'dark' | 'light') => {
    setSettings(prev => ({ ...prev, theme }));
    document.documentElement.classList.toggle('light-theme', theme === 'light');
    document.documentElement.classList.toggle('dark-theme', theme === 'dark');
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
                  onClick={() => setSettings(prev => ({ ...prev, accentColor: c.value }))}
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
      key: 'about',
      label: 'Hakkında',
      icon: <Info size={15} />,
      content: (
        <div className="config-items">
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Versiyon</span>
              <span className="config-item-desc">Pi5 Secure Gateway Panel</span>
            </div>
            <div className="config-item-control">
              <Badge variant="info">v2.0</Badge>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Platform</span>
              <span className="config-item-desc">Raspberry Pi 5 - React 19 + Vite 8</span>
            </div>
            <div className="config-item-control">
              <Badge variant="neutral">Pi 5</Badge>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Geliştirici</span>
              <span className="config-item-desc">Pi5 Ağ Geçidi Yönetim Paneli</span>
            </div>
            <div className="config-item-control">
              <Monitor size={14} />
            </div>
          </div>
        </div>
      ),
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

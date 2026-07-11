import { useState, useEffect, useRef } from 'react';
import {
  Settings, Palette, Globe, Bell, Zap, Info, Save, ChevronDown, ChevronRight,
  Volume2, VolumeX, Clock, RefreshCw, Download, Loader2, Gauge
} from 'lucide-react';
import { useApi, putApi, postApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { BRAND } from '../brand';
import { toast } from '../toast';

interface AppSettings {
  accentColor: string;
  language: string;
  notificationSound: boolean;
  desktopNotifications: boolean;
  autoRefresh: boolean;
  refreshInterval: number;
  speedtestInterval: number; // otomatik hız testi aralığı (dakika; 0 = kapalı)
}

const defaultSettings: AppSettings = {
  accentColor: 'blue',
  language: 'tr',
  notificationSound: true,
  desktopNotifications: false,
  autoRefresh: true,
  refreshInterval: 5000,
  speedtestInterval: 360,
};

// API key-value nesnesini AppSettings'e dönüştür
function parseApiSettings(raw: Record<string, string>): Partial<AppSettings> {
  return {
    accentColor: raw.accent_color || raw.accentColor || 'blue',
    language: raw.language || 'tr',
    notificationSound: raw.notification_sound === 'true',
    autoRefresh: raw.auto_refresh === 'true',
    refreshInterval: parseInt(raw.refresh_interval || '5000') || 5000,
    speedtestInterval: raw.speedtest_interval_min ? (parseInt(raw.speedtest_interval_min) || 0) : 360,
  };
}

// AppSettings'i API formatına dönüştür
function toApiSettings(s: AppSettings): Record<string, unknown> {
  return {
    accent_color: s.accentColor,
    language: s.language,
    notification_sound: String(s.notificationSound),
    auto_refresh: String(s.autoRefresh),
    refresh_interval: String(s.refreshInterval),
    speedtest_interval_min: String(s.speedtestInterval),
  };
}

export function SettingsPanel() {
  const { data, loading } = useApi<{ settings: Record<string, string> }>('/settings', { settings: {} });
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const skipFirstSave = useRef(true); // yükleme sonrası ilk otomatik-kayıt tetiğini atla

  // İlk fetch tamamlanınca kayıtlı ayarları uygula. `loading` bayrağını kullanıyoruz;
  // DB boş dönse bile loaded=true olur (aksi halde otomatik kayıt hiç etkinleşmezdi).
  useEffect(() => {
    if (loading || loaded) return;
    setSettings({ ...defaultSettings, ...parseApiSettings(data.settings || {}) });
    setLoaded(true);
  }, [loading, loaded, data.settings]);

  // Otomatik kayıt: kullanıcı bir ayarı değiştirince (ilk yükleme hariç) kısa debounce ile kaydet
  useEffect(() => {
    if (!loaded) return;
    if (skipFirstSave.current) { skipFirstSave.current = false; return; }
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        await putApi('/settings', { settings: toApiSettings(settings) });
        toast.success('Ayarlar otomatik kaydedildi.');
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Otomatik kaydetme başarısız.');
      }
      setSaving(false);
    }, 300);
    return () => clearTimeout(t);
  }, [settings, loaded]);

  const toggleCollapse = (cat: string) => {
    setCollapsed(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  // Accent rengini DOM'a uygula (tema Topbar'dan yönetilir)
  const applyAccentColor = (color: string) => {
    document.documentElement.classList.remove('accent-green', 'accent-purple', 'accent-orange');
    if (color !== 'blue') {
      document.documentElement.classList.add(`accent-${color}`);
    }
  };

  // Apply accent on load
  useEffect(() => {
    if (loaded) {
      applyAccentColor(settings.accentColor);
    }
  }, [loaded]);

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
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Otomatik Hız Testi</span>
              <span className="config-item-desc">Arka planda periyodik speedtest ölçümü. Her ölçüm hattı kısa süre (~30-60sn) doyurur; sık aralık gateway trafiğini aksatır.</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Gauge size={14} />
              <select className="config-select" value={settings.speedtestInterval}
                onChange={e => setSettings(prev => ({ ...prev, speedtestInterval: Number(e.target.value) }))}
                style={{ width: 140 }}>
                <option value={0}>Kapalı</option>
                <option value={30}>30 dakikada bir</option>
                <option value={60}>Saatte bir</option>
                <option value={180}>3 saatte bir</option>
                <option value={360}>6 saatte bir</option>
                <option value={720}>12 saatte bir</option>
                <option value={1440}>Günde bir</option>
              </select>
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
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            <Save size={13} /> {saving ? 'Kaydediliyor…' : 'Değişiklikler otomatik kaydedilir'}
          </span>
        }
      >
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

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      const result = await postApi('/system/update', {});
      if (result.success) {
        toast.success('Güncelleme tamamlandı! Servis yeniden başlatılıyor, 8sn sonra sayfa yenilenecek...');
        setTimeout(() => window.location.reload(), 8000);
      } else {
        const failed = result.steps?.filter((s: any) => !s.success).map((s: any) => s.step).join(', ');
        toast.error(`Başarısız adımlar: ${failed}`);
      }
    } catch (e: any) {
      toast.error(e.message || 'Güncelleme başarısız');
    }
    setUpdating(false);
  };

  return (
    <div className="config-items">
      <div className="config-item">
        <div className="config-item-info">
          <span className="config-item-label">Mevcut Versiyon</span>
          <span className="config-item-desc">{BRAND.name} Panel</span>
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
          <span className="config-item-desc">{BRAND.name} Panel</span>
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
                padding: '5px 10px', borderRadius: 8,
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

  useEffect(() => {
    if (data.timezone && !selected) setSelected(data.timezone);
  }, [data.timezone]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await putApi('/system/timezone', { timezone: selected });
      toast.success('Saat dilimi güncellendi');
    } catch {
      toast.error('Güncelleme başarısız');
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
    </div>
  );
}

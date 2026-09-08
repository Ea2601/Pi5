import {
  Lightbulb, Palette, Zap, Type, Save, Plus, Trash2,
  ChevronUp, ChevronDown, SlidersHorizontal, AlertTriangle, RotateCcw,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi, putApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { BRAND } from '../brand';
import { toast } from '../toast';

interface LedConfig {
  color: string;
  brightness: number;
  animation: string;
  enabled: boolean;
}

interface LcdPage {
  id: string;
  label: string;
  type: 'system' | 'custom';
  content: string;
  duration: number;
  enabled: boolean;
}

interface LcdMount {
  name: string;
  path: string;
}

// Kasa OLED motor ayarları — scripts/lcd_display.py DEFAULT_SETTINGS ile aynı şema.
interface LcdSettings {
  wan_if: string;
  temp_alarm: number;
  fps: number;
  anim: boolean;
  i2c_addr: string;
  i2c_port: number;
  mounts: LcdMount[];
}

interface LcdHints {
  interfaces: string[];
  wan: string;
  mounts: LcdMount[];
}

const DEFAULT_SETTINGS: LcdSettings = {
  wan_if: 'eth0',
  temp_alarm: 75,
  fps: 10,
  anim: true,
  i2c_addr: '0x3C',
  i2c_port: 1,
  mounts: [{ name: 'ROOT', path: '/' }, { name: 'BOOT', path: '/boot/firmware' }],
};

// Sistem sayfa tipleri — Python renderer'larındaki içerik anahtarlarıyla eşleşir.
// (content → lcd_display.py _KEY_MAP → klyrix_oled.py sayfa id'si)
const SYSTEM_PAGE_TYPES: { content: string; label: string }[] = [
  { content: 'brand', label: 'Marka Açılışı (Klyrix)' },
  { content: 'temp', label: 'Sıcaklık + Fan (grafik)' },
  { content: 'ram', label: 'RAM + Yük (grafik)' },
  { content: 'cpu_ram', label: 'Sıcaklık ve RAM (iki sayfa)' },
  { content: 'disk', label: 'Disk Doluluk (birimler)' },
  { content: 'network', label: 'İnternet Hızı (grafik)' },
  { content: 'hostname', label: 'Ağ Adresleri (WAN/LAN/GW)' },
  { content: 'devices', label: 'Bağlı Cihazlar' },
  { content: 'vpn', label: 'Güvenlik Katmanları / VPN' },
];

// lcd_display.py _KEY_MAP ile senkron: menüde görünmeyen eş anlamlılar da geçerlidir
// (eski kayıtlar). Bu kümede olmayan içerik motorda serbest metin sayfasına düşer.
const KNOWN_CONTENT_KEYS = new Set([
  'brand', 'hostname', 'system', 'ip', 'net', 'cpu_ram', 'cpu', 'temperature', 'temp',
  'memory', 'ram', 'disk', 'storage', 'network', 'speed', 'internet', 'inet',
  'devices', 'clients', 'vpn', 'security', 'sec', 'message', 'msg',
]);

const DEFAULT_PAGES: LcdPage[] = [
  { id: 'brand', label: 'Marka Açılışı', type: 'system', content: 'brand', duration: 5, enabled: true },
  { id: 'temp', label: 'Sıcaklık + Fan', type: 'system', content: 'temp', duration: 10, enabled: true },
  { id: 'ram', label: 'RAM + Yük', type: 'system', content: 'ram', duration: 10, enabled: true },
  { id: 'disk', label: 'Disk Doluluk', type: 'system', content: 'disk', duration: 10, enabled: true },
  { id: 'network', label: 'İnternet Hızı', type: 'system', content: 'network', duration: 10, enabled: true },
  { id: 'hostname', label: 'Ağ Adresleri', type: 'system', content: 'hostname', duration: 10, enabled: true },
  { id: 'devices', label: 'Bağlı Cihazlar', type: 'system', content: 'devices', duration: 10, enabled: true },
  { id: 'vpn', label: 'Güvenlik / VPN', type: 'system', content: 'vpn', duration: 10, enabled: true },
  { id: 'custom1', label: 'Özel Metin', type: 'custom', content: BRAND.name, duration: 6, enabled: false },
];

const ANIMATIONS = [
  { value: 'static', label: 'Sabit' },
  { value: 'breathe', label: 'Nefes Alma' },
  { value: 'rainbow', label: 'Gökkuşağı' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'blink', label: 'Yanıp Sönme' },
];

const PRESET_COLORS = [
  { label: 'Mavi', value: '#3b82f6' },
  { label: 'Yeşil', value: '#22c55e' },
  { label: 'Kırmızı', value: '#ef4444' },
  { label: 'Mor', value: '#8b5cf6' },
  { label: 'Turuncu', value: '#f59e0b' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Pembe', value: '#ec4899' },
  { label: 'Beyaz', value: '#ffffff' },
];

export function CaseControlPanel() {
  const { data: ledData } = useApi<{ config: LedConfig }>('/case/led', {
    config: { color: '#3b82f6', brightness: 80, animation: 'static', enabled: true },
  });
  const { data: lcdData } = useApi<{ pages: LcdPage[]; controller?: string; settings?: LcdSettings; hints?: LcdHints }>(
    '/case/lcd', { pages: [], controller: 'auto', settings: DEFAULT_SETTINGS, hints: { interfaces: [], wan: 'eth0', mounts: [] } });

  const [led, setLed] = useState<LedConfig>({ color: '#3b82f6', brightness: 80, animation: 'static', enabled: true });
  const [pages, setPages] = useState<LcdPage[]>(DEFAULT_PAGES);
  const [controller, setController] = useState('auto');
  const [settings, setSettings] = useState<LcdSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const hints = lcdData.hints || { interfaces: [], wan: 'eth0', mounts: [] };

  useEffect(() => {
    if (ledData.config) setLed(ledData.config);
  }, [ledData.config]);

  useEffect(() => {
    if (lcdData.pages?.length) setPages(lcdData.pages);
  }, [lcdData.pages]);

  useEffect(() => {
    if (lcdData.controller) setController(lcdData.controller);
  }, [lcdData.controller]);

  useEffect(() => {
    if (lcdData.settings) setSettings({ ...DEFAULT_SETTINGS, ...lcdData.settings });
  }, [lcdData.settings]);

  const handleSaveLed = async () => {
    setSaving(true);
    try {
      const r = await putApi('/case/led', led as unknown as Record<string, unknown>);
      if (r?.warning) { toast.info(r.warning); }
      else if (r?.applied === false) { toast.error(r?.error || 'LED kaydedildi ama donanıma uygulanamadı'); }
      else { toast.success('LED ayarları kaydedildi ve uygulandı'); }
    } catch { toast.error('LED kaydetme başarısız'); }
    setSaving(false);
  };

  const handleSaveLcd = async () => {
    setSaving(true);
    try {
      const r = await putApi('/case/lcd', { pages, controller, settings } as unknown as Record<string, unknown>);
      if (r?.warning) { toast.info(r.warning); }
      else if (r?.applied === false) { toast.error(r?.error || 'LCD kaydedildi ama donanıma uygulanamadı'); }
      else { toast.success('LCD ayarları kaydedildi ve uygulandı'); }
    } catch { toast.error('LCD kaydetme başarısız'); }
    setSaving(false);
  };

  const togglePage = (id: string) => {
    setPages(prev => prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };

  const updatePage = (id: string, field: keyof LcdPage, value: any) => {
    setPages(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const addCustomPage = () => {
    const id = `custom_${Date.now()}`;
    setPages(prev => [...prev, { id, label: 'Özel Metin', type: 'custom', content: '', duration: 5, enabled: true }]);
  };

  const addSystemPage = (content: string) => {
    if (!content) return;
    const meta = SYSTEM_PAGE_TYPES.find(t => t.content === content);
    const id = `sys_${content}_${Date.now()}`;
    setPages(prev => [...prev, {
      id, label: meta?.label || content, type: 'system', content, duration: 5, enabled: true,
    }]);
  };

  const removePage = (id: string) => {
    setPages(prev => prev.filter(p => p.id !== id));
  };

  // Dizideki sıra = ekrandaki sıra; motor sayfaları bu sırayla döndürür.
  const movePage = (id: string, dir: -1 | 1) => {
    setPages(prev => {
      const i = prev.findIndex(p => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const resetPages = () => setPages(DEFAULT_PAGES.map(p => ({ ...p })));

  const updateSetting = <K extends keyof LcdSettings>(key: K, value: LcdSettings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }));

  const updateMount = (i: number, field: keyof LcdMount, value: string) =>
    setSettings(prev => ({
      ...prev,
      mounts: prev.mounts.map((m, k) => k === i ? { ...m, [field]: value } : m),
    }));

  const addMount = () =>
    setSettings(prev => prev.mounts.length >= 8 ? prev : { ...prev, mounts: [...prev.mounts, { name: '', path: '' }] });

  const removeMount = (i: number) =>
    setSettings(prev => ({ ...prev, mounts: prev.mounts.filter((_, k) => k !== i) }));

  // Motorun tanımadığı içerik anahtarı serbest metin sayfasına düşer — kullanıcıyı uyar.
  const isUnknownPage = (page: LcdPage) =>
    page.type === 'system' && !KNOWN_CONTENT_KEYS.has(String(page.content).toLowerCase().trim());

  return (
    <div className="fade-in">
      <Panel title="Kasa LED Kontrol" icon={<Lightbulb size={20} style={{ marginRight: 8 }} />}
        subtitle="Pimoroni Fan SHIM RGB LED — renk, parlaklık ve animasyon ayarları"
        badge={<Badge variant={led.enabled ? 'success' : 'neutral'}>{led.enabled ? 'Aktif' : 'Kapalı'}</Badge>}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-primary btn-sm" onClick={handleSaveLed} disabled={saving}>
              <Save size={13} /> Kaydet & Uygula
            </button>
            <button className={`toggle-btn ${led.enabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={() => setLed(prev => ({ ...prev, enabled: !prev.enabled }))}>
              <div className="toggle-knob" />
            </button>
          </div>
        }>

        <div className="config-items" style={{ marginTop: 8 }}>
          {/* LED Renk */}
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><Palette size={14} /> LED Rengi</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {PRESET_COLORS.map(c => (
                <button key={c.value}
                  style={{
                    width: 28, height: 28, borderRadius: 8, background: c.value,
                    border: led.color === c.value ? '2px solid #fff' : '2px solid transparent',
                    cursor: 'pointer',
                  }}
                  onClick={() => setLed(prev => ({ ...prev, color: c.value }))}
                  title={c.label}
                />
              ))}
              <input type="color" value={led.color}
                onChange={e => setLed(prev => ({ ...prev, color: e.target.value }))}
                style={{ width: 28, height: 28, border: 'none', cursor: 'pointer', borderRadius: 8 }}
                title="Özel renk"
              />
            </div>
          </div>

          {/* Parlaklık */}
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Parlaklık</span>
              <span className="config-item-desc">{led.brightness}%</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 180 }}>
              <input type="range" min={0} max={100} value={led.brightness}
                onChange={e => setLed(prev => ({ ...prev, brightness: Number(e.target.value) }))}
                style={{ flex: 1 }} />
            </div>
          </div>

          {/* Animasyon */}
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><Zap size={14} /> Animasyon</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {ANIMATIONS.map(a => (
                <button key={a.value}
                  className={`btn-sm ${led.animation === a.value ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setLed(prev => ({ ...prev, animation: a.value }))}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          {/* Önizleme */}
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Önizleme</span>
            </div>
            <div className="config-item-control">
              <div style={{
                width: 40, height: 40, borderRadius: '50%',
                background: led.enabled ? led.color : '#333',
                opacity: led.enabled ? led.brightness / 100 : 0.2,
                boxShadow: led.enabled ? `0 0 20px ${led.color}60` : 'none',
                transition: 'all 0.3s',
                animation: led.enabled && led.animation === 'breathe' ? 'breathe 3s ease-in-out infinite' : undefined,
              }} />
            </div>
          </div>
        </div>
      </Panel>

      {/* LCD Döngü Ayarları */}
      <div style={{ marginTop: 14 }}>
        <Panel title="LCD Ekran Döngüsü" icon={<Type size={20} style={{ marginRight: 8 }} />}
          subtitle="Kasa LCD ekranında sırayla gösterilecek bilgiler"
          badge={<Badge variant="info">{pages.filter(p => p.enabled).length} sayfa aktif</Badge>}
          actions={
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select className="config-select-sm" defaultValue=""
                onChange={e => { addSystemPage(e.target.value); e.target.value = ''; }}
                style={{ width: 'auto', minWidth: 130 }} title="Sistem sayfası ekle">
                <option value="" disabled>+ Sayfa Ekle</option>
                {SYSTEM_PAGE_TYPES.map(t => (
                  <option key={t.content} value={t.content}>{t.label}</option>
                ))}
              </select>
              <button className="btn-outline btn-sm" onClick={addCustomPage}>
                <Plus size={13} /> Metin Ekle
              </button>
              <button className="btn-outline btn-sm" onClick={resetPages} title="Sayfa listesini varsayılan döngüye döndür">
                <RotateCcw size={13} /> Varsayılan
              </button>
              <button className="btn-primary btn-sm" onClick={handleSaveLcd} disabled={saving}>
                <Save size={13} /> Kaydet & Uygula
              </button>
            </div>
          }>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Ekran denetleyici</span>
            <select className="config-select-sm" value={controller}
              onChange={e => setController(e.target.value)} style={{ width: 'auto', minWidth: 150 }}>
              <option value="auto">Otomatik (ssd1306→sh1106)</option>
              <option value="ssd1306">SSD1306 (0.96")</option>
              <option value="sh1106">SH1106 (1.3" — Pironman 5)</option>
            </select>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Yazı kayıyor/kırpılıyorsa SH1106 deneyin</span>
          </div>

          {/* Ekran (motor) ayarları — PI5_LCD_* uçlarına yazılır */}
          <div className="glass-panel" style={{ padding: '10px 14px', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <SlidersHorizontal size={14} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Ekran Ayarları</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Sayfaların veriyi nereden okuduğunu ve nasıl çizildiğini belirler
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
              {/* WAN arayüzü — internet sayfasındaki canlı grafik bu arayüzden okunur */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  WAN arayüzü {hints.wan && hints.wan !== settings.wan_if && (
                    <button onClick={() => updateSetting('wan_if', hints.wan)}
                      title="Tespit edilen arayüzü kullan"
                      style={{
                        background: 'none', border: 'none', padding: 0, marginLeft: 4, cursor: 'pointer',
                        fontSize: 10, color: 'var(--accent, #3b82f6)', textDecoration: 'underline',
                      }}>
                      tespit: {hints.wan}
                    </button>
                  )}
                </span>
                {hints.interfaces.length > 0 ? (
                  <select className="config-select-sm" value={settings.wan_if}
                    onChange={e => updateSetting('wan_if', e.target.value)}>
                    {(hints.interfaces.includes(settings.wan_if)
                      ? hints.interfaces : [settings.wan_if, ...hints.interfaces]).map(i => (
                      <option key={i} value={i}>{i}</option>
                    ))}
                  </select>
                ) : (
                  <input className="config-input" type="text" value={settings.wan_if}
                    onChange={e => updateSetting('wan_if', e.target.value)}
                    style={{ fontSize: 12, padding: '4px 8px' }} />
                )}
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>İnternet sayfasındaki hız grafiği</span>
              </label>

              {/* Sıcaklık alarm eşiği */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Sıcaklık alarmı (°C)</span>
                <input className="config-input" type="number" min={40} max={110} value={settings.temp_alarm}
                  onChange={e => updateSetting('temp_alarm', Number(e.target.value))}
                  style={{ fontSize: 12, padding: '4px 8px' }} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Aşılınca sayfa yanıp söner</span>
              </label>

              {/* Kare hızı */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Kare hızı (FPS)</span>
                <input className="config-input" type="number" min={1} max={60} value={settings.fps}
                  onChange={e => updateSetting('fps', Number(e.target.value))}
                  style={{ fontSize: 12, padding: '4px 8px' }} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  100 kHz I2C'de 10–12 üst sınır; üstüne çıkınca görüntü bozulur.
                  Daha yükseği için /boot/firmware/config.txt → dtparam=i2c_arm_baudrate=400000
                </span>
              </label>

              {/* I2C adres / port */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>I2C adres / port</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input className="config-input" type="text" value={settings.i2c_addr}
                    onChange={e => updateSetting('i2c_addr', e.target.value)} placeholder="0x3C"
                    style={{ fontSize: 12, padding: '4px 8px', width: 70 }} />
                  <input className="config-input" type="number" min={0} max={9} value={settings.i2c_port}
                    onChange={e => updateSetting('i2c_port', Number(e.target.value))}
                    style={{ fontSize: 12, padding: '4px 8px', width: 55 }} />
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Ekran hiç açılmıyorsa: i2cdetect -y 1</span>
              </label>

              {/* Animasyon anahtarı */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Animasyon</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className={`toggle-btn toggle-sm ${settings.anim ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => updateSetting('anim', !settings.anim)}>
                    <div className="toggle-knob" />
                  </button>
                  <span style={{ fontSize: 12 }}>{settings.anim ? 'Açık' : 'Kapalı (statik)'}</span>
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Kapalıyken sayfa geçişleri anlık</span>
              </div>
            </div>

            {/* Disk birimleri — disk sayfasındaki göstergeler */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Disk birimleri (disk sayfası)</span>
                <button className="btn-outline btn-sm" onClick={addMount} disabled={settings.mounts.length >= 8}
                  style={{ fontSize: 11, padding: '2px 8px' }}>
                  <Plus size={11} /> Birim
                </button>
                {hints.mounts.length > 0 && (
                  <select className="config-select-sm" defaultValue=""
                    onChange={e => {
                      const m = hints.mounts.find(x => x.path === e.target.value);
                      if (m && !settings.mounts.some(x => x.path === m.path)) {
                        setSettings(prev => prev.mounts.length >= 8 ? prev : { ...prev, mounts: [...prev.mounts, { ...m }] });
                      }
                      e.target.value = '';
                    }}
                    style={{ width: 'auto', minWidth: 150, fontSize: 11 }} title="Sistemde bulunan bağlama noktaları">
                    <option value="" disabled>+ Bulunanlardan ekle</option>
                    {hints.mounts.map(m => <option key={m.path} value={m.path}>{m.name} — {m.path}</option>)}
                  </select>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {settings.mounts.length === 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Birim yok — disk sayfası motorun varsayılan listesini kullanır (ROOT, BOOT, NAS, USB, DOCKER)
                  </span>
                )}
                {settings.mounts.map((m, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input className="config-input" type="text" value={m.name} maxLength={6}
                      onChange={e => updateMount(i, 'name', e.target.value.toUpperCase())}
                      placeholder="AD"
                      style={{ fontSize: 12, padding: '4px 8px', width: 80, fontFamily: 'var(--font-mono)' }} />
                    <input className="config-input" type="text" value={m.path}
                      onChange={e => updateMount(i, 'path', e.target.value)}
                      placeholder="/mnt/nas"
                      style={{ fontSize: 12, padding: '4px 8px', flex: 1, fontFamily: 'var(--font-mono)' }} />
                    <button className="icon-btn icon-btn-sm" onClick={() => removeMount(i)} title="Kaldır">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                Ad en fazla 6 karakter (ekranda gösterilir), yol mutlak olmalı. Bağlı olmayan yollar atlanır.
              </span>
            </div>
          </div>

          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {pages.map((page, idx) => (
              <div key={page.id} className={`glass-panel ${!page.enabled ? 'routing-row-disabled' : ''}`}
                style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Sıra — dizideki sıra ekrandaki dönüş sırasıdır */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                  <button className="icon-btn icon-btn-sm" onClick={() => movePage(page.id, -1)}
                    disabled={idx === 0} title="Yukarı taşı"
                    style={{ width: 20, height: 16, opacity: idx === 0 ? 0.3 : 1 }}>
                    <ChevronUp size={11} />
                  </button>
                  <button className="icon-btn icon-btn-sm" onClick={() => movePage(page.id, 1)}
                    disabled={idx === pages.length - 1} title="Aşağı taşı"
                    style={{ width: 20, height: 16, opacity: idx === pages.length - 1 ? 0.3 : 1 }}>
                    <ChevronDown size={11} />
                  </button>
                </div>

                {/* Toggle */}
                <button className={`toggle-btn toggle-sm ${page.enabled ? 'toggle-on' : 'toggle-off'}`}
                  onClick={() => togglePage(page.id)} style={{ flexShrink: 0 }}>
                  <div className="toggle-knob" />
                </button>

                {/* Sayfa adı */}
                <span style={{ width: 140, fontSize: 13, fontWeight: 500, flexShrink: 0 }}>{page.label}</span>

                {/* İçerik */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {page.type === 'custom' ? (
                    <input className="config-input" type="text" value={page.content}
                      onChange={e => updatePage(page.id, 'content', e.target.value)}
                      placeholder="Özel metin yazın..."
                      style={{ fontSize: 12, padding: '4px 8px', width: '100%' }} />
                  ) : isUnknownPage(page) ? (
                    <span title="Bu içerik anahtarını ekran motoru tanımıyor; sayfa serbest metin olarak çizilir"
                      style={{ fontSize: 11, color: 'var(--warning, #f59e0b)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangle size={11} />
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{page.content}</span>
                      <span>— tanınmıyor, metin olarak gösterilir</span>
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {page.content}
                    </span>
                  )}
                </div>

                {/* Süre */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  <input className="config-input" type="number" min={2} max={30} value={page.duration}
                    onChange={e => updatePage(page.id, 'duration', Number(e.target.value))}
                    style={{ width: 50, fontSize: 12, padding: '4px 6px', textAlign: 'center' }} />
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>sn</span>
                </div>

                {/* Sil */}
                <button className="icon-btn icon-btn-sm" onClick={() => removePage(page.id)} title="Kaldır" style={{ flexShrink: 0 }}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

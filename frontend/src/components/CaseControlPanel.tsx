import { Lightbulb, Palette, Zap, Type, Save, RotateCcw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi, putApi, postApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';

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

const DEFAULT_PAGES: LcdPage[] = [
  { id: 'hostname', label: 'Hostname + IP', type: 'system', content: 'hostname', duration: 5, enabled: true },
  { id: 'cpu', label: 'CPU Sıcaklık + RAM', type: 'system', content: 'cpu_ram', duration: 5, enabled: true },
  { id: 'network', label: 'Download / Upload Hız', type: 'system', content: 'network', duration: 5, enabled: true },
  { id: 'devices', label: 'Aktif Cihaz Sayısı', type: 'system', content: 'devices', duration: 5, enabled: true },
  { id: 'vpn', label: 'VPN Durumu', type: 'system', content: 'vpn', duration: 5, enabled: true },
  { id: 'custom1', label: 'Özel Metin', type: 'custom', content: 'Pi5 Secure Gateway', duration: 5, enabled: false },
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
  const { data: lcdData } = useApi<{ pages: LcdPage[] }>('/case/lcd', { pages: DEFAULT_PAGES });

  const [led, setLed] = useState<LedConfig>({ color: '#3b82f6', brightness: 80, animation: 'static', enabled: true });
  const [pages, setPages] = useState<LcdPage[]>(DEFAULT_PAGES);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => {
    if (ledData.config) setLed(ledData.config);
  }, [ledData.config]);

  useEffect(() => {
    if (lcdData.pages?.length) setPages(lcdData.pages);
  }, [lcdData.pages]);

  const handleSaveLed = async () => {
    setSaving(true);
    try {
      await putApi('/case/led', led);
      setResult('LED ayarları kaydedildi');
    } catch { setResult('Kaydetme başarısız'); }
    setSaving(false);
  };

  const handleSaveLcd = async () => {
    setSaving(true);
    try {
      await putApi('/case/lcd', { pages });
      setResult('LCD ayarları kaydedildi');
    } catch { setResult('Kaydetme başarısız'); }
    setSaving(false);
  };

  const togglePage = (id: string) => {
    setPages(prev => prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };

  const updatePage = (id: string, field: keyof LcdPage, value: any) => {
    setPages(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  return (
    <div className="fade-in">
      <Panel title="Kasa LED Kontrol" icon={<Lightbulb size={20} style={{ marginRight: 8 }} />}
        subtitle="Pimoroni Fan SHIM RGB LED — renk, parlaklık ve animasyon ayarları"
        badge={<Badge variant={led.enabled ? 'success' : 'neutral'}>{led.enabled ? 'Aktif' : 'Kapalı'}</Badge>}
        actions={
          <button className={`toggle-btn ${led.enabled ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => setLed(prev => ({ ...prev, enabled: !prev.enabled }))}>
            <div className="toggle-knob" />
          </button>
        }>

        {/* LED Renk */}
        <div className="config-items" style={{ marginTop: 8 }}>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><Palette size={14} /> LED Rengi</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {PRESET_COLORS.map(c => (
                <button key={c.value}
                  style={{
                    width: 28, height: 28, borderRadius: 6, background: c.value,
                    border: led.color === c.value ? '2px solid #fff' : '2px solid transparent',
                    cursor: 'pointer',
                  }}
                  onClick={() => setLed(prev => ({ ...prev, color: c.value }))}
                  title={c.label}
                />
              ))}
              <input type="color" value={led.color}
                onChange={e => setLed(prev => ({ ...prev, color: e.target.value }))}
                style={{ width: 28, height: 28, border: 'none', cursor: 'pointer', borderRadius: 6 }}
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
            <div className="config-item-control" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200 }}>
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
            <div className="config-item-control" style={{ display: 'flex', gap: 4 }}>
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

          {/* LED Önizleme */}
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

        <div style={{ marginTop: 12 }}>
          <button className="btn-primary btn-sm" onClick={handleSaveLed} disabled={saving}>
            <Save size={13} /> LED Kaydet
          </button>
        </div>
      </Panel>

      {/* LCD Döngü Ayarları */}
      <div style={{ marginTop: 14 }}>
        <Panel title="LCD Ekran Döngüsü" icon={<Type size={20} style={{ marginRight: 8 }} />}
          subtitle="Kasa LCD ekranında sırayla gösterilecek bilgiler"
          badge={<Badge variant="info">{pages.filter(p => p.enabled).length} sayfa aktif</Badge>}
          actions={
            <button className="btn-primary btn-sm" onClick={handleSaveLcd} disabled={saving}>
              <Save size={13} /> LCD Kaydet
            </button>
          }>

          <div className="list-items" style={{ marginTop: 8 }}>
            <div className="routing-row routing-header-row">
              <span className="routing-col-toggle">Durum</span>
              <span style={{ flex: 2 }}>Sayfa</span>
              <span style={{ flex: 2 }}>İçerik</span>
              <span style={{ width: 80 }}>Süre (sn)</span>
            </div>
            {pages.map(page => (
              <div key={page.id} className={`routing-row ${!page.enabled ? 'routing-row-disabled' : ''}`}>
                <span className="routing-col-toggle">
                  <button className={`toggle-btn toggle-sm ${page.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => togglePage(page.id)}>
                    <div className="toggle-knob" />
                  </button>
                </span>
                <span style={{ flex: 2, fontSize: 13, fontWeight: 500 }}>{page.label}</span>
                <span style={{ flex: 2 }}>
                  {page.type === 'custom' ? (
                    <input className="config-input" type="text" value={page.content}
                      onChange={e => updatePage(page.id, 'content', e.target.value)}
                      placeholder="Özel metin yazın..."
                      style={{ fontSize: 12, padding: '3px 8px' }} />
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {page.content}
                    </span>
                  )}
                </span>
                <span style={{ width: 80 }}>
                  <input className="config-input" type="number" min={2} max={30} value={page.duration}
                    onChange={e => updatePage(page.id, 'duration', Number(e.target.value))}
                    style={{ width: 60, fontSize: 12, padding: '3px 6px' }} />
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {result && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12, color: '#10b981', background: 'rgba(16,185,129,0.1)' }}>
          <RotateCcw size={12} style={{ marginRight: 4 }} />{result}
        </div>
      )}
    </div>
  );
}

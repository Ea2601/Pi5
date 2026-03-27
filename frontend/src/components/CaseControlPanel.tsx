import { Lightbulb, Palette, Zap, Type, Save, RotateCcw, Plus, Trash2 } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi, putApi } from '../hooks/useApi';
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
  const { data: lcdData } = useApi<{ pages: LcdPage[] }>('/case/lcd', { pages: [] });

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
    setResult('');
    try {
      await putApi('/case/led', led as unknown as Record<string, unknown>);
      setResult('LED ayarları kaydedildi ve uygulandı');
    } catch { setResult('LED kaydetme başarısız'); }
    setSaving(false);
  };

  const handleSaveLcd = async () => {
    setSaving(true);
    setResult('');
    try {
      await putApi('/case/lcd', { pages });
      setResult('LCD ayarları kaydedildi ve uygulandı');
    } catch { setResult('LCD kaydetme başarısız'); }
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

  const removePage = (id: string) => {
    setPages(prev => prev.filter(p => p.id !== id));
  };

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
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-outline btn-sm" onClick={addCustomPage}>
                <Plus size={13} /> Metin Ekle
              </button>
              <button className="btn-primary btn-sm" onClick={handleSaveLcd} disabled={saving}>
                <Save size={13} /> Kaydet & Uygula
              </button>
            </div>
          }>

          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {pages.map(page => (
              <div key={page.id} className={`glass-panel ${!page.enabled ? 'routing-row-disabled' : ''}`}
                style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
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

                {/* Sil (sadece custom) */}
                {page.type === 'custom' && (
                  <button className="icon-btn icon-btn-sm" onClick={() => removePage(page.id)} title="Kaldır" style={{ flexShrink: 0 }}>
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {result && (
        <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12, color: '#10b981', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <RotateCcw size={12} />{result}
        </div>
      )}
    </div>
  );
}

import { Monitor, Layout, Clock, Save, ExternalLink } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi, putApi } from '../hooks/useApi';
import { Panel } from './ui';
import { toast } from '../toast';

interface KioskConfig {
  enabled: boolean;
  rotateInterval: number;
  widgets: { id: string; label: string; enabled: boolean }[];
}

const DEFAULT_WIDGETS = [
  { id: 'system', label: 'Sistem Durumu (CPU/RAM/Disk)', enabled: true },
  { id: 'network', label: 'Ağ Trafiği', enabled: true },
  { id: 'vpn', label: 'VPN Tünelleri', enabled: true },
  { id: 'devices', label: 'Aktif Cihazlar', enabled: true },
  { id: 'speedtest', label: 'Son Hız Testi', enabled: true },
  { id: 'alerts', label: 'Son Bildirimler', enabled: true },
  { id: 'pihole', label: 'Pi-hole İstatistikleri', enabled: false },
  { id: 'services', label: 'Servis Durumu', enabled: true },
];

export function KioskSettingsPanel() {
  const { data } = useApi<{ config: KioskConfig }>('/case/kiosk', {
    config: { enabled: true, rotateInterval: 10, widgets: DEFAULT_WIDGETS },
  });

  const [config, setConfig] = useState<KioskConfig>({
    enabled: true, rotateInterval: 10, widgets: DEFAULT_WIDGETS,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data.config?.widgets?.length) setConfig(data.config);
  }, [data.config]);

  const toggleWidget = (id: string) => {
    setConfig(prev => ({
      ...prev,
      widgets: prev.widgets.map(w => w.id === id ? { ...w, enabled: !w.enabled } : w),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await putApi('/case/kiosk', config as unknown as Record<string, unknown>);
      toast.success('Kiosk ayarları kaydedildi');
    } catch { toast.error('Kaydetme başarısız'); }
    setSaving(false);
  };

  const openKiosk = () => {
    window.open('/kiosk.html', '_blank', 'fullscreen=yes');
  };

  return (
    <div className="fade-in">
      <Panel title="HDMI Harici Ekran" icon={<Monitor size={20} style={{ marginRight: 8 }} />}
        subtitle="Dokunmatik veya HDMI ekranda tam ekran dashboard — otomatik carousel"
        actions={
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-outline btn-sm" onClick={openKiosk}>
              <ExternalLink size={13} /> Kiosk Aç
            </button>
            <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
              <Save size={13} /> Kaydet
            </button>
          </div>
        }>

        <div className="config-items" style={{ marginTop: 8 }}>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><Clock size={14} /> Sayfa Döngü Süresi</span>
              <span className="config-item-desc">Her widget kaç saniye gösterilecek</span>
            </div>
            <div className="config-item-control" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input className="config-input" type="number" min={5} max={60}
                value={config.rotateInterval}
                onChange={e => setConfig(prev => ({ ...prev, rotateInterval: Number(e.target.value) }))}
                style={{ width: 60 }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>saniye</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <h4 style={{ fontSize: 13, marginBottom: 8 }}><Layout size={14} /> Gösterilecek Widgetlar</h4>
          <div className="list-items">
            {config.widgets.map(w => (
              <div key={w.id} className={`routing-row ${!w.enabled ? 'routing-row-disabled' : ''}`}>
                <span className="routing-col-toggle">
                  <button className={`toggle-btn toggle-sm ${w.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => toggleWidget(w.id)}>
                    <div className="toggle-knob" />
                  </button>
                </span>
                <span style={{ flex: 1, fontSize: 13 }}>{w.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 14, padding: '12px 16px', borderRadius: 8, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <h4 style={{ fontSize: 13, marginBottom: 6 }}>Kiosk Kurulumu</h4>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <p>HDMI ekranda otomatik açılış için Pi5'te (install.sh servisi kurar):</p>
            <code style={{ display: 'block', padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.3)', marginTop: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              # Chromium + kiosk servisini etkinleştir{'\n'}
              sudo apt install -y chromium{'\n'}
              sudo systemctl enable --now pi5-kiosk{'\n'}
              # Panel URL'i: http://localhost/kiosk.html
            </code>
          </div>
        </div>
      </Panel>
    </div>
  );
}

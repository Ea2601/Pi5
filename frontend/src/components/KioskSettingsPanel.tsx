import { Monitor, Layout, Clock, Save, ExternalLink, ChevronUp, ChevronDown, Power, RotateCcw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useApi, putApi } from '../hooks/useApi';
import { Panel } from './ui';
import { toast } from '../toast';

interface KioskWidget { id: string; label: string; enabled: boolean }
interface KioskConfig {
  enabled: boolean;
  rotateInterval: number;
  widgets: KioskWidget[];
}

// id'ler kiosk.html içindeki PAGE_BUILDERS anahtarlarıyla birebir eşleşmeli —
// eşleşmeyen id kiosk tarafında sessizce elenir (loadConfig filtresi).
const DEFAULT_WIDGETS: KioskWidget[] = [
  { id: 'system', label: 'Sistem Durumu (CPU/RAM/Disk + trend)', enabled: true },
  { id: 'trends', label: 'Trend / Geçmiş (sıcaklık, CPU, bellek, ağ)', enabled: true },
  { id: 'network', label: 'Ağ Trafiği', enabled: true },
  { id: 'wan', label: 'WAN / DDNS (genel IP + değişim geçmişi)', enabled: true },
  { id: 'vpn', label: 'VPN Tünelleri', enabled: true },
  { id: 'devices', label: 'Aktif Cihazlar (liste)', enabled: true },
  { id: 'dns', label: 'DNS Sorguları (unbound)', enabled: false },
  { id: 'security', label: 'Güvenlik (fail2ban, firewall, sağlık)', enabled: true },
  { id: 'speedtest', label: 'Son Hız Testi', enabled: true },
  { id: 'alerts', label: 'Son Bildirimler', enabled: true },
  { id: 'pihole', label: 'Pi-hole İstatistikleri', enabled: false },
  { id: 'services', label: 'Servis Durumu', enabled: true },
];

/**
 * Kayıtlı config ile kod tarafındaki widget listesini birleştirir.
 * Kayıttan yalnız sıra ve açık/kapalı seçimi alınır; etiket her zaman koddan gelir.
 * Yeni eklenen sayfalar kayıtta bulunmadığı için sona, kendi varsayılanıyla eklenir —
 * merge olmasaydı DB'deki eski liste yeni sayfaları panelde de gizlerdi.
 */
function mergeWidgets(saved?: KioskWidget[]): KioskWidget[] {
  const known = new Map(DEFAULT_WIDGETS.map(w => [w.id, w]));
  const out: KioskWidget[] = [];
  for (const w of saved || []) {
    const def = known.get(w.id);
    if (!def) continue;                                  // kiosk.html'de karşılığı yok
    out.push({ ...def, enabled: !!w.enabled });
    known.delete(w.id);
  }
  for (const def of DEFAULT_WIDGETS) if (known.has(def.id)) out.push({ ...def });
  return out;
}

export function KioskSettingsPanel() {
  const { data } = useApi<{ config: KioskConfig }>('/case/kiosk', {
    config: { enabled: true, rotateInterval: 10, widgets: DEFAULT_WIDGETS },
  });

  const [config, setConfig] = useState<KioskConfig>({
    enabled: true, rotateInterval: 10, widgets: DEFAULT_WIDGETS,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data.config) {
      setConfig({
        enabled: data.config.enabled !== false,
        rotateInterval: data.config.rotateInterval || 10,
        widgets: mergeWidgets(data.config.widgets),
      });
    }
  }, [data.config]);

  const toggleWidget = (id: string) => {
    setConfig(prev => ({
      ...prev,
      widgets: prev.widgets.map(w => w.id === id ? { ...w, enabled: !w.enabled } : w),
    }));
  };

  // Dizideki sıra = kioskta dönüş sırası (kiosk.html pages dizisini bu sırayla kurar).
  const moveWidget = (id: string, dir: -1 | 1) => {
    setConfig(prev => {
      const i = prev.widgets.findIndex(w => w.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.widgets.length) return prev;
      const next = [...prev.widgets];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...prev, widgets: next };
    });
  };

  const resetWidgets = () => setConfig(prev => ({ ...prev, widgets: DEFAULT_WIDGETS.map(w => ({ ...w })) }));

  const activeCount = config.widgets.filter(w => w.enabled).length;

  const handleSave = async () => {
    setSaving(true);
    try {
      // Yanıt {success, applied, message, error} döner; servis gerçekten uygulanmadıysa
      // "kaydedildi" demek yanıltıcı olurdu.
      const r = await putApi('/case/kiosk', config as unknown as Record<string, unknown>) as
        { applied?: boolean; message?: string; error?: string; warning?: string };
      if (r.error) toast.error(r.error);
      else if (r.warning) toast.info(r.warning);
      else toast.success(r.message || 'Kiosk ayarları kaydedildi');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Kaydetme başarısız'); }
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
              <span className="config-item-label"><Power size={14} /> Kiosk Modu</span>
              <span className="config-item-desc">
                Kapatılırsa pi5-kiosk servisi durdurulur ve HDMI çıkışı terminale döner
              </span>
            </div>
            <div className="config-item-control">
              <button className={`toggle-btn ${config.enabled ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => setConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
                title={config.enabled ? 'Kiosk modunu kapat' : 'Kiosk modunu aç'}>
                <div className="toggle-knob" />
              </button>
            </div>
          </div>

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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h4 style={{ fontSize: 13 }}>
              <Layout size={14} /> Gösterilecek Sayfalar
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
                {activeCount}/{config.widgets.length} açık · sıra = dönüş sırası
              </span>
            </h4>
            <button className="btn-outline btn-sm" onClick={resetWidgets} title="Varsayılan sıraya ve seçime dön">
              <RotateCcw size={12} /> Sıfırla
            </button>
          </div>

          {activeCount === 0 && (
            <div style={{
              marginBottom: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
              color: 'var(--text-muted)',
            }}>
              Hiçbir sayfa seçili değil — kiosk bu durumda tüm sayfaları sırayla gösterir.
            </div>
          )}

          <div className="list-items">
            {config.widgets.map((w, idx) => (
              <div key={w.id} className={`routing-row ${!w.enabled ? 'routing-row-disabled' : ''}`}>
                {/* Sıra — dizideki sıra kioskta dönüş sırasıdır */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                  <button className="icon-btn icon-btn-sm" onClick={() => moveWidget(w.id, -1)}
                    disabled={idx === 0} title="Yukarı taşı"
                    style={{ width: 20, height: 16, opacity: idx === 0 ? 0.3 : 1 }}>
                    <ChevronUp size={11} />
                  </button>
                  <button className="icon-btn icon-btn-sm" onClick={() => moveWidget(w.id, 1)}
                    disabled={idx === config.widgets.length - 1} title="Aşağı taşı"
                    style={{ width: 20, height: 16, opacity: idx === config.widgets.length - 1 ? 0.3 : 1 }}>
                    <ChevronDown size={11} />
                  </button>
                </div>
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
            <p style={{ marginTop: 8 }}>
              Ekranda: <b>ok tuşları</b> veya <b>kaydırma</b> ile sayfa değiştirilir; alttaki
              noktalara tıklanabilir. Veriler 5 saniyede bir yerinde tazelenir.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

import { Monitor, Layout, Save, ExternalLink, Power, RotateCcw, Palette, ScanLine, TriangleAlert, Info } from 'lucide-react';
import { useState } from 'react';
import { useApi, putApi } from '../hooks/useApi';
import { Panel, Select } from './ui';
import { toast } from '../toast';
import { DEFAULT_CONFIG, TILES, normalizeConfig, type KioskConfig, type KioskThemeMode, type KioskTileId } from '../kiosk/config';
import './KioskSettingsPanel.css';

// HDMI ekranı (kiosk.html → src/kiosk): tek ekranlı gösterge paneli. Burada hangi panoların görüneceği, tema ve ekran
// koruma seçilir; kiosk ayarı 60 sn içinde kendisi okur. Kiosk modu açılıp kapatılınca pi5-kiosk servisi başlar / durur.
// support: cihazın HDMI ekranını kaldırıp kaldıramayacağı (backend kiosk.ts ← scripts/platform.sh). no: 512 MB sınıfı ya
// da elle seçilmiş Hafif profil (forced), no-display: ekran çıkışı yok (backend açmayı reddeder), warn: 1 GB sınıfı
// (açılır, bellek dar). active: ekran servisi şu an çalışıyor. Eski backend: yok.
type KioskSupport = { state: 'ok' | 'warn' | 'no' | 'no-display'; memMiB: number; forced?: boolean; active?: boolean } | null;

// Açmayı engelleyen neden — backend kiosk.ts kioskBlockReason ile aynı metin (elle seçilmiş profilde bellek suçlanmaz)
const blockReasonOf = (s: KioskSupport) => s?.state === 'no'
  ? (s.forced ? 'HDMI ekranı Hafif profilde kapalı (profil elle seçildi: /etc/pi5-gateway/profile)'
    : `HDMI ekranı bu cihazda açılamaz: ${s.memMiB} MB bellek (en az 1 GB gerekir)`)
  : s?.state === 'no-display' ? 'Ekran çıkışı bulunamadı' : '';

export function KioskSettingsPanel() {
  const { data, refetch } = useApi<{ config: unknown; support?: KioskSupport }>('/case/kiosk', { config: null });
  const support = data.support ?? null;
  const blockReason = blockReasonOf(support);
  // Açılamaz ama ekran bu sürümden önce açılmış ve hâlâ çalışıyor: anahtar gerçeği ("açık") gösterir ve kapatılabilir;
  // kapatıldıktan sonra bu cihazda yeniden açılamaz. Pano / tema kaydı ekranı kapatmaz (backend yalnız ayarı kaydeder).
  const runningAnyway = !!blockReason && !!support?.active;
  const locked = !!blockReason && !runningAnyway;
  const [config, setConfig] = useState<KioskConfig>(DEFAULT_CONFIG);
  // Açılamayan cihazda anahtar kapalı görünür ve kilitlidir; Kaydet "kapalı" gönderir (kayıt yoksa varsayılan "açık"tı,
  // her kayıtta ret iletisi gelirdi). Yedekten "açık" gelmiş bir ayar da böylece kapanır (kapatma koşulsuzdur).
  const kioskOn = config.enabled && (!blockReason || runningAnyway);
  const [saving, setSaving] = useState(false);
  // Sunucudan yeni kayıt gelince formu ona göre kur (render sırasında; efekt + setState zincirleme render yapardı)
  const [loadedFrom, setLoadedFrom] = useState<unknown>(undefined);
  if (data.config !== loadedFrom) {
    setLoadedFrom(data.config);
    setConfig(normalizeConfig(data.config));
  }

  const toggleTile = (id: KioskTileId) =>
    setConfig(prev => ({ ...prev, tiles: prev.tiles.map(t => (t.id === id ? { ...t, enabled: !t.enabled } : t)) }));
  const on = (id: KioskTileId) => config.tiles.find(t => t.id === id)?.enabled;
  const activeCount = config.tiles.filter(t => t.enabled).length;

  const handleSave = async () => {
    setSaving(true);
    try {
      // Yanıt {success, applied, message, error}: servis gerçekten uygulanmadıysa "kaydedildi" demek yanıltıcı olurdu.
      const r = await putApi('/case/kiosk', { ...config, enabled: kioskOn } as unknown as Record<string, unknown>) as
        { applied?: boolean; message?: string; error?: string; warning?: string };
      if (r.error) toast.error(r.error);
      else if (r.warning) toast.info(r.warning);
      else toast.success(r.message || 'Kiosk ayarları kaydedildi');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Kaydetme başarısız'); }
    setSaving(false);
    // Açılamayan cihazda ekranın çalışıp çalışmadığı kayıttan sonra değişebilir (kapatıldıysa anahtar kilitlenir)
    if (blockReason) refetch();
  };

  return (
    <div className="fade-in">
      <Panel title="HDMI Ekran" icon={<Monitor size={20} style={{ marginRight: 8 }} />}
        subtitle="Pi'nin HDMI çıkışında tek ekranlı gösterge paneli: internet hızı, sistem, DNS, internet, tüneller, cihazlar ve güvenlik"
        actions={
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-outline btn-sm" onClick={() => window.open('/kiosk.html', '_blank')}>
              <ExternalLink size={13} /> Kiosku aç
            </button>
            <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
              <Save size={13} /> {saving ? (kioskOn && !blockReason ? 'Ekran açılıyor…' : 'Kaydediliyor…') : 'Kaydet'}
            </button>
          </div>
        }>

        <div className="config-items" style={{ marginTop: 8 }}>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><Power size={14} /> Kiosk modu</span>
              <span className="config-item-desc">Kapatılırsa pi5-kiosk servisi durur ve HDMI çıkışı terminale döner</span>
              {blockReason && (
                <span className="config-item-desc ks-support ks-support-no">
                  <TriangleAlert size={12} /> {blockReason}{runningAnyway ? ' — ekran şu an açık (önceki ayar); kapatılırsa bu cihazda yeniden açılamaz' : ''}
                </span>
              )}
              {support?.state === 'warn' && (
                <span className="config-item-desc ks-support ks-support-warn">
                  <Info size={12} /> {support.memMiB} MB bellek: tarayıcı için dar — ekran açılır ama panel ve DNS ile aynı belleği paylaşır
                </span>
              )}
            </div>
            <div className="config-item-control">
              <button className={`toggle-btn ks-toggle ${kioskOn ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => setConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
                disabled={locked}
                title={locked ? blockReason : (kioskOn ? 'Kiosk modunu kapat' : 'Kiosk modunu aç')}>
                <div className="toggle-knob" />
              </button>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><Palette size={14} /> Tema</span>
              <span className="config-item-desc">"Panelle aynı": paneldeki koyu/açık tema ve vurgu rengi ekrana da uygulanır</span>
            </div>
            <div className="config-item-control">
              <Select value={config.theme} onChange={e => setConfig(prev => ({ ...prev, theme: e.target.value as KioskThemeMode }))}>
                <option value="panel">Panelle aynı</option>
                <option value="dark">Her zaman koyu</option>
                <option value="light">Her zaman açık</option>
              </Select>
            </div>
          </div>
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label"><ScanLine size={14} /> Ekran koruma</span>
              <span className="config-item-desc">Görüntü birkaç dakikada bir 1-2 piksel kayar; TV ve OLED ekranda sabit yazılar iz bırakmaz</span>
            </div>
            <div className="config-item-control">
              <button className={`toggle-btn ${config.shift ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => setConfig(prev => ({ ...prev, shift: !prev.shift }))}>
                <div className="toggle-knob" />
              </button>
            </div>
          </div>
        </div>

        <div className="kiosk-cfg">
          <div>
            <div className="kiosk-cfg-head">
              <h4><Layout size={14} /> Panolar <span>{activeCount}/{config.tiles.length} açık</span></h4>
              <button className="btn-outline btn-sm" onClick={() => setConfig(prev => ({ ...prev, tiles: TILES.map(t => ({ ...t })) }))}
                title="Tüm panoları aç">
                <RotateCcw size={12} /> Sıfırla
              </button>
            </div>
            <div className="list-items">
              {config.tiles.map(t => (
                <div key={t.id} className={`routing-row ${!t.enabled ? 'routing-row-disabled' : ''}`}>
                  <span className="routing-col-toggle">
                    <button className={`toggle-btn toggle-sm ${t.enabled ? 'toggle-on' : 'toggle-off'}`} onClick={() => toggleTile(t.id)}>
                      <div className="toggle-knob" />
                    </button>
                  </span>
                  <span style={{ flex: 1, fontSize: 13 }}>{t.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Yerleşim önizlemesi: kiosk ekranının şeması (kapatılan panoların yerini diğerleri doldurur) */}
          <div className="kiosk-preview" aria-label="Ekran yerleşimi önizlemesi">
            <div className="kiosk-preview-screen">
              <div className="kp-head" />
              <div className="kp-top" data-solo={!on('traffic') || !(on('system') || on('dns')) ? '1' : undefined}>
                {on('traffic') && <div className="kp-box kp-traffic">Hız testi</div>}
                {(on('system') || on('dns')) && (
                  <div className="kp-stack">
                    {on('system') && <div className="kp-box">Sistem</div>}
                    {on('dns') && <div className="kp-box">DNS</div>}
                  </div>
                )}
              </div>
              <div className="kp-bottom">
                {on('internet') && <div className="kp-box">İnternet</div>}
                {on('tunnels') && <div className="kp-box">Tüneller</div>}
                {on('devices') && <div className="kp-box">Cihazlar</div>}
                {on('security') && <div className="kp-box">Güvenlik</div>}
              </div>
              {on('alerts') && <div className="kp-box kp-ticker">Bildirim şeridi</div>}
            </div>
            <span className="config-item-desc">Önizleme · ekran boyutuna göre ölçeklenir (TV'den 7" dokunmatiğe)</span>
          </div>
        </div>

        <div className="kiosk-note">
          <h4>Kurulum ve kullanım</h4>
          <p>
            Pi'de pi5-kiosk servisi (install.sh kurar) HDMI ekranda <code>http://localhost/kiosk.html</code> adresini açar;
            bu sayfada <strong>Kiosk modu</strong> açıkken Kaydet'e basmak servisi başlatır. Ekran dokunma gerektirmez:
            veriler kendiliğinden tazelenir, panel güncellenince sayfa kendini yeniler. Ayar değişiklikleri ekrana 1 dakika
            içinde yansır.
          </p>
        </div>
      </Panel>
    </div>
  );
}

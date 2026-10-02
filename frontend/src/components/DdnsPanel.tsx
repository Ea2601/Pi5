import { useState } from 'react';
import { Globe, RefreshCw, Shield, Clock, Plus, Trash2, Check, Edit3, X } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge, StatCard, Select } from './ui';
import { toast } from '../toast';
import { fmtDbTime } from '../time';

interface DdnsConfig {
  id: number;
  provider: string;
  hostname: string;
  username: string;
  password: string;
  token: string;
  domain: string;
  update_interval_min: number;
  enabled: number;
  last_update: string;   // son BAŞARILI güncelleme (UTC)
  last_ip: string;       // son başarıyla gönderilen adres
  status: string;        // active | error (yeniden denenir) | halted (bilgiler düzeltilene kadar durdu) | idle
  message?: string;      // son denemenin sağlayıcı yanıtı (panel yeniden başlayınca boş)
  // Sunucu sırları maskeli döner: password/token '••••••••'; özel sağlayıcıda URL maskeli, domain_display = ana makine adı
  has_password?: boolean;
  has_token?: boolean;
  domain_display?: string;
}

const DDNS_MASK = '••••••••';
const STATUS_META: Record<string, { variant: 'success' | 'error' | 'warning' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Aktif' },
  error: { variant: 'error', label: 'Hata' },
  halted: { variant: 'warning', label: 'Durduruldu' },
};
const statusMeta = (s: string) => STATUS_META[s] || { variant: 'neutral' as const, label: 'Beklemede' };
// Durdurulmuş kaydın nedeni (panel yeniden başladıysa mesaj bellekte yoktur)
const statusNote = (c: DdnsConfig) => c.message || (c.status === 'halted'
  ? 'Sağlayıcı bilgileri reddetti — bilgileri düzeltip kaydedin ya da Test edin' : '');
const displayDomain = (c: DdnsConfig) => (c.provider === 'custom' ? c.domain_display || '' : c.domain);

interface IpHistoryEntry {
  id: number;
  ip: string;
  detected_at: string;
  source: string;
}

interface CurrentIp {
  ip: string;
  provider: string;
  checked_at: string;
}

type DdnsTab = 'durum' | 'yapilandirma' | 'gecmis';

const PROVIDERS = ['duckdns', 'noip', 'cloudflare', 'dynu', 'custom'] as const;
const PROVIDER_LABELS: Record<string, string> = {
  duckdns: 'DuckDNS', noip: 'No-IP', cloudflare: 'Cloudflare', dynu: 'Dynu', custom: 'Ozel',
};

const emptyForm = {
  provider: 'duckdns', hostname: '', username: '', password: '',
  token: '', domain: '', update_interval_min: 5, enabled: 1,
};

export function DdnsPanel() {
  const [activeTab, setActiveTab] = useState<DdnsTab>('durum');
  const { data: configsData, refetch: refetchConfigs } = useApi<{ configs: DdnsConfig[] }>('/ddns/configs', { configs: [] });
  const { data: ipData, refetch: refetchIp } = useApi<CurrentIp>('/ddns/current-ip', { ip: '', provider: '', checked_at: '' }, 30000);
  const { data: historyData, refetch: refetchHistory } = useApi<{ history: IpHistoryEntry[] }>('/ddns/ip-history', { history: [] });

  const [checking, setChecking] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingOrig, setEditingOrig] = useState<DdnsConfig | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  const handleCheckIp = async () => {
    setChecking(true);
    try {
      const result = await postApi('/ddns/check-ip', {});
      if (result.changed) toast.info(`IP degisti: ${result.old_ip} → ${result.new_ip}`);
      else toast.success(`IP degismedi: ${result.new_ip || '—'}`);
      refetchIp(); refetchHistory(); refetchConfigs();
    } catch { toast.error('IP kontrolu basarisiz.'); }
    setChecking(false);
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const r = await postApi(`/ddns/configs/${id}/test`, {}) as { success?: boolean; message?: string };
      if (r.success) toast.success(r.message || 'DDNS güncellendi');
      else toast.error(r.message || 'DDNS güncellenemedi');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test edilemedi');
    }
    refetchConfigs();
    setTesting(null);
  };

  // Düzenlemede sır alanları boş gelir (sunucu sırrı göndermez); boş bırakılan kayıtlı sır maskeyle "değişmedi" olarak
  // gönderilir ve sunucu saklı değeri korur.
  const handleSave = async () => {
    try {
      if (editingId) {
        const payload: Record<string, unknown> = { ...form };
        if (editingOrig) {
          if (form.password === '' && editingOrig.has_password) payload.password = DDNS_MASK;
          if (form.token === '' && editingOrig.has_token) payload.token = DDNS_MASK;
          // Maskeli URL yalnız sağlayıcı değişmediyse korunur; değiştiyse boş gider (eski URL sırrı yeni türde açıkta kalmasın).
          if (form.domain === '' && editingOrig.domain === DDNS_MASK && form.provider === editingOrig.provider) payload.domain = DDNS_MASK;
        }
        await putApi(`/ddns/configs/${editingId}`, payload);
      } else {
        await postApi('/ddns/configs', form as unknown as Record<string, unknown>);
      }
      refetchConfigs(); setForm(emptyForm); setEditingId(null); setEditingOrig(null); setShowForm(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kaydedilemedi');
    }
  };

  const handleEdit = (c: DdnsConfig) => {
    setForm({
      provider: c.provider, hostname: c.hostname, username: c.username, password: '', token: '',
      domain: c.domain === DDNS_MASK ? '' : c.domain, update_interval_min: c.update_interval_min, enabled: c.enabled,
    });
    setEditingOrig(c); setEditingId(c.id); setShowForm(true);
  };
  const keptHint = (has: boolean | undefined) => (editingId && has ? 'Kayıtlı — değiştirmek için yazın' : undefined);

  const handleDelete = async (c: DdnsConfig) => {
    if (!window.confirm(`${PROVIDER_LABELS[c.provider] || c.provider} — ${c.hostname} DDNS kaydı silinsin mi?`)) return;
    try { await deleteApi(`/ddns/configs/${c.id}`); } catch (e) { toast.error(e instanceof Error ? e.message : 'Silinemedi'); }
    refetchConfigs();
  };
  const handleToggle = async (c: DdnsConfig) => {
    try { await putApi(`/ddns/configs/${c.id}`, { enabled: c.enabled ? 0 : 1 }); } catch (e) { toast.error(e instanceof Error ? e.message : 'Değiştirilemedi'); }
    refetchConfigs();
  };

  const showTokenField = form.provider === 'duckdns' || form.provider === 'cloudflare';
  const showUserPassFields = form.provider === 'noip' || form.provider === 'dynu' || form.provider === 'custom';
  const showDomainField = form.provider === 'cloudflare' || form.provider === 'custom';

  const tabs: { id: DdnsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'durum', label: 'Durum', icon: <Globe size={14} /> },
    { id: 'yapilandirma', label: 'Yapilandirma', icon: <Shield size={14} /> },
    { id: 'gecmis', label: 'IP Gecmisi', icon: <Clock size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel title="DDNS Yonetimi" icon={<Globe size={20} style={{ marginRight: 8 }} />}
        subtitle="Dinamik DNS yapilandirmasi ve dis IP takibi">
        <div className="service-tabs">
          {tabs.map(t => (
            <button key={t.id}
              className={`service-tab ${activeTab === t.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(t.id)}>
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'durum' && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<Globe size={20} />} label="Mevcut IP" value={ipData.ip || '---'} color="blue" />
            <StatCard icon={<Shield size={20} />} label="Aktif DDNS" value={configsData.configs.filter(c => c.status === 'active').length} color="green" />
            <StatCard icon={<RefreshCw size={20} />} label={<>Toplam <span lang="en">Config</span></>} value={configsData.configs.length} color="purple" />
            <StatCard icon={<Clock size={20} />} label="Son Kontrol" value={ipData.checked_at ? new Date(ipData.checked_at).toLocaleTimeString('tr-TR') : '---'} color="orange" />
          </div>

          <div style={{ marginTop: 14 }}>
            <Panel title="Dis IP Durumu" icon={<Globe size={18} style={{ marginRight: 8 }} />}
              actions={
                <button className="btn-primary btn-sm" onClick={handleCheckIp} disabled={checking}>
                  <RefreshCw size={14} className={checking ? 'spin' : ''} /> IP Kontrol Et
                </button>
              }>
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <span style={{ fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent-color)' }}>
                  {ipData.ip || '---'}
                </span>
                <p className="text-muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Saglayici: {ipData.provider} — {ipData.checked_at ? new Date(ipData.checked_at).toLocaleString('tr-TR') : '---'}
                </p>
              </div>
            </Panel>
          </div>

          <div style={{ marginTop: 14 }}>
            <Panel title="Aktif Yapilandirmalar">
              <div className="list-items">
                {configsData.configs.length === 0 && (
                  <div className="empty-state" style={{ padding: 20 }}>Henuz DDNS yapilandirmasi yok.</div>
                )}
                {configsData.configs.map(c => (
                  <div key={c.id} className="list-item">
                    <div className="list-item-content">
                      <span className="list-item-value">
                        <strong>{PROVIDER_LABELS[c.provider]}</strong> — {displayDomain(c) || c.hostname}
                      </span>
                      <span className="list-item-comment">
                        Son IP: {c.last_ip || '---'} — {fmtDbTime(c.last_update, undefined, 'Guncellenmedi')}
                      </span>
                      {statusNote(c) && <span className="list-item-comment">{statusNote(c)}</span>}
                    </div>
                    <Badge variant={statusMeta(c.status).variant}>{statusMeta(c.status).label}</Badge>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'yapilandirma' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="DDNS Yapilandirmalari" icon={<Shield size={18} style={{ marginRight: 8 }} />}
            actions={!showForm ? (
              <button className="btn-primary btn-sm" onClick={() => { setForm(emptyForm); setEditingId(null); setEditingOrig(null); setShowForm(true); }}>
                <Plus size={14} /> Yeni DDNS Ekle
              </button>
            ) : undefined}>

            {showForm && (
              <div className="cron-add-form">
                <div className="cron-add-grid">
                  <div className="form-group">
                    <label>Saglayici</label>
                    <Select className="config-select" value={form.provider}
                      onChange={e => setForm({ ...form, provider: e.target.value })}>
                      {PROVIDERS.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
                    </Select>
                  </div>
                  <div className="form-group">
                    <label>Hostname</label>
                    <input className="config-input" value={form.hostname}
                      onChange={e => setForm({ ...form, hostname: e.target.value })} placeholder="pi5gateway" />
                  </div>
                  {showTokenField && (
                    <div className="form-group">
                      <label>{form.provider === 'cloudflare' ? 'API Token (Zone · DNS · Edit yetkili)' : 'Token'}</label>
                      <input className="config-input" type="password" autoComplete="off" value={form.token}
                        onChange={e => setForm({ ...form, token: e.target.value })}
                        placeholder={keptHint(editingOrig?.has_token) || (form.provider === 'cloudflare' ? 'Global API Key değil, API Token' : 'Token')} />
                    </div>
                  )}
                  {showUserPassFields && (
                    <>
                      <div className="form-group">
                        <label>Kullanici Adi</label>
                        <input className="config-input" value={form.username}
                          onChange={e => setForm({ ...form, username: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>Sifre</label>
                        <input className="config-input" type="password" autoComplete="off" value={form.password}
                          onChange={e => setForm({ ...form, password: e.target.value })}
                          placeholder={keptHint(editingOrig?.has_password)} />
                      </div>
                    </>
                  )}
                  {showDomainField && (
                    <div className="form-group">
                      <label>{form.provider === 'cloudflare' ? 'Alan adı ya da Zone ID (isteğe bağlı)' : 'Update URL'}</label>
                      <input className="config-input" value={form.domain}
                        onChange={e => setForm({ ...form, domain: e.target.value })}
                        placeholder={keptHint(editingOrig?.domain === DDNS_MASK && form.provider === editingOrig?.provider)
                          || (form.provider === 'cloudflare' ? 'Boş: addan bulunur (ör. ornek.com)' : 'https://…?ip={ip}&host={hostname}')} />
                    </div>
                  )}
                </div>
                <p className="text-muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
                  Genel IP değişince en geç 5 dakika içinde güncellenir; IP aynıyken günde bir kez yenilenir (sağlayıcılar
                  değişmeyen adresin sık gönderilmesini kötüye kullanım sayıp hesabı engelleyebilir). Kullanıcı adı / şifre
                  ya da token reddedilirse güncelleme durur ve bildirim gelir; bilgileri düzeltip kaydedince yeniden başlar.
                  {form.provider === 'cloudflare' && ' Cloudflare kaydı yoksa oluşturulur (proxy kapalı — Ev VPN\'i için gerekli); varsa yalnız adresi değişir.'}
                </p>
                <div className="cron-add-actions">
                  <button className="btn-primary btn-sm" onClick={handleSave}>
                    <Check size={13} /> {editingId ? 'Guncelle' : 'Kaydet'}
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => { setShowForm(false); setEditingId(null); setEditingOrig(null); }}>
                    <X size={13} /> Iptal
                  </button>
                </div>
              </div>
            )}

            <div className="list-items" style={{ marginTop: showForm ? 14 : 0 }}>
              {configsData.configs.map(c => (
                <div key={c.id} className="list-item">
                  <button className={`toggle-btn toggle-sm ${c.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleToggle(c)}>
                    <div className="toggle-knob" />
                  </button>
                  <div className="list-item-content">
                    <span className="list-item-value">
                      <strong>{PROVIDER_LABELS[c.provider]}</strong> — {c.hostname}
                      {displayDomain(c) && <span className="text-muted"> ({displayDomain(c)})</span>}
                    </span>
                    <span className="list-item-comment">Son IP: {c.last_ip || '---'} — {fmtDbTime(c.last_update, undefined, 'Guncellenmedi')}</span>
                    {statusNote(c) && <span className="list-item-comment">{statusNote(c)}</span>}
                  </div>
                  <Badge variant={statusMeta(c.status).variant}>{statusMeta(c.status).label}</Badge>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleTest(c.id)} disabled={testing === c.id} title="Test Et">
                      <RefreshCw size={13} className={testing === c.id ? 'spin' : ''} />
                    </button>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleEdit(c)} title="Duzenle">
                      <Edit3 size={13} />
                    </button>
                    <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(c)} title="Sil">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {configsData.configs.length === 0 && (
                <div className="empty-state" style={{ padding: 24 }}>
                  <Globe size={32} /><p>Henuz DDNS yapilandirmasi yok</p>
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 'gecmis' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="IP Degisim Gecmisi" icon={<Clock size={18} style={{ marginRight: 8 }} />}
            actions={<button className="btn-outline btn-sm" onClick={() => refetchHistory()}><RefreshCw size={14} /> Yenile</button>}>

            <div className="list-items">
              {historyData.history.map((entry, idx) => (
                <div key={entry.id} className={`list-item ${idx === 0 ? '' : ''}`}>
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                    background: idx === 0 ? 'var(--accent-color)' : 'var(--text-muted)',
                    boxShadow: idx === 0 ? '0 0 8px var(--accent-glow)' : 'none',
                  }} />
                  <div className="list-item-content">
                    <span className="list-item-value" style={{
                      fontFamily: 'var(--font-mono)', fontWeight: idx === 0 ? 700 : 400,
                      color: idx === 0 ? 'var(--accent-color)' : 'var(--text-primary)',
                    }}>
                      {entry.ip}
                    </span>
                    <span className="list-item-comment">{fmtDbTime(entry.detected_at)}</span>
                  </div>
                  {idx === 0 && <Badge variant="success">Mevcut</Badge>}
                  <Badge variant="neutral"><span lang="en">{entry.source}</span></Badge>
                </div>
              ))}
              {historyData.history.length === 0 && (
                <div className="empty-state" style={{ padding: 24 }}>IP gecmisi bos.</div>
              )}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Globe, RefreshCw, Shield, Clock, Plus, Trash2, Check, AlertTriangle, Edit3, X } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge, StatCard } from './ui';

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
  last_update: string;
  last_ip: string;
  status: string;
}

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
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  const handleCheckIp = async () => {
    setChecking(true); setCheckResult(null);
    try {
      const result = await postApi('/ddns/check-ip', {});
      setCheckResult(result.changed ? `IP degisti: ${result.old_ip} → ${result.new_ip}` : `IP degismedi: ${result.ip}`);
      refetchIp(); refetchHistory(); refetchConfigs();
    } catch { setCheckResult('IP kontrolu basarisiz.'); }
    setChecking(false);
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try { await postApi(`/ddns/configs/${id}/test`, {}); refetchConfigs(); } catch { /* */ }
    setTesting(null);
  };

  const handleSave = async () => {
    try {
      if (editingId) await putApi(`/ddns/configs/${editingId}`, form as unknown as Record<string, unknown>);
      else await postApi('/ddns/configs', form as unknown as Record<string, unknown>);
      refetchConfigs(); setForm(emptyForm); setEditingId(null); setShowForm(false);
    } catch { /* */ }
  };

  const handleEdit = (c: DdnsConfig) => {
    setForm({ provider: c.provider, hostname: c.hostname, username: c.username, password: c.password, token: c.token, domain: c.domain, update_interval_min: c.update_interval_min, enabled: c.enabled });
    setEditingId(c.id); setShowForm(true);
  };

  const handleDelete = async (id: number) => {
    await deleteApi(`/ddns/configs/${id}`); refetchConfigs();
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
            <StatCard icon={<RefreshCw size={20} />} label="Toplam Config" value={configsData.configs.length} color="purple" />
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
              {checkResult && (
                <div className={`alert ${checkResult.includes('degisti') ? 'alert-error' : 'alert-success'}`}>
                  {checkResult.includes('degisti') ? <AlertTriangle size={14} /> : <Check size={14} />}
                  <span>{checkResult}</span>
                </div>
              )}
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
                        <strong>{PROVIDER_LABELS[c.provider]}</strong> — {c.domain || c.hostname}
                      </span>
                      <span className="list-item-comment">
                        Son IP: {c.last_ip || '---'} — {c.last_update ? new Date(c.last_update).toLocaleString('tr-TR') : 'Guncellenmedi'}
                      </span>
                    </div>
                    <Badge variant={c.status === 'active' ? 'success' : c.status === 'error' ? 'error' : 'neutral'}>
                      {c.status === 'active' ? 'Aktif' : c.status === 'error' ? 'Hata' : 'Beklemede'}
                    </Badge>
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
              <button className="btn-primary btn-sm" onClick={() => { setForm(emptyForm); setEditingId(null); setShowForm(true); }}>
                <Plus size={14} /> Yeni DDNS Ekle
              </button>
            ) : undefined}>

            {showForm && (
              <div className="cron-add-form">
                <div className="cron-add-grid">
                  <div className="form-group">
                    <label>Saglayici</label>
                    <select className="config-select" value={form.provider}
                      onChange={e => setForm({ ...form, provider: e.target.value })}>
                      {PROVIDERS.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Hostname</label>
                    <input className="config-input" value={form.hostname}
                      onChange={e => setForm({ ...form, hostname: e.target.value })} placeholder="pi5gateway" />
                  </div>
                  {showTokenField && (
                    <div className="form-group">
                      <label>{form.provider === 'cloudflare' ? 'API Key' : 'Token'}</label>
                      <input className="config-input" value={form.token}
                        onChange={e => setForm({ ...form, token: e.target.value })} placeholder="Token / API Key" />
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
                        <input className="config-input" type="password" value={form.password}
                          onChange={e => setForm({ ...form, password: e.target.value })} />
                      </div>
                    </>
                  )}
                  {showDomainField && (
                    <div className="form-group">
                      <label>{form.provider === 'cloudflare' ? 'Zone (Domain)' : 'Update URL'}</label>
                      <input className="config-input" value={form.domain}
                        onChange={e => setForm({ ...form, domain: e.target.value })} />
                    </div>
                  )}
                  <div className="form-group">
                    <label>Guncelleme Araligi (dk)</label>
                    <input className="config-input" type="number" min={1} value={form.update_interval_min}
                      onChange={e => setForm({ ...form, update_interval_min: parseInt(e.target.value) || 5 })} />
                  </div>
                </div>
                <div className="cron-add-actions">
                  <button className="btn-primary btn-sm" onClick={handleSave}>
                    <Check size={13} /> {editingId ? 'Guncelle' : 'Kaydet'}
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => { setShowForm(false); setEditingId(null); }}>
                    <X size={13} /> Iptal
                  </button>
                </div>
              </div>
            )}

            <div className="list-items" style={{ marginTop: showForm ? 14 : 0 }}>
              {configsData.configs.map(c => (
                <div key={c.id} className="list-item">
                  <button className={`toggle-btn toggle-sm ${c.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={async () => { await putApi(`/ddns/configs/${c.id}`, { enabled: c.enabled ? 0 : 1 }); refetchConfigs(); }}>
                    <div className="toggle-knob" />
                  </button>
                  <div className="list-item-content">
                    <span className="list-item-value">
                      <strong>{PROVIDER_LABELS[c.provider]}</strong> — {c.hostname}
                      {c.domain && <span className="text-muted"> ({c.domain})</span>}
                    </span>
                    <span className="list-item-comment">Her {c.update_interval_min} dk — Son IP: {c.last_ip || '---'}</span>
                  </div>
                  <Badge variant={c.status === 'active' ? 'success' : c.status === 'error' ? 'error' : 'neutral'}>
                    {c.status === 'active' ? 'Aktif' : c.status === 'error' ? 'Hata' : 'Beklemede'}
                  </Badge>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleTest(c.id)} disabled={testing === c.id} title="Test Et">
                      <RefreshCw size={13} className={testing === c.id ? 'spin' : ''} />
                    </button>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleEdit(c)} title="Duzenle">
                      <Edit3 size={13} />
                    </button>
                    <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(c.id)} title="Sil">
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
                    <span className="list-item-comment">{new Date(entry.detected_at).toLocaleString('tr-TR')}</span>
                  </div>
                  {idx === 0 && <Badge variant="success">Mevcut</Badge>}
                  <Badge variant="neutral">{entry.source}</Badge>
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

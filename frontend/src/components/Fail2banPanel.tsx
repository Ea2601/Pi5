import { ShieldAlert, Settings, Activity, Lock, Ban, Users, RefreshCw, Loader2, Save, Home, Repeat } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import type { ServiceStatus } from '../types';
import { toast } from '../toast';

// Ayarlar Fail2Ban'a gerçekten uygulanır (backend fail2ban.ts: /etc/fail2ban/jail.d/klyrix-panel.local, sınama + yeniden
// yükleme; başarısızsa eski ayarlar kalır). Eskiden yalnız veritabanına yazılıyordu.
interface F2bSettings {
  bantime: number; findtime: number; maxretry: number; sshd_enabled: boolean; sshd_maxretry: number; sshd_bantime: number;
  lan_exempt: boolean; extra_ignore: string[]; recidive: boolean;
}
interface F2bView { settings: F2bSettings | null; installed: boolean; lan: string[]; ignore: string[]; applied: boolean }
const NUM_FIELDS: { key: keyof F2bSettings; label: string; hint: string; min: number; max: number }[] = [
  { key: 'sshd_maxretry', label: 'SSH: deneme hakkı', hint: 'Bu kadar hatalı girişte yasak', min: 1, max: 20 },
  { key: 'sshd_bantime', label: 'SSH: yasak süresi (sn)', hint: '7200 = 2 saat', min: 60, max: 604800 },
  { key: 'findtime', label: 'Hata penceresi (sn)', hint: 'Denemeler bu süre içinde sayılır', min: 60, max: 86400 },
  { key: 'maxretry', label: 'Öbür jail\'ler: deneme hakkı', hint: 'SSH dışındaki korumalar', min: 1, max: 20 },
  { key: 'bantime', label: 'Öbür jail\'ler: yasak süresi (sn)', hint: '3600 = 1 saat', min: 60, max: 604800 },
];

function Fail2banSettingsCard() {
  const { data, refetch } = useApi<F2bView>('/fail2ban/settings', { settings: null, installed: false, lan: [], ignore: [], applied: false });
  if (!data.settings) return <div style={{ padding: 20, textAlign: 'center' }}><Loader2 size={18} className="spin" /></div>;
  if (!data.installed) return <div className="fw-hint">Fail2Ban kurulu değil.</div>;
  // Sunucudaki ayarlar değişince (kaydetme sonrası) form yeniden kurulur.
  return <Fail2banForm key={JSON.stringify(data.settings)} initial={data.settings} ignore={data.ignore} onSaved={refetch} />;
}

function Fail2banForm({ initial, ignore, onSaved }: { initial: F2bSettings; ignore: string[]; onSaved: () => Promise<void> | void }) {
  const [form, setForm] = useState<F2bSettings>(initial);
  const [extra, setExtra] = useState(initial.extra_ignore.join(' '));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof F2bSettings>(k: K, v: F2bSettings[K]) => setForm({ ...form, [k]: v });
  const save = async () => {
    setSaving(true);
    try {
      await postApi('/fail2ban/settings', { settings: { ...form, extra_ignore: extra.split(/[\s,]+/).filter(Boolean) } });
      toast.success('Fail2Ban ayarları uygulandı.');
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Uygulanamadı');
    }
    setSaving(false);
  };
  return (
    <div className="glass-panel widget-large f2b-settings">
      <div className="f2b-toggles">
        <label className="f2b-toggle">
          <button type="button" className={`toggle-btn toggle-sm ${form.sshd_enabled ? 'toggle-on' : 'toggle-off'}`} onClick={() => set('sshd_enabled', !form.sshd_enabled)} aria-label="SSH koruması"><div className="toggle-knob" /></button>
          <span><Lock size={13} /> SSH koruması</span>
        </label>
        <label className="f2b-toggle">
          <button type="button" className={`toggle-btn toggle-sm ${form.lan_exempt ? 'toggle-on' : 'toggle-off'}`} onClick={() => set('lan_exempt', !form.lan_exempt)} aria-label="Ev ağı muaf"><div className="toggle-knob" /></button>
          <span><Home size={13} /> Ev ağı muaf <span className="f2b-sub">evdeki cihazlardan yanlış şifre SSH'ı kilitlemez</span></span>
        </label>
        <label className="f2b-toggle">
          <button type="button" className={`toggle-btn toggle-sm ${form.recidive ? 'toggle-on' : 'toggle-off'}`} onClick={() => set('recidive', !form.recidive)} aria-label="Tekrarlayanlara uzun yasak"><div className="toggle-knob" /></button>
          <span><Repeat size={13} /> Tekrarlayanlara 1 hafta <span className="f2b-sub">1 günde 5 kez yasaklanan adres tüm portlardan</span></span>
        </label>
      </div>
      <div className="f2b-grid">
        {NUM_FIELDS.map(f => (
          <div key={f.key} className="f2b-field">
            <label>{f.label}</label>
            <input className="config-input" type="number" min={f.min} max={f.max} value={String(form[f.key])}
              onChange={e => set(f.key, Number(e.target.value) as never)} />
            <span className="f2b-sub">{f.hint}</span>
          </div>
        ))}
        <div className="f2b-field f2b-field-wide">
          <label>Ek muaf adresler</label>
          <input className="config-input" value={extra} onChange={e => setExtra(e.target.value)} placeholder="ör. 203.0.113.7 10.0.0.0/24" />
          <span className="f2b-sub">Boşlukla ayırın (IPv4 / IPv6, önekli olabilir)</span>
        </div>
      </div>
      <div className="fw-hint" style={{ marginTop: 10 }}>
        Muaf: {ignore.join(' · ')}{form.lan_exempt ? '' : ' (ev ağı muafiyeti kaydedilince kalkar)'}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} {saving ? 'Uygulanıyor...' : 'Uygula'}
        </button>
      </div>
    </div>
  );
}

type F2bTab = 'overview' | 'settings';

interface Jail {
  name: string;
  currentlyBanned: number;
  totalBanned: number;
  bannedIps: string[];
}

interface RecentBan {
  ip: string;
  jail: string;
  time: string;
}

export function Fail2banPanel() {
  const [activeTab, setActiveTab] = useState<F2bTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const { data: f2bData, loading, refetch: refetchF2b } = useApi<{ jails: Jail[]; recentBans: RecentBan[] }>(
    '/fail2ban/status', { jails: [], recentBans: [] }
  );
  const f2bSvc = svcData.services.find(s => s.name === 'fail2ban');
  const isEnabled = f2bSvc?.enabled === 1;
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [unbanning, setUnbanning] = useState('');

  const handleUnban = async (ip: string) => {
    setUnbanning(ip);
    try {
      await postApi('/fail2ban/unban', { ip });
      toast.success(`${ip} yasağı kaldırıldı`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Yasak kaldırılamadı');
    }
    await refetchF2b();
    setUnbanning('');
  };

  // Anahtar kalıcıdır (açılışta da geçerli); hata artık yutulmuyor.
  const handleToggle = async () => {
    setToggling(true);
    try {
      await postApi('/services/toggle', { name: 'fail2ban', enabled: !isEnabled });
      toast.success(isEnabled ? 'Fail2Ban durduruldu' : 'Fail2Ban başlatıldı');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    }
    await refetch();
    setToggling(false);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchF2b();
    setRefreshing(false);
  };

  const tabs: { id: F2bTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <Activity size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
  ];

  const jails = f2bData.jails || [];
  const recentBans = f2bData.recentBans || [];
  const totalBanned = jails.reduce((sum, j) => sum + j.currentlyBanned, 0);
  const totalAllTime = jails.reduce((sum, j) => sum + j.totalBanned, 0);
  const activeJails = jails.length;

  return (
    <div className="fade-in">
      <Panel title="Fail2Ban Saldırı Koruması" icon={<ShieldAlert size={20} style={{ marginRight: 8 }} />}
        subtitle="SSH brute-force ve servis saldırılarına karşı otomatik IP engelleme"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn-outline btn-sm" onClick={handleRefresh} disabled={refreshing} title="Yenile">
              {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            </button>
            <button
              className={`toggle-btn ${isEnabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={handleToggle}
              disabled={toggling}
              title={isEnabled ? 'Durdur' : 'Başlat'}
            >
              <div className="toggle-knob" />
            </button>
          </div>
        }>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'overview' && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<Ban size={20} />} label="Aktif Ban" value={loading ? '...' : String(totalBanned)} color="orange" />
            <StatCard icon={<ShieldAlert size={20} />} label="Toplam Ban" value={loading ? '...' : String(totalAllTime)} color="blue" />
            <StatCard icon={<Lock size={20} />} label={<>Aktif <span lang="en">Jail</span></>} value={loading ? '...' : String(activeJails)} color="green" />
            <StatCard icon={<Users size={20} />} label="Son Engelleme" value={loading ? '...' : String(recentBans.length)} color="purple" />
          </div>

          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="Jail Durumları" size="medium">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}><Loader2 size={20} className="spin" /></div>
              ) : jails.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>
                  {isEnabled ? 'Aktif jail bulunamadı' : 'Fail2Ban pasif'}
                </div>
              ) : (
                <div className="jail-list">
                  {jails.map(jail => (
                    <div key={jail.name} className="jail-row">
                      <span className="svc-dot svc-on" />
                      <div className="jail-info">
                        <strong>{jail.name}</strong>
                        <span className="jail-stats">
                          {jail.currentlyBanned > 0 && <Badge variant="error">{jail.currentlyBanned} banned</Badge>}
                          <span className="text-muted">Toplam: {jail.totalBanned}</span>
                        </span>
                      </div>
                      {jail.bannedIps.length > 0 && (
                        <div className="f2b-banned">
                          {jail.bannedIps.map(ip => (
                            <span key={ip} className="f2b-banned-ip">
                              <span>{ip}</span>
                              <button className="btn-outline btn-sm" disabled={unbanning === ip} onClick={() => handleUnban(ip)} title="Yasağı kaldır">
                                {unbanning === ip ? <Loader2 size={11} className="spin" /> : 'Yasağı kaldır'}
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Son Engellenen IP'ler" size="medium">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}><Loader2 size={20} className="spin" /></div>
              ) : recentBans.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>
                  Henüz engelleme kaydı yok
                </div>
              ) : (
                <div className="ban-list">
                  {recentBans.map((ban, i) => (
                    <div key={i} className="ban-row">
                      <span className="ban-ip">{ban.ip}</span>
                      <Badge variant={ban.jail === 'recidive' ? 'error' : 'info'}><span lang="en">{ban.jail}</span></Badge>
                      <span className="ban-time">{ban.time}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <Fail2banSettingsCard />
        </div>
      )}
    </div>
  );
}

import { Activity, AlertTriangle, ArrowDown, ArrowUp, Edit3, Gauge, Plus, RotateCcw, Trash2, Wifi } from 'lucide-react';
import { useApi, putApi, postApi, deleteApi } from '../hooks/useApi';
import { useMemo, useState } from 'react';
import { Panel, StatCard, Badge, Modal, Select } from './ui';
import { toast } from '../toast';
import { BANDWIDTH_TAB_KEY } from '../nav';

// Bant Genişliği: canlı cihaz trafiği + cihaz başına hız sınırı ve kullanım kotası (backend qos.ts — Pi'de nftables ile
// uygulanır). Eskiden kota yalnız veritabanına yazılıyordu ve cihaz eklenemiyordu; hız sınırı Trafik Kontrol'deydi (o da
// uygulanmıyordu). Sınır canlı tablodaki satırdan ya da "Kota ve Hız" sekmesinden eklenir. Hız Mbps, kota GB girilir
// (backend kbps / MB saklar).

type BandwidthTab = 'live' | 'limits';

interface LiveEntry {
  device_mac: string;
  hostname: string;
  bytes_in: number;
  bytes_out: number;
  speed_in_kbps: number;
  speed_out_kbps: number;
  timestamp: string;
}

interface DeviceLimit {
  device_mac: string;
  daily_limit_mb: number;
  monthly_limit_mb: number;
  max_down_kbps: number;
  max_up_kbps: number;
  over_action: 'block' | 'throttle';
  over_kbps: number;
  enabled: number;
}
interface LimitStatus extends DeviceLimit {
  hostname: string;
  ips: string[];
  used_day: number;
  used_month: number;
  over: '' | 'daily' | 'monthly';
  applied: boolean;
  protected?: boolean;
  ip_missing?: boolean;
}
interface LimitsResponse { limits: LimitStatus[]; forwarding: boolean; error: string; protected_macs?: string[] }
interface DeviceRow { mac_address: string; hostname: string; ip_address: string }

const isMac = (s: string) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(s);
const MB = 1048576;

const formatSpeed = (kbps: number) => (kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} Mbps` : `${kbps} kbps`);
const formatBytes = (bytes: number) => {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};
// Girilen sayı ("1,5" da olur) → birim; boş = 0 (sınırsız). Geçersizse NaN.
const parseNum = (s: string) => (s.trim() === '' ? 0 : Number(s.trim().replace(',', '.')));
const trimNum = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',');
const mbpsText = (kbps: number) => `${trimNum(kbps / 1000)} Mbps`;
const gbText = (mb: number) => (mb >= 1024 ? `${trimNum(Math.round((mb / 1024) * 100) / 100)} GB` : `${mb} MB`);

function limitSummary(l: DeviceLimit): string {
  const parts: string[] = [];
  if (l.max_down_kbps || l.max_up_kbps) {
    parts.push(`↓${l.max_down_kbps ? mbpsText(l.max_down_kbps) : '∞'} ↑${l.max_up_kbps ? mbpsText(l.max_up_kbps) : '∞'}`);
  }
  if (l.daily_limit_mb) parts.push(`${gbText(l.daily_limit_mb)}/gün`);
  if (l.monthly_limit_mb) parts.push(`${gbText(l.monthly_limit_mb)}/ay`);
  return parts.join(' · ');
}

function stateBadge(l: LimitStatus, error: string) {
  if (!l.enabled) return <Badge variant="neutral">Kapalı</Badge>;
  if (l.protected) return <span title="Modemin ya da Pi'nin adresi: sınır uygulanmaz (tüm evin trafiği bu adresten geçer)"><Badge variant="warning">Uygulanmaz (modem / Pi)</Badge></span>;
  if (error) return <span title={`Pi'ye uygulanamadı: ${error}`}><Badge variant="error">Uygulanamadı</Badge></span>;
  if (l.ip_missing) {
    return <span title="Cihazın IP adresi henüz bilinmiyor: indirme yönü (ve kota dolunca kesme) cihaz ağda görününce uygulanır"><Badge variant="warning">{l.applied ? 'Kısmen uygulanıyor' : 'IP bekleniyor'}</Badge></span>;
  }
  if (l.over) {
    const when = l.over === 'daily' ? 'günlük' : 'aylık';
    return l.over_action === 'throttle'
      ? <Badge variant="warning">{`Kota doldu (${when}) — yavaşlatıldı`}</Badge>
      : <Badge variant="error">{`Kota doldu (${when}) — internet kesildi`}</Badge>;
  }
  if (!l.applied) return <span title="Hız sınırı yok; kota dolunca uygulanır"><Badge variant="success">İzleniyor</Badge></span>;
  return <Badge variant="success">Uygulanıyor</Badge>;
}

// ─── Sınır düzenleyici ───

interface EditorTarget { mac: string; name: string; limit?: DeviceLimit }
interface EditorForm { mac: string; down: string; up: string; daily: string; monthly: string; action: 'block' | 'throttle'; over: string; enabled: boolean }

const toForm = (t: EditorTarget): EditorForm => {
  const l = t.limit;
  return {
    mac: t.mac,
    down: l?.max_down_kbps ? trimNum(l.max_down_kbps / 1000) : '',
    up: l?.max_up_kbps ? trimNum(l.max_up_kbps / 1000) : '',
    daily: l?.daily_limit_mb ? trimNum(l.daily_limit_mb / 1024) : '',
    monthly: l?.monthly_limit_mb ? trimNum(l.monthly_limit_mb / 1024) : '',
    action: l?.over_action || 'block',
    over: trimNum((l?.over_kbps || 1000) / 1000),
    enabled: l ? !!l.enabled : true,
  };
};

function LimitEditor({ target, choices, onClose, onSaved }: {
  target: EditorTarget; choices: { mac: string; label: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<EditorForm>(() => toForm(target));
  const [saving, setSaving] = useState(false);
  const pick = !target.mac; // "Cihaz ekle": cihaz seçilir
  const set = (patch: Partial<EditorForm>) => setF(prev => ({ ...prev, ...patch }));
  const hasQuota = parseNum(f.daily) > 0 || parseNum(f.monthly) > 0;

  const save = async () => {
    const down = parseNum(f.down), up = parseNum(f.up), daily = parseNum(f.daily), monthly = parseNum(f.monthly), over = parseNum(f.over);
    if (!isMac(f.mac)) { toast.error('Bir cihaz seçin'); return; }
    if ([down, up, daily, monthly].some(n => !Number.isFinite(n) || n < 0)) { toast.error('Değerler boş ya da pozitif sayı olmalı'); return; }
    if (!down && !up && !daily && !monthly) { toast.error('En az bir hız sınırı ya da kota girin'); return; }
    if (hasQuota && f.action === 'throttle' && (!Number.isFinite(over) || over <= 0)) { toast.error('Kota dolunca uygulanacak hızı girin'); return; }
    setSaving(true);
    try {
      await putApi(`/bandwidth/limits/${f.mac.toLowerCase()}`, {
        max_down_kbps: Math.round(down * 1000), max_up_kbps: Math.round(up * 1000),
        daily_limit_mb: Math.round(daily * 1024), monthly_limit_mb: Math.round(monthly * 1024),
        over_action: f.action, over_kbps: Math.round((Number.isFinite(over) && over > 0 ? over : 1) * 1000),
        enabled: f.enabled ? 1 : 0,
      });
      toast.success('Sınır kaydedildi ve uygulandı');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kaydedilemedi');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} width={520}
      title={target.limit ? 'Cihaz sınırını düzenle' : 'Cihaz sınırı ekle'}
      actions={<>
        <button className="btn-outline btn-sm" onClick={onClose} disabled={saving}>İptal</button>
        <button className="btn-primary btn-sm" onClick={save} disabled={saving || !isMac(f.mac)}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
      </>}>
      <div className="bw-form">
        {pick ? (
          <div className="bw-field bw-field-wide">
            <label>Cihaz</label>
            <Select className="config-select" value={f.mac} onChange={e => set({ mac: e.target.value })}>
              <option value="">Cihaz seçin…</option>
              {choices.map(c => <option key={c.mac} value={c.mac}>{c.label}</option>)}
            </Select>
            {!choices.length && <span className="bw-help">Sınır eklenebilecek cihaz yok (hepsinin sınırı var ya da cihaz listesi boş).</span>}
          </div>
        ) : (
          <div className="bw-field bw-field-wide">
            <label>Cihaz</label>
            <div className="bw-device"><strong>{target.name || target.mac}</strong><span>{target.mac}</span></div>
          </div>
        )}

        <div className="bw-section">Hız sınırı <span>boş = sınırsız</span></div>
        <div className="bw-field">
          <label><ArrowDown size={12} /> İndirme (Mbps)</label>
          <input className="config-input" inputMode="decimal" placeholder="Sınırsız" value={f.down} onChange={e => set({ down: e.target.value })} />
        </div>
        <div className="bw-field">
          <label><ArrowUp size={12} /> Yükleme (Mbps)</label>
          <input className="config-input" inputMode="decimal" placeholder="Sınırsız" value={f.up} onChange={e => set({ up: e.target.value })} />
        </div>

        <div className="bw-section">Kullanım kotası <span>indirme + yükleme; boş = yok</span></div>
        <div className="bw-field">
          <label>Günlük (GB)</label>
          <input className="config-input" inputMode="decimal" placeholder="Yok" value={f.daily} onChange={e => set({ daily: e.target.value })} />
        </div>
        <div className="bw-field">
          <label>Aylık (GB)</label>
          <input className="config-input" inputMode="decimal" placeholder="Yok" value={f.monthly} onChange={e => set({ monthly: e.target.value })} />
        </div>
        <div className="bw-field bw-field-wide">
          <label>Kota dolunca</label>
          <div className="bw-over">
            <Select className="config-select" value={f.action} disabled={!hasQuota}
              onChange={e => set({ action: e.target.value === 'throttle' ? 'throttle' : 'block' })}>
              <option value="block">İnterneti kes</option>
              <option value="throttle">Yavaşlat</option>
            </Select>
            {f.action === 'throttle' && (
              <label className="bw-over-speed">
                <input className="config-input" inputMode="decimal" value={f.over} disabled={!hasQuota} onChange={e => set({ over: e.target.value })} />
                <span>Mbps</span>
              </label>
            )}
          </div>
          <span className="bw-help">Günlük kota gece yarısı, aylık kota ayın 1'inde yenilenir; dolunca uygulanan sınır da o zaman kendiliğinden kalkar. Ev ağı, panel ve DNS etkilenmez.</span>
        </div>

        <label className="bw-check bw-field-wide">
          <input type="checkbox" checked={f.enabled} onChange={e => set({ enabled: e.target.checked })} />
          <span>Sınır etkin</span>
        </label>
      </div>
    </Modal>
  );
}

// ─── Kota çubuğu ───

function QuotaBar({ label, used, limitMb, onReset }: { label: string; used: number; limitMb: number; onReset: () => void }) {
  const pct = Math.min(100, (used / (limitMb * MB)) * 100);
  const over = used >= limitMb * MB;
  return (
    <div className="bw-quota">
      <div className="bw-quota-head">
        <span>{label}</span>
        <span className={over ? 'text-danger' : pct >= 80 ? 'text-warning' : ''}>{formatBytes(used)} / {gbText(limitMb)}</span>
        {used > 0 && (
          <button className="icon-btn icon-btn-sm" onClick={onReset} title={`${label} sayacını sıfırla`} aria-label={`${label} sayacını sıfırla`}>
            <RotateCcw size={11} />
          </button>
        )}
      </div>
      <div className="progress-bar"><div className={`progress-fill bw-quota-fill${over ? ' is-over' : pct >= 80 ? ' is-warn' : ''}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// ─── Sayfa ───

export function BandwidthPanel() {
  const [activeTab, setActiveTab] = useState<BandwidthTab>(() => {
    try {
      const t = sessionStorage.getItem(BANDWIDTH_TAB_KEY);
      if (t) { sessionStorage.removeItem(BANDWIDTH_TAB_KEY); return t === 'limits' ? 'limits' : 'live'; }
    } catch { /* depolama yok */ }
    return 'live';
  });
  const { data: liveData } = useApi<{ live: LiveEntry[] }>('/bandwidth/live', { live: [] }, 3000);
  const { data: limitsData, refetch: refetchLimits } = useApi<LimitsResponse>('/bandwidth/limits', { limits: [], forwarding: true, error: '' }, 15000);
  const { data: devicesData } = useApi<{ devices: DeviceRow[] }>('/devices', { devices: [] });
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const tabs: { id: BandwidthTab; label: string; icon: React.ReactNode }[] = [
    { id: 'live', label: 'Canlı İzleme', icon: <Activity size={14} /> },
    { id: 'limits', label: 'Kota ve Hız', icon: <Gauge size={14} /> },
  ];

  const limits = useMemo(() => limitsData.limits || [], [limitsData.limits]);
  const limitOf = useMemo(() => new Map(limits.map(l => [l.device_mac.toLowerCase(), l])), [limits]);
  // Modem / Pi: sınır konamaz (tüm evin trafiği bu adresten geçer).
  const protectedMacs = useMemo(() => new Set((limitsData.protected_macs || []).map(m => m.toLowerCase())), [limitsData.protected_macs]);
  // "Cihaz ekle" seçenekleri: cihaz listesi + canlı tabloda görülen (MAC'i bilinen) cihazlar; sınırı olanlar hariç.
  const choices = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of devicesData.devices || []) {
      const mac = String(d.mac_address || '').toLowerCase();
      if (isMac(mac)) m.set(mac, `${d.hostname || 'Adsız cihaz'} — ${mac}${d.ip_address ? ` (${d.ip_address})` : ''}`);
    }
    for (const e of liveData.live) {
      const mac = e.device_mac.toLowerCase();
      if (isMac(mac) && !m.has(mac)) m.set(mac, `${e.hostname || 'Adsız cihaz'} — ${mac}`);
    }
    return [...m].filter(([mac]) => !limitOf.has(mac) && !protectedMacs.has(mac)).map(([mac, label]) => ({ mac, label })).sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  }, [devicesData.devices, liveData.live, limitOf, protectedMacs]);

  const totalIn = liveData.live.reduce((s, d) => s + d.speed_in_kbps, 0);
  const totalOut = liveData.live.reduce((s, d) => s + d.speed_out_kbps, 0);
  const activeDevices = liveData.live.filter(d => d.speed_in_kbps > 0 || d.speed_out_kbps > 0).length;
  const maxSpeed = Math.max(...liveData.live.map(d => Math.max(d.speed_in_kbps, d.speed_out_kbps)), 1);

  const nameOf = (mac: string, fallback = '') => {
    const d = (devicesData.devices || []).find(x => String(x.mac_address).toLowerCase() === mac);
    return d?.hostname || fallback || limitOf.get(mac)?.hostname || '';
  };
  const openFor = (mac: string, name: string) => {
    const m = mac.toLowerCase();
    setEditor({ mac: m, name: name || nameOf(m), limit: limitOf.get(m) });
  };

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await refetchLimits();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setBusy(null);
    }
  };
  const toggle = (l: LimitStatus) => act(`t:${l.device_mac}`, () => putApi(`/bandwidth/limits/${l.device_mac}`, {
    max_down_kbps: l.max_down_kbps, max_up_kbps: l.max_up_kbps, daily_limit_mb: l.daily_limit_mb, monthly_limit_mb: l.monthly_limit_mb,
    over_action: l.over_action, over_kbps: l.over_kbps, enabled: l.enabled ? 0 : 1,
  }), l.enabled ? 'Sınır kapatıldı' : 'Sınır açıldı');
  const remove = (l: LimitStatus) => {
    if (!window.confirm(`${l.hostname || l.device_mac} için hız ve kota sınırı kaldırılsın mı?`)) return;
    void act(`d:${l.device_mac}`, () => deleteApi(`/bandwidth/limits/${l.device_mac}`), 'Sınır kaldırıldı');
  };
  const reset = (l: LimitStatus, period: 'daily' | 'monthly') => {
    const what = period === 'daily' ? 'bugünkü' : 'bu ayki';
    if (!window.confirm(`${l.hostname || l.device_mac}: ${what} kullanım sayacı sıfırlansın mı? Kota dolmuşsa sınır hemen kalkar.`)) return;
    void act(`r:${l.device_mac}`, () => postApi(`/bandwidth/limits/${l.device_mac}/reset`, { period }), 'Sayaç sıfırlandı');
  };

  return (
    <div className="fade-in">
      <Panel title="Bant Genişliği Yönetimi" icon={<Gauge size={20} style={{ marginRight: 8 }} />}
        subtitle="Cihaz bazlı trafik izleme, hız sınırı ve kullanım kotası">
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

      {activeTab === 'live' && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<ArrowDown size={20} />} label="Toplam İndirme" value={formatSpeed(totalIn)} color="blue" />
            <StatCard icon={<ArrowUp size={20} />} label="Toplam Yükleme" value={formatSpeed(totalOut)} color="green" />
            <StatCard icon={<Wifi size={20} />} label="Aktif Cihaz" value={activeDevices} color="purple" />
            <StatCard icon={<Activity size={20} />} label="İzlenen Cihaz" value={liveData.live.length} color="orange" />
          </div>

          <div style={{ marginTop: 14 }}>
            <Panel title="Cihaz Bazlı Trafik">
              <div className="blocked-list">
                <div className="ban-row" style={{ opacity: 0.6 }}>
                  <span className="ban-ip" style={{ flex: 2 }}>Cihaz</span>
                  <span style={{ flex: 1 }}>İndirme</span>
                  <span style={{ flex: 1 }}>Yükleme</span>
                  <span style={{ flex: 1 }} title="Pi üzerinden geçen trafik; sayaçlar Pi açılınca (ya da güvenlik duvarı yeniden yüklenince) sıfırlanır">Toplam Veri (açılıştan beri)</span>
                  <span className="bw-live-limit">Hız / kota</span>
                </div>
                {liveData.live.length === 0 && (
                  <div className="empty-state" style={{ padding: '20px' }}>Aktif cihaz bulunamadı.</div>
                )}
                {liveData.live.map(device => {
                  const mac = device.device_mac.toLowerCase();
                  const lim = limitOf.get(mac);
                  const isProt = protectedMacs.has(mac);
                  const canLimit = isMac(mac) && !isProt;
                  return (
                    <div key={device.device_mac} className="ban-row">
                      <div style={{ flex: 2, minWidth: 0 }}>
                        <strong>{device.hostname || device.device_mac}</strong>
                        <br />
                        <span className="text-muted" style={{ fontSize: '0.75rem' }}>{device.device_mac}</span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="query-type-row">
                          <div className="progress-bar">
                            <div className="progress-fill progress-cpu"
                              style={{ width: `${(device.speed_in_kbps / maxSpeed) * 100}%` }} />
                          </div>
                        </div>
                        <span style={{ fontSize: '0.75rem' }}>
                          <ArrowDown size={10} /> {formatSpeed(device.speed_in_kbps)}
                        </span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="query-type-row">
                          <div className="progress-bar">
                            <div className="progress-fill progress-mem"
                              style={{ width: `${(device.speed_out_kbps / maxSpeed) * 100}%` }} />
                          </div>
                        </div>
                        <span style={{ fontSize: '0.75rem' }}>
                          <ArrowUp size={10} /> {formatSpeed(device.speed_out_kbps)}
                        </span>
                      </div>
                      <div style={{ flex: 1 }}>
                        <Badge variant="info">{formatBytes(device.bytes_in + device.bytes_out)}</Badge>
                      </div>
                      <div className="bw-live-limit">
                        {lim ? (
                          <button className="bw-limit-chip" onClick={() => openFor(mac, device.hostname)}
                            title="Sınırı düzenle" data-state={!lim.enabled ? 'off' : lim.over ? 'over' : 'on'}>
                            <Gauge size={12} /><span>{limitSummary(lim) || 'Sınır'}</span><Edit3 size={11} />
                          </button>
                        ) : (
                          <button className="btn-outline btn-sm" onClick={() => openFor(mac, device.hostname)} disabled={!canLimit}
                            title={canLimit ? 'Bu cihaza hız sınırı ya da kota koy' : isProt ? "Modemin ya da Pi'nin adresi: sınır konamaz (tüm evin trafiği bu adresten geçer)" : "MAC adresi bilinmeyen cihaza sınır konamaz (ör. Ev VPN'i istemcisi)"}>
                            <Plus size={12} /> Sınır ekle
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'limits' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Cihaz Sınırları" icon={<Gauge size={18} style={{ marginRight: 8 }} />}
            subtitle="Hız sınırı ve günlük / aylık kota — Pi üzerinden internete çıkan trafiğe uygulanır"
            actions={<button className="btn-primary btn-sm" onClick={() => setEditor({ mac: '', name: '' })}><Plus size={13} /> Cihaz ekle</button>}>
            {!limitsData.forwarding && (
              <div className="rl-banner"><AlertTriangle size={14} /><span>Pi şu an yönlendirme yapmıyor (ip_forward kapalı): sınırlar ancak cihazlar interneti Pi üzerinden kullanınca etkili olur.</span></div>
            )}
            {limitsData.error && (
              <div className="rl-banner"><AlertTriangle size={14} /><span>Sınırlar Pi'ye uygulanamadı: {limitsData.error}</span></div>
            )}
            {limits.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 20px' }}>
                Sınır tanımlı cihaz yok. "Cihaz ekle" ile ya da Canlı İzleme'deki satırdan "Sınır ekle" ile başlayın.
              </div>
            ) : (
              <div className="bw-limit-list">
                {limits.map(l => {
                  const name = l.hostname || nameOf(l.device_mac) || l.device_mac;
                  const quota = l.daily_limit_mb > 0 || l.monthly_limit_mb > 0;
                  return (
                    <div key={l.device_mac} className={`bw-limit-card${l.enabled ? '' : ' is-off'}`}>
                      <div className="bw-limit-head">
                        <button className={`toggle-btn toggle-sm ${l.enabled ? 'toggle-on' : 'toggle-off'}`} onClick={() => toggle(l)}
                          disabled={busy !== null} title={l.enabled ? 'Sınırı kapat' : 'Sınırı aç'} aria-label={l.enabled ? 'Sınırı kapat' : 'Sınırı aç'}>
                          <div className="toggle-knob" />
                        </button>
                        <div className="bw-limit-name">
                          <strong>{name}</strong>
                          <span>{l.device_mac}{l.ips.length ? ` · ${l.ips.join(', ')}` : ''}</span>
                        </div>
                        {stateBadge(l, limitsData.error)}
                        <div className="bw-limit-actions">
                          <button className="icon-btn icon-btn-sm" onClick={() => setEditor({ mac: l.device_mac, name, limit: l })} title="Düzenle" aria-label="Düzenle"><Edit3 size={13} /></button>
                          <button className="icon-btn icon-btn-sm cron-delete" onClick={() => remove(l)} disabled={busy !== null} title="Sınırı kaldır" aria-label="Sınırı kaldır"><Trash2 size={13} /></button>
                        </div>
                      </div>
                      <div className="bw-limit-body">
                        <div className="bw-limit-speed">
                          <span><ArrowDown size={11} /> {l.max_down_kbps ? mbpsText(l.max_down_kbps) : 'Sınırsız'}</span>
                          <span><ArrowUp size={11} /> {l.max_up_kbps ? mbpsText(l.max_up_kbps) : 'Sınırsız'}</span>
                          {quota && <span className="bw-limit-over">Kota dolunca: {l.over_action === 'throttle' ? `${mbpsText(l.over_kbps)}'e yavaşlat` : 'interneti kes'}</span>}
                        </div>
                        {quota ? (
                          <div className="bw-quotas">
                            {l.daily_limit_mb > 0 && <QuotaBar label="Bugün" used={l.used_day} limitMb={l.daily_limit_mb} onReset={() => reset(l, 'daily')} />}
                            {l.monthly_limit_mb > 0 && <QuotaBar label="Bu ay" used={l.used_month} limitMb={l.monthly_limit_mb} onReset={() => reset(l, 'monthly')} />}
                          </div>
                        ) : (
                          <div className="bw-help">Kota yok · bugün {formatBytes(l.used_day)}, bu ay {formatBytes(l.used_month)}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
      )}

      {editor && (
        <LimitEditor target={editor} choices={choices} onClose={() => setEditor(null)} onSaved={() => { void refetchLimits(); }} />
      )}
    </div>
  );
}

import { Globe, Server, Gauge, Shield, Settings, Activity, RefreshCw, Loader2, Clock, Database, ShieldCheck, ShieldAlert, AlertTriangle, Check, Sparkles } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge, Select } from './ui';
import type { ServiceStatus } from '../types';
import { toast } from '../toast';

type UnboundTab = 'overview' | 'settings';

// Backend unbound.ts: etkin yapılandırma unbound-checkconf'tan, sayaçlar unbound-control'den; ayarlar gerçekten uygulanır.
interface UnboundSettings {
  num_threads: number; cache_mb: number; cache_min_ttl: number;
  prefetch: boolean; serve_expired: boolean; hide_identity: boolean; hide_version: boolean;
}
interface UnboundStats {
  queries: number | null; cacheHits: number | null; cacheMiss: number | null; hitRate: number | null;
  prefetch: number | null; servedExpired: number | null; recursionAvgMs: number | null; recursionMedianMs: number | null;
  uptimeS: number | null; msgCacheCount: number | null; rrsetCacheCount: number | null;
  secure: number | null; bogus: number | null; servfail: number | null; memCacheBytes: number | null;
}
interface UnboundStatus {
  installed: boolean; running?: boolean; listen?: string; managed?: boolean;
  effective?: UnboundSettings | null; settings?: UnboundSettings | null; recommended: UnboundSettings;
  options: { num_threads: number[]; cache_mb: number[]; cache_min_ttl: number[] };
  extendedStats?: boolean; stats?: UnboundStats | null; security?: { label: string; status: boolean }[];
  error?: string;
}

const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('tr-TR'));
function fmtUptime(s: number | null | undefined) {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} g ${h} sa` : h ? `${h} sa ${m} dk` : `${m} dk`;
}

export function UnboundPanel() {
  const [activeTab, setActiveTab] = useState<UnboundTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const { data: st, loading, refetch: refetchUb } = useApi<UnboundStatus | null>('/unbound/status', null);
  const unboundSvc = svcData.services.find(s => s.name === 'unbound');
  const isEnabled = unboundSvc?.enabled === 1;
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);

  // Anahtar kalıcıdır (açılışta da geçerli). Unbound, Pi-hole'un tek üst DNS'i: durursa ağın DNS'i kesilir.
  const handleToggle = async () => {
    if (isEnabled && !confirm('Unbound durdurulursa Pi-hole alan adlarını çözemez; Pi\'yi DNS olarak kullanan tüm cihazların interneti kesilir ve Pi yeniden başlasa da kapalı kalır. Devam edilsin mi?')) return;
    setToggling(true);
    try {
      await postApi('/services/toggle', { name: 'unbound', enabled: !isEnabled });
      toast.success(isEnabled ? 'Unbound durduruldu' : 'Unbound başlatıldı');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    }
    await Promise.all([refetch(), refetchUb()]);
    setToggling(false);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchUb();
    setRefreshing(false);
  };

  const tabs: { id: UnboundTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <Activity size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
  ];

  const s = st?.stats;
  const listen = st?.listen || '127.0.0.1:5335';
  return (
    <div className="fade-in">
      <Panel title="Unbound Recursive DNS" icon={<Globe size={20} style={{ marginRight: 8 }} />}
        subtitle="Özyinelemeli DNS çözücü — Pi-hole ile entegre, gizlilik odaklı"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn-outline btn-sm" onClick={handleRefresh} disabled={refreshing} title="Yenile">
              {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            </button>
            <button className={`toggle-btn ${isEnabled ? 'toggle-on' : 'toggle-off'}`} onClick={handleToggle} disabled={toggling} title={isEnabled ? 'Durdur' : 'Başlat'}>
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

      {st && !st.installed && (
        <div className="routing-apply routing-apply-err" style={{ marginTop: 14 }}>
          <AlertTriangle size={14} /><span>Unbound bu cihazda kurulu değil.</span>
        </div>
      )}

      {activeTab === 'overview' && st?.installed !== false && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<Globe size={20} />} label="Dinleme" value={loading ? '...' : listen} color="blue" />
            <StatCard icon={<Shield size={20} />} label="Toplam Sorgu" value={loading ? '...' : fmtNum(s?.queries)} color="green" />
            <StatCard icon={<Gauge size={20} />} label="Önbellek İsabeti"
              value={loading ? '...' : s?.hitRate !== null && s?.hitRate !== undefined ? `%${s.hitRate.toLocaleString('tr-TR')}` : '—'} color="purple" />
            <StatCard icon={<Clock size={20} />} label="Ort. Çözüm Süresi"
              value={loading ? '...' : s?.recursionAvgMs !== null && s?.recursionAvgMs !== undefined ? `${s.recursionAvgMs} ms` : '—'} color="cyan" />
          </div>
          {st?.extendedStats ? (
            <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
              <StatCard icon={<Database size={20} />} label="Önbellekteki Yanıt" value={fmtNum(s?.msgCacheCount)} color="purple" />
              <StatCard icon={<ShieldCheck size={20} />} label="DNSSEC Doğrulanan" value={fmtNum(s?.secure)} color="emerald" />
              <StatCard icon={<ShieldAlert size={20} />} label="Reddedilen Sahte Yanıt" value={fmtNum(s?.bogus)} color="orange" />
              <StatCard icon={<Server size={20} />} label="Çalışma Süresi" value={fmtUptime(s?.uptimeS)} color="blue" />
            </div>
          ) : st && (
            <div className="routing-apply" style={{ marginTop: 14 }}>
              <AlertTriangle size={14} />
              <span>Ayrıntılı sayaçlar (önbellekteki yanıt, DNSSEC doğrulanan / reddedilen) kapalı. Ayarlar sekmesinden uygulayınca açılır.</span>
            </div>
          )}
          <p className="subtitle" style={{ marginTop: 10 }}>
            Önbellek isabeti düşük görünür: tekrar eden sorguları önce Pi-hole kendi önbelleğinden yanıtlar, Unbound'a yalnız
            yenileri gelir. Sayaçlar Unbound'un son başlatılmasından beri ({fmtUptime(s?.uptimeS)}).
          </p>
          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="Nasıl Çalışır?" size="medium">
              <div className="info-list">
                <div className="info-item">
                  <span className="info-num">1</span>
                  <div><strong>Pi-hole → Unbound</strong><p>Pi-hole DNS sorgularını {listen}'e yönlendirir</p></div>
                </div>
                <div className="info-item">
                  <span className="info-num">2</span>
                  <div><strong>Özyinelemeli Çözümleme</strong><p>Unbound root DNS sunucularından başlayarak sorguyu çözer</p></div>
                </div>
                <div className="info-item">
                  <span className="info-num">3</span>
                  <div><strong>Önbellekleme</strong><p>Sonuçlar yerel olarak önbelleklenir, tekrar sorgu gerektirmez</p></div>
                </div>
                <div className="info-item">
                  <span className="info-num">4</span>
                  <div><strong>Gizlilik</strong><p>Hiçbir üçüncü taraf DNS sağlayıcısına bağımlılık yoktur</p></div>
                </div>
              </div>
            </Panel>
            <Panel title="Güvenlik Durumu" size="medium">
              {loading ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}><Loader2 size={20} className="spin" /></div>
              ) : !st?.security?.length ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)', fontSize: 13 }}>
                  {isEnabled ? 'Güvenlik bilgisi alınamadı' : 'Unbound pasif'}
                </div>
              ) : (
                <div className="security-checks">
                  {st.security.map(check => (
                    <div key={check.label} className="security-check-row">
                      <span className={`svc-dot ${check.status ? 'svc-on' : 'svc-off'}`} />
                      <span>{check.label}</span>
                      <Badge variant={check.status ? 'success' : 'neutral'}>{check.status ? 'Aktif' : 'Pasif'}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'settings' && st?.installed && (
        <div style={{ marginTop: 14 }}>
          {/* Uygulamadan sonra yeni kayıtlı ayarlarla sıfırdan kurulur */}
          <UnboundSettingsForm key={JSON.stringify(st.settings ?? null)} st={st} onApplied={refetchUb} />
        </div>
      )}
    </div>
  );
}

type Row = { key: keyof UnboundSettings; label: string; desc: string } & (
  { kind: 'select'; options: number[]; fmt: (v: number) => string } | { kind: 'bool' });

function UnboundSettingsForm({ st, onApplied }: { st: UnboundStatus; onApplied: () => Promise<void> }) {
  const [form, setForm] = useState<UnboundSettings>(st.settings || st.recommended);
  const [applying, setApplying] = useState(false);
  const eff = st.effective;

  const rows: Row[] = [
    { key: 'num_threads', kind: 'select', options: st.options.num_threads, fmt: v => String(v), label: 'İş parçacığı',
      desc: 'Küçük ev ağında 1 yeterli (Pi-hole rehberi önerisi); artırmak önbelleği parçalara böler.' },
    { key: 'cache_mb', kind: 'select', options: st.options.cache_mb, fmt: v => `${v} MB`, label: 'Önbellek boyutu',
      desc: 'Yanıt önbelleği; kayıt önbelleği bunun iki katı ayrılır. Unbound\'un varsayılanı 4 MB.' },
    { key: 'cache_min_ttl', kind: 'select', options: st.options.cache_min_ttl, fmt: v => (v ? `${v} sn` : 'Kapalı (0)'), label: 'En kısa önbellek süresi',
      desc: '0 = sitenin kendi süresine uy (önerilen). Yükseltmek, IP adresi değişen sitelerde eski adrese gitmeye yol açabilir.' },
    { key: 'prefetch', kind: 'bool', label: 'Önceden yenileme', desc: 'Sık sorulan kayıtları süresi dolmadan arka planda yeniler.' },
    { key: 'serve_expired', kind: 'bool', label: 'Süresi dolmuş kaydı hemen ver',
      desc: 'Süresi dolan kaydı beklemeden verir ve arka planda yeniler (RFC 8767): sık açılan siteler çözüm beklemeden açılır.' },
    { key: 'hide_identity', kind: 'bool', label: 'Kimliği gizle', desc: 'Sunucu adını soran sorgulara (id.server) yanıt vermez.' },
    { key: 'hide_version', kind: 'bool', label: 'Sürümü gizle', desc: 'Sürümü soran sorgulara (version.bind) yanıt vermez.' },
  ];
  const show = (r: Row, v: number | boolean) => (r.kind === 'bool' ? (v ? 'Açık' : 'Kapalı') : r.fmt(v as number));
  const diff = eff ? rows.filter(r => form[r.key] !== eff[r.key]) : rows;
  const isRecommended = rows.every(r => form[r.key] === st.recommended[r.key]);
  const canApply = !applying && (diff.length > 0 || !st.managed);

  const set = (k: keyof UnboundSettings, v: number | boolean) => setForm(prev => ({ ...prev, [k]: v }));

  const handleApply = async () => {
    if (!confirm('Unbound yeni ayarlarla yeniden başlatılacak; Pi\'nin DNS\'i 1-2 saniye yanıt vermez. Yeni ayarlarla yanıt vermezse eski ayarlar kendiliğinden geri yüklenir. Devam edilsin mi?')) return;
    setApplying(true);
    try {
      await postApi('/unbound/settings', { settings: form as unknown as Record<string, unknown> });
      toast.success('Ayarlar Unbound\'a uygulandı ve Unbound yanıt veriyor');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Uygulanamadı');
    } finally {
      setApplying(false);
      await onApplied();
    }
  };

  return (
    <div className="service-settings">
      <div className="settings-toolbar">
        <div className="settings-toolbar-left">
          <span className="config-item-desc">
            {eff ? (diff.length ? `${diff.length} ayar Pi'deki değerden farklı` : 'Pi\'deki değerlerle aynı') : 'Pi\'deki değerler okunamadı'}
          </span>
        </div>
        <div className="settings-toolbar-right">
          <button className="btn-outline btn-sm" onClick={() => setForm(st.recommended)} disabled={applying || isRecommended}>
            <Sparkles size={13} /> Önerilen değerler
          </button>
          <button className="btn-primary btn-sm" onClick={handleApply} disabled={!canApply}>
            {applying ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            {applying ? 'Uygulanıyor…' : 'Uygula'}
          </button>
        </div>
      </div>

      <div className="routing-apply" style={{ marginTop: 0, marginBottom: 12 }}>
        <AlertTriangle size={14} />
        <span>
          Uygula'ya basınca ayarlar Unbound'a yazılır ve Unbound yeniden başlar (DNS 1-2 sn kesilir). Önce yapılandırma denetlenir;
          Unbound yeni ayarlarla yanıt vermezse eski ayarlar kendiliğinden geri yüklenir.
        </span>
      </div>

      <div className="config-category">
        <div className="config-items">
          {rows.map(r => {
            const changed = eff ? form[r.key] !== eff[r.key] : false;
            return (
              <div key={r.key} className="config-item">
                <div className="config-item-info">
                  <span className="config-item-label">{r.label}</span>
                  <span className="config-item-desc">{r.desc}</span>
                  <span className="config-item-desc">
                    Şu an: {eff ? show(r, eff[r.key]) : '—'}{changed ? ` → ${show(r, form[r.key])}` : ''}
                    {form[r.key] === st.recommended[r.key] ? ' · önerilen' : ''}
                  </span>
                </div>
                <div className="config-item-control">
                  {r.kind === 'bool' ? (
                    <button className={`toggle-btn ${form[r.key] ? 'toggle-on' : 'toggle-off'}`} onClick={() => set(r.key, !form[r.key])}
                      disabled={applying} title={form[r.key] ? 'Kapat' : 'Aç'}>
                      <div className="toggle-knob" />
                    </button>
                  ) : (
                    <Select className={`config-select ${changed ? 'config-changed' : ''}`} value={String(form[r.key])}
                      onChange={e => set(r.key, Number(e.target.value))} disabled={applying}>
                      {r.options.map(o => <option key={o} value={String(o)}>{r.fmt(o)}</option>)}
                    </Select>
                  )}
                </div>
              </div>
            );
          })}
          <div className="config-item">
            <div className="config-item-info">
              <span className="config-item-label">Dinleme adresi</span>
              <span className="config-item-desc">Değiştirilemez: Pi-hole'un üst DNS'i bu adres; değişirse ağın DNS'i kesilir.</span>
            </div>
            <div className="config-item-control"><span className="config-item-label">{st.listen || '—'}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

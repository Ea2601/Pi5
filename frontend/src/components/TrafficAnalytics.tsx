import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowDown, ArrowUp, Crown, Route, BarChart3, AppWindow } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel, StatCard } from './ui';

// Trafik Kontrol → Trafik Analizi. Veri /api/traffic/analytics: Pi'nin 5 dakikada bir kaydettiği cihaz × yol (yerel /
// DPI / VPS) bayt sayaçları ve Pi-hole sorgularından uygulama kullanımı. Kayıt bu sürümle başladığı için geçmiş, kaydın
// başladığı andan itibaren dolar.

type Range = '24h' | '7d';
type Cls = 'local' | 'dpi' | 'vps';
type HourRow = { h: number; route: string; down: number; up: number };
type DevRow = { mac: string; route: string; down: number; up: number };
type AppRow = { name: string; category: string; queries: number; devices: { mac: string; queries: number }[] };
type Analytics = {
  range: Range; recording: boolean; now: number; since: number; firstSampleAt: number | null;
  hours: HourRow[]; devices: DevRow[];
  apps: { available: boolean; error?: string; totalQueries: number; matchedQueries: number; apps: AppRow[] };
  deviceInfo: { mac: string; ip: string | null; hostname: string | null; type: string | null }[];
  vps: { id: number; ip: string; location: string | null }[];
};

const CLS: Cls[] = ['local', 'dpi', 'vps'];
const CLS_LABEL: Record<Cls, string> = { local: 'Yerel', dpi: 'DPI', vps: 'VPS' };
const clsOf = (route: string): Cls => (route === 'dpi' ? 'dpi' : route.startsWith('vps:') ? 'vps' : 'local');
const CAT_LABEL: Record<string, string> = {
  voip: 'Mesajlaşma / arama', streaming: 'Video / müzik', social: 'Sosyal', gaming: 'Oyun', web: 'Web', apple: 'Apple',
};

const fmtBytes = (n: number) =>
  n >= 1099511627776 ? `${(n / 1099511627776).toFixed(1)} TB`
    : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB`
      : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
        : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${Math.round(n)} B`;
// DeviceControlPanel.deviceLabel ile aynı kural
const isRandomMac = (mac: string) => /^[0-9a-f]([26ae])/i.test(mac);
function nameOf(mac: string, info: Map<string, { hostname: string | null; ip: string | null }>): string {
  if (mac.startsWith('ip:')) return mac.slice(3);
  const i = info.get(mac);
  if (i?.hostname) return i.hostname;
  return isRandomMac(mac) ? 'Adsız cihaz (gizli MAC)' : 'Adsız cihaz';
}
const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

type Bucket = { key: string; label: string; local: number; dpi: number; vps: number; down: number; up: number };

export function TrafficAnalytics() {
  const [range, setRange] = useState<Range>('24h');
  const { data, error, loading } = useApi<Analytics | null>(`/traffic/analytics?range=${range}`, null, 60000);

  const info = useMemo(() => new Map((data?.deviceInfo || []).map(d => [d.mac, d])), [data]);

  // Grafik kovaları: 24 saatte saatlik (son 24 saat, boş saatler 0), 7 günde yerel takvim günü.
  const buckets = useMemo<Bucket[]>(() => {
    if (!data) return [];
    const map = new Map<string, Bucket>();
    const order: string[] = [];
    const add = (key: string, label: string) => {
      if (!map.has(key)) { map.set(key, { key, label, local: 0, dpi: 0, vps: 0, down: 0, up: 0 }); order.push(key); }
      return map.get(key)!;
    };
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (data.range === '24h') {
      const end = Math.floor(data.now / 3600) * 3600;
      for (let h = end - 23 * 3600; h <= end; h += 3600) add(String(h), `${pad(new Date(h * 1000).getHours())}:00`);
      for (const r of data.hours) {
        const b = map.get(String(r.h));
        if (!b) continue;
        b[clsOf(r.route)] += r.down + r.up; b.down += r.down; b.up += r.up;
      }
    } else {
      for (let i = 6; i >= 0; i--) {
        const d = new Date((data.now - i * 86400) * 1000);
        add(dayKey(d), `${DAYS[d.getDay()]} ${d.getDate()}`);
      }
      for (const r of data.hours) {
        const b = map.get(dayKey(new Date(r.h * 1000)));
        if (!b) continue;
        b[clsOf(r.route)] += r.down + r.up; b.down += r.down; b.up += r.up;
      }
    }
    return order.map(k => map.get(k)!);
  }, [data]);

  const devices = useMemo(() => {
    const m = new Map<string, { mac: string; down: number; up: number; cls: Record<Cls, number> }>();
    for (const r of data?.devices || []) {
      const e = m.get(r.mac) || { mac: r.mac, down: 0, up: 0, cls: { local: 0, dpi: 0, vps: 0 } };
      e.down += r.down; e.up += r.up; e.cls[clsOf(r.route)] += r.down + r.up;
      m.set(r.mac, e);
    }
    return [...m.values()].sort((a, b) => (b.down + b.up) - (a.down + a.up));
  }, [data]);

  // Eksen birimi en büyük çubuğa göre (GB / MB / KB): eksen yalnız yuvarlak sayılar gösterir, birim başlıkta.
  const axis = useMemo(() => {
    const max = Math.max(0, ...buckets.map(b => b.local + b.dpi + b.vps));
    const [unit, div] = max >= 2 * 1073741824 ? ['GB', 1073741824] : max >= 2 * 1048576 ? ['MB', 1048576] : ['KB', 1024];
    return { unit, div, data: buckets.map(b => ({ ...b, local: b.local / div, dpi: b.dpi / div, vps: b.vps / div })) };
  }, [buckets]);
  const [showAll, setShowAll] = useState(false);
  const total = devices.reduce((a, d) => ({ down: a.down + d.down, up: a.up + d.up }), { down: 0, up: 0 });
  const byCls = devices.reduce((a, d) => { CLS.forEach(c => { a[c] += d.cls[c]; }); return a; }, { local: 0, dpi: 0, vps: 0 } as Record<Cls, number>);
  const sum = byCls.local + byCls.dpi + byCls.vps;
  const pct = (v: number) => (sum > 0 ? Math.round((v / sum) * 100) : 0);
  const top = devices[0];
  const maxDev = devices.length ? devices[0].down + devices[0].up : 0;
  const noData = !!data && data.recording && !data.firstSampleAt;
  const partial = !!data && !!data.firstSampleAt && data.firstSampleAt > data.since;

  const rangeTabs = (
    <div className="ta-range" role="group" aria-label="Zaman aralığı">
      {(['24h', '7d'] as Range[]).map(r => (
        <button key={r} className={`ta-range-btn${range === r ? ' is-on' : ''}`} aria-pressed={range === r} onClick={() => setRange(r)}>
          {r === '24h' ? 'Son 24 saat' : 'Son 7 gün'}
        </button>
      ))}
    </div>
  );

  if (!data) {
    return (
      <div className="ta-root" style={{ marginTop: 14 }}>
        {rangeTabs}
        <div className="empty-state" style={{ padding: 40 }}>
          <BarChart3 size={32} />
          <p>{error ? `Trafik verisi alınamadı (${error})` : loading ? 'Yükleniyor…' : 'Veri yok'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ta-root" style={{ marginTop: 14 }}>
      {rangeTabs}
      {!data.recording && <div className="ta-note">Trafik kaydı yalnız Pi üzerinde çalışır.</div>}
      {noData && <div className="ta-note">Kayıt başladı: Pi trafiği 5 dakikada bir kaydediyor. İlk veriler birkaç dakika içinde görünür, saatlik dağılım zamanla dolar.</div>}
      {partial && <div className="ta-note">Kayıt {new Date(data.firstSampleAt! * 1000).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} itibarıyla tutuluyor; öncesi yok.</div>}

      <div className="stats-grid stats-grid-4" style={{ marginTop: 12 }}>
        <StatCard icon={<ArrowDown size={20} />} label="Toplam indirme" value={fmtBytes(total.down)} color="blue" />
        <StatCard icon={<ArrowUp size={20} />} label="Toplam yükleme" value={fmtBytes(total.up)} color="green" />
        <StatCard icon={<Crown size={20} />} label="En çok kullanan" value={top ? `${nameOf(top.mac, info)} · ${fmtBytes(top.down + top.up)}` : '—'} color="purple" valueClass="ta-stat-text" />
        <StatCard icon={<Route size={20} />} label="Yollar" value={sum ? `Yerel %${pct(byCls.local)} · DPI %${pct(byCls.dpi)} · VPS %${pct(byCls.vps)}` : '—'} color="orange" valueClass="ta-stat-text" />
      </div>

      <div style={{ marginTop: 14 }}>
        <Panel title={data.range === '24h' ? 'Saatlik dağılım' : 'Günlük dağılım'} subtitle={`İndirme + yükleme (${axis.unit}), yola göre: Yerel / DPI / VPS`}>
          <div className="ta-chart" aria-label="Zamana göre trafik grafiği">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={axis.data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false}
                  interval={data.range === '24h' ? 2 : 0} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} width={40}
                  tickFormatter={(v: number) => v.toLocaleString('tr-TR', { maximumFractionDigits: 1 })} />
                <Tooltip cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--panel-border)', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={(v, n) => [fmtBytes(Number(v) * axis.div), String(n)]}
                  labelFormatter={(l, p) => {
                    const b = (p?.[0]?.payload || null) as Bucket | null;
                    return b ? `${l} — ↓ ${fmtBytes(b.down)} ↑ ${fmtBytes(b.up)}` : String(l);
                  }} />
                {CLS.map(c => <Bar key={c} dataKey={c} name={CLS_LABEL[c]} stackId="a" fill={`var(--ta-${c})`} isAnimationActive={false} maxBarSize={28} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="ta-legend">{CLS.map(c => <span key={c} className={`ta-c-${c}`}><i />{CLS_LABEL[c]}</span>)}</div>
        </Panel>
      </div>

      <div style={{ marginTop: 14 }}>
        <Panel title="Cihazlara göre" subtitle="Pi üzerinden geçen veri; çubuk içindeki renkler yolların payı">
          {devices.length === 0 && <div className="empty-state" style={{ padding: 24 }}><p>Bu aralıkta kayıtlı cihaz trafiği yok</p></div>}
          <div className="ta-list">
            {(showAll ? devices : devices.slice(0, 12)).map(d => {
              const t = d.down + d.up;
              const i = info.get(d.mac);
              return (
                <div key={d.mac} className="ta-row">
                  <div className="ta-row-head">
                    <span className="ta-name">{nameOf(d.mac, info)}</span>
                    <span className="ta-sub">{i?.ip || (d.mac.startsWith('ip:') ? '' : d.mac)}</span>
                    <span className="ta-amount">↓ {fmtBytes(d.down)} · ↑ {fmtBytes(d.up)}</span>
                  </div>
                  <div className="ta-bar" style={{ width: `${Math.max(2, (t / (maxDev || 1)) * 100)}%` }}
                    title={CLS.filter(c => d.cls[c] > 0).map(c => `${CLS_LABEL[c]} ${fmtBytes(d.cls[c])}`).join(' · ')}>
                    {CLS.map(c => d.cls[c] > 0 && <span key={c} className={`ta-c-${c}`} style={{ flexGrow: d.cls[c] }} />)}
                  </div>
                </div>
              );
            })}
          </div>
          {devices.length > 12 && (
            <button className="btn-outline btn-sm" style={{ marginTop: 10 }} onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Daha az göster' : `Tümünü göster (${devices.length})`}
            </button>
          )}
        </Panel>
      </div>

      <div style={{ marginTop: 14 }}>
        <Panel title="Uygulamalar" icon={<AppWindow size={18} style={{ marginRight: 8 }} />}
          subtitle="Routing'deki uygulamalar, Pi-hole'un yanıtladığı DNS sorgularına göre: ne sıklıkla kullanıldığını gösterir, veri miktarını değil.">
          {!data.apps.available && (
            <div className="empty-state" style={{ padding: 24 }}>
              <p>{data.apps.error || (data.recording ? 'Pi-hole sorgu kayıtları bulunamadı' : 'Yalnız Pi üzerinde çalışır')}</p>
            </div>
          )}
          {data.apps.available && data.apps.apps.length === 0 && (
            <div className="empty-state" style={{ padding: 24 }}><p>Bu aralıkta tanımlı uygulamalara ait sorgu yok</p></div>
          )}
          <div className="ta-list">
            {data.apps.apps.slice(0, 14).map(a => (
              <div key={a.name} className="ta-row">
                <div className="ta-row-head">
                  <span className="ta-name">{a.name}</span>
                  <span className="ta-cat">{CAT_LABEL[a.category] || a.category}</span>
                  <span className="ta-amount">{a.queries.toLocaleString('tr-TR')} sorgu</span>
                </div>
                <div className="ta-bar ta-bar-app" style={{ width: `${Math.max(2, (a.queries / (data.apps.apps[0]?.queries || 1)) * 100)}%` }}><span /></div>
                <div className="ta-devs">{a.devices.slice(0, 3).map(d => nameOf(d.mac, info)).join(' · ')}</div>
              </div>
            ))}
          </div>
          {data.apps.available && data.apps.totalQueries > 0 && (
            <p className="ta-foot">
              Toplam {data.apps.totalQueries.toLocaleString('tr-TR')} sorgunun %{Math.round((data.apps.matchedQueries / data.apps.totalQueries) * 100)}'i
              bu uygulamalara ait. Tarayıcısında güvenli DNS (DoH) ya da iCloud Özel Geçiş açık cihazların sorguları Pi-hole'a gelmez.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

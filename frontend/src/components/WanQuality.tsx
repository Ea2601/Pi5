import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, Info, Loader2, Power, PowerOff } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { useApi, putApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge, Select } from './ui';
import { fmtDbTime, parseDbTime } from '../time';
import './WanQuality.css';

// Hız Testi → Hat Kalitesi (backend wanMonitor.ts, /api/wan-monitor): hat başına kayıp / gecikme / jitter geçmişi ve kesinti
// listesi. Varsayılan kapalı; açılınca her hat kendi aralığında 5 ping (tahmini aylık veri burada gösterilir). Ayrı parça
// (React.lazy): ana paket büyümesin.

type Role = 'primary' | 'backup';
// lossPct null: ICMP yanıtlanmıyor, TCP 443 açık (hat çalışıyor; kayıp ölçülemedi)
interface Sample {
  at: number; role: Role; dev: string; target: string; sent: number; recv: number; lossPct: number | null;
  rttAvg: number | null; rttMin: number | null; rttMax: number | null; jitter: number | null; tcp: boolean | null;
}
interface LineView {
  role: Role; dev: string; kind: string; state: 'unknown' | 'up' | 'down'; since: number; verdict: 'ok' | 'fail' | 'down' | 'skip';
  reason: string; checkedAt: number; present: boolean; hasRoute: boolean; measured: boolean; watcher: boolean; last: Sample | null;
}
interface Agg { samples: number; lossPct: number | null; rttAvg: number | null; jitter: number | null; rttMax: number | null; tcpOnly: number }
interface Outage { role: Role; dev: string; start: string; end: string | null; minutes: number | null; ongoing: boolean; endMessage: string }
interface Settings { enabled: boolean; intervalS: number; backupIntervalS: number; measureBackup: boolean }
interface Status {
  supported: boolean; settings: Settings; running: boolean; now: number; lines: LineView[];
  summary: { h24: Record<Role, Agg | null>; d7: Record<Role, Agg | null> }; outages: Outage[];
  limits: { intervalMin: number; intervalMax: number; bytesPerSample: number };
}
interface History { hours: number; bucketMs: number; points: ({ t: number; role: Role } & Agg)[] }

const ROLE_NAME: Record<Role, string> = { primary: 'Ana hat', backup: 'Yedek hat' };
const KIND_LABEL: Record<string, string> = {
  wan: 'internet kartı', pppoe: 'PPPoE', vlan: 'VLAN', wifi: 'Wi-Fi internet kartı', bridge: 'Wi-Fi köprüsü (üst ağ)',
  lan: 'modem arkası', eth: 'Ethernet', usb: 'USB modem / telefon', hotspot: 'telefon hotspot\'u',
};
const COLORS: Record<Role, string> = { primary: '#3b82f6', backup: '#f59e0b' };
const PRIMARY_STEPS = [10, 30, 60, 120, 300];
const BACKUP_STEPS = [30, 60, 120, 300, 600];
const DEFAULT_BYTES = 840; // 5 istek + 5 yanıt × 84 B (IP + ICMP)
type ChartPt = { t: number; rtt: number | null; jit: number | null; loss: number | null };
// Grafik açıklaması: yazı nötr renkte (renk simgede; açık temada kehribar yazı okunmuyordu), simge kesikli çizgiyi de gösterir.
const legendText = (v: unknown) => <span className="wq-legend">{String(v)}</span>;

// Aylık (30 gün) tahmini veri: örnek başına bayt × aylık örnek sayısı. Yanıt alınamayan turda 3 hedef denendiği için kesinti
// sırasında biraz artar.
const mbPerMonth = (intervalS: number, bytes: number) => Math.round((bytes * 30 * 86400) / intervalS / 1e6);
const fmtMs = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} ms`);
const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `%${v.toFixed(1)}`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const minutesText = (m: number | null) => (m == null ? '—' : m < 1 ? "1 dk'dan kısa" : m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`);
// "Saat 14:03" (bugün) ya da "01.10 23:50" — ek almayan biçim ("itibarıyla"): saatin okunuşuna göre ek değişirdi.
const sinceText = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString()
  ? `Saat ${clock(ms)}` : new Date(ms).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));

function stateBadge(l: LineView, running: boolean) {
  if (!running) return <Badge variant="neutral">Kapalı</Badge>;
  if (l.verdict === 'skip' && l.role === 'backup' && !l.present) return <Badge variant="warning">Ölçülemedi</Badge>;
  // Ne ping atıldı ne izleyici okunabildi (ör. yedek hat ping'i kapalı, izleyici çalışmıyor): eski durum gösterilmez
  if (l.verdict === 'skip' && !l.measured && !l.watcher) return <Badge variant="neutral">Ölçülmüyor</Badge>;
  if (l.state === 'down') return <Badge variant="error">Kesik</Badge>;
  if (l.state === 'up') return <Badge variant="success">Çalışıyor</Badge>;
  return <Badge variant="neutral">Ölçülüyor…</Badge>;
}

function LineCard({ l, st }: { l: LineView; st: Status }) {
  const day = st.summary.h24[l.role];
  const last = l.last;
  const icmpOff = !!last && last.tcp === true && last.recv === 0;
  const notes: { tone: 'info' | 'warn'; text: string }[] = [];
  if (st.running && l.state === 'down' && l.since) notes.push({ tone: 'warn', text: `${sinceText(l.since)} itibarıyla kesik — ${l.reason || 'yanıt yok'}` });
  else if (st.running && l.verdict === 'fail') notes.push({ tone: 'warn', text: `Son ölçümde yanıt yok (${l.reason}) — bir sonraki ölçüm de yanıtsızsa kesik sayılır` });
  else if (st.running && l.verdict === 'skip' && l.reason) notes.push({ tone: 'info', text: l.reason.charAt(0).toUpperCase() + l.reason.slice(1) });
  if (l.role === 'backup' && !st.settings.measureBackup) notes.push({ tone: 'info', text: 'Yedek hat ping\'lenmiyor (ayar kapalı) — durum yalnız yedek hat izleyicisinden' });
  if (st.running && l.watcher) notes.push({ tone: 'info', text: 'Kesinti kararı yedek hat izleyicisinden (ikinci bir karar yok)' });
  if (icmpOff) notes.push({ tone: 'info', text: 'Hat ICMP (ping) yanıtlamıyor, TCP 443 açık — hat çalışıyor sayıldı; kayıp ve gecikme ölçülemiyor' });
  return (
    <div className={`wq-line${l.state === 'down' && st.running ? ' is-down' : ''}`}>
      <div className="wq-line-head">
        <div className="wq-line-name">
          <strong>{ROLE_NAME[l.role]}</strong>
          <span className="wq-mono">{l.dev || 'arayüz yok'}</span>
          <span className="wq-kind">{KIND_LABEL[l.kind] || l.kind}</span>
        </div>
        {stateBadge(l, st.running)}
      </div>
      <div className="wq-metrics">
        <div><span>Gecikme</span><strong>{fmtMs(last?.rttAvg)}</strong></div>
        <div>
          <span>Kayıp</span>
          {icmpOff
            ? <strong className="wq-na" title="Hat ICMP (ping) yanıtlamıyor, TCP 443 açık">ICMP yanıtsız</strong>
            : <strong className={(last?.lossPct ?? 0) >= 5 ? 'wq-bad' : ''}>{last ? fmtPct(last.lossPct) : '—'}</strong>}
        </div>
        <div><span>Jitter</span><strong>{fmtMs(last?.jitter)}</strong></div>
      </div>
      {day && (
        <p className="wq-day">
          Son 24 saat: ort. {fmtMs(day.rttAvg)} · kayıp {fmtPct(day.lossPct)} · jitter {fmtMs(day.jitter)} · {day.samples} ölçüm
        </p>
      )}
      {last && <p className="wq-day">Son ölçüm {clock(last.at)} · hedef {last.target}</p>}
      {notes.map((n, i) => (
        <p key={i} className={`wq-line-note${n.tone === 'warn' ? ' is-warn' : ''}`}>
          {n.tone === 'warn' ? <AlertTriangle size={13} /> : <Info size={13} />}<span>{n.text}</span>
        </p>
      ))}
    </div>
  );
}

export function WanQuality() {
  const { data: st, error, refetch } = useApi<Status | null>('/wan-monitor', null, 15000);
  const [hours, setHours] = useState<24 | 168>(24);
  const { data: hist, loading: histLoading, error: histErr, refetch: refetchHist } =
    useApi<History | null>(`/wan-monitor/history?hours=${hours}`, null, 60000);
  const [busy, setBusy] = useState(false);

  // Hat başına ayrı seri: örneği olmayan kova satır olarak oluşmaz (seyrek ölçülen yedek hat kesik çizilmez). Ölçüm olmayan
  // uzun aralıkta (izleme / panel kapalıydı) çizgi kırılır; tam kayıplı kovada gecikme boş kalır (kesinti boşluğu).
  const intervalS = st?.settings.intervalS, backupIntervalS = st?.settings.backupIntervalS;
  const series = useMemo(() => {
    const out: Record<Role, ChartPt[]> = { primary: [], backup: [] };
    if (!hist) return out;
    const every: Record<Role, number> = { primary: (intervalS || 30) * 1000, backup: (backupIntervalS || 60) * 1000 };
    for (const role of ['primary', 'backup'] as const) {
      const gap = Math.max(2 * hist.bucketMs, 2.5 * every[role]);
      let prev: number | null = null;
      for (const p of hist.points.filter(x => x.role === role).sort((a, b) => a.t - b.t)) {
        if (prev !== null && p.t - prev > gap) out[role].push({ t: prev + hist.bucketMs, rtt: null, jit: null, loss: null });
        out[role].push({ t: p.t, rtt: p.rttAvg, jit: p.jitter, loss: p.lossPct });
        prev = p.t;
      }
    }
    return out;
  }, [hist, intervalS, backupIntervalS]);
  const hasBackup = series.backup.length > 0;
  const chartReady = Math.max(series.primary.length, series.backup.length) > 1;

  if (error === 'HTTP 409') {
    return (
      <Panel title="Hat Kalitesi" icon={<Activity size={20} style={{ marginRight: 8 }} />}>
        <p className="wq-help">Bu cihaz uydu — hat izleme ana cihazdadır.</p>
      </Panel>
    );
  }
  if (!st) {
    return <div className="wq-loading">{error ? <span className="wq-help">Hat izleme durumu okunamadı ({error})</span> : <Loader2 size={18} className="spin" />}</div>;
  }

  const s = st.settings;
  const bytes = st.limits?.bytesPerSample || DEFAULT_BYTES;
  const save = async (patch: Partial<Settings>, okMsg: string) => {
    setBusy(true);
    try {
      await putApi('/wan-monitor/settings', patch);
      toast.success(okMsg);
      await Promise.all([refetch(), refetchHist()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ayar kaydedilemedi');
    } finally {
      setBusy(false);
    }
  };
  const lineTip = (v: unknown, name: unknown): [string, string] =>
    [typeof v === 'number' ? (String(name).includes('kayıp') ? `%${v.toFixed(1)}` : `${v.toFixed(1)} ms`) : '—', String(name)];
  const tick = (t: number) => new Date(t).toLocaleString('tr-TR', hours > 24
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const tipLabel = (t: unknown) => (typeof t === 'number' ? new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

  return (
    <div className="wq">
      <Panel title="Hat Kalitesi" icon={<Activity size={20} style={{ marginRight: 8 }} />}
        subtitle="Ana hat ve yedek hat için paket kaybı, gecikme ve jitter geçmişi; hat kesilince ve geri gelince Bildirimler'e yazılır"
        badge={<Badge variant={s.enabled ? 'success' : 'neutral'}>{s.enabled ? 'Açık' : 'Kapalı'}</Badge>}
        actions={s.enabled
          ? <button className="btn-outline btn-sm wq-off" disabled={busy} onClick={() => { void save({ enabled: false }, 'Hat izleme kapatıldı'); }}>
              {busy ? <Loader2 size={14} className="spin" /> : <PowerOff size={14} />} Kapat
            </button>
          : <button className="btn-primary btn-sm wq-on" disabled={busy || !st.supported} onClick={() => { void save({ enabled: true }, 'Hat izleme açıldı'); }}>
              {busy ? <Loader2 size={14} className="spin" /> : <Power size={14} />} Hat izlemeyi aç
            </button>}>
        {!st.supported && <p className="wq-note"><Info size={14} /><span>Bu sistemde ölçüm yapılamaz (yalnız Pi / Linux).</span></p>}
        {!s.enabled && (
          <p className="wq-note">
            <Info size={14} />
            <span>Kapalı: ölçüm yapılmaz, veri harcanmaz. Açınca her hat seçilen aralıkta 1.1.1.1'e 5 ping atar (yanıt yoksa
              8.8.8.8 ve 9.9.9.9, o da olmazsa TCP 443 denenir). Ağ ayarlarına dokunulmaz.</span>
          </p>
        )}
        <div className="wq-settings">
          <label className="wq-field">
            <span>Ana hat ölçümü</span>
            <Select className="config-select" value={String(s.intervalS)} disabled={busy}
              onChange={e => { void save({ intervalS: Number(e.target.value) }, 'Ölçüm aralığı kaydedildi'); }}>
              {[...new Set([...PRIMARY_STEPS, s.intervalS])].sort((a, b) => a - b).map(v => (
                <option key={v} value={String(v)}>{`${v} sn'de bir (≈${mbPerMonth(v, bytes)} MB/ay)`}</option>
              ))}
            </Select>
          </label>
          <label className="wq-field">
            <span>Yedek hat ölçümü</span>
            <Select className="config-select" value={String(s.backupIntervalS)} disabled={busy || !s.measureBackup}
              onChange={e => { void save({ backupIntervalS: Number(e.target.value) }, 'Ölçüm aralığı kaydedildi'); }}>
              {[...new Set([...BACKUP_STEPS, s.backupIntervalS])].sort((a, b) => a - b).map(v => (
                <option key={v} value={String(v)}>{`${v} sn'de bir (≈${mbPerMonth(v, bytes)} MB/ay)`}</option>
              ))}
            </Select>
          </label>
          <label className="wq-check">
            <input type="checkbox" checked={s.measureBackup} disabled={busy}
              onChange={e => { void save({ measureBackup: e.target.checked }, e.target.checked ? 'Yedek hat da ölçülecek' : 'Yedek hat ping\'lenmeyecek'); }} />
            <span>Yedek hattı da ölç (kotalı 4G/5G hatta veri harcar)</span>
          </label>
        </div>
        <p className="wq-help">
          Tahmini veri: ana hat ≈{mbPerMonth(s.intervalS, bytes)} MB/ay{s.measureBackup ? `, yedek hat ≈${mbPerMonth(s.backupIntervalS, bytes)} MB/ay` : ', yedek hat ölçülmüyor'}.
          Yedek hat açıkken kesinti kararı yedek hat izleyicisinden okunur; yoksa varsayılan rota kaybında hemen, rota varken
          art arda 2 yanıtsız ölçümde (TCP 443 de kapalıysa) hat kesik sayılır.
        </p>
      </Panel>

      <Panel title="Hatlar" className="wq-gap">
        {st.lines.length
          ? <div className="wq-lines">{st.lines.map(l => <LineCard key={l.role} l={l} st={st} />)}</div>
          : <p className="wq-help">{st.running ? 'İlk ölçüm sürüyor…' : 'Ölçülecek hat bulunamadı.'}</p>}
      </Panel>

      <Panel title="Gecikme ve kayıp geçmişi" className="wq-gap"
        actions={
          <div className="wq-period">
            {([24, 168] as const).map(h => (
              <button key={h} className={`btn-sm ${hours === h ? 'btn-primary' : 'btn-outline'}`} onClick={() => setHours(h)}>
                {h === 24 ? '24 Saat' : '7 Gün'}
              </button>
            ))}
          </div>
        }>
        {chartReady ? (
          <>
            <p className="wq-chart-title">Ortalama gecikme ve jitter (ms)</p>
            <div className="wq-chart">
              <ResponsiveContainer>
                <LineChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={tick} stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} width={40} />
                  <Tooltip labelFormatter={tipLabel} formatter={lineTip} contentStyle={{ background: '#111820', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={legendText} />
                  <Line data={series.primary} type="monotone" dataKey="rtt" name="Ana hat gecikme" legendType="plainline" stroke={COLORS.primary} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                  <Line data={series.primary} type="monotone" dataKey="jit" name="Ana hat jitter" legendType="plainline" stroke={COLORS.primary} strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                  {hasBackup && <Line data={series.backup} type="monotone" dataKey="rtt" name="Yedek hat gecikme" legendType="plainline" stroke={COLORS.backup} strokeWidth={2} dot={false} isAnimationActive={false} />}
                  {hasBackup && <Line data={series.backup} type="monotone" dataKey="jit" name="Yedek hat jitter" legendType="plainline" stroke={COLORS.backup} strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="wq-chart-title">Paket kaybı (%)</p>
            <div className="wq-chart wq-chart-sm">
              <ResponsiveContainer>
                <LineChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={tick} stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} width={40} domain={[0, 100]} />
                  <Tooltip labelFormatter={tipLabel} formatter={lineTip} contentStyle={{ background: '#111820', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }} />
                  {hasBackup && <Legend wrapperStyle={{ fontSize: 11 }} formatter={legendText} />}
                  <Line data={series.primary} type="stepAfter" dataKey="loss" name="Ana hat kayıp" legendType="plainline" stroke={COLORS.primary} strokeWidth={2} dot={false} isAnimationActive={false} />
                  {hasBackup && <Line data={series.backup} type="stepAfter" dataKey="loss" name="Yedek hat kayıp" legendType="plainline" stroke={COLORS.backup} strokeWidth={2} dot={false} isAnimationActive={false} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : !hist && histLoading ? (
          <div className="wq-loading"><Loader2 size={18} className="spin" /></div>
        ) : !hist && histErr ? (
          <p className="wq-help">Ölçüm geçmişi okunamadı ({histErr}) — sayfa birazdan yeniden dener.</p>
        ) : (
          <p className="wq-help">{s.enabled ? 'Grafik için yeterli ölçüm yok — birkaç dakika sonra burada görünür.' : 'Hat izleme açılınca ölçümler burada görünür.'}</p>
        )}
      </Panel>

      <Panel title="Kesintiler" className="wq-gap" badge={<Badge variant={st.outages.length ? 'warning' : 'neutral'}>{`${st.outages.length} · 7 gün`}</Badge>}>
        {st.outages.length ? (
          <div className="wq-outages">
            {st.outages.map((o, i) => {
              const start = parseDbTime(o.start);
              return (
                <div key={`${o.role}-${o.start}-${i}`} className="wq-outage">
                  <span className="wq-outage-line"><strong>{ROLE_NAME[o.role]}</strong> <span className="wq-mono">{o.dev}</span></span>
                  <span className="wq-outage-time">{fmtDbTime(o.start, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    {' – '}
                    {o.end ? (parseDbTime(o.end)?.toDateString() === start?.toDateString()
                      ? parseDbTime(o.end)?.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
                      : fmtDbTime(o.end, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))
                      : o.ongoing ? 'sürüyor' : 'bitişi kaydedilmedi'}
                  </span>
                  <span className={`wq-outage-dur${o.ongoing ? ' wq-bad' : ''}`}>{o.end ? minutesText(o.minutes) : o.ongoing ? 'sürüyor' : '—'}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="wq-help">Son 7 günde kayıtlı kesinti yok.</p>
        )}
      </Panel>
    </div>
  );
}

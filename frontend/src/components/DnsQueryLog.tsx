import { Fragment, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Search, ShieldOff, ShieldCheck, ShieldBan, Pause, Play, X, Loader2, AlertTriangle, Info, Activity, Percent, MonitorSmartphone,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel, Select, SelectOption, StatCard } from './ui';
import './DnsQueryLog.css';

// DNS sorgu kaydı (backend system.ts getDnsQueries): Pi-hole FTL veritabanındaki en yeni sorgular, yeniden eskiye. FTL diske
// dakikada bir yazar (database.DBinterval): yeni sorgular toplu ve bir dakikaya kadar gecikmeyle gelir, 3 sn'de bir yoklamak
// bir şey kazandırmıyordu. Özet ve süzgeçler bu pencerede (son LIMIT sorgu), tarayıcıda çalışır.
const LIMIT = 200;
const POLL_MS = 5000;

interface DnsQuery {
  id: number;
  timestamp: string;
  client_ip: string;
  domain: string;
  type: string;
  status: 'blocked' | 'allowed';
}
interface DnsQueryData { queries: DnsQuery[] }
interface Device { ip_address?: string | null; hostname?: string | null }

// Satır: kalıcı anahtar + biçimlenmiş zaman. Backend'in id'si sıra numarasıdır, her yoklamada kayar — yeni satırları ayırt
// etmek (vurgu, "N yeni") için zaman + istemci + ad + tür + durumdan anahtar; aynı saniyede tekrarlanan sorguya sıra eki.
interface Row extends DnsQuery { key: string; ms: number; time: string; day: string }

type StatusFilter = 'all' | 'blocked' | 'allowed';
const STATUS_TABS: { id: StatusFilter; label: string; icon?: ReactNode }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'blocked', label: 'Engellenen', icon: <ShieldOff size={14} /> },
  { id: 'allowed', label: 'İzin verilen', icon: <ShieldCheck size={14} /> },
];

const EMPTY: DnsQueryData = { queries: [] };
const TIME = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const HM = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
const PCT = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 1 });
const NUM = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
// Pi'nin kendi sorguları (cihaz listesinde yok)
const LOCAL: Record<string, string> = { '127.0.0.1': 'Pi (yerel)', '::1': 'Pi (yerel)' };
const nameOf = (names: Map<string, string>, ip: string) => names.get(ip) || LOCAL[ip] || '';

function keyed(queries: DnsQuery[]): Row[] {
  const seen = new Map<string, number>();
  return queries.map(q => {
    const base = `${q.timestamp}|${q.client_ip}|${q.domain}|${q.type}|${q.status}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const ms = Date.parse(q.timestamp);
    const ok = Number.isFinite(ms);
    return { ...q, key: `${base}#${n}`, ms, time: ok ? TIME.format(ms) : q.timestamp, day: ok ? DAY.format(ms) : '' };
  });
}

// Aramayla eşleşen parçayı işaretle (ilk eşleşme)
function Hit({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="dq-hit">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function DnsQueryLog() {
  const { data, loading, error } = useApi<DnsQueryData>(`/dns/queries?limit=${LIMIT}`, EMPTY, POLL_MS);
  // IP → cihaz adı (bir kez). Liste en son görülen önce gelir: aynı IP'de ilk kayıt geçerli (eski kiradaki ad karışmasın).
  const { data: devData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const names = useMemo(() => {
    const m = new Map<string, string>();
    const seen = new Set<string>();
    for (const d of devData.devices || []) {
      if (!d.ip_address || seen.has(d.ip_address)) continue;
      seen.add(d.ip_address);
      if (d.hostname) m.set(d.ip_address, d.hostname);
    }
    return m;
  }, [devData.devices]);

  const live = useMemo(() => keyed(data.queries || []), [data.queries]);
  // Duraklat: liste o anki hâlinde donar (okurken kaymasın); yoklama sürer, arada gelenler "N yeni" olarak sayılır.
  const [frozen, setFrozen] = useState<Row[] | null>(null);
  const shown = frozen ?? live;
  const pending = useMemo(() => {
    if (!frozen) return 0;
    const had = new Set(frozen.map(r => r.key));
    return live.filter(r => !had.has(r.key)).length;
  }, [frozen, live]);

  // Yeni gelen satırlar (kısa vurgu): bir önceki gösterilen listede olmayanlar. İlk yüklemede vurgu yok; sürdürünce
  // duraklatmadayken gelenlerin hepsi vurgulanır.
  const [seen, setSeen] = useState<{ src: Row[]; fresh: ReadonlySet<string> }>({ src: shown, fresh: new Set() });
  if (seen.src !== shown) {
    const before = new Set(seen.src.map(r => r.key));
    setSeen({ src: shown, fresh: new Set(seen.src.length ? shown.filter(r => !before.has(r.key)).map(r => r.key) : []) });
  }

  const [status, setStatus] = useState<StatusFilter>('all');
  const [device, setDevice] = useState('');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const q = search.trim().toLowerCase();

  // Özet pencerenin tamamından (süzgeçten bağımsız)
  const stats = useMemo(() => {
    const perClient = new Map<string, number>();
    let blocked = 0, min = Infinity, max = -Infinity;
    for (const r of shown) {
      if (r.status === 'blocked') blocked++;
      perClient.set(r.client_ip, (perClient.get(r.client_ip) ?? 0) + 1);
      if (Number.isFinite(r.ms)) { min = Math.min(min, r.ms); max = Math.max(max, r.ms); }
    }
    const minutes = max > min ? (max - min) / 60000 : 0;
    return { total: shown.length, blocked, perClient, min, max, rate: shown.length > 1 && minutes >= 0.5 ? (shown.length - 1) / minutes : null };
  }, [shown]);

  // Cihaz seçenekleri: penceredeki istemciler (adıyla) + seçili olan (pencereden düşse de seçim görünsün)
  const deviceOpts = useMemo(() => {
    const ips = new Set(stats.perClient.keys());
    if (device) ips.add(device);
    return [...ips].map(ip => {
      const nm = nameOf(names, ip);
      return { ip, name: nm, n: stats.perClient.get(ip) ?? 0, sort: nm || ip };
    }).sort((a, b) => a.sort.localeCompare(b.sort, 'tr', { numeric: true }));
  }, [stats.perClient, device, names]);

  const filtered = useMemo(() => shown.filter(r =>
    (status === 'all' || r.status === status)
    && (!device || r.client_ip === device)
    && (!q || r.domain.toLowerCase().includes(q) || r.client_ip.includes(q) || nameOf(names, r.client_ip).toLowerCase().includes(q)),
  ), [shown, status, device, q, names]);
  const multiDay = useMemo(() => new Set(filtered.map(r => r.day)).size > 1, [filtered]);
  const filtering = status !== 'all' || device !== '' || q !== '';
  const clearFilters = () => { setStatus('all'); setDevice(''); setSearch(''); };

  const state = error ? 'error' : frozen ? 'paused' : 'live';
  const windowText = stats.total
    ? `Son ${stats.total} sorgu${stats.max > stats.min ? ` · ${HM.format(stats.min)} – ${HM.format(stats.max)}` : ''}`
    : '';

  return (
    <div className="page-stack fade-in">
      <Panel title="DNS Sorgu Logu" icon={<Search size={20} style={{ marginRight: 8 }} />} className="dq-head"
        subtitle="Ağdaki cihazların Pi-hole'a sorduğu alan adları — hangisi yanıtlandı, hangisi engellendi"
        actions={
          <div className="dq-live">
            <span className={`dq-live-state is-${state}`} role="status">
              <span className={state === 'live' ? 'dot pulse' : state === 'error' ? 'dot dot-error' : 'dq-live-idle'} aria-hidden="true" />
              {state === 'live' ? 'Canlı' : state === 'error' ? 'Bağlantı yok' : 'Duraklatıldı'}
            </span>
            <button type="button" className={`${frozen ? 'btn-primary' : 'btn-outline'} btn-sm`} onClick={() => setFrozen(frozen ? null : live)}
              title={frozen ? 'Akışı sürdür' : 'Listeyi dondur — okurken kaymasın'}>
              {frozen
                ? <><Play size={13} /> Sürdür{pending ? ` · ${pending}${pending >= live.length ? '+' : ''} yeni` : ''}</>
                : <><Pause size={13} /> Duraklat</>}
            </button>
          </div>
        }>
        <p className="dq-note">
          <Info size={13} /> Pi-hole sorguları veritabanına dakikada bir yazar: yeni sorgular toplu ve bir dakikaya kadar gecikmeyle
          gelir. Özet ve süzgeçler son {LIMIT} sorguyu kapsar; bir cihaza tıklayınca yalnız onun sorguları görünür.
        </p>
      </Panel>

      <div className="stats-grid stats-grid-4 dq-stats">
        <StatCard icon={<Activity size={20} />} label="Sorgu / dk" color="green"
          value={stats.rate === null ? '—' : NUM.format(stats.rate >= 10 ? Math.round(stats.rate) : stats.rate)} />
        <StatCard icon={<ShieldBan size={20} />} label="Engellenen" value={stats.blocked.toLocaleString('tr-TR')} color="orange" />
        <StatCard icon={<Percent size={20} />} label="Engelleme oranı" value={stats.total ? PCT.format(stats.blocked / stats.total) : '—'} color="blue" />
        <StatCard icon={<MonitorSmartphone size={20} />} label="Cihaz" value={stats.perClient.size} color="purple" />
      </div>

      <Panel title="Sorgular" badge={windowText ? <span className="dq-window">{windowText}</span> : undefined}>
        {error && (
          <div className="routing-apply routing-apply-err dq-alert">
            <AlertTriangle size={14} />
            <span>Sorgu kaydı alınamadı ({error}){shown.length ? ' — son alınan liste gösteriliyor' : ''}.</span>
          </div>
        )}

        <div className="dq-filters">
          <div className="dq-seg" role="radiogroup" aria-label="Duruma göre süz">
            {STATUS_TABS.map(t => (
              <button key={t.id} type="button" role="radio" aria-checked={status === t.id} data-s={t.id}
                className={`dq-seg-btn${status === t.id ? ' is-on' : ''}`} onClick={() => setStatus(t.id)}>
                {t.icon}{t.label}
              </button>
            ))}
          </div>
          <Select className="dq-select" value={device} onChange={e => setDevice(e.target.value)} aria-label="Cihaz" columns={['text', 'mono', 'num']}>
            <option value="">Tüm cihazlar</option>
            {/* Ad | IP | sorgu sayısı — her biri kendi sütununda hizalı; adı bilinmeyen cihaz "Adsız cihaz" */}
            {deviceOpts.map(o => <SelectOption key={o.ip} value={o.ip} cols={[o.name || 'Adsız cihaz', o.ip, o.n]} />)}
          </Select>
          <label className="dq-search">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} type="search" placeholder="Alan adı, cihaz ya da IP ara" value={search}
              onChange={e => setSearch(e.target.value)} aria-label="Sorgularda ara" />
            {search && (
              <button type="button" className="dq-clear" aria-label="Aramayı temizle"
                onClick={() => { setSearch(''); searchRef.current?.focus(); }}>
                <X size={14} />
              </button>
            )}
          </label>
        </div>

        {filtering && shown.length > 0 && (
          <div className="dq-meta">
            <span>{filtered.length} / {shown.length} sorgu gösteriliyor</span>
            <button type="button" className="dq-link" onClick={clearFilters}>Süzgeçleri temizle</button>
          </div>
        )}

        {loading && !shown.length ? (
          <div className="empty-state dq-empty"><Loader2 size={18} className="spin" /></div>
        ) : !shown.length ? (
          <div className="empty-state dq-empty">
            {error ? 'Sorgu kaydı okunamadı.' : 'Henüz sorgu yok. Pi-hole çalışıyorsa yeni sorgular bir dakika içinde burada görünür.'}
          </div>
        ) : !filtered.length ? (
          <div className="empty-state dq-empty">
            Bu süzgeçle eşleşen sorgu yok.
            <button type="button" className="btn-outline btn-sm" onClick={clearFilters}>Süzgeçleri temizle</button>
          </div>
        ) : (
          <div className="dq-list" role="list" aria-label="DNS sorguları">
            <div className="dq-cols" aria-hidden="true"><span /><span>Saat</span><span>Alan adı</span><span>Cihaz</span><span>Tür</span></div>
            {filtered.map((r, i) => {
              const nm = nameOf(names, r.client_ip);
              const blocked = r.status === 'blocked';
              const mine = device === r.client_ip;
              return (
                <Fragment key={r.key}>
                  {multiDay && (i === 0 || filtered[i - 1].day !== r.day) && <div className="dq-day" role="presentation">{r.day}</div>}
                  <div role="listitem" className={`dq-row${blocked ? ' is-blocked' : ''}${seen.fresh.has(r.key) ? ' is-new' : ''}`}>
                    <span className="dq-st" role="img" aria-label={blocked ? 'Engellendi' : 'İzin verildi'} title={blocked ? 'Engellendi' : 'İzin verildi'}>
                      {blocked ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                    </span>
                    <time className="dq-time" dateTime={r.timestamp}>{r.time}</time>
                    <span className="dq-domain" title={r.domain}><Hit text={r.domain} q={q} /></span>
                    <button type="button" className={`dq-dev${mine ? ' is-on' : ''}`} onClick={() => setDevice(mine ? '' : r.client_ip)}
                      title={mine ? 'Tüm cihazları göster' : 'Yalnız bu cihazın sorguları'}>
                      {nm && <span className="dq-dev-name">{nm}</span>}
                      <span className="dq-dev-ip">{r.client_ip}</span>
                    </button>
                    <span className="dq-type">{r.type}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

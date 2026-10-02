import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { CalendarDays, AlertTriangle, Info, ChevronRight, Repeat, RefreshCw, Loader2, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel } from './ui';
import { parseDbTime } from '../time';
import { BANDWIDTH_TAB_KEY, MAINTENANCE_TAB_KEY } from '../nav';
import type { TabId } from '../types';
import './AgendaPanel.css';

// Ağ Ajandası (backend agenda.ts, GET /api/agenda): Pi'de zamanlanmış işler ve saat pencereleri — salt okunur. Ebeveyn ve
// Trafik Zamanlayıcı pencereleri, panel ve sistem cron görevleri, bulut yedeği, otomatik hız testi, kota dönemi ve Zapret
// gece denetimi gün gün listelenir; eşleşen günde 24'ten çok ya da 5 dakikadan sık tekrar eden işler "Periyodik işler"
// özetindedir. Saatler Pi'nin saat dilimiyle gösterilir (tarayıcınınki farklı olsa da).
type Source = 'parental' | 'traffic' | 'cron' | 'system' | 'vault' | 'speedtest' | 'quota' | 'zapret';
// sub: sayfanın açılacak alt sekmesi (tek seferlik oturum anahtarıyla)
interface AgendaLink { tab: TabId; sub?: string }
interface AgendaItem {
  id: string; source: Source; title: string; start: string; end: string | null; kind: 'window' | 'job' | 'reset';
  approx: boolean; link: AgendaLink | null; note?: string; since?: boolean;
}
interface PeriodicJob {
  id: string; source: Source | 'panel'; kind: 'periodic'; title: string; everySec: number | null; next: string | null;
  note?: string; link: AgendaLink | null; atBoot?: boolean; dead?: boolean;
}
interface SourceState { id: Source | 'panel'; label: string; count: number; error: string | null; warning?: string | null }
interface AgendaResp {
  tz: string; processTz: string; tzMismatch: boolean; now: string; from: string; to: string;
  items: AgendaItem[]; periodic: PeriodicJob[]; sources: SourceState[]; truncated: boolean;
}
const EMPTY: AgendaResp = {
  tz: '', processTz: '', tzMismatch: false, now: '', from: '', to: '', items: [], periodic: [], sources: [], truncated: false,
};

const RANGES = [{ days: 7, label: '7 gün' }, { days: 14, label: '14 gün' }, { days: 31, label: '31 gün' }];
// Kaynağın kısa etiketi (renk: AgendaPanel.css --agenda-<kaynak>)
const TAG: Record<Source | 'panel', string> = {
  parental: 'Ebeveyn', traffic: 'Trafik', cron: 'Cron', system: 'Sistem', vault: 'Bulut yedeği', speedtest: 'Hız testi',
  quota: 'Kota', zapret: 'Zapret', panel: 'Panel',
};
// Alt sekmeyi açan tek seferlik anahtarlar (BandwidthPanel / SystemLogs açılışta okuyup siler)
const SUB_KEYS: Partial<Record<TabId, string>> = { bandwidth: BANDWIDTH_TAB_KEY, maintenance: MAINTENANCE_TAB_KEY };

// Pi'nin saat dilimiyle biçimleyiciler; dilim tarayıcıda tanınmazsa tarayıcının saati
function formatters(tz: string) {
  const mk = (o: Intl.DateTimeFormatOptions) => {
    try { return new Intl.DateTimeFormat('tr-TR', tz ? { ...o, timeZone: tz } : o); } catch { return new Intl.DateTimeFormat('tr-TR', o); }
  };
  const key = mk({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = mk({ weekday: 'long', day: 'numeric', month: 'long' });
  const time = mk({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayShort = mk({ weekday: 'short', day: 'numeric' });
  const dayTime = mk({ weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return {
    key: (d: Date) => key.format(d), day: (d: Date) => day.format(d), time: (d: Date) => time.format(d),
    dayShort: (d: Date) => dayShort.format(d), dayTime: (d: Date) => dayTime.format(d),
  };
}
const fmtEvery = (sec: number) => {
  if (sec % 86400 === 0) return sec === 86400 ? 'günde bir' : `${sec / 86400} günde bir`;
  if (sec % 3600 === 0) return sec === 3600 ? 'saatte bir' : `${sec / 3600} saatte bir`;
  if (sec % 60 === 0) return `${sec / 60} dakikada bir`;
  return `${sec} saniyede bir`;
};
const statusText = (err: string) => (err === 'HTTP 409' ? 'Bu cihaz uydu — Ağ Ajandası ana cihazdadır.' : `Ajanda alınamadı (${err}).`);

function LinkTo({ link }: { link: AgendaLink | null }) {
  if (!link) return null;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Yeni sekmede açılışta (orta / Ctrl tık) anahtar bu sekmede kalıp sonraki açılışı etkilemesin
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const k = link.sub ? SUB_KEYS[link.tab] : undefined;
    if (k && link.sub) { try { sessionStorage.setItem(k, link.sub); } catch { /* depolama yok: sayfanın varsayılan sekmesi */ } }
  };
  return <a className="ag-link" href={`#${link.tab}`} onClick={onClick} aria-label="İlgili sayfayı aç">Aç <ChevronRight size={13} /></a>;
}

export function AgendaPanel() {
  const [days, setDays] = useState(7);
  const [only, setOnly] = useState<Source | ''>('');
  const [busy, setBusy] = useState(false);
  const { data, loading, error, refetch } = useApi<AgendaResp>(`/agenda?days=${days}`, EMPTY, 60000);
  // Aralık değişirken (useApi veriyi boşaltır) yeni yanıt gelene dek önceki yanıt soluk gösterilir (önceki render'ın
  // verisi durumda tutulur — React'in "önceki değeri saklama" kalıbı)
  const [last, setLast] = useState<AgendaResp>(EMPTY);
  if (data.now && data !== last) setLast(data);
  const stale = !data.now && loading && !!last.now;
  const view = stale ? last : data;
  const f = useMemo(() => formatters(view.tz), [view.tz]);
  // "Şimdi" sunucunun yanıtındaki an (öğe yokken kullanılmaz)
  const now = parseDbTime(view.now)?.getTime() ?? 0;
  const from = parseDbTime(view.from)?.getTime() ?? 0;

  const counts = useMemo(() => {
    const m = new Map<Source, number>();
    for (const it of view.items) m.set(it.source, (m.get(it.source) || 0) + 1);
    return m;
  }, [view.items]);
  const groups = useMemo(() => {
    const todayKey = f.key(new Date(now));
    const tomorrowKey = f.key(new Date(now + 86400000));
    const out: { key: string; label: string; rows: AgendaItem[] }[] = [];
    for (const it of view.items) {
      if (only && it.source !== only) continue;
      const s = parseDbTime(it.start);
      if (!s) continue;
      const anchor = new Date(Math.max(s.getTime(), from));
      const k = f.key(anchor);
      const last = out[out.length - 1];
      if (last && last.key === k) { last.rows.push(it); continue; }
      const base = f.day(anchor);
      out.push({ key: k, label: k === todayKey ? `Bugün · ${base}` : k === tomorrowKey ? `Yarın · ${base}` : base, rows: [it] });
    }
    return out;
  }, [view.items, only, f, now, from]);

  const failed = view.sources.filter(s => s.error);
  const warned = view.sources.filter(s => !s.error && s.warning);
  const scheduled = view.periodic.filter(p => p.source !== 'panel');
  const internal = view.periodic.filter(p => p.source === 'panel');
  const unknown = scheduled.some(p => p.everySec === null && !p.atBoot);
  // Süzgeç çipleri: öğesi olan kaynaklar + seçili kaynak (sayısı 0'a düşse de görünür kalır, kaldırılabilir)
  const chips = view.sources.filter(s => s.id !== 'panel' && (counts.get(s.id as Source) || only === s.id));

  // Zaman hücresi: [başlangıç, bitiş parçası] — dar sütunda bitiş alt satıra geçebilir
  const timeCell = (it: AgendaItem): [string, string?] => {
    const s = parseDbTime(it.start);
    const e = parseDbTime(it.end);
    if (!s) return ['—'];
    if (it.kind !== 'window') return [`${it.approx ? '~' : ''}${f.time(s)}`];
    if (!e) return it.since ? ['Sürekli'] : [f.time(s), '–…'];
    const startTxt = it.since || s.getTime() < from ? '…' : f.time(s);
    // Gece yarısında biten pencere o günün 24:00'ı; başlangıç da 00:00 ise bütün gün
    const endMid = f.time(e) === '00:00';
    const endDay = endMid ? new Date(e.getTime() - 60000) : e;
    const endTime = endMid ? '24:00' : f.time(e);
    const anchorKey = f.key(new Date(Math.max(s.getTime(), from)));
    const sameDay = f.key(endDay) === anchorKey;
    if (sameDay && startTxt === '00:00' && endMid) return ['Tüm gün'];
    return [startTxt, `–${sameDay ? endTime : `${f.dayShort(endDay)} ${endTime}`}`];
  };
  const refresh = async () => {
    setBusy(true);
    try { await refetch(); } finally { setBusy(false); }
  };

  return (
    <Panel title="Ağ Ajandası" icon={<CalendarDays size={20} style={{ marginRight: 8 }} />} className="ag-panel"
      subtitle="Pi'de zamanlanmış işler ve saat pencereleri — salt okunur; değiştirmek için ilgili sayfayı açın"
      actions={
        <button className="btn-outline btn-sm" onClick={() => void refresh()} disabled={loading || busy} aria-label="Yenile">
          {loading || busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Yenile
        </button>
      }>
      <div className="ag-toolbar">
        <div className="ag-seg" role="group" aria-label="Aralık">
          {RANGES.map(r => (
            <button key={r.days} className={`ag-seg-btn${days === r.days ? ' is-on' : ''}`} aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}>{r.label}</button>
          ))}
        </div>
        {view.tz && <span className="ag-tz"><Info size={13} /> Saatler Pi'nin saat dilimine göre: <b>{view.tz}</b></span>}
      </div>

      {error && <div className="ag-alert is-error"><AlertTriangle size={14} /><span>{statusText(error)}</span></div>}
      {view.tzMismatch && (
        <div className="ag-alert is-warn">
          <AlertTriangle size={14} />
          <span>Pi'nin saat dilimi <b>{view.tz}</b>, ama panel hâlâ <b>{view.processTz}</b> ile çalışıyor: ebeveyn, trafik ve kota
            pencereleri, bulut yedeği, hız testi ve Zapret denetimi eski dilime göre uygulanıyor; cron görevleri ise yeni dilime göre
            çalışıyor (aşağıdaki saatler buna göre). Panel yeniden başlayınca (Pi'yi yeniden başlatın) düzelir.</span>
        </div>
      )}
      {failed.map(s => (
        <div key={s.id} className="ag-alert is-error"><AlertTriangle size={14} /><span>{s.label} okunamadı: {s.error}</span></div>
      ))}
      {warned.map(s => (
        <div key={s.id} className="ag-alert is-warn"><AlertTriangle size={14} /><span><b>{s.label}:</b> {s.warning}</span></div>
      ))}

      {chips.length > 0 && (
        <div className="ag-chips" role="group" aria-label="Kaynak süzgeci">
          {chips.map(s => {
            const id = s.id as Source;
            return (
              <button key={id} data-src={id} className={`ag-chip${only === id ? ' is-on' : ''}`} aria-pressed={only === id}
                onClick={() => setOnly(only === id ? '' : id)}>
                {s.label} <b>{counts.get(id) || 0}</b>
              </button>
            );
          })}
        </div>
      )}

      {loading && !view.now && (
        <p className="ag-empty ag-loading"><Loader2 size={14} className="spin" /> Ajanda yükleniyor…</p>
      )}
      {!error && !loading && !groups.length && (
        <p className="ag-empty">
          {only ? <>
            Bu kaynakta seçili aralıkta zamanlanmış iş yok.{' '}
            <button className="ag-clear" onClick={() => setOnly('')}><X size={12} /> Süzgeci kaldır</button>
          </> : 'Seçili aralıkta zamanlanmış iş ya da saat penceresi yok. Ebeveyn Kontrol ve Trafik Kontrol → Zamanlayıcı pencereleri, Sistem & Log → Cron görevleri ve bulut yedeği burada görünür.'}
        </p>
      )}

      <div className={`ag-list${stale ? ' is-stale' : ''}`} aria-busy={stale || undefined}>
        {groups.map(g => (
          <section key={g.key} className="ag-day" aria-label={g.label}>
            <h4 className="ag-day-head">{g.label}</h4>
            {g.rows.map(it => {
              const s = parseDbTime(it.start)?.getTime() ?? 0;
              const e = parseDbTime(it.end)?.getTime() ?? null;
              const open = it.kind === 'window' && e === null;   // bitmeyen pencere
              const past = !open && (e ?? s) < now;
              const live = it.kind === 'window' && s <= now && (open || (e !== null && now < e));
              const [t1, t2] = timeCell(it);
              return (
                <div key={it.id} className={`ag-row${past ? ' is-past' : ''}${live ? ' is-live' : ''}`} data-src={it.source}>
                  <span className="ag-time"><span>{t1}</span>{t2 && <span>{t2}</span>}</span>
                  <span className="ag-title">
                    {it.title}
                    {live && <span className="ag-badge is-now">şu an</span>}
                    {it.approx && <span className="ag-badge" title="Saat kesin değil (aralıkla çalışan iş, yaz saati geçişi ya da yeniden başlatma kaydırabilir)">yaklaşık</span>}
                  </span>
                  <span className="ag-tag" data-src={it.source}>{TAG[it.source]}</span>
                  {it.note && <span className="ag-note">{it.note}</span>}
                  <span className="ag-go"><LinkTo link={it.link} /></span>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {view.truncated && <p className="ag-empty">Liste uzun olduğu için kısaltıldı — daha kısa bir aralık seçin.</p>}

      {(scheduled.length > 0 || internal.length > 0) && (
        <details className="ag-periodic" open={unknown || undefined}>
          <summary>
            <ChevronRight size={14} className="ag-caret" /><Repeat size={14} /> Periyodik işler <span className="ag-count">{scheduled.length + internal.length}</span>
          </summary>
          <p className="ag-note-block">
            Sık tekrar eden ya da saate bağlı olmayan işler listede gösterilmez. Panelin kendi denetimleri panel açıldıktan sonra
            sayılır (her yeniden başlatmada sıfırlanır).
          </p>
          <div className="ag-plist">
            {[...scheduled, ...internal].map(p => {
              const next = parseDbTime(p.next);
              return (
                <div key={p.id} className={`ag-prow${p.everySec === null && !p.atBoot ? ' is-unknown' : ''}`} data-src={p.source}>
                  <span className="ag-ptitle">{p.title}</span>
                  <span className="ag-tag" data-src={p.source}>{TAG[p.source]}</span>
                  <span className="ag-every">
                    {p.atBoot ? 'Pi açılınca' : p.dead ? 'çalışmaz' : p.everySec === null ? 'zaman hesaplanamadı' : fmtEvery(p.everySec)}
                    {next && <> · sıradaki {f.dayTime(next)}</>}
                  </span>
                  {p.note && !p.atBoot && <span className="ag-note">{p.note}</span>}
                  <span className="ag-go"><LinkTo link={p.link} /></span>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </Panel>
  );
}

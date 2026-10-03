import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { CalendarCheck, Plus, Trash2, Pencil, Loader2, AlertTriangle, Info, Eye, Check, X, Square, Hash, Gauge, ShieldOff, ShieldCheck, Users, Smartphone, BellRing } from 'lucide-react';
import { useApi, getApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Select, SelectOption } from './ui';
import { parseDbTime } from '../time';
import { toast } from '../toast';
import type { Device } from '../types';
import './CalendarRules.css';

// Takvim kuralları (Ağ Ajandası sayfası; backend calendarEngine.ts, /api/calendar/{engine,profiles,bindings,local-events,
// decisions,preview}): takvimdeki TAM #etiket, kullanıcının bağladığı profile göre ebeveyn kuralını geçici askıya alır,
// "Yalnız takvimle çalışır" işaretli kuralı açar ya da seçilen cihazların hızını kısar. Dış takvimin her etkinliği önce onay
// ister (otomatik mod yok); paneldeki yerel etkinlik onaylı sayılır. Her etkinleşmenin bitişi kesin (en çok 14 gün).
// Takvim cihazın hız sınırını ve kotasını kaldıramaz. Düğmeler: açan / onaylayan yeşil, kapatan / reddeden kırmızı.
// G5.6 Tatil alarm kipi: "Yeni cihaz alarmı" eylemi pencere boyunca yeni cihaz bildirimini uyarı yapar (sessiz saatleri yok
// sayma ve varlık grubu isteğe bağlı, varsayılan kapalı); Bildirimler'deki "Yeni cihaz bildirimi" kapalıysa çalışmaz.
interface Settings { enabled: boolean; stale_hours: number; default_lead_min: number; max_days: number }
interface EntryRow {
  key: string; title: string; tags: string[]; source_name: string; local: boolean; start: string; end: string; clipped: boolean;
  tag: string; profile_id: number; profile: string; priority: number; reason?: string;
}
interface EngineResp {
  settings: Settings; allowed: boolean; running: boolean; clock_synced: boolean | null; stale_sources: string[]; error: string | null;
  active: EntryRow[]; upcoming: EntryRow[]; blocked: EntryRow[]; pending: number; conflicts: string[]; warnings: string[];
}
interface CapsAction { devices: string[]; groups: number[]; down_kbps: number; up_kbps: number; exempt: string[] }
interface NewDeviceAlarm { ignore_quiet: boolean; presence_group: number | null; presence_min: number }
interface Actions { suspend: number[]; activate: number[]; caps: CapsAction | null; newDevice?: NewDeviceAlarm | null }
interface Profile { id: number; name: string; actions: Actions; problems: string[] }
interface Binding { id: number; tag: string; profile_id: number; priority: number; sources: string[] | null; enabled: boolean }
interface LocalEv { id: number; title: string; tag: string; start: string; duration_min: number; weekly: boolean; until: string | null; next_start: string | null; next_end: string | null }
interface PendingRow { key: string; title: string; tags: string[]; source_name: string; start: string; end: string; clipped: boolean; profiles: { tag: string; priority: number; profile_id: number }[] }
interface RecentRow { key: string; title: string; tags: string[]; source_name: string; start: string; end: string; status: string }
interface PRule { id: number; name: string; enabled: boolean; blockAll: boolean; calendarOnly?: boolean }
interface Group { id: number; name: string; members?: { device_mac: string }[] }
interface Preview {
  rules: { suspend: { id: number; name: string; problem: string | null }[]; activate: { id: number; name: string; problem: string | null }[] };
  devices: { mac: string; name: string; effects: string[] }[];
  caps: { down_kbps: number; up_kbps: number; devices: number; protected_skipped: number; exempt: number } | null;
  conflicts: string[]; warnings: string[];
  alarm?: { ignore_quiet: boolean; presence_group: number | null; presence_group_name: string; presence_min: number; device_watch: boolean };
}

const ENGINE0: EngineResp = { settings: { enabled: false, stale_hours: 6, default_lead_min: 15, max_days: 14 }, allowed: true, running: false, clock_synced: null,
  stale_sources: [], error: null, active: [], upcoming: [], blocked: [], pending: 0, conflicts: [], warnings: [] };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mbps = (k: number) => (k ? `${(k / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 3 })} Mbps` : 'sınırsız');
const toKbps = (s: string) => { const n = Number(String(s).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0; };
const STATUS_TEXT: Record<string, string> = { approved: 'onaylandı', declined: 'reddedildi', ended: 'erken bitirildi' };
const WEEKLY_MAX_MIN = 6 * 1440;   // haftalık tekrarda en uzun süre (backend ile aynı: her hafta en az bir gün boşluk)
const durText = (m: number) => (m < 60 ? `${m} dk` : `${(m / 60).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sa`);
const PRESENCE_LIMIT = "Telefonlar uykuda Wi-Fi'ı bırakır ve gizli adres kullanır — yanlış alarm ya da kaçırma olabilir.";

function useFmt(tz?: string) {
  return useMemo(() => {
    const mk = (o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat('tr-TR', tz ? { ...o, timeZone: tz } : o); } catch { return new Intl.DateTimeFormat('tr-TR', o); } };
    const dt = mk({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const t = mk({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const day = mk({ year: 'numeric', month: '2-digit', day: '2-digit' });
    const at = (s: string | null) => { const d = parseDbTime(s); return d ? dt.format(d) : '—'; };
    const range = (a: string, b: string) => {
      const x = parseDbTime(a), y = parseDbTime(b);
      if (!x || !y) return '—';
      return day.format(x) === day.format(y) ? `${dt.format(x)}–${t.format(y)}` : `${dt.format(x)} – ${dt.format(y)}`;
    };
    return { at, range };
  }, [tz]);
}

function actionsText(a: Actions, rules: PRule[], groups: Group[]): string[] {
  const rn = (id: number) => rules.find(r => r.id === id)?.name || `Kural #${id}`;
  const out: string[] = [];
  if (a.activate.length) out.push(`Aç: ${a.activate.map(rn).join(', ')}`);
  if (a.suspend.length) out.push(`Askıya al: ${a.suspend.map(rn).join(', ')}`);
  if (a.caps) {
    const t = [...a.caps.groups.map(g => groups.find(x => x.id === g)?.name || `grup #${g}`), ...(a.caps.devices.length ? [`${a.caps.devices.length} cihaz`] : [])].join(', ');
    out.push(`Hız ↓${mbps(a.caps.down_kbps)} ↑${mbps(a.caps.up_kbps)}: ${t}${a.caps.exempt.length ? ` (${a.caps.exempt.length} muaf)` : ''}`);
  }
  const n = a.newDevice;
  if (n) {
    const g = n.presence_group ? groups.find(x => x.id === n.presence_group)?.name || `grup #${n.presence_group}` : '';
    out.push(`Yeni cihaz alarmı${n.ignore_quiet ? ' (sessiz saatlerde de)' : ''}${g ? ` · ${g} ${n.presence_min} dk görülmezse` : ''}`);
  }
  return out;
}

// Yan etkisiz önizleme: etkilenen cihazlar, askıya alınan / açılan kurallar, çakışmalar
// dwNote: "Yeni cihaz bildirimi kapalı" uyarısı (profil düzenleyici kendi bağlantılı uyarısını gösterir)
function PreviewBox({ query, dwNote = true }: { query: string; dwNote?: boolean }) {
  // Yanıt sorgusuyla birlikte tutulur: sorgu değişince eski önizleme gösterilmez (yeni yanıt gelene dek "hazırlanıyor")
  const [res, setRes] = useState<{ q: string; p?: Preview; err?: string } | null>(null);
  useEffect(() => {
    let on = true;
    const t = setTimeout(() => {
      getApi<Preview>(`/calendar/preview?${query}`).then(r => { if (on) setRes({ q: query, p: r }); }).catch(e => { if (on) setRes({ q: query, err: errText(e) }); });
    }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [query]);
  const p = res?.q === query ? res.p ?? null : null;
  const err = res?.q === query ? res.err ?? '' : '';
  if (err) return <div className="cr-note is-bad"><AlertTriangle size={14} /><span>Önizleme alınamadı: {err}</span></div>;
  if (!p) return <p className="cr-muted"><Loader2 size={12} className="spin" /> Önizleme hazırlanıyor…</p>;
  return (
    <div className="cr-preview" aria-label="Önizleme">
      <b>Önizleme</b>
      {p.rules.activate.map(r => <div key={`a${r.id}`} className="cr-pv-row"><ShieldCheck size={13} /> Açılır: «{r.name}»{r.problem ? <em> — {r.problem}</em> : null}</div>)}
      {p.rules.suspend.map(r => <div key={`s${r.id}`} className="cr-pv-row"><ShieldOff size={13} /> Askıya alınır: «{r.name}»{r.problem ? <em> — {r.problem}</em> : null}</div>)}
      {p.caps && <div className="cr-pv-row"><Gauge size={13} /> Hız ↓{mbps(p.caps.down_kbps)} ↑{mbps(p.caps.up_kbps)}: {p.caps.devices} cihaz{p.caps.exempt ? `, ${p.caps.exempt} muaf` : ''}{p.caps.protected_skipped ? `, ${p.caps.protected_skipped} korunan (modem / Pi) dışarıda` : ''}</div>}
      {p.alarm && (
        <div className="cr-pv-row"><BellRing size={13} /><span>Bu süre boyunca yeni cihazlar uyarı olarak bildirilir{p.alarm.ignore_quiet ? ' (dış kanalın sessiz saatlerinde de)' : ''}
          {p.alarm.presence_group ? ` — yalnız «${p.alarm.presence_group_name || `grup #${p.alarm.presence_group}`}» cihazlarından hiçbiri son ${p.alarm.presence_min} dk'da ağda görülmediyse` : ''}</span></div>
      )}
      {p.alarm && !p.alarm.device_watch && dwNote && <div className="cr-note is-warn"><AlertTriangle size={13} /><span>Yeni cihaz bildirimi kapalı — alarm çalışmaz (Bildirimler → Dış kanallar).</span></div>}
      {p.alarm && !p.caps && !p.rules.suspend.length && !p.rules.activate.length ? null : p.devices.length > 0 ? (
        <ul className="cr-pv-devs">
          {p.devices.slice(0, 12).map(d => <li key={d.mac}><b>{d.name || d.mac}</b> — {d.effects.join(', ')}</li>)}
          {p.devices.length > 12 && <li>ve {p.devices.length - 12} cihaz daha</li>}
        </ul>
      ) : <p className="cr-muted">Etkilenen cihaz yok.</p>}
      {p.conflicts.map((c, i) => <div key={`c${i}`} className="cr-note is-warn"><AlertTriangle size={13} /><span>Çakışma: {c}</span></div>)}
      {p.warnings.map((w, i) => <div key={`w${i}`} className="cr-note is-warn"><AlertTriangle size={13} /><span>{w}</span></div>)}
    </div>
  );
}

export function CalendarRules({ tz }: { tz?: string }) {
  const f = useFmt(tz);
  const { data: eng, error: engErr, refetch: refEng } = useApi<EngineResp>('/calendar/engine', ENGINE0, 20000);
  const { data: dec, refetch: refDec } = useApi<{ pending: PendingRow[]; recent: RecentRow[] }>('/calendar/decisions', { pending: [], recent: [] }, 30000);
  const { data: prof, refetch: refProf } = useApi<{ profiles: Profile[] }>('/calendar/profiles', { profiles: [] });
  const { data: bind, refetch: refBind } = useApi<{ bindings: Binding[] }>('/calendar/bindings', { bindings: [] });
  const { data: loc, refetch: refLoc } = useApi<{ events: LocalEv[] }>('/calendar/local-events', { events: [] });
  const { data: pr } = useApi<{ rules: PRule[] }>('/parental/rules', { rules: [] });
  const { data: dv } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const { data: gr, loading: grLoading, error: grErr } = useApi<{ groups: Group[] }>('/devices/groups', { groups: [] });
  const { data: tg } = useApi<{ tags: { tag: string; count: number }[] }>('/calendar/tags', { tags: [] }, 120000);
  const { data: src } = useApi<{ sources: { id: string; name: string }[] }>('/calendar/sources', { sources: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);   // önizlemesi açık bekleyen
  const [editP, setEditP] = useState<ProfileDraft | null>(null);
  const [editB, setEditB] = useState<{ id: number | null; tag: string; profile_id: number; priority: number; sources: string[] | null; enabled: boolean } | null>(null);
  const [editL, setEditL] = useState<{ id: number | null; title: string; tag: string; date: string; time: string; dur: string; weekly: boolean; until: string } | null>(null);
  const rules = pr.rules || [];
  const groups = gr.groups || [];
  const groupsReady = !grLoading && !grErr;   // grup listesi yüklendi (listede olmayan grup gerçekten silinmiş)
  const devices = dv.devices || [];
  const profiles = prof.profiles || [];
  const bindings = bind.bindings || [];
  const on = eng.settings.enabled;
  // Panel etkinliğini tetikleyebilen bağlamalar: açık ve kaynağı "tüm takvimler" ya da Panel
  const localB = bindings.filter(x => x.enabled && (x.sources === null || x.sources.includes('local')));
  const localTags = [...new Set(localB.map(x => x.tag))];
  const all = async () => { await Promise.all([refEng(), refDec(), refProf(), refBind(), refLoc()]); };

  if (engErr === 'HTTP 409') return null;   // uydu: ajanda zaten uyarır

  // Başarıda true: formlar yalnız o zaman kapanır (sunucu reddederse yazılanlar kalır)
  const run = async (id: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setBusy(id);
    let done = false;
    try { await fn(); done = true; if (ok) toast.success(ok); await all(); } catch (e) { toast.error(errText(e)); } finally { setBusy(null); }
    return done;
  };
  const setEngine = (enabled: boolean) => {
    if (!enabled && !window.confirm('Takvim etkileri durdurulsun mu?\n\nAskıya alınan kurallar geri gelir, takvim kuralları kapanır, hız kısıtları kalkar (en çok birkaç saniye). Profiller ve bağlamalar silinmez.')) return;
    void run('engine', () => putApi('/calendar/engine', { enabled }), enabled ? 'Takvim kuralları açıldı' : 'Takvim etkileri durduruldu');
  };
  // Reddet / erken bitir / bu sefer atla geri alınamaz: onay sorulur
  const decide = (key: string, action: 'approve' | 'decline' | 'end', ask?: string) => {
    if (ask && !window.confirm(ask)) return;
    void run(`d:${key}`, () => postApi(`/calendar/decisions/${key}`, { action }), action === 'approve' ? 'Onaylandı' : action === 'decline' ? 'Reddedildi' : 'Erken bitirildi');
  };

  const pname = (id: number) => profiles.find(p => p.id === id)?.name || `Profil #${id}`;
  const blocks: { row: EntryRow; kind: 'active' | 'upcoming' | 'blocked' }[] = [
    ...eng.active.map(row => ({ row, kind: 'active' as const })), ...eng.blocked.map(row => ({ row, kind: 'blocked' as const })),
    ...eng.upcoming.map(row => ({ row, kind: 'upcoming' as const })),
  ];

  return (
    <Panel title="Takvim kuralları" icon={<CalendarCheck size={20} style={{ marginRight: 8 }} />} className="cr-panel"
      subtitle="Takvimdeki #etiketi bir profile bağlayın: etkinlik süresince ebeveyn kuralını askıya alır, takvim kuralını açar, seçtiğiniz cihazların hızını kısar ya da (ör. #Tatil) ağa ilk kez bağlanan cihazı uyarı olarak bildirir. Dış takvimin her etkinliği önce onayınızı ister."
      actions={on ? (
        <button className="btn-outline btn-sm cr-off" onClick={() => setEngine(false)} disabled={!!busy}><Square size={13} /> Takvim etkilerini durdur</button>
      ) : (
        <button className="btn-primary btn-sm cr-on" onClick={() => setEngine(true)} disabled={!!busy || !eng.allowed}><Check size={13} /> Takvim kurallarını aç</button>
      )}>
      {engErr && <div className="cr-note is-bad"><AlertTriangle size={14} /><span>Takvim kuralları alınamadı ({engErr}).</span></div>}
      {!on && (
        <div className="cr-note is-info"><Info size={14} /><span>Kapalı: hiçbir takvim etkinliği kural uygulamaz, ebeveyn ve hız kuralları eskisi gibi çalışır. Profilleri
          ve bağlamaları açmadan önce hazırlayabilirsiniz.</span></div>
      )}
      {on && eng.clock_synced === false && <div className="cr-note is-warn"><AlertTriangle size={14} /><span>Pi'nin saati internetle eşitlenmedi: yeni etkinleşme başlamaz (başlamış olanlar bitişine dek sürer).</span></div>}
      {on && eng.stale_sources.length > 0 && <div className="cr-note is-warn"><AlertTriangle size={14} /><span>{eng.stale_sources.join(', ')} en az {eng.settings.stale_hours} saattir eşitlenemiyor: bu takvimden yeni etkinleşme başlamaz.</span></div>}
      {on && eng.error && <div className="cr-note is-bad"><AlertTriangle size={14} /><span>Uygulanamadı: {eng.error}</span></div>}
      {eng.conflicts.map((c, i) => <div key={`c${i}`} className="cr-note is-warn"><AlertTriangle size={14} /><span>Çakışma: {c}</span></div>)}
      {eng.warnings.map((w, i) => <div key={`w${i}`} className="cr-note is-warn"><AlertTriangle size={14} /><span>{w}</span></div>)}

      {on && (
        <section className="cr-sec" aria-label="Etkin ve yakında">
          <h4>Şu an ve önümüzdeki 7 gün</h4>
          {!blocks.length && !dec.pending.length && <p className="cr-muted">Etkin ya da onaylı takvim kuralı yok.</p>}
          <div className="cr-blocks">
            {dec.pending.map(p => (
              <div key={p.key} className="cr-block is-pending">
                <div className="cr-block-head">
                  <span className="cr-time">{f.range(p.start, p.end)}</span>
                  <span className="cr-badge is-pending">Onay bekliyor</span>
                </div>
                <div className="cr-block-title">{p.title || 'Başlıksız etkinlik'} {p.tags.map(t => <span key={t} className="cr-tag">#{t}</span>)}</div>
                <div className="cr-muted">{p.source_name} · {p.profiles.map(x => `#${x.tag} → ${pname(x.profile_id)}`).join(', ')}{p.clipped ? ` · en çok ${eng.settings.max_days} gün uygulanır` : ''}</div>
                <div className="cr-actions">
                  <button className="btn-outline btn-sm" onClick={() => setOpen(open === p.key ? null : p.key)}><Eye size={13} /> Önizle</button>
                  <button className="btn-primary btn-sm cr-on" disabled={!!busy} onClick={() => decide(p.key, 'approve')}>{busy === `d:${p.key}` ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Onayla</button>
                  <button className="btn-outline btn-sm cr-off" disabled={!!busy} onClick={() => decide(p.key, 'decline', `«${p.title || 'Başlıksız etkinlik'}» reddedilsin mi?

Bu etkinlikte takvim kuralı uygulanmaz ve karar geri alınamaz (etkinliğin saati ya da etiketi değişirse yeniden onay istenir).`)}><X size={13} /> Reddet</button>
                </div>
                {open === p.key && p.profiles.map(x => (
                  <PreviewBox key={x.profile_id} query={`profile=${x.profile_id}&priority=${x.priority}&start=${encodeURIComponent(p.start)}&end=${encodeURIComponent(p.end)}`} />
                ))}
              </div>
            ))}
            {blocks.map(({ row, kind }) => (
              <div key={`${kind}${row.key}${row.profile_id}`} className={`cr-block is-${kind}`}>
                <div className="cr-block-head">
                  <span className="cr-time">{f.range(row.start, row.end)}</span>
                  <span className={`cr-badge is-${kind}`}>{kind === 'active' ? 'Etkin' : kind === 'blocked' ? 'Başlatılamadı' : 'Onaylı'}</span>
                </div>
                <div className="cr-block-title">{row.title || 'Başlıksız etkinlik'} <span className="cr-tag">#{row.tag}</span> → {row.profile}</div>
                <div className="cr-muted">{row.source_name}{row.clipped ? ` · en çok ${eng.settings.max_days} gün` : ''}{row.reason ? ` · ${row.reason}` : ''}</div>
                {kind !== 'blocked' && (
                  <div className="cr-actions">
                    <button className="btn-outline btn-sm cr-off" disabled={!!busy} onClick={() => decide(row.key, 'end', kind === 'active'
                      ? `«${row.title || 'Başlıksız etkinlik'}» erken bitirilsin mi?

Takvim etkileri hemen kalkar; bu etkinlik için yeniden başlamaz.`
                      : `«${row.title || 'Başlıksız etkinlik'}» bu sefer atlansın mı?

Bu oluşumda takvim kuralı uygulanmaz.`)}><Square size={13} /> {kind === 'active' ? 'Erken bitir' : 'Bu sefer atla'}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {dec.recent.length > 0 && (
            <details className="cr-recent">
              <summary>Son kararlar ({dec.recent.length})</summary>
              <ul>{dec.recent.map(r => <li key={r.key}>{f.range(r.start, r.end)} · {r.title || 'Başlıksız'} {r.tags.map(t => `#${t}`).join(' ')} — {STATUS_TEXT[r.status] || r.status}</li>)}</ul>
            </details>
          )}
        </section>
      )}

      <ProfilesSection profiles={profiles} rules={rules} groups={groups} groupsReady={groupsReady} devices={devices} busy={busy} edit={editP} setEdit={setEditP}
        onSave={(p) => run('p', () => (p.id ? putApi(`/calendar/profiles/${p.id}`, { name: p.name, actions: p.actions as unknown as Record<string, unknown> }) : postApi('/calendar/profiles', { name: p.name, actions: p.actions as unknown as Record<string, unknown> })), 'Profil kaydedildi').then(saved => { if (saved) setEditP(null); })}
        onDelete={(p) => { if (window.confirm(`«${p.name}» profili silinsin mi?`)) void run(`pd:${p.id}`, () => deleteApi(`/calendar/profiles/${p.id}`), 'Profil silindi'); }} />

      <section className="cr-sec" aria-label="Etiket bağlamaları">
        <div className="cr-sec-head">
          <h4><Hash size={14} /> Etiket → profil</h4>
          {!editB && <button className="btn-primary btn-sm cr-on" disabled={!profiles.length} onClick={() => setEditB({ id: null, tag: '', profile_id: profiles[0]?.id ?? 0, priority: 0, sources: null, enabled: true })}><Plus size={13} /> Bağla</button>}
        </div>
        <p className="cr-muted">Yalnız tam etiket eşleşir (büyük / küçük harf fark etmez, "#Sınav" ile "#Sinav" ayrıdır). Çakışmada önceliği yüksek olan, eşitlikte kısıtlayıcı olan geçerli.{!profiles.length ? ' Önce bir profil ekleyin.' : ''}</p>
        {bindings.map(b => (
          <div key={b.id} className={`cr-item${b.enabled ? '' : ' is-off'}`}>
            <span className="cr-tag">#{b.tag}</span> → <b>{pname(b.profile_id)}</b>
            <span className="cr-muted"> · öncelik {b.priority} · {b.sources ? b.sources.map(s => (s === 'local' ? 'Panel' : src.sources.find(x => x.id === s)?.name || s)).join(', ') : 'tüm takvimler + panel'}{b.enabled ? '' : ' · kapalı'}</span>
            <span className="cr-item-actions">
              <button className="icon-btn icon-btn-sm" aria-label="Düzenle" onClick={() => setEditB({ ...b })}><Pencil size={13} /></button>
              <button className="icon-btn icon-btn-sm cr-danger" aria-label="Sil" disabled={!!busy} onClick={() => { if (window.confirm(`#${b.tag} bağlaması silinsin mi?`)) void run(`bd:${b.id}`, () => deleteApi(`/calendar/bindings/${b.id}`), 'Bağlama silindi'); }}><Trash2 size={13} /></button>
            </span>
          </div>
        ))}
        {editB && (
          <form className="cr-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void run('b', () => (editB.id ? putApi(`/calendar/bindings/${editB.id}`, { ...editB }) : postApi('/calendar/bindings', { ...editB })), 'Bağlama kaydedildi').then(saved => { if (saved) setEditB(null); }); }}>
            <div className="cr-grid">
              <label>Etiket
                <input className="config-input" list="cr-tags" value={editB.tag} placeholder="#Sınav" maxLength={65} onChange={e => setEditB({ ...editB, tag: e.target.value })} />
                <datalist id="cr-tags">{tg.tags.map(t => <option key={t.tag} value={`#${t.tag}`}>{t.count} etkinlik</option>)}</datalist>
              </label>
              <label>Profil
                <Select className="config-input" value={String(editB.profile_id)} onChange={e => setEditB({ ...editB, profile_id: Number(e.target.value) })} columns={['text']}>
                  {profiles.map(p => <SelectOption key={p.id} value={String(p.id)} cols={[p.name]} />)}
                </Select>
              </label>
              <label>Öncelik (0–100, yüksek kazanır)
                <input className="config-input" type="number" min={0} max={100} value={editB.priority} onChange={e => setEditB({ ...editB, priority: Number(e.target.value) })} />
              </label>
            </div>
            <div className="cr-checks" role="group" aria-label="Kaynak">
              <label><input type="checkbox" checked={editB.sources === null} onChange={e => setEditB({ ...editB, sources: e.target.checked ? null : ['local'] })} /> Tüm takvimler ve panel</label>
              {editB.sources !== null && [{ id: 'local', name: 'Panel (yerel etkinlik)' }, ...src.sources].map(s => (
                <label key={s.id}><input type="checkbox" checked={editB.sources!.includes(s.id)}
                  onChange={e => setEditB({ ...editB, sources: e.target.checked ? [...editB.sources!, s.id] : editB.sources!.filter(x => x !== s.id) })} /> {s.name}</label>
              ))}
              <label><input type="checkbox" checked={editB.enabled} onChange={e => setEditB({ ...editB, enabled: e.target.checked })} /> Bağlama açık</label>
            </div>
            <div className="cr-actions">
              <button type="button" className="btn-outline btn-sm" onClick={() => setEditB(null)}>Vazgeç</button>
              <button type="submit" className="btn-primary btn-sm cr-on" disabled={!!busy || !editB.tag.trim() || (editB.sources !== null && !editB.sources.length)}>Kaydet</button>
            </div>
          </form>
        )}
      </section>

      <section className="cr-sec" aria-label="Yerel etkinlikler">
        <div className="cr-sec-head">
          <h4><CalendarCheck size={14} /> Panelde etkinlik</h4>
          {!editL && <button className="btn-primary btn-sm cr-on" disabled={!localTags.length} onClick={() => {
            const d = new Date(Date.now() + 3600_000);
            const pad = (n: number) => String(n).padStart(2, '0');
            setEditL({ id: null, title: '', tag: localTags[0] ?? '', date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:00`, dur: '60', weekly: false, until: '' });
          }}><Plus size={13} /> Etkinlik ekle</button>}
        </div>
        <p className="cr-muted">Panelde oluşturulan etkinlik onaylı sayılır. Saat bu tarayıcının saatiyle girilir.{!localTags.length ? ' Önce bir etiket bağlayın (açık, kaynağı "Tüm takvimler ve panel" ya da Panel).' : ''}</p>
        {(loc.events || []).map(ev => (
          <div key={ev.id} className="cr-item">
            <b>{ev.title}</b> <span className="cr-tag">#{ev.tag}</span>
            <span className="cr-muted"> · {ev.weekly ? 'her hafta' : 'tek sefer'} · {durText(ev.duration_min)} · {ev.next_start ? `sıradaki ${f.range(ev.next_start, ev.next_end || ev.next_start)}` : 'geçti'}</span>
            <span className="cr-item-actions">
              <button className="icon-btn icon-btn-sm cr-danger" aria-label="Sil" disabled={!!busy} onClick={() => { if (window.confirm(`«${ev.title}» silinsin mi? Sürüyorsa hemen biter.`)) void run(`ld:${ev.id}`, () => deleteApi(`/calendar/local-events/${ev.id}`), 'Etkinlik silindi'); }}><Trash2 size={13} /></button>
            </span>
          </div>
        ))}
        {editL && (() => {
          const start = new Date(`${editL.date}T${editL.time || '00:00'}`);
          const dur = Math.round(Number(editL.dur));
          const maxDur = editL.weekly ? Math.min(WEEKLY_MAX_MIN, eng.settings.max_days * 1440) : eng.settings.max_days * 1440;
          const ok = editL.title.trim() && localTags.includes(editL.tag) && Number.isFinite(start.getTime()) && dur >= 1 && dur <= maxDur;
          // Önizleme: bu etiketin panel etkinliğine açık her bağlaması (etiket birden çok profile bağlı olabilir)
          const bs = localB.filter(x => x.tag === editL.tag);
          return (
            <form className="cr-form" onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const until = editL.weekly && editL.until ? new Date(`${editL.until}T23:59:59`).toISOString() : null;
              void run('l', () => postApi('/calendar/local-events', { title: editL.title.trim(), tag: editL.tag, start: start.toISOString(), duration_min: dur, weekly: editL.weekly, until }), 'Etkinlik eklendi').then(saved => { if (saved) setEditL(null); });
            }}>
              <div className="cr-grid">
                <label>Başlık<input className="config-input" value={editL.title} maxLength={80} placeholder="ör. Matematik sınavı" onChange={e => setEditL({ ...editL, title: e.target.value })} /></label>
                <label>Etiket
                  <Select className="config-input" value={editL.tag} onChange={e => setEditL({ ...editL, tag: e.target.value })} columns={['text']}>
                    {localTags.map(t => <SelectOption key={t} value={t} cols={[`#${t}`]} />)}
                  </Select>
                </label>
                <label>Tarih<input className="config-input" type="date" value={editL.date} onChange={e => setEditL({ ...editL, date: e.target.value })} /></label>
                <label>Saat<input className="config-input" type="time" value={editL.time} onChange={e => setEditL({ ...editL, time: e.target.value })} /></label>
                <label>Süre (dakika)<input className="config-input" type="number" min={1} max={maxDur} value={editL.dur} onChange={e => setEditL({ ...editL, dur: e.target.value })} /></label>
              </div>
              <div className="cr-checks">
                <label><input type="checkbox" checked={editL.weekly} onChange={e => setEditL({ ...editL, weekly: e.target.checked })} /> Her hafta tekrarla</label>
                {editL.weekly && <label>son gün <input className="config-input cr-date" type="date" value={editL.until} onChange={e => setEditL({ ...editL, until: e.target.value })} /></label>}
              </div>
              {editL.weekly && dur > WEEKLY_MAX_MIN && <div className="cr-note is-warn"><AlertTriangle size={13} /><span>Haftalık tekrarda süre en çok 6 gün ({WEEKLY_MAX_MIN} dakika): her hafta en az bir gün boşluk kalır.</span></div>}
              {bs.map(b => <PreviewBox key={b.id} query={`profile=${b.profile_id}&priority=${b.priority}${Number.isFinite(start.getTime()) && dur > 0 ? `&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(new Date(start.getTime() + dur * 60000).toISOString())}` : ''}`} />)}
              <div className="cr-actions">
                <button type="button" className="btn-outline btn-sm" onClick={() => setEditL(null)}>Vazgeç</button>
                <button type="submit" className="btn-primary btn-sm cr-on" disabled={!!busy || !ok}>Kaydet</button>
              </div>
            </form>
          );
        })()}
      </section>
    </Panel>
  );
}

type ProfileDraft = { id: number | null; name: string; actions: Actions };
function ProfilesSection({ profiles, rules, groups, groupsReady, devices, busy, edit, setEdit, onSave, onDelete }: {
  profiles: Profile[]; rules: PRule[]; groups: Group[]; groupsReady: boolean; devices: Device[]; busy: string | null;
  edit: ProfileDraft | null; setEdit: (e: ProfileDraft | null) => void; onSave: (p: ProfileDraft) => Promise<void>; onDelete: (p: Profile) => void;
}) {
  return (
    <section className="cr-sec" aria-label="Profiller">
      <div className="cr-sec-head">
        <h4><ShieldCheck size={14} /> Profiller</h4>
        {!edit && <button className="btn-primary btn-sm cr-on" onClick={() => setEdit({ id: null, name: '', actions: { suspend: [], activate: [], caps: null } })}><Plus size={13} /> Profil ekle</button>}
      </div>
      <p className="cr-muted">Profil, etiketli etkinlik süresince ne olacağını söyler. Takvim cihazın kendi hız sınırını ve kotasını kaldıramaz; yalnız ek kısıt getirir.</p>
      {profiles.map(p => (
        <div key={p.id} className="cr-item">
          <b>{p.name}</b>
          <span className="cr-muted"> · {actionsText(p.actions, rules, groups).join(' · ') || 'eylem yok'}</span>
          <span className="cr-item-actions">
            <button className="icon-btn icon-btn-sm" aria-label="Düzenle" onClick={() => setEdit({ id: p.id, name: p.name, actions: p.actions })}><Pencil size={13} /></button>
            <button className="icon-btn icon-btn-sm cr-danger" aria-label="Sil" disabled={!!busy} onClick={() => onDelete(p)}><Trash2 size={13} /></button>
          </span>
          {p.problems.map((x, i) => <div key={i} className="cr-note is-warn"><AlertTriangle size={13} /><span>{x}</span></div>)}
        </div>
      ))}
      {edit && <ProfileEditor key={edit.id ?? 'yeni'} initial={edit} rules={rules} groups={groups} groupsReady={groupsReady} devices={devices} busy={busy} onCancel={() => setEdit(null)} onSave={onSave} />}
    </section>
  );
}

function ProfileEditor({ initial, rules, groups, groupsReady, devices, busy, onCancel, onSave }: {
  initial: ProfileDraft; rules: PRule[]; groups: Group[]; groupsReady: boolean; devices: Device[]; busy: string | null; onCancel: () => void; onSave: (p: ProfileDraft) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [a, setAct] = useState<Actions>(initial.actions);
  const [down, setDown] = useState(initial.actions.caps?.down_kbps ? String(initial.actions.caps.down_kbps / 1000).replace('.', ',') : '');
  const [up, setUp] = useState(initial.actions.caps?.up_kbps ? String(initial.actions.caps.up_kbps / 1000).replace('.', ',') : '');
  const [pmin, setPmin] = useState(String(initial.actions.newDevice?.presence_min ?? 15));
  // "Yeni cihaz bildirimi" (Bildirimler → Dış kanallar) açık mı: kapalıyken alarm çalışmaz (alarm onu kendiliğinden açmaz)
  const { data: nt } = useApi<{ deviceWatch?: { enabled: boolean } }>('/notify', {});
  const calRules = rules.filter(r => r.calendarOnly);
  const normal = rules.filter(r => !r.calendarOnly);
  const caps = a.caps;
  const nd = a.newDevice ?? null;
  const setNd = (p: Partial<NewDeviceAlarm>) => { if (nd) setA({ newDevice: { ...nd, ...p } }); };
  const setA = (p: Partial<Actions>) => setAct(prev => ({ ...prev, ...p }));
  const setCaps = (p: Partial<CapsAction>) => { if (caps) setA({ caps: { ...caps, ...p } }); };
  const toggleId = (list: number[], id: number) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const devName = (m: string) => { const d = devices.find(x => x.mac_address.toLowerCase() === m); return d?.hostname || d?.ip_address || m; };
  const pm = Math.round(Number(pmin));
  const pmOk = Number.isInteger(pm) && pm >= 5 && pm <= 240;
  // Varlık grubu listede yok: liste yüklendiyse grup silinmiş (sunucu böyle kaydı reddeder), yüklenmediyse yalnız numarasıyla
  const pg = nd?.presence_group ?? null;
  const pgListed = !pg || groups.some(g => g.id === pg);
  const pgGone = !pgListed && groupsReady;
  const out: Actions = { ...a, caps: caps ? { ...caps, down_kbps: toKbps(down), up_kbps: toKbps(up) } : null,
    newDevice: nd ? { ...nd, presence_min: nd.presence_group ? pm : 15 } : null };
  const valid = !!name.trim() && (out.suspend.length > 0 || out.activate.length > 0 || !!out.caps || !!out.newDevice)
    && (!out.caps || ((out.caps.groups.length > 0 || out.caps.devices.length > 0) && (out.caps.down_kbps > 0 || out.caps.up_kbps > 0)))
    && (!pg || pmOk) && !pgGone;
  // Kaydedilmemiş değişiklik var mı: Bildirimler bağlantısı sekmeyi değiştirince düzenleyici kapanır (varsa önce sorulur)
  const snap = (n: string, x: Actions) => JSON.stringify([n.trim(), x.suspend, x.activate, x.caps, x.newDevice ?? null]);
  const dirty = snap(name, out) !== snap(initial.name, initial.actions);
  return (
    <form className="cr-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void onSave({ id: initial.id, name: name.trim(), actions: out }); }}>
      <label className="cr-wide">Profil adı<input className="config-input" value={name} maxLength={40} placeholder="ör. Sınav" onChange={e => setName(e.target.value)} /></label>
      <fieldset className="cr-fs">
        <legend><ShieldCheck size={13} /> Takvim kuralını aç</legend>
        {calRules.length ? calRules.map(r => (
          <label key={r.id}><input type="checkbox" checked={a.activate.includes(r.id)} onChange={() => setA({ activate: toggleId(a.activate, r.id), suspend: a.suspend.filter(x => x !== r.id) })} /> {r.name || `Kural #${r.id}`}{r.blockAll ? ' (tüm internet)' : ''}</label>
        )) : <p className="cr-muted">"Yalnız takvimle çalışır" işaretli ebeveyn kuralı yok — Ebeveyn Kontrol'de kural eklerken seçin.</p>}
      </fieldset>
      <fieldset className="cr-fs">
        <legend><ShieldOff size={13} /> Ebeveyn kuralını askıya al</legend>
        {normal.length ? normal.map(r => (
          <label key={r.id}><input type="checkbox" checked={a.suspend.includes(r.id)} onChange={() => setA({ suspend: toggleId(a.suspend, r.id) })} /> {r.name || `Kural #${r.id}`}{r.enabled ? '' : ' (kapalı)'}</label>
        )) : <p className="cr-muted">Ebeveyn kuralı yok.</p>}
      </fieldset>
      <fieldset className="cr-fs">
        <legend><Gauge size={13} /> Hız kısıtı</legend>
        <label><input type="checkbox" checked={!!caps} onChange={e => setA({ caps: e.target.checked ? { devices: [], groups: [], down_kbps: 0, up_kbps: 0, exempt: [] } : null })} /> Seçilen grupların / cihazların hızını kıs</label>
        {caps && (
          <>
            <div className="cr-chips">
              {caps.groups.map(g => <span key={`g${g}`} className="cr-chip"><Users size={12} /> {groups.find(x => x.id === g)?.name || `grup #${g}`}<button type="button" aria-label="Çıkar" onClick={() => setCaps({ groups: caps.groups.filter(x => x !== g) })}><X size={12} /></button></span>)}
              {caps.devices.map(m => <span key={m} className="cr-chip"><Smartphone size={12} /> {devName(m)}<button type="button" aria-label="Çıkar" onClick={() => setCaps({ devices: caps.devices.filter(x => x !== m) })}><X size={12} /></button></span>)}
            </div>
            <Select className="config-input" value="" columns={['text', 'muted']} onChange={e => {
              const v = e.target.value;
              if (v.startsWith('g:')) { const g = Number(v.slice(2)); if (!caps.groups.includes(g)) setCaps({ groups: [...caps.groups, g] }); }
              else if (v && !caps.devices.includes(v)) setCaps({ devices: [...caps.devices, v] });
            }}>
              <option value="">+ Grup ya da cihaz ekle…</option>
              {groups.length > 0 && <optgroup label="Gruplar">{groups.filter(g => !caps.groups.includes(g.id)).map(g => <SelectOption key={g.id} value={`g:${g.id}`} cols={[g.name, `${g.members?.length ?? 0} cihaz`]} />)}</optgroup>}
              <optgroup label="Cihazlar">{devices.filter(d => !caps.devices.includes(d.mac_address.toLowerCase())).map(d => <SelectOption key={d.mac_address} value={d.mac_address.toLowerCase()} cols={[d.hostname || 'Adsız cihaz', d.ip_address || d.mac_address]} />)}</optgroup>
            </Select>
            <div className="cr-grid">
              <label>İndirme (Mbps, boş = sınırsız)<input className="config-input" inputMode="decimal" value={down} placeholder="ör. 5" onChange={e => setDown(e.target.value)} /></label>
              <label>Yükleme (Mbps, boş = sınırsız)<input className="config-input" inputMode="decimal" value={up} placeholder="ör. 1" onChange={e => setUp(e.target.value)} /></label>
            </div>
            <div className="cr-label">Muaf (kısılmaz — ör. toplantı yapılan bilgisayar)</div>
            <div className="cr-chips">
              {caps.exempt.map(m => <span key={m} className="cr-chip is-exempt">{devName(m)}<button type="button" aria-label="Çıkar" onClick={() => setCaps({ exempt: caps.exempt.filter(x => x !== m) })}><X size={12} /></button></span>)}
            </div>
            <Select className="config-input" value="" columns={['text', 'muted']} onChange={e => { const v = e.target.value; if (v && !caps.exempt.includes(v)) setCaps({ exempt: [...caps.exempt, v] }); }}>
              <option value="">+ Muaf cihaz ekle…</option>
              {devices.filter(d => !caps.exempt.includes(d.mac_address.toLowerCase())).map(d => <SelectOption key={d.mac_address} value={d.mac_address.toLowerCase()} cols={[d.hostname || 'Adsız cihaz', d.ip_address || d.mac_address]} />)}
            </Select>
          </>
        )}
      </fieldset>
      <fieldset className="cr-fs">
        <legend><BellRing size={13} /> Yeni cihaz alarmı</legend>
        <label><input type="checkbox" checked={!!nd} onChange={e => setA({ newDevice: e.target.checked ? { ignore_quiet: false, presence_group: null, presence_min: 15 } : null })} /> Bu süre boyunca ağa ilk kez bağlanan cihazı uyarı olarak bildir (ör. tatildeyken)</label>
        {nd && (
          <>
            <label><input type="checkbox" checked={nd.ignore_quiet} onChange={e => setNd({ ignore_quiet: e.target.checked })} /> Sessiz saatleri yok say (dış kanalın sessiz saatlerinde de hemen gönderilir)</label>
            <div className="cr-grid cr-grid-end">
              <label>Yalnız evde kimse yokken — ev sakinlerinin cihaz grubu (isteğe bağlı)
                <Select className="config-input" value={pg ? String(pg) : ''} columns={['text', 'muted']}
                  onChange={e => setNd({ presence_group: e.target.value ? Number(e.target.value) : null })}>
                  <SelectOption value="" cols={['Koşul yok — her yeni cihazda', '']} />
                  {groups.map(g => <SelectOption key={g.id} value={String(g.id)} cols={[g.name, `${g.members?.length ?? 0} cihaz`]} />)}
                  {!pgListed && <SelectOption value={String(pg)} cols={[`grup #${pg}${pgGone ? ' (silinmiş)' : ''}`, '']} />}
                </Select>
              </label>
              {!!pg && (
                <label>Son kaç dakikada görülmediyse (5–240)
                  <input className="config-input" type="number" min={5} max={240} value={pmin} onChange={e => setPmin(e.target.value)} />
                </label>
              )}
            </div>
            {!!pg && !pmOk && <div className="cr-note is-warn"><AlertTriangle size={13} /><span>5–240 dakika arasında bir süre girin.</span></div>}
            {pgGone ? (
              <div className="cr-note is-warn"><AlertTriangle size={13} /><span>Varlık grubu #{pg} silinmiş — başka bir grup ya da «Koşul yok» seçin (böyle kaydedilemez).</span></div>
            ) : !!pg && (
              <div className="cr-note is-warn"><AlertTriangle size={13} /><span>Alarm yalnız bu gruptaki cihazlardan hiçbiri son {pmOk ? pm : 'N'} dakikada ağda görülmediyse verilir; görülen varsa yeni cihaz bilgi olarak yazılır. {PRESENCE_LIMIT}</span></div>
            )}
            {nt.deviceWatch && !nt.deviceWatch.enabled && (
              <div className="cr-note is-warn"><AlertTriangle size={13} /><span>Yeni cihaz bildirimi kapalı — alarm çalışmaz. <a href="#alerts" onClick={e => {
                if (dirty && !window.confirm("Bildirimler sayfasına geçilsin mi?\n\nKaydedilmemiş profil değişiklikleri kaybolur. Önce Kaydet'e basabilirsiniz: alarm saklanır, yeni cihaz bildirimi açılınca çalışır.")) e.preventDefault();
              }}>Bildirimler</a> sayfasında "Dış kanallar" → "Yeni cihaz bildirimi"nden açın.</span></div>
            )}
          </>
        )}
      </fieldset>
      {valid && <PreviewBox dwNote={false} query={`actions=${encodeURIComponent(JSON.stringify(out))}${initial.id ? `&self=${initial.id}` : ''}`} />}
      <div className="cr-actions">
        <button type="button" className="btn-outline btn-sm" onClick={onCancel}>Vazgeç</button>
        <button type="submit" className="btn-primary btn-sm cr-on" disabled={!!busy || !valid}>Kaydet</button>
      </div>
    </form>
  );
}

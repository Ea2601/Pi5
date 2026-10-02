import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CalendarSync, Plus, RefreshCw, Trash2, Loader2, AlertTriangle, Eye, EyeOff, Hash, KeyRound, Pencil, ChevronRight, CircleHelp } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Select } from './ui';
import { parseDbTime } from '../time';
import { relativeTime } from '../alerts';
import { toast } from '../toast';
import './CalendarSources.css';

// Takvim bağlantıları (Ağ Ajandası sayfası; backend calendarSync.ts, /api/calendar/*): Google / Outlook / iCloud takviminin
// ICS adresi salt okunur bağlanır, etkinlikler ajandada görünür. Adres gizli bir anahtardır: Pi'de yalnız root'un okuyabildiği
// dosyada durur, burada yalnız maskeli (alan adı + son 4 karakter) görünür ve yedeğe girmez. Hiçbir kural değişmez.
// hiddenCount / hidden: tarihleri hesaplanamayan seriler (ufukta oluşumu yok) — ajandada görünmez, yalnız uyarıda adıyla geçer
interface SourceStats {
  events: number | null; unresolvedCount: number; hiddenCount: number; unresolved: { summary: string; reason: string; detail: string; hidden: boolean }[];
  capped: number; truncated: boolean; badLines: number;
}
interface CalSource {
  id: string; name: string; color: string; enabled: boolean; interval_min: number; url: string | null; needs_url: boolean;
  last_attempt: string | null; last_ok: string | null; last_error: string | null; event_count: number; next_sync: string | null;
  syncing: boolean; stats: SourceStats;
}
interface SourcesResp { sources: CalSource[]; max: number; interval: { min: number; max: number } }
interface TagRow { tag: string; count: number; next: string | null; sources: string[] }
const EMPTY: SourcesResp = { sources: [], max: 5, interval: { min: 15, max: 360 } };

const COLORS = [
  { v: '#14b8a6', n: 'Turkuaz' }, { v: '#6366f1', n: 'Çivit' }, { v: '#f59e0b', n: 'Kehribar' },
  { v: '#ec4899', n: 'Pembe' }, { v: '#22c55e', n: 'Yeşil' }, { v: '#0ea5e9', n: 'Mavi' },
];
const INTERVALS = [15, 30, 60, 180, 360];
const everyText = (m: number) => (m % 60 === 0 ? (m === 60 ? 'Saatte bir' : `${m / 60} saatte bir`) : `${m} dakikada bir`);
const URL_OK = /^(https|webcals?):\/\/\S+$/i;
const REASON: Record<string, string> = {
  tz: 'saat dilimi tanınmadı', rrule: 'tekrarlama kuralı desteklenmiyor', limit: 'tekrarlama çok uzun', time: 'bitiş, süre ya da istisna tarihi okunamadı',
};
// Saatler ajandadaki gibi Pi'nin diliminde (tz: /api/agenda yanıtı); dilim tarayıcıda tanınmazsa ya da henüz yoksa tarayıcının
function tzFormat(tz: string | undefined, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try { return new Intl.DateTimeFormat('tr-TR', tz ? { ...o, timeZone: tz } : o); } catch { return new Intl.DateTimeFormat('tr-TR', o); }
}
function useTimeFormats(tz: string | undefined) {
  return useMemo(() => {
    const clock = tzFormat(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const dayTime = tzFormat(tz, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return {
      clock: (s: string | null) => { const d = parseDbTime(s); return d ? clock.format(d) : null; },
      dayTime: (s: string | null) => { const d = parseDbTime(s); return d ? dayTime.format(d) : null; },
      // 6 saatten yakını göreli ("5 dk önce": dilimden bağımsız), uzağı Pi'nin diliminde tarih + saat
      ago: (s: string | null) => {
        const d = parseDbTime(s);
        if (!d) return null;
        return Date.now() - d.getTime() < 6 * 3600_000 ? relativeTime(d) : dayTime.format(d);
      },
    };
  }, [tz]);
}

interface Form { id: string | null; name: string; url: string; color: string; interval: number; mask: string | null }
const NEW_FORM: Form = { id: null, name: '', url: '', color: COLORS[0].v, interval: 15, mask: null };

// Takvimde görülen etiketler (öneri listesi — hiçbir kurala bağlı değil)
function CalendarTags({ tz }: { tz?: string }) {
  const { data, error } = useApi<{ tags: TagRow[] }>('/calendar/tags', { tags: [] }, 60000);
  const f = useTimeFormats(tz);
  return (
    <section className="cal-tags" aria-label="Takvimde görülen etiketler">
      <h4><Hash size={14} /> Takvimde görülen etiketler</h4>
      <p className="cal-hint">
        Etkinlik başlığındaki tam <b>#etiket</b> sözcükleri ve takvimdeki kategori adları (açıklama metni okunmaz; büyük / küçük harf
        fark etmez, ama "#Sınav" ile "#Sinav" ayrıdır). Bunlar sonraki bir sürümde kurallara bağlanabilecek — şimdilik yalnız
        görünür, hiçbir ayarı değiştirmez.
      </p>
      {error ? <p className="cal-empty">Etiketler alınamadı ({error}).</p>
        : data.tags.length ? (
          <div className="cal-chips">
            {data.tags.map(t => (
              <span key={t.tag} className="cal-chip" title={`${t.sources.join(', ')}${t.next ? ` · sıradaki: ${f.dayTime(t.next)}` : ''}`}>
                #{t.tag} <b>{t.count}</b>
              </span>
            ))}
          </div>
        ) : <p className="cal-empty">Önümüzdeki 62 günde etiketli etkinlik yok. Başlığa #Sınav, #Tatil gibi bir etiket ya da takvimde kategori ekleyebilirsiniz.</p>}
    </section>
  );
}

// tz: ajandanın gösterdiği dilim (Pi'nin) — aynı sayfadaki saatler tek dilimde
export function CalendarSources({ onChanged, tz }: { onChanged?: () => void; tz?: string }) {
  const { data, error, loading, refetch } = useApi<SourcesResp>('/calendar/sources', EMPTY, 30000);
  const f = useTimeFormats(tz);
  // İlk yanıt gelene dek boş durum ve "Takvim ekle" gösterilmez (kayıtlı takvimler varken "henüz yok" yanıltır)
  const ready = !loading || !!error;
  const [form, setForm] = useState<Form | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tagsKey, setTagsKey] = useState(0);
  const urlRef = useRef<HTMLInputElement>(null);
  const sources = data.sources;
  const syncing = sources.some(s => s.syncing);

  // Eşitleme sürerken sık yenile; biten eşitlemeden sonra ajanda ve etiketler yenilensin
  const prevSync = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(sources.filter(s => s.syncing).map(s => s.id));
    const finished = [...prevSync.current].some(id => !now.has(id));
    prevSync.current = now;
    if (finished) { onChanged?.(); setTagsKey(k => k + 1); }
  }, [sources, onChanged]);
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => { void refetch(); }, 2000);
    return () => clearInterval(t);
  }, [syncing, refetch]);

  if (error === 'HTTP 409') return null;   // uydu: ajanda zaten uyarır
  const changed = async () => { await refetch(); onChanged?.(); setTagsKey(k => k + 1); };

  const openAdd = () => { setForm({ ...NEW_FORM, color: COLORS[sources.length % COLORS.length].v }); setShow(false); };
  const openEdit = (s: CalSource) => {
    setForm({ id: s.id, name: s.name, url: '', color: s.color, interval: s.interval_min, mask: s.url });
    setShow(false);
    if (s.needs_url) setTimeout(() => urlRef.current?.focus(), 50);
  };
  const editing = form?.id ? sources.find(s => s.id === form.id) : undefined;
  const urlRequired = !form?.id || !!editing?.needs_url;
  const urlBad = !!form && form.url.trim() !== '' && !URL_OK.test(form.url.trim());
  const nameOk = !!form && form.name.trim().length > 0 && [...form.name.trim()].length <= 40;
  const canSave = !!form && nameOk && !urlBad && (!urlRequired || form.url.trim() !== '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || !canSave) return;
    setBusy('save');
    try {
      const body: Record<string, unknown> = { name: form.name.trim(), color: form.color, interval_min: form.interval };
      if (form.url.trim()) body.url = form.url.trim();
      if (form.id) {
        // Adres yeniden girildiyse (yedekten gelen kapalı takvim) açılır
        if (editing?.needs_url && form.url.trim()) body.enabled = true;
        // Eşitleme yalnız açık takvimde ve adres gerçekten değiştiyse başlar (sunucu söyler)
        const r = await putApi(`/calendar/sources/${form.id}`, body) as { syncing?: boolean };
        const off = !!editing && !editing.enabled && body.enabled !== true;
        toast.success(r.syncing ? `«${form.name.trim()}» kaydedildi — eşitleniyor`
          : off && form.url.trim() ? `«${form.name.trim()}» kaydedildi — takvim kapalı, açınca eşitlenir` : `«${form.name.trim()}» kaydedildi`);
      } else {
        await postApi('/calendar/sources', body);
        toast.success(`«${form.name.trim()}» eklendi — ilk eşitleme başladı`);
      }
      setForm(null);
      await changed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const syncNow = async (s: CalSource) => {
    setBusy(`sync:${s.id}`);
    try {
      const r = await postApi(`/calendar/sources/${s.id}/sync`, {}) as { status: string; events?: number; error?: string };
      if (r.status === 'ok') toast.success(`«${s.name}» eşitlendi: ${r.events ?? 0} etkinlik`);
      else if (r.status === 'unchanged') toast.success(`«${s.name}» değişmemiş (${r.events ?? 0} etkinlik)`);
      else if (r.status === 'waiting') toast.info(r.error || 'Saat eşitlenmeyi bekliyor');
      else toast.error(r.error || 'Eşitlenemedi');
      await changed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (s: CalSource, on: boolean) => {
    setBusy(`toggle:${s.id}`);
    try {
      await putApi(`/calendar/sources/${s.id}`, { enabled: on });
      toast.success(on ? `«${s.name}» açıldı — eşitleniyor` : `«${s.name}» kapatıldı — etkinlikleri ajandada gösterilmez`);
      await changed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: CalSource) => {
    if (!window.confirm(`«${s.name}» takvim bağlantısı silinsin mi?\n\nEtkinlikleri ajandadan kalkar, gizli adres Pi'den silinir. Takvimin kendisi (Google / Outlook / iCloud) değişmez.`)) return;
    setBusy(`del:${s.id}`);
    try {
      await deleteApi(`/calendar/sources/${s.id}`);
      if (form?.id === s.id) setForm(null);
      toast.success(`«${s.name}» silindi`);
      await changed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const intervals = form && !INTERVALS.includes(form.interval) ? [...INTERVALS, form.interval].sort((a, b) => a - b) : INTERVALS;
  const full = sources.length >= data.max;

  return (
    <Panel title="Takvim bağlantıları" icon={<CalendarSync size={20} style={{ marginRight: 8 }} />} className="cal-panel"
      subtitle="Google, Outlook ya da iCloud takviminizi salt okunur bağlayın: etkinlikler yukarıdaki ajandada görünür. Takvim hiçbir ayarı, kuralı ya da bağlantıyı değiştirmez."
      actions={ready && !form && !full ? (
        <button className="btn-primary btn-sm cal-on" onClick={openAdd} disabled={!!busy}><Plus size={13} /> Takvim ekle</button>
      ) : undefined}>
      <div id="cal-sources" />
      {error && <div className="cal-note is-bad"><AlertTriangle size={14} /><span>Takvimler alınamadı ({error}).</span></div>}
      {!ready && <p className="cal-empty cal-loading"><Loader2 size={13} className="spin" /> Takvim bağlantıları yükleniyor…</p>}
      {ready && !error && !sources.length && !form && (
        <p className="cal-empty">
          Henüz takvim bağlı değil. Okul, iş ya da aile takviminizi ekleyince etkinlikler ajandada gün gün görünür; Pi takvimi
          {` ${everyText(15).toLocaleLowerCase('tr-TR')}`} denetler (sağlayıcının kendi yayın gecikmesi buna eklenir).
        </p>
      )}

      {sources.length > 0 && (
        <div className="cal-list">
          {sources.map(s => {
            const state = s.needs_url ? { cls: 'is-warn', t: 'Adres gerekli' }
              : !s.enabled ? { cls: 'is-off', t: 'Kapalı' }
                : s.syncing ? { cls: 'is-run', t: 'Eşitleniyor…' }
                  : s.last_error ? { cls: 'is-bad', t: 'Eşitlenemedi' }
                    : s.last_ok ? { cls: 'is-ok', t: 'Eşitlendi' } : { cls: 'is-run', t: 'Bekliyor' };
            const okAgo = f.ago(s.last_ok);
            const next = s.enabled && !s.needs_url ? f.clock(s.next_sync) : null;
            // Çözülemeyenler: ajandada işaretli görünenler ve tarihleri hesaplanamadığı için hiç görünmeyenler (eski kayıtta hiddenCount yok)
            const hiddenN = s.stats.hiddenCount || 0;
            const shownN = s.stats.unresolvedCount - hiddenN;
            const unresWhere = [
              ...(shownN > 0 ? [`${hiddenN ? `${shownN} tanesi ` : ''}ajandada uyarı işaretiyle gösterilir`] : []),
              ...(hiddenN > 0 ? [`${shownN > 0 ? `${hiddenN} tanesinin ` : ''}tarihleri hesaplanamadığı için ajandada görünmez`] : []),
            ].join(', ');
            const b =busy?.endsWith(`:${s.id}`) ? busy.split(':')[0] : null;
            return (
              <div key={s.id} className={`cal-item${s.enabled ? '' : ' is-disabled'}`}>
                <div className="cal-head">
                  <span className="cal-dot" style={{ background: s.color }} aria-hidden="true" />
                  <b className="cal-name">{s.name}</b>
                  <span className={`cal-state ${state.cls}`}>{s.syncing && <Loader2 size={11} className="spin" />}{state.t}</span>
                </div>
                <div className="cal-meta">
                  <span className="cal-url" title="Gizli adres — yalnız alan adı ve son 4 karakter gösterilir"><KeyRound size={12} /> {s.url ?? 'adres yok'}</span>
                  <span>{everyText(s.interval_min)}</span>
                  {okAgo && <span>Son eşitleme {okAgo} · {s.event_count} etkinlik</span>}
                  {next && <span>Sıradaki ~{next}</span>}
                </div>
                {s.needs_url && (
                  <div className="cal-note is-warn"><AlertTriangle size={14} /><span>Bu takvim yedekten geri yüklendi: gizli adres yedeğe girmediği için yeniden girilmeli.</span></div>
                )}
                {!s.needs_url && s.last_error && (
                  <div className="cal-note is-bad"><AlertTriangle size={14} /><span>{s.last_error}{s.last_ok ? ' — son eşitlenen kopya gösteriliyor.' : ''}</span></div>
                )}
                {s.stats.unresolvedCount > 0 && (
                  <details className="cal-note is-warn cal-unres">
                    <summary><AlertTriangle size={14} /><span>{s.stats.unresolvedCount} etkinlik çözülemedi — {unresWhere}; hiçbir şeyi tetiklemez</span><ChevronRight size={13} className="cal-caret" /></summary>
                    <ul>
                      {s.stats.unresolved.map((u, i) => (
                        <li key={i}><b>{u.summary || 'Başlıksız etkinlik'}</b>: {REASON[u.reason] || u.reason}{u.detail ? ` (${u.detail})` : ''}{u.hidden ? ' — ajandada görünmez' : ''}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {(s.stats.truncated || s.stats.capped > 0) && (
                  <div className="cal-note is-warn"><AlertTriangle size={14} /><span>Takvim çok büyük: {s.stats.truncated ? 'zamanca en yakın 5000 etkinlik alındı' : `${s.stats.capped} tekrarlayan etkinlikte en çok 500 oluşum alındı`}.</span></div>
                )}
                <div className="cal-actions">
                  {s.needs_url ? (
                    <button className="btn-primary btn-sm cal-on" onClick={() => openEdit(s)} disabled={!!busy}><KeyRound size={13} /> Adresi gir</button>
                  ) : s.enabled ? (
                    <>
                      <button className="btn-outline btn-sm" onClick={() => { void syncNow(s); }} disabled={!!busy || s.syncing}>
                        {b === 'sync' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Şimdi eşitle
                      </button>
                      <button className="btn-outline btn-sm cal-off" onClick={() => { void toggle(s, false); }} disabled={!!busy}>
                        {b === 'toggle' ? 'Kapatılıyor…' : 'Kapat'}
                      </button>
                    </>
                  ) : (
                    <button className="btn-primary btn-sm cal-on" onClick={() => { void toggle(s, true); }} disabled={!!busy}>{b === 'toggle' ? 'Açılıyor…' : 'Aç'}</button>
                  )}
                  <button className="btn-outline btn-sm" onClick={() => openEdit(s)} disabled={!!busy}><Pencil size={13} /> Düzenle</button>
                  <button className="btn-outline btn-sm cal-off" onClick={() => { void remove(s); }} disabled={!!busy}><Trash2 size={13} /> Sil</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {full && !form && <p className="cal-hint">En çok {data.max} takvim bağlanabilir.</p>}

      {form && (
        <form className="cal-form" onSubmit={e => { void save(e); }} aria-label={form.id ? 'Takvimi düzenle' : 'Takvim ekle'}>
          <h4>{form.id ? `«${editing?.name ?? form.name}» düzenle` : 'Takvim ekle'}</h4>
          <div className="cal-grid">
            <div className="form-group">
              <label htmlFor="cal-name">Ad</label>
              <input id="cal-name" value={form.name} maxLength={40} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="ör. Okul, İş, Aile" autoComplete="off" />
            </div>
            <div className="form-group">
              <label htmlFor="cal-interval">Eşitleme aralığı</label>
              <Select id="cal-interval" value={String(form.interval)} onChange={e => setForm({ ...form, interval: Number(e.target.value) })}>
                {intervals.map(m => <option key={m} value={String(m)}>{everyText(m)}</option>)}
              </Select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="cal-url"><KeyRound size={13} /> ICS adresi (gizli){!urlRequired && ' — değiştirmek istemiyorsanız boş bırakın'}</label>
            <div className="cal-inline">
              <input id="cal-url" ref={urlRef} type={show ? 'text' : 'password'} value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
                placeholder={form.mask ? `${form.mask} (kayıtlı)` : 'https://… ya da webcal://…'} spellCheck={false} aria-invalid={urlBad || undefined}
                name="ics-url" autoComplete="new-password" data-1p-ignore data-lpignore="true" />
              <button type="button" className="btn-outline btn-sm" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? 'Adresi gizle' : 'Adresi göster'}>
                {show ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {urlBad && <p className="cal-hint is-bad">Adres https:// ya da webcal:// ile başlamalı.</p>}
          </div>
          <div className="form-group">
            <span className="cal-label">Renk</span>
            <div className="cal-colors" role="radiogroup" aria-label="Renk">
              {COLORS.map(c => (
                <button key={c.v} type="button" role="radio" aria-checked={form.color === c.v} aria-label={c.n} title={c.n}
                  className={`cal-swatch${form.color === c.v ? ' is-on' : ''}`} style={{ background: c.v }} onClick={() => setForm({ ...form, color: c.v })} />
              ))}
            </div>
          </div>
          <div className="cal-note is-info cal-secret">
            <KeyRound size={14} />
            <span><b>Bu adres gizli bir anahtardır:</b> bilen herkes takviminizi okuyabilir — kimseyle paylaşmayın. Pi'de yalnız yönetici (root)
              okuyabilen bir dosyada saklanır, panelde maskeli görünür, yedek dosyasına ve günlüklere girmez. Sızdığını düşünürseniz
              takvim uygulamasından adresi sıfırlayın.</span>
          </div>
          <details className="cal-help">
            <summary><CircleHelp size={14} /> Adres nereden alınır?<ChevronRight size={13} className="cal-caret" /></summary>
            <dl>
              <dt>Google Takvim</dt>
              <dd>Bilgisayarda calendar.google.com → Ayarlar → soldan takvimi seçin → <b>Takvimi entegre et</b> → <b>iCal biçimindeki gizli adres</b>i kopyalayın.</dd>
              <dt>Outlook / Microsoft 365</dt>
              <dd>outlook.office.com (kişisel hesapta outlook.live.com) → Ayarlar → Takvim → <b>Paylaşılan takvimler</b> → <b>Takvim yayımla</b>: takvimi
                ve «Tüm ayrıntıları görüntüleyebilir»i seçip <b>Yayımla</b> → <b>ICS</b> bağlantısını kopyalayın («Başlıkları ve konumları görüntüleyebilir» de başlıktaki
                #etiketler için yeterli; yalnız meşgul / boş bilgisi yetmez).</dd>
              <dt>iCloud (Apple)</dt>
              <dd>iPhone Takvim → Takvimler → takvimin yanındaki (i) → <b>Herkese Açık Takvim</b>'i açın → Bağlantıyı Paylaş → Kopyala (webcal:// adresi olduğu gibi kabul edilir).</dd>
            </dl>
            <p className="cal-hint">Takvim yalnız okunur; Pi takviminize hiçbir şey yazmaz. Sağlayıcılar yayımlanan takvimi kendi aralıklarıyla günceller — yeni bir etkinlik birkaç saat gecikmeyle görünebilir.</p>
          </details>
          <div className="cal-actions">
            <button type="submit" className="btn-primary btn-sm cal-on" disabled={!canSave || !!busy}>
              {busy === 'save' ? <Loader2 size={13} className="spin" /> : form.id ? null : <Plus size={13} />} {form.id ? 'Kaydet' : 'Ekle'}
            </button>
            <button type="button" className="btn-outline btn-sm" onClick={() => setForm(null)} disabled={busy === 'save'}>Vazgeç</button>
          </div>
        </form>
      )}

      {sources.length > 0 && <CalendarTags key={tagsKey} tz={tz} />}
    </Panel>
  );
}

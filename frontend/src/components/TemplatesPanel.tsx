import { useMemo, useState, type ReactNode } from 'react';
import {
  ShieldCheck, Lock, Users, Smartphone, X, Eye, Check, Undo2, Loader2, AlertTriangle, Info, Search, Globe, Plus, CircleDot, RefreshCw,
} from 'lucide-react';
import { useApi, postApi, putApi } from '../hooks/useApi';
import { Panel, Select, SelectOption } from './ui';
import { parseDbTime, fmtDbTime } from '../time';
import { toast } from '../toast';
import type { Device } from '../types';
import './TemplatesPanel.css';

// Koruma Şablonları (backend templates.ts / safeSearch.ts; /api/templates, /api/safesearch). Şablon yeni bir engelleme motoru
// değil: Ebeveyn Kontrol kuralı, tüm ağda şifreli DNS engeli ve güvenli aramayı birlikte kurar. Sıra: seç → Önizle (yan etkisiz
// değişiklik listesi) → Uygula (yeşil); uygulanmış şablonda Geri al (kırmızı) — yalnız şablonun kurduğu ve o zamandan beri
// değişmemiş olanlar kalkar. Ürün dili "uyuma yardımcı": panel bir mevzuata uyumlu olduğunu söylemez.
type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type Prov = 'google' | 'youtube' | 'bing' | 'duckduckgo';
interface Cat { id: string; label: string; desc: string; timed: boolean }
interface InstRule { id: number; name: string; status: 'ok' | 'changed' | 'missing'; enabled: boolean | null }
// applying: uygulama şu an sürüyor (bozuk değil); state 'applying' ama applying false → panel uygulama sırasında yeniden başladı.
// Ayarların status'u bugünkü değerle karşılaştırmadır (geri almanın yaptığının aynısı): 'changed' → geri al ona dokunmaz.
interface Instance {
  id: number; state: string; appliedAt: string; applying: boolean; rules: InstRule[];
  dnsGuardAll: boolean; dnsGuardAllStatus: 'ok' | 'changed' | null;
  safeSearch: { enabled: boolean; providers: Prov[]; status: 'ok' | 'changed' } | null; broken: string | null;
  params: { target: 'all' | 'devices'; devices: string[]; groups: number[] } | null;
}
interface Tpl { key: string; title: string; desc: string; available: boolean; locked?: string; instance: Instance | null }
interface SsStatus {
  supported: boolean; enabled: boolean; providers: Prov[];
  catalog: { id: Prov; label: string; target: string; names: number }[];
  applied: boolean; pending: boolean; suspended: string | null;
  conflicts: { name: string; provider: Prov; reason: string }[]; skipped: { provider: Prov; reason: string }[];
  ips: Record<string, { a: string[]; aaaa: string[] }>; resolvedAt: number | null; error: string | null;
  dns: { phase: string; error: string };
}
interface Resp { templates: Tpl[]; safeSearch: SsStatus | null; categories: Cat[] }
interface Change { kind: 'add' | 'on' | 'keep' | 'warn' | 'info'; text: string }
interface Group { id: number; name: string; members?: { device_mac: string }[] }
type Use = 'off' | 'always' | 'timed';
interface Form {
  target: 'all' | 'devices'; devices: string[]; groups: number[];
  adult: boolean; gambling: boolean; social: Use; gaming: Use;
  days: Day[]; start: string; end: string; safeSearch: boolean; dnsGuardAll: boolean;
}

const EMPTY: Resp = { templates: [], safeSearch: null, categories: [] };
const DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_SHORT: Record<Day, string> = { mon: 'Pzt', tue: 'Sal', wed: 'Çar', thu: 'Per', fri: 'Cum', sat: 'Cmt', sun: 'Paz' };
const NEW_FORM: Form = {
  target: 'all', devices: [], groups: [], adult: true, gambling: true, social: 'off', gaming: 'off',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '16:00', safeSearch: true, dnsGuardAll: false,
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const deviceLabel = (d?: Device, mac?: string) => d?.hostname || d?.ip_address || mac || '?';
const errText = (e: unknown, d: string) => (e instanceof Error ? e.message : d);

function toParams(f: Form) {
  const always = [f.adult && 'adult', f.gambling && 'gambling', f.social === 'always' && 'social', f.gaming === 'always' && 'gaming'].filter(Boolean) as string[];
  const timed = f.target === 'devices' ? [f.social === 'timed' && 'social', f.gaming === 'timed' && 'gaming'].filter(Boolean) as string[] : [];
  return {
    target: f.target, devices: f.target === 'devices' ? f.devices : [], groups: f.target === 'devices' ? f.groups : [],
    categories: always, timed: timed.length ? { categories: timed, windows: [{ days: f.days, start: f.start, end: f.end }] } : null,
    safeSearch: f.safeSearch, dnsGuardAll: f.dnsGuardAll,
  };
}
function formProblem(f: Form): string {
  const p = toParams(f);
  if (f.target === 'devices' && !f.devices.length && !f.groups.length) return 'Cihaz ya da grup seçin';
  if (p.timed && !f.days.length) return 'Saat aralığı için en az bir gün seçin';
  if (p.timed && (!HHMM.test(f.start) || !HHMM.test(f.end))) return 'Saat SS:DD biçiminde olmalı';
  if (!p.categories.length && !p.timed && !f.safeSearch && !f.dnsGuardAll) return 'En az bir koruma seçin';
  return '';
}

export function TemplatesPanel() {
  const { data, loading, error, refetch } = useApi<Resp>('/templates', EMPTY, 20000);
  const tpl = data.templates.find(t => t.key === 'okul-aile');
  const pos = data.templates.find(t => t.key === 'pos');
  return (
    <div className="fade-in tp">
      <Panel title="Koruma Şablonları" icon={<ShieldCheck size={20} style={{ marginRight: 8 }} />}
        subtitle="Hazır koruma demetleri: önce önizle, sonra uygula — tek tıkla geri al">
        <p className="tp-lead">
          Şablon yeni bir engelleme motoru değildir: Ebeveyn Kontrol kuralını, Pi-hole kayıtlarını ve güvenli aramayı sizin için birlikte
          kurar; hepsi kendi sayfasında da görünür. Bunlar <strong>uyuma yardımcı kontrollerdir</strong> — panel bir mevzuata ya da standarda
          (okul, ödeme güvenliği) «uyumlu» olduğunu söylemez.
        </p>
        {/* "Uyumlu" denmemesinin gerekçesi: panelin bugün karşılamadığı denetimler (kanıtları: scripts/panel-auth.sh, install.sh, index.ts) */}
        <details className="tp-note tp-conf tp-gaps">
          <summary><Info size={14} /><span>Bu panelin karşılamadığı denetimler</span></summary>
          <ul>
            <li>Tek ortak yönetici hesabı (kişi başına hesap ve yetki yok)</li>
            <li>Panel yalnız HTTP (80) üzerinden sunulur — TLS (HTTPS) yok</li>
            <li>İki aşamalı doğrulama (MFA) yok</li>
            <li>Olay geçmişi 30 gün tutulur</li>
            <li>Panel koruması (şifre) kurulumda kapalı gelir — üst banttan açılır</li>
          </ul>
        </details>
        {error && <div className="tp-note is-bad"><AlertTriangle size={14} /><span>Durum alınamadı ({error}).</span></div>}
      </Panel>
      <div className="tp-grid">
        {tpl ? <OkulAileCard tpl={tpl} cats={data.categories} onChange={refetch} />
          : (
            <section className="glass-panel tp-card">
              {loading || !error
                ? <div className="tp-empty"><Loader2 size={16} className="spin" /> Yükleniyor…</div>
                : <div className="tp-empty"><AlertTriangle size={16} /> Şablonlar alınamadı.
                  <button type="button" className="btn-outline btn-sm" onClick={() => { void refetch(); }}><RefreshCw size={13} /> Yeniden dene</button></div>}
            </section>
          )}
        {pos && <LockedCard tpl={pos} />}
      </div>
      {/* key: sunucudaki sağlayıcı seçimi değişince (şablon, başka sekme) kartın yerel seçimi baştan kurulur */}
      {data.safeSearch && <SafeSearchCard key={data.safeSearch.providers.join()} st={data.safeSearch} onChange={refetch} />}
    </div>
  );
}

// ── Okul / Aile ──────────────────────────────────────────────────────────────
function OkulAileCard({ tpl, cats, onChange }: { tpl: Tpl; cats: Cat[]; onChange: () => Promise<void> | void }) {
  const inst = tpl.instance;
  // Bu sekmeden uygulama sürerken form yerinde kalır (20 sn'lik yoklama "uygulanıyor" kaydını getirse de): hata olursa formda görünür
  const [applyingHere, setApplyingHere] = useState(false);
  const busy = applyingHere || !!inst?.applying;
  const showForm = !inst || applyingHere;
  return (
    <section className="glass-panel tp-card" aria-label={tpl.title}>
      <div className="tp-card-head">
        <h4><ShieldCheck size={16} /> {tpl.title}</h4>
        <span className={`tp-state ${busy ? 'is-busy' : inst ? (inst.broken ? 'is-warn' : 'is-on') : 'is-off'}`}>
          {busy ? <><Loader2 size={11} className="spin" /> Uygulanıyor…</> : inst ? (inst.broken ? 'Bozuk' : 'Uygulandı') : 'Uygulanmadı'}</span>
      </div>
      <p className="tp-desc">{tpl.desc}</p>
      {showForm ? <OkulAileForm cats={cats} onChange={onChange} onBusy={setApplyingHere} /> : <AppliedView inst={inst!} onChange={onChange} />}
    </section>
  );
}

function AppliedView({ inst, onChange }: { inst: Instance; onChange: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const at = parseDbTime(inst.appliedAt);
  // Panel uygulama sırasında yeniden başladıysa (kayıt 'applying' kaldı) ayarlar açılamamış olabilir — "değiştirilmiş" denmez
  const crashed = inst.state === 'applying' && !inst.applying;
  const setText = (s: 'ok' | 'changed' | null | undefined, on: string, name: string) => (s === 'changed'
    ? `${name} — ${crashed ? 'açılmamış olabilir' : 'sonradan değiştirilmiş, geri almada korunur'}` : on);
  const undo = async () => {
    if (!window.confirm('Okul / Aile şablonu geri alınsın mı? Şablonun eklediği kurallar silinir, açtığı ayarlar önceki değerine döner. Sonradan değiştirdikleriniz korunur.')) return;
    setBusy(true);
    try {
      const r = await postApi(`/templates/${inst.id}/undo`, {}) as { removed: string[]; kept: string[]; missing: string[]; notes: string[] };
      const parts = [r.removed.length ? `${r.removed.length} kural silindi` : '', ...r.notes].filter(Boolean);
      toast.success(`Şablon geri alındı${parts.length ? `: ${parts.join(', ')}` : ''}`);
      if (r.kept.length) toast.info(`Dokunulmadı: ${r.kept.join('; ')}`);
      await onChange();
    } catch (e) {
      toast.error(errText(e, 'Geri alınamadı'));
    } finally {
      setBusy(false);
    }
  };
  const ST: Record<InstRule['status'], string> = { ok: 'şablondaki gibi', changed: 'sonradan değiştirilmiş — geri almada korunur', missing: 'bulunamadı' };
  return (
    <div className="tp-applied">
      {inst.applying && <div className="tp-note"><Loader2 size={14} className="spin" />
        <span>Şablon uygulanıyor (Pi-hole eşitlemesi birkaç dakika sürebilir). Bitince değişiklikler burada listelenir ve «Geri al» açılır.</span></div>}
      {inst.broken && <div className="tp-note is-warn"><AlertTriangle size={14} /><span>{inst.broken}</span></div>}
      <ul className="tp-list">
        {inst.params && <li><CircleDot size={13} /><span>Hedef: {inst.params.target === 'all' ? 'tüm ağ'
          : [inst.params.groups.length ? `${inst.params.groups.length} grup` : '', inst.params.devices.length ? `${inst.params.devices.length} cihaz` : ''].filter(Boolean).join(', ')}</span></li>}
        {inst.rules.map(r => (
          <li key={r.id} className={r.status !== 'ok' ? 'is-dim' : ''}><Check size={13} />
            <span>Ebeveyn kuralı «{r.name}»{r.enabled === false ? ' (kapalı)' : ''} — {ST[r.status]}</span></li>
        ))}
        {inst.safeSearch && <li className={inst.safeSearch.status === 'changed' ? 'is-dim' : ''}><Check size={13} />
          <span>{setText(inst.safeSearch.status, 'Güvenli arama açıldı', 'Güvenli arama')}</span></li>}
        {inst.dnsGuardAll && <li className={inst.dnsGuardAllStatus === 'changed' ? 'is-dim' : ''}><Check size={13} />
          <span>{setText(inst.dnsGuardAllStatus, 'Tüm ağda şifreli DNS engeli açıldı', 'Tüm ağda şifreli DNS engeli')}</span></li>}
        {inst.state === 'applied' && !inst.rules.length && !inst.safeSearch && !inst.dnsGuardAll
          && <li><Info size={13} /><span>Seçilenler zaten açıktı — şablon bir şey değiştirmedi</span></li>}
      </ul>
      <div className="tp-foot">
        <span className="tp-muted">{at && !inst.applying ? `Uygulandı: ${fmtDbTime(inst.appliedAt)}` : ''}</span>
        <button className="btn-outline btn-sm btn-off" disabled={busy || inst.applying} onClick={undo}
          title={inst.applying ? 'Uygulama bitince geri alınabilir' : undefined}>
          {busy ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />} Geri al
        </button>
      </div>
    </div>
  );
}

// Sıralı adımlar (sihirbaz): yalnız sıradaki adım parlak; biten adım sönük + ✓ (yine düzenlenebilir); kilitli adım soluk ve
// "Önce N. adım" der. 2. ve 3. adımın varsayılanları geçerlidir: hedef seçilince sıra 4. adıma (Önizle / Uygula) gelir.
const STEP_TITLES = ['Kime', 'Ne engellensin', 'Ek korumalar', 'Önizle ve uygula'];
const STEP_NEED = ['cihaz ya da grup seçin', 'saat aralığını tamamlayın', 'en az bir koruma seçin', ''];
type StepState = 'done' | 'active' | 'locked';

function Step({ n, state, lockedBy, children }: { n: number; state: StepState; lockedBy: number; children: ReactNode }) {
  return (
    <section className={`tp-step is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <h5><span className="tp-num">{state === 'done' ? <Check size={12} /> : n}</span> {STEP_TITLES[n - 1]}</h5>
      {state === 'locked'
        ? <span className="tp-lock"><Lock size={12} /> Önce {lockedBy + 1}. adım: {STEP_NEED[lockedBy]}</span>
        : children}
    </section>
  );
}

function OkulAileForm({ cats, onChange, onBusy }: { cats: Cat[]; onChange: () => Promise<void> | void; onBusy: (b: boolean) => void }) {
  const { data: devData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const { data: grpData } = useApi<{ groups: Group[] }>('/devices/groups', { groups: [] });
  const devices = devData.devices || [];
  const groups = grpData.groups || [];
  const [f, setF] = useState<Form>(NEW_FORM);
  const [preview, setPreview] = useState<{ key: string; changes: Change[] } | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'apply'>('');
  const [err, setErr] = useState('');
  const set = (p: Partial<Form>) => { setF(prev => ({ ...prev, ...p })); setErr(''); };
  const params = useMemo(() => toParams(f), [f]);
  const key = JSON.stringify(params);
  const problem = formProblem(f);
  const fresh = !!preview && preview.key === key;
  const label = (id: string) => cats.find(c => c.id === id)?.label || id;

  // Tüm ağda saat aralığı yok: seçili saat aralıklı kategori kapanır (kapsam sessizce "her zaman"a genişlemez)
  const setTarget = (t: Form['target']) => set(t === 'all'
    ? { target: t, social: f.social === 'timed' ? 'off' : f.social, gaming: f.gaming === 'timed' ? 'off' : f.gaming }
    : { target: t });
  const addTarget = (v: string) => {
    if (!v) return;
    if (v.startsWith('g:')) { const g = Number(v.slice(2)); if (!f.groups.includes(g)) set({ groups: [...f.groups, g] }); }
    else if (!f.devices.includes(v)) set({ devices: [...f.devices, v] });
  };
  const doPreview = async () => {
    setBusy('preview'); setErr('');
    try {
      const r = await postApi('/templates/okul-aile/preview', params) as { changes: Change[] };
      setPreview({ key, changes: r.changes });
    } catch (e) { setErr(errText(e, 'Önizlenemedi')); setPreview(null); } finally { setBusy(''); }
  };
  const doApply = async () => {
    setBusy('apply'); setErr(''); onBusy(true);
    try {
      const r = await postApi('/templates/okul-aile/apply', params) as { health?: { error: string | null } };
      toast.success('Okul / Aile şablonu uygulandı');
      if (r.health?.error) toast.info(`Pi-hole: ${r.health.error} — sonraki turda yeniden denenir`);
      setPreview(null);
    } catch (e) { setErr(errText(e, 'Uygulanamadı')); } finally {
      // Önce güncel durum (başarısız uygulamanın kaydı silindi): form, kart özetine geçmeden önce hatayı göstersin
      await onChange();
      setBusy('');
      onBusy(false);
    }
  };

  const useRow = (id: 'social' | 'gaming') => (
    <div className="tp-cat" key={id}>
      <span className="tp-cat-name">{label(id)}</span>
      <div className="tp-seg" role="radiogroup" aria-label={label(id)}>
        {(['off', 'always', 'timed'] as Use[]).map(u => (
          <button key={u} type="button" role="radio" aria-checked={f[id] === u} className={f[id] === u ? 'is-on' : ''}
            disabled={u === 'timed' && f.target === 'all'} title={u === 'timed' && f.target === 'all' ? 'Saat aralığı yalnız seçili cihaz ve gruplarda' : undefined}
            onClick={() => set({ [id]: u } as Partial<Form>)}>
            {u === 'off' ? 'Açık kalsın' : u === 'always' ? 'Her zaman engelle' : 'Saat aralığında'}
          </button>
        ))}
      </div>
    </div>
  );
  const timedOn = f.target === 'devices' && (f.social === 'timed' || f.gaming === 'timed');
  const devOpts = devices.filter(d => !f.devices.includes(d.mac_address.toLowerCase()));
  const grpOpts = groups.filter(g => !f.groups.includes(g.id));

  // Adım durumları: ilk tamamlanmamış adım sıradakidir; ondan sonrakiler kilitli
  const s1 = f.target === 'all' || f.devices.length > 0 || f.groups.length > 0;
  const s2 = s1 && !(timedOn && (!f.days.length || !HHMM.test(f.start) || !HHMM.test(f.end)));
  const s3 = s2 && !problem;
  const firstOpen = [s1, s2, s3].indexOf(false);
  const current = firstOpen === -1 ? 3 : firstOpen;
  const st = (i: number): StepState => (i < current ? 'done' : i === current ? 'active' : 'locked');

  return (
    <div className="tp-form">
      <Step n={1} state={st(0)} lockedBy={current}>
        <div className="tp-seg tp-seg-wide" role="radiogroup" aria-label="Hedef">
          <button type="button" role="radio" aria-checked={f.target === 'all'} className={f.target === 'all' ? 'is-on' : ''} onClick={() => setTarget('all')}>
            <Globe size={13} /> Tüm ağ</button>
          <button type="button" role="radio" aria-checked={f.target === 'devices'} className={f.target === 'devices' ? 'is-on' : ''} onClick={() => setTarget('devices')}>
            <Users size={13} /> Seçili cihazlar ve gruplar</button>
        </div>
        {f.target === 'all' ? (
          <p className="tp-hint">Pi-hole'u DNS olarak kullanan her cihaz (Pi-hole'un Default grubu). Yalnız «her zaman» kategori / site engeli;
            «tüm internet» engeli yoktur (modemin ve Pi'nin bağlantısı kesilmez). Kendi DNS'ini (ör. 8.8.8.8) ya da şifreli DNS kullanan cihaz
            atlatır — 3. adımdaki «tüm ağda şifreli DNS engeli» bunu kapatır (yalnız IPv4).</p>
        ) : (
          <>
            <div className="tp-chips">
              {f.groups.map(g => {
                const grp = groups.find(x => x.id === g);
                return <span key={`g${g}`} className="tp-chip"><Users size={12} /> {grp?.name || `grup #${g}`} <small>{grp?.members?.length ?? 0} cihaz</small>
                  <button type="button" aria-label="Çıkar" onClick={() => set({ groups: f.groups.filter(x => x !== g) })}><X size={12} /></button></span>;
              })}
              {f.devices.map(m => (
                <span key={m} className="tp-chip"><Smartphone size={12} /> {deviceLabel(devices.find(d => d.mac_address.toLowerCase() === m), m)}
                  <button type="button" aria-label="Çıkar" onClick={() => set({ devices: f.devices.filter(x => x !== m) })}><X size={12} /></button></span>
              ))}
              {!f.devices.length && !f.groups.length && <span className="tp-muted">Henüz seçilmedi</span>}
            </div>
            <Select className="config-input" value="" onChange={e => addTarget(e.target.value)} columns={['text', 'mono', 'muted']} aria-label="Cihaz ya da grup ekle">
              <option value="">+ Cihaz ya da grup ekle…</option>
              {grpOpts.length > 0 && <optgroup label="Gruplar (Cihaz Yönetimi)">
                {grpOpts.map(g => <SelectOption key={g.id} value={`g:${g.id}`} cols={[g.name, '', `${g.members?.length ?? 0} cihaz`]} />)}
              </optgroup>}
              <optgroup label="Cihazlar">
                {devOpts.map(d => <SelectOption key={d.mac_address} value={d.mac_address.toLowerCase()} cols={[d.hostname || 'Adsız cihaz', d.ip_address || d.mac_address, '']} />)}
              </optgroup>
            </Select>
            <p className="tp-hint">Kural cihazı MAC adresinden tanır: gizli (rastgele) Wi-Fi adresi kullanan telefon kurala girmeyebilir. Seçilen
              cihazlarda dış DNS ve bilinen şifreli DNS (DoH) sunucuları kuralla kesilir.</p>
          </>
        )}
      </Step>

      <Step n={2} state={st(1)} lockedBy={current}>
        <label className="tp-check"><input type="checkbox" checked={f.adult} onChange={e => set({ adult: e.target.checked })} />
          <span><strong>{label('adult')}</strong> — her zaman<small>{cats.find(c => c.id === 'adult')?.desc}</small></span></label>
        <label className="tp-check"><input type="checkbox" checked={f.gambling} onChange={e => set({ gambling: e.target.checked })} />
          <span><strong>{label('gambling')}</strong> — her zaman<small>{cats.find(c => c.id === 'gambling')?.desc}</small></span></label>
        {useRow('social')}
        {useRow('gaming')}
        {timedOn && (
          <div className="tp-window">
            <span className="tp-cat-name">Saat aralığı (ör. ders saatleri)</span>
            <div className="tp-days">
              {DAYS.map(d => (
                <button key={d} type="button" aria-pressed={f.days.includes(d)} className={f.days.includes(d) ? 'is-on' : ''}
                  onClick={() => set({ days: f.days.includes(d) ? f.days.filter(x => x !== d) : DAYS.filter(x => x === d || f.days.includes(x)) })}>{DAY_SHORT[d]}</button>
              ))}
            </div>
            <div className="tp-times">
              <input type="time" aria-label="Başlangıç" value={f.start} onChange={e => set({ start: e.target.value })} />
              <span>–</span>
              <input type="time" aria-label="Bitiş" value={f.end} onChange={e => set({ end: e.target.value })} />
            </div>
          </div>
        )}
        {s1 && !s2 && problem && <p className="tp-hint is-bad">{problem}</p>}
      </Step>

      <Step n={3} state={st(2)} lockedBy={current}>
        <label className="tp-check"><input type="checkbox" checked={f.safeSearch} onChange={e => set({ safeSearch: e.target.checked })} />
          <span><strong>Güvenli arama</strong> — tüm ağda<small>Google, YouTube (Sıkı kısıtlı mod), Bing, DuckDuckGo; açılırken Pi-hole bir kez yeniden başlar (DNS birkaç saniye kesilir).</small></span></label>
        <label className="tp-check"><input type="checkbox" checked={f.dnsGuardAll} onChange={e => set({ dnsGuardAll: e.target.checked })} />
          <span><strong>Tüm ağda şifreli DNS engeli</strong> — isteğe bağlı<small>Dış DNS'i ve DoH / DoT ile engeli atlatmayı önler. Yalnız IPv4: IPv6'yı
            modem dağıtıyorsa o yol açık kalır. Dikkat: Android'de «Özel DNS» sabit bir sağlayıcıya ayarlı telefonların interneti kesilir.</small></span></label>
        {s2 && !s3 && problem && <p className="tp-hint is-bad">{problem} (2. ya da 3. adımda)</p>}
      </Step>

      <Step n={4} state={st(3)} lockedBy={current}>
        <div className="tp-actions">
          <button type="button" className="btn-outline btn-sm" disabled={!!problem || !!busy} onClick={doPreview}>
            {busy === 'preview' ? <Loader2 size={13} className="spin" /> : <Eye size={13} />} Önizle</button>
          <button type="button" className="btn-primary btn-sm btn-on" disabled={!!problem || !fresh || !!busy} onClick={doApply}
            title={!fresh ? 'Önce önizleyin' : undefined}>
            {busy === 'apply' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Uygula</button>
        </div>
        {preview && !fresh && <p className="tp-hint">Seçim değişti — yeniden önizleyin.</p>}
        {fresh && preview && (
          <ul className="tp-changes" aria-label="Yapılacak değişiklikler">
            {preview.changes.map((c, i) => (
              <li key={i} className={`is-${c.kind}`}>
                {c.kind === 'warn' ? <AlertTriangle size={13} /> : c.kind === 'info' || c.kind === 'keep' ? <Info size={13} /> : <Plus size={13} />}
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        )}
        {busy === 'apply' && <p className="tp-hint">Uygulanıyor — Pi-hole eşitlemesi birkaç dakika sürebilir.</p>}
      </Step>
      {err && <div className="tp-note is-bad"><AlertTriangle size={14} /><span>{err}</span></div>}
    </div>
  );
}

function LockedCard({ tpl }: { tpl: Tpl }) {
  return (
    <section className="glass-panel tp-card tp-locked" aria-label={tpl.title}>
      <div className="tp-card-head">
        <h4><Lock size={16} /> {tpl.title}</h4>
        <span className="tp-state is-off">{tpl.locked || 'Yakında'}</span>
      </div>
      <p className="tp-desc">{tpl.desc}</p>
      <p className="tp-hint">Ödeme cihazını gerçekten ayırmak için ayrı bir ağ bölgesi (VLAN ve yönetilebilir switch) gerekir: aynı ağdaki cihazlar
        arasındaki trafik Pi'den geçmez. Bu şablon bölgeler eklendiğinde açılacak.</p>
    </section>
  );
}

// ── Güvenli arama ────────────────────────────────────────────────────────────
function SafeSearchCard({ st, onChange }: { st: SsStatus; onChange: () => Promise<void> | void }) {
  const [prov, setProv] = useState<Prov[]>(st.providers);
  const [busy, setBusy] = useState(false);
  const dirty = [...prov].sort().join() !== [...st.providers].sort().join();
  const label = (id: Prov) => st.catalog.find(c => c.id === id)?.label || id;
  const dnsBusy = st.dns.phase !== 'idle' && st.dns.phase !== 'failed';
  const send = async (enabled: boolean, msg: string) => {
    setBusy(true);
    try {
      await putApi('/safesearch', { enabled, providers: prov });
      toast.success(msg);
      await onChange();
    } catch (e) {
      toast.error(errText(e, 'Uygulanamadı'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="glass-panel tp-card tp-ss" aria-label="Güvenli arama">
      <div className="tp-card-head">
        <h4><Search size={16} /> Güvenli arama (SafeSearch)</h4>
        <span className={`tp-state ${st.enabled ? (st.applied ? 'is-on' : 'is-warn') : 'is-off'}`}>{st.enabled ? (st.suspended ? 'Askıda' : st.applied ? 'Açık' : 'Açık — güncel değil') : 'Kapalı'}</span>
      </div>
      <p className="tp-desc">Arama motorlarının adı Pi-hole'da sağlayıcının kısıtlı sunucusuna yönlenir: uygunsuz sonuçlar gizlenir ve kullanıcı ayarı
        kapatamaz. Tüm ağ içindir (cihaz bazlı değil); Okul / Aile şablonu da bunu açar.</p>
      {!st.supported && <div className="tp-note is-warn"><Info size={14} /><span>Yalnız Pi üzerinde çalışır.</span></div>}
      <div className="tp-provs">
        {st.catalog.map(c => (
          <label key={c.id} className="tp-check tp-prov">
            <input type="checkbox" checked={prov.includes(c.id)} disabled={busy}
              onChange={e => setProv(p => (e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id)))} />
            <span><strong>{c.label}</strong><small>{c.names} ad → {c.target}{st.ips[c.target]?.a.length ? ` (${st.ips[c.target].a.join(', ')})` : ''}</small></span>
          </label>
        ))}
      </div>
      {st.enabled && dnsBusy && <div className="tp-note"><Loader2 size={14} className="spin" /><span>DNS yenileniyor (Pi-hole birkaç saniye yeniden başlıyor)…</span></div>}
      {/* Askıdayken DNS işinin hatası güvenlik ağının kendisidir: aşağıdaki askı notu yeter */}
      {st.enabled && !st.suspended && st.dns.phase === 'failed' && st.dns.error && <div className="tp-note is-bad"><AlertTriangle size={14} /><span>DNS: {st.dns.error}</span></div>}
      {st.pending && <div className="tp-note"><Info size={14} /><span>Bir sağlayıcının adresi değişti: yeni adres gece 03–06 arasında uygulanır (DNS gündüz yeniden başlatılmaz); o zamana dek son geçerli adres kullanılır.</span></div>}
      {st.enabled && st.suspended && (
        <div className="tp-note is-bad"><AlertTriangle size={14} />
          <span>Askıya alındı: {st.suspended}. Askıdayken kayıtlar ne gece ne başka bir DNS yenilemesinde yazılır.</span></div>
      )}
      {st.enabled && !st.applied && !st.suspended && !dnsBusy && (
        <div className="tp-note is-warn"><AlertTriangle size={14} />
          <span>Kayıtlar güncel değil (kaldırılan bir çakışma ya da elle silinen dosya). «Şimdi uygula» ile hemen yazılır; yoksa gece 03–06'da.</span></div>
      )}
      {st.error && <div className="tp-note is-warn"><AlertTriangle size={14} /><span>{st.error}</span></div>}
      {st.skipped.map(s => <div key={s.provider} className="tp-note is-warn"><AlertTriangle size={14} /><span>{label(s.provider)} uygulanmıyor: {s.reason}.</span></div>)}
      {st.conflicts.length > 0 && (
        <details className="tp-note tp-conf">
          <summary><Info size={14} /><span>{st.conflicts.length} ad atlandı — aynı ad için başka bir kayıt var (o kayıt geçerli)</span></summary>
          <ul>{st.conflicts.slice(0, 30).map(c => <li key={c.name}><code>{c.name}</code> — {c.reason}</li>)}</ul>
        </details>
      )}
      <p className="tp-hint">Atlatılabilir: şifreli DNS (DoH / DoT) kullanan, Pi-hole'u kullanmayan ya da IPv6 üzerinden başka bir DNS alan cihaz.
        «Tüm ağda şifreli DNS engeli» dış DNS'i ve DoH / DoT'yi kapatır (yalnız IPv4: IPv6'yı modem dağıtıyorsa o yol açık kalır). Routing'de VPS / DPI
        üzerinden geçirilen ya da yerel kaydı olan adlar atlanır. Tarayıcı ve telefon eski yanıtı birkaç dakika önbellekte tutabilir.</p>
      <div className="tp-foot">
        <span className="tp-muted">{st.resolvedAt ? `Adresler: ${new Date(st.resolvedAt).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        <div className="tp-actions">
          {!st.enabled && (
            <button type="button" className="btn-primary btn-sm btn-on" disabled={busy || !prov.length || !st.supported} onClick={() => send(true, 'Güvenli arama açıldı')}>
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Aç</button>
          )}
          {st.enabled && (dirty || !st.applied) && (
            <button type="button" className="btn-primary btn-sm btn-on" disabled={busy || !prov.length || dnsBusy} onClick={() => send(true, dirty ? 'Sağlayıcılar güncellendi' : 'Güvenli arama kayıtları yazıldı')}>
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {dirty ? 'Sağlayıcıları uygula' : 'Şimdi uygula'}</button>
          )}
          {st.enabled && (
            <button type="button" className="btn-outline btn-sm btn-off" disabled={busy} onClick={() => send(false, 'Güvenli arama kapatıldı')}>
              <X size={13} /> Kapat</button>
          )}
        </div>
      </div>
    </section>
  );
}

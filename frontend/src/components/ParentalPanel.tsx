import { useMemo, useState } from 'react';
import {
  Shield, Clock, Globe, Plus, Trash2, Pencil, Users, Smartphone, X, Moon, BookOpen, ShieldCheck, Wifi, MessageCircle,
  Gamepad2, Tv, Dices, EyeOff, AlertTriangle, Info, Loader2, CalendarClock, Target, Ban,
} from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Modal, Panel, Badge, Select } from './ui';
import { toast } from '../toast';
import type { Device } from '../types';
import './ParentalPanel.css';

// Ebeveyn kontrolleri (backend parental.ts). Kural = kime (cihazlar + Cihaz Yönetimi grupları) × neyi (tüm internet ya da
// kategoriler + siteler, birlikte) × ne zaman (her zaman / saat aralıklarında engelle / yalnız saat aralıklarında izin ver;
// birden çok aralık, gün seçimli, gece yarısını aşabilir). Kurallar Pi'de uygulanır: tüm internet güvenlik duvarında,
// kategori ve site Pi-hole'da yalnız o cihazlar için; dış DNS / DoH ile atlatma engellenir.
type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type Mode = 'always' | 'during' | 'outside';
interface TimeWindow { days: Day[]; start: string; end: string }
interface RuleBody {
  name: string; enabled: boolean; targets: { devices: string[]; groups: number[] };
  blockAll: boolean; categories: string[]; sites: string[]; mode: Mode; windows: TimeWindow[];
}
interface Rule extends RuleBody { id: number; legacy: boolean; status: { active: boolean; nextChange: string | null; devices: number } }
interface Category { id: string; label: string; desc: string; list: boolean }
interface Health { nft: boolean; pihole: boolean | null; error: string | null; at: number; gravityPending: boolean }
interface Group { id: number; name: string; color?: string; members?: { device_mac: string }[] }

const DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_SHORT: Record<Day, string> = { mon: 'Pzt', tue: 'Sal', wed: 'Çar', thu: 'Per', fri: 'Cum', sat: 'Cmt', sun: 'Paz' };
const WEEKDAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND: Day[] = ['sat', 'sun'];
const CAT_ICON: Record<string, typeof Globe> = { social: Users, video: Tv, gaming: Gamepad2, messaging: MessageCircle, adult: EyeOff, gambling: Dices };
const MODE_LABEL: Record<Mode, string> = { always: 'Her zaman', during: 'Bu saatlerde engelle', outside: 'Yalnız bu saatlerde izin ver' };

const EMPTY: RuleBody = { name: '', enabled: true, targets: { devices: [], groups: [] }, blockAll: false, categories: [], sites: [], mode: 'always', windows: [] };
const TEMPLATES: { key: string; icon: typeof Globe; title: string; desc: string; body: Partial<RuleBody> }[] = [
  { key: 'bed', icon: Moon, title: 'Yatma saati', desc: 'Her gece 22:00–07:00 internet kapalı',
    body: { name: 'Yatma saati', blockAll: true, mode: 'during', windows: [{ days: [...DAYS], start: '22:00', end: '07:00' }] } },
  { key: 'school', icon: BookOpen, title: 'Ders saati', desc: 'Hafta içi 08:00–16:00 sosyal medya, video ve oyun kapalı',
    body: { name: 'Ders saati', categories: ['social', 'video', 'gaming'], mode: 'during', windows: [{ days: [...WEEKDAYS], start: '08:00', end: '16:00' }] } },
  { key: 'safe', icon: ShieldCheck, title: 'Güvenli internet', desc: 'Yetişkin içerik ve kumar her zaman kapalı',
    body: { name: 'Güvenli internet', categories: ['adult', 'gambling'], mode: 'always' } },
];

const deviceLabel = (d?: Device, mac?: string) => d?.hostname || d?.ip_address || mac || '?';
function daysText(days: Day[]): string {
  const s = DAYS.filter(d => days.includes(d));
  if (s.length === 7) return 'Her gün';
  if (s.join() === WEEKDAYS.join()) return 'Hafta içi';
  if (s.join() === WEEKEND.join()) return 'Hafta sonu';
  return s.map(d => DAY_SHORT[d]).join(', ');
}
const windowText = (w: TimeWindow) => `${daysText(w.days)} ${w.start}–${w.end}${w.start > w.end ? ' (ertesi gün)' : w.start === w.end ? ' (tüm gün)' : ''}`;
function whenText(r: RuleBody): string {
  if (r.mode === 'always') return 'her zaman';
  const ws = r.windows.map(windowText).join(' ve ');
  return r.mode === 'during' ? `${ws} arasında` : `${ws} dışında (yalnız bu saatlerde açık)`;
}
function whatText(r: RuleBody, cats: Category[]): string {
  if (r.blockAll) return 'tüm internet';
  const parts = r.categories.map(c => cats.find(x => x.id === c)?.label.toLowerCase() || c);
  if (r.sites.length) parts.push(r.sites.length <= 2 ? r.sites.join(', ') : `${r.sites.slice(0, 2).join(', ')} ve ${r.sites.length - 2} site daha`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ve ${parts[parts.length - 1]}` : parts[0] || '—';
}
function nextText(iso: string | null, active: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const when = sameDay ? hm : d.toDateString() === tomorrow.toDateString() ? `yarın ${hm}` : `${d.toLocaleDateString('tr-TR', { weekday: 'short' })} ${hm}`;
  return active ? `${when}'de biter` : `${when}'de başlar`;
}
// Kullanıcının yazdığı site → alan adı (backend normalizeSite ile aynı; kesin doğrulama backend'de)
const cleanSite = (s: string) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
const SITE_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export function ParentalPanel() {
  const { data, refetch } = useApi<{ rules: Rule[]; catalog: Category[]; health?: Health }>('/parental/rules', { rules: [], catalog: [] }, 30000);
  const { data: devData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const { data: grpData } = useApi<{ groups: Group[] }>('/devices/groups', { groups: [] });
  const [editing, setEditing] = useState<{ id: number | null; body: RuleBody } | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const devices = devData.devices || [];
  const groups = grpData.groups || [];
  const cats = data.catalog || [];
  const activeCount = data.rules.filter(r => r.status?.active).length;
  const h = data.health;
  const later = () => setTimeout(() => { void refetch(); }, 2500);   // uygulama arka planda: sonucu (sağlık) biraz sonra oku

  const targetsText = (r: RuleBody) => {
    const names = [...r.targets.groups.map(g => groups.find(x => x.id === g)?.name || `grup #${g}`),
      ...r.targets.devices.map(m => deviceLabel(devices.find(d => d.mac_address.toLowerCase() === m), m))];
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} ve ${names.length - 3} hedef daha` : names.join(', ') || 'hedef yok';
  };

  const toggle = async (r: Rule) => {
    try {
      await putApi(`/parental/rules/${r.id}`, { enabled: !r.enabled });
      await refetch(); later();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Değiştirilemedi'); }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      await deleteApi(`/parental/rules/${removing.id}`);
      toast.success('Kural silindi');
      setRemoving(null);
      await refetch(); later();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Silinemedi'); }
  };

  return (
    <div className="fade-in pc">
      <Panel title="Ebeveyn Kontrolleri" icon={<Shield size={20} style={{ marginRight: 8 }} />}
        subtitle="Cihaz ya da grup için internet, kategori ve site kısıtlamaları — saat aralıklarıyla istediğin gibi birleştirilir"
        badge={<Badge variant={activeCount ? 'warning' : 'info'}>{data.rules.length} kural · {activeCount} şu an etkin</Badge>}
        actions={<button className="btn-primary btn-sm" onClick={() => setEditing({ id: null, body: { ...EMPTY } })}><Plus size={14} /> Kural ekle</button>}>
        {h?.pihole === false && (
          <div className="routing-apply routing-apply-err pc-note"><AlertTriangle size={14} />
            <span>Pi-hole'a ulaşılamadı: kategori ve site engelleri şu an uygulanamıyor (tüm internet engeli çalışır). {h.error}</span></div>
        )}
        {h && !h.nft && (
          <div className="routing-apply routing-apply-err pc-note"><AlertTriangle size={14} /><span>Güvenlik duvarı kuralı yüklenemedi: {h.error}</span></div>
        )}
        {h?.gravityPending && (
          <div className="routing-apply pc-note"><Loader2 size={14} className="spin" /><span>Hazır listeler (yetişkin içerik / kumar) Pi-hole'a indiriliyor…</span></div>
        )}
        <div className="pc-templates">
          {TEMPLATES.map(t => (
            <button key={t.key} className="pc-template" onClick={() => setEditing({ id: null, body: { ...EMPTY, ...t.body } })}>
              <t.icon size={18} />
              <span><strong>{t.title}</strong><small>{t.desc}</small></span>
            </button>
          ))}
        </div>
        <p className="pc-hint"><Info size={13} /> Kurallar, Pi'yi ağ geçidi ve DNS olarak kullanan cihazlarda uygulanır. Kategori ve site engeli
          alan adına göredir; kurala giren cihazlar dışarıdaki DNS sunucularını ve güvenli DNS'i (DoH) kullanamaz.</p>
      </Panel>

      <div className="pc-rules">
        {data.rules.length === 0 && (
          <div className="glass-panel pc-empty">Henüz kural yok. Yukarıdaki hazır şablonlardan biriyle ya da <strong>Kural ekle</strong> ile başlayın.</div>
        )}
        {data.rules.map(r => {
          const state = !r.enabled ? (r.legacy ? 'legacy' : 'off') : r.status?.active ? 'on' : 'wait';
          return (
            <section key={r.id} className={`glass-panel pc-rule pc-rule-${state}`}>
              <div className="pc-rule-head">
                <div className="pc-rule-title">
                  <strong>{r.name || whatText(r, cats)}</strong>
                  <span className={`pc-pill pc-pill-${state}`}>
                    {state === 'on' ? 'Şu an etkin' : state === 'wait' ? 'Bekliyor' : state === 'legacy' ? 'Gözden geçirin' : 'Kapalı'}
                    {r.enabled && r.status?.nextChange ? ` · ${nextText(r.status.nextChange, r.status.active)}` : ''}
                  </span>
                </div>
                <button className={`toggle-btn toggle-sm ${r.enabled ? 'toggle-on' : 'toggle-off'}`} onClick={() => toggle(r)}
                  aria-label={r.enabled ? 'Kuralı kapat' : 'Kuralı aç'}><div className="toggle-knob" /></button>
              </div>
              <div className="pc-rule-rows">
                <div className="pc-row"><Target size={14} /><span>{targetsText(r)}{r.enabled ? ` · ${r.status?.devices ?? 0} cihaz` : ''}</span></div>
                <div className="pc-row"><Ban size={14} />
                  <span className="pc-tags">
                    {r.blockAll ? <span className="pc-tag pc-tag-strong">Tüm internet</span> : null}
                    {r.categories.map(c => <span key={c} className="pc-tag">{cats.find(x => x.id === c)?.label || c}</span>)}
                    {r.sites.slice(0, 6).map(s => <span key={s} className="pc-tag pc-tag-site">{s}</span>)}
                    {r.sites.length > 6 && <span className="pc-tag">+{r.sites.length - 6} site</span>}
                  </span>
                </div>
                <div className="pc-row"><CalendarClock size={14} /><span>{r.mode === 'always' ? 'Her zaman' : `${r.mode === 'during' ? 'Engellenir' : 'Yalnız açık'}: ${r.windows.map(windowText).join(' · ')}`}</span></div>
              </div>
              {r.legacy && <div className="pc-legacy"><Info size={13} /> Eski sürümden taşındı ve kapalı geldi — düzenleyip açın.</div>}
              <div className="pc-rule-foot">
                <button className="btn-outline btn-sm" onClick={() => setEditing({ id: r.id, body: { name: r.name, enabled: r.enabled, targets: r.targets, blockAll: r.blockAll, categories: r.categories, sites: r.sites, mode: r.mode, windows: r.windows } })}>
                  <Pencil size={13} /> Düzenle
                </button>
                <button className="btn-outline btn-sm pc-danger" onClick={() => setRemoving(r)}><Trash2 size={13} /> Sil</button>
              </div>
            </section>
          );
        })}
      </div>

      {editing && (
        <RuleEditor initial={editing.body} id={editing.id} cats={cats} devices={devices} groups={groups} targetsText={targetsText}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refetch(); later(); }} />
      )}
      {removing && (
        <Modal open onClose={() => setRemoving(null)} title="Kuralı sil" width={420}
          actions={<>
            <button className="btn-outline btn-sm" onClick={() => setRemoving(null)}>Vazgeç</button>
            <button className="btn-primary btn-sm pc-danger-solid" onClick={remove}><Trash2 size={13} /> Sil</button>
          </>}>
          <p className="pc-hint" style={{ marginTop: 0 }}>«{removing.name || whatText(removing, cats)}» silinir; kısıtlama hemen kalkar.</p>
        </Modal>
      )}
    </div>
  );
}

function RuleEditor({ initial, id, cats, devices, groups, targetsText, onClose, onSaved }: {
  initial: RuleBody; id: number | null; cats: Category[]; devices: Device[]; groups: Group[];
  targetsText: (r: RuleBody) => string; onClose: () => void; onSaved: () => void;
}) {
  const [r, setR] = useState<RuleBody>(() => ({ ...initial, targets: { ...initial.targets }, windows: initial.windows.map(w => ({ ...w, days: [...w.days] })) }));
  const [site, setSite] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (p: Partial<RuleBody>) => setR(prev => ({ ...prev, ...p }));

  const problem = useMemo(() => {
    if (!r.targets.devices.length && !r.targets.groups.length) return 'Kime uygulanacağını seçin';
    if (!r.blockAll && !r.categories.length && !r.sites.length) return 'Neyin engelleneceğini seçin';
    if (r.mode !== 'always' && !r.windows.length) return 'En az bir saat aralığı ekleyin';
    if (r.windows.some(w => !w.days.length)) return 'Her saat aralığında en az bir gün seçin';
    return '';
  }, [r]);

  const addTarget = (v: string) => {
    if (!v) return;
    if (v.startsWith('g:')) {
      const g = Number(v.slice(2));
      if (!r.targets.groups.includes(g)) set({ targets: { ...r.targets, groups: [...r.targets.groups, g] } });
    } else if (!r.targets.devices.includes(v)) {
      set({ targets: { ...r.targets, devices: [...r.targets.devices, v] } });
    }
  };
  const addSite = () => {
    const parts = site.split(/[\s,;]+/).map(cleanSite).filter(Boolean);
    if (!parts.length) return;
    const bad = parts.filter(p => !SITE_RE.test(p));
    if (bad.length) { setErr(`Geçersiz site: ${bad.join(', ')}`); return; }
    setErr('');
    set({ sites: [...new Set([...r.sites, ...parts])] });
    setSite('');
  };
  const setMode = (m: Mode) => set({ mode: m, windows: m !== 'always' && !r.windows.length ? [{ days: [...DAYS], start: '22:00', end: '07:00' }] : r.windows });
  const setWin = (i: number, p: Partial<TimeWindow>) => set({ windows: r.windows.map((w, j) => (j === i ? { ...w, ...p } : w)) });

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const body = { ...r, windows: r.mode === 'always' ? [] : r.windows } as unknown as Record<string, unknown>;
      if (id == null) await postApi('/parental/rules', body);
      else await putApi(`/parental/rules/${id}`, body);
      toast.success(id == null ? 'Kural eklendi ve uygulanıyor' : 'Kural güncellendi');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Kaydedilemedi');
      setSaving(false);
    }
  };

  const devOpts = devices.filter(d => !r.targets.devices.includes(d.mac_address.toLowerCase()));
  const grpOpts = groups.filter(g => !r.targets.groups.includes(g.id));
  return (
    <Modal open onClose={onClose} title={id == null ? 'Yeni kural' : 'Kuralı düzenle'} width={660}
      actions={<>
        {problem && <span className="pc-problem">{problem}</span>}
        <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
        <button className="btn-primary btn-sm" disabled={!!problem || saving} onClick={save}>
          {saving ? <Loader2 size={13} className="spin" /> : null} Kaydet
        </button>
      </>}>
      <div className="form-group">
        <label htmlFor="pc-name">Kural adı (isteğe bağlı)</label>
        <input id="pc-name" value={r.name} maxLength={60} placeholder="ör. Ali — ders saati" onChange={e => set({ name: e.target.value })} />
      </div>

      <section className="pc-sec">
        <h5><Target size={14} /> Kime</h5>
        <div className="pc-chips">
          {r.targets.groups.map(g => {
            const grp = groups.find(x => x.id === g);
            return (
              <span key={`g${g}`} className="pc-chip pc-chip-group"><Users size={12} /> {grp?.name || `grup #${g}`}
                <small>{grp?.members?.length ?? 0} cihaz</small>
                <button aria-label="Çıkar" onClick={() => set({ targets: { ...r.targets, groups: r.targets.groups.filter(x => x !== g) } })}><X size={12} /></button>
              </span>
            );
          })}
          {r.targets.devices.map(m => (
            <span key={m} className="pc-chip"><Smartphone size={12} /> {deviceLabel(devices.find(d => d.mac_address.toLowerCase() === m), m)}
              <button aria-label="Çıkar" onClick={() => set({ targets: { ...r.targets, devices: r.targets.devices.filter(x => x !== m) } })}><X size={12} /></button>
            </span>
          ))}
          {!r.targets.devices.length && !r.targets.groups.length && <span className="pc-muted">Henüz seçilmedi</span>}
        </div>
        <Select className="config-input" value="" onChange={e => addTarget(e.target.value)}>
          <option value="">+ Cihaz ya da grup ekle…</option>
          {grpOpts.length > 0 && <optgroup label="Gruplar (Cihaz Yönetimi)">
            {grpOpts.map(g => <option key={g.id} value={`g:${g.id}`}>{`${g.name} (${g.members?.length ?? 0} cihaz)`}</option>)}
          </optgroup>}
          <optgroup label="Cihazlar">
            {devOpts.map(d => <option key={d.mac_address} value={d.mac_address.toLowerCase()}>{`${deviceLabel(d)} · ${d.ip_address || d.mac_address}`}</option>)}
          </optgroup>
        </Select>
        {!groups.length && <p className="pc-hint">Birden çok cihazı birlikte yönetmek için Cihaz Yönetimi'nden grup (ör. "Çocuklar") oluşturabilirsiniz.</p>}
      </section>

      <section className="pc-sec">
        <h5><Ban size={14} /> Neyi engelle</h5>
        <button className={`pc-all ${r.blockAll ? 'is-on' : ''}`} onClick={() => set({ blockAll: !r.blockAll })} aria-pressed={r.blockAll}>
          <Wifi size={18} /><span><strong>Tüm internet</strong><small>Cihaz internete hiç çıkamaz (seçiliyken kategori ve siteler gerekmez)</small></span>
        </button>
        <div className={`pc-cats ${r.blockAll ? 'is-disabled' : ''}`}>
          {cats.map(c => {
            const Icon = CAT_ICON[c.id] || Globe;
            const on = r.categories.includes(c.id);
            return (
              <button key={c.id} className={`pc-cat ${on ? 'is-on' : ''}`} disabled={r.blockAll} aria-pressed={on}
                onClick={() => set({ categories: on ? r.categories.filter(x => x !== c.id) : [...r.categories, c.id] })}>
                <Icon size={16} /><span><strong>{c.label}</strong><small>{c.desc}</small></span>
              </button>
            );
          })}
        </div>
        <div className={`pc-sites ${r.blockAll ? 'is-disabled' : ''}`}>
          <div className="pc-site-add">
            <input className="config-input" value={site} disabled={r.blockAll} placeholder="Site ekle: ornek.com (virgülle birden çok)"
              onChange={e => setSite(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSite(); } }} />
            <button className="btn-outline btn-sm" disabled={r.blockAll || !site.trim()} onClick={addSite}><Plus size={13} /> Ekle</button>
          </div>
          {r.sites.length > 0 && (
            <div className="pc-chips">
              {r.sites.map(s => (
                <span key={s} className="pc-chip pc-chip-site"><Globe size={12} /> {s}
                  <button aria-label="Çıkar" onClick={() => set({ sites: r.sites.filter(x => x !== s) })}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="pc-sec">
        <h5><Clock size={14} /> Ne zaman</h5>
        <div className="pc-seg" role="radiogroup">
          {(['always', 'during', 'outside'] as Mode[]).map(m => (
            <button key={m} role="radio" aria-checked={r.mode === m} className={r.mode === m ? 'is-on' : ''} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
          ))}
        </div>
        {r.mode !== 'always' && (
          <div className="pc-windows">
            {r.windows.map((w, i) => (
              <div key={i} className="pc-window">
                <div className="pc-days">
                  {DAYS.map(d => (
                    <button key={d} className={w.days.includes(d) ? 'is-on' : ''} aria-pressed={w.days.includes(d)}
                      onClick={() => setWin(i, { days: w.days.includes(d) ? w.days.filter(x => x !== d) : DAYS.filter(x => x === d || w.days.includes(x)) })}>{DAY_SHORT[d]}</button>
                  ))}
                  <span className="pc-quick">
                    <button onClick={() => setWin(i, { days: [...DAYS] })}>Her gün</button>
                    <button onClick={() => setWin(i, { days: [...WEEKDAYS] })}>Hafta içi</button>
                    <button onClick={() => setWin(i, { days: [...WEEKEND] })}>Hafta sonu</button>
                  </span>
                </div>
                <div className="pc-times">
                  <input className="config-input" type="time" value={w.start} onChange={e => setWin(i, { start: e.target.value })} aria-label="Başlangıç" />
                  <span>–</span>
                  <input className="config-input" type="time" value={w.end} onChange={e => setWin(i, { end: e.target.value })} aria-label="Bitiş" />
                  {w.start > w.end && <small className="pc-muted">ertesi güne geçer</small>}
                  {r.windows.length > 1 && <button className="icon-btn icon-btn-sm" aria-label="Aralığı sil" onClick={() => set({ windows: r.windows.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>}
                </div>
              </div>
            ))}
            {r.windows.length < 10 && (
              <button className="btn-outline btn-sm" onClick={() => set({ windows: [...r.windows, { days: [...WEEKDAYS], start: '08:00', end: '16:00' }] })}>
                <Plus size={13} /> Saat aralığı ekle
              </button>
            )}
          </div>
        )}
      </section>

      <div className="pc-summary">
        <Info size={14} />
        <span>{problem ? 'Kural tamamlanınca özeti burada görünür.' : <><strong>{targetsText(r)}</strong>: {whatText(r, cats)} {r.mode === 'outside' ? 'yalnız belirtilen saatlerde açık, diğer zamanlarda engellenir' : `— ${whenText(r)} engellenir`}.</>}</span>
      </div>
      {err && <div className="routing-apply routing-apply-err"><AlertTriangle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}

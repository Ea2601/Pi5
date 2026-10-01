import { useEffect, useMemo, useState } from 'react';
import { History, Search, Trash2, Loader2, AlertTriangle, Info, ShieldOff, ShieldCheck } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { Panel, Select, Modal } from './ui';
import { toast } from '../toast';
import './VisitHistory.css';

// Ziyaret Geçmişi (backend visits.ts): hangi cihaz ne zaman hangi siteye girdi ve sitenin içerik türü. Pi-hole'un sorgu
// kaydından; site düzeyi (HTTPS'te sayfanın yolu ağdan görünmez). Arka plan istekleri (CDN, ölçüm, ön yükleme, gömülü
// içerik, uygulamaların alt adresleri) ayıklanır; "Arka planı da göster" nedenleriyle birlikte gösterir.
interface Visit {
  id: number; device: string; name: string; ip: string; site: string; host: string; category: string;
  first_at: number; last_at: number; queries: number; blocked: number; kind: 'visit' | 'background'; reason: string | null;
}
interface VisitResp {
  visits: Visit[]; total: number;
  devices: { device: string; name: string; n: number }[];
  categories: { id: string; n: number }[];
  cats: { id: string; label: string }[];
  status: { running: boolean; lastAt: number | null; cursorAt: number | null; error: string | null; note: string | null };
  lists: { domains: number; updatedAt: string | null; error: string | null };
  retentionDays: number;
}
const EMPTY: VisitResp = {
  visits: [], total: 0, devices: [], categories: [], cats: [],
  status: { running: false, lastAt: null, cursorAt: null, error: null, note: null },
  lists: { domains: 0, updatedAt: null, error: null }, retentionDays: 30,
};

// Tüm ağda şifreli DNS engeli (backend parental.ts; /parental/dns-guard — yazma netAdminGuard'dan geçer)
interface DnsGuard { enabled: boolean; applied: boolean; pihole: boolean | null; error: string | null }

type Range = 'today' | 'yesterday' | '7d' | '30d';
const RANGES: { id: Range; label: string }[] = [
  { id: 'today', label: 'Bugün' }, { id: 'yesterday', label: 'Dün' }, { id: '7d', label: '7 gün' }, { id: '30d', label: '30 gün' },
];
// Yerel gece yarısına göre aralık (unix sn)
function rangeOf(r: Range): { from: number; until: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const midnight = Math.floor(d.getTime() / 1000);
  const tomorrow = midnight + 86400;
  if (r === 'yesterday') return { from: midnight - 86400, until: midnight };
  if (r === '7d') return { from: midnight - 6 * 86400, until: tomorrow };
  if (r === '30d') return { from: midnight - 29 * 86400, until: tomorrow };
  return { from: midnight, until: tomorrow };
}

const fmtTime = (s: number) => new Date(s * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (s: number) => new Date(s * 1000).toDateString();
function dayLabel(s: number): string {
  const d = new Date(s * 1000);
  const today = new Date();
  const y = new Date(); y.setDate(y.getDate() - 1);
  const base = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  if (d.toDateString() === today.toDateString()) return `Bugün · ${base}`;
  if (d.toDateString() === y.toDateString()) return `Dün · ${base}`;
  return base;
}
// Süre: ilk–son istek (DNS önbelleği yüzünden yaklaşık)
function fmtDur(v: Visit): string {
  const s = v.last_at - v.first_at;
  if (s < 60) return 'kısa';
  const m = Math.round(s / 60);
  if (m < 60) return `~${m} dk`;
  return `~${Math.floor(m / 60)} sa${m % 60 ? ` ${m % 60} dk` : ''}`;
}

export function VisitHistory() {
  const [range, setRange] = useState<Range>('today');
  const [device, setDevice] = useState('');
  const [cat, setCat] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [bg, setBg] = useState(false);
  const [limit, setLimit] = useState(200);
  const [clearOpen, setClearOpen] = useState(false);

  // Süzgeç değişince listenin başına dönülür (limit sıfırlanır)
  const pick = <T,>(set: (v: T) => void) => (v: T) => { set(v); setLimit(200); };
  // Arama yazarken her tuşta istek gitmesin
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setLimit(200); }, 350);
    return () => clearTimeout(t);
  }, [qInput]);

  const { from, until } = useMemo(() => rangeOf(range), [range]);
  const qs = new URLSearchParams({ from: String(from), until: String(until), limit: String(limit) });
  if (device) qs.set('device', device);
  if (cat) qs.set('cat', cat);
  if (q) qs.set('q', q);
  if (bg) qs.set('bg', '1');
  const { data, loading, refetch } = useApi<VisitResp>(`/visits?${qs}`, EMPTY, 30000);

  const catLabel = useMemo(() => new Map(data.cats.map(c => [c.id, c.label])), [data.cats]);
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: Visit[] }[] = [];
    for (const v of data.visits) {
      const k = dayKey(v.first_at);
      const last = out[out.length - 1];
      if (last && last.key === k) last.rows.push(v);
      else out.push({ key: k, label: dayLabel(v.first_at), rows: [v] });
    }
    return out;
  }, [data.visits]);
  const devName = data.devices.find(d => d.device === device)?.name || device;
  const st = data.status;
  const { data: guard, refetch: refetchGuard } = useApi<DnsGuard | null>('/parental/dns-guard', null, 60000);
  const [guardBusy, setGuardBusy] = useState(false);
  const [guardAsk, setGuardAsk] = useState(false);
  const setGuard = async (enabled: boolean) => {
    setGuardBusy(true);
    try {
      const r = await postApi('/parental/dns-guard', { enabled }) as DnsGuard;
      if (enabled && !r.applied) toast.error(`Şifreli DNS engeli uygulanamadı: ${r.error || 'bilinmeyen hata'}`);
      else toast.success(enabled ? 'Şifreli DNS engeli açıldı — tüm cihazlar Pi-hole\'dan geçiyor' : 'Şifreli DNS engeli kapatıldı');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Değiştirilemedi');
    } finally {
      setGuardBusy(false);
      setGuardAsk(false);
      void refetchGuard();
    }
  };

  return (
    <Panel title="Ziyaret Geçmişi" icon={<History size={20} style={{ marginRight: 8 }} />} className="vh-panel"
      subtitle="Hangi cihaz, ne zaman, hangi siteye girdi — tarayıcıyla girilen siteler; arka plan istekleri ayıklanır"
      actions={
        <button className="btn-outline btn-sm" onClick={() => setClearOpen(true)} disabled={!data.total && !device}>
          <Trash2 size={13} /> Geçmişi temizle
        </button>
      }>
      <p className="vh-note">
        <Info size={13} /> Site düzeyindedir: HTTPS'te sayfanın tam adresi ağdan görünmez. Süre yaklaşıktır.
        Geçmiş {data.retentionDays} gün saklanır, yedeğe girmez.{guard?.enabled ? '' : ' Kendi şifreli DNS\'ini kullanan cihazlar görünmez.'}
      </p>
      {guard && (
        <div className={`vh-guard${guard.enabled ? ' is-on' : ''}`}>
          <ShieldCheck size={16} />
          <div className="vh-guard-text">
            <strong>Şifreli DNS engeli (tüm ağ)</strong>
            <span>
              {guard.enabled && guard.applied && 'Açık — tüm cihazların DNS\'i Pi-hole\'dan geçiyor; DoT / DoH kapalı.'}
              {guard.enabled && !guard.applied && `Açık ama uygulanamadı: ${guard.error || 'güvenlik duvarı kuralı yüklenemedi'}`}
              {!guard.enabled && 'Kapalı — tarayıcısında ya da telefonunda şifreli DNS açık cihazlar listede görünmez.'}
            </span>
          </div>
          <button className={`toggle-btn${guard.enabled ? ' toggle-on' : ' toggle-off'}`} disabled={guardBusy}
            aria-label="Şifreli DNS engeli" title={guard.enabled ? 'Kapat' : 'Aç'}
            onClick={() => (guard.enabled ? void setGuard(false) : setGuardAsk(true))}>
            {guardBusy ? <Loader2 size={12} className="spin" /> : <div className="toggle-knob" />}
          </button>
        </div>
      )}
      {st.error && <div className="routing-apply routing-apply-err vh-alert"><AlertTriangle size={14} /><span>{st.error}</span></div>}
      {st.note && <div className="routing-apply routing-apply-err vh-alert"><AlertTriangle size={14} /><span>{st.note}</span></div>}
      {!st.running && !loading && (
        <div className="routing-apply vh-alert"><Info size={14} /><span>Ziyaret toplayıcısı bu cihazda çalışmıyor (uydu cihaz ya da Pi-hole yok).</span></div>
      )}

      <div className="vh-filters">
        <div className="vh-seg" role="radiogroup" aria-label="Zaman aralığı">
          {RANGES.map(r => (
            <button key={r.id} role="radio" aria-checked={range === r.id} className={`vh-seg-btn${range === r.id ? ' is-on' : ''}`}
              onClick={() => pick(setRange)(r.id)}>{r.label}</button>
          ))}
        </div>
        <Select className="config-input vh-select" value={device} onChange={e => pick(setDevice)(e.target.value)} aria-label="Cihaz">
          <option value="">Tüm cihazlar</option>
          {data.devices.map(d => <option key={d.device} value={d.device}>{d.name} ({d.n})</option>)}
        </Select>
        <Select className="config-input vh-select" value={cat} onChange={e => pick(setCat)(e.target.value)} aria-label="İçerik türü">
          <option value="">Tüm türler</option>
          {data.cats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
        <label className="vh-search">
          <Search size={14} />
          <input type="search" placeholder="Site ara" value={qInput} onChange={e => setQInput(e.target.value)} />
        </label>
        <label className="vh-toggle" title="CDN, ölçüm, ön yükleme, gömülü içerik ve uygulamaların arka plan istekleri">
          <input type="checkbox" checked={bg} onChange={e => pick(setBg)(e.target.checked)} /> Arka planı da göster
        </label>
      </div>

      {data.categories.length > 0 && (
        <div className="vh-chips">
          {data.categories.map(c => (
            <button key={c.id} data-cat={c.id} className={`vh-chip${cat === c.id ? ' is-on' : ''}`} onClick={() => pick(setCat)(cat === c.id ? '' : c.id)}>
              {catLabel.get(c.id) || c.id} <b>{c.n}</b>
            </button>
          ))}
        </div>
      )}

      {loading && !data.visits.length ? (
        <div className="empty-state" style={{ padding: 24 }}><Loader2 size={18} className="spin" /></div>
      ) : !data.visits.length ? (
        <div className="empty-state" style={{ padding: 24 }}>
          {q || cat || device ? 'Bu süzgeçle ziyaret yok.' : 'Bu aralıkta ziyaret yok. Yeni ziyaretler 30 sn – 2 dk içinde görünür.'}
        </div>
      ) : (
        <div className="vh-list">
          {groups.map(g => (
            <section key={g.key} className="vh-day">
              <h4 className="vh-day-head">{g.label}</h4>
              {g.rows.map(v => (
                <div key={v.id} className={`vh-row${v.kind === 'background' ? ' is-bg' : ''}${v.blocked ? ' is-blocked' : ''}`}>
                  <time className="vh-time" dateTime={new Date(v.first_at * 1000).toISOString()}>{fmtTime(v.first_at)}</time>
                  <span className="vh-site" title={v.host}>
                    {v.site}
                    {v.blocked ? <span className="vh-flag"><ShieldOff size={11} /> engellendi</span> : null}
                  </span>
                  <span className="vh-cat" data-cat={v.category}>{catLabel.get(v.category) || v.category}</span>
                  <span className="vh-dev" title={v.ip}>{v.name}</span>
                  <span className="vh-dur" title={`${fmtTime(v.first_at)} – ${fmtTime(v.last_at)} · ${v.queries} istek`}>{fmtDur(v)}</span>
                  {v.kind === 'background' && <span className="vh-reason">{v.reason || 'arka plan'}</span>}
                </div>
              ))}
            </section>
          ))}
          {data.visits.length < data.total && (
            <button className="btn-outline btn-sm vh-more" onClick={() => setLimit(l => l + 200)}>
              Daha fazla göster ({data.total - data.visits.length})
            </button>
          )}
        </div>
      )}

      {guardAsk && (
        <Modal open onClose={() => setGuardAsk(false)} title="Şifreli DNS engelini aç" width={500}
          actions={
            <>
              <button className="btn-outline btn-sm" onClick={() => setGuardAsk(false)} disabled={guardBusy}>Vazgeç</button>
              <button className="btn-primary btn-sm" onClick={() => void setGuard(true)} disabled={guardBusy}>
                {guardBusy ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} Aç
              </button>
            </>
          }>
          <p className="vh-modal-text">Ev ağındaki her cihazın DNS'i Pi-hole'dan geçer: elle başka DNS'e (ör. 8.8.8.8) ayarlı cihazlar
            Pi-hole'a yönlendirilir ve çalışmayı sürdürür; şifreli DNS (DoT, DoH) kapatılır. Bu cihazlarda bir ayar değiştirmek gerekebilir:</p>
          <ul className="vh-modal-list">
            <li><strong>Android "Özel DNS"</strong> belirli bir sağlayıcıya (ör. dns.google) ayarlıysa telefonun interneti kesilir →
              Ayarlar → Ağ → Özel DNS → <strong>Otomatik</strong> ya da <strong>Kapalı</strong>.</li>
            <li><strong>Tarayıcıda "Güvenli DNS"</strong> Cloudflare / Google gibi bir sağlayıcıya ayarlıysa siteler açılmaz →
              <strong> Kapalı</strong> ya da <strong>"Mevcut servis sağlayıcınız"</strong>.</li>
            <li>Cloudflare WARP / 1.1.1.1 uygulaması bu ağda çalışmaz.</li>
          </ul>
          <p className="vh-modal-text">VPS tünelleri ve Pi'nin kendi bağlantıları etkilenmez. Sorun olursa bu anahtarla hemen kapatabilirsiniz.
            Yalnız IPv4: IPv6'yı modem dağıtıyorsa o trafik Pi'den geçmez.</p>
        </Modal>
      )}

      {clearOpen && (
        <ClearModal device={device} deviceName={devName} onClose={() => setClearOpen(false)}
          onDone={() => { setClearOpen(false); void refetch(); }} />
      )}
    </Panel>
  );
}

function ClearModal({ device, deviceName, onClose, onDone }: { device: string; deviceName: string; onClose: () => void; onDone: () => void }) {
  const [sending, setSending] = useState(false);
  const clear = async (dev?: string) => {
    setSending(true);
    try {
      const r = await postApi('/visits/clear', dev ? { device: dev } : {}) as { removed?: number };
      toast.success(`Geçmiş temizlendi (${r.removed ?? 0} kayıt)`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Temizlenemedi');
      setSending(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Ziyaret geçmişini temizle" width={440}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose} disabled={sending}>Vazgeç</button>
          {device && (
            <button className="btn-outline btn-sm" onClick={() => void clear(device)} disabled={sending}>
              Yalnız {deviceName}
            </button>
          )}
          <button className="btn-primary btn-sm" onClick={() => void clear()} disabled={sending}>
            {sending ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Tümünü sil
          </button>
        </>
      }>
      <p className="vh-modal-text">
        Kayıtlar kalıcı olarak silinir. Toplama sürer: yeni ziyaretler yine görünür.
      </p>
    </Modal>
  );
}

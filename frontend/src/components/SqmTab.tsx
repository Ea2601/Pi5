import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, Gauge, Info, Loader2, Lock, Play, Power, RotateCcw, ShieldCheck, Timer } from 'lucide-react';
import { useApi, putApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Badge, Panel, Select } from './ui';
import './SqmTab.css';

// Bant Genişliği → "Gecikme (Akıllı Kuyruk)" (G1.1-A, backend sqm.ts): hat düzeyi CAKE ile indirme / yükleme sırasında
// gecikmenin fırlamasını (bufferbloat) önler. Varsayılan kapalı. Sihirbaz sıralı ve adım adım (yalnız sıradaki parlak):
// ① hat ve ön koşullar ② bant — elle ya da "Ölç" (Ookla; hattın gerçek hızının %90'ı önerilir — paket ek yükü hesaba
// katılır; ölçüm boyunca kuyruk geçici kalkar) + "Kaydet" ③ "Dene (5 dk)" (yeşil) ④ "Kalıcı yap" (yeşil) / "Geri al"
// (kırmızı). Kalıcıyken "Kapat" kırmızı. Adımlar ayardan (enabled / trialUntil) türetilir, anlık durumdan değil: arayüz
// beklenirken (PPPoE yeniden arıyor) deneme ve kalıcı kuyruk görünür kalır. Tek bacak ve ev Wi-Fi köprüsü (br0) bu
// sürümde yok — neden ve "yakında" gösterilir (G1.1-B). Yedek hattayken "Ölç" ve "Dene" kapalı.

type Overhead = 'ethernet' | 'docsis' | 'vdsl' | 'adsl' | 'raw';
type State = 'unsupported' | 'off' | 'mismatch' | 'calibrating' | 'trial' | 'on' | 'waiting' | 'error';
interface SqmStatus {
  supported: boolean; code: string; reason: string; satellite: boolean;
  line: { dev: string; kind: string; label: string; nat: boolean; port: string } | null;
  tc: boolean; modules: Record<string, boolean>; missingModules: string[]; ready: boolean;
  configured: boolean; enabled: boolean; trialUntil: number; now: number; trialS: number; onBackup?: boolean;
  config: {
    downKbit: number; upKbit: number; overhead: Overhead; savedAt: number; sigMatches: boolean; overheadBytes: number | null;
    efficiency?: number | null;
  } | null;
  state: State; calibrating: boolean; lastError: string;
  defaults: { overhead: Overhead; suggestPct: number }; limits: { minKbit: number; maxKbit: number };
  overheadPreview: Record<Overhead, number | null> | null; efficiencyPreview?: Record<Overhead, number> | null; warnings: string[];
}
interface Measured { download_mbps: number; upload_mbps: number; ping_ms: number; loaded_ms?: number | null; server?: string }
type Suggestion = { downKbit: number; upKbit: number; pct: number };
interface CalResp { result: Measured; bypassed: boolean; suggestion: Suggestion; suggestions?: Record<Overhead, Suggestion> }
interface Draft { down: string; up: string; overhead: Overhead }

const INITIAL: SqmStatus = {
  supported: false, code: '', reason: '', satellite: false, line: null, tc: false, modules: {}, missingModules: [], ready: false,
  configured: false, enabled: false, trialUntil: 0, now: 0, trialS: 300, config: null, state: 'off', calibrating: false,
  lastError: '', defaults: { overhead: 'ethernet', suggestPct: 90 }, limits: { minKbit: 64, maxKbit: 10_000_000 },
  overheadPreview: null, warnings: [],
};
const BACKUP_TEXT = 'Şu an yedek hattasınız — ölçüm ve deneme ana hatta dönünce yapılabilir.';
const OVERHEAD_LABEL: Record<Overhead, string> = {
  ethernet: 'Ethernet / fiber (önerilen)',
  docsis: 'Kablo internet (DOCSIS)',
  vdsl: 'VDSL (PTM)',
  adsl: 'ADSL (ATM)',
  raw: 'Ek yük hesaplama (raw)',
};
const STATE_BADGE: Record<State, { v: 'success' | 'error' | 'info' | 'neutral' | 'warning'; t: string }> = {
  unsupported: { v: 'neutral', t: 'Bu kurulumda yok' },
  off: { v: 'neutral', t: 'Kapalı' },
  mismatch: { v: 'warning', t: 'Hat değişti' },
  calibrating: { v: 'info', t: 'Ölçülüyor' },
  trial: { v: 'warning', t: 'Deneme' },
  on: { v: 'success', t: 'Açık' },
  waiting: { v: 'warning', t: 'Arayüz bekleniyor' },
  error: { v: 'error', t: 'Takılamadı' },
};

// kbit/sn → "90" / "18,5" (Mbps)
const mbpsText = (kbit: number) => String(Math.round(kbit / 100) / 10).replace('.', ',');
const toKbit = (s: string) => {
  const v = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(v) ? Math.round(v * 1000) : NaN;
};
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Deneme geri sayımı (sunucu saatine göre; WanPanel / DhcpWizard'daki gibi): tarayıcının saati Pi'ninkinden farklı olsa da
// kalan süre doğru görünür.
function useCountdown(ends: number, now: number): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!ends) return;
    const startedAt = performance.now();
    const base = now ? now * 1000 : Date.now();
    const update = () => setLeft(Math.max(0, Math.round(ends - (base + performance.now() - startedAt) / 1000)));
    const first = setTimeout(update, 0);
    const tick = setInterval(update, 1000);
    return () => { clearTimeout(first); clearInterval(tick); };
  }, [ends, now]);
  return ends ? left : null;
}

type StepState = 'done' | 'active' | 'todo';
function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  return (
    <div className={`dhcp-step dhcp-step-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <div className="dhcp-step-head">
        <span className="dhcp-step-num">{state === 'done' ? <Check size={12} /> : n}</span>
        <strong>{title}</strong>
      </div>
      {children && <div className="dhcp-step-body">{children}</div>}
    </div>
  );
}
const Locked = ({ text }: { text: string }) => <span className="dhcp-step-lock"><Lock size={12} /> {text}</span>;
function Note({ kind, children }: { kind: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'warn' ? 'err' : 'ok'} sqm-note`}>
      {kind === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

export function SqmTab() {
  const { data: st, refetch, error } = useApi<SqmStatus>('/bandwidth/sqm', INITIAL, 5000);
  const [ack, setAck] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);   // null: kayıtlı değerler gösterilir
  const [editing, setEditing] = useState(false);            // kalıcıyken "Bandı değiştir"
  const [busy, setBusy] = useState<string | null>(null);
  const [cal, setCal] = useState<CalResp | null>(null);
  const [check, setCheck] = useState<Measured | null>(null); // denemede kuyruklu ölçüm
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const [busySince, setBusySince] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  const cfg = st.config;
  const saved: Draft = { down: cfg ? mbpsText(cfg.downKbit) : '', up: cfg ? mbpsText(cfg.upKbit) : '', overhead: cfg?.overhead || st.defaults.overhead };
  const form = draft || saved;
  const downK = toKbit(form.down), upK = toKbit(form.up);
  const inRange = (k: number) => Number.isInteger(k) && k >= st.limits.minKbit && k <= st.limits.maxKbit;
  const formOk = inRange(downK) && inRange(upK);
  const dirty = !!draft && (!cfg || downK !== cfg.downKbit || upK !== cfg.upKbit || form.overhead !== cfg.overhead);
  const savedOk = !!cfg && cfg.sigMatches && !dirty;
  // Deneme / kalıcı ayardan (anlık durum değil): arayüz beklenirken ya da kurulum hatasında da adımlar doğru kalır.
  const inTrial = st.enabled && st.trialUntil > 0;
  const permanent = st.enabled && !st.trialUntil;
  const trialLeft = useCountdown(inTrial ? st.trialUntil : 0, st.now) ?? 0;
  const elapsed = busy ? Math.max(0, nowS - busySince) : 0;

  const act = async <T,>(key: string, fn: () => Promise<T>, ok?: (r: T) => string): Promise<T | null> => {
    setBusy(key);
    setBusySince(Math.floor(Date.now() / 1000));
    try {
      const r = await fn();
      if (ok) toast.success(ok(r));
      return r;
    } catch (e) {
      toast.error(errText(e, 'İşlem başarısız'));
      return null;
    } finally {
      setBusy(null);
      await refetch();
    }
  };
  const setField = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const measure = () => void act('cal', () => postApi('/bandwidth/sqm/calibrate', { overhead: form.overhead }) as Promise<CalResp>).then(r => { if (r) setCal(r); });
  // Öneri seçili bağlantı türüne göre (tür ölçümden sonra değiştirilse de doğru öneri)
  const sug = cal ? (cal.suggestions?.[form.overhead] || cal.suggestion) : null;
  const useSuggestion = () => sug && setDraft({ ...form, down: mbpsText(sug.downKbit), up: mbpsText(sug.upKbit) });
  const save = () => void act('save', () => putApi('/bandwidth/sqm', { downKbit: downK, upKbit: upK, overhead: form.overhead }) as Promise<{ trialUntil: number }>,
    r => (r.trialUntil ? 'Kaydedildi — yeni bantla 5 dk deneme başladı' : 'Bant kaydedildi')).then(r => { if (r) { setDraft(null); setEditing(false); } });
  const startTrial = () => void act('trial', () => postApi('/bandwidth/sqm/trial', {}), () => 'Deneme başladı — 5 dk içinde "Kalıcı yap"a basın');
  const confirm = () => void act('confirm', () => postApi('/bandwidth/sqm/confirm', {}), () => 'Akıllı kuyruk kalıcı yapıldı');
  const rollback = () => void act('rollback', () => postApi('/bandwidth/sqm/rollback', {}), () => 'Deneme geri alındı — hat eski hâlinde').then(() => setCheck(null));
  const turnOff = () => {
    if (!window.confirm('Akıllı kuyruk kapatılsın mı? Hat eski hâline döner (yük altında gecikme yeniden artabilir).')) return;
    void act('off', () => postApi('/bandwidth/sqm/disable', {}), () => 'Akıllı kuyruk kapatıldı').then(() => setCheck(null));
  };
  const shapedTest = () => void act('check', async () => (await postApi('/speedtest/run', {})).result as Measured).then(r => { if (r) setCheck(r); });

  if (error && !st.now) {
    return <div className="sqm-page"><Panel title="Gecikme (Akıllı Kuyruk)" icon={<Timer size={18} style={{ marginRight: 8 }} />}>
      <Note kind="warn">Durum okunamadı ({error}) — sayfayı yenileyin.</Note>
    </Panel></div>;
  }

  const badge = STATE_BADGE[st.state] || STATE_BADGE.off;
  const soon = st.code === 'onearm' || st.code === 'bridge';
  const busyAny = busy !== null || st.calibrating;
  // Kalıcıyken (takılı, arayüz bekleniyor ya da takılamadı) özet + "Bandı değiştir"; sihirbaz kapalıyken, denemede ve hat
  // değişince.
  const showWizard = st.supported && (editing || !st.enabled || inTrial || st.state === 'mismatch');
  const step1Done = st.supported && st.ready && (ack || savedOk || st.enabled);
  const step2Done = step1Done && savedOk;
  const onBackup = !!st.onBackup;
  const oh = (o: Overhead) => (st.overheadPreview?.[o] != null ? ` · +${st.overheadPreview[o]} bayt` : '');
  // "Kuyrukla hız testi": beklenen = bant × verim (hız testi paket başlıklarını saymaz)
  const eff = cfg?.efficiency || 1;
  const ofExpected = (mbps: number, kbit: number) => Math.round((mbps * 1000 / (kbit * eff)) * 100);

  return (
    <div className="sqm-page">
      <Panel title="Gecikme (Akıllı Kuyruk)" icon={<Timer size={18} style={{ marginRight: 8 }} />}
        subtitle="İndirme ya da yükleme hattı doldurduğunda ping'in fırlamasını önler: kuyruk Pi'de, hattın biraz altında oluşur ve cihazlar arasında adil paylaşılır"
        badge={<Badge variant={soon ? 'info' : badge.v}>{soon ? 'Yakında' : badge.t}</Badge>}
        actions={st.enabled ? <button className="btn-outline btn-sm btn-off" onClick={turnOff} disabled={busyAny}><Power size={13} /> Kapat</button> : undefined}>
        {st.line && <div className="sqm-line"><Gauge size={14} /><span><strong>Hat:</strong> {st.line.label}</span></div>}
        {!st.supported && (
          <Note kind={soon ? 'info' : 'warn'}>{st.reason || 'Bu kurulumda kullanılamıyor'}</Note>
        )}
        {!st.supported && st.enabled && (
          <Note kind="warn">Akıllı kuyruk açık ama bu kipte takılmıyor — hat kuyruksuz çalışıyor. Kapatmak için sağ üstteki "Kapat"ı kullanın.</Note>
        )}
        {st.state === 'mismatch' && (
          <Note kind="warn">İnternet hattı bant ölçüldüğünden beri değişti: yanlış bantla hat kısılmasın diye kuyruk takılmadı. Bandı yeniden ölçüp kaydedin, sonra deneyin.</Note>
        )}
        {(st.state === 'error' || st.state === 'waiting') && st.lastError && <Note kind="warn">{st.lastError}</Note>}
        {permanent && st.supported && st.state !== 'mismatch' && cfg && !editing && (
          <div className="sqm-summary">
            <span>{st.state === 'on' ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />} {st.state === 'on' ? `Kuyruk takılı (${st.line?.dev})` : 'Kuyruk açık, şu an takılı değil'}: ↓ {mbpsText(cfg.downKbit)} Mbps · ↑ {mbpsText(cfg.upKbit)} Mbps · {OVERHEAD_LABEL[cfg.overhead].replace(' (önerilen)', '')}{cfg.overheadBytes != null ? ` (+${cfg.overheadBytes} bayt)` : ''}</span>
            <button className="btn-outline btn-sm" onClick={() => { setEditing(true); setAck(true); }} disabled={busyAny}>Bandı değiştir</button>
          </div>
        )}
        {onBackup && st.supported && <Note kind="info">{BACKUP_TEXT}</Note>}
        {st.warnings.length > 0 && st.supported && (
          <ul className="sqm-warn-list">{st.warnings.map(w => <li key={w}><AlertTriangle size={12} /> <span>{w}</span></li>)}</ul>
        )}
      </Panel>

      {showWizard && (
        <section className="dhcp-wizard sqm-wizard" aria-labelledby="sqm-wiz-title">
          <div className="sqm-wizard-head">
            <div id="sqm-wiz-title" className="dhcp-wizard-title">{editing ? 'Bandı değiştir' : 'Akıllı kuyruğu aç'}</div>
            {editing && <button className="btn-outline btn-sm" onClick={() => { setEditing(false); setDraft(null); }} disabled={busyAny}>Vazgeç</button>}
          </div>

          <Step n={1} title="Hat ve ön koşullar" state={step1Done ? 'done' : 'active'}>
            <ul className="sqm-checks">
              <li className={st.tc ? 'is-ok' : 'is-bad'}>{st.tc ? <Check size={12} /> : <AlertTriangle size={12} />} tc (iproute2): {st.tc ? 'var' : 'yok'}</li>
              <li className={st.missingModules.length ? 'is-bad' : 'is-ok'}>{st.missingModules.length ? <AlertTriangle size={12} /> : <Check size={12} />} Çekirdek modülleri: {st.missingModules.length ? `eksik — ${st.missingModules.join(', ')}` : 'hazır (sch_cake, ifb, act_mirred, cls_matchall, sch_ingress)'}</li>
            </ul>
            <p className="sqm-help">Kuyruk yalnız internet arayüzüne ({st.line?.dev}) takılır; ev ağı kartına, Pi ile ev cihazları arasındaki trafiğe (panel, paylaşım, DNS) dokunmaz. Cihaz hız sınırları ve kotalar (Kota ve Hız) aynen çalışır.</p>
            {!step1Done && (
              <div className="sqm-actions">
                <button className="btn-primary btn-sm" onClick={() => setAck(true)} disabled={!st.ready}>Devam</button>
                {!st.ready && <Locked text="Önce eksik bileşen giderilmeli" />}
              </div>
            )}
          </Step>

          <Step n={2} title="Bant (hattın gerçek hızının biraz altı)" state={!step1Done ? 'todo' : step2Done && !editing ? 'done' : 'active'}>
            {!step1Done ? <Locked text="1. adımdan sonra" /> : (
              <>
                <p className="sqm-help">Bant hattın gerçek hızının biraz altında olmalı (önerilen %{st.defaults.suggestPct}): kuyruk modemde değil Pi'de oluşsun. Elle girerken hız testindeki değerin %90–95'i iyi bir başlangıçtır; "Ölç" paket başlıklarını da hesaba katarak önerir.</p>
                <div className="sqm-grid">
                  <div className="form-group">
                    <label htmlFor="sqm-down">İndirme (Mbps)</label>
                    <input id="sqm-down" className="config-input" inputMode="decimal" value={form.down} placeholder="ör. 90"
                      onChange={e => setField({ down: e.target.value })} disabled={busyAny} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="sqm-up">Yükleme (Mbps)</label>
                    <input id="sqm-up" className="config-input" inputMode="decimal" value={form.up} placeholder="ör. 18"
                      onChange={e => setField({ up: e.target.value })} disabled={busyAny} />
                  </div>
                  <div className="form-group sqm-wide">
                    <label>Bağlantı türü (paket başına ek yük)</label>
                    <Select className="config-select" value={form.overhead} onChange={e => setField({ overhead: e.target.value as Overhead })} disabled={busyAny}>
                      {(Object.keys(OVERHEAD_LABEL) as Overhead[]).map(o => <option key={o} value={o}>{OVERHEAD_LABEL[o]}{oh(o)}</option>)}
                    </Select>
                  </div>
                </div>
                {(form.down !== '' || form.up !== '') && !formOk && (
                  <Note kind="warn">İndirme ve yükleme 0,064 – 10000 Mbps arasında olmalı.</Note>
                )}
                <div className="sqm-measure">
                  <button className="btn-outline btn-sm" onClick={measure} disabled={busyAny || onBackup}>
                    {busy === 'cal' ? <><Loader2 size={13} className="spin" /> Ölçülüyor ({elapsed} sn)…</> : <><Play size={13} /> Ölç (~1 dk)</>}
                  </button>
                  <span className="sqm-muted">{onBackup ? BACKUP_TEXT : `Ookla hız testi. ${st.enabled ? 'Ölçüm boyunca kuyruk geçici olarak kaldırılır: evde 30–60 sn gecikme artabilir.' : 'Hat ölçüm boyunca dolar: evde 30–60 sn gecikme artabilir.'}`}</span>
                </div>
                {cal && sug && (
                  <div className="sqm-result">
                    <span>Ölçülen: ↓ <strong>{cal.result.download_mbps.toFixed(1)}</strong> Mbps · ↑ <strong>{cal.result.upload_mbps.toFixed(1)}</strong> Mbps · boşta ping {cal.result.ping_ms.toFixed(0)} ms
                      {cal.result.loaded_ms != null && <> · yük altında <strong>{cal.result.loaded_ms.toFixed(0)} ms</strong></>}</span>
                    <button className="btn-outline btn-sm" onClick={useSuggestion} disabled={busyAny}
                      title="Hız testi yalnız veriyi sayar, kuyruk paket başlıklarını da: öneri seçili bağlantı türüne göre hattın gerçek hızının bu kadarı">
                      Hattın %{sug.pct}'ını kullan (↓ {mbpsText(sug.downKbit)} · ↑ {mbpsText(sug.upKbit)})
                    </button>
                  </div>
                )}
                {editing && <p className="sqm-help">Kaydedince yeni bantla 5 dk'lık deneme yeniden başlar; "Kalıcı yap"a basılmazsa kuyruk kalkar.</p>}
                <div className="sqm-actions">
                  <button className="btn-primary btn-sm btn-on" onClick={save} disabled={busyAny || !formOk || (!dirty && savedOk)}>
                    {busy === 'save' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Kaydet
                  </button>
                  {savedOk && !dirty && <span className="sqm-muted">Kayıtlı: ↓ {mbpsText(cfg!.downKbit)} · ↑ {mbpsText(cfg!.upKbit)} Mbps</span>}
                </div>
              </>
            )}
          </Step>

          {!editing && (
            <Step n={3} title="Dene (5 dk)" state={!step2Done ? 'todo' : inTrial ? 'done' : 'active'}>
              {!step2Done ? <Locked text="Bant kaydedilince" /> : inTrial ? <span>Deneme sürüyor.</span> : (
                <>
                  <p className="sqm-help">Kuyruk takılır. 5 dk içinde "Kalıcı yap"a basılmazsa kendiliğinden kalkar — panel kapansa ya da Pi'ye ulaşılamasa da (Pi'deki zamanlayıcı).</p>
                  <div className="sqm-actions">
                    <button className="btn-primary btn-sm btn-on" onClick={startTrial} disabled={busyAny || onBackup}>
                      {busy === 'trial' ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Dene (5 dk)
                    </button>
                    {onBackup && <Locked text="Ana hatta dönünce" />}
                  </div>
                </>
              )}
            </Step>
          )}

          {!editing && (
            <Step n={4} title="Kalıcı yap ya da geri al" state={inTrial ? 'active' : 'todo'}>
              {!inTrial ? <Locked text="Deneme başlayınca" /> : (
                <>
                  <p className="sqm-help sqm-countdown"><Timer size={13} /> Kalan süre: <strong>{mmss(trialLeft)}</strong> — internet ve görüntülü görüşme düzgünse kalıcı yapın.</p>
                  <div className="sqm-measure">
                    <button className="btn-outline btn-sm" onClick={shapedTest} disabled={busyAny}>
                      {busy === 'check' ? <><Loader2 size={13} className="spin" /> Ölçülüyor ({elapsed} sn)…</> : <><Gauge size={13} /> Kuyrukla hız testi</>}
                    </button>
                    <span className="sqm-muted">İsteğe bağlı: kuyruk açıkken hız ve yük altı gecikme (kayıt "kısılmış" işaretlenir).</span>
                  </div>
                  {check && cfg && (
                    <div className="sqm-result">
                      <span>↓ <strong>{check.download_mbps.toFixed(1)}</strong> Mbps (beklenenin %{ofExpected(check.download_mbps, cfg.downKbit)}'ı) · ↑ <strong>{check.upload_mbps.toFixed(1)}</strong> Mbps (%{ofExpected(check.upload_mbps, cfg.upKbit)})
                        {check.loaded_ms != null && <> · yük altında <strong>{check.loaded_ms.toFixed(0)} ms</strong></>}</span>
                    </div>
                  )}
                  {check && cfg && (ofExpected(check.download_mbps, cfg.downKbit) < 85 || ofExpected(check.upload_mbps, cfg.upKbit) < 85) && (
                    <Note kind="warn">Verim beklenenin %85'inin altında: Pi'nin işlemcisi bu hızda yetmiyor olabilir ya da hat şu an yavaş. Bandı düşürün ya da geri alın.</Note>
                  )}
                  {st.state !== 'trial' && (
                    <Note kind="warn">Kuyruk şu an takılı değil{st.state === 'waiting' ? ' — internet arayüzü bekleniyor' : ''}: takılınca onaylayın. Süre dolarsa kendiliğinden kalkar.</Note>
                  )}
                  <div className="sqm-actions">
                    <button className="btn-primary btn-sm btn-on" onClick={confirm} disabled={busyAny || st.state !== 'trial'}>
                      {busy === 'confirm' ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} Kalıcı yap
                    </button>
                    <button className="btn-outline btn-sm btn-off" onClick={rollback} disabled={busyAny}>
                      {busy === 'rollback' ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} Geri al
                    </button>
                  </div>
                  <span className="sqm-muted">"Kalıcı yap" ev ağındaki bir cihazdan (PC / telefon) kabul edilir; Pi'nin kendi ekranından değil.</span>
                </>
              )}
            </Step>
          )}
        </section>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ClipboardPaste, Copy, Info, KeyRound, Loader2, Lock, Pencil, Plus, RefreshCw, Trash2, Undo2, Waypoints } from 'lucide-react';
import { getApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { toast } from '../toast';
import { copyText } from '../clipboard';
import { Panel, Badge, Select, SelectOption } from './ui';
import './SdwanPanel.css';

// Altyapı → SD-WAN (backend sdwan.ts, /api/sdwan): şubelerin ağlarını WireGuard ile birbirine bağlar (merkez + şubeler).
// Merkez bu Klyrix (UDP 51821) ya da kullanıcının VPS'i; şube daveti ve kabul yanıtı kopyala-yapıştırla taşınır. Uzak
// şubeden bu ağa erişim varsayılan kapalı, izin listesiyle açılır. Rotalar ilk eklenince 5 dk deneme + "Kalıcı yap".
// Ayrı parça (React.lazy): ana paket büyümesin.

type State = 'up' | 'connecting' | 'stale' | 'down' | 'unknown';
interface Health { state: State; handshakeAge: number | null; endpoint: string; rx: number; tx: number; rttMs: number | null }
interface Site { id: number; name: string; ip: string; nets: string[]; peer: boolean; endpoint: string; hub: boolean; health: Health | null }
interface Rule { id?: string; from: string; to: string; proto: 'tcp' | 'udp' | 'icmp' | 'any'; port: number | null }
interface Pending { id: string; ip: string; name: string; exp: number }
interface Status {
  supported: boolean; configured: boolean; corrupt?: boolean;
  role?: 'hub' | 'spoke'; hubKind?: 'klyrix' | 'vps' | null; name?: string; overlay?: string; ip?: string; hubIp?: string; nets?: string[];
  endpoint?: string; port?: number | null; vps?: { id: number; label: string } | null; publicKey?: string; running?: boolean;
  unitEnabled?: boolean; ipForward?: boolean | null; trial?: { stage: 'none' | 'trial' | 'on' | 'rolledback'; until: number; at: number };
  now?: number; sites?: Site[]; pending?: Pending[]; allow?: Rule[]; reply?: string;
  blocked?: { net: string; local: string; label: string }[];
}
interface Suggest { nets: string[]; candidates: string[]; endpoint: string; endpointSource: string; overlay: string; vps: { id: number; location: string; ip: string }[] }
interface InvitePreview { name: string; ip: string; exp: number; hub: { name: string; endpoint: string; ip: string }; sites: { name: string; ip: string; nets: string[] }[]; remote: string[]; suggest: string[] }

const errMsg = (e: unknown, d: string) => (e instanceof Error ? e.message : d);
const STATE: Record<State, { text: string; v: 'success' | 'info' | 'warning' | 'error' | 'neutral' }> = {
  up: { text: 'Bağlı', v: 'success' }, connecting: { text: 'Bağlanıyor', v: 'info' }, stale: { text: 'Yanıt yok', v: 'warning' },
  down: { text: 'Kapalı', v: 'error' }, unknown: { text: '—', v: 'neutral' },
};
const ago = (s: number | null) => (s === null ? 'hiç' : s < 60 ? `${s} sn önce` : s < 3600 ? `${Math.floor(s / 60)} dk önce` : `${Math.floor(s / 3600)} sa önce`);
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const NAME_RE = /^[\p{L}\p{N} ._-]{1,40}$/u;
const splitNets = (s: string) => s.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
const PROTO_TEXT: Record<Rule['proto'], string> = { tcp: 'TCP', udp: 'UDP', icmp: 'Ping', any: 'Tümü' };

function CopyBox({ text, label }: { text: string; label: string }) {
  const copy = async () => {
    if (await copyText(text)) toast.success(`${label} kopyalandı`);
    else toast.error('Kopyalanamadı — metni seçip elle kopyalayın');
  };
  return (
    <div className="sdw-copy">
      <textarea className="config-input sdw-text" readOnly value={text} rows={3} aria-label={label} onFocus={e => e.currentTarget.select()} />
      <button className="btn-outline btn-sm" onClick={() => { void copy(); }}><Copy size={13} /> Kopyala</button>
    </div>
  );
}

export function SdwanPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [recvAt, setRecvAt] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const load = useCallback(async () => {
    try {
      setSt(await getApi<Status>('/sdwan'));
      setRecvAt(Date.now());
      setErr('');
    } catch (e) {
      setErr(errMsg(e, 'Durum okunamadı'));
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, 10000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load]);
  const inTrial = st?.trial?.stage === 'trial';
  useEffect(() => {
    if (!inTrial) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [inTrial]);
  const serverNow = st?.now ? st.now + Math.max(0, (nowMs || recvAt) - recvAt) / 1000 : 0;

  const body = () => {
    if (err === 'HTTP 409') return <p className="sdw-note"><Info size={15} /><span>Bu cihaz mesh uydusu — SD-WAN ana cihazdadır.</span></p>;
    if (!st) {
      return err
        ? <p className="sdw-note sdw-note-bad"><AlertTriangle size={15} /><span>Durum okunamadı ({err}).</span></p>
        : <div className="sdw-loading"><Loader2 size={20} className="spin" /></div>;
    }
    if (!st.supported) return <p className="sdw-note"><Info size={15} /><span>SD-WAN yalnız Pi üzerinde çalışır.</span></p>;
    if (!st.configured) return <Setup onDone={load} />;
    if (st.corrupt) {
      return (
        <>
          <p className="sdw-note sdw-note-bad"><AlertTriangle size={15} /><span>SD-WAN ayarları okunamadı (/etc/pi5-gateway/sdwan). Kaldırıp yeniden kurun.</span></p>
          <Danger st={st} onDone={load} />
        </>
      );
    }
    return <NodeView st={st} serverNow={serverNow} reload={load} />;
  };

  return (
    <div className="sdw">
      <Panel title="Şubeler Arası SD-WAN" icon={<Waypoints size={18} style={{ marginRight: 8 }} />}
        subtitle="Şubelerin ev / ofis ağlarını WireGuard ile birbirine bağlar: bir merkez (bu Klyrix ya da VPS'iniz) ve ona bağlanan şubeler.">
        {body()}
      </Panel>
    </div>
  );
}

// ─── Kurulum: merkez ya da şube ───
function Setup({ onDone }: { onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'' | 'hub' | 'join'>('');
  return (
    <div className="sdw-setup">
      {!mode && (
        <>
          <div className="sdw-choices">
            <button className="sdw-choice" onClick={() => setMode('hub')}>
              <strong>Merkez kur</strong>
              <span>Bu cihaz ya da VPS'iniz şubelerin bağlandığı merkez olur. Şubeleri davet metniyle eklersiniz.</span>
            </button>
            <button className="sdw-choice" onClick={() => setMode('join')}>
              <strong>Bir merkeze katıl</strong>
              <span>Merkezin panelinde oluşturulan davet metnini yapıştırın; bu cihaz şube olur (CGNAT arkasında da çalışır).</span>
            </button>
          </div>
          <p className="sdw-note sdw-scope">
            <Info size={15} />
            <span>
              Her şubenin ev ağı farklı bir alt ağda olmalı (ör. merkez 192.168.10.0/24, şube 192.168.20.0/24): çakışan alt ağ reddedilir,
              şubeler arasında adres çevirisi yapılmaz. Uzak şubeler bu ağa varsayılan olarak hiçbir yeni bağlantı açamaz; izin listesiyle açarsınız.
            </span>
          </p>
        </>
      )}
      {mode === 'hub' && <HubWizard onCancel={() => setMode('')} onDone={onDone} />}
      {mode === 'join' && <JoinWizard onCancel={() => setMode('')} onDone={onDone} />}
    </div>
  );
}

// Sihirbaz adımı: sıradaki adım parlak, bitenler işaretli; kilitli adım soluk başlık + "Önce N. adım: …" (titles: tüm adım başlıkları)
function Step({ n, title, at, titles, children }: { n: number; title: string; at: number; titles: string[]; children: ReactNode }) {
  const cls = at === n ? 'sdw-step sdw-step-now' : at > n ? 'sdw-step sdw-step-done' : 'sdw-step sdw-step-later';
  return (
    <section className={cls} aria-current={at === n ? 'step' : undefined}>
      <h4><span className="sdw-num">{at > n ? <Check size={12} /> : n}</span> {title}</h4>
      {at >= n ? children : <p className="sdw-lock"><Lock size={12} /> Önce {at}. adım: {titles[at - 1]}</p>}
    </section>
  );
}

function HubWizard({ onCancel, onDone }: { onCancel: () => void; onDone: () => Promise<void> }) {
  const [at, setAt] = useState(1);
  const [kind, setKind] = useState<'klyrix' | 'vps' | ''>('');
  const steps = ['Merkez türü', 'Bu şube', kind === 'vps' ? 'VPS' : 'Merkezin dış adresi', 'Kur'];
  const [sg, setSg] = useState<Suggest | null>(null);
  const [name, setName] = useState('Merkez');
  const [nets, setNets] = useState('');
  const [overlay, setOverlay] = useState('10.88.0.0/24');
  const [endpoint, setEndpoint] = useState('');
  const [vpsId, setVpsId] = useState('');
  const [busy, setBusy] = useState(false);
  // Adımın sunucu doğrulaması (POST /sdwan/hub/check) hatası: adımın içinde gösterilir, adım değişmez
  const [stepErr, setStepErr] = useState('');
  useEffect(() => {
    let live = true;
    getApi<Suggest>('/sdwan/suggest').then(s => {
      if (!live) return;
      setSg(s);
      setNets(n => n || s.nets.join(', '));
      setEndpoint(e => e || s.endpoint);
      if (s.overlay) setOverlay(s.overlay);
    }, () => { if (live) setSg({ nets: [], candidates: [], endpoint: '', endpointSource: 'none', overlay: '10.88.0.0/24', vps: [] }); });
    return () => { live = false; };
  }, []);
  const okName = NAME_RE.test(name.trim());
  const okNets = splitNets(nets).length > 0;
  const okWhere = kind === 'klyrix' ? endpoint.trim().length > 0 : !!vpsId;
  const vps = sg?.vps.find(v => String(v.id) === vpsId);
  const body = () => ({
    kind, name: name.trim(), nets: splitNets(nets), overlay: overlay.trim(),
    ...(kind === 'klyrix' ? { endpoint: endpoint.trim() } : { vpsId: Number(vpsId) }),
  });
  // "İleri": adım sunucuda kurulumla aynı denetimlerden geçer (alt ağ, overlay çakışması, port, VPS yoklaması)
  const next = async (step: 2 | 3) => {
    setBusy(true);
    setStepErr('');
    try {
      const r = await postApi('/sdwan/hub/check', { step, ...body() }) as { nets: string[]; overlay: string; endpoint: string };
      setNets(r.nets.join(', '));
      setOverlay(r.overlay);
      if (step === 3 && kind === 'klyrix' && r.endpoint) setEndpoint(r.endpoint);
      setAt(step + 1);
    } catch (e) {
      setStepErr(errMsg(e, 'Doğrulanamadı'));
    }
    setBusy(false);
  };
  const back = (n: number) => { setStepErr(''); setAt(n); };
  const create = async () => {
    setBusy(true);
    try {
      await postApi('/sdwan/hub', body());
      toast.success(kind === 'klyrix' ? 'Merkez kuruldu — şube davet edebilirsiniz' : 'VPS merkezi kuruldu — 5 dk içinde "Kalıcı yap"');
      await onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Merkez kurulamadı'));
    }
    setBusy(false);
  };
  const err = (n: number) => (at === n && stepErr ? <p className="sdw-help sdw-bad" role="alert">{stepErr}</p> : null);
  return (
    <div className="sdw-form">
      <Step n={1} title={steps[0]} at={at} titles={steps}>
        <div className="sdw-modes" role="radiogroup" aria-label="Merkez türü">
          <label className={`sdw-mode${kind === 'klyrix' ? ' sdw-mode-on' : ''}`}>
            <input type="radio" name="sdw-kind" checked={kind === 'klyrix'} onChange={() => setKind('klyrix')} disabled={at !== 1} />
            <span className="sdw-mode-title">Bu Klyrix</span>
            <span className="sdw-mode-desc">Şubeler bu cihaza bağlanır (UDP 51821). Modemde bu port Pi'ye yönlendirilmeli; operatör paylaşımlı IP (CGNAT) veriyorsa olmaz — VPS'i seçin.</span>
          </label>
          <label className={`sdw-mode${kind === 'vps' ? ' sdw-mode-on' : ''}`}>
            <input type="radio" name="sdw-kind" checked={kind === 'vps'} onChange={() => setKind('vps')} disabled={at !== 1} />
            <span className="sdw-mode-title">Kendi VPS'im</span>
            <span className="sdw-mode-desc">WireGuard sayfasında kurulu VPS'iniz merkez olur: wg0'dan ayrı wg_s2s arayüzü (UDP 51821) kurulur, mevcut tünellere dokunulmaz. Bu cihaz VPS'in ilk şubesi olur.</span>
          </label>
        </div>
        {at === 1 && (
          <div className="sdw-actions">
            <button className="btn-outline btn-sm" onClick={onCancel}>Vazgeç</button>
            <button className="btn-primary btn-sm" disabled={!kind} onClick={() => setAt(2)}>İleri</button>
          </div>
        )}
      </Step>
      <Step n={2} title={steps[1]} at={at} titles={steps}>
        <div className="sdw-grid">
          <label className="sdw-field"><span>Şube adı</span>
            <input className="config-input" value={name} maxLength={40} onChange={e => { setName(e.target.value); setStepErr(''); }} disabled={at !== 2} />
          </label>
          <label className="sdw-field"><span>Bu şubenin alt ağları</span>
            <input className="config-input" value={nets} placeholder="192.168.10.0/24" onChange={e => { setNets(e.target.value); setStepErr(''); }} disabled={at !== 2} />
          </label>
        </div>
        {sg && sg.candidates.length > 0 && <p className="sdw-help">Bu cihazın ev ağı: {sg.candidates.join(', ')} — yalnız bunların içindeki ağlar duyurulabilir.</p>}
        <details className="sdw-adv">
          <summary>Gelişmiş: tünel içi ağ (overlay)</summary>
          <label className="sdw-field"><span>Overlay /24</span>
            <input className="config-input" value={overlay} onChange={e => { setOverlay(e.target.value); setStepErr(''); }} disabled={at !== 2} />
          </label>
        </details>
        {at === 2 && !okName && <p className="sdw-help sdw-bad">Ad 1-40 karakter: harf, rakam, boşluk, . _ -</p>}
        {err(2)}
        {at === 2 && (
          <div className="sdw-actions">
            <button className="btn-outline btn-sm" onClick={() => back(1)} disabled={busy}>Geri</button>
            <button className="btn-primary btn-sm" disabled={busy || !okName || !okNets} onClick={() => { void next(2); }}>
              {busy && <Loader2 size={14} className="spin" />} İleri
            </button>
          </div>
        )}
      </Step>
      <Step n={3} title={steps[2]} at={at} titles={steps}>
        {kind === 'klyrix' ? (
          <>
            <label className="sdw-field"><span>Şubelerin bağlanacağı adres (DDNS adı ya da dış IP)</span>
              <input className="config-input" value={endpoint} placeholder={`ornek.duckdns.org:51821`} onChange={e => { setEndpoint(e.target.value); setStepErr(''); }} disabled={at !== 3} />
            </label>
            <p className="sdw-help">Modeminizde UDP 51821'i bu Pi'ye yönlendirin. Dış IP değişebiliyorsa DDNS adı kullanın (DDNS sayfası); adres sonradan değiştirilebilir.</p>
          </>
        ) : (
          <>
            <label className="sdw-field"><span>Merkez olacak VPS</span>
              <Select className="config-input" columns={['text', 'mono']} value={vpsId} onChange={e => { setVpsId(e.target.value); setStepErr(''); }} disabled={at !== 3} aria-label="Merkez olacak VPS">
                <option value="">VPS seçin…</option>
                {(sg?.vps || []).map(v => <SelectOption key={v.id} value={String(v.id)} cols={[v.location || 'VPS', v.ip]} />)}
              </Select>
            </label>
            {sg && !sg.vps.length && <p className="sdw-help sdw-warn">SSH ile kurulmuş VPS yok — önce WireGuard sayfasından VPS ekleyin.</p>}
            {at === 3 && <p className="sdw-help">İleri'ye basınca VPS'e SSH ile bağlanılıp yoklanır (UDP 51821 boş mu, ağları çakışıyor mu); değişiklik yapılmaz.</p>}
          </>
        )}
        {err(3)}
        {at === 3 && (
          <div className="sdw-actions">
            <button className="btn-outline btn-sm" onClick={() => back(2)} disabled={busy}>Geri</button>
            <button className="btn-primary btn-sm" disabled={busy || !okWhere} onClick={() => { void next(3); }}>
              {busy && <Loader2 size={14} className="spin" />} İleri
            </button>
          </div>
        )}
      </Step>
      <Step n={4} title={steps[3]} at={at} titles={steps}>
        <ul className="sdw-summary">
          <li><span>Merkez</span><strong>{kind === 'vps' ? `VPS — ${vps ? `${vps.location || 'VPS'}, ${vps.ip}` : ''}` : `Bu Klyrix — ${endpoint}`}</strong></li>
          <li><span>Şube</span><strong>{name.trim()} · {splitNets(nets).join(', ')}</strong></li>
          <li><span>Overlay</span><strong>{overlay}</strong></li>
        </ul>
        {kind === 'vps' && <p className="sdw-help">Kurulunca bu cihaz VPS'e bağlanır ve 5 dakikalık deneme başlar: panel açık kaldıysa "Kalıcı yap"a basın.</p>}
        {kind === 'klyrix' && <p className="sdw-help">Merkez şimdilik yalnız kaydedilir; ilk şube eklenince tünel açılır ve 5 dakikalık deneme başlar.</p>}
        {at === 4 && (
          <div className="sdw-actions">
            <button className="btn-outline btn-sm" onClick={() => back(3)} disabled={busy}>Geri</button>
            <button className="btn-primary btn-sm btn-on" onClick={() => { void create(); }} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Merkezi kur
            </button>
          </div>
        )}
      </Step>
    </div>
  );
}

const JOIN_STEPS = ['Daveti yapıştırın', 'Bu şube'];
function JoinWizard({ onCancel, onDone }: { onCancel: () => void; onDone: () => Promise<void> }) {
  const [at, setAt] = useState(1);
  const [invite, setInvite] = useState('');
  const [pv, setPv] = useState<InvitePreview | null>(null);
  const [name, setName] = useState('');
  const [nets, setNets] = useState('');
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      const r = await postApi('/sdwan/join/check', { invite: invite.trim() }) as InvitePreview;
      setPv(r);
      setName(r.name);
      setNets(r.suggest.join(', '));
      setAt(2);
    } catch (e) {
      toast.error(errMsg(e, 'Davet doğrulanamadı'));
    }
    setBusy(false);
  };
  const join = async () => {
    setBusy(true);
    try {
      await postApi('/sdwan/join', { invite: invite.trim(), name: name.trim(), nets: splitNets(nets) });
      toast.success('Merkeze bağlanıldı — kabul yanıtını merkeze yapıştırın; 5 dk içinde "Kalıcı yap"');
      await onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Bağlanılamadı'));
    }
    setBusy(false);
  };
  return (
    <div className="sdw-form">
      <Step n={1} title={JOIN_STEPS[0]} at={at} titles={JOIN_STEPS}>
        <textarea className="config-input sdw-text" rows={3} value={invite} placeholder="klyrix-sdwan:davet:1:…" onChange={e => setInvite(e.target.value)} disabled={at !== 1} aria-label="Davet metni" />
        {at === 1 && (
          <div className="sdw-actions">
            <button className="btn-outline btn-sm" onClick={onCancel}>Vazgeç</button>
            <button className="btn-primary btn-sm" disabled={!invite.trim() || busy} onClick={() => { void check(); }}>
              {busy ? <Loader2 size={14} className="spin" /> : <ClipboardPaste size={14} />} Daveti doğrula
            </button>
          </div>
        )}
        {pv && (
          <ul className="sdw-summary">
            <li><span>Merkez</span><strong>{pv.hub.name} · {pv.hub.endpoint}</strong></li>
            <li><span>Bu şubenin adresi</span><strong>{pv.ip}</strong></li>
            <li><span>Uzak ağlar</span><strong>{pv.remote.join(', ')}</strong></li>
          </ul>
        )}
      </Step>
      <Step n={2} title={JOIN_STEPS[1]} at={at} titles={JOIN_STEPS}>
        <div className="sdw-grid">
          <label className="sdw-field"><span>Şube adı</span>
            <input className="config-input" value={name} maxLength={40} onChange={e => setName(e.target.value)} disabled={at !== 2} />
          </label>
          <label className="sdw-field"><span>Bu şubenin alt ağları</span>
            <input className="config-input" value={nets} placeholder="192.168.20.0/24" onChange={e => setNets(e.target.value)} disabled={at !== 2} />
          </label>
        </div>
        <p className="sdw-help">Bağlanınca 5 dakikalık deneme başlar: panel açık kaldıysa "Kalıcı yap"a basın; basılmazsa her şey kendiliğinden geri alınır.</p>
        {at === 2 && (
          <div className="sdw-actions">
            <button className="btn-outline btn-sm" onClick={() => setAt(1)} disabled={busy}>Geri</button>
            <button className="btn-primary btn-sm btn-on" disabled={busy || !NAME_RE.test(name.trim()) || !splitNets(nets).length} onClick={() => { void join(); }}>
              {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Şubeyi bağla
            </button>
          </div>
        )}
      </Step>
    </div>
  );
}

// ─── Kurulu düğüm ───
function NodeView({ st, serverNow, reload }: { st: Status; serverNow: number; reload: () => Promise<void> }) {
  const hub = st.role === 'hub';
  const sites = st.sites || [];
  const trial = st.trial?.stage || 'none';
  const hubSite = sites.find(s => s.hub);
  return (
    <>
      {trial === 'trial' && <TrialBar until={st.trial!.until} serverNow={serverNow} reload={reload} />}
      {trial === 'rolledback' && <RolledBack reload={reload} />}
      <div className="sdw-card">
        <div className="sdw-card-head">
          <Badge variant="info">{hub ? (st.hubKind === 'vps' ? 'Merkez (VPS)' : 'Merkez') : 'Şube'}</Badge>
          <strong>{st.name}</strong>
          {st.running ? <Badge variant="success">Tünel açık</Badge> : <Badge variant="neutral">Tünel kapalı</Badge>}
        </div>
        <ul className="sdw-summary">
          <li><span>Overlay adresi</span><strong>{st.ip} ({st.overlay})</strong></li>
          <li><span>Bu şubenin ağları</span><strong>{(st.nets || []).join(', ')}</strong></li>
          {hub && st.hubKind === 'klyrix' && <li><span>Merkez adresi</span><strong>{st.endpoint} (UDP {st.port})</strong></li>}
          {st.vps && <li><span>VPS</span><strong>{st.vps.label} · UDP 51821</strong></li>}
          {!hub && <li><span>Merkez</span><strong>{hubSite?.name || '—'} · {st.endpoint}</strong></li>}
          <li><span><KeyRound size={12} /> Açık anahtar</span><strong className="sdw-mono">{st.publicKey}</strong></li>
        </ul>
        {hub && st.hubKind === 'klyrix' && (
          <>
            <p className="sdw-help">Modemde UDP {st.port} bu Pi'ye yönlendirilmiş olmalı. Şubeler yalnız bu porta bağlanır; başka port açılmaz.</p>
            <EndpointEdit current={st.endpoint || ''} reload={reload} />
          </>
        )}
        {(st.blocked || []).length > 0 && (
          <div className="sdw-note sdw-note-bad" role="alert">
            <AlertTriangle size={15} />
            <span>
              {(st.blocked || []).map(b => `${b.net} (bu cihazın ${b.label} ağı ${b.local} ile)`).join(', ')}: uzak ağ bu cihazın bir ağıyla
              çakışıyor — o ağa giden SD-WAN yolu durduruldu, yerel ağ kesilmez. Ağlardan birini başka bir alt ağa taşıyın; çakışma kalkınca yol kendiliğinden döner.
            </span>
          </div>
        )}
        {st.ipForward === false && <p className="sdw-help sdw-warn">Pi'de IP iletimi kapalı (net.ipv4.ip_forward=0) — şubeler arası trafik geçmez.</p>}
        <p className="sdw-help">Ev ağındaki cihazların uzak şubelere gidebilmesi için ağ geçitleri bu Pi olmalı (Pi DHCP) ya da modemde uzak ağlar için Pi'ye rota tanımlanmalı.</p>
      </div>
      {!hub && st.reply && hubSite?.health?.state !== 'up' && (
        <div className="sdw-card">
          <h4 className="sdw-h"><ClipboardPaste size={15} /> Kabul yanıtı — merkezin paneline yapıştırın</h4>
          <CopyBox text={st.reply} label="Kabul yanıtı" />
          <p className="sdw-help">Merkez bu yanıtı ekleyince el sıkışma birkaç saniye içinde gelir ve şube "Bağlı" görünür.</p>
        </div>
      )}
      <Sites st={st} reload={reload} />
      {hub ? <InviteFlow st={st} reload={reload} /> : <UpdatePaste reload={reload} />}
      <AllowEditor st={st} reload={reload} />
      <Danger st={st} onDone={reload} />
    </>
  );
}

// Klyrix merkezin dış adresi (ör. DDNS'siz hatta IP değişti): kaydedilince şubelere güncelleme metni verilir.
function EndpointEdit({ current, reload }: { current: string; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [update, setUpdate] = useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await putApi('/sdwan/endpoint', { endpoint: value.trim() }) as { changed: boolean; update: string };
      if (r.changed) {
        toast.success('Merkez adresi değişti — şubelere güncelleme metnini verin; bekleyen davetleri yeniden oluşturun');
        setUpdate(r.update || '');
      } else {
        toast.info('Adres aynı');
      }
      setOpen(false);
      await reload();
    } catch (e) {
      setErr(errMsg(e, 'Kaydedilemedi'));
    }
    setBusy(false);
  };
  return (
    <div className="sdw-ep">
      {!open ? (
        <button className="btn-outline btn-sm" onClick={() => { setValue(current); setErr(''); setOpen(true); }}><Pencil size={13} /> Adresi değiştir</button>
      ) : (
        <>
          <div className="sdw-row">
            <input className="config-input" value={value} placeholder="ornek.duckdns.org:51821" onChange={e => { setValue(e.target.value); setErr(''); }} aria-label="Merkezin dış adresi" />
            <button className="btn-outline btn-sm" onClick={() => setOpen(false)} disabled={busy}>Vazgeç</button>
            <button className="btn-primary btn-sm btn-on" onClick={() => { void save(); }} disabled={busy || !value.trim()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Kaydet
            </button>
          </div>
          {err && <p className="sdw-help sdw-bad" role="alert">{err}</p>}
        </>
      )}
      {update && (
        <>
          <p className="sdw-help">Şubeler yeni adresi bu güncelleme metniyle öğrenir — her şubenin SD-WAN sayfasına yapıştırın:</p>
          <CopyBox text={update} label="Güncelleme metni" />
        </>
      )}
    </div>
  );
}

function TrialBar({ until, serverNow, reload }: { until: number; serverNow: number; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const left = Math.floor(until - serverNow);
  // Deneme hangi akıştan başlarsa başlasın (şube ekleme, VPS merkezi, katılma, yeniden dene) çubuk görünür olsun: kullanıcı
  // sayfanın aşağısındaki karttayken üstte kalıp gözden kaçmasın.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: 'center' }); }, []);
  const act = async (what: 'confirm' | 'rollback') => {
    if (what === 'rollback' && !confirm('SD-WAN şimdi geri alınsın mı? Tünel, rotalar ve kurallar kaldırılır; ayarlar kalır.')) return;
    setBusy(true);
    try {
      await postApi(`/sdwan/${what}`, {});
      toast.success(what === 'confirm' ? 'SD-WAN kalıcı yapıldı' : 'SD-WAN geri alındı');
    } catch (e) {
      toast.error(errMsg(e, 'İşlem yapılamadı'));
    }
    await reload();
    setBusy(false);
  };
  return (
    <div className="sdw-trial" role="status" ref={ref}>
      <AlertTriangle size={16} />
      <div>
        <strong>Deneme sürüyor — kalan {mmss(left)}</strong>
        <p>Panel ve ev ağı sorunsuzsa "Kalıcı yap"a basın. Basılmazsa SD-WAN kendiliğinden geri alınır (panel erişimi kesilse de).</p>
        <div className="sdw-actions">
          <button className="btn-primary btn-sm btn-on" disabled={busy} onClick={() => { void act('confirm'); }}><Check size={14} /> Kalıcı yap</button>
          <button className="btn-outline btn-sm btn-off" disabled={busy} onClick={() => { void act('rollback'); }}><Undo2 size={14} /> Geri al</button>
        </div>
      </div>
    </div>
  );
}

function RolledBack({ reload }: { reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await postApi('/sdwan/retry', {});
      toast.success('SD-WAN yeniden açıldı — 5 dk içinde "Kalıcı yap"');
    } catch (e) {
      toast.error(errMsg(e, 'Açılamadı'));
    }
    await reload();
    setBusy(false);
  };
  return (
    <div className="sdw-trial sdw-trial-off" role="status">
      <Undo2 size={16} />
      <div>
        <strong>SD-WAN geri alındı</strong>
        <p>Deneme "Kalıcı yap"sız bitti ya da geri alındı: tünel, rotalar ve kurallar kaldırıldı; ayarlar duruyor.</p>
        <div className="sdw-actions">
          <button className="btn-primary btn-sm btn-on" disabled={busy} onClick={() => { void retry(); }}><RefreshCw size={14} /> Yeniden dene</button>
        </div>
      </div>
    </div>
  );
}

function Sites({ st, reload }: { st: Status; reload: () => Promise<void> }) {
  const hub = st.role === 'hub';
  const [busy, setBusy] = useState(0);
  const remove = async (s: Site) => {
    if (!confirm(`"${s.name}" şubesi kaldırılsın mı? Tüneli kesilir, ağlarına giden rotalar kaldırılır.`)) return;
    setBusy(s.id);
    try {
      await deleteApi(`/sdwan/sites/${s.id}`);
      toast.success(`${s.name} kaldırıldı — diğer şubelere güncelleme metnini verin`);
    } catch (e) {
      toast.error(errMsg(e, 'Kaldırılamadı'));
    }
    await reload();
    setBusy(0);
  };
  const sites = st.sites || [];
  return (
    <div className="sdw-card">
      <h4 className="sdw-h">Şubeler</h4>
      {!sites.length ? (
        <p className="sdw-help">{hub ? 'Henüz şube yok — aşağıdan davet oluşturun.' : 'Merkez bilgisi yok.'}</p>
      ) : (
        <div className="sdw-table-wrap">
          <table className="sdw-table">
            <thead><tr><th>Ad</th><th>Overlay</th><th>Alt ağlar</th><th>Durum</th><th>El sıkışma</th><th>Gecikme</th>{hub && <th />}</tr></thead>
            <tbody>
              {sites.map(s => {
                const h = s.health;
                const stt = STATE[h?.state || 'unknown'];
                return (
                  <tr key={s.id}>
                    <td data-l="Ad"><strong>{s.name}</strong>{s.hub && <Badge variant="info" className="sdw-badge-gap">merkez</Badge>}</td>
                    <td data-l="Overlay" className="sdw-mono">{s.ip}</td>
                    <td data-l="Alt ağlar" className="sdw-mono">{s.nets.join(', ') || '—'}</td>
                    <td data-l="Durum"><Badge variant={stt.v}>{stt.text}</Badge></td>
                    <td data-l="El sıkışma">{s.peer ? ago(h?.handshakeAge ?? null) : 'merkez üzerinden'}</td>
                    <td data-l="Gecikme">{h?.rttMs != null ? `${h.rttMs} ms` : '—'}</td>
                    {hub && (
                      <td className="sdw-td-act">
                        {!(st.hubKind === 'vps' && s.peer) && (
                          <button className="btn-outline btn-sm btn-off" disabled={busy === s.id} onClick={() => { void remove(s); }} aria-label={`${s.name} şubesini kaldır`}>
                            <Trash2 size={13} /> Kaldır
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const INVITE_STEPS = ['Davet oluştur', 'Daveti şubeye verin, kabul yanıtını buraya yapıştırın'];
function InviteFlow({ st, reload }: { st: Status; reload: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [inv, setInv] = useState<{ invite: string; id: string; ip: string; exp: number } | null>(null);
  const [resp, setResp] = useState('');
  const [update, setUpdate] = useState('');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      setInv(await postApi('/sdwan/invite', { name: name.trim() }));
      setUpdate('');
      await reload();
    } catch (e) {
      toast.error(errMsg(e, 'Davet oluşturulamadı'));
    }
    setBusy(false);
  };
  const accept = async () => {
    setBusy(true);
    try {
      const r = await postApi('/sdwan/accept', { response: resp.trim() }) as { update: string; others: number; warning?: string; status?: Status };
      // İlk şube bu Klyrix merkezde tüneli açar ve 5 dk'lık denemeyi başlatır: bildirim bunu söyler (çubuk görünür kaydırılır)
      if (st.trial?.stage !== 'trial' && r.status?.trial?.stage === 'trial') toast.success('Şube eklendi — deneme başladı: 5 dk içinde yukarıdaki "Kalıcı yap"a basın, yoksa geri alınır');
      else toast.success('Şube eklendi');
      if (r.warning) toast.info(r.warning);
      setInv(null);
      setResp('');
      setName('');
      setUpdate(r.others > 0 ? r.update : '');
    } catch (e) {
      toast.error(errMsg(e, 'Şube eklenemedi'));
    }
    await reload();
    setBusy(false);
  };
  const cancelInvite = async (p: Pending) => {
    try {
      await deleteApi(`/sdwan/invite/${p.id}`);
      if (inv?.id === p.id) setInv(null);
    } catch (e) {
      toast.error(errMsg(e, 'Silinemedi'));
    }
    await reload();
  };
  const fetchUpdate = async () => {
    try {
      setUpdate((await getApi<{ text: string }>('/sdwan/update-text')).text);
    } catch (e) {
      toast.error(errMsg(e, 'Alınamadı'));
    }
  };
  const at = inv ? 2 : 1;
  return (
    <div className="sdw-card">
      <h4 className="sdw-h"><Plus size={15} /> Şube ekle</h4>
      <div className="sdw-form">
        <Step n={1} title={INVITE_STEPS[0]} at={at} titles={INVITE_STEPS}>
          <div className="sdw-row">
            <input className="config-input" value={name} maxLength={40} placeholder="Şube adı (ör. Kadıköy)" onChange={e => setName(e.target.value)} disabled={at !== 1} aria-label="Şube adı" />
            {at === 1 && (
              <button className="btn-primary btn-sm btn-on" disabled={busy || !NAME_RE.test(name.trim())} onClick={() => { void make(); }}>
                {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Davet oluştur
              </button>
            )}
          </div>
        </Step>
        <Step n={2} title={INVITE_STEPS[1]} at={at} titles={INVITE_STEPS}>
          {inv && (
            <>
              {inv.invite
                ? <CopyBox text={inv.invite} label="Davet" />
                : <p className="sdw-help">Davet metni yalnız oluşturulurken gösterilir; şube elindeki daveti kullandıysa kabul yanıtını aşağıya yapıştırın.</p>}
              <p className="sdw-help">
                Tek kullanımlık; 24 saat geçerli. Şubenin adresi: {inv.ip}. Davette gizli anahtar yoktur.
                {st.hubKind === 'klyrix' && !st.running && st.trial?.stage !== 'on' && ' İlk şube eklenince tünel açılır ve 5 dakikalık deneme başlar: "Kalıcı yap"a basmayı unutmayın.'}
              </p>
              <textarea className="config-input sdw-text" rows={3} value={resp} placeholder="klyrix-sdwan:kabul:1:…" onChange={e => setResp(e.target.value)} aria-label="Kabul yanıtı" />
              <div className="sdw-actions">
                <button className="btn-outline btn-sm" onClick={() => setInv(null)} disabled={busy}>Sonra</button>
                <button className="btn-primary btn-sm btn-on" disabled={busy || !resp.trim()} onClick={() => { void accept(); }}>
                  {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Şubeyi ekle
                </button>
              </div>
            </>
          )}
        </Step>
      </div>
      {(st.pending || []).length > 0 && (
        <div className="sdw-pending">
          <span className="sdw-help">Bekleyen davetler:</span>
          {(st.pending || []).map(p => (
            <span key={p.id} className="sdw-chip">
              {p.name} · {p.ip}
              {inv?.id !== p.id && <button className="sdw-chip-x" onClick={() => setInv({ invite: '', id: p.id, ip: p.ip, exp: p.exp })} title="Kabul yanıtını yapıştır">yanıt</button>}
              <button className="sdw-chip-x sdw-chip-del" onClick={() => { void cancelInvite(p); }} aria-label={`${p.name} davetini sil`}><Trash2 size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="sdw-update">
        {update ? (
          <>
            <h4 className="sdw-h">Diğer şubelere güncelleme metni</h4>
            <CopyBox text={update} label="Güncelleme metni" />
            <p className="sdw-help">Yeni ya da kaldırılan şubenin ağlarını diğer şubeler bu metinle öğrenir: her şubenin SD-WAN sayfasına yapıştırın.</p>
          </>
        ) : (
          <button className="btn-outline btn-sm" onClick={() => { void fetchUpdate(); }}><RefreshCw size={13} /> Şubeler için güncelleme metni</button>
        )}
      </div>
    </div>
  );
}

function UpdatePaste({ reload }: { reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      await postApi('/sdwan/update', { text: text.trim() });
      toast.success('Üye listesi güncellendi');
      setText('');
    } catch (e) {
      toast.error(errMsg(e, 'Uygulanamadı'));
    }
    await reload();
    setBusy(false);
  };
  return (
    <div className="sdw-card">
      <h4 className="sdw-h"><RefreshCw size={15} /> Merkezden güncelleme</h4>
      <p className="sdw-help">Merkeze yeni şube eklenince ya da şube kaldırılınca merkezin verdiği güncelleme metnini buraya yapıştırın.</p>
      <textarea className="config-input sdw-text" rows={2} value={text} placeholder="klyrix-sdwan:guncelleme:1:…" onChange={e => setText(e.target.value)} aria-label="Güncelleme metni" />
      <div className="sdw-actions">
        <button className="btn-primary btn-sm btn-on" disabled={busy || !text.trim()} onClick={() => { void apply(); }}>
          {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Güncellemeyi uygula
        </button>
      </div>
    </div>
  );
}

function AllowEditor({ st, reload }: { st: Status; reload: () => Promise<void> }) {
  const saved = st.allow || [];
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const list = rules ?? saved;
  const dirty = rules !== null;
  const remoteNets = [...new Set((st.sites || []).flatMap(s => s.nets))];
  const own = st.nets || [];
  const set = (i: number, patch: Partial<Rule>) => setRules(list.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const add = () => setRules([...list, { from: 'any', to: own[0] || 'pi', proto: 'tcp', port: null }]);
  const save = async () => {
    setBusy(true);
    try {
      await putApi('/sdwan/allow', { rules: list });
      toast.success('İzin listesi uygulandı');
      setRules(null);
    } catch (e) {
      toast.error(errMsg(e, 'Uygulanamadı'));
    }
    await reload();
    setBusy(false);
  };
  const opt = (v: string, known: string[]) => (known.includes(v) ? v : '__custom');
  return (
    <div className="sdw-card">
      <h4 className="sdw-h">Bu şubeye erişim izinleri</h4>
      <p className="sdw-help">
        Varsayılan: uzak şubeler bu ağdaki cihazlara ve bu Pi'nin hizmetlerine (panel, DNS, ağ paylaşımı, SSH) yeni bağlantı açamaz;
        yalnız Pi'ye ping atabilir. Bu şubeden uzak şubelere giden bağlantılar her zaman açıktır; karşı şube kendi listesiyle izin verir.
        Ev VPN'i istemcileri uzak şubelere ulaşamaz.
      </p>
      {list.length > 0 && (
        <div className="sdw-rules">
          {list.map((r, i) => (
            <div className="sdw-rule" key={r.id || `n${i}`}>
              <label className="sdw-field"><span>Kaynak</span>
                <select className="config-input" value={r.from === 'any' ? 'any' : opt(r.from, remoteNets)} onChange={e => set(i, { from: e.target.value === '__custom' ? '' : e.target.value })}>
                  <option value="any">Tüm şubeler</option>
                  {remoteNets.map(n => <option key={n} value={n}>{n}</option>)}
                  <option value="__custom">Adres / ağ…</option>
                </select>
                {r.from !== 'any' && !remoteNets.includes(r.from) && (
                  <input className="config-input" value={r.from} placeholder="192.168.20.5" onChange={e => set(i, { from: e.target.value })} aria-label="Kaynak adres" />
                )}
              </label>
              <label className="sdw-field"><span>Hedef</span>
                <select className="config-input" value={r.to === 'pi' ? 'pi' : opt(r.to, own)} onChange={e => set(i, { to: e.target.value === '__custom' ? '' : e.target.value })}>
                  <option value="pi">Bu Pi (hizmetleri)</option>
                  {own.map(n => <option key={n} value={n}>{n}</option>)}
                  <option value="__custom">Tek cihaz…</option>
                </select>
                {r.to !== 'pi' && !own.includes(r.to) && (
                  <input className="config-input" value={r.to} placeholder="192.168.10.20" onChange={e => set(i, { to: e.target.value })} aria-label="Hedef adres" />
                )}
              </label>
              <label className="sdw-field sdw-field-s"><span>Protokol</span>
                <select className="config-input" value={r.proto} onChange={e => { const proto = e.target.value as Rule['proto']; set(i, { proto, port: proto === 'icmp' ? null : r.port }); }}>
                  {(Object.keys(PROTO_TEXT) as Rule['proto'][]).map(p => <option key={p} value={p}>{PROTO_TEXT[p]}</option>)}
                </select>
              </label>
              <label className="sdw-field sdw-field-s"><span>Port</span>
                <input className="config-input" inputMode="numeric" value={r.port ?? ''} disabled={r.proto === 'icmp'} placeholder={r.proto === 'icmp' ? '—' : r.proto === 'any' ? 'tümü' : '443'}
                  onChange={e => set(i, { port: e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')) || null })} />
              </label>
              <button className="btn-outline btn-sm btn-off sdw-rule-del" onClick={() => setRules(list.filter((_, k) => k !== i))} aria-label="Kuralı sil"><Trash2 size={13} /></button>
              {r.to !== 'pi' && <p className="sdw-help sdw-rule-note">Alt ağ / cihaz hedefi bu Pi'nin kendi hizmetlerini kapsamaz — panel, DNS, SSH, ağ paylaşımı için Hedef: "Bu Pi (hizmetleri)".</p>}
            </div>
          ))}
        </div>
      )}
      <div className="sdw-actions">
        <button className="btn-outline btn-sm" onClick={add}><Plus size={13} /> Kural ekle</button>
        {dirty && <button className="btn-outline btn-sm" onClick={() => setRules(null)} disabled={busy}>Vazgeç</button>}
        {dirty && (
          <button className="btn-primary btn-sm btn-on" onClick={() => { void save(); }} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Uygula
          </button>
        )}
      </div>
    </div>
  );
}

function Danger({ st, onDone }: { st: Status; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const hub = st.role === 'hub';
  const remove = async () => {
    const q = st.corrupt
      ? "Bozuk SD-WAN ayarları ve bu cihazdaki tünel, rotalar ve kurallar silinsin mi? Merkez bir VPS idiyse VPS'teki wg_s2s'e dokunulmaz — gerekirse VPS'te: systemctl disable --now wg-quick@wg_s2s"
      : hub
        ? `SD-WAN kaldırılsın mı? Tüm şubelerin tüneli kesilir${st.hubKind === 'vps' ? ", VPS'teki wg_s2s de kaldırılır (wg0'a dokunulmaz)" : ''}; ayarlar silinir.`
        : 'Merkezden ayrılınsın mı? Tünel, rotalar ve ayarlar silinir. Merkezde de bu şubeyi kaldırın.';
    if (!confirm(q)) return;
    setBusy(true);
    try {
      const r = await deleteApi('/sdwan') as { warning?: string };
      toast.success('SD-WAN kaldırıldı');
      if (r.warning) toast.info(r.warning);
    } catch (e) {
      toast.error(errMsg(e, 'Kaldırılamadı'));
    }
    await onDone();
    setBusy(false);
  };
  return (
    <div className="sdw-actions sdw-danger">
      <button className="btn-outline btn-sm btn-off" onClick={() => { void remove(); }} disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} {hub || st.corrupt ? "SD-WAN'ı kaldır" : 'Merkezden ayrıl'}
      </button>
    </div>
  );
}

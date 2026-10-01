import { useEffect, useMemo, useState } from 'react';
import {
  Cloud, CloudUpload, KeyRound, Loader2, CheckCircle2, XCircle, Copy, Download, FolderPlus, Trash2, AlertTriangle,
  Unplug, Clock, ShieldCheck, History, Info, Satellite,
} from 'lucide-react';
import { postApi, useApi } from '../hooks/useApi';
import { Modal, Panel, Select } from './ui';
import { toast } from '../toast';
import './CloudBackupPanel.css';

// Bulut Yedeği (backend vault.ts → scripts/vault.sh, restic): panel ayarları ve isteğe bağlı klasörler kullanıcının KENDİ
// S3 uyumlu kovasına (Cloudflare R2, Backblaze B2, AWS S3, MinIO / özel) istemci tarafında şifrelenerek yüklenir.
// Klyrix hiçbir hesabı ve anahtarı görmez. Parola cihazda saklanmaz; kurtarma için kurtarma kiti + parola gerekir.
// Bağlanma ve yedek işleri panel servisinin dışında koşar (pi5-vault birimi); ilerleme şeridi /api/vault/job'u izler.
type Provider = 'r2' | 'b2' | 'aws' | 'custom';
interface VaultConfView {
  provider: Provider; endpoint: string; region: string; bucket: string; prefix: string; keyIdMasked: string; host: string;
  schedule: string; includeSecrets: boolean; folders: string[]; keep: { daily: number; weekly: number; monthly: number };
  uploadKbps: number;
}
interface VaultLast {
  attempt: string | null; okConfig: number | null; okFiles: number | null; state: string | null; cmd: string | null;
  msg: string | null; error: string | null; finished: number | null; forget: string | null; connected: number | null;
  filesSkipped: string | null; retryAt?: number | null; nextRun?: number | null;
}
interface VaultStatus {
  supported?: boolean; configured?: boolean; hostname?: string; now?: number; lowMem?: boolean; totalMemMb?: number; memClassMb?: number; restic?: boolean;
  backupLine?: boolean; lastUploadMbps?: number | null; conf?: VaultConfView | null; last?: VaultLast;
}
interface Job {
  state: 'idle' | 'running' | 'done' | 'failed'; id?: string; cmd?: 'connect' | 'backup' | 'disconnect'; step?: string;
  pct?: number; msg?: string; error?: string; startedAt?: number; finishedAt?: number; log?: string[];
}
interface Snap { id: string; time: string; hostname: string; tags: string[]; paths: string[]; files?: number; bytes?: number; added?: number }
interface StoragePart { name: string; fsUsed: number | null; shareName?: string }
interface StorageInfo { layout?: { shareMounted: boolean; shareDev: string }; disks?: { parts: (StoragePart & { path: string })[] }[] }
interface ShareInfo { usb?: { name: string; mounted: boolean }[] }

const PROVIDERS: { id: Provider; label: string; note: string }[] = [
  { id: 'r2', label: 'Cloudflare R2', note: 'İndirme (çıkış) trafiği ücretsiz; ayda ilk 10 GB depolama ücretsiz.' },
  { id: 'b2', label: 'Backblaze B2', note: 'S3 uyumlu uç nokta; bölge kova ayrıntısında yazar (ör. us-west-004). Kova ayarında yaşam döngüsünü «Keep only the last version of the file» yapın: yoksa temizlenen eski yedekler gizlenir ama ücretlendirilmeye devam eder.' },
  { id: 'aws', label: 'AWS S3', note: 'Bölge kovanın bölgesidir (ör. eu-central-1).' },
  { id: 'custom', label: 'Özel / MinIO', note: 'Herhangi bir S3 uyumlu depo. Şifresiz http yalnız ev ağındaki bir adreste.' },
];
const providerLabel = (p?: string) => PROVIDERS.find(x => x.id === p)?.label || p || '—';
const CMD_LABEL = { connect: 'Bulut deposuna bağlanma', backup: 'Bulut yedeği', disconnect: 'Bağlantıyı kaldırma' } as const;
const DISMISS_KEY = 'pi5.vault.jobDismissed';
// Kurtarma kitindeki cihaz kimliği: ana bilgisayar adı + sayfa açılışında bir kez üretilen ek (aynı adlı iki cihaz
// birbirinin anlık görüntülerini budamasın). Bileşen gövdesinde değil: render saf kalsın.
const HOST_SUFFIX = Array.from(crypto.getRandomValues(new Uint8Array(2)), b => b.toString(16).padStart(2, '0')).join('');
const hostFor = (hostname?: string) =>
  `${(hostname || 'klyrix').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'klyrix'}-${HOST_SUFFIX}`;

function size(b?: number | null): string {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
const when = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T12:00:00`).toLocaleDateString('tr-TR', { dateStyle: 'medium' }) : ymd);
const kibToMbit = (k: number) => Math.round((k * 1024 * 8) / 1e5) / 10;
const mbitToKib = (m: number) => Math.round((m * 1e6) / 8 / 1024);

// Kurtarma kiti: sağlayıcı, uç nokta, bölge, kova, ön ek, erişim anahtarı, cihaz kimliği ve iki deponun restic adresi
// (base64 JSON). Parola YOK.
interface Kit { provider: Provider; endpoint: string; region: string; bucket: string; prefix: string; keyId: string; secret: string; host: string }
const repoUrl = (k: Pick<Kit, 'endpoint' | 'bucket' | 'prefix'>, r: 'config' | 'files') =>
  `s3:${k.endpoint}/${k.bucket}/${k.prefix ? `${k.prefix}/` : ''}${r}`;
function encodeKit(k: Kit): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    kit: 'klyrix-vault', v: 1, ...k, repoConfig: repoUrl(k, 'config'), repoFiles: repoUrl(k, 'files'),
  }));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function decodeKit(text: string): Partial<Kit> | null {
  try {
    const bin = atob(text.trim().replace(/\s+/g, ''));
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    return o && o.kit === 'klyrix-vault' ? o : null;
  } catch {
    return null;
  }
}
// İndirilen kit dosyası: kit + okunur bilgiler + panel olmadan restic ile açma örneği (yeni cihaz hazır olmadan da)
function kitText(code: string): string {
  const k = decodeKit(code);
  const lines = ['Klyrix Gate kurtarma kiti — şifreleme parolanızı İÇERMEZ, bulut deposu erişim anahtarınızı içerir: güvenli bir yerde saklayın.', '',
    'Kit (yeni cihazda Yedekleme → Bulut Yedeği → «Var olan depoya bağlan» → «Kurtarma kitinden doldur»):', code, ''];
  if (k?.endpoint && k.bucket) {
    const loc = { endpoint: k.endpoint, bucket: k.bucket, prefix: k.prefix || '' };
    const ro = k.region ? ` -o s3.region=${k.region}` : '';
    lines.push(`Sağlayıcı: ${providerLabel(k.provider)}`, `Uç nokta: ${k.endpoint}`, `Bölge: ${k.region || '—'}`, `Kova: ${k.bucket}`,
      `Ön ek: ${k.prefix || '—'}`, `Erişim anahtarı kimliği: ${k.keyId || ''}`, `Gizli erişim anahtarı: ${k.secret || ''}`,
      `Cihaz kimliği: ${k.host || ''}`, `Ayar deposu: ${repoUrl(loc, 'config')}`, `Dosya deposu: ${repoUrl(loc, 'files')}`, '',
      'Panel olmadan restic ile açmak (restic parolayı sorar):',
      `  export AWS_ACCESS_KEY_ID='${k.keyId || ''}' AWS_SECRET_ACCESS_KEY='${k.secret || ''}'`,
      `  restic -r ${repoUrl(loc, 'config')}${ro} snapshots`,
      `  restic -r ${repoUrl(loc, 'config')}${ro} restore latest --target ./klyrix-geri`, '');
  }
  return lines.join('\n');
}
// Panel http üzerinden açılır (güvenli bağlam değil): navigator.clipboard yoksa seçip kopyalama
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* aşağıdaki yol */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// GET: getApi sunucunun Türkçe hata metnini atar — burada {error} korunur (409 = uydu, durum kodu da döner)
class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' && body.error ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(`/api${url}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, body as Record<string, unknown>);
  return body as T;
}

function readDismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
}

// Durum (uyduda 409) ve iş: iş sürerken 2 sn'de bir, değilse 15 sn'de bir. İş bitince durum yenilenir. Uyduda iş
// sorgulanmaz (her istek 409 olurdu). leftover: uyduda bu cihazda kalmış bulut yedeği bilgisi (silinebilir).
function useVault() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [satellite, setSatellite] = useState<null | { leftover: boolean }>(null);
  const [loadError, setLoadError] = useState('');
  const [tick, setTick] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [jobTick, setJobTick] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await getJson<VaultStatus>('/vault');
        if (!alive) return;
        setStatus(d);
        setSatellite(null);
        setLoadError('');
      } catch (e) {
        if (!alive) return;
        if (e instanceof HttpError && e.status === 409) setSatellite({ leftover: e.body.leftover === true });
        else setLoadError(e instanceof Error ? e.message : 'Durum okunamadı');
      }
    })();
    return () => { alive = false; };
  }, [tick]);
  const isSatellite = !!satellite;
  useEffect(() => {
    if (isSatellite) return;
    let alive = true;
    let timer: number | undefined;
    let prev: Job['state'] | undefined;
    const load = async () => {
      try {
        const j = await getJson<Job>('/vault/job');
        if (!alive) return;
        setJob(j);
        if (prev === 'running' && j.state !== 'running') setTick(t => t + 1);
        prev = j.state;
        timer = window.setTimeout(load, j.state === 'running' ? 2000 : 15000);
      } catch (e) {
        if (!alive) return;
        if (e instanceof HttpError && e.status === 409) { setSatellite(s => s || { leftover: e.body.leftover === true }); return; }
        timer = window.setTimeout(load, 5000);
      }
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [jobTick, isSatellite]);
  return {
    status, satellite, loadError, job,
    reload: () => setTick(t => t + 1),
    jobStarted: () => { setJobTick(t => t + 1); setTick(t => t + 1); },
  };
}

export function CloudBackupPanel() {
  const { status, satellite, loadError, job, reload, jobStarted } = useVault();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [kitAfterConnect, setKitAfterConnect] = useState('');
  const running = job?.state === 'running';

  const dismiss = () => {
    const id = job?.id || '';
    setDismissed(id);
    try { localStorage.setItem(DISMISS_KEY, id); } catch { /* yalnız bu oturum */ }
  };

  const header = (body: React.ReactNode, actions?: React.ReactNode) => (
    <Panel title="Bulut Yedeği" icon={<Cloud size={20} style={{ marginRight: 8 }} />} className="cb-panel" actions={actions}
      subtitle="Şifreli yedek kendi bulut depolama hesabınıza (S3 uyumlu) yüklenir. Klyrix hesabınızı ve anahtarlarınızı görmez.">
      {body}
    </Panel>
  );

  if (satellite) {
    return header(
      <>
        <div className="cb-note cb-note-info"><Satellite size={16} /><span>Uydu — yedek ana cihazdadır. Bulut yedeğini ana cihazın panelinden yönetin.</span></div>
        {satellite.leftover && <SatelliteLeftover onDone={reload} />}
      </>,
    );
  }
  if (!status) {
    return header(loadError
      ? <div className="cb-note cb-note-warn"><AlertTriangle size={16} /><span>Bulut yedeği durumu okunamadı: {loadError}</span></div>
      : <div className="cb-loading"><Loader2 size={18} className="spin" /></div>);
  }
  if (!status.supported) {
    return header(<div className="empty-state" style={{ padding: 20 }}>Bulut yedeği yalnız Pi üzerinde çalışır.</div>);
  }

  const showJob = job && job.state !== 'idle' && (job.state === 'running' || job.id !== dismissed);
  return (
    <>
      {showJob && <VaultJobBanner job={job} onDismiss={dismiss} />}
      {status.configured && status.conf ? (
        <>
          {kitAfterConnect && <KitCard kit={kitAfterConnect} onDone={() => setKitAfterConnect('')} />}
          <ConfiguredView st={status} conf={status.conf} running={running} onChanged={reload} onJob={jobStarted} />
        </>
      ) : header(
        <ConnectForm st={status} busy={running} onStarted={kit => { setKitAfterConnect(kit); jobStarted(); }} />,
      )}
    </>
  );
}

// Uydu olarak yeniden kurulmuş eski ana cihaz: bulut deposunun erişim anahtarı ve cihaz anahtarı burada kalmasın
function SatelliteLeftover({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const wipe = async () => {
    setBusy(true);
    try {
      await postApi('/vault/disable', {});
      toast.success('Bu cihazdaki bulut yedeği bilgileri silindi');
      onDone();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Silinemedi');
    }
    setBusy(false);
  };
  return (
    <div className="cb-note cb-note-warn">
      <AlertTriangle size={16} />
      <span>
        Bu cihazda önceki ana cihaz rolünden kalan bulut yedeği bilgileri var (bulut deposunun erişim anahtarı ve cihaz anahtarı).
        Uyduda kullanılmazlar; silmeniz önerilir. Kovadaki yedekler silinmez.{' '}
        <button className="btn-outline btn-sm cb-inline-btn" disabled={busy} onClick={wipe}>
          {busy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Bu cihazdan sil
        </button>
      </span>
    </div>
  );
}

function VaultJobBanner({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
  const label = job.cmd ? CMD_LABEL[job.cmd] : 'Bulut yedeği işi';
  const running = job.state === 'running';
  const pct = Math.max(0, Math.min(100, job.pct ?? 0));
  const cls = running ? 'cb-job-run' : job.state === 'done' ? 'cb-job-ok' : 'cb-job-bad';
  return (
    <section className={`glass-panel cb-job ${cls}`} role="status" aria-live="polite">
      <div className="cb-job-head">
        {running ? <Loader2 size={18} className="spin" /> : job.state === 'done' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
        <div className="cb-job-title">
          <strong>{running ? `${label} sürüyor` : job.state === 'done' ? `${label} tamamlandı` : `${label} başarısız`}</strong>
          <span>{running ? job.step || 'Başlatılıyor' : job.state === 'done' ? job.msg : job.error}</span>
        </div>
        {!running && <button className="btn-outline btn-sm" onClick={onDismiss}>Kapat</button>}
      </div>
      {running && (
        <>
          <div className="cb-job-bar"><div style={{ width: `${pct}%` }} /></div>
          <p className="cb-job-note">İş panelden bağımsız sürer: sayfayı kapatabilirsiniz. Panel güncellemesi işi kesmez.</p>
        </>
      )}
      {(job.log || []).length > 0 && (
        <details className="cb-job-log" open={job.state === 'failed'}>
          <summary>Ayrıntılı günlük</summary>
          <pre>{job.log!.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}

// ── bağlanma ────────────────────────────────────────────────────────────────
// Panodan yapıştırılan tam adres de kabul edilir: Cloudflare panelindeki S3 API adresi (https://<kimlik>[.eu].r2…[/kova])
// → 32 haneli hesap kimliği; B2 / AWS kova sayfasındaki uç nokta (s3.<bölge>.backblazeb2.com) → bölge.
const R2_ID = /[a-f0-9]{32}/i;
const REGION_IN = /s3\.([a-z0-9-]+)\.(?:backblazeb2|amazonaws)\.com/i;
const regionOf = (input: string) => {
  const t = input.trim().toLowerCase();
  return REGION_IN.exec(t)?.[1] || t;
};
const regionOk = (r: string) => /^[a-z0-9-]{1,32}$/.test(r);
function endpointFor(p: Provider, account: string, eu: boolean, region: string, custom: string): string {
  if (p === 'r2') {
    const id = R2_ID.exec(account)?.[0]?.toLowerCase();
    return id ? `https://${id}.${eu ? 'eu.' : ''}r2.cloudflarestorage.com` : '';
  }
  const r = regionOf(region);
  if (p === 'b2') return regionOk(r) ? `https://s3.${r}.backblazeb2.com` : '';
  if (p === 'aws') return regionOk(r) ? `https://s3.${r}.amazonaws.com` : '';
  return custom.trim();
}

function ConnectForm({ st, busy, onStarted }: { st: VaultStatus; busy: boolean; onStarted: (kit: string) => void }) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [provider, setProvider] = useState<Provider>('r2');
  const [account, setAccount] = useState('');
  const [eu, setEu] = useState(false);
  const [region, setRegion] = useState('');
  const [custom, setCustom] = useState('');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('klyrix');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  // Onay kutusu kitin o anki hâline bağlı: kit değişirse (ör. yanlış gizli anahtar düzeltildi) yeniden kaydedilmeli
  const [savedKit, setSavedKit] = useState('');
  const [paste, setPaste] = useState('');
  const [kitHost, setKitHost] = useState('');
  const [replaceHost, setReplaceHost] = useState(false);
  const [sending, setSending] = useState(false);
  // Var olan depoya, kitteki cihazın yerine bağlanırken aynı cihaz kimliği: eski cihazın anlık görüntüleri aynı saklama
  // grubunda kalır ve budanmaya devam eder
  const host = mode === 'existing' && replaceHost && kitHost ? kitHost : hostFor(st.hostname);
  const endpoint = endpointFor(provider, account, eu, region, custom);
  const effRegion = provider === 'r2' ? 'auto' : provider === 'custom' ? region.trim() : regionOf(region);
  const kit = useMemo(() => encodeKit({ provider, endpoint, region: effRegion, bucket: bucket.trim(), prefix: prefix.trim(), keyId: keyId.trim(), secret: secret.trim(), host }),
    [provider, endpoint, effRegion, bucket, prefix, keyId, secret, host]);
  const saved = !!savedKit && savedKit === kit;
  const kitChanged = !!savedKit && savedKit !== kit;
  const pwOk = pw.length >= 12 && pw === pw2 && pw.trim() === pw;
  const ready = !!endpoint && !!bucket.trim() && !!keyId.trim() && !!secret.trim() && pwOk && saved && !busy && !sending;
  const note = PROVIDERS.find(p => p.id === provider)?.note;
  const accountBad = provider === 'r2' && !!account.trim() && !R2_ID.test(account);
  const regionBad = (provider === 'b2' || provider === 'aws') && !!region.trim() && !regionOk(regionOf(region));

  const onAccount = (v: string) => {
    setAccount(v);
    if (/\.eu\.r2\.cloudflarestorage\.com/i.test(v)) setEu(true);
  };
  const fillFromKit = () => {
    const k = decodeKit(paste);
    if (!k || !k.endpoint) { toast.error('Kurtarma kiti okunamadı — kitin tamamını yapıştırın'); return; }
    const p = (PROVIDERS.some(x => x.id === k.provider) ? k.provider : 'custom') as Provider;
    setProvider(p);
    if (p === 'r2') { setAccount(k.endpoint); setEu(/\.eu\.r2\./i.test(k.endpoint)); }
    else if (p === 'custom') setCustom(k.endpoint);
    setRegion(p === 'r2' ? '' : k.region || '');
    setBucket(k.bucket || '');
    setPrefix(k.prefix || 'klyrix');
    setKeyId(k.keyId || '');
    setSecret(k.secret || '');
    setKitHost(typeof k.host === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(k.host) ? k.host : '');
    setReplaceHost(false);
    setPaste('');
    toast.success('Bağlantı bilgileri kitten dolduruldu — parolayı yazın');
  };

  const submit = async () => {
    setSending(true);
    try {
      await postApi('/vault/connect', {
        provider, endpoint, region: effRegion, bucket: bucket.trim(), prefix: prefix.trim(), keyId: keyId.trim(), secret: secret.trim(),
        passphrase: pw, mode, host,
      });
      toast.info(mode === 'new' ? 'Depolar oluşturuluyor…' : 'Depoya bağlanılıyor…');
      onStarted(kit);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Bağlanılamadı');
    }
    setSending(false);
  };

  return (
    <div className="cb-connect">
      <p className="cb-help">
        Panel ayarlarınız her gece, isterseniz seçtiğiniz klasörler de <strong>restic</strong> ile şifrelenip kendi kovanıza
        yüklenir (AES-256). Depolama ücreti ve hesap sizindir. Bu cihazda erişim anahtarınız ve rastgele bir cihaz anahtarı
        saklanır (yalnız root okuyabilir); şifreleme parolanız saklanmaz. Cihaz (SD kart) ele geçirilirse yedekler okunabilir
        ya da silinebilir — bu yüzden yalnız bu kovaya yetkili bir erişim anahtarı kullanın.
      </p>
      <div className="cb-mode" role="radiogroup" aria-label="Bağlantı kipi">
        <button type="button" role="radio" aria-checked={mode === 'new'} className={`cb-mode-btn ${mode === 'new' ? 'cb-mode-on' : ''}`}
          onClick={() => setMode('new')}>Yeni depo<span>Kovada iki boş depo oluşturur</span></button>
        <button type="button" role="radio" aria-checked={mode === 'existing'} className={`cb-mode-btn ${mode === 'existing' ? 'cb-mode-on' : ''}`}
          onClick={() => setMode('existing')}>Var olan depoya bağlan<span>Daha önce oluşturulmuş depo + parolası</span></button>
      </div>

      {mode === 'existing' && (
        <div className="form-group cb-kit-paste">
          <label htmlFor="cb-paste"><KeyRound size={13} /> Kurtarma kitinden doldur (isteğe bağlı)</label>
          <div className="cb-inline">
            <input id="cb-paste" value={paste} onChange={e => setPaste(e.target.value)} placeholder="Kurtarma kitini yapıştırın" autoComplete="off" spellCheck={false} />
            <button className="btn-outline btn-sm" type="button" disabled={!paste.trim()} onClick={fillFromKit}>Doldur</button>
          </div>
          {kitHost && kitHost !== hostFor(st.hostname) && (
            <label className="cb-check">
              <input type="checkbox" checked={replaceHost} onChange={e => setReplaceHost(e.target.checked)} />
              <span>Bu cihaz, kitteki cihazın (<code>{kitHost}</code>) yerine geçiyor — aynı cihaz kimliğiyle bağlan</span>
            </label>
          )}
          <p className="cb-hint">
            {replaceHost && kitHost
              ? 'Eski cihazın anlık görüntüleri bu cihazınkilerle aynı saklama grubunda kalır ve eskidikçe temizlenir. Eski cihaz hâlâ çalışıyorsa bunu seçmeyin.'
              : 'Bu cihaz yeni bir cihaz kimliğiyle bağlanır. Başka cihaz kimliklerinin anlık görüntüleri korunur ve kendiliğinden temizlenmez.'}
          </p>
        </div>
      )}

      <div className="cb-grid">
        <div className="form-group">
          <label htmlFor="cb-provider">Sağlayıcı</label>
          <Select id="cb-provider" value={provider} onChange={e => setProvider(e.target.value as Provider)}>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
          {note && <p className="cb-hint">{note}</p>}
        </div>
        {provider === 'r2' && (
          <div className="form-group">
            <label htmlFor="cb-acc">Hesap kimliği (Account ID)</label>
            <input id="cb-acc" value={account} onChange={e => onAccount(e.target.value)} placeholder="32 haneli kimlik ya da S3 API adresi" autoComplete="off" spellCheck={false}
              aria-invalid={accountBad} />
            {accountBad
              ? <p className="cb-hint cb-bad">Hesap kimliği 32 haneli olmalı (Cloudflare panelindeki S3 API adresini de yapıştırabilirsiniz)</p>
              : (
                <label className="cb-check cb-check-sm">
                  <input type="checkbox" checked={eu} onChange={e => setEu(e.target.checked)} />
                  <span>Kova AB yargı bölgesinde (adres …<code>.eu.r2.cloudflarestorage.com</code>)</span>
                </label>
              )}
          </div>
        )}
        {(provider === 'b2' || provider === 'aws' || provider === 'custom') && (
          <div className="form-group">
            <label htmlFor="cb-region">Bölge{provider === 'custom' ? ' (isteğe bağlı)' : ''}</label>
            <input id="cb-region" value={region} onChange={e => setRegion(e.target.value)} aria-invalid={regionBad}
              placeholder={provider === 'b2' ? 'us-west-004 ya da kovadaki uç nokta' : provider === 'aws' ? 'eu-central-1' : 'us-east-1'} autoComplete="off" spellCheck={false} />
            {regionBad && <p className="cb-hint cb-bad">Bölge yalnız küçük harf, rakam ve tire içerir (ör. {provider === 'b2' ? 'us-west-004' : 'eu-central-1'}) — uç nokta adresini de yapıştırabilirsiniz</p>}
          </div>
        )}
        {provider === 'custom' ? (
          <div className="form-group cb-span">
            <label htmlFor="cb-ep">Uç nokta adresi</label>
            <input id="cb-ep" value={custom} onChange={e => setCustom(e.target.value)} placeholder="https://depo.ornek.com ya da http://192.168.1.10:9000"
              autoComplete="off" spellCheck={false} />
          </div>
        ) : (
          <div className="form-group cb-span">
            <label>Uç nokta</label>
            <code className="cb-code">{endpoint || '—'}</code>
          </div>
        )}
        <div className="form-group">
          <label htmlFor="cb-bucket">Kova adı</label>
          <input id="cb-bucket" value={bucket} onChange={e => setBucket(e.target.value)} placeholder="ev-yedek" autoComplete="off" spellCheck={false} />
        </div>
        <div className="form-group">
          <label htmlFor="cb-prefix">Ön ek (kovadaki klasör)</label>
          <input id="cb-prefix" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="klyrix" autoComplete="off" spellCheck={false} />
        </div>
        <div className="form-group">
          <label htmlFor="cb-key">Erişim anahtarı kimliği (Access Key ID)</label>
          <input id="cb-key" value={keyId} onChange={e => setKeyId(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="form-group">
          <label htmlFor="cb-secret">Gizli erişim anahtarı (Secret)</label>
          <input id="cb-secret" type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} />
        </div>
        <div className="form-group">
          <label htmlFor="cb-pw">Şifreleme parolası (en az 12 karakter)</label>
          <input id="cb-pw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="form-group">
          <label htmlFor="cb-pw2">Parola (tekrar)</label>
          <input id="cb-pw2" type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" />
          {pw2 && !pwOk && <p className="cb-hint cb-bad">{pw !== pw2 ? 'Parolalar aynı değil' : pw.trim() !== pw ? 'Parola boşlukla başlayıp bitemez' : 'En az 12 karakter'}</p>}
        </div>
      </div>
      <p className="cb-hint">
        En iyisi yalnız bu kovaya okuma + yazma izni olan ayrı bir erişim anahtarı (ör. R2 API belirteci) oluşturmaktır.
        {mode === 'existing' ? ' Var olan depoda parola, depoyu oluştururken kullandığınız paroladır.' : ''}
      </p>

      <div className="cb-kit">
        <div className="cb-kit-head"><ShieldCheck size={16} /><strong>Kurtarma kiti</strong></div>
        <p className="cb-hint">
          Cihaz bozulursa yedeğe ulaşmak için <strong>kurtarma kiti + parola</strong> birlikte gerekir. Kit erişim anahtarınızı ve
          depo adreslerini içerir (parolayı içermez): bir parola yöneticisinde ya da çevrim dışı güvenli bir yerde saklayın.
          Parolayı kaybederseniz yedekler hiç kimse tarafından açılamaz.
        </p>
        <textarea className="cb-kit-text" readOnly value={kit} rows={3} aria-label="Kurtarma kiti" onFocus={e => e.currentTarget.select()} />
        <div className="cb-actions">
          <button className="btn-outline btn-sm" type="button" onClick={async () => { if (await copyText(kit)) toast.success('Kurtarma kiti kopyalandı'); else toast.error('Kopyalanamadı — metni seçip elle kopyalayın'); }}>
            <Copy size={13} /> Kopyala
          </button>
          <button className="btn-outline btn-sm" type="button" onClick={() => downloadText(`klyrix-kurtarma-kiti-${host}.txt`, kitText(kit))}>
            <Download size={13} /> İndir
          </button>
          <span className="cb-hint">Cihaz kimliği: <code>{host}</code></span>
        </div>
      </div>

      <label className="cb-check">
        <input type="checkbox" checked={saved} onChange={e => setSavedKit(e.target.checked ? kit : '')} />
        <span>Kurtarma bilgilerini (kit + parola) güvenli bir yere kaydettim</span>
      </label>
      {kitChanged && <p className="cb-hint cb-bad">Kit değişti (bağlantı bilgileri düzeltildi) — yeni kiti yeniden kaydedip kutuyu yeniden işaretleyin.</p>}
      <div className="cb-actions">
        <button className="btn-primary" type="button" disabled={!ready} onClick={submit}>
          {sending ? <Loader2 size={14} className="spin" /> : <Cloud size={14} />} {mode === 'new' ? 'Depoyu oluştur ve bağlan' : 'Depoya bağlan'}
        </button>
      </div>
    </div>
  );
}

function KitCard({ kit, onDone }: { kit: string; onDone: () => void }) {
  return (
    <section className="glass-panel cb-kit cb-kit-after">
      <div className="cb-kit-head"><ShieldCheck size={16} /><strong>Kurtarma kitiniz</strong></div>
      <p className="cb-hint">
        Bu kit ve parolanız olmadan yeni bir cihazdan yedeğe ulaşılamaz. Kit bir daha gösterilmez (panel gizli erişim anahtarını
        tarayıcıya bir daha göndermez): kopyalayın ya da indirin, parola yöneticinize kaydedin.
      </p>
      <textarea className="cb-kit-text" readOnly value={kit} rows={3} aria-label="Kurtarma kiti" onFocus={e => e.currentTarget.select()} />
      <div className="cb-actions">
        <button className="btn-outline btn-sm" type="button" onClick={async () => { if (await copyText(kit)) toast.success('Kurtarma kiti kopyalandı'); else toast.error('Kopyalanamadı — metni seçip elle kopyalayın'); }}>
          <Copy size={13} /> Kopyala
        </button>
        <button className="btn-outline btn-sm" type="button" onClick={() => downloadText('klyrix-kurtarma-kiti.txt', kitText(kit))}>
          <Download size={13} /> İndir
        </button>
        <button className="btn-primary btn-sm" type="button" onClick={onDone}>Kaydettim, gizle</button>
      </div>
    </section>
  );
}

// ── bağlıyken ───────────────────────────────────────────────────────────────
function ConfiguredView({ st, conf, running, onChanged, onJob }: {
  st: VaultStatus; conf: VaultConfView; running: boolean; onChanged: () => void; onJob: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [disable, setDisable] = useState(false);
  const last = st.last;
  const hasFolders = conf.folders.length > 0;
  // Sonraki otomatik yedek (backend hesaplar: bugün denenmediyse bugünün saati, bekleyen yeniden deneme ya da yarın);
  // "şimdi" de durum yanıtındaki saat (render saf kalsın). Saat ekiz yazılır (12:30'da / 04:30'da ünlü uyumu değişir).
  const next = last?.nextRun ?? null;
  const now = st.now ?? 0;
  const nextText = !next || !now ? `her gün ${conf.schedule}`
    : next - now < 180 ? 'birkaç dakika içinde'
      : new Date(next * 1000).toDateString() === new Date(now * 1000).toDateString()
        ? `bugün ${new Date(next * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
        : when(next);

  const backup = async (what: 'config' | 'all') => {
    setBusy(true);
    try {
      await postApi('/vault/backup', { what });
      toast.info(what === 'all' ? 'Yedek başladı (ayarlar + klasörler)' : 'Ayar yedeği başladı');
      onJob();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Yedek başlatılamadı');
    }
    setBusy(false);
  };

  return (
    <>
      <Panel title="Bulut Yedeği" icon={<Cloud size={20} style={{ marginRight: 8 }} />} className="cb-panel"
        subtitle={`${providerLabel(conf.provider)} · ${conf.bucket}/${conf.prefix}`}
        actions={
          <div className="cb-head-actions">
            <button className="btn-primary btn-sm" disabled={running || busy} onClick={() => backup(hasFolders ? 'all' : 'config')}>
              <CloudUpload size={13} /> Şimdi yedekle
            </button>
            {hasFolders && (
              <button className="btn-outline btn-sm" disabled={running || busy} onClick={() => backup('config')}>Yalnız ayarlar</button>
            )}
          </div>
        }>
        {st.backupLine && (
          <div className="cb-note cb-note-warn"><AlertTriangle size={16} /><span>Yedek hattasınız: klasörler yüklenmez, yalnız ayarlar yedeklenir.</span></div>
        )}
        <div className="cb-facts">
          <div><span>Uç nokta</span><code>{conf.endpoint}</code></div>
          <div><span>Kova / ön ek</span><code>{conf.bucket}/{conf.prefix}</code></div>
          <div><span>Erişim anahtarı</span><code>{conf.keyIdMasked}</code></div>
          <div><span>Cihaz kimliği</span><code>{conf.host}</code></div>
          <div><span>Son ayar yedeği</span><strong>{when(last?.okConfig)}</strong></div>
          <div><span>Son klasör yedeği</span><strong>{hasFolders ? when(last?.okFiles) : 'klasör seçilmedi'}</strong></div>
          <div><span>Otomatik yedek</span><strong>her gün {conf.schedule}</strong></div>
          <div><span>Eski anlık görüntü temizliği</span><strong>{last?.forget ? `Son: ${day(last.forget)} · Pazar günleri` : 'Pazar günleri'}</strong></div>
        </div>
        {last?.state === 'failed' && last.error && (
          <div className="cb-note cb-note-bad">
            <XCircle size={16} />
            <span>Son iş başarısız: {last.error}{last.cmd === 'backup' && !running ? ` — otomatik yedek yeniden denenecek (${nextText}); «Şimdi yedekle» ile hemen deneyebilirsiniz.` : ''}</span>
          </div>
        )}
        {!last?.okConfig && !running && last?.state !== 'failed' && (
          <p className="cb-help"><Info size={13} /> Henüz yedek yok. İlk otomatik yedek: {nextText}; beklemek istemezseniz «Şimdi yedekle».</p>
        )}
      </Panel>

      <SettingsForm key={JSON.stringify(conf)} st={st} conf={conf} onSaved={onChanged} />
      <SnapshotList conf={conf} />

      <Panel title="Bağlantı" icon={<Unplug size={18} style={{ marginRight: 8 }} />} className="cb-panel" size="medium">
        <p className="cb-help">
          Bağlantıyı kaldırmak bu cihazdaki yapılandırmayı ve cihaz anahtarını siler; kovadaki yedekler kalır (kurtarma kiti +
          parolayla açılır).
        </p>
        <button className="btn-outline btn-sm" disabled={running} onClick={() => setDisable(true)}><Unplug size={13} /> Bağlantıyı kaldır</button>
      </Panel>
      {disable && <DisableModal onClose={() => setDisable(false)} onDone={job => { setDisable(false); if (job) onJob(); else onChanged(); }} />}
    </>
  );
}

function folderSuggestions(storage: StorageInfo, share: ShareInfo): { path: string; label: string; bytes?: number | null }[] {
  const out: { path: string; label: string; bytes?: number | null }[] = [];
  const parts = (storage.disks || []).flatMap(d => d.parts);
  if (storage.layout?.shareMounted) {
    const p = parts.find(x => x.path === storage.layout?.shareDev);
    out.push({ path: '/mnt/klyrix-share/Paylasim', label: 'Paylaşım alanı (Paylasim)', bytes: p?.fsUsed });
  }
  for (const p of parts.filter(x => x.shareName)) out.push({ path: `/mnt/klyrix-usb/${p.shareName}`, label: `USB disk: ${p.shareName}`, bytes: p.fsUsed });
  for (const u of share.usb || []) {
    if (u.mounted && !out.some(o => o.path === `/mnt/klyrix-usb/${u.name}`)) out.push({ path: `/mnt/klyrix-usb/${u.name}`, label: `USB disk: ${u.name}` });
  }
  return out;
}

function SettingsForm({ st, conf, onSaved }: { st: VaultStatus; conf: VaultConfView; onSaved: () => void }) {
  const { data: storage } = useApi<StorageInfo>('/storage', {});
  const { data: share } = useApi<ShareInfo>('/storage/share', {});
  const [schedule, setSchedule] = useState(conf.schedule);
  const [folders, setFolders] = useState<string[]>(conf.folders);
  const [custom, setCustom] = useState('');
  const [secrets, setSecrets] = useState(conf.includeSecrets);
  const [keep, setKeep] = useState(conf.keep);
  const [upMbit, setUpMbit] = useState(conf.uploadKbps ? String(kibToMbit(conf.uploadKbps)) : '0');
  const [lowOk, setLowOk] = useState(conf.folders.length > 0);
  const [saving, setSaving] = useState(false);
  const sugg = folderSuggestions(storage, share);
  const lowMem = !!st.lowMem;
  const foldersOpen = !lowMem || lowOk;
  const suggestUp = st.lastUploadMbps ? Math.max(1, Math.round(st.lastUploadMbps / 2)) : null;
  // Kaydedilmemiş değişiklik: form uzun (telefonda Kaydet düğmesi görünmez kalır) — altta da Kaydet + uyarı
  const sorted = (a: string[]) => [...a].sort().join('|');
  const dirty = schedule !== conf.schedule || secrets !== conf.includeSecrets
    || sorted(foldersOpen ? folders : []) !== sorted(conf.folders)
    || keep.daily !== conf.keep.daily || keep.weekly !== conf.keep.weekly || keep.monthly !== conf.keep.monthly
    || Number(upMbit.replace(',', '.')) !== (conf.uploadKbps ? kibToMbit(conf.uploadKbps) : 0);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const toggleFolder = (p: string) => setFolders(f => (f.includes(p) ? f.filter(x => x !== p) : [...f, p]));
  const addCustom = () => {
    const p = custom.trim().replace(/\/+$/, '');
    if (!p.startsWith('/')) { toast.error('Tam yol yazın (ör. /home/pi/Belgeler)'); return; }
    if (!folders.includes(p)) setFolders([...folders, p]);
    setCustom('');
  };
  const save = async () => {
    const up = Number(upMbit.replace(',', '.'));
    if (!Number.isFinite(up) || up < 0) { toast.error('Yükleme sınırı 0 (sınırsız) ya da pozitif bir sayı olmalı'); return; }
    setSaving(true);
    try {
      await postApi('/vault/settings', {
        schedule, folders: foldersOpen ? folders : [], includeSecrets: secrets, keep, uploadKbps: up ? mbitToKib(up) : 0,
        ...(lowMem && lowOk ? { allowLowMem: true } : {}),
      });
      toast.success('Bulut yedeği ayarları kaydedildi');
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Kaydedilemedi');
    }
    setSaving(false);
  };
  const num = (v: string) => Math.max(0, Math.min(999, Math.floor(Number(v) || 0)));
  const saveBtn = (
    <button className="btn-primary btn-sm" disabled={saving || !dirty} onClick={save}>{saving ? <Loader2 size={13} className="spin" /> : null} Kaydet</button>
  );

  return (
    <Panel title="Yedek ayarları" icon={<Clock size={18} style={{ marginRight: 8 }} />} className="cb-panel"
      actions={<div className="cb-head-actions">{dirty && <span className="cb-dirty">Kaydedilmemiş değişiklik</span>}{saveBtn}</div>}>
      <div className="cb-grid">
        <div className="form-group">
          <label htmlFor="cb-time">Otomatik yedek saati (her gün)</label>
          <input id="cb-time" type="time" value={schedule} onChange={e => setSchedule(e.target.value)} />
          <p className="cb-hint">Cihaz kapalıyken kaçırılan yedek açılışta alınır. Pazar günleri eski anlık görüntüler temizlenir.</p>
        </div>
        <div className="form-group">
          <label htmlFor="cb-up">Yükleme sınırı (Mbit/sn, 0 = sınırsız)</label>
          <div className="cb-inline">
            <input id="cb-up" inputMode="decimal" value={upMbit} onChange={e => setUpMbit(e.target.value)} />
            {suggestUp && <button className="btn-outline btn-sm" type="button" onClick={() => setUpMbit(String(suggestUp))}>Öneri: {suggestUp}</button>}
          </div>
          <p className="cb-hint">{suggestUp
            ? `Son hız testinde yükleme ${st.lastUploadMbps?.toFixed(1)} Mbit/sn — yarısı önerilir (görüntülü görüşme ve oyun etkilenmesin).`
            : 'Yükleme hızınızın yarısı önerilir; Hız Testi sayfasında ölçebilirsiniz.'}</p>
        </div>
      </div>

      <h4 className="cb-h"><FolderPlus size={15} /> Yedeklenecek klasörler</h4>
      {lowMem && (
        <div className="cb-note cb-note-warn">
          <AlertTriangle size={16} />
          <span>Bu cihazın belleği az ({st.memClassMb || st.totalMemMb} MB sınıfı): klasör yedeği varsayılan olarak kapalı, yalnız
            ayarlar yedeklenir. Büyük klasörler belleği zorlayabilir.</span>
        </div>
      )}
      {lowMem && (
        <label className="cb-check">
          <input type="checkbox" checked={lowOk} onChange={e => setLowOk(e.target.checked)} />
          <span>Yine de klasör yedeğini aç (önerilmez)</span>
        </label>
      )}
      {foldersOpen && (
        <div className="cb-folders">
          {sugg.length === 0 && folders.length === 0 && (
            <p className="cb-hint">Önerilecek klasör yok (paylaşım alanı ya da ağda paylaşılan USB disk bulunamadı). Aşağıdan bir yol ekleyebilirsiniz.</p>
          )}
          {sugg.map(s => (
            <label key={s.path} className="cb-folder">
              <input type="checkbox" checked={folders.includes(s.path)} onChange={() => toggleFolder(s.path)} />
              <span className="cb-folder-main"><strong>{s.label}</strong><code>{s.path}</code></span>
              {s.bytes != null && <span className="cb-folder-size">≈ {size(s.bytes)}</span>}
            </label>
          ))}
          {folders.filter(f => !sugg.some(s => s.path === f)).map(f => (
            <div key={f} className="cb-folder">
              <span className="cb-folder-main"><strong>Seçilen klasör</strong><code>{f}</code></span>
              <button className="icon-btn" aria-label={`${f} kaldır`} onClick={() => toggleFolder(f)}><Trash2 size={14} /></button>
            </div>
          ))}
          <div className="cb-inline">
            <input aria-label="Klasör yolu" value={custom} onChange={e => setCustom(e.target.value)} placeholder="/home/pi/Belgeler ya da /srv/…"
              autoComplete="off" spellCheck={false} onKeyDown={e => { if (e.key === 'Enter') addCustom(); }} />
            <button className="btn-outline btn-sm" type="button" disabled={!custom.trim()} onClick={addCustom}>Ekle</button>
          </div>
          <p className="cb-hint">Yalnız paylaşım alanı, ağda paylaşılan USB diskler, ev dizinleri (/home/…) ve /srv/… yedeklenebilir. Sistem
            klasörleri (/etc, günlükler, panel ve Pi-hole veritabanı) eklenemez; panel ayarları zaten her yedekte. Eski sistem
            arşivleri (eski-sistem-arsivi-…) seçilemez; ev dizini seçilirse arşivdeki eski sistem klasörleri (etc, root, opt —
            parola özetleri, SSH ve VPN anahtarları) yedeğe girmez.</p>
        </div>
      )}

      <h4 className="cb-h"><KeyRound size={15} /> Gizli anahtarlar</h4>
      <label className="cb-check">
        <input type="checkbox" checked={secrets} onChange={e => setSecrets(e.target.checked)} />
        <span>Gizli anahtarları da yedekle</span>
      </label>
      <p className="cb-hint">
        Varsayılan kapalı. Açıksa ayar yedeğine şunlar da girer: VPS sunucularının SSH bilgileri, VPS tünel anahtarları, VPN
        istemci yapılandırmaları, Ev VPN'i sunucu ve cihaz anahtarları, DDNS anahtarları. Hepsi kendi kovanızda parolanızla
        şifrelidir; kurtarma kitinizi ve parolanızı ele geçiren bu anahtarlara da ulaşır. Yeni cihaza taşırken tünellerin ve
        telefon VPN profillerinin aynen çalışmasını sağlar.
      </p>
      {conf.includeSecrets && (
        <p className="cb-hint">
          Kapatmak önceki anlık görüntüleri değiştirmez: içlerindeki gizli anahtarlar saklama süresi dolana kadar (en çok
          {' '}{conf.keep.monthly} ay) kovanızda kalır.
        </p>
      )}

      <h4 className="cb-h"><History size={15} /> Saklama (anlık görüntü sayısı)</h4>
      <div className="cb-keep">
        <div className="form-group"><label htmlFor="cb-kd">Günlük</label><input id="cb-kd" inputMode="numeric" value={keep.daily} onChange={e => setKeep({ ...keep, daily: num(e.target.value) })} /></div>
        <div className="form-group"><label htmlFor="cb-kw">Haftalık</label><input id="cb-kw" inputMode="numeric" value={keep.weekly} onChange={e => setKeep({ ...keep, weekly: num(e.target.value) })} /></div>
        <div className="form-group"><label htmlFor="cb-km">Aylık</label><input id="cb-km" inputMode="numeric" value={keep.monthly} onChange={e => setKeep({ ...keep, monthly: num(e.target.value) })} /></div>
      </div>
      <div className="cb-save-bar">
        {dirty && <span className="cb-dirty">Kaydedilmemiş değişiklik</span>}
        {saveBtn}
      </div>
    </Panel>
  );
}

function SnapshotList({ conf }: { conf: VaultConfView }) {
  const [lists, setLists] = useState<Partial<Record<'config' | 'files', Snap[]>>>({});
  const [errs, setErrs] = useState<Partial<Record<'config' | 'files', string>>>({});
  const [tried, setTried] = useState(false);
  const [loading, setLoading] = useState(false);
  // Sunucunun Türkçe nedeni gösterilir (ulaşılamadı, parola, restic kurulu değil …); dosya deposunun hatası ayrı not
  const load = async () => {
    setLoading(true);
    const res = await Promise.allSettled((['config', 'files'] as const).map(r => getJson<{ snapshots: Snap[] }>(`/vault/snapshots?repo=${r}`)));
    const next: typeof lists = {};
    const er: typeof errs = {};
    (['config', 'files'] as const).forEach((r, i) => {
      const x = res[i];
      if (x.status === 'fulfilled') next[r] = x.value.snapshots;
      else er[r] = x.reason instanceof Error ? x.reason.message : 'okunamadı';
    });
    setLists(next);
    setErrs(er);
    setTried(true);
    if (er.config) toast.error(`Anlık görüntüler okunamadı: ${er.config}`);
    setLoading(false);
  };
  // Boyut tahmini: her depoda her cihazın EN SON anlık görüntüsünün boyutu (sıkıştırmadan önce). Eklenen verinin toplamı
  // değil: budamayla ilk tam yedek listeden düşer ama verisi depoda kalır ve ücretlendirilir.
  const latestBytes = (['config', 'files'] as const).reduce((sum, r) => {
    const byHost = new Map<string, Snap>();
    for (const sn of lists[r] || []) {
      const cur = byHost.get(sn.hostname);
      if (!cur || sn.time > cur.time) byHost.set(sn.hostname, sn);
    }
    return sum + [...byHost.values()].reduce((a, sn) => a + (sn.bytes || 0), 0);
  }, 0);
  const gb = latestBytes / 1e9;
  return (
    <Panel title="Anlık görüntüler" icon={<History size={18} style={{ marginRight: 8 }} />} className="cb-panel"
      actions={<button className="btn-outline btn-sm" disabled={loading} onClick={load}>{loading ? <Loader2 size={13} className="spin" /> : null} {tried ? 'Yenile' : 'Listele'}</button>}>
      {!tried && <p className="cb-help">Liste buluttan okunur (birkaç saniye). «Listele» ile getirin.</p>}
      {tried && (['config', 'files'] as const).map(repo => (
        <div key={repo} className="cb-snaps">
          <h4 className="cb-h">{repo === 'config' ? 'Ayarlar' : 'Klasörler'} {!errs[repo] && <span className="cb-count">{lists[repo]?.length || 0}</span>}</h4>
          {errs[repo]
            ? <div className="cb-note cb-note-warn"><AlertTriangle size={16} /><span>Okunamadı: {errs[repo]}</span></div>
            : (lists[repo] || []).length === 0 && <p className="cb-hint">Anlık görüntü yok.</p>}
          {(lists[repo] || []).slice(0, 30).map(sn => (
            <div key={`${repo}-${sn.id}`} className="cb-snap">
              <span className="cb-snap-time">{new Date(sn.time).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <code>{sn.id}</code>
              <span className="cb-snap-meta">{sn.hostname}{sn.files != null ? ` · ${sn.files} dosya` : ''}{sn.bytes != null ? ` · ${size(sn.bytes)}` : ''}</span>
            </div>
          ))}
        </div>
      ))}
      {tried && conf.provider === 'r2' && latestBytes > 0 && (
        <p className="cb-hint cb-cost">
          Son yedeklerin boyutu yaklaşık {size(latestBytes)} (sıkıştırmadan önce; her cihazın en son anlık görüntüsü). Kovada
          bunun üstüne eski sürümlerin değişen verisi de durur — kesin boyutu sağlayıcınızın panelinde görürsünüz. Cloudflare
          R2'de aylık ilk 10 GB ücretsiz, sonrası GB başına yaklaşık $0.015: bu boyutla kabaca {gb <= 10
            ? 'ücretsiz kotanın içinde'
            : `en az $${((gb - 10) * 0.015).toFixed(2)} / ay`} (eski sürümler hariç). Ücret sizin hesabınızdadır; güncel fiyatlar
          için sağlayıcınızın sayfasına bakın.
        </p>
      )}
    </Panel>
  );
}

function DisableModal({ onClose, onDone }: { onClose: () => void; onDone: (job: boolean) => void }) {
  const [removeKey, setRemoveKey] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await postApi('/vault/disable', removeKey ? { removeKey: true, passphrase: pw } : {}) as { id?: string };
      toast.info(r.id ? 'Cihaz anahtarı depodan siliniyor…' : 'Bulut yedeği bağlantısı kaldırıldı');
      onDone(!!r.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Kaldırılamadı');
    }
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} title="Bulut yedeği bağlantısını kaldır" width={460}
      actions={<>
        <button className="btn-outline" onClick={onClose}>Vazgeç</button>
        <button className="btn-primary" disabled={busy || (removeKey && pw.length < 12)} onClick={submit}>
          {busy ? <Loader2 size={14} className="spin" /> : <Unplug size={14} />} Bağlantıyı kaldır
        </button>
      </>}>
      <p className="cb-help" style={{ marginTop: 0 }}>
        Bu cihazdaki yapılandırma ve cihaz anahtarı silinir; otomatik yedek durur. Kovadaki yedekler silinmez — kurtarma kiti +
        parolayla açılmaya devam eder.
      </p>
      <label className="cb-check">
        <input type="checkbox" checked={removeKey} onChange={e => setRemoveKey(e.target.checked)} />
        <span>Bu cihazın anahtarını depodan da sil (cihazı satacak ya da başkasına verecekseniz önerilir)</span>
      </label>
      <p className="cb-hint">Kaybolan bir cihazın anahtarı o cihazın panelinden silinemez: kurtarma sırasında (sonraki sürüm) yeni cihazdan
        kaldırılır.</p>
      {removeKey && (
        <div className="form-group">
          <label htmlFor="cb-dpw">Şifreleme parolası</label>
          <input id="cb-dpw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
        </div>
      )}
    </Modal>
  );
}

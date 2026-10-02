import { useEffect, useState } from 'react';
import {
  HardDriveUpload, Loader2, CheckCircle2, XCircle, AlertTriangle, Copy, Power, Satellite, Monitor, Smartphone, Apple, Usb,
  HardDrive, Trash2, Pause, Play, Check, X, FolderSync, ShieldCheck, Settings2, Link2, Info,
} from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { Modal, Panel, Select } from './ui';
import { toast } from '../toast';
import { copyText } from '../clipboard';
import './DeviceBackupPanel.css';

// Cihaz Yedekleme (backend sync.ts → scripts/sync.sh, Syncthing): bilgisayar / telefon / tabletlerdeki seçilen klasörler
// Pi'nin diskine (veri diskinin paylaşım bölümü ya da "Ağda paylaş" denen USB diskler) sürekli yedeklenir. Pi yalnız alır:
// cihazda silinen / değişen dosyanın eski sürümü burada N gün kalır; Pi cihazdaki hiçbir dosyayı değiştirmez. Yeni cihaz ve
// klasör panelde onaylanır. Açma paket kurduğu için depolama işi olarak koşar (ilerleme /api/storage/job, iş türü 'sync').
interface Target { key: string; kind: 'internal' | 'usb'; name: string; mounted: boolean; fstype: string; free: number | null; size: number | null }
interface Device { id: string; name: string; connected: boolean; address: string; clientVersion: string; lastSeen: string | null; paused: boolean }
interface Folder {
  id: string; label: string; deviceId: string; deviceName: string; path: string; target: string; targetMounted: boolean;
  state: string; error: string; paused: boolean; autoPaused: boolean; days: number;
  globalBytes: number; localBytes: number; needBytes: number; localFiles: number; changedLocally: number;
}
interface PendingDevice { id: string; name: string; address: string; time: string }
interface PendingFolder { id: string; label: string; deviceId: string; deviceName: string; time: string }
interface SyncStatus {
  supported?: boolean; installed?: boolean; enabled?: boolean; active?: boolean; version?: string; apiOk?: boolean; apiError?: string;
  deviceId?: string; qr?: string; name?: string; nameOk?: boolean; ip?: string; port?: number;
  devices?: Device[]; folders?: Folder[]; pendingDevices?: PendingDevice[]; pendingFolders?: PendingFolder[]; targets?: Target[];
}
interface Job {
  state: 'idle' | 'running' | 'done' | 'failed'; id?: string; cmd?: string; step?: string; pct?: number; msg?: string;
  error?: string; log?: string[];
}

const DAYS = [7, 30, 90, 180, 365];
const FS_LABEL: Record<string, string> = { exfat: 'exFAT', vfat: 'FAT32', ntfs3: 'NTFS', fuseblk: 'NTFS', ext4: 'ext4' };
const DISMISS_KEY = 'pi5.sync.jobDismissed';

function size(b?: number | null): string {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  if (b <= 0) return '0';
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const targetLabel = (t?: Target) => (t ? (t.kind === 'internal' ? 'Dahili disk' : `USB: ${t.name}`) : '—');

async function copy(text: string) {
  if (await copyText(text)) toast.success('Kopyalandı');
  else toast.error('Kopyalanamadı — elle seçip kopyalayın');
}

// GET: sunucunun Türkçe hata metni korunur (409 = uydu)
class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(`/api${url}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, typeof body.error === 'string' && body.error ? body.error : `HTTP ${r.status}`);
  return body as T;
}
function readDismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
}

// Durum 10 sn'de bir (uyduda 409 → durur). Açma işi depolama işidir: iş sürerken 2 sn, değilse 15 sn'de bir; yalnız
// 'sync' işi gösterilir, bitince durum yenilenir.
function useSync() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [satellite, setSatellite] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tick, setTick] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [jobTick, setJobTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const d = await getJson<SyncStatus>('/sync');
        if (!alive) return;
        setStatus(d); setSatellite(false); setLoadError('');
        timer = window.setTimeout(load, 10000);
      } catch (e) {
        if (!alive) return;
        if (e instanceof HttpError && e.status === 409) { setSatellite(true); return; }
        setLoadError(e instanceof Error ? e.message : 'Durum okunamadı');
        timer = window.setTimeout(load, 10000);
      }
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [tick]);
  useEffect(() => {
    if (satellite) return;
    let alive = true;
    let timer: number | undefined;
    let prev: Job['state'] | undefined;
    const load = async () => {
      try {
        const j = await getJson<Job>('/storage/job');
        if (!alive) return;
        setJob(j.cmd === 'sync' ? j : null);
        if (j.cmd === 'sync' && prev === 'running' && j.state !== 'running') setTick(t => t + 1);
        prev = j.cmd === 'sync' ? j.state : undefined;
        timer = window.setTimeout(load, j.state === 'running' ? 2000 : 15000);
      } catch {
        if (alive) timer = window.setTimeout(load, 5000);
      }
    };
    void load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [jobTick, satellite]);
  return {
    status, satellite, loadError, job,
    reload: () => setTick(t => t + 1),
    jobStarted: () => { setJobTick(t => t + 1); setTick(t => t + 1); },
  };
}

function usePost(onOk?: () => void) {
  const [sending, setSending] = useState('');
  const send = async (key: string, url: string, body: Record<string, unknown>, okMsg?: string) => {
    setSending(key);
    try {
      const r = await postApi(url, body);
      if (okMsg) toast.success(okMsg);
      onOk?.();
      return r;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
      return null;
    } finally {
      setSending('');
    }
  };
  return { sending, send };
}

export function DeviceBackupPanel() {
  const { status, satellite, loadError, job, reload, jobStarted } = useSync();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [confirmOff, setConfirmOff] = useState(false);
  const running = job?.state === 'running';
  const st = status;

  const dismiss = () => {
    const id = job?.id || '';
    setDismissed(id);
    try { localStorage.setItem(DISMISS_KEY, id); } catch { /* yalnız bu oturum */ }
  };
  const panel = (body: React.ReactNode, actions?: React.ReactNode) => (
    <Panel title="Cihaz Yedekleme" icon={<HardDriveUpload size={20} style={{ marginRight: 8 }} />} className="dv-panel" actions={actions}
      subtitle="Bilgisayar, telefon ve tabletlerinizdeki klasörler Pi'nin diskine sürekli yedeklenir. Cihazda silinen dosya burada eski sürüm olarak kalır.">
      {body}
    </Panel>
  );

  if (satellite) {
    return panel(<div className="dv-note dv-note-info"><Satellite size={16} /><span>Uydu — cihaz yedekleme ana cihazdadır. Ana cihazın panelinden yönetin.</span></div>);
  }
  if (!st) {
    return panel(loadError
      ? <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>Cihaz yedekleme durumu okunamadı: {loadError}</span></div>
      : <div className="dv-loading"><Loader2 size={18} className="spin" /></div>);
  }
  if (!st.supported) return panel(<div className="empty-state" style={{ padding: 20 }}>Cihaz yedekleme yalnız Pi üzerinde çalışır.</div>);

  const showJob = job && job.state !== 'idle' && (job.state === 'running' || job.id !== dismissed);
  return panel(
    <>
      {showJob && <JobBanner job={job} onDismiss={dismiss} />}
      {st.enabled ? <OnView st={st} onChanged={reload} /> : <OffView st={st} busy={running} onStarted={jobStarted} />}
      {confirmOff && <DisableModal onClose={() => setConfirmOff(false)} onDone={() => { setConfirmOff(false); reload(); }} />}
    </>,
    st.enabled ? <button className="btn-outline btn-sm" disabled={running} onClick={() => setConfirmOff(true)}><Power size={13} /> Yedeklemeyi kapat</button> : undefined,
  );
}

function JobBanner({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
  const running = job.state === 'running';
  const pct = Math.max(0, Math.min(100, job.pct ?? 0));
  const cls = running ? 'dv-job-run' : job.state === 'done' ? 'dv-job-ok' : 'dv-job-bad';
  return (
    <section className={`dv-job ${cls}`} role="status" aria-live="polite">
      <div className="dv-job-head">
        {running ? <Loader2 size={18} className="spin" /> : job.state === 'done' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
        <div className="dv-job-title">
          <strong>{running ? 'Cihaz yedekleme açılıyor' : job.state === 'done' ? 'Cihaz yedekleme açıldı' : 'Cihaz yedekleme açılamadı'}</strong>
          <span>{running ? job.step || 'Başlatılıyor' : job.state === 'done' ? 'Şimdi cihazlarınızı aşağıdaki kimlikle ekleyin.' : job.error}</span>
        </div>
        {!running && <button className="btn-outline btn-sm" onClick={onDismiss}>Kapat</button>}
      </div>
      {running && <div className="dv-job-bar"><div style={{ width: `${pct}%` }} /></div>}
      {(job.log || []).length > 0 && (
        <details className="dv-job-log" open={job.state === 'failed'}>
          <summary>Ayrıntılı günlük</summary>
          <pre>{job.log!.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}

function Targets({ targets }: { targets: Target[] }) {
  return (
    <div className="dv-targets">
      {targets.map(t => (
        <div key={t.key} className="dv-target">
          {t.kind === 'internal' ? <HardDrive size={15} /> : <Usb size={15} />}
          <span className="dv-target-name">{targetLabel(t)}{t.mounted && t.fstype && t.kind === 'usb' ? ` (${FS_LABEL[t.fstype] || t.fstype})` : ''}</span>
          <span className="dv-target-free">{t.mounted ? `${size(t.free)} boş / ${size(t.size)}` : t.kind === 'internal' ? 'bağlı değil' : 'takılı değil'}</span>
        </div>
      ))}
    </div>
  );
}

function OffView({ st, busy, onStarted }: { st: SyncStatus; busy: boolean; onStarted: () => void }) {
  const { sending, send } = usePost();
  const targets = st.targets || [];
  const anyTarget = targets.some(t => t.mounted);
  const start = async () => {
    if (await send('enable', '/sync/enable', {})) onStarted();
  };
  return (
    <div className="dv-off">
      <p className="dv-help">
        Cihazlarınızdaki <strong>Syncthing</strong> uygulaması seçtiğiniz klasörleri (fotoğraflar, belgeler…) Pi'ye gönderir. Pi
        yalnız alır: cihazınızdaki hiçbir dosyayı değiştirmez. Değişen ya da silinen dosyanın eski sürümü burada seçtiğiniz süre
        kadar saklanır. Yedekler SD karta değil, aşağıdaki disklere yazılır.
      </p>
      <h4 className="dv-h"><HardDrive size={14} /> Yedek alanı</h4>
      <Targets targets={targets} />
      {!anyTarget && (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>
          Şu an yedek alanı yok: Depolama sayfasından veri diskini hazırlayın ya da bir USB diski <strong>Ağda paylaş</strong> ile ekleyin.
          Yine de açabilirsiniz; disk eklenince klasörler oraya yedeklenir.
        </span></div>
      )}
      <div className="dv-note dv-note-info"><ShieldCheck size={16} /><span>
        Yalnız ev ağındaki cihazlar ve Ev VPN'ine <strong>yönetici</strong> profiliyle bağlananlar yedekleyebilir; her yeni cihazı
        burada siz onaylarsınız. İnternete port açılmaz, Syncthing'in genel sunucuları kullanılmaz. İlk açılışta gerekli paketler
        kurulur (birkaç dakika).
      </span></div>
      <button className="btn-primary btn-sm dv-start" disabled={busy || sending === 'enable'} onClick={start}>
        {sending === 'enable' || busy ? <Loader2 size={13} className="spin" /> : <HardDriveUpload size={13} />} Cihaz yedeklemeyi aç
      </button>
    </div>
  );
}

function OnView({ st, onChanged }: { st: SyncStatus; onChanged: () => void }) {
  const targets = st.targets || [];
  const devices = st.devices || [];
  const folders = st.folders || [];
  const pd = st.pendingDevices || [];
  const pf = st.pendingFolders || [];
  if (!st.active) {
    return (
      <>
        <div className="dv-note dv-note-bad"><XCircle size={16} /><span>
          Yedekleme hizmeti çalışmıyor. Veri diski takılı değilse hizmet onu bekler; ayrıntı için Pi'de
          <code> journalctl -u klyrix-sync</code>. Paneli güncellemek ya da Pi'yi yeniden başlatmak hizmeti yeniden başlatır.
        </span></div>
        <h4 className="dv-h"><HardDrive size={14} /> Yedek alanı</h4>
        <Targets targets={targets} />
      </>
    );
  }
  if (!st.apiOk) {
    return <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>Hizmet yanıt vermiyor (yeni açıldıysa birkaç saniye içinde hazır olur): {st.apiError}</span></div>;
  }
  return (
    <>
      <Identity st={st} />
      <HowTo st={st} />
      {pd.length > 0 && <PendingDevices list={pd} onChanged={onChanged} />}
      {pf.length > 0 && <PendingFolders list={pf} targets={targets} onChanged={onChanged} />}
      <Devices list={devices} folders={folders} onChanged={onChanged} />
      <Folders list={folders} targets={targets} onChanged={onChanged} />
      <h4 className="dv-h"><HardDrive size={14} /> Yedek alanı</h4>
      <Targets targets={targets} />
      {targets.some(t => t.mounted && t.fstype === 'vfat') && (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>FAT32 biçimli USB diske 4 GB'tan büyük dosya (ör. uzun video) yazılamaz: büyük dosyalar için exFAT ya da ext4 disk seçin.</span></div>
      )}
    </>
  );
}

function Identity({ st }: { st: SyncStatus }) {
  const port = st.port || 22000;
  const addrs = [...(st.nameOk ? [`tcp://${st.name}:${port}`] : []), ...(st.ip ? [`tcp://${st.ip}:${port}`] : [])];
  return (
    <div className="dv-id">
      {st.qr ? <img className="dv-qr" src={st.qr} alt="Pi'nin cihaz kimliği (QR kodu)" width={164} height={164} /> : null}
      <div className="dv-id-body">
        <h4 className="dv-h" style={{ marginTop: 0 }}><Link2 size={14} /> Pi'nin cihaz kimliği</h4>
        <div className="dv-code-row"><code className="dv-code">{st.deviceId}</code>
          <button className="dv-copy" title="Kimliği kopyala" aria-label="Kimliği kopyala" onClick={() => void copy(st.deviceId || '')}><Copy size={13} /></button>
        </div>
        <p className="dv-hint">Cihazınızdaki Syncthing'de <strong>Uzak cihaz ekle</strong> → bu kimliği yapıştırın ya da QR kodunu taratın.</p>
        {addrs.length > 0 && (
          <>
            <p className="dv-hint" style={{ marginTop: 10 }}>
              Ev ağında Pi kendiliğinden bulunur. Evin dışından (Ev VPN'i açıkken) yedeklenecekse cihazın <strong>Gelişmiş</strong>{' '}
              sekmesinde <strong>Adresler</strong>'e şunu yazın:
            </p>
            {addrs.map(a => (
              <div key={a} className="dv-code-row"><code className="dv-code">{a}</code>
                <button className="dv-copy" title="Adresi kopyala" aria-label={`Kopyala: ${a}`} onClick={() => void copy(a)}><Copy size={13} /></button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function HowTo({ st }: { st: SyncStatus }) {
  const [open, setOpen] = useState(!(st.devices || []).length);
  return (
    <details className="dv-howto" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><Info size={14} /> Bir cihaz nasıl eklenir</summary>
      <ol>
        <li><Monitor size={14} /><span><strong>Windows / Mac / Linux:</strong> <code>syncthing.net</code> adresinden Syncthing'i kurun ve açın
          (tarayıcıda açılan arayüz). <strong>Uzak cihaz ekle</strong> → Pi'nin kimliğini yapıştırın.</span></li>
        <li><Smartphone size={14} /><span><strong>Android:</strong> <strong>Syncthing-Fork</strong> uygulamasını (F-Droid ya da Google Play) kurun →
          <strong> Cihazlar → +</strong> → QR kodunu taratın.</span></li>
        <li><Apple size={14} /><span><strong>iPhone / iPad:</strong> Klyrix mobil uygulaması hazırlanıyor; şimdilik bilgisayar ve Android desteklenir.</span></li>
        <li><Check size={14} /><span>Birkaç saniye içinde cihaz aşağıda <strong>Onay bekleyen cihazlar</strong>'da görünür: adını verip onaylayın.</span></li>
        <li><FolderSync size={14} /><span>Cihazda yedeklenecek klasörü Pi ile paylaşın (klasör → <strong>Paylaşım</strong> sekmesi → Klyrix). Klasör
          türünü <strong>Yalnız Gönder</strong> yapmanız önerilir. Klasör burada <strong>Onay bekleyen klasörler</strong>'de görünür: hedef diski seçip kabul edin.</span></li>
      </ol>
    </details>
  );
}

function PendingDevices({ list, onChanged }: { list: PendingDevice[]; onChanged: () => void }) {
  const { sending, send } = usePost(onChanged);
  const [names, setNames] = useState<Record<string, string>>({});
  return (
    <section className="dv-pending">
      <h4 className="dv-h"><Smartphone size={14} /> Onay bekleyen cihazlar <span className="dv-count">{list.length}</span></h4>
      {list.map(d => {
        const name = names[d.id] ?? (d.name || '');
        const ok = name.trim().length >= 1 && name.trim().length <= 40;
        return (
          <div key={d.id} className="dv-card dv-card-pending">
            <div className="dv-card-main">
              <strong>{d.name || 'Adsız cihaz'}</strong>
              <span className="dv-meta">{d.address ? `${d.address.replace(/:\d+$/, '')} · ` : ''}{when(d.time)}</span>
              <code className="dv-meta dv-mono">{d.id}</code>
              <div className="form-group dv-name">
                <label htmlFor={`dv-n-${d.id}`}>Bu cihazın adı</label>
                <input id={`dv-n-${d.id}`} value={name} maxLength={40} placeholder="ör. Ayşe'nin dizüstü"
                  onChange={e => setNames(n => ({ ...n, [d.id]: e.target.value }))} />
              </div>
            </div>
            <div className="dv-card-actions">
              <button className="btn-primary btn-sm" disabled={!ok || !!sending}
                onClick={() => void send(`a-${d.id}`, '/sync/devices/accept', { id: d.id, name: name.trim() }, `${name.trim()} onaylandı`)}>
                {sending === `a-${d.id}` ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Onayla
              </button>
              <button className="btn-outline btn-sm" disabled={!!sending} title="Cihaz yeniden bağlanmaya çalışırsa yine görünür"
                onClick={() => void send(`r-${d.id}`, '/sync/devices/reject', { id: d.id })}>
                <X size={13} /> Yoksay
              </button>
            </div>
          </div>
        );
      })}
      <p className="dv-hint">Tanımadığınız bir cihazı onaylamayın. Onaylanmamış cihaz hiçbir şey gönderemez ve göremez.</p>
    </section>
  );
}

function PendingFolders({ list, targets, onChanged }: { list: PendingFolder[]; targets: Target[]; onChanged: () => void }) {
  const { sending, send } = usePost(onChanged);
  const usable = targets.filter(t => t.mounted);
  const [choice, setChoice] = useState<Record<string, { target: string; days: number }>>({});
  return (
    <section className="dv-pending">
      <h4 className="dv-h"><FolderSync size={14} /> Onay bekleyen klasörler <span className="dv-count">{list.length}</span></h4>
      {!usable.length && (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>Takılı bir yedek diski yok: Depolama sayfasından veri diskini hazırlayın ya da bir USB diski <strong>Ağda paylaş</strong> ile ekleyin.</span></div>
      )}
      {list.map(f => {
        const k = `${f.deviceId}/${f.id}`;
        const c = choice[k] || { target: usable[0]?.key || '', days: 30 };
        const set = (p: Partial<typeof c>) => setChoice(s => ({ ...s, [k]: { ...c, ...p } }));
        return (
          <div key={k} className="dv-card dv-card-pending">
            <div className="dv-card-main">
              <strong>{f.label || f.id}</strong>
              <span className="dv-meta">{f.deviceName} yedeklemek istiyor · {when(f.time)}</span>
              <div className="dv-choose">
                <div className="form-group">
                  <label>Hedef disk</label>
                  <Select value={c.target} onChange={e => set({ target: e.target.value })} disabled={!usable.length}>
                    {targets.map(t => (
                      <option key={t.key} value={t.key} disabled={!t.mounted}>
                        {targetLabel(t)}{t.mounted ? ` — ${size(t.free)} boş` : ' (takılı değil)'}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="form-group">
                  <label>Eski sürümleri sakla</label>
                  <Select value={String(c.days)} onChange={e => set({ days: Number(e.target.value) })}>
                    {DAYS.map(d => <option key={d} value={d}>{d} gün</option>)}
                  </Select>
                </div>
              </div>
            </div>
            <div className="dv-card-actions">
              <button className="btn-primary btn-sm" disabled={!c.target || !!sending}
                onClick={() => void send(`a-${k}`, '/sync/folders/accept', { deviceId: f.deviceId, folderId: f.id, target: c.target, days: c.days }, `${f.label || f.id} yedeklenmeye başladı`)}>
                {sending === `a-${k}` ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Kabul et
              </button>
              <button className="btn-outline btn-sm" disabled={!!sending}
                onClick={() => void send(`r-${k}`, '/sync/folders/reject', { deviceId: f.deviceId, folderId: f.id })}>
                <X size={13} /> Yoksay
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Devices({ list, folders, onChanged }: { list: Device[]; folders: Folder[]; onChanged: () => void }) {
  const [remove, setRemove] = useState<Device | null>(null);
  return (
    <section>
      <h4 className="dv-h"><Monitor size={14} /> Cihazlar <span className="dv-count">{list.length}</span></h4>
      {!list.length && <div className="dv-empty">Henüz cihaz yok — yukarıdaki adımlarla ilk cihazınızı ekleyin.</div>}
      {list.map(d => {
        const n = folders.filter(f => f.deviceId === d.id).length;
        return (
          <div key={d.id} className="dv-card">
            <div className="dv-card-main">
              <strong>{d.name}</strong>
              <span className="dv-meta">
                {d.connected ? d.address.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '') : `Son görülme: ${when(d.lastSeen)}`}
                {` · ${n} klasör`}
              </span>
            </div>
            <span className={`dv-chip ${d.connected ? 'dv-chip-ok' : 'dv-chip-off'}`}>{d.connected ? 'bağlı' : 'çevrim dışı'}</span>
            <button className="dv-icon-btn" title="Cihazı kaldır" aria-label={`${d.name} cihazını kaldır`} onClick={() => setRemove(d)}><Trash2 size={14} /></button>
          </div>
        );
      })}
      {remove && <RemoveDeviceModal device={remove} folders={folders.filter(f => f.deviceId === remove.id).length}
        onClose={() => setRemove(null)} onDone={() => { setRemove(null); onChanged(); }} />}
    </section>
  );
}

function folderState(f: Folder): { text: string; cls: string } {
  if (f.paused && (f.autoPaused || !f.targetMounted)) return { text: 'disk takılı değil', cls: 'dv-chip-warn' };
  if (f.paused) return { text: 'duraklatıldı', cls: 'dv-chip-off' };
  if (f.state === 'error') return { text: 'hata', cls: 'dv-chip-bad' };
  if (f.state === 'scanning' || f.state === 'scan-waiting') return { text: 'taranıyor', cls: 'dv-chip-run' };
  if (f.needBytes > 0 || f.state === 'syncing' || f.state === 'sync-preparing' || f.state === 'sync-waiting') {
    const pct = f.globalBytes > 0 ? Math.floor((1 - f.needBytes / f.globalBytes) * 100) : 0;
    return { text: `eşitleniyor %${Math.max(0, Math.min(99, pct))}`, cls: 'dv-chip-run' };
  }
  if (f.state === 'idle') return { text: 'güncel', cls: 'dv-chip-ok' };
  return { text: f.state || '—', cls: 'dv-chip-off' };
}

function Folders({ list, targets, onChanged }: { list: Folder[]; targets: Target[]; onChanged: () => void }) {
  const { sending, send } = usePost(onChanged);
  const [edit, setEdit] = useState<Folder | null>(null);
  const [remove, setRemove] = useState<Folder | null>(null);
  return (
    <section>
      <h4 className="dv-h"><FolderSync size={14} /> Yedeklenen klasörler <span className="dv-count">{list.length}</span></h4>
      {!list.length && <div className="dv-empty">Henüz klasör yok — cihazda bir klasörü Pi ile paylaşınca burada onay için görünür.</div>}
      {list.map(f => {
        const s = folderState(f);
        const t = targets.find(x => x.key === f.target);
        return (
          <div key={f.id} className="dv-card dv-card-folder">
            <div className="dv-card-main">
              <strong>{f.label}</strong>
              <span className="dv-meta">{targetLabel(t)} · {size(f.localBytes)} · {f.localFiles} dosya{f.days ? ` · eski sürümler ${f.days} gün` : ''}</span>
              <code className="dv-meta dv-mono">{f.path}</code>
              {f.state === 'error' && f.error && !f.paused && <span className="dv-meta dv-bad">{f.error}</span>}
              {f.changedLocally > 0 && <span className="dv-meta">Pi'de elle değiştirilmiş {f.changedLocally} dosya var (cihaza gönderilmez).</span>}
            </div>
            <span className={`dv-chip ${s.cls}`}>{s.text}</span>
            <div className="dv-row-actions">
              {f.paused
                ? <button className="dv-icon-btn" title="Sürdür" aria-label={`${f.label} sürdür`} disabled={!!sending || !f.targetMounted}
                    onClick={() => void send(`p-${f.id}`, '/sync/folders/update', { id: f.id, paused: false })}><Play size={14} /></button>
                : <button className="dv-icon-btn" title="Duraklat" aria-label={`${f.label} duraklat`} disabled={!!sending}
                    onClick={() => void send(`p-${f.id}`, '/sync/folders/update', { id: f.id, paused: true })}><Pause size={14} /></button>}
              <button className="dv-icon-btn" title="Ayarlar" aria-label={`${f.label} ayarları`} onClick={() => setEdit(f)}><Settings2 size={14} /></button>
              <button className="dv-icon-btn" title="Yedeklemeyi bırak" aria-label={`${f.label} yedeklemeyi bırak`} onClick={() => setRemove(f)}><Trash2 size={14} /></button>
            </div>
          </div>
        );
      })}
      {edit && <FolderModal folder={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); onChanged(); }} />}
      {remove && <RemoveFolderModal folder={remove} onClose={() => setRemove(null)} onDone={() => { setRemove(null); onChanged(); }} />}
    </section>
  );
}

function FolderModal({ folder, onClose, onDone }: { folder: Folder; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = useState(folder.days || 30);
  const { sending, send } = usePost(onDone);
  const opts = DAYS.includes(days) ? DAYS : [...DAYS, days].sort((a, b) => a - b);
  return (
    <Modal open onClose={onClose} title={folder.label} width={420}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={!!sending || days === folder.days}
            onClick={() => void send('d', '/sync/folders/update', { id: folder.id, days }, 'Kaydedildi')}>
            {sending ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Kaydet
          </button>
        </>
      }>
      <div className="form-group">
        <label>Eski sürümleri sakla</label>
        <Select value={String(days)} onChange={e => setDays(Number(e.target.value))}>
          {opts.map(d => <option key={d} value={d}>{d} gün</option>)}
        </Select>
      </div>
      <p className="dv-hint">
        Cihazda değişen ya da silinen dosyanın önceki hâli Pi'de bu süre kadar kalır (yakın tarihli sürümler sık, eskiler seyrek
        tutulur). Eski sürümler yedek klasöründeki <code>.stversions</code> içindedir.
      </p>
    </Modal>
  );
}

function RemoveFolderModal({ folder, onClose, onDone }: { folder: Folder; onClose: () => void; onDone: () => void }) {
  const { sending, send } = usePost(onDone);
  return (
    <Modal open onClose={onClose} title="Yedeklemeyi bırak" width={440}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={!!sending}
            onClick={() => void send('x', '/sync/folders/remove', { id: folder.id }, 'Klasörün yedeklenmesi bırakıldı')}>
            {sending ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Bırak
          </button>
        </>
      }>
      <p className="dv-help" style={{ marginTop: 0 }}>
        <strong>{folder.label}</strong> artık yedeklenmez. Şimdiye kadarki yedekler diskte kalır: <code>{folder.path}</code>.
        Cihazdaki klasöre dokunulmaz.
      </p>
    </Modal>
  );
}

function RemoveDeviceModal({ device, folders, onClose, onDone }: { device: Device; folders: number; onClose: () => void; onDone: () => void }) {
  const { sending, send } = usePost(onDone);
  return (
    <Modal open onClose={onClose} title="Cihazı kaldır" width={440}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={!!sending}
            onClick={() => void send('x', '/sync/devices/remove', { id: device.id }, `${device.name} kaldırıldı`)}>
            {sending ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Kaldır
          </button>
        </>
      }>
      <p className="dv-help" style={{ marginTop: 0 }}>
        <strong>{device.name}</strong> artık Pi'ye bağlanamaz{folders ? ` ve ${folders} klasörünün yedeklenmesi bırakılır` : ''}.
        Şimdiye kadarki yedekler diskte kalır. Cihazı yeniden eklemek için cihazdan yeniden bağlanıp onaylamanız yeterli.
      </p>
    </Modal>
  );
}

function DisableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { sending, send } = usePost(onDone);
  return (
    <Modal open onClose={onClose} title="Cihaz yedeklemeyi kapat" width={440}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={!!sending}
            onClick={() => void send('off', '/sync/disable', {}, 'Cihaz yedekleme kapatıldı')}>
            {sending ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Evet, kapat
          </button>
        </>
      }>
      <p className="dv-help" style={{ marginTop: 0 }}>
        Cihazlar yedekleme yapamaz. Yedekler, onaylı cihazlar ve klasör ayarları kalır; yeniden açınca kaldığı yerden sürer.
      </p>
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import {
  HardDrive, MemoryStick, Usb, Thermometer, AlertTriangle, Info, Database, Loader2, Archive, Eraser, ArrowRightLeft,
  CheckCircle2, XCircle, FolderOpen, Share2,
} from 'lucide-react';
import { useApi, getApi, postApi } from '../hooks/useApi';
import { Modal, Panel } from './ui';
import './StoragePanel.css';

// Depolama (backend storage.ts): takılı diskler ve bölümleri, doluluk, disk sıcaklığı ve panel verilerinin /
// Pi-hole sorgu veritabanının / günlüklerin hangi diskte durduğu. Dashboard'daki "Disk" satırı yalnız bağlı bölümleri
// toplar; bağlı olmayan bölümler (ör. eski bir sistemden kalan) yalnız burada görünür.
// Veri diski işleri (scripts/storage.sh): eski sistemi SD karta arşivle, diski hazırla (SİLER), verileri diske taşı. İş
// panel servisinin dışında koşar; hazırlama ve taşıma servisi bir süre durdurur — ilerleme şeridi bağlantıyı bekler.
type DiskKind = 'sd' | 'nvme' | 'usb' | 'other';
interface Part {
  name: string; path: string; size: number; fstype: string; label: string; uuid: string;
  mounts: string[]; fsSize: number | null; fsUsed: number | null; fsAvail: number | null; note: string; archivable?: boolean;
}
interface Disk {
  name: string; path: string; size: number; model: string; tran: string; removable: boolean; kind: DiskKind;
  role: 'system' | 'data' | 'external' | 'unused'; tempC: number | null; parts: Part[]; preparable?: boolean;
}
interface Placement { key: string; label: string; path: string; device: string; mount: string; kind: DiskKind | 'unknown' }
interface Layout { dataDev: string; dataMounted: boolean; shareDev: string; shareMounted: boolean }
interface Status {
  supported?: boolean; disks?: Disk[]; placement?: Placement[]; findings?: { level: 'info' | 'warn'; text: string }[];
  layout?: Layout; archives?: string[];
}
type Cmd = 'archive' | 'prepare' | 'migrate';
interface Job {
  state: 'idle' | 'running' | 'done' | 'failed'; id?: string; cmd?: Cmd; step?: string; pct?: number; msg?: string;
  error?: string; startedAt?: number; finishedAt?: number; log?: string[];
}

const KIND = { sd: 'SD kart', nvme: 'NVMe SSD', usb: 'USB disk', other: 'Disk' } as const;
const ROLE = { system: 'Sistem diski', data: 'Veri diski', external: 'Harici disk', unused: 'Kullanılmıyor' } as const;
const CMD_LABEL: Record<Cmd, string> = { archive: 'Eski sistem arşivi', prepare: 'Disk hazırlama', migrate: 'Verileri diske taşıma' };
const GIB = 2 ** 30;
const DISMISS_KEY = 'pi5.storage.jobDismissed';

function size(b: number | null): string {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}
const KindIcon = ({ kind }: { kind: DiskKind }) => (kind === 'sd' ? <MemoryStick size={18} /> : kind === 'usb' ? <Usb size={18} /> : <HardDrive size={18} />);
// storage.sh ile aynı: diskin model adı, yoksa GB (10^9) cinsinden boyutu
const confirmText = (d: Disk) => d.model || String(Math.floor(d.size / 1e9));

function readDismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
}

// İş durumu: sürerken 2 sn'de bir; panel servisi kapalıyken (hazırlama / taşıma) hata alınır → 3 sn'de bir yeniden dener.
function useStorageJob() {
  const [job, setJob] = useState<Job | null>(null);
  const [offline, setOffline] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const j = await getApi<Job>('/storage/job');
        if (!alive) return;
        setJob(j);
        setOffline(false);
        timer = window.setTimeout(load, j.state === 'running' ? 2000 : 15000);
      } catch {
        if (!alive) return;
        setOffline(true);
        timer = window.setTimeout(load, 3000);
      }
    };
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [tick]);
  return { job, offline, refresh: () => setTick(t => t + 1) };
}

export function StoragePanel() {
  const { data, loading, refetch } = useApi<Status>('/storage', {}, 15000);
  const { job, offline, refresh } = useStorageJob();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [prepare, setPrepare] = useState<Disk | null>(null);
  const [archive, setArchive] = useState<Part | null>(null);
  const [migrate, setMigrate] = useState(false);
  const disks = data.disks || [];
  const hasExtra = disks.some(d => d.kind !== 'sd');
  const busy = job?.state === 'running';
  const layout = data.layout;
  const canMigrate = !!layout?.dataMounted && (data.placement || []).some(p => p.kind === 'sd');

  // İş bitince disk listesini hemen yenile (bölümler, bağlama noktaları, verilerin yeri değişti)
  const prevState = useRef<Job['state'] | undefined>(undefined);
  useEffect(() => {
    if (prevState.current === 'running' && job && job.state !== 'running') void refetch();
    prevState.current = job?.state;
  }, [job, refetch]);

  const dismiss = () => {
    const id = job?.id || '';
    setDismissed(id);
    try { localStorage.setItem(DISMISS_KEY, id); } catch { /* yalnız bu oturum */ }
  };
  const started = () => { refresh(); void refetch(); };
  const showJob = job && job.state !== 'idle' && (job.state === 'running' || job.id !== dismissed);

  return (
    <div className="fade-in">
      {showJob && <JobBanner job={job} offline={offline} onDismiss={dismiss} />}
      <Panel title="Depolama" icon={<HardDrive size={20} style={{ marginRight: 8 }} />}
        subtitle="Takılı diskler, bölümleri, doluluk ve panelin verilerinin hangi diskte durduğu">
        {loading && !data.disks && <div className="st-loading"><Loader2 size={18} className="spin" /></div>}
        {data.supported === false && <div className="empty-state" style={{ padding: 20 }}>Depolama bilgisi yalnız Pi üzerinde okunur.</div>}
        {(data.findings || []).map((f, i) => (
          <div key={i} className={`routing-apply ${f.level === 'warn' ? 'routing-apply-err' : ''}`} style={{ marginTop: 10 }}>
            {f.level === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}<span>{f.text}</span>
          </div>
        ))}

        {(data.placement || []).length > 0 && (
          <div className="st-place">
            <div className="st-place-head">
              <h4><Database size={14} /> Verilerin yeri</h4>
              {canMigrate && (
                <button className="btn-primary btn-sm" disabled={busy} onClick={() => setMigrate(true)}>
                  <ArrowRightLeft size={13} /> Verileri diske taşı
                </button>
              )}
            </div>
            {data.placement!.map(p => {
              const onDisk = p.kind === 'nvme' || p.kind === 'usb' || p.kind === 'other';
              return (
                <div key={p.key} className="st-place-row">
                  <span className="st-place-label">{p.label}</span>
                  <span className="st-place-where">
                    <code>{p.device || '?'}</code>{p.mount && p.mount !== '/' ? <> · <code>{p.mount}</code></> : null}
                  </span>
                  <span className={`st-chip ${onDisk ? 'st-chip-ok' : hasExtra ? 'st-chip-warn' : ''}`}>
                    {p.kind === 'unknown' ? 'bilinmiyor' : KIND[p.kind]}
                  </span>
                </div>
              );
            })}
            {layout?.shareDev && (
              <div className="st-place-row">
                <span className="st-place-label"><Share2 size={13} /> Paylaşım alanı</span>
                <span className="st-place-where">
                  <code>{layout.shareDev}</code>{layout.shareMounted ? <> · <code>/mnt/klyrix-share</code></> : ' · bağlı değil'}
                </span>
                <span className="st-chip">ağda paylaşım henüz kapalı</span>
              </div>
            )}
          </div>
        )}

        {(data.archives || []).length > 0 && (
          <div className="st-place">
            <h4><FolderOpen size={14} /> Eski sistem arşivleri (SD kartta)</h4>
            {data.archives!.map(a => <div key={a} className="st-archive"><code>{a}</code></div>)}
          </div>
        )}
      </Panel>

      <div className="st-disks">
        {disks.map(d => (
          <DiskCard key={d.name} d={d} busy={busy} onPrepare={() => setPrepare(d)} onArchive={p => setArchive(p)} />
        ))}
      </div>

      {prepare && (
        <PrepareModal disk={prepare} archives={data.archives || []} onClose={() => setPrepare(null)}
          onStarted={() => { setPrepare(null); started(); }} />
      )}
      {archive && (
        <ArchiveModal part={archive} sdFree={disks.find(d => d.role === 'system')?.parts.find(p => p.mounts.includes('/'))?.fsAvail ?? null}
          onClose={() => setArchive(null)} onStarted={() => { setArchive(null); started(); }} />
      )}
      {migrate && (
        <MigrateModal placement={(data.placement || []).filter(p => p.kind === 'sd')} onClose={() => setMigrate(false)}
          onStarted={() => { setMigrate(false); started(); }} />
      )}
    </div>
  );
}

function JobBanner({ job, offline, onDismiss }: { job: Job; offline: boolean; onDismiss: () => void }) {
  const label = job.cmd ? CMD_LABEL[job.cmd] : 'Depolama işi';
  const running = job.state === 'running';
  const pct = Math.max(0, Math.min(100, job.pct ?? 0));
  const cls = running ? 'st-job-run' : job.state === 'done' ? 'st-job-ok' : 'st-job-bad';
  return (
    <section className={`glass-panel st-job ${cls}`} role="status" aria-live="polite">
      <div className="st-job-head">
        {running ? <Loader2 size={18} className="spin" /> : job.state === 'done' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
        <div className="st-job-title">
          <strong>{running ? `${label} sürüyor` : job.state === 'done' ? `${label} tamamlandı` : `${label} başarısız`}</strong>
          <span>{running ? job.step || 'Başlatılıyor' : job.state === 'done' ? job.msg : job.error}</span>
        </div>
        {!running && <button className="btn-outline btn-sm" onClick={onDismiss}>Kapat</button>}
      </div>
      {running && (
        <>
          <div className="st-job-bar"><div style={{ width: `${pct}%` }} /></div>
          {offline ? (
            <p className="st-job-note">
              Panel servisi bu adımda kısa süre kapalı; iş arka planda sürüyor. Sayfa kendiliğinden yeniden bağlanır —
              Pi'yi kapatmayın, diski çıkarmayın.
            </p>
          ) : job.cmd !== 'archive' && (
            <p className="st-job-note">İş sırasında panel yaklaşık bir dakika kapanır, DNS birkaç saniye kesilebilir. Pi'yi kapatmayın.</p>
          )}
        </>
      )}
      {(job.log || []).length > 0 && (
        <details className="st-job-log" open={job.state === 'failed'}>
          <summary>Ayrıntılı günlük</summary>
          <pre>{job.log!.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}

function DiskCard({ d, busy, onPrepare, onArchive }: { d: Disk; busy: boolean; onPrepare: () => void; onArchive: (p: Part) => void }) {
  const total = d.size || d.parts.reduce((a, p) => a + p.size, 0) || 1;
  return (
    <section className={`glass-panel st-disk st-disk-${d.role}`}>
      <div className="st-disk-head">
        <span className="st-disk-icon"><KindIcon kind={d.kind} /></span>
        <div className="st-disk-title">
          <strong>{d.model || (d.kind === 'sd' ? 'SD kart' : d.name)}</strong>
          <span><code>{d.path}</code> · {size(d.size)}</span>
        </div>
        <div className="st-chips">
          <span className="st-chip">{KIND[d.kind]}</span>
          <span className={`st-chip ${d.role === 'unused' ? 'st-chip-warn' : d.role === 'data' ? 'st-chip-ok' : ''}`}>{ROLE[d.role]}</span>
          {d.tempC != null && (
            <span className={`st-chip ${d.tempC >= 70 ? 'st-chip-bad' : d.tempC >= 55 ? 'st-chip-warn' : ''}`}><Thermometer size={12} /> {d.tempC.toFixed(0)}°C</span>
          )}
        </div>
      </div>

      {/* Bölüm çubuğu: genişlik bölüm boyutuyla orantılı; bağlı bölümlerde doluluk koyu dolgu */}
      <div className="st-bar" aria-hidden="true">
        {d.parts.map(p => {
          const used = p.fsSize && p.fsUsed != null ? Math.min(100, (p.fsUsed / p.fsSize) * 100) : 0;
          const state = p.mounts.length ? 'on' : p.fstype ? 'off' : 'raw';
          return (
            <div key={p.name} className={`st-seg st-seg-${state}`} style={{ flexGrow: Math.max(p.size / total, 0.012) }} title={`${p.name} · ${size(p.size)}`}>
              {state === 'on' && <div className="st-seg-used" style={{ width: `${used}%` }} />}
            </div>
          );
        })}
      </div>

      <div className="st-parts">
        {d.parts.length === 0 && <div className="st-part st-muted">Bölüm yok (boş disk)</div>}
        {d.parts.map(p => {
          const used = p.fsSize && p.fsUsed != null ? (p.fsUsed / p.fsSize) * 100 : null;
          return (
            <div key={p.name} className="st-part">
              <div className="st-part-main">
                <code className="st-part-name">{p.name}</code>
                <span className="st-part-note">{p.note}</span>
                <span className="st-part-meta">
                  {size(p.size)}{p.fstype ? ` · ${p.fstype}` : ''}{p.label ? ` · etiket "${p.label}"` : ''}
                </span>
              </div>
              {used != null ? (
                <div className="st-part-usage">
                  <div className="st-meter"><div className="st-meter-fill" style={{ width: `${Math.min(100, used)}%` }} data-level={used >= 90 ? 'bad' : used >= 75 ? 'warn' : 'ok'} /></div>
                  <span>{size(p.fsUsed)} / {size(p.fsSize)} kullanıldı</span>
                </div>
              ) : p.archivable ? (
                <button className="btn-outline btn-sm st-part-action" disabled={busy} onClick={() => onArchive(p)}>
                  <Archive size={13} /> SD karta arşivle
                </button>
              ) : (
                <span className="st-part-usage st-muted">{p.mounts.length ? p.mounts.join(', ') : 'bağlı değil'}</span>
              )}
            </div>
          );
        })}
      </div>

      {d.preparable && (
        <div className="st-disk-actions">
          <span className="st-muted">
            {d.parts.some(p => p.label === 'klyrix-data') ? 'Veri diski olarak kullanılıyor.' : 'Panel verileri, Pi-hole ve günlükler için veri diski yapılabilir.'}
          </span>
          <button className="btn-outline btn-sm st-btn-danger" disabled={busy} onClick={onPrepare}>
            <Eraser size={13} /> Diski hazırla
          </button>
        </div>
      )}
    </section>
  );
}

function PrepareModal({ disk, archives, onClose, onStarted }: { disk: Disk; archives: string[]; onClose: () => void; onStarted: () => void }) {
  const totalGib = Math.floor(disk.size / GIB);
  const maxGb = totalGib - 8;
  const canShare = maxGb >= 8;
  const [share, setShare] = useState(canShare && totalGib >= 128);
  const [gb, setGb] = useState(String(Math.min(64, Math.max(8, maxGb))));
  const [typed, setTyped] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const expect = confirmText(disk);
  const gbNum = Number(gb);
  const gbOk = !share || (Number.isInteger(gbNum) && gbNum >= 8 && gbNum <= maxGb);
  const ok = gbOk && typed.trim() === expect && !sending;
  const oldSystem = disk.parts.some(p => p.label === 'rootfs' || p.archivable);
  const shareGib = share && gbOk ? disk.size / GIB - gbNum : 0;

  const submit = async () => {
    setSending(true);
    setErr('');
    try {
      await postApi('/storage/prepare', { disk: disk.path, share, systemGb: share ? gbNum : undefined, confirm: typed.trim() });
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Başlatılamadı');
      setSending(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Diski hazırla — ${disk.model || disk.name}`} width={540}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm st-btn-danger-solid" disabled={!ok} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin" /> : <Eraser size={13} />} Diski sil ve hazırla
          </button>
        </>
      }>
      <div className="st-danger-box">
        <AlertTriangle size={16} />
        <div>
          <strong>{disk.path} üzerindeki her şey silinir.</strong>
          {disk.parts.length > 0 ? (
            <ul>
              {disk.parts.map(p => (
                <li key={p.name}><code>{p.name}</code> · {size(p.size)}{p.label ? ` · "${p.label}"` : ''} — {p.note}</li>
              ))}
            </ul>
          ) : <span> Disk şu an boş.</span>}
        </div>
      </div>
      {oldSystem && archives.length === 0 && (
        <div className="routing-apply routing-apply-err" style={{ marginTop: 10 }}>
          <AlertTriangle size={14} />
          <span>Diskte eski bir sistem var ve arşivi yok. Önce bölümün yanındaki «SD karta arşivle» ile eski dosyaları kopyalamanız önerilir.</span>
        </div>
      )}

      <h5 className="st-modal-h">Düzen</h5>
      <label className={`st-check ${canShare ? '' : 'st-muted'}`}>
        <input type="checkbox" checked={share} disabled={!canShare} onChange={e => setShare(e.target.checked)} />
        <span>Ağ paylaşımı için ayrı bölüm {canShare ? '' : '(disk bunun için küçük)'}</span>
      </label>
      {share && (
        <div className="form-group" style={{ marginTop: 10 }}>
          <label htmlFor="st-gb">Sistem verileri bölümü (GB, 8–{maxGb})</label>
          <input id="st-gb" type="number" inputMode="numeric" min={8} max={maxGb} value={gb} onChange={e => setGb(e.target.value)} />
        </div>
      )}
      <div className="st-layout">
        <div className="st-layout-seg st-layout-data" style={{ flexGrow: share && gbOk ? gbNum : 1 }}>
          <span>Sistem verileri</span><strong>{share ? (gbOk ? `${gbNum} GB` : '?') : `${totalGib} GB`}</strong>
        </div>
        {share && (
          <div className="st-layout-seg st-layout-share" style={{ flexGrow: Math.max(shareGib, 1) }}>
            <span>Paylaşım</span><strong>{gbOk ? `~${Math.floor(shareGib)} GB` : '?'}</strong>
          </div>
        )}
      </div>
      <p className="st-help">
        Sistem verileri bölümüne panel verileri, Pi-hole sorgu veritabanı ve günlükler taşınır; işletim sistemi SD kartta kalır.
        Disk sonradan çıkarılır ya da bozulursa panel SD karttaki kopyayla açılır. İş sırasında panel yaklaşık bir dakika
        kapanır, DNS birkaç saniye kesilir.{share ? ' Paylaşım bölümü şimdilik boş durur; ağda paylaşım ayrıca açılacak.' : ''}
      </p>

      <div className="form-group" style={{ marginTop: 12 }}>
        <label htmlFor="st-confirm">Onaylamak için <code>{expect}</code> yazın</label>
        <input id="st-confirm" value={typed} autoComplete="off" spellCheck={false} onChange={e => setTyped(e.target.value)} />
      </div>
      {err && <div className="routing-apply routing-apply-err"><XCircle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}

function ArchiveModal({ part, sdFree, onClose, onStarted }: { part: Part; sdFree: number | null; onClose: () => void; onStarted: () => void }) {
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setSending(true);
    setErr('');
    try {
      await postApi('/storage/archive', { src: part.path });
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Başlatılamadı');
      setSending(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Eski sistemi arşivle — ${part.name}`} width={480}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={sending} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin" /> : <Archive size={13} />} Arşivle
          </button>
        </>
      }>
      <p className="st-help" style={{ marginTop: 0 }}>
        <code>{part.path}</code> ({size(part.size)}{part.label ? `, etiket "${part.label}"` : ''}) salt okunur bağlanır; içindeki
        <code> /home</code>, <code>/root</code>, <code>/opt</code>, <code>/etc</code> ve <code>/srv</code> klasörleri SD karta,
        ev klasörünüzdeki <code>eski-sistem-arsivi-TARİH</code> klasörüne kopyalanır. Bölümde hiçbir şey değişmez.
      </p>
      <p className="st-help">
        SD kartta boş yer: <strong>{size(sdFree)}</strong>. Yer yetmezse iş başlamadan durur (gereken boyut hesaplanır).
        Büyük arşivler birkaç dakika sürebilir; panel bu sırada çalışmaya devam eder.
      </p>
      {err && <div className="routing-apply routing-apply-err"><XCircle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}

function MigrateModal({ placement, onClose, onStarted }: { placement: Placement[]; onClose: () => void; onStarted: () => void }) {
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setSending(true);
    setErr('');
    try {
      await postApi('/storage/migrate', {});
      onStarted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Başlatılamadı');
      setSending(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Verileri diske taşı" width={460}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={sending} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin" /> : <ArrowRightLeft size={13} />} Taşı
          </button>
        </>
      }>
      <p className="st-help" style={{ marginTop: 0 }}>SD kartta duranlar veri diskine taşınır:</p>
      <ul className="st-list">{placement.map(p => <li key={p.key}>{p.label}</li>)}</ul>
      <p className="st-help">
        SD kartta bir kopya kalır: disk sonradan çıkarılırsa panel onunla açılır. İş sırasında panel yaklaşık bir dakika
        kapanır, DNS birkaç saniye kesilir. Pi-hole yeni yerde açılamazsa eski yerinde bırakılır.
      </p>
      {err && <div className="routing-apply routing-apply-err"><XCircle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}

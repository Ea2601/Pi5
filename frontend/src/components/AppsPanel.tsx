import { useEffect, useState } from 'react';
import {
  Package, CheckCircle2, XCircle, Loader2, AlertTriangle, Info, Play, Square, Trash2, ExternalLink, Power, Download, ShieldCheck, Undo2,
} from 'lucide-react';
import { useApi, postApi, putApi, getApi } from '../hooks/useApi';
import { Panel } from './ui';
import { toast } from '../toast';
import './AppsPanel.css';

// Uygulamalar (G3.3; backend apps.ts + scripts/apps.sh, /api/apps): NVMe veri diskli ana cihazda Podman konteyner
// uygulamaları. Sihirbaz sıralı: 1) uygunluk → 2) motor (5 dk deneme → Kalıcı yap) → 3) katalog (kur → sağlık → aç /
// durdur / kaldır). Yalnız sıradaki adım parlak; öncekiler tamamlandı, sonrakiler kilitli. Düğme rengi = ne yaptığı: açan /
// kuran / başlatan yeşil, kapatan / geri alan / kaldıran kırmızı.
interface Check { key: string; label: string; ok: boolean; detail: string }
interface Job {
  state: 'idle' | 'running' | 'done' | 'failed'; id?: string; cmd?: string; app?: string; step?: string; pct?: number;
  msg?: string; error?: string; log?: string[];
}
interface CatalogApp {
  id: string; name: string; summary: string; version: string; port: number; scheme: 'http' | 'https'; minMemMiB: number; diskMB: number;
  lanAccessOption: boolean; usbOption: boolean; signupsOption: boolean; tls: boolean; notes: string[]; valid: boolean; warnings: string[];
  memOk: boolean; installed: boolean; lanAccess: boolean; usbDevice: string | null; signups: boolean; dataExists: boolean;
  health: 'ok' | 'starting' | 'stopped' | 'failed' | null;
}
interface AppsResp {
  supported: boolean;
  eligibility?: { ok: boolean; checks: Check[]; memClassMiB: number | null; onBackup: boolean };
  engine?: { stage: 'off' | 'trial' | 'on'; trialEnds: number; installed: boolean; trialSeconds: number; rolledBackAt?: number | null };
  now?: number; job?: Job; catalog?: CatalogApp[]; excluded?: { name: string; reason: string }[]; openHost?: string;
  freeMb?: number | null; network?: { name: string; subnet: string }; dns?: { listening: string; ok: boolean };
  error?: string;
}
const EMPTY: AppsResp = { supported: true };
const HEALTH: Record<NonNullable<CatalogApp['health']>, { text: string; cls: string }> = {
  ok: { text: 'Çalışıyor', cls: 'is-ok' }, starting: { text: 'Açılıyor…', cls: 'is-run' },
  stopped: { text: 'Durduruldu', cls: 'is-off' }, failed: { text: 'Hata', cls: 'is-bad' },
};
// Süren iş / biten iş başlığı
const JOB_LABEL: Record<string, [string, string]> = {
  enable: ['Motor açılıyor', 'Motoru açma'], disable: ['Motor kapatılıyor', 'Motoru kapatma'],
  install: ['Kuruluyor', 'Kurulum'], uninstall: ['Kaldırılıyor', 'Kaldırma'],
};
const jobTitle = (j: Job) => JOB_LABEL[j.cmd || '']?.[j.state === 'running' ? 0 : 1] || 'Uygulama işi';
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function JobBox({ job, title }: { job: Job; title: string }) {
  const running = job.state === 'running';
  return (
    <div className={`apx-job ${job.state === 'failed' ? 'is-bad' : job.state === 'done' ? 'is-done' : ''}`} role="status" aria-live="polite">
      <div className="apx-job-head">
        {running ? <Loader2 size={14} className="spin" /> : job.state === 'done' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
        <strong>{title}</strong>
        <span className="apx-job-step">{running ? job.step || 'Başlatılıyor' : job.state === 'done' ? job.msg || 'Tamamlandı' : job.error || 'Başarısız'}</span>
      </div>
      {running && (
        <div className="apx-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.pct ?? 0}>
          <span style={{ width: `${Math.max(3, Math.min(100, job.pct ?? 0))}%` }} />
        </div>
      )}
      {!!job.log?.length && (
        <details className="apx-log">
          <summary>Ayrıntılı günlük</summary>
          <pre>{job.log.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

export function AppsPanel() {
  const { data, loading, error, refetch } = useApi<AppsResp>('/apps', EMPTY, 10000);
  const [busy, setBusy] = useState('');
  const [confirmOff, setConfirmOff] = useState(false);
  const [openForm, setOpenForm] = useState('');
  const [form, setForm] = useState<{ lanAccess: boolean; usb: string; usbConsent: boolean; tlsAck: boolean }>({ lanAccess: false, usb: '', usbConsent: false, tlsAck: false });
  const [usbList, setUsbList] = useState<string[]>([]);
  const [removing, setRemoving] = useState<{ id: string; purge: boolean; confirm: string } | null>(null);

  const job = data.job;
  const running = job?.state === 'running';
  // İş sürerken ve deneme sırasında 2 sn'de bir (geri sayım sunucu saatiyle: tarayıcı saati kaymış olabilir)
  const fast = running || data.engine?.stage === 'trial';
  useEffect(() => {
    if (!fast) return;
    const id = setInterval(() => { void refetch(); }, 2000);
    return () => clearInterval(id);
  }, [fast, refetch]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await refetch();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
      return false;
    } finally {
      setBusy('');
    }
  };

  if (!data.supported) {
    return <Panel title="Uygulamalar" icon={<Package size={18} />}><p className="apx-muted">Uygulamalar yalnız Pi üzerinde çalışır.</p></Panel>;
  }
  if (loading && !data.eligibility) {
    return <Panel title="Uygulamalar" icon={<Package size={18} />}><p className="apx-muted apx-loading"><Loader2 size={14} className="spin" /> Yükleniyor…</p></Panel>;
  }
  if (error && !data.eligibility) {
    return <Panel title="Uygulamalar" icon={<Package size={18} />}><p className="apx-note is-bad"><AlertTriangle size={14} /> <span>Durum alınamadı: {error}</span></p></Panel>;
  }

  const elig = data.eligibility;
  const eng = data.engine;
  const stage = eng?.stage || 'off';
  const eligOk = !!elig?.ok;
  const left = eng && stage === 'trial' ? Math.max(0, eng.trialEnds - (data.now || 0)) : 0;
  const engineJob = job && (job.cmd === 'enable' || job.cmd === 'disable') ? job : null;
  const appJob = job && (job.cmd === 'install' || job.cmd === 'uninstall') ? job : null;
  // Motor açma işi sürerken (Podman paket kurulumu) deneme henüz başlamamıştır: durum dosyasındaki süre kurulum payını da
  // içerir — geri sayım gösterilmez
  const enabling = engineJob?.cmd === 'enable' && engineJob.state === 'running';
  // Biten açma işinin iletisi ("5 dk içinde Kalıcı yap") yalnız deneme sürerken geçerli: kalıcı yapılınca ya da süre dolup
  // geri alınınca gösterilmez
  const showEngineJob = !!engineJob && engineJob.state !== 'idle' && !(engineJob.cmd === 'enable' && engineJob.state === 'done' && stage !== 'trial');
  const rolledBack = stage === 'off' && !!eng?.rolledBackAt;
  const step = !eligOk && stage === 'off' ? 1 : stage !== 'on' ? 2 : 3;
  // 1. adım uygunluğa göre: motor açıkken uygunluk yitirilirse (ör. veri diski bağlı değil) yeniden dikkat ister
  const stepCls = (n: number) => `apx-step ${n === 1 && !eligOk ? 'is-current' : step === n ? 'is-current' : step > n ? 'is-done' : 'is-locked'}`;
  const host = data.openHost || window.location.hostname;

  const openInstall = async (a: CatalogApp) => {
    setOpenForm(a.id);
    setForm({ lanAccess: false, usb: '', usbConsent: false, tlsAck: false });
    if (a.usbOption) {
      try { setUsbList((await getApi<{ devices: string[] }>('/apps/usb')).devices || []); } catch { setUsbList([]); }
    }
  };

  return (
    <div className="apx-page">
      <Panel title="Uygulamalar" icon={<Package size={18} />} subtitle="Ev sunucusu uygulamaları — NVMe diskte, kendi ağında, internete kapalı">
        <p className="apx-intro">
          Home Assistant ve Vaultwarden gibi uygulamalar bu cihazda, ayrı bir konteyner ağında ({data.network?.subnet || '198.18.64.0/24'}) çalışır.
          Uygulamalara yalnız ev ağından ve Ev VPN yöneticilerinden ulaşılır; internetten, yedek hattan ve misafir ağlarından erişim yoktur.
          Varsayılan kapalıdır: siz açana kadar hiçbir şey kurulmaz.
        </p>

        {/* 1. Uygunluk */}
        <section className={stepCls(1)} aria-label="1. adım: uygunluk">
          <h3 className="apx-step-title"><span className="apx-num">{eligOk ? <CheckCircle2 size={14} /> : 1}</span> Uygunluk</h3>
          <ul className="apx-checks">
            {(elig?.checks || []).map(c => (
              <li key={c.key} className={c.ok ? 'is-ok' : 'is-bad'}>
                {c.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span className="apx-check-label">{c.label}</span>
                <span className="apx-check-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
          {elig && !eligOk && (
            <p className="apx-note is-warn">
              <AlertTriangle size={14} />
              <span>{stage === 'off' ? 'Bu cihaz şu an uygun değil: koşullar sağlanınca mağaza açılabilir.'
                : 'Bu cihaz şu an uygun değil: koşullar sağlanana kadar yeni uygulama kurulamaz.'}</span>
            </p>
          )}
        </section>

        {/* 2. Motor */}
        <section className={stepCls(2)} aria-label="2. adım: uygulama motoru">
          <h3 className="apx-step-title"><span className="apx-num">{step > 2 ? <CheckCircle2 size={14} /> : 2}</span> Uygulama motoru (Podman)</h3>
          {stage === 'off' && (
            <>
              {rolledBack && (
                <p className="apx-note is-warn">
                  <AlertTriangle size={14} />
                  <span>Deneme süresi doldu: «Kalıcı yap» denmediği için uygulama motoru geri alındı. Ev ağınızda internet ve panel
                    çalışıyorsa yeniden etkinleştirip süre içinde «Kalıcı yap» deyin.</span>
                </p>
              )}
              <p className="apx-text">
                Podman (Debian paketi, arka planda sürekli çalışan bir hizmet yok) kurulur, uygulama ağı ve güvenlik duvarı kuralları açılır.
                İlk açılış 5 dakikalık denemedir: «Kalıcı yap» denmezse her şey kendiliğinden geri alınır.
              </p>
              <div className="apx-actions">
                <button className="btn-primary btn-sm apx-on" disabled={!eligOk || !!busy || running}
                  onClick={() => { void act('enable', () => postApi('/apps/engine', { action: 'enable' }), 'Uygulama motoru açılıyor'); }}>
                  {busy === 'enable' ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Mağazayı etkinleştir
                </button>
              </div>
            </>
          )}
          {stage === 'trial' && (
            <>
              {enabling ? (
                <p className="apx-note is-info">
                  <Loader2 size={14} className="spin" />
                  <span>Motor kuruluyor: kurulum bitince {Math.round((eng?.trialSeconds || 300) / 60)} dakikalık deneme başlar.</span>
                </p>
              ) : left > 0 ? (
                <p className="apx-note is-warn">
                  <AlertTriangle size={14} />
                  <span>Deneme sürüyor: <strong className="apx-count">{mmss(left)}</strong> içinde «Kalıcı yap» denmezse motor kapatılır.
                    Ev ağınızda internet ve panel çalışıyorsa kalıcı yapın.</span>
                </p>
              ) : (
                <p className="apx-note is-warn">
                  <Loader2 size={14} className="spin" />
                  <span>Deneme süresi doldu: motor geri alınıyor…</span>
                </p>
              )}
              <div className="apx-actions">
                <button className="btn-primary btn-sm apx-on" disabled={!!busy || running || left === 0}
                  onClick={() => { void act('confirm', () => postApi('/apps/engine', { action: 'confirm' }), 'Uygulama motoru kalıcı yapıldı'); }}>
                  {busy === 'confirm' ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} Kalıcı yap
                </button>
                <button className="btn-outline btn-sm apx-off" disabled={!!busy || running || left === 0}
                  onClick={() => { void act('rollback', () => postApi('/apps/engine', { action: 'rollback' }), 'Deneme geri alınıyor'); }}>
                  <Undo2 size={13} /> Geri al
                </button>
              </div>
            </>
          )}
          {stage === 'on' && (
            <div className="apx-actions">
              <span className="apx-state is-ok"><CheckCircle2 size={12} /> Açık</span>
              {!confirmOff ? (
                <button className="btn-outline btn-sm apx-off" disabled={!!busy || running} onClick={() => setConfirmOff(true)}><Power size={13} /> Motoru kapat</button>
              ) : (
                <>
                  <span className="apx-text apx-inline">Uygulamalar durur, ağ ve kurallar kalkar; veriler diskte kalır.</span>
                  <button className="btn-outline btn-sm apx-off" disabled={!!busy || running}
                    onClick={() => { setConfirmOff(false); void act('disable', () => postApi('/apps/engine', { action: 'disable' }), 'Uygulama motoru kapatılıyor'); }}>
                    Kapat
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => setConfirmOff(false)}>Vazgeç</button>
                </>
              )}
            </div>
          )}
          {showEngineJob && engineJob && <JobBox job={engineJob} title={jobTitle(engineJob)} />}
          {data.dns && !data.dns.ok && (
            <p className="apx-note is-warn">
              <AlertTriangle size={14} />
              <span>Pi-hole yalnız ev ağı kartını dinliyor (DNS dinleme kipi {data.dns.listening}): uygulamalar internetteki adları çözemez.
                Pi-hole → Ayarlar → DNS'te «yerel» ya da «tüm arayüzler» seçin.</span>
            </p>
          )}
        </section>

        {/* 3. Katalog */}
        <section className={stepCls(3)} aria-label="3. adım: uygulamalar">
          <h3 className="apx-step-title"><span className="apx-num">3</span> Uygulamalar</h3>
          {appJob && appJob.state !== 'idle' && (
            <JobBox job={appJob} title={`${jobTitle(appJob)}: ${data.catalog?.find(c => c.id === appJob.app)?.name || appJob.app || ''}`} />
          )}
          <div className="apx-grid">
            {(data.catalog || []).map(a => {
              const h = a.health ? HEALTH[a.health] : null;
              const url = `${a.scheme}://${host}:${a.port}/`;
              const canInstall = step === 3 && eligOk && a.valid && a.memOk && !running && !busy;
              return (
                <article key={a.id} className={`apx-card ${a.installed ? 'is-installed' : ''}`}>
                  <div className="apx-card-head">
                    <strong className="apx-name">{a.name}</strong>
                    <span className="apx-ver">{a.version}</span>
                    {a.installed && h && <span className={`apx-state ${h.cls}`}>{h.text}</span>}
                  </div>
                  <p className="apx-text">{a.summary}</p>
                  <div className="apx-meta">
                    <span>Port {a.port} ({a.scheme.toUpperCase()})</span>
                    <span>En az {a.minMemMiB / 1024} GB bellek</span>
                    <span>~{a.diskMB >= 1000 ? `${(a.diskMB / 1000).toFixed(1)} GB` : `${a.diskMB} MB`} disk</span>
                  </div>
                  {!a.memOk && <p className="apx-note is-warn"><AlertTriangle size={14} /> <span>Bu cihazın belleği {a.name} için az (en az {a.minMemMiB / 1024} GB).</span></p>}
                  {!a.valid && <p className="apx-note is-bad"><XCircle size={14} /> <span>Katalog girdisi güvenlik denetiminden geçmedi — kurulamaz.</span></p>}
                  {a.warnings.map(w => <p key={w} className="apx-note is-warn"><AlertTriangle size={14} /> <span>{w}</span></p>)}
                  <details className="apx-notes">
                    <summary><Info size={13} /> Bilmeniz gerekenler</summary>
                    <ul>{a.notes.map(n => <li key={n}>{n}</li>)}</ul>
                  </details>

                  {!a.installed && openForm !== a.id && (
                    <div className="apx-actions">
                      <button className="btn-primary btn-sm apx-on" disabled={!canInstall} onClick={() => { void openInstall(a); }}>
                        <Download size={13} /> Kur
                      </button>
                      {/* Kurulu değilken kalan veriler (kaldırıldı ya da motor kapalı): yalnız ad yazılarak silinir */}
                      {a.dataExists && removing?.id !== a.id && (
                        <button className="btn-outline btn-sm apx-off" disabled={!!busy || running} onClick={() => setRemoving({ id: a.id, purge: true, confirm: '' })}>
                          <Trash2 size={13} /> Verileri sil
                        </button>
                      )}
                      {a.dataExists && <span className="apx-text apx-inline">Önceki kurulumun verileri diskte: yeniden kurulunca kullanılır.</span>}
                    </div>
                  )}

                  {!a.installed && openForm === a.id && (
                    <form className="apx-form" onSubmit={e => {
                      e.preventDefault();
                      void act(`install-${a.id}`, () => postApi(`/apps/${a.id}/install`, {
                        lanAccess: form.lanAccess, ...(form.usb ? { usbDevice: form.usb, usbConsent: form.usbConsent } : {}), tlsAck: form.tlsAck,
                      }), `${a.name} kuruluyor`).then(ok => { if (ok) setOpenForm(''); });
                    }}>
                      {a.lanAccessOption && (
                        <label className="apx-check">
                          <input type="checkbox" checked={form.lanAccess} onChange={e => setForm({ ...form, lanAccess: e.target.checked })} />
                          <span><strong>Ev ağına erişim</strong> — akıllı ev cihazlarını yönetebilsin (yalnız ev ağına; varsayılan kapalı)</span>
                        </label>
                      )}
                      {a.usbOption && (
                        <div className="apx-field">
                          <label htmlFor={`usb-${a.id}`}>USB aygıtı (Zigbee / Z-Wave çubuğu, isteğe bağlı)</label>
                          <select id={`usb-${a.id}`} className="apx-select" value={form.usb} onChange={e => setForm({ ...form, usb: e.target.value, usbConsent: false })}>
                            <option value="">Yok</option>
                            {usbList.map(d => <option key={d} value={d}>{d.replace('/dev/serial/by-id/', '')}</option>)}
                          </select>
                          {form.usb && (
                            <label className="apx-check">
                              <input type="checkbox" checked={form.usbConsent} onChange={e => setForm({ ...form, usbConsent: e.target.checked })} />
                              <span>Bu tek aygıtı uygulamaya vermeyi onaylıyorum</span>
                            </label>
                          )}
                        </div>
                      )}
                      {a.tls && (
                        <label className="apx-check">
                          <input type="checkbox" checked={form.tlsAck} onChange={e => setForm({ ...form, tlsAck: e.target.checked })} />
                          <span>Tarayıcının ilk girişte <strong>sertifika uyarısı</strong> vereceğini anladım; yalnız ev ağından / Ev VPN'den erişeceğim</span>
                        </label>
                      )}
                      <p className="apx-text">İmaj indirilir ({a.diskMB >= 1000 ? `~${(a.diskMB / 1000).toFixed(1)} GB` : `~${a.diskMB} MB`}); süre internet hızına bağlıdır.</p>
                      <div className="apx-actions">
                        <button type="submit" className="btn-primary btn-sm apx-on"
                          disabled={!canInstall || (a.tls && !form.tlsAck) || (!!form.usb && !form.usbConsent)}>
                          {busy === `install-${a.id}` ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Kur
                        </button>
                        <button type="button" className="btn-outline btn-sm" onClick={() => setOpenForm('')}>Vazgeç</button>
                      </div>
                    </form>
                  )}

                  {a.installed && (
                    <>
                      {a.lanAccessOption && (
                        <label className="apx-check">
                          <input type="checkbox" checked={a.lanAccess} disabled={!!busy || stage === 'off'}
                            onChange={e => { const v = e.target.checked; void act(`lan-${a.id}`, () => putApi(`/apps/${a.id}`, { lanAccess: v }), v ? 'Ev ağına erişim açıldı' : 'Ev ağına erişim kapatıldı'); }} />
                          <span><strong>Ev ağına erişim</strong> — kapalıyken uygulama ev ağındaki cihazlara bağlantı açamaz</span>
                        </label>
                      )}
                      {a.signupsOption && (
                        <label className="apx-check">
                          <input type="checkbox" checked={a.signups} disabled={!!busy || running}
                            onChange={e => { const v = e.target.checked; void act(`signups-${a.id}`, () => putApi(`/apps/${a.id}`, { signups: v }), v ? 'Yeni hesap açma açıldı' : 'Yeni hesap açma kapatıldı'); }} />
                          <span><strong>Yeni hesap açılabilsin</strong> — ev ağındaki herkes hesap açabilir; hesaplarınızı açınca kapatın (uygulama yeniden başlar)</span>
                        </label>
                      )}
                      {a.usbDevice && <p className="apx-text">USB aygıtı: {a.usbDevice.replace('/dev/serial/by-id/', '')}</p>}
                      <div className="apx-actions">
                        <a className={`btn-primary btn-sm apx-on apx-link ${a.health === 'ok' ? '' : 'is-disabled'}`} href={url} target="_blank" rel="noopener noreferrer"
                          aria-disabled={a.health !== 'ok'} onClick={e => { if (a.health !== 'ok') e.preventDefault(); }}>
                          <ExternalLink size={13} /> Aç
                        </a>
                        {a.health === 'stopped' || a.health === 'failed' ? (
                          <button className="btn-primary btn-sm apx-on" disabled={!!busy || running}
                            onClick={() => { void act(`start-${a.id}`, () => postApi(`/apps/${a.id}/start`, {}), `${a.name} başlatıldı`); }}>
                            <Play size={13} /> Başlat
                          </button>
                        ) : (
                          <button className="btn-outline btn-sm apx-off" disabled={!!busy || running || stage === 'off'}
                            onClick={() => { void act(`stop-${a.id}`, () => postApi(`/apps/${a.id}/stop`, {}), `${a.name} durduruldu`); }}>
                            <Square size={13} /> Durdur
                          </button>
                        )}
                        {removing?.id !== a.id && (
                          <button className="btn-outline btn-sm apx-off" disabled={!!busy || running} onClick={() => setRemoving({ id: a.id, purge: false, confirm: '' })}>
                            <Trash2 size={13} /> Kaldır
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {removing?.id === a.id && (a.installed || a.dataExists) && (
                    <div className="apx-remove">
                      {a.installed ? (
                        <label className="apx-check">
                          <input type="checkbox" checked={removing.purge} onChange={e => setRemoving({ ...removing, purge: e.target.checked, confirm: '' })} />
                          <span><strong>Verileri de sil</strong> (ayarlar, hesaplar, kasa — geri alınamaz)</span>
                        </label>
                      ) : (
                        <p className="apx-text">Uygulamanın diskte kalan verileri (ayarlar, hesaplar, kasa) silinir — geri alınamaz.</p>
                      )}
                      {removing.purge && (
                        <div className="apx-field">
                          <label htmlFor={`rm-${a.id}`}>Silmek için uygulamanın adını yazın: <strong>{a.name}</strong></label>
                          <input id={`rm-${a.id}`} className="apx-input" value={removing.confirm} autoComplete="off"
                            onChange={e => setRemoving({ ...removing, confirm: e.target.value })} />
                        </div>
                      )}
                      <div className="apx-actions">
                        <button className="btn-outline btn-sm apx-off" disabled={!!busy || running || (removing.purge && removing.confirm.trim() !== a.name)}
                          onClick={() => {
                            const r = removing;
                            void act(`rm-${a.id}`, () => postApi(`/apps/${a.id}/uninstall`, { purge: r.purge, confirm: r.confirm }),
                              !a.installed ? `${a.name} verileri siliniyor` : r.purge ? `${a.name} verileriyle kaldırılıyor` : `${a.name} kaldırılıyor (veriler kalır)`)
                              .then(ok => { if (ok) setRemoving(null); });
                          }}>
                          <Trash2 size={13} /> {!a.installed ? 'Verileri sil' : removing.purge ? 'Verileriyle kaldır' : 'Kaldır (veriler kalır)'}
                        </button>
                        <button className="btn-outline btn-sm" onClick={() => setRemoving(null)}>Vazgeç</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <div className="apx-foot">
          {(data.excluded || []).map(x => (
            <p key={x.name} className="apx-note is-info"><Info size={14} /> <span><strong>Neden {x.name} yok?</strong> {x.reason}</span></p>
          ))}
          <p className="apx-note is-info"><Info size={14} /> <span>Uygulama verileri ({'/mnt/klyrix-data/apps'}) bulut yedeğine ve panel yedeğine girmez (şimdilik): önemli verileri uygulamanın kendi yedekleme özelliğiyle saklayın.</span></p>
          <p className="apx-note is-info"><Info size={14} /> <span>Uygulamalar ve verileri bu cihaza bağlıdır (paylaşımlı depolama yok): başka bir Klyrix cihazına — ileride gelecek yedek cihaz (yüksek erişilebilirlik) özelliği dahil — kendiliğinden taşınmaz.</span></p>
        </div>
      </Panel>
    </div>
  );
}

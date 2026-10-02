import { useEffect, useState } from 'react';
import {
  CloudDownload, Loader2, CheckCircle2, XCircle, AlertTriangle, Info, KeyRound, ListChecks, FolderDown, Trash2, Play, MinusCircle,
} from 'lucide-react';
import { postApi, useApi } from '../hooks/useApi';
import { Modal, Panel, Select, SelectOption } from './ui';
import { toast } from '../toast';
import './CloudRestore.css';

// Buluttan geri yükleme (yeni cihaza kurtarma) — CloudBackupPanel'in ayrı parçası (React.lazy): ayar deposundan bir anlık
// görüntü getirilir (iş: vault.sh restore-config → tmpfs), önizlenir (sayılar ve uyarılar; gizli değer gelmez), uygulanır
// (indirilen yedek dosyasıyla aynı yol + isteğe bağlı gizli anahtarlar, «eski cihaz kapalı» onayıyla). Ardından yapılacaklar
// listesi, eski cihazın anahtarını kaldırma, dosyaları yeni bir klasöre geri yükleme ve «Bu cihazdan yedeklemeye devam».
interface Job { state: 'idle' | 'running' | 'done' | 'failed'; id?: string; cmd?: string; msg?: string }
interface Snap { id: string; time: string; hostname: string; files?: number; bytes?: number }
interface SecretCounts { vps: number; tunnels: number; clients: number; homeVpn: boolean; homeVpnPeers: number; ddns: number }
interface CronRow { name: string; schedule: string; command: string; enabled: boolean }
interface VpsWarn { ids: number[]; block: string[]; isp: string[] }
interface VpsBinding { id: number; ip: string; location: string; backupIp: string | null; backupLocation: string | null; differs: boolean | null; rules: string[] }
interface Preview {
  staged: boolean; fetching?: boolean; snapshotId?: string; fetchedAt?: number; expiresAt?: number;
  meta?: { createdAt: string; panelVersion: string; build: string; role: string; hostname: string; vaultHost: string; board: string; arch: string; includeSecrets?: boolean };
  version?: { backup: string; running: string; newer: boolean };
  tables?: { name: string; rows: number }[];
  secrets?: {
    counts: SecretCounts; valid: boolean; usable?: boolean; error?: string; errors?: { section: string; label: string; error: string }[];
    vpsOnDevice: number; ddnsOnDevice?: number; homeVpnOnDevice?: { enabled: boolean; peers: number };
  } | null;
  warnings?: { vps: VpsWarn & { coveredBySecrets: boolean }; vpsExisting?: VpsBinding[]; cron: CronRow[]; satellite: boolean };
}
interface Part { item: string; ok: boolean; skipped?: boolean; detail?: string }
// followUp: geri yüklemeden sonra yapılacaklar için (backend applyRestore)
interface FollowUp { vps: VpsWarn; homeVpnInBackup: boolean; homeVpnRestored: boolean; ddnsInBackup: number; oldIncludeSecrets: boolean; firewallDeployPending: boolean }
interface ApplyResult {
  imported: { message: string; restored_count: number; applied: Part[]; ignored: string[] }; secrets: Part[] | null; snapshot: string; followUp?: FollowUp;
}
interface KeyRow { id: string; configId: string | null; filesId: string | null; host: string; created: string; current: boolean; likelyPassphrase: boolean }
interface StorageInfo { layout?: { shareMounted: boolean; shareDev: string }; disks?: { parts: { path: string; shareName?: string; fsAvail: number | null }[] }[] }
interface ShareInfo { usb?: { name: string; mounted: boolean }[] }

const TABLE_LABEL: Record<string, string> = {
  service_config: 'Servis ayarları', service_status: 'Servis durumları', traffic_routing: 'Uygulama yönlendirme kuralları',
  domain_routing: 'Alan adı kuralları', routing_rules: 'Güvenlik duvarı kuralları', pihole_lists: 'Pi-hole listeleri',
  zapret_domains: 'Zapret alan adları', bandwidth_limits: 'Hız ve kota sınırları', parental_rules: 'Ebeveyn kuralları',
  traffic_schedules: 'Trafik zamanlamaları', device_groups: 'Cihaz grupları', device_group_members: 'Grup üyeleri',
  throttle_rules: 'Yavaşlatma kuralları', app_settings: 'Panel ayarları', cron_jobs: 'Cron görevleri',
  dhcp_leases: 'Statik DHCP kayıtları', domain_suggestion_dismissed: 'Yoksayılan öneriler', calendar_sources: 'Takvim bağlantıları',
  port_forwards: 'Port yönlendirmeleri', device_names: 'Elle verilen cihaz adları',
  policy_templates: 'Koruma şablonları',
};
// Hiç geri yüklenmeyenler: eski donanımın arayüz adlarını / adreslerini taşırlar ya da parola içerirler
const NEVER_RESTORED = [
  'Ağ kurulumu: sabit adres, Pi DHCP, internet kartı (WAN / PPPoE), yedek hat, Wi-Fi ve NetworkManager profilleri',
  'Uydu (mesh) eşleşmeleri', 'Panel parolası ve ağ paylaşımı (Samba) parolası',
  'Cihaz listesi (verdiğiniz adlar, engeller) ve port yönlendirmeleri',
  'Bulut yedeğinin kendi ayarları (klasörler, gizli anahtar yedeği, saat, saklama)',
];

function size(b?: number | null): string {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
const at = (iso?: string) => {
  const d = iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T')) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : iso || '—';
};
const errText = (e: unknown, d: string) => (e instanceof Error ? e.message : d);
// GET: sunucunun Türkçe hata metni korunur (getApi yalnız "HTTP 400" bırakır)
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(`/api${url}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `HTTP ${r.status}`);
  return body as T;
}

// Bulut yedeğinin kendi ayarları (klasörler, gizli anahtar yedeği, saat, saklama) yedekte değil, bu cihazda varsayılandır
const RESUME_CONFIRM = 'Bu cihazdan yedeklemeye devam edilsin mi?\n\nBu cihazın ayarları her gün yedeklenir ve bu cihazın eski anlık görüntüleri saklama kurallarına göre temizlenir. Geri yüklemeyi bitirdiyseniz devam edin.\n\nÖnce aşağıdaki «Yedek ayarları»nı denetleyin: klasör seçimi, gizli anahtar yedeği, saat ve saklama geri yüklenmez — bu cihazda varsayılandır (klasör yok, gizli anahtarlar kapalı).';

export function CloudRestore({ paused, host, job, lowMem, onJob, onChanged }: {
  paused: boolean; host: string; job: Job | null; lowMem: boolean; onJob: () => void; onChanged: () => void;
}) {
  const running = job?.state === 'running';
  const [result, setResult] = useState<ApplyResult | null>(null);
  return (
    <div className="cr-wrap">
      {paused && <ResumeBanner onChanged={onChanged} />}
      <RestoreWizard host={host} job={job} running={running} onJob={onJob} onApplied={r => { setResult(r); onChanged(); }} result={result} />
      {(paused || result) && <AfterRestore paused={paused} result={result} onChanged={onChanged} />}
      <KeysSection job={job} running={running} onJob={onJob} />
      <FilesSection job={job} running={running} lowMem={lowMem} onJob={onJob} />
    </div>
  );
}

// Geri yükleme kipi: otomatik yedek duraklatıldı — «Bu cihazdan yedeklemeye devam»
function ResumeBanner({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    if (!window.confirm(RESUME_CONFIRM)) return;
    setBusy(true);
    try {
      await postApi('/vault/resume', {});
      toast.success('Otomatik bulut yedeği yeniden açıldı');
      onChanged();
    } catch (e: unknown) {
      toast.error(errText(e, 'Açılamadı'));
    }
    setBusy(false);
  };
  return (
    <div className="glass-panel cr-paused">
      <Info size={18} />
      <div className="cr-paused-text">
        <strong>Geri yükleme kipi — otomatik yedek duraklatıldı</strong>
        <span>Bu cihaz bulut deposuna bağlı ama geri yükleme bitene kadar yedek almaz: yeni cihazın boş ayarları iyi yedeklerin
          yanına anlık görüntü olarak eklenmez, eski anlık görüntüler budanmaz.</span>
      </div>
      <button className="btn-primary btn-sm" disabled={busy} onClick={resume}>
        {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Bu cihazdan yedeklemeye devam
      </button>
    </div>
  );
}

function RestoreWizard({ host, job, running, onJob, onApplied, result }: {
  host: string; job: Job | null; running: boolean; onJob: () => void; onApplied: (r: ApplyResult) => void; result: ApplyResult | null;
}) {
  const [snaps, setSnaps] = useState<Snap[] | null>(null);
  const [listing, setListing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [reload, setReload] = useState(0);
  const [secrets, setSecrets] = useState(false);
  const [retired, setRetired] = useState(false);
  const [busy, setBusy] = useState(false);
  // Getirme işi bitince — başarılı ya da başarısız (ya da açılışta / elle) önizleme okunur: başarısız getirmeden sonra
  // önceki anlık görüntünün önizlemesi kalmasın (backend ve vault.sh getirmenin başında onu siler)
  const fetchEnd = job?.cmd === 'restore-config' && job.state !== 'running' && job.state !== 'idle' ? job.id || '' : '';
  useEffect(() => {
    let alive = true;
    getJson<Preview>('/vault/restore/preview')
      .then(p => { if (alive) { setPreview(p); setPreviewErr(''); } })
      .catch(e => { if (alive) setPreviewErr(errText(e, 'Önizleme okunamadı')); });
    return () => { alive = false; };
  }, [reload, fetchEnd]);

  const list = async () => {
    setListing(true);
    try {
      const r = await getJson<{ snapshots: Snap[] }>('/vault/snapshots?repo=config');
      setSnaps(r.snapshots);
    } catch (e: unknown) {
      toast.error(`Anlık görüntüler okunamadı: ${errText(e, 'bilinmeyen hata')}`);
    }
    setListing(false);
  };
  const fetchSnap = async (id: string) => {
    setBusy(true);
    try {
      await postApi('/vault/restore/fetch', { snapshot: id });
      toast.info('Ayar yedeği getiriliyor…');
      setPreview(null);
      setPreviewErr('');
      setSecrets(false);
      setRetired(false);
      onJob();
    } catch (e: unknown) {
      toast.error(errText(e, 'Getirilemedi'));
    }
    setBusy(false);
  };
  const discard = async () => {
    setBusy(true);
    try {
      await postApi('/vault/restore/discard', {});
      setReload(n => n + 1);
    } catch (e: unknown) {
      toast.error(errText(e, 'Silinemedi'));
    }
    setBusy(false);
  };
  const apply = async () => {
    const p = preview;
    if (!p?.staged) return;
    const what = secrets ? 'Ayarlar ve gizli anahtarlar (VPS, VPN, DDNS)' : 'Ayarlar (gizli anahtarlar olmadan)';
    if (!window.confirm(`Bu yedek bu cihaza geri yüklensin mi? (${at(p.meta?.createdAt)}, ${p.meta?.hostname || p.meta?.vaultHost || '?'})\n\n${what}.\n\nYedekteki kurallar ve listeler şimdikilerin yerine geçer, ayarlar birleştirilir; ardından yönlendirme, Cron, Pi-hole listeleri, Fail2Ban, Unbound ve (kuruluysa) güvenlik duvarı yeniden uygulanır. Ağ kurulumu geri yüklenmez.`)) return;
    setBusy(true);
    try {
      // Önizlenen anlık görüntü: arada (başka bir sekmede) yenisi getirildiyse backend reddeder
      const r = await postApi('/vault/restore/apply', { secrets, oldDeviceRetired: secrets && retired, snapshot: p.snapshotId, fetchedAt: p.fetchedAt }) as ApplyResult;
      toast.success(r.imported?.message || 'Geri yüklendi');
      setPreview({ staged: false });
      onApplied(r);
    } catch (e: unknown) {
      toast.error(errText(e, 'Geri yüklenemedi'));
      setReload(n => n + 1);  // "değişti" ise yeni önizleme gelsin
    }
    setBusy(false);
  };

  const fetching = (running && job?.cmd === 'restore-config') || !!preview?.fetching;
  const sorted = [...(snaps || [])].sort((a, b) => b.time.localeCompare(a.time));
  return (
    <Panel title="Buluttan geri yükle" icon={<CloudDownload size={20} style={{ marginRight: 8 }} />} className="cb-panel cr-panel"
      subtitle="Yeni cihaza kurtarma: ayar yedeğini seçin, önizleyin, uygulayın">
      <h4 className="cb-h"><span className="cr-step">1</span> Anlık görüntü seçin</h4>
      <div className="cb-actions">
        <button className="btn-outline btn-sm" disabled={listing} onClick={list}>
          {listing ? <Loader2 size={13} className="spin" /> : null} {snaps ? 'Yenile' : 'Ayar yedeklerini listele'}
        </button>
        <span className="cb-hint">Liste buluttan okunur (birkaç saniye). Panel sürümü ve içerik «Getir»den sonra görünür.</span>
      </div>
      {snaps && sorted.length === 0 && <p className="cb-hint">Ayar deposunda anlık görüntü yok.</p>}
      {sorted.length > 0 && (
        <div className="cr-snaps">
          {sorted.slice(0, 40).map(s => (
            <div key={s.id} className="cr-snap">
              <div className="cr-snap-main">
                <strong>{at(s.time)}</strong>
                <span>{s.hostname}{s.hostname === host ? ' · bu cihaz' : ''} · <code>{s.id}</code></span>
              </div>
              <button className="btn-outline btn-sm" disabled={running || busy} onClick={() => fetchSnap(s.id)}>Getir</button>
            </div>
          ))}
        </div>
      )}

      {fetching && <div className="cb-note cb-note-info"><Loader2 size={16} className="spin" /><span>Ayar yedeği getiriliyor — bitince önizleme burada açılır.</span></div>}
      {previewErr && <div className="cb-note cb-note-bad"><XCircle size={16} /><span>Getirilen yedek okunamadı: {previewErr}</span></div>}
      {preview?.staged && !fetching && (
        <PreviewCard p={preview} secrets={secrets} setSecrets={setSecrets} retired={retired} setRetired={setRetired}
          busy={busy || running} onApply={apply} onDiscard={discard} />
      )}
      {result && <ResultCard r={result} />}
    </Panel>
  );
}

function PreviewCard({ p, secrets, setSecrets, retired, setRetired, busy, onApply, onDiscard }: {
  p: Preview; secrets: boolean; setSecrets: (v: boolean) => void; retired: boolean; setRetired: (v: boolean) => void;
  busy: boolean; onApply: () => void; onDiscard: () => void;
}) {
  const m = p.meta;
  const tables = p.tables || [];
  const rows = tables.reduce((a, t) => a + t.rows, 0);
  const sec = p.secrets;
  const vps = p.warnings?.vps;
  const existing = p.warnings?.vpsExisting || [];
  const cron = p.warnings?.cron || [];
  // Eski panel yanıtında usable yok: valid'e düşülür. Geçersiz bölüm (ör. DDNS) yalnız kendisini atlatır.
  const secretsUsable = !!sec && (sec.usable ?? sec.valid);
  const secErrors = sec?.errors || [];
  const vpsSkip = !!sec && sec.vpsOnDevice > 0;
  // Gizli anahtarlarla değişecek olanlar (bu cihazda kurulmuş): Ev VPN'i her zaman; DDNS yalnız yedekte DDNS varsa ve VPS
  // bölümü atlanmıyorsa (bu cihazda VPS yokken)
  const homeHere = sec?.homeVpnOnDevice;
  const homeReplace = !!sec && sec.counts.homeVpn && !secErrors.some(e => e.section === 'homeVpn') && !!homeHere && (homeHere.enabled || homeHere.peers > 0);
  const ddnsReplace = !!sec && !vpsSkip && sec.counts.ddns > 0 && !secErrors.some(e => e.section === 'ddns') && (sec.ddnsOnDevice ?? 0) > 0;
  // Gizli anahtarlar seçilmezse (ya da VPS bölümü atlanacaksa) VPS'e yönlenen kurallar için uyarı
  const vpsWarn = !!vps && vps.ids.length > 0 && !(secrets && vps.coveredBySecrets);
  const canApply = !busy && (!secrets || retired);
  const ruleList = (r: string[]) => `${r.slice(0, 6).join(', ')}${r.length > 6 ? ` +${r.length - 6}` : ''}`;
  return (
    <>
      <h4 className="cb-h"><span className="cr-step">2</span> Önizleme</h4>
      <div className="cb-facts">
        <div><span>Anlık görüntü</span><code>{(p.snapshotId || '').slice(0, 8)}</code></div>
        <div><span>Yedeğin tarihi</span><strong>{at(m?.createdAt)}</strong></div>
        <div><span>Kaynak cihaz</span><strong>{m?.hostname || '—'}{m?.vaultHost ? ` (${m.vaultHost})` : ''}</strong></div>
        <div><span>Kart</span><strong>{[m?.board, m?.arch].filter(Boolean).join(' · ') || '—'}</strong></div>
        <div><span>Panel sürümü (yedek / bu cihaz)</span><strong>{p.version?.backup || '?'} / {p.version?.running || '?'}</strong></div>
        <div><span>İçerik</span><strong>{tables.length} tablo, {rows} kayıt</strong></div>
      </div>
      {p.version?.newer && (
        <div className="cb-note cb-note-warn"><AlertTriangle size={16} /><span>Yedek daha yeni bir panel sürümünden ({p.version.backup}). Önce bu
          cihazın panelini güncellemeniz önerilir: bu sürümün tanımadığı ayarlar atlanır.</span></div>
      )}
      {p.warnings?.satellite && (
        <div className="cb-note cb-note-warn"><AlertTriangle size={16} /><span>Bu yedek bir uydu cihazdan alınmış: ana cihaz ayarlarını içermeyebilir.</span></div>
      )}
      <details className="cr-details">
        <summary>Tablolar ve kayıt sayıları</summary>
        <ul className="cr-tables">
          {tables.map(t => <li key={t.name}><span>{TABLE_LABEL[t.name] || t.name}</span><strong>{t.rows}</strong></li>)}
        </ul>
      </details>

      <h4 className="cb-h"><KeyRound size={15} /> Gizli anahtarlar</h4>
      {!sec && <p className="cb-hint">Bu yedekte gizli anahtar yok (yedek alınırken «Gizli anahtarları da yedekle» kapalıydı). VPS sunucularını,
        tünelleri, Ev VPN'ini ve DDNS'i yeniden kurmanız gerekir.</p>}
      {sec && !secretsUsable && <div className="cb-note cb-note-bad"><XCircle size={16} /><span>Gizli anahtar paketi kullanılamaz: {sec.error}</span></div>}
      {sec && secretsUsable && secErrors.length > 0 && (
        <div className="cb-note cb-note-warn">
          <AlertTriangle size={16} />
          <span>
            Bu bölümler yedekte geçersiz, geri yüklenmez (yeniden kurun):
            {secErrors.map(e => <span key={e.section} className="cr-secerr"><strong>{e.label}</strong> — {e.error}</span>)}
          </span>
        </div>
      )}
      {sec && (
        <ul className="cr-counts">
          <li>VPS sunucusu: <strong>{sec.counts.vps}</strong> (tünel anahtarı: {sec.counts.tunnels})</li>
          <li>VPS istemcisi: <strong>{sec.counts.clients}</strong></li>
          <li>Ev VPN'i: <strong>{sec.counts.homeVpn ? `sunucu + ${sec.counts.homeVpnPeers} cihaz` : 'yok'}</strong></li>
          <li>DDNS: <strong>{sec.counts.ddns}</strong></li>
        </ul>
      )}
      {secretsUsable && (
        <>
          <label className="cb-check">
            <input type="checkbox" checked={secrets} onChange={e => { setSecrets(e.target.checked); if (!e.target.checked) setRetired(false); }} />
            <span>Gizli anahtarları da geri yükle (VPS tünelleri, Ev VPN'i, DDNS)</span>
          </label>
          {vpsSkip && secrets && (
            <p className="cb-hint">Bu cihazda zaten {sec!.vpsOnDevice} VPS kaydı var: yedekteki VPS'ler, VPS istemcileri, DDNS ve tüneller atlanır
              (üzerine yazılmaz); Ev VPN'i yine geri yüklenir. Yedekteki kurallar bu cihazın VPS numaralarını kullanır — aşağıdaki uyarıya bakın.</p>
          )}
          {secrets && (homeReplace || ddnsReplace) && (
            <div className="cb-note cb-note-warn">
              <AlertTriangle size={16} />
              <span>
                {homeReplace && <>Bu cihazdaki Ev VPN'i{homeHere!.peers ? ` (${homeHere!.peers} cihaz)` : ''} yedektekiyle değiştirilir — bu cihazda
                  oluşturulan telefon / dizüstü profilleri çalışmaz. </>}
                {ddnsReplace && <>Bu cihazdaki {sec!.ddnsOnDevice} DDNS kaydı yedektekilerle değiştirilir.</>}
              </span>
            </div>
          )}
          {secrets && (
            <div className="cb-note cb-note-warn cr-retired">
              <AlertTriangle size={16} />
              <span>
                Aynı WireGuard anahtarları iki cihazda çalışırsa <strong>ikisinin de</strong> VPS tüneli ve Ev VPN'i bozulur (bağlantı iki cihaz
                arasında gidip gelir). Eski cihaz hâlâ çalışıyorsa gizli anahtarları geri yüklemeyin — VPS'i WireGuard sayfasından yeniden kurun.
                <label className="cb-check">
                  <input type="checkbox" checked={retired} onChange={e => setRetired(e.target.checked)} />
                  <span>Eski cihaz kapalı / artık kullanılmıyor</span>
                </label>
              </span>
            </div>
          )}
        </>
      )}

      <h4 className="cb-h"><AlertTriangle size={15} /> Uyarılar</h4>
      {vpsWarn && (
        <div className="cb-note cb-note-warn">
          <AlertTriangle size={16} />
          <span>
            {vps!.block.length + vps!.isp.length} kural bu cihazda kayıtlı olmayan VPS'e yönleniyor (VPS {vps!.ids.join(', ')})
            {vps!.block.length ? `; yedek yolu «engelle» olanlar: ${ruleList(vps!.block)}` : ''}.
            {' '}Bu VPS kayıtlı olmadıkça bu kurallar VPS yerine doğrudan operatör hattından çıkar («engelle» koruması kayıtlı olmayan VPS'te
            işlemez). VPS'i yeniden eklediğinizde kuralların VPS seçimini denetleyin — yeni kaydın numarası farklı olabilir.
            {secretsUsable && !secrets && vps!.coveredBySecrets ? ' Gizli anahtarlar geri yüklenirse bu VPS\'ler ve tünelleri geri gelir.' : ''}
          </span>
        </div>
      )}
      {secrets && vps?.coveredBySecrets && vps.ids.length > 0 && (
        <p className="cb-hint">VPS {vps.ids.join(', ')} gizli anahtarlarla geri gelir; tünel bağlanana kadar yedek yolu «engelle» olan uygulamalar
          engellenir (açılmaz).</p>
      )}
      {existing.length > 0 && (
        <div className="cb-note cb-note-warn">
          <AlertTriangle size={16} />
          <span>
            Yedekteki kurallar VPS'i numarasıyla seçer ve bu numaralar bu cihazda zaten kayıtlı — kurallar <strong>bu cihazın</strong> VPS'inden çıkar:
            {existing.map(b => (
              <span key={b.id} className="cr-secerr">
                <strong>VPS {b.id}</strong> = bu cihazda {b.ip}{b.location ? ` (${b.location})` : ''}
                {b.differs === true ? <> — yedekte <strong>farklı bir sunucuydu</strong> ({b.backupIp}{b.backupLocation ? `, ${b.backupLocation}` : ''})</>
                  : b.differs === false ? ' — yedektekiyle aynı sunucu' : ''}: {b.rules.length} kural ({ruleList(b.rules)})
              </span>
            ))}
            {' '}Uyguladıktan sonra Routing sayfasında bu kuralların VPS seçimini denetleyin.
          </span>
        </div>
      )}
      {cron.length > 0 && (
        <details className="cr-details">
          <summary>Cron görevleri ({cron.length}) — root olarak çalışır; tanımadığınız bir komut varsa geri yüklemeyin</summary>
          <ul className="cr-cron">
            {cron.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <span>{c.name} <em>{c.schedule}{c.enabled ? '' : ' · kapalı'}</em></span>
                <code>{c.command}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="cb-note cb-note-info">
        <Info size={16} />
        <span>Geri yüklenmez (yeniden kurulur): {NEVER_RESTORED.join('; ')}.</span>
      </div>

      <h4 className="cb-h"><span className="cr-step">3</span> Uygula</h4>
      <div className="cb-actions">
        <button className="btn-primary" disabled={!canApply} onClick={onApply}>
          {busy ? <Loader2 size={14} className="spin" /> : <CloudDownload size={14} />} {secrets ? 'Ayarları ve gizli anahtarları geri yükle' : 'Ayarları geri yükle'}
        </button>
        <button className="btn-outline btn-sm" disabled={busy} onClick={onDiscard}><Trash2 size={13} /> Vazgeç</button>
        {secrets && !retired && <span className="cb-hint cb-bad">Gizli anahtarlar için «Eski cihaz kapalı» onayı gerekir.</span>}
      </div>
      {p.expiresAt && <p className="cb-hint">Getirilen yedek yalnız root'un okuyabildiği geçici bellekte durur; saat {new Date(p.expiresAt * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} itibarıyla silinir (uygulanınca hemen silinir).</p>}
    </>
  );
}

function PartRow({ p }: { p: Part }) {
  const Icon = p.skipped ? MinusCircle : p.ok ? CheckCircle2 : XCircle;
  return (
    <li className={p.skipped ? 'cr-skip' : p.ok ? 'cr-ok' : 'cr-bad'}>
      <Icon size={14} /><span><strong>{p.item}</strong>{p.detail ? ` — ${p.detail}` : ''}</span>
    </li>
  );
}
function ResultCard({ r }: { r: ApplyResult }) {
  // Başlık, olmayan bir bölüm varsa uyarı (yeşil onay yalnız hepsi tamamken)
  const failed = [...(r.imported.applied || []), ...(r.secrets || [])].filter(p => !p.ok).length;
  return (
    <div className="cr-result">
      <h4 className={`cb-h ${failed ? 'cr-h-warn' : 'cr-h-ok'}`}>
        {failed ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />} Geri yükleme sonucu — {r.imported.message}
        {failed ? ` ${failed} bölüm olmadı (aşağıda)` : ''}
      </h4>
      <ul className="cr-parts">
        {(r.imported.applied || []).map((p, i) => <PartRow key={`a${i}`} p={p} />)}
        {r.secrets === null
          ? <li className="cr-skip"><MinusCircle size={14} /><span><strong>Gizli anahtarlar</strong> — geri yüklenmedi</span></li>
          : r.secrets.map((p, i) => <PartRow key={`s${i}`} p={p} />)}
      </ul>
    </div>
  );
}

// Geri yüklemeden sonra yapılacaklar (bağlantılar ilgili sayfayı açar). Uygulamanın sonucu (followUp) varsa bu geri yüklemeye
// özgü maddeler vurgulanır: hâlâ kayıtlı olmayan VPS'e yönlenen kurallar, gelmeyen Ev VPN'i, Deploy Et bekleyen güvenlik duvarı.
type Item = { text: string; href?: string; link?: string; hl?: boolean };
function AfterRestore({ paused, result, onChanged }: { paused: boolean; result: ApplyResult | null; onChanged: () => void }) {
  const f = result?.followUp;
  const vpsRules = f ? f.vps.block.length + f.vps.isp.length : 0;
  const homeVpnMissing = !!f && !f.homeVpnRestored;
  const items: Item[] = [
    { text: 'Ağ kurulumunu sihirbazlarla yeniden yapın: sabit adres ve Pi DHCP', href: '#dhcp', link: 'DHCP Ayarları' },
    { text: 'İnternet kartı (WAN / PPPoE), yedek hat ve ev Wi-Fi\'si', href: '#roles', link: 'Cihaz Rolleri' },
    { text: 'Port yönlendirmelerini yeniden ekleyin (geri yüklenmez; İnternet kartı bölümünde)', href: '#roles', link: 'Cihaz Rolleri' },
    { text: 'Uyduları (mesh) yeniden eşleştirin', href: '#roles', link: 'Cihaz Rolleri' },
    ...(f && vpsRules > 0 ? [{
      text: `VPS ${f.vps.ids.join(', ')} bu cihazda yok: VPS'i WireGuard sayfasından yeniden kurun, sonra ${vpsRules} kuralın VPS seçimini Routing sayfasında denetleyin — şu an bu kurallar VPS yerine operatör hattından çıkıyor${f.vps.block.length ? ` («engelle» olanlar dahil: ${f.vps.block.slice(0, 4).join(', ')}${f.vps.block.length > 4 ? '…' : ''})` : ''}`,
      href: '#vps', link: 'WireGuard', hl: true,
    }] : []),
    homeVpnMissing
      ? { text: `Ev VPN'i ${f!.homeVpnInBackup ? 'geri yüklenmedi' : 'yedekte yoktu'}: kullanıyorsanız yeniden açın ve telefon / dizüstü profillerini yeniden dağıtın (eski profiller bu cihazda geçersiz); modemdeki UDP 51820 yönlendirmesini bu cihazın adresine çevirin`,
        href: '#vps', link: 'WireGuard', hl: f!.homeVpnInBackup }
      : { text: 'Ev VPN\'i kullanıyorsanız modemdeki UDP 51820 yönlendirmesini bu cihazın adresine çevirin, sonra dışarıdan bağlantı testini çalıştırın',
        href: '#vps', link: 'WireGuard', hl: !!f?.homeVpnRestored },
    ...(f && !(f.ddnsInBackup > 0 && result?.secrets?.some(p => p.item.startsWith('VPS sunucuları') && p.ok && !p.skipped))
      ? [{ text: f.ddnsInBackup > 0 ? 'DDNS kayıtları geri yüklenmedi: kullanıyorsanız DDNS sayfasından yeniden ekleyin'
        : 'DDNS kullanıyorsanız DDNS sayfasından yeniden ekleyin (yedekte DDNS kaydı yoktu)', href: '#ddns', link: 'DDNS', hl: f.ddnsInBackup > 0 }] : []),
    { text: `Güvenlik duvarı eski cihazda kuruluysa Firewall sayfasında kuralları denetleyip «Deploy Et» ile kurun${f?.firewallDeployPending ? ' — kurallar geri yüklendi, bu cihazda henüz kurulu değil' : ''}`,
      href: '#firewall', link: 'Firewall', hl: !!f?.firewallDeployPending },
    { text: 'Ağ paylaşımını (Samba) parolayla yeniden açın; klasörleri isterseniz aşağıdan geri yükleyin', href: '#storage', link: 'Depolama' },
    { text: 'Eski cihazın anahtarını depodan kaldırın (aşağıda «Depo anahtarları») — eski cihaz ya da SD kartı başkasının eline geçerse yedeklere ulaşamasın' },
    { text: `Bulut yedeği ayarlarını yeniden yapın (aşağıda «Yedek ayarları»): yedeklenecek klasörler, gizli anahtar yedeği${f ? ` (eski cihazda ${f.oldIncludeSecrets ? 'açıktı' : 'kapalıydı'})` : ''}, saat ve saklama — bunlar geri yüklenmez, bu cihazda varsayılandır` },
    ...(paused ? [{ text: 'Her şey yerindeyse «Bu cihazdan yedeklemeye devam» ile otomatik yedeği açın' }] : []),
  ];
  return (
    <Panel title="Geri yüklemeden sonra" icon={<ListChecks size={18} style={{ marginRight: 8 }} />} className="cb-panel">
      <ol className="cr-check">
        {items.map((it, i) => (
          <li key={i} className={it.hl ? 'cr-hl' : ''}>
            <span>{it.text}</span>
            {it.href && <a className="cr-link" href={it.href}>{it.link} →</a>}
          </li>
        ))}
      </ol>
      {paused && <ResumeInline onChanged={onChanged} />}
    </Panel>
  );
}
function ResumeInline({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    if (!window.confirm(RESUME_CONFIRM)) return;
    setBusy(true);
    try {
      await postApi('/vault/resume', {});
      toast.success('Otomatik bulut yedeği yeniden açıldı');
      onChanged();
    } catch (e: unknown) {
      toast.error(errText(e, 'Açılamadı'));
    }
    setBusy(false);
  };
  return (
    <div className="cb-actions">
      <button className="btn-primary btn-sm" disabled={busy} onClick={resume}>
        {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Bu cihazdan yedeklemeye devam
      </button>
    </div>
  );
}

// Depo anahtarları: eski cihazın anahtarı iki depodan da kaldırılır (parola + yazılı onay). Bu cihazın ve (büyük olasılıkla)
// parolanın anahtarı için düğme yok; backend / vault.sh de reddeder.
function KeysSection({ job, running, onJob }: { job: Job | null; running: boolean; onJob: () => void }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [filesMissing, setFilesMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<KeyRow | null>(null);
  const [loadN, setLoadN] = useState(0);
  // Kaldırma işi bitince liste (açıksa) yenilenir
  const removedId = job?.cmd === 'key-remove' && job.state !== 'running' ? job.id || '' : '';
  useEffect(() => {
    if (!loadN) return;
    let alive = true;
    getJson<{ keys: KeyRow[]; filesMissing: boolean }>('/vault/keys')
      .then(r => { if (alive) { setKeys(r.keys); setFilesMissing(r.filesMissing); setLoading(false); } })
      .catch(e => { if (alive) { toast.error(`Anahtarlar okunamadı: ${errText(e, 'bilinmeyen hata')}`); setLoading(false); } });
    return () => { alive = false; };
  }, [loadN, removedId]);
  const load = () => { setLoading(true); setLoadN(n => n + 1); };
  return (
    <Panel title="Depo anahtarları" icon={<KeyRound size={18} style={{ marginRight: 8 }} />} className="cb-panel"
      actions={<button className="btn-outline btn-sm" disabled={loading} onClick={load}>{loading ? <Loader2 size={13} className="spin" /> : null} {keys ? 'Yenile' : 'Listele'}</button>}>
      <p className="cb-help">Depoyu açan anahtarlar: şifreleme parolanız ve her bağlı cihazın rastgele anahtarı. Eski (bozulan, satılan) cihazın
        anahtarını kaldırın: o cihaz ya da SD kartı başkasının eline geçse de depoya ulaşamaz. Kovadaki yedekler silinmez.</p>
      {filesMissing && <div className="cb-note cb-note-warn"><AlertTriangle size={16} /><span>Bu cihazın anahtarı dosya deposunda yok — dosya deposu listelenemedi.</span></div>}
      {keys && (
        <div className="cr-keys">
          {keys.map(k => (
            <div key={k.id} className="cr-key">
              <div className="cr-key-main">
                <strong>{k.host || '—'}</strong>
                <span>{at(k.created)} · <code>{k.id.slice(0, 8)}</code>
                  {!k.configId ? ' · yalnız dosya deposunda' : !k.filesId && !filesMissing ? ' · yalnız ayar deposunda' : ''}</span>
              </div>
              {k.current ? <span className="cr-tag">bu cihaz</span>
                : k.likelyPassphrase ? <span className="cr-tag" title="Depoyu ilk oluşturan anahtar">parola</span>
                  : <button className="btn-outline btn-sm" disabled={running} onClick={() => setTarget(k)}><Trash2 size={13} /> Kaldır</button>}
            </div>
          ))}
        </div>
      )}
      {target && <KeyRemoveModal k={target} onClose={() => setTarget(null)} onStarted={() => { setTarget(null); onJob(); }} />}
    </Panel>
  );
}
function KeyRemoveModal({ k, onClose, onStarted }: { k: KeyRow; onClose: () => void; onStarted: () => void }) {
  const [pw, setPw] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = pw.length >= 12 && typed.trim() === k.host && !busy;
  const submit = async () => {
    setBusy(true);
    try {
      await postApi('/vault/keys/remove', { key: k.id, passphrase: pw });
      toast.info('Eski cihazın anahtarı siliniyor…');
      onStarted();
    } catch (e: unknown) {
      toast.error(errText(e, 'Kaldırılamadı'));
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Eski cihazın anahtarını kaldır" width={460}
      actions={<>
        <button className="btn-outline" onClick={onClose}>Vazgeç</button>
        <button className="btn-primary" disabled={!ok} onClick={submit}>{busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} Anahtarı kaldır</button>
      </>}>
      <p className="cb-help" style={{ marginTop: 0 }}>
        <strong>{k.host}</strong> cihazının anahtarı ({at(k.created)}) ayar ve dosya deposundan silinir. O anahtarla depo bir daha açılamaz —
        geri alınamaz. Kovadaki yedekler ve bu cihazın erişimi değişmez.
      </p>
      <div className="form-group">
        <label htmlFor="cr-kpw">Şifreleme parolası</label>
        <input id="cr-kpw" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
      </div>
      <div className="form-group">
        <label htmlFor="cr-ktyped">Onay için cihaz kimliğini yazın: <code>{k.host}</code></label>
        <input id="cr-ktyped" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
    </Modal>
  );
}

// Dosyaları geri yükle: kökün altında YENİ bir klasöre (geri-yuklenen-YYYYMMDD-HHMM) — hiçbir dosyanın üzerine yazılmaz
function FilesSection({ job, running, lowMem, onJob }: { job: Job | null; running: boolean; lowMem: boolean; onJob: () => void }) {
  const { data: storage } = useApi<StorageInfo>('/storage', {});
  const { data: share } = useApi<ShareInfo>('/storage/share', {});
  const [snaps, setSnaps] = useState<Snap[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [snap, setSnap] = useState('');
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const parts = (storage.disks || []).flatMap(d => d.parts);
  const roots: { path: string; label: string; avail?: number | null }[] = [];
  if (storage.layout?.shareMounted) {
    roots.push({ path: '/mnt/klyrix-share/Paylasim', label: 'Paylaşım alanı (Paylasim)', avail: parts.find(p => p.path === storage.layout?.shareDev)?.fsAvail });
  }
  for (const u of share.usb || []) {
    if (u.mounted) roots.push({ path: `/mnt/klyrix-usb/${u.name}`, label: `USB disk: ${u.name}`, avail: parts.find(p => p.shareName === u.name)?.fsAvail });
  }
  const rootSel = root || roots[0]?.path || '';
  const chosen = (snaps || []).find(s => s.id === snap);
  const lastDone = job?.cmd === 'restore-files' && job.state === 'done' ? job.msg : '';
  const list = async () => {
    setLoading(true);
    try {
      const r = await getJson<{ snapshots: Snap[] }>('/vault/snapshots?repo=files');
      const s = [...r.snapshots].sort((a, b) => b.time.localeCompare(a.time));
      setSnaps(s);
      if (s[0] && !snap) setSnap(s[0].id);
    } catch (e: unknown) {
      toast.error(`Klasör yedekleri okunamadı: ${errText(e, 'bilinmeyen hata')}`);
    }
    setLoading(false);
  };
  const start = async () => {
    if (!chosen || !rootSel) return;
    if (!window.confirm(`Klasör yedeği (${at(chosen.time)}${chosen.bytes ? `, ~${size(chosen.bytes)}` : ''}) ${rootSel} altında yeni bir klasöre indirilsin mi?\n\nVar olan dosyalara dokunulmaz.`)) return;
    setBusy(true);
    try {
      await postApi('/vault/restore/files', { snapshot: chosen.id, root: rootSel });
      toast.info('Dosyalar indiriliyor…');
      onJob();
    } catch (e: unknown) {
      toast.error(errText(e, 'Başlatılamadı'));
    }
    setBusy(false);
  };
  return (
    <Panel title="Dosyaları geri yükle (isteğe bağlı)" icon={<FolderDown size={18} style={{ marginRight: 8 }} />} className="cb-panel"
      actions={<button className="btn-outline btn-sm" disabled={loading} onClick={list}>{loading ? <Loader2 size={13} className="spin" /> : null} {snaps ? 'Yenile' : 'Listele'}</button>}>
      <p className="cb-help">Klasör yedeği seçtiğiniz diskte <strong>yeni bir klasöre</strong> (geri-yuklenen-YYYYMMDD-HHMM) indirilir; var olan hiçbir
        dosyanın üzerine yazılmaz. Klasörün içinde yedeklenen yollar aynen durur (ör. …/mnt/klyrix-share/Paylasim/…); sahibi paylaşımın
        kullanıcısı olur, dosyaları ağ paylaşımından taşıyıp silebilirsiniz. Önce Depolama sayfasında
        veri diskini hazırlayıp paylaşımı ya da USB diski açın. Yedek hattındayken başlamaz.</p>
      {lowMem && (
        <div className="cb-note cb-note-warn">
          <AlertTriangle size={16} />
          <span>Bu cihazın belleği az (512 MB sınıfı): büyük bir klasör yedeğini geri yüklerken restic belleğe sığmayabilir. İş «Bellek
            yetmedi» diye biterse dosyaları daha çok belleği olan bir bilgisayarda kurtarma kitindeki restic komutlarıyla açın.</span>
        </div>
      )}
      {snaps && snaps.length === 0 && <p className="cb-hint">Klasör yedeği yok.</p>}
      {snaps && snaps.length > 0 && (
        <div className="cb-grid">
          <div className="form-group">
            <label htmlFor="cr-fsnap">Klasör yedeği</label>
            <Select id="cr-fsnap" value={snap} onChange={e => setSnap(e.target.value)} columns={['mono', 'text', 'num']}>
              {snaps.slice(0, 40).map(s => <SelectOption key={s.id} value={s.id} cols={[at(s.time), s.hostname, s.bytes ? size(s.bytes) : '']} />)}
            </Select>
          </div>
          <div className="form-group">
            <label htmlFor="cr-froot">Hedef disk</label>
            {roots.length ? (
              <Select id="cr-froot" value={rootSel} onChange={e => setRoot(e.target.value)}>
                {roots.map(r => <SelectOption key={r.path} value={r.path} cols={[r.label, r.avail != null ? `${size(r.avail)} boş` : '']} />)}
              </Select>
            ) : <p className="cb-hint cb-bad">Bağlı paylaşım alanı ya da ağda paylaşılan USB disk yok — Depolama sayfasından hazırlayın.</p>}
          </div>
        </div>
      )}
      {snaps && snaps.length > 0 && (
        <div className="cb-actions">
          <button className="btn-primary btn-sm" disabled={!chosen || !rootSel || running || busy} onClick={start}>
            {busy ? <Loader2 size={13} className="spin" /> : <FolderDown size={13} />} Yeni klasöre geri yükle
          </button>
          {chosen?.bytes ? <span className="cb-hint">Yaklaşık {size(chosen.bytes)} indirilecek.</span> : null}
        </div>
      )}
      {lastDone && <div className="cb-note cb-note-info"><CheckCircle2 size={16} /><span>{lastDone}</span></div>}
    </Panel>
  );
}

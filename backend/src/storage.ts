// Depolama: takılı diskler ve bölümleri, doluluk, disk sıcaklığı ve panelin verilerinin (panel veritabanı, Pi-hole sorgu
// veritabanı, günlükler) hangi diskte durduğu; veri diski işleri (eski sistemi arşivle, diski hazırla, verileri taşı).
//  - lsblk -J: tek komutla ağaç + bağlama noktaları + dosya sistemi doluluğu (FSSIZE/FSUSED/FSAVAIL).
//  - findmnt -T: bir yolun hangi bölümde olduğu (sembolik bağlantı ve bind mount dahil).
//  - Dashboard'daki "Disk" satırı yalnız bağlı bölümleri toplar; bağlı olmayan (ör. eski bir sistemden kalan) bölümler
//    ancak burada görünür.
//  - İşler scripts/storage.sh'dedir ve pi5-backend'in DIŞINDA koşar (systemd-run → pi5-storage birimi): disk hazırlama ve
//    taşıma panel servisini durdurup yeniden başlatır. Durum /run/pi5-storage/state (KEY=VALUE), çıktı .../output.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isLinux } from './system';
import { dbGet, dbRun } from './db';
import { recordEvent } from './events';
import { parseKv } from './update';

const execFileP = promisify(execFile);

const DATA_LABEL = 'klyrix-data';
const SHARE_LABEL = 'klyrix-share';
const DATA_MNT = '/mnt/klyrix-data';
const SHARE_MNT = '/mnt/klyrix-share';
const USB_SHARE_MNT = '/mnt/klyrix-usb';   // share.sh: panelden ağda paylaşılan USB bölümleri
const SCRIPT = path.resolve(__dirname, '../../scripts/storage.sh');

export type DiskKind = 'sd' | 'nvme' | 'usb' | 'other';
export interface StoragePart {
  name: string; path: string; size: number; fstype: string; label: string; uuid: string;
  mounts: string[]; fsSize: number | null; fsUsed: number | null; fsAvail: number | null; note: string;
  archivable?: boolean;  // eski bir sistem gibi arşivlenebilir (sistem diskinde değil, bağlı değil, Linux dosya sistemi)
  shareName?: string;    // ağda paylaşılan USB bölümü: paylaşım adı (/mnt/klyrix-usb/<ad>)
}
export interface StorageDisk {
  name: string; path: string; size: number; model: string; tran: string; removable: boolean; kind: DiskKind;
  role: 'system' | 'data' | 'external' | 'unused'; tempC: number | null; parts: StoragePart[];
  preparable: boolean;   // veri diski olarak hazırlanabilir (dahili disk: NVMe / SATA; sistem diski, SD ve USB değil)
}
export interface DataPlacement { key: 'panel' | 'pihole' | 'logs'; label: string; path: string; device: string; mount: string; kind: DiskKind | 'unknown' }
// Veri diski düzeni (storage.sh): klyrix-data / klyrix-share etiketli bölümler ve bağlı olup olmadıkları.
export interface StorageLayout { dataDev: string; dataMounted: boolean; shareDev: string; shareMounted: boolean }
export interface StorageStatus {
  supported: boolean; disks: StorageDisk[]; placement: DataPlacement[]; findings: { level: 'info' | 'warn'; text: string }[];
  layout?: StorageLayout; archives?: string[];
}

interface LsblkNode {
  name: string; path?: string; size?: number | string; type?: string; fstype?: string | null; label?: string | null;
  partlabel?: string | null; uuid?: string | null; mountpoints?: (string | null)[]; mountpoint?: string | null;
  model?: string | null; tran?: string | null; rm?: boolean | string | number;
  fssize?: number | string | null; fsused?: number | string | null; fsavail?: number | string | null; children?: LsblkNode[];
}

const n = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const GB = 1e9;
const human = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= GB ? `${Math.round(b / GB)} GB` : `${Math.round(b / 1e6)} MB`);

function diskTemp(name: string): number | null {
  // NVMe: /sys/block/nvme0n1/device → denetleyici (nvme0), hwmon onun altında. USB/SD diskler genelde sıcaklık vermez.
  try {
    const base = `/sys/block/${name}/device`;
    for (const h of fs.readdirSync(base).filter(d => d.startsWith('hwmon'))) {
      const t = Number(fs.readFileSync(path.join(base, h, 'temp1_input'), 'utf8'));
      if (Number.isFinite(t) && t > 0) return Math.round(t / 100) / 10;
    }
  } catch { /* yok */ }
  return null;
}

function partNote(p: { mounts: string[]; fstype: string; label: string }): string {
  if (p.mounts.includes('/')) return 'Sistem (kök dizin)';
  if (p.mounts.some(m => m.startsWith('/boot'))) return 'Açılış bölümü';
  if (p.mounts.includes('[SWAP]')) return 'Takas alanı';
  if (p.mounts.includes(DATA_MNT)) return 'Veri bölümü (panel verileri, Pi-hole, günlükler)';
  if (p.mounts.includes(SHARE_MNT)) return 'Paylaşım alanı';
  if (p.mounts.some(m => m.startsWith(`${USB_SHARE_MNT}/`))) return 'Ağda paylaşılıyor';
  if (p.mounts.some(m => m.startsWith('/mnt/ssd'))) return 'Panel verileri';
  if (p.mounts.length) return `Bağlı: ${p.mounts.join(', ')}`;
  if (p.label === DATA_LABEL) return 'Veri bölümü — bağlı değil';
  if (p.label === SHARE_LABEL) return 'Paylaşım alanı — bağlı değil';
  if (!p.fstype) return 'Biçimlendirilmemiş';
  if (p.label === 'rootfs') return 'Eski bir sistemin kök bölümü (bağlı değil)';
  if (p.label === 'bootfs') return 'Eski bir sistemin açılış bölümü (bağlı değil)';
  return 'Bağlı değil';
}

async function findMount(p: string): Promise<{ source: string; target: string }> {
  try {
    const { stdout } = await execFileP('findmnt', ['-J', '-n', '-o', 'SOURCE,TARGET', '-T', p], { timeout: 4000 });
    const fsys = JSON.parse(stdout)?.filesystems?.[0];
    return { source: String(fsys?.source || '').replace(/\[.*\]$/, ''), target: String(fsys?.target || '') };
  } catch {
    return { source: '', target: '' };
  }
}

async function piholeDbPath(): Promise<string> {
  try {
    const { stdout } = await execFileP('pihole-FTL', ['--config', 'files.database'], { timeout: 5000 });
    const v = stdout.trim().split('\n').pop()?.trim() || '';
    if (v.startsWith('/')) return v;
  } catch { /* Pi-hole yok ya da v5 */ }
  return '/etc/pihole/pihole-FTL.db';
}

const ARCHIVE_FS = /^(ext[234]|xfs|btrfs)$/;
// USB diskler veri diski yapılmaz (çıkarılabilir); SD kart ve işletim sisteminin diski hiçbir zaman.
const preparable = (d: Pick<StorageDisk, 'role' | 'kind' | 'removable'>) =>
  d.role !== 'system' && (d.kind === 'nvme' || d.kind === 'other') && !d.removable;

// storage.sh archive'ın varsayılan hedefleri: /home/<kullanıcı>/eski-sistem-arsivi-YYYYMMDD-HHMM
function listArchives(): string[] {
  const out: string[] = [];
  try {
    for (const u of fs.readdirSync('/home')) {
      try {
        for (const a of fs.readdirSync(path.join('/home', u))) if (a.startsWith('eski-sistem-arsivi-')) out.push(path.join('/home', u, a));
      } catch { /* okunamayan ev dizini */ }
    }
  } catch { /* /home yok */ }
  return out.sort();
}

let cache: { at: number; data: StorageStatus } | null = null;
export async function storageStatus(): Promise<StorageStatus> {
  if (!isLinux) return { supported: false, disks: [], placement: [], findings: [] };
  // Önbellek: bir depolama işi bu arada ilerlediyse / bittiyse (durum dosyası daha yeni) kullanılmaz
  if (cache && Date.now() - cache.at < 5000 && jobStateMtime() < cache.at) return cache.data;
  const { stdout } = await execFileP('lsblk', ['-J', '-b', '-o',
    'NAME,PATH,SIZE,TYPE,FSTYPE,LABEL,PARTLABEL,UUID,MOUNTPOINTS,MODEL,TRAN,RM,FSSIZE,FSUSED,FSAVAIL'], { timeout: 5000 });
  const nodes: LsblkNode[] = JSON.parse(stdout)?.blockdevices || [];
  const partOwner = new Map<string, StorageDisk>();
  const disks: StorageDisk[] = [];
  for (const d of nodes) {
    if (d.type !== 'disk' || /^(zram|ram|loop|mtdblock)/.test(d.name)) continue;
    const tran = String(d.tran || (d.name.startsWith('mmcblk') ? 'mmc' : ''));
    const kind: DiskKind = tran === 'mmc' ? 'sd' : tran === 'nvme' ? 'nvme' : tran === 'usb' ? 'usb' : 'other';
    // Bölümsüz disk (doğrudan dosya sistemi) kendisi tek bölüm gibi gösterilir.
    const kids = d.children?.length ? d.children.filter(c => c.type === 'part') : (d.fstype ? [d] : []);
    const parts: StoragePart[] = kids.map(c => {
      const mounts = (c.mountpoints || (c.mountpoint ? [c.mountpoint] : [])).filter((m): m is string => !!m);
      const base = { mounts, fstype: String(c.fstype || ''), label: String(c.label || '') };
      return {
        name: c.name, path: String(c.path || `/dev/${c.name}`), size: n(c.size) || 0, ...base, uuid: String(c.uuid || ''),
        fsSize: n(c.fssize), fsUsed: n(c.fsused), fsAvail: n(c.fsavail), note: partNote(base),
      };
    });
    const all = parts.flatMap(p => p.mounts);
    const role: StorageDisk['role'] = all.some(m => m === '/' || m.startsWith('/boot')) ? 'system'
      : all.some(m => m.startsWith('/mnt/ssd')) || parts.some(p => p.label.startsWith('klyrix')) ? 'data'
        : kind === 'usb' ? 'external' : 'unused';
    const removable = d.rm === true || d.rm === '1' || d.rm === 1;
    const disk: StorageDisk = {
      name: d.name, path: String(d.path || `/dev/${d.name}`), size: n(d.size) || 0, model: String(d.model || '').trim(), tran,
      removable, kind, role, tempC: diskTemp(d.name), parts, preparable: false,
    };
    disk.preparable = preparable(disk);
    for (const p of parts) {
      p.archivable = role !== 'system' && !p.mounts.length && ARCHIVE_FS.test(p.fstype) && !p.label.startsWith('klyrix');
      const sm = p.mounts.find(m => m.startsWith(`${USB_SHARE_MNT}/`));
      if (sm) p.shareName = sm.slice(USB_SHARE_MNT.length + 1);
    }
    disks.push(disk);
    for (const p of parts) partOwner.set(p.path, disk);
  }

  const targets: [DataPlacement['key'], string, string][] = [
    ['panel', 'Panel verileri (ayarlar, ölçüm ve trafik geçmişi, bildirimler)', fs.realpathSync(path.resolve(__dirname, '../../core'))],
    ['pihole', 'Pi-hole DNS sorgu veritabanı', await piholeDbPath()],
    ['logs', 'Sistem ve servis günlükleri', '/var/log'],
  ];
  const SHORT: Record<DataPlacement['key'], string> = { panel: 'panel verileri', pihole: 'Pi-hole sorgu veritabanı', logs: 'günlükler' };
  const placement: DataPlacement[] = [];
  for (const [key, label, p] of targets) {
    const m = await findMount(fs.existsSync(p) ? p : path.dirname(p));
    placement.push({ key, label, path: p, device: m.source, mount: m.target, kind: partOwner.get(m.source)?.kind || 'unknown' });
  }

  const allParts = disks.flatMap(d => d.parts);
  const dataPart = allParts.find(p => p.label === DATA_LABEL);
  const sharePart = allParts.find(p => p.label === SHARE_LABEL);
  const layout: StorageLayout = {
    dataDev: dataPart?.path || '', dataMounted: !!dataPart?.mounts.includes(DATA_MNT),
    shareDev: sharePart?.path || '', shareMounted: !!sharePart?.mounts.includes(SHARE_MNT),
  };

  const findings: StorageStatus['findings'] = [];
  const extra = disks.filter(d => d.kind !== 'sd');
  if (dataPart && !layout.dataMounted) {
    findings.push({ level: 'warn', text: `Veri bölümü (${dataPart.name}) bağlı değil: panel, Pi-hole ve günlükler SD karttaki kopyayla çalışıyor. Pi'yi yeniden başlatın; düzelmezse diskin takılı olduğunu denetleyin.` });
  }
  for (const d of extra) {
    for (const p of d.parts.filter(p => !p.mounts.length && p.size > 8 * GB && p.label !== DATA_LABEL)) {
      findings.push({ level: 'warn', text: `${p.name} (${human(p.size)}) kullanılmıyor: ${p.note.toLowerCase()}.` });
    }
  }
  const panel = placement[0];
  const panelPart = disks.flatMap(d => d.parts).find(p => p.path === panel.device);
  if (panelPart && panel.kind !== 'sd' && panelPart.size < 4 * GB) {
    findings.push({ level: 'warn', text: `Panel verileri diskin yalnız ${human(panelPart.size)}'lık bir bölümünde duruyor.` });
  }
  if (extra.length && placement.some(p => p.kind === 'sd')) {
    const onSd = placement.filter(p => p.kind === 'sd').map(p => SHORT[p.key]);
    const hint = layout.dataMounted ? ' «Verileri diske taşı» ile diske alınabilir.'
      : !dataPart && extra.some(preparable) ? ' Diski aşağıdan «Diski hazırla» ile veri diski yapabilirsiniz.' : '';
    findings.push({ level: 'info', text: `Ek disk takılı ama şunlar hâlâ SD kartta: ${onSd.join(', ')}.${hint}` });
  }
  if (!extra.length) findings.push({ level: 'info', text: 'Ek disk yok: tüm veriler SD kartta. Bu da desteklenen bir kurulumdur.' });

  const data: StorageStatus = { supported: true, disks, placement, findings, layout, archives: listArchives() };
  cache = { at: Date.now(), data };
  return data;
}

// ─── İşler: eski sistemi arşivle, diski hazırla, verileri diske taşı (scripts/storage.sh) ───────────────────────────
// İş pi5-backend'in DIŞINDA koşar (systemd-run, update.ts ile aynı yol): hazırlama ve taşıma panel servisini durdurup
// yeniden başlatır. Backend durumu systemd-run'dan ÖNCE yazar; betik (PI5_STORAGE_ID) aynı dosyayı günceller.
const STORAGE_UNIT = 'pi5-storage';
const JOB_DIR = '/run/pi5-storage';
const JOB_STATE = `${JOB_DIR}/state`;
const JOB_OUTPUT = `${JOB_DIR}/output`;
const JOB_LOCK = '/run/pi5-storage.lock';
const JOB_MAX_RUNTIME_S = 4 * 3600;   // büyük bir eski sistemin SD karta arşivi uzun sürebilir
const START_GRACE_S = 15;             // bu süre içinde birim henüz görünmüyorsa iş "yarıda kesildi" sayılmaz
const NOTIFIED_KEY = 'storage_job_notified';

export type StorageCmd = 'archive' | 'prepare' | 'migrate' | 'share';
export interface StorageJob {
  state: 'idle' | 'running' | 'done' | 'failed';
  id?: string; cmd?: StorageCmd; step?: string; pct?: number; msg?: string; error?: string;
  startedAt?: number; finishedAt?: number; log?: string[];
}
const CMD_LABEL: Record<StorageCmd, string> = {
  archive: 'Eski sistem arşivi', prepare: 'Disk hazırlama', migrate: 'Verileri diske taşıma', share: 'Ağ paylaşımını açma',
};
// Biten iş için başka modüllerin işi (ör. share.ts: paylaşım açılınca erişim listesi ve güvenlik duvarı zinciri)
const doneHooks: ((j: StorageJob) => void)[] = [];
export function onStorageJobDone(cb: (j: StorageJob) => void): void { doneHooks.push(cb); }
const numOf = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

function jobStateMtime(): number {
  try { return fs.statSync(JOB_STATE).mtimeMs; } catch { return 0; }
}

function readJobState(): Record<string, string> | null {
  try { return parseKv(fs.readFileSync(JOB_STATE, 'utf8')); } catch { return null; }
}

function writeJobState(text: string) {
  const tmp = `${JOB_STATE}.b${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, JOB_STATE);
}

function jobLog(lines = 40): string[] {
  try {
    const buf = fs.readFileSync(JOB_OUTPUT);
    return buf.subarray(Math.max(0, buf.length - 65536)).toString('utf8').split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

// systemctl okunamazsa 'unknown': süren bir işi yanlışlıkla "yarıda kesildi" saymayalım, ikinci iş de başlatmayalım.
async function unitState(unit: string): Promise<'active' | 'inactive' | 'unknown'> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', '-p', 'ActiveState', '--value', `${unit}.service`], { timeout: 5000 });
    return /^(active|activating|deactivating|reloading)$/.test(stdout.trim()) ? 'active' : 'inactive';
  } catch {
    return 'unknown';
  }
}

export async function storageJob(): Promise<StorageJob> {
  const kv = readJobState();
  if (!kv?.id) return { state: 'idle' };
  const base = {
    id: kv.id, cmd: kv.cmd as StorageCmd, step: kv.step || undefined, pct: numOf(kv.pct), msg: kv.msg || undefined,
    error: kv.error || undefined, startedAt: numOf(kv.started), finishedAt: numOf(kv.finished), log: jobLog(),
  };
  if (kv.state === 'running') {
    const young = Math.floor(Date.now() / 1000) - (base.startedAt ?? 0) < START_GRACE_S;
    if (young || (await unitState(STORAGE_UNIT)) !== 'inactive') return { ...base, state: 'running' };
    // Birim yok ama durum "sürüyor": iş sonucu yazamadan öldü (SIGKILL vb.)
    return { ...base, state: 'failed', error: 'İş yarıda kesildi — ayrıntı aşağıdaki günlükte' };
  }
  return { ...base, state: kv.state === 'done' ? 'done' : 'failed' };
}

// Biten iş için bir kez olay (Bildirimler). Hazırlama ve taşıma panel servisini yeniden başlattığı için "bildirildi"
// kaydı app_settings'te tutulur; açılışta ve iş izlenirken denetlenir.
let noting = false;
export async function noteStorageJob(): Promise<void> {
  if (noting) return;
  noting = true;
  try {
    const j = await storageJob();
    if (!j.id || (j.state !== 'done' && j.state !== 'failed')) return;
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [NOTIFIED_KEY]);
    if (row?.value === j.id) return;
    await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [NOTIFIED_KEY, j.id]);
    for (const h of doneHooks) { try { h(j); } catch { /* kanca hatası işi bozmaz */ } }
    const label = j.cmd ? CMD_LABEL[j.cmd] : 'Depolama işi';
    if (j.state === 'done') await recordEvent('storage', j.msg || `${label} tamamlandı`, /taşınamadı/.test(j.msg || '') ? 'warning' : 'info');
    else await recordEvent('storage', `${label} başarısız: ${j.error || 'ayrıntı Depolama sayfasında'}`, 'warning');
  } catch (e: any) {
    console.error('[depolama] iş sonucu kaydedilemedi:', e?.message || e);
  } finally {
    noting = false;
  }
}

let watchTimer: NodeJS.Timeout | null = null;
function watchJob(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    storageJob().then(j => {
      if (j.state === 'running') return;
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      cache = null;
      return noteStorageJob();
    }).catch(() => { /* sonraki turda */ });
  }, 10000);
}

// Açılışta: panel servisi bir işin sonunda yeniden başlatıldıysa sonucu bildir; iş sürüyorsa izle.
export function startStorageWatch(): void {
  if (!isLinux) return;
  setTimeout(() => {
    storageJob().then(j => (j.state === 'running' ? watchJob() : noteStorageJob())).catch(() => {});
  }, 8000);
}

// Depolama işi ile bulut yedeği işi (vault.ts) aynı anda başlatılmasın: iki başlatıcı da birim durumu denetiminden
// systemd-run dönene kadar bu kapıyı tutar (bulut yedeği arada ayar dökümünü hazırlar — denetim ile başlatma arasında
// öbürü araya giremez). Değer: kapıyı tutanın adı ('' = boş).
let jobGate = '';
export function holdJobGate(owner: 'storage' | 'vault'): string {
  if (jobGate) return jobGate;
  jobGate = owner;
  return '';
}
export function freeJobGate(owner: 'storage' | 'vault'): void {
  if (jobGate === owner) jobGate = '';
}

let launching = false;
// script / scriptCmd: paylaşım işi (share.ts) aynı birimi ve durum dosyasını scripts/share.sh ile kullanır.
export async function launchStorageJob(cmd: StorageCmd, args: string[], startMsg: string, script = SCRIPT, scriptCmd: string = cmd): Promise<{ id: string }> {
  if (!isLinux) throw new Error('Depolama işleri yalnız Pi üzerinde çalışır');
  if (!fs.existsSync(script)) throw new Error(`scripts/${path.basename(script)} bulunamadı — paneli güncelleyin`);
  if (launching) throw new Error('Bir depolama işi başlatılıyor');
  launching = true;
  try {
    if (holdJobGate('storage')) throw new Error('Bulut yedeği işi başlatılıyor — bitince yeniden deneyin');
    // Bulut yedeği (vault.ts, pi5-vault) paylaşım klasörlerini okurken hazırlama / taşıma onları ayıramaz ("kullanımda")
    const [unit, upd, vault] = await Promise.all([unitState(STORAGE_UNIT), unitState('pi5-update'), unitState('pi5-vault')]);
    if (unit === 'unknown' || upd === 'unknown' || vault === 'unknown') throw new Error('İş durumu okunamadı (systemctl) — birazdan yeniden deneyin');
    if (unit === 'active') throw new Error('Bir depolama işi zaten sürüyor');
    if (upd === 'active') throw new Error('Panel güncellemesi sürüyor — bitince yeniden deneyin');
    if (vault === 'active') throw new Error('Bulut yedeği sürüyor — bitince yeniden deneyin');
    // Kilit: güncelleme sonrası denetim (storage.sh ensure) ya da elle başlatılmış bir komut sürüyorsa bekle
    try {
      await execFileP('flock', ['-n', JOB_LOCK, 'true'], { timeout: 5000 });
    } catch {
      throw new Error('Başka bir depolama işlemi sürüyor — birazdan yeniden deneyin');
    }
    const id = String(Date.now());
    const started = Math.floor(Date.now() / 1000);
    fs.mkdirSync(JOB_DIR, { recursive: true });
    fs.writeFileSync(JOB_OUTPUT, '');
    writeJobState(`id=${id}\nstate=running\ncmd=${cmd}\nstarted=${started}\npct=0\nstep=Başlatılıyor\n`);
    try {
      await execFileP('systemd-run', [
        '--quiet', '--collect', `--unit=${STORAGE_UNIT}`, '--service-type=exec',
        '--description=Klyrix Gate depolama işi', '-p', `RuntimeMaxSec=${JOB_MAX_RUNTIME_S}`, `--setenv=PI5_STORAGE_ID=${id}`,
        '/bin/bash', script, scriptCmd, ...args,
      ], { timeout: 15000 });
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'systemd-run hatası';
      fs.writeFileSync(JOB_OUTPUT, `İş başlatılamadı: ${msg}\n`);
      writeJobState(`id=${id}\nstate=failed\ncmd=${cmd}\nstarted=${started}\nfinished=${Math.floor(Date.now() / 1000)}\nerror=İş başlatılamadı: ${msg}\n`);
      throw new Error(`Depolama işi başlatılamadı: ${msg}`);
    }
    await recordEvent('storage', startMsg);
    cache = null;
    watchJob();
    return { id };
  } finally {
    freeJobGate('storage');
    launching = false;
  }
}

async function freshStatus(): Promise<StorageStatus> {
  cache = null;
  return storageStatus();
}

export async function startArchive(src: unknown): Promise<{ id: string }> {
  const st = await freshStatus();
  const part = st.disks.flatMap(d => d.parts).find(p => p.path === src);
  if (!part) throw new Error('Bölüm bulunamadı');
  if (!part.archivable) throw new Error('Bu bölüm arşivlenemez (sistem diskinde, bağlı ya da Linux dosya sistemi değil)');
  return launchStorageJob('archive', ['--src', part.path], `Eski sistem arşivi başlatıldı: ${part.name}`);
}

// Onay metni: diskin model adı (yoksa GB cinsinden boyutu) — storage.sh aynı denetimi yeniden yapar.
const confirmText = (d: Pick<StorageDisk, 'model' | 'size'>) => d.model || String(Math.floor(d.size / 1e9));

export async function startPrepare(body: { disk?: unknown; systemGb?: unknown; share?: unknown; confirm?: unknown }): Promise<{ id: string }> {
  const st = await freshStatus();
  const disk = st.disks.find(d => d.path === body.disk);
  if (!disk) throw new Error('Disk bulunamadı');
  if (!disk.preparable) throw new Error('Bu disk veri diski olarak hazırlanamaz (sistem diski, SD kart ya da USB disk)');
  const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
  if (confirm !== confirmText(disk)) throw new Error(`Onay eşleşmedi: diski silmek için "${confirmText(disk)}" yazın`);
  const share = body.share !== false;
  const args = ['--disk', disk.path, '--confirm', confirm];
  let layout = 'tek bölüm';
  if (share) {
    const gb = Number(body.systemGb);
    const totalGib = Math.floor(disk.size / 2 ** 30);
    if (!Number.isInteger(gb) || gb < 8 || gb + 8 > totalGib) throw new Error(`Sistem verileri bölümü 8 ile ${totalGib - 8} GB arasında olmalı`);
    args.push('--system-gb', String(gb));
    layout = `${gb} GB sistem verileri + paylaşım`;
  } else {
    args.push('--no-share');
  }
  return launchStorageJob('prepare', args, `Disk hazırlama başlatıldı: ${disk.path} (${layout})`);
}

export async function startMigrate(): Promise<{ id: string }> {
  const st = await freshStatus();
  if (!st.layout?.dataMounted) throw new Error('Veri bölümü (klyrix-data) bağlı değil — önce diski hazırlayın');
  return launchStorageJob('migrate', [], 'Verileri veri diskine taşıma başlatıldı');
}

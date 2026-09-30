// Depolama (salt okunur): takılı diskler ve bölümleri, doluluk, disk sıcaklığı ve panelin verilerinin (panel veritabanı,
// Pi-hole sorgu veritabanı, günlükler) hangi diskte durduğu. Hiçbir şey yazmaz ya da bağlamaz.
//  - lsblk -J: tek komutla ağaç + bağlama noktaları + dosya sistemi doluluğu (FSSIZE/FSUSED/FSAVAIL).
//  - findmnt -T: bir yolun hangi bölümde olduğu (sembolik bağlantı ve bind mount dahil).
//  - Dashboard'daki "Disk" satırı yalnız bağlı bölümleri toplar; bağlı olmayan (ör. eski bir sistemden kalan) bölümler
//    ancak burada görünür.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isLinux } from './system';

const execFileP = promisify(execFile);

export type DiskKind = 'sd' | 'nvme' | 'usb' | 'other';
export interface StoragePart {
  name: string; path: string; size: number; fstype: string; label: string; uuid: string;
  mounts: string[]; fsSize: number | null; fsUsed: number | null; fsAvail: number | null; note: string;
}
export interface StorageDisk {
  name: string; path: string; size: number; model: string; tran: string; removable: boolean; kind: DiskKind;
  role: 'system' | 'data' | 'external' | 'unused'; tempC: number | null; parts: StoragePart[];
}
export interface DataPlacement { key: 'panel' | 'pihole' | 'logs'; label: string; path: string; device: string; mount: string; kind: DiskKind | 'unknown' }
export interface StorageStatus {
  supported: boolean; disks: StorageDisk[]; placement: DataPlacement[]; findings: { level: 'info' | 'warn'; text: string }[];
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
  if (p.mounts.some(m => m.startsWith('/mnt/ssd'))) return 'Panel verileri';
  if (p.mounts.length) return `Bağlı: ${p.mounts.join(', ')}`;
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

let cache: { at: number; data: StorageStatus } | null = null;
export async function storageStatus(): Promise<StorageStatus> {
  if (!isLinux) return { supported: false, disks: [], placement: [], findings: [] };
  if (cache && Date.now() - cache.at < 5000) return cache.data;
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
    const disk: StorageDisk = {
      name: d.name, path: String(d.path || `/dev/${d.name}`), size: n(d.size) || 0, model: String(d.model || '').trim(), tran,
      removable: d.rm === true || d.rm === '1' || d.rm === 1, kind, role, tempC: diskTemp(d.name), parts,
    };
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

  const findings: StorageStatus['findings'] = [];
  const extra = disks.filter(d => d.kind !== 'sd');
  for (const d of extra) {
    for (const p of d.parts.filter(p => !p.mounts.length && p.size > 8 * GB)) {
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
    findings.push({ level: 'info', text: `Ek disk takılı ama şunlar hâlâ SD kartta: ${onSd.join(', ')}.` });
  }
  if (!extra.length) findings.push({ level: 'info', text: 'Ek disk yok: tüm veriler SD kartta. Bu da desteklenen bir kurulumdur.' });

  const data: StorageStatus = { supported: true, disks, placement, findings };
  cache = { at: Date.now(), data };
  return data;
}

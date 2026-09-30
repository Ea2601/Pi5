import { HardDrive, MemoryStick, Usb, Thermometer, AlertTriangle, Info, Database, Loader2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel } from './ui';
import './StoragePanel.css';

// Depolama (backend storage.ts, salt okunur): takılı diskler ve bölümleri, doluluk, disk sıcaklığı ve panel verilerinin /
// Pi-hole sorgu veritabanının / günlüklerin hangi diskte durduğu. Dashboard'daki "Disk" satırı yalnız bağlı bölümleri
// toplar; bağlı olmayan bölümler (ör. eski bir sistemden kalan) yalnız burada görünür.
type DiskKind = 'sd' | 'nvme' | 'usb' | 'other';
interface Part {
  name: string; path: string; size: number; fstype: string; label: string; uuid: string;
  mounts: string[]; fsSize: number | null; fsUsed: number | null; fsAvail: number | null; note: string;
}
interface Disk {
  name: string; path: string; size: number; model: string; tran: string; removable: boolean; kind: DiskKind;
  role: 'system' | 'data' | 'external' | 'unused'; tempC: number | null; parts: Part[];
}
interface Placement { key: string; label: string; path: string; device: string; mount: string; kind: DiskKind | 'unknown' }
interface Status { supported?: boolean; disks?: Disk[]; placement?: Placement[]; findings?: { level: 'info' | 'warn'; text: string }[] }

const KIND = { sd: 'SD kart', nvme: 'NVMe SSD', usb: 'USB disk', other: 'Disk' } as const;
const ROLE = { system: 'Sistem diski', data: 'Veri diski', external: 'Harici disk', unused: 'Kullanılmıyor' } as const;

function size(b: number | null): string {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}
const KindIcon = ({ kind }: { kind: DiskKind }) => (kind === 'sd' ? <MemoryStick size={18} /> : kind === 'usb' ? <Usb size={18} /> : <HardDrive size={18} />);

export function StoragePanel() {
  const { data, loading } = useApi<Status>('/storage', {}, 15000);
  const disks = data.disks || [];
  const hasExtra = disks.some(d => d.kind !== 'sd');

  return (
    <div className="fade-in">
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
            <h4><Database size={14} /> Verilerin yeri</h4>
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
          </div>
        )}
      </Panel>

      <div className="st-disks">
        {disks.map(d => <DiskCard key={d.name} d={d} />)}
      </div>
    </div>
  );
}

function DiskCard({ d }: { d: Disk }) {
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
              ) : (
                <span className="st-part-usage st-muted">{p.mounts.length ? p.mounts.join(', ') : 'bağlı değil'}</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

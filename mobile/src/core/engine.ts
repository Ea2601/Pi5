// Yedekleme turu: telefondaki fotoğraf / videoları tarar, Pi'de olmayanları yükler. Telefonda hiçbir şey silinmez ya da
// değişmez. Kesilirse (süre doldu, ağ gitti, kullanıcı durdurdu) bir sonraki tur Pi'ye sorarak kaldığı yerden sürer.
import { type Client, PiError } from './client.ts';
import { assetKey, chunkPlan, WHOLE_MAX } from './protocol.ts';

class StopSignal extends Error {}

export interface MediaItem { id: string; filename: string; created: number | null; modified: number | null; video: boolean }
export interface Media {
  // Eskiden yeniye sayfa sayfa (offset / limit)
  page(offset: number, limit: number): Promise<MediaItem[]>;
  // Yüklenecek yerel dosya (iOS'ta gerekirse iCloud'dan indirilir); bulunamazsa null
  file(item: MediaItem): Promise<{ uri: string; size: number } | null>;
}
export interface Progress { phase: 'scan' | 'upload' | 'done'; scanned: number; pending: number; done: number; failed: number; current?: string; bytes: number }
export interface RunResult { uploaded: number; failed: number; pending: number; skipped: number; bytes: number; stopped: boolean; error?: string }
export interface RunOptions {
  videos: boolean;
  deadline?: number;                 // ms (Date.now() tabanı): arka plan görevinin süresi
  shouldStop?: () => boolean;
  onProgress?: (p: Progress) => void;
  pageSize?: number;
}

export async function runBackup(client: Client, media: Media, o: RunOptions): Promise<RunResult> {
  const stop = () => (o.shouldStop?.() ?? false) || (o.deadline !== undefined && Date.now() > o.deadline);
  const p: Progress = { phase: 'scan', scanned: 0, pending: 0, done: 0, failed: 0, bytes: 0 };
  const emit = () => o.onProgress?.({ ...p });
  const st = await client.status();
  if (!st.ok) throw new PiError(503, 'Pi\'de mobil yedekleme kapalı ya da Cihaz Yedekleme kapalı');
  if (st.target && !st.target.mounted) throw new PiError(503, 'Pi\'de yedek diski bağlı değil');

  // 1) Tara: Pi'de olmayanlar (eskiden yeniye)
  const todo: { item: MediaItem; key: string }[] = [];
  const size = o.pageSize ?? 500;
  let skipped = 0;
  for (let off = 0; ; off += size) {
    if (stop()) return { uploaded: 0, failed: 0, pending: todo.length, skipped, bytes: 0, stopped: true };
    const page = await media.page(off, size);
    if (!page.length) break;
    const items = page.filter(it => o.videos || !it.video).map(item => ({ item, key: assetKey(item.id, item.modified, item.created) }));
    const have = await client.have(items.map(x => x.key));
    for (const x of items) (have.has(x.key) ? skipped++ : todo.push(x));
    p.scanned += page.length; p.pending = todo.length; emit();
    if (page.length < size) break;
  }

  // 2) Yükle
  p.phase = 'upload'; emit();
  let uploaded = 0;
  let firstError = '';
  for (const { item, key } of todo) {
    if (stop()) return { uploaded, failed: p.failed, pending: todo.length - uploaded - p.failed, skipped, bytes: p.bytes, stopped: true, error: firstError || undefined };
    p.current = item.filename; emit();
    try {
      const f = await media.file(item);
      if (!f) throw new Error('dosya okunamadı');
      const meta = { key, name: item.filename || 'dosya', size: f.size, mtime: Math.floor((item.created || item.modified || 0) / 1000) };
      if (f.size <= WHOLE_MAX) {
        await client.putWhole(meta, f.uri);
      } else {
        const s = await client.state(key);
        if (!s.done) {
          for (const [off, len] of chunkPlan(f.size, s.received)) {
            if (stop()) throw new StopSignal();
            await client.putChunk(meta, f.uri, off, len);
          }
        }
      }
      uploaded++; p.done = uploaded; p.bytes += f.size;
    } catch (e) {
      if (e instanceof StopSignal) return { uploaded, failed: p.failed, pending: todo.length - uploaded - p.failed, skipped, bytes: p.bytes, stopped: true };
      // Pi tarafı sorunları (disk dolu / bağlı değil, anahtar geçersiz) turu bitirir; tek dosya sorunu atlanır
      if (e instanceof PiError && (e.status === 401 || e.status === 503 || e.status === 507 || e.status === 0)) throw e;
      p.failed++;
      if (!firstError) firstError = `${item.filename}: ${e instanceof Error ? e.message : String(e)}`;
    }
    emit();
  }
  p.phase = 'done'; p.current = undefined; emit();
  return { uploaded, failed: p.failed, pending: 0, skipped, bytes: p.bytes, stopped: false, error: firstError || undefined };
}

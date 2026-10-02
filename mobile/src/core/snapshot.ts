// Yedekleme (anlık görüntü): seçili kaynakları (fotoğraf, video, … — S2b'de klasör, kişi, takvim) tarar, Pi'de olmayanları
// şifreleyip yükler, sonra o anki durumun manifestini (şifreli) yazıp anlık görüntüyü kaydeder. Telefonda hiçbir şey
// silinmez ya da değişmez. Yarıda kalırsa anlık görüntü yazılmaz; yüklenen nesneler bir sonraki turda yeniden kullanılır.
// Telefondaki durum önceki yedekle aynıysa (unchanged) yeni anlık görüntü yazılmaz.
import type { Api, SnapshotStats } from './api.ts';
import { PiError } from './client.ts';
import { chunkAad, chunkAt, chunkCount, objectId, plainSizeOf, resumeChunk, sealBytes, sealedSize, toHex, utf8, type Cipher } from './crypto.ts';

export type ItemKind = 'photo' | 'video' | 'audio' | 'file' | 'contacts' | 'calendar';
export interface SourceItem {
  kind: ItemKind;
  src: string;              // kaynaktaki kalıcı kimlik (varlık kimliği, klasör yolu …)
  name: string;
  created: number | null;   // ms
  modified: number | null;  // ms
  album?: string;
  path?: string;            // klasör yedeğinde "<klasör>/<alt klasör>/<ad>"
  count?: number;           // tek öğedeki kayıt sayısı (kişiler, takvim etkinlikleri)
}
export interface Reader { size: number; read(offset: number, length: number): Promise<Uint8Array>; close?(): void }
export interface Source {
  pages(): AsyncGenerator<SourceItem[]>;
  open(item: SourceItem): Promise<Reader | null>;
}
export interface ManifestItem extends SourceItem { id: string; size: number }
export interface Manifest { v: 1; device: string; platform: string; at: number; items: ManifestItem[] }

export interface SnapshotProgress { phase: 'scan' | 'upload' | 'save' | 'done'; scanned: number; pending: number; done: number; failed: number; bytes: number; current?: string }
export interface SnapshotResult {
  snapshotId: number | null; items: number; uploaded: number; failed: number; bytes: number; stopped: boolean;
  unchanged?: boolean;  // önceki yedekle aynı: yeni anlık görüntü yazılmadı
  empty?: boolean;      // yedeklenecek öğe yok
  hash?: string;        // bu durumun özeti (bir sonraki turda karşılaştırılır)
  error?: string;
}
// Kaynak tanımı → nesne kimliği: HMAC her turda yeniden hesaplanmaz (büyük kitaplıkta tarama yavaşlamasın)
export interface IdCache { get(source: string): string | undefined; set(source: string, id: string): void }
export interface SnapshotOptions {
  device: string; platform: string;
  deadline?: number; shouldStop?: () => boolean; onProgress?: (p: SnapshotProgress) => void;
  ids?: IdCache;
  unchanged?: (hash: string) => Promise<boolean>;
}

class StopSignal extends Error {}
const sourceKey = (it: SourceItem) => `${it.kind}:${it.src}:${it.modified ?? it.created ?? 0}`;

// Bir okuyucudaki veriyi şifreli nesne olarak yükler (Pi'nin aldığı yerden sürer)
export async function uploadObject(api: Api, c: Cipher, id: string, r: Reader, received: number, stop: () => boolean): Promise<void> {
  const n = chunkCount(r.size);
  const total = sealedSize(r.size);
  for (let i = resumeChunk(received); i < n; i++) {
    if (stop()) throw new StopSignal();
    const ch = chunkAt(i, r.size);
    const plain = await r.read(ch.plainOffset, ch.plainLength);
    if (plain.length !== ch.plainLength) throw new Error('dosya okunurken boyutu değişti');
    await api.putChunk(id, total, ch.sealedOffset, await c.seal(plain, chunkAad(id, i, n)));
  }
}
// Bellekteki bayt dizisini (manifest) şifreli nesne olarak yükler
export async function uploadBytes(api: Api, c: Cipher, id: string, plain: Uint8Array): Promise<void> {
  const sealed = await sealBytes(c, id, plain);
  const n = chunkCount(plain.length);
  for (let i = 0; i < n; i++) {
    const ch = chunkAt(i, plain.length);
    await api.putChunk(id, sealed.length, ch.sealedOffset, sealed.subarray(ch.sealedOffset, ch.sealedOffset + ch.sealedLength));
  }
}

export async function runSnapshot(api: Api, c: Cipher, sources: Source[], o: SnapshotOptions): Promise<SnapshotResult> {
  const stop = () => (o.shouldStop?.() ?? false) || (o.deadline !== undefined && Date.now() > o.deadline);
  const p: SnapshotProgress = { phase: 'scan', scanned: 0, pending: 0, done: 0, failed: 0, bytes: 0 };
  const emit = () => o.onProgress?.({ ...p });

  // 1) Tara: kaynaklardaki her öğe → nesne kimliği
  const items: { item: SourceItem; source: Source; id: string }[] = [];
  for (const source of sources) {
    for await (const page of source.pages()) {
      if (stop()) return { snapshotId: null, items: items.length, uploaded: 0, failed: 0, bytes: 0, stopped: true };
      for (const item of page) {
        const k = sourceKey(item);
        let id = o.ids?.get(k);
        if (!id) {
          id = await objectId(c, k);
          o.ids?.set(k, id);
        }
        items.push({ item, source, id });
        // İlk taramada kimlik hesaplanırken de sayaç ilerlesin (sayfa 500 öğe)
        if (items.length % 100 === 0) { p.scanned = items.length; emit(); }
      }
      p.scanned = items.length; emit();
    }
  }

  // 2) Pi'de olmayanlar
  const { have, partial } = await api.objects(items.map(x => x.id));
  const sizes = new Map<string, number>();
  for (const [id, sealed] of have) sizes.set(id, plainSizeOf(sealed));
  const todo = items.filter(x => !have.has(x.id));
  p.phase = 'upload'; p.pending = todo.length; emit();

  // 3) Yükle (tek dosya sorunu atlanır; Pi / ağ sorunu turu bitirir)
  let firstError = '';
  for (const x of todo) {
    if (stop()) return { snapshotId: null, items: items.length, uploaded: p.done, failed: p.failed, bytes: p.bytes, stopped: true };
    p.current = x.item.name; emit();
    let r: Reader | null = null;
    try {
      r = await x.source.open(x.item);
      if (!r) throw new Error('dosya okunamadı');
      await uploadObject(api, c, x.id, r, partial.get(x.id) ?? 0, stop);
      sizes.set(x.id, r.size);
      p.done++; p.bytes += r.size;
    } catch (e) {
      if (e instanceof StopSignal) return { snapshotId: null, items: items.length, uploaded: p.done, failed: p.failed, bytes: p.bytes, stopped: true };
      if (e instanceof PiError && (e.status === 0 || e.status === 401 || e.status === 403 || e.status === 503 || e.status === 507)) throw e;
      p.failed++;
      if (!firstError) firstError = `${x.item.name}: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      r?.close?.();
    }
    emit();
  }

  // 4) Anlık görüntü: yalnız Pi'de tam olan öğeler (o anki durum); öncekiyle aynıysa yazılmaz
  p.phase = 'save'; p.current = undefined; emit();
  const stored = items.filter(x => sizes.has(x.id));
  const base = { items: stored.length, uploaded: p.done, failed: p.failed, bytes: p.bytes, stopped: false, error: firstError || undefined };
  if (!stored.length) return { ...base, snapshotId: null, empty: true };
  const lines = stored.map(x => `${x.id}:${sizes.get(x.id)}:${x.item.album ?? ''}:${x.item.path ?? ''}`).sort();
  const hash = toHex(await c.hmac(utf8(lines.join('|'))));
  if (await o.unchanged?.(hash)) {
    p.phase = 'done'; emit();
    return { ...base, snapshotId: null, unchanged: true, hash };
  }
  const at = Date.now();
  const manifest: Manifest = { v: 1, device: o.device, platform: o.platform, at, items: stored.map(x => ({ ...x.item, id: x.id, size: sizes.get(x.id)! })) };
  const mid = await objectId(c, `manifest:${o.device}:${at}:${Math.random()}`);
  await uploadBytes(api, c, mid, utf8(JSON.stringify(manifest)));
  const stats: SnapshotStats = { photos: 0, videos: 0, audio: 0, files: 0, contacts: 0, events: 0, items: stored.length, bytes: 0 };
  for (const x of manifest.items) {
    stats.bytes += x.size;
    if (x.kind === 'photo') stats.photos++; else if (x.kind === 'video') stats.videos++; else if (x.kind === 'audio') stats.audio++;
    else if (x.kind === 'file') stats.files++;
    else if (x.kind === 'contacts') stats.contacts += x.count ?? 1; else if (x.kind === 'calendar') stats.events += x.count ?? 1;
  }
  const { id } = await api.createSnapshot({ manifest: mid, objects: [...new Set(stored.map(x => x.id)), mid], stats });
  p.phase = 'done'; emit();
  return { ...base, snapshotId: id, hash };
}

// Geri yükleme: anlık görüntünün manifestini (şifreli) indirip açar; seçilen öğeleri parça parça indirir, çözer ve
// platformun yazıcısına verir (galeride "Klyrix/Gate Sync" albümü, klasör …). Varsayılan: telefonda zaten olanlar atlanır.
import type { Api, Snapshot } from './api.ts';
import { PiError } from './client.ts';
import { chunkAad, chunkAt, chunkCount, fromUtf8, openBytes, type Cipher } from './crypto.ts';
import type { Manifest, ManifestItem } from './snapshot.ts';

export async function loadManifest(api: Api, c: Cipher, s: Snapshot): Promise<Manifest> {
  const st = await api.objectState(s.manifest);
  if (!st.done) throw new PiError(404, 'Bu yedeğin içerik listesi Pi\'de eksik');
  const sealed = await api.getRange(s.manifest, 0, st.size);
  let m: Manifest;
  try {
    m = JSON.parse(fromUtf8(await openBytes(c, s.manifest, sealed))) as Manifest;
  } catch {
    throw new Error('Yedek açılamadı — bu cihazdaki anahtar bu yedeğin anahtarı değil');
  }
  if (m?.v !== 1 || !Array.isArray(m.items)) throw new Error('Yedeğin içerik listesi tanınmadı');
  return m;
}

export interface Writer { write(bytes: Uint8Array): Promise<void>; finish(): Promise<void>; abort(): Promise<void> }
export interface Sink {
  exists(item: ManifestItem): Promise<boolean>;  // telefonda zaten var mı (aynı cihaz, silinmemiş)
  begin(item: ManifestItem): Promise<Writer>;
}
export interface RestoreProgress { total: number; done: number; skipped: number; failed: number; current?: string }
export interface RestoreResult { restored: number; skipped: number; failed: number; stopped: boolean; error?: string }

export async function restoreItems(api: Api, c: Cipher, items: ManifestItem[], sink: Sink, o: {
  onlyMissing?: boolean; shouldStop?: () => boolean; onProgress?: (p: RestoreProgress) => void;
} = {}): Promise<RestoreResult> {
  const p: RestoreProgress = { total: items.length, done: 0, skipped: 0, failed: 0 };
  let firstError = '';
  for (const it of items) {
    if (o.shouldStop?.()) return { restored: p.done, skipped: p.skipped, failed: p.failed, stopped: true, error: firstError || undefined };
    p.current = it.name; o.onProgress?.({ ...p });
    if (o.onlyMissing !== false && await sink.exists(it).catch(() => false)) { p.skipped++; continue; }
    let w: Writer | null = null;
    try {
      w = await sink.begin(it);
      const n = chunkCount(it.size);
      for (let i = 0; i < n; i++) {
        const ch = chunkAt(i, it.size);
        const sealed = await api.getRange(it.id, ch.sealedOffset, ch.sealedLength);
        await w.write(await c.open(sealed, chunkAad(it.id, i, n)));
      }
      await w.finish();
      p.done++;
    } catch (e) {
      await w?.abort().catch(() => {});
      if (e instanceof PiError && (e.status === 0 || e.status === 401 || e.status === 403)) throw e;
      p.failed++;
      if (!firstError) firstError = `${it.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
    o.onProgress?.({ ...p });
  }
  p.current = undefined; o.onProgress?.({ ...p });
  return { restored: p.done, skipped: p.skipped, failed: p.failed, stopped: false, error: firstError || undefined };
}

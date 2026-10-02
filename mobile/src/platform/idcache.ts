// Kaynak tanımı → nesne kimliği önbelleği (kişi başına bir JSON dosyası, uygulama belgelerinde). Yalnız hız içindir:
// kimlik HMAC'i her turda on binlerce kez yeniden hesaplanmasın. Silinirse kimlikler yeniden hesaplanır (aynı sonuç).
// Tarama tamamlanınca kitaplıkta artık olmayan öğelerin satırları atılır.
import { File, Paths } from 'expo-file-system';
import type { IdCache } from '../core/snapshot.ts';

export interface SavedIdCache extends IdCache { save(scanComplete: boolean): void }
const file = (profileId: string) => new File(Paths.document, `klyrix-ids-${profileId}.json`);

export function loadIdCache(profileId: string): SavedIdCache {
  const f = file(profileId);
  let map = new Map<string, string>();
  try {
    if (f.exists) map = new Map(Object.entries(JSON.parse(f.textSync()) as Record<string, string>));
  } catch {
    map = new Map();
  }
  const used = new Set<string>();
  let dirty = false;
  return {
    get(k) { used.add(k); return map.get(k); },
    set(k, id) { used.add(k); map.set(k, id); dirty = true; },
    save(scanComplete) {
      if (scanComplete && used.size < map.size) {
        for (const k of [...map.keys()]) if (!used.has(k)) map.delete(k);
        dirty = true;
      }
      if (!dirty) return;
      try { f.write(JSON.stringify(Object.fromEntries(map))); } catch { /* yalnız hız içindir */ }
    },
  };
}
export function dropIdCache(profileId: string): void {
  try { file(profileId).delete(); } catch { /* yok */ }
}

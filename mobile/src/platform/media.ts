// Telefonun fotoğraf / video kitaplığı (expo-media-library yeni sorgu API'si). Yedekleme yalnız okur: hiçbir şey silinmez
// ya da değişmez. Geri yükleme yalnız ekler: çözülen dosya "Klyrix Gate Sync" albümüne yeni öğe olarak yazılır.
import { File, Paths } from 'expo-file-system';
import { Album, Asset, AssetField, MediaType, Query, getPermissionsAsync, requestPermissionsAsync, presentPermissionsPicker } from 'expo-media-library';
import type { AssetMetadata } from 'expo-media-library';
import type { Sink } from '../core/restore.ts';
import type { ManifestItem, Source, SourceItem } from '../core/snapshot.ts';

const PAGE = 500;
// Albüm adı klasör adı da olur (Android): eğik çizgi alt klasör açacağı için uygulama adındaki "/" yok
export const RESTORE_ALBUM = 'Klyrix Gate Sync';

async function* library(types: MediaType[]): AsyncGenerator<AssetMetadata[]> {
  for (let offset = 0; ; offset += PAGE) {
    const rows = await new Query()
      .within(AssetField.MEDIA_TYPE, types)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
      .offset(offset)
      .limit(PAGE)
      .exeForMetadata();
    if (!rows.length) return;
    yield rows;
    if (rows.length < PAGE) return;
  }
}

// Yedekleme kaynağı: eskiden yeniye sayfa sayfa; dosya parça parça okunur (iOS'ta gerekirse iCloud'dan iner)
export function mediaSource(o: { videos: boolean }): Source {
  return {
    async *pages() {
      for await (const rows of library(o.videos ? [MediaType.IMAGE, MediaType.VIDEO] : [MediaType.IMAGE])) {
        yield rows.map((r): SourceItem => ({
          kind: r.mediaType === MediaType.VIDEO ? 'video' : 'photo', src: r.id, name: r.filename || '',
          created: r.creationTime ?? null, modified: r.modificationTime ?? null,
        }));
      }
    },
    async open(item) {
      const f = new File(await new Asset(item.src).getUri());
      if (!f.exists) return null;
      const size = f.size;
      const h = f.open();
      return {
        size,
        read: async (offset, length) => {
          h.offset = offset;
          return h.readBytes(length);
        },
        close: () => { try { h.close(); } catch { /* kapalı */ } },
      };
    },
  };
}

// Dosya adı: yol parçası ve sistemlerin yasakladıkları atılır, uzantı kalır (galeri türü uzantıdan anlar)
function safeName(name: string, kind: string): string {
  const n = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').slice(-120);
  return n || (kind === 'video' ? 'video.mp4' : 'foto.jpg');
}

// Geri yükleme hedefi. sameDevice: yedek bu telefonunsa, kitaplıkta hâlâ duran öğe "zaten var" sayılır (yinelenmez).
export function gallerySink(o: { sameDevice: boolean }): Sink {
  let present: Set<string> | null = null;
  let album: Album | null | undefined;
  let n = 0;
  return {
    async exists(item: ManifestItem) {
      if (!o.sameDevice) return false;
      if (!present) {
        const s = new Set<string>();
        for await (const rows of library([MediaType.IMAGE, MediaType.VIDEO])) for (const r of rows) s.add(r.id);
        present = s;
      }
      return present.has(item.src);
    },
    async begin(item: ManifestItem) {
      const f = new File(Paths.cache, 'klyrix-restore', `${Date.now()}-${n++}-${safeName(item.name, item.kind)}`);
      f.create({ intermediates: true, overwrite: true });
      const h = f.open();
      let pos = 0;
      const cleanup = () => { try { f.delete(); } catch { /* önbellek: sistem de temizler */ } };
      return {
        async write(bytes) {
          h.offset = pos;
          h.writeBytes(bytes);
          pos += bytes.length;
        },
        async finish() {
          h.close();
          try {
            if (album === undefined) album = await Album.get(RESTORE_ALBUM);
            if (album) await Asset.create(f.uri, album);
            else album = await Album.create(RESTORE_ALBUM, [f.uri]);
          } finally {
            cleanup();
          }
        },
        async abort() {
          try { h.close(); } catch { /* kapalı */ }
          cleanup();
        },
      };
    },
  };
}

export type Access = 'all' | 'limited' | 'none';
export async function mediaAccess(ask: boolean): Promise<Access> {
  const p = ask ? await requestPermissionsAsync(false) : await getPermissionsAsync(false);
  if (!p.granted) return 'none';
  return p.accessPrivileges === 'limited' ? 'limited' : 'all';
}
// iOS / Android 14+: "seçili fotoğraflar" izninde seçimi genişletme
export const widenAccess = () => presentPermissionsPicker().catch(() => {});

// Telefonun fotoğraf / video kitaplığı (expo-media-library yeni sorgu API'si). Yedekleme yalnız okur: hiçbir şey silinmez
// ya da değişmez. Geri yükleme yalnız ekler: çözülen dosya "Klyrix Gate Sync" albümüne yeni öğe olarak yazılır.
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { Album, Asset, AssetField, MediaType, Query, getPermissionsAsync, requestPermissionsAsync, presentPermissionsPicker } from 'expo-media-library';
import type { AssetMetadata } from 'expo-media-library';
import type { Sink } from '../core/restore.ts';
import type { ManifestItem, Source, SourceItem } from '../core/snapshot.ts';

const PAGE = 500;
// Albüm adı klasör adı da olur (Android): eğik çizgi alt klasör açacağı için uygulama adındaki "/" yok. Ses ayrı albümde:
// Android'de fotoğraf albümü Pictures/ altında, ses dosyası oraya yazılamaz (Music/).
export const RESTORE_ALBUM = 'Klyrix Gate Sync';
export const RESTORE_AUDIO_ALBUM = 'Klyrix Gate Sync Ses';

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

// Yedekleme kaynağı: eskiden yeniye sayfa sayfa; dosya parça parça okunur (iOS'ta gerekirse iCloud'dan iner).
// audio: ses kayıtları ve müzik (yalnız Android; iOS uygulamalara ses kitaplığını açmaz)
const kindOf = (t: MediaType) => (t === MediaType.VIDEO ? 'video' : t === MediaType.AUDIO ? 'audio' : 'photo');
export function mediaSource(o: { videos: boolean; audio: boolean }): Source {
  const types = [MediaType.IMAGE, ...(o.videos ? [MediaType.VIDEO] : []), ...(o.audio ? [MediaType.AUDIO] : [])];
  return {
    async *pages() {
      if (o.audio && !(await audioAccess(false))) throw new Error('Ses dosyalarına erişim izni yok — Ayarlar\'dan izin verin ya da sesi kapatın');
      for await (const rows of library(types)) {
        yield rows.map((r): SourceItem => ({
          kind: kindOf(r.mediaType), src: r.id, name: r.filename || '',
          created: r.creationTime ?? null, modified: r.modificationTime ?? null,
        }));
      }
    },
    async open(item) {
      const f = new File(await new Asset(item.src).getUri());
      if (!f.exists) return null;
      const size = f.size;
      // Salt okunur: varsayılan okuma-yazma kipi Android'de başka uygulamanın (kameranın) dosyası için yazma izni ister ve
      // reddedilir (kapsamlı depolama); iOS'ta da fotoğraf kitaplığı dosyası güncellemeye açılamaz
      const h = f.open(FileMode.ReadOnly);
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
// audio: ses öğeleri için (ayrı albüm)
export function gallerySink(o: { sameDevice: boolean; audio?: boolean }): Sink {
  const title = o.audio ? RESTORE_AUDIO_ALBUM : RESTORE_ALBUM;
  let present: Set<string> | null = null;
  let album: Album | null | undefined;
  let n = 0;
  return {
    async exists(item: ManifestItem) {
      if (!o.sameDevice) return false;
      if (!present) {
        const s = new Set<string>();
        for await (const rows of library(o.audio ? [MediaType.AUDIO] : [MediaType.IMAGE, MediaType.VIDEO])) for (const r of rows) s.add(r.id);
        present = s;
      }
      return present.has(item.src);
    },
    async begin(item: ManifestItem) {
      // Öğe başına geçici klasör: galeri dosyanın adını yoldaki son parçadan alır (özgün ad kalsın, önek eklenmesin)
      const dir = new Directory(Paths.cache, 'klyrix-restore', `${Date.now()}-${n++}`);
      const f = new File(dir, safeName(item.name, item.kind));
      f.create({ intermediates: true, overwrite: true });
      const h = f.open();
      let pos = 0;
      const cleanup = () => { try { dir.delete(); } catch { /* önbellek: sistem de temizler */ } };
      return {
        async write(bytes) {
          h.offset = pos;
          h.writeBytes(bytes);
          pos += bytes.length;
        },
        async finish() {
          h.close();
          try {
            if (album === undefined) album = await Album.get(title);
            if (album) await Asset.create(f.uri, album);
            else album = await Album.create(title, [f.uri]);
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
// İzin türleri açıkça: verilmezse Android 13+ yapılandırmadaki hepsini (ses dahil) sorar / denetler — ses izni olmayan
// telefonda fotoğraf izni de "yok" görünürdü
export async function mediaAccess(ask: boolean): Promise<Access> {
  const p = ask ? await requestPermissionsAsync(false, ['photo', 'video']) : await getPermissionsAsync(false, ['photo', 'video']);
  if (!p.granted) return 'none';
  return p.accessPrivileges === 'limited' ? 'limited' : 'all';
}
// Ses kayıtları ve müzik (yalnız Android)
export async function audioAccess(ask: boolean): Promise<boolean> {
  const p = ask ? await requestPermissionsAsync(false, ['audio']) : await getPermissionsAsync(false, ['audio']);
  return p.granted;
}
// iOS / Android 14+: "seçili fotoğraflar" izninde seçimi genişletme
export const widenAccess = () => presentPermissionsPicker().catch(() => {});

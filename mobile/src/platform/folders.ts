// Klasör yedeği: Android'de kullanıcının seçtiği klasörler (SAF, kalıcı izin), iOS'ta uygulamanın Dosyalar'daki kendi klasörü
// (Dosyalar → Bu iPhone'da → Klyrix/Gate Sync; iOS uygulamalara kalıcı klasör izni vermez). Yalnız okunur: hiçbir dosya
// silinmez ya da değişmez. Geri yükleme kullanıcının seçtiği hedef klasöre, yedekteki alt klasörleriyle yeni dosya yazar.
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { Sink } from '../core/restore.ts';
import type { ManifestItem, Source, SourceItem } from '../core/snapshot.ts';

export interface FolderPick { uri: string; name: string }
// iOS: uygulamanın belge klasörü (Dosyalar uygulamasında görünür: app.json UIFileSharingEnabled)
export const APP_FOLDER: FolderPick = { uri: 'app:documents', name: 'Klyrix Gate Sync' };
const MAX_DEPTH = 16;
const PAGE = 500;

// SAF adresinin son parçası kodlanmış belge kimliğidir ("primary%3ABelgeler%2Fa.pdf"): çözülüp son ad alınır
export function nameOf(uri: string): string {
  const base = uri.replace(/\/+$/, '').split('/').pop() || '';
  let s = base;
  try { s = decodeURIComponent(base); } catch { /* olduğu gibi */ }
  return s.split(/[/:]/).pop() || s || 'dosya';
}
const rootOf = (f: FolderPick) => (f.uri === APP_FOLDER.uri ? new Directory(Paths.document) : new Directory(f.uri));

export async function pickFolder(): Promise<FolderPick | null> {
  try {
    const d = await Directory.pickDirectoryAsync();
    return { uri: d.uri, name: nameOf(d.uri) };
  } catch {
    return null; // vazgeçildi
  }
}
export function folderReachable(f: FolderPick): boolean {
  try { return rootOf(f).exists; } catch { return false; }
}

function* walk(dir: Directory, rel: string, depth: number): Generator<{ file: File; rel: string }> {
  for (const e of dir.list()) {
    const name = nameOf(e.uri);
    if (name.startsWith('.')) continue; // gizli dosya / klasör
    const path = rel ? `${rel}/${name}` : name;
    if (e instanceof File) yield { file: e, rel: path };
    else if (depth < MAX_DEPTH) yield* walk(e, path, depth + 1);
  }
}

// Erişilemeyen klasör (izin düştü, silindi, SD kart çıkarıldı) turu durdurur: yedek o klasör eksik yazılmasın
export function folderSource(folders: FolderPick[]): Source {
  return {
    async *pages() {
      for (const f of folders) {
        const root = rootOf(f);
        if (!folderReachable(f)) throw new Error(`«${f.name}» klasörüne erişilemiyor — Ayarlar'dan yeniden seçin ya da kaldırın`);
        let page: SourceItem[] = [];
        for (const { file, rel } of walk(root, '', 0)) {
          page.push({ kind: 'file', src: file.uri, name: nameOf(file.uri), path: `${f.name}/${rel}`, created: null, modified: file.modificationTime ?? null });
          if (page.length >= PAGE) { yield page; page = []; }
        }
        if (page.length) yield page;
      }
    },
    async open(item) {
      const f = new File(item.src);
      if (!f.exists) return null;
      const size = f.size;
      const h = f.open(FileMode.ReadOnly);
      return {
        size,
        read: async (offset, length) => {
          if (h.offset !== offset) h.offset = offset;
          return h.readBytes(length);
        },
        close: () => { try { h.close(); } catch { /* kapalı */ } },
      };
    },
  };
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', zip: 'application/zip', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
const clean = (s: string) => s.replace(/[\\:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').slice(0, 120) || 'dosya';

// Geri yükleme hedefi: seçilen klasörün altına "<yedekteki klasör>/<alt klasörler>/<ad>". Aynı adda dosya varsa sistem yeni ad verir.
export function folderSink(dest: Directory): Sink {
  const dirs = new Map<string, Directory>([['', dest]]);
  const dirFor = (parts: string[]): Directory => {
    let key = '';
    let d = dest;
    for (const raw of parts) {
      const name = clean(raw);
      key = key ? `${key}/${name}` : name;
      const known = dirs.get(key);
      if (known) { d = known; continue; }
      const found = d.list().find(e => e instanceof Directory && nameOf(e.uri) === name) as Directory | undefined;
      d = found ?? d.createDirectory(name);
      dirs.set(key, d);
    }
    return d;
  };
  return {
    exists: async () => false,
    async begin(item: ManifestItem) {
      const parts = (item.path || item.name).split('/').filter(Boolean);
      const name = clean(parts.pop() || item.name);
      const f = dirFor(parts).createFile(name, mimeOf(name));
      const h = f.open(FileMode.WriteOnly);
      return {
        async write(bytes) { h.writeBytes(bytes); },
        async finish() { h.close(); },
        async abort() {
          try { h.close(); } catch { /* kapalı */ }
          try { f.delete(); } catch { /* yarım dosya kalırsa kullanıcı görür */ }
        },
      };
    },
  };
}
export async function pickRestoreFolder(): Promise<Directory | null> {
  try { return await Directory.pickDirectoryAsync(); } catch { return null; }
}

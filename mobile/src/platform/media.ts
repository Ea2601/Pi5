// Telefonun fotoğraf / video kitaplığı (expo-media-library yeni sorgu API'si). Yalnız okunur: hiçbir şey silinmez.
import { File } from 'expo-file-system';
import { Asset, AssetField, MediaType, Query, getPermissionsAsync, requestPermissionsAsync, presentPermissionsPicker } from 'expo-media-library';
import type { Media } from '../core/engine.ts';

export const media: Media = {
  async page(offset, limit) {
    const rows = await new Query()
      .within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO])
      .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
      .offset(offset)
      .limit(limit)
      .exeForMetadata();
    return rows.map(r => ({
      id: r.id, filename: r.filename || '', created: r.creationTime, modified: r.modificationTime, video: r.mediaType === MediaType.VIDEO,
    }));
  },
  async file(item) {
    const uri = await new Asset(item.id).getUri();
    const f = new File(uri);
    if (!f.exists || !f.size) return null;
    return { uri, size: f.size };
  },
};

export type Access = 'all' | 'limited' | 'none';
export async function mediaAccess(ask: boolean): Promise<Access> {
  const p = ask ? await requestPermissionsAsync(false) : await getPermissionsAsync(false);
  if (!p.granted) return 'none';
  return p.accessPrivileges === 'limited' ? 'limited' : 'all';
}
// iOS / Android 14+: "seçili fotoğraflar" izninde seçimi genişletme
export const widenAccess = () => presentPermissionsPicker().catch(() => {});

// expo-media-library önizleme sahtesi: izin verilmiş, kitaplık boş. ?photos=N → N sahte fotoğraf, sayfa başına 400 ms
// (yavaş tarama: sekme değiştirip dönünce ilerlemenin sürdüğünü görmek için; dosyaları okunamaz, yüklenemez sayılır)
import { previewQuery } from './state.ts';

export const AssetField = { CREATION_TIME: 'creationTime', MODIFICATION_TIME: 'modificationTime', MEDIA_TYPE: 'mediaType' } as const;
export const MediaType = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', UNKNOWN: 'unknown' } as const;
const FAKE = Number(previewQuery.get('photos') || 0);
export class Query {
  private off = 0;
  private lim = 500;
  within() { return this; }
  eq() { return this; }
  orderBy() { return this; }
  offset(n: number) { this.off = n; return this; }
  limit(n: number) { this.lim = n; return this; }
  async exe() { return []; }
  async exeForMetadata() {
    if (!FAKE) return [];
    await new Promise(r => setTimeout(r, 400));
    const n = Math.max(0, Math.min(this.lim, FAKE - this.off));
    return Array.from({ length: n }, (_, i) => ({
      id: `onizleme-${this.off + i}`, filename: `IMG_${this.off + i}.JPG`, mediaType: MediaType.IMAGE,
      creationTime: Date.UTC(2026, 0, 1) + (this.off + i) * 60_000, modificationTime: null,
    }));
  }
}
export class Asset {
  id: string;
  constructor(id: string) { this.id = id; }
  async getUri() { return ''; }
  static async create() { return new Asset('onizleme'); }
}
export class Album {
  id: string;
  constructor(id: string) { this.id = id; }
  static async get() { return null; }
  static async create() { return new Album('onizleme'); }
}
const granted = { granted: true, status: 'granted', accessPrivileges: 'all', canAskAgain: true, expires: 'never' };
export async function getPermissionsAsync() { return granted; }
export async function requestPermissionsAsync() { return granted; }
export async function presentPermissionsPicker() {}

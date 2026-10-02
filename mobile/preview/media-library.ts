// expo-media-library önizleme sahtesi: izin verilmiş, kitaplık boş
export const AssetField = { CREATION_TIME: 'creationTime', MODIFICATION_TIME: 'modificationTime', MEDIA_TYPE: 'mediaType' } as const;
export const MediaType = { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', UNKNOWN: 'unknown' } as const;
export class Query {
  within() { return this; }
  eq() { return this; }
  orderBy() { return this; }
  offset() { return this; }
  limit() { return this; }
  async exe() { return []; }
  async exeForMetadata() { return []; }
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

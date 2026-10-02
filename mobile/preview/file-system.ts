// expo-file-system önizleme sahtesi (önizlemede dosya yüklenmez)
export class File {
  uri: string;
  constructor(...parts: unknown[]) { this.uri = parts.map(String).join('/'); }
  get exists() { return false; }
  get size() { return 0; }
}
export class Directory {
  uri: string;
  constructor(...parts: unknown[]) { this.uri = parts.map(String).join('/'); }
  delete() {}
}
export const Paths = { cache: 'cache', document: 'document' };
export const FileMode = { ReadWrite: 'rw', ReadOnly: 'r', WriteOnly: 'w', Append: 'wa', Truncate: 'wt' } as const;

// Klyrix Gate mobil yedekleme protokolü (Pi tarafı: backend/src/mobile.ts). Saf TypeScript: React Native'de ve Node
// testlerinde (node --test, tür ayıklama) aynı kod çalışır — enum / sınıf parametre özelliği yok, yalnız silinebilir tür.

export const PAYLOAD_TYPE = 'klyrix-backup';
export const DEFAULT_PORT = 8095;
// Pi'nin kabul ettiği dosya anahtarı (mobile.ts KEY_RE ile aynı)
export const KEY_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
export const CHECK_BATCH = 200;
// Bu boyuta kadar dosya tek istekte (iOS'ta arka planda da süren yükleme); büyükleri 8 MB parçalarla, kaldığı yerden
export const WHOLE_MAX = 64 * 1024 * 1024;
export const CHUNK = 8 * 1024 * 1024;

export interface PairPayload { hosts: string[]; port: number; code: string; name: string }
export interface Pairing { hosts: string[]; port: number; token: string; piName: string; deviceName: string; host: string }

// Pi adresi: IPv4 ya da ad (yedek.lan); başka bir şey QR'dan gelmesin (ör. URL / yol)
const HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;
export const validHost = (h: unknown): h is string => typeof h === 'string' && h.length <= 253 && HOST_RE.test(h);
export const normCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Paneldeki QR: {"t":"klyrix-backup","v":1,"h":[...],"p":8095,"c":"ABCD-EFGH","n":"pi5"}
export function parsePayload(text: string): PairPayload | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.t !== PAYLOAD_TYPE || j.v !== 1) return null;
  const hosts = Array.isArray(j.h) ? j.h.filter(validHost).slice(0, 8) : [];
  const port = Number.isInteger(j.p) && j.p > 0 && j.p < 65536 ? j.p : DEFAULT_PORT;
  const code = typeof j.c === 'string' ? normCode(j.c) : '';
  if (!hosts.length || code.length !== 8) return null;
  return { hosts, port, code, name: typeof j.n === 'string' ? j.n.slice(0, 64) : '' };
}
// Elle giriş: "192.168.0.153" + "ABCD-EFGH" (port isteğe bağlı: "192.168.0.153:8095")
export function manualPayload(address: string, code: string): PairPayload | null {
  const m = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(address);
  if (!m || !validHost(m[1])) return null;
  const c = normCode(code);
  if (c.length !== 8) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  if (port < 1 || port > 65535) return null;
  return { hosts: [m[1]], port, code: c, name: '' };
}

// Dosya anahtarı: cihazdaki varlık kimliği + değişme zamanı (düzenlenen fotoğraf yeni sürüm olarak yeniden yedeklenir).
// Anahtar biçimine uymayan karakterler '-' olur; çok uzunsa sonu korunur (kimliklerin ayırt edici kısmı sondadır).
export function assetKey(id: string, modified: number | null, created: number | null): string {
  const t = Math.floor((modified || created || 0) / 1000);
  let k = `${id.replace(/[^A-Za-z0-9._:/-]/g, '-').replace(/\.\.+/g, '-')}:${t}`;
  if (k.length > 200) k = k.slice(k.length - 200);
  return k;
}

// Parça planı: [başlangıç, uzunluk] — offset'ten sona
export function chunkPlan(size: number, offset: number, chunk = CHUNK): [number, number][] {
  const out: [number, number][] = [];
  for (let o = Math.max(0, offset); o < size; o += chunk) out.push([o, Math.min(chunk, size - o)]);
  return out;
}

export function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0';
}

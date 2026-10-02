// Uçtan uca şifreleme (saf TypeScript; AES ve SHA bağdaştırıcıdan): uygulamada expo-crypto (yerel AES-GCM), testte node:crypto.
// Pi yalnız şifreli nesne saklar; anahtar yalnız profilin cihazlarında (ve kullanıcının kurtarma anahtarında).
//  - Nesne biçimi: düz veri 4 MiB parçalara bölünür; her parça [12 bayt nonce][şifreli][16 bayt etiket] olarak art arda
//    yazılır. Ek doğrulama verisi (AAD) = `${nesne}:${sıra}:${toplam}` → parçalar yer değiştiremez, eksiltilemez.
//  - Nesne kimliği = HMAC-SHA256(anahtar, kaynak tanımı): aynı kaynak yeniden yüklenmez; Pi kimlikten bir şey öğrenemez.
//  - Kurtarma anahtarı: 32 bayt + 10 bit denetim → 54 karakter Crockford base32, 6'lık gruplar (yazım hatası yakalanır).

export const PLAIN_CHUNK = 4 * 1024 * 1024;
export const OVERHEAD = 28; // 12 nonce + 16 etiket
const SEALED_CHUNK = PLAIN_CHUNK + OVERHEAD;

export interface Cipher {
  seal(plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array>; // nonce + şifreli + etiket
  open(sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>; // etiket tutmazsa hata
  hmac(data: Uint8Array): Promise<Uint8Array>; // HMAC-SHA256(profil anahtarı, veri)
}

export const chunkCount = (plain: number): number => Math.max(1, Math.ceil(plain / PLAIN_CHUNK));
export const sealedSize = (plain: number): number => plain + OVERHEAD * chunkCount(plain);
// i. parçanın şifreli nesnedeki yeri ve düz verideki yeri
export function chunkAt(i: number, plain: number): { sealedOffset: number; sealedLength: number; plainOffset: number; plainLength: number } {
  const plainOffset = i * PLAIN_CHUNK;
  const plainLength = Math.max(0, Math.min(PLAIN_CHUNK, plain - plainOffset));
  return { sealedOffset: i * SEALED_CHUNK, sealedLength: plainLength + OVERHEAD, plainOffset, plainLength };
}
// Pi'nin bildirdiği alınmış bayt → kaldığı parça (yarım parça baştan gönderilir)
export const resumeChunk = (received: number): number => Math.floor(received / SEALED_CHUNK);
export const chunkAad = (id: string, i: number, n: number): Uint8Array => utf8(`${id}:${i}:${n}`);

// ── metin / ikili yardımcılar (React Native'de Buffer yok) ─────────────────────
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
export const toHex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}
export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ── kurtarma anahtarı ───────────────────────────────────────────────────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function checksum10(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = (c * 31 + b[i] + i) % 1021; // 1021 asal < 1024
  return c;
}
export function encodeRecoveryKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('anahtar 32 bayt olmalı');
  let bits = '';
  for (const x of key) bits += x.toString(2).padStart(8, '0');
  bits += '0000' + checksum10(key).toString(2).padStart(10, '0'); // 256 + 4 dolgu + 10 denetim = 270 bit = 54 karakter
  let s = '';
  for (let i = 0; i < bits.length; i += 5) s += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return s.match(/.{1,6}/g)!.join('-');
}
// Kullanıcının yazdığı anahtar: küçük harf, boşluk / tire, I→1, L→1, O→0 kabul. Geçersiz ya da denetim tutmazsa null.
export function parseRecoveryKey(input: string): Uint8Array | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== 54) return null;
  let bits = '';
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (bits.slice(256, 260) !== '0000' || parseInt(bits.slice(260, 270), 2) !== checksum10(key)) return null;
  return key;
}

// ── anahtar doğrulama (Pi'de saklanır; doğru anahtar açabilir, Pi açamaz) ────────
const KEY_CHECK = 'klyrix-gate-sync-key-v1';
export async function makeKeyCheck(c: Cipher): Promise<string> {
  return toBase64(await c.seal(utf8(KEY_CHECK), utf8('keycheck')));
}
export async function verifyKeyCheck(c: Cipher, b64: string): Promise<boolean> {
  try {
    return fromUtf8(await c.open(fromBase64(b64), utf8('keycheck'))) === KEY_CHECK;
  } catch {
    return false;
  }
}

// Şifreli boyuttan düz boyut (Pi yalnız şifreli boyutu bilir)
export const plainSizeOf = (sealed: number): number => sealed - OVERHEAD * Math.max(1, Math.ceil(sealed / SEALED_CHUNK));

// HMAC-SHA256 (RFC 2104) — SHA-256 bağdaştırıcıdan (uygulamada expo-crypto digest)
export async function hmacSha256(key: Uint8Array, data: Uint8Array, sha256: (b: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const block = 64;
  let k = key.length > block ? await sha256(key) : key;
  const pad = new Uint8Array(block);
  pad.set(k);
  k = pad;
  const inner = new Uint8Array(block + data.length);
  const outer = new Uint8Array(block + 32);
  for (let i = 0; i < block; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
  inner.set(data, block);
  outer.set(await sha256(inner), block);
  return sha256(outer);
}

export async function objectId(c: Cipher, source: string): Promise<string> {
  return toHex(await c.hmac(utf8(source)));
}

// Küçük veri (manifest, kişiler, takvim) → tek parça ya da çok parçalı şifreli nesne (bellekte)
export async function sealBytes(c: Cipher, id: string, plain: Uint8Array): Promise<Uint8Array> {
  const n = chunkCount(plain.length);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const r = chunkAt(i, plain.length);
    parts.push(await c.seal(plain.subarray(r.plainOffset, r.plainOffset + r.plainLength), chunkAad(id, i, n)));
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export async function openBytes(c: Cipher, id: string, sealed: Uint8Array): Promise<Uint8Array> {
  const plain = sealed.length - OVERHEAD * Math.ceil(sealed.length / SEALED_CHUNK);
  const n = chunkCount(plain);
  const out = new Uint8Array(plain);
  for (let i = 0; i < n; i++) {
    const r = chunkAt(i, plain);
    out.set(await c.open(sealed.subarray(r.sealedOffset, r.sealedOffset + r.sealedLength), chunkAad(id, i, n)), r.plainOffset);
  }
  return out;
}

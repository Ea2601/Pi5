// Klyrix Gate eşleştirme kodu (Pi tarafı: backend/src/mobile.ts startPairing) ve ortak biçimlendirme. Saf TypeScript:
// React Native'de ve Node testlerinde (node --test, tür ayıklama) aynı kod çalışır — enum / sınıf parametre özelliği yok.

export const PAYLOAD_TYPE = 'klyrix-backup';
export const DEFAULT_PORT = 8095;

export interface PairPayload { hosts: string[]; port: number; code: string; name: string }

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
// Elle giriş: "192.168.0.153" + "ABCD-EFGH". Panelin adresi gibi yazılan da kabul edilir ("http://192.168.0.153/",
// "192.168.0.153:80"): şema ve yol atılır, panel portu (80 / 443 / 3000) mobil yedekleme portuna çevrilir; başka port
// açıkça yazıldıysa o kullanılır. Geçersizse neyin yanlış olduğunu söyleyen metin döner.
export function manualPayload(address: string, code: string): PairPayload | string {
  const a = address.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  const m = /^([^\s:]+)(?::(\d{1,5}))?$/.exec(a);
  if (!m || !validHost(m[1])) return 'Pi\'nin adresi geçersiz — ör. 192.168.1.153 (panelde «Telefon ekle» penceresinin altında yazar)';
  const c = normCode(code);
  if (c.length !== 8) return 'Kod 8 karakter olmalı — ör. ABCD-EFGH (panelde «Telefon ekle» penceresinde yazar)';
  let port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  if (port === 80 || port === 443 || port === 3000) port = DEFAULT_PORT;
  if (port < 1 || port > 65535) return 'Port geçersiz';
  return { hosts: [m[1]], port, code: c, name: '' };
}

export function fmtBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0';
}

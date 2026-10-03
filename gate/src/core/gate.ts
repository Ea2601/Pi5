// Pi'nin Klyrix/Gate uygulama uçları (backend/src/gateApp.ts) — saf TypeScript (Node testleriyle aynı kod):
//  - Kimlik yanıtı GET /api/app/pair ve eşleşme POST /api/app/pair: ev ağında, panelin kendi adresinden (nginx :80),
//    oturumsuz; sahipliği panel kodu ya da panel şifresi kanıtlar.
//  - QR: panelin «Telefon ekle» penceresi {t:'klyrix-gate-app', v:1, h:[adresler], p:80, c:kod, n:ad, i:kimlik, k:sunucu anahtarı}.
//    Eşleşme yanıtındaki sunucu anahtarı QR'daki k ile aynı olmalı: ev ağındaki sahte bir yanıt telefonu başka bir cihaza
//    eşleyemez.

export interface Hello { app: string; v: number; id: string; name: string; role: 'main' | 'satellite'; code: boolean; password: boolean; tunnel: boolean }
export interface QrPayload { hosts: string[]; port: number; code: string; name: string; id: string; serverKey: string }
export interface Tunnel { address: string; serverPublicKey: string; port: number; gate: string; lan: string[]; remote: string }
export interface PairResult { device: { id: number; name: string }; pi: { id: string; name: string }; tunnel: Tunnel }
export interface PairBody {
  name: string; platform: 'android' | 'ios'; publicKey: string; code?: string; password?: string; enableTunnel?: boolean;
}

export class GateError extends Error {
  status: number;
  needTunnel: boolean; // Pi'de Ev VPN'i kapalı: kullanıcıya sorulup enableTunnel ile yeniden denenir
  retryAfter: number;  // şifre deneme sınırı (sn)
  constructor(status: number, message: string, needTunnel = false, retryAfter = 0) {
    super(message);
    this.status = status;
    this.needTunnel = needTunnel;
    this.retryAfter = retryAfter;
  }
}

// Ağ bağdaştırıcısı (uygulamada fetch + zaman aşımı, testte sahte)
export type Fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number }) => Promise<{ status: number; text: string }>;

export const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const TUNNEL_ADDR = /^10\.77\.77\.(\d{1,3})$/;

export const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const validHost = (h: unknown): h is string => typeof h === 'string' && HOST.test(h);
const hostPort = (host: string, port: number) => (port === 80 ? host : `${host}:${port}`);

export function parseQr(text: string): QrPayload | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.t !== 'klyrix-gate-app' || j.v !== 1) return null;
  const hosts = Array.isArray(j.h) ? j.h.filter(validHost) : [];
  const code = typeof j.c === 'string' ? normCode(j.c) : '';
  if (!hosts.length || code.length !== 8 || typeof j.k !== 'string' || !WG_KEY.test(j.k)) return null;
  const port = Number(j.p) || 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hosts, port, code, name: String(j.n || '').slice(0, 64), id: String(j.i || '').slice(0, 64), serverKey: j.k };
}

export async function hello(f: Fetch, host: string, port = 80): Promise<Hello> {
  const r = await f(`http://${hostPort(host, port)}/api/app/pair`, { method: 'GET', timeoutMs: 4000 });
  let j: any = null;
  try { j = JSON.parse(r.text); } catch { /* aşağıda */ }
  if (r.status !== 200 || !j || j.app !== 'klyrix-gate') throw new GateError(r.status, 'Bu adreste Klyrix Gate bulunamadı (panel güncel mi?)');
  return {
    app: j.app, v: Number(j.v) || 0, id: String(j.id || ''), name: String(j.name || ''), role: j.role === 'satellite' ? 'satellite' : 'main',
    code: j.code === true, password: j.password === true, tunnel: j.tunnel === true,
  };
}

// Eşleşme yanıtını sıkı doğrular: tünel adresi Pi'nin uygulama ağında, anahtarlar biçimli, uç adresler geçerli
export function checkPairResult(j: any): PairResult {
  const t = j?.tunnel;
  const m = typeof t?.address === 'string' ? TUNNEL_ADDR.exec(t.address) : null;
  if (!m || Number(m[1]) < 2 || Number(m[1]) > 254) throw new GateError(0, 'Pi geçersiz bir tünel adresi verdi');
  if (!WG_KEY.test(String(t.serverPublicKey))) throw new GateError(0, "Pi'nin anahtarı geçersiz");
  const port = Number(t.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GateError(0, 'Pi geçersiz bir port verdi');
  const lan = (Array.isArray(t.lan) ? t.lan : []).filter((x: unknown) => typeof x === 'string' && IPV4.test(x));
  const remote = validHost(t.remote) ? t.remote : '';
  if (!lan.length && !remote) throw new GateError(0, "Pi'ye ulaşılacak adres yok");
  const id = Number(j?.device?.id);
  if (!Number.isInteger(id) || id <= 0) throw new GateError(0, 'Pi geçersiz bir yanıt verdi');
  return {
    device: { id, name: String(j.device.name || '') },
    pi: { id: String(j?.pi?.id || ''), name: String(j?.pi?.name || '') },
    tunnel: { address: t.address, serverPublicKey: t.serverPublicKey, port, gate: String(t.gate || ''), lan, remote },
  };
}

export async function pair(f: Fetch, host: string, port: number, body: PairBody): Promise<PairResult> {
  // Ev VPN'i eşleşmeyle açılıyorsa Pi'de birkaç saniye sürer
  const r = await f(`http://${hostPort(host, port)}/api/app/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 45000,
  });
  let j: any = {};
  try { j = JSON.parse(r.text); } catch { /* düz metin */ }
  if (r.status !== 200) {
    throw new GateError(r.status, typeof j.error === 'string' ? j.error : `Eşleşme başarısız (HTTP ${r.status})`, j.needTunnel === true, Number(j.retry_after) || 0);
  }
  return checkPairResult(j);
}

// Bağlantı için denenecek uç adresler: ev ağındayken önce Pi'nin ev ağı adresleri, sonra dış adres (DDNS / dış IP)
export function endpoints(t: { lan: string[]; remote: string; port: number }, onLan: boolean): { endpoint: string; via: 'lan' | 'remote' }[] {
  const out: { endpoint: string; via: 'lan' | 'remote' }[] = [];
  if (onLan) for (const h of t.lan) out.push({ endpoint: `${h}:${t.port}`, via: 'lan' });
  if (t.remote) out.push({ endpoint: `${t.remote}:${t.port}`, via: 'remote' });
  return out;
}

// Yerel modül hatası: Expo "… → Caused by: <ileti>" biçiminde sarar; kullanıcıya yalnız ileti
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const i = m.lastIndexOf('Caused by:');
  return (i >= 0 ? m.slice(i + 10) : m).trim().replace(/^java\.lang\.Exception:\s*/, '');
}

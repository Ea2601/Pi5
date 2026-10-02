// Pi istemcisi: adres bulma (/v1/hello), eşleştirme, durum, denetim, yükleme. Ağ işleri bağdaştırıcıdan (Http) gelir:
// uygulamada fetch + expo-file-system, testte Node fetch + fs.
import { type PairPayload, type Pairing, CHECK_BATCH } from './protocol.ts';

export interface HttpResponse { status: number; text: string }
export interface Http {
  request(url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number }): Promise<HttpResponse>;
  // Bütün dosya tek istekte (gövde = dosya); uygulamada iOS arka plan oturumu
  uploadFile(url: string, fileUri: string, headers: Record<string, string>, onProgress?: (sent: number) => void): Promise<HttpResponse>;
  // Dosyanın bir aralığı (parça) tek istekte; gövde boyu (Content-Length) belli olmalı — Pi parçalı kodlamayı reddeder
  uploadRange(url: string, fileUri: string, offset: number, length: number, headers: Record<string, string>): Promise<HttpResponse>;
}
export interface PiStatus { ok: boolean; device: { name: string; files: number; bytes: number }; target: { name: string; mounted: boolean; free: number | null; size: number | null } | null }
export class PiError extends Error {
  status: number;
  received?: number;
  constructor(status: number, message: string, received?: number) {
    super(message);
    this.status = status;
    this.received = received;
  }
}

const parse = (r: HttpResponse): any => { try { return JSON.parse(r.text || '{}'); } catch { return {}; } };
function check(r: HttpResponse): any {
  const j = parse(r);
  if (r.status < 200 || r.status >= 300) throw new PiError(r.status, typeof j.error === 'string' && j.error ? j.error : `Pi yanıtı ${r.status}`, typeof j.received === 'number' ? j.received : undefined);
  return j;
}

// Neden ulaşılamadı: zaman aşımı (adres yanlış ağda / güvenlik duvarı) ya da bağlantı kurulamadı (yanlış adres, kapalı)
const failReason = (e: unknown): string =>
  (/abort/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e)) ? 'zaman aşımı' : 'bağlanılamadı');

// Sırayla dener (ev ağı adresleri, sabit ad, Ev VPN'i); ilk yanıt veren Klyrix Gate kullanılır. Hiçbiri olmazsa her adresin
// nedeni hata metninde (hangi adres, neden) — telefonda neyin yanlış olduğu görünsün.
export async function findHost(http: Http, hosts: string[], port: number, prefer = ''): Promise<string> {
  const order = prefer && hosts.includes(prefer) ? [prefer, ...hosts.filter(h => h !== prefer)] : hosts;
  const why: string[] = [];
  for (const h of order) {
    try {
      const r = await http.request(`http://${h}:${port}/v1/hello`, { method: 'GET', timeoutMs: 2500 });
      if (r.status === 200 && parse(r).app === 'klyrix-gate') return h;
      why.push(`${h}: ${r.status === 200 ? 'Klyrix Gate değil' : `yanıt ${r.status}`}`);
    } catch (e) {
      why.push(`${h}: ${failReason(e)}`);
    }
  }
  throw new PiError(0, `Pi'ye ulaşılamadı (${why.join(' · ')}). Telefon ev Wi-Fi'ında mı (ya da Ev VPN'i açık mı), panelde mobil yedekleme açık mı?`);
}

export async function pair(http: Http, p: PairPayload, deviceName: string, platform: string): Promise<Pairing> {
  const host = await findHost(http, p.hosts, p.port);
  const r = await http.request(`http://${host}:${p.port}/v1/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: p.code, name: deviceName, platform }), timeoutMs: 10000,
  });
  const j = check(r);
  if (typeof j.token !== 'string' || !j.token) throw new PiError(500, 'Pi anahtar vermedi');
  return { hosts: p.hosts, port: p.port, token: j.token, piName: p.name, deviceName: j.device?.name || deviceName, host };
}

export interface Client {
  host: string;
  status(): Promise<PiStatus>;
  have(keys: string[]): Promise<Set<string>>;
  state(key: string): Promise<{ received: number; done: boolean }>;
  putWhole(q: UploadMeta, fileUri: string, onProgress?: (sent: number) => void): Promise<{ done: boolean; received: number; duplicate?: boolean }>;
  putChunk(q: UploadMeta, fileUri: string, offset: number, length: number): Promise<{ done: boolean; received: number }>;
}
export interface UploadMeta { key: string; name: string; size: number; mtime: number }

// Ağ hatası (bağlantı koptu, zaman aşımı) tek dosyanın değil turun sorunudur: PiError(0) — yükleme turu durur
const net = <T>(f: () => Promise<T>): Promise<T> => f().catch(e => {
  if (e instanceof PiError) throw e;
  throw new PiError(0, `Pi ile bağlantı koptu: ${e instanceof Error ? e.message : String(e)}`);
});

export async function connect(http0: Http, pr: Pairing): Promise<Client> {
  const host = await findHost(http0, pr.hosts, pr.port, pr.host);
  const http: Http = {
    request: (u, i) => net(() => http0.request(u, i)),
    uploadFile: (u, f, h, cb) => net(() => http0.uploadFile(u, f, h, cb)),
    uploadRange: (u, f, o, l, h) => net(() => http0.uploadRange(u, f, o, l, h)),
  };
  const base = `http://${host}:${pr.port}`;
  const auth = { Authorization: `Bearer ${pr.token}` };
  const qs = (q: UploadMeta, offset: number) =>
    `key=${encodeURIComponent(q.key)}&name=${encodeURIComponent(q.name)}&size=${q.size}&offset=${offset}&mtime=${q.mtime}`;
  return {
    host,
    status: async () => check(await http.request(`${base}/v1/status`, { method: 'GET', headers: auth, timeoutMs: 10000 })) as PiStatus,
    have: async keys => {
      const out = new Set<string>();
      for (let i = 0; i < keys.length; i += CHECK_BATCH) {
        const j = check(await http.request(`${base}/v1/check`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: keys.slice(i, i + CHECK_BATCH) }), timeoutMs: 15000,
        }));
        for (const k of j.have || []) out.add(k);
      }
      return out;
    },
    state: async key => check(await http.request(`${base}/v1/upload?key=${encodeURIComponent(key)}`, { method: 'GET', headers: auth, timeoutMs: 10000 })),
    putWhole: async (q, fileUri, onProgress) => check(await http.uploadFile(`${base}/v1/upload?${qs(q, 0)}`, fileUri, { ...auth, 'Content-Type': 'application/octet-stream' }, onProgress)),
    putChunk: async (q, fileUri, offset, length) =>
      check(await http.uploadRange(`${base}/v1/upload?${qs(q, offset)}`, fileUri, offset, length, { ...auth, 'Content-Type': 'application/octet-stream' })),
  };
}

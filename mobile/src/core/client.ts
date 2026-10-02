// Pi istemcisinin ortak parçaları: adres bulma (/v1/hello — Pi'nin v1 ve v2 uçları aynı dinleyicide), yanıt denetimi, ağ
// hatası sarmalayıcı. Ağ işleri bağdaştırıcıdan (Http) gelir: uygulamada fetch + expo/fetch, testte Node fetch.
// Uç çağrıları api.ts'te (v2: kişi, şifreli nesneler, yedekler).

export interface HttpResponse { status: number; text: string }
export interface Http {
  request(url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number }): Promise<HttpResponse>;
  // Bellekteki bayt dizisi tek istekte (şifreli parça); Content-Length belli — Pi parçalı kodlamayı reddeder
  uploadBytes(url: string, bytes: Uint8Array, headers: Record<string, string>): Promise<HttpResponse>;
  // İkili yanıt (geri yüklemede şifreli parça indirme; Range başlığıyla)
  requestBytes(url: string, init: { headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; bytes: Uint8Array }>;
}
export class PiError extends Error {
  status: number;
  received?: number;
  constructor(status: number, message: string, received?: number) {
    super(message);
    this.status = status;
    this.received = received;
  }
}

export const parse = (r: HttpResponse): any => { try { return JSON.parse(r.text || '{}'); } catch { return {}; } };
export function check(r: HttpResponse): any {
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

// Ağ hatası (bağlantı koptu, zaman aşımı) tek dosyanın değil turun sorunudur: PiError(0) — tur durur
export const net = <T>(f: () => Promise<T>): Promise<T> => f().catch(e => {
  if (e instanceof PiError) throw e;
  throw new PiError(0, `Pi ile bağlantı koptu: ${e instanceof Error ? e.message : String(e)}`);
});

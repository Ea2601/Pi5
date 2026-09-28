import fs from 'fs';

// IP aralığı yönlendirmesi: DNS'e dayanmayan trafik için (ör. WhatsApp aramaları Meta'nın aktarma sunucularına DNS
// sorgusu olmadan, sohbet bağlantısının bildirdiği IP'lerle gider — canlı ölçüm: UDP 3478 → 57.144.37.54, 157.240.227.62,
// 157.240.203.62, 31.13.86.48; hepsi AS32934). Uygulama kuralının alan adı listesinde iki biçim kabul edilir:
//   @asn:<numara>[!443]   bir özerk sistemin (AS) ilan ettiği IPv4 aralıkları; "!443" = 443 (tcp/udp) HARİÇ (yalnız
//                         arama/diğer trafik — aynı sunuculardaki web trafiği, ör. Facebook/Instagram, yerel kalır)
//   a.b.c.d[/nn]          sabit IPv4 adresi ya da aralığı (tüm portlar)
// AS aralıkları RIPEstat'tan (açık veri) günde bir çekilir ve önbelleğe yazılır; Pi internetsizse son kopya, o da yoksa
// (yalnız AS32934 için) koddaki anlık görüntü kullanılır.

export const ASN_TOKEN = /^@asn:(\d{1,10})(!443)?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// "a.b.c.d" / "a.b.c.d/nn" → normalize edilmiş "ağ/önek" (host bitleri sıfırlanır); geçersizse null. /8'den geniş aralık
// kabul edilmez (yanlış bir girdi tüm interneti tünele almasın).
export function normalizeCidr(s: string): string | null {
  const [ip, p, extra] = String(s || '').trim().split('/');
  if (extra !== undefined || !IPV4.test(ip)) return null;
  const prefix = p === undefined ? 32 : /^\d{1,2}$/.test(p) ? Number(p) : -1;
  if (prefix < 8 || prefix > 32) return null;
  const num = ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  const size = 2 ** (32 - prefix);
  const net = Math.floor(num / size) * size;
  return [24, 16, 8, 0].map(sh => Math.floor(net / 2 ** sh) % 256).join('.') + `/${prefix}`;
}

// AS32934 (Meta: WhatsApp, Facebook, Instagram, Messenger) — RIPEstat announced-prefixes, 2026-09-27 16:00 UTC anlık
// görüntüsü (239 ilan → 34 blok). Yalnız RIPE'ye hiç ulaşılamadığında ve önbellek yokken kullanılır.
const SEED: Record<number, string[]> = {
  32934: [
    '31.13.24.0/21', '31.13.64.0/18', '45.64.40.0/22', '57.141.0.0/24', '57.141.2.0/23', '57.141.4.0/23', '57.141.6.0/24',
    '57.141.8.0/24', '57.141.10.0/24', '57.141.12.0/23', '57.141.14.0/24', '57.141.16.0/22', '57.141.20.0/24',
    '57.141.22.0/24', '57.141.24.0/24', '57.144.0.0/14', '66.220.144.0/20', '69.63.176.0/20', '69.171.224.0/19',
    '74.119.76.0/22', '102.132.96.0/20', '103.4.96.0/22', '129.134.0.0/17', '157.240.0.0/17', '157.240.192.0/18',
    '163.70.128.0/17', '163.77.132.0/23', '163.77.136.0/23', '163.77.160.0/20', '173.252.64.0/18', '179.60.192.0/22',
    '185.60.216.0/22', '185.89.216.0/22', '204.15.20.0/22',
  ],
};

const CACHE_DIR = '/opt/pi5-gateway/core/asn';
const MAX_AGE_MS = 24 * 3600 * 1000;
const RETRY_AFTER_MS = 3600 * 1000; // başarısız çekimden sonra 1 sa yeniden deneme yok (her kural uygulamasını bekletmesin)
const lastFailure = new Map<number, number>();

export interface AsnPrefixes { asn: number; prefixes: string[]; source: 'ripe' | 'cache' | 'seed' | 'none'; fetchedAt: number }

const cacheFile = (asn: number) => `${CACHE_DIR}/AS${asn}.json`;
function readCache(asn: number): { fetched_at: number; prefixes: string[] } | null {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(asn), 'utf8'));
    const prefixes = Array.isArray(j?.prefixes) ? j.prefixes.map(normalizeCidr).filter(Boolean) as string[] : [];
    return prefixes.length ? { fetched_at: Number(j.fetched_at) || 0, prefixes } : null;
  } catch { return null; }
}

// RIPEstat'tan AS'nin ilan ettiği IPv4 aralıkları (tekilleştirilmiş, sıralı). Hata → null.
async function fetchRipe(asn: number): Promise<string[] | null> {
  try {
    const res = await fetch(`https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`,
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'klyrix-gate' } });
    if (!res.ok) return null;
    const j: any = await res.json();
    const list = Array.isArray(j?.data?.prefixes) ? j.data.prefixes : [];
    const v4 = new Set<string>();
    for (const p of list) {
      const s = String(p?.prefix || '');
      if (s.includes(':')) continue;
      const n = normalizeCidr(s);
      if (n) v4.add(n);
    }
    return v4.size ? [...v4].sort() : null;
  } catch { return null; }
}

// Güncel liste: önbellek tazeyse o; değilse RIPE'den çekilir (başarısızlıkta 1 sa bekleme), olmazsa bayat önbellek,
// o da yoksa anlık görüntü. force: tazelik denetimini atla (günlük yenileme).
export async function getAsnPrefixes(asn: number, opts: { force?: boolean } = {}): Promise<AsnPrefixes> {
  const cached = readCache(asn);
  const fresh = cached && Date.now() - cached.fetched_at < MAX_AGE_MS;
  if (cached && fresh && !opts.force) return { asn, prefixes: cached.prefixes, source: 'cache', fetchedAt: cached.fetched_at };
  const failedAt = lastFailure.get(asn) || 0;
  if (opts.force || Date.now() - failedAt > RETRY_AFTER_MS) {
    const fetched = await fetchRipe(asn);
    if (fetched) {
      lastFailure.delete(asn);
      const now = Date.now();
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = `${cacheFile(asn)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ asn, fetched_at: now, prefixes: fetched }) + '\n');
        fs.renameSync(tmp, cacheFile(asn));
      } catch (e: any) {
        console.error(`[routing] AS${asn} aralık önbelleği yazılamadı: ${e?.message || e}`);
      }
      return { asn, prefixes: fetched, source: 'ripe', fetchedAt: now };
    }
    lastFailure.set(asn, Date.now());
    console.warn(`[routing] AS${asn} aralıkları RIPE'den alınamadı — ${cached ? 'son kopya' : SEED[asn] ? 'yerleşik liste' : 'aralık yok'} kullanılıyor`);
  }
  if (cached) return { asn, prefixes: cached.prefixes, source: 'cache', fetchedAt: cached.fetched_at };
  if (SEED[asn]) return { asn, prefixes: [...SEED[asn]], source: 'seed', fetchedAt: 0 };
  return { asn, prefixes: [], source: 'none', fetchedAt: 0 };
}

// Günlük yenileme: önbellek 24 saatten eskiyse (ya da yoksa) RIPE'den çekilir. Yeni liste öncekinden farklıysa true
// (çağıran kuralları yeniden uygular; ilk uygulama anlık görüntüyle yapılmış olabilir).
export async function refreshAsnIfStale(asn: number): Promise<boolean> {
  const before = readCache(asn);
  if (before && Date.now() - before.fetched_at < MAX_AGE_MS) return false;
  const r = await getAsnPrefixes(asn);
  if (r.source !== 'ripe') return false;
  return !before || before.prefixes.join(',') !== r.prefixes.join(',');
}

// Bir alan adı listesi girdisi IP aralığı biçiminde mi? (ASN belirteci ya da IPv4/CIDR.)
export const isRangeEntry = (s: string) => ASN_TOKEN.test(s.trim()) || normalizeCidr(s) !== null;

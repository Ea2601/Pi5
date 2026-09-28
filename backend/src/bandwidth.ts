import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Cihaz başı bant genişliği. Pi evin ağ geçidi olduğu için cihazların internet trafiği Pi'nin forward yolundan geçer;
// yalnız SAYAÇ tutan ayrı bir nftables tablosu (inet pi5_acct) her yerel IP için indirilen (hedef) ve yüklenen (kaynak)
// baytı sayar. Tabloda karar yoktur (policy accept, drop/accept kuralı yok) → trafiği etkileyemez. NAT (masquerade)
// postrouting'de, geri çevirisi prerouting'de yapıldığı için forward kancası cihazın kendi IP'sini görür (gerçek çekirdek
// yönlendirmesi + NAT ile doğrulandı). Eskiden tüm arayüzlerin toplamı cihaz sayısına eşit bölünüyordu: her cihaz aynı
// değeri gösteriyordu. Aynı ağdaki iki cihaz arasındaki trafik Pi'den geçmez, sayılmaz. Yalnız IPv4.
// upm/downm aynı trafiği bağlantı işaretine (ct mark) göre de ayırır: PI5_ROUTING işareti CONNMARK ile bağlantıya yazar,
// forward kancası onu iki yönde de görür → cihaz başı yerel / DPI / VPS tüneli ayrımı (ağ topolojisi, topology.ts).

const execFileP = promisify(execFile);
const TABLE = 'pi5_acct';
const RULES_FILE = '/run/pi5-acct.nft';
// "fwd" nft'de ayrılmış sözcük — zincir adı olarak kullanılamaz.
const RULES = `table inet ${TABLE} {
\tset down4 { type ipv4_addr; size 4096; flags dynamic; counter; }
\tset up4 { type ipv4_addr; size 4096; flags dynamic; counter; }
\tset downm { type ipv4_addr . mark; size 8192; flags dynamic; counter; }
\tset upm { type ipv4_addr . mark; size 8192; flags dynamic; counter; }
\tchain acct_fwd {
\t\ttype filter hook forward priority -300; policy accept;
\t\tip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } update @up4 { ip saddr }
\t\tip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } update @down4 { ip daddr }
\t\tip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } update @upm { ip saddr . ct mark }
\t\tip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } update @downm { ip daddr . ct mark }
\t}
}
`;

export type IpCounters = Map<string, { down: number; up: number }>;

// `nft -j list table inet pi5_acct` → IP başına toplam bayt (down4 = indirilen, up4 = yüklenen).
export function parseAcctJson(json: string): IpCounters {
  const out: IpCounters = new Map();
  const items = (JSON.parse(json)?.nftables || []) as any[];
  for (const it of items) {
    const set = it?.set;
    if (!set || (set.name !== 'down4' && set.name !== 'up4')) continue;
    for (const e of set.elem || []) {
      const ip = e?.elem?.val;
      const bytes = Number(e?.elem?.counter?.bytes);
      if (typeof ip !== 'string' || !Number.isFinite(bytes)) continue;
      const cur = out.get(ip) || { down: 0, up: 0 };
      if (set.name === 'down4') cur.down = bytes; else cur.up = bytes;
      out.set(ip, cur);
    }
  }
  return out;
}

// Bağlantı işaretinin yönlendirme kısmı: Zapret kendi bitlerini (0x40000000, 0x20000000) üst bitlere yazar.
export const ROUTE_MARK_MASK = 0xffff;
export const markKey = (ip: string, mark: number) => `${ip}|${mark}`;

// upm/downm → "ip|işaret" başına toplam bayt. İşaret maskelenir; üst bitleri farklı iki öğe aynı anahtarda toplanır.
export function parseMarkJson(json: string): IpCounters {
  const out: IpCounters = new Map();
  const items = (JSON.parse(json)?.nftables || []) as any[];
  for (const it of items) {
    const set = it?.set;
    if (!set || (set.name !== 'downm' && set.name !== 'upm')) continue;
    for (const e of set.elem || []) {
      const [ip, rawMark] = Array.isArray(e?.elem?.val?.concat) ? e.elem.val.concat : [];
      const mark = typeof rawMark === 'string' ? Number(rawMark) : rawMark;
      const bytes = Number(e?.elem?.counter?.bytes);
      if (typeof ip !== 'string' || !Number.isInteger(mark) || !Number.isFinite(bytes)) continue;
      const key = markKey(ip, mark & ROUTE_MARK_MASK);
      const cur = out.get(key) || { down: 0, up: 0 };
      if (set.name === 'downm') cur.down += bytes; else cur.up += bytes;
      out.set(key, cur);
    }
  }
  return out;
}

// Tablo yoksa kurar (ör. açılışta ya da nftables yeniden yüklenip kurallar silindiyse). Güncel haliyse dokunmaz: sayaçlar
// sıfırlanmaz. İşaret setleri olmayan eski tablo (v2.24.10) tek işlemde silinip yeniden kurulur — sayaçlar bir kez sıfırlanır.
async function ensureTable(): Promise<void> {
  let current = '';
  try {
    current = (await execFileP('nft', ['list', 'table', 'inet', TABLE], { timeout: 5000 })).stdout;
    if (/\bset upm\b/.test(current) && /\bset downm\b/.test(current)) return;
  } catch { /* yok → kur */ }
  fs.writeFileSync(RULES_FILE, (current ? `delete table inet ${TABLE}\n` : '') + RULES);
  await execFileP('nft', ['-f', RULES_FILE], { timeout: 5000 });
}

type Rates = Map<string, { downBps: number; upBps: number }>;
type Sample = { t: number; counters: IpCounters; markCounters: IpCounters };
let last: Sample | null = null;
let lastRates: Rates = new Map();
let lastMarkRates: Rates = new Map();
let inflight: Promise<void> | null = null;

// Hızlar iki okuma arasındaki farktan hesaplanır. Sayfa açıkken 3 sn'de bir çağrılır; aynı anda bakan birden çok tarayıcı
// için 1 sn'den sık okunmaz. Uzun aradan sonra (>10 sn) gelen ilk okuma yalnız yeni başlangıç olur (ortalama "canlı" sanılmasın).
export function computeRates(prev: { t: number; counters: IpCounters } | null, cur: { t: number; counters: IpCounters }): Rates {
  const rates = new Map<string, { downBps: number; upBps: number }>();
  const dt = prev ? (cur.t - prev.t) / 1000 : 0;
  for (const [ip, c] of cur.counters) {
    const p = prev?.counters.get(ip);
    const ok = !!p && dt > 0 && dt <= 10;
    // Sayaç geriye gittiyse (tablo yeniden kuruldu) o aralık 0 sayılır.
    rates.set(ip, {
      downBps: ok && c.down >= p!.down ? (c.down - p!.down) / dt : 0,
      upBps: ok && c.up >= p!.up ? (c.up - p!.up) / dt : 0,
    });
  }
  return rates;
}

// markCounters/markRates: aynı okumanın "ip|işaret" (markKey) anahtarlı hali; hızlar aynı iki okumadan hesaplanır.
export async function sampleBandwidth(): Promise<{ counters: IpCounters; rates: Rates; markCounters: IpCounters; markRates: Rates }> {
  const now = Date.now();
  const result = () => ({ counters: last!.counters, rates: lastRates, markCounters: last!.markCounters, markRates: lastMarkRates });
  if (last && now - last.t < 1000) return result();
  if (!inflight) {
    inflight = (async () => {
      await ensureTable();
      const { stdout } = await execFileP('nft', ['-j', 'list', 'table', 'inet', TABLE], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      const cur: Sample = { t: Date.now(), counters: parseAcctJson(stdout), markCounters: parseMarkJson(stdout) };
      lastRates = computeRates(last, cur);
      lastMarkRates = computeRates(last && { t: last.t, counters: last.markCounters }, { t: cur.t, counters: cur.markCounters });
      last = cur;
    })().finally(() => { inflight = null; });
  }
  await inflight;
  return result();
}

// IP → MAC: çekirdeğin komşu (ARP) tablosu — Pi'den geçen her cihaz orada; cihaz listesindeki IP eskimiş olabilir.
export async function neighborMacs(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const { stdout } = await execFileP('ip', ['-j', '-4', 'neigh', 'show'], { timeout: 5000 });
    for (const n of JSON.parse(stdout) as any[]) {
      if (n?.dst && n?.lladdr) m.set(String(n.dst), String(n.lladdr).toLowerCase());
    }
  } catch { /* boş eşleme: cihaz listesindeki IP kullanılır */ }
  return m;
}

export type LiveEntry = {
  device_mac: string; hostname: string; bytes_in: number; bytes_out: number;
  speed_in_kbps: number; speed_out_kbps: number; timestamp: string;
};

// Cihaz listesi (MAC, ad, son bilinen IP) + sayaçlar → sayfanın satırları. Bir cihazın birden çok IP'si toplanır; listede
// olmayan ama trafiği görülen IP'ler MAC'iyle (yoksa IP'siyle) ayrı satır olur. Sıra: anlık hız, sonra toplam veri.
export function buildLive(
  devices: { mac_address: string; hostname: string | null; ip_address: string | null }[],
  counters: IpCounters,
  rates: Map<string, { downBps: number; upBps: number }>,
  macOf: Map<string, string>,
  timestamp = new Date().toISOString(),
): LiveEntry[] {
  const kbps = (bps: number) => Math.round(bps / 125); // bayt/sn → kbit/sn (sayfanın birimi)
  const byMac = new Map<string, LiveEntry>();
  const entry = (key: string, hostname: string) => {
    let e = byMac.get(key);
    if (!e) {
      e = { device_mac: key, hostname, bytes_in: 0, bytes_out: 0, speed_in_kbps: 0, speed_out_kbps: 0, timestamp };
      byMac.set(key, e);
    }
    return e;
  };
  const known = new Map<string, string>(); // mac → ad
  for (const d of devices) {
    const mac = String(d.mac_address || '').toLowerCase();
    if (!mac) continue;
    known.set(mac, d.hostname || '');
    entry(mac, d.hostname || '');
  }
  const ipOfDevice = new Map<string, string>(); // yedek: komşu tablosunda olmayan IP için cihaz listesindeki IP
  for (const d of devices) if (d.ip_address && d.mac_address) ipOfDevice.set(d.ip_address, String(d.mac_address).toLowerCase());
  for (const [ip, c] of counters) {
    const mac = macOf.get(ip) || ipOfDevice.get(ip) || '';
    const e = entry(mac || ip, mac && known.has(mac) ? known.get(mac)! : ip);
    const r = rates.get(ip) || { downBps: 0, upBps: 0 };
    e.bytes_in += c.down;
    e.bytes_out += c.up;
    e.speed_in_kbps += kbps(r.downBps);
    e.speed_out_kbps += kbps(r.upBps);
  }
  return [...byMac.values()].sort((a, b) =>
    (b.speed_in_kbps + b.speed_out_kbps) - (a.speed_in_kbps + a.speed_out_kbps)
    || (b.bytes_in + b.bytes_out) - (a.bytes_in + a.bytes_out));
}

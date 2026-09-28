import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Cihaz başı bant genişliği. Pi evin ağ geçidi olduğu için cihazların internet trafiği Pi'nin forward yolundan geçer;
// yalnız SAYAÇ tutan ayrı bir nftables tablosu (inet pi5_acct) her yerel IP için indirilen (hedef) ve yüklenen (kaynak)
// baytı sayar. Tabloda karar yoktur (policy accept, drop/accept kuralı yok) → trafiği etkileyemez. NAT (masquerade)
// postrouting'de, geri çevirisi prerouting'de yapıldığı için forward kancası cihazın kendi IP'sini görür (gerçek çekirdek
// yönlendirmesi + NAT ile doğrulandı). Eskiden tüm arayüzlerin toplamı cihaz sayısına eşit bölünüyordu: her cihaz aynı
// değeri gösteriyordu. Aynı ağdaki iki cihaz arasındaki trafik Pi'den geçmez, sayılmaz. Yalnız IPv4.

const execFileP = promisify(execFile);
const TABLE = 'pi5_acct';
const RULES_FILE = '/run/pi5-acct.nft';
// "fwd" nft'de ayrılmış sözcük — zincir adı olarak kullanılamaz.
const RULES = `table inet ${TABLE} {
\tset down4 { type ipv4_addr; size 4096; flags dynamic; counter; }
\tset up4 { type ipv4_addr; size 4096; flags dynamic; counter; }
\tchain acct_fwd {
\t\ttype filter hook forward priority -300; policy accept;
\t\tip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } update @up4 { ip saddr }
\t\tip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } update @down4 { ip daddr }
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

// Tablo yoksa kurar (ör. açılışta ya da nftables yeniden yüklenip kurallar silindiyse). VARSA dokunmaz: sayaçlar sıfırlanmaz.
async function ensureTable(): Promise<void> {
  try {
    await execFileP('nft', ['list', 'table', 'inet', TABLE], { timeout: 5000 });
    return;
  } catch { /* yok → kur */ }
  fs.writeFileSync(RULES_FILE, RULES);
  await execFileP('nft', ['-f', RULES_FILE], { timeout: 5000 });
}

type Sample = { t: number; counters: IpCounters };
let last: Sample | null = null;
let lastRates = new Map<string, { downBps: number; upBps: number }>();
let inflight: Promise<void> | null = null;

// Hızlar iki okuma arasındaki farktan hesaplanır. Sayfa açıkken 3 sn'de bir çağrılır; aynı anda bakan birden çok tarayıcı
// için 1 sn'den sık okunmaz. Uzun aradan sonra (>10 sn) gelen ilk okuma yalnız yeni başlangıç olur (ortalama "canlı" sanılmasın).
export function computeRates(prev: Sample | null, cur: Sample): Map<string, { downBps: number; upBps: number }> {
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

export async function sampleBandwidth(): Promise<{ counters: IpCounters; rates: Map<string, { downBps: number; upBps: number }> }> {
  const now = Date.now();
  if (last && now - last.t < 1000) return { counters: last.counters, rates: lastRates };
  if (!inflight) {
    inflight = (async () => {
      await ensureTable();
      const { stdout } = await execFileP('nft', ['-j', 'list', 'table', 'inet', TABLE], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const cur = { t: Date.now(), counters: parseAcctJson(stdout) };
      lastRates = computeRates(last, cur);
      last = cur;
    })().finally(() => { inflight = null; });
  }
  await inflight;
  return { counters: last!.counters, rates: lastRates };
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

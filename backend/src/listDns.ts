// Routing'de hazır listeli satırlar (Yetişkin içerik / Kumar ve bahis — categoryLists.ts) için Pi'deki küçük DNS iletici.
// Neden: dnsmasq'ın ipset= eşlemesi her yanıtta tüm satırları sırayla tarar — 83 bin satırla yukarı akışa giden HER sorgu
// ~5 kat pahalanır (ölçüm: FTL 6.7, 0,9 → 5,2 ms işlemci). server=/ad/ eşlemesi ise sıralı dizide ikili aramadır: liste
// adları Pi-hole'dan buraya (127.0.0.1:LIST_DNS_PORT) iletilir, burada yukarı akışa (Pi-hole'un kendi yukarı akışları)
// sorulur ve yanıttaki IPv4 adresleri kuralın setine (rt_m<işaret>) yanıt Pi-hole'a DÖNMEDEN eklenir — cihazın ilk
// bağlantısı da kuralın çıkışından gider. Diğer bütün sorgular bu yoldan geçmez.
//  - Yalnız VPS çıkışlı liste satırı için kullanılır; yalnız DPI seçilirse liste doğrudan Zapret'e gider (zapret.ts).
//  - Önbellek yok: her sorgu yukarı akışa gider (önbellekten dönen yanıt sete eklenmezdi). Pi-hole kendi önbelleğini tutar.
//  - Panel yeniden başlarken liste adları kısa süre çözülemez (Pi-hole bu adları yalnız buraya sorar) — kural açıkken
//    bilinçli olarak "kapalı kalır": trafik operatöre sızmaz.
import dgram from 'dgram';
import net from 'net';
import { spawn } from 'child_process';
import { LIST_IDS, listOf, type ListId } from './categoryLists';

export const LIST_DNS_PORT = 5390;
const HOST = '127.0.0.1';
const UPSTREAM_TIMEOUT_MS = 2500;
const IPSET_TIMEOUT_MS = 2000;

export type ListRoute = { id: ListId; exit_node: string; dpi_bypass: number; vps_fallback?: string };
export type Upstream = { host: string; port: number };

// ── Plan (saf): liste satırları → dnsmasq satırları ve setler ─────────────────────────────────────────────────────────
// mark: kuralın işareti (system.ts getFwmark); yalnız VPS işaretleri (vpsMark true) iletici yoluna girer. Dönen
// markers 05 dosyasına yorum olarak yazılır ("# klyrix-list:adult/rt_m32769"): çıkış değişince eski set "satırı çıkarılan
// set" sayılıp boşaltılır (system.ts). serverLines tekrarsız, sıralı.
export function planListRouting(routes: ListRoute[], markOf: (r: ListRoute) => { mark: number; vps: boolean },
  domainsOf: (id: ListId) => string[], valid: (d: string) => boolean = () => true):
  { sets: Map<ListId, string>; marks: Map<number, string>; markers: string[]; serverLines: string[]; skipped: ListId[] } {
  const sets = new Map<ListId, string>(), marks = new Map<number, string>(), markers: string[] = [], skipped: ListId[] = [];
  const names = new Set<string>();
  for (const r of routes) {
    if (sets.has(r.id)) continue;
    const { mark, vps } = markOf(r);
    if (!vps || mark === 0) continue;
    const doms = domainsOf(r.id);
    if (!doms.length) { skipped.push(r.id); continue; }
    const set = `rt_m${mark}`;
    sets.set(r.id, set);
    marks.set(mark, set);
    markers.push(`# klyrix-list:${r.id}/${set}`);
    for (const d of doms) if (valid(d)) names.add(d);
  }
  const serverLines = [...names].sort().map(d => `server=/${d}/${HOST}#${LIST_DNS_PORT}`);
  return { sets, marks, markers, serverLines, skipped };
}

// `pihole-FTL --config dns.upstreams` çıktısı ("[ 127.0.0.1#5335 ]", "[ 8.8.8.8, 1.1.1.1 ]") → yukarı akışlar.
export function parseUpstreams(text: string): Upstream[] {
  const out: Upstream[] = [];
  for (const m of String(text || '').matchAll(/([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-f]*:[0-9a-f:.]+)(?:#(\d{1,5}))?/gi)) {
    const host = m[1], port = Number(m[2] || 53);
    if (host === HOST && port === LIST_DNS_PORT) continue; // kendine döngü olmasın
    if (port > 0 && port < 65536) out.push({ host, port });
  }
  return out;
}

// ── DNS paketleri ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Ad okur (sıkıştırma işaretçileriyle); [ad, adın bittiği konum].
function readName(buf: Buffer, off: number): [string, number] {
  const labels: string[] = [];
  let pos = off, end = -1, jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('kısa paket');
    const len = buf[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length || ++jumps > 20) throw new Error('bozuk işaretçi');
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len === 0) { if (end < 0) end = pos + 1; break; }
    if (pos + 1 + len > buf.length) throw new Error('kısa etiket');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join('.').toLowerCase(), end];
}

export function queryName(buf: Buffer): string | null {
  try {
    if (buf.length < 12 || buf.readUInt16BE(4) < 1) return null;
    return readName(buf, 12)[0];
  } catch { return null; }
}

// Yanıttaki A kayıtları (CNAME zinciri dahil; ad denetimi yok — soru zaten listedeki addı).
export function answerIps(buf: Buffer): string[] {
  const ips: string[] = [];
  try {
    if (buf.length < 12) return ips;
    const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6);
    let pos = 12;
    for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;
    for (let i = 0; i < an; i++) {
      pos = readName(buf, pos)[1];
      if (pos + 10 > buf.length) break;
      const type = buf.readUInt16BE(pos), rdlen = buf.readUInt16BE(pos + 8);
      pos += 10;
      if (pos + rdlen > buf.length) break;
      if (type === 1 && rdlen === 4) ips.push(`${buf[pos]}.${buf[pos + 1]}.${buf[pos + 2]}.${buf[pos + 3]}`);
      pos += rdlen;
    }
  } catch { /* bozuk yanıt: eldekiler */ }
  return ips;
}

// Sorudan SERVFAIL yanıtı (yukarı akış yanıt vermedi).
export function servfail(query: Buffer): Buffer {
  let qEnd = 12;
  try { qEnd = query.readUInt16BE(4) >= 1 ? readName(query, 12)[1] + 4 : 12; } catch { qEnd = 12; }
  const out = Buffer.from(query.subarray(0, Math.min(qEnd, query.length)));
  if (out.length >= 12) {
    out[2] = (out[2] | 0x80) & ~0x04;     // QR=1, AA=0
    out[3] = (out[3] & 0xf0) | 0x80 | 2;  // RA=1, RCODE=SERVFAIL
    out.writeUInt16BE(qEnd > 12 ? 1 : 0, 4);
    out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  }
  return out;
}

// 0.0.0.0/8, 127/8 ve çok noktaya yayın/ayrılmış aralık sete yazılmaz (system.ts isRoutableV4 ile aynı).
const routable = (ip: string) => { const a = Number(ip.split('.')[0]); return a !== 0 && a !== 127 && a < 224; };

// ── İletici ───────────────────────────────────────────────────────────────────────────────────────────────────────────
let routes = new Map<ListId, string>();
let upstreams: Upstream[] = [];
let udp: dgram.Socket | null = null;
let tcp: net.Server | null = null;
const stats = { queries: 0, added: 0, failed: 0, since: Date.now(), lastError: '' as string, listening: false };

// İletici için bekçi: hangi listenin adresleri hangi sete (yoksa yalnız iletir) ve yukarı akışlar. Rota varsa dinlemeye
// başlar; rota kalmasa da dinlemeyi sürdürür (Pi-hole yeni dosyayla yeniden başlayana dek liste adlarını buraya sorar).
export function configureListDns(next: Map<ListId, string>, ups: Upstream[]): void {
  routes = new Map(next);
  if (ups.length) upstreams = ups;
  if (routes.size && !udp) start();
}

export function listSetForName(name: string): string | null {
  if (!routes.size) return null;
  const id = listOf(name, LIST_IDS.filter(i => routes.has(i)));
  return id ? routes.get(id) || null : null;
}

export function listDnsStats() {
  return { ...stats, routes: Object.fromEntries(routes), upstreams: upstreams.map(u => `${u.host}#${u.port}`) };
}

function start(): void {
  udp = dgram.createSocket('udp4');
  udp.on('error', e => { stats.lastError = `UDP ${LIST_DNS_PORT}: ${e.message}`; console.error(`[listdns] ${stats.lastError}`); });
  udp.on('message', (msg, rinfo) => {
    void handle(msg, 'udp').then(res => { if (res) udp?.send(res, rinfo.port, rinfo.address); });
  });
  udp.bind(LIST_DNS_PORT, HOST, () => { stats.listening = true; });
  tcp = net.createServer(sock => {
    let buf = Buffer.alloc(0);
    sock.setTimeout(10000, () => sock.destroy());
    sock.on('error', () => sock.destroy());
    sock.on('data', d => {
      buf = Buffer.concat([buf, d as Buffer]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
        buf = buf.subarray(2 + msg.length);
        void handle(Buffer.from(msg), 'tcp').then(res => {
          if (!res || sock.destroyed) return;
          const len = Buffer.alloc(2);
          len.writeUInt16BE(res.length);
          sock.write(Buffer.concat([len, res]));
        });
      }
    });
  });
  tcp.on('error', e => { stats.lastError = `TCP ${LIST_DNS_PORT}: ${e.message}`; console.error(`[listdns] ${stats.lastError}`); });
  tcp.listen(LIST_DNS_PORT, HOST);
}

export function stopListDns(): void {
  udp?.close(); tcp?.close();
  udp = null; tcp = null;
  stats.listening = false;
}

async function handle(query: Buffer, proto: 'udp' | 'tcp'): Promise<Buffer | null> {
  if (query.length < 12 || query[2] & 0x80) return null; // yanıt paketi / çöp
  stats.queries++;
  const name = queryName(query);
  let res: Buffer | null = null;
  for (const u of upstreams) {
    try { res = await (proto === 'tcp' ? askTcp(u, query) : askUdp(u, query)); break; } catch { /* sıradaki */ }
  }
  if (!res) { stats.failed++; return servfail(query); }
  const set = name ? listSetForName(name) : null;
  if (set) {
    const ips = [...new Set(answerIps(res).filter(routable))];
    if (ips.length) {
      try { await ipsetAdd(set, ips); stats.added += ips.length; } catch (e: any) { stats.lastError = `ipset ${set}: ${e?.message || e}`; }
    }
  }
  return res;
}

function askUdp(u: Upstream, query: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket(net.isIPv6(u.host) ? 'udp6' : 'udp4');
    const t = setTimeout(() => { s.close(); reject(new Error('zaman aşımı')); }, UPSTREAM_TIMEOUT_MS);
    s.on('error', e => { clearTimeout(t); s.close(); reject(e); });
    s.on('message', m => {
      if (m.length < 12 || m.readUInt16BE(0) !== query.readUInt16BE(0)) return;
      clearTimeout(t); s.close();
      // Kesilmiş (TC) yanıt olduğu gibi döner: Pi-hole aynı soruyu TCP ile yeniden sorar (TCP yolu da burada).
      resolve(m);
    });
    s.send(query, u.port, u.host);
  });
}

function askTcp(u: Upstream, query: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const s = net.connect(u.port, u.host);
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { s.destroy(); reject(new Error('zaman aşımı')); }, UPSTREAM_TIMEOUT_MS);
    s.on('error', e => { clearTimeout(t); reject(e); });
    s.on('connect', () => { const len = Buffer.alloc(2); len.writeUInt16BE(query.length); s.write(Buffer.concat([len, query])); });
    s.on('data', d => {
      buf = Buffer.concat([buf, d as Buffer]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        clearTimeout(t); s.destroy();
        resolve(buf.subarray(2, 2 + buf.readUInt16BE(0)));
      }
    });
  });
}

// Adresler tek `ipset restore` ile eklenir (-exist: zaten varsa hata değil). Set yoksa (kural kaldırıldı) hata yutulur.
function ipsetAdd(set: string, ips: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ipset', ['-exist', 'restore'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('zaman aşımı')); }, IPSET_TIMEOUT_MS);
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(err.trim() || `çıkış ${code}`)); });
    p.stdin.end(ips.map(ip => `add ${set} ${ip}\n`).join(''));
  });
}

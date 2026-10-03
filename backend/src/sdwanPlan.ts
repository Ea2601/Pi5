// Şubeler arası SD-WAN (site-to-site WireGuard, hub-and-spoke): saf kısım — davet / kabul / güncelleme metinleri, alt ağ
// doğrulaması ve çakışma denetimi, wg_s2s0 yapılandırması, nft tablosu ve rota planı. Bu modül sisteme, dosyaya ya da
// veritabanına dokunmaz (birim testleri derlenmiş dosyayla çalışır); yaşam döngüsü sdwan.ts'te.
//
// Kaynaklar (planın 0.5 tahsisi; başka hiçbir özellik kullanmaz):
//  - arayüz wg_s2s0 (önek wg_s2s: 'wg' öneki LAN tespitinden zaten dışlanır, 'wg_vps*' joker kurallarına girmez),
//    yalnız merkez (hub) Klyrix'te UDP 51821; VPS merkezinde VPS'in wg_s2s arayüzü / UDP 51821 (wg0'a dokunulmaz),
//  - overlay 10.88.0.0/24 (merkez .1; VPS merkezinde bu cihaz .2), yönlendirme tablosu 30001, ip rule önceliği 1050
//    (VPS işaret kuralları 1100 / 1101 / 1200'den önce), rota protokolü 178, tabloda 'unreachable … metric 1000',
//  - nft inet pi5_sdwan (input / forward, öncelik filter - 7), /etc/nftables.d/pi5-sdwan.conf.
// NAT yok: her şubede benzersiz alt ağ zorunlu (çakışan alt ağ reddedilir, yeniden numaralandırma önerilir, yapılmaz).
// Metinlerde yalnız açık anahtar bulunur; özel anahtar cihazdan hiç çıkmaz.

export const S2S_IFACE = 'wg_s2s0';
export const S2S_PORT = 51821;
export const S2S_TABLE = 30001;
export const S2S_PREF = 1050;
export const S2S_PROTO = 178;
export const S2S_UNREACH_METRIC = 1000;
export const DEFAULT_OVERLAY = '10.88.0.0/24';
export const SDWAN_NFT_TABLE = 'pi5_sdwan';
export const SDWAN_NFT_FILE = '/etc/nftables.d/pi5-sdwan.conf';
export const SDWAN_SCRIPT = '/opt/pi5-gateway/scripts/sdwan.sh';
export const S2S_KEEPALIVE = 25;
export const S2S_DEFAULT_MTU = 1420;
export const INVITE_TTL_S = 24 * 3600;
export const MAX_NETS = 8;
export const MAX_SITES = 50;
export const MAX_ALLOW = 64;
// Metin sınırı en kötü durumu karşılar: 51 üye × 8 alt ağ × 40 harflik (4 baytlık harflerle) ad ≈ 23 000 karakter.
export const MAX_TEXT = 32768;

// Çakışma denetiminde her zaman bakılan ağlar. Planın 0.3 adres sicili (backend/src/netRegistry.ts, G1.2) gelince
// buradan sicile taşınacak; segment ağları (192.168.<VID>/24) şimdilik kart adresleri üzerinden (localNetworks) yakalanır.
export interface NamedNet { cidr: string; label: string }
export const RESERVED_NETS: NamedNet[] = [
  { cidr: '192.168.50.0/24', label: "Kurulum Wi-Fi'ı" },
  { cidr: '10.66.66.0/24', label: 'VPS tünel ağı' },
  { cidr: '10.77.77.0/24', label: "Ev VPN'i" },
  { cidr: '198.18.64.0/24', label: 'Uygulama ağı' },
];

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NAME = /^[\p{L}\p{N} ._-]{1,40}$/u;
const INVITE_ID = /^[0-9a-f]{16}$/;

export const isWgKey = (k: unknown): k is string => typeof k === 'string' && WG_KEY.test(k);
export const isIpv4 = (s: unknown): s is string => typeof s === 'string' && IPV4.test(s);
export const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
export const numIp = (n: number) => [24, 16, 8, 0].map(sh => Math.floor(n / 2 ** sh) % 256).join('.');

// Şube / merkez adı: yapılandırmaya yorum olarak girer — harf, rakam, boşluk, . _ - (satır sonu giremez).
export function validName(raw: unknown): string | null {
  const n = String(raw ?? '').trim();
  return NAME.test(n) ? n : null;
}

export interface Net { net: string; prefix: number; start: number; size: number }
// "a.b.c.d/nn" → ağ (host bitleri sıfırlanır). Önek yoksa ya da geçersizse null.
export function parseNet(s: unknown): Net | null {
  const m = /^\s*([0-9.]+)\/(\d{1,2})\s*$/.exec(String(s ?? ''));
  if (!m || !IPV4.test(m[1])) return null;
  const prefix = Number(m[2]);
  if (prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipNum(m[1]) / size) * size;
  return { net: `${numIp(start)}/${prefix}`, prefix, start, size };
}
export function netsOverlap(a: string, b: string): boolean {
  const x = parseNet(a), y = parseNet(b);
  if (!x || !y) return false;
  return x.start < y.start + y.size && y.start < x.start + x.size;
}
export function ipInNet(ip: string, net: string): boolean {
  const n = parseNet(net);
  if (!n || !isIpv4(ip)) return false;
  const v = ipNum(ip);
  return v >= n.start && v < n.start + n.size;
}
// a, b'nin içinde mi (b'nin alt ağı ya da kendisi)
export function netWithin(a: string, b: string): boolean {
  const x = parseNet(a), y = parseNet(b);
  return !!x && !!y && x.start >= y.start && x.start + x.size <= y.start + y.size;
}
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
export const isPrivateNet = (cidr: string) => PRIVATE.some(p => netWithin(cidr, p));

// Bir şubenin alt ağları: dizi ya da virgül / boşlukla ayrılmış metin. Her biri özel (RFC1918) /16–/30, ağ adresine
// indirilir; tekrarlar ve birbiriyle çakışanlar reddedilir. min = 0 boş listeye izin verir.
export function validateNets(raw: unknown, min = 1): { ok: true; nets: string[] } | { ok: false; error: string } {
  const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/)).map(x => String(x ?? '').trim()).filter(Boolean);
  if (items.length < min) return { ok: false, error: 'En az bir alt ağ girin (ör. 192.168.10.0/24)' };
  if (items.length > MAX_NETS) return { ok: false, error: `En çok ${MAX_NETS} alt ağ girilebilir` };
  const out: string[] = [];
  for (const it of items) {
    const n = parseNet(it);
    if (!n) return { ok: false, error: `Alt ağ geçersiz: ${it.slice(0, 40)} (a.b.c.d/nn olmalı)` };
    if (n.prefix < 16 || n.prefix > 30) return { ok: false, error: `Alt ağ ${n.net}: önek /16 ile /30 arasında olmalı` };
    if (!isPrivateNet(n.net)) return { ok: false, error: `Alt ağ ${n.net} özel adres aralığında değil (10/8, 172.16/12, 192.168/16)` };
    const dup = out.find(o => netsOverlap(o, n.net));
    if (dup) return { ok: false, error: `Alt ağlar ${dup} ve ${n.net} çakışıyor` };
    out.push(n.net);
  }
  return { ok: true, nets: out };
}

// Overlay (tünel içi ağ): özel bir /24.
export function validateOverlay(raw: unknown): string | null {
  const n = parseNet(raw);
  return n && n.prefix === 24 && isPrivateNet(n.net) ? n.net : null;
}
// Overlay'de .N adresi (1–254)
export function overlayHost(overlay: string, host: number): string {
  const n = parseNet(overlay)!;
  return numIp(n.start + host);
}
export const hostOf = (ip: string) => Number(ip.split('.')[3]);

// Yeni alt ağların bilinen ağlarla çakışması: hata metni (yeniden numaralandırma önerisiyle) ya da null.
export function findConflict(nets: string[], against: NamedNet[]): string | null {
  for (const n of nets) {
    const hit = against.find(a => netsOverlap(n, a.cidr));
    if (hit) {
      return `Alt ağ ${n}, ${hit.label} (${hit.cidr}) ile çakışıyor — şubeler arasında NAT yapılmaz; şubelerden birinin ev ağını başka bir alt ağa (ör. 192.168.${suggestThird(n)}.0/24) taşıyın`;
    }
  }
  return null;
}
// Öneri için üçüncü sekizli: 192.168.0/24 çakışınca 192.168.10/24 vb. (yalnız metin)
function suggestThird(n: string): number {
  const third = Number(n.split('.')[2]) || 0;
  return third >= 240 ? 20 : third + 10;
}

// Uç adres "host:port": IPv4 ya da alan adı; port 1–65535.
export function parseEndpoint(raw: unknown): { host: string; port: number } | null {
  const m = /^\s*([A-Za-z0-9.-]{1,253}):(\d{1,5})\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  const host = m[1].replace(/\.$/, '').toLowerCase();
  if (IPV4.test(host)) {
    const a = Number(host.split('.')[0]);
    if (a === 0 || a === 127 || a >= 224) return null;
    return { host, port };
  }
  if (/^[\d.]+$/.test(host) || !HOSTNAME.test(host)) return null;
  return { host, port };
}

// ─── Davet / kabul / güncelleme metinleri ───
// Biçim: önek + base64url(JSON). Bulut yok: merkez paneli davet üretir, şube paneli kabul yanıtı üretir (iki kopyala-yapıştır).
export interface SiteInfo { name: string; ip: string; nets: string[] }
export interface InviteData {
  v: 1; id: string; exp: number; overlay: string; ip: string; name: string;
  hub: { name: string; pub: string; endpoint: string; ip: string };
  sites: SiteInfo[];
}
export interface AcceptData { v: 1; id: string; pub: string; ip: string; name: string; nets: string[] }
export interface UpdateData { v: 1; at: number; overlay: string; hub: { pub: string; endpoint: string; ip: string; name: string }; sites: SiteInfo[] }
type Kind = 'davet' | 'kabul' | 'guncelleme';
const prefix = (k: Kind) => `klyrix-sdwan:${k}:1:`;

export function encodeText(kind: Kind, data: object): string {
  return prefix(kind) + Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}
function decodeText(kind: Kind, raw: unknown): { ok: true; obj: any } | { ok: false; error: string } {
  const what = kind === 'davet' ? 'Davet' : kind === 'kabul' ? 'Kabul yanıtı' : 'Güncelleme metni';
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: `${what} boş` };
  if (raw.length > MAX_TEXT) return { ok: false, error: `${what} çok uzun` };
  const t = raw.replace(/\s+/g, '');
  const others = (['davet', 'kabul', 'guncelleme'] as Kind[]).filter(k => k !== kind);
  if (!t.startsWith(prefix(kind))) {
    const other = others.find(k => t.startsWith(prefix(k)));
    if (other) return { ok: false, error: `Bu bir ${other === 'davet' ? 'davet' : other === 'kabul' ? 'kabul yanıtı' : 'güncelleme metni'} — ${what.toLowerCase()} bekleniyordu` };
    return { ok: false, error: `${what} tanınmadı (klyrix-sdwan:${kind}:1: ile başlamalı)` };
  }
  const body = t.slice(prefix(kind).length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return { ok: false, error: `${what} bozuk (eksik ya da fazla karakter)` };
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.v !== 1) return { ok: false, error: `${what} sürümü desteklenmiyor` };
    return { ok: true, obj };
  } catch {
    return { ok: false, error: `${what} bozuk (eksik kopyalanmış olabilir)` };
  }
}

// Üye listesi: ad, overlay adresi, alt ağlar; adresler tekil, alt ağlar birbiriyle çakışmaz.
function validateSites(raw: unknown, overlay: string): { ok: true; sites: SiteInfo[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length > MAX_SITES + 1) return { ok: false, error: 'şube listesi geçersiz' };
  const sites: SiteInfo[] = [];
  const all: string[] = [];
  for (const s of raw) {
    const name = validName(s?.name);
    if (!name) return { ok: false, error: 'şube adı geçersiz' };
    if (!isIpv4(s?.ip) || !ipInNet(s.ip, overlay) || hostOf(s.ip) < 1 || hostOf(s.ip) > 254) return { ok: false, error: `${name}: overlay adresi geçersiz` };
    if (sites.some(x => x.ip === s.ip)) return { ok: false, error: `${s.ip} iki şubede` };
    const v = validateNets(s?.nets, 0);
    if (!v.ok) return { ok: false, error: `${name}: ${v.error}` };
    for (const n of v.nets) {
      const dup = all.find(a => netsOverlap(a, n));
      if (dup) return { ok: false, error: `${name}: alt ağ ${n} başka bir şubeninkiyle (${dup}) çakışıyor` };
      if (netsOverlap(n, overlay)) return { ok: false, error: `${name}: alt ağ ${n} overlay ile çakışıyor` };
      all.push(n);
    }
    sites.push({ name, ip: s.ip, nets: v.nets });
  }
  return { ok: true, sites };
}

// Davet (şube tarafında): süre, anahtar, uç, overlay ve adresler sıkı doğrulanır. now = unix sn.
export function parseInvite(raw: unknown, now: number): { ok: true; inv: InviteData } | { ok: false; error: string } {
  const d = decodeText('davet', raw);
  if (!d.ok) return d;
  const o = d.obj;
  if (typeof o.id !== 'string' || !INVITE_ID.test(o.id)) return { ok: false, error: 'Davet kimliği geçersiz' };
  if (!Number.isSafeInteger(o.exp)) return { ok: false, error: 'Davetin süresi geçersiz' };
  if (o.exp <= now) return { ok: false, error: 'Davetin süresi dolmuş — merkezden yeni davet isteyin' };
  if (o.exp - now > 7 * 86400) return { ok: false, error: 'Davetin süresi geçersiz (saat farkı?)' };
  const overlay = validateOverlay(o.overlay);
  if (!overlay || o.overlay !== overlay) return { ok: false, error: 'Davetteki overlay ağı geçersiz' };
  const h = o.hub || {};
  const hubName = validName(h.name);
  if (!hubName) return { ok: false, error: 'Davetteki merkez adı geçersiz' };
  if (!isWgKey(h.pub)) return { ok: false, error: 'Davetteki merkez anahtarı geçersiz' };
  const ep = parseEndpoint(h.endpoint);
  if (!ep) return { ok: false, error: 'Davetteki merkez adresi geçersiz (adres:port olmalı)' };
  if (!isIpv4(h.ip) || !ipInNet(h.ip, overlay) || hostOf(h.ip) < 1 || hostOf(h.ip) > 254) return { ok: false, error: 'Davetteki merkez overlay adresi geçersiz' };
  if (!isIpv4(o.ip) || !ipInNet(o.ip, overlay) || hostOf(o.ip) < 2 || hostOf(o.ip) > 254 || o.ip === h.ip) {
    return { ok: false, error: 'Davetteki şube adresi geçersiz' };
  }
  const name = validName(o.name);
  if (!name) return { ok: false, error: 'Davetteki şube adı geçersiz' };
  const v = validateSites(o.sites, overlay);
  if (!v.ok) return { ok: false, error: `Davetteki ${v.error}` };
  if (v.sites.some(s => s.ip === o.ip)) return { ok: false, error: 'Davetteki şube adresi başka bir şubede kullanılıyor' };
  return {
    ok: true,
    inv: { v: 1, id: o.id, exp: o.exp, overlay, ip: o.ip, name, hub: { name: hubName, pub: h.pub, endpoint: `${ep.host}:${ep.port}`, ip: h.ip }, sites: v.sites },
  };
}

export function parseAccept(raw: unknown): { ok: true; acc: AcceptData } | { ok: false; error: string } {
  const d = decodeText('kabul', raw);
  if (!d.ok) return d;
  const o = d.obj;
  if (typeof o.id !== 'string' || !INVITE_ID.test(o.id)) return { ok: false, error: 'Kabul yanıtındaki davet kimliği geçersiz' };
  if (!isWgKey(o.pub)) return { ok: false, error: 'Kabul yanıtındaki şube anahtarı geçersiz' };
  if (!isIpv4(o.ip)) return { ok: false, error: 'Kabul yanıtındaki şube adresi geçersiz' };
  const name = validName(o.name);
  if (!name) return { ok: false, error: 'Kabul yanıtındaki şube adı geçersiz' };
  const v = validateNets(o.nets, 1);
  if (!v.ok) return { ok: false, error: `Kabul yanıtı: ${v.error}` };
  return { ok: true, acc: { v: 1, id: o.id, pub: o.pub, ip: o.ip, name, nets: v.nets } };
}

export function parseUpdate(raw: unknown): { ok: true; upd: UpdateData } | { ok: false; error: string } {
  const d = decodeText('guncelleme', raw);
  if (!d.ok) return d;
  const o = d.obj;
  if (!Number.isSafeInteger(o.at) || o.at <= 0) return { ok: false, error: 'Güncelleme metninin zamanı geçersiz' };
  const overlay = validateOverlay(o.overlay);
  if (!overlay || o.overlay !== overlay) return { ok: false, error: 'Güncelleme metnindeki overlay ağı geçersiz' };
  const h = o.hub || {};
  const hubName = validName(h.name);
  const ep = parseEndpoint(h.endpoint);
  if (!hubName || !isWgKey(h.pub) || !ep || !isIpv4(h.ip) || !ipInNet(h.ip, overlay)) return { ok: false, error: 'Güncelleme metnindeki merkez bilgisi geçersiz' };
  const v = validateSites(o.sites, overlay);
  if (!v.ok) return { ok: false, error: `Güncelleme metnindeki ${v.error}` };
  return { ok: true, upd: { v: 1, at: o.at, overlay, hub: { name: hubName, pub: h.pub, endpoint: `${ep.host}:${ep.port}`, ip: h.ip }, sites: v.sites } };
}

// ─── Düğüm durumu ───
export type SdwanRole = 'hub' | 'spoke';
export type HubKind = 'klyrix' | 'vps';
export interface PendingInvite { id: string; ip: string; name: string; exp: number }
export type AllowProto = 'tcp' | 'udp' | 'icmp' | 'any';
// İzin listesi: uzak şubeden (from: 'any' = tüm şubeler, ya da alt ağ) bu şubeye (to: 'pi' = bu cihazın hizmetleri, ya da
// yerel alt ağ / adres) yeni bağlantı. Kural yoksa uzak şubeler hiçbir şeye yeni bağlantı açamaz (ping yalnız Pi'ye).
export interface AllowRule { id: string; from: string; to: string; proto: AllowProto; port: number | null }
export interface NodeConfig {
  v: 1;
  role: SdwanRole;
  hubKind: HubKind | null;   // merkez: 'klyrix' (bu cihaz dinler) | 'vps' (kullanıcının VPS'i dinler, bu cihaz yönetir); şube: null
  name: string;              // bu şubenin adı
  overlay: string;
  ip: string;                // bu cihazın overlay adresi
  nets: string[];            // bu şubenin duyurduğu alt ağlar
  endpoint: string;          // klyrix merkez: davetlere yazılan uç (host:51821); şube / VPS merkezi: bağlanılan uç
  hubIp: string;             // merkezin overlay adresi (klyrix merkezde kendi adresi)
  vpsId: number | null;      // VPS merkezi: vps_servers kimliği
  vpsNets: string[];         // VPS merkezi: VPS'in kendi ağları (şube alt ağları bunlarla çakışamaz)
  allow: AllowRule[];
  pending: PendingInvite[];  // merkez: bekleyen davetler (gizli değer yok)
  updatedAt: number;         // şube: son uygulanan güncelleme metninin zamanı (eskisi reddedilir)
  reply: string;             // şube: merkeze yapıştırılacak kabul yanıtı (gizli değer yok; ilk el sıkışmaya dek gösterilir)
}

// node.json'dan okunan nesne → doğrulanmış yapılandırma; bozuksa null.
export function normalizeNode(o: any): NodeConfig | null {
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  const role: SdwanRole | null = o.role === 'hub' || o.role === 'spoke' ? o.role : null;
  const hubKind: HubKind | null = role === 'hub' && (o.hubKind === 'klyrix' || o.hubKind === 'vps') ? o.hubKind : null;
  if (!role || (role === 'hub' && !hubKind)) return null;
  const overlay = validateOverlay(o.overlay);
  const name = validName(o.name);
  if (!overlay || !name || !isIpv4(o.ip) || !ipInNet(o.ip, overlay) || !isIpv4(o.hubIp) || !ipInNet(o.hubIp, overlay)) return null;
  const nets = validateNets(o.nets, 1);
  if (!nets.ok) return null;
  const ep = o.endpoint === '' && role === 'hub' && hubKind === 'klyrix' ? null : parseEndpoint(o.endpoint);
  if (!ep && !(role === 'hub' && hubKind === 'klyrix')) return null;
  const vpsNets = (Array.isArray(o.vpsNets) ? o.vpsNets : []).map((x: unknown) => parseNet(x)?.net).filter((x: unknown): x is string => !!x);
  const allow = validateAllow(Array.isArray(o.allow) ? o.allow : [], nets.nets, () => '00000000');
  const pending = (Array.isArray(o.pending) ? o.pending : []).filter((p: any) =>
    p && INVITE_ID.test(String(p.id)) && isIpv4(p.ip) && ipInNet(p.ip, overlay) && validName(p.name) && Number.isSafeInteger(p.exp))
    .map((p: any) => ({ id: p.id, ip: p.ip, name: p.name, exp: p.exp }));
  return {
    v: 1, role, hubKind, name, overlay, ip: o.ip, nets: nets.nets, endpoint: ep ? `${ep.host}:${ep.port}` : '', hubIp: o.hubIp,
    vpsId: hubKind === 'vps' && Number.isSafeInteger(o.vpsId) && o.vpsId > 0 ? o.vpsId : null,
    vpsNets, allow: allow.ok ? allow.rules : [], pending,
    updatedAt: Number.isSafeInteger(o.updatedAt) ? o.updatedAt : 0,
    reply: typeof o.reply === 'string' && o.reply.length <= MAX_TEXT ? o.reply : '',
  };
}
// Uzak üye (sdwan_sites satırı). peer: bu cihazın doğrudan WireGuard eşi (merkez Klyrix'te her şube; şubede ve VPS
// merkezinde yalnız merkez) — diğerlerine merkez üzerinden ulaşılır.
export interface SiteRow { id: number; name: string; ip: string; pub: string; nets: string[]; endpoint: string; peer: boolean }

// Tablo 30001'e giden ağlar: overlay + uzak üyelerin alt ağları (tekil, sıralı).
export function remoteRoutes(node: Pick<NodeConfig, 'overlay'>, sites: Pick<SiteRow, 'nets'>[]): string[] {
  const set = new Set<string>([node.overlay]);
  for (const s of sites) for (const n of s.nets) set.add(n);
  return [...set].sort((a, b) => parseNet(a)!.start - parseNet(b)!.start || a.localeCompare(b));
}

// Kurulumdan SONRA bu cihazda bir uzak ağla çakışan yerel ağ belirebilir (modem değişince yeni ev ağı, segment, yedek
// hattın USB modemi / telefonu, Wi-Fi köprüsünün üst ağı). O uzak ağın yolu (ip rule 1050) kurulmaz: kural o ağdaki
// cihazlara giden yanıtları (DNS, DHCP, panel, SSH) tünele çekerdi. Çakışma kalkınca yol kendiliğinden geri gelir
// (remoteAccess.ts planRemoteAccess deseni). local: bu cihazın kart ağları (wg_s2s* hariç).
export interface BlockedRoute { net: string; local: string; label: string }
export function splitRoutes(routes: string[], local: NamedNet[]): { routes: string[]; blocked: BlockedRoute[] } {
  const use: string[] = [];
  const blocked: BlockedRoute[] = [];
  for (const r of routes) {
    const hit = local.find(l => netsOverlap(r, l.cidr));
    if (hit) blocked.push({ net: r, local: hit.cidr, label: hit.label });
    else use.push(r);
  }
  return { routes: use, blocked };
}

export interface PeerSpec { name: string; pub: string; endpoint: string; allowed: string[] }
export function nodePeers(node: NodeConfig, sites: SiteRow[]): PeerSpec[] {
  if (node.role === 'hub' && node.hubKind === 'klyrix') {
    return sites.filter(s => s.peer).map(s => ({ name: s.name, pub: s.pub, endpoint: '', allowed: [`${s.ip}/32`, ...s.nets] }));
  }
  // Şube ve VPS merkezi: tek eş (merkez); overlay ve tüm uzak alt ağlar ondan geçer.
  const hub = sites.find(s => s.peer);
  if (!hub) return [];
  return [{ name: hub.name, pub: hub.pub, endpoint: hub.endpoint, allowed: remoteRoutes(node, sites) }];
}

// /etc/wireguard/wg_s2s0.conf (0600). Table = off: wg-quick rota eklemez; rotalar tablo 30001'de, ip rule 1050 ile.
//  - PreUp: önce güvenlik duvarı tablosu (yüklenemezse tünel açılmaz; uzak ağlara operatör yolundan giden trafiği de
//    reddeder), sonra `sdwan.sh rules`: uzak ağlara 'unreachable' (metric 1000) ve ip rule — arayüz düşse de kalır: tünel
//    yokken trafik operatöre SIZMAZ, hemen hata alır. Açılışta panelden önce de çalışır: o an bu cihazın bir kartının
//    ağıyla çakışan uzak ağın kuralını kurmaz.
//  - PostUp: arayüz rotaları (arayüz silinince çekirdek kaldırır, unreachable kalır) ve gevşek rp_filter.
// routes: kurulacak uzak ağlar (verilmezse hepsi; sdwan.ts çakışanları çıkarır). Komutlara yalnız doğrulanmış ağ adresleri
// girer (parseNet).
export function renderS2sConf(o: { privateKey: string; node: NodeConfig; sites: SiteRow[]; mtu: number; routes?: string[] }): string {
  const routes = o.routes ?? remoteRoutes(o.node, o.sites);
  const listen = o.node.role === 'hub' && o.node.hubKind === 'klyrix';
  return [
    '# Klyrix Gate: subeler arasi SD-WAN (wg_s2s0). Panel yazar, elle degistirmeyin (SD-WAN sayfasi).',
    '[Interface]',
    `PrivateKey = ${o.privateKey}`,
    `Address = ${o.node.ip}/32`,
    ...(listen ? [`ListenPort = ${S2S_PORT}`] : []),
    `MTU = ${o.mtu}`,
    'Table = off',
    `PreUp = nft -f ${SDWAN_NFT_FILE}`,
    ...(routes.length ? [`PreUp = bash ${SDWAN_SCRIPT} rules ${routes.join(' ')}`] : []),
    'PostUp = sysctl -q -w net.ipv4.conf.%i.rp_filter=2 || true',
    ...routes.map(r => `PostUp = ip route replace ${r} dev %i table ${S2S_TABLE} proto ${S2S_PROTO}`),
    ...nodePeers(o.node, o.sites).flatMap(p => [
      '', `# ${p.name}`, '[Peer]', `PublicKey = ${p.pub}`, `AllowedIPs = ${p.allowed.join(', ')}`,
      ...(p.endpoint ? [`Endpoint = ${p.endpoint}`] : []),
      `PersistentKeepalive = ${S2S_KEEPALIVE}`,
    ]),
    '',
  ].join('\n');
}

// VPS merkezinin eşleri (VPS'teki /etc/wireguard/wg_s2s.conf'un [Peer] bölümleri): bu cihaz + diğer şubeler. Özel anahtar
// VPS'te kalır; bu metin gizli değer içermez.
export function renderVpsPeers(node: NodeConfig, ownPub: string, sites: SiteRow[]): string {
  const members = [{ name: node.name, pub: ownPub, ip: node.ip, nets: node.nets }, ...sites.filter(s => !s.peer)];
  return members.map(m => [`# ${m.name}`, '[Peer]', `PublicKey = ${m.pub}`, `AllowedIPs = ${[`${m.ip}/32`, ...m.nets].join(', ')}`, ''].join('\n')).join('\n');
}

// ─── İzin listesi ───
const RULE_ID = /^[0-9a-f]{8}$/;
// Kural doğrulaması: from 'any' ya da özel ağ (/8–/32); to 'pi' ya da bu şubenin alt ağlarından birinin içinde (/16–/32);
// port 1–65535 (icmp'de yok); 'any' + port → TCP ve UDP. piAddrs: bu cihazın adresleri — tek cihaz hedefi Pi'nin kendisiyse
// reddedilir: alt ağ / cihaz kuralları yalnız iletimdir (forward), Pi'nin hizmetleri 'Bu Pi' hedefiyle açılır.
export function validateAllow(raw: unknown, ownNets: string[], makeId: () => string, piAddrs: string[] = []): { ok: true; rules: AllowRule[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'İzin listesi dizi olmalı' };
  if (raw.length > MAX_ALLOW) return { ok: false, error: `En çok ${MAX_ALLOW} izin kuralı eklenebilir` };
  const rules: AllowRule[] = [];
  for (const [i, r] of raw.entries()) {
    const at = `${i + 1}. kural`;
    const proto = r?.proto;
    if (!['tcp', 'udp', 'icmp', 'any'].includes(proto)) return { ok: false, error: `${at}: protokol tcp, udp, icmp ya da any olmalı` };
    let from = String(r?.from ?? '').trim();
    if (from !== 'any') {
      const n = parseNet(from.includes('/') ? from : `${from}/32`);
      if (!n || n.prefix < 8 || !isPrivateNet(n.net)) return { ok: false, error: `${at}: kaynak 'tüm şubeler' ya da özel bir alt ağ / adres olmalı` };
      if (ownNets.some(o => netsOverlap(o, n.net))) return { ok: false, error: `${at}: kaynak (${n.net}) bu şubenin kendi ağı` };
      from = n.net;
    }
    let to = String(r?.to ?? '').trim();
    if (to !== 'pi') {
      const n = parseNet(to.includes('/') ? to : `${to}/32`);
      if (!n || n.prefix < 16) return { ok: false, error: `${at}: hedef 'bu cihaz' ya da bu şubenin alt ağı / bir adresi olmalı` };
      if (!ownNets.some(o => netWithin(n.net, o))) return { ok: false, error: `${at}: hedef (${n.net}) bu şubenin alt ağlarında (${ownNets.join(', ') || 'yok'}) değil` };
      const self = n.prefix === 32 ? piAddrs.find(a => `${a}/32` === n.net) : undefined;
      if (self) return { ok: false, error: `${at}: ${self} bu Pi'nin adresi — Pi'nin hizmetleri için hedef olarak "Bu Pi (hizmetleri)" seçin` };
      to = n.net;
    }
    let port: number | null = null;
    if (r?.port !== undefined && r?.port !== null && r?.port !== '') {
      port = Number(r.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `${at}: port 1-65535 arasında olmalı` };
    }
    if (proto === 'icmp' && port !== null) return { ok: false, error: `${at}: ping (icmp) için port verilmez` };
    if ((proto === 'tcp' || proto === 'udp') && port === null) return { ok: false, error: `${at}: ${proto.toUpperCase()} için port girin (tüm portlar için protokol 'tümü')` };
    const id = typeof r?.id === 'string' && RULE_ID.test(r.id) ? r.id : makeId();
    if (rules.some(x => x.from === from && x.to === to && x.proto === proto && x.port === port)) continue;
    rules.push({ id, from, to, proto, port });
  }
  return { ok: true, rules };
}

function allowMatch(r: AllowRule): string {
  const parts: string[] = ['iifname "wg_s2s*"'];
  if (r.from !== 'any') parts.push(`ip saddr ${r.from}`);
  if (r.to !== 'pi') parts.push(`ip daddr ${r.to}`);
  if (r.proto === 'icmp') parts.push('icmp type echo-request');
  else if (r.proto === 'tcp' || r.proto === 'udp') parts.push(`${r.proto} dport ${r.port}`);
  else if (r.port !== null) parts.push(`meta l4proto { tcp, udp } th dport ${r.port}`);
  parts.push('accept');
  return parts.join(' ');
}

// inet pi5_sdwan (öncelik filter - 7). drop her taban zincirde kesindir (wgServer.ts ilkesi): uzak şubeden gelen YENİ
// bağlantı burada düşerse başka tablolardaki izinler (Samba / Syncthing'in "tüm RFC1918 ev ağıdır" kuralları, panel,
// DNS) onu geri açamaz. accept yalnız bu zinciri bitirir: politikası drop tablolar ayrıca izin ister (sdwan.ts atlama zincirleri).
//  - kaçış koruması (forward + output → guard): uzak ağlara (remote; çakışan yerel ağlar sdwan.ts'te çıkarılır) wg_s2s*
//    dışından giden paket reddedilir — ağ geçidine (operatör / modem), PPPoE'ye ya da başka bir WireGuard tüneline. Yönlendirme
//    kurallarından (ip rule 1050) bağımsızdır: açılışta tünel ve kurallar gelmeden (pi5-sdwan-guard ağdan önce yükler) ya da
//    kurallar elle silinse de trafik operatöre SIZMAZ. Doğrudan bağlı ağdaki hedef (sonradan çakışan yerel ağ: sonraki atlama
//    hedefin kendisi) reddedilmez — o ağdaki cihazlar kesilmez.
//  - input: wg_s2s* → yanıtlar ve ping; izin listesinde 'bu cihaz' hedefli kurallar; geri kalan drop.
//  - forward: MSS kısma — tünele çıkan SYN rota MTU'suna, tünelden gelen SYN / SYN-ACK bu ucun tünel MTU'suna (mtu - 40; iki
//    uçta MTU farklıysa, ör. PPPoE 1412 ↔ 1420, ev ağı cihazı büyük karşı MSS'i öğrenip PMTUD'ye kalmasın); yanıtlar; merkez
//    Klyrix'te şubeden şubeye aktarma (karar hedef şubenin kendi listesinde); izin listesi; wg_s2s* kaynaklı geri kalan drop.
//    Tünele yeni bağlantıyı yalnız bu şubenin kendi alt ağları açar: Ev VPN'i istemcileri, VPS tünelleri, kurulum Wi-Fi'ı ve
//    internet tarafı uzak şubelere ulaşamaz.
export function renderSdwanNft(o: { ownNets: string[]; transit: boolean; allow: AllowRule[]; remote: string[]; mtu: number }): string {
  const pi = o.allow.filter(r => r.to === 'pi');
  const fwd = o.allow.filter(r => r.to !== 'pi');
  const mss = Math.max(536, Math.floor(o.mtu) - 40);
  const remote = o.remote.map(r => parseNet(r)?.net).filter((r): r is string => !!r);
  const guard = '    ip daddr @remote oifname != "wg_s2s*" jump guard';
  return [
    "# Klyrix Gate — subeler arasi SD-WAN (wg_s2s*) kurallari; panel yazar, arayuzun PreUp'i yukler.",
    `table inet ${SDWAN_NFT_TABLE} {}`,
    `delete table inet ${SDWAN_NFT_TABLE}`,
    `table inet ${SDWAN_NFT_TABLE} {`,
    '  set remote {',
    '    type ipv4_addr; flags interval; auto-merge;',
    ...(remote.length ? [`    elements = { ${remote.join(', ')} }`] : []),
    '  }',
    '  chain guard {',
    '    oifname "ppp*" reject with icmp type net-unreachable',
    '    oifname "wg*" reject with icmp type net-unreachable',
    '    rt ip nexthop != @remote reject with icmp type net-unreachable',
    '  }',
    '  chain output {',
    '    type filter hook output priority filter - 7; policy accept;',
    guard,
    '  }',
    '  chain input {',
    '    type filter hook input priority filter - 7; policy accept;',
    '    iifname "wg_s2s*" ct state established,related accept',
    '    iifname "wg_s2s*" icmp type echo-request accept',
    ...pi.map(r => `    ${allowMatch(r)}`),
    '    iifname "wg_s2s*" drop',
    '  }',
    '  chain forward {',
    '    type filter hook forward priority filter - 7; policy accept;',
    '    oifname "wg_s2s*" tcp flags syn tcp option maxseg size set rt mtu',
    `    iifname "wg_s2s*" tcp flags syn tcp option maxseg size > ${mss} tcp option maxseg size set ${mss}`,
    guard,
    '    iifname "wg_s2s*" ct state established,related accept',
    '    oifname "wg_s2s*" ct state established,related accept',
    ...(o.transit ? ['    iifname "wg_s2s*" oifname "wg_s2s*" accept'] : []),
    ...fwd.map(r => `    ${allowMatch(r)}`),
    '    iifname "wg_s2s*" drop',
    ...(o.ownNets.length ? [`    oifname "wg_s2s*" ip saddr { ${o.ownNets.join(', ')} } accept`] : []),
    '    oifname "wg_s2s*" drop',
    '  }',
    '}',
    '',
  ].join('\n');
}

// Politikası drop tablolardaki (Debian inet filter, panelin inet pi5_filter) izin zincirleri: pi5_sdwan süzdüğü için
// wg_s2s* trafiği burada yalnız kabul edilir; merkez Klyrix'te UDP 51821 de.
export function dropTableRules(listen: boolean): { input: string[]; forward: string[] } {
  return {
    input: [...(listen ? [`udp dport ${S2S_PORT} accept`] : []), 'iifname "wg_s2s*" accept'],
    forward: ['iifname "wg_s2s*" accept', 'oifname "wg_s2s*" accept'],
  };
}

// ─── Rota / kural okuma (ip çıktısı → yapı) ───
// `ip -4 route show table 30001`: "unreachable 192.168.1.0/24 metric 1000" | "192.168.1.0/24 dev wg_s2s0 proto 178 scope link"
export function parseTableRoutes(text: string): { unreach: string[]; dev: { net: string; dev: string }[]; other: string[] } {
  const unreach: string[] = [], dev: { net: string; dev: string }[] = [], other: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^unreachable\s+(\S+)/.exec(line);
    if (m) { unreach.push(m[1].includes('/') ? m[1] : `${m[1]}/32`); continue; }
    m = /^(\S+)\s+dev\s+(\S+)/.exec(line);
    if (m && m[1] !== 'default') { dev.push({ net: m[1].includes('/') ? m[1] : `${m[1]}/32`, dev: m[2] }); continue; }
    other.push(line);
  }
  return { unreach, dev, other };
}
// `ip -4 rule show pref 1050`: "1050:	from all to 192.168.1.0/24 lookup 30001"
export function parseRules(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${S2S_PREF}:\\s+from all to (\\S+) lookup ${S2S_TABLE}\\b`).exec(line.trim());
    if (m) out.push(m[1].includes('/') ? m[1] : `${m[1]}/32`);
  }
  return out;
}

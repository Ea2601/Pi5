// Hazır WireGuard yapılandırması (.conf): saf ayrıştırma, temizleme ve yazım. Bu modül sisteme, dosyaya ya da veritabanına
// dokunmaz. Kullanıcının elindeki yapılandırma (ticari VPN sağlayıcısı, başkasının sunucusu, şirket VPN'i) Pi'ye HİÇBİR ZAMAN
// olduğu gibi yazılmaz: önce burada ayrıştırılır, Pi'ye yalnız renderImportedConf'un ürettiği metin yazılır. Veritabanındaki
// kayıt da her yazımda yeniden temizlenir (renderStoredConf): elle değiştirilmiş bir kayıt Pi'de komut çalıştıramaz.
// Tünelin yaşam döngüsü: wgImport.ts.
//
// wg-quick'in tanıdığı anahtarlar (büyük / küçük harf duyarsız, '#' sonrası yorum):
//   [Interface] PrivateKey Address MTU DNS Table PreUp PostUp PreDown PostDown SaveConfig ListenPort FwMark
//   [Peer]      PublicKey PresharedKey AllowedIPs Endpoint PersistentKeepalive
// Başka bir anahtar `wg setconf`'ta da hata verir; burada açık bir iletiyle reddedilir (AmneziaWG'nin Jc / S1 / H1 … anahtarları
// ayrıca söylenir).
// Pi'ye yazılan biçim:
//  - Table = off: wg-quick'in otomatik varsayılan rotası Pi'nin bütün trafiğini tünele verirdi. Hangi trafiğin bu tünelden
//    çıkacağına panelin yönlendirme kuralları karar verir (işaret tabloları; ssh.ts connectPi5ToVps ile aynı).
//  - PreUp: koruma tablosu (inet pi5_wgext, wgImport.ts) arayüz açılmadan yüklenir; yüklenemezse tünel açılmaz.
//  - PostUp: tünelden dönen yanıtlar işaretsiz gelir, katı rp_filter onları düşürmesin (panelin VPS tünelleriyle aynı).
//  - Uygulanmaz: DNS (resolv.conf'u ezerdi, Pi-hole devreden çıkardı), kullanıcının PreUp / PostUp / PreDown / PostDown satırları
//    (Pi'de root olarak çalışan komut), SaveConfig, FwMark, ListenPort (Ev VPN'inin 51820'siyle çakışabilir).
//  - Address: ilk IPv4 adres, /32. Örneğin /24, ana tabloya ev ağıyla çakışabilecek bir rota eklerdi. IPv6 adres ve aralıklar
//    uygulanmaz (panelin yönlendirmesi IPv4).
//  - AllowedIPs: sunucunun verdiği IPv4 aralıkları korunur. Bölünmüş tünelde (ör. yalnız şirket ağı) yalnız o aralıklara giden
//    trafik taşınır; tünele yönlendirilen başka trafiği WireGuard düşürür.
//  - PersistentKeepalive = 25: tünel durumu el sıkışma yaşıyla ölçülür (vpsTunnel.ts, 180 sn); boştayken de taze kalsın.
import net from 'net';

export const WGEXT_NFT_FILE = '/etc/nftables.d/pi5-wgext.conf';
export const MAX_CONF_BYTES = 16 * 1024;
const MAX_ALLOWED = 256;
const KEEPALIVE = 25;

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const INTERFACE_KEYS = new Set(['privatekey', 'address', 'mtu', 'dns', 'table', 'preup', 'postup', 'predown', 'postdown',
  'saveconfig', 'listenport', 'fwmark']);
const PEER_KEYS = new Set(['publickey', 'presharedkey', 'allowedips', 'endpoint', 'persistentkeepalive']);
// Birden çok satırda yazılabilenler (wg-quick / wg değerleri birleştirir); diğerinin ikinci kez yazılması reddedilir.
const MULTI = new Set(['address', 'dns', 'allowedips', 'preup', 'postup', 'predown', 'postdown']);
const AMNEZIA = /^(jc|jmin|jmax|s[1-4]|h[1-4]|i[1-5]|j[1-3]|itime)$/;
const HOOKS: [string, string][] = [['preup', 'PreUp'], ['postup', 'PostUp'], ['predown', 'PreDown'], ['postdown', 'PostDown']];

export interface WgImportConf {
  privateKey: string;
  address: string;          // "a.b.c.d/32"
  mtu: number | null;       // null = wg-quick hesaplar
  peerPublicKey: string;
  presharedKey: string;     // '' = yok
  allowedIps: string[];     // IPv4, ağ adresine indirilmiş ("0.0.0.0/0", "10.0.0.0/24"); verildiği sırada
  fullTunnel: boolean;      // internet trafiğini taşıyabilir (aralıklar IPv4 uzayının en az yarısı)
  endpointHost: string;     // "vpn.example.com" | "203.0.113.5" | "2001:db8::1" (köşeli parantezsiz)
  endpointPort: number;
  notes: string[];          // uygulanmayan / değiştirilen satırlar (kullanıcıya gösterilir)
}
export type WgParse = { ok: true; conf: WgImportConf } | { ok: false; error: string };

const fail = (error: string): WgParse => ({ ok: false, error });
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const numIp = (n: number) => [24, 16, 8, 0].map(sh => Math.floor(n / 2 ** sh) % 256).join('.');

// "a.b.c.d" ya da "a.b.c.d/nn" (önek 0–32) → adres, önek ve host bitleri sıfırlanmış ağ; geçersizse null.
function parseCidr4(s: string): { ip: string; prefix: number; net: string } | null {
  const m = /^([^/\s]+)(?:\/(\d{1,2}))?$/.exec(s.trim());
  if (!m || !IPV4.test(m[1])) return null;
  const prefix = m[2] === undefined ? 32 : Number(m[2]);
  if (prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return { ip: m[1], prefix, net: `${numIp(Math.floor(ipNum(m[1]) / size) * size)}/${prefix}` };
}

// Tünel adresi ya da sunucu adresi olamayacak IPv4 aralıkları: neden, kullanılabilirse ''.
function badUnicast(ip: string): string {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return 'ayrılmış adres';
  if (a === 127) return 'yerel döngü adresi';
  if (a === 169 && b === 254) return 'bağlantı-yerel adres';
  if (a >= 224) return 'çok noktaya yayın / ayrılmış adres';
  return '';
}

// Aralıkların kapladığı adres sayısı (çakışanlar bir kez sayılır).
function coverage(cidrs: string[]): number {
  const iv = cidrs.map(c => {
    const [n, p] = c.split('/');
    const start = ipNum(n);
    return [start, start + 2 ** (32 - Number(p))] as [number, number];
  }).sort((x, y) => x[0] - y[0]);
  let total = 0, from = 0, to = 0;
  for (const [s, e] of iv) {
    if (s > to) { total += to - from; from = s; to = e; } else if (e > to) to = e;
  }
  return total + (to - from);
}

export function parseImportedConf(raw: unknown): WgParse {
  if (typeof raw !== 'string' || !raw.trim()) return fail('Yapılandırma boş');
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONF_BYTES) return fail(`Yapılandırma çok büyük (en çok ${MAX_CONF_BYTES / 1024} KB)`);
  const text = raw.replace(/^﻿/, '');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    return fail('Yapılandırmada geçersiz (denetim) karakter var — dosyanın kendisini yükleyin ya da metni yeniden kopyalayın');
  }
  let section: 'interface' | 'peer' | '' = '';
  let nIface = 0, nPeer = 0;
  const vals: Record<string, string[]> = {};
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim(); // wg-quick gibi: '#' sonrası yorum
    if (!line) continue;
    const where = `${i + 1}. satır`;
    const sec = /^\[\s*([A-Za-z]+)\s*\]$/.exec(line);
    if (sec) {
      const name = sec[1].toLowerCase();
      if (name === 'interface') {
        if (++nIface > 1) return fail('Birden çok [Interface] bölümü var');
        section = 'interface';
      } else if (name === 'peer') {
        if (++nPeer > 1) return fail('Birden çok [Peer] var — yalnız tek sunuculu yapılandırma desteklenir');
        section = 'peer';
      } else return fail(`Bilinmeyen bölüm: [${clip(sec[1])}] (${where})`);
      continue;
    }
    const kv = /^([A-Za-z0-9]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) return fail(`Anlaşılamayan satır (${where}): ${clip(line)}`);
    if (!section) return fail(`[Interface] başlığından önce satır var (${where})`);
    const key = kv[1].toLowerCase();
    if (AMNEZIA.test(key)) return fail(`Bu bir AmneziaWG yapılandırması (${kv[1]} anahtarı) — standart WireGuard ile bağlanamaz`);
    if (!(section === 'interface' ? INTERFACE_KEYS : PEER_KEYS).has(key)) {
      const misplaced = (section === 'interface' ? PEER_KEYS : INTERFACE_KEYS).has(key);
      return fail(misplaced
        ? `${kv[1]} ${section === 'interface' ? '[Interface]' : '[Peer]'} bölümünde olmamalı (${where})`
        : `Bilinmeyen anahtar: ${clip(kv[1])} (${where})`);
    }
    const k = `${section}.${key}`;
    if (vals[k] && !MULTI.has(key)) return fail(`${kv[1]} iki kez yazılmış (${where})`);
    (vals[k] ||= []).push(kv[2].trim());
  }
  if (!nIface) return fail('[Interface] bölümü yok');
  if (!nPeer) return fail('[Peer] (sunucu) bölümü yok');
  const one = (k: string) => vals[k]?.[0] ?? '';
  const list = (k: string) => (vals[k] || []).flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean);
  const notes: string[] = [];

  const privateKey = one('interface.privatekey');
  if (!privateKey) return fail('PrivateKey yok');
  if (!WG_KEY.test(privateKey)) return fail('PrivateKey geçersiz (44 karakterlik base64 anahtar olmalı)');
  const peerPublicKey = one('peer.publickey');
  if (!peerPublicKey) return fail("Sunucunun PublicKey satırı yok ([Peer] bölümünde)");
  if (!WG_KEY.test(peerPublicKey)) return fail('PublicKey geçersiz (44 karakterlik base64 anahtar olmalı)');
  const presharedKey = one('peer.presharedkey');
  if (presharedKey && !WG_KEY.test(presharedKey)) return fail('PresharedKey geçersiz (44 karakterlik base64 anahtar olmalı)');

  // Tünel adresi: ilk IPv4, /32
  const addrs = list('interface.address');
  if (!addrs.length) return fail('Address (tünel adresi) yok');
  const v4: { ip: string; prefix: number }[] = [];
  let v6 = 0;
  for (const a of addrs) {
    if (a.includes(':')) { v6++; continue; }
    const c = parseCidr4(a);
    if (!c) return fail(`Address geçersiz: ${clip(a)}`);
    v4.push(c);
  }
  if (!v4.length) return fail("Address'te IPv4 adres yok — panelin yönlendirmesi IPv4 ile çalışır");
  const addr = v4[0];
  const badAddr = badUnicast(addr.ip);
  if (badAddr) return fail(`Address kullanılamaz: ${addr.ip} (${badAddr})`);
  if (v4.length > 1) notes.push(`Yalnız ilk IPv4 adres kullanıldı (${addr.ip})`);
  if (addr.prefix !== 32) notes.push(`Address /${addr.prefix} yerine /32 — ev ağıyla çakışabilecek rota eklenmez`);
  if (v6) notes.push('IPv6 adres uygulanmadı (panelin yönlendirmesi IPv4)');

  let mtu: number | null = null;
  const mtuRaw = one('interface.mtu');
  if (mtuRaw) {
    const n = /^\d{1,5}$/.test(mtuRaw) ? Number(mtuRaw) : NaN;
    if (n >= 1280 && n <= 1500) mtu = n;
    else notes.push(`MTU ${clip(mtuRaw)} uygulanmadı (1280–1500 dışında) — otomatik`);
  }
  if (vals['interface.dns']) notes.push("DNS satırı uygulanmadı — Pi'nin DNS'i (Pi-hole) değişmez");
  const table = one('interface.table');
  if (table && table.toLowerCase() !== 'off') notes.push("Table uygulanmadı — Pi'nin trafiği tünele kendiliğinden verilmez, Routing kuralları belirler");
  const hooks = HOOKS.filter(([k]) => vals[`interface.${k}`]).map(([, label]) => label);
  if (hooks.length) notes.push(`${hooks.join(' / ')} uygulanmadı — Pi'de komut çalıştırılmaz`);
  if (vals['interface.saveconfig']) notes.push('SaveConfig uygulanmadı');
  if (vals['interface.listenport']) notes.push('ListenPort uygulanmadı (yerel port rastgele seçilir)');
  if (vals['interface.fwmark']) notes.push('FwMark uygulanmadı');

  const allowedRaw = list('peer.allowedips');
  if (!allowedRaw.length) return fail('AllowedIPs yok — sunucunun hangi trafiği taşıyacağı belirsiz');
  const nets = new Set<string>();
  let a6 = 0;
  for (const a of allowedRaw) {
    if (a.includes(':')) { a6++; continue; }
    const c = parseCidr4(a);
    if (!c) return fail(`AllowedIPs geçersiz: ${clip(a)}`);
    nets.add(c.net);
  }
  if (!nets.size) return fail("AllowedIPs'te IPv4 aralık yok (yalnız IPv6) — panelin yönlendirmesi IPv4 ile çalışır");
  if (nets.size > MAX_ALLOWED) return fail(`AllowedIPs'te çok fazla aralık var (${nets.size}; en çok ${MAX_ALLOWED})`);
  if (a6) notes.push('IPv6 aralıkları (AllowedIPs) uygulanmadı');
  const allowedIps = nets.has('0.0.0.0/0') ? ['0.0.0.0/0'] : [...nets];
  const fullTunnel = coverage(allowedIps) >= 2 ** 31;

  const ep = one('peer.endpoint');
  if (!ep) return fail('Endpoint (sunucunun adresi) yok');
  const e6 = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(ep);
  const m = e6 || /^([^:\s[\]]+):(\d{1,5})$/.exec(ep);
  if (!m) return fail(`Endpoint geçersiz: ${clip(ep)} (adres:port olmalı)`);
  const endpointPort = Number(m[2]);
  if (endpointPort < 1 || endpointPort > 65535) return fail(`Endpoint portu geçersiz: ${m[2]}`);
  let endpointHost = m[1];
  if (e6) {
    if (!net.isIPv6(endpointHost)) return fail(`Endpoint geçersiz: ${clip(ep)}`);
    notes.push('Sunucu adresi IPv6 — hattınızda IPv6 yoksa tünel bağlanmaz');
  } else if (IPV4.test(endpointHost)) {
    const bad = badUnicast(endpointHost);
    if (bad) return fail(`Endpoint kullanılamaz: ${endpointHost} (${bad})`);
  } else {
    endpointHost = endpointHost.replace(/\.$/, '');
    if (!HOSTNAME.test(endpointHost) || /^[\d.]+$/.test(endpointHost)) return fail(`Endpoint geçersiz: ${clip(ep)}`);
  }
  const ka = one('peer.persistentkeepalive');
  if (ka && ka !== String(KEEPALIVE)) notes.push(`PersistentKeepalive ${KEEPALIVE} yapıldı (tünel durumu el sıkışmayla ölçülür)`);

  return {
    ok: true,
    conf: {
      privateKey, address: `${addr.ip}/32`, mtu, peerPublicKey, presharedKey, allowedIps, fullTunnel,
      endpointHost, endpointPort, notes,
    },
  };
}

// Pi'ye yazılan tek biçim (/etc/wireguard/wg_vps<id>.conf). Yorum satırı ASCII: wg-quick '#' sonrasını zaten atar.
export function renderImportedConf(c: WgImportConf): string {
  const host = c.endpointHost.includes(':') ? `[${c.endpointHost}]` : c.endpointHost;
  return [
    '# Klyrix Gate: ice aktarilan WireGuard yapilandirmasi. Panel yazar, elle degistirmeyin (WireGuard > Yapilandirmayi degistir).',
    '[Interface]',
    `PrivateKey = ${c.privateKey}`,
    `Address = ${c.address}`,
    ...(c.mtu ? [`MTU = ${c.mtu}`] : []),
    'Table = off',
    `PreUp = nft -f ${WGEXT_NFT_FILE}`,
    'PostUp = sysctl -q -w net.ipv4.conf.%i.rp_filter=2 || true',
    '',
    '[Peer]',
    `PublicKey = ${c.peerPublicKey}`,
    ...(c.presharedKey ? [`PresharedKey = ${c.presharedKey}`] : []),
    `AllowedIPs = ${c.allowedIps.join(', ')}`,
    `Endpoint = ${host}:${c.endpointPort}`,
    `PersistentKeepalive = ${KEEPALIVE}`,
    '',
  ].join('\n');
}

// Veritabanındaki kayıt (vps_servers.wg_conf) → yeniden temizlenmiş yazım; okunamazsa null. Geri yükleme de bunu kullanır.
export function renderStoredConf(stored: unknown): string | null {
  const r = parseImportedConf(stored);
  return r.ok ? renderImportedConf(r.conf) : null;
}

// Kartta ve listede gösterilen, gizli olmayan özet (özel anahtar ve ön paylaşımlı anahtar asla).
export interface ImportSummary { address: string; endpoint: string; allowed_ips: string[]; full_tunnel: boolean; mtu: number | null }
export function importSummary(stored: unknown): ImportSummary | null {
  const r = parseImportedConf(stored);
  if (!r.ok) return null;
  const c = r.conf;
  const host = c.endpointHost.includes(':') ? `[${c.endpointHost}]` : c.endpointHost;
  return { address: c.address, endpoint: `${host}:${c.endpointPort}`, allowed_ips: c.allowedIps, full_tunnel: c.fullTunnel, mtu: c.mtu };
}

// Ev VPN'i dış erişim testinin (wgServer.ts) deneme paketlerini çıkaracağı tüneller, tercih sırasıyla: panelin kendi VPS
// tünelleri önce (sıraları korunur), sonra internet trafiğini taşıyan içe aktarılan tüneller. Bölünmüş içe aktarılan tünel hiç
// kullanılmaz: paketler evin dış adresine ulaşamaz, test yanlışlıkla "ulaşılamıyor" derdi. imported: arayüz → interneti taşıyor mu.
export function orderProbeTunnels<T extends { iface: string }>(tunnels: T[], imported: Map<string, boolean>): T[] {
  return [...tunnels.filter(t => !imported.has(t.iface)), ...tunnels.filter(t => imported.get(t.iface) === true)];
}

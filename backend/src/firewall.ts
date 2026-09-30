// Güvenlik duvarı (nftables, inet pi5_filter) — panelin özel kuralları: doğrulama, nft satırı, kilitlenme denetimi.
// Özel kurallar input zincirinde sabit izinlerden (SSH, DNS, panel …) ÖNCE değerlendirilir: "engelle" kuralı gerçekten
// engeller. Bu yüzden kuralı ekleyen cihazın panele erişimini kesecek kural reddedilir (panelBlockFor).
// Kural türleri: tcp / udp (Pi'nin o portu, herkes için) ve ip (kaynak adres; port boşsa o cihazın Pi'ye tüm erişimi,
// doluysa yalnız o port — ör. misafir cihaz panel/SSH'a giremez ama DNS'i sürer).

export type FwAction = 'accept' | 'drop' | 'reject';
export type FwProto = '' | 'tcp' | 'udp' | 'both';
export interface FwRule { id?: number; type: 'tcp' | 'udp' | 'ip'; target: string; port: string; proto: FwProto; action: FwAction; enabled: number }

export const PANEL_PORT = 80; // nginx → backend (127.0.0.1:3001)
export const SSH_PORT = 22;

const ACTIONS = new Set(['accept', 'drop', 'reject']);
// Yalnız standart yazım: baştaki sıfır yok ("012" nft'de sekizlik okunabilir, "/00" "herkesi" denetiminden kaçardı).
const octet = (s: string) => /^(0|[1-9]\d{0,2})$/.test(s) && Number(s) <= 255;
export function isIpv4Cidr(s: string): boolean {
  const [ip, pfx, ...rest] = s.split('/');
  if (rest.length) return false;
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every(octet)) return false;
  return pfx === undefined || (/^(0|[1-9]\d?)$/.test(pfx) && Number(pfx) <= 32);
}
const isPort = (s: string) => /^[1-9]\d{0,4}$/.test(s) && Number(s) <= 65535;

// Kullanıcı girdisi → doğrulanmış kural ya da Türkçe hata.
export function validateFwRule(input: any): { rule: FwRule } | { error: string } {
  const type = String(input?.type || '').toLowerCase();
  const action = String(input?.action || '').toLowerCase();
  const target = String(input?.target ?? '').trim();
  const port = String(input?.port ?? '').trim();
  let proto = String(input?.proto ?? '').toLowerCase() as FwProto;
  if (!ACTIONS.has(action)) return { error: 'Eylem izin ver / düşür / reddet olmalı' };
  if (type === 'tcp' || type === 'udp') {
    if (!isPort(target)) return { error: 'Port 1-65535 arası bir sayı olmalı' };
    return { rule: { type, target: String(Number(target)), port: '', proto: '', action: action as FwAction, enabled: 1 } };
  }
  if (type !== 'ip') return { error: 'Tür TCP port, UDP port ya da kaynak IP olmalı' };
  if (!isIpv4Cidr(target)) return { error: 'Geçerli bir IPv4 ya da IPv4/önek girin (ör. 192.168.1.50 veya 192.168.1.0/24)' };
  if (port) {
    if (!isPort(port)) return { error: 'Port 1-65535 arası bir sayı olmalı' };
    if (!['tcp', 'udp', 'both'].includes(proto)) proto = 'tcp';
  } else {
    proto = '';
  }
  return { rule: { type: 'ip', target, port: port ? String(Number(port)) : '', proto, action: action as FwAction, enabled: 1 } };
}

// DB satırı → nft satırı (yalnız doğrulamadan geçen, etkin kurallar). Satırlar DB'den okunurken de yeniden doğrulanır.
export function fwRuleToNft(row: any): string | null {
  if (row && Number(row.enabled ?? 1) === 0) return null;
  const v = validateFwRule(row);
  if ('error' in v) return null;
  const r = v.rule;
  if (r.type !== 'ip') return `${r.type} dport ${r.target} ${r.action}`;
  if (!r.port) return `ip saddr ${r.target} ${r.action}`;
  if (r.proto === 'both') return `ip saddr ${r.target} meta l4proto { tcp, udp } th dport ${r.port} ${r.action}`;
  return `ip saddr ${r.target} ${r.proto} dport ${r.port} ${r.action}`;
}

const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
export function ipv4InCidr(ip: string, cidr: string): boolean {
  if (!isIpv4Cidr(ip) || ip.includes('/') || !isIpv4Cidr(cidr)) return false;
  const [net, pfx] = cidr.split('/');
  const bits = pfx === undefined ? 32 : Number(pfx);
  if (bits === 0) return true;
  const div = 2 ** (32 - bits);
  return Math.floor(ipNum(ip) / div) === Math.floor(ipNum(net) / div);
}

// Kaynak `src`'den TCP `port`'a gelen yeni bağlantıya ilk eşleşen etkin özel kural (sırayla). null = özel kural yok
// (sabit izinler karar verir: 22 ve 80 açık).
export function firstTcpMatch(rows: any[], src: string, port: number): FwRule | null {
  for (const row of rows) {
    if (Number(row?.enabled ?? 1) === 0) continue;
    const v = validateFwRule(row);
    if ('error' in v) continue;
    const r = v.rule;
    if (r.type === 'tcp' && Number(r.target) === port) return r;
    if (r.type === 'ip' && ipv4InCidr(src, r.target) && (!r.port || (Number(r.port) === port && r.proto !== 'udp'))) return r;
  }
  return null;
}
const blocks = (r: FwRule | null) => !!r && r.action !== 'accept';
export const describeRule = (r: FwRule) =>
  r.type === 'ip' ? `${r.target}${r.port ? ` → ${r.proto === 'both' ? 'TCP/UDP' : r.proto.toUpperCase()} ${r.port}` : ' (tüm erişim)'}` : `${r.type.toUpperCase()} ${r.target}`;

// Kural Pi'nin panel portuna (TCP 80) yeni bağlantıyı engelliyor mu (kaynaktan bağımsız)?
function blocksPanelPort(r: FwRule): boolean {
  if (r.action === 'accept') return false;
  if (r.type === 'tcp') return Number(r.target) === PANEL_PORT;
  if (r.type === 'ip') return !r.port || (Number(r.port) === PANEL_PORT && r.proto !== 'udp');
  return false;
}
// Kaynak IP kuralı Pi'nin ev ağının TAMAMINI panelden kesiyor mu (ör. 192.168.1.0/24 düşür)? Kimden gelirse gelsin (IPv6
// ile bağlanan yönetici, Ev VPN'i) kabul edilmez; eskiden kaydedilmişse uygulanmaz.
export function blocksWholeLan(row: any, lanNets: string[]): boolean {
  const v = validateFwRule(row);
  if ('error' in v || v.rule.type !== 'ip' || !blocksPanelPort(v.rule)) return false;
  const bits = (c: string) => Number(c.split('/')[1] ?? 32);
  return lanNets.some(n => isIpv4Cidr(n) && bits(v.rule.target) <= bits(n) && ipv4InCidr(n.split('/')[0], v.rule.target));
}

// Panele (80) HERKESİN erişimini kesen kural (TCP 80'i engelle ya da 0.0.0.0/0'ı tümden / 80'de engelle): hiç eklenmez,
// eskiden kaydedilmişse uygulanmaz — panel ve kurtarma yolu kapanırdı. SSH'ı kapatmak serbest (panelin terminali kalır).
export function isPanelLockoutForAll(row: any): boolean {
  const v = validateFwRule(row);
  if ('error' in v) return false;
  const r = v.rule;
  if (r.action === 'accept') return false;
  if (r.type === 'tcp') return Number(r.target) === PANEL_PORT;
  if (r.type === 'ip') return /\/0$/.test(r.target) && (!r.port || (Number(r.port) === PANEL_PORT && r.proto !== 'udp'));
  return false;
}

// Kurallar uygulanınca `src` panele (80) / SSH'a (22) yeni bağlantı açabilecek mi? src IPv4 değilse (loopback, IPv6,
// bilinmiyor) denetlenmez — Pi'nin kendisi (iif lo) her zaman geçer.
export function accessCheck(rows: any[], src: string): { panel: FwRule | null; ssh: FwRule | null } {
  if (!src || !isIpv4Cidr(src) || src.includes('/') || src.startsWith('127.')) return { panel: null, ssh: null };
  const p = firstTcpMatch(rows, src, PANEL_PORT);
  const s = firstTcpMatch(rows, src, SSH_PORT);
  return { panel: blocks(p) ? p : null, ssh: blocks(s) ? s : null };
}

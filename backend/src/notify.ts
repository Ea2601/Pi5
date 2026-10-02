// Dış bildirim (G2.1): olay geçmişindeki (alerts) uyarıları kullanıcının KENDİ Telegram botuna, Discord kanalına ya da
// webhook adresine iletir. Klyrix'e hiçbir şey gitmez; yalnız kullanıcının açtığı kanala, açıkça açılınca.
//  - Varsayılan KAPALI: kanal yokken (ya da hepsi kapalıyken) zamanlayıcı kurulmaz, dışarı istek gitmez, dosya yazılmaz.
//  - Kanallar /etc/pi5-gateway/notify/channels.json (0600, notifyStore.ts) — app_settings'e asla. Yanıtlarda gizli alanlar
//    maskeli (DDNS_MASK deseni); düzenleme formu maskeyi geri gönderirse "değişmedi" sayılır.
//  - Gönderici alerts tablosunu id imleciyle okur (10 sn): sağlık denetimi ve VPS tüneli uyarıları recordEvent'i atlayıp
//    doğrudan yazdığı için kanca events.ts'e değil buraya. Kanal başına imleç state.json'da; kanal açılınca MAX(id) — geçmiş
//    gönderilmez. İmleç yalnız başarılı gönderimden sonra ilerler (en az bir kez; yeniden başlatmada en çok bir yineleme).
//  - Süzgeç: önem eşiği (varsayılan 'warning') + kaynak kuralları. Varsayılanda önemden bağımsız gidenler: yeni cihaz,
//    hat kalitesi (kesildi / geri geldi), yedek hat geçişi, yeni takılan ağ kartı; 5 dk'lık tek ping 'network' süzülür;
//    'notify' (bu modülün kendi olayları) asla gönderilmez — döngü olmaz.
//  - Aynı kaynak + önem 10 dk'da bir (arada gelenler birleştirilip pencere dolunca tek satır); birikim 20'yi aşarsa tek özet;
//    hat kesintisi ('wan-monitor' uyarısı) 2 dk içinde iletilemezse atlanır (dönüş olayı gider); isteğe bağlı sessiz saatler
//    (yalnız kritik geçer, biten pencerede tek özet). Aynı ana hat olayı iki kaynaktan ('netmode-bak' + 'wan-monitor') 2 dk
//    içinde gelirse Telegram / Discord'a tek bildirim gider (webhook her kaydı alır).
//  - Webhook'ta her kayıt ayrı POST: gönderilecekler önce durum dosyasına yazılır, her başarılı gönderimde biri düşer
//    (yarıda kalan tur başarılı olanları yinelemez); 4xx (408 / 429 dışı) ya da yönlendirme o kayıt için kalıcı ret sayılır —
//    kayıt atlanır, kuyruk kilitlenmez.
//  - Gönderim Node'un yerleşik http/https'i ile süreç içinde (token argv / env / günlüğe girmez); hata metinleri redakte.
//    SSRF: bağlanırken çözülen adres denetlenir (loopback, link-local, 0.0.0.0, çoklu yayın, Pi'nin kendi adresleri red;
//    ev ağı adresi yalnız kanalda açık onayla); yönlendirme izlenmez; 10 sn zaman aşımı.
//  - Çıkış yolu için yeni mekanizma yok: istek Pi'nin kendi trafiği gibi çıkar (yönlendirme kuralı / yedek hat).
//  - Uyduda kapalı (uçlar 409, açılış '!isSatellite'); HA'da yalnız MASTER (notifyStore notifyMayRun).
import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import type express from 'express';
import { dbAll, dbGet, dbRun, dbTimeMs } from './db';
import { recordEvent, recordEventOnce, serviceLabel } from './events';
import { isSatellite } from './role';
import { isLinux } from './system';
import { notifyConfig, saveNotifyConfig, notifyState, saveNotifyState, notifyMayRun, testEnv,
  type ChState, type Held, type OutItem, type Severity } from './notifyStore';
import { setDeviceWatch, deviceWatchRunning } from './deviceWatch';

export type ChannelKind = 'telegram' | 'discord' | 'webhook';
export type SourceRule = 'always' | 'never';
export interface Channel {
  id: string; kind: ChannelKind; name: string; enabled: boolean;
  minSeverity: Severity;
  // 'always' önemden bağımsız gönderilir, 'never' hiç; listede olmayan kaynak önem eşiğine göre.
  sources: Record<string, SourceRule>;
  quiet: { enabled: boolean; start: string; end: string }; // 'HH:MM', Pi'nin saat dilimi
  content: 'short' | 'full';
  allowPrivate: boolean; // yalnız webhook: ev ağındaki hedef (ör. Home Assistant) için açık onay
  botToken?: string; chatId?: string; webhookUrl?: string; url?: string; hmacSecret?: string;
  created: string;
}

// ─── Kaynak adları (eşi: frontend/src/alerts.ts SOURCE_LABEL) ───
export const SOURCE_LABEL: Record<string, string> = {
  cpu: 'İşlemci', memory: 'Bellek', disk: 'Disk', dns: 'DNS', network: 'İnternet', dhcp: 'DHCP', 'dhcp-rogue': 'DHCP',
  'dhcp-probe': 'DHCP', netmode: 'Ağ modu', 'netmode-ap': 'Ağ modu', 'netmode-missing': 'Ağ modu', service: 'Servis', update: 'Güncelleme',
  unbound: 'Unbound', zapret: 'Zapret', pihole: 'Pi-hole', vps: 'VPS', device: 'Cihaz', cron: 'Cron', vpn: 'Ev VPN',
  mesh: 'Mesh', storage: 'Depolama', bandwidth: 'Bant genişliği', backup: 'Yedekleme', vault: 'Yedekleme',
  sync: 'Cihaz yedekleme', visits: 'Ziyaret Geçmişi', hotplug: 'Ağ kartı',
  'netmode-bak': 'Yedek hat', 'netmode-bak-health': 'Yedek hat', 'netmode-wan': 'İnternet kartı', 'netmode-rep': 'Wi-Fi köprüsü',
  'netmode-home': "Ev Wi-Fi'ı", firewall: 'Güvenlik duvarı', fail2ban: 'Fail2Ban', 'routing-list': 'Yönlendirme listesi',
  'vps-tunnel': 'VPS tüneli', 'device-new': 'Yeni cihaz', 'wan-monitor': 'Hat kalitesi', notify: 'Dış bildirim',
  pcap: 'Paket kaydı', geo: 'Geo-IP',
};
const head = (source: string) => String(source || '').split(':')[0];
export const sourceLabel = (s: string) => SOURCE_LABEL[head(s)] || s || 'Sistem';

// Kaynak süzgecinde seçilebilenler ('notify' yok: hiç gönderilmez).
export const FILTER_SOURCES: [string, string][] = [
  ['device-new', 'Yeni cihaz bağlandı'], ['wan-monitor', 'Hat kalitesi (kesildi / geri geldi)'], ['netmode-bak', 'Yedek hat geçişi'],
  ['hotplug', 'Yeni ağ kartı takıldı'], ['network', "İnternet (5 dk'lık tek ping denetimi)"], ['service', 'Servis çöktü / durdu'],
  ['vps-tunnel', 'VPS tüneli yanıt vermiyor'], ['netmode-bak-health', 'Yedek hat sağlığı'], ['netmode-wan', 'İnternet kartı'],
  ['netmode-rep', 'Wi-Fi köprüsü'], ['netmode-home', "Ev Wi-Fi'ı"], ['netmode', 'Ağ modu'], ['dns', 'DNS'], ['dhcp', 'DHCP'],
  ['dhcp-rogue', 'Başka DHCP sunucusu'], ['cpu', 'İşlemci sıcaklığı'], ['memory', 'Bellek'], ['disk', 'Disk'],
  ['update', 'Panel güncellemesi'], ['vps', 'VPS'], ['vpn', 'Ev VPN'], ['mesh', 'Mesh / uydular'], ['bandwidth', 'Kota ve hız sınırı'],
  ['fail2ban', 'Fail2Ban'], ['firewall', 'Güvenlik duvarı'], ['pihole', 'Pi-hole'], ['unbound', 'Unbound'], ['zapret', 'Zapret'],
  ['storage', 'Depolama'], ['vault', 'Bulut yedeği'], ['sync', 'Cihaz yedekleme'], ['backup', 'Yedekleme'], ['device', 'Cihaz'],
  ['cron', 'Cron görevleri'], ['routing-list', 'Yönlendirme listesi'], ['visits', 'Ziyaret Geçmişi'], ['pcap', 'Paket kaydı'], ['geo', 'Geo-IP'],
];
const FILTER_IDS = new Set(FILTER_SOURCES.map(([id]) => id));
export const DEFAULT_SOURCES: Record<string, SourceRule> = {
  'device-new': 'always', 'wan-monitor': 'always', 'netmode-bak': 'always', hotplug: 'always', network: 'never',
};

export const NOTIFY_MASK = '••••••••';
const KINDS: ChannelKind[] = ['telegram', 'discord', 'webhook'];
export const KIND_LABEL: Record<ChannelKind, string> = { telegram: 'Telegram', discord: 'Discord', webhook: 'Webhook' };
const SEVERITIES: Severity[] = ['info', 'warning', 'critical'];
const SEV_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const SEV_LABEL: Record<Severity, string> = { critical: 'Kritik', warning: 'Uyarı', info: 'Bilgi' };
const normSev = (s: unknown): Severity => (SEVERITIES.includes(s as Severity) ? s as Severity : 'info');
const MAX_CHANNELS = 10;
const ID_RE = /^[0-9a-f]{8}$/;
const TG_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const TG_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);
const DISCORD_PATH = /^\/api\/webhooks\/(\d{5,25})\/[A-Za-z0-9_-]{20,128}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const BAD_TEXT = /[\x00-\x1f\x7f]/;

// ─── Adres sınıflandırma (SSRF) ───
export type AddrClass = 'public' | 'private' | 'loopback' | 'linklocal' | 'unspecified' | 'multicast' | 'reserved';
const v4num = (ip: string) => ip.split('.').reduce((a, o) => ((a << 8) | (Number(o) & 255)) >>> 0, 0);
const V4_RANGES: [string, number, AddrClass][] = [
  ['0.0.0.0', 8, 'unspecified'], ['127.0.0.0', 8, 'loopback'], ['169.254.0.0', 16, 'linklocal'], ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], // 255.255.255.255 dahil
  ['10.0.0.0', 8, 'private'], ['172.16.0.0', 12, 'private'], ['192.168.0.0', 16, 'private'],
  ['100.64.0.0', 10, 'private'], // operatör NAT'ı / Tailscale
  ['198.18.0.0', 15, 'private'], // Pi'nin uygulama ağı (plan 0.3)
  ['192.0.0.0', 24, 'reserved'], ['192.0.2.0', 24, 'reserved'], ['198.51.100.0', 24, 'reserved'], ['203.0.113.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
];
function classify4(ip: string): AddrClass {
  const n = v4num(ip);
  for (const [net4, bits, cls] of V4_RANGES) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((n & mask) >>> 0) === ((v4num(net4) & mask) >>> 0)) return cls;
  }
  return 'public';
}
// IPv6 → 8 adet 16 bitlik grup (gömülü IPv4 sonda olabilir). Geçersizse null.
function v6groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (net.isIPv4(m[2]) === false) return null;
    const n = v4num(m[2]);
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (parts.length === 1 && left.length !== 8)) return null;
  const g = [...left, ...Array(fill).fill('0'), ...right].map(x => parseInt(x, 16));
  return g.length === 8 && g.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}
const emb = (a: number, b: number) => `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;
const isMapped = (g: number[]) => g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff; // ::ffff:a.b.c.d
function classify6(ip: string): AddrClass {
  const g = v6groups(ip);
  if (!g) return 'reserved';
  if (g.every(x => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return 'loopback';
  if (isMapped(g)) return classify4(emb(g[6], g[7]));
  if (g.slice(0, 6).every(x => x === 0)) return 'reserved'; // ::a.b.c.d (eski biçim)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return classify4(emb(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return classify4(emb(g[1], g[2])); // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return 'linklocal';
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; // ULA
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return 'reserved'; // belge / Teredo
  if ((g[0] & 0xe000) === 0x2000) return 'public';
  return 'reserved';
}
export function classifyIp(ip: string): AddrClass {
  const v = net.isIP(ip);
  return v === 4 ? classify4(ip) : v === 6 ? classify6(ip) : 'reserved';
}
// Karşılaştırma biçimi: IPv4 noktalı; IPv4-eşlemeli IPv6 (::ffff:a.b.c.d — URL bunu ::ffff:c0a8:99 diye onaltılık yazar)
// gömülü IPv4; diğer IPv6 sıkıştırmasız 8 grup (yazım farkı eşleşmeyi bozmasın).
export function canonIp(ip: string): string {
  const a = String(ip).toLowerCase().split('%')[0].replace(/^\[(.*)\]$/, '$1');
  if (net.isIPv4(a)) return a;
  const g = v6groups(a);
  if (!g) return a;
  return isMapped(g) ? emb(g[6], g[7]) : g.map(x => x.toString(16)).join(':');
}
// NAT64 (64:ff9b::/96) ve 6to4 (2002::/16) adresinin içindeki IPv4 (Pi'nin kendi adresi gömülü olabilir).
function embeddedV4(ip: string): string {
  const g = v6groups(ip);
  if (!g) return '';
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return emb(g[6], g[7]);
  if (g[0] === 0x2002) return emb(g[1], g[2]);
  return '';
}
// Çekirdeğin yerel adresleri: os.networkInterfaces() yalnız çalışan (UP + RUNNING) kartları döndürür; kablosu çıkmış ya da
// taşıyıcısız (boş köprü, veth) karttaki adres yine Pi'nin kendisidir. /proc/net/fib_trie '/32 host LOCAL' + if_inet6.
function procLocalAddrs(): string[] {
  if (!isLinux) return [];
  const out: string[] = [];
  try {
    let leaf = '';
    for (const line of fs.readFileSync('/proc/net/fib_trie', 'utf8').split('\n')) {
      const m = /([|+])--\s+(\S+)/.exec(line); // "|-- 10.0.0.1" yaprak, "+-- 10.0.0.0/24 …" ara düğüm
      if (m) { leaf = m[1] === '|' && net.isIPv4(m[2]) ? m[2] : ''; continue; }
      if (leaf && /^\s+\/32 host LOCAL/.test(line)) out.push(leaf);
    }
  } catch { /* /proc yok */ }
  try {
    for (const line of fs.readFileSync('/proc/net/if_inet6', 'utf8').split('\n')) {
      const hex = line.trim().split(/\s+/)[0] || '';
      if (/^[0-9a-f]{32}$/i.test(hex)) out.push((hex.match(/.{4}/g) as string[]).join(':'));
    }
  } catch { /* IPv6 kapalı */ }
  return out;
}
// Pi'nin kendi adresleri (tüm kartlar, IPv4 + IPv6; canonIp biçiminde). Kısa önbellek: gönderim başına /proc okunmasın.
let ownCache: { at: number; set: Set<string> } | null = null;
export function ownAddresses(): Set<string> {
  if (ownCache && Date.now() - ownCache.at < 5000) return ownCache.set;
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) out.add(canonIp(a.address));
  for (const a of procLocalAddrs()) out.add(canonIp(a));
  ownCache = { at: Date.now(), set: out };
  return out;
}
// Boş = izinli; değilse ret nedeni. needPrivate: http ile yalnız ev ağındaki hedefe gidilir. own: canonIp biçiminde.
export function addrVerdict(ip: string, allowPrivate: boolean, own: Set<string>, needPrivate = false): string {
  const a = canonIp(ip);
  const cls = classifyIp(a);
  if (cls === 'loopback') return `Hedef Pi'nin kendisi (${ip}) — güvenlik için reddedildi`;
  const inner = embeddedV4(a);
  if (own.has(a) || (inner && own.has(inner))) return `Hedef Pi'nin kendi adresi (${ip}) — güvenlik için reddedildi`;
  switch (cls) {
    case 'linklocal': return `Yerel bağlantı adresi (${ip}) — reddedildi`;
    case 'unspecified': return `Geçersiz hedef adresi (${ip})`;
    case 'multicast': return `Çoklu yayın adresi (${ip}) — reddedildi`;
    case 'reserved': return `Ayrılmış adres (${ip}) — reddedildi`;
    case 'private': return allowPrivate ? '' : `Hedef ev ağında (${ip}) — ev ağına göndermek için kanalda "Ev ağındaki hedefe izin ver" onayı gerekir`;
    default: return needPrivate ? 'İnternetteki hedefe yalnız https ile gönderilir' : '';
  }
}
// Bağlantı anındaki ad çözümü: çözülen adreslerden biri bile yasaksa bağlanılmaz (DNS rebinding dahil).
function guardedLookup(allowPrivate: boolean, own: Set<string>, needPrivate: boolean): net.LookupFunction {
  return ((hostname: string, options: any, callback: any) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, { all: true, verbatim: true, family: options?.family || 0, hints: options?.hints }, (err, addrs) => {
      if (err) return callback(err);
      const list = addrs as dns.LookupAddress[];
      if (!list.length) return callback(Object.assign(new Error(`Ad çözülemedi: ${hostname}`), { code: 'ENOTFOUND' }));
      for (const a of list) {
        const why = addrVerdict(a.address, allowPrivate, own, needPrivate);
        if (why) return callback(Object.assign(new Error(why), { code: 'EKLXBLOCKED' }));
      }
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  }) as net.LookupFunction;
}

// ─── Kanal doğrulama ve maskeleme ───
type Valid = { ch: Channel; error?: undefined } | { ch?: undefined; error: string };
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

// Webhook adresi: http yalnız ev ağındaki hedefe (açık onayla); kullanıcı:parola ve localhost yok. Adres sabitse burada da
// denetlenir (asıl denetim bağlanırken). Döner: hata metni ya da boş.
export function checkWebhookUrl(raw: string, allowPrivate: boolean, own: Set<string> | null): string {
  if (!raw || raw.length > 500 || /\s/.test(raw) || BAD_TEXT.test(raw)) return 'Webhook adresi geçersiz (en çok 500 karakter, boşluksuz)';
  let u: URL;
  try { u = new URL(raw); } catch { return 'Webhook adresi geçersiz'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Webhook adresi http:// ya da https:// ile başlamalı';
  if (u.username || u.password) return 'Adreste kullanıcı adı / parola desteklenmiyor';
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return "Hedef Pi'nin kendisi olamaz";
  const needPrivate = u.protocol === 'http:';
  if (needPrivate && !allowPrivate) return 'İnternetteki hedefe yalnız https ile gönderilir — ev ağındaki (http) hedef için "Ev ağındaki hedefe izin ver" onayını açın';
  if (own && net.isIP(host)) return addrVerdict(host, allowPrivate, own, needPrivate);
  return '';
}

// input: istek gövdesi ya da saklı kanal; existing: güncellenen kanal (maskeli alan = değişmedi). stored: dosyadan okuma
// (adres denetimi bağlanırken yapılır — Pi'nin adresi değişti diye saklı kanal düşmesin).
export function validateChannel(input: any, existing: Channel | null, stored = false): Valid {
  if (!input || typeof input !== 'object') return { error: 'Geçersiz istek gövdesi' };
  const kind = (existing?.kind || input.kind) as ChannelKind;
  if (!KINDS.includes(kind)) return { error: 'Kanal türü telegram, discord ya da webhook olmalı' };
  if (existing && input.kind !== undefined && input.kind !== existing.kind) return { error: 'Kanal türü değiştirilemez — yeni kanal ekleyin' };
  const name = str(input.name ?? existing?.name ?? KIND_LABEL[kind]).trim();
  if (!name || [...name].length > 40 || /[\x00-\x1f\x7f<>]/.test(name)) return { error: 'Ad 1-40 karakter olmalı (< > olmadan)' };
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') return { error: "'enabled' true ya da false olmalı" };
  const minSeverity = input.minSeverity ?? existing?.minSeverity ?? 'warning';
  if (!SEVERITIES.includes(minSeverity)) return { error: 'Önem eşiği info, warning ya da critical olmalı' };
  const content = input.content ?? existing?.content ?? 'short';
  if (content !== 'short' && content !== 'full') return { error: "İçerik kipi 'short' ya da 'full' olmalı" };
  let sources: Record<string, SourceRule> = existing?.sources || { ...DEFAULT_SOURCES };
  if (input.sources !== undefined) {
    if (!input.sources || typeof input.sources !== 'object' || Array.isArray(input.sources)) return { error: 'Kaynak süzgeci geçersiz' };
    sources = {};
    for (const [k, v] of Object.entries(input.sources)) {
      if (k === 'notify') return { error: "'notify' kaynağı dışarı gönderilmez" };
      if (!FILTER_IDS.has(k)) return { error: `Bilinmeyen kaynak: ${k.slice(0, 40)}` };
      if (v !== 'always' && v !== 'never') return { error: `Kaynak kuralı 'always' ya da 'never' olmalı: ${k}` };
      sources[k] = v;
    }
  }
  let quiet = existing?.quiet || { enabled: false, start: '23:00', end: '07:00' };
  if (input.quiet !== undefined) {
    const q = input.quiet;
    if (!q || typeof q !== 'object' || typeof q.enabled !== 'boolean' || !HHMM.test(str(q.start)) || !HHMM.test(str(q.end))) {
      return { error: 'Sessiz saatler: enabled ve SS:DD biçiminde başlangıç / bitiş gerekli' };
    }
    if (q.enabled && q.start === q.end) return { error: 'Sessiz saatlerin başlangıcı ve bitişi aynı olamaz' };
    quiet = { enabled: q.enabled, start: q.start, end: q.end };
  }
  const allowPrivate = kind === 'webhook' ? (input.allowPrivate ?? existing?.allowPrivate ?? false) : false;
  if (typeof allowPrivate !== 'boolean') return { error: "'allowPrivate' true ya da false olmalı" };
  // Gizli alan: gönderilmediyse ya da maskeyse saklı değer.
  const secret = (f: 'botToken' | 'webhookUrl' | 'url'): string | null => {
    const v = input[f];
    if (v === undefined || v === NOTIFY_MASK) return existing?.[f] ?? null;
    return str(v).trim();
  };
  const ch: Channel = {
    id: existing?.id || '', kind, name, enabled, minSeverity, sources, quiet, content, allowPrivate,
    created: existing?.created || (stored && typeof input.created === 'string' ? input.created : new Date().toISOString()),
  };
  if (kind === 'telegram') {
    const botToken = secret('botToken');
    const chatId = str(input.chatId ?? existing?.chatId).trim();
    if (!botToken || !TG_TOKEN.test(botToken)) return { error: "Bot token geçersiz (BotFather'ın verdiği 123456:ABC… biçimi)" };
    if (!TG_CHAT.test(chatId)) return { error: 'Sohbet kimliği geçersiz (sayı, grupta -100… ya da @kanaladı)' };
    Object.assign(ch, { botToken, chatId });
  } else if (kind === 'discord') {
    const webhookUrl = secret('webhookUrl');
    let u: URL | null = null;
    try { u = webhookUrl ? new URL(webhookUrl) : null; } catch { u = null; }
    if (!u || u.protocol !== 'https:' || !DISCORD_HOSTS.has(u.hostname) || u.port || u.username || u.password
      || !DISCORD_PATH.test(u.pathname) || (u.search && !/^\?thread_id=\d{5,25}$/.test(u.search)) || u.hash) {
      return { error: 'Discord webhook adresi geçersiz (https://discord.com/api/webhooks/… biçimi)' };
    }
    ch.webhookUrl = u.toString();
  } else {
    const url = secret('url') || '';
    const why = checkWebhookUrl(url, allowPrivate, stored ? null : ownAddresses());
    if (why) return { error: why };
    const hs = input.hmacSecret === undefined || input.hmacSecret === NOTIFY_MASK ? (existing?.hmacSecret || '') : str(input.hmacSecret);
    if (hs.length > 200 || BAD_TEXT.test(hs)) return { error: 'HMAC sırrı en çok 200 karakter olmalı' };
    ch.url = url;
    if (hs) ch.hmacSecret = hs;
  }
  return { ch };
}

function normalizeStored(x: unknown): Channel | null {
  const id = (x as any)?.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const r = validateChannel(x, null, true);
  return r.ch ? { ...r.ch, id } : null;
}
export const listChannels = (): Channel[] => notifyConfig().channels.map(normalizeStored).filter((c): c is Channel => !!c);
function saveChannels(list: Channel[]): void {
  saveNotifyConfig({ ...notifyConfig(), channels: list });
}

function targetText(ch: Channel): string {
  if (ch.kind === 'telegram') return `Bot ${String(ch.botToken).split(':')[0]} → sohbet ${ch.chatId}`;
  if (ch.kind === 'discord') {
    const m = DISCORD_PATH.exec(new URL(String(ch.webhookUrl)).pathname);
    return `discord.com · webhook …${m ? m[1].slice(-4) : ''}`;
  }
  try {
    const u = new URL(String(ch.url));
    const label = longHostLabel(u);
    return `${u.protocol}//${label ? `${label.slice(0, 4)}…${u.host.slice(label.length)}` : u.host}/…`;
  } catch { return 'webhook'; }
}
// Webhook ana makinesinin uzun ilk etiketi (≥ 8 karakter) sırrın kendisi olabilir (Pipedream eoXXXX.m.pipedream.net).
function longHostLabel(u: URL): string {
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(host) || !host.includes('.')) return '';
  const label = host.split('.')[0];
  return label.length >= 8 ? label : '';
}
// Genel webhook'ta gizli olan adresin kendisi: yol (n8n /webhook/<uuid>, Home Assistant /api/webhook/<id>), uzun yol
// parçaları, sorgu değerleri, uzun ilk ana makine etiketi. Hata metinlerinden de silinir (sunucu yolu geri yansıtabilir).
function webhookSecrets(raw: string): string[] {
  let u: URL;
  try { u = new URL(raw); } catch { return []; }
  const out = [u.pathname];
  for (const seg of u.pathname.split('/')) {
    if (seg.length < 8) continue;
    out.push(seg);
    try { const d = decodeURIComponent(seg); if (d !== seg) out.push(d); } catch { /* bozuk kodlama */ }
  }
  for (const [, v] of u.searchParams) out.push(v);
  const label = longHostLabel(u);
  if (label) out.push(label);
  return out;
}
// Yanıttaki kanal: gizli alanlar maskeli (token, webhook adresi, HMAC sırrı); hedef yalnız ana makine adıyla.
export function publicChannel(ch: Channel) {
  return {
    id: ch.id, kind: ch.kind, name: ch.name, enabled: ch.enabled, minSeverity: ch.minSeverity, sources: ch.sources,
    quiet: ch.quiet, content: ch.content, allowPrivate: ch.allowPrivate, created: ch.created, target: targetText(ch),
    ...(ch.kind === 'telegram' ? { botToken: NOTIFY_MASK, chatId: ch.chatId } : {}),
    ...(ch.kind === 'discord' ? { webhookUrl: NOTIFY_MASK } : {}),
    ...(ch.kind === 'webhook' ? { url: NOTIFY_MASK, hmacSecret: ch.hmacSecret ? NOTIFY_MASK : '', hasHmac: !!ch.hmacSecret } : {}),
  };
}

// ─── Gönderim ───
export interface SendResult { ok: boolean; status: number; error: string; retryAfterMs: number }
const okResult: SendResult = { ok: true, status: 200, error: '', retryAfterMs: 0 };
const fail = (error: string, status = 0, retryAfterMs = 0): SendResult => ({ ok: false, status, error, retryAfterMs });

// Hata metninden gizli değerler: kanalın sırları, Telegram yolundaki token, Discord webhook token'ı, URL'deki token= / şifre.
export function redact(text: string, secrets: string[] = []): string {
  let s = String(text);
  // uzundan kısaya: önce adresin tamamı, sonra yolu, sonra parçaları
  for (const x of [...secrets].sort((a, b) => b.length - a.length)) if (x && x.length >= 6) s = s.split(x).join('***');
  return s
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***')
    .replace(/(\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/g, '$1***')
    .replace(/((?:token|key|password|pass|secret|api_key|apikey|sig)=)[^&\s"']+/gi, '$1***')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi, '$1***')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@');
}

function errText(e: any, host: string): string {
  const code = String(e?.code || '');
  if (code === 'EKLXBLOCKED') return String(e.message);
  if (code === 'EKLXTIMEOUT' || code === 'ETIMEDOUT') return 'Zaman aşımı (10 sn)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Ad çözülemedi: ${host}`;
  if (code === 'ECONNREFUSED') return 'Bağlantı reddedildi';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'Bağlantı koptu';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'Ağa ulaşılamıyor';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'TLS sertifikası doğrulanamadı';
  return String(e?.message || e || 'bilinmeyen hata');
}

// Retry-After: başlık (sn ya da tarih), Discord gövdesi retry_after (sn), Telegram parameters.retry_after (sn).
function retryAfterMs(headers: http.IncomingHttpHeaders, body: any): number {
  const h = String(headers['retry-after'] || '').trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Math.ceil(Number(h) * 1000);
  if (h) { const t = Date.parse(h); if (Number.isFinite(t)) return Math.max(0, t - Date.now()); }
  const v = Number(body?.retry_after ?? body?.parameters?.retry_after);
  return Number.isFinite(v) && v > 0 ? Math.ceil(v * 1000) : 0;
}

// serverText: yanıt gövdesindeki açıklama (Telegram description, Discord message) hata metnine eklenir. Genel webhook'ta
// kapalı: keyfi sunucunun metni adresteki sırrı geri yansıtabilir — yalnız "HTTP <durum>".
export interface PostOpts { allowPrivate: boolean; httpNeedsPrivate: boolean; secrets: string[]; timeoutMs?: number; serverText?: boolean }
export function postJson(rawUrl: string, payload: unknown, headers: Record<string, string>, o: PostOpts): Promise<SendResult> {
  const own = ownAddresses();
  let u: URL;
  try { u = new URL(rawUrl); } catch { return Promise.resolve(fail('Geçersiz adres')); }
  const isHttps = u.protocol === 'https:';
  if (!isHttps && u.protocol !== 'http:') return Promise.resolve(fail('Desteklenmeyen adres türü'));
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  const needPrivate = !isHttps && o.httpNeedsPrivate;
  // Sabit adreste ad çözümü (lookup) hiç çağrılmaz: denetim burada.
  if (net.isIP(host)) {
    const why = addrVerdict(host, o.allowPrivate, own, needPrivate);
    if (why) return Promise.resolve(fail(why));
  }
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise(resolve => {
    let done = false;
    const finish = (r: SendResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const req = (isHttps ? https : http).request({
      protocol: u.protocol, hostname: host, port: u.port || (isHttps ? 443 : 80), path: `${u.pathname}${u.search}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'user-agent': 'Klyrix-Gate', ...headers },
      agent: false, lookup: guardedLookup(o.allowPrivate, own, needPrivate),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { if (size < 8192) { chunks.push(c); size += c.length; } });
      res.on('error', e => finish(fail(redact(errText(e, host), o.secrets))));
      res.on('end', () => {
        const status = res.statusCode || 0;
        const text = Buffer.concat(chunks).toString('utf8').slice(0, 8192);
        let j: any = null;
        try { j = JSON.parse(text); } catch { /* metin */ }
        if (status >= 200 && status < 300) return finish({ ...okResult, status });
        if (status >= 300 && status < 400) return finish(fail(`Yönlendirme izlenmez (HTTP ${status})`, status));
        const desc = o.serverText === false ? ''
          : redact(String(j?.description || j?.message || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200), o.secrets);
        if (status === 429) return finish(fail(`Hız sınırı (HTTP 429)${desc ? `: ${desc}` : ''}`, 429, retryAfterMs(res.headers, j)));
        finish(fail(`HTTP ${status}${desc ? `: ${desc}` : ''}`, status));
      });
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('zaman aşımı'), { code: 'EKLXTIMEOUT' })), o.timeoutMs ?? 10000);
    req.on('error', e => finish(fail(redact(errText(e, host), o.secrets))));
    req.end(body);
  });
}

const channelSecrets = (ch: Channel) => [ch.botToken, ch.webhookUrl, ch.url, ch.hmacSecret, ...(ch.url ? webhookSecrets(ch.url) : [])]
  .filter(Boolean) as string[];
// Yalnız test (NODE_ENV=test): sahte Telegram / Discord sunucusu.
const telegramBase = () => testEnv('KLX_TG_BASE') || 'https://api.telegram.org';
function discordTarget(webhookUrl: string): string {
  const base = testEnv('KLX_DISCORD_BASE');
  if (!base) return webhookUrl;
  const u = new URL(webhookUrl);
  return `${base}${u.pathname}${u.search}`;
}
export const telegramBody = (chatId: string, text: string) => ({ chat_id: chatId, text, disable_web_page_preview: true });
export const discordBody = (text: string) => ({ content: text.slice(0, 2000), allowed_mentions: { parse: [] as string[] } });

function sendText(ch: Channel, text: string): Promise<SendResult> {
  const secrets = channelSecrets(ch);
  if (ch.kind === 'telegram') {
    return postJson(`${telegramBase()}/bot${ch.botToken}/sendMessage`, telegramBody(String(ch.chatId), text.slice(0, 4000)), {},
      { allowPrivate: false, httpNeedsPrivate: false, secrets });
  }
  return postJson(discordTarget(String(ch.webhookUrl)), discordBody(text), {}, { allowPrivate: false, httpNeedsPrivate: false, secrets });
}
export const hmacSignature = (secret: string, raw: string) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
function sendWebhook(ch: Channel, body: Record<string, unknown>): Promise<SendResult> {
  const headers: Record<string, string> = {};
  if (ch.hmacSecret) headers['x-klyrix-signature'] = hmacSignature(ch.hmacSecret, JSON.stringify(body));
  return postJson(String(ch.url), body, headers, { allowPrivate: ch.allowPrivate, httpNeedsPrivate: true, secrets: channelSecrets(ch), serverText: false });
}

// ─── Mesaj biçimi ───
export interface AlertRow { id: number; type?: string; severity: string; message: string; source: string; created_at: string }
export type { OutItem };
const clean = (s: string) => String(s || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/[ \t]+/g, ' ').trim();

// Kısa kip: kaynağa göre sabit cümle — cihaz adı, IP, MAC ya da DHCP'den gelen metin yok (ayrıntı panelde).
export function shortPhrase(source: string, sev: Severity, message: string): string {
  const h = head(source);
  const m = String(message || '');
  switch (h) {
    case 'device-new': {
      const n = /^(?:[^:]*: )?(\d+) yeni cihaz bağlandı/.exec(m);
      return n ? `Ağa ${n[1]} yeni cihaz bağlandı` : 'Ağa yeni bir cihaz bağlandı';
    }
    case 'wan-monitor': { // G2.3 wanMonitor.ts lineEventMessage: "Ana hat …" / "Yedek hat …"
      const line = m.startsWith('Yedek hat') ? 'Yedek hat' : 'Ana hat';
      return sev === 'info' ? `${line} geri geldi` : `${line} kesildi`;
    }
    case 'netmode-bak':
      if (m.startsWith('Ana hat çalışmıyor')) return 'Ana hat çalışmıyor — yedek hatta geçildi';
      if (m.startsWith('Ana hatta dönüldü')) return 'Ana hatta dönüldü';
      if (m.startsWith('Yedek hat geçiş denemesi')) return 'Yedek hat geçiş denemesi başladı';
      return sev === 'info' ? 'Yedek hat bilgisi' : 'Yedek hat sorunu';
    case 'hotplug': return m.startsWith('Yeni ağ kartı') ? 'Yeni ağ kartı takıldı' : sev === 'info' ? 'Ağ kartı bilgisi' : 'Ağ kartı uyarısı';
    case 'network': return sev === 'info' ? 'İnternet bağlantısı aktif' : 'İnternet bağlantısı kesildi';
    case 'service': {
      const [, name, iface] = String(source).split(':');
      if (name === 'wireguard' && iface) return sev === 'info' ? `WireGuard tüneli ${iface} yeniden ayakta` : `WireGuard tüneli ${iface} kapalı`;
      const svc = name ? serviceLabel(name) : 'Bir servis';
      return sev === 'critical' ? `${svc} çöktü` : sev === 'warning' ? `${svc} beklenmedik şekilde durdu` : `${svc} yeniden çalışıyor`;
    }
    case 'vps-tunnel': return sev === 'info' ? 'VPS tüneli yeniden yanıt veriyor' : 'VPS tüneli yanıt vermiyor';
    default: return sev === 'critical' ? 'Yeni kritik kayıt' : sev === 'warning' ? 'Yeni uyarı' : 'Yeni bilgi kaydı';
  }
}
const bodyOf = (ch: Channel, it: OutItem) => (ch.content === 'full' ? clean(it.message).slice(0, 500) : `${shortPhrase(it.source, it.severity, it.message)}.`);
const countNote = (n: number) => (n > 1 ? ` (${n} kayıt)` : '');
const FOOTER = 'Ayrıntı panelde: Bildirimler.';

function summaryLines(it: OutItem, max: number): string[] {
  const lines = (it.lines || []).map(l => `• ${sourceLabel(l.source)} · ${SEV_LABEL[l.severity]}: ${l.n}`);
  return lines.length > max ? [...lines.slice(0, max), `… ve ${lines.length - max} tür daha`] : lines;
}
// Telegram / Discord metni (düz metin; biçimlendirme ayrıştırılmaz). Tek kayıt tek satır başlık + gövde; birden çoğu liste.
export function formatText(ch: Channel, items: OutItem[], host: string, limit: number): string {
  const top = `Klyrix Gate (${clean(host).slice(0, 40) || 'pi'})`;
  const out: string[] = [];
  const events = items.filter(i => i.kind === 'event' || i.kind === 'merged');
  // Aynı kaynak + önem tek satır (son kaydın metni, sayıyla)
  const groups: OutItem[] = [];
  for (const it of events) {
    const g = groups.find(x => x.kind === it.kind && x.source === it.source && x.severity === it.severity);
    if (g) { g.count += it.count; g.message = it.message; g.alertId = it.alertId; } else groups.push({ ...it });
  }
  const summaries = items.filter(i => i.kind === 'digest' || i.kind === 'quiet');
  for (const s of summaries) {
    out.push(`${top} · ${s.kind === 'quiet' ? `Sessiz saatlerde biriken ${s.count} kayıt` : `Özet: ${s.count} yeni kayıt`}`);
    out.push(...summaryLines(s, 8));
  }
  if (groups.length === 1 && !summaries.length) {
    const g = groups[0];
    out.push(`${top} · ${SEV_LABEL[g.severity]} · ${sourceLabel(g.source)}${g.kind === 'merged' ? '' : countNote(g.count)}`);
    out.push(g.kind === 'merged' ? `Son 10 dk'da ${g.count} kayıt daha. Sonuncusu: ${bodyOf(ch, g)}` : bodyOf(ch, g));
  } else if (groups.length) {
    if (!summaries.length) out.push(`${top} · ${groups.reduce((a, g) => a + g.count, 0)} bildirim`);
    for (const g of groups) {
      out.push(`• ${SEV_LABEL[g.severity]} · ${sourceLabel(g.source)}: ${bodyOf(ch, g)}${g.kind === 'merged' ? ` (son 10 dk'da ${g.count} kayıt daha)` : countNote(g.count)}`);
    }
  }
  if (ch.content === 'short' || summaries.length) out.push(FOOTER);
  let text = out.join('\n');
  if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
  return text;
}

// Webhook gövdesi (sürüm 1). Özet / sessiz saat özeti kaynağı 'summary'. createdAt ISO UTC (db.ts dbTimeMs ile çevrilmiş).
export function webhookBody(ch: Channel, it: OutItem, host: string): Record<string, unknown> {
  const summary = it.kind === 'digest' || it.kind === 'quiet';
  const message = summary
    ? `${it.kind === 'quiet' ? `Sessiz saatlerde biriken ${it.count} kayıt` : `Özet: ${it.count} yeni kayıt`} — ${summaryLines(it, 8).map(l => l.replace(/^• /, '')).join('; ')}`
    : it.kind === 'merged' ? `Son 10 dk'da ${it.count} kayıt daha. Sonuncusu: ${bodyOf(ch, it)}` : bodyOf(ch, it);
  return {
    v: 1, device: host, alertId: it.alertId, severity: it.severity, source: summary ? 'summary' : it.source,
    sourceLabel: summary ? 'Özet' : sourceLabel(it.source), message,
    createdAt: Number.isFinite(it.createdAt) ? new Date(it.createdAt).toISOString() : null,
  };
}

// ─── Süzgeç ve plan (saf) ───
// portWatch.ts hotplugMessage: yalnız yeni kart olayı ('Yeni ağ kartı: …') her zaman gider; aç / kapat olayı eşiğe göre.
export const isNewCardEvent = (source: string, message: string) => head(source) === 'hotplug' && String(message).startsWith('Yeni ağ kartı');
export function eligible(ch: Pick<Channel, 'sources' | 'minSeverity'>, row: Pick<AlertRow, 'source' | 'severity' | 'message'>): boolean {
  const h = head(row.source);
  if (h === 'notify') return false;
  const rule = ch.sources[h];
  if (rule === 'never') return false;
  if (rule === 'always' && (h !== 'hotplug' || isNewCardEvent(h, row.message))) return true;
  return SEV_RANK[normSev(row.severity)] >= SEV_RANK[ch.minSeverity];
}

export const MERGE_MS = 10 * 60 * 1000;
export const DIGEST_AT = 20;
export const OUTAGE_TTL_MS = 2 * 60 * 1000;
const keyOf = (source: string, sev: Severity) => `${source}|${sev}`;
// Hat kesintisi (G2.3): 2 dk içinde iletilemezse eskimiş sayılır, dönüş olayı gider.
const expiring = (source: string, sev: Severity) => head(source) === 'wan-monitor' && sev !== 'info';
const cloneHeld = (m: Record<string, Held>) => Object.fromEntries(Object.entries(m).map(([k, h]) => [k, { ...h }]));
function addHeld(m: Record<string, Held>, k: string, r: AlertRow, sev: Severity, at: number): void {
  const h = m[k];
  if (h) { h.n++; h.lastId = r.id; h.lastMsg = String(r.message).slice(0, 500); h.lastAt = at; }
  else m[k] = { n: 1, source: r.source, severity: sev, lastId: r.id, lastMsg: String(r.message).slice(0, 500), firstAt: at, lastAt: at };
}
// Birleştirme bekleyeni sessiz saat birikimine (aynı anahtar: sayılar toplanır, son kayıt korunur).
function moveHeld(m: Record<string, Held>, k: string, h: Held): void {
  const q = m[k];
  if (!q) { m[k] = { ...h }; return; }
  q.n += h.n;
  if (h.lastId > q.lastId) { q.lastId = h.lastId; q.lastMsg = h.lastMsg; }
  q.firstAt = Math.min(q.firstAt, h.firstAt);
  q.lastAt = Math.max(q.lastAt, h.lastAt);
}
// Aynı ana hat olayı iki kaynaktan düşer (G2.3 hat kalitesi + yedek hat izleyicisi, 1-15 sn arayla). Yedek hattın kendi
// kesintisi ("Yedek hat kesildi") eşlenmez.
export const PAIR_MS = 2 * 60 * 1000;
export function lineEvent(source: string, message: string): 'down' | 'up' | '' {
  const h = head(source);
  const m = String(message || '');
  if (h === 'wan-monitor') return m.startsWith('Ana hat kesildi') ? 'down' : m.startsWith('Ana hat geri geldi') ? 'up' : '';
  if (h === 'netmode-bak') return m.startsWith('Ana hat çalışmıyor') ? 'down' : m.startsWith('Ana hatta dönüldü') ? 'up' : '';
  return '';
}
function summaryItem(kind: 'digest' | 'quiet', parts: { source: string; severity: Severity; n: number; lastId: number; lastAt: number }[]): OutItem {
  const agg = new Map<string, { source: string; severity: Severity; n: number }>();
  for (const p of parts) {
    const k = `${head(p.source)}|${p.severity}`;
    const a = agg.get(k);
    if (a) a.n += p.n; else agg.set(k, { source: head(p.source), severity: p.severity, n: p.n });
  }
  const lines = [...agg.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.n - a.n);
  const sev = parts.reduce<Severity>((s, p) => (SEV_RANK[p.severity] > SEV_RANK[s] ? p.severity : s), 'info');
  return {
    kind, source: 'summary', severity: sev, count: parts.reduce((a, p) => a + p.n, 0), message: '', lines,
    alertId: Math.max(0, ...parts.map(p => p.lastId)), createdAt: Math.max(0, ...parts.map(p => p.lastAt)),
  };
}

// Bir kanalın bu turu: gönderilecekler + gönderim başarılı olursa yazılacak durum. Satırlar imleçten sonrakiler (id sırasıyla).
export function planChannel(ch: Channel, st: ChState, rows: AlertRow[], now: number, quietNow: boolean): { items: OutItem[]; next: ChState; skipped: number } {
  const next: ChState = { cursor: st.cursor, sentAt: { ...st.sentAt }, held: cloneHeld(st.held), quiet: cloneHeld(st.quiet) };
  let skipped = 0;
  // 1) Birleştirme penceresi dolan bekleyenler
  const merged: OutItem[] = [];
  for (const [k, h] of Object.entries(next.held)) {
    if (now - (next.sentAt[k] || 0) < MERGE_MS) continue;
    delete next.held[k];
    if (expiring(h.source, h.severity) && now - h.lastAt > OUTAGE_TTL_MS) { skipped += h.n; continue; }
    // Pencere sessiz saatte doldu: kritik değilse sessiz saat özetine (yalnız kritik geçer)
    if (quietNow && h.severity !== 'critical') { moveHeld(next.quiet, k, h); continue; }
    merged.push({ kind: 'merged', source: h.source, severity: h.severity, count: h.n, message: h.lastMsg, alertId: h.lastId, createdAt: h.lastAt });
  }
  // 2) Sessiz saat bitti: biriken tek özet
  let quietItem: OutItem | null = null;
  if (!quietNow && Object.keys(next.quiet).length) {
    quietItem = summaryItem('quiet', Object.values(next.quiet));
    next.quiet = {};
  }
  // 3) Yeni satırlar
  const fresh: OutItem[] = [];
  for (const r of rows) {
    next.cursor = Math.max(next.cursor, Number(r.id) || 0);
    if (!eligible(ch, r)) continue;
    const sev = normSev(r.severity);
    const t = dbTimeMs(r.created_at);
    const at = Number.isFinite(t) ? t : now;
    if (expiring(r.source, sev) && now - at > OUTAGE_TTL_MS) { skipped++; continue; }
    // Metin kanalı: eşi (öbür kaynaktan aynı yönde ana hat olayı) 2 dk içinde gittiyse bu gitmez. İz anahtarı sentAt'te.
    const dir = ch.kind === 'webhook' ? '' : lineEvent(r.source, String(r.message));
    if (dir) {
      const pairAt = next.sentAt[`line:${dir}:${head(r.source) === 'wan-monitor' ? 'netmode-bak' : 'wan-monitor'}`];
      if (pairAt && Math.abs(at - pairAt) <= PAIR_MS) { skipped++; continue; }
    }
    const k = keyOf(r.source, sev);
    if (quietNow && sev !== 'critical') {
      addHeld(next.quiet, k, r, sev, at);
      if (dir) next.sentAt[`line:${dir}:${head(r.source)}`] = at;
      continue;
    }
    if (now - (st.sentAt[k] || 0) < MERGE_MS) { addHeld(next.held, k, r, sev, at); continue; }
    fresh.push({ kind: 'event', source: r.source, severity: sev, count: 1, message: String(r.message), alertId: Number(r.id), createdAt: at });
    if (dir) next.sentAt[`line:${dir}:${head(r.source)}`] = at;
  }
  // 4) Birikim 20'yi aşarsa tek özet (birleştirilenler de içinde)
  const total = fresh.length + merged.reduce((a, m) => a + m.count, 0);
  let items: OutItem[] = total > DIGEST_AT
    ? [summaryItem('digest', [...fresh, ...merged].map(i => ({ source: i.source, severity: i.severity, n: i.count, lastId: i.alertId, lastAt: i.createdAt })))]
    : [...merged, ...fresh];
  if (quietItem) items = [quietItem, ...items];
  const sentKeys = new Set<string>();
  for (const it of items) {
    if (it.kind === 'event' || it.kind === 'merged') sentKeys.add(keyOf(it.source, it.severity));
  }
  if (total > DIGEST_AT) for (const i of [...fresh, ...merged]) sentKeys.add(keyOf(i.source, i.severity));
  for (const k of sentKeys) next.sentAt[k] = now;
  // Pencere dışına çıkmış ve bekleyeni olmayan kayıtlar atılır (durum dosyası küçük kalır).
  for (const [k, t] of Object.entries(next.sentAt)) if (now - t >= MERGE_MS && !next.held[k]) delete next.sentAt[k];
  return { items, next, skipped };
}

export function inQuiet(q: Channel['quiet'], d: Date): boolean {
  if (!q.enabled) return false;
  const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const m = d.getHours() * 60 + d.getMinutes();
  const s = hm(q.start), e = hm(q.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

// ─── Teslim kaydı (notify_deliveries: 30 gün, yedeğe girmez) ───
let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = dbRun(`CREATE TABLE IF NOT EXISTS notify_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER, channel_id TEXT NOT NULL, ok INTEGER NOT NULL,
      http_status INTEGER, error_redacted TEXT, label TEXT, items INTEGER DEFAULT 1, ts DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).then(() => dbRun('CREATE INDEX IF NOT EXISTS idx_notify_deliveries_ts ON notify_deliveries(ts)'))
      .catch(e => { tablesReady = null; throw e; });
  }
  return tablesReady;
}
function itemsLabel(items: OutItem[]): string {
  if (items.length === 1) {
    const it = items[0];
    if (it.kind === 'digest') return `Özet: ${it.count} kayıt`;
    if (it.kind === 'quiet') return `Sessiz saat özeti: ${it.count} kayıt`;
    return `${sourceLabel(it.source)} · ${SEV_LABEL[it.severity]}${it.count > 1 ? ` (${it.count})` : ''}`;
  }
  return `${items.reduce((a, i) => a + i.count, 0)} kayıt`;
}
async function logDelivery(channelId: string, label: string, alertId: number, count: number, r: SendResult): Promise<void> {
  try {
    await ensureTables();
    await dbRun('INSERT INTO notify_deliveries (alert_id, channel_id, ok, http_status, error_redacted, label, items) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [alertId || null, channelId, r.ok ? 1 : 0, r.status || null, r.ok ? '' : r.error.slice(0, 300), label.slice(0, 120), count]);
  } catch (e: any) {
    console.error('[bildirim] teslim kaydı yazılamadı:', e?.message || e);
  }
}
async function cleanupDeliveries(): Promise<void> {
  if (!tablesReady) return;
  await tablesReady;
  await dbRun("DELETE FROM notify_deliveries WHERE ts < datetime('now', '-30 days')");
}

// ─── Gönderici ───
const TICK_MS = 10000;
const READ_LIMIT = 1000;
const RETRY_MS = [30000, 120000, 600000];
// Kanal başı hız sınırı: Telegram sohbet başına ~1/sn, Discord webhook ~30/dk (sağlayıcıların güncel sınırları doğrulanamadı).
const RATE: Record<ChannelKind, { gapMs: number; perMin: number }> = {
  telegram: { gapMs: 1100, perMin: 20 }, discord: { gapMs: 2100, perMin: 25 }, webhook: { gapMs: 200, perMin: 60 },
};
interface Rt { failures: number; retryAt: number; rateUntil: number; sent: number[]; lastError: string; lastOkAt: number; epoch: number }
const rts = new Map<string, Rt>();
const rtOf = (id: string): Rt => {
  let r = rts.get(id);
  if (!r) { r = { failures: 0, retryAt: 0, rateUntil: 0, sent: [], lastError: '', lastOkAt: 0, epoch: 0 }; rts.set(id, r); }
  return r;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Dakikalık pencerede yer var mı; varsa önceki gönderimden bu yana en az gapMs beklenir. Yoksa pencerenin açılacağı an.
async function pace(rt: Rt, kind: ChannelKind, n: number): Promise<number> {
  const now = Date.now();
  rt.sent = rt.sent.filter(t => now - t < 60000);
  if (rt.sent.length + n > RATE[kind].perMin) return (rt.sent[0] || now) + 60000;
  const last = rt.sent[rt.sent.length - 1] || 0;
  const wait = RATE[kind].gapMs - (now - last);
  if (wait > 0) await sleep(wait);
  return 0;
}

// Metin kanalı (Telegram / Discord): turun bütün kayıtları tek mesajda.
async function deliverText(ch: Channel, items: OutItem[], rt: Rt): Promise<SendResult> {
  const until = await pace(rt, ch.kind, 1);
  if (until) return fail('Kanal hız sınırı (dakikalık üst sınır)', 429, until - Date.now());
  const r = await sendText(ch, formatText(ch, items, os.hostname(), ch.kind === 'discord' ? 2000 : 4000));
  rt.sent.push(Date.now());
  await logDelivery(ch.id, itemsLabel(items), Math.max(0, ...items.map(i => i.alertId)), items.reduce((a, i) => a + i.count, 0), r);
  return r;
}

const okNote = (rt: Rt) => { rt.failures = 0; rt.retryAt = 0; rt.lastError = ''; rt.lastOkAt = Date.now(); };
// Başarısız gönderim: 429 → sağlayıcının beklettiği süre; diğerleri 30 sn / 2 dk / 10 dk sonra, 3. hatada tek 'notify' uyarısı.
async function noteFailure(ch: Channel, rt: Rt, r: SendResult): Promise<void> {
  rt.lastError = r.error;
  if (r.status === 429) {
    rt.rateUntil = Date.now() + Math.min(Math.max(r.retryAfterMs || 60000, 1000), 3600000);
    return;
  }
  rt.failures++;
  rt.retryAt = Date.now() + RETRY_MS[Math.min(rt.failures, RETRY_MS.length) - 1];
  if (rt.failures === 3) {
    await recordEventOnce('notify', `Dış bildirim gönderilemedi: ${ch.name} (${KIND_LABEL[ch.kind]}) — ${r.error}. Yeniden denenecek;`
      + " kanal ayarını Bildirimler → Dış kanallar'dan denetleyin", 'warning', 360);
  }
}
// Webhook'ta kalıcı ret: yönlendirme ya da 4xx (408 zaman aşımı ve 429 hız sınırı dışında) — aynı kayıt yeniden denense de geçmez.
export const permanentReject = (status: number) => status >= 300 && status < 500 && status !== 408 && status !== 429;

// Webhook kuyruğu: baştaki öğe POST edilir; başarılı ya da kalıcı reddedilen öğe kuyruktan düşer ve durum hemen yazılır
// (yeniden başlatmada yalnız o an gönderilmekte olan öğe yinelenebilir). Geçici hatada öğe kuyrukta kalır, sonra yeniden.
async function drainOutbox(ch: Channel, cs: ChState, rt: Rt): Promise<void> {
  const st = notifyState();
  const epoch = rt.epoch;
  const host = os.hostname();
  // Gönderim sürerken kanal kapatıldı / silindi / bağlantısı değişti / yeniden açıldı: bu tur durum yazmaz.
  const live = () => rt.epoch === epoch && st.channels[ch.id] === cs;
  const drop = () => {
    cs.out?.shift();
    if (!cs.out?.length) delete cs.out;
    try { saveNotifyState(); } catch (e: any) { console.error('[bildirim] durum yazılamadı:', e?.message || e); }
  };
  while (cs.out?.length && live()) {
    const it = cs.out[0];
    // Hat kesintisi 2 dk içinde iletilemediyse eskidi (dönüş olayı gider)
    if (expiring(it.source, it.severity) && Date.now() - it.createdAt > OUTAGE_TTL_MS) { drop(); continue; }
    const until = await pace(rt, 'webhook', 1);
    if (!live()) return;
    if (until) { await noteFailure(ch, rt, fail('Kanal hız sınırı (dakikalık üst sınır)', 429, until - Date.now())); return; }
    const r = await sendWebhook(ch, webhookBody(ch, it, host));
    rt.sent.push(Date.now());
    await logDelivery(ch.id, itemsLabel([it]), it.alertId, it.count, r);
    if (!live()) return;
    if (r.ok) { okNote(rt); drop(); continue; }
    if (permanentReject(r.status)) {
      rt.lastError = r.error;
      drop();
      await recordEventOnce('notify', `Dış bildirim reddedildi: ${ch.name} (${KIND_LABEL[ch.kind]}) — ${r.error}. Bu kayıt atlandı;`
        + " adresi Bildirimler → Dış kanallar'dan denetleyin", 'warning', 360);
      continue;
    }
    await noteFailure(ch, rt, r);
    return;
  }
  // Kuyruk geçici hata olmadan boşaldı: ardışık hata sayacı sıfır (eskiyen kesinti sonraki tek hatayı "3." yapmasın)
  if (live() && !cs.out?.length) { rt.failures = 0; rt.retryAt = 0; }
}

const freshState = (cursor: number): ChState => ({ cursor, sentAt: {}, held: {}, quiet: {} });
const maxAlertId = async () => Number((await dbGet('SELECT MAX(id) AS m FROM alerts'))?.m) || 0;

// Kanalın bir turu. Döner: durum değişti mi (dosyaya yazılacak).
async function runChannel(ch: Channel, maxId: number): Promise<boolean> {
  const st = notifyState();
  const rt = rtOf(ch.id);
  const cs = st.channels[ch.id];
  if (!cs) { st.channels[ch.id] = freshState(maxId); return true; } // durum yok (silinmiş dosya): geçmiş gönderilmez
  let dirty = false;
  if (cs.cursor > maxId) { cs.cursor = maxId; dirty = true; } // veritabanı değişti
  const now = Date.now();
  if (rt.retryAt > now || rt.rateUntil > now) return dirty;
  // Webhook: yarım kalan kuyruk önce (yeni kayıtlar kuyruk boşalınca planlanır)
  if (ch.kind === 'webhook' && cs.out?.length) {
    await drainOutbox(ch, cs, rt);
    return dirty;
  }
  const rows = await dbAll('SELECT id, type, severity, message, source, created_at FROM alerts WHERE id > ? ORDER BY id LIMIT ?', [cs.cursor, READ_LIMIT]) as AlertRow[];
  if (!rows.length && !Object.keys(cs.held).length && !Object.keys(cs.quiet).length) return dirty;
  const plan = planChannel(ch, cs, rows, now, inQuiet(ch.quiet, new Date(now)));
  const changed = JSON.stringify(plan.next) !== JSON.stringify(cs);
  if (!plan.items.length) {
    // Gönderilecek kalmadı (başarısız kayıt eskidi ya da sessiz saate geçti): ardışık hata sayacı onunla birlikte sıfır.
    rt.failures = 0; rt.retryAt = 0; rt.lastError = '';
    if (changed) st.channels[ch.id] = plan.next;
    return dirty || changed;
  }
  if (ch.kind === 'webhook') {
    // Önce yazılır, sonra gönderilir: imleç ilerler, gönderilecekler kuyrukta
    const next: ChState = { ...plan.next, out: plan.items };
    st.channels[ch.id] = next;
    try { saveNotifyState(); } catch (e: any) { console.error('[bildirim] durum yazılamadı:', e?.message || e); }
    await drainOutbox(ch, next, rt);
    return true;
  }
  const epoch = rt.epoch;
  const r = await deliverText(ch, plan.items, rt);
  // Gönderim sürerken kanal kapatıldı / silindi / yeniden açıldı: bu turun durumu yazılmaz.
  if (rt.epoch !== epoch || !st.channels[ch.id]) return dirty;
  if (r.ok) {
    st.channels[ch.id] = plan.next;
    okNote(rt);
    return true;
  }
  await noteFailure(ch, rt, r);
  return dirty;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let lastCleanup = 0;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (!notifyMayRun()) return;
    const chans = listChannels().filter(c => c.enabled);
    if (!chans.length) { refreshNotify(); return; }
    const maxId = await maxAlertId();
    let dirty = false;
    for (const ch of chans) {
      try { if (await runChannel(ch, maxId)) dirty = true; } catch (e: any) { console.error(`[bildirim] ${ch.name}:`, e?.message || e); }
    }
    if (dirty) {
      try { saveNotifyState(); } catch (e: any) { console.error('[bildirim] durum yazılamadı:', e?.message || e); }
    }
    if (Date.now() - lastCleanup > 3600000) {
      lastCleanup = Date.now();
      await cleanupDeliveries().catch(() => undefined);
    }
  } finally {
    ticking = false;
  }
}

export const notifyRunning = () => timer !== null;
// Zamanlayıcı yalnız en az bir açık kanal varken (ana cihazda, HA kapısı açıkken) kurulur.
export function refreshNotify(): void {
  const want = !isSatellite() && notifyMayRun() && listChannels().some(c => c.enabled);
  if (want && !timer) {
    timer = setInterval(() => { void tick(); }, TICK_MS);
    timer.unref?.();
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
}
// Açılış (index.ts '!isSatellite'): kanal yoksa hiçbir şey kurulmaz, dosya okunur ama yazılmaz.
export function startNotify(): void { refreshNotify(); }

// Kanal açıldı / eklendi: imleç şimdiki son kayda (geçmiş gönderilmez), bekleyenler ve hata sayacı sıfır.
async function resetChannel(id: string): Promise<void> {
  const st = notifyState();
  st.channels[id] = freshState(await maxAlertId());
  const rt = rtOf(id);
  Object.assign(rt, { failures: 0, retryAt: 0, rateUntil: 0, lastError: '', epoch: rt.epoch + 1 });
  saveNotifyState();
}
// Teslimi etkileyen alanlar (sihirbazdaki test imzasıyla aynı küme).
const CONN_FIELDS = ['botToken', 'chatId', 'webhookUrl', 'url', 'allowPrivate', 'hmacSecret'] as const;
function dropChannelState(id: string): void {
  const st = notifyState();
  if (st.channels[id]) { delete st.channels[id]; saveNotifyState(); }
  const rt = rts.get(id);
  if (rt) rt.epoch++;
  rts.delete(id);
}

// Test mesajı: kanal kaydedilmeden önce de (sihirbaz) gönderilebilir.
export async function sendTest(ch: Channel): Promise<SendResult> {
  const host = os.hostname();
  let r: SendResult;
  if (ch.kind === 'webhook') {
    r = await sendWebhook(ch, {
      v: 1, device: host, alertId: 0, severity: 'info', source: 'test', sourceLabel: 'Test',
      message: 'Klyrix Gate test mesajı — bu kanal çalışıyor', createdAt: new Date().toISOString(),
    });
  } else {
    r = await sendText(ch, `Klyrix Gate (${clean(host).slice(0, 40) || 'pi'}) · Test\nBu kanal çalışıyor: Pi'nin bildirimleri buraya gelecek.`);
  }
  await logDelivery(ch.id || 'taslak', 'Test mesajı', 0, 0, r);
  return r;
}

// Kanal başına gönderim durumu (arayüz): son hata, art arda başarısızlık, hız sınırı.
function channelStatus(id: string) {
  const r = rts.get(id);
  return {
    failures: r?.failures || 0, lastError: r?.lastError || '', lastOkAt: r?.lastOkAt || 0, retryAt: r?.retryAt || 0,
    rateUntil: r?.rateUntil || 0, limited: !!r && r.rateUntil > Date.now(),
  };
}

// Kanal değişikliği tek sırada (iki sekme aynı anda kaydetse dosya ve durum uyumlu kalır).
let op: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = op.then(fn);
  op = p.catch(() => undefined);
  return p;
}

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;
// Uçlar: /api/notify (GET dışı yazma sınırı + netAdminGuard; uyduda tümü 409). Gizli alanlar hiçbir yanıtta dönmez.
export function registerNotifyRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw }): void {
  app.use('/api/notify', (req, res, next) => (req.method === 'GET' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — dış bildirimler ana cihazdadır' });
    deps.guard(req, res, next);
  });

  app.get('/api/notify', (_req, res) => {
    const dw = notifyConfig().deviceWatch;
    res.json({
      supported: true, running: notifyRunning(), maxChannels: MAX_CHANNELS,
      channels: listChannels().map(c => ({ ...publicChannel(c), status: channelStatus(c.id) })),
      deviceWatch: { ...dw, running: deviceWatchRunning(), supported: isLinux },
      sources: FILTER_SOURCES.map(([id, label]) => ({ id, label })), defaultSources: DEFAULT_SOURCES,
    });
  });

  app.get('/api/notify/deliveries', async (req, res) => {
    try {
      const limit = Math.min(Math.max(Math.floor(Number(req.query.limit)) || 50, 1), 200);
      const has = await dbGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notify_deliveries'");
      const rows = has ? await dbAll('SELECT id, alert_id, channel_id, ok, http_status, error_redacted, label, items, ts FROM notify_deliveries ORDER BY id DESC LIMIT ?', [limit]) : [];
      const names = new Map(listChannels().map(c => [c.id, c.name]));
      res.json({ deliveries: (rows as any[]).map(r => ({ ...r, ok: !!r.ok, channel: names.get(r.channel_id) || (r.channel_id === 'taslak' ? 'Taslak (sihirbaz)' : 'silinmiş kanal') })) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/notify/device-watch', async (req, res) => {
    const { enabled, randomMac } = req.body || {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: "'enabled' true ya da false olmalı" });
    if (randomMac !== undefined && randomMac !== 'tag' && randomMac !== 'suppress') return res.status(400).json({ error: "'randomMac' tag ya da suppress olmalı" });
    if (enabled === true && !isLinux) return res.status(409).json({ error: 'Yeni cihaz algılama yalnız Pi üzerinde çalışır' });
    try {
      const before = notifyConfig().deviceWatch;
      const r = await setDeviceWatch({ enabled, randomMac });
      if (r.enabled !== before.enabled) {
        await recordEvent('notify', !r.enabled ? 'Yeni cihaz bildirimi kapatıldı'
          : r.baselinePending ? 'Yeni cihaz bildirimi açıldı (bağlı cihazlar ilk başarılı taramada bilinen sayılacak)'
            : `Yeni cihaz bildirimi açıldı (şu an bağlı ${r.baseline} cihaz bilinen sayıldı)`);
      } else if (r.randomMac !== before.randomMac) {
        await recordEvent('notify', `Yeni cihaz bildirimi: gizli Wi-Fi adresli cihazlar ${r.randomMac === 'suppress' ? 'bildirilmeyecek' : 'etiketle bildirilecek'}`);
      }
      res.json({ success: true, ...r, running: deviceWatchRunning() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Test: taslak (sihirbaz; id verilirse maskeli alanlar o kanaldan) ya da kayıtlı kanal. Tüm cihazda 10 sn'de bir.
  let lastTestAt = 0;
  const testGate = (res: express.Response): boolean => {
    const wait = 10000 - (Date.now() - lastTestAt);
    if (wait > 0) {
      res.status(429).json({ error: `Test mesajı 10 sn'de bir gönderilebilir — ${Math.ceil(wait / 1000)} sn sonra yeniden deneyin`, retryAfter: Math.ceil(wait / 1000) });
      return false;
    }
    lastTestAt = Date.now();
    return true;
  };
  const testReply = (res: express.Response, r: SendResult) =>
    (r.ok ? res.json({ success: true }) : res.status(502).json({ error: r.error || 'Gönderilemedi', status: r.status }));

  app.post('/api/notify/test', async (req, res) => {
    const id = req.body?.id;
    const existing = id === undefined ? null : listChannels().find(c => c.id === id) || null;
    if (id !== undefined && !existing) return res.status(404).json({ error: 'Kanal bulunamadı' });
    const v = validateChannel(req.body, existing);
    if (v.error !== undefined) return res.status(400).json({ error: v.error });
    if (!testGate(res)) return;
    testReply(res, await sendTest({ ...v.ch, id: existing?.id || '' }));
  });

  app.post('/api/notify/:id/test', async (req, res) => {
    const ch = listChannels().find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'Kanal bulunamadı' });
    if (!testGate(res)) return;
    testReply(res, await sendTest(ch));
  });

  app.post('/api/notify', (req, res) => {
    void serial(async () => {
      const list = listChannels();
      if (list.length >= MAX_CHANNELS) return res.status(409).json({ error: `En çok ${MAX_CHANNELS} kanal eklenebilir` });
      if (req.body?.id !== undefined) return res.status(400).json({ error: 'Yeni kanalda id verilmez' });
      const v = validateChannel(req.body, null);
      if (v.error !== undefined) return res.status(400).json({ error: v.error });
      let id = '';
      do { id = crypto.randomBytes(4).toString('hex'); } while (list.some(c => c.id === id));
      const ch = { ...v.ch, id };
      saveChannels([...list, ch]);
      await resetChannel(id);
      refreshNotify();
      await recordEvent('notify', `Dış bildirim kanalı eklendi: ${ch.name} (${KIND_LABEL[ch.kind]})${ch.enabled ? '' : ' — kapalı'}`);
      res.json({ success: true, channel: publicChannel(ch) });
    }).catch((e: any) => res.status(500).json({ error: e?.message || 'Kaydedilemedi' }));
  });

  app.put('/api/notify/:id', (req, res) => {
    void serial(async () => {
      const list = listChannels();
      const existing = list.find(c => c.id === req.params.id);
      if (!existing) return res.status(404).json({ error: 'Kanal bulunamadı' });
      const v = validateChannel(req.body, existing);
      if (v.error !== undefined) return res.status(400).json({ error: v.error });
      const ch = { ...v.ch, id: existing.id };
      saveChannels(list.map(c => (c.id === ch.id ? ch : c)));
      // Yeniden açılan kanal kapalıyken biriken geçmişi göndermez.
      if (ch.enabled && !existing.enabled) await resetChannel(ch.id);
      else if (!ch.enabled) { const rt = rts.get(ch.id); if (rt) rt.epoch++; }
      else if (CONN_FIELDS.some(f => ch[f] !== existing[f])) {
        // Açık kanalın bağlantısı düzeltildi: eski adresin bekleme süresi ve hata sayacı sıfır (imleç ve bekleyenler aynı —
        // geçmiş yeniden gönderilmez, kuyruktakiler yeni adrese gider).
        const rt = rts.get(ch.id);
        if (rt) Object.assign(rt, { failures: 0, retryAt: 0, rateUntil: 0, lastError: '', epoch: rt.epoch + 1 });
      }
      refreshNotify();
      const what = ch.enabled !== existing.enabled ? (ch.enabled ? 'açıldı' : 'kapatıldı') : 'güncellendi';
      await recordEvent('notify', `Dış bildirim kanalı ${what}: ${ch.name} (${KIND_LABEL[ch.kind]})`);
      res.json({ success: true, channel: publicChannel(ch) });
    }).catch((e: any) => res.status(500).json({ error: e?.message || 'Kaydedilemedi' }));
  });

  app.delete('/api/notify/:id', (req, res) => {
    void serial(async () => {
      const list = listChannels();
      const ch = list.find(c => c.id === req.params.id);
      if (!ch) return res.status(404).json({ error: 'Kanal bulunamadı' });
      saveChannels(list.filter(c => c.id !== ch.id));
      dropChannelState(ch.id);
      refreshNotify();
      await recordEvent('notify', `Dış bildirim kanalı silindi: ${ch.name} (${KIND_LABEL[ch.kind]})`);
      res.json({ success: true });
    }).catch((e: any) => res.status(500).json({ error: e?.message || 'Silinemedi' }));
  });
}

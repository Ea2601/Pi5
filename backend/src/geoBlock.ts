// Geo-IP ülke engeli + tehdit istihbaratı IP beslemeleri (G2.4, Güvenlik → Geo-IP / Tehdit).
//  - VARSAYILAN KAPALI: tablo, dosya, zamanlayıcı ve indirme yoktur; `nft list ruleset` bayt bayt aynı kalır. Kapatınca
//    tablo, deneme / kalıcı kural dosyası, sayaçlar ve zamanlayıcılar kalkar; indirilen listeler yalnız önbellekte kalır
//    (yeniden açınca kullanılır). Ayar app_settings 'geo_settings' (JSON) yalnız PUT /api/geo/settings'ten, doğrulamayla
//    yazılır (UI_SETTING_KEYS dışı).
//  - Kendi tablosu `inet pi5_geo`: input + forward, priority filter - 15 (pi5_wgprobe -20 ile -10 grubu arası). Prerouting
//    ve output'a kural YOK: Pi'nin kendi apt / Unbound / VPS tüneli / liste indirmeleri etkilenmez; lo'dan gelen (Pi'nin
//    kendi kendine açtığı) bağlantılar da düşmez. Yalnız `ct state new`.
//    Özel ve ayrılmış adresler (private4: RFC1918, CGNAT, loopback, link-local, çoklu yayın, 0/8 — DHCP keşfi —, 198.18/15
//    konteyner ağı) ve muaflar (allow4: VPS uçları, tünel uçları `wg show all endpoints`, kullanıcı listesi, ek sağlayıcılar)
//    hiç düşmez; Ev VPN portu (UDP 51820) her zaman muaftır. Özel aralıklar, kullanıcı muafları ve adresle kayıtlı VPS'ler
//    veriden de çıkarılır (tünel uçları ve DNS'ten çözülen VPS adresleri değişkendir: yalnız allow4'te, küme yerinde
//    güncellenir — onarım turunda en çok 10 dk'da bir).
//  - Kaynaklar: Spamhaus DROP (+ EDROP varsa) ve FireHOL level1 (anahtarsız); ülke verisi RIPEstat (kayıt tabanlı — IP'nin
//    kayıtlı olduğu ülke, coğrafi konum değil); AbuseIPDB yalnız kullanıcının kendi anahtarıyla (dosyada 0600; argv, env,
//    app_settings ve günlüklere girmez; yanıtlarda maskeli; anahtarlı istek yönlendirilmez). Geri rapor gönderilmez.
//    İndirmeler https (yönlendirme de yalnız https'e), boyut sınırlı; önbellek /var/cache/pi5-gateway/geo/. /8'den geniş
//    önek atlanır (sayısı gösterilir); 0.0.0.0/0 asla.
//  - Boyut kapısı: toplam aralık sayısı profile ve belleğe göre (lite / profil bilinmiyor 40k; standard 1 GB 50k, 2 GB
//    100k, daha büyük ya da bellek bilinmiyor 200k — capFor); aşılırsa uygulanmaz + uyarı.
//  - Deneme: açma ve her ayar değişikliği 5 dk denemedir. Kural /run/pi5-geo/pending.nft'ten yüklenir; ÖNCE systemd-run
//    geri alma zamanlayıcısı (pi5-geo-rollback, panel servisinden bağımsız) kurulur: onaylanmazsa kalıcı dosya varsa ona
//    döner, yoksa tablo silinir (backend çökse de). "Kalıcı yap" → /opt/pi5-gateway/core/pi5-geo.nft (açılışta
//    pi5-gw-restore yükler; /etc/nftables.d dışında: bozuk dosya pi5_filter'ın `nft -c` adımına girmesin). Kapatma anında.
//  - Onarım: açıkken 60 sn'de bir tablo imzası denetlenir (nftables yeniden yüklendiyse geri kurulur); beslemeler saatlik
//    turda bayatsa (12 sa; AbuseIPDB 24 sa) yenilenir. Yedekten geri yüklemede ayar KAPALI yazılır.
//  - Uyduda kapalı (uçlar 409, açılış '!isSatellite'). IPv6 kapsam dışı.
import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type express from 'express';
import { dbAll, dbGet, dbRun } from './db';
import { recordEvent, recordEventOnce } from './events';
import { isSatellite } from './role';
import { readPlatform } from './hardware';
import { WG_PORT } from './wgServer';
import { normalizeCidr } from './ipRanges';

const execFileP = promisify(execFile);
const isLinux = os.platform() === 'linux';

export const GEO_TABLE = 'pi5_geo';
export const GEO_SETTINGS_KEY = 'geo_settings';
const PRIORITY = 'filter - 15';
const PERSIST_FILE = '/opt/pi5-gateway/core/pi5-geo.nft';
const RUN_DIR = '/run/pi5-geo';
const PENDING_NFT = `${RUN_DIR}/pending.nft`;
const PENDING_JSON = `${RUN_DIR}/pending.json`;
const CACHE_DIR = '/var/cache/pi5-gateway/geo';
const COUNTERS_FILE = `${CACHE_DIR}/counters.json`;
const SECRET_DIR = '/etc/pi5-gateway/geo';
const ABUSE_KEY_FILE = `${SECRET_DIR}/abuseipdb.key`;
const ROLLBACK_UNIT = 'pi5-geo-rollback';
export const TRIAL_S = 300;
const WATCH_MS = 60 * 1000;
const REFRESH_TICK_MS = 3600 * 1000;      // saatlik tur: yalnız bayat beslemeler indirilir
const FIRST_REFRESH_MS = 5 * 60 * 1000;   // açılıştan 5 dk sonra
const THREAT_MAX_AGE_MS = 12 * 3600 * 1000;
const DAILY_MAX_AGE_MS = 24 * 3600 * 1000;
const RETRY_AFTER_MS = 3600 * 1000;       // başarısız indirmeden sonra 1 sa yeniden deneme yok
const MAX_DOWNLOAD = 24 * 1024 * 1024;
const ALLOW_MIN_MS = 10 * 60 * 1000;      // onarım turunda allow4 yerinde güncellemesi en çok 10 dk'da bir
const CAP_STANDARD = 200000;              // standart profil, 4 GB ve üstü (ya da bellek bilinmiyor)
const CAP_2G = 100000;
const CAP_1G = 50000;
const CAP_LITE = 40000;
export const MAX_COUNTRIES = 60;
export const MAX_EXEMPT = 256;
// SD-WAN hub'ı (G4.4): arayüz varsa eş uçları ve hub portu muaf (yerleşik sağlayıcı, aşağıda).
export const S2S_IFACE = 'wg_s2s0';
export const S2S_PORT = 51821;

// Hiç düşmeyen kaynaklar (kural düzeyinde ilk return) ve veriden çıkarılan aralıklar. 0.0.0.0/8: DHCP keşfi 0.0.0.0'dan
// gelir (FireHOL level1 0.0.0.0/8 içerir); 198.18.0.0/15: konteyner ağı (G3.3 klx-apps 198.18.64.0/24).
export const PRIVATE4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;

// ─── Ayar ───
export interface GeoSettings {
  enabled: boolean;
  threatIn: boolean;
  threatOut: boolean;
  feeds: { spamhaus: boolean; firehol: boolean; abuseipdb: boolean };
  countriesIn: string[];
  countriesOut: string[];
  exempt: string[];
}
export const GEO_DEFAULTS: GeoSettings = {
  enabled: false, threatIn: true, threatOut: true, feeds: { spamhaus: true, firehol: true, abuseipdb: false },
  countriesIn: [], countriesOut: [], exempt: [],
};
const CC_RE = /^[A-Z]{2}$/;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const uniq = <T>(a: T[]) => [...new Set(a)];

// Kayıtlı (ya da yedekten gelen) değer → geçerli ayar; bozuk / eksik alanlar varsayılana düşer.
export function normalizeGeoSettings(raw: unknown): GeoSettings {
  const o: any = raw && typeof raw === 'object' ? raw : {};
  const f: any = o.feeds && typeof o.feeds === 'object' ? o.feeds : {};
  const cc = (v: unknown) => (Array.isArray(v) ? uniq(v.map(x => String(x).toUpperCase()).filter(x => CC_RE.test(x))).slice(0, MAX_COUNTRIES) : []);
  return {
    enabled: o.enabled === true,
    threatIn: bool(o.threatIn, true), threatOut: bool(o.threatOut, true),
    feeds: { spamhaus: bool(f.spamhaus, true), firehol: bool(f.firehol, true), abuseipdb: bool(f.abuseipdb, false) },
    countriesIn: cc(o.countriesIn), countriesOut: cc(o.countriesOut),
    exempt: Array.isArray(o.exempt) ? uniq(o.exempt.map((x: unknown) => normalizeCidr(String(x))).filter(Boolean) as string[]).slice(0, MAX_EXEMPT) : [],
  };
}

// PUT gövdesi doğrulaması (hata metni Türkçe). keyPresent: AbuseIPDB anahtar dosyası var mı.
export function validateGeoSettings(b: any, keyPresent: boolean): { settings: GeoSettings } | { error: string } {
  if (!b || typeof b !== 'object') return { error: 'Geçersiz istek' };
  if (typeof b.enabled !== 'boolean') return { error: "'enabled' true / false olmalı" };
  // Kapatma her zaman geçer: biçimdeki bir yazım hatası engeli kaldırmayı engellemesin (geçersiz girdiler ayıklanır)
  if (!b.enabled) return { settings: normalizeGeoSettings({ ...b, enabled: false }) };
  for (const k of ['threatIn', 'threatOut']) if (b[k] !== undefined && typeof b[k] !== 'boolean') return { error: `'${k}' true / false olmalı` };
  if (b.feeds !== undefined) {
    if (!b.feeds || typeof b.feeds !== 'object') return { error: "'feeds' nesne olmalı" };
    for (const k of ['spamhaus', 'firehol', 'abuseipdb']) {
      if (b.feeds[k] !== undefined && typeof b.feeds[k] !== 'boolean') return { error: `Kaynak '${k}' true / false olmalı` };
    }
  }
  for (const k of ['countriesIn', 'countriesOut']) {
    const v = b[k];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return { error: `'${k}' liste olmalı` };
    if (v.length > MAX_COUNTRIES) return { error: `En çok ${MAX_COUNTRIES} ülke seçilebilir` };
    const bad = v.find((x: unknown) => typeof x !== 'string' || !CC_RE.test(x.toUpperCase()));
    if (bad !== undefined) return { error: `Geçersiz ülke kodu: ${String(bad).slice(0, 10)}` };
  }
  if (b.exempt !== undefined) {
    if (!Array.isArray(b.exempt)) return { error: "'exempt' liste olmalı" };
    if (b.exempt.length > MAX_EXEMPT) return { error: `Muaf listede en çok ${MAX_EXEMPT} girdi olabilir` };
    const bad = b.exempt.find((x: unknown) => typeof x !== 'string' || !normalizeCidr(x));
    if (bad !== undefined) return { error: `Muaf listede geçersiz adres: ${String(bad).slice(0, 40)} (IPv4 ya da /8–/32 aralık)` };
  }
  const s = normalizeGeoSettings(b);
  if (s.enabled) {
    const anyFeed = s.feeds.spamhaus || s.feeds.firehol || s.feeds.abuseipdb;
    if ((s.threatIn || s.threatOut) && !anyFeed) return { error: 'Tehdit engeli için en az bir kaynak seçin (ya da gelen / giden tehdit engelini kapatın)' };
    if (!s.threatIn && !s.threatOut && !s.countriesIn.length && !s.countriesOut.length) {
      return { error: 'Engellenecek bir şey seçilmedi: tehdit engelini açın ya da ülke seçin' };
    }
  }
  if (s.feeds.abuseipdb && !keyPresent) return { error: 'AbuseIPDB için önce kendi API anahtarınızı kaydedin' };
  return { settings: s };
}

async function readSettings(): Promise<GeoSettings> {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [GEO_SETTINGS_KEY]).catch(() => null);
  if (!row) return { ...GEO_DEFAULTS };
  try { return normalizeGeoSettings(JSON.parse(String(row.value))); } catch { return { ...GEO_DEFAULTS }; }
}
const writeSettings = (s: GeoSettings) =>
  dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [GEO_SETTINGS_KEY, JSON.stringify(s)]);

// Yedekten gelen değer KAPALI yazılır (index.ts restoreTable): beklenmedik güvenlik duvarı değişikliği olmasın.
export function restoredGeoSettingsValue(value: unknown): string {
  let raw: unknown = null;
  try { raw = JSON.parse(String(value)); } catch { raw = null; }
  return JSON.stringify({ ...normalizeGeoSettings(raw), enabled: false });
}

// ─── IPv4 aralık aritmetiği (saf) ───
export type Range = [number, number]; // [başlangıç, bitiş] dahil
const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const ipStr = (n: number) => [24, 16, 8, 0].map(sh => Math.floor(n / 2 ** sh) % 256).join('.');
export function cidrToRange(c: string): Range {
  const [ip, p] = c.split('/');
  const len = p === undefined ? 32 : Number(p);
  const size = 2 ** (32 - len);
  const start = Math.floor(ipNum(ip) / size) * size;
  return [start, start + size - 1];
}
// Sıralar, örtüşen ve bitişik aralıkları birleştirir.
export function mergeRanges(rs: Range[]): Range[] {
  const s = rs.filter(r => r[0] <= r[1]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) { if (b > last[1]) last[1] = b; } else out.push([a, b]);
  }
  return out;
}
// a − b (ikisi de mergeRanges çıktısı).
export function subtractRanges(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  let j = 0;
  for (const [s0, e] of a) {
    let s = s0;
    while (j < b.length && b[j][1] < s) j++;
    for (let k = j; k < b.length && b[k][0] <= e; k++) {
      if (b[k][0] > s) out.push([s, b[k][0] - 1]);
      s = Math.max(s, b[k][1] + 1);
      if (s > e) break;
    }
    if (s <= e) out.push([s, e]);
  }
  return out;
}
// Aralık → en az sayıda CIDR (testler ve RIPE'nin "a-b" biçimi için).
export function rangeToCidrs(start: number, end: number): string[] {
  const out: string[] = [];
  let s = start;
  while (s <= end) {
    let len = 32;
    let size = 1;
    while (len > 0 && s % (size * 2) === 0 && s + size * 2 - 1 <= end) { size *= 2; len--; }
    out.push(`${ipStr(s)}/${len}`);
    s += size;
  }
  return out;
}
// nft öğesi: tek adres, hizalı blok (CIDR) ya da "a-b" aralığı.
export function fmtRange([s, e]: Range): string {
  if (s === e) return ipStr(s);
  const size = e - s + 1;
  const len = 32 - Math.log2(size);
  if (Number.isInteger(len) && s % size === 0) return `${ipStr(s)}/${len}`;
  return `${ipStr(s)}-${ipStr(e)}`;
}
const toRanges = (cidrs: string[]) => mergeRanges(cidrs.map(cidrToRange));

// ─── Besleme ayrıştırıcıları (saf) ───
// Satır tabanlı liste: Spamhaus drop_v4.json (her satır {"cidr": …}) / drop.txt / edrop.txt ("a/b ; SBL…"), FireHOL
// .netset, AbuseIPDB düz metin. Her satırın ilk IPv4/CIDR'si; IPv6 sessizce atlanır, /8'den geniş ya da bozuk → skipped.
export function parseFeedText(text: string): { prefixes: string[]; skipped: number } {
  const out = new Set<string>();
  let skipped = 0;
  for (const raw of String(text).split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('{')) {
      let j: any = null;
      try { j = JSON.parse(line); } catch { skipped++; continue; }
      if (typeof j?.cidr !== 'string') continue; // son satır: {"type":"metadata", …}
      line = j.cidr;
    }
    const tok = line.split(/[\s;#,]/)[0];
    if (!tok || tok.includes(':')) continue;
    const n = normalizeCidr(tok);
    if (n) out.add(n); else skipped++;
  }
  return { prefixes: [...out].sort(), skipped };
}
// RIPEstat country-resource-list: data.resources.ipv4 öğeleri "a.b.c.d/nn" ya da "a.b.c.d-e.f.g.h". Geçersiz yapı → null.
export function parseRipeCountry(j: any): { prefixes: string[]; skipped: number } | null {
  const list = j?.data?.resources?.ipv4;
  if (!Array.isArray(list)) return null;
  const out = new Set<string>();
  let skipped = 0;
  for (const item of list) {
    const s = String(item || '').trim();
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    const parts = m ? (normalizeCidr(m[1]) && normalizeCidr(m[2]) && ipNum(m[1]) <= ipNum(m[2]) ? rangeToCidrs(ipNum(m[1]), ipNum(m[2])) : null) : [s];
    if (!parts) { skipped++; continue; }
    for (const p of parts) {
      const n = normalizeCidr(p);
      if (n) out.add(n); else skipped++;
    }
  }
  return { prefixes: [...out].sort(), skipped };
}

// ─── Kurallar (saf) ───
export interface GeoRenderInput {
  private4: Range[]; allow4: Range[]; threat4: Range[]; geoIn4: Range[]; geoOut4: Range[];
  threatIn: boolean; threatOut: boolean; geoIn: boolean; geoOut: boolean; udpPorts: number[];
}
// Tablo bütünüyle değiştirilir (boş tanımla → sil → tanımla: tek `nft -f` işlemi, atomik). İmza (klx:<sha1>) input'un ilk
// kuralının açıklamasında: onarım turu tabloyu küme öğelerini dökmeden (`list chain`) tanır. allow4 (tünel uçları; Ev VPN
// istemcisi ağ değiştirdikçe değişir) imzaya girmez, kendi özeti 'allow:' kuralındadır: yalnız o değişince küme yerinde
// güncellenir (büyük kümeler yeniden yüklenmez, sayaçlar sıfırlanmaz). Metin bir kez kurulur (renderGeoTemplate); allow4
// her turda ucuzca yerine konur (withAllow).
// Kümelerde `auto-merge` YOK: öğeler burada zaten birleştirilmiş (ayrık, bitişik olmayan) gelir; auto-merge'lü kümede tablo
// yüklüyken her `nft -f` / `nft -c` eski öğeleri de okur (200k aralıkta ~335 MB yerine ~100 MB — x86 ölçümü).
export const allowSetNft = (rs: Range[]) => rs.map(fmtRange);
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
export const allowSigOf = (rs: Range[]) => hash(allowSetNft(rs).join(','));
const setLines = (name: string, els: string[]): string[] => {
  const lines: string[] = [];
  for (let i = 0; i < els.length; i += 16) lines.push(`      ${els.slice(i, i + 16).join(', ')}${i + 16 < els.length ? ',' : ''}`);
  return els.length
    ? [`  set ${name} {`, '    type ipv4_addr; flags interval;', '    elements = {', ...lines, '    }', '  }']
    : [`  set ${name} { type ipv4_addr; flags interval; }`];
};
export interface GeoTemplate { sig: string; withAllow(allow4: Range[]): { text: string; allowSig: string } }
export function renderGeoTemplate(r: Omit<GeoRenderInput, 'allow4'>): GeoTemplate {
  const set = (name: string, rs: Range[]) => setLines(name, rs.map(fmtRange));
  const ports = uniq(r.udpPorts.filter(p => Number.isInteger(p) && p > 0 && p < 65536)).sort((a, b) => a - b);
  const portExpr = ports.length === 1 ? String(ports[0]) : `{ ${ports.join(', ')} }`;
  // İşaretler (sırasıyla): allow4 kümesi, imza, allow4 özeti — metin bunlardan bölünür, her çağrıda yalnız yerlerine konur
  const body = [
    `table inet ${GEO_TABLE} {}`,
    `delete table inet ${GEO_TABLE}`,
    `table inet ${GEO_TABLE} {`,
    ...set('private4', r.private4),
    '\u0001A\u0001',
    ...set('threat4', r.threat4),
    ...set('geo_in4', r.geoIn4),
    ...set('geo_out4', r.geoOut4),
    '  chain input {',
    `    type filter hook input priority ${PRIORITY}; policy accept;`,
    '    ct state != new return comment "klx:\u0001S\u0001"',
    // Pi'nin kendi kendine açtığı bağlantılar (ör. internet kartı kipinde kendi genel adresine; kaynak o adres) hiç düşmez
    '    iifname "lo" return',
    '    ip saddr @private4 return',
    '    ip saddr @allow4 return comment "allow:\u0001H\u0001"',
    ...(ports.length ? [`    udp dport ${portExpr} return`] : []),
    ...(r.threatIn ? ['    ip saddr @threat4 counter drop comment "threat-in"'] : []),
    ...(r.geoIn ? ['    ip saddr @geo_in4 counter drop comment "geo-in"'] : []),
    '  }',
    '  chain forward {',
    `    type filter hook forward priority ${PRIORITY}; policy accept;`,
    '    ct state != new return',
    '    ip saddr @allow4 return',
    '    ip daddr @allow4 return',
    // Gelen: yalnız port yönlendirmesiyle (DNAT) içeri alınan bağlantılar
    ...(r.threatIn ? ['    ct status dnat ip saddr != @private4 ip saddr @threat4 counter drop comment "fwd-threat-in"'] : []),
    ...(r.geoIn ? ['    ct status dnat ip saddr != @private4 ip saddr @geo_in4 counter drop comment "fwd-geo-in"'] : []),
    // Giden: ev ağı (ve Ev VPN istemcileri) → tehdit / seçili ülke
    ...(r.threatOut ? ['    ip saddr @private4 ip daddr @threat4 counter drop comment "threat-out"'] : []),
    ...(r.geoOut ? ['    ip saddr @private4 ip daddr @geo_out4 counter drop comment "geo-out"'] : []),
    '  }',
    '}',
    '',
  ].join('\n');
  const [p0, p1, p2, p3] = body.split(/\u0001[ASH]\u0001/);
  const allowBlock = (els: string[]) => setLines('allow4', els).join('\n');
  // İmza: imzasız, allow4'süz metnin özeti (allow4 değişimi imzayı değiştirmez)
  const sig = hash(p0 + allowBlock([]) + p1 + p2 + p3);
  const mid = p1 + sig + p2;
  return {
    sig,
    withAllow: (allow4: Range[]) => {
      const els = allowSetNft(allow4);
      const allowSig = hash(els.join(','));
      return { text: p0 + allowBlock(els) + mid + allowSig + p3, allowSig };
    },
  };
}
export function renderGeoNft(r: GeoRenderInput): { text: string; sig: string; allowSig: string } {
  const t = renderGeoTemplate(r);
  return { ...t.withAllow(r.allow4), sig: t.sig };
}

// ─── nft ───
function nft(args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const p = spawn('nft', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { if (out.length < 65536) out += d; });
    p.on('error', e => resolve({ code: -1, out: String(e.message) }));
    p.on('close', code => resolve({ code: code ?? -1, out }));
    p.stdin.on('error', () => { /* nft stdin'i okumadan çıktı (EPIPE) — sonuç 'close' ile */ });
    p.stdin.end(input ?? '');
  });
}
const lastLine = (s: string) => s.trim().split('\n').pop() || 'bilinmeyen hata';
const CHAINS = ['input', 'forward'] as const;
const COUNTER_KEYS = ['threat-in', 'geo-in', 'fwd-threat-in', 'fwd-geo-in', 'threat-out', 'geo-out'] as const;
type CounterKey = typeof COUNTER_KEYS[number];
type Counters = Record<CounterKey, number>;
const zeroCounters = (): Counters => Object.fromEntries(COUNTER_KEYS.map(k => [k, 0])) as Counters;

// Tablonun imzası, allow4 özeti (ve kuralının tanıtıcısı) ve sayaçları (küme öğeleri dökülmez). Tablo yoksa null.
interface TableState { sig: string; allowSig: string; allowHandle: number; counters: Counters }
async function readTable(): Promise<TableState | null> {
  const counters = zeroCounters();
  let sig = '';
  let allowSig = '';
  let allowHandle = 0;
  for (const ch of CHAINS) {
    const r = await nft(['-j', 'list', 'chain', 'inet', GEO_TABLE, ch]);
    if (r.code !== 0) return null;
    let j: any = null;
    try { j = JSON.parse(r.out); } catch { return null; }
    for (const item of Array.isArray(j?.nftables) ? j.nftables : []) {
      const rule = item?.rule;
      if (!rule) continue;
      const c = String(rule.comment || '');
      if (c.startsWith('klx:')) sig = c.slice(4);
      if (c.startsWith('allow:') && ch === 'input') { allowSig = c.slice(6); allowHandle = Number(rule.handle) || 0; }
      if ((COUNTER_KEYS as readonly string[]).includes(c)) {
        const cnt = (Array.isArray(rule.expr) ? rule.expr : []).find((e: any) => e && e.counter)?.counter;
        counters[c as CounterKey] += Number(cnt?.packets) || 0;
      }
    }
  }
  return { sig, allowSig, allowHandle, counters };
}

// Sayaçlar tablo her değiştirildiğinde sıfırlanır: değiştirmeden önce okunan değer kalıcı toplama eklenir.
interface CounterStore { since: number; base: Counters }
function readCounterStore(): CounterStore | null {
  try {
    const j = JSON.parse(fs.readFileSync(COUNTERS_FILE, 'utf8'));
    const base = zeroCounters();
    for (const k of COUNTER_KEYS) base[k] = Number(j?.base?.[k]) || 0;
    return { since: Number(j?.since) || Date.now(), base };
  } catch { return null; }
}
function writeCounterStore(c: CounterStore): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(`${COUNTERS_FILE}.tmp`, JSON.stringify(c) + '\n');
    fs.renameSync(`${COUNTERS_FILE}.tmp`, COUNTERS_FILE);
  } catch (e: any) { console.error('[geo] sayaçlar yazılamadı:', e?.message || e); }
}

// Tabloyu metinle değiştirir (önce `nft -c`; checked: çağıran aynı metni az önce denetledi).
async function loadTable(text: string, current: { counters: Counters } | null, checked = false): Promise<void> {
  if (!checked) {
    const chk = await nft(['-c', '-f', '-'], text);
    if (chk.code !== 0) throw new Error(`kural denetimi geçmedi: ${lastLine(chk.out)}`);
  }
  const r = await nft(['-f', '-'], text);
  if (r.code !== 0) throw new Error(`kural yüklenemedi: ${lastLine(r.out)}`);
  // Eski tablonun sayaçları ancak tablo gerçekten değiştiyse kalıcı toplama eklenir: başarısız yükleme (ör. ENOMEM) aynı
  // sayaçları her turda yeniden saydırmasın
  if (current) {
    const st = readCounterStore() || { since: Date.now(), base: zeroCounters() };
    for (const k of COUNTER_KEYS) st.base[k] += current.counters[k];
    writeCounterStore(st);
  } else if (!readCounterStore()) {
    writeCounterStore({ since: Date.now(), base: zeroCounters() });
  }
}
async function deleteTable(): Promise<void> {
  if ((await nft(['list', 'chain', 'inet', GEO_TABLE, 'input'])).code !== 0
    && (await nft(['list', 'chain', 'inet', GEO_TABLE, 'forward'])).code !== 0
    && (await nft(['list', 'table', 'inet', GEO_TABLE])).code !== 0) return;
  const r = await nft(['delete', 'table', 'inet', GEO_TABLE]);
  if (r.code !== 0) throw new Error(`tablo silinemedi: ${lastLine(r.out)}`);
}

// ─── Dosyalar ───
function writeAtomic(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: file.startsWith(RUN_DIR) || file.startsWith(SECRET_DIR) ? 0o700 : 0o755 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const rm = (f: string) => { try { fs.rmSync(f, { force: true }); } catch { /* yok */ } };

interface Pending { settings: GeoSettings; startedAt: number; until: number }
function readPending(): Pending | null {
  const t = readText(PENDING_JSON);
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    const startedAt = Number(j?.startedAt);
    const until = Number(j?.until);
    if (!Number.isFinite(startedAt) || !Number.isFinite(until)) return null;
    return { settings: { ...normalizeGeoSettings(j.settings), enabled: true }, startedAt, until };
  } catch { return null; }
}
const clearPending = () => { rm(PENDING_JSON); rm(PENDING_NFT); };

// AbuseIPDB anahtarı: yalnız bu dosyada (0600); süreç içinde istek başlığında kullanılır.
const readAbuseKey = (): string => (readText(ABUSE_KEY_FILE) || '').trim();
export const ABUSE_KEY_RE = /^[A-Za-z0-9]{32,128}$/;
const maskKey = (k: string) => (k ? `••••${k.slice(-4)}` : '');

// ─── Geri alma zamanlayıcısı (panel servisinden bağımsız; backend çökse de çalışır) ───
const ROLLBACK_SH = `rm -f ${PENDING_NFT} ${PENDING_JSON}; if [ -s ${PERSIST_FILE} ] && nft -f ${PERSIST_FILE}; then exit 0; fi; `
  + `nft delete table inet ${GEO_TABLE} 2>/dev/null; exit 0`;
const unitState = (unit: string) => execFileP('systemctl', ['is-active', unit], { timeout: 5000 })
  .then(r => r.stdout.trim(), (e: any) => String(e?.stdout || '').trim());
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function stopRollback(): Promise<void> {
  await execFileP('systemctl', ['stop', `${ROLLBACK_UNIT}.timer`], { timeout: 10000 }).catch(() => undefined);
  // Süre tam dolarken başlamış geri alma işi (büyük kümede `nft -f` saniyeler sürer) bitene dek beklenir (en çok 30 sn;
  // öldürülmez — yarım geri alma kalmasın): ardından gelen kapatma / onay / yeni deneme onun yüklemesiyle ezilmesin
  for (let i = 0; i < 60 && ['active', 'activating', 'deactivating', 'reloading'].includes(await unitState(`${ROLLBACK_UNIT}.service`)); i++) {
    await sleep(500);
  }
  await execFileP('systemctl', ['reset-failed', `${ROLLBACK_UNIT}.timer`, `${ROLLBACK_UNIT}.service`], { timeout: 10000 }).catch(() => undefined);
}
async function armRollback(): Promise<void> {
  await stopRollback();
  await execFileP('systemd-run', ['--quiet', '--collect', `--unit=${ROLLBACK_UNIT}`, `--on-active=${TRIAL_S}`,
    '--timer-property=AccuracySec=1s', '/bin/sh', '-c', ROLLBACK_SH], { timeout: 10000 });
}
const rollbackArmed = () => execFileP('systemctl', ['is-active', '--quiet', `${ROLLBACK_UNIT}.timer`], { timeout: 5000 }).then(() => true, () => false);
// Geri almanın aynısı, süreç içinde: kalıcı dosya varsa ona dön, yoksa tablo silinir.
async function rollbackNow(): Promise<void> {
  clearPending();
  if (fs.existsSync(PERSIST_FILE)) {
    const t = readText(PERSIST_FILE) || '';
    const cur = await readTable();
    try { await loadTable(t, cur); return; } catch (e: any) { console.error('[geo] kalıcı kural yüklenemedi — tablo siliniyor:', e?.message || e); }
  }
  await deleteTable();
}

// ─── Kaynaklar ───
export type FeedId = 'spamhaus' | 'firehol' | 'abuseipdb';
export const FEED_LABEL: Record<FeedId, string> = { spamhaus: 'Spamhaus DROP', firehol: 'FireHOL level1', abuseipdb: 'AbuseIPDB' };
const FEED_IDS: FeedId[] = ['spamhaus', 'firehol', 'abuseipdb'];
const SPAMHAUS_URLS = ['https://www.spamhaus.org/drop/drop_v4.json', 'https://www.spamhaus.org/drop/edrop.txt'];
const FIREHOL_URL = 'https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset';
const ABUSE_URL = 'https://api.abuseipdb.com/api/v2/blacklist?confidenceMinimum=90&plaintext';
const ripeUrl = (cc: string) => `https://stat.ripe.net/data/country-resource-list/data.json?resource=${cc}&v4_format=prefix`;

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
// https, boyut sınırlı indirme. Hata metinleri anahtar içermez. Yönlendirme elle izlenir: yalnız https adrese, en çok 3 adım
// (https dışına hiç istek gitmez). secret: istek gizli başlık taşır (AbuseIPDB anahtarı) → yönlendirme hiç izlenmez — Node
// fetch özel başlıkları başka bir kökene ve http'ye de taşır.
async function download(url: string, headers: Record<string, string> = {}, timeoutMs = 30000, secret = false): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let cur = url;
  let res: Response | null = null;
  for (let hop = 0; !res; hop++) {
    if (!cur.startsWith('https://')) throw new Error(hop ? 'https dışına yönlendirildi' : 'yalnız https');
    const r = await fetch(cur, { signal, redirect: 'manual', headers: { 'User-Agent': 'klyrix-gate', ...headers } });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!loc) { res = r; break; }
    await r.body?.cancel().catch(() => undefined);
    if (secret) throw new Error('beklenmedik yönlendirme (izlenmedi)');
    if (hop >= 3) throw new Error('çok fazla yönlendirme');
    cur = new URL(loc, cur).toString();
  }
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > MAX_DOWNLOAD) throw new Error('liste çok büyük');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD) { await reader.cancel().catch(() => undefined); throw new Error('liste çok büyük'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchSource(id: string): Promise<{ prefixes: string[]; skipped: number }> {
  if (id === 'spamhaus') {
    const main = parseFeedText(await download(SPAMHAUS_URLS[0]));
    // EDROP 2024'te DROP'a katıldı; dosya hâlâ varsa (boş olabilir) eklenir, yoksa yok sayılır
    const extra = await download(SPAMHAUS_URLS[1]).then(parseFeedText, () => ({ prefixes: [] as string[], skipped: 0 }));
    const prefixes = uniq([...main.prefixes, ...extra.prefixes]).sort();
    if (!prefixes.length) throw new Error('liste boş geldi');
    return { prefixes, skipped: main.skipped + extra.skipped };
  }
  if (id === 'firehol') {
    const r = parseFeedText(await download(FIREHOL_URL));
    if (!r.prefixes.length) throw new Error('liste boş geldi');
    return r;
  }
  if (id === 'abuseipdb') {
    const key = readAbuseKey();
    if (!key) throw new Error('API anahtarı yok');
    let text: string;
    try {
      text = await download(ABUSE_URL, { Key: key, Accept: 'text/plain' }, 30000, true);
    } catch (e: any) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new Error('anahtar reddedildi');
      if (e instanceof HttpError && e.status === 429) throw new Error('günlük istek sınırı doldu');
      throw e;
    }
    const r = parseFeedText(text);
    if (!r.prefixes.length) throw new Error('liste boş geldi');
    return r;
  }
  const cc = /^cc-([A-Z]{2})$/.exec(id)?.[1];
  if (!cc) throw new Error('bilinmeyen kaynak');
  let j: any;
  try { j = JSON.parse(await download(ripeUrl(cc))); } catch (e: any) { throw new Error(e instanceof SyntaxError ? 'RIPEstat yanıtı okunamadı' : e?.message || String(e)); }
  const r = parseRipeCountry(j);
  if (!r) throw new Error('RIPEstat yanıtı tanınmadı');
  if (!r.prefixes.length) throw new Error('bu ülke kodu için kayıtlı IPv4 aralığı yok');
  return r;
}

interface CacheEntry { fetched_at: number; prefixes: string[]; skipped: number }
const cacheFile = (id: string) => `${CACHE_DIR}/${id}.json`;
function readCache(id: string): CacheEntry | null {
  const t = readText(cacheFile(id));
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    const prefixes = Array.isArray(j?.prefixes) ? j.prefixes.map((p: unknown) => normalizeCidr(String(p))).filter(Boolean) as string[] : [];
    return { fetched_at: Number(j?.fetched_at) || 0, prefixes, skipped: Number(j?.skipped) || 0 };
  } catch { return null; }
}
const maxAge = (id: string) => (id === 'spamhaus' || id === 'firehol' ? THREAT_MAX_AGE_MS : DAILY_MAX_AGE_MS);
const lastFailure = new Map<string, { at: number; error: string }>();
// Bir kez, önbellek taze olsa da yeniden indirilecek kaynaklar (AbuseIPDB anahtarı değişti): eski kopya silinmez — yeni
// anahtarla ilk indirme başarısız olursa (429, henüz etkin değil, ağ) eski liste kullanılmaya devam eder.
const refetch = new Set<string>();
type FetchMode = 'cache' | 'missing' | 'stale' | 'force';
export interface SourceView { id: string; label: string; kind: 'threat' | 'country'; fetchedAt: number; count: number; skipped: number; error: string }

// Önbellek → (gerekirse) indir → doğrula → önbelleğe yaz; indirme başarısızsa eski kopyayla sürülür.
async function getSource(id: string, mode: FetchMode): Promise<{ entry: CacheEntry | null; error: string }> {
  const cached = readCache(id);
  const fresh = cached && Date.now() - cached.fetched_at < maxAge(id);
  const fail = lastFailure.get(id);
  const want = mode === 'force' || refetch.has(id) || (mode === 'stale' && !fresh) || (mode === 'missing' && !cached);
  const mayTry = mode === 'force' || !fail || Date.now() - fail.at > RETRY_AFTER_MS;
  // Son indirme başarısızsa (başarılı indirme kaydı siler) hata gösterilmeye devam eder: kullanılan veri son kopyadır
  if (!want || !mayTry) return { entry: cached, error: fail ? fail.error : '' };
  refetch.delete(id); // tek deneme: başarısızsa eski kopya bayatlayınca (ya da "Listeleri şimdi yenile" ile) yeniden denenir
  try {
    const r = await fetchSource(id);
    const entry: CacheEntry = { fetched_at: Date.now(), prefixes: r.prefixes, skipped: r.skipped };
    try {
      writeAtomic(cacheFile(id), JSON.stringify(entry) + '\n');
    } catch (e: any) { console.error(`[geo] ${id} önbelleği yazılamadı: ${e?.message || e}`); }
    lastFailure.delete(id);
    return { entry, error: '' };
  } catch (e: any) {
    const error = String(e?.name === 'TimeoutError' ? 'zaman aşımı' : e?.message || e).slice(0, 160);
    lastFailure.set(id, { at: Date.now(), error });
    console.warn(`[geo] ${id} indirilemedi (${error}) — ${cached ? 'son kopya' : 'veri yok'} kullanılıyor`);
    return { entry: cached, error };
  }
}

// Sınırlı eşzamanlılık (RIPEstat'a en çok 4 istek).
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ─── Muafiyetler ───
// Ek muafiyet sağlayıcıları: izin verilen uç adresleri + Pi'ye gelen (muaf) UDP portları. G4.4 SD-WAN kendi sağlayıcısını
// aynı kimlikle ('sdwan') kaydederek yerleşik olanın yerine geçebilir.
export interface GeoExemptProvider { id: string; collect(): Promise<{ allow4: string[]; udpPorts: number[] }> }
const providers = new Map<string, GeoExemptProvider>();
export function registerGeoExemptProvider(p: GeoExemptProvider): void { providers.set(p.id, p); }

// `wg show <arayüz|all> endpoints` → IPv4 uçlar ("a.b.c.d:port"; IPv6 "[…]:port" atlanır).
export function parseWgEndpoints(out: string): string[] {
  const ips = new Set<string>();
  for (const line of String(out).split('\n')) {
    for (const tok of line.trim().split(/\s+/)) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(tok);
      if (m && normalizeCidr(m[1])) ips.add(normalizeCidr(m[1])!);
    }
  }
  return [...ips].sort();
}
const wgEndpoints = (target: string) =>
  execFileP('wg', ['show', target, 'endpoints'], { timeout: 5000 }).then(r => parseWgEndpoints(r.stdout), () => [] as string[]);

registerGeoExemptProvider({
  id: 'sdwan',
  collect: async () => (fs.existsSync(`/sys/class/net/${S2S_IFACE}`)
    ? { allow4: await wgEndpoints(S2S_IFACE), udpPorts: [S2S_PORT] }
    : { allow4: [], udpPorts: [] }),
});

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
async function resolve4(host: string): Promise<string[]> {
  const t = new Promise<string[]>(r => setTimeout(() => r([]), 3000).unref());
  const q = dns.promises.lookup(host, { family: 4, all: true }).then(a => a.map(x => x.address), () => [] as string[]);
  return Promise.race([q, t]);
}
// allow: kural düzeyindeki muaf küme (allow4; input ve forward'da her düşürmeden önce return). fixed: veriden de
// çıkarılanlar (kullanıcı listesi + adresle kayıtlı VPS'ler). Değişkenler yalnız allow4'tedir: tünel uçları (Ev VPN
// istemcisi ağ değiştirince) ve adla kayıtlı VPS'lerin DNS'ten çözülen adresleri (yanıt değişince / zaman aşımında) —
// büyük kümeler bunlar yüzünden yeniden hesaplanıp yüklenmesin.
async function collectExempt(s: GeoSettings): Promise<{ allow: string[]; fixed: string[]; udpPorts: number[] }> {
  const allow = new Set<string>(s.exempt);
  const fixed = new Set<string>(s.exempt);
  // VPS sunucuları ve içe aktarılmış tünellerin uçları (adres ya da ad)
  const rows = await dbAll('SELECT ip FROM vps_servers').catch(() => [] as any[]);
  for (const r of rows) {
    const h = String(r?.ip || '').trim();
    const n = normalizeCidr(h);
    if (n) { if (n.endsWith('/32')) { allow.add(n); fixed.add(n); } continue; }
    if (HOST_RE.test(h)) for (const ip of await resolve4(h)) { const x = normalizeCidr(ip); if (x) allow.add(x); }
  }
  // Tüm WireGuard arayüzlerinin güncel uçları: VPS tünelleri, hazır yapılandırmalar, Ev VPN (wg_pi) istemcileri
  for (const ip of await wgEndpoints('all')) allow.add(ip);
  const udpPorts = new Set<number>([WG_PORT]);
  for (const p of providers.values()) {
    const r = await p.collect().catch(() => ({ allow4: [] as string[], udpPorts: [] as number[] }));
    for (const a of r.allow4) { const x = normalizeCidr(a); if (x) allow.add(x); }
    for (const port of r.udpPorts) if (Number.isInteger(port) && port > 0 && port < 65536) udpPorts.add(port);
  }
  return { allow: [...allow].sort(), fixed: [...fixed].sort(), udpPorts: [...udpPorts].sort((a, b) => a - b) };
}

// ─── İstenen tablo ───
interface Desired {
  text: string; sig: string; allowSig: string; allow4: Range[]; error: string; tpl: GeoTemplate | null;
  counts: { threat: number; geoIn: number; geoOut: number; allow: number; total: number; cap: number };
  sources: SourceView[]; udpPorts: number[];
}
// Tavan profile ve belleğe göre. Büyük kümeler yüklüyken nft 1.1 HER `add / delete element` işleminde — başka tablolarda da
// (Fail2Ban yasağı ve kaldırması, allow4 yerinde güncellemesi) — tüm küme öğelerini okur: 200k aralıkta ~240 MB geçici
// bellek ve saniyeler (x86 ölçümü; Pi'de daha uzun). 1–2 GB kartta tavan küçülür. Bellek okunamadıysa (0) profil tavanı.
export function capFor(p: { profile?: string; memClassMiB?: number } | null | undefined): number {
  if (p?.profile !== 'standard') return CAP_LITE;
  const mem = Number(p.memClassMiB) || 0;
  if (mem > 0 && mem <= 1024) return CAP_1G;
  if (mem > 0 && mem <= 2048) return CAP_2G;
  return CAP_STANDARD;
}

// 60 sn'lik onarım turu ('missing') aynı girdilerle her dakika yeniden hesaplamasın (200k aralıkta Pi'de saniyeler sürer):
// sonuç veriyi etkileyen girdilerin anahtarıyla (ayar, sabit muaflar, muaf portlar, tavan, önbellek dosyalarının değişim
// zamanı / boyutu) saklanır; allow4 (tünel uçları, çözülen VPS adları) her turda ayrıca ve ucuzca yerine konur. İndirme
// yapabilen turlar ('stale', 'force'), verisi eksik ya da yeniden indirilecek kaynak her zaman yeniden hesaplanır.
// Kapatınca bırakılır.
interface SourceInfo { fetchedAt: number; count: number; skipped: number; has: boolean }
let memo: { key: string; d: Desired; info: Map<string, SourceInfo> } | null = null;
const statKey = (id: string) => { try { const st = fs.statSync(cacheFile(id)); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
const sourceView = (id: string, i: SourceInfo | undefined): SourceView => {
  const cc = id.startsWith('cc-') ? id.slice(3) : '';
  return {
    id, label: cc || FEED_LABEL[id as FeedId], kind: cc ? 'country' : 'threat', fetchedAt: i?.fetchedAt || 0,
    count: i?.count || 0, skipped: i?.skipped || 0, error: lastFailure.get(id)?.error || (i?.has ? '' : 'veri yok'),
  };
};

async function computeDesired(s: GeoSettings, mode: FetchMode): Promise<Desired> {
  const [platform, ex] = await Promise.all([readPlatform().catch(() => null), collectExempt(s)]);
  const cap = capFor(platform);
  const threatIds = s.threatIn || s.threatOut ? FEED_IDS.filter(id => s.feeds[id]) : [];
  const ccs = uniq([...s.countriesIn, ...s.countriesOut]);
  const ids = [...threatIds, ...ccs.map(c => `cc-${c}`)];
  const keyOf = () => JSON.stringify([s.threatIn, s.threatOut, threatIds, s.countriesIn, s.countriesOut, ex.fixed, ex.udpPorts, cap, ids.map(statKey)]);
  const m = memo;
  if (mode === 'missing' && m && m.key === keyOf() && ids.every(id => m.info.get(id)?.has) && !ids.some(id => refetch.has(id))) {
    m.d = withAllow(m.d, ex.allow);
    return { ...m.d, sources: ids.map(id => sourceView(id, m.info.get(id))) };
  }
  const got = await pool(ids, 4, id => getSource(id, mode));
  const by = new Map(ids.map((id, i) => [id, got[i]]));
  const info = new Map<string, SourceInfo>(ids.map(id => {
    const e = by.get(id)?.entry;
    return [id, { fetchedAt: e?.fetched_at || 0, count: e?.prefixes.length || 0, skipped: e?.skipped || 0, has: !!e }];
  }));
  const sources = ids.map(id => sourceView(id, info.get(id)));
  const d = buildDesired(s, ex, cap, sources, threatIds, id => by.get(id)?.entry?.prefixes || []);
  memo = { key: keyOf(), d, info };
  return d;
}

function buildDesired(s: GeoSettings, ex: { allow: string[]; fixed: string[]; udpPorts: number[] }, cap: number, sources: SourceView[],
  threatIds: string[], prefixesOf: (id: string) => string[]): Desired {
  const minus = toRanges([...PRIVATE4, ...ex.fixed]);
  const collect = (list: string[]) => subtractRanges(toRanges(list.flatMap(prefixesOf)), minus);
  const threat4 = collect(threatIds);
  const geoIn4 = collect(s.countriesIn.map(c => `cc-${c}`));
  const geoOut4 = collect(s.countriesOut.map(c => `cc-${c}`));
  const allow4 = toRanges(ex.allow);
  const total = threat4.length + geoIn4.length + geoOut4.length;
  const counts = { threat: threat4.length, geoIn: geoIn4.length, geoOut: geoOut4.length, allow: allow4.length, total, cap };
  const base = { sources, udpPorts: ex.udpPorts, counts };
  if (total > cap) {
    return { ...base, text: '', sig: '', allowSig: '', allow4, tpl: null, error: `Toplam ${total.toLocaleString('tr-TR')} aralık bu cihazın tavanını (${cap.toLocaleString('tr-TR')}) aşıyor — daha az ülke seçin` };
  }
  const tpl = renderGeoTemplate({
    private4: toRanges(PRIVATE4), threat4, geoIn4, geoOut4, threatIn: s.threatIn, threatOut: s.threatOut,
    geoIn: s.countriesIn.length > 0, geoOut: s.countriesOut.length > 0, udpPorts: ex.udpPorts,
  });
  const { text, allowSig } = tpl.withAllow(allow4);
  return { ...base, text, sig: tpl.sig, allowSig, allow4, tpl, error: '' };
}

// Hafızadaki sonuca güncel allow4'ü koyar (yalnız özeti değiştiyse metin yeniden birleştirilir).
function withAllow(d: Desired, allow: string[]): Desired {
  const allow4 = toRanges(allow);
  const counts = { ...d.counts, allow: allow4.length };
  if (!d.tpl || allowSigOf(allow4) === d.allowSig) return { ...d, allow4, counts };
  const { text, allowSig } = d.tpl.withAllow(allow4);
  return { ...d, text, allowSig, allow4, counts };
}

// ─── Durum makinesi (tek sıra) ───
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
class GeoError extends Error { constructor(public status: number, message: string) { super(message); } }

let lastDesired: Desired | null = null;
let lastError = '';
let watchedTrial = 0;                 // izlenen denemenin başlangıcı: kendiliğinden geri alınınca bir kez olay yazılır
let watchTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let firstRefresh: ReturnType<typeof setTimeout> | null = null;
let allowUpdatedAt = 0;               // allow4'ün son yerinde güncellemesi (onarım turunda en çok ALLOW_MIN_MS'de bir)

// Süresi geçmiş deneme (zamanlayıcı geri aldı ya da kayboldu): geri almanın aynısı uygulanır.
// Zamanlayıcı geri alınca deneme dosyalarını kendisi siler; izlenen deneme onaylanmadan / geri alınmadan bittiyse olay yazılır.
async function settlePending(): Promise<Pending | null> {
  const p = readPending();
  if (p && await rollbackArmed()) return p;
  if (p) await rollbackNow();
  else if (fs.existsSync(PENDING_NFT)) rm(PENDING_NFT);
  if (watchedTrial) {
    void recordEvent('geo', 'Geo-IP / tehdit engeli denemesi onaylanmadı — 5 dk sonra kendiliğinden geri alındı', 'warning');
    watchedTrial = 0;
  }
  return null;
}

// Açık ayarı tabloya uygular (imza aynıysa dokunmaz; tablo dışarıdan silindiyse geri kurar). mode: veri indirme kipi.
async function ensureNow(mode: FetchMode = 'missing'): Promise<void> {
  if (!isLinux) return;
  const pending = await settlePending();
  const eff = pending ? pending.settings : await readSettings();
  if (!eff.enabled) {
    // Kapalı: kalan kalıcı dosya / tablo temizlenir
    rm(PERSIST_FILE);
    await deleteTable();
    lastDesired = memo = null;
    syncTimers(false);
    return;
  }
  syncTimers(true);
  const d = await computeDesired(eff, mode);
  // Hesaplama sürerken deneme süresi dolduysa (zamanlayıcı tabloyu sildi, deneme dosyalarını kaldırdı) deneme kuralı geri
  // kurulmaz: sonraki tur kalıcı ayara göre karar verir.
  if (pending && !readPending()) return;
  lastDesired = d;
  if (d.error) {
    lastError = d.error;
    void recordEventOnce('geo', `Geo-IP / tehdit engeli güncellenemedi: ${d.error}`, 'warning', 360);
    return;
  }
  const cur = await readTable();
  let deferred = false;
  if (!cur || cur.sig !== d.sig || !cur.allowHandle) {
    await loadTable(d.text, cur);
    if (!cur) console.warn(`[geo] tablo (inet ${GEO_TABLE}) yoktu — yeniden yüklendi`);
  } else if (cur.allowSig !== d.allowSig && mode === 'missing' && Date.now() - allowUpdatedAt < ALLOW_MIN_MS) {
    // Yalnız muaf uçlar değişti ve son yerinde güncelleme yakın: ertelenir (büyük kümeler yüklüyken her öğe işlemi tüm
    // kümeyi okur; Ev VPN portu zaten muaf). Saatlik tur ve "Listeleri şimdi yenile" beklemez.
    deferred = true;
  } else if (cur.allowSig !== d.allowSig) {
    // Yalnız muaf uçlar değişti: küme ve özet kuralı tek işlemde yerinde güncellenir
    const els = allowSetNft(d.allow4);
    const tx = [`flush set inet ${GEO_TABLE} allow4`, ...(els.length ? [`add element inet ${GEO_TABLE} allow4 { ${els.join(', ')} }`] : []),
      `replace rule inet ${GEO_TABLE} input handle ${cur.allowHandle} ip saddr @allow4 return comment "allow:${d.allowSig}"`, ''].join('\n');
    const r = await nft(['-f', '-'], tx);
    if (r.code !== 0) await loadTable(d.text, cur);
    allowUpdatedAt = Date.now();
  }
  // Yükleme sürerken deneme süresi dolduysa: zamanlayıcı deneme dosyalarını sildi, kuralı bizden önce geri aldıysa yükleme
  // deneme kuralını yeniden kurmuş olabilir → geri almanın aynısı (onaysız kural zamanlayıcısız ve görünmez kalmasın).
  if (pending && !readPending()) {
    await rollbackNow();
    return;
  }
  // Onaylı durumda kalıcı dosya güncel tutulur (açılışta pi5-gw-restore yükler); denemede deneme dosyası.
  const file = pending ? PENDING_NFT : PERSIST_FILE;
  if (!deferred && readText(file) !== d.text) writeAtomic(file, d.text, pending ? 0o600 : 0o644);
  lastError = '';
}

function syncTimers(on: boolean): void {
  if (!on) {
    if (watchTimer) clearInterval(watchTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (firstRefresh) clearTimeout(firstRefresh);
    watchTimer = refreshTimer = firstRefresh = null;
    return;
  }
  if (!watchTimer) {
    watchTimer = setInterval(() => { void serial(() => ensureNow('missing')).catch(logErr('onarım')); }, WATCH_MS);
  }
  if (!refreshTimer) {
    const tick = () => { void serial(() => ensureNow('stale')).catch(logErr('yenileme')); };
    firstRefresh = setTimeout(tick, FIRST_REFRESH_MS);
    refreshTimer = setInterval(tick, REFRESH_TICK_MS);
  }
}
let lastLogged = '';
const logErr = (what: string) => (e: any) => {
  const msg = String(e?.message || e);
  lastError = msg;
  if (msg !== lastLogged) console.error(`[geo] ${what}:`, msg);
  lastLogged = msg;
};

// Deneme: pending + geri alma zamanlayıcısı (ÖNCE) → yükleme. Hata → anında geri alma; reddedilen denemenin hesabı durumda
// "yüklü" görünmesin diye önceki sonuç geri konur (kapalıyken hafıza da bırakılır).
async function startTrial(s: GeoSettings): Promise<void> {
  const prev = lastDesired;
  try {
    await startTrialInner(s);
  } catch (e) {
    lastDesired = prev;
    if (!prev) memo = null;
    throw e;
  }
}
async function startTrialInner(s: GeoSettings): Promise<void> {
  lastFailure.clear(); // kullanıcı istedi: son başarısız indirmenin 1 sa beklemesi uygulanmaz
  const d = await computeDesired(s, 'stale');
  lastDesired = d;
  if (d.error) throw new GeoError(409, d.error);
  const threatOn = (s.threatIn || s.threatOut) && d.sources.some(x => x.kind === 'threat' && x.count > 0);
  if ((s.threatIn || s.threatOut) && !threatOn && !s.countriesIn.length && !s.countriesOut.length) {
    throw new GeoError(502, `Tehdit listeleri indirilemedi: ${d.sources.map(x => `${x.label} (${x.error || 'boş'})`).join(', ')}`);
  }
  const missing = d.sources.filter(x => x.kind === 'country' && !x.count);
  if (missing.length) throw new GeoError(502, `Ülke verisi alınamadı: ${missing.map(x => `${x.label} (${x.error || 'boş'})`).join(', ')}`);
  const chk = await nft(['-c', '-f', '-'], d.text);
  if (chk.code !== 0) throw new GeoError(500, `Kural denetimi geçmedi: ${lastLine(chk.out)}`);
  const now = Date.now();
  writeAtomic(PENDING_NFT, d.text, 0o600);
  writeAtomic(PENDING_JSON, JSON.stringify({ settings: { ...s, enabled: true }, startedAt: now, until: now + TRIAL_S * 1000 }) + '\n', 0o600);
  try {
    await armRollback();
  } catch (e: any) {
    clearPending();
    throw new GeoError(500, `Geri alma zamanlayıcısı kurulamadı — kural uygulanmadı: ${lastLine(String(e?.stderr || e?.message || e))}`);
  }
  watchedTrial = now;
  try {
    await loadTable(d.text, await readTable(), true); // metin yukarıda denetlendi
  } catch (e: any) {
    await stopRollback();
    await rollbackNow().catch(logErr('geri alma'));
    watchedTrial = 0;
    throw new GeoError(500, String(e?.message || e));
  }
  syncTimers(true);
  lastError = '';
  void recordEvent('geo', `Geo-IP / tehdit engeli denemeye alındı (${summary(s, d)}) — 5 dk içinde "Kalıcı yap" denmezse kendiliğinden geri alınır`);
}

function summary(s: GeoSettings, d: Desired | null): string {
  const parts: string[] = [];
  const dir = [s.threatIn && 'gelen', s.threatOut && 'giden'].filter(Boolean).join(' + ');
  if (dir) parts.push(`tehdit ${dir}${d ? `: ${d.counts.threat.toLocaleString('tr-TR')} aralık` : ''}`);
  if (s.countriesIn.length) parts.push(`gelen ülke: ${s.countriesIn.join(', ')}`);
  if (s.countriesOut.length) parts.push(`giden ülke: ${s.countriesOut.join(', ')}`);
  return parts.join('; ') || 'kural yok';
}

async function confirmTrial(): Promise<void> {
  const p = readPending();
  if (!p || !(await rollbackArmed())) throw new GeoError(409, 'Onaylanacak deneme yok (süresi dolmuş ya da geri alınmış olabilir)');
  const text = readText(PENDING_NFT);
  if (!text) throw new GeoError(409, 'Deneme kuralı bulunamadı — yeniden açın');
  // Önce zamanlayıcı durur (onay sırasında geri alma araya girmesin); sonra kalıcı dosya, ayar, deneme dosyaları.
  await stopRollback();
  // Zamanlayıcı denetimle durdurma arasında çalıştıysa deneme geri alınmıştır (dosyalar silindi): onaylanacak bir şey kalmadı
  if (!readPending()) throw new GeoError(409, 'Deneme süresi doldu ve geri alındı — yeniden açın');
  writeAtomic(PERSIST_FILE, text);
  await writeSettings({ ...p.settings, enabled: true });
  clearPending();
  watchedTrial = 0;
  void recordEvent('geo', `Geo-IP / tehdit engeli kalıcı yapıldı (${summary(p.settings, lastDesired)})`);
}

async function revertTrial(): Promise<void> {
  if (!readPending()) throw new GeoError(409, 'Geri alınacak deneme yok');
  await stopRollback();
  await rollbackNow();
  watchedTrial = 0;
  const s = await readSettings();
  if (!s.enabled) { syncTimers(false); lastDesired = memo = null; }
  void recordEvent('geo', 'Geo-IP / tehdit engeli denemesi geri alındı');
}

async function disableNow(s: GeoSettings): Promise<void> {
  await stopRollback();
  clearPending();
  rm(PERSIST_FILE);
  await deleteTable();
  rm(COUNTERS_FILE);
  await writeSettings({ ...s, enabled: false });
  watchedTrial = 0;
  lastDesired = memo = null;
  lastError = '';
  syncTimers(false);
}

// ─── Dışa açık kancalar (index.ts) ───
// nftables "yeniden uygula" sonrası: açıksa tablo geri kurulur, kalıntı (deneme / kalıcı dosya) varsa temizlenir. Kapalı ve
// kalıntı yoksa hiçbir şey yapılmaz (alt süreç yok). Tek başına pending.nft: deneme süresi tam dolarken yarım kalmış tur.
const leftover = () => fs.existsSync(PENDING_JSON) || fs.existsSync(PERSIST_FILE) || fs.existsSync(PENDING_NFT);
export const reapplyGeo = (): Promise<void> => serial(async () => {
  if (!isLinux || (!(await readSettings()).enabled && !leftover())) return;
  await ensureNow('missing');
}).catch(e => { logErr('yeniden uygulama')(e); });

// Yedekten geri yüklendi: ayar KAPALI yazıldı (restoredGeoSettingsValue); süren deneme, kalıcı dosya ve tablo kaldırılır.
export const afterGeoRestore = (): Promise<string> => serial(async () => {
  if (!isLinux) return 'kapalı geldi';
  const wasOn = fs.existsSync(PERSIST_FILE) || !!readPending();
  await disableNow(await readSettings());
  if (wasOn) void recordEvent('geo', 'Yedek geri yüklendi: Geo-IP / tehdit engeli kapatıldı — açmak için Güvenlik → Geo-IP / Tehdit (5 dk deneme)');
  return 'kapalı geldi — açmak için Güvenlik → Geo-IP / Tehdit sayfasından açın (5 dk deneme)';
});

// Uyduya geçiş (index.ts POST /api/system/role): uyduda uçlar 409, açılış işi yok — kalıcı kural yine de açılışta yüklenir
// (pi5-gw-restore) ve yönetilemez kalırdı. Önce kapatılmalı.
export async function geoBlocksSatellite(): Promise<string | null> {
  if (!isLinux) return null;
  // Kapalıyken kalan artık (yarım kalmış deneme dosyası / tablo) önce temizlenir; süren deneme ya da açık engel reddedilir
  if (!(await readSettings()).enabled && leftover()) await reapplyGeo();
  const on = (await readSettings()).enabled || leftover();
  return on ? 'Geo-IP / tehdit engeli açık — önce kapatın (Güvenlik → Geo-IP / Tehdit)' : null;
}

// Açılış ('!isSatellite'): kapalıysa ve kalıntı yoksa hiçbir şey yapılmaz (zamanlayıcı, nft çağrısı, dosya yok).
let started = false;
export function startGeo(): void {
  if (!isLinux || started) return;
  started = true;
  void (async () => {
    const s = await readSettings();
    if (!s.enabled && !leftover()) return;
    // Pi yeniden başladıysa deneme dosyaları (/run) yoktur; panel yeniden başladıysa süren deneme izlenmeye devam eder.
    const p = readPending();
    if (p) watchedTrial = p.startedAt;
    await serial(() => ensureNow('missing'));
  })().catch(logErr('açılış'));
}

// ─── Uçlar ───
async function statusView(): Promise<Record<string, unknown>> {
  const settings = await readSettings();
  const pending = isLinux ? readPending() : null;
  const armed = pending ? await rollbackArmed() : false;
  // Kapalıyken de kalıntı varsa tablo okunur: 'loaded' gerçeği göstersin (arayüz o zaman Kapat sunar)
  const table = isLinux && (settings.enabled || pending || leftover()) ? await readTable() : null;
  const store = table ? readCounterStore() : null;
  const sum = (a: CounterKey, b?: CounterKey) => (table ? table.counters[a] + (b ? table.counters[b] : 0) : 0)
    + (store ? store.base[a] + (b ? store.base[b] : 0) : 0);
  const platform = isLinux ? await readPlatform().catch(() => null) : null;
  const key = isLinux ? readAbuseKey() : '';
  return {
    supported: isLinux,
    settings,
    state: pending && armed ? 'trial' : settings.enabled ? 'on' : 'off',
    trial: pending && armed ? { settings: pending.settings, startedAt: pending.startedAt, until: pending.until, now: Date.now() } : null,
    loaded: !!table,
    persisted: isLinux && fs.existsSync(PERSIST_FILE),
    counts: lastDesired?.counts || null,
    cap: capFor(platform),
    profile: platform?.profile ?? null,
    counters: table ? { threatIn: sum('threat-in', 'fwd-threat-in'), geoIn: sum('geo-in', 'fwd-geo-in'), threatOut: sum('threat-out'),
      geoOut: sum('geo-out'), since: store?.since || null } : null,
    sources: lastDesired?.sources || [],
    exemptPorts: lastDesired?.udpPorts || [WG_PORT],
    abuseKey: { set: !!key, masked: maskKey(key) },
    lastError,
    trialSeconds: TRIAL_S,
    limits: { countries: MAX_COUNTRIES, exempt: MAX_EXEMPT },
  };
}

export function registerGeoRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw }): void {
  app.use('/api/geo', (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — Geo-IP / tehdit engeli ana cihazdadır' });
    deps.guard(req, res, next);
  });
  const fail = (res: express.Response, e: any) => res.status(e instanceof GeoError ? e.status : 500).json({ error: String(e?.message || e) });
  const linuxOnly = (res: express.Response) => {
    if (isLinux) return false;
    res.status(400).json({ error: 'Geo-IP / tehdit engeli yalnız Pi üzerinde çalışır' });
    return true;
  };

  app.get('/api/geo/status', async (_req, res) => {
    try { res.json(await statusView()); } catch (e: any) { fail(res, e); }
  });

  // Ayar: enabled=false → anında kapatır (deneme gerekmez); enabled=true → 5 dk deneme (onaylanınca kalıcı).
  app.put('/api/geo/settings', async (req, res) => {
    if (linuxOnly(res)) return;
    const v = validateGeoSettings(req.body, !!readAbuseKey());
    if ('error' in v) return res.status(400).json({ error: v.error });
    try {
      await serial(async () => {
        if (!v.settings.enabled) {
          const wasOn = (await readSettings()).enabled || !!readPending();
          await disableNow(v.settings);
          if (wasOn) void recordEvent('geo', 'Geo-IP / tehdit engeli kapatıldı');
          return;
        }
        await startTrial(v.settings);
      });
      res.json(await statusView());
    } catch (e: any) { fail(res, e); }
  });

  app.post('/api/geo/confirm', async (_req, res) => {
    if (linuxOnly(res)) return;
    try { await serial(confirmTrial); res.json(await statusView()); } catch (e: any) { fail(res, e); }
  });

  app.post('/api/geo/revert', async (_req, res) => {
    if (linuxOnly(res)) return;
    try { await serial(revertTrial); res.json(await statusView()); } catch (e: any) { fail(res, e); }
  });

  // Listeleri şimdi yenile (açıkken): tüm seçili kaynaklar yeniden indirilir.
  app.post('/api/geo/refresh', async (_req, res) => {
    if (linuxOnly(res)) return;
    try {
      await serial(async () => {
        const s = await readSettings();
        if (!s.enabled && !readPending()) throw new GeoError(409, 'Geo-IP / tehdit engeli kapalı');
        lastFailure.clear();
        await ensureNow('force');
      });
      res.json(await statusView());
    } catch (e: any) { fail(res, e); }
  });

  // AbuseIPDB anahtarı: yalnız dosyaya (0600) yazılır; yanıtta maskeli.
  app.put('/api/geo/abuseipdb-key', async (req, res) => {
    if (linuxOnly(res)) return;
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!ABUSE_KEY_RE.test(key)) return res.status(400).json({ error: 'Geçersiz AbuseIPDB anahtarı (yalnız harf ve rakam, 32–128 karakter)' });
    try {
      await serial(async () => {
        writeAtomic(ABUSE_KEY_FILE, key + '\n', 0o600);
        lastFailure.delete('abuseipdb');
        // Önbellek silinmez, yalnız bir kez yeniden indirilir: yeni anahtar başarısızsa eski liste korumayı sürdürür
        refetch.add('abuseipdb');
      });
      res.json({ ok: true, abuseKey: { set: true, masked: maskKey(key) } });
    } catch (e: any) { fail(res, e); }
  });

  app.delete('/api/geo/abuseipdb-key', async (_req, res) => {
    if (linuxOnly(res)) return;
    try {
      await serial(async () => {
        const s = await readSettings();
        if ((s.enabled && s.feeds.abuseipdb) || readPending()?.settings.feeds.abuseipdb) {
          throw new GeoError(409, 'AbuseIPDB kaynağı kullanılıyor — önce kaynağı kapatıp uygulayın');
        }
        if (s.feeds.abuseipdb) await writeSettings({ ...s, feeds: { ...s.feeds, abuseipdb: false } });
        rm(ABUSE_KEY_FILE);
        rm(cacheFile('abuseipdb'));
        refetch.delete('abuseipdb');
      });
      res.json({ ok: true, abuseKey: { set: false, masked: '' } });
    } catch (e: any) { fail(res, e); }
  });
}

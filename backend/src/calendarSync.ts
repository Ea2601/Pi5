// Dış takvim eşitleme (G5.2): kullanıcının verdiği ICS adreslerinden (Google "gizli iCal adresi", Outlook 365 "takvimi
// yayımla", iCloud "herkese açık takvim") SALT OKUNUR çekme; ufuk içindeki oluşumlar saklanır ve Ağ Ajandası'nda gösterilir.
// Hiçbir kural, nft, Pi-hole, ebeveyn ya da kota ayarına dokunmaz (etiket → kural bağlama sonraki sürümde; o da
// "çözülemedi" işaretli oluşumları hiçbir zaman tetiklemez).
//  - Varsayılan: kaynak yok → ağ isteği, zamanlayıcı, dosya yok; tablolar ilk kaynak eklenirken kurulur.
//  - Adres gizli bir anahtardır (bilen takvimi okur): yalnız /etc/pi5-gateway/calendar/sources.conf'ta (dizin 0700, dosya
//    0600, yalnız "id=URL" satırları). Veritabanına, app_settings'e, yedeğe, günlüğe, argv / env'e girmez; yanıtlarda maskeli
//    (alan adı + son 4 karakter), hata metinlerinde yalnız alan adı.
//  - Çekme süreç içinde (Node https; adres argv'ye girmez): yalnız https (webcal:// → https://); en çok 3 yönlendirme, her
//    adım yeniden denetlenir; BAĞLANIRKEN çözülen adres denetlenir (loopback, link-local / 169.254.169.254, 0.0.0.0, çoklu
//    yayın, Pi'nin kendi adresleri reddedilir — loopback panel kimliğinden muaf olduğundan SSRF kritik, auth.ts); 20 sn;
//    gövde ≤ 2 MB; koşullu GET (ETag / Last-Modified). Saat internetle eşitlenmeden (RTC yok, vault.ts clockSynced) çekilmez.
//    Ağ yoksa son eşitlenen kopya (önbellek /var/cache/pi5-gateway/calendar/<id>.ics, 0600) gösterilmeye devam eder.
//  - Kaynak başına zamanlayıcı (setTimeout): varsayılan 15 dk (15–360), ±60 sn sapma; sıradaki çekme eşitlemenin BİTİŞİNDEN
//    bir aralık sonra (uzun süren eşitleme arka arkaya dizilmez); son deneme veritabanında — panel yeniden başlayınca kaldığı
//    yerden. Ayrıştırma ve açılım dilimli (calendarIcs.ts): büyük ya da kötü niyetli takvim olay döngüsünü tutmaz. Ufuk [şimdi − 1 gün, şimdi + 62 gün]; kaynağın oluşumları tek adımda değişir (nesil:
//    yeni nesil yazılır, kaynağın gen'i tek UPDATE'le geçer, eskiler silinir — okuyanlar yarım liste görmez; BEGIN yok, panelde
//    başka akışlar da işlem açıyor: trafficHistory.ts).
//  - Yalnız ana cihazda; HA (G4.3) geldiğinde yalnız MASTER'da: tek kapı syncAllowed().
//  - Olay kaynağı 'calendar': yalnız hata (aynı metin 6 sa'te bir) ve hatadan dönüş.
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import dns from 'dns';
import https from 'https';
import zlib from 'zlib';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type express from 'express';
import { dbAll, dbGet, dbRun, dbRunChanges, dbTimeMs } from './db';
import { isSatellite } from './role';
import { recordEvent, recordEventOnce } from './events';
import { clockSynced } from './vault';
import { isValidHexColor } from './util';
import { decodeIcsBytes, parseIcsAsync, expandIcsAsync, type ExpandResult } from './calendarIcs';

const CAL_DIR = process.env.PI5_CALENDAR_DIR || '/etc/pi5-gateway/calendar';
const SOURCES_FILE = path.join(CAL_DIR, 'sources.conf');
const CACHE_DIR = process.env.PI5_CALENDAR_CACHE || '/var/cache/pi5-gateway/calendar';
export const MAX_SOURCES = 5;
export const INTERVAL_MIN = 15;
export const INTERVAL_MAX = 360;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const JITTER_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const PAST_MS = DAY_MS;
const FUTURE_MS = 62 * DAY_MS;
const REEXPAND_MS = 6 * 3600_000;      // 304 / ağ hatasında ufuk kaysın diye önbellekten yeniden açılım aralığı
const BOOT_DELAY_MS = 60_000;          // açılışta ağ ve saat otursun
const CLOCK_RETRY_MS = 60_000;
const DEFAULT_COLOR = '#14b8a6';
const ID_RE = /^[0-9a-f]{12}$/;
const NEEDS_URL = 'Takvim adresi yok (yedekten geri yüklendi) — adresi yeniden girin';
const USER_AGENT = 'KlyrixGate/1 (calendar; read-only ICS)';

// Tek "etkin mi" kapısı: ana cihazda (uydu ağ geçidi işi yapmaz). G4.3 (HA) yedek düğümü burada da false döner.
export const syncAllowed = (): boolean => !isSatellite();

// ── Gizli adres dosyası ──────────────────────────────────────────────────────
function writeFile0600(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
export function readUrls(): Map<string, string> {
  const m = new Map<string, string>();
  let text = '';
  try { text = fs.readFileSync(SOURCES_FILE, 'utf8'); } catch { return m; }
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const id = line.slice(0, i).trim(), url = line.slice(i + 1).trim();
    if (ID_RE.test(id) && /^https:\/\/\S+$/.test(url)) m.set(id, url);
  }
  return m;
}
// Boş kalınca dosya (ve boş dizin) kaldırılır: kaynak yokken diskte iz kalmaz
function writeUrls(m: Map<string, string>): void {
  if (!m.size) {
    fs.rmSync(SOURCES_FILE, { force: true });
    try { fs.rmdirSync(CAL_DIR); } catch { /* dolu ya da yok */ }
    return;
  }
  writeFile0600(SOURCES_FILE, `${[...m].map(([id, u]) => `${id}=${u}`).join('\n')}\n`);
}
const cacheFile = (id: string) => path.join(CACHE_DIR, `${id}.ics`);
function removeCache(id: string): void {
  fs.rmSync(cacheFile(id), { force: true });
  try { fs.rmdirSync(CACHE_DIR); } catch { /* dolu ya da yok */ }
}

// Yalnız alan adı + son 4 karakter
export function maskUrl(url: string): string {
  try { return `${new URL(url).hostname}/••••${url.slice(-4)}`; } catch { return '••••'; }
}
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return '?'; } };
// Hata / günlük metninden adres parçalarını siler: tam adres, yol + sorgu ve gizli anahtar olabilecek uzun (≥ 16) yol / sorgu
// parçaları (Google "private-…", Outlook ve iCloud belirteçleri); yönlendirme adresleri dahil. Kısa ortak parçalar ("calendar",
// "basic.ics") silinmez — alan adının içinde de geçtikleri için ileti okunmaz olurdu.
export function redact(msg: string, urls: string[]): string {
  const parts = new Set<string>();
  for (const url of urls) {
    parts.add(url);
    try {
      const u = new URL(url);
      for (const p of [u.href, `${u.host}${u.pathname}${u.search}`, `${u.pathname}${u.search}`, u.search]) if (p.length >= 6) parts.add(p);
      for (const seg of `${u.pathname}${u.search}`.split(/[/?&=]/)) {
        if (seg.length >= 16) { parts.add(seg); try { parts.add(decodeURIComponent(seg)); } catch { /* bozuk kaçış */ } }
      }
    } catch { /* adres değil */ }
  }
  let out = String(msg ?? '');
  for (const p of [...parts].sort((a, b) => b.length - a.length)) if (p) out = out.split(p).join('••••');
  return out.slice(0, 300);
}

// ── SSRF: adres denetimi ─────────────────────────────────────────────────────
const V4_BLOCK: [string, number, string][] = [
  ['0.0.0.0', 8, 'belirsiz adres'], ['127.0.0.0', 8, 'loopback'], ['169.254.0.0', 16, 'link-local / bulut meta veri adresi'],
  ['224.0.0.0', 4, 'çoklu yayın'], ['240.0.0.0', 4, 'ayrılmış / yayın adresi'],
];
const v4int = (ip: string) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
function ownAddresses(): Set<string> {
  const s = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) s.add(a.address.toLowerCase().replace(/%.*$/, ''));
  }
  return s;
}
// Reddedilen adres → neden; izinliyse null. Ev ağındaki başka cihazlar (özel adresler) kendi takvim sunucusu olabilir: izinli.
export function forbiddenAddress(ip: string, own: Set<string> = ownAddresses()): string | null {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (dotted) a = dotted[1];
  else if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); a = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
  if (net.isIPv4(a)) {
    const n = v4int(a);
    for (const [base, bits, why] of V4_BLOCK) {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((n & mask) === (v4int(base) & mask)) return why;
    }
  } else if (net.isIPv6(a)) {
    if (a === '::') return 'belirsiz adres';
    if (a === '::1') return 'loopback';
    if (/^fe[89ab]/.test(a)) return 'link-local';
    if (/^ff/.test(a)) return 'çoklu yayın';
  } else {
    return 'geçersiz adres';
  }
  return own.has(a) ? 'Pi\'nin kendi adresi' : null;
}
type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
// Bağlantı anındaki ad çözümü: çözülen adreslerden biri bile yasaksa bağlanılmaz (DNS yeniden bağlama / çok kayıtlı ad)
function guardedLookup(own: Set<string>): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions | LookupCb, cb?: LookupCb) => {
    const done = (typeof options === 'function' ? options : cb) as LookupCb;
    const o = (typeof options === 'object' && options) ? options : {};
    dns.lookup(hostname, { all: true, family: o.family ?? 0, hints: o.hints }, (err, addrs) => {
      if (err) return done(err);
      const list = addrs as dns.LookupAddress[];
      if (!list.length) return done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      for (const a of list) {
        const why = forbiddenAddress(a.address, own);
        if (why) return done(Object.assign(new Error(`yasak adres ${a.address}`), { code: 'KLX_BLOCKED', address: a.address, why }));
      }
      if (o.all) done(null, list);
      else done(null, list[0].address, list[0].family);
    });
  }) as unknown as net.LookupFunction;
}

// ── Adres doğrulama ──────────────────────────────────────────────────────────
class CalError extends Error {}
function checkUrl(u: URL, own: Set<string>): void {
  if (u.protocol !== 'https:') throw new CalError(`${u.hostname || 'adres'}: yalnız https adresleri kabul edilir (yönlendirme güvensiz bir adrese)`);
  if (u.username || u.password) throw new CalError(`${u.hostname}: adreste kullanıcı adı / parola olamaz`);
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (!h) throw new CalError('Adres geçersiz');
  if (/^localhost$|\.localhost$/i.test(h)) throw new CalError(`${h}: yerel adres (loopback) kabul edilmez`);
  if (net.isIP(h)) {
    const why = forbiddenAddress(h, own);
    if (why) throw new CalError(`${h}: izin verilmeyen adres (${why})`);
  }
}
// Kullanıcının girdiği adres → https (webcal:// ve webcals:// https olur); geçersizse hata metni
export function normalizeUrl(raw: unknown): { url: string } | { error: string } {
  let s = String(raw ?? '').trim();
  if (!s) return { error: 'Takvim adresi gerekli' };
  if (s.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(s)) return { error: 'Takvim adresi geçersiz (boşluk ya da denetim karakteri)' };
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try { u = new URL(s); } catch { return { error: 'Takvim adresi geçersiz' }; }
  if (u.protocol === 'http:') return { error: 'Yalnız https:// ya da webcal:// adresleri kabul edilir (http şifresizdir)' };
  try { checkUrl(u, ownAddresses()); } catch (e) { return { error: (e as Error).message }; }
  u.hash = '';
  return { url: u.toString() };
}

// ── Çekme ────────────────────────────────────────────────────────────────────
export type FetchResult = { status: 200; body: Buffer; etag: string | null; lastModified: string | null; host: string } | { status: 304; host: string };
function requestOnce(u: URL, headers: Record<string, string>, signal: AbortSignal, own: Set<string>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: 'https:', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 443, path: `${u.pathname}${u.search}`,
      method: 'GET', headers, agent: false, lookup: guardedLookup(own), signal,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}
async function readBody(res: IncomingMessage, host: string): Promise<Buffer> {
  const tooBig = () => new CalError(`${host}: takvim dosyası ${MAX_BODY / 1048576} MB sınırını aşıyor`);
  const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim();
  if ((!enc || enc === 'identity') && Number(res.headers['content-length']) > MAX_BODY) { res.destroy(); throw tooBig(); }
  let stream: NodeJS.ReadableStream = res;
  if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') {
    const z = enc === 'deflate' ? zlib.createInflate() : zlib.createGunzip();
    // Sıkıştırılmış ham bayt da sınırlı (açılmış gövde aşağıda ayrıca sayılır)
    let raw = 0;
    res.on('data', (c: Buffer) => { raw += c.length; if (raw > MAX_BODY) z.destroy(tooBig()); });
    res.on('error', e => z.destroy(e));
    stream = res.pipe(z);
  } else if (enc && enc !== 'identity') {
    res.destroy();
    throw new CalError(`${host}: desteklenmeyen sıkıştırma (${enc.slice(0, 20)})`);
  }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > MAX_BODY) { res.destroy(); throw tooBig(); }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const HTTP_HINT: Record<number, string> = {
  401: 'erişim reddedildi — gizli adres yenilenmiş ya da paylaşım kapatılmış olabilir',
  403: 'erişim reddedildi — gizli adres yenilenmiş ya da paylaşım kapatılmış olabilir',
  404: 'takvim bulunamadı — adres değişmiş ya da yayım kaldırılmış olabilir',
  410: 'takvim kaldırılmış — adres değişmiş ya da yayım kaldırılmış olabilir',
  429: 'sunucu çok sık istek dediği için reddetti — daha uzun aralık seçin',
};
// urls: bu çekmede görülen bütün adresler (yönlendirmeler dahil) — hata metni redact için çağırana döner
export async function fetchIcs(url0: string, cond: { etag?: string | null; lastModified?: string | null }, urls: string[]): Promise<FetchResult> {
  const own = ownAddresses();
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let u = new URL(url0.replace(/^webcals?:\/\//i, 'https://'));
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'text/calendar, */*;q=0.5', 'Accept-Encoding': 'gzip, deflate' };
  if (cond.etag) headers['If-None-Match'] = cond.etag;
  if (cond.lastModified) headers['If-Modified-Since'] = cond.lastModified;
  for (let hop = 0; ; hop++) {
    checkUrl(u, own);
    const host = u.hostname;
    let res: IncomingMessage;
    try {
      res = await requestOnce(u, headers, signal, own);
    } catch (e) {
      throw new CalError(errorText(e, host));
    }
    const st = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(st)) {
      const loc = String(res.headers.location || '');
      res.resume();
      if (!loc) throw new CalError(`${host}: yönlendirme adresi yok (HTTP ${st})`);
      if (hop >= MAX_REDIRECTS) throw new CalError(`${host}: çok fazla yönlendirme (en çok ${MAX_REDIRECTS})`);
      let next: URL;
      try { next = new URL(loc, u); } catch { throw new CalError(`${host}: yönlendirme adresi geçersiz`); }
      urls.push(next.href);
      u = next;
      continue;
    }
    if (st === 304) { res.resume(); return { status: 304, host }; }
    if (st !== 200) {
      res.resume();
      throw new CalError(`${host}: HTTP ${st}${HTTP_HINT[st] ? ` — ${HTTP_HINT[st]}` : ''}`);
    }
    let body: Buffer;
    try {
      body = await readBody(res, host);
    } catch (e) {
      throw e instanceof CalError ? e : new CalError(errorText(e, host));
    }
    const h = (k: string) => { const v = res.headers[k]; return typeof v === 'string' && v.length <= 300 && !/[\r\n]/.test(v) ? v : null; };
    return { status: 200, body, etag: h('etag'), lastModified: h('last-modified'), host };
  }
}
function errorText(e: unknown, host: string): string {
  const err = e as { code?: string; name?: string; message?: string; address?: string; why?: string; cause?: { code?: string; name?: string } };
  if (e instanceof CalError) return e.message;
  const code = String(err?.code || err?.cause?.code || '');
  if (code === 'KLX_BLOCKED') {
    const sink = err.address === '0.0.0.0' || err.address === '::';
    return `${host} izin verilmeyen bir adrese çözülüyor (${err.address}: ${err.why}) — güvenlik nedeniyle bağlanılmadı${sink ? '; Pi-hole bu alan adını engelliyor olabilir' : ''}`;
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME'].includes(code)) return `${host} alan adı çözülemedi — internet bağlantısı yok ya da DNS engeli olabilir`;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `${host} ${FETCH_TIMEOUT_MS / 1000} sn içinde yanıt vermedi`;
  }
  if (code === 'ECONNREFUSED') return `${host} bağlantıyı reddetti (sunucu kapalı olabilir)`;
  if (code === 'ECONNRESET' || code === 'EPIPE') return `${host} bağlantıyı kesti`;
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return `${host} adresine ulaşılamıyor (ağ yok)`;
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS/i.test(code)) return `${host} güvenli bağlantısı doğrulanamadı (sertifika: ${code})`;
  return `${host} bağlanılamadı (${code || String(err?.message || e).slice(0, 80)})`;
}

// ── Veritabanı ───────────────────────────────────────────────────────────────
let schemaReady: Promise<void> | null = null;
export function ensureCalendarSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      // Adres burada TUTULMAZ (sources.conf). calendar_sources yedeğe girer (yalnız ad, renk, açık, aralık).
      await dbRun(`CREATE TABLE IF NOT EXISTS calendar_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '${DEFAULT_COLOR}', enabled INTEGER NOT NULL DEFAULT 1,
        interval_min INTEGER NOT NULL DEFAULT ${INTERVAL_MIN}, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_attempt TEXT, last_ok TEXT, last_error TEXT, etag TEXT, last_modified TEXT,
        gen INTEGER NOT NULL DEFAULT 0, expanded_at TEXT, event_count INTEGER NOT NULL DEFAULT 0, stats TEXT)`);
      // Açılmış oluşumlar (ufuk içi); kaynağın geçerli nesli calendar_sources.gen. Yedeğe girmez, yeniden eşitlenir.
      await dbRun(`CREATE TABLE IF NOT EXISTS calendar_events (
        source_id TEXT NOT NULL, gen INTEGER NOT NULL, uid TEXT NOT NULL, recurrence_id TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', dtstart_utc TEXT NOT NULL, dtend_utc TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0, unresolved TEXT, tzid TEXT, note TEXT)`);
      await dbRun('CREATE INDEX IF NOT EXISTS idx_calendar_events_src ON calendar_events (source_id, gen)');
      await dbRun('CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events (dtstart_utc)');
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
// Tablo henüz yoksa (hiç kaynak eklenmemiş) okuyanlar boş döner — tablo kurmaz
let tableSeen = false;
async function haveTables(): Promise<boolean> {
  if (tableSeen) return true;
  const r = await dbGet("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'calendar_sources'");
  tableSeen = !!r;
  return tableSeen;
}

interface SourceRow {
  id: string; name: string; color: string; enabled: number; interval_min: number; created_at: string | null;
  last_attempt: string | null; last_ok: string | null; last_error: string | null; etag: string | null; last_modified: string | null;
  gen: number; expanded_at: string | null; event_count: number; stats: string | null;
}
const getRow = async (id: string) => (await dbGet('SELECT * FROM calendar_sources WHERE id = ?', [id])) as SourceRow | undefined;
const allRows = async () => (await haveTables() ? await dbAll('SELECT * FROM calendar_sources ORDER BY created_at, id') : []) as SourceRow[];
const clampInterval = (v: unknown) => Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(Number(v)) || INTERVAL_MIN));
const iso = (ms: number) => new Date(ms).toISOString();

// Yeni nesli yazar ve kaynağı tek UPDATE'le ona geçirir; set: aynı UPDATE'te yazılacak durum sütunları
const EVENT_COLS = ['source_id', 'gen', 'uid', 'recurrence_id', 'summary', 'tags', 'dtstart_utc', 'dtend_utc', 'all_day', 'unresolved', 'tzid', 'note'];
async function swapGen(id: string, ex: ExpandResult, set: Record<string, unknown>): Promise<number | null> {
  const cur = await dbGet('SELECT gen FROM calendar_sources WHERE id = ?', [id]) as { gen: number } | undefined;
  if (!cur) return null;
  const gen = Number(cur.gen) + 1;
  await dbRun('DELETE FROM calendar_events WHERE source_id = ? AND gen = ?', [id, gen]);
  const rows = ex.occurrences.map(o => [id, gen, o.uid, o.recurrenceId, o.summary, JSON.stringify(o.tags), iso(o.start), iso(o.end),
    o.allDay ? 1 : 0, o.unresolved, o.tzid, o.note ?? null]);
  // 60 satır × 12 sütun < SQLite'ın eski 999 değişken sınırı
  for (let i = 0; i < rows.length; i += 60) {
    const chunk = rows.slice(i, i + 60);
    await dbRun(`INSERT INTO calendar_events (${EVENT_COLS.join(', ')}) VALUES ${chunk.map(() => `(${EVENT_COLS.map(() => '?').join(', ')})`).join(', ')}`, chunk.flat());
  }
  const stats = JSON.stringify({
    events: ex.stats.events, unresolvedCount: ex.stats.unresolvedCount, hiddenCount: ex.stats.hiddenCount, unresolved: ex.stats.unresolved,
    capped: ex.stats.capped, truncated: ex.stats.truncated, badLines: ex.stats.badLines, skipped: ex.stats.skipped,
  });
  const cols = { gen, expanded_at: iso(Date.now()), event_count: rows.length, stats, ...set };
  const keys = Object.keys(cols);
  const changed = await dbRunChanges(`UPDATE calendar_sources SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND gen = ?`,
    [...keys.map(k => (cols as Record<string, unknown>)[k]), id, cur.gen]);
  if (!changed) {
    await dbRun('DELETE FROM calendar_events WHERE source_id = ? AND gen = ?', [id, gen]);
    return null;
  }
  await dbRun('DELETE FROM calendar_events WHERE source_id = ? AND gen != ?', [id, gen]);
  return rows.length;
}
const horizon = (now: number) => ({ from: now - PAST_MS, to: now + FUTURE_MS });
async function expandBytes(buf: Buffer, host: string, now: number): Promise<ExpandResult> {
  const parsed = await parseIcsAsync(decodeIcsBytes(buf));
  if (!parsed.isCalendar) throw new CalError(`${host} yanıtı bir takvim (ICS) dosyası değil — adres doğru mu? (giriş ya da hata sayfası olabilir)`);
  return expandIcsAsync(parsed, horizon(now));
}

// ── Zamanlayıcı ve eşitleme ──────────────────────────────────────────────────
const timers = new Map<string, NodeJS.Timeout>();
const nextAt = new Map<string, number>();
const running = new Set<string>();
function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  nextAt.delete(id);
}
function schedule(id: string, delayMs: number): void {
  clearTimer(id);
  const d = Math.max(5_000, Math.round(delayMs));
  nextAt.set(id, Date.now() + d);
  const t = setTimeout(() => {
    timers.delete(id);
    nextAt.delete(id);
    void runSync(id).catch(e => console.error('[takvim]', (e as Error)?.message || e));
  }, d);
  t.unref?.();
  timers.set(id, t);
}
const jitter = () => Math.round((Math.random() * 2 - 1) * JITTER_MS);
// Sıradaki çekme: son denemeden bir aralık sonra (±60 sn); hiçbir zaman bir aralıktan uzak değil (saat geri / ileri gitse de).
// afterRun: eşitleme az önce bitti — aralık bitiş anından sayılır (last_attempt başlangıçta yazılır; aralıktan uzun süren bir
// eşitleme sonrakini 5 sn'ye çekip yükü kalıcı yapmasın).
function planNext(row: SourceRow, minDelay = 0, afterRun = false): void {
  if (!syncAllowed() || !row.enabled || !readUrls().has(row.id)) { clearTimer(row.id); return; }
  const every = clampInterval(row.interval_min) * MIN_MS;
  const last = dbTimeMs(row.last_attempt);
  const now = Date.now();
  const due = afterRun ? now + every : Number.isFinite(last) ? Math.min(last + every, now + every) : now;
  schedule(row.id, Math.max(due - now, minDelay) + jitter());
}

// Eşitlemeler sırayla (bellek: aynı anda tek takvim açılır)
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
export interface SyncResult { status: 'ok' | 'unchanged' | 'error' | 'waiting' | 'skipped'; events?: number; error?: string }
export function runSync(id: string): Promise<SyncResult> {
  return serial(() => doSync(id));
}
const stale = (row: SourceRow, now: number) => !(now - dbTimeMs(row.expanded_at) < REEXPAND_MS);

async function doSync(id: string): Promise<SyncResult> {
  if (!syncAllowed()) return { status: 'skipped' };
  const row = await getRow(id);
  if (!row || !row.enabled) { clearTimer(id); return { status: 'skipped' }; }
  const url = readUrls().get(id);
  if (!url) {
    await dbRun('UPDATE calendar_sources SET last_error = ? WHERE id = ?', [NEEDS_URL, id]);
    clearTimer(id);
    return { status: 'error', error: NEEDS_URL };
  }
  if (!(await clockSynced())) {
    schedule(id, CLOCK_RETRY_MS);
    return { status: 'waiting', error: 'Pi\'nin saati henüz internet saatiyle eşitlenmedi — 1 dk sonra yeniden denenecek' };
  }
  running.add(id);
  const now = Date.now();
  const nowIso = iso(now);
  const urls = [url];
  const host = hostOf(url);
  let result: SyncResult;
  try {
    await dbRun('UPDATE calendar_sources SET last_attempt = ? WHERE id = ?', [nowIso, id]);
    const cache = cacheFile(id);
    const hasCache = fs.existsSync(cache);
    try {
      const r = await fetchIcs(url, hasCache ? { etag: row.etag, lastModified: row.last_modified } : {}, urls);
      if (r.status === 304) {
        // Değişmedi: tablo aynen kalır; yalnız ufuk kayması için ara sıra önbellekten yeniden açılır
        let n: number | null = row.event_count;
        if (stale(row, now)) n = await swapGen(id, await expandBytes(fs.readFileSync(cache), host, now), { last_ok: nowIso, last_error: null });
        else await dbRun('UPDATE calendar_sources SET last_ok = ?, last_error = NULL WHERE id = ?', [nowIso, id]);
        result = { status: 'unchanged', events: n ?? 0 };
      } else {
        const ex = await expandBytes(r.body, r.host, now);
        writeFile0600(cache, r.body);
        const n = await swapGen(id, ex, { last_ok: nowIso, last_error: null, etag: r.etag, last_modified: r.lastModified });
        if (n === null) removeCache(id);   // eşitleme sürerken silindi
        result = { status: 'ok', events: n ?? 0 };
      }
    } catch (e) {
      const msg = redact(e instanceof CalError ? e.message : `${host}: takvim işlenemedi (${String((e as Error)?.message || e).slice(0, 120)})`, urls);
      // Son eşitlenen kopya gösterilmeye devam eder; ufuk kaysın diye ara sıra önbellekten yeniden açılır
      if (hasCache && stale(row, now)) {
        try { await swapGen(id, await expandBytes(fs.readFileSync(cache), host, now), {}); } catch { /* önbellek okunamadı: tablo aynen */ }
      }
      await dbRun('UPDATE calendar_sources SET last_error = ? WHERE id = ?', [msg, id]);
      result = { status: 'error', error: msg };
    }
    // Olay geçmişi: hata (aynı metin 6 sa'te bir) ve hatadan dönüş
    if (result.status === 'error') {
      await recordEventOnce('calendar', `Takvim «${row.name}» eşitlenemedi: ${result.error} — son eşitlenen kopya gösteriliyor`, 'warning', 360);
    } else if (row.last_error && row.last_error !== NEEDS_URL) {
      await recordEvent('calendar', `Takvim «${row.name}» yeniden eşitlendi`);
    }
    return result;
  } finally {
    running.delete(id);
    const fresh = await getRow(id).catch(() => undefined);
    if (fresh) planNext(fresh, 0, true);
  }
}

let started = false;
// Açılış (index.ts !isSatellite bloğu): kaynak yoksa hiçbir şey yapmaz (tablo bile kurulmaz).
export async function startCalendarSync(): Promise<void> {
  if (started || !syncAllowed()) return;
  started = true;
  const rows = await allRows();
  if (!rows.length) return;
  const urls = readUrls();
  for (const r of rows) if (r.enabled && urls.has(r.id)) planNext(r, BOOT_DELAY_MS + Math.random() * JITTER_MS);
}
async function rescheduleAll(): Promise<void> {
  const rows = await allRows();
  const ids = new Set(rows.map(r => r.id));
  for (const id of [...timers.keys()]) if (!ids.has(id)) clearTimer(id);
  for (const r of rows) planNext(r, 5_000);
}

// ── Yedek ────────────────────────────────────────────────────────────────────
// Yedeğe giren satırlar: yalnız ayar sütunları (adres yok, çalışma durumu yok). Tablo yoksa boş.
export async function calendarBackupRows(): Promise<Record<string, unknown>[]> {
  if (!(await haveTables())) return [];
  return dbAll('SELECT id, name, color, enabled, interval_min FROM calendar_sources ORDER BY created_at, id');
}
const validName = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s && [...s].length <= 40 && !/[\u0000-\u001f\u007f<>]/.test(s) ? s : null;
};
// Geri yüklemeden ÖNCE (index.ts importBackupData, işlemden önce): tablo kurulur, satırlar doğrulanır; hepsi KAPALI gelir
// (adres yedekte yok — aynı cihazda adres hâlâ kayıtlıysa yeniden açılabilir, değilse yeniden girilmeli).
export async function prepareCalendarRestore(rows: unknown[]): Promise<{ rows: Record<string, unknown>[]; skipped: number }> {
  await ensureCalendarSchema();
  tableSeen = true;
  const out: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const r of rows) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const id = String(o.id ?? '');
    const name = validName(o.name);
    if (!ID_RE.test(id) || !name || out.some(x => x.id === id) || out.length >= MAX_SOURCES) { skipped++; continue; }
    const color = isValidHexColor(o.color) ? `#${String(o.color).trim().replace(/^#/, '').toLowerCase()}` : DEFAULT_COLOR;
    out.push({ id, name, color, enabled: 0, interval_min: clampInterval(o.interval_min) });
  }
  return { rows: out, skipped };
}
// Geri yüklemeden SONRA (applyRestored): yedekte olmayan kaynakların adresi, önbelleği ve oluşumları silinir; zamanlayıcılar
// yeniden kurulur. Dönüş: kullanıcıya not.
export async function afterCalendarRestore(): Promise<string> {
  const rows = await allRows();
  const ids = new Set(rows.map(r => r.id));
  const urls = readUrls();
  let dropped = 0;
  for (const id of [...urls.keys()]) if (!ids.has(id)) { urls.delete(id); dropped++; }
  if (dropped) writeUrls(urls);
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const id = f.replace(/\.ics$/, '');
      if (!ids.has(id) || !rows.find(r => r.id === id)?.etag) fs.rmSync(path.join(CACHE_DIR, f), { force: true });
    }
    fs.rmdirSync(CACHE_DIR);
  } catch { /* dizin yok ya da dolu */ }
  await dbRun('DELETE FROM calendar_events WHERE NOT EXISTS (SELECT 1 FROM calendar_sources s WHERE s.id = calendar_events.source_id AND s.gen = calendar_events.gen)');
  await rescheduleAll();
  const noUrl = rows.filter(r => !urls.has(r.id)).length;
  if (!rows.length) return 'yedekte takvim yok';
  return `${rows.length} takvim kapalı geldi — ${noUrl ? `${noUrl} takvimin adresi yeniden girilmeli (gizli adres yedeğe girmez); ` : ''}Ağ Ajandası → Takvim bağlantıları'ndan açın`;
}

// ── Ajanda ───────────────────────────────────────────────────────────────────
interface EventRow {
  source_id: string; uid: string; recurrence_id: string; summary: string; tags: string; dtstart_utc: string; dtend_utc: string;
  all_day: number; unresolved: string | null; tzid: string | null; note: string | null; source_name: string; color: string;
}
const parseTags = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
// Son açılımın özeti (calendar_sources.stats; eski kayıtta hiddenCount / hidden yok)
interface SourceStats {
  events?: number; unresolvedCount?: number; hiddenCount?: number; unresolved?: { summary: string; reason: string; detail: string; hidden?: boolean }[];
  capped?: number; truncated?: boolean; badLines?: number; skipped?: number;
}
const parseStats = (s: string | null): SourceStats => { try { return s ? JSON.parse(s) as SourceStats : {}; } catch { return {}; } };
async function eventsBetween(from: number, to: number, limit = 5001): Promise<EventRow[]> {
  if (!(await haveTables())) return [];
  return await dbAll(`SELECT e.source_id, e.uid, e.recurrence_id, e.summary, e.tags, e.dtstart_utc, e.dtend_utc, e.all_day, e.unresolved,
      e.tzid, e.note, s.name AS source_name, s.color AS color
    FROM calendar_events e JOIN calendar_sources s ON s.id = e.source_id AND s.gen = e.gen
    WHERE s.enabled = 1 AND e.dtstart_utc < ? AND (e.dtend_utc > ? OR (e.dtend_utc = e.dtstart_utc AND e.dtstart_utc >= ?))
    ORDER BY e.dtstart_utc, e.source_id LIMIT ?`, [iso(to), iso(from), iso(from), limit]) as EventRow[];
}
const UNRESOLVED_TEXT: Record<string, string> = {
  tz: 'saat dilimi tanınmadı — saat tahmini, hiçbir şeyi tetiklemez',
  rrule: 'tekrarlama kuralı desteklenmiyor — yalnız ilk tarih, hiçbir şeyi tetiklemez',
  limit: 'tekrarlama çok uzun — hiçbir şeyi tetiklemez',
  time: 'bitiş, süre, istisna ya da değiştirilen oluşumun tarihi okunamadı — hiçbir şeyi tetiklemez',
};
export interface CalendarAgendaItem {
  id: string; source: 'calendar'; title: string; start: string; end: string | null; kind: 'window' | 'job'; approx: boolean;
  link: null; note?: string; tags: string[]; color: string; calendar: string; allDay?: boolean; unresolved?: string;
}
export interface CalendarPeriodic {
  id: string; source: 'calendar'; kind: 'periodic'; title: string; everySec: number | null; next: string | null; note?: string; link: null;
}
// Ajandanın "Takvim" kaynağı (agenda.ts). Hiç kaynak yoksa null: ajanda yanıtında takvim hiç görünmez (eskisiyle aynı).
export async function calendarForAgenda(from: number, to: number): Promise<{ items: CalendarAgendaItem[]; periodic: CalendarPeriodic[]; warning: string | null } | null> {
  const rows = await allRows();
  if (!rows.length) return null;
  const urls = readUrls();
  const items: CalendarAgendaItem[] = (await eventsBetween(from, to)).map(e => {
    const s = dbTimeMs(e.dtstart_utc), en = dbTimeMs(e.dtend_utc);
    const h = crypto.createHash('sha1').update(`${e.uid}\n${e.recurrence_id}`).digest('hex').slice(0, 10);
    return {
      id: `calendar:${e.source_id}:${h}:${s}`, source: 'calendar', title: e.summary || 'Başlıksız etkinlik', start: iso(s),
      end: en > s ? iso(en) : null, kind: en > s ? 'window' : 'job', approx: e.unresolved === 'tz', link: null,
      note: e.unresolved ? `${e.source_name} · ${UNRESOLVED_TEXT[e.unresolved] || 'çözülemedi'}${e.tzid ? ` (${e.tzid})` : ''}` : e.source_name,
      tags: parseTags(e.tags), color: e.color, calendar: e.source_name,
      ...(e.all_day ? { allDay: true } : {}), ...(e.unresolved ? { unresolved: e.unresolved } : {}),
    };
  });
  const periodic: CalendarPeriodic[] = rows.filter(r => r.enabled && urls.has(r.id)).map(r => {
    const n = nextAt.get(r.id);
    return {
      id: `calendar:${r.id}`, source: 'calendar', kind: 'periodic', title: `Takvim eşitlemesi: ${r.name}`,
      everySec: clampInterval(r.interval_min) * 60, next: n ? iso(n) : null, link: null,
      ...(r.last_error ? { note: `Son deneme başarısız: ${r.last_error}` } : {}),
    };
  });
  const warn: string[] = [];
  for (const r of rows) {
    if (!r.enabled) continue;
    if (!urls.has(r.id)) warn.push(`«${r.name}»: adres yeniden girilmeli`);
    else if (r.last_error) warn.push(`«${r.name}» eşitlenemedi (${r.last_error}) — son eşitlenen kopya gösteriliyor`);
  }
  const unresolved = items.filter(i => i.unresolved).length;
  if (unresolved) warn.push(`${unresolved} etkinlik çözülemedi (saat dilimi, tekrarlama kuralı ya da okunamayan saat bilgisi) — uyarı işaretiyle gösterilir, hiçbir şeyi tetiklemez`);
  // Tarihleri hesaplanamayan seriler (ör. ufuktan önce başlamış, kuralı desteklenmeyen tekrar): ajandada hiç oluşumu yok — adıyla
  let hidden = 0;
  const names: string[] = [];
  for (const r of rows) {
    if (!r.enabled || !urls.has(r.id)) continue;
    const st = parseStats(r.stats);
    hidden += st.hiddenCount ?? 0;
    for (const u of st.unresolved || []) if (u.hidden && names.length < 3) names.push(`«${u.summary || 'Başlıksız etkinlik'}»`);
  }
  if (hidden) {
    warn.push(`${hidden} tekrarlayan etkinliğin tarihleri hesaplanamadı${names.length ? ` (${names.join(', ')}${hidden > names.length ? ', …' : ''})` : ''} — ajandada gösterilemiyor, hiçbir şeyi tetiklemez; ayrıntı Takvim bağlantıları'nda`);
  }
  return { items, periodic, warning: warn.length ? warn.join(' · ') : null };
}

// ── API ──────────────────────────────────────────────────────────────────────
function publicSource(r: SourceRow, urls: Map<string, string>) {
  const url = urls.get(r.id);
  const stats = parseStats(r.stats);
  const n = nextAt.get(r.id);
  return {
    id: r.id, name: r.name, color: r.color, enabled: !!r.enabled, interval_min: clampInterval(r.interval_min),
    url: url ? maskUrl(url) : null, needs_url: !url,
    last_attempt: r.last_attempt, last_ok: r.last_ok, last_error: r.last_error, event_count: Number(r.event_count) || 0,
    expanded_at: r.expanded_at, next_sync: n ? iso(n) : null, syncing: running.has(r.id),
    stats: {
      events: stats.events ?? null, unresolvedCount: stats.unresolvedCount ?? 0, hiddenCount: stats.hiddenCount ?? 0,
      unresolved: (stats.unresolved || []).slice(0, 10).map(u => ({ ...u, hidden: !!u.hidden })),
      capped: stats.capped ?? 0, truncated: !!stats.truncated, badLines: stats.badLines ?? 0,
    },
  };
}
const MASK_RE = /••••/;
// Sorgu zamanı: ISO ya da epoch ms
const parseWhen = (v: unknown, dflt: number) => {
  const s = String(v ?? '').trim();
  if (!s) return dflt;
  return /^\d{10,14}$/.test(s) ? Number(s) : Date.parse(s);
};
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 300);

// Uçlar. Kapılar index.ts'te (app.use '/api/calendar'): uyduda 409, netAdminGuard (yazma yalnız panelin IP / adıyla), yazma
// sınırı. Tüm yanıtlarda adres maskeli.
export function registerCalendarRoutes(app: express.Express): void {
  app.get('/api/calendar/sources', async (_req, res) => {
    try {
      const urls = readUrls();
      res.json({ sources: (await allRows()).map(r => publicSource(r, urls)), max: MAX_SOURCES, interval: { min: INTERVAL_MIN, max: INTERVAL_MAX } });
    } catch (e) {
      res.status(500).json({ error: `Takvimler okunamadı: ${errMsg(e)}` });
    }
  });

  app.post('/api/calendar/sources', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const name = validName(b.name);
    if (!name) return res.status(400).json({ error: 'Ad 1–40 karakter olmalı (< > ve denetim karakteri olmadan)' });
    const nu = normalizeUrl(b.url);
    if ('error' in nu) return res.status(400).json({ error: nu.error });
    if (b.color !== undefined && b.color !== '' && !isValidHexColor(b.color)) return res.status(400).json({ error: 'Renk #rrggbb biçiminde olmalı' });
    const iv = b.interval_min === undefined ? INTERVAL_MIN : Number(b.interval_min);
    if (!Number.isInteger(iv) || iv < INTERVAL_MIN || iv > INTERVAL_MAX) return res.status(400).json({ error: `Eşitleme aralığı ${INTERVAL_MIN}–${INTERVAL_MAX} dakika olmalı` });
    try {
      await ensureCalendarSchema();
      tableSeen = true;
      const rows = await allRows();
      if (rows.length >= MAX_SOURCES) return res.status(400).json({ error: `En çok ${MAX_SOURCES} takvim bağlanabilir` });
      const urls = readUrls();
      const dup = [...urls].find(([, u]) => u === nu.url);
      if (dup) return res.status(409).json({ error: `Bu takvim zaten bağlı (${rows.find(r => r.id === dup[0])?.name || 'başka bir kayıt'})` });
      const id = crypto.randomBytes(6).toString('hex');
      const color = b.color ? `#${String(b.color).trim().replace(/^#/, '').toLowerCase()}` : DEFAULT_COLOR;
      urls.set(id, nu.url);
      writeUrls(urls);   // önce gizli dosya: yazılamazsa kayıt eklenmez
      try {
        await dbRun('INSERT INTO calendar_sources (id, name, color, enabled, interval_min) VALUES (?, ?, ?, 1, ?)', [id, name, color, iv]);
      } catch (e) {
        urls.delete(id);
        writeUrls(urls);
        throw e;
      }
      void runSync(id).catch(e => console.error('[takvim]', errMsg(e)));
      res.json({ success: true, id });
    } catch (e) {
      res.status(500).json({ error: `Takvim eklenemedi: ${redact(errMsg(e), [nu.url])}` });
    }
  });

  app.put('/api/calendar/sources/:id', async (req, res) => {
    const id = String(req.params.id);
    const b = (req.body || {}) as Record<string, unknown>;
    try {
      const row = ID_RE.test(id) && await haveTables() ? await getRow(id) : undefined;
      if (!row) return res.status(404).json({ error: 'Takvim bulunamadı' });
      const set: Record<string, unknown> = {};
      if (b.name !== undefined) {
        const name = validName(b.name);
        if (!name) return res.status(400).json({ error: 'Ad 1–40 karakter olmalı (< > ve denetim karakteri olmadan)' });
        set.name = name;
      }
      if (b.color !== undefined) {
        if (!isValidHexColor(b.color)) return res.status(400).json({ error: 'Renk #rrggbb biçiminde olmalı' });
        set.color = `#${String(b.color).trim().replace(/^#/, '').toLowerCase()}`;
      }
      if (b.interval_min !== undefined) {
        const iv = Number(b.interval_min);
        if (!Number.isInteger(iv) || iv < INTERVAL_MIN || iv > INTERVAL_MAX) return res.status(400).json({ error: `Eşitleme aralığı ${INTERVAL_MIN}–${INTERVAL_MAX} dakika olmalı` });
        set.interval_min = iv;
      }
      const urls = readUrls();
      // Maskeli değer ya da boş = adres değişmedi (DDNS deseni)
      let newUrl: string | null = null;
      if (b.url !== undefined && String(b.url).trim() !== '' && !MASK_RE.test(String(b.url))) {
        const nu = normalizeUrl(b.url);
        if ('error' in nu) return res.status(400).json({ error: nu.error });
        const dup = [...urls].find(([k, u]) => u === nu.url && k !== id);
        if (dup) return res.status(409).json({ error: 'Bu takvim zaten bağlı' });
        newUrl = nu.url;
      }
      if (b.enabled !== undefined) {
        const on = b.enabled === true || b.enabled === 1 || b.enabled === '1';
        if (on && !urls.has(id) && !newUrl) return res.status(400).json({ error: 'Önce takvim adresini girin' });
        set.enabled = on ? 1 : 0;
      }
      if (newUrl && newUrl !== urls.get(id)) {
        urls.set(id, newUrl);
        writeUrls(urls);
        removeCache(id);
        Object.assign(set, { etag: null, last_modified: null, last_error: null });
      } else {
        newUrl = null;
      }
      const keys = Object.keys(set);
      if (keys.length) await dbRun(`UPDATE calendar_sources SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => set[k]), id]);
      const fresh = await getRow(id);
      let syncing = false;
      if (fresh) {
        // Adres değişti ya da takvim açıldı: hemen eşitle; kapandı: zamanlayıcı durur (oluşumlar ajandada görünmez)
        const turnedOn = set.enabled === 1 && !row.enabled;
        syncing = !!fresh.enabled && (!!newUrl || turnedOn);
        if (syncing) void runSync(id).catch(e => console.error('[takvim]', errMsg(e)));
        else planNext(fresh);
      }
      // syncing: arayüzün iletisi için (kapalı takvimde ya da aynı adres yeniden girilince eşitleme başlamaz)
      res.json({ success: true, syncing });
    } catch (e) {
      res.status(500).json({ error: `Takvim güncellenemedi: ${errMsg(e)}` });
    }
  });

  app.delete('/api/calendar/sources/:id', async (req, res) => {
    const id = String(req.params.id);
    try {
      if (!ID_RE.test(id) || !(await haveTables())) return res.status(404).json({ error: 'Takvim bulunamadı' });
      const n = await dbRunChanges('DELETE FROM calendar_sources WHERE id = ?', [id]);
      await dbRun('DELETE FROM calendar_events WHERE source_id = ?', [id]);
      clearTimer(id);
      const urls = readUrls();
      if (urls.delete(id)) writeUrls(urls);
      removeCache(id);
      if (!n) return res.status(404).json({ error: 'Takvim bulunamadı' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: `Takvim silinemedi: ${errMsg(e)}` });
    }
  });

  app.post('/api/calendar/sources/:id/sync', async (req, res) => {
    const id = String(req.params.id);
    try {
      const row = ID_RE.test(id) && await haveTables() ? await getRow(id) : undefined;
      if (!row) return res.status(404).json({ error: 'Takvim bulunamadı' });
      if (!row.enabled) return res.status(409).json({ error: 'Takvim kapalı — önce açın' });
      if (!readUrls().has(id)) return res.status(409).json({ error: NEEDS_URL });
      const r = await runSync(id);
      res.json({ success: r.status === 'ok' || r.status === 'unchanged', ...r });
    } catch (e) {
      res.status(500).json({ error: `Eşitlenemedi: ${errMsg(e)}` });
    }
  });

  // Oluşumlar (açık takvimler, geçerli nesil): ?from&to (ISO ya da epoch ms; varsayılan şimdi → 7 gün, en çok 62 gün)
  app.get('/api/calendar/events', async (req, res) => {
    const now = Date.now();
    const from = parseWhen(req.query.from, now);
    const to = parseWhen(req.query.to, from + 7 * DAY_MS);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return res.status(400).json({ error: 'from / to geçersiz (ISO zaman ya da epoch ms; to > from)' });
    if (to - from > 62 * DAY_MS + 3600_000) return res.status(400).json({ error: 'Aralık en çok 62 gün olabilir' });
    try {
      const rows = await eventsBetween(from, to, 5000);
      res.json({
        from: iso(from), to: iso(to),
        events: rows.map(e => ({
          source_id: e.source_id, calendar: e.source_name, color: e.color, uid: e.uid, recurrence_id: e.recurrence_id || null,
          summary: e.summary, tags: parseTags(e.tags), start: e.dtstart_utc, end: e.dtend_utc, all_day: !!e.all_day,
          unresolved: e.unresolved, tzid: e.tzid,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: `Etkinlikler okunamadı: ${errMsg(e)}` });
    }
  });

  // Takvimde görülen etiketler (öneri listesi: hiçbir kurala bağlı değil, otomatik eylem yok)
  app.get('/api/calendar/tags', async (_req, res) => {
    try {
      const now = Date.now();
      const rows = await eventsBetween(now - PAST_MS, now + FUTURE_MS + DAY_MS, 100_000);
      const m = new Map<string, { tag: string; count: number; next: string | null; sources: Set<string> }>();
      for (const e of rows) {
        for (const t of parseTags(e.tags)) {
          const x = m.get(t) ?? { tag: t, count: 0, next: null, sources: new Set<string>() };
          x.count++;
          x.sources.add(e.source_name);
          if (dbTimeMs(e.dtend_utc) > now && (x.next === null || e.dtstart_utc < x.next)) x.next = e.dtstart_utc;
          m.set(t, x);
        }
      }
      const tags = [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'tr'))
        .map(x => ({ tag: x.tag, count: x.count, next: x.next, sources: [...x.sources] }));
      res.json({ tags });
    } catch (e) {
      res.status(500).json({ error: `Etiketler okunamadı: ${errMsg(e)}` });
    }
  });
}

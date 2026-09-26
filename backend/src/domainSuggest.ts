// ─── Routing önerileri: yönlendirilen bir siteyle birlikte açılan diğer alan adları ───
// Pi-hole v6 FTL disk veritabanından (salt okunur) hesaplanır. Bir cihaz yönlendirilen bir kuralın adını sorduğunda,
// aynı cihazın o sorgudan W_BEFORE sn önce ile W_AFTER sn sonrası arasında sorduğu diğer adlar aday olur. Kelime
// eşleşmesi ve otomatik ekleme YOK (kullanıcı kararı): yalnız öneri + tek tıkla ekle / yoksay.
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isLinux, FTL_DB, VALID_DNSMASQ_DOMAIN } from './system';

const execFileAsync = promisify(execFile);

const W_BEFORE = 20;            // yönlendirme adresleri açılış adresinden önce sorulur
const W_AFTER = 60;             // sayfa ve sonradan yüklenen öğeler
const SESSION_GAP = 600;        // aynı cihaz + kural için 10 dk'dan uzun boşluk → yeni ziyaret (yalnız sayım için)
const MIN_LIFT = 3;             // pencere içi / pencere dışı etkinlik oranı bunun altındaysa arka plan sayılır
const MIN_OUTSIDE_BUCKETS = 2;  // arka plan kararı için gereken en az pencere dışı dakika
const MAX_ANCHOR_DUTY = 0.6;    // kural adı cihazın etkin dakikalarının bu oranından fazlasında sorgulanıyorsa (sürekli
                                // yoklayan mesajlaşma/VoIP) o cihaz için "ziyaret" sayılmaz: eş-yükleme anlamsızlaşır
const MIN_DUTY_MINUTES = 30;    // …ama yalnız en az bu kadar dakikada sorgulandıysa (az etkin cihazda birkaç ziyaret %100 görünür)
const MAX_RULE_ITEMS = 15;
const MAX_CACHED_ITEMS = 200;
const MAX_SAMPLES = 4;
const MAX_FQDNS = 20;
const MAX_CLIENTS = 20;
const MAX_SESSIONS_PER_RULE = 100;
const MAX_ANCHOR_RULES = 200;
const Q1_LIMIT = 20000;
const Q2_LIMIT = 200000;
const CACHE_TTL_MS = 60000;     // FTL diske dakikada bir yazar (database.DBinterval)
const QUERY_TIMEOUT_MS = 10000;
export const MAX_HOURS = 72;
// Cevaplanmış sorgular (izinli liste): engellenen/yanıtsız adlar ipset'i hiç doldurmaz, önermek anlamsız.
// 2 forwarded, 3 cached, 12 retried, 13 retried-DNSSEC, 14 already-forwarded, 17 cached-stale.
const ANSWERED_STATUS = '2,3,12,13,14,17';
const QUERY_TYPES = '1,2,15,16'; // A, AAAA, SVCB, HTTPS

// Kayıtlı alan adı bazında son-ek eşleşmesiyle elenen yaygın arka plan adları (kaba süzgeç; asıl süzgeç lift testi).
const IGNORE = new Set([
  // Apple
  'apple.com', 'icloud.com', 'icloud-content.com', 'apple-dns.net', 'aaplimg.com', 'mzstatic.com', 'cdn-apple.com',
  'apple-cloudkit.com', 'itunes.com', 'me.com', 'ls-apple.com.akadns.net',
  // Google
  'google.com', 'google.com.tr', 'google.ae', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'googlevideo.com',
  'youtube.com', 'ytimg.com', 'ggpht.com', 'gvt1.com', 'gvt2.com', '1e100.net', 'googletagmanager.com',
  'google-analytics.com', 'googleadservices.com', 'googlesyndication.com', 'doubleclick.net', 'app-measurement.com',
  'app-analytics-services.com', 'recaptcha.net', 'crashlytics.com', 'firebaseinstallations.googleapis.com',
  // Meta
  'whatsapp.net', 'whatsapp.com', 'facebook.com', 'facebook.net', 'fbcdn.net', 'fbsbx.com', 'instagram.com',
  'cdninstagram.com',
  // Microsoft
  'microsoft.com', 'msftconnecttest.com', 'msftncsi.com', 'windows.com', 'windowsupdate.com', 'live.com', 'office.com',
  'office.net', 'bing.com', 'msn.com', 'clarity.ms', 'msedge.net', 'skype.com',
  // Analiz, reklam, izleme
  'newrelic.com', 'nr-data.net', 'hotjar.com', 'hotjar.io', 'sentry.io', 'mixpanel.com', 'segment.io', 'amplitude.com',
  'onesignal.com', 'appsflyer.com', 'adjust.com', 'branch.io', 'criteo.com', 'criteo.net', 'scorecardresearch.com',
  'yandex.ru', 'adsrvr.org', 'amazon-adsystem.com', 'adsafeprotected.com', 'pub.network', 'btloader.com',
  // Cloudflare ve ortak kütüphaneler
  'cloudflare.com', 'cloudflareinsights.com', 'jquery.com', 'jsdelivr.net', 'unpkg.com', 'bootstrapcdn.com',
  'fontawesome.com', 'typekit.net', 'cookielaw.org',
  // OS, captive, NTP, diğer
  'ntp.org', 'mozilla.com', 'mozilla.org', 'mozilla.net', 'firefox.com', 'samsung.com', 'waze.com', 'ouraring.com',
  // Apple/Microsoft Akamai uçları
  'akamaiedge.net', 'akamai.net', 'edgekey.net', 'edgesuite.net', 'akadns.net',
  // Etisalat/du operatör adları (VoWiFi ePDG vb.)
  'etisalat.ae', 'du.ae', '3gppnetwork.org',
]);

// Çok kiracılı paylaşımlı ana makineler: tam host adı önerilir, asla gruplanmaz (tek tıkla bütün CloudFront VPS'e gitmesin).
const SHARED_HOST_SUFFIXES = [
  'cloudfront.net', 'amazonaws.com', 'fastly.net', 'fastlylb.net', 'fastly-edge.com', 'azureedge.net', 'azurefd.net',
  'azurewebsites.net', 'cloudapp.net', 'windows.net', 'trafficmanager.net', 'b-cdn.net', 'cdn77.org', 'kxcdn.com',
  'r2.dev', 'pages.dev', 'workers.dev', 'herokuapp.com', 'github.io', 'firebaseapp.com', 'firebaseio.com', 'web.app',
  'appspot.com', 'netlify.app', 'vercel.app', 'onrender.com', 'blogspot.com', 'digitaloceanspaces.com', 'llnwd.net',
  'gcdn.co', 'akamaized.net', 'akamaihd.net', 'edgecastcdn.net', 'myshopify.com', 'wixsite.com', 'wordpress.com',
];

// İki seviyeli kamu son ekleri (tam PSL yerine küçük liste; bilinmeyen 2 harfli ccTLD'de GENERIC_SLD geri dönüşü var).
const TWO_LEVEL = new Set([
  ...['com', 'net', 'org', 'gen', 'biz', 'info', 'web', 'edu', 'gov', 'k12', 'av', 'bel', 'pol', 'tsk', 'dr', 'bbs', 'name',
    'tel', 'tv', 'kep', 'mil'].map(s => `${s}.tr`),
  ...['co', 'org', 'ac', 'gov', 'me', 'ltd', 'plc', 'net'].map(s => `${s}.uk`),
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'co.za',
  'co.in', 'com.ar', 'com.ua', 'com.cy', 'com.mt', 'com.gi', 'co.il', 'com.sg', 'com.hk', 'com.tw',
  // gTLD üzerinde kayıt operatörü son ekleri (CentralNic vb.)
  'br.com', 'us.com', 'uk.com', 'eu.org', 'sa.com', 'ru.com', 'de.com', 'cn.com', 'jpn.com', 'gb.net',
]);
const GENERIC_SLD = new Set(['com', 'net', 'org', 'co', 'edu', 'gov', 'ac', 'gen', 'biz', 'info', 'web', 'nom', 'ne', 'or',
  'go', 'mil', 'ltd', 'plc', 'sch']);
const SPECIAL_SUFFIX = /\.(arpa|local|lan|home|internal|localdomain)$/;

// Bir adın kendisi ve tüm üst son ekleri (dnsmasq `ipset=/base/` eşleşmesiyle birebir: fqdn === base || *.base).
function suffixesOf(fqdn: string): string[] {
  const labels = fqdn.split('.');
  return labels.map((_, i) => labels.slice(i).join('.'));
}
export function coveredBy(fqdn: string, bases: Set<string>): boolean {
  return suffixesOf(fqdn).some(s => bases.has(s));
}

// Gruplama anahtarı: kayıtlı alan adı (eTLD+1); paylaşımlı ana makinede tam host; ad kendisi bir son ekse null.
export function registrableKey(fqdn: string): string | null {
  if (SHARED_HOST_SUFFIXES.some(s => fqdn.endsWith('.' + s))) return fqdn;
  if (SHARED_HOST_SUFFIXES.includes(fqdn)) return null;
  const labels = fqdn.split('.');
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const n = TWO_LEVEL.has(`${sld}.${tld}`) || (tld.length === 2 && GENERIC_SLD.has(sld)) ? 3 : 2;
  return labels.length < n ? null : labels.slice(-n).join('.');
}

// Eklenecek kural: görülen adların en uzun ortak son eki (hep anahtarla biter). Tek ad görüldüyse o ad; kayıtlı alan
// adının tamamı ancak en az iki farklı alt adres görüldüyse önerilir — tek gözlemden geniş kural çıkmasın.
export function suggestionTarget(key: string, fqdns: string[]): string {
  const uniq = [...new Set(fqdns)];
  if (uniq.length <= 1) return uniq[0] || key;
  const rev = uniq.map(f => f.split('.').reverse());
  const common: string[] = [];
  for (let i = 0; rev[0][i] !== undefined && rev.every(r => r[i] === rev[0][i]); i++) common.push(rev[0][i]);
  const target = common.reverse().join('.');
  return target.length >= key.length ? target : key;
}

function normalizeName(raw: unknown): string | null {
  const f = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!f.includes('.') || f === 'pi.hole' || SPECIAL_SUFFIX.test(f)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(f) || !VALID_DNSMASQ_DOMAIN.test(f) || f.startsWith('*.')) return null;
  return f;
}

// ─── FTL okuma (salt okunur; immutable YOK — FTL dakikada bir yazarken yırtık okuma riski) ───
function ftlAll(db: sqlite3.Database, sql: string, params: unknown[]): Promise<any[]> {
  return new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows || []))));
}
async function withFtlDb<T>(fn: (db: sqlite3.Database) => Promise<T>): Promise<T> {
  if (!fs.existsSync(FTL_DB)) throw new Error('FTL veritabanı bulunamadı');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const d = new sqlite3.Database(FTL_DB, sqlite3.OPEN_READONLY, e => (e ? reject(e) : resolve(d)));
  });
  db.configure('busyTimeout', 3000);
  // Tek seferlik interrupt iki ifade arasında düşerse kaybolur (etkin VDBE yokken SQLite bayrağı temizler) → son
  // tarihten sonra, iş bitene kadar tekrar tekrar kesilir.
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  const timer = setInterval(() => { if (Date.now() >= deadline) db.interrupt(); }, 200);
  try {
    return await fn(db);
  } finally {
    clearInterval(timer);
    db.close(() => {});
  }
}

let privacyCache: { at: number; level: number | null } | null = null;
async function privacyLevel(): Promise<number | null> {
  if (privacyCache && Date.now() - privacyCache.at < 300000) return privacyCache.level;
  let level: number | null = null;
  try {
    const { stdout } = await execFileAsync('pihole-FTL', ['--config', 'misc.privacylevel'], { timeout: 5000 });
    const n = Number(stdout.trim().split('\n').pop());
    level = Number.isFinite(n) ? n : null; // v5'te --config yok → sayı değil → kontrol atlanır
  } catch { level = null; }
  privacyCache = { at: Date.now(), level };
  return level;
}

// ─── Hesaplama ───
interface Anchor { id: number; base: string }
interface Interval { start: number; end: number; visit: string }
interface CachedItem { key: string; domain: string; samples: string[]; fqdns: string[]; visits: number; clients: number; last_seen: number }
interface CachedRule { rule_id: number; visits: number; hidden_background: number; items: CachedItem[] }
interface Computed { truncated: boolean; rules: Map<number, CachedRule> }

// Birleştirilmiş, sıralı, çakışmayan aralıklarda ikili arama.
function findInterval(list: Interval[], t: number): Interval | null {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].end < t) lo = mid + 1;
    else if (list[mid].start > t) hi = mid - 1;
    else return list[mid];
  }
  return null;
}

const minuteOf = (t: number) => Math.floor(t / 60);

async function compute(anchors: Anchor[], covered: Set<string>, hours: number): Promise<Computed> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - hours * 3600;
  const likeEsc = (s: string) => s.replace(/[\\%_]/g, '\\$&');
  const byBase = new Map(anchors.map(a => [a.base, a.id]));
  const ruleOf = (fqdn: string) => { for (const s of suffixesOf(fqdn)) { const id = byBase.get(s); if (id !== undefined) return id; } return undefined; };
  const common = `timestamp >= ? AND timestamp < ? AND type IN (${QUERY_TYPES}) AND status IN (${ANSWERED_STATUS})`;

  return withFtlDb(async db => {
    // Q1: başlangıç noktaları, SQL'de (cihaz, ad, 10 sn) başına tek satır. FTL v6.5 `queries` görünümü adı satır başına
    // ilişkili alt sorguyla çözer: kural koşulları küçük domain_by_id tablosunda BİR KEZ değerlendirilir (her koşulu satır
    // başına ayrı alt sorguyla çalıştırmak 50 kuralda Pi'de zaman aşımına giriyordu). Tablo yoksa (eski şema) doğrudan koşul.
    const conds = anchors.map(() => `domain = ? OR domain LIKE ? ESCAPE '\\'`).join(' OR ');
    const condParams = anchors.flatMap(a => [a.base, `%.${likeEsc(a.base)}`]);
    const q1Sql = (filter: string) => `SELECT client, domain, MIN(timestamp) AS t FROM queries WHERE ${common} AND ${filter}
       GROUP BY client, domain, CAST(timestamp / 10 AS INTEGER) ORDER BY t DESC LIMIT ${Q1_LIMIT}`;
    let q1: any[];
    try {
      q1 = await ftlAll(db, q1Sql(`domain IN (SELECT domain FROM domain_by_id WHERE ${conds})`), [since, now, ...condParams]);
    } catch (e: any) {
      if (!/no such table/i.test(String(e?.message))) throw e;
      q1 = await ftlAll(db, q1Sql(`(${conds})`), [since, now, ...condParams]);
    }
    const q1Truncated = q1.length >= Q1_LIMIT;
    const anchorTimes = new Map<string, Map<number, number[]>>(); // cihaz → kural → zamanlar
    const perClient = new Map<string, number>();
    for (const r of q1) {
      const fqdn = normalizeName(r.domain);
      const rule = fqdn ? ruleOf(fqdn) : undefined;
      if (rule === undefined) continue;
      const c = String(r.client);
      if (!anchorTimes.has(c)) anchorTimes.set(c, new Map());
      const m = anchorTimes.get(c)!;
      if (!m.has(rule)) m.set(rule, []);
      m.get(rule)!.push(Number(r.t));
      perClient.set(c, (perClient.get(c) || 0) + 1);
    }
    const clients = [...perClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CLIENTS).map(e => e[0]);
    if (!clients.length) return { truncated: q1Truncated, rules: new Map() };

    // Q2: aynı cihazların tüm cevaplanmış sorguları, (cihaz, ad, dakika) başına tek satır; dakikadaki ilk ve son sorgu.
    const q2 = await ftlAll(db,
      `SELECT client, domain, CAST(timestamp / 60 AS INTEGER) AS b, MIN(timestamp) AS t0, MAX(timestamp) AS t1 FROM queries
       WHERE ${common} AND client IN (${clients.map(() => '?').join(',')})
       GROUP BY client, domain, b ORDER BY b DESC LIMIT ${Q2_LIMIT}`,
      [since, now, ...clients]);
    const q2Truncated = q2.length >= Q2_LIMIT;
    // Kesilen sorgularda güvenilir aralık: Q2'nin en eski (yarım kalmış olabilecek) dakikası tamamen dışarıda kalır;
    // Q1 kesildiyse en eski başlangıçtan sonraki W_AFTER sn de (öncesindeki eksik başlangıçların pencereleri).
    let effSince = since;
    if (q2Truncated) effSince = Math.max(effSince, (Number(q2[q2.length - 1].b) + 1) * 60 + W_BEFORE);
    if (q1Truncated) effSince = Math.max(effSince, Number(q1[q1.length - 1].t) + W_AFTER);

    // Cihaz etkinliği (dakika): yoğunluk eşiği ve lift paydaları.
    const active = new Map<string, Set<number>>();
    for (const r of q2) {
      if (Number(r.t1) < effSince) continue;
      const c = String(r.client);
      if (!active.has(c)) active.set(c, new Set());
      active.get(c)!.add(Number(r.b));
    }

    // Ziyaretler (aralarında ≤ SESSION_GAP olan başlangıçlar; yalnız sayım ve sahiplik için) ve eş-yükleme pencereleri.
    type Sess = { client: string; rule: number; end: number; visit: string; times: number[] };
    const sessionsByRule = new Map<number, Sess[]>();
    for (const c of clients) {
      const act = active.get(c)?.size || 0;
      for (const [rule, raw] of anchorTimes.get(c) || new Map<number, number[]>()) {
        const times = raw.filter(t => t + W_AFTER >= effSince).sort((a, b) => a - b);
        if (!times.length) continue;
        const anchorMinutes = new Set(times.map(minuteOf)).size;
        if (anchorMinutes >= MIN_DUTY_MINUTES && act > 0 && anchorMinutes / act > MAX_ANCHOR_DUTY) continue;
        let cur: Sess | null = null;
        for (const t of times) {
          if (!cur || t - cur.times[cur.times.length - 1] > SESSION_GAP) {
            cur = { client: c, rule, end: t, visit: `${c}#${rule}#${t}`, times: [] };
            if (!sessionsByRule.has(rule)) sessionsByRule.set(rule, []);
            sessionsByRule.get(rule)!.push(cur);
          }
          cur.times.push(t);
          cur.end = t;
        }
      }
    }
    const windows = new Map<string, Map<number, Interval[]>>(); // cihaz → kural → birleşik pencereler
    const inWindow = new Map<string, Set<number>>();            // cihaz → herhangi bir pencereye düşen dakikalar
    const ruleVisits = new Map<number, number>();
    for (const [rule, list] of sessionsByRule) {
      const kept = list.sort((a, b) => b.end - a.end).slice(0, MAX_SESSIONS_PER_RULE);
      ruleVisits.set(rule, kept.length);
      for (const s of kept) {
        if (!windows.has(s.client)) windows.set(s.client, new Map());
        const wm = windows.get(s.client)!;
        if (!wm.has(rule)) wm.set(rule, []);
        const wl = wm.get(rule)!;
        if (!inWindow.has(s.client)) inWindow.set(s.client, new Set());
        const iw = inWindow.get(s.client)!;
        for (const t of s.times) {
          const last = wl[wl.length - 1];
          if (last && last.visit === s.visit && t - W_BEFORE <= last.end) last.end = Math.max(last.end, t + W_AFTER);
          else wl.push({ start: t - W_BEFORE, end: t + W_AFTER, visit: s.visit });
          for (let b = minuteOf(t - W_BEFORE); b <= minuteOf(t + W_AFTER); b++) iw.add(b);
        }
      }
    }
    for (const wm of windows.values()) for (const wl of wm.values()) wl.sort((a, b) => a.start - b.start);

    // Tek geçiş: anahtar başına pencere içi/dışı dakikalar ve kural başına eş-yükleme. Bir (cihaz, ad, dakika) satırı,
    // dakikadaki ilk ya da son sorgusu bir pencereye düşüyorsa eş-yüklenmiş sayılır (pencere 80 sn > dakika → kesin).
    const keyIn = new Map<string, Set<string>>();
    const keyOut = new Map<string, Set<string>>();
    type Co = { visits: Set<string>; clients: Set<string>; last: number; fqdn: Map<string, number> };
    const co = new Map<number, Map<string, Co>>();
    for (const r of q2) {
      const t0 = Number(r.t0);
      const t1 = Number(r.t1);
      if (t1 < effSince) continue;
      const c = String(r.client);
      const b = Number(r.b);
      const fqdn = normalizeName(r.domain);
      if (!fqdn || coveredBy(fqdn, covered) || coveredBy(fqdn, IGNORE)) continue;
      const key = registrableKey(fqdn);
      if (!key) continue;
      const bucketSet = inWindow.get(c)?.has(b) ? keyIn : keyOut;
      if (!bucketSet.has(key)) bucketSet.set(key, new Set());
      bucketSet.get(key)!.add(`${c}|${b}`);
      for (const [rule, wl] of windows.get(c) || new Map<number, Interval[]>()) {
        const w = findInterval(wl, t0) || findInterval(wl, t1);
        if (!w) continue;
        if (!co.has(rule)) co.set(rule, new Map());
        const cm = co.get(rule)!;
        if (!cm.has(key)) cm.set(key, { visits: new Set(), clients: new Set(), last: 0, fqdn: new Map() });
        const e = cm.get(key)!;
        e.visits.add(w.visit);
        e.clients.add(c);
        e.last = Math.max(e.last, t1);
        e.fqdn.set(fqdn, (e.fqdn.get(fqdn) || 0) + 1);
      }
    }

    // Arka plan (lift) testi: ad, pencere dışında da pencere içindekine yakın sıklıkta etkinse sitenin parçası değildir.
    let inActive = 0, outActive = 0;
    for (const [c, bs] of active) {
      const iw = inWindow.get(c);
      for (const b of bs) { if (iw?.has(b)) inActive++; else outActive++; }
    }
    const isBackground = (key: string) => {
      const inN = keyIn.get(key)?.size || 0;
      const outN = keyOut.get(key)?.size || 0;
      if (outN < MIN_OUTSIDE_BUCKETS || !outActive || !inActive) return false;
      return (inN / inActive) / (outN / outActive) < MIN_LIFT;
    };

    // Her anahtar tek kurala: kuralın ziyaretlerinin en büyük bölümünde görüldüğü kural (sonra ziyaret sayısı, sonra küçük
    // id). Sayıya göre seçmek, sık ziyaret edilen bir kuralın başka sitenin gerçek yardımcılarını kapmasına yol açıyordu.
    const ratio = (rule: number, e: Co) => e.visits.size / Math.max(1, ruleVisits.get(rule) || 0);
    const owner = new Map<string, number>();
    for (const [rule, cm] of co) for (const [key, e] of cm) {
      const o = owner.get(key);
      if (o === undefined) { owner.set(key, rule); continue; }
      const oe = co.get(o)!.get(key)!;
      if ((ratio(rule, e) - ratio(o, oe) || e.visits.size - oe.visits.size || o - rule) > 0) owner.set(key, rule);
    }
    const rules = new Map<number, CachedRule>();
    for (const [rule, visits] of ruleVisits) {
      const items: CachedItem[] = [];
      let hidden = 0;
      for (const [key, e] of co.get(rule) || new Map<string, Co>()) {
        if (owner.get(key) !== rule) continue;
        if (isBackground(key)) { hidden++; continue; }
        const fqdns = [...e.fqdn.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, MAX_FQDNS);
        items.push({
          key, domain: suggestionTarget(key, fqdns), samples: fqdns.slice(0, MAX_SAMPLES), fqdns,
          visits: e.visits.size, clients: e.clients.size, last_seen: e.last,
        });
      }
      items.sort((a, b) => b.visits - a.visits || b.clients - a.clients || b.last_seen - a.last_seen);
      rules.set(rule, { rule_id: rule, visits, hidden_background: hidden, items: items.slice(0, MAX_CACHED_ITEMS) });
    }
    return { truncated: q1Truncated || q2Truncated, rules };
  });
}

// Önbellek: aynı saat aralığı + aynı başlangıç kuralları için 60 sn; eşzamanlı istekler aynı hesaplamayı bekler. Hata da
// TTL boyunca önbellekte kalır: 2 dk'lık yoklama başarısız 10 sn'lik taramayı tekrar tekrar başlatmasın.
let cache: { sig: string; at: number; promise: Promise<Computed> } | null = null;

export interface SuggestionsInput { anchors: { id: number; domain: string }[]; covered: string[]; dismissed: string[]; hours: number }
export async function getRoutingSuggestions(input: SuggestionsInput) {
  const window = { hours: input.hours, before_s: W_BEFORE, after_s: W_AFTER };
  const base = { generated_at: new Date().toISOString(), window, truncated: false };
  if (!isLinux) return { ...base, available: false, reason: 'unsupported', rules: [] };
  const level = await privacyLevel();
  if (level !== null && level > 0) return { ...base, available: false, reason: 'privacy', rules: [] };

  const anchors: Anchor[] = input.anchors
    .map(a => ({ id: Number(a.id), base: String(a.domain).trim().toLowerCase().replace(/^\*\./, '') }))
    .filter(a => Number.isInteger(a.id) && a.base.length > 0 && VALID_DNSMASQ_DOMAIN.test(a.base))
    .slice(0, MAX_ANCHOR_RULES);
  if (!anchors.length) return { ...base, available: true, reason: null, rules: [] };
  const covered = new Set(input.covered.map(d => d.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean));

  const sig = `${input.hours}|${anchors.map(a => `${a.id}:${a.base}`).sort().join(',')}`;
  if (!cache || cache.sig !== sig || Date.now() - cache.at > CACHE_TTL_MS) {
    const promise = compute(anchors, covered, input.hours);
    promise.catch(() => { /* hata aşağıda, yanıt anında işlenir */ });
    cache = { sig, at: Date.now(), promise };
  }
  let computed: Computed;
  try {
    computed = await cache.promise;
  } catch (e: any) {
    const reason = /INTERRUPT/i.test(String(e?.code || e?.message)) ? 'timeout' : 'db';
    console.error(`[routing] öneriler hesaplanamadı (${reason}): ${e?.message || e}`);
    return { ...base, available: false, reason, rules: [] };
  }

  // Yanıt anında güncel kapsam ve yoksayılanlarla yeniden süz: yeni eklenen öneri FTL yeniden okunmadan düşer.
  const dismissed = new Set(input.dismissed.map(d => d.toLowerCase()));
  const rules = anchors
    .map(a => computed.rules.get(a.id) && { a, r: computed.rules.get(a.id)! })
    .filter((x): x is { a: Anchor; r: CachedRule } => !!x && x.r.visits > 0)
    .map(({ a, r }) => {
      const live = r.items.filter(it => !dismissed.has(it.key) && !dismissed.has(it.domain)
        && !coveredBy(it.domain, covered) && !it.fqdns.every(f => coveredBy(f, covered)));
      return {
        rule_id: r.rule_id, domain: a.base, visits: r.visits, hidden_background: r.hidden_background,
        more: Math.max(0, live.length - MAX_RULE_ITEMS),
        suggestions: live.slice(0, MAX_RULE_ITEMS).map(it => ({
          key: it.key, domain: it.domain, samples: it.samples, visits: it.visits, clients: it.clients,
          last_seen: new Date(it.last_seen * 1000).toISOString(),
        })),
      };
    });
  return { ...base, truncated: computed.truncated, available: true, reason: null, rules };
}

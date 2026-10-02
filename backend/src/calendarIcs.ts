// Dış takvim (ICS, RFC 5545) ayrıştırıcı ve açıcı — SAF ve bağımlılıksız (G5.2). Ağ, dosya, veritabanı yok: calendarSync.ts
// takvim metnini verir, burası olayları istenen ufuk içindeki oluşumlara açar.
//  - Desteklenen alt küme: satır katlama; VEVENT (VALARM / VTIMEZONE içindeki alanlar olaya karışmaz); DTSTART / DTEND /
//    DURATION (UTC, TZID, dilimsiz "yüzen" saat, DATE = tüm gün; DTEND hariç); SUMMARY; CATEGORIES; STATUS:CANCELLED; RRULE
//    (FREQ DAILY / WEEKLY / MONTHLY / YEARLY; INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, WKST); EXDATE;
//    RECURRENCE-ID geçersiz kılmaları.
//  - TZID → UTC: Node'un Intl'i (IANA adları); Outlook'un Windows dilim adları için gömülü CLDR windowsZones tablosu. Yüzen
//    saat takvimin X-WR-TIMEZONE'u, yoksa Pi'nin dilimiyle; tüm gün olaylar Pi'nin diliminde gece yarısından gece yarısına.
//  - Çözülemeyen dilim ya da desteklenmeyen tekrarlama kuralı: olay "çözülemedi" (unresolved) işaretiyle döner — saat Pi'nin
//    diliminde tahmin, kural yerine yalnız ilk tarih. Bu işaretli oluşumlar HİÇBİR ZAMAN bir eylemi tetiklemez (sonraki
//    sürümlerin etiket → kural bağlaması unresolved'ı her zaman dışarıda bırakır).
//  - Sınırlar (lite 512 MB için de): ufuk çağıranın [from, to) aralığı; olay başına en çok 500, toplam en çok 5000 oluşum
//    (sınırda zamanca EN YAKIN 5000 kalır); en çok 20 000 VEVENT; dakika / saat / saniye sıklığı yok; kural başına en çok
//    200 000 dönem, takvim başına toplam MAX_WORK tarama adımı (aşılınca kalan tekrarlar "çözülemedi: çok uzun"); iç içe
//    bileşen derinliği en çok 8; olay başına en çok 50 kategori ve 2000 EXDATE; takvimde en çok 64 farklı saat dilimi.
//  - Ayrıştırma ve açılım ~8 ms'lik dilimlerle ilerler: zaman uyumsuz sürümler (parseIcsAsync / expandIcsAsync) her dilimden
//    sonra olay döngüsüne döner — 2 MB'lık kötü niyetli bir takvim de paneli kilitlemez.
// Etiketler: yalnız SUMMARY'deki tam "#etiket" belirteçleri ve CATEGORIES'in tam değerleri (DESCRIPTION okunmaz). Karşılaştırma
// Türkçe büyük / küçük harf duyarsız ama harf eşlemesiz: "#SINAV" = "#Sınav" ≠ "#Sinav"; diyezsiz kelime etiket değildir.

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
export const MAX_PER_EVENT = 500;
export const MAX_TOTAL = 5000;
export const MAX_EVENTS = 20_000;
const MAX_PERIODS = 200_000;
export const MAX_WORK = 2_000_000;
const MAX_DEPTH = 8;
const MAX_CATEGORIES = 50;
const MAX_EXDATES = 2000;
const MAX_RRULE_LEN = 1000;
const MAX_ZONES_PER_RUN = 64;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 64;
const MAX_SUMMARY = 200;
const SLICE_MS = 8;

// Zaman dilimi (iş bölme): uzun döngüler her ~8 ms'de bir "nefes" ister; zaman uyumsuz sürücü setImmediate ile olay döngüsüne
// döner, eşzamanlı sürücü doğrudan devam eder. Saat 64 adımda bir okunur (performance.now ucuz ama bedava değil).
class Slicer {
  private at = performance.now() + SLICE_MS;
  private n = 0;
  due(): boolean {
    if ((++this.n & 63) !== 0) return false;
    return performance.now() >= this.at;
  }
  resume(): void { this.at = performance.now() + SLICE_MS; }
}
function drive<T>(it: Generator<void, T>): T {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
async function driveAsync<T>(it: Generator<void, T>): Promise<T> {
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>(res => setImmediate(res));
  }
}

// ── Saat dilimi ──────────────────────────────────────────────────────────────
// off(t): t anında (UTC ms) UTC'den ileri dakika
export interface Zone { id: string; off(t: number): number }
export const UTC_ZONE: Zone = { id: 'UTC', off: () => 0 };
// Pi'nin (sürecin) dilimi: Date ile — TZ ortam değişkeni ve /etc/localtime'ı izler
export const PROCESS_ZONE: Zone = { id: 'local', off: t => -new Date(t).getTimezoneOffset() };

// IANA adıyla dilim. Önbelleğe yalnız ÇÖZÜLEN adlar girer (en çok 64 dilim; aşınca boşalır) ve anahtar takvim metninden
// koparılır: TZID değeri belgenin bir dilimidir (V8 "sliced string") — önbellekte kalsa 2 MB'lık belgenin tamamını kalıcı
// olarak tutardı. Çözülemeyen adlar yalnız açılım boyunca hatırlanır (Ctx.zones).
// off(): saat kovası önbelleği — kovanın başında ve sonunda ofset aynıysa kova boyunca sabittir (geçişler tam dakikada, bir
// saatte en çok bir geçiş); farklıysa (geçiş saati) dakika dakika hesaplanır. Kova sayısı dilim başına sınırlı (≈ 170 gün).
const ZONE_CACHE_MAX = 64;
const ZONE_BUCKETS_MAX = 4096;
const ianaCache = new Map<string, Zone>();
export function ianaZone(tz: string): Zone | null {
  const hit = ianaCache.get(tz);
  if (hit) return hit;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return null;
  const id = Buffer.from(tz, 'utf8').toString('utf8');
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: id, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return null;
  }
  // t (tam dakika, UTC ms) anındaki ofset (dakika)
  const exact = (t: number): number => {
    const p: Record<string, string> = {};
    for (const x of fmt.formatToParts(new Date(t))) p[x.type] = x.value;
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return Math.round((wall - t) / MIN_MS);
  };
  const edges = new Map<number, number>();   // saat kovasının başı → ofset
  const mins = new Map<number, number>();    // geçiş saatlerinde dakika → ofset
  const edge = (h: number): number => {
    let o = edges.get(h);
    if (o === undefined) {
      o = exact(h * HOUR_MS);
      if (edges.size >= ZONE_BUCKETS_MAX) edges.clear();
      edges.set(h, o);
    }
    return o;
  };
  const z: Zone = {
    id,
    off: t => {
      const h = Math.floor(t / HOUR_MS);
      const a = edge(h);
      if (edge(h + 1) === a) return a;
      const k = Math.floor(t / MIN_MS);
      let o = mins.get(k);
      if (o === undefined) {
        o = exact(k * MIN_MS);
        if (mins.size >= 1024) mins.clear();
        mins.set(k, o);
      }
      return o;
    },
  };
  if (ianaCache.size >= ZONE_CACHE_MAX) ianaCache.clear();
  ianaCache.set(id, z);
  return z;
}

// CLDR windowsZones (territory "001"): Outlook / Exchange'in yazdığı Windows dilim adı → IANA. Kaynak: unicode-org/cldr
// common/supplemental/windowsZones.xml. Ad büyük / küçük harf duyarsız aranır.
export const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12', 'UTC-11': 'Etc/GMT+11', 'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Marquesas Standard Time': 'Pacific/Marquesas', 'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9', 'Pacific Standard Time (Mexico)': 'America/Tijuana', 'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles', 'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan', 'Mountain Standard Time': 'America/Denver', 'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala', 'Central Standard Time': 'America/Chicago', 'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City', 'Canada Central Standard Time': 'America/Regina', 'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun', 'Eastern Standard Time': 'America/New_York', 'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana', 'US Eastern Standard Time': 'America/Indiana/Indianapolis', 'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion', 'Atlantic Standard Time': 'America/Halifax', 'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba', 'SA Western Standard Time': 'America/La_Paz', 'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns', 'Tocantins Standard Time': 'America/Araguaina', 'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires', 'Greenland Standard Time': 'America/Nuuk',
  'Montevideo Standard Time': 'America/Montevideo', 'Magallanes Standard Time': 'America/Punta_Arenas', 'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia', 'UTC-02': 'Etc/GMT+2', 'Mid-Atlantic Standard Time': 'Etc/GMT+2', 'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde', 'UTC': 'Etc/UTC', 'Coordinated Universal Time': 'Etc/UTC', 'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik', 'Sao Tome Standard Time': 'Africa/Sao_Tome', 'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw', 'W. Central Africa Standard Time': 'Africa/Lagos', 'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest', 'Middle East Standard Time': 'Asia/Beirut', 'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau', 'Syria Standard Time': 'Asia/Damascus', 'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg', 'FLE Standard Time': 'Europe/Kyiv', 'Israel Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba', 'Kaliningrad Standard Time': 'Europe/Kaliningrad', 'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli', 'Namibia Standard Time': 'Africa/Windhoek', 'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul', 'Arab Standard Time': 'Asia/Riyadh', 'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow', 'E. Africa Standard Time': 'Africa/Nairobi', 'Volgograd Standard Time': 'Europe/Volgograd',
  'Iran Standard Time': 'Asia/Tehran', 'Arabian Standard Time': 'Asia/Dubai', 'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku', 'Russia Time Zone 3': 'Europe/Samara', 'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov', 'Georgian Standard Time': 'Asia/Tbilisi', 'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul', 'West Asia Standard Time': 'Asia/Tashkent', 'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg', 'Pakistan Standard Time': 'Asia/Karachi', 'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo', 'Nepal Standard Time': 'Asia/Kathmandu', 'Central Asia Standard Time': 'Asia/Bishkek',
  'Bangladesh Standard Time': 'Asia/Dhaka', 'Omsk Standard Time': 'Asia/Omsk', 'Myanmar Standard Time': 'Asia/Yangon',
  'SE Asia Standard Time': 'Asia/Bangkok', 'Altai Standard Time': 'Asia/Barnaul', 'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk', 'N. Central Asia Standard Time': 'Asia/Novosibirsk', 'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai', 'North Asia East Standard Time': 'Asia/Irkutsk', 'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth', 'Taipei Standard Time': 'Asia/Taipei', 'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla', 'Transbaikal Standard Time': 'Asia/Chita', 'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang', 'Korea Standard Time': 'Asia/Seoul', 'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide', 'AUS Central Standard Time': 'Australia/Darwin', 'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'West Pacific Standard Time': 'Pacific/Port_Moresby', 'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok', 'Lord Howe Standard Time': 'Australia/Lord_Howe', 'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk', 'Magadan Standard Time': 'Asia/Magadan', 'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin', 'Central Pacific Standard Time': 'Pacific/Guadalcanal', 'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland', 'UTC+12': 'Etc/GMT-12', 'Fiji Standard Time': 'Pacific/Fiji', 'Kamchatka Standard Time': 'Asia/Kamchatka',
  'Chatham Islands Standard Time': 'Pacific/Chatham', 'UTC+13': 'Etc/GMT-13', 'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia', 'Line Islands Standard Time': 'Pacific/Kiritimati',
};
const WINDOWS_LC = new Map(Object.entries(WINDOWS_ZONES).map(([k, v]) => [k.toLowerCase(), v]));

// TZID → dilim: IANA adı, Windows adı ya da "/mozilla.org/…/Europe/Berlin" gibi önekli IANA adı. Çözülemezse null.
export function resolveZone(tzid: string | null | undefined): Zone | null {
  const t = String(tzid ?? '').trim().replace(/^"|"$/g, '');
  if (!t) return null;
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt|etc\/zulu)$/i.test(t)) return UTC_ZONE;
  const win = WINDOWS_LC.get(t.toLowerCase());
  if (win) return ianaZone(win);
  const iana = ianaZone(t);
  if (iana) return iana;
  if (t.startsWith('/')) {
    const seg = t.split('/').filter(Boolean);
    for (const n of [3, 2]) {
      if (seg.length >= n) {
        const z = ianaZone(seg.slice(-n).join('/'));
        if (z) return z;
      }
    }
  }
  return null;
}

// Dilimin duvar saati → UTC anı. İki kez yaşanan saatte (geri alma) ilk yaşanış; atlanan saatte (ileri alma) geçişten önceki
// ofset — duvar saati ileri kayar (RFC 5545 3.3.5).
export function wallToUtc(z: Zone, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const w = Date.UTC(y, mo - 1, d, h, mi, s);
  const oA = z.off(w - DAY_MS), oB = z.off(w + DAY_MS);
  const cands: number[] = [];
  for (const o of oA === oB ? [oA] : [oA, oB]) {
    const t = w - o * MIN_MS;
    if (z.off(t) === o) cands.push(t);
  }
  if (cands.length) return Math.min(...cands);
  return w - oA * MIN_MS;
}

// ── Satır düzeyi ─────────────────────────────────────────────────────────────
// Ham baytlardan metin: katlama (CRLF / LF + boşluk ya da sekme) UTF-8 çözümünden ÖNCE bayt düzeyinde açılır — 75 sekizlide
// katlayan üreticiler çok baytlı harfi (ı, ş, ğ) ikiye bölebilir (RFC 5545 3.1 notu).
export function decodeIcsBytes(buf: Uint8Array): string {
  const out = new Uint8Array(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d && buf[i + 1] === 0x0a && (buf[i + 2] === 0x20 || buf[i + 2] === 0x09)) { i += 2; continue; }
    if (b === 0x0a && (buf[i + 1] === 0x20 || buf[i + 1] === 0x09)) { i += 1; continue; }
    out[n++] = b;
  }
  return new TextDecoder('utf-8').decode(out.subarray(0, n));
}
// Katlanmış satırları açarak tek tek verir: bütün belge satır dizisine bölünmez (2 MB'lık belgede bellek ve dilimsiz iş az)
export function* iterLines(text: string): Generator<string> {
  const str = String(text ?? '');
  const re = /\r\n|\n|\r/g;
  let pos = str.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cur: string | null = null;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(str);
    const end = m ? m.index : str.length;
    const l = str.slice(pos, end);
    if ((l.startsWith(' ') || l.startsWith('\t')) && cur !== null) cur += l.slice(1);
    else {
      if (cur !== null) yield cur;
      cur = l;
    }
    if (!m) break;
    pos = end + m[0].length;
  }
  if (cur !== null) yield cur;
}
export function unfoldLines(text: string): string[] {
  return [...iterLines(text)];
}

export interface ContentLine { name: string; params: Map<string, string>; value: string }
// "AD;PARAM=değer;PARAM="tırnaklı:değer":DEĞER" — biçimsiz satır null
export function parseContentLine(line: string): ContentLine | null {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,64}$/.test(name)) return null;
  const params = new Map<string, string>();
  while (i < n && line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return null;
    const pname = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let val = '';
    for (;;) {
      if (line[i] === '"') {
        const end = line.indexOf('"', i + 1);
        if (end < 0) return null;
        val += line.slice(i + 1, end);
        i = end + 1;
      } else {
        let j = i;
        while (j < n && line[j] !== ';' && line[j] !== ':' && line[j] !== ',') j++;
        val += line.slice(i, j);
        i = j;
      }
      if (line[i] === ',') { val += ','; i++; continue; }
      break;
    }
    if (pname) params.set(pname, val);
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

// TEXT değeri: \\ \; \, \n çözülür
export const unescapeText = (v: string) => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
// Kaçışsız virgülle bölünmüş TEXT listesi (CATEGORIES); en çok max öğe (gerisi okunmaz)
export function splitTextList(v: string, max = Infinity): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\' && i + 1 < v.length) { cur += c + v[i + 1]; i++; continue; }
    if (c === ',') {
      out.push(unescapeText(cur));
      cur = '';
      if (out.length >= max) return out;
      continue;
    }
    cur += c;
  }
  out.push(unescapeText(cur));
  return out;
}

// ── Zaman değerleri ──────────────────────────────────────────────────────────
export interface IcsTime {
  date: boolean;              // DATE (tüm gün): saat alanları 0
  y: number; mo: number; d: number; h: number; mi: number; s: number;
  utc: boolean;               // "Z" ile biten
  tzid: string | null;        // TZID parametresi (UTC ve DATE'te null)
}
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
export function parseIcsTime(value: string, params?: Map<string, string>): IcsTime | null {
  const v = String(value ?? '').trim();
  const isDate = (params?.get('VALUE') || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(v);
  const m = isDate ? /^(\d{4})(\d{2})(\d{2})$/.exec(v) : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  if (isDate) return { date: true, y, mo, d, h: 0, mi: 0, s: 0, utc: false, tzid: null };
  const h = Number(m[4]), mi = Number(m[5]), s = Math.min(59, Number(m[6] ?? 0));
  if (h > 23 || mi > 59) return null;
  const utc = !!m[7];
  const tz = params?.get('TZID');
  return { date: false, y, mo, d, h, mi, s, utc, tzid: utc ? null : (tz ? tz.trim() : null) };
}

// DURATION: nominal gün (W, D) + kesin süre (H, M, S). Eksi ya da boş → null.
export interface Dur { days: number; ms: number }
export function parseDuration(v: string): Dur | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v ?? '').trim());
  if (!m || m[1] === '-' || m.slice(2).every(x => x === undefined)) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  return { days: n(2) * 7 + n(3), ms: (n(4) * 3600 + n(5) * 60 + n(6)) * 1000 };
}

// ── Ayrıştırma ───────────────────────────────────────────────────────────────
export interface IcsEvent {
  uid: string; summary: string; categories: string[]; status: string;
  dtstart: IcsTime | null; dtend: IcsTime | null; duration: Dur | null;
  // Değeri okunamayan zaman alanı (bozuk / eksi DURATION, bozuk DTEND, bozuk ya da çok sayıda EXDATE): olay "çözülemedi"
  durationBad: boolean; dtendBad: boolean; exdateBad: boolean;
  rrule: string | null; rdate: boolean; exdates: IcsTime[]; recurrenceId: IcsTime | null;
  rdateLast: number | null;   // RDATE'lerin en geç günü (gün numarası; okunamazsa Infinity) — yalnız "bitti mi" uyarısı için
  range: string;              // RECURRENCE-ID;RANGE= (THISANDFUTURE desteklenmez → sonraki oluşumlar "çözülemedi")
  // RECURRENCE-ID var ama değeri okunamadı: hangi oluşumu değiştirdiği bilinmez — ana olay sayılmaz, kendi zamanıyla tek kayıt,
  // çözülemedi (time; dilimi de tanınmıyorsa tz); ana olayın oluşumları olduğu gibi kalır
  ridBad: boolean;
}
export interface ParsedIcs {
  isCalendar: boolean;        // BEGIN:VCALENDAR görüldü (HTML giriş sayfası vb. değil)
  events: IcsEvent[];
  xwrTimezone: string | null; calName: string | null;
  badLines: number;           // biçimsiz satır (atlandı)
  truncated: boolean;         // MAX_EVENTS aşıldı
}
const cleanSummary = (v: string) => unescapeText(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);

// Eşzamanlı: testler ve küçük takvimler. Panel parseIcsAsync kullanır (olay döngüsünü tutmaz).
export function parseIcs(text: string): ParsedIcs {
  return drive(parseSteps(text, new Slicer()));
}
export function parseIcsAsync(text: string): Promise<ParsedIcs> {
  return driveAsync(parseSteps(text, new Slicer()));
}
const ymdDigits = /^(\d{4})(\d{2})(\d{2})/;
function* parseSteps(text: string, sl: Slicer): Generator<void, ParsedIcs> {
  const out: ParsedIcs = { isCalendar: false, events: [], xwrTimezone: null, calName: null, badLines: 0, truncated: false };
  const stack: string[] = [];
  let skip = 0;    // derinlik sınırını aşan bileşenler: içerikleri ve iç içe BEGIN / END'leri atlanır (yığın en çok 8)
  let ev: IcsEvent | null = null;
  let evAt = -1;   // olayın yığındaki yeri: alanlar yalnız tam bu düzeyde (VALARM vb. iç bileşenler karışmaz)
  for (const line of iterLines(text)) {
    if (sl.due()) { yield; sl.resume(); }
    if (!line.trim()) continue;
    const cl = parseContentLine(line);
    if (!cl) { out.badLines++; continue; }
    if (cl.name === 'BEGIN') {
      if (skip || stack.length >= MAX_DEPTH) { skip++; out.badLines++; continue; }
      const comp = cl.value.trim().toUpperCase();
      if (comp === 'VCALENDAR') out.isCalendar = true;
      if (comp === 'VEVENT' && !ev && stack[stack.length - 1] === 'VCALENDAR') {
        if (out.events.length >= MAX_EVENTS) out.truncated = true;
        else {
          ev = {
            uid: '', summary: '', categories: [], status: '', dtstart: null, dtend: null, duration: null, durationBad: false, dtendBad: false,
            exdateBad: false, rrule: null, rdate: false, exdates: [], recurrenceId: null, rdateLast: null, range: '', ridBad: false,
          };
          evAt = stack.length;
        }
      }
      stack.push(comp);
      continue;
    }
    if (cl.name === 'END') {
      if (skip) { skip--; continue; }
      const comp = cl.value.trim().toUpperCase();
      const at = stack.lastIndexOf(comp);
      if (at < 0) { out.badLines++; continue; }
      // Olay kapandı; END:VEVENT gelmeden üst bileşen kapandıysa (bozuk dosya) yarım olay atılır
      if (ev && at <= evAt) {
        if (at === evAt && comp === 'VEVENT') out.events.push(ev);
        ev = null;
        evAt = -1;
      }
      stack.length = at;
      continue;
    }
    if (skip) continue;
    if (stack[stack.length - 1] === 'VCALENDAR' && stack.length === 1) {
      if (cl.name === 'X-WR-TIMEZONE') out.xwrTimezone = cl.value.trim() || null;
      else if (cl.name === 'X-WR-CALNAME') out.calName = cleanSummary(cl.value) || null;
      continue;
    }
    if (!ev || stack.length - 1 !== evAt) continue;
    switch (cl.name) {
      case 'UID': ev.uid = cl.value.trim().slice(0, 300); break;
      case 'SUMMARY': ev.summary = cleanSummary(cl.value); break;
      // Yaymadan (çok uzun listede yığın taşmasın) ve olay başına en çok 50
      case 'CATEGORIES':
        for (const v of splitTextList(cl.value, MAX_CATEGORIES)) {
          if (ev.categories.length >= MAX_CATEGORIES) break;
          ev.categories.push(v);
        }
        break;
      case 'STATUS': ev.status = cl.value.trim().toUpperCase(); break;
      case 'DTSTART': ev.dtstart = parseIcsTime(cl.value, cl.params); break;
      case 'DTEND': ev.dtend = parseIcsTime(cl.value, cl.params); ev.dtendBad = !ev.dtend; break;
      case 'DURATION': ev.duration = parseDuration(cl.value); ev.durationBad = !ev.duration; break;
      case 'RRULE': ev.rrule = ev.rrule === null ? cl.value.trim() : `${ev.rrule}\n${cl.value.trim()}`; break;
      case 'RDATE':
        ev.rdate = true;
        for (const v of cl.value.split(',')) {
          const m = ymdDigits.exec(v.trim());
          const dn = m ? dayNum(Number(m[1]), Number(m[2]), Number(m[3])) : Infinity;
          ev.rdateLast = Math.max(ev.rdateLast ?? -Infinity, Number.isFinite(dn) ? dn : Infinity);
        }
        break;
      case 'EXDATE':
        for (const v of cl.value.split(',')) {
          if (!v.trim()) continue;
          if (ev.exdates.length >= MAX_EXDATES) { ev.exdateBad = true; break; }
          const t = parseIcsTime(v, cl.params);
          if (t) ev.exdates.push(t);
          else ev.exdateBad = true;
        }
        break;
      case 'RECURRENCE-ID':
        ev.recurrenceId = parseIcsTime(cl.value, cl.params);
        ev.ridBad = !ev.recurrenceId;
        ev.range = (cl.params.get('RANGE') || '').trim().toUpperCase();
        break;
      default: break;
    }
  }
  return out;
}

// ── Etiketler ────────────────────────────────────────────────────────────────
// Türkçe küçük harf (yerel ayardan bağımsız): I → ı, İ → i; NFC; boşluklar tek. Harf eşleme YOK (ı ≠ i).
export function normTag(s: string): string {
  return String(s ?? '').normalize('NFC').replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase().replace(/\s+/g, ' ').trim();
}
// "#" önünde harf / rakam / "#" olmamalı ("C#", "a#b" etiket değil); etiket harf, rakam, "_" ve iç "-" ("#e-posta")
const HASH_RE = /(^|[^\p{L}\p{M}\p{N}_#])#([\p{L}\p{M}\p{N}_]+(?:-[\p{L}\p{M}\p{N}_]+)*)/gu;
// SUMMARY'deki tam "#etiket" belirteçleri + CATEGORIES tam değerleri (başta tek "#" atılır). Sıralı, tekrarsız, en çok 20.
export function extractTags(summary: string, categories: string[] = []): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const n = normTag(t);
    if (n && n.length <= MAX_TAG_LEN && !out.includes(n) && out.length < MAX_TAGS) out.push(n);
  };
  for (const m of String(summary ?? '').normalize('NFC').matchAll(HASH_RE)) add(m[2]);
  for (const c of categories) add(String(c ?? '').trim().replace(/^#/, ''));
  return out;
}

// ── Tekrarlama kuralı ────────────────────────────────────────────────────────
type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export interface RRule {
  freq: Freq; interval: number; count: number | null; until: IcsTime | null;
  byday: { n: number; wd: number }[] | null; bymonthday: number[] | null; bymonth: number[] | null; wkst: number;
}
const WD: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// Tekrarsız sayı listesi (BYMONTHDAY, BYMONTH); 100'den uzun liste geçersiz (tekilleştirilince en çok 62 / 12 öğe)
const intList = (v: string, lo: number, hi: number, neg: boolean): number[] | null => {
  const parts = v.split(',');
  if (parts.length > 100) return null;
  const out = new Set<number>();
  for (const p of parts) {
    if (!/^[+-]?\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n === 0 || Math.abs(n) < lo || Math.abs(n) > hi || (!neg && n < 0)) return null;
    out.add(n);
  }
  return out.size ? [...out] : null;
};
export function parseRrule(s: string): RRule | { error: string } {
  if (/\n/.test(s)) return { error: 'birden çok RRULE' };
  if (s.length > MAX_RRULE_LEN) return { error: 'kural çok uzun' };
  const parts = new Map<string, string>();
  for (const kv of String(s).trim().split(';')) {
    if (!kv) continue;
    const eq = kv.indexOf('=');
    if (eq < 1) return { error: `biçimsiz: ${kv.slice(0, 30)}` };
    parts.set(kv.slice(0, eq).toUpperCase(), kv.slice(eq + 1).toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return { error: `FREQ=${freq ?? '?'} desteklenmiyor` };
  for (const k of parts.keys()) {
    if (!['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'].includes(k)) return { error: `${k} desteklenmiyor` };
  }
  const r: RRule = { freq: freq as Freq, interval: 1, count: null, until: null, byday: null, bymonthday: null, bymonth: null, wkst: 1 };
  const iv = parts.get('INTERVAL');
  if (iv !== undefined) {
    if (!/^\d{1,5}$/.test(iv) || Number(iv) < 1) return { error: 'INTERVAL geçersiz' };
    r.interval = Number(iv);
  }
  const cnt = parts.get('COUNT');
  if (cnt !== undefined) {
    if (!/^\d{1,9}$/.test(cnt) || Number(cnt) < 1) return { error: 'COUNT geçersiz' };
    r.count = Number(cnt);
  }
  const un = parts.get('UNTIL');
  if (un !== undefined) {
    r.until = parseIcsTime(un);
    if (!r.until) return { error: 'UNTIL geçersiz' };
  }
  const wk = parts.get('WKST');
  if (wk !== undefined) {
    if (!(wk in WD)) return { error: 'WKST geçersiz' };
    r.wkst = WD[wk];
  }
  const bd = parts.get('BYDAY');
  if (bd !== undefined) {
    // Tekrarsız (en çok 7 gün × 11 sıra = 77 öğe): her gün için baştan taranan liste sınırsız büyümesin
    const list = bd.split(',');
    if (list.length > 100) return { error: 'BYDAY çok uzun' };
    const seen = new Set<number>();
    r.byday = [];
    for (const p of list) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(p);
      if (!m) return { error: `BYDAY geçersiz: ${p.slice(0, 10)}` };
      const n = m[1] ? Number(m[1]) : 0;
      if (Math.abs(n) > 5 && n !== 0) return { error: 'BYDAY sırası desteklenmiyor' };
      if (m[1] && n === 0) return { error: 'BYDAY geçersiz' };
      const key = n * 10 + WD[m[2]];
      if (seen.has(key)) continue;
      seen.add(key);
      r.byday.push({ n, wd: WD[m[2]] });
    }
  }
  const md = parts.get('BYMONTHDAY');
  if (md !== undefined) {
    r.bymonthday = intList(md, 1, 31, true);
    if (!r.bymonthday) return { error: 'BYMONTHDAY geçersiz' };
  }
  const bm = parts.get('BYMONTH');
  if (bm !== undefined) {
    r.bymonth = intList(bm, 1, 12, false);
    if (!r.bymonth) return { error: 'BYMONTH geçersiz' };
  }
  const ordinals = !!r.byday?.some(b => b.n !== 0);
  if (ordinals && (r.freq === 'DAILY' || r.freq === 'WEEKLY')) return { error: `${r.freq} ile sıralı BYDAY desteklenmiyor` };
  if (ordinals && r.bymonthday) return { error: 'sıralı BYDAY + BYMONTHDAY desteklenmiyor' };
  if (r.freq === 'WEEKLY' && r.bymonthday) return { error: 'WEEKLY + BYMONTHDAY desteklenmiyor' };
  if (r.freq === 'YEARLY' && r.byday && !r.bymonth) return { error: 'YEARLY + BYDAY (BYMONTH olmadan) desteklenmiyor' };
  return r;
}

// Gün numarası (1970-01-01'den gün) ↔ tarih; haftanın günü 0 = Pazar
const dayNum = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);
const weekday = (dn: number) => ((dn + 4) % 7 + 7) % 7;
const ymdOf = (dn: number) => { const t = new Date(dn * DAY_MS); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const dateKey = (dn: number) => { const t = new Date(dn * DAY_MS); return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`; };

// Ayın kurala uyan günleri (artan). Haftanın günleri tarama yerine hesapla: ayın ilk "o günü" + 7k (BYDAY en çok 77 öğe).
function monthDays(r: RRule, y: number, mo: number, startDay: number): number[] {
  const dim = daysIn(y, mo);
  const first = dayNum(y, mo, 1);
  const wd1 = weekday(first);
  let days: number[];
  if (r.bymonthday) {
    days = r.bymonthday.map(v => (v > 0 ? v : dim + 1 + v)).filter(v => v >= 1 && v <= dim);
    if (r.byday) days = days.filter(d => r.byday!.some(b => b.wd === (wd1 + d - 1) % 7));
  } else if (r.byday) {
    days = [];
    for (const b of r.byday) {
      const d0 = 1 + ((b.wd - wd1 + 7) % 7);           // ayın ilk o günü
      const cnt = Math.floor((dim - d0) / 7) + 1;      // ayda kaç tane
      if (b.n === 0) for (let k = 0; k < cnt; k++) days.push(d0 + 7 * k);
      else {
        const i = b.n > 0 ? b.n - 1 : cnt + b.n;
        if (i >= 0 && i < cnt) days.push(d0 + 7 * i);
      }
    }
  } else {
    days = startDay <= dim ? [startDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b).map(d => first + d - 1);
}

// Tarama sınırı (kural başına MAX_PERIODS ya da takvim başına MAX_WORK) aşıldı
const LIMIT = new Error('limit');
// Kuralın aday günleri (gün numarası, artan) dönem dönem; minDn'den önce bitmiş dönemler (COUNT yoksa) atlanır. Dönemin ilk
// olası günü maxDn'i geçince durur. Tarama sınırı aşılırsa LIMIT atılır. NaN: "nefes al" işareti (çağıran zaman uyumsuz
// sürücüye döner) — gün üretmeyen uzun taramalar da olay döngüsünü tutmasın.
function* ruleDays(r: RRule, start: { y: number; mo: number; d: number }, minDn: number, maxDn: number, c: Ctx): Generator<number> {
  const sDn = dayNum(start.y, start.mo, start.d);
  const skip = r.count === null;
  const dayLimits = (dn: number) => {
    const t = ymdOf(dn);
    if (r.bymonth && !r.bymonth.includes(t.mo)) return false;
    if (r.bymonthday) {
      const dim = daysIn(t.y, t.mo);
      if (!r.bymonthday.some(v => (v > 0 ? v : dim + 1 + v) === t.d)) return false;
    }
    if (r.byday && !r.byday.some(b => b.wd === weekday(dn))) return false;
    return true;
  };
  let periods = 0;
  // İş birimi ≈ yapılan iş: gün süzgeci / ayın günleri listelerin uzunluğuyla (tekilleştirilmiş: BYDAY ≤ 77, BYMONTHDAY ≤ 62)
  const lists = (r.byday?.length ?? 0) + (r.bymonthday?.length ?? 0) + (r.bymonth?.length ?? 0);
  const dayCost = 1 + Math.ceil(lists / 8), monthCost = 2 + lists;
  // Dönem başına: iki sınır + iş birimi; true → nefes zamanı
  const step = (units: number): boolean => {
    if (++periods > MAX_PERIODS) throw LIMIT;
    c.work += units;
    if (c.work > c.maxWork) { c.overBudget = true; throw LIMIT; }
    return c.sl.due();
  };
  if (r.freq === 'DAILY') {
    let p = skip ? Math.max(0, Math.floor((minDn - sDn) / r.interval) - 1) : 0;
    for (; ; p++) {
      if (step(dayCost)) yield NaN;
      const dn = sDn + p * r.interval;
      if (dn > maxDn) return;
      if (dayLimits(dn)) yield dn;
    }
  }
  if (r.freq === 'WEEKLY') {
    const ws0 = sDn - ((weekday(sDn) - r.wkst + 7) % 7);
    const wds = (r.byday ? r.byday.map(b => b.wd) : [weekday(sDn)]).map(wd => (wd - r.wkst + 7) % 7);
    const offs = [...new Set(wds)].sort((a, b) => a - b);
    let p = skip ? Math.max(0, Math.floor((minDn - ws0) / (7 * r.interval)) - 1) : 0;
    for (; ; p++) {
      if (step(1 + offs.length)) yield NaN;
      const ws = ws0 + p * 7 * r.interval;
      if (ws > maxDn) return;
      for (const o of offs) {
        const dn = ws + o;
        if (!r.bymonth || r.bymonth.includes(ymdOf(dn).mo)) yield dn;
      }
    }
  }
  if (r.freq === 'MONTHLY') {
    const m0 = start.y * 12 + (start.mo - 1);
    const minT = ymdOf(minDn);
    let p = skip ? Math.max(0, Math.floor((minT.y * 12 + minT.mo - 1 - m0) / r.interval) - 1) : 0;
    for (; ; p++) {
      if (step(monthCost)) yield NaN;
      const mi = m0 + p * r.interval;
      const y = Math.floor(mi / 12), mo = (mi % 12) + 1;
      if (dayNum(y, mo, 1) > maxDn) return;
      if (r.bymonth && !r.bymonth.includes(mo)) continue;
      yield* monthDays(r, y, mo, start.d);
    }
  }
  if (r.freq === 'YEARLY') {
    const minT = ymdOf(minDn);
    let p = skip ? Math.max(0, Math.floor((minT.y - start.y) / r.interval) - 1) : 0;
    const months = r.bymonth ? [...r.bymonth].sort((a, b) => a - b) : r.bymonthday ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.mo];
    for (; ; p++) {
      if (step(monthCost * months.length)) yield NaN;
      const y = start.y + p * r.interval;
      if (dayNum(y, 1, 1) > maxDn) return;
      for (const mo of months) yield* monthDays(r, y, mo, start.d);
    }
  }
}

// ── Açılım ───────────────────────────────────────────────────────────────────
// Çözülemedi nedenleri (hepsi ASLA tetiklemez): tz = saat dilimi tanınmadı (saat tahmini); rrule = tekrarlama kuralı
// desteklenmiyor (yalnız ilk tarih), RDATE ya da "bu ve sonraki oluşumlar" (RANGE=THISANDFUTURE) değişikliği; limit = tarama
// sınırı; time = bitiş (DTEND), süre (DURATION), istisna tarihi (EXDATE) ya da geçersiz kılmanın RECURRENCE-ID'si okunamadı.
export type Unresolved = 'tz' | 'rrule' | 'limit' | 'time';
export interface Occurrence {
  uid: string;
  recurrenceId: string;        // tekrarlayan olayda oluşumun ASIL başlangıcı (ISO); tekil olayda ''
  summary: string; tags: string[];
  start: number; end: number;  // UTC ms; end hariç
  allDay: boolean;
  unresolved: Unresolved | null;
  tzid: string | null;         // çözülemeyen dilimin adı (yalnız unresolved = 'tz')
  note?: string;               // çözülemedi nedeni (kısa)
}
// hidden: serinin ufukta hiç oluşumu yok (tarihleri hesaplanamadı) — ajandada görünmez, yalnız uyarıda adıyla geçer
export interface UnresolvedNote { summary: string; reason: Unresolved; detail: string; hidden: boolean }
export interface ExpandStats {
  events: number; occurrences: number; badLines: number; skipped: number;
  unresolvedCount: number;     // çözülemedi işaretli olay (seri) sayısı
  hiddenCount: number;         // bunlardan ufukta hiç oluşumu olmayanlar
  unresolved: UnresolvedNote[];  // en çok 10 (görünmeyenler öncelikli)
  capped: number;              // olay başına 500 sınırına takılan olay sayısı
  truncated: boolean;          // toplam 5000 sınırı (zamanca en yakın 5000 kaldı) ya da 20 000 VEVENT aşıldı
}
export interface ExpandResult { occurrences: Occurrence[]; stats: ExpandStats }
export interface ExpandOpts { from: number; to: number; localZone?: Zone; maxPerEvent?: number; maxTotal?: number; maxWork?: number }

interface Ctx {
  from: number; to: number; local: Zone; float: Zone; maxPerEvent: number; maxTotal: number; maxWork: number;
  out: Occurrence[]; stats: ExpandStats;
  sl: Slicer;
  work: number; overBudget: boolean;               // takvim başına toplam tarama (MAX_WORK)
  zones: Map<string, Zone | null>; zoneCount: number;
}
// TZID → dilim, açılım boyunca hatırlanır (çözülemeyenler dahil; bunlar modül önbelleğine girmez). Takvimde 64'ten çok farklı
// dilim varsa fazlası çözülemedi sayılır (her dilimin saat önbelleği bellek tutar).
function zoneFor(c: Ctx, tzid: string): Zone | null {
  const hit = c.zones.get(tzid);
  if (hit !== undefined) return hit;
  c.work += 10;
  let z = resolveZone(tzid);
  if (z && z !== UTC_ZONE && ++c.zoneCount > MAX_ZONES_PER_RUN) z = null;
  c.zones.set(tzid, z);
  return z;
}
// Zaman değerinin dilimi: UTC / TZID (çözülemezse Pi'nin dilimi + işaret) / yüzen (X-WR-TIMEZONE ya da Pi)
function zoneOf(t: IcsTime, c: Ctx): { z: Zone; bad: string | null } {
  if (t.utc) return { z: UTC_ZONE, bad: null };
  if (t.tzid) {
    const z = zoneFor(c, t.tzid);
    return z ? { z, bad: null } : { z: c.local, bad: t.tzid };
  }
  return { z: c.float, bad: null };
}
const instantOf = (t: IcsTime, c: Ctx) => (t.date ? wallToUtc(c.local, t.y, t.mo, t.d) : wallToUtc(zoneOf(t, c).z, t.y, t.mo, t.d, t.h, t.mi, t.s));
const keyOf = (t: IcsTime, c: Ctx) => (t.date ? `d:${dateKey(dayNum(t.y, t.mo, t.d))}` : `t:${instantOf(t, c)}`);

function noteUnresolved(c: Ctx, summary: string, reason: Unresolved, detail: string, hidden: boolean) {
  c.stats.unresolvedCount++;
  if (hidden) c.stats.hiddenCount++;
  const item: UnresolvedNote = { summary: summary || '', reason, detail: detail.slice(0, 120), hidden };
  const list = c.stats.unresolved;
  if (list.length < 10) list.push(item);
  else if (hidden) {
    const i = list.findIndex(x => !x.hidden);
    if (i >= 0) list[i] = item;
  }
}

// Seri ufuktan önce bitmiş mi — yalnız "çözülemedi" uyarısını susturmak için, cömert tahmin: UNTIL günü; ya da COUNT ×
// INTERVAL × dönem uzunluğu × 3 (desteklenmeyen kuralda boş dönemler olabilir: BYSETPOS vb.). RDATE'lerin en geç günü de geçmiş
// olmalı. Bilinmiyorsa false (uyarı verilir).
const PERIOD_DAYS: Record<string, number> = { SECONDLY: 1, MINUTELY: 1, HOURLY: 1, DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 };
function ruleEnded(s: string, startDn: number, fromDn: number): boolean {
  const until = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})/i.exec(s);
  if (until) return dayNum(Number(until[1]), Number(until[2]), Number(until[3])) < fromDn - 1;
  const cnt = /(?:^|;)COUNT=(\d{1,9})(?=;|$)/i.exec(s);
  const per = PERIOD_DAYS[(/(?:^|;)FREQ=([A-Z]+)/i.exec(s)?.[1] || '').toUpperCase()];
  if (!cnt || !per) return false;
  const iv = Number(/(?:^|;)INTERVAL=(\d{1,5})(?=;|$)/i.exec(s)?.[1] || 1) || 1;
  return startDn + Number(cnt[1]) * iv * per * 3 + 31 < fromDn;
}
function endedBefore(ev: IcsEvent, startDn: number, fromDn: number): boolean {
  if (ev.rdate && !(ev.rdateLast !== null && ev.rdateLast < fromDn - 1)) return false;
  return !ev.rrule || ev.rrule.split('\n').every(s => ruleEnded(s.trim(), startDn, fromDn));
}

const byStart = (a: Occurrence, b: Occurrence) => a.start - b.start || a.end - b.end || a.uid.localeCompare(b.uid);
// Toplam sınır: zamanca EN YAKIN maxTotal oluşum kalır (dosya sırası değil); ufuk en son kalanın başlangıcına daralır —
// sonraki olayların daha geç oluşumları hesaplanmaz bile, daha erken olanlar yine girer.
function compact(c: Ctx): void {
  c.out.sort(byStart);
  if (c.out.length <= c.maxTotal) return;
  c.out.length = c.maxTotal;
  c.to = Math.min(c.to, c.out[c.maxTotal - 1].start);
  c.stats.truncated = true;
}

// Geçersiz kılmalar (UID başına bir kez): oluşum anahtarları; RANGE=THISANDFUTURE varsa en erken başlangıcı (UTC ms)
interface UidInfo { keys: Set<string>; future: number | null }
const FUTURE_NOTE = 'bu ve sonraki oluşumlar takvimde değiştirilmiş (RANGE=THISANDFUTURE) — desteklenmiyor, saat eski olabilir';

// Bir olayın (ana olay ya da geçersiz kılma) oluşumları. info: bu UID'nin geçersiz kılmaları (yalnız ana olayda).
function* expandEvent(ev: IcsEvent, c: Ctx, info: UidInfo | null): Generator<void, void> {
  const st = ev.dtstart!;
  const zr = st.date ? { z: c.local, bad: null } : zoneOf(st, c);
  const z = zr.z;
  const tags = extractTags(ev.summary, ev.categories);
  // Olay düzeyinde çözülemedi nedeni: ilk bulunan (desteklenmeyen tekrarlama kuralı hepsinin önüne geçer)
  let unresolved = null as Unresolved | null;
  let note = '', detail = '';
  let badTz = null as string | null;
  // n: oluşumun notu (ajanda), d: uyarı listesindeki kısa ayrıntı (kaynak kartı)
  const flag = (r: Unresolved, n: string, d: string = n, tz: string | null = null) => {
    if (unresolved) return;
    unresolved = r; note = n; detail = d; badTz = tz;
  };
  // Kart nedeni ve ayrıntıyı birlikte gösterir («saat dilimi tanınmadı (X)»): ayrıntı yalnız dilim adı
  if (zr.bad) flag('tz', `saat dilimi tanınmadı: ${zr.bad}`, zr.bad, zr.bad);
  // Süre: DTEND (kesin; tüm günde gün farkı), yoksa DURATION (nominal gün + kesin süre), yoksa tüm gün 1 gün / anlık 0
  let dur: Dur = st.date ? { days: 1, ms: 0 } : { days: 0, ms: 0 };
  if (ev.dtend) {
    if (st.date) {
      const dd = dayNum(ev.dtend.y, ev.dtend.mo, ev.dtend.d) - dayNum(st.y, st.mo, st.d);
      dur = { days: Math.max(1, dd), ms: 0 };
    } else {
      const endZ = ev.dtend.date ? null : zoneOf(ev.dtend, c);
      if (endZ?.bad) flag('tz', `saat dilimi tanınmadı: ${endZ.bad}`, endZ.bad, endZ.bad);
      const e = ev.dtend.date ? wallToUtc(z, ev.dtend.y, ev.dtend.mo, ev.dtend.d) : wallToUtc(endZ!.z, ev.dtend.y, ev.dtend.mo, ev.dtend.d, ev.dtend.h, ev.dtend.mi, ev.dtend.s);
      dur = { days: 0, ms: Math.max(0, e - wallToUtc(z, st.y, st.mo, st.d, st.h, st.mi, st.s)) };
    }
  } else if (ev.duration) {
    dur = st.date ? { days: Math.max(1, ev.duration.days + (ev.duration.ms >= DAY_MS ? Math.floor(ev.duration.ms / DAY_MS) : 0)), ms: 0 } : ev.duration;
  }
  // Okunamayan RECURRENCE-ID: hangi oluşumun yerini aldığı bilinmez — kendi zamanıyla tek kayıt (expandSteps), çözülemedi.
  // Dilim tanınmadıysa o önce gelir (diğer 'time' nedenleri gibi): saat tahmini → ajandada "yaklaşık" ve dilim adı kalır
  if (ev.ridBad) flag('time', 'değiştirilen oluşumun tarihi (RECURRENCE-ID) okunamadı — ana olayın o oluşumu da görünebilir', 'RECURRENCE-ID okunamadı');
  // Okunamayan bitiş / süre: başlangıç doğru, süre tahmin (anlık ya da tüm gün)
  if (ev.dtendBad) flag('time', 'bitiş zamanı (DTEND) okunamadı — süre bilinmiyor', 'DTEND okunamadı');
  if (ev.durationBad) flag('time', 'süre (DURATION) okunamadı ya da eksi — süre bilinmiyor', 'DURATION okunamadı ya da eksi');
  const span = (dur.days + 1) * DAY_MS + dur.ms;   // açılımda geriye bakış (ufuktan önce başlayıp süren oluşum)
  const instance = (dn: number): { s: number; e: number } => {
    const t = ymdOf(dn);
    if (st.date) return { s: wallToUtc(c.local, t.y, t.mo, t.d), e: wallToUtc(c.local, ...ymdArr(dn + dur.days)) };
    const s = wallToUtc(z, t.y, t.mo, t.d, st.h, st.mi, st.s);
    const e = dur.days ? wallToUtc(z, ...ymdArr(dn + dur.days), st.h, st.mi, st.s) + dur.ms : s + dur.ms;
    return { s, e };
  };
  const startDn = dayNum(st.y, st.mo, st.d);
  const fromDn = Math.floor(c.from / DAY_MS);
  const minDn = Math.floor((c.from - span) / DAY_MS) - 2;
  const maxDn = Math.floor(c.to / DAY_MS) + 2;
  // EXDATE: yalnız ufka düşebilenler (COUNT'u etkilemez; ufuk dışındakilerin anı hiç hesaplanmaz). Dilimi tanınmayan ya da
  // okunamayan istisna: iptal edilen oluşum yanlışlıkla görünebilir → olay çözülemedi.
  const ex = new Set<string>();
  for (const x of ev.exdates) {
    const xd = dayNum(x.y, x.mo, x.d);
    if (xd < minDn - 2 || xd > maxDn + 2) continue;
    if (!x.date && !x.utc && x.tzid && !zoneFor(c, x.tzid)) flag('time', `istisna tarihinin (EXDATE) saat dilimi tanınmadı: ${x.tzid}`, `EXDATE saat dilimi tanınmadı: ${x.tzid}`);
    ex.add(keyOf(x, c));
  }
  if (ev.exdateBad) flag('time', 'istisna tarihi (EXDATE) okunamadı ya da çok fazla — iptal edilen oluşum görünebilir', `EXDATE okunamadı ya da ${MAX_EXDATES}'den çok`);
  const recurring = !!ev.rrule && !ev.recurrenceId;
  let rule: RRule | null = null;
  if (recurring) {
    const r = parseRrule(ev.rrule!);
    if ('error' in r) {
      // Desteklenmeyen kural: yalnız ilk tarih, çözülemedi (asla tetiklemez)
      unresolved = 'rrule';
      note = `tekrarlama kuralı desteklenmiyor (${r.error}) — yalnız ilk tarih`;
      detail = r.error;
      badTz = null;
    } else {
      rule = r;
    }
  }
  if (ev.rdate && !unresolved) { flag('rrule', 'RDATE (ek tarihler) desteklenmiyor'); detail = 'RDATE'; }
  const baseInstant = instance(startDn).s;
  const rid = (s: number) => (recurring ? new Date(s).toISOString() : '');
  const ridFixed = ev.recurrenceId ? new Date(instantOf(ev.recurrenceId, c)).toISOString() : null;
  const fut = info?.future ?? null;
  let kept = 0;
  let futureKept = 0;
  let limitHit = false;
  // [from, to) ile kesişiyor mu (süresiz olay: başlangıcı aralıkta mı)
  const inRange = (s: number, e: number) => s < c.to && (e > c.from || (e === s && s >= c.from));
  // false: olay başına sınıra takıldı, açılım durur. future: "bu ve sonraki" değişikliğinden sonraki oluşum (işaretli)
  const emit = (s: number, e: number, future: boolean): boolean => {
    if (!inRange(s, e)) return true;
    if (kept >= c.maxPerEvent) { c.stats.capped++; return false; }
    kept++;
    const u: Unresolved | null = unresolved ?? (future ? 'rrule' : null);
    if (future && !unresolved) futureKept++;
    c.out.push({
      uid: ev.uid, recurrenceId: ridFixed ?? rid(s),
      summary: ev.summary, tags, start: s, end: e, allDay: st.date, unresolved: u, tzid: u === 'tz' ? badTz : null,
      ...(u ? { note: unresolved ? note : FUTURE_NOTE } : {}),
    });
    if (c.out.length >= c.maxTotal * 2) compact(c);
    return true;
  };
  // EXDATE ya da geçersiz kılınan oluşum (anahtar: UTC anı ya da tarih)
  const skipKey = (dn: number, s: number) => [`t:${s}`, `d:${dateKey(dn)}`].some(k => ex.has(k) || (info?.keys.has(k) ?? false));
  // İlk oluşum her zaman DTSTART (RFC 5545 3.8.5.3) ve COUNT'a sayılır (EXDATE ile çıkarılsa da)
  let stop = false;
  if (!skipKey(startDn, baseInstant)) {
    const first = instance(startDn);
    stop = !emit(first.s, first.e, fut !== null && first.s >= fut);
  }
  if (rule && !stop && c.overBudget) limitHit = true;   // takvimin tarama bütçesi bitti: yalnız ilk tarih
  else if (rule && !stop) {
    let count = 1;
    const until = rule.until;
    // UNTIL: UTC ise kesin an; yüzense olayın kendi dilimiyle; tarihse gün karşılaştırması
    const untilMs = until && !until.date ? (until.utc ? instantOf(until, c) : wallToUtc(z, until.y, until.mo, until.d, until.h, until.mi, until.s)) : null;
    const untilDn = until ? dayNum(until.y, until.mo, until.d) : null;
    try {
      for (const dn of ruleDays(rule, st, minDn, maxDn, c)) {
        if (dn !== dn) { yield; c.sl.resume(); continue; }   // NaN: nefes
        if (dn < minDn) {
          // Ufuktan önceki oluşum: yalnız COUNT ve UNTIL için sayılır, anı hesaplanmaz (dilim hesabı pahalı). Saatli UNTIL'de
          // kesin karşılaştırma yalnız sınır günlerinde (bir oluşumun UTC anı kendi gününün başından en çok 36 saat sonra).
          c.work++;
          if (dn <= startDn) continue;
          if (until) {
            if (until.date) { if (dn > untilDn!) break; }
            else if ((dn + 2) * DAY_MS > untilMs! && instance(dn).s > untilMs!) break;
          }
          count++;
          if (rule.count !== null && count > rule.count) break;
          continue;
        }
        if (dn < startDn) continue;
        c.work += 5;
        const inst = instance(dn);
        if (inst.s <= baseInstant) continue;
        if (until) {
          if (until.date ? dn > untilDn! : inst.s > untilMs!) break;
        }
        count++;
        if (rule.count !== null && count > rule.count) break;
        if (inst.s >= c.to) break;
        if (skipKey(dn, inst.s)) continue;
        if (!emit(inst.s, inst.e, fut !== null && inst.s >= fut)) break;
        if (c.sl.due()) { yield; c.sl.resume(); }
      }
    } catch (e) {
      if (e !== LIMIT) throw e;
      limitHit = true;
    }
  }
  // Uyarı kaydı (seri başına bir kez). hidden: ufukta hiç oluşumu yok — tarihleri hesaplanamadı, ajandada görünmez.
  const hidden = kept === 0;
  if (unresolved === 'rrule') {
    // Desteklenmeyen kural / RDATE: seri ufkun sonundan önce başladıysa ve bitmediyse
    if (baseInstant < c.to && !endedBefore(ev, startDn, fromDn)) noteUnresolved(c, ev.summary, 'rrule', detail, hidden);
  } else if (limitHit) {
    if (!endedBefore(ev, startDn, fromDn)) noteUnresolved(c, ev.summary, 'limit', 'tekrarlama çok uzun', hidden);
  } else if (unresolved) {
    if (kept) noteUnresolved(c, ev.summary, unresolved, detail, false);   // tz / time: yalnız ufukta görünen olay
  } else if (futureKept) {
    noteUnresolved(c, ev.summary, 'rrule', 'RANGE=THISANDFUTURE', false);
  }
}
const ymdArr = (dn: number): [number, number, number] => { const t = ymdOf(dn); return [t.y, t.mo, t.d]; };

// Olayları UID'ye göre gruplayıp açar (geçersiz kılmalar ana olayın oluşumunun yerini alır). Zaman dilimleriyle: her ~8 ms'de
// bir boş yield (zaman uyumsuz sürücü burada olay döngüsüne nefes aldırır).
function* expandSteps(p: ParsedIcs, opts: ExpandOpts): Generator<void, ExpandResult> {
  const local = opts.localZone ?? PROCESS_ZONE;
  const float = (p.xwrTimezone && resolveZone(p.xwrTimezone)) || local;
  const c: Ctx = {
    from: opts.from, to: opts.to, local, float, maxPerEvent: opts.maxPerEvent ?? MAX_PER_EVENT, maxTotal: opts.maxTotal ?? MAX_TOTAL,
    maxWork: opts.maxWork ?? MAX_WORK,
    out: [], stats: {
      events: p.events.length, occurrences: 0, badLines: p.badLines, skipped: 0, unresolvedCount: 0, hiddenCount: 0, unresolved: [],
      capped: 0, truncated: p.truncated,
    },
    sl: new Slicer(), work: 0, overBudget: false, zones: new Map(), zoneCount: 0,
  };
  const valid = p.events.filter(e => {
    if (e.dtstart) return true;
    c.stats.skipped++;
    return false;
  });
  // UID'siz olay tekil sayılır (geçersiz kılma eşleşmesi yok)
  valid.forEach((e, i) => { if (!e.uid) e.uid = `klx-nouid-${i}`; });
  const masters = new Set(valid.filter(e => !e.recurrenceId && !e.ridBad).map(e => e.uid));
  const infos = new Map<string, UidInfo>();
  for (const e of valid) {
    if (!e.recurrenceId || !masters.has(e.uid)) continue;
    if (c.sl.due()) { yield; c.sl.resume(); }
    let info = infos.get(e.uid);
    if (!info) { info = { keys: new Set(), future: null }; infos.set(e.uid, info); }
    info.keys.add(keyOf(e.recurrenceId, c));
    if (e.range === 'THISANDFUTURE') {
      const t = instantOf(e.recurrenceId, c);
      if (info.future === null || t < info.future) info.future = t;
    }
  }
  for (const e of valid) {
    if (c.sl.due()) { yield; c.sl.resume(); }
    if (e.status === 'CANCELLED') continue;
    // Geçersiz kılma: kendi zamanıyla tek oluşum (iptal edilmişse yok). Ana olay yoksa da gösterilir. RECURRENCE-ID'si
    // okunamayan da tek oluşum (çözülemedi, asla tetiklemez); ana olayın oluşumları değişmez.
    if (e.recurrenceId || e.ridBad) yield* expandEvent({ ...e, rrule: null }, c, null);
    else yield* expandEvent(e, c, infos.get(e.uid) ?? null);
  }
  compact(c);
  c.stats.occurrences = c.out.length;
  return { occurrences: c.out, stats: c.stats };
}

export function expandIcs(p: ParsedIcs, opts: ExpandOpts): ExpandResult {
  return drive(expandSteps(p, opts));
}
// Olay döngüsünü kilitlemeden (her ~8 ms'lik dilimden sonra setImmediate)
export function expandIcsAsync(p: ParsedIcs, opts: ExpandOpts): Promise<ExpandResult> {
  return driveAsync(expandSteps(p, opts));
}

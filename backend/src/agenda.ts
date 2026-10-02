// Ağ Ajandası: Pi'de zamanlanmış işlerin ve saat pencerelerinin SALT OKUNUR kayıt defteri (GET /api/agenda). Arka plan işi
// yoktur, yalnız istek gelince çalışır; hiçbir zamanlayıcıyı kurmaz, ertelemez ya da tetiklemez — her iş kendi modülünde
// eskisi gibi zamanlanır, burası yalnız okur. Kaynaklar birbirinden yalıtılmıştır: biri okunamazsa sources[].error'a yazılır,
// diğerleri listelenir.
//  - Ebeveyn Kontrol ve Trafik Zamanlayıcı pencereleri motorların KENDİ fonksiyonlarıyla (parental.ts ruleActive,
//    trafficSchedule.ts scheduleActive) değerlendirilir; gece yarısını aşan pencere ve başlangıç = bitiş (bütün gün) aynı
//    anlamdadır. Durum yalnız pencere sınırında, gece yarısında ve yaz saati geçişinde değişebilir: bu anlar aday olarak
//    denenir (dakika taraması yok — O(gün × sınır)).
//  - Panel ve sistem cron'u: cronNext — cronSync.ts validateSchedule'ın kabul ettiği alt küme, Debian cron (3.0pl1)
//    anlamıyla: ayın günü ve haftanın günü ikisi de kısıtlıysa VEYA, biri '*' ile başlıyorsa VE; 0 ve 7 Pazar. Adımı tek
//    sayıya verilmiş satırı ("1/2") Debian cron reddeder ("bad minute") ve o satırın bulunduğu DOSYANIN TAMAMINI yok sayar
//    (user.c: "this crontab file will be ignored"): o dosyadaki hiçbir görev çalışmaz, öyle gösterilir. Yaz saati geçişi
//    Debian cron'un kendi kuralıyla (cron.c): ileri alınınca atlanan dakikadaki sabit saatli iş geçiş anında, geri alınınca
//    tekrarlanan saatte joker iş iki kez. Hesaplanamayan satır için tahmin yapılmaz.
//  - Motorlar (ebeveyn, trafik, kota, Zapret, bulut yedeği) Node sürecinin saat dilimiyle çalışır, burada da onunla
//    hesaplanır; cron ise sistemin GÜNCEL dilimiyle (timedatectl: Debian cron /etc/localtime değişikliğini yeniden başlamadan
//    alır). Yanıttaki zamanlar UTC ISO. İkisi farklıysa (saat dilimi değiştirildi, panel yeniden başlamadı) tzMismatch.
//  - Eşleşen bir günde 24'ten çok ya da 5 dakikadan sık çalışan işler listeye girmez: "periyodik işler" özetinde aralık ve
//    sıradaki çalışmayla gösterilir; panelin kendi iç denetimleri (30 sn – 24 sa, açılıştan itibaren sayılır) de orada.
// Uyduda 409: ağ geçidi işleri ana cihazdadır.
import { execFile } from 'child_process';
import { promisify } from 'util';
import type express from 'express';
import { dbAll, dbGet, dbTimeMs } from './db';
import { isLinux } from './system';
import { isSatellite } from './role';
import { isValidTimezone } from './util';
import { listRules, ruleActive, type ParentalRule } from './parental';
import { loadSchedules, scheduleActive, supported, type Schedule } from './trafficSchedule';
import { readSystemCron, validateCommand, validateSchedule } from './cronSync';
import { vaultStatus, forgetDue, ymd } from './vault';
import { isMac } from './qos';
import { zapretBrief, ZAPRET_CHECK_HOUR } from './zapret';
import { LIST_MAX_AGE_MS } from './categoryLists';
import { REACH_WATCH_INTERVAL_H } from './wgWatch';

const execFileP = promisify(execFile);
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 62;
const DEFAULT_DAYS = 7;
const MAX_ITEMS = 5000;          // yanıt üst sınırı (lite profil): aşılırsa en erkenleri döner, truncated
const PER_DAY_LIMIT = 24;        // eşleşen günde 24'ten fazla çalışma = "periyodik işler" özetine
const FREQ_MIN = 5;              // ardışık iki çalışma 5 dakikadan yakınsa da özete
const SCAN_PAD_MS = 8 * DAY_MS;  // aralıktan önce başlayan pencerenin gerçek başlangıcı için (haftalık döngü + 1 gün)

export type AgendaSource = 'parental' | 'traffic' | 'cron' | 'system' | 'vault' | 'speedtest' | 'quota' | 'zapret';
export type AgendaKind = 'window' | 'job' | 'reset';
// sub: sayfanın açılacak alt sekmesi (Bant Genişliği → limits, Sistem & Log → cron)
export interface AgendaLink { tab: string; sub?: string }
export interface AgendaItem {
  id: string; source: AgendaSource; title: string; start: string; end: string | null; kind: AgendaKind;
  approx: boolean; link: AgendaLink | null; note?: string;
  since?: boolean;   // pencere: aralıktan çok önce başlamış (gerçek başlangıç bilinmiyor; start = from). end null: bitmiyor
}
export interface PeriodicJob {
  id: string; source: AgendaSource | 'panel'; kind: 'periodic'; title: string;
  everySec: number | null;   // null: zaman hesaplanamadı / çalışmaz (note nedenini söyler) ya da açılışta (atBoot)
  next: string | null; note?: string; link: AgendaLink | null; atBoot?: boolean;
  dead?: boolean;            // zamanlayıcıya hiç ulaşmıyor (geçersiz zamanlama, Debian cron'un yok saydığı dosya)
}
// warning: kaynak okundu ama dikkat isteyen durum (ör. cron dosyasının tamamı Debian cron'ca yok sayılıyor)
export interface AgendaSourceState { id: AgendaSource | 'panel'; label: string; count: number; error: string | null; warning: string | null }
export interface AgendaResponse {
  tz: string; processTz: string; tzMismatch: boolean; now: string; from: string; to: string;
  items: AgendaItem[]; periodic: PeriodicJob[]; sources: AgendaSourceState[]; truncated: boolean;
}
export interface AgendaDeps {
  speedtestNextAt: () => number | null;            // index.ts rescheduleSpeedtest'in kurduğu zamanlayıcının anı (ms)
  speedtestIntervalMin: () => Promise<number>;     // index.ts getSpeedtestIntervalMin (0 = kapalı)
}

const iso = (ms: number) => new Date(ms).toISOString();
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 200);
const hhmm = (s: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// Ebeveyn motorunun saati okuma biçimi (parental.ts minutes: 1.–2. ve 4.–5. karakter, düzenli ifade yok): HH:MM dışında
// saklanmış bir değer ("08:00:00" — yedekten geri yüklenen satır doğrulanmaz) de motorla aynı dakikaya düşer. Durum tam sayı
// dakikada değişir (now >= s ⇔ now >= ⌈s⌉).
const parentalMark = (s: unknown): number | null => {
  const t = String(s ?? '');
  const v = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return Number.isFinite(v) ? Math.ceil(v) : null;
};
// Yerel takvim günleri: [a, b) aralığına değen her günün yerel gece yarısı (yaz saati boşluğunda o günün ilk anı)
function localDays(a: number, b: number): Date[] {
  const out: Date[] = [];
  const s = new Date(a);
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d.getTime() < b; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(d);
  }
  return out;
}

// ── Pencere açılımı ──────────────────────────────────────────────────────────
// pred yalnız yerel saatin (gün, saat, dakika) değerine bakar ve değeri yalnız yerel saat bounds'taki bir dakikayı (gün içi
// dakika; gece yarısı = 0 her zaman eklenir) geçerken ya da yaz saati geçişinde değişebilir. Bu anların hepsi aday olarak
// denenir; iki aday arasında durum sabittir. Bir günün iki ofseti varsa (geçiş günü) sınır her iki ofsetle de eklenir: geri
// alınan saatte aynı yerel dakika iki kez yaşanır. Fazladan aday zararsızdır (aynı durum birleşir). Sonuç [a, b) içinde
// pred'in doğru olduğu, birleşik aralıklar.
export function activeIntervals(pred: (d: Date) => boolean, bounds: number[], a: number, b: number): [number, number][] {
  const marks = [...new Set([0, ...bounds.filter(n => Number.isInteger(n) && n >= 0 && n < 1440)])];
  const cands = new Set<number>([a]);
  for (const day of localDays(a - DAY_MS, b + DAY_MS)) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const offs = [...new Set([day.getTimezoneOffset(), next.getTimezoneOffset()])];
    const base = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate());
    for (const off of offs) {
      for (const m of marks) {
        const t = base + (m + off) * MIN_MS;
        if (t > a && t < b) cands.add(t);
      }
    }
    if (offs.length > 1) {
      // Geçiş anı (dakika çözünürlüğünde): ofsetin değiştiği ilk dakika
      let lo = day.getTime(), hi = next.getTime();
      const o0 = day.getTimezoneOffset();
      while (hi - lo > MIN_MS) {
        const mid = lo + Math.floor((hi - lo) / (2 * MIN_MS)) * MIN_MS;
        if (new Date(mid).getTimezoneOffset() === o0) lo = mid; else hi = mid;
      }
      if (hi > a && hi < b) cands.add(hi);
    }
  }
  const pts = [...cands].sort((x, y) => x - y);
  const out: [number, number][] = [];
  let open: number | null = null;
  for (const t of pts) {
    const on = pred(new Date(t));
    if (on && open === null) open = t;
    else if (!on && open !== null) { out.push([open, t]); open = null; }
  }
  if (open !== null) out.push([open, b]);
  return out;
}

// ── Saat dilimi bölgesi ──────────────────────────────────────────────────────
// off(t): t anında UTC'den ileri dakika. Süreç dilimi (motorlar) Date ile; başka bir adlı dilim (cron: timedatectl dilimi
// süreçten farklıysa) Intl ile.
export interface Zone { off(t: number): number }
export const LOCAL_ZONE: Zone = { off: t => -new Date(t).getTimezoneOffset() };
export function namedZone(tz: string): Zone | null {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return null;
  }
  return {
    off: t => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
      const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
      return Math.round((wall - Math.floor(t / MIN_MS) * MIN_MS) / MIN_MS);
    },
  };
}

// ── cron ─────────────────────────────────────────────────────────────────────
export interface CronSpec {
  min: number[]; hour: number[]; dom: boolean[]; mon: boolean[]; dow: boolean[]; domStar: boolean; dowStar: boolean;
  // Debian cron'un "joker" işi (entry.c MIN_STAR | HR_STAR: dakika ya da saat alanı '*' ile başlar; @hourly): yaz saati
  // geçişinde sabit saatli işten farklı çalışır (cron.c find_jobs doWild / doNonWild)
  wild: boolean;
}
const CRON_MACROS: Record<string, string> = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
};
const CRON_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

// Panelin kabul ettiği alt küme (validateSchedule) dışındaki ya da Debian cron'un reddettiği zamanlama → null.
export function parseCron(raw: unknown): CronSpec | null {
  const s0 = String(raw ?? '').trim();
  if (validateSchedule(s0) !== null) return null;
  const f = (CRON_MACROS[s0] ?? s0).split(/\s+/);
  const bits: boolean[][] = [];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = CRON_RANGES[i];
    const b = new Array<boolean>(hi + 1).fill(false);
    for (const part of f[i].split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
      if (!m) return null;
      if (m[4] !== undefined && m[1] !== '*' && m[3] === undefined) return null;  // "1/2": Debian cron "bad minute"
      const start = m[1] === '*' ? lo : Number(m[2]);
      const end = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : start;
      const step = m[4] !== undefined ? Number(m[4]) : 1;
      for (let v = start; v <= end; v += step) b[v] = true;
    }
    bits.push(b);
  }
  const dow = bits[4].slice(0, 7);
  if (bits[4][7]) dow[0] = true;   // 7 = Pazar
  const idx = (b: boolean[]) => b.flatMap((on, i) => (on ? [i] : []));
  return {
    min: idx(bits[0]), hour: idx(bits[1]), dom: bits[2], mon: bits[3], dow,
    domStar: f[2].startsWith('*'), dowStar: f[4].startsWith('*'), wild: f[0].startsWith('*') || f[1].startsWith('*'),
  };
}
export const isStepWithoutRange = (raw: unknown) =>
  validateSchedule(raw) === null && String(raw ?? '').trim().split(/\s+/).some(fld => fld.split(',').some(p => /^\d+\/\d+$/.test(p)));

// Duvar takvimi günü (UTC alanlarıyla kodlanmış gece yarısı) eşleşiyor mu
function cronDayMatch(c: CronSpec, wd: Date): boolean {
  if (!c.mon[wd.getUTCMonth() + 1]) return false;
  const dm = c.dom[wd.getUTCDate()], wm = c.dow[wd.getUTCDay()];
  return c.domStar || c.dowStar ? dm && wm : dm || wm;
}
export interface CronRun { t: number; approx: boolean }
// [fromMs, toMs) içindeki çalışmalar (artan), zone diliminin duvar saatiyle — Debian cron'un yaz saati kuralı (cron.c ana
// döngü): ileri alınınca (case 2) atlanan dakikalardaki SABİT saatli iş geçiş anında bir kez çalışır, joker iş o dakikalar
// için çalışmaz; geri alınınca (case 0) tekrarlanan saatte sabit saatli iş yalnız ilk yaşanışta, joker iş iki kez. Geçişten
// etkilenen çalışmalar yaklaşık (Debian geçiş anında birikmiş işleri art arda, araya 10 sn koyarak başlatır).
export function* cronRuns(c: CronSpec, fromMs: number, toMs: number, zone: Zone = LOCAL_ZONE): Generator<CronRun> {
  const wallFrom = fromMs + zone.off(fromMs) * MIN_MS, wallTo = toMs + zone.off(toMs) * MIN_MS;
  for (let wd = Math.floor(wallFrom / DAY_MS) * DAY_MS; wd <= wallTo; wd += DAY_MS) {
    if (!cronDayMatch(c, new Date(wd))) continue;
    // Günün anları [wd − 14 sa, wd + 1 gün + 12 sa] içindedir; uçlarda ofset aynıysa gün içinde geçiş yok
    const oA = zone.off(wd - 14 * 3600_000), oB = zone.off(wd + DAY_MS + 14 * 3600_000);
    const runs = new Map<number, boolean>();
    let gapEnd: number | null = null;   // ileri geçişin anı (gerekince bir kez aranır)
    for (const h of c.hour) {
      for (const mi of c.min) {
        const w = wd + (h * 60 + mi) * MIN_MS;
        if (oA === oB) { runs.set(w - oA * MIN_MS, false); continue; }
        const ts = [oA, oB].map(o => [w - o * MIN_MS, o]).filter(([t, o]) => zone.off(t) === o).map(([t]) => t).sort((x, y) => x - y);
        if (ts.length === 1) {
          if (!runs.has(ts[0])) runs.set(ts[0], false);
        } else if (ts.length === 2) {
          runs.set(ts[0], true);                 // tekrarlanan saat: ilk yaşanış
          if (c.wild) runs.set(ts[1], true);     // joker iş ikinci yaşanışta da
        } else if (!c.wild) {
          // Atlanan dakika: geçiş anı = ofsetin oB olduğu ilk dakika (w − oB … w − oA arasında)
          if (gapEnd === null) {
            let lo = w - oB * MIN_MS, hi = w - oA * MIN_MS;
            while (hi - lo > MIN_MS) {
              const mid = lo + Math.floor((hi - lo) / (2 * MIN_MS)) * MIN_MS;
              if (zone.off(mid) === oB) hi = mid; else lo = mid;
            }
            gapEnd = hi;
          }
          runs.set(gapEnd, true);
        }
      }
    }
    for (const t of [...runs.keys()].sort((x, y) => x - y)) {
      if (t >= toMs) return;
      if (t >= fromMs) yield { t, approx: runs.get(t) === true };
    }
  }
}
export function* cronTimes(c: CronSpec, fromMs: number, toMs: number, zone: Zone = LOCAL_ZONE): Generator<number> {
  for (const r of cronRuns(c, fromMs, toMs, zone)) yield r.t;
}
// İfadenin after'dan SONRAKİ ilk çalışması; geçersiz / desteklenmeyen / hiç gelmeyen (31 Şubat) → null.
export function cronNext(expr: unknown, after: Date, horizonDays = 8 * 366, zone: Zone = LOCAL_ZONE): Date | null {
  const c = parseCron(expr);
  if (!c) return null;
  const from = (Math.floor(after.getTime() / MIN_MS) + 1) * MIN_MS;
  for (const t of cronTimes(c, from, from + horizonDays * DAY_MS, zone)) return new Date(t);
  return null;
}
// Eşleşen bir günde kaç kez ve en sık kaç dakikada bir çalışır (seçilen aralıktan bağımsız): 24'ten çok ya da 5 dakikadan
// sık → periyodik özet. Gece yarısını aşan aralık yalnız her gün eşleşiyorsa sayılır.
export function cronPeriodic(c: CronSpec): boolean {
  const mins = c.hour.flatMap(h => c.min.map(m => h * 60 + m));
  if (mins.length > PER_DAY_LIMIT) return true;
  let gap = Infinity;
  for (let i = 1; i < mins.length; i++) gap = Math.min(gap, mins[i] - mins[i - 1]);
  if (mins.length > 1 && c.dom.slice(1).every(Boolean) && c.dow.every(Boolean)) gap = Math.min(gap, 1440 - mins[mins.length - 1] + mins[0]);
  return gap < FREQ_MIN;
}

// ── Saat dilimi ──────────────────────────────────────────────────────────────
export const processTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
// /api/system/timezone ile aynı kaynak (timedatectl); okunamazsa süreç dilimi.
async function systemTimeZone(): Promise<string> {
  if (!isLinux) return processTimeZone();
  try {
    const { stdout } = await execFileP('timedatectl', ['show', '--property=Timezone', '--value'], { timeout: 5000 });
    const tz = stdout.trim();
    return tz && isValidTimezone(tz) ? tz : processTimeZone();
  } catch {
    return processTimeZone();
  }
}
// Sistem dilimi ile sürecin dilimi aralıkta farklı saat veriyor mu (adlar farklı ama kurallar aynıysa uyarı yok)
export function zonesDiffer(a: string, b: string, from: number, to: number): boolean {
  if (a === b) return false;
  const za = namedZone(a), zb = namedZone(b);
  if (!za || !zb) return false;
  for (let t = from; t <= to + DAY_MS; t += DAY_MS) {
    if (za.off(t) !== zb.off(t)) return true;
  }
  return false;
}

// ── Aralık ───────────────────────────────────────────────────────────────────
// Dilim yazılmamış tarih ve tarih-saat YEREL (ajandanın geri kalanı gibi; JS yalnız tarihi UTC gece yarısı sayardı); taşan
// tarih ("2026-02-31", "25:00") reddedilir (JS sessizce sonraki aya kaydırırdı).
const parseInstant = (v: unknown): number => {
  const s = String(v ?? '').trim();
  if (/^\d{10,14}$/.test(s)) return Number(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return NaN;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number);
  const ms = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > dim || h > 23 || mi > 59 || se > 59) return NaN;
  if (m[8]) {
    const z = /^[+-](\d{2}):?(\d{2})$/.exec(m[8]);
    if (z && (Number(z[1]) > 23 || Number(z[2]) > 59)) return NaN;
    return Date.parse(s.replace(' ', 'T'));
  }
  return new Date(y, mo - 1, d, h, mi, se, ms).getTime();
};
// from / to: ISO zaman ya da epoch ms. Yoksa bugünün yerel gece yarısından başlayarak days gün (varsayılan 7, en çok 62).
export function parseRange(q: { from?: unknown; to?: unknown; days?: unknown }, now: number): { from: number; to: number } | { error: string } {
  const has = (v: unknown) => v !== undefined && v !== null && String(v) !== '';
  let days = DEFAULT_DAYS;
  if (has(q.days)) {
    days = Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_RANGE_DAYS) return { error: `days 1 ile ${MAX_RANGE_DAYS} arasında bir tam sayı olmalı` };
  }
  let from: number;
  if (has(q.from)) {
    from = parseInstant(q.from);
    if (!Number.isFinite(from)) return { error: 'from geçersiz (ISO zaman ya da epoch ms)' };
  } else {
    const d = new Date(now);
    from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  let to: number;
  if (has(q.to)) {
    to = parseInstant(q.to);
    if (!Number.isFinite(to)) return { error: 'to geçersiz (ISO zaman ya da epoch ms)' };
  } else {
    const d = new Date(from);
    to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
  }
  if (to <= from) return { error: 'to, from\'dan sonra olmalı' };
  // Yerel 62 gün yaz saati geçişinde ±1 sa uzayabilir
  if (to - from > MAX_RANGE_DAYS * DAY_MS + 3600_000) return { error: `Aralık en çok ${MAX_RANGE_DAYS} gün olabilir` };
  if (Math.abs(from - now) > 400 * DAY_MS) return { error: 'from bugünden en çok 400 gün uzakta olabilir' };
  return { from, to };
}

// ── Kaynaklar ────────────────────────────────────────────────────────────────
interface Ctx {
  from: number; to: number; now: number; days: number; deps: AgendaDeps; periodic: PeriodicJob[];
  cronZone: Zone;                                  // cron'un çalıştığı dilim (sistemin güncel dilimi)
  warnings: Map<AgendaSource, string>;
}
const LABELS: Record<AgendaSource, string> = {
  parental: 'Ebeveyn Kontrol', traffic: 'Trafik Zamanlayıcı', cron: 'Cron görevleri', system: 'Sistem görevleri',
  vault: 'Bulut yedeği', speedtest: 'Hız testi', quota: 'Kota dönemi', zapret: 'Zapret denetimi',
};
const overlaps = (s: number, e: number, c: Ctx) => s < c.to && e > c.from;

// Kuralın / pencerenin etkin olduğu aralıklar — motorun kendi fonksiyonuyla (birim testi bunları dakika dakika karşılaştırır)
export const ruleIntervals = (r: ParentalRule, a: number, b: number) => activeIntervals(d => ruleActive(r, d),
  r.windows.flatMap(w => [parentalMark(w.start), parentalMark(w.end)]).filter((n): n is number => n !== null), a, b);
export const scheduleIntervals = (s: Schedule, a: number, b: number) => activeIntervals(d => scheduleActive(s, d),
  [hhmm(s.time_start), hhmm(s.time_end)].filter((n): n is number => n !== null), a, b);

// Tarama ([from − 8 gün, to + 8 gün)) uçlarına değen aralık: bitişi / başlangıcı taramanın sınırı, gerçek an değil. Haftalık
// döngüde 8 günden uzun etkin pencere hiç bitmez ("sürekli etkin"): end null, başlangıç bilinmiyor (since, start = from).
function windowItem(c: Ctx, s: number, e: number, base: Omit<AgendaItem, 'start' | 'end' | 'since'>): AgendaItem {
  const since = s <= c.from - SCAN_PAD_MS, open = e >= c.to + SCAN_PAD_MS;
  return {
    ...base, start: iso(since ? c.from : s), end: open ? null : iso(e), ...(since ? { since } : {}),
    ...(since && open ? { note: base.note ? `Sürekli etkin · ${base.note}` : 'Sürekli etkin' } : {}),
  };
}

// (a) Ebeveyn Kontrol: kuralın etkin (engelin uygulandığı) aralıkları — "saatlerde engelle" pencerelerin birleşimi, "yalnız
// saatlerde izin ver" tümleyeni. Her zaman açık ve kapalı kurallar zamanlanmış değildir, listelenmez.
async function srcParental(c: Ctx): Promise<AgendaItem[]> {
  const out: AgendaItem[] = [];
  for (const r of await listRules()) {
    if (!r.enabled || r.mode === 'always' || !r.windows.length) continue;
    for (const [s, e] of ruleIntervals(r, c.from - SCAN_PAD_MS, c.to + SCAN_PAD_MS)) {
      if (!overlaps(s, e, c)) continue;
      out.push(windowItem(c, s, e, {
        id: `parental:${r.id}:${s}`, source: 'parental', title: r.name || `Kural #${r.id}`,
        kind: 'window', approx: false, link: { tab: 'parental' },
        note: `${r.blockAll ? 'İnternet kapalı' : 'Kategori / site engeli'}${r.mode === 'outside' ? ' (izin saatleri dışında)' : ''}`,
      }));
    }
  }
  return out;
}

// (b) Trafik Zamanlayıcı: penceresi uygulanan (açık, alan adı olan) uygulama kuralları; "Engelle" pencereleri uygulanmaz.
async function srcTraffic(c: Ctx): Promise<AgendaItem[]> {
  const scheds = (await loadSchedules()).filter(supported);
  if (!scheds.length) return [];
  const rules = new Map((await dbAll("SELECT id, app_name FROM traffic_routing WHERE enabled = 1 AND domains != ''") as any[])
    .map(r => [Number(r.id), String(r.app_name || '')]));
  const vps = new Map((await dbAll('SELECT id, location FROM vps_servers') as any[]).map(v => [String(v.id), String(v.location || '')]));
  const out: AgendaItem[] = [];
  for (const s of scheds) {
    const app = rules.get(Number(s.traffic_routing_id));
    if (app === undefined) continue;
    const exit = String(s.schedule_exit_node || 'isp');
    const base = vps.has(exit) ? `VPS ${vps.get(exit) || `#${exit}`}` : 'ISP (Direkt)';
    const label = `${base}${s.schedule_dpi_bypass ? ' + DPI' : ''}`;
    for (const [a, b] of scheduleIntervals(s, c.from - SCAN_PAD_MS, c.to + SCAN_PAD_MS)) {
      if (!overlaps(a, b, c)) continue;
      out.push(windowItem(c, a, b, {
        id: `traffic:${s.id}:${a}`, source: 'traffic', title: `${app || `Kural #${s.traffic_routing_id}`} → ${label}`,
        kind: 'window', approx: false, link: { tab: 'trafficcontrol' },
        note: 'Uygulamanın çıkışı bu saatlerde değişir',
      }));
    }
  }
  return out;
}

const fmtEvery = (sec: number) => (sec % 86400 === 0 ? `${sec / 86400} gün` : sec % 3600 === 0 ? `${sec / 3600} sa` : sec % 60 === 0 ? `${sec / 60} dk` : `${sec} sn`);
const CRON_LINK: AgendaLink = { tab: 'maintenance', sub: 'cron' };
const STEP_FIX = 'adımı * ya da aralıkla yazın, ör. "1/2" yerine "1-59/2"';
// Debian cron'un yok saydığı dosyadaki görev: çalışmaz (özete, zaman yok)
const deadJob = (c: Ctx, id: string, source: 'cron' | 'system', title: string, note: string) =>
  c.periodic.push({ id, source, kind: 'periodic', title, everySec: null, next: null, note, link: CRON_LINK, dead: true });
// Bir cron satırını açar: eşleşen günde 24'ten çok ya da 5 dakikadan sık → periyodik özet; hesaplanamayan → özet (neden);
// yoksa liste öğeleri. Saatler cron'un dilimiyle (c.cronZone).
function expandCron(c: Ctx, key: string, source: 'cron' | 'system', title: string, schedule: string, link: AgendaLink): AgendaItem[] {
  const spec = parseCron(schedule);
  if (!spec) {
    const atBoot = schedule.trim() === '@reboot';
    const why = atBoot ? 'Açılışta çalışır' : `Zaman hesaplanamadı: "${schedule.slice(0, 60)}"`;
    c.periodic.push({ id: `${source}:${key}`, source, kind: 'periodic', title, everySec: null, next: null, note: why, link, ...(atBoot ? { atBoot } : {}) });
    return [];
  }
  let periodic = cronPeriodic(spec);
  const runs: CronRun[] = [];
  if (!periodic) {
    // İkinci koruma (yanıt boyutu): yaz saati günü joker iş 25 kez çalışabilir
    const cap = (PER_DAY_LIMIT + 2) * c.days;
    for (const r of cronRuns(spec, c.from, c.to, c.cronZone)) {
      runs.push(r);
      if (runs.length > cap) { periodic = true; break; }
    }
  }
  if (periodic) {
    const n1 = cronNext(schedule, new Date(c.now), undefined, c.cronZone);
    const n2 = n1 ? cronNext(schedule, n1, undefined, c.cronZone) : null;
    c.periodic.push({
      id: `${source}:${key}`, source, kind: 'periodic', title, everySec: n1 && n2 ? Math.round((n2.getTime() - n1.getTime()) / 1000) : null,
      next: n1 ? n1.toISOString() : null, note: `cron: ${schedule}`, link,
    });
    return [];
  }
  return runs.map(r => ({
    id: `${source}:${key}:${r.t}`, source, title, start: iso(r.t), end: null, kind: 'job' as const, approx: r.approx, link,
    note: `cron: ${schedule}`,
  }));
}

// (c) Panel Cron görevleri (Sistem & Log → Cron) — /etc/cron.d/pi5-panel'e yazılanlar (cronSync.ts syncCronJobs süzgeci);
// varsayılan "Pi-hole Gravity" (04:00) de buradadır. Dosyaya yazılan satırlardan biri Debian cron'un reddettiği biçimdeyse
// ("1/2") cron dosyanın TAMAMINI yok sayar: hiçbir panel görevi çalışmaz.
async function srcCron(c: Ctx): Promise<AgendaItem[]> {
  const jobs = await dbAll('SELECT id, name, schedule, command, enabled FROM cron_jobs ORDER BY id') as any[];
  const listed = jobs.filter(j => Number.isInteger(Number(j.id)) && Number(j.id) > 0 && j.enabled && !validateCommand(j.command));
  const bad = listed.find(j => !validateSchedule(j.schedule) && isStepWithoutRange(j.schedule));
  const badRef = bad ? `görev #${bad.id} "${String(bad.schedule).trim()}"` : '';
  if (bad) {
    c.warnings.set('cron', `${String(bad.name || `Görev #${bad.id}`)} (${badRef}) Debian cron'da geçersiz: cron /etc/cron.d/pi5-panel `
      + `dosyasının tamamını yok sayar, hiçbir panel görevi çalışmaz. Sistem & Log → Cron'da düzeltin (${STEP_FIX}).`);
  }
  const out: AgendaItem[] = [];
  for (const j of listed) {
    const title = String(j.name || `Görev #${j.id}`);
    const sched = String(j.schedule).trim();
    if (validateSchedule(j.schedule)) {
      c.periodic.push({ id: `cron:${j.id}`, source: 'cron', kind: 'periodic', title, everySec: null,
        next: null, note: 'Zamanlama geçersiz — zamanlayıcıya yazılmadı, çalışmaz', link: CRON_LINK, dead: true });
      continue;
    }
    if (bad) {
      deadJob(c, `cron:${j.id}`, 'cron', title, isStepWithoutRange(sched)
        ? `Zamanlama "${sched}" Debian cron'da geçersiz (${STEP_FIX}) — cron bu yüzden /etc/cron.d/pi5-panel dosyasının tamamını yok sayar: hiçbir panel görevi çalışmaz`
        : `Çalışmaz: ${badRef} Debian cron'da geçersiz — cron /etc/cron.d/pi5-panel dosyasının tamamını yok sayar`);
      continue;
    }
    out.push(...expandCron(c, String(j.id), 'cron', title, sched, CRON_LINK));
  }
  return out;
}

// (d) Sistem cron'u: Klyrix Gate gece güncellemesi (/etc/cron.d/pi5-maintenance, 03:30) ve Pi-hole'un kendi görevleri.
function systemCronTitle(source: string, command: string): string {
  if (/update-job\.sh|--unit=pi5-update/.test(command)) return 'Panel güncellemesi (gece)';
  if (/pihole\s+updateGravity/.test(command)) return 'Pi-hole: liste güncellemesi (gravity)';
  if (/pihole\s+flush/.test(command)) return 'Pi-hole: sorgu günlüğü temizliği';
  if (/pihole\s+updatechecker/.test(command)) return 'Pi-hole: sürüm denetimi';
  if (/logrotate/.test(command)) return `${source}: günlük döndürme`;
  return `${source}: ${command.replace(/\s+/g, ' ').slice(0, 60)}`;
}
const SYSTEM_CRON_FILE: Record<string, string> = { pihole: '/etc/cron.d/pihole', klyrix: '/etc/cron.d/pi5-maintenance' };
async function srcSystem(c: Ctx): Promise<AgendaItem[]> {
  const out: AgendaItem[] = [];
  const entries = readSystemCron().map(e => ({ ...e, file: e.source === 'Pi-hole' ? 'pihole' : 'klyrix' }));
  // Debian cron'un reddettiği satır ("1/2") dosyanın tamamını devre dışı bırakır (dosya başına)
  const bad = new Map<string, string>();
  for (const e of entries) if (!bad.has(e.file) && isStepWithoutRange(e.schedule)) bad.set(e.file, e.schedule);
  for (const [file, sched] of bad) {
    const w = `${SYSTEM_CRON_FILE[file]} içindeki "${sched}" satırı Debian cron'da geçersiz: cron dosyanın tamamını yok sayar, oradaki görevler çalışmaz.`;
    c.warnings.set('system', c.warnings.has('system') ? `${c.warnings.get('system')} ${w}` : w);
  }
  const seq = new Map<string, number>();   // kimlik: dosya + dosyadaki sıra
  for (const e of entries) {
    const i = seq.get(e.file) ?? 0;
    seq.set(e.file, i + 1);
    const title = systemCronTitle(e.source, e.command);
    const badSched = bad.get(e.file);
    if (badSched !== undefined) {
      deadJob(c, `system:${e.file}-${i}`, 'system', title, isStepWithoutRange(e.schedule)
        ? `Zamanlama "${e.schedule}" Debian cron'da geçersiz — cron bu yüzden ${SYSTEM_CRON_FILE[e.file]} dosyasının tamamını yok sayar`
        : `Çalışmaz: ${SYSTEM_CRON_FILE[e.file]} içindeki "${badSched}" satırı Debian cron'da geçersiz — cron dosyanın tamamını yok sayar`);
      continue;
    }
    out.push(...expandCron(c, `${e.file}-${i}`, 'system', title, e.schedule, CRON_LINK));
  }
  return out;
}

// (e) Bulut yedeği: sıradaki otomatik yedek vault.ts'in kendi hesabıyla (vaultStatus nextRun), sonraki günler ayarlı saatte;
// Pazar budaması forgetDue ile. Bağlı değilse ya da geri yükleme kipinde (otomatik yedek duraklatıldı) yoktur.
async function srcVault(c: Ctx): Promise<AgendaItem[]> {
  const st = await vaultStatus() as {
    configured?: boolean; conf?: { schedule?: string; paused?: boolean } | null;
    last?: { nextRun?: number | null; forget?: string | null; attempt?: string | null };
  };
  const nextRun = st.last?.nextRun;
  if (!st.configured || !st.conf || st.conf.paused || typeof nextRun !== 'number') return [];
  const slot = hhmm(String(st.conf.schedule || ''));
  const attempt = st.last?.attempt || '';
  const first = nextRun * 1000;
  const slotOn = (d: Date, plus: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus, Math.floor((slot ?? 0) / 60), (slot ?? 0) % 60);
  // Bugün denenmiş ve bekleyen yeniden deneme gece yarısını aşıyorsa nextAutoRun o anı döner; ama yeniden deneme yalnız
  // denendiği gün yapılır (vault.ts retryDue: attempt === bugün) ve o saat günün yedek saatinden önceyse (scheduleDue) o an
  // yedek alınmaz → listelenmez. Günün asıl yedeği aşağıdaki döngüden gelir.
  const fd = new Date(first);
  const ghost = slot !== null && attempt === ymd(new Date(c.now)) && ymd(fd) !== attempt
    && fd.getHours() * 60 + fd.getMinutes() < slot;
  const runs: { t: number; note?: string }[] = ghost ? []
    : [{ t: first, note: first <= c.now + MIN_MS ? 'Kaçırılan yedek — birkaç dakika içinde' : undefined }];
  if (slot !== null) {
    // Sonraki yedekler: nextRun'ın gününden başlayarak her gün ayarlı saatte — nextRun'dan sonra ve o gün denenmediyse
    // (aynı gün yeniden deneme, kaçırılan yedek, gece yarısını aşan yeniden deneme durumlarının hepsi)
    for (let i = 0; ; i++) {
      const day = slotOn(fd, i);
      const t = day.getTime();
      if (t >= c.to) break;
      if (t <= first || ymd(day) === attempt) continue;
      runs.push({ t });
    }
  }
  let lastForget = st.last?.forget || undefined;
  const out: AgendaItem[] = [];
  for (const r of runs) {
    const d = new Date(r.t);
    const prune = forgetDue(lastForget, d);
    if (prune) lastForget = ymd(d);
    if (r.t < c.from || r.t >= c.to) continue;
    out.push({
      id: `vault:${r.t}`, source: 'vault', title: prune ? 'Bulut yedeği + eski yedeklerin budanması' : 'Bulut yedeği',
      start: iso(r.t), end: null, kind: 'job', approx: false, link: { tab: 'backup' }, note: r.note,
    });
  }
  return out;
}

// (f) Otomatik hız testi: sıradaki ölçüm index.ts'in kurduğu zamanlayıcıdan (kesin); sonrakiler aralıkla (yaklaşık: ölçüm
// süresi ve panelin yeniden başlaması kaydırır). Zamanlayıcı bilinmiyorsa son ölçüm + aralık (yaklaşık).
async function srcSpeedtest(c: Ctx): Promise<AgendaItem[]> {
  if (!isLinux) return [];
  const min = await c.deps.speedtestIntervalMin();
  if (!(min > 0)) return [];
  const step = min * MIN_MS;
  let first = c.deps.speedtestNextAt();
  let approxFirst = false;
  if (first === null) {
    approxFirst = true;
    const row = await dbGet('SELECT timestamp FROM speed_tests ORDER BY id DESC LIMIT 1').catch(() => null) as { timestamp?: string } | null;
    const last = dbTimeMs(row?.timestamp);
    first = Number.isFinite(last) ? last + step : c.now + step;
    if (first < c.now) first += Math.ceil((c.now - first) / step) * step;
  }
  if (min < 60) {
    c.periodic.push({ id: 'speedtest', source: 'speedtest', kind: 'periodic', title: 'Otomatik hız testi', everySec: min * 60,
      next: iso(first), note: approxFirst ? 'Sıradaki ölçüm yaklaşık' : undefined, link: { tab: 'speedtest' } });
    return [];
  }
  const out: AgendaItem[] = [];
  for (let t = first, i = 0; t < c.to; t += step, i++) {
    if (t < c.from) continue;
    out.push({
      id: `speedtest:${t}`, source: 'speedtest', title: 'Otomatik hız testi', start: iso(t), end: null, kind: 'job',
      approx: approxFirst || i > 0, link: { tab: 'speedtest' }, note: i > 0 ? `Her ${fmtEvery(min * 60)}` : undefined,
    });
  }
  return out;
}

// (g) Kota dönemi: günlük kota gece yarısı, aylık kota ayın 1'inde yenilenir (qos.ts periodKeys — yerel tarih); yalnız o
// türde kotası olan açık sınır varsa.
const QUOTA_LINK: AgendaLink = { tab: 'bandwidth', sub: 'limits' };
async function srcQuota(c: Ctx): Promise<AgendaItem[]> {
  const rows = (await dbAll('SELECT device_mac, daily_limit_mb, monthly_limit_mb FROM bandwidth_limits WHERE enabled = 1') as any[])
    .filter(r => isMac(String(r.device_mac || '').trim().toLowerCase()));
  const daily = rows.filter(r => Number(r.daily_limit_mb) > 0).length;
  const monthly = rows.filter(r => Number(r.monthly_limit_mb) > 0).length;
  if (!daily && !monthly) return [];
  const out: AgendaItem[] = [];
  for (const day of localDays(c.from, c.to)) {
    const t = day.getTime();
    if (t < c.from) continue;
    if (monthly && day.getDate() === 1) {
      out.push({ id: `quota:monthly:${t}`, source: 'quota', title: 'Aylık kota yenilenir', start: iso(t), end: null, kind: 'reset',
        approx: false, link: QUOTA_LINK, note: `${monthly} cihaz` });
    }
    if (daily) {
      out.push({ id: `quota:daily:${t}`, source: 'quota', title: 'Günlük kota yenilenir', start: iso(t), end: null, kind: 'reset',
        approx: false, link: QUOTA_LINK, note: `${daily} cihaz` });
    }
  }
  return out;
}

// (h) Zapret gece denetimi: index.ts'teki 10 dakikalık zamanlayıcı ZAPRET_CHECK_HOUR saatinde günde bir kez (ilk tur
// :00–:10 arasında). Zapret kurulu ve açık değilse denetim atlanır, listelenmez.
async function srcZapret(c: Ctx): Promise<AgendaItem[]> {
  const z = await zapretBrief();
  if (!z.installed || z.issue || !z.active) return [];
  const out: AgendaItem[] = [];
  for (const day of localDays(c.from, c.to)) {
    const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), ZAPRET_CHECK_HOUR, 0).getTime();
    if (t < c.from || t >= c.to) continue;
    out.push({ id: `zapret:${t}`, source: 'zapret', title: 'Zapret gece denetimi', start: iso(t), end: null, kind: 'job', approx: true,
      link: { tab: 'zapret' }, note: 'Saatin ilk 10 dakikasında; denenecek site varsa' });
  }
  return out;
}

// (j) Panelin kendi periyodik işleri: saate bağlı değil, panel açıldıktan itibaren sayılır (her yeniden başlatmada sıfırlanır).
// Kaynak: parental.ts TICK_MS, trafficSchedule.ts startScheduleWatch, qos.ts TICK_MS, index.ts watchVpsTunnels / healthCheck /
// ddnsAutoUpdate / refreshAsnRanges / refreshRoutingLists, trafficHistory.ts startTrafficRecorder, visits.ts POLL_MS,
// siteCategories.ts MAX_AGE_MS, categoryLists.ts LIST_MAX_AGE_MS, wgWatch.ts INTERVAL_MS.
const PANEL_PERIODIC: Omit<PeriodicJob, 'source' | 'kind' | 'next'>[] = [
  { id: 'panel:parental', title: 'Ebeveyn Kontrol kuralları uygulanır', everySec: 30, link: { tab: 'parental' } },
  { id: 'panel:traffic', title: 'Trafik Zamanlayıcı pencereleri denetlenir', everySec: 30, link: { tab: 'trafficcontrol' } },
  { id: 'panel:vps', title: 'VPS tünelleri denetlenir', everySec: 30, link: { tab: 'vps' } },
  { id: 'panel:visits', title: 'Ziyaret Geçmişi kaydedilir', everySec: 30, link: { tab: 'visits' } },
  { id: 'panel:qos', title: 'Kota ve hız sınırları uygulanır', everySec: 60, link: QUOTA_LINK },
  { id: 'panel:health', title: 'Servis sağlık denetimi', everySec: 300, link: { tab: 'maintenance' } },
  { id: 'panel:ddns', title: 'DDNS güncellemesi', everySec: 300, link: { tab: 'ddns' } },
  { id: 'panel:traffic-rec', title: 'Trafik kaydı', everySec: 300, link: { tab: 'bandwidth' }, note: '5 dakikalık saat sınırlarına hizalı' },
  { id: 'panel:routing-lists', title: 'Routing hazır listeleri (Yetişkin / Kumar) denetlenir', everySec: 3600, link: { tab: 'routing' },
    note: `Liste en çok ${LIST_MAX_AGE_MS / 3600_000} saatte bir indirilir; değişiklik 03:00–06:00 arasında uygulanır` },
  { id: 'panel:asn', title: 'AS aralıkları yenilenir (WhatsApp, Steam, Zoom …)', everySec: 6 * 3600, link: { tab: 'routing' },
    note: 'Yalnız AS kuralı varsa' },
  { id: 'panel:wg-reach', title: 'Ev VPN dışarıdan erişim denetimi', everySec: REACH_WATCH_INTERVAL_H * 3600, link: { tab: 'vps' },
    note: 'Ev VPN açıkken' },
  { id: 'panel:ut1', title: 'Site kategorileri (UT1) yenilenir', everySec: 24 * 3600, link: { tab: 'visits' } },
];

// ── Birleştirme ──────────────────────────────────────────────────────────────
export async function buildAgenda(from: number, to: number, deps: AgendaDeps, now = Date.now()): Promise<AgendaResponse> {
  const days = Math.max(1, Math.ceil((to - from) / DAY_MS));
  // Cron sistemin güncel dilimiyle çalışır; süreç dilimiyle aynı kurallardaysa (çoğu zaman) hızlı yerel hesap
  const tz = await systemTimeZone();
  const processTz = processTimeZone();
  const tzMismatch = zonesDiffer(tz, processTz, from, to);
  const cronZone = (tzMismatch && namedZone(tz)) || LOCAL_ZONE;
  const c: Ctx = { from, to, now, days, deps, periodic: [], cronZone, warnings: new Map() };
  const sources: AgendaSourceState[] = [];
  const items: AgendaItem[] = [];
  const run: [AgendaSource, (c: Ctx) => Promise<AgendaItem[]>][] = [
    ['parental', srcParental], ['traffic', srcTraffic], ['cron', srcCron], ['system', srcSystem], ['vault', srcVault],
    ['speedtest', srcSpeedtest], ['quota', srcQuota], ['zapret', srcZapret],
  ];
  for (const [id, fn] of run) {
    const before = c.periodic.length;
    try {
      const got = await fn(c);
      items.push(...got);
      sources.push({ id, label: LABELS[id], count: got.length + c.periodic.length - before, error: null, warning: c.warnings.get(id) ?? null });
    } catch (e) {
      c.periodic.splice(before);
      sources.push({ id, label: LABELS[id], count: 0, error: errMsg(e), warning: null });
    }
  }
  const panel: PeriodicJob[] = PANEL_PERIODIC.map(p => ({ ...p, source: 'panel', kind: 'periodic', next: null }));
  sources.push({ id: 'panel', label: 'Panelin periyodik işleri', count: panel.length, error: null, warning: null });
  items.sort((a, b) => a.start.localeCompare(b.start) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  const truncated = items.length > MAX_ITEMS;
  return {
    tz, processTz, tzMismatch, now: iso(now), from: iso(from), to: iso(to),
    items: truncated ? items.slice(0, MAX_ITEMS) : items, periodic: [...c.periodic, ...panel], sources, truncated,
  };
}

// GET /api/agenda?from&to (ya da ?days=N). Yalnız okuma: authGate (/api) geçerli; netAdminGuard'ın GET'te yaptığı tek şey
// önbelleği kapatmak — burada da kapatılır. Uyduda 409.
export function registerAgendaRoutes(app: express.Express, deps: AgendaDeps): void {
  app.get('/api/agenda', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — Ağ Ajandası ana cihazdadır' });
    const range = parseRange(req.query as Record<string, unknown>, Date.now());
    if ('error' in range) return res.status(400).json({ error: range.error });
    try {
      res.json(await buildAgenda(range.from, range.to, deps));
    } catch (e) {
      res.status(500).json({ error: `Ajanda hazırlanamadı: ${errMsg(e)}` });
    }
  });
}

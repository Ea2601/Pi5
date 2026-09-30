import fs from 'fs';
import sqlite3 from 'sqlite3';
import { dbAll, dbRun } from './db';
import { sampleBandwidth } from './bandwidth';
import { classifyMark, readNeighbors } from './topology';
import { FTL_DB } from './system';

// Trafik analizi: cihaz ve yol (yerel / DPI / VPS) başına 5 dakikalık bayt kayıtları + Pi-hole sorgularından uygulama
// kullanımı. Kaynak, ağ haritasıyla aynı nft sayaçları (bandwidth.ts: ip . ct mark). Kayıt tablosu bu modülün kendisi:
// traffic_usage (ts = aralık başı, unix sn). traffic_counter_last son sayaç değerlerini tutar → panel yeniden başlasa da
// aradaki trafik kaybolmaz; Pi yeniden başlayınca sayaçlar sıfırlanır (azalan sayaç = yeni başlangıç, değeri olduğu gibi
// fark sayılır). 14 gün saklanır. traffic_daily: cihaz başına günlük toplam (yerel gün, 400 gün) — kota (qos.ts) aylık
// dönemi 14 günlük kayıttan uzun sürer.

export const INTERVAL_S = 300;
const KEEP_S = 14 * 86400;
const DAILY_KEEP_DAYS = 400;

type Counter = { down: number; up: number };
export type UsageRow = { ts: number; mac: string; route: string; down: number; up: number };

// Önceki ve şimdiki sayaçlardan aralık farkları (anahtar "ip|işaret"). prev = null: hiç kayıtlı durum yok (ilk çalışma)
// → yalnız başlangıç noktası, fark yok. Kayıtlı durum BOŞ olabilir (trafik yoktu / tablo yeni kuruldu) — o zaman her yeni
// anahtarın tamamı bu aralığa aittir. Sayaç geriye gittiyse (tablo yeniden kuruldu / yeniden başlatma) yeni değer farktır.
export function counterDeltas(prev: Map<string, Counter> | null, cur: Map<string, Counter>): Map<string, Counter> {
  const out = new Map<string, Counter>();
  if (!prev) return out;
  for (const [k, c] of cur) {
    const p = prev.get(k);
    const down = !p || c.down < p.down ? c.down : c.down - p.down;
    const up = !p || c.up < p.up ? c.up : c.up - p.up;
    if (down > 0 || up > 0) out.set(k, { down, up });
  }
  return out;
}

// "ip|işaret" farklarını (cihaz, yol) satırlarına çevirir. Yol: 'local' | 'dpi' | 'vps:<id>'.
export function toUsageRows(ts: number, deltas: Map<string, Counter>, macOf: (ip: string) => string | undefined): UsageRow[] {
  const acc = new Map<string, UsageRow>();
  for (const [k, d] of deltas) {
    const bar = k.lastIndexOf('|');
    const ip = k.slice(0, bar), mark = Number(k.slice(bar + 1));
    const mac = macOf(ip) || `ip:${ip}`;
    const route = classifyMark(mark).exit;
    const key = `${mac}|${route}`;
    const r = acc.get(key) || { ts, mac, route, down: 0, up: 0 };
    r.down += d.down; r.up += d.up;
    acc.set(key, r);
  }
  return [...acc.values()];
}

let tableReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await dbRun(`CREATE TABLE IF NOT EXISTS traffic_usage (
        ts INTEGER NOT NULL, mac TEXT NOT NULL, route TEXT NOT NULL, down INTEGER NOT NULL DEFAULT 0, up INTEGER NOT NULL DEFAULT 0
      )`);
      await dbRun('CREATE INDEX IF NOT EXISTS idx_traffic_usage_ts ON traffic_usage(ts)');
      await dbRun(`CREATE TABLE IF NOT EXISTS traffic_counter_last (k TEXT PRIMARY KEY, down INTEGER NOT NULL, up INTEGER NOT NULL)`);
      await dbRun(`CREATE TABLE IF NOT EXISTS traffic_daily (
        day TEXT NOT NULL, mac TEXT NOT NULL, down INTEGER NOT NULL DEFAULT 0, up INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, mac)
      )`);
      // Tablo boşsa (ilk kez) mevcut 5 dakikalık kayıtlardan doldurulur: bu ayın kullanımı sıfırdan başlamasın.
      if (!(await dbAll('SELECT 1 FROM traffic_daily LIMIT 1')).length) {
        await dbRun(`INSERT OR IGNORE INTO traffic_daily (day, mac, down, up)
          SELECT date(ts, 'unixepoch', 'localtime'), mac, SUM(down), SUM(up) FROM traffic_usage GROUP BY 1, 2`);
      }
    })().catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}

// İşaret satırı ('#'): durum en az bir kez kaydedildi (boş sayaç kümesi "hiç kayıt yok"tan ayrılır).
const MARKER = '#';
async function loadLast(): Promise<Map<string, Counter> | null> {
  const rows = await dbAll('SELECT k, down, up FROM traffic_counter_last');
  if (!rows.some((r: any) => r.k === MARKER)) return null;
  return new Map(rows.filter((r: any) => r.k !== MARKER).map((r: any) => [String(r.k), { down: Number(r.down), up: Number(r.up) }]));
}
// Açık işlem (BEGIN) kullanılmaz: panelde başka akışlar da işlem açıyor, iç içe BEGIN hata verir. Her parça tek ifadedir
// (çok satırlı INSERT kendi içinde bölünmez); 150 satırlık parçalar SQLite'ın değişken sınırının altında kalır.
async function insertMany(table: string, cols: string[], rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 150) {
    const chunk = rows.slice(i, i + 150);
    const ph = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    await dbRun(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES ${ph}`, chunk.flat());
  }
}
async function saveLast(cur: Map<string, Counter>): Promise<void> {
  await dbRun('DELETE FROM traffic_counter_last');
  await insertMany('traffic_counter_last', ['k', 'down', 'up'], [[MARKER, 0, 0], ...[...cur].map(([k, c]) => [k, c.down, c.up])]);
}

// IP → MAC: komşu tablosu, yoksa cihaz listesindeki son IP.
async function macResolver(): Promise<(ip: string) => string | undefined> {
  const neighbors = await readNeighbors();
  const known = new Map<string, string>();
  for (const d of await dbAll('SELECT mac_address, ip_address FROM devices WHERE ip_address IS NOT NULL')) {
    known.set(String((d as any).ip_address), String((d as any).mac_address).toLowerCase());
  }
  return ip => neighbors.get(ip)?.mac || known.get(ip);
}

// Kayıt ile kota okuması (periodUsage) sıralı: kayıt satırlarını yazıp son sayaçları kaydetmeden araya giren okuma aynı
// trafiği iki kez saymasın.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export function recordInterval(now = Date.now()): Promise<number> {
  return serial(() => recordIntervalNow(now));
}
async function recordIntervalNow(now: number): Promise<number> {
  await ensureTables();
  const { markCounters } = await sampleBandwidth();
  const prev = await loadLast();
  const deltas = counterDeltas(prev, markCounters);
  const ts = Math.floor(now / 1000 / INTERVAL_S) * INTERVAL_S - INTERVAL_S; // biten aralığın başı
  let rows: UsageRow[] = [];
  if (deltas.size) {
    rows = toUsageRows(ts, deltas, await macResolver());
    await insertMany('traffic_usage', ['ts', 'mac', 'route', 'down', 'up'], rows.map(r => [r.ts, r.mac, r.route, r.down, r.up]));
    const daily = new Map<string, Counter>();
    for (const r of rows) {
      const c = daily.get(r.mac) || { down: 0, up: 0 };
      c.down += r.down; c.up += r.up;
      daily.set(r.mac, c);
    }
    for (const [mac, c] of daily) {
      await dbRun(`INSERT INTO traffic_daily (day, mac, down, up) VALUES (date(?, 'unixepoch', 'localtime'), ?, ?, ?)
        ON CONFLICT(day, mac) DO UPDATE SET down = down + excluded.down, up = up + excluded.up`, [ts, mac, c.down, c.up]);
    }
  }
  await saveLast(markCounters);
  await dbRun('DELETE FROM traffic_usage WHERE ts < ?', [Math.floor(now / 1000) - KEEP_S]);
  await dbRun(`DELETE FROM traffic_daily WHERE day < date('now', 'localtime', '-${DAILY_KEEP_DAYS} days')`);
  return rows.length;
}

// Kota (qos.ts): cihaz (MAC) başına bugünkü ve aylık dönemdeki kullanım, indirme + yükleme bayt. today / monthStart
// 'YYYY-MM-DD' (yerel gün). Kayıtlı günlük toplamlar + henüz kaydedilmemiş sayaç farkı (en çok son 5 dk; bugüne sayılır).
// Sayaçlar okunamazsa (nft yok) yalnız kayıtlı toplamlar.
export function periodUsage(today: string, monthStart: string): Promise<Map<string, { day: number; month: number }>> {
  return serial(async () => {
    await ensureTables();
    const out = new Map<string, { day: number; month: number }>();
    const add = (mac: string, day: number, month: number) => {
      const c = out.get(mac) || { day: 0, month: 0 };
      c.day += day; c.month += month;
      out.set(mac, c);
    };
    const rows = await dbAll(`SELECT mac, SUM(CASE WHEN day = ? THEN down + up ELSE 0 END) AS d, SUM(down + up) AS m
      FROM traffic_daily WHERE day >= ? GROUP BY mac`, [today, monthStart]);
    for (const r of rows as any[]) add(String(r.mac), Number(r.d) || 0, Number(r.m) || 0);
    const prev = await loadLast();
    if (prev) {
      try {
        const { markCounters } = await sampleBandwidth();
        const deltas = counterDeltas(prev, markCounters);
        if (deltas.size) for (const r of toUsageRows(0, deltas, await macResolver())) add(r.mac, r.down + r.up, r.down + r.up);
      } catch { /* sayaçlar okunamadı: kayıtlı toplamlar */ }
    }
    return out;
  });
}

// 5 dakikalık saat sınırlarına hizalı kayıt (ilk kayıt açılıştan en az 1 dk sonra).
export function startTrafficRecorder(): void {
  const schedule = () => {
    const now = Date.now();
    const next = (Math.floor(now / 1000 / INTERVAL_S) + 1) * INTERVAL_S * 1000 + 5000;
    setTimeout(async () => {
      try { await recordInterval(); } catch (e: any) { console.warn(`[traffic] kayıt başarısız: ${String(e?.message || e)}`); }
      schedule();
    }, Math.max(60000, next - now));
  };
  schedule();
}

// ─── Okuma ───

export type AnalyticsRange = '24h' | '7d';
export async function usageSummary(range: AnalyticsRange, nowS = Math.floor(Date.now() / 1000)) {
  await ensureTables();
  const since = nowS - (range === '24h' ? 86400 : 7 * 86400);
  const hours = await dbAll(
    `SELECT (ts / 3600) * 3600 AS h, route, SUM(down) AS down, SUM(up) AS up FROM traffic_usage WHERE ts >= ? GROUP BY h, route ORDER BY h`,
    [since]);
  const byDevice = await dbAll(
    `SELECT mac, route, SUM(down) AS down, SUM(up) AS up FROM traffic_usage WHERE ts >= ? GROUP BY mac, route`, [since]);
  const first = await dbAll('SELECT MIN(ts) AS t FROM traffic_usage');
  return {
    since,
    firstSampleAt: first[0]?.t ?? null,
    hours: hours.map((r: any) => ({ h: Number(r.h), route: String(r.route), down: Number(r.down), up: Number(r.up) })),
    devices: byDevice.map((r: any) => ({ mac: String(r.mac), route: String(r.route), down: Number(r.down), up: Number(r.up) })),
  };
}

// Uygulama kullanımı: Pi-hole'un yanıtladığı sorgular (engellenenler hariç), Routing'deki uygulama tanımlarının alan
// adlarıyla eşleştirilir. BAYT DEĞİL, sorgu sayısıdır (uygulamanın ne sıklıkla kullanıldığı). FTL v6'da `queries` bir
// görünümdür ve satır başına alt sorgu çalıştırır (Pi'de yavaş) → tamsayı kimlikli query_storage üzerinden gruplanır.
const ANSWERED = '2,3,12,13,14,17';
const QTYPES = '1,2,15,16';
export type AppDef = { name: string; category: string; bases: string[] };

export function appDefsFrom(rows: { app_name: string; category: string; domains: string | null }[]): AppDef[] {
  return rows.map(r => ({
    name: r.app_name, category: r.category,
    bases: String(r.domains || '').split(',').map(s => s.trim().toLowerCase().replace(/^\*\./, '')).filter(s => s && !s.startsWith('@') && /^[a-z0-9.-]+$/.test(s)),
  })).filter(a => a.bases.length);
}
export function appOf(domain: string, defs: AppDef[]): AppDef | undefined {
  const d = domain.toLowerCase();
  let best: AppDef | undefined, bestLen = 0;
  for (const a of defs) for (const b of a.bases) {
    if ((d === b || d.endsWith(`.${b}`)) && b.length > bestLen) { best = a; bestLen = b.length; }
  }
  return best;
}

let appCache: { key: string; at: number; value: any } | null = null;
export async function appActivity(range: AnalyticsRange, defs: AppDef[], macOf: (ip: string) => string | undefined, nowS = Math.floor(Date.now() / 1000)) {
  const key = `${range}|${defs.map(d => d.name).join(',')}`;
  if (appCache && appCache.key === key && Date.now() - appCache.at < 60000) return appCache.value;
  const since = nowS - (range === '24h' ? 86400 : 7 * 86400);
  if (!fs.existsSync(FTL_DB)) return { available: false, apps: [], matchedQueries: 0, totalQueries: 0 };
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const d = new sqlite3.Database(FTL_DB, sqlite3.OPEN_READONLY, e => (e ? reject(e) : resolve(d)));
  });
  db.configure('busyTimeout', 3000);
  const deadline = Date.now() + 15000;
  const timer = setInterval(() => { if (Date.now() >= deadline) db.interrupt(); }, 200);
  const all = (sql: string, p: unknown[]) => new Promise<any[]>((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
  try {
    let rows: any[];
    try {
      rows = await all(
        `SELECT c.ip AS client, d.domain AS domain, g.n AS n FROM (
           SELECT client, domain, COUNT(*) AS n FROM query_storage
           WHERE timestamp >= ? AND type IN (${QTYPES}) AND status IN (${ANSWERED}) GROUP BY client, domain
         ) g JOIN domain_by_id d ON d.id = g.domain JOIN client_by_id c ON c.id = g.client`, [since]);
    } catch {
      rows = await all(`SELECT client, domain, COUNT(*) AS n FROM queries WHERE timestamp >= ? AND type IN (${QTYPES}) AND status IN (${ANSWERED}) GROUP BY client, domain`, [since]);
    }
    const apps = new Map<string, { name: string; category: string; queries: number; devices: Map<string, number> }>();
    let total = 0, matched = 0;
    for (const r of rows) {
      const n = Number(r.n) || 0;
      total += n;
      const a = appOf(String(r.domain || ''), defs);
      if (!a) continue;
      matched += n;
      const e = apps.get(a.name) || { name: a.name, category: a.category, queries: 0, devices: new Map() };
      e.queries += n;
      const dev = macOf(String(r.client)) || `ip:${r.client}`;
      e.devices.set(dev, (e.devices.get(dev) || 0) + n);
      apps.set(a.name, e);
    }
    const value = {
      available: true, totalQueries: total, matchedQueries: matched,
      apps: [...apps.values()].sort((x, y) => y.queries - x.queries).map(a => ({
        name: a.name, category: a.category, queries: a.queries,
        devices: [...a.devices.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([mac, queries]) => ({ mac, queries })),
      })),
    };
    appCache = { key, at: Date.now(), value };
    return value;
  } finally {
    clearInterval(timer);
    db.close(() => {});
  }
}

import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun } from './db';
import { readNeighbors } from './topology';
import { periodUsage } from './trafficHistory';
import { recordEvent, recordEventOnce } from './events';
import { isLinux } from './system';

// Cihaz hız sınırı ve kullanım kotası (Bant Genişliği → Kota ve Hız). Eskiden kota ve hız kuralları yalnız veritabanına
// yazılıyordu, hiçbir cihaz sınırlanmıyordu. Uygulama ayrı bir nftables tablosunda (inet pi5_qos): forward kancası,
// öncelik -350 — sayaç tablosundan (pi5_acct, -300) önce, düşürülen paket kotaya sayılmaz. Yalnız sınırı tanımlı
// cihazların yönlendirilen trafiği etkilenir; Pi'ye giden trafik (panel, DNS, ağ paylaşımı) input'tan geçer, etkilenmez.
//  - Hız: "limit rate over … drop" (tc kuyruğu değil). Yükleme cihazın MAC'iyle (ether saddr — IP değişse de tutar),
//    indirme IP'siyle (Pi'den cihaza giden pakette cihazın MAC'i yoktur); IP'ler komşu tablosu, Pi-hole kiraları ve cihaz
//    listesinden, dakikada bir tazelenir. Gerçek çekirdekte 20 ms gecikmeyle ölçüldü: oran ×0,95 ve burst 0,1 sn (en az
//    16 kB) ile TCP 1 / 10 / 100 Mbps'de sınırı tutturuyor (düzeltmesiz %5 üstüne çıkıyordu).
//  - Kota: indirme + yükleme, Pi üzerinden geçen trafik (trafficHistory günlük toplamları + henüz yazılmamış sayaç farkı).
//    Günlük dönem gece yarısı, aylık dönem ayın 1'inde yenilenir. Kota dolunca cihaz başına seçilen: internet kesilir ya
//    da hız düşürülür. %80 ve %100'de zile bir kez uyarı; "sıfırla" o dönemin sayacını o andan başlatır (quota_state.base).
//  - Yalnız IPv4 (Pi IPv6 yönlendirmiyor); MAC'i bilinmeyen cihaz (Ev VPN istemcisi) sınırlanamaz.

const execFileP = promisify(execFile);
const TABLE = 'pi5_qos';
const RULES_FILE = '/run/pi5-qos.nft';
const TICK_MS = 60000;
const MB = 1048576;
const MIN_KBPS = 64;
const MAX_KBPS = 10_000_000;
const MAX_MB = 100_000_000;

export type OverAction = 'block' | 'throttle';
export type QuotaPeriod = 'daily' | 'monthly';
export interface DeviceLimit {
  device_mac: string; daily_limit_mb: number; monthly_limit_mb: number;
  max_down_kbps: number; max_up_kbps: number; over_action: OverAction; over_kbps: number; enabled: number;
}
export type LimitStatus = DeviceLimit & {
  hostname: string; ips: string[];
  used_day: number; used_month: number; // bayt, dönem başından (ya da sıfırlamadan) beri
  over: '' | QuotaPeriod;
  applied: boolean; // son uygulamada kurala girdi
  protected: boolean; // modem / Pi: kural yazılmaz (tüm evin trafiği bu MAC'ten gelir)
  ip_missing: boolean; // indirme yönü (ya da kota dolunca kesme) IP ister, IP henüz bilinmiyor
};

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
export const normMac = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const isMac = (s: string) => MAC_RE.test(s) && s !== '00:00:00:00:00:00' && s !== 'ff:ff:ff:ff:ff:ff';
const octet = (s: string) => /^(0|[1-9]\d{0,2})$/.test(s) && Number(s) <= 255;
export const isIpv4 = (s: string) => { const p = s.split('.'); return p.length === 4 && p.every(octet); };
const isPrivate = (ip: string) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

// Kullanıcı girdisi → doğrulanmış sınır ya da Türkçe hata. Hız kbps (0 = sınırsız), kota MB (0 = yok).
export function validateLimit(mac: string, input: any): { limit: DeviceLimit } | { error: string } {
  const m = normMac(mac);
  if (!isMac(m)) return { error: 'Geçerli bir cihaz MAC adresi gerekli' };
  const num = (v: any) => (v === undefined || v === null || v === '' ? 0 : Number(v));
  const down = num(input?.max_down_kbps), up = num(input?.max_up_kbps);
  const daily = num(input?.daily_limit_mb), monthly = num(input?.monthly_limit_mb);
  for (const [v, name] of [[down, 'İndirme hızı'], [up, 'Yükleme hızı']] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_KBPS || (v > 0 && v < MIN_KBPS)) return { error: `${name} boş (sınırsız) ya da 0,064–10000 Mbps olmalı` };
  }
  for (const [v, name] of [[daily, 'Günlük kota'], [monthly, 'Aylık kota']] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_MB) return { error: `${name} boş (yok) ya da pozitif bir değer olmalı` };
  }
  if (!down && !up && !daily && !monthly) return { error: 'En az bir hız sınırı ya da kota girin' };
  const rawAction = input?.over_action ?? 'block';
  if (rawAction !== 'block' && rawAction !== 'throttle') return { error: 'Kota dolunca: interneti kes ya da yavaşlat' };
  const over = num(input?.over_kbps ?? 1000);
  const overOk = Number.isInteger(over) && over >= MIN_KBPS && over <= MAX_KBPS;
  if (rawAction === 'throttle' && !overOk) return { error: 'Kota dolunca hız 0,064–10000 Mbps olmalı' };
  return {
    limit: {
      device_mac: m, daily_limit_mb: daily, monthly_limit_mb: monthly, max_down_kbps: down, max_up_kbps: up,
      over_action: rawAction, over_kbps: overOk ? over : 1000, enabled: input?.enabled === undefined || input.enabled ? 1 : 0,
    },
  };
}

// DB satırı (eski sürümün satırı dahil: yeni sütunlar boş) → sınır.
function rowToLimit(r: any): DeviceLimit {
  const n = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : d);
  return {
    device_mac: normMac(r.device_mac), daily_limit_mb: n(r.daily_limit_mb), monthly_limit_mb: n(r.monthly_limit_mb),
    max_down_kbps: n(r.max_down_kbps), max_up_kbps: n(r.max_up_kbps), over_action: r.over_action === 'throttle' ? 'throttle' : 'block',
    over_kbps: n(r.over_kbps, 1000) || 1000, enabled: Number(r.enabled) ? 1 : 0,
  };
}

// Sınır konamayacak MAC'ler (index.ts blockProtectedMacs: Pi'nin kartları, modem / üst router, ağ geçidi IP'li cihaz
// satırları). Modeme konan hız sınırı ya da "kes" tüm evin internetini etkilerdi: internetten gelen her paket Pi'ye
// modemin MAC'iyle girer.
let protectedProvider: () => Promise<Set<string>> = async () => new Set();
async function protectedSet(): Promise<Set<string>> {
  try { return new Set([...await protectedProvider()].map(normMac)); } catch (e: any) {
    console.warn(`[qos] korunan MAC listesi okunamadı: ${e?.message || e}`);
    return new Set();
  }
}
export const isProtectedMac = async (mac: string) => (await protectedSet()).has(normMac(mac));

// ─── Kurallar ───

export type QosDevice = { mac: string; ips: string[]; block: boolean; downKbps: number; upKbps: number };
const rateOf = (kbps: number) => Math.max(1, Math.round((kbps * 1000) / 8 * 0.95)); // bayt/sn
const burstOf = (bps: number) => Math.max(16000, Math.round(bps / 10));

// Cihazlar → nft tablosu metni; uygulanacak kural yoksa null (tablo kaldırılır).
export function buildQosRules(devs: QosDevice[]): string | null {
  const lines: string[] = [];
  let rules = 0;
  for (const d of devs) {
    if (!isMac(d.mac)) continue;
    const ips = [...new Set(d.ips.filter(ip => isIpv4(ip) && isPrivate(ip)))].sort();
    const dst = ips.length ? `ip daddr { ${ips.join(', ')} }` : '';
    const own: string[] = [];
    if (d.block) {
      own.push(`ether saddr ${d.mac} drop`);
      if (dst) own.push(`${dst} drop`);
    } else {
      if (d.upKbps > 0) {
        const r = rateOf(d.upKbps);
        own.push(`ether saddr ${d.mac} limit rate over ${r} bytes/second burst ${burstOf(r)} bytes drop`);
      }
      if (d.downKbps > 0 && dst) {
        const r = rateOf(d.downKbps);
        own.push(`${dst} limit rate over ${r} bytes/second burst ${burstOf(r)} bytes drop`);
      }
    }
    if (!own.length) continue;
    rules += own.length;
    lines.push(`\t\t# ${d.mac}`, ...own.map(l => `\t\t${l}`));
  }
  if (!rules) return null;
  return `table inet ${TABLE} {\n\tchain qos_fwd {\n\t\ttype filter hook forward priority -350; policy accept;\n${lines.join('\n')}\n\t}\n}\n`;
}

// MAC → IPv4'ler: komşu tablosu (en güncel), Pi-hole kiraları, cihaz listesi. Bir IP'yi önce gören kaynak sahiplenir.
async function ipsByMac(macs: Set<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  const claimed = new Set<string>();
  const put = (mac: string, ip: string) => {
    if (claimed.has(ip) || !isIpv4(ip) || !isPrivate(ip)) return;
    claimed.add(ip);
    if (!macs.has(mac)) return;
    const s = out.get(mac) || new Set<string>();
    s.add(ip);
    out.set(mac, s);
  };
  for (const [ip, n] of await readNeighbors()) if (!['FAILED', 'INCOMPLETE'].includes(n.state)) put(n.mac, ip);
  try {
    for (const line of fs.readFileSync('/etc/pihole/dhcp.leases', 'utf8').split('\n')) {
      const p = line.trim().split(/\s+/);
      if (/^\d+$/.test(p[0] || '') && p[1] && p[2]) put(normMac(p[1]), p[2]);
    }
  } catch { /* Pi DHCP kapalı */ }
  for (const d of await dbAll('SELECT mac_address, ip_address FROM devices WHERE ip_address IS NOT NULL') as any[]) {
    put(normMac(d.mac_address), String(d.ip_address));
  }
  return new Map([...out].map(([m, s]) => [m, [...s].sort()]));
}

// ─── Durum ───

const pad = (n: number) => String(n).padStart(2, '0');
export function periodKeys(d = new Date()): { day: string; month: string; monthStart: string } {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { day, month: day.slice(0, 7), monthStart: `${day.slice(0, 7)}-01` };
}

type StateRow = { pkey: string; base: number; notified: number };
let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = dbRun(`CREATE TABLE IF NOT EXISTS quota_state (
      mac TEXT NOT NULL, period TEXT NOT NULL, pkey TEXT NOT NULL, base INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (mac, period)
    )`).then(() => undefined).catch(e => { tablesReady = null; throw e; });
  }
  return tablesReady;
}
async function loadStates(): Promise<Map<string, StateRow>> {
  const m = new Map<string, StateRow>();
  for (const r of await dbAll('SELECT mac, period, pkey, base, notified FROM quota_state') as any[]) {
    m.set(`${r.mac}|${r.period}`, { pkey: String(r.pkey), base: Number(r.base) || 0, notified: Number(r.notified) || 0 });
  }
  return m;
}
const saveState = (mac: string, period: QuotaPeriod, s: StateRow) =>
  dbRun('INSERT OR REPLACE INTO quota_state (mac, period, pkey, base, notified) VALUES (?, ?, ?, ?, ?)', [mac, period, s.pkey, s.base, s.notified]);

// Kural girdisinin hız değeri: kota dolup "yavaşlat" seçiliyse düşük olan.
const effKbps = (limit: number, overKbps: number) => (overKbps ? (limit ? Math.min(limit, overKbps) : overKbps) : limit);

type Evaluation = { rows: LimitStatus[]; devs: QosDevice[]; states: Map<string, StateRow>; keys: ReturnType<typeof periodKeys>; raw: Map<string, { day: number; month: number }> };

// Sınırlar + kullanım + dönem durumu → satırlar ve kural girdileri. Yan etkisi yok (durum yazılmaz).
async function evaluate(): Promise<Evaluation> {
  await ensureTables();
  const keys = periodKeys();
  const limits = (await dbAll('SELECT * FROM bandwidth_limits') as any[]).map(rowToLimit).filter(l => isMac(l.device_mac))
    .sort((a, b) => a.device_mac.localeCompare(b.device_mac));
  const states = await loadStates();
  const caps = calendarCapsNow();   // takvim kaplaması (G5.3): boşsa her şey eskisi gibi
  if (!limits.length && !caps.size) return { rows: [], devs: [], states, keys, raw: new Map() };
  const raw = await periodUsage(keys.day, keys.monthStart).catch(() => new Map<string, { day: number; month: number }>());
  const ips = await ipsByMac(new Set([...limits.filter(l => l.enabled).map(l => l.device_mac), ...caps.keys()]));
  const prot = await protectedSet();
  const names = new Map<string, string>();
  for (const d of await dbAll('SELECT mac_address, hostname FROM devices') as any[]) names.set(normMac(d.mac_address), String(d.hostname || ''));
  const rows: LimitStatus[] = [];
  const devs: QosDevice[] = [];
  for (const l of limits) {
    const u = raw.get(l.device_mac) || { day: 0, month: 0 };
    const sd = states.get(`${l.device_mac}|daily`), sm = states.get(`${l.device_mac}|monthly`);
    const usedDay = Math.max(0, u.day - (sd && sd.pkey === keys.day ? sd.base : 0));
    const usedMonth = Math.max(0, u.month - (sm && sm.pkey === keys.month ? sm.base : 0));
    const overM = l.monthly_limit_mb > 0 && usedMonth >= l.monthly_limit_mb * MB;
    const overD = l.daily_limit_mb > 0 && usedDay >= l.daily_limit_mb * MB;
    const over: LimitStatus['over'] = overM ? 'monthly' : overD ? 'daily' : '';
    const devIps = ips.get(l.device_mac) || [];
    const isProt = prot.has(l.device_mac);
    const slow = over && l.over_action === 'throttle' ? l.over_kbps : 0;
    const needsIp = !!over || effKbps(l.max_down_kbps, slow) > 0;
    rows.push({
      ...l, hostname: names.get(l.device_mac) || '', ips: devIps, used_day: usedDay, used_month: usedMonth, over, applied: false,
      protected: isProt, ip_missing: !!l.enabled && !isProt && needsIp && !devIps.length,
    });
    if (!l.enabled || isProt) continue;
    devs.push({
      mac: l.device_mac, ips: devIps, block: !!over && l.over_action === 'block',
      downKbps: effKbps(l.max_down_kbps, slow), upKbps: effKbps(l.max_up_kbps, slow),
    });
  }
  mergeCalendarCaps(devs, caps, ips, prot);
  return { rows, devs, states, keys, raw };
}

export const fmtGb = (bytes: number) => {
  const gb = bytes / (1024 * MB);
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1).replace(/\.0$/, '').replace('.', ',')} GB` : `${Math.round(bytes / MB)} MB`;
};
export const fmtMbps = (kbps: number) => {
  const m = kbps / 1000;
  return `${Number.isInteger(m) ? m : m.toFixed(m < 1 ? 3 : 1).replace(/\.?0+$/, '').replace('.', ',')} Mbps`;
};
const PERIOD_TEXT: Record<QuotaPeriod, { name: string; until: string }> = {
  daily: { name: 'günlük', until: 'gece yarısına kadar' },
  monthly: { name: 'aylık', until: "ayın 1'ine kadar" },
};

// Dönem geçişi (yeni gün / ay: sayaç ve uyarılar sıfırlanır) ve %80 / %100 uyarıları. Durum satırı yalnız değişince yazılır.
async function updateStates(ev: Evaluation): Promise<void> {
  for (const r of ev.rows) {
    const name = r.hostname || r.device_mac;
    for (const period of ['daily', 'monthly'] as QuotaPeriod[]) {
      const limitMb = period === 'daily' ? r.daily_limit_mb : r.monthly_limit_mb;
      const pkey = period === 'daily' ? ev.keys.day : ev.keys.month;
      const st = ev.states.get(`${r.device_mac}|${period}`);
      const rolled = !!st && st.pkey !== pkey;
      const next: StateRow = { pkey, base: st && !rolled ? st.base : 0, notified: st && !rolled ? st.notified : 0 };
      if (rolled && (st!.notified & 2) && r.enabled && !r.over) {
        await recordEvent('bandwidth', `${name}: ${PERIOD_TEXT[period].name} kota yenilendi, sınır kalktı`);
      }
      if (r.enabled && limitMb > 0) {
        const used = period === 'daily' ? r.used_day : r.used_month;
        const lim = limitMb * MB;
        const t = PERIOD_TEXT[period];
        if (used >= lim && !(next.notified & 2)) {
          const what = r.over_action === 'throttle'
            ? `hızı ${t.until} ${fmtMbps(effKbps(r.max_down_kbps, r.over_kbps))}'e düşürüldü`
            : `interneti ${t.until} kesildi`;
          await recordEvent('bandwidth', `${name} ${t.name} kotasını doldurdu (${fmtGb(lim)}) — ${what}`, 'warning');
          next.notified |= 3;
        } else if (used >= lim * 0.8 && !(next.notified & 1)) {
          await recordEvent('bandwidth', `${name} ${t.name} kotasının %80'ini kullandı (${fmtGb(used)} / ${fmtGb(lim)})`, 'warning');
          next.notified |= 1;
        }
      }
      if (!st || rolled || next.notified !== st.notified) await saveState(r.device_mac, period, next);
    }
  }
}

// ─── Uygulama ───

let applied: string | null = null; // son yüklenen kural metni (null: tablo yok)
let appliedMacs = new Set<string>();
let lastError = '';

async function tableExists(): Promise<boolean> {
  try { await execFileP('nft', ['list', 'table', 'inet', TABLE], { timeout: 5000 }); return true; } catch { return false; }
}
const nftErr = (e: any) => String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).slice(-3).join(' ') || 'nft hatası';

// Kural metni değiştiyse ya da tablo dışarıdan silindiyse (nftables yeniden yüklendi) yeniden yükler: önce sınar (nft -c).
async function applyText(text: string | null, force: boolean): Promise<void> {
  if (!isLinux) return;
  const exists = await tableExists();
  if (!force && text === applied && exists === (text !== null)) return;
  if (text === null && !exists) { applied = null; return; }
  fs.writeFileSync(RULES_FILE, `table inet ${TABLE} {}\ndelete table inet ${TABLE}\n${text || ''}`);
  try {
    await execFileP('nft', ['-c', '-f', RULES_FILE], { timeout: 10000 });
    await execFileP('nft', ['-f', RULES_FILE], { timeout: 10000 });
  } catch (e) {
    throw new Error(nftErr(e));
  }
  applied = text;
}

// Sınırlar ve kota değişiklikleri sırayla (kaydet → uygula → gerekirse geri al adımları iç içe geçmesin).
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

async function runNow(opts: { notify?: boolean; force?: boolean } = {}): Promise<LimitStatus[]> {
  const ev = await evaluate();
  if (opts.notify !== false) await updateStates(ev);
  const text = buildQosRules(ev.devs);
  try {
    await applyText(text, !!opts.force);
    lastError = '';
  } catch (e: any) {
    lastError = e.message;
    throw e;
  }
  appliedMacs = new Set(text ? ev.devs.filter(d => text.includes(`# ${d.mac}\n`)).map(d => d.mac) : []);
  return ev.rows.map(r => ({ ...r, applied: appliedMacs.has(r.device_mac) }));
}
export const runQos = (opts: { notify?: boolean; force?: boolean } = {}) => serial(() => runNow(opts));

// Sayfa: sınırlar, kullanım, durum (uygulamadan). forwarding: Pi yönlendirme yapıyor mu (yapmıyorsa sınırlar etkisiz).
export async function qosStatus(): Promise<{ limits: LimitStatus[]; forwarding: boolean; error: string; protected_macs: string[] }> {
  const ev = await evaluate();
  let forwarding = true;
  if (isLinux) {
    try { forwarding = fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim() === '1'; } catch { /* bilinmiyor */ }
  }
  return { limits: ev.rows.map(r => ({ ...r, applied: appliedMacs.has(r.device_mac) })), forwarding, error: lastError, protected_macs: [...await protectedSet()] };
}

const deviceName = async (mac: string) => {
  const d = await dbGet('SELECT hostname FROM devices WHERE lower(mac_address) = ?', [mac]) as any;
  return String(d?.hostname || '') || mac;
};
export function describeLimit(l: DeviceLimit): string {
  const parts: string[] = [];
  if (l.max_down_kbps || l.max_up_kbps) {
    parts.push(`hız ↓${l.max_down_kbps ? fmtMbps(l.max_down_kbps) : 'sınırsız'} ↑${l.max_up_kbps ? fmtMbps(l.max_up_kbps) : 'sınırsız'}`);
  }
  const q = [l.daily_limit_mb ? `günlük ${fmtGb(l.daily_limit_mb * MB)}` : '', l.monthly_limit_mb ? `aylık ${fmtGb(l.monthly_limit_mb * MB)}` : ''].filter(Boolean);
  if (q.length) parts.push(`kota ${q.join(', ')} (dolunca ${l.over_action === 'throttle' ? `${fmtMbps(l.over_kbps)}'e yavaşlat` : 'interneti kes'})`);
  return parts.join('; ');
}

const upsert = (l: DeviceLimit) => dbRun(
  `INSERT INTO bandwidth_limits (device_mac, daily_limit_mb, monthly_limit_mb, max_down_kbps, max_up_kbps, over_action, over_kbps, enabled)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(device_mac) DO UPDATE SET daily_limit_mb = excluded.daily_limit_mb, monthly_limit_mb = excluded.monthly_limit_mb,
     max_down_kbps = excluded.max_down_kbps, max_up_kbps = excluded.max_up_kbps, over_action = excluded.over_action,
     over_kbps = excluded.over_kbps, enabled = excluded.enabled`,
  [l.device_mac, l.daily_limit_mb, l.monthly_limit_mb, l.max_down_kbps, l.max_up_kbps, l.over_action, l.over_kbps, l.enabled]);

// Kaydet ve uygula; uygulanamazsa önceki hali geri yazılır.
export function saveLimit(l: DeviceLimit): Promise<void> {
  return serial(async () => {
    const prev = await dbGet('SELECT * FROM bandwidth_limits WHERE device_mac = ?', [l.device_mac]);
    await upsert(l);
    // Kota değiştiyse o dönemin %80 / %100 uyarıları yeniden verilir (ör. kota artırılıp yeniden dolunca).
    await ensureTables();
    const old = prev ? rowToLimit(prev) : null;
    if (old && old.daily_limit_mb !== l.daily_limit_mb) await dbRun("UPDATE quota_state SET notified = 0 WHERE mac = ? AND period = 'daily'", [l.device_mac]);
    if (old && old.monthly_limit_mb !== l.monthly_limit_mb) await dbRun("UPDATE quota_state SET notified = 0 WHERE mac = ? AND period = 'monthly'", [l.device_mac]);
    try {
      await runNow();
    } catch (e: any) {
      if (prev) await upsert(rowToLimit(prev)); else await dbRun('DELETE FROM bandwidth_limits WHERE device_mac = ?', [l.device_mac]);
      await runNow({ notify: false }).catch(() => {});
      throw new Error(`Sınır uygulanamadı, kaydedilmedi: ${e.message}`);
    }
    const name = await deviceName(l.device_mac);
    await recordEvent('bandwidth', `${name}: cihaz sınırı ${prev ? 'güncellendi' : 'eklendi'}${l.enabled ? '' : ' (kapalı)'} — ${describeLimit(l)}`);
  });
}

export function deleteLimit(mac: string): Promise<boolean> {
  return serial(async () => {
    const prev = await dbGet('SELECT * FROM bandwidth_limits WHERE device_mac = ?', [mac]);
    if (!prev) return false;
    await dbRun('DELETE FROM bandwidth_limits WHERE device_mac = ?', [mac]);
    try {
      await runNow({ notify: false });
    } catch (e: any) {
      await upsert(rowToLimit(prev));
      await runNow({ notify: false }).catch(() => {});
      throw new Error(`Sınır kaldırılamadı: ${e.message}`);
    }
    await ensureTables();
    await dbRun('DELETE FROM quota_state WHERE mac = ?', [mac]);
    await recordEvent('bandwidth', `${await deviceName(mac)}: cihaz sınırı kaldırıldı`);
    return true;
  });
}

// "Sıfırla": dönemin sayacı bu andan başlar (kota dolmuşsa sınır hemen kalkar); uyarılar da yeniden verilir.
export function resetQuota(mac: string, period: QuotaPeriod): Promise<boolean> {
  return serial(async () => {
    if (!await dbGet('SELECT 1 FROM bandwidth_limits WHERE device_mac = ?', [mac])) return false;
    await ensureTables();
    const keys = periodKeys();
    const u = (await periodUsage(keys.day, keys.monthStart)).get(mac) || { day: 0, month: 0 };
    const prev = (await loadStates()).get(`${mac}|${period}`);
    await saveState(mac, period, { pkey: period === 'daily' ? keys.day : keys.month, base: period === 'daily' ? u.day : u.month, notified: 0 });
    try {
      await runNow();
    } catch (e: any) {
      if (prev) await saveState(mac, period, prev); else await dbRun('DELETE FROM quota_state WHERE mac = ? AND period = ?', [mac, period]);
      await runNow({ notify: false }).catch(() => {});
      throw new Error(`Sayaç sıfırlanamadı: ${e.message}`);
    }
    await recordEvent('bandwidth', `${await deviceName(mac)}: ${PERIOD_TEXT[period].name} kota panelden sıfırlandı`);
    return true;
  });
}

// ─── Eski Hız Limitleme (Trafik Kontrol) kuralları ───

const clampKbps = (v: any) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_KBPS, Math.max(MIN_KBPS, n));
};
const TARGET_LABEL: Record<string, string> = { device: 'cihaz', app: 'uygulama', group: 'grup' };

// throttle_rules (yalnız veritabanındaydı, hiç uygulanmıyordu) → cihaz sınırları. Cihaz kuralı MAC, ad ya da IP ile
// eşleşirse taşınır; uygulama ve grup kuralları uygulanamadığı için kaldırılır, olayda listelenir. Açılışta ve yedekten
// geri yüklemeden sonra (eski yedekte kural olabilir); tablo boşsa hiçbir şey yapmaz.
export async function migrateThrottleRules(): Promise<number> {
  let rules: any[];
  try { rules = await dbAll('SELECT * FROM throttle_rules ORDER BY id') as any[]; } catch { return 0; }
  if (!rules.length) return 0;
  const devices = await dbAll('SELECT mac_address, ip_address, hostname FROM devices') as any[];
  const moved: string[] = [];
  const dropped: string[] = [];
  for (const r of rules) {
    const target = String(r.target_value ?? '').trim();
    const label = `${TARGET_LABEL[r.target_type] || 'kural'} "${target}"`;
    let mac = '';
    if (r.target_type === 'device') {
      const t = normMac(target).replace(/-/g, ':');
      if (isMac(t)) mac = t;
      else {
        const d = devices.find(x => String(x.hostname || '').toLowerCase() === target.toLowerCase() || String(x.ip_address || '') === target);
        if (d) mac = normMac(d.mac_address);
      }
    }
    const down = clampKbps(r.max_download_kbps), up = clampKbps(r.max_upload_kbps);
    if (!isMac(mac) || (!down && !up)) { dropped.push(label); continue; }
    const cur = await dbGet('SELECT * FROM bandwidth_limits WHERE device_mac = ?', [mac]) as any;
    if (!cur) {
      await upsert({ device_mac: mac, daily_limit_mb: 0, monthly_limit_mb: 0, max_down_kbps: down, max_up_kbps: up, over_action: 'block', over_kbps: 1000, enabled: Number(r.enabled) ? 1 : 0 });
    } else if (!Number(r.enabled)) {
      dropped.push(`${label} (kapalıydı; cihazın zaten kotası var)`);
      continue;
    } else if (!Number(cur.max_down_kbps) && !Number(cur.max_up_kbps)) {
      await dbRun('UPDATE bandwidth_limits SET max_down_kbps = ?, max_up_kbps = ? WHERE device_mac = ?', [down, up, mac]);
    } else {
      dropped.push(`${label} (cihazın zaten hız sınırı var)`);
      continue;
    }
    moved.push(target);
  }
  await dbRun('DELETE FROM throttle_rules');
  await recordEvent('bandwidth', `Trafik Kontrol → Hız Limitleme kuralları Bant Genişliği → Kota ve Hız'a taşındı${moved.length ? `: ${moved.length} cihaz (${moved.join(', ')})` : ''}${dropped.length ? `. Uygulanamadığı için kaldırılanlar: ${dropped.join(', ')}` : ''}`,
    dropped.length ? 'warning' : 'info');
  return moved.length;
}

// Büyük harfli MAC satırları (eski sürüm / yedekten geri yükleme) küçültülür; küçük harflisi zaten varsa büyük harfli kopya
// silinir (API her zaman küçük harfle yazar ve arar).
export async function normalizeLimitMacs(): Promise<void> {
  await dbRun(`DELETE FROM bandwidth_limits WHERE device_mac <> lower(device_mac)
    AND lower(device_mac) IN (SELECT device_mac FROM bandwidth_limits WHERE device_mac = lower(device_mac))`);
  await dbRun('UPDATE OR IGNORE bandwidth_limits SET device_mac = lower(device_mac) WHERE device_mac <> lower(device_mac)');
}

// Açılış: eski büyük harfli MAC satırları küçültülür, eski kurallar taşınır, sonra dakikada bir: kullanım, dönem, uyarı ve
// kuralların varlığı (nftables dışarıdan yeniden yüklenirse tablo gider — bir dakika içinde geri gelir).
export function startQos(opts: { protectedMacs?: () => Promise<Set<string>> } = {}): void {
  if (opts.protectedMacs) protectedProvider = opts.protectedMacs;
  const tick = async () => {
    try {
      await runQos();
    } catch (e: any) {
      console.warn(`[qos] uygulanamadı: ${e.message}`);
      await recordEventOnce('bandwidth', `Kota ve hız sınırları uygulanamadı: ${e.message}`, 'warning', 360);
    }
  };
  setTimeout(() => {
    void (async () => {
      try {
        await normalizeLimitMacs();
        await migrateThrottleRules();
      } catch (e: any) {
        console.warn(`[qos] eski kurallar taşınamadı: ${e.message}`);
      }
      await tick();
      setInterval(() => { void tick(); }, TICK_MS);
    })();
  }, 15000);
}

// ─── Takvim kaplaması (G5.3, calendarEngine.ts) ───
// Takvim etkinliği sırasında seçilen cihazlara GEÇİCİ ek hız kısıtı. Yalnız kısıt ekler: hız = en küçüğü (kullanıcı sınırı,
// takvim); kullanıcının sınırını ve kotasını kaldıramaz (kota kesmesi sürer), bandwidth_limits / quota_state'e yazmaz, kota
// sayaçlarına ve dönemlere (updateStates) dokunmaz. Sınırı olmayan hedef cihaz yalnız hız girdisi alır. Korunan MAC'ler
// (modem, Pi) her zaman dışarıda. Kaplama boşken evaluate ve buildQosRules metni eskisiyle bayt bayt aynı.
export type CalendarCap = { downKbps: number; upKbps: number };
let capsProvider: (() => Map<string, CalendarCap>) | null = null;
export function setCalendarCaps(fn: (() => Map<string, CalendarCap>) | null): void { capsProvider = fn; }
function calendarCapsNow(): Map<string, CalendarCap> {
  if (!capsProvider) return new Map();
  try {
    const out = new Map<string, CalendarCap>();
    for (const [mac, c] of capsProvider()) {
      const m = normMac(mac);
      const ok = (v: number) => Number.isInteger(v) && v >= MIN_KBPS && v <= MAX_KBPS;
      if (isMac(m) && (ok(c.downKbps) || ok(c.upKbps))) out.set(m, { downKbps: ok(c.downKbps) ? c.downKbps : 0, upKbps: ok(c.upKbps) ? c.upKbps : 0 });
    }
    return out;
  } catch { return new Map(); }
}
const minKbps = (a: number, b: number) => (a && b ? Math.min(a, b) : a || b);   // 0 = sınırsız
function mergeCalendarCaps(devs: QosDevice[], caps: Map<string, CalendarCap>, ips: Map<string, string[]>, prot: Set<string>): void {
  if (!caps.size) return;
  for (const d of devs) {
    const c = caps.get(d.mac);
    if (c) { d.downKbps = minKbps(d.downKbps, c.downKbps); d.upKbps = minKbps(d.upKbps, c.upKbps); }
  }
  const have = new Set(devs.map(d => d.mac));
  for (const [mac, c] of [...caps].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (have.has(mac) || prot.has(mac)) continue;
    devs.push({ mac, ips: ips.get(mac) || [], block: false, downKbps: c.downKbps, upKbps: c.upKbps });
  }
}

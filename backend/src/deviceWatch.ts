// Yeni cihaz algılayıcısı (G2.1): ağa ilk kez bağlanan cihazı panel açık olmasa da bulur ve olay geçmişine yazar
// (kaynak 'device-new'); dış kanal açıksa gönderici (notify.ts) iletir. Eskiden known_devices yalnız GET /api/devices
// çağrılınca doluyordu: cihaz sayfası açılmazsa yeni cihaz hiç kaydedilmiyordu.
//  - Varsayılan KAPALI: /etc/pi5-gateway/notify/channels.json 'deviceWatch' (yalnız PUT /api/notify/device-watch yazar;
//    app_settings'te değil, yedekten geri gelmez). Kapalıyken zamanlayıcı yok, komşu tablosu okunmaz, veritabanına yazılmaz.
//  - Açılınca önce bağlı cihazlar ve DHCP kirası süren (uyuyan) cihazlar sessizce "bilinen" olur (taban çizgisi — bildirim
//    yağmuru olmaz), sonra 60 sn'de bir getNetworkDevices (system.ts: internet kartı / yedek hat ve Wi-Fi köprüsünün üst ağı
//    ayıklanmış komşu tablosu). Taban çizgisi yalnız başarılı bir turdan sonra işaretlenir (bayrak state.json'da: panel
//    yeniden başlayınca kapalıyken bağlanan cihaz da bildirilir); tarama düşerse sonraki tur yine sessiz taban turudur.
//  - "Bilinen" kümesi known_devices'tan bir kez okunur ve bellekte tutulur: cihaz sayfası (GET /api/devices) yeni cihazı
//    known_devices'a algılayıcıdan önce yazsa da bildirim kaçmaz. Yeni MAC known_devices'a (INSERT OR IGNORE; "Tanıyorum"
//    listesi ve first_seen aynen çalışır) ancak olayı yazılınca girer: bekleme sırasında yeniden başlatmada kaybolmaz.
//  - Yeni MAC 60 sn bekler (DHCP adı gelsin), sonra 'device-new' olayı ('info'): bilgi olayı okunmuş yazılır — zil, OLED ve
//    kiosk sayacı kirlenmez. Bir turda 10'dan fazla yeni cihaz → tek özet olay. Olay yazılamazsa cihaz bekleyende kalır.
//  - Rastgele (gizli Wi-Fi) MAC etiketlenir; ayarda "bildirme" seçilirse olay yazılmaz (cihaz yine bilinen olur). Kurulum
//    Wi-Fi'ı (192.168.50.0/24) istemcisi etiketlenir. Pi'nin kendi kartları ve ağ geçidi (modem) atlanır.
//  - Otomatik engel YOK: yalnız farkındalık. Ev VPN istemcileri (wg_pi, L3) komşu tablosunda görünmez — kapsam dışı.
//  - Uyduda başlatılmaz (index.ts '!isSatellite'); HA'da yalnız MASTER (notifyStore notifyMayRun).
//  - G5.6 Tatil alarm kipi — tek kanca setAlarmProvider (takvim motoru verir). Sağlayıcı yokken ya da null / false dönerken
//    olay (tür, önem, metin, kaynak, birleştirme) yukarıdaki gibi. Alarm etkinken: bekleme yok (gecikme ≤ tarama aralığı +
//    gönderim), olay 'warning' (okunmamış: zil, OLED, kiosk), metin "Tatil kipi: tanınmayan cihaz bağlandı — <ad|MAC>",
//    kaynak 'device-new:alarm' ("sessiz saatleri yok say" seçiliyse 'device-new:alarm-urgent' — notify.ts sessiz saatte
//    yalnız bunu geçirir). Kaynağın başı 'device-new': dış kanal süzgeçleri, etiket ve "git" bağlantısı aynı. Aynı MAC pencere
//    başına bir kez. Rastgele MAC bastırması, taban çizgisi, korunan cihazlar ve Kurulum Wi-Fi'ı etiketi aynen.
import fs from 'fs';
import { dbAll, dbRun } from './db';
import { getNetworkDevices, protectedMacs as baseProtectedMacs, AP_NET } from './system';
import { inCidr } from './topology';
import { isRandomMac } from './linkProbe';
import { isSatellite } from './role';
import { notifyConfig, saveNotifyConfig, notifyState, saveNotifyState, notifyMayRun, type RandomMacMode } from './notifyStore';

const INTERVAL_MS = 60000;
const HOLD_MS = 60000;
// Turun zamanı ad okuması (ip neigh) bitince alınır: art arda iki tur 60 sn'den birkaç ms kısa olabilir. Pay olmadan bekleme
// bir tur daha (120 sn) kayardı — yeni cihaz bağlandıktan sonra en geç iki turda (≤ ~120 sn) yazılır.
const HOLD_SLACK_MS = 5000;
const SUMMARY_AT = 10;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

// G5.6: etkin alarm — label: metin öneki ('Tatil kipi'); until: pencerenin sonu (aynı MAC o ana dek bir kez); ignoreQuiet:
// dış kanalın sessiz saatlerinde de gönder; written: alarm olayı yazılınca çağrılır (takvim motoru göndericiyi uyandırır —
// dış kanal 10 sn'lik turu beklemez).
export type AlarmState = { label: string; until: number; ignoreQuiet: boolean; written?: () => void };
export type AlarmProvider = () => AlarmState | null | false | Promise<AlarmState | null | false>;
export const ALARM_SOURCE = 'device-new:alarm';
export const ALARM_URGENT_SOURCE = 'device-new:alarm-urgent';
let alarmProvider: AlarmProvider | null = null;
export function setAlarmProvider(fn: AlarmProvider | null): void { alarmProvider = fn; }
// Alarmla bildirilen MAC → pencerenin sonu (aç / kapat dönemlerinden bağımsız; pencere bitince düşer).
const alarmed = new Map<string, number>();
type Live = { ip: string; mac: string };
// intervalMs / holdMs / devices / leasesFile yalnız test içindir.
export type DeviceWatchOpts = {
  protectedMacs?: () => Promise<Set<string>>;
  intervalMs?: number; holdMs?: number; devices?: () => Promise<Live[]>; leasesFile?: string;
};
let opts: DeviceWatchOpts = {};
let timer: ReturnType<typeof setInterval> | null = null;
// Kapatılınca artar: kapatma sırasında süren tur sonuç yazmaz.
let gen = 0;
let known: Set<string> | null = null;
const pending = new Map<string, { ip: string; at: number }>();
// known_devices'a yazılamayanlar (veritabanı o an meşgul): bellekte bilinen, sonraki turlarda sessizce yeniden yazılır.
const unsaved = new Set<string>();
// Taban çizgisi henüz alınamadı (tarama hatası, HA kapısı kapalı): sonraki tur da sessiz taban turu olur.
let baselinePending = false;
type Scan = { ok: boolean; n: number; extra?: string[] };
const NO_SCAN: Scan = { ok: false, n: 0 };
let scanning: { gen: number; p: Promise<Scan> } | null = null;
const LEASES = '/etc/pihole/dhcp.leases';

export const deviceWatchRunning = () => timer !== null;
// boş ve çoklu yayın adresi cihaz değildir
const deviceMac = (mac: string) => MAC_RE.test(mac) && mac !== '00:00:00:00:00:00' && !(parseInt(mac.slice(0, 2), 16) & 1);

// DHCP adı (index.ts fillDeviceNames ile aynı kaynaklar, salt okunur): Pi-hole kira dosyası + panelde verilen sabit kayıt adı.
async function leaseNames(file: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const [exp, mac, , host] = line.trim().split(/\s+/);
      if (!/^\d+$/.test(exp || '') || !MAC_RE.test(String(mac || '').toLowerCase()) || !host || host === '*') continue;
      names.set(mac.toLowerCase(), host);
    }
  } catch { /* kira dosyası yok (Pi DHCP kapalı) */ }
  const statics = await dbAll("SELECT mac_address, hostname FROM dhcp_leases WHERE is_static = 1 AND COALESCE(hostname, '') <> ''").catch(() => []);
  for (const r of statics as any[]) names.set(String(r.mac_address).toLowerCase(), String(r.hostname));
  for (const [k, v] of names) names.set(k, v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 63));
  return names;
}
// Taban çizgisinde o an komşu tablosunda olmayan ama bilinen sayılanlar: süren DHCP kirası (uyuyan telefon / IoT) ve cihaz
// listesindeki (devices) kayıtlar. Okunamazsa yalnız bağlı olanlar.
async function baselineExtras(file: string): Promise<string[]> {
  const out: string[] = [];
  const nowS = Math.floor(Date.now() / 1000);
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const [exp, mac] = line.trim().split(/\s+/);
      if (!/^\d+$/.test(exp || '') || (Number(exp) !== 0 && Number(exp) < nowS)) continue; // 0 = süresiz, geçmiş = bitmiş
      out.push(String(mac || '').toLowerCase());
    }
  } catch { /* kira dosyası yok */ }
  const rows = await dbAll('SELECT mac_address FROM devices').catch(() => []);
  for (const r of rows as any[]) out.push(String(r.mac_address || '').toLowerCase());
  return out.filter(deviceMac);
}

export type NewDevice = { mac: string; ip: string; name: string; random: boolean; setup: boolean };
export function deviceMessage(d: NewDevice): string {
  return `Yeni cihaz bağlandı: ${d.name || 'adı bilinmiyor'} (${d.ip}, ${d.mac})`
    + `${d.random ? ' — gizli Wi-Fi adresi olabilir (rastgele MAC)' : ''}${d.setup ? " — Kurulum Wi-Fi'ı" : ''}`;
}
export function summaryMessage(list: NewDevice[]): string {
  const shown = list.slice(0, 5).map(d => d.name || d.ip).join(', ');
  const rnd = list.filter(d => d.random).length;
  return `${list.length} yeni cihaz bağlandı: ${shown}${list.length > 5 ? ' …' : ''}${rnd ? ` (${rnd} tanesi gizli Wi-Fi adresi olabilir)` : ''}`;
}
// G5.6 alarm metni: ad (DHCP'den, düz metin) yoksa MAC; ayrıntıda IP (ve adı varsa MAC).
export function alarmMessage(d: NewDevice, label = 'Tatil kipi'): string {
  return `${label}: tanınmayan cihaz bağlandı — ${d.name || d.mac} (${d.name ? `${d.ip}, ${d.mac}` : d.ip})`
    + `${d.random ? ' — gizli Wi-Fi adresi olabilir (rastgele MAC)' : ''}${d.setup ? " — Kurulum Wi-Fi'ı" : ''}`;
}

async function saveKnown(mac: string): Promise<void> {
  try {
    await dbRun('INSERT OR IGNORE INTO known_devices (mac_address) VALUES (?)', [mac]);
    unsaved.delete(mac);
  } catch (e: any) {
    if (!unsaved.has(mac)) console.error('[yeni cihaz] kaydedilemedi (yeniden denenecek):', e?.message || e);
    unsaved.add(mac);
  }
}
// Olay satırı (events.ts recordEvent ile aynı biçim; bilgi olayı okunmuş). recordEvent hatayı yutar: burada yazılamazsa cihaz
// bekleyende kalır, sonraki turda yeniden denenir.
const writeEvent = (message: string, sev: 'info' | 'warning', source = 'device-new') =>
  dbRun('INSERT INTO alerts (type, severity, message, source, acknowledged) VALUES (?, ?, ?, ?, ?)',
    ['event', sev, String(message).slice(0, 500), source, sev === 'info' ? 1 : 0]);

// G5.6: sağlayıcının yanıtı (hata ya da süresi geçmiş pencere = alarm yok: olay bugünkü gibi yazılır).
async function alarmNow(): Promise<AlarmState | null> {
  if (!alarmProvider) return null;
  try {
    const a = await alarmProvider();
    return a && Number.isFinite(a.until) && a.until > Date.now() ? a : null;
  } catch (e: any) {
    console.error('[yeni cihaz] alarm durumu okunamadı (olay uyarısız yazılır):', e?.message || e);
    return null;
  }
}
type Done = (d: NewDevice) => Promise<void>;
// Tatil kipi: bu pencerede alarmı verilmiş MAC yeniden bildirilmez (bilinen olur); kalanlar 'warning' (10'dan fazlası tek özet).
async function writeAlarm(list: NewDevice[], a: AlarmState, done: Done): Promise<void> {
  const now = Date.now();
  for (const [m, u] of alarmed) if (u <= now) alarmed.delete(m);
  if (alarmed.size > 5000) alarmed.clear(); // üst sınır (cihaz zaten bilinen olur, yineleme yine olmaz)
  const fresh: NewDevice[] = [];
  for (const d of list) {
    if (alarmed.has(d.mac)) await done(d);
    else fresh.push(d);
  }
  const src = a.ignoreQuiet ? ALARM_URGENT_SOURCE : ALARM_SOURCE;
  const label = a.label || 'Tatil kipi';
  let wrote = 0;
  try {
    if (fresh.length > SUMMARY_AT) {
      await writeEvent(`${label}: ${summaryMessage(fresh)}`, 'warning', src);
      wrote++;
      for (const d of fresh) { alarmed.set(d.mac, a.until); await done(d); }
    } else {
      for (const d of fresh) {
        await writeEvent(alarmMessage(d, label), 'warning', src);
        wrote++;
        alarmed.set(d.mac, a.until);
        await done(d);
      }
    }
  } finally {
    // Öncelikli gönderim: yazılan alarm dış kanala göndericinin sıradaki turunu beklemeden gider (hata yalnız günlüğe)
    if (wrote && a.written) {
      try { a.written(); } catch (e: any) { console.error('[yeni cihaz] gönderici uyandırılamadı:', e?.message || e); }
    }
  }
}

// Bekleme süresi dolan yeni cihazlar olay olarak yazılır (tur başına 10'dan fazlası tek özet). Cihaz ancak olayı yazılınca
// known_devices'a girer: bekleme sırasında panel yeniden başlarsa cihaz açılışta yine yeni görünür ve bildirilir.
async function flush(now: number, my: number): Promise<void> {
  const holdMs = opts.holdMs ?? HOLD_MS;
  let due = [...pending].filter(([, p]) => now - p.at >= holdMs - (holdMs > HOLD_SLACK_MS ? HOLD_SLACK_MS : 0));
  // G5.6: sağlayıcı yalnız bekleyen cihaz varken sorulur; Tatil kipinde bekleme yok (öncelikli bildirim)
  const alarm = alarmProvider && pending.size ? await alarmNow() : null;
  if (my !== gen) return;
  if (alarm) due = [...pending];
  if (!due.length) return;
  const names = await leaseNames(opts.leasesFile || LEASES);
  if (my !== gen) return;
  const mode = notifyConfig().deviceWatch.randomMac;
  const devs: NewDevice[] = due.map(([mac, p]) => ({ mac, ip: p.ip, name: names.get(mac) || '', random: isRandomMac(mac), setup: inCidr(p.ip, AP_NET) }));
  const done = async (d: NewDevice) => { pending.delete(d.mac); await saveKnown(d.mac); };
  const list: NewDevice[] = [];
  for (const d of devs) {
    if (d.random && mode === 'suppress') await done(d); // bildirilmez, bilinen olur
    else list.push(d);
  }
  if (!list.length || my !== gen) return;
  try {
    if (alarm) {
      await writeAlarm(list, alarm, done);
    } else if (list.length > SUMMARY_AT) {
      await writeEvent(summaryMessage(list), 'info');
      for (const d of list) await done(d);
    } else {
      for (const d of list) {
        await writeEvent(deviceMessage(d), 'info');
        await done(d);
      }
    }
  } catch (e: any) {
    console.error('[yeni cihaz] olay yazılamadı (sonraki turda yeniden):', e?.message || e);
  }
}

// Bir tur. baseline: yeni görülenler (ve süren DHCP kiraları) bildirimsiz "bilinen" olur. ok: komşu tablosu ve bilinenler
// okundu (taban çizgisi ancak böyle bir turdan sonra tamam sayılır); n: bu turda geçerli MAC'li komşu sayısı.
async function scan(baseline: boolean, my: number): Promise<Scan> {
  if (my !== gen) return NO_SCAN;
  const live = await (opts.devices || getNetworkDevices)();
  if (my !== gen) return NO_SCAN;
  if (!known) {
    const rows = await dbAll('SELECT mac_address FROM known_devices');
    if (my !== gen) return NO_SCAN;
    known = new Set([...(rows as any[]).map(r => String(r.mac_address).toLowerCase()), ...notifyState().deviceWatch.extra]);
  }
  const now = Date.now();
  const seen = new Map<string, string>(); // mac → ip
  for (const d of live) {
    const mac = String(d.mac || '').toLowerCase();
    if (deviceMac(mac)) seen.set(mac, String(d.ip || ''));
  }
  for (const mac of [...unsaved]) await saveKnown(mac);
  const extra: string[] = [];
  if (baseline) {
    for (const mac of await baselineExtras(opts.leasesFile || LEASES)) {
      if (!seen.has(mac) && !known.has(mac)) { known.add(mac); extra.push(mac); }
    }
    if (my !== gen) return NO_SCAN;
  }
  const fresh = [...seen].filter(([mac]) => !known!.has(mac));
  if (fresh.length) {
    const prot = baseline ? new Set<string>() : await (opts.protectedMacs || baseProtectedMacs)().catch(() => new Set<string>());
    if (my !== gen) return NO_SCAN;
    for (const [mac, ip] of fresh) {
      known.add(mac);
      // Taban çizgisi ve korunan cihaz (ağ geçidi, Pi'nin kartları) hemen bilinen; yeni cihaz olayı yazılınca (flush)
      if (baseline || prot.has(mac)) await saveKnown(mac);
      else pending.set(mac, { ip, at: now });
    }
  }
  for (const [mac, p] of pending) { const ip = seen.get(mac); if (ip) p.ip = ip; } // adres değiştiyse güncel olanı
  await flush(now, my);
  return { ok: true, n: seen.size, extra: baseline ? [...notifyState().deviceWatch.extra, ...extra] : undefined };
}

// Tek tur (zamanlayıcı ve açma): aynı dönemde süren tur varsa onu bekler, üst üste binmez. Taban çizgisi yalnız başarılı
// bir taban turundan sonra işaretlenir; HA kapısı kapalıyken tur çalışmaz ve taban çizgisi bekler.
function scanOnce(): Promise<Scan> {
  if (scanning && scanning.gen === gen) return scanning.p;
  const prev = scanning?.p || Promise.resolve(NO_SCAN);
  const my = gen;
  const p: Promise<Scan> = prev.then(async () => {
    if (my !== gen || !notifyMayRun()) return NO_SCAN;
    const baseline = baselinePending;
    const r = await scan(baseline, my);
    if (r.ok && baseline && my === gen) {
      baselinePending = false;
      const dw = notifyState().deviceWatch;
      dw.baselineAt = Date.now();
      dw.extra = r.extra || [];
      try { saveNotifyState(); } catch (e: any) { console.error('[yeni cihaz] durum yazılamadı:', e?.message || e); }
    }
    return r;
  }).catch((e: any) => { console.error('[yeni cihaz] tarama:', e?.message || e); return NO_SCAN; })
    .finally(() => { if (scanning?.p === p) scanning = null; });
  scanning = { gen: my, p };
  return p;
}

function stop(): void {
  gen++;
  if (timer) clearInterval(timer);
  timer = null;
  known = null;
  pending.clear();
  unsaved.clear();
  baselinePending = false;
}

// Döner: ilk tur (taban turuysa taban çizgisi alındı mı, şu an bağlı kaç cihaz bilinen sayıldı).
async function begin(baseline: boolean): Promise<Scan> {
  stop();
  const my = gen;
  baselinePending = baseline;
  const r = await scanOnce();
  if (my !== gen) return NO_SCAN;
  timer = setInterval(() => { void scanOnce(); }, opts.intervalMs ?? INTERVAL_MS);
  timer.unref?.();
  return r;
}

// Aç / kapat / açılış tek sırada: biri bitmeden öbürü başlamaz (ayar ve izleyici durumu hep uyumlu kalır).
let op: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = op.then(fn);
  op = p.catch(() => undefined);
  return p;
}

// Açılış (yalnız ana cihaz, index.ts '!isSatellite'): sağlayıcılar saklanır; ayar kapalıysa hiçbir şey kurulmaz.
export function startDeviceWatch(o: DeviceWatchOpts = {}): Promise<void> {
  opts = { ...o };
  return serial(async () => {
    if (isSatellite() || !notifyMayRun() || !notifyConfig().deviceWatch.enabled) return;
    await begin(!notifyState().deviceWatch.baselineAt);
  });
}

export function stopDeviceWatch(): void { stop(); }

// Ayar ucu (PUT /api/notify/device-watch): açınca taban çizgisi, kapatınca zamanlayıcı durur ve bekleyenler atılır.
// baselinePending: açıldı ama taban çizgisi alınamadı (sonraki başarılı turda sessizce alınır).
export function setDeviceWatch(patch: { enabled?: boolean; randomMac?: RandomMacMode }):
  Promise<{ enabled: boolean; randomMac: RandomMacMode; baseline: number; baselinePending: boolean }> {
  return serial(async () => {
    const c = notifyConfig();
    const was = c.deviceWatch.enabled;
    const dw = { enabled: patch.enabled ?? was, randomMac: patch.randomMac ?? c.deviceWatch.randomMac };
    saveNotifyConfig({ ...c, deviceWatch: dw });
    let baseline = 0;
    if (!dw.enabled) {
      if (was) {
        stop();
        Object.assign(notifyState().deviceWatch, { baselineAt: 0, extra: [] });
        saveNotifyState();
      }
    } else if (!was || !timer) {
      baseline = (await begin(true)).n;
    }
    return { ...dw, baseline, baselinePending: dw.enabled && baselinePending };
  });
}

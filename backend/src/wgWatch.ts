// Ev VPN'i — dışarıdan erişimin otomatik denetimi. Ev VPN'i açıkken erişim testi (wgServer.ts reachabilityTest) açılıştan
// 10 dk sonra ve 6 saatte bir kendiliğinden çalışır. Olay geçmişine (zil) yalnız DURUM DEĞİŞİNCE yazılır:
//  - dışarıdan ulaşılamıyor: ilk başarısızlıkta 15 dk sonra yeniden denenir; ikinci kez de ulaşılamazsa uyarı (anlık kopma,
//    modemin yeniden başlaması alarm üretmez). Uyarı test sonucuna göre olası nedeni ve düzeltmeyi söyler (ör. arka arkaya
//    iki cihazda dıştaki cihazın kuralı iç router'ın eski adresini gösteriyor).
//  - yeniden ulaşılıyor: bilgi.   - DDNS adı evin adresini göstermiyor: uyarı (düzelip yeniden bozulursa yine).
// Dış deneme yapılamadıysa (VPS tüneli yok, Pi doğrudan internette) son bilinen durum korunur, alarm yazılmaz. Elle
// çalıştırılan test de durumu günceller (index.ts); kullanıcı sonucu ekranda gördüğü için onun için ayrıca alarm yazılmaz.
// Durum app_settings'te (wg_reach_watch): panel yeniden başlasa da aynı sorun için ikinci alarm çıkmaz.
import { dbGet, dbRun } from './db';
import { reachabilityTest, type ReachResult } from './wgServer';
import { recordEvent } from './events';
import { isSatellite } from './role';
import { isLinux } from './system';

const FIRST_DELAY_MS = 10 * 60_000; // açılışta ağ, tüneller ve DDNS otursun
const INTERVAL_MS = 6 * 3600_000; // günde 4 kez
const RECHECK_MS = 15 * 60_000; // ilk başarısızlıktan sonra doğrulama
export const REACH_WATCH_INTERVAL_H = INTERVAL_MS / 3600_000;
const KEY = 'wg_reach_watch';

export interface ReachWatchState {
  status: 'reachable' | 'unreachable' | 'none'; // son kesin sonuç (dış deneme yapılamayanlar değiştirmez)
  statusAt: string;
  lastRun: string; // son test (sonucu ne olursa olsun)
  lastExternal: 'reachable' | 'unreachable' | 'untested' | '';
  lastSource: 'auto' | 'manual' | '';
  fails: number;
  alerted: boolean;
  ddnsAlerted: boolean;
}
const EMPTY: ReachWatchState = {
  status: 'none', statusAt: '', lastRun: '', lastExternal: '', lastSource: '', fails: 0, alerted: false, ddnsAlerted: false,
};

export async function reachWatchState(): Promise<ReachWatchState> {
  try {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [KEY]);
    return row?.value ? { ...EMPTY, ...JSON.parse(row.value) } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

async function save(s: ReachWatchState): Promise<void> {
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [KEY, JSON.stringify(s)]).catch(() => {});
}

// Uyarı metni (olay en çok 500 karakter): test sonucundan olası neden ve yapılacak iş.
function unreachableMessage(r: ReachResult): string {
  const n = r.routers.length;
  const hint = r.cgnatHop
    ? `Evden çıkışta operatörün paylaşımlı adresi (${r.cgnatHop}) görülüyor: operatör CGNAT'a geçmiş olabilir.`
    : n >= 2
      ? `Büyük olasılıkla dıştaki cihazın (${r.routers[n - 1]}) port yönlendirmesi iç router'ın eski adresini gösteriyor: o cihazın bağlı cihazlar listesinden iç router'ın güncel adresini bulup kuraldaki iç adrese yazın.`
      : n === 1
        ? `Modemdeki (${r.routers[0]}) UDP ${r.port} → ${r.piLanIp || 'Pi'} yönlendirmesini kontrol edin.`
        : `Modemdeki UDP ${r.port} yönlendirmesini kontrol edin.`;
  return `Ev VPN'ine dışarıdan ulaşılamıyor (iki denetimde de); ev dışındaki cihazlar bağlanamaz. ${hint} Adım adım: VPS WireGuard → Ev VPN'i (Pi) → Testi başlat.`;
}

// Elle ve otomatik testlerin ortak sonucu. reachabilityTest eşzamanlı çağrılarda aynı sonucu paylaştırır → aynı sonuç bir
// kez işlenir. 'recheck': otomatik denetimde ilk başarısızlık, doğrulama erken yapılsın.
let lastNotedAt = '';
export async function noteReachResult(r: ReachResult, source: 'auto' | 'manual'): Promise<'recheck' | void> {
  if (r.at === lastNotedAt) return;
  lastNotedAt = r.at;
  const s = await reachWatchState();
  const ext = r.external.status;
  let recheck = false;
  s.lastRun = r.at;
  s.lastExternal = ext;
  s.lastSource = source;
  if (ext === 'unreachable') {
    s.fails = s.status === 'unreachable' ? s.fails + 1 : 1;
    if (source === 'manual') s.alerted = true; // sonuç ekranda; index.ts ayrıca uyarı olayı yazar
    else if (!s.alerted && s.fails >= 2) {
      await recordEvent('vpn', unreachableMessage(r), 'warning');
      s.alerted = true;
    } else if (!s.alerted) recheck = true;
    if (s.status !== 'unreachable') s.statusAt = r.at;
    s.status = 'unreachable';
  } else if (ext === 'reachable') {
    if (s.alerted && source === 'auto') await recordEvent('vpn', "Ev VPN'ine dışarıdan yeniden ulaşılıyor.");
    if (s.status !== 'reachable') s.statusAt = r.at;
    s.status = 'reachable';
    s.fails = 0;
    s.alerted = false;
  }
  if (r.ddnsOk === false) {
    if (!s.ddnsAlerted && source === 'auto') {
      await recordEvent('vpn', `DDNS adı (${r.endpoint.host}) evin güncel adresini (${r.publicIp}) göstermiyor; ev dışındaki cihazlar Ev VPN'ine bağlanamaz. Ağ Yönetimi → DDNS → IP Kontrol Et.`, 'warning');
    }
    s.ddnsAlerted = true;
  } else if (r.ddnsOk === true) s.ddnsAlerted = false;
  await save(s);
  return recheck ? 'recheck' : undefined;
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void runOnce(); }, ms);
}

async function runOnce(): Promise<void> {
  let next = INTERVAL_MS;
  try {
    const srv = await dbGet('SELECT enabled FROM wg_server WHERE id = 1').catch(() => null);
    if (isSatellite() || !srv?.enabled) {
      // Kapalıyken eski durum saklanmaz: yeniden açılınca ilk sorun yine bildirilsin.
      if ((await reachWatchState()).status !== 'none') await save({ ...EMPTY });
    } else if (await noteReachResult(await reachabilityTest(), 'auto') === 'recheck') {
      next = RECHECK_MS;
    }
  } catch (e: any) {
    console.error('[ev-vpn] otomatik erişim denetimi:', e?.message || e);
  }
  schedule(next);
}

export function startReachWatch(): void {
  if (!isLinux || timer) return;
  schedule(FIRST_DELAY_MS);
}

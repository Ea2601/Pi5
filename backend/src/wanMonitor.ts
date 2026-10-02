// WAN monitörü (G2.3): hat başına (ana hat / yedek hat) paket kaybı, ortalama gecikme (RTT) ve jitter geçmişi + "hat kesildi
// / geri geldi" olayı. Panel: Hız Testi → Hat Kalitesi. Yalnız ölçer: nft, ip rule, rota, tc ya da systemd birimi YOK; wan.ts,
// net-mode.sh ve sağlık denetimindeki 5 dakikalık 'network' ping'i aynen kalır.
//  - VARSAYILAN KAPALI: app_settings 'wan_monitor' (JSON) yalnız PUT /api/wan-monitor/settings'ten, doğrulamayla yazılır (genel
//    PUT /api/settings kabul etmez; yedekten geri gelmez — index.ts BACKUP_SKIP_SETTINGS: kotalı hatta geri yüklenen ayar
//    kendiliğinden ping başlatmasın). Kapalıyken zamanlayıcı, ping ve tablo yazımı (tablo oluşturma dahil) yoktur.
//  - Hatlar tek kaynaktan (system.ts): internet kartı kipinde kartın adres arayüzü (pppwan / wan.<VLAN> / kart), Wi-Fi
//    köprüsünde (R4 C) üst Wi-Fi, tek bacakta varsayılan rotanın arayüzü (getLanIdentity — yedek hat hariç). Yedek hat her
//    turda yeniden okunur (USB türünde arayüz grubu 77, adı her takışta değişebilir); yedek hattın arayüzü yoksa "ölçülemedi"
//    (kesinti sayılmaz).
//  - Sonda: `ping -n -q -c 5 -i 0.2 -W 1 -I <arayüz> <hedef>` (SO_BINDTODEVICE: VPS kuralları ve rota metrikleri araya girmez;
//    net-mode.sh bak_probe ile aynı), hedefler 1.1.1.1 / 8.8.8.8 / 9.9.9.9 — son yanıt veren hedeften başlanır, biri yanıt
//    verince durulur; turda gönderilen bütün ping'ler kayba sayılır (yanıtsız hedefin ping'leri atılmaz). Hiçbiri yanıt
//    vermezse (operatör ICMP'yi süzüyor olabilir) TCP 443 denemesi (net-mode.sh wan_internet_ok deseni): curl arayüze bağlanır
//    (--interface: ping -I ile aynı anlam; yedek hatta ve geçiş sırasında da o hattan çıkar), yalnız bağlantı kurulur, veri
//    gönderilmez. ICMP'yi süzen hatta sonraki turlar tek hedefe 5 ping + TCP 443'tür (veri tahmini aşılmasın); bu turlar
//    kayıp hesabına girmez.
//  - Kesinti kararı tek yerde: yedek hat açıkken ana hattın kesikliği izleyicinin (net-mode.sh backup watch → failover.status)
//    geçişidir — yedek hatta geçtiyse kesik, ana hatta dönünce geri geldi (izleyicinin 60 sn kuralı); ana hattayken tek turluk
//    primary_ok=0 kesinti sayılmaz (geçiş kararı izleyicinin). Yalnız yedek hat da yanıtsızsa (izleyici geçemez) ya da yedek
//    hat yokken kendi kuralı: varsayılan rota yoksa tek ölçüm, rota varsa ardışık 2 tam kayıp + TCP 443 başarısız. İkinci bir
//    geçiş / karar mekanizması yoktur.
//  - Olaylar yalnız durum değişince (writeLineEvent tek yazım noktası — HA'da (G4.3) iki düğüm de ölçer, olayı yalnız MASTER
//    yazar; kapatma o fonksiyonda yapılacak). Hat durumu /var/lib/pi5-gateway/wan-monitor.state'te (gizli değer yok, yedeğe
//    girmez): panel kesinti sürerken yeniden başlarsa (güncelleme, çökme, Pi'nin yeniden başlatılması) "kesildi" yinelenmez.
//  - Kayıt: wan_samples (yedeğe girmez). Örnekler bellekte birikir, 5 dk'da bir ve panel kapanırken tek ifadeyle toplu yazılır
//    (SD kart); standard profilde 7, lite profilde 2 gün saklanır.
import { execFile } from 'child_process';
import fs from 'fs';
import type express from 'express';
import { dbAll, dbGet, dbRun, dbTimeMs } from './db';
import { recordEvent, type EventSeverity } from './events';
import {
  isLinux, readNetModeState, readFailoverStatus, wanActive, sameNetActive, backupIfaces, getLanIdentity, HOME_BRIDGE,
  type NetModeState, type FailoverStatus,
} from './system';
import { readPlatform } from './hardware';

export type LineRole = 'primary' | 'backup';
const ROLES: LineRole[] = ['primary', 'backup'];
export const EVENT_SOURCE = 'wan-monitor';

// ─── Ayar ───

export interface WanMonitorSettings { enabled: boolean; intervalS: number; backupIntervalS: number; measureBackup: boolean }
export const WAN_MONITOR_DEFAULTS: Readonly<WanMonitorSettings> = { enabled: false, intervalS: 30, backupIntervalS: 60, measureBackup: true };
export const SETTINGS_KEY = 'wan_monitor';
export const INTERVAL_MIN_S = 10;
export const INTERVAL_MAX_S = 600;
const intervalOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= INTERVAL_MIN_S && (v as number) <= INTERVAL_MAX_S;

// Kayıtlı değer → ayar (bozuk / eksik alan varsayılana döner; kayıt yoksa kapalı).
export function normalizeSettings(raw: unknown): WanMonitorSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    enabled: o.enabled === true,
    intervalS: intervalOk(o.intervalS) ? o.intervalS : WAN_MONITOR_DEFAULTS.intervalS,
    backupIntervalS: intervalOk(o.backupIntervalS) ? o.backupIntervalS : WAN_MONITOR_DEFAULTS.backupIntervalS,
    measureBackup: typeof o.measureBackup === 'boolean' ? o.measureBackup : WAN_MONITOR_DEFAULTS.measureBackup,
  };
}

// PUT gövdesi: yalnız bilinen alanlar, tür ve aralık denetimi; verilmeyen alan mevcut değerinde kalır.
const SETTING_FIELDS = ['enabled', 'intervalS', 'backupIntervalS', 'measureBackup'];
export function validateSettingsPatch(body: unknown, cur: WanMonitorSettings): { settings: WanMonitorSettings } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Ayar nesnesi gerekli' };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter(k => !SETTING_FIELDS.includes(k));
  if (extra.length) return { error: `Bilinmeyen ayar: ${extra.join(', ')}` };
  const next = { ...cur };
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean') return { error: 'Açık / kapalı değeri true ya da false olmalı' };
    next.enabled = b.enabled;
  }
  for (const [k, label] of [['intervalS', 'Ana hat'], ['backupIntervalS', 'Yedek hat']] as const) {
    if (!(k in b)) continue;
    if (!intervalOk(b[k])) return { error: `${label} ölçüm aralığı ${INTERVAL_MIN_S}–${INTERVAL_MAX_S} sn arasında tam sayı olmalı` };
    next[k] = b[k] as number;
  }
  if ('measureBackup' in b) {
    if (typeof b.measureBackup !== 'boolean') return { error: 'Yedek hat ölçümü true ya da false olmalı' };
    next.measureBackup = b.measureBackup;
  }
  return { settings: next };
}

export async function readSettings(): Promise<WanMonitorSettings> {
  try {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY]);
    return normalizeSettings(row?.value ? JSON.parse(String(row.value)) : null);
  } catch {
    return { ...WAN_MONITOR_DEFAULTS };
  }
}

// ─── Ping çıktısı (iputils; busybox "round-trip … = min/avg/max" biçimi de okunur) ───

export interface PingStats {
  sent: number; recv: number; errors: number; lossPct: number;
  rttMin: number | null; rttAvg: number | null; rttMax: number | null; jitter: number | null;
}
// "5 packets transmitted, 4 received, +1 errors, 20% packet loss, time 803ms" + "rtt min/avg/max/mdev = a/b/c/d ms".
// jitter = mdev; tek yanıtta tanımsız (iputils 0.000 basar) → null. Özet satırı yoksa (ping çalışamadı: "Network is
// unreachable", arayüz yok) null.
export const lossPctOf = (sent: number, recv: number) => (sent > 0 ? Math.round(((sent - recv) / sent) * 1000) / 10 : 100);
export function parsePing(out: string): PingStats | null {
  const text = String(out || '');
  const tx = /(\d+) packets transmitted/.exec(text);
  const rx = /(\d+) (?:packets )?received/.exec(text);
  if (!tx || !rx) return null;
  const sent = Number(tx[1]);
  const recv = Math.min(Number(rx[1]), sent);
  const errors = Number(/\+(\d+) errors?/.exec(text)?.[1] || 0);
  const rtt = /(?:rtt|round-trip) min\/avg\/max(?:\/(?:mdev|stddev))? = ([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))? ms/.exec(text);
  const num = (s: string | undefined) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : null);
  const has = recv > 0 && !!rtt;
  return {
    sent, recv, errors, lossPct: lossPctOf(sent, recv),
    rttMin: has ? num(rtt![1]) : null, rttAvg: has ? num(rtt![2]) : null, rttMax: has ? num(rtt![3]) : null,
    jitter: has && recv >= 2 ? num(rtt![4]) : null,
  };
}

// ─── Ölçülecek hatlar (saf) ───

export type LineKind = 'wan' | 'pppoe' | 'vlan' | 'wifi' | 'bridge' | 'lan' | 'eth' | 'usb' | 'hotspot';
export interface LineTarget { role: LineRole; dev: string; kind: LineKind }
export interface LineEnv {
  lanDev: string;                       // tek bacak: getLanIdentity().iface (yedek hat hariç en düşük metrikli varsayılan rota)
  bakIfs: string[];                     // backupIfaces(ns) — her turda
  foBackupDev: string;                  // izleyicinin o anki yedek hat arayüzü (failover.status backup_dev)
  hasAddr: (dev: string) => boolean;    // USB: adresli grup 77 arayüzü (net-mode.sh bak_cur_dev)
  exists: (dev: string) => boolean;
}
// wanActive tür daraltıcıdır (false dalında ns'yi null'a daraltır): burada yalın boole.
const wanCardOn = (s: NetModeState): boolean => wanActive(s);
export function resolveLines(ns: NetModeState | null, env: LineEnv): LineTarget[] {
  const out: LineTarget[] = [];
  if (ns && wanCardOn(ns)) {
    // İnternet kartı (R3 / R3b tek port / R4 A Wi-Fi WAN): adresin ve varsayılan rotanın arayüzü (net-mode.sh bak_primary_dev).
    out.push({ role: 'primary', dev: ns.wanDev, kind: ns.wanType === 'pppoe' ? 'pppoe' : ns.wanVlan ? 'vlan' : ns.wanSsid ? 'wifi' : 'wan' });
  } else if (ns && sameNetActive(ns)) {
    out.push({ role: 'primary', dev: ns.repPort, kind: 'bridge' });
  } else {
    // Tek bacak: varsayılan rotanın arayüzü; rota yoksa net-mode.sh'nin ana hattı (lan_dev: ev Wi-Fi'ı köprüsü ya da kart).
    const lan = env.lanDev || (ns && ns.homeStage !== 'none' && env.exists(HOME_BRIDGE) ? HOME_BRIDGE : ns?.iface || '');
    out.push({ role: 'primary', dev: lan, kind: 'lan' });
  }
  if (ns && ns.bakStage === 'on') {
    let dev: string;
    if (ns.bakKind === 'usb') {
      dev = env.bakIfs.includes(env.foBackupDev) ? env.foBackupDev : env.bakIfs.find(d => env.hasAddr(d)) || env.bakIfs[0] || '';
    } else {
      dev = ns.bakDev || env.foBackupDev || env.bakIfs[env.bakIfs.length - 1] || '';
    }
    const kind: LineKind = ns.bakKind === 'usb' ? 'usb' : ns.bakKind === 'wifi' ? 'hotspot'
      : ns.bakType === 'pppoe' ? 'pppoe' : ns.bakVlan ? 'vlan' : 'eth';
    out.push({ role: 'backup', dev, kind });
  }
  return out;
}

// ─── Karar (saf) ───

export type Verdict = 'ok' | 'fail' | 'down' | 'skip';
export interface ProbeOutcome { target: string; stats: PingStats; tcp: boolean | null } // tcp: null = denenmedi
// Güncel failover.status (yedek hat açık, izleyici çalışıyor). forced: panelden geçiş denemesi sürüyor (force_until > şimdi).
export interface WatcherView { active: 'primary' | 'backup'; primaryOk: boolean | null; backupOk: boolean | null; forced: boolean }
export interface JudgeInput {
  role: LineRole; dev: string; present: boolean; hasRoute: boolean;
  probe: ProbeOutcome | null;                                               // null: ölçülmedi
  watcher: WatcherView | null;
}
export function judge(i: JudgeInput): { verdict: Verdict; reason: string } {
  // Yedek hattın arayüzü yok (USB modem çıkarıldı / adı değişti): ölçülemedi, kesinti değil.
  if (i.role === 'backup' && (!i.dev || !i.present)) return { verdict: 'skip', reason: 'arayüz yok — ölçülemedi' };
  const w = i.watcher;
  if (w && i.role === 'backup') {
    if (w.backupOk === true) return { verdict: 'ok', reason: '' };
    if (w.backupOk === null) return { verdict: 'skip', reason: 'yedek hat izleyicisi henüz ölçmedi' };
    return { verdict: 'fail', reason: 'yedek hat izleyicisi yedek hattan yanıt alamıyor — ana hat düşerse geçilecek hat yok' };
  }
  if (w) {
    // Ana hat: kesiklik izleyicinin geçişidir (eşiği: 3 yanıtsız tur ya da rota yok; dönüşü: ana hat 60 sn sağlam). Yedek
    // hattayken ana hat yanıt verse de dönülene dek kesik — "geri geldi" izleyicinin "Ana hatta dönüldü"süyle aynı turda.
    if (w.active === 'backup') {
      if (w.forced) return { verdict: 'skip', reason: 'geçiş denemesi sürüyor — ev ağı geçici olarak yedek hattan internette' };
      return { verdict: 'down', reason: w.primaryOk === true
        ? 'ev ağı yedek hatta; ana hat yeniden yanıt veriyor, yedek hat izleyicisi 60 sn sağlam görünce ana hatta döner'
        : 'yedek hat izleyicisi yedek hatta geçti, ana hat yanıt vermiyor' };
    }
    if (w.primaryOk === true) return { verdict: 'ok', reason: '' };
    if (w.primaryOk === null) return { verdict: 'skip', reason: 'yedek hat izleyicisi henüz ölçmedi' };
    // Ana hattayken tek turluk yanıtsızlık kesinti değil: geçiş kararı izleyicinin (gerçek kesintide ≈15 sn'de geçer).
    if (w.backupOk === true) return { verdict: 'skip', reason: 'ana hat izleyicinin son turunda yanıt vermedi — geçiş kararı yedek hat izleyicisinde' };
    // Yedek hat da yanıtsız: izleyici geçemez → aşağıdaki kendi kuralı
  }
  if (!i.dev || !i.present) return { verdict: 'down', reason: i.dev ? `arayüz yok (${i.dev})` : 'varsayılan rota yok' };
  if (!i.hasRoute) return { verdict: 'down', reason: 'varsayılan rota yok' };
  if (!i.probe) return { verdict: 'skip', reason: 'ölçülmedi' };
  if (i.probe.stats.recv > 0 || i.probe.tcp === true) return { verdict: 'ok', reason: '' };
  return { verdict: 'fail', reason: `${PROBE_TARGETS.join(', ')} yanıt vermiyor${i.probe.tcp === false ? ', TCP 443 de açılmadı' : ''}` };
}

// Hat durumu: ardışık 2 'fail' ya da tek 'down' → kesik; tek 'ok' → çalışıyor. 'skip' durumu değiştirmez.
export interface LineState { state: 'unknown' | 'up' | 'down'; fails: number; failSince: number; since: number }
export const initialLineState = (): LineState => ({ state: 'unknown', fails: 0, failSince: 0, since: 0 });
export interface LineChange { to: 'down' | 'up'; from: number; at: number }
export function advance(st: LineState, verdict: Verdict, now: number): { next: LineState; change: LineChange | null } {
  if (verdict === 'skip') return { next: st, change: null };
  if (verdict === 'ok') {
    const next: LineState = { state: 'up', fails: 0, failSince: 0, since: st.state === 'up' ? st.since : now };
    return { next, change: st.state === 'down' ? { to: 'up', from: st.since, at: now } : null };
  }
  const failSince = st.fails > 0 ? st.failSince : now;
  const fails = st.fails + 1;
  if (st.state !== 'down' && (verdict === 'down' || fails >= 2)) {
    return { next: { state: 'down', fails, failSince, since: failSince }, change: { to: 'down', from: failSince, at: now } };
  }
  return { next: { ...st, fails, failSince }, change: null };
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const LINE_NAME: Record<LineRole, string> = { primary: 'Ana hat', backup: 'Yedek hat' };
export function lineEventMessage(role: LineRole, change: LineChange, dev: string, reason: string): string {
  if (change.to === 'down') return `${LINE_NAME[role]} kesildi (${dev || 'arayüz yok'}) — ${reason || 'yanıt yok'}`;
  const mins = Math.max(1, Math.round((change.at - change.from) / 60000));
  return `${LINE_NAME[role]} geri geldi: ${hhmm(change.from)}–${hhmm(change.at)} arası ${mins} dk kesikti`;
}

// Kesinti listesi: olay geçmişindeki "kesildi" / "geri geldi" çiftleri (rows: eskiden yeniye). Bitişi olmayan kesinti
// ongoing ise sürüyor; değilse bitişi kaydedilmemiş (izleme kapatıldı / panel kesinti sürerken 15 dk'dan uzun kapalı kaldı).
export interface Outage {
  role: LineRole; dev: string; start: string; end: string | null; minutes: number | null; ongoing: boolean; endMessage: string;
}
const EVENT_RE = /^(Ana|Yedek) hat (kesildi|geri geldi)/;
export function pairOutages(rows: { message: string; created_at: string }[], ongoing: Record<LineRole, boolean>): Outage[] {
  const open: Partial<Record<LineRole, Outage>> = {};
  const out: Outage[] = [];
  for (const r of rows) {
    const m = EVENT_RE.exec(String(r.message || ''));
    if (!m) continue;
    const role: LineRole = m[1] === 'Ana' ? 'primary' : 'backup';
    if (m[2] === 'kesildi') {
      if (open[role]) out.push(open[role]!);
      const dev = /kesildi \(([^)]*)\)/.exec(r.message)?.[1] || '';
      open[role] = { role, dev, start: r.created_at, end: null, minutes: null, ongoing: false, endMessage: '' };
    } else if (open[role]) {
      const o = open[role]!;
      const a = dbTimeMs(o.start), b = dbTimeMs(r.created_at);
      out.push({ ...o, end: r.created_at, endMessage: r.message,
        minutes: Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 60000)) : null });
      delete open[role];
    }
  }
  for (const role of ROLES) if (open[role]) out.push({ ...open[role]!, ongoing: ongoing[role] });
  return out.sort((x, y) => (dbTimeMs(y.start) || 0) - (dbTimeMs(x.start) || 0));
}

export const retentionDaysFor = (profile: string | null | undefined) => (profile === 'lite' ? 2 : 7);

// Kayıtlı hat durumu (wan-monitor.state, KEY=VALUE): dosya en çok RESTORE_WINDOW_MIN dakika önce yazılmışsa (panel kısa süre
// kapalı kaldı) kesik hatlar kaydedilen başlangıçlarıyla kesik sürer. Daha eski dosya (uzun kapanma / kapatılmış izleme)
// eski bir durumu diriltmez.
export const RESTORE_WINDOW_MIN = 15;
export function parseSavedStates(text: string, now: number): Partial<Record<LineRole, LineState>> {
  const kv: Record<string, string> = {};
  for (const l of String(text || '').split('\n')) {
    const k = l.indexOf('=');
    if (k > 0) kv[l.slice(0, k).trim()] = l.slice(k + 1).trim();
  }
  const seen = Number(kv.seen);
  if (!Number.isFinite(seen) || seen <= 0 || seen > now + 60000 || now - seen > RESTORE_WINDOW_MIN * 60000) return {};
  const out: Partial<Record<LineRole, LineState>> = {};
  for (const role of ROLES) {
    const since = Number(kv[`${role}_since`]);
    if (kv[`${role}_state`] === 'down' && Number.isFinite(since) && since > 0 && since <= now) {
      out[role] = { state: 'down', fails: 0, failSince: 0, since };
    }
  }
  return out;
}

// ─── Ölçüm (Linux) ───

export const PROBE_TARGETS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
const PING_COUNT = 5;
const TCP_TARGET = '1.1.1.1';
const IFNAME = /^[A-Za-z0-9_.-]{1,15}$/;

function run(cmd: string, args: string[], timeout = 5000): Promise<{ code: number | string | null; stdout: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException).code ?? 1) : 0, stdout: String(stdout || '') });
    });
  });
}
const ipJson = async (args: string[]): Promise<any[]> => {
  const r = await run('ip', ['-j', '-4', ...args]);
  try { const v = JSON.parse(r.stdout || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const hasDefaultRoute = async (dev: string) => (await ipJson(['route', 'show', 'default', 'dev', dev])).length > 0;

// Bir hedefe 5 ping; ping yoksa (ENOENT) null — ölçülemedi, kesinti sayılmaz.
async function pingOnce(dev: string, target: string): Promise<PingStats | null> {
  const r = await run('ping', ['-n', '-q', '-c', String(PING_COUNT), '-i', '0.2', '-W', '1', '-I', dev, target], 10000);
  if (r.code === 'ENOENT') return null;
  return parsePing(r.stdout) || { sent: PING_COUNT, recv: 0, errors: 0, lossPct: 100, rttMin: null, rttAvg: null, rttMax: null, jitter: null };
}

// TCP 443 yedeği: curl arayüze bağlanır (--interface → SO_BINDTODEVICE, ping -I ile aynı; depodaki kalıp: wgImport.ts,
// wgServer.ts). telnet:// yalnız TCP bağlantısı kurar, veri göndermez (el sıkışma + kapanış ≈ 330 B); bağlantı kurulduysa
// time_connect > 0 (sunucu açık tutarsa -m süresince beklenir). curl yoksa ya da arayüze bağlanamadıysa (45) null: denenmedi.
async function tcpReach(dev: string): Promise<boolean | null> {
  const r = await run('curl', ['-4', '-s', '-o', '/dev/null', '-w', '%{time_connect}', '--interface', dev,
    '--connect-timeout', '4', '-m', '4', `telnet://${TCP_TARGET}:443`], 7000);
  if (r.code === 'ENOENT' || r.code === 45) return null;
  const t = Number(r.stdout.trim().replace(',', '.'));
  return Number.isFinite(t) && t > 0;
}

// Hat başına sonda belleği: son yanıt veren hedef (sonraki tur ondan başlar) ve ICMP'nin süzüldüğü (önceki tur: hiçbir hedef
// yanıt vermedi, TCP 443 açık). Süzülen hatta tek hedefe 5 ping + TCP 443 (üç hedef her turda denenmez: veri tahmini tutsun);
// hedef yanıt verince ya da TCP 443 de kapanınca normal sondaya dönülür.
const probeMemo = new Map<string, { pref: string; icmpOff: boolean }>();
export async function probeLine(dev: string): Promise<ProbeOutcome | null> {
  if (probeMemo.size > 32) probeMemo.clear(); // USB adı her takışta değişebilir: bellek büyümesin
  const m = probeMemo.get(dev) || { pref: PROBE_TARGETS[0], icmpOff: false };
  const order = [m.pref, ...PROBE_TARGETS.filter(t => t !== m.pref)];
  // Turda gönderilen bütün ping'ler kayba sayılır: yanıtsız hedefin ping'leri atılırsa yüksek kayıp düşük görünürdü.
  let sent = 0, errors = 0;
  for (const target of m.icmpOff ? order.slice(0, 1) : order) {
    const st = await pingOnce(dev, target);
    if (!st) return null;
    sent += st.sent; errors += st.errors;
    if (st.recv > 0) {
      probeMemo.set(dev, { pref: target, icmpOff: false });
      return { target, stats: { ...st, sent, errors, lossPct: lossPctOf(sent, st.recv) }, tcp: null };
    }
  }
  // Hiçbir hedef yanıt vermedi: TCP 443 denemesi
  const tcp = await tcpReach(dev);
  probeMemo.set(dev, { pref: m.pref, icmpOff: tcp === true });
  return { target: order[0], stats: { sent, recv: 0, errors, lossPct: 100, rttMin: null, rttAvg: null, rttMax: null, jitter: null }, tcp };
}

// Bu turda ölçülecek hatlar (durum dosyası + izleyici durumu + canlı arayüzler). only: yalnız o hat çözülür (ana hat turunda
// yedek hattın USB adres taraması, yedek hat turunda varsayılan rota sorgusu yapılmaz).
export async function currentLines(ns: NetModeState | null, fo: FailoverStatus | null, only?: LineRole): Promise<LineTarget[]> {
  const bakIfs = backupIfaces(ns);
  const single = !wanActive(ns) && !sameNetActive(ns);
  const lanDev = single && only !== 'backup' ? (await getLanIdentity().catch(() => null))?.iface || '' : '';
  const addrs = new Set<string>();
  if (only !== 'primary' && ns?.bakKind === 'usb' && bakIfs.length) {
    for (const a of await ipJson(['addr', 'show'])) {
      if (a?.ifname && (a.addr_info || []).some((x: any) => x?.family === 'inet' && x.local)) addrs.add(String(a.ifname));
    }
  }
  return resolveLines(ns, {
    lanDev, bakIfs, foBackupDev: fo?.backupDev || '', hasAddr: d => addrs.has(d),
    exists: d => IFNAME.test(d) && fs.existsSync(`/sys/class/net/${d}`),
  }).map(l => ({ ...l, dev: IFNAME.test(l.dev) ? l.dev : '' }));
}

// ─── Çalışma durumu ───

// lossPct: null = ICMP yanıtlanmıyor ama TCP 443 açık (hat çalışıyor; kayıp ölçülemedi — özet ve grafik kayba saymaz)
export interface Sample {
  at: number; role: LineRole; dev: string; target: string; sent: number; recv: number; lossPct: number | null;
  rttAvg: number | null; rttMin: number | null; rttMax: number | null; jitter: number | null; tcp: boolean | null;
}
interface LineView {
  role: LineRole; dev: string; kind: LineKind; state: LineState['state']; since: number; verdict: Verdict; reason: string;
  checkedAt: number; present: boolean; hasRoute: boolean; measured: boolean; watcher: boolean; last: Sample | null;
}
const WATCHER_FRESH_S = 30;          // izleyici 5-7 sn'de bir yazar; daha eskiyse çalışmıyor sayılır
const FLUSH_MS = 5 * 60 * 1000;
const RECENT_MAX = 120;
const DAY_MS = 86400000;
const STATE_DIR = '/var/lib/pi5-gateway';
const STATE_FILE = `${STATE_DIR}/wan-monitor.state`;

let settings: WanMonitorSettings = { ...WAN_MONITOR_DEFAULTS };
let settingsGen = 0;                 // ayar uçtan her kaydedilişte artar (açılıştaki okuma eskiyse uygulanmaz)
let running = false;
let runGen = 0;                      // her açılışta artar: kapatılıp yeniden açılınca eski turun sonucu yazılmaz
let timers: ReturnType<typeof setInterval>[] = [];
let states: Record<LineRole, LineState> = { primary: initialLineState(), backup: initialLineState() };
let views: Record<LineRole, LineView | null> = { primary: null, backup: null };
const busy: Record<LineRole, boolean> = { primary: false, backup: false };
let pending: Sample[] = [];
let recent: Record<LineRole, Sample[]> = { primary: [], backup: [] };

// Hat olayının TEK yazım noktası. G4.3 (HA): iki düğüm de ölçer, olayı yalnız MASTER yazar — susturma burada yapılacak.
async function writeLineEvent(message: string, severity: EventSeverity): Promise<void> {
  await recordEvent(EVENT_SOURCE, message, severity);
}

// Hat durumu dosyası (parseSavedStates): durum değişince, her toplu yazımda ve panel kapanırken yazılır; izleme kapatılınca
// silinir. Yazılamazsa yalnız yeniden başlatmada süren kesinti tanınmaz (bir kez günlüğe).
let stateFileWarned = false;
function saveStateFile(): void {
  const out = [`seen=${Date.now()}`];
  for (const role of ROLES) out.push(`${role}_state=${states[role].state}`, `${role}_since=${states[role].since}`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(`${STATE_FILE}.tmp`, `${out.join('\n')}\n`);
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (e: any) {
    if (!stateFileWarned) console.error('[wan-monitor] durum dosyası yazılamadı:', e?.message || e);
    stateFileWarned = true;
  }
}
function removeStateFile(): void {
  try { fs.unlinkSync(STATE_FILE); } catch { /* yok */ }
}
// Panel kesinti sürerken yeniden başladı: kesik hat kesik başlar — "kesildi" yinelenmez, dönüş süresi ilk andan.
function restoreStates(): void {
  let text = '';
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return; }
  const saved = parseSavedStates(text, Date.now());
  for (const role of ROLES) if (saved[role]) states[role] = saved[role]!;
}

async function round(role: LineRole): Promise<void> {
  if (!running || busy[role]) return;
  const gen = runGen;
  busy[role] = true;
  try {
    const ns = readNetModeState();
    if (role === 'backup' && ns?.bakStage !== 'on') {
      // Yedek hat yok / kapatıldı: durum sessizce sıfırlanır (olay yok), hat çözülmez
      states.backup = initialLineState(); views.backup = null;
      return;
    }
    const fo = ns?.bakStage === 'on' ? readFailoverStatus() : null;
    const line = (await currentLines(ns, fo, role)).find(l => l.role === role);
    if (!line) {
      states[role] = initialLineState(); views[role] = null;
      return;
    }
    const now = Date.now();
    const present = !!line.dev && fs.existsSync(`/sys/class/net/${line.dev}`);
    const hasRoute = present && await hasDefaultRoute(line.dev);
    const measure = role === 'primary' || settings.measureBackup;
    const probe = present && hasRoute && measure ? await probeLine(line.dev) : null;
    if (!running || gen !== runGen) return; // ölçüm sürerken kapatıldı (ya da kapatılıp yeniden açıldı)
    // İzleyicinin durumu ölçümden sonra yeniden okunur (sonda ≈10 sn sürebilir): karar en güncel geçiş durumundan
    const foNow = fo ? readFailoverStatus() : null;
    const tNow = Date.now() / 1000;
    const watcher: WatcherView | null = foNow && foNow.checked > 0 && Math.abs(tNow - foNow.checked) <= WATCHER_FRESH_S
      ? { active: foNow.active, primaryOk: foNow.primaryOk, backupOk: foNow.backupOk, forced: foNow.forceUntil > tNow } : null;
    const j = judge({ role, dev: line.dev, present, hasRoute, probe, watcher });
    let sample: Sample | null = null;
    if (probe) {
      const s = probe.stats;
      sample = { at: now, role, dev: line.dev, target: probe.target, sent: s.sent, recv: s.recv,
        lossPct: s.recv === 0 && probe.tcp === true ? null : s.lossPct,
        rttAvg: s.rttAvg, rttMin: s.rttMin, rttMax: s.rttMax, jitter: s.jitter, tcp: probe.tcp };
      pending.push(sample);
      recent[role] = [...recent[role], sample].slice(-RECENT_MAX);
    }
    const { next, change } = advance(states[role], j.verdict, now);
    states[role] = next;
    views[role] = {
      role, dev: line.dev, kind: line.kind, state: next.state, since: next.since, verdict: j.verdict, reason: j.reason,
      checkedAt: now, present, hasRoute, measured: !!probe, watcher: !!watcher, last: sample || views[role]?.last || null,
    };
    if (change) {
      saveStateFile();
      await writeLineEvent(lineEventMessage(role, change, line.dev, j.reason), change.to === 'down' ? 'warning' : 'info');
    }
  } catch (e: any) {
    console.error(`[wan-monitor] ${role}:`, e?.message || e);
  } finally {
    busy[role] = false;
  }
}

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await dbRun(`CREATE TABLE IF NOT EXISTS wan_samples (
        ts INTEGER NOT NULL, role TEXT NOT NULL, dev TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '',
        sent INTEGER NOT NULL DEFAULT 0, recv INTEGER NOT NULL DEFAULT 0,
        rtt_avg REAL, rtt_min REAL, rtt_max REAL, jitter REAL, tcp INTEGER
      )`);
      await dbRun('CREATE INDEX IF NOT EXISTS idx_wan_samples_ts ON wan_samples(ts)');
    })().catch(e => { tableReady = null; throw e; });
  }
  return tableReady;
}
const SAMPLE_COLS = ['ts', 'role', 'dev', 'target', 'sent', 'recv', 'rtt_avg', 'rtt_min', 'rtt_max', 'jitter', 'tcp'];
const sampleRow = (s: Sample) => [s.at, s.role, s.dev, s.target, s.sent, s.recv, s.rttAvg, s.rttMin, s.rttMax, s.jitter,
  s.tcp === null ? null : s.tcp ? 1 : 0];

// Toplu yazım + saklama temizliği. Açık işlem (BEGIN) yok: panelde başka akışlar da işlem açıyor (trafficHistory.ts ile aynı
// gerekçe); her parça tek ifadedir.
let flushing: Promise<void> | null = null;
export function flushSamples(): Promise<void> {
  if (!flushing) {
    flushing = (async () => {
      const rows = pending;
      pending = [];
      if (!rows.length && !running) return; // kapalıyken tablo kurulmaz, temizlik yapılmaz
      try {
        await ensureTable();
        for (let i = 0; i < rows.length; i += 150) {
          const chunk = rows.slice(i, i + 150);
          await dbRun(`INSERT INTO wan_samples (${SAMPLE_COLS.join(', ')}) VALUES ${chunk.map(() => `(${SAMPLE_COLS.map(() => '?').join(', ')})`).join(', ')}`,
            chunk.flatMap(sampleRow));
        }
        const days = retentionDaysFor((await readPlatform().catch(() => null))?.profile);
        await dbRun('DELETE FROM wan_samples WHERE ts < ?', [Date.now() - days * DAY_MS]);
      } catch (e: any) {
        // Yazılamayanlar bir sonraki tura kalır (en çok bir saatlik birikim: bellek sınırı)
        pending = [...rows, ...pending].slice(-720);
        console.error('[wan-monitor] kayıt yazılamadı:', e?.message || e);
      }
    })().finally(() => { flushing = null; });
  }
  return flushing;
}

function clearTimers(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
function schedule(): void {
  clearTimers();
  timers.push(setInterval(() => { void round('primary'); }, settings.intervalS * 1000));
  timers.push(setInterval(() => { void round('backup'); }, settings.backupIntervalS * 1000));
  timers.push(setInterval(() => {
    if (!running) return;
    saveStateFile();
    void flushSamples();
  }, FLUSH_MS));
}

// Eşzamanlı: açılış ile kapatma isteği arasında bekleme (await) yok — kapatılan izleme zamanlayıcı bırakmaz.
function startRunning(fromBoot: boolean): void {
  if (running) { schedule(); return; } // aralık değişti: durum korunur
  running = true;
  runGen++;
  if (fromBoot) restoreStates();
  schedule();
  // İlk ölçüm hemen (aralık beklenmez)
  void round('primary');
  void round('backup');
}
async function stopRunning(): Promise<void> {
  if (!running) return;
  running = false;
  clearTimers();
  states = { primary: initialLineState(), backup: initialLineState() };
  views = { primary: null, backup: null };
  recent = { primary: [], backup: [] };
  probeMemo.clear();
  removeStateFile();
  if (pending.length) await flushSamples(); // ölçüm yoksa tablo da kurulmaz
}

// Açılış ('!isSatellite' bloğu): ayar kapalıysa hiçbir şey yapmaz — zamanlayıcı, ping, tablo yok.
export function startWanMonitor(): void {
  if (!isLinux) return;
  const gen = settingsGen;
  void (async () => {
    const s = await readSettings();
    if (gen !== settingsGen) return; // okuma sürerken ayar uçtan kaydedildi: o uygulandı
    settings = s;
    if (s.enabled) startRunning(true);
  })().catch((e: any) => console.error('[wan-monitor] başlatılamadı:', e?.message || e));
}

export async function saveSettings(next: WanMonitorSettings): Promise<void> {
  settingsGen++;
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(next)]);
  settings = next;
  if (!isLinux) return;
  if (next.enabled) startRunning(false);
  else await stopRunning();
}

// Panel kapanırken (index.ts SIGTERM / SIGINT): hat durumu kaydedilir, bekleyen örnekler yazılır. İzleme kapalıyken null —
// çağıran beklemeden çıkar (davranış aynı).
export function shutdownWanMonitor(): Promise<void> | null {
  if (!running) return null;
  saveStateFile();
  return pending.length ? flushSamples() : Promise.resolve();
}

// ─── Okuma (API) ───

const noTable = (e: any) => (/no such table/i.test(String(e?.message || e)) ? [] : Promise.reject(e));
interface Agg { samples: number; lossPct: number | null; rttAvg: number | null; jitter: number | null; rttMax: number | null; tcpOnly: number }
const round1 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
function aggOf(r: { n: number; s: number; r: number; rs: number; rn: number; js: number; jn: number; mx: number | null; t: number }): Agg | null {
  if (!r.n) return null;
  return {
    samples: r.n, lossPct: r.s > 0 ? round1(((r.s - r.r) / r.s) * 100) : null, rttAvg: r.rn ? round1(r.rs / r.rn) : null,
    jitter: r.jn ? round1(r.js / r.jn) : null, rttMax: round1(r.mx), tcpOnly: r.t,
  };
}
type RawAgg = { n: number; s: number; r: number; rs: number; rn: number; js: number; jn: number; mx: number | null; t: number };
const emptyRaw = (): RawAgg => ({ n: 0, s: 0, r: 0, rs: 0, rn: 0, js: 0, jn: 0, mx: null, t: 0 });
// ICMP yanıtlanmayan ama TCP 443 açık örnek (çalışan hat) kayba sayılmaz: AGG_SQL ile aynı koşul.
function addSample(a: RawAgg, s: Sample): void {
  a.n++;
  if (!(s.tcp === true && s.recv === 0)) { a.s += s.sent; a.r += s.recv; }
  if (s.rttAvg !== null) { a.rs += s.rttAvg; a.rn++; }
  if (s.jitter !== null) { a.js += s.jitter; a.jn++; }
  if (s.rttMax !== null) a.mx = a.mx === null ? s.rttMax : Math.max(a.mx, s.rttMax);
  if (s.tcp === true) a.t++;
}
const AGG_SQL = `COUNT(*) AS n, SUM(CASE WHEN tcp = 1 AND recv = 0 THEN 0 ELSE sent END) AS s, SUM(recv) AS r,
  SUM(rtt_avg) AS rs, COUNT(rtt_avg) AS rn, SUM(jitter) AS js,
  COUNT(jitter) AS jn, MAX(rtt_max) AS mx, SUM(CASE WHEN tcp = 1 THEN 1 ELSE 0 END) AS t`;
const rawOf = (row: any): RawAgg => ({ n: Number(row.n) || 0, s: Number(row.s) || 0, r: Number(row.r) || 0, rs: Number(row.rs) || 0,
  rn: Number(row.rn) || 0, js: Number(row.js) || 0, jn: Number(row.jn) || 0, mx: row.mx === null || row.mx === undefined ? null : Number(row.mx),
  t: Number(row.t) || 0 });

async function summary(sinceMs: number): Promise<Record<LineRole, Agg | null>> {
  const rows = await dbAll(`SELECT role, ${AGG_SQL} FROM wan_samples WHERE ts >= ? GROUP BY role`, [sinceMs]).catch(noTable);
  const acc: Record<LineRole, RawAgg> = { primary: emptyRaw(), backup: emptyRaw() };
  for (const r of rows as any[]) if (r.role === 'primary' || r.role === 'backup') acc[r.role as LineRole] = rawOf(r);
  for (const s of pending) if (s.at >= sinceMs) addSample(acc[s.role], s);
  return { primary: aggOf(acc.primary), backup: aggOf(acc.backup) };
}

async function outages(sinceMs: number): Promise<Outage[]> {
  const since = new Date(sinceMs).toISOString().slice(0, 19).replace('T', ' ');
  // En yeni 400 olay (eskiden yeniye çevrilerek eşlenir)
  const rows = (await dbAll(`SELECT message, created_at FROM alerts WHERE type = 'event' AND source = ? AND created_at >= ?
    ORDER BY id DESC LIMIT 400`, [EVENT_SOURCE, since])).reverse();
  return pairOutages(rows as any[], { primary: states.primary.state === 'down', backup: states.backup.state === 'down' }).slice(0, 50);
}

export async function wanMonitorStatus(): Promise<Record<string, unknown>> {
  const now = Date.now();
  let lines: LineView[] = [];
  if (running) {
    lines = ROLES.map(r => views[r]).filter((v): v is LineView => !!v);
  } else if (isLinux) {
    // Kapalıyken: ölçülecek hatlar (salt okuma — ping yok)
    const ns = readNetModeState();
    lines = (await currentLines(ns, ns?.bakStage === 'on' ? readFailoverStatus() : null)).map((l): LineView => ({
      ...l, state: 'unknown', since: 0, verdict: 'skip', reason: '', checkedAt: 0, present: !!l.dev && fs.existsSync(`/sys/class/net/${l.dev}`),
      hasRoute: false, measured: false, watcher: false, last: null,
    }));
  }
  const [h24, d7, list] = await Promise.all([summary(now - DAY_MS), summary(now - 7 * DAY_MS), outages(now - 7 * DAY_MS)]);
  return {
    supported: isLinux, settings, running, now, lines,
    recent: { primary: recent.primary.slice(-20), backup: recent.backup.slice(-20) },
    summary: { h24, d7 }, outages: list,
    limits: { intervalMin: INTERVAL_MIN_S, intervalMax: INTERVAL_MAX_S, bytesPerSample: PING_COUNT * 2 * 84 },
  };
}

// Grafik: en çok ~240 nokta (kova = pencere / 240, en az 1 dk). Henüz yazılmamış örnekler de katılır.
export async function wanMonitorHistory(hours: number): Promise<Record<string, unknown>> {
  const now = Date.now();
  const sinceMs = now - hours * 3600000;
  const bucketMs = Math.max(60000, Math.ceil((hours * 3600000) / 240 / 60000) * 60000);
  const rows = await dbAll(`SELECT role, (ts / ${bucketMs}) * ${bucketMs} AS b, ${AGG_SQL} FROM wan_samples WHERE ts >= ?
    GROUP BY role, b ORDER BY b`, [sinceMs]).catch(noTable);
  const acc = new Map<string, { role: LineRole; t: number; a: RawAgg }>();
  for (const r of rows as any[]) {
    if (r.role !== 'primary' && r.role !== 'backup') continue;
    acc.set(`${r.role}|${r.b}`, { role: r.role, t: Number(r.b), a: rawOf(r) });
  }
  for (const s of pending) {
    if (s.at < sinceMs) continue;
    const t = Math.floor(s.at / bucketMs) * bucketMs;
    const k = `${s.role}|${t}`;
    if (!acc.has(k)) acc.set(k, { role: s.role, t, a: emptyRaw() });
    addSample(acc.get(k)!.a, s);
  }
  const points = [...acc.values()].sort((x, y) => x.t - y.t).map(p => ({ t: p.t, role: p.role, ...aggOf(p.a)! }));
  return { hours, bucketMs, now, points };
}

// ─── Uçlar (index.ts: '/api/wan-monitor' netAdminGuard önek listesinde; uydu kapısı + writeLimiter index.ts'te) ───

export function registerWanMonitorRoutes(app: express.Express): void {
  app.get('/api/wan-monitor', async (_req, res) => {
    try {
      res.json(await wanMonitorStatus());
    } catch (e: any) {
      res.status(500).json({ error: `Hat izleme durumu okunamadı: ${e?.message || e}` });
    }
  });
  app.get('/api/wan-monitor/history', async (req, res) => {
    const hours = req.query.hours === undefined ? 24 : Number(req.query.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return res.status(400).json({ error: 'Süre 1–168 saat arasında olmalı' });
    try {
      res.json(await wanMonitorHistory(hours));
    } catch (e: any) {
      res.status(500).json({ error: `Hat geçmişi okunamadı: ${e?.message || e}` });
    }
  });
  app.put('/api/wan-monitor/settings', async (req, res) => {
    const v = validateSettingsPatch(req.body, await readSettings());
    if ('error' in v) return res.status(400).json({ error: v.error });
    try {
      await saveSettings(v.settings);
      res.json({ success: true, settings: v.settings, running });
    } catch (e: any) {
      res.status(500).json({ error: `Ayar kaydedilemedi: ${e?.message || e}` });
    }
  });
}

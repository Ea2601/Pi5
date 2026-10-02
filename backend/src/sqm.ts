// Hat düzeyi akıllı kuyruk (G1.1-A, SQM: CAKE) — Bant Genişliği → Gecikme (Akıllı Kuyruk). İndirme / yükleme hattı
// doyurduğunda gecikmenin fırlamasını (bufferbloat) önler: kuyruk modemde / operatörde değil Pi'de, hattın ölçülen hızının
// biraz altında oluşur; CAKE paketleri cihazlar arasında adil paylaştırır (dual-srchost / dual-dsthost + nat: cihaz başı
// adalet). qos.ts'in (cihaz başı nft hız sınırı + kota) YERİNE DEĞİL, üstüne ayrı katman: qos.ts değişmez.
//  - Yalnız A aşaması: ayrı internet kartı kipleri (WAN router DHCP / sabit / PPPoE / VLAN / tek port VLAN, R4 A Wi-Fi WAN) ve
//    R4 C aynı ağ köprüsü (üst Wi-Fi; Pi NAT yapmadığından 'nat' anahtarı yok). Tek bacak (modem ile ev ağı aynı kartta) ve
//    ev Wi-Fi köprüsü br0 G1.1-B, yedek hat kuyruğu G1.1-C: kod yolu reddeder (resolveSqmLine), arayüz "yakında" der. Tek
//    portta kuyruk ASLA ev ağı kartına takılmaz — yalnız wan.<VLAN> / pppwan'a.
//  - VARSAYILAN KAPALI: app_settings 'sqm_config' (JSON) yalnız /api/bandwidth/sqm uçlarından, doğrulamayla yazılır (genel PUT
//    /api/settings kabul etmez; yedekten geri gelmez — index.ts BACKUP_SKIP_SETTINGS: hatta özgü bant başka bir cihaza /
//    hatta geri yüklenip hattı kısmasın). Ayar yokken modül hiçbir tc / ip komutu çalıştırmaz (okuma dahil); kapalıyken
//    (enabled=false) da çalıştırmaz — yalnız kapatırken bir kez kendi kaynaklarını kaldırır.
//  - Kaynaklar (plan 0.5): hat arayüzünün kök qdisc'i ca1e:, IFB ifb-klx0 (kökü ca1f:), giriş (ingress ffff:) süzgeci pref
//    4910. Kaldırma tek uygulamadır: scripts/sqm.sh clear (yalnız bunlar; başka qdisc'e dokunmaz). Giriş kuyruğunu yalnız biz
//    eklediysek kaldırır (sahiplik: /run/pi5-sqm/ingress-owned). IFB modülü numifbs=0 ile yüklenir (ifb0 / ifb1 kurulmaz).
//  - Öncelik sınıfı yok: CAKE 'besteffort' (varsayılanı diffserv3, DSCP'ye göre kova — uzak sunucunun / operatörün koyduğu
//    işaretle bir cihaz Bulk kovasına düşüp adaletin dışında kalırdı). DSCP sınıfları G5.8 ile bilinçli gelir.
//  - Komutlar argv listesi (buildSqmPlan, saf), execFile ile — kabuk yok; arayüz adı ve kbit sıkı doğrulanır. Sıra önemli:
//    IFB ve kökündeki CAKE hazır olmadan giriş yönlendirmesi kurulmaz (yönlendirilen paket düşerdi).
//  - Uzlaştırma 15 sn'de bir (yalnız açıkken; kendi sıralı kuyruğunda): tc -j ile kind + handle (+ bant) karşılaştırılır,
//    yalnız sapmada yeniden kurulur (PPPoE yeniden arandı, NetworkManager kartı yeniden kurdu, IFB silindi). Hat imzası
//    (sig) kayıtlı ayarınkinden farklıysa kuyruk TAKILMAZ (yanlış bantla hat kısılmasın) ve bir kez uyarı olayı yazılır.
//  - Açma ve bant değişikliği her zaman 5 dk'lık denemedir: geri alma zamanlayıcısı (systemd-run pi5-sqm-rollback →
//    sqm.sh clear) değişiklikten ÖNCE kurulur, backend çökse de çalışır; "Kalıcı yap" Pi'nin kendi ekranından (loopback)
//    kabul edilmez. Süre dolunca backend de ayarı kapatır (enabled=false) — açılışta süresi geçmiş deneme kapatılır.
//    Zamanlayıcı (monoton saat) belirleyicidir: deneme sürerken zamanlayıcı yoksa (çalıştı, Pi yeniden başladı) deneme bitmiş
//    sayılır — duvar saati geri gitse de (NTP) kuyruk zamanlayıcısız yeniden takılmaz, "Kalıcı yap" kabul edilmez.
//  - SSH kurtarması: sqm.sh off kuyruğu hemen kaldırır ve /etc/pi5-gateway/sqm.off bırakır; backend onu görünce ayarı kapatır
//    (açıkken 15 sn içinde, durmuşsa açılışta) — uzlaştırma kuyruğu geri takmaz.
//  - Hız testi: kuyruk takılıyken ölçüm kısılmış hattan geçer → speed_tests.shaped=1 (index.ts measureAndStore,
//    sqmShaping). Otomatik ölçüm kuyruğu kaldırmaz; yalnız kalibrasyon (sihirbazın "Ölç"ü) ölçüm boyunca kaldırır ve
//    kısılmamış (shaped=0) kayıt yazar — her turda biraz daha düşen geri besleme döngüsü olmaz.
//  - Uydu rolünde çalışmaz: rol uyduya çevrilirken ve açılışta uyduysa kendi kaynakları kaldırılır, ayar kapatılır.
//  - HA (G4.3): iki düğümde — sqm_config eşitlenir, her düğüm kendi hattına uygular (bu sürümde HA yok).
//  - İleriye not (G5.8 öncelik kancası, bu sürümde YOK): fwmark gerekirse yalnız 0x000E0000–0x1FF00000 aralığından.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type express from 'express';
import { dbGet, dbRun } from './db';
import { recordEvent, recordEventOnce } from './events';
import { isLinux, readNetModeState, wanActive, sameNetActive, readFailoverStatus, HOME_BRIDGE, type NetModeState } from './system';
import { isSatellite } from './role';
import { readPlatform, hasModule, onPath, ifaceBus, SQM_MODULES } from './hardware';
import { fmtMbps } from './qos';
import { SpeedtestUnavailable, type SpeedResult } from './speedtest';

const execFileP = promisify(execFile);

export const ROOT_HANDLE = 'ca1e:';
export const IFB_HANDLE = 'ca1f:';
export const FILTER_PREF = '4910';
export const IFB_DEV = 'ifb-klx0';
export const SETTINGS_KEY = 'sqm_config';
export const TRIAL_S = 300;
export const MIN_KBIT = 64;
export const MAX_KBIT = 10_000_000;
export const ROLLBACK_UNIT = 'pi5-sqm-rollback';
// Giriş kuyruğu sahipliği (sqm.sh ile aynı yol): kurulum giriş kuyruğunu kendisi eklediği arayüzün adını yazar; sqm.sh clear
// giriş kuyruğunu yalnız bu arayüzlerde siler. /run tmpfs: tc durumuyla aynı ömür.
export const RUN_DIR = '/run/pi5-sqm';
export const INGRESS_OWNED = `${RUN_DIR}/ingress-owned`;
// sqm.sh off'un bıraktığı işaret (yalnız varlığı önemli): görülünce ayar kapatılır, işaret silinir.
export const OFF_FLAG = '/etc/pi5-gateway/sqm.off';
const TICK_MS = 15000;
const SQM_SCRIPT = path.resolve(__dirname, '../../scripts/sqm.sh');
const IFNAME = /^[A-Za-z0-9_.-]{1,15}$/;
const SIG_RE = /^[A-Za-z0-9_.:|#-]{1,160}$/;

// ─── Ayar ───

// Bağlantı türü → CAKE ek yük (overhead) hesabı (tc-cake(8)): ethernet = overhead 38 mpu 84 noatm, docsis = overhead 18
// mpu 64 noatm, bridged-ptm (VDSL2) = overhead 22 ptm, bridged-llcsnap (ADSL) = overhead 32 atm; raw = hesap yok. Üstüne
// VLAN etiketi +4 (ether-vlan) ve PPPoE başlığı +8 (pppoe-ptm 30 = 22 + 8, pppoe-llcsnap 40 = 32 + 8) eklenir. CAKE ek yükü
// ağ katmanı (IP) boyuna ekler: kuyruk pppwan'da da kartta da aynı sonucu verir.
export type SqmOverhead = 'ethernet' | 'docsis' | 'vdsl' | 'adsl' | 'raw';
export const OVERHEADS: readonly SqmOverhead[] = ['ethernet', 'docsis', 'vdsl', 'adsl', 'raw'];
const MEDIUM: Record<Exclude<SqmOverhead, 'raw'>, { base: number; mpu: number; mode: 'noatm' | 'ptm' | 'atm' }> = {
  ethernet: { base: 38, mpu: 84, mode: 'noatm' },
  docsis: { base: 18, mpu: 64, mode: 'noatm' },
  vdsl: { base: 22, mpu: 0, mode: 'ptm' },
  adsl: { base: 32, mpu: 0, mode: 'atm' },
};

export interface SqmLineSettings { sig: string; downKbit: number; upKbit: number; overhead: SqmOverhead; savedAt: number }
// enabled: kuyruk açık (deneme ya da kalıcı); trialUntil: deneme bitişi (unix sn; 0 = kalıcı). primary: ana hat ayarı ve
// ölçüldüğü hattın imzası (yedek hat G1.1-C'de ayrı anahtarla gelir).
export interface SqmConfig { enabled: boolean; trialUntil: number; primary: SqmLineSettings | null }

const kbitOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= MIN_KBIT && (v as number) <= MAX_KBIT;
const isOverhead = (v: unknown): v is SqmOverhead => typeof v === 'string' && (OVERHEADS as readonly string[]).includes(v);

// Kayıtlı değer → ayar (bozuk alan atılır; geçerli hat ayarı yoksa kuyruk açık sayılmaz). Kayıt hiç yoksa null.
export function normalizeConfig(raw: unknown): SqmConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const p = o.primary && typeof o.primary === 'object' && !Array.isArray(o.primary) ? o.primary as Record<string, unknown> : null;
  const primary: SqmLineSettings | null = p && typeof p.sig === 'string' && SIG_RE.test(p.sig) && kbitOk(p.downKbit) && kbitOk(p.upKbit)
    && isOverhead(p.overhead)
    ? { sig: p.sig, downKbit: p.downKbit, upKbit: p.upKbit, overhead: p.overhead, savedAt: Number.isInteger(p.savedAt) ? p.savedAt as number : 0 }
    : null;
  const enabled = o.enabled === true && !!primary;
  const trialUntil = enabled && Number.isInteger(o.trialUntil) && (o.trialUntil as number) > 0 ? o.trialUntil as number : 0;
  return { enabled, trialUntil, primary };
}

// PUT gövdesi: bant (kbit/sn, 64 kbit – 10 Gbit, tam sayı) ve bağlantı türü; üçü de zorunlu, bilinmeyen alan reddedilir.
const LINE_FIELDS = ['downKbit', 'upKbit', 'overhead'];
export function validateLinePatch(body: unknown): { line: Pick<SqmLineSettings, 'downKbit' | 'upKbit' | 'overhead'> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Ayar nesnesi gerekli' };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter(k => !LINE_FIELDS.includes(k));
  if (extra.length) return { error: `Bilinmeyen ayar: ${extra.join(', ')}` };
  for (const [k, label] of [['downKbit', 'İndirme bandı'], ['upKbit', 'Yükleme bandı']] as const) {
    if (!kbitOk(b[k])) return { error: `${label} ${MIN_KBIT} kbit/sn – ${MAX_KBIT / 1e6} Gbit/sn arasında tam sayı (kbit/sn) olmalı` };
  }
  if (!isOverhead(b.overhead)) return { error: `Bağlantı türü şunlardan biri olmalı: ${OVERHEADS.join(', ')}` };
  return { line: { downKbit: b.downKbit as number, upKbit: b.upKbit as number, overhead: b.overhead } };
}

export async function readConfig(): Promise<SqmConfig | null> {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY]) as { value?: string } | undefined;
  if (!row?.value) return null;
  try { return normalizeConfig(JSON.parse(String(row.value))) || { enabled: false, trialUntil: 0, primary: null }; } catch {
    return { enabled: false, trialUntil: 0, primary: null }; // bozuk kayıt: kapalı say (kaldırma yine yapılabilsin)
  }
}
async function writeConfig(c: SqmConfig): Promise<void> {
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(c)]);
}

// ─── Hat çözümü (saf) ───

export type SqmLineKind = 'wan' | 'vlan' | 'pppoe' | 'wifi' | 'samenet';
export interface SqmLine {
  dev: string; kind: SqmLineKind; label: string; sig: string;
  nat: boolean; vlan: boolean; pppoe: boolean;
  port: string; // fiziksel kart (USB 2 uyarısı) — tek portta ev ağı kartı, yalnız bilgi
}
// Neden kodu: ok | satellite (uydu) | onearm (tek bacak, G1.1-B) | bridge (ev Wi-Fi köprüsü br0, G1.1-B) | wan-trial (internet
// kartı denemesi) | rep-trial (Wi-Fi köprüsü denemesi) | invalid (arayüz ev ağıyla aynı / geçersiz)
export type SqmLineCode = 'ok' | 'satellite' | 'onearm' | 'bridge' | 'wan-trial' | 'rep-trial' | 'invalid';
export type SqmLineResult = { code: 'ok'; line: SqmLine; reason: '' } | { code: Exclude<SqmLineCode, 'ok'>; line: null; reason: string };

const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
// wanActive tür daraltıcıdır (false dalında ns'yi null'a daraltır): burada yalın boole.
const wanCardOn = (s: NetModeState): boolean => wanActive(s);

export function resolveSqmLine(ns: NetModeState | null, satellite: boolean): SqmLineResult {
  if (satellite) return { code: 'satellite', line: null, reason: 'Bu cihaz uydu — akıllı kuyruk ana cihazdadır' };
  // Ev ağının arayüzleri: kuyruk bunlara asla takılmaz (tek portta kart ev ağıdır; br0 ev Wi-Fi köprüsü).
  const lanDevs = new Set([ns?.iface, ns?.lanIf, ns?.homeIface, ns?.repLan, ns?.apIface, HOME_BRIDGE].filter((x): x is string => !!x));
  const invalid = (dev: string): SqmLineResult => ({
    code: 'invalid', line: null,
    reason: dev ? `İnternet arayüzü (${dev}) ev ağı arayüzüyle aynı görünüyor — kuyruk ev ağına takılmaz` : 'İnternet arayüzü okunamadı',
  });
  if (ns && wanCardOn(ns)) {
    if (ns.wanStage !== 'on' || !ns.wanLan) {
      return { code: 'wan-trial', line: null, reason: "İnternet kartı denemesi sürüyor — WAN router panelinde 'Kalıcı yap'tan sonra açılabilir" };
    }
    const dev = ns.wanDev;
    if (!IFNAME.test(dev) || lanDevs.has(dev)) return invalid(dev);
    const pppoe = ns.wanType === 'pppoe', vlan = !!ns.wanVlan;
    const typeText = pppoe ? 'PPPoE' : ns.wanType === 'static' ? 'sabit adres' : 'DHCP';
    const label = ns.wanSingle ? `Tek port ${ns.wanPort}, VLAN ${ns.wanVlan} (${typeText}) → ${dev}`
      : ns.wanSsid ? `Wi-Fi ile internet: ${ns.wanPort} (${typeText})${dev !== ns.wanPort ? ` → ${dev}` : ''}`
        : `İnternet kartı ${ns.wanPort}${vlan ? `, VLAN ${ns.wanVlan}` : ''} (${typeText})${dev !== ns.wanPort ? ` → ${dev}` : ''}`;
    const sig = ['wan', ns.wanPort, dev, ns.wanType || '-', ns.wanVlan || '-', ns.wanSingle ? 'single' : 'card',
      ns.wanSsid ? `wifi#${shortHash(ns.wanSsid)}` : 'eth'].join('|');
    return {
      code: 'ok', reason: '',
      line: { dev, kind: pppoe ? 'pppoe' : vlan ? 'vlan' : ns.wanSsid ? 'wifi' : 'wan', label, sig, nat: true, vlan, pppoe, port: ns.wanPort },
    };
  }
  if (ns && sameNetActive(ns)) {
    const dev = ns.repPort;
    if (!IFNAME.test(dev) || dev === ns.repLan || dev === HOME_BRIDGE) return invalid(dev);
    return {
      code: 'ok', reason: '',
      line: {
        dev, kind: 'samenet', label: `Wi-Fi köprüsü (aynı ağ): üst Wi-Fi ${dev}`, nat: false, vlan: false, pppoe: false, port: dev,
        sig: ['samenet', dev, ns.repSsid ? `wifi#${shortHash(ns.repSsid)}` : '-'].join('|'),
      },
    };
  }
  if (ns && ns.repStage === 'trial') {
    return { code: 'rep-trial', line: null, reason: "Wi-Fi köprüsü denemesi sürüyor — 'Kalıcı yap'tan sonra açılabilir" };
  }
  if (ns && ns.homeStage !== 'none') {
    return { code: 'bridge', line: null, reason: "Ev Wi-Fi köprüsünde (br0, tek bacak) yakında — G1.1-B. Şimdilik yalnız ayrı internet kartıyla ya da Wi-Fi köprüsüyle (aynı ağ)" };
  }
  return {
    code: 'onearm', line: null,
    reason: 'Tek bacaklı kurulumda yakında — G1.1-B (modem ile ev ağı aynı kartta: kuyruk modemin trafiğini ayırarak takılacak). Şimdilik yalnız ayrı internet kartıyla (WAN router) ya da Wi-Fi köprüsüyle (aynı ağ)',
  };
}

// Ek yük argümanları ve toplam bayt (arayüzde gösterilir; raw: null).
export function overheadArgs(o: SqmOverhead, line: Pick<SqmLine, 'vlan' | 'pppoe'>): { args: string[]; bytes: number | null } {
  if (o === 'raw') return { args: ['raw'], bytes: null };
  const m = MEDIUM[o];
  const bytes = m.base + (line.vlan ? 4 : 0) + (line.pppoe ? 8 : 0);
  return { args: ['overhead', String(bytes), ...(m.mpu ? ['mpu', String(m.mpu)] : []), m.mode], bytes };
}

// Beklenen verim: hız testinin (Ookla) ölçtüğü TCP verisi / CAKE'in aynı paket için saydığı bayt. Tam boy pakette veri
// MTU − 52 (IPv4 20 + TCP 20 + zaman damgası 12; PPPoE'de MTU 1492); CAKE IP boyuna ek yükü ekler, en az mpu sayar, ATM'de
// 48 baytlık hücre başına 53, PTM'de 64 bayt başına +1 sayar (sch_cake.c cake_calc_overhead). Ethernet'te 1448/1538 ≈ 0,941,
// ADSL'de 1448/1696 ≈ 0,854. Öneri ve "Kuyrukla hız testi" karşılaştırması bununla düzeltilir; raw: 1 (hesap yok).
export function lineEfficiency(o: SqmOverhead, line: Pick<SqmLine, 'vlan' | 'pppoe'>): number {
  if (o === 'raw') return 1;
  const m = MEDIUM[o];
  const mtu = line.pppoe ? 1492 : 1500;
  let len = Math.max(mtu + (overheadArgs(o, line).bytes as number), m.mpu);
  if (m.mode === 'atm') len = Math.ceil(len / 48) * 53;
  else if (m.mode === 'ptm') len += Math.ceil(len / 64);
  return Math.round(((mtu - 52) / len) * 1000) / 1000;
}

// ─── Plan (saf) ───

// unless: adım koşullu — 'ifbmod' ifb modülü zaten yüklüyse (/sys/module/ifb), 'ifb' IFB arayüzü zaten varsa, 'ingress'
// arayüzde giriş kuyruğu zaten varsa atlanır (başkasınınki yeniden kullanılır, sahiplenilmez). optional: düşerse kurulum
// sürer (yalnız günlüğe yazılır).
export interface SqmStep { argv: string[]; unless?: 'ifbmod' | 'ifb' | 'ingress'; optional?: boolean }
export interface SqmPlanEnv { satellite: boolean; ns: NetModeState | null; lite: boolean }
export type SqmPlanCode = SqmLineCode | 'off' | 'mismatch';
export interface SqmPlan { steps: SqmStep[]; line: SqmLine | null; code: SqmPlanCode; reason: string }

// Ayar + hat → kurulum komutları. Ayar yok / kapalı / hat desteklenmiyor / hat imzası değişti → boş liste (hiçbir şey
// takılmaz = bugünkü davranış). Kurulum her zaman kendi kaynaklarımız temizlendikten sonra çalışır (applyPlan).
export function buildSqmPlan(env: SqmPlanEnv, cfg: SqmConfig | null): SqmPlan {
  const r = resolveSqmLine(env.ns, env.satellite);
  if (r.code !== 'ok') return { steps: [], line: null, code: r.code, reason: r.reason };
  const line = r.line;
  if (!cfg || !cfg.enabled || !cfg.primary) return { steps: [], line, code: 'off', reason: 'Akıllı kuyruk kapalı' };
  const p = cfg.primary;
  if (p.sig !== line.sig) {
    return { steps: [], line, code: 'mismatch', reason: 'İnternet hattı bant ölçüldüğünden beri değişti — bandı yeniden ölçüp kaydedin' };
  }
  if (!kbitOk(p.downKbit) || !kbitOk(p.upKbit) || !isOverhead(p.overhead) || !IFNAME.test(line.dev)) {
    return { steps: [], line, code: 'invalid', reason: 'Kayıtlı ayar geçersiz — bandı yeniden kaydedin' };
  }
  const D = line.dev;
  const oh = overheadArgs(p.overhead, line).args;
  const nat = line.nat ? ['nat'] : [];
  // Düşük bellekli (lite) profil: CAKE'in kuyruk belleği hıza göre büyür (1 Gbit'te ~50 MB) — 4 MB ile sınırlanır.
  const mem = env.lite ? ['memlimit', '4mb'] : [];
  return {
    line, code: 'ok', reason: '',
    steps: [
      // Yükleme: hat arayüzünün çıkışı
      { argv: ['tc', 'qdisc', 'replace', 'dev', D, 'root', 'handle', ROOT_HANDLE, 'cake', 'bandwidth', `${p.upKbit}kbit`, ...oh, 'besteffort', 'dual-srchost', ...nat, ...mem] },
      // İndirme: önce IFB ve kökündeki CAKE, en son giriş yönlendirmesi (IFB hazır olmadan yönlendirilen paket düşerdi).
      // Modül yüklü değilse numifbs=0 ile yüklenir: çekirdeğin varsayılanı (2) ifb0 / ifb1'i de kurar, kapatınca kalırlardı.
      { argv: ['modprobe', 'ifb', 'numifbs=0'], unless: 'ifbmod', optional: true },
      { argv: ['ip', 'link', 'add', IFB_DEV, 'type', 'ifb'], unless: 'ifb' },
      { argv: ['ip', 'link', 'set', IFB_DEV, 'up'] },
      { argv: ['tc', 'qdisc', 'replace', 'dev', IFB_DEV, 'root', 'handle', IFB_HANDLE, 'cake', 'bandwidth', `${p.downKbit}kbit`, ...oh, 'besteffort', 'dual-dsthost', ...nat, 'ingress', ...mem] },
      { argv: ['tc', 'qdisc', 'add', 'dev', D, 'handle', 'ffff:', 'ingress'], unless: 'ingress' },
      { argv: ['tc', 'filter', 'add', 'dev', D, 'parent', 'ffff:', 'pref', FILTER_PREF, 'matchall', 'action', 'mirred', 'egress', 'redirect', 'dev', IFB_DEV] },
    ],
  };
}

// ─── Canlı durum (tc -j) ───

const errText = (e: any) => String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).slice(-2).join(' ') || 'bilinmeyen hata';
const devExists = (d: string) => IFNAME.test(d) && fs.existsSync(`/sys/class/net/${d}`);
function devUp(d: string): boolean {
  try { return (parseInt(fs.readFileSync(`/sys/class/net/${d}/flags`, 'utf8').trim(), 16) & 1) === 1; } catch { return false; }
}
async function tcJson(args: string[]): Promise<any[]> {
  try {
    const { stdout } = await execFileP('tc', ['-j', ...args], { timeout: 5000 });
    const v = JSON.parse(String(stdout).trim() || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
type QdiscView = { kind: string; handle: string; bandwidth: number | null; diffserv?: string | null };
const rootOf = (qs: any[]): QdiscView | null => {
  const q = qs.find(x => x && x.root === true);
  if (!q) return null;
  const bw = q.options?.bandwidth, ds = q.options?.diffserv;
  return { kind: String(q.kind || ''), handle: String(q.handle || ''), bandwidth: typeof bw === 'number' ? bw : null, diffserv: typeof ds === 'string' ? ds : null };
};
export interface SqmLive { dev: string; devExists: boolean; root: QdiscView | null; ingress: boolean; filter: boolean; ifbUp: boolean; ifbRoot: QdiscView | null }
async function readLive(dev: string): Promise<SqmLive> {
  const exists = devExists(dev);
  const qs = exists ? await tcJson(['qdisc', 'show', 'dev', dev]) : [];
  const fl = exists && qs.some(q => q?.kind === 'ingress') ? await tcJson(['filter', 'show', 'dev', dev, 'parent', 'ffff:']) : [];
  const ifb = devExists(IFB_DEV);
  return {
    dev, devExists: exists, root: rootOf(qs), ingress: qs.some(q => q?.kind === 'ingress'),
    filter: fl.some(f => String(f?.pref) === FILTER_PREF && f?.kind === 'matchall'
      && (f.options?.actions || []).some((a: any) => a?.kind === 'mirred' && a?.to_dev === IFB_DEV)),
    ifbUp: ifb && devUp(IFB_DEV), ifbRoot: ifb ? rootOf(await tcJson(['qdisc', 'show', 'dev', IFB_DEV])) : null,
  };
}
// Bant ve öncelik kipi karşılaştırması (tc bant için bayt/sn bildirir; alan yoksa yalnız kind + handle).
const bwOk = (v: QdiscView, kbit: number) => (v.bandwidth === null || v.bandwidth === kbit * 125) && (!v.diffserv || v.diffserv === 'besteffort');
export function liveIntact(live: SqmLive, p: Pick<SqmLineSettings, 'downKbit' | 'upKbit'>): boolean {
  return live.devExists && !!live.root && live.root.kind === 'cake' && live.root.handle === ROOT_HANDLE && bwOk(live.root, p.upKbit)
    && live.ingress && live.filter && live.ifbUp
    && !!live.ifbRoot && live.ifbRoot.kind === 'cake' && live.ifbRoot.handle === IFB_HANDLE && bwOk(live.ifbRoot, p.downKbit);
}

// ─── Uygulama ───

let appliedDev: string | null = null;   // kuyruk takılı ve doğrulandı (sqmShaping)
let calibrating = false;
let lastError = '';
let lastAppliedAt = 0;
let blockKey = '';                      // açıkken takılamama nedeni (uyarı olayı durum değişince bir kez)

// Kuyruk şu an hattı kısıyor mu (index.ts measureAndStore → speed_tests.shaped). Kalibrasyon ölçümünde false; yedek hattayken
// de false (kuyruk ana hat arayüzünde: ölçüm yedek hattan, kuyruksuz geçer — G1.1-C'ye dek).
// (index.ts bakActive ile aynı denetim: durum dosyası yalnız yedek hat açıkken geçerli.)
const onBackupLine = (ns: NetModeState | null = readNetModeState()): boolean => ns?.bakStage === 'on' && readFailoverStatus()?.active === 'backup';
export const sqmShaping = (): boolean => !!appliedDev && !calibrating && !onBackupLine();

async function clearOwn(): Promise<void> {
  appliedDev = null;
  try {
    await execFileP('bash', [SQM_SCRIPT, 'clear'], { timeout: 30000 });
  } catch (e: any) {
    const warn = String(e?.stdout || '').split('\n').filter(l => l.startsWith('warning=')).map(l => l.slice(8));
    throw new Error(`kuyruk kaldırılamadı: ${warn.join('; ') || errText(e)}`);
  }
}
const ownPresent = () => devExists(IFB_DEV) || appliedDev !== null;

async function runStep(argv: string[]): Promise<void> {
  try { await execFileP(argv[0], argv.slice(1), { timeout: 10000 }); } catch (e: any) {
    throw new Error(`${argv.slice(0, 3).join(' ')} ${argv.includes('dev') ? argv[argv.indexOf('dev') + 1] : ''}: ${errText(e)}`.replace(/\s+:/, ':'));
  }
}
// Giriş kuyruğunu biz ekliyoruz: arayüz adı sahiplik dosyasına (eklemeden ÖNCE — eklenip yazılamazsa sqm.sh onu kaldırmazdı).
function markIngressOwned(dev: string): void {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o755 });
    const cur = fs.existsSync(INGRESS_OWNED) ? fs.readFileSync(INGRESS_OWNED, 'utf8').split('\n') : [];
    if (!cur.includes(dev)) fs.appendFileSync(INGRESS_OWNED, `${dev}\n`, { mode: 0o644 });
  } catch (e: any) {
    throw new Error(`giriş kuyruğu kaydı yazılamadı (${INGRESS_OWNED}): ${e?.message || e}`);
  }
}

// Kendi kaynaklarımız kaldırılır, plan sırayla kurulur; bir adım düşerse yarım kurulum kaldırılır (hiçbir şey takılı kalmaz).
async function install(plan: SqmPlan): Promise<void> {
  await clearOwn();
  try {
    for (const s of plan.steps) {
      if (s.unless === 'ifbmod' && fs.existsSync('/sys/module/ifb')) continue;
      if (s.unless === 'ifb' && devExists(IFB_DEV)) continue;
      if (s.unless === 'ingress') {
        if ((await tcJson(['qdisc', 'show', 'dev', s.argv[4]])).some(q => q?.kind === 'ingress')) continue;
        markIngressOwned(s.argv[4]);
      }
      try { await runStep(s.argv); } catch (e: any) {
        if (!s.optional) throw e;
        console.warn(`[sqm] ${e.message} — devam ediliyor`);
      }
    }
  } catch (e) {
    await clearOwn().catch(() => {});
    throw e;
  }
  appliedDev = plan.line!.dev;
  lastAppliedAt = Date.now();
}

async function planEnv(): Promise<SqmPlanEnv> {
  return { satellite: isSatellite(), ns: readNetModeState(), lite: (await readPlatform().catch(() => null))?.profile === 'lite' };
}

// Ayar ve işlemler sırayla (deneme, onay, kapatma, kalibrasyon ve 15 sn'lik uzlaştırma iç içe geçmesin).
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export class SqmError extends Error { constructor(public status: number, message: string) { super(message); } }
const nowS = () => Math.floor(Date.now() / 1000);

// sqm.sh off'un işareti var mıydı (varsa silinir — tek seferlik).
function takeOffFlag(): boolean {
  try { fs.unlinkSync(OFF_FLAG); return true; } catch { return false; }
}
// Yedek hattayken ölçüm ve deneme yapılmaz: Ookla varsayılan rotayı (yedek hattı) ölçer, sonuç ana hattın imzasıyla
// kaydedilip ana hat geri gelince onu yanlış bantla kısardı.
const BACKUP_MSG = 'Şu an yedek hattasınız — ölçüm ve deneme ana hatta dönünce yapılabilir';

// ─── Geri alma zamanlayıcısı (systemd-run: backend'den bağımsız) ───

async function stopRollback(): Promise<void> {
  const units = [`${ROLLBACK_UNIT}.timer`, `${ROLLBACK_UNIT}.service`];
  await execFileP('systemctl', ['stop', ...units], { timeout: 15000 }).catch(() => {});
  await execFileP('systemctl', ['reset-failed', ...units], { timeout: 15000 }).catch(() => {});
}
async function rollbackArmed(): Promise<boolean> {
  try { await execFileP('systemctl', ['is-active', '--quiet', `${ROLLBACK_UNIT}.timer`], { timeout: 5000 }); return true; } catch { return false; }
}
async function armRollback(seconds: number): Promise<void> {
  await stopRollback();
  try {
    await execFileP('systemd-run', ['--quiet', '--collect', `--unit=${ROLLBACK_UNIT}`, `--on-active=${Math.max(5, Math.round(seconds))}`,
      '--timer-property=AccuracySec=1s', '/bin/bash', SQM_SCRIPT, 'clear'], { timeout: 15000 });
  } catch (e: any) {
    throw new SqmError(500, `Geri alma zamanlayıcısı kurulamadı — kuyruk açılmadı: ${errText(e)}`);
  }
}

// ─── Uzlaştırma ───

let tickTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const onBgError = (e: any) => {
  lastError = e?.message || String(e);
  console.warn(`[sqm] ${lastError}`);
  void recordEventOnce('bandwidth', `Akıllı kuyruk uygulanamadı: ${lastError}`, 'warning', 360);
};
// Uzun bir işlem (kalibrasyon ~60 sn) sürerken turlar birikmesin: sırada bekleyen tur varken yenisi eklenmez.
let tickQueued = false;
function ensureTicking(on: boolean): void {
  if (on && !tickTimer) {
    tickTimer = setInterval(() => {
      if (tickQueued) return;
      tickQueued = true;
      void serial(() => { tickQueued = false; return reconcile(); }).catch(onBgError);
    }, TICK_MS);
  }
  if (!on && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
function clearExpiry(): void { if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; } }
function scheduleExpiry(until: number): void {
  clearExpiry();
  expiryTimer = setTimeout(() => { expiryTimer = null; void serial(() => reconcile()).catch(onBgError); }, Math.max(0, (until - 1) * 1000 - Date.now()) + 100);
}

// why: 'timeout' süre doldu (backend'in saati) | 'gone' geri alma zamanlayıcısı yok (çalıştı ya da Pi yeniden başladı).
async function expireTrial(cfg: SqmConfig, why: 'timeout' | 'gone' = 'timeout'): Promise<void> {
  await writeConfig({ ...cfg, enabled: false, trialUntil: 0 });
  clearExpiry();
  ensureTicking(false);
  blockKey = '';
  // Zamanlayıcı ya çalıştı ya birazdan çalışacak: önce durdurulur (iki kaldırma aynı anda koşmasın), sonra burada kaldırılır.
  await stopRollback();
  let err = '';
  try { await clearOwn(); } catch (e: any) { err = e.message; }
  lastError = err;
  const what = why === 'gone' ? 'denemesi onaylanmadan bitti (geri alma zamanlayıcısı çalıştı ya da Pi yeniden başladı)'
    : 'denemesi 5 dk içinde onaylanmadı';
  await recordEvent('bandwidth', `Akıllı kuyruk ${what} — kuyruk kaldırıldı, hat eski hâlinde${err ? ` (${err})` : ''}`, 'warning');
}

// Kapatma (Geri al / Kapat / uydu / SSH'tan sqm.sh off): zamanlayıcı durur, kendi kaynaklarımız kalkar, ayar kapanır. Kaldırma
// hatası döner (ayar yine kapalıdır). Sıralı kuyruğun içinden çağrılır.
type OffKind = 'rollback' | 'disable' | 'satellite' | 'ssh';
async function turnOff(cfg: SqmConfig, kind: OffKind): Promise<string> {
  const was = cfg.enabled;
  await writeConfig({ ...cfg, enabled: false, trialUntil: 0 });
  clearExpiry();
  ensureTicking(false);
  blockKey = '';
  takeOffFlag(); // kapalıyken kalmış işaret sonraki açmayı kapatmasın
  await stopRollback();
  let err = '';
  if (isLinux) { try { await clearOwn(); } catch (e: any) { err = e.message; } }
  lastError = err;
  if (was || err) {
    const what = kind === 'rollback' ? 'denemesi geri alındı' : kind === 'satellite' ? 'kapatıldı (cihaz uydu oluyor)'
      : kind === 'ssh' ? "kapatıldı (SSH'tan sqm.sh off)" : 'kapatıldı';
    await recordEvent('bandwidth', `Akıllı kuyruk ${what} — hat eski hâlinde${err ? ` (${err})` : ''}`, err ? 'warning' : 'info');
  }
  return err;
}

// Açıkken: süresi dolan deneme kapatılır; hat ve ayar uyuyorsa canlı durum denetlenir, yalnız sapmada yeniden kurulur;
// uymuyorsa (hat değişti / desteklenmeyen kip) kendi kaynaklarımız kaldırılır ve bir kez uyarılır.
async function reconcile(): Promise<void> {
  const cfg = await readConfig();
  // SSH'tan sqm.sh off: kuyruk betikte kaldırıldı — burada ayar kapanır (geri takılmaz).
  if (takeOffFlag() && cfg?.enabled) { await turnOff(cfg, 'ssh'); return; }
  if (!cfg || !cfg.enabled) { ensureTicking(false); return; }
  // 1 sn erken: zamanlayıcının çalıştığı anla backend'in süresi arasındaki kısa aralıkta bir tur kuyruğu yeniden takmasın.
  if (cfg.trialUntil && nowS() >= cfg.trialUntil - 1) { await expireTrial(cfg); return; }
  // Deneme sürerken güvenlik ağı (monoton saatli systemd zamanlayıcısı) yoksa deneme bitmiştir: duvar saati geri gittiyse
  // (NTP) trialUntil ileri kayar — kuyruk zamanlayıcısız yeniden takılmasın.
  if (cfg.trialUntil && !(await rollbackArmed())) { await expireTrial(cfg, 'gone'); return; }
  if (calibrating) return;
  const plan = buildSqmPlan(await planEnv(), cfg);
  if (!plan.steps.length) {
    if (ownPresent()) await clearOwn();
    const key = `${plan.code}|${plan.line?.sig || ''}`;
    if (key !== blockKey) {
      blockKey = key;
      lastError = '';
      const what = plan.code === 'mismatch' ? `internet hattı değişti (${plan.line?.label || 'yeni hat'})` : plan.reason;
      await recordEvent('bandwidth', `Akıllı kuyruk takılmadı: ${what} — Bant Genişliği → Gecikme'den bandı yeniden ölçüp kaydedin`, 'warning');
    }
    return;
  }
  const live = await readLive(plan.line!.dev);
  if (liveIntact(live, cfg.primary!)) {
    appliedDev = plan.line!.dev;
    lastError = '';
    blockKey = '';
    return;
  }
  // Arayüz yok (PPPoE yeniden arıyor, kart çıkarıldı): gelince takılır — o ana kadar kuyruksuz (= bugünkü davranış), olay yok.
  if (!live.devExists) {
    appliedDev = null;
    lastError = `${plan.line!.dev} arayüzü şu an yok — gelince kuyruk yeniden takılır`;
    return;
  }
  const was = appliedDev;
  await install(plan);
  lastError = '';
  if (blockKey) await recordEvent('bandwidth', `Akıllı kuyruk yeniden takıldı (${plan.line!.label})`);
  else if (was) console.log(`[sqm] kuyruk yeniden kuruldu (${plan.line!.dev}: arayüz yeniden kuruldu ya da kuyruk dışarıdan silindi)`);
  blockKey = '';
}

// ─── İşlemler ───

async function requireLine(): Promise<{ env: SqmPlanEnv; line: SqmLine }> {
  if (!isLinux) throw new SqmError(409, 'Akıllı kuyruk yalnız Pi üzerinde çalışır');
  const env = await planEnv();
  const r = resolveSqmLine(env.ns, env.satellite);
  if (r.code !== 'ok') throw new SqmError(409, r.reason);
  return { env, line: r.line };
}

let modCache: { at: number; mods: Record<string, boolean> } | null = null;
async function kernelModules(): Promise<Record<string, boolean>> {
  if (modCache && Date.now() - modCache.at < 600000) return modCache.mods;
  const vals = await Promise.all(SQM_MODULES.map(m => hasModule(m)));
  const mods = Object.fromEntries(SQM_MODULES.map((m, i) => [m, vals[i]]));
  modCache = { at: Date.now(), mods };
  return mods;
}

// Deneme: zamanlayıcı → ayar → kurulum. Kurulamazsa zamanlayıcı durur, ayar kapanır (hiçbir şey takılı kalmaz).
async function startTrial(cfg: SqmConfig, env: SqmPlanEnv, line: SqmLine, why: string): Promise<number> {
  const next: SqmConfig = { ...cfg, enabled: true };
  const plan = buildSqmPlan(env, next);
  if (!plan.steps.length) throw new SqmError(409, plan.reason);
  if (!onPath('tc')) throw new SqmError(409, 'tc (iproute2) kurulu değil — sudo apt install iproute2');
  const missing = Object.entries(await kernelModules()).filter(([, ok]) => !ok).map(([m]) => m);
  if (missing.length) throw new SqmError(409, `Çekirdekte gerekli modül yok: ${missing.join(', ')}`);
  // Yedek hattayken trafik ana hat arayüzünden geçmez: deneme sınanamaz (kuyruk boştaki hatta takılırdı).
  if (onBackupLine(env.ns)) throw new SqmError(409, BACKUP_MSG);
  takeOffFlag(); // kapalıyken kalmış sqm.sh off işareti yeni denemeyi hemen kapatmasın
  await armRollback(TRIAL_S);
  const until = nowS() + TRIAL_S;
  try {
    await writeConfig({ ...next, trialUntil: until });
  } catch (e: any) {
    await stopRollback();
    throw new SqmError(500, `Ayar kaydedilemedi — kuyruk açılmadı: ${e?.message || e}`);
  }
  try {
    await install(plan);
  } catch (e: any) {
    await stopRollback();
    await writeConfig({ ...next, enabled: false, trialUntil: 0 }).catch(() => {});
    lastError = e.message;
    await recordEvent('bandwidth', `Akıllı kuyruk açılamadı, geri alındı: ${e.message}`, 'warning');
    throw new SqmError(500, `Kuyruk takılamadı, geri alındı: ${e.message}`);
  }
  lastError = '';
  blockKey = '';
  scheduleExpiry(until);
  ensureTicking(true);
  const p = next.primary!;
  await recordEvent('bandwidth', `Akıllı kuyruk ${why}: ${line.label} — ↓${fmtMbps(p.downKbit)} ↑${fmtMbps(p.upKbit)}. 5 dk içinde "Kalıcı yap"a basılmazsa kaldırılır`);
  return until;
}

export function saveLine(patch: Pick<SqmLineSettings, 'downKbit' | 'upKbit' | 'overhead'>): Promise<{ trialUntil: number }> {
  return serial(async () => {
    const { env, line } = await requireLine();
    if (calibrating) throw new SqmError(409, 'Ölçüm sürüyor — bitince kaydedin');
    const cfg = (await readConfig()) || { enabled: false, trialUntil: 0, primary: null };
    const next: SqmConfig = { ...cfg, primary: { sig: line.sig, ...patch, savedAt: nowS() } };
    // Açıkken bant değişikliği de denemedir (yanlış değer 5 dk sonra kendiliğinden kalkar).
    if (cfg.enabled) return { trialUntil: await startTrial(next, env, line, 'yeni bantla yeniden denemede') };
    await writeConfig({ ...next, enabled: false, trialUntil: 0 });
    await recordEvent('bandwidth', `Akıllı kuyruk bandı kaydedildi: ${line.label} — ↓${fmtMbps(patch.downKbit)} ↑${fmtMbps(patch.upKbit)} (kuyruk kapalı)`);
    return { trialUntil: 0 };
  });
}

export function trial(): Promise<{ trialUntil: number }> {
  return serial(async () => {
    const { env, line } = await requireLine();
    if (calibrating) throw new SqmError(409, 'Ölçüm sürüyor — bitince deneyin');
    const cfg = await readConfig();
    if (!cfg?.primary) throw new SqmError(409, 'Önce bandı kaydedin (2. adım)');
    if (cfg.primary.sig !== line.sig) throw new SqmError(409, 'İnternet hattı bant kaydedildiğinden beri değişti — bandı yeniden ölçüp kaydedin');
    if (cfg.enabled && !cfg.trialUntil) throw new SqmError(409, 'Akıllı kuyruk zaten açık (kalıcı)');
    return { trialUntil: await startTrial(cfg, env, line, 'denemesi başladı') };
  });
}

export function confirm(): Promise<void> {
  return serial(async () => {
    const cfg = await readConfig();
    if (!cfg?.enabled || !cfg.trialUntil) throw new SqmError(409, 'Deneme sürmüyor (süre dolduysa kuyruk kaldırılmıştır)');
    if (nowS() >= cfg.trialUntil - 2) throw new SqmError(409, 'Deneme süresi doldu — kuyruk kaldırılıyor');
    // Güvenlik ağı (zamanlayıcı) yoksa deneme bitmiştir (çalıştı ya da Pi yeniden başladı): kalıcı yapılmaz, kapatılır.
    if (isLinux && !(await rollbackArmed())) {
      await expireTrial(cfg, 'gone');
      throw new SqmError(409, "Deneme bitti — Pi'deki geri alma zamanlayıcısı kuyruğu kaldırdı. Yeniden deneyin");
    }
    const plan = buildSqmPlan(await planEnv(), cfg);
    if (!plan.steps.length || !liveIntact(await readLive(plan.line!.dev), cfg.primary!)) {
      throw new SqmError(409, 'Kuyruk takılı değil — deneme sürüyor, süre dolunca kapanır');
    }
    // Önce zamanlayıcı (durmazsa kalıcı yapılmaz), sonra ayar: ayar yazılamazsa backend süre dolunca yine kapatır.
    await stopRollback();
    if (await rollbackArmed()) throw new SqmError(500, 'Geri alma zamanlayıcısı durdurulamadı — deneme sürüyor');
    await writeConfig({ ...cfg, trialUntil: 0 });
    clearExpiry();
    ensureTicking(true);
    await recordEvent('bandwidth', `Akıllı kuyruk kalıcı yapıldı: ${plan.line!.label} — ↓${fmtMbps(cfg.primary!.downKbit)} ↑${fmtMbps(cfg.primary!.upKbit)}`);
  });
}

// Geri al (deneme) / Kapat (kalıcı ya da deneme) / uydu: zamanlayıcı durur, kendi kaynaklarımız kalkar, ayar kapanır.
export function disable(kind: 'rollback' | 'disable' | 'satellite'): Promise<void> {
  return serial(async () => {
    const cfg = await readConfig();
    if (!cfg) {
      if (kind === 'rollback') throw new SqmError(409, 'Deneme sürmüyor');
      return; // ayar hiç yok: hiçbir şey takılmadı, tc çağrılmaz
    }
    if (kind === 'rollback' && !(cfg.enabled && cfg.trialUntil)) throw new SqmError(409, 'Deneme sürmüyor (süre dolduysa kuyruk kaldırılmıştır)');
    const err = await turnOff(cfg, kind);
    if (err) throw new SqmError(500, `Ayar kapatıldı ama ${err}`);
  });
}

// Kalibrasyon: süren ölçüm (kısılmış olabilir) beklenir, kuyruk ölçüm boyunca kaldırılır (kayıt shaped=0), sonra açıksa
// hemen geri takılır. Öneri: hattın gerçek hızının %90'ı — hız testi yalnız veriyi sayar, CAKE paket başlıklarını da: ölçülen
// / beklenen verim (lineEfficiency) = hattın hızı; onun %90'ı (100 kbit'e aşağı yuvarlanır). Tam boy pakette sonuç ölçülen
// verinin ~%90'ıdır (hangi bağlantı türü seçilirse seçilsin). Her bağlantı türü için ayrı öneri döner (sihirbazda tür
// değiştirilince öneri de değişir); suggestion: istekteki ya da kayıtlı tür (yoksa ethernet).
export interface SqmDeps {
  measure: () => Promise<SpeedResult>;                  // index.ts measureAndStore — tek ölçüm yolu
  idle: () => Promise<void>;                            // süren hız testi bitene kadar
  isLoopback: (ip: string | undefined) => boolean;      // index.ts isLoopbackClient
}
export const SUGGEST_PCT = 90;
export const suggestKbit = (mbps: number, eff = 1) =>
  Math.min(MAX_KBIT, Math.max(MIN_KBIT, Math.floor((mbps * 1000 * SUGGEST_PCT) / 100 / eff / 100) * 100));
type Suggestion = { downKbit: number; upKbit: number; pct: number };
export function calibrate(deps: SqmDeps, overhead?: SqmOverhead): Promise<{
  result: SpeedResult; bypassed: boolean; overhead: SqmOverhead; suggestion: Suggestion; suggestions: Record<SqmOverhead, Suggestion>;
}> {
  return serial(async () => {
    const { env, line } = await requireLine();
    if (onBackupLine(env.ns)) throw new SqmError(409, BACKUP_MSG);
    const o = overhead || (await readConfig())?.primary?.overhead || 'ethernet';
    calibrating = true;
    let bypassed = false;
    try {
      await deps.idle();
      if (ownPresent()) { await clearOwn(); bypassed = true; }
      const result = await deps.measure();
      const suggestions = Object.fromEntries(OVERHEADS.map(x => {
        const eff = lineEfficiency(x, line);
        return [x, { downKbit: suggestKbit(result.download_mbps, eff), upKbit: suggestKbit(result.upload_mbps, eff), pct: SUGGEST_PCT }];
      })) as Record<SqmOverhead, Suggestion>;
      return { result, bypassed, overhead: o, suggestion: suggestions[o], suggestions };
    } finally {
      calibrating = false;
      await reconcile().catch(onBgError); // açıksa 15 sn beklemeden geri takılır
    }
  });
}

// ─── Durum ───

export async function sqmStatus(): Promise<Record<string, unknown>> {
  const cfg = await readConfig();
  const env = isLinux ? await planEnv() : { satellite: isSatellite(), ns: null, lite: false };
  const r = isLinux ? resolveSqmLine(env.ns, env.satellite)
    : { code: 'invalid' as const, line: null, reason: 'Akıllı kuyruk yalnız Pi üzerinde çalışır' };
  const line = r.line;
  const mods = isLinux ? await kernelModules() : {};
  const missing = SQM_MODULES.filter(m => !mods[m]);
  const tc = isLinux && onPath('tc');
  const p = cfg?.primary || null;
  const sigMatches = !!p && !!line && p.sig === line.sig;
  // Canlı okuma yalnız açıkken (ayar yokken / kapalıyken tc çağrılmaz).
  const live = cfg?.enabled && line ? await readLive(line.dev) : null;
  const intact = !!live && !!p && sigMatches && liveIntact(live, p);
  const trialOn = !!cfg?.enabled && cfg.trialUntil > 0;
  // waiting: açık ama hat arayüzü şu an yok (PPPoE yeniden arıyor) — gelince takılır.
  const state = !line ? 'unsupported' : !cfg?.enabled ? 'off' : !sigMatches ? 'mismatch' : calibrating ? 'calibrating'
    : intact ? (trialOn ? 'trial' : 'on') : live && !live.devExists ? 'waiting' : 'error';
  const warnings: string[] = [];
  if (env.lite) warnings.push('Düşük bellekli (lite) profil: kuyruk belleği 4 MB ile sınırlanır; yüksek hızlarda işlemci yetmeyebilir — denemede hızı karşılaştırın');
  if (line && line.port) {
    const b = ifaceBus(line.port);
    if (b.bus === 'usb' && b.usbSpeedMbps !== null && b.usbSpeedMbps < 5000) {
      warnings.push(`${line.port} USB 2 portunda: hat ~300 Mbps ile sınırlı — bandı bunun üstünde ayarlamayın; adaptörü mavi USB 3 portuna takın`);
    }
  }
  if (line?.kind === 'samenet') warnings.push('Wi-Fi köprüsünde (aynı ağ) üst ağdaki cihazlarla (ör. modem tarafındaki yazıcı / TV) yerel trafik de bu banda girer');
  if (line?.kind === 'wifi') warnings.push("Wi-Fi ile internet: hız sinyale göre değişir — bandı kötü saatteki ölçümün biraz altında seçin");
  const onBackup = isLinux && onBackupLine(env.ns);
  if (env.ns?.bakStage === 'on') {
    warnings.push(`Yedek hat kuyruksuz: yedek hatta geçilince akıllı kuyruk devre dışı kalır (yedek hat kuyruğu yakında — G1.1-C)${onBackup ? ' — şu an yedek hattasınız' : ''}`);
  }
  return {
    supported: r.code === 'ok', code: r.code, reason: r.reason, satellite: env.satellite,
    line: line ? { dev: line.dev, kind: line.kind, label: line.label, nat: line.nat, port: line.port } : null,
    tc, modules: mods, missingModules: isLinux ? missing : [], ready: isLinux && tc && missing.length === 0,
    configured: !!cfg, enabled: !!cfg?.enabled, trialUntil: trialOn ? cfg!.trialUntil : 0, now: nowS(), trialS: TRIAL_S,
    // Yedek hattayken "Ölç" ve "Dene" kapalı (409): ölçüm yedek hattı ölçerdi, deneme sınanamazdı.
    onBackup,
    config: p ? {
      downKbit: p.downKbit, upKbit: p.upKbit, overhead: p.overhead, savedAt: p.savedAt, sigMatches,
      overheadBytes: line ? overheadArgs(p.overhead, line).bytes : null,
      // beklenen verim (hız testi / bant): "Kuyrukla hız testi" bununla karşılaştırılır
      efficiency: line ? lineEfficiency(p.overhead, line) : null,
    } : null,
    state, applied: intact ? { dev: line!.dev, ifb: IFB_DEV, at: lastAppliedAt ? Math.floor(lastAppliedAt / 1000) : null } : null,
    calibrating, lastError: cfg?.enabled ? lastError : '',
    rollbackArmed: trialOn && isLinux ? await rollbackArmed() : false,
    defaults: { overhead: 'ethernet', suggestPct: SUGGEST_PCT },
    limits: { minKbit: MIN_KBIT, maxKbit: MAX_KBIT },
    overheadPreview: line ? Object.fromEntries(OVERHEADS.map(o => [o, overheadArgs(o, line).bytes])) : null,
    efficiencyPreview: line ? Object.fromEntries(OVERHEADS.map(o => [o, lineEfficiency(o, line)])) : null,
    warnings,
  };
}

// ─── Açılış / rol ───

// Açılış (ana cihaz): ayar yoksa hiçbir şey (tc yok). Kapalıysa yalnız kalmış kaynak varsa (ör. çökme) kaldırılır. SSH'tan
// sqm.sh off işareti varsa ayar kapatılır. Açıksa: süresi geçmiş deneme kapatılır; süren denemenin zamanlayıcısı yoksa
// (çalıştı ya da Pi yeniden başladı) deneme bitmiş sayılır — kuyruk zamanlayıcısız kurulmaz; varsa (yalnız backend yeniden
// başladı) aynı zamanlayıcıyla sürer. Sonra uzlaştırma ve 15 sn'lik izleyici.
export function startSqm(): void {
  if (!isLinux) return;
  void serial(async () => {
    const cfg = await readConfig();
    const off = takeOffFlag();
    if (!cfg) return;
    if (off && cfg.enabled) { await turnOff(cfg, 'ssh'); return; }
    if (!cfg.enabled) {
      if (devExists(IFB_DEV)) await clearOwn();
      return;
    }
    if (cfg.trialUntil) {
      if (cfg.trialUntil - nowS() <= 0) { await expireTrial(cfg); return; }
      if (!await rollbackArmed()) { await expireTrial(cfg, 'gone'); return; }
      scheduleExpiry(cfg.trialUntil);
    }
    ensureTicking(true);
    await reconcile();
  }).catch(onBgError);
}

// Uydu rolünde açılış: kalmış kaynaklar kaldırılır, ayar kapatılır (ayar yoksa hiçbir şey).
export function sqmSatelliteCleanup(): void {
  if (!isLinux) return;
  void disable('satellite').catch((e: any) => console.warn(`[sqm] uydu temizliği: ${e.message}`));
}

// ─── API ───

// /api/bandwidth/sqm — yazma uçları netAdminGuard ('/api/bandwidth' öneki) + writeLimiter, uyduda 409 (index.ts).
export function registerSqmRoutes(app: express.Express, deps: SqmDeps): void {
  const fail = (res: express.Response, e: any) => res.status(e instanceof SqmError ? e.status : e instanceof SpeedtestUnavailable ? 503 : 500)
    .json({ error: e?.message || 'Akıllı kuyruk işlemi başarısız' });
  app.get('/api/bandwidth/sqm', async (_req, res) => {
    try { res.json(await sqmStatus()); } catch (e: any) { res.status(500).json({ error: `Akıllı kuyruk durumu okunamadı: ${e?.message || e}` }); }
  });
  app.put('/api/bandwidth/sqm', async (req, res) => {
    const v = validateLinePatch(req.body);
    if ('error' in v) return res.status(400).json({ error: v.error });
    try { res.json({ success: true, ...await saveLine(v.line) }); } catch (e) { fail(res, e); }
  });
  app.post('/api/bandwidth/sqm/trial', async (_req, res) => {
    try { res.json({ success: true, ...await trial() }); } catch (e) { fail(res, e); }
  });
  app.post('/api/bandwidth/sqm/confirm', async (req, res) => {
    if (deps.isLoopback(req.ip)) {
      return res.status(403).json({ error: "Onayı ev ağındaki bir cihazdan (PC/telefon) verin — Pi'nin kendi ekranı internetin kuyrukla çalıştığını kanıtlamaz" });
    }
    try { await confirm(); res.json({ success: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/bandwidth/sqm/rollback', async (_req, res) => {
    try { await disable('rollback'); res.json({ success: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/bandwidth/sqm/disable', async (_req, res) => {
    try { await disable('disable'); res.json({ success: true }); } catch (e) { fail(res, e); }
  });
  // Gövde: {} ya da { overhead } (sihirbazda seçili bağlantı türü — suggestion onunla; suggestions her tür için).
  app.post('/api/bandwidth/sqm/calibrate', async (req, res) => {
    const o = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).overhead : undefined;
    if (o !== undefined && !isOverhead(o)) return res.status(400).json({ error: `Bağlantı türü şunlardan biri olmalı: ${OVERHEADS.join(', ')}` });
    if (calibrating) return res.status(409).json({ error: 'Ölçüm zaten sürüyor' });
    try { res.json({ success: true, ...await calibrate(deps, o) }); } catch (e) { fail(res, e); }
  });
}

// Hat düzeyi akıllı kuyruk (G1.1, SQM: CAKE) — Bant Genişliği → Gecikme (Akıllı Kuyruk). İndirme / yükleme hattı
// doyurduğunda gecikmenin fırlamasını (bufferbloat) önler: kuyruk modemde / operatörde değil Pi'de, hattın ölçülen hızının
// biraz altında oluşur; CAKE paketleri cihazlar arasında adil paylaştırır (dual-srchost / dual-dsthost + nat: cihaz başı
// adalet). qos.ts'in (cihaz başı nft hız sınırı + kota) YERİNE DEĞİL, üstüne ayrı katman: qos.ts değişmez.
//  - A: ayrı internet kartı kipleri (WAN router DHCP / sabit / PPPoE / VLAN / tek port VLAN, R4 A Wi-Fi WAN) ve R4 C aynı ağ
//    köprüsü (üst Wi-Fi; Pi NAT yapmadığından 'nat' anahtarı yok). Tek portta kuyruk ASLA ev ağı kartına takılmaz — yalnız
//    wan.<VLAN> / pppwan'a.
//  - B: tek bacak (modem ile ev ağı aynı kartta; kalıcı sabit adres düzeni) ve ev Wi-Fi köprüsü br0. Kuyruk ev ağı kartına
//    (br0'da modemin MAC'inin öğrenildiği KÖPRÜ PORTUNA) takılır ama SINIFLIDIR: kök prio (2 bant, varsayılan bant 2),
//    ca1e:1 altında CAKE (internet: yalnız hedef MAC'i modem olan çerçeveler — flower dst_mac), ca1e:2 altında kısıtsız
//    fq_codel (yerel: Pi ↔ ev cihazları, Samba / Time Machine, Syncthing, panel, Pi-hole). Girişte yalnız kaynak MAC'i modem
//    olan çerçeveler IFB'ye yönlendirilir. Süzgeçler 'protocol all': VLAN etiketli çerçeveler (G1.2 segmentleri aynı karttan)
//    de MAC'e göre ayrılır — segment → internet CAKE'e, Pi → segment cihazı yerel banda. Modem MAC'i (varsayılan ağ geçidinin
//    komşu kaydı; index.ts blockProtectedMacs ile aynı kaynak) bilinmiyorsa HİÇBİR ŞEY TAKILMAZ (bugünkü davranış); takılıyken
//    geçici olarak okunamazsa takılı olan kalır. Modem MAC'i değişirse (modem değişti) hat imzası değişir → kuyruk kaldırılır.
//  - C: yedek hat kuyruğu. Yedek hattın adres arayüzü (kart / bak.<VLAN> / pppbak / Wi-Fi kartı / USB grup 77 arayüzü)
//    kendi bandıyla (sqm_config.backup, hat imzasıyla), kendi IFB'siyle (ifb-klx1..). Yedek profiller hep bağlı (metrik 900)
//    olduğundan kuyruk ÖNCEDEN takılır: geçişte tc'ye dokunulmaz, yalnız rota değişir. USB kartın adı değişirse imza (adsız:
//    sürücü + USB kimliği) aynı kalır, uzlaştırma kuyruğu yeni arayüze yeniden takar; başka bir USB modem / telefon ya da
//    başka bir hotspot (ağ adı) imzayı değiştirir — eski bant uygulanmaz. Bant elle girilir; "Ölç" yalnız yedek hattayken
//    (Ookla varsayılan rotayı ölçer).
//  - VARSAYILAN KAPALI: app_settings 'sqm_config' (JSON) yalnız /api/bandwidth/sqm uçlarından, doğrulamayla yazılır (genel PUT
//    /api/settings kabul etmez; yedekten geri gelmez — index.ts BACKUP_SKIP_SETTINGS: hatta özgü bant başka bir cihaza /
//    hatta geri yüklenip hattı kısmasın). Ayar yokken modül hiçbir tc komutu çalıştırmaz; kapalıyken (enabled=false) da
//    çalıştırmaz — yalnız kapatırken bir kez kendi kaynaklarını kaldırır.
//  - Kaynaklar (plan 0.5): hat arayüzünün kök qdisc'i ca1e: (tek bacakta prio; altında ca11: CAKE, ca12: fq_codel), IFB
//    ifb-klx0 (ana hat) / ifb-klx1.. (yedek hat) (kökleri ca1f:), giriş (ingress ffff:) ve çıkış sınıflandırma süzgeci pref
//    4910. Kaldırma tek uygulamadır: scripts/sqm.sh clear (tümü) / clear-line (tek hat) — başka qdisc'e dokunmaz. Giriş
//    kuyruğunu yalnız biz eklediysek kaldırır (sahiplik: /run/pi5-sqm/ingress-owned). IFB modülü numifbs=0 ile yüklenir.
//  - Öncelik sınıfı yok: CAKE 'besteffort' (varsayılanı diffserv3, DSCP'ye göre kova — uzak sunucunun / operatörün koyduğu
//    işaretle bir cihaz Bulk kovasına düşüp adaletin dışında kalırdı). DSCP sınıfları G5.8 ile bilinçli gelir (tin / DSCP /
//    fwmark bu sürümde YOK).
//  - Komutlar argv listesi (buildSqmPlan, saf), execFile ile — kabuk yok; arayüz adı, MAC ve kbit sıkı doğrulanır. Sıra
//    önemli: IFB ve kökündeki CAKE hazır olmadan giriş yönlendirmesi kurulmaz (yönlendirilen paket düşerdi); sınıflı kipte
//    CAKE ve yerel bant hazır olmadan sınıflandırma süzgeci eklenmez.
//  - Uzlaştırma 15 sn'de bir (yalnız açıkken; kendi sıralı kuyruğunda), HAT BAŞINA: tc -j ile kind + handle (+ bant, sınıflı
//    kipte alt kuyruklar ve süzgeçler) karşılaştırılır, yalnız sapan hat yeniden kurulur (sqm.sh clear-line → kurulum; diğer
//    hatlara dokunulmaz). Hat imzası (sig) kayıtlı ayarınkinden farklıysa kuyruk TAKILMAZ (yanlış bantla hat kısılmasın) ve
//    bir kez uyarı olayı yazılır.
//  - Açma ve bant değişikliği (ana ya da yedek hat) her zaman 5 dk'lık denemedir: geri alma zamanlayıcısı (systemd-run
//    pi5-sqm-rollback → sqm.sh clear) değişiklikten ÖNCE kurulur, backend çökse de çalışır; "Kalıcı yap" Pi'nin kendi
//    ekranından (loopback) kabul edilmez. Süre dolunca backend de ayarı kapatır (enabled=false) — açılışta süresi geçmiş
//    deneme kapatılır. Zamanlayıcı (monoton saat) belirleyicidir: deneme sürerken zamanlayıcı yoksa deneme bitmiş sayılır.
//  - SSH kurtarması: sqm.sh off kuyruğu hemen kaldırır ve /etc/pi5-gateway/sqm.off bırakır; backend onu görünce ayarı kapatır.
//  - Hız testi: kuyruk takılıyken ölçüm kısılmış hattan geçer → speed_tests.shaped=1 (index.ts measureAndStore, sqmShaping;
//    yedek hattayken yedek hat kuyruğu takılıysa). Otomatik ölçüm kuyruğu kaldırmaz; yalnız kalibrasyon ("Ölç") kaldırır.
//  - Uydu rolünde çalışmaz: rol uyduya çevrilirken ve açılışta uyduysa kendi kaynakları kaldırılır, ayar kapatılır.
//  - G2.5 (hızlı yedek hat) için dışa açık: sqmLineEnabled(dev) (hatta kuyruk açık ve takılı mı), sqmCalibrating().
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
import { isLinux, readNetModeState, wanActive, sameNetActive, readFailoverStatus, backupIfaces, HOME_BRIDGE, type NetModeState } from './system';
import { isSatellite } from './role';
import { readPlatform, hasModule, onPath, ifaceBus, SQM_MODULES } from './hardware';
import { readDefaultRoute, readNeighbors } from './topology';
import { fmtMbps } from './qos';
import { SpeedtestUnavailable, type SpeedResult } from './speedtest';

const execFileP = promisify(execFile);

export const ROOT_HANDLE = 'ca1e:';
export const IFB_HANDLE = 'ca1f:';
// Tek bacak / br0 (sınıflı kip): prio kökünün 1. bandındaki CAKE (internet) ve 2. bandındaki fq_codel (yerel, kısıtsız)
export const SHAPER_HANDLE = 'ca11:';
export const LOCAL_HANDLE = 'ca12:';
export const FILTER_PREF = '4910';
export const IFB_DEV = 'ifb-klx0';
// Yedek hat IFB'leri: ifb-klx1..N (hat sırasıyla)
export const ifbFor = (i: number) => `ifb-klx${i}`;
export const SETTINGS_KEY = 'sqm_config';
export const TRIAL_S = 300;
export const MIN_KBIT = 64;
export const MAX_KBIT = 10_000_000;
export const ROLLBACK_UNIT = 'pi5-sqm-rollback';
// Sınıflı kipin (tek bacak / br0) ek modülleri: prio kökü, flower (MAC) süzgeci, yerel bandın fq_codel'i
export const ONEARM_MODULES = ['sch_prio', 'cls_flower', 'sch_fq_codel'] as const;
// Yedek hat bandı kayıtları (hat imzasıyla): yedek hat değiştirilip geri alınırsa eski bant yeniden kullanılır; en çok 4
export const MAX_BACKUP_ENTRIES = 4;
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
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IFB_RE = /^ifb-klx\d+$/;
// USB kimliği (yedek hat imzası): idVendor:idProduct, seri numarası varsa #özet
const USBID_RE = /^[0-9a-f]{4}:[0-9a-f]{4}(#[0-9a-f]{8})?$/;
// Tek yayın (unicast), sıfır değil: modem MAC'i süzgece yazılır
export const unicastMac = (m: string) => MAC_RE.test(m) && m !== '00:00:00:00:00:00' && (parseInt(m.slice(0, 2), 16) & 1) === 0;

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
// ölçüldüğü hattın imzası. backup: yedek hat ayarları (hat imzasıyla; yoksa alan hiç yazılmaz — G1.1-A kaydıyla bayt bayt aynı).
export interface SqmConfig { enabled: boolean; trialUntil: number; primary: SqmLineSettings | null; backup?: SqmLineSettings[] }

const kbitOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= MIN_KBIT && (v as number) <= MAX_KBIT;
const isOverhead = (v: unknown): v is SqmOverhead => typeof v === 'string' && (OVERHEADS as readonly string[]).includes(v);
function lineSettingsOf(v: unknown): SqmLineSettings | null {
  const p = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  return p && typeof p.sig === 'string' && SIG_RE.test(p.sig) && kbitOk(p.downKbit) && kbitOk(p.upKbit) && isOverhead(p.overhead)
    ? { sig: p.sig, downKbit: p.downKbit, upKbit: p.upKbit, overhead: p.overhead, savedAt: Number.isInteger(p.savedAt) ? p.savedAt as number : 0 }
    : null;
}

// Kayıtlı değer → ayar (bozuk alan atılır; geçerli hat ayarı yoksa kuyruk açık sayılmaz). Kayıt hiç yoksa null.
export function normalizeConfig(raw: unknown): SqmConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const primary = lineSettingsOf(o.primary);
  const enabled = o.enabled === true && !!primary;
  const trialUntil = enabled && Number.isInteger(o.trialUntil) && (o.trialUntil as number) > 0 ? o.trialUntil as number : 0;
  const backup: SqmLineSettings[] = [];
  for (const b of Array.isArray(o.backup) ? o.backup : []) {
    const s = lineSettingsOf(b);
    if (s && !backup.some(x => x.sig === s.sig) && backup.length < MAX_BACKUP_ENTRIES) backup.push(s);
  }
  return { enabled, trialUntil, primary, ...(backup.length ? { backup } : {}) };
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
  // Boş yedek hat listesi yazılmaz (yalnız ana hat ayarı olan kayıt G1.1-A'dakiyle aynı kalır)
  const { backup, ...rest } = c;
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(backup?.length ? c : rest)]);
}

// ─── Hat çözümü (saf) ───

export type SqmLineKind = 'wan' | 'vlan' | 'pppoe' | 'wifi' | 'samenet' | 'onearm' | 'bridge' | 'backup';
export interface SqmLine {
  dev: string; kind: SqmLineKind; label: string; sig: string;
  nat: boolean; vlan: boolean; pppoe: boolean;
  port: string; // fiziksel kart (USB 2 uyarısı) — tek portta ev ağı kartı, yalnız bilgi
  ifb: string;  // girişin yönlendirildiği IFB: ana hat ifb-klx0, yedek hat ifb-klx1..
  role: 'primary' | 'backup';
  l3: string;   // hattın adres / rota arayüzü (br0 kipinde br0; diğerlerinde dev)
  // Tek bacak / br0: modemin MAC'i — kuyruk sınıflı (prio + flower); yoksa ayrık arayüz (kök CAKE + matchall)
  modemMac?: string;
}
// Neden kodu: ok | satellite (uydu) | wan-trial (internet kartı denemesi) | rep-trial (Wi-Fi köprüsü denemesi) | lan-trial
// (sabit adres / ev Wi-Fi'ı denemesi) | setup (tek bacakta sabit adres yok) | nomac (modem MAC'i öğrenilemedi) | noport
// (br0'da modemin portu bulunamadı) | invalid (arayüz ev ağıyla aynı / geçersiz)
export type SqmLineCode = 'ok' | 'satellite' | 'wan-trial' | 'rep-trial' | 'lan-trial' | 'setup' | 'nomac' | 'noport' | 'invalid';
export type SqmLineResult = { code: 'ok'; line: SqmLine; reason: '' } | { code: Exclude<SqmLineCode, 'ok'>; line: null; reason: string };

// Canlı okumalar (planEnv): saf çözüm bunlarla çalışır. Tek bacak / br0: modem (varsayılan ağ geçidi) ve MAC'i (komşu
// tablosu), br0'da MAC'in öğrenildiği köprü portu. Yedek hat (USB, grup 77 — adı değişebilir): şu an varsayılan rotası olan
// arayüz, sürücüsü ve USB kimliği (usbId: 'üretici:ürün' + seri numarası varsa özeti; '' = okunamadı / sanal arayüz).
// Wi-Fi yedek hat (telefon hotspot'u): ağ adı (durum dosyası bak_ssid; imzaya yalnız özeti girer).
export interface SqmLiveFacts {
  modem?: { ip: string; mac: string } | null;
  bridgePort?: string | null;
  backupUsb?: { dev: string; driver: string; usbId?: string } | null;
  backupSsid?: string;
}

const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
// wanActive tür daraltıcıdır (false dalında ns'yi null'a daraltır): burada yalın boole.
const wanCardOn = (s: NetModeState): boolean => wanActive(s);

// Tek bacak kipi mi (internet kartı / Wi-Fi köprüsü yok): öyleyse ev ağı arayüzü (br0 açıksa br0, değilse kart) — modem orada.
export function oneArmLanDev(ns: NetModeState | null): string {
  if (!ns || wanCardOn(ns) || sameNetActive(ns) || ns.repStage === 'trial') return '';
  if (ns.stage !== 'static' || ns.homeStage === 'trial' || !IFNAME.test(ns.iface)) return '';
  return ns.homeStage === 'on' ? HOME_BRIDGE : ns.iface;
}

export function resolveSqmLine(ns: NetModeState | null, satellite: boolean, facts: SqmLiveFacts = {}): SqmLineResult {
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
      line: {
        dev, kind: pppoe ? 'pppoe' : vlan ? 'vlan' : ns.wanSsid ? 'wifi' : 'wan', label, sig, nat: true, vlan, pppoe, port: ns.wanPort,
        ifb: IFB_DEV, role: 'primary', l3: dev,
      },
    };
  }
  if (ns && sameNetActive(ns)) {
    const dev = ns.repPort;
    if (!IFNAME.test(dev) || dev === ns.repLan || dev === HOME_BRIDGE) return invalid(dev);
    return {
      code: 'ok', reason: '',
      line: {
        dev, kind: 'samenet', label: `Wi-Fi köprüsü (aynı ağ): üst Wi-Fi ${dev}`, nat: false, vlan: false, pppoe: false, port: dev,
        sig: ['samenet', dev, ns.repSsid ? `wifi#${shortHash(ns.repSsid)}` : '-'].join('|'), ifb: IFB_DEV, role: 'primary', l3: dev,
      },
    };
  }
  if (ns && ns.repStage === 'trial') {
    return { code: 'rep-trial', line: null, reason: "Wi-Fi köprüsü denemesi sürüyor — 'Kalıcı yap'tan sonra açılabilir" };
  }
  // ── Tek bacak (modem ile ev ağı aynı kartta) / ev Wi-Fi köprüsü (br0) ──
  if (!ns || ns.stage === 'none') {
    return { code: 'setup', line: null, reason: "Tek bacaklı kurulumda akıllı kuyruk için önce Pi'ye sabit adres verin ve kalıcı yapın (DHCP Ayarları, 1. adım)" };
  }
  if (ns.stage === 'trial') return { code: 'lan-trial', line: null, reason: "Sabit adres denemesi sürüyor — 'Kalıcı yap'tan sonra açılabilir" };
  if (ns.homeStage === 'trial') return { code: 'lan-trial', line: null, reason: "Ev Wi-Fi'ı (br0) denemesi sürüyor — 'Kalıcı yap'tan sonra açılabilir" };
  const lanDev = oneArmLanDev(ns);
  if (!lanDev) return invalid('');
  const bridge = lanDev === HOME_BRIDGE;
  const m = facts.modem;
  if (!m || !unicastMac(m.mac)) {
    return {
      code: 'nomac', line: null,
      reason: `Modemin MAC adresi öğrenilemedi (ağ geçidi ${m?.ip || ns.gw || 'bilinmiyor'}, ${lanDev}) — kuyruk takılmaz (yerel trafik internet trafiğinden ayrılamaz). Modem açık ve Pi'ye bağlıysa birkaç saniye içinde öğrenilir`,
    };
  }
  const port = bridge ? facts.bridgePort || '' : ns.iface;
  if (!IFNAME.test(port) || port === HOME_BRIDGE || (bridge && port === ns.homeIface)) {
    return {
      code: 'noport', line: null,
      reason: port && port === ns.homeIface
        ? `Modem ev Wi-Fi'ı tarafında (${port}) görünüyor — kuyruk takılmaz (modem kabloyla bağlı olmalı)`
        : `Modemin ev Wi-Fi köprüsündeki (br0) portu bulunamadı — kuyruk takılmaz. Modem trafiği görülünce birkaç saniye içinde öğrenilir`,
    };
  }
  const macTag = `mac#${shortHash(m.mac)}`;
  return {
    code: 'ok', reason: '',
    line: {
      dev: port, kind: bridge ? 'bridge' : 'onearm', nat: true, vlan: false, pppoe: false, port, ifb: IFB_DEV, role: 'primary', l3: lanDev,
      label: bridge ? `Ev Wi-Fi köprüsü (br0): modem portu ${port} → modem ${m.ip}` : `Tek bacak: ${port} → modem ${m.ip}`,
      sig: (bridge ? ['bridge', HOME_BRIDGE, port, macTag] : ['onearm', port, macTag]).join('|'),
      modemMac: m.mac,
    },
  };
}

// Yedek hat(lar): bakStage=on iken adres arayüzü (net-mode.sh bak_cur_dev ile aynı: kart / bak.<VLAN> / pppbak / Wi-Fi kartı;
// USB'de grup 77'de şu an varsayılan rotası olan arayüz). line null: arayüz şu an yok / geçersiz (reason). Ev ağı
// arayüzlerine ve ana hattın arayüzüne asla.
export interface SqmBackupResult { line: SqmLine | null; reason: string; ifb: string }
export function resolveBackupLines(ns: NetModeState | null, satellite: boolean, facts: SqmLiveFacts = {}, primaryDev = ''): SqmBackupResult[] {
  if (satellite || !ns || ns.bakStage !== 'on') return [];
  const ifb = ifbFor(1);
  const lanDevs = new Set([ns.iface, ns.lanIf, ns.homeIface, ns.repLan, ns.apIface, HOME_BRIDGE, primaryDev].filter(x => !!x));
  const typeText = ns.bakType === 'pppoe' ? 'PPPoE' : ns.bakType === 'static' ? 'sabit adres' : 'DHCP';
  const pppoe = ns.bakType === 'pppoe', vlan = !!ns.bakVlan;
  let dev = '', label = '', sig = '';
  if (ns.bakKind === 'usb') {
    const u = facts.backupUsb;
    if (!u) return [{ line: null, ifb, reason: 'USB modem / telefon şu an bağlı değil (ya da adres almadı) — takılınca kuyruk kendiliğinden takılır' }];
    dev = u.dev;
    label = `Yedek hat: USB modem / telefon ${dev} (${typeText})`;
    // Adı her takışta değişebilir: imzada ad yok — sürücü ve USB kimliği (üretici:ürün, seri no özeti) var. Aynı sürücüyü
    // kullanan başka bir modem / telefon takılırsa imza değişir: kayıtlı bant uygulanmaz, bant yeniden girilir (uyarı).
    sig = ['bak', 'usb', /^[A-Za-z0-9_.-]{1,32}$/.test(u.driver) ? u.driver : '-', USBID_RE.test(u.usbId || '') ? u.usbId : '-',
      ns.bakType || '-'].join('|');
  } else if (ns.bakKind === 'wifi') {
    dev = ns.bakDev || ns.bakPort;
    label = `Yedek hat: telefon hotspot'u ${dev} (Wi-Fi)`;
    // Ağ adının özeti (ana hattın Wi-Fi WAN imzası gibi): başka bir telefonun hotspot'una geçilirse imza değişir
    const ssid = facts.backupSsid || '';
    sig = ['bak', 'wifi', ns.bakPort || '-', dev, ns.bakType || '-', ssid ? `wifi#${shortHash(ssid)}` : '-'].join('|');
  } else {
    dev = ns.bakDev;
    label = `Yedek hat: kart ${ns.bakPort || '-'}${vlan ? `, VLAN ${ns.bakVlan}` : ''} (${typeText})${dev !== ns.bakPort ? ` → ${dev}` : ''}`;
    sig = ['bak', 'eth', ns.bakPort || '-', dev, ns.bakType || '-', ns.bakVlan || '-'].join('|');
  }
  if (!IFNAME.test(dev) || lanDevs.has(dev)) {
    return [{ line: null, ifb, reason: `Yedek hat arayüzü (${dev || '?'}) geçersiz ya da ev ağı / ana hat arayüzüyle aynı — kuyruk takılmaz` }];
  }
  return [{
    ifb, reason: '',
    line: { dev, kind: 'backup', label, sig, nat: true, vlan, pppoe, port: ns.bakKind === 'usb' ? dev : ns.bakPort || dev, ifb, role: 'backup', l3: dev },
  }];
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
export interface SqmPlanEnv { satellite: boolean; ns: NetModeState | null; lite: boolean; facts?: SqmLiveFacts }
// off: kapalı | mismatch: hat değişti | absent: yedek hat arayüzü şu an yok | unset: yedek hat için bant kaydedilmedi
export type SqmPlanCode = SqmLineCode | 'off' | 'mismatch' | 'absent' | 'unset';
// hold: hat şu an çözülemiyor ama değişmiş de sayılmaz (modem MAC'i / köprü portu okunamadı, USB yedek hat takılı değil):
// takılı olan kalır, yenisi takılmaz. settings: planın kullandığı bant (uzlaştırmada canlı karşılaştırma için).
export interface SqmPlan { steps: SqmStep[]; line: SqmLine | null; code: SqmPlanCode; reason: string; ifb: string; hold?: boolean; settings?: SqmLineSettings }

// Hat + bant → kurulum komutları. Ayrık arayüz (A, yedek hat): kök CAKE + giriş matchall → IFB. Sınıflı (tek bacak / br0):
// prio kökü, 1. bant CAKE (yalnız hedef MAC'i modem), 2. bant (varsayılan) kısıtsız fq_codel; giriş yalnız kaynak MAC'i
// modem → IFB.
export function lineSteps(line: SqmLine, p: Pick<SqmLineSettings, 'downKbit' | 'upKbit' | 'overhead'>, lite: boolean): SqmStep[] {
  const D = line.dev, I = line.ifb;
  const oh = overheadArgs(p.overhead, line).args;
  const nat = line.nat ? ['nat'] : [];
  // Düşük bellekli (lite) profil: CAKE'in kuyruk belleği hıza göre büyür (1 Gbit'te ~50 MB) — 4 MB ile sınırlanır.
  const mem = lite ? ['memlimit', '4mb'] : [];
  const upCake = ['cake', 'bandwidth', `${p.upKbit}kbit`, ...oh, 'besteffort', 'dual-srchost', ...nat, ...mem];
  // İndirme: önce IFB ve kökündeki CAKE, en son giriş yönlendirmesi (IFB hazır olmadan yönlendirilen paket düşerdi).
  // Modül yüklü değilse numifbs=0 ile yüklenir: çekirdeğin varsayılanı (2) ifb0 / ifb1'i de kurar, kapatınca kalırlardı.
  const ifbSteps: SqmStep[] = [
    { argv: ['modprobe', 'ifb', 'numifbs=0'], unless: 'ifbmod', optional: true },
    { argv: ['ip', 'link', 'add', I, 'type', 'ifb'], unless: 'ifb' },
    { argv: ['ip', 'link', 'set', I, 'up'] },
    { argv: ['tc', 'qdisc', 'replace', 'dev', I, 'root', 'handle', IFB_HANDLE, 'cake', 'bandwidth', `${p.downKbit}kbit`, ...oh, 'besteffort', 'dual-dsthost', ...nat, 'ingress', ...mem] },
    { argv: ['tc', 'qdisc', 'add', 'dev', D, 'handle', 'ffff:', 'ingress'], unless: 'ingress' },
  ];
  if (!line.modemMac) {
    return [
      // Yükleme: hat arayüzünün çıkışı
      { argv: ['tc', 'qdisc', 'replace', 'dev', D, 'root', 'handle', ROOT_HANDLE, ...upCake] },
      ...ifbSteps,
      { argv: ['tc', 'filter', 'add', 'dev', D, 'parent', 'ffff:', 'pref', FILTER_PREF, 'matchall', 'action', 'mirred', 'egress', 'redirect', 'dev', I] },
    ];
  }
  const M = line.modemMac;
  return [
    // Sınıflı kök: 2 bant, tüm öncelikler 2. banda (yerel, kısıtsız) — süzgeç yalnız modeme gideni 1. banda (CAKE) alır.
    // prio 1. bandı önce boşaltır ama CAKE kendi hızında bıraktığından yerel bant aç kalmaz.
    { argv: ['tc', 'qdisc', 'replace', 'dev', D, 'root', 'handle', ROOT_HANDLE, 'prio', 'bands', '2', 'priomap', ...Array(16).fill('1')] },
    { argv: ['tc', 'qdisc', 'replace', 'dev', D, 'parent', `${ROOT_HANDLE}1`, 'handle', SHAPER_HANDLE, ...upCake] },
    { argv: ['tc', 'qdisc', 'replace', 'dev', D, 'parent', `${ROOT_HANDLE}2`, 'handle', LOCAL_HANDLE, 'fq_codel'] },
    // 'protocol all': VLAN etiketli çerçeveler (tc etiketliyi 802.1Q sayar) de MAC'e göre ayrılır
    { argv: ['tc', 'filter', 'add', 'dev', D, 'parent', ROOT_HANDLE, 'protocol', 'all', 'pref', FILTER_PREF, 'flower', 'dst_mac', M, 'classid', `${ROOT_HANDLE}1`] },
    ...ifbSteps,
    { argv: ['tc', 'filter', 'add', 'dev', D, 'parent', 'ffff:', 'protocol', 'all', 'pref', FILTER_PREF, 'flower', 'src_mac', M, 'action', 'mirred', 'egress', 'redirect', 'dev', I] },
  ];
}

// Ayar + ana hat → kurulum komutları. Ayar yok / kapalı / hat desteklenmiyor / hat imzası değişti → boş liste (hiçbir şey
// takılmaz = bugünkü davranış). Kurulum her zaman o hattın kendi kaynakları temizlendikten sonra çalışır.
export function buildSqmPlan(env: SqmPlanEnv, cfg: SqmConfig | null): SqmPlan {
  const r = resolveSqmLine(env.ns, env.satellite, env.facts);
  if (r.code !== 'ok') return { steps: [], line: null, code: r.code, reason: r.reason, ifb: IFB_DEV, hold: r.code === 'nomac' || r.code === 'noport' };
  const line = r.line;
  if (!cfg || !cfg.enabled || !cfg.primary) return { steps: [], line, code: 'off', reason: 'Akıllı kuyruk kapalı', ifb: IFB_DEV };
  const p = cfg.primary;
  if (p.sig !== line.sig) {
    return { steps: [], line, code: 'mismatch', reason: 'İnternet hattı bant ölçüldüğünden beri değişti — bandı yeniden ölçüp kaydedin', ifb: IFB_DEV };
  }
  if (!kbitOk(p.downKbit) || !kbitOk(p.upKbit) || !isOverhead(p.overhead) || !IFNAME.test(line.dev) || (line.modemMac !== undefined && !unicastMac(line.modemMac))) {
    return { steps: [], line, code: 'invalid', reason: 'Kayıtlı ayar geçersiz — bandı yeniden kaydedin', ifb: IFB_DEV };
  }
  return { line, code: 'ok', reason: '', ifb: IFB_DEV, settings: p, steps: lineSteps(line, p, env.lite) };
}

// Yedek hat planları (G1.1-C): her yedek hat kendi bandıyla (imzası eşleşen kayıt) ve kendi IFB'siyle. Kayıt yoksa kuyruk
// yok (yedek hat bugünkü gibi kuyruksuz).
export function buildBackupPlans(env: SqmPlanEnv, cfg: SqmConfig | null): SqmPlan[] {
  const primary = resolveSqmLine(env.ns, env.satellite, env.facts);
  return resolveBackupLines(env.ns, env.satellite, env.facts, primary.line?.dev || '').map(b => {
    if (!b.line) return { steps: [], line: null, code: 'absent' as const, reason: b.reason, ifb: b.ifb, hold: true };
    if (!cfg || !cfg.enabled || !cfg.primary) return { steps: [], line: b.line, code: 'off' as const, reason: 'Akıllı kuyruk kapalı', ifb: b.ifb };
    const s = (cfg.backup || []).find(x => x.sig === b.line!.sig);
    if (!s) {
      return {
        steps: [], line: b.line, code: 'unset' as const, ifb: b.ifb,
        reason: cfg.backup?.length ? 'Yedek hat bant kaydedildiğinden beri değişti — yedek hat bandını yeniden girin'
          : 'Yedek hat için bant kaydedilmedi — yedek hatta geçilince hat kuyruksuz çalışır',
      };
    }
    return { line: b.line, code: 'ok' as const, reason: '', ifb: b.ifb, settings: s, steps: lineSteps(b.line, s, env.lite) };
  });
}
export const buildAllPlans = (env: SqmPlanEnv, cfg: SqmConfig | null): SqmPlan[] => [buildSqmPlan(env, cfg), ...buildBackupPlans(env, cfg)];

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
const viewOf = (q: any): QdiscView => {
  const bw = q.options?.bandwidth, ds = q.options?.diffserv;
  return { kind: String(q.kind || ''), handle: String(q.handle || ''), bandwidth: typeof bw === 'number' ? bw : null, diffserv: typeof ds === 'string' ? ds : null };
};
const rootOf = (qs: any[]): QdiscView | null => {
  const q = qs.find(x => x && x.root === true);
  return q ? viewOf(q) : null;
};
// shaper / local / classify: yalnız sınıflı kipte (tek bacak / br0) — CAKE alt kuyruğu, yerel bant, çıkış süzgeci (dst_mac)
export interface SqmLive {
  dev: string; devExists: boolean; root: QdiscView | null; ingress: boolean; filter: boolean; ifbUp: boolean; ifbRoot: QdiscView | null;
  shaper?: QdiscView | null; local?: QdiscView | null; classify?: boolean;
}
const mirredTo = (f: any, ifb: string) => (f.options?.actions || []).some((a: any) => a?.kind === 'mirred' && a?.to_dev === ifb);
async function readLive(line: Pick<SqmLine, 'dev' | 'ifb' | 'modemMac'>): Promise<SqmLive> {
  const dev = line.dev, ifbName = line.ifb || IFB_DEV, mac = line.modemMac;
  const exists = devExists(dev);
  const qs = exists ? await tcJson(['qdisc', 'show', 'dev', dev]) : [];
  const fl = exists && qs.some(q => q?.kind === 'ingress') ? await tcJson(['filter', 'show', 'dev', dev, 'parent', 'ffff:']) : [];
  const ifb = devExists(ifbName);
  const live: SqmLive = {
    dev, devExists: exists, root: rootOf(qs), ingress: qs.some(q => q?.kind === 'ingress'),
    filter: fl.some(f => String(f?.pref) === FILTER_PREF && (mac
      ? f?.kind === 'flower' && f.options?.keys?.src_mac === mac
      : f?.kind === 'matchall') && mirredTo(f, ifbName)),
    ifbUp: ifb && devUp(ifbName), ifbRoot: ifb ? rootOf(await tcJson(['qdisc', 'show', 'dev', ifbName])) : null,
  };
  if (mac) {
    const child = (h: string, parent: string) => { const q = qs.find(x => x?.handle === h && x?.parent === parent); return q ? viewOf(q) : null; };
    live.shaper = child(SHAPER_HANDLE, `${ROOT_HANDLE}1`);
    live.local = child(LOCAL_HANDLE, `${ROOT_HANDLE}2`);
    const ef = exists && live.root?.kind === 'prio' && live.root.handle === ROOT_HANDLE ? await tcJson(['filter', 'show', 'dev', dev, 'parent', ROOT_HANDLE]) : [];
    live.classify = ef.some(f => String(f?.pref) === FILTER_PREF && f?.kind === 'flower' && f.options?.keys?.dst_mac === mac
      && f.options?.classid === `${ROOT_HANDLE}1`);
  }
  return live;
}
// Bant ve öncelik kipi karşılaştırması (tc bant için bayt/sn bildirir; alan yoksa yalnız kind + handle).
const bwOk = (v: QdiscView, kbit: number) => (v.bandwidth === null || v.bandwidth === kbit * 125) && (!v.diffserv || v.diffserv === 'besteffort');
// classed: sınıflı kip (tek bacak / br0) bekleniyor — kök prio, alt kuyruklar ve çıkış süzgeci de denetlenir.
export function liveIntact(live: SqmLive, p: Pick<SqmLineSettings, 'downKbit' | 'upKbit'>, classed = false): boolean {
  const ingressOk = live.ingress && live.filter && live.ifbUp
    && !!live.ifbRoot && live.ifbRoot.kind === 'cake' && live.ifbRoot.handle === IFB_HANDLE && bwOk(live.ifbRoot, p.downKbit);
  if (!classed) {
    return live.devExists && !!live.root && live.root.kind === 'cake' && live.root.handle === ROOT_HANDLE && bwOk(live.root, p.upKbit) && ingressOk;
  }
  return live.devExists && !!live.root && live.root.kind === 'prio' && live.root.handle === ROOT_HANDLE
    && !!live.shaper && live.shaper.kind === 'cake' && bwOk(live.shaper, p.upKbit)
    && !!live.local && live.local.kind === 'fq_codel' && live.classify === true && ingressOk;
}

// ─── Uygulama ───

// Takılı ve doğrulanmış hatlar (IFB adına göre). sqmShaping, sqmLineEnabled ve hat başına uzlaştırma bunu kullanır.
type Slot = { dev: string; l3: string; role: 'primary' | 'backup'; label: string; at: number };
const slots = new Map<string, Slot>();
let calibrating = false;
let lastError = '';
let lastBackupError = '';
let lastAppliedAt = 0;
let blockKey = '';                      // açıkken ana hattın takılamama nedeni (uyarı olayı durum değişince bir kez)
let backupBlockKey = '';                // yedek hat için aynısı
let adopted = false;                    // açılışta önceki süreçten kalan kaynaklar denetlendi mi

const slotOf = (l: SqmLine): Slot => ({ dev: l.dev, l3: l.l3, role: l.role, label: l.label, at: Date.now() });
// Yedek hattayken (index.ts bakActive ile aynı denetim: durum dosyası yalnız yedek hat açıkken geçerli).
const onBackupLine = (ns: NetModeState | null = readNetModeState()): boolean => ns?.bakStage === 'on' && readFailoverStatus()?.active === 'backup';
// Kuyruk şu an hattı kısıyor mu (index.ts measureAndStore → speed_tests.shaped). Kalibrasyon ölçümünde false. Yedek hattayken
// ölçüm yedek hattan geçer: yalnız yedek hat kuyruğu takılıysa true.
export const sqmShaping = (): boolean => {
  if (calibrating) return false;
  if (!onBackupLine()) return slots.has(IFB_DEV);
  const d = readFailoverStatus()?.backupDev || '';
  return [...slots.values()].some(s => s.role === 'backup' && (!d || s.dev === d));
};
// G2.5 (hızlı yedek hat) için: bu arayüzün hattında akıllı kuyruk açık ve takılı mı (deneme ya da kalıcı). dev: kuyruğun
// arayüzü (wan.35 / pppwan / eth0 / yedek hat arayüzü) ya da hattın adres arayüzü (ev Wi-Fi köprüsünde br0).
export function sqmLineEnabled(dev: string): boolean {
  return !!dev && [...slots.values()].some(s => s.dev === dev || s.l3 === dev);
}
// G2.5 için: kalibrasyon ölçümü sürüyor mu (kuyruk geçici kalkar, hat doyar — yanlış geçiş bastırılmalı).
export const sqmCalibrating = (): boolean => calibrating;

const ownIfbs = (): string[] => { try { return fs.readdirSync('/sys/class/net').filter(n => IFB_RE.test(n)); } catch { return []; } };
async function clearOwn(): Promise<void> {
  slots.clear();
  try {
    await execFileP('bash', [SQM_SCRIPT, 'clear'], { timeout: 30000 });
  } catch (e: any) {
    const warn = String(e?.stdout || '').split('\n').filter(l => l.startsWith('warning=')).map(l => l.slice(8));
    throw new Error(`kuyruk kaldırılamadı: ${warn.join('; ') || errText(e)}`);
  }
}
// Tek bir hattın kaynakları (diğer hatlara dokunulmaz): arayüzdeki kök / giriş süzgeci, kimse kullanmıyorsa IFB.
async function clearLine(dev: string, ifb: string): Promise<void> {
  try {
    await execFileP('bash', [SQM_SCRIPT, 'clear-line', dev || '-', ifb], { timeout: 30000 });
  } catch (e: any) {
    const warn = String(e?.stdout || '').split('\n').filter(l => l.startsWith('warning=')).map(l => l.slice(8));
    throw new Error(`kuyruk kaldırılamadı (${dev || ifb}): ${warn.join('; ') || errText(e)}`);
  }
}
const ownPresent = () => slots.size > 0 || ownIfbs().length > 0;
// Ana hattın kuyruğu takılı mı (hat şu an çözülemezken korunan dahil — açılıştan sonra bellekte kaydı olmayabilir: IFB'ye bakılır)
const primaryHeld = () => slots.has(IFB_DEV) || devExists(IFB_DEV);

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
async function runSteps(steps: SqmStep[]): Promise<void> {
  for (const s of steps) {
    if (s.unless === 'ifbmod' && fs.existsSync('/sys/module/ifb')) continue;
    if (s.unless === 'ifb' && devExists(s.argv[3])) continue;
    if (s.unless === 'ingress') {
      if ((await tcJson(['qdisc', 'show', 'dev', s.argv[4]])).some(q => q?.kind === 'ingress')) continue;
      markIngressOwned(s.argv[4]);
    }
    try { await runStep(s.argv); } catch (e: any) {
      if (!s.optional) throw e;
      console.warn(`[sqm] ${e.message} — devam ediliyor`);
    }
  }
}

// Açma / deneme: kendi kaynaklarımızın tamamı kaldırılır, hatlar sırayla kurulur; bir adım düşerse tümü kaldırılır (hiçbir
// şey takılı kalmaz). Ana hattın arayüzü yoksa kurulum düşer (G1.1-A ile aynı); yedek hattınki yoksa (USB takılı değil,
// pppbak düştü) atlanır — gelince uzlaştırma takar. skipAbsentPrimary: yedek hattayken yedek hat bandı denenirken ana hattın
// arayüzü yoksa (PPPoE düştü) o da atlanır — deneme kullanılan hattı (yedek) sınar. keepPrimary: yedek hattayken ana hat şu
// an çözülemiyor (tek bacakta modem yanıt vermiyor — hold): ana hattın takılı kuyruğuna dokunulmaz, yalnız yedek hatların
// kaynakları kaldırılıp yeniden kurulur (düşerse yine tümü kaldırılır).
async function installAll(plans: SqmPlan[], skipAbsentPrimary = false, keepPrimary = false): Promise<void> {
  if (!keepPrimary) await clearOwn();
  try {
    if (keepPrimary) {
      for (const p of plans.slice(1)) {
        const devs = [...new Set([slots.get(p.ifb)?.dev, p.line?.dev].filter((d): d is string => !!d))];
        slots.delete(p.ifb);
        for (const d of devs.length ? devs : ['']) await clearLine(d, p.ifb);
      }
    }
    for (const p of plans) {
      if (!p.steps.length || !p.line) continue;
      if ((p.line.role === 'backup' || skipAbsentPrimary) && !devExists(p.line.dev)) continue;
      await runSteps(p.steps);
      slots.set(p.ifb, slotOf(p.line));
    }
  } catch (e) {
    await clearOwn().catch(() => {});
    throw e;
  }
  lastAppliedAt = Date.now();
}
// Uzlaştırma: tek hat yeniden kurulur (önce yalnız o hattın kaynakları kalkar); düşerse yalnız o hat kaldırılır.
async function installLine(p: SqmPlan): Promise<void> {
  const line = p.line!;
  slots.delete(p.ifb);
  await clearLine(line.dev, p.ifb);
  try {
    await runSteps(p.steps);
  } catch (e) {
    await clearLine(line.dev, p.ifb).catch(() => {});
    throw e;
  }
  slots.set(p.ifb, slotOf(line));
  lastAppliedAt = Date.now();
}

// Tek bacak / br0: modem (varsayılan ağ geçidi) ve MAC'i. readDefaultRoute en düşük metrikli rotayı verir — yedek hatta
// geçilmişken (metrik 10) o yedek hattınkidir: o zaman sabit adres düzeninin kayıtlı ağ geçidi (durum dosyası gw) kullanılır.
// MAC komşu tablosundan (ev ağı arayüzünde, FAILED / INCOMPLETE değil); okunamazsa mac ''.
async function readModem(ns: NetModeState, lanDev: string): Promise<{ ip: string; mac: string } | null> {
  const [route, neigh] = await Promise.all([readDefaultRoute(), readNeighbors()]);
  const ip = route && route.dev === lanDev ? route.ip : ns.gw;
  if (!ip) return null;
  const n = neigh.get(ip);
  const mac = n && n.dev === lanDev && !['FAILED', 'INCOMPLETE'].includes(n.state) && unicastMac(n.mac) ? n.mac : '';
  // Pi'nin kendi kartının MAC'i modem sayılmaz (bozuk komşu kaydı)
  const own = new Set<string>();
  try { for (const d of fs.readdirSync('/sys/class/net')) { try { own.add(fs.readFileSync(`/sys/class/net/${d}/address`, 'utf8').trim().toLowerCase()); } catch { /* */ } } } catch { /* */ }
  return { ip, mac: own.has(mac) ? '' : mac };
}
// br0: modemin MAC'inin öğrenildiği köprü portu (bridge fdb; köprünün kendi / kalıcı kayıtları değil).
async function readBridgePort(mac: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('bridge', ['-j', 'fdb', 'show', 'br', HOME_BRIDGE], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const rows = JSON.parse(String(stdout).trim() || '[]');
    const e = (Array.isArray(rows) ? rows : []).find((r: any) => String(r?.mac || '').toLowerCase() === mac && r?.master === HOME_BRIDGE
      && typeof r?.ifname === 'string' && r.ifname !== HOME_BRIDGE && r.state !== 'permanent' && !(r.flags || []).includes('self'));
    return e && IFNAME.test(e.ifname) ? e.ifname : null;
  } catch { return null; }
}
// USB kimliği: arayüzün aygıtı (USB arayüzü, ör. 1-1:1.0) → üst dizindeki USB aygıtının idVendor / idProduct (+ seri
// numarası varsa özeti). Adı değişse de, yeniden takılsa da aynı kalır; başka model / başka cihazda değişir. USB değilse
// (sanal arayüz, PCI) ya da okunamazsa ''. sysNet: test için.
export function readUsbIdentity(dev: string, sysNet = '/sys/class/net'): string {
  try {
    const intf = fs.realpathSync(path.join(sysNet, dev, 'device'));
    const usbDev = fs.existsSync(path.join(intf, 'idVendor')) ? intf : path.dirname(intf);
    const rd = (f: string) => { try { return fs.readFileSync(path.join(usbDev, f), 'utf8').trim(); } catch { return ''; } };
    const vid = rd('idVendor').toLowerCase(), pid = rd('idProduct').toLowerCase(), serial = rd('serial');
    if (!/^[0-9a-f]{4}$/.test(vid) || !/^[0-9a-f]{4}$/.test(pid)) return '';
    return `${vid}:${pid}${serial ? `#${shortHash(serial)}` : ''}`;
  } catch { return ''; }
}
// Yedek hat (USB, grup 77): şu an varsayılan rotası (NetworkManager profili, metrik 900 / geçişte 10) olan arayüz + sürücüsü
// + USB kimliği.
async function readUsbBackup(ns: NetModeState): Promise<{ dev: string; driver: string; usbId: string } | null> {
  const cands = backupIfaces(ns).filter(d => IFNAME.test(d));
  if (!cands.length) return null;
  let routes: any[] = [];
  try { routes = JSON.parse(String((await execFileP('ip', ['-j', '-4', 'route', 'show', 'default'], { timeout: 5000 })).stdout).trim() || '[]'); } catch { routes = []; }
  const dev = cands.find(d => (Array.isArray(routes) ? routes : []).some((r: any) => r?.dev === d));
  if (!dev) return null;
  let driver = '-';
  try { driver = path.basename(fs.readlinkSync(`/sys/class/net/${dev}/device/driver`)); } catch { /* sanal / bilinmiyor */ }
  return { dev, driver, usbId: readUsbIdentity(dev) };
}
// Wi-Fi yedek hattın ağ adı (net-mode.sh durum dosyası bak_ssid — system.ts readNetModeState bu alanı okumaz; aynı
// ayrıştırma ve wan_ssid ile aynı doğrulama). Yoksa ''.
const NET_STATE = '/etc/pi5-gateway/net/state';
function readBakSsid(): string {
  let v = '';
  try {
    for (const l of fs.readFileSync(NET_STATE, 'utf8').split('\n')) {
      const i = l.indexOf('=');
      if (i > 0 && l.slice(0, i).trim() === 'bak_ssid') v = l.slice(i + 1).trim();
    }
  } catch { /* dosya yok */ }
  return /^[^\x00-\x1f\x7f]{1,32}$/.test(v) ? v : '';
}

async function planEnv(): Promise<SqmPlanEnv> {
  const satellite = isSatellite();
  const ns = readNetModeState();
  const lite = (await readPlatform().catch(() => null))?.profile === 'lite';
  const facts: SqmLiveFacts = {};
  if (isLinux && !satellite && ns) {
    // Canlı okumalar yalnız gereken kipte (internet kartı kiplerinde hiçbiri — G1.1-A ile aynı çağrılar)
    const lanDev = oneArmLanDev(ns);
    if (lanDev) {
      facts.modem = await readModem(ns, lanDev);
      if (lanDev === HOME_BRIDGE && facts.modem?.mac) facts.bridgePort = await readBridgePort(facts.modem.mac);
    }
    if (ns.bakStage === 'on' && ns.bakKind === 'usb') facts.backupUsb = await readUsbBackup(ns);
    if (ns.bakStage === 'on' && ns.bakKind === 'wifi') facts.backupSsid = readBakSsid();
  }
  return { satellite, ns, lite, facts };
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
// Yedek hattayken ana hat ölçülmez / denenmez: Ookla varsayılan rotayı (yedek hattı) ölçer, sonuç ana hattın imzasıyla
// kaydedilip ana hat geri gelince onu yanlış bantla kısardı.
const BACKUP_MSG = 'Şu an yedek hattasınız — ana hat için ölçüm ve deneme ana hatta dönünce yapılabilir';
const BACKUP_MEASURE_MSG = 'Yedek hat yalnız yedek hattayken ölçülebilir (şimdi Ookla ana hattı ölçer) — bandı elle girin ya da yedek hatta geçilince ölçün';

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
  backupBlockKey = '';
  // Zamanlayıcı ya çalıştı ya birazdan çalışacak: önce durdurulur (iki kaldırma aynı anda koşmasın), sonra burada kaldırılır.
  await stopRollback();
  let err = '';
  try { await clearOwn(); } catch (e: any) { err = e.message; }
  lastError = err;
  lastBackupError = '';
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
  backupBlockKey = '';
  takeOffFlag(); // kapalıyken kalmış işaret sonraki açmayı kapatmasın
  await stopRollback();
  let err = '';
  if (isLinux) { try { await clearOwn(); } catch (e: any) { err = e.message; } }
  lastError = err;
  lastBackupError = '';
  if (was || err) {
    const what = kind === 'rollback' ? 'denemesi geri alındı' : kind === 'satellite' ? 'kapatıldı (cihaz uydu oluyor)'
      : kind === 'ssh' ? "kapatıldı (SSH'tan sqm.sh off)" : 'kapatıldı';
    await recordEvent('bandwidth', `Akıllı kuyruk ${what} — hat eski hâlinde${err ? ` (${err})` : ''}`, err ? 'warning' : 'info');
  }
  return err;
}

// Şu an çözülemeyen (hold) hatların olası kaynakları: ana hat (modem MAC'i / köprü portu okunamıyor) → ev ağı kartı (br0'da
// köprünün portları) + ifb-klx0; yedek hat (USB takılı değil) → yalnız IFB'si (arayüzü yok).
function heldResources(plans: SqmPlan[], ns: NetModeState | null): { devs: Set<string>; ifbs: Set<string> } {
  const devs = new Set<string>(), ifbs = new Set<string>();
  for (const p of plans) {
    if (!p.hold) continue;
    ifbs.add(p.ifb);
    if (p.ifb !== IFB_DEV) continue;
    const lanDev = oneArmLanDev(ns);
    if (lanDev === HOME_BRIDGE) {
      try { for (const d of fs.readdirSync(`/sys/class/net/${HOME_BRIDGE}/brif`)) if (IFNAME.test(d)) devs.add(d); } catch { /* köprü yok */ }
    } else if (lanDev) devs.add(lanDev);
  }
  return { devs, ifbs };
}
// Açılışta (bellekte kayıt yok) önceki süreçten kalan ve artık istenmeyen kaynak var mı (durum dosyası backend kapalıyken
// değişti): varsa tamamı kaldırılır, istenenler uzlaştırmada yeniden takılır. Takılı ve istenen hat dokunulmadan kalır
// (deneme sürerken backend'in yeniden başlaması kuyruğu yeniden kurmaz). Şu an çözülemeyen (hold) hattın kaynakları da
// kalır (yedek hattayken modem yanıt vermiyorken backend yeniden başlarsa takılı kuyruk kalkmasın): karar hat çözülünce
// verilir — o zamana kadar her turda yeniden bakılır.
async function adoptLeftovers(plans: SqmPlan[], ns: NetModeState | null): Promise<void> {
  adopted = true;
  let out = '';
  try { out = String((await execFileP('bash', [SQM_SCRIPT, 'status'], { timeout: 30000 })).stdout); } catch { return; }
  const kv = Object.fromEntries(out.split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  if (kv.installed !== '1') return;
  const want = plans.filter(p => p.steps.length && p.line);
  const devs = new Set(want.map(p => p.line!.dev)), ifbs = new Set(want.map(p => p.ifb));
  const held = heldResources(plans, ns);
  const list = (s: string | undefined) => (s || '').split(' ').filter(Boolean);
  const devList = [...list(kv.root_devs), ...list(kv.filter_devs)], ifbList = list(kv.ifb);
  if (devList.some(d => !devs.has(d) && !held.devs.has(d)) || ifbList.some(i => !ifbs.has(i) && !held.ifbs.has(i))) {
    console.log('[sqm] önceki çalışmadan kalan kuyruk kaynakları kaldırılıyor (hat değişmiş)');
    await clearOwn();
    return;
  }
  // Yalnız çözülemeyen hattın kaynakları duruyor: dokunulmaz, sonraki turda yeniden bakılır.
  if (devList.some(d => !devs.has(d)) || ifbList.some(i => !ifbs.has(i))) adopted = false;
}

// Açıkken: süresi dolan deneme kapatılır; HAT BAŞINA: hat ve ayar uyuyorsa canlı durum denetlenir, yalnız sapan hat yeniden
// kurulur; uymuyorsa (hat değişti / desteklenmeyen kip) o hattın kaynakları kaldırılır ve bir kez uyarılır. Hat şu an
// çözülemiyorsa (modem MAC'i, köprü portu, USB arayüzü) takılı olan kalır.
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
  const env = await planEnv();
  const plans = buildAllPlans(env, cfg);
  if (!adopted) await adoptLeftovers(plans, env.ns);
  // 1) Artık istenmeyen ya da arayüzü değişen hat: yalnız onun kaynakları kaldırılır (diğer hatlar dokunulmadan sürer).
  for (const [ifb, s] of [...slots]) {
    const p = plans.find(x => x.ifb === ifb);
    if (p?.hold) continue;
    if (!p || !p.steps.length || p.line!.dev !== s.dev) {
      slots.delete(ifb);
      await clearLine(s.dev, ifb);
      if (s.role === 'backup' && p && !p.steps.length && p.code !== 'off') {
        const key = `${p.code}|${p.line?.sig || ''}`;
        if (key !== backupBlockKey) {
          backupBlockKey = key;
          await recordEvent('bandwidth', `Yedek hat kuyruğu kaldırıldı: ${p.reason}`, 'warning');
        }
      }
    }
  }
  // Bellekte kaydı olmayan ve artık istenmeyen IFB (önceki kurulumdan; hattın arayüzü gitti, hat değişti ya da yedek hat
  // kaldırıldı): kaldırılır. İstenen (kurulacak) ya da şu an çözülemeyen (hold) hattınkine dokunulmaz.
  for (const ifb of ownIfbs()) {
    if (slots.has(ifb)) continue;
    const p = plans.find(x => x.ifb === ifb);
    if (p && (p.hold || p.steps.length)) continue;
    await clearLine('', ifb);
  }
  // Ana hat takılamıyor (hat değişti / desteklenmiyor): bir kez uyarı.
  const primary = plans[0];
  let primaryErr: any = null;
  if (!primary.steps.length) {
    if (primary.hold) {
      lastError = primaryHeld() ? `${primary.reason} — takılı kuyruk korunuyor` : primary.reason;
    } else {
      const key = `${primary.code}|${primary.line?.sig || ''}`;
      if (key !== blockKey) {
        blockKey = key;
        lastError = '';
        const what = primary.code === 'mismatch' ? `internet hattı değişti (${primary.line?.label || 'yeni hat'})` : primary.reason;
        await recordEvent('bandwidth', `Akıllı kuyruk takılmadı: ${what} — Bant Genişliği → Gecikme'den bandı yeniden ölçüp kaydedin`, 'warning');
      }
    }
  }
  // 2) İstenen hatlar: sağlamsa dokunulmaz; arayüz yoksa (PPPoE yeniden arıyor, USB çıkarıldı) gelince takılır — o ana kadar
  // kuyruksuz (= bugünkü davranış), olay yok; sapmışsa yalnız o hat yeniden kurulur.
  for (const p of plans) {
    if (!p.steps.length || !p.line || !p.settings) continue;
    const line = p.line, isPrimary = line.role === 'primary';
    const live = await readLive(line);
    if (liveIntact(live, p.settings, !!line.modemMac)) {
      slots.set(p.ifb, slots.get(p.ifb) || slotOf(line));
      if (isPrimary) { lastError = ''; blockKey = ''; } else { lastBackupError = ''; backupBlockKey = ''; }
      continue;
    }
    if (!live.devExists) {
      slots.delete(p.ifb);
      const msg = `${line.dev} arayüzü şu an yok — gelince kuyruk yeniden takılır`;
      if (isPrimary) lastError = msg; else lastBackupError = msg;
      continue;
    }
    const was = slots.has(p.ifb);
    try {
      await installLine(p);
    } catch (e: any) {
      if (isPrimary) { primaryErr = e; continue; }
      lastBackupError = e?.message || String(e);
      console.warn(`[sqm] yedek hat: ${lastBackupError}`);
      void recordEventOnce('bandwidth', `Yedek hat kuyruğu uygulanamadı: ${lastBackupError}`, 'warning', 360);
      continue;
    }
    if (isPrimary) {
      lastError = '';
      if (blockKey) await recordEvent('bandwidth', `Akıllı kuyruk yeniden takıldı (${line.label})`);
      else if (was) console.log(`[sqm] kuyruk yeniden kuruldu (${line.dev}: arayüz yeniden kuruldu ya da kuyruk dışarıdan silindi)`);
      blockKey = '';
    } else {
      lastBackupError = '';
      backupBlockKey = '';
      console.log(`[sqm] yedek hat kuyruğu kuruldu (${line.label})`);
    }
  }
  if (primaryErr) throw primaryErr;
}

// ─── İşlemler ───

async function requireLine(): Promise<{ env: SqmPlanEnv; line: SqmLine }> {
  if (!isLinux) throw new SqmError(409, 'Akıllı kuyruk yalnız Pi üzerinde çalışır');
  const env = await planEnv();
  const r = resolveSqmLine(env.ns, env.satellite, env.facts);
  if (r.code !== 'ok') throw new SqmError(409, r.reason);
  return { env, line: r.line };
}

let modCache: { at: number; mods: Record<string, boolean> } | null = null;
// Gerekli çekirdek modülleri (sınıflı kipte prio / flower / fq_codel da). 10 dk önbellek.
async function kernelModules(classed = false): Promise<Record<string, boolean>> {
  const names: string[] = [...SQM_MODULES, ...(classed ? ONEARM_MODULES : [])];
  if (!modCache || Date.now() - modCache.at >= 600000) modCache = { at: Date.now(), mods: {} };
  const miss = names.filter(m => !(m in modCache!.mods));
  const vals = await Promise.all(miss.map(m => hasModule(m)));
  miss.forEach((m, i) => { modCache!.mods[m] = vals[i]; });
  return Object.fromEntries(names.map(m => [m, modCache!.mods[m]]));
}

// Deneme: zamanlayıcı → ayar → kurulum (ana + yedek hatlar). Kurulamazsa zamanlayıcı durur, ayar kapanır (hiçbir şey takılı
// kalmaz). allowOnBackup: yedek hat bandı değişikliği yedek hattayken de denenebilir (deneme tam o hattı sınar) — ana hat şu
// an çözülemese de (tek bacakta modem yanıt vermiyor: hold); o zaman ana hattın takılı kuyruğuna dokunulmaz.
async function startTrial(cfg: SqmConfig, env: SqmPlanEnv, line: SqmLine, why: string, allowOnBackup = false): Promise<number> {
  const next: SqmConfig = { ...cfg, enabled: true };
  const plans = buildAllPlans(env, next);
  const plan = plans[0];
  const keepPrimary = allowOnBackup && !plan.steps.length && !!plan.hold && onBackupLine(env.ns) && plans.slice(1).some(p => p.steps.length > 0);
  if (!plan.steps.length && !keepPrimary) throw new SqmError(409, plan.reason);
  if (!onPath('tc')) throw new SqmError(409, 'tc (iproute2) kurulu değil — sudo apt install iproute2');
  const missing = Object.entries(await kernelModules(!!line.modemMac)).filter(([, ok]) => !ok).map(([m]) => m);
  if (missing.length) throw new SqmError(409, `Çekirdekte gerekli modül yok: ${missing.join(', ')}`);
  // Yedek hattayken trafik ana hat arayüzünden geçmez: deneme sınanamaz (kuyruk boştaki hatta takılırdı).
  if (!allowOnBackup && onBackupLine(env.ns)) throw new SqmError(409, BACKUP_MSG);
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
    await installAll(plans, allowOnBackup && onBackupLine(env.ns), keepPrimary);
  } catch (e: any) {
    await stopRollback();
    await writeConfig({ ...next, enabled: false, trialUntil: 0 }).catch(() => {});
    lastError = e.message;
    await recordEvent('bandwidth', `Akıllı kuyruk açılamadı, geri alındı: ${e.message}`, 'warning');
    throw new SqmError(500, `Kuyruk takılamadı, geri alındı: ${e.message}`);
  }
  lastError = '';
  lastBackupError = '';
  blockKey = '';
  backupBlockKey = '';
  // Ana hattın korunan kaynakları kaldırılmadı: açılıştaki denetim (hat çözülünce) sürer
  if (!keepPrimary) adopted = true;
  scheduleExpiry(until);
  ensureTicking(true);
  const p = next.primary!;
  const bk = plans.slice(1).filter(x => x.steps.length && x.settings && x.line)
    .map(x => ` · ${x.line!.label}: ↓${fmtMbps(x.settings!.downKbit)} ↑${fmtMbps(x.settings!.upKbit)}`).join('');
  const head = keepPrimary ? `ana hat şu an çözülemiyor (${plan.code === 'noport' ? 'köprü portu' : "modem MAC'i"} bekleniyor — ana hat kuyruğuna dokunulmadı)`
    : `${line.label} — ↓${fmtMbps(p.downKbit)} ↑${fmtMbps(p.upKbit)}`;
  await recordEvent('bandwidth', `Akıllı kuyruk ${why}: ${head}${bk}. 5 dk içinde "Kalıcı yap"a basılmazsa kaldırılır`);
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

// Yedek hat bandı (G1.1-C): şu anki yedek hattın imzasıyla kaydedilir. Kuyruk açıksa 5 dk'lık deneme yeniden başlar (yedek
// hattayken de — deneme tam o hattı sınar).
export function saveBackupLine(patch: Pick<SqmLineSettings, 'downKbit' | 'upKbit' | 'overhead'>): Promise<{ trialUntil: number }> {
  return serial(async () => {
    if (!isLinux) throw new SqmError(409, 'Akıllı kuyruk yalnız Pi üzerinde çalışır');
    if (calibrating) throw new SqmError(409, 'Ölçüm sürüyor — bitince kaydedin');
    const env = await planEnv();
    const pr = resolveSqmLine(env.ns, env.satellite, env.facts);
    const b = resolveBackupLines(env.ns, env.satellite, env.facts, pr.line?.dev || '')[0];
    if (!b) throw new SqmError(409, 'Yedek hat kurulu değil (Cihaz Rolleri → Yedek hat)');
    if (!b.line) throw new SqmError(409, b.reason);
    const cfg = (await readConfig()) || { enabled: false, trialUntil: 0, primary: null };
    const entry: SqmLineSettings = { sig: b.line.sig, ...patch, savedAt: nowS() };
    const next: SqmConfig = { ...cfg, backup: [entry, ...(cfg.backup || []).filter(x => x.sig !== entry.sig)].slice(0, MAX_BACKUP_ENTRIES) };
    if (cfg.enabled) {
      // Ana hat çözülemiyor (tek bacakta modem yanıt vermiyor) ama yedek hattayız: deneme yalnız yedek hattı sınar
      const held = (pr.code === 'nomac' || pr.code === 'noport') && onBackupLine(env.ns);
      if (pr.code !== 'ok' && !held) {
        throw new SqmError(409, `Ana hat: ${pr.reason} — yedek hat bandı şimdi denenemez (akıllı kuyruk kapalıyken kaydedilebilir)`);
      }
      return { trialUntil: await startTrial(next, env, pr.line || b.line, 'yedek hat bandıyla yeniden denemede', true) };
    }
    await writeConfig({ ...next, enabled: false, trialUntil: 0 });
    await recordEvent('bandwidth', `Yedek hat bandı kaydedildi: ${b.line.label} — ↓${fmtMbps(patch.downKbit)} ↑${fmtMbps(patch.upKbit)} (kuyruk kapalı)`);
    return { trialUntil: 0 };
  });
}

// Yedek hat kuyruğunu kaldır: şu anki yedek hattın bandı silinir (yedek hat yoksa tüm yedek hat kayıtları); kuyruk açıksa
// yalnız o hattın kuyruğu kalkar (kaldırmak hattı bugünkü hâline döndürür — deneme gerekmez).
export function removeBackupLine(): Promise<void> {
  return serial(async () => {
    const cfg = await readConfig();
    if (!cfg?.backup?.length) throw new SqmError(409, 'Yedek hat için kayıtlı bant yok');
    const env = isLinux ? await planEnv() : { satellite: isSatellite(), ns: null, lite: false, facts: {} };
    const pr = resolveSqmLine(env.ns, env.satellite, env.facts);
    const b = resolveBackupLines(env.ns, env.satellite, env.facts, pr.line?.dev || '')[0];
    const backup = b?.line ? cfg.backup.filter(x => x.sig !== b.line!.sig) : [];
    await writeConfig({ ...cfg, backup });
    let err = '';
    for (const [ifb, s] of [...slots]) {
      if (s.role !== 'backup') continue;
      slots.delete(ifb);
      try { await clearLine(s.dev, ifb); } catch (e: any) { err = e.message; }
    }
    lastBackupError = err;
    backupBlockKey = '';
    await recordEvent('bandwidth', `Yedek hat kuyruğu kaldırıldı${b?.line ? `: ${b.line.label}` : ''} — yedek hat kuyruksuz${err ? ` (${err})` : ''}`, err ? 'warning' : 'info');
    if (err) throw new SqmError(500, `Bant silindi ama ${err}`);
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
    const env = await planEnv();
    const plans = buildAllPlans(env, cfg);
    const plan = plans[0];
    // Yedek hattayken ana hattın arayüzü yoksa (PPPoE düştü) ana hat kuyruğu gelince takılır; ana hat şu an çözülemiyorsa
    // (tek bacakta modem yanıt vermiyor — hold) takılı kuyruğu korunur: onay kullanılan (yedek) hattın kuyruğuna bakar — o da
    // yoksa onaylanmaz.
    const backups = plans.slice(1).filter(b => b.steps.length && b.line && b.settings && devExists(b.line.dev));
    const primaryAway = onBackupLine(env.ns) && backups.length > 0
      && (!!plan.hold || (plan.steps.length > 0 && !!plan.line && !devExists(plan.line.dev)));
    if (!primaryAway && (!plan.steps.length || !liveIntact(await readLive(plan.line!), cfg.primary!, !!plan.line!.modemMac))) {
      throw new SqmError(409, 'Kuyruk takılı değil — deneme sürüyor, süre dolunca kapanır');
    }
    // Yedek hat kuyruğu: arayüzü varsa takılı olmalı (yoksa — USB takılı değil — gelince takılır)
    for (const b of backups) {
      if (!liveIntact(await readLive(b.line!), b.settings!, false)) {
        throw new SqmError(409, `Yedek hat kuyruğu takılı değil (${b.line!.dev}) — deneme sürüyor, süre dolunca kapanır`);
      }
    }
    // Önce zamanlayıcı (durmazsa kalıcı yapılmaz), sonra ayar: ayar yazılamazsa backend süre dolunca yine kapatır.
    await stopRollback();
    if (await rollbackArmed()) throw new SqmError(500, 'Geri alma zamanlayıcısı durdurulamadı — deneme sürüyor');
    await writeConfig({ ...cfg, trialUntil: 0 });
    clearExpiry();
    ensureTicking(true);
    const bk = plans.slice(1).filter(x => x.steps.length && x.settings && x.line)
      .map(x => ` · ${x.line!.label}: ↓${fmtMbps(x.settings!.downKbit)} ↑${fmtMbps(x.settings!.upKbit)}`).join('');
    await recordEvent('bandwidth', `Akıllı kuyruk kalıcı yapıldı: ${plan.line ? plan.line.label : 'ana hat (şu an çözülemiyor)'} — ↓${fmtMbps(cfg.primary!.downKbit)} ↑${fmtMbps(cfg.primary!.upKbit)}${bk}`);
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
// değiştirilince öneri de değişir); suggestion: istekteki ya da kayıtlı tür (yoksa ethernet). target 'backup': yedek hat —
// yalnız yedek hattayken (Ookla varsayılan rotayı, yani yedek hattı ölçer); ana hat yalnız ana hattayken.
export interface SqmDeps {
  measure: () => Promise<SpeedResult>;                  // index.ts measureAndStore — tek ölçüm yolu
  idle: () => Promise<void>;                            // süren hız testi bitene kadar
  isLoopback: (ip: string | undefined) => boolean;      // index.ts isLoopbackClient
}
export const SUGGEST_PCT = 90;
export const suggestKbit = (mbps: number, eff = 1) =>
  Math.min(MAX_KBIT, Math.max(MIN_KBIT, Math.floor((mbps * 1000 * SUGGEST_PCT) / 100 / eff / 100) * 100));
type Suggestion = { downKbit: number; upKbit: number; pct: number };
export function calibrate(deps: SqmDeps, overhead?: SqmOverhead, target: 'primary' | 'backup' = 'primary'): Promise<{
  result: SpeedResult; bypassed: boolean; overhead: SqmOverhead; suggestion: Suggestion; suggestions: Record<SqmOverhead, Suggestion>; target: 'primary' | 'backup';
}> {
  return serial(async () => {
    let line: SqmLine;
    let o: SqmOverhead;
    if (target === 'backup') {
      if (!isLinux) throw new SqmError(409, 'Akıllı kuyruk yalnız Pi üzerinde çalışır');
      const env = await planEnv();
      const pr = resolveSqmLine(env.ns, env.satellite, env.facts);
      const b = resolveBackupLines(env.ns, env.satellite, env.facts, pr.line?.dev || '')[0];
      if (!b) throw new SqmError(409, 'Yedek hat kurulu değil (Cihaz Rolleri → Yedek hat)');
      if (!b.line) throw new SqmError(409, b.reason);
      if (!onBackupLine(env.ns)) throw new SqmError(409, BACKUP_MEASURE_MSG);
      line = b.line;
      o = overhead || (await readConfig())?.backup?.find(x => x.sig === b.line!.sig)?.overhead || 'ethernet';
    } else {
      const r = await requireLine();
      if (onBackupLine(r.env.ns)) throw new SqmError(409, BACKUP_MSG);
      line = r.line;
      o = overhead || (await readConfig())?.primary?.overhead || 'ethernet';
    }
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
      return { result, bypassed, overhead: o, suggestion: suggestions[o], suggestions, target };
    } finally {
      calibrating = false;
      await reconcile().catch(onBgError); // açıksa 15 sn beklemeden geri takılır
    }
  });
}

// ─── Durum ───

// Tek bacak / br0: modem ev ağına IPv6 dağıtıyor mu (RA: varsayılan rota + SLAAC / DHCPv6) — dağıtıyorsa cihazların IPv6
// trafiği Pi'ye uğramadan doğrudan modeme gider, kuyruğa girmez. sqm.sh ra-probe (Router Solicitation gönderir, 3 sn Router
// Advertisement dinler; salt okunur, adres / rotaya dokunmaz). Yalnız durum okunurken (sayfa açıkken), arka planda — durum
// beklemez; sonuç 10 dk önbellekte. null: bilinmiyor (henüz bakılmadı / denenemedi).
let raCache: { dev: string; at: number; ra: boolean | null } | null = null;
let raRunning = false;
const RA_TTL_MS = 600000;
function ipv6Bypass(dev: string): boolean | null {
  if (!isLinux || !IFNAME.test(dev)) return null;
  if ((!raCache || raCache.dev !== dev || Date.now() - raCache.at >= RA_TTL_MS) && !raRunning) {
    raRunning = true;
    void execFileP('bash', [SQM_SCRIPT, 'ra-probe', dev], { timeout: 15000 })
      .then(({ stdout }) => {
        const ra = String(stdout).split('\n').find(l => l.startsWith('ra='))?.slice(3).trim();
        raCache = { dev, at: Date.now(), ra: ra === '1' ? true : ra === '0' ? false : null };
      })
      .catch(() => { raCache = { dev, at: Date.now(), ra: null }; })
      .finally(() => { raRunning = false; });
  }
  return raCache && raCache.dev === dev ? raCache.ra : null;
}

export async function sqmStatus(): Promise<Record<string, unknown>> {
  const cfg = await readConfig();
  const env = isLinux ? await planEnv() : { satellite: isSatellite(), ns: null, lite: false, facts: {} as SqmLiveFacts };
  const r = isLinux ? resolveSqmLine(env.ns, env.satellite, env.facts)
    : { code: 'invalid' as const, line: null, reason: 'Akıllı kuyruk yalnız Pi üzerinde çalışır' };
  const line = r.line;
  const lanDev = isLinux ? oneArmLanDev(env.ns) : '';
  const classed = !!line?.modemMac || (!line && !!lanDev);
  const mods = isLinux ? await kernelModules(classed) : {};
  const missing = Object.keys(mods).filter(m => !mods[m]);
  const tc = isLinux && onPath('tc');
  const p = cfg?.primary || null;
  const sigMatches = !!p && !!line && p.sig === line.sig;
  // Canlı okuma yalnız açıkken (ayar yokken / kapalıyken tc çağrılmaz).
  const live = cfg?.enabled && line ? await readLive(line) : null;
  const intact = !!live && !!p && sigMatches && liveIntact(live, p, !!line?.modemMac);
  const trialOn = !!cfg?.enabled && cfg.trialUntil > 0;
  const hold = r.code === 'nomac' || r.code === 'noport';
  // waiting: açık ama hat arayüzü şu an yok (PPPoE yeniden arıyor) ya da modem MAC'i / köprü portu şu an okunamıyor.
  const state = !line ? (hold && cfg?.enabled ? 'waiting' : 'unsupported') : !cfg?.enabled ? 'off' : !sigMatches ? 'mismatch'
    : calibrating ? 'calibrating' : intact ? (trialOn ? 'trial' : 'on') : live && !live.devExists ? 'waiting' : 'error';
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
  // Yedek hat (G1.1-C)
  const bres = isLinux ? resolveBackupLines(env.ns, env.satellite, env.facts, line?.dev || '')[0] : undefined;
  const bline = bres?.line || null;
  const bset = bline ? (cfg?.backup || []).find(x => x.sig === bline.sig) || null : null;
  const bslot = bres ? slots.get(bres.ifb) : undefined;
  let backup: Record<string, unknown> | null = null;
  // Yedek hat kuyruğu uygulanıyor (bant kayıtlı, açık, arayüzü var) ve takılı mı — "Kalıcı yap" kararında da (confirm ile aynı)
  const backupApplies = !!(cfg?.enabled && bset && bline && devExists(bline.dev));
  let bIntact = false;
  if (bres) {
    const blive = backupApplies ? await readLive(bline!) : null;
    bIntact = !!blive && !!bset && liveIntact(blive, bset, false);
    // absent: yedek hat arayüzü şu an yok (USB takılı değil) — imza (sürücü / USB kimliği) okunamadığından kayıtlı bant da bilinmez
    const bstate = !bline ? 'absent' : !bset ? 'unset' : !cfg?.enabled ? 'off' : !devExists(bline.dev) ? 'waiting' : bIntact ? 'on' : 'error';
    backup = {
      line: bline ? { dev: bline.dev, kind: bline.kind, label: bline.label, port: bline.port } : null,
      reason: bres.reason, ifb: bres.ifb, state: bstate, active: onBackup,
      config: bset && bline ? {
        downKbit: bset.downKbit, upKbit: bset.upKbit, overhead: bset.overhead, savedAt: bset.savedAt,
        overheadBytes: overheadArgs(bset.overhead, bline).bytes, efficiency: lineEfficiency(bset.overhead, bline),
      } : null,
      // kayıtlı bant başka bir yedek hatta ait (yedek hat değişti)
      otherSaved: !bset && !!cfg?.backup?.length,
      applied: bIntact && bslot ? { dev: bslot.dev, ifb: bres.ifb } : null,
      lastError: cfg?.enabled ? lastBackupError : '',
      overheadPreview: bline ? Object.fromEntries(OVERHEADS.map(o => [o, overheadArgs(o, bline).bytes])) : null,
      efficiencyPreview: bline ? Object.fromEntries(OVERHEADS.map(o => [o, lineEfficiency(o, bline)])) : null,
    };
    if (bline && !bset) {
      warnings.push(`Yedek hat kuyruksuz: yedek hat için bant girilmedi — yedek hatta geçilince hat kuyruksuz çalışır (aşağıdaki "Yedek hat kuyruğu" bölümü)${onBackup ? ' — şu an yedek hattasınız' : ''}`);
    } else if (onBackup && !bIntact) {
      warnings.push(`Yedek hat kuyruksuz: ${bres.reason || 'yedek hat kuyruğu şu an takılı değil'} — şu an yedek hattasınız`);
    }
  }
  // Tek bacak / br0: modem ev ağına IPv6 dağıtıyorsa (RA) cihazların IPv6 trafiği Pi'ye uğramaz — kuyruğa girmez
  if (lanDev && !env.satellite && ipv6Bypass(lanDev)) {
    warnings.push(`Modem ev ağına IPv6 dağıtıyor: ${lanDev === HOME_BRIDGE ? 'modemle aynı anahtardaki (kablolu) cihazların' : 'ev cihazlarının'} IPv6 trafiği Pi'ye uğramadan doğrudan modeme gider ve akıllı kuyruğa girmez — büyük bir IPv6 indirmesi / yüklemesi gecikmeyi yine artırır. Modemde ev ağı IPv6'sını (RA / SLAAC) kapatın`);
  }
  // Tek bacak / br0: modem ve yerel trafik notu
  const modem = lanDev && env.facts?.modem !== undefined ? {
    ip: env.facts.modem?.ip || env.ns?.gw || '', mac: env.facts.modem?.mac || '', lanDev, bridge: lanDev === HOME_BRIDGE,
    port: line?.modemMac ? line.dev : (lanDev === HOME_BRIDGE ? env.facts.bridgePort || '' : lanDev),
  } : null;
  // "Kalıcı yap" yapılabilir mi (confirm ile aynı karar): ana hat takılı — ya da yedek hattayken ana hat şu an yok (PPPoE düştü)
  // / çözülemiyor (modem yanıt vermiyor) ve yedek hat kuyruğu takılı (deneme kullanılan hattı sınar); yedek hat kuyruğu
  // uygulanıyorsa o da takılı olmalı.
  const primaryAway = onBackup && bIntact && (hold || (sigMatches && !!live && !live.devExists));
  const confirmable = trialOn && !calibrating && (state === 'trial' || primaryAway) && (!backupApplies || bIntact);
  return {
    supported: r.code === 'ok', code: r.code, reason: r.reason, satellite: env.satellite,
    line: line ? { dev: line.dev, kind: line.kind, label: line.label, nat: line.nat, port: line.port, l3: line.l3, classed: !!line.modemMac } : null,
    modem,
    tc, modules: mods, missingModules: isLinux ? missing : [], ready: isLinux && tc && missing.length === 0,
    configured: !!cfg, enabled: !!cfg?.enabled, trialUntil: trialOn ? cfg!.trialUntil : 0, now: nowS(), trialS: TRIAL_S,
    // Yedek hattayken ana hat için "Ölç" ve "Dene" kapalı (409): ölçüm yedek hattı ölçerdi, deneme sınanamazdı.
    onBackup,
    config: p ? {
      downKbit: p.downKbit, upKbit: p.upKbit, overhead: p.overhead, savedAt: p.savedAt, sigMatches,
      overheadBytes: line ? overheadArgs(p.overhead, line).bytes : null,
      // beklenen verim (hız testi / bant): "Kuyrukla hız testi" bununla karşılaştırılır
      efficiency: line ? lineEfficiency(p.overhead, line) : null,
    } : null,
    state, applied: intact ? { dev: line!.dev, ifb: IFB_DEV, at: lastAppliedAt ? Math.floor(lastAppliedAt / 1000) : null } : null,
    // held: ana hat şu an çözülemiyor (modem MAC'i / köprü portu) ama takılı kuyruğu korunuyor
    held: hold && !!cfg?.enabled && primaryHeld(), confirmable,
    calibrating, lastError: cfg?.enabled ? lastError || (hold ? r.reason : '') : '',
    rollbackArmed: trialOn && isLinux ? await rollbackArmed() : false,
    defaults: { overhead: 'ethernet', suggestPct: SUGGEST_PCT },
    limits: { minKbit: MIN_KBIT, maxKbit: MAX_KBIT },
    overheadPreview: line ? Object.fromEntries(OVERHEADS.map(o => [o, overheadArgs(o, line).bytes])) : null,
    efficiencyPreview: line ? Object.fromEntries(OVERHEADS.map(o => [o, lineEfficiency(o, line)])) : null,
    backup,
    warnings,
  };
}

// ─── Açılış / rol ───

// Açılış (ana cihaz): ayar yoksa hiçbir şey (tc yok). Kapalıysa yalnız kalmış kaynak varsa (ör. çökme) kaldırılır. SSH'tan
// sqm.sh off işareti varsa ayar kapatılır. Açıksa: süresi geçmiş deneme kapatılır; süren denemenin zamanlayıcısı yoksa
// (çalıştı ya da Pi yeniden başladı) deneme bitmiş sayılır — kuyruk zamanlayıcısız kurulmaz; varsa (yalnız backend yeniden
// başladı) aynı zamanlayıcıyla sürer. Sonra uzlaştırma (önceki süreçten kalan istenmeyen kaynak varsa önce temizlik) ve
// 15 sn'lik izleyici.
export function startSqm(): void {
  if (!isLinux) return;
  void serial(async () => {
    const cfg = await readConfig();
    const off = takeOffFlag();
    if (!cfg) return;
    if (off && cfg.enabled) { await turnOff(cfg, 'ssh'); return; }
    if (!cfg.enabled) {
      if (ownIfbs().length) await clearOwn();
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
  // Yedek hat bandı (G1.1-C): PUT kaydeder (açıksa yeni deneme), DELETE yedek hat kuyruğunu kaldırır.
  app.put('/api/bandwidth/sqm/backup', async (req, res) => {
    const v = validateLinePatch(req.body);
    if ('error' in v) return res.status(400).json({ error: v.error });
    try { res.json({ success: true, ...await saveBackupLine(v.line) }); } catch (e) { fail(res, e); }
  });
  app.delete('/api/bandwidth/sqm/backup', async (_req, res) => {
    try { await removeBackupLine(); res.json({ success: true }); } catch (e) { fail(res, e); }
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
  // Gövde: {} ya da { overhead } (sihirbazda seçili bağlantı türü — suggestion onunla; suggestions her tür için); { line:
  // 'backup' } yedek hattı ölçer (yalnız yedek hattayken).
  app.post('/api/bandwidth/sqm/calibrate', async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const o = b.overhead, target = b.line;
    if (o !== undefined && !isOverhead(o)) return res.status(400).json({ error: `Bağlantı türü şunlardan biri olmalı: ${OVERHEADS.join(', ')}` });
    if (target !== undefined && target !== 'primary' && target !== 'backup') return res.status(400).json({ error: "Hat 'primary' ya da 'backup' olmalı" });
    if (calibrating) return res.status(409).json({ error: 'Ölçüm zaten sürüyor' });
    try { res.json({ success: true, ...await calibrate(deps, o, target === 'backup' ? 'backup' : 'primary') }); } catch (e) { fail(res, e); }
  });
}

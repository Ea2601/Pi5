// Tak-çalıştır ağ kartı algılama (G1.4-A): yeni takılan ağ kartını (USB Ethernet, USB modem / telefon paylaşımı, SIM'li
// modem, USB Wi-Fi) bulur, olay geçmişine bir kez yazar ve panelde "rolünü seç" bandını açar. YALNIZ ALGILAMA: hiçbir rol
// kendiliğinden atanmaz, ağ ayarı değişmez — rol her zaman mevcut onaylı akışla (WAN router / yedek hat panelleri: deneme +
// "Kalıcı yap") uygulanır; sihirbaz yalnız o paneli kart seçili açar.
//  - Varsayılan KAPALI: app_settings 'hotplug_watch' (yalnız PUT /api/ports/settings yazar; genel ayar ucu yazamaz, yedekten
//    geri gelmez). Kapalıyken zamanlayıcı yok, /sys okunmaz, veritabanına yazılmaz.
//  - Açılınca önce takılı kartlar sessizce "bilinen" olur (taban çizgisi — bildirim yağmuru olmaz), sonra 10 sn'de bir
//    /sys/class/net okunur (readdir + küçük dosyalar). Süzgeç hardware.ts ile aynı; Wi-Fi radyo başına bir kart.
//  - Kimlik kalıcı MAC (`ip -j link show dev X` permaddr, yoksa adres; yalnız yeni kart için bir kez). Adresi her
//    bağlanışta değişen USB kartta (cardIdentity) USB aygıt kimliğinden türetilen sabit MAC. Aynı kart yeniden takılınca
//    bildirim yok; çıkarma yalnız last_seen'i günceller (rol kartlarının "kart bulunamadı" uyarısı aynen sürer).
//  - Aç / kapat tek sırada (serial): iki sekme ya da açılışla eşzamanlı istek zamanlayıcı sızdırmaz; durdurulan izleyicinin
//    süren turu (dönem: gen) hiçbir şey yazmaz.
//  - udev kuralı yok: yedek hattın 90-pi5-bak.rules / grup 77'siyle yarışmaz. Uyduda başlatılmaz (index.ts '!isSatellite').
//  - Olay 'info' önemde (events.ts okunmuş yazar): zil sayacı, OLED ve kiosk kirlenmez. Tek istisna: iki kart aynı MAC'i
//    taşıyorsa (ikincisi bildirilemez) bir kez 'warning'.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun } from './db';
import { recordEvent, recordEventOnce } from './events';
import { listNetCards, describeNetCard, readPermAddrs, type NetCard, type PortKind, type Bus } from './hardware';

const execFileP = promisify(execFile);
export const HOTPLUG_KEY = 'hotplug_watch';
const INTERVAL_MS = 10000;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
export type PortState = 'pending' | 'known' | 'dismissed';

type Live = { mac: string; card: NetCard };
// opts yalnız test içindir: sahte /sys kökü, kısa aralık, hazır kalıcı MAC okuyucu.
type Cfg = { root: string; intervalMs: number; permAddrs: (dev: string) => Promise<Map<string, string>> };
const DEFAULT_CFG: Cfg = { root: '', intervalMs: INTERVAL_MS, permAddrs: readPermAddrs };
let cfg: Cfg = DEFAULT_CFG;
let timer: ReturnType<typeof setInterval> | null = null;
// Kart anahtarı (ad#ifindex / phy) → kimlik + ayrıntı: ayrıntı ve kalıcı MAC yalnız yeni anahtarda okunur.
const byKey = new Map<string, Live>();
// Şu an takılı kartlar (kalıcı MAC → kart): giriş / çıkış geçişlerinde veritabanına yazılır, her turda değil.
let present = new Map<string, Live>();
// Kapatılınca artar: kapatma sırasında süren tur sonuç yazmaz.
let gen = 0;
let scanning: { gen: number; p: Promise<number> } | null = null;
// Aynı MAC'i taşıyan iki kart (ucuz klon adaptörler): bu izleyici oturumunda uyarısı yazılmış çiftler.
const dupWarned = new Set<string>();

export async function portWatchEnabled(): Promise<boolean> {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [HOTPLUG_KEY]).catch(() => null);
  return row?.value === '1';
}
export const portWatchRunning = () => timer !== null;

const busText = (c: { bus: Bus; usbSpeedMbps: number | null }) =>
  c.bus === 'usb' ? (c.usbSpeedMbps === null ? 'USB' : c.usbSpeedMbps >= 5000 ? 'USB 3' : 'USB 2') : 'dahili';
// "Yeni ağ kartı: eth1 (USB 3, r8152, 1000 Mbps, kablo bağlı)". Hız ve kablo yalnız bağlantı varken: yeni takılan kart
// ilk saniyelerde kapalı ya da anlaşmada olur — "kablo takılı değil" olay geçmişinde kalıcı yanıltırdı (güncel durum
// sihirbazda).
export function hotplugMessage(c: NetCard): string {
  const parts = [busText(c), c.driver || 'sürücü bilinmiyor'];
  if (c.kind === 'usb-modem') parts.push('USB modem / telefon');
  else if (c.kind === 'wwan') parts.push("SIM'li modem — desteklenmiyor");
  else if (c.kind === 'wifi') parts.push('Wi-Fi');
  else if (c.carrier === true) {
    if (c.speedMbps) parts.push(`${c.speedMbps} Mbps`);
    parts.push('kablo bağlı');
  }
  return `Yeni ağ kartı: ${c.name} (${parts.join(', ')})`;
}

// USB aygıt kimliğinden türetilen sabit, yerel yönetimli MAC (02:…): /api/ports/:mac ve MAC_RE aynen çalışır.
export const usbIdMac = (usbId: string) => `02:${createHash('sha1').update(`usb:${usbId}`).digest('hex').slice(0, 10).replace(/(..)(?!$)/g, '$1:')}`;
// Kalıcı MAC'i (permaddr) olmayan kablolu kartın kimliği. Adresi her bağlanışta değişen USB kartta — çekirdek rastgele
// verdi (addrRandom: ZTE cdc_ether, geçersiz EEPROM) ya da USB modem / telefonun yerel yönetimli adresi (Android RNDIS /
// NCM paylaşımı her açılışta yeni adres alır) — USB aygıt kimliği (üretici:ürün + seri no; seri yoksa port yolu); aksi
// halde geçerli adres. Böylece aynı modem her takılışta yeni kart sayılmaz.
export function cardIdentity(c: Pick<NetCard, 'mac' | 'bus' | 'kind' | 'usbId' | 'addrRandom'>): string {
  if (c.bus !== 'usb' || !c.usbId) return c.mac;
  const local = (parseInt(c.mac.slice(0, 2), 16) & 0x02) !== 0;
  return c.addrRandom || (c.kind === 'usb-modem' && local) ? usbIdMac(c.usbId) : c.mac;
}
// Takılı kartın kimliği USB aygıtından mı türetildi (sihirbaz "Kalıcı MAC" yerine "Kimlik" yazar).
export const idFromUsb = (c: NetCard | null, mac: string) => !!c && !!c.usbId && usbIdMac(c.usbId) === mac;

// Bir tarama turu. baseline: yeni kartlar bildirimsiz "bilinen" yazılır (algılama açılırken bir kez). Döner: taban
// çizgisinde yeni "bilinen" yazılan kart sayısı. Her beklemeden sonra dönem denetlenir: durdurulan izleyici yazmaz.
async function scan(baseline: boolean, my: number): Promise<number> {
  if (my !== gen) return 0;
  const { root, permAddrs } = cfg;
  const refs = listNetCards(root);
  const keys = new Set(refs.map(r => r.key));
  for (const k of [...byKey.keys()]) if (!keys.has(k)) byKey.delete(k);
  const now = new Map<string, Live>();
  const dups: [string, string, string][] = [];
  for (const ref of refs) {
    let live = byKey.get(ref.key);
    if (!live) {
      const card = describeNetCard(ref, root);
      const perm = ref.wifi ? '' : (await permAddrs(ref.name)).get(ref.name) || '';
      if (my !== gen) return 0;
      const mac = ref.wifi ? card.mac : perm || cardIdentity(card);
      if (!MAC_RE.test(mac)) continue; // adresi okunamadı (kart tam o anda çıkarıldı): sonraki turda yeniden denenir
      live = { mac, card };
      byKey.set(ref.key, live);
    }
    // Aynı MAC iki kartta: ilki izlenir, ikincisi ayırt edilemez (bir kez uyarılır).
    const first = now.get(live.mac);
    if (first) dups.push([first.card.name, live.card.name, live.mac]);
    else now.set(live.mac, live);
  }
  if (my !== gen) return 0;
  let known = 0;
  for (const [mac, live] of now) {
    const c = live.card;
    const cols = [c.name, c.driver, c.kind, c.bus, c.usbSpeedMbps];
    const prev = present.get(mac);
    if (prev) {
      // Takılıyken anahtarı değişti (başka porta taşındı, yeniden adlandırıldı, başka sürücüyle bağlandı): satır güncel
      // ayrıntıyı alır, olay yok.
      if (prev !== live && my === gen) {
        await dbRun(`UPDATE net_ports SET name = ?, driver = ?, kind = ?, bus = ?, usb_speed = ?, last_seen = CURRENT_TIMESTAMP
          WHERE perm_mac = ?`, [...cols, mac]);
      }
      continue;
    }
    const row = await dbGet('SELECT state FROM net_ports WHERE perm_mac = ?', [mac]);
    if (my !== gen) return known;
    if (row) {
      // Aynı kart yeniden takıldı (ya da izleyici yeniden başladı): bildirim yok, durumu değişmez.
      await dbRun(`UPDATE net_ports SET name = ?, driver = ?, kind = ?, bus = ?, usb_speed = ?, last_seen = CURRENT_TIMESTAMP
        WHERE perm_mac = ?`, [...cols, mac]);
    } else {
      await dbRun('INSERT INTO net_ports (perm_mac, name, driver, kind, bus, usb_speed, state) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [mac, ...cols, baseline ? 'known' : 'pending']);
      if (baseline) known++;
      else if (my === gen) await recordEvent('hotplug', hotplugMessage(c), 'info');
    }
  }
  for (const [a, b, mac] of dups) {
    const k = `${mac} ${a} ${b}`;
    if (dupWarned.has(k) || my !== gen) continue;
    dupWarned.add(k);
    await recordEventOnce('hotplug', `${a} ve ${b} aynı MAC adresini (${mac}) taşıyor — tak-çalıştır algılama bu kartları ayırt edemez,`
      + ` ${b} ayrıca bildirilmez`, 'warning', 0);
  }
  for (const mac of present.keys()) {
    if (!now.has(mac) && my === gen) await dbRun('UPDATE net_ports SET last_seen = CURRENT_TIMESTAMP WHERE perm_mac = ?', [mac]);
  }
  if (my === gen) present = now;
  return known;
}

// Tek tur (zamanlayıcı ve test): aynı dönemde süren tur varsa onu bekler, üst üste binmez. Önceki dönemin (kapatılmış
// izleyicinin) turu sürüyorsa önce o biter — yeniden açılıştaki taban çizgisi turu atlanmaz.
export function scanPorts(baseline = false): Promise<number> {
  if (scanning && scanning.gen === gen) return scanning.p;
  const prev = scanning?.p || Promise.resolve(0);
  const my = gen;
  const p: Promise<number> = prev.then(() => scan(baseline, my))
    .catch((e: any) => { console.error('[tak-çalıştır] tarama:', e?.message || e); return 0; })
    .finally(() => { if (scanning?.p === p) scanning = null; });
  scanning = { gen: my, p };
  return p;
}

// Döner: taban çizgisinde yeni "bilinen" yazılan kart sayısı. Taban çizgisi sürerken durdurulduysa (ya da yeniden
// başlatıldıysa) zamanlayıcı kurulmaz.
type StartOpts = { baseline?: boolean; root?: string; intervalMs?: number; permAddrs?: Cfg['permAddrs'] };
export async function startPortWatch(opts: StartOpts = {}): Promise<number> {
  stopPortWatch();
  const my = gen;
  cfg = { root: opts.root ?? '', intervalMs: opts.intervalMs ?? INTERVAL_MS, permAddrs: opts.permAddrs ?? readPermAddrs };
  const known = await scanPorts(!!opts.baseline);
  if (my !== gen) return 0;
  timer = setInterval(() => { void scanPorts(false); }, cfg.intervalMs);
  timer.unref?.();
  return known;
}

export function stopPortWatch(): void {
  gen++;
  if (timer) clearInterval(timer);
  timer = null;
  byKey.clear();
  present = new Map();
  dupWarned.clear();
  cfg = DEFAULT_CFG;
}

// Aç / kapat / açılış tek sırada: biri bitmeden öbürü başlamaz (ayar ve izleyici durumu hep uyumlu kalır).
let op: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = op.then(fn);
  op = p.catch(() => undefined);
  return p;
}

// Açılış (yalnız ana cihaz): ayar açıksa başlar. Taban çizgisi yalnız hiç satır yoksa (ilk açılış); yoksa panel kapalıyken
// takılan kart da bildirilir.
export function initPortWatch(): Promise<void> {
  return serial(async () => {
    if (!(await portWatchEnabled())) return;
    const n = await dbGet('SELECT COUNT(*) AS n FROM net_ports');
    await startPortWatch({ baseline: !n?.n });
  });
}

// Ayar ucu (PUT /api/ports/settings): açınca taban çizgisi (takılı kartlar sessizce bilinen), kapatınca zamanlayıcı durur.
// Döner: taban çizgisinde yeni bilinen sayılan kart sayısı (önceden kayıtlı ya da bekleyen kartlar sayılmaz).
// opts yalnız test içindir (startPortWatch ile aynı).
export function setPortWatch(enabled: boolean, opts: Omit<StartOpts, 'baseline'> = {}): Promise<{ enabled: boolean; baseline: number }> {
  return serial(async () => {
    await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [HOTPLUG_KEY, enabled ? '1' : '0']);
    if (!enabled) { stopPortWatch(); return { enabled, baseline: 0 }; }
    return { enabled, baseline: await startPortWatch({ ...opts, baseline: true }) };
  });
}

export type PortRow = {
  mac: string; name: string; driver: string; kind: PortKind; bus: string; usbSpeedMbps: number | null;
  firstSeen: string; lastSeen: string; state: PortState; present: boolean;
};
export async function listPorts(): Promise<PortRow[]> {
  const rows = await dbAll('SELECT * FROM net_ports ORDER BY first_seen DESC, perm_mac');
  return rows.map(r => ({
    mac: String(r.perm_mac), name: String(r.name || ''), driver: String(r.driver || ''), kind: r.kind as PortKind,
    bus: String(r.bus || ''), usbSpeedMbps: r.usb_speed === null || r.usb_speed === undefined ? null : Number(r.usb_speed),
    firstSeen: String(r.first_seen || ''), lastSeen: String(r.last_seen || ''), state: r.state as PortState,
    present: present.has(String(r.perm_mac)),
  }));
}
// Takılı kartın güncel ayrıntısı (sihirbaz: kablo / hız değişmiş olabilir); takılı değilse null.
export function liveCard(mac: string): NetCard | null {
  for (const ref of listNetCards(cfg.root)) {
    const l = byKey.get(ref.key);
    if (l?.mac === mac) return describeNetCard(ref, cfg.root);
  }
  return null;
}

export async function setPortState(mac: string, state: PortState): Promise<boolean> {
  const row = await dbGet('SELECT perm_mac FROM net_ports WHERE perm_mac = ?', [mac]);
  if (!row) return false;
  await dbRun('UPDATE net_ports SET state = ? WHERE perm_mac = ?', [state, mac]);
  return true;
}

// ─── Sihirbaz (saf): uyarılar ve rol seçenekleri ───

// Ağ kipi durumunun gereken kısmı (system.ts NetModeState ile yapısal uyumlu).
export type NetBrief = {
  stage: string; iface: string; wanStage: string; wanPort: string; bakStage: string; bakKind: string; bakPort: string; bakDev: string;
  apStage: string; apIface: string; homeStage: string; homeIface: string; repStage: string; repPort: string; repLan: string;
};
export type WizardInput = {
  // null: kart takılı değil. usbVersion yoksa bilinmiyor sayılır.
  card: Pick<NetCard, 'name' | 'kind' | 'driver' | 'bus' | 'usbSpeedMbps'> & { usbVersion?: number | null } | null;
  ns: NetBrief | null; piDhcp: boolean;
  conn: string; ipv4: string[]; defaultRoute: boolean; // NetworkManager'ın karttaki etkin profili, adresleri, varsayılan rota
};
export type RoleOptionId = 'wan' | 'failover' | 'iot' | 'ignore';
export type RoleOption = { id: RoleOptionId; ok: boolean; why: string; bakKind?: 'eth' | 'usb' | 'wifi' };
export type WizardPlan = { role: string; warnings: { kind: 'warn' | 'info'; text: string }[]; options: RoleOption[] };

// Kartın şu anki rolü (net-mode.sh durum dosyası): varsa yeni rol önerilmez.
export function cardRole(name: string, ns: NetBrief | null): string {
  if (!ns || !name) return '';
  if (ns.stage !== 'none' && ns.iface === name) return 'ev ağı kartı';
  if (ns.wanStage !== 'none' && ns.wanPort === name) return 'internet kartı (WAN router)';
  if (ns.bakStage !== 'none' && (ns.bakPort === name || ns.bakDev === name)) return 'yedek hat';
  if (ns.repStage !== 'none' && (ns.repPort === name || ns.repLan === name)) return 'Wi-Fi köprüsü';
  if (ns.apStage !== 'none' && ns.apIface === name) return "kurulum Wi-Fi'ı";
  if (ns.homeStage !== 'none' && ns.homeIface === name) return "ev Wi-Fi'ı";
  return '';
}

export function planPortWizard(x: WizardInput): WizardPlan {
  const c = x.card, ns = x.ns;
  const warnings: WizardPlan['warnings'] = [];
  const role = c ? cardRole(c.name, ns) : '';
  const usbBak = ns?.bakStage === 'on' && ns.bakKind === 'usb';
  if (!c) warnings.push({ kind: 'warn', text: 'Kart şu an takılı değil — takınca bilgileri ve rol seçenekleri gelir.' });
  else {
    if (role) warnings.push({ kind: 'info', text: `Bu kart şu an ${role} olarak kullanılıyor — yeni rol önerilmez.` });
    // USB 2 hızı: 4G modem / telefon paylaşımı / SIM'li modemde uyarı yok (hatları bu sınırın altında; cdc_ncm hariç — 2.5G
    // Ethernet adaptörü de olabilir). Aygıt kesin USB 2'yse (bcdUSB < 2.10) mavi port önerilmez.
    const modem = (c.kind === 'usb-modem' && c.driver !== 'cdc_ncm') || c.kind === 'wwan';
    if (c.bus === 'usb' && c.usbSpeedMbps !== null && c.usbSpeedMbps < 5000 && !modem) {
      warnings.push(typeof c.usbVersion === 'number' && c.usbVersion < 2.1
        ? { kind: 'info', text: `${c.name} bir USB 2 aygıtı: hız ~300 Mbps ile sınırlı — USB 3 portuna takmak bunu değiştirmez.` }
        : { kind: 'warn', text: `${c.name} USB 2 hızında bağlı: hız ~300 Mbps ile sınırlı. Adaptör USB 3 ise mavi USB 3 portuna takın.` });
    }
    if (/^netplan-/.test(x.conn) && x.ipv4.length) {
      warnings.push({ kind: 'warn', text: `${c.name} eski kurulum profiliyle (${x.conn}) kendiliğinden adres aldı (${x.ipv4.join(', ')})`
        + `${x.defaultRoute ? " ve ikinci bir varsayılan rota açtı — Pi'nin internet çıkışı karışabilir" : ''}. Rol verince kart kendi`
        + ' profiline alınır; rol vermeyecekseniz kabloyu çıkarın.' });
    }
    if (c.kind === 'usb-modem' && usbBak) {
      warnings.push({ kind: 'warn', text: `Yedek hat USB türünde açık: ${c.driver} sürücülü kartları yedek hat sahiplenir — bu kart başka bir rolde kullanılamaz.` });
    }
    if (c.driver === 'cdc_ncm') {
      warnings.push({ kind: 'info', text: "USB 2.5G Ethernet adaptörleri (ör. RTL8156) bazen cdc_ncm sürücüsüyle bağlanır: panel kartı USB modem sayar (WAN router listesinde 'USB modem' etiketiyle görünür)." });
    }
    if (c.kind === 'wwan') {
      warnings.push({ kind: 'warn', text: "SIM'li modem (QMI / MBIM): APN / PIN isteyen modemler şimdilik desteklenmiyor. Web arayüzlü (HiLink) modem ya da telefonun USB paylaşımını kullanın." });
    }
  }
  // Ön koşullar (ilk karşılanmayan "önce …" olarak gösterilir) — WanPanel / FailoverPanel'in kendi kilitleriyle aynı sıra.
  const common = !c ? 'önce kartı takın' : c.kind === 'wwan' ? "SIM'li modem desteklenmiyor" : role ? `kart zaten ${role}`
    : !ns || ns.stage !== 'static' ? "önce DHCP Ayarları'nda Pi'ye sabit adres verip kalıcı yapın"
      : !x.piDhcp ? "önce Pi DHCP'sini açın (DHCP Ayarları)" : '';
  const wanWhy = common || (ns!.wanStage !== 'none' ? `önce mevcut internet kartını (${ns!.wanPort || '?'}) kapatın`
    : ns!.homeStage === 'trial' ? "önce ev Wi-Fi'ı denemesini bitirin"
      : c!.kind === 'usb-modem' && usbBak ? 'önce yedek hattı kapatın (USB türü bu kartı sahipleniyor)' : '');
  const bakWhy = common || (ns!.bakStage !== 'none' ? 'önce mevcut yedek hattı kapatın'
    : ns!.homeStage === 'trial' || ns!.wanStage === 'trial' ? 'önce süren denemeyi bitirin' : '');
  const bakKind = c?.kind === 'wifi' ? 'wifi' : c?.kind === 'usb-modem' ? 'usb' : 'eth';
  return {
    role, warnings,
    options: [
      { id: 'wan', ok: !wanWhy, why: wanWhy },
      { id: 'failover', ok: !bakWhy, why: bakWhy, bakKind },
      { id: 'iot', ok: false, why: 'yakında (bölgeler gelince)' },
      { id: 'ignore', ok: true, why: '' },
    ],
  };
}

// Sihirbaz için kartın ağ durumu (yalnız sihirbaz açılınca): NetworkManager'ın etkin profili, IPv4 adresleri, varsayılan
// rota bu karttan mı. Okunamazsa boş.
export async function readCardNet(name: string): Promise<{ conn: string; ipv4: string[]; defaultRoute: boolean }> {
  const run = (bin: string, args: string[]) => execFileP(bin, args, { timeout: 5000 }).then(r => r.stdout, () => '');
  const [conn, addr, route] = await Promise.all([
    run('nmcli', ['-g', 'GENERAL.CONNECTION', 'device', 'show', name]),
    run('ip', ['-j', '-4', 'addr', 'show', 'dev', name]),
    run('ip', ['-j', '-4', 'route', 'show', 'default', 'dev', name]),
  ]);
  const json = (t: string): any[] => { try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; } };
  const ipv4 = json(addr).flatMap(l => (Array.isArray(l?.addr_info) ? l.addr_info : []))
    .filter((a: any) => a?.family === 'inet' && typeof a.local === 'string').map((a: any) => `${a.local}/${a.prefixlen}`);
  return { conn: conn.trim().split('\n')[0] || '', ipv4, defaultRoute: json(route).length > 0 };
}

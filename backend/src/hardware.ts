import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Cihaz rolleri (R0): Pi'nin takılı donanımı (Ethernet portları, Wi-Fi radyoları ve yetenekleri) okunur ve her ağ rolü
// (LAN router, WAN router, erişim noktası, repeater, mesh) için "kullanımda / yapılabilir / donanım gerekli" değerlendirilir.
// SALT OKUNUR: hiçbir ağ ayarı değişmez. Radyo yetenekleri `iw list`ten (desteklenen modlar, bantlar, eşzamanlı arayüz
// birleşimleri); 4 adresli köprü (repeater için) iw'de ilan edilmediğinden sürücü tablosundan.

const execFileP = promisify(execFile);

export type Bus = 'usb' | 'onboard';
export type Combo = { groups: { modes: string[]; max: number }[]; total: number; channels: number };
export type IwPhy = { phy: string; modes: string[]; bands: ('2.4' | '5' | '6')[]; combos: Combo[] };
export type Radio = IwPhy & {
  ifaces: string[]; driver: string; bus: Bus; usbSpeedMbps: number | null;
  ap: boolean; sta: boolean; mesh: boolean; apSta: boolean; apMesh: boolean; apAp: boolean; fourAddr: boolean | null;
};
export type EthPort = {
  name: string; driver: string; bus: Bus; usbSpeedMbps: number | null; speedMbps: number | null;
  carrier: boolean | null; mac: string; uplink: boolean;
};
export type Hardware = {
  board: string; kernel: string; iwMissing: boolean;
  eth: EthPort[]; radios: Radio[];
  tools: Record<string, boolean>; modules: Record<string, boolean>;
  net: { uplinkIface: string | null; netStage: string; apStage: string; apIface: string | null; piDhcp: boolean };
};

// ─── iw list ayrıştırma ───
// iw girintisi sekmedir: bölüm başlıkları 1 sekme ("\tSupported interface modes:"), öğeler 2-3 sekme. Birleşim satırları
// uzunsa alt satıra devam eder ("\t\t   total <= 3, #channels <= 2").
export function parseIwList(text: string): IwPhy[] {
  const out: (IwPhy & { comboText: string[]; bandSet: Set<'2.4' | '5' | '6'> })[] = [];
  let cur: (typeof out)[number] | null = null;
  let section = '';
  for (const line of text.split('\n')) {
    const m = /^Wiphy (\S+)/.exec(line);
    if (m) {
      cur = { phy: m[1], modes: [], bands: [], combos: [], comboText: [], bandSet: new Set() };
      out.push(cur);
      section = '';
      continue;
    }
    if (!cur) continue;
    const tabs = (/^\t*/.exec(line) || [''])[0].length;
    const t = line.trim();
    if (!t) continue;
    if (tabs === 1) { section = t; continue; }
    if (section === 'Supported interface modes:' && t.startsWith('*')) {
      cur.modes.push(t.replace(/^\*\s*/, ''));
    } else if (/^Band \d+:$/.test(section)) {
      const f = /^\*\s*(\d+(?:\.\d+)?) MHz/.exec(t);
      if (f && !/disabled/.test(t)) {
        const mhz = Number(f[1]);
        cur.bandSet.add(mhz < 3000 ? '2.4' : mhz < 5930 ? '5' : '6');
      }
    } else if (section === 'valid interface combinations:') {
      if (t.startsWith('*')) cur.comboText.push(t.replace(/^\*\s*/, ''));
      else if (cur.comboText.length) cur.comboText[cur.comboText.length - 1] += ` ${t}`;
    }
  }
  return out.map(p => ({
    phy: p.phy, modes: p.modes, bands: (['2.4', '5', '6'] as const).filter(b => p.bandSet.has(b)),
    combos: p.comboText.map(parseCombo),
  }));
}

export function parseCombo(text: string): Combo {
  const groups: Combo['groups'] = [];
  for (const g of text.matchAll(/#\{\s*([^}]+?)\s*\}\s*<=\s*(\d+)/g)) {
    groups.push({ modes: g[1].split(',').map(s => s.trim()).filter(Boolean), max: Number(g[2]) });
  }
  const total = Number((/total <= (\d+)/.exec(text) || [])[1] || 1);
  const channels = Number((/#channels <= (\d+)/.exec(text) || [])[1] || 1);
  return { groups, total, channels };
}

// İki mod aynı radyoda aynı anda çalışabilir mi (ör. AP + istemci, AP + mesh): bir birleşimde ikisi de yer almalı.
export function canCoexist(combos: Combo[], a: string, b: string): boolean {
  return combos.some(c => {
    if (c.total < 2) return false;
    const ga = c.groups.find(g => g.modes.includes(a)), gb = c.groups.find(g => g.modes.includes(b));
    if (!ga || !gb) return false;
    return ga === gb ? ga.max >= 2 : ga.max >= 1 && gb.max >= 1;
  });
}

// 4 adresli (WDS) istemci: köprülü repeater ve mesh uydusunun kablosuz bağlantısı için. iw bunu ilan etmez → sürücü bilgisi.
// brcmfmac (Pi'nin dahili Wi-Fi'ı) desteklemez; mt76 ve ath ailesi destekler. Bilinmeyen sürücü: null.
const FOUR_ADDR: Record<string, boolean> = {
  brcmfmac: false,
  mt76x0u: true, mt76x2u: true, mt76x0e: true, mt76x2e: true, mt7615e: true, mt7915e: true,
  ath9k: true, ath9k_htc: true, ath10k_pci: true, ath11k_pci: true, rt2800usb: true, carl9170: true,
};

export function toRadio(p: IwPhy, extra: { ifaces: string[]; driver: string; bus: Bus; usbSpeedMbps: number | null }): Radio {
  const has = (m: string) => p.modes.includes(m);
  return {
    ...p, ...extra,
    ap: has('AP'), sta: has('managed'), mesh: has('mesh point'),
    apSta: canCoexist(p.combos, 'AP', 'managed'), apMesh: canCoexist(p.combos, 'AP', 'mesh point'), apAp: canCoexist(p.combos, 'AP', 'AP'),
    fourAddr: Object.prototype.hasOwnProperty.call(FOUR_ADDR, extra.driver) ? FOUR_ADDR[extra.driver] : null,
  };
}

// ─── Rol değerlendirmesi (saf) ───

export type RoleId = 'lan-router' | 'wan-router' | 'ap' | 'repeater' | 'mesh-wired' | 'mesh-wireless';
// active: şu an bu rolde · available: yazılımı hazır, etkin değil · hw-ready: donanım uygun, yazılımı sonraki fazda
// needs-hw: donanım eksik · unknown: yetenek okunamadı
export type RoleStatus = 'active' | 'available' | 'hw-ready' | 'needs-hw' | 'unknown';
export type Check = { ok: boolean | null; label: string; detail?: string };
export type RoleEval = { id: RoleId; status: RoleStatus; phase: string | null; checks: Check[]; need: string[]; notes: string[] };

export const HW_SUGGEST = {
  usbEth: 'USB 3.0 Gigabit Ethernet adaptörü — önerilen: TP-Link UE300 (RTL8153; sürücüsü çekirdekte hazır)',
  wifiMesh: 'Mesh destekli USB Wi-Fi adaptörü — önerilen: ALFA AWUS036ACM (MediaTek MT7612U; AP + 802.11s mesh + 4 adres)',
  secondDevice: 'İkinci bir Klyrix cihazı (Raspberry Pi 5)',
};

export function evaluateRoles(hw: Hardware): RoleEval[] {
  const eth = hw.eth, radios = hw.radios;
  const linked = eth.filter(e => e.carrier);
  const apRadios = radios.filter(r => r.ap);
  const meshRadios = radios.filter(r => r.mesh);
  const unknownRadios = hw.iwMissing && radios.length > 0;
  const radioLabel = (r: Radio) => `${r.ifaces.join(', ') || r.phy} (${r.driver || 'bilinmeyen sürücü'}${r.bus === 'usb' ? ', USB' : ', dahili'})`;
  const out: RoleEval[] = [];

  // LAN router: mevcut ağın arkasında DHCP + DNS + NAT (DHCP Ayarları sihirbazı).
  const lanActive = hw.net.piDhcp && hw.net.netStage === 'static';
  out.push({
    id: 'lan-router', phase: null,
    status: lanActive ? 'active' : eth.length ? 'available' : 'needs-hw',
    checks: [
      { ok: eth.length > 0, label: 'Ethernet portu', detail: eth.map(e => e.name).join(', ') || 'yok' },
      { ok: hw.net.netStage === 'static', label: 'Sabit adres', detail: hw.net.netStage === 'static' ? 'kalıcı' : hw.net.netStage === 'trial' ? 'deneme sürüyor' : 'yok' },
      { ok: hw.net.piDhcp, label: 'Pi DHCP sunucusu', detail: hw.net.piDhcp ? 'açık' : 'kapalı' },
    ],
    need: eth.length ? [] : [HW_SUGGEST.usbEth],
    notes: lanActive ? [] : ['DHCP Ayarları sayfasındaki sihirbazla açılır.'],
  });

  // WAN router: internet bir porttan, ev ağı ayrı porttan (ya da tek port + VLAN destekli yönetilebilir anahtar).
  const usb2Eth = eth.filter(e => e.bus === 'usb' && e.usbSpeedMbps !== null && e.usbSpeedMbps < 5000);
  out.push({
    id: 'wan-router', phase: 'R3',
    status: eth.length >= 2 ? 'hw-ready' : 'needs-hw',
    checks: [
      { ok: eth.length >= 2, label: 'İki Ethernet portu (internet + ev)', detail: `${eth.length} port: ${eth.map(e => e.name).join(', ') || '—'}` },
      ...(usb2Eth.length ? [{ ok: false, label: 'USB 3 bağlantısı', detail: `${usb2Eth.map(e => e.name).join(', ')} USB 2 portunda — hız ~300 Mbps ile sınırlı; mavi USB 3 portuna takın` }] : []),
      { ok: hw.modules['8021q'] ?? null, label: 'VLAN desteği (operatör istiyorsa)', detail: hw.modules['8021q'] ? 'çekirdek modülü var' : 'modül bulunamadı' },
      { ok: hw.tools.pppd ? !!hw.modules.pppoe : null, label: 'PPPoE desteği (operatör istiyorsa)', detail: hw.tools.pppd ? (hw.modules.pppoe ? 'hazır' : 'pppoe modülü yok') : 'pppd kurulu değil — R3\'te kurulur' },
    ],
    need: eth.length >= 2 ? [] : [HW_SUGGEST.usbEth],
    notes: ['Alternatif: tek port + VLAN destekli yönetilebilir anahtar (daha karmaşık kurulum).'],
  });

  // Erişim noktası: ev Wi-Fi'ı Pi'den, ev ağına köprülü.
  const setupRadio = hw.net.apStage !== 'none' && hw.net.apIface ? radios.find(r => r.ifaces.includes(hw.net.apIface!)) : undefined;
  const apNotes: string[] = [];
  if (setupRadio && apRadios.length === 1 && apRadios[0] === setupRadio && !setupRadio.apAp) {
    apNotes.push(`Kurulum Wi-Fi'ı bu radyoyu kullanıyor ve radyo aynı anda iki yayın yapamıyor: ev Wi-Fi'ı açılırsa kurulum Wi-Fi'ı ya kapanır ya da ikinci radyoya taşınır.`);
  }
  if (apRadios.some(r => r.driver === 'brcmfmac') && !apRadios.some(r => r.bus === 'usb')) {
    apNotes.push('Dahili radyo tek antenli Wi-Fi 5: küçük alan ve az cihaz için uygun; geniş ev için USB adaptör önerilir.');
  }
  out.push({
    id: 'ap', phase: 'R1',
    status: unknownRadios ? 'unknown' : apRadios.length ? 'hw-ready' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : apRadios.length > 0, label: 'Erişim noktası (AP) modu', detail: unknownRadios ? 'okunamadı (iw yok)' : apRadios.map(radioLabel).join('; ') || 'AP destekli radyo yok' },
      { ok: unknownRadios ? null : apRadios.some(r => r.bands.includes('5')), label: '5 GHz bant', detail: unknownRadios ? '—' : apRadios.some(r => r.bands.includes('5')) ? 'var' : 'yalnız 2.4 GHz' },
    ],
    need: !unknownRadios && !apRadios.length ? [HW_SUGGEST.wifiMesh] : [],
    notes: apNotes,
  });

  // Repeater: bir radyo mevcut Wi-Fi'a bağlanır, yeniden yayınlar. En iyisi iki radyo (biri bağlantı, biri yayın);
  // gerçek köprü için bağlantı radyosu 4 adres desteklemeli, yoksa ARP vekiliyle (L3) köprü kurulur.
  const staRadios = radios.filter(r => r.sta);
  const twoRadio = staRadios.some(s => apRadios.some(a => a !== s));
  const bridgeCapable = staRadios.some(r => r.fourAddr === true);
  const singleApSta = radios.some(r => r.apSta);
  out.push({
    id: 'repeater', phase: 'R4',
    status: unknownRadios ? 'unknown' : twoRadio || singleApSta ? 'hw-ready' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : twoRadio, label: 'İki radyo (biri bağlantı, biri yayın)', detail: unknownRadios ? 'okunamadı (iw yok)' : `${radios.length} radyo` },
      { ok: unknownRadios ? null : singleApSta, label: 'Tek radyoda aynı anda bağlantı + yayın', detail: singleApSta ? 'destekleniyor (bant genişliği paylaşılır)' : 'desteklenmiyor' },
      { ok: unknownRadios ? null : bridgeCapable, label: '4 adresli köprü', detail: bridgeCapable ? 'destekleniyor' : 'yok — köprü ARP vekiliyle (L3) kurulur' },
    ],
    need: !unknownRadios && !(twoRadio && bridgeCapable) ? [HW_SUGGEST.wifiMesh] : [],
    notes: twoRadio ? [] : singleApSta ? ['Tek radyoyla çalışır ama hız yarıya düşer.'] : [],
  });

  // Kablolu mesh uydusu: ikinci Klyrix cihazı kabloyla ağa bağlanır, aynı ağ adıyla yayın yapar.
  out.push({
    id: 'mesh-wired', phase: 'R2',
    status: unknownRadios ? 'unknown' : eth.length && apRadios.length ? 'hw-ready' : 'needs-hw',
    checks: [
      { ok: eth.length > 0, label: 'Ethernet (uydu bağlantısı)', detail: linked.map(e => e.name).join(', ') || eth.map(e => e.name).join(', ') || 'yok' },
      { ok: unknownRadios ? null : apRadios.length > 0, label: 'AP modu (yayın)', detail: unknownRadios ? 'okunamadı (iw yok)' : apRadios.length ? 'var' : 'yok' },
    ],
    need: [HW_SUGGEST.secondDevice],
    notes: ['Her uydu Klyrix yazılımıyla kurulur; kurulumda "ana cihaz / uydu" sorulur (R2).'],
  });

  // Kablosuz mesh: 802.11s bağlantısı. İdeali mesh radyosu + ayrı yayın radyosu; tek radyoda AP + mesh birlikte olabiliyorsa o da olur.
  const meshWithAp = meshRadios.some(r => r.apMesh) || meshRadios.some(m => apRadios.some(a => a !== m));
  out.push({
    id: 'mesh-wireless', phase: 'R2',
    status: unknownRadios ? 'unknown' : meshWithAp ? 'hw-ready' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : meshRadios.length > 0, label: '802.11s mesh modu', detail: unknownRadios ? 'okunamadı (iw yok)' : meshRadios.map(radioLabel).join('; ') || 'mesh destekli radyo yok' },
      { ok: unknownRadios ? null : meshWithAp, label: 'Mesh + yayın birlikte', detail: meshWithAp ? 'var' : 'yok' },
    ],
    need: [...(!unknownRadios && !meshWithAp ? [HW_SUGGEST.wifiMesh] : []), HW_SUGGEST.secondDevice],
    notes: radios.some(r => r.driver === 'brcmfmac') ? ["Pi'nin dahili Wi-Fi'ı (brcmfmac) mesh ve 4 adresli köprüyü desteklemez."] : [],
  });
  return out;
}

// ─── Canlı okuma (Linux) ───

const readText = (p: string) => { try { return fs.readFileSync(p, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; } };
const driverOf = (devPath: string) => { try { return path.basename(fs.realpathSync(path.join(devPath, 'driver'))); } catch { return ''; } };
function busInfo(devPath: string): { bus: Bus; usbSpeedMbps: number | null } {
  let real = '';
  try { real = fs.realpathSync(devPath); } catch { return { bus: 'onboard', usbSpeedMbps: null }; }
  if (!/\/usb\d*\//.test(real)) return { bus: 'onboard', usbSpeedMbps: null };
  // USB aygıt dizini (speed + idVendor dosyaları olan) arayüz dizininin üstlerinde
  for (let d = real; d.length > 5; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'idVendor')) && fs.existsSync(path.join(d, 'speed'))) {
      const s = Number(readText(path.join(d, 'speed')));
      return { bus: 'usb', usbSpeedMbps: Number.isFinite(s) && s > 0 ? s : null };
    }
  }
  return { bus: 'usb', usbSpeedMbps: null };
}
const onPath = (bin: string) => ['/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/local/sbin', '/usr/local/bin'].some(d => fs.existsSync(path.join(d, bin)));
async function hasModule(name: string): Promise<boolean> {
  try { await execFileP('modinfo', ['-n', name], { timeout: 5000 }); return true; } catch { return false; }
}

// opts yalnız test içindir: sahte /sys kökü ve hazır `iw list` çıktısı.
export async function readHardware(net: Omit<Hardware['net'], 'uplinkIface'>, opts: { root?: string; iwText?: string } = {}): Promise<Hardware> {
  const R = opts.root || '';
  let uplinkIface: string | null = null;
  try {
    const { stdout } = await execFileP('ip', ['-j', '-4', 'route', 'show', 'default'], { timeout: 5000 });
    uplinkIface = (JSON.parse(stdout) as any[]).find(r => r?.dev)?.dev || null;
  } catch { /* rota yok */ }

  const eth: EthPort[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(`${R}/sys/class/net`); } catch { /* yok */ }
  for (const name of names.sort()) {
    const base = `${R}/sys/class/net/${name}`;
    if (readText(`${base}/type`) !== '1' || fs.existsSync(`${base}/wireless`) || fs.existsSync(`${base}/phy80211`)
      || fs.existsSync(`${base}/bridge`) || !fs.existsSync(`${base}/device`)) continue;
    const speed = Number(readText(`${base}/speed`));
    const carrier = readText(`${base}/carrier`);
    eth.push({
      name, driver: driverOf(`${base}/device`), ...busInfo(`${base}/device`),
      speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
      carrier: carrier === '1' ? true : carrier === '0' ? false : null,
      mac: readText(`${base}/address`), uplink: name === uplinkIface,
    });
  }

  let iwText = '', iwMissing = false;
  if (opts.iwText !== undefined) iwText = opts.iwText;
  else try { iwText = (await execFileP('iw', ['list'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout; } catch { iwMissing = true; }
  const parsed = new Map(parseIwList(iwText).map(p => [p.phy, p]));
  const radios: Radio[] = [];
  let phys: string[] = [];
  try { phys = fs.readdirSync(`${R}/sys/class/ieee80211`); } catch { /* radyo yok */ }
  for (const phy of phys.sort()) {
    const base = `${R}/sys/class/ieee80211/${phy}`;
    const ifaces = names.filter(n => readText(`${R}/sys/class/net/${n}/phy80211/name`) === phy);
    const p = parsed.get(phy) || { phy, modes: [], bands: [], combos: [] };
    radios.push(toRadio(p, { ifaces, driver: driverOf(`${base}/device`), ...busInfo(`${base}/device`) }));
  }

  const toolNames = ['iw', 'nmcli', 'wpa_supplicant', 'hostapd', 'batctl', 'pppd'];
  const modNames = ['mac80211', 'batman_adv', '8021q', 'pppoe'];
  const mods = await Promise.all(modNames.map(hasModule));
  return {
    board: readText(`${R}/proc/device-tree/model`) || os.hostname(), kernel: os.release(), iwMissing,
    eth, radios,
    tools: Object.fromEntries(toolNames.map(t => [t, onPath(t)])),
    modules: Object.fromEntries(modNames.map((m, i) => [m, mods[i]])),
    net: { ...net, uplinkIface },
  };
}

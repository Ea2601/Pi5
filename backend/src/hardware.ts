import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseKv } from './update';

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
// Ağ kartı türü (sürücüye göre; tak-çalıştır algılama ve WAN aday listesi etiketi): ethernet, USB modem / telefon paylaşımı,
// SIM'li modem (desteklenmiyor), Wi-Fi. permMac: kalıcı (fabrika) MAC — MAC kopyalanmış kartta da aynı; yoksa geçerli adres.
export type PortKind = 'ethernet' | 'usb-modem' | 'wwan' | 'wifi';
export type EthPort = {
  name: string; driver: string; bus: Bus; usbSpeedMbps: number | null; speedMbps: number | null;
  carrier: boolean | null; mac: string; uplink: boolean; kind: PortKind; permMac: string;
};
// Donanım profili (scripts/platform.sh detect — eşikler yalnız orada): bellek sınıfı, mimari, ekran çıkışı, takas.
// rpi: Raspberry Pi kartı; arch: kullanıcı alanı (dpkg), kernelArch: uname -m; memClassMiB: MemTotal'dan büyük ya da eşit
// ilk 2'nin kuvveti; forced: profil elle verildi (/etc/pi5-gateway/profile ya da KLYRIX_PROFILE).
export type KioskSupport = 'ok' | 'warn' | 'no' | 'no-display';
export type Platform = {
  board: string; rpi: boolean; arch: string; kernelArch: string; cpus: number; memMiB: number; memClassMiB: number;
  profile: 'lite' | 'standard'; forced: boolean; display: boolean; kiosk: KioskSupport;
  swap: { mib: number; zram: boolean; file: boolean; mgr: string };
};
export type Hardware = {
  board: string; kernel: string; iwMissing: boolean;
  platform: Platform | null;
  eth: EthPort[]; radios: Radio[];
  tools: Record<string, boolean>; modules: Record<string, boolean>;
  net: {
    uplinkIface: string | null; netStage: string; apStage: string; apIface: string | null; piDhcp: boolean;
    homeStage?: string; homeIface?: string | null;
    // R2: cihaz rolü, eşleşmiş uydu sayısı (ana cihaz), uydunun eşleşmesi, kablosuz mesh yapılandırıldı mı.
    role?: 'main' | 'satellite'; satellites?: number; paired?: boolean; meshConfigured?: boolean;
    // R3: internet kartı (WAN router) aşaması, kartı ve adres/rota arayüzü (kart / VLAN / PPPoE).
    wanStage?: string; wanPort?: string | null; wanDev?: string | null;
    wanSingle?: boolean; // R3b: tek port (internet ev ağı kartının üzerindeki VLAN'dan)
    wanSsid?: string; // R4 A: internet kartı Wi-Fi istemci ise üst ağın adı (repeater)
    // Yedek hat (failover): açık mı, arayüzü, şu an etkin mi (ana hat düştü, yedek hattan çıkılıyor).
    bakStage?: string; bakDev?: string | null; bakActive?: boolean;
    // R4 C: Wi-Fi köprüsü (aynı ağ) aşaması, üst Wi-Fi kartı / adı, DHCP kipi, ev tarafının durumu (izleyici).
    repStage?: string; repPort?: string | null; repSsid?: string; repDhcp?: string; repLanState?: string;
    // Ev ağı kartının adı (sabit adres kartı / Wi-Fi köprüsünün ev tarafı): rol notlarında gösterilir (eth0, end0, enp1s0 …).
    lanIface?: string | null; repLan?: string | null;
  };
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
export type RoleGroup = 'routing' | 'wireless' | 'mesh';
// active: şu an bu rolde · available: yazılımı hazır, etkin değil · hw-ready: donanım uygun, yazılımı sonraki fazda
// needs-hw: donanım eksik · unknown: yetenek okunamadı
export type RoleStatus = 'active' | 'available' | 'hw-ready' | 'needs-hw' | 'unknown';
// Kontrol satırı: etiket + kısa değer (ayrıntılı açıklama nota gider). ok=null: bilinmiyor / ilgili fazda kurulur.
export type Check = { ok: boolean | null; label: string; value: string };
export type Note = { kind: 'warn' | 'info'; text: string };
export type Need = { item: string; model?: string; chip?: string };
export type RoleEval = {
  id: RoleId; group: RoleGroup; status: RoleStatus; phase: string | null; checks: Check[]; need: Need[]; notes: Note[];
};

export const HW_SUGGEST: Record<'usbEth' | 'wifiMesh' | 'secondDevice', Need> = {
  usbEth: { item: 'USB 3.0 Gigabit Ethernet adaptörü', model: 'TP-Link UE300', chip: 'RTL8153 · sürücü çekirdekte' },
  wifiMesh: { item: 'Mesh destekli USB Wi-Fi adaptörü', model: 'ALFA AWUS036ACM', chip: 'MediaTek MT7612U · AP + 802.11s + 4 adres' },
  secondDevice: { item: 'İkinci Klyrix cihazı', model: 'Raspberry Pi 5' },
};

export function evaluateRoles(hw: Hardware): RoleEval[] {
  const eth = hw.eth, radios = hw.radios;
  const linked = eth.filter(e => e.carrier);
  const apRadios = radios.filter(r => r.ap);
  const meshRadios = radios.filter(r => r.mesh);
  const unknownRadios = hw.iwMissing && radios.length > 0;
  // Kısa değer: arayüz + bağlantı (sürücü ve yetenekler Donanım tablosunda).
  const radioLabel = (r: Radio) => `${r.ifaces.join(', ') || r.phy} (${r.bus === 'usb' ? 'USB' : 'dahili'})`;
  const names = (xs: { name: string }[]) => xs.map(e => e.name).join(', ');
  const unk = 'okunamadı';
  const out: RoleEval[] = [];
  // Mesh uydusu (R2): ağ geçidi rolleri ana cihazdadır; uydunun yayını ana cihazın ev Wi-Fi'ı ayarlarıyla yapılır.
  const satRole = hw.net.role === 'satellite';
  const satNote: Note = { kind: 'info', text: 'Bu cihaz uydu: ağ geçidi rolleri ana cihazda. Ana cihaz yapmak için Uydu panelinden rolü çevirin.' };

  // Yedek hat (isteğe bağlı; LAN router ve WAN router kartlarında açıkken görünür): arayüzü ve şu an devrede mi.
  const bakRows: Check[] = hw.net.bakStage === 'on'
    ? [{ ok: true, label: 'Yedek hat', value: `${hw.net.bakDev || 'bağlı değil'}${hw.net.bakActive ? ' · devrede' : ''}` }] : [];

  // LAN router: mevcut ağın arkasında DHCP + DNS + NAT (DHCP Ayarları sihirbazı).
  const lanActive = hw.net.piDhcp && hw.net.netStage === 'static';
  out.push({
    id: 'lan-router', group: 'routing', phase: null,
    status: lanActive ? 'active' : eth.length ? 'available' : 'needs-hw',
    checks: [
      { ok: eth.length > 0, label: 'Ethernet portu', value: names(eth) || 'yok' },
      { ok: hw.net.netStage === 'static', label: 'Sabit adres', value: hw.net.netStage === 'static' ? 'kalıcı' : hw.net.netStage === 'trial' ? 'deneme sürüyor' : 'yok' },
      { ok: hw.net.piDhcp, label: 'Pi DHCP sunucusu', value: hw.net.piDhcp ? 'açık' : 'kapalı' },
      ...(hw.net.wanStage === 'on' ? [] : bakRows),
    ],
    need: eth.length ? [] : [HW_SUGGEST.usbEth],
    notes: satRole ? [satNote] : lanActive ? [] : [{ kind: 'info', text: 'DHCP Ayarları sayfasındaki sihirbazla açılır.' }],
  });

  // WAN router (R3): internet bir porttan (DHCP / sabit / PPPoE, isteğe bağlı VLAN), ev ağı ayrı porttan. Cihaz Rolleri →
  // WAN router panelinden açılır (net-mode.sh wan); ön koşul kalıcı sabit adres + Pi DHCP (ev ağına adresi Pi verir).
  // Tek port (R3b): ev ağı kartı + VLAN destekli yönetilebilir anahtar — internet VLAN'ı etiketli, ev ağı etiketsiz.
  const usb2Eth = eth.filter(e => e.bus === 'usb' && e.usbSpeedMbps !== null && e.usbSpeedMbps < 5000);
  const wanStage = hw.net.wanStage || 'none';
  const wanOn = wanStage === 'on';
  const wanNotes: Note[] = usb2Eth.map(e => ({ kind: 'warn', text: `${e.name} USB 2 portunda: hız ~300 Mbps ile sınırlı. Adaptörü mavi USB 3 portuna takın.` }));
  if (wanStage === 'trial') wanNotes.push({ kind: 'info', text: "Deneme sürüyor: internet çalışıyorsa WAN router panelinden 'Kalıcı yap'a basın; basılmazsa Pi eski ayara döner." });
  if (!satRole && wanStage === 'none' && eth.length >= 1) {
    if (hw.net.netStage !== 'static') wanNotes.push({ kind: 'info', text: "Önce DHCP Ayarları sihirbazında Pi'ye sabit adres verip Pi DHCP'sini açın (ev ağına adresi Pi verecek)." });
    else if (!hw.net.piDhcp) wanNotes.push({ kind: 'info', text: "Önce Pi DHCP'sini açın (DHCP Ayarları): internet kartına geçince ev ağına adresi yalnız Pi verir." });
  }
  if (!wanOn && eth.length === 1) {
    wanNotes.push({ kind: 'info', text: "Tek port: modem / ONT ve ev ağı VLAN destekli yönetilebilir anahtara takılır; Pi'nin portu internet VLAN'ını etiketli, ev ağını etiketsiz taşır. İkinci Ethernet portu (USB) daha basittir." });
  }
  out.push({
    id: 'wan-router', group: 'routing', phase: null,
    status: wanOn ? 'active' : eth.length ? 'available' : 'needs-hw',
    checks: [
      { ok: eth.length > 0, label: 'Ethernet portu', value: eth.length >= 2 ? `${eth.length} port (${names(eth)})` : eth.length ? `1 port (${names(eth)}) · tek port + VLAN` : 'yok' },
      ...(eth.some(e => e.bus === 'usb') ? [{ ok: usb2Eth.length === 0, label: 'USB 3 bağlantısı', value: usb2Eth.length ? `${names(usb2Eth)}: USB 2` : 'evet' }] : []),
      ...(wanStage !== 'none' && hw.net.wanPort
        ? [{ ok: wanOn, label: 'İnternet kartı', value: `${hw.net.wanPort}${hw.net.wanDev && hw.net.wanDev !== hw.net.wanPort ? ` → ${hw.net.wanDev}` : ''}${hw.net.wanSingle ? ' · tek port' : ''}${wanOn ? '' : ' (deneme)'}` }]
        : []),
      { ok: hw.modules['8021q'] ?? null, label: 'VLAN (operatör isterse)', value: hw.modules['8021q'] ? 'hazır' : 'modül yok' },
      { ok: hw.tools.pppd ? !!hw.modules.pppoe : null, label: 'PPPoE (operatör isterse)', value: hw.tools.pppd ? (hw.modules.pppoe ? 'hazır' : 'modül yok') : 'panel güncellemesiyle kurulur' },
      ...(hw.net.wanStage === 'on' ? bakRows : []),
    ],
    need: eth.length >= 2 || (wanOn && hw.net.wanSingle) ? [] : [HW_SUGGEST.usbEth], // tek portta öneri (daha basit kurulum)
    notes: satRole ? [satNote, ...wanNotes.filter(n => n.kind === 'warn')] : wanNotes,
  });

  // Erişim noktası: ev Wi-Fi'ı Pi'den, ev ağına köprülü (net-mode.sh home: eth0 + Wi-Fi kartı tek köprüde, R1).
  // Betik ilk Wi-Fi kartını kullanır; kurulum Wi-Fi'ı da aynı kartta olduğundan ikisi birlikte açılamaz.
  const homeStage = hw.net.homeStage || 'none';
  const isStatic = hw.net.netStage === 'static';
  const apNotes: Note[] = [];
  if (homeStage === 'trial') apNotes.push({ kind: 'info', text: "Deneme sürüyor: ev Wi-Fi'ına bağlı bir telefondan 'Kalıcı yap'a basın; basılmazsa Pi eski ayara döner." });
  if (homeStage === 'none' && hw.net.apStage !== 'none') {
    apNotes.push({ kind: 'warn', text: "Kurulum Wi-Fi'ı açık: ev Wi-Fi'ı aynı Wi-Fi kartını kullanır — önce kurulum Wi-Fi'ını kapatın." });
  }
  if (satRole) apNotes.push({ kind: 'info', text: hw.net.paired ? "Bu cihaz uydu: ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle yayınlar." : 'Bu cihaz uydu: ana cihazla eşleşince onun ev Wi-Fi\'ını yayınlar.' });
  else if (homeStage === 'none' && !isStatic) apNotes.push({ kind: 'info', text: "Önce DHCP Ayarları sihirbazında Pi'ye sabit adres verip kalıcı yapın." });
  if (apRadios.some(r => r.driver === 'brcmfmac') && !apRadios.some(r => r.bus === 'usb')) {
    apNotes.push({ kind: 'info', text: 'Dahili radyo tek antenli Wi-Fi 5: küçük alan ve az cihaz için uygun; geniş ev için USB adaptör önerilir.' });
  }
  out.push({
    id: 'ap', group: 'wireless', phase: null,
    status: unknownRadios ? 'unknown' : homeStage === 'on' || (satRole && hw.net.paired) ? 'active' : apRadios.length ? 'available' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : apRadios.length > 0, label: 'AP modu', value: unknownRadios ? unk : apRadios.map(radioLabel).join(', ') || 'yok' },
      { ok: unknownRadios ? null : apRadios.some(r => r.bands.includes('5')), label: '5 GHz bant', value: unknownRadios ? unk : apRadios.some(r => r.bands.includes('5')) ? 'var' : 'yalnız 2.4 GHz' },
      satRole
        ? { ok: !!hw.net.paired, label: 'Ana cihazla eşleşme', value: hw.net.paired ? 'eşleşti' : 'yok' }
        : { ok: isStatic, label: 'Sabit adres', value: isStatic ? 'kalıcı' : hw.net.netStage === 'trial' ? 'deneme sürüyor' : 'yok' },
    ],
    need: !unknownRadios && !apRadios.length ? [HW_SUGGEST.wifiMesh] : [],
    notes: apNotes,
  });

  // Repeater (R4): Pi mevcut bir Wi-Fi'a istemci olarak bağlanır ve kapsamı genişletir. Ayrı ağ (yönlendirmeli, kip A):
  // WAN router panelinde internet kartı olarak Wi-Fi kartı seçilir (net-mode.sh wan --ssid); eth0 ve öbür radyonun
  // yayını (ev Wi-Fi'ı) ev ağı olur, Klyrix özellikleri arkadaki cihazlara uygulanır. Aynı ağ (ARP vekili, kip C): Wi-Fi
  // köprüsü panelinden (net-mode.sh rep); eth0'daki cihazlar modemle aynı ağda olur, DNS Pi-hole'a çekilir. En iyisi iki
  // radyo (biri bağlantı, biri yayın). 4 adresli köprü (kip B) sonraki adımda: üst router'ın da 4 adresli (WDS) istemciyi
  // kabul etmesini ister (ev modemlerinin çoğu etmez).
  const staRadios = radios.filter(r => r.sta);
  const twoRadio = staRadios.some(s => apRadios.some(a => a !== s));
  const bridgeCapable = staRadios.some(r => r.fourAddr === true);
  const repStage = hw.net.wanSsid ? (hw.net.wanStage || 'none') : 'none';
  const sameStage = hw.net.repStage === 'trial' || hw.net.repStage === 'on' ? hw.net.repStage : 'none';
  const sameLan = hw.net.repLanState || '';
  // Ev tarafı kartının gerçek adı (Wi-Fi köprüsünün ev tarafı, yoksa sabit adres kartı); bilinmiyorsa genel ad.
  const lanCard = hw.net.repLan || hw.net.lanIface || '';
  const lanCable = lanCard ? `${lanCard} kablosu` : 'ev tarafı kartının kablosu';
  const SAME_LAN_TEXT: Record<string, string> = {
    active: 'ev tarafı açık', modem: `${lanCable} modemde`, no_carrier: `${lanCable} takılı değil`,
    no_uplink: 'üst Wi-Fi kopuk', missing: 'ev tarafı kartı yok',
  };
  const repNotes: Note[] = [];
  if (repStage === 'trial') repNotes.push({ kind: 'info', text: "Deneme sürüyor: internet çalışıyorsa WAN router panelinden 'Kalıcı yap'a basın; basılmazsa Pi eski ayara döner." });
  if (sameStage === 'trial') repNotes.push({ kind: 'info', text: "Wi-Fi köprüsü denemesi sürüyor: Pi'nin yeni adresini açıp Wi-Fi köprüsü panelinden 'Kalıcı yap'a basın; basılmazsa geri alınır." });
  if (sameStage === 'on' && sameLan === 'modem') repNotes.push({ kind: 'warn', text: `${lanCard ? lanCable : 'Ev tarafı kartının kablosu'} hâlâ modeme bağlı: ev tarafı kapalı. Kabloyu arkadaki cihaza ya da anahtara takın.` });
  if (!unknownRadios && !satRole && repStage === 'none' && sameStage === 'none' && staRadios.length) {
    repNotes.push({ kind: 'info', text: "Ayrı ağ (yönlendirmeli): WAN router panelinde internet kartı olarak Wi-Fi kartını seçip üst Wi-Fi'ın adını ve parolasını girin. Kurulum kabloyla yapılır; kalıcı yaptıktan sonra kablo çıkarılıp Pi yerine taşınır." });
    repNotes.push({ kind: 'info', text: `Aynı ağ (ARP vekili): Wi-Fi köprüsü panelinden. Ev tarafı kartına${lanCard ? ` (${lanCard})` : ''} takılan cihazlar modemle aynı ağda olur (adresi modem ya da Pi verir), Pi-hole ve VPS yönlendirmesi onlara da uygulanır.` });
  }
  if (!unknownRadios && staRadios.length && !twoRadio) {
    repNotes.push({ kind: 'info', text: `Tek Wi-Fi radyosu: üst Wi-Fi'a bağlanınca ev ağı yalnız kablodan (${lanCard || 'ev tarafı kartı'}) olur; kablosuz yayın için ikinci bir Wi-Fi kartı gerekir.` });
  }
  out.push({
    id: 'repeater', group: 'wireless', phase: null,
    status: unknownRadios ? 'unknown' : repStage === 'on' || sameStage === 'on' ? 'active' : staRadios.length ? 'available' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : staRadios.length > 0, label: 'Bağlantı radyosu (istemci)', value: unknownRadios ? unk : staRadios.map(radioLabel).join(', ') || 'yok' },
      { ok: unknownRadios ? null : twoRadio, label: 'Ayrı yayın radyosu', value: unknownRadios ? unk : `${radios.length} radyo` },
      ...(repStage !== 'none'
        ? [{ ok: repStage === 'on', label: 'Üst Wi-Fi', value: `${hw.net.wanSsid} · ${hw.net.wanPort || '—'}${repStage === 'on' ? '' : ' (deneme)'}` }]
        : []),
      ...(sameStage !== 'none'
        ? [{
          ok: sameStage === 'on' && sameLan === 'active', label: 'Wi-Fi köprüsü (aynı ağ)',
          value: `${hw.net.repSsid || '?'} · ${hw.net.repPort || '—'}${sameStage === 'on' ? ` · ${SAME_LAN_TEXT[sameLan] || 'ev tarafı denetleniyor'}` : ' (deneme)'}`,
        }]
        : []),
      { ok: unknownRadios ? null : bridgeCapable, label: '4 adresli köprü (aynı ağ kipi)', value: unknownRadios ? unk : bridgeCapable ? 'radyo destekliyor' : 'yok' },
    ],
    need: !unknownRadios && !twoRadio ? [HW_SUGGEST.wifiMesh] : [],
    notes: satRole ? [satNote] : repNotes,
  });

  // Kablolu mesh uydusu: ikinci Klyrix cihazı kabloyla ağa bağlanır, ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle
  // (farklı kanalda) yayınlar (R2: mesh.ts, net-mode.sh sat). Ana cihazda uydu eklenir; uyduda eşleşme gösterilir.
  const isSat = hw.net.role === 'satellite';
  const sats = hw.net.satellites || 0;
  const homeOn = hw.net.homeStage === 'on';
  const baseOk = eth.length > 0 && apRadios.length > 0;
  const wiredNotes: Note[] = [];
  if (isSat) wiredNotes.push({ kind: 'info', text: hw.net.paired ? 'Bu cihaz uydu: yayın ayarlarını ana cihazdan alır.' : 'Bu cihaz uydu: Uydular panelinden ana cihazla eşleştirin.' });
  else {
    if (!homeOn) wiredNotes.push({ kind: 'info', text: "Uydular bu cihazın ev Wi-Fi'ını yayınlar — önce ev Wi-Fi'ını açın." });
    wiredNotes.push({ kind: 'info', text: 'Uydu: ikinci Klyrix cihazı kurulumda "Uydu" seçilerek kurulur; eşleştirme Uydular panelinden.' });
  }
  out.push({
    id: 'mesh-wired', group: 'mesh', phase: null,
    status: unknownRadios ? 'unknown' : (isSat ? hw.net.paired : sats > 0) ? 'active' : baseOk ? 'available' : 'needs-hw',
    checks: [
      { ok: eth.length > 0, label: 'Ethernet (uydu bağlantısı)', value: names(linked) || names(eth) || 'yok' },
      { ok: unknownRadios ? null : apRadios.length > 0, label: 'AP modu (yayın)', value: unknownRadios ? unk : apRadios.length ? 'var' : 'yok' },
      isSat
        ? { ok: !!hw.net.paired, label: 'Ana cihazla eşleşme', value: hw.net.paired ? 'eşleşti' : 'yok' }
        : { ok: sats > 0 ? true : homeOn, label: 'Uydular', value: sats > 0 ? `${sats} uydu` : homeOn ? 'eklenmedi' : "ev Wi-Fi'ı kapalı" },
    ],
    need: isSat || sats > 0 ? [] : [HW_SUGGEST.secondDevice],
    notes: wiredNotes,
  });

  // Kablosuz mesh: 802.11s + SAE (scripts/mesh.sh). İdeali mesh radyosu + ayrı yayın radyosu; tek radyoda AP + mesh
  // birlikte olabiliyorsa o da olur. Omurga ana cihazdan açılır, uydular ayarı senkronla alır.
  const meshWithAp = meshRadios.some(r => r.apMesh) || meshRadios.some(m => apRadios.some(a => a !== m));
  const meshNotes: Note[] = [];
  if (radios.some(r => r.driver === 'brcmfmac')) meshNotes.push({ kind: 'info', text: "Pi'nin dahili Wi-Fi'ı (brcmfmac) mesh ve 4 adresli köprüyü desteklemez." });
  if (!isSat && meshWithAp && !hw.net.meshConfigured) meshNotes.push({ kind: 'info', text: 'Uydular panelinden açılır; uydularda da mesh destekli radyo olmalı.' });
  out.push({
    id: 'mesh-wireless', group: 'mesh', phase: null,
    status: unknownRadios ? 'unknown' : hw.net.meshConfigured ? 'active' : meshWithAp ? 'available' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : meshRadios.length > 0, label: '802.11s mesh modu', value: unknownRadios ? unk : meshRadios.map(radioLabel).join(', ') || 'yok' },
      { ok: unknownRadios ? null : meshWithAp, label: 'Mesh + yayın birlikte', value: unknownRadios ? unk : meshWithAp ? 'var' : 'yok' },
    ],
    need: [...(!unknownRadios && !meshWithAp ? [HW_SUGGEST.wifiMesh] : []), ...(isSat || sats > 0 ? [] : [HW_SUGGEST.secondDevice])],
    notes: meshNotes,
  });
  return out;
}

// ─── Donanım profili (saf ayrıştırma + önbellekli okuma) ───

const KIOSK_STATES: KioskSupport[] = ['ok', 'warn', 'no', 'no-display'];
// platform.sh detect çıktısı (KEY=VALUE) → Platform. Beklenen anahtarlar yoksa (eski / bozuk çıktı) null.
export function parsePlatform(kv: Record<string, string>): Platform | null {
  if (kv.profile !== 'lite' && kv.profile !== 'standard') return null;
  const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : 0);
  const kiosk = KIOSK_STATES.includes(kv.kiosk as KioskSupport) ? (kv.kiosk as KioskSupport) : 'ok';
  return {
    board: kv.board || '', rpi: kv.rpi === '1', arch: kv.arch || '', kernelArch: kv.kernel_arch || '',
    cpus: n(kv.cpus), memMiB: n(kv.mem_mib), memClassMiB: n(kv.mem_class),
    profile: kv.profile, forced: kv.forced === '1', display: kv.display === '1', kiosk,
    swap: { mib: n(kv.swap_mib), zram: kv.swap_zram === '1', file: kv.swap_file === '1', mgr: kv.swap_mgr || 'none' },
  };
}

const PLATFORM_SCRIPT = path.resolve(__dirname, '../../scripts/platform.sh');
const PLATFORM_TTL_MS = 60000;
let platformCache: { at: number; value: Platform | null } | null = null;
let platformRun: Promise<Platform | null> | null = null;
// Bellek / mimari değişmez, ekran ve takas nadiren: 60 sn önbellek (kiosk, Unbound ve Cihaz Rolleri aynı sonucu paylaşır).
// Linux dışında ya da betik çalışmazsa null (çağıranlar bugünkü davranışa döner).
export function readPlatform(): Promise<Platform | null> {
  if (platformCache && Date.now() - platformCache.at < PLATFORM_TTL_MS) return Promise.resolve(platformCache.value);
  if (platformRun) return platformRun;
  platformRun = (async () => {
    let value: Platform | null = null;
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execFileP('bash', [PLATFORM_SCRIPT, 'detect'], { timeout: 5000 });
        value = parsePlatform(parseKv(stdout));
      } catch { /* betik yok / zaman aşımı */ }
    }
    platformCache = { at: Date.now(), value };
    return value;
  })().finally(() => { platformRun = null; });
  return platformRun;
}

// ─── Kart türü ───

// USB modem / telefon paylaşımı sürücüleri (HiLink 4G modem, Android RNDIS, iPhone): TEK liste. Aynı içerik
// scripts/net-mode.sh BAK_USB_DRIVERS (yedek hat USB türü) ve FailoverPanel USB_DRIVERS'ta — bu sürümde onlar değişmez,
// üçünün eşitliğini test denetler. USB 2.5G Ethernet adaptörü cdc_ncm ile bağlanırsa o da bu türe düşer.
export const USB_MODEM_DRIVERS: readonly string[] = ['rndis_host', 'cdc_ether', 'cdc_ncm', 'ipheth'];
// SIM'li modemler (QMI / MBIM; AT ile çevirmeli Huawei NCM çubuk kipi ve Sierra DirectIP): APN / PIN ya da çevirme
// (AT^NDISDUP / AT!SCACT) ister, çevrilmeden DHCP almaz — tanınır, desteklenmez (ayrı faz). DEVTYPE=wwan'a bakılmaz:
// cdc_ether'in wwan_info aygıtları (Telit, bazı ZTE) yedek hattın USB türüyle (BAK_USB_DRIVERS) çakışırdı.
export const WWAN_DRIVERS: readonly string[] = ['qmi_wwan', 'cdc_mbim', 'huawei_cdc_ncm', 'sierra_net'];
export function portKind(driver: string, wireless = false): PortKind {
  if (wireless) return 'wifi';
  if (USB_MODEM_DRIVERS.includes(driver)) return 'usb-modem';
  if (WWAN_DRIVERS.includes(driver)) return 'wwan';
  return 'ethernet';
}

// `ip -j link show` çıktısı → kart adı → kalıcı MAC (permaddr; iproute2 yalnız geçerli adresten farklıysa yazar —
// yazmadığı kartta kalıcı MAC geçerli adrestir). net-mode.sh perm_mac ile aynı anlam (orada önce ethtool -P).
export function parsePermAddrs(json: string): Map<string, string> {
  const out = new Map<string, string>();
  let links: unknown;
  try { links = JSON.parse(json); } catch { return out; }
  if (!Array.isArray(links)) return out;
  for (const l of links as { ifname?: unknown; permaddr?: unknown }[]) {
    const mac = typeof l?.permaddr === 'string' ? l.permaddr.toLowerCase() : '';
    if (typeof l?.ifname === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) out.set(l.ifname, mac);
  }
  return out;
}
// dev verilirse yalnız o kart (tak-çalıştır: yeni kart için bir kez). ip yoksa / hata: boş (geçerli adres kullanılır).
export async function readPermAddrs(dev?: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileP('ip', ['-j', 'link', 'show', ...(dev ? ['dev', dev] : [])], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return parsePermAddrs(stdout);
  } catch { return new Map(); }
}

// ─── Canlı okuma (Linux) ───

const readText = (p: string) => { try { return fs.readFileSync(p, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; } };
// Fiziksel kablolu kart: Ethernet türü (type=1), aygıtı var (sanal değil: VLAN, köprü, veth, dummy elenir), kablosuz değil.
const isWiredCard = (base: string) => !(readText(`${base}/type`) !== '1' || fs.existsSync(`${base}/wireless`) || fs.existsSync(`${base}/phy80211`)
  || fs.existsSync(`${base}/bridge`) || !fs.existsSync(`${base}/device`));
// Wi-Fi kartı (tak-çalıştır): aynı süzgeç, kablosuz olanlar.
const isWifiCard = (base: string) => readText(`${base}/type`) === '1' && (fs.existsSync(`${base}/wireless`) || fs.existsSync(`${base}/phy80211`))
  && !fs.existsSync(`${base}/bridge`) && fs.existsSync(`${base}/device`);
const driverOf = (devPath: string) => { try { return path.basename(fs.realpathSync(path.join(devPath, 'driver'))); } catch { return ''; } };
// USB aygıt dizini (speed + idVendor dosyaları olan) arayüz dizininin üstlerinde; USB değilse ya da bulunamazsa ''.
function usbDevDir(devPath: string): string {
  let real = '';
  try { real = fs.realpathSync(devPath); } catch { return ''; }
  if (!/\/usb\d*\//.test(real)) return '';
  for (let d = real; d.length > 5; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'idVendor')) && fs.existsSync(path.join(d, 'speed'))) return d;
  }
  return '';
}
function busInfo(devPath: string): { bus: Bus; usbSpeedMbps: number | null } {
  let real = '';
  try { real = fs.realpathSync(devPath); } catch { return { bus: 'onboard', usbSpeedMbps: null }; }
  if (!/\/usb\d*\//.test(real)) return { bus: 'onboard', usbSpeedMbps: null };
  const d = usbDevDir(real);
  if (!d) return { bus: 'usb', usbSpeedMbps: null };
  const s = Number(readText(path.join(d, 'speed')));
  return { bus: 'usb', usbSpeedMbps: Number.isFinite(s) && s > 0 ? s : null };
}
const onPath = (bin: string) => ['/usr/sbin', '/usr/bin', '/sbin', '/bin', '/usr/local/sbin', '/usr/local/bin'].some(d => fs.existsSync(path.join(d, bin)));
async function hasModule(name: string): Promise<boolean> {
  try { await execFileP('modinfo', ['-n', name], { timeout: 5000 }); return true; } catch { return false; }
}

// opts yalnız test içindir: sahte /sys kökü, hazır `iw list` / `ip -j link show` çıktısı ve hazır donanım profili.
export async function readHardware(net: Omit<Hardware['net'], 'uplinkIface'>, opts: { root?: string; iwText?: string; linkJson?: string; platform?: Platform | null } = {}): Promise<Hardware> {
  const R = opts.root || '';
  let uplinkIface: string | null = null;
  try {
    const { stdout } = await execFileP('ip', ['-j', '-4', 'route', 'show', 'default'], { timeout: 5000 });
    uplinkIface = (JSON.parse(stdout) as any[]).find(r => r?.dev)?.dev || null;
  } catch { /* rota yok */ }
  const perm = opts.linkJson !== undefined ? parsePermAddrs(opts.linkJson) : await readPermAddrs();

  const eth: EthPort[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(`${R}/sys/class/net`); } catch { /* yok */ }
  for (const name of names.sort()) {
    const base = `${R}/sys/class/net/${name}`;
    if (!isWiredCard(base)) continue;
    const speed = Number(readText(`${base}/speed`));
    const carrier = readText(`${base}/carrier`);
    // Ev Wi-Fi'ı açıkken varsayılan rota köprüdedir (br0): köprünün portu olan kart da bağlantı kartıdır.
    let master = '';
    try { master = path.basename(fs.readlinkSync(`${base}/master`)); } catch { /* köprüde değil */ }
    const driver = driverOf(`${base}/device`);
    const mac = readText(`${base}/address`);
    eth.push({
      name, driver, ...busInfo(`${base}/device`),
      speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
      carrier: carrier === '1' ? true : carrier === '0' ? false : null,
      // İnternet kartı VLAN / PPPoE ile bağlıysa varsayılan rota o arayüzdedir (wan.35 / pppwan): kartın kendisi çıkıştır.
      mac,
      uplink: !!uplinkIface && (name === uplinkIface || master === uplinkIface
        || (!!net.wanDev && uplinkIface === net.wanDev && name === net.wanPort)),
      kind: portKind(driver), permMac: perm.get(name) || mac.toLowerCase(),
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
  const [mods, platform] = await Promise.all([
    Promise.all(modNames.map(hasModule)),
    opts.platform !== undefined ? Promise.resolve(opts.platform) : readPlatform(),
  ]);
  return {
    // Kart adı: device-tree (ARM); yoksa DMI üretici + ürün (x86, platform.sh); o da yoksa makine adı.
    board: readText(`${R}/proc/device-tree/model`) || platform?.board || os.hostname(), kernel: os.release(), iwMissing,
    platform,
    eth, radios,
    tools: Object.fromEntries(toolNames.map(t => [t, onPath(t)])),
    modules: Object.fromEntries(modNames.map((m, i) => [m, mods[i]])),
    net: { ...net, uplinkIface },
  };
}

// ─── Tak-çalıştır taraması (portWatch.ts; yalnız algılama açıkken) ───

// Ucuz liste (her yoklamada): kablolu kartlar readHardware ile aynı süzgeçle, Wi-Fi kartları radyo (phy) başına bir kez —
// aynı radyoda açılan ek arayüzler (ap0, mesh0 …) yeni kart sayılmaz. key: kablolu kartta ad + ifindex (çıkarılıp başka
// kart aynı adla takılırsa yeni anahtar), Wi-Fi'da radyo adı (yeniden takılan USB radyo yeni phy numarası alır).
export type NetCardRef = { name: string; key: string; wifi: boolean; phy: string };
export function listNetCards(root = ''): NetCardRef[] {
  let names: string[] = [];
  try { names = fs.readdirSync(`${root}/sys/class/net`); } catch { return []; }
  const out: NetCardRef[] = [];
  const phys = new Set<string>();
  for (const name of names.sort()) {
    const base = `${root}/sys/class/net/${name}`;
    if (isWiredCard(base)) out.push({ name, key: `${name}#${readText(`${base}/ifindex`)}`, wifi: false, phy: '' });
    else if (isWifiCard(base)) {
      const phy = readText(`${base}/phy80211/name`) || name;
      if (phys.has(phy)) continue;
      phys.add(phy);
      out.push({ name, key: `phy:${phy}`, wifi: true, phy });
    }
  }
  return out;
}

// Ayrıntı (yalnız yeni anahtarda bir kez): sürücü, USB hızı, bağlantı hızı, kablo, geçerli MAC. Wi-Fi'da MAC radyonun
// kalıcı adresi (/sys/class/ieee80211/<phy>/macaddress), hız ve kablo yok. USB aygıtında ayrıca:
//  - usbVersion: aygıtın bildirdiği USB sürümü (bcdUSB, `version`; 2.00 / 2.10 / 3.20). USB 3 aygıt USB 2 portta 2.10
//    bildirir: 2.10'dan küçükse aygıt kesin USB 2'dir (mavi porta takmak hızı değiştirmez).
//  - usbId: aygıt kimliği (idVendor:idProduct + seri no; seri yoksa USB port yolu, ör. 3-1) — adresi her bağlanışta
//    değişen kartın tak-çalıştır kimliği (portWatch.ts).
//  - addrRandom: çekirdek kartın adresini rastgele verdi (addr_assign_type 1: ZTE cdc_ether, geçersiz EEPROM MAC).
export type NetCard = {
  name: string; kind: PortKind; driver: string; bus: Bus; usbSpeedMbps: number | null; speedMbps: number | null;
  carrier: boolean | null; mac: string; usbVersion: number | null; usbId: string; addrRandom: boolean;
};
function usbDetail(devPath: string): { usbVersion: number | null; usbId: string } {
  const d = usbDevDir(devPath);
  if (!d) return { usbVersion: null, usbId: '' };
  const v = parseFloat(readText(path.join(d, 'version')));
  const id = [readText(path.join(d, 'idVendor')), readText(path.join(d, 'idProduct'))].join(':');
  const serial = readText(path.join(d, 'serial'));
  return { usbVersion: Number.isFinite(v) && v > 0 ? v : null, usbId: serial ? `${id}:${serial}` : `${id}@${path.basename(d)}` };
}
export function describeNetCard(ref: NetCardRef, root = ''): NetCard {
  const base = `${root}/sys/class/net/${ref.name}`;
  const driver = driverOf(`${base}/device`);
  if (ref.wifi) {
    const mac = (readText(`${root}/sys/class/ieee80211/${ref.phy}/macaddress`) || readText(`${base}/address`)).toLowerCase();
    return { name: ref.name, kind: 'wifi', driver, ...busInfo(`${base}/device`), speedMbps: null, carrier: null, mac, ...usbDetail(`${base}/device`), addrRandom: false };
  }
  const speed = Number(readText(`${base}/speed`));
  const carrier = readText(`${base}/carrier`);
  return {
    name: ref.name, kind: portKind(driver), driver, ...busInfo(`${base}/device`),
    speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
    carrier: carrier === '1' ? true : carrier === '0' ? false : null,
    mac: readText(`${base}/address`).toLowerCase(),
    ...usbDetail(`${base}/device`), addrRandom: readText(`${base}/addr_assign_type`) === '1',
  };
}

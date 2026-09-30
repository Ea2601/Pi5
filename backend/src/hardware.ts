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
  // yayını (ev Wi-Fi'ı) ev ağı olur, Klyrix özellikleri arkadaki cihazlara uygulanır. En iyisi iki radyo (biri bağlantı,
  // biri yayın). Aynı ağ kipleri (4 adresli köprü / ARP vekili) sonraki adımda; 4 adresli köprü üst router'ın da 4
  // adresli (WDS) istemciyi kabul etmesini ister (ev modemlerinin çoğu etmez).
  const staRadios = radios.filter(r => r.sta);
  const twoRadio = staRadios.some(s => apRadios.some(a => a !== s));
  const bridgeCapable = staRadios.some(r => r.fourAddr === true);
  const repStage = hw.net.wanSsid ? (hw.net.wanStage || 'none') : 'none';
  const repNotes: Note[] = [];
  if (repStage === 'trial') repNotes.push({ kind: 'info', text: "Deneme sürüyor: internet çalışıyorsa WAN router panelinden 'Kalıcı yap'a basın; basılmazsa Pi eski ayara döner." });
  if (!unknownRadios && !satRole && repStage === 'none' && staRadios.length) {
    repNotes.push({ kind: 'info', text: "Ayrı ağ (yönlendirmeli): WAN router panelinde internet kartı olarak Wi-Fi kartını seçip üst Wi-Fi'ın adını ve parolasını girin. Kurulum kabloyla yapılır; kalıcı yaptıktan sonra kablo çıkarılıp Pi yerine taşınır." });
  }
  if (!unknownRadios && staRadios.length && !twoRadio) {
    repNotes.push({ kind: 'info', text: "Tek Wi-Fi radyosu: üst Wi-Fi'a bağlanınca ev ağı yalnız kablodan (eth0) olur; kablosuz yayın için ikinci bir Wi-Fi kartı gerekir." });
  }
  out.push({
    id: 'repeater', group: 'wireless', phase: null,
    status: unknownRadios ? 'unknown' : repStage === 'on' ? 'active' : staRadios.length ? 'available' : 'needs-hw',
    checks: [
      { ok: unknownRadios ? null : staRadios.length > 0, label: 'Bağlantı radyosu (istemci)', value: unknownRadios ? unk : staRadios.map(radioLabel).join(', ') || 'yok' },
      { ok: unknownRadios ? null : twoRadio, label: 'Ayrı yayın radyosu', value: unknownRadios ? unk : `${radios.length} radyo` },
      ...(repStage !== 'none'
        ? [{ ok: repStage === 'on', label: 'Üst Wi-Fi', value: `${hw.net.wanSsid} · ${hw.net.wanPort || '—'}${repStage === 'on' ? '' : ' (deneme)'}` }]
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
    // Ev Wi-Fi'ı açıkken varsayılan rota köprüdedir (br0): köprünün portu olan kart da bağlantı kartıdır.
    let master = '';
    try { master = path.basename(fs.readlinkSync(`${base}/master`)); } catch { /* köprüde değil */ }
    eth.push({
      name, driver: driverOf(`${base}/device`), ...busInfo(`${base}/device`),
      speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
      carrier: carrier === '1' ? true : carrier === '0' ? false : null,
      // İnternet kartı VLAN / PPPoE ile bağlıysa varsayılan rota o arayüzdedir (wan.35 / pppwan): kartın kendisi çıkıştır.
      mac: readText(`${base}/address`),
      uplink: !!uplinkIface && (name === uplinkIface || master === uplinkIface
        || (!!net.wanDev && uplinkIface === net.wanDev && name === net.wanPort)),
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

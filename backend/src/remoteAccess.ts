// Uzaktan yönetim — yalnız VPN istemcileri (CGNAT arkasından). Kullanıcının KENDİ VPS'inin WireGuard istemcilerinden
// (telefon, dizüstü) "Panel erişimi" işaretlenenler paneli http://10.66.66.2 adresinden açar:
//   telefon (AllowedIPs 0.0.0.0/0) → VPS wg0 (wg0 ↔ wg0 iletimi kurulumda açık, ssh.ts) → Pi wg_vps<id> → nginx :80.
// Panel internete AÇILMAZ: alan adı, TLS, ters vekil, merkezi portal yok; Pi'nin tüneli yine Pi'den dışarı kurulur.
//  - Dönüş yolu: Pi'nin tünel adresi 10.66.66.2/32 ve Table = off (ssh.ts) — VPS tarafından başlayan bağlantının yanıtı
//    bugün ana tablodan operatöre çıkar ve kaybolur. İşaretli her istemciye `10.66.66.X/32 dev wg_vps<id> proto 177`
//    rotası konur (proto 177 yalnız bu modülündür). Arayüz yoksa rota konmaz; wg-quick yeniden başlayınca arayüzün
//    rotaları silinir → tünel izleyicisi (index.ts, 30 sn) her turda yeniden eşitler.
//  - Süzgeç: nft `inet pi5_relay` (/etc/nftables.d/pi5-relay.conf, açılışta include ve pi5-gw-restore yükler):
//      giriş (öncelik -10): işaretli istemciler yalnız KENDİ VPS tünellerinden ve yalnız panel (80), SSH (22), DNS (53) ve
//      ping için yeni bağlantı açar; VPS tünellerinden gelen diğer her YENİ bağlantı düşer (işaretsiz istemciler, VPS'in
//      kendi adresi, başka bir VPS'in aynı numaralı istemcisi, yöneticinin öbür portları — ağ paylaşımı vb.). Port sınırı
//      burada: panelin güvenlik duvarı (pi5_filter) hiç kurulmamış Pi'de de geçerli. Buradaki accept yalnız bu zinciri
//      bitirir: pi5_filter (öncelik 0) varsa yine karar verir — hiçbir izin genişlemez.
//      iletim (öncelik -10): ev ağı ile işaretli istemciler arasında iki yönde de YENİ bağlantı düşer — /32 rotası onları
//      ev ağına açmasın (VPS ev ağını Pi'ye yönlendirse bile).
//      son yönlendirme (postrouting, öncelik -10): yöneticinin açtığı bağlantının yanıtı yalnız onun VPS tünelinden çıkar —
//      Routing'deki bir IP aralığı kuralı 10.66.66.X'i başka bir VPS'e işaretlese (orada aynı numara başka cihazdır) yanıt
//      düşer, sızmaz.
//    VPS'in kendisi yöneticinin adresini taklit edebilir (Pi'nin eşi AllowedIPs 0.0.0.0/0) ve panel bu yolda HTTP'dir:
//    VPS'i yöneten trafiği görür. Seçenek B'nin kabul edilen sınırı — arayüz ve belgeler kullanıcıya söyler.
//    Açık bağlantıların yanıtları (Pi'nin tünelden çıkan kendi trafiği, Ev VPN'inin dış deneme paketleri — onlar zaten
//    internet kartından gelir) 'new' değildir, etkilenmez. drop her tabloda kesindir (wgServer.ts ile aynı gerekçe).
//  - Panel parolası şarttır: koruma kalıcı açık (panel-auth.state = on) değilse plan boştur — sonradan kapatılırsa erişim
//    30 sn içinde geri çekilir. Uyduda da plan boştur (ana cihaz özelliği). İşaretli istemciler tek VPS'te olabilir:
//    istemci adresleri VPS başına numaralanır (10.66.66.3 iki VPS'te ayrı cihazdır), /32 rotası çakışırdı.
//  - Ev ağı çakışması: Pi'nin VPS tüneli dışındaki bir kartının ağı 10.66.66.0/24 ile çakışırsa (sonradan değişen ev
//    ağı, eski iki kartlı düzen) plan boştur — /32 rotası o ağdaki aynı adresli cihazın yanıtlarını tünele çekerdi.
//    Durum olay kaydına bir kez yazılır; çakışma kalkınca erişim kendiliğinden döner.
//  - Özellik kapalıyken (işaretli istemci yok) rota da tablo da dosya da yoktur: bugünkü durumun aynısı. Uygularken önce
//    nft, sonra rotalar; kaldırırken önce rotalar, sonra tablo.
// KURAL: hiçbir aktarım 127.0.0.1'e yapılmaz — Pi'nin kendisi (loopback) panel parolasından muaftır (panel-auth.sh geo,
// auth.ts). Bu modül yalnız 10.66.66.X/32 rotası ve süzgeç kurar; DNAT / vekil / yönlendirme yoktur.
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll } from './db';
import { isLinux } from './system';
import { isSatellite } from './role';
import { inCidr } from './topology';
import { vpsIface } from './vpsTunnel';
import { recordEvent } from './events';

const execFileP = promisify(execFile);

export const RELAY_NET = '10.66.66.0/24';
export const PANEL_TUNNEL_IP = '10.66.66.2';
export const PANEL_TUNNEL_URL = `http://${PANEL_TUNNEL_IP}`;
export const RELAY_PROTO = '177';
const NFT_TABLE = 'pi5_relay';
export const RELAY_NFT_FILE = '/etc/nftables.d/pi5-relay.conf';
const PANEL_AUTH_STATE = '/etc/pi5-gateway/panel-auth.state';

export interface RelayRow { vps_id: number | string; ip: string; panel_access?: number | string | null }
export interface RelayRoute { ip: string; iface: string }
export interface RelayPlan {
  routes: RelayRoute[];   // arayüzü olan işaretli istemcilerin /32 rotaları
  nft: string | null;     // pi5-relay.conf metni; null = tablo ve dosya kaldırılır
  error?: string;         // işaretli istemciler birden çok VPS'te (veritabanı elle değişti): plan boş
  blocked?: string;       // işaretli istemci var ama ev ağı çakışıyor: plan boş (hata değil — kapalı durum uygulanır)
}

// İstemci adresi ("10.66.66.7/32" ya da "10.66.66.7") → "10.66.66.7"; yalnız istemci aralığı (.3–.254: .1 VPS, .2 Pi).
export function clientTunnelIp(ip: unknown): string | null {
  const m = /^10\.66\.66\.(\d{1,3})(?:\/32)?$/.exec(String(ip ?? '').trim());
  if (!m) return null;
  const host = Number(m[1]);
  return host >= 3 && host <= 254 ? `10.66.66.${host}` : null;
}

// İki IPv4 ağı (a.b.c.d/nn) çakışıyor mu: biri öbürünün ağ adresini içeriyorsa.
export function cidrOverlaps(a: string, b: string): boolean {
  const ok = (c: string) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(c) && Number(c.split('/')[1]) <= 32;
  if (!ok(a) || !ok(b)) return false;
  return inCidr(a.split('/')[0], b) || inCidr(b.split('/')[0], a);
}

const flagged = (rows: RelayRow[]) => rows.filter(r => Number(r.panel_access) === 1 && clientTunnelIp(r.ip));

// Açmadan önce (API): başka bir VPS'te işaretli istemci varsa onun kimliği.
export function panelAccessConflict(rows: RelayRow[], vpsId: number): number | null {
  const other = flagged(rows).find(r => Number(r.vps_id) !== vpsId);
  return other ? Number(other.vps_id) : null;
}

// Yöneticinin yeni bağlantı açabildiği hizmetler: panel (nginx 80), SSH (22), DNS (Pi-hole 53) ve ping. Arayüz ve belgeler
// bunu söyler; ağ paylaşımı (445) ve diğer her port (güvenlik duvarındaki özel izinler dahil) tünelden açılmaz.
export const RELAY_TCP_PORTS = [22, 53, 80];
export function renderRelayNft(iface: string, admins: string[]): string {
  const set = `{ ${admins.join(', ')} }`;
  const from = `iifname "${iface}" ip saddr ${set}`;
  return [
    `table inet ${NFT_TABLE} {}`,
    `delete table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority -10; policy accept;',
    `    ${from} tcp dport { ${RELAY_TCP_PORTS.join(', ')} } accept`,
    `    ${from} udp dport 53 accept`,
    `    ${from} icmp type echo-request accept`,
    '    iifname "wg_vps*" ct state new drop',
    '  }',
    '  chain forward {',
    '    type filter hook forward priority -10; policy accept;',
    `    oifname "wg_vps*" ip daddr ${set} ct state new drop`,
    `    iifname "wg_vps*" ip saddr ${set} ct state new drop`,
    '  }',
    // Çıkış kartı postrouting'de denetlenir: output kancasında oifname, bir işaretle (mangle OUTPUT) yeniden yönlendirilen
    // paketin ESKİ kartını gösterir (kanca durumu yeniden yönlendirmeden önce kurulur) — kontrol orada boşa düşerdi.
    '  chain postrouting {',
    '    type filter hook postrouting priority -10; policy accept;',
    `    ip daddr ${set} ct direction reply oifname != "${iface}" drop`,
    '  }',
    '}',
    '',
  ].join('\n');
}

// Saf plan: veritabanı satırları + arayüz var mı (+ Pi'nin VPS tüneli dışındaki ağları) → rotalar ve nft metni. İşaretli
// istemci yoksa ya da bir ağ 10.66.66.0/24 ile çakışıyorsa boş plan (bugünkü durum).
export function planRemoteAccess(rows: RelayRow[], ifaceExists: (iface: string) => boolean, localNets: string[] = []): RelayPlan {
  const on = flagged(rows);
  if (!on.length) return { routes: [], nft: null };
  const clash = localNets.find(n => cidrOverlaps(n, RELAY_NET));
  if (clash) return { routes: [], nft: null, blocked: `Pi'deki ağ (${clash}) VPS tünel ağıyla (${RELAY_NET}) çakışıyor` };
  const vpsIds = [...new Set(on.map(r => Number(r.vps_id)))];
  if (vpsIds.length !== 1 || !Number.isSafeInteger(vpsIds[0]) || vpsIds[0] < 1) {
    return { routes: [], nft: null, error: `panel erişimi birden çok VPS'in istemcisinde açık (${vpsIds.join(', ')}) — uygulanmadı` };
  }
  const iface = vpsIface(vpsIds[0]);
  const admins = [...new Set(on.map(r => clientTunnelIp(r.ip)!))].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
  return {
    routes: ifaceExists(iface) ? admins.map(ip => ({ ip, iface })) : [],
    nft: renderRelayNft(iface, admins),
  };
}

// Panel koruması kalıcı açık mı (panel-auth.sh'nin durum dosyası: "<durum> <deneme_bitişi>"). Okunamazsa kapalı sayılır.
export function panelAuthOn(file = PANEL_AUTH_STATE): boolean {
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] === 'on';
  } catch {
    return false;
  }
}

// Pi'nin VPS tünelleri (wg_vps*) ve loopback dışındaki IPv4 adresleri, "a.b.c.d/nn" (ev ağı, internet kartı, eski iki kartlı
// düzenin LAN kartı, Wi-Fi, Ev VPN'i …). Biri 10.66.66.0/24 ile çakışırsa uzaktan yönetim durur. Okunamazsa fırlatır.
export async function localNetworks(): Promise<string[]> {
  const { stdout } = await execFileP('ip', ['-j', '-4', 'addr', 'show'], { timeout: 5000 });
  const out: string[] = [];
  for (const a of JSON.parse(stdout || '[]') as { ifname?: string; addr_info?: { local?: string; prefixlen?: number }[] }[]) {
    const name = String(a.ifname || '');
    if (name === 'lo' || name.startsWith('wg_vps')) continue;
    for (const x of a.addr_info || []) if (x.local && typeof x.prefixlen === 'number') out.push(`${x.local}/${x.prefixlen}`);
  }
  return out;
}

// Çakışma yüzünden durdurulduysa olay kaydına bir kez (neden değişince yeniden) yazılır.
let lastBlocked = '';
async function noteBlocked(reason = ''): Promise<void> {
  if (reason === lastBlocked) return;
  lastBlocked = reason;
  if (!reason) return;
  console.error('[uzaktan yönetim] durduruldu:', reason);
  await recordEvent('vps', `Uzaktan yönetim durduruldu: ${reason} — panel erişimi açık istemciler panele tünelden ulaşamaz; çakışma kalkınca kendiliğinden döner`, 'warning');
}

async function currentRoutes(): Promise<RelayRoute[]> {
  const { stdout } = await execFileP('ip', ['-4', 'route', 'show', 'proto', RELAY_PROTO], { timeout: 5000 });
  const out: RelayRoute[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/32)?\s.*\bdev\s+(\S+)/.exec(line.trim());
    if (m) out.push({ ip: m[1], iface: m[2] });
  }
  return out;
}
const delRoute = (r: RelayRoute) =>
  execFileP('ip', ['-4', 'route', 'del', `${r.ip}/32`, 'dev', r.iface, 'proto', RELAY_PROTO], { timeout: 5000 })
    .then(() => '', (e: any) => `${r.ip} ${r.iface}: ${String(e?.stderr || e?.message || e).trim().split('\n').pop()}`);
const tableExists = () =>
  execFileP('nft', ['list', 'table', 'inet', NFT_TABLE], { timeout: 5000 }).then(() => true, () => false);
const errText = (e: any) => String(e?.stderr || e?.message || e).trim().split('\n').pop()?.slice(0, 300) || 'bilinmeyen hata';

// Doğrulamalı yükleme (services.ts configureNftables deseni): geçici dosya `nft -c` ile sınanır, yüklenir, ancak sonra
// kalıcı dosya olur. Geçici ad .conf ile bitmez: eşzamanlı bir nftables yeniden yüklemesinin include'una girmesin.
async function loadNft(text: string): Promise<void> {
  fs.mkdirSync('/etc/nftables.d', { recursive: true });
  const tmp = `${RELAY_NFT_FILE}.new.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  try {
    await execFileP('nft', ['-c', '-f', tmp], { timeout: 10000 }).catch(e => { throw new Error(`süzgeç sınamadan geçmedi: ${errText(e)}`); });
    await execFileP('nft', ['-f', tmp], { timeout: 10000 }).catch(e => { throw new Error(`süzgeç yüklenemedi: ${errText(e)}`); });
    fs.renameSync(tmp, RELAY_NFT_FILE);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* taşındı */ }
  }
}

let nftApplied = '';
// Kapalı durum bu süreçte bir kez doğrulandı mı: özellik kullanılmıyorken izleyicinin her turu ip / nft çalıştırmasın.
// Bir şey uygulanınca düşer. (Dosya silindiği için tablo kendiliğinden geri gelemez; rotalar yalnız buradan eklenir.)
let cleanVerified = false;
// Planı uygular (idempotent; index.ts yönlendirme kuyruğunda çağırır). Süzgeç kurulamazsa rota da konmaz (kapalı kalır).
export async function syncRemoteAccess(): Promise<RelayPlan> {
  if (!isLinux) return { routes: [], nft: null };
  const rows = !isSatellite() && panelAuthOn()
    ? await dbAll('SELECT vps_id, ip, panel_access FROM wg_clients WHERE panel_access = 1') as RelayRow[]
    : [];
  let plan: RelayPlan;
  try {
    // Kartlar yalnız işaretli istemci varken okunur: özellik kapalıyken izleyicinin turu hiçbir komut çalıştırmaz.
    plan = planRemoteAccess(rows, iface => fs.existsSync(`/sys/class/net/${iface}`), rows.length ? await localNetworks() : []);
  } catch (e) {
    plan = { routes: [], nft: null, blocked: `Pi'nin ağ kartları okunamadı (${errText(e)})` };
  }
  await noteBlocked(plan.blocked);
  if (!plan.nft && cleanVerified) {
    if (plan.error) throw new Error(plan.error);
    return plan;
  }
  const current = await currentRoutes().catch(() => [] as RelayRoute[]);
  const key = (r: RelayRoute) => `${r.ip} ${r.iface}`;
  if (!plan.nft) {
    // Kaldırma: önce rotalar, sonra tablo ve dosya — bugünkü durum.
    const errs: string[] = [];
    for (const r of current) { const e = await delRoute(r); if (e) errs.push(e); }
    if (await tableExists()) {
      await execFileP('nft', ['delete', 'table', 'inet', NFT_TABLE], { timeout: 5000 }).catch((e: any) => { errs.push(`nft: ${errText(e)}`); });
    }
    try { fs.unlinkSync(RELAY_NFT_FILE); } catch { /* yok */ }
    nftApplied = '';
    const left = await currentRoutes().catch(() => null);
    cleanVerified = !!left && !left.length && !fs.existsSync(RELAY_NFT_FILE) && !(await tableExists());
    if (plan.error) throw new Error(plan.error);
    // Erişim hâlâ açık (dönüş rotası ya da süzgeç kaldı): "kapatıldı" denmesin; izleyici 30 sn'de bir yeniden dener
    if (!cleanVerified) {
      throw new Error(`Uzaktan panel erişimi tam kaldırılamadı${left ? ` (${left.length} dönüş rotası kaldı)` : ' (rotalar okunamadı)'}${errs.length ? `: ${errs.join('; ').slice(0, 300)}` : ''} — 30 sn'de bir yeniden denenecek`);
    }
    return plan;
  }
  cleanVerified = false;
  // Önce süzgeç (tablo dışarıdan silinmiş olabilir: nftables yeniden başlatma) …
  if (plan.nft !== nftApplied || !(await tableExists()) || !fs.existsSync(RELAY_NFT_FILE)) {
    try {
      await loadNft(plan.nft);
    } catch (e) {
      nftApplied = '';
      for (const r of current) await delRoute(r);
      throw e;
    }
    nftApplied = plan.nft;
  }
  // … sonra rotalar: eksikler eklenir, planda olmayanlar silinir.
  const want = new Set(plan.routes.map(key));
  const have = new Set(current.map(key));
  for (const r of current) if (!want.has(key(r))) await delRoute(r);
  for (const r of plan.routes) {
    if (have.has(key(r))) continue;
    await execFileP('ip', ['-4', 'route', 'replace', `${r.ip}/32`, 'dev', r.iface, 'proto', RELAY_PROTO], { timeout: 5000 })
      .catch(e => { throw new Error(`${r.ip} dönüş rotası eklenemedi: ${errText(e)}`); });
  }
  return plan;
}

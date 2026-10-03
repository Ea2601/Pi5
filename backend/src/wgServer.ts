// Pi üzerinde WireGuard sunucusu ("Ev VPN'i"): ev dışındaki cihazlar (telefon, dizüstü) QR ile Pi'ye bağlanır; trafikleri
// Pi'den çıkar ve paneldeki yönlendirme kurallarına tabi olur (PI5_ROUTING gelen arayüze bakmaz — system.ts PREROUTING kancası).
// VPS tünellerinden ayrıdır: onlar wg_vps<N> + 10.66.66.0/24 (Pi = .2, ssh.ts); bu sunucu wg_pi + 10.77.77.0/24 (Pi = .1),
// UDP 51820 (Pi'de başka dinleyen yok: tünellerin ListenPort'u yok).
//  - Anahtarlar Pi'de `wg genkey` ile üretilir; sunucu ve istemci anahtarları kendi tablolarında (wg_server,
//    wg_server_peers — yedeklere girmez) ve /etc/wireguard/wg_pi.conf'ta (0600) durur.
//  - İstemci yapılandırması her istendiğinde güncel uç adresiyle üretilir: paneldeki DDNS adı, yoksa dış IP. Ev IP'si
//    değişse de (DDNS geçmişinde 2-4 haftada bir) QR geçerli kalır.
//  - Roller: 'admin' ev ağına, panele ve SSH'a erişir; 'guest' yalnız internete çıkar ve Pi'nin DNS'ini kullanır: misafirden
//    Pi'ye giriş izin listesiyle — yalnız DNS (53) ve ping; panel, SSH, ağ paylaşımı, keşif servisleri (wsdd2, LLMNR, avahi),
//    NTP, cihaz yedekleme ve sonradan eklenecek her servis kapalı.
//  - Güvenlik duvarı kendi tablolarında: inet pi5_wgsrv (misafir yalıtımı), ip pi5_wgsrv_nat (maskeleme). Kurallar
//    core/pi5-wgsrv.nft'e yazılır ve arayüzün PostUp'ı yükler → Pi açılışında arayüzle aynı anda gelir. Debian'ın
//    inet filter tablosunda giriş/iletme politikası drop ise oraya kendi zincirleriyle izin eklenir (başka tablodaki accept
//    drop'u geçemez; drop ise her tabloda kesindir — misafir yalıtımı bu yüzden kendi tablosunda yeterli).
//  - Ekleme/silme/rol değişikliği bağlı istemcileri koparmadan `wg syncconf` ile uygulanır.
//  - Klyrix/Gate uygulama eşleri (gateApp.ts, registerAppPeers) aynı arayüzde ama ayrı tabloda: gizli anahtarları telefonda
//    kalır; Pi'de yalnız uygulama kapısına (APP_PORT) ulaşırlar, iletme kapalı (VPN değil). Adresleri istemcilerle aynı ağdan.
import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import dns from 'dns';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux, getCurrentExternalIp, getLanIdentity, listWireguardTunnels, readNetModeState, wanActive, activeUplink } from './system';
import { importSummary, orderProbeTunnels } from './wgConf';

const execFileP = promisify(execFile);
export const WG_IFACE = 'wg_pi';
export const WG_PORT = 51820;
export const WG_NET = '10.77.77.0/24';
const WG_PREFIX = '10.77.77.';
export const WG_SERVER_IP = `${WG_PREFIX}1`;
const CONF = `/etc/wireguard/${WG_IFACE}.conf`;
const NFT_FILE = path.resolve(__dirname, '../../core/pi5-wgsrv.nft');
const UNIT = `wg-quick@${WG_IFACE}`;
// Misafirin erişemeyeceği yerel ağlar (ev ağı, diğer VPN istemcileri, CGNAT, link-local)
const PRIVATE_NETS = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16';
// Misafirin Pi'de erişebildiği tek servis: DNS (Pi-hole, TCP/UDP 53 — istemci yapılandırmasındaki DNS = 10.77.77.1; ebeveyn
// kontrolünün "tüm ağda DNS" yönlendirmesi de 53'e iner). Geri kalan her şey (yasak liste değil izin listesi) düşer.
const GUEST_PI_PORTS = '53';
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
export const validWgKey = (k: unknown): k is string => typeof k === 'string' && KEY.test(k);
// Klyrix/Gate uygulama kapısı (gateApp.ts): Pi'de yalnız WG_SERVER_IP üzerinde dinler.
export const APP_PORT = 8097;

export type PeerRole = 'admin' | 'guest';
interface ServerRow { private_key: string; public_key: string; enabled: number }
interface PeerRow { id: number; name: string; ip: string; public_key: string; private_key: string; role: PeerRole; created_at: string }

// Klyrix/Gate uygulama eşleri (gateApp.ts — kendi tablosunda; gizli anahtarları Pi'de hiç yok): yapılandırmaya ve kurallara
// eklenir. Uygulama eşi VPN istemcisi değildir: Pi'de yalnız uygulama kapısına (APP_PORT) ulaşır, iletme kapalıdır.
export interface AppPeer { id: number; ip: string; public_key: string }
let appPeersProvider: () => Promise<AppPeer[]> = async () => [];
export function registerAppPeers(fn: () => Promise<AppPeer[]>): void { appPeersProvider = fn; }
const appPeers = () => appPeersProvider().catch((e: any): AppPeer[] => {
  console.error('[ev-vpn] uygulama eşleri okunamadı:', e?.message || e);
  return [];
});
// Bir Ev VPN'i istemcisinin adresini ya da anahtarını (veya sunucunun anahtarını) taşıyan uygulama eşi yazılmaz: aynı adres
// iki eşte olamaz — buluttan geri yüklenen istemci önceliklidir; panel o telefonu "çakışıyor" diye gösterir (gateApp.ts).
function usableApps(s: ServerRow, peers: PeerRow[], apps: AppPeer[]): AppPeer[] {
  const ips = new Set(peers.map(p => p.ip));
  const keys = new Set([s.public_key, ...peers.map(p => p.public_key)]);
  return apps.filter(a => KEY.test(a.public_key) && /^10\.77\.77\.\d{1,3}$/.test(a.ip) && !ips.has(a.ip) && !keys.has(a.public_key));
}

let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  tablesReady ??= (async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS wg_server (
      id INTEGER PRIMARY KEY CHECK (id = 1), private_key TEXT NOT NULL, public_key TEXT NOT NULL,
      enabled INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await dbRun(`CREATE TABLE IF NOT EXISTS wg_server_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
      private_key TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'guest', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  })().catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}

// Standart girdiye veri verip komutu çalıştırır (wg pubkey, qrencode). Hata → çıkış kodu ve stderr ile fırlatır.
function runInput(cmd: string, args: string[], input: string, timeout = 10000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd}: zaman aşımı`)); }, timeout);
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} (${code}): ${err.trim()}`));
    });
    p.stdin.on('error', () => { /* komut stdin'i okumadan çıktı (EPIPE): sonuç 'close' ile */ });
    p.stdin.end(input);
  });
}

async function genKeyPair(): Promise<{ priv: string; pub: string }> {
  const priv = (await execFileP('wg', ['genkey'], { timeout: 5000 })).stdout.trim();
  const pub = (await runInput('wg', ['pubkey'], `${priv}\n`)).toString().trim();
  if (!KEY.test(priv) || !KEY.test(pub)) throw new Error('WireGuard anahtarı üretilemedi');
  return { priv, pub };
}

async function serverRow(create = false): Promise<ServerRow | null> {
  await ensureTables();
  const row = await dbGet('SELECT private_key, public_key, enabled FROM wg_server WHERE id = 1') as ServerRow | undefined;
  if (row || !create) return row || null;
  const k = await genKeyPair();
  await dbRun('INSERT OR IGNORE INTO wg_server (id, private_key, public_key, enabled) VALUES (1, ?, ?, 0)', [k.priv, k.pub]);
  return (await dbGet('SELECT private_key, public_key, enabled FROM wg_server WHERE id = 1')) as ServerRow;
}

async function peerRows(): Promise<PeerRow[]> {
  await ensureTables();
  return (await dbAll('SELECT * FROM wg_server_peers ORDER BY id')) as PeerRow[];
}

// Ad yapılandırma dosyasına yorum olarak girer: harf, rakam, boşluk, . _ - (satır sonu giremez).
export function validatePeerName(raw: unknown): string | null {
  const n = String(raw ?? '').trim();
  return /^[\p{L}\p{N} ._-]{1,40}$/u.test(n) ? n : null;
}
export const validRole = (r: unknown): r is PeerRole => r === 'admin' || r === 'guest';

// Uç adres: paneldeki etkin DDNS adı (DuckDNS adı ".duckdns.org"suz kayıtlı olabilir), yoksa dış IP (10 dk önbellek).
let ipCache: { ip: string; at: number } | null = null;
export async function serverEndpoint(): Promise<{ host: string; source: 'ddns' | 'ip' | 'none' }> {
  try {
    const d = await dbGet("SELECT provider, hostname FROM ddns_configs WHERE enabled = 1 AND hostname != '' ORDER BY id LIMIT 1");
    if (d?.hostname) {
      let h = String(d.hostname).trim().toLowerCase();
      if (d.provider === 'duckdns' && !h.includes('.')) h += '.duckdns.org';
      if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) return { host: h, source: 'ddns' };
    }
  } catch { /* DDNS tablosu yok */ }
  if (!ipCache || Date.now() - ipCache.at > 600000) {
    const ip = (await getCurrentExternalIp().catch(() => ({ ip: '' }))).ip;
    if (ip) ipCache = { ip, at: Date.now() };
  }
  return ipCache?.ip ? { host: ipCache.ip, source: 'ip' } : { host: '', source: 'none' };
}

// İnternet kartı PPPoE ise tünel MTU'su PPPoE MTU'su − 80 (WireGuard başlığı): 1492'de 1412, RFC 4638 ile 1500'de 1420.
// wg-quick'in kendi hesabı açılışta PPPoE henüz bağlanmamışsa 1420 bulurdu. PPPoE değilse 0.
const DEFAULT_WG_MTU = 1420;
export function pppoeWgMtu(): number {
  const ns = readNetModeState();
  // Ana hat ya da yedek hat PPPoE ise küçüğü: yedek hatta geçildiğinde de tünel paketleri parçalanmasın.
  const mtus = [
    ...(wanActive(ns) && ns.wanType === 'pppoe' ? [(ns.wanMtu || 1492) - 80] : []),
    ...(ns?.bakStage === 'on' && ns.bakType === 'pppoe' ? [(ns.bakMtu || 1492) - 80] : []),
  ];
  return mtus.length ? Math.min(DEFAULT_WG_MTU, ...mtus) : 0;
}
// PPPoE değilken wg-quick'in açılışta bulacağı değer: varsayılan rotanın kartının MTU'su − 80 (en çok 1420). PPPoE'den
// çıkınca arayüz buna döner; okunamazsa 0 (dokunulmaz).
function routeWgMtu(): number {
  try {
    let best: { dev: string; metric: number } | null = null;
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
      const metric = Number(f[6]) || 0;
      if (!best || metric < best.metric) best = { dev: f[0], metric };
    }
    if (!best || !/^[A-Za-z0-9_.-]{1,15}$/.test(best.dev)) return 0;
    const dev = Number(fs.readFileSync(`/sys/class/net/${best.dev}/mtu`, 'utf8').trim()) || 0;
    return dev > 80 ? Math.min(DEFAULT_WG_MTU, dev - 80) : 0;
  } catch {
    return 0;
  }
}

export function renderServerConf(s: ServerRow, peers: PeerRow[], apps: AppPeer[] = []): string {
  return [
    "# Klyrix Gate paneli yönetir (VPS WireGuard → Ev VPN'i); elle düzenlemeyin.",
    '[Interface]',
    `Address = ${WG_SERVER_IP}/24`,
    `ListenPort = ${WG_PORT}`,
    ...(pppoeWgMtu() ? [`MTU = ${pppoeWgMtu()}`] : []),
    `PrivateKey = ${s.private_key}`,
    // Tünel yanıtları işaretsiz dönebilir: katı rp_filter düşürmesin (wg_vps tünelleriyle aynı). Kurallar arayüzle gelir.
    'PostUp = sysctl -q -w net.ipv4.conf.%i.rp_filter=2 || true',
    `PostUp = nft -f ${NFT_FILE} || true`,
    'PostDown = nft delete table inet pi5_wgsrv 2>/dev/null || true',
    'PostDown = nft delete table ip pi5_wgsrv_nat 2>/dev/null || true',
    ...peers.flatMap(p => [
      '', `# ${p.name} (${p.role === 'admin' ? 'yönetici' : 'misafir'})`, '[Peer]',
      `PublicKey = ${p.public_key}`, `AllowedIPs = ${p.ip}/32`,
    ]),
    // Uygulama eşinin adı yoruma girmez (kullanıcının yazdığı ad; satır sonu vb. taşıyabilir): kayıt numarası yeter
    ...apps.flatMap(a => ['', `# Klyrix/Gate uygulaması #${a.id}`, '[Peer]', `PublicKey = ${a.public_key}`, `AllowedIPs = ${a.ip}/32`]),
    '',
  ].join('\n');
}

export function renderNft(peers: PeerRow[], apps: AppPeer[] = []): string {
  const guests = peers.filter(p => p.role !== 'admin').map(p => p.ip);
  const appIps = apps.map(a => a.ip);
  return [
    "# Klyrix Gate — Ev VPN'i (wg_pi) kuralları; panel yazar, arayüzün PostUp'ı yükler.",
    'table inet pi5_wgsrv',
    'delete table inet pi5_wgsrv',
    'table inet pi5_wgsrv {',
    `  set guests { type ipv4_addr;${guests.length ? ` elements = { ${guests.join(', ')} }` : ''} }`,
    `  set apps { type ipv4_addr;${appIps.length ? ` elements = { ${appIps.join(', ')} }` : ''} }`,
    '  chain input {',
    '    type filter hook input priority filter - 1; policy accept;',
    `    iifname "${WG_IFACE}" ip saddr @guests ct state established,related accept`,
    `    iifname "${WG_IFACE}" ip saddr @guests meta l4proto { tcp, udp } th dport { ${GUEST_PI_PORTS} } accept`,
    `    iifname "${WG_IFACE}" ip saddr @guests icmp type echo-request accept`,
    `    iifname "${WG_IFACE}" ip saddr @guests drop`,
    // Uygulama eşi: Pi'de yalnız uygulama kapısı (+ ping); uygulama kapısına wg_pi dışından (ev ağı, loopback hariç) gelinmez
    `    iifname "${WG_IFACE}" ip saddr @apps ct state established,related accept`,
    `    iifname "${WG_IFACE}" ip saddr @apps tcp dport ${APP_PORT} accept`,
    `    iifname "${WG_IFACE}" ip saddr @apps icmp type echo-request accept`,
    `    iifname "${WG_IFACE}" ip saddr @apps drop`,
    `    iifname != { "${WG_IFACE}", "lo" } tcp dport ${APP_PORT} drop`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority filter - 1; policy accept;',
    `    iifname "${WG_IFACE}" ip saddr @guests ip daddr { ${PRIVATE_NETS} } drop`,
    // Uygulama eşi VPN değildir: hiçbir yere iletilmez (ev ağı da internet de kapalı)
    `    iifname "${WG_IFACE}" ip saddr @apps drop`,
    '  }',
    '}',
    'table ip pi5_wgsrv_nat',
    'delete table ip pi5_wgsrv_nat',
    'table ip pi5_wgsrv_nat {',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    ip saddr ${WG_NET} oifname != "${WG_IFACE}" masquerade`,
    '  }',
    '}',
    '',
  ].join('\n');
}

function writeFile(file: string, txt: string, mode: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, txt, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Politikası drop olan filtre tabloları: Debian'ın inet filter'ı ve panelin güvenlik duvarı (Firewall → kurulum,
// services.ts: inet pi5_filter — iletmede yalnız LAN ve wg_vps* açık). Giriş/iletme politikası drop ise kendi zincirlerimizle
// izin; değilse (ya da sunucu kapalıysa) zincirlerimizi kaldır. Tablo yoksa dokunulmaz. pi5_filter yeniden kurulunca
// zincirlerimiz silinir → index.ts güvenlik duvarı kurulumundan sonra reapplyWgServer çağırır.
const DROP_TABLES = ['filter', 'pi5_filter'];
async function syncDropPolicyTables(enable: boolean): Promise<void> {
  const specs: [string, string, string[]][] = [
    ['input', 'pi5_wgsrv_in', [`udp dport ${WG_PORT} accept`, `iifname "${WG_IFACE}" accept`]],
    ['forward', 'pi5_wgsrv_fwd', [`iifname "${WG_IFACE}" accept`, `oifname "${WG_IFACE}" ct state established,related accept`]],
  ];
  for (const table of DROP_TABLES) {
    for (const [chain, own, rules] of specs) {
      const listing = await execFileP('nft', ['-a', 'list', 'chain', 'inet', table, chain], { timeout: 5000 }).then(r => r.stdout, () => null);
      if (listing === null) continue;
      const policyDrop = /policy drop;/.test(listing);
      const jump = new RegExp(`jump ${own} # handle (\\d+)`).exec(listing);
      const ownExists = await execFileP('nft', ['list', 'chain', 'inet', table, own], { timeout: 5000 }).then(() => true, () => false);
      let script = '';
      if (enable && policyDrop) {
        script += `add chain inet ${table} ${own}\nflush chain inet ${table} ${own}\n`;
        for (const r of rules) script += `add rule inet ${table} ${own} ${r}\n`;
        if (!jump) script += `insert rule inet ${table} ${chain} jump ${own}\n`;
      } else {
        if (jump) script += `delete rule inet ${table} ${chain} handle ${jump[1]}\n`;
        if (ownExists) script += `delete chain inet ${table} ${own}\n`;
      }
      if (script) await runInput('nft', ['-f', '-'], script);
    }
  }
}

// Ev VPN'i kuralları yenilenince (istemci eklendi / silindi / rolü değişti, güvenlik duvarı yeniden kuruldu, açılış) başka
// modüllerin kendi izinlerini yenilemesi: ağ paylaşımı (share.ts) misafir listesini ve güvenlik duvarı zincirini eşitler.
// Beklenmez: kancanın gecikmesi (ör. depolama kilidi) Ev VPN'ini yavaşlatmaz.
const rulesHooks: (() => Promise<void>)[] = [];
export function onWgRulesChanged(cb: () => Promise<void>): void { rulesHooks.push(cb); }
function runRulesHooks(): void {
  for (const h of rulesHooks) h().catch(e => console.error('[ev-vpn] kanca:', e?.message || e));
}

let applying: Promise<WgApplyResult> | null = null;
export interface WgApplyResult { ok: boolean; running: boolean; error?: string }

// Durumu Pi'ye uygular (sıralı). Açıksa: dosyalar yazılır, arayüz ayaktaysa bağlantılar koparılmadan eşitlenir, değilse
// açılır (ve açılışta etkin); kapalıysa arayüz ve kurallar kaldırılır.
export function applyWgServer(): Promise<WgApplyResult> {
  if (applying) return applying.then(() => applyWgServer());
  applying = doApply().finally(() => { applying = null; runRulesHooks(); });
  return applying;
}

async function doApply(): Promise<WgApplyResult> {
  if (!isLinux) return { ok: false, running: false, error: "Ev VPN'i yalnız Pi üzerinde çalışır" };
  try {
    const s = await serverRow();
    const peers = await peerRows();
    const up = () => fs.existsSync(`/sys/class/net/${WG_IFACE}`);
    if (!s || !s.enabled) {
      const stopErr = await execFileP('systemctl', ['disable', '--now', UNIT], { timeout: 30000 })
        .then(() => '', (e: any) => String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'bilinmeyen hata');
      await runInput('nft', ['-f', '-'], 'table inet pi5_wgsrv\ndelete table inet pi5_wgsrv\ntable ip pi5_wgsrv_nat\ndelete table ip pi5_wgsrv_nat\n').catch(() => {});
      await syncDropPolicyTables(false).catch(() => {});
      // Arayüz hâlâ ayaktaysa kapatma başarısız: "kapatıldı" denmesin (UDP 51820 açık kalır). Birim hiç kurulmamışsa
      // systemctl hata verir ama arayüz yoktur — başarı.
      if (up()) return { ok: false, running: true, error: `Ev VPN'i durdurulamadı: ${stopErr.slice(0, 200) || 'arayüz hâlâ açık'}` };
      return { ok: true, running: false };
    }
    const apps = usableApps(s, peers, await appPeers());
    writeFile(NFT_FILE, renderNft(peers, apps), 0o644);
    writeFile(CONF, renderServerConf(s, peers, apps), 0o600);
    if (up()) {
      await execFileP('bash', ['-c', `wg syncconf ${WG_IFACE} <(wg-quick strip ${WG_IFACE})`], { timeout: 15000 });
      // MTU syncconf ile uygulanmaz (wg-quick yönergesi): internet kartı PPPoE'ye geçtiyse / çıktıysa arayüzde ayarlanır.
      const mtu = Number(fs.readFileSync(`/sys/class/net/${WG_IFACE}/mtu`, 'utf8').trim()) || 0;
      const want = pppoeWgMtu() || routeWgMtu() || mtu;
      if (want && want !== mtu) await execFileP('ip', ['link', 'set', 'dev', WG_IFACE, 'mtu', String(want)], { timeout: 5000 }).catch(() => {});
      await execFileP('nft', ['-f', NFT_FILE], { timeout: 10000 });
      await execFileP('systemctl', ['enable', UNIT], { timeout: 15000 }).catch(() => {});
    } else {
      const busy = await execFileP('ss', ['-Hlun', 'sport', '=', `:${WG_PORT}`], { timeout: 5000 }).then(r => r.stdout.trim(), () => '');
      if (busy) throw new Error(`UDP ${WG_PORT} başka bir program tarafından kullanılıyor`);
      await execFileP('systemctl', ['enable', '--now', UNIT], { timeout: 30000 }).catch(async () => {
        const j = await execFileP('journalctl', ['-u', UNIT, '-n', '6', '--no-pager', '-q'], { timeout: 5000 }).then(r => r.stdout.trim(), () => '');
        throw new Error(`WireGuard arayüzü açılamadı${j ? `: ${j.split('\n').slice(-3).join(' · ')}` : ''}`);
      });
    }
    await syncDropPolicyTables(true);
    return { ok: up(), running: up(), error: up() ? undefined : 'WireGuard arayüzü açılmadı' };
  } catch (e: any) {
    return { ok: false, running: fs.existsSync(`/sys/class/net/${WG_IFACE}`), error: String(e?.stderr || e?.message || e).trim().slice(0, 400) };
  }
}

// Açılışta / nftables yeniden başlatıldıktan sonra (flush ruleset kuralları siler): sunucu açıksa her şey yeniden uygulanır.
export async function reapplyWgServer(): Promise<void> {
  if (!isLinux) return;
  const s = await serverRow().catch(() => null);
  if (!s?.enabled) { runRulesHooks(); return; }
  const r = await applyWgServer();
  if (!r.ok) console.error("[ev-vpn] uygulanamadı:", r.error);
}

// Buluttan geri yükleme (vault.ts — satırlar orada sıkı doğrulanır): Ev VPN'i sunucu anahtarı ve istemcileri yedektekiyle
// DEĞİŞTİRİLİR (aynı anahtarlar → telefon / dizüstü profilleri geçerli kalır), sonra Pi'ye uygulanır. İki tablo tek işlemde.
export interface WgServerRestore { private_key: string; public_key: string; enabled: number; created_at?: string | null }
export interface WgPeerRestore {
  id: number; name: string; ip: string; public_key: string; private_key: string; role: PeerRole; created_at?: string | null;
}
export async function restoreWgServerRows(server: WgServerRestore, peers: WgPeerRestore[]): Promise<WgApplyResult> {
  await ensureTables();
  await dbRun('BEGIN');
  try {
    await dbRun('DELETE FROM wg_server');
    await dbRun('INSERT INTO wg_server (id, private_key, public_key, enabled, created_at) VALUES (1, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))',
      [server.private_key, server.public_key, server.enabled ? 1 : 0, server.created_at ?? null]);
    await dbRun('DELETE FROM wg_server_peers');
    for (const p of peers) {
      await dbRun(`INSERT INTO wg_server_peers (id, name, ip, public_key, private_key, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`, [p.id, p.name, p.ip, p.public_key, p.private_key, p.role, p.created_at ?? null]);
    }
    await dbRun('COMMIT');
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
  return applyWgServer();
}

export async function setServerEnabled(enabled: boolean): Promise<WgApplyResult> {
  await serverRow(true);
  await dbRun('UPDATE wg_server SET enabled = ? WHERE id = 1', [enabled ? 1 : 0]);
  return applyWgServer();
}

// Boş tünel adresi: Ev VPN istemcileri ve uygulama eşleri aynı ağı (10.77.77.2–254) paylaşır. İstemciler alttan, uygulama
// eşleri üstten (fromTop) alır: buluttan geri yüklenen istemci listesi sonradan eşleşmiş bir telefonun adresine denk gelmesin.
// Uygulama eşleri okunamazsa adres verilmez (çakışan adres vermektense hata).
export async function freePeerIp(fromTop = false): Promise<string> {
  const used = new Set([...(await peerRows()).map(p => p.ip), ...(await appPeersProvider()).map(a => a.ip)]);
  for (let k = 2; k <= 254; k++) {
    const i = fromTop ? 256 - k : k;
    if (!used.has(WG_PREFIX + i)) return WG_PREFIX + i;
  }
  throw new Error('İstemci adresi kalmadı (en çok 253 istemci)');
}
// Sunucunun genel anahtarı (yoksa üretilir) — uygulama eşleşmesi yanıtı için
export async function serverPublicKey(): Promise<string> {
  return (await serverRow(true))!.public_key;
}
export async function serverEnabled(): Promise<boolean> {
  return !!(await serverRow().catch(() => null))?.enabled;
}

export async function addPeer(name: string, role: PeerRole): Promise<{ id: number; ip: string; apply: WgApplyResult | null }> {
  await serverRow(true);
  const ip = await freePeerIp();
  const k = await genKeyPair();
  const id = await dbInsert('INSERT INTO wg_server_peers (name, ip, public_key, private_key, role) VALUES (?, ?, ?, ?, ?)',
    [name, ip, k.pub, k.priv, role]);
  const s = await serverRow();
  return { id, ip, apply: s?.enabled ? await applyWgServer() : null };
}

export async function updatePeerRole(id: number, role: PeerRole): Promise<{ name: string; apply: WgApplyResult | null } | null> {
  const p = await dbGet('SELECT name FROM wg_server_peers WHERE id = ?', [id]);
  if (!p) return null;
  await dbRun('UPDATE wg_server_peers SET role = ? WHERE id = ?', [role, id]);
  const s = await serverRow();
  return { name: p.name, apply: s?.enabled ? await applyWgServer() : null };
}

export async function deletePeer(id: number): Promise<{ name: string; apply: WgApplyResult | null } | null> {
  await ensureTables();
  const p = await dbGet('SELECT name FROM wg_server_peers WHERE id = ?', [id]);
  if (!p) return null;
  await dbRun('DELETE FROM wg_server_peers WHERE id = ?', [id]);
  const s = await serverRow();
  return { name: p.name, apply: s?.enabled ? await applyWgServer() : null };
}

// İstemci yapılandırması + QR (güncel uç adresiyle). IPv6 de tünele alınır (::/0): Pi'de IPv6 çıkışı yok, telefon IPv4'e
// düşer — mobil ağın IPv6'sından tünel dışına sızıntı olmaz.
export async function peerConfig(id: number): Promise<{ name: string; config: string; qr: string; endpoint: string } | null> {
  const s = await serverRow();
  const p = await dbGet('SELECT * FROM wg_server_peers WHERE id = ?', [id]) as PeerRow | undefined;
  if (!s || !p) return null;
  const ep = await serverEndpoint();
  if (!ep.host) throw new Error('Evin dış adresi bulunamadı: DDNS kaydı yok ve dış IP alınamadı');
  const config = [
    '[Interface]', `PrivateKey = ${p.private_key}`, `Address = ${p.ip}/32`, `DNS = ${WG_SERVER_IP}`, '',
    '[Peer]', `PublicKey = ${s.public_key}`, `Endpoint = ${ep.host}:${WG_PORT}`, 'AllowedIPs = 0.0.0.0/0, ::/0',
    'PersistentKeepalive = 25', '',
  ].join('\n');
  const png = await runInput('qrencode', ['-t', 'PNG', '-s', '6', '-m', '2', '-o', '-'], config);
  return { name: p.name, config, qr: `data:image/png;base64,${png.toString('base64')}`, endpoint: `${ep.host}:${WG_PORT}` };
}

// Durum: arayüz, uç adres, istemciler + canlı bilgi (son el sıkışma, alınan/gönderilen, istemcinin dış adresi). Gizli anahtar yok.
export async function wgServerStatus() {
  if (!isLinux) return { supported: false as const };
  const tools = await execFileP('wg', ['--version'], { timeout: 5000 }).then(() => true, () => false);
  const qr = await execFileP('qrencode', ['--version'], { timeout: 5000 }).then(() => true, () => false);
  const s = await serverRow();
  const peers = await peerRows();
  const running = fs.existsSync(`/sys/class/net/${WG_IFACE}`);
  const live = new Map<string, { handshake: number; rx: number; tx: number; endpoint: string }>();
  if (running) {
    const dump = await execFileP('wg', ['show', WG_IFACE, 'dump'], { timeout: 5000 }).then(r => r.stdout, () => '');
    for (const line of dump.trim().split('\n').slice(1)) {
      const f = line.split('\t');
      if (f.length >= 7) live.set(f[0], { endpoint: f[2] === '(none)' ? '' : f[2], handshake: Number(f[4]) || 0, rx: Number(f[5]) || 0, tx: Number(f[6]) || 0 });
    }
  }
  const legacyDrop = await execFileP('nft', ['list', 'chain', 'inet', 'filter', 'input'], { timeout: 5000 })
    .then(r => /policy drop;/.test(r.stdout), () => false);
  // VPN istemcilerinin DNS'i 10.77.77.1'dir: Pi-hole yalnız "yerel" (LOCAL — bağlı ağlar, wg_pi dahil) ya da "tüm arayüzler"
  // (ALL) kipinde yanıtlar; SINGLE / BIND yalnız ev ağı kartını dinler → istemciler bağlanır ama hiçbir ad çözülmez.
  const dnsListening = await execFileP('pihole-FTL', ['--config', 'dns.listeningMode'], { timeout: 5000 })
    .then(r => r.stdout.trim().toUpperCase(), () => '');
  return {
    supported: tools,
    qrencode: qr,
    enabled: !!s?.enabled,
    running,
    port: WG_PORT,
    network: WG_NET,
    serverIp: WG_SERVER_IP,
    publicKey: s?.public_key || '',
    endpoint: await serverEndpoint(),
    legacyInputDrop: legacyDrop,
    dnsListening,
    dnsOk: !dnsListening || dnsListening === 'LOCAL' || dnsListening === 'ALL',
    peers: peers.map(p => ({
      id: p.id, name: p.name, ip: p.ip, role: p.role, created_at: p.created_at,
      ...(live.get(p.public_key) || { handshake: 0, rx: 0, tx: 0, endpoint: '' }),
    })),
  };
}

// ─── Dışarıdan erişim testi ───
// Ev dışındaki bir cihazın Pi'ye ulaşıp ulaşamayacağını ölçer; arayüz sonuca göre doğru senaryoyu (tek modem, arka arkaya
// iki cihaz / çift NAT, operatörün paylaşımlı IP'si / CGNAT) adım adım gösterir.
//  1. Dış IP (Pi'nin WAN kartından, VPS yönlendirmesine takılmadan) ve DDNS adının bu adresi gösterip göstermediği.
//  2. Evden çıkış durakları: TTL'i 1..5 ping'lerin "Time to live exceeded" yanıtları. Baştan art arda gelen özel adresler
//     evdeki cihazlardır (ilk durak Pi'nin ağ geçidi); 100.64/10 operatörün CGNAT'ıdır.
//  3. Gerçek dış deneme: bağlı bir VPS tüneli varsa Pi, evin dış IP'sine UDP 51820'ye 5 deneme paketini TÜNELDEN yollar
//     (geçici `ip rule to <dış IP> iif lo` — yalnız Pi'nin kendi paketleri, ~3 sn). Paketler internete VPS'ten çıkıp
//     modem(ler)den geçerek geri gelirse geçici nft tablosundaki sayaç artar. Deneme paketinin boyu (UDP uzunluğu 45)
//     hiçbir WireGuard mesajıyla (148/92/64/32+16k) çakışmaz. Kaynak adrese bakılmaz: bazı modemler yönlendirdiği
//     trafiğin kaynağını kendi adresine çevirir; paketin tünelden çıktığı gönderimden önce `ip route get` ile doğrulanır
//     (modemin içeriden geri döndürmesi — hairpin — olamaz). Sayaç giriş kancasında güvenlik duvarından önce çalışır →
//     Ev VPN'i kapalıyken de yönlendirme sınanır.
export interface ReachHop { ttl: number; ip: string; kind: 'private' | 'cgnat' | 'public' | 'none' }
export interface ReachExternal { status: 'reachable' | 'unreachable' | 'untested'; via: string; reason: string; sent: number; received: number }
export interface ReachResult {
  at: string;
  running: boolean;
  port: number;
  piLanIp: string;
  gateway: string;
  publicIp: string;
  endpoint: { host: string; source: 'ddns' | 'ip' | 'none' };
  ddnsIps: string[];
  ddnsOk: boolean | null;
  hops: ReachHop[];
  routers: string[];
  cgnatHop: string;
  external: ReachExternal;
  // direct: Pi doğrudan internette (internet kartında açık IP, ör. PPPoE) — modem / NAT yok, yönlendirme gerekmez.
  scenario: 'reachable' | 'cgnat' | 'nat' | 'unknown' | 'direct';
  // Testin yapıldığı hat: backup = ana hat çalışmıyor, yedek hattan (4G / telefon çoğu zaman CGNAT) ölçüldü.
  uplink: 'main' | 'backup';
}

const HOP_TARGET = '9.9.9.9';
const PROBE_TABLE = '31820'; // geçici rota tablosu (panelin VPS tabloları 32768–65535, routeMarks.ts — çakışmaz)
const LEGACY_PROBE_TABLE = '51820'; // ≤ v2.24.54: artık kural yalnız deneme önceliğiyle silinir (VPS #2668 + DPI tablosuyla aynı sayı)
const PROBE_PREF = '50';
const PROBE_LEN = 37; // 'klyrix-reach-' + 24 onaltılık → UDP uzunluğu 45
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Sıfır olmayan çıkışta da çıktı gerekir (TTL aşımında ping 1 ile çıkar).
const execOut = (cmd: string, args: string[], timeout = 5000) =>
  execFileP(cmd, args, { timeout }).then(r => r.stdout, (e: any) => String(e?.stdout || ''));

export function ipKind(ip: string): ReachHop['kind'] {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return 'none';
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  return 'public';
}

// -I: yönlendirme kuralları (VPS işaretleri) ping'i tünele sokmasın, duraklar ev tarafından okunsun.
async function traceHops(iface: string): Promise<ReachHop[]> {
  const hops: ReachHop[] = [];
  for (let ttl = 1; ttl <= 5; ttl++) {
    const out = await execOut('ping', ['-n', '-c1', '-W2', '-t', String(ttl), ...(iface ? ['-I', iface] : []), HOP_TARGET], 4000);
    const from = /From (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1];
    const reached = /bytes from (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1];
    const ip = from || reached || '';
    const kind = ip ? ipKind(ip) : 'none';
    hops.push({ ttl, ip, kind });
    if (reached || kind === 'public') break;
  }
  return hops;
}

async function wanPublicIp(iface: string): Promise<string> {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me']) {
    const ip = (await execOut('curl', ['-s', '--max-time', '5', ...(iface ? ['--interface', iface] : []), url], 7000)).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return (await getCurrentExternalIp().catch(() => ({ ip: '' }))).ip;
}

// Sistem çözücüsü (telefonların gördüğü adres Pi-hole'dan gelir; /etc/hosts da okunur).
function resolveHost(host: string): Promise<string[]> {
  return Promise.race([
    dns.promises.lookup(host, { all: true, family: 4 }).then(a => [...new Set(a.map(x => x.address))], () => [] as string[]),
    new Promise<string[]>(r => setTimeout(() => r([]), 5000)),
  ]);
}

async function probeCleanup(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const removed = await execFileP('ip', ['rule', 'del', 'table', PROBE_TABLE], { timeout: 5000 }).then(() => true, () => false);
    if (!removed) break;
  }
  for (let i = 0; i < 5; i++) {
    const removed = await execFileP('ip', ['rule', 'del', 'pref', PROBE_PREF, 'table', LEGACY_PROBE_TABLE], { timeout: 5000 }).then(() => true, () => false);
    if (!removed) break;
  }
  await execFileP('ip', ['route', 'flush', 'table', PROBE_TABLE], { timeout: 5000 }).catch(() => {});
  await runInput('nft', ['-f', '-'], 'table inet pi5_wgprobe\ndelete table inet pi5_wgprobe\n').catch(() => {});
}

// Hazır yapılandırmayla kurulan tüneller (wgImport.ts): arayüz → internet trafiğini taşıyor mu.
async function importedScope(): Promise<Map<string, boolean>> {
  const rows = await dbAll(`SELECT id, wg_conf FROM vps_servers WHERE kind = 'import'`).catch(() => [] as any[]);
  return new Map(rows.map(r => [`wg_vps${Number(r.id)}`, !!importSummary(r.wg_conf)?.full_tunnel]));
}

async function externalProbe(publicIp: string): Promise<ReachExternal> {
  const untested = (reason: string, via = ''): ReachExternal => ({ status: 'untested', via, reason, sent: 0, received: 0 });
  if (!publicIp) return untested('Evin dış IP adresi alınamadı');
  // Son el sıkışması 3 dk içinde olan ilk VPS tüneli (deneme paketlerini internete o çıkarır). Panelin kendi VPS tünelleri
  // önce; hazır yapılandırmayla kurulanlardan yalnız internet trafiğini taşıyanlar (wgConf.ts orderProbeTunnels).
  const tunnels = orderProbeTunnels((await listWireguardTunnels().catch(() => [])).filter(t => t.up), await importedScope());
  let iface = '';
  for (const t of tunnels) {
    const hs = await execOut('wg', ['show', t.iface, 'latest-handshakes']);
    const last = Math.max(0, ...hs.trim().split('\n').map(l => Number(l.split('\t')[1]) || 0));
    if (last && Date.now() / 1000 - last < 180) { iface = t.iface; break; }
  }
  if (!iface) return untested(tunnels.length ? 'VPS tüneli şu an bağlı değil' : 'Bağlı bir VPS tüneli yok');
  const vps = await dbGet('SELECT ip, location FROM vps_servers WHERE id = ?', [Number(iface.replace('wg_vps', ''))]).catch(() => null);
  const via = vps ? `${vps.location ? `${vps.location} VPS` : 'VPS'} (${vps.ip})` : iface;
  await probeCleanup();
  try {
    await runInput('nft', ['-f', '-'], [
      'table inet pi5_wgprobe {',
      '  chain in {',
      // İnternet kartı güvenlik duvarından (inet pi5_wan, filter - 10) da önce: Ev VPN'i kapalıyken port orada düşer.
      '    type filter hook input priority filter - 20; policy accept;',
      `    iifname != "lo" udp dport ${WG_PORT} udp length ${PROBE_LEN + 8} counter`,
      '  }',
      '}',
      '',
    ].join('\n'));
    await execFileP('ip', ['route', 'replace', 'default', 'dev', iface, 'table', PROBE_TABLE], { timeout: 5000 });
    await execFileP('ip', ['rule', 'add', 'pref', PROBE_PREF, 'to', `${publicIp}/32`, 'iif', 'lo', 'lookup', PROBE_TABLE], { timeout: 5000 });
    if (!(await execOut('ip', ['route', 'get', publicIp])).includes(`dev ${iface}`)) return untested('Deneme paketi VPS tüneline yönlendirilemedi', via);
    const payload = Buffer.from(`klyrix-reach-${crypto.randomBytes(12).toString('hex')}`);
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => {});
    let sent = 0;
    try {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>(r => sock.send(payload, WG_PORT, publicIp, err => { if (!err) sent++; r(); }));
        await sleep(300);
      }
    } finally {
      sock.close();
    }
    if (!sent) return untested('Deneme paketleri gönderilemedi', via);
    await sleep(1500);
    const received = Number(/counter packets (\d+)/.exec(await execOut('nft', ['list', 'chain', 'inet', 'pi5_wgprobe', 'in']))?.[1] || 0);
    return { status: received > 0 ? 'reachable' : 'unreachable', via, reason: '', sent, received };
  } catch (e: any) {
    return untested(`Test kurulamadı: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`, via);
  } finally {
    await probeCleanup();
  }
}

let reachRun: Promise<ReachResult> | null = null;
export function reachabilityTest(): Promise<ReachResult> {
  reachRun ??= doReach().finally(() => { reachRun = null; });
  return reachRun;
}

async function doReach(): Promise<ReachResult> {
  if (!isLinux) throw new Error('Test yalnız Pi üzerinde çalışır');
  const id = await getLanIdentity().catch(() => null);
  // İnternet kartı modunda (R3) duraklar ve dış adres internet kartından okunur; gateway zaten onun ağ geçididir.
  // Yedek hatta geçilmişse test etkin hattan (yedek hat) yapılır.
  const up = await activeUplink().catch(() => null);
  const onBackup = up?.via === 'backup';
  const iface = (onBackup ? up?.dev : '') || id?.wan?.dev || id?.iface || '';
  const gateway = (onBackup ? up?.gateway : id?.gateway) || '';
  const endpoint = await serverEndpoint();
  const [publicIp, hops] = await Promise.all([wanPublicIp(iface), traceHops(iface)]);
  const ddnsIps = endpoint.source === 'ddns' ? await resolveHost(endpoint.host) : [];
  const ddnsOk = endpoint.source === 'ddns' ? !!publicIp && ddnsIps.includes(publicIp) : null;
  // Evdeki cihazlar: baştan art arda özel adresli duraklar. İlk durak ağ geçidi değilse (yanıt vermedi) yalnız o bilinir.
  let routers: string[] = [];
  for (const h of hops) {
    if (h.kind !== 'private') break;
    routers.push(h.ip);
  }
  if (routers[0] !== gateway) routers = ipKind(gateway) === 'private' ? [gateway] : [];
  const firstPublic = hops.findIndex(h => h.kind === 'public');
  const cgnatHop = hops.slice(0, firstPublic < 0 ? undefined : firstPublic).find(h => h.kind === 'cgnat')?.ip || '';
  // Açık IP Pi'nin kendi kartındaysa deneme paketi Pi'nin yerel adresine gider (yerel tablo, tünelden çıkmaz):
  // VPS'ten ölçülemez. Modem / NAT yoktur; port internet kartı güvenlik duvarında Ev VPN'i açıkken açıktır.
  const upPublic = onBackup ? !!up?.public : !!id?.wan?.public;
  const upIp = (onBackup ? up?.ip : id?.wan?.ip) || '';
  const direct = upPublic && !!upIp && (!publicIp || publicIp === upIp);
  const external = direct
    ? { status: 'untested' as const, via: '', reason: "Pi doğrudan internette (açık IP internet kartında) — modemde yönlendirme gerekmez", sent: 0, received: 0 }
    : await externalProbe(publicIp || ddnsIps[0] || '');
  const scenario: ReachResult['scenario'] = direct ? 'direct'
    : external.status === 'reachable' ? 'reachable' : cgnatHop ? 'cgnat' : routers.length ? 'nat' : 'unknown';
  return {
    at: new Date().toISOString(),
    running: fs.existsSync(`/sys/class/net/${WG_IFACE}`),
    port: WG_PORT,
    // Modemde yönlendirmenin hedefi: internet kartı modunda Pi'nin modeme bakan adresi internet kartınınkidir; yedek
    // hatta geçilmişse yedek hattın (4G modem / router) Pi'ye verdiği adres.
    piLanIp: (onBackup ? up?.ip : '') || id?.wan?.ip || id?.transit.ip || '',
    uplink: onBackup ? 'backup' : 'main',
    gateway,
    publicIp,
    endpoint,
    ddnsIps,
    ddnsOk,
    hops,
    routers,
    cgnatHop,
    external,
    scenario,
  };
}

// Pi üzerinde WireGuard sunucusu ("Ev VPN'i"): ev dışındaki cihazlar (telefon, dizüstü) QR ile Pi'ye bağlanır; trafikleri
// Pi'den çıkar ve paneldeki yönlendirme kurallarına tabi olur (PI5_ROUTING gelen arayüze bakmaz — system.ts PREROUTING kancası).
// VPS tünellerinden ayrıdır: onlar wg_vps<N> + 10.66.66.0/24 (Pi = .2, ssh.ts); bu sunucu wg_pi + 10.77.77.0/24 (Pi = .1),
// UDP 51820 (Pi'de başka dinleyen yok: tünellerin ListenPort'u yok).
//  - Anahtarlar Pi'de `wg genkey` ile üretilir; sunucu ve istemci anahtarları kendi tablolarında (wg_server,
//    wg_server_peers — yedeklere girmez) ve /etc/wireguard/wg_pi.conf'ta (0600) durur.
//  - İstemci yapılandırması her istendiğinde güncel uç adresiyle üretilir: paneldeki DDNS adı, yoksa dış IP. Ev IP'si
//    değişse de (DDNS geçmişinde 2-4 haftada bir) QR geçerli kalır.
//  - Roller: 'admin' ev ağına, panele ve SSH'a erişir; 'guest' yalnız internete çıkar ve Pi'nin DNS'ini kullanır.
//  - Güvenlik duvarı kendi tablolarında: inet pi5_wgsrv (misafir yalıtımı), ip pi5_wgsrv_nat (maskeleme). Kurallar
//    core/pi5-wgsrv.nft'e yazılır ve arayüzün PostUp'ı yükler → Pi açılışında arayüzle aynı anda gelir. Debian'ın
//    inet filter tablosunda giriş/iletme politikası drop ise oraya kendi zincirleriyle izin eklenir (başka tablodaki accept
//    drop'u geçemez; drop ise her tabloda kesindir — misafir yalıtımı bu yüzden kendi tablosunda yeterli).
//  - Ekleme/silme/rol değişikliği bağlı istemcileri koparmadan `wg syncconf` ile uygulanır.
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux, getCurrentExternalIp } from './system';

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
// Misafirin Pi üzerinde erişemeyeceği yönetim portları (SSH, panel, backend, Pi-hole arayüzü)
const ADMIN_PORTS = '22, 80, 443, 3001, 8080';
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export type PeerRole = 'admin' | 'guest';
interface ServerRow { private_key: string; public_key: string; enabled: number }
interface PeerRow { id: number; name: string; ip: string; public_key: string; private_key: string; role: PeerRole; created_at: string }

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

export function renderServerConf(s: ServerRow, peers: PeerRow[]): string {
  return [
    "# Klyrix Gate paneli yönetir (VPS WireGuard → Ev VPN'i); elle düzenlemeyin.",
    '[Interface]',
    `Address = ${WG_SERVER_IP}/24`,
    `ListenPort = ${WG_PORT}`,
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
    '',
  ].join('\n');
}

export function renderNft(peers: PeerRow[]): string {
  const guests = peers.filter(p => p.role !== 'admin').map(p => p.ip);
  return [
    "# Klyrix Gate — Ev VPN'i (wg_pi) kuralları; panel yazar, arayüzün PostUp'ı yükler.",
    'table inet pi5_wgsrv',
    'delete table inet pi5_wgsrv',
    'table inet pi5_wgsrv {',
    `  set guests { type ipv4_addr;${guests.length ? ` elements = { ${guests.join(', ')} }` : ''} }`,
    '  chain input {',
    '    type filter hook input priority filter - 1; policy accept;',
    `    iifname "${WG_IFACE}" ip saddr @guests tcp dport { ${ADMIN_PORTS} } drop`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority filter - 1; policy accept;',
    `    iifname "${WG_IFACE}" ip saddr @guests ip daddr { ${PRIVATE_NETS} } drop`,
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

let applying: Promise<WgApplyResult> | null = null;
export interface WgApplyResult { ok: boolean; running: boolean; error?: string }

// Durumu Pi'ye uygular (sıralı). Açıksa: dosyalar yazılır, arayüz ayaktaysa bağlantılar koparılmadan eşitlenir, değilse
// açılır (ve açılışta etkin); kapalıysa arayüz ve kurallar kaldırılır.
export function applyWgServer(): Promise<WgApplyResult> {
  if (applying) return applying.then(() => applyWgServer());
  applying = doApply().finally(() => { applying = null; });
  return applying;
}

async function doApply(): Promise<WgApplyResult> {
  if (!isLinux) return { ok: false, running: false, error: "Ev VPN'i yalnız Pi üzerinde çalışır" };
  try {
    const s = await serverRow();
    const peers = await peerRows();
    const up = () => fs.existsSync(`/sys/class/net/${WG_IFACE}`);
    if (!s || !s.enabled) {
      await execFileP('systemctl', ['disable', '--now', UNIT], { timeout: 30000 }).catch(() => {});
      await runInput('nft', ['-f', '-'], 'table inet pi5_wgsrv\ndelete table inet pi5_wgsrv\ntable ip pi5_wgsrv_nat\ndelete table ip pi5_wgsrv_nat\n').catch(() => {});
      await syncDropPolicyTables(false).catch(() => {});
      return { ok: true, running: up() };
    }
    writeFile(NFT_FILE, renderNft(peers), 0o644);
    writeFile(CONF, renderServerConf(s, peers), 0o600);
    if (up()) {
      await execFileP('bash', ['-c', `wg syncconf ${WG_IFACE} <(wg-quick strip ${WG_IFACE})`], { timeout: 15000 });
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
  if (!s?.enabled) return;
  const r = await applyWgServer();
  if (!r.ok) console.error("[ev-vpn] uygulanamadı:", r.error);
}

export async function setServerEnabled(enabled: boolean): Promise<WgApplyResult> {
  await serverRow(true);
  await dbRun('UPDATE wg_server SET enabled = ? WHERE id = 1', [enabled ? 1 : 0]);
  return applyWgServer();
}

export async function addPeer(name: string, role: PeerRole): Promise<{ id: number; ip: string; apply: WgApplyResult | null }> {
  await serverRow(true);
  const used = new Set((await peerRows()).map(p => p.ip));
  let ip = '';
  for (let i = 2; i <= 254 && !ip; i++) if (!used.has(WG_PREFIX + i)) ip = WG_PREFIX + i;
  if (!ip) throw new Error('İstemci adresi kalmadı (en çok 253 istemci)');
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
    peers: peers.map(p => ({
      id: p.id, name: p.name, ip: p.ip, role: p.role, created_at: p.created_at,
      ...(live.get(p.public_key) || { handshake: 0, rx: 0, tx: 0, endpoint: '' }),
    })),
  };
}

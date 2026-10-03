// Şubeler arası SD-WAN (site-to-site WireGuard, hub-and-spoke) — yaşam döngüsü, sağlık izleme ve /api/sdwan uçları. Saf
// kısım (metinler, doğrulama, yapılandırma / nft / rota planı) sdwanPlan.ts'te.
//
// Topoloji: bir merkez (hub) + şubeler. Merkez ya açık UDP alabilen bir Klyrix'tir (bu cihaz UDP 51821'i dinler) ya da
// kullanıcının VPS'idir (bu panel SSH ile VPS'te wg0'dan ayrı 'wg_s2s' arayüzü kurar ve yönetir; bu cihaz VPS'in şubesi
// olur). CGNAT arkasındaki şubeler yalnız şube olabilir: dinleme portu açmazlar, merkezden gelen yanıtlar established sayılır.
// Bulut röle yok: veri trafiği yalnız merkezden geçer.
//
// Denetim düzlemi (sunucusuz, iki kopyala-yapıştır):
//  1. Merkez "Şube daveti oluştur": tek kullanımlık, 24 saatlik davet (merkezin açık anahtarı, uç, overlay adresi, üye ağları).
//  2. Şube daveti yapıştırır: kendi anahtarını üretir (özel anahtar cihazdan hiç çıkmaz), tüneli kurar, "kabul yanıtı" verir.
//  3. Kabul yanıtı merkeze yapıştırılır: merkez eşi ekler. Diğer şubeler yeni alt ağı "güncelleme metniyle" alır.
//
// Varsayılan kapalı: yapılandırma yokken arayüz, dosya, nft tablosu, rota, ip rule, birim ve veritabanı tablosu yoktur
// (sdwan_sites tembel oluşturulur, yedeğe girmez); izleyici hiçbir komut çalıştırmaz. Ayarlar /etc/pi5-gateway/sdwan/
// (0700): node.json (gizli değer yok), private.key (0600), trial (KEY=VALUE deneme durumu). Özel anahtar app_settings'e,
// yedeğe, argv'ye ve günlüklere girmez; wg pubkey'e stdin'le verilir.
//
// Kaçış koruması: uzak ağlara wg_s2s* dışından giden trafik pi5_sdwan'da reddedilir (sdwanPlan.ts renderSdwanNft). Açılışta
// ağdan önce pi5-sdwan-guard birimi yükler (SD-WAN açıkken yazılır, kaldırılınca silinir): tünel ve kurallar gelmeden de
// trafik operatöre çıkmaz. Kurulumdan sonra bu cihazda bir uzak ağla çakışan yerel ağ belirirse o uzak ağın yolu kurulmaz
// (her uygulamada ve izleyicinin her turunda denetlenir, olay bir kez yazılır; çakışma kalkınca yol kendiliğinden döner).
//
// Erişim modeli: uzak şubeden gelen YENİ bağlantılar varsayılan düşer (inet pi5_sdwan, öncelik -7; drop her tabloda
// kesindir). Bu şubeye erişim yalnız izin listesiyle (alt ağ / port); Pi hizmetleri (panel, DNS, ağ paylaşımı) de kapalıdır,
// izin listesinde 'bu cihaz' hedefiyle açılır. Ev VPN'i istemcileri ve VPS tünelleri uzak şubelere ulaşamaz.
//
// Deneme: rotalar bu cihaza İLK kez eklenirken 5 dk'lık deneme başlar — geri alma zamanlayıcısı (systemd-run →
// scripts/sdwan.sh rollback) değişiklikten ÖNCE kurulur; "Kalıcı yap" gelmezse SD-WAN kendiliğinden kaldırılır (panel
// erişimi kesilmiş olsa da). Deneme sürerken birim açılışta etkin değildir; Pi deneme sırasında yeniden başlarsa açılışta
// geri alınır. Sonraki şube eklemeleri deneme istemez (çakışan alt ağ zaten reddedilir).
//
// HA (G4.3): yalnız MASTER'da çalışır, ortak anahtarla; uç adres transit VIP'idir. Tek kapı: sdwanNodeActive().
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type express from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux, readNetModeState, uplinkIfaces, getLanIdentity } from './system';
import { isSatellite } from './role';
import { recordEvent, recordEventOnce } from './events';
import { classifyTunnel, type TunnelState } from './vpsTunnel';
import { pppoeWgMtu, serverEndpoint } from './wgServer';
import { listForwards } from './wan';
import { parseKv } from './update';
import { probeS2sHub, syncS2sHub, removeS2sHub } from './ssh';
import {
  S2S_IFACE, S2S_PORT, S2S_TABLE, S2S_PREF, S2S_PROTO, S2S_UNREACH_METRIC, DEFAULT_OVERLAY, SDWAN_NFT_TABLE, SDWAN_NFT_FILE,
  SDWAN_SCRIPT, S2S_DEFAULT_MTU, INVITE_TTL_S, MAX_SITES, MAX_TEXT, RESERVED_NETS, type NamedNet, type NodeConfig, type SiteRow,
  type HubKind, type SiteInfo, type BlockedRoute, validName, validateNets, validateOverlay, overlayHost, findConflict, parseEndpoint,
  parseNet, netsOverlap, netWithin, ipInNet, isIpv4, encodeText, parseInvite, parseAccept, parseUpdate, normalizeNode, remoteRoutes,
  splitRoutes, nodePeers, renderS2sConf, renderVpsPeers, renderSdwanNft, dropTableRules, validateAllow, parseTableRoutes, parseRules,
} from './sdwanPlan';

const execFileP = promisify(execFile);
const DIR = '/etc/pi5-gateway/sdwan';
const NODE_FILE = `${DIR}/node.json`;
const KEY_FILE = `${DIR}/private.key`;
const TRIAL_FILE = `${DIR}/trial`;
const CONF = `/etc/wireguard/${S2S_IFACE}.conf`;
const UNIT = `wg-quick@${S2S_IFACE}`;
const SCRIPT = SDWAN_SCRIPT;
const CORE_DIR = '/opt/pi5-gateway/core';
const ROLLBACK_UNIT = 'pi5-sdwan-rollback';
// Açılış kaçış koruması: pi5_sdwan'ı ağdan (network-pre) önce, nftables.service'in 'flush ruleset'inden sonra yükler.
// Debian'ın varsayılan nftables.conf'u /etc/nftables.d'yi içermez; pi5-gw-restore ise network-online'dan sonra gelir.
const GUARD_UNIT = 'pi5-sdwan-guard.service';
const GUARD_FILE = `/etc/systemd/system/${GUARD_UNIT}`;
const GUARD_TEXT = `[Unit]
Description=Klyrix Gate - SD-WAN kacis korumasi: uzak sube aglarina giden trafik tunel disindan cikmaz (backend/src/sdwan.ts yazar)
DefaultDependencies=no
Wants=network-pre.target
After=local-fs.target nftables.service
Before=network-pre.target shutdown.target
Conflicts=shutdown.target
ConditionPathExists=${SDWAN_NFT_FILE}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f ${SDWAN_NFT_FILE}

[Install]
WantedBy=sysinit.target
`;
export const SDWAN_TRIAL_S = 300;
// Politikası drop olabilen filtre tabloları: Debian'ın inet filter'ı ve panelin inet pi5_filter'ı (wgServer.ts ile aynı).
const DROP_TABLES = ['filter', 'pi5_filter'];
const WATCH_MS = 30000;
const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

// HA kapısı (G4.3 haPassive): SD-WAN yalnız ana cihazda (ve HA'da yalnız MASTER'da) çalışır. Uydu kapısı bugün tek koşul.
export const sdwanNodeActive = (): boolean => isLinux && !isSatellite();
export const sdwanConfigured = (): boolean => isLinux && fs.existsSync(NODE_FILE);

// ─── Küçük yardımcılar ───
const errText = (e: any) => String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).pop()?.slice(0, 300) || 'bilinmeyen hata';
const nowS = () => Math.floor(Date.now() / 1000);
const out = (cmd: string, args: string[], timeout = 5000) => execFileP(cmd, args, { timeout }).then(r => r.stdout, () => '');
const ifaceUp = () => fs.existsSync(`/sys/class/net/${S2S_IFACE}`);

// Standart girdiye veri verip komutu çalıştırır (wg pubkey, nft -f -). EPIPE dinlenir (backend-epipe-crash).
function runInput(cmd: string, args: string[], input: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cmd}: zaman aşımı`)); }, timeout);
    p.stdout.on('data', (d: Buffer) => { so += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { se += d.toString(); });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(so);
      else reject(new Error(`${cmd} (${code}): ${se.trim()}`));
    });
    p.stdin.on('error', () => { /* komut stdin'i okumadan çıktı (EPIPE): sonuç 'close' ile */ });
    p.stdin.end(input);
  });
}

function writeSecure(file: string, text: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Yaşam döngüsü işleri sırayla (wgImport.ts deseni): iki istek ya da istek + izleyici aynı dosyayı / arayüzü birbirinin
// ortasında değiştirmesin.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

// ─── Durum dosyaları ───
function readNode(): NodeConfig | null {
  try { return normalizeNode(JSON.parse(fs.readFileSync(NODE_FILE, 'utf8'))); } catch { return null; }
}
function writeNode(n: NodeConfig): void {
  writeSecure(NODE_FILE, `${JSON.stringify(n, null, 1)}\n`, 0o600);
}
function readKey(): string {
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return KEY.test(k) ? k : '';
  } catch { return ''; }
}
let pubCache: { priv: string; pub: string } | null = null;
async function ownPub(): Promise<string> {
  const priv = readKey();
  if (!priv) return '';
  if (pubCache?.priv === priv) return pubCache.pub;
  const pub = (await runInput('wg', ['pubkey'], `${priv}\n`)).trim();
  if (!KEY.test(pub)) throw new Error('WireGuard açık anahtarı hesaplanamadı');
  pubCache = { priv, pub };
  return pub;
}
async function genKey(): Promise<string> {
  const priv = (await execFileP('wg', ['genkey'], { timeout: 5000 })).stdout.trim();
  if (!KEY.test(priv)) throw new Error('WireGuard anahtarı üretilemedi');
  return priv;
}
type TrialStage = 'none' | 'trial' | 'on' | 'rolledback';
// notice=timer: deneme süresi dolunca zamanlayıcı geri aldı (sdwan.sh rollback timer) — izleyici olayı bir kez yazar.
function readTrial(): { stage: TrialStage; until: number; at: number; notice: string } {
  try {
    const kv = parseKv(fs.readFileSync(TRIAL_FILE, 'utf8'));
    const stage = (['trial', 'on', 'rolledback'] as const).find(s => s === kv.stage) || 'none';
    return { stage, until: Number(kv.until) || 0, at: Number(kv.at) || 0, notice: kv.notice === 'timer' ? 'timer' : '' };
  } catch { return { stage: 'none', until: 0, at: 0, notice: '' }; }
}
function writeTrial(stage: TrialStage, until = 0, at = nowS()): void {
  writeSecure(TRIAL_FILE, `stage=${stage}\nuntil=${until}\nat=${at}\n`, 0o600);
}

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= dbRun(`CREATE TABLE IF NOT EXISTS sdwan_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL DEFAULT '',
      nets TEXT NOT NULL DEFAULT '[]', endpoint TEXT NOT NULL DEFAULT '', peer INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    .catch(e => { tableReady = null; throw e; });
  return tableReady;
}
async function siteRows(): Promise<SiteRow[]> {
  await ensureTable();
  const rows = await dbAll('SELECT id, name, ip, public_key, nets, endpoint, peer FROM sdwan_sites ORDER BY id') as any[];
  return rows.map(r => {
    let nets: string[] = [];
    try { const v = validateNets(JSON.parse(String(r.nets || '[]')), 0); if (v.ok) nets = v.nets; } catch { /* bozuk kayıt: ağsız */ }
    return { id: Number(r.id), name: String(r.name), ip: String(r.ip), pub: String(r.public_key || ''), nets, endpoint: String(r.endpoint || ''), peer: Number(r.peer) === 1 };
  });
}
const isKlyrixHub = (n: NodeConfig) => n.role === 'hub' && n.hubKind === 'klyrix';

// ─── Ağlar ve çakışma ───
interface IfNet { ifname: string; cidr: string; ip: string }
// Bu cihazın kart adresleri ve ağları (lo ve wg_s2s* hariç). Okunamazsa fırlatır.
async function ifaceNets(): Promise<IfNet[]> {
  const { stdout } = await execFileP('ip', ['-j', '-4', 'addr', 'show'], { timeout: 5000 });
  const res: IfNet[] = [];
  for (const a of JSON.parse(stdout || '[]') as { ifname?: string; addr_info?: { local?: string; prefixlen?: number }[] }[]) {
    const ifname = String(a.ifname || '');
    if (ifname === 'lo' || ifname.startsWith('wg_s2s')) continue;
    for (const x of a.addr_info || []) {
      const n = x.local && typeof x.prefixlen === 'number' ? parseNet(`${x.local}/${x.prefixlen}`) : null;
      if (n && x.local) res.push({ ifname, cidr: n.net, ip: x.local });
    }
  }
  return res;
}
// Kurulacak uzak ağlar: bu cihazın bir kart ağıyla o an çakışanlar çıkarılır (sdwanPlan.ts splitRoutes).
async function routePlan(node: NodeConfig, sites: SiteRow[]): Promise<{ routes: string[]; blocked: BlockedRoute[] }> {
  const local = (await ifaceNets()).map(n => ({ cidr: n.cidr, label: n.ifname }));
  return splitRoutes(remoteRoutes(node, sites), local);
}
// Çakışma yüzünden durdurulan yollar: olay kaydına uzak ağ başına bir kez (çakıştığı ağ değişince yeniden); kalkınca bilgi.
const blockedNow = new Map<string, BlockedRoute>();
async function noteBlocked(list: BlockedRoute[]): Promise<void> {
  const next = new Map(list.map(b => [b.net, b] as const));
  for (const b of list) {
    if (blockedNow.get(b.net)?.local === b.local) continue;
    const msg = `Uzak ağ ${b.net}, bu cihazın ${b.label} ağıyla (${b.local}) çakışıyor — o ağa giden SD-WAN yolu durduruldu; çakışma kalkınca kendiliğinden döner`;
    console.error('[sdwan]', msg);
    await recordEventOnce('sdwan', msg, 'warning', 60);
  }
  for (const net of blockedNow.keys()) {
    if (!next.has(net)) await recordEvent('sdwan', `Uzak ağ ${net} için SD-WAN yolu yeniden açıldı (yerel ağ çakışması kalktı)`);
  }
  blockedNow.clear();
  for (const [k, v] of next) blockedNow.set(k, v);
}
// Son uygulanan uzak ağ listesi (yapılandırma ve nft bununla yazıldı); izleyici değişince yeniden uygular.
let appliedRoutes: string | null = null;
// Bu şubenin duyurabileceği ağlar: ev ağı tarafındaki kartların ağları (tünel, internet kartı / yedek hat ve kurulum Wi-Fi'ı
// değil). Duyurulan alt ağ bunlardan birinin içinde olmalı: yoksa uzaktan gelen trafik ana tablodan operatöre çıkardı.
async function lanCandidates(): Promise<string[]> {
  const up = new Set(uplinkIfaces(readNetModeState()));
  return [...new Set((await ifaceNets()).filter(n => !n.ifname.startsWith('wg') && !up.has(n.ifname)
    && !RESERVED_NETS.some(r => netsOverlap(r.cidr, n.cidr))).map(n => n.cidr))];
}
// Uzak ağların çakışamayacağı ağlar: bu cihazın tüm ağları (internet kartı ve modem tarafı dahil — çakışan uzak ağ
// rotası Pi'nin kendi bağlantısını tünele çekerdi), sabit ayrılmış ağlar.
async function localConflictNets(): Promise<NamedNet[]> {
  return [
    ...(await ifaceNets()).map(n => ({ cidr: n.cidr, label: `bu cihazın ağı (${n.ifname})` })),
    ...RESERVED_NETS,
  ];
}
const clientIp = (req: express.Request) => String(req.ip || '').replace(/^::ffff:/, '');
// İsteği yapan cihaz yeni uzak ağlardan birindeyse (ör. çakışma denetiminden kaçmış bir yol) panel erişimi kesilirdi.
function requesterInside(req: express.Request, nets: string[]): string | null {
  const ip = clientIp(req);
  if (!isIpv4(ip)) return null;
  return nets.find(n => ipInNet(ip, n)) || null;
}

// ─── Sistem durumu: nft, zincirler, rotalar ───
async function writeNftChecked(text: string): Promise<void> {
  fs.mkdirSync(path.dirname(SDWAN_NFT_FILE), { recursive: true });
  const tmp = `${SDWAN_NFT_FILE}.new.${process.pid}`; // *.conf değil: eşzamanlı include'a girmesin
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  try {
    await execFileP('nft', ['-c', '-f', tmp], { timeout: 10000 }).catch(e => { throw new Error(`SD-WAN güvenlik duvarı sınamadan geçmedi: ${errText(e)}`); });
    fs.renameSync(tmp, SDWAN_NFT_FILE);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* taşındı */ }
  }
}
const nftTableExists = () => execFileP('nft', ['list', 'table', 'inet', SDWAN_NFT_TABLE], { timeout: 5000 }).then(() => true, () => false);

// Politikası drop tablolarda izin zincirleri (wgServer.ts syncDropPolicyTables deseni). Kurulan zincirler ayrıca
// /opt/pi5-gateway/core/pi5-sdwan-<tablo>.nft'e yazılır: nftables yeniden başlatılınca (gece apt) pi5-gw-restore geri yükler.
async function syncChainsNow(enable: boolean, listen: boolean): Promise<void> {
  const specs = dropTableRules(listen);
  for (const table of DROP_TABLES) {
    const file = `${CORE_DIR}/pi5-sdwan-${table}.nft`;
    const persist: string[] = [];
    let seen = false;
    for (const [chain, own, rules] of [['input', 'pi5_sdwan_in', specs.input], ['forward', 'pi5_sdwan_fwd', specs.forward]] as [string, string, string[]][]) {
      const listing = await execFileP('nft', ['-a', 'list', 'chain', 'inet', table, chain], { timeout: 5000 }).then(r => r.stdout, () => null);
      if (listing === null) continue;
      seen = true;
      const policyDrop = /policy drop;/.test(listing);
      const jumps = [...listing.matchAll(new RegExp(`jump ${own} # handle (\\d+)`, 'g'))].map(m => m[1]);
      const ownExists = await execFileP('nft', ['list', 'chain', 'inet', table, own], { timeout: 5000 }).then(() => true, () => false);
      let script = '';
      if (enable && policyDrop) {
        const body = [`add chain inet ${table} ${own}`, `flush chain inet ${table} ${own}`, ...rules.map(r => `add rule inet ${table} ${own} ${r}`)];
        persist.push(...body);
        script += `${body.join('\n')}\n`;
        if (!jumps.length) script += `insert rule inet ${table} ${chain} jump ${own}\n`;
        for (const h of jumps.slice(1)) script += `delete rule inet ${table} ${chain} handle ${h}\n`;
      } else {
        for (const h of jumps) script += `delete rule inet ${table} ${chain} handle ${h}\n`;
        if (ownExists) script += `delete chain inet ${table} ${own}\n`;
      }
      if (script) await runInput('nft', ['-f', '-'], script);
    }
    if (persist.length && seen) {
      writeSecure(file, `${persist.join('\n')}\n`, 0o644);
    } else {
      try { fs.unlinkSync(file); } catch { /* yok */ }
    }
  }
}

// Tablo 30001 ve ip rule 1050'yi istenen ağlara eşitler. Eklerken önce 'unreachable' (kaçış yolu kapanır), sonra arayüz
// rotası, sonra kural; kaldırırken önce kural, sonra rotalar.
async function syncRoutes(want: string[], up: boolean): Promise<void> {
  const T = String(S2S_TABLE), P = String(S2S_PREF), M = String(S2S_UNREACH_METRIC);
  const ip = (args: string[]) => execFileP('ip', ['-4', ...args], { timeout: 5000 });
  const cur = parseTableRoutes(await out('ip', ['-4', 'route', 'show', 'table', T]));
  const rules = parseRules(await out('ip', ['-4', 'rule', 'show', 'pref', P]));
  const W = new Set(want);
  for (const r of want) {
    if (!cur.unreach.includes(r)) {
      await ip(['route', 'replace', 'unreachable', r, 'metric', M, 'table', T]).catch(e => { throw new Error(`${r} için kaçış koruması (unreachable) kurulamadı: ${errText(e)}`); });
    }
  }
  if (up) {
    for (const r of want) {
      if (!cur.dev.some(d => d.net === r && d.dev === S2S_IFACE)) {
        await ip(['route', 'replace', r, 'dev', S2S_IFACE, 'table', T, 'proto', String(S2S_PROTO)]).catch(e => { throw new Error(`${r} rotası eklenemedi: ${errText(e)}`); });
      }
    }
  }
  const kept = new Set<string>();
  for (const r of rules) {
    if (!W.has(r) || kept.has(r)) await ip(['rule', 'del', 'pref', P, 'to', r, 'lookup', T]).catch(() => {});
    else kept.add(r);
  }
  for (const r of want) {
    if (!kept.has(r)) await ip(['rule', 'add', 'pref', P, 'to', r, 'lookup', T]).catch(e => { throw new Error(`${r} kuralı eklenemedi: ${errText(e)}`); });
  }
  for (const d of cur.dev) if (!W.has(d.net) || d.dev !== S2S_IFACE) await ip(['route', 'del', d.net, 'dev', d.dev, 'table', T]).catch(() => {});
  for (const u of cur.unreach) if (!W.has(u)) await ip(['route', 'del', 'unreachable', u, 'metric', M, 'table', T]).catch(() => {});
}

const unitEnabled = () => execFileP('systemctl', ['is-enabled', UNIT], { timeout: 5000 }).then(r => r.stdout.trim() === 'enabled', () => false);
// net-mode.sh wg_listen_port ile aynı ölçüt: arayüz ayakta ya da birim etkin ve yapılandırmada ListenPort var.
async function listenState(): Promise<boolean> {
  let conf = '';
  try { conf = fs.readFileSync(CONF, 'utf8'); } catch { return false; }
  if (!/^\s*ListenPort\s*=\s*\d+/m.test(conf)) return false;
  return ifaceUp() || await unitEnabled();
}

// Index.ts'ten: internet kartı / yedek hat güvenlik duvarının yeniden yüklenmesi (UDP 51821 izni wg_listen_port'tan).
let wanReload: () => Promise<void> = async () => {};

async function runScript(cmd: 'down' | 'rollback'): Promise<Record<string, string>> {
  const r = await execFileP('bash', [SCRIPT, cmd], { timeout: 120000 }).then(x => x.stdout, (e: any) => String(e?.stdout || '') || `error=${errText(e)}`);
  const kv = parseKv(r);
  if (kv.error) throw new Error(kv.error);
  return kv;
}

// Sistemdeki SD-WAN durumunu kaldırır (ayarlar kalır). Port izni değiştiyse internet kartı güvenlik duvarı yeniden yüklenir.
async function downNow(): Promise<void> {
  const before = await listenState();
  await runScript('down');
  health.clear();
  blockedNow.clear();
  appliedRoutes = null;
  if (before) await wanReload().catch(e => console.error('[sdwan] internet kartı güvenlik duvarı yeniden yüklenemedi:', errText(e)));
}
// Deneme zamanlayıcısının geri alması panelin bir işiyle (uygulama, izleyici turu) aynı anda çalıştıysa: betik durumu
// önce 'rolledback' yazar; panel işinin sonunda bunu görürse az önce eklediğini de kaldırır (betik kilidini bekler, down
// idempotent). Geri alınmışsa true.
async function settleRollback(): Promise<boolean> {
  if (readTrial().stage !== 'rolledback') return false;
  await downNow().catch(e => console.error('[sdwan] geri alma sonrası kaldırılamadı:', errText(e)));
  return true;
}

// Açılış kaçış korumasının birimi (GUARD_TEXT): SD-WAN uygulanınca yazılır ve etkinleştirilir; sdwan.sh down siler.
async function ensureGuardUnit(): Promise<void> {
  try {
    let cur = '';
    try { cur = fs.readFileSync(GUARD_FILE, 'utf8'); } catch { /* yok */ }
    if (cur !== GUARD_TEXT) {
      writeSecure(GUARD_FILE, GUARD_TEXT, 0o644);
      await execFileP('systemctl', ['daemon-reload'], { timeout: 30000 });
    }
    const on = await execFileP('systemctl', ['is-enabled', GUARD_UNIT], { timeout: 5000 }).then(r => r.stdout.trim() === 'enabled', () => false);
    if (!on) await execFileP('systemctl', ['enable', GUARD_UNIT], { timeout: 15000 });
  } catch (e) {
    // Koruma pi5-gw-restore ve arayüzün PreUp'ıyla da yüklenir: birim kurulamazsa SD-WAN durdurulmaz, günlüğe yazılır.
    console.error('[sdwan] açılış koruması birimi kurulamadı:', errText(e));
  }
}

async function timerActive(): Promise<boolean> {
  return execFileP('systemctl', ['is-active', `${ROLLBACK_UNIT}.timer`], { timeout: 5000 }).then(r => r.stdout.trim() === 'active', () => false);
}
async function armTrial(): Promise<void> {
  await execFileP('systemctl', ['stop', `${ROLLBACK_UNIT}.timer`], { timeout: 10000 }).catch(() => {});
  writeTrial('trial', nowS() + SDWAN_TRIAL_S);
  try {
    await execFileP('systemd-run', ['--quiet', '--collect', `--unit=${ROLLBACK_UNIT}`, `--on-active=${SDWAN_TRIAL_S}`,
      '--timer-property=AccuracySec=1s', '/bin/bash', SCRIPT, 'rollback', 'timer'], { timeout: 15000 });
  } catch (e) {
    writeTrial('none');
    throw new Error(`Geri alma zamanlayıcısı kurulamadı — SD-WAN açılmadı: ${errText(e)}`);
  }
}

export interface SdwanApply { ok: boolean; running: boolean; trial: boolean; error?: string }
// Durumu sisteme uygular (sıralı kuyruktan çağrılır). Eş yoksa (merkezde henüz şube yok) sistem durumu kaldırılır.
async function applyNow(): Promise<SdwanApply> {
  const node = readNode();
  if (!node) { await downNow(); return { ok: true, running: false, trial: false }; }
  let trial = readTrial();
  if (trial.stage === 'rolledback') return { ok: true, running: false, trial: false };
  const sites = await siteRows();
  if (!nodePeers(node, sites).length) {
    await downNow();
    if (trial.stage === 'trial') { await execFileP('systemctl', ['stop', `${ROLLBACK_UNIT}.timer`], { timeout: 10000 }).catch(() => {}); writeTrial('none'); }
    return { ok: true, running: false, trial: false };
  }
  const key = readKey();
  if (!key) throw new Error('SD-WAN özel anahtarı okunamadı — SD-WAN\'ı kaldırıp yeniden kurun');
  const listenBefore = await listenState();
  // Rotalar bu cihaza ilk kez ekleniyor: 5 dk'lık deneme, geri alma zamanlayıcısı değişiklikten önce
  if (trial.stage === 'none') { await armTrial(); trial = readTrial(); }
  const inTrial = trial.stage === 'trial';
  const listen = isKlyrixHub(node);
  const want = pppoeWgMtu() || S2S_DEFAULT_MTU;
  // Uzak ağlardan bu cihazın bir kart ağıyla çakışanlar kurulmaz (yol, kaçış koruması, PreUp)
  const plan = await routePlan(node, sites);
  await noteBlocked(plan.blocked);
  await writeNftChecked(renderSdwanNft({ ownNets: node.nets, transit: listen, allow: node.allow, remote: plan.routes, mtu: want }));
  await ensureGuardUnit();
  writeSecure(CONF, renderS2sConf({ privateKey: key, node, sites, mtu: want, routes: plan.routes }), 0o600);
  if (ifaceUp()) {
    await execFileP('nft', ['-f', SDWAN_NFT_FILE], { timeout: 10000 });
    await execFileP('bash', ['-c', `wg syncconf ${S2S_IFACE} <(wg-quick strip ${S2S_IFACE})`], { timeout: 15000 });
    // MTU syncconf ile uygulanmaz (PPPoE'ye geçiş / çıkış): arayüzde ayarlanır.
    const mtu = Number(fs.readFileSync(`/sys/class/net/${S2S_IFACE}/mtu`, 'utf8').trim()) || 0;
    if (mtu && want !== mtu) await execFileP('ip', ['link', 'set', 'dev', S2S_IFACE, 'mtu', String(want)], { timeout: 5000 }).catch(() => {});
    if (!inTrial) await execFileP('systemctl', ['enable', UNIT], { timeout: 15000 }).catch(() => {});
  } else {
    if (listen) {
      const busy = await out('ss', ['-Hlun', 'sport', '=', `:${S2S_PORT}`]);
      if (busy.trim()) throw new Error(`UDP ${S2S_PORT} başka bir program tarafından kullanılıyor`);
    }
    // Arayüz dışarıdan silindiyse birim "active (exited)" kalır ve start / enable --now hiçbir şey yapmaz: önce durdurulur
    // (wg-quick down arayüz yokken hata verir, birim 'failed' olur — reset-failed temizler).
    await execFileP('systemctl', ['stop', UNIT], { timeout: 30000 }).catch(() => {});
    await execFileP('systemctl', ['reset-failed', UNIT], { timeout: 10000 }).catch(() => {});
    await execFileP('systemctl', inTrial ? ['start', UNIT] : ['enable', '--now', UNIT], { timeout: 30000 }).catch(async () => {
      const j = await out('journalctl', ['-u', UNIT, '-n', '6', '--no-pager', '-q']);
      throw new Error(`SD-WAN arayüzü (${S2S_IFACE}) açılamadı${j.trim() ? `: ${j.trim().split('\n').slice(-3).join(' · ').slice(0, 300)}` : ''}`);
    });
  }
  const up = ifaceUp();
  await syncRoutes(plan.routes, up);
  appliedRoutes = plan.routes.join(' ');
  await syncChainsNow(true, listen);
  if (listenBefore !== await listenState()) await wanReload().catch(e => console.error('[sdwan] internet kartı güvenlik duvarı yeniden yüklenemedi:', errText(e)));
  if (inTrial && await settleRollback()) return { ok: true, running: false, trial: false };
  return { ok: up, running: up, trial: inTrial, error: up ? undefined : `${S2S_IFACE} açılmadı` };
}
export const applySdwan = (): Promise<SdwanApply> => serial(applyNow);

// Yapılandırmanın tamamını kaldırır: sistem durumu, ayar klasörü ve veritabanı tablosu (bugünkü durumun aynısı).
async function resetNow(): Promise<void> {
  await execFileP('systemctl', ['stop', `${ROLLBACK_UNIT}.timer`], { timeout: 10000 }).catch(() => {});
  await downNow();
  fs.rmSync(DIR, { recursive: true, force: true });
  pubCache = null;
  await dbRun('DROP TABLE IF EXISTS sdwan_sites');
  tableReady = null;
  health.clear();
  siteState.clear();
}

// ─── Güvenlik duvarı kancaları (index.ts) ───
// Panelin güvenlik duvarı (pi5_filter) yeniden kurulunca izin zincirleri silinir: yeniden eklenir. Yapılandırma yoksa
// hiçbir komut çalışmaz.
export function syncSdwanChains(): Promise<void> {
  if (!sdwanConfigured() || !sdwanNodeActive()) return Promise.resolve();
  return serial(async () => {
    const node = readNode();
    const stage = readTrial().stage;
    const on = !!node && stage !== 'rolledback' && (ifaceUp() || await unitEnabled());
    await syncChainsNow(on, on && !!node && isKlyrixHub(node));
    if (on && stage === 'trial') await settleRollback();
  });
}
// "nftables yeniden uygula": tablo, zincirler ve rotalar yeniden yüklenir.
export function reapplySdwan(): Promise<void> {
  if (!sdwanConfigured() || !sdwanNodeActive()) return Promise.resolve();
  return serial(async () => {
    if (readTrial().stage === 'rolledback') return;
    const r = await applyNow();
    if (!r.ok && r.error) console.error('[sdwan] yeniden uygulanamadı:', r.error);
  });
}
// G2.4 (Geo-IP) için: hub portu ve WireGuard eşlerinin uç adresleri (allow4 kümesine ve 51821 muafiyetine). Kapalıyken boş.
export async function sdwanPeerEndpoints(): Promise<{ port: number | null; endpoints: string[] }> {
  if (!sdwanConfigured() || !ifaceUp()) return { port: null, endpoints: [] };
  const node = readNode();
  const txt = await out('wg', ['show', S2S_IFACE, 'endpoints']);
  const endpoints = [...new Set(txt.split('\n').map(l => /\t(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(l.trim())?.[1] || '').filter(Boolean))];
  return { port: node && isKlyrixHub(node) ? S2S_PORT : null, endpoints };
}
// Uydu rolüne geçiş: SD-WAN ana cihazdadır (uç 409); yapılandırma kalmasın.
export function sdwanBlocksSatellite(): string {
  return sdwanConfigured() ? "Önce SD-WAN'ı kaldırın (Altyapı → SD-WAN)" : '';
}

// ─── Sağlık: el sıkışma yaşı + overlay ping; 'sdwan' olayları ───
export interface SiteHealth { state: TunnelState | 'unknown'; handshakeAge: number | null; endpoint: string; rx: number; tx: number; rttMs: number | null; checkedAt: number }
const health = new Map<string, SiteHealth>(); // overlay ip → sağlık
const siteState = new Map<string, { up: boolean; downRounds: number; reported: 'up' | 'down' | '' }>();
let ifSeen: { ifindex: string; since: number } | null = null;
const resolvedAt = new Map<string, number>();

async function pingMs(ip: string): Promise<number | null> {
  const o = await execFileP('ping', ['-n', '-c1', '-W2', ip], { timeout: 4000 }).then(r => r.stdout, () => '');
  const m = /time[=<]([\d.]+)\s*ms/.exec(o);
  return m ? Math.round(Number(m[1]) * 10) / 10 : null;
}

async function healthRound(sites: SiteRow[]): Promise<void> {
  const now = nowS();
  let ifindex = '';
  try { ifindex = fs.readFileSync(`/sys/class/net/${S2S_IFACE}/ifindex`, 'utf8').trim(); } catch { ifSeen = null; }
  if (ifindex && ifSeen?.ifindex !== ifindex) ifSeen = { ifindex, since: now };
  const present = !!ifindex;
  const dump = present ? await out('wg', ['show', S2S_IFACE, 'dump']) : '';
  const live = new Map<string, { hs: number; endpoint: string; rx: number; tx: number }>();
  for (const line of dump.trim().split('\n').slice(1)) {
    const f = line.split('\t');
    if (f.length >= 7) live.set(f[0], { endpoint: f[2] === '(none)' ? '' : f[2], hs: Number(f[4]) || 0, rx: Number(f[5]) || 0, tx: Number(f[6]) || 0 });
  }
  const upFor = ifSeen ? now - ifSeen.since : 0;
  const rtts = await Promise.all(sites.map(s => (present ? pingMs(s.ip) : Promise.resolve(null))));
  for (const [i, s] of sites.entries()) {
    const l = s.peer ? live.get(s.pub) : undefined;
    const c = s.peer ? classifyTunnel(present, l?.hs || 0, upFor, now) : { state: 'unknown' as const, handshakeAge: null };
    const rttMs = rtts[i];
    const state: SiteHealth['state'] = s.peer ? c.state : (!present ? 'down' : rttMs !== null ? 'up' : 'stale');
    health.set(s.ip, { state, handshakeAge: c.handshakeAge, endpoint: l?.endpoint || '', rx: l?.rx || 0, tx: l?.tx || 0, rttMs, checkedAt: now });
    // Olay: 'up' ↔ değil, iki ardışık turla onaylı kopuş (tek ölçümlük sapma yazılmaz)
    const st = siteState.get(s.ip) || { up: false, downRounds: 0, reported: '' as const };
    const isUp = state === 'up';
    if (isUp) {
      st.downRounds = 0;
      if (st.reported !== 'up') {
        void recordEvent('sdwan', st.reported === 'down' ? `Şube bağlantısı geri geldi: ${s.name} (${s.ip})` : `Şube bağlandı: ${s.name} (${s.ip})`);
        st.reported = 'up';
      }
    } else if (state !== 'connecting') {
      st.downRounds++;
      if (st.reported === 'up' && st.downRounds >= 2) {
        const why = s.peer ? (c.handshakeAge !== null ? `son el sıkışma ${c.handshakeAge} sn önce` : 'el sıkışma yok') : 'merkez üzerinden yanıt yok';
        void recordEvent('sdwan', `Şube bağlantısı koptu: ${s.name} (${s.ip}) — ${why}`, 'warning');
        st.reported = 'down';
      }
    }
    st.up = isUp;
    siteState.set(s.ip, st);
    // Merkezin adı DNS ile çözülür (DDNS): yanıt vermiyorsa adres değişmiş olabilir — en çok 2 dk'da bir yeniden çözülür.
    if (s.peer && s.endpoint && present && (state === 'stale' || (state === 'connecting' && upFor > 60))) {
      const ep = parseEndpoint(s.endpoint);
      if (ep && !isIpv4(ep.host) && now - (resolvedAt.get(s.pub) || 0) >= 120) {
        resolvedAt.set(s.pub, now);
        await execFileP('wg', ['set', S2S_IFACE, 'peer', s.pub, 'endpoint', `${ep.host}:${ep.port}`], { timeout: 15000 }).catch(() => {});
      }
    }
  }
  for (const ip of [...health.keys()]) if (!sites.some(s => s.ip === ip)) { health.delete(ip); siteState.delete(ip); }
}

let watchTimer: ReturnType<typeof setInterval> | null = null;
let healRounds = 0;
let lastWatchError = '';
async function watchTick(): Promise<void> {
  const node = readNode();
  if (!node) return;
  const trial = readTrial();
  // Güvenlik ağı: deneme süresi geçti ama zamanlayıcı yok (ör. systemd yeniden yüklendi) → geri al
  if (trial.stage === 'trial' && trial.until && nowS() > trial.until + 90 && !(await timerActive())) {
    await runScript('rollback').catch(e => console.error('[sdwan] geri alınamadı:', errText(e)));
    await recordEvent('sdwan', 'SD-WAN denemesi "Kalıcı yap"sız bitti — geri alındı', 'warning');
    return;
  }
  if (trial.stage === 'rolledback') {
    health.clear();
    // Zamanlayıcı denemeyi geri aldı (betik yalnız syslog'a yazar): Bildirimler'e bir kez
    if (trial.notice === 'timer') {
      writeTrial('rolledback', 0, trial.at);
      await recordEvent('sdwan', 'SD-WAN denemesi "Kalıcı yap"sız bitti — geri alındı; SD-WAN sayfasından yeniden deneyin', 'warning');
    }
    // Geri alma panelin bir işiyle yarıştıysa kalıntı (arayüz, kural, nft tablosu) kalmasın: görülürse kaldırılır
    if (ifaceUp() || (await out('ip', ['-4', 'rule', 'show', 'pref', String(S2S_PREF)])).trim() || await nftTableExists()) {
      console.error('[sdwan] geri alınmış SD-WAN\'dan kalıntı bulundu — kaldırılıyor');
      await downNow();
    }
    return;
  }
  const sites = await siteRows();
  if (!nodePeers(node, sites).length) return;
  // Bu cihazda bir uzak ağla çakışan yerel ağ belirdi / kalktı: o ağın yolu kaldırılır / geri eklenir
  const plan = await routePlan(node, sites);
  const changed = plan.routes.join(' ') !== appliedRoutes;
  // Kendini onarma: arayüz kayboldu (ör. elle durduruldu) → ikinci turda yeniden uygulanır (en çok 5 dk'da bir)
  if (!ifaceUp()) {
    healRounds++;
    if (changed) {
      // Arayüz yokken de kural / unreachable çakışan ağı keserdi: hemen kaldırılır (yapılandırma uygulamada yazılır)
      await noteBlocked(plan.blocked);
      await syncRoutes(plan.routes, false);
    }
    if (healRounds === 2 || healRounds % 10 === 0) {
      const r = await applyNow().catch((e: any) => ({ ok: false, error: errText(e) } as SdwanApply));
      if (!r.ok) await recordEventOnce('sdwan', `SD-WAN arayüzü açılamadı: ${r.error || 'bilinmeyen hata'}`, 'warning', 60);
    }
  } else if (changed) {
    healRounds = 0;
    const r = await applyNow();
    if (!r.ok && r.error) throw new Error(r.error);
  } else {
    healRounds = 0;
    if (!(await nftTableExists()) && fs.existsSync(SDWAN_NFT_FILE)) await execFileP('nft', ['-f', SDWAN_NFT_FILE], { timeout: 10000 });
    await syncRoutes(plan.routes, true);
    await syncChainsNow(true, isKlyrixHub(node));
    if (trial.stage === 'trial' && await settleRollback()) return;
  }
  await healthRound(sites);
}
let tickPending = false;
export function startSdwanWatch(): void {
  if (!isLinux || watchTimer) return;
  watchTimer = setInterval(() => {
    if (!sdwanConfigured() || !sdwanNodeActive()) return;
    // Kuyruk uzun bir işle (VPS SSH) doluyken turlar birikmesin: bekleyen tur varken yenisi eklenmez
    if (tickPending) return;
    tickPending = true;
    void serial(watchTick).then(() => { lastWatchError = ''; }, (e: any) => {
      const msg = errText(e);
      if (msg !== lastWatchError) console.error('[sdwan] izleyici:', msg);
      lastWatchError = msg;
    }).finally(() => { tickPending = false; });
  }, WATCH_MS);
}

// Açılış: yapılandırma yoksa hemen döner. Deneme sürerken Pi yeniden başladıysa (zamanlayıcı kalıcı değil) geri alınır;
// yalnız panel yeniden başladıysa (güncelleme) zamanlayıcı hâlâ kuruludur — deneme sürer.
export async function restoreSdwan(): Promise<void> {
  if (!sdwanConfigured() || !sdwanNodeActive()) return;
  await serial(async () => {
    const trial = readTrial();
    if (trial.stage === 'trial' && await timerActive()) return;
    if (trial.stage === 'trial') {
      await runScript('rollback').catch(e => console.error('[sdwan] açılışta geri alınamadı:', errText(e)));
      await recordEvent('sdwan', 'SD-WAN denemesi sürerken Pi yeniden başladı — geri alındı; SD-WAN sayfasından yeniden deneyin', 'warning');
      return;
    }
    if (trial.stage === 'rolledback') return;
    const r = await applyNow().catch((e: any) => ({ ok: false, running: false, trial: false, error: errText(e) } as SdwanApply));
    if (!r.ok && r.error) console.error('[sdwan] açılışta uygulanamadı:', r.error);
  });
}

// ─── Metinler ───
async function vpsRow(id: number | null): Promise<{ ip: string; username: string; password: string; location: string } | null> {
  if (!id) return null;
  const r = await dbGet(`SELECT ip, username, password, location FROM vps_servers WHERE id = ? AND COALESCE(kind, '') != 'import'`, [id]).catch(() => null);
  return r && r.ip && r.username ? { ip: String(r.ip), username: String(r.username), password: String(r.password || ''), location: String(r.location || '') } : null;
}
const vpsOpts = (v: { ip: string; username: string; password: string }) => ({ ip: v.ip, username: v.username, password: v.password || undefined });

// Merkezin bilgisi (davet ve güncelleme metninde): Klyrix merkezde bu cihaz, VPS merkezinde VPS.
async function hubInfo(node: NodeConfig, sites: SiteRow[]): Promise<{ name: string; pub: string; endpoint: string; ip: string }> {
  if (isKlyrixHub(node)) return { name: node.name, pub: await ownPub(), endpoint: node.endpoint, ip: node.ip };
  const v = sites.find(s => s.peer);
  if (!v?.pub) throw new Error("VPS merkezinin anahtarı yok — SD-WAN'ı kaldırıp yeniden kurun");
  return { name: v.name, pub: v.pub, endpoint: v.endpoint, ip: node.hubIp };
}
// Üyeler (merkez dahil, VPS hariç): ad, overlay adresi, alt ağlar.
function members(node: NodeConfig, sites: SiteRow[]): SiteInfo[] {
  const others = isKlyrixHub(node) ? sites : sites.filter(s => !s.peer);
  return [{ name: node.name, ip: node.ip, nets: node.nets }, ...others.map(s => ({ name: s.name, ip: s.ip, nets: s.nets }))];
}
// Davet / güncelleme metni sınırı (sdwanPlan MAX_TEXT): şube kendi merkezinin metnini "çok uzun" diye reddetmesin.
function checkedText(text: string): string {
  if (text.length > MAX_TEXT) throw Object.assign(new Error('Şube / alt ağ sayısı metin sınırını aşıyor — şube adlarını kısaltın ya da alt ağ sayısını azaltın'), { status: 409 });
  return text;
}
async function updateText(node: NodeConfig, sites: SiteRow[]): Promise<string> {
  return checkedText(encodeText('guncelleme', { v: 1, at: Date.now(), overlay: node.overlay, hub: await hubInfo(node, sites), sites: members(node, sites) }));
}
// VPS merkezini yöneten Pi'nin kimliği (VPS'teki wg_s2s.conf'a '# klyrix-owner=' olarak yazılır): makine kimliğinin özeti —
// gizli değer değil, yalnız aynı VPS'i iki Klyrix'in yönetmesini önler.
function ownerId(): string {
  let id = '';
  try { id = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* yok */ }
  return crypto.createHash('sha256').update(`klyrix-sdwan:${id || os.hostname()}`).digest('hex').slice(0, 16);
}
// VPS merkezinde üye listesi değişince VPS'in wg_s2s eşleri eşitlenir; wg0 önce / sonra aynı olmalı. VPS'in anahtarı
// kurulumdakinden farklıysa (VPS yeniden kurulmuş / wg_s2s.conf silinmiş: betik yeni anahtar üretti) şubeler eski anahtarla
// kalır ve tünel sessizce kopardı — hata döner.
async function pushVps(node: NodeConfig, sites: SiteRow[]): Promise<{ pub: string; warning: string }> {
  const v = await vpsRow(node.vpsId);
  if (!v) throw Object.assign(new Error("VPS kaydı bulunamadı (WireGuard sayfasından silinmiş olabilir)"), { status: 409 });
  const r = await syncS2sHub(vpsOpts(v), `${node.hubIp}/24`, renderVpsPeers(node, await ownPub(), sites), ownerId()).catch((e: any) => ({ result: 'failed' as const, detail: errText(e), kv: {} as Record<string, string> }));
  // unreachable: betik hiç yanıt vermedi (bağlantı / zaman aşımı) — VPS'te değişiklik olmadı sayılır
  if (r.result !== 'ok' || !KEY.test(r.kv.pub || '')) throw Object.assign(new Error(`VPS'te SD-WAN merkezi güncellenemedi: ${r.detail || 'anahtar okunamadı'}`), { status: 502, unreachable: !r.kv.result });
  const known = sites.find(s => s.peer)?.pub || '';
  if (known && known !== r.kv.pub) {
    const msg = "VPS'teki SD-WAN anahtarı değişmiş (VPS yeniden kurulmuş ya da wg_s2s.conf silinmiş olabilir) — şubeler bağlanamaz; SD-WAN'ı kaldırıp yeniden kurun";
    await recordEvent('sdwan', msg, 'warning');
    throw Object.assign(new Error(msg), { status: 409 });
  }
  let warning = '';
  if (r.kv.wg0_before !== r.kv.wg0_after) {
    warning = "VPS'teki wg0 yapılandırması bu işlem sırasında değişti (başka bir oturum eş eklemiş / kaldırmış olabilir) — VPS tünellerini denetleyin";
    await recordEvent('sdwan', warning, 'warning');
  }
  return { pub: r.kv.pub, warning };
}

// ─── API ───
type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;
type Invite = Extract<ReturnType<typeof parseInvite>, { ok: true }>['inv'];
const fail = (res: express.Response, status: number, error: string) => res.status(status).json({ error });
const failE = (res: express.Response, e: any) => res.status(Number(e?.status) || 500).json({ error: String(e?.message || e).slice(0, 500) });

async function statusView() {
  const node = readNode();
  const present = sdwanConfigured();
  if (!present) return { supported: isLinux, configured: false };
  if (!node) return { supported: true, configured: true, corrupt: true };
  const sites = await siteRows();
  const trial = readTrial();
  const fwd = (() => { try { return fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim() === '1'; } catch { return null; } })();
  const vps = node.hubKind === 'vps' ? await vpsRow(node.vpsId) : null;
  // Bu cihazın bir kart ağıyla çakıştığı için yolu kurulmayan uzak ağlar (anlık)
  const blocked = nodePeers(node, sites).length && trial.stage !== 'rolledback'
    ? (await routePlan(node, sites).catch(() => ({ blocked: [] as BlockedRoute[] }))).blocked : [];
  return {
    supported: true, configured: true, role: node.role, hubKind: node.hubKind, name: node.name, overlay: node.overlay, ip: node.ip,
    hubIp: node.hubIp, nets: node.nets, endpoint: node.endpoint, port: isKlyrixHub(node) ? S2S_PORT : null,
    vps: vps ? { id: node.vpsId, label: `${vps.location || 'VPS'} (${vps.ip})` } : null,
    publicKey: await ownPub().catch(() => ''), running: ifaceUp(), unitEnabled: await unitEnabled(), ipForward: fwd,
    trial: { stage: trial.stage, until: trial.until, at: trial.at }, now: nowS(), blocked,
    sites: sites.map(s => ({ id: s.id, name: s.name, ip: s.ip, nets: s.nets, peer: s.peer, endpoint: s.endpoint, hub: s.ip === node.hubIp, health: health.get(s.ip) || null })),
    pending: node.pending.filter(p => p.exp > nowS()), allow: node.allow, reply: node.role === 'spoke' ? node.reply : '',
  };
}

export function registerSdwanRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw; wanFirewallReload: () => Promise<void> }): void {
  wanReload = deps.wanFirewallReload;
  app.use('/api/sdwan', (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — SD-WAN ana cihazdadır' });
    deps.guard(req, res, next);
  });

  app.get('/api/sdwan', async (_req, res) => {
    try { res.json(await statusView()); } catch (e: any) { failE(res, e); }
  });

  // Kurulum sihirbazının önerileri (yalnız sihirbaz açılınca): bu şubenin ağları, merkezin dış adresi, VPS listesi.
  app.get('/api/sdwan/suggest', async (_req, res) => {
    if (!isLinux) return res.json({ nets: [], endpoint: '', vps: [] });
    try {
      const id = await getLanIdentity().catch(() => null);
      const cands = await lanCandidates().catch(() => [] as string[]);
      const nets = [...new Set([id?.client?.network, ...cands].filter((n): n is string => !!n && cands.includes(n)))];
      const ep = await serverEndpoint().catch(() => ({ host: '', source: 'none' as const }));
      const vps = await dbAll(`SELECT id, ip, location FROM vps_servers WHERE COALESCE(kind, '') != 'import' AND username != '' ORDER BY id`).catch(() => [] as any[]);
      res.json({
        nets, candidates: cands, endpoint: ep.host ? `${ep.host}:${S2S_PORT}` : '', endpointSource: ep.source, overlay: DEFAULT_OVERLAY,
        vps: vps.map(v => ({ id: Number(v.id), location: String(v.location || ''), ip: String(v.ip || '') })),
      });
    } catch (e: any) { failE(res, e); }
  });

  // Bu şubenin alt ağları: ev ağı kartlarının içinde, ayrılmış / overlay ağlarıyla çakışmayan.
  async function ownNetsCheck(raw: unknown, overlay: string): Promise<{ nets: string[] } | { error: string }> {
    const v = validateNets(raw, 1);
    if (!v.ok) return { error: v.error };
    const cands = await lanCandidates();
    const outside = v.nets.find(n => !cands.some(c => netWithin(n, c)));
    if (outside) return { error: `Alt ağ ${outside} bu cihazın ev ağı kartlarında değil (${cands.join(', ') || 'ev ağı bulunamadı'}) — yalnız bu şubenin kendi ağı duyurulabilir` };
    const clash = findConflict(v.nets, [...RESERVED_NETS, { cidr: overlay, label: 'SD-WAN overlay ağı' }]);
    if (clash) return { error: clash };
    return { nets: v.nets };
  }

  // Merkezin dış adresi (Klyrix merkez): DDNS adı ya da IP, port yoksa 51821 eklenir; port 51821 olmalı, şube ağlarında
  // olamaz, UDP 51821 bir port yönlendirmesinde kullanılamaz.
  async function hubEndpointCheck(raw: unknown, overlay: string, ownNets: string[]): Promise<string> {
    const ep = parseEndpoint(typeof raw === 'string' && !raw.includes(':') ? `${raw}:${S2S_PORT}` : raw);
    if (!ep) throw Object.assign(new Error('Merkezin dış adresi geçersiz (DDNS adı ya da IP, isteğe bağlı :port)'), { status: 400 });
    if (ep.port !== S2S_PORT) throw Object.assign(new Error(`Merkez portu ${S2S_PORT} olmalı (modemde bu portu Pi'ye yönlendirin)`), { status: 400 });
    if (isIpv4(ep.host) && (ipInNet(ep.host, overlay) || ownNets.some(n => ipInNet(ep.host, n)))) throw Object.assign(new Error('Merkezin dış adresi şube ağlarının içinde olamaz'), { status: 400 });
    const fwds = await listForwards().catch(() => []);
    const f = fwds.find(x => x.proto !== 'tcp' && x.ext_from <= S2S_PORT && S2S_PORT <= x.ext_to);
    if (f) throw Object.assign(new Error(`UDP ${S2S_PORT} bir port yönlendirmesinde kullanılıyor${f.name ? ` (${f.name})` : ''} — önce onu silin`), { status: 409 });
    return `${ep.host}:${ep.port}`;
  }
  // Merkez sihirbazının denetimleri — kurulum (POST /hub) ve adım adım kuru doğrulama (POST /hub/check) aynısını çalıştırır.
  // Adım 1–2: tür, ad, overlay, bu şubenin alt ağları; adım 3: merkezin dış adresi ya da VPS (SSH ile yoklanır).
  function hubBasics(b: any): { kind: HubKind; name: string; overlay: string } {
    const kind: HubKind | null = b.kind === 'klyrix' || b.kind === 'vps' ? b.kind : null;
    if (!kind) throw Object.assign(new Error("Merkez türü 'klyrix' ya da 'vps' olmalı"), { status: 400 });
    const name = validName(b.name);
    if (!name) throw Object.assign(new Error('Şube adı 1-40 karakter: harf, rakam, boşluk, . _ -'), { status: 400 });
    const overlay = b.overlay === undefined || b.overlay === '' ? DEFAULT_OVERLAY : validateOverlay(b.overlay);
    if (!overlay) throw Object.assign(new Error('Overlay ağı özel bir /24 olmalı (ör. 10.88.0.0/24)'), { status: 400 });
    return { kind, name, overlay };
  }
  async function hubChecks(b: any, h: { kind: HubKind; overlay: string }, step: 2 | 3) {
    const own = await ownNetsCheck(b.nets, h.overlay);
    if ('error' in own) throw Object.assign(new Error(own.error), { status: 400 });
    const localClash = findConflict([h.overlay], await localConflictNets());
    if (localClash) throw Object.assign(new Error(`Overlay: ${localClash}`), { status: 409 });
    let endpoint = '';
    let vps: Awaited<ReturnType<typeof vpsRow>> = null;
    let vpsNets: string[] = [];
    if (step === 3 && h.kind === 'klyrix') {
      endpoint = await hubEndpointCheck(b.endpoint, h.overlay, own.nets);
    } else if (step === 3) {
      vps = await vpsRow(Number(b.vpsId) || null);
      if (!vps) throw Object.assign(new Error('VPS seçin (WireGuard sayfasında SSH ile kurulmuş bir VPS)'), { status: 400 });
      const p = await probeS2sHub(vpsOpts(vps)).catch((e: any) => ({ result: 'failed' as const, detail: errText(e), kv: {} as Record<string, string> }));
      if (p.result !== 'ok') throw Object.assign(new Error(`VPS'e bağlanılamadı: ${p.detail}`), { status: 502 });
      if (p.kv.busy === '1') throw Object.assign(new Error(`VPS'te UDP ${S2S_PORT} başka bir programda`), { status: 409 });
      if (p.kv.exists === '1' && p.kv.owner !== ownerId()) {
        throw Object.assign(new Error(`VPS'te başka bir SD-WAN merkezi (wg_s2s) var${p.kv.owner ? ' — başka bir Klyrix yönetiyor' : ''}. Bir VPS'i yalnız bir Klyrix yönetebilir; eskisi sizinse VPS'te: systemctl disable --now wg-quick@wg_s2s && rm /etc/wireguard/wg_s2s.conf`), { status: 409 });
      }
      vpsNets = [...new Set((p.kv.nets || '').split(/\s+/).map(x => parseNet(x)?.net || '').filter(Boolean))];
      const vc = findConflict([h.overlay, ...own.nets], vpsNets.map(n => ({ cidr: n, label: "VPS'in ağı" })));
      if (vc) throw Object.assign(new Error(vc), { status: 409 });
      endpoint = `${vps.ip}:${S2S_PORT}`;
      if (!parseEndpoint(endpoint)) throw Object.assign(new Error('VPS adresi geçersiz'), { status: 400 });
    }
    return { nets: own.nets, endpoint, vps, vpsNets };
  }

  // Sihirbazın "İleri"si: adımı sistemi değiştirmeden doğrular (kurulumla aynı denetimler); hata adımda gösterilir.
  app.post('/api/sdwan/hub/check', async (req, res) => {
    if (!isLinux) return fail(res, 400, 'SD-WAN yalnız Pi üzerinde çalışır');
    try {
      if (sdwanConfigured()) return fail(res, 409, 'SD-WAN zaten kurulu');
      const b = req.body || {};
      const h = hubBasics(b);
      const r = await hubChecks(b, h, Number(b.step) === 3 ? 3 : 2);
      res.json({ success: true, name: h.name, overlay: h.overlay, nets: r.nets, endpoint: r.endpoint });
    } catch (e: any) { failE(res, e); }
  });

  // Merkez kurulumu. kind 'klyrix': bu cihaz dinler (henüz sistem değişmez — ilk şube eklenince açılır). kind 'vps':
  // VPS'te wg_s2s kurulur ve bu cihaz VPS'in ilk şubesi olarak bağlanır (deneme başlar).
  app.post('/api/sdwan/hub', async (req, res) => {
    if (!isLinux) return fail(res, 400, 'SD-WAN yalnız Pi üzerinde çalışır');
    const b = req.body || {};
    let basics: ReturnType<typeof hubBasics>;
    try { basics = hubBasics(b); } catch (e: any) { return failE(res, e); }
    const { kind, name, overlay } = basics;
    try {
      await serial(async () => {
        if (sdwanConfigured()) throw Object.assign(new Error('SD-WAN zaten kurulu'), { status: 409 });
        await execFileP('wg', ['--version'], { timeout: 5000 }).catch(() => { throw Object.assign(new Error('WireGuard araçları (wg) kurulu değil'), { status: 500 }); });
        const { nets: ownNetsOk, endpoint, vps, vpsNets } = await hubChecks(b, basics, 3);
        const own = { nets: ownNetsOk };
        const priv = await genKey();
        writeSecure(KEY_FILE, `${priv}\n`, 0o600);
        const node: NodeConfig = {
          v: 1, role: 'hub', hubKind: kind, name, overlay, ip: overlayHost(overlay, kind === 'klyrix' ? 1 : 2), nets: own.nets, endpoint,
          hubIp: overlayHost(overlay, 1), vpsId: kind === 'vps' ? Number(b.vpsId) : null, vpsNets, allow: [], pending: [], updatedAt: 0, reply: '',
        };
        writeNode(node);
        await ensureTable();
        if (kind === 'vps' && vps) {
          try {
            await dbInsert('INSERT INTO sdwan_sites (name, ip, public_key, nets, endpoint, peer) VALUES (?, ?, ?, ?, ?, 1)',
              [validName(`VPS ${vps.location}`.trim()) || 'VPS', node.hubIp, '', '[]', endpoint]);
            const pushed = await pushVps(node, await siteRows());
            await dbRun('UPDATE sdwan_sites SET public_key = ? WHERE ip = ?', [pushed.pub, node.hubIp]);
            const r = await applyNow();
            if (!r.ok) throw new Error(r.error || 'SD-WAN arayüzü açılamadı');
          } catch (e) {
            if (vps) await removeS2sHub(vpsOpts(vps), ownerId()).catch(() => {});
            await resetNow().catch(() => {});
            throw e;
          }
        }
        await recordEvent('sdwan', kind === 'klyrix'
          ? `SD-WAN merkezi kuruldu (${name}, ${own.nets.join(', ')}) — şubeler davetle eklenir; modemde UDP ${S2S_PORT} Pi'ye yönlendirilmeli`
          : `SD-WAN merkezi VPS'te kuruldu (${vps?.ip}) — bu cihaz ilk şube (${own.nets.join(', ')}); 5 dk içinde "Kalıcı yap"`);
      });
      res.json({ success: true, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // Merkez: tek kullanımlık, 24 saatlik şube daveti. Şubeye bir overlay adresi ayrılır.
  app.post('/api/sdwan/invite', async (req, res) => {
    const name = validName(req.body?.name);
    if (!name) return fail(res, 400, 'Şube adı 1-40 karakter: harf, rakam, boşluk, . _ -');
    try {
      const r = await serial(async () => {
        const node = readNode();
        if (!node || node.role !== 'hub') throw Object.assign(new Error('Bu cihaz SD-WAN merkezi değil'), { status: 409 });
        const sites = await siteRows();
        const now = nowS();
        node.pending = node.pending.filter(p => p.exp > now);
        if (sites.length + node.pending.length >= MAX_SITES) throw Object.assign(new Error(`En çok ${MAX_SITES} şube`), { status: 409 });
        const used = new Set([node.ip, node.hubIp, ...sites.map(s => s.ip), ...node.pending.map(p => p.ip)]);
        let ip = '';
        for (let h = 2; h <= 254 && !ip; h++) { const c = overlayHost(node.overlay, h); if (!used.has(c)) ip = c; }
        if (!ip) throw Object.assign(new Error('Overlay ağında boş adres kalmadı'), { status: 409 });
        const inv = { id: crypto.randomBytes(8).toString('hex'), ip, name, exp: now + INVITE_TTL_S };
        const text = checkedText(encodeText('davet', { v: 1, id: inv.id, exp: inv.exp, overlay: node.overlay, ip, name, hub: await hubInfo(node, sites), sites: members(node, sites) }));
        node.pending.push(inv);
        writeNode(node);
        return { invite: text, ...inv };
      });
      res.json({ success: true, ...r });
    } catch (e: any) { failE(res, e); }
  });

  app.delete('/api/sdwan/invite/:id', async (req, res) => {
    try {
      await serial(async () => {
        const node = readNode();
        if (!node || node.role !== 'hub') throw Object.assign(new Error('Bu cihaz SD-WAN merkezi değil'), { status: 409 });
        const before = node.pending.length;
        node.pending = node.pending.filter(p => p.id !== String(req.params.id));
        if (node.pending.length === before) throw Object.assign(new Error('Davet bulunamadı'), { status: 404 });
        writeNode(node);
      });
      res.json({ success: true });
    } catch (e: any) { failE(res, e); }
  });

  // Davet önizlemesi (şube, sihirbazın 1. adımı): metin geçerli mi, hangi ağlar gelecek, bu cihazla çakışıyor mu.
  async function inviteChecks(raw: unknown): Promise<{ inv: Invite; remote: string[] }> {
    const p = parseInvite(raw, nowS());
    if (!p.ok) throw Object.assign(new Error(p.error), { status: 400 });
    const remote = remoteRoutes({ overlay: p.inv.overlay }, p.inv.sites);
    const clash = findConflict(remote, await localConflictNets());
    if (clash) throw Object.assign(new Error(clash), { status: 409 });
    const ep = parseEndpoint(p.inv.hub.endpoint)!;
    if (isIpv4(ep.host) && remote.some(n => ipInNet(ep.host, n))) throw Object.assign(new Error('Merkezin adresi şube ağlarının içinde — davet kullanılamaz'), { status: 409 });
    return { inv: p.inv, remote };
  }
  app.post('/api/sdwan/join/check', async (req, res) => {
    if (!isLinux) return fail(res, 400, 'SD-WAN yalnız Pi üzerinde çalışır');
    try {
      if (sdwanConfigured()) return fail(res, 409, 'SD-WAN zaten kurulu');
      const { inv, remote } = await inviteChecks(req.body?.invite);
      const id = await getLanIdentity().catch(() => null);
      const cands = await lanCandidates().catch(() => [] as string[]);
      res.json({
        success: true, name: inv.name, ip: inv.ip, exp: inv.exp, hub: { name: inv.hub.name, endpoint: inv.hub.endpoint, ip: inv.hub.ip },
        sites: inv.sites, remote, suggest: id?.client?.network && cands.includes(id.client.network) ? [id.client.network] : cands.slice(0, 1),
      });
    } catch (e: any) { failE(res, e); }
  });

  // Şube: daveti kabul eder — anahtar üretilir, tünel kurulur (deneme), merkeze yapıştırılacak kabul yanıtı döner.
  app.post('/api/sdwan/join', async (req, res) => {
    if (!isLinux) return fail(res, 400, 'SD-WAN yalnız Pi üzerinde çalışır');
    try {
      const r = await serial(async () => {
        if (sdwanConfigured()) throw Object.assign(new Error('SD-WAN zaten kurulu'), { status: 409 });
        await execFileP('wg', ['--version'], { timeout: 5000 }).catch(() => { throw Object.assign(new Error('WireGuard araçları (wg) kurulu değil'), { status: 500 }); });
        const { inv, remote } = await inviteChecks(req.body?.invite);
        const name = req.body?.name === undefined || req.body?.name === '' ? inv.name : validName(req.body.name);
        if (!name) throw Object.assign(new Error('Şube adı 1-40 karakter: harf, rakam, boşluk, . _ -'), { status: 400 });
        const own = await ownNetsCheck(req.body?.nets, inv.overlay);
        if ('error' in own) throw Object.assign(new Error(own.error), { status: 400 });
        const clash = findConflict(own.nets, remote.map(n => ({ cidr: n, label: 'uzak şube ağı' })));
        if (clash) throw Object.assign(new Error(clash), { status: 409 });
        const inside = requesterInside(req, remote);
        if (inside) throw Object.assign(new Error(`Panele bağlandığınız cihaz (${clientIp(req)}) uzak ağın (${inside}) içinde — bu bağlantı kesilirdi`), { status: 409 });
        const priv = await genKey();
        writeSecure(KEY_FILE, `${priv}\n`, 0o600);
        const reply = encodeText('kabul', { v: 1, id: inv.id, pub: await ownPub(), ip: inv.ip, name, nets: own.nets });
        writeNode({
          v: 1, role: 'spoke', hubKind: null, name, overlay: inv.overlay, ip: inv.ip, nets: own.nets, endpoint: inv.hub.endpoint,
          hubIp: inv.hub.ip, vpsId: null, vpsNets: [], allow: [], pending: [], updatedAt: 0, reply,
        });
        try {
          await ensureTable();
          await dbInsert('INSERT INTO sdwan_sites (name, ip, public_key, nets, endpoint, peer) VALUES (?, ?, ?, ?, ?, 1)',
            [inv.hub.name, inv.hub.ip, inv.hub.pub, JSON.stringify(inv.sites.find(s => s.ip === inv.hub.ip)?.nets || []), inv.hub.endpoint]);
          for (const s of inv.sites.filter(x => x.ip !== inv.hub.ip)) {
            await dbInsert('INSERT INTO sdwan_sites (name, ip, public_key, nets, endpoint, peer) VALUES (?, ?, ?, ?, ?, 0)', [s.name, s.ip, '', JSON.stringify(s.nets), '']);
          }
          const a = await applyNow();
          if (!a.ok) throw new Error(a.error || 'SD-WAN arayüzü açılamadı');
        } catch (e) {
          await resetNow().catch(() => {});
          throw e;
        }
        await recordEvent('sdwan', `SD-WAN: "${inv.hub.name}" merkezine katılındı (${inv.ip}, ${own.nets.join(', ')}) — kabul yanıtını merkeze yapıştırın; 5 dk içinde "Kalıcı yap"`);
        return { reply };
      });
      res.json({ success: true, ...r, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // Merkez: şubenin kabul yanıtı — eş eklenir (VPS merkezinde VPS'e de), diğer şubeler için güncelleme metni döner.
  app.post('/api/sdwan/accept', async (req, res) => {
    const p = parseAccept(req.body?.response);
    if (!p.ok) return fail(res, 400, p.error);
    const acc = p.acc;
    try {
      const r = await serial(async () => {
        const node = readNode();
        if (!node || node.role !== 'hub') throw Object.assign(new Error('Bu cihaz SD-WAN merkezi değil'), { status: 409 });
        const pend = node.pending.find(x => x.id === acc.id);
        if (!pend) throw Object.assign(new Error('Bu yanıtın daveti bulunamadı (kullanıldı ya da silindi) — yeni davet oluşturun'), { status: 404 });
        if (pend.exp <= nowS()) throw Object.assign(new Error('Davetin süresi dolmuş — yeni davet oluşturun'), { status: 409 });
        if (pend.ip !== acc.ip) throw Object.assign(new Error('Kabul yanıtındaki adres davetle uyuşmuyor'), { status: 400 });
        const sites = await siteRows();
        if (acc.pub === await ownPub() || sites.some(s => s.pub === acc.pub)) throw Object.assign(new Error('Bu anahtar zaten ekli'), { status: 409 });
        const against: NamedNet[] = [
          ...await localConflictNets(), { cidr: node.overlay, label: 'SD-WAN overlay ağı' },
          ...node.nets.map(n => ({ cidr: n, label: `${node.name} (bu şube)` })),
          ...sites.flatMap(s => s.nets.map(n => ({ cidr: n, label: s.name }))),
          ...node.vpsNets.map(n => ({ cidr: n, label: "VPS'in ağı" })),
        ];
        const clash = findConflict(acc.nets, against);
        if (clash) throw Object.assign(new Error(clash), { status: 409 });
        const inside = requesterInside(req, acc.nets);
        if (inside) throw Object.assign(new Error(`Panele bağlandığınız cihaz (${clientIp(req)}) şubenin ağının (${inside}) içinde — bu bağlantı kesilirdi`), { status: 409 });
        const klyrix = isKlyrixHub(node);
        const id = await dbInsert('INSERT INTO sdwan_sites (name, ip, public_key, nets, endpoint, peer) VALUES (?, ?, ?, ?, ?, ?)',
          [acc.name, acc.ip, acc.pub, JSON.stringify(acc.nets), '', klyrix ? 1 : 0]);
        let warning = '';
        let pushed = false;
        try {
          if (!klyrix) { warning = (await pushVps(node, await siteRows())).warning; pushed = true; }
          node.pending = node.pending.filter(x => x.id !== acc.id);
          writeNode(node);
          const a = await applyNow();
          if (!a.ok) throw new Error(a.error || 'SD-WAN arayüzü açılamadı');
        } catch (e) {
          await dbRun('DELETE FROM sdwan_sites WHERE id = ?', [id]).catch(() => {});
          // Davet tüketilmesin: geçici bir merkez hatasından sonra aynı kabul yanıtı yeniden yapıştırılabilsin
          if (!node.pending.some(x => x.id === pend.id)) node.pending.push(pend);
          try { writeNode(node); } catch { /* yazılamadı: davet yeniden oluşturulur */ }
          // VPS'e eş listesi gittiyse (ya da betik yarıda kaldıysa) eski liste geri yazılır; VPS'e hiç ulaşılamadıysa ikinci kez beklenmez
          if (!klyrix && (pushed || !(e as any)?.unreachable)) await pushVps(node, await siteRows()).catch(() => {});
          await applyNow().catch(() => {});
          throw e;
        }
        await recordEvent('sdwan', `Şube eklendi: ${acc.name} (${acc.ip}, ${acc.nets.join(', ')})`);
        const all = await siteRows();
        const update = await updateText(node, all).catch((e: any) => { warning = warning || String(e?.message || e); return ''; });
        return { site: { id, name: acc.name, ip: acc.ip, nets: acc.nets }, update, others: Math.max(0, members(node, all).length - 2), warning };
      });
      res.json({ success: true, ...r, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // Merkez: şubelere verilecek güncel üye listesi.
  app.get('/api/sdwan/update-text', async (_req, res) => {
    try {
      const node = readNode();
      if (!node || node.role !== 'hub') return fail(res, 409, 'Bu cihaz SD-WAN merkezi değil');
      res.json({ text: await updateText(node, await siteRows()) });
    } catch (e: any) { failE(res, e); }
  });

  // Klyrix merkez: dış adresi değişti (ör. DDNS'siz ev hattında IP değişti). Sonraki davet ve güncelleme metinleri yeni
  // adresi taşır; şubeler güncelleme metniyle uygular (POST /api/sdwan/update). Merkezde sistem durumu değişmez (dinler).
  app.put('/api/sdwan/endpoint', async (req, res) => {
    try {
      const r = await serial(async () => {
        const node = readNode();
        if (!node || !isKlyrixHub(node)) throw Object.assign(new Error('Dış adres yalnız merkez bu Klyrix ise değiştirilir'), { status: 409 });
        const endpoint = await hubEndpointCheck(req.body?.endpoint, node.overlay, node.nets);
        if (endpoint === node.endpoint) return { changed: false, endpoint, update: '' };
        node.endpoint = endpoint;
        writeNode(node);
        await recordEvent('sdwan', `SD-WAN merkezinin dış adresi değişti: ${endpoint} — şubelere güncelleme metnini verin`);
        const sites = await siteRows();
        return { changed: true, endpoint, update: sites.length ? await updateText(node, sites).catch(() => '') : '' };
      });
      res.json({ success: true, ...r, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // Şube: merkezden gelen güncelleme metni (yeni / kaldırılan şubeler, merkezin değişen adresi).
  app.post('/api/sdwan/update', async (req, res) => {
    const p = parseUpdate(req.body?.text);
    if (!p.ok) return fail(res, 400, p.error);
    const upd = p.upd;
    try {
      await serial(async () => {
        const node = readNode();
        if (!node || node.role !== 'spoke') throw Object.assign(new Error('Bu cihaz SD-WAN şubesi değil'), { status: 409 });
        const sites = await siteRows();
        const hub = sites.find(s => s.peer);
        if (!hub || hub.pub !== upd.hub.pub || upd.overlay !== node.overlay || upd.hub.ip !== node.hubIp) throw Object.assign(new Error('Bu güncelleme metni başka bir merkezden'), { status: 409 });
        if (upd.at <= node.updatedAt) throw Object.assign(new Error('Bu güncelleme metni eski — merkezden güncelini alın'), { status: 409 });
        if (!upd.sites.some(s => s.ip === node.ip)) throw Object.assign(new Error("Bu şube merkezin listesinde yok (merkezden kaldırılmış) — gerekiyorsa SD-WAN'dan ayrılın"), { status: 409 });
        const others = upd.sites.filter(s => s.ip !== node.ip && s.ip !== upd.hub.ip);
        const hubNets = upd.sites.find(s => s.ip === upd.hub.ip)?.nets || [];
        const remote = remoteRoutes(node, [{ nets: hubNets }, ...others]);
        const clash = findConflict(remote, [...await localConflictNets(), ...node.nets.map(n => ({ cidr: n, label: `${node.name} (bu şube)` }))]);
        if (clash) throw Object.assign(new Error(clash), { status: 409 });
        const inside = requesterInside(req, remote);
        if (inside) throw Object.assign(new Error(`Panele bağlandığınız cihaz (${clientIp(req)}) uzak ağın (${inside}) içinde — bu bağlantı kesilirdi`), { status: 409 });
        await dbRun('BEGIN');
        try {
          await dbRun('DELETE FROM sdwan_sites WHERE peer = 0');
          await dbRun('UPDATE sdwan_sites SET name = ?, nets = ?, endpoint = ? WHERE id = ?', [upd.hub.name, JSON.stringify(hubNets), upd.hub.endpoint, hub.id]);
          for (const s of others) await dbRun('INSERT INTO sdwan_sites (name, ip, public_key, nets, endpoint, peer) VALUES (?, ?, ?, ?, ?, 0)', [s.name, s.ip, '', JSON.stringify(s.nets), '']);
          await dbRun('COMMIT');
        } catch (e) {
          await dbRun('ROLLBACK').catch(() => {});
          throw e;
        }
        node.updatedAt = upd.at;
        node.endpoint = upd.hub.endpoint;
        writeNode(node);
        const a = await applyNow();
        if (!a.ok) throw new Error(a.error || 'SD-WAN arayüzü açılamadı');
        await recordEvent('sdwan', `SD-WAN üye listesi güncellendi: ${others.length + 1} uzak şube`);
      });
      res.json({ success: true, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // Merkez: şubeyi kaldır (eş, rotalar, kurallar). Son şube kalkınca arayüz ve kurallar kaldırılır.
  app.delete('/api/sdwan/sites/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return fail(res, 400, 'Geçersiz şube');
    try {
      await serial(async () => {
        const node = readNode();
        if (!node || node.role !== 'hub') throw Object.assign(new Error('Şubeler merkezden kaldırılır'), { status: 409 });
        const sites = await siteRows();
        const s = sites.find(x => x.id === id);
        if (!s) throw Object.assign(new Error('Şube bulunamadı'), { status: 404 });
        if (!isKlyrixHub(node) && s.peer) throw Object.assign(new Error("VPS merkezi kaldırılamaz — SD-WAN'ı kaldırın"), { status: 409 });
        // VPS merkezinde önce VPS'in eş listesi (şube hariç): VPS'e ulaşılamazsa satır kalır, kaldırma yeniden denenebilir —
        // yoksa VPS kaldırılan şubeyi eş olarak tutup diğer şubelere iletmeyi sürdürürdü.
        if (!isKlyrixHub(node)) await pushVps(node, sites.filter(x => x.id !== id));
        await dbRun('DELETE FROM sdwan_sites WHERE id = ?', [id]);
        await recordEvent('sdwan', `Şube kaldırıldı: ${s.name} (${s.ip})`);
        const a = await applyNow();
        if (!a.ok) throw new Error(`Şube kaldırıldı ama SD-WAN yeniden uygulanamadı: ${a.error || 'bilinmeyen hata'}`);
      });
      res.json({ success: true, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // İzin listesi (uzak şubelerden bu şubeye). Uygulanınca nft tablosu yeniden yüklenir.
  app.put('/api/sdwan/allow', async (req, res) => {
    try {
      await serial(async () => {
        const node = readNode();
        if (!node) throw Object.assign(new Error('SD-WAN kurulu değil'), { status: 409 });
        // Bu cihazın adresleri: tek cihaz hedefi Pi'nin kendisiyse reddedilir (iletim kuralı Pi'nin hizmetlerini açmaz)
        const own = await ifaceNets();
        const v = validateAllow(req.body?.rules, node.nets, () => crypto.randomBytes(4).toString('hex'), [...own.map(n => n.ip), node.ip]);
        if (!v.ok) throw Object.assign(new Error(v.error), { status: 400 });
        const plan = splitRoutes(remoteRoutes(node, await siteRows()), own.map(n => ({ cidr: n.cidr, label: n.ifname })));
        const nftOf = (allow: typeof node.allow) => renderSdwanNft({
          ownNets: node.nets, transit: isKlyrixHub(node), allow, remote: plan.routes, mtu: pppoeWgMtu() || S2S_DEFAULT_MTU,
        });
        const old = node.allow;
        node.allow = v.rules;
        try {
          await writeNftChecked(nftOf(node.allow));
          if (await nftTableExists() || ifaceUp()) await execFileP('nft', ['-f', SDWAN_NFT_FILE], { timeout: 10000 });
        } catch (e) {
          node.allow = old;
          await writeNftChecked(nftOf(old)).catch(() => {});
          throw e;
        }
        writeNode(node);
        await recordEvent('sdwan', `SD-WAN izin listesi güncellendi: ${node.allow.length} kural`);
      });
      res.json({ success: true, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // Deneme: "Kalıcı yap" (zamanlayıcı durur, birim açılışta etkin) ve "Geri al" (hemen kaldırılır, ayarlar kalır).
  app.post('/api/sdwan/confirm', async (_req, res) => {
    try {
      await serial(async () => {
        if (!sdwanConfigured()) throw Object.assign(new Error('SD-WAN kurulu değil'), { status: 409 });
        if (readTrial().stage !== 'trial') throw Object.assign(new Error('Süren bir deneme yok'), { status: 409 });
        await execFileP('systemctl', ['stop', `${ROLLBACK_UNIT}.timer`], { timeout: 10000 }).catch(() => {});
        const running = await execFileP('systemctl', ['is-active', `${ROLLBACK_UNIT}.service`], { timeout: 5000 }).then(r => r.stdout.trim() === 'active', () => false);
        if (running || readTrial().stage !== 'trial') throw Object.assign(new Error('Deneme süresi doldu — SD-WAN geri alındı; "Yeniden dene" ile tekrar açın'), { status: 409 });
        writeTrial('on');
        await execFileP('systemctl', ['enable', UNIT], { timeout: 15000 }).catch(e => {
          throw new Error(`Kalıcı yapıldı ama açılışta etkinleştirilemedi: ${errText(e)}`);
        });
        await recordEvent('sdwan', 'SD-WAN kalıcı yapıldı');
      });
      res.json({ success: true, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });
  app.post('/api/sdwan/rollback', async (_req, res) => {
    try {
      await serial(async () => {
        if (readTrial().stage !== 'trial') throw Object.assign(new Error('Süren bir deneme yok'), { status: 409 });
        await execFileP('systemctl', ['stop', `${ROLLBACK_UNIT}.timer`], { timeout: 10000 }).catch(() => {});
        const before = await listenState();
        await runScript('rollback');
        health.clear();
        if (before) await wanReload().catch(() => {});
        await recordEvent('sdwan', 'SD-WAN denemesi geri alındı');
      });
      res.json({ success: true, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });
  // Geri alınmış (ya da deneme açılışta bitmiş) SD-WAN'ı yeni bir denemeyle yeniden açar.
  app.post('/api/sdwan/retry', async (_req, res) => {
    try {
      const r = await serial(async () => {
        if (!readNode()) throw Object.assign(new Error('SD-WAN kurulu değil'), { status: 409 });
        if (readTrial().stage !== 'rolledback') throw Object.assign(new Error('SD-WAN geri alınmış değil'), { status: 409 });
        writeTrial('none');
        const a = await applyNow();
        if (!a.ok && a.error) throw new Error(a.error);
        return a;
      });
      res.json({ success: true, apply: r, status: await statusView() });
    } catch (e: any) { failE(res, e); }
  });

  // SD-WAN'ı kaldır / merkezden ayrıl: sistem durumu, ayarlar ve tablo silinir. VPS merkezinde VPS'teki wg_s2s de
  // kaldırılır (wg0'a dokunulmaz); VPS'e ulaşılamazsa yerel kaldırma yine yapılır, uyarı döner.
  app.delete('/api/sdwan', async (_req, res) => {
    try {
      const warning = await serial(async () => {
        if (!sdwanConfigured()) return '';
        const node = readNode();
        let w = '';
        if (node?.hubKind === 'vps') {
          const v = await vpsRow(node.vpsId);
          const r = v ? await removeS2sHub(vpsOpts(v), ownerId()).catch((e: any) => ({ result: 'failed' as const, detail: errText(e), kv: {} as Record<string, string> })) : null;
          if (!r || r.result !== 'ok') w = `VPS'teki SD-WAN merkezi kaldırılamadı${r ? `: ${r.detail}` : ' (VPS kaydı yok)'} — VPS'te: systemctl disable --now wg-quick@wg_s2s`;
          else if (r.kv.wg0_before !== r.kv.wg0_after) w = "VPS'teki wg0 yapılandırması bu işlem sırasında değişti — VPS tünellerini denetleyin";
        }
        await resetNow();
        await recordEvent('sdwan', `SD-WAN kaldırıldı${w ? ` — ${w}` : ''}`, w ? 'warning' : 'info');
        return w;
      });
      res.json({ success: true, warning: warning || undefined });
    } catch (e: any) { failE(res, e); }
  });
}

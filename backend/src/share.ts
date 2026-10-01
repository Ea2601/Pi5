// Ağ paylaşımı (Samba): scripts/share.sh'nin panel tarafı. Paylaşılanlar: veri diskinin paylaşım bölümü (Paylasim) ve
// panelden "Ağda paylaş" denen USB bölümleri. Erişim yalnız kullanıcı adı + şifreyle; iki katmanda sınırlanır:
//  - Samba hosts allow: özel ağlar, EXCEPT Ev VPN misafirleri ve VPS tünel ağları (applyShareAccess → share.sh apply)
//  - güvenlik duvarı: politikası drop olan giriş zincirlerine (Debian inet filter, panelin inet pi5_filter) kendi
//    zincirimiz pi5_share_in (wgServer.ts'teki Ev VPN'i deseni). Güvenlik duvarı yeniden kurulunca zincir silinir; Ev VPN'inin
//    kural kancası (onWgRulesChanged — her güvenlik duvarı kurulumundan sonra çağrılır) onu geri ekler.
// Paylaşımı açmak paket kurar (samba, wsdd2, avahi-daemon): depolama işi olarak koşar (storage.ts, pi5-storage birimi).
import fs from 'fs';
import os from 'os';
import dns from 'dns';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { isLinux, getLanIdentity } from './system';
import { dbAll } from './db';
import { recordEvent } from './events';
import { launchStorageJob, onStorageJobDone } from './storage';
import { onWgRulesChanged } from './wgServer';
import { registerHostsProvider } from './piholeLists';

const execFileP = promisify(execFile);
const SCRIPT = path.resolve(__dirname, '../../scripts/share.sh');
const PW_DIR = '/run/pi5-storage';
const FSTAB = '/etc/fstab';
const USB_MARK = '# klyrix-usb';
const PRIVATE = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16';
// smbd 445; wsdd2 (Windows'ta Ağ altında görünme) TCP/UDP 3702 ve LLMNR 5355; avahi (Mac / iPhone) UDP 5353
const FW_RULES = [
  'iifname "wg_vps*" return',
  `ip saddr { ${PRIVATE} } tcp dport { 445, 3702, 5355 } accept`,
  `ip saddr { ${PRIVATE} } udp dport { 3702, 5353, 5355 } accept`,
];
const FW_TABLES = ['filter', 'pi5_filter'];
const FW_CHAIN = 'pi5_share_in';
const CONF = process.env.PI5_SHARE_CONF || '/etc/pi5-gateway/share.conf';
// Paylaşımın sabit adı (Pi-hole yerel DNS): \\paylasim.lan\Paylasim — Pi'nin adresi değişse de aynı kalır.
export const SHARE_DNS_NAME = 'paylasim.lan';

export interface ShareUsb { name: string; uuid: string; fstype: string; mounted: boolean; device: string }
export interface ShareStatus {
  supported: boolean; installed: boolean; enabled: boolean; user: string;
  smbd: boolean; wsdd: boolean; avahi: boolean; shareDir: string; usb: ShareUsb[]; host: string; ip: string;
  name: string; nameOk: boolean; // nameOk: ad Pi-hole'da gerçekten çözülüyor
}

// share.sh'yi çalıştırır; çıktı KEY=VALUE satırları (usb birden çok). Betik hata verirse (error=...) fırlatır.
async function run(args: string[], input?: string, timeout = 60000): Promise<{ kv: Record<string, string>; usb: string[] }> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn('/bin/bash', [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('paylaşım komutu zaman aşımına uğradı')); }, timeout);
    p.stdout.on('data', d => { so += d; });
    p.stderr.on('data', d => { se += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      const err = /^error=(.*)$/m.exec(so)?.[1];
      if (err) reject(new Error(err));
      else if (code !== 0) reject(new Error(se.trim().split('\n').pop() || `share.sh çıkış kodu ${code}`));
      else resolve(so);
    });
    p.stdin.end(input ?? '');
  });
  const kv: Record<string, string> = {};
  const usb: string[] = [];
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === 'usb') usb.push(v); else kv[k] = v;
  }
  return { kv, usb };
}

let cache: { at: number; data: ShareStatus } | null = null;
export async function shareStatus(fresh = false): Promise<ShareStatus> {
  const empty: ShareStatus = {
    supported: false, installed: false, enabled: false, user: '', smbd: false, wsdd: false, avahi: false, shareDir: '', usb: [], host: '', ip: '',
    name: SHARE_DNS_NAME, nameOk: false,
  };
  if (!isLinux || !fs.existsSync(SCRIPT)) return empty;
  if (!fresh && cache && Date.now() - cache.at < 3000) return cache.data;
  const { kv, usb } = await run(['status'], undefined, 15000);
  const data: ShareStatus = {
    supported: true, installed: kv.installed === '1', enabled: kv.enabled === '1', user: kv.user || '',
    smbd: kv.smbd === '1', wsdd: kv.wsdd === '1', avahi: kv.avahi === '1', shareDir: kv.share_dir || '',
    usb: usb.map(l => {
      const [name, uuid, fstype, mounted, device] = l.split('|');
      return { name, uuid, fstype, mounted: mounted === '1', device: device || '' };
    }),
    host: os.hostname(), ip: (await getLanIdentity().catch(() => null))?.ip || '',
    name: SHARE_DNS_NAME, nameOk: kv.enabled === '1' && await nameResolves(),
  };
  cache = { at: Date.now(), data };
  return data;
}

// ── sabit ad: Pi-hole yerel DNS kaydı ───────────────────────────────────────
// Paylaşım açıkken paylasim.lan → Pi'nin ev ağı adresi ve (sabit adres modunda ayrıysa) modem tarafı adresi; Pi-hole
// sorunun geldiği ağdaki adresi döndürür. Kaydı piholeLists eşitlemesi yazar; adres değişince izleyicisi yeniler.
function confEnabled(): boolean {
  let txt = '';
  try { txt = fs.readFileSync(CONF, 'utf8'); } catch { return false; }
  const vals = txt.split('\n').filter(l => l.startsWith('enabled=')).map(l => l.slice('enabled='.length).trim());
  return vals.pop() === '1'; // share.sh conf_get gibi son satır geçerli
}
async function shareHosts(): Promise<string[]> {
  if (!confEnabled()) return [];
  const lan = await getLanIdentity().catch(() => null);
  if (!lan) throw new Error('Pi\'nin ev ağı adresi okunamadı'); // geçici: önceki kayıt kalır
  return [...new Set([lan.ip, lan.transit.ip].filter(Boolean))].map(ip => `${ip} ${SHARE_DNS_NAME}`);
}
// Ad Pi-hole'da (Pi'nin kendi DNS'i) çözülüyor mu — panel çözülmüyorsa IP'li adresi öne alır.
async function nameResolves(): Promise<boolean> {
  const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
  r.setServers(['127.0.0.1']);
  try { return (await r.resolve4(SHARE_DNS_NAME)).length > 0; } catch { return false; }
}

// ── erişim: Samba dışlama listesi + güvenlik duvarı zinciri ─────────────────
async function exceptList(): Promise<string[]> {
  const out: string[] = [];
  // Ev VPN'i misafirleri (yalnız internet): paylaşıma erişemez
  try {
    for (const r of (await dbAll("SELECT ip FROM wg_server_peers WHERE role != 'admin'")) as { ip: string }[]) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(r.ip)) out.push(r.ip);
    }
  } catch { /* Ev VPN'i hiç kurulmamış */ }
  // VPS tünelleri (wg_vps*): karşı uç (VPS) ev ağı değildir
  try {
    const { stdout } = await execFileP('ip', ['-j', '-4', 'addr', 'show'], { timeout: 5000 });
    for (const a of JSON.parse(stdout || '[]') as { ifname: string; addr_info?: { local: string; prefixlen: number }[] }[]) {
      if (!a.ifname.startsWith('wg_vps')) continue;
      for (const x of a.addr_info || []) out.push(`${x.local}/${x.prefixlen}`);
    }
  } catch { /* ip okunamadı */ }
  return out;
}

async function nft(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('nft', ['-f', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let se = '';
    p.stderr.on('data', d => { se += d; });
    p.on('error', reject);
    p.on('close', c => (c === 0 ? resolve() : reject(new Error(se.trim() || `nft çıkış ${c}`))));
    p.stdin.end(script);
  });
}

// Giriş zincirinde bizim jump'ın ve ilk koşulsuz son kararın (ör. eski kurulumların `inet filter`'ındaki sondaki `drop`,
// `counter drop`, `reject ...`) yeri. Koşulsuz karardan SONRA gelen kural hiç okunmaz: jump onun önüne konur. Karar
// satırı yoksa (panelin pi5_filter'ı: yalnız politika drop) sona eklenir — kullanıcının özel "engelle" kuralları önce kalır.
const TERMINAL = /^(counter( packets \d+ bytes \d+)?\s+)?(log\b.*?\s+)?(drop|reject\b.*)$/;
export function shareJumpPlan(listing: string): { jump?: string; terminal?: string; misplaced: boolean } {
  const rules: { text: string; handle: string }[] = [];
  for (const line of listing.split('\n')) {
    const m = /^\s*(.+?)\s+# handle (\d+)\s*$/.exec(line);
    if (m && !/^(chain|table)\s/.test(m[1])) rules.push({ text: m[1].trim(), handle: m[2] });
  }
  const ji = rules.findIndex(r => r.text === `jump ${FW_CHAIN}`);
  const ti = rules.findIndex(r => TERMINAL.test(r.text));
  return { jump: rules[ji]?.handle, terminal: rules[ti]?.handle, misplaced: ji >= 0 && ti >= 0 && ji > ti };
}

// Politikası drop olan giriş zincirlerine izin zinciri: açıksa ekle / tazele (yanlış yerdeki jump taşınır), kapalıysa
// kaldır. Tablo yoksa dokunulmaz.
export async function syncShareFirewall(enable: boolean): Promise<void> {
  for (const table of FW_TABLES) {
    const listing = await execFileP('nft', ['-a', 'list', 'chain', 'inet', table, 'input'], { timeout: 5000 }).then(r => r.stdout, () => null);
    if (listing === null) continue;
    const policyDrop = /policy drop;/.test(listing);
    const plan = shareJumpPlan(listing);
    const exists = await execFileP('nft', ['list', 'chain', 'inet', table, FW_CHAIN], { timeout: 5000 }).then(() => true, () => false);
    let script = '';
    if (enable && policyDrop) {
      script += `add chain inet ${table} ${FW_CHAIN}\nflush chain inet ${table} ${FW_CHAIN}\n`;
      for (const r of FW_RULES) script += `add rule inet ${table} ${FW_CHAIN} ${r}\n`;
      if (plan.jump && plan.misplaced) script += `delete rule inet ${table} input handle ${plan.jump}\n`;
      if (!plan.jump || plan.misplaced) {
        script += plan.terminal
          ? `insert rule inet ${table} input position ${plan.terminal} jump ${FW_CHAIN}\n`
          : `add rule inet ${table} input jump ${FW_CHAIN}\n`;
      }
    } else {
      if (plan.jump) script += `delete rule inet ${table} input handle ${plan.jump}\n`;
      if (exists) script += `delete chain inet ${table} ${FW_CHAIN}\n`;
    }
    if (script) await nft(script);
  }
}

// Dışlama listesini ve güvenlik duvarı zincirini güncel duruma getirir (paylaşım kapalıyken de listeyi kaydeder: açılınca
// misafirler baştan dışlanmış olur).
let accessRun: Promise<void> | null = null;
export function applyShareAccess(): Promise<void> {
  if (accessRun) return accessRun.then(() => applyShareAccess());
  accessRun = (async () => {
    if (!isLinux || !fs.existsSync(SCRIPT)) return;
    const except = await exceptList();
    await run(['apply', '--except', except.join(' ')]);
    const st = await shareStatus(true);
    await syncShareFirewall(st.enabled);
  })().finally(() => { accessRun = null; cache = null; });
  return accessRun;
}

// ── işlemler ─────────────────────────────────────────────────────────────────
const USER_RE = /^[a-z][a-z0-9_-]{2,31}$/;
function checkPassword(p: unknown): string {
  if (typeof p !== 'string' || p.length < 8 || p.length > 64 || /[\r\n]/.test(p)) throw new Error('Şifre 8-64 karakter olmalı');
  return p;
}

export async function enableShare(body: { user?: unknown; password?: unknown }): Promise<{ id: string }> {
  if (!isLinux) throw new Error('Ağ paylaşımı yalnız Pi üzerinde çalışır');
  const user = typeof body.user === 'string' ? body.user.trim() : '';
  if (!USER_RE.test(user)) throw new Error('Kullanıcı adı 3-32 karakter olmalı: küçük harfle başlar; küçük harf, rakam, - ve _ içerir');
  const password = checkPassword(body.password);
  const st = await shareStatus(true);
  if (st.user && st.user !== user) throw new Error(`Kullanıcı adı değiştirilemez (mevcut: ${st.user})`);
  // Önce dışlama listesi: paylaşım açıldığı an misafirler ve VPS tünelleri dışarıda olsun
  await applyShareAccess().catch(() => { /* iş yine de açar; tamamlanınca yeniden uygulanır */ });
  // Şifre betiğe dosyayla verilir (komut satırı ve ortam değişkenleri süreç listesinde görünür); betik okuyup siler
  fs.mkdirSync(PW_DIR, { recursive: true, mode: 0o700 });
  const pwfile = path.join(PW_DIR, `share-${Date.now()}.pw`);
  fs.writeFileSync(pwfile, `${password}\n`, { mode: 0o600 });
  try {
    return await launchStorageJob('share', ['--user', user, '--pwfile', pwfile], `Ağ paylaşımı açılıyor (kullanıcı: ${user})`, SCRIPT, 'enable');
  } catch (e) {
    fs.rmSync(pwfile, { force: true });
    throw e;
  }
}

export async function disableShare(): Promise<void> {
  await run(['disable'], undefined, 30000);
  cache = null;
  await syncShareFirewall(false).catch(() => {});
  await recordEvent('storage', 'Ağ paylaşımı kapatıldı');
}

export async function setSharePassword(p: unknown): Promise<void> {
  await run(['passwd'], `${checkPassword(p)}\n`, 30000);
  await recordEvent('storage', 'Ağ paylaşımı şifresi değiştirildi');
}

export async function addUsbShare(part: unknown): Promise<string> {
  if (typeof part !== 'string' || !/^\/dev\/[A-Za-z0-9]+$/.test(part)) throw new Error('Geçersiz bölüm');
  const { kv } = await run(['usb-add', '--part', part], undefined, 90000);
  cache = null;
  await recordEvent('storage', `USB disk ağda paylaşıldı: ${kv.name || part}`);
  return kv.name || '';
}

export async function removeUsbShare(name: unknown): Promise<void> {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('Geçersiz paylaşım adı');
  await run(['usb-remove', '--name', name], undefined, 60000);
  cache = null;
  await recordEvent('storage', `USB disk paylaşımı kaldırıldı: ${name} (disk güvenle ayrıldı)`);
}

// ── izleme ───────────────────────────────────────────────────────────────────
// Paylaşılan bir USB disk çıkarılıp yeniden takılınca kendiliğinden bağlanmaz (fstab satırı yalnız açılışta): takılı
// (/dev/disk/by-uuid) ama bağlı olmayan paylaşım görülünce share.sh ensure. Yalnız USB paylaşımı varken, 20 sn'de bir.
function usbNeedsMount(): boolean {
  let fstab = '';
  let mounts = '';
  try { fstab = fs.readFileSync(FSTAB, 'utf8'); mounts = fs.readFileSync('/proc/mounts', 'utf8'); } catch { return false; }
  for (const line of fstab.split('\n')) {
    if (!line.includes(USB_MARK)) continue;
    const [src, mp] = line.split(/\s+/);
    const uuid = src?.startsWith('UUID=') ? src.slice(5) : '';
    if (uuid && mp && fs.existsSync(`/dev/disk/by-uuid/${uuid}`) && !mounts.includes(` ${mp} `)) return true;
  }
  return false;
}

export function startShareWatch(): void {
  if (!isLinux) return;
  registerHostsProvider(shareHosts);
  onWgRulesChanged(async () => { await applyShareAccess(); });
  onStorageJobDone(j => { if (j.cmd === 'share' && j.state === 'done') void applyShareAccess().catch(e => console.error('[paylaşım]', e?.message || e)); });
  setInterval(() => {
    if (!usbNeedsMount()) return;
    run(['ensure']).then(() => { cache = null; }).catch(e => console.error('[paylaşım] USB bağlanamadı:', e?.message || e));
  }, 20000);
}

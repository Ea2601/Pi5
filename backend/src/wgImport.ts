// Hazır WireGuard yapılandırmasıyla bağlanma: içe aktarılan tünelin yaşam döngüsü (kur, bağla, yapılandırmayı değiştir, sil)
// ve koruma tablosu. Kayıt vps_servers'ta durur (kind = 'import', SSH bilgisi yok, wg_conf = temizlenmiş yapılandırma). Arayüz
// wg_vps<id> olduğu için şunlar panelin kendi VPS tünelleriyle aynı yoldan çalışır: yönlendirme kuralları ve "tünel düşerse"
// (işaret tabloları), durum ve uyarılar (vpsTunnel.ts, index.ts izleyicisi), NAT (wg_vps*), ağ haritası ve açılışta geri kurulum
// (systemd wg-quick@). Sunucu panelin değildir: kurulum, istemci (QR), SSH denetimi ve otomatik onarım yok (index.ts bu kayıtlarda
// reddeder). Temizleme ve yazım wgConf.ts'te: Pi'ye yalnız onun ürettiği metin yazılır.
//
// Güven: sunucu ve arkasındaki ağ (sağlayıcının öbür kullanıcıları, şirket ağı) panelin değil. Panelin kendi VPS tünellerine
// tam güvenilir (services.ts: SSH / DNS / panel her karttan açık, wg_vps* → ev ağı iletimi açık). Bu yüzden içe aktarılan
// arayüzlerden gelen YENİ bağlantılar inet pi5_wgext tablosunda düşer (input + forward); giden trafik ve yanıtları geçer.
// Tablo /etc/nftables.d/pi5-wgext.conf'ta: tünelin PreUp'ı yükler (yüklenemezse tünel açılmaz), panelin nftables.conf'u
// açılışta include eder, pi5-gw-restore nftables yeniden başlayınca yükler, burada da dakikada bir denetlenir.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux } from './system';
import { vpsIface } from './vpsTunnel';
import { localNetworks, cidrOverlaps, clientTunnelIp } from './remoteAccess';
import { lanNetworks } from './fail2ban';
import { WG_NET } from './wgServer';
import { parseWgVpsConf } from './vault';
import { parseImportedConf, renderImportedConf, renderStoredConf, importSummary, WGEXT_NFT_FILE, type WgImportConf } from './wgConf';

const execFileP = promisify(execFile);

export const IMPORT_KIND = 'import';
const WG_DIR = '/etc/wireguard';
const NFT_TABLE = 'pi5_wgext';
// Kurulumdan / bağlanmadan sonra ilk el sıkışma için beklenen süre (sonuç yalnız bilgi: gelmese de tünel kurulu kalır).
const HANDSHAKE_WAIT_MS = 6000;
// Etkileşimli kurulumda sunucu adı çözülemezse wg uzun süre yeniden dener (varsayılan 15 deneme, ~70 sn): kullanıcı beklemesin.
// Açılıştaki systemd birimi varsayılanla çalışır (DNS geç hazır olabilir).
const UP_ENV = { ...process.env, WG_ENDPOINT_RESOLUTION_RETRIES: '3' };

export type ImportFail = { ok: false; status: 400 | 404 | 409 | 500; error: string };
export interface ImportDone { ok: true; id: number; label: string; handshake: boolean; notes: string[]; fullTunnel: boolean }
export interface ReplaceDone { ok: true; label: string; applied: boolean; handshake: boolean; notes: string[] }
export interface ConnectDone { ok: true; handshake: boolean }
interface ImportedRow { id: number; ip: string; location: string; status: string; wg_conf: string }

const confPath = (id: number) => path.join(WG_DIR, `${vpsIface(id)}.conf`);
const label = (name: unknown, host: unknown) => `${String(name || '') || 'VPS'} (${String(host || '')})`;
const notLinux: ImportFail = { ok: false, status: 400, error: 'Tünel yalnız Pi üzerinde kurulabilir' };

// Kartta görünen ad (vps_servers.location): denetim karakterleri atılır, en çok 60 karakter.
export function importName(raw: unknown): string {
  return String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 60);
}

// Yaşam döngüsü işleri sırayla çalışır: eşzamanlı iki işlem (iki içe aktarma, silme + izleyici) koruma dosyasını ya da aynı
// arayüzü birbirinin ortasında değiştirmesin. İç yardımcılar (…Now) kuyruğa girmez — kuyruktaki işten çağrılır.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const importedRows = () =>
  dbAll('SELECT id, ip, location, status, wg_conf FROM vps_servers WHERE kind = ? ORDER BY id', [IMPORT_KIND]) as Promise<ImportedRow[]>;
const importedRow = (id: number) =>
  dbGet('SELECT id, ip, location, status, wg_conf FROM vps_servers WHERE id = ? AND kind = ?', [id, IMPORT_KIND]) as Promise<ImportedRow | undefined>;

// ─── Koruma tablosu ───
// Arayüz adı eşleşmesi (iifname) arayüz henüz yokken de çalışır: tablo tünelden önce yüklenebilir.
export function renderGuardNft(ifaces: string[]): string {
  const set = `{ ${ifaces.map(i => `"${i}"`).join(', ')} }`;
  return [
    `table inet ${NFT_TABLE} {}`,
    `delete table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority filter - 5; policy accept;',
    `    iifname ${set} ct state new drop`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority filter - 5; policy accept;',
    `    iifname ${set} ct state new drop`,
    '  }',
    '}',
    '',
  ].join('\n');
}

const nftHasTable = () =>
  execFileP('nft', ['list', 'table', 'inet', NFT_TABLE], { timeout: 10000 }).then(() => true, () => false);

// Dosya ve tablo veritabanındaki içe aktarılan kayıtlardan yazılır; kayıt yoksa ikisi de kaldırılır.
async function syncGuardNow(): Promise<void> {
  if (!isLinux) return;
  const ifaces = (await importedRows()).map(r => Number(r.id)).filter(n => Number.isSafeInteger(n) && n > 0).map(vpsIface);
  if (!ifaces.length) {
    try { fs.unlinkSync(WGEXT_NFT_FILE); } catch { /* yok */ }
    if (await nftHasTable()) await execFileP('nft', ['delete', 'table', 'inet', NFT_TABLE], { timeout: 10000 });
    return;
  }
  fs.mkdirSync(path.dirname(WGEXT_NFT_FILE), { recursive: true });
  const tmp = `${WGEXT_NFT_FILE}.tmp`; // *.conf değil: yarım dosya include'a girmez
  fs.writeFileSync(tmp, renderGuardNft(ifaces));
  fs.renameSync(tmp, WGEXT_NFT_FILE);
  await execFileP('nft', ['-f', WGEXT_NFT_FILE], { timeout: 10000 });
}
export const syncImportGuard = (): Promise<void> => serial(syncGuardNow);

// Tablo yoksa (ör. elle `nft flush ruleset`) dakikada bir yeniden yüklenir. nftables yeniden başlatılınca pi5-gw-restore zaten
// hemen yükler; bu denetim ondan bağımsız ikinci yoldur.
let guardTimer: ReturnType<typeof setInterval> | null = null;
let lastGuardError = '';
export function startImportGuardWatch(): void {
  if (!isLinux || guardTimer) return;
  guardTimer = setInterval(() => {
    void serial(async () => {
      if (!(await importedRows()).length || await nftHasTable()) return;
      await syncGuardNow();
      console.warn(`[wg-import] koruma tablosu (inet ${NFT_TABLE}) yoktu — yeniden yüklendi`);
    }).then(() => { lastGuardError = ''; }, (e: any) => {
      const msg = String(e?.message || e);
      if (msg !== lastGuardError) console.error('[wg-import] koruma tablosu denetlenemedi:', msg);
      lastGuardError = msg;
    });
  }, 60000);
}

// ─── Tünel ───
function writeConf(id: number, text: string): void {
  fs.mkdirSync(WG_DIR, { recursive: true, mode: 0o700 });
  const file = confPath(id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
function removeConf(id: number): void {
  try { fs.unlinkSync(confPath(id)); } catch { /* yok */ }
}

function wgQuickError(e: any): string {
  if (e?.killed) return 'Tünel açılamadı: zaman aşımı (sunucunun adı çözülemedi olabilir)';
  const lines = String(e?.stderr || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[#]'));
  const msg = lines.slice(-2).join(' — ') || String(e?.message || e);
  return `Tünel açılamadı: ${msg.length > 300 ? `${msg.slice(0, 297)}…` : msg}`;
}

// ssh.ts connectPi5ToVps ile aynı sıra: açılışta systemd birimi başlattıysa önce birim durur, sonra arayüz yeniden kurulur.
async function tunnelUp(iface: string): Promise<void> {
  await execFileP('systemctl', ['stop', `wg-quick@${iface}`], { timeout: 15000 }).catch(() => {});
  await execFileP('wg-quick', ['down', iface], { timeout: 15000 }).catch(() => {});
  try {
    await execFileP('wg-quick', ['up', iface], { timeout: 30000, env: UP_ENV });
  } catch (e: any) {
    throw new Error(wgQuickError(e));
  }
  const { stdout } = await execFileP('wg', ['show', iface], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  if (!/endpoint/.test(stdout)) throw new Error(`Tünel açılamadı: ${iface} arayüzünde sunucu (endpoint) yok`);
}
async function tunnelDown(iface: string): Promise<void> {
  await execFileP('systemctl', ['disable', '--now', `wg-quick@${iface}`], { timeout: 15000 }).catch(() => {});
  await execFileP('wg-quick', ['down', iface], { timeout: 15000 }).catch(() => {});
}
const enableUnit = (iface: string) =>
  execFileP('systemctl', ['enable', `wg-quick@${iface}`], { timeout: 10000 }).then(() => {}, () => {});
const unitEnabled = (iface: string) =>
  execFileP('systemctl', ['is-enabled', `wg-quick@${iface}`], { timeout: 5000 }).then(r => r.stdout.trim() === 'enabled', () => false);

async function waitHandshake(iface: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const { stdout } = await execFileP('wg', ['show', iface, 'latest-handshakes'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
    if (stdout.split('\n').some(l => Number(l.trim().split(/\s+/)[1]) > 0)) return true;
    if (Date.now() >= until) return false;
    await new Promise(r => setTimeout(r, 500));
  }
}

// Kurulmadan önce: tünel adresi bu cihazın bir ağıyla (ev ağı, internet kartı, kurulum Wi-Fi'ı, Ev VPN'i …) çakışmasın (Pi o
// ağa giden trafiği tünele sanırdı), uzaktan yönetimi açık bir VPS istemcisinin adresi olmasın (Pi o istemcinin paketlerini
// kendi adresinden gelmiş sayıp düşürürdü) ve aynı yapılandırma (özel anahtar) ikinci kez eklenmesin (iki arayüz sunucuda
// birbirini düşürür). selfId: değiştirilen kaydın kendisi.
async function checkConflicts(c: WgImportConf, selfId: number | null): Promise<string | null> {
  const ip = c.address.split('/')[0];
  const nets = [...await localNetworks().catch(() => [] as string[]), ...await lanNetworks().catch(() => [] as string[]), WG_NET];
  const hit = nets.find(n => cidrOverlaps(`${ip}/32`, n));
  if (hit) return `Tünel adresi (${ip}) bu cihazın bir ağıyla (${hit}) çakışıyor — sağlayıcıdan başka adresli bir yapılandırma alın`;
  const admins = await dbAll('SELECT name, ip FROM wg_clients WHERE panel_access = 1').catch(() => [] as any[]);
  const admin = admins.find(r => clientTunnelIp(r.ip) === ip);
  if (admin) {
    return `Tünel adresi (${ip}) uzaktan yönetimi açık "${admin.name}" VPS istemcisinin adresiyle aynı — önce onun panel erişimini kapatın ya da başka adresli bir yapılandırma alın`;
  }
  for (const r of await dbAll('SELECT id, ip, location, kind, wg_conf FROM vps_servers').catch(() => [] as any[])) {
    const id = Number(r.id);
    if (id === selfId) continue;
    let key = '';
    if (r.kind === IMPORT_KIND) {
      const p = parseImportedConf(r.wg_conf);
      key = p.ok ? p.conf.privateKey : '';
    } else {
      try { key = parseWgVpsConf(fs.readFileSync(confPath(id), 'utf8'))?.privateKey || ''; } catch { /* tünel kurulmamış */ }
    }
    if (key && key === c.privateKey) return `Bu yapılandırma zaten ekli: ${label(r.location, r.ip)}`;
  }
  return null;
}

export function importTunnel(nameRaw: unknown, raw: unknown): Promise<ImportDone | ImportFail> {
  return serial(async (): Promise<ImportDone | ImportFail> => {
    if (!isLinux) return notLinux;
    const p = parseImportedConf(raw);
    if (!p.ok) return { ok: false, status: 400, error: p.error };
    const clash = await checkConflicts(p.conf, null);
    if (clash) return { ok: false, status: 409, error: clash };
    const name = importName(nameRaw);
    const conf = renderImportedConf(p.conf);
    const id = await dbInsert(
      `INSERT INTO vps_servers (ip, username, password, location, status, kind, wg_conf) VALUES (?, '', '', ?, 'installing', ?, ?)`,
      [p.conf.endpointHost, name, IMPORT_KIND, conf]);
    const iface = vpsIface(id);
    try {
      await syncGuardNow(); // koruma tablosu tünelden önce (PreUp da yükler)
      writeConf(id, conf);
      await tunnelUp(iface);
    } catch (e: any) {
      // Yarım kurulum kalmaz: arayüz, dosya ve kayıt geri alınır.
      await tunnelDown(iface);
      removeConf(id);
      await dbRun('DELETE FROM vps_servers WHERE id = ?', [id]).catch(() => {});
      await syncGuardNow().catch((g: any) => console.error('[wg-import] koruma tablosu güncellenemedi:', g?.message || g));
      return { ok: false, status: 500, error: String(e?.message || e) };
    }
    await enableUnit(iface); // açılışta systemd ile geri gelsin ("Tüneli kes" kapatır)
    await dbRun(`UPDATE vps_servers SET status = 'connected' WHERE id = ?`, [id]);
    return {
      ok: true, id, label: label(name, p.conf.endpointHost), handshake: await waitHandshake(iface, HANDSHAKE_WAIT_MS),
      notes: p.conf.notes, fullTunnel: p.conf.fullTunnel,
    };
  });
}

// "Tüneli bağla": kayıtlı yapılandırma her seferinde yeniden temizlenip yazılır (dosya elle değişmişse de kayıt geçerlidir).
export function connectImported(id: number): Promise<ConnectDone | ImportFail> {
  return serial(async (): Promise<ConnectDone | ImportFail> => {
    if (!isLinux) return notLinux;
    const row = await importedRow(id);
    if (!row) return { ok: false, status: 404, error: 'Kayıt bulunamadı' };
    const conf = renderStoredConf(row.wg_conf);
    if (!conf) return { ok: false, status: 500, error: 'Kayıtlı yapılandırma okunamadı — kartta "Yapılandırmayı değiştir" ile yeniden yapıştırın' };
    const iface = vpsIface(id);
    try {
      await syncGuardNow();
      writeConf(id, conf);
      await tunnelUp(iface);
    } catch (e: any) {
      await dbRun(`UPDATE vps_servers SET status = 'error' WHERE id = ?`, [id]).catch(() => {});
      return { ok: false, status: 500, error: String(e?.message || e) };
    }
    await enableUnit(iface);
    await dbRun(`UPDATE vps_servers SET status = 'connected' WHERE id = ?`, [id]);
    return { ok: true, handshake: await waitHandshake(iface, HANDSHAKE_WAIT_MS) };
  });
}

// Aynı kayda yeni yapılandırma (ör. sağlayıcıda sunucu değişti): kimlik ve arayüz aynı kalır, bu tünele yönlenen kurallar korunur.
// Tünel açıksa (ya da açılışta açılacaksa) yeni yapılandırmayla yeniden kurulur; açılamazsa eskisi geri yazılır ve yeniden açılır.
// Kullanıcı tüneli kestiyse yalnız kaydedilir, bağlanınca kullanılır. nameRaw undefined: ad değişmez.
export function replaceImportedConf(id: number, nameRaw: unknown, raw: unknown): Promise<ReplaceDone | ImportFail> {
  return serial(async (): Promise<ReplaceDone | ImportFail> => {
    if (!isLinux) return notLinux;
    const row = await importedRow(id);
    if (!row) return { ok: false, status: 404, error: 'Kayıt bulunamadı' };
    const p = parseImportedConf(raw);
    if (!p.ok) return { ok: false, status: 400, error: p.error };
    const clash = await checkConflicts(p.conf, id);
    if (clash) return { ok: false, status: 409, error: clash };
    const name = nameRaw === undefined ? String(row.location || '') : importName(nameRaw);
    const conf = renderImportedConf(p.conf);
    const iface = vpsIface(id);
    const active = fs.existsSync(`/sys/class/net/${iface}`) || await unitEnabled(iface);
    await dbRun('UPDATE vps_servers SET ip = ?, location = ?, wg_conf = ? WHERE id = ?', [p.conf.endpointHost, name, conf, id]);
    writeConf(id, conf);
    const done = { label: label(name, p.conf.endpointHost), notes: p.conf.notes };
    if (!active) return { ok: true, ...done, applied: false, handshake: false };
    try {
      await syncGuardNow();
      await tunnelUp(iface);
    } catch (e: any) {
      await dbRun('UPDATE vps_servers SET ip = ?, location = ?, wg_conf = ? WHERE id = ?', [row.ip, row.location, row.wg_conf, id]).catch(() => {});
      const old = renderStoredConf(row.wg_conf);
      let back = false;
      if (old) {
        writeConf(id, old);
        back = await tunnelUp(iface).then(() => true, (b: any) => { console.error('[wg-import] eski yapılandırma da açılamadı:', b?.message || b); return false; });
      }
      return {
        ok: false, status: 500,
        error: `${String(e?.message || e)} — eski yapılandırma geri yüklendi${back ? ' ve tünel yeniden açıldı' : ''}`,
      };
    }
    await enableUnit(iface);
    await dbRun(`UPDATE vps_servers SET status = 'connected' WHERE id = ?`, [id]);
    return { ok: true, ...done, applied: true, handshake: await waitHandshake(iface, HANDSHAKE_WAIT_MS) };
  });
}

// Silme (index.ts DELETE /api/vps/:id): tünel indirilip kayıt silindikten sonra yapılandırma dosyası (özel anahtar) Pi'den
// kaldırılır ve koruma tablosu kalan tünellere göre yazılır.
export function removeImportedTunnel(id: number): Promise<void> {
  return serial(async () => {
    if (!isLinux) return;
    removeConf(id);
    await syncGuardNow();
  });
}

// Çıkış IP'si Pi'den tünel üzerinden ölçülür (sunucuya SSH yok): curl arayüze bağlanır (SO_BINDTODEVICE). Bölünmüş tünelde
// çağrılmaz (index.ts): internet trafiği o tünelden çıkmaz.
export async function importedExitIp(id: number): Promise<{ publicIp: string; note?: string }> {
  if (!isLinux) return { publicIp: '', note: 'Yalnız Pi üzerinde ölçülür' };
  const iface = vpsIface(id);
  if (!fs.existsSync(`/sys/class/net/${iface}`)) return { publicIp: '', note: 'Tünel kapalı' };
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me']) {
    const out = await execFileP('curl', ['-4', '-s', '--max-time', '6', '--interface', iface, url], { timeout: 10000 })
      .then(r => r.stdout.trim(), () => '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return { publicIp: out };
  }
  return { publicIp: '', note: 'Tünel üzerinden internete çıkılamadı' };
}

// Uzaktan yönetim (index.ts panel-access): istemcinin adresi içe aktarılan bir tünelin adresiyse o tünelin adı.
export async function importedAddressOwner(ip: string): Promise<string | null> {
  for (const r of await importedRows()) {
    const s = importSummary(r.wg_conf);
    if (s && s.address.split('/')[0] === ip) return label(r.location, r.ip);
  }
  return null;
}

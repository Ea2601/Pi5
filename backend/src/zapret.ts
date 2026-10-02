// Zapret (DPI atlatma): panel ayarları Zapret'e gerçekten uygulanır.
//  - Öğrenen liste (v2.24.80, kullanıcı kararı): ev ağından modemden çıkan tüm web trafiği öğrenme işaretiyle (0x10000) ve
//    Routing'de DPI'ı açık kuralların trafiği DPI biti (0x4000) ile nfqws'e gider (FILTER_MARK=0x14000, routeMarks.ts).
//    MODE_FILTER=autohostlist: atlatma yalnız listedeki sitelere uygulanır — kullanıcı listesi (DPI kurallarının siteleri,
//    ek siteler, DPI'lı hazır listeler; panel yazar) + otomatik liste (zapret-hosts-auto.txt: nfqws bir sitenin engellendiğini
//    — ilk isteğe RST, tekrarlanan istek, başka alan adına yönlendirme — 60 sn'de 3 kez görünce kendisi ekler; kalıcıdır).
//    Engelsiz sitelere dokunulmaz: nfqws boş otomatik listeyi "hiçbiri" sayar (MakeAutolistsNonEmpty). Yeni engellenen siteyi
//    ilk ziyarette birkaç yenileme gerekir, sonra kalıcı olarak açılır. Yanlış öğrenilen site panelden çıkarılır.
//  - Yalnız modem tarafı çıkışında (IFACE_WAN): VPS + DPI kuralında tünel çalışırken trafik wg'den çıkar, Zapret dokunmaz;
//    tünel düşüp "operatörden devam" edilirse trafik modemden DPI ile çıkar (işaret aynı kalır, siteler kullanıcı listesinde).
//  - Hariç liste (exclude) --hostlist-exclude olarak gider ve öğrenmeyi de durdurur.
//  - Yöntem yalnız nfqws (TPWS_ENABLE=0) — nedeni doApply'da. Gece denetimi (runDpiCheck) stratejinin hâlâ işe yaradığını
//    öğrenilen / DPI'lı sitelerle dener.
//  - Otomatik yöntem öğrenme (v2.24.82, kullanıcı kararı: kendiliğinden uygula): yeni öğrenilen site mevcut yöntemle Pi'den
//    3 kez açılamazsa (ya da gece denetiminde açılmazsa) o site için Blockcheck kendiliğinden çalışır (Zapret durdurulmaz),
//    bulunan yöntem YALNIZ o siteye profil olarak eklenir (config'te KLYRIX_SITE_OPT, NFQWS_OPT'un başında), Zapret yeniden
//    başlar ve site denenir; açılmazsa geri alınır. Site başına günde en çok bir otomatik tarama.
//  - Liste dosyaları değişince nfqws onları kendiliğinden yeniden okur; yalnız config değişince (çalışıyorsa) yeniden
//    başlatılır. Özgün config bir kez config.pi5-orig olarak saklanır.
import { applyOverrides, loadOverrides } from './trafficSchedule';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll } from './db';
import { isLinux, detectInterfaces } from './system';
import { ZAPRET_FILTER_MARK } from './routeMarks';
import { recordEvent } from './events';
import { ASN_TOKEN, normalizeCidr } from './ipRanges';
import { LIST_TOKEN, LIST_SOURCES, ensureList, collapsedList, type ListId } from './categoryLists';

const execFileP = promisify(execFile);
const ZAPRET = '/opt/zapret';
const CONFIG = `${ZAPRET}/config`;
const BACKUP = `${ZAPRET}/config.pi5-orig`;
const IPSET = `${ZAPRET}/ipset`;
const USER_LIST = `${IPSET}/zapret-hosts-user.txt`;
const EXCLUDE_LIST = `${IPSET}/zapret-hosts-user-exclude.txt`;
const AUTO_LIST = `${IPSET}/zapret-hosts-auto.txt`;
const ZAPRET_OWN = [`${IPSET}/zapret-hosts.txt.gz`, `${IPSET}/zapret-hosts.txt`];
export const BLOCKCHECK_LOG = path.resolve(__dirname, '../../core/blockcheck.log');
export const BLOCKCHECK_SCRIPT = path.resolve(__dirname, '../../scripts/zapret-blockcheck.sh');
const SITE_STRATEGIES = path.resolve(__dirname, '../../core/zapret-site-strategies.json');
const BEGIN = '# klyrix-begin — Klyrix Gate paneli yönetir (Zapret listeleri + Routing DPI kuralları), elle düzenlemeyin';
const END = '# klyrix-end';
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

// Liste girdisi → Zapret alan adı ("*.site.com" / ".site.com" → "site.com": Zapret alt alan adlarını kendisi kapsar).
// IP aralığı belirteçleri (@asn, CIDR) Zapret listesine girmez.
export function cleanDpiDomain(raw: unknown): string | null {
  const d = String(raw ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
  if (!d || ASN_TOKEN.test(d) || normalizeCidr(d)) return null;
  return DOMAIN.test(d) ? d : null;
}

// DPI'ı kullanan kurallar. hostlist: atlatmanın her zaman uygulanacağı siteler (Zapret'in kullanıcı listesi) — DPI'ı açık
// tüm kuralların alan adları (VPS + DPI dahil: tünel düşünce kullanılır), DPI'lı hazır listeler, ek siteler. Arayüz için:
// fromRouting (çıkışı ISP olan DPI kurallarının alan adları), fromLists (hazır listeler, yalnız sayı), manual (ek siteler),
// dpiRules / vpsDpiRules (kural sayıları).
export async function collectDpiDomains(): Promise<{ hostlist: string[]; exclude: string[]; manual: string[]; fromRouting: string[];
  fromLists: { id: ListId; label: string; count: number }[]; dpiRules: number; vpsDpiRules: number }> {
  const zap = await dbAll('SELECT list_type, domain FROM zapret_domains WHERE enabled = 1') as any[];
  // Trafik Zamanlayıcı'nın etkin penceresi kuralın DPI'ını / çıkışını değiştirebilir (routing motoruyla aynı: trafficSchedule.ts)
  const apps = applyOverrides(await dbAll("SELECT id, domains, exit_node, dpi_bypass FROM traffic_routing WHERE enabled = 1 AND domains != ''") as any[], await loadOverrides())
    .filter(r => Number(r.dpi_bypass) === 1);
  const doms = await dbAll("SELECT domain, exit_node, redirect_url FROM domain_routing WHERE enabled = 1 AND dpi_bypass = 1") as any[];
  const isp = (e: unknown) => !e || e === 'isp';
  const hostlist = new Set<string>(), fromRouting = new Set<string>();
  const listIds = new Set<ListId>();
  let dpiRules = 0, vpsDpiRules = 0;
  for (const r of apps) {
    dpiRules++;
    if (!isp(r.exit_node)) vpsDpiRules++;
    for (const d of String(r.domains || '').split(',')) {
      const lt = LIST_TOKEN.exec(d.trim());
      if (lt) { listIds.add(lt[1] as ListId); continue; }
      const c = cleanDpiDomain(d);
      if (!c) continue;
      hostlist.add(c);
      if (isp(r.exit_node)) fromRouting.add(c);
    }
  }
  for (const r of doms) {
    if (r.redirect_url) continue;
    dpiRules++;
    if (!isp(r.exit_node)) vpsDpiRules++;
    const c = cleanDpiDomain(r.domain);
    if (!c) continue;
    hostlist.add(c);
    if (isp(r.exit_node)) fromRouting.add(c);
  }
  const fromLists: { id: ListId; label: string; count: number }[] = [];
  for (const id of listIds) {
    await ensureList(id, Infinity);
    let n = 0;
    for (const d of collapsedList(id)) { const c = cleanDpiDomain(d); if (c) { hostlist.add(c); n++; } }
    fromLists.push({ id, label: LIST_SOURCES[id].label, count: n });
  }
  const exclude = new Set<string>(), manual = new Set<string>();
  for (const r of zap) {
    const c = cleanDpiDomain(r.domain);
    if (!c) continue;
    if (r.list_type === 'exclude') exclude.add(c);
    else { manual.add(c); hostlist.add(c); }
  }
  return { hostlist: [...hostlist].sort(), exclude: [...exclude].sort(), manual: [...manual].sort(), fromRouting: [...fromRouting].sort(),
    fromLists, dpiRules, vpsDpiRules };
}

// Dosyadaki panel bölümünü yeniler (dışındaki satırlar korunur). Değiştiyse true.
function writeManagedBlock(file: string, entries: string[]): boolean {
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* dosya yok */ }
  const lines = cur.split('\n');
  const b = lines.indexOf(BEGIN);
  const e = lines.indexOf(END);
  const outside = b >= 0 && e > b ? [...lines.slice(0, b), ...lines.slice(e + 1)] : lines;
  const rest = outside.join('\n').replace(/\n+$/, '');
  const next = (rest ? `${rest}\n` : '') + [BEGIN, ...entries, END].join('\n') + '\n';
  if (next === cur) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next, { mode: 0o644 });
  fs.renameSync(tmp, file);
  return true;
}

// Dosyadaki etkin (yorum/boş olmayan) satır sayısı.
function countEntries(file: string): number {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length; } catch { return 0; }
}

const configValue = (txt: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(txt)?.[1]?.replace(/^"|"$/g, '') ?? '';
const nfqwsStrategy = (txt: string) => /^NFQWS_OPT="([\s\S]*?)"/m.exec(txt)?.[1].trim() || '';
// NFQWS_OPT'taki --new ile ayrılmış bölümlerden <HOSTLIST>/<HOSTLIST_NOAUTO> içermeyenlerin sayısı: o bölüm listeye
// bakmaz — öğrenme ev ağının tüm web trafiğini nfqws'e verdiği için o satır TÜM web trafiğine uygulanır.
const unlistedStrategyLines = (txt: string) =>
  nfqwsStrategy(txt).split(/\s--new(?:\s|$)/).filter(s => s.trim() && !s.includes('<HOSTLIST')).length;
function setConfigKeys(txt: string, kv: Record<string, string>): string {
  let out = txt;
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out.replace(/\n*$/, '\n')}${k}=${v}\n`;
  }
  return out;
}

const serviceActive = async () =>
  (await execFileP('systemctl', ['is-active', 'zapret'], { timeout: 5000 }).then(r => r.stdout.trim(), e => String(e?.stdout || '').trim())) === 'active';

export interface ZapretApplyResult {
  ok: boolean; installed: boolean; dpiRules: number; manual: number; exclude: number; fromRouting: number; vpsDpiRules: number; learned: number;
  methodEnabled: boolean; restarted: boolean; warnings: string[]; error?: string; at: number;
}
let lastApply: ZapretApplyResult | null = null;
let applying: Promise<ZapretApplyResult> | null = null;

export function applyZapret(): Promise<ZapretApplyResult> {
  if (applying) return applying.then(() => applyZapret());
  applying = doApply().finally(() => { applying = null; });
  return applying;
}

async function doApply(): Promise<ZapretApplyResult> {
  const res: ZapretApplyResult = {
    ok: false, installed: false, dpiRules: 0, manual: 0, exclude: 0, fromRouting: 0, vpsDpiRules: 0, learned: 0,
    methodEnabled: false, restarted: false, warnings: [], at: Date.now(),
  };
  try {
    if (!isLinux || !fs.existsSync(CONFIG)) {
      res.ok = true;
      res.warnings.push('Zapret bu cihazda kurulu değil');
      return res;
    }
    res.installed = true;
    // Eksik kurulumda da liste ve ayarlar yazılır (kurulum tamamlanınca hazır olsunlar); durum uyarıda söylenir.
    const issue = zapretInstallIssue();
    if (issue) res.warnings.push(issue);
    const { hostlist, exclude, manual, fromRouting, dpiRules, vpsDpiRules } = await collectDpiDomains();
    Object.assign(res, { dpiRules, manual: manual.length, exclude: exclude.length, fromRouting: fromRouting.length, vpsDpiRules,
      learned: listAutoHosts().length });
    writeManagedBlock(USER_LIST, hostlist);
    writeManagedBlock(EXCLUDE_LIST, exclude);
    // find_hostlists .gz'yi tercih eder: varsa panelin yazdığı .txt okunmaz.
    if (fs.existsSync(`${USER_LIST}.gz`)) res.warnings.push('zapret-hosts-user.txt.gz var: panelin listesi (DPI kuralları, ek siteler) okunmuyor — dosyayı silin');
    const ownList = ZAPRET_OWN.find(f => fs.existsSync(f));
    if (ownList) res.warnings.push(`Zapret'in kendi listesi de etkin (${path.basename(ownList)}): içindeki sitelere de atlatma uygulanır`);

    const wan = (await detectInterfaces().catch(() => null))?.wan || 'eth0';
    const cur = fs.readFileSync(CONFIG, 'utf8');
    const loose = unlistedStrategyLines(cur);
    if (loose) res.warnings.push(`Strateji satırlarından ${loose} tanesinde <HOSTLIST> yok — o satır engelsiz sitelere de, yani tüm web trafiğine uygulanır`);
    if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, cur, { mode: 0o644 });
    // Yalnız nfqws: paketleri modem çıkışında işler, VPS tüneline giren trafiğe dokunmaz. tpws web trafiğini Pi'deki
    // vekile yönlendirir; bağlantı Pi'den yeniden açıldığı için VPS yönlendirme işareti (fwmark) kaybolur.
    // Öğrenme hep açık (NFQWS_ENABLE=1): atlatma yalnız listedeki / öğrenilen sitelere. FILTER_MARK aynı yazımda:
    // süzgeçsiz nfqws modemden çıkan her şeyi (dışarıdan gelen bağlantılar dahil) görürdü.
    const next = setConfigKeys(cur, {
      NFQWS_ENABLE: '1',
      TPWS_ENABLE: '0',
      MODE_FILTER: 'autohostlist',
      FILTER_MARK: `0x${ZAPRET_FILTER_MARK.toString(16)}`,
      IFACE_WAN: wan,
    });
    // Site başına öğrenilmiş yöntemler (hariç tutulan siteler atlanır)
    const ex = new Set(exclude);
    const sites = Object.fromEntries(Object.entries(readSiteStrategies()).filter(([d]) => !ex.has(d)));
    const withSites = applySiteOptToConfig(next, buildSiteOpt(sites));
    if (withSites === null) res.warnings.push('config\'te NFQWS_OPT bulunamadı: siteye özel yöntemler uygulanamıyor');
    const finalCfg = withSites ?? next;
    res.methodEnabled = true;
    if (finalCfg !== cur) {
      const tmp = `${CONFIG}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, finalCfg, { mode: 0o644 });
      fs.renameSync(tmp, CONFIG);
      if (await serviceActive()) {
        await execFileP('systemctl', ['restart', 'zapret'], { timeout: 60000 });
        res.restarted = true;
      }
    }
    res.ok = true;
  } catch (e: any) {
    res.error = String(e?.stderr || e?.message || e).trim().slice(0, 300);
  } finally {
    res.at = Date.now();
    lastApply = res;
  }
  return res;
}

export async function zapretStatus() {
  if (!zapretInstalled()) return { installed: false, lastApply };
  const txt = fs.readFileSync(CONFIG, 'utf8');
  const strategy = nfqwsStrategy(txt);
  const procs = await execFileP('pgrep', ['-a', '-f', 'nfqws|tpws'], { timeout: 5000 }).then(r => r.stdout.trim().split('\n').filter(Boolean), () => []);
  const bcActive = await blockcheckRunning();
  let bcLog = '';
  try { bcLog = fs.readFileSync(BLOCKCHECK_LOG, 'utf8').split('\n').slice(-80).join('\n'); } catch { /* henüz yok */ }
  const { fromRouting, fromLists, manual, dpiRules, vpsDpiRules } = await collectDpiDomains();
  const learned = listAutoHosts();
  return {
    installed: true,
    installIssue: zapretInstallIssue(),
    service: await serviceActive(),
    processes: procs.length,
    nfqws: configValue(txt, 'NFQWS_ENABLE') === '1',
    tpws: configValue(txt, 'TPWS_ENABLE') === '1',
    modeFilter: configValue(txt, 'MODE_FILTER'),
    filterMark: configValue(txt, 'FILTER_MARK'),
    iface: configValue(txt, 'IFACE_WAN'),
    strategy,
    unlistedLines: unlistedStrategyLines(txt),
    dpiRules,
    vpsDpiRules,
    manualEntries: manual.length,
    excludeEntries: countEntries(EXCLUDE_LIST),
    learned: learned.slice(-500).reverse(), // en yeni önce
    learnedCount: learned.length,
    lastCheck,
    siteStrategies: Object.entries(readSiteStrategies()).map(([domain, v]) => ({ domain, ...v })),
    autoScan: { scanning, queue: scanQueue.map(q => q.domain), last: lastScanResult },
    fromRouting,
    fromLists,
    zapretOwnList: ZAPRET_OWN.some(f => fs.existsSync(f)),
    blockcheck: { running: bcActive, log: bcLog },
    lastApply,
  };
}

export const blockcheckRunning = async () =>
  (await execFileP('systemctl', ['is-active', 'pi5-blockcheck'], { timeout: 5000 })
    .then(r => r.stdout.trim(), e => String(e?.stdout || '').trim())) === 'active';

export const zapretInstalled = () => isLinux && fs.existsSync(CONFIG);

// Klasör / config var ama Zapret çalıştırılamıyorsa nedeni (yoksa null). Eskiden yalnız config'e bakılıyordu: install.sh'in
// etkileşimli kurulumu yarıda kaldığında panel "kurulu" diyor, servis "Unit zapret.service does not exist" ile düşüyordu.
// Eksik parçayı panel güncellemesi kurar (scripts/zapret-install.sh, post-update).
const NFQWS = `${ZAPRET}/nfq/nfqws`;
const UNIT_FILES = ['/lib/systemd/system/zapret.service', '/usr/lib/systemd/system/zapret.service', '/etc/systemd/system/zapret.service'];
export function zapretInstallIssue(): string | null {
  if (!zapretInstalled()) return null;
  const missing: string[] = [];
  try { fs.accessSync(NFQWS, fs.constants.X_OK); } catch { missing.push('nfqws programı'); }
  if (!UNIT_FILES.some(f => fs.existsSync(f))) missing.push('servis birimi');
  return missing.length ? `Zapret eksik kurulu (${missing.join(' ve ')} yok) — Ayarlar → Güncelle Zapret'i kurar` : null;
}

// Routing kartları için kısa durum: DPI kuralı açık ama Zapret çalışmıyorsa kartta uyarı gösterilir.
export async function zapretBrief(): Promise<{ installed: boolean; issue: string | null; active: boolean }> {
  if (!zapretInstalled()) return { installed: false, issue: null, active: false };
  return { installed: true, issue: zapretInstallIssue(), active: await serviceActive() };
}

export async function startBlockcheck(domain: string, mode: 'manual' | 'auto' = 'manual'): Promise<void> {
  await execFileP('systemd-run', ['--quiet', '--collect', '--unit=pi5-blockcheck', '/bin/bash', BLOCKCHECK_SCRIPT, domain, BLOCKCHECK_LOG, mode],
    { timeout: 10000 });
}

// ─── Öğrenilen siteler (otomatik liste) ───
// nfqws dosyaya kendisi ekler (tpws kullanıcısıyla çalışır); panel yalnız okur ve satır çıkarır. Dosya YERİNDE yazılır:
// geçici dosya + rename sahipliği root yapar ve nfqws bir daha ekleyemezdi. nfqws değişiklik zamanından yeniden okur.
export function listAutoHosts(): string[] {
  try {
    return fs.readFileSync(AUTO_LIST, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}
export function removeAutoHost(domain: string): boolean {
  const d = String(domain || '').trim().toLowerCase();
  let cur = '';
  try { cur = fs.readFileSync(AUTO_LIST, 'utf8'); } catch { return false; }
  const lines = cur.split('\n');
  const kept = lines.filter(l => l.trim().toLowerCase() !== d);
  if (kept.length === lines.length) return false;
  fs.writeFileSync(AUTO_LIST, kept.join('\n'));
  return true;
}

// ─── Gece denetimi: strateji hâlâ işe yarıyor mu? ───
// Engelli olduğu kanıtlanmış siteler (öğrenilenlerin en yenileri) ve DPI kurallarının sitelerinden en çok 4'ü Pi'den açılmaya
// çalışılır: Pi'nin kendi trafiği de öğrenme işaretini alır, bu sitelere atlatma uygulanır. Yanıt gelmezse (zaman aşımı,
// bağlantı sıfırlandı) operatör yöntemini değiştirmiş olabilir → Bildirimler'e yazılır, Blockcheck önerilir. Başarı sessiz.
export type DpiCheck = { at: number; skipped?: string; results: { domain: string; ok: boolean; detail: string }[] };
// Denetimin saati (yerel): index.ts'teki 10 dakikalık zamanlayıcı bu saatte günde bir kez çalıştırır; Ağ Ajandası (agenda.ts)
// da buradan okur — gösterim kodla ayrışmasın.
export const ZAPRET_CHECK_HOUR = 4;
let lastCheck: DpiCheck | null = null;
let checking: Promise<DpiCheck> | null = null;
export function runDpiCheck(): Promise<DpiCheck> {
  if (!checking) checking = doDpiCheck().finally(() => { checking = null; });
  return checking;
}
async function doDpiCheck(): Promise<DpiCheck> {
  const out: DpiCheck = { at: Date.now(), results: [] };
  try {
    if (!zapretInstalled() || zapretInstallIssue()) { out.skipped = 'Zapret kurulu değil'; return out; }
    if (!(await serviceActive())) { out.skipped = 'Zapret kapalı'; return out; }
    const { fromRouting } = await collectDpiDomains();
    const domains = [...new Set([...listAutoHosts().reverse().slice(0, 3), ...fromRouting])].slice(0, 4);
    if (!domains.length) { out.skipped = 'denenecek site yok (öğrenilen ya da DPI kuralı yok)'; return out; }
    for (const domain of domains) {
      const r = await execFileP('curl', ['-sS', '-o', '/dev/null', '-m', '15', '-w', '%{http_code}', `https://${domain}/`], { timeout: 20000 })
        .then(x => ({ ok: x.stdout.trim() !== '000', detail: `HTTP ${x.stdout.trim()}` }),
          (e: any) => ({ ok: false, detail: String(e?.stderr || e?.message || e).trim().split('\n')[0].replace(/^curl: \(\d+\) /, '').slice(0, 120) }));
      out.results.push({ domain, ...r });
    }
    const failed = out.results.filter(r => !r.ok);
    if (failed.length) {
      await recordEvent('zapret', `DPI denetimi: ${failed.map(f => f.domain).join(', ')} açılamadı — operatör engelleme yöntemini `
        + `değiştirmiş olabilir; yeni yöntem kendiliğinden aranıyor (Blockcheck)`, 'warning');
      for (const f of failed) enqueueScan(f.domain, 'gece denetimi');
    }
  } catch (e: any) {
    out.skipped = `denetlenemedi: ${String(e?.message || e).slice(0, 120)}`;
  } finally {
    out.at = Date.now();
    lastCheck = out;
  }
  return out;
}

// ─── Siteye özel yöntemler (otomatik Blockcheck'in bulduğu) ───
type SiteStrategy = { strategy: string; at: number };
export function readSiteStrategies(): Record<string, SiteStrategy> {
  try {
    const raw = JSON.parse(fs.readFileSync(SITE_STRATEGIES, 'utf8'));
    const out: Record<string, SiteStrategy> = {};
    for (const [d, v] of Object.entries(raw || {})) {
      const st = (v as SiteStrategy)?.strategy;
      if (cleanDpiDomain(d) === d && typeof st === 'string' && SAFE_STRATEGY.test(st)) out[d] = { strategy: st, at: Number((v as SiteStrategy).at) || 0 };
    }
    return out;
  } catch { return {}; }
}
function writeSiteStrategies(map: Record<string, SiteStrategy>) {
  const tmp = `${SITE_STRATEGIES}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, SITE_STRATEGIES);
}
export function removeSiteStrategy(domain: string): boolean {
  const map = readSiteStrategies();
  if (!map[domain]) return false;
  delete map[domain];
  writeSiteStrategies(map);
  return true;
}

// config root olarak kaynaklanan bir kabuk dosyası: strateji yalnız "--seçenek[=değer]" belirteçlerinden oluşabilir; değerde
// tırnak, $, `, \, ;, &, |, <, >, (, ), boşluk yok (komut sızamaz).
export const SAFE_STRATEGY = /^--[a-z0-9][a-z0-9-]*(=[A-Za-z0-9_.,:@+%/=!^~-]*)?( --[a-z0-9][a-z0-9-]*(=[A-Za-z0-9_.,:@+%/=!^~-]*)?)*$/;

// Blockcheck günlüğünün "* SUMMARY" bölümünden bu site için çalışan ilk HTTPS (TLS 1.2) nfqws stratejisi.
// Satır biçimi (blockcheck.sh report_append): "curl_test_https_tls12 ipv4 discord.com : nfqws --dpi-desync=..."
export function parseBlockcheckSummary(log: string, domain: string): string | null {
  const at = log.lastIndexOf('* SUMMARY');
  if (at < 0) return null;
  for (const line of log.slice(at).split('\n')) {
    const m = /^curl_test_https_tls12 ipv4 (\S+) : nfqws (.+)$/.exec(line.trim());
    if (!m || m[1] !== domain || / not working$/.test(m[2])) continue;
    const st = m[2].trim().replace(/\s+/g, ' ');
    if (SAFE_STRATEGY.test(st)) return st;
  }
  return null;
}

// Aynı stratejili siteler tek profilde: "--filter-tcp=443 --hostlist-domains=a.com,b.com <strateji> --new". Profiller
// NFQWS_OPT'un başında olduğundan ilk eşleşen bunlardır; listeli öbür siteler genel profille sürer.
export function buildSiteOpt(sites: Record<string, SiteStrategy>): string {
  const by = new Map<string, string[]>();
  for (const [d, v] of Object.entries(sites).sort()) by.set(v.strategy, [...(by.get(v.strategy) || []), d]);
  return [...by].map(([st, ds]) => `--filter-tcp=443 --hostlist-domains=${ds.join(',')} ${st} --new`).join(' ');
}

// config'te NFQWS_OPT'un hemen önüne KLYRIX_SITE_OPT="..." satırı (kabuk sırayla okur: önce tanımlanmalı) ve NFQWS_OPT'un
// başına $KLYRIX_SITE_OPT. NFQWS_OPT yoksa null.
export function applySiteOptToConfig(cfg: string, opt: string): string | null {
  const lines = cfg.split('\n').filter(l => !/^KLYRIX_SITE_OPT=/.test(l));
  const i = lines.findIndex(l => /^NFQWS_OPT="/.test(l));
  if (i < 0) return null;
  const rest = lines[i].slice('NFQWS_OPT="'.length);
  if (!rest.startsWith('$KLYRIX_SITE_OPT')) lines[i] = `NFQWS_OPT="$KLYRIX_SITE_OPT${rest && !rest.startsWith('"') ? ' ' : ''}${rest}`;
  lines.splice(i, 0, `KLYRIX_SITE_OPT="${opt}"`);
  return lines.join('\n');
}

// ─── Otomatik yöntem öğrenme ───
const SCAN_COOLDOWN_MS = 24 * 3600 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const known = new Set<string>();
let watchReady = false;
const lastScanAt = new Map<string, number>();
const scanQueue: { domain: string; reason: string }[] = [];
let scanning: string | null = null;
let lastScanResult: { domain: string; at: number; ok: boolean; strategy?: string; detail: string } | null = null;

// Pi'den siteyi aç (Pi'nin kendi trafiği de öğrenme işaretini alır → listedeki siteye atlatma uygulanır).
async function probe(domain: string): Promise<boolean> {
  return execFileP('curl', ['-sS', '-o', '/dev/null', '-m', '10', '-w', '%{http_code}', `https://${domain}/`], { timeout: 15000 })
    .then(x => x.stdout.trim() !== '000', () => false);
}
async function probe3(domain: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (await probe(domain)) return true;
    if (i < 2) await sleep(5000);
  }
  return false;
}

// Otomatik listeyi izler (dakikada bir): açılışta var olanlar bilinir sayılır; yeni eklenen site 15 sn sonra (nfqws listeyi
// yeniden okusun) mevcut yöntemle denenir, açılmazsa taranır.
export function startAutoMethod(): void {
  if (!isLinux) return;
  const tick = async () => {
    if (!zapretInstalled() || zapretInstallIssue()) return;
    const list = listAutoHosts();
    if (!watchReady) { list.forEach(h => known.add(h)); watchReady = true; return; }
    for (const h of list) {
      if (known.has(h)) continue;
      known.add(h);
      setTimeout(() => {
        void (async () => {
          if (!(await serviceActive())) return;
          if (!(await probe3(h))) enqueueScan(h, 'yeni öğrenilen site mevcut yöntemle açılmadı');
        })();
      }, 15000);
    }
  };
  setTimeout(() => void tick(), 30000);
  setInterval(() => void tick(), 60000);
}

export function enqueueScan(domain: string, reason: string): void {
  const d = cleanDpiDomain(domain);
  if (!d) return;
  if (Date.now() - (lastScanAt.get(d) || 0) < SCAN_COOLDOWN_MS || scanning === d || scanQueue.some(q => q.domain === d)) return;
  scanQueue.push({ domain: d, reason });
  void drainScans();
}
async function drainScans() {
  if (scanning) return;
  while (scanQueue.length) {
    const { domain, reason } = scanQueue.shift()!;
    scanning = domain;
    lastScanAt.set(domain, Date.now());
    try {
      lastScanResult = await autoScan(domain, reason);
    } catch (e: any) {
      lastScanResult = { domain, at: Date.now(), ok: false, detail: `tarama hatası: ${String(e?.message || e).slice(0, 160)}` };
    }
    scanning = null;
  }
}
async function waitBlockcheck(maxMs: number) {
  const until = Date.now() + maxMs;
  while (Date.now() < until && await blockcheckRunning()) await sleep(10000);
}
async function autoScan(domain: string, reason: string) {
  const done = (ok: boolean, detail: string, strategy?: string) => ({ domain, at: Date.now(), ok, detail, strategy });
  await waitBlockcheck(30 * 60 * 1000); // elle başlatılan bitsin
  await startBlockcheck(domain, 'auto');
  await sleep(5000);
  await waitBlockcheck(30 * 60 * 1000);
  let log = '';
  try { log = fs.readFileSync(BLOCKCHECK_LOG, 'utf8'); } catch { /* yok */ }
  const strategy = parseBlockcheckSummary(log, domain);
  if (!log.includes('* SUMMARY')) {
    // Tarama yarıda kaldı (eksik araç, ağ yok, durduruldu): engel hakkında bir şey söylemez; son anlamlı satır gösterilir.
    const why = log.split('\n').map(l => l.trim()).filter(l => l && !/^(==|Zapret muafiyeti)/.test(l)).pop() || 'günlük boş';
    await recordEvent('zapret', `${domain} için Blockcheck tamamlanamadı (${reason}): ${why.slice(0, 200)}`, 'warning');
    return done(false, `Blockcheck tamamlanamadı: ${why.slice(0, 120)}`);
  }
  if (!strategy) {
    await recordEvent('zapret', `${domain} için çalışan DPI yöntemi bulunamadı (${reason}). Engel IP ya da DNS tabanlı olabilir — `
      + `bu siteyi Routing'de VPS çıkışına yönlendirin`, 'warning');
    return done(false, 'çalışan yöntem bulunamadı (IP / DNS engeli olabilir)');
  }
  const map = readSiteStrategies();
  const prev = map[domain];
  map[domain] = { strategy, at: Date.now() };
  writeSiteStrategies(map);
  const applied = await applyZapret();
  await sleep(3000);
  if (applied.ok && await probe3(domain)) {
    await recordEvent('zapret', `${domain} için yeni DPI yöntemi öğrenildi ve uygulandı (${reason}): nfqws ${strategy}`);
    return done(true, 'yeni yöntem uygulandı, site açılıyor', strategy);
  }
  if (prev) map[domain] = prev; else delete map[domain];
  writeSiteStrategies(map);
  await applyZapret();
  await recordEvent('zapret', `${domain}: Blockcheck'in bulduğu yöntem (${strategy}) uygulandı ama site yine açılmadı — geri alındı`, 'warning');
  return done(false, 'bulunan yöntem işe yaramadı, geri alındı', strategy);
}

// Zapret (DPI atlatma): panel ayarları Zapret'e gerçekten uygulanır.
//  - v2.24.75'ten beri Zapret LİSTEYE değil Routing'in işaretine bakar: DPI'ı açık kuralın trafiği PI5_ROUTING'de DPI
//    bitini (0x4000, routeMarks.ts) alır; config'te FILTER_MARK=0x4000 → nfqws yalnız bu bitli paketleri işler. Site
//    listesi gerekmez; IP aralıklı kurallar (ör. WhatsApp aramaları) da kapsanır. Eskiden yalnız alan adı listesine
//    bakılıyordu: DPI'ı açan kullanıcıdan liste bekleniyor, IP aralıkları ve VPS kuralları hiç kapsanmıyordu.
//  - Yalnız modem tarafı çıkışında (IFACE_WAN): VPS + DPI kuralında tünel çalışırken trafik wg'den çıkar, Zapret dokunmaz;
//    tünel düşüp "operatörden devam" edilirse trafik modemden DPI ile çıkar (işaret aynı kalır).
//  - Zapret sayfasının ek siteleri (zapret_domains hostlist) Routing'de ISP + DPI alan adı gibi işaretlenir (index.ts).
//    Hariç liste (exclude) nfqws'e --hostlist-exclude olarak gider (MODE_FILTER=hostlist). Kullanıcı listesi dosyası
//    (zapret-hosts-user.txt) BULUNMAZ: varsa nfqws işaretli trafikte de yalnız ondaki sitelere çalışırdı.
//  - Yöntem yalnız nfqws (TPWS_ENABLE=0) — nedeni doApply'da. DPI kuralı yoksa NFQWS_ENABLE=0.
//  - Liste dosyaları değişince nfqws onları kendiliğinden yeniden okur; yalnız config değişince (çalışıyorsa) yeniden
//    başlatılır. Özgün config bir kez config.pi5-orig olarak saklanır.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll } from './db';
import { isLinux, detectInterfaces } from './system';
import { DPI_MARK_BIT } from './routeMarks';
import { ASN_TOKEN, normalizeCidr } from './ipRanges';
import { LIST_TOKEN, LIST_SOURCES, ensureList, collapsedList, type ListId } from './categoryLists';

const execFileP = promisify(execFile);
const ZAPRET = '/opt/zapret';
const CONFIG = `${ZAPRET}/config`;
const BACKUP = `${ZAPRET}/config.pi5-orig`;
const IPSET = `${ZAPRET}/ipset`;
const USER_LIST = `${IPSET}/zapret-hosts-user.txt`;
const EXCLUDE_LIST = `${IPSET}/zapret-hosts-user-exclude.txt`;
const ZAPRET_OWN = [`${IPSET}/zapret-hosts.txt.gz`, `${IPSET}/zapret-hosts.txt`];
export const BLOCKCHECK_LOG = path.resolve(__dirname, '../../core/blockcheck.log');
export const BLOCKCHECK_SCRIPT = path.resolve(__dirname, '../../scripts/zapret-blockcheck.sh');
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

// DPI'ı kullanan kurallar (arayüz ve NFQWS_ENABLE için). fromRouting: çıkışı ISP olan DPI kurallarının alan adları;
// fromLists: hazır listeli ISP + DPI satırları (Yetişkin / Kumar — on binlerce ad, yalnız sayısı); manual: Zapret
// sayfasının ek siteleri; dpiRules: DPI'ı açık tüm Routing kuralları (VPS + DPI dahil — tünel düşünce kullanılır),
// vpsDpiRules: bunların VPS çıkışlı olanları.
export async function collectDpiDomains(): Promise<{ exclude: string[]; manual: string[]; fromRouting: string[];
  fromLists: { id: ListId; label: string; count: number }[]; dpiRules: number; vpsDpiRules: number }> {
  const zap = await dbAll('SELECT list_type, domain FROM zapret_domains WHERE enabled = 1') as any[];
  const apps = await dbAll("SELECT domains, exit_node FROM traffic_routing WHERE enabled = 1 AND dpi_bypass = 1 AND domains != ''") as any[];
  const doms = await dbAll("SELECT domain, exit_node, redirect_url FROM domain_routing WHERE enabled = 1 AND dpi_bypass = 1") as any[];
  const isp = (e: unknown) => !e || e === 'isp';
  const fromRouting = new Set<string>();
  const listIds = new Set<ListId>();
  let dpiRules = 0, vpsDpiRules = 0;
  for (const r of apps) {
    dpiRules++;
    if (!isp(r.exit_node)) { vpsDpiRules++; continue; }
    for (const d of String(r.domains || '').split(',')) {
      const lt = LIST_TOKEN.exec(d.trim());
      if (lt) { listIds.add(lt[1] as ListId); continue; }
      const c = cleanDpiDomain(d);
      if (c) fromRouting.add(c);
    }
  }
  for (const r of doms) {
    if (r.redirect_url) continue;
    dpiRules++;
    if (!isp(r.exit_node)) { vpsDpiRules++; continue; }
    const c = cleanDpiDomain(r.domain);
    if (c) fromRouting.add(c);
  }
  const fromLists: { id: ListId; label: string; count: number }[] = [];
  for (const id of listIds) {
    await ensureList(id, Infinity);
    fromLists.push({ id, label: LIST_SOURCES[id].label, count: collapsedList(id).length });
  }
  const exclude = new Set<string>(), manual = new Set<string>();
  for (const r of zap) {
    const c = cleanDpiDomain(r.domain);
    if (c) (r.list_type === 'exclude' ? exclude : manual).add(c);
  }
  return { exclude: [...exclude].sort(), manual: [...manual].sort(), fromRouting: [...fromRouting].sort(), fromLists, dpiRules, vpsDpiRules };
}

// Kullanıcı listesi (zapret-hosts-user.txt[.gz]) varsa nfqws işaretli trafikte de yalnız ondaki sitelere çalışır. Panelin
// eski bölümü (≤ v2.24.74 Routing DPI alan adlarını buraya yazıyordu) ya da boş dosya silinir; elle eklenmiş satır varsa
// dosyaya dokunulmaz, uyarı döner.
function retireUserList(): string | null {
  if (fs.existsSync(`${USER_LIST}.gz`)) return 'zapret-hosts-user.txt.gz var: DPI yalnız o listedeki sitelere uygulanır (dosyayı silin)';
  if (!fs.existsSync(USER_LIST)) return null;
  const lines = fs.readFileSync(USER_LIST, 'utf8').split('\n');
  const b = lines.indexOf(BEGIN);
  const e = lines.indexOf(END);
  const outside = b >= 0 && e > b ? [...lines.slice(0, b), ...lines.slice(e + 1)] : lines;
  const foreign = outside.filter(l => l.trim() && !l.trim().startsWith('#')).length;
  if (foreign) return `zapret-hosts-user.txt'te elle eklenmiş ${foreign} satır var: DPI yalnız o sitelere uygulanır (satırları silin)`;
  fs.unlinkSync(USER_LIST);
  return null;
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
// NFQWS_OPT'taki --new ile ayrılmış bölümlerden <HOSTLIST>/<HOSTLIST_NOAUTO> içermeyenlerin sayısı: o bölümde Hariç
// Tutulanlar (--hostlist-exclude) uygulanmaz. Kapsam yine işaretle sınırlı (FILTER_MARK).
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
  ok: boolean; installed: boolean; dpiRules: number; manual: number; exclude: number; fromRouting: number; vpsDpiRules: number;
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
    ok: false, installed: false, dpiRules: 0, manual: 0, exclude: 0, fromRouting: 0, vpsDpiRules: 0,
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
    const { exclude, manual, fromRouting, dpiRules, vpsDpiRules } = await collectDpiDomains();
    Object.assign(res, { dpiRules, manual: manual.length, exclude: exclude.length, fromRouting: fromRouting.length, vpsDpiRules });
    writeManagedBlock(EXCLUDE_LIST, exclude);
    const userList = retireUserList();
    if (userList) res.warnings.push(userList);
    const ownList = ZAPRET_OWN.find(f => fs.existsSync(f));
    if (ownList) res.warnings.push(`Zapret'in kendi listesi (${path.basename(ownList)}) etkin: DPI yalnız o listedeki sitelere uygulanır`);

    // Kapsamı işaret belirler (FILTER_MARK): DPI'ı açık kural ya da ek site yoksa yöntem kapalı.
    const on = dpiRules + manual.length > 0;
    const wan = (await detectInterfaces().catch(() => null))?.wan || 'eth0';

    const cur = fs.readFileSync(CONFIG, 'utf8');
    const loose = unlistedStrategyLines(cur);
    if (loose) res.warnings.push(`Strateji satırlarından ${loose} tanesinde <HOSTLIST> yok — o satırda Hariç Tutulanlar uygulanmaz`);
    if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, cur, { mode: 0o644 });
    // Yalnız nfqws: paketleri modem çıkışında işler, VPS tüneline giren trafiğe dokunmaz. tpws web trafiğini Pi'deki
    // vekile yönlendirir; bağlantı Pi'den yeniden açıldığı için VPS yönlendirme işareti (fwmark) kaybolur.
    // FILTER_MARK NFQWS_ENABLE ile aynı yazımda: süzgeçsiz nfqws modemden çıkan tüm 80/443 trafiğini işlerdi.
    const next = setConfigKeys(cur, {
      NFQWS_ENABLE: on ? '1' : '0',
      TPWS_ENABLE: '0',
      MODE_FILTER: 'hostlist',
      FILTER_MARK: `0x${DPI_MARK_BIT.toString(16)}`,
      IFACE_WAN: wan,
    });
    res.methodEnabled = on;
    if (next !== cur) {
      const tmp = `${CONFIG}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, next, { mode: 0o644 });
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

export async function startBlockcheck(domain: string): Promise<void> {
  await execFileP('systemd-run', ['--quiet', '--collect', '--unit=pi5-blockcheck', '/bin/bash', BLOCKCHECK_SCRIPT, domain, BLOCKCHECK_LOG],
    { timeout: 10000 });
}

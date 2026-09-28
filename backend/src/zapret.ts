// Zapret (DPI atlatma): panel ayarları Zapret'e gerçekten uygulanır. Eskiden mod, ayarlar ve alan adı listeleri yalnız
// veritabanındaydı; Routing'deki "DPI" anahtarı bir fwmark koyuyordu ama Zapret'i o işarete göre çalıştıran kod yoktu.
//  - Zapret yalnız LİSTEDEKİ alan adlarına (MODE_FILTER=hostlist) ve yalnız modem tarafı çıkışında (IFACE_WAN) çalışır;
//    VPS tüneline giren trafik eth0'a şifreli çıkar, Zapret ona dokunmaz (VPS + DPI kuralında DPI etkisizdir).
//  - Liste = Zapret sayfasının bypass listesi + Routing'de çıkışı ISP olan DPI kurallarının alan adları. Hariç liste ayrı.
//    Zapret'in dosyalarında panelin bölümü işaretlidir (klyrix-begin/end); dosyaya elle eklenmiş satırlar korunur.
//  - GÜVENLİK: Zapret'in belgesine göre "boş liste = liste yok" → boş hostlist ile nfqws TÜM 80/443 trafiğine uygulanır.
//    Etkin toplam liste boşsa yöntem kapalı tutulur (NFQWS_ENABLE=0), servis açık olsa bile.
//  - Yöntem yalnız nfqws (TPWS_ENABLE=0) — nedeni doApply'da.
//  - Liste dosyaları değişince nfqws onları kendiliğinden yeniden okur; yalnız config değişince (çalışıyorsa) yeniden
//    başlatılır. Özgün config bir kez config.pi5-orig olarak saklanır.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll } from './db';
import { isLinux, detectInterfaces } from './system';
import { ASN_TOKEN, normalizeCidr } from './ipRanges';

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

export async function collectDpiDomains(): Promise<{ hostlist: string[]; exclude: string[]; fromRouting: string[]; vpsDpiRules: number }> {
  const zap = await dbAll('SELECT list_type, domain FROM zapret_domains WHERE enabled = 1') as any[];
  const apps = await dbAll("SELECT domains, exit_node FROM traffic_routing WHERE enabled = 1 AND dpi_bypass = 1") as any[];
  const doms = await dbAll("SELECT domain, exit_node, redirect_url FROM domain_routing WHERE enabled = 1 AND dpi_bypass = 1") as any[];
  const isp = (e: unknown) => !e || e === 'isp';
  const fromRouting = new Set<string>();
  let vpsDpiRules = 0;
  for (const r of apps) {
    if (!isp(r.exit_node)) { vpsDpiRules++; continue; }
    for (const d of String(r.domains || '').split(',')) { const c = cleanDpiDomain(d); if (c) fromRouting.add(c); }
  }
  for (const r of doms) {
    if (r.redirect_url) continue;
    if (!isp(r.exit_node)) { vpsDpiRules++; continue; }
    const c = cleanDpiDomain(r.domain);
    if (c) fromRouting.add(c);
  }
  const hostlist = new Set(fromRouting);
  const exclude = new Set<string>();
  for (const r of zap) {
    const c = cleanDpiDomain(r.domain);
    if (c) (r.list_type === 'exclude' ? exclude : hostlist).add(c);
  }
  return { hostlist: [...hostlist].sort(), exclude: [...exclude].sort(), fromRouting: [...fromRouting].sort(), vpsDpiRules };
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
// NFQWS_OPT'taki --new ile ayrılmış bölümlerden listeye (<HOSTLIST>/<HOSTLIST_NOAUTO>) bağlı olmayanların sayısı.
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
  ok: boolean; installed: boolean; hostlist: number; exclude: number; fromRouting: number; vpsDpiRules: number;
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
    ok: false, installed: false, hostlist: 0, exclude: 0, fromRouting: 0, vpsDpiRules: 0,
    methodEnabled: false, restarted: false, warnings: [], at: Date.now(),
  };
  try {
    if (!isLinux || !fs.existsSync(CONFIG)) {
      res.ok = true;
      res.warnings.push('Zapret bu cihazda kurulu değil');
      return res;
    }
    res.installed = true;
    const { hostlist, exclude, fromRouting, vpsDpiRules } = await collectDpiDomains();
    Object.assign(res, { hostlist: hostlist.length, exclude: exclude.length, fromRouting: fromRouting.length, vpsDpiRules });
    writeManagedBlock(USER_LIST, hostlist);
    writeManagedBlock(EXCLUDE_LIST, exclude);

    // Etkin toplam liste: kullanıcı dosyasının tamamı + Zapret'in kendi listesi (varsa)
    const ownList = ZAPRET_OWN.find(f => fs.existsSync(f));
    const includeCount = countEntries(USER_LIST) + (ownList ? (ownList.endsWith('.gz') ? 1 : countEntries(ownList)) : 0);
    if (ownList) res.warnings.push(`Zapret'in kendi listesi de etkin (${path.basename(ownList)})`);

    const on = includeCount > 0;
    if (!on) res.warnings.push('DPI listesi boş: Zapret hiçbir trafiğe dokunmaz (boş liste Zapret\'te "tüm trafik" demektir, bu yüzden yöntem kapalı tutuldu)');
    const wan = (await detectInterfaces().catch(() => null))?.wan || 'eth0';

    const cur = fs.readFileSync(CONFIG, 'utf8');
    const loose = unlistedStrategyLines(cur);
    if (loose) res.warnings.push(`Strateji satırlarından ${loose} tanesi listeye bağlı değil (<HOSTLIST> yok) — o satır tüm trafiğe uygulanır`);
    if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, cur, { mode: 0o644 });
    // Yalnız nfqws: paketleri modem çıkışında işler, VPS tüneline giren trafiğe dokunmaz. tpws web trafiğini Pi'deki
    // vekile yönlendirir; bağlantı Pi'den yeniden açıldığı için VPS yönlendirme işareti (fwmark) kaybolur.
    const next = setConfigKeys(cur, {
      NFQWS_ENABLE: on ? '1' : '0',
      TPWS_ENABLE: '0',
      MODE_FILTER: 'hostlist',
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
  const { fromRouting } = await collectDpiDomains();
  return {
    installed: true,
    service: await serviceActive(),
    processes: procs.length,
    nfqws: configValue(txt, 'NFQWS_ENABLE') === '1',
    tpws: configValue(txt, 'TPWS_ENABLE') === '1',
    modeFilter: configValue(txt, 'MODE_FILTER'),
    iface: configValue(txt, 'IFACE_WAN'),
    strategy,
    unlistedLines: unlistedStrategyLines(txt),
    userEntries: countEntries(USER_LIST),
    excludeEntries: countEntries(EXCLUDE_LIST),
    fromRouting,
    zapretOwnList: ZAPRET_OWN.some(f => fs.existsSync(f)),
    blockcheck: { running: bcActive, log: bcLog },
    lastApply,
  };
}

export const blockcheckRunning = async () =>
  (await execFileP('systemctl', ['is-active', 'pi5-blockcheck'], { timeout: 5000 })
    .then(r => r.stdout.trim(), e => String(e?.stdout || '').trim())) === 'active';

export const zapretInstalled = () => isLinux && fs.existsSync(CONFIG);

export async function startBlockcheck(domain: string): Promise<void> {
  await execFileP('systemd-run', ['--quiet', '--collect', '--unit=pi5-blockcheck', '/bin/bash', BLOCKCHECK_SCRIPT, domain, BLOCKCHECK_LOG],
    { timeout: 10000 });
}

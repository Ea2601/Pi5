// Güvenli arama (SafeSearch) — ağ geneli. Koruma Şablonları sayfası; Okul/Aile şablonunun parçası (templates.ts) ya da tek başına.
// Arama motorunun adları (www.google.com …) Pi-hole'da sağlayıcının kısıtlı sunucusunun adresine yerel kayıt olur: Google Güvenli
// Arama (forcesafesearch.google.com), YouTube Sıkı kısıtlı mod (restrict.youtube.com), Bing (strict.bing.com), DuckDuckGo
// (safe.duckduckgo.com). Hedefin adresleri Unbound'dan (127.0.0.1#5335) çözülür ve her ad için host-record yazılır —
// /etc/dnsmasq.d/09-pi5-safesearch.conf.
//  - CNAME (cname=) BİLEREK yok: aynı ad için ikinci bir CNAME (ör. sonradan Pi-hole'un web arayüzünden eklenen) dnsmasq'ı
//    "duplicate CNAME" ile hiç açtırmaz — tüm ağın DNS'i gider. host-record başka bir kayıtla aynı adda olsa da FTL açılır (gerçek
//    FTL 6.5'te doğrulandı: aynı adda Pi-hole CNAME'i kazanır; Pi-hole Yerel DNS kaydıyla adresler birleşir — çakışma hemen atlanır).
//  - Hedefin IPv6'sı yoksa ad için AAAA '::' yazılır: yalnız A'lı yerel adın AAAA sorgusu yukarı iletilir ve gerçek (kısıtsız)
//    IPv6 adresi dönerdi. Hedefin kendi kaydı ilk satırdır (ters sorgu sağlayıcının adını döner).
//  - Varsayılan KAPALI: ayar yokken dosya yok, DNS bugünküyle aynı. Kapatınca dosya silinir; /etc/dnsmasq.d okumasını
//    (misc.etc_dnsmasq_d) güvenli arama açtırdıysa ve orada yüklenecek başka satır yoksa aynı yeniden başlatmada geri kapatılır.
//  - FTL yeniden başlatması routing'in birleştirilmiş DNS işiyle (system.ts requestDnsRestart): aynı aralık, /etc/dnsmasq.d
//    okumasını açma ve DNS gelmezse dosyaları boşaltan güvenlik ağı (09 DNSMASQ_D_FILES'ta).
//  - Güvenlik ağı dosyaları boşaltırsa güvenli arama ASKIYA alınır: ne DNS öncesi kanca ne gece turu 09'u yeniden yazar (aynı
//    kesinti her yeniden başlatmada tekrarlamasın); kullanıcı «Şimdi uygula» / Aç ile yeniden dener (olay geçmişine uyarı).
//  - Hedef adresler 6 saatte bir yeniden çözülür. Değişmişse dosya yalnız gece 03–06'da yazılır (Pi-hole'u yeniden başlatan
//    liste değişikliği kuralı); gündüz son geçerli kayıt korunur. Başka bir nedenle (Routing) DNS zaten yeniden başlıyorsa yeni
//    adresler o yeniden başlatmaya katılır. Kullanıcının aç / kapat / sağlayıcı değişikliği hemen uygulanır (tek yeniden başlatma).
//  - Çakışma: aynı ad için başka bir yerel kayıt ya da yönlendirme varsa o ad atlanır ve listelenir — kullanıcının kaydı kazanır:
//    Routing → alan adı yönlendirmesi (06) ya da VPS / DPI çıkışı (05 ipset= / server=: dnsmasq yerel yanıtın adresini sete
//    eklemez, trafik VPS / Zapret yerine operatörden çıkardı), Pi-hole Yerel DNS / CNAME kaydı, /etc/hosts, başka bir dnsmasq
//    dosyası. Yeni çıkan çakışma 30 dk'lık turda gece beklenmeden uygulanır (tek yeniden başlatma); kalkan çakışma gece, başka bir
//    DNS yeniden başlatmasında ya da «Şimdi uygula» ile.
//  - Sınırlar: DoH / DoT kullanan, Pi-hole'u kullanmayan ya da IPv6 DNS alan cihaz atlatır (tüm ağda şifreli DNS engeli önerilir;
//    o da yalnız IPv4). Cihaz bazlı değildir. Ayar app_settings.safesearch_config (gizli değil; yedeğe girer, geri yüklemede uygulanır).
import fs from 'fs';
import net from 'net';
import { promises as dnsPromises } from 'dns';
import { dbAll, dbGet, dbRun } from './db';
import { recordEvent, recordEventOnce } from './events';
import {
  isLinux, SAFESEARCH_DNSMASQ, VALID_DNSMASQ_DOMAIN, requestDnsRestart, onBeforeDnsRestart, onDnsFilesCleared, ftlConfigGet,
  getRoutingApplyStatus, dnsmasqDirOffRestorable, readDnsmasqDirKey,
} from './system';

export type SafeSearchProvider = 'google' | 'youtube' | 'bing' | 'duckduckgo';
// Kullanıcıya dönen hata (HTTP durumuyla): geçersiz girdi / çözülemeyen adres 400, Pi dışı 409
export class SafeSearchError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
interface ProviderDef { label: string; target: string; names: string[] }

// Google'ın ülke alan adları (google.com/supported_domains): hem çıplak ad hem www.
const GOOGLE_TLDS = ['com', 'ad', 'ae', 'com.af', 'com.ag', 'al', 'am', 'co.ao', 'com.ar', 'as', 'at', 'com.au', 'az', 'ba',
  'com.bd', 'be', 'bf', 'bg', 'com.bh', 'bi', 'bj', 'com.bn', 'com.bo', 'com.br', 'bs', 'bt', 'co.bw', 'by', 'com.bz', 'ca', 'cat',
  'cd', 'cf', 'cg', 'ch', 'ci', 'co.ck', 'cl', 'cm', 'cn', 'com.co', 'co.cr', 'com.cu', 'cv', 'com.cy', 'cz', 'de', 'dj', 'dk', 'dm',
  'com.do', 'dz', 'com.ec', 'ee', 'com.eg', 'es', 'com.et', 'fi', 'com.fj', 'fm', 'fr', 'ga', 'ge', 'gg', 'com.gh', 'com.gi', 'gl',
  'gm', 'gr', 'com.gt', 'gy', 'com.hk', 'hn', 'hr', 'ht', 'hu', 'co.id', 'ie', 'co.il', 'im', 'co.in', 'iq', 'is', 'it', 'je',
  'com.jm', 'jo', 'co.jp', 'co.ke', 'com.kh', 'ki', 'kg', 'co.kr', 'com.kw', 'kz', 'la', 'com.lb', 'li', 'lk', 'co.ls', 'lt', 'lu',
  'lv', 'com.ly', 'co.ma', 'md', 'me', 'mg', 'mk', 'ml', 'com.mm', 'mn', 'com.mt', 'mu', 'mv', 'mw', 'com.mx', 'com.my', 'co.mz',
  'com.na', 'com.ng', 'com.ni', 'ne', 'nl', 'no', 'com.np', 'nr', 'nu', 'co.nz', 'com.om', 'com.pa', 'com.pe', 'com.pg', 'com.ph',
  'com.pk', 'pl', 'pn', 'com.pr', 'ps', 'pt', 'com.py', 'com.qa', 'ro', 'rs', 'ru', 'rw', 'com.sa', 'com.sb', 'sc', 'se', 'com.sg',
  'sh', 'si', 'sk', 'com.sl', 'sn', 'so', 'sm', 'sr', 'st', 'com.sv', 'td', 'tg', 'co.th', 'com.tj', 'tl', 'tm', 'tn', 'to',
  'com.tr', 'tt', 'com.tw', 'co.tz', 'com.ua', 'co.ug', 'co.uk', 'com.uy', 'co.uz', 'com.vc', 'co.ve', 'co.vi', 'com.vn', 'vu',
  'ws', 'co.za', 'co.zm', 'co.zw'];

export const SAFESEARCH_PROVIDERS: Record<SafeSearchProvider, ProviderDef> = {
  google: { label: 'Google', target: 'forcesafesearch.google.com', names: GOOGLE_TLDS.flatMap(t => [`www.google.${t}`, `google.${t}`]) },
  // Sıkı kısıtlı mod (kullanıcı kararı 2026-10-02); adlar Google'ın YouTube kısıtlı mod belgesindeki liste
  youtube: { label: 'YouTube (Sıkı kısıtlı mod)', target: 'restrict.youtube.com',
    names: ['www.youtube.com', 'm.youtube.com', 'youtubei.googleapis.com', 'youtube.googleapis.com', 'www.youtube-nocookie.com'] },
  bing: { label: 'Bing', target: 'strict.bing.com', names: ['www.bing.com'] },
  duckduckgo: { label: 'DuckDuckGo', target: 'safe.duckduckgo.com', names: ['duckduckgo.com', 'www.duckduckgo.com'] },
};
export const SAFESEARCH_IDS = Object.keys(SAFESEARCH_PROVIDERS) as SafeSearchProvider[];

interface Ips { a: string[]; aaaa: string[] }
// suspended: DNS güvenlik ağı dosyayı boşalttı (neden metni) — kullanıcı yeniden uygulayana dek 09 yazılmaz
export interface SafeSearchConfig { enabled: boolean; providers: SafeSearchProvider[]; ips: Record<string, Ips>; resolvedAt: number; suspended?: string }
const CONFIG_KEY = 'safesearch_config';
// Açarken /etc/dnsmasq.d okuması kapalıydı ('1'): kapatınca geri kapatılır. Çalışma kaydı — yedekten geri gelmez
// (index.ts BACKUP_SKIP_SETTINGS): başka bir cihazın Pi-hole durumunu taşımasın.
const DIR_KEY = 'safesearch_dir_was_off';
const MAX_IPS = 4;
const REFRESH_MS = 6 * 3600 * 1000;
const TICK_MS = 30 * 60 * 1000;
const HEADER = '# Klyrix Gate - guvenli arama (SafeSearch). Backend yazar (safeSearch.ts), elle duzenlemeyin.';
const SUSPEND_TEXT = "DNS yeniden başlatıldıktan sonra yanıt vermediği için güvenlik ağı dosyayı boşalttı — «Şimdi uygula» ile yeniden deneyin";

const cleanIps = (x: any): Ips => ({
  a: (Array.isArray(x?.a) ? x.a : []).map(String).filter((s: string) => net.isIPv4(s)).slice(0, MAX_IPS),
  aaaa: (Array.isArray(x?.aaaa) ? x.aaaa : []).map(String).filter((s: string) => net.isIPv6(s)).slice(0, MAX_IPS),
});
const validProviders = (x: unknown): SafeSearchProvider[] =>
  SAFESEARCH_IDS.filter(p => Array.isArray(x) && x.includes(p));

export async function readSafeSearchConfig(): Promise<SafeSearchConfig> {
  const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [CONFIG_KEY]).catch(() => undefined) as { value?: string } | undefined;
  let j: any = {};
  try { j = JSON.parse(row?.value || '{}') || {}; } catch { j = {}; }
  const ips: Record<string, Ips> = {};
  for (const p of SAFESEARCH_IDS) {
    const t = SAFESEARCH_PROVIDERS[p].target;
    if (j.ips?.[t]) ips[t] = cleanIps(j.ips[t]);
  }
  const providers = j.providers === undefined ? [...SAFESEARCH_IDS] : validProviders(j.providers);
  const enabled = j.enabled === true && providers.length > 0;
  return {
    enabled, providers, ips, resolvedAt: Number(j.resolvedAt) || 0,
    ...(enabled && typeof j.suspended === 'string' && j.suspended ? { suspended: j.suspended.slice(0, 300) } : {}),
  };
}
async function saveConfig(c: SafeSearchConfig): Promise<void> {
  await dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [CONFIG_KEY, JSON.stringify({ enabled: c.enabled, providers: c.providers, ips: c.ips, resolvedAt: c.resolvedAt, ...(c.suspended ? { suspended: c.suspended } : {}) })]);
}

// ── Çakışmalar: aynı ad için başka bir yerel kayıt ya da yönlendirme ─────────
export interface SafeSearchConflict { name: string; provider: SafeSearchProvider; reason: string }
interface LocalNames { exact: Map<string, string>; suffix: Map<string, string> }
const PIHOLE_DNSMASQ = '/etc/pihole/dnsmasq.conf';
const PIHOLE_HOSTS = '/etc/pihole/hosts/custom.list';
const ROUTING_FILE = '/etc/dnsmasq.d/05-domain-routing.conf';
const REDIRECT_FILE = '/etc/dnsmasq.d/06-domain-redirect.conf';
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
// Ad ve üst alan adları (www.google.com.tr → www.google.com.tr, google.com.tr, com.tr, tr): dnsmasq'ın /alan/ eşleşmesi
const parents = (n: string) => n.split('.').map((_, i, a) => a.slice(i).join('.'));
// Yalnız bizim adlarımızı (ve üst alan adlarını) ilgilendiren kayıtlar tutulur: 05'te on binlerce server= satırı olabilir
const WANTED = new Set(SAFESEARCH_IDS.flatMap(p => [SAFESEARCH_PROVIDERS[p].target, ...SAFESEARCH_PROVIDERS[p].names]).flatMap(parents));
// dnsmasq "anahtar = değer" yazımına boşluk da izin verir ("cname = a , b"): hepsi tanınır
const DIRECTIVE = /^\s*([a-z-]+)\s*=\s*(.*?)\s*$/i;

function reasonOf(file: string, key: string): string {
  if (file === PIHOLE_DNSMASQ) return key === 'cname' ? 'Pi-hole yerel CNAME kaydı' : 'Pi-hole yapılandırması';
  if (file === ROUTING_FILE) return 'Routing → VPS / DPI yönlendirmesi';
  if (file === REDIRECT_FILE) return 'Routing → alan adı yönlendirmesi';
  return `dnsmasq dosyası ${file.split('/').pop()}`;
}

// Pi-hole'un ürettiği dnsmasq.conf (CNAME kayıtları), /etc/dnsmasq.d'deki diğer dosyalar (05 VPS / DPI, 06 yönlendirme dahil),
// Pi-hole Yerel DNS (dns.hosts → custom.list), /etc/hosts, panelin henüz yazılmamış kayıtları (Routing yönlendirmesi, Pi-hole →
// Yerel DNS).
async function localNames(): Promise<LocalNames> {
  const exact = new Map<string, string>(), suffix = new Map<string, string>();
  const put = (m: Map<string, string>, n: string, why: string) => {
    const k = n.trim().toLowerCase().replace(/^\*\.?/, '').replace(/\.$/, '');
    if (k && WANTED.has(k) && !m.has(k)) m.set(k, why);
  };
  const files = [PIHOLE_DNSMASQ];
  try {
    for (const f of fs.readdirSync('/etc/dnsmasq.d').sort()) {
      const p = `/etc/dnsmasq.d/${f}`;
      if (f.endsWith('.conf') && p !== SAFESEARCH_DNSMASQ) files.push(p);
    }
  } catch { /* dizin yok */ }
  for (const file of files) {
    for (const raw of readText(file).split('\n')) {
      const m = DIRECTIVE.exec(raw);
      if (!m) continue;
      const key = m[1].toLowerCase(), val = m[2], why = reasonOf(file, key);
      if (key === 'cname') {
        const parts = val.split(',').map(s => s.trim()).filter(Boolean);
        if (/^\d+$/.test(parts[parts.length - 1] || '')) parts.pop();   // TTL
        for (const a of parts.slice(0, -1)) put(exact, a, why);
      } else if (key === 'host-record') {
        for (const n of val.split(',').map(s => s.trim())) if (n && !net.isIP(n) && !/^\d+$/.test(n)) put(exact, n, why);
      } else if (key === 'address' || key === 'ipset' || key === 'nftset' || key === 'server') {
        const d = /^\/(.+)\/([^/]*)$/.exec(val);
        // server=/ad/ (adressiz) "yalnız yerelden yanıtla" demektir — yerel kaydımız onu bozmaz; adresli olan yönlendirmedir
        if (!d || (key === 'server' && !d[2].trim())) continue;
        for (const n of d[1].split('/')) if (n && n !== '#') put(suffix, n, why);
      }
    }
  }
  for (const [file, why] of [[PIHOLE_HOSTS, 'Pi-hole → Yerel DNS kaydı'], ['/etc/hosts', '/etc/hosts kaydı']]) {
    for (const raw of readText(file).split('\n')) {
      const [ip, ...names] = raw.replace(/#.*/, '').trim().split(/\s+/);
      if (ip && net.isIP(ip)) for (const n of names) put(exact, n, why);
    }
  }
  const red = await dbAll("SELECT domain FROM domain_routing WHERE enabled = 1 AND COALESCE(redirect_url, '') != ''").catch(() => []) as any[];
  for (const r of red) put(suffix, String(r.domain || ''), 'Routing → alan adı yönlendirmesi');
  const ldns = await dbAll("SELECT value FROM pihole_lists WHERE list_type = 'localdns' AND enabled = 1").catch(() => []) as any[];
  for (const r of ldns) { const host = String(r.value || '').trim().split(/\s+/)[1]; if (host) put(exact, host, 'Pi-hole → Yerel DNS kaydı'); }
  return { exact, suffix };
}
function conflictOf(name: string, l: LocalNames): string | null {
  if (l.exact.has(name)) return l.exact.get(name)!;
  for (const d of parents(name)) if (l.suffix.has(d)) return l.suffix.get(d)!;
  return null;
}
const NO_LOCAL: LocalNames = { exact: new Map(), suffix: new Map() };

interface Plan { content: string; conflicts: SafeSearchConflict[]; skipped: { provider: SafeSearchProvider; reason: string }[] }
// Saf: sağlayıcılar + adresler + yerel adlar → 09 dosyası. Yazılacak satır yoksa boş metin.
export function renderSafeSearch(providers: SafeSearchProvider[], ips: Record<string, Ips>, local: LocalNames): Plan {
  const out: string[] = [];
  const conflicts: SafeSearchConflict[] = [];
  const skipped: Plan['skipped'] = [];
  for (const p of SAFESEARCH_IDS) {
    if (!providers.includes(p)) continue;
    const def = SAFESEARCH_PROVIDERS[p];
    const ip = ips[def.target];
    if (!ip?.a.length) { skipped.push({ provider: p, reason: `${def.target} adresi çözülemedi` }); continue; }
    const tWhy = conflictOf(def.target, local);
    if (tWhy) { skipped.push({ provider: p, reason: `${def.target} için başka bir kayıt var (${tWhy})` }); continue; }
    const names: string[] = [];
    for (const n of [...new Set(def.names)]) {
      if (!VALID_DNSMASQ_DOMAIN.test(n)) continue;
      const why = conflictOf(n, local);
      if (why) conflicts.push({ name: n, provider: p, reason: why });
      else names.push(n);
    }
    if (!names.length) { skipped.push({ provider: p, reason: 'tüm adlar başka bir kayıtla çakışıyor' }); continue; }
    out.push(`# ${def.label.split(' ')[0]} -> ${def.target}`);
    // host-record satır başına bir IPv4 + bir IPv6; fazlası ek satırla (aynı ada). Önce hedefin kendisi (gerçek adresleri),
    // sonra her ad; hedefin IPv6'sı yoksa adlara AAAA '::' (gerçek IPv6'ya sızmasın — başlıktaki not).
    const row = (n: string, v6: string[]) => {
      for (let i = 0; i < Math.max(ip.a.length, v6.length); i++) out.push(`host-record=${n},${[ip.a[i], v6[i]].filter(Boolean).join(',')}`);
    };
    row(def.target, ip.aaaa);
    for (const n of names) row(n, ip.aaaa.length ? ip.aaaa : ['::']);
  }
  return { content: out.length ? `${HEADER}\n${out.join('\n')}\n` : '', conflicts, skipped };
}

// ── Dosya ────────────────────────────────────────────────────────────────────
const readConf = () => readText(SAFESEARCH_DNSMASQ);
const hasEntries = (s: string) => s.split('\n').some(l => l.trim() && !l.startsWith('#'));
// Dosyada kaydı olan adlar (hedefler dahil): yeni bir çakışma ad çıkarıyor mu (hemen uygulanır) karşılaştırması
const namesIn = (s: string) => new Set(s.split('\n').map(l => /^host-record=([^,]+),/.exec(l)?.[1]).filter((x): x is string => !!x));
// Atomik yazım (geçici ad .conf ile bitmez: FTL yarım dosyayı okumasın). İçerik aynıysa yazılmaz. Değişti mi döner; hata fırlatır.
function writeConf(content: string): boolean {
  if (readConf() === content && fs.existsSync(SAFESEARCH_DNSMASQ)) return false;
  fs.mkdirSync('/etc/dnsmasq.d', { recursive: true });   // Pi-hole v6'nın yeni kurulumunda dizin olmayabilir
  const tmp = `${SAFESEARCH_DNSMASQ}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, SAFESEARCH_DNSMASQ);
  return true;
}
// Dosyayı kaldırır; DNS'e yüklü bir satırı var mıydı (yeniden başlatma gerekir mi) döner.
function removeConf(): boolean {
  const had = hasEntries(readConf());
  try { fs.unlinkSync(SAFESEARCH_DNSMASQ); } catch { /* yok */ }
  return had;
}
// Plan dosyaya: satır kalmadıysa (hepsi çakışıyor) dosya kaldırılır — kullanıcının kayıtları tek başına kalsın.
const writePlan = (content: string): boolean => (content ? writeConf(content) : removeConf());

// ── Çözümleme (Unbound; yoksa Pi-hole'un kendi üst sunucuları — Pi-hole'un kendisi değil: kendi kaydımızı geri okurduk) ──
async function resolverServers(): Promise<string[]> {
  if (process.env.PI5_SAFESEARCH_DNS) return [process.env.PI5_SAFESEARCH_DNS];   // yalnız test
  const out = ['127.0.0.1:5335'];
  const raw = await ftlConfigGet('dns.upstreams').catch(() => null);
  for (const u of String(raw || '').replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [host, port] = u.split('#');
    if (!net.isIP(host) || ((host === '127.0.0.1' || host === '::1') && (port || '53') === '53')) continue;
    const s = net.isIPv6(host) ? `[${host}]:${port || 53}` : `${host}:${port || 53}`;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
async function resolveOne(name: string, servers: string[]): Promise<Ips | null> {
  for (const s of servers) {
    const r = new dnsPromises.Resolver({ timeout: 3000, tries: 2 });
    try {
      r.setServers([s]);
      const a = (await r.resolve4(name)).filter(x => net.isIPv4(x)).slice(0, MAX_IPS);
      if (!a.length) continue;
      const aaaa = await r.resolve6(name).then(x => x.filter(y => net.isIPv6(y)).slice(0, MAX_IPS), () => [] as string[]);
      return { a: a.sort(), aaaa: aaaa.sort() };
    } catch { /* sıradaki sunucu */ }
  }
  return null;
}
async function resolveTargets(providers: SafeSearchProvider[]): Promise<Map<string, Ips | null>> {
  const servers = await resolverServers();
  const out = new Map<string, Ips | null>();
  await Promise.all(providers.map(async p => { const t = SAFESEARCH_PROVIDERS[p].target; out.set(t, await resolveOne(t, servers)); }));
  return out;
}
const sameIps = (x: Record<string, Ips>, y: Record<string, Ips>) =>
  JSON.stringify(Object.keys(x).sort().map(k => [k, x[k]])) === JSON.stringify(Object.keys(y).sort().map(k => [k, y[k]]));

// ── Durum ────────────────────────────────────────────────────────────────────
let pendingIps: Record<string, Ips> | null = null;   // gece yazılacak yeni adresler
let lastResolveAt = 0;
let lastError: string | null = null;
let nightDoneDay = '';
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}
export const inNightWindow = (d: Date) => d.getHours() >= 3 && d.getHours() < 6;

export interface SafeSearchStatus {
  supported: boolean; enabled: boolean; providers: SafeSearchProvider[];
  catalog: { id: SafeSearchProvider; label: string; target: string; names: number }[];
  applied: boolean; pending: boolean; suspended: string | null;
  conflicts: SafeSearchConflict[]; skipped: { provider: SafeSearchProvider; reason: string }[];
  ips: Record<string, Ips>; resolvedAt: number | null; error: string | null;
  dns: { phase: string; error: string };
}
export async function safeSearchStatus(): Promise<SafeSearchStatus> {
  const cfg = await readSafeSearchConfig();
  // Kapalıyken yerel adlar okunmaz (plan kullanılmıyor)
  const plan = renderSafeSearch(cfg.providers, cfg.ips, isLinux && cfg.enabled ? await localNames() : NO_LOCAL);
  const have = readConf();
  const rs = getRoutingApplyStatus();
  return {
    supported: isLinux, enabled: cfg.enabled, providers: cfg.providers,
    catalog: SAFESEARCH_IDS.map(id => ({ id, label: SAFESEARCH_PROVIDERS[id].label, target: SAFESEARCH_PROVIDERS[id].target, names: SAFESEARCH_PROVIDERS[id].names.length })),
    // Açıkken: dosya plana eşit (hepsi çakışıyorsa plan da dosya da boş). Askıdayken uygulanmış sayılmaz.
    applied: cfg.enabled ? !cfg.suspended && have === plan.content && (hasEntries(have) || !plan.content) : !hasEntries(have),
    pending: cfg.enabled && !cfg.suspended && pendingIps !== null,
    suspended: cfg.suspended || null,
    conflicts: cfg.enabled ? plan.conflicts : [], skipped: cfg.enabled ? plan.skipped : [],
    ips: cfg.ips, resolvedAt: cfg.resolvedAt || null, error: cfg.enabled ? lastError : null,
    dns: { phase: rs.phase, error: rs.error },
  };
}

// Önizleme (yan etkisiz): verilen sağlayıcılar için adresler çözülür, atlanacak adlar ve sağlayıcılar döner.
export async function previewSafeSearch(providers: SafeSearchProvider[]): Promise<{ conflicts: SafeSearchConflict[]; skipped: Plan['skipped'] }> {
  const cfg = await readSafeSearchConfig();
  const res = isLinux ? await resolveTargets(providers) : new Map<string, Ips | null>();
  const ips = { ...cfg.ips };
  for (const [t, r] of res) if (r) ips[t] = r;
  const plan = renderSafeSearch(providers, ips, isLinux ? await localNames() : NO_LOCAL);
  return { conflicts: plan.conflicts, skipped: plan.skipped };
}

// Açmadan önce (şablon): seçilen sağlayıcılardan en az birinin adresi çözülüyor (ya da önceki adresi kayıtlı) mu — yan etkisiz.
// Hiçbiri değilse setSafeSearch'ün vereceği hatayla fırlatır: şablon hiçbir şey değiştirmeden reddedilir.
export async function assertSafeSearchResolvable(providers: SafeSearchProvider[]): Promise<void> {
  if (!isLinux) throw new SafeSearchError('Güvenli arama yalnız Pi üzerinde çalışır', 409);
  const cfg = await readSafeSearchConfig();
  const res = await resolveTargets(providers);
  const failed = providers.filter(p => !res.get(SAFESEARCH_PROVIDERS[p].target) && !cfg.ips[SAFESEARCH_PROVIDERS[p].target]?.a.length);
  if (providers.length && failed.length === providers.length) {
    throw new SafeSearchError(`Güvenli arama adresleri çözülemedi (${failed.map(p => SAFESEARCH_PROVIDERS[p].label).join(', ')}) — Unbound çalışıyor mu? Hiçbir şey değişmedi`);
  }
}

const setDirKey = (v: string | null) => (v === null
  ? dbRun('DELETE FROM app_settings WHERE key = ?', [DIR_KEY])
  : dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [DIR_KEY, v]));

// Kullanıcı (ya da şablon / yedekten geri yükleme) açar / kapatır / sağlayıcıları değiştirir: hemen uygulanır (askıyı da kaldırır).
// Açarken adresler yeniden çözülür; hiçbiri çözülemezse (ve önceki adres yoksa) hiçbir şey değişmeden hata.
export async function setSafeSearch(input: { enabled: boolean; providers?: unknown }): Promise<SafeSearchStatus> {
  if (!isLinux) throw new SafeSearchError('Güvenli arama yalnız Pi üzerinde çalışır', 409);
  if (input.providers !== undefined && (!Array.isArray(input.providers) || input.providers.some(p => !SAFESEARCH_IDS.includes(p as SafeSearchProvider)))) {
    throw new SafeSearchError('Bilinmeyen arama sağlayıcısı');
  }
  await serial(async () => {
    const cfg = await readSafeSearchConfig();
    const providers = input.providers === undefined ? cfg.providers : validProviders(input.providers);
    if (input.enabled) {
      if (!providers.length) throw new SafeSearchError('En az bir sağlayıcı seçin');
      const res = await resolveTargets(providers);
      const ips = { ...cfg.ips };
      const failed: string[] = [];
      for (const p of providers) {
        const t = SAFESEARCH_PROVIDERS[p].target;
        const r = res.get(t);
        if (r) ips[t] = r;
        else if (!ips[t]?.a.length) failed.push(SAFESEARCH_PROVIDERS[p].label);
      }
      if (failed.length === providers.length) {
        throw new SafeSearchError(`Güvenli arama adresleri çözülemedi (${failed.join(', ')}) — Unbound çalışıyor mu? Hiçbir şey değişmedi`);
      }
      const next: SafeSearchConfig = { enabled: true, providers, ips, resolvedAt: Date.now() };
      const plan = renderSafeSearch(providers, ips, await localNames());
      if (!plan.content) throw new SafeSearchError('Yazılacak kayıt kalmadı — tüm adlar başka bir yerel kayıtla çakışıyor');
      // Kapalıdan açılırken /etc/dnsmasq.d okumasının durumu (DNS işi kapalıysa açar): kapatınca geri kapatmak için
      if (!cfg.enabled) await setDirKey((await readDnsmasqDirKey()) === 'false' ? '1' : null);
      // Askıdaydıysa dosya güvenlik ağınca boşaltılmıştı: içerik aynı olsa da (yazılmasa da) yeniden başlatma gerekir
      const changed = writeConf(plan.content) || !!cfg.suspended;
      await saveConfig(next);
      pendingIps = null;
      lastResolveAt = Date.now();
      lastError = failed.length ? `${failed.join(', ')} adresi çözülemedi — atlandı` : null;
      if (changed) requestDnsRestart();
    } else {
      const removed = removeConf();
      await saveConfig({ ...cfg, enabled: false, providers: providers.length ? providers : cfg.providers, suspended: undefined });
      pendingIps = null;
      lastError = null;
      // Okumayı güvenli arama açtırdıysa ve /etc/dnsmasq.d'de yüklenecek satır kalmadıysa aynı yeniden başlatmada geri kapatılır
      const dirOff = (await dbGet('SELECT value FROM app_settings WHERE key = ?', [DIR_KEY]).catch(() => undefined) as { value?: string } | undefined)?.value === '1';
      const restore = dirOff && await dnsmasqDirOffRestorable();
      await setDirKey(null);
      if (removed || restore) requestDnsRestart({ restoreDnsmasqDirOff: restore });
    }
  });
  return safeSearchStatus();
}

// Zamanlayıcı turu (dışa açık: test sahte saatle çağırır). 6 saatte bir adresler yeniden çözülür; değişen adres dosyaya yalnız
// gece 03–06'da (gece başına bir kez) yazılır — gündüz son geçerli kayıt korunur. Yeni bir çakışma (kullanıcı aynı ad için kayıt
// ekledi) bir adı dosyadan çıkarıyorsa beklenmez: DNS bir kez yeniden başlatılır (kanca dosyayı güncel durumla yazar).
export async function safeSearchTick(now: Date = new Date()): Promise<'off' | 'suspended' | 'idle' | 'pending' | 'conflict' | 'applied'> {
  return serial(async () => {
    const cfg = await readSafeSearchConfig();
    if (!cfg.enabled) { pendingIps = null; return 'off'; }
    if (cfg.suspended) { pendingIps = null; return 'suspended'; }
    let resolvedAt = cfg.resolvedAt;
    if (!lastResolveAt || now.getTime() - lastResolveAt >= REFRESH_MS) {
      lastResolveAt = now.getTime();
      const res = await resolveTargets(cfg.providers);
      const next = { ...(pendingIps || cfg.ips) };
      const failed: string[] = [];
      for (const p of cfg.providers) {
        const t = SAFESEARCH_PROVIDERS[p].target;
        const r = res.get(t);
        if (r) next[t] = r; else failed.push(SAFESEARCH_PROVIDERS[p].label);
      }
      if (failed.length) {
        lastError = `${failed.join(', ')} adresi çözülemedi — son geçerli kayıt korunuyor`;
        void recordEventOnce('templates', `Güvenli arama: ${lastError}`, 'warning', 360);
      } else {
        lastError = null;
        resolvedAt = now.getTime();
      }
      pendingIps = sameIps(next, cfg.ips) ? null : next;
    }
    const local = await localNames();
    const ips = pendingIps || cfg.ips;
    const plan = renderSafeSearch(cfg.providers, ips, local);
    const have = readConf();
    if (plan.content === have) {
      if (pendingIps || resolvedAt !== cfg.resolvedAt) await saveConfig({ ...cfg, ips, resolvedAt });
      pendingIps = null;
      return 'idle';
    }
    // Çakışma bir adı çıkarıyor mu (yalnız adres değişimi değil: karşılaştırma bugünkü adreslerle)
    const now09 = renderSafeSearch(cfg.providers, cfg.ips, local).content;
    const keep = namesIn(now09);
    const dropped = [...namesIn(have)].filter(n => !keep.has(n));
    if (dropped.length) {
      // Önce dosya (bugünkü adreslerle; yazılamazsa hata — her turda yeniden başlatma istenmez), sonra tek yeniden başlatma
      // (kanca bekleyen adres varsa onu da katar)
      writePlan(now09);
      requestDnsRestart();
      void recordEvent('templates', `Güvenli arama: ${dropped.length} ad için başka bir kayıt eklendi (${dropped.slice(0, 3).join(', ')}${dropped.length > 3 ? '…' : ''}) — o kayıt geçerli, DNS bir kez yeniden başlatıldı`);
      return 'conflict';
    }
    const day = now.toDateString();
    if (!inNightWindow(now) || nightDoneDay === day) return 'pending';
    nightDoneDay = day;
    writePlan(plan.content);
    await saveConfig({ ...cfg, ips, resolvedAt });
    const ipChange = !!pendingIps;
    pendingIps = null;
    requestDnsRestart();
    void recordEvent('templates', ipChange ? 'Güvenli arama: sağlayıcı adresleri değişti — gece DNS bir kez yeniden başlatıldı'
      : 'Güvenli arama kayıtları yenilendi (gece) — DNS bir kez yeniden başlatıldı');
    return 'applied';
  });
}

// DNS (Routing ya da başka bir neden) zaten yeniden başlarken: 09 güncel çakışmalarla ve bekleyen adreslerle yeniden yazılır —
// aynı yeniden başlatmada yüklenir. Kapalıysa ve dosya kalmışsa kaldırılır. Askıdayken dokunulmaz (güvenlik ağı boşalttı).
async function beforeRestart(): Promise<void> {
  await serial(async () => {
    const cfg = await readSafeSearchConfig();
    if (!cfg.enabled) { if (fs.existsSync(SAFESEARCH_DNSMASQ)) removeConf(); return; }
    if (cfg.suspended) return;
    const ips = pendingIps || cfg.ips;
    writePlan(renderSafeSearch(cfg.providers, ips, await localNames()).content);
    if (pendingIps) { await saveConfig({ ...cfg, ips }); pendingIps = null; }
  });
}

// DNS güvenlik ağı 05/06/07/09'u boşalttı (system.ts restartFtlNow): açıksa askıya alınır — kanca ve gece turu 09'u yeniden
// yazıp aynı kesintiyi tekrarlamasın. Kullanıcı Aç / «Şimdi uygula» ile kaldırır.
async function afterFilesCleared(): Promise<void> {
  await serial(async () => {
    const cfg = await readSafeSearchConfig();
    if (!cfg.enabled || cfg.suspended) return;
    pendingIps = null;
    await saveConfig({ ...cfg, suspended: SUSPEND_TEXT });
    await recordEvent('templates', `Güvenli arama askıya alındı: ${SUSPEND_TEXT} (Koruma Şablonları → Güvenli arama)`, 'warning');
  });
}

// Yedekten geri yükleme (index.ts applyRestored): geri gelen ayar Pi'ye uygulanır (adresler yeniden çözülür).
export async function applyRestoredSafeSearch(): Promise<string> {
  const cfg = await readSafeSearchConfig();
  if (!cfg.enabled) { await setSafeSearch({ enabled: false }); return 'güvenli arama kapalı'; }
  const st = await setSafeSearch({ enabled: true, providers: cfg.providers });
  return `güvenli arama açık (${st.providers.map(p => SAFESEARCH_PROVIDERS[p].label).join(', ')})${st.conflicts.length ? ` — ${st.conflicts.length} ad çakışma nedeniyle atlandı` : ''}`;
}

// Açılış (index.ts '!isSatellite'): kapalıyken her 30 dk'da yalnız ayar okunur; dosya yazılmaz.
let started = false;
export function startSafeSearch(): void {
  if (!isLinux || started) return;
  started = true;
  onBeforeDnsRestart(beforeRestart);
  onDnsFilesCleared(afterFilesCleared);
  setTimeout(() => { void safeSearchTick().catch(e => console.error('[güvenli arama]', e?.message || e)); }, 4 * 60 * 1000);
  setInterval(() => { void safeSearchTick().catch(e => console.error('[güvenli arama]', e?.message || e)); }, TICK_MS);
}

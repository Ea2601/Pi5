// Unbound (özyinelemeli DNS): panelin Unbound sayfası gerçek değerleri gösterir, Ayarlar Unbound'a gerçekten uygulanır.
// Eskiden ayarlar yalnız veritabanındaydı (sekmede Thread 2 / Min TTL 3600 görünürken Pi'de 1 / 0 idi) ve iki kart var
// olmayan istatistiği okuyordu (num.threads hiç yok; msg.cache.count yalnız extended-statistics açıkken gelir).
//  - Panelin ayarları tek dosyada: /etc/unbound/unbound.conf.d/klyrix-panel.conf. Unbound conf.d dosyalarını SIRASIZ okur
//    (util/config_file.c: glob(..., GLOB_NOSORT)) ve aynı ayar iki kez yazılırsa sonraki kazanır — hangisinin kazanacağı
//    belirsizdir. Bu yüzden diğer conf.d dosyalarındaki aynı ayar satırları "#klyrix-panel: " önekiyle devre dışı bırakılır
//    (önek silinince eski hâline döner).
//  - Uygulama: yaz → unbound-checkconf → etkin değerler doğrulanır (checkconf -o) → systemctl restart → 127.0.0.1:5335'e
//    deneme sorgusu. Herhangi bir adım başarısızsa bütün dosyalar eski hâline döner (gerekirse Unbound yeniden başlatılır).
//  - Port / arayüz yönetilmez: Pi-hole'un üst DNS'i 127.0.0.1#5335; değişirse ağın DNS'i kesilir.
import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbGet, dbRun } from './db';
import { isLinux } from './system';

const execFileP = promisify(execFile);
const CONF_D = '/etc/unbound/unbound.conf.d';
const PANEL_FILE = 'klyrix-panel.conf';
const PANEL_PATH = `${CONF_D}/${PANEL_FILE}`;
const OFF = '#klyrix-panel: ';
const SETTINGS_KEY = 'unbound_settings';
const MB = 1024 * 1024;

export interface UnboundSettings {
  num_threads: number;     // 1 | 2 | 4
  cache_mb: number;        // mesaj önbelleği (MB); kayıt (rrset) önbelleği bunun iki katı
  cache_min_ttl: number;   // 0 | 60 | 300
  prefetch: boolean;
  serve_expired: boolean;
  hide_identity: boolean;
  hide_version: boolean;
}
export const UNBOUND_OPTIONS = { num_threads: [1, 2, 4], cache_mb: [4, 16, 32, 64], cache_min_ttl: [0, 60, 300] };
// Önerilen (kullanıcı onayı 2026-09-29): tek iş parçacığı (Pi-hole rehberi: küçük ağda yeterli), 32 MB önbellek,
// süresi dolan kaydı hemen verip arka planda yenileme (RFC 8767), sürüm/kimlik gizli.
export const RECOMMENDED: UnboundSettings = {
  num_threads: 1, cache_mb: 32, cache_min_ttl: 0, prefetch: true, serve_expired: true, hide_identity: true, hide_version: true,
};

const BOOL_KEYS = ['prefetch', 'serve_expired', 'hide_identity', 'hide_version'] as const;
export function validateUnboundSettings(v: any): UnboundSettings | string {
  if (!v || typeof v !== 'object') return 'Ayarlar eksik';
  for (const k of ['num_threads', 'cache_mb', 'cache_min_ttl'] as const) {
    if (!UNBOUND_OPTIONS[k].includes(Number(v[k]))) return `Geçersiz değer: ${k}`;
  }
  for (const k of BOOL_KEYS) if (typeof v[k] !== 'boolean') return `Geçersiz değer: ${k}`;
  return {
    num_threads: Number(v.num_threads), cache_mb: Number(v.cache_mb), cache_min_ttl: Number(v.cache_min_ttl),
    prefetch: v.prefetch, serve_expired: v.serve_expired, hide_identity: v.hide_identity, hide_version: v.hide_version,
  };
}

// Panel dosyasının yazdığı ayarlar ve unbound-checkconf -o ile görülmesi gereken etkin değerleri.
function managedValues(s: UnboundSettings): [string, string, string][] {
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return [ // [ayar, dosyadaki değer, checkconf -o çıktısı]
    ['num-threads', String(s.num_threads), String(s.num_threads)],
    ['msg-cache-size', `${s.cache_mb}m`, String(s.cache_mb * MB)],
    ['rrset-cache-size', `${s.cache_mb * 2}m`, String(s.cache_mb * 2 * MB)],
    ['cache-min-ttl', String(s.cache_min_ttl), String(s.cache_min_ttl)],
    ['prefetch', yn(s.prefetch), yn(s.prefetch)],
    ['serve-expired', yn(s.serve_expired), yn(s.serve_expired)],
    ['serve-expired-ttl', '86400', '86400'],
    ['serve-expired-client-timeout', '0', '0'],
    ['hide-identity', yn(s.hide_identity), yn(s.hide_identity)],
    ['hide-version', yn(s.hide_version), yn(s.hide_version)],
    ['extended-statistics', 'yes', 'yes'], // panelin önbellek / DNSSEC sayaçları için
  ];
}
const MANAGED_KEYS = managedValues(RECOMMENDED).map(([k]) => k);

export function renderPanelConf(s: UnboundSettings): string {
  return [
    '# Klyrix Gate paneli yönetir (Unbound DNS → Ayarlar); elle düzenlemeyin, panelden değiştirin.',
    '# Aynı ayarlar diğer dosyalarda "#klyrix-panel: " önekiyle devre dışı bırakıldı: Unbound bu klasörü sırasız okur.',
    'server:',
    ...managedValues(s).map(([k, v]) => `    ${k}: ${v}`),
    '',
  ].join('\n');
}

// Başka bir dosyadaki yönetilen ayar satırlarını devre dışı bırakır (yorum satırlarına dokunmaz).
const MANAGED_LINE = new RegExp(`^\\s*(${MANAGED_KEYS.join('|')})\\s*:`);
export function disableManagedLines(txt: string): string {
  return txt.split('\n').map(l => (MANAGED_LINE.test(l) ? `${OFF}${l}` : l)).join('\n');
}

const readOrNull = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function writeAtomic(f: string, txt: string) {
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, txt, { mode: 0o644 });
  fs.renameSync(tmp, f);
}
const otherConfFiles = () => {
  try { return fs.readdirSync(CONF_D).filter(f => f.endsWith('.conf') && f !== PANEL_FILE).map(f => path.join(CONF_D, f)); }
  catch { return []; }
};

const checkconfOpt = (opt: string) =>
  execFileP('unbound-checkconf', ['-o', opt], { timeout: 10000 }).then(r => r.stdout.trim().split('\n').join(' '), () => '');

// Yerel deneme sorgusu (internetsiz de yanıtlanır): "localhost A" → Unbound'un yerleşik localhost bölgesi. Herhangi bir
// DNS yanıtı Unbound'un ayakta olduğunu gösterir; yanıt kodu döner, yanıt yoksa null.
export function probeUnbound(port = 5335, timeoutMs = 1500): Promise<number | null> {
  return new Promise(resolve => {
    const id = Math.floor(Math.random() * 65535);
    const qname = Buffer.concat([Buffer.from([9]), Buffer.from('localhost'), Buffer.from([0])]);
    const msg = Buffer.concat([
      Buffer.from([id >> 8, id & 255, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), qname, Buffer.from([0, 1, 0, 1]),
    ]);
    const sock = dgram.createSocket('udp4');
    const done = (v: number | null) => { clearTimeout(t); try { sock.close(); } catch { /* kapalı */ } resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    sock.on('error', () => done(null));
    sock.on('message', m => { if (m.length >= 4 && m.readUInt16BE(0) === id) done(m[3] & 0x0f); });
    sock.send(msg, port, '127.0.0.1', err => { if (err) done(null); });
  });
}
async function waitUnboundUp(ms = 12000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const active = await execFileP('systemctl', ['is-active', 'unbound'], { timeout: 5000 }).then(r => r.stdout.trim() === 'active', () => false);
    if (active && (await probeUnbound()) !== null) return true;
    await new Promise(r => setTimeout(r, 700));
  }
  return false;
}

export interface UnboundApplyResult { ok: boolean; changed: boolean; restarted: boolean; rolledBack: boolean; error?: string; at: number }
let lastApply: UnboundApplyResult | null = null;
let applying: Promise<UnboundApplyResult> | null = null;

export function applyUnboundSettings(s: UnboundSettings): Promise<UnboundApplyResult> {
  if (applying) return applying.then(() => applyUnboundSettings(s));
  applying = doApply(s).finally(() => { applying = null; });
  return applying;
}

async function doApply(s: UnboundSettings): Promise<UnboundApplyResult> {
  const res: UnboundApplyResult = { ok: false, changed: false, restarted: false, rolledBack: false, at: Date.now() };
  // Geri alma için önce her şeyin kopyası
  const before = new Map<string, string>();
  for (const f of otherConfFiles()) { const t = readOrNull(f); if (t !== null) before.set(f, t); }
  const panelBefore = readOrNull(PANEL_PATH);
  const next = new Map<string, string>();
  for (const [f, t] of before) { const n = disableManagedLines(t); if (n !== t) next.set(f, n); }
  const panelNext = renderPanelConf(s);
  const restore = () => {
    for (const f of next.keys()) writeAtomic(f, before.get(f)!);
    if (panelBefore === null) { try { fs.unlinkSync(PANEL_PATH); } catch { /* yok */ } } else writeAtomic(PANEL_PATH, panelBefore);
  };
  try {
    if (!isLinux || !fs.existsSync(CONF_D)) throw new Error('Unbound bu cihazda kurulu değil');
    if (!next.size && panelNext === panelBefore) {
      res.ok = true;
      await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(s)]);
      return res;
    }
    res.changed = true;
    for (const [f, t] of next) writeAtomic(f, t);
    writeAtomic(PANEL_PATH, panelNext);

    const check = await execFileP('unbound-checkconf', [], { timeout: 15000 }).then(() => '', (e: any) => String(e?.stdout || '') + String(e?.stderr || e?.message || ''));
    if (check) {
      restore(); res.rolledBack = true;
      throw new Error(`Yapılandırma geçersiz, eski ayarlar korundu: ${check.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    }
    const wrong: string[] = [];
    await Promise.all(managedValues(s).map(async ([k, , want]) => {
      const got = await checkconfOpt(k);
      if (got !== want) wrong.push(`${k} (beklenen ${want}, etkin ${got || '?'})`);
    }));
    if (wrong.length) {
      restore(); res.rolledBack = true;
      throw new Error(`Ayar etkin olmadı — başka bir yapılandırma dosyası aynı ayarı yazıyor: ${wrong.join(', ')}`);
    }
    await execFileP('systemctl', ['restart', 'unbound'], { timeout: 30000 }).catch(() => { /* aşağıdaki denetim karar verir */ });
    res.restarted = true;
    if (!(await waitUnboundUp())) {
      restore(); res.rolledBack = true;
      await execFileP('systemctl', ['restart', 'unbound'], { timeout: 30000 }).catch(() => {});
      const back = await waitUnboundUp();
      throw new Error(`Unbound yeni ayarlarla yanıt vermedi — eski ayarlar geri yüklendi${back ? ' ve Unbound çalışıyor' : ', ama Unbound hâlâ yanıt vermiyor: SSH\'tan "sudo systemctl status unbound" ile bakın'}`);
    }
    await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(s)]);
    res.ok = true;
  } catch (e: any) {
    res.error = String(e?.message || e).slice(0, 500);
  } finally {
    res.at = Date.now();
    lastApply = res;
  }
  return res;
}

async function savedSettings(): Promise<UnboundSettings | null> {
  try {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY]);
    const v = row?.value ? validateUnboundSettings(JSON.parse(row.value)) : null;
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

const STAT_KEYS = ['total.num.queries', 'total.num.cachehits', 'total.num.cachemiss', 'total.num.prefetch',
  'total.num.expired', 'total.recursion.time.avg', 'total.recursion.time.median', 'time.up', 'msg.cache.count',
  'rrset.cache.count', 'num.answer.secure', 'num.answer.bogus', 'num.answer.rcode.SERVFAIL', 'mem.cache.message', 'mem.cache.rrset'];
const EFFECTIVE_KEYS = ['interface', 'port', 'num-threads', 'msg-cache-size', 'rrset-cache-size', 'cache-min-ttl', 'prefetch',
  'serve-expired', 'hide-identity', 'hide-version', 'harden-glue', 'harden-dnssec-stripped', 'qname-minimisation',
  'aggressive-nsec', 'auto-trust-anchor-file', 'module-config', 'extended-statistics'];

export async function unboundStatus() {
  if (!isLinux || !fs.existsSync(CONF_D)) return { installed: false, recommended: RECOMMENDED, options: UNBOUND_OPTIONS, lastApply };
  const [running, statsTxt, effList, saved] = await Promise.all([
    execFileP('systemctl', ['is-active', 'unbound'], { timeout: 5000 }).then(r => r.stdout.trim() === 'active', () => false),
    execFileP('unbound-control', ['stats_noreset'], { timeout: 5000 }).then(r => r.stdout, () => ''),
    Promise.all(EFFECTIVE_KEYS.map(async k => [k, await checkconfOpt(k)] as const)),
    savedSettings(),
  ]);
  const eff = Object.fromEntries(effList) as Record<string, string>;
  const raw: Record<string, string> = {};
  for (const line of statsTxt.split('\n')) { const i = line.indexOf('='); if (i > 0) raw[line.slice(0, i)] = line.slice(i + 1).trim(); }
  const num = (k: string) => (raw[k] !== undefined && raw[k] !== '' && !isNaN(Number(raw[k])) ? Number(raw[k]) : null);
  const queries = num('total.num.queries');
  const hits = num('total.num.cachehits');
  const yes = (k: string) => eff[k] === 'yes';
  const effective: UnboundSettings | null = eff['num-threads'] ? {
    num_threads: Number(eff['num-threads']), cache_mb: Math.round(Number(eff['msg-cache-size']) / MB * 10) / 10,
    cache_min_ttl: Number(eff['cache-min-ttl']), prefetch: yes('prefetch'), serve_expired: yes('serve-expired'),
    hide_identity: yes('hide-identity'), hide_version: yes('hide-version'),
  } : null;
  return {
    installed: true,
    running,
    listen: eff.interface && eff.port ? `${eff.interface.split(' ')[0]}:${eff.port}` : '',
    managed: fs.existsSync(PANEL_PATH),
    effective,
    settings: saved,
    recommended: RECOMMENDED,
    options: UNBOUND_OPTIONS,
    extendedStats: yes('extended-statistics'),
    stats: statsTxt ? {
      queries, cacheHits: hits, cacheMiss: num('total.num.cachemiss'),
      hitRate: queries && hits !== null ? Math.round((hits / queries) * 1000) / 10 : null,
      prefetch: num('total.num.prefetch'), servedExpired: num('total.num.expired'),
      recursionAvgMs: num('total.recursion.time.avg') !== null ? Math.round(num('total.recursion.time.avg')! * 1000) : null,
      recursionMedianMs: num('total.recursion.time.median') !== null ? Math.round(num('total.recursion.time.median')! * 1000) : null,
      uptimeS: num('time.up') !== null ? Math.round(num('time.up')!) : null,
      msgCacheCount: num('msg.cache.count'), rrsetCacheCount: num('rrset.cache.count'),
      secure: num('num.answer.secure'), bogus: num('num.answer.bogus'), servfail: num('num.answer.rcode.SERVFAIL'),
      memCacheBytes: num('mem.cache.message') !== null && num('mem.cache.rrset') !== null ? num('mem.cache.message')! + num('mem.cache.rrset')! : null,
    } : null,
    security: [
      { label: 'DNSSEC doğrulama', status: /validator/.test(eff['module-config'] || '') && !!eff['auto-trust-anchor-file'] },
      { label: 'DNSSEC çıkarma koruması', status: yes('harden-dnssec-stripped') },
      { label: 'Glue sıkılaştırma', status: yes('harden-glue') },
      { label: 'QNAME küçültme (gizlilik)', status: yes('qname-minimisation') },
      { label: 'Agresif NSEC', status: yes('aggressive-nsec') },
      { label: 'Kimlik gizleme', status: yes('hide-identity') },
      { label: 'Sürüm gizleme', status: yes('hide-version') },
    ],
    lastApply,
  };
}

// Ziyaret Geçmişi: hangi cihaz, ne zaman, hangi siteye girdi ve sitenin içerik türü (siteCategories.ts).
// Kaynak Pi-hole v6'nın sorgu kaydı (/api/queries, 30 sn'de bir; Pi-hole oturumu açık tutulur). DNS'e dayanır → SİTE düzeyi:
// HTTPS'te sayfanın yolu (adresin geri kalanı) ağdan görünmez. Pi-hole'u kullanmayan (şifreli DNS'li) cihaz görünmez.
// "Ziyaret" = tarayıcıyla girilen site; arka plan istekleri ayıklanır:
//  1) Ziyareti yalnız sitenin ANA adının sorgusu başlatır (site.com, www., m., …; uygulama adresleri — mail.google.com).
//     Alt adlar (api., cdn., static., telemetri) ve sitenin yan adları (ytimg.com → YouTube) açık ziyareti uzatır.
//  2) Altyapı / ölçüm / sertifika / güncelleme / reklam / şifreli DNS adları ziyaret sayılmaz (siteCategories).
//  3) Ön yükleme: tarayıcı, adres çubuğuna yazarken ve sayfadaki bağlantılar için adı önceden çözer. Ziyaret ancak sayfa
//     gerçekten yüklendiyse kesinleşir: 15 sn içinde 2+ başka ad ya da 2 dk içinde sitenin bir alt / yan adı.
//  4) Gömülü içerik: başka bir ziyaretin 4 sn içinde gelen gömülebilir site (YouTube videosu, harita, paylaş düğmesi).
//  5) Pi-hole'un engellediği reklam / izleyici sayılmaz; içerik engeli (yetişkin, kumar, ebeveyn kuralı) "engellendi" ile.
// Aynı cihazın aynı siteye 10 dk'dan kısa aralıklı istekleri tek ziyarettir (süre = ilk–son istek; DNS önbelleği yüzünden
// yaklaşık). Arka plan oturumları da nedenleriyle saklanır (sayfada "arka planı da göster"). 30 gün saklanır; yedeğe girmez.
import { getDomain } from 'tldts';
import { openFtl, type Ftl } from './piholeLists';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux } from './system';
import { NOISE_SUFFIXES } from './contentActivity';
import { readNeighbors6 } from './topology';
import { ensureLists } from './categoryLists';
import {
  categorize, ensureSiteCategories, APP_HOSTS, FAMILY, ALIAS, EMBEDDABLE, CONTENT_BLOCK_CATS, type SiteCat,
} from './siteCategories';

export const GAP_S = 600;          // aynı siteye bu kadar sessizlikten sonra yeni ziyaret
export const CONFIRM_S = 15;       // ön yükleme denetimi: sayfa yüklemesinin görüleceği süre
export const LATE_S = 120;         // geç gelen sayfa yüklemesi (yazıp bir süre sonra Enter): sitenin alt adı bu sürede
export const EMBED_S = 4;          // gömülü içerik: başka bir ziyaretin ana sorgusundan sonra bu süre içinde (gömülü çerçeve 1–3 sn'de yüklenir)
export const RETENTION_DAYS = 30;
const POLL_MS = 30000;
const LAG_S = 5;                   // FTL kaydı birkaç sn geriden gelebilir
const SLICE_S = 600;               // geriden gelirken 10 dk'lık dilimler (Pi-hole en yeniden başlayarak sayfalar)
const MAX_SLICES = 12;
const PAGE = 2000;
const MAX_PAGES = 10;
const CURSOR_KEY = 'visits_cursor';
const PRIMARY_PREFIX = new Set(['', 'www', 'www2', 'm', 'mobile', 'touch', 'web', 'tr', 'en', 'amp']);
const NOISE = new Set(NOISE_SUFFIXES);
const QTYPES = new Set(['A', 'AAAA', 'HTTPS']);
const isBlockedStatus = (s: string) =>
  /^(GRAVITY|REGEX|DENYLIST|SPECIAL_DOMAIN)(_CNAME)?$/.test(s) || s.startsWith('EXTERNAL_BLOCKED');

// ── Sınıflandırma (saf) ──────────────────────────────────────────────────────
export type HostInfo = { site: string; primary: boolean; cat: SiteCat; bg: string | null };
export function hostInfo(raw: string): HostInfo | null {
  const h = String(raw || '').toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h === 'hidden' || /^[\d.]+$/.test(h) || h.includes(':') || h.length > 253) return null;
  const labels = h.split('.');
  for (let i = 0; i < labels.length; i++) if (NOISE.has(labels.slice(i).join('.'))) return null;
  const withCat = (site: string, primary: boolean): HostInfo => {
    let c = categorize(h);
    if (!c.bg && c.cat === 'general' && site !== h) c = categorize(site);
    return { site, primary, cat: c.cat, bg: c.bg };
  };
  if (APP_HOSTS.has(h)) return withCat(h, true);
  for (const a of APP_HOSTS) if (h.endsWith(`.${a}`)) return withCat(a, false);
  const reg = getDomain(h, { allowPrivateDomains: true });
  if (!reg) return null;
  const fam = FAMILY[reg];
  const sub = h === reg ? '' : h.slice(0, -(reg.length + 1));
  return withCat(fam || ALIAS[reg] || reg, !fam && PRIMARY_PREFIX.has(sub));
}

// ── Oturumlar ────────────────────────────────────────────────────────────────
export type Kind = 'visit' | 'background' | 'pending';
export type Sess = {
  id?: number; dev: string; ip: string; name: string; site: string; host: string; cat: SiteCat;
  first: number; last: number; queries: number; blocked: boolean; kind: Kind; reason: string | null; subAt: number; dirty: boolean;
};
export type VQuery = { t: number; ip: string; host: string; blocked: boolean };
export type Client = { dev: string; name: string };
type DevState = { open: Map<string, Sess>; recent: { t: number; host: string }[]; lastNav: { t: number; site: string; cat: SiteCat } | null };

export class Sessionizer {
  devs = new Map<string, DevState>();
  closed: Sess[] = [];   // açık listesinden çıkıp henüz yazılmamış (aynı siteye yeni ziyaret başladı)

  private state(dev: string): DevState {
    let s = this.devs.get(dev);
    if (!s) { s = { open: new Map(), recent: [], lastNav: null }; this.devs.set(dev, s); }
    return s;
  }

  // Açılışta veritabanındaki hâlâ açık oturumlar (son istek GAP içinde) geri yüklenir: yeniden başlatma ziyareti bölmesin.
  restore(rows: Sess[]): void {
    for (const r of rows) this.state(r.dev).open.set(r.site, { ...r, subAt: 0, dirty: false });
  }

  ingest(qs: VQuery[], clients: Map<string, Client>): void {
    for (const q of [...qs].sort((a, b) => a.t - b.t)) {
      const info = hostInfo(q.host);
      if (!info) continue;
      const c = clients.get(q.ip) || { dev: `ip:${q.ip}`, name: q.ip };
      const st = this.state(c.dev);
      st.recent.push({ t: q.t, host: q.host });
      if (q.blocked && !info.primary) continue; // engellenen alt ad / reklam: yalnız etkinlik olarak sayılır
      const nav = info.primary && !info.bg && !q.blocked;
      const cur = st.open.get(info.site);
      if (cur && q.t - cur.last <= GAP_S && !(cur.kind === 'background' && nav)) {
        cur.last = Math.max(cur.last, q.t);
        cur.queries++;
        if (!info.primary && !cur.subAt) cur.subAt = q.t;
        if (q.blocked) cur.blocked = true;
        cur.dirty = true;
        continue;
      }
      let kind: Kind;
      let reason: string | null = null;
      let blocked = false;
      if (q.blocked) {
        if (!CONTENT_BLOCK_CATS.has(info.cat) || info.bg) continue; // reklam / izleyici engeli
        kind = 'visit';
        blocked = true;
      } else if (nav) {
        const prev = st.lastNav;
        if (prev && q.t - prev.t <= EMBED_S && prev.site !== info.site && prev.cat !== 'search' && EMBEDDABLE.has(info.site)) {
          kind = 'background';
          reason = 'gömülü içerik';
        } else {
          kind = 'pending';
          st.lastNav = { t: q.t, site: info.site, cat: info.cat };
        }
      } else {
        kind = 'background';
        reason = info.bg || 'arka plan (uygulama / alt adres)';
      }
      if (cur) this.closed.push(cur);
      st.open.set(info.site, {
        dev: c.dev, ip: q.ip, name: c.name, site: info.site, host: q.host.toLowerCase(), cat: info.cat, first: q.t, last: q.t,
        queries: 1, blocked, kind, reason, subAt: 0, dirty: true,
      });
    }
  }

  // Ön yükleme kararı: processedUntil'e kadarki istekler eksiksiz işlendi. Sayfa yüklendiyse ziyaret, LATE_S geçtiyse arka plan.
  decide(processedUntil: number): void {
    for (const st of this.devs.values()) {
      for (const s of st.open.values()) {
        if (s.kind !== 'pending') continue;
        const late = s.subAt && s.subAt - s.first <= LATE_S;
        let others = 0;
        if (processedUntil >= s.first + CONFIRM_S) {
          const seen = new Set<string>();
          for (const r of st.recent) if (r.t > s.first && r.t <= s.first + CONFIRM_S && r.host !== s.host) seen.add(r.host);
          others = seen.size;
        }
        if (others >= 2 || late) { s.kind = 'visit'; s.dirty = true; }
        else if (processedUntil > s.first + LATE_S) { s.kind = 'background'; s.reason = 'ön yükleme (sayfa açılmadı)'; s.dirty = true; }
      }
    }
  }

  // Yazılacaklar (bekleyen hariç) ve bellekten düşenler: son isteği GAP'ten eski oturum kapanır.
  takeDirty(nowS: number): Sess[] {
    const out = this.closed.filter(s => s.kind !== 'pending');
    this.closed = [];
    for (const [dev, st] of this.devs) {
      for (const [site, s] of st.open) {
        if (s.dirty && s.kind !== 'pending') out.push(s);
        if (nowS - s.last > GAP_S + LATE_S) st.open.delete(site);
      }
      st.recent = st.recent.filter(r => r.t > nowS - LATE_S - 60);
      if (!st.open.size && !st.recent.length) this.devs.delete(dev);
    }
    return out;
  }
}

// ── Cihaz adları ─────────────────────────────────────────────────────────────
// Pi-hole istemciyi IP'siyle kaydeder → panelin cihaz listesi (MAC + ad), IPv6 adresi komşu tablosundan MAC'e, Ev VPN'i
// istemcileri kendi adlarıyla. Bulunamazsa Pi-hole'un bildiği ad ya da IP.
async function resolveClients(ips: string[], piholeNames: Map<string, string>): Promise<Map<string, Client>> {
  const out = new Map<string, Client>();
  const devices = await dbAll('SELECT mac_address, ip_address, hostname FROM devices').catch(() => []) as { mac_address: string; ip_address: string; hostname: string }[];
  const byIp = new Map(devices.filter(d => d.ip_address).map(d => [d.ip_address, d]));
  const byMac = new Map(devices.map(d => [String(d.mac_address).toLowerCase(), d]));
  const peers = await dbAll('SELECT ip, name FROM wg_server_peers').catch(() => []) as { ip: string; name: string }[];
  const peerByIp = new Map(peers.map(p => [String(p.ip), String(p.name)]));
  const v6 = ips.some(ip => ip.includes(':')) ? await readNeighbors6() : new Map();
  for (const ip of ips) {
    const d = byIp.get(ip);
    if (d) { out.set(ip, { dev: String(d.mac_address).toLowerCase(), name: d.hostname || piholeNames.get(ip) || ip }); continue; }
    const mac = (v6.get(ip) as { mac?: string } | undefined)?.mac?.toLowerCase();
    if (mac) { const dm = byMac.get(mac); out.set(ip, { dev: mac, name: dm?.hostname || piholeNames.get(ip) || ip }); continue; }
    const peer = peerByIp.get(ip);
    if (peer) { out.set(ip, { dev: `vpn:${ip}`, name: `${peer} (Ev VPN'i)` }); continue; }
    out.set(ip, { dev: `ip:${ip}`, name: piholeNames.get(ip) || ip });
  }
  return out;
}

// ── Yazma ────────────────────────────────────────────────────────────────────
async function persist(rows: Sess[]): Promise<void> {
  for (const s of rows) {
    if (s.id) {
      await dbRun('UPDATE web_visits SET last_at = ?, queries = ?, blocked = ?, kind = ?, reason = ? WHERE id = ?',
        [Math.round(s.last), s.queries, s.blocked ? 1 : 0, s.kind, s.reason, s.id]);
    } else {
      s.id = await dbInsert(`INSERT INTO web_visits (device, ip, name, site, host, category, first_at, last_at, queries, blocked, kind, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.dev, s.ip, s.name, s.site, s.host, s.cat, Math.round(s.first), Math.round(s.last), s.queries, s.blocked ? 1 : 0, s.kind, s.reason]);
    }
    s.dirty = false;
  }
}

// ── Toplayıcı ────────────────────────────────────────────────────────────────
export type VisitStatus = { running: boolean; lastAt: number | null; cursorAt: number | null; error: string | null; note: string | null };
const sz = new Sessionizer();
let ftl: Ftl | null = null;
let cursor = 0;
let ticking = false;
let lastPrune = 0;
let status: VisitStatus = { running: false, lastAt: null, cursorAt: null, error: null, note: null };
export const visitStatus = () => status;

type RawQ = { id?: number; time?: number; type?: string; status?: string; domain?: string; client?: { ip?: string; name?: string } };
async function fetchRange(from: number, until: number): Promise<RawQ[] | 'auth'> {
  const got: RawQ[] = [];
  let cur: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = `from=${from}&until=${until}&length=${PAGE}${cur !== undefined ? `&cursor=${cur}&start=${page * PAGE}` : ''}`;
    const r = await ftl!.call('GET', `queries?${qs}`);
    if (r.status === 401) return 'auth';
    if (r.status >= 400 || !Array.isArray(r.json?.queries)) throw new Error(`HTTP ${r.status}`);
    got.push(...r.json.queries);
    if (r.json.queries.length < PAGE) return got;
    cur = Number(r.json.cursor);
  }
  console.warn(`[ziyaret] ${from}–${until} aralığında ${got.length}+ sorgu: sayfa sınırı, bir kısmı atlanmış olabilir`);
  return got;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    void ensureSiteCategories().catch(() => undefined);
    void ensureLists().catch(() => undefined);
    const until = Math.floor(Date.now() / 1000) - LAG_S;
    let hidden = 0, total = 0;
    for (let n = 0; n < MAX_SLICES && cursor < until; n++) {
      const end = Math.min(cursor + SLICE_S, until);
      let got: RawQ[] | 'auth' = 'auth';
      for (let attempt = 0; attempt < 2 && got === 'auth'; attempt++) {
        if (!ftl) ftl = await openFtl();
        got = await fetchRange(cursor, end);
        if (got === 'auth') ftl = null;
      }
      if (got === 'auth') throw new Error('Pi-hole oturumu açılamadı');
      const qs: VQuery[] = [];
      const names = new Map<string, string>();
      for (const q of got) {
        const t = Number(q.time), ip = String(q.client?.ip || '');
        if (!Number.isFinite(t) || t < cursor || t >= end || !ip || ip === '127.0.0.1' || ip === '::1') continue;
        if (!QTYPES.has(String(q.type || ''))) continue;
        total++;
        if (q.domain === 'hidden') { hidden++; continue; }
        if (q.client?.name && q.client.name !== ip) names.set(ip, String(q.client.name));
        qs.push({ t, ip, host: String(q.domain || ''), blocked: isBlockedStatus(String(q.status || '')) });
      }
      sz.ingest(qs, await resolveClients([...new Set(qs.map(q => q.ip))], names));
      cursor = end;
      sz.decide(cursor);
      await persist(sz.takeDirty(cursor));
    }
    await dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [CURSOR_KEY, String(cursor)]);
    if (Date.now() - lastPrune > 3600 * 1000) {
      lastPrune = Date.now();
      await dbRun('DELETE FROM web_visits WHERE last_at < ?', [Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400]);
    }
    status = {
      running: true, lastAt: Date.now(), cursorAt: cursor * 1000, error: null,
      note: total > 0 && hidden === total ? 'Pi-hole gizlilik düzeyi alan adlarını gizliyor — siteler görülemiyor' : null,
    };
  } catch (e: any) {
    const f = ftl;
    ftl = null;
    void f?.close().catch(() => undefined);
    status = { ...status, running: true, error: `Pi-hole sorgu kaydı okunamadı: ${String(e?.message || e).slice(0, 140)}` };
  } finally {
    ticking = false;
  }
}

// Yalnız ana cihazda (index.ts, uyduda başlatılmaz). Kaldığı yerden sürer (en çok 24 sa geriye), ilk açılışta son 1 sa.
export async function startVisits(): Promise<void> {
  if (!isLinux && !process.env.PI5_FTL_API) return;
  const nowS = Math.floor(Date.now() / 1000);
  const saved = Number((await dbGet('SELECT value FROM app_settings WHERE key = ?', [CURSOR_KEY]) as { value?: string } | undefined)?.value);
  cursor = Number.isFinite(saved) && saved > 0 ? Math.max(saved, nowS - 86400) : nowS - 3600;
  const open = await dbAll(`SELECT id, device AS dev, ip, name, site, host, category AS cat, first_at AS first, last_at AS last, queries,
    blocked, kind, reason FROM web_visits WHERE last_at > ?`, [cursor - GAP_S]) as any[];
  sz.restore(open.map(r => ({ ...r, blocked: !!r.blocked })));
  status = { ...status, running: true };
  setInterval(() => { void tick(); }, POLL_MS).unref?.();
  void tick();
}

// ── Sorgu (sayfa) ────────────────────────────────────────────────────────────
export type VisitFilter = { from: number; until: number; device?: string; cat?: string; q?: string; bg?: boolean; limit: number; offset: number };
export async function listVisits(f: VisitFilter) {
  const where = ['v.first_at >= ?', 'v.first_at < ?'];
  const args: any[] = [f.from, f.until];
  where.push(f.bg ? "v.kind IN ('visit', 'background')" : "v.kind = 'visit'");
  const facetWhere = [...where];
  const facetArgs = [...args];
  if (f.device) { where.push('v.device = ?'); args.push(f.device); }
  if (f.cat) { where.push('v.category = ?'); args.push(f.cat); }
  if (f.q) { where.push('(v.site LIKE ? OR v.host LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`); }
  const w = where.join(' AND ');
  const name = 'COALESCE(NULLIF(d.hostname, \'\'), v.name)';
  const [rows, total, devices, cats] = await Promise.all([
    dbAll(`SELECT v.id, v.device, ${name} AS name, v.ip, v.site, v.host, v.category, v.first_at, v.last_at, v.queries, v.blocked,
      v.kind, v.reason FROM web_visits v LEFT JOIN devices d ON d.mac_address = v.device COLLATE NOCASE WHERE ${w}
      ORDER BY v.first_at DESC, v.id DESC LIMIT ? OFFSET ?`, [...args, f.limit, f.offset]),
    dbGet(`SELECT COUNT(*) AS n FROM web_visits v WHERE ${w}`, args),
    dbAll(`SELECT v.device, ${name} AS name, COUNT(*) AS n FROM web_visits v LEFT JOIN devices d ON d.mac_address = v.device COLLATE NOCASE
      WHERE ${facetWhere.join(' AND ')} GROUP BY v.device ORDER BY n DESC`, facetArgs),
    dbAll(`SELECT v.category AS id, COUNT(*) AS n FROM web_visits v WHERE ${facetWhere.join(' AND ')}${f.device ? ' AND v.device = ?' : ''}
      GROUP BY v.category ORDER BY n DESC`, f.device ? [...facetArgs, f.device] : facetArgs),
  ]);
  return { visits: rows, total: Number((total as { n?: number })?.n || 0), devices, categories: cats };
}

export async function clearVisits(device?: string): Promise<number> {
  const before = await dbGet('SELECT COUNT(*) AS n FROM web_visits' + (device ? ' WHERE device = ?' : ''), device ? [device] : []) as { n: number };
  await dbRun('DELETE FROM web_visits' + (device ? ' WHERE device = ?' : ''), device ? [device] : []);
  for (const [dev, st] of sz.devs) if (!device || dev === device) st.open.clear();
  return Number(before?.n || 0);
}

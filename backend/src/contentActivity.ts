// Ağ haritası: cihaz başına anlık içerik türü — Ebeveyn Kontrol kategorileri (sosyal medya, video, oyun, mesajlaşma,
// yetişkin, kumar) + Genel. Kaynak Pi-hole v6'nın bellekteki sorgu kaydı (/api/queries): FTL veritabanına en geç 1 dk
// gecikmeyle yazar, API anlıktır. Bir cihaz son 5 dk'da bir türün alan adını sorduysa o türün rozeti yanar; o türdeki
// sorguların hepsi Pi-hole'da engellendiyse rozet "engellendi" olur.
//  - Sınıflandırma ebeveyn kurallarıyla aynı kaynaktan: CATEGORIES (parental.ts) alan adları alt alan adlarıyla, Yetişkin /
//    Kumar StevenBlack listeleri (categoryLists.ts: Routing ile ortak, günde bir indirilir, diskte önbellek). Hiçbirine
//    uymayan = Genel. Arka plan gürültüsü (bağlantı denetimi, saat, bildirim kanalı, telemetri, ters DNS, yerel adlar) sayılmaz.
//  - DNS'e dayanır: arka planda çalışan uygulama da görünür; Pi-hole'u kullanmayan (başka DNS'e ayarlı) cihaz görünmez.
//  - Yalnız harita açıkken (panel /api/topology/live?content=1 istedikçe) 10 sn'de bir okunur; 2 dk istek gelmezse durur,
//    Pi-hole oturumu kapanır, bellekteki kayıt silinir. Kiosk bu parametreyi göndermez.
import { CATEGORIES, type CategoryId } from './parental';
import { openFtl, type Ftl } from './piholeLists';
import { isLinux } from './system';
import { LIST_IDS, ensureLists, getList } from './categoryLists';

export { parseHostsList } from './categoryLists';

export type ContentCat = CategoryId | 'general';
export const CONTENT_ORDER: ContentCat[] = ['social', 'video', 'gaming', 'messaging', 'adult', 'gambling', 'general'];
// ageS: son sorgudan bu yana geçen sn; blocked: penceredeki sorguların hepsi engellendi; domains: en yeni 3 alan adı.
export type ContentBadge = { cat: ContentCat; ageS: number; queries: number; blocked: boolean; domains: string[] };
export type ContentStatus = { available: boolean; windowS: number; note: string | null };

export const WINDOW_S = 300;
const POLL_MS = 10000;
const IDLE_MS = 120000;
const PAGE = 2000;
const MAX_PAGES = 10;
const OVERLAP_S = 15;             // ardışık okumalar üst üste biner; aynı sorgu kimlik + zamanla bir kez sayılır
const MAX_EVENTS = 400;           // cihaz × tür başına bellekte en çok

// Yalnız ad çözme sorguları; PTR (ters DNS), SRV, TXT… içerik değildir.
const QTYPES = new Set(['A', 'AAAA', 'HTTPS']);
// Pi-hole v6 durumları: engellenenler (gravity / regex / kara liste, CNAME üzerinden olanlar, yukarı akışın engeli, özel ad).
const isBlockedStatus = (s: string) =>
  /^(GRAVITY|REGEX|DENYLIST|SPECIAL_DOMAIN)(_CNAME)?$/.test(s) || s.startsWith('EXTERNAL_BLOCKED');

// Arka plan gürültüsü: cihaz boştayken de sorulan adlar (Genel sayılsa her cihaz hep "Genel" görünürdü).
const NOISE_SUFFIXES = [
  'in-addr.arpa', 'ip6.arpa', 'local', 'lan', 'home.arpa', 'localdomain', 'internal', 'home', 'localhost',
  // bağlantı / captive portal denetimi
  'connectivitycheck.gstatic.com', 'connectivitycheck.android.com', 'clients3.google.com', 'captive.apple.com',
  'msftconnecttest.com', 'msftncsi.com', 'detectportal.firefox.com', 'nmcheck.gnome.org', 'connectivity-check.ubuntu.com',
  'network-test.debian.org',
  // saat
  'ntp.org', 'time.apple.com', 'time.windows.com', 'time.google.com', 'time.cloudflare.com', 'time.android.com',
  // bildirim kanalları
  'push.apple.com', 'mtalk.google.com', 'push.services.mozilla.com', 'notify.windows.com',
  // telemetri / çökme raporu
  'events.data.microsoft.com', 'settings-win.data.microsoft.com', 'app-measurement.com', 'crashlytics.com',
  'firebaselogging-pa.googleapis.com', 'metrics.icloud.com', 'xp.apple.com',
  // DoH işaretleri (ebeveyn kuralı bunları ayrıca engeller)
  'use-application-dns.net', 'mask.icloud.com', 'mask-h2.icloud.com', 'mask-api.icloud.com', 'wpad',
];
const NOISE = new Set(NOISE_SUFFIXES);

// Kategori alan adları → tür (en özel sonek kazanır).
const SUFFIX_CAT = new Map<string, ContentCat>();
for (const [id, c] of Object.entries(CATEGORIES) as [CategoryId, (typeof CATEGORIES)[CategoryId]][]) {
  for (const d of c.domains || []) if (!SUFFIX_CAT.has(d)) SUFFIX_CAT.set(d, id);
}

export type ListSets = Map<CategoryId, Set<string>>;
const loadedSets = (): ListSets => {
  const m: ListSets = new Map();
  for (const id of LIST_IDS) { const s = getList(id); if (s) m.set(id, s); }
  return m;
};

// Alan adı → tür; null = sayılmaz (gürültü / geçersiz). Soneklere en özelden genele bakılır: önce kategori alan adları,
// sonra hazır listeler (listeler tam ad içerir: "cdn.site.com" kaydı "a.cdn.site.com"u da kapsar).
export function classifyDomain(domain: string, sets: ListSets = loadedSets()): ContentCat | null {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!d.includes('.') || d === 'hidden' || /^[\d.]+$/.test(d) || d.includes(':')) return null;
  const labels = d.split('.');
  for (let i = 0; i < labels.length; i++) if (NOISE.has(labels.slice(i).join('.'))) return null;
  for (let i = 0; i < labels.length - 1; i++) {
    const s = labels.slice(i).join('.');
    const c = SUFFIX_CAT.get(s);
    if (c) return c;
    for (const [cat, set] of sets) if (set.has(s)) return cat;
  }
  return 'general';
}

// ── Toplama ──────────────────────────────────────────────────────────────────
type Ev = { t: number; domain: string; blocked: boolean };
const perClient = new Map<string, Map<ContentCat, Ev[]>>();
const seen = new Map<string, number>();   // `${id}|${time}` → zaman
// Penceredeki ad sorgusu sayısı (10 sn'lik kovalar): "hiç sorgu yok" / "hepsi gizli" notları için.
const buckets = new Map<number, { n: number; hidden: number }>();
function windowCounts(nowS: number): { n: number; hidden: number } {
  let n = 0, hidden = 0;
  for (const [b, c] of buckets) if (b * 10 + 10 > nowS - WINDOW_S) { n += c.n; hidden += c.hidden; }
  return { n, hidden };
}

export type RawQuery = { id?: number; time?: number; type?: string; status?: string; domain?: string; client?: { ip?: string } };

export function ingest(queries: RawQuery[], nowS: number): void {
  for (const q of queries) {
    const t = Number(q.time), ip = String(q.client?.ip || '');
    if (!Number.isFinite(t) || !ip || ip === '127.0.0.1' || ip === '::1') continue;
    const key = `${q.id}|${t}`;
    if (seen.has(key)) continue;
    seen.set(key, t);
    if (t < nowS - WINDOW_S) continue;
    if (!QTYPES.has(String(q.type || ''))) continue;
    const bk = Math.floor(t / 10);
    const b = buckets.get(bk) || { n: 0, hidden: 0 };
    b.n++;
    if (q.domain === 'hidden') b.hidden++;
    buckets.set(bk, b);
    if (q.domain === 'hidden') continue;
    const cat = classifyDomain(String(q.domain || ''));
    if (!cat) continue;
    let m = perClient.get(ip);
    if (!m) { m = new Map(); perClient.set(ip, m); }
    let evs = m.get(cat);
    if (!evs) { evs = []; m.set(cat, evs); }
    evs.push({ t, domain: String(q.domain).toLowerCase(), blocked: isBlockedStatus(String(q.status || '')) });
    if (evs.length > MAX_EVENTS) evs.splice(0, evs.length - MAX_EVENTS);
  }
  prune(nowS);
}

function prune(nowS: number): void {
  const cut = nowS - WINDOW_S;
  for (const [ip, m] of perClient) {
    for (const [cat, evs] of m) {
      const keep = evs.filter(e => e.t >= cut);
      if (keep.length) m.set(cat, keep); else m.delete(cat);
    }
    if (!m.size) perClient.delete(ip);
  }
  for (const [k, t] of seen) if (t < nowS - WINDOW_S - OVERLAP_S * 2) seen.delete(k);
  for (const b of buckets.keys()) if (b * 10 + 10 <= cut) buckets.delete(b);
}

// Bir cihazın (birden çok adresi olabilir: IPv4 + IPv6) rozetleri, CONTENT_ORDER sırasıyla.
export function contentForClients(ips: string[], nowS = Date.now() / 1000): ContentBadge[] {
  const byCat = new Map<ContentCat, Ev[]>();
  for (const ip of new Set(ips.filter(Boolean))) {
    for (const [cat, evs] of perClient.get(ip) || []) byCat.set(cat, [...(byCat.get(cat) || []), ...evs]);
  }
  const out: ContentBadge[] = [];
  for (const cat of CONTENT_ORDER) {
    const evs = (byCat.get(cat) || []).filter(e => e.t >= nowS - WINDOW_S).sort((a, b) => b.t - a.t);
    if (!evs.length) continue;
    const domains: string[] = [];
    for (const e of evs) { if (!domains.includes(e.domain)) domains.push(e.domain); if (domains.length === 3) break; }
    out.push({ cat, ageS: Math.max(0, Math.round(nowS - evs[0].t)), queries: evs.length, blocked: evs.every(e => e.blocked), domains });
  }
  return out;
}

// ── Örnekleyici ──────────────────────────────────────────────────────────────
let lastView = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let ftl: Ftl | null = null;
let running = false;
let fromS = 0;
let status: ContentStatus = { available: false, windowS: WINDOW_S, note: 'İçerik okunuyor…' };

const enabled = () => isLinux || !!process.env.PI5_FTL_API;

// Harita her istendiğinde çağrılır: örnekleyici uyuyorsa başlar.
export function noteContentView(): void {
  lastView = Date.now();
  if (timer || !enabled()) return;
  status = { available: false, windowS: WINDOW_S, note: 'İçerik okunuyor…' };
  timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();
  void tick();
}

export function contentStatus(): ContentStatus {
  if (!enabled()) return { available: false, windowS: WINDOW_S, note: 'İçerik yalnız Pi üzerinde okunur' };
  const w = windowCounts(Date.now() / 1000);
  if (status.available && w.n === 0) {
    return { ...status, note: 'Son 5 dk\'da DNS sorgusu görülmedi — cihazlar Pi-hole\'u kullanmıyor olabilir' };
  }
  if (status.available && w.hidden > 0 && w.hidden === w.n) {
    return { ...status, available: false, note: 'Pi-hole gizlilik düzeyi alan adlarını gizliyor — içerik ayırt edilemiyor' };
  }
  return status;
}

export function stopContent(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const f = ftl;
  ftl = null;
  void f?.close().catch(() => undefined);
  perClient.clear();
  seen.clear();
  buckets.clear();
  fromS = 0;
}

async function fetchSince(f: Ftl, from: number, until: number): Promise<RawQuery[] | 'auth'> {
  const got: RawQuery[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = `from=${Math.floor(from)}&until=${Math.ceil(until)}&length=${PAGE}${cursor !== undefined ? `&cursor=${cursor}&start=${page * PAGE}` : ''}`;
    const r = await f.call('GET', `queries?${qs}`);
    if (r.status === 401) return 'auth';
    if (r.status >= 400 || !Array.isArray(r.json?.queries)) throw new Error(`HTTP ${r.status}`);
    got.push(...r.json.queries);
    if (r.json.queries.length < PAGE) break;
    cursor = Number(r.json.cursor);
  }
  return got;
}

async function tick(): Promise<void> {
  if (running) return;
  if (Date.now() - lastView > IDLE_MS) { stopContent(); return; }
  running = true;
  try {
    void ensureLists().catch(() => undefined);
    const nowS = Date.now() / 1000;
    const from = fromS || nowS - WINDOW_S;
    let got: RawQuery[] | 'auth' = 'auth';
    for (let attempt = 0; attempt < 2 && got === 'auth'; attempt++) {
      if (!ftl) ftl = await openFtl();
      got = await fetchSince(ftl, from, nowS + 1);
      if (got === 'auth') ftl = null;   // oturum düştü (FTL yeniden başladı / süresi doldu): bir kez yeniden aç
    }
    if (got === 'auth') throw new Error('Pi-hole oturumu açılamadı');
    ingest(got, nowS);
    fromS = nowS - OVERLAP_S;
    status = { available: true, windowS: WINDOW_S, note: null };
  } catch (e: any) {
    const f = ftl;
    ftl = null;
    void f?.close().catch(() => undefined);
    status = { available: false, windowS: WINDOW_S, note: `Pi-hole sorgu kaydı okunamadı: ${String(e?.message || e).slice(0, 120)}` };
  } finally {
    running = false;
  }
}

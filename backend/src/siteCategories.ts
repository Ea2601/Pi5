// Site → içerik türü (Ziyaret Geçmişi, visits.ts). Kaynaklar, en özel alan adından genele, her düzeyde bu sırayla:
//  1) Yerleşik liste (aşağıda): Türkiye'de sık kullanılan siteler, arama / yapay zekâ / e-posta uygulama adları, kamu ve
//     eğitim uzantıları (gov.tr, edu.tr, k12.tr) — UT1 Fransa ağırlıklıdır, yerli siteler çoğunlukla orada yok.
//  2) Ebeveyn kontrolünün kategorileri (parental.ts CATEGORIES: sosyal, video, oyun, mesajlaşma, yetişkin, kumar).
//  3) Yetişkin / Kumar hazır listeleri (categoryLists.ts, StevenBlack — Routing ve ebeveyn kontrolüyle ortak).
//  4) UT1 (Toulouse 1 Capitole Üniversitesi) açık kategori listeleri — GitHub yansısı (olbat/ut1-blacklists, günlük
//     güncellenir); diskte önbellek, en çok günde bir indirilir, indirilemezse eski önbellekle sürer.
// Arka plan adları (CDN, ölçüm, sertifika, güncelleme, reklam, şifreli DNS) "ziyaret" sayılmaz: background nedeni döner.
import fs from 'fs';
import path from 'path';
import { CATEGORIES, type CategoryId } from './parental';
import { getList, parseHostsList } from './categoryLists';

export type SiteCat =
  | 'search' | 'social' | 'video' | 'music' | 'gaming' | 'messaging' | 'email' | 'news' | 'shopping' | 'finance'
  | 'government' | 'education' | 'sports' | 'jobs' | 'dating' | 'forum' | 'download' | 'ai' | 'vpn' | 'adult'
  | 'gambling' | 'general';
// Sıra = arayüzdeki sıra
export const SITE_CATS: { id: SiteCat; label: string }[] = [
  { id: 'search', label: 'Arama' }, { id: 'social', label: 'Sosyal medya' }, { id: 'video', label: 'Video' },
  { id: 'music', label: 'Müzik' }, { id: 'gaming', label: 'Oyun' }, { id: 'messaging', label: 'Mesajlaşma' },
  { id: 'email', label: 'E-posta' }, { id: 'news', label: 'Haber' }, { id: 'shopping', label: 'Alışveriş' },
  { id: 'finance', label: 'Banka / Finans' }, { id: 'government', label: 'Kamu' }, { id: 'education', label: 'Eğitim' },
  { id: 'sports', label: 'Spor' }, { id: 'jobs', label: 'İş ilanı' }, { id: 'dating', label: 'Arkadaşlık' },
  { id: 'forum', label: 'Forum / Blog' }, { id: 'download', label: 'İndirme' }, { id: 'ai', label: 'Yapay zekâ' },
  { id: 'vpn', label: 'VPN / Proxy' }, { id: 'adult', label: 'Yetişkin' }, { id: 'gambling', label: 'Kumar' },
  { id: 'general', label: 'Genel' },
];
// Engellense de "girmeye çalıştı" diye gösterilecek türler (reklam engeli değil, içerik engeli).
export const CONTENT_BLOCK_CATS = new Set<SiteCat>(['adult', 'gambling', 'social', 'video', 'gaming', 'messaging', 'dating', 'vpn']);

// ── 1) Yerleşik ──────────────────────────────────────────────────────────────
const BUILTIN: Partial<Record<SiteCat, string[]>> = {
  search: ['google.com', 'google.com.tr', 'bing.com', 'yandex.com', 'yandex.com.tr', 'duckduckgo.com', 'yahoo.com',
    'ecosia.org', 'startpage.com', 'search.brave.com', 'yaani.com.tr', 'qwant.com'],
  ai: ['chatgpt.com', 'openai.com', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'perplexity.ai',
    'deepseek.com', 'poe.com', 'character.ai', 'grok.com', 'mistral.ai', 'huggingface.co'],
  email: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com',
    'mail.yandex.com', 'mail.yandex.com.tr', 'proton.me', 'protonmail.com', 'gmx.com', 'yaani.mail'],
  news: ['hurriyet.com.tr', 'sabah.com.tr', 'sozcu.com.tr', 'milliyet.com.tr', 'cumhuriyet.com.tr', 'haberturk.com',
    'ntv.com.tr', 'cnnturk.com', 'aa.com.tr', 'trthaber.com', 't24.com.tr', 'ensonhaber.com', 'sondakika.com',
    'haber7.com', 'haberler.com', 'mynet.com', 'ahaber.com.tr', 'star.com.tr', 'yenisafak.com', 'karar.com', 'odatv.com',
    'halktv.com.tr', 'gazeteduvar.com.tr', 'bianet.org', 'diken.com.tr', 'medyascope.tv', 'takvim.com.tr', 'posta.com.tr',
    'yeniakit.com.tr', 'gazetevatan.com', 'birgun.net', 'evrensel.net', 'tele1.com.tr', 'onedio.com', 'webtekno.com',
    'shiftdelete.net', 'donanimhaber.com', 'chip.com.tr', 'bbc.com', 'bbc.co.uk', 'dw.com', 'euronews.com',
    'independentturkish.com', 'reuters.com', 'apnews.com', 'nytimes.com', 'theguardian.com', 'cnn.com'],
  sports: ['fanatik.com.tr', 'fotomac.com.tr', 'sporx.com', 'ajansspor.com', 'trtspor.com.tr', 'beinsports.com.tr',
    'ntvspor.net', 'aspor.com.tr', 'mackolik.com', 'sahadan.com', 'tff.org', 'espn.com', 'transfermarkt.com.tr',
    'transfermarkt.com', 'sofascore.com', 'flashscore.com', 'flashscore.com.tr'],
  shopping: ['trendyol.com', 'hepsiburada.com', 'n11.com', 'amazon.com.tr', 'amazon.com', 'ciceksepeti.com', 'getir.com',
    'yemeksepeti.com', 'migros.com.tr', 'a101.com.tr', 'sahibinden.com', 'letgo.com', 'dolap.com', 'teknosa.com',
    'mediamarkt.com.tr', 'vatanbilgisayar.com', 'boyner.com.tr', 'lcw.com', 'lcwaikiki.com', 'defacto.com.tr',
    'koton.com', 'akakce.com', 'cimri.com', 'epey.com', 'temu.com', 'aliexpress.com', 'ebay.com', 'shein.com', 'etsy.com',
    'pazarama.com', 'idefix.com', 'dr.com.tr', 'kitapyurdu.com', 'trendyolgo.com', 'carrefoursa.com', 'sokmarket.com.tr',
    'ikea.com.tr', 'ikea.com', 'zara.com', 'hm.com', 'arabam.com', 'emlakjet.com', 'hepsiemlak.com'],
  finance: ['ziraatbank.com.tr', 'garantibbva.com.tr', 'isbank.com.tr', 'akbank.com', 'yapikredi.com.tr', 'qnb.com.tr',
    'denizbank.com', 'vakifbank.com.tr', 'halkbank.com.tr', 'enpara.com', 'teb.com.tr', 'ing.com.tr', 'kuveytturk.com.tr',
    'albaraka.com.tr', 'odeabank.com.tr', 'sekerbank.com.tr', 'fibabanka.com.tr', 'papara.com', 'ininal.com',
    'paypal.com', 'wise.com', 'revolut.com', 'binance.com', 'binance.tr', 'btcturk.com', 'paribu.com', 'investing.com',
    'borsaistanbul.com', 'tradingview.com', 'kap.org.tr', 'doviz.com', 'bloomberght.com', 'paraanaliz.com'],
  jobs: ['kariyer.net', 'secretcv.com', 'yenibiris.com', 'eleman.net', 'indeed.com', 'iskur.gov.tr'],
  education: ['edu.tr', 'k12.tr', 'edu', 'ac.uk', 'eba.gov.tr', 'meb.gov.tr', 'osym.gov.tr', 'yok.gov.tr',
    'wikipedia.org', 'khanacademy.org', 'coursera.org', 'udemy.com', 'duolingo.com', 'quizlet.com', 'edx.org',
    'tureng.com', 'tdk.gov.tr', 'eodev.com', 'brainly.com', 'w3schools.com', 'stackoverflow.com', 'github.com'],
  government: ['gov.tr', 'bel.tr', 'tsk.tr', 'pol.tr', 'gov', 'gov.uk', 'europa.eu'],
  music: ['spotify.com', 'music.youtube.com', 'deezer.com', 'fizy.com', 'soundcloud.com', 'music.apple.com', 'tidal.com',
    'shazam.com', 'muud.com.tr', 'radyodinle.fm', 'powerapp.com.tr'],
  video: ['blutv.com', 'exxen.com', 'puhutv.com', 'gain.tv', 'tabii.com', 'tod.tv', 'trtizle.com', 'atv.com.tr',
    'kanald.com.tr', 'showtv.com.tr', 'startv.com.tr', 'nowtv.com.tr', 'tv8.com.tr', 'dizibox.com', 'dizipal.com'],
};
// Uygulamanın kendi adresi alt alan adıdır (ör. mail.google.com): ana site sayılır, ayrı satır olarak görünür.
export const APP_HOSTS = new Set(['mail.google.com', 'drive.google.com', 'docs.google.com', 'maps.google.com',
  'translate.google.com', 'news.google.com', 'photos.google.com', 'calendar.google.com', 'meet.google.com',
  'play.google.com', 'gemini.google.com', 'music.youtube.com', 'outlook.live.com', 'outlook.office.com',
  'outlook.office365.com', 'copilot.microsoft.com', 'mail.yahoo.com', 'mail.yandex.com', 'mail.yandex.com.tr',
  'web.whatsapp.com', 'web.telegram.org', 'open.spotify.com', 'music.apple.com', 'search.brave.com']);

// Aynı sitenin yan adları (CDN / kısa adres / medya) → sitenin adı. Yan adın sorgusu ziyaret BAŞLATMAZ, açık ziyareti uzatır.
export const FAMILY: Record<string, string> = {
  'youtu.be': 'youtube.com', 'ytimg.com': 'youtube.com', 'googlevideo.com': 'youtube.com',
  'fbcdn.net': 'facebook.com', 'fb.com': 'facebook.com', 'facebook.net': 'facebook.com', 'fbsbx.com': 'facebook.com',
  'cdninstagram.com': 'instagram.com', 'whatsapp.net': 'whatsapp.com', 'wa.me': 'whatsapp.com',
  'twimg.com': 'x.com', 't.co': 'x.com',
  'tiktokcdn.com': 'tiktok.com', 'tiktokv.com': 'tiktok.com', 'tiktokcdn-us.com': 'tiktok.com', 'byteoversea.com': 'tiktok.com',
  'ibytedtos.com': 'tiktok.com', 'nflxvideo.net': 'netflix.com', 'nflximg.net': 'netflix.com', 'nflxext.com': 'netflix.com',
  'nflxso.net': 'netflix.com', 'scdn.co': 'spotify.com', 'spotifycdn.com': 'spotify.com', 'ttvnw.net': 'twitch.tv',
  'jtvnw.net': 'twitch.tv', 'redd.it': 'reddit.com', 'redditmedia.com': 'reddit.com', 'redditstatic.com': 'reddit.com',
  'licdn.com': 'linkedin.com', 'discordapp.com': 'discord.com', 'discordapp.net': 'discord.com', 'discord.gg': 'discord.com',
  'discord.media': 'discord.com', 't.me': 'telegram.org', 'telegram.me': 'telegram.org', 'pinimg.com': 'pinterest.com',
  'sc-cdn.net': 'snapchat.com', 'snapkit.com': 'snapchat.com', 'dmcdn.net': 'dailymotion.com', 'vimeocdn.com': 'vimeo.com',
  'steamstatic.com': 'steampowered.com', 'steamcontent.com': 'steampowered.com', 'steamserver.net': 'steampowered.com',
  'rbxcdn.com': 'roblox.com', 'oaistatic.com': 'chatgpt.com', 'oaiusercontent.com': 'chatgpt.com',
  'trendyol-cdn.com': 'trendyol.com', 'hepsiburada.net': 'hepsiburada.com',
  'sahibinden.net': 'sahibinden.com', 'shbdn.com': 'sahibinden.com',
};
// Aynı sitenin başka ANA adresi (ülke uzantısı / eski ad): ziyaret başlatır, sitenin adıyla görünür.
export const ALIAS: Record<string, string> = { 'google.com.tr': 'google.com', 'twitter.com': 'x.com', 'yandex.com.tr': 'yandex.com' };
// Başka bir sayfaya gömülü olarak da yüklenen siteler: başka bir ziyaretin hemen ardından gelirse "gömülü içerik".
export const EMBEDDABLE = new Set(['youtube.com', 'vimeo.com', 'dailymotion.com', 'facebook.com', 'instagram.com', 'x.com',
  'tiktok.com', 'google.com', 'spotify.com', 'soundcloud.com', 'linkedin.com', 'pinterest.com', 'reddit.com', 'twitch.tv',
  'disqus.com', 'maps.google.com']);

// Arka plan: sayfaların ve uygulamaların kullandığı altyapı — ana adı sorulsa da ziyaret sayılmaz.
const BACKGROUND: Record<string, string[]> = {
  'altyapı (CDN)': ['gstatic.com', 'googleapis.com', 'googleusercontent.com', 'ggpht.com', 'gvt1.com', 'gvt2.com', 'gvt3.com',
    '1e100.net', 'youtube-nocookie.com', 'akamai.net', 'akamaihd.net', 'akamaized.net', 'akamaiedge.net',
    'akamaitechnologies.com', 'edgekey.net', 'edgesuite.net', 'cloudfront.net', 'amazonaws.com', 'awsstatic.com',
    'media-amazon.com', 'ssl-images-amazon.com', 'fastly.net', 'fastlylb.net', 'fastly-edge.com', 'cdn77.org', 'jsdelivr.net',
    'unpkg.com', 'cdnjs.com', 'azureedge.net', 'azurefd.net', 'trafficmanager.net', 'msedge.net', 'apple-dns.net',
    'aaplimg.com', 'icloud-content.com', 'mzstatic.com', 'cdn-apple.com', 'apple-cloudkit.com', 'mncdn.com', 'yastatic.net',
    'yandex.net', 'wp.com', 'gravatar.com', 'typekit.net', 'fonts.net', 'bootstrapcdn.com',
    'cloudflareinsights.com', 'cloudflarestream.com', 'recaptcha.net', 'hcaptcha.com', 'firebaseio.com', 'appspot.com',
    'googleoptimize.com', 'gstatic.cn', 'sharethis.com', 'addthis.com', 'onetrust.com', 'cookielaw.org', 'cookiebot.com'],
  'ölçüm / reklam': ['googletagmanager.com', 'google-analytics.com', 'googlesyndication.com', 'googleadservices.com',
    'doubleclick.net', 'app-measurement.com', 'crashlytics.com', 'sentry.io', 'sentry-cdn.com', 'newrelic.com', 'nr-data.net',
    'hotjar.com', 'hotjar.io', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'branch.io', 'app.link',
    'appsflyer.com', 'adjust.com', 'onesignal.com', 'braze.com', 'clarity.ms', 'bugsnag.com', 'datadoghq.com',
    'scorecardresearch.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'adnxs.com',
    'mc.yandex.ru', 'facebook.net'],
  'sertifika denetimi': ['digicert.com', 'lencr.org', 'pki.goog', 'sectigo.com', 'usertrust.com', 'globalsign.com',
    'entrust.net', 'identrust.com', 'comodoca.com'],
  'güncelleme': ['windowsupdate.com', 'update.microsoft.com', 'delivery.mp.microsoft.com', 'swcdn.apple.com',
    'mesu.apple.com', 'update.googleapis.com', 'dl.google.com', 'play.googleapis.com'],
};
// facebook.net hem aile hem ölçüm: Facebook'un "beğen / piksel" betiği — ziyaret başlatmaz (aile kuralı da başlatmaz).

const BUILTIN_CAT = new Map<string, SiteCat>();
for (const [cat, list] of Object.entries(BUILTIN) as [SiteCat, string[]][]) for (const d of list) if (!BUILTIN_CAT.has(d)) BUILTIN_CAT.set(d, cat);
const PARENTAL_MAP: Record<CategoryId, SiteCat> = { social: 'social', video: 'video', gaming: 'gaming', messaging: 'messaging', adult: 'adult', gambling: 'gambling' };
const PARENTAL_CAT = new Map<string, SiteCat>();
for (const [id, c] of Object.entries(CATEGORIES) as [CategoryId, (typeof CATEGORIES)[CategoryId]][]) {
  for (const d of c.domains || []) if (!PARENTAL_CAT.has(d)) PARENTAL_CAT.set(d, PARENTAL_MAP[id]);
}
const BG_REASON = new Map<string, string>();
for (const [reason, list] of Object.entries(BACKGROUND)) for (const d of list) if (!BG_REASON.has(d)) BG_REASON.set(d, reason);

// ── 4) UT1 ───────────────────────────────────────────────────────────────────
const UT1_BASE = 'https://raw.githubusercontent.com/olbat/ut1-blacklists/master/blacklists';
// Sıra öncelik: bir ad birden çok listedeyse öndeki kazanır. bg: ziyaret sayılmaz (nedeni).
const UT1: { name: string; cat?: SiteCat; bg?: string }[] = [
  { name: 'doh', bg: 'şifreli DNS' }, { name: 'publicite', bg: 'ölçüm / reklam' }, { name: 'update', bg: 'güncelleme' },
  { name: 'bank', cat: 'finance' }, { name: 'financial', cat: 'finance' }, { name: 'webmail', cat: 'email' },
  { name: 'social_networks', cat: 'social' }, { name: 'chat', cat: 'messaging' }, { name: 'dating', cat: 'dating' },
  { name: 'audio-video', cat: 'video' }, { name: 'radio', cat: 'music' }, { name: 'games', cat: 'gaming' },
  { name: 'press', cat: 'news' }, { name: 'sports', cat: 'sports' }, { name: 'shopping', cat: 'shopping' },
  { name: 'jobsearch', cat: 'jobs' }, { name: 'vpn', cat: 'vpn' }, { name: 'download', cat: 'download' },
  { name: 'filehosting', cat: 'download' }, { name: 'forums', cat: 'forum' }, { name: 'blog', cat: 'forum' },
];
type Ut1Hit = { cat?: SiteCat; bg?: string };
let ut1Map = new Map<string, Ut1Hit>();
const ut1Sets = new Map<string, Set<string>>(); // ad → küme (şifreli DNS engeli de "doh"u kullanır)
const CACHE_DIR = process.env.PI5_SITECAT_CACHE || '/var/cache/pi5-gateway/site-categories';
const MAX_AGE_MS = 24 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;
let checkedAt = 0;
let loadedAt = 0;
let lastError: string | null = null;
let refreshing: Promise<void> | null = null;

function rebuild() {
  const m = new Map<string, Ut1Hit>();
  for (const l of UT1) for (const d of ut1Sets.get(l.name) || []) if (!m.has(d)) m.set(d, l.cat ? { cat: l.cat } : { bg: l.bg });
  ut1Map = m;
}

export function ut1List(name: string): Set<string> | undefined {
  const s = ut1Sets.get(name);
  return s && s.size ? s : undefined;
}

export function siteCategoryInfo() {
  return { source: 'UT1 (olbat/ut1-blacklists) + yerleşik liste', domains: ut1Map.size, updatedAt: loadedAt ? new Date(loadedAt).toISOString() : null, error: lastError };
}

// Önbellekten okur; yoksa ya da günden eskiyse indirir (başarısızsa 30 dk sonra yeniden, eldeki liste korunur).
export function ensureSiteCategories(): Promise<void> {
  if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}
async function refresh(): Promise<void> {
  const file = (n: string) => path.join(CACHE_DIR, `${n}.txt`);
  if (!loadedAt) {
    let newest = 0;
    for (const l of UT1) {
      try {
        const st = fs.statSync(file(l.name));
        ut1Sets.set(l.name, parseHostsList(fs.readFileSync(file(l.name), 'utf8')));
        newest = Math.max(newest, st.mtimeMs);
      } catch { /* önbellek yok */ }
    }
    if (ut1Sets.size) { rebuild(); loadedAt = newest; }
  }
  if (loadedAt && Date.now() - loadedAt < MAX_AGE_MS) return;
  if (Date.now() - checkedAt < RETRY_MS) return;
  checkedAt = Date.now();
  const errors: string[] = [];
  for (const l of UT1) {
    try {
      const r = await fetch(`${UT1_BASE}/${l.name}/domains`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const set = parseHostsList(text);
      if (!set.size) throw new Error('boş liste');
      ut1Sets.set(l.name, set);
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(`${file(l.name)}.tmp`, text);
        fs.renameSync(`${file(l.name)}.tmp`, file(l.name));
      } catch { /* salt okunur: yalnız bellekte */ }
    } catch (e: any) {
      errors.push(`${l.name}: ${String(e?.message || e).slice(0, 60)}`);
    }
  }
  rebuild();
  if (errors.length < UT1.length) loadedAt = Date.now();
  lastError = errors.length ? `UT1 listeleri kısmen indirilemedi (${errors.slice(0, 3).join('; ')})` : null;
  if (lastError) console.warn(`[site-categories] ${lastError}`);
}

// Alan adı → { tür, arka plan nedeni }. Sonek düzeyleri en özelden genele; her düzeyde kaynak sırası yukarıdaki gibi.
export function categorize(host: string): { cat: SiteCat; bg: string | null } {
  const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  const adult = getList('adult'), gambling = getList('gambling');
  for (let i = 0; i < labels.length; i++) {
    const s = labels.slice(i).join('.');
    const bg = BG_REASON.get(s);
    if (bg) return { cat: 'general', bg };
    const b = BUILTIN_CAT.get(s) || PARENTAL_CAT.get(s);
    if (b) return { cat: b, bg: null };
    if (i < labels.length - 1) {
      if (adult?.has(s)) return { cat: 'adult', bg: null };
      if (gambling?.has(s)) return { cat: 'gambling', bg: null };
    }
    const u = ut1Map.get(s);
    if (u) return u.cat ? { cat: u.cat, bg: null } : { cat: 'general', bg: u.bg || 'arka plan' };
  }
  return { cat: 'general', bg: null };
}

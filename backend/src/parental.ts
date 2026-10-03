// Ebeveyn kontrolleri. Kural = kime (cihazlar + Cihaz Yönetimi grupları) × neyi (tüm internet | kategoriler + siteler) ×
// ne zaman (her zaman | saat aralıklarında engelle | yalnız saat aralıklarında izin ver). Eskiden kurallar yalnız
// veritabanındaydı, hiçbir şey engellenmiyordu (pi5-check.sh "yalnız DB"). Artık uygulanır:
//  - Tüm internet: nftables `inet pi5_parental` (forward, öncelik -10): kuralı o an etkin cihazın MAC'inden gelen her
//    paket düşer. Pi'yi ağ geçidi olarak kullanan cihazlarda çalışır (Cihaz Yönetimi'ndeki "engelle" ile aynı sınır).
//  - Kategori / site: Pi-hole v6 grupları (API). Kural başına "klyrix-ebeveyn-<id>" grubu; hedef cihazlar (MAC) o gruba
//    da üye olur, Default grubu korunur (normal reklam engeli sürer). Kategori alan adları ve siteler düzenli ifade,
//    Yetişkin / Kumar hazır listeleri bloklistesi olarak yalnız bu gruba bağlanır. Grup, kuralın saatine göre açılıp kapanır.
//  - DNS atlatma: kategori/site kuralına giren cihazlarda dış DNS (53/853) ve bilinen DoH sunucuları (443) güvenlik
//    duvarında; Firefox DoH işareti, iCloud Özel Geçiş ve DoH adları Pi-hole'da ("klyrix-ebeveyn-dns" grubu) engellenir.
//    Kural açık olduğu sürece (saatinden bağımsız) geçerlidir.
//  - Zamanlayıcı 30 sn'de bir durumu hesaplar, yalnız değişeni uygular. Kural değişince ve açılışta tam eşitleme.
//  - Eski (v1) kurallar kapalı olarak yeni biçime taşınır: güncellemeyle birden devreye girmesinler.
//  - Tüm ağ hedefi (targets.all; Koruma Şablonları — templates.ts): yalnız kategori / site ve "her zaman". Kayıtlar Pi-hole'un
//    Default grubuna bağlanır (dns_guard_all dalının deseni); kendi grubu, istemcisi ve güvenlik duvarı kuralı yoktur.
//    Şablonun oluşturduğu kural template_id taşır (geri alma yalnız onu ve yalnız değişmemişse siler).
// Pi-hole kayıtları açıklamada "klyrix-ebeveyn" ile işaretlenir; piholeLists.ts'in eşitlemesi ("klyrix" / "klyrix:")
// bunları kendisininki saymaz. Başkasının (kullanıcının) kaydına yalnız kendi grubumuz eklenir / çıkarılır.
import { spawn } from 'child_process';
import { dbAll, dbGet, dbInsert, dbRun } from './db';
import { isLinux } from './system';
import { openFtl, startGravity, type Ftl } from './piholeLists';
import { LIST_SOURCES } from './categoryLists';

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type Mode = 'always' | 'during' | 'outside';
export type CategoryId = 'social' | 'video' | 'gaming' | 'messaging' | 'adult' | 'gambling';
export interface TimeWindow { days: Day[]; start: string; end: string }
export interface ParentalRule {
  id: number; name: string; enabled: boolean;
  // all: tüm ağ (Pi-hole Default grubu) — yalnız true olarak bulunur; cihaz / grup listeleri o zaman boş
  targets: { devices: string[]; groups: number[]; all?: true };
  blockAll: boolean; categories: CategoryId[]; sites: string[];
  mode: Mode; windows: TimeWindow[];
  legacy: boolean;   // eski sürümden taşındı (kapalı geldi, gözden geçirilmeli)
  templateId?: number;   // Koruma Şablonları kaydı (policy_templates.id); yalnız şablonun oluşturduğu kuralda bulunur
}
export interface RuleStatus { active: boolean; nextChange: string | null; devices: number }

const ALL_DAYS: Day[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const JS_DAYS: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];   // Date.getDay() sırası
const MARK = 'klyrix-ebeveyn';
const GROUP_PREFIX = 'klyrix-ebeveyn-';
const DNS_GROUP = 'klyrix-ebeveyn-dns';
const NFT_TABLE = 'pi5_parental';
// Tüm ağda şifreli DNS engeli (Ziyaret Geçmişi sayfasındaki anahtar; varsayılan kapalı). Açıkken ev ağından (özel IPv4)
// gelen DNS (53) Pi-hole'a YÖNLENDİRİLİR (elle 8.8.8.8 yazılmış cihaz çalışmayı sürdürür, Pi-hole'dan geçer); DoT (853) ve
// bilinen DoH sunucularına 443 kesilir; Pi-hole'da DoH adları (yerleşik + UT1 "doh" listesi) herkese (Default grup)
// engellenir. VPS tünellerinden gelen (wg_vps*) ve Pi'nin kendi trafiği muaf. Yalnız IPv4: IPv6'yı modem dağıtıyorsa o
// trafik Pi'den geçmez. Firefox DoH işareti, iCloud Özel Geçiş ve DDR (resolver.arpa) Pi-hole'un kendi varsayılanında kapalı.
const GUARD_ALL_KEY = 'dns_guard_all';
const UT1_DOH_LIST = 'https://raw.githubusercontent.com/olbat/ut1-blacklists/master/blacklists/doh/domains';
const DEFAULT_GROUP = 'Default';
const TICK_MS = 30000;
const FULL_SYNC_MS = 15 * 60 * 1000;   // kendini onarma: Pi-hole yeniden kurulsa / elle değiştirilse de

// ── Kategoriler ──────────────────────────────────────────────────────────────
// Alan adları alt alan adlarıyla birlikte engellenir. Uygulamaların bir kısmı (WhatsApp, Telegram) ayrıca doğrudan IP'ye de
// bağlanabilir: DNS engeli yeni bağlantıyı keser, açık kalmış bir bağlantı bir süre sürebilir.
export const CATEGORIES: Record<CategoryId, { label: string; desc: string; domains?: string[]; lists?: string[] }> = {
  social: {
    label: 'Sosyal medya', desc: 'Instagram, TikTok, Facebook, X, Snapchat, Reddit, Pinterest, Threads',
    domains: ['facebook.com', 'fbcdn.net', 'fb.com', 'instagram.com', 'cdninstagram.com', 'threads.net', 'twitter.com', 'x.com',
      'twimg.com', 't.co', 'tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'byteoversea.com', 'ibytedtos.com',
      'snapchat.com', 'snapkit.com', 'sc-cdn.net', 'snap-dev.net', 'pinterest.com', 'pinimg.com', 'reddit.com', 'redd.it',
      'redditmedia.com', 'redditstatic.com', 'tumblr.com', 'bsky.app', 'vk.com', 'ask.fm'],
  },
  video: {
    label: 'Video ve yayın', desc: 'YouTube, Netflix, Twitch, Kick, Disney+, Prime Video, yerli platformlar',
    domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'youtube-nocookie.com', 'youtubei.googleapis.com',
      'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflxext.com', 'nflxso.net', 'twitch.tv', 'ttvnw.net', 'jtvnw.net',
      'kick.com', 'disneyplus.com', 'dssott.com', 'bamgrid.com', 'disney-plus.net', 'primevideo.com', 'aiv-cdn.net',
      'aiv-delivery.net', 'hulu.com', 'max.com', 'hbomax.com', 'dailymotion.com', 'dmcdn.net', 'vimeo.com', 'vimeocdn.com',
      'blutv.com', 'exxen.com', 'puhutv.com', 'gain.tv', 'tabii.com', 'tod.tv', 'mubi.com'],
  },
  gaming: {
    label: 'Oyun', desc: 'Steam, Epic, Roblox, Fortnite, Minecraft, PlayStation, Xbox, Riot, Battle.net, EA',
    domains: ['steampowered.com', 'steamcommunity.com', 'steamcontent.com', 'steamserver.net', 'steamstatic.com',
      'epicgames.com', 'epicgames.dev', 'fortnite.com', 'roblox.com', 'rbxcdn.com', 'robloxlabs.com', 'minecraft.net',
      'minecraftservices.com', 'mojang.com', 'playstation.com', 'playstation.net', 'sonyentertainmentnetwork.com',
      'xboxlive.com', 'xbox.com', 'ea.com', 'origin.com', 'riotgames.com', 'leagueoflegends.com', 'playvalorant.com',
      'battle.net', 'blizzard.com', 'supercell.com', 'garena.com', 'pubgmobile.com', 'miniclip.com', 'brawlstars.com',
      'clashofclans.com', 'poki.com', 'crazygames.com', 'friv.com'],
  },
  messaging: {
    label: 'Mesajlaşma', desc: 'WhatsApp, Telegram, Discord, Messenger, Signal, Viber',
    domains: ['whatsapp.com', 'whatsapp.net', 'wa.me', 'telegram.org', 'telegram.me', 't.me', 'discord.com', 'discord.gg',
      'discordapp.com', 'discordapp.net', 'discord.media', 'signal.org', 'messenger.com', 'viber.com', 'line.me', 'wechat.com'],
  },
  adult: {
    label: 'Yetişkin içerik', desc: 'Hazır liste: StevenBlack (porn-only), düzenli güncellenir',
    lists: LIST_SOURCES.adult.urls,   // Routing ve ağ haritasıyla aynı kaynak (categoryLists.ts)
  },
  gambling: {
    label: 'Kumar ve bahis', desc: 'Hazır liste: StevenBlack (gambling-only), düzenli güncellenir',
    lists: LIST_SOURCES.gambling.urls,
  },
};
const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

// DNS atlatma: Firefox'un DoH'u kapatma işareti, iCloud Özel Geçiş (Private Relay) ve yaygın DoH / DoT adları.
export const DOH_DOMAINS = ['use-application-dns.net', 'mask.icloud.com', 'mask-h2.icloud.com', 'mask-api.icloud.com', 'dns.google',
  'dns64.dns.google', 'cloudflare-dns.com', 'one.one.one.one', 'dns.quad9.net', 'doh.opendns.com', 'dns.adguard.com',
  'dns.adguard-dns.com', 'doh.cleanbrowsing.org', 'dns.nextdns.io', 'doh.mullvad.net', 'dns.controld.com', 'doh.dns.sb'];
const DOH_V4 = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '94.140.14.14', '94.140.15.15',
  '208.67.222.222', '208.67.220.220', '185.228.168.168', '185.228.169.168', '76.76.2.0', '76.76.10.0'];
const DOH_V6 = ['2606:4700:4700::1111', '2606:4700:4700::1001', '2001:4860:4860::8888', '2001:4860:4860::8844',
  '2620:fe::fe', '2620:fe::9', '2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'];

const esc = (d: string) => d.replace(/[.+^$()|[\]\\{}?*]/g, m => `\\${m}`);
const domainRegex = (domains: string[]) => `(^|\\.)(${domains.map(esc).join('|')})$`;

// ── Doğrulama / dönüşüm ──────────────────────────────────────────────────────
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDay = (d: unknown): d is Day => typeof d === 'string' && (ALL_DAYS as string[]).includes(d);

// Kullanıcının yazdığı site → alan adı ("https://www.site.com/yol" → "site.com"). Geçersizse null.
export function normalizeSite(raw: unknown): string | null {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN.test(s) ? s : null;
}

export function validateRule(body: any): { rule: Omit<ParentalRule, 'id' | 'legacy'> } | { error: string } {
  const calErr = calendarRuleError(body);   // takvim kuralı (G5.3): ayrı denetim, aşağıda
  if (calErr) return { error: calErr };
  const name = String(body?.name ?? '').trim().slice(0, 60);
  const devices = [...new Set((Array.isArray(body?.targets?.devices) ? body.targets.devices : []).map((m: unknown) => String(m).toLowerCase()))] as string[];
  const groups = [...new Set((Array.isArray(body?.targets?.groups) ? body.targets.groups : []).map(Number))] as number[];
  if (devices.some(m => !MAC.test(m))) return { error: 'Geçersiz cihaz (MAC adresi)' };
  if (groups.some(g => !Number.isInteger(g) || g <= 0)) return { error: 'Geçersiz cihaz grubu' };
  // Tüm ağ (yalnız açıkça true): cihaz / grup seçimiyle birlikte olamaz. Yoksa eskisi gibi en az bir hedef.
  const all = body?.targets?.all === true;
  if (all && (devices.length || groups.length)) return { error: 'Tüm ağ hedefi cihaz ya da grup seçimiyle birlikte kullanılamaz' };
  if (!all && !devices.length && !groups.length) return { error: 'En az bir cihaz ya da grup seçin' };
  if (devices.length > 100 || groups.length > 50) return { error: 'Çok fazla hedef' };
  const blockAll = !!body?.blockAll;
  const categories = [...new Set(Array.isArray(body?.categories) ? body.categories : [])] as CategoryId[];
  if (categories.some(c => !CATEGORY_IDS.includes(c))) return { error: 'Bilinmeyen kategori' };
  const rawSites = Array.isArray(body?.sites) ? body.sites : [];
  if (rawSites.length > 200) return { error: 'En çok 200 site eklenebilir' };
  const sites: string[] = [];
  for (const s of rawSites) {
    const n = normalizeSite(s);
    if (!n) return { error: `Geçersiz site: ${String(s).slice(0, 80)}` };
    if (!sites.includes(n)) sites.push(n);
  }
  if (!blockAll && !categories.length && !sites.length) return { error: 'Neyin engelleneceğini seçin: tüm internet, kategori ya da site' };
  const mode: Mode = body?.mode === 'during' || body?.mode === 'outside' ? body.mode : 'always';
  const rawWin = Array.isArray(body?.windows) ? body.windows : [];
  if (rawWin.length > 10) return { error: 'En çok 10 saat aralığı eklenebilir' };
  const windows: TimeWindow[] = [];
  for (const w of rawWin) {
    const days = [...new Set(Array.isArray(w?.days) ? w.days : [])].filter(isDay) as Day[];
    if (!days.length) return { error: 'Her saat aralığında en az bir gün seçin' };
    if (!HHMM.test(String(w?.start)) || !HHMM.test(String(w?.end))) return { error: 'Saat SS:DD biçiminde olmalı' };
    windows.push({ days: ALL_DAYS.filter(d => days.includes(d)), start: String(w.start), end: String(w.end) });
  }
  if (mode !== 'always' && !windows.length) return { error: 'En az bir saat aralığı ekleyin' };
  // Tüm ağda "tüm internet" modemi ve Pi'yi de keserdi; saat aralığı Pi-hole'un Default grubunu aç / kapa gerektirirdi
  // (grup panelin değil, kapanırsa tüm evin reklam engeli de kalkar).
  if (all && blockAll) return { error: 'Tüm ağda tüm internet engellenemez — kategori ya da site seçin' };
  if (all && mode !== 'always') return { error: 'Tüm ağ hedefi yalnız "her zaman" ile kullanılabilir — saat aralığı için cihaz ya da grup seçin' };
  return {
    rule: {
      name, enabled: body?.enabled === undefined ? true : !!body.enabled, targets: all ? { devices: [], groups: [], all: true } : { devices, groups },
      blockAll, categories: blockAll ? [] : categories, sites: blockAll ? [] : sites, mode, windows: mode === 'always' ? [] : windows,
    },
  };
}

// ── Zaman ────────────────────────────────────────────────────────────────────
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// Aralık gece yarısını aşabilir (22:00–07:00: başladığı günün gecesinden ertesi sabaha). Başlangıç = bitiş: o gün boyunca.
export function windowActive(w: TimeWindow, d: Date): boolean {
  const today = JS_DAYS[d.getDay()], yesterday = JS_DAYS[(d.getDay() + 6) % 7];
  const now = d.getHours() * 60 + d.getMinutes();
  const s = minutes(w.start), e = minutes(w.end);
  if (s === e) return w.days.includes(today);
  if (s < e) return w.days.includes(today) && now >= s && now < e;
  return (w.days.includes(today) && now >= s) || (w.days.includes(yesterday) && now < e);
}
export function ruleActive(r: ParentalRule, d: Date): boolean {
  if (!r.enabled) return false;
  if (r.mode === 'always') return true;
  const inside = r.windows.some(w => windowActive(w, d));
  return r.mode === 'during' ? inside : !inside;
}
// Durumun değişeceği ilk dakika (en çok 8 gün ileri); değişmiyorsa null.
export function nextChange(r: ParentalRule, d: Date): Date | null {
  if (!r.enabled || r.mode === 'always') return null;
  const cur = ruleActive(r, d);
  const t = new Date(d);
  t.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 1440; i++) {
    t.setTime(t.getTime() + 60000);
    if (ruleActive(r, t) !== cur) return new Date(t);
  }
  return null;
}

// ── Veritabanı ───────────────────────────────────────────────────────────────
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const cols = ["name TEXT DEFAULT ''", "targets TEXT DEFAULT ''", 'block_all INTEGER DEFAULT 0', "categories TEXT DEFAULT ''",
        "sites TEXT DEFAULT ''", "windows TEXT DEFAULT ''", "schedule_mode TEXT DEFAULT 'always'", 'version INTEGER DEFAULT 1',
        'legacy INTEGER DEFAULT 0', 'template_id INTEGER DEFAULT NULL'];
      for (const c of cols) await dbRun(`ALTER TABLE parental_rules ADD COLUMN ${c}`).catch(() => { /* zaten var */ });
      for (const c of CALENDAR_COLS) await dbRun(`ALTER TABLE parental_rules ADD COLUMN ${c}`).catch(() => { /* zaten var */ });
    })();
  }
  return schemaReady;
}

const LEGACY_CATEGORY: Record<string, CategoryId> = {
  adult_content: 'adult', gambling: 'gambling', social_media: 'social', gaming: 'gaming', streaming: 'video',
};
const parseJson = <T>(s: unknown, dflt: T): T => { try { const v = JSON.parse(String(s || '')); return v ?? dflt; } catch { return dflt; } };

// all ve templateId yalnız varsa eklenir: şablonsuz kuralların nesnesi (API yanıtı) eskisiyle aynı kalır.
function rowToRule(r: any): ParentalRule {
  const t = parseJson<{ devices?: string[]; groups?: number[]; all?: boolean }>(r.targets, {});
  const mode = r.schedule_mode === 'during' || r.schedule_mode === 'outside' ? r.schedule_mode : 'always';
  return {
    id: Number(r.id), name: String(r.name || ''), enabled: !!r.enabled,
    targets: { devices: Array.isArray(t.devices) ? t.devices : [], groups: Array.isArray(t.groups) ? t.groups : [], ...(t.all === true ? { all: true as const } : {}) },
    blockAll: !!r.block_all, categories: parseJson<CategoryId[]>(r.categories, []).filter(c => CATEGORY_IDS.includes(c)),
    sites: parseJson<string[]>(r.sites, []), mode, windows: parseJson<TimeWindow[]>(r.windows, []), legacy: !!r.legacy,
    ...(r.template_id !== null && r.template_id !== undefined ? { templateId: Number(r.template_id) } : {}),
  };
}

// Eski kayıt (tek hedef, tek tür) → yeni biçim, KAPALI. Yedekten geri yüklenen eski kayıtlar da okunurken taşınır.
async function migrateLegacy(): Promise<void> {
  const rows = await dbAll("SELECT * FROM parental_rules WHERE version IS NULL OR version < 2") as any[];
  for (const r of rows) {
    const target = String(r.device_mac_or_group || '').toLowerCase();
    const days = String(r.days_of_week || '').split(',').map(s => s.trim()).filter(isDay);
    let blockAll = 0, categories: CategoryId[] = [], sites: string[] = [], mode: Mode = 'always', windows: TimeWindow[] = [];
    if (r.rule_type === 'time_restrict') {
      blockAll = 1;
      mode = 'during';
      windows = [{ days: days.length ? days : ALL_DAYS, start: HHMM.test(r.schedule_start) ? r.schedule_start : '22:00', end: HHMM.test(r.schedule_end) ? r.schedule_end : '08:00' }];
    } else if (r.rule_type === 'category_block' && LEGACY_CATEGORY[r.value]) {
      categories = [LEGACY_CATEGORY[r.value]];
    } else if (r.rule_type === 'site_block') {
      const s = normalizeSite(r.value);
      if (s) sites = [s];
    }
    await dbRun(`UPDATE parental_rules SET name = ?, targets = ?, block_all = ?, categories = ?, sites = ?, windows = ?,
      schedule_mode = ?, version = 2, legacy = 1, enabled = 0 WHERE id = ?`,
    [`Eski kural #${r.id}`, JSON.stringify({ devices: MAC.test(target) ? [target] : [], groups: [] }), blockAll,
      JSON.stringify(categories), JSON.stringify(sites), JSON.stringify(windows), mode, r.id]);
  }
}

export async function listRules(): Promise<ParentalRule[]> {
  await ensureSchema();
  await migrateLegacy();
  return (await dbAll('SELECT * FROM parental_rules ORDER BY id') as any[]).map(r => withCalendarFlags(rowToRule(r), r));
}

const ruleParams = (r: Omit<ParentalRule, 'id' | 'legacy'>) => [r.name, JSON.stringify(r.targets), r.blockAll ? 1 : 0,
  JSON.stringify(r.categories), JSON.stringify(r.sites), JSON.stringify(r.windows), r.mode, r.enabled ? 1 : 0];

// opts.templateId: Koruma Şablonları'nın oluşturduğu kural (templates.ts) — işaret ayrı yazılır, INSERT eskisiyle aynı.
export async function createRule(body: any, opts: { templateId?: number } = {}): Promise<ParentalRule> {
  const v = validateRule(body);
  if ('error' in v) throw new Error(v.error);
  await ensureSchema();
  // Eski sütunlar (yedek / geriye dönük okuma için) özet değerle doldurulur. Satır INSERT'ün kendi id'siyle okunur ("en son
  // satır" değil): aynı anda kaydedilen başka bir kuralı şablon kendisininki saymasın.
  const id = await dbInsert(`INSERT INTO parental_rules (name, targets, block_all, categories, sites, windows, schedule_mode, enabled,
    version, legacy, device_mac_or_group, rule_type, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 0, '', 'v2', '')`, ruleParams(v.rule));
  let row = await dbGet('SELECT * FROM parental_rules WHERE id = ?', [id]);
  if (opts.templateId !== undefined && row) {
    await dbRun('UPDATE parental_rules SET template_id = ? WHERE id = ?', [opts.templateId, row.id]);
    row = { ...row, template_id: opts.templateId };
  }
  requestApply('kural eklendi');
  return markCalendarRule(rowToRule(row), body);
}

export async function updateRule(id: number, body: any): Promise<void> {
  await ensureSchema();
  const row = await dbGet('SELECT * FROM parental_rules WHERE id = ?', [id]);
  if (!row) throw new Error('Kural bulunamadı');
  body = calendarEditBody(row, body);   // takvim kuralı elle açılamaz (G5.3)
  // Yalnız aç / kapat. Açarken kural geçerli olmalı (eski kurallarda hedef kaybolmuş olabilir: "Çocuklar" gibi sabit gruplar)
  if (body && Object.keys(body).length === 1 && body.enabled !== undefined) {
    if (body.enabled) {
      const cur = rowToRule(row);
      const v = validateRule({ ...cur, enabled: true });
      if ('error' in v) throw new Error(`Kural açılamadı: ${v.error} — önce düzenleyin`);
    }
    await dbRun('UPDATE parental_rules SET enabled = ?, legacy = 0 WHERE id = ?', [body.enabled ? 1 : 0, id]);
  } else {
    const v = validateRule(body);
    if ('error' in v) throw new Error(v.error);
    await dbRun(`UPDATE parental_rules SET name = ?, targets = ?, block_all = ?, categories = ?, sites = ?, windows = ?,
      schedule_mode = ?, enabled = ?, version = 2, legacy = 0 WHERE id = ?`, [...ruleParams(v.rule), id]);
    await writeCalendarFlag(id, body);
  }
  requestApply('kural güncellendi');
}

export async function deleteRule(id: number): Promise<void> {
  await dbRun('DELETE FROM parental_rules WHERE id = ?', [id]);
  requestApply('kural silindi');
}

// ── Uygulama ─────────────────────────────────────────────────────────────────
let protectedMacs: () => Promise<Set<string>> = async () => new Set();
export interface ParentalHealth { nft: boolean; pihole: boolean | null; error: string | null; at: number; gravityPending: boolean }
const health: ParentalHealth = { nft: true, pihole: null, error: null, at: 0, gravityPending: false };
export const parentalHealth = () => ({ ...health });

async function resolveTargets(rules: ParentalRule[]): Promise<Map<number, Set<string>>> {
  const gids = [...new Set(rules.flatMap(r => r.targets.groups))];
  const members = new Map<number, string[]>();
  if (gids.length) {
    const rows = await dbAll(`SELECT group_id, device_mac FROM device_group_members WHERE group_id IN (${gids.map(() => '?').join(',')})`, gids) as any[];
    for (const r of rows) {
      const g = Number(r.group_id);
      if (!members.has(g)) members.set(g, []);
      members.get(g)!.push(String(r.device_mac).toLowerCase());
    }
  }
  const prot = await protectedMacs().catch(() => new Set<string>());
  const out = new Map<number, Set<string>>();
  for (const r of rules) {
    const s = new Set<string>([...r.targets.devices, ...r.targets.groups.flatMap(g => members.get(g) || [])]
      .map(m => m.toLowerCase()).filter(m => MAC.test(m) && !prot.has(m)));
    out.set(r.id, s);
  }
  return out;
}

const hasDnsPart = (r: ParentalRule) => !r.blockAll && (r.categories.length > 0 || r.sites.length > 0);

export function renderNft(blockNow: string[], guard: string[], all = false): string {
  const set = (name: string, type: string, els: string[], flags = '') =>
    `  set ${name} { type ${type};${flags}${els.length ? ` elements = { ${els.join(', ')} }` : ''} }`;
  // Tüm ağ (şifreli DNS engeli): ev ağı = özel IPv4 kaynak, VPS tünelinden gelen hariç
  const lan = 'iifname != "wg_vps*" ip saddr @lan4';
  return [
    `table inet ${NFT_TABLE} {}`,
    `delete table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    set('block_now', 'ether_addr', blockNow),
    set('dns_guard', 'ether_addr', guard),
    set('doh4', 'ipv4_addr', DOH_V4),
    set('doh6', 'ipv6_addr', DOH_V6),
    ...(all ? [
      set('lan4', 'ipv4_addr', ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], ' flags interval;'),
      '  chain prerouting {',
      '    type nat hook prerouting priority dstnat; policy accept;',
      `    ${lan} fib daddr type != local meta l4proto { tcp, udp } th dport 53 redirect to :53`,
      '  }',
    ] : []),
    '  chain forward {',
    '    type filter hook forward priority -10; policy accept;',
    '    ether saddr @block_now drop',
    '    ether saddr @dns_guard meta l4proto { tcp, udp } th dport { 53, 853 } drop',
    '    ether saddr @dns_guard ip daddr @doh4 meta l4proto { tcp, udp } th dport 443 drop',
    '    ether saddr @dns_guard ip6 daddr @doh6 meta l4proto { tcp, udp } th dport 443 drop',
    ...(all ? [
      `    ${lan} meta l4proto { tcp, udp } th dport 853 drop`,
      `    ${lan} ip daddr @doh4 meta l4proto { tcp, udp } th dport 443 drop`,
    ] : []),
    '  }',
    '}',
    '',
  ].join('\n');
}

function nft(args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const p = spawn('nft', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('error', e => resolve({ code: -1, out: String(e.message) }));
    p.on('close', code => resolve({ code: code ?? -1, out }));
    // nft stdin'i okumadan çıkarsa (ör. `list table` yoksa hemen çıkar) yazma EPIPE verir; dinleyicisiz 'error' olayı tüm
    // backend'i düşürüyordu (canlıda 30 sn'lik zamanlayıcıda 26 saatte 9 kez). Sonuç yine 'close' ile bildirilir.
    p.stdin.on('error', () => { /* nft stdin'i okumadan çıktı */ });
    p.stdin.end(input ?? '');
  });
}

let nftApplied = '';
async function applyNft(blockNow: string[], guard: string[], all = false): Promise<void> {
  const want = blockNow.length || guard.length || all ? renderNft(blockNow.sort(), guard.sort(), all) : '';
  // Tablo dışarıdan silinmiş olabilir (nftables yeniden başlatma, flush ruleset): varsa ve aynıysa dokunulmaz
  const exists = (await nft(['list', 'table', 'inet', NFT_TABLE])).code === 0;
  if (want === nftApplied && exists === !!want) return;
  const r = want ? await nft(['-f', '-'], want) : exists ? await nft(['delete', 'table', 'inet', NFT_TABLE]) : { code: 0, out: '' };
  health.nft = r.code === 0;
  if (r.code !== 0) throw new Error(`güvenlik duvarı kuralı yüklenemedi: ${r.out.trim().split('\n').pop()}`);
  nftApplied = want;
}

// ── Pi-hole ──────────────────────────────────────────────────────────────────
interface DnsPlan {
  groups: Map<string, boolean>;             // grup adı → açık mı (saatine göre)
  clients: Map<string, Set<string>>;        // MAC (büyük harf) → gruplar
  regex: Map<string, Set<string>>;          // düzenli ifade → gruplar
  lists: Map<string, Set<string>>;          // bloklistesi → gruplar
  // Yalnız tüm ağ kuralı varken: Default grubunu o kural için isteyen ifade / listeler (kullanıcının kaydına Default ekleme
  // kaydı — syncPihole). Tüm ağ kuralı yokken alan hiç bulunmaz (plan eskisiyle aynı nesne).
  allItems?: { regex: Set<string>; lists: Set<string> };
}

export function planDns(rules: ParentalRule[], targets: Map<number, Set<string>>, now: Date, all = false, ov: CalendarOverlay | null = currentOverlay()): DnsPlan {
  const p: DnsPlan = { groups: new Map(), clients: new Map(), regex: new Map(), lists: new Map() };
  const add = (m: Map<string, Set<string>>, k: string, g: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(g); };
  const guard = new Set<string>();
  for (const r of rules) {
    if (!r.enabled || !hasDnsPart(r)) continue;
    // Tüm ağ kuralı: kategori / site Pi-hole'un Default grubuna (herkes), "Tüm ağda şifreli DNS engeli" dalı gibi — grup
    // oluşturulmaz, istemci ve DNS koruma grubu eklenmez. Yalnız "her zaman" (validateRule; yedekten gelen başka kip uygulanmaz).
    if (r.targets.all) {
      if (r.mode !== 'always') continue;
      const fromAll = (p.allItems ||= { regex: new Set(), lists: new Set() });
      const rx = (x: string) => { add(p.regex, x, DEFAULT_GROUP); fromAll.regex.add(x); };
      for (const c of r.categories) {
        const cat = CATEGORIES[c];
        if (cat.domains?.length) rx(domainRegex(cat.domains));
        for (const l of cat.lists || []) { add(p.lists, l, DEFAULT_GROUP); fromAll.lists.add(l); }
      }
      for (const s of r.sites) rx(domainRegex([s]));
      continue;
    }
    const macs = targets.get(r.id) || new Set();
    if (!macs.size) continue;
    const g = `${GROUP_PREFIX}${r.id}`;
    p.groups.set(g, effectiveActive(r, now, ov));
    for (const m of macs) { add(p.clients, m.toUpperCase(), g); guard.add(m.toUpperCase()); }
    for (const c of r.categories) {
      const cat = CATEGORIES[c];
      if (cat.domains?.length) add(p.regex, domainRegex(cat.domains), g);
      for (const l of cat.lists || []) add(p.lists, l, g);
    }
    for (const s of r.sites) add(p.regex, domainRegex([s]), g);
  }
  planCalendarRules(rules, targets, now, ov, p, guard);   // takvim kuralları (G5.3): uyurken grup kapalı kurulur
  if (guard.size) {
    p.groups.set(DNS_GROUP, true);
    for (const m of guard) add(p.clients, m, DNS_GROUP);
    add(p.regex, domainRegex(DOH_DOMAINS), DNS_GROUP);
  }
  // Tüm ağda şifreli DNS engeli: Pi-hole'un Default grubu (herkes). Grup bizim değil: oluşturulmaz / silinmez.
  if (all) {
    add(p.regex, domainRegex(DOH_DOMAINS), DEFAULT_GROUP);
    add(p.lists, UT1_DOH_LIST, DEFAULT_GROUP);
  }
  return p;
}

const isOurGroup = (name: string) => name.startsWith(GROUP_PREFIX);
// Default defteri (syncPihole 3–4): panelin çalışma kaydı — yedekten geri gelmez (index.ts BACKUP_SKIP_SETTINGS); tüm ağ kuralı
// hiç kullanılmadıysa anahtar hiç yazılmaz.
const DEFAULT_LEDGER_KEY = 'parental_default_added';
async function readDefaultLedger(): Promise<{ regex: Set<string>; lists: Set<string> }> {
  const r = await dbGet('SELECT value FROM app_settings WHERE key = ?', [DEFAULT_LEDGER_KEY]).catch(() => undefined) as { value?: string } | undefined;
  const j = parseJson<{ regex?: unknown; lists?: unknown }>(r?.value, {});
  const set = (x: unknown) => new Set(Array.isArray(x) ? x.map(String) : []);
  return { regex: set(j.regex), lists: set(j.lists) };
}
async function writeDefaultLedger(l: { regex: Set<string>; lists: Set<string> }): Promise<void> {
  await dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [DEFAULT_LEDGER_KEY, JSON.stringify({ regex: [...l.regex].sort(), lists: [...l.lists].sort() })]);
}
const apiErr = (r: { status: number; json: any }, what: string) =>
  `${what}: HTTP ${r.status}${r.json?.error?.message ? ` — ${r.json.error.message}` : ''}`;
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

// Tam eşitleme: gruplar, istemciler, düzenli ifadeler, bloklisteleri. Hata listesi döner.
async function syncPihole(plan: DnsPlan, ftl: Ftl): Promise<{ errors: string[]; listsChanged: boolean }> {
  const errors: string[] = [];
  let listsChanged = false;
  // 1) Gruplar (eksikler oluşturulur; kalanlar en sonda silinir)
  const gr = await ftl.call('GET', 'groups');
  if (gr.status !== 200) throw new Error(apiErr(gr, 'Pi-hole grupları okunamadı'));
  const byName = new Map<string, any>((gr.json?.groups || []).map((g: any) => [g.name, g]));
  for (const [name, enabled] of plan.groups) {
    const h = byName.get(name);
    if (!h) {
      const r = await ftl.call('POST', 'groups', { name, comment: MARK, enabled });
      if (r.status >= 300) { errors.push(apiErr(r, name)); continue; }
      for (const g of r.json?.groups || []) byName.set(g.name, g);
    } else if (!!h.enabled !== enabled) {
      const r = await ftl.call('PUT', `groups/${encodeURIComponent(name)}`, { name, comment: MARK, enabled });
      if (r.status >= 300) errors.push(apiErr(r, name));
    }
  }
  const ourIds = new Set<number>([...byName.values()].filter(g => isOurGroup(g.name)).map(g => Number(g.id)));
  const idOf = (names: Set<string>) => [...names].map(n => byName.get(n)?.id).filter((x): x is number => Number.isInteger(x));

  // 2) İstemciler: bizim gruplar istenene eşitlenir, başka gruplar (Default dahil) korunur
  const cl = await ftl.call('GET', 'clients');
  if (cl.status !== 200) throw new Error(apiErr(cl, 'Pi-hole istemcileri okunamadı'));
  const clients = new Map<string, any>((cl.json?.clients || []).map((c: any) => [String(c.client).toUpperCase(), c]));
  const keys = new Set([...plan.clients.keys(), ...[...clients.values()].filter(c => (c.groups || []).some((g: number) => ourIds.has(g))).map(c => String(c.client).toUpperCase())]);
  for (const key of keys) {
    const h = clients.get(key);
    const want = idOf(plan.clients.get(key) || new Set());
    if (!h) {
      if (!want.length) continue;
      const r = await ftl.call('POST', 'clients', { client: key, comment: MARK, groups: [0, ...want] });
      if (r.status >= 300) errors.push(apiErr(r, key));
      continue;
    }
    const cur: number[] = (h.groups || []).map(Number);
    const next = [...new Set([...cur.filter(g => !ourIds.has(g)), ...want])];
    if (!want.length && h.comment === MARK && next.length <= 1 && (next[0] ?? 0) === 0) {
      const r = await ftl.call('DELETE', `clients/${encodeURIComponent(h.client)}`);
      if (r.status >= 300 && r.status !== 404) errors.push(apiErr(r, key));
    } else if (!sameSet(cur, next.length ? next : [0])) {
      const r = await ftl.call('PUT', `clients/${encodeURIComponent(h.client)}`, { comment: h.comment ?? '', groups: next.length ? next : [0] });
      if (r.status >= 300) errors.push(apiErr(r, key));
    }
  }

  // 3) Düzenli ifadeler (deny/regex) ve 4) bloklisteleri: aynı desen. Kullanıcının kaydına (açıklaması bizim değil) tüm ağ
  //    kuralı için Default grubunu BİZ eklediysek (önceden yoktu) defterde tutulur: kural kalkınca yalnız o Default bağı
  //    çıkarılır — kaydı kullanıcı zaten Default'ta tutuyorsa ya da Default'u şifreli DNS engeli istediyse dokunulmaz.
  const defId = byName.get(DEFAULT_GROUP)?.id as number | undefined;
  const ledger = await readDefaultLedger();
  const ledgerBefore = JSON.stringify([[...ledger.regex].sort(), [...ledger.lists].sort()]);
  const syncItems = async (kind: 'regex' | 'lists', want: Map<string, Set<string>>) => {
    const added = ledger[kind];
    const fromAll = plan.allItems?.[kind];
    const ours = (k: string) => (g: number) => ourIds.has(g) || (g === defId && added.has(k));
    const cur = await ftl.call('GET', kind === 'regex' ? 'domains/deny/regex' : 'lists?type=block');
    if (cur.status !== 200) throw new Error(apiErr(cur, kind === 'regex' ? 'Pi-hole alan adları okunamadı' : 'Pi-hole listeleri okunamadı'));
    const rows: any[] = kind === 'regex' ? cur.json?.domains || [] : (cur.json?.lists || []).filter((l: any) => l.type === 'block');
    const keyOf = (x: any) => String(kind === 'regex' ? x.domain : x.address);
    const have = new Map<string, any>(rows.map(x => [keyOf(x), x]));
    const path = (k: string) => kind === 'regex' ? `domains/deny/regex/${encodeURIComponent(k)}` : `lists/${encodeURIComponent(k)}?type=block`;
    for (const [k, names] of want) {
      const ids = idOf(names);
      const h = have.get(k);
      if (!h) {
        const r = await ftl.call('POST', kind === 'regex' ? 'domains/deny/regex' : 'lists?type=block',
          kind === 'regex' ? { domain: k, comment: MARK, groups: ids, enabled: true } : { address: k, comment: MARK, groups: ids, enabled: true });
        if (r.status >= 300) errors.push(apiErr(r, k.slice(0, 60)));
        else if (kind === 'lists') listsChanged = true;
        continue;
      }
      const cur2: number[] = (h.groups || []).map(Number);
      const mine = ours(k);
      const next = h.comment === MARK ? ids : [...new Set([...cur2.filter(g => !mine(g)), ...ids])];
      if (!sameSet(cur2, next) || (h.comment === MARK && !h.enabled)) {
        const r = await ftl.call('PUT', path(k), { comment: h.comment ?? '', groups: next, enabled: h.comment === MARK ? true : !!h.enabled });
        if (r.status >= 300) errors.push(apiErr(r, k.slice(0, 60)));
        else {
          if (kind === 'lists') listsChanged = true;
          if (h.comment !== MARK && defId !== undefined) {
            if (fromAll?.has(k) && next.includes(defId) && !cur2.includes(defId)) added.add(k);
            else if (!next.includes(defId)) added.delete(k);
          }
        }
      }
    }
    for (const [k, h] of have) {
      if (want.has(k)) continue;
      const cur2: number[] = (h.groups || []).map(Number);
      if (h.comment === MARK) {
        const r = await ftl.call('DELETE', path(k));
        if (r.status >= 300 && r.status !== 404) errors.push(apiErr(r, k.slice(0, 60)));
        else if (kind === 'lists') listsChanged = true;
      } else if (cur2.some(ours(k))) {
        const r = await ftl.call('PUT', path(k), { comment: h.comment ?? '', groups: cur2.filter(g => !ours(k)(g)), enabled: !!h.enabled });
        if (r.status >= 300) errors.push(apiErr(r, k.slice(0, 60)));
        else added.delete(k);
      }
    }
    for (const k of [...added]) if (!have.has(k)) added.delete(k);   // kullanıcı kaydını silmiş
  };
  try {
    await syncItems('regex', plan.regex);
    await syncItems('lists', plan.lists);
  } finally {
    // Liste okuma hatası (fırlatır) ifadelerde yapılan Default eklemesinin kaydını kaybettirmesin
    if (JSON.stringify([[...ledger.regex].sort(), [...ledger.lists].sort()]) !== ledgerBefore) await writeDefaultLedger(ledger);
  }

  // 5) Artık gerekmeyen gruplarımız (bağları grup silinince Pi-hole kendisi kaldırır)
  for (const g of byName.values()) {
    if (!isOurGroup(g.name) || plan.groups.has(g.name)) continue;
    const r = await ftl.call('DELETE', `groups/${encodeURIComponent(g.name)}`);
    if (r.status >= 300 && r.status !== 404) errors.push(apiErr(r, g.name));
  }
  return { errors, listsChanged };
}

// Yalnız grupların açık/kapalı durumu (saat geçişleri): tam eşitlemeden ucuz.
async function toggleGroups(want: Map<string, boolean>, ftl: Ftl): Promise<string[]> {
  const errors: string[] = [];
  const gr = await ftl.call('GET', 'groups');
  if (gr.status !== 200) throw new Error(apiErr(gr, 'Pi-hole grupları okunamadı'));
  for (const g of gr.json?.groups || []) {
    if (!want.has(g.name) || !!g.enabled === want.get(g.name)) continue;
    const r = await ftl.call('PUT', `groups/${encodeURIComponent(g.name)}`, { name: g.name, comment: MARK, enabled: want.get(g.name) });
    if (r.status >= 300) errors.push(apiErr(r, g.name));
  }
  return errors;
}

// ── Zamanlayıcı ──────────────────────────────────────────────────────────────
let lastPlanKey = '';      // gruplar hariç yapı (istemci, ifade, liste): değişince tam eşitleme
let lastGroupsKey = '';    // grup açık/kapalı durumları
let lastFull = 0;
let forceFull = true;
let applying: Promise<void> | null = null;

async function applyAll(reason: string): Promise<void> {
  const rules = await listRules();
  const targets = await resolveTargets(rules);
  const now = new Date();
  const ov = currentOverlay();   // takvim kaplaması (G5.3): bu tur boyunca tek görüntü
  const errors: string[] = [];
  const all = await dnsGuardAllEnabled();
  // Güvenlik duvarı: şu an "tüm internet" kuralı etkin cihazlar + DNS koruması (kategori/site kuralı açık cihazlar)
  const blockNow = new Set<string>(), guard = new Set<string>();
  for (const r of rules) {
    const macs = targets.get(r.id) || new Set();
    if (r.blockAll && effectiveActive(r, now, ov)) macs.forEach(m => blockNow.add(m));
    if ((r.calendarOnly ? effectiveActive(r, now, ov) : r.enabled) && hasDnsPart(r)) macs.forEach(m => guard.add(m));
  }
  try { await applyNft([...blockNow], [...guard], all); } catch (e: any) { errors.push(e.message); }

  const plan = planDns(rules, targets, now, all, ov);
  const planKey = JSON.stringify([[...plan.clients].map(([k, v]) => [k, [...v].sort()]).sort(),
    [...plan.regex].map(([k, v]) => [k, [...v].sort()]).sort(), [...plan.lists].map(([k, v]) => [k, [...v].sort()]).sort(),
    [...plan.groups.keys()].sort()]);
  const groupsKey = JSON.stringify([...plan.groups].sort());
  const full = forceFull || planKey !== lastPlanKey || Date.now() - lastFull > FULL_SYNC_MS;
  if (full || groupsKey !== lastGroupsKey || health.gravityPending) {
    let ftl: Ftl | null = null;
    try {
      ftl = await openFtl();
      if (full) {
        const r = await syncPihole(plan, ftl);
        errors.push(...r.errors);
        if (r.listsChanged) health.gravityPending = true;
        lastPlanKey = planKey;
        lastFull = Date.now();
        forceFull = false;
      } else {
        errors.push(...await toggleGroups(plan.groups, ftl));
      }
      lastGroupsKey = groupsKey;
      health.pihole = true;
    } catch (e: any) {
      if (plan.groups.size || plan.regex.size || plan.lists.size) {
        // Pi-hole kapalı / yanıt vermiyor: kategori-site / şifreli DNS engeli uygulanamadı; sonraki turda yeniden denenir
        health.pihole = false;
        errors.push(e?.message || String(e));
        forceFull = true;
      } else {
        // Uygulanacak DNS kuralı yok (ya da Pi-hole'suz kurulum): 15 dk'lık onarım turuna kadar yeniden denenmez
        health.pihole = null;
        lastPlanKey = planKey; lastGroupsKey = groupsKey; lastFull = Date.now(); forceFull = false;
      }
    } finally {
      await ftl?.close();
    }
    // Hazır listeler (Yetişkin / Kumar) Pi-hole'a eklendi / çıkarıldı: liste indirme (gravity) arka planda
    if (health.gravityPending && health.pihole) health.gravityPending = !(await startGravity());
  }
  health.error = errors.length ? errors.slice(0, 3).join(' · ').slice(0, 400) : null;
  health.at = Date.now();
  if (errors.length) console.error(`[ebeveyn] ${reason}: ${health.error}`);
}

function runApply(reason: string): Promise<void> {
  if (applying) return applying.then(() => runApply(reason));
  applying = applyAll(reason).catch(e => { health.error = e?.message || String(e); }).finally(() => { applying = null; });
  return applying;
}
function requestApply(reason: string): void {
  forceFull = true;
  void runApply(reason);
}
// Tam eşitleme ve bitmesini bekleme (Koruma Şablonları: uygulama / geri alma yanıtı Pi-hole sonucunu bildirsin).
export async function applyParentalNow(reason: string): Promise<ParentalHealth> {
  forceFull = true;
  if (isLinux) await runApply(reason);
  return parentalHealth();
}

// ── Tüm ağda şifreli DNS engeli ──────────────────────────────────────────────
async function dnsGuardAllEnabled(): Promise<boolean> {
  const r = await dbGet('SELECT value FROM app_settings WHERE key = ?', [GUARD_ALL_KEY]).catch(() => undefined) as { value?: string } | undefined;
  return r?.value === '1';
}
export type DnsGuardStatus = { enabled: boolean; applied: boolean; pihole: boolean | null; error: string | null };
export async function dnsGuardStatus(): Promise<DnsGuardStatus> {
  const enabled = await dnsGuardAllEnabled();
  const inNft = nftApplied.includes('chain prerouting');
  return { enabled, applied: enabled ? inNft && health.nft : !inNft, pihole: health.pihole, error: health.error };
}
// Açar / kapatır ve hemen uygular (güvenlik duvarı + Pi-hole); uygulama bitince durum döner.
export async function setDnsGuardAll(on: boolean): Promise<DnsGuardStatus> {
  await dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [GUARD_ALL_KEY, on ? '1' : '0']);
  forceFull = true;
  if (isLinux) await runApply(on ? 'şifreli DNS engeli açıldı' : 'şifreli DNS engeli kapatıldı');
  return dnsGuardStatus();
}
export async function rulesWithStatus(): Promise<{ rules: (ParentalRule & { status: RuleStatus })[]; health: ParentalHealth }> {
  const rules = await listRules();
  const targets = await resolveTargets(rules);
  const now = new Date();
  const ov = currentOverlay();
  return {
    rules: rules.map(r => {
      const nc = nextChange(r, now);
      return { ...r, status: { active: effectiveActive(r, now, ov), nextChange: nc ? nc.toISOString() : null, devices: targets.get(r.id)?.size || 0, ...calendarStatus(r, now, ov) } };
    }),
    health: parentalHealth(),
  };
}

export function startParental(opts: { protectedMacs: () => Promise<Set<string>> }): void {
  protectedMacs = opts.protectedMacs;
  if (!isLinux) return;
  setTimeout(() => { void runApply('açılış'); }, 12000);
  setInterval(() => { void runApply('zamanlayıcı'); }, TICK_MS);
}

// ── Takvim kaplaması (G5.3, calendarEngine.ts) ───────────────────────────────
// Takvim motoru nft'ye ya da Pi-hole'a YAZMAZ: bu motora geçici bir kaplama (hangi kural ne zamana dek askıda / etkin) verir;
// uygulama yine bu dosyanın 30 sn'lik döngüsüdür (döngü kaplamayı her turda yeniden okur, kendi yazdığını geri yazmaz).
//  - Sağlayıcı yokken ya da motor kapalıyken kaplama null: effectiveActive ≡ ruleActive, plan ve nft metni bayt bayt aynı.
//  - Takvim kuralı (calendar_only = 1, cal_armed = 1) veritabanında enabled = 0 KALIR: yeni bir schedule_mode değeri eski
//    sürümde (rowToRule / ruleActive) kuralı kalıcı "her zaman" yapardı; enabled = 0 eski kodda ve yedeği eski panele
//    yükleyende pasif kalır. Elle açılamaz (validateRule / updateRule); tüm ağ hedefiyle (Default grup) birleşemez.
//  - Uyuyan takvim kuralının Pi-hole grubu (motor açıkken) KAPALI olarak önceden kurulur: etkinleşme yalnız grup aç / kapa,
//    gravity beklenmez. DNS atlatma koruması takvim kuralında yalnız kural etkinken uygulanır.
//  - Her etki bir bitiş anı taşır (until): motor dursa da etki o anda kendiliğinden biter.
export interface ParentalRule { calendarOnly?: true; calArmed?: true }   // yalnız takvim kuralında bulunur
export interface CalendarEffect { until: number; label: string }
export interface CalendarOverlay { suspend: Map<number, CalendarEffect>; activate: Map<number, CalendarEffect> }
export interface RuleStatus { calendar?: { state: 'active' | 'waiting' | 'suspended'; until: string | null; label: string | null } }
const CALENDAR_COLS = ['calendar_only INTEGER DEFAULT 0', 'cal_armed INTEGER DEFAULT 0'];

let overlayProvider: (() => CalendarOverlay | null) | null = null;
export function setCalendarOverlay(fn: (() => CalendarOverlay | null) | null): void { overlayProvider = fn; }
function currentOverlay(): CalendarOverlay | null {
  if (!overlayProvider) return null;
  try { return overlayProvider(); } catch { return null; }
}
const effectLive = (e: CalendarEffect | undefined, now: Date): e is CalendarEffect => !!e && now.getTime() < e.until;
// Tüm ağ hedefli kural (G1.3-A, Pi-hole Default grubu): takvim askıya alamaz (alan henüz yoksa false)
const allTarget = (r: ParentalRule) => !!(r.targets as { all?: boolean } | undefined)?.all;
// Kuralın şu an uygulanıp uygulanmadığı (kaplama dahil). Kaplama null: ruleActive ile aynı.
export function effectiveActive(r: ParentalRule, now: Date, ov: CalendarOverlay | null = currentOverlay()): boolean {
  if (r.calendarOnly) return !!ov && !!r.calArmed && effectLive(ov.activate.get(r.id), now) && !effectLive(ov.suspend.get(r.id), now);
  if (ov && !allTarget(r) && effectLive(ov.suspend.get(r.id), now)) return false;
  return ruleActive(r, now);
}
// Liste yanıtı: takvim kuralı ve takvimin askıya aldığı kural için durum (diğer kuralların yanıtı eskisiyle aynı). Kapalı ya da
// tüm ağ hedefli normal kural askıya alınmış görünmez (askının etkisi yok; kart "Kapalı" kalır).
function calendarStatus(r: ParentalRule, now: Date, ov: CalendarOverlay | null): Pick<RuleStatus, 'calendar'> {
  const sus = ov ? ov.suspend.get(r.id) : undefined;
  const act = ov ? ov.activate.get(r.id) : undefined;
  if (r.calendarOnly) {
    const on = effectiveActive(r, now, ov);
    const e = on ? act : effectLive(sus, now) ? sus : undefined;
    return { calendar: { state: on ? 'active' : effectLive(sus, now) ? 'suspended' : 'waiting', until: e ? new Date(e.until).toISOString() : null, label: e?.label ?? null } };
  }
  return r.enabled && !allTarget(r) && effectLive(sus, now) ? { calendar: { state: 'suspended', until: new Date(sus.until).toISOString(), label: sus.label } } : {};
}

// Takvim kuralı alanının denetimi (validateRule'un başında). calendarOnly yoksa / false ise hiçbir şey denetlenmez.
function calendarRuleError(body: any): string | null {
  if (body?.calendarOnly === undefined || body.calendarOnly === false) return null;
  if (body.calendarOnly !== true) return 'calendarOnly true ya da false olmalı';
  if (body.enabled !== false) return 'Takvim kuralı elle açılamaz — yalnız takvim etkinliği sırasında çalışır';
  if (body.targets?.all) return 'Tüm ağ hedefi takvimle açılıp kapatılamaz (Pi-hole Default grubu) — cihaz ya da grup seçin';
  if (body.mode !== undefined && body.mode !== 'always') return 'Takvim kuralında saat aralığı olmaz — süreyi takvim etkinliği belirler';
  return null;
}
function withCalendarFlags(rule: ParentalRule, row: any): ParentalRule {
  if (!Number(row?.calendar_only)) return rule;
  // enabled her zaman false: eski sürümde elle açılmış (enabled = 1) bir takvim kuralı da yalnız takvimle çalışır
  return { ...rule, enabled: false, calendarOnly: true, ...(Number(row.cal_armed) ? { calArmed: true as const } : {}) };
}
// Yeni kural takvim kuralıysa işaretlenir (INSERT eskisiyle aynı; kural enabled = 0 eklendiği için arada etkisizdir). createRule
// satırı INSERT'ün kendi id'siyle okur: işaret yalnız eklenen kurala (kapalı, henüz takvim kuralı değil) yazılır — eşzamanlı
// eklenen başka bir kural kapatılmaz ya da takvim kuralına çevrilmez.
async function markCalendarRule(rule: ParentalRule, body: any): Promise<ParentalRule> {
  if (body?.calendarOnly !== true) return rule;
  const v = validateRule(body);
  if ('error' in v) return rule;
  const row = await dbGet('SELECT * FROM parental_rules WHERE id = ? AND enabled = 0 AND calendar_only = 0', [rule.id]);
  if (!row) return rule;
  await dbRun('UPDATE parental_rules SET calendar_only = 1, cal_armed = 1, enabled = 0 WHERE id = ?', [row.id]);
  requestApply('takvim kuralı eklendi');
  return { ...rowToRule(row), enabled: false, calendarOnly: true, calArmed: true };
}
// PUT /api/parental/rules/:id: takvim kuralını "Aç"mak reddedilir (kalıcı "her zaman" engeli olurdu); tam düzenlemede alan
// gönderilmemişse takvim kuralı olarak kalır (enabled = 0). calendarOnly: false açıkça gönderilirse normal kurala döner, ama
// KAPALI: çıkarma ve açma iki ayrı istek (tek istekte takvim kuralı kalıcı engel olamaz); açmak kartındaki düğmeyle.
const MANUAL_ON = 'Takvim kuralı elle açılamaz — yalnız takvim etkinliği sırasında çalışır (Ağ Ajandası → Takvim kuralları)';
function calendarEditBody(row: any, body: any): any {
  if (!Number(row?.calendar_only)) return body;
  if (body && Object.keys(body).length === 1 && body.enabled !== undefined) {
    if (body.enabled) throw new Error(MANUAL_ON);
    return body;
  }
  if (body?.calendarOnly === false) {
    if (body.enabled === true) throw new Error('Takvim kuralı elle açılamaz — önce "Yalnız takvimle çalışır"ı kaldırıp kaydedin, sonra kartından açın');
    return { ...body, enabled: false };
  }
  return body?.calendarOnly === undefined ? { ...body, calendarOnly: true, enabled: body?.enabled ?? false } : body;
}
async function writeCalendarFlag(id: number, body: any): Promise<void> {
  if (body?.calendarOnly === undefined) return;
  const on = body.calendarOnly === true ? 1 : 0;
  await dbRun('UPDATE parental_rules SET calendar_only = ?, cal_armed = ? WHERE id = ?', [on, on, id]);
}

// planDns'in takvim kuralları: yalnız motor açıkken (kaplama null değil). Grup kuralın takvim durumuna göre açık / kapalı.
function planCalendarRules(rules: ParentalRule[], targets: Map<number, Set<string>>, now: Date, ov: CalendarOverlay | null, p: DnsPlan, guard: Set<string>): void {
  if (!ov) return;
  const add = (m: Map<string, Set<string>>, k: string, g: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(g); };
  for (const r of rules) {
    if (!r.calendarOnly || !r.calArmed || !hasDnsPart(r) || (r.targets as { all?: boolean }).all) continue;
    const macs = targets.get(r.id) || new Set();
    if (!macs.size) continue;
    const g = `${GROUP_PREFIX}${r.id}`;
    const on = effectiveActive(r, now, ov);
    p.groups.set(g, on);
    for (const m of macs) { add(p.clients, m.toUpperCase(), g); if (on) guard.add(m.toUpperCase()); }
    for (const c of r.categories) {
      const cat = CATEGORIES[c];
      if (cat.domains?.length) add(p.regex, domainRegex(cat.domains), g);
      for (const l of cat.lists || []) add(p.lists, l, g);
    }
    for (const s of r.sites) add(p.regex, domainRegex([s]), g);
  }
}

// Kaplama değişti (takvim motoru): beklemeden bir tur (yalnız değişen uygulanır). Bittiğinde sağlık durumu döner.
export async function applyCalendarOverlay(): Promise<ParentalHealth> {
  if (isLinux) await runApply('takvim');
  return parentalHealth();
}

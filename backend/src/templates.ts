// Koruma Şablonları (Koruma Şablonları sayfası, /api/templates). Yeni bir uygulama motoru DEĞİL: şablon, mevcut motorlara giden
// önizlemeli ve geri alınabilir bir girdi demetidir — ebeveyn kuralı (parental.ts; tüm ağ hedefi Pi-hole Default grubu),
// tüm ağda şifreli DNS engeli (parental.ts dns_guard_all) ve güvenli arama (safeSearch.ts).
//  - Önizleme yan etkisizdir: neyin ekleneceği / açılacağı Türkçe liste olarak döner. "Uygula" ondan sonra; kapsam sessizce
//    genişlemez (otomatik ilişkilendirme yok).
//  - Uygulama oluşturduğu kuralları (id + içerik özeti) ve değiştirdiği ayarların önceki değerlerini policy_templates'e HER
//    ADIMDA yazar (ayar değiştirilmeden önce, kural oluşturulduktan hemen sonra): panel uygulama sırasında yeniden başlarsa
//    kayıt doğru kalır, «Geri al» yarım kalanı da temizler (şablon işaretli ama kayda girmemiş kural, parametrelerden
//    hesaplanan özetle). Bir adım başarısız olursa o ana dek yapılanlar geri alınır, kayıt silinir. Uygulama sürerken liste
//    "uygulanıyor" der (bozuk değil); geri alma o sırada reddedilir.
//  - Geri al: yalnız şablonun oluşturduğu VE o zamandan beri değişmemiş nesneler. Değişmiş kural silinmez (şablon işareti
//    kalkar, kullanıcının kuralı olur); değişmiş ayara dokunulmaz — yanıtta ve olay geçmişinde söylenir.
//  - Kısmi yedek geri yüklemede kaydın kuralı yoksa ya da aynı numarada başka bir kural varsa şablon "bozuk" gösterilir; geri al
//    yine çalışır (olmayanı atlar, başkasınınkine dokunmaz). Ters yön: etkin bir şablon kaydına ait olmayan kural işareti
//    (template_id) açılışta ve geri yüklemede kaldırılır (reconcileTemplateMarks) — kural sıradan bir ebeveyn kuralı olur.
//  - Şablon başına tek etkin uygulama. POS Güvenlik Modu bu sürümde kilitli (ağ bölgeleri — VLAN — gelince).
//  - Ürün dili "uyuma yardımcı kontroller": panel bir mevzuata (PCI-DSS, CIPA) "uyumlu" olduğunu söylemez.
//  - Uyduda kapalı (uçlar 409). HA: iki düğümde (DNS yapılandırması eşitlenir) — şimdilik yalnız bu cihaz.
import crypto from 'crypto';
import type express from 'express';
import { dbAll, dbGet, dbInsert, dbRun } from './db';
import { recordEvent } from './events';
import { isSatellite } from './role';
import {
  CATEGORIES, createRule, deleteRule, listRules, validateRule, dnsGuardStatus, setDnsGuardAll, applyParentalNow,
  type CategoryId, type ParentalRule, type TimeWindow, type ParentalHealth,
} from './parental';
import {
  SAFESEARCH_IDS, SAFESEARCH_PROVIDERS, SafeSearchError, readSafeSearchConfig, safeSearchStatus, setSafeSearch, previewSafeSearch,
  assertSafeSearchResolvable,
  type SafeSearchProvider,
} from './safeSearch';

export type TemplateKey = 'okul-aile' | 'pos';
export const TEMPLATE_DEFS: { key: TemplateKey; title: string; desc: string; available: boolean; locked?: string }[] = [
  { key: 'okul-aile', title: 'Okul / Aile koruması', available: true,
    desc: 'Yetişkin içerik ve kumar engeli, güvenli arama (Google, YouTube Sıkı, Bing, DuckDuckGo); isteğe bağlı ders saatlerinde sosyal medya / oyun engeli ve tüm ağda şifreli DNS engeli.' },
  { key: 'pos', title: 'POS Güvenlik Modu', available: false, locked: 'Yakında — ağ bölgeleri (VLAN) gelince',
    desc: 'Ödeme cihazını ayrı bir ağ bölgesine alır: yalnız ödeme sağlayıcılarına çıkış, ev ağına erişim yok; önce gözlem, sonra zorlama.' },
];

// ── Okul / Aile parametreleri ────────────────────────────────────────────────
const ALWAYS_CATS: CategoryId[] = ['adult', 'gambling', 'social', 'gaming'];
const TIMED_CATS: CategoryId[] = ['social', 'gaming'];
export interface OkulAileParams {
  target: 'all' | 'devices'; devices: string[]; groups: number[];
  categories: CategoryId[];                                             // her zaman engellenenler
  timed: { categories: CategoryId[]; windows: TimeWindow[] } | null;    // saat aralığında (yalnız cihaz / grup hedefi)
  safeSearch: boolean; dnsGuardAll: boolean;
}
const RULE_ALWAYS = 'Okul/Aile — her zaman';
const RULE_TIMED = 'Okul/Aile — saat aralığı';

// Gövde → parametreler + oluşturulacak ebeveyn kuralları (parental.validateRule'dan geçmiş). Yan etkisiz.
export function parseOkulAile(body: any): { params: OkulAileParams; rules: any[] } | { error: string } {
  const target = body?.target === 'all' || body?.target === 'devices' ? body.target : null;
  if (!target) return { error: 'Hedef seçin: tüm ağ ya da seçili cihazlar / gruplar' };
  const devices = target === 'devices' && Array.isArray(body?.devices) ? [...new Set(body.devices.map((m: unknown) => String(m).toLowerCase()))] as string[] : [];
  const groups = target === 'devices' && Array.isArray(body?.groups) ? [...new Set(body.groups.map(Number))] as number[] : [];
  const cats = (x: unknown) => (Array.isArray(x) ? [...new Set(x)] : []) as CategoryId[];
  const categories = cats(body?.categories);
  if (categories.some(c => !ALWAYS_CATS.includes(c))) return { error: 'Bu şablonda kullanılamayan kategori' };
  let timed: OkulAileParams['timed'] = null;
  if (body?.timed && typeof body.timed === 'object') {
    const tc = cats(body.timed.categories);
    if (tc.some(c => !TIMED_CATS.includes(c))) return { error: 'Saat aralığında yalnız sosyal medya ve oyun seçilebilir' };
    if (tc.length) timed = { categories: tc, windows: Array.isArray(body.timed.windows) ? body.timed.windows : [] };
  }
  if (timed && target === 'all') return { error: 'Saat aralıklı engel yalnız seçili cihaz ve gruplara uygulanabilir (tüm ağ yalnız "her zaman")' };
  if (timed && timed.categories.some(c => categories.includes(c))) return { error: 'Bir kategori hem "her zaman" hem saat aralığında seçilemez' };
  const params: OkulAileParams = {
    target, devices, groups, categories, timed, safeSearch: body?.safeSearch === true, dnsGuardAll: body?.dnsGuardAll === true,
  };
  const targets = target === 'all' ? { devices: [], groups: [], all: true } : { devices, groups };
  const rules: any[] = [];
  if (categories.length) rules.push({ name: RULE_ALWAYS, enabled: true, targets, categories: ALWAYS_CATS.filter(c => categories.includes(c)), mode: 'always' });
  if (timed) rules.push({ name: RULE_TIMED, enabled: true, targets, categories: TIMED_CATS.filter(c => timed!.categories.includes(c)), mode: 'during', windows: timed.windows });
  for (const r of rules) {
    const v = validateRule(r);
    if ('error' in v) return { error: v.error };
    if (r.mode === 'during') params.timed = { categories: r.categories, windows: v.rule.windows };
  }
  if (!rules.length && !params.safeSearch && !params.dnsGuardAll) return { error: 'Seçili hiçbir koruma yok — en az bir kategori, güvenli arama ya da şifreli DNS engeli seçin' };
  return { params, rules };
}

// Kuralın içerik özeti: geri almada "o zamandan beri değişmemiş mi" karşılaştırması (ad, açık / kapalı, hedef, ne, ne zaman).
export function ruleHash(r: ParentalRule): string {
  return crypto.createHash('sha256').update(JSON.stringify([r.name, r.enabled, [...r.targets.devices].sort(),
    [...r.targets.groups].sort((a, b) => a - b), !!r.targets.all, r.blockAll, [...r.categories].sort(), [...r.sites].sort(), r.mode,
    r.windows])).digest('hex').slice(0, 24);
}

// ── Önizleme ─────────────────────────────────────────────────────────────────
export interface Change { kind: 'add' | 'on' | 'keep' | 'warn' | 'info'; text: string }
const DAY_TR: Record<string, string> = { mon: 'Pzt', tue: 'Sal', wed: 'Çar', thu: 'Per', fri: 'Cum', sat: 'Cmt', sun: 'Paz' };
const catText = (cs: CategoryId[]) => cs.map(c => CATEGORIES[c].label).join(', ');
const winText = (ws: TimeWindow[]) => ws.map(w => `${w.days.length === 7 ? 'her gün' : w.days.map(d => DAY_TR[d]).join(', ')} ${w.start}–${w.end}`).join(' ve ');
const providersText = (ps: SafeSearchProvider[]) => ps.map(p => SAFESEARCH_PROVIDERS[p].label).join(', ');

async function targetText(p: OkulAileParams): Promise<string> {
  if (p.target === 'all') return "tüm ağ (Pi-hole'u DNS olarak kullanan, Pi-hole'un Default grubundaki her cihaz)";
  const names: string[] = [];
  if (p.groups.length) {
    const g = await dbAll(`SELECT id, name FROM device_groups WHERE id IN (${p.groups.map(() => '?').join(',')})`, p.groups) as any[];
    names.push(...p.groups.map(id => `${g.find(x => Number(x.id) === id)?.name || `grup #${id}`} grubu`));
  }
  if (p.devices.length) {
    const d = await dbAll(`SELECT lower(mac_address) AS mac, hostname, ip_address FROM devices WHERE lower(mac_address) IN (${p.devices.map(() => '?').join(',')})`, p.devices) as any[];
    names.push(...p.devices.map(m => { const x = d.find(y => y.mac === m); return x?.hostname || x?.ip_address || m; }));
  }
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} ve ${names.length - 4} hedef daha` : names.join(', ');
}

async function groupsExist(ids: number[]): Promise<boolean> {
  if (!ids.length) return true;
  const rows = await dbAll(`SELECT id FROM device_groups WHERE id IN (${ids.map(() => '?').join(',')})`, ids) as any[];
  return rows.length === ids.length;
}

async function activeInstance(key: TemplateKey): Promise<any | null> {
  return (await dbGet("SELECT * FROM policy_templates WHERE tkey = ? AND state != 'undone' ORDER BY id DESC LIMIT 1", [key])) || null;
}

export async function previewTemplate(key: string, body: any): Promise<{ changes: Change[] }> {
  const v = await checkApplicable(key, body);
  const p = v.params;
  const changes: Change[] = [];
  const who = await targetText(p);
  for (const r of v.rules) {
    changes.push({ kind: 'add', text: r.mode === 'always'
      ? `Ebeveyn kuralı eklenir — «${r.name}»: ${who} için ${catText(r.categories)} her zaman engellenir.`
      : `Ebeveyn kuralı eklenir — «${r.name}»: ${who} için ${catText(r.categories)} ${winText(p.timed!.windows)} arasında engellenir.` });
  }
  if (v.rules.some(r => r.categories.some((c: CategoryId) => CATEGORIES[c].lists))) {
    changes.push({ kind: 'info', text: 'Yetişkin içerik / kumar hazır listeleri Pi-hole\'a indirilir (birkaç dakika sürebilir; o sürede engel eksik olabilir).' });
  }
  if (p.target === 'devices') {
    changes.push({ kind: 'info', text: 'Kural cihazı MAC adresinden tanır: gizli (rastgele) Wi-Fi adresi kullanan telefon kurala girmeyebilir.' });
  } else if (v.rules.length) {
    changes.push({ kind: 'warn', text: 'Tüm ağ: listelerdeki yanlış bir kayıt evdeki herkesi etkiler — gerekirse Pi-hole → Beyaz Liste ya da tek tıkla «Geri al».' });
  }
  if (p.safeSearch) {
    const cfg = await readSafeSearchConfig();
    const want = [...new Set([...(cfg.enabled ? cfg.providers : []), ...SAFESEARCH_IDS])] as SafeSearchProvider[];
    if (cfg.enabled && want.length === cfg.providers.length) changes.push({ kind: 'keep', text: `Güvenli arama zaten açık (${providersText(cfg.providers)}) — değişmez.` });
    else {
      changes.push({ kind: 'on', text: `Güvenli arama açılır: ${providersText(want)} — tüm ağda; Pi-hole bir kez yeniden başlar (DNS birkaç saniye kesilir).` });
      const pv = await previewSafeSearch(want);
      for (const s of pv.skipped) changes.push({ kind: 'warn', text: `${SAFESEARCH_PROVIDERS[s.provider].label} atlanacak: ${s.reason}.` });
      const byReason = new Map<string, string[]>();
      for (const c of pv.conflicts) byReason.set(c.reason, [...(byReason.get(c.reason) || []), c.name]);
      for (const [why, names] of byReason) changes.push({ kind: 'warn', text: `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` ve ${names.length - 4} ad daha` : ''} atlanır (${why} var).` });
    }
  }
  const guard = await dnsGuardStatus();
  if (p.dnsGuardAll) {
    if (guard.enabled) changes.push({ kind: 'keep', text: 'Tüm ağda şifreli DNS engeli zaten açık — değişmez.' });
    else {
      changes.push({ kind: 'on', text: 'Tüm ağda şifreli DNS engeli açılır: ev ağının DNS\'i Pi-hole\'a yönlendirilir, DoT / bilinen DoH sunucuları kesilir (yalnız IPv4: IPv6\'yı modem dağıtıyorsa o yol açık kalır).' });
      changes.push({ kind: 'warn', text: 'Android\'de «Özel DNS» sabit bir sağlayıcıya ayarlı telefonların interneti kesilir (ayar «Otomatik» ya da «Kapalı» yapılmalı).' });
    }
  } else if (!guard.enabled) {
    // Neyin atlatılabileceği hedefe bağlı: cihaz / grup kuralının cihazlarında dış DNS ve bilinen DoH zaten kesilir (kuralın DNS
    // koruması — parental.ts renderNft); tüm ağ kuralının güvenlik duvarı kuralı yoktur.
    const ipv4 = '«tüm ağda şifreli DNS engeli» bunu kapatır (yalnız IPv4)';
    if (p.target === 'all' && v.rules.length) {
      changes.push({ kind: 'warn', text: `Tüm ağ kuralı${p.safeSearch ? ' ve güvenli arama' : ''}, kendi DNS'ini (ör. 8.8.8.8) ya da şifreli DNS (DoH / DoT) kullanan cihazda atlatılır — ${ipv4}.` });
    } else if (p.target === 'devices' && v.rules.length) {
      changes.push({ kind: 'info', text: `Hedef cihazlarda dış DNS ve bilinen şifreli DNS (DoH) sunucuları kuralla zaten kesilir${p.safeSearch ? `; hedef dışı cihazlar güvenli aramayı kendi DNS'i ya da şifreli DNS ile atlatabilir — ${ipv4}` : ''}.` });
    } else if (p.safeSearch) {
      changes.push({ kind: 'info', text: `Güvenli arama, kendi DNS'ini (ör. 8.8.8.8) ya da şifreli DNS (DoH / DoT) kullanan cihazda atlatılabilir — ${ipv4}.` });
    }
  }
  return { changes };
}

class TemplateError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

async function checkApplicable(key: string, body: any): Promise<{ params: OkulAileParams; rules: any[] }> {
  const def = TEMPLATE_DEFS.find(t => t.key === key);
  if (!def) throw new TemplateError('Bilinmeyen şablon', 404);
  if (!def.available) throw new TemplateError(`${def.title}: ${def.locked || 'henüz kullanılamaz'}`, 409);
  const v = parseOkulAile(body);
  if ('error' in v) throw new TemplateError(v.error);
  if (!(await groupsExist(v.params.groups))) throw new TemplateError('Seçilen cihaz grubu bulunamadı — sayfayı yenileyin');
  return v;
}

// ── Uygulama / geri alma ─────────────────────────────────────────────────────
interface Created {
  rules: { id: number; name: string; hash: string }[];
  dnsGuardAll: boolean;
  safeSearch: { enabled: boolean; providers: SafeSearchProvider[] } | null;
}
interface Prev { dnsGuardAll?: boolean; safeSearch?: { enabled: boolean; providers: SafeSearchProvider[] } }
const parseJson = <T>(s: unknown, d: T): T => { try { return (JSON.parse(String(s || '')) ?? d) as T; } catch { return d; } };
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}
// Şu an uygulanan kayıt: 'applying' satırı bununla eşleşiyorsa sürüyor; eşleşmiyorsa panel uygulama sırasında yeniden başlamış.
let inFlightId: number | null = null;

export async function applyTemplate(key: string, body: any): Promise<{ id: number; health: ParentalHealth; created: Created }> {
  return serial(async () => {
    const v = await checkApplicable(key, body);
    if (await activeInstance(key as TemplateKey)) throw new TemplateError('Bu şablon zaten uygulanmış — değiştirmek için önce «Geri al»', 409);
    const p = v.params;
    // Güvenli arama adresleri önce denetlenir (yan etkisiz): hiçbiri çözülemezse hiçbir şey değişmeden reddedilir
    let ss: { want: SafeSearchProvider[]; prev: { enabled: boolean; providers: SafeSearchProvider[] } } | null = null;
    if (p.safeSearch) {
      const cfg = await readSafeSearchConfig();
      const want = [...new Set([...(cfg.enabled ? cfg.providers : []), ...SAFESEARCH_IDS])] as SafeSearchProvider[];
      if (!cfg.enabled || want.length !== cfg.providers.length) {
        await assertSafeSearchResolvable(want);
        ss = { want, prev: { enabled: cfg.enabled, providers: cfg.providers } };
      }
    }
    const id = await dbInsert("INSERT INTO policy_templates (tkey, params, state) VALUES (?, ?, 'applying')", [key, JSON.stringify(p)]);
    inFlightId = id;
    const created: Created = { rules: [], dnsGuardAll: false, safeSearch: null };
    const prev: Prev = {};
    // Her adımda kayda: panel arada yeniden başlarsa «Geri al» neyin yapıldığını bilir. Ayar değiştirilmeden ÖNCE yazılır
    // (geri alma güncel durumu yine denetler: açılmamışsa dokunmaz).
    const record = () => dbRun('UPDATE policy_templates SET created = ?, prev = ? WHERE id = ?', [JSON.stringify(created), JSON.stringify(prev), id]);
    let health: ParentalHealth;
    try {
      for (const r of v.rules) {
        const rule = await createRule(r, { templateId: id });
        created.rules.push({ id: rule.id, name: rule.name, hash: ruleHash(rule) });
        await record();
      }
      if (p.dnsGuardAll && !(await dnsGuardStatus()).enabled) {
        prev.dnsGuardAll = false;
        created.dnsGuardAll = true;
        await record();
        await setDnsGuardAll(true);
      }
      // Pi-hole eşitlemesi bitsin; güvenli aramanın DNS yeniden başlatması (en sonda) onunla çakışmasın
      health = await applyParentalNow('koruma şablonu uygulandı');
      if (ss) {
        prev.safeSearch = ss.prev;
        created.safeSearch = { enabled: true, providers: ss.want };
        await record();
        await setSafeSearch({ enabled: true, providers: ss.want });
      }
      await dbRun("UPDATE policy_templates SET created = ?, prev = ?, state = 'applied' WHERE id = ?", [JSON.stringify(created), JSON.stringify(prev), id]);
    } catch (e) {
      // Yarım kalan uygulama geri alınır (az önce oluşturuldu — özet karşılaştırması gerekmez)
      for (const r of created.rules) await deleteRule(r.id).catch(() => undefined);
      if (created.dnsGuardAll) await setDnsGuardAll(false).catch(() => undefined);
      if (created.safeSearch && prev.safeSearch) await setSafeSearch(prev.safeSearch).catch(() => undefined);
      await dbRun('DELETE FROM policy_templates WHERE id = ?', [id]).catch(() => undefined);
      throw e;
    } finally {
      inFlightId = null;
    }
    const parts = [
      ...created.rules.map(r => `«${r.name}» kuralı`),
      ...(created.safeSearch ? [`güvenli arama (${providersText(created.safeSearch.providers)})`] : []),
      ...(created.dnsGuardAll ? ['tüm ağda şifreli DNS engeli'] : []),
    ];
    await recordEvent('templates', `Okul / Aile koruma şablonu uygulandı: ${parts.join(', ') || 'değişiklik yok (seçilenler zaten açıktı)'}${health.error ? ` — uyarı: ${health.error}` : ''}`,
      health.error ? 'warning' : 'info');
    return { id, health, created };
  });
}

// Yarım kalan uygulamanın (panel yeniden başladı) şablon işaretli ama kayda girmemiş kuralları: parametrelerden hesaplanan
// kuralların özetiyle karşılaştırılır — eşleşen şablonundur (silinir); eşleşmeyen sonradan değiştirilmiştir (korunur).
function orphanRules(row: any, created: Created, all: ParentalRule[]): Created['rules'] {
  const known = new Set((created.rules || []).map(r => r.id));
  const orphans = all.filter(r => r.templateId === Number(row.id) && !known.has(r.id));
  if (!orphans.length) return [];
  const v = parseOkulAile(parseJson<any>(row.params, {}));
  const want = new Set('error' in v ? [] : v.rules.map(r => {
    const x = validateRule(r);
    return 'error' in x ? '' : ruleHash({ ...x.rule, id: 0, legacy: false });
  }));
  return orphans.map(r => ({ id: r.id, name: r.name, hash: want.has(ruleHash(r)) ? ruleHash(r) : '' }));
}

export async function undoTemplate(id: number): Promise<{ removed: string[]; kept: string[]; missing: string[]; notes: string[]; health: ParentalHealth }> {
  if (inFlightId === id) throw new TemplateError('Şablon hâlâ uygulanıyor — bitince geri alabilirsiniz', 409);
  return serial(async () => {
    const row = await dbGet('SELECT * FROM policy_templates WHERE id = ?', [id]);
    if (!row) throw new TemplateError('Şablon kaydı bulunamadı', 404);
    if (row.state === 'undone') throw new TemplateError('Bu şablon zaten geri alınmış', 409);
    const created = parseJson<Created>(row.created, { rules: [], dnsGuardAll: false, safeSearch: null });
    const prev = parseJson<Prev>(row.prev, {});
    const all = await listRules();
    const byId = new Map(all.map(r => [r.id, r]));
    if (row.state === 'applying') created.rules = [...(created.rules || []), ...orphanRules(row, created, all)];
    const removed: string[] = [], kept: string[] = [], missing: string[] = [], notes: string[] = [];
    for (const cr of created.rules || []) {
      const r = byId.get(cr.id);
      // Yoksa ya da aynı numarada başka bir kural varsa (yedekten geri yükleme) dokunulmaz
      if (!r || r.templateId !== id) { missing.push(cr.name); continue; }
      if (ruleHash(r) === cr.hash) { await deleteRule(r.id); removed.push(cr.name); }
      else {
        // Kullanıcı değiştirmiş: silinmez, şablon işareti kalkar (artık sıradan bir ebeveyn kuralı)
        await dbRun('UPDATE parental_rules SET template_id = NULL WHERE id = ? AND template_id = ?', [r.id, id]);
        kept.push(`«${cr.name}» kuralı (sonradan değiştirilmiş — Ebeveyn Kontrol'de duruyor)`);
      }
    }
    if (created.dnsGuardAll) {
      if ((await dnsGuardStatus()).enabled) { await setDnsGuardAll(prev.dnsGuardAll === true); notes.push('tüm ağda şifreli DNS engeli kapatıldı'); }
      else notes.push('tüm ağda şifreli DNS engeli zaten kapalıydı');
    }
    // Pi-hole eşitlemesi önce bitsin; güvenli aramanın DNS yeniden başlatması en sonda
    const health = await applyParentalNow('koruma şablonu geri alındı');
    if (created.safeSearch) {
      const cfg = await readSafeSearchConfig();
      if (cfg.enabled === created.safeSearch.enabled && sameSet(cfg.providers, created.safeSearch.providers)) {
        const back = prev.safeSearch || { enabled: false, providers: cfg.providers };
        await setSafeSearch(back);
        notes.push(back.enabled ? `güvenli arama önceki sağlayıcılara döndü (${providersText(back.providers)})` : 'güvenli arama kapatıldı');
      } else if (row.state === 'applying') {
        // Yarım kalan uygulama güvenli aramayı açamadan kesildi: ayar şablonun değil, dokunulmaz
        notes.push('güvenli arama açılmamıştı — dokunulmadı');
      } else {
        kept.push('güvenli arama ayarı (sonradan değiştirilmiş — Koruma Şablonları → Güvenli arama)');
      }
    }
    await dbRun("UPDATE policy_templates SET state = 'undone' WHERE id = ?", [id]);
    // Geçmiş kısa tutulur: son 10 geri alınmış kayıt
    await dbRun("DELETE FROM policy_templates WHERE state = 'undone' AND id NOT IN (SELECT id FROM policy_templates WHERE state = 'undone' ORDER BY id DESC LIMIT 10)");
    await recordEvent('templates', `Okul / Aile koruma şablonu geri alındı: ${[
      removed.length ? `${removed.length} kural silindi` : '', ...notes,
      kept.length ? `dokunulmadı: ${kept.join('; ')}` : '', missing.length ? `bulunamadı: ${missing.join(', ')}` : '',
    ].filter(Boolean).join(' · ') || 'değişiklik yok'}`, kept.length || missing.length ? 'warning' : 'info');
    return { removed, kept, missing, notes, health };
  });
}

// ── Liste / durum ────────────────────────────────────────────────────────────
export async function listTemplates() {
  const rows = await dbAll("SELECT * FROM policy_templates WHERE state != 'undone' ORDER BY id") as any[];
  const byId = new Map((await listRules()).map(r => [r.id, r]));
  // Ayarların bugünkü durumu (geri almanın yaptığı karşılaştırmanın aynısı): sonradan değiştirilmişse geri al ona dokunmaz
  const ssCfg = rows.length ? await readSafeSearchConfig() : null;
  const guardOn = rows.length ? (await dnsGuardStatus()).enabled : false;
  const templates = TEMPLATE_DEFS.map(def => {
    const row = [...rows].reverse().find(r => r.tkey === def.key);
    if (!row) return { ...def, instance: null };
    const created = parseJson<Created>(row.created, { rules: [], dnsGuardAll: false, safeSearch: null });
    const rules = (created.rules || []).map(cr => {
      const r = byId.get(cr.id);
      const status = !r || r.templateId !== row.id ? 'missing' : ruleHash(r) === cr.hash ? 'ok' : 'changed';
      return { id: cr.id, name: cr.name, status, enabled: r && status !== 'missing' ? r.enabled : null };
    });
    const missing = rules.filter(r => r.status === 'missing').length;
    // Uygulama sürüyor (bu süreçte): bozuk değil; 'applying' kalıp sürmüyorsa panel uygulama sırasında yeniden başlamıştır
    const applying = row.state === 'applying' && Number(row.id) === inFlightId;
    const ss = created.safeSearch;
    return {
      ...def,
      instance: {
        id: Number(row.id), state: String(row.state), appliedAt: row.applied_at, params: parseJson<OkulAileParams | null>(row.params, null),
        applying, rules,
        dnsGuardAll: !!created.dnsGuardAll, dnsGuardAllStatus: created.dnsGuardAll ? (guardOn ? 'ok' : 'changed') : null,
        safeSearch: ss ? { ...ss, status: ssCfg && ssCfg.enabled === ss.enabled && sameSet(ssCfg.providers, ss.providers) ? 'ok' : 'changed' } : null,
        broken: applying ? null : row.state === 'applying' ? 'Uygulama yarım kaldı (panel yeniden başladı) — «Geri al» ile temizleyin'
          : missing ? `${missing} kural bulunamadı (yedekten geri yükleme ya da elle silinmiş) — «Geri al» kalanları temizler` : null,
      },
    };
  });
  return { templates };
}

// Ters yöndeki sarkan referans: kuralın şablon işareti etkin bir şablon kaydına ait değilse (kayıt yok / geri alınmış ya da
// uygulanmış kaydın kural listesinde yok — kısmi yedek geri yükleme, eski sürümde alınmış yedek) işaret kaldırılır: kural
// sıradan bir ebeveyn kuralı olur (Ebeveyn Kontrol "şablon oluşturdu" demez). Yarım kalan ('applying') kaydınkilere dokunulmaz
// (geri al onları parametrelerden tanır). Açılışta ve geri yüklemede; kaldırılan işaret sayısı döner.
export async function reconcileTemplateMarks(): Promise<number> {
  return serial(async () => {
    // Doğrudan sorgu (listRules değil): şablon hiç kullanılmadıysa sütun yoktur ya da işaret yoktur — açılışta ebeveyn
    // modülünün şema / taşıma adımları erkene alınmaz, hiçbir şey yazılmaz.
    const marked = (await dbAll('SELECT id, template_id FROM parental_rules WHERE template_id IS NOT NULL').catch(() => []) as any[])
      .map(r => ({ id: Number(r.id), templateId: Number(r.template_id) }));
    if (!marked.length) return 0;
    const rows = await dbAll("SELECT id, state, created FROM policy_templates WHERE state != 'undone'") as any[];
    const byId = new Map(rows.map(r => [Number(r.id), r]));
    let n = 0;
    for (const r of marked) {
      const row = byId.get(r.templateId);
      if (row && (row.state === 'applying'
        || (parseJson<Created>(row.created, { rules: [], dnsGuardAll: false, safeSearch: null }).rules || []).some(c => c.id === r.id))) continue;
      await dbRun('UPDATE parental_rules SET template_id = NULL WHERE id = ? AND template_id = ?', [r.id, r.templateId]);
      n++;
    }
    return n;
  });
}

// Yedekten geri yükleme (index.ts applyRestored): sarkan kayıt sayısı (kural yedekte yok → şablon "bozuk" gösterilir).
export async function templatesRestoreNote(): Promise<string> {
  const { templates } = await listTemplates();
  const broken = templates.filter(t => t.instance?.broken).map(t => t.title);
  const active = templates.filter(t => t.instance).length;
  return broken.length ? `${broken.join(', ')}: kuralı yedekte yok — şablon «bozuk» görünür, «Geri al» ile temizlenir`
    : active ? `${active} şablon uygulanmış` : 'uygulanmış şablon yok';
}

// ── Uçlar: /api/templates, /api/safesearch (netAdminGuard + yazma sınırı; uyduda 409) ──
type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;
export function registerTemplateRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw }): void {
  app.use(['/api/templates', '/api/safesearch'], (req, res, next) => (req.method === 'GET' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — koruma şablonları ve güvenli arama ana cihazdadır' });
    deps.guard(req, res, next);
  });
  // Doğrulama / çakışma (TemplateError, SafeSearchError) kendi durumuyla; beklenmeyen hata 500
  const fail = (res: express.Response, e: any) => res.status(e instanceof TemplateError || e instanceof SafeSearchError ? e.status : 500).json({ error: e?.message || String(e) });

  app.get('/api/templates', async (_req, res) => {
    try {
      res.json({ ...(await listTemplates()), safeSearch: await safeSearchStatus(),
        categories: ALWAYS_CATS.map(id => ({ id, label: CATEGORIES[id].label, desc: CATEGORIES[id].desc, timed: TIMED_CATS.includes(id) })) });
    } catch (e: any) { fail(res, e); }
  });
  app.post('/api/templates/:key/preview', async (req, res) => {
    try { res.json(await previewTemplate(String(req.params.key), req.body)); } catch (e: any) { fail(res, e); }
  });
  app.post('/api/templates/:key/apply', async (req, res) => {
    try {
      const r = await applyTemplate(String(req.params.key), req.body);
      res.json({ success: true, id: r.id, health: r.health, ...(await listTemplates()) });
    } catch (e: any) { fail(res, e); }
  });
  app.post('/api/templates/:id/undo', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz şablon kaydı' });
    try { res.json({ success: true, ...(await undoTemplate(id)) }); } catch (e: any) { fail(res, e); }
  });

  app.get('/api/safesearch', async (_req, res) => {
    try { res.json(await safeSearchStatus()); } catch (e: any) { fail(res, e); }
  });
  app.put('/api/safesearch', async (req, res) => {
    const { enabled, providers } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (true / false) gerekli' });
    try {
      const before = await readSafeSearchConfig();
      const st = await setSafeSearch({ enabled, providers });
      if (before.enabled !== st.enabled || !sameSet(before.providers, st.providers)) {
        await recordEvent('templates', st.enabled
          ? `Güvenli arama açıldı: ${providersText(st.providers)}${st.conflicts.length ? ` — ${st.conflicts.length} ad çakışma nedeniyle atlandı` : ''}`
          : 'Güvenli arama kapatıldı');
      }
      res.json(st);
    } catch (e: any) { fail(res, e); }
  });
}

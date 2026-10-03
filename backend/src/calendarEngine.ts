// Takvim etiketi → profil motoru (G5.3). Takvimdeki bir etkinlik, kullanıcının ELLE tanımladığı "etiket → profil" bağlamasıyla
// ebeveyn ve kota / hız motorlarına GEÇİCİ bir kaplama verir; takvim nft'ye ya da Pi-hole'a kendisi YAZMAZ (yazsaydı ebeveyn
// motorunun 30 sn'lik ve kota motorunun 60 sn'lik döngüleri geri yazardı). Uygulama parental.ts (effectiveActive) ve qos.ts
// (setCalendarCaps) üzerinden; kaplama boşken iki motor da bayt bayt eskisi gibi çalışır.
//  - Kullanıcı kararları (2026-10-02, erişim sınıfı): yalnız TAM etiket eşleşir (bulanık / anahtar kelime / zaman penceresi
//    yok); dış takvimin (ICS, calendarSync.ts) her oluşumu panelden ONAY ister, OTOMATİK MOD YOK; panelde oluşturulan yerel
//    etkinlik onaylı sayılır. Her etkinleşmenin kesin bitişi var (etkinliğin bitişi ya da en çok max_days, 14 gün). Eşit
//    öncelikte KISITLAYICI kazanır. Takvim cihazın hız sınırını ve kotasını KALDIRAMAZ: yalnız ebeveyn kuralı askıya alınır,
//    qos.caps EK kısıt getirir. Kısılacak cihazları kullanıcının seçtiği gruplar / cihazlar belirler ("tümü" yok); muaf
//    listesi elle.
//  - Profil eylemleri: parental.suspend [kural id] (normal ya da takvim kuralı), parental.activate [yalnız takvim kuralı —
//    calendar_only], qos.caps {cihazlar, gruplar, down_kbps, up_kbps, muaf}. Çakışma: aynı kurala etkinleştir / askıya al
//    diyen iki bağlamadan önceliği yüksek olan, eşitlikte etkinleştir (kısıtlayıcı); hız kısıtında en küçük değer.
//  - Kapılar: motor kapalı (calendar_settings yok ya da enabled = false) → kaplama null, zamanlayıcı yok. Saat internetle
//    eşitlenmemişse (vault.ts clockSynced) ya da kaynak bayatsa (son başarılı eşitleme stale_hours'tan ve kaynağın iki eşitleme
//    aralığından eski) YENİ etkinleşme başlamaz; önceden başlamış olan bitişine dek sürer. "Çözülemedi" işaretli takvim olayı hiçbir zaman tetiklemez ve onaya
//    düşmez. Takvimden silinen etkinlik (sonraki başarılı eşitlemede görülür) hemen biter.
//  - Karar anahtarı oluşumun değişmez özelliklerinden (kaynak, UID, RECURRENCE-ID, başlangıç, bitiş, etiketler): etkinliğin
//    saati ya da etiketi değişirse anahtar değişir, onay yeniden istenir.
//  - Değerlendirme 60 sn'de bir ve en yakın başlangıç / bitiş anında (zamanlayıcı o ana kurulur); kaplamanın imzası
//    değişince ebeveyn ve kota motorları beklemeden uyandırılır. Açılışta veritabanından yeniden hesaplanır. Başarısız tur
//    (geçici veritabanı kilidi) motoru durdurmaz: yeniden denenir; hata 3 dk sürerse kaplama boşa döner (taban davranış).
//  - Olaylar 'calendar' kaynağıyla, oluşum başına bir kez: onay bekliyor (uyarı), yakında başlıyor, başladı, bitti,
//    uygulanamadı (uyarı). Profilin kural / grup referansları her turda doğrulanır (sarkan referans uyarısı).
//  - Yalnız ana cihazda; HA (G4.3) geldiğinde yalnız MASTER'da: tek kapı engineAllowed().
import crypto from 'crypto';
import fs from 'fs';
import type express from 'express';
import { dbAll, dbGet, dbRun, dbInsert, dbRunChanges, dbTimeMs } from './db';
import { isSatellite } from './role';
import { recordEvent } from './events';
import { clockSynced } from './vault';
import { normTag } from './calendarIcs';
import { INTERVAL_MIN, INTERVAL_MAX } from './calendarSync';
import { listRules, setCalendarOverlay, applyCalendarOverlay, type CalendarOverlay, type CalendarEffect, type ParentalRule } from './parental';
import { setCalendarCaps, runQos, isMac, normMac, type CalendarCap } from './qos';

const SETTINGS_KEY = 'calendar_settings';
const TICK_MS = 60_000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const LOOKAHEAD_MS = 7 * DAY_MS;          // onay kuyruğu: önümüzdeki 7 gün
const LOCAL_PAST_MS = 15 * DAY_MS;        // yerel tekrarların açılımı: [şimdi − 15 gün, şimdi + 62 gün]
const LOCAL_FUTURE_MS = 62 * DAY_MS;
const KEEP_DECISIONS_MS = 30 * DAY_MS;
const MAX_PROFILES = 30;
const MAX_BINDINGS = 50;
const MAX_LOCAL = 100;
const MIN_KBPS = 64;                      // qos.ts ile aynı aralık
const MAX_KBPS = 10_000_000;
const KEY_RE = /^[0-9a-f]{40}$/;
const SOURCE_RE = /^([0-9a-f]{12}|local)$/;
const WEEKLY_MAX_MIN = 6 * 1440;          // haftalık tekrarda en uzun süre: her hafta en az 1 gün boşluk (ardışık oluşumlar kalıcı engel olmasın)
const RETRY_MS = 5_000;                   // başarısız turdan sonra yeniden deneme (5, 10, 20, 40 sn, sonra 60 sn)
const FAIL_DROP_MS = 3 * TICK_MS;         // bu kadar süre tur başarısızsa kaplama boşa döner (taban davranış)

// Tek "etkin mi" kapısı: ana cihazda (uydu ağ geçidi işi yapmaz). G4.3 (HA) yedek düğümü burada da false döner.
export const engineAllowed = (): boolean => !isSatellite();

// ── Ayarlar ──────────────────────────────────────────────────────────────────
export interface EngineSettings { enabled: boolean; stale_hours: number; default_lead_min: number; max_days: number }
const DEFAULTS: EngineSettings = { enabled: false, stale_hours: 6, default_lead_min: 15, max_days: 14 };
const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
function parseSettings(raw: unknown): EngineSettings {
  let o: Record<string, unknown> = {};
  try { const v = JSON.parse(String(raw ?? '')); if (v && typeof v === 'object') o = v; } catch { /* yok / bozuk: varsayılan */ }
  return {
    enabled: o.enabled === true,
    stale_hours: clampInt(o.stale_hours, 1, 72, DEFAULTS.stale_hours),
    default_lead_min: clampInt(o.default_lead_min, 0, 240, DEFAULTS.default_lead_min),
    max_days: clampInt(o.max_days, 1, 14, DEFAULTS.max_days),
  };
}
// Satır yoksa varsayılan (kapalı); okuma HATASI fırlatılır: geçici bir veritabanı hatası motoru "kapalı" sanıp etkileri
// kaldırmasın, PUT /api/calendar/engine de varsayılanları kaydetmesin.
export async function loadSettings(): Promise<EngineSettings> {
  const r = await dbGet('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY]) as { value?: string } | undefined;
  return parseSettings(r?.value);
}
async function saveSettings(s: EngineSettings): Promise<void> {
  await dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [SETTINGS_KEY, JSON.stringify(s)]);
}

// ── Veritabanı ───────────────────────────────────────────────────────────────
let schemaReady: Promise<void> | null = null;
export function ensureEngineSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await dbRun(`CREATE TABLE IF NOT EXISTS calendar_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, actions TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      // sources: NULL = tüm kaynaklar (yerel dahil); JSON dizi = yalnız bu kaynak id'leri ('local' = panelde oluşturulan)
      await dbRun(`CREATE TABLE IF NOT EXISTS calendar_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, profile_id INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
        sources TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      await dbRun(`CREATE TABLE IF NOT EXISTS calendar_local_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, tag TEXT NOT NULL, start_utc TEXT NOT NULL,
        duration_min INTEGER NOT NULL, weekly INTEGER NOT NULL DEFAULT 0, until_utc TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      // Oluşum kararları (yedeğe girmez: dış etkinlikler geri yüklemeden sonra yeniden onay ister). flags: 1 onay bekliyor
      // bildirildi, 2 başladı, 4 bitti, 8 uygulanamadı bildirildi, 16 yakında başlıyor bildirildi
      await dbRun(`CREATE TABLE IF NOT EXISTS calendar_decisions (
        key TEXT PRIMARY KEY, source TEXT NOT NULL, uid TEXT NOT NULL DEFAULT '', rid TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]', start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        flags INTEGER NOT NULL DEFAULT 0, decided_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
const tableExists = async (name: string) => !!(await dbGet("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));

// ── Tipler ───────────────────────────────────────────────────────────────────
export interface CapsAction { devices: string[]; groups: number[]; down_kbps: number; up_kbps: number; exempt: string[] }
export interface ProfileActions { suspend: number[]; activate: number[]; caps: CapsAction | null }
export interface Profile { id: number; name: string; actions: ProfileActions }
export interface Binding { id: number; tag: string; profile_id: number; priority: number; sources: string[] | null; enabled: boolean }
export interface LocalEvent { id: number; title: string; tag: string; start: string; duration_min: number; weekly: boolean; until: string | null }
export type DecisionStatus = 'pending' | 'approved' | 'declined' | 'ended';
export interface Occurrence {
  key: string; source: string; sourceName: string; uid: string; rid: string; title: string; tags: string[];
  start: number; end: number; unresolved: boolean; local: boolean;
}
export interface DecisionState { status: DecisionStatus; flags: number }
// all: tüm ağ hedefli kural (G1.3-A, Pi-hole Default grubu) — takvim onu askıya alamaz / açamaz; alan yoksa false
export interface RuleInfo { name: string; calendarOnly: boolean; calArmed: boolean; enabled: boolean; all?: boolean }

const parseJson = <T>(s: unknown, dflt: T): T => { try { const v = JSON.parse(String(s ?? '')); return v ?? dflt; } catch { return dflt; } };
const ints = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number))].filter(n => Number.isInteger(n) && n > 0) : []);
const macs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(m => normMac(m)))].filter(isMac) : []);
function rowToProfile(r: any): Profile {
  const a = parseJson<any>(r.actions, {});
  const c = a?.caps && typeof a.caps === 'object' ? a.caps : null;
  return {
    id: Number(r.id), name: String(r.name || ''),
    actions: {
      suspend: ints(a?.suspend), activate: ints(a?.activate),
      caps: c ? { devices: macs(c.devices), groups: ints(c.groups), down_kbps: Number(c.down_kbps) || 0, up_kbps: Number(c.up_kbps) || 0, exempt: macs(c.exempt) } : null,
    },
  };
}
const rowToBinding = (r: any): Binding => {
  const src = r.sources === null || r.sources === undefined ? null : parseJson<unknown>(r.sources, null);
  return {
    id: Number(r.id), tag: String(r.tag || ''), profile_id: Number(r.profile_id), priority: Number(r.priority) || 0,
    sources: Array.isArray(src) ? src.map(String).filter(s => SOURCE_RE.test(s)) : null, enabled: !!Number(r.enabled),
  };
};
const rowToLocal = (r: any): LocalEvent => ({
  id: Number(r.id), title: String(r.title || ''), tag: String(r.tag || ''), start: String(r.start_utc), duration_min: Number(r.duration_min) || 0,
  weekly: !!Number(r.weekly), until: r.until_utc ? String(r.until_utc) : null,
});
export const occurrenceKey = (source: string, uid: string, rid: string, start: number, end: number, tags: string[]) =>
  crypto.createHash('sha1').update(JSON.stringify([source, uid, rid, start, end, [...tags].sort()])).digest('hex');

// Yerel etkinliğin oluşumları [a, b) içinde. Haftalık tekrar yerel saatle (yaz saati geçişinde saat aynı kalır).
export function expandLocal(ev: LocalEvent, a: number, b: number): Occurrence[] {
  const s0 = dbTimeMs(ev.start);
  if (!Number.isFinite(s0) || ev.duration_min <= 0) return [];
  // Haftalık tekrarda 6 günden uzun süre: ardışık oluşumlar (neredeyse) kesintisiz, kalıcı etki olurdu. Doğrulama reddeder;
  // yedekten gelen böyle bir satır hiç tetiklemez.
  if (ev.weekly && ev.duration_min > WEEKLY_MAX_MIN) return [];
  const dur = ev.duration_min * MIN_MS;
  const until = ev.until ? dbTimeMs(ev.until) : Infinity;
  const out: Occurrence[] = [];
  const base = new Date(s0);
  const mk = (s: number): Occurrence => ({
    key: occurrenceKey('local', String(ev.id), '', s, s + dur, [ev.tag]), source: 'local', sourceName: 'Panel', uid: String(ev.id), rid: '',
    title: ev.title, tags: [ev.tag], start: s, end: s + dur, unresolved: false, local: true,
  });
  if (!ev.weekly) return s0 < b && s0 + dur > a ? [mk(s0)] : [];
  // İlk aday: a'dan bir hafta önceki hafta (uzun etkinlik a'ya taşabilir)
  const skip = Math.max(0, Math.floor((a - dur - s0) / (7 * DAY_MS)) - 1);
  for (let k = skip; k < skip + 600; k++) {
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * k, base.getHours(), base.getMinutes(), base.getSeconds()).getTime();
    if (s >= b || s > until) break;
    if (s + dur > a) out.push(mk(s));
  }
  return out;
}

// ── Saf kaplama hesabı ───────────────────────────────────────────────────────
export interface OverlayInput {
  now: number; occs: Occurrence[]; bindings: Binding[]; profiles: Map<number, Profile>; decisions: Map<string, DecisionState>;
  rules: Map<number, RuleInfo>; settings: EngineSettings; clockOk: boolean; staleSources: Set<string>;
  groups?: Set<number>; sourceIds?: Set<string>;   // verilirse sarkan grup / takvim referansları da uyarılır
}
export interface Entry { occ: Occurrence; binding: Binding; profile: Profile; start: number; end: number; label: string }
export interface PendingItem { occ: Occurrence; bindings: Binding[]; end: number }
export interface OverlayResult {
  active: Entry[];                         // şu an uygulanan
  upcoming: Entry[];                       // onaylı, henüz başlamamış (önümüzdeki 7 gün)
  blocked: { entry: Entry; reason: string }[];   // onaylı ve vakti gelmiş ama başlatılamayan (saat / bayat kaynak)
  pending: PendingItem[];
  parental: CalendarOverlay;
  caps: { action: CapsAction; until: number; label: string }[];
  conflicts: string[];
  warnings: string[];                      // sarkan referanslar vb.
  nextBoundary: number | null;
}
const entryLabel = (occ: Occurrence, b: Binding, p: Profile) => `#${b.tag} → ${p.name}${occ.title ? ` («${occ.title}»)` : ''}`;
export function bindingMatches(b: Binding, occ: Occurrence): boolean {
  return b.enabled && occ.tags.includes(b.tag) && (b.sources === null || b.sources.includes(occ.source));
}

// Profil eylemlerinin referans denetimi (her tur): olmayan kural, takvim kuralı olmayan "etkinleştir", tüm ağ hedefli kural,
// olmayan cihaz grubu (groups verilmezse grup denetlenmez)
const ALL_TARGET = (r: RuleInfo) => `«${r.name}» tüm ağ hedefli (Pi-hole Default grubu) — takvimle açılıp kapatılamaz`;
export function profileProblems(p: Profile, rules: Map<number, RuleInfo>, groups?: Set<number>): string[] {
  const out: string[] = [];
  for (const id of p.actions.suspend) {
    const r = rules.get(id);
    if (!r) out.push(`«${p.name}»: askıya alınacak kural #${id} artık yok`);
    else if (r.all) out.push(`«${p.name}»: ${ALL_TARGET({ ...r, name: r.name || `#${id}` })}`);
  }
  for (const id of p.actions.activate) {
    const r = rules.get(id);
    if (!r) out.push(`«${p.name}»: etkinleştirilecek kural #${id} artık yok`);
    else if (!r.calendarOnly) out.push(`«${p.name}»: «${r.name || `#${id}`}» takvim kuralı değil — etkinleştirilmez (Ebeveyn Kontrol'de "Yalnız takvimle çalışır" seçin)`);
    else if (r.all) out.push(`«${p.name}»: ${ALL_TARGET({ ...r, name: r.name || `#${id}` })}`);
  }
  if (groups && p.actions.caps) for (const g of p.actions.caps.groups) if (!groups.has(g)) out.push(`«${p.name}»: hız kısıtı grubu #${g} artık yok`);
  return out;
}
// Etiket bağlamasının kaynak referansları: silinmiş takvim (bağlama o kaynaktan artık tetiklenmez)
export function bindingProblems(bindings: Binding[], sourceIds: Set<string>): string[] {
  const out: string[] = [];
  for (const b of bindings) for (const s of b.sources ?? []) if (s !== 'local' && !sourceIds.has(s)) out.push(`#${b.tag} bağlaması: seçili takvim (${s}) artık yok`);
  return out;
}

export function computeOverlay(inp: OverlayInput): OverlayResult {
  const { now, settings } = inp;
  const res: OverlayResult = {
    active: [], upcoming: [], blocked: [], pending: [], parental: { suspend: new Map(), activate: new Map() }, caps: [], conflicts: [], warnings: [], nextBoundary: null,
  };
  const bound = (t: number) => { if (t > now && (res.nextBoundary === null || t < res.nextBoundary)) res.nextBoundary = t; };
  for (const p of inp.profiles.values()) res.warnings.push(...profileProblems(p, inp.rules, inp.groups));
  if (inp.sourceIds) res.warnings.push(...bindingProblems(inp.bindings, inp.sourceIds));
  for (const occ of inp.occs) {
    if (occ.unresolved || !(occ.end > occ.start)) continue;   // "çözülemedi": hiçbir zaman tetiklemez
    const bs = inp.bindings.filter(b => bindingMatches(b, occ) && inp.profiles.has(b.profile_id));
    if (!bs.length) continue;
    const end = Math.min(occ.end, occ.start + settings.max_days * DAY_MS);
    if (end <= now) continue;
    const d = inp.decisions.get(occ.key);
    const status: DecisionStatus = occ.local ? (d && (d.status === 'ended' || d.status === 'declined') ? d.status : 'approved') : d?.status ?? 'pending';
    if (status === 'pending') {
      if (occ.start < now + LOOKAHEAD_MS) res.pending.push({ occ, bindings: bs, end });
      continue;
    }
    if (status !== 'approved') continue;
    const entries = bs.map(b => { const p = inp.profiles.get(b.profile_id)!; return { occ, binding: b, profile: p, start: occ.start, end, label: entryLabel(occ, b, p) }; });
    if (occ.start > now) {
      if (occ.start < now + LOOKAHEAD_MS) res.upcoming.push(...entries);
      bound(occ.start);
      continue;
    }
    // Vakti gelmiş: yeni etkinleşme için saat eşitlenmiş ve kaynak taze olmalı; önceden başlamış (ve bitmemiş) olan bitişine
    // dek sürer. Bitmiş oluşum yeniden görünürse (bağlama yeniden açıldı, saat geri alındı) kapılardan yeniden geçer.
    const started = !!d && (d.flags & 2) !== 0 && (d.flags & 4) === 0;
    const why = !inp.clockOk ? 'Pi\'nin saati internetle eşitlenmedi' : !occ.local && inp.staleSources.has(occ.source) ? 'takvim uzun süredir eşitlenemiyor' : '';
    if (why && !started) { for (const e of entries) res.blocked.push({ entry: e, reason: why }); continue; }
    res.active.push(...entries);
    bound(end);
  }
  // Ebeveyn: kural başına öncelik; eşitlikte etkinleştir (kısıtlayıcı) kazanır. Etkinin bitişi, oylar bittikçe sonucun ilk
  // değiştiği an (firstChange): motor dursa da etki, onu doğuran etkinlikten uzun sürmez. Tüm ağ hedefli kurala oy yok.
  type Vote = { kind: 'activate' | 'suspend'; e: Entry };
  const winner = (vs: Vote[]): Vote['kind'] | '' => {
    if (!vs.length) return '';
    const top = Math.max(...vs.map(v => v.e.binding.priority));
    return vs.some(v => v.e.binding.priority === top && v.kind === 'activate') ? 'activate' : 'suspend';
  };
  const votes = new Map<number, Vote[]>();
  const vote = (id: number, v: Vote) => { const l = votes.get(id) ?? []; l.push(v); votes.set(id, l); };
  for (const e of res.active) {
    for (const id of e.profile.actions.suspend) { const r = inp.rules.get(id); if (r && !r.all) vote(id, { kind: 'suspend', e }); }
    for (const id of e.profile.actions.activate) { const r = inp.rules.get(id); if (r?.calendarOnly && !r.all) vote(id, { kind: 'activate', e }); }
  }
  for (const [id, vs] of votes) {
    const top = Math.max(...vs.map(v => v.e.binding.priority));
    const best = vs.filter(v => v.e.binding.priority === top);
    const kind = winner(vs) as Vote['kind'];
    const win = vs.filter(v => v.kind === kind);
    const until = firstChange(vs, v => v.e.end, winner);
    const label = (best.find(v => v.kind === kind) ?? win[0]).e.label;
    const eff: CalendarEffect = { until, label };
    if (kind === 'activate') res.parental.activate.set(id, eff); else res.parental.suspend.set(id, eff);
    const other = vs.filter(v => v.kind !== kind);
    if (other.length) {
      const name = inp.rules.get(id)?.name || `Kural #${id}`;
      const verb = (k: Vote['kind']) => (k === 'activate' ? 'etkinleştiriyor' : 'askıya alıyor');
      res.conflicts.push(`«${name}»: ${win[0].e.label} ${verb(kind)}, ${other[0].e.label} ${verb(other[0].kind)} — geçerli olan: ${verb(kind)} (${other.every(o => o.e.binding.priority < top) ? 'yüksek öncelik' : 'eşit öncelikte kısıtlayıcı'})`);
    }
  }
  for (const e of res.active) if (e.profile.actions.caps) res.caps.push({ action: e.profile.actions.caps, until: e.end, label: e.label });
  return res;
}

// Birleşik etkinin geçerlik sınırı: girdiler bittikçe sonucun (value) ilk değiştiği an. Sonucu değiştirmeyen bitişte etki
// bölünmez (sınırda gereksiz aç / kapa olmaz); değiştiren bitişte biter, motor o sınırda kalan etkiyi yeniden kurar.
export function firstChange<T>(items: T[], end: (x: T) => number, value: (live: T[]) => string): number {
  const cur = value(items);
  const ends = [...new Set(items.map(end))].sort((a, b) => a - b);
  for (const t of ends) if (value(items.filter(x => end(x) > t)) !== cur) return t;
  return ends[ends.length - 1];
}

// Hız kısıtları → MAC başına en küçük değer (0 = o yönde kısıt yok). Korunanlar ve muaflar dışarıda. Bitiş: firstChange
// (daha sıkı kısıt bitince etki de biter — motor dursa da sıkı değer kendi etkinliğinden uzun sürmez).
export function resolveCaps(caps: OverlayResult['caps'], groupMembers: Map<number, string[]>, protectedMacs: Set<string>): Map<string, CalendarCap & { until: number }> {
  const per = new Map<string, OverlayResult['caps']>();
  for (const c of caps) {
    const exempt = new Set(c.action.exempt);
    const set = new Set([...c.action.devices, ...c.action.groups.flatMap(g => groupMembers.get(g) || [])].map(normMac));
    for (const m of set) {
      if (!isMac(m) || exempt.has(m) || protectedMacs.has(m)) continue;
      const l = per.get(m) ?? [];
      l.push(c);
      per.set(m, l);
    }
  }
  const mn = (a: number, b: number) => (a && b ? Math.min(a, b) : a || b);
  const val = (l: OverlayResult['caps']) => l.reduce((v, c) => ({ downKbps: mn(v.downKbps, c.action.down_kbps), upKbps: mn(v.upKbps, c.action.up_kbps) }), { downKbps: 0, upKbps: 0 });
  const out = new Map<string, CalendarCap & { until: number }>();
  for (const [m, l] of per) out.set(m, { ...val(l), until: firstChange(l, c => c.until, x => { const v = val(x); return `${v.downKbps},${v.upKbps}`; }) });
  return out;
}

// ── Girdilerin okunması ──────────────────────────────────────────────────────
export async function loadProfiles(): Promise<Profile[]> {
  if (!(await tableExists('calendar_profiles'))) return [];
  return (await dbAll('SELECT * FROM calendar_profiles ORDER BY id') as any[]).map(rowToProfile);
}
export async function loadBindings(): Promise<Binding[]> {
  if (!(await tableExists('calendar_bindings'))) return [];
  return (await dbAll('SELECT * FROM calendar_bindings ORDER BY priority DESC, id') as any[]).map(rowToBinding);
}
async function loadLocal(): Promise<LocalEvent[]> {
  if (!(await tableExists('calendar_local_events'))) return [];
  return (await dbAll('SELECT * FROM calendar_local_events ORDER BY start_utc, id') as any[]).map(rowToLocal);
}
// Dış takvimin oluşumları (calendarSync.ts tabloları; açık kaynak, geçerli nesil) ve bayat kaynaklar
async function loadExternal(now: number, staleMs: number, maxDays: number): Promise<{ occs: Occurrence[]; stale: Set<string>; names: Map<string, string> }> {
  const stale = new Set<string>();
  const names = new Map<string, string>([['local', 'Panel']]);
  if (!(await tableExists('calendar_sources')) || !(await tableExists('calendar_events'))) return { occs: [], stale, names };
  for (const s of await dbAll('SELECT id, name, enabled, last_ok, interval_min FROM calendar_sources') as any[]) {
    names.set(String(s.id), String(s.name || ''));
    const ok = dbTimeMs(s.last_ok);
    // Kaynağın kendi eşitleme aralığı bayatlık süresinden uzunsa (en çok 6 sa) her turda bir süre "bayat" görünmesin: en az iki
    // aralık + 5 dk (last_ok eşitlemenin BAŞLANGICI; sonraki eşitleme bitişten aralık ± 60 sn sonra)
    const every = Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(Number(s.interval_min)) || INTERVAL_MIN)) * MIN_MS;
    if (!(now - ok < Math.max(staleMs, 2 * every + 5 * MIN_MS))) stale.add(String(s.id));
  }
  const rows = await dbAll(`SELECT e.source_id, e.uid, e.recurrence_id, e.summary, e.tags, e.dtstart_utc, e.dtend_utc, e.unresolved
    FROM calendar_events e JOIN calendar_sources s ON s.id = e.source_id AND s.gen = e.gen
    WHERE s.enabled = 1 AND e.dtend_utc > ? AND e.dtstart_utc < ? AND e.tags != '[]'`,
  [new Date(now - maxDays * DAY_MS).toISOString(), new Date(now + LOOKAHEAD_MS).toISOString()]) as any[];
  const occs: Occurrence[] = [];
  for (const r of rows) {
    const start = dbTimeMs(r.dtstart_utc), end = dbTimeMs(r.dtend_utc);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const tags = parseJson<unknown[]>(r.tags, []).map(String);
    const src = String(r.source_id), uid = String(r.uid), rid = String(r.recurrence_id || '');
    occs.push({
      key: occurrenceKey(src, uid, rid, start, end, tags), source: src, sourceName: names.get(src) || '', uid, rid,
      title: String(r.summary || ''), tags, start, end, unresolved: !!r.unresolved, local: false,
    });
  }
  return { occs, stale, names };
}
async function loadDecisions(): Promise<Map<string, DecisionState & { start: number; end: number; title: string; tags: string[]; source: string }>> {
  const m = new Map<string, DecisionState & { start: number; end: number; title: string; tags: string[]; source: string }>();
  if (!(await tableExists('calendar_decisions'))) return m;
  for (const r of await dbAll('SELECT * FROM calendar_decisions') as any[]) {
    const st = ['pending', 'approved', 'declined', 'ended'].includes(r.status) ? r.status as DecisionStatus : 'pending';
    m.set(String(r.key), { status: st, flags: Number(r.flags) || 0, start: dbTimeMs(r.start_utc), end: dbTimeMs(r.end_utc), title: String(r.title || ''),
      tags: parseJson<unknown[]>(r.tags, []).map(String), source: String(r.source) });
  }
  return m;
}
async function loadRuleInfo(): Promise<{ map: Map<number, RuleInfo>; rules: ParentalRule[] }> {
  const rules = await listRules();
  return { rules, map: new Map(rules.map(r => [r.id, { name: r.name, calendarOnly: !!r.calendarOnly, calArmed: !!r.calArmed, enabled: r.enabled,
    all: !!(r.targets as { all?: boolean } | undefined)?.all }])) };
}
// Var olan cihaz grupları (profilin hız kısıtı grup referansları için)
async function loadGroupIds(): Promise<Set<number>> {
  if (!(await tableExists('device_groups'))) return new Set();
  return new Set((await dbAll('SELECT id FROM device_groups') as any[]).map(r => Number(r.id)));
}
async function groupMembers(gids: number[]): Promise<Map<number, string[]>> {
  const m = new Map<number, string[]>();
  if (!gids.length) return m;
  const rows = await dbAll(`SELECT group_id, device_mac FROM device_group_members WHERE group_id IN (${gids.map(() => '?').join(',')})`, gids) as any[];
  for (const r of rows) {
    const g = Number(r.group_id);
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(normMac(r.device_mac));
  }
  return m;
}

// ── Motor ────────────────────────────────────────────────────────────────────
let protectedProvider: () => Promise<Set<string>> = async () => new Set();
async function protectedSet(): Promise<Set<string>> {
  try { return new Set([...await protectedProvider()].map(normMac)); } catch { return new Set(); }
}
interface Snapshot {
  parental: CalendarOverlay; caps: Map<string, CalendarCap & { until: number }>; result: OverlayResult; at: number; sig: string;
  clockOk: boolean; stale: string[]; names: Map<string, string>;
}
let enabledNow = false;          // ayar + rol kapısı (son okunan)
let snapshot: Snapshot | null = null;
let lastError: string | null = null;
let timer: NodeJS.Timeout | null = null;
let nextTickAt: number | null = null;
let running: Promise<void> | null = null;
let rerun = false;
let started = false;
let firstTick = true;            // açılıştaki ilk tur motorları uyandırmaz: ebeveyn (12 sn) ve kota (15 sn) açılış turları kaplamayı okur
let startedAt = 0;               // ilk tur yeniden denemeyle geç kaldıysa (10 sn'den sonra) motorlar yine uyandırılır
let failStreak = 0;              // art arda başarısız tur (geçici veritabanı kilidi vb.): yeniden deneme aralığı
let failingSince: number | null = null;
let endPending = false;          // kapatmada "bitti" işaretleri yazılamadıysa sonraki turda yeniden denenir

const EMPTY_OVERLAY = (): CalendarOverlay => ({ suspend: new Map(), activate: new Map() });
// Sağlayıcılar (parental.ts / qos.ts): motor kapalıyken null / boş — iki motor eskisi gibi
const overlayProvider = (): CalendarOverlay | null => (enabledNow ? snapshot?.parental ?? EMPTY_OVERLAY() : null);
const capsProvider = (): Map<string, CalendarCap> => {
  const out = new Map<string, CalendarCap>();
  if (!enabledNow || !snapshot) return out;
  const now = Date.now();
  for (const [m, c] of snapshot.caps) if (now < c.until) out.set(m, { downKbps: c.downKbps, upKbps: c.upKbps });
  return out;
};
const sigOf = (ov: CalendarOverlay | null, caps: Map<string, CalendarCap & { until: number }>) => JSON.stringify(ov ? [
  [...ov.suspend].map(([k, v]) => [k, v.until]).sort(), [...ov.activate].map(([k, v]) => [k, v.until]).sort(),
  [...caps].map(([k, v]) => [k, v.downKbps, v.upKbps, v.until]).sort(),
] : null);

const two = (n: number) => String(n).padStart(2, '0');
const fmt = (ms: number) => { const d = new Date(ms); return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const occText = (occ: Occurrence, end: number) => `«${occ.title || 'Başlıksız etkinlik'}» (${occ.tags.map(t => `#${t}`).join(' ')}, ${fmt(occ.start)}–${fmt(end)})`;

async function upsertDecision(occ: Occurrence, end: number, status: DecisionStatus, flagsOr = 0): Promise<void> {
  await dbRun(`INSERT INTO calendar_decisions (key, source, uid, rid, title, tags, start_utc, end_utc, status, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET flags = calendar_decisions.flags | excluded.flags, title = excluded.title`,
  [occ.key, occ.source, occ.uid, occ.rid, occ.title.slice(0, 200), JSON.stringify(occ.tags), new Date(occ.start).toISOString(), new Date(end).toISOString(), status, flagsOr]);
}
const setFlags = (key: string, f: number) => dbRun('UPDATE calendar_decisions SET flags = flags | ? WHERE key = ?', [f, key]);

// Motoru beklemeden uyandır (kayıt değişti, karar verildi, açıldı / kapandı)
export function kick(): void {
  if (!started) return;
  void runTick();
}
// Başarısız tur (ör. SQLITE_BUSY) motoru durdurmaz: zamanlayıcı yoksa kısa aralıkla yeniden denenir (5, 10, 20, 40 sn, sonra
// 60 sn). Son kaplama bu arada korunur (etkilerin bitişi zaten içinde); hata FAIL_DROP_MS sürerse kaplama boşa döner.
function runTick(): Promise<void> {
  // Süren tur varsa bir tur daha istenir; bekleyen çağıran (PUT / karar ucu) o güncel turu bekler, eski görüntüyü değil
  if (running) { rerun = true; return running.then(() => running ?? undefined); }
  running = tick().then(() => { failStreak = 0; failingSince = null; }, async e => {
    lastError = String((e as Error)?.message || e).slice(0, 300);
    console.error('[takvim motoru]', lastError);
    failStreak++;
    if (failingSince === null) failingSince = Date.now();
    if (snapshot && Date.now() - failingSince >= FAIL_DROP_MS) await dropOverlay(lastError);
  }).finally(() => {
    running = null;
    if (rerun) { rerun = false; void runTick(); }
    else if (failStreak && started && !timer) schedule(Date.now() + Math.min(TICK_MS, RETRY_MS * 2 ** Math.min(failStreak - 1, 4)));
  });
  return running;
}
// Motor uzun süre çalışamıyor: takvim etkileri kalkar (taban davranış), düzelince ilk başarılı tur yeniden kurar
async function dropOverlay(err: string): Promise<void> {
  snapshot = null;
  try {
    await wakeEngines();
    await recordEvent('calendar', `Takvim motoru çalışamıyor (${err}) — takvim etkileri durduruldu; düzelince kendiliğinden sürer`, 'warning');
  } catch { /* veritabanı hâlâ yazılamıyor olabilir */ }
}
function schedule(at: number): void {
  if (timer) clearTimeout(timer);
  const d = Math.max(1_000, at - Date.now());
  nextTickAt = Date.now() + d;
  timer = setTimeout(() => { timer = null; nextTickAt = null; void runTick(); }, d);
  timer.unref?.();
}
function stopTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextTickAt = null;
}

// Kaplama değişti: ebeveyn (nft + Pi-hole) ve kota / hız motorları hemen bir tur. Hata metni döner (yoksa null).
async function wakeEngines(): Promise<string | null> {
  const errs: string[] = [];
  try {
    const h = await applyCalendarOverlay();
    if (h.error) errs.push(`ebeveyn: ${h.error}`);
  } catch (e) { errs.push(`ebeveyn: ${String((e as Error)?.message || e)}`); }
  try { await runQos({ notify: false }); } catch (e) { errs.push(`hız: ${String((e as Error)?.message || e)}`); }
  return errs.length ? errs.join(' · ').slice(0, 300) : null;
}

async function endAllStarted(why: string): Promise<void> {
  if (!(await tableExists('calendar_decisions'))) return;
  const rows = await dbAll('SELECT key, title, tags, start_utc, end_utc FROM calendar_decisions WHERE (flags & 2) != 0 AND (flags & 4) = 0') as any[];
  for (const r of rows) {
    // "Başladı" işareti silinir: motor yeniden açılınca hâlâ süren oluşum yeniden başlar (saat / bayatlık kapısından geçerek)
    // ve başladı / bitti olayları yeniden yazılır
    await dbRun('UPDATE calendar_decisions SET flags = flags & ~6 WHERE key = ?', [String(r.key)]);
    await recordEvent('calendar', `Takvim kuralı bitti: «${r.title || 'Başlıksız etkinlik'}» — ${why}`);
  }
}

async function tick(): Promise<void> {
  const settings = await loadSettings();
  const on = settings.enabled && engineAllowed();
  if (!on) {
    firstTick = false;
    stopTimer();
    const was = enabledNow || snapshot !== null;
    enabledNow = false;
    snapshot = null;
    let err: string | null = null;
    if (was) { err = await wakeEngines(); endPending = true; }
    if (endPending) { await endAllStarted('takvim etkileri durduruldu'); endPending = false; }
    if (err) lastError = err;
    return;
  }
  await ensureEngineSchema();
  const now = Date.now();
  const [ext, bindings, profiles, locals, decisions, ruleInfo, groupIds, clockOk] = await Promise.all([
    loadExternal(now, settings.stale_hours * 3600_000, settings.max_days), loadBindings(), loadProfiles(), loadLocal(), loadDecisions(), loadRuleInfo(),
    loadGroupIds(), clockSynced().catch(() => false),
  ]);
  const occs = [...ext.occs, ...locals.flatMap(l => expandLocal(l, now - LOCAL_PAST_MS, now + LOCAL_FUTURE_MS))];
  const result = computeOverlay({
    now, occs, bindings, profiles: new Map(profiles.map(p => [p.id, p])), decisions, rules: ruleInfo.map, settings, clockOk, staleSources: ext.stale,
    groups: groupIds, sourceIds: new Set(ext.names.keys()),
  });
  const gids = [...new Set(result.caps.flatMap(c => c.action.groups))];
  const caps = resolveCaps(result.caps, await groupMembers(gids), await protectedSet());
  const sig = sigOf(result.parental, caps);
  const changed = !snapshot || snapshot.sig !== sig || !enabledNow;
  enabledNow = true;
  snapshot = { parental: result.parental, caps, result, at: now, sig, clockOk, stale: [...ext.stale], names: ext.names };
  let applyErr: string | null = null;
  if (changed && (!firstTick || Date.now() - startedAt > 10_000)) applyErr = await wakeEngines();
  firstTick = false;
  lastError = applyErr;

  // Kararlar ve olaylar (oluşum başına bir kez)
  const fresh: PendingItem[] = [];
  for (const p of result.pending) {
    const d = decisions.get(p.occ.key);
    if (!d) await upsertDecision(p.occ, p.end, 'pending');
    if (!d || !(d.flags & 1)) fresh.push(p);
  }
  if (fresh.length) {
    const list = fresh.slice(0, 3).map(p => occText(p.occ, p.end)).join(', ');
    await recordEvent('calendar', `${fresh.length} takvim etkinliği onay bekliyor: ${list}${fresh.length > 3 ? ', …' : ''} — Ağ Ajandası → Takvim kuralları'ndan onaylayın ya da reddedin`, 'warning');
    for (const p of fresh) await setFlags(p.occ.key, 1);
  }
  const lead = settings.default_lead_min * MIN_MS;
  const seenUp = new Set<string>();
  for (const e of result.upcoming) {
    if (seenUp.has(e.occ.key) || !lead || e.start - now > lead) continue;
    seenUp.add(e.occ.key);
    const d = decisions.get(e.occ.key);
    if (d && (d.flags & 16)) continue;
    await upsertDecision(e.occ, e.end, d?.status ?? 'approved', 16);
    const names = result.upcoming.filter(x => x.occ.key === e.occ.key).map(x => x.profile.name).join(', ');
    await recordEvent('calendar', `Takvim kuralı ${Math.max(1, Math.round((e.start - now) / MIN_MS))} dk sonra başlıyor: ${occText(e.occ, e.end)} → ${names}`);
  }
  const activeKeys = new Set<string>();
  for (const e of result.active) {
    if (activeKeys.has(e.occ.key)) continue;
    activeKeys.add(e.occ.key);
    const d = decisions.get(e.occ.key);
    const names = result.active.filter(x => x.occ.key === e.occ.key).map(x => x.profile.name).join(', ');
    let flags = d?.flags ?? 0;
    if (!(flags & 2) || (flags & 4)) {
      // İlk başlangıç ya da bitmiş oluşumun yeniden başlaması: "bitti" ve "uygulanamadı" işaretleri silinir (olaylar yeniden yazılır)
      await upsertDecision(e.occ, e.end, d?.status ?? 'approved', 2);
      if (flags & 4) await dbRun('UPDATE calendar_decisions SET flags = flags & ~12 WHERE key = ?', [e.occ.key]);
      flags = (flags | 2) & ~12;
      await recordEvent('calendar', `Takvim kuralı başladı: ${occText(e.occ, e.end)} → ${names}`);
    }
    const probs = result.active.filter(x => x.occ.key === e.occ.key).flatMap(x => profileProblems(x.profile, ruleInfo.map, groupIds));
    const fail = applyErr || (probs.length ? probs.join('; ') : null);
    if (fail && !(flags & 8)) {
      await setFlags(e.occ.key, 8);
      await recordEvent('calendar', `Takvim kuralı uygulanamadı: ${occText(e.occ, e.end)} — ${fail}`, 'warning');
    }
  }
  // Başlamış ama artık etkin olmayan: bitti (süresi doldu, takvimden silindi, erken bitirildi, saati değişti)
  for (const [key, d] of decisions) {
    if (!(d.flags & 2) || (d.flags & 4) || activeKeys.has(key)) continue;
    await setFlags(key, 4);
    const why = d.status === 'ended' ? 'erken bitirildi' : d.end <= now + 1000 ? 'süresi doldu' : 'etkinlik takvimde yok ya da değişti';
    await recordEvent('calendar', `Takvim kuralı bitti: «${d.title || 'Başlıksız etkinlik'}» — ${why}`);
  }
  await dbRun('DELETE FROM calendar_decisions WHERE end_utc < ? AND ((flags & 2) = 0 OR (flags & 4) != 0)', [new Date(now - KEEP_DECISIONS_MS).toISOString()]);
  const nb = result.nextBoundary;
  schedule(nb !== null && nb + 500 < now + TICK_MS ? nb + 500 : now + TICK_MS);
}

// Açılış (index.ts, yalnız ana cihaz): sağlayıcılar bağlanır; motor kapalıysa (varsayılan) zamanlayıcı kurulmaz.
export function startCalendarEngine(opts: { protectedMacs: () => Promise<Set<string>> }): void {
  if (started || !engineAllowed()) return;
  started = true;
  startedAt = Date.now();
  protectedProvider = opts.protectedMacs;
  setCalendarOverlay(overlayProvider);
  setCalendarCaps(capsProvider);
  void runTick();
}

// ── Doğrulama ────────────────────────────────────────────────────────────────
const validName = (v: unknown, max = 40) => {
  const s = String(v ?? '').trim();
  return s && [...s].length <= max && !/[\u0000-\u001f\u007f<>]/.test(s) ? s : null;
};
const cleanTag = (v: unknown) => {
  const t = normTag(String(v ?? '').trim().replace(/^#/, ''));
  return t && t.length <= 64 && /^[\p{L}\p{M}\p{N}_]+(?:-[\p{L}\p{M}\p{N}_]+)*$/u.test(t) ? t : null;
};
const kbpsOk = (v: number) => Number.isInteger(v) && (v === 0 || (v >= MIN_KBPS && v <= MAX_KBPS));
// groups verilirse hız kısıtının grupları var olmalı (uçlar verir; saf testler vermeyebilir)
export function validateActions(raw: any, rules: Map<number, RuleInfo>, groupIds?: Set<number>): { actions: ProfileActions } | { error: string } {
  const a = raw && typeof raw === 'object' ? raw : {};
  const listOk = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 50);
  if (!listOk(a.suspend) || !listOk(a.activate)) return { error: 'Kural listesi geçersiz (en çok 50)' };
  const suspend = ints(a.suspend), activate = ints(a.activate);
  for (const id of suspend) {
    const r = rules.get(id);
    if (!r) return { error: `Askıya alınacak kural #${id} bulunamadı` };
    if (r.all) return { error: ALL_TARGET({ ...r, name: r.name || `#${id}` }) };
  }
  for (const id of activate) {
    const r = rules.get(id);
    if (!r) return { error: `Etkinleştirilecek kural #${id} bulunamadı` };
    if (!r.calendarOnly) return { error: `«${r.name || `#${id}`}» takvim kuralı değil — yalnız "Yalnız takvimle çalışır" işaretli kurallar etkinleştirilebilir` };
    if (r.all) return { error: ALL_TARGET({ ...r, name: r.name || `#${id}` }) };
  }
  if (suspend.some(id => activate.includes(id))) return { error: 'Aynı kural hem askıya alınıp hem etkinleştirilemez' };
  let caps: CapsAction | null = null;
  if (a.caps !== undefined && a.caps !== null) {
    const c = a.caps;
    if (typeof c !== 'object' || c.all !== undefined || c.target === 'all') return { error: 'Hız kısıtında "tüm ağ" hedefi yok — grup ya da cihaz seçin' };
    if ((c.devices !== undefined && (!Array.isArray(c.devices) || c.devices.length > 100)) || (c.groups !== undefined && (!Array.isArray(c.groups) || c.groups.length > 50))
      || (c.exempt !== undefined && (!Array.isArray(c.exempt) || c.exempt.length > 100))) return { error: 'Hız kısıtı hedefi geçersiz' };
    const devices = (c.devices || []).map(normMac), exempt = (c.exempt || []).map(normMac), groups = (c.groups || []).map(Number);
    if (devices.some((m: string) => !isMac(m)) || exempt.some((m: string) => !isMac(m))) return { error: 'Geçersiz cihaz (MAC adresi)' };
    if (groups.some((g: number) => !Number.isInteger(g) || g <= 0)) return { error: 'Geçersiz cihaz grubu' };
    const gone = groupIds ? groups.find((g: number) => !groupIds.has(g)) : undefined;
    if (gone !== undefined) return { error: `Cihaz grubu #${gone} bulunamadı` };
    if (!devices.length && !groups.length) return { error: 'Hız kısıtı için en az bir grup ya da cihaz seçin' };
    const down = Number(c.down_kbps ?? 0), up = Number(c.up_kbps ?? 0);
    if (!kbpsOk(down) || !kbpsOk(up)) return { error: 'Hız boş (sınırsız) ya da 0,064–10000 Mbps olmalı' };
    if (!down && !up) return { error: 'Hız kısıtında indirme ya da yükleme hızı girin' };
    caps = { devices: [...new Set<string>(devices)], groups: [...new Set<number>(groups)], down_kbps: down, up_kbps: up, exempt: [...new Set<string>(exempt)] };
  }
  if (!suspend.length && !activate.length && !caps) return { error: 'En az bir eylem seçin: kural askıya al, takvim kuralını etkinleştir ya da hız kısıtı' };
  return { actions: { suspend, activate, caps } };
}
function validateBinding(b: any, profiles: Profile[], sourceIds: Set<string>): { binding: Omit<Binding, 'id'> } | { error: string } {
  const tag = cleanTag(b?.tag);
  if (!tag) return { error: 'Etiket geçersiz: harf, rakam, _ ve - (ör. #Sınav)' };
  const pid = Number(b?.profile_id);
  if (!profiles.some(p => p.id === pid)) return { error: 'Profil bulunamadı' };
  const priority = b?.priority === undefined ? 0 : Number(b.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) return { error: 'Öncelik 0–100 arası bir tam sayı olmalı' };
  let sources: string[] | null = null;
  if (b?.sources !== undefined && b.sources !== null) {
    if (!Array.isArray(b.sources) || !b.sources.length || b.sources.length > 10) return { error: 'Kaynak seçimi geçersiz' };
    sources = [...new Set(b.sources.map(String))] as string[];
    if (sources.some(s => s !== 'local' && !sourceIds.has(s))) return { error: 'Seçilen takvim bulunamadı' };
  }
  return { binding: { tag, profile_id: pid, priority, sources, enabled: b?.enabled === undefined ? true : !!b.enabled } };
}
function validateLocal(b: any, maxDays: number): { ev: Omit<LocalEvent, 'id'> } | { error: string } {
  const title = validName(b?.title, 80);
  if (!title) return { error: 'Başlık 1–80 karakter olmalı' };
  const tag = cleanTag(b?.tag);
  if (!tag) return { error: 'Etiket geçersiz' };
  const s = Date.parse(String(b?.start ?? ''));
  if (!Number.isFinite(s)) return { error: 'Başlangıç zamanı geçersiz' };
  const dur = Number(b?.duration_min);
  if (!Number.isInteger(dur) || dur < 1 || dur > maxDays * 1440) return { error: `Süre 1 dakika – ${maxDays} gün olmalı` };
  const weekly = !!b?.weekly;
  if (weekly && dur > WEEKLY_MAX_MIN) return { error: 'Haftalık tekrarda süre en çok 6 gün (her hafta en az bir gün boşluk kalır)' };
  let until: string | null = null;
  if (weekly && b?.until) {
    const u = Date.parse(String(b.until));
    if (!Number.isFinite(u) || u < s) return { error: 'Tekrar bitişi başlangıçtan sonra olmalı' };
    until = new Date(u).toISOString();
  }
  return { ev: { title, tag, start: new Date(s).toISOString(), duration_min: dur, weekly, until } };
}

// ── Önizleme (yan etkisiz) ───────────────────────────────────────────────────
export interface Preview {
  rules: { suspend: { id: number; name: string; problem: string | null }[]; activate: { id: number; name: string; problem: string | null }[] };
  devices: { mac: string; name: string; effects: string[] }[];
  caps: { down_kbps: number; up_kbps: number; devices: number; protected_skipped: number; exempt: number } | null;
  conflicts: string[]; warnings: string[];
}
const fmtMbps = (k: number) => (k ? `${(k / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 3 })} Mbps` : 'sınırsız');
export async function buildPreview(actions: ProfileActions, win: { start: number; end: number } | null, priority: number, selfProfile: number | null): Promise<Preview> {
  const { map: rules, rules: list } = await loadRuleInfo();
  const byId = new Map(list.map(r => [r.id, r]));
  const prot = await protectedSet();
  const devNames = new Map<string, string>();
  for (const d of await dbAll('SELECT mac_address, hostname, ip_address FROM devices') as any[]) devNames.set(normMac(d.mac_address), String(d.hostname || d.ip_address || ''));
  const gids = [...new Set([...actions.activate.flatMap(id => byId.get(id)?.targets.groups || []), ...actions.suspend.flatMap(id => byId.get(id)?.targets.groups || []),
    ...(actions.caps?.groups || [])])];
  const members = await groupMembers(gids);
  const ruleMacs = (r: ParentalRule) => new Set([...r.targets.devices, ...r.targets.groups.flatMap(g => members.get(g) || [])].map(normMac).filter(m => isMac(m) && !prot.has(m)));
  const eff = new Map<string, string[]>();
  const addEff = (m: string, t: string) => { const l = eff.get(m) ?? []; if (!l.includes(t)) l.push(t); eff.set(m, l); };
  const p: Preview = { rules: { suspend: [], activate: [] }, devices: [], caps: null, conflicts: [], warnings: [] };
  const ALL_NOTE = 'tüm ağ hedefli — takvimle açılıp kapatılamaz';
  for (const id of actions.suspend) {
    const r = byId.get(id), all = !!rules.get(id)?.all;
    p.rules.suspend.push({ id, name: r?.name || `Kural #${id}`, problem: r ? (all ? ALL_NOTE : !r.enabled && !r.calendarOnly ? 'kural kapalı — askıya almanın etkisi yok' : null) : 'kural yok' });
    if (r && !all) for (const m of ruleMacs(r)) addEff(m, `«${r.name || `#${id}`}» askıda`);
  }
  for (const id of actions.activate) {
    const r = byId.get(id), all = !!rules.get(id)?.all;
    p.rules.activate.push({ id, name: r?.name || `Kural #${id}`, problem: !r ? 'kural yok' : !r.calendarOnly ? 'takvim kuralı değil' : all ? ALL_NOTE : null });
    if (r?.calendarOnly && !all) for (const m of ruleMacs(r)) addEff(m, r.blockAll ? 'internet kesilir' : 'kategori / site engeli');
  }
  if (actions.caps) {
    const c = actions.caps;
    const all = new Set([...c.devices, ...c.groups.flatMap(g => members.get(g) || [])].map(normMac).filter(isMac));
    const ex = new Set(c.exempt);
    let protN = 0, exN = 0, n = 0;
    for (const m of all) {
      if (prot.has(m)) { protN++; continue; }
      if (ex.has(m)) { exN++; continue; }
      n++;
      addEff(m, `hız ↓${fmtMbps(c.down_kbps)} ↑${fmtMbps(c.up_kbps)}`);
    }
    p.caps = { down_kbps: c.down_kbps, up_kbps: c.up_kbps, devices: n, protected_skipped: protN, exempt: exN };
    if (!n) p.warnings.push('Hız kısıtına giren cihaz yok (seçilen gruplar boş ya da hepsi muaf / korunan)');
  }
  p.devices = [...eff].map(([mac, effects]) => ({ mac, name: devNames.get(mac) || '', effects })).sort((a, b) => (a.name || a.mac).localeCompare(b.name || b.mac, 'tr'));
  p.warnings.push(...profileProblems({ id: 0, name: 'Bu profil', actions }, rules, await loadGroupIds()));
  try { if (fs.readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim() !== '1') p.warnings.push('Pi şu an yönlendirme yapmıyor (ağ geçidi değil): kurallar ve hız kısıtı etkisiz kalır'); } catch { /* Linux değil */ }
  // Çakışmalar: aynı anda etkin / onaylı diğer girişler (pencere verilmezse şu an etkin olanlar)
  const res = snapshot?.result;
  if (res) {
    const others = [...res.active, ...res.upcoming].filter(e => e.profile.id !== selfProfile && (win ? e.start < win.end && e.end > win.start : res.active.includes(e)));
    for (const o of others) {
      for (const id of actions.activate) if (o.profile.actions.suspend.includes(id)) {
        p.conflicts.push(`«${byId.get(id)?.name || `#${id}`}»: ${o.label} askıya alıyor — ${o.binding.priority > priority ? 'yüksek öncelikli olduğu için o geçerli' : 'eşit ya da düşük öncelikte etkinleştirme (kısıtlayıcı) geçerli'}`);
      }
      for (const id of actions.suspend) if (o.profile.actions.activate.includes(id)) {
        p.conflicts.push(`«${byId.get(id)?.name || `#${id}`}»: ${o.label} etkinleştiriyor — ${priority > o.binding.priority ? 'bu profil yüksek öncelikli, askıya alma geçerli' : 'eşit ya da yüksek öncelikte etkinleştirme (kısıtlayıcı) geçerli'}`);
      }
      if (actions.caps && o.profile.actions.caps) p.conflicts.push(`Hız kısıtı ${o.label} ile örtüşüyor — aynı cihazda en küçük değer geçerli`);
    }
  }
  return p;
}

// ── Durum ────────────────────────────────────────────────────────────────────
const iso = (ms: number) => new Date(ms).toISOString();
const entryOut = (e: Entry, names: Map<string, string>) => ({
  key: e.occ.key, title: e.occ.title, tags: e.occ.tags, source: e.occ.source, source_name: e.occ.local ? 'Panel' : names.get(e.occ.source) || '',
  local: e.occ.local, start: iso(e.start), end: iso(e.end), clipped: e.end < e.occ.end, tag: e.binding.tag, profile_id: e.profile.id,
  profile: e.profile.name, priority: e.binding.priority,
});
export async function engineStatus() {
  const settings = await loadSettings();
  const s = snapshot;
  const names = s?.names ?? new Map<string, string>();
  return {
    settings, allowed: engineAllowed(), running: enabledNow && !!s, computed_at: s ? iso(s.at) : null, next_tick: nextTickAt ? iso(nextTickAt) : null,
    clock_synced: s ? s.clockOk : null, stale_sources: (s?.stale ?? []).map(id => names.get(id) || id), error: lastError,
    active: s ? s.result.active.map(e => entryOut(e, names)) : [],
    upcoming: s ? s.result.upcoming.map(e => entryOut(e, names)) : [],
    blocked: s ? s.result.blocked.map(b => ({ ...entryOut(b.entry, names), reason: b.reason })) : [],
    pending: s ? s.result.pending.length : 0,
    conflicts: s ? s.result.conflicts : [], warnings: s ? [...new Set(s.result.warnings)] : [],
    effects: s ? {
      suspend: [...s.parental.suspend].map(([id, e]) => ({ rule_id: id, until: iso(e.until), label: e.label })),
      activate: [...s.parental.activate].map(([id, e]) => ({ rule_id: id, until: iso(e.until), label: e.label })),
      caps: [...s.caps].map(([mac, c]) => ({ mac, down_kbps: c.downKbps, up_kbps: c.upKbps, until: iso(c.until) })),
    } : { suspend: [], activate: [], caps: [] },
  };
}

// ── Yedek ────────────────────────────────────────────────────────────────────
export const ENGINE_BACKUP_TABLES = ['calendar_profiles', 'calendar_bindings', 'calendar_local_events'];
export async function engineBackupRows(table: string): Promise<Record<string, unknown>[]> {
  if (!ENGINE_BACKUP_TABLES.includes(table) || !(await tableExists(table))) return [];
  return dbAll(`SELECT * FROM ${table} ORDER BY id`);
}
// Geri yüklemeden sonra: motor yeniden hesaplar (profillerin kural / grup referansları sarkıyorsa durumda uyarı olur)
export async function afterEngineRestore(): Promise<string> {
  kick();
  const s = await loadSettings();
  return s.enabled ? 'yeniden hesaplandı' : 'takvim motoru kapalı — Ağ Ajandası → Takvim kuralları';
}

// ── API ──────────────────────────────────────────────────────────────────────
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 300);
async function sourceIds(): Promise<Set<string>> {
  if (!(await tableExists('calendar_sources'))) return new Set();
  return new Set((await dbAll('SELECT id FROM calendar_sources') as any[]).map(r => String(r.id)));
}
const idParam = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// Uçlar (index.ts app.use('/api/calendar') kapısının arkasında: uyduda 409, netAdminGuard, yazma sınırı).
export function registerCalendarEngineRoutes(app: express.Express): void {
  app.get('/api/calendar/engine', async (_req, res) => {
    try { res.json(await engineStatus()); } catch (e) { res.status(500).json({ error: `Takvim motoru durumu okunamadı: ${errMsg(e)}` }); }
  });
  // Aç / kapat (kill-switch: enabled false — tüm takvim etkileri hemen kalkar) ve ayarlar
  app.put('/api/calendar/engine', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    try {
      const cur = await loadSettings();
      const next = { ...cur };
      if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled true ya da false olmalı' });
        next.enabled = b.enabled;
      }
      const num = (k: 'stale_hours' | 'default_lead_min' | 'max_days', lo: number, hi: number, label: string) => {
        if (b[k] === undefined) return null;
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < lo || n > hi) return `${label} ${lo}–${hi} olmalı`;
        next[k] = n;
        return null;
      };
      const err = num('stale_hours', 1, 72, 'Bayatlık süresi (saat)') || num('default_lead_min', 0, 240, 'Ön bildirim (dakika)') || num('max_days', 1, 14, 'En uzun süre (gün)');
      if (err) return res.status(400).json({ error: err });
      await ensureEngineSchema();
      await saveSettings(next);
      if (next.enabled !== cur.enabled) {
        await recordEvent('calendar', next.enabled ? 'Takvim kuralları açıldı' : 'Takvim etkileri durduruldu (takvim kuralları kapatıldı)', next.enabled ? 'info' : 'warning');
      }
      if (started) await runTick();
      res.json({ success: true, ...(await engineStatus()) });
    } catch (e) {
      res.status(500).json({ error: `Takvim motoru ayarı kaydedilemedi: ${errMsg(e)}` });
    }
  });

  // Profiller
  app.get('/api/calendar/profiles', async (_req, res) => {
    try {
      const { map } = await loadRuleInfo();
      const gids = await loadGroupIds();
      res.json({ profiles: (await loadProfiles()).map(p => ({ ...p, problems: profileProblems(p, map, gids) })) });
    } catch (e) { res.status(500).json({ error: `Profiller okunamadı: ${errMsg(e)}` }); }
  });
  const saveProfile = async (req: express.Request, res: express.Response, id: number | null) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const name = validName(b.name);
    if (!name) return res.status(400).json({ error: 'Profil adı 1–40 karakter olmalı' });
    try {
      const { map } = await loadRuleInfo();
      const v = validateActions(b.actions, map, await loadGroupIds());
      if ('error' in v) return res.status(400).json({ error: v.error });
      await ensureEngineSchema();
      if (id === null) {
        if ((await loadProfiles()).length >= MAX_PROFILES) return res.status(400).json({ error: `En çok ${MAX_PROFILES} profil` });
        const nid = await dbInsert('INSERT INTO calendar_profiles (name, actions) VALUES (?, ?)', [name, JSON.stringify(v.actions)]);
        kick();
        return res.json({ success: true, id: nid });
      }
      const n = await dbRunChanges('UPDATE calendar_profiles SET name = ?, actions = ? WHERE id = ?', [name, JSON.stringify(v.actions), id]);
      if (!n) return res.status(404).json({ error: 'Profil bulunamadı' });
      kick();
      res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: `Profil kaydedilemedi: ${errMsg(e)}` }); }
  };
  app.post('/api/calendar/profiles', (req, res) => { void saveProfile(req, res, null); });
  app.put('/api/calendar/profiles/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'Profil bulunamadı' });
    void saveProfile(req, res, id);
  });
  app.delete('/api/calendar/profiles/:id', async (req, res) => {
    const id = idParam(req.params.id);
    try {
      if (!id || !(await tableExists('calendar_profiles'))) return res.status(404).json({ error: 'Profil bulunamadı' });
      const used = (await loadBindings()).filter(b => b.profile_id === id).map(b => `#${b.tag}`);
      if (used.length) return res.status(409).json({ error: `Profil bağlamalarda kullanılıyor (${used.join(', ')}) — önce bağlamaları silin` });
      const n = await dbRunChanges('DELETE FROM calendar_profiles WHERE id = ?', [id]);
      if (!n) return res.status(404).json({ error: 'Profil bulunamadı' });
      kick();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: `Profil silinemedi: ${errMsg(e)}` }); }
  });

  // Bağlamalar (tam etiket → profil)
  app.get('/api/calendar/bindings', async (_req, res) => {
    try { res.json({ bindings: await loadBindings() }); } catch (e) { res.status(500).json({ error: `Bağlamalar okunamadı: ${errMsg(e)}` }); }
  });
  const saveBinding = async (req: express.Request, res: express.Response, id: number | null) => {
    try {
      const v = validateBinding(req.body, await loadProfiles(), await sourceIds());
      if ('error' in v) return res.status(400).json({ error: v.error });
      await ensureEngineSchema();
      const all = await loadBindings();
      if (all.some(x => x.id !== id && x.tag === v.binding.tag && x.profile_id === v.binding.profile_id)) return res.status(409).json({ error: 'Bu etiket bu profile zaten bağlı' });
      const params = [v.binding.tag, v.binding.profile_id, v.binding.priority, v.binding.sources ? JSON.stringify(v.binding.sources) : null, v.binding.enabled ? 1 : 0];
      if (id === null) {
        if (all.length >= MAX_BINDINGS) return res.status(400).json({ error: `En çok ${MAX_BINDINGS} bağlama` });
        const nid = await dbInsert('INSERT INTO calendar_bindings (tag, profile_id, priority, sources, enabled) VALUES (?, ?, ?, ?, ?)', params);
        kick();
        return res.json({ success: true, id: nid });
      }
      const n = await dbRunChanges('UPDATE calendar_bindings SET tag = ?, profile_id = ?, priority = ?, sources = ?, enabled = ? WHERE id = ?', [...params, id]);
      if (!n) return res.status(404).json({ error: 'Bağlama bulunamadı' });
      kick();
      res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: `Bağlama kaydedilemedi: ${errMsg(e)}` }); }
  };
  app.post('/api/calendar/bindings', (req, res) => { void saveBinding(req, res, null); });
  app.put('/api/calendar/bindings/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'Bağlama bulunamadı' });
    void saveBinding(req, res, id);
  });
  app.delete('/api/calendar/bindings/:id', async (req, res) => {
    const id = idParam(req.params.id);
    try {
      if (!id || !(await tableExists('calendar_bindings'))) return res.status(404).json({ error: 'Bağlama bulunamadı' });
      const n = await dbRunChanges('DELETE FROM calendar_bindings WHERE id = ?', [id]);
      if (!n) return res.status(404).json({ error: 'Bağlama bulunamadı' });
      kick();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: `Bağlama silinemedi: ${errMsg(e)}` }); }
  });

  // Yerel etkinlikler (panelde oluşturulan: onaylı sayılır)
  app.get('/api/calendar/local-events', async (_req, res) => {
    try {
      const now = Date.now();
      res.json({
        events: (await loadLocal()).map(ev => {
          const next = expandLocal(ev, now, now + LOCAL_FUTURE_MS)[0];
          return { ...ev, next_start: next ? iso(next.start) : null, next_end: next ? iso(next.end) : null };
        }),
      });
    } catch (e) { res.status(500).json({ error: `Etkinlikler okunamadı: ${errMsg(e)}` }); }
  });
  const saveLocal = async (req: express.Request, res: express.Response, id: number | null) => {
    try {
      const v = validateLocal(req.body, (await loadSettings()).max_days);
      if ('error' in v) return res.status(400).json({ error: v.error });
      await ensureEngineSchema();
      const params = [v.ev.title, v.ev.tag, v.ev.start, v.ev.duration_min, v.ev.weekly ? 1 : 0, v.ev.until];
      if (id === null) {
        if ((await loadLocal()).length >= MAX_LOCAL) return res.status(400).json({ error: `En çok ${MAX_LOCAL} yerel etkinlik` });
        const nid = await dbInsert('INSERT INTO calendar_local_events (title, tag, start_utc, duration_min, weekly, until_utc) VALUES (?, ?, ?, ?, ?, ?)', params);
        kick();
        return res.json({ success: true, id: nid });
      }
      const n = await dbRunChanges('UPDATE calendar_local_events SET title = ?, tag = ?, start_utc = ?, duration_min = ?, weekly = ?, until_utc = ? WHERE id = ?', [...params, id]);
      if (!n) return res.status(404).json({ error: 'Etkinlik bulunamadı' });
      kick();
      res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: `Etkinlik kaydedilemedi: ${errMsg(e)}` }); }
  };
  app.post('/api/calendar/local-events', (req, res) => { void saveLocal(req, res, null); });
  app.put('/api/calendar/local-events/:id', (req, res) => {
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ error: 'Etkinlik bulunamadı' });
    void saveLocal(req, res, id);
  });
  app.delete('/api/calendar/local-events/:id', async (req, res) => {
    const id = idParam(req.params.id);
    try {
      if (!id || !(await tableExists('calendar_local_events'))) return res.status(404).json({ error: 'Etkinlik bulunamadı' });
      const n = await dbRunChanges('DELETE FROM calendar_local_events WHERE id = ?', [id]);
      if (!n) return res.status(404).json({ error: 'Etkinlik bulunamadı' });
      kick();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: `Etkinlik silinemedi: ${errMsg(e)}` }); }
  });

  // Onay kuyruğu: bekleyenler (önümüzdeki 7 gün) + son kararlar
  app.get('/api/calendar/decisions', async (_req, res) => {
    try {
      const s = snapshot;
      const names = s?.names ?? new Map<string, string>();
      const decisions = await loadDecisions();
      const pending = (s?.result.pending ?? []).map(p => ({
        key: p.occ.key, title: p.occ.title, tags: p.occ.tags, source: p.occ.source, source_name: names.get(p.occ.source) || '',
        start: iso(p.occ.start), end: iso(p.end), clipped: p.end < p.occ.end,
        profiles: p.bindings.map(b => ({ tag: b.tag, priority: b.priority, profile_id: b.profile_id })),
      }));
      const recent = [...decisions].filter(([, d]) => d.status !== 'pending' && !d.source.startsWith('local'))
        .sort((a, b) => b[1].start - a[1].start).slice(0, 20)
        .map(([key, d]) => ({ key, title: d.title, tags: d.tags, source_name: names.get(d.source) || '', start: iso(d.start), end: iso(d.end), status: d.status }));
      res.json({ running: enabledNow && !!s, pending, recent });
    } catch (e) { res.status(500).json({ error: `Onay kuyruğu okunamadı: ${errMsg(e)}` }); }
  });
  // action: approve (onayla) | decline (reddet) | end (erken bitir — yerel etkinlik dahil)
  app.post('/api/calendar/decisions/:key', async (req, res) => {
    const key = String(req.params.key);
    const action = String((req.body || {}).action || '');
    if (!KEY_RE.test(key)) return res.status(404).json({ error: 'Etkinlik bulunamadı' });
    if (!['approve', 'decline', 'end'].includes(action)) return res.status(400).json({ error: 'action: approve, decline ya da end' });
    try {
      await ensureEngineSchema();
      const s = snapshot;
      const now = Date.now();
      const known = s ? [...s.result.pending.map(p => ({ occ: p.occ, end: p.end })), ...s.result.active.map(e => ({ occ: e.occ, end: e.end })),
        ...s.result.upcoming.map(e => ({ occ: e.occ, end: e.end })), ...s.result.blocked.map(b => ({ occ: b.entry.occ, end: b.entry.end }))].find(x => x.occ.key === key) : undefined;
      const row = await dbGet('SELECT status, end_utc FROM calendar_decisions WHERE key = ?', [key]) as { status: string; end_utc: string } | undefined;
      if (!known && !row) return res.status(404).json({ error: 'Etkinlik bulunamadı ya da süresi geçti — takvim motoru açık mı?' });
      const end = known ? known.end : dbTimeMs(row!.end_utc);
      if (end <= now) return res.status(409).json({ error: 'Etkinliğin süresi geçti' });
      if (action === 'approve' && known?.occ.local) return res.status(400).json({ error: 'Yerel etkinlik zaten onaylı' });
      const status: DecisionStatus = action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'ended';
      if (known && !row) await upsertDecision(known.occ, known.end, status);
      await dbRun('UPDATE calendar_decisions SET status = ?, decided_at = ? WHERE key = ?', [status, iso(now), key]);
      const title = known?.occ.title || '';
      await recordEvent('calendar', `Takvim etkinliği ${action === 'approve' ? 'onaylandı' : action === 'decline' ? 'reddedildi' : 'erken bitirildi'}: «${title || 'Başlıksız etkinlik'}»`);
      if (started) await runTick();
      res.json({ success: true, status });
    } catch (e) { res.status(500).json({ error: `Karar kaydedilemedi: ${errMsg(e)}` }); }
  });

  // Önizleme (yan etkisiz, yazma yok): ?profile=ID ya da ?actions=<JSON> (düzenlenen profil için ?self=ID: kendisiyle çakışma
  // sayılmaz); isteğe bağlı ?start&end (ISO) ve ?priority
  app.get('/api/calendar/preview', async (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      let actions: ProfileActions;
      let self: number | null = null;
      if (q.profile !== undefined) {
        self = idParam(q.profile);
        const p = (await loadProfiles()).find(x => x.id === self);
        if (!p) return res.status(404).json({ error: 'Profil bulunamadı' });
        actions = p.actions;
      } else {
        let raw: unknown;
        try { raw = JSON.parse(String(q.actions ?? '')); } catch { return res.status(400).json({ error: 'actions JSON olmalı' }); }
        const v = validateActions(raw, (await loadRuleInfo()).map);
        if ('error' in v) return res.status(400).json({ error: v.error });
        actions = v.actions;
        if (q.self !== undefined) self = idParam(q.self);
      }
      const s = q.start !== undefined ? Date.parse(String(q.start)) : NaN, e = q.end !== undefined ? Date.parse(String(q.end)) : NaN;
      const win = Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
      const pr = clampInt(q.priority, 0, 100, 0);
      res.json(await buildPreview(actions, win, pr, self));
    } catch (e) { res.status(500).json({ error: `Önizleme hazırlanamadı: ${errMsg(e)}` }); }
  });
}

// Hazır alan adı listeleri (Yetişkin içerik / Kumar ve bahis — StevenBlack). Tek kaynak: ebeveyn kuralları (parental.ts,
// Pi-hole bloklistesi olarak), ağ haritası rozetleri (contentActivity.ts) ve Routing (listDns.ts + system.ts, zapret.ts)
// aynı listeyi kullanır. Liste diskte önbelleğe alınır, en çok günde bir indirilir; indirilemezse eski önbellekle sürer.
// Bu modül proje modüllerini içe aktarmaz (system.ts ↔ parental.ts döngüsüne girmesin).
import fs from 'fs';
import path from 'path';

export type ListId = 'adult' | 'gambling';
export const LIST_IDS: ListId[] = ['adult', 'gambling'];
export const LIST_SOURCES: Record<ListId, { label: string; source: string; urls: string[] }> = {
  adult: {
    label: 'Yetişkin içerik', source: 'StevenBlack porn-only',
    urls: ['https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts'],
  },
  gambling: {
    label: 'Kumar ve bahis', source: 'StevenBlack gambling-only',
    urls: ['https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts'],
  },
};
// Routing satırında listeyi gösteren belirteç (traffic_routing.domains): "@list:adult".
export const LIST_TOKEN = /^@list:(adult|gambling)$/;

const CACHE_DIR = process.env.PI5_CONTENT_CACHE || '/var/cache/pi5-gateway/content-lists';
export const LIST_MAX_AGE_MS = 24 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;
// İnternetten gelen listeye katı denetim: dnsmasq satırına (server=/ad/…) ve Zapret listesine yalnız geçerli ad girer.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;

// hosts biçimi ("0.0.0.0 alan.adı") ya da düz alan adı listesi → küme.
export function parseHostsList(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const d = (parts.length > 1 ? parts[1] : parts[0]).toLowerCase().replace(/\.$/, '');
    if (d !== 'localhost' && !/^[\d.]+$/.test(d) && DOMAIN.test(d)) out.add(d);
  }
  return out;
}

// Üst alan adı da listedeyse alt alan adı atılır (dnsmasq server=/a.com/ ve Zapret alt adları kendisi kapsar): 83 bin
// satırlık liste ~52 bine iner, Pi-hole açılışı belirgin kısalır. Sıralı döner.
export function collapseCovered(set: Set<string>): string[] {
  const out: string[] = [];
  for (const d of set) {
    const p = d.split('.');
    let covered = false;
    for (let i = 1; i < p.length - 1 && !covered; i++) covered = set.has(p.slice(i).join('.'));
    if (!covered) out.push(d);
  }
  return out.sort();
}

type Loaded = { set: Set<string>; collapsed: string[] | null; mtimeMs: number; checkedAt: number; error: string | null };
const loaded = new Map<ListId, Loaded>();

export function getList(id: ListId): Set<string> | undefined {
  const l = loaded.get(id);
  return l && l.set.size ? l.set : undefined;
}

// Routing / Zapret için ayıklanmış liste (ilk istekte hesaplanır, liste değişince yenilenir).
export function collapsedList(id: ListId): string[] {
  const l = loaded.get(id);
  if (!l || !l.set.size) return [];
  if (!l.collapsed) l.collapsed = collapseCovered(l.set);
  return l.collapsed;
}

// Alan adı (ya da alt alan adı) hangi listede; en özelden genele, liste sırasıyla.
export function listOf(domain: string, ids: readonly ListId[] = LIST_IDS): ListId | null {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  const labels = d.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const s = labels.slice(i).join('.');
    for (const id of ids) if (loaded.get(id)?.set.has(s)) return id;
  }
  return null;
}

export type ListInfo = { id: ListId; label: string; source: string; count: number; collapsed: number; updatedAt: string | null; error: string | null };
export function listInfo(): ListInfo[] {
  return LIST_IDS.map(id => {
    const l = loaded.get(id);
    return {
      id, label: LIST_SOURCES[id].label, source: LIST_SOURCES[id].source, count: l?.set.size || 0,
      collapsed: l?.set.size ? collapsedList(id).length : 0,
      updatedAt: l?.mtimeMs ? new Date(l.mtimeMs).toISOString() : null, error: l?.error || null,
    };
  });
}

const fileOf = (id: ListId) => path.join(CACHE_DIR, `${id}.txt`);
const busy = new Map<ListId, Promise<boolean>>();

// Listeyi hazırlar: bellekte yoksa önbellekten okur; önbellek yoksa ya da maxAgeMs'den eskiyse indirir (başarısız indirme
// 30 dk'da bir yeniden denenir, eldeki liste korunur). true = içerik değişti (yeni yüklendi / indirilen farklı).
export function ensureList(id: ListId, maxAgeMs = LIST_MAX_AGE_MS): Promise<boolean> {
  const running = busy.get(id);
  if (running) return running;
  const p = loadOrRefresh(id, maxAgeMs).finally(() => busy.delete(id));
  busy.set(id, p);
  return p;
}

export async function ensureLists(ids: readonly ListId[] = LIST_IDS, maxAgeMs = LIST_MAX_AGE_MS): Promise<ListId[]> {
  const changed: ListId[] = [];
  for (const id of ids) if (await ensureList(id, maxAgeMs)) changed.push(id);
  return changed;
}

async function loadOrRefresh(id: ListId, maxAgeMs: number): Promise<boolean> {
  const file = fileOf(id);
  let cur = loaded.get(id);
  let changed = false;
  if (!cur) {
    cur = { set: new Set(), collapsed: null, mtimeMs: 0, checkedAt: 0, error: null };
    try {
      const st = fs.statSync(file);
      cur.set = parseHostsList(fs.readFileSync(file, 'utf8'));
      cur.mtimeMs = st.mtimeMs;
    } catch { /* önbellek yok */ }
    loaded.set(id, cur);
    changed = cur.set.size > 0;
  }
  const stale = !cur.set.size || Date.now() - cur.mtimeMs >= maxAgeMs;
  if (!stale || Date.now() - cur.checkedAt < RETRY_MS) return changed;
  cur.checkedAt = Date.now();
  try {
    const parts: string[] = [];
    for (const url of LIST_SOURCES[id].urls) {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      parts.push(await r.text());
    }
    const text = parts.join('\n');
    const set = parseHostsList(text);
    if (set.size < 100) throw new Error(`liste beklenenden kısa (${set.size} ad)`);
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, text);
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* salt okunur: yalnız bellekte */ }
    const same = set.size === cur.set.size && [...set].every(d => cur!.set.has(d));
    cur.mtimeMs = Date.now();
    cur.error = null;
    if (!same) { cur.set = set; cur.collapsed = null; changed = true; }
  } catch (e: any) {
    cur.error = `${LIST_SOURCES[id].label} listesi indirilemedi: ${String(e?.message || e).slice(0, 120)}`;
    console.warn(`[lists] ${cur.error}`);
  }
  return changed;
}

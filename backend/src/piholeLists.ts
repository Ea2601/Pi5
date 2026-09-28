// Pi-hole → Bloklisteleri / Beyaz Liste / Kara Liste / Yerel DNS: paneldeki kayıtlar Pi-hole'a gerçekten uygulanır.
// Eskiden yalnız veritabanındaydı (panelde beyaz listeye eklenen site Pi-hole'da engelli kalıyordu).
//  - Pi-hole v6'nın kendi API'si kullanılır (pihole allow/deny CLI'sinin yaptığı gibi): veritabanı dosyasına doğrudan
//    yazılmaz, FTL kaydı kendisi yapar ve listeleri yeniden yükler. Adres FTL'e DNS (CHAOS local.api.ftl) ile sorulur;
//    oturum /etc/pihole/cli_pw ile açılır (Pi-hole'un CLI'si de böyle yapar; parolasız API'de gerekmez).
//  - Panelin eklediği kayıtlar açıklamada "klyrix" ile işaretlenir; eşitleme YALNIZ bunları ekler/siler. Pi-hole'a kendi
//    arayüzünden eklenmiş kayıtlara dokunulmaz (panelde "Pi-hole'da ayrıca" olarak gösterilir).
//  - Yerel DNS (dns.hosts) kayıtlarında açıklama alanı yok: panelin son yazdığı kayıtlar app_settings'te tutulur.
//  - Bloklistesi değişince gravity (liste indirme) arka planda başlatılır.
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun } from './db';
import { isLinux } from './system';

const execFileP = promisify(execFile);
const MARK = 'klyrix';
const HOSTS_KEY = 'pihole_hosts_managed';
const FALLBACK_API = 'http://127.0.0.1:8080/api/';

export type PanelListType = 'adlist' | 'whitelist' | 'blacklist' | 'localdns';
interface PanelItem { id: number; list_type: PanelListType; value: string; comment: string; enabled: number }

// ─── Doğrulama / dönüşüm ───
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

// Paneldeki değer biçimi: alan adı ("*.site.com" = alt alan adları dahil), liste URL'si, "IP adı". Hata metni ya da null.
export function validateListValue(type: string, raw: unknown): string | null {
  const v = String(raw ?? '').trim();
  if (!v) return 'Değer boş olamaz';
  if (type === 'whitelist' || type === 'blacklist') {
    const d = v.replace(/^\*\./, '');
    return DOMAIN.test(d) ? null : 'Geçerli bir alan adı girin (ör. example.com ya da alt alan adlarıyla *.example.com)';
  }
  if (type === 'adlist') {
    return /^https?:\/\/[^\s"'<>]{4,500}$/i.test(v) ? null : 'Liste adresi http:// ya da https:// ile başlayan bir URL olmalı';
  }
  if (type === 'localdns') {
    const [ip, host, extra] = v.split(/\s+/);
    if (extra !== undefined || !ip || !host) return 'Biçim: "IP adı" (ör. 192.168.0.50 nas.lan)';
    if (!IPV4.test(ip) && !/^[0-9a-f:]{2,39}$/i.test(ip)) return 'Geçerli bir IP adresi girin';
    return HOSTNAME.test(host) ? null : 'Geçerli bir ad girin (harf, rakam, tire ve nokta)';
  }
  return 'Bilinmeyen liste türü';
}

export function normalizeListValue(type: string, raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (type === 'whitelist' || type === 'blacklist') return v.toLowerCase();
  if (type === 'localdns') { const [ip, host] = v.split(/\s+/); return `${ip} ${host.toLowerCase()}`; }
  return v;
}

// Beyaz/kara liste değeri → Pi-hole alan adı kaydı. "*.site.com" pihole --wild ile aynı düzenli ifadeye dönüşür.
function domainEntry(item: PanelItem): { type: 'allow' | 'deny'; kind: 'exact' | 'regex'; domain: string } {
  const type = item.list_type === 'whitelist' ? 'allow' : 'deny';
  const v = item.value.trim().toLowerCase();
  if (v.startsWith('*.')) return { type, kind: 'regex', domain: `(\\.|^)${v.slice(2).replace(/\./g, '\\.')}$` };
  return { type, kind: 'exact', domain: v };
}
const markComment = (c: string) => (c ? `${MARK}: ${c}` : MARK).slice(0, 200);
const isManaged = (c: unknown) => typeof c === 'string' && (c === MARK || c.startsWith(`${MARK}:`));

// ─── FTL API istemcisi ───
interface Ftl { call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>; close: () => Promise<void> }

async function apiBase(): Promise<string> {
  try {
    const port = (await execFileP('pihole-FTL', ['--config', 'dns.port'], { timeout: 5000 })).stdout.trim() || '53';
    const out = (await execFileP('dig', ['+short', '-p', port, 'chaos', 'txt', 'local.api.ftl', '@127.0.0.1'], { timeout: 5000 })).stdout;
    const urls = [...out.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    return urls.find(u => u.startsWith('http://')) || FALLBACK_API;
  } catch {
    return FALLBACK_API;
  }
}

async function openFtl(): Promise<Ftl> {
  const base = await apiBase();
  let sid: string | null = null;
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(sid ? { sid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  };
  let password = '';
  try { password = fs.readFileSync('/etc/pihole/cli_pw', 'utf8').trim(); } catch { /* parolasız API ya da CLI parolası kapalı */ }
  const auth = await req('POST', 'auth', { password });
  if (auth.status >= 400 || !auth.json?.session?.valid) {
    throw new Error(`Pi-hole API oturumu açılamadı (HTTP ${auth.status})`);
  }
  sid = auth.json.session.sid || null;
  return {
    call: req,
    close: async () => { if (sid) await req('DELETE', 'auth').catch(() => undefined); },
  };
}

const apiError = (r: { status: number; json: any }, what: string) =>
  `${what}: HTTP ${r.status}${r.json?.error?.message ? ` — ${r.json.error.message}` : ''}`;
// Toplu işlem yanıtındaki satır hataları (ör. geçersiz düzenli ifade)
const processedErrors = (r: { json: any }) =>
  (Array.isArray(r.json?.processed?.errors) ? r.json.processed.errors : []).map((e: any) => `${e.item}: ${e.error}`);

export interface ListSyncResult { ok: boolean; added: number; removed: number; gravity: boolean; errors: string[]; at: number }
let lastSync: ListSyncResult | null = null;
export const lastListSync = () => lastSync;
let running: Promise<ListSyncResult> | null = null;

// Paneldeki durum → Pi-hole. Aynı anda tek eşitleme (üst üste gelen istekler bekleyen sonucu paylaşır).
export function syncPiholeLists(): Promise<ListSyncResult> {
  if (!isLinux) return Promise.resolve({ ok: true, added: 0, removed: 0, gravity: false, errors: [], at: Date.now() });
  if (running) return running.then(() => syncPiholeLists());
  running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync(): Promise<ListSyncResult> {
  const result: ListSyncResult = { ok: false, added: 0, removed: 0, gravity: false, errors: [], at: Date.now() };
  const items = (await dbAll('SELECT * FROM pihole_lists') as PanelItem[]).filter(i => !validateListValue(i.list_type, i.value));
  let ftl: Ftl | null = null;
  try {
    ftl = await openFtl();

    // 1) Beyaz / kara liste (exact + regex)
    const want = new Map<string, { entry: ReturnType<typeof domainEntry>; comment: string }>();
    for (const i of items) {
      if (!i.enabled || (i.list_type !== 'whitelist' && i.list_type !== 'blacklist')) continue;
      const entry = domainEntry(i);
      want.set(`${entry.type}/${entry.kind}/${entry.domain}`, { entry, comment: markComment(i.comment) });
    }
    const cur = await ftl.call('GET', 'domains');
    if (cur.status !== 200) throw new Error(apiError(cur, 'alan adları okunamadı'));
    const have = new Map<string, any>();
    for (const d of cur.json?.domains || []) have.set(`${d.type}/${d.kind}/${d.domain}`, d);
    for (const [key, w] of want) {
      const h = have.get(key);
      if (h && !isManaged(h.comment)) continue; // Pi-hole'a elle eklenmiş: sahiplenilmez
      if (h && h.enabled) continue;
      const r = h
        ? await ftl.call('PUT', `domains/${w.entry.type}/${w.entry.kind}/${encodeURIComponent(w.entry.domain)}`,
          { comment: w.comment, groups: h.groups || [0], enabled: true })
        : await ftl.call('POST', `domains/${w.entry.type}/${w.entry.kind}`, { domain: w.entry.domain, comment: w.comment, enabled: true });
      if (r.status >= 300) result.errors.push(apiError(r, w.entry.domain));
      else { result.errors.push(...processedErrors(r)); if (!h) result.added++; }
    }
    const drop = [...have.entries()].filter(([key, d]) => isManaged(d.comment) && !want.has(key))
      .map(([, d]) => ({ item: d.domain, type: d.type, kind: d.kind }));
    if (drop.length) {
      const r = await ftl.call('POST', 'domains:batchDelete', drop);
      if (r.status >= 300) result.errors.push(apiError(r, 'alan adları silinemedi'));
      else result.removed += drop.length;
    }

    // 2) Bloklisteleri (block türü)
    const wantLists = new Map<string, string>();
    for (const i of items) if (i.enabled && i.list_type === 'adlist') wantLists.set(i.value.trim(), markComment(i.comment));
    const curLists = await ftl.call('GET', 'lists?type=block');
    if (curLists.status !== 200) throw new Error(apiError(curLists, 'bloklisteleri okunamadı'));
    const haveLists = new Map<string, any>();
    for (const l of curLists.json?.lists || []) if (l.type === 'block') haveLists.set(l.address, l);
    let listsChanged = false;
    for (const [address, comment] of wantLists) {
      const h = haveLists.get(address);
      if (h && (!isManaged(h.comment) || h.enabled)) continue;
      const r = h
        ? await ftl.call('PUT', `lists/${encodeURIComponent(address)}?type=block`, { comment, groups: h.groups || [0], enabled: true })
        : await ftl.call('POST', 'lists?type=block', { address, comment, enabled: true });
      if (r.status >= 300) result.errors.push(apiError(r, address));
      else { result.errors.push(...processedErrors(r)); listsChanged = true; if (!h) result.added++; }
    }
    const dropLists = [...haveLists.values()].filter(l => isManaged(l.comment) && !wantLists.has(l.address))
      .map(l => ({ item: l.address, type: 'block' }));
    if (dropLists.length) {
      const r = await ftl.call('POST', 'lists:batchDelete', dropLists);
      if (r.status >= 300) result.errors.push(apiError(r, 'bloklisteleri silinemedi'));
      else { result.removed += dropLists.length; listsChanged = true; }
    }

    // 3) Yerel DNS (dns.hosts): panelin önceki kayıtları çıkarılır, güncelleri eklenir; diğerleri korunur.
    const wantHosts = items.filter(i => i.enabled && i.list_type === 'localdns').map(i => normalizeListValue('localdns', i.value));
    const prevRow = await dbGet('SELECT value FROM app_settings WHERE key = ?', [HOSTS_KEY]) as any;
    let prev: string[] = [];
    try { prev = JSON.parse(prevRow?.value || '[]'); } catch { prev = []; }
    const cfg = await ftl.call('GET', 'config/dns/hosts');
    if (cfg.status !== 200) throw new Error(apiError(cfg, 'yerel DNS okunamadı'));
    const curHosts: string[] = Array.isArray(cfg.json?.config?.dns?.hosts) ? cfg.json.config.dns.hosts : [];
    const norm = (h: string) => h.trim().replace(/\s+/g, ' ');
    const kept = curHosts.filter(h => !prev.includes(norm(h)) || wantHosts.includes(norm(h)));
    const next = [...kept, ...wantHosts.filter(h => !kept.map(norm).includes(h))];
    if (next.join('\n') !== curHosts.join('\n')) {
      const r = await ftl.call('PATCH', 'config', { config: { dns: { hosts: next } } });
      if (r.status >= 300) result.errors.push(apiError(r, 'yerel DNS yazılamadı'));
      else {
        result.added += wantHosts.filter(h => !curHosts.map(norm).includes(h)).length;
        result.removed += curHosts.filter(h => !next.includes(h)).length;
      }
    }
    await dbRun('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [HOSTS_KEY, JSON.stringify(wantHosts)]);

    // 4) Bloklistesi değiştiyse liste indirme (gravity) arka planda — birkaç dakika sürebilir.
    if (listsChanged) {
      await execFileP('systemd-run', ['--quiet', '--collect', '--unit=pi5-gravity', 'pihole', '-g'], { timeout: 10000 })
        .then(() => { result.gravity = true; })
        .catch(e => { result.errors.push(`liste güncellemesi başlatılamadı: ${e?.message || e}`); });
    }
    result.ok = result.errors.length === 0;
  } catch (e: any) {
    result.errors.push(e?.message || String(e));
  } finally {
    await ftl?.close();
    result.at = Date.now();
    lastSync = result;
  }
  return result;
}

// Pi-hole'da panelin yönetmediği kayıtlar (salt okunur gösterim için). Ulaşılamazsa null.
export async function externalPiholeEntries(): Promise<{ whitelist: string[]; blacklist: string[]; adlist: string[]; localdns: string[] } | null> {
  if (!isLinux) return null;
  let ftl: Ftl | null = null;
  try {
    ftl = await openFtl();
    const [d, l, c] = await Promise.all([ftl.call('GET', 'domains'), ftl.call('GET', 'lists?type=block'), ftl.call('GET', 'config/dns/hosts')]);
    const prevRow = await dbGet('SELECT value FROM app_settings WHERE key = ?', [HOSTS_KEY]) as any;
    let prev: string[] = [];
    try { prev = JSON.parse(prevRow?.value || '[]'); } catch { prev = []; }
    const doms = (d.json?.domains || []).filter((x: any) => !isManaged(x.comment));
    return {
      whitelist: doms.filter((x: any) => x.type === 'allow').map((x: any) => x.domain),
      blacklist: doms.filter((x: any) => x.type === 'deny').map((x: any) => x.domain),
      adlist: (l.json?.lists || []).filter((x: any) => x.type === 'block' && !isManaged(x.comment)).map((x: any) => x.address),
      localdns: (Array.isArray(c.json?.config?.dns?.hosts) ? c.json.config.dns.hosts : [])
        .filter((h: string) => !prev.includes(h.trim().replace(/\s+/g, ' '))),
    };
  } catch {
    return null;
  } finally {
    await ftl?.close();
  }
}

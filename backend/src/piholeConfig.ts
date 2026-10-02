// Pi-hole → Ayarlar sekmesi ve engelleme aç/kapa: değerler panelin veritabanından değil Pi-hole'un kendisinden (pihole.toml)
// okunur ve oraya yazılır. Eskiden sekme yalnız service_config tablosunu güncelliyordu (hiçbir şey uygulanmıyordu) ve başlıktaki
// anahtar pihole-FTL servisini durduruyordu (tüm ağın DNS'i kesilir, açılışta da kapalı kalırdı).
//  - Ayarlar: system.ts applyFtlConfig — FTL dururken yazılır, sağlıklı açılmazsa önceki değerler geri gelir.
//  - Engelleme: Pi-hole API'si (POST /api/dns/blocking, isteğe bağlı süre); oturum yetmezse Pi-hole'un CLI'si (pihole
//    enable / disable). DNS hiç kesilmez; yalnız reklam / takip engeli durur.
// service_config satırları yedek dışa aktarımı ve görünüm (etiket, açıklama, tür) için kalır; uygulanan değer oraya da yazılır.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbRun } from './db';
import { isLinux, applyFtlConfig, ftlConfigGet } from './system';
import { openFtl } from './piholeLists';

const execFileP = promisify(execFile);

// Panel anahtarı → Pi-hole ayarı. upstream_dns_1/2 birlikte dns.upstreams dizisidir; blocking_enabled API ile.
const FTL_KEYS: Record<string, string> = {
  dnssec: 'dns.dnssec', cache_size: 'dns.cache.size', query_logging: 'dns.queryLogging',
  privacy_level: 'misc.privacylevel', rate_limit_count: 'dns.rateLimit.count',
};
const BOOL_KEYS = new Set(['dnssec', 'query_logging', 'blocking_enabled']);
const UPSTREAM = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]+)(#\d{1,5})?$/;

// `pihole-FTL --config dns.upstreams` çıktısı TIRNAKSIZ: [ 127.0.0.1#5335, 9.9.9.9 ] (JSON da kabul): her adres özgün
// biçimiyle (#port varsa korunur) — listDns.ts parseUpstreams ile aynı adres kalıbı.
export function parseUpstreamList(text: string | null): string[] {
  if (!text) return [];
  return [...text.matchAll(/([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-f]*:[0-9a-f:.]+)(?:#\d{1,5})?/gi)].map(m => m[0]);
}

export interface ConfigRow { category: string; key: string; value: string; label: string; description: string; type: string; options: string }

// Görünüm: veritabanı satırları, değerleri Pi-hole'dan okunanla değiştirilmiş (okunamazsa veritabanındaki kalır; live=false).
export async function piholeConfigView(rows: ConfigRow[]): Promise<{ rows: (ConfigRow & { live?: boolean })[] }> {
  if (!isLinux) return { rows };
  const live: Record<string, string> = {};
  const upsRaw = await ftlConfigGet('dns.upstreams');
  if (upsRaw !== null) {
    const ups = parseUpstreamList(upsRaw);
    live.upstream_dns_1 = ups[0] || '';
    live.upstream_dns_2 = ups[1] || '';
  }
  for (const [k, ftlKey] of Object.entries(FTL_KEYS)) {
    const v = await ftlConfigGet(ftlKey);
    if (v !== null) live[k] = v.replace(/^"|"$/g, '');
  }
  const b = await getBlocking().catch(() => null);
  if (b) live.blocking_enabled = b.enabled ? 'true' : 'false';
  return { rows: rows.map(r => (r.key in live ? { ...r, value: live[r.key], live: true } : r)) };
}

function checkValue(key: string, raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (BOOL_KEYS.has(key)) {
    if (v !== 'true' && v !== 'false') throw new Error(`${key}: true ya da false olmalı`);
    return v;
  }
  const int = (min: number, max: number) => {
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`${key}: ${min}-${max} arasında bir tam sayı olmalı`);
    return String(Number(v));
  };
  if (key === 'cache_size') return int(0, 1000000);
  if (key === 'rate_limit_count') return int(0, 1000000);
  if (key === 'privacy_level') return int(0, 3);
  if (key === 'upstream_dns_1' || key === 'upstream_dns_2') {
    if (v && !UPSTREAM.test(v)) throw new Error(`${key}: IP adresi olmalı (isteğe bağlı #port, ör. 127.0.0.1#5335)`);
    return v;
  }
  throw new Error(`Bilinmeyen Pi-hole ayarı: ${key}`);
}

// Değişiklikleri doğrular ve Pi-hole'a uygular; başarılı olanlar veritabanına da yazılır. DHCP alanları burada değil (DHCP
// Ayarları sayfası, pi-dhcp.sh).
export async function applyPiholeSettings(changes: Record<string, unknown>): Promise<{ applied: string[]; message: string }> {
  if (!isLinux) throw new Error('Pi-hole ayarları yalnız Pi üzerinde uygulanır');
  const keys = Object.keys(changes);
  if (!keys.length) throw new Error('Değişiklik yok');
  for (const k of keys) if (k.startsWith('dhcp_')) throw new Error('DHCP ayarları DHCP Ayarları sayfasından yapılır');
  const vals: Record<string, string> = {};
  for (const k of keys) vals[k] = checkValue(k, changes[k]);

  const pairs: [string, string][] = [];
  if ('upstream_dns_1' in vals || 'upstream_dns_2' in vals) {
    const cur = parseUpstreamList(await ftlConfigGet('dns.upstreams'));
    const list = [vals.upstream_dns_1 ?? cur[0] ?? '', vals.upstream_dns_2 ?? cur[1] ?? ''].filter(Boolean);
    if (!list.length) throw new Error('En az bir DNS sunucusu gerekli (önerilen: 127.0.0.1#5335 — Pi\'deki Unbound)');
    pairs.push(['dns.upstreams', JSON.stringify([...list, ...cur.slice(2)])]);
  }
  for (const [k, ftlKey] of Object.entries(FTL_KEYS)) if (k in vals) pairs.push([ftlKey, vals[k]]);

  if (pairs.length) {
    const r = await applyFtlConfig(pairs);
    if (!r.ok) throw new Error(r.error || 'Pi-hole ayarları uygulanamadı');
  }
  if ('blocking_enabled' in vals) await setBlocking(vals.blocking_enabled === 'true');
  for (const k of keys) await dbRun('UPDATE service_config SET value = ? WHERE service = ? AND key = ?', [vals[k], 'pihole', k]);
  return {
    applied: keys,
    message: pairs.length ? 'Pi-hole ayarları uygulandı (DNS birkaç saniye yeniden başladı)' : 'Pi-hole ayarları uygulandı',
  };
}

// ── engelleme ────────────────────────────────────────────────────────────────
export interface BlockingState { enabled: boolean; timer: number | null }

export async function getBlocking(): Promise<BlockingState> {
  if (!isLinux) return { enabled: true, timer: null };
  try {
    const ftl = await openFtl();
    try {
      const r = await ftl.call('GET', 'dns/blocking');
      if (r.status === 200 && r.json && typeof r.json.blocking === 'string') {
        return { enabled: r.json.blocking !== 'disabled', timer: typeof r.json.timer === 'number' ? Math.round(r.json.timer) : null };
      }
    } finally {
      await ftl.close();
    }
  } catch { /* API'ye ulaşılamadı: ayardan */ }
  const v = await ftlConfigGet('dns.blocking.active');
  if (v === null) throw new Error('Pi-hole engelleme durumu okunamadı (Pi-hole çalışıyor mu?)');
  return { enabled: v !== 'false', timer: null };
}

// minutes: kapatırken süre (dk; yoksa / 0 süresiz). Süre dolunca Pi-hole engellemeyi kendisi açar.
export async function setBlocking(enabled: boolean, minutes?: number): Promise<BlockingState> {
  if (!isLinux) throw new Error('Yalnız Pi üzerinde');
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60)) throw new Error('Süre 0-1440 dakika olmalı');
  const timer = !enabled && minutes ? minutes * 60 : null;
  let apiErr = '';
  try {
    const ftl = await openFtl();
    try {
      const r = await ftl.call('POST', 'dns/blocking', { blocking: enabled, timer });
      if (r.status < 300) return { enabled, timer };
      apiErr = `HTTP ${r.status}`;
    } finally {
      await ftl.close();
    }
  } catch (e: any) {
    apiErr = e?.message || String(e);
  }
  // Pi-hole'un kendi aracı (kendi oturumuyla aynı API'yi kullanır); süreli kapatma "pihole disable 5m"
  try {
    const args = enabled ? ['enable'] : ['disable', ...(timer ? [`${minutes}m`] : [])];
    await execFileP('pihole', args, { timeout: 20000 });
    return { enabled, timer };
  } catch (e: any) {
    throw new Error(`Pi-hole engellemesi ${enabled ? 'açılamadı' : 'kapatılamadı'} (API: ${apiErr}; pihole: ${(e?.stderr || e?.message || '').toString().trim().slice(0, 120)})`);
  }
}

// Eski kurulumların tohum değerleri: ikinci DNS 1.1.1.1 (uygulansaydı sorgular Unbound'u atlardı), gizlilik seçenekleri boş
// (seçim değiştirilemiyordu). Açılışta bir kez; kullanıcının kendi değerine dokunmaz.
export async function migratePiholeConfigRows(): Promise<void> {
  await dbRun("UPDATE service_config SET options = '0,1,2,3' WHERE service = 'pihole' AND key = 'privacy_level' AND (options IS NULL OR options = '')");
  await dbRun(
    "UPDATE service_config SET description = ? WHERE service = 'pihole' AND key = 'privacy_level'",
    ["0 = her şey görünür; 1 ve üstü alan adlarını gizler — Ziyaret Geçmişi, içerik rozetleri ve alan adı önerileri çalışmaz"],
  );
  await dbRun(
    "UPDATE service_config SET label = 'İkincil DNS', description = ? WHERE service = 'pihole' AND key = 'upstream_dns_2'",
    ['Boş bırakın: yalnız Pi\'deki Unbound. Dış bir sunucu (ör. 1.1.1.1) eklemek sorguların bir kısmını Unbound\'u atlayarak gönderir'],
  );
}

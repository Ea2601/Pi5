// Fail2Ban: panelin ayarları Fail2Ban'a gerçekten uygulanır. Eskiden ayarlar yalnız veritabanındaydı (sekmede "Muaf IPler
// 192.168.1.0/24" görünürken jail.local'de ignoreip yoktu: evdeki yönetici 3 hatalı SSH girişinde 2 saat dışarıda kalırdı).
//  - Panelin ayarları tek dosyada: /etc/fail2ban/jail.d/klyrix-panel.local — jail.local'den SONRA okunur, aynı ayarları
//    geçersiz kılar; jail.local'e (kurulumun ya da kullanıcının) dokunulmaz.
//  - Uygulama: yaz → `fail2ban-client -t` (yapılandırma sınaması) → çalışıyorsa `fail2ban-client reload`. Bir adım
//    başarısızsa dosya eski hâline döner (Fail2Ban durmasın: SSH korumasız kalırdı).
//  - Ev ağı muaf (kullanıcı kararı 2026-09-30): yerel adresler, Pi'nin ev ağı(ları), kurulum Wi-Fi'ı ve IPv6 yerel bağlantı
//    adresleri. Ev ağı değişirse (sabit adres, internet kartı, Wi-Fi köprüsü) dosya kendiliğinden güncellenir (ensure).
//  - Recidive: 1 günde 5 kez yasaklanan adres 1 hafta, tüm portlardan. Fail2Ban'ın kendi günlüğünü okur: günlük dosyaya
//    yazılıyorsa dosyadan, journal'a yazılıyorsa journal'dan (Debian 13'te hangisi olduğu kuruluma göre değişir).
import fs from 'fs';
import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun } from './db';
import { isLinux, getLanIdentity, AP_NET } from './system';

const execFileP = promisify(execFile);
const JAIL_D = '/etc/fail2ban/jail.d';
export const PANEL_JAIL = `${JAIL_D}/klyrix-panel.local`;
const SETTINGS_KEY = 'fail2ban_settings';

export interface Fail2banSettings {
  bantime: number;       // sn — varsayılan (SSH dışındaki jail'ler)
  findtime: number;      // sn — hataların sayıldığı pencere
  maxretry: number;      // varsayılan deneme hakkı
  sshd_enabled: boolean;
  sshd_maxretry: number;
  sshd_bantime: number;  // sn — kurulumun jail.local'indeki değer 7200
  lan_exempt: boolean;   // ev ağı muaf
  extra_ignore: string[]; // ek muaf adresler (IPv4 / IPv6, önekli olabilir)
  recidive: boolean;
}
export const F2B_DEFAULTS: Fail2banSettings = {
  bantime: 3600, findtime: 600, maxretry: 5, sshd_enabled: true, sshd_maxretry: 3, sshd_bantime: 7200,
  lan_exempt: true, extra_ignore: [], recidive: true,
};
const LIMITS = {
  bantime: [60, 604800], findtime: [60, 86400], maxretry: [1, 20], sshd_maxretry: [1, 20], sshd_bantime: [60, 604800],
} as const;

// "1.2.3.4", "1.2.3.0/24", "2001:db8::1", "2001:db8::/32" — başka karakter yok (dosyaya yazılır).
export function isIgnoreEntry(s: string): boolean {
  const [ip, pfx, ...rest] = String(s).split('/');
  if (rest.length) return false;
  const v = net.isIP(ip);
  if (!v) return false;
  if (pfx === undefined) return true;
  return /^\d{1,3}$/.test(pfx) && Number(pfx) <= (v === 4 ? 32 : 128);
}

export function validateFail2banSettings(v: any): Fail2banSettings | string {
  if (!v || typeof v !== 'object') return 'Ayarlar eksik';
  const out: any = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) return `Geçersiz değer: ${k} (${lo}–${hi})`;
    out[k] = n;
  }
  for (const k of ['sshd_enabled', 'lan_exempt', 'recidive'] as const) {
    if (typeof v[k] !== 'boolean') return `Geçersiz değer: ${k}`;
    out[k] = v[k];
  }
  const extra = Array.isArray(v.extra_ignore) ? v.extra_ignore.map((x: unknown) => String(x).trim()).filter(Boolean) : null;
  if (!extra) return 'Geçersiz değer: extra_ignore';
  if (extra.length > 20) return 'En çok 20 ek muaf adres';
  const bad = extra.find((x: string) => !isIgnoreEntry(x));
  if (bad) return `Geçersiz muaf adres: ${bad}`;
  out.extra_ignore = [...new Set(extra)];
  return out as Fail2banSettings;
}

// Eski sürümün service_config satırlarından (yalnız veritabanındaydı) ilk ayarlar; sonra satırlar silinir.
async function legacySettings(): Promise<Fail2banSettings | null> {
  const rows = await dbAll("SELECT key, value FROM service_config WHERE service = 'fail2ban'").catch(() => []) as any[];
  if (!rows.length) return null;
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = String(r.value);
  const num = (k: string, d: number) => (m[k] !== undefined && /^\d+$/.test(m[k]) ? Number(m[k]) : d);
  // Tohum değeri ('127.0.0.1/8 192.168.1.0/24') kullanıcı seçimi değil: ev ağı artık kendiliğinden bulunur.
  const ign = m.ignoreip && m.ignoreip.trim() !== '127.0.0.1/8 192.168.1.0/24'
    ? m.ignoreip.split(/[\s,]+/).filter(x => x && x !== '127.0.0.1/8' && isIgnoreEntry(x)).slice(0, 20) : [];
  const s = validateFail2banSettings({
    ...F2B_DEFAULTS,
    bantime: num('bantime', F2B_DEFAULTS.bantime), findtime: num('findtime', F2B_DEFAULTS.findtime),
    maxretry: num('maxretry', F2B_DEFAULTS.maxretry), sshd_maxretry: num('sshd_maxretry', F2B_DEFAULTS.sshd_maxretry),
    sshd_enabled: m.sshd_enabled === undefined ? true : m.sshd_enabled === 'true', extra_ignore: ign,
  });
  return typeof s === 'string' ? null : s;
}

export async function readFail2banSettings(): Promise<Fail2banSettings> {
  try {
    const row = await dbGet('SELECT value FROM app_settings WHERE key = ?', [SETTINGS_KEY]);
    if (row?.value) {
      const s = validateFail2banSettings({ ...F2B_DEFAULTS, ...JSON.parse(row.value) });
      if (typeof s !== 'string') return s;
    }
  } catch { /* varsayılan */ }
  const legacy = await legacySettings();
  const s = legacy || { ...F2B_DEFAULTS };
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(s)]).catch(() => {});
  await dbRun("DELETE FROM service_config WHERE service = 'fail2ban'").catch(() => {});
  return s;
}

// Ev ağı: Pi'nin modem tarafı ve Pi DHCP'sinin ağı (tek ağda aynı), kurulum Wi-Fi'ı; internet kartı tarafı DEĞİL.
export async function lanNetworks(): Promise<string[]> {
  const id = await getLanIdentity().catch(() => null);
  const nets = new Set<string>();
  if (id) {
    if (id.transit?.network) nets.add(id.transit.network);
    if (id.client?.network) nets.add(id.client.network);
  }
  nets.add(AP_NET);
  return [...nets].filter(isIgnoreEntry);
}

export function ignoreList(s: Fail2banSettings, lan: string[]): string[] {
  return [...new Set(['127.0.0.1/8', '::1', ...(s.lan_exempt ? [...lan, 'fe80::/10'] : []), ...s.extra_ignore])];
}

// Fail2Ban'ın kendi günlüğü: dosya yolu ya da journal (recidive ve "son yasaklar" buradan okur).
async function logTarget(): Promise<{ file: string } | { journal: true }> {
  const out = await execFileP('fail2ban-client', ['get', 'logtarget'], { timeout: 10000 }).then(r => r.stdout, () => '');
  const m = out.match(/(\/[^\s`'"]+)/);
  if (m && m[1] !== '/dev/null' && fs.existsSync(m[1])) return { file: m[1] };
  if (/SYSTEMD-JOURNAL/i.test(out)) return { journal: true };
  return fs.existsSync('/var/log/fail2ban.log') ? { file: '/var/log/fail2ban.log' } : { journal: true };
}

export function buildJailFile(s: Fail2banSettings, lan: string[], log: { file: string } | { journal: true }): string {
  const lines = [
    '# Klyrix Gate paneli yazar (Fail2Ban → Ayarlar) — elle değiştirmeyin; jail.local\'deki aynı ayarları geçersiz kılar.',
    '[DEFAULT]',
    `bantime = ${s.bantime}`,
    `findtime = ${s.findtime}`,
    `maxretry = ${s.maxretry}`,
    `ignoreip = ${ignoreList(s, lan).join(' ')}`,
    '',
    '[sshd]',
    `enabled = ${s.sshd_enabled ? 'true' : 'false'}`,
    `maxretry = ${s.sshd_maxretry}`,
    `bantime = ${s.sshd_bantime}`,
    '',
    '[recidive]',
    `enabled = ${s.recidive ? 'true' : 'false'}`,
    ...('file' in log ? ['backend = auto', `logpath = ${log.file}`] : ['backend = systemd']),
    'bantime = 604800',
    'findtime = 86400',
    'maxretry = 5',
  ];
  return lines.join('\n') + '\n';
}

const f2bInstalled = () => fs.existsSync('/usr/bin/fail2ban-client') || fs.existsSync('/usr/local/bin/fail2ban-client');
const f2bActive = () => execFileP('systemctl', ['is-active', 'fail2ban'], { timeout: 10000 }).then(r => r.stdout.trim() === 'active', () => false);

export interface F2bApplyResult { ok: boolean; changed: boolean; error?: string; rolledBack?: boolean }
// Yaz → sına → (çalışıyorsa) yeniden yükle; başarısızsa eski dosya geri. Kaydedilen ayarlar yalnız başarıda değişir.
export async function applyFail2banSettings(s: Fail2banSettings, opts: { onlyIfChanged?: boolean } = {}): Promise<F2bApplyResult> {
  if (!isLinux) return { ok: false, changed: false, error: 'Yalnız Pi üzerinde uygulanır' };
  if (!f2bInstalled()) return { ok: false, changed: false, error: 'Fail2Ban kurulu değil' };
  const content = buildJailFile(s, await lanNetworks(), await logTarget());
  let old: string | null = null;
  try { old = fs.readFileSync(PANEL_JAIL, 'utf8'); } catch { /* ilk kez */ }
  if (opts.onlyIfChanged && old === content) return { ok: true, changed: false };
  const restore = () => {
    try {
      if (old === null) fs.unlinkSync(PANEL_JAIL); else fs.writeFileSync(PANEL_JAIL, old, { mode: 0o644 });
    } catch { /* */ }
  };
  try {
    fs.mkdirSync(JAIL_D, { recursive: true });
    fs.writeFileSync(PANEL_JAIL, content, { mode: 0o644 });
  } catch (e: any) {
    return { ok: false, changed: false, error: `Dosya yazılamadı: ${e?.message || e}` };
  }
  const test = await execFileP('fail2ban-client', ['-t'], { timeout: 30000 }).then(() => '', (e: any) => String(e?.stderr || e?.stdout || e?.message || e).trim());
  if (test) {
    restore();
    return { ok: false, changed: false, rolledBack: true, error: `Yapılandırma sınamadan geçmedi: ${test.split('\n').slice(-3).join(' ').slice(0, 300)}` };
  }
  if (await f2bActive()) {
    const rl = await execFileP('fail2ban-client', ['reload'], { timeout: 60000 }).then(() => '', (e: any) => String(e?.stderr || e?.stdout || e?.message || e).trim());
    if (rl) {
      restore();
      await execFileP('fail2ban-client', ['reload'], { timeout: 60000 }).catch(() => {});
      return { ok: false, changed: false, rolledBack: true, error: `Fail2Ban yeniden yüklenemedi: ${rl.slice(0, 300)}` };
    }
  }
  await dbRun('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [SETTINGS_KEY, JSON.stringify(s)]);
  return { ok: true, changed: true };
}

// Açılışta ve sağlık denetiminde: panel dosyası yoksa ya da ev ağı değiştiyse yeniden yazılır (eski kurulumlarda ev ağı
// muafiyeti güncellemeyle kendiliğinden gelir).
export async function ensureFail2ban(): Promise<F2bApplyResult | null> {
  if (!isLinux || !f2bInstalled()) return null;
  return applyFail2banSettings(await readFail2banSettings(), { onlyIfChanged: true });
}

export async function fail2banSettingsView() {
  const settings = await readFail2banSettings();
  const lan = await lanNetworks();
  let written = '';
  try { written = fs.readFileSync(PANEL_JAIL, 'utf8'); } catch { /* yok */ }
  return {
    settings, installed: isLinux && f2bInstalled(), lan, ignore: ignoreList(settings, lan),
    applied: !!written, file: PANEL_JAIL,
  };
}

// Son yasaklar: "2026-09-30 12:00:01,123 fail2ban.actions [123]: NOTICE [sshd] Ban 1.2.3.4" (dosya) ya da journal'ın
// "2026-09-30T12:00:01+0300 pi fail2ban-server[123]: ... [sshd] Ban 1.2.3.4" satırları. "Restore Ban" (yeniden
// başlatmada) sayılmaz. En yeni önce.
export function parseBanLines(text: string, limit = 20): { ip: string; jail: string; time: string }[] {
  const out: { ip: string; jail: string; time: string }[] = [];
  for (const line of text.split('\n')) {
    if (/Restore Ban/.test(line)) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}).*?\[([^\]\s]+)\]\s+Ban\s+(\S+)\s*$/);
    if (!m || !net.isIP(m[4])) continue;
    out.push({ ip: m[4], jail: m[3], time: `${m[1]} ${m[2]}` });
  }
  return out.reverse().slice(0, limit);
}
export async function recentBans(limit = 20) {
  if (!isLinux || !f2bInstalled()) return [];
  const t = await logTarget();
  let text = '';
  if ('file' in t) {
    try {
      const fd = fs.openSync(t.file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 512 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { /* */ }
  } else {
    text = await execFileP('journalctl', ['-u', 'fail2ban', '-o', 'short-iso', '-n', '3000', '--no-pager'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
      .then(r => r.stdout, () => '');
  }
  return parseBanLines(text, limit);
}

// Yasağı kaldır: tüm jail'lerden (fail2ban-client unban). Adres doğrulanır, kabuk kullanılmaz.
export async function unbanIp(ip: string): Promise<{ ok: boolean; error?: string }> {
  const a = String(ip || '').trim();
  if (!net.isIP(a)) return { ok: false, error: 'Geçerli bir IP adresi girin' };
  if (!isLinux || !f2bInstalled()) return { ok: false, error: 'Fail2Ban kurulu değil' };
  const r = await execFileP('fail2ban-client', ['unban', a], { timeout: 20000 }).then(() => '', (e: any) => String(e?.stderr || e?.message || e).trim());
  return r ? { ok: false, error: r.slice(0, 300) } : { ok: true };
}

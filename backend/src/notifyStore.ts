// Dış bildirim (notify.ts) ve yeni cihaz algılayıcısının (deviceWatch.ts) ortak deposu: /etc/pi5-gateway/notify (0700).
//  - channels.json (0600): kanallar (bot token, webhook adresi, HMAC sırrı) ve "Yeni cihaz bildirimi" ayarı. ASLA app_settings'te
//    değil: GET /api/settings tüm satırları maskesiz döner ve app_settings yedeğe (dışa aktarma, bulut yedeği) bütünüyle girer.
//  - state.json (0600): kanal başına imleç (alerts.id), birleştirme / sessiz saat bekleyenleri, webhook gönderim kuyruğu,
//    algılayıcının taban çizgisi bayrağı. Yedeğe girmez: geri yükleme eski uyarıları yeniden göndertmez.
//  - Dosyalar yoksa hiçbir şey yazılmaz (varsayılan kapalı): klasör ilk kanal kaydedilince ya da algılayıcı açılınca kurulur.
//  - Yazım geçici dosya + rename (vault.ts writeFile0600 deseni). Bellekteki kopya tek doğru kaynaktır (panel yazar — elle
//    düzenlemeyin). Kanal satırları burada olduğu gibi taşınır; biçim denetimi notify.ts'te (algılayıcı ayarı yazılırken
//    kanallar bozulmadan geri yazılır).
//  - HA (G4.3): dış bağlantı işi yalnız MASTER'da çalışır. Gönderici ve algılayıcı tek kapıdan (notifyMayRun) geçer; kapı şimdi
//    hep açık, G4.3 setNotifyRunGate ile bağlar.
import fs from 'fs';
import path from 'path';

export type Severity = 'info' | 'warning' | 'critical';
export type RandomMacMode = 'tag' | 'suppress';
export interface DeviceWatchConf { enabled: boolean; randomMac: RandomMacMode }
export interface NotifyConfig { v: 1; channels: unknown[]; deviceWatch: DeviceWatchConf }

// Birleştirme / sessiz saat bekleyeni: aynı kaynak + önem için sayı ve son kayıt.
export interface Held { n: number; source: string; severity: Severity; lastId: number; lastMsg: string; firstAt: number; lastAt: number }
// Gönderilecek tek bildirim (notify.ts planChannel): kayıt, birleşik satır ya da özet.
export interface OutItem {
  kind: 'event' | 'merged' | 'digest' | 'quiet';
  source: string; severity: Severity; count: number; message: string; alertId: number; createdAt: number;
  lines?: { source: string; severity: Severity; n: number }[];
}
// out: webhook'un gönderim kuyruğu (öğe öğe POST; başarılı olan düşer — yeniden başlatmada en çok bir yineleme).
export interface ChState {
  cursor: number; sentAt: Record<string, number>; held: Record<string, Held>; quiet: Record<string, Held>; out?: OutItem[];
}
// deviceWatch.extra: taban çizgisinde bilinen sayılan ama o an bağlı olmayan cihazlar (süren DHCP kirası, cihaz listesi) —
// known_devices'a (Bilinmeyen Cihazlar listesi) yazılmaz, yeniden başlatmada da bilinen kalsınlar diye burada.
export interface NotifyState { v: 1; channels: Record<string, ChState>; deviceWatch: { baselineAt: number; extra: string[] } }

// Yalnız test (NODE_ENV=test): sahte klasör ve sahte Telegram / Discord temel adresi (notify.ts).
export const testEnv = (name: string): string => (process.env.NODE_ENV === 'test' ? String(process.env[name] || '') : '');
export const NOTIFY_DIR = testEnv('KLX_NOTIFY_DIR') || '/etc/pi5-gateway/notify';
const CONFIG_FILE = path.join(NOTIFY_DIR, 'channels.json');
const STATE_FILE = path.join(NOTIFY_DIR, 'state.json');

export const emptyConfig = (): NotifyConfig => ({ v: 1, channels: [], deviceWatch: { enabled: false, randomMac: 'tag' } });
export const emptyState = (): NotifyState => ({ v: 1, channels: {}, deviceWatch: { baselineAt: 0, extra: [] } });

function writeFile0600(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* geliştirme ortamı */ }
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // yarım yazılmış sır kalmasın
    throw e;
  }
}

// Bozuk dosya kenara alınır (.bad) ve boş sayılır: bir sonraki yazım onu sessizce ezmesin.
function readJson(file: string): any {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch {
    console.error(`[bildirim] ${path.basename(file)} okunamadı (bozuk) — .bad olarak kenara alındı`);
    try { fs.renameSync(file, `${file}.bad`); } catch { /* */ }
    return null;
  }
}

let config: NotifyConfig | null = null;
let state: NotifyState | null = null;

export function notifyConfig(): NotifyConfig {
  if (config) return config;
  const raw = readJson(CONFIG_FILE);
  const c = emptyConfig();
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.channels)) c.channels = raw.channels;
    const dw = raw.deviceWatch;
    if (dw && typeof dw === 'object') c.deviceWatch = { enabled: dw.enabled === true, randomMac: dw.randomMac === 'suppress' ? 'suppress' : 'tag' };
  }
  config = c;
  return c;
}
export function saveNotifyConfig(c: NotifyConfig): void {
  writeFile0600(CONFIG_FILE, `${JSON.stringify(c, null, 1)}\n`);
  config = c;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function heldMap(v: unknown): Record<string, Held> {
  const out: Record<string, Held> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, h] of Object.entries(v as Record<string, any>)) {
    if (!h || typeof h !== 'object' || !['info', 'warning', 'critical'].includes(h.severity)) continue;
    out[k] = {
      n: num(h.n), source: String(h.source || ''), severity: h.severity, lastId: num(h.lastId),
      lastMsg: String(h.lastMsg || '').slice(0, 500), firstAt: num(h.firstAt), lastAt: num(h.lastAt),
    };
  }
  return out;
}
const SEVS = ['info', 'warning', 'critical'];
const KINDS = ['event', 'merged', 'digest', 'quiet'];
function outList(v: unknown): OutItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(o => o && typeof o === 'object' && KINDS.includes(o.kind) && SEVS.includes(o.severity)).slice(0, 100).map(o => ({
    kind: o.kind, source: String(o.source || ''), severity: o.severity, count: num(o.count) || 1, message: String(o.message || '').slice(0, 500),
    alertId: num(o.alertId), createdAt: num(o.createdAt),
    ...(Array.isArray(o.lines) ? { lines: o.lines.filter((l: any) => l && SEVS.includes(l.severity)).slice(0, 60)
      .map((l: any) => ({ source: String(l.source || ''), severity: l.severity, n: num(l.n) })) } : {}),
  }));
}
export function notifyState(): NotifyState {
  if (state) return state;
  const raw = readJson(STATE_FILE);
  const s = emptyState();
  if (raw && typeof raw === 'object') {
    for (const [id, c] of Object.entries((raw.channels || {}) as Record<string, any>)) {
      if (!c || typeof c !== 'object') continue;
      const sentAt: Record<string, number> = {};
      for (const [k, t] of Object.entries(c.sentAt || {})) sentAt[k] = num(t);
      const out = outList(c.out);
      s.channels[id] = { cursor: num(c.cursor), sentAt, held: heldMap(c.held), quiet: heldMap(c.quiet), ...(out.length ? { out } : {}) };
    }
    s.deviceWatch.baselineAt = num(raw.deviceWatch?.baselineAt);
    const extra = raw.deviceWatch?.extra;
    if (Array.isArray(extra)) s.deviceWatch.extra = extra.map(m => String(m).toLowerCase()).filter(m => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)).slice(0, 5000);
  }
  state = s;
  return s;
}
export function saveNotifyState(): void {
  if (state) writeFile0600(STATE_FILE, `${JSON.stringify(state)}\n`);
}

// HA kapısı (G4.3): false dönerse gönderici ve algılayıcı hiçbir şey kurmaz / göndermez.
let runGate: () => boolean = () => true;
export function setNotifyRunGate(fn: () => boolean): void { runGate = fn; }
export const notifyMayRun = (): boolean => runGate();

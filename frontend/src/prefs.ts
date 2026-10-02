// Panel tercihleri (Ayarlar → Bildirimler / Performans): app_settings'ten bir kez okunur, Ayarlar sayfası değiştirince
// anında güncellenir. Eskiden bu ayarlar kaydediliyor ama hiçbir şey onlara bakmıyordu.
//  - autoRefresh: kapalıysa sayfalar arka planda kendiliğinden yenilenmez (useApi yoklaması durur; açılışta bir kez yükler).
//  - refreshMs: yenileme hızı — 5000 = normal (sayfaların kendi aralığı); büyük değer tüm yoklamaları orantılı seyrekleştirir,
//    küçük değer hızlandırır (en az 1 sn). Çarpan olduğu için varsayılan davranış değişmez.
//  - sound / desktop: yeni (okunmamış) uyarı gelince kısa ses / tarayıcı bildirimi (NotificationBell).
export interface Prefs { autoRefresh: boolean; refreshMs: number; sound: boolean; desktop: boolean }
const BASE_MS = 5000;
let prefs: Prefs = { autoRefresh: true, refreshMs: BASE_MS, sound: true, desktop: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export function prefsFromSettings(s: Record<string, string | undefined>): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (s.auto_refresh !== undefined) out.autoRefresh = s.auto_refresh !== 'false';
  const r = Number(s.refresh_interval);
  if (Number.isFinite(r) && r > 0) out.refreshMs = r;
  if (s.notification_sound !== undefined) out.sound = s.notification_sound !== 'false';
  if (s.desktop_notifications !== undefined) out.desktop = s.desktop_notifications === 'true';
  return out;
}

export function getPrefs(): Prefs {
  if (!loading) loading = loadPrefs();
  return prefs;
}
async function loadPrefs(): Promise<void> {
  try {
    const r = await fetch('/api/settings');
    if (r.ok) setPrefs(prefsFromSettings((await r.json())?.settings || {}));
  } catch { /* panel çevrim dışı: varsayılanlar */ }
}
export function setPrefs(p: Partial<Prefs>): void {
  prefs = { ...prefs, ...p };
  for (const f of listeners) f();
}
export function onPrefsChange(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

// Sayfanın kendi yoklama aralığı → tercihlere göre gerçek aralık (null = yoklama yok)
export function effectivePoll(pollMs: number | undefined): number | null {
  if (!pollMs) return null;
  const p = getPrefs();
  if (!p.autoRefresh) return null;
  return Math.max(1000, Math.round(pollMs * (p.refreshMs / BASE_MS)));
}

// Kısa uyarı sesi (WebAudio; dosya yok). Tarayıcı kullanıcı etkileşimi olmadan sesi engelleyebilir — sessizce geçilir.
let audio: AudioContext | null = null;
export function alertSound(): void {
  if (!getPrefs().sound) return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t);
    o.frequency.setValueAtTime(660, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.32);
  } catch { /* ses çalınamadı */ }
}

// Masaüstü bildirimi: tarayıcılar bu API'yi yalnız güvenli bağlamda (HTTPS ya da localhost) açar.
export const desktopSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;
export function desktopNotify(title: string, body: string): void {
  if (!getPrefs().desktop || !desktopSupported() || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: 'klyrix-alert' }); } catch { /* engellendi */ }
}

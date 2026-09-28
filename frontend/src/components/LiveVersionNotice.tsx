import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

// Pi güncellenince açık sayfa bunu kendisi fark eder (eskiden eski arayüzde kalıyor, elle yenilemek gerekiyordu — ör. gece
// otomatik güncellemesi ya da başka cihazdan yapılan güncelleme). Arayüz derlendiği commit'i taşır (__APP_BUILD__,
// vite.config); dakikada bir ve sekmeye dönülünce /build.json yoklanır. Kimlik değiştiyse:
//  - sekme GÖRÜNÜRKEN asla kendiliğinden yenilenmez: altta "Yenile" düğmeli çubuk çıkar;
//  - sekme ARKA PLANDAYKEN güvenliyse sessizce yenilenir (dönünce yeni arayüz hazır). Güvenli değil: odakta yazı alanı,
//    açık pencere (modal), panel koruma deneme bandı ya da DHCP sayfası (5 dk'lık denemeler) — o zaman çubuk bekler.
// Kiosk sayfası (kiosk.html) ayrıdır, etkilenmez.
declare const __APP_BUILD__: string;

function safeToReload(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
  if (document.querySelector('.modal-backdrop, .panel-auth-trial')) return false;
  if (/^#dhcp\b/.test(window.location.hash)) return false;
  return true;
}

export function LiveVersionNotice() {
  const [ready, setReady] = useState<{ version: string } | null>(null);

  useEffect(() => {
    if (__APP_BUILD__ === 'dev') return;
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`/build.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return; // derleme sürerken dist boş olabilir
        const b = await r.json();
        if (alive && b && typeof b.id === 'string' && b.id && b.id !== __APP_BUILD__) setReady({ version: String(b.version || '') });
      } catch { /* bağlantı yok: sonraki denemede */ }
    };
    check();
    const iv = setInterval(check, 60000);
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const tryReload = () => { if (document.visibilityState === 'hidden' && safeToReload()) window.location.reload(); };
    tryReload();
    document.addEventListener('visibilitychange', tryReload);
    return () => document.removeEventListener('visibilitychange', tryReload);
  }, [ready]);

  if (!ready) return null;
  return (
    <div className="live-version-bar glass-panel" role="status">
      <RefreshCw size={16} aria-hidden="true" />
      <span>Panel güncellendi{ready.version ? ` (v${ready.version})` : ''} — yeni sürümü görmek için sayfayı yenileyin.</span>
      <button className="btn-primary btn-sm" onClick={() => window.location.reload()}>Yenile</button>
    </div>
  );
}

// Panel Klyrix/Gate yönetim uygulamasının içinden açıldığında (uygulamanın WebView'ı, gate/src/ui/PanelScreen.tsx):
// menünün en üstünde uygulamaya (cihaz listesine) dönüş ve telefon ile Pi arasındaki bağlantının durumu (evden / dışarıdan,
// gecikme); bağlantı sorunluyken menü düğmesinde küçük bir işaret. Uygulamanın kendi başlık çubuğu yok, panelin üst çubuğu
// tarayıcıdakiyle aynı. Uygulama durumu window.__klyrixGateApp ile gönderir (ilk durum sayfa yüklenmeden
// window.__klyrixGateAppInfo'ya yazılır); dönüş isteği window.ReactNativeWebView.postMessage ile gider. Bu nesne yalnız
// mesaj dinleyen WebView'da vardır: tarayıcıda (ve uygulamanın ilk sürümünde) hiçbiri görünmez.
import { useEffect, useSyncExternalStore } from 'react';

export interface GateAppInfo { status: 'idle' | 'connecting' | 'connected' | 'error'; via: 'lan' | 'remote' | null; ms: number }

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __klyrixGateApp?: (info: GateAppInfo) => void;
    __klyrixGateAppInfo?: GateAppInfo;
  }
}

export const inGateApp = (): boolean => typeof window !== 'undefined' && !!window.ReactNativeWebView;

// Durum tek yerde (menü ve üst çubuk aynı bilgiyi dinler)
let current: GateAppInfo | null = inGateApp() ? window.__klyrixGateAppInfo ?? { status: 'connected', via: null, ms: 0 } : null;
const listeners = new Set<() => void>();
let announced = false;
if (inGateApp()) {
  window.__klyrixGateApp = i => {
    current = i;
    for (const l of listeners) l();
  };
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const snapshot = () => current;

export function gateAppBack(): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'back' }));
}

// Uygulamadaki bağlantı durumu; uygulamanın dışında null
export function useGateApp(): GateAppInfo | null {
  const info = useSyncExternalStore(subscribe, snapshot, () => null);
  useEffect(() => {
    // Uygulama dönüşün panelde olduğunu bilsin (bilmeyen eski panelde kendi dönüş düğmesini gösterir)
    if (!inGateApp() || announced) return;
    announced = true;
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'ready' }));
  }, []);
  return info;
}

// Kısa durum metni ve tonu: ok (bağlı), warn (bağlanıyor), bad (bağlantı yok)
export function gateAppStatus(a: GateAppInfo): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (a.status === 'connected') {
    const where = a.via === 'remote' ? 'Dışarıdan' : 'Evden';
    return { tone: 'ok', text: a.ms ? `${where} · ${a.ms} ms` : where };
  }
  if (a.status === 'connecting') return { tone: 'warn', text: 'Bağlanıyor…' };
  return { tone: 'bad', text: "Pi'ye bağlantı yok" };
}

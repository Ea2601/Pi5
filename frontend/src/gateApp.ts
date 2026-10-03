// Panel Klyrix/Gate yönetim uygulamasının içinden açıldığında (uygulamanın WebView'ı, gate/src/ui/PanelScreen.tsx): üst
// çubukta uygulamaya dönüş düğmesi ve telefon ile Pi arasındaki bağlantının durumu (evden / dışarıdan, gecikme) — uygulama
// kendi ayrı başlık çubuğunu göstermez. Uygulama durumu window.__klyrixGateApp ile gönderir (ilk durum sayfa yüklenmeden
// window.__klyrixGateAppInfo'ya yazılır); dönüş isteği window.ReactNativeWebView.postMessage ile gider. Bu nesne yalnız
// mesaj dinleyen WebView'da vardır: tarayıcıda (ve uygulamanın eski sürümünde) hiçbiri görünmez.
import { useEffect, useState } from 'react';

export interface GateAppInfo { status: 'idle' | 'connecting' | 'connected' | 'error'; via: 'lan' | 'remote' | null; ms: number }

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
    __klyrixGateApp?: (info: GateAppInfo) => void;
    __klyrixGateAppInfo?: GateAppInfo;
  }
}

export const inGateApp = (): boolean => typeof window !== 'undefined' && !!window.ReactNativeWebView;

export function gateAppBack(): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'back' }));
}

// Uygulamadaki bağlantı durumu; uygulamanın dışında null
export function useGateApp(): GateAppInfo | null {
  const [info, setInfo] = useState<GateAppInfo | null>(() =>
    (inGateApp() ? window.__klyrixGateAppInfo ?? { status: 'connected', via: null, ms: 0 } : null));
  useEffect(() => {
    if (!inGateApp()) return;
    window.__klyrixGateApp = i => setInfo(i);
    // Uygulama bu sürümün dönüş düğmesini gösterdiğini bilsin (eski panelde kendi geri düğmesini gösterir)
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'ready' }));
    return () => { window.__klyrixGateApp = undefined; };
  }, []);
  return info;
}

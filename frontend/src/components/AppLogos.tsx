import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

// Uygulama logoları — markanın favicon'u (Google'ın favicon servisi) yalnız internetten GERÇEKTEN yüklenirse gösterilir;
// o zamana kadar (ve internetsiz ağda, ör. kurulum Wi-Fi'ı) uygulamanın baş harfi görünür. Resim arka planda denenir:
// bekleyen istek sayfayı bekletmez, kırık resim simgesi çıkmaz. İstekle panelin adresi (referrer) gönderilmez.

const FAVICON_BASE = 'https://www.google.com/s2/favicons?sz=64&domain=';

const domainMap: Record<string, string> = {
  WhatsApp: 'whatsapp.com',
  Telegram: 'telegram.org',
  Discord: 'discord.com',
  Signal: 'signal.org',
  YouTube: 'youtube.com',
  Netflix: 'netflix.com',
  Twitch: 'twitch.tv',
  Instagram: 'instagram.com',
  'Twitter/X': 'x.com',
  TikTok: 'tiktok.com',
  Steam: 'store.steampowered.com',
  'Epic Games': 'epicgames.com',
  Spotify: 'spotify.com',
  Google: 'google.com',
  GitHub: 'github.com',
  'Siri/iCloud': 'apple.com',
  FaceTime: 'apple.com',
  Zoom: 'zoom.us',
  Facebook: 'facebook.com',
  Snapchat: 'snapchat.com',
};

const letterStyle: CSSProperties = {
  fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
};

export function AppLogo({ name }: { name: string; size?: number }) {
  const domain = domainMap[name];
  const src = domain ? `${FAVICON_BASE}${domain}` : '';
  const [loadedSrc, setLoadedSrc] = useState('');

  useEffect(() => {
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (alive) setLoadedSrc(src); };
    img.src = src;
    return () => { alive = false; img.onload = null; };
  }, [src]);

  if (src && loadedSrc === src) return <img src={src} alt={name} referrerPolicy="no-referrer" />;
  return <span style={letterStyle}>{name.charAt(0)}</span>;
}

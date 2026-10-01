import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

// Uygulama logoları — markanın favicon'u (Google'ın favicon servisi) yalnız internetten GERÇEKTEN yüklenirse gösterilir;
// o zamana kadar (ve internetsiz ağda, ör. kurulum Wi-Fi'ı) uygulamanın baş harfi görünür. Resim arka planda denenir:
// bekleyen istek sayfayı bekletmez, kırık resim simgesi çıkmaz. İstekle panelin adresi (referrer) gönderilmez.
//
// Bazı markaların favicon'u kendi arka planıyla (beyaz / açık renkli kare) ve düşük çözünürlükle geliyor (WhatsApp 23 px,
// GitHub 32 px): onlar panele gömülü, arka plansız SVG olarak çizilir — Simple Icons 16.33.0 (CC0), resmî marka renkleri.
// GitHub'ın rengi siyah olduğundan yazı rengiyle çizilir (koyu temada beyaz, açıkta koyu). İnternetsiz de görünürler.
const LOCAL_LOGOS: Record<string, { color: string; path: string }> = {
  WhatsApp: {
    color: "#25D366",
    path: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
  },
  Signal: {
    color: "#3B45FD",
    path: "M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M12 2.25a9.75 9.75 0 0 0-8.539 14.459c.074.134.1.292.064.441l-1.013 4.338 4.338-1.013a.62.62 0 0 1 .441.064A9.7 9.7 0 0 0 12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25m-7.092.068a12 12 0 0 0-2.59 2.59l.909.664a11 11 0 0 1 2.345-2.345zm14.184 0-.664.909a11 11 0 0 1 2.345 2.345l.909-.664a12 12 0 0 0-2.59-2.59M1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.269-3.066zm20.516 0-.961.584a10.8 10.8 0 0 1 1.27 3.066l1.093-.268a12 12 0 0 0-1.402-3.383M.138 10.168A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17A11 11 0 0 1 1.125 12q0-.848.125-1.66zm23.723.002-1.111.17q.125.812.125 1.66c0 .848-.042 1.12-.125 1.66l1.111.172a12.1 12.1 0 0 0 0-3.662M1.434 14.58l-1.094.268a12 12 0 0 0 .96 2.591l-.265 1.14 1.096.255.36-1.539-.188-.365a10.8 10.8 0 0 1-.87-2.35m21.133 0a10.8 10.8 0 0 1-1.27 3.067l.962.584a12 12 0 0 0 1.402-3.383zm-1.793 3.848a11 11 0 0 1-2.345 2.345l.664.909a12 12 0 0 0 2.59-2.59zm-19.959 1.1L.357 21.48a1.8 1.8 0 0 0 2.162 2.161l1.954-.455-.256-1.095-1.953.455a.675.675 0 0 1-.81-.81l.454-1.954zm16.832 1.769a10.8 10.8 0 0 1-3.066 1.27l.268 1.093a12 12 0 0 0 3.382-1.402zm-10.94.213-1.54.36.256 1.095 1.139-.266c.814.415 1.683.74 2.591.961l.268-1.094a10.8 10.8 0 0 1-2.35-.869zm3.634 1.24-.172 1.111a12.1 12.1 0 0 0 3.662 0l-.17-1.111q-.812.125-1.66.125a11 11 0 0 1-1.66-.125",
  },
  Telegram: {
    color: "#26A5E4",
    path: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  },
  GitHub: {
    color: "currentColor",
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
};

const FAVICON_BASE = 'https://www.google.com/s2/favicons?sz=64&domain=';

const domainMap: Record<string, string> = {
  Discord: 'discord.com',
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
  'Siri/iCloud': 'apple.com',
  FaceTime: 'apple.com',
  Zoom: 'zoom.us',
  Facebook: 'facebook.com',
  Snapchat: 'snapchat.com',
  // v2.24.67: Ebeveyn Kontrol kategorilerinden eklenen servisler
  Threads: 'threads.net', Pinterest: 'pinterest.com', Reddit: 'reddit.com', Tumblr: 'tumblr.com', Bluesky: 'bsky.app',
  VK: 'vk.com', 'Ask.fm': 'ask.fm', Kick: 'kick.com', 'Disney+': 'disneyplus.com', 'Prime Video': 'primevideo.com',
  Hulu: 'hulu.com', Max: 'max.com', Dailymotion: 'dailymotion.com', Vimeo: 'vimeo.com', MUBI: 'mubi.com',
  Roblox: 'roblox.com', Minecraft: 'minecraft.net', PlayStation: 'playstation.com', Xbox: 'xbox.com', EA: 'ea.com',
  'Riot Games': 'riotgames.com', 'Battle.net': 'battle.net', Supercell: 'supercell.com', Garena: 'garena.com',
  'PUBG Mobile': 'pubgmobile.com', Miniclip: 'miniclip.com', Messenger: 'messenger.com', Viber: 'viber.com',
  LINE: 'line.me', WeChat: 'wechat.com',
};

const letterStyle: CSSProperties = {
  fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
};

export function AppLogo({ name, size = 18 }: { name: string; size?: number }) {
  const local = LOCAL_LOGOS[name];
  const domain = local ? undefined : domainMap[name];
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

  if (local) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={name}
        style={{ display: 'block', color: 'var(--text-primary)', fill: local.color }}>
        <path d={local.path} />
      </svg>
    );
  }
  if (src && loadedSrc === src) return <img src={src} alt={name} referrerPolicy="no-referrer" />;
  return <span style={letterStyle}>{name.charAt(0)}</span>;
}

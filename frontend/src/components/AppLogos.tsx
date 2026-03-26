// Uygulama logoları — her markanın kendi favicon/logo URL'si
// Google'ın favicon servisi üzerinden yüksek kaliteli logolar

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

export function AppLogo({ name }: { name: string; size?: number }) {
  const domain = domainMap[name];
  if (!domain) {
    return <span style={{ fontSize: 16, fontWeight: 700, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>{name.charAt(0)}</span>;
  }
  return (
    <img
      src={`${FAVICON_BASE}${domain}`}
      alt={name}
      loading="lazy"
    />
  );
}

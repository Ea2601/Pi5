// Merkezi marka tanımı — uygulamanın adı/logosu buradan yönetilir.
// Marka değişimi için yalnızca bu dosyayı düzenlemek yeterli (statik dosyalar:
// index.html, kiosk.html, public/favicon.svg ayrıca elle güncellenir).
export const BRAND = {
  // Tam ad — başlıklar, banner, dokümantasyon
  name: 'Klyrix Gate',
  fullName: 'Klyrix Gate — Secure Gateway',
  // Kelime işareti (wordmark) — iki tonlu render için parçalı
  wordmarkPrimary: 'klyrix',
  wordmarkSecondary: '/gate',
  // Slogan / alt başlık
  tagline: 'Secure Gateway',
  // Sürüm rozeti (major.minor — version.json ile birlikte güncellenir)
  version: 'v2.7',
  // Marka renkleri (klyrix/gate — düşük kromalı slate paleti)
  colors: {
    bgFrom: '#94A3B8',   // slate 400 — gradient başlangıcı
    bgTo: '#1E293B',     // slate 800 — gradient bitişi
    accent: '#64748B',   // slate 500 — ikincil metin / link
    ink: '#F8FAFC',      // birincil metin (beyaz)
  },
} as const;

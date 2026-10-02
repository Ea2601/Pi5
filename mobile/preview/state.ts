// Web önizlemesinin sahte durumu: adres satırındaki sorgu ilk açılışta tarayıcı deposuna yazılır. Yalnız KLYRIX_PREVIEW
// derlemesinde kullanılır (metro.config.js).
//   ?paired=1     eşleşmiş + anahtar var (ana ekran)
//   ?paired=key   eşleşmiş, kişinin ilk telefonu: anahtar adımı (kurtarma anahtarı gösterilir)
//   ?paired=join  eşleşmiş, kişinin anahtarı başka telefonda: kurtarma anahtarı istenir
//   ?legacy=1     uygulamanın eski sürümünün eşleşmesi (güncelleme notu)
//   &theme=dark|light|system
const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
export const previewQuery = q;

export function seed(): void {
  if (typeof localStorage === 'undefined' || localStorage.getItem('preview.seeded') === window.location.search) return;
  localStorage.clear();
  localStorage.setItem('preview.seeded', window.location.search);
  const paired = q.get('paired');
  if (paired === '1' || paired === 'key' || paired === 'join') {
    localStorage.setItem('klyrix.pairing2', JSON.stringify({
      hosts: ['192.168.1.153', 'yedek.lan'], port: 8095, token: 'onizleme', piName: 'pi5', deviceName: 'Hakan\'ın Telefonu',
      host: '192.168.1.153', deviceId: 7, profileId: 'a1b2c3d4e5f6', profileName: 'Hakan', v: 2,
    }));
  }
  if (paired === '1') {
    localStorage.setItem('klyrix.key.a1b2c3d4e5f6', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=');
    localStorage.setItem('klyrix.last', JSON.stringify({ at: Date.UTC(2026, 9, 2, 9, 5), uploaded: 4, failed: 0, bytes: 21e6, items: 1321, snapshotId: 31 }));
  }
  if (q.get('legacy') === '1') localStorage.setItem('klyrix.pairing', '{}');
  const theme = q.get('theme');
  if (theme === 'dark' || theme === 'light' || theme === 'system') {
    localStorage.setItem('klyrix.settings', JSON.stringify({ wifiOnly: true, videos: true, auto: true, theme }));
  }
}

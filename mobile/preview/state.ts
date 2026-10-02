// Web önizlemesinin sahte durumu: adres satırındaki sorgu (?paired=1&theme=light&tab=settings) ilk açılışta tarayıcı
// deposuna yazılır. Yalnız KLYRIX_PREVIEW derlemesinde kullanılır (metro.config.js).
const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
export const previewQuery = q;

export function seed(): void {
  if (typeof localStorage === 'undefined' || localStorage.getItem('preview.seeded') === window.location.search) return;
  localStorage.clear();
  localStorage.setItem('preview.seeded', window.location.search);
  if (q.get('paired') === '1') {
    localStorage.setItem('klyrix.pairing', JSON.stringify({
      hosts: ['192.168.1.153', 'yedek.lan'], port: 8095, token: 'onizleme', piName: 'pi5', deviceName: 'Hakan\'ın Telefonu', host: '192.168.1.153',
    }));
    localStorage.setItem('klyrix.last', JSON.stringify({ at: Date.UTC(2026, 9, 2, 11, 5), uploaded: 128, failed: 0, skipped: 1106, bytes: 812e6 }));
  }
  const theme = q.get('theme');
  if (theme === 'dark' || theme === 'light' || theme === 'system') {
    localStorage.setItem('klyrix.settings', JSON.stringify({ wifiOnly: true, videos: true, auto: true, theme }));
  }
}

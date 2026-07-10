// Tema yönetimi — localStorage birincil kaynak (anlık, senkron; sayfa yenilemede sıfırlanmaz),
// backend'e de en iyi çaba ile yazılır (diğer cihazlar/kiosk okuyabilsin diye).
import { putApi } from './hooks/useApi';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'theme';

export function getStoredTheme(): Theme | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle('light-theme', theme === 'light');
}

export function getCurrentTheme(): Theme {
  return document.documentElement.classList.contains('light-theme') ? 'light' : 'dark';
}

// Temayı ayarla: DOM'a uygula + localStorage'a yaz + backend'e senkronla (en iyi çaba).
export function setTheme(theme: Theme): void {
  applyThemeClass(theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* yoksay */ }
  putApi('/settings', { settings: { theme } }).catch(() => { /* offline/senkron hatası önemsiz */ });
}

// localStorage'da tema yoksa backend'deki değeri localStorage'a tohumla (ilk kullanım).
export function seedThemeFromBackend(backendTheme: string | undefined): void {
  if (getStoredTheme()) return; // zaten localStorage'da var, dokunma
  const theme: Theme = backendTheme === 'light' ? 'light' : 'dark';
  applyThemeClass(theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* yoksay */ }
}

// Kalıcı kayıt (expo-secure-store — Android Keystore / iOS anahtar zinciri): eşli cihazlar, her cihaz için bu telefonun
// WireGuard gizli anahtarı (telefondan hiç çıkmaz; Pi'de yalnız genel anahtarı var) ve görünüm tercihi.
import * as SecureStore from 'expo-secure-store';

export type ThemePref = 'system' | 'dark' | 'light';
export interface Settings { theme: ThemePref }
export const DEFAULT_SETTINGS: Settings = { theme: 'system' };

export interface SavedDevice {
  piId: string;      // Pi'nin kimliği (keşifteki id; yoksa sunucu anahtarı)
  piName: string;
  deviceId: number;  // bu telefonun Pi'deki kaydı (kaldırmak için)
  address: string;   // telefonun tünel adresi (10.77.77.x)
  serverPublicKey: string;
  port: number;      // Pi'nin WireGuard portu
  lan: string[];     // Pi'nin ev ağı adresleri (evdeyken uç adres)
  remote: string;    // DDNS adı ya da dış IP (dışarıdayken)
  addedAt: number;
}

const SECRET = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'x';
const K = { devices: 'gate.devices', settings: 'gate.settings', key: (piId: string) => `gate.key.${safe(piId)}` };

async function read<T>(k: string): Promise<T | null> {
  const v = await SecureStore.getItemAsync(k, SECRET).catch(() => null);
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

export const loadDevices = async (): Promise<SavedDevice[]> => (await read<SavedDevice[]>(K.devices)) ?? [];
export const saveDevices = (d: SavedDevice[]) => SecureStore.setItemAsync(K.devices, JSON.stringify(d), SECRET);
export const loadKey = (piId: string) => SecureStore.getItemAsync(K.key(piId), SECRET).catch(() => null);
export const saveKey = (piId: string, privateKey: string) => SecureStore.setItemAsync(K.key(piId), privateKey, SECRET);
export const dropKey = (piId: string) => SecureStore.deleteItemAsync(K.key(piId), SECRET).catch(() => {});
export const loadSettings = async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(K.settings)) });
export const saveSettings = (s: Settings) => SecureStore.setItemAsync(K.settings, JSON.stringify(s), SECRET);

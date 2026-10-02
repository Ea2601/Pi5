// Kalıcı ayarlar: eşleştirme (Pi anahtarı) ve kişinin şifreleme anahtarı anahtar zincirinde / Keystore'da — telefon
// kilitliyken de (ilk kilit açılışından sonra) okunur ki arka plan yedeklemesi çalışsın; yalnız bu cihazda kalır (bulut
// yedeğine / yeni telefona taşınmaz: yeni telefon kurtarma anahtarıyla alır). Tercihler ve son turun özeti de burada.
import * as SecureStore from 'expo-secure-store';
import type { Pairing2 } from '../core/api.ts';
import { fromBase64, toBase64 } from '../core/crypto.ts';

// theme: panelle aynı koyu / açık tema; 'system' telefonun görünümünü izler
export type ThemePref = 'system' | 'dark' | 'light';
export interface Settings { wifiOnly: boolean; videos: boolean; auto: boolean; theme: ThemePref }
export interface LastRun {
  at: number; uploaded: number; failed: number; bytes: number; items?: number;
  snapshotId?: number | null; unchanged?: boolean; error?: string; stopped?: boolean;
}
// Bu telefonun son yazdığı yedek ve durum özeti: telefonda değişiklik yoksa yeni yedek yazılmaz
export interface LastSnap { profileId: string; snapshotId: number; hash: string }
export const DEFAULT_SETTINGS: Settings = { wifiOnly: true, videos: true, auto: true, theme: 'system' };

const SECRET = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const K = {
  pairing: 'klyrix.pairing2', legacy: 'klyrix.pairing', settings: 'klyrix.settings', last: 'klyrix.last', snap: 'klyrix.snap',
  key: (profile: string) => `klyrix.key.${profile}`,
};
async function read<T>(key: string): Promise<T | null> {
  try {
    const v = await SecureStore.getItemAsync(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
const write = (key: string, v: unknown) => SecureStore.setItemAsync(key, JSON.stringify(v), SECRET);
const drop = (key: string) => SecureStore.deleteItemAsync(key).catch(() => {});

export const loadPairing = () => read<Pairing2>(K.pairing);
export const savePairing = (p: Pairing2) => write(K.pairing, p);
// Uygulamanın eski sürümünün (şifresiz, kişisiz) eşleşmesi: yeni sürümde yeniden eşleştirilir
export const hasLegacyPairing = async (): Promise<boolean> => !!(await SecureStore.getItemAsync(K.legacy).catch(() => null));

export async function loadKey(profileId: string): Promise<Uint8Array | null> {
  const v = await SecureStore.getItemAsync(K.key(profileId)).catch(() => null);
  const k = v ? fromBase64(v) : null;
  return k && k.length === 32 ? k : null;
}
export const saveKey = (profileId: string, key: Uint8Array) => SecureStore.setItemAsync(K.key(profileId), toBase64(key), SECRET);

// Eşleştirmeyi kaldırma: Pi anahtarı, şifreleme anahtarı ve bu telefonun yedek kayıtları silinir (tercihler kalır)
export async function forgetPairing(): Promise<void> {
  const p = await loadPairing();
  if (p) await drop(K.key(p.profileId));
  for (const k of [K.pairing, K.legacy, K.last, K.snap]) await drop(k);
}
export const loadSettings = async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(K.settings)) });
export const saveSettings = (s: Settings) => SecureStore.setItemAsync(K.settings, JSON.stringify(s));
export const loadLast = () => read<LastRun>(K.last);
export const saveLast = (l: LastRun) => write(K.last, l);
export const loadLastSnap = () => read<LastSnap>(K.snap);
export const saveLastSnap = (s: LastSnap) => write(K.snap, s);

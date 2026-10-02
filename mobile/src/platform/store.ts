// Kalıcı ayarlar: eşleştirme (Pi anahtarı dahil — anahtar zinciri / Keystore), tercihler ve son turun özeti.
import * as SecureStore from 'expo-secure-store';
import type { Pairing } from '../core/protocol.ts';

export interface Settings { wifiOnly: boolean; videos: boolean; auto: boolean }
export interface LastRun { at: number; uploaded: number; failed: number; skipped: number; bytes: number; error?: string; stopped?: boolean }
export const DEFAULT_SETTINGS: Settings = { wifiOnly: true, videos: true, auto: true };

const K = { pairing: 'klyrix.pairing', settings: 'klyrix.settings', last: 'klyrix.last' };
async function read<T>(key: string): Promise<T | null> {
  try {
    const v = await SecureStore.getItemAsync(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
const write = (key: string, v: unknown) => SecureStore.setItemAsync(key, JSON.stringify(v));

export const loadPairing = () => read<Pairing>(K.pairing);
export const savePairing = (p: Pairing) => write(K.pairing, p);
export const forgetPairing = async () => { await SecureStore.deleteItemAsync(K.pairing); await SecureStore.deleteItemAsync(K.last); };
export const loadSettings = async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(K.settings)) });
export const saveSettings = (s: Settings) => write(K.settings, s);
export const loadLast = () => read<LastRun>(K.last);
export const saveLast = (l: LastRun) => write(K.last, l);

// Pi oturumu: eşleştirme + kişinin anahtarı → Pi istemcisi ve şifreleme. Yedekler sekmesi (liste, geri yükleme, çöp) ve
// yedekleme turu bunu kullanır.
import { connect2, type Api, type Pairing2 } from './core/api.ts';
import type { Cipher } from './core/crypto.ts';
import { makeCipher } from './platform/cipher.ts';
import { http } from './platform/http.ts';
import { loadKey, loadPairing, savePairing } from './platform/store.ts';

export class Skip extends Error {}
export interface Session { pairing: Pairing2; api: Api; cipher: Cipher }

export async function openSession(): Promise<Session> {
  const pairing = await loadPairing();
  if (!pairing) throw new Skip('Pi ile eşleşmemiş');
  const key = await loadKey(pairing.profileId);
  if (!key) throw new Skip('Şifreleme anahtarı kurulmadı');
  const api = await connect2(http, pairing);
  // Bir dahaki sefere önce yanıt veren adres
  const pr = api.host !== pairing.host ? { ...pairing, host: api.host } : pairing;
  if (pr !== pairing) await savePairing(pr);
  return { pairing: pr, api, cipher: await makeCipher(key) };
}

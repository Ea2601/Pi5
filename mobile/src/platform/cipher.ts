// Uçtan uca şifreleme bağdaştırıcısı: AES-256-GCM yerel kodla (expo-crypto; iOS CryptoKit, Android javax.crypto),
// SHA-256 yerel, HMAC çekirdekte (crypto.ts). Biçim çekirdeğin ve Node testinin biçimi: [12 bayt nonce][şifreli][16 bayt etiket].
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, CryptoDigestAlgorithm, digest, getRandomBytes } from 'expo-crypto';
import { hmacSha256, type Cipher } from '../core/crypto.ts';

const SEALED = { ivLength: 12, tagLength: 16 } as const;

export async function makeCipher(raw: Uint8Array): Promise<Cipher> {
  if (raw.length !== 32) throw new Error('Şifreleme anahtarı 32 bayt olmalı');
  const key = await AESEncryptionKey.import(raw);
  const sha256 = async (b: Uint8Array) => new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, b as Uint8Array<ArrayBuffer>));
  return {
    async seal(plain, aad) {
      const s = await aesEncryptAsync(plain, key, { nonce: { length: SEALED.ivLength }, tagLength: SEALED.tagLength, additionalData: aad });
      return await s.combined();
    },
    // Etiket tutmazsa (değiştirilmiş veri ya da başka anahtar) hata fırlatır
    async open(sealed, aad) {
      return await aesDecryptAsync(AESSealedData.fromCombined(sealed, SEALED), key, { additionalData: aad });
    },
    hmac: data => hmacSha256(raw, data, sha256),
  };
}

// Yeni kişi anahtarı (yalnız kişinin ilk telefonunda; sonrakiler kurtarma anahtarıyla alır)
export const newKey = (): Uint8Array => getRandomBytes(32);

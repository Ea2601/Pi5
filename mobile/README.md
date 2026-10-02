# Klyrix Yedek — mobil uygulama (iOS / Android)

Telefonun fotoğraf ve videolarını evdeki Klyrix Gate'e (Raspberry Pi) yedekler. Pi tarafı: `backend/src/mobile.ts`
(panelde Yedekleme → Cihaz Yedekleme → «Telefon ve tablet — Klyrix uygulaması»).

- **Eşleştirme:** panelde «Telefon ekle» → uygulamada «QR kodu okut» (ya da Pi'nin adresi + kodu elle). Kod tek kullanımlık,
  10 dakika geçerli. Uygulama Pi'den bir cihaz anahtarı alır (telefonun anahtar zincirinde / Keystore'da saklanır).
- **Yedekleme:** fotoğraf kitaplığı eskiden yeniye taranır, Pi'de olmayanlar yüklenir (64 MB'a kadar dosya tek istekte, büyükleri
  8 MB parçalarla; kesilen yükleme kaldığı yerden sürer). Telefonda hiçbir şey silinmez ya da değişmez. Düzenlenen fotoğraf yeni
  sürüm olarak yeniden yedeklenir.
- **Arka plan:** `expo-background-task` (Android en sık 15 dakikada bir; iOS sistemin seçtiği zamanlarda, çoğunlukla gece).
  Ayarlar: kendiliğinden yedekle, yalnız Wi-Fi'da, videolar.
- **Ağ:** Pi'ye ev ağında ya da Ev VPN'iyle HTTP (port 8095) ile bağlanılır — panelin kendisi gibi. Pi uç noktası yalnız yükleme
  kabul eder: anahtar ele geçse bile yedekler okunamaz ya da silinemez.

## Klasörler

| Yol | İçerik |
| --- | --- |
| `src/core/` | Saf TypeScript protokol, Pi istemcisi ve yedekleme motoru (Node testleriyle aynı kod) |
| `src/platform/` | Expo bağdaştırıcıları: ağ / dosya yükleme, medya kitaplığı, güvenli depo, arka plan görevi |
| `src/ui/` | Eşleştirme ve ana ekran |
| `test/core.test.ts` | Birim testleri (`npm test`) |
| `test/pi-integration.ts` | Gerçek Pi'ye karşı uçtan uca test (`PANEL=http://<pi>:3001 node test/pi-integration.ts`, ev ağında) |

## Geliştirme

```bash
cd mobile
npm install
npm run typecheck      # tsc (strict)
npm test               # çekirdek birim testleri (Node 22.18+ / 23.6+, tür ayıklama)
npx expo start         # geliştirme sunucusu — kamera, medya ve arka plan görevi için development build gerekir:
npx expo run:android   # ya da: npx expo run:ios  (Xcode, macOS)
```

## Derleme ve mağaza

Mağaza yayını Apple Developer / Google Play Console hesabınızla yapılır (Klyrix'in hesabı yoktur):

1. Paket kimliklerini kendi hesabınıza göre verin: `KLYRIX_IOS_BUNDLE_ID=com.sizin.yedek`, `KLYRIX_ANDROID_PACKAGE=com.sizin.yedek`
   (varsayılan `com.klyrix.gatebackup`, `app.config.ts`).
2. `npm install -g eas-cli && eas login && eas init` (Expo hesabı; proje kimliği `app.json`'a eklenir — ilk `eas build` de kendisi ekler).
3. Android'i mağazasız denemek için: `eas build -p android --profile preview` → APK'yi telefona kurun.
4. Mağaza: `eas build -p ios --profile production` ve `eas build -p android --profile production`, sonra `eas submit`.

iOS notları: yerel ağ izni (`NSLocalNetworkUsageDescription`) ve yalnız yerel adreslere şifresiz HTTP (`NSAllowsLocalNetworking`,
`yedek.lan` istisnası) `app.json`'da. İlk cihaz denemesinde Pi'ye IP adresiyle bağlanılamazsa ATS ayarını gözden geçirin.
Android: şifresiz HTTP `expo-build-properties` ile açık (`usesCleartextTraffic`).

## Durum

Çekirdek Node'da birim + gerçek Pi API'sine karşı entegrasyon testinden geçti; Android ve iOS JS paketleri derleniyor
(`npx expo export`). Gerçek telefonda (kamera, medya izni, arka plan görevi) henüz denenmedi.

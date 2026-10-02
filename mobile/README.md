# Klyrix/Gate Sync — mobil uygulama (iOS / Android)

Telefonun fotoğraf ve videolarını evdeki Klyrix Gate'e (Raspberry Pi) **uçtan uca şifreli** yedekler; yedekler uygulamadan
listelenir, telefona geri yüklenir ve silinir. Pi tarafı: `backend/src/mobile.ts` (HTTP ucu, eşleştirme) ve
`backend/src/mobileStore.ts` (şifreli depo); panelde Yedekleme → Cihaz Yedekleme → «Telefon ve tablet — Klyrix/Gate Sync».

- **Kişi:** panelde kişi eklenir (ör. kendiniz, eşiniz). Aynı kişinin telefonları birbirinin yedeğini görür ve geri yükleyebilir;
  başka kişiler göremez. Eşleştirme: kişide «Telefon ekle» → uygulamada «QR kodu okut» (ya da Pi'nin adresi + kodu elle). Kod
  tek kullanımlık, 10 dakika geçerli; uygulama Pi'den bir cihaz anahtarı alır (anahtar zincirinde / Keystore'da).
- **Şifreleme:** kişinin ilk telefonu 32 baytlık anahtar üretir ve **kurtarma anahtarını** gösterir (9 grup, 54 karakter; iki
  grubu yazılarak doğrulanır). Kişinin sonraki telefonları kurtarma anahtarıyla eklenir. Dosyalar telefonda AES-256-GCM ile
  (4 MiB parçalar, parça sırası doğrulanır) şifrelenip gönderilir; Pi yalnız opak kimlik, boyut ve zaman görür. Anahtar Pi'de
  ve panelde yoktur: kurtarma anahtarı kaybolursa ve hiçbir telefonda anahtar kalmazsa yedekler açılamaz.
- **Yedek (anlık görüntü):** her turda kitaplık taranır, Pi'de olmayanlar şifrelenip yüklenir (kesilen yükleme kaldığı
  parçadan sürer), sonra o anki durumun içerik listesi (şifreli) yazılır. Telefonda değişiklik yoksa yeni yedek yazılmaz.
  Pi eski yedekleri seyreltir (son 14 gün günlük, 8 hafta haftalık, 12 ay aylık); silinen yedek 30 gün çöpte kalır.
- **Geri yükleme:** yedeğin içerik listesi açılır, telefonda olmayanlar indirilip çözülür ve «Klyrix Gate Sync» albümüne eklenir.
  Telefonda hiçbir şey silinmez ya da değişmez.
- **Arka plan:** `expo-background-task` (Android yaklaşık saatte bir — sistem pil için erteleyebilir; iOS sistemin seçtiği zamanlarda, çoğunlukla gece).
  Ayarlar: kendiliğinden yedekle, yalnız Wi-Fi'da, videolar.
- **Ağ:** Pi'ye ev ağında ya da Ev VPN'iyle HTTP (port 8095) ile bağlanılır — panelin kendisi gibi; içerik zaten şifreli.

## Klasörler

| Yol | İçerik |
| --- | --- |
| `src/core/` | Saf TypeScript: şifreleme biçimi ve kurtarma anahtarı (`crypto.ts`), Pi v2 istemcisi (`api.ts`), yedek (`snapshot.ts`), geri yükleme (`restore.ts`), eşleştirme kodu (`protocol.ts`) — Node testleriyle aynı kod |
| `src/platform/` | Expo bağdaştırıcıları: AES-GCM (`expo-crypto`), ağ (`expo/fetch`), medya kitaplığı ve galeri, güvenli depo, kimlik önbelleği, arka plan görevi |
| `src/ui/` | Kurulum (anahtar adımı dahil), Yedekleme, Yedekler (liste, ayrıntı, geri yükleme, çöp), Ayarlar |
| `test/core.test.ts`, `test/v2.test.ts` | Birim testleri (`npm test`; şifreleme Node'un AES-GCM'iyle aynı biçimde) |
| `test/pi-v2.ts` | Gerçek Pi'ye karşı uçtan uca test (`PANEL=http://<pi>:3001 STORE=<disk>/.klyrix-mobil node test/pi-v2.ts`, Pi'de) |
| `preview/`, `scripts/preview.mjs` | Web önizlemesi (yalnız geliştirme, sahte Pi verisi) |

## Geliştirme

```bash
cd mobile
npm install
npm run typecheck      # tsc (strict)
npm test               # çekirdek birim testleri (Node 22.18+ / 23.6+, tür ayıklama)
npm run preview        # ekranlar tarayıcıda: http://127.0.0.1:8099/?paired=1&theme=dark (state.ts'te diğer durumlar)
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

Uygulamanın eski sürümüyle (şifresiz, kişisiz) eşleşmiş telefon güncellenince yeniden eşleştirilir; Pi eski sürümün yükleme
ucunu yeni sürüm yayılana dek açık tutar ve panelde o telefonları ayrı listeler.

## Durum

Çekirdek Node'da birim testlerinden ve gerçek Pi arka ucuna karşı uçtan uca testten (test kabı) geçti; ekranlar web
önizlemesinde denetlendi. Gerçek telefonda (expo-crypto AES-GCM, medya izni, galeriye yazma, arka plan görevi) henüz denenmedi.

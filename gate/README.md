# Klyrix/Gate — yönetim uygulaması

Pi'deki Klyrix Gate'i telefondan panelin kendisiyle yönetir: evde de evin dışında da. Birden çok cihaz eklenebilir;
yakındaki cihaz ağda kendiliğinden bulunur. Telefon ile Pi arasındaki bağlantı şifreli ve kalıcıdır, ama **telefonda VPN
açılmaz**: WireGuard yalnız uygulamanın içinde, kullanıcı alanında çalışır (wireguard-go + gVisor netstack) ve yalnız
uygulamanın kendi trafiğini taşır. Pi tarafı: `backend/src/gateApp.ts` (eşleşme ucu, uygulama kapısı `10.77.77.1:8097`).

Şimdilik Android. iPhone sonraki aşamada (Apple geliştirici hesabı).

## Nasıl çalışır

- **Eşleşme:** telefon kendi WireGuard anahtarını üretir (gizli anahtar telefondan çıkmaz; Pi'de yalnız genel anahtarı
  olur). Sahiplik panelin «Telefon ekle» kodu (QR) ya da panel şifresiyle kanıtlanır. Pi'de Ev VPN'i kapalıysa uygulama
  açılması için onay ister. QR'daki sunucu anahtarı eşleşme yanıtıyla karşılaştırılır.
- **Bağlantı:** uygulama açılınca seçili cihaza; evdeyken Pi'nin ev ağı adresinden, dışarıda DDNS adından. 15 sn'de bir
  denetlenir; Pi'ye 3 sn'de ulaşılamazsa el sıkışma hemen yenilenir. Uygulama arka planda 60 sn sonra bağlantıyı kapatır.
- **Panel:** uygulama içindeki küçük ters vekilden (127.0.0.1, açılışa özel sır; telefondaki diğer uygulamalar
  kullanamaz) WebView'da; panel şifresi sorulmaz — kimlik eşli telefonun tüneli.

## Klasörler

| Yol | İçerik |
| --- | --- |
| `src/core/gate.ts` | Saf TypeScript: Pi uçları (kimlik, eşleşme), QR, yanıt doğrulaması, uç adres sırası — Node testleriyle aynı kod |
| `src/connection.ts` | Bağlantı yöneticisi (tünel, uç adres seçimi, denetim, arka plan) |
| `src/platform/` | Güvenli depo (cihazlar, anahtarlar), ağ |
| `src/ui/` | Cihazlar, Cihaz ekle (keşif, QR, kod / şifre), Panel (WebView), Ayrıntılar |
| `modules/klyrix-wg/` | Yerel Android modülü (Kotlin): WireGuard köprüsü + ağda keşif (NSD) |
| `wg/` | Go: `wgbridge` (gomobile ile Android'e), `cmd/wgtest` (Linux'ta uçtan uca deneme), derleme betiği |

## Geliştirme

```bash
npm install
npm run typecheck && npm test
bash wg/build-android.sh      # Go kodu değişince: Docker'da derler, modules/klyrix-wg/android'e koyar (commit'lenir)
npx eas-cli build -p android --profile preview   # APK
```

`wg/cmd/wgtest`, Pi'ye (ya da Docker'daki Pi kabına) gerçekten eşleşip tüneli, vekili ve yeniden bağlanmayı sınar:
`PI=<pi adresi> CODE=<panel kodu> go run ./cmd/wgtest`.

EAS proje kimliği (`extra.eas.projectId`) yalnız yerel `app.json`'da durur, commit'lenmez.

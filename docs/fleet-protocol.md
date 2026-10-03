# klx-fleet/1 — Klyrix Gate filo protokolü

Bu belge, Klyrix Gate cihazındaki **filo ajanının** (`backend/src/fleet.ts`, `backend/src/fleetProto.ts`) yönetilen bulut
denetleyicisiyle konuştuğu protokolü tanımlar. Bulut sunucusu ayrı bir depodadır ve bu sözleşmeyi uygular; bu depo yalnız
cihaz tarafını içerir.

## 1. İlkeler

- **Varsayılan kapalı.** Cihaz yalnız yönetici panelden «Filoya kaydol» dediğinde bağlanır. Kayıt yokken hiçbir dosya,
  zamanlayıcı ya da ağ isteği yoktur.
- **Yalnız dışa doğru.** Cihaz sunucuyu HTTPS ile yoklar. Cihazda dinlenen port, ters tünel ya da `127.0.0.1`'e aktarım
  yoktur; panel internete açılmaz. Sunucu cihaza hiçbir zaman bağlantı açmaz.
- **İmzalı komut, sabit izin listesi.** Sunucu komutları kiracı anahtarıyla (Ed25519) imzalar. Cihaz yalnız şu türleri tanır:
  `report.inventory`, `update.start`, `policy.apply`. Güvenlik duvarı, yönlendirme, cihaz rolü, ağ ayarları (DHCP, WAN, yedek
  hat), terminal, panel koruması, bulut yedeği kasası, mesh eşleştirme ve gizli anahtar okuma **protokolde yoktur**; sunucu
  gönderse bile cihaz reddeder. Yeni tür ancak cihaz yazılımının yeni sürümüyle eklenebilir.
- **Yerel denetim.** Cihaz yöneticisi tür başına «onay iste» seçer (varsayılan: `policy.apply` onay ister), rapor ayrıntı
  düzeyini seçer ve istediği an «Filodan ayrıl» ile bağlantıyı keser.

## 2. Taşıma

- Temel adres: kayıtta girilen `https://` adresi (isteğe bağlı yol önekiyle, ör. `https://filo.ornek.com/klx`). Uçlar
  `<temel>/v1/...` biçimindedir. Yalnız HTTPS; sertifika sistemin güven deposuyla doğrulanır.
- Tüm istekler `POST`, gövde `application/json` (kanonik JSON, § 3). Her gövdede `"proto": "klx-fleet/1"` bulunur.
- Cihaz istemci sınırları: mutlak 15 sn zaman aşımı, yönlendirme (3xx) **izlenmez** (hata sayılır), yanıt en çok 256 KiB.
  Bağlanırken çözülen adres denetlenir: loopback, link-local, çoklu yayın, ayrılmış adresler ve Pi'nin kendi adresleri
  reddedilir; özel ağ adresi (10/8, 172.16/12, 192.168/16, 100.64/10, ULA) yalnız kayıtta açık onayla kabul edilir.
- Saat: Pi'de RTC yoktur. Cihaz, saati NTP ile eşitlenmeden (`timedatectl NTPSynchronized`) hiçbir imzalı istek göndermez
  (kayıt, yoklama, sonuç, ayrılma); sonuçlar kuyrukta bekler.

## 3. Kanonik JSON

RFC 8785 (JCS) alt kümesi: nesne anahtarları UTF-16 kod birimine göre sıralı, ayırıcılarda boşluk yok, dizgeler
`JSON.stringify` kaçışıyla, sayılar ECMAScript gösterimiyle (yalnız sonlu sayılar; komut alanlarında tamsayı). `undefined`
alanlar yazılmaz. İmzalanan her yapı bu biçimde serileştirilir.

## 4. Anahtarlar ve imzalar

- **Cihaz anahtarı:** Ed25519; kayıtta cihazda üretilir. Gizli yarı `/etc/pi5-gateway/fleet/device.key` (0600) dosyasında
  kalır, hiçbir zaman gönderilmez. Açık anahtar ham 32 bayt, base64url (padding yok, 43 karakter).
- **Kiracı anahtarı:** Ed25519; sunucu (kiracı) tutar. Açık yarısı kayıt yanıtıyla gelir ve cihazda **sabitlenir**
  (`enroll.json`); değişmesi yeniden kayıt gerektirir.
- **Cihaz isteği imzası** (her uçta):

  ```
  X-Klx-Proto:  klx-fleet/1
  X-Klx-Device: <device_id>            (kayıtta: "enroll")
  X-Klx-Ts:     <unix saniye>
  X-Klx-Sig:    base64url(Ed25519(cihaz_anahtarı, "<METHOD>|<yol>|<ts>|<sha256hex(gövde)>"))
  ```

  `<yol>` isteğin URL yoludur (temel adresin öneki dahil, sorgu yok), ör. `POST|/klx/v1/poll|1767225600|9f86d0…`.
  Sunucu `|ts − şimdi| ≤ 300 sn` dışını ve aynı `(device_id, ts, sig)` yinelemesini reddetmelidir.
- **Komut zarfı imzası:** `sig = base64url(Ed25519(kiracı_anahtarı, kanonik(cmd)))`.

## 5. Uçlar

### 5.1 `POST /v1/enroll`

Gövde:

```json
{ "proto": "klx-fleet/1", "enroll_key": "<tek kullanımlık anahtar>", "device_pub": "<base64url>",
  "hw_tag": "<donanım özeti, 32 hex — ham seri numarası değil>", "version": "2.24.126", "build": 203,
  "profile": "standard", "site": "<kullanıcının konum etiketi, en çok 40 karakter>" }
```

İmza `device_pub`'ın gizli yarısıyla (`X-Klx-Device: enroll`). Sunucu: anahtar tek kullanımlıktır ve kısa ömürlüdür
(önerilen ≤ 10 dk); başarılı kayıtta geçersiz olur.

Yanıt `200`:

```json
{ "device_id": "<8–64, [A-Za-z0-9_-]>", "tenant_id": "<8–64, [A-Za-z0-9_-]>", "tenant_name": "<en çok 60>",
  "tenant_pub": "<base64url Ed25519>", "poll_s": 120 }
```

Kayıt anahtarı cihazda yalnız bu isteğin gövdesinde ve bellekte bulunur: diske, günlüğe, argv / env'e, ayar tablosuna ya
da yedeğe yazılmaz.

### 5.2 `POST /v1/poll`

Gövde: `{ "proto", "last_seq": <cihazın işlediği en büyük seq>, "version", "build", "awaiting": <yerel onay bekleyen sayısı>,
"pending_policy": "<sağlık penceresindeki politika id'si ya da null>" }`.

Yanıt `200`: `{ "commands": [<zarf>, …], "poll_s"?: <öneri> }` — `seq > last_seq` olanlar gönderilir. Cihaz zarfları `seq`'e
göre artan sırada işler (en küçük 20'si; kalanlar sonraki yoklamada yeniden gelir).

Cihaz aralığı: sunucunun önerisi (kayıt yanıtındaki ve her yoklama yanıtındaki son `poll_s`) ya da yerel ayar (60–900 sn,
varsayılan 120), her seferde ±%20 rastgele. Hata sürdükçe üstel geri çekilme (aralık × 2ⁿ, sapma dahil en çok 1 saat).
`Retry-After` (sn) yalnız `429` / `503`'te okunur ve geri çekilmenin altına inmez. Politikanın sağlık penceresinde (§ 7)
başarılı yoklama henüz yoksa sonraki yoklama en geç 15 sn (hata sürüyorsa 60 sn) sonradır.

### 5.3 `POST /v1/result`

Gövde: `{ "proto", "id", "seq", "type", "status", "detail": "<en çok 300>", "at": <unix sn>, "data"?: {…} }`.

`status`: `ok` · `failed` · `rejected` · `expired` · `awaiting_approval` (yerel onay bekleniyor; son sonuç sonra gelir) ·
`applied` (politika uygulandı, sağlık penceresi sürüyor) · `rolled_back` (politika otomatik / ayrılırken geri alındı).
Her sonuç önce cihazdaki kuyruğa (en çok 50) girer ve kuyruk baştan sırayla gönderilir: daha önce gidemeyen sonuç varken
yenisi onun önüne geçmez. Kalıcı `4xx` (408 / 429 dışı) yanıt alan sonuç düşer. Cihaz yoklamayı duraklatmışken, sunucu cihazı
kaldırmışken ya da saat eşitli değilken sonuç gönderilmez, kuyrukta bekler. Sunucu `(device_id, id, status)` üzerinden
yinelemeyi tekilleştirmelidir.

### 5.4 `POST /v1/leave`

Gövde: `{ "proto", "reason": "local" }`. Cihaz önce uçuştaki yoklamanın ve komutun bitmesini bekler, bekleyen politikayı
geri alır, sonra bu isteği bir kez dener, sonucu ne olursa olsun anahtarını ve tüm filo dosyalarını siler. Sunucu cihazı
«ayrıldı» işaretlemeli ve sonraki istekleri `410` + `device_unknown` ile yanıtlamalıdır.

**Kopya kart:** `hw_tag` bu donanımla uyuşmayan cihaz (§ 10) sunucuya hiçbir istek göndermez — yoklama, sonuç, onay ve
`/v1/leave` dahil. Orada «Filodan ayrıl» yalnız o kopyadaki dosyaları siler; kimlik asıl cihazındır ve onun kaydı sürer.

### 5.5 Ayrılmış: `POST /v1/claim-status` (G4.2, sıfır dokunuşla kurulum)

Bu sürümde cihaz çağırmaz; G4.2 için ayrılmıştır. Uç adı ve `/v1/` altındaki başka yeni uçlar geriye uyumlu eklenir.

## 6. Komut zarfı

```json
{ "cmd": { "v": 1, "id": "<8–64, [A-Za-z0-9_-]>", "seq": 42, "type": "policy.apply",
           "tenant_id": "…", "device_id": "…", "issued_at": 1767225600, "not_before": 1767225600,
           "not_after": 1767229200, "params": { … } },
  "sig": "<base64url, 86 karakter>" }
```

Cihazın denetim sırası (ilk başarısızlıkta durur):

1. Biçim; `cmd` kanonik JSON'a çevrilebilmeli.
2. **İmza** — kiracının sabitlenmiş açık anahtarıyla. Bozuk imzalı zarfın hiçbir alanına güvenilmez: sonuç gönderilmez,
   `last_seq` ilerlemez, cihazda uyarı olayı yazılır.
3. `tenant_id` ve `device_id` bu cihazınki olmalı (başka cihaza imzalanmış komut tekrar oynatılamaz).
4. `type` izin listesinde olmalı.
5. `seq > last_seq` (kesin artan). Eşit / küçük seq sessizce atlanır (sonucu zaten gönderilmiş / kuyrukta).
6. Süre: `not_before` (yoksa `issued_at`) − 300 sn ≤ şimdi ≤ `not_after`; `not_after − şimdi ≤ 7 gün`.
7. Tür parametreleri (§ 7).

İmzası geçerli ama 3–7'de reddedilen komutta cihaz `last_seq`'i ilerletir ve `rejected` (süre dolmuşsa `expired`) sonucu
gönderir. Geçerli komutun `seq`'i yürütmeden **önce** diske yazılır (yeniden başlatmada iki kez işlenmez).

## 7. Komut türleri

### `report.inventory` — `params: {}`

Sonuç `data`'sı yerel rıza düzeyine göre:

| Düzey | İçerik |
|---|---|
| `minimal` (varsayılan) | `version`, `build`, `role`, `profile`, `uptime_s`, `health` (çalışan / sorunlu servis sayısı, okunmamış uyarı / kritik sayısı, sağlık oranı). **IP, MAC, cihaz listesi yok.** |
| `standard` | + `board`, `cpus`, `mem_mib`, `mem_used_pct`, `load1`, `services[{name,status}]`, `update_state`. IP / MAC yok. |
| `detailed` | + `hostname`, `interfaces[{name, mac, ipv4[], ipv6[]}]`, `devices_known` (sayı). |

### `update.start` — `params: {}`

Cihazın mevcut güncelleme akışını başlatır (GitHub'dan iner; systemd-run ile panel dışında). Depolama ya da bulut yedeği işi
sürerken `rejected`; güncelleme zaten sürüyorsa `ok` («zaten sürüyor»).

### `policy.apply`

```json
{ "pihole_lists": { "add": [{ "list_type": "blacklist", "value": "ornek.com", "comment": "…" }],
                    "remove": [{ "list_type": "blacklist", "value": "eski.com" }] },
  "fail2ban": { "bantime": 3600, "findtime": 600, "maxretry": 5, "sshd_maxretry": 3, "sshd_bantime": 7200, "recidive": true },
  "ui_settings": { "theme": "dark" } }
```

En az bir bölüm; başka bölüm (ör. `firewall`, `routing`) → `rejected`.

- `pihole_lists`: `list_type` ∈ `adlist`, `whitelist`, `blacklist` — **yerel DNS kaydı yok**. Toplam en çok 200 kayıt.
  Eklenen kayıtlar `Filo:` açıklamasıyla işaretlenir; `remove` **yalnız filonun eklediği** kayıtları çıkarır (kullanıcının
  kendi kaydı → `rejected`). Hazır blokliste seçimi (HaGeZi sürümleri) ve Pi-hole'un kendi listeleri (StevenBlack)
  değiştirilemez.
  - `adlist` yalnız `https://`; kullanıcı:parola içeremez; ev ağı, loopback, link-local, ayrılmış adres, cihazın kendi
    adresi ve yerel ad (`localhost`, `*.lan`, `*.local`, `*.home`, `*.internal`, `*.intranet`, `*.home.arpa`, noktasız ad)
    → `rejected` (gravity listeyi cihazdan indirir: kiracı cihaza iç ağda istek attıramaz).
  - **Filo beyaz listesi ebeveyn denetimini ve şifreli DNS engelini aşamaz:** DoH / DoT adlarına ya da cihazdaki ebeveyn
    kurallarının (açık ya da kapalı) kategori alan adlarına ve sitelerine denk gelen `whitelist` kaydı → `rejected`.
- `fail2ban`: yalnız yukarıdaki altı anahtar; aralıklar panelinkiyle aynı. Ev ağı muafiyeti, ek muaf adresler ve SSH
  korumasının açık / kapalı durumu filodan değişmez.
- `ui_settings`: panelin «Ayarlar» sayfasının yazdığı görünüm anahtarları (`accent_color`, `language`, `theme`,
  `notification_sound`, `desktop_notifications`, `auto_refresh`, `refresh_interval`, `speedtest_interval_min`); değerler
  dizge. Ağla ilgili anahtar (DHCP sihirbazı kaydı) filodan değişmez.

Uygulama: doğrula (hiçbir şeye dokunmadan) → anlık görüntü (`/etc/pi5-gateway/fleet/pending/<id>.json`, 0600) → uygula →
`applied` sonucu → **10 dk sağlık penceresi**: pencere içinde politika uygulandıktan SONRA başlamış başarılı bir `/v1/poll`
VE `127.0.0.1:53`'ten DNS yanıtı gelirse `ok` (kalıcı), gelmezse anlık görüntü **otomatik geri yüklenir** ve `rolled_back`
gönderilir. Geri yükleme yalnız filonun değiştirdiğini geri alır: Fail2Ban ve arayüz ayarlarında yalnız politikadaki
anahtarlar ve yalnız değer hâlâ filonun yazdığıysa (pencerede yöneticinin yerelde yaptığı değişiklik korunur). Komutlar,
yerel onaylar, sağlık penceresi ve ayrılma cihazda tek sıradan geçer: pencere sürerken (aynı anda gelen onay dahil) ikinci
`policy.apply` → `rejected`. Fail2Ban uygulanamazsa politikanın tamamı hemen geri alınır (`failed`).

Yerel onay kartında politikanın tamamı görünür: eklenecek / çıkarılacak her kayıt (tür + değer) ve her ayarın şimdiki →
yeni değeri. Cihaz yoklamayı duraklatmışken, sunucu cihazı kaldırmışken ya da kopya kartta onay verilemez (ret verilebilir).

## 8. Hata yanıtları

Sunucu hata gövdesi: `{ "error": { "code": "<kod>", "message": "<insan okur>" } }`.

| HTTP | `code` | Cihazın davranışı |
|---|---|---|
| 400 | `bad_request` | Hata gösterilir; geri çekilme. |
| 401 | `bad_sig`, `stale_ts` | Geri çekilme (saat / anahtar sorunu). `device_revoked` ise yoklama durur. |
| 403 | `device_revoked` | Yoklama durur; panelde «Sunucu cihazı kaldırdı». Kodsuz / başka kodlu 403 (ör. araya giren WAF) geçici hata: geri çekilme. |
| 409 | `enroll_key_used`, `enroll_key_expired` | Kayıt başarısız. |
| 400/404 | `enroll_key_invalid` | Kayıt başarısız. |
| 410 | `device_unknown` | Yoklama durur (cihaz ayrılmış / silinmiş). Başka kodlu 410: geri çekilme. |
| 426 | `proto_unsupported` | Geri çekilme; panelde hata (cihazı güncelleyin). |
| 429 / 503 | `rate_limited`, `unavailable` | `Retry-After` kadar bekle (geri çekilmeden kısa değilse). |
| 5xx | — | Üstel geri çekilme. |

## 9. Sürümleme

- Protokol kimliği `klx-fleet/1`: başlıkta (`X-Klx-Proto`) ve her gövdede (`proto`). Geriye uyumsuz değişiklik yeni bir
  ana sürüm (`klx-fleet/2`) ve yeni yol öneki (`/v2/`) gerektirir; sunucu bir süre iki sürümü birlikte sunar.
- `/v1/` içinde geriye uyumlu eklemeler: yeni isteğe bağlı alanlar (cihaz bilmediği yanıt alanlarını yok sayar), yeni uçlar
  (§ 5.5). **Yeni komut türü geriye uyumlu değildir:** eski cihaz onu `rejected` (`type_not_allowed`) ile döndürür.

## 10. Cihazdaki dosyalar

`/etc/pi5-gateway/fleet/` (0700; yalnız kayıtla oluşur, «Filodan ayrıl» siler): `device.key` (0600, PKCS#8 PEM),
`hw_tag` (0600; açılışta donanım özetiyle karşılaştırılır — uyuşmazsa «yeniden kayıt gerekli», yoklama yapılmaz),
`enroll.json` (0600), `state.json` (0600: `last_seq`, ayarlar, son komutlar, gönderilecek sonuçlar), `pending/` (0600
politika anlık görüntüleri). Bu klasör yedeğe ve bulut yedeğine **girmez**: cihaz kimliği başka bir cihaza taşınmaz.

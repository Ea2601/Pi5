# klx-fleet/1 — Klyrix Gate filo protokolü

Bu belge, Klyrix Gate cihazındaki **filo ajanının** (`backend/src/fleet.ts`, `backend/src/fleetProto.ts`) yönetilen bulut
denetleyicisiyle konuştuğu protokolü tanımlar. Bulut sunucusu ayrı bir depodadır ve bu sözleşmeyi uygular; bu depo yalnız
cihaz tarafını içerir.

## 1. İlkeler

- **Varsayılan kapalı.** Cihaz yalnız yönetici panelden «Filoya kaydol» (ya da «Filoya kodla kaydol») dediğinde veya SD kartın
  açılış bölümüne ZTP dosyası konduğunda (§ 11) bağlanır. Kayıt yokken, dosya yokken ve düğmeye basılmadıkça hiçbir dosya,
  zamanlayıcı ya da ağ isteği yoktur.
- **Yalnız dışa doğru.** Cihaz sunucuyu HTTPS ile yoklar. Cihazda dinlenen port, ters tünel ya da `127.0.0.1`'e aktarım
  yoktur; panel internete açılmaz. Sunucu cihaza hiçbir zaman bağlantı açmaz.
- **İmzalı komut, sabit izin listesi.** Sunucu komutları kiracı anahtarıyla (Ed25519) imzalar. Cihaz yalnız şu türleri tanır:
  `report.inventory`, `update.start`, `policy.apply` (+ takma adı `ztp.profile`, § 7). Güvenlik duvarı, yönlendirme, cihaz
  rolü, ağ ayarları (DHCP, WAN, yedek hat), terminal, panel koruması, bulut yedeği kasası, mesh eşleştirme ve gizli anahtar
  okuma **protokolde yoktur**; sunucu gönderse bile cihaz reddeder. Yeni tür ancak cihaz yazılımının yeni sürümüyle
  eklenebilir.
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

İsteğe bağlı `"source": "ztp-file"`: anahtar SD karttaki ZTP dosyasından geldi (§ 11.1). Panelden kayıtta alan yoktur. ZTP
dosyasına yazılan anahtar kartta durduğu için sunucu onu **mutlaka** tek kullanımlık ve kısa ömürlü vermelidir (kart hazırlanıp
cihaza takılana kadar; önerilen ≤ 24 sa); kesin red `409 enroll_key_used` / `enroll_key_expired`, `400/404 enroll_key_invalid`.

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

### 5.5 `POST /v1/claim-status` (G4.2, kodla kayıt — § 11.2)

Henüz kayıtsız cihaz, panelde «Filoya kodla kaydol» denince ürettiği Ed25519 anahtarının gizli yarısıyla imzalar
(`X-Klx-Device: claim`; sunucu imzayı gövdedeki `device_pub` ile doğrular, § 4'teki `ts` ve yineleme kuralları geçerli).

Gövde:

```json
{ "proto": "klx-fleet/1", "device_pub": "<base64url>", "hw_tag": "<32 hex>", "version": "2.24.134", "build": 211,
  "profile": "standard", "site": "<en çok 40 karakter>" }
```

Sunucu **kayıt kodunu** `device_pub`'dan kendisi hesaplar (cihazın gönderdiği bir koda güvenmez):
`base32(sha256(ham 32 bayt açık anahtar))` ilk 8 karakter, RFC 4648 alfabesi (`A–Z`, `2–7`), 4-4 gruplu gösterim
(`ABCD-EFGH`; konsol girişinde büyük / küçük harf ve tire önemsizdir; alfabede `0`, `1`, `8`, `9` olmadığından konsol
okunuşta karışanları `0`→`O`, `1`→`I`, `8`→`B` eşlemelidir). Kod 40 bittir: sunucu kod denemelerini kiracı başına
sınırlamalı ve yalnız son 10 dk içinde bu uca gelmiş bekleyen cihazları eşleştirmelidir. 40 bit, kodu gören birinin aynı
koda düşen başka bir anahtar üretmesine (kaba kuvvetle) yeter; bu yüzden sunucu **şunları yapmalıdır**:

- Girilen kod birden çok bekleyen `device_pub` ile eşleşirse **hiçbirini** bağlamaz (`claimed` dönmez); yöneticiye cihazda
  kodu iptal edip yeniden almasını söyler.
- `claimed` dönmeden önce konsolda bekleyen cihazın konumunu (`site`), `hw_tag`'ın başını, anahtar parmak izini
  (`sha256(device_pub)` ilk 16 hex, `xxxx:xxxx:xxxx:xxxx` — cihazın kod kartında ve kayıttan sonra panelde gösterilen değer) ve
  isteğin kaynak IP'sini gösterir; yönetici onaylayınca bağlar.

Yanıt `200`:

- `{ "status": "pending" }` — yönetici kodu henüz konsola girmedi. Cihaz 15 sn sonra yeniden sorar.
- `{ "status": "claimed", "device_id", "tenant_id", "tenant_name", "tenant_pub", "poll_s" }` — alanlar § 5.1 yanıtıyla aynıdır;
  cihaz kayıt dosyalarını yazar (kaynak `code`) ve § 5.2 yoklamasına geçer. Sunucu bu yanıtı verdikten sonra aynı `device_pub`
  için yeniden `claimed` dönebilir (cihaz yanıtı alamadıysa) ama onu başka bir kiracıya **bağlamaz**.

Cihaz: ilk istek düğmeye basılınca hemen gider (cihazı sunucuda tanıtır ve adresi sınar; başarısızsa kod gösterilmez), sonra
15 sn'de bir, en çok 10 dk. `429` / `503`'te `Retry-After` (15–60 sn). Kesin ret (kodlu 4xx, § 8: `claim_unknown`,
`claim_expired`, `claim_rejected`), süre sonu ya da yerel «İptal» → bekleyen anahtar silinir, istek durur. Anahtar yalnız
cihazın belleğindedir: panel servisi yeniden başlarsa bekleyen kod geçersizdir (sunucudaki bekleyen kayıt kendiliğinden
düşmelidir). `/v1/` altındaki başka yeni uçlar da geriye uyumlu eklenir.

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
`policy.apply` (ya da `ztp.profile`) → `rejected`. Fail2Ban uygulanamazsa politikanın tamamı hemen geri alınır (`failed`).

Yerel onay kartında politikanın tamamı görünür: eklenecek / çıkarılacak her kayıt (tür + değer) ve her ayarın şimdiki →
yeni değeri. Cihaz yoklamayı duraklatmışken, sunucu cihazı kaldırmışken ya da kopya kartta onay verilemez (ret verilebilir).

### `ztp.profile` (G4.2) — `policy.apply`'ın takma adı

Kayıttan sonra (çoğunlukla ZTP ile kaydolan cihaza) şirket profilini göndermek için. Parametreler, izin listesi, anlamsal
denetim, yerel onay ayarı (cihazdaki «Politika» onayı — ayrı bir ayar yoktur; varsayılan **onay ister**), anlık görüntü, 10 dk
sağlık penceresi ve otomatik geri alma `policy.apply` ile **aynıdır**; cihazda ayrı bir yürütme yolu yoktur. Sonuçlar
`type: "ztp.profile"` ile gelir. Tek ek bölüm:

```json
{ "net_suggestion": { "text": "DHCP Ayarları sihirbazında önerilen havuz 192.168.10.20–200", "tab": "dhcp" } }
```

- `text`: 1–300 karakter düz metin (C0 / C1 denetim karakteri ve yön değiştiren Unicode karakterleri — U+200E/F, U+202A–E,
  U+2066–9 — yok: gösterilen metin saklanandan farklı okunamaz). Panelde **yalnız kart** olarak, düz metin gösterilir (HTML ya da
  bağlantı yorumlanmaz) ve kartta «Uygulanmadı — sihirbazda deneme + Kalıcı yap gerekir» yazar.
- `tab` (isteğe bağlı): kartın bağlantısı, yalnız sabit listeden: `dhcp` (DHCP Ayarları), `roles` (Cihaz Rolleri).
- Cihaz öneriyi **hiçbir zaman uygulamaz**: ağ modu, DHCP, WAN, güvenlik duvarı, panel koruması betiği / komutu çağrılmaz.
  Yalnız `net_suggestion` içeren profil de geçerlidir (sonuç `ok`, değişiklik yok).
- `policy.apply`'da `net_suggestion` → `rejected` (izin verilmeyen bölüm). İzin listesi dışındaki her bölüm (`firewall`,
  `routing`, `network`, `dhcp`, `panel_auth` …) iki türde de `rejected`.

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
| 404/410 | `claim_unknown`, `claim_expired` | Kodla kayıt (§ 5.5) durur, bekleyen anahtar silinir. |
| 403 | `claim_rejected` | Yönetici kodu reddetti: kodla kayıt durur, bekleyen anahtar silinir. |
| 429 / 503 | `rate_limited`, `unavailable` | `Retry-After` kadar bekle (geri çekilmeden kısa değilse). |
| 5xx | — | Üstel geri çekilme. |

## 9. Sürümleme

- Protokol kimliği `klx-fleet/1`: başlıkta (`X-Klx-Proto`) ve her gövdede (`proto`). Geriye uyumsuz değişiklik yeni bir
  ana sürüm (`klx-fleet/2`) ve yeni yol öneki (`/v2/`) gerektirir; sunucu bir süre iki sürümü birlikte sunar.
- `/v1/` içinde geriye uyumlu eklemeler: yeni isteğe bağlı alanlar (cihaz bilmediği yanıt alanlarını yok sayar), yeni uçlar
  (§ 5.5). **Yeni komut türü geriye uyumlu değildir:** eski cihaz onu `rejected` (`type_not_allowed`) ile döndürür.
  `ztp.profile`'ı ZTP ile (`source: "ztp-file"` ya da `/v1/claim-status`) kaydolan cihazlar tanır; panelden kaydolmuş
  cihaza göndermeden önce yoklamadaki `version` / `build` alanına bakın.

## 10. Cihazdaki dosyalar

`/etc/pi5-gateway/fleet/` (0700; yalnız kayıtla oluşur, «Filodan ayrıl» siler): `device.key` (0600, PKCS#8 PEM),
`hw_tag` (0600; açılışta donanım özetiyle karşılaştırılır — uyuşmazsa «yeniden kayıt gerekli», yoklama yapılmaz),
`enroll.json` (0600; ZTP ile kayıtta `source`: `ztp-file` / `code`), `state.json` (0600: `last_seq`, ayarlar, son komutlar,
gönderilecek sonuçlar, `ztp.profile`'ın ağ önerisi kartı), `pending/` (0600 politika anlık görüntüleri), `ztp.done` (0600,
§ 11.1: ZTP dosyasının sonucu — `enrolled` / `rejected` / `superseded`; kayıt anahtarı içermez). Bu klasör yedeğe ve bulut yedeğine **girmez**: cihaz kimliği başka
bir cihaza taşınmaz.

## 11. ZTP — SD kartla ya da kodla kayıt (G4.2)

Kapsam yalnız **kayıt + ağ dışı profil** (`ztp.profile`, § 7). Ağ ayarları, panel parolası / koruması ve cihaz rolü buluttan
gelmez; ağ önerisi yalnız panelde karttır. «Sıfır dokunuş» yalnız önkurulu bir Klyrix imajıyla mümkündür (ayrı proje); bugün
dosya yolu kartı hazırlayan kişinin, kod yolu panelde tek düğmenin işidir.

### 11.1 Dosya: `/boot/firmware/klyrix-ztp.json`

Kartın açılış (FAT) bölümüne, kartı hazırlayan kişi yazar:

```json
{ "v": 1, "base_url": "https://filo.ornek.com", "claim": "<tek kullanımlık kayıt anahtarı>", "site_label": "Şube 12" }
```

- Sıkı şema: yalnız bu dört alan (`site_label` isteğe bağlı, en çok 40 karakter); `v` = 1; `base_url` § 2'deki kurallarla
  (yalnız `https://`, kullanıcı:parola / sorgu / `#` / localhost yok; IP olarak yazılmış ev ağı, Pi'nin kendi ya da ayrılmış
  adresi kabul edilmez — ZTP'de «ev ağına izin ver» seçeneği yoktur); `claim` 8–256 karakter, boşluksuz. Bilinmeyen alan,
  bozuk JSON, 4 KiB'tan büyük dosya, sembolik bağ, birden çok sabit bağı olan ya da normal olmayan dosya → **geçersiz**.
  UTF-8 BOM kabul edilir. Ad olarak yazılmış sunucunun adresi bağlanırken denetlenir: ad ev ağı adresine çözülürse (ör.
  açılışta henüz internete çıkmamış modemin DNS'i) **geçici** hatadır, ad çözümü düzelince kayıt sürer.
- Cihaz dosyayı panel servisinin açılışında, ağ modu ve DHCP denetimlerinden sonra, **yalnız ana cihazda, filo kaydı yokken
  ve HA'da etkin düğümde** okur ve § 5.1 kaydını `source: "ztp-file"` ile yapar. Dosya yoksa hiçbir şey olmaz.
- **Kesin sonuç** — dosyanın üzerine sıfır yazılır, dosya silinir, `ztp.done` yazılır, `fleet` olayı; yeniden denenmez:
  başarılı kayıt; sunucunun kodlu 4xx reddi (ör. `enroll_key_invalid`, `enroll_key_used`, `enroll_key_expired`); geçersiz
  dosya (sembolik bağsa yalnız bağın kendisi silinir, hedefine dokunulmaz; birden çok sabit bağı varsa üzerine yazılmaz, yalnız
  bu ad silinir); cihazın **başka yolla kayıtlı olması** (`superseded`: açılışta kayıtlıyken dosya bulunursa ya da dosya yeniden
  denenmeyi beklerken panelden / kodla kaydolunursa). Son durumda kayıt denenmez, ağ isteği yoktur; dosya kartta kalsaydı
  «Filodan ayrıl» ve yeniden başlatma onunla sessizce yeniden kayda (belki başka bir kiracıya) yol açardı. Dosya
  silinemezse olay ve panel, dosyayı elle silmeyi ve kullanılmamış `claim`'i denetleyicide iptal etmeyi söyler.
- **Geçici hata** — dosya yerinde kalır, üstel geri çekilmeyle (30 sn'den başlayıp en çok 30 dk aralık) yeniden denenir:
  ağ yok / ad çözülemedi / TLS, 5xx, `401`, `408`, `425`, `426`, `429`, kodsuz 4xx (araya giren WAF / vekil sunucu sayfası),
  yönlendirme, geçersiz kayıt yanıtı, beklenmeyen yerel hata, HA yedek düğüm. Saat eşitlenmemişse (NTP) imzalı istek hiç
  gönderilmez; saat yalnız yerelde, 30 sn'den başlayıp en çok 5 dk aralıkla yeniden denetlenir.
- `ztp.done` (0600): sonuç, zaman, sunucu, neden, dosya silindi mi ve dosyanın boyut + değişiklik zamanı (silinemediyse
  sıfırlamadan **sonraki** hâli). Silinemeyen dosya (aynı boyut ve zaman) ya da içeriği tamamen sıfır olan dosya yeniden
  işlenmez (olay yinelenmez); yalnız silme yeniden denenir. Yeni bir dosya işlenir.
- **Uyarı (FAT):** üzerine sıfır yazmak ve silmek, kartın denetleyicisinin eski blokları tutması nedeniyle kesin silmeyi
  garanti etmez. Asıl koruma sunucudadır: `claim` tek kullanımlık ve kısa ömürlü olmalıdır. Kayıttan sonra panelde kiracı
  açıkça görünür; yanlış kiracıya bağlanan cihaz «Filodan ayrıl» ile kopar.
- `claim` değeri yalnız § 5.1 isteğinin gövdesinde gider: günlüğe, olaya, ayar tablosuna, yedeğe, argv / env'e ve API
  yanıtına yazılmaz. Sunucunun hata gövdesi `claim`'i yankılarsa kesilmeden önce maskelenir; hata metni `claim`'den 8+
  karakterlik bir parça bile taşıyorsa gösterilmez (yalnız HTTP durumu ve hata kodu).

### 11.2 Kod: panelde «Filoya kodla kaydol»

Yönetici sunucu adresini girer; cihaz Ed25519 anahtarını **yalnız bellekte** üretir, § 5.5'teki kayıt kodunu (yanında
anahtar parmak izini) gösterir ve
`/v1/claim-status`'ü 15 sn'de bir, en çok 10 dk yoklar. Yönetici kodu bulut konsoluna girince sunucu `claimed` döner ve cihaz
kaydolur (kaynak `code`). Süre dolunca, «İptal» ile ya da panel servisi yeniden başlayınca anahtar ve bekleyen durum yok olur
(diske yazılmamıştır). Aynı anda tek bekleyen kod; kayıt sürerken ya da cihaz kayıtlıyken başlatılamaz.

Her iki yolda da § 10'daki `hw_tag` bağı geçerlidir: kopyalanmış kartta kimlik «yeniden kayıt gerekli» olur, yoklama yapılmaz.

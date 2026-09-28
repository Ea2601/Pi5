<div align="center">

# 🛡️ Klyrix/gate
### Açık Kaynaklı, Yeni Nesil Akıllı Ağ Güvenlik Ağ Geçidi
*Enterprise-Grade Open Source Edge Security & Network Gateway for Raspberry Pi 5*

<p align="center">
  🌐 <b>Diller / Languages:</b>
  <a href="README.md"><b>English</b></a> •
  <a href="README.tr.md"><b>Türkçe</b></a>
</p>

<p align="center">
  <a href="https://github.com/Ea2601/klyrix-gate/releases"><img src="https://img.shields.io/badge/version-2.24.15-38bdf8.svg?style=for-the-badge&logo=git&logoColor=white" alt="Version 2.24.15"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e.svg?style=for-the-badge" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/100%25-Free%20%26%20Open%20Source-ef4444.svg?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="Free & Open Source">
  <img src="https://img.shields.io/badge/Telemetry-Zero-10b981.svg?style=for-the-badge" alt="Zero Telemetry">
  <img src="https://img.shields.io/badge/Hardware-Raspberry%20Pi%205-C51A4A.svg?style=for-the-badge&logo=raspberrypi&logoColor=white" alt="Raspberry Pi 5">
  <img src="https://img.shields.io/badge/OS-Debian%2013%20%7C%20Bookworm-A81D33.svg?style=for-the-badge&logo=debian&logoColor=white" alt="Debian Bookworm">
</p>

<p align="center">
  <b>Klyrix/gate</b>, Raspberry Pi 5 donanımınızı tek satır komutla pahalı kurumsal güvenlik cihazlarına (firewall appliance) taş çıkartan bir ağ geçidine, DPI bypass motoruna, DNS kalkanına ve WireGuard VPN orkestratörüne dönüştürür.
</p>

<p align="center">
  <b>%100 Ücretsiz • Açık Kaynaklı • Aboneliksiz • Yerel ve Gizlilik Odaklı (Self-Hosted)</b>
</p>

<p align="center">
  <a href="#-hızlı-kurulum">🚀 Hızlı Kurulum</a> •
  <a href="#-sistem-mimarisi">🏛️ Mimari</a> •
  <a href="#-temel-özellikler">⚡ Özellikler</a> •
  <a href="#-klyrixgate-vs-geleneksel-çözümler">📊 Karşılaştırma</a> •
  <a href="#-açık-kaynak-topluluğu-ve-katkı">🤝 Topluluk & Katkı</a>
</p>

---

</div>

## 💡 Neden Klyrix/gate?

Ağ güvenliği ve gizliliği bir lüks değil, temel bir haktır. Geleneksel modemler yetersiz güvenlik ve sıfır kontrol sunarken, ticari kurumsal güvenlik duvarları yüksek donanım ve lisans maliyetleri gerektirir.

**Klyrix/gate**, ev kullanıcılarına, laboratuvar meraklılarına (homelab) ve küçük işletmelere kurumsal seviyede ağ egemenliğini **tamamen ücretsiz ve açık kaynaklı** olarak sunar:

- **Sıfır Telemetri & Yerel Egemenlik:** Ağ trafiğiniz, DNS sorgularınız veya cihaz kayıtlarınız asla üçüncü taraf bulutlara gönderilmez. Tüm veriler Pi 5 üzerindeki yerel SQLite veritabanında saklanır.
- **DPI Atlatma Gücü (Zapret):** Servis sağlayıcı seviyesinde uygulanan kısıtlama ve Deep Packet Inspection (DPI) filtrelemelerini çekirdek seviyesinde bypass eder.
- **Hepsi Bir Arada Entegrasyon:** Pi-hole, Unbound DNS, nftables, WireGuard ve modern bir React 19 arayüzü sıfır yapılandırma sürtünmesiyle bir araya gelir.

---

## 📊 Klyrix/gate vs. Geleneksel Çözümler

| Özellik | Standart ISS Modemi | pfSense / OPNsense | Klyrix/gate (Pi 5) |
| :--- | :---: | :---: | :---: |
| **Maliyet** | Ücretsiz (Kiralık) | Yüksek Donanım Maliyeti | **%100 Ücretsiz & FOSS** |
| **Donanım Uyumluluğu** | Kapalı Kutu | x86_64 Sunucu Gerekir | **Raspberry Pi 5 Optimize (ARM64)** |
| **ISP DPI Bypass (Zapret)** | ❌ Desteklemez | ⚠️ Manuel / Çok Zor | **Dahili & Tek Tıkla Aktif** |
| **DNS Reklam & Takip Kalkanı**| ❌ Yok | Eklenti (pfBlockerNG) | **Entegre Pi-hole + Unbound** |
| **Kullanıcı Deneyimi (UI)** | İlkel / Yavaş Web Arayüzü | Karmaşık / Eski PHP Arayüzü | **React 19 + TypeScript (Anlık Veri)** |
| **Yedekli Ağ Geçidi Koruması** | ❌ Yok | Karmaşık Kurallar | **ICMP Redirect Kalkanı Dahili** |
| **Kurulum Süresi** | - | 45-60 Dakika | **~5 Dakika (Tek Komut)** |

---

## 🏛️ Sistem Mimarisi

Klyrix/gate, yerel ağınızdaki istemciler ile internet arasında modern bir koruma kalkanı ve yönlendirme merkezi kurar:

```mermaid
flowchart TD
    subgraph LAN["Yerel Ağ (LAN)"]
        CLIENTS["İstemci Cihazlar (PC, Mobil, IoT)"]
    end

    subgraph GATEWAY["Klyrix/gate (Raspberry Pi 5)"]
        NFT["nftables Güvenlik Duvarı & NAT"]
        PIHOLE["Pi-hole (Reklam & Tehdit Engelleme)"]
        UNBOUND["Unbound (Özyinelemeli Kök DNS)"]
        ZAPRET["Zapret (ISS DPI Atlatma Motoru)"]
        WG["WireGuard (VPN Tüneli & Yönlendirme)"]
        UI["React 19 Kontrol Paneli & Yönetim"]
    end

    subgraph WAN["Dış Ağ (WAN)"]
        MODEM["İnternet Servis Sağlayıcı (Modem/ONT)"]
        INTERNET(("İnternet / Cloud VPS"))
    end

    CLIENTS -->|Varsayılan Ağ Geçidi| NFT
    NFT -->|DNS Sorguları| PIHOLE
    PIHOLE -->|Kök Çözümleme| UNBOUND
    NFT -->|Doğrudan & DPI Trafiği| ZAPRET
    NFT -->|Şifreli VPN Trafiği| WG
    ZAPRET --> MODEM
    WG --> MODEM
    UNBOUND --> MODEM
    MODEM --> INTERNET
    UI -.->|Yönetim & İzleme| NFT
```

---

## ⚡ Temel Özellikler

### 🛡️ 1. Ağ & Siber Güvenlik
- **nftables Çekirdek Güvenlik Duvarı:** Yeniden başlatmalarda kalıcı kural setleri, NAT, port yönlendirme ve modem/ağ bypass girişimlerini engelleyen ICMP redirect koruması.
- **Zapret DPI Bypass:** Servis sağlayıcıların SNI ve TCP paket incelemelerine karşı paket manipülasyonu ile engelleri aşma.
- **Fail2Ban Saldırı Önleme:** SSH ve yönetim paneline yönelik yetkisiz giriş denemelerini algılayarak IP seviyesinde bloklama.

### 🌐 2. DNS Egemenliği & Reklam Engelleme
- **Pi-hole Entegrasyonu:** Ağ seviyesinde reklam, izleyici ve kötü amaçlı yazılım alan adlarını engelleme, canlı sorgu kaydı ve blokliste yönetimi.
- **Unbound Recursive DNS:** Dış DNS sağlayıcılarına (Google, Cloudflare) güvenmek yerine doğrudan DNS kök sunucularıyla şifreli doğrulama.

### 🚀 3. Tünelleme, VPN & Trafik Yönetimi
- **WireGuard VPS Köprüsü:** Tek tıkla VPS tüneli kurma, istemci yapılandırmaları ve mobil cihazlar için anlık QR kod üretimi.
- **Politika Bazlı Yönlendirme (Policy Routing):** Cihaz bazında veya uygulama bazında trafiği yerel internete ya da VPN tüneline dinamik yönlendirme.
- **Dinamik DNS (DDNS):** Cloudflare, DuckDNS ve No-IP entegrasyonu ile değişen IP adresinizi otomatik güncelleme.

### 📊 4. Canlı Ağ Haritası & Gözlemlenebilirlik
- **Ağ Topolojisi & Cihaz Profilleri:** Ağdaki tüm bağlı cihazları otomatik keşfetme, özel isim/grup atama ve tek tıkla ağdan izole etme.
- **Bant Genişliği & Kota Takibi:** Cihaz başına anlık veri tüketimi, hız grafikleri ve kota aşımlarında uyarı mekanizması.
- **Dahili Hız Testi:** Ağ geçidi üzerinden doğrudan internet bağlantı hızını ölçümleme.
- **Ebeveyn Kontrolü:** Belirli cihazlar için zaman kısıtlamaları ve güvenli internet profilleri.

### 💻 5. Sistem & Modern Yönetim Deneyimi
- **React 19 & Tailwind/Slate UI:** Canlı WebSocket metrikleri (CPU sıcaklığı, RAM, disk, ağ yükü), karanlık mod ve akıcı cam efekti (glassmorphism).
- **Web SSH Terminali:** Pi 5'e fiziksel klavye/ekran bağlamadan tarayıcı üzerinden güvenli komut satırı erişimi ve hazır operasyon scriptleri.

---

## 🚀 Hızlı Kurulum

### Tek Komutla Otomatik Kurulum (Raspberry Pi 5 üzerinde)

Raspberry Pi OS (Bookworm / Debian 13) kurulu cihazınızda terminali açın ve çalıştırın:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Ea2601/klyrix-gate/main/install.sh)"
```

*Script gerekli bağımlılıkları (Node.js, Pi-hole, nftables, WireGuard vb.) otomatik olarak kurar, servisleri yapılandırır ve paneli ayağa kaldırır.*

### Alternatif: Git ile Kurulum

```bash
git clone https://github.com/Ea2601/klyrix-gate.git
cd klyrix-gate
sudo chmod +x install.sh
sudo ./install.sh
```

---

## 🛠️ Yerel Geliştirme (Local Development)

Projeye katkı sağlamak veya arayüzü geliştirmek istiyorsanız:

```bash
# Depoyu klonlayın
git clone https://github.com/Ea2601/klyrix-gate.git
cd klyrix-gate

# 1. Backend API Servisini Başlatın
cd backend
npm install
npm run dev

# 2. Frontend Uygulamasını Başlatın (Ayrı bir terminalde)
cd ../frontend
npm install
npm run dev
```

- **Frontend:** `http://localhost:3000`
- **Backend API:** `http://localhost:3001`

---

## 🔒 Gizlilik ve Güvenlik Taahhüdü

Klyrix/gate, açık kaynak felsefesinin en saf halini benimser:

1. **Hiçbir İzleme / Telemetri Yok:** Yazılım içinde kullanım analitiği, kaza raporlama (crash report) veya harici izleme kütüphaneleri bulunmaz.
2. **Yerel Veri Saklama:** İstemci listeleri, ağ kuralları ve istatistikler yalnızca cihazınızdaki SQLite dosyasında yerel olarak barındırılır.
3. **Şeffaf Kod Tabanı:** Çalıştırılan tüm servisler, ağ kuralları ve yönlendirme scriptleri deponun [scripts/](scripts/) ve [backend/](backend/) dizinlerinde incelenebilir.

---

## 🤝 Açık Kaynak Topluluğu ve Katkı

Klyrix/gate toplulukla büyüyen özgür bir projedir. Her türlü katkıya açığız!

- **⭐ Projeye Yıldız Verin:** Projeyi beğeniyorsanız GitHub üzerinden bir yıldız vererek daha fazla kişiye ulaşmasını sağlayabilirsiniz.
- **🐛 Hata Bildirimi (Bug Report):** Karşılaştığınız sorunları veya sistem uyumsuzluklarını [GitHub Issues](https://github.com/Ea2601/klyrix-gate/issues) üzerinden bize iletin.
- **💡 Yeni Özellik Önerisi:** Görmek istediğiniz özellikleri tartışmalarda paylaşın.
- **🔀 Pull Request:** Yeni bir özellik veya hata düzeltmesi geliştirdiyseniz çekinmeden PR gönderin!

---

## 🙏 Açık Kaynak Ekosistemi & Teşekkürler (Upstream Credits)

Klyrix/gate, açık kaynak dünyasının kanıtlanmış, saygın ve güçlü yazılımları üzerine inşa edilmiş bir orkestrasyon ve yönetim platformudur. Bu temel teknolojileri geliştiren ve topluluğa kazandıran tüm geliştiricilere minnettarız:

| Proje | Klyrix/gate İçindeki Görevi | Lisans | Resmi Bağlantı |
| :--- | :--- | :---: | :--- |
| **Pi-hole®** | DNS seviyesinde reklam, izleyici ve tehdit engelleme | EUPL v1.2 | [pi-hole.net](https://pi-hole.net) |
| **Unbound** | Doğrudan kök sunuculardan özyinelemeli & şifreli DNS çözümleme | BSD 3-Clause | [nlnetlabs.nl](https://nlnetlabs.nl/projects/unbound) |
| **Zapret** | Çekirdek seviyesinde ISS DPI ve SNI paket manipülasyon motoru | MIT / GPL | [bol-van/zapret](https://github.com/bol-van/zapret) |
| **WireGuard®** | Yeni nesil hızlı ve güvenli VPN tünelleme | GPLv2 | [wireguard.com](https://www.wireguard.com) |
| **nftables** | Linux çekirdeği L3/L4 paket filtreleme, NAT ve yönlendirme | GPLv2 | [netfilter.org](https://netfilter.org/projects/nftables) |
| **Fail2Ban** | Yetkisiz giriş ve brute-force denemelerini otomatik bloklama | GPLv2 | [fail2ban.org](https://www.fail2ban.org) |

### ⚖️ Yasal Bildirimler ve Ticari Markalar
- **Pi-hole®**, Pi-hole LLC'nin tescilli ticari markasıdır. Klyrix/gate bağımsız bir entegrasyon olup Pi-hole LLC ile doğrudan bir ortaklığı veya sponsorluğu bulunmamaktadır.
- **WireGuard®** ve WireGuard logosu Jason A. Donenfeld'in tescilli ticari markalarıdır. Klyrix/gate bağımsız bir proje olup Jason A. Donenfeld tarafından onaylanmamış veya finanse edilmemiştir.
- **Raspberry Pi®**, Raspberry Pi Ltd.'nin tescilli ticari markasıdır.
- Belirtilen diğer tüm ticari markalar ve tescilli isimler ilgili hak sahiplerinin mülkiyetindedir.

---

## 📄 Lisans

Bu proje **[MIT Lisansı](LICENSE)** altında lisanslanmıştır. Tamamen ücretsizdir; kişisel, ticari veya kurumsal amaçlarla özgürce kullanılabilir, değiştirilebilir ve dağıtılabilir.

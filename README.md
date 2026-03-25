# Pi5 Secure Gateway

Raspberry Pi 5 uzerinde calisan kapsamli ag guvenligi ve yonetim paneli.

## Ozellikler

- **Dashboard** — Gercek zamanli CPU, bellek, disk, ag grafikleri
- **Ag Haritasi** — Mesh topoloji, cihaz profilleri
- **Pi-hole DNS** — Reklam engelleme, DNS ayarlari, blokliste yonetimi
- **Unbound DNS** — Ozyinelemeli DNS cozucu
- **Zapret DPI** — ISP DPI bypass motoru
- **nftables Firewall** — Paket filtreleme, NAT
- **WireGuard VPN** — VPS tunel yonetimi, client olusturma, QR kodu
- **Fail2Ban** — Brute-force korumasi
- **DDNS** — Dinamik IP takibi (DuckDNS, No-IP, Cloudflare)
- **Trafik Yonlendirme** — Uygulama bazli routing, cihaz bazli kurallar
- **Bant Genisligi** — Canli izleme, kota yonetimi
- **Hiz Testi** — Tek tikla speed test
- **Ebeveyn Kontrol** — Zaman kisitlama, kategori engelleme
- **Cihaz Yonetimi** — Gruplar, engelleme, bilinmeyen cihaz alarmi
- **SSH Terminal** — Web tabanli terminal, hazir komutlar
- **Cron Gorevleri** — Zamanlanmis bakim islemleri
- **Dokumantasyon** — Teknik klavuz ve SSS

## Hizli Kurulum (Pi5 uzerinde)

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/Ea2601/Pi5/main/install.sh)"
```

veya:

```bash
git clone https://github.com/Ea2601/Pi5.git
cd Pi5
sudo chmod +x install.sh
sudo ./install.sh
```

## Gelistirme

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend (ayri terminalde)
cd frontend && npm install && npm run dev
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## Teknolojiler

- **Frontend:** React 19 + Vite 8 + TypeScript
- **Backend:** Express 5 + TypeScript + SQLite
- **Guvenlik:** Helmet, rate-limiting, input sanitization

# RPi5 Network — Antigravity / Claude Code Skill

> Raspberry Pi 5 (Debian Bookworm 64-bit) üzerinde ağ altyapısı, gizlilik ve güvenlik araçlarının kurulumu, yapılandırması ve yönetimi için kapsamlı referans ve otomasyon kaynağı.

---

## ÇALIŞMA PRENSİBİ

Bu skill Claude Code (Antigravity) ortamında şu akışla çalışır:

1. Kullanıcı isteğini al → aşağıdaki modül haritasından ilgili bölümü bul
2. Script üret (bash) veya config dosyası oluştur
3. SSH ile Pi'ye deploy et veya kullanıcıya sun
4. Kurulumu doğrula

Tüm script'ler **idempotent** olmalı (tekrar çalıştırılabilir, mevcut kurulumu bozmaz), **fonksiyon bazlı** yapıda ve **değişken bloğu üstte** olmalı.

---

## MODÜL HARİTASI

| İstek Anahtar Kelimeleri | Bölüm |
|--------------------------|-------|
| wireguard, vpn, pivpn, wg | [WireGuard VPN](#wireguard-vpn) |
| pi-hole, pihole, reklam, adblock | [Pi-hole](#pi-hole) |
| unbound, recursive dns | [Unbound DNS](#unbound-recursive-dns) |
| cloudflared, doh, dns-over-https | [Cloudflared DoH](#cloudflared-dns-over-https) |
| zapret, dpi, bypass, engel aşma | [Zapret DPI Bypass](#zapret-dpi-bypass) |
| firewall, iptables, nftables, ufw | [Firewall](#firewall) |
| gateway, router, nat, routing | [Gateway/Router](#gatewayrouter-yapilandirmasi) |
| tailscale, mesh vpn | [Tailscale](#tailscale-mesh-vpn) |
| tor, proxy, socks | [Tor Proxy](#tor-proxy) |
| cloudflare tunnel | [Cloudflare Tunnel](#cloudflare-tunnel) |
| ntopng, izleme, monitor | [Ağ İzleme](#ag-izleme) |
| fail2ban, brute force | [Fail2Ban](#fail2ban) |
| bakım, maintenance | [Bakım](#bakim) |
| toplu kurulum, full setup | [Full Setup Script](#full-setup-script) |

---

## SCRİPT ÜRETİM KURALLARI

Claude Code script üretirken bu şablona MUTLAKA uymalı:

```bash
#!/usr/bin/env bash
# ============================================================
# RPi5 Network — <MODÜL ADI>
# Hedef: Raspberry Pi 5 / Debian Bookworm 64-bit
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1" >&2; }

[[ $EUID -ne 0 ]] && { err "Root olarak çalıştırın: sudo bash $0"; exit 1; }

# ============ YAPILANDIRMA ============
# Kullanıcıya göre düzenle
PI_IP="192.168.1.100"
PI_IFACE="eth0"
# ======================================

install_deps()    { ... }
configure()       { ... }
setup_service()   { ... }
verify_install()  {
    systemctl is-active --quiet <service> && log "<Service> çalışıyor" || err "<Service> başlatılamadı!"
}

main() {
    log "=== Kurulum Başlıyor ==="
    install_deps
    configure
    setup_service
    verify_install
    log "=== Kurulum Tamamlandı ==="
}
main "$@"
```

Her script'te: idempotent kontrol (`command -v ... &>/dev/null`), root kontrolü, renk/log fonksiyonları, doğrulama adımı.

---

## ENV DEĞİŞKENLERİ ŞABLONU

Tüm modüller bu değişkenleri kullanır. Claude Code kullanıcıya göre doldurur.

```bash
# ============================================================
# RPi5 Network — Master Environment Variables
# ============================================================

# --- Pi Temel ---
PI_HOST="192.168.1.100"
PI_USER="pi"
PI_PORT="22"
PI_IFACE="eth0"
PI_WIFI_IFACE="wlan0"
PI_SUBNET="192.168.1.0/24"
PI_GATEWAY="192.168.1.1"
TIMEZONE="Europe/Istanbul"

# --- Pi-hole ---
PIHOLE_ENABLED="yes"
PIHOLE_PASS="changeme123"
PIHOLE_DNS_UPSTREAM="127.0.0.1#5335"   # Unbound varsa

# --- Unbound ---
UNBOUND_ENABLED="yes"
UNBOUND_PORT="5335"

# --- WireGuard ---
WG_ENABLED="yes"
WG_PORT="51820"
WG_SUBNET="10.0.0.0/24"
WG_SERVER_IP="10.0.0.1"
WG_DNS="${WG_SERVER_IP}"
WG_CLIENTS="phone,laptop,tablet"
WG_ENDPOINT=""                         # Boş=otomatik tespit

# --- DuckDNS ---
DUCKDNS_ENABLED="no"
DUCKDNS_SUBDOMAIN=""
DUCKDNS_TOKEN=""

# --- Zapret ---
ZAPRET_ENABLED="no"
ZAPRET_TEST_DOMAIN="discord.com"
ZAPRET_NFQWS_OPT=""                    # blockcheck sonucu

# --- Tailscale ---
TAILSCALE_ENABLED="no"
TAILSCALE_EXIT_NODE="no"
TAILSCALE_ADVERTISE_ROUTES=""

# --- Tor ---
TOR_ENABLED="no"
TOR_SOCKS_PORT="9050"
TOR_ALLOW_SUBNET="${PI_SUBNET}"

# --- Cloudflare Tunnel ---
CFTUNNEL_ENABLED="no"
CFTUNNEL_NAME="pi-tunnel"
CFTUNNEL_HOSTNAME=""

# --- Cloudflared DoH ---
CLOUDFLARED_ENABLED="no"
CLOUDFLARED_PORT="5053"

# --- Firewall ---
FIREWALL_ENABLED="yes"
FIREWALL_TYPE="ufw"

# --- Gateway ---
GATEWAY_ENABLED="no"
GATEWAY_LAN_IP="10.10.0.1"
GATEWAY_LAN_SUBNET="10.10.0.0/24"
GATEWAY_DHCP_RANGE_START="10.10.0.50"
GATEWAY_DHCP_RANGE_END="10.10.0.250"

# --- Monitoring ---
NTOPNG_ENABLED="no"
VNSTAT_ENABLED="yes"
FAIL2BAN_ENABLED="yes"
FAIL2BAN_BANTIME="3600"
FAIL2BAN_SSH_MAXRETRY="3"

# --- SSH ---
SSH_HARDEN="yes"
SSH_DISABLE_ROOT="yes"
SSH_DISABLE_PASSWORD="no"
SSH_PORT="22"
```

---

## SSH DEPLOY HELPER

Pi'ye dosya göndermek ve uzaktan komut çalıştırmak için:

```bash
#!/usr/bin/env bash
set -euo pipefail
PI_HOST="${PI_HOST:-192.168.1.100}"
PI_USER="${PI_USER:-pi}"
PI_PORT="${PI_PORT:-22}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
SSH_CMD="ssh ${SSH_OPTS} -p ${PI_PORT} ${PI_USER}@${PI_HOST}"
SCP_CMD="scp ${SSH_OPTS} -P ${PI_PORT}"

case "${1:-help}" in
    test)
        $SSH_CMD "echo 'OK' && uname -a && hostname -I" ;;
    push)
        $SCP_CMD "$2" "${PI_USER}@${PI_HOST}:${3:-/tmp/$(basename "$2")}" ;;
    exec)
        shift; $SSH_CMD "$@" ;;
    push-exec)
        shift; local_script="$1"; shift
        $SCP_CMD "$local_script" "${PI_USER}@${PI_HOST}:/tmp/$(basename "$local_script")"
        $SSH_CMD "chmod +x /tmp/$(basename "$local_script") && sudo bash /tmp/$(basename "$local_script") $*" ;;
    status)
        $SSH_CMD 'bash -s' << 'EOF'
for svc in pihole-FTL unbound "wg-quick@wg0" fail2ban zapret tailscaled tor ntopng; do
    systemctl is-active --quiet "$svc" 2>/dev/null && echo "[✓] ${svc}" || true
done
echo ""; df -h / | tail -1; echo ""; free -h | awk 'NR==2{print}'; echo ""; ss -tunlp 2>/dev/null | grep LISTEN
EOF
        ;;
esac
```

---

## SENARYO BAZLI KURULUM SIRALARI

### Senaryo A — Gizlilik Kalesi
```
İnternet ← Router ← [Pi-hole + Unbound + WireGuard] ← Ev Cihazları
Sıra: Pi-hole → Unbound → WireGuard → Firewall → Fail2Ban → Router DNS=Pi
```

### Senaryo B — DPI Bypass Gateway
```
İnternet ← [Zapret + Pi-hole] ← Router ← Cihazlar
Sıra: Gateway NAT → Pi-hole → Zapret → Firewall → Fail2Ban
```

### Senaryo C — Uzaktan Erişim + Reklam Engelleme
```
Uzak Cihaz → Tailscale → [Pi-hole + Unbound] ← Ev Ağı
Sıra: Pi-hole → Unbound → Tailscale (exit node) → Fail2Ban
```

### Senaryo D — Full Stack
```
Gateway → Pi-hole → Unbound → WireGuard → Zapret → Tailscale → Firewall → Fail2Ban → Monitoring → Bakım cron
```

---

## PORT REFERANSI

| Servis | Port | Protokol | UFW |
|--------|------|----------|-----|
| SSH | 22 | TCP | `ufw allow 22/tcp` |
| DNS | 53 | TCP+UDP | `ufw allow 53` |
| Pi-hole Web | 80 | TCP | `ufw allow 80/tcp` |
| WireGuard | 51820 | UDP | `ufw allow 51820/udp` |
| Unbound | 5335 | loopback | — |
| Cloudflared | 5053 | loopback | — |
| ntopng | 3000 | TCP | `ufw allow 3000/tcp` |
| Tor SOCKS | 9050 | TCP | subnet bazlı |
| Tailscale | 41641 | UDP | otomatik |

---

## HIZLI SORUN GİDERME

```bash
# Servis durumu
sudo systemctl status pihole-FTL unbound wg-quick@wg0 fail2ban zapret

# DNS testleri
dig google.com @127.0.0.1 -p 5335    # Unbound
dig google.com @127.0.0.1 -p 5053    # Cloudflared
dig google.com @127.0.0.1            # Pi-hole

# WireGuard
sudo wg show

# Ağ
ip addr show && ip route show

# Firewall
sudo iptables -L -n -v
sudo nft list ruleset
sudo ufw status verbose

# Port
sudo ss -tunelp

# Log
sudo journalctl -u <service> --no-pager -n 50
```

---
---

# MODÜL DETAYLARI

---

## WireGuard VPN

### PiVPN ile Otomatik Kurulum (Önerilen)

```bash
sudo apt update && sudo apt upgrade -y
curl -L https://install.pivpn.io | bash
```

Kurulumda: WireGuard seç → Port 51820 → DNS: Pi IP (Pi-hole varsa) veya 1.1.1.1 → Public IP veya DuckDNS.

PiVPN komutları:
```bash
pivpn add          # Yeni client
pivpn -c           # Bağlı client'lar
pivpn -l           # Tüm profiller
pivpn -qr          # QR kodu (mobil)
pivpn revoke       # Client kaldır
pivpn -d           # Debug
```

### Manuel Kurulum

```bash
sudo apt install -y wireguard wireguard-tools

# Key üretimi
wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key
chmod 600 /etc/wireguard/server_private.key
```

Server config (`/etc/wireguard/wg0.conf`):
```ini
[Interface]
PrivateKey = <SERVER_PRIVATE_KEY>
Address = 10.0.0.1/24
ListenPort = 51820
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

[Peer]
PublicKey = <CLIENT_PUBLIC_KEY>
PresharedKey = <PRESHARED_KEY>
AllowedIPs = 10.0.0.2/32
```

```bash
# IP forwarding
echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.d/99-wireguard.conf
sudo sysctl -p /etc/sysctl.d/99-wireguard.conf

# Başlat
sudo systemctl enable wg-quick@wg0
sudo systemctl start wg-quick@wg0
```

### Client Config

```bash
wg genkey | tee client1_private.key | wg pubkey > client1_public.key
wg genpsk > client1_preshared.key
```

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY>
Address = 10.0.0.2/24
DNS = 10.0.0.1

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
PresharedKey = <PRESHARED_KEY>
Endpoint = <PUBLIC_IP_VEYA_DUCKDNS>:51820
AllowedIPs = 0.0.0.0/0, ::/0      # Full tunnel
PersistentKeepalive = 25
```

Split tunnel: `AllowedIPs = 10.0.0.0/24, 192.168.1.0/24`

QR kodu: `sudo apt install -y qrencode && qrencode -t ansiutf8 < client1.conf`

Router port forwarding: UDP 51820 → Pi IP

### DuckDNS (Dinamik DNS)

```bash
mkdir ~/duckdns && cd ~/duckdns
cat > duck.sh << 'EOF'
#!/bin/bash
echo url="https://www.duckdns.org/update?domains=SUBDOMAIN&token=TOKEN&ip=" | curl -k -o ~/duckdns/duck.log -K -
EOF
chmod +x duck.sh
./duck.sh && cat duck.log  # "OK" dönmeli
(crontab -l 2>/dev/null; echo "*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1") | crontab -
```

Client Endpoint: `your-subdomain.duckdns.org:51820`

### WireGuard Sorun Giderme

```bash
sudo wg show
sudo systemctl status wg-quick@wg0
sudo journalctl -u wg-quick@wg0 -f
sudo ss -tunelp | grep 51820
sudo iptables -L FORWARD -n -v
sudo iptables -t nat -L POSTROUTING -n -v
curl -s https://ipinfo.io/ip
```

**Handshake olmuyor:** Router port forwarding, firewall, client endpoint, key eşleşmesi kontrol et.
**İnternet yok:** `cat /proc/sys/net/ipv4/ip_forward` → 1 olmalı. PostUp kuralları, client DNS kontrol et.
**Yavaş:** Interface'e `MTU = 1420` ekle.

---

## Pi-hole

### Kurulum

```bash
sudo apt update && sudo apt upgrade -y
curl -sSL https://install.pi-hole.net | bash
```

Seçimler: Upstream DNS → Unbound varsa Custom sonra ayarla, yoksa Cloudflare. Web interface, query logging evet.

```bash
pihole -a -p       # Admin şifre değiştir
# Web: http://<PI_IP>/admin
```

### Komut Satırı

```bash
pihole status
pihole enable / pihole disable 300
pihole -up              # Güncelle
pihole -g               # Gravity (blocklist) güncelle
pihole -t               # Canlı log
pihole -c               # Konsol dashboard
pihole restartdns
pihole -q example.com   # Domain sorgula
pihole -w example.com   # Whitelist
pihole -b example.com   # Blacklist
```

### Router DNS Ayarı

Router admin → DHCP/DNS ayarları → Primary DNS: Pi IP → Secondary DNS: BOŞ → Kaydet → Router restart.

Router DNS değiştirmeye izin vermiyorsa → Pi-hole DHCP server modunu aç (Settings → DHCP), router'da DHCP kapat.

### Popüler Blocklist'ler

Pi-hole Web → Adlists → URL ekle:
```
https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts
https://big.oisd.nl
https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Alternate%20versions%20Anti-Malware%20List/AntiMalwareHosts.txt
```
Sonra: `pihole -g`

### Pi-hole + WireGuard

Client config'de `DNS = 10.0.0.1` (Pi VPN IP'si). Pi-hole'da Settings → DNS → Interface → "Listen on all interfaces, permit all origins".

### Docker ile Pi-hole v6

```yaml
services:
  pihole:
    image: pihole/pihole:latest
    container_name: pihole
    restart: unless-stopped
    network_mode: host
    environment:
      - TZ=Europe/Istanbul
      - FTLCONF_webserver_api_password=SIFREN
      - FTLCONF_LOCAL_IPV4=192.168.1.100
      - FTLCONF_dns_upstreams=127.0.0.1#5335
    volumes:
      - ./etc-pihole:/etc/pihole
      - ./etc-dnsmasq.d:/etc/dnsmasq.d
    cap_add:
      - NET_ADMIN
```

Port 53 çakışması: `sudo systemctl disable systemd-resolved && sudo systemctl stop systemd-resolved`

### Pi-hole Sorun Giderme

```bash
sudo systemctl status pihole-FTL
dig google.com @127.0.0.1
sudo ss -tunelp | grep :53
pihole -t
pihole -g
```

**DNS çözümlenmiyor:** `sudo systemctl restart pihole-FTL`, upstream erişim kontrol, port 53 başka servis var mı.
**Web açılmıyor:** lighttpd/pihole-FTL servisi, firewall port 80.
**Site bozuluyor:** `pihole -w domain.com`, query log'dan engellenen domain'i bul.

---

## Unbound Recursive DNS

Kendi recursive DNS sunucun — üçüncü parti DNS'e bağımlılık yok.

### Kurulum

```bash
sudo apt install -y unbound

# Root hints (6 ayda bir güncelle)
wget -O root.hints https://www.internic.net/domain/named.root
sudo mv root.hints /var/lib/unbound/
```

### Yapılandırma

`sudo nano /etc/unbound/unbound.conf.d/pi-hole.conf`:

```yaml
server:
    verbosity: 0
    interface: 127.0.0.1
    port: 5335
    do-ip4: yes
    do-udp: yes
    do-tcp: yes
    do-ip6: no
    prefer-ip6: no
    root-hints: "/var/lib/unbound/root.hints"
    harden-glue: yes
    harden-dnssec-stripped: yes
    harden-large-queries: yes
    harden-algo-downgrade: yes
    hide-identity: yes
    hide-version: yes
    qname-minimisation: yes
    use-caps-for-id: no
    edns-buffer-size: 1472
    prefetch: yes
    num-threads: 1
    so-rcvbuf: 1m
    serve-expired: yes
    cache-min-ttl: 300
    cache-max-ttl: 86400
    deny-any: yes
    minimal-responses: yes
    private-address: 192.168.0.0/16
    private-address: 169.254.0.0/16
    private-address: 172.16.0.0/12
    private-address: 10.0.0.0/8
    private-address: fd00::/8
    private-address: fe80::/10
```

```bash
# Bookworm resolvconf fix
sudo sed -i 's/^unbound_conf=/#unbound_conf=/' /etc/resolvconf.conf 2>/dev/null || true

sudo systemctl restart unbound && sudo systemctl enable unbound

# Test
dig pi-hole.net @127.0.0.1 -p 5335
```

### DNSSEC Test

```bash
dig sigfail.verteiltesysteme.net @127.0.0.1 -p 5335   # → SERVFAIL, IP yok
dig sigok.verteiltesysteme.net @127.0.0.1 -p 5335     # → NOERROR, IP + "ad" flag
```

### Pi-hole + Unbound

Pi-hole Web → Settings → DNS → Tüm upstream'leri kaldır → Custom 1: `127.0.0.1#5335` → DNSSEC kutusunu KALDIR (Unbound yapıyor) → Save.

### Root Hints Otomatik Güncelleme

```bash
cat > ~/update-root-hints.sh << 'EOF'
#!/bin/bash
wget -qO /tmp/root.hints https://www.internic.net/domain/named.root
if [ -s /tmp/root.hints ]; then
    sudo mv /tmp/root.hints /var/lib/unbound/root.hints
    sudo systemctl restart unbound
fi
EOF
chmod +x ~/update-root-hints.sh
(crontab -l 2>/dev/null; echo "0 3 1 1,7 * ~/update-root-hints.sh") | crontab -
```

---

## Cloudflared DNS-over-HTTPS

⚠️ Cloudflare `proxy-dns` Şubat 2026'da deprecated oldu. **Yeni kurulumlar için Unbound önerilir.**

### Kurulum (ARM64)

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared
sudo useradd -s /usr/sbin/nologin -r -M cloudflared
```

`sudo nano /etc/default/cloudflared`:
```bash
CLOUDFLARED_OPTS=--port 5053 --upstream https://1.1.1.1/dns-query --upstream https://1.0.0.1/dns-query
```

```bash
sudo chown cloudflared:cloudflared /etc/default/cloudflared /usr/local/bin/cloudflared
```

`sudo nano /etc/systemd/system/cloudflared.service`:
```ini
[Unit]
Description=cloudflared DNS over HTTPS proxy
After=syslog.target network-online.target
[Service]
Type=simple
User=cloudflared
EnvironmentFile=/etc/default/cloudflared
ExecStart=/usr/local/bin/cloudflared proxy-dns $CLOUDFLARED_OPTS
Restart=on-failure
RestartSec=10
KillMode=process
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable cloudflared && sudo systemctl start cloudflared
dig @127.0.0.1 -p 5053 google.com   # Test
```

Pi-hole ile: Settings → DNS → Custom 1: `127.0.0.1#5053`

### Unbound vs Cloudflared

| | Unbound | Cloudflared |
|--|---------|-------------|
| Gizlilik | Hiçbir 3. parti yok | Cloudflare'e güvenir |
| ISP görünürlük | Root DNS sorgularını görebilir | Göremez (HTTPS) |
| DNSSEC | Yerleşik | Cloudflare yapar |
| Bağımlılık | Yok | Cloudflare servisi |
| Durum | ✅ Aktif | ⚠️ Deprecated |

---

## Zapret DPI Bypass

Standalone DPI atlatma aracı — VPN gerektirmez. ISP'nin DPI sistemi HTTP/TLS trafiğindeki SNI, Host header vb. alanları okuyarak engelliyorsa, zapret paketleri manipüle ederek DPI'ı yanıltır.

Araçlar: **nfqws** (ana — netfilter queue), **tpws** (transparent proxy), **blockcheck.sh** (strateji tespiti).

Stratejiler: fakeddisorder, split, disorder, fake, TTL tabanlı, md5sig.

### Kurulum

```bash
sudo apt install -y bind9-dnsutils curl nftables wget git unzip

cd /tmp
git clone --depth=1 https://github.com/bol-van/zapret.git
cd zapret
sudo ./install_prereq.sh
sudo ./install_bin.sh
```

### Blockcheck (Strateji Tespiti) — ÖNEMLİ

```bash
sudo ./blockcheck.sh
```

Sorular: domain → engelli site yaz (ör: `discord.com`), IP version → 4, mod → standard.

**Sonuçtaki NFQWS parametrelerini kopyala.** Örnek:
```
nfqws --dpi-desync=fakeddisorder --dpi-desync-ttl=1 --dpi-desync-autottl=-5 --dpi-desync-split-pos=1
```

### Ana Kurulum

```bash
sudo ./install_easy.sh
```

Cevaplar: copy → Y, firewall → nftables, ipv6 → N, offloading → none, filtering → none, **nfqws → Y** (önemli!), tpws socks → N.

Config düzenleme ekranında `NFQWS_OPT` satırını blockcheck sonucuyla değiştir:

```bash
sudo nano /opt/zapret/config
# Bul ve değiştir:
NFQWS_OPT="--dpi-desync=fakeddisorder --dpi-desync-ttl=1 --dpi-desync-autottl=-5 --dpi-desync-split-pos=1"
```

LAN/WAN: NONE / ANY (router değilse).

### DNS Yapılandırması (ZORUNLU)

Zapret DNS çözmez! ISP DNS poisoning kullanıyorsa ayrıca DNS değiştir:

**systemd-resolved ile DoT:**
```bash
sudo nano /etc/systemd/resolved.conf
```
```ini
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 1.0.0.1#cloudflare-dns.com
DNSOverTLS=yes
DNSSEC=yes
```
`sudo systemctl restart systemd-resolved`

Veya Pi-hole+Unbound zaten kuruluysa ek adım gerekmez.

### Servis Yönetimi

```bash
sudo systemctl status/start/stop/restart/enable/disable zapret
```

### Gateway Modu (Tüm Ağ İçin)

Kurulumda LAN: eth0, WAN: wlan0 seç. Pi'yi gateway olarak yapılandır (Gateway bölümüne bak).

### Kaldırma

```bash
sudo /opt/zapret/uninstall_easy.sh
sudo rm -rf /opt/zapret
```

### Zapret Sorun Giderme

```bash
sudo systemctl status zapret
sudo journalctl -u zapret -f
ps aux | grep nfqws
sudo nft list ruleset | grep -i nfqueue
curl -v https://discord.com 2>&1 | head -20
nslookup discord.com 1.1.1.1          # DNS poisoning kontrolü
```

**Site hala açılmıyor:** DNS değiştir, blockcheck'i `force` modunda çalıştır, UDP 443 kontrol et.
**Servis başlamıyor:** Firewall tipi (iptables vs nftables), binary kontrol (`ls /opt/zapret/nfq/`).
**Bazı siteler bozuluyor:** hostlist filtreleme kullan, `/opt/zapret/ipset/zapret-hosts-user.txt` düzenle.

---

## Firewall

### iptables vs nftables vs UFW

Bookworm'da iptables komutu arka planda nftables kullanır (iptables-nft uyumluluk katmanı). Her iki syntax çalışır. Basit kullanım için UFW önerilir.

### UFW

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh                     # KENDİNİ KİLİTLEMEMEK İÇİN ÖNCE BU!
sudo ufw enable

# Port bazlı
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 53
sudo ufw allow 51820/udp
sudo ufw allow 3000/tcp

# IP bazlı
sudo ufw allow from 192.168.1.0/24 to any port 22

# Kural silme
sudo ufw status numbered && sudo ufw delete <numara>

# Durum
sudo ufw status verbose
```

### iptables Temel Kurallar

```bash
# Loopback
sudo iptables -A INPUT -i lo -j ACCEPT
# Kurulu bağlantılar
sudo iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# SSH
sudo iptables -A INPUT -p tcp --dport 22 -j ACCEPT
# DNS
sudo iptables -A INPUT -p tcp --dport 53 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 53 -j ACCEPT
# HTTP
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
# WireGuard
sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT
# Ping
sudo iptables -A INPUT -p icmp -m icmp --icmp-type 8 -j ACCEPT
# Reddet
sudo iptables -A INPUT -j DROP
sudo iptables -A FORWARD -j DROP
```

NAT:
```bash
sudo iptables -A FORWARD -i eth0 -o wlan0 -j ACCEPT
sudo iptables -A FORWARD -i wlan0 -o eth0 -m state --state RELATED,ESTABLISHED -j ACCEPT
sudo iptables -t nat -A POSTROUTING -o wlan0 -j MASQUERADE
```

### nftables Yapılandırma

`sudo nano /etc/nftables.conf`:
```
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;
        iif lo accept
        ct state established,related accept
        ct state invalid drop
        ip protocol icmp accept
        tcp dport 22 accept
        tcp dport 53 accept
        udp dport 53 accept
        tcp dport 80 accept
        udp dport 51820 accept
        tcp dport 3000 accept
        drop
    }
    chain forward {
        type filter hook forward priority 0; policy drop;
        iifname "wg0" accept
        oifname "wg0" accept
        iifname "eth0" oifname "wlan0" accept
        iifname "wlan0" oifname "eth0" ct state related,established accept
    }
    chain output {
        type filter hook output priority 0; policy accept;
    }
}
table ip nat {
    chain postrouting {
        type nat hook postrouting priority 100;
        oifname "wlan0" masquerade
        oifname "eth0" masquerade
    }
}
```

```bash
sudo nft -f /etc/nftables.conf && sudo systemctl enable nftables
```

### Kuralları Kalıcı Yapma

```bash
# iptables
sudo apt install -y iptables-persistent
sudo netfilter-persistent save

# nftables → /etc/nftables.conf zaten kalıcı, systemctl enable nftables yeterli
```

### Güvenlik İpuçları

```bash
# SSH rate limiting
sudo iptables -A INPUT -p tcp --dport 22 -m state --state NEW -m recent --set
sudo iptables -A INPUT -p tcp --dport 22 -m state --state NEW -m recent --update --seconds 60 --hitcount 4 -j DROP

# SYN flood koruması
sudo iptables -A INPUT -p tcp --syn -m limit --limit 1/s --limit-burst 3 -j ACCEPT
```

---

## Gateway/Router Yapılandırması

Pi'yi ağ geçidi olarak kullan: eth0 (LAN) ↔ wlan0 (İnternet).

```
[İnternet] ←WiFi→ [Pi wlan0: 192.168.1.100] ←Ethernet→ [Pi eth0: 10.10.0.1] ←Switch→ [Cihazlar]
```

### Adımlar

```bash
# 1. IP forwarding
echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-gateway.conf
sudo sysctl -p /etc/sysctl.d/99-gateway.conf

# 2. Statik IP (eth0)
sudo nano /etc/dhcpcd.conf
# interface eth0
# static ip_address=10.10.0.1/24
# nogateway

# 3. NAT
sudo iptables -t nat -A POSTROUTING -o wlan0 -j MASQUERADE
sudo iptables -A FORWARD -i eth0 -o wlan0 -j ACCEPT
sudo iptables -A FORWARD -i wlan0 -o eth0 -m state --state RELATED,ESTABLISHED -j ACCEPT

# 4. Kalıcı
sudo apt install -y iptables-persistent && sudo netfilter-persistent save
```

### DHCP Server

```bash
sudo apt install -y isc-dhcp-server
```

`sudo nano /etc/default/isc-dhcp-server`:
```
INTERFACESv4="eth0"
```

`sudo nano /etc/dhcp/dhcpd.conf`:
```
subnet 10.10.0.0 netmask 255.255.255.0 {
    range 10.10.0.50 10.10.0.250;
    option routers 10.10.0.1;
    option domain-name-servers 10.10.0.1;
    default-lease-time 600;
    max-lease-time 7200;
}
```

```bash
sudo systemctl restart isc-dhcp-server && sudo systemctl enable isc-dhcp-server
```

---

## Tailscale Mesh VPN

WireGuard tabanlı mesh VPN — NAT traversal otomatik, port forwarding gereksiz.

### Kurulum

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up   # Açılan URL ile yetkilendir
```

### Komutlar

```bash
tailscale status           # Bağlı cihazlar
tailscale ip               # Tailscale IP (100.x.x.x)
tailscale ping <peer>
tailscale netcheck
sudo tailscale down/logout
```

### Exit Node

```bash
# Pi'de:
sudo tailscale up --advertise-exit-node
# Admin panelden (login.tailscale.com): Machines → Pi → Edit → Exit node onayla

# Client'ta:
sudo tailscale up --exit-node=<PI_TAILSCALE_IP> --exit-node-allow-lan-access=true
```

### Subnet Router

```bash
sudo tailscale up --advertise-routes=192.168.1.0/24
# Admin panelden subnet route onayla
```

### Tailscale + Pi-hole

Yöntem A: Tailscale Admin → DNS → Pi Tailscale IP'sini DNS olarak ekle → "Override local DNS".
Pi-hole'da: Settings → DNS → Interface → "Listen on all interfaces, permit all origins".

---

## Tor Proxy

### SOCKS5 Proxy

```bash
sudo apt install -y tor
sudo nano /etc/tor/torrc
```

```
SocksPort 9050
SocksPolicy accept 192.168.1.0/24
SocksPolicy reject *
Log notice file /var/log/tor/notices.log
```

```bash
sudo systemctl restart tor && sudo systemctl enable tor
curl --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip   # Test
```

### Transparent Proxy (Tüm Trafik)

`/etc/tor/torrc`'ye ekle:
```
VirtualAddrNetworkIPv4 10.192.0.0/10
AutomapHostsOnResolve 1
TransPort 9040 IsolateClientAddr IsolateClientProtocol IsolateDestAddr IsolateDestPort
DNSPort 5353
```

iptables:
```bash
sudo iptables -t nat -A OUTPUT -m owner --uid-owner debian-tor -j RETURN
sudo iptables -t nat -A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports 5353
sudo iptables -t nat -A OUTPUT -p tcp --syn -j REDIRECT --to-ports 9040
sudo iptables -t nat -A OUTPUT -d 127.0.0.0/8 -j RETURN
sudo iptables -t nat -A OUTPUT -d 192.168.0.0/16 -j RETURN
sudo systemctl restart tor
```

---

## Cloudflare Tunnel

Port forwarding'e gerek kalmadan Pi servislerini internete aç.

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared && sudo chmod +x /usr/local/bin/cloudflared

cloudflared tunnel login                               # Tarayıcıda domain seç
cloudflared tunnel create pi-tunnel
cloudflared tunnel route dns pi-tunnel tunnel.example.com
```

`nano ~/.cloudflared/config.yml`:
```yaml
tunnel: pi-tunnel
credentials-file: /home/<USER>/.cloudflared/<UUID>.json
ingress:
  - hostname: pihole.example.com
    service: http://localhost:80
  - hostname: ssh.example.com
    service: ssh://localhost:22
  - service: http_status:404
```

```bash
sudo cloudflared --config ~/.cloudflared/config.yml service install
sudo systemctl enable cloudflared && sudo systemctl start cloudflared
```

### Karşılaştırma: Tailscale vs WireGuard vs CF Tunnel

| | Tailscale | WireGuard | CF Tunnel |
|--|-----------|-----------|-----------|
| Port forward | Gerekmez | Gerekli | Gerekmez |
| NAT traversal | Otomatik | Manuel | N/A |
| UDP | Evet | Evet | Hayır |
| Kontrol | Tailscale | Sende | Cloudflare |
| Hız | Çok iyi | En iyi | İyi |

---

## Ağ İzleme

### ntopng

```bash
sudo wget -qO /tmp/apt-ntop.deb http://packages.ntop.org/RaspberryPI/apt-ntop.deb
sudo apt install -y /tmp/apt-ntop.deb && sudo apt update && sudo apt install -y ntopng
sudo systemctl enable ntopng && sudo systemctl start ntopng
```

Web: `https://<PI_IP>:3000` — admin/admin (ilk girişte değiştir).
Config (`/etc/ntopng/ntopng.conf`): `-w=3000`, `-i=eth0`, `-m=192.168.1.0/24`.

### vnStat

```bash
sudo apt install -y vnstat
sudo systemctl enable vnstat && sudo systemctl start vnstat
vnstat          # Özet
vnstat -d       # Günlük
vnstat -m       # Aylık
vnstat -l       # Canlı
```

### tcpdump

```bash
sudo apt install -y tcpdump
sudo tcpdump -i eth0                                  # Tüm trafik
sudo tcpdump -i eth0 host 192.168.1.50                # Belirli host
sudo tcpdump -i eth0 port 53 -vv                      # DNS
sudo tcpdump -i eth0 udp port 51820                   # WireGuard
sudo tcpdump -i eth0 -w /tmp/capture.pcap -c 1000     # Dosyaya kaydet
sudo tcpdump -i eth0 'tcp[tcpflags] & (tcp-syn) != 0' # SYN paketleri
```

### Darkstat

```bash
sudo apt install -y darkstat
sudo nano /etc/darkstat/init.cfg   # START_DARKSTAT=yes, INTERFACE="-i eth0"
sudo systemctl restart darkstat && sudo systemctl enable darkstat
# Web: http://<PI_IP>:667
```

### Faydalı Tek Satırlıklar

```bash
ss -tn | awk '{print $5}' | cut -d: -f1 | sort | uniq -c | sort -rn | head  # Top IP'ler
arp -a                        # Ağdaki cihazlar
nmap -sn 192.168.1.0/24       # Ağ taraması
sudo iftop -i eth0            # Gerçek zamanlı bant genişliği
```

---

## Fail2Ban

```bash
sudo apt install -y fail2ban
sudo cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
sudo nano /etc/fail2ban/jail.local
```

```ini
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
banaction = iptables-multiport

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 86400
```

```bash
sudo systemctl restart fail2ban && sudo systemctl enable fail2ban
sudo fail2ban-client status
sudo fail2ban-client status sshd
sudo fail2ban-client get sshd banned
sudo fail2ban-client set sshd unbanip 1.2.3.4
```

---

## SSH Sertleştirme

`sudo nano /etc/ssh/sshd_config`:
```
PermitRootLogin no
PasswordAuthentication no       # Key-based auth varsa
PubkeyAuthentication yes
PermitEmptyPasswords no
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
X11Forwarding no
```

```bash
sudo systemctl restart sshd
# Client'ta: ssh-keygen -t ed25519 && ssh-copy-id user@PI_IP
```

---

## Bakım

### Otomatik Bakım Scripti

```bash
cat > /usr/local/bin/rpi5-maintenance.sh << 'EOF'
#!/usr/bin/env bash
LOG="/var/log/rpi5-maintenance.log"
echo "=== Bakım: $(date) ===" >> "$LOG"
apt update -qq && apt upgrade -y -qq >> "$LOG" 2>&1
command -v pihole &>/dev/null && { pihole -up >> "$LOG" 2>&1; pihole -g >> "$LOG" 2>&1; }
if [[ -f /var/lib/unbound/root.hints ]]; then
    wget -qO /tmp/root.hints https://www.internic.net/domain/named.root && \
    mv /tmp/root.hints /var/lib/unbound/root.hints && \
    systemctl restart unbound && echo "Root hints güncellendi" >> "$LOG"
fi
for svc in pihole-FTL unbound wg-quick@wg0 fail2ban; do
    systemctl is-active --quiet "$svc" 2>/dev/null || \
    { echo "UYARI: $svc restart" >> "$LOG"; systemctl restart "$svc" 2>/dev/null; }
done
DISK=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
[[ "$DISK" -gt 80 ]] && echo "UYARI: Disk %${DISK}" >> "$LOG"
echo "=== Tamamlandı ===" >> "$LOG"
EOF
chmod +x /usr/local/bin/rpi5-maintenance.sh
(crontab -l 2>/dev/null | grep -v rpi5-maintenance; echo "0 4 * * 0 /usr/local/bin/rpi5-maintenance.sh") | crontab -
```

---

## FULL SETUP SCRIPT

Aşağıdaki script `env.template` dosyasını okuyarak tüm modülleri otomatik kurar. Claude Code bu scripti `configs/env.template` değişkenlerini kullanıcıya göre doldurduktan sonra Pi'ye gönderir ve çalıştırır.

Script her modülü `_ENABLED=yes/no` ile kontrol eder, idempotent çalışır (zaten kuruluyu atlar), fonksiyon bazlı yapıdadır ve sonunda doğrulama + özet yazdırır.

Kullanım:
```bash
# 1. env dosyasını hazırla (env.template'i düzenle)
# 2. Pi'ye gönder
scp rpi5-env.conf pi@PI_IP:/tmp/
scp full-setup.sh pi@PI_IP:/tmp/
# 3. Çalıştır
ssh pi@PI_IP "sudo bash /tmp/full-setup.sh /tmp/rpi5-env.conf"
```

Script yapısı: `system_update()` → `install_pihole()` → `install_unbound()` → `install_wireguard()` → `install_zapret()` → `install_tailscale()` → `install_tor()` → `setup_firewall()` → `install_fail2ban()` → `install_monitoring()` → `harden_ssh()` → `setup_maintenance()` → `print_summary()`.

Her fonksiyon ilgili `_ENABLED` değişkenini kontrol eder, `yes` değilse atlar. WireGuard kurulumunda key'ler otomatik üretilir, client config'ler ve QR kodları `/etc/wireguard/clients/` altına yazılır. Pi-hole unattended modda kurulur. Unbound yapılandırması otomatik uygulanır ve Pi-hole'a bağlanır.

Full setup script'in tamamı için `scripts/full-setup.sh` dosyasına bak veya Claude Code'a üretmesini iste — bu dokümandaki her modülün kurulum komutlarını idempotent fonksiyonlara sarar ve env'den okunan değişkenlerle çalıştırır.

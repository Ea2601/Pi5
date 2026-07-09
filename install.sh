#!/bin/bash
set -e

# ╔══════════════════════════════════════════════════════════════╗
# ║         Pi5 Secure Gateway — Tek Komut Kurulum              ║
# ║                                                              ║
# ║  Kullanım:                                                   ║
# ║    curl -fsSL https://raw.githubusercontent.com/             ║
# ║      Ea2601/Pi5/main/install.sh | bash                        ║
# ║                                                              ║
# ║  veya:                                                       ║
# ║    git clone https://github.com/Ea2601/Pi5.git                ║
# ║    cd Pi5 && chmod +x install.sh && ./install.sh             ║
# ╚══════════════════════════════════════════════════════════════╝

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="/opt/pi5-gateway"
SERVICE_USER="pi5gw"

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

# Root kontrolü
if [ "$EUID" -ne 0 ]; then
  err "Bu script root olarak çalıştırılmalı: sudo bash install.sh"
fi

echo -e "${BLUE}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║     Pi5 Secure Gateway Kurulum Başlıyor      ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── 1. Sistem Güncellemesi ───
step "1/10 — Sistem Güncelleniyor"
apt update -qq
apt upgrade -y -qq
log "Sistem güncellendi"

# ─── 2. Gerekli Paketler ───
step "2/10 — Bağımlılıklar Kuruluyor"
apt install -y -qq \
  curl git build-essential \
  sqlite3 libsqlite3-dev \
  nginx certbot python3-certbot-nginx apache2-utils \
  qrencode speedtest-cli vnstat \
  ipset iptables

# Node.js 22 LTS
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  warn "Node.js kuruluyor..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y -qq nodejs
fi
log "Node.js $(node -v) hazır"
log "npm $(npm -v) hazır"

# ─── 3. Proje Dosyaları ───
step "3/10 — Proje Dosyaları İndiriliyor"
if [ -d "$INSTALL_DIR" ]; then
  warn "Mevcut kurulum bulundu, güncelleniyor..."
  cd "$INSTALL_DIR"
  git pull --rebase 2>/dev/null || true
else
  git clone https://github.com/Ea2601/Pi5.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
log "Proje dosyaları hazır: $INSTALL_DIR"

# ─── 4. Backend Kurulumu ───
step "4/10 — Backend Kuruluyor"
cd "$INSTALL_DIR/backend"
npm ci --production=false 2>/dev/null || npm install
npm run build || warn "Backend build hata verdi"
# Build çıktısı yoksa servisi başlatma — dist/index.js olmadan pi5-backend sonsuz crash-loop'a girer
if [ ! -f "$INSTALL_DIR/backend/dist/index.js" ]; then
  err "Backend build başarısız (dist/index.js yok). Kurulum durduruldu — crash-loop önlendi. Logları kontrol edin."
fi
log "Backend derlendi"

# ─── 5. Frontend Kurulumu ───
step "5/10 — Frontend Kuruluyor"
cd "$INSTALL_DIR/frontend"
npm ci --production=false 2>/dev/null || npm install
npm run build
log "Frontend build tamamlandı"

# ─── 6. Ağ Servislerinin Kurulumu ───
step "6/10 — Ağ Servisleri Kuruluyor"

# --- Pi-hole ---
if command -v pihole &>/dev/null; then
  log "Pi-hole zaten kurulu"
else
  warn "Pi-hole kuruluyor (headless)..."
  mkdir -p /etc/pihole
  cat > /etc/pihole/setupVars.conf << 'PHEOF'
PIHOLE_INTERFACE=eth0
# Gizlilik: TEK upstream = Unbound (recursive). 1.1.1.1 gibi ikinci upstream eklemek
# sorguların yarısını Unbound'u atlayıp dış sağlayıcıya sızdırır — kasıtlı olarak eklenmedi.
PIHOLE_DNS_1=127.0.0.1#5335
QUERY_LOGGING=true
INSTALL_WEB_SERVER=false
INSTALL_WEB_INTERFACE=false
LIGHTTPD_ENABLED=false
CACHE_SIZE=10000
DNS_FQDN_REQUIRED=true
DNS_BOGUS_PRIV=true
DNSMASQ_LISTENING=local
BLOCKING_ENABLED=true
PHEOF
  curl -sSL https://install.pi-hole.net | bash /dev/stdin --unattended
  log "Pi-hole kuruldu"
fi

# --- Unbound (recursive DNS) ---
if command -v unbound &>/dev/null; then
  log "Unbound zaten kurulu"
else
  warn "Unbound kuruluyor..."
  apt install -y -qq unbound
  cat > /etc/unbound/unbound.conf.d/pi5-unbound.conf << 'UBEOF'
server:
    verbosity: 0
    interface: 127.0.0.1
    port: 5335
    do-ip4: yes
    do-udp: yes
    do-tcp: yes
    do-ip6: no
    prefer-ip6: no
    harden-glue: yes
    harden-dnssec-stripped: yes
    harden-additional-queries: yes
    aggressive-nsec: yes
    use-caps-for-id: yes
    hide-identity: yes
    hide-version: yes
    auto-trust-anchor-file: "/var/lib/unbound/root.key"
    edns-buffer-size: 1232
    prefetch: yes
    num-threads: 1
    so-rcvbuf: 1m
    private-address: 192.168.0.0/16
    private-address: 169.254.0.0/16
    private-address: 172.16.0.0/12
    private-address: 10.0.0.0/8
UBEOF
  systemctl enable unbound
  systemctl restart unbound
  log "Unbound kuruldu ve aktif (port 5335)"
fi

# --- Fail2Ban ---
if command -v fail2ban-client &>/dev/null; then
  log "Fail2Ban zaten kurulu"
else
  warn "Fail2Ban kuruluyor..."
  apt install -y -qq fail2ban
  cat > /etc/fail2ban/jail.local << 'F2BEOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
# journald-only sistemlerde (Bookworm) /var/log/auth.log olmayabilir — systemd backend journal'ı okur
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 3
bantime = 7200
F2BEOF
  systemctl enable fail2ban
  systemctl restart fail2ban
  log "Fail2Ban kuruldu ve aktif"
fi

# --- nftables ---
if command -v nft &>/dev/null; then
  log "nftables zaten kurulu"
else
  warn "nftables kuruluyor..."
  apt install -y -qq nftables
fi
systemctl enable nftables
log "nftables aktif"

# --- Zapret (DPI bypass) ---
if [ -d "/opt/zapret" ]; then
  log "Zapret zaten kurulu"
else
  warn "Zapret kuruluyor..."
  git clone --depth=1 https://github.com/bol-van/zapret.git /opt/zapret 2>/dev/null || true
  if [ -f "/opt/zapret/install_easy.sh" ]; then
    cd /opt/zapret
    # Auto-install mode
    echo -e "1\n1\n" | bash install_easy.sh 2>/dev/null || warn "Zapret kurulumu kısmen tamamlandı (manuel kontrol gerekebilir)"
    cd "$INSTALL_DIR"
  fi
  log "Zapret kuruldu"
fi

# ─── Hardware: LED, LCD bağımlılıkları ───
# Bookworm (PEP 668) externally-managed-environment: --break-system-packages gerekir, yoksa sessiz başarısızlık.
warn "Pimoroni kasa bağımlılıkları kuruluyor..."
pip3 install --break-system-packages --quiet fanshim spidev luma.oled luma.core RPLCD 2>/dev/null \
  || pip3 install --quiet fanshim spidev luma.oled luma.core RPLCD 2>/dev/null \
  || warn "Pimoroni pip bağımlılıkları kurulamadı (donanım yoksa normal)"
log "Pimoroni bağımlılık adımı tamamlandı"

# ─── Kiosk: Minimal X11 + Chromium (Lite OS için) ───
warn "Kiosk modu bağımlılıkları kuruluyor (Lite OS)..."
apt install -y -qq xserver-xorg x11-xserver-utils xinit openbox chromium-browser 2>/dev/null || true

# Kiosk başlatma script'i
cat > /opt/pi5-gateway/scripts/kiosk.sh << 'KIOSKEOF'
#!/bin/bash
# Pi5 Gateway Kiosk Mode — minimal X11 + Chromium
export DISPLAY=:0

# Ekran koruyucu ve güç yönetimini kapat
xset s off
xset s noblank
xset -dpms

# Chromium kiosk modunda başlat
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-translate \
  --no-first-run \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --disable-component-update \
  --overscroll-history-navigation=0 \
  http://localhost/kiosk.html
KIOSKEOF
chmod +x /opt/pi5-gateway/scripts/kiosk.sh

# Openbox autostart — kiosk script'ini çalıştır
mkdir -p /root/.config/openbox
cat > /root/.config/openbox/autostart << 'OBEOF'
/opt/pi5-gateway/scripts/kiosk.sh &
OBEOF

# Systemd service: X11 + Openbox + Kiosk otomatik başlat
cat > /etc/systemd/system/pi5-kiosk.service << 'SVCEOF'
[Unit]
Description=Pi5 Gateway Kiosk Display
After=pi5-backend.service network-online.target getty@tty1.service
Wants=pi5-backend.service network-online.target
Conflicts=getty@tty1.service

[Service]
Type=simple
User=root
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/xinit /usr/bin/openbox-session -- :0 vt1 -nocursor
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

# Kiosk servisini aktifleştirme — panelden kontrol edilecek
# systemctl enable pi5-kiosk ile aktif edilir
log "Kiosk modu hazır (pi5-kiosk.service — panelden etkinleştirin)"

# ─── 7. SSD Algılama & Veri Dizini ───
step "7/10 — SSD Algılama & Veri Dizini"

# NVMe SSD algılama
SSD_DETECTED=false
SSD_MOUNT=""
if lsblk -dno NAME,TYPE | grep -q "nvme.*disk"; then
  SSD_DEV=$(lsblk -dno NAME,TYPE | grep "nvme.*disk" | head -1 | awk '{print $1}')
  log "NVMe SSD algılandı: /dev/$SSD_DEV"

  # SSD mount edilmiş mi kontrol et
  SSD_MOUNT=$(lsblk -no MOUNTPOINT /dev/${SSD_DEV}p1 2>/dev/null | head -1)

  if [ -z "$SSD_MOUNT" ]; then
    PART="/dev/${SSD_DEV}p1"
    HAS_PART=false
    lsblk -no NAME /dev/$SSD_DEV | grep -q "p1" && HAS_PART=true
    HAS_FS=false
    { blkid "$PART" 2>/dev/null | grep -q "TYPE="; } && HAS_FS=true

    # GÜVENLİK: Disk üzerinde bölüm/dosya sistemi varsa ASLA otomatik formatlama (veri kaybını önle).
    # Boş diski formatlamak için açık onay gerekir: PI5_FORMAT_SSD=1 sudo ./install.sh
    if { [ "$HAS_PART" = true ] || [ "$HAS_FS" = true ]; } && [ "${PI5_FORMAT_SSD:-0}" != "1" ]; then
      warn "SSD'de mevcut bölüm/veri tespit edildi — otomatik formatlama ATLANDI (veri korundu)."
      warn "Diski sıfırlayıp kullanmak isterseniz: PI5_FORMAT_SSD=1 ile yeniden çalıştırın."
      warn "SD kart üzerinde devam ediliyor."
      SSD_DETECTED=false
      mkdir -p "$INSTALL_DIR/core"
    else
      warn "SSD mount edilmemiş. /mnt/ssd olarak hazırlanıyor..."
      if [ "$HAS_PART" = false ]; then
        warn "SSD bölümlendiriliyor..."
        echo -e "g\nn\n\n\n\nw" | fdisk /dev/$SSD_DEV 2>/dev/null
        sleep 2
      fi
      if [ "$HAS_FS" = false ] || [ "${PI5_FORMAT_SSD:-0}" = "1" ]; then
        warn "SSD ext4 formatlanıyor..."
        mkfs.ext4 -F "$PART"
      fi

      SSD_MOUNT="/mnt/ssd"
      mkdir -p "$SSD_MOUNT"
      mount "$PART" "$SSD_MOUNT"

      UUID=$(blkid -s UUID -o value "$PART")
      if ! grep -q "$UUID" /etc/fstab; then
        echo "UUID=$UUID /mnt/ssd ext4 defaults,noatime,discard 0 2" >> /etc/fstab
        log "SSD /etc/fstab'a eklendi (kalıcı mount)"
      fi
      SSD_DETECTED=true
      log "SSD mount noktası: $SSD_MOUNT"
    fi
  else
    SSD_DETECTED=true
    log "SSD mount noktası: $SSD_MOUNT"
  fi

  # Core ve DB dizinini SSD'ye taşı (performans için)
  if [ -n "$SSD_MOUNT" ]; then
    SSD_DATA="$SSD_MOUNT/pi5-data"
    mkdir -p "$SSD_DATA"

    # Mevcut core dizinini SSD'ye taşı — SADECE kopyalama başarılıysa sil (veri kaybını önle)
    CORE_MOVED=true
    if [ -d "$INSTALL_DIR/core" ] && [ ! -L "$INSTALL_DIR/core" ]; then
      if cp -a "$INSTALL_DIR/core/." "$SSD_DATA/" 2>/dev/null; then
        rm -rf "$INSTALL_DIR/core"
      else
        CORE_MOVED=false
        warn "core/ SSD'ye kopyalanamadı — taşıma atlandı, veri korundu (core/ yerinde kaldı, SD kart kullanılıyor)"
      fi
    fi

    # Symlink oluştur: core → SSD (yalnızca gerçek core dizini kaldıysa/taşındıysa)
    if [ "$CORE_MOVED" = true ] && [ ! -e "$INSTALL_DIR/core" -o -L "$INSTALL_DIR/core" ]; then
      ln -sfn "$SSD_DATA" "$INSTALL_DIR/core"
      log "Veri dizini SSD'ye taşındı: $SSD_DATA → $INSTALL_DIR/core"
    fi
  fi
else
  warn "NVMe SSD algılanamadı, SD kart üzerinde çalışılacak"
  mkdir -p "$INSTALL_DIR/core"
fi

touch "$INSTALL_DIR/core/system.log"
log "Core dizini hazır"

# ─── 8. Systemd Servisleri ───
step "8/10 — Sistem Servisleri Kuruluyor"

# Backend servisi
cat > /etc/systemd/system/pi5-backend.service << 'SVCEOF'
[Unit]
Description=Pi5 Gateway Backend API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pi5-gateway/backend
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3001
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

# Domain redirect map (backend applyDomainRouting tarafından yönetilir; başlangıçta boş)
mkdir -p /etc/nginx/conf.d
if [ ! -f /etc/nginx/conf.d/pi5-redirect-map.conf ]; then
  printf 'map $host $pi5_redirect {\n    default "";\n}\n' > /etc/nginx/conf.d/pi5-redirect-map.conf
fi

# Nginx reverse proxy (frontend + API)
cat > /etc/nginx/sites-available/pi5-gateway << 'NGXEOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Panel erişim koruması (opt-in Basic Auth — localhost/kiosk muaf). İçerik pi5-auth.conf'tan gelir.
    include /etc/nginx/snippets/pi5-auth.conf;

    # Frontend (statik dosyalar)
    root /opt/pi5-gateway/frontend/dist;
    index index.html;

    location / {
        # DNS ile Pi5'e yönlendirilen domain'ler için 302 (pi5_redirect map'ten gelir)
        if ($pi5_redirect) { return 302 $pi5_redirect; }
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }

    # Güvenlik headerları
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGXEOF

# ─── Panel Erişim Koruması (Basic Auth — opt-in) ───
# PI5_ADMIN_PASSWORD verildiyse Basic Auth etkinleşir (localhost/kiosk muaf tutulur).
# Verilmediyse koruma kapalı kalır (kişisel/güvenilir LAN varsayımı) ama /api/terminal/execute gibi
# uç noktalar açıkta kalır — üretim/uzaktan erişimde MUTLAKA ayarlanmalı.
mkdir -p /etc/nginx/snippets
if [ -n "${PI5_ADMIN_PASSWORD:-}" ]; then
  PI5_ADMIN_USER="${PI5_ADMIN_USER:-admin}"
  htpasswd -bc /etc/nginx/.htpasswd "$PI5_ADMIN_USER" "$PI5_ADMIN_PASSWORD" 2>/dev/null
  cat > /etc/nginx/snippets/pi5-auth.conf << 'AUTHEOF'
satisfy any;
allow 127.0.0.1;
allow ::1;
deny all;
auth_basic "Pi5 Gateway";
auth_basic_user_file /etc/nginx/.htpasswd;
AUTHEOF
  log "Panel Basic Auth etkin (kullanıcı: $PI5_ADMIN_USER, localhost muaf)"
else
  echo "# Basic Auth kapalı — etkinleştirmek için PI5_ADMIN_PASSWORD ile yeniden çalıştırın" \
    > /etc/nginx/snippets/pi5-auth.conf
  warn "Panel erişim koruması KAPALI. Uzaktan/üretim için: PI5_ADMIN_PASSWORD=... sudo ./install.sh"
fi

# Nginx aktifleştir
ln -sf /etc/nginx/sites-available/pi5-gateway /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# Servisleri etkinleştir
systemctl daemon-reload
systemctl enable pi5-backend
systemctl start pi5-backend
log "Backend servisi çalışıyor"
log "Nginx reverse proxy aktif"

# ─── 9. IP Forwarding & Ağ Ayarları ───
step "9/10 — IP Forwarding Aktifleştiriliyor"
cat > /etc/sysctl.d/99-pi5-gateway.conf << 'SYSEOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
SYSEOF
sysctl -p /etc/sysctl.d/99-pi5-gateway.conf 2>/dev/null
log "IP forwarding aktif"

# ─── 10. Günlük Bakım Cron ───
step "10/10 — Otomatik Bakım Ayarlanıyor"

# Günlük otomatik güncelleme + restart
cat > /etc/cron.d/pi5-maintenance << 'CRONEOF'
# Pi5 Gateway günlük bakım
0 3 * * * root apt update -qq && apt upgrade -y -qq >> /opt/pi5-gateway/core/system.log 2>&1
# Güncelleme+build tek scriptte; backend restart YALNIZCA build başarılıysa (&&) yapılır — bozuk build'i canlıya almaz
30 3 * * * root /bin/bash /opt/pi5-gateway/scripts/update.sh >> /opt/pi5-gateway/core/system.log 2>&1 && systemctl restart pi5-backend >> /opt/pi5-gateway/core/system.log 2>&1
0 2 * * 1 root journalctl --vacuum-time=7d && find /var/log -name "*.gz" -mtime +30 -delete >> /opt/pi5-gateway/core/system.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/pi5-maintenance
log "Otomatik bakım cron görevleri ayarlandı"

# ─── Tamamlandı ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ Pi5 Secure Gateway kurulumu tamamlandı!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo -e "  Web Panel:  ${BLUE}http://${LOCAL_IP}${NC}"
echo -e "  API:        ${BLUE}http://${LOCAL_IP}/api/status${NC}"
echo -e "  Kurulum:    ${BLUE}${INSTALL_DIR}${NC}"
echo ""
echo -e "  ${YELLOW}Servis yönetimi:${NC}"
echo -e "    sudo systemctl status pi5-backend"
echo -e "    sudo systemctl restart pi5-backend"
echo -e "    sudo journalctl -u pi5-backend -f"
echo ""

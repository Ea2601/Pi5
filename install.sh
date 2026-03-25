#!/bin/bash
set -e

# ╔══════════════════════════════════════════════════════════════╗
# ║         Pi5 Secure Gateway — Tek Komut Kurulum              ║
# ║                                                              ║
# ║  Kullanım:                                                   ║
# ║    curl -fsSL https://raw.githubusercontent.com/             ║
# ║      akane/Pi5/main/install.sh | bash                        ║
# ║                                                              ║
# ║  veya:                                                       ║
# ║    git clone https://github.com/akane/Pi5.git                ║
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
step "1/8 — Sistem Güncelleniyor"
apt update -qq
apt upgrade -y -qq
log "Sistem güncellendi"

# ─── 2. Gerekli Paketler ───
step "2/8 — Bağımlılıklar Kuruluyor"
apt install -y -qq \
  curl git build-essential \
  sqlite3 libsqlite3-dev \
  nginx certbot python3-certbot-nginx \
  qrencode

# Node.js 22 LTS
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  warn "Node.js kuruluyor..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y -qq nodejs
fi
log "Node.js $(node -v) hazır"
log "npm $(npm -v) hazır"

# ─── 3. Proje Dosyaları ───
step "3/8 — Proje Dosyaları İndiriliyor"
if [ -d "$INSTALL_DIR" ]; then
  warn "Mevcut kurulum bulundu, güncelleniyor..."
  cd "$INSTALL_DIR"
  git pull --rebase 2>/dev/null || true
else
  git clone https://github.com/akane/Pi5.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
log "Proje dosyaları hazır: $INSTALL_DIR"

# ─── 4. Backend Kurulumu ───
step "4/8 — Backend Kuruluyor"
cd "$INSTALL_DIR/backend"
npm ci --production=false 2>/dev/null || npm install
npm run build 2>/dev/null || warn "Backend build uyarısı (devam ediyor)"
log "Backend bağımlılıkları kuruldu"

# ─── 5. Frontend Kurulumu ───
step "5/8 — Frontend Kuruluyor"
cd "$INSTALL_DIR/frontend"
npm ci --production=false 2>/dev/null || npm install
npm run build
log "Frontend build tamamlandı"

# ─── 6. Core Dizini ───
step "6/8 — Veri Dizini Hazırlanıyor"
mkdir -p "$INSTALL_DIR/core"
touch "$INSTALL_DIR/core/system.log"
log "Core dizini hazır"

# ─── 7. Systemd Servisleri ───
step "7/8 — Sistem Servisleri Kuruluyor"

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

# Nginx reverse proxy (frontend + API)
cat > /etc/nginx/sites-available/pi5-gateway << 'NGXEOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Frontend (statik dosyalar)
    root /opt/pi5-gateway/frontend/dist;
    index index.html;

    location / {
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

# ─── 8. Günlük Bakım Cron ───
step "8/8 — Otomatik Bakım Ayarlanıyor"

# Günlük otomatik güncelleme + restart
cat > /etc/cron.d/pi5-maintenance << 'CRONEOF'
# Pi5 Gateway günlük bakım
0 3 * * * root apt update -qq && apt upgrade -y -qq >> /opt/pi5-gateway/core/system.log 2>&1
30 3 * * * root cd /opt/pi5-gateway && git pull --rebase >> /opt/pi5-gateway/core/system.log 2>&1
0 4 * * * root systemctl restart pi5-backend >> /opt/pi5-gateway/core/system.log 2>&1
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

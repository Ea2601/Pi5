#!/bin/bash
# Post-update script — runs automatically after git pull
# Handles: npm install, dependency checks, new script permissions, migrations

set -e
BASE="/opt/pi5-gateway"
LOG="$BASE/core/update.log"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Post-update başlatıldı" >> "$LOG"

# 1. Backend npm install (if package.json changed)
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q "backend/package"; then
  echo "  Backend bağımlılıkları güncelleniyor..." >> "$LOG"
  cd "$BASE/backend" && npm install --production 2>&1 | tail -3 >> "$LOG"
fi

# 2. Frontend npm install (if package.json changed)
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q "frontend/package"; then
  echo "  Frontend bağımlılıkları güncelleniyor..." >> "$LOG"
  cd "$BASE/frontend" && npm install 2>&1 | tail -3 >> "$LOG"
fi

# 3. Make all scripts executable
chmod +x "$BASE/scripts/"*.py "$BASE/scripts/"*.sh 2>/dev/null || true

# 4. Install Python deps if scripts exist and deps missing
if [ -f "$BASE/scripts/led_control.py" ]; then
  python3 -c "import fanshim" 2>/dev/null || python3 -c "import spidev" 2>/dev/null || {
    echo "  LED Python bağımlılıkları kuruluyor..." >> "$LOG"
    pip3 install fanshim spidev 2>/dev/null >> "$LOG" || true
  }
fi

if [ -f "$BASE/scripts/lcd_display.py" ]; then
  python3 -c "from luma.oled.device import ssd1306" 2>/dev/null || {
    echo "  LCD Python bağımlılıkları kuruluyor..." >> "$LOG"
    pip3 install luma.oled luma.core RPLCD 2>/dev/null >> "$LOG" || true
  }
fi

# 5. Enable I2C/SPI if not already
raspi-config nonint do_i2c 0 2>/dev/null || true
raspi-config nonint do_spi 0 2>/dev/null || true

# 6. Kiosk bağımlılıkları (Lite OS için minimal X11 + Chromium)
if ! command -v chromium-browser &>/dev/null; then
  echo "  Kiosk bağımlılıkları kuruluyor (X11 + Chromium)..." >> "$LOG"
  apt install -y -qq xserver-xorg x11-xserver-utils xinit openbox chromium-browser 2>/dev/null >> "$LOG" || true
fi

# 7. Kiosk script ve servis dosyalarını oluştur/güncelle
cat > "$BASE/scripts/kiosk.sh" << 'KIOSKEOF'
#!/bin/bash
export DISPLAY=:0
xset s off
xset s noblank
xset -dpms
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
  http://localhost:3001/kiosk.html
KIOSKEOF
chmod +x "$BASE/scripts/kiosk.sh"

mkdir -p /root/.config/openbox
cat > /root/.config/openbox/autostart << 'OBEOF'
/opt/pi5-gateway/scripts/kiosk.sh &
OBEOF

# Kiosk systemd service (yoksa oluştur)
if [ ! -f /etc/systemd/system/pi5-kiosk.service ]; then
  cat > /etc/systemd/system/pi5-kiosk.service << 'SVCEOF'
[Unit]
Description=Pi5 Gateway Kiosk Display
After=pi5-backend.service network-online.target
Wants=pi5-backend.service

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
  systemctl daemon-reload 2>/dev/null || true
  echo "  pi5-kiosk.service oluşturuldu" >> "$LOG"
fi

# Kiosk config'de enabled=true ise servisi aktifleştir
if command -v python3 &>/dev/null && [ -f "$BASE/core/pi5router.sqlite" ]; then
  KIOSK_ENABLED=$(python3 -c "
import sqlite3, json
try:
    conn = sqlite3.connect('$BASE/core/pi5router.sqlite')
    row = conn.execute(\"SELECT value FROM app_settings WHERE key='kiosk_config'\").fetchone()
    if row:
        cfg = json.loads(row[0])
        print('1' if cfg.get('enabled') else '0')
    else: print('0')
except: print('0')
" 2>/dev/null)
  if [ "$KIOSK_ENABLED" = "1" ]; then
    systemctl enable --now pi5-kiosk.service 2>/dev/null || true
    echo "  Kiosk modu aktif (DB'den okunan ayar)" >> "$LOG"
  fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') — Post-update tamamlandı" >> "$LOG"

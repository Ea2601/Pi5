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

echo "$(date '+%Y-%m-%d %H:%M:%S') — Post-update tamamlandı" >> "$LOG"

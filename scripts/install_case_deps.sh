#!/bin/bash
# Install dependencies for case LED (WS2812/Pironman 5 or Fan SHIM) + OLED/LCD display
# Run on Pi5: bash /opt/pi5-gateway/scripts/install_case_deps.sh
# Bookworm (PEP 668): --break-system-packages gerekir, yoksa pip sessizce başarısız olur.

echo "=== Kasa Bağımlılıkları Kuruluyor ==="

# pip yardımcı: önce --break-system-packages, olmazsa düz
pipx_install() { pip3 install --break-system-packages "$@" 2>/dev/null || pip3 install "$@" 2>/dev/null; }

# LED: WS2812 (Pironman 5 / addressable RGB — SPI) VE Fan SHIM (APA102) desteği
echo "[1/4] LED kütüphaneleri (spidev + fanshim)..."
pipx_install spidev fanshim
echo "  ✓ LED hazır — WS2812/SPI önce denenir, sonra Fan SHIM."
echo "    Ayarlar: PI5_LED_TYPE=ws2812|apa102|fanshim  PI5_LED_COUNT=4  PI5_LED_SPI_BUS=0 PI5_LED_SPI_DEV=0"

# OLED Display (SSD1306 I2C — Pironman 5 dahil)
echo "[2/4] OLED display kütüphanesi..."
pipx_install luma.oled luma.core Pillow
echo "  ✓ OLED display hazır"

# HD44780 LCD fallback
echo "[3/4] HD44780 LCD kütüphanesi..."
pipx_install RPLCD smbus2
echo "  ✓ LCD display hazır"

# Enable I2C and SPI
echo "[4/4] I2C ve SPI aktif ediliyor..."
raspi-config nonint do_i2c 0 2>/dev/null || true
raspi-config nonint do_spi 0 2>/dev/null || true
echo "  ✓ I2C/SPI aktif"

# Make scripts executable
chmod +x /opt/pi5-gateway/scripts/led_control.py
chmod +x /opt/pi5-gateway/scripts/lcd_display.py

echo ""
echo "=== Kurulum Tamamlandı ==="
echo "Test: python3 /opt/pi5-gateway/scripts/led_control.py set '#22c55e' 80 'breathe'"
echo "LCD:  python3 /opt/pi5-gateway/scripts/lcd_display.py start"

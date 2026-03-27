#!/bin/bash
# Install dependencies for Pimoroni Fan SHIM LED and LCD display
# Run on Pi5: bash /opt/pi5-gateway/scripts/install_case_deps.sh

echo "=== Pimoroni Kasa Bağımlılıkları Kuruluyor ==="

# Fan SHIM LED (APA102 SPI)
echo "[1/4] Fan SHIM Python kütüphanesi..."
pip3 install fanshim 2>/dev/null || pip3 install spidev gpiod 2>/dev/null
echo "  ✓ LED kontrol hazır"

# OLED Display (SSD1306 I2C)
echo "[2/4] OLED display kütüphanesi..."
pip3 install luma.oled luma.core Pillow 2>/dev/null
echo "  ✓ OLED display hazır"

# HD44780 LCD fallback
echo "[3/4] HD44780 LCD kütüphanesi..."
pip3 install RPLCD smbus2 2>/dev/null
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

#!/usr/bin/env python3
"""
LCD Display Controller for Pimoroni Pi5 Case
Cycles through configured pages showing system info on I2C display.

Usage:
  python3 lcd_display.py start   # Start display daemon
  python3 lcd_display.py stop    # Stop display daemon
  python3 lcd_display.py status  # Show current state

Supports: SSD1306 OLED (128x64/128x32), HD44780 16x2 via I2C

Requires: pip3 install luma.oled luma.core  (for OLED)
     OR:  pip3 install RPLCD               (for HD44780)
"""

import sys
import os
import json
import time
import signal
import subprocess

PID_FILE = "/tmp/lcd_display.pid"
CONFIG_FILE = "/opt/pi5-gateway/core/pi5router.sqlite"
PAGES_KEY = "lcd_pages"


def kill_existing():
    """Kill any running LCD daemon."""
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE) as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, signal.SIGTERM)
            time.sleep(0.3)
    except (ProcessLookupError, ValueError):
        pass
    finally:
        try:
            os.unlink(PID_FILE)
        except:
            pass


def write_pid():
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))


def get_pages():
    """Read LCD pages config from SQLite."""
    try:
        import sqlite3
        db = sqlite3.connect(CONFIG_FILE)
        row = db.execute("SELECT value FROM app_settings WHERE key = ?", (PAGES_KEY,)).fetchone()
        db.close()
        if row and row[0]:
            return json.loads(row[0])
    except:
        pass
    return [
        {"id": "hostname", "type": "system", "content": "hostname", "duration": 5, "enabled": True},
        {"id": "cpu", "type": "system", "content": "cpu_ram", "duration": 5, "enabled": True},
    ]


def get_system_data(content_type):
    """Fetch system data for a page type."""
    try:
        if content_type == "hostname":
            hostname = subprocess.getoutput("hostname").strip()
            ip = subprocess.getoutput("hostname -I | awk '{print $1}'").strip()
            return [hostname, ip]

        elif content_type == "cpu_ram":
            temp = subprocess.getoutput("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null").strip()
            temp_c = f"{int(temp) / 1000:.1f}C" if temp.isdigit() else "N/A"
            ram = subprocess.getoutput("free -m | awk '/Mem:/{printf \"%d/%dMB\", $3, $2}'").strip()
            return [f"CPU: {temp_c}", f"RAM: {ram}"]

        elif content_type == "network":
            # Get last speed test from DB
            try:
                import sqlite3
                db = sqlite3.connect(CONFIG_FILE)
                row = db.execute("SELECT download_mbps, upload_mbps FROM speed_tests ORDER BY timestamp DESC LIMIT 1").fetchone()
                db.close()
                if row:
                    return [f"DL: {row[0]:.1f} Mbps", f"UL: {row[1]:.1f} Mbps"]
            except:
                pass
            return ["DL: --- Mbps", "UL: --- Mbps"]

        elif content_type == "devices":
            try:
                import sqlite3
                db = sqlite3.connect(CONFIG_FILE)
                row = db.execute("SELECT COUNT(*) FROM devices").fetchone()
                db.close()
                return [f"Aktif Cihaz", f"{row[0] if row else 0} adet"]
            except:
                return ["Cihaz: N/A", ""]

        elif content_type == "vpn":
            try:
                import sqlite3
                db = sqlite3.connect(CONFIG_FILE)
                rows = db.execute("SELECT location, status FROM vps_servers").fetchall()
                db.close()
                if not rows:
                    return ["VPN: Yok", ""]
                connected = sum(1 for r in rows if r[1] == "connected")
                return [f"VPN: {connected}/{len(rows)}", rows[0][0] if rows else ""]
            except:
                return ["VPN: N/A", ""]

        else:
            return [str(content_type)[:16], ""]

    except Exception as e:
        return ["Hata", str(e)[:16]]


def get_display():
    """Try to initialize display. OLED first, then HD44780."""
    # Try SSD1306 OLED
    try:
        from luma.core.interface.serial import i2c
        from luma.oled.device import ssd1306
        from luma.core.render import canvas
        from PIL import ImageFont

        serial = i2c(port=1, address=0x3C)
        device = ssd1306(serial, width=128, height=64)

        font = ImageFont.load_default()

        class OLEDDisplay:
            def show(self, lines):
                with canvas(device) as draw:
                    for i, line in enumerate(lines[:4]):
                        draw.text((2, i * 16), str(line)[:21], fill="white", font=font)

            def clear(self):
                device.clear()

        return OLEDDisplay()
    except:
        pass

    # Try HD44780 16x2 via I2C
    try:
        from RPLCD.i2c import CharLCD
        lcd = CharLCD('PCF8574', 0x27)

        class HD44780Display:
            def show(self, lines):
                lcd.clear()
                for i, line in enumerate(lines[:2]):
                    lcd.cursor_pos = (i, 0)
                    lcd.write_string(str(line)[:16])

            def clear(self):
                lcd.clear()

        return HD44780Display()
    except:
        pass

    # Fallback: console output (for testing)
    class ConsoleDisplay:
        def show(self, lines):
            os.system('clear' if os.name == 'posix' else 'cls')
            print("┌──────────────────┐")
            for line in lines[:2]:
                print(f"│ {str(line)[:16]:16} │")
            print("└──────────────────┘")

        def clear(self):
            pass

    return ConsoleDisplay()


def run_display():
    """Main display loop — cycles through enabled pages."""
    write_pid()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    display = get_display()
    last_config_check = 0

    pages = [p for p in get_pages() if p.get("enabled", True)]
    page_idx = 0

    while True:
        # Reload config every 60 seconds
        if time.time() - last_config_check > 60:
            pages = [p for p in get_pages() if p.get("enabled", True)]
            last_config_check = time.time()
            if not pages:
                display.show(["No pages", "configured"])
                time.sleep(5)
                continue

        if page_idx >= len(pages):
            page_idx = 0

        page = pages[page_idx]
        duration = page.get("duration", 5)

        if page.get("type") == "custom":
            content = page.get("content", "")
            lines = [content[:16], content[16:32] if len(content) > 16 else ""]
        else:
            lines = get_system_data(page.get("content", ""))

        display.show(lines)
        time.sleep(duration)
        page_idx += 1


def main():
    if len(sys.argv) < 2:
        print("Usage: lcd_display.py [start|stop|status]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "stop":
        kill_existing()
        print("LCD display durduruldu")

    elif cmd == "status":
        if os.path.exists(PID_FILE):
            with open(PID_FILE) as f:
                pid = f.read().strip()
            try:
                os.kill(int(pid), 0)
                print(f"LCD display calisiyor (PID: {pid})")
            except:
                print("LCD display calismıyor (eski PID dosyası)")
        else:
            print("LCD display calismıyor")

    elif cmd == "start":
        kill_existing()
        # Fork daemon
        pid = os.fork()
        if pid > 0:
            print(f"LCD display baslatildi (PID: {pid})")
            return
        else:
            os.setsid()
            run_display()

    else:
        print(f"Bilinmeyen komut: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

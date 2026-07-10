#!/usr/bin/env python3
"""
LCD Display Controller for Pimoroni Pi5 Case
Cycles through configured pages showing system info on I2C display.

Usage:
  python3 lcd_display.py run     # Foreground daemon (systemd Type=simple)
  python3 lcd_display.py start   # Fork daemon
  python3 lcd_display.py stop    # Stop daemon
  python3 lcd_display.py status  # Show current state
  python3 lcd_display.py detect  # Exit 0 if a real display, 2 if console fallback
  python3 lcd_display.py test    # 5s animated test view

Supports: SSD1306 / SH1106 OLED (128x64), HD44780 16x2 via I2C.
OLED render is frame-animated (header bar, slide-in, progress bars, marquee).
Env: PI5_LCD_CONTROLLER=ssd1306|sh1106|auto, PI5_LCD_ADDR, PI5_LCD_ANIM=0 (static).

Requires: pip3 install luma.oled luma.core Pillow  (for OLED)
     OR:  pip3 install RPLCD                       (for HD44780)
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
CONTROLLER_KEY = "lcd_controller"
LOG_FILE = "/tmp/lcd_display.log"


def log_lcd(msg):
    """Append a diagnostic line so 'ekran neden kararık' teşhis edilebilsin."""
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


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


def get_controller():
    """LCD denetleyicisi. Öncelik: env PI5_LCD_CONTROLLER > DB app_settings > 'auto'."""
    env = os.environ.get('PI5_LCD_CONTROLLER')
    if env:
        return env.lower()
    try:
        import sqlite3
        db = sqlite3.connect(CONFIG_FILE)
        row = db.execute("SELECT value FROM app_settings WHERE key = ?", (CONTROLLER_KEY,)).fetchone()
        db.close()
        if row and row[0]:
            return str(row[0]).lower()
    except Exception:
        pass
    return 'auto'


def _db_query(sql, one=True):
    """Read-only helper against the app SQLite. Returns row / rows / None on error."""
    try:
        import sqlite3
        db = sqlite3.connect(CONFIG_FILE)
        cur = db.execute(sql)
        res = cur.fetchone() if one else cur.fetchall()
        db.close()
        return res
    except Exception:
        return None


def _cpu_percent():
    """Instant CPU usage % via two /proc/stat samples (150ms)."""
    try:
        def read():
            with open("/proc/stat") as f:
                p = [float(x) for x in f.readline().split()[1:]]
            return p[3] + (p[4] if len(p) > 4 else 0), sum(p)
        i1, t1 = read()
        time.sleep(0.15)
        i2, t2 = read()
        dt = t2 - t1
        return int((1 - (i2 - i1) / dt) * 100) if dt > 0 else 0
    except Exception:
        return 0


def _flatten(view):
    """Flatten a rich view to plain text lines (HD44780 / console fallback)."""
    out = []
    for row in view.get("rows", []):
        if isinstance(row, (list, tuple)) and len(row) >= 3 and row[0] == "bar":
            out.append(f"{row[1]} {int(row[2])}%")
        elif isinstance(row, (list, tuple)):
            out.append(str(row[1]))
        else:
            out.append(str(row))
    return out


def build_system_view(content_type):
    """Build a rich page view: {title, rows}. row = ("text", str) | ("bar", label, percent)."""
    try:
        if content_type == "hostname":
            host = subprocess.getoutput("hostname").strip()
            ip = subprocess.getoutput("hostname -I | awk '{print $1}'").strip()
            up = subprocess.getoutput("uptime -p 2>/dev/null").strip().replace("up ", "")
            return {"title": "SISTEM", "rows": [
                ("text", host or "pi5"),
                ("text", "IP " + (ip or "-")),
                ("text", "Up " + (up[:18] or "-")),
            ]}
        if content_type == "cpu_ram":
            temp = subprocess.getoutput("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null").strip()
            temp_c = f"{int(temp) / 1000:.0f}C" if temp.isdigit() else "N/A"
            cpu = _cpu_percent()
            mem = subprocess.getoutput("free -m | awk '/Mem:/{printf \"%d %d\", $3, $2}'").split()
            used = int(mem[0]) if len(mem) == 2 else 0
            total = int(mem[1]) if len(mem) == 2 else 0
            mem_pct = int(used / total * 100) if total else 0
            return {"title": "CPU / RAM", "rows": [
                ("bar", "CPU", cpu),
                ("text", f"Sicaklik {temp_c}"),
                ("bar", "RAM", mem_pct),
                ("text", f"{used}/{total} MB"),
            ]}
        if content_type == "network":
            row = _db_query("SELECT download_mbps, upload_mbps, ping_ms FROM speed_tests ORDER BY timestamp DESC LIMIT 1")
            if row:
                return {"title": "AG / HIZ", "rows": [
                    ("text", f"DL {row[0]:.1f} Mbps"),
                    ("text", f"UL {row[1]:.1f} Mbps"),
                    ("text", f"Ping {row[2]:.0f} ms"),
                ]}
            return {"title": "AG / HIZ", "rows": [("text", "Veri yok")]}
        if content_type == "devices":
            row = _db_query("SELECT COUNT(*) FROM devices")
            n = row[0] if row else 0
            return {"title": "CIHAZLAR", "rows": [("text", f"Aktif {n} cihaz")]}
        if content_type == "vpn":
            rows = _db_query("SELECT location, status FROM vps_servers", one=False)
            if not rows:
                return {"title": "VPN", "rows": [("text", "Tunel yok")]}
            conn = sum(1 for r in rows if r[1] == "connected")
            out = [("text", f"Bagli {conn}/{len(rows)}")]
            for r in rows[:3]:
                st = "+" if r[1] == "connected" else "-"
                out.append(("text", f"{st} {r[0]}"[:20]))
            return {"title": "VPN", "rows": out}
        return {"title": str(content_type)[:20].upper(), "rows": [("text", "")]}
    except Exception as e:
        return {"title": "HATA", "rows": [("text", str(e)[:20])]}


def build_view(page):
    """Rich view for a page (system or custom-text)."""
    if page.get("type") == "custom":
        text = str(page.get("content", ""))
        rows = []
        while text and len(rows) < 4:
            rows.append(("text", text[:21]))
            text = text[21:]
        if not rows:
            rows = [("text", "")]
        return {"title": "MESAJ", "rows": rows}
    return build_system_view(page.get("content", ""))


def _make_oled(controller):
    """Init a luma OLED. controller: 'ssd1306' (0.96") or 'sh1106' (1.3", örn. Pironman 5).
    Ayar: PI5_LCD_ADDR (0x3C), PI5_LCD_WIDTH (128), PI5_LCD_HEIGHT (64), PI5_LCD_I2C_PORT (1)."""
    from luma.core.interface.serial import i2c
    from luma.core.render import canvas
    from PIL import ImageFont

    port = int(os.environ.get('PI5_LCD_I2C_PORT', '1') or 1)
    addr = int(os.environ.get('PI5_LCD_ADDR', '0x3C'), 0)
    width = int(os.environ.get('PI5_LCD_WIDTH', '128') or 128)
    height = int(os.environ.get('PI5_LCD_HEIGHT', '64') or 64)

    serial = i2c(port=port, address=addr)
    if controller == 'sh1106':
        from luma.oled.device import sh1106
        device = sh1106(serial, width=width, height=height)
    else:
        from luma.oled.device import ssd1306
        device = ssd1306(serial, width=width, height=height)

    font = ImageFont.load_default()

    class OLEDDisplay:
        controller_name = controller

        def show(self, lines):
            with canvas(device) as draw:
                for i, line in enumerate(lines[:4]):
                    draw.text((2, i * 16), str(line)[:21], fill="white", font=font)

        def animate(self, view, duration):
            """Render a page for `duration` s with animation: header bar + blinking activity
            dot, slide-in content, animated progress bars, marquee for long lines.
            PI5_LCD_ANIM=0 → statik tek kare."""
            title = str(view.get("title", ""))[:20]
            rows = view.get("rows", [])[:4]
            HEADER_H, LINE_H, ENTER, SCROLL_CPS = 13, 12, 0.45, 9
            anim = os.environ.get('PI5_LCD_ANIM', '1') != '0'
            start = time.time()
            try:
                while True:
                    t = time.time() - start
                    if t >= duration:
                        break
                    e = min(1.0, t / ENTER) if anim else 1.0
                    e = 1 - (1 - e) * (1 - e)  # ease-out
                    with canvas(device) as draw:
                        # Header (inverted) + blinking activity dot
                        draw.rectangle((0, 0, width - 1, HEADER_H - 1), fill="white")
                        draw.text((2, 2), title, fill="black", font=font)
                        if (not anim) or int(t * 2) % 2 == 0:
                            draw.ellipse((width - 9, 4, width - 5, 8), fill="black")
                        # Content slides up from below on enter
                        base_y = HEADER_H + 2 + int((1 - e) * (height - HEADER_H))
                        for i, row in enumerate(rows):
                            ry = base_y + i * LINE_H
                            if ry >= height:
                                break
                            is_bar = isinstance(row, (list, tuple)) and len(row) >= 3 and row[0] == "bar"
                            if is_bar:
                                pct = max(0, min(100, int(row[2])))
                                draw.text((2, ry), str(row[1])[:5], fill="white", font=font)
                                bx0, bx1 = 40, width - 24
                                draw.rectangle((bx0, ry + 1, bx1, ry + 8), outline="white")
                                fw = int((bx1 - bx0 - 2) * (pct * e) / 100)
                                if fw > 0:
                                    draw.rectangle((bx0 + 1, ry + 2, bx0 + 1 + fw, ry + 7), fill="white")
                                draw.text((bx1 + 3, ry), str(pct), fill="white", font=font)
                            else:
                                text = str(row[1]) if isinstance(row, (list, tuple)) else str(row)
                                if anim and len(text) > 21:
                                    period = len(text) + 3
                                    off = int(t * SCROLL_CPS) % period
                                    text = (text + "   " + text)[off:off + 21]
                                else:
                                    text = text[:21]
                                draw.text((2, ry), text, fill="white", font=font)
                    if not anim:
                        time.sleep(max(0.0, duration - (time.time() - start)))
                        break
                    time.sleep(1.0 / 15)
            except Exception as ex:
                log_lcd(f"animate hata: {ex}")
                try:
                    self.show(_flatten(view))
                except Exception:
                    pass
                time.sleep(max(0.0, duration - (time.time() - start)))

        def clear(self):
            device.clear()

    return OLEDDisplay()


def get_display():
    """Init a display. Controller: DB 'lcd_controller' veya env PI5_LCD_CONTROLLER (ssd1306|sh1106|auto)."""
    ctrl = get_controller()
    candidates = [ctrl] if ctrl in ('ssd1306', 'sh1106') else ['ssd1306', 'sh1106']

    for c in candidates:
        try:
            d = _make_oled(c)
            log_lcd(f"OLED baslatildi: {c}")
            return d
        except Exception as e:
            log_lcd(f"OLED {c} basarisiz: {e}")

    # HD44780 16x2 via I2C (fallback)
    try:
        from RPLCD.i2c import CharLCD
        hd_addr = int(os.environ.get('PI5_LCD_ADDR', '0x27'), 0)
        lcd = CharLCD('PCF8574', hd_addr)
        log_lcd("HD44780 baslatildi")

        class HD44780Display:
            controller_name = 'hd44780'

            def show(self, lines):
                lcd.clear()
                for i, line in enumerate(lines[:2]):
                    lcd.cursor_pos = (i, 0)
                    lcd.write_string(str(line)[:16])

            def animate(self, view, duration):
                # 16x2 karakter LCD — grafik yok; başlık + ilk veri satırını göster.
                self.show([str(view.get("title", ""))] + _flatten(view))
                time.sleep(duration)

            def clear(self):
                lcd.clear()

        return HD44780Display()
    except Exception as e:
        log_lcd(f"HD44780 basarisiz: {e}")

    log_lcd("GERCEK EKRAN YOK — luma.oled kurulu mu? "
            "'pip3 install --break-system-packages luma.oled luma.core Pillow'. "
            "I2C acik mi (raspi-config)? SH1106 panelde PI5_LCD_CONTROLLER=sh1106 deneyin.")

    # Fallback: console output (headless test). Fiziksel OLED KARANLIK kalir — bu bir teşhis durumudur.
    class ConsoleDisplay:
        controller_name = 'console'

        def show(self, lines):
            try:
                print("┌──────────────────┐")
                for line in lines[:2]:
                    print(f"│ {str(line)[:16]:16} │")
                print("└──────────────────┘", flush=True)
            except (BrokenPipeError, OSError):
                pass

        def animate(self, view, duration):
            self.show([str(view.get("title", ""))] + _flatten(view))
            time.sleep(duration)

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
        view = build_view(page)
        display.animate(view, duration)
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

    elif cmd == "run":
        # Foreground (systemd Type=simple için — fork YOK). Varsa eski fork daemon'u öldür.
        kill_existing()
        run_display()

    elif cmd == "detect":
        # Hızlı teşhis: gerçek ekran bulunursa exit 0, yalnızca console fallback ise exit 2.
        display = get_display()
        name = getattr(display, 'controller_name', '?')
        print(f"display={name}")
        sys.exit(0 if name != 'console' else 2)

    elif cmd == "test":
        # İnsan için: bulunan ekranda 5sn animasyonlu test görünümü göster.
        display = get_display()
        name = getattr(display, 'controller_name', '?')
        print(f"display={name}")
        if name == 'console':
            print("UYARI: Fiziksel ekran bulunamadi. Detay: /tmp/lcd_display.log")
            sys.exit(2)
        print("Animasyonlu test 5sn gorunecek...")
        display.animate({"title": "Pi5 Gateway", "rows": [
            ("text", f"LCD OK: {name}"),
            ("bar", "CPU", 72),
            ("bar", "RAM", 45),
            ("text", "Animasyon aktif - kayan uzun metin ornegi"),
        ]}, 5)
        sys.exit(0)

    else:
        print(f"Bilinmeyen komut: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

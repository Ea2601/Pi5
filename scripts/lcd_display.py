#!/usr/bin/env python3
"""
LCD Display Controller — Pi5 Gateway kasa OLED'i (Pironman / Pimoroni).

Kasada sırayla dönen çok-sayfalı, animasyonlu bilgi ekranı. OLED render'ı
Klyrix "piroled" 1-bit motoruyla (scripts/lcd_widgets.py) yapılır: marka
açılışı, yay göstergesi, sparkline, nokta ızgarası, kalkan, segmentli barlar.

Usage:
  python3 lcd_display.py run              # Foreground daemon (systemd Type=simple)
  python3 lcd_display.py start            # Fork daemon
  python3 lcd_display.py stop             # Stop daemon
  python3 lcd_display.py status           # Show current state
  python3 lcd_display.py detect           # Exit 0 gerçek ekran, 2 console fallback
  python3 lcd_display.py test [page]      # 5s animasyonlu test (varsayılan: brand)
  python3 lcd_display.py preview ...      # Cihazsız PNG/GIF üret (Pillow yeter)

  # Önizleme örnekleri (masaüstünde, luma/I2C gerekmez):
  python3 lcd_display.py preview --sheet sayfalar.png --scale 4
  python3 lcd_display.py preview --gif brand.gif -p brand --seconds 5 --scale 6

Supports: SSD1306 / SH1106 OLED (128x64), HD44780 16x2 via I2C, console fallback.
Env: PI5_LCD_CONTROLLER=ssd1306|sh1106|auto, PI5_LCD_ADDR, PI5_LCD_ANIM=0 (statik),
     PI5_LCD_WIDTH, PI5_LCD_HEIGHT, PI5_LCD_I2C_PORT, PI5_LCD_FPS.
Requires: pip3 install luma.oled luma.core Pillow  (OLED)  |  RPLCD (HD44780)
"""

import sys
import os
import json
import time
import signal
import subprocess

# Script dizinini import yoluna ekle (lcd_widgets aynı klasörde).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import lcd_widgets as lw
except Exception:
    lw = None  # Pillow yoksa yalnızca HD44780/console yolu çalışır.

PID_FILE = "/tmp/lcd_display.pid"
CONFIG_FILE = "/opt/pi5-gateway/core/pi5router.sqlite"
PAGES_KEY = "lcd_pages"
CONTROLLER_KEY = "lcd_controller"
LOG_FILE = "/tmp/lcd_display.log"
FPS = int(os.environ.get("PI5_LCD_FPS", "20") or 20)


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
        except Exception:
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
    except Exception:
        pass
    return [
        {"id": "brand", "type": "system", "content": "brand", "duration": 5, "enabled": True},
        {"id": "cpu", "type": "system", "content": "cpu_ram", "duration": 5, "enabled": True},
        {"id": "network", "type": "system", "content": "network", "duration": 5, "enabled": True},
        {"id": "devices", "type": "system", "content": "devices", "duration": 5, "enabled": True},
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


# ── Veri toplayıcılar ────────────────────────────────────────────────────────
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


def _uptime_s():
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except Exception:
        return 0


def _temp_c():
    temp = subprocess.getoutput("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null").strip()
    return int(temp) / 1000.0 if temp.isdigit() else 0.0


def _mem():
    mem = subprocess.getoutput("free -m | awk '/Mem:/{printf \"%d %d\", $3, $2}'").split()
    used = int(mem[0]) if len(mem) == 2 else 0
    total = int(mem[1]) if len(mem) == 2 else 0
    pct = int(used / total * 100) if total else 0
    return used, total, pct


def _devices():
    rows = _db_query("SELECT hostname, ip_address FROM devices ORDER BY last_seen DESC", one=False) or []
    cnt = _db_query("SELECT COUNT(*) FROM devices")
    count = cnt[0] if cnt else len(rows)
    names = [(r[0] or r[1] or "?") for r in rows]
    return count, names


def _speed():
    row = _db_query("SELECT download_mbps, upload_mbps, ping_ms FROM speed_tests ORDER BY timestamp DESC LIMIT 1")
    hist_rows = _db_query("SELECT download_mbps FROM speed_tests ORDER BY timestamp DESC LIMIT 64", one=False) or []
    hist = [float(r[0]) for r in reversed(hist_rows) if r and r[0] is not None]
    if row:
        return float(row[0]), float(row[1]), float(row[2]), hist
    return None, None, None, hist


def _tunnels():
    rows = _db_query("SELECT location, status FROM vps_servers", one=False) or []
    return [{"name": r[0] or "VPS", "up": r[1] == "connected"} for r in rows]


def _addrs():
    host = subprocess.getoutput("hostname").strip() or "pi5"
    lan = subprocess.getoutput("hostname -I | awk '{print $1}'").strip() or "-"
    gw = subprocess.getoutput("ip route 2>/dev/null | awk '/default/{print $3; exit}'").strip() or "-"
    return host, lan, gw


# İçerik anahtarı → renderer anahtarı (geriye dönük + piroled takma adları)
_KEY_MAP = {
    "hostname": "system", "system": "system", "ip": "system",
    "cpu_ram": "cpu", "cpu": "cpu", "temperature": "cpu", "temp": "cpu", "memory": "cpu",
    "network": "speed", "speed": "speed",
    "devices": "clients", "clients": "clients",
    "vpn": "vpn", "security": "vpn",
    "brand": "brand",
}


def _page_key(page):
    if page.get("type") == "custom":
        return "custom"
    c = str(page.get("content", "")).lower().strip()
    return _KEY_MAP.get(c, "system" if c in ("", "brand") else "custom")


def collect_data(page, demo=False):
    """Bir sayfanın çizim verisini topla. demo=True → offline örnek veri."""
    key = _page_key(page)
    if demo:
        return demo_data(key, page)
    d = {"key": key}
    try:
        if key == "brand":
            cnt, _ = _devices()
            d.update(name="Klyrix", suffix="/gate",
                     tagline=str(page.get("content", "") or ""),
                     clients=cnt, uptime_s=_uptime_s(), filled=False)
        elif key == "cpu":
            used, total, pct = _mem()
            d.update(temp_c=_temp_c(), cpu=_cpu_percent(), mem_pct=pct,
                     mem_used=used, mem_total=total, uptime_s=_uptime_s(),
                     temp_alarm=75)
        elif key == "speed":
            dl, ul, ping, hist = _speed()
            d.update(dl=dl, ul=ul, ping=ping, dl_hist=hist)
        elif key == "clients":
            cnt, names = _devices()
            d.update(count=cnt, names=names)
        elif key == "vpn":
            d.update(tunnels=_tunnels())
        elif key == "system":
            host, lan, gw = _addrs()
            d.update(host=host, lan=lan, gw=gw, uptime_s=_uptime_s())
        else:
            d.update(message=str(page.get("content", "")))
    except Exception as ex:
        log_lcd(f"collect {key} hata: {ex}")
    return d


def demo_data(key, page):
    samples = {
        "brand": dict(name="Klyrix", suffix="/gate", tagline="Secure Gateway",
                      clients=12, uptime_s=95000, filled=False),
        "cpu": dict(temp_c=52.4, cpu=37, mem_pct=61, mem_used=4980,
                    mem_total=8192, uptime_s=95000, temp_alarm=75),
        "speed": dict(dl=284.6, ul=41.2, ping=8,
                      dl_hist=[120, 180, 150, 210, 190, 260, 240, 300, 280,
                               255, 284, 240, 265, 300, 288, 276, 310, 284]),
        "clients": dict(count=12, names=["macbook-pro", "pixel-8", "ps5",
                                         "nas", "iphone", "desk-pc"]),
        "vpn": dict(tunnels=[{"name": "Frankfurt", "up": True},
                             {"name": "Amsterdam", "up": True},
                             {"name": "New York", "up": False}]),
        "system": dict(host="pi5-gateway", lan="192.168.1.153",
                       gw="192.168.1.1", uptime_s=95000),
        "custom": dict(message=str(page.get("content") or "Klyrix Gate")),
    }
    return samples.get(key, samples["custom"])


# ── Sayfa renderer'ları (draw, img, data, p, t) ─────────────────────────────
# p: giriş animasyonu 0..1 (eased) · t: geçen saniye (sürekli anim)
def render_brand(draw, img, data, p, t):
    TILE, TILE_X, TILE_Y, MARK_H = 40, 2, 11, 23
    filled = bool(data.get("filled"))
    lw.klyrix_tile(draw, TILE_X, TILE_Y, TILE,
                   reveal=lw.ease_out_cubic(lw.clamp(p / 0.35)), filled=filled)
    lw.klyrix_mark(draw, TILE_X + TILE // 2, TILE_Y + TILE // 2, MARK_H,
                   reveal=lw.clamp((p - 0.15) / 0.65), ink=0 if filled else 1)
    wp = lw.ease_out_cubic(lw.clamp((p - 0.60) / 0.40))
    tx = TILE_X + TILE + 8
    if wp > 0:
        off = int(round((1 - wp) * (lw.WIDTH - tx)))
        lw.text(draw, (tx + off, 13), data.get("name", "Klyrix"), lw.load(19, bold=True))
        if lw.has_true_italic():
            lw.text(draw, (tx + off, 32), data.get("suffix", "/gate"),
                    lw.load(15, bold=True, italic=True))
        else:
            lw.text_oblique(draw, (tx + off, 32), data.get("suffix", "/gate"),
                            lw.load(15, bold=True), img=img)
    if p >= 0.99:
        bits = []
        if data.get("tagline"):
            bits.append(str(data["tagline"]))
        if data.get("clients") is not None:
            bits.append(f"{data['clients']} clients")
        if data.get("uptime_s"):
            bits.append("up " + lw.human_uptime(data["uptime_s"]))
        line = "  ·  ".join(bits)
        if line:
            lw.text(draw, (lw.WIDTH - lw.SAFE, 52),
                    lw.fit(draw, line, lw.f_label(), lw.SAFE_W), lw.f_label(), "rt")


def render_cpu(draw, img, data, p, t):
    over = data.get("temp_c", 0) >= data.get("temp_alarm", 75)
    blink = over and int(t * 2) % 2 == 0
    lw.header(draw, "SISTEM", right="up " + lw.human_uptime(data.get("uptime_s")))
    cx, cy, r = 24, 40, 19
    if not blink:
        lw.arc_gauge(draw, cx, cy, r, lw.clamp(data.get("temp_c", 0) / 90.0) * p, thickness=4)
        lw.text(draw, (cx, cy - 2), f"{int(round(data.get('temp_c', 0) * p))}", lw.f_value(), "cm")
        lw.text(draw, (cx, cy + 10), "C", lw.f_label(), "cm")
    bx, bw = 52, 72
    lw.text(draw, (bx, 16), "CPU", lw.f_label())
    lw.text(draw, (bx + bw, 16), f"{int(round(data.get('cpu', 0) * p))}%", lw.f_label(), "rt")
    lw.hbar(draw, bx, 26, bw, 9, lw.clamp(data.get("cpu", 0) / 100.0) * p, segments=12)
    lw.text(draw, (bx, 40), "RAM", lw.f_label())
    lw.text(draw, (bx + bw, 40), f"{int(round(data.get('mem_pct', 0) * p))}%", lw.f_label(), "rt")
    lw.hbar(draw, bx, 50, bw, 9, lw.clamp(data.get("mem_pct", 0) / 100.0) * p, segments=12)


def render_speed(draw, img, data, p, t):
    lw.header(draw, "INTERNET", right="Mbps")
    hist = data.get("dl_hist") or []
    if hist:
        lw.sparkline(draw, lw.SAFE, 15, lw.SAFE_W, 25, hist, vmin=0, fill=True, baseline=True)
    dl, ul, ping = data.get("dl"), data.get("ul"), data.get("ping")
    if dl is not None:
        lw.text(draw, (lw.SAFE, 45), f"DL {dl * p:.0f}", lw.f_body())
        lw.text(draw, (60, 45), f"UL {ul * p:.0f}", lw.f_body())
        lw.text(draw, (lw.WIDTH - lw.SAFE, 45), f"{ping:.0f}ms", lw.f_body(), "rt")
    else:
        lw.text(draw, (lw.WIDTH // 2, 42), "Veri yok", lw.f_body(), "cm")


def render_clients(draw, img, data, p, t):
    n = int(data.get("count", 0))
    lw.header(draw, "CIHAZLAR", right=f"{n}")
    shown = int(round(n * p))
    lw.text(draw, (30, 34), str(shown), lw.f_hero(26), "cm")
    lw.text(draw, (30, 52), "cihaz", lw.f_label(), "cm")
    cols, rows = 8, 4
    lw.dot_grid(draw, 68, 18, cols, rows, min(n, cols * rows), cell=6, dot=3, progress=p)
    names = data.get("names") or []
    if names and p >= 0.6:
        idx = int(t / 2) % len(names)
        lw.text_badge(draw, (66, 46), lw.fit(draw, names[idx], lw.f_label(), 58), lw.f_label())


def render_vpn(draw, img, data, p, t):
    tunnels = data.get("tunnels") or []
    conn = sum(1 for x in tunnels if x.get("up"))
    total = len(tunnels)
    frac = (conn / total) if total else 0.0
    lw.header(draw, "GUVENLIK", right=f"{conn}/{total}")
    lw.icon_shield(draw, 6, 16, w=24, h=30, frac=frac * p, img=img)
    if not tunnels:
        lw.text(draw, (40, 30), "Tunel yok", lw.f_body())
        return
    for i, x in enumerate(tunnels[:3]):
        if lw.clamp((p - i * 0.12) / 0.3) <= 0:
            continue
        yy = 16 + i * 14
        gx = 38
        if x.get("up"):
            lw.icon_check(draw, gx, yy + 2, 9)
        elif int(t * 2) % 2 == 0:
            lw.icon_cross(draw, gx, yy + 2, 9)
        lw.text(draw, (gx + 13, yy), lw.fit(draw, str(x.get("name", "?")), lw.f_body(),
                                            lw.WIDTH - (gx + 13) - lw.SAFE), lw.f_body())


def render_system(draw, img, data, p, t):
    lw.header(draw, "AG ADRESLERI", right=lw.fit(draw, str(data.get("host", "")), lw.f_label(), 60))
    slide = lw.clamp(lw.ease_out_back(p))
    xoff = int((1 - slide) * lw.WIDTH)
    lw.text(draw, (lw.SAFE - xoff, 18), f"LAN {data.get('lan', '-')}", lw.f_body())
    lw.text(draw, (lw.WIDTH - lw.SAFE + xoff, 32), f"GW {data.get('gw', '-')}", lw.f_body(), "rt")
    if p >= 0.99:
        lw.text(draw, (lw.SAFE, 50), "up " + lw.human_uptime(data.get("uptime_s")), lw.f_label())


def render_custom(draw, img, data, p, t):
    msg = str(data.get("message", "") or "")
    f = lw.f_value()
    if lw.text_size(draw, msg, f)[0] <= lw.SAFE_W:
        lw.text(draw, (lw.WIDTH // 2, lw.HEIGHT // 2), msg, f, "cm")
    else:
        lw.marquee(draw, (lw.SAFE, lw.HEIGHT // 2 - 8), lw.SAFE_W, msg, f, t=t, img=img)


RENDERERS = {
    "brand": render_brand, "cpu": render_cpu, "speed": render_speed,
    "clients": render_clients, "vpn": render_vpn, "system": render_system,
    "custom": render_custom,
}
INTRO_TIME = {"brand": 1.6, "system": 1.0, "cpu": 1.2, "speed": 1.0,
              "clients": 1.2, "vpn": 1.3, "custom": 0.6}


def render_page(device, page, duration):
    """Bir sayfayı `duration` sn boyunca zengin animasyonla OLED'e çiz."""
    from PIL import Image, ImageDraw
    key = _page_key(page)
    renderer = RENDERERS.get(key, render_custom)
    data = collect_data(page)
    intro = INTRO_TIME.get(key, 1.2)
    anim = os.environ.get("PI5_LCD_ANIM", "1") != "0"
    W, H = lw.WIDTH, lw.HEIGHT
    start = time.time()
    while True:
        t = time.time() - start
        if t >= duration:
            break
        p = lw.ease_out_cubic(min(1.0, t / intro)) if anim else 1.0
        tt = t if anim else 999.0
        img = Image.new("1", (W, H), 0)
        draw = ImageDraw.Draw(img)
        try:
            renderer(draw, img, data, p, tt)
        except Exception as ex:
            log_lcd(f"render {key} hata: {ex}")
            lw.text(draw, (2, 2), str(ex)[:20], lw.f_label())
        device.display(img)
        if not anim:
            time.sleep(max(0.0, duration - (time.time() - start)))
            break
        time.sleep(1.0 / FPS)


# ── HD44780 / console için düz-metin görünüm (grafik yok) ────────────────────
def _flatten(view):
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
    """HD44780/console için düz {title, rows} görünümü (OLED zengin yolu kullanmaz)."""
    try:
        c = str(content_type).lower()
        if c in ("hostname", "system", "ip", "brand"):
            host, lan, gw = _addrs()
            title = "KLYRIX/GATE" if c == "brand" else "SISTEM"
            return {"title": title, "rows": [
                ("text", host), ("text", "IP " + lan), ("text", "GW " + gw)]}
        if c in ("cpu_ram", "cpu", "temperature", "memory", "temp"):
            used, total, pct = _mem()
            return {"title": "CPU / RAM", "rows": [
                ("bar", "CPU", _cpu_percent()),
                ("text", f"Sicaklik {_temp_c():.0f}C"),
                ("bar", "RAM", pct),
                ("text", f"{used}/{total} MB")]}
        if c in ("network", "speed"):
            dl, ul, ping, _ = _speed()
            if dl is not None:
                return {"title": "AG / HIZ", "rows": [
                    ("text", f"DL {dl:.1f} Mbps"), ("text", f"UL {ul:.1f} Mbps"),
                    ("text", f"Ping {ping:.0f} ms")]}
            return {"title": "AG / HIZ", "rows": [("text", "Veri yok")]}
        if c in ("devices", "clients"):
            n, _ = _devices()
            return {"title": "CIHAZLAR", "rows": [("text", f"Aktif {n} cihaz")]}
        if c in ("vpn", "security"):
            tuns = _tunnels()
            if not tuns:
                return {"title": "VPN", "rows": [("text", "Tunel yok")]}
            conn = sum(1 for r in tuns if r["up"])
            out = [("text", f"Bagli {conn}/{len(tuns)}")]
            for r in tuns[:3]:
                out.append(("text", f"{'+' if r['up'] else '-'} {r['name']}"[:20]))
            return {"title": "VPN", "rows": out}
        return {"title": str(content_type)[:20].upper(), "rows": [("text", "")]}
    except Exception as e:
        return {"title": "HATA", "rows": [("text", str(e)[:20])]}


def build_view(page):
    if page.get("type") == "custom":
        text = str(page.get("content", ""))
        rows = []
        while text and len(rows) < 4:
            rows.append(("text", text[:21]))
            text = text[21:]
        return {"title": "MESAJ", "rows": rows or [("text", "")]}
    return build_system_view(page.get("content", ""))


def _make_oled(controller):
    """luma OLED (ssd1306 0.96" / sh1106 1.3"). Zengin render device.display(img) ile."""
    if lw is None:
        raise RuntimeError("Pillow/lcd_widgets yok — OLED render devre dışı")
    from luma.core.interface.serial import i2c
    from PIL import Image, ImageDraw

    port = int(os.environ.get('PI5_LCD_I2C_PORT', '1') or 1)
    addr = int(os.environ.get('PI5_LCD_ADDR', '0x3C'), 0)
    width = lw.WIDTH
    height = lw.HEIGHT

    serial = i2c(port=port, address=addr)
    if controller == 'sh1106':
        from luma.oled.device import sh1106
        device = sh1106(serial, width=width, height=height)
    else:
        from luma.oled.device import ssd1306
        device = ssd1306(serial, width=width, height=height)

    class OLEDDisplay:
        controller_name = controller

        def show(self, lines):
            img = Image.new("1", (width, height), 0)
            draw = ImageDraw.Draw(img)
            for i, line in enumerate(lines[:5]):
                lw.text(draw, (2, i * 12), str(line), lw.f_body())
            device.display(img)

        def animate(self, page, duration):
            try:
                render_page(device, page, duration)
            except Exception as ex:
                log_lcd(f"animate hata: {ex}")
                try:
                    self.show(_flatten(build_view(page)))
                except Exception:
                    pass
                time.sleep(duration)

        def clear(self):
            device.clear()

    return OLEDDisplay()


def get_display():
    """Init a display. Controller: DB 'lcd_controller' veya env (ssd1306|sh1106|auto)."""
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

            def animate(self, page, duration):
                view = build_view(page)
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

    class ConsoleDisplay:
        controller_name = 'console'

        def show(self, lines):
            try:
                print("┌──────────────────┐")
                for line in lines[:4]:
                    print(f"│ {str(line)[:16]:16} │")
                print("└──────────────────┘", flush=True)
            except (BrokenPipeError, OSError):
                pass

        def animate(self, page, duration):
            view = build_view(page)
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
        display.animate(page, page.get("duration", 5))
        page_idx += 1


# ── Offline önizleme (cihazsız; yalnızca Pillow) ─────────────────────────────
def _preview(argv):
    if lw is None:
        print("Pillow gerekli: pip3 install Pillow")
        sys.exit(1)
    from PIL import Image, ImageDraw, ImageOps

    opts = {"scale": 4, "seconds": 5.0, "fps": FPS, "page": "brand"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--sheet":
            opts["sheet"] = argv[i + 1]; i += 2
        elif a == "--gif":
            opts["gif"] = argv[i + 1]; i += 2
        elif a in ("-p", "--page"):
            opts["page"] = argv[i + 1]; i += 2
        elif a == "--seconds":
            opts["seconds"] = float(argv[i + 1]); i += 2
        elif a == "--scale":
            opts["scale"] = int(argv[i + 1]); i += 2
        elif a == "--fps":
            opts["fps"] = int(argv[i + 1]); i += 2
        elif a == "--invert":
            opts["invert"] = True; i += 1
        else:
            i += 1

    scale = opts["scale"]

    def make_page(key):
        return {"type": "custom", "content": "Klyrix Gate"} if key == "custom" \
            else {"type": "system", "content": key}

    def frame(key, p, t):
        img = Image.new("1", (lw.WIDTH, lw.HEIGHT), 0)
        draw = ImageDraw.Draw(img)
        data = collect_data(make_page(key), demo=True)
        RENDERERS.get(key, render_custom)(draw, img, data, p, t)
        return img

    def scaled(img):
        im = img.convert("L")
        if opts.get("invert"):
            im = ImageOps.invert(im)
        return im.resize((im.width * scale, im.height * scale), Image.NEAREST)

    keys = ["brand", "system", "cpu", "speed", "clients", "vpn", "custom"]

    if "gif" in opts:
        key = opts["page"] if opts["page"] in RENDERERS else "brand"
        secs, fps = opts["seconds"], opts["fps"]
        intro = INTRO_TIME.get(key, 1.2)
        frames = []
        for n in range(int(secs * fps)):
            t = n / fps
            p = lw.ease_out_cubic(min(1.0, t / intro))
            frames.append(scaled(frame(key, p, t)).convert("P"))
        frames[0].save(opts["gif"], save_all=True, append_images=frames[1:],
                       duration=int(1000 / fps), loop=0)
        print("GIF yazildi:", opts["gif"])

    if "sheet" in opts:
        imgs = [scaled(frame(k, 1.0, 3.0)) for k in keys]
        gap = 8
        bg = 255 if opts.get("invert") else 0
        W = max(im.width for im in imgs)
        H = sum(im.height for im in imgs) + gap * (len(imgs) - 1)
        sheet = Image.new("L", (W, H), bg)
        y = 0
        for im in imgs:
            sheet.paste(im, (0, y)); y += im.height + gap
        sheet.save(opts["sheet"])
        print("Sheet yazildi:", opts["sheet"], f"({len(keys)} sayfa)")

    if "gif" not in opts and "sheet" not in opts:
        print("Kullanim: preview --sheet out.png [--scale 4] | "
              "--gif out.gif -p brand [--seconds 5] [--scale 6] [--invert]")


def main():
    if len(sys.argv) < 2:
        print("Usage: lcd_display.py [run|start|stop|status|detect|test|preview]")
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
            except Exception:
                print("LCD display calismıyor (eski PID dosyası)")
        else:
            print("LCD display calismıyor")

    elif cmd == "start":
        kill_existing()
        pid = os.fork()
        if pid > 0:
            print(f"LCD display baslatildi (PID: {pid})")
            return
        else:
            os.setsid()
            run_display()

    elif cmd == "run":
        kill_existing()
        run_display()

    elif cmd == "detect":
        display = get_display()
        name = getattr(display, 'controller_name', '?')
        print(f"display={name}")
        sys.exit(0 if name != 'console' else 2)

    elif cmd == "test":
        display = get_display()
        name = getattr(display, 'controller_name', '?')
        print(f"display={name}")
        if name == 'console':
            print("UYARI: Fiziksel ekran bulunamadi. Detay: /tmp/lcd_display.log")
            sys.exit(2)
        page_key = sys.argv[2] if len(sys.argv) > 2 else "brand"
        print(f"Animasyonlu test 5sn gorunecek ({page_key})...")
        display.animate({"type": "system", "content": page_key}, 5)
        sys.exit(0)

    elif cmd == "preview":
        _preview(sys.argv[2:])

    else:
        print(f"Bilinmeyen komut: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

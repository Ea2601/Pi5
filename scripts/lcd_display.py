#!/usr/bin/env python3
"""
LCD Display Controller — Pi5 Gateway kasa OLED'i (Pironman / Pimoroni).

Kasada sırayla dönen çok-sayfalı, animasyonlu bilgi ekranı. OLED render'ı
Klyrix 1-bit motoruyla (scripts/klyrix_oled.py) yapılır: marka açılışı, termometre,
sparkline, yay göstergesi, nokta ızgarası, güvenlik listesi ve sayfalar arası
yatay kaydırma geçişi. HD44780 16x2 ve konsol için düz-metin görünüm korunur.

Yapılandırma tamamen panelden (Kasa Kontrol) gelir, DB app_settings üzerinden:
  lcd_pages      sayfa sırası / süresi / aktifliği + özel metin
  lcd_controller ssd1306 | sh1106 | auto
  lcd_settings   WAN arayüzü, sıcaklık alarmı, FPS, animasyon, I2C adres/port,
                 disk birimleri — apply_settings() bunları PI5_LCD_* env'lerine yazar
Elle verilmiş bir PI5_LCD_* env'i (systemd/kabuk) panel ayarının önüne geçer.

Usage:
  python3 lcd_display.py run              # Foreground daemon (systemd Type=simple)
  python3 lcd_display.py start            # Fork daemon
  python3 lcd_display.py stop             # Stop daemon
  python3 lcd_display.py status           # Show current state
  python3 lcd_display.py detect           # Exit 0 gerçek ekran, 2 console fallback
  python3 lcd_display.py test [sayfa]     # 6s animasyonlu test (varsayılan: brand)
  python3 lcd_display.py preview ...      # Cihazsız PNG/GIF üret (Pillow yeter)

  # Önizleme örnekleri (masaüstünde, luma/I2C gerekmez):
  python3 lcd_display.py preview --sheet sayfalar.png --scale 4
  python3 lcd_display.py preview --gif temp.gif -p temp --seconds 8 --scale 6

Sayfa id'leri: brand temp ram disk inet net clients sec msg
Supports: SSD1306 / SH1106 OLED (128x64), HD44780 16x2 via I2C, console fallback.
Env (panel ayarını ezmek için): PI5_LCD_CONTROLLER=ssd1306|sh1106|auto, PI5_LCD_ADDR,
     PI5_LCD_ANIM=0 (statik), PI5_LCD_I2C_PORT, PI5_LCD_FPS, PI5_LCD_WAN_IF,
     PI5_LCD_TEMP_ALARM, PI5_LCD_MOUNTS.
Requires: pip3 install luma.oled luma.core Pillow  (OLED)  |  RPLCD (HD44780)
"""

import sys
import os
import json
import time
import signal
import subprocess

# Script dizinini import yoluna ekle (klyrix_oled aynı klasörde).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import klyrix_oled as ko
except Exception:
    ko = None  # Pillow yoksa yalnızca HD44780/console yolu çalışır.

PID_FILE = "/tmp/lcd_display.pid"
CONFIG_FILE = "/opt/pi5-gateway/core/pi5router.sqlite"
PAGES_KEY = "lcd_pages"
CONTROLLER_KEY = "lcd_controller"
SETTINGS_KEY = "lcd_settings"
LOG_FILE = "/tmp/lcd_display.log"
FPS = int(os.environ.get("PI5_LCD_FPS", "10") or 10)
CONFIG_POLL = 60  # sn — panelden değişen sayfa yapılandırmasını yeniden oku
# Her karede en az bu kadar bekle. 100 kHz I2C'de tam kare (~1 KB) ~100 ms sürer;
# beklemesiz döngü yarım kalan transferin üstüne yazıp görüntüyü bozar (üst üste binme).
# I2C 400 kHz'e çıkarılırsa (dtparam=i2c_arm_baudrate=400000) FPS güvenle yükseltilebilir.
MIN_FRAME_SLEEP = 0.005

# Panelden yönetilen motor ayarları. Değerler klyrix_oled'in okuduğu env'lere yazılır;
# elle verilmiş bir PI5_LCD_* env'i (systemd/kabuk) her zaman panelin önüne geçer.
DEFAULT_SETTINGS = {
    "wan_if": "eth0",          # internet sayfasının canlı DL/UL grafiği bu arayüzden okunur
    "temp_alarm": 75,          # °C — sıcaklık sayfasındaki alarm eşiği
    "fps": 10,                 # kare/sn — 100 kHz I2C'nin taşıyabildiği üst sınır
    "anim": True,              # False: animasyonsuz statik sayfa döngüsü
    "i2c_addr": "0x3C",
    "i2c_port": 1,
    "mounts": [                # disk sayfasındaki birimler (ad → yol)
        {"name": "ROOT", "path": "/"},
        {"name": "BOOT", "path": "/boot/firmware"},
    ],
}
SETTINGS_ENV = {
    "wan_if": "PI5_LCD_WAN_IF", "temp_alarm": "PI5_LCD_TEMP_ALARM", "fps": "PI5_LCD_FPS",
    "anim": "PI5_LCD_ANIM", "i2c_addr": "PI5_LCD_ADDR", "i2c_port": "PI5_LCD_I2C_PORT",
    "mounts": "PI5_LCD_MOUNTS",
}
# Süreç başlarken dışarıdan gelen env'ler — panel ayarı bunları ezmez.
_ENV_OVERRIDES = {k for k, e in SETTINGS_ENV.items() if os.environ.get(e)}


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
        {"id": "cpu", "type": "system", "content": "cpu_ram", "duration": 10, "enabled": True},
        {"id": "disk", "type": "system", "content": "disk", "duration": 10, "enabled": True},
        {"id": "network", "type": "system", "content": "network", "duration": 10, "enabled": True},
        {"id": "hostname", "type": "system", "content": "hostname", "duration": 10, "enabled": True},
        {"id": "devices", "type": "system", "content": "devices", "duration": 10, "enabled": True},
        {"id": "vpn", "type": "system", "content": "vpn", "duration": 10, "enabled": True},
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


def get_settings():
    """Panelden kaydedilen motor ayarları (app_settings.lcd_settings) + varsayılanlar."""
    s = dict(DEFAULT_SETTINGS)
    s["mounts"] = [dict(m) for m in DEFAULT_SETTINGS["mounts"]]
    try:
        import sqlite3
        db = sqlite3.connect(CONFIG_FILE)
        row = db.execute("SELECT value FROM app_settings WHERE key = ?", (SETTINGS_KEY,)).fetchone()
        db.close()
        if row and row[0]:
            saved = json.loads(row[0])
            if isinstance(saved, dict):
                for k in DEFAULT_SETTINGS:
                    if saved.get(k) is not None:
                        s[k] = saved[k]
    except Exception as ex:
        log_lcd(f"lcd_settings okunamadi ({ex}) — varsayilanlar")
    return s


def _int_or(value, dflt):
    """0 geçerli bir ayar değeri (I2C bus 0) — 'or' ile fallback yapılamaz."""
    try:
        return dflt if value is None or value == "" else int(value)
    except (TypeError, ValueError):
        return dflt


def apply_settings(s):
    """Ayarları motorun okuduğu env'lere yaz. Elle verilmiş env'ler korunur."""
    global FPS
    FPS = max(1, min(60, _int_or(s.get("fps"), 10)))
    mounts = ",".join(
        f"{str(m.get('name', '')).strip().upper()[:6]}={str(m.get('path', '')).strip()}"
        for m in (s.get("mounts") or [])
        if str(m.get("name", "")).strip() and str(m.get("path", "")).strip()
    )
    values = {
        "wan_if": str(s.get("wan_if") or "eth0"),
        "temp_alarm": str(_int_or(s.get("temp_alarm"), 75)),
        "fps": str(FPS),
        "anim": "1" if s.get("anim", True) else "0",
        "i2c_addr": str(s.get("i2c_addr") or "0x3C"),
        "i2c_port": str(_int_or(s.get("i2c_port"), 1)),
        "mounts": mounts,
    }
    for key, env in SETTINGS_ENV.items():
        if key in _ENV_OVERRIDES:
            continue  # dışarıdan verilmiş env panelin önünde
        if key == "mounts" and not mounts:
            # Boş liste = motorun kendi varsayılan mount seti. Env'i temizle ki
            # önceki ayardan kalan liste çalışma sırasında yapışıp kalmasın.
            os.environ.pop(env, None)
            continue
        os.environ[env] = values[key]
    return values


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


# ── Sayfa eşlemesi: panel içerik anahtarı → motor sayfa id'leri ──────────────
# Bir panel sayfası birden fazla motor sayfasına açılabilir (cpu_ram → temp + ram).
_KEY_MAP = {
    "brand": ["brand"],
    "hostname": ["net"], "system": ["net"], "ip": ["net"], "net": ["net"],
    "cpu_ram": ["temp", "ram"],
    "cpu": ["temp"], "temperature": ["temp"], "temp": ["temp"],
    "memory": ["ram"], "ram": ["ram"],
    "disk": ["disk"], "storage": ["disk"],
    "network": ["inet"], "speed": ["inet"], "internet": ["inet"], "inet": ["inet"],
    "devices": ["clients"], "clients": ["clients"],
    "vpn": ["sec"], "security": ["sec"], "sec": ["sec"],
    "message": ["msg"], "msg": ["msg"],
}


def _page_key(page):
    """Panel sayfasının motor id'leri. Bilinmeyen içerik → serbest metin sayfası."""
    if str(page.get("type")) == "custom":
        return ["msg"]
    c = str(page.get("content", "")).lower().strip()
    return _KEY_MAP.get(c) or ["msg"]


def build_engine_pages(db_pages):
    """Panel yapılandırmasını motor sayfa listesine çevir (etkin olanlar, sırayla)."""
    out = []
    for pg in db_pages or []:
        if not pg.get("enabled", True):
            continue
        dwell = float(pg.get("duration") or 5)
        ids = _page_key(pg)
        content = str(pg.get("content", "") or "")
        for pid in ids:
            # 'msg' sayfası metnini panel içeriğinden alır (custom sayfa ya da bilinmeyen anahtar).
            out.append(ko.page(pid, dwell, message=content if pid == "msg" else None))
    return out


def _pages_signature(pages):
    return [(p["id"], p["dwell"], p.get("message")) for p in pages]


# ── Veri toplayıcılar (HD44780 / konsol düz-metin yolu) ──────────────────────
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
    if row:
        return float(row[0] or 0), float(row[1] or 0), float(row[2] or 0)
    return None, None, None


def _tunnels():
    rows = _db_query("SELECT location, status FROM vps_servers", one=False) or []
    return [{"name": r[0] or "VPS", "up": r[1] == "connected"} for r in rows]


def _addrs():
    host = subprocess.getoutput("hostname").strip() or "pi5"
    lan = subprocess.getoutput("hostname -I | awk '{print $1}'").strip() or "-"
    gw = subprocess.getoutput("ip route 2>/dev/null | awk '/default/{print $3; exit}'").strip() or "-"
    return host, lan, gw


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
        if c in ("hostname", "system", "ip", "brand", "net"):
            host, lan, gw = _addrs()
            title = "KLYRIX/GATE" if c == "brand" else "SISTEM"
            return {"title": title, "rows": [
                ("text", host), ("text", "IP " + lan), ("text", "GW " + gw)]}
        if c in ("cpu_ram", "cpu", "temperature", "memory", "temp", "ram"):
            used, total, pct = _mem()
            return {"title": "CPU / RAM", "rows": [
                ("bar", "CPU", _cpu_percent()),
                ("text", f"Sicaklik {_temp_c():.0f}C"),
                ("bar", "RAM", pct),
                ("text", f"{used}/{total} MB")]}
        if c in ("disk", "storage"):
            import shutil
            rows = []
            for name, path in (ko._mounts() if ko else [("ROOT", "/")]):
                try:
                    u = shutil.disk_usage(path)
                    rows.append(("bar", name, int(u.used * 100 / u.total)))
                except Exception:
                    pass
            return {"title": "DISK", "rows": rows or [("text", "Veri yok")]}
        if c in ("network", "speed", "internet", "inet"):
            dl, ul, ping = _speed()
            if dl is not None:
                return {"title": "AG / HIZ", "rows": [
                    ("text", f"DL {dl:.1f} Mbps"), ("text", f"UL {ul:.1f} Mbps"),
                    ("text", f"Ping {ping:.0f} ms")]}
            return {"title": "AG / HIZ", "rows": [("text", "Veri yok")]}
        if c in ("devices", "clients"):
            n, _ = _devices()
            return {"title": "CIHAZLAR", "rows": [("text", f"Aktif {n} cihaz")]}
        if c in ("vpn", "security", "sec"):
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
    if str(page.get("type")) == "custom":
        text = str(page.get("content", ""))
        rows = []
        while text and len(rows) < 4:
            rows.append(("text", text[:21]))
            text = text[21:]
        return {"title": "MESAJ", "rows": rows or [("text", "")]}
    return build_system_view(page.get("content", ""))


# ── OLED (zengin motor) ──────────────────────────────────────────────────────
def _make_oled(controller):
    """luma OLED (ssd1306 0.96" / sh1106 1.3"). Render Klyrix 1-bit motoruyla."""
    if ko is None:
        raise RuntimeError("Pillow/klyrix_oled yok — OLED render devre dışı")
    device = ko.make_device(controller)

    class OLEDDisplay:
        controller_name = controller

        def __init__(self):
            self.device = device
            self.src = None

        def _source(self):
            if self.src is None:
                self.src = ko.Live()
            return self.src

        def show(self, lines):
            """Düz metin (yalnızca hata/uyarı durumları için)."""
            fb = ko.FB()
            for i, line in enumerate(lines[:6]):
                fb.text(2, 2 + i * 10, str(line)[:21])
            device.display(fb.image())

        def loop(self):
            """Sürekli saat: sayfalar arası geçiş animasyonlu, config canlı yenilenir."""
            src = self._source()
            pages = build_engine_pages(get_pages()) or ko.pages_spec()
            player = ko.Player(src, pages)
            clock, last, last_cfg = 0.0, time.time(), time.time()
            while True:
                now = time.time()
                dt = min(0.1, max(0.0, now - last))
                last = now
                clock += dt
                if now - last_cfg > CONFIG_POLL:
                    last_cfg = now
                    # temp_alarm / mounts / fps anında etkili; wan_if ve I2C adresi
                    # yalnızca servis yeniden başlayınca (panel kaydı zaten restart eder).
                    apply_settings(get_settings())
                    fresh = build_engine_pages(get_pages())
                    if fresh and _pages_signature(fresh) != _pages_signature(player.pages):
                        player.pages = fresh
                        player.cur = None  # geçiş animasyonunu atla, temiz başla
                        clock = 0.0
                        log_lcd(f"sayfa yapilandirmasi yenilendi: {[p['id'] for p in fresh]}")
                src.step(dt)
                try:
                    device.display(player.frame(clock).image())
                except Exception as ex:
                    log_lcd(f"render hata: {ex}")
                    time.sleep(0.5)
                time.sleep(max(MIN_FRAME_SLEEP, 1.0 / FPS - (time.time() - now)))

        def animate(self, page, duration):
            """Tek sayfayı `duration` sn oynat (test komutu / statik mod)."""
            try:
                src = self._source()
                pages = build_engine_pages([dict(page, enabled=True, duration=duration)]) \
                    or [ko.page('msg', duration, message=str(page.get('content', '')))]
                player = ko.Player(src, pages)
                anim = os.environ.get("PI5_LCD_ANIM", "1") != "0"
                if not anim:
                    src.step(0.1)
                    device.display(player.frame(duration - 0.01).image())
                    time.sleep(duration)
                    return
                start, last = time.time(), time.time()
                while True:
                    now = time.time()
                    t = now - start
                    if t >= duration:
                        break
                    src.step(min(0.1, max(0.0, now - last)))
                    last = now
                    device.display(player.frame(t).image())
                    time.sleep(max(MIN_FRAME_SLEEP, 1.0 / FPS - (time.time() - now)))
            except Exception as ex:
                log_lcd(f"animate hata: {ex}")
                try:
                    self.show([str(build_view(page).get("title", ""))] + _flatten(build_view(page)))
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
    """Main display loop. OLED: tek sürekli saat; diğerleri: sayfa sayfa döngü."""
    write_pid()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    apply_settings(get_settings())

    display = get_display()

    # Zengin OLED yolu — sayfa geçişleri ve canlı veri motorun içinde akar.
    if hasattr(display, 'loop') and os.environ.get("PI5_LCD_ANIM", "1") != "0":
        display.loop()
        return

    last_config_check = 0
    pages = [p for p in get_pages() if p.get("enabled", True)]
    page_idx = 0

    while True:
        if time.time() - last_config_check > CONFIG_POLL:
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
    if ko is None:
        print("Pillow gerekli: pip3 install Pillow")
        sys.exit(1)
    from PIL import Image, ImageOps

    opts = {"scale": 4, "seconds": 8.0, "fps": FPS, "page": "temp", "alarm": False}
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
        elif a == "--alarm":
            opts["alarm"] = True; i += 1
        elif a == "--invert":
            opts["invert"] = True; i += 1
        else:
            i += 1

    scale = opts["scale"]
    src = ko.Demo(alarm=opts["alarm"])
    pages = ko.pages_spec(float(os.environ.get("PI5_LCD_DWELL", "10") or 10))
    player = ko.Player(src, pages)

    def scaled(fb):
        im = fb.image().convert("L")
        if opts.get("invert"):
            im = ImageOps.invert(im)
        return im.resize((ko.W * scale, ko.H * scale), Image.NEAREST)

    if "gif" in opts:
        pg = next((p for p in pages if p["id"] == opts["page"]), pages[1])
        fps = opts["fps"]
        frames = []
        for n in range(int(opts["seconds"] * fps)):
            src.step(1.0 / fps)
            fb = ko.FB()
            pg["fn"](fb, player.ctx(pg, n / fps, src.data()))
            frames.append(scaled(fb).convert("P"))
        frames[0].save(opts["gif"], save_all=True, append_images=frames[1:],
                       duration=int(1000 / fps), loop=0)
        print("GIF yazildi:", opts["gif"], f"({pg['id']})")

    if "sheet" in opts:
        D = src.data()
        imgs = []
        for pg in pages:
            fb = ko.FB()
            # Giriş animasyonu bitmiş, döngü animasyonu ortasında bir an yakala.
            tt = max(pg["intro"] + 0.95, pg["dwell"] - 3.5)
            pg["fn"](fb, player.ctx(pg, tt, D))
            imgs.append(scaled(fb))
        gap = 8
        bg = 255 if opts.get("invert") else 0
        W = max(im.width for im in imgs)
        H = sum(im.height for im in imgs) + gap * (len(imgs) - 1)
        sheet = Image.new("L", (W, H), bg)
        y = 0
        for im in imgs:
            sheet.paste(im, (0, y)); y += im.height + gap
        sheet.save(opts["sheet"])
        print("Sheet yazildi:", opts["sheet"], f"({len(imgs)} sayfa)")

    if "gif" not in opts and "sheet" not in opts:
        print("Kullanim: preview --sheet out.png [--scale 4] [--alarm] | "
              "--gif out.gif -p temp [--seconds 8] [--scale 6] [--invert]")
        print("Sayfalar:", " ".join(ko.PAGE_ORDER))


def main():
    if len(sys.argv) < 2:
        print("Usage: lcd_display.py [run|start|stop|status|detect|test|preview]")
        sys.exit(1)

    cmd = sys.argv[1]
    apply_settings(get_settings())

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
        print(f"Animasyonlu test 6sn gorunecek ({page_key})...")
        display.animate({"type": "system", "content": page_key}, 6)
        sys.exit(0)

    elif cmd == "preview":
        _preview(sys.argv[2:])

    else:
        print(f"Bilinmeyen komut: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()

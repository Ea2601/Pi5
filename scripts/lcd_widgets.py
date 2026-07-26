#!/usr/bin/env python3
"""1-bit çizim motoru — Pi5 Gateway kasa OLED'i (SSD1306/SH1106, 128x64) için.

Kaynak: Klyrix "piroled" paketinin widget/marka motoru, tek dosyada toplanıp
projenin mevcut lcd_display.py altyapısına (luma device + SQLite config + systemd)
uyumlu hale getirildi. Paketin ayrı `theme` / `anim` / `collectors` modülleri
buraya gömüldü; harici bağımlılık yalnızca Pillow.

Her şey mode "1" (tek bit) PIL görüntüsüne `fill=1` ile çizer. Gri yok, kenar
yumuşatma yok — 0.17 mm piksel adımında şekiller siluet olarak okunmalı.
"""
from __future__ import annotations

import math
import os

# ── Panel geometrisi ────────────────────────────────────────────────────────
WIDTH = int(os.environ.get("PI5_LCD_WIDTH", "128") or 128)
HEIGHT = int(os.environ.get("PI5_LCD_HEIGHT", "64") or 64)
SAFE = 2                      # her kenardan güvenli boşluk (burn-in kayması ±1 px)
SAFE_W = WIDTH - 2 * SAFE


# ── Easing / interpolasyon (piroled anim.py yeniden kuruldu) ────────────────
def clamp(x, lo=0.0, hi=1.0):
    return lo if x < lo else hi if x > hi else x


def lerp(a, b, t):
    return a + (b - a) * t


def ease_out_cubic(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_in_out_cubic(t):
    t = clamp(t)
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def ease_out_quad(t):
    t = clamp(t)
    return 1 - (1 - t) * (1 - t)


def ease_out_back(t):
    # Hafif overshoot (1'i biraz aşar) — düğümlerin "oturma" hissi için.
    c1 = 1.70158
    c3 = c1 + 1
    t = clamp(t)
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


class Tween:
    """Hedefe kritik-sönümlü yaklaşan skaler; her karede update(dt) ile ilerler."""

    def __init__(self, value=0.0, speed=6.0):
        self.value = float(value)
        self.target = float(value)
        self.speed = float(speed)

    def set(self, target):
        self.target = float(target)

    def update(self, dt):
        self.value += (self.target - self.value) * min(1.0, self.speed * dt)
        return self.value


def human_uptime(seconds):
    """Saniye → 'up 3d 4h' benzeri kısa metin."""
    try:
        s = int(seconds)
    except (TypeError, ValueError):
        return "-"
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, _ = divmod(s, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


# ── Font yönetimi (piroled theme.py yeniden kuruldu) ────────────────────────
_FONT_CACHE = {}
_TRUE_ITALIC = None

# RPi OS'ta hazır; fonts-dejavu-extra oblique kesimini ekler.
_DEJAVU = {
    (False, False): ["DejaVuSans.ttf"],
    (True, False): ["DejaVuSans-Bold.ttf"],
    (False, True): ["DejaVuSans-Oblique.ttf"],
    (True, True): ["DejaVuSans-BoldOblique.ttf"],
}
_FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/local/share/piroled/fonts",
    "/usr/share/fonts/dejavu",
    os.path.join(os.path.dirname(__file__), "fonts"),
    # Windows (offline preview için)
    "C:\\Windows\\Fonts",
]
_WIN_FALLBACK = {
    (False, False): ["DejaVuSans.ttf", "arial.ttf", "segoeui.ttf"],
    (True, False): ["DejaVuSans-Bold.ttf", "arialbd.ttf", "segoeuib.ttf"],
    (False, True): ["DejaVuSans-Oblique.ttf", "ariali.ttf"],
    (True, True): ["DejaVuSans-BoldOblique.ttf", "arialbi.ttf"],
}


def _find_font_file(bold, italic):
    names = list(_DEJAVU[(bold, italic)]) + _WIN_FALLBACK[(bold, italic)]
    for d in _FONT_DIRS:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p):
                return p
    return None


def load(size, bold=False, italic=False):
    """Verilen boyutta TTF font (cache'li). Bulunamazsa Pillow bitmap default."""
    key = (int(size), bool(bold), bool(italic))
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    from PIL import ImageFont
    font = None
    path = _find_font_file(bold, italic)
    if path:
        try:
            font = ImageFont.truetype(path, int(size))
        except Exception:
            font = None
    if font is None:
        try:
            font = ImageFont.load_default(int(size))  # Pillow ≥10 boyutlu default
        except Exception:
            font = ImageFont.load_default()
    _FONT_CACHE[key] = font
    return font


def has_true_italic():
    global _TRUE_ITALIC
    if _TRUE_ITALIC is None:
        _TRUE_ITALIC = _find_font_file(True, True) is not None or \
            _find_font_file(False, True) is not None
    return _TRUE_ITALIC


def f_label():
    return load(9)


def f_body():
    return load(11)


def f_value():
    return load(14, bold=True)


def f_hero(size=24):
    return load(size, bold=True)


def text_size(draw, s, font):
    """Metin (genişlik, yükseklik) — modern ve eski Pillow uyumlu."""
    try:
        l, t, r, b = draw.textbbox((0, 0), s, font=font)
        return r - l, b - t
    except Exception:
        try:
            return font.getsize(s)
        except Exception:
            return (len(s) * 6, 11)


# ── Metin yardımcıları ──────────────────────────────────────────────────────
def text(draw, xy, s, font=None, anchor="lt", fill=1):
    """anchor: yatay (l/c/r) + dikey (t/m/b)."""
    font = font or f_body()
    w, h = text_size(draw, s, font)
    x, y = xy
    if anchor[0] == "c":
        x -= w // 2
    elif anchor[0] == "r":
        x -= w
    if anchor[1] == "m":
        y -= h // 2
    elif anchor[1] == "b":
        y -= h
    draw.text((x, y), s, font=font, fill=fill)
    return w, h


def fit(draw, s, font, width, ellipsis="…"):
    if text_size(draw, s, font)[0] <= width:
        return s
    out = s
    while out and text_size(draw, out + ellipsis, font)[0] > width:
        out = out[:-1]
    return out + ellipsis


def text_badge(draw, xy, s, font=None, anchor="lt", pad=1):
    """Grafiğin üstündeki etiketi altındaki mürekkebi silerek yazar."""
    font = font or f_label()
    tw, th = text_size(draw, s, font)
    x, y = xy
    if anchor[0] == "c":
        x -= tw // 2
    elif anchor[0] == "r":
        x -= tw
    if anchor[1] == "m":
        y -= th // 2
    elif anchor[1] == "b":
        y -= th
    draw.rectangle([x - pad, y - pad, x + tw + pad, y + th + pad], fill=0)
    draw.text((x, y), s, font=font, fill=1)


def marquee(draw, xy, width, s, font=None, t=0.0, speed=18.0, gap=14,
            img=None, height=None):
    """Yatay kayan metin, `width`'e sert kırpılır. img yoksa ellipsis'e düşer."""
    from PIL import Image, ImageDraw as _ID
    font = font or f_body()
    x, y = xy
    tw, th = text_size(draw, s, font)
    if tw <= width:
        draw.text((x, y), s, font=font, fill=1)
        return
    if img is None:
        draw.text((x, y), fit(draw, s, font, width), font=font, fill=1)
        return
    h = height or (th + 4)
    span = tw + gap
    off = int((t * speed) % span)
    strip = Image.new("1", (width, h), 0)
    sd = _ID.Draw(strip)
    sd.text((-off, 0), s, font=font, fill=1)
    sd.text((-off + span, 0), s, font=font, fill=1)
    img.paste(1, (x, y), strip)


# ── Barlar ──────────────────────────────────────────────────────────────────
def hbar(draw, x, y, w, h, frac, border=True, segments=0):
    """Yatay dolum barı. segments>0 → segmentli (LED tarzı) bar."""
    frac = clamp(frac)
    if border:
        draw.rectangle([x, y, x + w - 1, y + h - 1], outline=1, fill=0)
        ix, iy, iw, ih = x + 2, y + 2, w - 4, h - 4
    else:
        ix, iy, iw, ih = x, y, w, h
    if iw <= 0 or ih <= 0:
        return
    if segments > 0:
        seg_w = max(1, (iw - (segments - 1)) // segments)
        lit = int(round(segments * frac))
        for i in range(lit):
            sx = ix + i * (seg_w + 1)
            if sx + seg_w > ix + iw:
                break
            draw.rectangle([sx, iy, sx + seg_w - 1, iy + ih - 1], fill=1)
    else:
        fw = int(round(iw * frac))
        if fw > 0:
            draw.rectangle([ix, iy, ix + fw - 1, iy + ih - 1], fill=1)


def vbar(draw, x, y, w, h, frac, border=True):
    frac = clamp(frac)
    if border:
        draw.rectangle([x, y, x + w - 1, y + h - 1], outline=1, fill=0)
        ix, iy, iw, ih = x + 2, y + 2, w - 4, h - 4
    else:
        ix, iy, iw, ih = x, y, w, h
    fh = int(round(ih * frac))
    if fh > 0:
        draw.rectangle([ix, iy + ih - fh, ix + iw - 1, iy + ih - 1], fill=1)


def ticks(draw, x, y, w, count=5, height=3):
    for i in range(count + 1):
        tx = x + int(round(w * i / count))
        draw.line([tx, y, tx, y + height], fill=1)


# ── Göstergeler ──────────────────────────────────────────────────────────────
def arc_gauge(draw, cx, cy, r, frac, thickness=4, start=150, end=390, ends=True):
    """Süpüren yay göstergesi. Açılar PIL geleneğinde (0 = saat 3, CW)."""
    frac = clamp(frac)
    steps = 28
    for i in range(steps + 1):
        a = math.radians(start + (end - start) * i / steps)
        px = cx + math.cos(a) * r
        py = cy + math.sin(a) * r
        draw.point((int(round(px)), int(round(py))), fill=1)
    sweep_end = start + (end - start) * frac
    if frac > 0.005:
        for i in range(thickness):
            rr = r - 3 - i
            draw.arc([cx - rr, cy - rr, cx + rr, cy + rr], start, sweep_end, fill=1)


def needle(draw, cx, cy, r, frac, start=150, end=390):
    a = math.radians(start + (end - start) * clamp(frac))
    draw.line([cx, cy, int(round(cx + math.cos(a) * r)),
               int(round(cy + math.sin(a) * r))], fill=1)


def ring(draw, cx, cy, r, frac, thickness=3):
    arc_gauge(draw, cx, cy, r, frac, thickness=thickness, start=-90, end=270)


# ── Sparkline / bar grafik ───────────────────────────────────────────────────
def sparkline(draw, x, y, w, h, values, vmin=None, vmax=None, fill=False,
              baseline=False):
    """Sağa hizalı çizgi grafik. En yeni örnek sağ kenarda."""
    if not values:
        return
    vals = values[-w:]
    lo = min(vals) if vmin is None else vmin
    hi = max(vals) if vmax is None else vmax
    if hi - lo < 1e-9:
        hi = lo + 1.0
    n = len(vals)
    x0 = x + max(0, w - n)
    pts = []
    for i, v in enumerate(vals):
        px = x0 + i
        py = y + h - 1 - int(round((clamp((v - lo) / (hi - lo))) * (h - 1)))
        pts.append((px, py))
    if fill:
        for px, py in pts:
            draw.line([px, py, px, y + h - 1], fill=1)
    elif n > 1:
        draw.line(pts, fill=1)
    else:
        draw.point(pts[0], fill=1)
    if baseline:
        draw.line([x, y + h - 1, x + w - 1, y + h - 1], fill=1)


def bars_chart(draw, x, y, w, h, values, vmax=None, bar_w=2, gap=1):
    if not values:
        return
    hi = max(values) if vmax is None else vmax
    if hi <= 0:
        hi = 1.0
    step = bar_w + gap
    n = min(len(values), w // step)
    vals = values[-n:]
    for i, v in enumerate(vals):
        bh = int(round(clamp(v / hi) * h))
        px = x + w - (n - i) * step
        if bh > 0:
            draw.rectangle([px, y + h - bh, px + bar_w - 1, y + h - 1], fill=1)


# ── Nokta ızgarası ───────────────────────────────────────────────────────────
def dot_grid(draw, x, y, cols, rows, count, cell=5, dot=3, progress=1.0):
    total = cols * rows
    shown = int(round(clamp(progress) * count))
    for i in range(total):
        cx = x + (i % cols) * cell
        cy = y + (i // cols) * cell
        if i < shown:
            draw.rectangle([cx, cy, cx + dot - 1, cy + dot - 1], fill=1)
        elif i < count:
            pass
        else:
            draw.point((cx, cy), fill=1)


# ── Geometrik glifler (bu boyutta icon font gerekmez) ───────────────────────
def icon_check(draw, x, y, s=7):
    draw.line([x, y + s // 2, x + s // 3, y + s - 1], fill=1)
    draw.line([x + s // 3, y + s - 1, x + s - 1, y], fill=1)


def icon_cross(draw, x, y, s=7):
    draw.line([x, y, x + s - 1, y + s - 1], fill=1)
    draw.line([x + s - 1, y, x, y + s - 1], fill=1)


def icon_dots(draw, x, y, s=7, t=0.0):
    """Üç noktalı 'çalışıyor' göstergesi."""
    k = int(t * 3) % 3
    for i in range(3):
        cx = x + i * 3
        if i <= k:
            draw.rectangle([cx, y + s - 2, cx + 1, y + s - 1], fill=1)


def icon_shield(draw, x, y, w=13, h=15, frac=1.0, img=None):
    """Kalkan konturu; `frac` onu alttan yukarı doldurur (poligonla maskeli)."""
    poly = [(w // 2, 0), (w - 1, 3), (w - 1, h // 2),
            (w // 2, h - 1), (0, h // 2), (0, 3)]
    shifted = [(px + x, py + y) for px, py in poly]
    draw.polygon(shifted, outline=1, fill=0)
    fh = int(round(clamp(frac) * (h - 2)))
    if fh <= 0 or img is None:
        return
    from PIL import Image, ImageDraw as _ID
    mask = Image.new("1", (w, h), 0)
    md = _ID.Draw(mask)
    md.polygon(poly, outline=0, fill=1)
    md.rectangle([0, 0, w - 1, h - 1 - fh], fill=0)
    img.paste(1, (x, y), mask)


def icon_arrow(draw, x, y, s=7, up=True):
    m = s // 2
    if up:
        draw.polygon([(x + m, y), (x + s - 1, y + m), (x, y + m)], fill=1)
        draw.rectangle([x + m - 1, y + m, x + m + 1, y + s - 1], fill=1)
    else:
        draw.polygon([(x + m, y + s - 1), (x + s - 1, y + m), (x, y + m)], fill=1)
        draw.rectangle([x + m - 1, y, x + m + 1, y + m], fill=1)


def icon_thermo(draw, x, y, h=15, frac=0.5):
    w = 5
    draw.ellipse([x, y + h - w, x + w - 1, y + h - 1], outline=1, fill=0)
    draw.rectangle([x + 1, y, x + w - 2, y + h - w], outline=1, fill=0)
    col = int(round(clamp(frac) * (h - w - 1)))
    if col > 0:
        draw.rectangle([x + 2, y + h - w - col, x + w - 3, y + h - w], fill=1)


def dashed_hline(draw, x, y, w, on=2, off=2):
    i = 0
    while i < w:
        draw.line([x + i, y, x + min(i + on, w) - 1, y], fill=1)
        i += on + off


def header(draw, title, t=0.0, right=None):
    """11 px başlık şeridi + alt çizgi. Sağ etiket çakışacaksa düşürülür."""
    f = f_label()
    text(draw, (SAFE, SAFE - 1), title, f)
    if right:
        tw, _ = text_size(draw, title, f)
        rw, _ = text_size(draw, right, f)
        if SAFE + tw + 6 + rw <= WIDTH - SAFE:
            text(draw, (WIDTH - SAFE, SAFE - 1), right, f, anchor="rt")
    draw.line([SAFE, 11, WIDTH - SAFE - 1, 11], fill=1)


def text_oblique(draw, xy, s, font=None, img=None, slant=0.22):
    """Sağa eğik metin (italik kesim yoksa /gate soneki için fallback)."""
    from PIL import Image, ImageDraw as _ID
    font = font or f_body()
    if img is None:
        draw.text(xy, s, font=font, fill=1)
        return
    tw, th = text_size(draw, s, font)
    pad = int(th * slant) + 2
    tmp = Image.new("1", (tw + pad * 2, th + 4), 0)
    _ID.Draw(tmp).text((pad, 0), s, font=font, fill=1)
    tmp = tmp.transform(tmp.size, Image.AFFINE,
                        (1, slant, -slant * tmp.height, 0, 1, 0),
                        resample=Image.NEAREST)
    img.paste(1, (xy[0] - pad, xy[1]), tmp)


# ── Klyrix markası (resmi görselden ölçülü geometri) ────────────────────────
# tile 301x300, sembol 128x169:
#   çubuk x90..113 (24), y69..230 (162) · kol koşusu 26 px, tam 45° · düğüm 31x31
#   boşluk çubuk↔chevron 9 px · çubuk kollardan kalın (24 vs 18.4, oran 1.30)
def _mark_geometry(height):
    h = max(13, int(height))
    half = (h - 1) // 2
    bar_w = max(2, round(h * 0.142))
    run = max(2, round(h * 0.154))
    node = max(3, round(run * 1.19))
    gap = max(1, round(h * 0.053))
    vertex = bar_w + gap
    arm_top = node // 2
    arm_rows = max(1, half - arm_top)
    node_x0 = vertex + arm_rows
    width = node_x0 + node
    return {"half": half, "bar_w": bar_w, "run": run, "node": node,
            "gap": gap, "vertex": vertex, "arm_rows": arm_rows,
            "node_x0": node_x0, "width": width, "height": 2 * half + 1}


def klyrix_mark(draw, cx, cy, height, reveal=1.0, ink=1):
    """Beyaz Klyrix K'si, (cx, cy) merkezli. reveal 0..1 onu monte eder."""
    g = _mark_geometry(height)
    r = clamp(reveal)
    x0 = int(round(cx - g["width"] / 2.0))
    cy = int(round(cy))
    half = g["half"]

    p_bar = ease_out_cubic(clamp(r / 0.40))
    p_arm = ease_out_cubic(clamp((r - 0.25) / 0.50))
    p_node = clamp((r - 0.72) / 0.28)

    if p_bar > 0:
        hh = int(round(half * p_bar))
        draw.rectangle([x0, cy - hh, x0 + g["bar_w"] - 1, cy + hh], fill=ink)

    if p_arm > 0:
        steps = int(round(g["arm_rows"] * p_arm))
        for i in range(steps + 1):
            lx = x0 + g["vertex"] + i
            rx = lx + g["run"] - 1
            draw.rectangle([lx, cy - i, rx, cy - i], fill=ink)
            draw.rectangle([lx, cy + i, rx, cy + i], fill=ink)

    if p_node > 0:
        n = g["node"]
        size = n if p_node >= 1 else max(2, min(n, int(round(
            n * ease_out_back(p_node)))))
        pad = (n - size) // 2
        nx = x0 + g["node_x0"] + pad
        for sign in (-1, 1):
            ny = (cy - half if sign < 0 else cy + half - n + 1) + pad
            draw.rectangle([nx, ny, nx + size - 1, ny + size - 1], fill=ink)
            if size >= 7:
                for dx, dy in ((0, 0), (size - 1, 0), (0, size - 1),
                               (size - 1, size - 1)):
                    draw.point((nx + dx, ny + dy), fill=0 if ink else 1)


def _tile_insets(size, rx):
    out = []
    for i in range(size):
        dy = min(i, size - 1 - i)
        if dy >= rx:
            out.append(0)
        else:
            out.append(rx - int(round(math.sqrt(
                max(0.0, rx * rx - (rx - dy - 0.5) ** 2)))))
    return out


def klyrix_tile(draw, x, y, size, reveal=1.0, filled=False):
    """Yuvarlak köşeli kutu, rx = 0.21875 x size (marka spec)."""
    rx = max(2, int(round(0.21875 * size)))
    ins = _tile_insets(size, rx)
    rows = min(size, int(round(size * clamp(reveal))))
    if rows < 2:
        return
    x1 = x + size - 1
    if filled:
        for i in range(rows):
            draw.rectangle([x + ins[i], y + i, x1 - ins[i], y + i], fill=1)
        return
    for i in range(rows):
        yy = y + i
        a = ins[i]
        if i == 0 or i == size - 1:
            draw.rectangle([x + a, yy, x1 - a, yy], fill=1)
            continue
        b = ins[i - 1]
        lo, hi = (a, b) if a <= b else (b, a)
        if lo == hi:
            draw.point((x + a, yy), fill=1)
            draw.point((x1 - a, yy), fill=1)
        else:
            draw.rectangle([x + lo, yy, x + hi, yy], fill=1)
            draw.rectangle([x1 - hi, yy, x1 - lo, yy], fill=1)

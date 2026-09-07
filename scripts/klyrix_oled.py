#!/usr/bin/env python3
"""Klyrix/gate OLED render motoru — SSD1306/SH1106 128x64, I2C, 1-bit.

Tarayıcı simülatörünün piksel-eş Python portu. Saf motor modülüdür: çizim
tamponu (FB), piksel font, 9 sayfa renderer'ı, veri kaynakları (Live/Demo) ve
sayfa geçişli oynatıcı (Player). Daemon, CLI ve DB yapılandırması
scripts/lcd_display.py tarafında yaşar — bu dosya doğrudan çalıştırılmaz.

Tek bağımlılık Pillow; cihazda ayrıca luma.oled + luma.core.

Env: PI5_LCD_ADDR=0x3C  PI5_LCD_I2C_PORT=1  PI5_LCD_FPS=20  PI5_LCD_DWELL=10
     PI5_LCD_WAN_IF=eth0  PI5_LCD_CONTROLLER=ssd1306|sh1106
     PI5_LCD_TEMP_ALARM=75
     PI5_LCD_MOUNTS="ROOT=/,BOOT=/boot/firmware,NAS=/mnt/nas,USB=/mnt/usb,DOCKER=/var/lib/docker"
"""
import glob
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time

W, H = 128, 64
CONFIG_FILE = "/opt/pi5-gateway/core/pi5router.sqlite"
TR = 0.35  # yatay kaydırma geçişi (s)

# ── Piksel font (5x7 + descender) ve wordmark ───────────────────────────────
F = {
    ' ': '...|...|...|...|...|...|...',
    'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#', 'B': '####.|#...#|#...#|####.|#...#|#...#|####.',
    'C': '.####|#....|#....|#....|#....|#....|.####', 'D': '####.|#...#|#...#|#...#|#...#|#...#|####.',
    'E': '#####|#....|#....|####.|#....|#....|#####', 'F': '#####|#....|#....|####.|#....|#....|#....',
    'G': '.####|#....|#....|#.###|#...#|#...#|.####', 'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#',
    'I': '###|.#.|.#.|.#.|.#.|.#.|###', 'J': '....#|....#|....#|....#|....#|#...#|.###.',
    'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', 'L': '#....|#....|#....|#....|#....|#....|#####',
    'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', 'N': '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
    'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.', 'P': '####.|#...#|#...#|####.|#....|#....|#....',
    'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', 'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    'S': '.####|#....|#....|.###.|....#|....#|####.', 'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..',
    'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.', 'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
    'W': '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', 'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', 'Z': '#####|....#|...#.|..#..|.#...|#....|#####',
    '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
    '2': '.###.|#...#|....#|...#.|..#..|.#...|#####', '3': '####.|....#|....#|.###.|....#|....#|####.',
    '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', '5': '#####|#....|####.|....#|....#|#...#|.###.',
    '6': '..##.|.#...|#....|####.|#...#|#...#|.###.', '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
    '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.', '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
    '.': '.|.|.|.|.|.|#', ',': '..|..|..|..|..|.#|#.', ':': '.|.|#|.|.|#|.', '!': '#|#|#|#|#|.|#',
    '?': '.###.|#...#|....#|..##.|..#..|.....|..#..', '-': '...|...|...|###|...|...|...',
    '+': '...|.#.|.#.|###|.#.|.#.|...', '/': '..#|..#|.#.|.#.|.#.|#..|#..',
    '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##', '°': '.#.|#.#|.#.|...|...|...|...',
    '(': '.#|#.|#.|#.|#.|#.|.#', ')': '#.|.#|.#|.#|.#|.#|#.', "'": '#|#|.|.|.|.|.', '·': '.|.|.|#|.|.|.',
    '=': '...|...|###|...|###|...|...', '↓': '..#..|..#..|..#..|..#..|#.#.#|.###.|..#..',
    '↑': '..#..|.###.|#.#.#|..#..|..#..|..#..|..#..', '▸': '#...|##..|###.|####|###.|##..|#...',
    'a': '.....|.....|.###.|....#|.####|#...#|.####', 'b': '#....|#....|####.|#...#|#...#|#...#|####.',
    'c': '.....|.....|.####|#....|#....|#....|.####', 'd': '....#|....#|.####|#...#|#...#|#...#|.####',
    'e': '.....|.....|.###.|#...#|#####|#....|.####', 'f': '..##.|.#...|####.|.#...|.#...|.#...|.#...',
    'g': '.....|.....|.####|#...#|#...#|#...#|.####|....#|.###.', 'h': '#....|#....|####.|#...#|#...#|#...#|#...#',
    'i': '#|.|#|#|#|#|#', 'j': '..#|...|..#|..#|..#|..#|..#|#.#|.#.', 'k': '#...|#...|#..#|#.#.|##..|#.#.|#..#',
    'l': '#.|#.|#.|#.|#.|#.|.#', 'm': '.....|.....|##.#.|#.#.#|#.#.#|#...#|#...#',
    'n': '.....|.....|####.|#...#|#...#|#...#|#...#', 'o': '.....|.....|.###.|#...#|#...#|#...#|.###.',
    'p': '.....|.....|####.|#...#|#...#|####.|#....|#....|#....', 'q': '.....|.....|.####|#...#|#...#|.####|....#|....#|....#',
    'r': '....|....|#.##|##..|#...|#...|#...', 's': '.....|.....|.####|#....|.###.|....#|####.',
    't': '.#..|.#..|####|.#..|.#..|.#..|..##', 'u': '.....|.....|#...#|#...#|#...#|#..##|.##.#',
    'v': '.....|.....|#...#|#...#|#...#|.#.#.|..#..', 'w': '.....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.',
    'x': '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#', 'y': '.....|.....|#...#|#...#|#...#|.####|....#|....#|.###.',
    'z': '.....|.....|#####|...#.|..#..|.#...|#####',
}
WM = {  # "Klyrix" wordmark, cap 12 px, 2 px kalınlık
    'K': '##.....##|##....##.|##...##..|##..##...|##.##....|####.....|####.....|##.##....|##..##...|##...##..|##....##.|##.....##',
    'l': '##|##|##|##|##|##|##|##|##|##|##|##',
    'y': '........|........|........|........|##....##|##....##|##....##|.##..##.|.##..##.|..####..|..####..|...##...|...##...|..##....|###.....',
    'r': '......|......|......|......|##.###|###..#|##....|##....|##....|##....|##....|##....',
    'i': '..|##|##|..|##|##|##|##|##|##|##|##',
    'x': '........|........|........|........|##....##|.##..##.|..####..|...##...|...##...|..####..|.##..##.|##....##',
}
ALERT_MAX_AGE = 60

# Canli veri (alert mesaji, hostname, cihaz adi) Turkce olabilir; font 5x7 ASCII.
_ASCII = str.maketrans({
    'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I', 'ö': 'o', 'Ö': 'O',
    'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U', 'â': 'a', 'Â': 'A', 'î': 'i', 'Î': 'I',
    'û': 'u', 'Û': 'U', 'é': 'e', 'É': 'E', '–': '-', '—': '-', '’': "'", '‘': "'",
    '“': '"', '”': '"', ' ': ' ',
})


def tr_ascii(s):
    """Fontta karsiligi olmayan harfleri ASCII esdegerine indir ('?' blogu cikmasin)."""
    return s.translate(_ASCII) if isinstance(s, str) else str(s)



def clamp(v, a=0.0, b=1.0):
    return a if v < a else b if v > b else v


def eoc(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def eob(t):
    t = clamp(t)
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def R(v):  # JS Math.round eşleniği (0.5 yukarı)
    return int(math.floor(v + 0.5))


def chunk(a, n):
    return [a[i:i + n] for i in range(0, len(a), n)]


# ── 1-bit kare tamponu ───────────────────────────────────────────────────────
class FB:
    def __init__(self):
        self.b = bytearray(W * H)
        self.clip = None

    def clear(self):
        self.b = bytearray(W * H)

    def px(self, x, y, v=1):
        x = int(x); y = int(y)
        if x < 0 or y < 0 or x > 127 or y > 63:
            return
        c = self.clip
        if c and (x < c[0] or y < c[1] or x > c[2] or y > c[3]):
            return
        self.b[y * W + x] = 255 if v else 0

    def rect(self, x0, y0, x1, y1, v=1):
        x0, y0, x1, y1 = R(x0), R(y0), R(x1), R(y1)
        if x1 < x0: x0, x1 = x1, x0
        if y1 < y0: y0, y1 = y1, y0
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, v)

    def box(self, x0, y0, x1, y1, v=1):
        self.rect(x0, y0, x1, y0, v); self.rect(x0, y1, x1, y1, v)
        self.rect(x0, y0, x0, y1, v); self.rect(x1, y0, x1, y1, v)

    def dotted(self, x0, x1, y, v=1, step=2):
        for x in range(x0, x1 + 1, step):
            self.px(x, y, v)

    def line(self, x0, y0, x1, y1, v=1):
        x0, y0, x1, y1 = R(x0), R(y0), R(x1), R(y1)
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        e = dx + dy
        while True:
            self.px(x0, y0, v)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * e
            if e2 >= dy: e += dy; x0 += sx
            if e2 <= dx: e += dx; y0 += sy

    def circle(self, cx, cy, r, v=1):
        x, y, d = r, 0, 1 - r
        while x >= y:
            for a, b in ((x, y), (-x, y), (x, -y), (-x, -y), (y, x), (-y, x), (y, -x), (-y, -x)):
                self.px(cx + a, cy + b, v)
            y += 1
            if d < 0: d += 2 * y + 1
            else: x -= 1; d += 2 * (y - x) + 1

    def disc(self, cx, cy, r, v=1):
        for dy in range(-r, r + 1):
            dx = int(math.floor(math.sqrt(r * r - dy * dy)))
            self.rect(cx - dx, cy + dy, cx + dx, cy + dy, v)

    def arc(self, cx, cy, r, a0, a1, v=1):
        n = max(2, int(math.ceil(math.radians(a1 - a0) * r * 1.6)))
        for i in range(n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            self.px(R(cx + math.cos(a) * r), R(cy + math.sin(a) * r), v)

    def gauge(self, cx, cy, r, frac, thick=4, start=135, end=405, track=True):
        if track:
            steps = R((end - start) / 9)
            for i in range(steps + 1):
                a = math.radians(start + (end - start) * i / steps)
                self.px(R(cx + math.cos(a) * r), R(cy + math.sin(a) * r), 1)
        frac = clamp(frac)
        if frac > 0.005:
            se = start + (end - start) * frac
            for k in range(thick):
                self.arc(cx, cy, r - 3 - k, start, se)

    def measure(self, s, sc=1, font=None, bold=False, **_):
        s = tr_ascii(s)
        f = font or F
        b = 1 if bold else 0
        ex = 1 if font is WM else 0
        w = 0
        for ch in s:
            g = f.get(ch) or F['?']
            w += (g.index('|') + 1 + b + ex) * sc
        return w - (1 + ex) * sc if w else 0

    def text(self, x, y, s, sc=1, font=None, ink=1, bold=False, obl=False, al='l'):
        s = tr_ascii(s)
        f = font or F
        b = 1 if bold else 0
        ex = 1 if font is WM else 0
        w = self.measure(s, sc=sc, font=font, bold=bold)
        if al == 'c': x -= w >> 1
        elif al == 'r': x -= w - 1
        cx, y = R(x), R(y)
        for ch in s:
            g = f.get(ch) or F['?']
            rows = g.split('|')
            gw = len(rows[0])
            for r, row in enumerate(rows):
                sh = (2 if r < 3 else 1 if r < 6 else 0) if obl else 0
                for c in range(gw):
                    if row[c] == '#':
                        px, py = cx + (c + sh) * sc, y + r * sc
                        self.rect(px, py, px + sc - 1 + b, py + sc - 1, ink)
            cx += (gw + 1 + b + ex) * sc
        return w

    def typed(self, x, y, s, n, **o):
        return self.text(x, y, s[:max(0, n)], **o)

    def badge(self, x, y, s, al='l', **o):
        w = self.measure(s, **o)
        h = 7 * o.get('sc', 1)
        bx = x - (w >> 1) if al == 'c' else x - w + 1 if al == 'r' else x
        self.rect(bx - 1, y - 1, bx + w, y + h, 0)
        self.text(bx, y, s, **o)

    def marquee(self, x, y, w, s, t=0.0, speed=18.0, gap=14, **o):
        tw = self.measure(s, **o)
        h = (15 if o.get('font') is WM else 9) * o.get('sc', 1)
        if tw <= w:
            self.text(x, y, s, **o)
            return
        span = tw + gap
        off = int(math.floor((t * speed) % span))
        old = self.clip
        self.clip = (x, y, x + w - 1, y + h)
        self.text(x - off, y, s, **o)
        self.text(x - off + span, y, s, **o)
        self.clip = old

    def spark(self, x, y, w, h, vals, vmin=None, vmax=None, pad=0, fill=None):
        if not vals:
            return
        v = vals[-w:]
        lo = min(v) if vmin is None else vmin
        hi = max(v) if vmax is None else vmax
        if pad: lo -= pad; hi += pad
        if hi - lo < 1e-9: hi = lo + 1
        x0 = x + max(0, w - len(v))
        py0 = None
        for i, val in enumerate(v):
            px = x0 + i
            py = y + h - 1 - R(clamp((val - lo) / (hi - lo)) * (h - 1))
            if fill == 'dots':
                for yy in range(py, y + h):
                    if ((px + yy) & 1) == 0:
                        self.px(px, yy, 1)
                self.px(px, py, 1)
            elif fill:
                self.rect(px, py, px, y + h - 1, 1)
            else:
                if py0 is not None: self.line(px - 1, py0, px, py)
                else: self.px(px, py, 1)
                py0 = py

    def poly(self, pts, v=1):
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            self.line(a[0], a[1], b[0], b[1], v)

    def poly_fill(self, pts, y_from, y_to, v=1):
        for y in range(y_from, y_to + 1):
            sy = y + 0.5
            xs = []
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                if (a[1] <= sy < b[1]) or (b[1] <= sy < a[1]):
                    xs.append(a[0] + (sy - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
            xs.sort()
            for i in range(0, len(xs) - 1, 2):
                self.rect(math.ceil(xs[i]), y, math.floor(xs[i + 1]), y, v)

    def image(self):
        from PIL import Image
        return Image.frombytes('L', (W, H), bytes(self.b)).convert('1')


# ── Widget'lar ──────────────────────────────────────────────────────────────
def shield(fb, x, y, w, h, frac):
    m = w // 2
    P = [(x + m, y), (x + w - 1, y + 3), (x + w - 1, y + h / 2), (x + m, y + h - 1), (x, y + h / 2), (x, y + 3)]
    fb.poly(P)
    fh = R(clamp(frac) * (h - 2))
    if fh > 0:
        fb.poly_fill(P, y + h - 1 - fh, y + h - 1)


def check(fb, x, y, s=7):
    fb.line(x, y + (s >> 1), x + s // 3, y + s - 1)
    fb.line(x + s // 3, y + s - 1, x + s - 1, y)


def cross(fb, x, y, s=7):
    fb.line(x, y, x + s - 1, y + s - 1)
    fb.line(x + s - 1, y, x, y + s - 1)


def thermo_h(fb, x, y, w, frac):
    bx = x + 5
    fb.circle(bx, y, 5)
    fb.rect(x + 9, y - 3, x + w - 1, y - 3); fb.rect(x + 9, y + 3, x + w - 1, y + 3)
    fb.rect(x + w - 1, y - 3, x + w - 1, y + 3)
    fb.rect(x + 8, y - 2, x + 11, y + 2, 0)
    fb.disc(bx, y, 3)
    ln = R(clamp(frac) * (w - 12))
    if ln > 0:
        fb.rect(x + 8, y - 1, x + 8 + ln, y + 1)


def kmark(fb, cx, cy, h, reveal, ink=1):
    h = max(13, int(h))
    half = (h - 1) >> 1
    bw = max(2, R(h * 0.142)); run = max(2, R(h * 0.154)); node = max(3, R(run * 1.19))
    gap = max(1, R(h * 0.053)); vertex = bw + gap; arm_top = node >> 1
    arm_rows = max(1, half - arm_top); nx0 = vertex + arm_rows; width = nx0 + node
    r = clamp(reveal); x0 = R(cx - width / 2); cy = R(cy)
    p_bar, p_arm, p_node = eoc(r / 0.4), eoc((r - 0.25) / 0.5), clamp((r - 0.72) / 0.28)
    if p_bar > 0:
        hh = R(half * p_bar)
        fb.rect(x0, cy - hh, x0 + bw - 1, cy + hh, ink)
    if p_arm > 0:
        for i in range(R(arm_rows * p_arm) + 1):
            lx = x0 + vertex + i; rx = lx + run - 1
            fb.rect(lx, cy - i, rx, cy - i, ink); fb.rect(lx, cy + i, rx, cy + i, ink)
    if p_node > 0:
        size = node if p_node >= 1 else max(2, min(node, R(node * eob(p_node))))
        pad = (node - size) >> 1
        nx = x0 + nx0 + pad
        for sg in (-1, 1):
            ny = (cy - half if sg < 0 else cy + half - node + 1) + pad
            fb.rect(nx, ny, nx + size - 1, ny + size - 1, ink)
            if size >= 7:
                for dx, dy in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)):
                    fb.px(nx + dx, ny + dy, 0 if ink else 1)
    return width


def dot_grid(fb, x, y, cols, rows, shown, items, cell, dot):
    for i in range(cols * rows):
        cx, cy = x + (i % cols) * cell, y + (i // cols) * cell
        if i < shown and i < len(items):
            if items[i]['blocked']: fb.box(cx, cy, cx + dot - 1, cy + dot - 1)
            else: fb.rect(cx, cy, cx + dot - 1, cy + dot - 1)
        elif i >= len(items):
            fb.px(cx, cy, 1)


def page_dots(fb, cx, y, n, cur):
    x0 = cx - ((n * 5 - 2) >> 1)
    for i in range(n):
        x = x0 + i * 5
        if i == cur: fb.rect(x, y, x + 2, y + 2)
        else: fb.px(x + 1, y + 1, 1)


def alert_strip(fb, c):
    fb.rect(0, 0, 127, 9, 1)
    fb.marquee(2, 1, 124, c['alert'], t=c['t'], speed=22, gap=16, ink=0)


def header(fb, c, title, right=None):
    if c['alert']:
        alert_strip(fb, c)
    else:
        fb.text(2, 2, title)
        rt = right
        if c['stale']:
            rt = '' if c['blink1'] else 'STALE %dS' % c['stale_age']
        if rt:
            if 2 + fb.measure(title) + 6 + fb.measure(rt) <= 126:
                fb.text(125, 2, rt, al='r')
    fb.rect(2, 11, 125, 11)


# ── Sayfa renderer'ları (Yerleşim B) ────────────────────────────────────────
def r_brand(fb, c):
    D, p = c['D'], c['p']
    n = int(math.floor((c['t'] - 1.6) / 0.03))
    ver = 'V' + str(D['version'])
    kmark(fb, 17, 31, 41, eoc(p / 0.7))
    wp = eoc((p - 0.5) / 0.4)
    if wp > 0:
        off = R((1 - wp) * 88)
        fb.text(40 + off, 17, 'Klyrix', font=WM)
        fb.text(88 + off, 22, '/gate', bold=True, obl=True)
    lp = eoc((p - 0.8) / 0.2)
    if lp > 0:
        fb.dotted(40, 40 + R(85 * lp), 34)
    if p >= 0.99:
        fb.typed(40, 39, 'SECURE GATEWAY', n)
        fb.typed(40, 53, 'UP ' + D['uptime'], n - 14)
        fb.typed(126 - fb.measure(ver), 53, ver, n - 22)
    if c['alert']:
        alert_strip(fb, c)


def r_temp(fb, c):
    D, p, Hs = c['D'], c['p'], c['S']['temp_hist']
    over = D['temp'] >= D['temp_alarm']
    hide = over and c['blink2']
    stat = 'ALARM' if over else 'MAX %d' % R(max(Hs) if Hs else 0)
    frac = clamp((D['temp'] - 20) / 80) * p
    header(fb, c, 'TEMPERATURE', 'FAN %d' % D['fan'])
    if not hide:
        fb.text(2, 14, str(R(D['temp'] * p)), sc=3)
        fb.text(38, 14, '°C')
        fb.text(38, 28, stat)
        thermo_h(fb, 55, 20, 71, frac)
        tx = 63 + R(59 * (D['temp_alarm'] - 20) / 80)
        fb.rect(tx, 14, tx, 15); fb.rect(tx, 25, tx, 26)
        fb.text(tx, 28, str(D['temp_alarm']), al='c')
    fb.spark(0, 40, 128, 22, Hs, pad=2, fill=True)


def r_ram(fb, c):
    D, p, Hs = c['D'], c['p'], c['S']['ram_hist']
    pct = R(D['ram_pct'] * p)
    lit = R(24 * D['ram_pct'] / 100 * p)
    header(fb, c, 'RAM', 'LOAD ' + D['load'][0])
    fb.text(2, 14, str(pct), sc=3)
    fb.text(37, 14, '%', sc=2)
    fb.text(2, 38, 'USED %d' % R(D['ram_used'] * p))
    fb.text(2, 46, 'FREE %d' % (D['ram_total'] - D['ram_used']))
    fb.text(2, 54, 'TOT %d' % D['ram_total'])
    fb.text(60, 14, '2 MIN')
    if Hs:
        vals = [Hs[min(len(Hs) - 1, R(i * (len(Hs) - 1) / 49))] for i in range(50)]
        fb.spark(60, 24, 50, 38, vals, vmin=0, vmax=100)
    for i in range(lit):
        fb.rect(114, 61 - i * 2, 124, 61 - i * 2)


def r_disk(fb, c):
    D = c['D']
    pages = chunk(D['disks'], 3) or [[]]
    per = c['dwell'] / len(pages)
    pi = min(len(pages) - 1, int(c['tt'] // per))
    tp = c['t'] if pi == 0 else c['tt'] - pi * per
    header(fb, c, 'DISK', '%d VOLUMES' % len(D['disks']))
    for i, d in enumerate(pages[pi]):
        cx = 21 + 43 * i
        q = eoc((tp - 0.12 * i) / 0.7)
        over = d['pct'] >= 90
        fb.gauge(cx, 30, 12, d['pct'] / 100 * q, thick=3, start=-90, end=270)
        fb.text(cx, 27, str(R(d['pct'] * q)), al='c')
        if not (over and c['blink2']):
            fb.text(cx, 46, d['name'], al='c')
    page_dots(fb, 8, 57, len(pages), pi)
    fb.text(125, 55, 'R %s W %s' % (D['disk_r'], D['disk_w']), al='r')


def _fmt(v):
    return str(R(v)) if v >= 100 else '%.1f' % v


def _nice(v):
    return 100 if v <= 100 else 200 if v <= 200 else 500 if v <= 500 else 1000


def r_inet(fb, c):
    D, dl, ul = c['D'], c['S']['dl'], c['S']['ul']
    last3 = c['tt'] >= c['dwell'] - 3
    dots = '.' * (1 + int(c['t'] * 3) % 3)
    st_txt = ('SPEEDTEST RUNNING' + dots) if c['running'] else 'SPEEDTEST ↓%s ↑%s' % (D['st']['dl'], D['st']['ul'])
    header(fb, c, 'INTERNET', '%dMS J%d' % (D['ping'], D['jitter']))
    if dl:
        fb.spark(2, 13, 124, 23, dl, vmin=0, vmax=_nice(max(dl)), fill='dots')
        fb.badge(3, 14, '↓ ' + _fmt(dl[-1]))
    if ul:
        fb.spark(2, 38, 124, 24, ul, vmin=0, vmax=_nice(max(ul)))
        fb.badge(3, 39, '↑ ' + _fmt(ul[-1]))
    if last3:
        q = eoc((c['tt'] - (c['dwell'] - 3)) / 0.15)
        h = R(12 * q)
        if h > 0:
            y0 = 37 - (h >> 1)
            fb.rect(0, y0, 127, y0 + h - 1, 1)
            if h >= 11:
                fb.text(64, y0 + 2, st_txt, al='c', ink=0)


def r_net(fb, c):
    D = c['D']
    header(fb, c, 'NETWORK', 'DDNS ' + D['ddns'])
    rows = (('WAN', D['wan'], 'l', 0.0), ('V6', D['wan6'], 'm', 0.3), ('LAN', D['lan'], 'r', 0.15), ('GW', D['gw'], 'r', 0.3))
    for i, (lab, val, mode, delay) in enumerate(rows):
        y = 14 + i * 12
        st = c['t'] - delay
        if st < 0:
            continue
        w = fb.measure(lab)
        fb.rect(2, y - 1, w + 5, y + 7, 1)
        fb.text(4, y, lab, ink=0)
        s = eob(st / 0.8)
        if mode == 'l': fb.text(30 - R((1 - s) * 130), y, val)
        elif mode == 'r': fb.text(125 + R((1 - s) * 130), y, val, al='r')
        else: fb.marquee(30, y, 96, val, t=st)


def r_clients(fb, c):
    D, p = c['D'], c['p']
    items = D['clients']
    n = max(1, len(items))
    shown = R(len(items) * p)
    blocked = sum(1 for i in items if i['blocked'])
    k = int(c['t'] // 2)
    ph = (c['t'] % 2) / 2
    roll = ph / 0.125 if ph < 0.125 else 1.0
    header(fb, c, 'CLIENTS', '%d BLOCKED' % blocked)
    dot_grid(fb, 3, 14, 20, 3, shown, items, 6, 4)
    fb.text(2, 36, str(shown), sc=2)
    fb.text(26, 43, 'ONLINE')
    if c['t'] > 0.7 and items:
        a, b, pv = items[k % n]['name'], items[(k + 1) % n]['name'], items[(k - 1) % n]['name']
        dy = R(9 * roll) if roll < 1 else 9
        old = fb.clip
        fb.clip = (60, 35, 125, 53)
        fb.text(125, 36 - dy, pv, al='r'); fb.text(125, 45 - dy, a, al='r'); fb.text(125, 54 - dy, b, al='r')
        fb.clip = old


def r_sec(fb, c):
    D = c['D']
    rows = D['layers']
    pages = chunk(rows, 4) or [[]]
    per = c['dwell'] / len(pages)
    pi = min(len(pages) - 1, int(c['tt'] // per))
    tp = c['t'] if pi == 0 else c['tt'] - pi * per
    up = sum(1 for r in rows if r['up'])
    ratio = up / len(rows) if rows else 0.0
    labels = ['%d/%d' % (up, len(rows)), 'F2B %s' % D['f2b'], 'PH %s%%' % D['ph']]
    header(fb, c, 'SECURITY %d/%d' % (pi + 1, len(pages)), labels[int(c['t'] // 2) % 3])
    fb.rect(2, 13, 2 + R(123 * ratio * c['p']), 15, 1)
    for i, r in enumerate(pages[pi]):
        st = tp - 0.15 * i
        if st <= 0:
            continue
        y = 19 + i * 11
        n = int(math.floor(st / 0.04))
        done = n >= len(r['name'])
        bl = (not r['up']) and done and c['blink2']
        if r['up']: check(fb, 118, y)
        elif not bl: cross(fb, 118, y)
        if not bl: fb.typed(2, y, r['name'], n)


def r_msg(fb, c):
    D = c['D']
    header(fb, c, 'MESSAGE', D['host'])
    s = c.get('message') or D['message']
    if fb.measure(s, sc=2) <= 124: fb.text(64, 26, s, sc=2, al='c')
    else: fb.marquee(2, 26, 124, s, t=c['t'], speed=24, gap=20, sc=2)


PAGE_FNS = {'brand': r_brand, 'temp': r_temp, 'ram': r_ram, 'disk': r_disk, 'inet': r_inet,
            'net': r_net, 'clients': r_clients, 'sec': r_sec, 'msg': r_msg}
PAGE_INTRO = {'brand': 1.6, 'temp': 1.2, 'ram': 1.2, 'disk': 0.9, 'inet': 0.6,
              'net': 0.9, 'clients': 1.2, 'sec': 1.3, 'msg': 0.4}
PAGE_ORDER = ['brand', 'temp', 'ram', 'disk', 'inet', 'net', 'clients', 'sec', 'msg']
PAGE_DEFAULT_DWELL = {'brand': 5, 'msg': 6}


def page(pid, dwell=10, message=None):
    """Tek sayfa tanimi. Bilinmeyen id -> serbest metin sayfasi ('msg')."""
    pid = pid if pid in PAGE_FNS else 'msg'
    return {'id': pid, 'dwell': max(1.0, float(dwell or 1)), 'intro': PAGE_INTRO[pid],
            'fn': PAGE_FNS[pid], 'message': message}


def pages_spec(dwell=10):
    """Varsayilan tam dongu — DB yapilandirmasi yoksa ve onizlemede kullanilir."""
    return [page(pid, PAGE_DEFAULT_DWELL.get(pid, dwell)) for pid in PAGE_ORDER]


# ── Veri kaynakları ─────────────────────────────────────────────────────────
def _db(sql, one=True):
    try:
        import sqlite3
        con = sqlite3.connect(CONFIG_FILE)
        cur = con.execute(sql)
        res = cur.fetchone() if one else cur.fetchall()
        con.close()
        return res
    except Exception:
        return None


def _sh(cmd, timeout=3):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ''


def _rf(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ''


def _mounts():
    spec = os.environ.get('PI5_LCD_MOUNTS', 'ROOT=/,BOOT=/boot/firmware,NAS=/mnt/nas,USB=/mnt/usb,DOCKER=/var/lib/docker')
    out = []
    for part in spec.split(','):
        if '=' in part:
            n, p = part.split('=', 1)
            out.append((n.strip().upper()[:6], p.strip()))
    return out


class Source:
    """Ortak geçmiş tamponları; alt sınıflar sample_* ve slow() sağlar."""

    def __init__(self):
        self.S = {'temp_hist': [], 'ram_hist': [], 'dl': [], 'ul': []}
        self.acc = {'t': 0.0, 'r': 0.0, 'n': 0.0}

    def step(self, dt):
        a = self.acc
        a['t'] += dt; a['r'] += dt; a['n'] += dt
        while a['t'] >= 0.1:
            a['t'] -= 0.1; self._push('temp_hist', self.sample_temp(), 128)
        while a['n'] >= 0.1:
            a['n'] -= 0.1
            dl, ul = self.sample_net()
            self._push('dl', dl, 124); self._push('ul', ul, 124)
        while a['r'] >= 1.0:
            a['r'] -= 1.0; self._push('ram_hist', self.sample_ram(), 120)

    def _push(self, key, v, n):
        h = self.S[key]
        h.append(v)
        if len(h) > n:
            del h[0]

    def prime(self):
        for _ in range(128): self._push('temp_hist', self.sample_temp(), 128)
        for _ in range(124):
            dl, ul = self.sample_net(); self._push('dl', dl, 124); self._push('ul', ul, 124)
        for _ in range(120): self._push('ram_hist', self.sample_ram(), 120)


class Demo(Source):
    NAMES = ['MACBOOK-PRO', 'PIXEL-8', 'PS5', 'NAS', 'IPHONE-15', 'DESK-PC', 'TV-LG', 'ESP32-KITCHEN',
             'IPAD', 'PRINTER', 'CAM-FRONT', 'WATCH', 'SWITCH-8P', 'GUEST-PHONE']

    def __init__(self, alarm=False):
        super().__init__()
        self.alarm = alarm
        self.tv, self.rv, self.burst, self.ub = 52.0, 61.0, 0.0, 0.0
        self.prime()

    def sample_temp(self):
        self.tv += ((78.4 if self.alarm else 52.4) - self.tv) * 0.06 + (random.random() - 0.5) * 0.8
        return self.tv

    def sample_ram(self):
        self.rv = clamp(self.rv + (61 - self.rv) * 0.1 + (random.random() - 0.5) * 3, 0, 100)
        return self.rv

    def sample_net(self):
        if self.burst > 0: self.burst -= 0.1; dl = 450 + random.random() * 480
        else:
            dl = 40 + random.random() * 100
            if random.random() < 0.03: self.burst = 0.6 + random.random() * 1.6
        if self.ub > 0: self.ub -= 0.1; ul = 150 + random.random() * 300
        else:
            ul = 8 + random.random() * 30
            if random.random() < 0.015: self.ub = 0.5 + random.random()
        return dl, ul

    def data(self):
        al = self.alarm
        return {
            'temp': 78.4 if al else 52.4, 'temp_alarm': 75, 'fan': 5100 if al else 2400,
            'ram_used': 4980, 'ram_total': 8192, 'ram_pct': 61, 'load': ['0.42', '0.38', '0.35'],
            'disks': [{'name': 'ROOT', 'pct': 47}, {'name': 'BOOT', 'pct': 12}, {'name': 'NAS', 'pct': 91},
                      {'name': 'USB', 'pct': 96 if al else 38}, {'name': 'DOCKER', 'pct': 54}],
            'disk_r': '12.4', 'disk_w': '3.1', 'ping': 8, 'jitter': 2, 'st': {'dl': 941, 'ul': 512},
            'wan': '85.104.22.17', 'wan6': '2a02:26f7:c9c8:4000:0:ab12:cd34:1a3f', 'lan': '192.168.1.153',
            'gw': '192.168.1.1', 'ddns': 'ERR' if al else 'OK', 'host': 'PI5-GATEWAY',
            'clients': [{'name': n, 'blocked': i in (4, 9)} for i, n in enumerate(self.NAMES)],
            'layers': [{'name': 'PI-HOLE', 'up': True}, {'name': 'UNBOUND', 'up': True}, {'name': 'WIREGUARD', 'up': True},
                       {'name': 'NFTABLES', 'up': True}, {'name': 'FAIL2BAN', 'up': True}, {'name': 'ZAPRET', 'up': not al},
                       {'name': 'TAILSCALE', 'up': True}, {'name': 'DDNS', 'up': not al}, {'name': 'FRANKFURT', 'up': True},
                       {'name': 'AMSTERDAM', 'up': True}, {'name': 'NEW YORK', 'up': False}],
            'f2b': 37, 'ph': '23', 'uptime': '3D 4H', 'version': '2.7', 'message': 'Klyrix/gate',
            'alert': None, 'stale': False, 'stale_age': 0, 'running': False,
        }


class Live(Source):
    """Gerçek veri: hızlı okumalar döngüde, yavaşlar arka planda 5 s'de bir."""

    def __init__(self):
        super().__init__()
        self.wan_if = os.environ.get('PI5_LCD_WAN_IF', 'eth0')
        self.lock = threading.Lock()
        self.slow, self.slow_at = {}, 0.0
        self._net = self._disk = None
        self._wan, self._wan_at = '-', 0.0
        self._dr = (0.0, 0.0)
        self._dacc = 0.0
        self.prime()
        threading.Thread(target=self._slow_loop, daemon=True).start()

    def step(self, dt):
        super().step(dt)
        self._dacc += dt
        if self._dacc >= 1.0:
            self._dacc = 0.0
            self._dr = self._disk_rates()

    # hızlı okumalar
    def sample_temp(self):
        v = _rf('/sys/class/thermal/thermal_zone0/temp')
        return int(v) / 1000.0 if v.isdigit() else 0.0

    def sample_ram(self):
        return self._mem()[2]

    def sample_net(self):
        now = time.time(); rx = tx = 0
        for line in _rf('/proc/net/dev').splitlines():
            if ':' in line and line.split(':')[0].strip() == self.wan_if:
                f = line.split(':')[1].split(); rx, tx = int(f[0]), int(f[8])
        if self._net is None:
            self._net = (now, rx, tx); return 0.0, 0.0
        t0, r0, x0 = self._net
        dt = max(1e-3, now - t0)
        self._net = (now, rx, tx)
        return (rx - r0) * 8 / dt / 1e6, (tx - x0) * 8 / dt / 1e6

    def _mem(self):
        tot = avail = 0
        for line in _rf('/proc/meminfo').splitlines():
            if line.startswith('MemTotal:'): tot = int(line.split()[1]) // 1024
            elif line.startswith('MemAvailable:'): avail = int(line.split()[1]) // 1024
        used = tot - avail
        return used, tot, (int(used * 100 / tot) if tot else 0)

    def _disk_rates(self):
        now = time.time(); rd = wr = 0
        for line in _rf('/proc/diskstats').splitlines():
            f = line.split()
            if len(f) >= 10 and f[2] in ('mmcblk0', 'nvme0n1', 'sda', 'sdb'):
                rd += int(f[5]) * 512; wr += int(f[9]) * 512
        if self._disk is None:
            self._disk = (now, rd, wr); return 0.0, 0.0
        t0, r0, w0 = self._disk
        dt = max(1e-3, now - t0)
        self._disk = (now, rd, wr)
        return (rd - r0) / dt / 1e6, (wr - w0) / dt / 1e6

    def _fan(self):
        for p in glob.glob('/sys/class/hwmon/hwmon*/fan1_input'):
            v = _rf(p)
            if v.isdigit(): return int(v)
        return 0

    # yavaş okumalar (ayrı thread)
    def _slow_loop(self):
        while True:
            try:
                s = self._collect_slow()
                with self.lock:
                    self.slow, self.slow_at = s, time.time()
            except Exception:
                pass
            time.sleep(5)

    def _collect_slow(self):
        s = {}
        s['host'] = (_sh('hostname') or 'pi5').upper()
        s['lan'] = _sh("hostname -I | awk '{print $1}'") or '-'
        s['gw'] = _sh("ip route | awk '/default/{print $3; exit}'") or '-'
        s['wan6'] = (_sh("ip -6 addr show scope global | awk '/inet6/{print $2; exit}'").split('/')[0]) or '-'
        if time.time() - self._wan_at > 600:
            w = _sh('curl -s --max-time 3 https://api.ipify.org', 5)
            if w: self._wan, self._wan_at = w, time.time()
        s['wan'] = self._wan
        row = _db("SELECT status FROM ddns_configs ORDER BY rowid DESC LIMIT 1")
        s['ddns'] = ('OK' if str(row[0]).lower() in ('updated', 'ok', 'idle') else 'ERR') if row else '-'
        rows = _db("SELECT hostname, ip_address, blocked FROM devices ORDER BY last_seen DESC", one=False)
        if rows is None:
            rows = [(r[0], r[1], 0) for r in (_db("SELECT hostname, ip_address FROM devices ORDER BY last_seen DESC", one=False) or [])]
        s['clients'] = [{'name': str(r[0] or r[1] or '?').upper()[:12], 'blocked': bool(r[2])} for r in rows]
        units = [('PI-HOLE', 'pihole-FTL'), ('UNBOUND', 'unbound'), ('WIREGUARD', 'wg-quick@wg0'), ('NFTABLES', 'nftables'),
                 ('FAIL2BAN', 'fail2ban'), ('ZAPRET', 'zapret'), ('TAILSCALE', 'tailscaled')]
        layers = [{'name': n, 'up': _sh('systemctl is-active ' + u) == 'active'} for n, u in units]
        layers.append({'name': 'DDNS', 'up': s['ddns'] == 'OK'})
        for r in (_db("SELECT location, status FROM vps_servers", one=False) or []):
            layers.append({'name': str(r[0] or 'VPS').upper()[:12], 'up': r[1] == 'connected'})
        s['layers'] = layers
        m = re.search(r'Currently banned:\s*(\d+)', _sh('fail2ban-client status sshd'))
        s['f2b'] = int(m.group(1)) if m else 0
        try:
            j = json.loads(_sh('curl -s --max-time 2 "http://127.0.0.1/admin/api.php?summaryRaw"'))
            s['ph'] = str(int(float(j.get('ads_percentage_today', 0))))
        except Exception:
            s['ph'] = '-'
        row = _db("SELECT download_mbps, upload_mbps, ping_ms, jitter_ms FROM speed_tests ORDER BY timestamp DESC LIMIT 1")
        if row is None:
            row = _db("SELECT download_mbps, upload_mbps, ping_ms FROM speed_tests ORDER BY timestamp DESC LIMIT 1")
        s['st'] = {'dl': int(row[0] or 0), 'ul': int(row[1] or 0)} if row else {'dl': 0, 'ul': 0}
        s['ping'] = int(row[2] or 0) if row else 0
        s['jitter'] = int(row[3] or 0) if row and len(row) > 3 else 0
        s['running'] = bool(_sh('pgrep -f speedtest'))
        up = float((_rf('/proc/uptime').split() or ['0'])[0])
        d, rem = divmod(int(up), 86400)
        s['uptime'] = '%dD %dH' % (d, rem // 3600) if d else '%dH %dM' % (rem // 3600, (rem % 3600) // 60)
        try:
            s['version'] = str(json.load(open('/opt/pi5-gateway/version.json')).get('version', '?')).lstrip('v')
        except Exception:
            s['version'] = '?'
        row = _db("SELECT message, strftime('%s', created_at) FROM alerts "
                  "WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT 1")
        s['alert'] = None
        if row and row[0]:
            try:
                fresh = (time.time() - int(row[1])) <= ALERT_MAX_AGE
            except (TypeError, ValueError):
                fresh = True
            if fresh:
                s['alert'] = '! ' + str(row[0]).upper()
        s['message'] = 'Klyrix/gate'
        s['disks'] = []
        for name, path in _mounts():
            try:
                u = shutil.disk_usage(path)
                s['disks'].append({'name': name, 'pct': int(u.used * 100 / u.total)})
            except Exception:
                pass
        s['fan'] = self._fan()
        return s

    def data(self):
        with self.lock:
            s = dict(self.slow)
            age = time.time() - self.slow_at if self.slow_at else 999
        used, tot, pct = self._mem()
        rd, wr = self._dr
        lp = (_rf('/proc/loadavg').split() + ['0.00'] * 3)[:3]
        temp = self.S['temp_hist'][-1] if self.S['temp_hist'] else 0.0
        d = {
            'temp': temp, 'temp_alarm': int(os.environ.get('PI5_LCD_TEMP_ALARM', '75')), 'fan': s.get('fan', 0),
            'ram_used': used, 'ram_total': tot, 'ram_pct': pct, 'load': lp,
            'disks': s.get('disks', []), 'disk_r': '%.1f' % rd, 'disk_w': '%.1f' % wr,
            'ping': s.get('ping', 0), 'jitter': s.get('jitter', 0), 'st': s.get('st', {'dl': 0, 'ul': 0}),
            'wan': s.get('wan', '-'), 'wan6': s.get('wan6', '-'), 'lan': s.get('lan', '-'), 'gw': s.get('gw', '-'),
            'ddns': s.get('ddns', '-'), 'host': s.get('host', 'PI5'),
            'clients': s.get('clients', []), 'layers': s.get('layers', []),
            'f2b': s.get('f2b', 0), 'ph': s.get('ph', '-'), 'uptime': s.get('uptime', '-'), 'version': s.get('version', '?'),
            'message': s.get('message', 'Klyrix/gate'), 'alert': s.get('alert'),
            'stale': age > 30, 'stale_age': int(min(age, 9999)), 'running': s.get('running', False),
        }
        return d


# ── Kare üretimi (simülatördeki frame() ile aynı) ───────────────────────────
class Player:
    def __init__(self, src, pages):
        self.src, self.pages = src, pages
        self.fbA, self.fbB, self.out = FB(), FB(), FB()
        self.cur, self.prev, self.trans_at = None, 0, -10.0

    def ctx(self, pg, tt, D):
        t = max(0.0, tt - TR)
        return {'D': D, 'S': self.src.S, 't': t, 'tt': tt, 'dwell': pg['dwell'], 'p': eoc(t / pg['intro']),
                'message': pg.get('message'),
                'blink2': int(t * 4) % 2 == 1, 'blink1': int(t * 2) % 2 == 1,
                'alert': D.get('alert'), 'stale': D.get('stale', False), 'stale_age': D.get('stale_age', 0),
                'running': D.get('running', False)}

    def frame(self, clk):
        P = self.pages
        total = sum(p['dwell'] for p in P)
        m = clk % total
        idx = 0
        while idx < len(P) - 1 and m >= P[idx]['dwell']:
            m -= P[idx]['dwell']; idx += 1
        tt = m
        if idx != self.cur:
            self.prev = idx if self.cur is None else self.cur
            self.cur = idx
            self.trans_at = clk - tt
        D = self.src.data()
        pg = P[idx]
        self.fbA.clear()
        pg['fn'](self.fbA, self.ctx(pg, tt, D))
        if self.prev != idx and (clk - self.trans_at) < TR:
            ps = P[self.prev]
            self.fbB.clear()
            ps['fn'](self.fbB, self.ctx(ps, ps['dwell'] - 0.01, D))
            off = R(eoc((clk - self.trans_at) / TR) * 128)
            o, a, b = self.out.b, self.fbA.b, self.fbB.b
            for y in range(H):
                base = y * W
                o[base:base + W] = b[base + off:base + W] + a[base:base + off]
            return self.out
        return self.fbA


def make_device(controller=None):
    """luma OLED cihazi. controller: 'ssd1306' | 'sh1106' (None -> env, varsayilan ssd1306)."""
    from luma.core.interface.serial import i2c
    port = int(os.environ.get('PI5_LCD_I2C_PORT', '1') or 1)
    addr = int(os.environ.get('PI5_LCD_ADDR', '0x3C'), 0)
    ctrl = str(controller or os.environ.get('PI5_LCD_CONTROLLER', 'ssd1306')).lower()
    serial = i2c(port=port, address=addr)
    if ctrl == 'sh1106':
        from luma.oled.device import sh1106
        return sh1106(serial, width=W, height=H)
    from luma.oled.device import ssd1306
    return ssd1306(serial, width=W, height=H)

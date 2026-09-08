#!/bin/sh
# SunFounder pironman5'in kasa OLED'ini ve RGB'sini GERÇEKTEN bırakmasını sağlar;
# fan ve güç yönetimi pironman5'te kalır.
#
# NEDEN CONFIG YETMİYOR: "pironman5 -oe 0 -re 0" yalnızca enable bayrağını değiştirir.
# Modüllerin donanımı açıp açmayacağı config'e değil, koddaki sabit PERIPHERALS
# listesine bakılarak belirlenir (pm_auto/pm_auto.py: "if 'oled' in peripherals" ve
# "if 'ws2812' in peripherals"). Bayrak false iken bile:
#   - pm_auto/oled.py   → OLED init edilir, I2C tutulur, sleep/wake komutu gider
#   - pm_auto/ws2812.py → loop() içinde "if not self.enable: clear(); show()" ile
#                         SPI'a durmadan siyah frame yazılır
# İkisi de bizim lcd_display.py / led_control.py ile aynı hatta yarışıyordu: ekran
# üst üste biniyor, LED rengi siliniyordu (sabit renk hiç yanmıyor, nefes kesik).
#
# Bu yüzden PERIPHERALS listesinden yalnız 'oled' ve 'ws2812' çıkarılıyor. Fan
# anahtarları (pwm_fan_*, gpio_fan_*) listede kalır; pm_auto.py fanı onlardan
# açtığı için soğutma etkilenmez.
#
# Yama idempotent: uygulanmışsa hiçbir şey yapmadan çıkar — gereksiz fan kesintisi
# ve boot gecikmesi olmaz. pironman5 paketi güncellenip yama silinirse bir sonraki
# pi5-lcd başlangıcında kendiliğinden yeniden uygulanır.
#
# restart --no-block: bu script pi5-lcd unit'inin ExecStartPre'sinden de çağrılıyor;
# oradan senkron "systemctl restart" systemd iş kuyruğunda kilitlenmeye yol açar.
#
# Her yoldan 0 ile çıkar: pironman5 kurulu olmayan kasalarda sessizce atlanmalı.
set -u

VENV_LIB=/opt/pironman5/venv/lib
[ -d "$VENV_LIB" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

CHANGED=0

for F in "$VENV_LIB"/python3*/site-packages/pironman5/variants/pironman5*.py; do
  [ -f "$F" ] || continue

  # Yamaya gerek var mı? çıkış 0 = 'oled'/'ws2812' hâlâ listede, 1 = zaten temiz.
  python3 - "$F" 2>/dev/null <<'PY' || continue
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'PERIPHERALS\s*=\s*\[.*?\]', src, re.S)
sys.exit(0 if m and re.search(r'''["'](?:oled|ws2812)["']''', m.group(0)) else 1)
PY

  cp -p "$F" "$F.klyrix.bak" 2>/dev/null || continue

  python3 - "$F" 2>/dev/null <<'PY'
import re, sys
p = sys.argv[1]
src = open(p, encoding='utf-8').read()
m = re.search(r'PERIPHERALS\s*=\s*\[.*?\]', src, re.S)
if not m:
    sys.exit(1)
block = m.group(0)
# Yalnız PERIPHERALS bloğu içinde ve yalnız tam satır eşleşmesinde sil; aynı
# kelimeler dosyanın başka yerinde (ör. SYSTEM_DEFAULT_CONFIG) geçebilir.
new = re.sub(r'''\n[ \t]*["'](?:oled|ws2812)["'][ \t]*,?(?=[\n\]])''', '', block)
open(p, 'w', encoding='utf-8').write(src[:m.start()] + new + src[m.end():])
PY

  # Doğrulama: dosya hâlâ geçerli Python mu ve fan anahtarları yerinde mi?
  if python3 -c "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())" "$F" 2>/dev/null \
     && grep -q 'gpio_fan_state' "$F" 2>/dev/null; then
    rm -f "$F.klyrix.bak"
    CHANGED=1
  else
    # Yama bozuk: yedeği geri yükle ve servise KESİNLİKLE dokunma (fan durmasın).
    mv -f "$F.klyrix.bak" "$F" 2>/dev/null || true
  fi
done

[ "$CHANGED" = "1" ] || exit 0

# PERIPHERALS import zamanında okunuyor; yama ancak servis yeniden başlayınca etkili olur.
systemctl restart --no-block pironman5 >/dev/null 2>&1 || true
exit 0

#!/bin/bash
# Post-update script — runs automatically after git pull
# Handles: npm install, dependency checks, new script permissions, migrations

set -e
BASE="/opt/pi5-gateway"
LOG="$BASE/core/update.log"
# Bu dosyayı getiren güncellemede update.sh henüz eski olabilir: HOME ve sistem geneli safe.directory burada da kurulur
# ki aşağıdaki `git diff HEAD@{1}` (npm install tespiti) "dubious ownership" ile sessizce boş dönmesin. set -e: || true.
export HOME="${HOME:-/root}"
git config --system --get-all safe.directory 2>/dev/null | grep -xF "$BASE" >/dev/null \
  || git config --system --add safe.directory "$BASE" 2>/dev/null || true

echo "$(date '+%Y-%m-%d %H:%M:%S') — Post-update başlatıldı" >> "$LOG"

# Sistem paketleri pi5-backend cgroup'unun DIŞINDA kurulur (systemd-run → scripts/pkg-ensure.sh): güncellemenin 300 sn
# exec sınırı ya da backend yeniden başlatması dpkg'yi yarıda kesemesin ("dpkg was interrupted" — canlıda yaşandı).
# En çok ~150 sn beklenir; aşılırsa birim arka planda sürer ve güncelleme derlemeye devam eder. Önceki birim hâlâ
# çalışıyorsa yenisi başlatılmaz. set -e: çağrılar `|| true` / `if` içinde yapılır.
pkg_ensure() {
  local worker="$BASE/scripts/pkg-ensure.sh" unit rcf state rc waited=0
  if systemctl list-units --state=active,activating --no-legend 'pi5-pkg-*' 2>/dev/null | grep -q .; then
    echo "  [pkg] önceki paket işlemi hâlâ sürüyor — bu tur atlandı" >> "$LOG"; return 0
  fi
  unit="pi5-pkg-$(date +%s)-$$-$RANDOM"
  rcf="/run/pi5-pkg-rc.$$.$RANDOM"
  if command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --collect --service-type=exec --unit="$unit" \
       -p StandardOutput=append:"$LOG" -p StandardError=append:"$LOG" --setenv=PI5_PKG_RC="$rcf" \
       /bin/bash "$worker" "$@" 2>>"$LOG"; then
    while [ "$waited" -lt 150 ]; do
      state=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null)
      case "$state" in
        active|activating|deactivating|reloading) sleep 2; waited=$((waited + 2)) ;;
        *) break ;;
      esac
    done
    if [ "$waited" -ge 150 ]; then
      echo "  [pkg] paket işlemi uzun sürüyor — arka planda devam ediyor ($unit)" >> "$LOG"; return 0
    fi
    rc=$(cat "$rcf" 2>/dev/null || echo 1); rm -f "$rcf"
    [ "$rc" = 0 ]
  else
    echo "  [pkg] systemd-run kullanılamadı — paket işlemi doğrudan çalıştırılıyor" >> "$LOG"
    /bin/bash "$worker" "$@" >> "$LOG" 2>&1 </dev/null
  fi
}

# 1. Backend npm install (if package.json changed)
# NOT: --production KULLANMA — tsc (typescript) devDependencies'te; --production onu siler ve build kırılır.
if git diff HEAD@{1} --name-only 2>/dev/null | grep -q "backend/package"; then
  echo "  Backend bağımlılıkları güncelleniyor..." >> "$LOG"
  cd "$BASE/backend" && npm install 2>&1 | tail -3 >> "$LOG"
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
    pip3 install --break-system-packages fanshim spidev 2>/dev/null >> "$LOG" || pip3 install fanshim spidev 2>/dev/null >> "$LOG" || true
  }
fi

if [ -f "$BASE/scripts/lcd_display.py" ]; then
  # Pillow: klyrix_oled render motorunun zorunlu bağımlılığı (luma'sız kurulumda da gerekir).
  python3 -c "from luma.oled.device import ssd1306; import PIL" 2>/dev/null || {
    echo "  LCD Python bağımlılıkları kuruluyor..." >> "$LOG"
    pip3 install --break-system-packages luma.oled luma.core RPLCD Pillow 2>/dev/null >> "$LOG" || pip3 install luma.oled luma.core RPLCD Pillow 2>/dev/null >> "$LOG" || true
  }
  # Unit'i tazele: eski kurulumlarda ExecStartPre yoktu, SunFounder pironman5 aynı
  # I2C OLED'ini sürmeye devam edip ekranı üst üste bindiriyordu.
  cat > /etc/systemd/system/pi5-lcd.service << 'LCDEOF'
[Unit]
Description=Pi5 Gateway Case LCD
After=pi5-backend.service
Wants=pi5-backend.service

[Service]
Type=simple
ExecStartPre=-/bin/sh /opt/pi5-gateway/scripts/pironman_release.sh
ExecStart=/usr/bin/python3 /opt/pi5-gateway/scripts/lcd_display.py run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
LCDEOF
  systemctl daemon-reload 2>/dev/null || true
  # Yeni render kodu ancak servis yeniden başlayınca ekrana düşer.
  systemctl restart pi5-lcd.service 2>/dev/null && echo "  pi5-lcd.service yeniden başlatıldı" >> "$LOG" || true
fi

# 4b. Sistem paketleri: wireguard-tools (Pi5 ↔ VPS tüneli wg / wg-quick) + ipset/iptables (domain/uygulama
#     yönlendirmesi: dnsmasq ipset'i doldurur, iptables mangle `-m set` ile işaretler). Yarıda kalmış dpkg'yi onarır,
#     eksikleri tek işlemde kurar.
if ! pkg_ensure wireguard-tools ipset iptables; then
  echo "  [pkg] UYARI: sistem paketleri kurulamadı (ayrıntı yukarıda)" >> "$LOG"
fi

# 5. Enable I2C/SPI if not already
raspi-config nonint do_i2c 0 2>/dev/null || true
raspi-config nonint do_spi 0 2>/dev/null || true

# 6. Kiosk bağımlılıkları (Lite OS için minimal X11 + Chromium). Trixie'de ikili adı `chromium`; eskiden yalnız
#    chromium-browser arandığı için bu apt her güncellemede boşuna (ve backend cgroup'unda) çalışıyordu.
if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
  echo "  Kiosk bağımlılıkları kuruluyor (X11 + Chromium)..." >> "$LOG"
  pkg_ensure xserver-xorg x11-xserver-utils xinit openbox chromium-browser || true
fi

# 7. Kiosk script ve servis dosyalarını oluştur/güncelle
cat > "$BASE/scripts/kiosk.sh" << 'KIOSKEOF'
#!/bin/bash
export DISPLAY=:0
xset s off
xset s noblank
xset -dpms
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-translate \
  --no-first-run \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --disable-component-update \
  --overscroll-history-navigation=0 \
  http://localhost/kiosk.html
KIOSKEOF
chmod +x "$BASE/scripts/kiosk.sh"

mkdir -p /root/.config/openbox
cat > /root/.config/openbox/autostart << 'OBEOF'
/opt/pi5-gateway/scripts/kiosk.sh &
OBEOF

# Kiosk systemd service (yoksa oluştur)
if [ ! -f /etc/systemd/system/pi5-kiosk.service ]; then
  cat > /etc/systemd/system/pi5-kiosk.service << 'SVCEOF'
[Unit]
Description=Pi5 Gateway Kiosk Display
After=pi5-backend.service network-online.target getty@tty1.service
Wants=pi5-backend.service network-online.target
Conflicts=getty@tty1.service

[Service]
Type=simple
User=root
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/xinit /usr/bin/openbox-session -- :0 vt1 -nocursor
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload 2>/dev/null || true
  echo "  pi5-kiosk.service oluşturuldu" >> "$LOG"
fi

# Kiosk config'de enabled=true ise servisi aktifleştir
if command -v python3 &>/dev/null && [ -f "$BASE/core/pi5router.sqlite" ]; then
  KIOSK_ENABLED=$(python3 -c "
import sqlite3, json
try:
    conn = sqlite3.connect('$BASE/core/pi5router.sqlite')
    row = conn.execute(\"SELECT value FROM app_settings WHERE key='kiosk_config'\").fetchone()
    if row:
        cfg = json.loads(row[0])
        print('1' if cfg.get('enabled') else '0')
    else: print('0')
except: print('0')
" 2>/dev/null)
  if [ "$KIOSK_ENABLED" = "1" ]; then
    systemctl enable --now pi5-kiosk.service 2>/dev/null || true
    echo "  Kiosk modu aktif (DB'den okunan ayar)" >> "$LOG"
  fi
fi

# 8. Panel erişim koruması: durum dosyasını kurar, açık korumayı onarır, süresi geçen denemeyi geri alır. Korumayı
#    ASLA kendiliğinden açmaz (gece 03:30 güncellemesi kimse başında değilken kilitlemesin); şifre yazdırmaz.
bash "$BASE/scripts/panel-auth.sh" ensure >> "$LOG" 2>&1 || echo "  [auth] UYARI: panel koruması denetlenemedi" >> "$LOG"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Post-update tamamlandı" >> "$LOG"

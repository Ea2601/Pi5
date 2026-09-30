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

# 1-2. npm bağımlılıkları (backend, frontend): package.json değiştiyse (git diff) YA DA node_modules'ta eksik / uyumsuz
#      paket varsa (npm ls hata verir) kurulur. Yalnız git diff'e bakmak yetmiyordu: kurulum bir kez başarısız olursa
#      (ağ vb.) ya da güncelleme yeniden denenirse HEAD@{1} aynı commit'i gösterir, kurulum atlanır ve derleme eksik paket
#      yüzünden her seferinde düşerdi. Kurulum hatası günlüğe ayrıntılı yazılır (eskiden son 3 satır).
# NOT: --production KULLANMA — tsc (typescript) devDependencies'te; --production onu siler ve build kırılır.
# --include=dev ŞART: panelden başlatılan güncelleme pi5-backend'in NODE_ENV=production ortamını devralır; npm 10 o
# ortamda `npm install` ile kurulu devDependencies'i (tsc, vite) SİLER, `npm ls` de eksik devDependency'yi göstermez
# (npm 10.9 ile denendi) → derleme her güncellemede düşer ve eksik paket hiç fark edilmezdi.
npm_sync() {
  local dir="$BASE/$1" name=$2 why="" out
  [ -f "$dir/package.json" ] || return 0
  if git diff 'HEAD@{1}' --name-only 2>/dev/null | grep -q "$1/package"; then why="package.json değişti"
  elif [ ! -d "$dir/node_modules" ]; then why="node_modules yok"
  # Yalnız eksik / sürümü tutmayan paket (npm ls "missing:" / "invalid:"); fazladan paket (extraneous) kurulum sebebi değil.
  elif (cd "$dir" && npm ls --depth=0 --include=dev 2>&1) | grep -qE "missing:|invalid:"; then why="eksik ya da uyumsuz paket"
  fi
  [ -n "$why" ] || return 0
  echo "  $name bağımlılıkları güncelleniyor ($why)..." >> "$LOG"
  if out=$(cd "$dir" && npm install --include=dev --no-audit --no-fund 2>&1); then
    printf '%s\n' "$out" | tail -3 >> "$LOG"
  else
    echo "  [npm] UYARI: $name npm install başarısız (derleme eksik paketle düşebilir):" >> "$LOG"
    printf '%s\n' "$out" | tail -25 >> "$LOG"
  fi
}
npm_sync backend Backend
npm_sync frontend Frontend

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
#     eksikleri tek işlemde kurar. iputils-arping: sabit adres (net-mode.sh) cihaz tarafı adresinin ağda boş olduğunu
#     arping -D ile doğrular (ping, modemin rotası olmayan 192.168.0.x'te dolu adresi göremez).
#     iw: Cihaz Rolleri sayfası Wi-Fi radyolarının yeteneklerini (AP / mesh / eşzamanlı çalışma) bununla okur.
#     ppp: WAN router rolünde PPPoE bağlantısı (NetworkManager'ın PPP eklentisi pppd'yi çalıştırır; hizmet başlatmaz).
#     Yedek hat: conntrack (geçişte eski hattın NAT kayıtlarını siler), usb-modeswitch (USB 4G modemi CD-ROM kipinden
#     modem kipine alır; udev ile, hizmet yok), usbmuxd (iPhone USB paylaşımı; yalnız iPhone takılınca udev başlatır).
if ! pkg_ensure wireguard-tools ipset iptables iputils-arping iw ppp conntrack usb-modeswitch usbmuxd; then
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

# 7b. Ağ geçidi kalıcılığı (Faz 2 Adım 0) — idempotent, her güncellemede yeniden yazılır:
#   - ICMP redirect kapalı: tek bacaklı ağ geçidinde Pi istemcilere "modeme doğrudan git" demesin (engel/tünel atlanırdı).
#     Kernel her arayüzde all VEYA <iface> 1 ise gönderir → all/default/eth0/wlan0 hepsi 0.
#   - Backend ağ hazır olunca başlasın (After/Wants network-online: routing ve LAN kimliği doğru adresle kurulsun).
#   - pi5-gw-restore.service: açılışta NAT / forward izni / cihaz engeli panelden bağımsız yüklenir.
mkdir -p /etc/sysctl.d
cat > /etc/sysctl.d/98-pi5-onearm.conf << 'SYSEOF'
# Klyrix Gate — tek bacaklı ağ geçidi: ICMP redirect gönderme (post-update.sh yazar)
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.eth0.send_redirects = 0
net.ipv4.conf.wlan0.send_redirects = 0
SYSEOF
sysctl -q -p /etc/sysctl.d/98-pi5-onearm.conf >/dev/null 2>&1 || true
mkdir -p /etc/systemd/system/pi5-backend.service.d
cat > /etc/systemd/system/pi5-backend.service.d/10-online.conf << 'DROPEOF'
[Unit]
After=network-online.target
Wants=network-online.target
DROPEOF
cat > /etc/systemd/system/pi5-gw-restore.service << 'GWEOF'
[Unit]
Description=Klyrix Gate - ağ geçidi kurallarını açılışta yükle (NAT, forward izni, cihaz engeli)
After=nftables.service network-online.target
Wants=network-online.target
# nftables yeniden başlatılır/yüklenirse (ör. apt yükseltmesi) kurallar silinir → bu birim de yeniden çalışır
PartOf=nftables.service
ReloadPropagatedFrom=nftables.service

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/pi5-gateway/scripts/pi5-gw-restore.sh
ExecReload=/bin/bash /opt/pi5-gateway/scripts/pi5-gw-restore.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
GWEOF
systemctl daemon-reload 2>/dev/null || true
systemctl enable pi5-gw-restore.service >/dev/null 2>&1 || true
echo "  [ağ] ICMP redirect kapalı, açılış kuralları (pi5-gw-restore) etkin" >> "$LOG"

# 7c. Sabit IP koruması (Faz 2 Adım 1) — pi5-net-guard.service: açılışta ve her NetworkManager (yeniden) başlatmasında
#     kalıcı sabit profil (pi5-eth0) denetlenir; yüklenmemişse yedekten onarılır, olmazsa adresler o açılış için elle
#     (acil mod) tutulur. Sabit adres yoksa hiçbir şey yapmaz. Hata güncellemeyi durdurmaz (set -e: her adım || / if).
cat > /etc/systemd/system/pi5-net-guard.service << 'NGEOF' || echo "  [ağ] UYARI: pi5-net-guard.service yazılamadı" >> "$LOG"
[Unit]
Description=Klyrix Gate sabit IP koruması (eth0 profili)
After=NetworkManager.service
PartOf=NetworkManager.service
Before=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=150
ExecStart=/bin/bash /opt/pi5-gateway/scripts/net-mode.sh guard

[Install]
WantedBy=multi-user.target NetworkManager.service
NGEOF
systemctl daemon-reload 2>/dev/null || true
if systemctl enable pi5-net-guard.service >/dev/null 2>&1; then
  echo "  [ağ] sabit IP koruması (pi5-net-guard) etkin" >> "$LOG"
else
  echo "  [ağ] UYARI: pi5-net-guard.service etkinleştirilemedi" >> "$LOG"
fi

# 7d. Kablosuz mesh (R2, 802.11s) — pi5-mesh.service yalnız yazılır; mesh panelden yapılandırılınca scripts/mesh.sh
#     etkinleştirir. Çalışıyorsa yeni betikle yeniden başlatılır. Hata güncellemeyi durdurmaz.
cat > /etc/systemd/system/pi5-mesh.service << 'MSEOF' || echo "  [ağ] UYARI: pi5-mesh.service yazılamadı" >> "$LOG"
[Unit]
Description=Klyrix Gate kablosuz mesh (802.11s)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=simple
ExecStart=/bin/bash /opt/pi5-gateway/scripts/mesh.sh run
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
MSEOF
systemctl daemon-reload 2>/dev/null || true
systemctl try-restart pi5-mesh.service >/dev/null 2>&1 || true

# 8. Panel erişim koruması: durum dosyasını kurar, açık korumayı onarır, süresi geçen denemeyi geri alır. Korumayı
#    ASLA kendiliğinden açmaz (gece 03:30 güncellemesi kimse başında değilken kilitlemesin); şifre yazdırmaz.
bash "$BASE/scripts/panel-auth.sh" ensure >> "$LOG" 2>&1 || echo "  [auth] UYARI: panel koruması denetlenemedi" >> "$LOG"

# 8b. Sabit IP durumu: süresi geçen denemeyi geri alır, kalıcı sabit profili denetler (gerekirse onarır). Sabit adresi
#     ASLA kendiliğinden açmaz.
bash "$BASE/scripts/net-mode.sh" ensure >> "$LOG" 2>&1 || echo "  [ağ] UYARI: sabit IP durumu denetlenemedi" >> "$LOG"

# 8c. Veri diski: hazırlanmış veri diski (klyrix-data) varsa fstab satırlarını ve bağlamaları (panel verileri, Pi-hole,
#     günlükler) onarır. Disk yoksa hiçbir şey yapmaz; veri taşımaz, diski ASLA silmez (hazırlama: Depolama sayfası).
bash "$BASE/scripts/storage.sh" ensure >> "$LOG" 2>&1 || echo "  [depolama] UYARI: veri diski denetlenemedi" >> "$LOG"

# 9. Hız testi motoru: Ookla Speedtest CLI (sabit sürüm + SHA256; kuruluysa hiçbir şey yapmaz). Kurulamazsa panel
#    speedtest-cli'ye düşer; hata güncellemeyi durdurmaz.
bash "$BASE/scripts/ookla-ensure.sh" >> "$LOG" 2>&1 || echo "  [ookla] UYARI: kurulamadı — hız testi speedtest-cli ile sürer" >> "$LOG"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Post-update tamamlandı" >> "$LOG"

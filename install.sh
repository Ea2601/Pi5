#!/bin/bash
set -e

# ╔══════════════════════════════════════════════════════════════╗
# ║         Klyrix/gate — Tek Komut Kurulum                      ║
# ║                                                              ║
# ║  Kullanım:                                                   ║
# ║    curl -fsSL https://raw.githubusercontent.com/             ║
# ║      Ea2601/klyrix-gate/master/install.sh | bash              ║
# ║                                                              ║
# ║  veya:                                                       ║
# ║    git clone https://github.com/Ea2601/klyrix-gate.git        ║
# ║    cd klyrix-gate && chmod +x install.sh && ./install.sh     ║
# ╚══════════════════════════════════════════════════════════════╝

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="/opt/pi5-gateway"
SERVICE_USER="pi5gw"

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

# Root kontrolü
if [ "$EUID" -ne 0 ]; then
  err "Bu script root olarak çalıştırılmalı: sudo bash install.sh"
fi

echo -e "${BLUE}"
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║     Klyrix/gate Kurulum Başlıyor             ║"
echo "  ╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Mimari: Node.js 22 (NodeSource) yalnız amd64 / arm64 / armhf (ARMv7 ve üstü) için var ───
# Burada satır içi: curl | bash ile çalışırken depo (scripts/platform.sh) henüz yok. Kullanıcı alanı mimarisi dpkg'den
# (Pi 5'te 32 bit sistem uname'de aarch64 görünür). 32 bit Raspberry Pi OS armv6 kartlarda (Pi Zero W, Pi 1) da "armhf"
# der: çekirdek armv6 ise Node.js 22 çalışmaz.
ARCH=$(dpkg --print-architecture 2>/dev/null || true)
KARCH=$(uname -m 2>/dev/null || true)
case "$ARCH" in
  amd64|arm64) ;;
  armhf)
    case "$KARCH" in
      armv6*) err "Bu işlemci (armv6: Pi Zero W / Pi 1) desteklenmiyor — Node.js 22 ARMv7 ya da 64 bit işlemci ister (Pi Zero 2 W, Pi 3/4/5)." ;;
    esac ;;
  *) err "Desteklenmeyen mimari: ${ARCH:-bilinmiyor} ($KARCH) — Klyrix Gate amd64 (x86_64), arm64 ya da armhf (32 bit Raspberry Pi OS) ister." ;;
esac

# ─── Cihaz rolü (R2): ana cihaz ya da mesh uydusu ───
# Kurulum ikisinde de aynıdır (tam kurulum). Uyduda panel ağ geçidi işlerini (yönlendirme, DNS/DHCP kuralları, tüneller)
# çalıştırmaz; ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle yayınlar. Soru terminalden (/dev/tty) sorulur: curl | bash
# ile de çalışır. Terminal yoksa önceki rol korunur (ilk kurulumda ana cihaz). KLYRIX_ROLE=main|satellite ile de verilir;
# rol sonradan panelden (Cihaz Rolleri → Uydular) değiştirilebilir.
ROLE_FILE=/etc/pi5-gateway/role
ROLE=${KLYRIX_ROLE:-}
PREV_ROLE=$(sed -n 's/^role=//p' "$ROLE_FILE" 2>/dev/null | head -1)
if [ -z "$ROLE" ] && ( exec </dev/tty ) 2>/dev/null; then
  echo "Bu cihaz nasıl kullanılacak?"
  echo "  1) Ana cihaz — ağ geçidi, DNS, DHCP, yönlendirme (varsayılan)"
  echo "  2) Uydu (mesh) — ana cihazın Wi-Fi'ını evin başka bir yerinde yayınlar"
  ROLE_ANS=""
  read -r -p "Seçim [1/2]: " ROLE_ANS < /dev/tty || ROLE_ANS=""
  case "$ROLE_ANS" in 2|u|U|uydu|Uydu) ROLE=satellite ;; *) ROLE=main ;; esac
fi
[ -n "$ROLE" ] || ROLE=${PREV_ROLE:-main}
case "$ROLE" in satellite) ;; *) ROLE=main ;; esac
mkdir -p /etc/pi5-gateway && chmod 755 /etc/pi5-gateway && printf 'role=%s\n' "$ROLE" > "$ROLE_FILE"
if [ "$ROLE" = satellite ]; then log "Cihaz rolü: uydu (mesh)"; else log "Cihaz rolü: ana cihaz"; fi

# ─── 1. Sistem Güncellemesi ───
step "1/10 — Sistem Güncelleniyor"
apt update -qq
apt upgrade -y -qq
log "Sistem güncellendi"

# ─── 2. Gerekli Paketler ───
step "2/10 — Bağımlılıklar Kuruluyor"
# dhcp-helper paketi kurulunca kendi servisini açıp UDP 67'yi tutar (Pi DHCP'siyle çakışır): servis kurulumdan ÖNCE
# maskelenir; Wi-Fi köprüsü (net-mode.sh rep) kendi birimini yalnız köprü açıkken çalıştırır.
systemctl mask --now dhcp-helper.service >/dev/null 2>&1 || true
apt install -y -qq \
  curl git build-essential \
  sqlite3 libsqlite3-dev \
  nginx certbot python3-certbot-nginx apache2-utils \
  qrencode speedtest-cli vnstat etherwake \
  ipset iptables wireguard-tools iputils-arping iw ppp \
  conntrack usb-modeswitch usbmuxd \
  parprouted dhcp-helper dnsmasq-base avahi-daemon avahi-utils

# NetworkManager: sabit adres ve ağ rolleri (scripts/net-mode.sh) onunla yönetilir. Raspberry Pi OS'ta zaten kuruludur;
# düz Debian'da (ifupdown / systemd-networkd, ör. x86) yoksa kurulur. Paketten ÖNCE no-auto-default yazılır: NM
# yönetmediği kartlara kendiliğinden "Wired connection" profili açıp mevcut adresi değiştirmesin. /etc/network/interfaces,
# netplan ve systemd-networkd ayarlarına dokunulmaz: ifupdown / netplan kartı NM'de "yönetilmiyor", salt systemd-networkd /
# dhcpcd kartı "dışarıdan bağlı" (connected (externally)) görünür; panel ikisini de bildirir, roller o kartta açılmaz.
if ! command -v nmcli >/dev/null 2>&1; then
  if { mkdir -p /etc/NetworkManager/conf.d \
       && printf '[main]\nno-auto-default=*\n' > /etc/NetworkManager/conf.d/90-klyrix-no-auto-default.conf; } 2>/dev/null; then
    warn "NetworkManager kuruluyor (ağ rolleri için gerekli)..."
    if apt install -y -qq network-manager; then log "NetworkManager kuruldu"
    else warn "NetworkManager kurulamadı — sabit adres ve ağ rolleri çalışmaz (sonra: sudo apt install network-manager)"; fi
  else
    warn "NetworkManager ayarı yazılamadı — paket kurulmadı (sabit adres ve ağ rolleri NetworkManager ister)"
  fi
fi

# Node.js 22 LTS
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  warn "Node.js kuruluyor..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y -qq nodejs
fi
log "Node.js $(node -v) hazır"
log "npm $(npm -v) hazır"

# ─── 3. Proje Dosyaları ───
step "3/10 — Proje Dosyaları İndiriliyor"
if [ -d "$INSTALL_DIR" ]; then
  warn "Mevcut kurulum bulundu, güncelleniyor..."
  cd "$INSTALL_DIR"
  git pull --rebase 2>/dev/null || true
else
  git clone https://github.com/Ea2601/klyrix-gate.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
log "Proje dosyaları hazır: $INSTALL_DIR"

# ─── Donanım profili (scripts/platform.sh — eşikler tek yerde; panel de aynısını okur) ───
# Bellek sınıfı (512 MB, 1 GB, 2 GB …), kullanıcı alanı mimarisi, ekran çıkışı ve takas. Profil saklanmaz, her seferinde
# gerçeklerden çıkar; yalnız KLYRIX_PROFILE=lite|standard verilirse elle seçim olarak /etc/pi5-gateway/profile'a yazılır.
# Okunamazsa (eski depo / hata) bugünkü davranış sürer: aşağıdaki kapılar yalnız açıkça "hayır" diyen değerde atlar.
case "${KLYRIX_PROFILE:-}" in
  lite|standard)
    if { printf 'profile=%s\n' "$KLYRIX_PROFILE" > /etc/pi5-gateway/profile; } 2>/dev/null; then log "Donanım profili elle seçildi: $KLYRIX_PROFILE"
    else warn "Donanım profili yazılamadı (/etc/pi5-gateway/profile)"; fi ;;
  "") ;;
  *) warn "KLYRIX_PROFILE yalnız lite ya da standard olabilir — yok sayıldı" ;;
esac
# KLYRIX_ZRAM=0 kalıcı olsun: gece / panel güncellemesi (post-update.sh) bu ortam değişkenini görmez, dosyaya bakar.
if [ "${KLYRIX_ZRAM:-}" = 0 ]; then
  if { : > /etc/pi5-gateway/zram.off; } 2>/dev/null; then log "zram kapalı (KLYRIX_ZRAM=0 → /etc/pi5-gateway/zram.off)"
  else warn "zram kapatma tercihi yazılamadı (/etc/pi5-gateway/zram.off)"; fi
fi
PLAT=$(bash "$INSTALL_DIR/scripts/platform.sh" detect 2>/dev/null) || PLAT=""
plat() { printf '%s\n' "$PLAT" | sed -n "s/^$1=//p" | head -1; }
if [ -n "$PLAT" ]; then
  if [ "$(plat profile)" = lite ]; then PLAT_PROFILE="Hafif"; else PLAT_PROFILE="Standart"; fi
  if [ "$(plat forced)" = 1 ]; then PLAT_PROFILE="$PLAT_PROFILE (elle seçildi)"; fi
  log "Donanım: $(plat board) · $(plat mem_mib) MB bellek ($(plat mem_class) MB sınıfı) · $(plat arch) · profil: $PLAT_PROFILE"
  if [ "$(plat profile)" = lite ] && [ "$(plat forced)" = 1 ]; then
    warn "Hafif profil elle seçildi (/etc/pi5-gateway/profile): HDMI ekranı (kiosk) kurulmaz"
  elif [ "$(plat profile)" = lite ]; then
    warn "Az bellekli cihaz: HDMI ekranı (kiosk) kurulmaz; derleme belleği zorlar (bellek biterse DNS değil derleme durur)"
  fi
else
  warn "Donanım profili okunamadı — tüm adımlar varsayılanla sürüyor"
fi

# zram: takas alanı hiç yoksa ve işletim sisteminin takas yöneticisi de yoksa (Raspberry Pi OS'ta rpi-swap vardır), 1 GB
# sınıfı ve altında derlemelerden ÖNCE. Kapatmak: KLYRIX_ZRAM=0 (yukarıda zram.off olarak saklanır) ya da
# /etc/pi5-gateway/zram.off. Bookworm'da paketin kendi varsayılan ayarı başlatılır (platform.sh swap-ensure).
if [ "$(plat need_zram)" = 1 ]; then
  warn "Takas alanı yok ve bellek az: zram (sıkıştırılmış bellek takası) kuruluyor..."
  if apt install -y -qq systemd-zram-generator; then
    if ZOUT=$(bash "$INSTALL_DIR/scripts/platform.sh" swap-ensure 2>&1); then log "zram: $(printf '%s\n' "$ZOUT" | tr '\n' ' ')"
    else warn "zram açılamadı: $(printf '%s\n' "$ZOUT" | tr '\n' ' ') — takassız devam ediliyor"; fi
  else
    warn "systemd-zram-generator kurulamadı — takassız devam ediliyor"
  fi
fi

# Hız testi motoru: Ookla Speedtest CLI (resmi; en yakın sunucu, çoklu bağlantı). Kurulamazsa speedtest-cli kullanılır.
if bash "$INSTALL_DIR/scripts/ookla-ensure.sh"; then log "Hız testi: Ookla Speedtest CLI hazır"
else warn "Ookla Speedtest CLI kurulamadı — hız testi speedtest-cli ile sürer (sonra: sudo bash $INSTALL_DIR/scripts/ookla-ensure.sh)"; fi

# ─── Derleme yöntemi (scripts/prebuilt.sh — panelde Ayarlar → Sistem Güncellemesi → Güncelleme Yöntemi) ───
# local: panel Pi'de derlenir (tsc + vite; ~400 MB bellek). prebuilt: GitHub'ın bu commit için derlediği hazır paket
# indirilir — frontend'de hiç npm yok, backend'e yalnız üretim bağımlılıkları. auto (varsayılan): 1 GB sınıfı ve altında
# hazır paket. KLYRIX_BUILD=auto|local|prebuilt ile elle seçilir ve /etc/pi5-gateway/build-mode'a yazılır (güncellemeler
# de onu okur). Okunamazsa (eski depo / hata) bugünkü davranış: Pi'de derle.
case "${KLYRIX_BUILD:-}" in
  auto|local|prebuilt)
    if { printf 'mode=%s\n' "$KLYRIX_BUILD" > /etc/pi5-gateway/build-mode; } 2>/dev/null; then log "Derleme yöntemi elle seçildi: $KLYRIX_BUILD"
    else warn "Derleme yöntemi yazılamadı (/etc/pi5-gateway/build-mode)"; fi ;;
  "") ;;
  *) warn "KLYRIX_BUILD yalnız auto, local ya da prebuilt olabilir — yok sayıldı" ;;
esac
BUILD_EFFECTIVE=local
BUILD_LOCAL_OK=1
BMODE=$(bash "$INSTALL_DIR/scripts/prebuilt.sh" mode 2>/dev/null) || BMODE=""
bmode() { printf '%s\n' "$BMODE" | sed -n "s/^$1=//p" | head -1; }
if [ "$(bmode effective)" = prebuilt ]; then BUILD_EFFECTIVE=prebuilt; fi
if [ "$(bmode local_ok)" = 0 ]; then BUILD_LOCAL_OK=0; fi
if [ "$BUILD_EFFECTIVE" = prebuilt ]; then log "Derleme yöntemi: hazır paket (GitHub) — panel bu cihazda derlenmez"
else log "Derleme yöntemi: Pi'de derle"; fi

# ─── 4. Backend Kurulumu ───
step "4/10 — Backend Kuruluyor"
cd "$INSTALL_DIR/backend"
# Hazır paket: yalnız üretim bağımlılıkları (sqlite3 yerel modül — pakete konamaz) + bu commit'in derlemesi. Paket
# alınamazsa belleği yeten cihaz (2 GB sınıfı ve üstü) aşağıdaki yerel derlemeye düşer; yetmeyende kurulum durur.
if [ "$BUILD_EFFECTIVE" = prebuilt ]; then
  npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund
  if PB_OUT=$(bash "$INSTALL_DIR/scripts/prebuilt.sh" fetch "$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null)" "$INSTALL_DIR"); then
    for d in backend frontend; do
      rm -rf "$INSTALL_DIR/$d/dist.prev"
      if [ -d "$INSTALL_DIR/$d/dist" ]; then mv "$INSTALL_DIR/$d/dist" "$INSTALL_DIR/$d/dist.prev"; fi
      mv "$INSTALL_DIR/$d/dist.next" "$INSTALL_DIR/$d/dist"
    done
    log "Hazır paket kuruldu: $(printf '%s\n' "$PB_OUT" | sed -n 's/^tag=//p' | head -1)"
  elif [ "$BUILD_LOCAL_OK" = 1 ]; then
    warn "Hazır paket alınamadı — panel bu cihazda derleniyor"
    BUILD_EFFECTIVE=local
  else
    err "Hazır paket bulunamadı (GitHub derlemesi henüz bitmemiş olabilir) — birkaç dakika sonra yeniden çalıştırın"
  fi
fi
if [ "$BUILD_EFFECTIVE" = local ]; then
  npm ci --production=false 2>/dev/null || npm install
  # Derleme alt kabukta oom_score_adj 500 ile: bellek biterse çekirdek önce derlemeyi öldürür, DNS'i (pihole-FTL, Unbound) değil.
  ( { echo 500 > /proc/self/oom_score_adj; } 2>/dev/null || true; npm run build ) || warn "Backend build hata verdi"
fi
# Build çıktısı yoksa servisi başlatma — dist/index.js olmadan pi5-backend sonsuz crash-loop'a girer
if [ ! -f "$INSTALL_DIR/backend/dist/index.js" ]; then
  err "Backend build başarısız (dist/index.js yok). Kurulum durduruldu — crash-loop önlendi. Logları kontrol edin."
fi
if [ "$BUILD_EFFECTIVE" = prebuilt ]; then log "Backend hazır paketten kuruldu"; else log "Backend derlendi"; fi

# ─── 5. Frontend Kurulumu ───
step "5/10 — Frontend Kuruluyor"
cd "$INSTALL_DIR/frontend"
if [ "$BUILD_EFFECTIVE" = prebuilt ]; then
  log "Frontend hazır paketten kuruldu (npm ve derleme yok)"
else
  npm ci --production=false 2>/dev/null || npm install
  ( { echo 500 > /proc/self/oom_score_adj; } 2>/dev/null || true; npm run build )
  log "Frontend build tamamlandı"
fi

# ─── 6. Ağ Servislerinin Kurulumu ───
step "6/10 — Ağ Servisleri Kuruluyor"

# --- Pi-hole ---
if command -v pihole &>/dev/null; then
  log "Pi-hole zaten kurulu"
else
  warn "Pi-hole kuruluyor (headless)..."
  mkdir -p /etc/pihole
  # Pi-hole'un arayüzü: en düşük metrikli varsayılan rotanın kartı (wg*/lo/docker*/veth* hariç); rota yoksa ilk fiziksel
  # kart (/sys/class/net/X/device var, tür 1), o da yoksa eth0. Kart adı cihaza göre değişir (eth0, end0, enp1s0 …).
  PH_IF=$(ip -4 route show default 2>/dev/null | awk '
    { dev = ""; m = 0
      for (i = 1; i < NF; i++) { if ($i == "dev") dev = $(i + 1); else if ($i == "metric") m = $(i + 1) + 0 }
      if (dev == "" || dev == "lo" || dev ~ /^(wg|docker|veth)/) next
      if (best == "" || m < bm) { best = dev; bm = m } }
    END { if (best != "") print best }') || PH_IF=""
  if [ -z "$PH_IF" ]; then
    for d in /sys/class/net/*; do
      if [ -e "$d/device" ] && [ "$(cat "$d/type" 2>/dev/null)" = 1 ]; then PH_IF=${d##*/}; break; fi
    done
  fi
  [ -n "$PH_IF" ] || PH_IF=eth0
  printf 'PIHOLE_INTERFACE=%s\n' "$PH_IF" > /etc/pihole/setupVars.conf
  cat >> /etc/pihole/setupVars.conf << 'PHEOF'
# Gizlilik: TEK upstream = Unbound (recursive). 1.1.1.1 gibi ikinci upstream eklemek
# sorguların yarısını Unbound'u atlayıp dış sağlayıcıya sızdırır — kasıtlı olarak eklenmedi.
PIHOLE_DNS_1=127.0.0.1#5335
QUERY_LOGGING=true
INSTALL_WEB_SERVER=false
INSTALL_WEB_INTERFACE=false
LIGHTTPD_ENABLED=false
CACHE_SIZE=10000
DNS_FQDN_REQUIRED=true
DNS_BOGUS_PRIV=true
DNSMASQ_LISTENING=local
BLOCKING_ENABLED=true
PHEOF
  curl -sSL https://install.pi-hole.net | bash /dev/stdin --unattended
  log "Pi-hole kuruldu"
fi

# --- Unbound (recursive DNS) ---
if command -v unbound &>/dev/null; then
  log "Unbound zaten kurulu"
else
  warn "Unbound kuruluyor..."
  apt install -y -qq unbound
  # Pi-hole'un resmî Unbound rehberindeki yapılandırma (docs.pi-hole.net/guides/dns/unbound). use-caps-for-id: no — rehber:
  # büyük/küçük harf karıştırma zaman zaman DNSSEC sorunlarına yol açıyor. Önbellek/gizleme ayarları paneldedir
  # (Unbound DNS → Ayarlar; /etc/unbound/unbound.conf.d/klyrix-panel.conf).
  cat > /etc/unbound/unbound.conf.d/pi5-unbound.conf << 'UBEOF'
server:
    verbosity: 0
    interface: 127.0.0.1
    port: 5335
    do-ip4: yes
    do-udp: yes
    do-tcp: yes
    do-ip6: no
    prefer-ip6: no
    harden-glue: yes
    harden-dnssec-stripped: yes
    aggressive-nsec: yes
    use-caps-for-id: no
    hide-identity: yes
    hide-version: yes
    edns-buffer-size: 1232
    prefetch: yes
    num-threads: 1
    so-rcvbuf: 1m
    private-address: 192.168.0.0/16
    private-address: 169.254.0.0/16
    private-address: 172.16.0.0/12
    private-address: 10.0.0.0/8
UBEOF
  # Debian paketi güven çapasını kendi dosyasında tanımlar; ikinci kez yazmak Unbound'u başlatmaz ("trust anchor presented
  # twice"). Yalnız o dosya yoksa eklenir.
  if [ ! -f /etc/unbound/unbound.conf.d/root-auto-trust-anchor-file.conf ]; then
    echo '    auto-trust-anchor-file: "/var/lib/unbound/root.key"' >> /etc/unbound/unbound.conf.d/pi5-unbound.conf
  fi
  # Güven çapası (root.key) normalde Unbound'un ilk başlatılışında Debian yardımcısıyla oluşur (unbound.service
  # ExecStartPre); denetimden önce aynı yardımcıyla oluşturulur (dns-root-data paketinden kopyalar).
  [ -x /usr/libexec/unbound-helper ] && /usr/libexec/unbound-helper root_trust_anchor_update || true
  if ! unbound-checkconf >/dev/null 2>&1; then
    unbound-checkconf || true
    err "Unbound yapılandırması geçersiz (yukarıdaki hata) — /etc/unbound/unbound.conf.d/pi5-unbound.conf düzeltilmeli"
  fi
  systemctl enable unbound
  systemctl restart unbound
  log "Unbound kuruldu ve aktif (port 5335)"
fi

# --- Fail2Ban ---
if command -v fail2ban-client &>/dev/null; then
  log "Fail2Ban zaten kurulu"
else
  warn "Fail2Ban kuruluyor..."
  apt install -y -qq fail2ban
  cat > /etc/fail2ban/jail.local << 'F2BEOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
# journald-only sistemlerde (Bookworm) /var/log/auth.log olmayabilir — systemd backend journal'ı okur
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 3
bantime = 7200
F2BEOF
  systemctl enable fail2ban
  systemctl restart fail2ban
  log "Fail2Ban kuruldu ve aktif"
fi

# --- nftables ---
if command -v nft &>/dev/null; then
  log "nftables zaten kurulu"
else
  warn "nftables kuruluyor..."
  apt install -y -qq nftables
fi
systemctl enable nftables
log "nftables aktif"

# --- Zapret (DPI bypass) ---
# Kaynaktan derlenir + servis birimi kurulur (scripts/zapret-install.sh); servis kapalı kalır, panelden açılır. Eskiden
# etkileşimli install_easy.sh'e körlemesine "1\n1" veriliyordu: hata gizleniyor, birim ve nfqws kurulmuyordu.
warn "Zapret kuruluyor (derleme birkaç dakika sürebilir)..."
if bash "$INSTALL_DIR/scripts/zapret-install.sh"; then log "Zapret hazır (panelden açılır)"
else warn "Zapret kurulamadı — DPI çalışmaz (sonra: sudo bash $INSTALL_DIR/scripts/zapret-install.sh; panel güncellemesi de dener)"; fi

# ─── Hardware: LED, LCD bağımlılıkları ───
# Bookworm (PEP 668) externally-managed-environment: --break-system-packages gerekir, yoksa sessiz başarısızlık.
# Kasa (OLED / LED / fan HAT) kütüphaneleri yalnız Raspberry Pi'de (platform.sh rpi=1; okunamazsa da kurulur).
if [ "$(plat rpi)" != 0 ]; then
  warn "Pimoroni kasa bağımlılıkları kuruluyor..."
  # Pillow: kasa OLED render motorunun (scripts/klyrix_oled.py) tek zorunlu bağımlılığı.
  pip3 install --break-system-packages --quiet fanshim spidev luma.oled luma.core RPLCD Pillow 2>/dev/null \
    || pip3 install --quiet fanshim spidev luma.oled luma.core RPLCD Pillow 2>/dev/null \
    || warn "Pimoroni pip bağımlılıkları kurulamadı (donanım yoksa normal)"
  log "Pimoroni bağımlılık adımı tamamlandı"
else
  log "Raspberry Pi değil — kasa (OLED / LED) kütüphaneleri atlandı"
fi

# ─── Kasa LCD servisi (kalıcı döngü daemon'u — fork yerine systemd) ───
# Birim tek kaynaktan (scripts/systemd/pi5-lcd.service; post-update.sh ve backend de aynısını kullanır)
install -m 0644 "$INSTALL_DIR/scripts/systemd/pi5-lcd.service" /etc/systemd/system/pi5-lcd.service
systemctl daemon-reload 2>/dev/null || true
systemctl enable pi5-lcd.service 2>/dev/null || true
log "Kasa LCD servisi hazır (pi5-lcd.service). Denetleyici: panelden ssd1306/sh1106 seçilebilir."

# ─── Kiosk: Minimal X11 + Chromium (Lite OS için) ───
# Yalnız HDMI ekranı açılabilecek cihazda (platform.sh kiosk: 512 MB sınıfında "no", ekran çıkışı yoksa "no-display").
# Birim yine kurulur: panel (kiosk.ts) onu arar ve nedeni söyler.
case "$(plat kiosk)" in
  no)
    if [ "$(plat forced)" = 1 ]; then warn "HDMI ekranı (kiosk) atlandı: Hafif profil elle seçildi — X11 / Chromium kurulmadı"
    else warn "HDMI ekranı (kiosk) atlandı: $(plat mem_mib) MB bellek tarayıcıya yetmez (en az 1 GB) — X11 / Chromium kurulmadı"; fi ;;
  no-display) warn "HDMI ekranı (kiosk) atlandı: ekran çıkışı bulunamadı — X11 / Chromium kurulmadı" ;;
  *)
    if [ "$(plat kiosk)" = warn ]; then warn "1 GB bellek: HDMI ekranı açılabilir ama tarayıcı için dar"; fi
    warn "Kiosk modu bağımlılıkları kuruluyor (Lite OS)..."
    apt install -y -qq xserver-xorg x11-xserver-utils xinit openbox 2>/dev/null || true
    # Bookworm tarayıcıyı "chromium" olarak paketler; eski/türev imajlar "chromium-browser" kullanır.
    apt install -y -qq chromium 2>/dev/null || apt install -y -qq chromium-browser 2>/dev/null || true ;;
esac

# Kiosk betiği depoda (scripts/kiosk.sh — Chromium'u root değil klyrix-kiosk kullanıcısıyla açar) ve birim tek
# kaynaktan (scripts/systemd/pi5-kiosk.service: xinit → openbox --startup kiosk.sh). Eskiden ikisi burada ve
# post-update.sh'de ayrı ayrı yazılıyordu; Chromium root'ta sandbox'sız açılmadığı için kiosk hiç görünmüyordu.
chmod +x /opt/pi5-gateway/scripts/kiosk.sh /opt/pi5-gateway/scripts/pironman_release.sh 2>/dev/null || true
install -m 0644 "$INSTALL_DIR/scripts/systemd/pi5-kiosk.service" /etc/systemd/system/pi5-kiosk.service
systemctl daemon-reload 2>/dev/null || true

# Kiosk servisini aktifleştirme — panelden kontrol edilecek
# systemctl enable pi5-kiosk ile aktif edilir
log "Kiosk modu hazır (pi5-kiosk.service — panelden etkinleştirin)"

# ─── 7. Veri Diski & Veri Dizini ───
step "7/10 — Veri Diski & Veri Dizini"

# İşletim sistemi SD kartta kalır. Veri diski işi scripts/storage.sh'dedir (panelin Depolama sayfası da onu kullanır):
#  - Daha önce hazırlanmış veri diski (etiket klyrix-data) varsa yalnız fstab satırları ve bağlamalar onarılır.
#  - TAMAMEN BOŞ bir NVMe varsa veri diski yapılır (128 GB ve üstü: 64 GB sistem verileri + geri kalanı paylaşım; küçükse
#    tek bölüm); panel verileri, Pi-hole sorgu veritabanı ve günlükler diske taşınır, SD kartta bir kopyası kalır.
#  - Bölümü ya da verisi olan disk ASLA kendiliğinden silinmez: panelde Depolama sayfasından (önce eski sistemi arşivleyip)
#    hazırlanır. Kurulumda silmek için açık onay: PI5_FORMAT_SSD=1 sudo ./install.sh
mkdir -p "$INSTALL_DIR/core"
STORAGE_ARGS=(auto)
[ "${PI5_FORMAT_SSD:-0}" = "1" ] && STORAGE_ARGS+=(--force)
if STORAGE_OUT=$(bash "$INSTALL_DIR/scripts/storage.sh" "${STORAGE_ARGS[@]}" 2>&1); then
  if grep -q '^result=ok' <<<"$STORAGE_OUT"; then
    log "Veri diski hazırlandı: $(grep -m1 '^data_dev=' <<<"$STORAGE_OUT" | cut -d= -f2) — panel verileri, Pi-hole ve günlükler diskte"
    grep '^warning=' <<<"$STORAGE_OUT" | cut -d= -f2- | while read -r w; do warn "$w"; done
  elif grep -q '^error=' <<<"$STORAGE_OUT"; then
    warn "Veri diski bağlanamadı: $(grep -m1 '^error=' <<<"$STORAGE_OUT" | cut -d= -f2-) — SD karttaki kopyayla devam ediliyor"
  elif grep -q '^data=/dev/' <<<"$STORAGE_OUT"; then
    log "Veri diski bağlı: $(grep -m1 '^data=' <<<"$STORAGE_OUT" | cut -d= -f2)"
  else
    grep '^skipped=' <<<"$STORAGE_OUT" | cut -d= -f2- | while read -r s; do warn "Disk atlandı: $s"; done
    warn "Veri diski yok — SD kart üzerinde çalışılacak (desteklenen kurulum)"
  fi
else
  warn "Veri diski hazırlanamadı: $(grep -m1 '^error=' <<<"$STORAGE_OUT" | cut -d= -f2-) — SD kart üzerinde devam ediliyor"
  warn "Ayrıntı: sudo bash $INSTALL_DIR/scripts/storage.sh status; panelde Depolama sayfası"
fi
mkdir -p "$INSTALL_DIR/core"

touch "$INSTALL_DIR/core/system.log"
log "Core dizini hazır"

# ─── 8. Systemd Servisleri ───
step "8/10 — Sistem Servisleri Kuruluyor"

# Backend servisi
cat > /etc/systemd/system/pi5-backend.service << 'SVCEOF'
[Unit]
Description=Pi5 Gateway Backend API
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/pi5-gateway/backend
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3001
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

# Domain redirect map (backend applyDomainRouting tarafından yönetilir; başlangıçta boş)
mkdir -p /etc/nginx/conf.d
if [ ! -f /etc/nginx/conf.d/pi5-redirect-map.conf ]; then
  printf 'map $host $pi5_redirect {\n    default "";\n}\n' > /etc/nginx/conf.d/pi5-redirect-map.conf
fi
# Yedek geri yükleme 20 MB'a kadar (nginx varsayılanı 1 MB); öbür uçları backend 1 MB'ta tutar. post-update 8f ile aynı.
printf '%s\n%s\n' '# Klyrix Gate: yedek geri yükleme 20 MB (backend öbür uçlarda 1 MB) — post-update yazar' 'client_max_body_size 20m;' \
  > /etc/nginx/conf.d/pi5-body.conf

# Nginx reverse proxy (frontend + API)
cat > /etc/nginx/sites-available/pi5-gateway << 'NGXEOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Panel erişim koruması (opt-in Basic Auth — localhost/kiosk muaf). İçerik pi5-auth.conf'tan gelir.
    include /etc/nginx/snippets/pi5-auth.conf;

    # Frontend (statik dosyalar)
    root /opt/pi5-gateway/frontend/dist;
    index index.html;

    location / {
        # DNS ile Pi5'e yönlendirilen domain'ler için 302 (pi5_redirect map'ten gelir)
        if ($pi5_redirect) { return 302 $pi5_redirect; }
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }

    # Güvenlik headerları
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGXEOF

# ─── Panel Erişim Koruması (Basic Auth) ───
# scripts/panel-auth.sh yönetir: koruma http seviyesindeki /etc/nginx/conf.d/pi5-auth.conf ile gelir, Pi'nin kendisi
# (127.0.0.1/::1: kiosk, OLED) muaftır. Site dosyasının eski include satırı için snippet yalnız yorum olarak kalır.
mkdir -p /etc/nginx/snippets
[ -f /etc/nginx/snippets/pi5-auth.conf ] || \
  echo "# Panel koruması conf.d/pi5-auth.conf ile yönetilir (scripts/panel-auth.sh)" > /etc/nginx/snippets/pi5-auth.conf

# Nginx aktifleştir
ln -sf /etc/nginx/sites-available/pi5-gateway /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# Şifre terminalde iki kez sorulup yalnız KAYDEDİLİR; koruma burada açılmaz. Açma, panelin üstündeki banttan 5 dk'lık
# denemeyle yapılır: şifreyle girebilen tarayıcı "Kalıcı yap" demezse kendiliğinden geri alınır (yanlış yazılan şifre
# kilitlemez). Şifre ortam değişkeniyle verilmez (sudo'nun argv'sinde görünür).
bash "$INSTALL_DIR/scripts/panel-auth.sh" ensure >/dev/null 2>&1 || true
if [ -t 0 ]; then
  read -rsp "Panel şifresi belirleyin (en az 12 karakter; boş bırakırsanız panelden belirlersiniz): " PANEL_PW; echo
  if [ -n "$PANEL_PW" ]; then
    read -rsp "Tekrar: " PANEL_PW2; echo
    if [ "$PANEL_PW" != "$PANEL_PW2" ]; then
      warn "Şifreler eşleşmedi — panelin üstündeki banttan belirleyin"
    elif printf '%s\n' "$PANEL_PW" | bash "$INSTALL_DIR/scripts/panel-auth.sh" set-password >/dev/null; then
      log "Panel şifresi kaydedildi — korumayı panelin üstündeki banttan açın (5 dk deneme)"
    else
      warn "Panel şifresi kaydedilemedi (en az 12 karakter) — panelin üstündeki banttan belirleyin"
    fi
  fi
  unset PANEL_PW PANEL_PW2
fi
warn "Panel koruması KAPALI — panelin üstündeki banttan şifreyi belirleyip korumayı açın"

# Servisleri etkinleştir
systemctl daemon-reload
systemctl enable pi5-backend
systemctl start pi5-backend
log "Backend servisi çalışıyor"
log "Nginx reverse proxy aktif"

# ─── 9. IP Forwarding & Ağ Ayarları ───
step "9/10 — IP Forwarding Aktifleştiriliyor"
cat > /etc/sysctl.d/99-pi5-gateway.conf << 'SYSEOF'
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
SYSEOF
sysctl -p /etc/sysctl.d/99-pi5-gateway.conf 2>/dev/null
# Tek bacaklı ağ geçidi: ICMP redirect gönderme (Pi istemcilere "modeme doğrudan git" demesin). Kart adı cihaza göre
# değişir (eth0, end0, enp1s0, enx…): '*' tüm kartları kapsar; sonradan takılan kart değeri default'tan alır.
cat > /etc/sysctl.d/98-pi5-onearm.conf << 'SYSEOF'
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.*.send_redirects = 0
net.ipv4.conf.eth0.send_redirects = 0
net.ipv4.conf.wlan0.send_redirects = 0
SYSEOF
sysctl -q -p /etc/sysctl.d/98-pi5-onearm.conf >/dev/null 2>&1 || true
# Şu an var olan her kartta da hemen 0 (sysctl'in glob desteğine bağlı kalınmaz).
for f in /proc/sys/net/ipv4/conf/*/send_redirects; do
  if [ -w "$f" ]; then { echo 0 > "$f"; } 2>/dev/null || true; fi
done
# Açılışta ağ geçidi kuralları (NAT, forward izni, cihaz engeli) panelden bağımsız yüklensin
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
# Sabit IP koruması: açılışta ve her NetworkManager (yeniden) başlatmasında kalıcı sabit profil (pi5-eth0) denetlenir /
# onarılır (sabit adres panelden verilir; yoksa birim hiçbir şey yapmaz). Hata kurulumu durdurmaz.
cat > /etc/systemd/system/pi5-net-guard.service << 'NGEOF' || warn "pi5-net-guard.service yazılamadı"
[Unit]
Description=Klyrix Gate sabit IP koruması (sabit adres profili)
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
systemctl enable pi5-net-guard.service >/dev/null 2>&1 || warn "pi5-net-guard.service etkinleştirilemedi"
# Kablosuz mesh (802.11s): birim yalnız yazılır; mesh panelden yapılandırılınca scripts/mesh.sh etkinleştirir.
cat > /etc/systemd/system/pi5-mesh.service << 'MSEOF' || warn "pi5-mesh.service yazılamadı"
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
log "IP forwarding aktif"

# ─── 10. Günlük Bakım Cron ───
step "10/10 — Otomatik Bakım Ayarlanıyor"

# Günlük otomatik panel güncellemesi + restart. OS güncellemesi (03:00) ve log temizliği (pazartesi 02:00) panel görevidir:
# backend ilk açılışta /etc/cron.d/pi5-panel'e yazar (Sistem & Log → Cron'dan açılıp kapatılabilir, bkz. cronSync.ts).
cat > /etc/cron.d/pi5-maintenance << 'CRONEOF'
# Pi5 Gateway günlük bakım
# Gece güncellemesi panelin güncelleme işiyle (update-job.sh): durum panelde görünür, başarısızlık zile yazılır, backend
# yalnız derleme başarılıysa yeniden başlar; panelden başlatılmış bir güncelleme sürüyorsa (aynı birim) atlanır.
30 3 * * * root /usr/bin/systemd-run --quiet --unit=pi5-update --collect --service-type=exec -p RuntimeMaxSec=1800 /bin/bash /opt/pi5-gateway/scripts/update-job.sh >> /opt/pi5-gateway/core/system.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/pi5-maintenance
log "Otomatik bakım cron görevleri ayarlandı"

# ─── Uydu eşleştirmesi (R2) ───
# Kod ana cihazın panelinden alınır (Cihaz Rolleri → Uydular → Uydu ekle; 10 dk geçerli) — kurulum uzun sürdüğü için
# burada, en sonda sorulur. Eşleştirmeyi uydunun kendi backend'i yapar (yerel API; kod argv'de görünmez). Boş bırakılırsa
# uydunun panelinden yapılır.
if [ "$ROLE" = satellite ] && ( exec </dev/tty ) 2>/dev/null; then
  echo ""
  echo "Uydu eşleştirmesi: ana cihazın panelinde Cihaz Rolleri → Uydular → Uydu ekle'ye basın."
  MAIN_ADDR=""; PAIR_CODE=""
  read -r -p "Ana cihazın adresi (ör. 192.168.1.153; boş = sonra panelden): " MAIN_ADDR < /dev/tty || MAIN_ADDR=""
  if [ -n "$MAIN_ADDR" ]; then
    read -r -p "Eşleştirme kodu (6 hane): " PAIR_CODE < /dev/tty || PAIR_CODE=""
  fi
  if [[ $MAIN_ADDR =~ ^[A-Za-z0-9.:-]{1,64}$ ]] && [[ $PAIR_CODE =~ ^[0-9]{6}$ ]]; then
    for _ in $(seq 1 30); do curl -s -o /dev/null -m 2 http://127.0.0.1:3001/api/status && break; sleep 2; done
    JOIN_OUT=$(printf '{"main":"%s","code":"%s"}' "$MAIN_ADDR" "$PAIR_CODE" \
      | curl -s -m 240 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:3001/api/mesh/join || true)
    if printf '%s' "$JOIN_OUT" | grep -q '"success":true'; then
      log "Uydu eşleşti — ana cihazın ev Wi-Fi'ı birkaç dakika içinde bu cihazdan da yayınlanır"
    else
      warn "Eşleştirme yapılamadı: $(printf '%s' "$JOIN_OUT" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | cut -c1-200) — uydunun panelinden yeniden deneyin"
    fi
  elif [ -n "$MAIN_ADDR" ]; then
    warn "Adres ya da kod biçimi geçersiz — eşleştirmeyi uydunun panelinden yapın"
  fi
  unset PAIR_CODE
fi

# ─── Tamamlandı ───
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✓ Klyrix Gate kurulumu tamamlandı!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
LOCAL_IP=$(hostname -I | awk '{print $1}')
echo -e "  Web Panel:  ${BLUE}http://${LOCAL_IP}${NC}"
echo -e "  API:        ${BLUE}http://${LOCAL_IP}/api/status${NC}"
echo -e "  Kurulum:    ${BLUE}${INSTALL_DIR}${NC}"
echo ""
echo -e "  ${YELLOW}Servis yönetimi:${NC}"
echo -e "    sudo systemctl status pi5-backend"
echo -e "    sudo systemctl restart pi5-backend"
echo -e "    sudo journalctl -u pi5-backend -f"
echo ""

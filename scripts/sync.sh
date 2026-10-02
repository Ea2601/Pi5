#!/usr/bin/env bash
# Klyrix Gate — cihaz yedekleme (Syncthing). Root olarak çalışır; storage.sh'nin yardımcılarını kullanır (kilit, iş durumu).
# Bilgisayar / telefon / tabletlerdeki Syncthing uygulaması seçilen klasörleri Pi'ye gönderir; Pi yalnız alır (receiveonly)
# ve değişen / silinen dosyaların eski sürümlerini saklar. Cihaz onayı, klasörler ve güvenlik duvarı backend'dedir (sync.ts,
# Syncthing REST API'si 127.0.0.1:8384); bu betik paketi, hizmet kullanıcısını, systemd birimini ve hedef klasörleri yönetir.
#
# Yerleşim:
#   /var/lib/klyrix-sync/config        Syncthing ayarı + cihaz anahtarı. SD kartta kalır: veri diski açılışta takılı olmasa da
#                                      cihaz kimliği (eşleşmeler) değişmez. İlk açılıştan ÖNCE gizlilik ayarları yazılır: genel
#                                      keşif, aktarıcılar (relay), NAT/UPnP, kullanım ve çökme raporu, kendi kendini güncelleme
#                                      kapalı; arayüz yalnız 127.0.0.1'de ve rastgele parolalı (parola saklanmaz).
#   dizin veritabanı                   veri diski bağlıysa /mnt/klyrix-data/klyrix-sync (birim diski bekler), değilse
#                                      /var/lib/klyrix-sync/db
#   /mnt/klyrix-share/Yedekler         dahili disk hedefi (veri diskinin paylaşım bölümü bağlıyken; 2750 klyrix-sync)
#   /mnt/klyrix-usb/<AD>/Klyrix-Yedekler
#                                      USB disk hedefi (Depolama'da "Ağda paylaş" denen USB diskler — share.sh)
# SD koruması: hizmet root DEĞİL (klyrix-sync) çalışır; bağlama noktaları root'undur (/mnt/klyrix-share 755, bağlı olmayan USB
# noktası 000). Disk yokken Syncthing klasör yolunu yeniden oluşturamaz ("folder path missing"), klasör işareti (.stfolder)
# olmayan klasöre de yazmaz. Hedef dizinler yalnız disk bağlıyken oluşturulur. Disk ayrılırken (storage.sh prepare, share.sh
# usb-remove) hizmet durdurulur ve iş sonunda yeniden başlatılır (storage.sh sync_stop / finish).
#
# Komutlar:
#   status                         durum satırları (kilitsiz, salt okunur)
#   enable                         (iş) paketleri kurar, kullanıcıyı ve ayarı oluşturur, hizmeti açar
#   disable                        hizmeti durdurur (ayar, cihaz kimliği, eşleşmeler ve yedekler kalır)
#   ensure                         açıksa: birimi yeni betik sürümüne göre yeniden yazar, hedef klasörü onarır, hizmeti başlatır
#   target --internal | --usb AD   hedef kökünü (disk bağlıysa) hazırlar: path=...
set -uo pipefail
export LC_ALL=C
STORAGE_LIB=1
# shellcheck source=storage.sh
. "$(dirname "$(readlink -f "$0")")/storage.sh"

CONF=${PI5_SYNC_CONF:-/etc/pi5-gateway/sync.conf}      # enabled=0|1
SHARE_CONF=${PI5_SHARE_CONF:-/etc/pi5-gateway/share.conf}
SYNC_USER=klyrix-sync
SYNC_HOME=/var/lib/klyrix-sync
ST_CONF=$SYNC_HOME/config
ST_XML=$ST_CONF/config.xml
SD_DB=$SYNC_HOME/db
DISK_DB=$DATA_MNT/klyrix-sync
UNIT_FILE=/etc/systemd/system/$SYNC_UNIT.service
GUI=127.0.0.1:8384
OUR_GECOS='Klyrix Gate cihaz yedekleme'
INTERNAL_DIR=$SHARE_MNT/Yedekler
USB_MNT=/mnt/klyrix-usb
USB_MARK='# klyrix-usb'
USB_DIR=Klyrix-Yedekler
PKGS=(syncthing qrencode)

# ── yardımcılar ──────────────────────────────────────────────────────────────
conf_get() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | tail -1; }
conf_set() { # ANAHTAR DEĞER
  mkdir -p "$(dirname "$CONF")"; touch "$CONF"
  { grep -v "^$1=" "$CONF" 2>/dev/null; echo "$1=$2"; } > "$CONF.tmp"; mv -f "$CONF.tmp" "$CONF"
}
enabled() { [ "$(conf_get enabled)" = 1 ]; }
pkg_ok() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
data_dir() { if is_mountpoint "$DATA_MNT"; then echo "$DISK_DB"; else echo "$SD_DB"; fi; }
# Ağ paylaşımı kullanıcısının grubu: FAT / exFAT / NTFS USB diskler bu grupla bağlanır (share.sh usb-add, umask 0002)
share_group() {
  local u; u=$([ -f "$SHARE_CONF" ] && sed -n 's/^user=//p' "$SHARE_CONF" | tail -1)
  [ -n "$u" ] && id "$u" >/dev/null 2>&1 && id -gn "$u"
}
# Syncthing arayüzü yanıt veriyor mu (curl gerekmez)
api_up() {
  local r
  r=$(timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/8384 && printf "GET /rest/noauth/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n" >&3 && cat <&3' 2>/dev/null) || return 1
  [[ $r == *'"OK"'* ]]
}
wait_api() {
  local i
  for i in $(seq 1 60); do
    api_up && return 0
    # Birim düştüyse beklemenin anlamı yok (ilk saniyelerde henüz "activating" olabilir)
    [ "$i" -gt 5 ] && ! svc_active "$SYNC_UNIT" && return 1
    sleep 1
  done
  return 1
}

# ── kurulum, kullanıcı, ayar ─────────────────────────────────────────────────
install_pkgs() {
  local missing=() p
  for p in "${PKGS[@]}"; do pkg_ok "$p" || missing+=("$p"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  step 10 "Paketler kuruluyor: ${missing[*]} (birkaç dakika sürebilir)"
  # Kurulum sırasında hiçbir servis Debian'ın varsayılanlarıyla başlamasın
  local prc=/usr/sbin/policy-rc.d
  if [ ! -e "$prc" ]; then printf '#!/bin/sh\nexit 101\n' > "$prc"; chmod +x "$prc"; CLEANUP+=("rm -f $prc"); fi
  local apt=(apt-get install -y -q --no-install-recommends -o DPkg::Lock::Timeout=300)
  if ! DEBIAN_FRONTEND=noninteractive "${apt[@]}" "${missing[@]}" >>"$OUT" 2>&1; then
    log "paket listesi yenileniyor (apt-get update)"
    apt-get update -q >>"$OUT" 2>&1
    DEBIAN_FRONTEND=noninteractive "${apt[@]}" "${missing[@]}" >>"$OUT" 2>&1 || die "paketler kurulamadı: ${missing[*]} — ayrıntı günlükte"
  fi
  [ -e "$prc" ] && grep -qx 'exit 101' "$prc" && rm -f "$prc"
  log "kuruldu: ${missing[*]}"
}

ensure_user() {
  if id "$SYNC_USER" >/dev/null 2>&1; then
    [ "$(getent passwd "$SYNC_USER" | cut -d: -f5)" = "$OUR_GECOS" ] || die "'$SYNC_USER' adı sistemde başka bir hesap için kullanılıyor"
  else
    useradd --system --user-group --no-create-home --home-dir "$SYNC_HOME" --shell /usr/sbin/nologin --comment "$OUR_GECOS" "$SYNC_USER" \
      || die "hizmet kullanıcısı oluşturulamadı: $SYNC_USER"
    log "hizmet kullanıcısı oluşturuldu: $SYNC_USER"
  fi
  install -d -o "$SYNC_USER" -g "$SYNC_USER" -m 0700 "$SYNC_HOME" "$ST_CONF"
}

# Paylaşım grubuna üyelik (FAT / exFAT / NTFS USB disklere yazabilmek için). 0 = değişti (hizmet yeniden başlamalı).
ensure_groups() {
  local g; g=$(share_group) || return 1
  [ -n "$g" ] || return 1
  id -nG "$SYNC_USER" 2>/dev/null | tr ' ' '\n' | grep -qx -- "$g" && return 1
  usermod -aG "$g" "$SYNC_USER" 2>>"$OUT" || { log "UYARI: $SYNC_USER, $g grubuna eklenemedi — FAT / exFAT / NTFS USB disklere yazamayabilir"; return 1; }
  log "$SYNC_USER, paylaşım grubuna ($g) eklendi"
  return 0
}

# Gizlilik: ilk açılıştan önce (Syncthing hiç dışarı bağlanmadan) yazılır. Öğeler Syncthing'in ürettiği config.xml'de tek
# satırdır; beklenen satır bulunamazsa (biçim değiştiyse) hizmet hiç başlatılmaz.
patch_config() {
  sed -i \
    -e 's#<globalAnnounceEnabled>true</globalAnnounceEnabled>#<globalAnnounceEnabled>false</globalAnnounceEnabled>#' \
    -e 's#<relaysEnabled>true</relaysEnabled>#<relaysEnabled>false</relaysEnabled>#' \
    -e 's#<natEnabled>true</natEnabled>#<natEnabled>false</natEnabled>#' \
    -e 's#<startBrowser>true</startBrowser>#<startBrowser>false</startBrowser>#' \
    -e 's#<urAccepted>0</urAccepted>#<urAccepted>-1</urAccepted>#' \
    -e 's#<autoUpgradeIntervalH>[0-9]*</autoUpgradeIntervalH>#<autoUpgradeIntervalH>0</autoUpgradeIntervalH>#' \
    -e 's#<crashReportingEnabled>true</crashReportingEnabled>#<crashReportingEnabled>false</crashReportingEnabled>#' \
    -e 's#<listenAddress>default</listenAddress>#<listenAddress>tcp://0.0.0.0:22000</listenAddress><listenAddress>quic://0.0.0.0:22000</listenAddress>#' \
    "$ST_XML"
  # sed -i dosyayı root'a ait yeniden yazar: Syncthing kendi ayarını yazabilmeli
  chown "$SYNC_USER:$SYNC_USER" "$ST_XML"; chmod 0600 "$ST_XML"
  local want
  for want in '<globalAnnounceEnabled>false<' '<relaysEnabled>false<' '<natEnabled>false<' '<urAccepted>-1<' \
              '<crashReportingEnabled>false<' '<autoUpgradeIntervalH>0<' '<listenAddress>tcp://0.0.0.0:22000<'; do
    grep -qF -- "$want" "$ST_XML" || die "Syncthing ayarı beklenen biçimde değil ($want) — hizmet başlatılmadı"
  done
}

gen_config() {
  [ -s "$ST_XML" ] && return 0
  step 50 "Syncthing ayarı ve cihaz anahtarı oluşturuluyor"
  local pw; pw=$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')
  printf '%s\n' "$pw" | runuser -u "$SYNC_USER" -- syncthing generate --config="$ST_CONF" --no-default-folder --skip-port-probing \
    --gui-user=klyrix --gui-password=- >>"$OUT" 2>&1 || die "Syncthing ayarı oluşturulamadı — ayrıntı günlükte"
  [ -s "$ST_XML" ] || die "Syncthing ayar dosyası oluşmadı"
  patch_config
  grep -q '<apikey>' "$ST_XML" || die "Syncthing ayarında API anahtarı yok"
}

render_unit() {
  local data
  data=$(data_dir)
  cat <<EOF
# Klyrix Gate tarafından yönetilir (scripts/sync.sh) — elle yapılan değişiklikler bir sonraki uygulamada silinir.
[Unit]
Description=Klyrix Gate cihaz yedekleme (Syncthing)
After=network-online.target
Wants=network-online.target
EOF
  # Dizin veritabanı veri diskindeyse disk bağlanmadan başlamaz (bağlama noktasının altına, SD karta yazılmasın)
  [ "$data" = "$DISK_DB" ] && echo "RequiresMountsFor=$DATA_MNT"
  cat <<EOF

[Service]
User=$SYNC_USER
Group=$SYNC_USER
ExecStartPre=+/usr/bin/install -d -o $SYNC_USER -g $SYNC_USER -m 0700 $data
ExecStart=/usr/bin/syncthing serve --no-browser --no-restart --no-upgrade --config=$ST_CONF --data=$data --gui-address=$GUI --logflags=0
Restart=on-failure
RestartSec=10
SuccessExitStatus=3 4
RestartForceExitStatus=3 4
NoNewPrivileges=yes
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=50
MemoryMax=50%

[Install]
WantedBy=multi-user.target
EOF
}

# Birim dosyası değiştiyse yazar + daemon-reload. 0 = değişti.
write_unit() {
  local t; t=$(mktemp)
  render_unit > "$t"
  if cmp -s "$t" "$UNIT_FILE"; then rm -f "$t"; return 1; fi
  install -m 0644 "$t" "$UNIT_FILE"; rm -f "$t"
  svc daemon-reload
  return 0
}

# Dahili hedef: yalnız paylaşım bölümü bağlıyken (bağlı değilken bağlama noktası SD karttadır)
prep_internal() {
  is_mountpoint "$SHARE_MNT" || return 1
  id "$SYNC_USER" >/dev/null 2>&1 || return 1
  install -d -o "$SYNC_USER" -g "$SYNC_USER" -m 2750 "$INTERNAL_DIR" || return 1
  echo "$INTERNAL_DIR"
}

# Eski SD veritabanı: veritabanı veri diskine geçtikten sonra (hizmet yeni yerde çalışıyorsa) silinir
drop_sd_db() {
  [ "$(data_dir)" = "$DISK_DB" ] && [ -d "$SD_DB" ] && svc_active "$SYNC_UNIT" && { rm -rf "$SD_DB"; log "eski dizin veritabanı (SD) silindi"; }
  return 0
}

# ── komutlar ─────────────────────────────────────────────────────────────────
cmd_status() {
  kv installed "$(have syncthing && echo 1 || echo 0)"
  kv enabled "$(enabled && echo 1 || echo 0)"
  kv active "$(svc_active "$SYNC_UNIT" && echo 1 || echo 0)"
  kv config "$([ -s "$ST_XML" ] && echo 1 || echo 0)"
  # HOME yokken (panel servisi systemd altında) syncthing sürüm yerine "$HOME is not defined" yazar
  kv version "$(have syncthing && HOME=$SYNC_HOME syncthing --version 2>/dev/null | grep -oE 'v[0-9]+(\.[0-9]+)+' | head -1)"
  kv data_dir "$(data_dir)"
  kv internal "$(is_mountpoint "$SHARE_MNT" && echo 1 || echo 0)"
}

cmd_enable() {
  install_pkgs
  step 40 "Hizmet kullanıcısı hazırlanıyor"
  ensure_user
  ensure_groups || true
  gen_config
  step 70 "Hedef klasör ve hizmet hazırlanıyor"
  prep_internal >/dev/null || log "UYARI: dahili disk (paylaşım bölümü) bağlı değil — yalnız USB diskler hedef olabilir"
  conf_set enabled 1
  write_unit || true
  systemctl enable "$SYNC_UNIT" >/dev/null 2>&1 || true
  systemctl restart "$SYNC_UNIT" >>"$OUT" 2>&1 || die "hizmet başlatılamadı — ayrıntı: journalctl -u $SYNC_UNIT"
  step 90 "Denetleniyor"
  wait_api || die "Syncthing yanıt vermedi — ayrıntı: journalctl -u $SYNC_UNIT"
  drop_sd_db
  step 100 "Tamam"
  setstate state=done "msg=Cihaz yedekleme açıldı" "finished=$(date +%s)"
  kv result ok
}

cmd_disable() {
  conf_set enabled 0
  systemctl disable --now "$SYNC_UNIT" >/dev/null 2>&1 || true
  log "cihaz yedekleme kapatıldı"
  kv result ok
}

cmd_ensure() {
  if ! enabled; then kv enabled 0; return 0; fi
  if ! have syncthing || [ ! -s "$ST_XML" ] || ! id "$SYNC_USER" >/dev/null 2>&1; then
    kv error "Syncthing kurulumu eksik — panelden cihaz yedeklemeyi yeniden açın"; return 0
  fi
  local changed=0
  ensure_groups && changed=1
  write_unit && changed=1
  prep_internal >/dev/null || true
  if svc_active "$SYNC_UNIT"; then
    if [ "$changed" = 1 ]; then systemctl restart "$SYNC_UNIT" >/dev/null 2>&1 && kv fixed restarted; fi
  else
    systemctl enable "$SYNC_UNIT" >/dev/null 2>&1 || true
    systemctl start "$SYNC_UNIT" >/dev/null 2>&1 && kv fixed started
  fi
  drop_sd_db
  kv enabled 1
}

cmd_target() {
  local kind='' name=''
  while [ $# -gt 0 ]; do case "$1" in --internal) kind=internal; shift;; --usb) kind=usb; name=${2:-}; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  id "$SYNC_USER" >/dev/null 2>&1 || die "önce cihaz yedeklemeyi açın"
  if [ "$kind" = internal ]; then
    local d; d=$(prep_internal) || die "dahili disk (veri diskinin paylaşım bölümü) bağlı değil"
    kv path "$d"; return 0
  fi
  [ "$kind" = usb ] || die "hedef belirtilmedi"
  [[ "$name" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || die "geçersiz disk adı"
  local mp=$USB_MNT/$name
  grep -F -- "$USB_MARK" "$FSTAB" 2>/dev/null | awk '{print $2}' | grep -qx -- "$mp" || die "USB disk bulunamadı: $name (Depolama → Ağda paylaş)"
  is_mountpoint "$mp" || die "$name takılı değil"
  local d=$mp/$USB_DIR fst
  fst=$(findmnt -n -o FSTYPE --mountpoint "$mp" 2>/dev/null)
  case "$fst" in
    ext2|ext3|ext4|btrfs|xfs) install -d -o "$SYNC_USER" -g "$SYNC_USER" -m 2750 "$d" || die "$d oluşturulamadı";;
    # FAT / exFAT / NTFS: sahiplik ve izin bağlama seçeneklerinden gelir (paylaşım kullanıcısı + grubu, umask 0002)
    *) mkdir -p "$d" || die "$d oluşturulamadı";;
  esac
  if ! runuser -u "$SYNC_USER" -- test -w "$d"; then
    ensure_groups && { systemctl try-restart "$SYNC_UNIT" >/dev/null 2>&1 || true; }
    runuser -u "$SYNC_USER" -- test -w "$d" || die "$name diskine yazılamıyor (dosya sistemi: ${fst:-?}) — ağ paylaşımı açık olmalı"
  fi
  kv path "$d"
}

# ── giriş ────────────────────────────────────────────────────────────────────
cmd=${1:-status}; shift || true
case "$cmd" in
  status) cmd_status; exit 0;;
  enable|disable|ensure|target) ;;
  *) echo "kullanım: sync.sh status|enable|disable|ensure|target" >&2; exit 2;;
esac
[ "$(id -u)" = 0 ] || { echo "root gerekli" >&2; exit 1; }
exec 9>"$LOCK"
if [ "$cmd" = enable ]; then
  if ! flock -n 9; then
    if [ -n "${PI5_STORAGE_ID:-}" ] && grep -qx "id=$PI5_STORAGE_ID" "$STATE" 2>/dev/null; then JOB=1; die "başka bir depolama işi sürüyor"; fi
    kv error "başka bir depolama işi sürüyor"; exit 1
  fi
  JOB=1
  trap finish EXIT
  trap 'die "iş durduruldu (süre sınırı ya da systemctl stop)"' TERM
  [ -n "${PI5_STORAGE_ID:-}" ] || : > "$OUT"
  setstate state=running cmd=sync started="$(date +%s)" "id=${PI5_STORAGE_ID:-$(date +%s)}" error= msg= step= pct=0 finished=
else
  # Kısa komutlar iş günlüğünü (panelin ilerleme şeridi) kirletmez
  OUT=$STATE_DIR/sync.log
  flock -w 30 9 || { kv error "başka bir depolama işi sürüyor — birazdan yeniden deneyin"; exit 1; }
  trap finish EXIT
fi
case "$cmd" in
  enable) cmd_enable;;
  disable) cmd_disable;;
  ensure) cmd_ensure;;
  target) cmd_target "$@";;
esac

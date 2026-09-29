#!/usr/bin/env bash
# Klyrix Gate — kablosuz mesh bağlantısı (R2, 802.11s + SAE). Root olarak çalışır.
# Ana cihaz ile uydular arasında Wi-Fi omurgası: mesh destekli radyoda (ör. ALFA AWUS036ACM, mt76x2u) "mesh0" arayüzü
# açılır, wpa_supplicant SAE ile şifreli 802.11s ağına katılır ve mesh0 ev ağı köprüsüne (br0, net-mode.sh home / sat)
# eklenir. NetworkManager mesh0'ı yönetmez (conf.d dosyası + çalışma anı ayarı); köprü NM'nin kalır.
#   status                                  durum satırları (kilitsiz)
#   configure --id AD --channel N --role main|satellite   ayarları yazar (parola STDIN'in ilk satırından; argv'ye ve
#                                           günlüğe girmez), pi5-mesh.service'i etkinleştirip yeniden başlatır
#   disable                                 servisi durdurur, mesh0'ı ve ayar dosyalarını kaldırır
#   run                                     servis döngüsü (pi5-mesh.service): arayüz + wpa_supplicant + köprü bağlama
# Döngü önlemi: ana cihazda mesh0 köprüde hep durur; uyduda yalnız kablo (eth) bağlı DEĞİLKEN köprüye eklenir — kablo
# gelince çıkarılır (kablo öncelikli; uydu köprüsünde ayrıca STP açık).
set -u
export LC_ALL=C
umask 077
DIR=/etc/pi5-gateway/mesh
CONF=$DIR/mesh.conf
WPA_CONF=$DIR/wpa-mesh.conf
NM_CONF=/etc/NetworkManager/conf.d/99-pi5-mesh.conf
NET_STATE=/etc/pi5-gateway/net/state
STATUS=/run/pi5-mesh.status
IF=mesh0
BR=br0
UNIT=pi5-mesh.service
WPA_PID=/run/pi5-mesh-wpa.pid
WPA_CTRL=/run/pi5-mesh-wpa

die() { echo "error=$*"; exit 1; }
log() { logger -t pi5-mesh "$*" 2>/dev/null || true; }
kv_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }
valid_id() { [[ $1 =~ ^[A-Za-z0-9_-]{1,32}$ ]]; }
valid_psk() { [[ $1 =~ ^[\ -~]{8,63}$ ]] && [[ $1 != *\\* ]] && [[ $1 != *\"* ]] && [[ $1 != " "* ]] && [[ $1 != *" " ]]; }
freq_of() { case "$1" in 36) echo 5180 ;; 40) echo 5200 ;; 44) echo 5220 ;; 48) echo 5240 ;; *) return 1 ;; esac; }
# Mesh (802.11s "mesh point") destekleyen radyolar: "phyN" satırları. iw list'te bölüm başlıkları 1 sekme girintili.
mesh_phys() {
  iw list 2>/dev/null | awk '
    /^Wiphy / { phy = $2; sect = ""; next }
    /^\t[^\t]/ { sect = $0; next }
    sect ~ /Supported interface modes/ && /\* mesh point/ { print phy }' | sort -u
}
phy_of_iface() { basename "$(readlink "/sys/class/net/$1/phy80211" 2>/dev/null)" 2>/dev/null; }
attached() { [ "$(basename "$(readlink "/sys/class/net/$IF/master" 2>/dev/null)" 2>/dev/null)" = "$BR" ]; }
wpa_running() { [ -f "$WPA_PID" ] && kill -0 "$(cat "$WPA_PID" 2>/dev/null)" 2>/dev/null; }
peers() { iw dev "$IF" station dump 2>/dev/null | grep -c '^Station'; }

cmd_status() {
  local role id ch phy capable
  role=$(kv_get "$CONF" role); id=$(kv_get "$CONF" id); ch=$(kv_get "$CONF" channel); phy=$(kv_get "$CONF" phy)
  capable=$(mesh_phys | paste -sd, -)
  if [ -s "$CONF" ] && [ -s "$WPA_CONF" ]; then echo "configured=1"; else echo "configured=0"; fi
  echo "role=$role"
  echo "id=$id"
  echo "channel=$ch"
  echo "phy=$phy"
  echo "capable=$capable"
  if systemctl is-active --quiet "$UNIT" 2>/dev/null; then echo "service=active"; else echo "service=inactive"; fi
  if [ -e "/sys/class/net/$IF" ]; then echo "iface=1"; else echo "iface=0"; fi
  if wpa_running; then echo "wpa=1"; else echo "wpa=0"; fi
  if attached; then echo "attached=1"; else echo "attached=0"; fi
  echo "peers=$( [ -e "/sys/class/net/$IF" ] && peers || echo 0)"
}

cmd_configure() {
  local id="" ch="" role="" psk="" phy apif appHy f
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) id=${2:-}; shift ;;
      --channel) ch=${2:-}; shift ;;
      --role) role=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  IFS= read -r -t 30 psk || true
  valid_id "$id" || die "geçersiz mesh adı (1-32: harf, rakam, _ -)"
  f=$(freq_of "$ch") || die "geçersiz mesh kanalı: $ch (5 GHz: 36, 40, 44, 48)"
  case "$role" in main|satellite) ;; *) die "geçersiz rol: $role (main|satellite)" ;; esac
  valid_psk "$psk" || die "geçersiz mesh parolası (8-63 karakter; tırnak ve ters bölü olmaz)"
  command -v iw >/dev/null 2>&1 || die "iw kurulu değil"
  command -v wpa_supplicant >/dev/null 2>&1 || die "wpa_supplicant kurulu değil"
  # Radyo seçimi: ev Wi-Fi'ı / uydu yayını yapan kart (net-mode.sh durumu) dışındaki mesh destekli radyo tercih edilir.
  apif=$(kv_get "$NET_STATE" home_iface); [ -n "$apif" ] || apif=$(kv_get "$NET_STATE" sat_wifi)
  appHy=$( [ -n "$apif" ] && phy_of_iface "$apif")
  phy=""
  for p in $(mesh_phys); do
    [ "$p" = "$appHy" ] && continue
    phy=$p; break
  done
  [ -n "$phy" ] || phy=$(mesh_phys | head -1)
  [ -n "$phy" ] || die "mesh (802.11s) destekleyen Wi-Fi radyosu yok — ör. ALFA AWUS036ACM (MT7612U) takın"
  mkdir -p "$DIR" && chmod 700 "$DIR"
  printf 'role=%s\nid=%s\nchannel=%s\nphy=%s\n' "$role" "$id" "$ch" "$phy" > "$CONF.tmp" && mv -f "$CONF.tmp" "$CONF" \
    || die "$CONF yazılamadı"
  # user_mpm=1: eşleşme (MPM) ve SAE wpa_supplicant'ta; mesh_fwding=1: 802.11s çok atlamalı iletim (HWMP).
  printf '%s\n' "ctrl_interface=$WPA_CTRL
user_mpm=1
network={
    ssid=\"$id\"
    mode=5
    frequency=$f
    key_mgmt=SAE
    psk=\"$psk\"
    ieee80211w=2
    mesh_fwding=1
}" > "$WPA_CONF.tmp" && chmod 600 "$WPA_CONF.tmp" && mv -f "$WPA_CONF.tmp" "$WPA_CONF" || { rm -f "$WPA_CONF.tmp"; die "$WPA_CONF yazılamadı"; }
  printf '[keyfile]\nunmanaged-devices=interface-name:%s\n' "$IF" > "$NM_CONF.tmp" && mv -f "$NM_CONF.tmp" "$NM_CONF"
  systemctl enable "$UNIT" >/dev/null 2>&1 || die "$UNIT etkinleştirilemedi"
  systemctl restart "$UNIT" >/dev/null 2>&1 || die "$UNIT başlatılamadı"
  log "mesh yapılandırıldı: $role, \"$id\", kanal $ch, $phy"
  echo "phy=$phy"
  echo "ok=1"
}

cmd_disable() {
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  mesh_down
  rm -f "$CONF" "$WPA_CONF" "$NM_CONF" "$STATUS"
  log "mesh kapatıldı"
  echo "ok=1"
}

mesh_down() {
  if wpa_running; then kill "$(cat "$WPA_PID")" 2>/dev/null; sleep 1; fi
  rm -f "$WPA_PID"
  [ -e "/sys/class/net/$IF" ] && { ip link set "$IF" nomaster 2>/dev/null; iw dev "$IF" del 2>/dev/null || ip link delete "$IF" 2>/dev/null; }
  return 0
}

# Uyduda kablo bağlı mı (net-mode.sh sat_iface'in taşıyıcısı).
eth_up() {
  local e
  e=$(kv_get "$NET_STATE" sat_iface)
  [ -n "$e" ] && [ "$(cat "/sys/class/net/$e/carrier" 2>/dev/null)" = 1 ]
}

cmd_run() {
  local role phy want
  role=$(kv_get "$CONF" role); phy=$(kv_get "$CONF" phy)
  [ -s "$CONF" ] && [ -s "$WPA_CONF" ] || { log "yapılandırma yok — servis duruyor"; exit 0; }
  trap 'mesh_down; exit 0' TERM INT
  while :; do
    if [ ! -e "/sys/class/net/$IF" ]; then
      if ! iw phy "$phy" interface add "$IF" type mp 2>/dev/null; then
        log "$phy üzerinde $IF açılamadı (radyo takılı mı?) — 10 sn sonra yeniden"
        printf 'state=no_radio\nat=%s\n' "$(date +%s)" > "$STATUS"
        sleep 10; continue
      fi
      command -v nmcli >/dev/null 2>&1 && nmcli device set "$IF" managed no >/dev/null 2>&1
      ip link set "$IF" up 2>/dev/null
    fi
    if ! wpa_running; then
      wpa_supplicant -B -D nl80211 -i "$IF" -c "$WPA_CONF" -P "$WPA_PID" >/dev/null 2>&1 \
        || log "wpa_supplicant başlatılamadı ($IF)"
    fi
    # Köprü bağlama: ana cihaz hep; uydu yalnız kablo yokken.
    want=0
    if [ -e "/sys/class/net/$BR" ]; then
      if [ "$role" = main ] || ! eth_up; then want=1; fi
    fi
    if [ "$want" = 1 ] && ! attached; then
      ip link set "$IF" master "$BR" 2>/dev/null && log "$IF köprüye eklendi"
    elif [ "$want" = 0 ] && attached; then
      ip link set "$IF" nomaster 2>/dev/null && log "$IF köprüden çıkarıldı (kablo bağlı)"
    fi
    printf 'state=running\nat=%s\npeers=%s\nattached=%s\n' "$(date +%s)" "$(peers)" "$(attached && echo 1 || echo 0)" > "$STATUS"
    sleep 3
  done
}

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)"
cmd=${1:-status}
shift || true
case "$cmd" in
  status) cmd_status ;;
  configure) cmd_configure "$@" ;;
  disable) cmd_disable ;;
  run) cmd_run ;;
  *) die "bilinmeyen komut: $cmd (status|configure|disable|run)" ;;
esac

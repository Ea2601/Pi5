#!/usr/bin/env bash
# Klyrix Gate — Pi'nin sabit adresi (Faz 2, topoloji A). Root olarak çalışır; aynı anda tek işlem (flock).
# eth0'a TEK sabit profil (pi5-eth0) ve İKİ adres verilir: modem tarafı (TRANSIT, ör. 192.168.1.153/24 — ilk sırada,
# varsayılan rota modeme) ve cihazlar için (CLIENT, varsayılan 192.168.0.1/24 — Pi DHCP'si bu ağa adres dağıtır).
#   status                               durum satırları (kilitsiz, salt okunur)
#   static --trial SN [--client IP/ÖNEK] sabit profili kurup etkinleştirir; SN saniye içinde "confirm" gelmezse eski
#                                        (otomatik adresli) profile kendiliğinden dönülür
#   confirm                              denemeyi kalıcı yapar (profil açılışta kendiliğinden etkinleşir)
#   rollback                             yalnız deneme sürüyorsa eski profile döner (zamanlayıcı / açılış / panel)
#   dhcp [--force]                       kalıcı sabit adresten bilerek otomatik adrese döner (Pi DHCP'si kapalıyken;
#                                        Pi'nin dağıttığı kiralar bitene kadar reddedilir, --force: yine de)
#   wifi off|on                          Pi'nin Wi-Fi'sini kapatır / açar (Pi DHCP'si açılmadan modem Wi-Fi'sinden ayrılır;
#                                        kurulum Wi-Fi'ı açıkken reddedilir)
#   ap on --trial SN [--ssid AD]         kurulum Wi-Fi'ı: Pi'nin dahili Wi-Fi'si erişim noktası olur (192.168.50.1, WPA2,
#                                        2.4 GHz; yalnız panele erişim, internet yok). Parola STDIN'in ilk satırından
#                                        okunur (argv'ye ve günlüğe girmez). SN saniye içinde "ap confirm" gelmezse geri alınır
#   ap confirm                           kurulum Wi-Fi'ını kalıcı yapar (açılışta kendiliğinden yayına başlar)
#   ap rollback                          yalnız deneme sürüyorsa kurulum Wi-Fi'ını kaldırır; Pi'nin Wi-Fi'si eski haline döner
#   ap off                               kurulum Wi-Fi'ını bilerek kapatır; Pi'nin Wi-Fi'si kapalı kalır (ev ağına dönmez)
#   home on --trial SN --ssid AD [--band bg|a] [--channel N]
#                                        ev Wi-Fi'ı (erişim noktası rolü): eth0 ve Wi-Fi kartı tek köprüde (br0) birleşir,
#                                        iki sabit adres köprüye taşınır; kablosuz cihazlar kablolularla aynı ağa katılır.
#                                        Parola STDIN'in ilk satırından okunur. SN saniye içinde "home confirm" gelmezse
#                                        Pi köprüsüz sabit profile (pi5-eth0) döner
#   home confirm | rollback | off        ev Wi-Fi'ını kalıcı yapar | yalnız deneme sürüyorsa geri alır | bilerek kapatır
#   ensure                             güncelleme / açılış: süresi geçen denemeleri geri alır, kalıcı profili ve kalıcı
#                                        kurulum Wi-Fi'ını denetler. Hiçbir şeyi kendiliğinden AÇMAZ.
#   guard                                pi5-net-guard.service (açılış + her NetworkManager (yeniden) başlatması): kalıcı
#                                        profil etkin değilse yedekten onarır; olmazsa adresleri bu açılış için elle tutar.
#                                        Kalıcı kurulum Wi-Fi'ı yayında değilse onu da onarır (onun acil modu yoktur)
# Raspberry Pi'nin NetworkManager yaması (rpt4) her NM başlangıcında /etc/netplan/*.yaml'ı silip yalnız dosya adı
# "netplan-" ile başlayan profillerden yeniden yazar: "pi5-eth0" adı bu yüzden seçildi (yerli keyfile olarak kalır).
# `nmcli con reload` ASLA çalıştırılmaz (netplan silme / yeniden yazmayı tetikler); tek dosya `nmcli con load` ile
# yüklenir. Eski profil (netplan-*) hiç değiştirilmez: değiştirmek /etc/netplan'ı yeniden yazdırırdı.
# Kurulum Wi-Fi'ı (pi5-ap): profil dosyası doğrudan yazılır (parola hiçbir komutun argv'sinde görünmez) ve yalnız o
# dosya yüklenir. Ev Wi-Fi'ı profili (netplan-wlan0-*) değiştirilmez: pi5-ap'nin kendiliğinden bağlanma önceliği (300)
# yüksek olduğundan açılışta o seçilir. pi5_ap nft tablosu bu karttan / bu karta iletimi düşürür ve 80/tcp'yi giriş
# sayfasına (192.168.50.1) yönlendirir; istemcilere adres dağıtan dnsmasq dosyasını (07-pi5-ap.conf) backend yazar.
# Kurtarma (terminal):  sudo bash /opt/pi5-gateway/scripts/net-mode.sh rollback   (deneme sürerken)
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh dhcp       (kalıcı sabit adresten dönüş)
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh ap off     (kurulum Wi-Fi'ını kapatma)
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh home off   (ev Wi-Fi'ını / köprüyü kapatma)
set -u
export LC_ALL=C
umask 077
DIR=/etc/pi5-gateway/net
STATE_FILE=$DIR/state
GUARD_STATUS=$DIR/guard.status
PROFILE=pi5-eth0
KEYFILE=/etc/NetworkManager/system-connections/pi5-eth0.nmconnection
BACKUP=$DIR/pi5-eth0.nmconnection
OLD_COPY=$DIR/old-profile.nmconnection
FALLBACK=eth0-dhcp
DEFAULT_CLIENT=192.168.0.1/24
TIMER_UNIT=pi5-net-rollback
RETRY_PREFIX=$TIMER_UNIT-retry
LOCK=/run/pi5-net-mode.lock
LEASES=/etc/pihole/dhcp.leases
# Kurulum Wi-Fi'ı (erişim noktası)
AP_PROFILE=pi5-ap
AP_KEYFILE=/etc/NetworkManager/system-connections/pi5-ap.nmconnection
AP_BACKUP=$DIR/pi5-ap.nmconnection
AP_GUARD_STATUS=$DIR/ap-guard.status
AP_ADDR=192.168.50.1/24
AP_NET=192.168.50.0/24
AP_NFT=/etc/nftables.d/pi5-ap.conf
AP_DEFAULT_SSID=Klyrix-Kurulum
AP_TIMER_UNIT=pi5-ap-rollback
AP_RETRY_PREFIX=$AP_TIMER_UNIT-retry
# Ev Wi-Fi'ı (köprü)
BR_IF=br0
BR_PROFILE=pi5-br0
BR_KEYFILE=/etc/NetworkManager/system-connections/pi5-br0.nmconnection
BR_BACKUP=$DIR/pi5-br0.nmconnection
PORT_PROFILE=pi5-br0-eth
PORT_KEYFILE=/etc/NetworkManager/system-connections/pi5-br0-eth.nmconnection
PORT_BACKUP=$DIR/pi5-br0-eth.nmconnection
HOME_PROFILE=pi5-home
HOME_KEYFILE=/etc/NetworkManager/system-connections/pi5-home.nmconnection
HOME_BACKUP=$DIR/pi5-home.nmconnection
HOME_TIMER_UNIT=pi5-home-rollback
HOME_RETRY_PREFIX=$HOME_TIMER_UNIT-retry
SELF=$(readlink -f "$0")
STATE_KEYS="stage trial_ends iface transit client gw dns old_uuid old_name old_ipv6 wifi_off ap_stage ap_trial_ends ap_iface ap_ssid ap_old_uuid ap_radio_was_off home_stage home_trial_ends home_iface home_ssid home_band home_channel home_radio_was_off lan_if"

die() { echo "error=$*"; exit 1; }
log() { logger -t pi5-net-mode "$*" 2>/dev/null || true; }
# Çok satırlı komut çıktısını tek satıra indirir (key=value satırı bozulmasın).
oneline() { tr '\n\r\t' '   ' | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//' | cut -c1-300; }
csv() { paste -sd, -; }

# Durum dosyası: key=value satırları; kaynak olarak ÇALIŞTIRILMAZ, yalnız bilinen anahtarlar S_<anahtar>'a okunur.
read_state() {
  local k v
  for k in $STATE_KEYS; do printf -v "S_$k" '%s' ""; done
  if [ -f "$STATE_FILE" ]; then
    while IFS='=' read -r k v || [ -n "$k" ]; do
      [ -n "$k" ] || continue
      case " $STATE_KEYS " in *" $k "*) printf -v "S_$k" '%s' "$v" ;; esac
    done < "$STATE_FILE"
  fi
  case "$S_stage" in trial|static) ;; *) S_stage=none ;; esac
  [[ $S_trial_ends =~ ^[0-9]+$ ]] || S_trial_ends=0
  [ "$S_wifi_off" = 1 ] || S_wifi_off=0
  case "$S_ap_stage" in trial|on) ;; *) S_ap_stage=none ;; esac
  [[ $S_ap_trial_ends =~ ^[0-9]+$ ]] || S_ap_trial_ends=0
  # Kart adı nft kuralına girer: biçim dışıysa boş sayılır.
  [[ $S_ap_iface =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_ap_iface=""
  [ "$S_ap_radio_was_off" = 1 ] || S_ap_radio_was_off=0
  case "$S_home_stage" in trial|on) ;; *) S_home_stage=none ;; esac
  [[ $S_home_trial_ends =~ ^[0-9]+$ ]] || S_home_trial_ends=0
  [[ $S_home_iface =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_home_iface=""
  [ "$S_home_band" = a ] || S_home_band="bg"
  [[ $S_home_channel =~ ^[0-9]{1,3}$ ]] || S_home_channel=""
  [ "$S_home_radio_was_off" = 1 ] || S_home_radio_was_off=0
  [[ $S_lan_if =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_lan_if=""
}
write_state() {
  local k v
  mkdir -p "$DIR" && chmod 700 "$DIR"
  for k in $STATE_KEYS; do v="S_$k"; printf '%s=%s\n' "$k" "${!v}"; done > "$STATE_FILE.tmp" \
    && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}
# Kurulum alanlarını boşaltır (stage=none); wifi_off ve kurulum Wi-Fi'ı alanları (ap_*) korunur.
reset_setup() {
  S_stage=none; S_trial_ends=0; S_iface=""; S_transit=""; S_client=""; S_gw=""; S_dns=""
  S_old_uuid=""; S_old_name=""; S_old_ipv6=""
}
# Kurulum Wi-Fi'ı alanlarını boşaltır (ap_stage=none); sabit adres alanları ve wifi_off korunur.
ap_reset() {
  S_ap_stage=none; S_ap_trial_ends=0; S_ap_iface=""; S_ap_ssid=""; S_ap_old_uuid=""; S_ap_radio_was_off=0
}
# Ev Wi-Fi'ı alanlarını boşaltır (home_stage=none, lan_if boş: cihaz ağı yeniden eth0'da); diğer alanlar korunur.
home_reset() {
  S_home_stage=none; S_home_trial_ends=0; S_home_iface=""; S_home_ssid=""; S_home_band="bg"; S_home_channel=""
  S_home_radio_was_off=0; S_lan_if=""
}

# static/confirm/dhcp: zamanlayıcıyı ve (varsa) biten geri alma servisini temizler. Geri alma işi KENDİ servisinde
# çalışır — rollback bunu çağırmaz: kendi servisini durdurmak systemd'nin tüm cgroup'u (bu betik dahil) sonlandırmasına
# yol açardı.
stop_timer() {
  systemctl stop "$TIMER_UNIT.timer" "$TIMER_UNIT.service" "$RETRY_PREFIX-*.timer" "$RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$TIMER_UNIT.timer" "$TIMER_UNIT.service" "$RETRY_PREFIX-*.timer" "$RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
}
retry_active() { systemctl list-units --type=timer --state=active --no-legend "$RETRY_PREFIX-*" 2>/dev/null | grep -q .; }
timer_active() { systemctl is-active --quiet "$TIMER_UNIT.timer" 2>/dev/null || retry_active; }
# Geri alma yeniden deneme zamanlayıcısı (benzersiz ad: o an çalışan bir yeniden deneme servisiyle çakışmasın). Kilit
# tanımlayıcısı (9) devredilmez.
arm_retry() {
  systemd-run --quiet --collect --unit="$RETRY_PREFIX-$(date +%s)-$$" --on-active="$1" --timer-property=AccuracySec=1s \
    /bin/bash "$SELF" rollback >/dev/null 2>&1 9>&-
}
# Kurulum Wi-Fi'ı denemesinin zamanlayıcıları (ayrı birim adları: sabit adres zamanlayıcılarıyla birbirini durdurmaz).
ap_stop_timer() {
  systemctl stop "$AP_TIMER_UNIT.timer" "$AP_TIMER_UNIT.service" "$AP_RETRY_PREFIX-*.timer" "$AP_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$AP_TIMER_UNIT.timer" "$AP_TIMER_UNIT.service" "$AP_RETRY_PREFIX-*.timer" "$AP_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
}
ap_retry_active() { systemctl list-units --type=timer --state=active --no-legend "$AP_RETRY_PREFIX-*" 2>/dev/null | grep -q .; }
ap_timer_active() { systemctl is-active --quiet "$AP_TIMER_UNIT.timer" 2>/dev/null || ap_retry_active; }
arm_ap_retry() {
  systemd-run --quiet --collect --unit="$AP_RETRY_PREFIX-$(date +%s)-$$" --on-active="$1" --timer-property=AccuracySec=1s \
    /bin/bash "$SELF" ap rollback >/dev/null 2>&1 9>&-
}
# Ev Wi-Fi'ı denemesinin zamanlayıcıları (ayrı birim adları).
home_stop_timer() {
  systemctl stop "$HOME_TIMER_UNIT.timer" "$HOME_TIMER_UNIT.service" "$HOME_RETRY_PREFIX-*.timer" "$HOME_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$HOME_TIMER_UNIT.timer" "$HOME_TIMER_UNIT.service" "$HOME_RETRY_PREFIX-*.timer" "$HOME_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
}
home_retry_active() { systemctl list-units --type=timer --state=active --no-legend "$HOME_RETRY_PREFIX-*" 2>/dev/null | grep -q .; }
home_timer_active() { systemctl is-active --quiet "$HOME_TIMER_UNIT.timer" 2>/dev/null || home_retry_active; }
arm_home_retry() {
  systemd-run --quiet --collect --unit="$HOME_RETRY_PREFIX-$(date +%s)-$$" --on-active="$1" --timer-property=AccuracySec=1s \
    /bin/bash "$SELF" home rollback >/dev/null 2>&1 9>&-
}

# --- IPv4 hesapları (bash tamsayısı; girdiler önceden doğrulanır) ---
IP_RE='^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$'
valid_ip() { [[ $1 =~ $IP_RE ]]; }
ip2int() { local IFS=. a b c d; read -r a b c d <<< "$1"; echo $(( (a << 24) | (b << 16) | (c << 8) | d )); }
int2ip() { echo "$(( ($1 >> 24) & 255 )).$(( ($1 >> 16) & 255 )).$(( ($1 >> 8) & 255 )).$(( $1 & 255 ))"; }
pmask() { echo $(( $1 == 0 ? 0 : (0xFFFFFFFF << (32 - $1)) & 0xFFFFFFFF )); }
# $1 ip, $2 ip/önek: ip o ağın içinde mi
in_net() { local m; m=$(pmask "${2#*/}"); [ $(( $(ip2int "$1") & m )) -eq $(( $(ip2int "${2%/*}") & m )) ]; }
# $1 $2 ip/önek: kısa önekli ağ diğerini kapsıyorsa çakışır
nets_overlap() {
  local p=${1#*/} q=${2#*/} m
  [ "$q" -lt "$p" ] && p=$q
  m=$(pmask "$p")
  [ $(( $(ip2int "${1%/*}") & m )) -eq $(( $(ip2int "${2%/*}") & m )) ]
}

# --- Ağ / NetworkManager sorguları ---
nm_running() { command -v nmcli >/dev/null 2>&1 && [ "$(nmcli -t -f RUNNING general 2>/dev/null)" = running ]; }
# En düşük metrikli varsayılan rota → "ARAYÜZ AĞ_GEÇİDİ" (wg*/lo/docker*/veth* hariç).
default_route() {
  ip -4 route show default 2>/dev/null | awk '
    { dev = ""; gw = ""; m = 0
      for (i = 1; i < NF; i++) { if ($i == "dev") dev = $(i + 1); else if ($i == "via") gw = $(i + 1); else if ($i == "metric") m = $(i + 1) + 0 }
      if (dev == "" || dev == "lo" || dev ~ /^(wg|docker|veth)/) next
      if (best == "" || m < bm) { best = dev " " gw; bm = m } }
    END { if (best != "") print best }'
}
iface_addrs() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{ print $4 }'; }
# $1 arayüz, $2 ağ geçidi → arayüzün ağ geçidini içeren ilk adresi (ip/önek)
addr_for_gw() {
  local a
  for a in $(iface_addrs "$1"); do in_net "$2" "$a" && { echo "$a"; return 0; }; done
  return 1
}
# $1 arayüz, $2 ip/önek: adres arayüzde var ve DHCP'den (dynamic) gelmiyor
addr_static() {
  ip -4 -o addr show dev "$1" 2>/dev/null \
    | awk -v a="$2" '$4 == a { f = 1; if ($0 ~ / dynamic /) d = 1 } END { exit !(f && !d) }'
}
both_addrs() { addr_static "$1" "$2" && addr_static "$1" "$3"; }
# $1 arayüz, $2 sn: kayıtlı iki sabit adres (S_transit, S_client) görünene kadar bekler
wait_both() {
  local end=$((SECONDS + $2))
  while ! both_addrs "$1" "$S_transit" "$S_client"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# $1 arayüz, $2 sn: arayüzde herhangi bir IPv4 adresi görünene kadar bekler
wait_ipv4() {
  local end=$((SECONDS + $2))
  while [ -z "$(iface_addrs "$1")" ]; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
route_ok() { local r; r=$(ip -4 route get 1.1.1.1 2>/dev/null | head -1); [[ " $r " == *" dev $1 "* && " $r " == *" src $2 "* ]]; }
carrier() { if [ "$(cat "/sys/class/net/$1/carrier" 2>/dev/null)" = 1 ]; then echo 1; else echo 0; fi; }
dev_type() { nmcli -g GENERAL.TYPE device show "$1" 2>/dev/null; }
dev_state() { nmcli -g GENERAL.STATE device show "$1" 2>/dev/null | cut -d' ' -f1; }
active_conn() { nmcli -g GENERAL.CONNECTION device show "$1" 2>/dev/null; }
active_uuid() { nmcli -t -f UUID,DEVICE connection show --active 2>/dev/null | awk -F: -v d="$1" '$2 == d { print $1; exit }'; }
uuids_named() { nmcli -t -f UUID,NAME connection show 2>/dev/null | awk -F: -v n="$1" '$2 == n { print $1 }'; }
file_of_name() { nmcli -t -f NAME,FILENAME connection show 2>/dev/null | awk -F: -v n="$1" '$1 == n { print $2; exit }'; }
file_of_uuid() { nmcli -t -f UUID,FILENAME connection show 2>/dev/null | awk -F: -v u="$1" '$1 == u { print $2; exit }'; }
uuid_exists() { [ -n "$1" ] && nmcli -g connection.uuid connection show uuid "$1" >/dev/null 2>&1; }
delete_named() {
  local u
  for u in $(uuids_named "$1"); do nmcli connection delete uuid "$u" >/dev/null 2>&1 || true; done
}
# Kayıtlı eski profil dışındaki eth0-dhcp kopyalarını siler (ikinci bir otomatik DHCP profili arkada kalmasın).
drop_fallback() {
  local u
  for u in $(uuids_named "$FALLBACK"); do
    [ "$u" = "$S_old_uuid" ] || nmcli connection delete uuid "$u" >/dev/null 2>&1 || true
  done
}
# Profil dosyası yerinde, boş değil ve NM onu bu dosyadan yüklemiş.
keyfile_ok() { [ -s "$KEYFILE" ] && [ "$(file_of_name "$PROFILE")" = "$KEYFILE" ]; }
pi_dhcp_active() {
  command -v pihole-FTL >/dev/null 2>&1 && [ "$(pihole-FTL --config dhcp.active 2>/dev/null | tr -d '[:space:]')" = true ]
}
rx() { printf '%s' "$1" | sed 's/[.]/\\./g'; }
# Pi DHCP'sinin cihaz ağında (client) süresi dolmamış en geç kiranın bitişi (epoch; yoksa 0). Satır: "bitiş mac ip ad
# [kimlik]"; bitiş 0 = süresiz kira. Pi DHCP'si kapatılsa da cihazlar bu ana kadar 192.168.0.1'i ağ geçidi/DNS bilir.
pi_lease_until() {
  local cl=${1:-$S_client} max=0 now e ip rest
  if [ -z "$cl" ] || [ ! -f "$LEASES" ]; then echo 0; return 0; fi
  now=$(date +%s)
  while read -r e _ ip rest; do
    [[ $e =~ ^[0-9]+$ ]] && valid_ip "${ip:-}" || continue
    [ "$e" = 0 ] && e=$((now + 315360000))
    if [ "$e" -gt "$now" ] && in_net "$ip" "$cl" && [ "$e" -gt "$max" ]; then max=$e; fi
  done < "$LEASES"
  echo "$max"
}

# NM'nin yazdığı profil dosyasını doğrular: yerli keyfile, adresler doğru sırada (TRANSIT önce), yöntem elle.
# $1 transit, $2 client, $3 ağ geçidi (eski NM biçimi "address1=IP/ÖNEK,AĞ_GEÇİDİ" de kabul edilir).
verify_keyfile() {
  local f
  f=$(file_of_name "$PROFILE")
  if [ "$f" != "$KEYFILE" ]; then echo "detail=profil dosyası beklenen yerde değil: ${f:-yok}"; return 1; fi
  if [ ! -s "$KEYFILE" ]; then echo "detail=profil dosyası boş: $KEYFILE"; return 1; fi
  if ! grep -Eq "^address1=$(rx "$1")(,$(rx "$3"))?\$" "$KEYFILE" || ! grep -Eq "^address2=$(rx "$2")\$" "$KEYFILE" \
     || ! grep -q '^method=manual$' "$KEYFILE"; then
    echo "detail=profil dosyasındaki adresler beklenenden farklı ($KEYFILE)"; return 1
  fi
  return 0
}

# Eski (otomatik adresli) profile döner. 0: arayüz otomatik adresli bir profille IPv4 adresi aldı.
# Eski profil yoksa ya da etkinleşmezse (rpt4 boş netplan yaml'ını silmiş olabilir) yerine eth0-dhcp kurulur.
restore_old() {
  local ifc=$S_iface v6=${S_old_ipv6:-auto} out dr
  if [ -z "$ifc" ]; then dr=$(default_route); ifc=${dr%% *}; fi
  [ -n "$ifc" ] || { echo "warning=arayüz bilinmiyor — otomatik adrese dönülemedi"; return 1; }
  # Acil moddan (NM'nin yönetmediği arayüz) dönülüyorsa NM arayüzü yeniden yönetsin.
  if [ "$(dev_state "$ifc")" = 10 ]; then nmcli device set "$ifc" managed yes >/dev/null 2>&1; sleep 1; fi
  if uuid_exists "$S_old_uuid"; then
    # Açılışta NM eski profili zaten etkinleştirmişse yeniden başlatılmaz (gereksiz kesinti olmasın).
    if [ "$(active_uuid "$ifc")" = "$S_old_uuid" ] && [ -n "$(iface_addrs "$ifc")" ]; then drop_fallback; return 0; fi
    if out=$(nmcli -w 30 connection up uuid "$S_old_uuid" 2>&1); then
      wait_ipv4 "$ifc" 20 && { drop_fallback; return 0; }
      out="IPv4 adresi gelmedi"
    fi
    echo "warning=eski profil (${S_old_name:-$S_old_uuid}) otomatik adres alamadı: $(printf '%s' "$out" | oneline)"
  fi
  delete_named "$FALLBACK"
  if ! out=$(nmcli connection add type ethernet con-name "$FALLBACK" ifname "$ifc" ipv4.method auto \
        ipv6.method "$v6" connection.autoconnect yes 2>&1); then
    echo "warning=yedek otomatik profil ($FALLBACK) oluşturulamadı: $(printf '%s' "$out" | oneline)"
    return 1
  fi
  if out=$(nmcli -w 30 connection up id "$FALLBACK" 2>&1); then
    wait_ipv4 "$ifc" 20 && return 0
    out="IPv4 adresi gelmedi"
  fi
  echo "warning=otomatik adres alınamadı ($FALLBACK): $(printf '%s' "$out" | oneline)"
  return 1
}

# Sabit profili siler, yedeği ve koruma sonucunu kaldırır, stage=none yazar.
finish_none() {
  delete_named "$PROFILE"
  rm -f "$BACKUP" "$GUARD_STATUS"
  reset_setup
  write_state
}

# Deneme sürerken geri alma (zamanlayıcı / ensure / panel / terminal). Zamanlayıcının kendisi de bunu çalıştırır: yalnız
# .timer durdurulur, servise dokunulmaz (bkz. stop_timer).
rollback_trial() {
  local ifc=$S_iface
  systemctl stop "$TIMER_UNIT.timer" "$RETRY_PREFIX-*.timer" >/dev/null 2>&1 || true
  if ! restore_old; then
    echo "warning=otomatik adres alınamadı — modemin DHCP'si açık mı? NetworkManager denemeyi sürdürür"
    log "geri alma: $ifc otomatik adres alamadı"
  fi
  finish_none
  log "sabit adres denemesi geri alındı ($ifc)"
  echo "rolled_back=1"
}

# Koruma sonucunu atomik yazar ve günlüğe geçer.
write_guard() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  printf 'result=%s\nat=%s\ndetail=%s\n' "$1" "$(date +%s)" "$2" > "$GUARD_STATUS.tmp" \
    && mv -f "$GUARD_STATUS.tmp" "$GUARD_STATUS"
  logger -t pi5-net-guard "sonuç=$1${2:+ — $2}" 2>/dev/null || true
  echo "guard_result=$1"
  if [ -n "$2" ]; then echo "guard_detail=$2"; fi
}

# ACİL MOD (yalnız bu açılış): NM arayüzü bırakır, adresler ve varsayılan rota elle kurulur. Profilde olmayan IPv4
# adresleri (ör. eski DHCP adresi) kaldırılır: kaynak adres seçimi belirsiz kalmasın. Yeniden başlatmada /run silinir
# ve NM arayüzü yeniden yönetir; NM yeniden başlatılırsa koruma önce onarmayı dener.
emergency() {
  local ifc=$S_iface a
  nmcli device set "$ifc" managed no >/dev/null 2>&1 || true
  ip link set "$ifc" up 2>/dev/null
  for a in $(iface_addrs "$ifc"); do
    [ "$a" = "$S_transit" ] || [ "$a" = "$S_client" ] || ip addr del "$a" dev "$ifc" 2>/dev/null
  done
  ip addr replace "$S_transit" brd + dev "$ifc" \
    && ip addr replace "$S_client" brd + dev "$ifc" \
    && ip route replace default via "$S_gw" dev "$ifc" metric 100
}

# Yedeği profil dosyasının yerine atomik koyar ve yalnız o dosyayı NM'ye yükler (con reload yok). RESTORE_DETAIL.
restore_backup() {
  local tmp out
  tmp="$(dirname "$KEYFILE")/.pi5-eth0.tmp"
  if cp -f "$BACKUP" "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$KEYFILE"; then
    if out=$(nmcli connection load "$KEYFILE" 2>&1); then RESTORE_DETAIL="profil dosyası yedekten geri yüklendi"
    else RESTORE_DETAIL="yedekten geri konan profil yüklenemedi: $(printf '%s' "$out" | oneline)"; fi
  else
    rm -f "$tmp"; RESTORE_DETAIL="profil dosyası yedekten geri konamadı"
  fi
}

# Profili etkinleştirir ve iki adresi bekler. 0 = tamam; değilse UP_OUT (tek satır neden).
try_up() {
  local out
  if out=$(nmcli -w 30 connection up id "$PROFILE" 2>&1); then
    wait_both "$1" 10 && return 0
    UP_OUT="profil etkinleşti ama iki adres de gelmedi"
  else
    UP_OUT=$(printf '%s' "$out" | oneline)
  fi
  return 1
}

# Kalıcı sabit profili denetler / onarır. $1 = profilin kendiliğinden etkinleşmesi için beklenecek en uzun süre (sn).
# $2 = passive (ensure: panel açılışı, güncelleme): acil moddaki arayüze dokunulmaz — onu yeniden NM yönetimine almak elle
# kurulmuş adresleri silip evi her gece / her panel açılışında yeniden kesintiye sokardı. Onarım yalnız guard'da
# (açılış, NetworkManager yeniden başlatması) ya da panelden bilinçli bir işlemde denenir.
guard_routine() {
  local wait=$1 ifc=$S_iface end detail=""
  if [ -z "$ifc" ] || [ -z "$S_transit" ] || [ -z "$S_client" ] || [ -z "$S_gw" ]; then
    write_guard error "durum kaydı eksik ($STATE_FILE)"; return 0
  fi
  if [ "${2:-}" = passive ] && [ "$(dev_state "$ifc")" = 10 ] && both_addrs "$ifc" "$S_transit" "$S_client" \
     && ip -4 route show default 2>/dev/null | grep -Eq "via $(rx "$S_gw") dev $ifc( |\$)"; then
    echo "guard_result=emergency"
    echo "guard_detail=acil mod sürüyor (adresler elle tutuluyor) — onarım açılışta ya da NetworkManager yeniden başlatılınca denenir"
    return 0
  fi
  # 1. Açılışta NM profili birazdan kendisi etkinleştirir: beklenir.
  end=$((SECONDS + wait))
  while :; do
    if [ "$(active_conn "$ifc")" = "$PROFILE" ] && both_addrs "$ifc" "$S_transit" "$S_client"; then
      write_guard ok ""; return 0
    fi
    # Arayüz yönetilmiyor (önceki acil mod, NM yeniden başlatıldı): beklemek boşuna.
    [ "$(dev_state "$ifc")" = 10 ] && break
    [ "$SECONDS" -ge "$end" ] && break
    sleep 1
  done
  # 2. Kablo yok: yapılacak bir şey yok — kablo gelince NM profili kendisi etkinleştirir.
  if [ "$(carrier "$ifc")" != 1 ]; then
    write_guard no_carrier "kablo bağlantısı yok ($ifc)"; return 0
  fi
  # 3. Profil dosyası yok / boş / yüklenmemiş → yedekten geri konur ve yalnız o dosya yüklenir.
  if ! keyfile_ok; then
    if [ -s "$BACKUP" ]; then restore_backup; detail=$RESTORE_DETAIL
    else detail="profil dosyası ve yedeği yok"; fi
  fi
  if [ "$(dev_state "$ifc")" = 10 ]; then nmcli device set "$ifc" managed yes >/dev/null 2>&1; sleep 1; fi
  if try_up "$ifc"; then
    write_guard repaired "${detail:-profil yeniden etkinleştirildi}"; return 0
  fi
  detail="${detail:+$detail; }profil etkinleştirilemedi: $UP_OUT"
  # 3b. Dosya yüklü ama yedekten farklı (elle / başka bir araçla değiştirilmiş): acil moddan önce yedekle bir kez daha.
  if [ -s "$BACKUP" ] && [ -s "$KEYFILE" ] && ! cmp -s "$BACKUP" "$KEYFILE"; then
    restore_backup
    detail="$detail; $RESTORE_DETAIL (dosya yedekten farklıydı)"
    if try_up "$ifc"; then
      write_guard repaired "$detail"; return 0
    fi
    detail="$detail; yedekle de etkinleştirilemedi: $UP_OUT"
  fi
  # 4. Hâlâ olmuyorsa acil mod.
  if emergency; then
    write_guard emergency "$detail — adresler bu açılış için elle kuruldu"
  else
    write_guard emergency "$detail — acil mod da tam kurulamadı"
  fi
  return 0
}

# Süresi geçen ya da zamanlayıcısı olmayan (Pi yeniden başladı: geçici zamanlayıcı /run'daydı; ya da zamanlayıcı
# kurulamadan süreç öldü) deneme geri alınır — onaylayacak tarayıcı oturumu zaten yok.
trial_check() {
  if [ "$S_trial_ends" -le "$(date +%s)" ] || ! timer_active; then rollback_trial; fi
}

# --- Kurulum Wi-Fi'ı (erişim noktası pi5-ap) ---
AP_SSID_RE='^[A-Za-z0-9 _.-]{1,32}$'
AP_PSK_RE='^[ -~]{8,63}$'
# Ağ adı: harf, rakam, boşluk, _ . - (1-32); başta / sonda boşluk olmaz (keyfile baştaki boşluğu siler).
valid_ssid() { [[ $1 =~ $AP_SSID_RE ]] && [[ $1 != " "* ]] && [[ $1 != *" " ]]; }
# WPA2 parolası: 8-63 yazdırılabilir ASCII (0x20-0x7E); ters bölü (keyfile kaçış karakteri) ve baştaki / sondaki boşluk
# olmaz. Denetim bash içinde yapılır: parola hiçbir dış komuta verilmez.
valid_psk() { [[ $1 =~ $AP_PSK_RE ]] && [[ $1 != *\\* ]] && [[ $1 != " "* ]] && [[ $1 != *" " ]]; }
# İlk Wi-Fi kartı (TYPE wifi; wifi-p2p sanal aygıtı hariç).
wifi_dev() { nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2 == "wifi" { print $1; exit }'; }
ap_capable() { [ -n "$1" ] && [ "$(nmcli -g WIFI-PROPERTIES.AP device show "$1" 2>/dev/null)" = yes ]; }
# Yayında: pi5-ap bu kartta etkin ve 192.168.50.1/24 kartta.
ap_up_ok() { [ -n "$1" ] && [ "$(active_conn "$1")" = "$AP_PROFILE" ] && addr_static "$1" "$AP_ADDR"; }
# $1 kart, $2 sn: yayın başlayana kadar bekler
wait_ap() {
  local end=$((SECONDS + $2))
  while ! ap_up_ok "$1"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# $1 kart, $2 sn: Wi-Fi açıldıktan sonra kart NM'de kullanılabilir olana kadar bekler (durum kodu ≥ 30: "bağlı değil").
wait_dev_ready() {
  local end=$((SECONDS + $2)) s
  while :; do
    s=$(dev_state "$1")
    [[ $s =~ ^[0-9]+$ ]] && [ "$s" -ge 30 ] && return 0
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# pi5-ap NM'ye beklenen dosyadan yüklenmiş.
ap_loaded() { [ -s "$AP_KEYFILE" ] && [ "$(file_of_name "$AP_PROFILE")" = "$AP_KEYFILE" ]; }
# NM'nin yeniden yazdığı dosyayı doğrular (ap confirm): erişim noktası kipi, adres ve parola dosyada.
ap_verify_keyfile() {
  ap_loaded && grep -q '^mode=ap$' "$AP_KEYFILE" && grep -Eq "^address1=$(rx "$AP_ADDR")(,|\$)" "$AP_KEYFILE" \
    && grep -q '^psk=' "$AP_KEYFILE"
}

# Profil dosyasını doğrudan yazar ($1 kart, $2 ağ adı, $3 parola). nmcli add kullanılmaz: parola hiçbir komutun
# argv'sinde görünmez (printf bash yerleşiği). Geçici dosya aynı dizinde ve adı "." ile başlar (NM onu profil saymaz);
# root 0600 (NM başka izinli dosyayı yüklemez). pmf=1 (PMF kapalı): NM 1.52 wpa-psk + PMF "optional" ile AP'yi
# WPA2/WPA3 geçiş kipinde (WPA-PSK WPA-PSK-SHA256 SAE) kurar; bazı telefonlar bu kipe bağlanamıyor — yalnız WPA2.
ap_write_keyfile() {
  local dir tmp uuid
  dir=$(dirname "$AP_KEYFILE"); tmp="$dir/.pi5-ap.tmp"
  uuid=$(cat /proc/sys/kernel/random/uuid 2>/dev/null)
  [[ $uuid =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  mkdir -p "$dir" || return 1
  if printf '%s\n' "[connection]
id=$AP_PROFILE
uuid=$uuid
type=wifi
interface-name=$1
autoconnect=false
autoconnect-priority=300

[wifi]
mode=ap
ssid=$2
band=bg
channel=6

[wifi-security]
key-mgmt=wpa-psk
proto=rsn;
pairwise=ccmp;
group=ccmp;
pmf=1
psk=$3

[ipv4]
method=manual
address1=$AP_ADDR

[ipv6]
method=disabled" > "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$AP_KEYFILE"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# pi5_ap nft tablosu ($1 kart): kurulum Wi-Fi'ı istemcilerinin 80/tcp trafiği (telefonun "ağa giriş" denetimi dahil)
# Pi'nin giriş sayfasına yönlendirilir; bu karttan / bu karta iletim düşürülür (yalnız panel, internet yok). Boş-tanımla
# → sil → yeniden-tanımla: her yüklemede idempotent; açılışta nftables.service (include) ve pi5-gw-restore da yükler.
# Hata → 1, neden AP_NFT_OUT'ta (tek satır).
ap_nft_load() {
  local ip=${AP_ADDR%/*} out
  AP_NFT_OUT=""
  command -v nft >/dev/null 2>&1 || { AP_NFT_OUT="nft bulunamadı"; return 1; }
  mkdir -p "$(dirname "$AP_NFT")" 2>/dev/null
  if ! printf '%s\n' "table inet pi5_ap {}
delete table inet pi5_ap
table inet pi5_ap {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        iifname \"$1\" ip daddr != $ip tcp dport 80 dnat ip to $ip:80
    }
    chain forward {
        type filter hook forward priority -5; policy accept;
        iifname \"$1\" drop
        oifname \"$1\" drop
    }
}" > "$AP_NFT.tmp" || ! mv -f "$AP_NFT.tmp" "$AP_NFT"; then
    rm -f "$AP_NFT.tmp"; AP_NFT_OUT="$AP_NFT yazılamadı"; return 1
  fi
  out=$(nft -f "$AP_NFT" 2>&1) || { AP_NFT_OUT=$(printf '%s' "$out" | oneline); return 1; }
  return 0
}
# Tabloyu kaldırır: dosyaya önce yalnız silen biçim yazılıp yüklenir (süreç yarıda kalsa da açılışta tablo yeniden
# kurulmaz), sonra dosya silinir.
ap_nft_remove() {
  local del out rc=0
  del=$'table inet pi5_ap {}\ndelete table inet pi5_ap'
  if command -v nft >/dev/null 2>&1; then
    if [ -d "$(dirname "$AP_NFT")" ] && printf '%s\n' "$del" > "$AP_NFT.tmp" && mv -f "$AP_NFT.tmp" "$AP_NFT"; then
      out=$(nft -f "$AP_NFT" 2>&1) || rc=1
    else
      out=$(printf '%s\n' "$del" | nft -f - 2>&1) || rc=1
    fi
    [ "$rc" = 0 ] || echo "warning=kurulum Wi-Fi'ı güvenlik duvarı tablosu (pi5_ap) kaldırılamadı: $(printf '%s' "$out" | oneline)"
  fi
  rm -f "$AP_NFT" "$AP_NFT.tmp"
}

# Kurulum Wi-Fi'ı profilini (tüm kopyaları), dosyasını ve nft tablosunu kaldırır; durum dosyasına dokunmaz.
ap_teardown() {
  nmcli connection down id "$AP_PROFILE" >/dev/null 2>&1 || true
  delete_named "$AP_PROFILE"
  rm -f "$AP_KEYFILE" "$(dirname "$AP_KEYFILE")/.pi5-ap.tmp"
  ap_nft_remove
}
# Denemeyi geri sarar; Pi'nin Wi-Fi'si eski haline döner (en iyi çaba). Wi-Fi önceden kapalıysa, "Wi-Fi ayrık"
# (wifi_off=1) kayıtlıysa ya da Pi evin DHCP sunucusuysa ("wifi on" ile aynı kural: Pi'nin Wi-Fi'si ev ağına dönmez)
# Wi-Fi ÖNCE kapatılır, sonra yayın kaldırılır: profil silinince NM ev Wi-Fi'ına bir anlığına bile bağlanmasın (eski
# bağlantıyı kurmak da boşunadır). Değilse yayın kaldırılır ve eski bağlantı (varsa, henüz kendiliğinden gelmediyse)
# yeniden etkinleştirilir.
ap_unwind() {
  local out
  if [ "$S_ap_radio_was_off" = 1 ] || [ "$S_wifi_off" = 1 ] || pi_dhcp_active; then
    nmcli radio wifi off >/dev/null 2>&1 || echo "warning=Pi'nin Wi-Fi'si kapatılamadı — elle kapatın (nmcli radio wifi off)"
    ap_teardown
    return 0
  fi
  ap_teardown
  uuid_exists "$S_ap_old_uuid" || return 0
  if [ -n "$S_ap_iface" ] && [ "$(active_uuid "$S_ap_iface")" = "$S_ap_old_uuid" ]; then return 0; fi
  out=$(nmcli -w 30 connection up uuid "$S_ap_old_uuid" 2>&1) \
    || echo "warning=Pi'nin Wi-Fi'si eski bağlantısına dönemedi: $(printf '%s' "$out" | oneline)"
  return 0
}
# Yedeği ve koruma sonucunu kaldırır, ap_stage=none yazar (sabit adres alanları ve wifi_off korunur).
ap_finish_none() {
  rm -f "$AP_BACKUP" "$AP_GUARD_STATUS"
  ap_reset
  write_state
}
# Deneme sürerken geri alma (zamanlayıcı / ensure / panel / terminal): yalnız .timer durdurulur (bkz. stop_timer).
ap_rollback_trial() {
  systemctl stop "$AP_TIMER_UNIT.timer" "$AP_RETRY_PREFIX-*.timer" >/dev/null 2>&1 || true
  ap_unwind
  ap_finish_none
  log "kurulum Wi-Fi'ı denemesi geri alındı"
  echo "rolled_back=1"
}

# Kurulum Wi-Fi'ı koruma sonucu (ayrı dosya: sabit adres korumasının sonucunu ezmez).
write_ap_guard() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  printf 'result=%s\nat=%s\ndetail=%s\n' "$1" "$(date +%s)" "$2" > "$AP_GUARD_STATUS.tmp" \
    && mv -f "$AP_GUARD_STATUS.tmp" "$AP_GUARD_STATUS"
  logger -t pi5-net-guard "kurulum Wi-Fi'ı: sonuç=$1${2:+ — $2}" 2>/dev/null || true
  echo "ap_guard_result=$1"
  if [ -n "$2" ]; then echo "ap_guard_detail=$2"; fi
}
# Yedeği profil dosyasının yerine atomik koyar ve yalnız o dosyayı yükler (con reload yok). AP_RESTORE_DETAIL.
ap_restore_backup() {
  local tmp out
  tmp="$(dirname "$AP_KEYFILE")/.pi5-ap.tmp"
  if cp -f "$AP_BACKUP" "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$AP_KEYFILE"; then
    if out=$(nmcli connection load "$AP_KEYFILE" 2>&1); then AP_RESTORE_DETAIL="profil dosyası yedekten geri yüklendi"
    else AP_RESTORE_DETAIL="yedekten geri konan profil yüklenemedi: $(printf '%s' "$out" | oneline)"; fi
  else
    rm -f "$tmp"; AP_RESTORE_DETAIL="profil dosyası yedekten geri konamadı"
  fi
}
# Kalıcı kurulum Wi-Fi'ını denetler / onarır. $1 = NM'nin profili kendiliğinden etkinleştirmesi beklenecek son an,
# $2 = işin bitmesi gereken son an (ikisi de betiğin başından saniye — SECONDS; 0 = sınır yok). nft tablosu her
# denetimde yeniden yüklenir (nftables yeniden başlatıldıysa da yerinde olsun). Acil mod yoktur: kurulum Wi-Fi'ı ev ağı
# için kritik değil.
ap_guard_routine() {
  local until=$1 limit=${2:-0} ifc=$S_ap_iface detail="" nftd="" w=30 out
  if [ -z "$ifc" ]; then write_ap_guard failed "durum kaydı eksik (ap_iface, $STATE_FILE)"; return 0; fi
  ap_nft_load "$ifc" || nftd="güvenlik duvarı tablosu (pi5_ap) yüklenemedi: $AP_NFT_OUT"
  if ! nm_running; then write_ap_guard failed "NetworkManager çalışmıyor${nftd:+; $nftd}"; return 0; fi
  # 1. Açılışta NM kalıcı profili kendisi etkinleştirir: beklenir.
  while ! ap_up_ok "$ifc" && [ "$SECONDS" -lt "$until" ]; do sleep 1; done
  if ap_up_ok "$ifc"; then
    if [ -n "$nftd" ]; then write_ap_guard failed "$nftd"; else write_ap_guard ok ""; fi
    return 0
  fi
  # 2. guard: pi5-net-guard.service TimeoutStartSec=150 — sabit adres onarımı uzun sürdüyse NM'yi bekleme süresi
  #    kısalır; hiç yetmiyorsa onarım sonraki denetime (NetworkManager yeniden başlatması / panel açılışı) kalır.
  if [ "$limit" -gt 0 ]; then
    w=$((limit - SECONDS - 10)); [ "$w" -gt 30 ] && w=30
    if [ "$w" -lt 5 ]; then
      write_ap_guard failed "yayın kapalı; onarıma süre kalmadı (sabit adres denetimi uzun sürdü) — NetworkManager yeniden başlatılınca ya da panel açılınca yeniden denenir${nftd:+; $nftd}"
      return 0
    fi
  fi
  # 3. Profil dosyası yok / boş / yedekten farklı → yedekten geri konur; dosya yerinde ama yüklenmemişse yalnız o yüklenir.
  if [ -s "$AP_BACKUP" ] && { [ ! -s "$AP_KEYFILE" ] || ! cmp -s "$AP_BACKUP" "$AP_KEYFILE"; }; then
    ap_restore_backup; detail=$AP_RESTORE_DETAIL
  elif [ ! -s "$AP_KEYFILE" ]; then
    detail="profil dosyası ve yedeği yok"
  elif [ "$(file_of_name "$AP_PROFILE")" != "$AP_KEYFILE" ]; then
    if out=$(nmcli connection load "$AP_KEYFILE" 2>&1); then detail="profil dosyası yeniden yüklendi"
    else detail="profil dosyası yüklenemedi: $(printf '%s' "$out" | oneline)"; fi
  fi
  # 4. Wi-Fi kapatılmışsa açılır, profil etkinleştirilir.
  if [ "$(nmcli radio wifi 2>/dev/null)" = disabled ]; then
    nmcli radio wifi on >/dev/null 2>&1 && wait_dev_ready "$ifc" 10
  fi
  if out=$(nmcli -w "$w" connection up id "$AP_PROFILE" 2>&1); then
    if wait_ap "$ifc" 10; then
      if [ -n "$nftd" ]; then write_ap_guard failed "${detail:+$detail; }yayın yeniden başlatıldı; $nftd"
      else write_ap_guard repaired "${detail:-yayın yeniden başlatıldı}"; fi
      return 0
    fi
    out="profil etkinleşti ama $AP_ADDR kartta görünmüyor"
  fi
  write_ap_guard failed "${detail:+$detail; }yayın başlatılamadı: $(printf '%s' "$out" | oneline)${nftd:+; $nftd}"
  return 0
}
# Kurulum Wi-Fi'ı denetimi (guard / ensure; sabit adres aşamasından bağımsız). $1 = guard | ensure.
# Süresi geçen ya da zamanlayıcısı olmayan (Pi yeniden başladı) deneme geri alınır; kalıcıysa yayın denetlenir.
ap_check() {
  case "$S_ap_stage" in
    trial)
      if [ "$S_ap_trial_ends" -le "$(date +%s)" ] || ! ap_timer_active; then ap_rollback_trial; fi ;;
    on)
      # guard: açılışta NM'ye betiğin başından 30 sn tanınır, iş 140. sn'de biter; ensure: 5 sn, sınır yok.
      if [ "$1" = guard ]; then ap_guard_routine 30 140; else ap_guard_routine $((SECONDS + 5)) 0; fi ;;
  esac
}

# --- Ev Wi-Fi'ı (erişim noktası rolü, köprü br0) ---
# Üç yerli keyfile doğrudan yazılır ve yalnız o dosyalar yüklenir (parola hiçbir komutun argv'sinde görünmez):
#   pi5-br0      köprü: iki sabit adres (transit + client) buraya taşınır; MAC = eth0'ın MAC'i (modem ve cihazlar Pi'yi
#                aynı MAC'le görmeye devam eder)
#   pi5-br0-eth  eth0 köprü portu
#   pi5-home     Wi-Fi erişim noktası, köprü portu: kablosuz cihazlar kablolularla AYNI ağdadır (adresi evin DHCP
#                sunucusu — modem ya da Pi — verir; Pi'de NAT ya da ayrı ağ yoktur)
# Öncelik 250/300 > pi5-eth0 (200): açılışta NM köprüyü seçer. pi5-eth0 silinmez — köprü kurulamazsa geri dönüş yolu.
# 5 GHz'te yalnız 36-48 (DFS gerektirmeyen, AP kipinde her ülke ayarında izinli kanallar).
HOME_CH_BG='^([1-9]|1[0-3])$'
HOME_CH_A='^(36|40|44|48)$'
valid_channel() { if [ "$1" = a ]; then [[ $2 =~ $HOME_CH_A ]]; else [[ $2 =~ $HOME_CH_BG ]]; fi; }
# $1 arayüz köprünün (br0) portu mu
br_port() { [ "$(basename "$(readlink "/sys/class/net/$1/master" 2>/dev/null)")" = "$BR_IF" ]; }
# Köprü yerinde: pi5-br0 br0'da etkin, iki adres br0'da, eth0 pi5-br0-eth ile köprünün portu.
br_up_ok() {
  [ "$(active_conn "$BR_IF")" = "$BR_PROFILE" ] && both_addrs "$BR_IF" "$S_transit" "$S_client" \
    && [ "$(active_conn "$S_iface")" = "$PORT_PROFILE" ] && br_port "$S_iface"
}
wait_br() {
  local end=$((SECONDS + $1))
  while ! br_up_ok; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# Yayında: pi5-home bu kartta etkin ve kart köprünün portu.
home_ap_ok() { [ -n "$1" ] && [ "$(active_conn "$1")" = "$HOME_PROFILE" ] && br_port "$1"; }
wait_home_ap() {
  local end=$((SECONDS + $2))
  while ! home_ap_ok "$1"; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# Üç profil de NM'ye beklenen dosyalardan yüklenmiş.
home_loaded() {
  [ -s "$BR_KEYFILE" ] && [ "$(file_of_name "$BR_PROFILE")" = "$BR_KEYFILE" ] \
    && [ -s "$PORT_KEYFILE" ] && [ "$(file_of_name "$PORT_PROFILE")" = "$PORT_KEYFILE" ] \
    && [ -s "$HOME_KEYFILE" ] && [ "$(file_of_name "$HOME_PROFILE")" = "$HOME_KEYFILE" ]
}
# $1 hedef dosya, $2 içerik: aynı dizinde "." ile başlayan geçici dosya (NM onu profil saymaz), root 0600, sonra mv.
home_put_keyfile() {
  local tmp
  tmp="$(dirname "$1")/.$(basename "$1").tmp"
  mkdir -p "$(dirname "$1")" || return 1
  if printf '%s\n' "$2" > "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$1"; then return 0; fi
  rm -f "$tmp"
  return 1
}
new_uuid() {
  local u
  u=$(cat /proc/sys/kernel/random/uuid 2>/dev/null)
  [[ $u =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && echo "$u"
}
# $1 Wi-Fi kartı, $2 ağ adı, $3 parola, $4 bant, $5 kanal, $6 eth0 MAC, $7 IPv6 yöntemi. Kendiliğinden bağlanma deneme
# boyunca KAPALI ("home confirm" açar). pmf=1 (yalnız WPA2): bkz. ap_write_keyfile.
home_write_keyfiles() {
  local u1 u2 u3
  u1=$(new_uuid) && u2=$(new_uuid) && u3=$(new_uuid) || return 1
  home_put_keyfile "$BR_KEYFILE" "[connection]
id=$BR_PROFILE
uuid=$u1
type=bridge
interface-name=$BR_IF
autoconnect=false
autoconnect-priority=250

[ethernet]
cloned-mac-address=$6

[bridge]
stp=false

[ipv4]
method=manual
address1=$S_transit
address2=$S_client
gateway=$S_gw
dns=127.0.0.1;$S_gw;
route-metric=100

[ipv6]
method=$7" || return 1
  home_put_keyfile "$PORT_KEYFILE" "[connection]
id=$PORT_PROFILE
uuid=$u2
type=ethernet
interface-name=$S_iface
master=$BR_IF
slave-type=bridge
autoconnect=false
autoconnect-priority=250

[ethernet]

[bridge-port]" || return 1
  home_put_keyfile "$HOME_KEYFILE" "[connection]
id=$HOME_PROFILE
uuid=$u3
type=wifi
interface-name=$1
master=$BR_IF
slave-type=bridge
autoconnect=false
autoconnect-priority=300

[wifi]
mode=ap
ssid=$2
band=$4
channel=$5

[wifi-security]
key-mgmt=wpa-psk
proto=rsn;
pairwise=ccmp;
group=ccmp;
pmf=1
psk=$3

[bridge-port]"
}
# Üç dosyayı yükler (con reload yok). Hata → 1, neden HOME_LOAD_OUT'ta.
home_load_all() {
  local f out
  HOME_LOAD_OUT=""
  for f in "$BR_KEYFILE" "$PORT_KEYFILE" "$HOME_KEYFILE"; do
    out=$(nmcli connection load "$f" 2>&1) || { HOME_LOAD_OUT=$(printf '%s' "$out" | oneline); return 1; }
  done
  home_loaded || { HOME_LOAD_OUT="profiller NetworkManager'da beklenen dosyalardan görünmüyor"; return 1; }
}
# Üç profili (tüm kopyaları), dosyalarını ve geçici dosyaları kaldırır; durum dosyasına dokunmaz.
home_delete_all() {
  local f
  delete_named "$HOME_PROFILE"; delete_named "$PORT_PROFILE"; delete_named "$BR_PROFILE"
  for f in "$HOME_KEYFILE" "$PORT_KEYFILE" "$BR_KEYFILE"; do rm -f "$f" "$(dirname "$f")/.$(basename "$f").tmp"; done
}
# NM köprü aygıtını kaldırmadıysa kaldırılır: aynı adresler iki arayüzde kalmasın.
br_link_remove() { if [ -e "/sys/class/net/$BR_IF" ]; then ip link delete "$BR_IF" 2>/dev/null || true; fi; }
# Yedekleri profil dosyalarının yerine koyar (eksik ya da farklıysa) ve yalnız o dosyaları yükler. HOME_RESTORE_DETAIL.
# Profil `nmcli connection delete` ile silindiyse NM o UUID için bir mezar taşı bırakır (<uuid>.nmmeta → /dev/null):
# aynı UUID'li yedek yüklense de gizli kalır (gerçek NM 1.52 ile görüldü) — yüklemeden önce kaldırılır.
home_restore_backups() {
  local pair kf bk tmp u n=0 bad=""
  HOME_RESTORE_DETAIL=""
  for pair in "$BR_KEYFILE|$BR_BACKUP" "$PORT_KEYFILE|$PORT_BACKUP" "$HOME_KEYFILE|$HOME_BACKUP"; do
    kf=${pair%%|*}; bk=${pair#*|}
    [ -s "$bk" ] || { bad="$bad $(basename "$bk") (yedek yok)"; continue; }
    if [ -s "$kf" ] && cmp -s "$bk" "$kf"; then
      nmcli -t -f FILENAME connection show 2>/dev/null | grep -Fxq "$kf" && continue
    else
      tmp="$(dirname "$kf")/.$(basename "$kf").tmp"
      if ! { cp -f "$bk" "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$kf"; }; then
        rm -f "$tmp"; bad="$bad $(basename "$kf")"; continue
      fi
    fi
    u=$(sed -n 's/^uuid=//p' "$kf" | head -1)
    if [[ $u =~ ^[0-9a-f-]{36}$ ]] && [ "$(readlink "$(dirname "$kf")/$u.nmmeta" 2>/dev/null)" = /dev/null ]; then
      rm -f "$(dirname "$kf")/$u.nmmeta"
    fi
    if nmcli connection load "$kf" >/dev/null 2>&1 && [ "$(file_of_uuid "$u")" = "$kf" ]; then n=$((n + 1))
    else bad="$bad $(basename "$kf")"; fi
  done
  [ "$n" -gt 0 ] && HOME_RESTORE_DETAIL="$n profil dosyası yedekten geri yüklendi"
  [ -n "$bad" ] && HOME_RESTORE_DETAIL="${HOME_RESTORE_DETAIL:+$HOME_RESTORE_DETAIL; }geri yüklenemeyen:$bad"
  return 0
}
# Ev Wi-Fi'ını kaldırıp Pi'yi köprüsüz sabit profile (pi5-eth0) döndürür (deneme geri alma, kapatma, başarısız açma).
# Wi-Fi önceden kapalıysa, "Wi-Fi ayrık" kayıtlıysa ya da Pi evin DHCP sunucusuysa Wi-Fi ÖNCE kapatılır ("wifi on" ile
# aynı kural: Pi'nin Wi-Fi'si ev ağına istemci olarak dönmez).
home_unwind() {
  local ifc=$S_iface out
  if [ "$S_home_radio_was_off" = 1 ] || [ "$S_wifi_off" = 1 ] || pi_dhcp_active; then
    nmcli radio wifi off >/dev/null 2>&1 || echo "warning=Pi'nin Wi-Fi'si kapatılamadı — elle kapatın (nmcli radio wifi off)"
  fi
  nmcli connection down id "$HOME_PROFILE" >/dev/null 2>&1 || true
  # Köprü önce indirilir (adresler br0'dan kalkar, eth0 portu bırakılır), sonra eth0'a sabit profil: adresler bir an bile
  # iki arayüzde birden olmasın.
  nmcli connection down id "$BR_PROFILE" >/dev/null 2>&1 || true
  home_delete_all
  br_link_remove
  [ -n "$ifc" ] || return 0
  if [ "$(dev_state "$ifc")" = 10 ]; then nmcli device set "$ifc" managed yes >/dev/null 2>&1; sleep 1; fi
  # Köprü kalkınca NM pi5-eth0'ı kendiliğinden etkinleştirmiş olabilir: yeniden başlatılmaz.
  if [ "$(active_conn "$ifc")" = "$PROFILE" ] && both_addrs "$ifc" "$S_transit" "$S_client"; then return 0; fi
  if out=$(nmcli -w 30 connection up id "$PROFILE" 2>&1) && wait_both "$ifc" 10; then return 0; fi
  echo "warning=sabit profil ($PROFILE) yeniden etkinleşmedi: $(printf '%s' "${out:-adresler gelmedi}" | oneline) — koruma onarıyor"
  guard_routine 0 >/dev/null
  return 0
}
# Yedekleri ve koruma sonucunu kaldırır, home_stage=none yazar (sabit adres ve kurulum Wi-Fi'ı alanları korunur).
home_finish_none() {
  rm -f "$BR_BACKUP" "$PORT_BACKUP" "$HOME_BACKUP" "$GUARD_STATUS"
  home_reset
  write_state
}
# Deneme sürerken geri alma (zamanlayıcı / ensure / panel / terminal): yalnız .timer durdurulur (bkz. stop_timer).
home_rollback_trial() {
  systemctl stop "$HOME_TIMER_UNIT.timer" "$HOME_RETRY_PREFIX-*.timer" >/dev/null 2>&1 || true
  home_unwind
  home_finish_none
  log "ev Wi-Fi'ı denemesi geri alındı"
  echo "rolled_back=1"
}
# Süresi geçen ya da zamanlayıcısı olmayan (Pi yeniden başladı) deneme geri alınır.
home_trial_check() {
  if [ "$S_home_trial_ends" -le "$(date +%s)" ] || ! home_timer_active; then home_rollback_trial; fi
}
# Ev Wi-Fi'ı yayında değilse başlatır (Wi-Fi kapatılmışsa açılır). 0 = yayında; değilse HOME_AP_OUT.
home_ap_repair() {
  local wifi=$S_home_iface out
  HOME_AP_OUT=""
  home_ap_ok "$wifi" && return 0
  if [ "$(nmcli radio wifi 2>/dev/null)" = disabled ]; then
    nmcli radio wifi on >/dev/null 2>&1 && wait_dev_ready "$wifi" 10
  fi
  if out=$(nmcli -w 20 connection up id "$HOME_PROFILE" 2>&1) && wait_home_ap "$wifi" 10; then return 0; fi
  HOME_AP_OUT=$(printf '%s' "${out:-kart köprüye bağlanmadı}" | oneline)
  return 1
}
# Kalıcı ev Wi-Fi'ını denetler / onarır (guard: açılış + NM yeniden başlatması; ensure: panel açılışı, güncelleme).
# Önce erişim: köprü kurulamıyorsa köprü kaldırılır ve Pi köprüsüz sabit profille (pi5-eth0) çalışır; o da olmazsa acil
# mod (adresler eth0'a elle). $1 = NM'nin köprüyü kendiliğinden kurması için beklenecek süre (sn), $2 = passive (bkz.
# guard_routine: acil moddaki ya da köprüsüz çalışan Pi'ye dokunulmaz — onarım açılışta / NM yeniden başlatılınca).
home_guard_routine() {
  local wait=$1 ifc=$S_iface end detail="" out
  if [ -z "$ifc" ] || [ -z "$S_transit" ] || [ -z "$S_client" ] || [ -z "$S_gw" ] || [ -z "$S_home_iface" ]; then
    write_guard error "durum kaydı eksik ($STATE_FILE)"; return 0
  fi
  if [ "${2:-}" = passive ] && [ "$(dev_state "$ifc")" = 10 ] && both_addrs "$ifc" "$S_transit" "$S_client"; then
    echo "guard_result=emergency"
    echo "guard_detail=acil mod sürüyor (adresler elle tutuluyor) — onarım açılışta ya da NetworkManager yeniden başlatılınca denenir"
    return 0
  fi
  if [ "${2:-}" = passive ] && ! br_up_ok && [ "$(active_conn "$ifc")" = "$PROFILE" ] && both_addrs "$ifc" "$S_transit" "$S_client"; then
    echo "guard_result=unbridged"
    echo "guard_detail=köprü kurulamamıştı; Pi köprüsüz (pi5-eth0) çalışıyor, ev Wi-Fi'ı yayında değil — onarım açılışta ya da NetworkManager yeniden başlatılınca denenir"
    return 0
  fi
  # 1. Açılışta NM köprüyü kendisi kurar: beklenir.
  end=$((SECONDS + wait))
  while ! br_up_ok; do
    [ "$(dev_state "$ifc")" = 10 ] && break
    [ "$SECONDS" -ge "$end" ] && break
    sleep 1
  done
  if ! br_up_ok; then
    # 2. Kablo yok: kablo gelince NM köprüyü kendisi kurar. Yayın yine denenir (kablosuz cihazlar Pi'ye ulaşabilsin).
    if [ "$(carrier "$ifc")" != 1 ]; then
      home_ap_repair || true
      write_guard no_carrier "kablo bağlantısı yok ($ifc)"; return 0
    fi
    # 3. Profil dosyaları yedekten; eth0 portu etkinleştirilir (NM köprüyü de etkinleştirir), gelmezse köprü açıkça.
    home_restore_backups; detail=$HOME_RESTORE_DETAIL
    if [ "$(dev_state "$ifc")" = 10 ]; then nmcli device set "$ifc" managed yes >/dev/null 2>&1; sleep 1; fi
    # Süreler pi5-net-guard.service TimeoutStartSec=150 içinde kalır (en kötü: 40 + 20 + 10 + 15 + 5 + 40 sn).
    out=$(nmcli -w 20 connection up id "$PORT_PROFILE" 2>&1)
    wait_br 10 || { nmcli -w 15 connection up id "$BR_PROFILE" >/dev/null 2>&1 && wait_br 5; }
    if br_up_ok; then
      detail="${detail:+$detail; }köprü yeniden kuruldu"
    else
      detail="${detail:+$detail; }köprü kurulamadı: $(printf '%s' "${out:-adresler köprüde görünmüyor}" | oneline)"
      # 4. Erişim önce: köprü kaldırılır, Pi köprüsüz sabit profille ayağa kalkar.
      nmcli connection down id "$HOME_PROFILE" >/dev/null 2>&1 || true
      nmcli connection down id "$BR_PROFILE" >/dev/null 2>&1 || true
      br_link_remove
      if try_up "$ifc"; then
        write_guard unbridged "$detail — Pi köprüsüz (pi5-eth0) çalışıyor, ev Wi-Fi'ı bu açılışta yayında değil"; return 0
      fi
      detail="$detail; sabit profil de etkinleşmedi: $UP_OUT"
      if emergency; then write_guard emergency "$detail — adresler bu açılış için elle kuruldu"
      else write_guard emergency "$detail — acil mod da tam kurulamadı"; fi
      return 0
    fi
  fi
  # 5. Köprü yerinde: yayın denetlenir.
  if home_ap_repair; then
    if [ -n "$detail" ]; then write_guard repaired "$detail"; else write_guard ok ""; fi
  else
    write_guard ap_failed "${detail:+$detail; }ev Wi-Fi'ı yayına başlamadı: $HOME_AP_OUT"
  fi
  return 0
}

cmd_status() {
  local now dr pifc pgw ptr="" ifc nm=0 ac="" au="" method="" wifi="" gr="" ga="" gd="" k v pok=0
  local wifc apc=0 apa=0 agr="" agd="" lifc hifc hc=0 ha=0 bra=0
  read_state
  now=$(date +%s)
  dr=$(default_route); pifc=${dr%% *}; pgw=${dr#"$pifc"}; pgw=${pgw# }
  if [ -n "$pifc" ] && valid_ip "$pgw"; then ptr=$(addr_for_gw "$pifc" "$pgw"); fi
  ifc=$S_iface
  [ -n "$ifc" ] || ifc=$pifc
  # Cihaz ağının arayüzü: ev Wi-Fi'ı açıkken köprü (adresler ve etkin profil orada), değilse kart.
  lifc=$ifc
  if [ "$S_home_stage" != none ] && [ -e "/sys/class/net/$BR_IF" ]; then lifc=$BR_IF; fi
  # Kurulum Wi-Fi'ı kartı: kayıtlıysa o, değilse ilk Wi-Fi kartı (erişim noktası desteği gösterilsin).
  wifc=$S_ap_iface
  hifc=$S_home_iface
  if nm_running; then
    nm=1
    if [ -n "$lifc" ]; then
      ac=$(active_conn "$lifc"); au=$(active_uuid "$lifc")
      [ -n "$au" ] && method=$(nmcli -g ipv4.method connection show uuid "$au" 2>/dev/null)
    fi
    wifi=$(nmcli radio wifi 2>/dev/null)
    keyfile_ok && pok=1
    [ -n "$wifc" ] || wifc=$(wifi_dev)
    ap_capable "$wifc" && apc=1
    ap_up_ok "$wifc" && apa=1
    [ -n "$hifc" ] || hifc=$(wifi_dev)
    ap_capable "$hifc" && hc=1
    if [ "$S_home_stage" != none ]; then
      home_ap_ok "$hifc" && ha=1
      br_up_ok && bra=1
    fi
  fi
  if [ -f "$GUARD_STATUS" ]; then
    while IFS='=' read -r k v; do
      case "$k" in result) gr=$v ;; at) ga=$v ;; detail) gd=$v ;; esac
    done < "$GUARD_STATUS"
  fi
  if [ -f "$AP_GUARD_STATUS" ]; then
    while IFS='=' read -r k v; do
      case "$k" in result) agr=$v ;; detail) agd=$v ;; esac
    done < "$AP_GUARD_STATUS"
  fi
  echo "stage=$S_stage"
  echo "trial_ends=$S_trial_ends"
  echo "now=$now"
  echo "iface=$ifc"
  echo "transit=$S_transit"
  echo "client=$S_client"
  echo "gw=$S_gw"
  echo "dns=$S_dns"
  echo "wifi_off=$S_wifi_off"
  echo "nm=$nm"
  echo "active_conn=$ac"
  echo "method=$method"
  echo "addrs=$( [ -n "$lifc" ] && iface_addrs "$lifc" | csv)"
  echo "carrier=$( if [ -n "$ifc" ]; then carrier "$ifc"; else echo 0; fi )"
  echo "profile_ok=$pok"
  echo "planned_iface=$pifc"
  echo "planned_type=$( [ "$nm" = 1 ] && [ -n "$pifc" ] && dev_type "$pifc" )"
  echo "planned_mac=$( [ -n "$pifc" ] && cat "/sys/class/net/$pifc/address" 2>/dev/null )"
  echo "planned_transit=$ptr"
  echo "planned_gw=$pgw"
  echo "planned_client=$DEFAULT_CLIENT"
  echo "wifi=$wifi"
  echo "wlan_addrs=$(ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^wlan/ { print $4 }' | csv)"
  echo "guard_result=$gr"
  echo "guard_at=$ga"
  echo "guard_detail=$gd"
  if pi_dhcp_active; then echo "pi_dhcp=1"; else echo "pi_dhcp=0"; fi
  echo "mac=$( [ -n "$ifc" ] && cat "/sys/class/net/$ifc/address" 2>/dev/null )"
  echo "lease_until=$(pi_lease_until)"
  echo "ap_stage=$S_ap_stage"
  echo "ap_trial_ends=$S_ap_trial_ends"
  echo "ap_ssid=$S_ap_ssid"
  echo "ap_iface=$wifc"
  echo "ap_capable=$apc"
  echo "ap_active=$apa"
  echo "ap_addr=$AP_ADDR"
  echo "ap_guard_result=$agr"
  echo "ap_guard_detail=$agd"
  echo "lan_if=$lifc"
  echo "home_stage=$S_home_stage"
  echo "home_trial_ends=$S_home_trial_ends"
  echo "home_ssid=$S_home_ssid"
  echo "home_iface=$hifc"
  echo "home_band=$S_home_band"
  echo "home_channel=$S_home_channel"
  echo "home_capable=$hc"
  echo "home_active=$ha"
  echo "br_active=$bra"
}

cmd_static() {
  local trial="" cl=$DEFAULT_CLIENT dr ifc gw transit cip cpx n m net bc dev a base_ping=0 rc
  local old_uuid old_name old_v6 old_file out end deadline why
  while [ $# -gt 0 ]; do
    case "$1" in
      --trial) trial=${2:-}; shift ;;
      --client) cl=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  { [[ $trial =~ ^[0-9]{1,5}$ ]] && [ "$trial" -ge 30 ] && [ "$trial" -le 3600 ]; } \
    || die "geçersiz deneme süresi (--trial 30-3600 sn)"
  # 1. Ön koşullar
  read_state
  [ "$S_stage" = static ] && die "zaten sabit adres var"
  [ "$S_stage" = trial ] && die "deneme sürüyor"
  command -v nmcli >/dev/null 2>&1 || die "nmcli bulunamadı (NetworkManager kurulu değil)"
  nm_running || die "NetworkManager çalışmıyor"
  # 2. Arayüz, ağ geçidi, modem tarafı adres ve istemci ağı
  dr=$(default_route); ifc=${dr%% *}; gw=${dr#"$ifc"}; gw=${gw# }
  [ -n "$ifc" ] || die "varsayılan rota yok — Pi internete bağlı değil"
  [ "$(dev_type "$ifc")" = ethernet ] \
    || die "Pi kabloyla bağlı değil (internet $ifc üzerinden geliyor) — Pi'yi modeme kabloyla bağlayın"
  [ "$(carrier "$ifc")" = 1 ] || die "$ifc kablo bağlantısı yok"
  valid_ip "$gw" || die "varsayılan ağ geçidi bulunamadı ($ifc)"
  transit=$(addr_for_gw "$ifc" "$gw") || die "$ifc üzerinde modemin ($gw) ağında adres yok"
  [[ $cl =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || die "geçersiz istemci adresi: $cl (ör. 192.168.0.1/24)"
  cip=${BASH_REMATCH[1]}; cpx=$((10#${BASH_REMATCH[2]}))
  valid_ip "$cip" || die "geçersiz istemci adresi: $cl"
  { [ "$cpx" -ge 16 ] && [ "$cpx" -le 30 ]; } || die "istemci ağı öneki 16-30 arasında olmalı (/$cpx)"
  in_net "$cip" 10.0.0.0/8 || in_net "$cip" 172.16.0.0/12 || in_net "$cip" 192.168.0.0/16 \
    || die "istemci adresi özel (RFC1918) bir ağda olmalı: $cip"
  n=$(ip2int "$cip"); m=$(pmask "$cpx"); net=$(( n & m )); bc=$(( net | (~m & 0xFFFFFFFF) ))
  { [ "$n" -ne "$net" ] && [ "$n" -ne "$bc" ]; } || die "istemci adresi ağ ya da yayın adresi olamaz: $cip/$cpx"
  cl="$cip/$cpx"
  nets_overlap "$cl" "$transit" && die "istemci ağı ($(int2ip "$net")/$cpx) modem tarafı ağla ($transit) çakışıyor"
  [ "$cip" != "$gw" ] || die "istemci adresi modemin adresiyle aynı olamaz"
  while read -r dev a; do
    { [ "$dev" = "$ifc" ] || [ "$dev" = lo ]; } && continue
    nets_overlap "$cl" "$a" && die "istemci ağı ($(int2ip "$net")/$cpx) $dev arayüzündeki $a ile çakışıyor"
  done < <(ip -4 -o addr show 2>/dev/null | awk '{ print $2, $4 }')
  # Adres ağda kullanılıyor mu: iputils arping -D (çıkış 0 = kimse yanıt vermedi). Başka arping (farklı seçenek
  # anlamları) ya da arping hatası → ping yedeği. Ping 3 deneme: adres modem üzerinden yönlendiriliyorsa modemin ICMP
  # yönlendirme (redirect) iletisi tek denemeli ping'i yanıt gelmeden hatayla bitirir (kapta görüldü).
  rc=2
  if command -v arping >/dev/null 2>&1 && arping -V 2>&1 | grep -qi iputils; then
    arping -D -q -c 2 -w 3 -I "$ifc" "$cip" >/dev/null 2>&1; rc=$?
    [ "$rc" = 1 ] && die "$cip adresi ağda başka bir cihazda kullanılıyor"
  fi
  if [ "$rc" != 0 ] && ping -c3 -W1 "$cip" >/dev/null 2>&1; then
    die "$cip adresi ağda yanıt veriyor (başka bir cihazda kullanılıyor)"
  fi
  # Modem şimdi ping'e yanıt veriyorsa geçişten sonra da vermeli (7. adım); vermiyorsa bu denetim atlanır.
  ping -c2 -W2 "$gw" >/dev/null 2>&1 && base_ping=1
  # 3. Eski profil (hiç değiştirilmez; geri dönüş için kaydedilir)
  old_uuid=$(active_uuid "$ifc")
  [ -n "$old_uuid" ] || die "$ifc üzerinde etkin bir NetworkManager profili yok"
  old_name=$(nmcli -g connection.id connection show uuid "$old_uuid" 2>/dev/null)
  [ "$old_name" != "$PROFILE" ] || die "$ifc zaten $PROFILE profiliyle çalışıyor ama durum kaydı yok — elle düzeltin (nmcli)"
  old_v6=$(nmcli -g ipv6.method connection show uuid "$old_uuid" 2>/dev/null)
  case "$old_v6" in auto|dhcp|ignore|link-local|disabled) ;; *) old_v6=auto ;; esac
  mkdir -p "$DIR" && chmod 700 "$DIR"
  old_file=$(file_of_uuid "$old_uuid")
  if [ -n "$old_file" ] && [ -f "$old_file" ]; then cp -f "$old_file" "$OLD_COPY" 2>/dev/null && chmod 600 "$OLD_COPY"; fi
  # 4. Yeni profil (kendiliğinden bağlanma deneme boyunca KAPALI: yeniden başlatmada eski profil gelir)
  delete_named "$PROFILE"
  rm -f "$KEYFILE"
  if ! out=$(nmcli connection add type ethernet con-name "$PROFILE" ifname "$ifc" connection.autoconnect no \
        connection.autoconnect-priority 200 ipv4.method manual ipv4.addresses "$transit,$cl" ipv4.gateway "$gw" \
        ipv4.dns "127.0.0.1,$gw" ipv4.route-metric 100 ipv6.method "$old_v6" 2>&1); then
    delete_named "$PROFILE"
    die "sabit profil oluşturulamadı: $(printf '%s' "$out" | oneline)"
  fi
  # 5. Dosya doğrulama + yedek
  if ! verify_keyfile "$transit" "$cl" "$gw"; then
    delete_named "$PROFILE"
    die "sabit profil doğrulanamadı — değişiklik yapılmadı"
  fi
  sync
  if ! { cp -f "$KEYFILE" "$BACKUP" && chmod 600 "$BACKUP"; }; then
    delete_named "$PROFILE"
    die "profil yedeği yazılamadı ($BACKUP) — değişiklik yapılmadı"
  fi
  # 6. Durum + geri alma zamanlayıcısı DEĞİŞİKLİKTEN ÖNCE. Kurulamazsa deneme güvenli değildir → hiç başlanmaz. Kilit
  #    tanımlayıcısı (9) devredilmez: geri alma işi kilidi kendisi alır, miras kalan tanımlayıcı onu kilitlerdi.
  end=$(( $(date +%s) + trial ))
  S_stage=trial; S_trial_ends=$end; S_iface=$ifc; S_transit=$transit; S_client=$cl; S_gw=$gw; S_dns="127.0.0.1,$gw"
  S_old_uuid=$old_uuid; S_old_name=$old_name; S_old_ipv6=$old_v6
  if ! write_state; then
    delete_named "$PROFILE"; rm -f "$BACKUP"
    die "durum dosyası yazılamadı ($STATE_FILE) — değişiklik yapılmadı"
  fi
  stop_timer
  if ! systemd-run --quiet --collect --unit="$TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
       /bin/bash "$SELF" rollback >/dev/null 2>&1 9>&-; then
    delete_named "$PROFILE"; rm -f "$BACKUP"; reset_setup; write_state
    die "geri alma zamanlayıcısı kurulamadı — sabit adres uygulanmadı"
  fi
  log "sabit adres denemesi: $ifc $transit + $cl (ağ geçidi $gw, $trial sn)"
  # 7. Etkinleştir + yerel denetim (en çok 15 sn). Sorun varsa hemen geri alınır; geri alma yarıda kesilse bile
  #    zamanlayıcı kurulu kalır (en sonda durdurulur) ve işi tamamlar.
  if ! out=$(nmcli -w 30 connection up id "$PROFILE" 2>&1); then
    echo "detail=$(printf '%s' "$out" | oneline)"
    restore_old || true
    finish_none; stop_timer
    echo "rolled_back=1"
    die "sabit profil etkinleştirilemedi — eski ayara dönüldü"
  fi
  deadline=$((SECONDS + 15))
  while :; do
    why=""
    both_addrs "$ifc" "$transit" "$cl" || why="adresler arayüzde görünmüyor (şu an: $(iface_addrs "$ifc" | csv))"
    if [ -z "$why" ] && ! route_ok "$ifc" "${transit%/*}"; then
      why="internet rotası $ifc / ${transit%/*} üzerinden değil: $(ip -4 route get 1.1.1.1 2>&1 | head -1 | oneline)"
    fi
    if [ -z "$why" ] && [ "$base_ping" = 1 ] && ! ping -c2 -W2 "$gw" >/dev/null 2>&1; then
      why="modem ($gw) ping'e yanıt vermiyor"
    fi
    [ -z "$why" ] && break
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 1
  done
  if [ -n "$why" ]; then
    echo "detail=$why"
    restore_old || true
    finish_none; stop_timer
    echo "rolled_back=1"
    log "sabit adres denetimi başarısız, geri alındı: $why"
    die "sabit adres denetimi başarısız — eski ayara dönüldü"
  fi
  echo "trial_ends=$end"
  echo "ok=1"
}

cmd_confirm() {
  local out
  read_state
  [ "$S_stage" = trial ] || die "deneme sürmüyor (süre dolduysa geri alınmıştır)"
  [ "$(active_conn "$S_iface")" = "$PROFILE" ] || die "sabit profil ($PROFILE) etkin değil — 'Geri al' ile başa dönün"
  # Eski profil DEĞİŞTİRİLMEZ (netplan- profili değişirse /etc/netplan yeniden yazılır); öncelik 200 açılışta yeter.
  out=$(nmcli connection modify id "$PROFILE" connection.autoconnect yes 2>&1) \
    || die "profil kalıcı yapılamadı: $(printf '%s' "$out" | oneline)"
  if ! verify_keyfile "$S_transit" "$S_client" "$S_gw"; then
    die "profil dosyası doğrulanamadı — deneme sürüyor, süre dolunca geri alınır"
  fi
  grep -q '^autoconnect=false' "$KEYFILE" && die "profil kendiliğinden bağlanmaya ayarlanamadı — deneme sürüyor"
  sync
  { cp -f "$KEYFILE" "$BACKUP" && chmod 600 "$BACKUP"; } || die "profil yedeği yazılamadı ($BACKUP) — deneme sürüyor"
  stop_timer
  S_stage=static; S_trial_ends=0
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  rm -f "$GUARD_STATUS"
  log "sabit adres kalıcı: $S_iface $S_transit + $S_client"
  echo "ok=1"
}

cmd_rollback() {
  read_state
  [ "$S_stage" = trial ] && rollback_trial
  echo "ok=1"
}

cmd_dhcp() {
  local ifc out lu
  read_state
  [ "$S_stage" = trial ] && die "deneme sürüyor — 'Geri al' ile dönün"
  [ "$S_stage" = static ] || die "sabit adres yok — Pi zaten otomatik adreste"
  [ "$S_home_stage" = none ] || die "ev Wi-Fi'ı (köprü) açık — önce Cihaz Rolleri'nden ev Wi-Fi'ını kapatın"
  pi_dhcp_active && die "Pi DHCP sunucusu açıkken otomatik adrese dönülemez — önce modemin DHCP'sini açıp Pi DHCP'sini kapatın"
  # Pi'nin dağıttığı kiralar sürerken cihaz tarafı adresi kaldırılırsa o cihazların ağ geçidi ve DNS'i kaybolur.
  lu=$(pi_lease_until)
  if [ "${1:-}" != --force ] && [ "$lu" -gt "$(date +%s)" ]; then
    echo "lease_until=$lu"
    die "Pi'nin dağıttığı kiralar $(date -d "@$lu" '+%d.%m %H:%M') saatine kadar sürüyor — o zamana kadar bu cihazlar ağ geçidi olarak ${S_client%/*} adresini kullanır; otomatik adrese bu saatten sonra dönün (cihazların Wi-Fi'ını kapatıp açmak onları modeme geçirir ama Pi'deki kira kaydı süresi dolana kadar kalır)"
  fi
  nm_running || die "NetworkManager çalışmıyor"
  ifc=$S_iface
  stop_timer
  if ! restore_old; then
    # Otomatik adres gelmedi (modemin DHCP'si kapalı olabilir): sabit profile geri dönülür — Pi adressiz kalmasın.
    if ! out=$(nmcli -w 30 connection up id "$PROFILE" 2>&1) || ! wait_both "$ifc" 10; then
      echo "detail=sabit profil yeniden etkinleşmedi: $(printf '%s' "$out" | oneline)"
      guard_routine 0 >/dev/null
    fi
    drop_fallback
    die "modemden otomatik adres alınamadı — sabit adres korundu (modemin DHCP'si açık mı?)"
  fi
  finish_none
  log "otomatik adrese dönüldü ($ifc)"
  echo "ok=1"
}

cmd_wifi() {
  local dr ifc
  read_state
  nm_running || die "NetworkManager çalışmıyor"
  # Ev Wi-Fi'ı kartı yayında kullanır: ne kapatılabilir ne de ev ağına istemci olarak bağlanabilir.
  [ "$S_home_stage" = none ] || die "ev Wi-Fi'ı açık — Wi-Fi kartı yayında; önce Cihaz Rolleri'nden ev Wi-Fi'ını kapatın"
  case "${1:-}" in
    off)
      [ "$S_ap_stage" = none ] || die "Kurulum Wi-Fi'ı açık — önce onu kapatın"
      # Pi'nin interneti Wi-Fi'dan geliyorsa kapatmak Pi'yi ağdan koparır.
      dr=$(default_route); ifc=${dr%% *}
      if [ -n "$ifc" ] && [ "$(dev_type "$ifc")" = wifi ]; then
        die "Pi şu an ağa Wi-Fi ile bağlı ($ifc) — Wi-Fi kapatılırsa erişim kesilir; önce Pi'yi modeme kabloyla bağlayın"
      fi
      nmcli radio wifi off >/dev/null 2>&1 || die "Wi-Fi kapatılamadı"
      S_wifi_off=1 ;;
    on)
      [ "$S_ap_stage" = none ] || die "Kurulum Wi-Fi'ı açık — Pi'nin Wi-Fi'si ev ağına bağlanamaz"
      pi_dhcp_active && die "Pi DHCP sunucusu açıkken Pi'nin Wi-Fi'si modeme bağlanamaz — Wi-Fi yayını sonraki adımda"
      nmcli radio wifi on >/dev/null 2>&1 || die "Wi-Fi açılamadı"
      S_wifi_off=0 ;;
    *) die "kullanım: wifi off|on" ;;
  esac
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "Wi-Fi: $1"
  echo "ok=1"
}

# Kurulum Wi-Fi'ı denemesi. Parola STDIN'in ilk satırından okunur; argv'ye, günlüğe, durum dosyasına ve çıktıya girmez.
cmd_ap_on() {
  local trial="" ssid=$AP_DEFAULT_SSID psk="" ifc dr dev a old_uuid radio_off=0 end out why="" lm
  while [ $# -gt 0 ]; do
    case "$1" in
      --trial) trial=${2:-}; shift ;;
      --ssid) ssid=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  # Terminalde sorulur (ekrana yazılmaz); süre sınırı: kilit parola beklenirken süresiz tutulmasın.
  if [ -t 0 ]; then
    printf "Kurulum Wi-Fi'ı parolası (8-63 karakter): " >&2
    IFS= read -r -s -t 120 psk || true
    echo >&2
  else
    IFS= read -r -t 30 psk || true
  fi
  { [[ $trial =~ ^[0-9]{1,5}$ ]] && [ "$((10#$trial))" -ge 30 ] && [ "$((10#$trial))" -le 3600 ]; } \
    || die "geçersiz deneme süresi (--trial 30-3600 sn)"
  trial=$((10#$trial))
  [ -n "$ssid" ] || ssid=$AP_DEFAULT_SSID
  # 1. Ön koşullar
  read_state
  command -v nmcli >/dev/null 2>&1 || die "nmcli bulunamadı (NetworkManager kurulu değil)"
  nm_running || die "NetworkManager çalışmıyor"
  command -v nft >/dev/null 2>&1 || die "nft bulunamadı (nftables kurulu değil) — kurulum Wi-Fi'ı güvenlik duvarı tablosu kurulamaz"
  # Kurulum Wi-Fi'ında adresleri ve DNS'i Pi-hole dağıtır: yalnız "yerel" (LOCAL) ya da "tüm arayüzler" (ALL) dinleme
  # kipinde AP kartını da dinler. SINGLE/BIND yalnız eth0'ı dinler → telefon adres alamaz (gerçek FTL 6.5 ile görüldü).
  command -v pihole-FTL >/dev/null 2>&1 || die "Pi-hole kurulu değil — kurulum Wi-Fi'ı adres dağıtamaz"
  lm=$(pihole-FTL --config dns.listeningMode 2>/dev/null | tr -d '[:space:]'); lm=${lm^^}
  case "$lm" in
    LOCAL|ALL) ;;
    *) die "Pi-hole DNS dinleme modu (${lm:-?}) kurulum Wi-Fi'ına uygun değil — Pi-hole → Ayarlar → DNS'te 'yerel' ya da 'tüm arayüzler' seçin" ;;
  esac
  ifc=$(wifi_dev)
  [ -n "$ifc" ] || die "Pi'de Wi-Fi kartı bulunamadı"
  [[ $ifc =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "Wi-Fi kartının adı beklenmedik: $ifc"
  ap_capable "$ifc" || die "Wi-Fi kartı ($ifc) erişim noktası (AP) kipini desteklemiyor"
  [ "$S_ap_stage" = on ] && die "kurulum Wi-Fi'ı zaten açık"
  [ "$S_ap_stage" = trial ] && die "kurulum Wi-Fi'ı denemesi sürüyor"
  [ "$S_home_stage" = none ] || die "ev Wi-Fi'ı açık — kurulum Wi-Fi'ı aynı kartı kullanır; önce ev Wi-Fi'ını kapatın"
  dr=$(default_route)
  [ "${dr%% *}" = "$ifc" ] && die "Pi'nin interneti Wi-Fi'dan geliyor — önce kabloyla bağlayın"
  # 192.168.50.0/24 başka bir kartta (ör. ev ağı bu aralıktaysa) kullanılıyorsa rota karışır.
  while read -r dev a; do
    { [ "$dev" = "$ifc" ] || [ "$dev" = lo ]; } && continue
    nets_overlap "$AP_ADDR" "$a" && die "kurulum Wi-Fi'ı ağı ($AP_NET) $dev arayüzündeki $a ile çakışıyor"
  done < <(ip -4 -o addr show 2>/dev/null | awk '{ print $2, $4 }')
  valid_ssid "$ssid" || die "geçersiz ağ adı: 1-32 karakter; harf, rakam, boşluk, _ . - (Türkçe harf olmaz, başta / sonda boşluk olmaz)"
  valid_psk "$psk" \
    || die "geçersiz parola: 8-63 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz"
  # 2. Geri dönüş için eski durum: Wi-Fi kartındaki etkin bağlantı (yoksa boş) ve Wi-Fi'nin kapalı olup olmadığı.
  [ "$(nmcli radio wifi 2>/dev/null)" = disabled ] && radio_off=1
  old_uuid=$(active_uuid "$ifc")
  if [ -n "$old_uuid" ] && [ "$(nmcli -g connection.id connection show uuid "$old_uuid" 2>/dev/null)" = "$AP_PROFILE" ]; then
    old_uuid=""
  fi
  # 3. Profil: önceki denemeden kalmış kopyalar silinir, dosya yazılır ve yalnız o yüklenir (con reload yok).
  #    Kendiliğinden bağlanma deneme boyunca KAPALI: yeniden başlatmada eski hal gelir.
  delete_named "$AP_PROFILE"
  rm -f "$AP_KEYFILE"
  ap_write_keyfile "$ifc" "$ssid" "$psk" \
    || die "kurulum Wi-Fi'ı profil dosyası yazılamadı ($AP_KEYFILE) — değişiklik yapılmadı"
  out=$(nmcli connection load "$AP_KEYFILE" 2>&1)
  if ! ap_loaded; then
    delete_named "$AP_PROFILE"; rm -f "$AP_KEYFILE"
    die "kurulum Wi-Fi'ı profili NetworkManager'a yüklenemedi${out:+: $(printf '%s' "$out" | oneline)} — değişiklik yapılmadı"
  fi
  # 4. Durum + geri alma zamanlayıcısı DEĞİŞİKLİKTEN ÖNCE (bkz. static). Kilit tanımlayıcısı (9) devredilmez.
  end=$(( $(date +%s) + trial ))
  S_ap_stage=trial; S_ap_trial_ends=$end; S_ap_iface=$ifc; S_ap_ssid=$ssid; S_ap_old_uuid=$old_uuid
  S_ap_radio_was_off=$radio_off
  if ! write_state; then
    delete_named "$AP_PROFILE"; rm -f "$AP_KEYFILE"
    die "durum dosyası yazılamadı ($STATE_FILE) — değişiklik yapılmadı"
  fi
  ap_stop_timer
  if ! systemd-run --quiet --collect --unit="$AP_TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
       /bin/bash "$SELF" ap rollback >/dev/null 2>&1 9>&-; then
    delete_named "$AP_PROFILE"; rm -f "$AP_KEYFILE"; ap_reset; write_state
    die "geri alma zamanlayıcısı kurulamadı — kurulum Wi-Fi'ı açılmadı"
  fi
  log "kurulum Wi-Fi'ı denemesi: $ifc \"$ssid\" ($AP_ADDR, $trial sn)"
  # 5. Etkinleştir + denetim (en çok 15 sn) + nft tablosu. Sorun varsa hemen geri alınır; geri alma yarıda kesilse bile
  #    zamanlayıcı kurulu kalır (en sonda durdurulur) ve işi tamamlar.
  if [ "$radio_off" = 1 ]; then
    if out=$(nmcli radio wifi on 2>&1); then wait_dev_ready "$ifc" 15 || true
    else why="Wi-Fi açılamadı: $(printf '%s' "$out" | oneline)"; fi
  fi
  if [ -z "$why" ] && ! out=$(nmcli -w 30 connection up id "$AP_PROFILE" 2>&1); then
    why="kurulum Wi-Fi'ı etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
  fi
  if [ -z "$why" ] && ! wait_ap "$ifc" 15; then
    why="kurulum Wi-Fi'ı yayına başlamadı (etkin bağlantı: $(active_conn "$ifc"); adresler: $(iface_addrs "$ifc" | csv))"
  fi
  if [ -z "$why" ] && ! ap_nft_load "$ifc"; then
    why="güvenlik duvarı tablosu (pi5_ap) yüklenemedi: $AP_NFT_OUT"
  fi
  if [ -n "$why" ]; then
    echo "detail=$why"
    ap_unwind; ap_finish_none; ap_stop_timer
    echo "rolled_back=1"
    log "kurulum Wi-Fi'ı denemesi başarısız, geri alındı: $why"
    die "kurulum Wi-Fi'ı açılamadı — eski ayara dönüldü"
  fi
  echo "ap_trial_ends=$end"
  echo "ok=1"
}

cmd_ap_confirm() {
  local out
  read_state
  [ "$S_ap_stage" = trial ] || die "kurulum Wi-Fi'ı denemesi sürmüyor (süre dolduysa geri alınmıştır)"
  nm_running || die "NetworkManager çalışmıyor"
  ap_up_ok "$S_ap_iface" || die "kurulum Wi-Fi'ı yayında değil — 'Geri al' ile başa dönün"
  # Yerli keyfile: NM yalnız bu dosyayı yeniden yazar (ev Wi-Fi'ı profili ve /etc/netplan değişmez).
  out=$(nmcli connection modify id "$AP_PROFILE" connection.autoconnect yes 2>&1) \
    || die "kurulum Wi-Fi'ı kalıcı yapılamadı: $(printf '%s' "$out" | oneline)"
  ap_verify_keyfile || die "kurulum Wi-Fi'ı profil dosyası doğrulanamadı — deneme sürüyor, süre dolunca geri alınır"
  grep -q '^autoconnect=false' "$AP_KEYFILE" && die "kurulum Wi-Fi'ı kendiliğinden açılmaya ayarlanamadı — deneme sürüyor"
  sync
  { cp -f "$AP_KEYFILE" "$AP_BACKUP" && chmod 600 "$AP_BACKUP"; } \
    || die "kurulum Wi-Fi'ı profil yedeği yazılamadı ($AP_BACKUP) — deneme sürüyor"
  ap_stop_timer
  S_ap_stage=on; S_ap_trial_ends=0
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  rm -f "$AP_GUARD_STATUS"
  log "kurulum Wi-Fi'ı kalıcı: $S_ap_iface \"$S_ap_ssid\""
  echo "ok=1"
}

cmd_ap_rollback() {
  read_state
  [ "$S_ap_stage" = trial ] && ap_rollback_trial
  echo "ok=1"
}

# Bilinçli kapatma (kalıcıdan ya da denemeden): kurulum Wi-Fi'ı kaldırılır ve Pi'nin Wi-Fi'si kapatılır — Pi ev Wi-Fi'ına
# sessizce yeniden bağlanmasın (wifi_off=1; yeniden bağlamak için "wifi on").
cmd_ap_off() {
  read_state
  [ "$S_ap_stage" = none ] && die "kurulum Wi-Fi'ı açık değil"
  nm_running || die "NetworkManager çalışmıyor"
  ap_stop_timer
  # Wi-Fi önce kapatılır (bkz. ap_unwind): profil silinince NM ev Wi-Fi'ına bir anlığına bile bağlanmasın.
  nmcli radio wifi off >/dev/null 2>&1 || echo "warning=Pi'nin Wi-Fi'si kapatılamadı — elle kapatın (nmcli radio wifi off)"
  ap_teardown
  S_wifi_off=1
  ap_finish_none || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "kurulum Wi-Fi'ı kapatıldı; Pi'nin Wi-Fi'si kapalı"
  echo "ok=1"
}

cmd_ap() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    on) cmd_ap_on "$@" ;;
    confirm) cmd_ap_confirm ;;
    rollback) cmd_ap_rollback ;;
    off) cmd_ap_off ;;
    *) die "kullanım: ap on --trial SN [--ssid AD] | ap confirm | ap rollback | ap off" ;;
  esac
}

# Ev Wi-Fi'ı denemesi. Parola STDIN'in ilk satırından okunur; argv'ye, günlüğe, durum dosyasına ve çıktıya girmez.
cmd_home_on() {
  local trial="" ssid="" psk="" band=bg ch="" wifi dr radio_off=0 end out why="" lm mac v6 base_ping=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --trial) trial=${2:-}; shift ;;
      --ssid) ssid=${2:-}; shift ;;
      --band) band=${2:-}; shift ;;
      --channel) ch=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  if [ -t 0 ]; then
    printf "Ev Wi-Fi'ı parolası (8-63 karakter): " >&2
    IFS= read -r -s -t 120 psk || true
    echo >&2
  else
    IFS= read -r -t 30 psk || true
  fi
  { [[ $trial =~ ^[0-9]{1,5}$ ]] && [ "$((10#$trial))" -ge 30 ] && [ "$((10#$trial))" -le 3600 ]; } \
    || die "geçersiz deneme süresi (--trial 30-3600 sn)"
  trial=$((10#$trial))
  case "$band" in bg|a) ;; *) die "geçersiz bant: $band (bg = 2,4 GHz, a = 5 GHz)" ;; esac
  if [ -z "$ch" ]; then if [ "$band" = a ]; then ch=36; else ch=6; fi; fi
  if ! valid_channel "$band" "$ch"; then
    if [ "$band" = a ]; then die "geçersiz kanal: $ch (5 GHz: 36, 40, 44, 48)"; else die "geçersiz kanal: $ch (2,4 GHz: 1-13)"; fi
  fi
  # 1. Ön koşullar
  read_state
  command -v nmcli >/dev/null 2>&1 || die "nmcli bulunamadı (NetworkManager kurulu değil)"
  nm_running || die "NetworkManager çalışmıyor"
  [ "$S_home_stage" = on ] && die "ev Wi-Fi'ı zaten açık"
  [ "$S_home_stage" = trial ] && die "ev Wi-Fi'ı denemesi sürüyor"
  [ "$S_stage" = static ] || die "önce Pi'ye sabit adres verin ve kalıcı yapın (DHCP Ayarları, 1. adım)"
  [ "$S_ap_stage" = none ] || die "kurulum Wi-Fi'ı açık — ev Wi-Fi'ı aynı kartı kullanır; önce kurulum Wi-Fi'ını kapatın"
  { [ "$(active_conn "$S_iface")" = "$PROFILE" ] && both_addrs "$S_iface" "$S_transit" "$S_client"; } \
    || die "sabit adres profili ($PROFILE) $S_iface üzerinde etkin değil — önce DHCP Ayarları'ndaki uyarıyı giderin"
  [ -e "/sys/class/net/$BR_IF" ] && die "$BR_IF arayüzü zaten var (başka bir araç köprü kurmuş olabilir) — önce onu kaldırın"
  # Pi DHCP'si açıksa kablosuz cihazlara adresi ve DNS'i Pi-hole verir: köprüyü de dinlemesi için yerel (LOCAL) ya da
  # tüm arayüzler (ALL) kipi. SINGLE/BIND yalnız eth0'ı dinler — köprüde eth0'ın adresi kalmaz.
  if command -v pihole-FTL >/dev/null 2>&1; then
    lm=$(pihole-FTL --config dns.listeningMode 2>/dev/null | tr -d '[:space:]'); lm=${lm^^}
    case "$lm" in
      LOCAL|ALL) ;;
      *) die "Pi-hole DNS dinleme modu (${lm:-?}) köprüye uygun değil — Pi-hole → Ayarlar → DNS'te 'yerel' ya da 'tüm arayüzler' seçin" ;;
    esac
  fi
  wifi=$(wifi_dev)
  [ -n "$wifi" ] || die "Pi'de Wi-Fi kartı bulunamadı"
  [[ $wifi =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "Wi-Fi kartının adı beklenmedik: $wifi"
  ap_capable "$wifi" || die "Wi-Fi kartı ($wifi) erişim noktası (AP) kipini desteklemiyor"
  dr=$(default_route)
  [ "${dr%% *}" = "$wifi" ] && die "Pi'nin interneti Wi-Fi'dan geliyor — önce kabloyla bağlayın"
  valid_ssid "$ssid" || die "geçersiz ağ adı: 1-32 karakter; harf, rakam, boşluk, _ . - (Türkçe harf olmaz, başta / sonda boşluk olmaz)"
  valid_psk "$psk" \
    || die "geçersiz parola: 8-63 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz"
  mac=$(tr 'A-F' 'a-f' < "/sys/class/net/$S_iface/address" 2>/dev/null)
  [[ $mac =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || die "$S_iface MAC adresi okunamadı"
  v6=$(nmcli -g ipv6.method connection show id "$PROFILE" 2>/dev/null)
  case "$v6" in auto|dhcp|ignore|link-local|disabled) ;; *) v6=auto ;; esac
  ping -c2 -W2 "$S_gw" >/dev/null 2>&1 && base_ping=1
  [ "$(nmcli radio wifi 2>/dev/null)" = disabled ] && radio_off=1
  # 2. Profiller (önceki denemeden kalmış kopyalar silinir; yalnız bu üç dosya yüklenir).
  home_delete_all
  home_write_keyfiles "$wifi" "$ssid" "$psk" "$band" "$ch" "$mac" "$v6" \
    || { home_delete_all; die "ev Wi-Fi'ı profil dosyaları yazılamadı — değişiklik yapılmadı"; }
  if ! home_load_all; then
    home_delete_all
    die "ev Wi-Fi'ı profilleri NetworkManager'a yüklenemedi: $HOME_LOAD_OUT — değişiklik yapılmadı"
  fi
  # 3. Durum + geri alma zamanlayıcısı DEĞİŞİKLİKTEN ÖNCE (bkz. static). Kilit tanımlayıcısı (9) devredilmez.
  end=$(( $(date +%s) + trial ))
  S_home_stage=trial; S_home_trial_ends=$end; S_home_iface=$wifi; S_home_ssid=$ssid; S_home_band=$band
  S_home_channel=$ch; S_home_radio_was_off=$radio_off; S_lan_if=$BR_IF
  if ! write_state; then
    home_delete_all
    die "durum dosyası yazılamadı ($STATE_FILE) — değişiklik yapılmadı"
  fi
  home_stop_timer
  if ! systemd-run --quiet --collect --unit="$HOME_TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
       /bin/bash "$SELF" home rollback >/dev/null 2>&1 9>&-; then
    home_delete_all; home_reset; write_state
    die "geri alma zamanlayıcısı kurulamadı — ev Wi-Fi'ı açılmadı"
  fi
  log "ev Wi-Fi'ı denemesi: $S_iface → $BR_IF, $wifi \"$ssid\" ($band kanal $ch, $trial sn)"
  # 4. Etkinleştir: önce eth0 portu (NM köprüyü de etkinleştirir, pi5-eth0 eth0'dan çekilir — adresler hiçbir an iki
  #    arayüzde birden olmaz); köprü gelmezse açıkça. Denetim, sonra yayın. Sorun varsa hemen geri alınır; geri alma
  #    yarıda kesilse bile zamanlayıcı kurulu kalır (en sonda durdurulur) ve işi tamamlar.
  if ! out=$(nmcli -w 30 connection up id "$PORT_PROFILE" 2>&1); then
    why="köprü portu ($S_iface) etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
  elif ! wait_br 15 && ! { nmcli -w 20 connection up id "$BR_PROFILE" >/dev/null 2>&1 && wait_br 10; }; then
    why="köprü kurulamadı ($BR_IF adresleri: $(iface_addrs "$BR_IF" | csv); $S_iface profili: $(active_conn "$S_iface"))"
  elif ! route_ok "$BR_IF" "${S_transit%/*}"; then
    why="internet rotası $BR_IF üzerinden değil: $(ip -4 route get 1.1.1.1 2>&1 | head -1 | oneline)"
  elif [ "$base_ping" = 1 ] && ! ping -c3 -W2 "$S_gw" >/dev/null 2>&1; then
    why="modem ($S_gw) köprüden ping'e yanıt vermiyor"
  fi
  if [ -z "$why" ] && [ "$radio_off" = 1 ]; then
    if out=$(nmcli radio wifi on 2>&1); then wait_dev_ready "$wifi" 15 || true
    else why="Wi-Fi açılamadı: $(printf '%s' "$out" | oneline)"; fi
  fi
  if [ -z "$why" ] && ! out=$(nmcli -w 30 connection up id "$HOME_PROFILE" 2>&1); then
    why="ev Wi-Fi'ı etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
  fi
  if [ -z "$why" ] && ! wait_home_ap "$wifi" 15; then
    why="ev Wi-Fi'ı yayına başlamadı (kartın etkin bağlantısı: $(active_conn "$wifi"))"
  fi
  if [ -n "$why" ]; then
    echo "detail=$why"
    home_unwind; home_finish_none; home_stop_timer
    echo "rolled_back=1"
    log "ev Wi-Fi'ı denemesi başarısız, geri alındı: $why"
    die "ev Wi-Fi'ı açılamadı — eski ayara dönüldü"
  fi
  echo "home_trial_ends=$end"
  echo "ok=1"
}

cmd_home_confirm() {
  local out p
  read_state
  [ "$S_home_stage" = trial ] || die "ev Wi-Fi'ı denemesi sürmüyor (süre dolduysa geri alınmıştır)"
  nm_running || die "NetworkManager çalışmıyor"
  br_up_ok || die "köprü etkin değil — 'Geri al' ile başa dönün"
  home_ap_ok "$S_home_iface" || die "ev Wi-Fi'ı yayında değil — 'Geri al' ile başa dönün"
  for p in "$BR_PROFILE" "$PORT_PROFILE" "$HOME_PROFILE"; do
    out=$(nmcli connection modify id "$p" connection.autoconnect yes 2>&1) \
      || die "$p kalıcı yapılamadı: $(printf '%s' "$out" | oneline) — deneme sürüyor"
  done
  home_loaded || die "ev Wi-Fi'ı profil dosyaları doğrulanamadı — deneme sürüyor, süre dolunca geri alınır"
  grep -q '^autoconnect=false' "$BR_KEYFILE" "$PORT_KEYFILE" "$HOME_KEYFILE" \
    && die "profiller kendiliğinden bağlanmaya ayarlanamadı — deneme sürüyor"
  { grep -q '^mode=ap$' "$HOME_KEYFILE" && grep -q '^psk=' "$HOME_KEYFILE"; } \
    || die "ev Wi-Fi'ı profil dosyası doğrulanamadı — deneme sürüyor"
  sync
  { cp -f "$BR_KEYFILE" "$BR_BACKUP" && cp -f "$PORT_KEYFILE" "$PORT_BACKUP" && cp -f "$HOME_KEYFILE" "$HOME_BACKUP" \
      && chmod 600 "$BR_BACKUP" "$PORT_BACKUP" "$HOME_BACKUP"; } || die "profil yedekleri yazılamadı — deneme sürüyor"
  home_stop_timer
  S_home_stage=on; S_home_trial_ends=0
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  rm -f "$GUARD_STATUS"
  log "ev Wi-Fi'ı kalıcı: $BR_IF ($S_iface + $S_home_iface \"$S_home_ssid\")"
  echo "ok=1"
}

cmd_home_rollback() {
  read_state
  [ "$S_home_stage" = trial ] && home_rollback_trial
  echo "ok=1"
}

# Bilinçli kapatma (kalıcıdan ya da denemeden): köprü ve yayın kalkar, Pi köprüsüz sabit profile döner.
cmd_home_off() {
  read_state
  [ "$S_home_stage" = none ] && die "ev Wi-Fi'ı açık değil"
  nm_running || die "NetworkManager çalışmıyor"
  home_stop_timer
  home_unwind
  home_finish_none || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "ev Wi-Fi'ı kapatıldı; Pi köprüsüz sabit profilde"
  echo "ok=1"
}

cmd_home() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    on) cmd_home_on "$@" ;;
    confirm) cmd_home_confirm ;;
    rollback) cmd_home_rollback ;;
    off) cmd_home_off ;;
    *) die "kullanım: home on --trial SN --ssid AD [--band bg|a] [--channel N] | home confirm | home rollback | home off" ;;
  esac
}

cmd_ensure() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  read_state
  case "$S_stage" in
    trial) trial_check ;;
    static)
      [ "$S_home_stage" = trial ] && home_trial_check
      # Kurulum Wi-Fi'ı ya da ev Wi-Fi'ı açıkken Wi-Fi kapatılmaz (yayın Wi-Fi kartından yapılır).
      if [ "$S_wifi_off" = 1 ] && [ "$S_ap_stage" = none ] && [ "$S_home_stage" = none ] && nm_running; then
        nmcli radio wifi off >/dev/null 2>&1
      fi
      # Ev Wi-Fi'ı denemesi sürerken eth0 bilerek köprüdedir: sabit profil denetimi onu "onarıp" denemeyi bozmasın.
      case "$S_home_stage" in
        on) home_guard_routine 5 passive ;;
        none) guard_routine 5 passive ;;
      esac ;;
  esac
  ap_check ensure
  echo "ok=1"
}

cmd_guard() {
  read_state
  case "$S_stage" in
    trial) trial_check ;;
    static)
      # Açılışta geçici zamanlayıcı yoktur: ev Wi-Fi'ı denemesi burada geri alınır (profilleri kendiliğinden bağlanmaz).
      [ "$S_home_stage" = trial ] && home_trial_check
      if [ "$S_wifi_off" = 1 ] && [ "$S_ap_stage" = none ] && [ "$S_home_stage" = none ]; then nmcli radio wifi off >/dev/null 2>&1; fi
      case "$S_home_stage" in
        on) home_guard_routine 40 ;;
        none) guard_routine 45 ;;
      esac ;;
  esac
  ap_check guard
  return 0
}

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)"
cmd=${1:-status}
shift || true
if [ "$cmd" = status ]; then cmd_status; exit 0; fi
case "$cmd" in
  ensure|guard|static|confirm|rollback|dhcp|wifi|ap|home) ;;
  *) die "bilinmeyen komut: $cmd (status|static|confirm|rollback|dhcp|wifi|ap|home|ensure|guard)" ;;
esac
exec 9>"$LOCK"
if ! flock -w 60 9; then
  [ "$cmd" = guard ] && { echo "error=başka bir ağ işlemi sürüyor"; exit 0; }
  # Zamanlayıcıyla gelen geri alma kilidi alamadıysa vazgeçmez: 30 sn sonra yeniden dener (deneme zamanlayıcısız kalmasın).
  if [ "$cmd" = rollback ]; then arm_retry 30 || true; fi
  if [ "$cmd" = ap ] && [ "${1:-}" = rollback ]; then arm_ap_retry 30 || true; fi
  if [ "$cmd" = home ] && [ "${1:-}" = rollback ]; then arm_home_retry 30 || true; fi
  die "başka bir ağ işlemi sürüyor"
fi
# Kullanıcının başlattığı değişiklikler kilit alındıktan sonra SIGTERM/SIGHUP ile yarıda kesilmez (panelin istek zaman
# aşımı ya da kapanan SSH oturumu Pi'yi adressiz bırakmasın). Kilit beklerken öldürülebilir: onay, kilidi bekleyen
# geri alma servisini durdurabilsin. guard/ensure idempotenttir, systemd'nin durdurmasına engel olmaz.
case "$cmd" in static|confirm|rollback|dhcp|wifi|ap|home) trap '' TERM HUP ;; esac
case "$cmd" in
  ensure) cmd_ensure ;;
  guard) cmd_guard; exit 0 ;;
  static) cmd_static "$@" ;;
  confirm) cmd_confirm ;;
  rollback) cmd_rollback ;;
  dhcp) cmd_dhcp "$@" ;;
  wifi) cmd_wifi "$@" ;;
  ap) cmd_ap "$@" ;;
  home) cmd_home "$@" ;;
esac

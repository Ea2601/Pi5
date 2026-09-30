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
#   home secret                          kalıcı ev Wi-Fi'ının ağ adı / bant / kanal / parolası (uydulara aktarım; salt okunur)
#   sat on --trial SN --ssid AD [--band bg|a] [--channel N]
#                                        uydu (mesh uydusu): eth0 + Wi-Fi kartı köprüde (br0, adres DHCP'den), ana cihazın
#                                        ev Wi-Fi'ı aynı ağ adı ve parolayla yayınlanır. Parola STDIN'den. SN saniye içinde
#                                        "sat confirm" gelmezse eth0 eski profiline döner
#   sat confirm | rollback | off         uyduyu kalıcı yapar | yalnız deneme sürüyorsa geri alır | kapatır
#   sat apply --ssid AD [--band] [--channel]  uydunun yayın ayarını değiştirir (parola STDIN'den; köprü kesilmez)
#   wan on --trial SN --port KART --type dhcp|static|pppoe [--vlan ID [--prio 0-7]] [--mac MAC] [--mtu N]
#          [--addr IP/ÖNEK --gw IP [--dns IP,IP]] [--user AD] [--dhcp-vendor S] [--dhcp-client-id S] [--dhcp-hostname AD]
#          [--ssid AD]
#                                        KART ev ağı kartıysa (tek port) --vlan zorunlu: internet, VLAN destekli
#                                        anahtardan etiketli gelir, ev ağı aynı porttan etiketsiz akar
#                                        KART Wi-Fi ise --ssid ile üst Wi-Fi'a istemci olarak bağlanır (repeater, ayrı
#                                        ağ; DHCP / sabit, VLAN / PPPoE yok); Wi-Fi parolası STDIN'in ilk satırından
#                                        internet kartı (WAN router rolü, R3): ikinci Ethernet kartı internete bağlanır,
#                                        eth0 / br0 yalnız ev ağı olur (cihaz adresi kalır, modem tarafı adres ve ağ
#                                        geçidi kalkar). PPPoE parolası STDIN'in ilk satırından. SN saniye içinde
#                                        "wan confirm" gelmezse eski (tek kablolu) düzene dönülür
#   wan confirm | rollback | off         kalıcı yapar | yalnız deneme sürüyorsa geri alır | bilerek kapatır (eski düzen)
#   wan fw                               internet kartı güvenlik duvarını yeniden yükler (Ev VPN'i portu değişince)
#   backup on --kind eth|usb|wifi [--type dhcp|static|pppoe] [--port KART] [--vlan ID] [--mtu N]
#             [--addr IP/ÖNEK --gw IP [--dns IP,IP]] [--user AD] [--ssid AD]
#                                        yedek hat (failover): ikinci internet bağlantısı (Ethernet kartı / VLAN, USB 4G
#                                        modem ya da telefon USB paylaşımı, telefon hotspot'u). Hemen sınanır; olmazsa geri
#                                        alınır. PPPoE / hotspot parolası STDIN'in ilk satırından. İzleyici ana hat düşünce
#                                        yedek hatta geçer, ana hat 60 sn sağlam kalınca döner
#   backup off | fw                      yedek hattı kapatır | güvenlik duvarını yeniden yükler
#   backup test [SN]                     geçiş denemesi: SN (varsayılan 60, 0 = bitir) saniye yedek hatta kalınır
#   backup watch                         izleyici (pi5-wan-failover.service)
#   ensure                            güncelleme / açılış: süresi geçen denemeleri geri alır, kalıcı profili ve kalıcı
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
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh sat off    (uydu köprüsünü kapatma)
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh wan off    (internet kartından tek kabloya dönüş)
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh backup off (yedek hattı kapatma)
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
# Uydu (aynı köprü / profil adları; ev Wi-Fi'ıyla birbirini dışlar)
SAT_TIMER_UNIT=pi5-sat-rollback
SAT_RETRY_PREFIX=$SAT_TIMER_UNIT-retry
# İnternet kartı (WAN router, R3)
WAN_PROFILE=pi5-wan
WAN_KEYFILE=/etc/NetworkManager/system-connections/pi5-wan.nmconnection
WAN_VLAN_PROFILE=pi5-wan-vlan
WAN_VLAN_KEYFILE=/etc/NetworkManager/system-connections/pi5-wan-vlan.nmconnection
WAN_PPP_PROFILE=pi5-wan-ppp
WAN_PPP_KEYFILE=/etc/NetworkManager/system-connections/pi5-wan-ppp.nmconnection
WAN_PPP_IF=pppwan
WAN_IDLE_PROFILE=pi5-wan-idle
WAN_IDLE_KEYFILE=/etc/NetworkManager/system-connections/pi5-wan-idle.nmconnection
WAN_BACKUP_DIR=$DIR/wan
WAN_GUARD_STATUS=$DIR/wan-guard.status
WAN_NFT=/etc/nftables.d/pi5-wan.conf
WAN_FW_UNIT=pi5-wan-fw
WAN_TIMER_UNIT=pi5-wan-rollback
WAN_RETRY_PREFIX=$WAN_TIMER_UNIT-retry
WAN_METRIC=50
# Yedek hat (failover): profiller hep bağlı, varsayılan rota metrik 900; geçişte yedek rotanın metrik 10'lu kopyası.
BAK_PROFILE=pi5-bak
BAK_KEYFILE=/etc/NetworkManager/system-connections/pi5-bak.nmconnection
BAK_VLAN_PROFILE=pi5-bak-vlan
BAK_VLAN_KEYFILE=/etc/NetworkManager/system-connections/pi5-bak-vlan.nmconnection
BAK_PPP_PROFILE=pi5-bak-ppp
BAK_PPP_KEYFILE=/etc/NetworkManager/system-connections/pi5-bak-ppp.nmconnection
BAK_PPP_IF=pppbak
BAK_BACKUP_DIR=$DIR/bak
BAK_NFT=/etc/nftables.d/pi5-bak.conf
BAK_FW_UNIT=pi5-bak-fw
BAK_WATCH_UNIT=pi5-wan-failover
BAK_UDEV_RULE=/etc/udev/rules.d/90-pi5-bak.rules
BAK_RUN=/run/pi5-gateway
BAK_STATUS=$BAK_RUN/failover.status
BAK_FORCE=$BAK_RUN/failover.force
BAK_METRIC=900
BAK_ACTIVE_METRIC=10
BAK_GROUP=77
# USB 4G modem (HiLink: cdc_ether / cdc_ncm) ve telefon USB paylaşımı (Android: rndis_host / cdc_ncm, iPhone: ipheth).
BAK_USB_DRIVERS="rndis_host cdc_ether cdc_ncm ipheth"
BAK_TARGETS="1.1.1.1 8.8.8.8 9.9.9.9"
SELF=$(readlink -f "$0")
STATE_KEYS="stage trial_ends iface transit client gw dns old_uuid old_name old_ipv6 wifi_off ap_stage ap_trial_ends ap_iface ap_ssid ap_old_uuid ap_radio_was_off home_stage home_trial_ends home_iface home_ssid home_band home_channel home_radio_was_off lan_if sat_stage sat_trial_ends sat_iface sat_old_uuid sat_old_name sat_wifi sat_ssid sat_band sat_channel sat_radio_was_off sat_backhaul wan_stage wan_trial_ends wan_port wan_dev wan_type wan_vlan wan_prio wan_mac wan_mtu wan_user wan_addr wan_gw wan_dns wan_lan wan_dhcp_vendor wan_dhcp_cid wan_dhcp_host wan_ssid bak_stage bak_kind bak_type bak_port bak_dev bak_vlan bak_mtu bak_user bak_addr bak_gw bak_dns bak_ssid bak_match bak_radio_was_off"

die() { echo "error=$*"; exit 1; }
log() { logger -t pi5-net-mode "$*" 2>/dev/null || true; }
# Çok satırlı komut çıktısını tek satıra indirir (key=value satırı bozulmasın).
oneline() { tr '\n\r\t' '   ' | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//' | cut -c1-300; }
csv() { paste -sd, -; }

# Durum dosyası: key=value satırları; kaynak olarak ÇALIŞTIRILMAZ, yalnız bilinen anahtarlar S_<anahtar>'a okunur.
read_state() {
  local k v line
  for k in $STATE_KEYS; do printf -v "S_$k" '%s' ""; done
  if [ -f "$STATE_FILE" ]; then
    # Satır ilk '=' işaretinden bölünür: IFS='=' read değerin sonundaki tek '='i siler (ör. Wi-Fi ağ adı "Ev=").
    while IFS= read -r line || [ -n "$line" ]; do
      k=${line%%=*}; v=""
      [[ $line == *=* ]] && v=${line#*=}
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
  case "$S_sat_stage" in trial|on) ;; *) S_sat_stage=none ;; esac
  [[ $S_sat_trial_ends =~ ^[0-9]+$ ]] || S_sat_trial_ends=0
  [[ $S_sat_iface =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_sat_iface=""
  [[ $S_sat_wifi =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_sat_wifi=""
  [ "$S_sat_band" = a ] || S_sat_band="bg"
  [[ $S_sat_channel =~ ^[0-9]{1,3}$ ]] || S_sat_channel=""
  [ "$S_sat_radio_was_off" = 1 ] || S_sat_radio_was_off=0
  [ "$S_sat_backhaul" = mesh ] || S_sat_backhaul=wired
  case "$S_wan_stage" in trial|on) ;; *) S_wan_stage=none ;; esac
  [[ $S_wan_trial_ends =~ ^[0-9]+$ ]] || S_wan_trial_ends=0
  # Kart adları nft kuralına ve profil dosyasına girer: biçim dışıysa boş sayılır.
  [[ $S_wan_port =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_wan_port=""
  [[ $S_wan_dev =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_wan_dev=""
  case "$S_wan_type" in dhcp|static|pppoe) ;; *) S_wan_type="" ;; esac
  [[ $S_wan_vlan =~ ^[0-9]{1,4}$ ]] || S_wan_vlan=""
  [[ $S_wan_prio =~ ^[0-7]$ ]] || S_wan_prio=""
  [[ $S_wan_mac =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || S_wan_mac=""
  [[ $S_wan_mtu =~ ^[0-9]{3,4}$ ]] || S_wan_mtu=""
  [ "$S_wan_lan" = 1 ] || S_wan_lan=0
  # DHCP kimlik seçenekleri profil dosyasına yazılır: biçim dışıysa boş sayılır.
  { [[ $S_wan_dhcp_vendor =~ ^[\ -~]{1,64}$ ]] && [[ $S_wan_dhcp_vendor != *\\* ]]; } || S_wan_dhcp_vendor=""
  { [[ $S_wan_dhcp_cid =~ ^[\ -~]{1,64}$ ]] && [[ $S_wan_dhcp_cid != *\\* ]]; } || S_wan_dhcp_cid=""
  [[ $S_wan_dhcp_host =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,62})$ ]] || S_wan_dhcp_host=""
  # Repeater (R4 A): internet kartı Wi-Fi istemci — üst ağın adı (1-32 bayt, denetim karakteri yok).
  { [ "$(printf '%s' "$S_wan_ssid" | wc -c)" -le 32 ] && ! [[ $S_wan_ssid =~ [[:cntrl:]] ]]; } || S_wan_ssid=""
  # Yedek hat: adlar nft kuralına ve profil dosyasına girer; biçim dışıysa boş sayılır.
  [ "$S_bak_stage" = on ] || S_bak_stage=none
  case "$S_bak_kind" in eth|usb|wifi) ;; *) S_bak_kind="" ;; esac
  case "$S_bak_type" in dhcp|static|pppoe) ;; *) S_bak_type="" ;; esac
  [[ $S_bak_port =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_bak_port=""
  [[ $S_bak_dev =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || S_bak_dev=""
  [[ $S_bak_vlan =~ ^[0-9]{1,4}$ ]] || S_bak_vlan=""
  [[ $S_bak_mtu =~ ^[0-9]{3,4}$ ]] || S_bak_mtu=""
  [[ $S_bak_user =~ ^[!-~]{1,64}$ ]] || S_bak_user=""
  [[ $S_bak_addr =~ ^[0-9.]{7,15}/[0-9]{1,2}$ ]] || S_bak_addr=""
  valid_ip "$S_bak_gw" || S_bak_gw=""
  [[ $S_bak_dns =~ ^[0-9.,]{7,47}$ ]] || S_bak_dns=""
  { [ "$(printf '%s' "$S_bak_ssid" | wc -c)" -le 32 ] && ! [[ $S_bak_ssid =~ [[:cntrl:]] ]]; } || S_bak_ssid=""
  [[ $S_bak_match =~ ^[a-z0-9_]+( [a-z0-9_]+)*$ ]] || S_bak_match=""
  [ "$S_bak_radio_was_off" = 1 ] || S_bak_radio_was_off=0
  # Kind yoksa yedek hat yok sayılır (bozuk durum dosyası).
  [ -n "$S_bak_kind" ] || S_bak_stage=none
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
# Uydu alanlarını boşaltır (sat_stage=none, lan_if boş).
sat_reset() {
  S_sat_stage=none; S_sat_trial_ends=0; S_sat_iface=""; S_sat_old_uuid=""; S_sat_old_name=""; S_sat_wifi=""
  S_sat_ssid=""; S_sat_band="bg"; S_sat_channel=""; S_sat_radio_was_off=0; S_sat_backhaul=wired; S_lan_if=""
}
# İnternet kartı alanlarını boşaltır (wan_stage=none, wan_lan=0: ev ağı profilleri tek kollu düzende).
wan_reset() {
  S_wan_stage=none; S_wan_trial_ends=0; S_wan_port=""; S_wan_dev=""; S_wan_type=""; S_wan_vlan=""; S_wan_prio=""
  S_wan_mac=""; S_wan_mtu=""; S_wan_user=""; S_wan_addr=""; S_wan_gw=""; S_wan_dns=""; S_wan_lan=0
  S_wan_dhcp_vendor=""; S_wan_dhcp_cid=""; S_wan_dhcp_host=""; S_wan_ssid=""
}
# Yedek hat alanlarını boşaltır (bak_stage=none).
bak_reset() {
  S_bak_stage=none; S_bak_kind=""; S_bak_type=""; S_bak_port=""; S_bak_dev=""; S_bak_vlan=""; S_bak_mtu=""
  S_bak_user=""; S_bak_addr=""; S_bak_gw=""; S_bak_dns=""; S_bak_ssid=""; S_bak_match=""; S_bak_radio_was_off=0
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
# İnternet kartı denemesinin zamanlayıcıları (ayrı birim adları).
wan_stop_timer() {
  systemctl stop "$WAN_TIMER_UNIT.timer" "$WAN_TIMER_UNIT.service" "$WAN_RETRY_PREFIX-*.timer" "$WAN_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$WAN_TIMER_UNIT.timer" "$WAN_TIMER_UNIT.service" "$WAN_RETRY_PREFIX-*.timer" "$WAN_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
}
wan_retry_active() { systemctl list-units --type=timer --state=active --no-legend "$WAN_RETRY_PREFIX-*" 2>/dev/null | grep -q .; }
wan_timer_active() { systemctl is-active --quiet "$WAN_TIMER_UNIT.timer" 2>/dev/null || wan_retry_active; }
arm_wan_retry() {
  systemd-run --quiet --collect --unit="$WAN_RETRY_PREFIX-$(date +%s)-$$" --on-active="$1" --timer-property=AccuracySec=1s \
    /bin/bash "$SELF" wan rollback >/dev/null 2>&1 9>&-
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
# En düşük metrikli varsayılan rota → "ARAYÜZ AĞ_GEÇİDİ" (wg*/lo/docker*/veth* ve yedek hat arayüzleri hariç: yedek
# hatta geçilmişken de ana hat görülür).
default_route() {
  ip -4 route show default 2>/dev/null | awk -v skip=" $(bak_devs 2>/dev/null | tr '\n' ' ') " '
    { dev = ""; gw = ""; m = 0
      for (i = 1; i < NF; i++) { if ($i == "dev") dev = $(i + 1); else if ($i == "via") gw = $(i + 1); else if ($i == "metric") m = $(i + 1) + 0 }
      if (dev == "" || dev == "lo" || dev ~ /^(wg|docker|veth)/ || index(skip, " " dev " ")) next
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
# Ev ağı tarafının adresleri: internet kartı (WAN router) modunda (wan_lan=1) eth0 / br0 yalnız ev ağıdır — yalnız cihaz
# adresi (client) aranır; değilse iki adres (transit + client). $1 arayüz.
lan_addrs_ok() { if [ "$S_wan_lan" = 1 ]; then addr_static "$1" "$S_client"; else both_addrs "$1" "$S_transit" "$S_client"; fi; }
# $1 arayüz, $2 sn: ev ağı adresleri görünene kadar bekler
wait_lan() {
  local end=$((SECONDS + $2))
  while ! lan_addrs_ok "$1"; do
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
    # ifname: rpt4 netplan profilleri karta bağlı değildir (match: {}) — ikinci bir kart (internet kartı) varken NM
    # profili o karta da bağlayabilirdi.
    if out=$(nmcli -w 30 connection up uuid "$S_old_uuid" ifname "$ifc" 2>&1); then
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
# ve NM arayüzü yeniden yönetir; NM yeniden başlatılırsa koruma önce onarmayı dener. İnternet kartı modunda (wan_lan=1)
# yalnız cihaz adresi kurulur: varsayılan rota internet kartındadır.
emergency() {
  local ifc=$S_iface a
  nmcli device set "$ifc" managed no >/dev/null 2>&1 || true
  ip link set "$ifc" up 2>/dev/null
  for a in $(iface_addrs "$ifc"); do
    [ "$a" = "$S_client" ] && continue
    [ "$S_wan_lan" != 1 ] && [ "$a" = "$S_transit" ] && continue
    ip addr del "$a" dev "$ifc" 2>/dev/null
  done
  if [ "$S_wan_lan" = 1 ]; then ip addr replace "$S_client" brd + dev "$ifc"; return; fi
  ip addr replace "$S_transit" brd + dev "$ifc" \
    && ip addr replace "$S_client" brd + dev "$ifc" \
    && ip route replace default via "$S_gw" dev "$ifc" metric 100
}

# Profil `nmcli connection delete` ile silindiyse NM o UUID için mezar taşı bırakır (<uuid>.nmmeta → /dev/null): aynı
# UUID'li dosya yüklense de gizli kalır (gerçek NM 1.52). $1 profil dosyası: yüklemeden önce mezar taşı kaldırılır.
drop_tombstone() {
  local u
  u=$(sed -n 's/^uuid=//p' "$1" 2>/dev/null | head -1)
  if [[ $u =~ ^[0-9a-f-]{36}$ ]] && [ "$(readlink "$(dirname "$1")/$u.nmmeta" 2>/dev/null)" = /dev/null ]; then
    rm -f "$(dirname "$1")/$u.nmmeta"
  fi
}
# Yedeği profil dosyasının yerine atomik koyar ve yalnız o dosyayı NM'ye yükler (con reload yok). RESTORE_DETAIL.
restore_backup() {
  local tmp out
  tmp="$(dirname "$KEYFILE")/.pi5-eth0.tmp"
  if cp -f "$BACKUP" "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$KEYFILE"; then
    drop_tombstone "$KEYFILE"
    if out=$(nmcli connection load "$KEYFILE" 2>&1); then RESTORE_DETAIL="profil dosyası yedekten geri yüklendi"
    else RESTORE_DETAIL="yedekten geri konan profil yüklenemedi: $(printf '%s' "$out" | oneline)"; fi
  else
    rm -f "$tmp"; RESTORE_DETAIL="profil dosyası yedekten geri konamadı"
  fi
}

# Profili etkinleştirir ve ev ağı adreslerini (bkz. lan_addrs_ok) bekler. 0 = tamam; değilse UP_OUT (tek satır neden).
try_up() {
  local out
  if out=$(nmcli -w 30 connection up id "$PROFILE" 2>&1); then
    wait_lan "$1" 10 && return 0
    if [ "$S_wan_lan" = 1 ]; then UP_OUT="profil etkinleşti ama ev ağı adresi gelmedi"
    else UP_OUT="profil etkinleşti ama iki adres de gelmedi"; fi
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
  if [ "${2:-}" = passive ] && [ "$(dev_state "$ifc")" = 10 ] && lan_addrs_ok "$ifc" \
     && { [ "$S_wan_lan" = 1 ] || ip -4 route show default 2>/dev/null | grep -Eq "via $(rx "$S_gw") dev $ifc( |\$)"; }; then
    echo "guard_result=emergency"
    echo "guard_detail=acil mod sürüyor (adresler elle tutuluyor) — onarım açılışta ya da NetworkManager yeniden başlatılınca denenir"
    return 0
  fi
  # 1. Açılışta NM profili birazdan kendisi etkinleştirir: beklenir.
  end=$((SECONDS + wait))
  while :; do
    if [ "$(active_conn "$ifc")" = "$PROFILE" ] && lan_addrs_ok "$ifc"; then
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
# --- Wi-Fi radyoları ve rolleri (iki radyolu cihaz: dahili + USB, ör. ALFA AWUS036ACM) ---
# Bir radyo aynı anda tek işte kullanılır: kurulum Wi-Fi'ı, ev Wi-Fi'ı / uydu yayını, internet bağlantısı (repeater: üst
# Wi-Fi'a istemci), yedek hat (telefon hotspot'u) ya da kablosuz mesh. Tek radyoda eski davranış: ilk kart.
wifi_devs() { nmcli -t -f DEVICE,TYPE device 2>/dev/null | awk -F: '$2 == "wifi" { print $1 }'; }
phy_of() { basename "$(readlink "/sys/class/net/$1/phy80211" 2>/dev/null)" 2>/dev/null; }
# İnternet kartı Wi-Fi istemci mi (repeater, R4 A).
wan_wifi() { [ -n "${S_wan_ssid:-}" ]; }
# $1 kart → onu kullanan rolün adı (boş: boşta). $2 = soran rol (ap | home | sat | wan | bak | mesh): kendisi sayılmaz.
radio_user() {
  local d=$1 me=${2:-} mphy
  [ -n "$d" ] || return 0
  if [ "$me" != ap ] && [ "$S_ap_stage" != none ] && [ "$S_ap_iface" = "$d" ]; then echo "kurulum Wi-Fi'ı"; return 0; fi
  if [ "$me" != home ] && [ "$S_home_stage" != none ] && [ "$S_home_iface" = "$d" ]; then echo "ev Wi-Fi'ı"; return 0; fi
  if [ "$me" != sat ] && [ "$S_sat_stage" != none ] && [ "$S_sat_wifi" = "$d" ]; then echo "uydu yayını"; return 0; fi
  if [ "$me" != wan ] && [ "$S_wan_stage" != none ] && wan_wifi && [ "$S_wan_port" = "$d" ]; then echo "internet bağlantısı (repeater)"; return 0; fi
  if [ "$me" != bak ] && [ "$S_bak_stage" != none ] && [ "$S_bak_kind" = wifi ] && [ "$S_bak_port" = "$d" ]; then echo "yedek hat (hotspot)"; return 0; fi
  mphy=$(sed -n 's/^phy=//p' /etc/pi5-gateway/mesh/mesh.conf 2>/dev/null | head -1)
  if [ "$me" != mesh ] && [ -n "$mphy" ] && [ "$(phy_of "$d")" = "$mphy" ]; then echo "kablosuz mesh"; return 0; fi
  return 0
}
# İlk boştaki Wi-Fi kartı ($1 = soran rol; $2 = ap: erişim noktası kipini desteklemeli). Yoksa 1.
wifi_dev_free() {
  local d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ -z "$(radio_user "$d" "$1")" ] || continue
    if [ "${2:-}" = ap ] && ! ap_capable "$d"; then continue; fi
    echo "$d"; return 0
  done < <(wifi_devs)
  return 1
}
# Hiçbir rolde olmayan Wi-Fi kartlarında etkin profil varsa bağlantı kesilir: radyo repeater / hotspot için açıkken Pi'nin
# eski Wi-Fi istemci profili (ör. netplan-wlan0-…) ev modemine bağlanıp ikinci bir bacak açmasın (Faz 2: Pi DHCP'si
# açıkken Pi'nin Wi-Fi'si modeme bağlanmaz). Yalnız internet kartı ya da yedek hat Wi-Fi iken çağrılır.
wifi_idle_quiet() {
  local d ac
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ -z "$(radio_user "$d")" ] || continue
    ac=$(active_conn "$d")
    [ -n "$ac" ] || continue
    nmcli device disconnect "$d" >/dev/null 2>&1 && log "Wi-Fi: boştaki $d üzerindeki bağlantı ($ac) kesildi"
  done < <(wifi_devs)
  return 0
}
# Kart seçilemediğinde neden: boştaki kartın adı biçim dışı ya da kart erişim noktası kipini desteklemiyor; yoksa ilk
# kartı kim kullanıyor.
wifi_busy_why() {
  local d u first=""
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    u=$(radio_user "$d" "$1")
    if [ -z "$u" ]; then
      if [[ $d =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then echo "Wi-Fi kartı ($d) erişim noktası (AP) kipini desteklemiyor"
      else echo "Wi-Fi kartının adı beklenmedik: $d"; fi
      return 0
    fi
    [ -n "$first" ] || first="Wi-Fi kartı ($d) şu an $u için kullanılıyor — ikinci bir Wi-Fi kartı takın ya da o işi kapatın"
  done < <(wifi_devs)
  [ -n "$first" ] || first="Pi'de Wi-Fi kartı bulunamadı"
  echo "$first"
}
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
# Köprü yerinde: pi5-br0 br0'da etkin, ev ağı adresleri br0'da, eth0 pi5-br0-eth ile köprünün portu.
br_up_ok() {
  [ "$(active_conn "$BR_IF")" = "$BR_PROFILE" ] && lan_addrs_ok "$BR_IF" \
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
# Köprü profilinin [ipv4] bölümü: tek kollu düzende iki adres + modem ağ geçidi; internet kartı (WAN router) modunda
# yalnız cihaz adresi — varsayılan rota internet kartındadır (bkz. lan_profiles_set).
br_ipv4_section() {
  if [ "$S_wan_lan" = 1 ]; then
    printf 'method=manual\naddress1=%s\ndns=127.0.0.1;\nnever-default=true\nroute-metric=100' "$S_client"
  else
    printf 'method=manual\naddress1=%s\naddress2=%s\ngateway=%s\ndns=127.0.0.1;%s;\nroute-metric=100' \
      "$S_transit" "$S_client" "$S_gw" "$S_gw"
  fi
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
$(br_ipv4_section)

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
  if [ "$(active_conn "$ifc")" = "$PROFILE" ] && lan_addrs_ok "$ifc"; then return 0; fi
  if out=$(nmcli -w 30 connection up id "$PROFILE" 2>&1) && wait_lan "$ifc" 10; then return 0; fi
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
# Ev Wi-Fi'ı yayında değilse başlatır (Wi-Fi kapatılmışsa açılır). 0 = yayında; değilse HOME_AP_OUT. $1 = kart (uydu;
# verilmezse ev Wi-Fi'ının kartı).
home_ap_repair() {
  local wifi=${1:-$S_home_iface} out
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
  if [ "${2:-}" = passive ] && [ "$(dev_state "$ifc")" = 10 ] && lan_addrs_ok "$ifc"; then
    echo "guard_result=emergency"
    echo "guard_detail=acil mod sürüyor (adresler elle tutuluyor) — onarım açılışta ya da NetworkManager yeniden başlatılınca denenir"
    return 0
  fi
  if [ "${2:-}" = passive ] && ! br_up_ok && [ "$(active_conn "$ifc")" = "$PROFILE" ] && lan_addrs_ok "$ifc"; then
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

# --- Uydu (mesh uydusu, R2): ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle yayınlar ---
# Uydu ev ağının bir istemcisidir: adresini DHCP'den alır (sabit adres yok). Köprü br0 = eth0 (kablolu bağlantı) + Wi-Fi
# kartı (erişim noktası); kablosuz mesh bağlantısı (mesh.sh, mesh0) varsa o da bu köprüye eklenir. Profil adları ev
# Wi-Fi'ıyla aynıdır (pi5-br0 / pi5-br0-eth / pi5-home): uydu ile sabit adres / ev Wi-Fi'ı / kurulum Wi-Fi'ı birbirini
# dışlar. Köprüde STP açık (iletim gecikmesi 4 sn): kablo ve mesh aynı anda bağlıyken döngü kurulmasın.
# Açma denemedir: backend ana cihaza köprü üzerinden ulaşınca "sat confirm" der; demezse eski DHCP profiline dönülür.
# Köprü kurulamaz / IPv4 almazsa: eth0'ın eski profili (netplan-eth0; hiç değiştirilmez).
SAT_FWD_DELAY=4
# Köprü yerinde: pi5-br0 br0'da etkin ve br0'da IPv4 var; eth0 varsa pi5-br0-eth ile köprünün portu.
sat_br_ok() {
  [ "$(active_conn "$BR_IF")" = "$BR_PROFILE" ] && [ -n "$(iface_addrs "$BR_IF")" ] || return 1
  [ -z "$S_sat_iface" ] && return 0
  [ "$(active_conn "$S_sat_iface")" = "$PORT_PROFILE" ] && br_port "$S_sat_iface"
}
wait_sat_br() {
  local end=$((SECONDS + $1))
  while ! sat_br_ok; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
sat_stop_timer() {
  systemctl stop "$SAT_TIMER_UNIT.timer" "$SAT_TIMER_UNIT.service" "$SAT_RETRY_PREFIX-*.timer" "$SAT_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$SAT_TIMER_UNIT.timer" "$SAT_TIMER_UNIT.service" "$SAT_RETRY_PREFIX-*.timer" "$SAT_RETRY_PREFIX-*.service" >/dev/null 2>&1 || true
}
sat_retry_active() { systemctl list-units --type=timer --state=active --no-legend "$SAT_RETRY_PREFIX-*" 2>/dev/null | grep -q .; }
sat_timer_active() { systemctl is-active --quiet "$SAT_TIMER_UNIT.timer" 2>/dev/null || sat_retry_active; }
arm_sat_retry() {
  systemd-run --quiet --collect --unit="$SAT_RETRY_PREFIX-$(date +%s)-$$" --on-active="$1" --timer-property=AccuracySec=1s \
    /bin/bash "$SELF" sat rollback >/dev/null 2>&1 9>&-
}
# Uydu köprüsünün varsayılan rotasının ağ geçidi (DHCP'den).
sat_gw() { ip -4 route show default dev "$BR_IF" 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }'; }
# $1 kart, $2 ağ adı, $3 parola, $4 bant, $5 kanal, $6 eth MAC (boş: eth yok), $7 IPv6 yöntemi, $8 DHCP istemci kimliği,
# $9 true|false (kendiliğinden bağlanma). Erişim noktası profili ev Wi-Fi'ıyla aynı biçimde.
sat_write_keyfiles() {
  local u1 u2 u3 cid=""
  u1=$(new_uuid) && u2=$(new_uuid) && u3=$(new_uuid) || return 1
  [ -n "$8" ] && cid="dhcp-client-id=$8"
  home_put_keyfile "$BR_KEYFILE" "[connection]
id=$BR_PROFILE
uuid=$u1
type=bridge
interface-name=$BR_IF
autoconnect=$9
autoconnect-priority=250
${6:+
[ethernet]
cloned-mac-address=$6
}
[bridge]
stp=true
forward-delay=$SAT_FWD_DELAY

[ipv4]
method=auto
$cid

[ipv6]
method=$7" || return 1
  if [ -n "$S_sat_iface" ]; then
    home_put_keyfile "$PORT_KEYFILE" "[connection]
id=$PORT_PROFILE
uuid=$u2
type=ethernet
interface-name=$S_sat_iface
master=$BR_IF
slave-type=bridge
autoconnect=$9
autoconnect-priority=250

[ethernet]

[bridge-port]" || return 1
  fi
  sat_write_ap_keyfile "$1" "$2" "$3" "$4" "$5" "$9" "$u3"
}
# $1 kart, $2 ağ adı, $3 parola, $4 bant, $5 kanal, $6 autoconnect, $7 uuid
sat_write_ap_keyfile() {
  home_put_keyfile "$HOME_KEYFILE" "[connection]
id=$HOME_PROFILE
uuid=$7
type=wifi
interface-name=$1
master=$BR_IF
slave-type=bridge
autoconnect=$6
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
sat_load_all() {
  local f out
  HOME_LOAD_OUT=""
  for f in "$BR_KEYFILE" "$HOME_KEYFILE" ${S_sat_iface:+"$PORT_KEYFILE"}; do
    out=$(nmcli connection load "$f" 2>&1) || { HOME_LOAD_OUT=$(printf '%s' "$out" | oneline); return 1; }
    [ "$(file_of_name "$(sed -n 's/^id=//p' "$f" | head -1)")" = "$f" ] \
      || { HOME_LOAD_OUT="$(basename "$f") NetworkManager'da görünmüyor"; return 1; }
  done
}
# Uyduyu kaldırır, eth0'ı eski profiline döndürür (deneme geri alma, kapatma, başarısız açma). Wi-Fi önceden kapalıysa
# yeniden kapatılır.
sat_unwind() {
  local ifc=$S_sat_iface out
  if [ "$S_sat_radio_was_off" = 1 ]; then
    nmcli radio wifi off >/dev/null 2>&1 || echo "warning=Pi'nin Wi-Fi'si kapatılamadı — elle kapatın (nmcli radio wifi off)"
  fi
  nmcli connection down id "$HOME_PROFILE" >/dev/null 2>&1 || true
  nmcli connection down id "$BR_PROFILE" >/dev/null 2>&1 || true
  home_delete_all
  br_link_remove
  rm -f "$BR_BACKUP" "$PORT_BACKUP" "$HOME_BACKUP"
  [ -n "$ifc" ] || return 0
  if [ "$(dev_state "$ifc")" = 10 ]; then nmcli device set "$ifc" managed yes >/dev/null 2>&1; sleep 1; fi
  if uuid_exists "$S_sat_old_uuid"; then
    if [ "$(active_uuid "$ifc")" = "$S_sat_old_uuid" ] && [ -n "$(iface_addrs "$ifc")" ]; then return 0; fi
    if out=$(nmcli -w 30 connection up uuid "$S_sat_old_uuid" 2>&1) && wait_ipv4 "$ifc" 20; then return 0; fi
    echo "warning=eski profil (${S_sat_old_name:-$S_sat_old_uuid}) adres alamadı: $(printf '%s' "${out:-IPv4 gelmedi}" | oneline)"
    return 0
  fi
  # Eski profil yok (silinmiş): NM'nin kendiliğinden bağlanması beklenir; olmazsa geçici DHCP profili.
  wait_ipv4 "$ifc" 15 && return 0
  delete_named "$FALLBACK"
  nmcli connection add type ethernet con-name "$FALLBACK" ifname "$ifc" ipv4.method auto connection.autoconnect yes >/dev/null 2>&1 \
    && nmcli -w 30 connection up id "$FALLBACK" >/dev/null 2>&1 && wait_ipv4 "$ifc" 20 && return 0
  echo "warning=$ifc adres alamadı — modemin / ana cihazın DHCP'si açık mı?"
  return 0
}
sat_finish_none() {
  rm -f "$GUARD_STATUS"
  sat_reset
  write_state
}
sat_rollback_trial() {
  systemctl stop "$SAT_TIMER_UNIT.timer" "$SAT_RETRY_PREFIX-*.timer" >/dev/null 2>&1 || true
  sat_unwind
  sat_finish_none
  log "uydu denemesi geri alındı"
  echo "rolled_back=1"
}
sat_trial_check() {
  if [ "$S_sat_trial_ends" -le "$(date +%s)" ] || ! sat_timer_active; then sat_rollback_trial; fi
}
# Kalıcı uyduyu denetler / onarır. Önce erişim: köprü kurulamazsa eth0 eski profiliyle (DHCP) çalışır, yayın yapılmaz.
# $1 = NM'nin köprüyü kendiliğinden kurması için beklenecek süre, $2 = passive (ensure: köprüsüz çalışan uyduya dokunmaz).
sat_guard_routine() {
  local wait=$1 ifc=$S_sat_iface end detail="" out
  if [ -z "$S_sat_wifi" ]; then write_guard error "durum kaydı eksik (sat_wifi, $STATE_FILE)"; return 0; fi
  if [ "${2:-}" = passive ] && ! sat_br_ok && [ -n "$ifc" ] && [ "$(active_uuid "$ifc")" = "$S_sat_old_uuid" ] \
     && [ -n "$(iface_addrs "$ifc")" ]; then
    echo "guard_result=unbridged"
    echo "guard_detail=köprü kurulamamıştı; uydu eski profille (DHCP) çalışıyor, yayın yok — onarım açılışta ya da NetworkManager yeniden başlatılınca denenir"
    return 0
  fi
  end=$((SECONDS + wait))
  while ! sat_br_ok; do
    [ "$SECONDS" -ge "$end" ] && break
    sleep 1
  done
  if ! sat_br_ok; then
    if [ -n "$ifc" ] && [ "$(carrier "$ifc")" != 1 ] && [ "$S_sat_backhaul" != mesh ]; then
      home_ap_repair "$S_sat_wifi" || true
      write_guard no_carrier "kablo bağlantısı yok ($ifc)"; return 0
    fi
    home_restore_backups; detail=$HOME_RESTORE_DETAIL
    if [ -n "$ifc" ]; then out=$(nmcli -w 20 connection up id "$PORT_PROFILE" 2>&1); fi
    wait_sat_br 20 || { nmcli -w 20 connection up id "$BR_PROFILE" >/dev/null 2>&1 && wait_sat_br 15; }
    if sat_br_ok; then
      detail="${detail:+$detail; }köprü yeniden kuruldu"
    else
      detail="${detail:+$detail; }köprü kurulamadı: $(printf '%s' "${out:-köprü IPv4 almadı}" | oneline)"
      nmcli connection down id "$HOME_PROFILE" >/dev/null 2>&1 || true
      nmcli connection down id "$BR_PROFILE" >/dev/null 2>&1 || true
      br_link_remove
      if [ -n "$ifc" ] && uuid_exists "$S_sat_old_uuid" && nmcli -w 30 connection up uuid "$S_sat_old_uuid" >/dev/null 2>&1 \
         && wait_ipv4 "$ifc" 20; then
        write_guard unbridged "$detail — uydu eski profille (DHCP) çalışıyor, bu açılışta yayın yok"
      else
        write_guard failed "$detail — eski profil de adres alamadı"
      fi
      return 0
    fi
  fi
  if home_ap_repair "$S_sat_wifi"; then
    if [ -n "$detail" ]; then write_guard repaired "$detail"; else write_guard ok ""; fi
  else
    write_guard ap_failed "${detail:+$detail; }yayın başlamadı: $HOME_AP_OUT"
  fi
  return 0
}

# --- İnternet kartı (WAN router, R3) ---
# İkinci Ethernet kartı (ör. USB adaptör) internete bağlanır: DHCP (modem arkası), sabit adres ya da PPPoE; her biri
# isteğe bağlı VLAN'lı (operatör etiketi + 802.1p önceliği), MAC kopyalama ve MTU ile. eth0 / br0 yalnız ev ağı olur:
# modem tarafı adres ve ağ geçidi kalkar, cihaz adresi (192.168.0.1) HİÇ kalkmaz → panel her an ev ağından açılır.
# Profiller (yerli keyfile, doğrudan yazılır; PPPoE parolası hiçbir komutun argv'sinde görünmez, 0600):
#   pi5-wan       kartın kendisi: DHCP / sabit adres burada; VLAN ya da PPPoE varsa adressiz (yalnız bağlantı, MAC)
#   pi5-wan-vlan  VLAN arayüzü wan.<ID>: DHCP / sabit adres burada; PPPoE varsa adressiz
#   pi5-wan-ppp   PPPoE (arayüz pppwan); üst arayüz kart ya da VLAN
# Varsayılan rota metriği 50 (ev ağı profilleri 100 idi). IPv6 kapalı: VPS yönlendirme kuralları yalnız IPv4 — IPv6
# trafik tünelleri atlardı. Güvenlik duvarı (inet pi5_wan + ip pi5_wan_nat) bağlantıdan ÖNCE yüklenir: internetten
# gelen her şey düşer (kurulu bağlantıların yanıtları, DHCP yanıtı, Ev VPN'i portu ve port yönlendirmeleri hariç), ev
# ağından çıkan trafik maskelenir, TCP MSS yola göre kırpılır (PPPoE). Herhangi bir tablodaki drop kesindir: başka
# tabloların kart ayrımı yapmayan izinleri internet kartını açamaz. Açılışta pi5-wan-fw.service tabloyu
# NetworkManager'dan ÖNCE yükler (kart bağlanırken korumasız an olmaz).

# Katman-3 arayüzü (adresin ve varsayılan rotanın olduğu arayüz): PPPoE → pppwan, VLAN → wan.<ID>, değilse kartın kendisi.
wan_l3_of() { if [ "$2" = pppoe ]; then echo "$WAN_PPP_IF"; elif [ -n "$3" ]; then echo "wan.$3"; else echo "$1"; fi; }
# Tek port (router on a stick): internet ev ağı kartının üzerindeki VLAN'dan gelir (VLAN destekli yönetilebilir anahtar
# internet trafiğini etiketli getirir, ev ağı aynı porttan etiketsiz akar). Kartın kendisi EV AĞIDIR: ona profil
# yazılmaz, güvenlik duvarına / maskelemeye girmez, park edilmez; MAC kopyalama ve MTU VLAN arayüzüne uygulanır.
wan_single() { [ -n "$S_wan_port" ] && [ "$S_wan_port" = "$S_iface" ]; }
# Bu kurulumun profilleri (etkinleştirme sırası): kart → VLAN → PPPoE (tek portta kart profili yok).
wan_profiles() {
  if ! wan_single; then echo "$WAN_PROFILE"; fi
  if [ -n "$S_wan_vlan" ]; then echo "$WAN_VLAN_PROFILE"; fi
  if [ "$S_wan_type" = pppoe ]; then echo "$WAN_PPP_PROFILE"; fi
}
wan_keyfile_of() {
  case "$1" in
    "$WAN_PROFILE") echo "$WAN_KEYFILE" ;;
    "$WAN_VLAN_PROFILE") echo "$WAN_VLAN_KEYFILE" ;;
    "$WAN_PPP_PROFILE") echo "$WAN_PPP_KEYFILE" ;;
  esac
}
# nft arayüz kümesi: kart + (varsa) VLAN + (varsa) PPPoE — internetten gelen trafik bunların hangisinden gelirse gelsin.
# Tek portta kart ev ağıdır: kümede yalnız VLAN (+ PPPoE).
wan_ifset() {
  local s=""
  if ! wan_single; then s="\"$S_wan_port\""; fi
  if [ -n "$S_wan_vlan" ]; then s="${s:+$s, }\"wan.$S_wan_vlan\""; fi
  if [ "$S_wan_type" = pppoe ]; then s="$s, \"$WAN_PPP_IF\""; fi
  echo "{ $s }"
}
# Ev VPN'inin (wg_pi) dinleme portu; yapılandırma yoksa ya da Ev VPN'i kapalıysa (birim etkin değil, arayüz yok) boş —
# panel Ev VPN'ini kapatınca yapılandırma dosyası kalır.
wg_listen_port() {
  local p
  [ -e /sys/class/net/wg_pi ] || systemctl is-enabled --quiet wg-quick@wg_pi.service 2>/dev/null || return 1
  p=$(sed -n 's/^[[:space:]]*ListenPort[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' /etc/wireguard/wg_pi.conf 2>/dev/null | head -1)
  [[ $p =~ ^[0-9]{1,5}$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ] && echo "$p"
}
# [ipv4] bölümü. $1 = 1: bu profil adresi taşır (katman 3); değilse adressiz. $2 = ppp: PPPoE profili (adres operatörden).
wan_ipv4_section() {
  if [ "$1" != 1 ]; then printf 'method=disabled'; return 0; fi
  if [ "$S_wan_type" = static ] && [ "${2:-}" != ppp ]; then
    printf 'method=manual\naddress1=%s\ngateway=%s\n' "$S_wan_addr" "$S_wan_gw"
    if [ -n "$S_wan_dns" ]; then printf 'dns=%s;\n' "${S_wan_dns//,/;}"; fi
  else
    printf 'method=auto\n'
    # Operatör adres vermek için kimlik istiyorsa (DHCP seçenek 60 / 61 / 12); PPPoE'de kullanılmaz.
    if [ "$S_wan_type" = dhcp ]; then
      if [ -n "$S_wan_dhcp_vendor" ]; then printf 'dhcp-vendor-class-identifier=%s\n' "$S_wan_dhcp_vendor"; fi
      if [ -n "$S_wan_dhcp_cid" ]; then printf 'dhcp-client-id=%s\n' "$S_wan_dhcp_cid"; fi
      if [ -n "$S_wan_dhcp_host" ]; then printf 'dhcp-hostname=%s\ndhcp-send-hostname=true\n' "$S_wan_dhcp_host"; fi
    fi
  fi
  # Operatörün DNS'i Pi'nin kendi DNS'inden (127.0.0.1, Pi-hole) SONRA gelsin: daha yüksek değer = daha düşük öncelik.
  printf 'route-metric=%s\ndns-priority=200\nmay-fail=false' "$WAN_METRIC"
}
# Profil dosyaları (kendiliğinden bağlanma deneme boyunca KAPALI; "wan confirm" açar). $1 = PPPoE parolası.
# PPPoE MTU'su 1492'den büyükse (RFC 4638, "baby jumbo": operatör destekliyorsa 1500) altındaki kart / VLAN arayüzü
# MTU + 8 (PPPoE başlığı) taşımalı.
wan_write_keyfiles() {
  local u1 u2 u3 l3port=1 l3vlan=0 eth="" vlan_eth="" prio="" ppp="" parent i base_mtu=""
  u1=$(new_uuid) && u2=$(new_uuid) && u3=$(new_uuid) || return 1
  if [ -n "$S_wan_vlan" ]; then l3port=0; l3vlan=1; fi
  if [ "$S_wan_type" = pppoe ]; then l3port=0; l3vlan=0; fi
  if [ "$S_wan_type" = pppoe ] && [ -n "$S_wan_mtu" ] && [ "$S_wan_mtu" -gt 1492 ]; then base_mtu=$((S_wan_mtu + 8)); fi
  # Kart: MAC kopyalama + (adres kartta ise) MTU ya da PPPoE için MTU + 8. Tek portta kart ev ağıdır: bunlar VLAN'a gider.
  if [ -n "$S_wan_mac" ]; then eth="cloned-mac-address=$S_wan_mac"; fi
  if [ -n "$S_wan_mtu" ] && [ "$l3port" = 1 ]; then eth="${eth:+$eth
}mtu=$S_wan_mtu"
  elif [ -n "$base_mtu" ]; then eth="${eth:+$eth
}mtu=$base_mtu"; fi
  if wan_single; then
    # Kart ev ağı: MAC kopyalama ve MTU (adres VLAN'da; PPPoE + 1492 üstü MTU tek portta reddedilir) VLAN arayüzüne.
    if [ -n "$S_wan_mac" ]; then vlan_eth="cloned-mac-address=$S_wan_mac"; fi
    if [ -n "$S_wan_mtu" ] && [ "$l3vlan" = 1 ]; then vlan_eth="${vlan_eth:+$vlan_eth
}mtu=$S_wan_mtu"; fi
  elif wan_wifi; then
    # Repeater (R4 A): kart üst Wi-Fi'a istemci olarak bağlanır; MAC kopyalama ve MTU [wifi] bölümünde. Ağ adı bayt
    # listesi (Türkçe harf / noktalı virgül olabilir), parola yalnız bu 0600 dosyada.
    home_put_keyfile "$WAN_KEYFILE" "[connection]
id=$WAN_PROFILE
uuid=$u1
type=wifi
interface-name=$S_wan_port
autoconnect=false
autoconnect-priority=200
autoconnect-retries=0

[wifi]
mode=infrastructure
ssid=$(ssid_bytes "$S_wan_ssid")
$eth

[wifi-security]
key-mgmt=wpa-psk
psk=$1

[ipv4]
$(wan_ipv4_section 1)

[ipv6]
method=disabled" || return 1
  else
    home_put_keyfile "$WAN_KEYFILE" "[connection]
id=$WAN_PROFILE
uuid=$u1
type=ethernet
interface-name=$S_wan_port
autoconnect=false
autoconnect-priority=200
autoconnect-retries=0

[ethernet]
$eth

[ipv4]
$(wan_ipv4_section "$l3port")

[ipv6]
method=disabled" || return 1
    # VLAN arayüzü: adres VLAN'daysa MTU, PPPoE MTU + 8 ise o (kartınki ayrı yazıldı).
    if [ -n "$S_wan_mtu" ] && [ "$l3vlan" = 1 ]; then vlan_eth="mtu=$S_wan_mtu"
    elif [ -n "$base_mtu" ]; then vlan_eth="mtu=$base_mtu"; fi
  fi
  if [ -n "$S_wan_vlan" ]; then
    # 802.1p: tüm çıkış trafiği (çekirdek önceliği 0-7) operatörün istediği önceliğe eşlenir.
    if [ -n "$S_wan_prio" ]; then
      # keyfile liste biçimi: "0:5;1:5;..." (nmcli'deki virgül değil)
      prio="egress-priority-map="
      for i in 0 1 2 3 4 5 6 7; do prio="$prio$i:$S_wan_prio;"; done
    fi
    home_put_keyfile "$WAN_VLAN_KEYFILE" "[connection]
id=$WAN_VLAN_PROFILE
uuid=$u2
type=vlan
interface-name=wan.$S_wan_vlan
autoconnect=false
autoconnect-priority=200
autoconnect-retries=0

[ethernet]
$vlan_eth

[vlan]
parent=$S_wan_port
id=$S_wan_vlan
$prio

[ipv4]
$(wan_ipv4_section "$l3vlan")

[ipv6]
method=disabled" || return 1
  fi
  if [ "$S_wan_type" = pppoe ]; then
    parent=$S_wan_port
    if [ -n "$S_wan_vlan" ]; then parent="wan.$S_wan_vlan"; fi
    if [ -n "$S_wan_mtu" ]; then ppp="mtu=$S_wan_mtu
mru=$S_wan_mtu"; fi
    home_put_keyfile "$WAN_PPP_KEYFILE" "[connection]
id=$WAN_PPP_PROFILE
uuid=$u3
type=pppoe
interface-name=$WAN_PPP_IF
autoconnect=false
autoconnect-priority=200
autoconnect-retries=0

[pppoe]
parent=$parent
username=$S_wan_user
password=$1

[ppp]
$ppp

[ipv4]
$(wan_ipv4_section 1 ppp)

[ipv6]
method=disabled" || return 1
  fi
}
# Profiller NM'ye beklenen dosyalardan yüklenmiş.
wan_loaded() {
  local p f
  for p in $(wan_profiles); do
    f=$(wan_keyfile_of "$p")
    [ -s "$f" ] && [ "$(file_of_name "$p")" = "$f" ] || return 1
  done
}
# Yalnız bu kurulumun dosyaları yüklenir (con reload yok). Hata → 1, neden WAN_LOAD_OUT'ta.
wan_load_all() {
  local p f out
  WAN_LOAD_OUT=""
  for p in $(wan_profiles); do
    f=$(wan_keyfile_of "$p")
    out=$(nmcli connection load "$f" 2>&1) || { WAN_LOAD_OUT="$p: $(printf '%s' "$out" | oneline)"; return 1; }
  done
  wan_loaded || { WAN_LOAD_OUT="profiller NetworkManager'da beklenen dosyalardan görünmüyor (dosya reddedilmiş olabilir)"; return 1; }
}
# Üç profili (tüm kopyaları) ve dosyalarını kaldırır; durum dosyasına dokunmaz.
wan_delete_all() {
  local f
  delete_named "$WAN_PPP_PROFILE"; delete_named "$WAN_VLAN_PROFILE"; delete_named "$WAN_PROFILE"
  for f in "$WAN_PPP_KEYFILE" "$WAN_VLAN_KEYFILE" "$WAN_KEYFILE"; do rm -f "$f" "$(dirname "$f")/.$(basename "$f").tmp"; done
}
# Profilleri sırayla etkinleştirir (kart → VLAN → PPPoE). Hata → 1, neden WAN_UP_OUT'ta.
wan_up() {
  local p out w
  WAN_UP_OUT=""
  for p in $(wan_profiles); do
    w=30; [ "$p" = "$WAN_PPP_PROFILE" ] && w=60; wan_wifi && w=45
    if ! out=$(nmcli -w "$w" connection up id "$p" 2>&1); then
      WAN_UP_OUT="$p etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
      # Senaryoya göre anlaşılır neden: adres profili DHCP yanıtı alamadı / PPPoE oturumu açılamadı / üst Wi-Fi'a bağlanılamadı.
      if wan_wifi; then
        WAN_UP_OUT="üst Wi-Fi'a ($S_wan_ssid) bağlanılamadı — ağ adı ve parola doğru mu, Pi sinyal alıyor mu ($WAN_UP_OUT)"
      elif [ "$p" = "$WAN_PPP_PROFILE" ]; then
        WAN_UP_OUT="PPPoE oturumu açılamadı — kullanıcı adı / şifre, VLAN numarası ya da operatörün PPPoE sunucusu ($WAN_UP_OUT)"
      elif [ "$S_wan_type" = dhcp ] && [[ $out == *Timeout* || $out == *"IP configuration"* ]]; then
        WAN_UP_OUT="operatörden adres gelmedi (DHCP yanıtı yok) — VLAN numarasını, DHCP kimlik seçeneklerini ve kabloyu kontrol edin ($WAN_UP_OUT)"
      fi
      return 1
    fi
  done
}
# İnternet kartının IPv4 adresi (ip/önek). PPPoE'de "adres peer karşı/32" → adres/32.
wan_ip() {
  [ -n "$S_wan_dev" ] || return 0
  ip -4 -o addr show dev "$S_wan_dev" 2>/dev/null | awk '{ if ($5 == "peer") print $4 "/32"; else print $4; exit }' | head -1
}
# İnternet kartının ağ geçidi (DHCP / sabit: varsayılan rotanın "via"sı; PPPoE: karşı uç).
wan_gateway() {
  local g
  [ -n "$S_wan_dev" ] || return 0
  g=$(ip -4 route show default dev "$S_wan_dev" 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }')
  [ -n "$g" ] || g=$(ip -4 -o addr show dev "$S_wan_dev" 2>/dev/null | awk '$5 == "peer" { sub(/\/.*/, "", $6); print $6; exit }')
  echo "$g"
}
# Bağlı: kartta bu kurulumun profili etkin, adres var ve varsayılan rota bu arayüzde. Kartı başka bir profil almışsa
# (ör. karta bağlı olmayan eski netplan profili, pi5-wan silindiğinde) bağlı sayılmaz — koruma yedekten onarır.
wan_up_ok() {
  if wan_single; then
    # Tek port: kart ev ağı profilindedir; bu kurulumun temel profili VLAN'dır.
    [ "$(active_conn "wan.$S_wan_vlan")" = "$WAN_VLAN_PROFILE" ] || return 1
  else
    [ "$(active_conn "$S_wan_port")" = "$WAN_PROFILE" ] || return 1
  fi
  [ -n "$(wan_ip)" ] && ip -4 route show default dev "$S_wan_dev" 2>/dev/null | grep -q .
}
wait_wan_ip() {
  local end=$((SECONDS + $1))
  while ! wan_up_ok; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# İnternet: internet kartına bağlı ping (SO_BINDTODEVICE: VPS yönlendirme kuralları araya girmez), olmazsa TCP 443.
wan_internet_ok() {
  local t
  for t in 1.1.1.1 8.8.8.8 9.9.9.9; do ping -c1 -W3 -I "$S_wan_dev" "$t" >/dev/null 2>&1 && return 0; done
  timeout 6 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' >/dev/null 2>&1
}
# Ev ağı arayüzü: ev Wi-Fi'ı açıkken köprü, değilse kart.
lan_dev() { if [ "$S_home_stage" != none ] && [ -e "/sys/class/net/$BR_IF" ]; then echo "$BR_IF"; else echo "$S_iface"; fi; }

# pi5_wan + pi5_wan_nat tabloları (boş-tanımla → sil → yeniden-tanımla: her yüklemede idempotent). Hata → 1, WAN_NFT_OUT.
wan_nft_load() {
  local ifs dhcp="" wgr="" wg out
  WAN_NFT_OUT=""
  command -v nft >/dev/null 2>&1 || { WAN_NFT_OUT="nft bulunamadı"; return 1; }
  [ -n "$S_wan_port" ] || { WAN_NFT_OUT="internet kartı kaydı yok"; return 1; }
  ifs=$(wan_ifset)
  if [ "$S_wan_type" != pppoe ]; then dhcp="        iifname $ifs udp sport 67 udp dport 68 accept"; fi
  if wg=$(wg_listen_port); then wgr="        iifname $ifs udp dport $wg accept"; fi
  mkdir -p "$(dirname "$WAN_NFT")" 2>/dev/null
  if ! printf '%s\n' "table inet pi5_wan {}
delete table inet pi5_wan
table inet pi5_wan {
    chain input {
        type filter hook input priority -10; policy accept;
        iifname $ifs ct state established,related accept
$dhcp
$wgr
        iifname $ifs drop
    }
    chain forward {
        type filter hook forward priority -10; policy accept;
        iifname $ifs tcp flags syn tcp option maxseg size set rt mtu
        oifname $ifs tcp flags syn tcp option maxseg size set rt mtu
        iifname $ifs ct state established,related accept
        iifname $ifs ct status dnat accept
        iifname $ifs drop
    }
}
table ip pi5_wan_nat {}
delete table ip pi5_wan_nat
table ip pi5_wan_nat {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        oifname $ifs masquerade
    }
}" > "$WAN_NFT.tmp" || ! mv -f "$WAN_NFT.tmp" "$WAN_NFT"; then
    rm -f "$WAN_NFT.tmp"; WAN_NFT_OUT="$WAN_NFT yazılamadı"; return 1
  fi
  out=$(nft -f "$WAN_NFT" 2>&1) || { WAN_NFT_OUT=$(printf '%s' "$out" | oneline); return 1; }
  return 0
}
# Tabloları kaldırır: dosyaya önce yalnız silen biçim yazılıp yüklenir (bkz. ap_nft_remove), sonra dosya silinir.
wan_nft_remove() {
  local del out rc=0
  del=$'table inet pi5_wan {}\ndelete table inet pi5_wan\ntable ip pi5_wan_nat {}\ndelete table ip pi5_wan_nat'
  if command -v nft >/dev/null 2>&1; then
    if [ -d "$(dirname "$WAN_NFT")" ] && printf '%s\n' "$del" > "$WAN_NFT.tmp" && mv -f "$WAN_NFT.tmp" "$WAN_NFT"; then
      out=$(nft -f "$WAN_NFT" 2>&1) || rc=1
    else
      out=$(printf '%s\n' "$del" | nft -f - 2>&1) || rc=1
    fi
    [ "$rc" = 0 ] || echo "warning=internet kartı güvenlik duvarı tabloları kaldırılamadı: $(printf '%s' "$out" | oneline)"
  fi
  rm -f "$WAN_NFT" "$WAN_NFT.tmp"
}
wan_nft_loaded() { nft list table inet pi5_wan >/dev/null 2>&1 && nft list table ip pi5_wan_nat >/dev/null 2>&1; }
# Açılışta tabloyu NetworkManager'dan ÖNCE yükleyen birim (nftables.service'in "flush ruleset"inden sonra).
wan_fw_unit_install() {
  local u="/etc/systemd/system/$WAN_FW_UNIT.service" nftb
  nftb=$(command -v nft) || return 1
  printf '%s\n' "[Unit]
Description=Klyrix Gate: internet kartı güvenlik duvarı (NetworkManager'dan önce)
DefaultDependencies=no
After=local-fs.target nftables.service
Before=network-pre.target NetworkManager.service shutdown.target
Wants=network-pre.target
Conflicts=shutdown.target
ConditionPathExists=$WAN_NFT

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$nftb -f $WAN_NFT

[Install]
WantedBy=multi-user.target NetworkManager.service" > "$u.tmp" && mv -f "$u.tmp" "$u" || { rm -f "$u.tmp"; return 1; }
  systemctl daemon-reload >/dev/null 2>&1
  systemctl enable "$WAN_FW_UNIT.service" >/dev/null 2>&1
}
wan_fw_unit_remove() {
  local u="/etc/systemd/system/$WAN_FW_UNIT.service"
  [ -e "$u" ] || return 0
  systemctl disable "$WAN_FW_UNIT.service" >/dev/null 2>&1 || true
  rm -f "$u"
  systemctl daemon-reload >/dev/null 2>&1 || true
}

# eth0 / br0 profillerini internet kartı moduna (lanonly: yalnız cihaz adresi, varsayılan rota yok) ya da tek kollu
# düzene (onearm: modem tarafı adres + cihaz adresi + modem ağ geçidi) çevirir. Etkin olana bağlantı kesilmeden
# uygulanır (nmcli device reapply; olmazsa profil yeniden etkinleştirilir). Hata → 1, neden LAN_SET_OUT'ta.
lan_profiles_set() {
  local p u dev ac out
  LAN_SET_OUT=""
  for p in "$PROFILE" "$BR_PROFILE"; do
    for u in $(uuids_named "$p"); do
      # Metrik 100: sabit adres (static) ve köprü (home) profilleriyle aynı — köprü profili WAN modunda yazıldıysa
      # metriksiz olabilir (NM köprü varsayılanı 425).
      if [ "$1" = lanonly ]; then
        out=$(nmcli connection modify uuid "$u" ipv4.addresses "$S_client" ipv4.gateway "" ipv4.never-default yes \
              ipv4.dns 127.0.0.1 ipv4.route-metric 100 2>&1)
      else
        out=$(nmcli connection modify uuid "$u" ipv4.addresses "$S_transit,$S_client" ipv4.gateway "$S_gw" \
              ipv4.never-default no ipv4.dns "127.0.0.1,$S_gw" ipv4.route-metric 100 2>&1)
      fi || { LAN_SET_OUT="$p: $(printf '%s' "$out" | oneline)"; return 1; }
    done
  done
  for dev in "$BR_IF" "$S_iface"; do
    [ -e "/sys/class/net/$dev" ] || continue
    ac=$(active_conn "$dev")
    case "$ac" in
      "$PROFILE"|"$BR_PROFILE")
        if ! nmcli device reapply "$dev" >/dev/null 2>&1; then
          out=$(nmcli -w 30 connection up id "$ac" 2>&1) \
            || { LAN_SET_OUT="$ac uygulanamadı: $(printf '%s' "$out" | oneline)"; return 1; }
        fi ;;
    esac
  done
  if [ "$1" = lanonly ]; then S_dns="127.0.0.1"; else S_dns="127.0.0.1,$S_gw"; fi
  return 0
}
# WAN modundaki ev ağı profil dosyası: yalnız cihaz adresi, varsayılan rota yok. $1 dosya.
verify_lan_only() {
  [ -s "$1" ] && grep -Eq "^address1=$(rx "$S_client")\$" "$1" && ! grep -q '^address2=' "$1" \
    && grep -q '^never-default=true$' "$1" && ! grep -q '^gateway=' "$1"
}
# Ev ağı profillerinin yedekleri (açılış koruması bunlardan onarır) şu anki dosyalardan yenilenir — dosya beklenen
# düzendeyse. $1 = lanonly | onearm.
lan_backups_refresh() {
  if [ "$1" = lanonly ]; then verify_lan_only "$KEYFILE" || return 1
  else verify_keyfile "$S_transit" "$S_client" "$S_gw" >/dev/null || return 1; fi
  { cp -f "$KEYFILE" "$BACKUP" && chmod 600 "$BACKUP"; } || return 1
  if [ "$S_home_stage" = on ] && [ -s "$BR_KEYFILE" ]; then
    { cp -f "$BR_KEYFILE" "$BR_BACKUP" && chmod 600 "$BR_BACKUP"; } || return 1
  fi
  return 0
}

# Kart adressiz bir profille "park" edilir (internet kartı kapatılınca): Raspberry Pi'nin NM yaması netplan profillerini
# karta bağlamadan (match: {}) yeniden yazar — eski otomatik adresli profil açılışta boştaki bu kartı DHCP ile bağlayıp
# ikinci bir varsayılan rota açmasın. Öncelik 200 > netplan profilleri (0). Kart çıkarılırsa profil bekler.
wan_park_port() {
  local u
  [ -n "$S_wan_port" ] || return 1
  # Tek portta kart ev ağıdır: park edilirse (adressiz, öncelik 200) açılışta ev ağı profilinin yerini alırdı.
  wan_single && return 0
  # Wi-Fi kartı park edilmez (Ethernet park profili Wi-Fi'da geçmez): bağlantısı kesilir (wan_unwind).
  wan_wifi && return 1
  u=$(new_uuid) || return 1
  delete_named "$WAN_IDLE_PROFILE"
  home_put_keyfile "$WAN_IDLE_KEYFILE" "[connection]
id=$WAN_IDLE_PROFILE
uuid=$u
type=ethernet
interface-name=$S_wan_port
autoconnect-priority=200

[ethernet]

[ipv4]
method=disabled

[ipv6]
method=disabled" || return 1
  nmcli connection load "$WAN_IDLE_KEYFILE" >/dev/null 2>&1 || return 1
  if [ -e "/sys/class/net/$S_wan_port" ]; then nmcli -w 10 connection up id "$WAN_IDLE_PROFILE" >/dev/null 2>&1 || true; fi
  return 0
}
wan_unpark() { delete_named "$WAN_IDLE_PROFILE"; rm -f "$WAN_IDLE_KEYFILE" "$(dirname "$WAN_IDLE_KEYFILE")/.$(basename "$WAN_IDLE_KEYFILE").tmp"; }
# İnternet kartını kaldırıp eski (tek kollu) düzene döner (deneme geri alma, kapatma, başarısız açma): önce ev ağı
# profillerine modem tarafı adres ve ağ geçidi geri verilir (varsayılan rota hazır olur), sonra internet kartı iner;
# kart NM'nin otomatik DHCP'sine düşmesin diye bağlantısı kesilir.
wan_unwind() {
  local lan
  if [ "$S_wan_lan" = 1 ]; then
    if lan_profiles_set onearm; then S_wan_lan=0
    else echo "warning=ev ağı profili eski düzene çevrilemedi: $LAN_SET_OUT — koruma onarıyor"; S_wan_lan=0; fi
    write_state
  fi
  nmcli connection down id "$WAN_PPP_PROFILE" >/dev/null 2>&1 || true
  nmcli connection down id "$WAN_VLAN_PROFILE" >/dev/null 2>&1 || true
  nmcli connection down id "$WAN_PROFILE" >/dev/null 2>&1 || true
  wan_delete_all
  if [ -n "$S_wan_vlan" ] && [ -e "/sys/class/net/wan.$S_wan_vlan" ]; then ip link delete "wan.$S_wan_vlan" 2>/dev/null || true; fi
  # Tek portta kart ev ağıdır: park edilmez, bağlantısı kesilmez (wan_park_port hemen döner).
  if ! wan_park_port && ! wan_single && [ -n "$S_wan_port" ] && [ -e "/sys/class/net/$S_wan_port" ]; then
    nmcli device disconnect "$S_wan_port" >/dev/null 2>&1 || true
  fi
  # Repeater: Wi-Fi sabit adres kurulumunda kapatılmışsa (Faz 2) ve başka hiçbir iş Wi-Fi kullanmıyorsa yeniden kapatılır.
  if wan_wifi && [ "$S_wifi_off" = 1 ] && [ "$S_ap_stage" = none ] && [ "$S_home_stage" = none ] && [ "$S_sat_stage" = none ] \
     && ! { [ "$S_bak_stage" != none ] && [ "$S_bak_kind" = wifi ]; } && [ ! -s /etc/pi5-gateway/mesh/mesh.conf ]; then
    nmcli radio wifi off >/dev/null 2>&1 || true
  fi
  wan_nft_remove
  wan_fw_unit_remove
  lan=$(lan_dev)
  if [ -n "$lan" ] && ! wait_lan "$lan" 15; then
    echo "warning=ev ağı adresleri ($lan) eski düzende görünmüyor — koruma onarıyor"
    if [ "$lan" = "$BR_IF" ]; then home_guard_routine 0 >/dev/null; else guard_routine 0 >/dev/null; fi
  fi
  return 0
}
# Yedekleri ve koruma sonucunu kaldırır, wan_stage=none yazar.
wan_finish_none() {
  rm -rf "$WAN_BACKUP_DIR"
  rm -f "$WAN_GUARD_STATUS"
  wan_reset
  write_state
}
# Deneme sürerken geri alma (zamanlayıcı / ensure / panel / terminal): yalnız .timer durdurulur (bkz. stop_timer).
wan_rollback_trial() {
  systemctl stop "$WAN_TIMER_UNIT.timer" "$WAN_RETRY_PREFIX-*.timer" >/dev/null 2>&1 || true
  wan_unwind
  lan_backups_refresh onearm >/dev/null 2>&1 || true
  wan_finish_none
  log "internet kartı denemesi geri alındı"
  echo "rolled_back=1"
}
# Süresi geçen ya da zamanlayıcısı olmayan (Pi yeniden başladı) deneme geri alınır.
wan_trial_check() {
  if [ "$S_wan_trial_ends" -le "$(date +%s)" ] || ! wan_timer_active; then wan_rollback_trial; fi
}
write_wan_guard() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  printf 'result=%s\nat=%s\ndetail=%s\n' "$1" "$(date +%s)" "$2" > "$WAN_GUARD_STATUS.tmp" \
    && mv -f "$WAN_GUARD_STATUS.tmp" "$WAN_GUARD_STATUS"
  logger -t pi5-net-guard "internet kartı: sonuç=$1${2:+ — $2}" 2>/dev/null || true
  echo "wan_guard_result=$1"
  if [ -n "$2" ]; then echo "wan_guard_detail=$2"; fi
}
# Yedekleri profil dosyalarının yerine koyar (eksik ya da farklıysa; mezar taşı kaldırılır) ve yalnız onları yükler.
wan_restore_backups() {
  local p kf bk tmp n=0 bad=""
  WAN_RESTORE_DETAIL=""
  for p in $(wan_profiles); do
    kf=$(wan_keyfile_of "$p"); bk="$WAN_BACKUP_DIR/$(basename "$kf")"
    [ -s "$bk" ] || { bad="$bad $(basename "$bk") (yedek yok)"; continue; }
    if [ -s "$kf" ] && cmp -s "$bk" "$kf" && [ "$(file_of_name "$p")" = "$kf" ]; then continue; fi
    tmp="$(dirname "$kf")/.$(basename "$kf").tmp"
    if ! { cp -f "$bk" "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$kf"; }; then
      rm -f "$tmp"; bad="$bad $(basename "$kf")"; continue
    fi
    drop_tombstone "$kf"
    if nmcli connection load "$kf" >/dev/null 2>&1 && [ "$(file_of_name "$p")" = "$kf" ]; then n=$((n + 1))
    else bad="$bad $(basename "$kf")"; fi
  done
  [ "$n" -gt 0 ] && WAN_RESTORE_DETAIL="$n profil dosyası yedekten geri yüklendi"
  [ -n "$bad" ] && WAN_RESTORE_DETAIL="${WAN_RESTORE_DETAIL:+$WAN_RESTORE_DETAIL; }geri yüklenemeyen:$bad"
  return 0
}
# Kalıcı internet kartını denetler / onarır (guard: açılış + NM yeniden başlatması; ensure: panel açılışı, güncelleme).
# Ev ağı buna bağlı değildir (acil mod yok). $1 = NM'nin kendiliğinden bağlaması için beklenecek süre (sn), $2 = işin
# bitmesi gereken son an (betiğin başından sn — SECONDS; 0 = sınır yok). Güvenlik duvarı yüklenemezse internet kartı
# güvenlik için indirilir (panel, SSH ve DNS internete açık kalmasın).
wan_guard_routine() {
  local wait=$1 limit=${2:-0} end detail="" w
  if [ -z "$S_wan_port" ] || [ -z "$S_wan_dev" ] || [ -z "$S_wan_type" ]; then
    write_wan_guard failed "durum kaydı eksik ($STATE_FILE)"; return 0
  fi
  if ! wan_nft_load; then
    nmcli connection down id "$WAN_PPP_PROFILE" >/dev/null 2>&1; nmcli connection down id "$WAN_VLAN_PROFILE" >/dev/null 2>&1
    nmcli connection down id "$WAN_PROFILE" >/dev/null 2>&1
    write_wan_guard failed "güvenlik duvarı (pi5_wan) yüklenemedi: $WAN_NFT_OUT — internet kartı güvenlik için kapatıldı"
    return 0
  fi
  [ -e "/etc/systemd/system/$WAN_FW_UNIT.service" ] || wan_fw_unit_install || true
  nm_running || { write_wan_guard failed "NetworkManager çalışmıyor"; return 0; }
  if [ ! -e "/sys/class/net/$S_wan_port" ]; then
    write_wan_guard missing_port "internet kartı ($S_wan_port) takılı değil — ev ağı çalışıyor, internet yok"; return 0
  fi
  # 1. Açılışta NM profilleri kendisi etkinleştirir: beklenir.
  end=$((SECONDS + wait))
  while ! wan_up_ok; do
    [ "$SECONDS" -ge "$end" ] && break
    sleep 1
  done
  if wan_up_ok; then write_wan_guard ok ""; return 0; fi
  # 2. Kablo yok: kablo gelince NM kendisi bağlar. (Wi-Fi'da "kablo" bağlanınca gelir: onarıma geçilir.)
  if ! wan_wifi && [ "$(carrier "$S_wan_port")" != 1 ]; then
    write_wan_guard no_carrier "internet kartında kablo bağlantısı yok ($S_wan_port)"; return 0
  fi
  # 3. Profil dosyaları yedekten; profiller sırayla etkinleştirilir.
  wan_restore_backups; detail=$WAN_RESTORE_DETAIL
  if [ "$limit" -gt 0 ]; then
    w=$((limit - SECONDS))
    if [ "$w" -lt 20 ]; then
      write_wan_guard failed "${detail:+$detail; }bağlantı yok; onarıma süre kalmadı — NetworkManager yeniden başlatılınca ya da panel açılınca yeniden denenir"
      return 0
    fi
  fi
  if wan_up && wait_wan_ip 45; then
    write_wan_guard repaired "${detail:+$detail; }internet kartı yeniden bağlandı"; return 0
  fi
  write_wan_guard failed "${detail:+$detail; }internet kartı bağlanamadı: ${WAN_UP_OUT:-adres ya da varsayılan rota gelmedi ($S_wan_dev)}"
  return 0
}

# --- Yedek hat (failover) ---
# İkinci internet bağlantısı: Ethernet kartı (ikinci modem / 4G-5G router / ikinci operatör; isteğe bağlı VLAN; DHCP,
# sabit ya da PPPoE), USB 4G modem ya da telefonun USB paylaşımı (sürücüye göre eşleşir: adı her takışta değişebilir) ya
# da telefon hotspot'u (Wi-Fi istemci). Profiller hep bağlıdır ama varsayılan rotaları düşük önceliklidir (metrik 900;
# ana hat 50, tek kollu ev ağı 100). İzleyici (pi5-wan-failover.service = "backup watch") ana hattı 5 sn'de bir ana hat
# arayüzüne bağlı ping ile sınar; 3 tur yanıt yoksa (bağlantı hiç yoksa hemen) yedek hattın varsayılan rotasının metrik
# 10'lu bir kopyasını koyar — hiçbir profile (ana hat, ev ağı) dokunulmaz. Ana hat 60 sn kesintisiz sağlam kalınca ve son
# geçişten 2 dk geçince kopya kaldırılır. Geçişte eski hattın adresine bağlı NAT kayıtları (conntrack) silinir: açık
# bağlantılar yeni hatta yeniden kurulur. Güvenlik duvarı ayrı tablolardadır (inet pi5_bak + ip pi5_bak_nat, açılışta
# NetworkManager'dan önce): internetten gelen her şey düşer (kurulu bağlantıların yanıtı, DHCP yanıtı, Ev VPN'i portu ve
# port yönlendirmeleri hariç), çıkan trafik maskelenir. USB modemler arayüz grubu 77 ile işaretlenir (udev kuralı +
# izleyici): kural arayüzün adını bilmeden geçerlidir.

# Ev ağı kartındaki VLAN (yönetilebilir anahtar yedek hattı etiketli getirir): kart ev ağıdır, ona profil yazılmaz.
bak_on_lan_card() { [ "$S_bak_kind" = eth ] && [ -n "$S_bak_port" ] && [ "$S_bak_port" = "$S_iface" ]; }
# Bu kurulumun profilleri (etkinleştirme sırası): kart / USB / Wi-Fi → VLAN → PPPoE.
bak_profiles() {
  if ! bak_on_lan_card; then echo "$BAK_PROFILE"; fi
  if [ -n "$S_bak_vlan" ]; then echo "$BAK_VLAN_PROFILE"; fi
  if [ "$S_bak_type" = pppoe ]; then echo "$BAK_PPP_PROFILE"; fi
}
bak_keyfile_of() {
  case "$1" in
    "$BAK_PROFILE") echo "$BAK_KEYFILE" ;;
    "$BAK_VLAN_PROFILE") echo "$BAK_VLAN_KEYFILE" ;;
    "$BAK_PPP_PROFILE") echo "$BAK_PPP_KEYFILE" ;;
  esac
}
# Adresin ve varsayılan rotanın olduğu arayüz. USB'de ad değişebilir: pi5-bak'ın etkin olduğu aygıt, yoksa grup 77'de
# adresi olan ilk arayüz.
bak_cur_dev() {
  local d="" n
  if [ "$S_bak_kind" = usb ]; then
    d=$(nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null | awk -F: -v p="$BAK_PROFILE" '$1 == p { print $2; exit }')
    if [ -z "$d" ]; then
      for n in /sys/class/net/*; do
        if [ "$(cat "$n/netdev_group" 2>/dev/null)" = "$BAK_GROUP" ] && [ -n "$(iface_addrs "${n##*/}")" ]; then d=${n##*/}; break; fi
      done
    fi
    if [[ $d =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; then echo "$d"; fi
  else
    echo "$S_bak_dev"
  fi
}
# Yedek hattın arayüzleri (kart + VLAN + PPPoE, Wi-Fi kartı ya da grup 77'deki USB arayüzleri) — satır başına bir ad.
bak_devs() {
  local n
  [ -n "${S_bak_kind:-}" ] || return 0
  if [ "$S_bak_kind" = usb ]; then
    for n in /sys/class/net/*; do [ "$(cat "$n/netdev_group" 2>/dev/null)" = "$BAK_GROUP" ] && echo "${n##*/}"; done
    return 0
  fi
  if ! bak_on_lan_card && [ -n "$S_bak_port" ]; then echo "$S_bak_port"; fi
  if [ -n "$S_bak_vlan" ]; then echo "bak.$S_bak_vlan"; fi
  if [ "$S_bak_type" = pppoe ]; then echo "$BAK_PPP_IF"; fi
  return 0
}
bak_is_dev() { bak_devs | grep -qx -- "$1"; }
# nft eşleşmesi ($1 = iif | oif): USB'de arayüz grubu (ad değişebilir), değilse ad kümesi.
bak_nft_match() {
  local s=""
  if [ "$S_bak_kind" = usb ]; then printf '%sgroup %s' "$1" "$BAK_GROUP"; return 0; fi
  if ! bak_on_lan_card; then s="\"$S_bak_port\""; fi
  if [ -n "$S_bak_vlan" ]; then s="${s:+$s, }\"bak.$S_bak_vlan\""; fi
  if [ "$S_bak_type" = pppoe ]; then s="$s, \"$BAK_PPP_IF\""; fi
  printf '%sname { %s }' "$1" "$s"
}
# pi5_bak + pi5_bak_nat (boş-tanımla → sil → yeniden-tanımla: idempotent). Hata → 1, BAK_NFT_OUT.
bak_nft_load() {
  local mi mo dhcp="" wgr="" wg out
  BAK_NFT_OUT=""
  command -v nft >/dev/null 2>&1 || { BAK_NFT_OUT="nft bulunamadı"; return 1; }
  [ -n "$S_bak_kind" ] || { BAK_NFT_OUT="yedek hat kaydı yok"; return 1; }
  mi=$(bak_nft_match iif); mo=$(bak_nft_match oif)
  if [ "$S_bak_type" != pppoe ]; then dhcp="        $mi udp sport 67 udp dport 68 accept"; fi
  if wg=$(wg_listen_port); then wgr="        $mi udp dport $wg accept"; fi
  mkdir -p "$(dirname "$BAK_NFT")" 2>/dev/null
  if ! printf '%s\n' "table inet pi5_bak {}
delete table inet pi5_bak
table inet pi5_bak {
    chain input {
        type filter hook input priority -10; policy accept;
        $mi ct state established,related accept
$dhcp
$wgr
        $mi drop
    }
    chain forward {
        type filter hook forward priority -10; policy accept;
        $mi tcp flags syn tcp option maxseg size set rt mtu
        $mo tcp flags syn tcp option maxseg size set rt mtu
        $mi ct state established,related accept
        $mi ct status dnat accept
        $mi drop
    }
}
table ip pi5_bak_nat {}
delete table ip pi5_bak_nat
table ip pi5_bak_nat {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        $mo masquerade
    }
}" > "$BAK_NFT.tmp" || ! mv -f "$BAK_NFT.tmp" "$BAK_NFT"; then
    rm -f "$BAK_NFT.tmp"; BAK_NFT_OUT="$BAK_NFT yazılamadı"; return 1
  fi
  out=$(nft -f "$BAK_NFT" 2>&1) || { BAK_NFT_OUT=$(printf '%s' "$out" | oneline); return 1; }
  return 0
}
bak_nft_remove() {
  local del out rc=0
  del=$'table inet pi5_bak {}\ndelete table inet pi5_bak\ntable ip pi5_bak_nat {}\ndelete table ip pi5_bak_nat'
  if command -v nft >/dev/null 2>&1; then
    if [ -d "$(dirname "$BAK_NFT")" ] && printf '%s\n' "$del" > "$BAK_NFT.tmp" && mv -f "$BAK_NFT.tmp" "$BAK_NFT"; then
      out=$(nft -f "$BAK_NFT" 2>&1) || rc=1
    else
      out=$(printf '%s\n' "$del" | nft -f - 2>&1) || rc=1
    fi
    [ "$rc" = 0 ] || echo "warning=yedek hat güvenlik duvarı tabloları kaldırılamadı: $(printf '%s' "$out" | oneline)"
  fi
  rm -f "$BAK_NFT" "$BAK_NFT.tmp"
}
bak_nft_loaded() { nft list table inet pi5_bak >/dev/null 2>&1 && nft list table ip pi5_bak_nat >/dev/null 2>&1; }
# Açılışta tabloyu NetworkManager'dan ÖNCE yükleyen birim (pi5-wan-fw ile aynı düzen).
bak_fw_unit_install() {
  local u="/etc/systemd/system/$BAK_FW_UNIT.service" nftb
  nftb=$(command -v nft) || return 1
  printf '%s\n' "[Unit]
Description=Klyrix Gate: yedek hat güvenlik duvarı (NetworkManager'dan önce)
DefaultDependencies=no
After=local-fs.target nftables.service
Before=network-pre.target NetworkManager.service shutdown.target
Wants=network-pre.target
Conflicts=shutdown.target
ConditionPathExists=$BAK_NFT

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$nftb -f $BAK_NFT

[Install]
WantedBy=multi-user.target NetworkManager.service" > "$u.tmp" && mv -f "$u.tmp" "$u" || { rm -f "$u.tmp"; return 1; }
  systemctl daemon-reload >/dev/null 2>&1
  systemctl enable "$BAK_FW_UNIT.service" >/dev/null 2>&1
}
bak_fw_unit_remove() {
  local u="/etc/systemd/system/$BAK_FW_UNIT.service"
  [ -e "$u" ] || return 0
  systemctl disable "$BAK_FW_UNIT.service" >/dev/null 2>&1 || true
  rm -f "$u"
  systemctl daemon-reload >/dev/null 2>&1 || true
}
# İzleyici birimi (açılışta NM ve açılış korumasından sonra; düşerse 5 sn'de yeniden başlar).
bak_watch_install() {
  local u="/etc/systemd/system/$BAK_WATCH_UNIT.service"
  printf '%s\n' "[Unit]
Description=Klyrix Gate: yedek hat izleyicisi (ana hat düşünce yedek hatta geçer, dönünce geri alır)
After=NetworkManager.service pi5-net-guard.service
Wants=NetworkManager.service

[Service]
Type=simple
ExecStart=/bin/bash $SELF backup watch
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target" > "$u.tmp" && mv -f "$u.tmp" "$u" || { rm -f "$u.tmp"; return 1; }
  systemctl daemon-reload >/dev/null 2>&1
  systemctl enable "$BAK_WATCH_UNIT.service" >/dev/null 2>&1
  # Beklemesiz: açılış korumasından (pi5-net-guard, oneshot) çağrılırsa izleyici "korumadan sonra" sıralı olduğu için
  # bekleyen bir başlatma korumanın bitmesini bekler, koruma da onu — zaman aşımına kadar kilitlenirdi.
  systemctl --no-block restart "$BAK_WATCH_UNIT.service" >/dev/null 2>&1
}
bak_watch_remove() {
  local u="/etc/systemd/system/$BAK_WATCH_UNIT.service"
  systemctl stop "$BAK_WATCH_UNIT.service" >/dev/null 2>&1 || true
  if [ -e "$u" ]; then
    systemctl disable "$BAK_WATCH_UNIT.service" >/dev/null 2>&1 || true
    rm -f "$u"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$BAK_STATUS" "$BAK_STATUS.tmp" "$BAK_FORCE"
}
# USB türü: sürücüsü listedeki arayüzler takılır takılmaz (NM etkinleştirmeden önce) grup 77'ye alınır.
bak_udev_install() {
  local ipb drv
  ipb=$(command -v ip) || return 1
  drv=$(printf '%s' "$S_bak_match" | tr ' ' '|')
  mkdir -p "$(dirname "$BAK_UDEV_RULE")" || return 1
  printf '%s\n' "# Klyrix Gate yedek hat: USB 4G modem / telefon paylaşımı arayüzleri grup $BAK_GROUP (güvenlik duvarı pi5_bak)
ACTION==\"add\", SUBSYSTEM==\"net\", DRIVERS==\"$drv\", RUN+=\"$ipb link set dev %k group $BAK_GROUP\"" > "$BAK_UDEV_RULE.tmp" \
    && chmod 644 "$BAK_UDEV_RULE.tmp" && mv -f "$BAK_UDEV_RULE.tmp" "$BAK_UDEV_RULE" || { rm -f "$BAK_UDEV_RULE.tmp"; return 1; }
  udevadm control --reload >/dev/null 2>&1 || true
}
bak_udev_remove() {
  local n
  if [ -e "$BAK_UDEV_RULE" ]; then rm -f "$BAK_UDEV_RULE"; udevadm control --reload >/dev/null 2>&1 || true; fi
  for n in /sys/class/net/*; do
    [ "$(cat "$n/netdev_group" 2>/dev/null)" = "$BAK_GROUP" ] && ip link set dev "${n##*/}" group default 2>/dev/null
  done
  return 0
}
# Ev ağı kartı, köprü ve ana hattın kartı yedek hat olamaz.
bak_foreign_port() { [ "$1" = "$S_iface" ] || [ "$1" = "$BR_IF" ] || { [ -n "$S_wan_port" ] && [ "$1" = "$S_wan_port" ]; }; }
dev_driver() { nmcli -g GENERAL.DRIVER device show "$1" 2>/dev/null; }
# USB türü: sürücüsü listede olan kablolu arayüzleri grup 77'ye alır ve adlarını yazar (udev kuralının kaçırdığı ya da
# kural kurulmadan önce takılmış aygıtlar). NetworkManager'ın yönetmediği arayüzler (ör. yapılandırmada unmanaged) alınmaz.
bak_tag_usb() {
  local n t st d
  while IFS=: read -r n t st; do
    case "$t" in ethernet|veth) ;; *) continue ;; esac
    [ "$st" = unmanaged ] && continue
    bak_foreign_port "$n" && continue
    d=$(dev_driver "$n")
    case " $S_bak_match " in *" $d "*) ;; *) continue ;; esac
    [ "$(cat "/sys/class/net/$n/netdev_group" 2>/dev/null)" = "$BAK_GROUP" ] || ip link set dev "$n" group "$BAK_GROUP" 2>/dev/null
    echo "$n"
  done < <(nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null)
}
# Yedek hattın kartında (Ethernet / Wi-Fi / USB) başka bir profil etkinse indirilir (ör. karta bağlı olmayan eski netplan
# profili ya da Pi'nin eski Wi-Fi profili ev modemine bağlandı): o zaman NM kendi önceliğiyle yedek hat profilini seçer.
bak_evict_foreign() {
  local d ac au
  if [ "$S_bak_kind" = usb ]; then
    # shellcheck disable=SC2046 # arayüz adları boşluksuz (satır başına bir ad): sözcüklere bölünmesi istenir
    set -- $(bak_devs)
  elif bak_on_lan_card; then
    return 0
  else
    set -- "$S_bak_port"
  fi
  for d in "$@"; do
    [ -n "$d" ] && [ -e "/sys/class/net/$d" ] || continue
    ac=$(active_conn "$d")
    [ -n "$ac" ] && [ "$ac" != "$BAK_PROFILE" ] || continue
    au=$(active_uuid "$d")
    [ -n "$au" ] && nmcli connection down uuid "$au" >/dev/null 2>&1 && log "yedek hat: $d üzerindeki başka profil ($ac) indirildi"
  done
  return 0
}
# [ipv4] bölümü. $1 = 1: bu profil adresi taşır; değilse adressiz. $2 = ppp: PPPoE profili.
bak_ipv4_section() {
  if [ "$1" != 1 ]; then printf 'method=disabled'; return 0; fi
  if [ "$S_bak_type" = static ] && [ "${2:-}" != ppp ]; then
    printf 'method=manual\naddress1=%s\ngateway=%s\n' "$S_bak_addr" "$S_bak_gw"
    if [ -n "$S_bak_dns" ]; then printf 'dns=%s;\n' "${S_bak_dns//,/;}"; fi
  else
    printf 'method=auto\n'
  fi
  # Düşük öncelikli varsayılan rota; operatörün DNS'i Pi'nin kendisinden (Pi-hole) sonra.
  printf 'route-metric=%s\ndns-priority=200\nmay-fail=false' "$BAK_METRIC"
}
# Wi-Fi ağ adı bayt listesi olarak yazılır ("65;108;105;"): telefon hotspot adlarında Türkçe harf, kesme işareti,
# noktalı virgül olabilir; keyfile'da bu biçim her baytı olduğu gibi taşır.
ssid_bytes() { printf '%s' "$1" | od -An -tu1 -v | tr -s ' \n' ';;' | sed 's/^;//'; }
# Profil dosyaları (kendiliğinden bağlanır; öncelik 250: karta bağlı olmayan eski profillerden önce seçilir).
# $1 = PPPoE parolası ya da Wi-Fi parolası (argv'ye / günlüğe girmez).
bak_write_keyfiles() {
  local u1 u2 u3 l3port=1 l3vlan=0 base_mtu="" eth="" vlan_eth="" ppp="" parent x="" p
  u1=$(new_uuid) && u2=$(new_uuid) && u3=$(new_uuid) || return 1
  if [ -n "$S_bak_vlan" ]; then l3port=0; l3vlan=1; fi
  if [ "$S_bak_type" = pppoe ]; then l3port=0; l3vlan=0; fi
  if [ "$S_bak_type" = pppoe ] && [ -n "$S_bak_mtu" ] && [ "$S_bak_mtu" -gt 1492 ]; then base_mtu=$((S_bak_mtu + 8)); fi
  if [ -n "$S_bak_mtu" ] && [ "$l3port" = 1 ]; then eth="mtu=$S_bak_mtu"; elif [ -n "$base_mtu" ]; then eth="mtu=$base_mtu"; fi
  case "$S_bak_kind" in
    eth)
      if ! bak_on_lan_card; then
        home_put_keyfile "$BAK_KEYFILE" "[connection]
id=$BAK_PROFILE
uuid=$u1
type=ethernet
interface-name=$S_bak_port
autoconnect=true
autoconnect-priority=250
autoconnect-retries=0

[ethernet]
$eth

[ipv4]
$(bak_ipv4_section "$l3port")

[ipv6]
method=disabled" || return 1
      fi ;;
    usb)
      # Ev ağı kartı, köprü ve ana hattın kartı eşleşmeden çıkarılır ("!ad": zorunlu değil-eşleşme).
      for p in "$S_iface" "$BR_IF" "$S_wan_port"; do if [ -n "$p" ]; then x="$x!$p;"; fi; done
      home_put_keyfile "$BAK_KEYFILE" "[connection]
id=$BAK_PROFILE
uuid=$u1
type=ethernet
autoconnect=true
autoconnect-priority=250
autoconnect-retries=0

[match]
driver=${S_bak_match// /;};
interface-name=$x

[ethernet]
$eth

[ipv4]
$(bak_ipv4_section 1)

[ipv6]
method=disabled" || return 1 ;;
    wifi)
      home_put_keyfile "$BAK_KEYFILE" "[connection]
id=$BAK_PROFILE
uuid=$u1
type=wifi
interface-name=$S_bak_port
autoconnect=true
autoconnect-priority=250
autoconnect-retries=0

[wifi]
mode=infrastructure
ssid=$(ssid_bytes "$S_bak_ssid")

[wifi-security]
key-mgmt=wpa-psk
psk=$1

[ipv4]
$(bak_ipv4_section 1)

[ipv6]
method=disabled" || return 1 ;;
  esac
  if [ -n "$S_bak_vlan" ]; then
    if [ -n "$S_bak_mtu" ] && [ "$l3vlan" = 1 ]; then vlan_eth="mtu=$S_bak_mtu"; elif [ -n "$base_mtu" ]; then vlan_eth="mtu=$base_mtu"; fi
    home_put_keyfile "$BAK_VLAN_KEYFILE" "[connection]
id=$BAK_VLAN_PROFILE
uuid=$u2
type=vlan
interface-name=bak.$S_bak_vlan
autoconnect=true
autoconnect-priority=250
autoconnect-retries=0

[ethernet]
$vlan_eth

[vlan]
parent=$S_bak_port
id=$S_bak_vlan

[ipv4]
$(bak_ipv4_section "$l3vlan")

[ipv6]
method=disabled" || return 1
  fi
  if [ "$S_bak_type" = pppoe ]; then
    parent=$S_bak_port
    if [ -n "$S_bak_vlan" ]; then parent="bak.$S_bak_vlan"; fi
    if [ -n "$S_bak_mtu" ]; then ppp="mtu=$S_bak_mtu
mru=$S_bak_mtu"; fi
    home_put_keyfile "$BAK_PPP_KEYFILE" "[connection]
id=$BAK_PPP_PROFILE
uuid=$u3
type=pppoe
interface-name=$BAK_PPP_IF
autoconnect=true
autoconnect-priority=250
autoconnect-retries=0

[pppoe]
parent=$parent
username=$S_bak_user
password=$1

[ppp]
$ppp

[ipv4]
$(bak_ipv4_section 1 ppp)

[ipv6]
method=disabled" || return 1
  fi
}
bak_loaded() {
  local p f
  for p in $(bak_profiles); do
    f=$(bak_keyfile_of "$p")
    [ -s "$f" ] && [ "$(file_of_name "$p")" = "$f" ] || return 1
  done
}
bak_load_all() {
  local p f out
  BAK_LOAD_OUT=""
  for p in $(bak_profiles); do
    f=$(bak_keyfile_of "$p")
    drop_tombstone "$f"
    out=$(nmcli connection load "$f" 2>&1) || { BAK_LOAD_OUT="$p: $(printf '%s' "$out" | oneline)"; return 1; }
  done
  bak_loaded || { BAK_LOAD_OUT="profiller NetworkManager'da beklenen dosyalardan görünmüyor (dosya reddedilmiş olabilir)"; return 1; }
}
bak_delete_all() {
  local f
  delete_named "$BAK_PPP_PROFILE"; delete_named "$BAK_VLAN_PROFILE"; delete_named "$BAK_PROFILE"
  for f in "$BAK_PPP_KEYFILE" "$BAK_VLAN_KEYFILE" "$BAK_KEYFILE"; do rm -f "$f" "$(dirname "$f")/.$(basename "$f").tmp"; done
}
bak_up() {
  local p out w
  BAK_UP_OUT=""
  for p in $(bak_profiles); do
    w=30; [ "$p" = "$BAK_PPP_PROFILE" ] && w=60; [ "$S_bak_kind" = wifi ] && w=45
    if ! out=$(nmcli -w "$w" connection up id "$p" 2>&1); then
      BAK_UP_OUT="$p etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
      if [ "$p" = "$BAK_PPP_PROFILE" ]; then
        BAK_UP_OUT="PPPoE oturumu açılamadı — kullanıcı adı / şifre, VLAN numarası ya da operatörün PPPoE sunucusu ($BAK_UP_OUT)"
      elif [ "$S_bak_kind" = wifi ]; then
        BAK_UP_OUT="hotspot'a bağlanılamadı — telefonda hotspot açık mı, ağ adı ve parola doğru mu ($BAK_UP_OUT)"
      elif [ "$S_bak_type" = dhcp ] && [[ $out == *Timeout* || $out == *"IP configuration"* ]]; then
        BAK_UP_OUT="yedek hattan adres gelmedi (DHCP yanıtı yok) — modem / telefon açık mı, kablo ve VLAN numarası doğru mu ($BAK_UP_OUT)"
      fi
      return 1
    fi
  done
}
bak_ip() {
  local d
  d=$(bak_cur_dev); [ -n "$d" ] || return 0
  ip -4 -o addr show dev "$d" 2>/dev/null | awk '{ if ($5 == "peer") print $4 "/32"; else print $4; exit }' | head -1
}
dev_gateway() {
  local g
  g=$(ip -4 route show default dev "$1" 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit } }')
  [ -n "$g" ] || g=$(ip -4 -o addr show dev "$1" 2>/dev/null | awk '$5 == "peer" { sub(/\/.*/, "", $6); print $6; exit }')
  echo "$g"
}
bak_gateway() { local d; d=$(bak_cur_dev); [ -n "$d" ] && dev_gateway "$d"; }
# Bağlı: arayüzde adres ve (düşük öncelikli) varsayılan rota var.
bak_up_ok() {
  local d
  d=$(bak_cur_dev)
  [ -n "$d" ] && [ -n "$(bak_ip)" ] && ip -4 route show default dev "$d" 2>/dev/null | grep -q .
}
wait_bak_ip() {
  local end=$((SECONDS + $1))
  while ! bak_up_ok; do
    [ "$SECONDS" -ge "$end" ] && return 1
    sleep 1
  done
}
# Ana hat: internet kartı modunda kartın adres/rota arayüzü, tek kollu modda ev ağı arayüzü (modem ağ geçidi orada).
bak_primary_dev() { if [ "$S_wan_stage" != none ] && [ -n "$S_wan_dev" ]; then echo "$S_wan_dev"; else lan_dev; fi; }
bak_primary_ip() { if [ "$S_wan_stage" != none ] && [ -n "$S_wan_dev" ]; then wan_ip; else echo "$S_transit"; fi; }
# Arayüze bağlı sınama (SO_BINDTODEVICE: metrik ve VPS yönlendirme kuralları araya girmez). Rota yoksa hemen başarısız.
# Üç hedef aynı anda denenir (en çok 2 sn): biri yanıt verirse sağlam.
bak_probe() {
  local t p rc=1 pids=()
  [ -n "$1" ] && [ -e "/sys/class/net/$1" ] || return 1
  ip -4 route show default dev "$1" 2>/dev/null | grep -q . || return 1
  for t in $BAK_TARGETS; do ping -n -c1 -W2 -I "$1" "$t" >/dev/null 2>&1 & pids+=("$!"); done
  for p in "${pids[@]}"; do wait "$p" && rc=0; done
  return "$rc"
}
# Geçiş rotası: yedek hattın varsayılan rotasının metrik 10'lu kopyası (NM'nin rotasına ve profillere dokunulmaz).
bak_route_on() {
  local g
  g=$(dev_gateway "$1")
  if [ -n "$g" ] && [ "$S_bak_type" != pppoe ]; then
    ip route replace default via "$g" dev "$1" metric "$BAK_ACTIVE_METRIC" 2>/dev/null
  else
    ip route replace default dev "$1" metric "$BAK_ACTIVE_METRIC" 2>/dev/null
  fi
}
bak_route_lines() { ip -4 route show default 2>/dev/null | awk -v m="$BAK_ACTIVE_METRIC" '$0 ~ (" metric " m "( |$)")'; }
bak_route_present() { bak_route_lines | grep -Eq " dev $(rx "$1")( |\$)"; }
bak_route_off() {
  local l n=0
  while l=$(bak_route_lines | head -1) && [ -n "$l" ] && [ "$n" -lt 8 ]; do
    # shellcheck disable=SC2086 # satır "default via G dev D metric 10" biçiminde, sözcüklere bölünmesi gerekir
    ip route del $l 2>/dev/null || break
    n=$((n + 1))
  done
  return 0
}
# Eski hattın adresine bağlı NAT / bağlantı kayıtları (yanıt hedefi = o adres): yeni hatta yeniden kurulsunlar.
bak_ct_flush() {
  [ -n "$1" ] && valid_ip "$1" || return 0
  command -v conntrack >/dev/null 2>&1 || return 0
  conntrack -D -q "$1" >/dev/null 2>&1 || true
}
bak_failed_over() { [ "$(sed -n 's/^active=//p' "$BAK_STATUS" 2>/dev/null)" = backup ]; }
bak_status_write() { # active since switches reason pdev pok bdev bok force_until
  mkdir -p "$BAK_RUN" 2>/dev/null
  printf 'active=%s\nsince=%s\nswitches=%s\nreason=%s\nprimary_dev=%s\nprimary_ok=%s\nbackup_dev=%s\nbackup_ok=%s\nchecked=%s\nforce_until=%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$(date +%s)" "$9" > "$BAK_STATUS.tmp" && mv -f "$BAK_STATUS.tmp" "$BAK_STATUS"
}
# Yedek hattı kaldırır (açma başarısız / kapatma): rota, NAT kayıtları, profiller, güvenlik duvarı, udev kuralı, Wi-Fi
# kartının eski durumu. Durum dosyasına dokunmaz.
bak_unwind() {
  local ip
  ip=$(bak_ip)
  bak_watch_remove
  bak_route_off
  nmcli connection down id "$BAK_PPP_PROFILE" >/dev/null 2>&1 || true
  nmcli connection down id "$BAK_VLAN_PROFILE" >/dev/null 2>&1 || true
  nmcli connection down id "$BAK_PROFILE" >/dev/null 2>&1 || true
  bak_delete_all
  if [ -n "$S_bak_vlan" ] && [ -e "/sys/class/net/bak.$S_bak_vlan" ]; then ip link delete "bak.$S_bak_vlan" 2>/dev/null || true; fi
  [ -n "$ip" ] && bak_ct_flush "${ip%/*}"
  bak_nft_remove
  bak_fw_unit_remove
  bak_udev_remove
  # Wi-Fi kartı: sabit adres kurulumunda kapatılmışsa (Faz 2) yeniden kapatılır.
  if [ "$S_bak_kind" = wifi ] && { [ "$S_bak_radio_was_off" = 1 ] || [ "$S_wifi_off" = 1 ]; } \
     && [ "$S_ap_stage" = none ] && [ "$S_home_stage" = none ] && [ "$S_sat_stage" = none ] \
     && ! { [ "$S_wan_stage" != none ] && wan_wifi; }; then
    nmcli radio wifi off >/dev/null 2>&1 || true
  fi
  rm -rf "$BAK_BACKUP_DIR"
  return 0
}
# Yedekleri profil dosyalarının yerine koyar (eksik / farklıysa) ve yükler (açılış koruması).
bak_restore_backups() {
  local p kf bk tmp
  for p in $(bak_profiles); do
    kf=$(bak_keyfile_of "$p"); bk="$BAK_BACKUP_DIR/$(basename "$kf")"
    [ -s "$bk" ] || continue
    if [ -s "$kf" ] && cmp -s "$bk" "$kf" && [ "$(file_of_name "$p")" = "$kf" ]; then continue; fi
    tmp="$(dirname "$kf")/.$(basename "$kf").tmp"
    { cp -f "$bk" "$tmp" && chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$kf"; } || { rm -f "$tmp"; continue; }
    drop_tombstone "$kf"
    nmcli connection load "$kf" >/dev/null 2>&1 && log "yedek hat profili yedekten geri yüklendi: $p"
  done
  return 0
}
# Kalıcı yedek hattı denetler (guard: açılış + NM yeniden başlatması; ensure: panel açılışı, güncelleme): güvenlik duvarı,
# açılış birimleri, udev kuralı, profil dosyaları, izleyici. Güvenlik duvarı yüklenemezse yedek hat indirilir.
bak_guard_routine() {
  [ -n "$S_bak_kind" ] || return 0
  if ! bak_nft_load; then
    nmcli connection down id "$BAK_PPP_PROFILE" >/dev/null 2>&1; nmcli connection down id "$BAK_VLAN_PROFILE" >/dev/null 2>&1
    nmcli connection down id "$BAK_PROFILE" >/dev/null 2>&1
    echo "bak_guard_result=failed"
    echo "bak_guard_detail=güvenlik duvarı (pi5_bak) yüklenemedi: $BAK_NFT_OUT — yedek hat güvenlik için kapatıldı"
    log "yedek hat: güvenlik duvarı yüklenemedi ($BAK_NFT_OUT) — yedek hat kapatıldı"
    return 0
  fi
  [ -e "/etc/systemd/system/$BAK_FW_UNIT.service" ] || bak_fw_unit_install || true
  if [ "$S_bak_kind" = usb ]; then
    [ -e "$BAK_UDEV_RULE" ] || bak_udev_install || true
    bak_tag_usb >/dev/null
  fi
  nm_running && bak_restore_backups
  if [ ! -e "/etc/systemd/system/$BAK_WATCH_UNIT.service" ]; then bak_watch_install || true
  elif ! systemctl is-active --quiet "$BAK_WATCH_UNIT.service" 2>/dev/null; then systemctl --no-block start "$BAK_WATCH_UNIT.service" >/dev/null 2>&1 || true; fi
  echo "bak_guard_result=ok"
  return 0
}

cmd_status() {
  local now dr pifc pgw ptr="" ifc nm=0 ac="" au="" method="" wifi="" gr="" ga="" gd="" k v pok=0
  local wifc apc=0 apa=0 agr="" agd="" lifc hifc hc=0 ha=0 bra=0 sa=0 sb=0
  read_state
  now=$(date +%s)
  dr=$(default_route); pifc=${dr%% *}; pgw=${dr#"$pifc"}; pgw=${pgw# }
  if [ -n "$pifc" ] && valid_ip "$pgw"; then ptr=$(addr_for_gw "$pifc" "$pgw"); fi
  ifc=$S_iface
  [ -n "$ifc" ] || ifc=$pifc
  # Cihaz ağının arayüzü: ev Wi-Fi'ı açıkken köprü (adresler ve etkin profil orada), değilse kart.
  lifc=$ifc
  if { [ "$S_home_stage" != none ] || [ "$S_sat_stage" != none ]; } && [ -e "/sys/class/net/$BR_IF" ]; then lifc=$BR_IF; fi
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
    [ -n "$wifc" ] || wifc=$(wifi_dev_free ap || wifi_dev)
    ap_capable "$wifc" && apc=1
    ap_up_ok "$wifc" && apa=1
    [ -n "$hifc" ] || hifc=$(wifi_dev_free home ap || wifi_dev)
    ap_capable "$hifc" && hc=1
    if [ "$S_home_stage" != none ]; then
      home_ap_ok "$hifc" && ha=1
      br_up_ok && bra=1
    fi
    if [ "$S_sat_stage" != none ]; then
      home_ap_ok "$S_sat_wifi" && sa=1
      sat_br_ok && sb=1
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
  echo "sat_stage=$S_sat_stage"
  echo "sat_trial_ends=$S_sat_trial_ends"
  echo "sat_ssid=$S_sat_ssid"
  echo "sat_band=$S_sat_band"
  echo "sat_channel=$S_sat_channel"
  echo "sat_wifi=$S_sat_wifi"
  echo "sat_iface=$S_sat_iface"
  echo "sat_backhaul=$S_sat_backhaul"
  echo "sat_active=$sa"
  echo "sat_br=$sb"
  echo "sat_ip=$( [ "$S_sat_stage" != none ] && iface_addrs "$BR_IF" | head -1)"
  echo "sat_gw=$( [ "$S_sat_stage" != none ] && sat_gw)"
  # İnternet kartı (WAN router): kayıtlı ayar + canlı durum. wan_static_*: sabit adres ayarı (canlı adres wan_ip).
  local wgr="" wgd="" wup=0 wfw=0 pppok=0
  if [ -f "$WAN_GUARD_STATUS" ]; then
    while IFS='=' read -r k v; do
      case "$k" in result) wgr=$v ;; detail) wgd=$v ;; esac
    done < "$WAN_GUARD_STATUS"
  fi
  if [ "$S_wan_stage" != none ]; then
    wan_up_ok && wup=1
    wan_nft_loaded && wfw=1
  fi
  if command -v pppd >/dev/null 2>&1 && compgen -G '/usr/lib/*/NetworkManager/*/libnm-ppp-plugin.so' >/dev/null; then pppok=1; fi
  echo "wan_stage=$S_wan_stage"
  echo "wan_trial_ends=$S_wan_trial_ends"
  echo "wan_port=$S_wan_port"
  echo "wan_dev=$S_wan_dev"
  echo "wan_type=$S_wan_type"
  echo "wan_vlan=$S_wan_vlan"
  echo "wan_prio=$S_wan_prio"
  echo "wan_mac=$S_wan_mac"
  echo "wan_mtu=$S_wan_mtu"
  echo "wan_user=$S_wan_user"
  echo "wan_static_addr=$S_wan_addr"
  echo "wan_static_gw=$S_wan_gw"
  echo "wan_static_dns=$S_wan_dns"
  echo "wan_lan=$S_wan_lan"
  echo "wan_single=$( wan_single && echo 1 || echo 0 )"
  echo "wan_dhcp_vendor=$S_wan_dhcp_vendor"
  echo "wan_dhcp_client_id=$S_wan_dhcp_cid"
  echo "wan_dhcp_hostname=$S_wan_dhcp_host"
  # Repeater (R4 A): internet kartı Wi-Fi istemci ise üst ağın adı ve sinyal gücü (%, NM'nin son taraması).
  echo "wan_ssid=$S_wan_ssid"
  echo "wan_kind=$( if wan_wifi; then echo wifi; elif [ -n "$S_wan_port" ]; then echo ethernet; fi )"
  echo "wan_signal=$( if [ "$S_wan_stage" != none ] && wan_wifi && [ "$nm" = 1 ]; then nmcli -t -f IN-USE,SIGNAL device wifi list ifname "$S_wan_port" --rescan no 2>/dev/null | awk -F: '$1 == "*" { print $2; exit }'; fi )"
  echo "wan_ip=$( [ "$S_wan_stage" != none ] && wan_ip)"
  echo "wan_gateway=$( [ "$S_wan_stage" != none ] && wan_gateway)"
  echo "wan_carrier=$( if [ -n "$S_wan_port" ]; then carrier "$S_wan_port"; else echo 0; fi )"
  echo "wan_up=$wup"
  echo "wan_fw=$wfw"
  echo "wan_guard_result=$wgr"
  echo "wan_guard_detail=$wgd"
  echo "ppp_ok=$pppok"
  # Yedek hat: kayıtlı ayar + canlı durum; bak_active/since/switches/reason/..._ok izleyicinin durum dosyasından (/run).
  local bdev="" bup=0 bfw=0 bw=0 fa=primary fsi="" fsw=0 fre="" fpo="" fbo="" fck="" ffu=0 brx=0 btx=0 bct=0 bcand=""
  if [ "$S_bak_stage" != none ]; then
    bdev=$(bak_cur_dev)
    bak_up_ok && bup=1
    bak_nft_loaded && bfw=1
    systemctl is-active --quiet "$BAK_WATCH_UNIT.service" 2>/dev/null && bw=1
    if [ -n "$bdev" ]; then
      brx=$(cat "/sys/class/net/$bdev/statistics/rx_bytes" 2>/dev/null || echo 0)
      btx=$(cat "/sys/class/net/$bdev/statistics/tx_bytes" 2>/dev/null || echo 0)
    fi
    if [ -f "$BAK_STATUS" ]; then
      while IFS='=' read -r k v; do
        case "$k" in
          active) fa=$v ;; since) fsi=$v ;; switches) fsw=$v ;; reason) fre=$v ;; primary_ok) fpo=$v ;;
          backup_ok) fbo=$v ;; checked) fck=$v ;; force_until) ffu=$v ;;
        esac
      done < "$BAK_STATUS"
    fi
  fi
  command -v conntrack >/dev/null 2>&1 && bct=1
  # USB modem / telefon adayları (sürücüsü listede olan, ev ağı / ana hat kartı olmayan kablolu arayüzler).
  if [ "$nm" = 1 ]; then
    bcand=$(nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null | while IFS=: read -r n t st; do
      case "$t" in ethernet|veth) ;; *) continue ;; esac
      [ "$st" = unmanaged ] && continue
      bak_foreign_port "$n" && continue
      case " ${PI5_BAK_USB_DRIVERS:-$BAK_USB_DRIVERS} " in *" $(dev_driver "$n") "*) echo "$n" ;; esac
    done | csv)
  fi
  echo "bak_stage=$S_bak_stage"
  echo "bak_kind=$S_bak_kind"
  echo "bak_type=$S_bak_type"
  echo "bak_port=$S_bak_port"
  echo "bak_dev=$bdev"
  echo "bak_vlan=$S_bak_vlan"
  echo "bak_mtu=$S_bak_mtu"
  echo "bak_user=$S_bak_user"
  echo "bak_ssid=$S_bak_ssid"
  echo "bak_static_addr=$S_bak_addr"
  echo "bak_static_gw=$S_bak_gw"
  echo "bak_static_dns=$S_bak_dns"
  echo "bak_ip=$( [ -n "$bdev" ] && bak_ip)"
  echo "bak_gateway=$( [ -n "$bdev" ] && bak_gateway)"
  echo "bak_up=$bup"
  echo "bak_fw=$bfw"
  echo "bak_watch=$bw"
  echo "bak_active=$fa"
  echo "bak_since=$fsi"
  echo "bak_switches=$fsw"
  echo "bak_reason=$fre"
  echo "bak_primary_ok=$fpo"
  echo "bak_backup_ok=$fbo"
  echo "bak_checked=$fck"
  echo "bak_force_until=$ffu"
  echo "bak_rx=$brx"
  echo "bak_tx=$btx"
  echo "bak_conntrack=$bct"
  echo "bak_usb_candidates=$bcand"
  # Wi-Fi radyoları ve rolleri ("kart=rol", boş rol = boşta): arayüz hangi radyonun seçilebileceğini gösterir.
  echo "wifi_roles=$( if [ "$nm" = 1 ]; then wifi_devs | while IFS= read -r d; do printf '%s=%s\n' "$d" "$(radio_user "$d")"; done | csv; fi )"
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
  [ "$S_sat_stage" = none ] || die "bu cihaz uydu olarak çalışıyor — sabit adres ana cihaz içindir"
  [ "$S_wan_stage" = none ] || die "internet kartı (WAN router) kaydı var — önce 'wan off' ile kapatın"
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
  [ "$S_wan_stage" = none ] || die "internet kartı (WAN router) açık — önce Cihaz Rolleri → WAN router'dan kapatın"
  [ "$S_bak_stage" = none ] || die "yedek hat açık — önce Cihaz Rolleri → Yedek hat'tan kapatın"
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
  [ "$S_sat_stage" = none ] || die "bu cihaz uydu olarak yayın yapıyor — Wi-Fi kartı yayında"
  if [ "$S_bak_stage" != none ] && [ "$S_bak_kind" = wifi ]; then
    die "Wi-Fi kartı yedek hat (telefon hotspot'u) olarak kullanılıyor — önce Cihaz Rolleri → Yedek hat'tan kapatın"
  fi
  if [ "$S_wan_stage" != none ] && wan_wifi; then
    die "Pi'nin interneti Wi-Fi'dan geliyor (repeater, $S_wan_port) — Wi-Fi kapatılamaz; önce WAN router'ı kapatın"
  fi
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
  [ "$S_ap_stage" = on ] && die "kurulum Wi-Fi'ı zaten açık"
  [ "$S_ap_stage" = trial ] && die "kurulum Wi-Fi'ı denemesi sürüyor"
  [ "$S_home_stage" = none ] || die "ev Wi-Fi'ı açık — kurulum Wi-Fi'ı aynı kartı kullanır; önce ev Wi-Fi'ını kapatın"
  [ "$S_sat_stage" = none ] || die "bu cihaz uydu olarak yayın yapıyor — kurulum Wi-Fi'ı açılamaz"
  # Radyo: başka işte (internet bağlantısı / yedek hat / mesh) olmayan ilk kart; tek radyoda ilk kart.
  [ -n "$(wifi_dev)" ] || die "Pi'de Wi-Fi kartı bulunamadı"
  ifc=$(wifi_dev_free ap) || die "$(wifi_busy_why ap)"
  [[ $ifc =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "Wi-Fi kartının adı beklenmedik: $ifc"
  ap_capable "$ifc" || die "Wi-Fi kartı ($ifc) erişim noktası (AP) kipini desteklemiyor"
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
  [ "$S_sat_stage" = none ] || die "bu cihaz uydu olarak çalışıyor — ev Wi-Fi'ı ana cihazdan yönetilir"
  [ "$S_stage" = static ] || die "önce Pi'ye sabit adres verin ve kalıcı yapın (DHCP Ayarları, 1. adım)"
  [ "$S_ap_stage" = none ] || die "kurulum Wi-Fi'ı açık — ev Wi-Fi'ı aynı kartı kullanır; önce kurulum Wi-Fi'ını kapatın"
  [ "$S_wan_stage" = trial ] && die "internet kartı (WAN router) denemesi sürüyor — önce kalıcı yapın ya da geri alın"
  if [ "$S_bak_stage" != none ]; then
    [ "$S_bak_kind" = wifi ] && die "Wi-Fi kartı yedek hat (telefon hotspot'u) olarak kullanılıyor — önce Cihaz Rolleri → Yedek hat'tan kapatın"
    bak_failed_over && die "yedek hat devrede (ana hat çalışmıyor) — ev Wi-Fi'ı denemesi internet rotasını ana hattan denetler; ana hat dönünce deneyin"
  fi
  { [ "$(active_conn "$S_iface")" = "$PROFILE" ] && lan_addrs_ok "$S_iface"; } \
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
  # Radyo: başka işte (internet bağlantısı / yedek hat / mesh) olmayan, erişim noktası destekleyen ilk kart.
  [ -n "$(wifi_dev)" ] || die "Pi'de Wi-Fi kartı bulunamadı"
  wifi=$(wifi_dev_free home ap) || die "$(wifi_busy_why home)"
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
  # İnternet kartı modunda modem eth0 tarafında değildir: modem / rota denetimi köprüye uygulanmaz.
  [ "$S_wan_lan" = 1 ] || { ping -c2 -W2 "$S_gw" >/dev/null 2>&1 && base_ping=1; }
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
  elif [ "$S_wan_lan" != 1 ] && ! route_ok "$BR_IF" "${S_transit%/*}"; then
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

# Ana cihazın ev Wi-Fi'ı ayarları (uydulara aktarılır; backend okur). Kilitsiz, salt okunur; parola yalnız stdout'a.
cmd_home_secret() {
  local psk
  read_state
  [ "$S_home_stage" = on ] || die "ev Wi-Fi'ı kalıcı değil (home_stage=$S_home_stage)"
  [ -s "$HOME_KEYFILE" ] || die "ev Wi-Fi'ı profil dosyası yok"
  psk=$(sed -n 's/^psk=//p' "$HOME_KEYFILE" | head -1)
  [ -n "$psk" ] || die "ev Wi-Fi'ı profilinde parola yok"
  echo "ssid=$(sed -n 's/^ssid=//p' "$HOME_KEYFILE" | head -1)"
  echo "band=$(sed -n 's/^band=//p' "$HOME_KEYFILE" | head -1)"
  echo "channel=$(sed -n 's/^channel=//p' "$HOME_KEYFILE" | head -1)"
  echo "psk=$psk"
  echo "ok=1"
}

# Uydu denemesi (backend, eşleştirmeden sonra). Parola STDIN'in ilk satırından; argv'ye, günlüğe, durum dosyasına girmez.
cmd_sat_on() {
  local trial="" ssid="" psk="" band=bg ch="" wifi dr ifc radio_off=0 end out why="" mac="" v6 cid old_uuid old_name gw base_ping=0
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
  valid_channel "$band" "$ch" || die "geçersiz kanal: $ch"
  read_state
  command -v nmcli >/dev/null 2>&1 || die "nmcli bulunamadı (NetworkManager kurulu değil)"
  nm_running || die "NetworkManager çalışmıyor"
  [ "$S_sat_stage" = none ] || die "uydu zaten açık (sat_stage=$S_sat_stage)"
  [ "$S_stage" = none ] || die "bu cihazda sabit adres var (ana cihaz ayarı) — uydu olmak için önce otomatik adrese dönün"
  [ "$S_ap_stage" = none ] || die "kurulum Wi-Fi'ı açık — önce kapatın"
  [ "$S_home_stage" = none ] || die "ev Wi-Fi'ı (ana cihaz) açık — önce kapatın"
  [ -e "/sys/class/net/$BR_IF" ] && die "$BR_IF arayüzü zaten var — önce kaldırın"
  [ -n "$(wifi_dev)" ] || die "Pi'de Wi-Fi kartı bulunamadı"
  wifi=$(wifi_dev_free sat ap) || die "$(wifi_busy_why sat)"
  [[ $wifi =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "Wi-Fi kartının adı beklenmedik: $wifi"
  ap_capable "$wifi" || die "Wi-Fi kartı ($wifi) erişim noktası (AP) kipini desteklemiyor"
  # İlk bağlantı kabloyla: ana cihaza ulaşım ve eşleştirme eth üzerinden (kablosuz mesh sonradan eklenir).
  dr=$(default_route); ifc=${dr%% *}; gw=${dr#"$ifc"}; gw=${gw# }
  [ -n "$ifc" ] || die "varsayılan rota yok — uydu ev ağına bağlı değil"
  [ "$ifc" = "$wifi" ] && die "uydunun ağ bağlantısı Wi-Fi'dan geliyor — ilk kurulum için uyduyu kabloyla bağlayın"
  [ "$(dev_type "$ifc")" = ethernet ] || die "uydu kabloyla bağlı değil ($ifc)"
  [[ $ifc =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "arayüz adı beklenmedik: $ifc"
  valid_ssid "$ssid" || die "geçersiz ağ adı"
  valid_psk "$psk" || die "geçersiz parola"
  mac=$(tr 'A-F' 'a-f' < "/sys/class/net/$ifc/address" 2>/dev/null)
  [[ $mac =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || die "$ifc MAC adresi okunamadı"
  old_uuid=$(active_uuid "$ifc")
  [ -n "$old_uuid" ] || die "$ifc üzerinde etkin bir NetworkManager profili yok"
  old_name=$(nmcli -g connection.id connection show uuid "$old_uuid" 2>/dev/null)
  v6=$(nmcli -g ipv6.method connection show uuid "$old_uuid" 2>/dev/null)
  case "$v6" in auto|dhcp|ignore|link-local|disabled) ;; *) v6=auto ;; esac
  # DHCP istemci kimliği eski profildekiyle aynı (yoksa MAC): DHCP sunucusu uyduya aynı adresi versin.
  cid=$(nmcli -g ipv4.dhcp-client-id connection show uuid "$old_uuid" 2>/dev/null)
  [[ $cid =~ ^[A-Za-z0-9:._-]{1,64}$ ]] || cid=mac
  valid_ip "${gw:-x}" && ping -c2 -W2 "$gw" >/dev/null 2>&1 && base_ping=1
  [ "$(nmcli radio wifi 2>/dev/null)" = disabled ] && radio_off=1
  S_sat_iface=$ifc
  home_delete_all
  if ! sat_write_keyfiles "$wifi" "$ssid" "$psk" "$band" "$ch" "$mac" "$v6" "$cid" false; then
    home_delete_all; die "uydu profil dosyaları yazılamadı — değişiklik yapılmadı"
  fi
  if ! sat_load_all; then
    home_delete_all; die "uydu profilleri NetworkManager'a yüklenemedi: $HOME_LOAD_OUT — değişiklik yapılmadı"
  fi
  end=$(( $(date +%s) + trial ))
  S_sat_stage=trial; S_sat_trial_ends=$end; S_sat_old_uuid=$old_uuid; S_sat_old_name=$old_name; S_sat_wifi=$wifi
  S_sat_ssid=$ssid; S_sat_band=$band; S_sat_channel=$ch; S_sat_radio_was_off=$radio_off; S_sat_backhaul=wired; S_lan_if=$BR_IF
  if ! write_state; then home_delete_all; sat_reset; die "durum dosyası yazılamadı ($STATE_FILE) — değişiklik yapılmadı"; fi
  sat_stop_timer
  if ! systemd-run --quiet --collect --unit="$SAT_TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
       /bin/bash "$SELF" sat rollback >/dev/null 2>&1 9>&-; then
    home_delete_all; sat_reset; write_state
    die "geri alma zamanlayıcısı kurulamadı — uydu açılmadı"
  fi
  log "uydu denemesi: $ifc → $BR_IF, $wifi \"$ssid\" ($band kanal $ch, $trial sn)"
  # STP: port önce dinleme/öğrenme (2 × iletim gecikmesi) sonra iletir; DHCP bundan sonra tamamlanır.
  if ! out=$(nmcli -w 45 connection up id "$PORT_PROFILE" 2>&1); then
    why="köprü portu ($ifc) etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
  elif ! wait_sat_br 40 && ! { nmcli -w 30 connection up id "$BR_PROFILE" >/dev/null 2>&1 && wait_sat_br 20; }; then
    why="köprü adres almadı ($BR_IF: $(iface_addrs "$BR_IF" | csv); $ifc profili: $(active_conn "$ifc"))"
  elif [ -z "$(sat_gw)" ]; then
    why="köprüde varsayılan rota yok"
  elif [ "$base_ping" = 1 ] && ! ping -c3 -W2 "$(sat_gw)" >/dev/null 2>&1; then
    why="ağ geçidi ($(sat_gw)) köprüden ping'e yanıt vermiyor"
  fi
  if [ -z "$why" ] && [ "$radio_off" = 1 ]; then
    if out=$(nmcli radio wifi on 2>&1); then wait_dev_ready "$wifi" 15 || true
    else why="Wi-Fi açılamadı: $(printf '%s' "$out" | oneline)"; fi
  fi
  if [ -z "$why" ] && ! out=$(nmcli -w 30 connection up id "$HOME_PROFILE" 2>&1); then
    why="yayın etkinleştirilemedi: $(printf '%s' "$out" | oneline)"
  fi
  if [ -z "$why" ] && ! wait_home_ap "$wifi" 15; then
    why="yayın başlamadı (kartın etkin bağlantısı: $(active_conn "$wifi"))"
  fi
  if [ -n "$why" ]; then
    echo "detail=$why"
    sat_unwind; sat_finish_none; sat_stop_timer
    echo "rolled_back=1"
    log "uydu denemesi başarısız, geri alındı: $why"
    die "uydu açılamadı — eski ayara dönüldü"
  fi
  echo "sat_trial_ends=$end"
  echo "sat_ip=$(iface_addrs "$BR_IF" | head -1)"
  echo "ok=1"
}

cmd_sat_confirm() {
  local out p
  read_state
  [ "$S_sat_stage" = trial ] || die "uydu denemesi sürmüyor (süre dolduysa geri alınmıştır)"
  nm_running || die "NetworkManager çalışmıyor"
  sat_br_ok || die "uydu köprüsü etkin değil"
  home_ap_ok "$S_sat_wifi" || die "uydu yayında değil"
  for p in "$BR_PROFILE" "$HOME_PROFILE" ${S_sat_iface:+"$PORT_PROFILE"}; do
    out=$(nmcli connection modify id "$p" connection.autoconnect yes 2>&1) \
      || die "$p kalıcı yapılamadı: $(printf '%s' "$out" | oneline) — deneme sürüyor"
  done
  grep -q '^autoconnect=false' "$BR_KEYFILE" "$HOME_KEYFILE" ${S_sat_iface:+"$PORT_KEYFILE"} \
    && die "profiller kendiliğinden bağlanmaya ayarlanamadı — deneme sürüyor"
  sync
  { cp -f "$BR_KEYFILE" "$BR_BACKUP" && cp -f "$HOME_KEYFILE" "$HOME_BACKUP" \
      && { [ -z "$S_sat_iface" ] || cp -f "$PORT_KEYFILE" "$PORT_BACKUP"; } \
      && chmod 600 "$BR_BACKUP" "$HOME_BACKUP" && { [ -z "$S_sat_iface" ] || chmod 600 "$PORT_BACKUP"; }; } \
    || die "profil yedekleri yazılamadı — deneme sürüyor"
  sat_stop_timer
  S_sat_stage=on; S_sat_trial_ends=0
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  rm -f "$GUARD_STATUS"
  log "uydu kalıcı: $BR_IF (${S_sat_iface:-eth yok} + $S_sat_wifi \"$S_sat_ssid\")"
  echo "ok=1"
}

cmd_sat_rollback() {
  read_state
  [ "$S_sat_stage" = trial ] && sat_rollback_trial
  echo "ok=1"
}

cmd_sat_off() {
  read_state
  [ "$S_sat_stage" = none ] && { echo "ok=1"; return 0; }
  nm_running || die "NetworkManager çalışmıyor"
  sat_stop_timer
  sat_unwind
  sat_finish_none || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "uydu kapatıldı; eth0 eski profilinde"
  echo "ok=1"
}

# Yayın ayarlarını değiştirir (ana cihazda ağ adı / şifre / bant değişti ya da kanal planı): yalnız erişim noktası
# profili yeniden yazılır ve yeniden etkinleştirilir; köprü kesilmez. Başlamazsa önceki profile dönülür.
cmd_sat_apply() {
  local ssid="" psk="" band=bg ch="" prev out ac=false uuid
  while [ $# -gt 0 ]; do
    case "$1" in
      --ssid) ssid=${2:-}; shift ;;
      --band) band=${2:-}; shift ;;
      --channel) ch=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  IFS= read -r -t 30 psk || true
  case "$band" in bg|a) ;; *) die "geçersiz bant: $band" ;; esac
  if [ -z "$ch" ]; then if [ "$band" = a ]; then ch=36; else ch=6; fi; fi
  valid_channel "$band" "$ch" || die "geçersiz kanal: $ch"
  valid_ssid "$ssid" || die "geçersiz ağ adı"
  valid_psk "$psk" || die "geçersiz parola"
  read_state
  case "$S_sat_stage" in trial|on) ;; *) die "uydu açık değil" ;; esac
  nm_running || die "NetworkManager çalışmıyor"
  [ "$S_sat_stage" = on ] && ac=true
  prev=$(mktemp "$DIR/.home-prev.XXXXXX") || die "geçici dosya açılamadı"
  cp -f "$HOME_KEYFILE" "$prev" 2>/dev/null
  uuid=$(sed -n 's/^uuid=//p' "$HOME_KEYFILE" | head -1)
  [[ $uuid =~ ^[0-9a-f-]{36}$ ]] || uuid=$(new_uuid)
  if ! sat_write_ap_keyfile "$S_sat_wifi" "$ssid" "$psk" "$band" "$ch" "$ac" "$uuid" \
     || ! nmcli connection load "$HOME_KEYFILE" >/dev/null 2>&1; then
    rm -f "$prev"; die "yayın profili yazılamadı"
  fi
  if out=$(nmcli -w 30 connection up id "$HOME_PROFILE" 2>&1) && wait_home_ap "$S_sat_wifi" 15; then
    [ "$ac" = true ] && { cp -f "$HOME_KEYFILE" "$HOME_BACKUP"; chmod 600 "$HOME_BACKUP"; }
    rm -f "$prev"
    S_sat_ssid=$ssid; S_sat_band=$band; S_sat_channel=$ch
    write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
    log "uydu yayını güncellendi: \"$ssid\" ($band kanal $ch)"
    echo "ok=1"
    return 0
  fi
  echo "detail=$(printf '%s' "${out:-yayın başlamadı}" | oneline)"
  if [ -s "$prev" ]; then
    cp -f "$prev" "$HOME_KEYFILE" && chmod 600 "$HOME_KEYFILE" && nmcli connection load "$HOME_KEYFILE" >/dev/null 2>&1 \
      && nmcli -w 30 connection up id "$HOME_PROFILE" >/dev/null 2>&1
  fi
  rm -f "$prev"
  die "yeni yayın ayarı başlamadı — önceki ayara dönüldü"
}

cmd_sat() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    on) cmd_sat_on "$@" ;;
    confirm) cmd_sat_confirm ;;
    rollback) cmd_sat_rollback ;;
    off) cmd_sat_off ;;
    apply) cmd_sat_apply "$@" ;;
    *) die "kullanım: sat on --trial SN --ssid AD [--band bg|a] [--channel N] | sat confirm | sat rollback | sat off | sat apply --ssid AD [--band] [--channel]" ;;
  esac
}

# İnternet kartı denemesi. PPPoE parolası STDIN'in ilk satırından okunur; argv'ye, günlüğe, durum dosyasına ve
# çıktıya girmez (yalnız 0600 profil dosyasına).
cmd_wan_on() {
  local trial="" port="" type="" vlan="" prio="" mac="" mtu="" addr="" gw="" dns="" user="" pw="" d
  local dvendor="" dcid="" dhost="" single=0 ssid="" wifi=0
  local ip pfx n m net bc lan end out why="" wait_ip i dev a
  while [ $# -gt 0 ]; do
    case "$1" in
      --trial) trial=${2:-}; shift ;;
      --port) port=${2:-}; shift ;;
      --type) type=${2:-}; shift ;;
      --vlan) vlan=${2:-}; shift ;;
      --prio) prio=${2:-}; shift ;;
      --mac) mac=${2:-}; shift ;;
      --mtu) mtu=${2:-}; shift ;;
      --addr) addr=${2:-}; shift ;;
      --gw) gw=${2:-}; shift ;;
      --dns) dns=${2:-}; shift ;;
      --user) user=${2:-}; shift ;;
      --dhcp-vendor) dvendor=${2:-}; shift ;;
      --dhcp-client-id) dcid=${2:-}; shift ;;
      --dhcp-hostname) dhost=${2:-}; shift ;;
      --ssid) ssid=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  # Repeater (R4 A): --ssid verilirse kart Wi-Fi istemcidir; Wi-Fi parolası da (PPPoE gibi) STDIN'in ilk satırından.
  [ -n "$ssid" ] && wifi=1
  if [ "$type" = pppoe ] || [ "$wifi" = 1 ]; then
    if [ -t 0 ]; then
      printf "Parola: " >&2
      IFS= read -r -s -t 120 pw || true
      echo >&2
    else
      IFS= read -r -t 30 pw || true
    fi
  fi
  # 1. Girdiler
  { [[ $trial =~ ^[0-9]{1,5}$ ]] && [ "$((10#$trial))" -ge 30 ] && [ "$((10#$trial))" -le 3600 ]; } \
    || die "geçersiz deneme süresi (--trial 30-3600 sn)"
  trial=$((10#$trial))
  [[ $port =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "geçersiz kart adı: ${port:-yok}"
  case "$type" in dhcp|static|pppoe) ;; *) die "geçersiz bağlantı türü: ${type:-yok} (dhcp | static | pppoe)" ;; esac
  if [ -n "$vlan" ]; then
    { [[ $vlan =~ ^[0-9]{1,4}$ ]] && [ "$((10#$vlan))" -ge 1 ] && [ "$((10#$vlan))" -le 4094 ]; } \
      || die "geçersiz VLAN numarası: $vlan (1-4094)"
    vlan=$((10#$vlan))
  fi
  if [ -n "$prio" ]; then
    [ -n "$vlan" ] || die "VLAN önceliği yalnız VLAN numarasıyla birlikte verilir"
    [[ $prio =~ ^[0-7]$ ]] || die "geçersiz VLAN önceliği: $prio (0-7)"
  fi
  if [ -n "$mac" ]; then
    mac=${mac,,}; mac=${mac//-/:}
    [[ $mac =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] || die "geçersiz MAC adresi: $mac (ör. 00:11:22:33:44:55)"
    [ $(( 0x${mac:0:2} & 1 )) = 0 ] || die "MAC adresi tekil (unicast) olmalı: $mac"
    [ "$mac" != 00:00:00:00:00:00 ] || die "MAC adresi 00:00:00:00:00:00 olamaz"
  fi
  if [ -n "$mtu" ]; then
    [[ $mtu =~ ^[0-9]{3,4}$ ]] || die "geçersiz MTU: $mtu"
    mtu=$((10#$mtu))
    # PPPoE 1492 üstü (en çok 1500): RFC 4638 — operatör destekliyorsa; altındaki arayüz MTU + 8 alır.
    if [ "$type" = pppoe ]; then { [ "$mtu" -ge 576 ] && [ "$mtu" -le 1500 ]; } || die "PPPoE MTU 576-1500 arasında olmalı ($mtu)"
    else { [ "$mtu" -ge 576 ] && [ "$mtu" -le 9000 ]; } || die "MTU 576-9000 arasında olmalı ($mtu)"; fi
  fi
  if [ "$type" = static ]; then
    [[ $addr =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || die "geçersiz sabit adres: ${addr:-yok} (ör. 203.0.113.10/24)"
    ip=${BASH_REMATCH[1]}; pfx=$((10#${BASH_REMATCH[2]}))
    valid_ip "$ip" || die "geçersiz sabit adres: $addr"
    { [ "$pfx" -ge 8 ] && [ "$pfx" -le 30 ]; } || die "sabit adresin öneki 8-30 arasında olmalı (/$pfx)"
    n=$(ip2int "$ip"); m=$(pmask "$pfx"); net=$(( n & m )); bc=$(( net | (~m & 0xFFFFFFFF) ))
    { [ "$n" -ne "$net" ] && [ "$n" -ne "$bc" ]; } || die "sabit adres ağ ya da yayın adresi olamaz: $addr"
    addr="$ip/$pfx"
    valid_ip "$gw" || die "geçersiz ağ geçidi: ${gw:-yok}"
    in_net "$gw" "$addr" || die "ağ geçidi ($gw) sabit adresin ağında ($addr) değil"
    [ "$gw" != "$ip" ] || die "ağ geçidi sabit adresle aynı olamaz"
    if [ -n "$dns" ]; then
      i=0
      for d in ${dns//,/ }; do valid_ip "$d" || die "geçersiz DNS adresi: $d"; i=$((i + 1)); done
      [ "$i" -le 3 ] || die "en çok 3 DNS adresi verilebilir"
    fi
  else
    addr=""; gw=""; dns=""
  fi
  # DHCP kimlik seçenekleri (yalnız otomatik adreste): yazdırılabilir ASCII, ters bölü yok, başta / sonda boşluk yok.
  if [ "$type" = dhcp ]; then
    for d in "$dvendor" "$dcid"; do
      [ -z "$d" ] && continue
      { [[ $d =~ ^[!-~]([\ -~]{0,62}[!-~])?$ ]] && [[ $d != *\\* ]]; } \
        || die "geçersiz DHCP kimlik değeri: 1-64 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz"
    done
    if [ -n "$dhost" ]; then
      [[ $dhost =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,62})$ ]] || die "geçersiz cihaz adı: $dhost (harf, rakam, . -; en çok 63)"
    fi
  else
    dvendor=""; dcid=""; dhost=""
  fi
  if [ "$type" = pppoe ]; then
    { [[ $user =~ ^[!-~]{1,64}$ ]] && [[ $user != *\\* ]]; } \
      || die "geçersiz PPPoE kullanıcı adı: 1-64 karakter, boşluk ve ters bölü (\\) olmaz"
    { [[ $pw =~ ^[!-~]([\ -~]{0,126}[!-~])?$ ]] && [[ $pw != *\\* ]]; } \
      || die "geçersiz PPPoE parolası: 1-128 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz"
  else
    user=""
    [ "$wifi" = 1 ] || pw=""
  fi
  # Repeater (R4 A): Wi-Fi istemci — DHCP ya da sabit adres (PPPoE ve VLAN üst modemin işidir), WPA2/WPA3 kişisel parola.
  if [ "$wifi" = 1 ]; then
    [ "$type" != pppoe ] || die "Wi-Fi bağlantısında PPPoE kullanılmaz — PPPoE'yi üst modem / router yapar"
    [ -z "$vlan" ] || die "Wi-Fi bağlantısında VLAN kullanılmaz"
    { [ "$(printf '%s' "$ssid" | wc -c)" -le 32 ] && ! [[ $ssid =~ [[:cntrl:]] ]]; } \
      || die "geçersiz Wi-Fi ağ adı: 1-32 bayt, denetim karakteri olmadan"
    valid_psk "$pw" || die "geçersiz Wi-Fi parolası: 8-63 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz"
  fi
  # 2. Ön koşullar
  read_state
  command -v nmcli >/dev/null 2>&1 || die "nmcli bulunamadı (NetworkManager kurulu değil)"
  nm_running || die "NetworkManager çalışmıyor"
  command -v nft >/dev/null 2>&1 || die "nft bulunamadı (nftables kurulu değil) — internet kartı korumasız açılmaz"
  [ "$S_wan_stage" = on ] && die "internet kartı (WAN router) zaten açık"
  [ "$S_wan_stage" = trial ] && die "internet kartı denemesi sürüyor"
  [ "$S_sat_stage" = none ] || die "bu cihaz uydu olarak çalışıyor — internet kartı ana cihaz içindir"
  [ "$S_stage" = static ] || die "önce DHCP Ayarları sihirbazında Pi'ye sabit adres verip kalıcı yapın"
  [ "$S_home_stage" = trial ] && die "ev Wi-Fi'ı denemesi sürüyor — önce kalıcı yapın ya da geri alın"
  pi_dhcp_active || die "önce Pi DHCP sunucusunu açın (DHCP Ayarları) — internet kartına geçince ev ağındaki cihazlara adresi yalnız Pi verir"
  # Pi DHCP denemesi geri alınırsa ev ağı adressiz kalırdı: deneme bitmiş (kalıcı) olmalı.
  [ "$(sed -n 's/^stage=//p' /etc/pi5-gateway/dhcp/state 2>/dev/null)" = trial ] \
    && die "Pi DHCP denemesi sürüyor — önce DHCP Ayarları'nda kalıcı yapın"
  lan=$(lan_dev)
  lan_addrs_ok "$lan" || die "ev ağı adresleri ($lan) beklenen düzende değil — önce DHCP Ayarları'ndaki uyarıyı giderin"
  [ -e "/sys/class/net/$port" ] || die "$port adlı kart yok"
  # Yedek hat: kartı / VLAN'ı ana hat olamaz; yedek hattayken deneme internet rotasını ana hattan denetleyemez.
  if [ "$S_bak_stage" != none ]; then
    bak_failed_over && die "yedek hat devrede (ana hat çalışmıyor) — internet kartı denemesi rotayı ana hattan denetler; ana hat dönünce ya da yedek hattı kapatınca deneyin"
    if [ "$S_bak_kind" = eth ] && [ "$port" = "$S_bak_port" ] && ! bak_on_lan_card; then
      die "$port yedek hattın kartı — ana hat için başka bir kart seçin ya da önce yedek hattı kapatın"
    fi
    if [ "$S_bak_kind" = eth ] && bak_on_lan_card && [ "$port" = "$S_iface" ] && [ "$vlan" = "$S_bak_vlan" ]; then
      die "VLAN $vlan yedek hatta kullanılıyor — ana hat için başka bir VLAN numarası girin"
    fi
    if [ "$S_bak_kind" = usb ]; then
      case " $S_bak_match " in *" $(dev_driver "$port") "*) die "$port USB modem sürücüsünü ($(dev_driver "$port")) kullanıyor — yedek hat (USB) bu kartı alabilir; önce yedek hattı kapatın" ;; esac
    fi
  fi
  # Tek port: ev ağı kartı internete de bağlanır — yalnız VLAN ile (anahtar internet trafiğini etiketli getirir).
  if [ "$port" = "$S_iface" ]; then
    [ -n "$vlan" ] || die "$port ev ağı kartı — aynı porttan internet için VLAN numarası girin (VLAN destekli anahtar internet trafiğini etiketli getirir) ya da ikinci bir Ethernet kartı seçin"
    if [ -n "$mtu" ]; then
      if [ "$type" = pppoe ] && [ "$mtu" -gt 1492 ]; then die "tek portta PPPoE MTU en çok 1492 olabilir (ev ağı kartının MTU'su değiştirilmez)"; fi
      [ "$mtu" -le 1500 ] || die "tek portta MTU en çok 1500 olabilir (ev ağı kartının MTU'su değiştirilmez)"
    fi
    single=1
  fi
  if [ "$wifi" = 1 ]; then
    [ "$(dev_type "$port")" = wifi ] || die "$port bir Wi-Fi kartı değil — Wi-Fi ağ adı yalnız Wi-Fi kartıyla verilir"
    i=$(radio_user "$port" wan)
    [ -z "$i" ] || die "$port şu an $i için kullanılıyor — üst Wi-Fi bağlantısı için başka bir Wi-Fi kartı seçin"
  else
    [ "$(dev_type "$port")" = ethernet ] || die "$port bir Ethernet kartı değil"
  fi
  if [ "$single" = 0 ] && [ -e "/sys/class/net/$port/master" ]; then
    die "$port bir köprünün ($(basename "$(readlink "/sys/class/net/$port/master")")) portu"
  fi
  # Wi-Fi'da "kablo" bağlanınca gelir: burada denetlenmez (bağlanamazsa deneme anlaşılır nedenle geri alınır).
  if [ "$wifi" = 0 ]; then
    [ "$(carrier "$port")" = 1 ] || die "$port kartında kablo bağlantısı yok — modemi / ONT'yi bu karta bağlayın"
  fi
  if [ "$type" = pppoe ]; then
    { command -v pppd >/dev/null 2>&1 && compgen -G '/usr/lib/*/NetworkManager/*/libnm-ppp-plugin.so' >/dev/null; } \
      || die "PPPoE bileşeni (ppp) kurulu değil — panelden güncelleyin ya da: sudo apt install ppp"
  fi
  if [ -n "$vlan" ] && [ ! -d /sys/module/8021q ]; then
    modprobe 8021q >/dev/null 2>&1 || die "VLAN desteği (8021q çekirdek modülü) yüklenemedi"
  fi
  # Wi-Fi: radyo kapalıysa (Faz 2'de kapatılmış olabilir) açılır; kartta ve boştaki öbür kartlarda başka profil (Pi'nin
  # eski Wi-Fi istemci profili) etkinse bağlantısı kesilir — üst ağa yalnız bu kurulumun profili bağlansın.
  if [ "$wifi" = 1 ]; then
    if [ "$(nmcli radio wifi 2>/dev/null)" = disabled ]; then
      nmcli radio wifi on >/dev/null 2>&1 && wait_dev_ready "$port" 15 || true
    fi
    wifi_idle_quiet
  fi
  # 3. Profiller (önceki denemeden kalmış kopyalar silinir; yalnız bu dosyalar yüklenir). Durum alanları profil
  #    yazımından önce doldurulur (yazıcılar onları okur); durum dosyası zamanlayıcıyla birlikte yazılır.
  S_wan_port=$port; S_wan_type=$type; S_wan_vlan=$vlan; S_wan_prio=$prio; S_wan_mac=$mac; S_wan_mtu=$mtu
  S_wan_user=$user; S_wan_addr=$addr; S_wan_gw=$gw; S_wan_dns=$dns; S_wan_lan=0
  S_wan_dhcp_vendor=$dvendor; S_wan_dhcp_cid=$dcid; S_wan_dhcp_host=$dhost; S_wan_ssid=$ssid
  S_wan_dev=$(wan_l3_of "$port" "$type" "$vlan")
  # Aynı kart daha önce park edildiyse park profili kalkar (ikisi de öncelik 200: NM hangisini seçeceğini bilemez).
  [ "$(nmcli -g connection.interface-name connection show id "$WAN_IDLE_PROFILE" 2>/dev/null)" = "$port" ] && wan_unpark
  wan_delete_all
  wan_write_keyfiles "$pw" || { wan_delete_all; die "internet kartı profil dosyaları yazılamadı — değişiklik yapılmadı"; }
  pw=""
  if ! wan_load_all; then
    wan_delete_all
    die "internet kartı profilleri NetworkManager'a yüklenemedi: $WAN_LOAD_OUT — değişiklik yapılmadı"
  fi
  # 4. Durum + geri alma zamanlayıcısı DEĞİŞİKLİKTEN ÖNCE (bkz. static). Kilit tanımlayıcısı (9) devredilmez.
  end=$(( $(date +%s) + trial ))
  S_wan_stage=trial; S_wan_trial_ends=$end
  if ! write_state; then
    wan_delete_all
    die "durum dosyası yazılamadı ($STATE_FILE) — değişiklik yapılmadı"
  fi
  wan_stop_timer
  if ! systemd-run --quiet --collect --unit="$WAN_TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
       /bin/bash "$SELF" wan rollback >/dev/null 2>&1 9>&-; then
    wan_delete_all; wan_reset; write_state
    die "geri alma zamanlayıcısı kurulamadı — internet kartı açılmadı"
  fi
  log "internet kartı denemesi: $port ($type${vlan:+, VLAN $vlan}${S_wan_dev:+ → $S_wan_dev}, $trial sn)"
  # 5. Güvenlik duvarı bağlantıdan ÖNCE: yüklenemezse kart hiç bağlanmaz.
  if ! wan_nft_load; then
    why="güvenlik duvarı (pi5_wan) yüklenemedi: $WAN_NFT_OUT"
  else
    wan_fw_unit_install || echo "warning=açılış birimi ($WAN_FW_UNIT) kurulamadı — güvenlik duvarını açılışta ağ koruması yükler"
  fi
  # 6. Bağlan ve adresi bekle (PPPoE oturumu ve DHCP yavaş olabilir).
  if [ -z "$why" ] && ! wan_up; then why=$WAN_UP_OUT; fi
  if [ -z "$why" ]; then
    wait_ip=30; [ "$type" = pppoe ] && wait_ip=45; [ "$type" = static ] && wait_ip=10
    wait_wan_ip "$wait_ip" || why="internet kartı adres ya da varsayılan rota almadı ($S_wan_dev: $(wan_ip | csv))"
  fi
  # 7. Adres çakışmaları: ev ağı (cihaz adresi), kurulum Wi-Fi'ı, diğer arayüzler (VPN tünelleri dahil). Modem tarafı
  #    ağ (transit) ile çakışma beklenir (modem kablosu eth0'dan internet kartına taşındıysa): o adres 8. adımda kalkar.
  if [ -z "$why" ]; then
    ip=$(wan_ip)
    if nets_overlap "$ip" "$S_client"; then
      why="internet kartının adresi ($ip) ev ağıyla ($S_client) çakışıyor — modemin ağını değiştirin ya da modemi köprü kipine alın"
    elif [ "$S_ap_stage" != none ] && nets_overlap "$ip" "$AP_NET"; then
      why="internet kartının adresi ($ip) kurulum Wi-Fi'ı ağıyla ($AP_NET) çakışıyor"
    else
      while read -r dev a; do
        case "$dev" in lo|"$S_wan_port"|"$S_wan_dev"|"wan.$vlan"|"$S_iface"|"$BR_IF") continue ;; esac
        if nets_overlap "$ip" "$a"; then why="internet kartının adresi ($ip) $dev arayüzündeki $a ile çakışıyor"; break; fi
      done < <(ip -4 -o addr show 2>/dev/null | awk '{ print $2, $4 }')
    fi
  fi
  # 8. Ev ağı profilleri yalnız ev ağına: modem tarafı adres ve ağ geçidi kalkar (cihaz adresi kalır).
  if [ -z "$why" ]; then
    if lan_profiles_set lanonly; then
      S_wan_lan=1
      write_state
      wait_lan "$lan" 15 || why="ev ağı adresi ($S_client) $lan üzerinde görünmüyor"
    else
      why="ev ağı profili çevrilemedi: $LAN_SET_OUT"
      S_wan_lan=1   # yarım kalmış olabilir: geri dönüş iki profili de eski düzene çevirir
    fi
  fi
  # 9. İnternet rotası ve erişim (en çok ~20 sn).
  if [ -z "$why" ]; then
    for i in 1 2 3 4 5 6 7 8 9 10; do
      [[ " $(ip -4 route get 1.1.1.1 2>/dev/null | head -1) " == *" dev $S_wan_dev "* ]] && break
      sleep 1
    done
    if [[ " $(ip -4 route get 1.1.1.1 2>/dev/null | head -1) " != *" dev $S_wan_dev "* ]]; then
      why="internet rotası $S_wan_dev üzerinden değil: $(ip -4 route get 1.1.1.1 2>&1 | head -1 | oneline)"
    fi
  fi
  if [ -z "$why" ]; then
    for i in 1 2 3; do wan_internet_ok && break; sleep 2; done
    wan_internet_ok || why="internet kartından internete ulaşılamıyor (adres $(wan_ip), ağ geçidi $(wan_gateway))"
  fi
  if [ -n "$why" ]; then
    echo "detail=$why"
    wan_unwind
    lan_backups_refresh onearm >/dev/null 2>&1 || true
    wan_finish_none; wan_stop_timer
    echo "rolled_back=1"
    log "internet kartı denemesi başarısız, geri alındı: $why"
    die "internet kartı açılamadı — eski ayara dönüldü"
  fi
  echo "wan_trial_ends=$end"
  echo "wan_ip=$(wan_ip)"
  echo "wan_gateway=$(wan_gateway)"
  echo "ok=1"
}

cmd_wan_confirm() {
  local p f out
  read_state
  [ "$S_wan_stage" = trial ] || die "internet kartı denemesi sürmüyor (süre dolduysa geri alınmıştır)"
  nm_running || die "NetworkManager çalışmıyor"
  [ "$S_wan_lan" = 1 ] || die "ev ağı profili henüz çevrilmedi — 'Geri al' ile başa dönün"
  wan_up_ok || die "internet kartı bağlı değil ($S_wan_dev: adres ya da varsayılan rota yok) — deneme sürüyor"
  wan_internet_ok || die "internet kartından internete ulaşılamıyor — deneme sürüyor, süre dolunca geri alınır"
  for p in $(wan_profiles); do
    out=$(nmcli connection modify id "$p" connection.autoconnect yes 2>&1) \
      || die "$p kalıcı yapılamadı: $(printf '%s' "$out" | oneline) — deneme sürüyor"
  done
  wan_loaded || die "internet kartı profil dosyaları doğrulanamadı — deneme sürüyor, süre dolunca geri alınır"
  for p in $(wan_profiles); do
    f=$(wan_keyfile_of "$p")
    grep -q '^autoconnect=false' "$f" && die "$p kendiliğinden bağlanmaya ayarlanamadı — deneme sürüyor"
  done
  if [ "$S_wan_type" = pppoe ]; then
    grep -q '^password=.' "$WAN_PPP_KEYFILE" || die "PPPoE profilinde parola yok — deneme sürüyor"
  fi
  verify_lan_only "$KEYFILE" || die "ev ağı profil dosyası ($KEYFILE) beklenen düzende değil — deneme sürüyor"
  if [ "$S_home_stage" = on ]; then
    verify_lan_only "$BR_KEYFILE" || die "köprü profil dosyası ($BR_KEYFILE) beklenen düzende değil — deneme sürüyor"
  fi
  sync
  mkdir -p "$WAN_BACKUP_DIR" && chmod 700 "$WAN_BACKUP_DIR" || die "yedek dizini oluşturulamadı — deneme sürüyor"
  for p in $(wan_profiles); do
    f=$(wan_keyfile_of "$p")
    { cp -f "$f" "$WAN_BACKUP_DIR/$(basename "$f")" && chmod 600 "$WAN_BACKUP_DIR/$(basename "$f")"; } \
      || die "profil yedeği yazılamadı — deneme sürüyor"
  done
  lan_backups_refresh lanonly || die "ev ağı profil yedekleri yazılamadı — deneme sürüyor"
  [ -e "/etc/systemd/system/$WAN_FW_UNIT.service" ] || wan_fw_unit_install \
    || echo "warning=açılış birimi ($WAN_FW_UNIT) kurulamadı — güvenlik duvarını açılışta ağ koruması yükler"
  wan_stop_timer
  S_wan_stage=on; S_wan_trial_ends=0
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  rm -f "$WAN_GUARD_STATUS"
  log "internet kartı kalıcı: $S_wan_port ($S_wan_type → $S_wan_dev)"
  echo "ok=1"
}

cmd_wan_rollback() {
  read_state
  [ "$S_wan_stage" = trial ] && wan_rollback_trial
  echo "ok=1"
}

# Bilinçli kapatma (kalıcıdan ya da denemeden): internet kartı kalkar, ev ağı profilleri eski (tek kollu) düzene döner.
# Modem kablosu eth0'dan internet kartına taşındıysa Pi'nin interneti kablo geri takılana kadar yoktur; ev ağı çalışır.
cmd_wan_off() {
  read_state
  [ "$S_wan_stage" = none ] && die "internet kartı (WAN router) açık değil"
  nm_running || die "NetworkManager çalışmıyor"
  wan_stop_timer
  wan_unwind
  lan_backups_refresh onearm || echo "warning=ev ağı profil yedekleri yenilenemedi — açılış koruması onarır"
  wan_finish_none || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "internet kartı kapatıldı; eski (tek kollu) düzene dönüldü"
  echo "ok=1"
}

# Güvenlik duvarını yeniden yükler (Ev VPN'i açıldı / kapandı / portu değişti, nftables yeniden başlatıldı).
cmd_wan_fw() {
  read_state
  if [ "$S_wan_stage" != none ]; then
    wan_nft_load || die "güvenlik duvarı (pi5_wan) yüklenemedi: $WAN_NFT_OUT"
  elif [ -e "$WAN_NFT" ]; then
    wan_nft_remove
  fi
  echo "ok=1"
}

cmd_wan() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    on) cmd_wan_on "$@" ;;
    confirm) cmd_wan_confirm ;;
    rollback) cmd_wan_rollback ;;
    off) cmd_wan_off ;;
    fw) cmd_wan_fw ;;
    *) die "kullanım: wan on --trial SN --port KART --type dhcp|static|pppoe [...] | wan confirm | wan rollback | wan off | wan fw" ;;
  esac
}

# Yedek hattı kurar ve hemen sınar (deneme süresi yok: ana hat ve ev ağı değişmez, yedek hat düşük öncelikte bekler).
# PPPoE parolası / Wi-Fi parolası STDIN'in ilk satırından. Başarısızsa her şey geri alınır (rolled_back=1).
cmd_backup_on() {
  local kind="" type="" port="" vlan="" mtu="" addr="" gw="" dns="" user="" ssid="" secret="" d i p drv cands
  local ip pfx n m net bc bip radio_off=0 why=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind=${2:-}; shift ;;
      --type) type=${2:-}; shift ;;
      --port) port=${2:-}; shift ;;
      --vlan) vlan=${2:-}; shift ;;
      --mtu) mtu=${2:-}; shift ;;
      --addr) addr=${2:-}; shift ;;
      --gw) gw=${2:-}; shift ;;
      --dns) dns=${2:-}; shift ;;
      --user) user=${2:-}; shift ;;
      --ssid) ssid=${2:-}; shift ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift
  done
  [ -n "$type" ] || type=dhcp
  if [ "$type" = pppoe ] || [ "$kind" = wifi ]; then
    if [ -t 0 ]; then
      printf "Parola: " >&2
      IFS= read -r -s -t 120 secret || true
      echo >&2
    else
      IFS= read -r -t 30 secret || true
    fi
  fi
  read_state
  command -v nmcli >/dev/null 2>&1 || die "nmcli bulunamadı (NetworkManager kurulu değil)"
  nm_running || die "NetworkManager çalışmıyor"
  [ "$S_bak_stage" = none ] || die "yedek hat zaten açık — değiştirmek için önce kapatın"
  [ "$S_sat_stage" = none ] || die "bu cihaz uydu — yedek hat ana cihaz içindir"
  [ "$S_stage" = static ] || die "önce Pi'ye sabit adres verip kalıcı yapın (DHCP Ayarları) — yedek hat Pi ağ geçidiyken çalışır"
  [ "$S_home_stage" = trial ] && die "ev Wi-Fi'ı denemesi sürüyor — önce kalıcı yapın ya da geri alın"
  [ "$S_wan_stage" = trial ] && die "internet kartı (WAN router) denemesi sürüyor — önce kalıcı yapın ya da geri alın"
  pi_dhcp_active || die "Pi DHCP sunucusu kapalı — yedek hat, ev ağındaki cihazlar Pi'yi ağ geçidi olarak kullanırken çalışır (DHCP Ayarları)"
  case "$kind" in eth|usb|wifi) ;; *) die "yedek hat türü eth (Ethernet), usb (USB modem / telefon) ya da wifi (hotspot) olmalı" ;; esac
  case "$type" in dhcp|static|pppoe) ;; *) die "bağlantı türü dhcp, static ya da pppoe olmalı" ;; esac
  [ "$kind" = eth ] || [ "$type" = dhcp ] || die "USB modem / telefon ve hotspot yedek hattı yalnız otomatik adresle (DHCP) çalışır"
  [ "$kind" = eth ] || [ -z "$vlan" ] || die "VLAN yalnız Ethernet yedek hatta kullanılır"
  if [ -n "$vlan" ]; then
    { [[ $vlan =~ ^[0-9]{1,4}$ ]] && [ "$((10#$vlan))" -ge 1 ] && [ "$((10#$vlan))" -le 4094 ]; } || die "geçersiz VLAN numarası: $vlan (1-4094)"
    vlan=$((10#$vlan))
  fi
  if [ -n "$mtu" ]; then
    [[ $mtu =~ ^[0-9]{3,4}$ ]] || die "geçersiz MTU: $mtu"
    mtu=$((10#$mtu))
    if [ "$type" = pppoe ]; then { [ "$mtu" -ge 576 ] && [ "$mtu" -le 1500 ]; } || die "PPPoE MTU 576-1500 arasında olmalı ($mtu)"
    else { [ "$mtu" -ge 576 ] && [ "$mtu" -le 9000 ]; } || die "MTU 576-9000 arasında olmalı ($mtu)"; fi
  fi
  if [ "$type" = static ]; then
    [[ $addr =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || die "geçersiz sabit adres: ${addr:-yok} (ör. 203.0.113.10/24)"
    ip=${BASH_REMATCH[1]}; pfx=$((10#${BASH_REMATCH[2]}))
    valid_ip "$ip" || die "geçersiz sabit adres: $addr"
    { [ "$pfx" -ge 8 ] && [ "$pfx" -le 30 ]; } || die "sabit adresin öneki 8-30 arasında olmalı (/$pfx)"
    n=$(ip2int "$ip"); m=$(pmask "$pfx"); net=$(( n & m )); bc=$(( net | (~m & 0xFFFFFFFF) ))
    { [ "$n" -ne "$net" ] && [ "$n" -ne "$bc" ]; } || die "sabit adres ağ ya da yayın adresi olamaz: $addr"
    addr="$ip/$pfx"
    valid_ip "$gw" || die "geçersiz ağ geçidi: ${gw:-yok}"
    in_net "$gw" "$addr" || die "ağ geçidi ($gw) sabit adresin ağında ($addr) değil"
    [ "$gw" != "$ip" ] || die "ağ geçidi sabit adresle aynı olamaz"
    if [ -n "$dns" ]; then
      i=0
      for d in ${dns//,/ }; do valid_ip "$d" || die "geçersiz DNS adresi: $d"; i=$((i + 1)); done
      [ "$i" -le 3 ] || die "en çok 3 DNS adresi verilebilir"
    fi
  else
    addr=""; gw=""; dns=""
  fi
  if [ "$type" = pppoe ]; then
    { [[ $user =~ ^[!-~]{1,64}$ ]] && [[ $user != *\\* ]]; } \
      || die "geçersiz PPPoE kullanıcı adı: 1-64 karakter, boşluk ve ters bölü (\\) olmaz"
    { [[ $secret =~ ^[!-~]([\ -~]{0,126}[!-~])?$ ]] && [[ $secret != *\\* ]]; } \
      || die "geçersiz PPPoE parolası: 1-128 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz"
  else
    user=""
  fi
  case "$kind" in
    eth)
      [[ $port =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "yedek hat kartını seçin (--port)"
      [ -e "/sys/class/net/$port" ] || die "kart bulunamadı: $port"
      [ -e "/sys/class/net/$port/wireless" ] || [ -e "/sys/class/net/$port/phy80211" ] && die "$port bir Wi-Fi kartı — hotspot için wifi türünü seçin"
      [ -e "/sys/class/net/$port/bridge" ] && die "$port bir köprü — kablolu bir kart seçin"
      [ "$port" = "$BR_IF" ] && die "$port bir köprü"
      if [ -n "$S_wan_port" ] && [ "$port" = "$S_wan_port" ]; then
        die "$port ana hattın (internet kartı) kartı — yedek hat için başka bir kart seçin"
      fi
      if [ "$port" = "$S_iface" ]; then
        # Ev ağı kartı: yedek hat VLAN destekli anahtardan etiketli gelir, ev ağı aynı porttan etiketsiz akar.
        [ -n "$vlan" ] || die "$port ev ağı kartı — aynı porttan yedek hat için VLAN numarası girin (VLAN destekli anahtar yedek hattı etiketli getirir) ya da başka bir kart seçin"
        if [ "$S_wan_stage" != none ] && [ "$S_wan_port" = "$S_iface" ] && [ "$S_wan_vlan" = "$vlan" ]; then
          die "VLAN $vlan ana hatta kullanılıyor — yedek hat için başka bir VLAN numarası girin"
        fi
        if [ "$type" = pppoe ] && [ -n "$mtu" ] && [ "$mtu" -gt 1492 ]; then die "ev ağı kartında PPPoE MTU en çok 1492 olabilir (kartın MTU'su değiştirilmez)"; fi
        if [ -n "$mtu" ] && [ "$mtu" -gt 1500 ]; then die "ev ağı kartında MTU en çok 1500 olabilir"; fi
      elif [ -n "$(basename "$(readlink "/sys/class/net/$port/master" 2>/dev/null)" 2>/dev/null)" ]; then
        die "$port bir köprünün portu — yedek hat olamaz"
      fi ;;
    usb)
      port=""
      S_bak_match=${PI5_BAK_USB_DRIVERS:-$BAK_USB_DRIVERS}
      [[ $S_bak_match =~ ^[a-z0-9_]+( [a-z0-9_]+)*$ ]] || die "geçersiz sürücü listesi"
      # Ev ağı / ana hat kartı aynı sürücüyü kullanıyorsa eşleşme onları da alırdı. (PI5_BAK_USB_DRIVERS ve
      # PI5_BAK_TEST_SAME_DRIVER=1 yalnız test kabı içindir: orada tüm kartlar veth.)
      for p in "$S_iface" "$S_wan_port"; do
        [ "${PI5_BAK_TEST_SAME_DRIVER:-0}" = 1 ] && break
        [ -n "$p" ] && [ -e "/sys/class/net/$p" ] || continue
        drv=$(dev_driver "$p")
        case " $S_bak_match " in *" $drv "*) die "$p ($( [ "$p" = "$S_iface" ] && echo 'ev ağı kartı' || echo 'ana hattın kartı' )) da USB modem sürücüsünü ($drv) kullanıyor — yedek hat için Ethernet türünü seçin" ;; esac
      done ;;
    wifi)
      # Radyo: verilmezse başka işte olmayan ilk kart (iki radyoda ev Wi-Fi'ı yayını öbür kartta sürer).
      if [ -z "$port" ]; then port=$(wifi_dev_free bak) || die "$(wifi_busy_why bak)"; fi
      [[ $port =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "Wi-Fi kartı bulunamadı"
      [ "$(dev_type "$port")" = wifi ] || die "$port bir Wi-Fi kartı değil"
      p=$(radio_user "$port" bak)
      [ -z "$p" ] || die "Wi-Fi kartı ($port) şu an $p için kullanılıyor — hotspot yedek hattı için boş bir Wi-Fi kartı gerekir"
      { [ -n "$ssid" ] && [ "$(printf '%s' "$ssid" | wc -c)" -le 32 ] && ! [[ $ssid =~ [[:cntrl:]] ]]; } \
        || die "geçersiz ağ adı: 1-32 bayt, denetim karakteri olmadan"
      valid_psk "$secret" || die "geçersiz hotspot parolası: 8-63 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta / sonda boşluk olmaz" ;;
  esac
  [ "$kind" = wifi ] || ssid=""
  S_bak_kind=$kind; S_bak_type=$type; S_bak_port=$port; S_bak_vlan=$vlan; S_bak_mtu=$mtu; S_bak_user=$user
  S_bak_addr=$addr; S_bak_gw=$gw; S_bak_dns=$dns; S_bak_ssid=$ssid
  [ "$kind" = usb ] || S_bak_match=""
  if [ "$type" = pppoe ]; then S_bak_dev=$BAK_PPP_IF; elif [ -n "$vlan" ]; then S_bak_dev="bak.$vlan"; else S_bak_dev=$port; fi
  if [ "$kind" = usb ]; then
    cands=$(bak_tag_usb | csv)
    [ -n "$cands" ] || die "USB modem ya da telefon bulunamadı — modemi takın (telefonda 'USB ile internet paylaşımı'nı açın), birkaç saniye bekleyip yeniden deneyin"
  fi
  # 1. Güvenlik duvarı profillerden ÖNCE (yedek hat bağlanırken korumasız an olmaz).
  bak_nft_load || die "güvenlik duvarı (pi5_bak) yüklenemedi: $BAK_NFT_OUT"
  bak_fw_unit_install || echo "warning=açılış güvenlik duvarı birimi ($BAK_FW_UNIT) kurulamadı — açılışta nftables.service yükler"
  if [ "$kind" = usb ]; then bak_udev_install || echo "warning=udev kuralı yazılamadı — izleyici arayüzleri 5 sn'de bir işaretler"; fi
  # 2. Wi-Fi kartı: kapalıysa açılır; kartta başka profil (ör. ev modemine bağlanan eski Wi-Fi profili) etkinse indirilir.
  if [ "$kind" = wifi ] && [ "$(nmcli radio wifi 2>/dev/null)" = disabled ]; then
    radio_off=1
    nmcli radio wifi on >/dev/null 2>&1 && wait_dev_ready "$port" 15 || true
  fi
  S_bak_radio_was_off=$radio_off
  bak_evict_foreign
  # 3. Profiller
  bak_delete_all
  if ! bak_write_keyfiles "$secret"; then why="profil dosyaları yazılamadı"
  elif ! bak_load_all; then why="profiller yüklenemedi: $BAK_LOAD_OUT"
  elif ! bak_up; then why=$BAK_UP_OUT
  elif ! wait_bak_ip 30; then why="yedek hatta adres ya da varsayılan rota yok ($(bak_cur_dev))"
  fi
  secret=""
  # 4. Ağ çakışması: yedek hattın ağı ev ağı, kurulum Wi-Fi'ı, modem tarafı ya da ana hattın ağıyla aynı olamaz.
  if [ -z "$why" ]; then
    bip=$(bak_ip)
    for n in "$S_client" "$AP_NET" "$( [ "$S_wan_lan" = 1 ] || echo "$S_transit")" "$( [ "$S_wan_stage" != none ] && wan_ip)"; do
      [ -n "$n" ] && [ -n "$bip" ] || continue
      [[ $n == */32 ]] && continue
      if nets_overlap "$bip" "$n"; then why="yedek hattın ağı ($bip) Pi'nin kullandığı bir ağla ($n) çakışıyor — modemin / telefonun ağını değiştirin"; break; fi
    done
  fi
  # 5. Yedek hattan internet.
  if [ -z "$why" ] && ! bak_probe "$(bak_cur_dev)"; then
    why="yedek hattan internete ulaşılamadı ($(bak_cur_dev), ${bip:-adres yok}) — modemin / telefonun internetini denetleyin"
  fi
  if [ -n "$why" ]; then
    bak_unwind
    bak_reset
    write_state
    echo "rolled_back=1"
    die "yedek hat açılamadı — $why"
  fi
  S_bak_stage=on
  write_state || { bak_unwind; bak_reset; write_state; die "durum dosyası yazılamadı ($STATE_FILE)"; }
  mkdir -p "$BAK_BACKUP_DIR" && chmod 700 "$BAK_BACKUP_DIR"
  for p in $(bak_profiles); do cp -f "$(bak_keyfile_of "$p")" "$BAK_BACKUP_DIR/" 2>/dev/null && chmod 600 "$BAK_BACKUP_DIR/$(basename "$(bak_keyfile_of "$p")")"; done
  bak_watch_install || echo "warning=yedek hat izleyicisi ($BAK_WATCH_UNIT) başlatılamadı"
  command -v conntrack >/dev/null 2>&1 || echo "warning=conntrack aracı yok — geçişte açık bağlantılar hemen taşınamaz (panel güncellemesi kurar)"
  log "yedek hat açıldı: $kind/$type $(bak_cur_dev) ${bip:-}"
  echo "ok=1"
  echo "bak_dev=$(bak_cur_dev)"
  echo "bak_ip=$bip"
  echo "bak_gateway=$(bak_gateway)"
  [ "$kind" = usb ] && echo "bak_candidates=$cands"
  return 0
}

cmd_backup_off() {
  read_state
  [ "$S_bak_stage" != none ] || [ -n "$S_bak_kind" ] || die "yedek hat açık değil"
  nm_running || die "NetworkManager çalışmıyor"
  bak_unwind
  bak_reset
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "yedek hat kapatıldı"
  echo "ok=1"
}

# Güvenlik duvarını yeniden yükler (Ev VPN'i açıldı / kapandı, nftables yeniden başlatıldı).
cmd_backup_fw() {
  read_state
  if [ "$S_bak_stage" != none ]; then bak_nft_load || die "güvenlik duvarı (pi5_bak) yüklenemedi: $BAK_NFT_OUT"
  elif [ -e "$BAK_NFT" ]; then bak_nft_remove; fi
  echo "ok=1"
}

# Geçiş denemesi (kilitsiz): izleyici SN saniye yedek hatta kalır (yedek hat sağlamsa), sonra ana hat sağlamsa hemen döner.
# SN = 0 denemeyi bitirir.
cmd_backup_test() {
  local s=${1:-60} now
  read_state
  [ "$S_bak_stage" = on ] || die "yedek hat açık değil"
  { [[ $s =~ ^[0-9]{1,3}$ ]] && [ "$((10#$s))" -le 600 ]; } || die "geçersiz süre: $s (0-600 sn)"
  s=$((10#$s))
  systemctl is-active --quiet "$BAK_WATCH_UNIT.service" 2>/dev/null || die "yedek hat izleyicisi çalışmıyor ($BAK_WATCH_UNIT)"
  mkdir -p "$BAK_RUN" 2>/dev/null
  now=$(date +%s)
  if [ "$s" = 0 ]; then rm -f "$BAK_FORCE"; else echo "$((now + s))" > "$BAK_FORCE.tmp" && mv -f "$BAK_FORCE.tmp" "$BAK_FORCE"; fi
  echo "ok=1"
  echo "force_until=$( [ "$s" = 0 ] && echo 0 || echo $((now + s)) )"
}

# İzleyici (pi5-wan-failover.service; kilitsiz döngü, kilidi yalnız geçiş anında dener: ağ işlemi sürerken beklenir).
cmd_backup_watch() {
  local active=primary since sw=0 reason="" pfail=0 pfail_since=0 pok_since=0 last=0 forced=0 now pdev bdev pok bok force want
  local k v oldip why
  mkdir -p "$BAK_RUN" 2>/dev/null
  since=$(date +%s)
  # Servis yeniden başladıysa (açılış değil: /run korunur) önceki durum sürer.
  if [ -f "$BAK_STATUS" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        active) [ "$v" = backup ] && active=backup ;;
        since) [[ $v =~ ^[0-9]+$ ]] && since=$v ;;
        switches) [[ $v =~ ^[0-9]+$ ]] && sw=$v ;;
        reason) reason=$v ;;
      esac
    done < "$BAK_STATUS"
  fi
  last=$since
  exec 9>"$LOCK"
  while :; do
    read_state
    now=$(date +%s)
    if [ "$S_bak_stage" != on ]; then
      bak_route_off; rm -f "$BAK_STATUS"; active=primary; sleep 10; continue
    fi
    if [ "$S_bak_kind" = usb ]; then bak_tag_usb >/dev/null; fi
    bak_evict_foreign
    pdev=$(bak_primary_dev); bdev=$(bak_cur_dev)
    pok=0; bak_probe "$pdev" && pok=1
    bok=0; bak_probe "$bdev" && bok=1
    force=$(cat "$BAK_FORCE" 2>/dev/null); [[ $force =~ ^[0-9]+$ ]] || force=0
    [ "$force" -gt "$now" ] || force=0
    if [ "$pok" = 1 ]; then pfail=0; pfail_since=0; [ "$pok_since" -gt 0 ] || pok_since=$now
    else pfail=$((pfail + 1)); pok_since=0; [ "$pfail_since" -gt 0 ] || pfail_since=$now; fi
    want=$active; why=""
    if [ "$active" = primary ]; then
      if [ "$bok" = 1 ]; then
        if [ "$force" -gt 0 ]; then want=backup; why="geçiş denemesi (panelden)"
        elif [ "$pfail" -ge 1 ] && ! ip -4 route show default dev "$pdev" 2>/dev/null | grep -q .; then
          want=backup; why="ana hat bağlantısı yok (${pdev:-arayüz yok})"
        elif [ "$pfail" -ge 3 ]; then want=backup; why="ana hat $((now - pfail_since + 5)) sn'dir yanıt vermiyor ($pdev)"; fi
      fi
    else
      if [ "$pok" = 1 ] && [ "$bok" != 1 ]; then want=primary; why="yedek hat yanıt vermiyor, ana hat sağlam"
      elif [ "$forced" = 1 ] && [ "$force" = 0 ] && [ "$pok" = 1 ]; then want=primary; why="geçiş denemesi bitti"
      elif [ "$force" = 0 ] && [ "$pok" = 1 ] && [ $((now - pok_since)) -ge 60 ] && [ $((now - last)) -ge 120 ]; then
        want=primary; why="ana hat 60 sn'dir sağlam"
      fi
    fi
    if [ "$want" != "$active" ]; then
      if flock -n 9; then
        if [ "$want" = backup ]; then oldip=$(bak_primary_ip); bak_route_on "$bdev"; else oldip=$(bak_ip); bak_route_off; fi
        bak_ct_flush "${oldip%/*}"
        flock -u 9
        active=$want; since=$now; last=$now; sw=$((sw + 1)); reason=$why
        forced=0; [ "$want" = backup ] && [ "$force" -gt 0 ] && forced=1
        log "yedek hat: $( [ "$active" = backup ] && echo 'yedek hatta geçildi' || echo 'ana hatta dönüldü') — $why"
      fi
    elif [ "$active" = backup ]; then
      # NM yeniden başladı / kart yeniden bağlandı: geçiş rotası yerinde olmalı.
      if [ "$bok" = 1 ] && [ -n "$bdev" ] && ! bak_route_present "$bdev"; then bak_route_off; bak_route_on "$bdev"; fi
    elif [ -n "$(bak_route_lines)" ]; then
      bak_route_off
    fi
    bak_status_write "$active" "$since" "$sw" "$reason" "$pdev" "$pok" "$bdev" "$bok" "$force"
    sleep 5
  done
}

cmd_backup() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    on) cmd_backup_on "$@" ;;
    off) cmd_backup_off ;;
    fw) cmd_backup_fw ;;
    *) die "kullanım: backup on --kind eth|usb|wifi [--type dhcp|static|pppoe] [--port KART] [...] | backup off | backup fw | backup test [SN] | backup watch" ;;
  esac
}

cmd_ensure() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  read_state
  case "$S_stage" in
    trial) trial_check ;;
    static)
      [ "$S_home_stage" = trial ] && home_trial_check
      [ "$S_wan_stage" = trial ] && wan_trial_check
      # Kurulum Wi-Fi'ı ya da ev Wi-Fi'ı açıkken Wi-Fi kapatılmaz (yayın Wi-Fi kartından yapılır).
      # İnternet kartı (repeater) ya da yedek hat Wi-Fi ise radyo açık kalır; boştaki kartlarda başka profil bağlanmaz.
      if [ "$S_wifi_off" = 1 ] && [ "$S_ap_stage" = none ] && [ "$S_home_stage" = none ] && [ "$S_bak_kind" != wifi ] \
         && ! { [ "$S_wan_stage" != none ] && wan_wifi; } && nm_running; then
        nmcli radio wifi off >/dev/null 2>&1
      fi
      if { [ "$S_wan_stage" != none ] && wan_wifi; } || { [ "$S_bak_stage" != none ] && [ "$S_bak_kind" = wifi ]; }; then
        nm_running && wifi_idle_quiet
      fi
      # Ev Wi-Fi'ı denemesi sürerken eth0 bilerek köprüdedir, internet kartı denemesi sürerken ev ağı profilleri bilerek
      # değişir: sabit profil denetimi onları "onarıp" denemeyi bozmasın.
      if [ "$S_wan_stage" != trial ]; then
        case "$S_home_stage" in
          on) home_guard_routine 5 passive ;;
          none) guard_routine 5 passive ;;
        esac
      fi
      [ "$S_wan_stage" = on ] && wan_guard_routine 5 0
      [ "$S_bak_stage" = on ] && bak_guard_routine ;;
    none)
      case "$S_sat_stage" in
        trial) sat_trial_check ;;
        on) sat_guard_routine 5 passive ;;
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
      # Açılışta geçici zamanlayıcı yoktur: ev Wi-Fi'ı / internet kartı denemesi burada geri alınır (profilleri
      # kendiliğinden bağlanmaz). NetworkManager yeniden başlatıldıysa zamanlayıcı yerindedir: deneme sürer.
      [ "$S_home_stage" = trial ] && home_trial_check
      [ "$S_wan_stage" = trial ] && wan_trial_check
      if [ "$S_wifi_off" = 1 ] && [ "$S_ap_stage" = none ] && [ "$S_home_stage" = none ] && [ "$S_bak_kind" != wifi ] \
         && ! { [ "$S_wan_stage" != none ] && wan_wifi; }; then nmcli radio wifi off >/dev/null 2>&1; fi
      if { [ "$S_wan_stage" != none ] && wan_wifi; } || { [ "$S_bak_stage" != none ] && [ "$S_bak_kind" = wifi ]; }; then
        wifi_idle_quiet
      fi
      if [ "$S_wan_stage" != trial ]; then
        case "$S_home_stage" in
          on) home_guard_routine 40 ;;
          none) guard_routine 45 ;;
        esac
      fi
      # pi5-net-guard.service TimeoutStartSec=150: internet kartı onarımı betiğin başından 130. sn'de biter.
      [ "$S_wan_stage" = on ] && wan_guard_routine 30 130
      [ "$S_bak_stage" = on ] && bak_guard_routine ;;
    none)
      # Açılışta geçici zamanlayıcı yoktur: uydu denemesi geri alınır (profilleri kendiliğinden bağlanmaz).
      case "$S_sat_stage" in
        trial) sat_trial_check ;;
        on) sat_guard_routine 60 ;;
      esac ;;
  esac
  ap_check guard
  return 0
}

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)"
cmd=${1:-status}
shift || true
if [ "$cmd" = status ]; then cmd_status; exit 0; fi
# Salt okunur, kilitsiz: ana cihazın ev Wi-Fi'ı ayarları (backend uydulara aktarır).
if [ "$cmd" = home ] && [ "${1:-}" = secret ]; then cmd_home_secret; exit 0; fi
# Yedek hat izleyicisi (servis; kilidi yalnız geçiş anında dener) ve geçiş denemesi (yalnız izleyiciye dosya bırakır).
if [ "$cmd" = backup ] && [ "${1:-}" = watch ]; then cmd_backup_watch; exit 0; fi
if [ "$cmd" = backup ] && [ "${1:-}" = test ]; then shift; cmd_backup_test "$@"; exit 0; fi
case "$cmd" in
  ensure|guard|static|confirm|rollback|dhcp|wifi|ap|home|sat|wan|backup) ;;
  *) die "bilinmeyen komut: $cmd (status|static|confirm|rollback|dhcp|wifi|ap|home|sat|wan|backup|ensure|guard)" ;;
esac
exec 9>"$LOCK"
if ! flock -w 60 9; then
  [ "$cmd" = guard ] && { echo "error=başka bir ağ işlemi sürüyor"; exit 0; }
  # Zamanlayıcıyla gelen geri alma kilidi alamadıysa vazgeçmez: 30 sn sonra yeniden dener (deneme zamanlayıcısız kalmasın).
  if [ "$cmd" = rollback ]; then arm_retry 30 || true; fi
  if [ "$cmd" = ap ] && [ "${1:-}" = rollback ]; then arm_ap_retry 30 || true; fi
  if [ "$cmd" = home ] && [ "${1:-}" = rollback ]; then arm_home_retry 30 || true; fi
  if [ "$cmd" = sat ] && [ "${1:-}" = rollback ]; then arm_sat_retry 30 || true; fi
  if [ "$cmd" = wan ] && [ "${1:-}" = rollback ]; then arm_wan_retry 30 || true; fi
  die "başka bir ağ işlemi sürüyor"
fi
# Kullanıcının başlattığı değişiklikler kilit alındıktan sonra SIGTERM/SIGHUP ile yarıda kesilmez (panelin istek zaman
# aşımı ya da kapanan SSH oturumu Pi'yi adressiz bırakmasın). Kilit beklerken öldürülebilir: onay, kilidi bekleyen
# geri alma servisini durdurabilsin. guard/ensure idempotenttir, systemd'nin durdurmasına engel olmaz.
case "$cmd" in static|confirm|rollback|dhcp|wifi|ap|home|sat|wan|backup) trap '' TERM HUP ;; esac
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
  sat) cmd_sat "$@" ;;
  wan) cmd_wan "$@" ;;
  backup) cmd_backup "$@" ;;
esac

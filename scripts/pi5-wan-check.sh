#!/usr/bin/env bash
# Klyrix Gate — internet kartı (WAN router, R3) ön / son denetimi. SALT OKUNUR: hiçbir ayar, profil ya da kural değişmez.
# Aynı komut üç aşamada çalıştırılır; betik hangi aşamada olduğunu kendisi anlar:
#   1) USB Ethernet adaptörü gelmeden: ön koşullar (sabit adres, Pi DHCP, bileşenler, güvenlik duvarı)
#   2) Adaptör takılıp modeme / ONT'ye bağlanınca: kart tanındı mı (sürücü, USB 3, hız, kablo), modemden adres aldı mı
#   3) Cihaz Rolleri → İnternet bağlantısı açıldıktan sonra: rota, internet, DNS, güvenlik duvarı, ev ağı, tüneller
# Tek port (ev ağı kartı + VLAN destekli anahtar) da denetlenir: VLAN arayüzü, ev ağı kartının internet tarafı sayılmaması.
# Yedek hat açıksa (7. bölüm): güvenlik duvarı, izleyici, bağlantı, internet, etkin hat, conntrack.
# Çalıştırma: sudo bash /opt/pi5-gateway/scripts/pi5-wan-check.sh 2>&1 | tee /tmp/wan-check.txt
# PPPoE parolası okunmaz; kullanıcı adı maskelenir (çıktı paylaşılabilir).
set +e
export LC_ALL=C
NET_STATE=/etc/pi5-gateway/net/state
DHCP_STATE=/etc/pi5-gateway/dhcp/state
NET_MODE=/opt/pi5-gateway/scripts/net-mode.sh
WAN_GUARD=/etc/pi5-gateway/net/wan-guard.status
N_OK=0; N_WARN=0; N_MISS=0
h() { printf '\n===== %s =====\n' "$*"; }
ok() { N_OK=$((N_OK + 1)); printf '[ OK ]  %s\n' "$*"; }
warn() { N_WARN=$((N_WARN + 1)); printf '[UYARI] %s\n' "$*"; }
miss() { N_MISS=$((N_MISS + 1)); printf '[EKSİK] %s\n' "$*"; }
info() { printf '[BİLGİ] %s\n' "$*"; }
kv() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | head -1; }
have() { command -v "$1" >/dev/null 2>&1; }
addrs() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{ if ($5 == "peer") print $4 "/32"; else print $4 }' | paste -sd, -; }
conn_of() { nmcli -g GENERAL.CONNECTION device show "$1" 2>/dev/null; }
# IPv4 hesapları (ağ çakışması)
ip2int() { local IFS=. a b c d; read -r a b c d <<< "$1"; echo $(( (a << 24) | (b << 16) | (c << 8) | d )); }
overlap() { # $1 $2 ip/önek
  local p=${1#*/} q=${2#*/} m
  [ "$q" -lt "$p" ] && p=$q
  m=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
  [ $(( $(ip2int "${1%/*}") & m )) -eq $(( $(ip2int "${2%/*}") & m )) ]
}
private_ip() {
  local a b; IFS=. read -r a b _ _ <<< "$1"
  [ "$a" = 10 ] || { [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; } || { [ "$a" = 192 ] && [ "$b" = 168 ]; } \
    || { [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ]; }
}
[ "$(id -u)" = 0 ] || { echo "root olarak çalıştırın: sudo bash $0"; exit 1; }

STAGE=$(kv "$NET_STATE" stage); STAGE=${STAGE:-none}
LAN_IF=$(kv "$NET_STATE" iface); CLIENT=$(kv "$NET_STATE" client); TRANSIT=$(kv "$NET_STATE" transit)
HOME_STAGE=$(kv "$NET_STATE" home_stage); HOME_STAGE=${HOME_STAGE:-none}
SAT_STAGE=$(kv "$NET_STATE" sat_stage); SAT_STAGE=${SAT_STAGE:-none}
AP_STAGE=$(kv "$NET_STATE" ap_stage); AP_STAGE=${AP_STAGE:-none}
WAN_STAGE=$(kv "$NET_STATE" wan_stage); WAN_STAGE=${WAN_STAGE:-none}
WAN_DEV=$(kv "$NET_STATE" wan_dev); WAN_TYPE=$(kv "$NET_STATE" wan_type)
WAN_PORT=$(kv "$NET_STATE" wan_port); WAN_VLAN=$(kv "$NET_STATE" wan_vlan)
WAN_SINGLE=0; [ -n "$WAN_PORT" ] && [ "$WAN_PORT" = "$LAN_IF" ] && WAN_SINGLE=1
BAK_STAGE=$(kv "$NET_STATE" bak_stage); BAK_STAGE=${BAK_STAGE:-none}; BAK_PORT=$(kv "$NET_STATE" bak_port)
# Yedek hat arayüzleri (kart, VLAN, PPPoE, Wi-Fi kartı, grup 77'deki USB arayüzleri): ana hattın rota denetimlerine girmez.
BAK_DEVS=""
if [ "$BAK_STAGE" = on ]; then
  BAK_DEVS="$(kv "$NET_STATE" bak_dev) $BAK_PORT pppbak"
  [ -n "$(kv "$NET_STATE" bak_vlan)" ] && BAK_DEVS="$BAK_DEVS bak.$(kv "$NET_STATE" bak_vlan)"
  for p in /sys/class/net/*; do [ "$(cat "$p/netdev_group" 2>/dev/null)" = 77 ] && BAK_DEVS="$BAK_DEVS ${p##*/}"; done
fi
# Ana hattın varsayılan rotaları (yedek hat arayüzlerininkiler hariç).
main_defaults() {
  ip -4 route show default 2>/dev/null | awk -v s=" $BAK_DEVS " '{ for (i = 1; i < NF; i++) if ($i == "dev" && index(s, " " $(i + 1) " ")) next; print }'
}
LAN_DEV=$LAN_IF
if [ "$HOME_STAGE" != none ] && [ -e /sys/class/net/br0 ]; then LAN_DEV=br0; fi

h "Sürümler"
printf 'Panel: %s\n' "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /opt/pi5-gateway/version.json 2>/dev/null | head -1)"
printf 'Sistem: %s · çekirdek %s\n' "$(sed -n 's/^PRETTY_NAME="\(.*\)"/\1/p' /etc/os-release)" "$(uname -r)"
printf 'NetworkManager: %s · ppp: %s · nftables: %s\n' "$(NetworkManager --version 2>/dev/null || echo yok)" \
  "$(dpkg-query -W -f='${Version}' ppp 2>/dev/null || echo yok)" "$(dpkg-query -W -f='${Version}' nftables 2>/dev/null || echo yok)"

h "1. Ön koşullar (ev ağı ve adres dağıtımı)"
if [ "$STAGE" = static ]; then ok "Sabit adres kalıcı ($LAN_IF: modem tarafı ${TRANSIT:-—}, ev ağı ${CLIENT:-—})"
else miss "Sabit adres kalıcı değil (stage=$STAGE) — menü → DHCP Ayarları sihirbazı, 1. adım"; fi
if [ "$(pihole-FTL --config dhcp.active 2>/dev/null | tr -d '[:space:]')" = true ]; then
  if [ "$(kv "$DHCP_STATE" stage)" = trial ]; then miss "Pi DHCP denemesi sürüyor — DHCP Ayarları'nda kalıcı yapın"
  else ok "Pi DHCP sunucusu açık (ev ağına adresi Pi veriyor)"; fi
else miss "Pi DHCP sunucusu kapalı — DHCP Ayarları sihirbazı, 5. adım (internet kartına geçince ev ağına adresi yalnız Pi verir)"; fi
case "$SAT_STAGE" in none) ;; *) miss "Bu cihaz uydu olarak çalışıyor — internet kartı ana cihaz içindir" ;; esac
case "$HOME_STAGE" in trial) warn "Ev Wi-Fi'ı denemesi sürüyor — önce kalıcı yapın ya da geri alın" ;; on) info "Ev Wi-Fi'ı açık: ev ağı köprüde (br0)" ;; esac
if [ -n "$LAN_DEV" ] && [ -n "$CLIENT" ]; then
  if ip -4 -o addr show dev "$LAN_DEV" 2>/dev/null | awk '{print $4}' | grep -qxF "$CLIENT"; then ok "Ev ağı adresi $CLIENT $LAN_DEV üzerinde"
  else miss "Ev ağı adresi $CLIENT $LAN_DEV üzerinde görünmüyor (şu an: $(addrs "$LAN_DEV"))"; fi
fi

h "2. Bileşenler"
if [ -f "$NET_MODE" ] && grep -q '^cmd_wan_on()' "$NET_MODE"; then ok "net-mode.sh internet kartını destekliyor"
else miss "net-mode.sh internet kartını desteklemiyor — panelden güncelleyin (Ayarlar → Güncelle)"; fi
if have nft; then ok "nftables (güvenlik duvarı)"; else miss "nft yok — internet kartı korumasız açılmaz"; fi
if have pppd && compgen -G '/usr/lib/*/NetworkManager/*/libnm-ppp-plugin.so' >/dev/null; then ok "PPPoE bileşeni (pppd + NetworkManager eklentisi)"
else warn "PPPoE bileşeni yok (yalnız PPPoE için gerekir) — panel güncellemesi kurar ya da: sudo apt install ppp"; fi
if [ -d /sys/module/8021q ] || modinfo -n 8021q >/dev/null 2>&1; then ok "VLAN desteği (8021q)"; else warn "VLAN çekirdek modülü (8021q) bulunamadı (yalnız VLAN isteyen operatörde ve tek portta gerekir)"; fi
if [ -d /sys/module/pppoe ] || modinfo -n pppoe >/dev/null 2>&1; then ok "PPPoE çekirdek modülü"; else warn "PPPoE çekirdek modülü bulunamadı (yalnız PPPoE için)"; fi
if [ "$(systemctl is-enabled pi5-net-guard.service 2>/dev/null)" = enabled ]; then ok "Açılış ağ koruması (pi5-net-guard) etkin"
else warn "pi5-net-guard etkin değil — açılışta internet kartı onarımı çalışmaz (panel güncellemesi kurar)"; fi
info "nftables.service: $(systemctl is-enabled nftables 2>/dev/null || echo yok) (internet kartı güvenlik duvarı açılışta bundan SONRA, NetworkManager'dan ÖNCE yüklenir)"

h "3. Ethernet kartları"
CANDS=""
for p in /sys/class/net/*; do
  n=${p##*/}
  [ "$(cat "$p/type" 2>/dev/null)" = 1 ] || continue
  # Fiziksel kart (sanal arayüzlerin device dizini yok). WAN_CHECK_VIRTUAL=1: yalnız test kabı (veth) için.
  [ -e "$p/device" ] || [ "${WAN_CHECK_VIRTUAL:-0}" = 1 ] || continue
  { [ -e "$p/wireless" ] || [ -e "$p/phy80211" ] || [ -e "$p/bridge" ]; } && continue
  drv=$(basename "$(readlink -f "$p/device/driver" 2>/dev/null)" 2>/dev/null)
  real=$(readlink -f "$p/device" 2>/dev/null); bus=dahili; usb=""
  if [[ $real == */usb* ]]; then
    bus=USB
    d=$real; while [ ${#d} -gt 5 ]; do if [ -f "$d/speed" ] && [ -f "$d/idVendor" ]; then usb=$(cat "$d/speed"); break; fi; d=$(dirname "$d"); done
  fi
  spd=$(cat "$p/speed" 2>/dev/null); car=$(cat "$p/carrier" 2>/dev/null)
  mst=$(basename "$(readlink "$p/master" 2>/dev/null)" 2>/dev/null)
  cn=$(conn_of "$n")
  printf '%-16s sürücü %-10s %s%s · hız %s · kablo %s · profil %s%s · adres %s\n' "$n" "${drv:-?}" "$bus" \
    "${usb:+ ($usb Mbps)}" "${spd:-—}${spd:+ Mbps}" "$( [ "$car" = 1 ] && echo takılı || echo yok)" "${cn:-—}" \
    "${mst:+ · köprü $mst}" "$(addrs "$n" | sed 's/^$/—/')"
  if [ "$n" = "$LAN_IF" ]; then continue; fi
  [ -n "$mst" ] && continue
  # Yedek hattın kartı / USB modemi internet kartı adayı değildir.
  if [ "$BAK_STAGE" = on ] && { [ "$n" = "$BAK_PORT" ] || [ "$(cat "$p/netdev_group" 2>/dev/null)" = 77 ]; }; then
    info "$n yedek hat arayüzü"; continue
  fi
  # NetworkManager'ın yönetmediği kart (ör. yapılandırmada unmanaged) internet kartı olamaz.
  if [ "$(nmcli -g GENERAL.STATE device show "$n" 2>/dev/null | cut -d' ' -f1)" = 10 ]; then
    info "$n NetworkManager tarafından yönetilmiyor — internet kartı olarak kullanılamaz"; continue
  fi
  CANDS="$CANDS $n"
  if [ "$bus" = USB ]; then
    if [ -n "$usb" ] && awk -v s="$usb" 'BEGIN { exit !(s + 0 < 5000) }'; then warn "$n USB 2 portunda ($usb Mbps): hız ~300 Mbps ile sınırlı — adaptörü mavi USB 3 portuna takın"
    elif [ -n "$usb" ]; then ok "$n USB 3 portunda"; fi
  fi
  if [ "$car" = 1 ]; then ok "$n kablosu takılı (modem / ONT bağlı)"
    [ -n "$spd" ] && [ "$spd" -gt 0 ] 2>/dev/null && [ "$spd" -lt 1000 ] && warn "$n bağlantı hızı $spd Mbps — kabloyu (Cat5e/Cat6) ve modem portunu kontrol edin"
  else warn "$n kablosu takılı değil ya da karşı taraf kapalı — modemin / ONT'nin boş LAN portuna bağlayın"; fi
  a=$(addrs "$n" | cut -d, -f1)
  if [ -n "$a" ] && [ "$WAN_STAGE" = none ]; then
    info "$n şu an '${cn:-?}' profiliyle modemden adres aldı ($a) — normal: internet kartı açılınca kart pi5-wan profiline geçer"
    if [ -n "$CLIENT" ] && overlap "$a" "$CLIENT"; then miss "Modemin verdiği ağ ($a) ev ağıyla ($CLIENT) çakışıyor — modemin LAN ağını değiştirin (ör. 192.168.70.x) ya da modemi köprü kipine alın"; fi
    if [ "$AP_STAGE" != none ] && overlap "$a" 192.168.50.0/24; then miss "Modemin verdiği ağ ($a) kurulum Wi-Fi'ı ağıyla (192.168.50.0/24) çakışıyor"; fi
  fi
done
CANDS=${CANDS# }
if [ -z "$CANDS" ] && [ "$WAN_STAGE" = none ]; then info "İkinci bir Ethernet kartı yok — adaptör gelince takıp modeme bağlayın, bu betiği yeniden çalıştırın"
  [ -n "$LAN_IF" ] && info "Ya da tek port: $LAN_IF + VLAN destekli yönetilebilir anahtar (panelde kart olarak '$LAN_IF · tek port' seçilir, internet VLAN numarası girilir)"
elif [ -n "$CANDS" ]; then info "İnternet kartı adayı: $CANDS"; fi
echo "Varsayılan rotalar:"; ip -4 route show default | sed 's/^/  /'
[ "$(main_defaults | grep -c .)" -gt 1 ] && [ "$WAN_STAGE" = none ] && info "Birden çok varsayılan rota var: adaptörü eski otomatik profil aldı (en düşük metrik geçerli; internet kartı açılınca tek rota kalır)"

h "4. Ağ profilleri"
nmcli -t -f NAME,TYPE,DEVICE,AUTOCONNECT,AUTOCONNECT-PRIORITY connection show 2>/dev/null | while IFS=: read -r nm ty dv ac pr; do
  ifn=$(nmcli -g connection.interface-name connection show id "$nm" 2>/dev/null | head -1)
  printf '  %-16s %-9s cihaz=%-8s oto=%-3s öncelik=%-4s kart=%s\n' "$nm" "${ty#802-3-}" "${dv:-—}" "$ac" "$pr" "${ifn:-HERHANGİ}"
  case "$nm" in netplan-*) [ -z "$ifn" ] && [ "$ty" = 802-3-ethernet ] && echo "    ↳ karta bağlı değil: boştaki Ethernet kartını otomatik adresle alabilir (bilinen durum; internet kartı kapatılınca kart park edilir)" ;; esac
done

h "5. Güvenlik duvarı"
echo "Tablolar: $(nft list tables 2>/dev/null | awk '{print $2 ":" $3}' | paste -sd' ' -)"
if nft list table inet pi5_filter >/dev/null 2>&1; then info "Panelin güvenlik duvarı (pi5_filter) kurulu"; else info "Panelin güvenlik duvarı (pi5_filter) kurulu değil — internet kartını pi5_wan tabloları korur"; fi
echo "İnternet kartı olmadan dışarıya açık olacak dinleyiciler (pi5_wan bunları internet tarafında kapatır):"
ss -Hltnu 2>/dev/null | awk '$5 !~ /^(127\.|\[::1\]|::1)/ { printf "  %s %s\n", $1, $5 }' | sort -u | head -20
if [ "$WAN_STAGE" != none ]; then
  if nft list table inet pi5_wan >/dev/null 2>&1 && nft list table ip pi5_wan_nat >/dev/null 2>&1; then ok "İnternet kartı güvenlik duvarı yüklü (pi5_wan + pi5_wan_nat)"
  else miss "İnternet kartı güvenlik duvarı YÜKLÜ DEĞİL — sudo bash $NET_MODE wan fw"; fi
  if [ "$(systemctl is-enabled pi5-wan-fw.service 2>/dev/null)" = enabled ]; then ok "Açılışta güvenlik duvarı birimi (pi5-wan-fw) etkin"
  elif [ "$WAN_STAGE" = on ]; then warn "pi5-wan-fw.service etkin değil — açılışta kısa bir süre korumasız kalınabilir"; fi
  nft list chain inet pi5_wan input 2>/dev/null | grep -E 'iifname|dport' | sed 's/^[[:space:]]*/  /'
fi

if [ "$WAN_STAGE" != none ]; then
  h "6. İnternet kartı ($WAN_STAGE)"
  st=$(bash "$NET_MODE" status 2>/dev/null)
  user=$(printf '%s\n' "$st" | sed -n 's/^wan_user=//p'); [ -n "$user" ] && user="${user:0:3}***"
  printf '%s\n' "$st" | grep -E '^wan_(port|dev|type|vlan|prio|mtu|single|dhcp_vendor|dhcp_hostname|ip|gateway|carrier|up|fw|guard_result|guard_detail)=' | sed 's/^/  /'
  [ -n "$user" ] && echo "  wan_user=$user"
  cid=$(printf '%s\n' "$st" | sed -n 's/^wan_dhcp_client_id=//p'); [ -n "$cid" ] && echo "  wan_dhcp_client_id=${cid:0:3}***"
  wip=$(printf '%s\n' "$st" | sed -n 's/^wan_ip=//p')
  if [ "$(main_defaults | grep -c .)" = 1 ] && main_defaults | grep -q " dev $WAN_DEV "; then ok "Tek varsayılan rota (yedek hat hariç), $WAN_DEV üzerinde"
  else warn "Varsayılan rotalar beklenenden farklı: $(main_defaults | paste -sd'|' -)"; fi
  if [[ " $(ip -4 route get 1.1.1.1 2>/dev/null | head -1) " == *" dev $WAN_DEV "* ]]; then ok "İnternet rotası $WAN_DEV üzerinden"
  elif [ "$(sed -n 's/^active=//p' /run/pi5-gateway/failover.status 2>/dev/null)" = backup ]; then warn "İnternet rotası yedek hatta (ana hat çalışmıyor): $(ip -4 route get 1.1.1.1 2>&1 | head -1)"
  else miss "İnternet rotası $WAN_DEV üzerinden değil: $(ip -4 route get 1.1.1.1 2>&1 | head -1)"; fi
  if ping -c2 -W3 -I "$WAN_DEV" 1.1.1.1 >/dev/null 2>&1 || ping -c2 -W3 -I "$WAN_DEV" 8.8.8.8 >/dev/null 2>&1; then ok "İnternete ulaşılıyor (ping, $WAN_DEV)"
  else miss "İnternet kartından ping yanıtı yok"; fi
  # Repeater (R4 A): internet kartı Wi-Fi istemci — üst Wi-Fi ve sinyal gücü.
  if [ "$(printf '%s\n' "$st" | sed -n 's/^wan_kind=//p')" = wifi ]; then
    wssid=$(printf '%s\n' "$st" | sed -n 's/^wan_ssid=//p'); sig=$(printf '%s\n' "$st" | sed -n 's/^wan_signal=//p')
    info "Repeater: internet $WAN_PORT ile üst Wi-Fi'dan (${wssid:-?})"
    if ! [ "${sig:-0}" -gt 0 ] 2>/dev/null; then warn "Üst Wi-Fi'a (${wssid:-?}) bağlı görünmüyor — modem açık mı, ağ adı / parola doğru mu"
    elif [ "$sig" -lt 40 ]; then warn "Üst Wi-Fi sinyali zayıf (%$sig) — Pi'yi modeme yaklaştırın ya da antenli USB Wi-Fi kartını daha açık bir yere alın"
    else ok "Üst Wi-Fi sinyali %$sig"; fi
  fi
  if [ -n "$LAN_DEV" ] && [ -n "$TRANSIT" ] && ip -4 -o addr show dev "$LAN_DEV" | awk '{print $4}' | grep -qxF "$TRANSIT"; then
    [ "$(kv "$NET_STATE" wan_lan)" = 1 ] && warn "Ev ağı kartında ($LAN_DEV) modem tarafı adres ($TRANSIT) hâlâ duruyor"
  else ok "Ev ağı kartı ($LAN_DEV) yalnız ev ağında ($(addrs "$LAN_DEV"))"; fi
  if [ "$WAN_SINGLE" = 1 ]; then
    info "Tek port: internet $WAN_PORT üzerindeki VLAN ${WAN_VLAN:-?} ile, ev ağı aynı kartta etiketsiz"
    if [ -n "$WAN_VLAN" ] && ip -o link show "wan.$WAN_VLAN" 2>/dev/null | grep -qF "wan.$WAN_VLAN@$WAN_PORT:"; then ok "VLAN arayüzü wan.$WAN_VLAN ($WAN_PORT üzerinde)"
    else miss "VLAN arayüzü wan.${WAN_VLAN:-?} $WAN_PORT üzerinde yok"; fi
    if nft list table inet pi5_wan 2>/dev/null | grep -qF "\"$WAN_PORT\""; then miss "Ev ağı kartı ($WAN_PORT) internet güvenlik duvarı kümesinde — ev ağı internet tarafı sayılıyor"
    else ok "Ev ağı kartı ($WAN_PORT) internet güvenlik duvarı kümesinde değil"; fi
    [ "$(cat "/sys/class/net/$WAN_PORT/carrier" 2>/dev/null)" = 1 ] || warn "$WAN_PORT kablosu takılı değil (anahtar bağlantısı)"
  fi
  if have dig; then
    if dig +short +time=3 +tries=1 @127.0.0.1 example.com 2>/dev/null | grep -qE '^[0-9.]+$'; then ok "DNS (Pi-hole) çözüyor"; else warn "Pi-hole example.com'u çözemedi"; fi
    if dig +short +time=3 +tries=1 @127.0.0.1 -p 5335 example.com 2>/dev/null | grep -qE '^[0-9.]+$'; then ok "Unbound (5335) internetten çözüyor"; else warn "Unbound (5335) çözemedi — Pi-hole'un üst DNS'ini kontrol edin"; fi
  else info "dig yok — DNS denetimi atlandı"; fi
  if have curl; then
    pub=$(curl -s --max-time 6 --interface "$WAN_DEV" https://api.ipify.org 2>/dev/null)
    if [ -n "$pub" ]; then
      echo "  dış IP (internetin gördüğü): $pub"
      IFS=. read -r o1 o2 _ _ <<< "${wip%/*}"
      if [ "$o1" = 100 ] && [ "$o2" -ge 64 ] && [ "$o2" -le 127 ]; then
        warn "İnternet kartının adresi operatörün paylaşımlı ağında (CGNAT, 100.64/10) — dışarıdan erişim (Ev VPN'i, port yönlendirme) için operatörden genel IP isteyin"
      elif private_ip "${wip%/*}"; then
        info "Pi bir modemin arkasında (internet kartı ${wip%/*}): Ev VPN'i ve port yönlendirmeleri için modemde UDP/TCP portlarını ${wip%/*} adresine yönlendirin"
      else ok "Pi doğrudan internette (açık IP ${wip%/*}) — modemde yönlendirme gerekmez"; fi
    fi
  fi
  mtu=$(cat "/sys/class/net/$WAN_DEV/mtu" 2>/dev/null); echo "  $WAN_DEV MTU: ${mtu:-—}"
  [ -e /sys/class/net/wg_pi ] && echo "  wg_pi (Ev VPN'i) MTU: $(cat /sys/class/net/wg_pi/mtu)$( [ "$WAN_TYPE" = pppoe ] && [ -n "$mtu" ] && echo " (PPPoE için $(( mtu - 80 > 1420 ? 1420 : mtu - 80 )) beklenir)")"
  if have wg; then
    wg show all latest-handshakes 2>/dev/null | awk -v now="$(date +%s)" '$1 ~ /^wg_vps/ { age = ($3 == 0 ? -1 : now - $3); printf "  %s el sıkışma: %s\n", $1, (age < 0 ? "HİÇ" : age " sn önce") }'
  fi
  n=$(nft list table ip pi5_wan_fwd 2>/dev/null | grep -c 'dnat to')
  echo "  port yönlendirme kuralı: ${n:-0}"
  [ -f "$WAN_GUARD" ] && echo "  son koruma sonucu: $(tr '\n' ' ' < "$WAN_GUARD")"
fi

if [ "$BAK_STAGE" = on ]; then
  h "7. Yedek hat"
  st=$(bash "$NET_MODE" status 2>/dev/null)
  bv() { printf '%s\n' "$st" | sed -n "s/^bak_$1=//p" | head -1; }
  printf '%s\n' "$st" | grep -E '^bak_(kind|type|port|dev|vlan|ip|gateway|active|switches|reason|primary_ok|backup_ok)=' | sed 's/^/  /'
  [ -n "$(bv user)" ] && echo "  bak_user=$(bv user | cut -c1-3)***"
  [ -n "$(bv ssid)" ] && echo "  bak_ssid=$(bv ssid)"
  if [ "$(bv fw)" = 1 ]; then ok "Yedek hat güvenlik duvarı yüklü (pi5_bak + pi5_bak_nat)"
  else miss "Yedek hat güvenlik duvarı YÜKLÜ DEĞİL — sudo bash $NET_MODE backup fw"; fi
  if [ "$(systemctl is-enabled pi5-bak-fw.service 2>/dev/null)" = enabled ]; then ok "Açılışta yedek hat güvenlik duvarı birimi (pi5-bak-fw) etkin"
  else warn "pi5-bak-fw.service etkin değil — açılışta yedek hat kısa bir süre korumasız kalabilir"; fi
  if [ "$(bv watch)" = 1 ]; then ok "Yedek hat izleyicisi (pi5-wan-failover) çalışıyor"
  else miss "Yedek hat izleyicisi çalışmıyor — ana hat düşerse geçiş yapılamaz (sudo systemctl start pi5-wan-failover)"; fi
  bd=$(bv dev)
  if [ "$(bv up)" = 1 ]; then ok "Yedek hat bağlı ($bd $(bv ip))"
  elif [ "$(bv kind)" = wifi ] || [ "$(bv kind)" = usb ]; then info "Yedek hat şu an bağlı değil ($(bv kind)) — telefonun hotspot'u / USB paylaşımı kapalıysa beklenen durum"
  else warn "Yedek hat bağlı değil (${bd:-arayüz yok}) — modemi / kabloyu denetleyin"; fi
  if [ -n "$bd" ] && [ "$(bv up)" = 1 ]; then
    if ping -c2 -W3 -I "$bd" 1.1.1.1 >/dev/null 2>&1 || ping -c2 -W3 -I "$bd" 8.8.8.8 >/dev/null 2>&1; then ok "Yedek hattan internete ulaşılıyor ($bd)"
    else warn "Yedek hattan ping yanıtı yok ($bd) — ana hat düşerse geçiş yapılamaz"; fi
    if have curl; then
      bpub=$(curl -s --max-time 6 --interface "$bd" https://api.ipify.org 2>/dev/null)
      [ -n "$bpub" ] && echo "  yedek hattın dış IP'si (internetin gördüğü): $bpub"
    fi
  fi
  if [ "$(bv active)" = backup ]; then warn "Şu an YEDEK HATTAN çıkılıyor: $(bv reason)"
  else ok "Şu an ana hattan çıkılıyor (yedek hat hazır bekliyor)"; fi
  if have conntrack; then ok "conntrack kurulu (geçişte açık bağlantılar yeni hatta taşınır)"
  else warn "conntrack yok — geçişte açık bağlantılar takılabilir (panel güncellemesi kurar ya da: sudo apt install conntrack)"; fi
  if [ "$(bv kind)" = usb ]; then
    if [ -f /etc/udev/rules.d/90-pi5-bak.rules ]; then ok "USB modem udev kuralı yerinde"; else warn "USB modem udev kuralı yok — sudo bash $NET_MODE ensure"; fi
  fi
  echo "  varsayılan rotalar:"; ip -4 route show default | sed 's/^/    /'
fi

h "Özet"
echo "OK: $N_OK · UYARI: $N_WARN · EKSİK: $N_MISS"
if [ "$WAN_STAGE" = none ]; then
  if [ "$N_MISS" -gt 0 ]; then echo "Önce [EKSİK] satırlarını giderin."
  elif [ -z "$CANDS" ]; then echo "Ön koşullar tamam. Adaptör gelince: mavi USB 3 portuna takın, modemin / ONT'nin boş LAN portuna bağlayın ve bu betiği yeniden çalıştırın. (Ya da tek port: VLAN anahtarı hazırsa panelden '${LAN_IF:-eth0} · tek port'.)"
  else echo "Hazır: Cihaz Rolleri → İnternet bağlantısı → kart ($CANDS), bağlantı türü seçip 'İnternet kartına geç (5 dk deneme)'. Sonra bu betiği yeniden çalıştırın."; fi
elif [ "$WAN_STAGE" = trial ]; then
  echo "Deneme sürüyor: [EKSİK] yoksa bir web sitesi açıp panelden 'Çalışıyor, kalıcı yap'a basın."
else
  echo "İnternet kartı kalıcı.$( [ "$N_MISS" -gt 0 ] && echo " [EKSİK] satırlarını bildirin." )"
fi
exit 0

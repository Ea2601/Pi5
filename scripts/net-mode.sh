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
#   wifi off|on                          Pi'nin Wi-Fi'sini kapatır / açar (Pi DHCP'si açılmadan modem Wi-Fi'sinden ayrılır)
#   ensure                               güncelleme / açılış: süresi geçen denemeyi geri alır, kalıcı profili denetler.
#                                        Hiçbir şeyi kendiliğinden AÇMAZ.
#   guard                                pi5-net-guard.service (açılış + her NetworkManager (yeniden) başlatması): kalıcı
#                                        profil etkin değilse yedekten onarır; olmazsa adresleri bu açılış için elle tutar
# Raspberry Pi'nin NetworkManager yaması (rpt4) her NM başlangıcında /etc/netplan/*.yaml'ı silip yalnız dosya adı
# "netplan-" ile başlayan profillerden yeniden yazar: "pi5-eth0" adı bu yüzden seçildi (yerli keyfile olarak kalır).
# `nmcli con reload` ASLA çalıştırılmaz (netplan silme / yeniden yazmayı tetikler); tek dosya `nmcli con load` ile
# yüklenir. Eski profil (netplan-*) hiç değiştirilmez: değiştirmek /etc/netplan'ı yeniden yazdırırdı.
# Kurtarma (terminal):  sudo bash /opt/pi5-gateway/scripts/net-mode.sh rollback   (deneme sürerken)
#                       sudo bash /opt/pi5-gateway/scripts/net-mode.sh dhcp       (kalıcı sabit adresten dönüş)
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
SELF=$(readlink -f "$0")
STATE_KEYS="stage trial_ends iface transit client gw dns old_uuid old_name old_ipv6 wifi_off"

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
}
write_state() {
  local k v
  mkdir -p "$DIR" && chmod 700 "$DIR"
  for k in $STATE_KEYS; do v="S_$k"; printf '%s=%s\n' "$k" "${!v}"; done > "$STATE_FILE.tmp" \
    && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}
# Kurulum alanlarını boşaltır (stage=none); wifi_off korunur.
reset_setup() {
  S_stage=none; S_trial_ends=0; S_iface=""; S_transit=""; S_client=""; S_gw=""; S_dns=""
  S_old_uuid=""; S_old_name=""; S_old_ipv6=""
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

cmd_status() {
  local now dr pifc pgw ptr="" ifc nm=0 ac="" au="" method="" wifi="" gr="" ga="" gd="" k v pok=0
  read_state
  now=$(date +%s)
  dr=$(default_route); pifc=${dr%% *}; pgw=${dr#"$pifc"}; pgw=${pgw# }
  if [ -n "$pifc" ] && valid_ip "$pgw"; then ptr=$(addr_for_gw "$pifc" "$pgw"); fi
  ifc=$S_iface
  [ -n "$ifc" ] || ifc=$pifc
  if nm_running; then
    nm=1
    if [ -n "$ifc" ]; then
      ac=$(active_conn "$ifc"); au=$(active_uuid "$ifc")
      [ -n "$au" ] && method=$(nmcli -g ipv4.method connection show uuid "$au" 2>/dev/null)
    fi
    wifi=$(nmcli radio wifi 2>/dev/null)
    keyfile_ok && pok=1
  fi
  if [ -f "$GUARD_STATUS" ]; then
    while IFS='=' read -r k v; do
      case "$k" in result) gr=$v ;; at) ga=$v ;; detail) gd=$v ;; esac
    done < "$GUARD_STATUS"
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
  echo "addrs=$( [ -n "$ifc" ] && iface_addrs "$ifc" | csv)"
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
  case "${1:-}" in
    off)
      # Pi'nin interneti Wi-Fi'dan geliyorsa kapatmak Pi'yi ağdan koparır.
      dr=$(default_route); ifc=${dr%% *}
      if [ -n "$ifc" ] && [ "$(dev_type "$ifc")" = wifi ]; then
        die "Pi şu an ağa Wi-Fi ile bağlı ($ifc) — Wi-Fi kapatılırsa erişim kesilir; önce Pi'yi modeme kabloyla bağlayın"
      fi
      nmcli radio wifi off >/dev/null 2>&1 || die "Wi-Fi kapatılamadı"
      S_wifi_off=1 ;;
    on)
      pi_dhcp_active && die "Pi DHCP sunucusu açıkken Pi'nin Wi-Fi'si modeme bağlanamaz — Wi-Fi yayını sonraki adımda"
      nmcli radio wifi on >/dev/null 2>&1 || die "Wi-Fi açılamadı"
      S_wifi_off=0 ;;
    *) die "kullanım: wifi off|on" ;;
  esac
  write_state || die "durum dosyası yazılamadı ($STATE_FILE)"
  log "Wi-Fi: $1"
  echo "ok=1"
}

cmd_ensure() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  read_state
  case "$S_stage" in
    trial) trial_check ;;
    static)
      if [ "$S_wifi_off" = 1 ] && nm_running; then nmcli radio wifi off >/dev/null 2>&1; fi
      guard_routine 5 passive ;;
  esac
  echo "ok=1"
}

cmd_guard() {
  read_state
  case "$S_stage" in
    trial) trial_check ;;
    static)
      if [ "$S_wifi_off" = 1 ]; then nmcli radio wifi off >/dev/null 2>&1; fi
      guard_routine 45 ;;
  esac
  return 0
}

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)"
cmd=${1:-status}
shift || true
if [ "$cmd" = status ]; then cmd_status; exit 0; fi
case "$cmd" in
  ensure|guard|static|confirm|rollback|dhcp|wifi) ;;
  *) die "bilinmeyen komut: $cmd (status|static|confirm|rollback|dhcp|wifi|ensure|guard)" ;;
esac
exec 9>"$LOCK"
if ! flock -w 60 9; then
  [ "$cmd" = guard ] && { echo "error=başka bir ağ işlemi sürüyor"; exit 0; }
  # Zamanlayıcıyla gelen geri alma kilidi alamadıysa vazgeçmez: 30 sn sonra yeniden dener (deneme zamanlayıcısız kalmasın).
  if [ "$cmd" = rollback ]; then arm_retry 30 || true; fi
  die "başka bir ağ işlemi sürüyor"
fi
# Kullanıcının başlattığı değişiklikler kilit alındıktan sonra SIGTERM/SIGHUP ile yarıda kesilmez (panelin istek zaman
# aşımı ya da kapanan SSH oturumu Pi'yi adressiz bırakmasın). Kilit beklerken öldürülebilir: onay, kilidi bekleyen
# geri alma servisini durdurabilsin. guard/ensure idempotenttir, systemd'nin durdurmasına engel olmaz.
case "$cmd" in static|confirm|rollback|dhcp|wifi) trap '' TERM HUP ;; esac
case "$cmd" in
  ensure) cmd_ensure ;;
  guard) cmd_guard; exit 0 ;;
  static) cmd_static "$@" ;;
  confirm) cmd_confirm ;;
  rollback) cmd_rollback ;;
  dhcp) cmd_dhcp "$@" ;;
  wifi) cmd_wifi "$@" ;;
esac

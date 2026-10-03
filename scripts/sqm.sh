#!/bin/bash
# Hat düzeyi akıllı kuyruk (G1.1; backend/src/sqm.ts) — yalnız KENDİ kaynaklarını gösterir / kaldırır (plan 0.5):
#   hat arayüzünün kök qdisc'i (handle ca1e:; tek bacakta prio kökü — altındaki ca11: CAKE, ca12: fq_codel ve sınıflandırma
#   süzgeci kökle birlikte gider), IFB arayüzleri ifb-klx* (ana hat ifb-klx0, yedek hat ifb-klx1..; kökleri ca1f:), giriş
#   (ingress ffff:) süzgeci pref 4910.
# Başka qdisc'e ve süzgece dokunulmaz. Giriş qdisc'i yalnız onu biz eklediysek (backend kurulumda arayüz adını
# /run/pi5-sqm/ingress-owned'a yazar) ve içinde süzgeç kalmadıysa silinir — başka bir aracın önceden kurduğu giriş kuyruğu
# (kurulum onu yeniden kullanır) yerinde kalır. tc çalışma anı durumudur: yeniden başlatmada zaten silinir (/run da).
#   clear   tümünü kaldırır; idempotent (iki kez çalışması zararsız). Deneme geri alma zamanlayıcısı (systemd-run
#           pi5-sqm-rollback, 300 sn) bunu backend'den bağımsız çalıştırır — panel çökse de kuyruk kalkar. Panel ayarı
#           değişmez: backend açıkken (kalıcı kuyrukta) uzlaştırma kuyruğu 15 sn içinde geri takar.
#   clear-line DEV IFB
#           tek bir hattın kaynaklarını kaldırır (backend uzlaştırması: o hat yeniden kurulurken / artık istenmezken diğer
#           hatlara dokunulmasın). DEV'deki kök ca1e:, giriş süzgeci 4910 ve sahiplenilen boş giriş kuyruğu; IFB yalnız hiçbir
#           arayüzde ona yönlendiren süzgecimiz kalmadıysa silinir (yoksa yönlendirilen paket düşerdi). DEV '-' olabilir
#           (arayüz gitti: kuyrukları onunla gitti, yalnız IFB kalır).
#   off     SSH kurtarması — kuyruğu kaldırır VE panel ayarını kapatır:  sudo bash /opt/pi5-gateway/scripts/sqm.sh off
#           (/etc/pi5-gateway/sqm.off işareti bırakılır; backend onu görünce ayarı kapatır — açıkken 15 sn içinde, durmuşsa
#           açılışta — ve işareti siler.)
#   status  KEY=VALUE: installed, root_devs, filter_devs, ifb
#   ra-probe DEV
#           salt okunur (tek bacak / br0 uyarısı): ev ağı arayüzünde bir Router Solicitation gönderir, 3 sn Router
#           Advertisement dinler — adres / rota ayarına dokunmaz. ra=1: Pi dışında bir yönlendirici (modem) ev ağına IPv6
#           dağıtıyor (varsayılan rota ömrü > 0 ve SLAAC'lı global önek ya da DHCPv6): cihazların IPv6 trafiği Pi'ye
#           uğramadan modeme gider, akıllı kuyruğa girmez. ra=0: gelmedi / kullanılamaz; ra=unknown: denenemedi.
set -u
export PATH="$PATH:/usr/sbin:/sbin"
ROOT_HANDLE='ca1e:'
PREF=4910
IFB_PREFIX='ifb-klx'
OWNED=/run/pi5-sqm/ingress-owned
OFF_FLAG=/etc/pi5-gateway/sqm.off

devs() {
  local p
  for p in /sys/class/net/*; do
    [ -e "$p" ] || continue
    printf '%s\n' "${p##*/}"
  done
}
# Kök qdisc'i bizim mi (tc qdisc show: "qdisc cake ca1e: root …")
own_root() { tc qdisc show dev "$1" root 2>/dev/null | awk -v h="$ROOT_HANDLE" '$1 == "qdisc" && $3 == h && $4 == "root" { f = 1 } END { exit !f }'; }
# Giriş süzgeci bizim mi ("filter protocol all pref 4910 matchall …")
own_filter() { tc filter show dev "$1" parent ffff: 2>/dev/null | grep -Eq "(^| )pref $PREF( |\$)"; }
has_ingress() { tc qdisc show dev "$1" ingress 2>/dev/null | grep -q 'ingress ffff:'; }
ifb_devs() { devs | grep -E "^${IFB_PREFIX}[0-9]+\$" || true; }
# Giriş qdisc'ini kurulum mu ekledi (sahiplik kaydı)
owned_ingress() { [ -f "$OWNED" ] && grep -qxF -- "$1" "$OWNED"; }

cmd_clear() {
  local d rc=0 filt_left=0
  local -a keep=()
  # 1. Giriş yönlendirmesi önce (IFB kalkmadan: yönlendirilen paket düşmesin), sonra kök kuyruk, en son IFB.
  while read -r d; do
    [ -n "$d" ] || continue
    if own_filter "$d"; then
      tc filter del dev "$d" parent ffff: pref "$PREF" 2>/dev/null || { echo "warning=$d giriş süzgeci (pref $PREF) kaldırılamadı"; rc=1; }
    fi
    # Bizim eklediğimiz giriş qdisc'i, içinde hiç süzgeç kalmadıysa (başkası süzgeç eklediyse ona bırakılır)
    if owned_ingress "$d" && has_ingress "$d" && [ -z "$(tc filter show dev "$d" parent ffff: 2>/dev/null)" ]; then
      tc qdisc del dev "$d" ingress 2>/dev/null || { echo "warning=$d giriş kuyruğu kaldırılamadı"; rc=1; }
    fi
    own_filter "$d" && filt_left=1
    # Hâlâ bizim olan giriş qdisc'i (süzgecimiz kaldı ya da boş ama silinemedi) kayıtta kalır: sonraki clear kaldırır.
    if owned_ingress "$d" && has_ingress "$d" && { own_filter "$d" || [ -z "$(tc filter show dev "$d" parent ffff: 2>/dev/null)" ]; }; then
      keep+=("$d")
    fi
  done < <(devs)
  # Sahiplik kaydı: arayüzü gitmiş, giriş qdisc'i kalkmış ya da başkasının süzgeci olan satır düşer.
  if [ "${#keep[@]}" -gt 0 ]; then
    mkdir -p "${OWNED%/*}" && printf '%s\n' "${keep[@]}" > "$OWNED.tmp" && mv -f "$OWNED.tmp" "$OWNED"
  else
    rm -f "$OWNED" "$OWNED.tmp"
  fi
  while read -r d; do
    [ -n "$d" ] || continue
    if own_root "$d"; then
      tc qdisc del dev "$d" root 2>/dev/null || { echo "warning=$d kök kuyruğu ($ROOT_HANDLE) kaldırılamadı"; rc=1; }
    fi
  done < <(devs)
  # IFB yalnız hiçbir arayüzde yönlendirme süzgecimiz kalmadıysa silinir: süzgeç kalıp hedefi silinirse çekirdek gelen her
  # paketi düşürür (indirme tamamen kesilirdi). Kaldıysa IFB ve kökü yerinde kalır — trafik IFB'den akmaya devam eder.
  if [ "$filt_left" = 0 ]; then
    while read -r d; do
      [ -n "$d" ] || continue
      ip link del "$d" 2>/dev/null || { echo "warning=$d kaldırılamadı"; rc=1; }
    done < <(ifb_devs)
  else
    echo "warning=giriş yönlendirmesi kaldı — IFB korunuyor (internet kesilmesin); yeniden deneyin"
  fi
  # Doğrulama: hiçbiri kalmadı
  while read -r d; do
    [ -n "$d" ] || continue
    if own_filter "$d" || own_root "$d"; then echo "warning=$d üzerinde akıllı kuyruk kaldı"; rc=1; fi
  done < <(devs)
  [ -z "$(ifb_devs)" ] || { echo "warning=IFB arayüzü kaldı"; rc=1; }
  if [ "$rc" = 0 ]; then echo "ok=1"; else echo "ok=0"; fi
  command -v logger >/dev/null 2>&1 && logger -t pi5-sqm "akıllı kuyruk kaldırıldı (ok=$([ "$rc" = 0 ] && echo 1 || echo 0))"
  return "$rc"
}

# Arayüzdeki süzgecimiz (pref 4910) verilen IFB'ye mi yönlendiriyor ("mirred (Egress Redirect to device ifb-klx1)").
filter_to() {
  tc filter show dev "$1" parent ffff: 2>/dev/null \
    | awk -v p="$PREF" -v t="to device $2)" '/^filter / { own = ($0 ~ ("(^| )pref " p "( |$)")) } own && index($0, t) { f = 1 } END { exit !f }'
}
redirected_to() {
  local d
  while read -r d; do
    [ -n "$d" ] || continue
    filter_to "$d" "$1" && return 0
  done < <(devs)
  return 1
}
# Arayüzün giriş qdisc'i hâlâ bizim mi (süzgecimiz kaldı ya da boş ama silinemedi): kayıtta kalır.
still_owned() { owned_ingress "$1" && has_ingress "$1" && { own_filter "$1" || [ -z "$(tc filter show dev "$1" parent ffff: 2>/dev/null)" ]; }; }

cmd_clear_line() {
  local d=${1:-} ifb=${2:-} rc=0
  if ! { [ "$d" = - ] || [[ $d =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; } || ! [[ $ifb =~ ^${IFB_PREFIX}[0-9]+$ ]]; then
    echo "warning=geçersiz arayüz ya da IFB adı"; echo "ok=0"; return 2
  fi
  [ -e "/sys/class/net/$d" ] || d=-
  if [ "$d" != - ]; then
    # Sıra clear ile aynı: giriş yönlendirmesi → (bizimse ve boşsa) giriş kuyruğu → kök kuyruk
    if own_filter "$d"; then
      tc filter del dev "$d" parent ffff: pref "$PREF" 2>/dev/null || { echo "warning=$d giriş süzgeci (pref $PREF) kaldırılamadı"; rc=1; }
    fi
    if owned_ingress "$d" && has_ingress "$d" && [ -z "$(tc filter show dev "$d" parent ffff: 2>/dev/null)" ]; then
      tc qdisc del dev "$d" ingress 2>/dev/null || { echo "warning=$d giriş kuyruğu kaldırılamadı"; rc=1; }
    fi
    if own_root "$d"; then
      tc qdisc del dev "$d" root 2>/dev/null || { echo "warning=$d kök kuyruğu ($ROOT_HANDLE) kaldırılamadı"; rc=1; }
    fi
  fi
  # Sahiplik kaydı: yalnız bu arayüzün satırı düşer (arayüzü gitti ya da giriş qdisc'i artık bizim değil); diğerleri aynen.
  if [ -f "$OWNED" ] && [ "${1:-}" != - ] && grep -qxF -- "$1" "$OWNED" && ! { [ "$d" != - ] && still_owned "$d"; }; then
    grep -vxF -- "$1" "$OWNED" > "$OWNED.tmp"
    if [ -s "$OWNED.tmp" ]; then mv -f "$OWNED.tmp" "$OWNED"; else rm -f "$OWNED" "$OWNED.tmp"; fi
  fi
  # IFB: hiçbir arayüzde ona yönlendiren süzgecimiz kalmadıysa (başka bir hat kullanmıyorsa) silinir.
  if [ -e "/sys/class/net/$ifb" ]; then
    if redirected_to "$ifb"; then
      echo "note=$ifb başka bir arayüzün yönlendirmesinde — korunuyor"
    else
      ip link del "$ifb" 2>/dev/null || { echo "warning=$ifb kaldırılamadı"; rc=1; }
    fi
  fi
  # Doğrulama: bu arayüzde kendi kuyruğumuz / süzgecimiz kalmadı
  if [ "$d" != - ] && { own_filter "$d" || own_root "$d"; }; then echo "warning=$d üzerinde akıllı kuyruk kaldı"; rc=1; fi
  if [ "$rc" = 0 ]; then echo "ok=1"; else echo "ok=0"; fi
  command -v logger >/dev/null 2>&1 && logger -t pi5-sqm "akıllı kuyruk hattı kaldırıldı (${1:-} $ifb, ok=$([ "$rc" = 0 ] && echo 1 || echo 0))"
  return "$rc"
}

# SSH kurtarması: önce işaret (backend uzlaştırması kuyruğu geri takmasın), sonra kaldırma.
cmd_off() {
  local rc
  if mkdir -p "${OFF_FLAG%/*}" && : > "$OFF_FLAG"; then
    echo "off_flag=1"
  else
    echo "warning=$OFF_FLAG yazılamadı (root olarak çalıştırın) — panel ayarı açık kalır"
  fi
  cmd_clear
  rc=$?
  command -v logger >/dev/null 2>&1 && logger -t pi5-sqm "akıllı kuyruk SSH'tan kapatıldı (sqm.sh off)"
  return "$rc"
}

cmd_status() {
  local d roots="" filters=""
  while read -r d; do
    [ -n "$d" ] || continue
    own_root "$d" && roots="$roots${roots:+ }$d"
    own_filter "$d" && filters="$filters${filters:+ }$d"
  done < <(devs)
  local ifbs
  ifbs=$(ifb_devs | tr '\n' ' ' | sed 's/ $//')
  if [ -n "$roots$filters$ifbs" ]; then echo "installed=1"; else echo "installed=0"; fi
  echo "root_devs=$roots"
  echo "filter_devs=$filters"
  echo "ifb=$ifbs"
}

cmd_ra_probe() {
  local d=${1:-}
  if ! [[ $d =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || ! [ -e "/sys/class/net/$d" ]; then
    echo "ra=unknown"; echo "warning=geçersiz arayüz"; return 2
  fi
  command -v python3 >/dev/null 2>&1 || { echo "ra=unknown"; echo "note=python3 yok"; return 0; }
  python3 - "$d" <<'PY'
import select, socket, struct, sys, time
ifn = sys.argv[1]
SO_BINDTODEVICE = getattr(socket, 'SO_BINDTODEVICE', 25)
own = set()  # Pi'nin kendi adresleri (kendi RA'sı sayılmaz)
try:
    for line in open('/proc/net/if_inet6'):
        f = line.split()
        if len(f) >= 6 and f[5] == ifn:
            own.add(socket.inet_ntop(socket.AF_INET6, bytes.fromhex(f[0])))
except (OSError, ValueError):
    pass
try:
    idx = socket.if_nametoindex(ifn)
    s = socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_ICMPV6)
    s.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, ifn.encode())
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_HOPS, 255)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_IF, idx)
    s.sendto(struct.pack('!BBHI', 133, 0, 0, 0), ('ff02::2', 0, 0, idx))
except OSError as e:
    print('ra=unknown')
    print('note=%s' % (e.strerror or e))
    sys.exit(0)
end, found = time.time() + 3, 0
while not found:
    left = end - time.time()
    if left <= 0 or not select.select([s], [], [], left)[0]:
        break
    data, addr = s.recvfrom(4096)
    if len(data) < 16 or data[0] != 134 or addr[0].split('%')[0] in own:
        continue
    flags, life = data[5], struct.unpack('!H', data[6:8])[0]
    usable = bool(flags & 0x80)  # DHCPv6 adres (M)
    i = 16
    while i + 2 <= len(data):
        t, n = data[i], data[i + 1] * 8
        if n == 0 or i + n > len(data):
            break
        o = data[i:i + n]
        # Önek bilgisi: SLAAC (A) ve global önek (2000::/3)
        if t == 3 and n >= 32 and (o[3] & 0x40) and (o[16] & 0xe0) == 0x20:
            usable = True
        i += n
    if life > 0 and usable:
        found = 1
print('ra=%d' % found)
PY
}

case "${1:-}" in
  clear) cmd_clear ;;
  clear-line) cmd_clear_line "${2:-}" "${3:-}" ;;
  off) cmd_off ;;
  status) cmd_status ;;
  ra-probe) cmd_ra_probe "${2:-}" ;;
  *) echo "kullanım: $0 clear|clear-line ARAYÜZ IFB|off|status|ra-probe ARAYÜZ" >&2; exit 2 ;;
esac

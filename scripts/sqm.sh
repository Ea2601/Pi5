#!/bin/bash
# Hat düzeyi akıllı kuyruk (G1.1-A; backend/src/sqm.ts) — yalnız KENDİ kaynaklarını gösterir / kaldırır (plan 0.5):
#   hat arayüzünün kök qdisc'i (handle ca1e:), IFB arayüzleri ifb-klx* (kökleri ca1f:), giriş (ingress ffff:) süzgeci pref 4910.
# Başka qdisc'e ve süzgece dokunulmaz. Giriş qdisc'i yalnız onu biz eklediysek (backend kurulumda arayüz adını
# /run/pi5-sqm/ingress-owned'a yazar) ve içinde süzgeç kalmadıysa silinir — başka bir aracın önceden kurduğu giriş kuyruğu
# (kurulum onu yeniden kullanır) yerinde kalır. tc çalışma anı durumudur: yeniden başlatmada zaten silinir (/run da).
#   clear   tümünü kaldırır; idempotent (iki kez çalışması zararsız). Deneme geri alma zamanlayıcısı (systemd-run
#           pi5-sqm-rollback, 300 sn) bunu backend'den bağımsız çalıştırır — panel çökse de kuyruk kalkar. Panel ayarı
#           değişmez: backend açıkken (kalıcı kuyrukta) uzlaştırma kuyruğu 15 sn içinde geri takar.
#   off     SSH kurtarması — kuyruğu kaldırır VE panel ayarını kapatır:  sudo bash /opt/pi5-gateway/scripts/sqm.sh off
#           (/etc/pi5-gateway/sqm.off işareti bırakılır; backend onu görünce ayarı kapatır — açıkken 15 sn içinde, durmuşsa
#           açılışta — ve işareti siler.)
#   status  KEY=VALUE: installed, root_devs, filter_devs, ifb
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

case "${1:-}" in
  clear) cmd_clear ;;
  off) cmd_off ;;
  status) cmd_status ;;
  *) echo "kullanım: $0 clear|off|status" >&2; exit 2 ;;
esac

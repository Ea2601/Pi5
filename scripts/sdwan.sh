#!/usr/bin/env bash
# Klyrix Gate — şubeler arası SD-WAN (backend/src/sdwan.ts): sistemdeki SD-WAN durumunu kaldırır. Panelden bağımsız çalışır
# (deneme süresinin sonunda systemd-run zamanlayıcısı çağırır; panele erişim kesilmişse de çalışır).
#   down     : wg-quick@wg_s2s0 durdurulur ve devre dışı bırakılır; ip rule önceliği 1050, yönlendirme tablosu 30001,
#              inet pi5_sdwan ve politikası drop tablolardaki izin zincirleri (pi5_sdwan_in / pi5_sdwan_fwd) kaldırılır;
#              /etc/wireguard/wg_s2s0.conf, /etc/nftables.d/pi5-sdwan.conf, atlama dosyaları ve açılış koruması birimi
#              (pi5-sdwan-guard) silinir. Ayarlar (/etc/pi5-gateway/sdwan) kalır: panel yeniden uygulayabilir.
#   rollback [timer] : deneme "Kalıcı yap"sız biterse: deneme hâlâ sürüyorsa önce durum 'rolledback' yazılır (panelin o an
#              süren bir işi bittiğinde bunu görüp kendi eklediğini de kaldırır), sonra down; internet kartı ve yedek hat
#              güvenlik duvarı (UDP 51821 izni) yeniden yüklenir. 'timer': zamanlayıcıdan — panel olay kaydına bir kez
#              "geri alındı" yazar (notice=timer). Deneme onaylandıysa hiçbir şey yapmaz.
#   rules AĞ… : wg-quick@wg_s2s0'ın PreUp'ı (açılışta panelden önce de çalışır; kilit almaz). Her uzak ağ için tablo 30001'e
#              'unreachable … metric 1000' ve ip rule 1050 — ama ağ o an bu cihazın bir kartının ağıyla çakışıyorsa (kurulumdan
#              sonra değişen ev ağı, yeni segment, yedek hat) atlanır: kural o ağdaki cihazlara giden yanıtları tünele çekerdi.
#              Panel aynı denetimi yapar, olayı yazar; çakışma kalkınca yolu kendisi ekler.
# Yalnız SD-WAN'ın kendi kaynaklarına dokunur (planın 0.5 tahsisi: öncelik 1050, tablo 30001, wg_s2s0, pi5_sdwan).
# Çıktı KEY=VALUE: ok=1 | error=…
set -u
export PATH="$PATH:/usr/sbin:/sbin"
DIR=/etc/pi5-gateway/sdwan
TRIAL=$DIR/trial
IF=wg_s2s0
TABLE=30001
PREF=1050
METRIC=1000
NFT_FILE=/etc/nftables.d/pi5-sdwan.conf
CONF=/etc/wireguard/$IF.conf
CORE=/opt/pi5-gateway/core
NET_MODE=/opt/pi5-gateway/scripts/net-mode.sh
GUARD_UNIT=/etc/systemd/system/pi5-sdwan-guard.service
LOCK=/run/pi5-sdwan.lock
log() { logger -t pi5-sdwan "$*" 2>/dev/null || true; }

ip2n() { local a b c d; IFS=. read -r a b c d <<< "$1"; echo $(( (a << 24) | (b << 16) | (c << 8) | d )); }
# İki IPv4 ağı (a.b.c.d/nn) çakışıyor mu: kısa önek kadar ilk bitleri aynıysa.
nets_overlap() {
  local a=${1%/*} p=${1#*/} b=${2%/*} q=${2#*/} m mask
  m=$(( p < q ? p : q ))
  mask=$(( m == 0 ? 0 : (0xFFFFFFFF << (32 - m)) & 0xFFFFFFFF ))
  [ $(( $(ip2n "$a") & mask )) -eq $(( $(ip2n "$b") & mask )) ]
}

sd_rules() {
  local n l clash locals have
  locals=$(ip -4 -o addr show 2>/dev/null | awk '$2 != "lo" && $2 !~ /^wg_s2s/ {print $4}')
  have=$(ip -4 rule show pref "$PREF" 2>/dev/null)
  for n in "$@"; do
    if ! [[ $n =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then echo "error=geçersiz ağ: $n"; return 1; fi
    clash=""
    for l in $locals; do
      if nets_overlap "$n" "$l"; then clash=$l; break; fi
    done
    if [ -n "$clash" ]; then log "uzak ağ $n bu cihazın $clash ağıyla çakışıyor — SD-WAN yolu kurulmadı"; continue; fi
    ip -4 route replace unreachable "$n" metric "$METRIC" table "$TABLE" || { echo "error=$n: unreachable kurulamadı"; return 1; }
    printf '%s\n' "$have" | grep -qF " to $n lookup " || ip -4 rule add pref "$PREF" to "$n" lookup "$TABLE" || { echo "error=$n: kural eklenemedi"; return 1; }
  done
  return 0
}

sd_down() {
  local t pair c j h n=0 left=""
  systemctl disable --now "wg-quick@$IF" >/dev/null 2>&1 || true
  if [ -e "/sys/class/net/$IF" ]; then ip link del "$IF" >/dev/null 2>&1 || true; fi
  # Önce kurallar (trafik ana tabloya döner), sonra tablo: arada uzak ağlara giden paket operatöre değil hataya düşer.
  while ip -4 rule del pref "$PREF" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -lt 300 ] || break; done
  ip -4 route flush table "$TABLE" >/dev/null 2>&1 || true
  if nft list table inet pi5_sdwan >/dev/null 2>&1; then nft delete table inet pi5_sdwan >/dev/null 2>&1 || true; fi
  for t in filter pi5_filter; do
    nft list table inet "$t" >/dev/null 2>&1 || continue
    for pair in input:pi5_sdwan_in forward:pi5_sdwan_fwd; do
      c=${pair%%:*}; j=${pair#*:}
      for h in $(nft -a list chain inet "$t" "$c" 2>/dev/null | sed -n "s/.*jump $j # handle \([0-9][0-9]*\).*/\1/p"); do
        nft delete rule inet "$t" "$c" handle "$h" >/dev/null 2>&1 || log "$t $c: $j atlaması silinemedi"
      done
      if nft list chain inet "$t" "$j" >/dev/null 2>&1; then nft delete chain inet "$t" "$j" >/dev/null 2>&1 || log "$t: $j silinemedi"; fi
    done
  done
  rm -f "$CONF" "$NFT_FILE" "$CORE"/pi5-sdwan-*.nft
  # Açılış koruması birimi (panel SD-WAN açıkken yazar): dosya gidince zaten bir şey yapmaz, yine de kalmasın.
  if [ -e "$GUARD_UNIT" ]; then
    systemctl disable pi5-sdwan-guard.service >/dev/null 2>&1 || true
    rm -f "$GUARD_UNIT"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  # Doğrulama: arayüz, kural, tablo, nft tablosu ve birim kalmadı
  [ -e "/sys/class/net/$IF" ] && left="$left arayüz"
  [ -n "$(ip -4 rule show pref "$PREF" 2>/dev/null)" ] && left="$left ip-rule"
  [ -n "$(ip -4 route show table "$TABLE" 2>/dev/null)" ] && left="$left tablo-$TABLE"
  nft list table inet pi5_sdwan >/dev/null 2>&1 && left="$left pi5_sdwan"
  for t in filter pi5_filter; do
    for j in pi5_sdwan_in pi5_sdwan_fwd; do nft list chain inet "$t" "$j" >/dev/null 2>&1 && left="$left $t/$j"; done
  done
  [ -e "$GUARD_UNIT" ] && left="$left pi5-sdwan-guard"
  if [ -n "$left" ]; then echo "error=SD-WAN tam kaldırılamadı:$left"; return 1; fi
  return 0
}

cmd=${1:-}
[ "$(id -u)" = 0 ] || { echo "error=root olarak çalıştırın"; exit 1; }
if [ "$cmd" = rules ]; then
  shift
  sd_rules "$@" || exit 1
  echo "ok=1"
  exit 0
fi
exec 9>"$LOCK"
flock -w 30 9 || { echo "error=başka bir SD-WAN işlemi sürüyor"; exit 1; }
case "$cmd" in
  down)
    sd_down || exit 1
    echo "ok=1"
    ;;
  rollback)
    stage=$(sed -n 's/^stage=//p' "$TRIAL" 2>/dev/null | head -1)
    if [ "$stage" != trial ]; then echo "ok=1"; echo "skipped=1"; exit 0; fi
    rc=0
    listen=0
    notice=""
    [ "${2:-}" = timer ] && notice="notice=timer"
    if grep -qE '^[[:space:]]*ListenPort[[:space:]]*=' "$CONF" 2>/dev/null; then listen=1; fi
    # Durum önce: "Kalıcı yap" artık kabul edilmez, panelin o an süren işi bitince 'rolledback'i görüp kendi eklediğini kaldırır.
    if printf 'stage=rolledback\nuntil=0\nat=%s\n%s\n' "$(date +%s)" "$notice" > "$TRIAL.tmp" && mv -f "$TRIAL.tmp" "$TRIAL"; then :; else
      echo "error=durum dosyası yazılamadı"; rc=1
    fi
    sd_down || rc=1
    log "deneme süresi \"Kalıcı yap\"sız doldu — SD-WAN geri alındı"
    # UDP 51821 izni (merkez Klyrix) internet kartı / yedek hat güvenlik duvarından kalksın (wg_listen_port artık boş).
    # Şubede (ListenPort yok) izin hiç yazılmamıştı: yeniden yükleme gerekmez.
    if [ "$listen" = 1 ] && [ -f "$NET_MODE" ]; then
      bash "$NET_MODE" wan fw >/dev/null 2>&1 || log "internet kartı güvenlik duvarı yeniden yüklenemedi"
      bash "$NET_MODE" backup fw >/dev/null 2>&1 || log "yedek hat güvenlik duvarı yeniden yüklenemedi"
    fi
    [ "$rc" = 0 ] && echo "ok=1"
    exit "$rc"
    ;;
  *)
    echo "error=kullanım: sdwan.sh down | rollback [timer] | rules AĞ…"; exit 1
    ;;
esac

#!/usr/bin/env bash
# Klyrix Gate — Pi-hole DHCP sunucusu (Faz 2, topoloji A: modem 192.168.1.1 kalır, yalnız DHCP'si kapanır; Pi eth0'da
# iki adres taşır: modem tarafı + cihazlar için 192.168.0.1). Root olarak çalışır; aynı anda tek işlem (flock).
#   status               durum satırları (kilitsiz)
#   probe [--iface I]    ağda yanıt veren DHCP sunucularını arar (yalnız DHCPDISCOVER — kira ALINMAZ)
#   enable --trial SN --start A --end B --router R --netmask M --lease L
#                        Pi-hole DHCP'sini deneme olarak açar; SN saniye içinde "confirm" gelmezse geri alınır
#   confirm [--lease 12h] denemeyi kalıcı yapar (kira süresi uzar, ayrıntılı DHCP günlüğü kapanır)
#   rollback             yalnız deneme sürüyorsa DHCP'yi kapatır, önceki ayarları geri yükler (zamanlayıcı / açılış)
#   disable [--force]    DHCP'yi kapatır; modemin DHCP'si açık olmalı (--force: denetlemeden — kurtarma)
#   ensure               güncelleme/açılış: süresi geçen denemeyi geri alır. DHCP'yi ASLA kendiliğinden açmaz.
#   ack                  "modemin DHCP'sini geri açın" uyarısını (modem_warn) kaldırır
# Kurtarma:  sudo bash /opt/pi5-gateway/scripts/pi-dhcp.sh disable --force   (sonra modemin DHCP'sini açın)
# Anahtarlar yalnız FTL DURMUŞKEN yazılır: çalışan FTL pihole.toml'daki her değişikliği görüp kendini yeniden başlatır
# (anahtar başına bir restart; başlatma sınırı 60 sn'de 5). Sıra: işaret dosyası → stop → yaz → geri oku → start →
# işaret silinir (backend açılışta işareti görürse durmuş kalmış FTL'i başlatır). dhcp.active en son açılır, geri
# almada ilk kapatılır: DHCP kapalıyken diğer anahtarlar dnsmasq yapılandırmasına girmez.
set -u
export LC_ALL=C
umask 077
DIR=/etc/pi5-gateway/dhcp
STATE=$DIR/state
SNAP=$DIR/snapshot
ADDED=$DIR/hosts.added
TOML=/etc/pihole/pihole.toml
TOML_BAK=$DIR/pihole.toml.bak
NET_STATE=/etc/pi5-gateway/net/state
MARKER=/opt/pi5-gateway/core/.ftl_restart_inprogress
LEASES=/etc/pihole/dhcp.leases
DNSMASQ_CONF=/etc/pihole/dnsmasq.conf
TIMER_UNIT=pi5-dhcp-rollback
RETRY_PREFIX=$TIMER_UNIT-retry
LOCK=/run/pi5-dhcp.lock
SELF=$(readlink -f "$0")
PROBE=${SELF%/*}/dhcp-probe.py
# Yazım sırası (dhcp.active EN SON). Anlık görüntü (SNAP) bu anahtarların önceki değerlerini tutar.
KEYS=(dhcp.start dhcp.end dhcp.router dhcp.netmask dhcp.leaseTime dhcp.ipv6 dhcp.rapidCommit dhcp.logging dhcp.hosts dhcp.active)

die() { echo "error=$*"; exit 1; }
# enable taramadan (modemin DHCP'si kapalı doğrulandı) sonra başarısız olursa evde DHCP veren kimse kalmaz → uyarı.
# Uyarı durum dosyasına da yazılır (modem_warn): panel sayfası o an açık olmasa da kart "modemin DHCP'sini geri açın" der.
die_nodhcp() { S_MODEM_WARN=$(date +%s); write_state "$STAGE" "$TRIAL_END"; echo "warning=modem_dhcp"; die "$@"; }
log() { logger -t pi5-dhcp "$*" 2>/dev/null || true; }

# JSON / TOML işleri (dhcp.hosts). `pihole-FTL --config dhcp.hosts` dizi elemanlarını tırnaksız ve virgülle birleşik
# basar ("[ aa:..,ignore, 11:..,192.168.0.5,ad ]": elemanın kendi virgülüyle ayırt edilemez) → dizi pihole.toml'dan
# okunur (python3 tomllib, 3.11+), FTL'e JSON dizi olarak yazılır.
PYHELP=$(cat <<'PY'
import json, re, sys
MAC = re.compile(r'^([0-9a-f]{2}:){5}[0-9a-f]{2}$')
def load(s):
    v = json.loads(s)
    if not isinstance(v, list):
        raise ValueError('liste değil')
    return [str(x) for x in v]
def dump(v):
    return json.dumps(v, separators=(',', ':'))
cmd, a = sys.argv[1], sys.argv[2:]
if cmd == 'toml-hosts':
    import tomllib
    with open(a[0], 'rb') as f:
        h = tomllib.load(f).get('dhcp', {}).get('hosts', [])
    print(dump([str(x) for x in h] if isinstance(h, list) else []))
elif cmd == 'merge':
    # merge MEVCUT_JSON MAC... → 1. satır yeni liste, 2. satır eklenenler. Zaten bir girişte geçen MAC'e dokunulmaz.
    cur = load(a[0])
    seen = {p.strip().lower() for x in cur for p in x.split(',') if MAC.match(p.strip().lower())}
    added = []
    for m in a[1:]:
        m = m.lower()
        if MAC.match(m) and m not in seen:
            seen.add(m)
            added.append(m + ',ignore')
    print(dump(cur + added))
    print(dump(added))
elif cmd == 'minus':
    drop = set(load(a[1]))
    print(dump([x for x in load(a[0]) if x not in drop]))
elif cmd == 'same':
    sys.exit(0 if load(a[0]) == load(a[1]) else 1)
elif cmd == 'probe':
    # probe TARAMA_JSON KENDİ_IP... → servers= (Pi'nin kendisi dışındakiler), own=, other=
    own = set(a[1:])
    srv, mine = [], []
    for s in json.loads(a[0]).get('servers', []):
        ip = str(s.get('server') or '')
        if not re.fullmatch(r'\d{1,3}(\.\d{1,3}){3}', ip):
            continue
        dst = mine if ip in own else srv
        if ip not in dst:
            dst.append(ip)
    print('servers=' + ','.join(srv))
    print('own=' + ','.join(mine))
    print('other=%d' % len(srv))
else:
    sys.exit(2)
PY
)
pyh() { python3 -c "$PYHELP" "$@"; }
toml_hosts() { pyh toml-hosts "$TOML" 2>/dev/null; }

# ── FTL yapılandırması ──
# FTL CLI pihole.toml'u (ve config_backups/, dnsmasq sınama dosyasını) çağıranın umask'ıyla yeniden yazar: bu betiğin
# 077'si 0640'ı 0600 yapardı → Pi-hole'un olağan umask'ı (022) ile çalıştırılır.
ftl_cli() { ( umask 022; exec pihole-FTL "$@" ); }
# Tek değer (dizi olmayan anahtarlar). Olası uyarı satırları atlanır: değer son satırdır.
ftl_get() {
  local out
  out=$(ftl_cli --config "$1" 2>/dev/null) || return 1
  printf '%s\n' "${out##*$'\n'}"
}
# Yazım. FTL dnsmasq'a giden anahtarlarda yeni yapılandırmayı sınar; reddederse FTL_ERR.
ftl_set() {
  local out
  if out=$(ftl_cli --config "$1" "$2" 2>&1); then FTL_ERR=""; return 0; fi
  FTL_ERR=${out##*$'\n'}
  return 1
}
managed_key() { local k; for k in "${KEYS[@]}"; do [ "$k" = "$1" ] && return 0; done; return 1; }

ftl_prop() { systemctl show -p "$1" --value pihole-FTL 2>/dev/null; }
ftl_unit_exists() { systemctl cat pihole-FTL >/dev/null 2>&1; }
ftl_running() { systemctl is-active --quiet pihole-FTL 2>/dev/null; }

# FTL durmuşken "$@" çalışır; işin çıkış kodu döner. FTL her durumda yeniden başlatılır (reset-failed başlatma
# sınırı sayacını da sıfırlar).
with_ftl_stopped() {
  local rc
  mkdir -p "${MARKER%/*}" 2>/dev/null
  date -Is > "$MARKER" 2>/dev/null || true
  systemctl stop pihole-FTL >/dev/null 2>&1 || true
  "$@"; rc=$?
  systemctl reset-failed pihole-FTL >/dev/null 2>&1 || true
  systemctl start pihole-FTL >/dev/null 2>&1 || true
  rm -f "$MARKER"
  return "$rc"
}

# Yerel DNS (127.0.0.1:53) yanıt veriyor mu? NXDOMAIN/SERVFAIL de yanıttır. dig yoksa python soketi.
dns_ok() {
  if command -v dig >/dev/null 2>&1; then
    dig +time=2 +tries=1 @127.0.0.1 pi.hole >/dev/null 2>&1
    return
  fi
  python3 -c '
import os, socket, sys
q = os.urandom(2) + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pi\x04hole\x00\x00\x01\x00\x01"
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(2)
try:
    s.sendto(q, ("127.0.0.1", 53))
    sys.exit(0 if s.recv(512)[:2] == q[:2] else 1)
except OSError:
    sys.exit(1)' 2>/dev/null
}
port67_ok() { ss -H -ulpn 'sport = :67' 2>/dev/null | grep -q '"pihole-FTL"'; }
# UDP 67'yi FTL dışında tutan program adı (yoksa boş).
port67_foreign() {
  ss -H -ulpn 'sport = :67' 2>/dev/null | grep -v '"pihole-FTL"' | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1
}

# Sağlık (en çok 120 sn): $1 = dns | full. full: DNS + UDP 67'yi pihole-FTL tutuyor (en çok 30 sn) + dnsmasq.conf'ta
# dhcp-range=<S_START>. FTL çöker / kendiliğinden yeniden başlarsa beklemeden başarısız. HEALTH_DETAIL.
ftl_health() {
  local deadline r0 st sub r i f
  HEALTH_DETAIL=""
  deadline=$(( $(date +%s) + 120 ))
  r0=$(ftl_prop NRestarts); [[ $r0 =~ ^[0-9]+$ ]] || r0=0
  until dns_ok; do
    st=$(ftl_prop ActiveState); sub=$(ftl_prop SubState); r=$(ftl_prop NRestarts); [[ $r =~ ^[0-9]+$ ]] || r=0
    if [ "$st" = failed ] || [ "$st" = inactive ] || [ "$sub" = auto-restart ] || [ "$r" -gt "$r0" ]; then
      HEALTH_DETAIL="pihole-FTL çalışmıyor ya da çöküp yeniden başlıyor ($st/$sub) — journalctl -u pihole-FTL"
      return 1
    fi
    # full: UDP 67'yi başka bir program tutuyorsa FTL'in dnsmasq'ı DHCP soketini açamaz; FTL 6.5 süreci ayakta kalır
    # ama DNS de susar ("failed to bind DHCP server socket") → 120 sn beklenmez, gerçek neden yazılır.
    f=""; [ "$1" = full ] && f=$(port67_foreign)
    if [ -n "$f" ]; then
      HEALTH_DETAIL="DHCP portunu (UDP 67) başka bir program tutuyor ($f) — pihole-FTL DHCP'yi başlatamadı, DNS de yanıt vermiyor"
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then HEALTH_DETAIL="yerel DNS (127.0.0.1:53) 120 sn içinde yanıt vermedi"; return 1; fi
    sleep 2
  done
  [ "$1" = full ] || return 0
  for i in $(seq 1 30); do port67_ok && break; sleep 1; done
  port67_ok || { HEALTH_DETAIL="pihole-FTL 30 sn içinde DHCP portunu (UDP 67) açmadı"; return 1; }
  if ! grep -q "^dhcp-range=${S_START//./\\.}," "$DNSMASQ_CONF" 2>/dev/null; then
    HEALTH_DETAIL="$DNSMASQ_CONF içinde dhcp-range=$S_START satırı yok"
    return 1
  fi
  return 0
}

# ── Durum dosyası (key=value, tmp+mv ile atomik) ──
# modem_warn: Pi DHCP'si modemin DHCP'si kapalıyken kapandı/açılamadı (epoch; 0 = yok). ack, başarılı enable ya da
# başka bir DHCP sunucusunu gören tarama temizler.
read_state() {
  local k v
  STAGE=off; TRIAL_END=0; S_START=""; S_END=""; S_ROUTER=""; S_NETMASK=""; S_LEASE=""; S_MODEM_WARN=0
  if [ -f "$STATE" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        stage) STAGE=$v ;; trial_ends) TRIAL_END=$v ;; start) S_START=$v ;; end) S_END=$v ;;
        router) S_ROUTER=$v ;; netmask) S_NETMASK=$v ;; lease) S_LEASE=$v ;; modem_warn) S_MODEM_WARN=$v ;;
      esac
    done < "$STATE"
  fi
  case "$STAGE" in off|trial|on) ;; *) STAGE=off ;; esac
  [[ $TRIAL_END =~ ^[0-9]+$ ]] || TRIAL_END=0
  [[ $S_MODEM_WARN =~ ^[0-9]+$ ]] || S_MODEM_WARN=0
}
write_state() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  printf 'stage=%s\ntrial_ends=%s\nstart=%s\nend=%s\nrouter=%s\nnetmask=%s\nlease=%s\nmodem_warn=%s\n' \
    "$1" "${2:-0}" "$S_START" "$S_END" "$S_ROUTER" "$S_NETMASK" "$S_LEASE" "${S_MODEM_WARN:-0}" > "$STATE.tmp" \
    && mv -f "$STATE.tmp" "$STATE"
}
# key=value dosyasından tek anahtar (yoksa boş).
kv_get() { [ -f "$1" ] && awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$1"; }

# confirm/disable/başarısız enable: zamanlayıcıyı ve (varsa) biten geri alma servisini temizler. Geri alma işi KENDİ
# servisinde çalışır — rollback bunu çağırmaz: kendi servisini durdurmak systemd'nin tüm cgroup'u (bu betik dahil)
# sonlandırmasına yol açardı.
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
# Zamanlayıcıyla çalışan geri alma, yalnız .timer birimlerini durdurur (kendi servisine dokunmaz — bkz. stop_timer).
stop_timer_units() { systemctl stop "$TIMER_UNIT.timer" "$RETRY_PREFIX-*.timer" >/dev/null 2>&1 || true; }

# ── Adres hesapları ──
valid_ip() { [[ $1 =~ ^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$ ]]; }
ip2int() { local IFS=.; set -- $1; echo $(( ($1 << 24) | ($2 << 16) | ($3 << 8) | $4 )); }
int2ip() { echo "$(( ($1 >> 24) & 255 )).$(( ($1 >> 16) & 255 )).$(( ($1 >> 8) & 255 )).$(( $1 & 255 ))"; }
prefix2mask() { int2ip $(( (0xffffffff << (32 - $1)) & 0xffffffff )); }
# 1.2.3.4/24 ağı içinde mi: in_net IP AĞ_IP PREFIX
in_net() {
  local m=$(( (0xffffffff << (32 - $3)) & 0xffffffff ))
  [ $(( $(ip2int "$1") & m )) -eq $(( $(ip2int "$2") & m )) ]
}
net_of() { int2ip $(( $(ip2int "$1") & ((0xffffffff << (32 - $2)) & 0xffffffff) )); }
valid_lease() { [[ $1 =~ ^[0-9]+[smhd]?$ ]] || [ "$1" = infinite ]; }
valid_mac() { [[ $1 =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ ]] && [ "$1" != 00:00:00:00:00:00 ]; }

# En düşük metrikli varsayılan rotanın arayüzü (wg*/lo/docker*/veth* hariç).
default_dev() {
  ip -4 route show default 2>/dev/null | awk '{
    dev = ""; m = 0
    for (i = 1; i <= NF; i++) { if ($i == "dev") dev = $(i + 1); if ($i == "metric") m = $(i + 1) }
    if (dev != "" && dev !~ /^(wg|lo|docker|veth)/) print m, dev
  }' | sort -n | awk 'NR == 1 { print $2 }'
}
# Cihaz ağının arayüzü: ev Wi-Fi'ı açıkken (net-mode.sh home) iki adres köprüdedir (lan_if=br0); köprü yoksa kart.
lan_iface() {
  local b
  b=$(kv_get "$NET_STATE" lan_if)
  if [ -n "$b" ] && [ -e "/sys/class/net/$b" ]; then echo "$b"; else kv_get "$NET_STATE" iface; fi
}
probe_iface() {
  local i
  i=$(lan_iface)
  [ -n "$i" ] && [ -e "/sys/class/net/$i" ] && { echo "$i"; return; }
  default_dev
}
iface_addrs() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{ print $4 }'; }

# Pi'nin diğer fiziksel kartlarının MAC'leri (geçerli + kalıcı; dağıtılan arayüz hariç). Sanal arayüzler (docker, veth,
# wg, köprü) ağa kendi MAC'leriyle çıkmaz → eklenmez.
pi_macs() {
  local d n mac perm served
  served=$(tr 'A-F' 'a-f' < "/sys/class/net/$1/address" 2>/dev/null)
  for d in /sys/class/net/*; do
    n=${d##*/}
    [ "$n" = "$1" ] && continue
    [ -e "$d/device" ] || continue
    [ "$(cat "$d/type" 2>/dev/null)" = 1 ] || continue
    mac=$(tr 'A-F' 'a-f' < "$d/address" 2>/dev/null)
    perm=$(ip -o link show dev "$n" 2>/dev/null | sed -n 's/.* permaddr \([0-9a-fA-F:]\{17\}\).*/\1/p' | tr 'A-F' 'a-f')
    for mac in $mac $perm; do valid_mac "$mac" && [ "$mac" != "$served" ] && echo "$mac"; done
  done | sort -u
}

# Güvenlik duvarı DHCP isteklerini (UDP 67) geçiriyor mu? INPUT_DETAIL.
UDP67_RE='udp dport (67|bootps|[{][^}]*[{ ,](67|bootps)[ ,}])([^0-9a-z]|$)'
input_ok() {
  INPUT_DETAIL=""
  if nft list chain inet filter input 2>/dev/null | grep -q 'policy drop'; then
    if ! nft list chain inet filter pi5_in 2>/dev/null | grep -Eq "$UDP67_RE.*accept"; then
      INPUT_DETAIL="inet filter input (policy drop): pi5_in zincirinde 'udp dport 67 accept' yok"; return 1
    fi
    if ! nft list chain inet filter input 2>/dev/null | grep -q 'jump pi5_in'; then
      INPUT_DETAIL="inet filter input (policy drop): pi5_in zincirine atlama yok"; return 1
    fi
  fi
  if nft list table inet pi5_filter >/dev/null 2>&1 && ! nft list chain inet pi5_filter input 2>/dev/null | grep -Eq "$UDP67_RE"; then
    INPUT_DETAIL="inet pi5_filter input zincirinde 'udp dport 67' izni yok"; return 1
  fi
  return 0
}

# DHCP taraması: PROBE_OUT (servers=/own=/other= satırları), PROBE_OTHER. Çalışmazsa 1 + PROBE_DETAIL.
run_probe() {
  local out err own
  PROBE_OUT=""; PROBE_OTHER=0; PROBE_DETAIL=""
  [ -n "$1" ] && [ -e "/sys/class/net/$1" ] || { PROBE_DETAIL="taranacak arayüz bulunamadı (${1:-?})"; return 1; }
  [ -f "$PROBE" ] || { PROBE_DETAIL="$PROBE yok"; return 1; }
  command -v python3 >/dev/null 2>&1 || { PROBE_DETAIL="python3 kurulu değil"; return 1; }
  err=$(mktemp) || return 1
  if ! out=$(timeout 30 python3 "$PROBE" --iface "$1" --timeout 5 2>"$err"); then
    PROBE_DETAIL="dhcp-probe.py: $(tail -n 1 "$err")"; rm -f "$err"; return 1
  fi
  rm -f "$err"
  own=$(ip -4 -o addr show 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }')
  # shellcheck disable=SC2086
  PROBE_OUT=$(pyh probe "$out" $own) || { PROBE_DETAIL="tarama çıktısı okunamadı"; return 1; }
  PROBE_OTHER=$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^other=//p')
  [[ $PROBE_OTHER =~ ^[0-9]+$ ]] || PROBE_OTHER=0
  return 0
}

# ── Yazım / geri yükleme (FTL DURMUŞKEN, with_ftl_stopped içinden) ──
# WANT[anahtar] sırayla yazılır (dhcp.active en son), sonra hepsi geri okunur. Reddedilen ya da tutmayan değer →
# aynı pencerede anlık görüntüye dönülür, 1 (WRITE_DETAIL / RESTORE_DETAIL).
declare -A WANT
apply_keys() {
  local k got
  WRITE_DETAIL=""; RESTORE_DETAIL=""
  if ftl_running; then WRITE_DETAIL="pihole-FTL durdurulamadı — ayar yazılmadı"; return 1; fi
  for k in "${KEYS[@]}"; do
    ftl_set "$k" "${WANT[$k]}" || { WRITE_DETAIL="Pi-hole $k değerini reddetti${FTL_ERR:+: $FTL_ERR}"; break; }
  done
  if [ -z "$WRITE_DETAIL" ]; then
    for k in "${KEYS[@]}"; do
      if [ "$k" = dhcp.hosts ]; then
        got=$(toml_hosts) && pyh same "$got" "${WANT[$k]}" 2>/dev/null && continue
      else
        got=$(ftl_get "$k") && [ "$got" = "${WANT[$k]}" ] && continue
      fi
      WRITE_DETAIL="geri okuma tutmadı: $k='${got:-}' (beklenen '${WANT[$k]}')"
      break
    done
  fi
  [ -z "$WRITE_DETAIL" ] && return 0
  restore_keys 1 snap || true
  return 1
}

# Önce dhcp.active=false (DHCP kesin kapansın), sonra SNAP'teki diğer anahtarlar önceki değerlerine; hepsi geri okunur.
# dhcp.hosts = şu anki liste − etkinleştirmede eklenenler (arada Pi-hole'dan eklenen sabit kiralar kaybolmasın);
# okunamazsa SNAP'teki liste. $1 = 1 → tutmayan anahtar olursa pihole.toml yedeği geri konur (yalnız deneme sırasında:
# yedek o zaman taze). $2 = snap | active (active: yalnız dhcp.active=false — durum dosyası kaybolmuşsa kurtarma).
# RESTORE_DETAIL; 1 = dhcp.active kapatılamadı.
restore_keys() {
  local use_bak=${1:-0} mode=${2:-snap} k v cur want bad=""
  RESTORE_DETAIL=""
  ftl_set dhcp.active false || bad="dhcp.active"
  if [ "$mode" = snap ] && [ -s "$SNAP" ]; then
    while IFS=$'\t' read -r k v <&3; do
      [ "$k" = dhcp.active ] && continue
      managed_key "$k" || continue
      if [ "$k" = dhcp.hosts ]; then
        want=$v
        if [ -s "$ADDED" ] && cur=$(toml_hosts); then
          cur=$(pyh minus "$cur" "$(cat "$ADDED")" 2>/dev/null) && want=$cur
        fi
        { ftl_set dhcp.hosts "$want" && cur=$(toml_hosts) && pyh same "$cur" "$want" 2>/dev/null; } || bad="$bad dhcp.hosts"
      else
        { ftl_set "$k" "$v" && [ "$(ftl_get "$k")" = "$v" ]; } || bad="$bad $k"
      fi
    done 3< "$SNAP"
  fi
  [ "$(ftl_get dhcp.active)" = false ] || bad="$bad dhcp.active"
  bad=${bad# }
  [ -z "$bad" ] && return 0
  if [ "$use_bak" = 1 ] && [ -s "$TOML_BAK" ] && cp -p "$TOML_BAK" "$TOML.pi5-tmp" && mv -f "$TOML.pi5-tmp" "$TOML"; then
    RESTORE_DETAIL="önceki değerine dönmeyen ayar ($bad) — pihole.toml yedeği geri kondu"
  else
    RESTORE_DETAIL="önceki değerine dönmeyen ayar: $bad"
  fi
  log "geri yükleme: $RESTORE_DETAIL"
  [ "$(ftl_get dhcp.active)" = false ]
}
restore_toml_bak() { cp -p "$TOML_BAK" "$TOML.pi5-tmp" && mv -f "$TOML.pi5-tmp" "$TOML"; }

# confirm: kira süresi + günlük. $1 = kira, $2 = dhcp.logging (true|false).
confirm_keys() {
  WRITE_DETAIL=""
  if ftl_running; then WRITE_DETAIL="pihole-FTL durdurulamadı — ayar yazılmadı"; return 1; fi
  ftl_set dhcp.leaseTime "$1" || { WRITE_DETAIL="Pi-hole dhcp.leaseTime=$1 değerini reddetti${FTL_ERR:+: $FTL_ERR}"; return 1; }
  ftl_set dhcp.logging "$2" || { WRITE_DETAIL="Pi-hole dhcp.logging=$2 değerini reddetti${FTL_ERR:+: $FTL_ERR}"; return 1; }
  [ "$(ftl_get dhcp.leaseTime)" = "$1" ] && [ "$(ftl_get dhcp.logging)" = "$2" ] && return 0
  WRITE_DETAIL="geri okuma tutmadı: dhcp.leaseTime/dhcp.logging"
  return 1
}

# Geri alma yolu (rollback, disable, başarısız enable): durmuş pencerede geri yükle → DNS sağlığı. Deneme sırasında DNS
# gelmezse pihole.toml yedeğiyle bir kez daha. $1 = use_bak, $2 = snap | active. ROLLBACK_DETAIL; 1 = DHCP kapanmadı.
rollback_routine() {
  local rc
  ROLLBACK_DETAIL=""
  with_ftl_stopped restore_keys "$1" "${2:-snap}"; rc=$?
  ROLLBACK_DETAIL=$RESTORE_DETAIL
  if ! ftl_health dns; then
    if [ "$1" = 1 ] && [ -s "$TOML_BAK" ]; then
      with_ftl_stopped restore_toml_bak
      if ftl_health dns; then
        ROLLBACK_DETAIL="${ROLLBACK_DETAIL:+$ROLLBACK_DETAIL; }DNS gelmediği için pihole.toml yedeği geri kondu"
      else
        ROLLBACK_DETAIL="${ROLLBACK_DETAIL:+$ROLLBACK_DETAIL; }geri almadan sonra da DNS yok: $HEALTH_DETAIL"
      fi
    else
      ROLLBACK_DETAIL="${ROLLBACK_DETAIL:+$ROLLBACK_DETAIL; }geri almadan sonra DNS yok: $HEALTH_DETAIL"
    fi
  fi
  [ "$(ftl_get dhcp.active)" = false ] && rc=0
  return "$rc"
}

# ── Komutlar ──
cmd_status() {
  local st hosts n
  read_state
  echo "stage=$STAGE"
  echo "trial_ends=$TRIAL_END"
  echo "now=$(date +%s)"
  echo "active=$(ftl_get dhcp.active)"
  echo "start=$(ftl_get dhcp.start)"
  echo "end=$(ftl_get dhcp.end)"
  echo "router=$(ftl_get dhcp.router)"
  echo "netmask=$(ftl_get dhcp.netmask)"
  echo "lease_time=$(ftl_get dhcp.leaseTime)"
  echo "ipv6=$(ftl_get dhcp.ipv6)"
  hosts=$(toml_hosts) || hosts=$(ftl_get dhcp.hosts)
  echo "hosts=$hosts"
  echo "listening_mode=$(ftl_get dns.listeningMode)"
  if port67_ok; then echo "port67=1"; else echo "port67=0"; fi
  n=$(grep -c '^[0-9]' "$LEASES" 2>/dev/null) || true
  echo "leases=${n:-0}"
  if input_ok; then echo "input_ok=1"; else echo "input_ok=0"; fi
  if ftl_unit_exists; then st=$(ftl_prop ActiveState); else st=missing; fi
  echo "ftl=${st:-unknown}"
  echo "modem_warn=$S_MODEM_WARN"
}

cmd_probe() {
  local iface=""
  if [ "${1:-}" = --iface ]; then iface=${2:-}; fi
  [ -z "$iface" ] || [[ $iface =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || die "geçersiz arayüz adı"
  [ -n "$iface" ] || iface=$(probe_iface)
  run_probe "$iface" || die "DHCP taraması çalışmadı: $PROBE_DETAIL"
  # Başka bir sunucu (modem) yeniden yanıt veriyor: "modemin DHCP'sini geri açın" uyarısı artık gereksiz.
  read_state
  if [ "$PROBE_OTHER" -gt 0 ] && [ "$S_MODEM_WARN" != 0 ]; then S_MODEM_WARN=0; write_state "$STAGE" "$TRIAL_END"; fi
  echo "iface=$iface"
  printf '%s\n' "$PROBE_OUT"
}

cmd_enable() {
  local trial="" start="" end="" router="" netmask="" lease="" now_end rc k v
  local iface transit client gw tip tpfx cip cpfx cnet lm di a d n addrs foreign snap_tmp cur merged added hd
  while [ $# -gt 0 ]; do
    case "$1" in
      --trial) trial=${2:-} ;; --start) start=${2:-} ;; --end) end=${2:-} ;; --router) router=${2:-} ;;
      --netmask) netmask=${2:-} ;; --lease) lease=${2:-} ;;
      *) die "bilinmeyen seçenek: $1" ;;
    esac
    shift 2 || break
  done
  # 9. Girdi: aralık yönlendiricinin alt ağında, başlangıç ≤ bitiş, yönlendirici aralığın dışında, kira biçimi.
  [[ $trial =~ ^[0-9]+$ ]] && [ "$trial" -ge 30 ] && [ "$trial" -le 3600 ] || die "geçersiz deneme süresi (30-3600 sn)"
  for v in "$start" "$end" "$router" "$netmask"; do valid_ip "$v" || die "geçersiz IPv4 adresi: '$v'"; done
  valid_lease "$lease" || die "geçersiz kira süresi: '$lease' (ör. 5m, 12h, infinite)"
  n=0; a=$(ip2int "$netmask")
  while [ $(( (a << n) & 0x80000000 )) -ne 0 ] && [ "$n" -lt 32 ]; do n=$((n + 1)); done
  [ "$(prefix2mask "$n")" = "$netmask" ] && [ "$n" -ge 16 ] && [ "$n" -le 30 ] || die "geçersiz alt ağ maskesi: $netmask (/16-/30)"
  in_net "$start" "$router" "$n" && in_net "$end" "$router" "$n" || die "adres aralığı $start-$end, $router/$n ağının içinde değil"
  [ "$(ip2int "$start")" -le "$(ip2int "$end")" ] || die "aralık başlangıcı ($start) bitişten ($end) büyük"
  if [ "$(ip2int "$router")" -ge "$(ip2int "$start")" ] && [ "$(ip2int "$router")" -le "$(ip2int "$end")" ]; then
    die "yönlendirici adresi ($router) dağıtılacak aralığın ($start-$end) içinde"
  fi
  cnet=$(net_of "$router" "$n")
  a=$(( $(ip2int "$cnet") | (0xffffffff >> n) ))
  if [ "$(ip2int "$start")" -eq "$(ip2int "$cnet")" ] || [ "$(ip2int "$end")" -ge "$a" ]; then
    die "aralık ağ ya da yayın adresini içeriyor ($cnet/$n)"
  fi

  # 1. Pi-hole kurulu ve çalışıyor; deneme / açık DHCP yok.
  for k in pihole-FTL python3 ss ip systemd-run; do command -v "$k" >/dev/null 2>&1 || die "$k bulunamadı"; done
  ftl_unit_exists || die "Pi-hole (pihole-FTL servisi) kurulu değil"
  ftl_running || die "Pi-hole (pihole-FTL) çalışmıyor — önce Pi-hole'u başlatın"
  read_state
  [ "$STAGE" = trial ] && die "Pi DHCP denemesi zaten sürüyor"
  [ "$STAGE" = on ] && die "Pi DHCP sunucusu zaten açık"
  [ "$(ftl_get dhcp.active)" = false ] || die "Pi-hole DHCP'si zaten açık (Pi-hole ayarlarından açılmış) — önce oradan kapatın"
  foreign=$(port67_foreign)
  [ -z "$foreign" ] || die "DHCP portunu (UDP 67) başka bir program tutuyor ($foreign) — önce onu durdurun"

  # 2. Pi'nin sabit adresi onaylanmış olmalı (net-mode.sh). İnternet kartı (WAN router) modunda eth0 / br0'da modem
  #    tarafı adres yoktur: aşağıdaki tek kollu denetimler geçerli değil (Pi DHCP'si WAN açılmadan önce açılır).
  [ "$(kv_get "$NET_STATE" stage)" = static ] || die "önce Pi'ye sabit adres verin ve onaylayın"
  case "$(kv_get "$NET_STATE" wan_stage)" in
    trial|on) die "internet kartı (WAN router) açık — Pi DHCP'si WAN kapalıyken açılır (Cihaz Rolleri → WAN router → Kapat)" ;;
  esac
  iface=$(lan_iface); transit=$(kv_get "$NET_STATE" transit)
  client=$(kv_get "$NET_STATE" client); gw=$(kv_get "$NET_STATE" gw)
  tip=${transit%/*}; tpfx=${transit#*/}; cip=${client%/*}; cpfx=${client#*/}
  if [ -z "$iface" ] || ! valid_ip "$tip" || ! valid_ip "$cip" || ! valid_ip "$gw" \
     || ! [[ $tpfx =~ ^[0-9]+$ && $cpfx =~ ^[0-9]+$ ]]; then
    die "sabit adres kaydı ($NET_STATE) eksik ya da bozuk"
  fi

  # 3. Arayüz yönlendirici (cihaz tarafı) ve modem tarafı adreslerini taşıyor; varsayılan rota modeme.
  [ "$router" = "$cip" ] || die "yönlendirici adresi ($router) Pi'nin cihaz tarafı adresi ($cip) değil"
  [ "$n" = "$cpfx" ] || die "alt ağ maskesi ($netmask) Pi'nin cihaz tarafı adresiyle ($client) uyuşmuyor"
  addrs=$(iface_addrs "$iface")
  printf '%s\n' "$addrs" | grep -qxF "$client" || die "$iface arayüzünde cihaz tarafı adresi ($client) yok — sabit adres profili etkin değil"
  printf '%s\n' "$addrs" | grep -qxF "$transit" || die "$iface arayüzünde modem tarafı adresi ($transit) yok — sabit adres profili etkin değil"
  ip -4 route show default 2>/dev/null | grep -Eq "via ${gw//./\\.} dev $iface( |$)" \
    || die "varsayılan rota $iface üzerinden modeme ($gw) gitmiyor"

  # 4. Pi'nin Wi-Fi'si ev ağından ayrılmış olmalı (yoksa Wi-Fi bacağı aynı ağda ikinci bir kapı olur).
  for d in /sys/class/net/wl*; do
    [ -e "$d" ] || continue
    for a in $(iface_addrs "${d##*/}"); do
      if in_net "${a%/*}" "$cip" "$cpfx" || in_net "${a%/*}" "$tip" "$tpfx"; then
        die "Pi'nin Wi-Fi'si hâlâ ev ağına bağlı — önce 'Wi-Fi bağlantısını ayır'"
      fi
    done
  done

  # 5. Ağ geçidi kuralları cihaz ağını kapsıyor (NAT + eski forward policy drop izni).
  nft list table ip pi5_wgnat 2>/dev/null | grep -qF "$cnet/$n" \
    || die "ağ geçidi NAT kuralları (pi5_wgnat) $cnet/$n ağını içermiyor — panelden yönlendirme kurallarını uygulayın"
  if nft list chain inet filter forward 2>/dev/null | grep -q 'policy drop'; then
    nft list chain inet filter pi5_gw 2>/dev/null | grep -qF "$cnet/$n" \
      || die "güvenlik duvarı (inet filter forward, policy drop) $cnet/$n ağına izin vermiyor — pi5_gw zinciri eksik"
  fi

  # 6. Güvenlik duvarı DHCP isteklerini geçiriyor.
  input_ok || die "güvenlik duvarı DHCP isteklerini (UDP 67) engelliyor — $INPUT_DETAIL"

  # 7. DNS dinleme modu 192.168.0.x istemcilerini yanıtlar.
  lm=$(ftl_get dns.listeningMode); lm=${lm^^}
  case "$lm" in
    LOCAL|ALL|BIND) ;;
    SINGLE)
      di=$(ftl_get dns.interface)
      [ -z "$di" ] || [ "$di" = "$iface" ] || die "Pi-hole DNS yalnız '$di' arayüzünü dinliyor — Pi-hole → Ayarlar → DNS: arayüz $iface olmalı" ;;
    *) die "Pi-hole DNS dinleme modu (dns.listeningMode=${lm:-?}) DHCP istemcilerine uygun değil — Pi-hole → Ayarlar → DNS'te 'yerel' ya da 'tüm arayüzler' seçin" ;;
  esac

  # 8. Ağda başka DHCP sunucusu yok (modemin DHCP'si kapalı).
  run_probe "$iface" || die "DHCP taraması çalışmadı: $PROBE_DETAIL"
  if [ "$PROBE_OTHER" -gt 0 ]; then
    die "başka bir DHCP sunucusu yanıt veriyor ($(printf '%s\n' "$PROBE_OUT" | sed -n 's/^servers=//p')) — modemin DHCP'sini kapatın"
  fi

  # Anlık görüntü: yönetilen anahtarların önceki değerleri + pihole.toml yedeği. dhcp.hosts pihole.toml'dan JSON olarak.
  mkdir -p "$DIR" && chmod 700 "$DIR"
  snap_tmp=$(mktemp "$DIR/.snapshot.XXXXXX") || die_nodhcp "anlık görüntü yazılamadı"
  for k in "${KEYS[@]}"; do
    if [ "$k" = dhcp.hosts ]; then
      v=$(toml_hosts) || { rm -f "$snap_tmp"; die_nodhcp "Pi-hole dhcp.hosts okunamadı ($TOML)"; }
    else
      v=$(ftl_get "$k") || { rm -f "$snap_tmp"; die_nodhcp "Pi-hole ayarı okunamadı: $k"; }
    fi
    printf '%s\t%s\n' "$k" "$v" >> "$snap_tmp"
  done
  mv -f "$snap_tmp" "$SNAP"
  cp -p "$TOML" "$TOML_BAK" || die_nodhcp "pihole.toml yedeklenemedi"
  cur=$(awk -F '\t' '$1 == "dhcp.hosts" { print $2 }' "$SNAP")
  # shellcheck disable=SC2046
  { read -r merged; read -r added; } < <(pyh merge "$cur" $(pi_macs "$iface"))
  [ -n "${merged:-}" ] && [ -n "${added:-}" ] || die_nodhcp "dhcp.hosts listesi hazırlanamadı"
  printf '%s\n' "$added" > "$ADDED"

  S_START=$start; S_END=$end; S_ROUTER=$router; S_NETMASK=$netmask; S_LEASE=$lease
  WANT=([dhcp.start]=$start [dhcp.end]=$end [dhcp.router]=$router [dhcp.netmask]=$netmask [dhcp.leaseTime]=$lease
        [dhcp.ipv6]=false [dhcp.rapidCommit]=false [dhcp.logging]=true [dhcp.hosts]=$merged [dhcp.active]=true)

  # Deneme + geri alma zamanlayıcısı DEĞİŞİKLİKTEN ÖNCE. Kurulamazsa deneme güvenli değildir → hiçbir şey yazılmaz.
  # Kilit tanımlayıcısı (9) devredilmez: geri alma işi kilidi kendisi alır.
  stop_timer
  now_end=$(( $(date +%s) + trial ))
  S_MODEM_WARN=0
  write_state trial "$now_end"
  if ! systemd-run --quiet --collect --unit="$TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
       /bin/bash "$SELF" rollback >/dev/null 2>&1 9>&-; then
    write_state off 0
    die_nodhcp "geri alma zamanlayıcısı kurulamadı — DHCP açılmadı"
  fi
  log "deneme: $start-$end yönlendirici $router kira $lease ($iface), $trial sn"

  # Durmuş pencere: yaz → geri oku (tutmazsa aynı pencerede geri yüklenir) → FTL başlar.
  with_ftl_stopped apply_keys; rc=$?
  if [ "$rc" != 0 ]; then
    ftl_health dns || RESTORE_DETAIL="${RESTORE_DETAIL:+$RESTORE_DETAIL; }$HEALTH_DETAIL"
    S_MODEM_WARN=$(date +%s)
    write_state off 0
    stop_timer
    log "açılamadı: $WRITE_DETAIL"
    echo "warning=modem_dhcp"
    echo "detail=$WRITE_DETAIL${RESTORE_DETAIL:+ — $RESTORE_DETAIL}"
    die "Pi-hole DHCP ayarları yazılamadı — önceki ayarlar geri yüklendi"
  fi
  if ! ftl_health full; then
    hd=$HEALTH_DETAIL
    rollback_routine 1 snap || true
    S_MODEM_WARN=$(date +%s)
    write_state off 0
    stop_timer
    log "sağlık denetimi başarısız, geri alındı: $hd"
    echo "warning=modem_dhcp"
    echo "detail=$hd${ROLLBACK_DETAIL:+ — $ROLLBACK_DETAIL}"
    die "Pi DHCP sunucusu sağlıklı başlamadı — önceki ayarlar geri yüklendi"
  fi
  echo "trial_ends=$now_end"
  echo "ok=1"
}

cmd_confirm() {
  local lease=12h rc detail
  if [ "${1:-}" = --lease ]; then lease=${2:-}; fi
  valid_lease "$lease" || die "geçersiz kira süresi: '$lease'"
  read_state
  [ "$STAGE" = trial ] || die "Pi DHCP denemesi sürmüyor (süre dolduysa geri alınmıştır)"
  with_ftl_stopped confirm_keys "$lease" false; rc=$?
  if [ "$rc" = 0 ] && ftl_health full; then
    stop_timer
    S_LEASE=$lease
    write_state on 0
    log "kalıcı: $S_START-$S_END kira $lease"
    echo "ok=1"
    return 0
  fi
  [ "$rc" = 0 ] && detail=$HEALTH_DETAIL || detail=$WRITE_DETAIL
  # Deneme ayarlarına dönülür (sağlıklı çalışan son hal); geri alma zamanlayıcısı kurulu kalır.
  with_ftl_stopped confirm_keys "${S_LEASE:-5m}" true || true
  if ! ftl_health full; then
    # Deneme ayarlarıyla da sağlıksız: evin DNS'i zamanlayıcıyı (en çok deneme süresi) beklemesin — hemen geri al.
    detail="$detail; deneme ayarlarıyla da: $HEALTH_DETAIL"
    log "kalıcı yapılamadı, deneme ayarları da sağlıksız — hemen geri alınıyor: $detail"
    do_rollback
    echo "detail=$detail${ROLLBACK_DETAIL:+ — $ROLLBACK_DETAIL}"
    die "kalıcı yapılamadı ve Pi DHCP deneme ayarlarıyla da sağlıklı çalışmadı — hemen geri alındı"
  fi
  # Zamanlayıcı bu sırada (kilit beklerken) vazgeçmiş olabilir: deneme zamanlayıcısız kalmasın.
  timer_active || arm_retry 60 || detail="$detail; geri alma zamanlayıcısı yeniden kurulamadı"
  log "kalıcı yapılamadı: $detail"
  echo "detail=$detail"
  die "kalıcı yapılamadı — deneme sürüyor; onaylanmazsa süre dolunca otomatik geri alınır"
}

# Zamanlayıcının kendisi de bunu çalıştırır: yalnız .timer durdurulur, servise dokunulmaz (bkz. stop_timer).
do_rollback() {
  stop_timer_units
  rollback_routine 1 snap || ROLLBACK_DETAIL="dhcp.active kapatılamadı! ${ROLLBACK_DETAIL:-}"
  S_MODEM_WARN=$(date +%s)
  write_state off 0
  log "deneme geri alındı${ROLLBACK_DETAIL:+: $ROLLBACK_DETAIL}"
  echo "rolled_back=1"
  echo "warning=modem_dhcp"
  [ -z "$ROLLBACK_DETAIL" ] || echo "detail=$ROLLBACK_DETAIL"
}
cmd_rollback() {
  read_state
  [ "$STAGE" = trial ] && do_rollback
  echo "ok=1"
}

cmd_disable() {
  local force=0 mode=snap use_bak=0
  if [ "${1:-}" = --force ]; then force=1; fi
  read_state
  case "$STAGE" in
    on|trial) ;;
    # Durum kaydı kapalı ama DHCP açık (kayıt kaybı / Pi-hole arayüzünden açılmış): yalnız dhcp.active kapatılır —
    # eski anlık görüntü kullanıcının ayarlarının üstüne yazılmaz.
    *) [ "$(ftl_get dhcp.active)" = true ] || die "Pi DHCP sunucusu zaten kapalı"; mode=active ;;
  esac
  # İnternet kartı (WAN router) modunda ev ağında başka DHCP sunucusu yoktur: kapatmak cihazları adressiz bırakır.
  case "$(kv_get "$NET_STATE" wan_stage)" in
    trial|on) die "internet kartı (WAN router) açıkken Pi DHCP'si kapatılamaz — ev ağındaki cihazlar adresini yalnız Pi'den alır; önce Cihaz Rolleri → WAN router'ı kapatın" ;;
  esac
  if [ "$force" = 0 ]; then
    run_probe "$(probe_iface)" || die "DHCP taraması çalışmadı ($PROBE_DETAIL) — modemin DHCP'sinin açık olduğu doğrulanamadı"
    [ "$PROBE_OTHER" -gt 0 ] || die "önce modemin DHCP'sini açın; sonra Pi DHCP'sini kapatın"
  fi
  [ "$STAGE" = trial ] && use_bak=1
  if ! rollback_routine "$use_bak" "$mode"; then
    echo "detail=${ROLLBACK_DETAIL:-}"
    die "Pi-hole DHCP'si kapatılamadı"
  fi
  # --force: modemin DHCP'si doğrulanmadı → uyarı kalıcı; aksi halde modem yanıt veriyor → uyarı temizlenir.
  if [ "$force" = 1 ]; then S_MODEM_WARN=$(date +%s); else S_MODEM_WARN=0; fi
  write_state off 0
  stop_timer
  log "kapatıldı${ROLLBACK_DETAIL:+: $ROLLBACK_DETAIL}"
  [ "$force" = 1 ] && echo "warning=modem_dhcp"
  [ -z "$ROLLBACK_DETAIL" ] || echo "detail=$ROLLBACK_DETAIL"
  echo "ok=1"
}

# Kullanıcı "modemin DHCP'sini açtım" dedi: kalıcı uyarı kaldırılır.
cmd_ack() {
  read_state
  S_MODEM_WARN=0
  write_state "$STAGE" "$TRIAL_END" || die "durum dosyası yazılamadı ($STATE)"
  echo "ok=1"
}

cmd_ensure() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  read_state
  case "$STAGE" in
    trial)
      # Süre dolduysa ya da geri alma zamanlayıcısı yoksa (Pi yeniden başladı: geçici zamanlayıcı /run'daydı; ya da
      # zamanlayıcı kurulamadan süreç öldü) deneme geri alınır — onaylayacak tarayıcı oturumu zaten yok.
      if [ "$TRIAL_END" -le "$(date +%s)" ] || ! timer_active; then do_rollback; fi ;;
    on)
      [ "$(ftl_get dhcp.active)" = true ] || echo "warning=dhcp_off" ;;
  esac
  echo "ok=1"
}

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)"
cmd=${1:-status}
shift || true
if [ "$cmd" = status ]; then cmd_status; exit 0; fi
exec 9>"$LOCK"
if ! flock -w 60 9; then
  # Zamanlayıcıyla gelen geri alma kilidi alamadıysa (ör. uzun süren bir "Kalıcı yap") vazgeçmez: 30 sn sonra yeniden
  # dener — deneme zamanlayıcısız kalıp gece bakımında sahipsiz geri alınmasın.
  if [ "$cmd" = rollback ]; then arm_retry 30 || true; fi
  die "başka bir DHCP işlemi sürüyor"
fi
# Değişiklik yapan komutlar yarıda kesilmez (net-mode.sh ile aynı): panel yeniden başlatılırken ya da SSH oturumu kapanırken
# gelen TERM/HUP, FTL durmuşken betiği öldürüp evi DNS'siz bırakmasın. systemd yine de süre dolunca durdurabilir.
case "$cmd" in enable|confirm|rollback|disable) trap '' TERM HUP ;; esac
case "$cmd" in
  probe) cmd_probe "$@" ;;
  enable) cmd_enable "$@" ;;
  confirm) cmd_confirm "$@" ;;
  rollback) cmd_rollback ;;
  disable) cmd_disable "$@" ;;
  ensure) cmd_ensure ;;
  ack) cmd_ack ;;
  *) die "bilinmeyen komut: $cmd (status|probe|enable|confirm|rollback|disable|ensure|ack)" ;;
esac

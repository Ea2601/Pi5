#!/usr/bin/env bash
# Klyrix Gate — ağ geçidi testi teşhisi: Pi'yi ağ geçidi yapan bir istemcinin paketleri Pi'de nereye kadar gidiyor?
# Yalnız SAYAÇ ekler (hiçbir paketi durdurmaz/değiştirmez); süre sonunda sayaç tablosu kaldırılır.
# Panel terminali komutları 120 sn'de keser → ayrık başlat:
#   sudo systemd-run --unit=pi5-gw-diag --collect bash /tmp/pi5-gw-diag.sh
# Sonuç (~150 sn sonra): cat /tmp/pi5-gw-diag.txt
set +e
export LC_ALL=C
DUR=${1:-150}
OUT=/tmp/pi5-gw-diag.txt
NFT=/tmp/pi5-gw-diag.nft
T=pi5_diag

SELF=$(ip -4 -o addr show | awk '{split($4,a,"/"); print a[1]}' | sort -u | paste -sd, -)
SELF_RE=$(echo "$SELF" | sed 's/\./\\./g; s/,/|/g')
NETS=$(ip -4 -o route show proto kernel scope link | awk '{print $1}' | sort -u | paste -sd, -)
LAN_IFS=$(ip -4 -o addr show scope global | awk '$2 !~ /^(wg|lo)/ {print $2}' | sort -u)
# Pi'nin kendisi dışındaki LAN kaynakları (= Pi'yi ağ geçidi yapan istemciler)
CLI="ip saddr { $NETS } ip saddr != { $SELF }"

snap(){ nstat -asz IpForwDatagrams IpInAddrErrors IpOutNoRoutes IpExtInNoRoutes TcpExtIPReversePathFilter IcmpOutRedirects 2>/dev/null | grep -v '^#'; }

{
  echo "===== Başlangıç $(date '+%H:%M:%S') — süre ${DUR} sn ====="
  echo "LAN arayüzleri: $(echo $LAN_IFS) | ağlar: $NETS | Pi adresleri: $SELF"
  for i in all default $LAN_IFS; do
    printf '%-8s rp_filter=%s forwarding=%s send_redirects=%s arp_ignore=%s arp_filter=%s\n' "$i" \
      "$(sysctl -n net.ipv4.conf.$i.rp_filter)" "$(sysctl -n net.ipv4.conf.$i.forwarding)" \
      "$(sysctl -n net.ipv4.conf.$i.send_redirects)" "$(sysctl -n net.ipv4.conf.$i.arp_ignore)" \
      "$(sysctl -n net.ipv4.conf.$i.arp_filter)"
  done
  echo "--- nft tabloları, input/forward politikaları ve eski 'inet filter' forward zinciri:"
  nft list ruleset 2>/dev/null | grep -E '^table|hook (input|forward)'
  nft list chain inet filter forward 2>/dev/null | grep -vE '^[[:space:]]*$'
  echo "--- sayaçlar (önce):"; snap
} > "$OUT"

{
  echo "table inet $T {"
  echo "  chain c_pre {"
  echo "    type filter hook prerouting priority -350; policy accept;"
  for i in $LAN_IFS; do
    echo "    $CLI fib daddr type unicast iifname \"$i\" counter comment \"1_gelen_$i\""
  done
  echo "  }"
  echo "  chain c_fwd {"
  echo "    type filter hook forward priority -350; policy accept;"
  for o in $LAN_IFS 'wg_vps*'; do
    echo "    $CLI oifname \"$o\" counter comment \"2_iletilen_${o//\*/}\""
  done
  echo "    ip daddr { $NETS } ip daddr != { $SELF } counter comment \"4_istemciye_donen_yanit\""
  echo "  }"
  echo "  chain c_post {"
  echo "    type filter hook postrouting priority 350; policy accept;"
  echo "    $CLI oifname != \"lo\" counter comment \"3_pi_den_cikan\""
  echo "  }"
  echo "}"
} > "$NFT"

nft delete table inet $T 2>/dev/null
trap 'nft delete table inet $T 2>/dev/null' EXIT INT TERM
if ! nft -f "$NFT" 2>>"$OUT"; then echo "HATA: nft sayaç tablosu kurulamadı" >> "$OUT"; exit 1; fi
echo "--- sayaçlar kuruldu $(date '+%H:%M:%S'); telefonu şimdi test et" >> "$OUT"

sleep "$DUR"

{
  echo "--- sayaçlar (sonra):"; snap
  echo "--- paket sayaçları (Pi'yi ağ geçidi yapan istemciler):"
  nft list table inet $T 2>/dev/null | grep -oE 'counter packets [0-9]+ bytes [0-9]+ comment "[^"]+"' \
    | sed -E 's/counter packets ([0-9]+) bytes ([0-9]+) comment "([^"]+)"/\3: \1 paket/' | sort
  echo "--- komşular (istemci hangi arayüzden görülüyor):"
  ip -4 neigh show | grep -vE 'FAILED|INCOMPLETE'
  echo "--- istemci bağlantıları (conntrack, web, ilk 15):"
  grep -vE "src=($SELF_RE) " /proc/net/nf_conntrack 2>/dev/null | grep -E 'dport=(80|443) ' | head -15
  echo "===== Bitti $(date '+%H:%M:%S') ====="
} >> "$OUT"

#!/usr/bin/env bash
# Klyrix Gate — WireGuard tünel hızı / MTU ölçümü. Hiçbir ayarı değiştirmez: yalnız ping ve kısa indirme testleri (~60 sn).
# Çalıştırma: sudo bash /tmp/pi5-wg-speed.sh 2>&1 | tee /tmp/pi5-wg-speed.txt
set +e
export LC_ALL=C
h(){ printf '\n===== %s =====\n' "$*"; }
IF=$(wg show interfaces 2>/dev/null | tr ' ' '\n' | grep '^wg_vps' | head -1)
if [ -z "$IF" ]; then echo "wg_vps* tüneli yok"; exit 0; fi
EP=$(wg show "$IF" endpoints | awk '{print $2}' | head -1); EPIP=${EP%:*}
PEER_TUN=10.66.66.1   # VPS tarafı wg0 adresi (ssh.ts: Address = 10.66.66.1/24)

h "Tünel: $IF → $EP"
ip -o link show "$IF" | grep -oE 'mtu [0-9]+'
echo "eth0 / wlan0 MTU: $(cat /sys/class/net/eth0/mtu 2>/dev/null) / $(cat /sys/class/net/wlan0/mtu 2>/dev/null)"
wg show "$IF" latest-handshakes | awk -v now="$(date +%s)" '{print "el sıkışma yaşı:", now-$2, "sn"}'
wg show "$IF" transfer | awk '{printf "aktarım: alınan %.1f MB, gönderilen %.1f MB\n", $2/1048576, $3/1048576}'

h "Gecikme / kayıp"
echo "ISP yolu → VPS ($EPIP): $(ping -c 5 -i 0.3 -W 2 "$EPIP" 2>&1 | tail -2 | tr '\n' ' ')"
echo "Tünel içi → $PEER_TUN: $(ping -I "$IF" -c 5 -i 0.3 -W 2 "$PEER_TUN" 2>&1 | tail -2 | tr '\n' ' ')"

# Parçalanmasız (DF) ping ile geçen en büyük yükü bulur. $1 hedef, $2 ek ping argümanı, kalanı denenecek boyutlar.
probe(){
  local dst=$1 extra=$2; shift 2
  for s in "$@"; do
    # shellcheck disable=SC2086
    if ping $extra -c 2 -i 0.3 -W 1 -M do -s "$s" "$dst" >/dev/null 2>&1; then
      echo "$s bayt GEÇTİ (IP paketi $((s + 28)))"; return
    fi
    echo "$s bayt geçmedi"
  done
  echo "hiçbiri geçmedi (ICMP engelli olabilir)"
}
h "Dış yol MTU (Pi → VPS, tünel paketlerinin taşındığı yol)"
probe "$EPIP" "" 1472 1464 1452 1432 1412 1392 1372
h "Tünel içi MTU (tünelin içinden geçebilen en büyük paket)"
probe "$PEER_TUN" "-I $IF" 1392 1372 1352 1332 1312 1280 1252 1200

h "Hız (12 sn'lik indirme, Cloudflare)"
URL='https://speed.cloudflare.com/__down?bytes=25000000'
spd(){
  curl "$@" -s -o /dev/null --max-time 12 -w '%{http_code} %{time_connect} %{time_appconnect} %{speed_download}\n' "$URL" \
    | awk '{printf "HTTP %s, bağlanma %.2fs, TLS %.2fs, hız %.1f Mbit/s\n", $1, $2, $3, $4 * 8 / 1000000}'
}
echo "ISP üzerinden:   $(spd)"
echo "Tünel üzerinden: $(spd --interface "$IF")"

h "Google HTTPS (tünel üzerinden)"
curl --interface "$IF" -s -o /dev/null --max-time 10 \
  -w 'HTTP %{http_code}, bağlanma %{time_connect}s, TLS %{time_appconnect}s, toplam %{time_total}s\n' https://www.google.com/ \
  || echo "(başarısız / zaman aşımı)"

h "Telefon yolu: istemciler Pi'nin hangi arayüzünden görülüyor (wlan0 = Pi'nin Wi-Fi'si yolda)"
ip -4 neigh show | grep -vE 'FAILED|INCOMPLETE' | awk '{print $1, $3}'
if command -v iw >/dev/null; then iw dev wlan0 link 2>/dev/null | grep -E 'freq|signal|tx bitrate'; fi
exit 0

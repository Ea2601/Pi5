#!/usr/bin/env bash
# Klyrix Gate — Unbound özyinelemeli DNS işlev testi. SALT OKUNUR: ayar değiştirmez, önbelleği temizlemez, servisi
# yeniden başlatmaz. Her bölüm GEÇTİ / KALDI / UYARI yazar, sonda özet verir. ~20-40 sn sürer.
#   sudo bash /opt/pi5-gateway/scripts/unbound-test.sh 2>&1 | tee /tmp/unbound-test.txt
set +e
export LC_ALL=C
U=127.0.0.1; P=5335
pass=0; fail=0; warn=0
ok(){ pass=$((pass+1)); printf '  [GEÇTİ] %s\n' "$*"; }
no(){ fail=$((fail+1)); printf '  [KALDI] %s\n' "$*"; }
uy(){ warn=$((warn+1)); printf '  [UYARI] %s\n' "$*"; }
h(){ printf '\n== %s ==\n' "$*"; }
q(){ dig +time=3 +tries=1 @"$U" -p "$P" "$@" 2>&1; }                       # doğrudan Unbound
qs(){ q "$@" +short | grep -v '^;'; }                                        # yalnız yanıt değerleri (hata satırları hariç)
st(){ sed -n 's/.*status: \([A-Z]*\).*/\1/p' | head -1; }                  # yanıt kodu
qt(){ sed -n 's/.*Query time: \([0-9]*\) msec.*/\1/p' | head -1; }          # süre (ms)
fl(){ sed -n 's/.*flags: \([a-z ]*\);.*/\1/p' | head -1; }                  # başlık bayrakları
a1(){ awk '!/^;/ && $4=="A"{print $5; exit}'; }                            # ilk A kaydı

echo "Unbound işlev testi — $(hostname) — $(date '+%Y-%m-%d %H:%M:%S')"

h "1. Servis"
if ! command -v unbound >/dev/null; then no "unbound kurulu değil"; else unbound -V 2>/dev/null | head -1 | sed 's/^/  /'; fi
A=$(systemctl is-active unbound 2>/dev/null); E=$(systemctl is-enabled unbound 2>/dev/null)
[ "$A" = active ] && ok "unbound çalışıyor" || no "unbound çalışmıyor (durum: ${A:-?})"
[ "$E" = enabled ] && ok "açılışta başlıyor" || uy "açılışta başlamıyor (${E:-?})"
echo "  başlama: $(systemctl show -p ActiveEnterTimestamp --value unbound 2>/dev/null) · systemd yeniden başlatma sayısı: $(systemctl show -p NRestarts --value unbound 2>/dev/null)"

h "2. Dinleme adresi (yalnız Pi'nin kendisi erişmeli)"
L=$(ss -Hlntu 'sport = :5335' 2>/dev/null | awk '{print $1, $5}')
echo "$L" | sed 's/^/  /'
echo "$L" | grep -q '127.0.0.1:5335' && ok "127.0.0.1:5335 dinleniyor" || no "127.0.0.1:5335 dinlenmiyor"
if [ -n "$L" ]; then
  if echo "$L" | awk '{print $2}' | grep -vqE '^(127\.0\.0\.1|\[::1\]):5335$'; then uy "5335 başka adreste de açık — ağa açık çözücü olabilir"; else ok "5335 ağa kapalı (yalnız yerel)"; fi
fi

h "3. Yapılandırma"
if C=$(unbound-checkconf 2>&1); then ok "yapılandırma geçerli (unbound-checkconf)"; else no "yapılandırma hatası: $C"; fi
echo "  dosyalar: $(ls /etc/unbound/unbound.conf.d/ 2>/dev/null | tr '\n' ' ')"
for o in interface port num-threads do-ip6 prefetch qname-minimisation hide-identity hide-version harden-glue \
         harden-dnssec-stripped use-caps-for-id aggressive-nsec auto-trust-anchor-file cache-min-ttl msg-cache-size \
         rrset-cache-size edns-buffer-size extended-statistics; do
  printf '  %-24s %s\n' "$o" "$(unbound-checkconf -o "$o" 2>/dev/null | tr '\n' ' ')"
done
F=$(grep -rlE '^[[:space:]]*forward-zone' /etc/unbound/ 2>/dev/null)
if [ -z "$F" ]; then ok "forward-zone yok: sorgular başka bir DNS sağlayıcısına iletilmiyor"
else no "forward-zone var ($F): sorgular dış sağlayıcıya iletiliyor, özyinelemeli değil"; grep -rnA4 -E '^[[:space:]]*forward-zone' /etc/unbound/ | sed 's/^/    /'; fi

h "4. Çözümleme (doğrudan Unbound, 127.0.0.1#5335)"
for d in example.com google.com whatsapp.net wikipedia.org cloudflare.com; do
  R=$(q "$d" A); S=$(echo "$R" | st); T=$(echo "$R" | qt); I=$(echo "$R" | a1)
  if [ "$S" = NOERROR ] && [ -n "$I" ]; then ok "$d → $I (${T} ms)"; else no "$d çözülemedi (durum: ${S:-yanıt yok})"; fi
done
R=$(q google.com AAAA); S=$(echo "$R" | st)
[ "$S" = NOERROR ] && ok "AAAA (IPv6 kaydı) sorgusu yanıtlanıyor" || uy "AAAA sorgusu: ${S:-yanıt yok}"

h "5. Gerçekten özyinelemeli mi? (yetkili sunucular soruyu kimin sorduğunu görür)"
R=$(dig +norec +time=3 +tries=1 @198.41.0.4 . SOA 2>&1); FL=$(echo "$R" | fl)
if echo "$FL" | grep -qw aa && ! echo "$FL" | grep -qw ra; then
  ok "kök sunucuya (a.root-servers.net) doğrudan ulaşılıyor — operatör 53 portunu yakalamıyor"
else no "kök sunucu yanıtı beklenmedik (bayraklar: '${FL:-yanıt yok}') — operatör DNS'i yakalıyor olabilir"; fi
W=$(qs whoami.akamai.net A | tail -1)
G=$(qs o-o.myaddr.l.google.com TXT | tr -d '"' | head -1)
PUB=$(curl -s --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p')
echo "  Akamai'nin gördüğü soran IP : ${W:-yok}"
echo "  Google'ın gördüğü soran IP  : ${G:-yok}"
echo "  Pi'nin internetteki IP'si   : ${PUB:-alınamadı}"
if [ -n "$W" ] && [ "$W" = "$PUB" ]; then ok "yetkili sunucular soruyu doğrudan Pi'den alıyor — araya başka çözücü girmiyor"
elif [ -n "$W" ] && [ -n "$PUB" ]; then uy "soran IP Pi'nin IP'si değil: sorgular başka bir çözücü ya da tünel üzerinden çıkıyor"
else uy "karşılaştırma yapılamadı"; fi

h "6. DNSSEC doğrulaması (sahte/değiştirilmiş yanıtlara karşı koruma)"
R=$(q isc.org A +dnssec); FL=$(echo "$R" | fl)
echo "$FL" | grep -qw ad && ok "imzalı alan (isc.org) doğrulandı: ad bayrağı var" \
  || no "isc.org yanıtında 'ad' (doğrulandı) bayrağı yok — DNSSEC doğrulaması çalışmıyor (durum $(echo "$R" | st), bayraklar: $FL)"
# Bozuk imzada Unbound reddetmeden önce diğer yetkili sunucuları da dener (>3 sn sürebilir) → uzun süre.
S=$(dig +time=12 +tries=1 @"$U" -p "$P" dnssec-failed.org A 2>&1 | st)
[ "$S" = SERVFAIL ] && ok "bozuk imzalı alan (dnssec-failed.org) reddedildi: SERVFAIL" \
  || no "bozuk imzalı alan reddedilmedi (durum: ${S:-yanıt yok}) — sahte yanıtlar kabul ediliyor"
S=$(q dnssec-failed.org A +cd | st)
[ "$S" = NOERROR ] && ok "doğrulama kapatılınca (+cd) aynı alan çözülüyor → reddin nedeni gerçekten DNSSEC" \
  || uy "+cd ile de çözülmedi (durum: ${S:-yanıt yok}) — ret başka bir nedenden olabilir"
K=$(unbound-checkconf -o auto-trust-anchor-file 2>/dev/null | head -1); K=${K:-/var/lib/unbound/root.key}
if [ -s "$K" ]; then ok "güven çapası mevcut ($K, son güncelleme: $(date -r "$K" '+%Y-%m-%d'))"; else no "güven çapası dosyası yok/boş ($K)"; fi
N=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
[ "$N" = yes ] && ok "saat eşitli (DNSSEC imza süreleri için gerekli)" || uy "saat eşitli değil (${N:-?}) — DNSSEC doğrulaması hatalı reddedebilir"

h "7. Kimlik / sürüm gizleme"
RV=$(q version.bind TXT CH); RI=$(q id.server TXT CH)
V=$(qs version.bind TXT CH); I=$(qs id.server TXT CH)
if [ -z "$(echo "$RV" | st)" ]; then no "Unbound yanıt vermedi"
else
  [ -z "$V" ] && ok "sürüm gizli ($(echo "$RV" | st))" || uy "sürüm görünüyor: $V"
  [ -z "$I" ] && ok "sunucu kimliği gizli ($(echo "$RI" | st))" || uy "kimlik görünüyor: $I"
fi

h "8. Önbellek ve hız"
T1=$(q www.debian.org A | qt); T2=$(q www.debian.org A | qt)
echo "  www.debian.org: 1. sorgu ${T1:-?} ms, 2. sorgu ${T2:-?} ms"
[ -n "$T2" ] && [ "$T2" -le 5 ] && ok "tekrar eden sorgu önbellekten (${T2} ms)" || uy "tekrar eden sorgu önbellekten gelmedi (${T2:-?} ms)"
N="klyrix-test-$RANDOM$RANDOM.com"; R=$(q "$N" A)
echo "  önbellekte olmayan ad ($N): $(echo "$R" | st), $(echo "$R" | qt) ms (tam özyineleme süresi)"

h "9. Pi-hole → Unbound bağlantısı"
UP=$(pihole-FTL --config dns.upstreams 2>/dev/null)
echo "  Pi-hole üst DNS'leri: ${UP:-okunamadı}"
CNT=$(echo "$UP" | tr -d '[] ' | tr ',' '\n' | grep -c .)
if echo "$UP" | grep -q '127.0.0.1#5335'; then
  [ "$CNT" = 1 ] && ok "Pi-hole'un tek üst DNS'i Unbound" || uy "Unbound'un yanında başka üst DNS'ler de var — sorguların bir kısmı dış sağlayıcıya gider"
else no "Pi-hole Unbound'u kullanmıyor"; fi
LANIP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
for s in 127.0.0.1 $LANIP; do
  R=$(dig +time=3 +tries=1 @"$s" wikipedia.org A 2>&1); S=$(echo "$R" | st)
  [ "$S" = NOERROR ] && ok "Pi-hole ($s:53) üzerinden çözüm çalışıyor ($(echo "$R" | qt) ms)" || no "Pi-hole ($s:53) çözemedi (${S:-yanıt yok})"
done
S=$(dig +time=12 +tries=1 @127.0.0.1 dnssec-failed.org A 2>&1 | st)
[ "$S" = SERVFAIL ] && ok "DNSSEC koruması istemcilere de ulaşıyor (Pi-hole üzerinden bozuk alan: SERVFAIL)" \
  || uy "Pi-hole üzerinden bozuk alan: ${S:-yanıt yok} (beklenen SERVFAIL)"

h "10. İstatistikler (panelin Unbound sayfası unbound-control kullanır)"
if ST=$(unbound-control stats_noreset 2>&1) && echo "$ST" | grep -q '^total.num.queries='; then
  ok "unbound-control çalışıyor"
  echo "$ST" | grep -E '^(time\.up|total\.num\.(queries|cachehits|cachemiss|prefetch|expired)|total\.recursion\.time\.(avg|median)|num\.answer\.rcode\.(NOERROR|SERVFAIL|NXDOMAIN|REFUSED)|num\.answer\.(secure|bogus)|msg\.cache\.count|rrset\.cache\.count|mem\.cache\.(message|rrset))=' | sed 's/^/  /'
  echo "  iş parçacığı sayısı (thread*.num.queries): $(echo "$ST" | grep -c '^thread[0-9]*\.num\.queries=')"
  echo "$ST" | grep -q '^num\.threads=' && echo "  num.threads anahtarı: var" || echo "  num.threads anahtarı: yok (paneldeki Thread kartı bu anahtarı okuyor)"
  echo "$ST" | grep -q '^msg\.cache\.count=' && echo "  msg.cache.count anahtarı: var" || echo "  msg.cache.count anahtarı: yok (paneldeki Önbellek kartı bu anahtarı okuyor)"
else no "unbound-control çalışmıyor — paneldeki Toplam Sorgu / Önbellek kartları 0 kalır: $(echo "$ST" | head -1)"; fi

h "11. Son 24 saatteki Unbound uyarı ve hataları"
if ! command -v journalctl >/dev/null; then uy "journalctl yok, günlük okunamadı"
else
  J=$(journalctl -u unbound --since '24 hours ago' -p warning --no-pager -q 2>/dev/null | tail -15)
  [ -z "$J" ] && ok "uyarı/hata yok" || { uy "günlükte uyarı/hata var:"; echo "$J" | sed 's/^/    /'; }
fi

printf '\n== ÖZET: %d geçti, %d kaldı, %d uyarı ==\n' "$pass" "$fail" "$warn"

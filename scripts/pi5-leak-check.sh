#!/usr/bin/env bash
# Klyrix Gate — yönlendirme kaçağı teşhisi: yönlendirilen bir site neden hâlâ yerel IP'yi / ülkeyi görüyor?
# Salt okunur (hiçbir ayarı değiştirmez), ~40 sn; panel terminalinde de çalışır:
#   sudo bash /opt/pi5-gateway/scripts/pi5-leak-check.sh [--izle [sn]] <istemci-ip> [alan-adı ...]
# --izle: betik önce sn (varsayılan 50) saniye bekler — bu sürede sorunu cihazda yeniden yaşayın; pencere içindeki
#   DNS sorguları (Pi-hole günlüğü, anlık), tünel işaret sayacı ve tünel trafiği farkı raporlanır.
# --izle olmadan: sorunu yaşadıktan hemen sonra (1 dk içinde) çalıştırın; bağlantı kayıtları kısa ömürlüdür.
# Alan adı verilmezse yönlendirme listesindeki ilk 8 alan adı denetlenir.
set +e
export LC_ALL=C
IZLE=0
if [ "$1" = "--izle" ]; then
  IZLE=50; shift
  if [[ $1 =~ ^[0-9]+$ ]]; then IZLE=$1; shift; fi
  [ "$IZLE" -gt 70 ] && IZLE=70   # panel terminali komutu 120 sn'de keser
fi
CLIENT=$1; shift
if ! [[ $CLIENT =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "kullanım: sudo bash $0 [--izle [sn]] <istemci-ip> [alan-adı ...]   (ör. --izle 192.168.1.187 site.com)"; exit 1
fi
CONF=/etc/dnsmasq.d/05-domain-routing.conf
FTLDB=/etc/pihole/pihole-FTL.db
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
h(){ printf '\n===== %s =====\n' "$*"; }
mask4(){ awk -F. 'NF==4{print $1"."$2".x.x"; next}{print}' <<<"$1"; }
flag(){ echo "$*" >> "$TMP/flags"; }
touch "$TMP/flags" "$TMP/ipmap.txt"

DOMAINS=()
for d in "$@"; do
  if [[ $d =~ ^[A-Za-z0-9.-]+$ ]]; then DOMAINS+=("${d,,}"); else echo "atlandı (geçersiz ad): $d"; fi
done
[ ${#DOMAINS[@]} -eq 0 ] && mapfile -t DOMAINS < <(sed -n 's|^ipset=/\([^/]*\)/.*|\1|p' "$CONF" 2>/dev/null | head -8)
LAN_IFS=$(ip -4 -o route show default | awk '{print $5}' | grep -v '^wg' | sort -u)
SELF=$(ip -4 -o addr show | awk '{split($4,a,"/"); print a[1]}' | sort -u | paste -sd, -)
WG_IFS=$(ls /sys/class/net | grep '^wg_vps')
WGADDR=$(for i in $WG_IFS; do ip -4 -o addr show dev "$i" | awk '{split($4,a,"/"); print a[1]}'; done | paste -sd, -)
echo "Klyrix sızıntı teşhisi $(date '+%F %T') — istemci $CLIENT | LAN: $(echo $LAN_IFS) | tünel: ${WG_IFS:-YOK} ${WGADDR:+($WGADDR)}"

# Alan adının yönlendirme kuralı (en uzun sonek eşleşmesi, dnsmasq gibi): "taban → set" ya da boş.
rule_for(){
  awk -F/ -v d="$1" '$1=="ipset=" && (d==$2 || (length(d) > length($2) && substr(d, length(d)-length($2)) == "."$2)) {print length($2), $2" → "$3}' "$CONF" 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-
}
# Tünel setlerinin o anki içeriği ("ip set"); dig de seti doldurduğu için betiğin kendi sorgularından ÖNCE alınır.
snapset(){
  for s in $(ipset list -n 2>/dev/null | grep '^rt_m'); do
    ipset list "$s" 2>/dev/null | grep -E '^[0-9]+\.' | awk -v s="$s" '{print $1, s}'
  done > "$TMP/set.txt"
  SNAP=1
}
marks(){ iptables -t mangle -L PI5_ROUTING -v -n -x 2>/dev/null | awk '/MARK set/ {p += $1; b += $2} END {print p + 0, b + 0}'; }
wgbytes(){ for i in $WG_IFS; do echo "$i $(cat /sys/class/net/$i/statistics/tx_bytes 2>/dev/null) $(cat /sys/class/net/$i/statistics/rx_bytes 2>/dev/null)"; done; }

if [ "$IZLE" -gt 0 ]; then
  LOG=/var/log/pihole/pihole.log
  L0=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  M0=$(marks); wgbytes > "$TMP/wg0"
  sleep "$IZLE"
  M1=$(marks); wgbytes > "$TMP/wg1"
  snapset
  h "0) İzleme penceresi ($IZLE sn)"
  read -r p0 b0 <<<"$M0"; read -r p1 b1 <<<"$M1"
  echo "Tünele işaretlenen paket: +$((p1 - p0)) ($(( (b1 - b0) / 1024 )) KB)"
  join "$TMP/wg0" "$TMP/wg1" | awk '{printf "%s: tünelden gönderilen +%d KB, alınan +%d KB\n", $1, ($4 - $2) / 1024, ($5 - $3) / 1024}'
  [ $((p1 - p0)) -gt 0 ] && flag WMARK
  # Pi-hole günlüğü anlıktır (veritabanı 60 sn geriden gelir). Satır: "... query[A] ad from 192.168.1.187"
  tail -c +$((L0 + 1)) "$LOG" 2>/dev/null \
    | awk -v c="$CLIENT" '{ for (i = 1; i <= NF - 3; i++) if ($i ~ /^query\[/ && $(i+2) == "from" && $(i+3) == c) print tolower($(i+1)) }' \
    | sort | uniq -c | sort -rn > "$TMP/wq.txt"
  echo "Cihazın bu sürede sorduğu alan adları: $(wc -l < "$TMP/wq.txt") (adet | ad | kural)"
  n=0
  while read -r cnt name; do
    [[ $name =~ ^[a-z0-9.-]+$ ]] || continue
    r=$(rule_for "$name")
    printf '  %3d  %-45s %s\n' "$cnt" "$name" "${r:-— kural yok}"
    [ -n "$r" ] && flag WRULED
    n=$((n + 1)); [ $n -le 25 ] || continue
    for ip in $(dig +short +time=2 +tries=1 @127.0.0.1 A "$name" 2>/dev/null | grep -E '^[0-9.]+$'); do echo "$ip $name ${r:+1}" >> "$TMP/ipmap.txt"; done
  done < <(head -40 "$TMP/wq.txt")
  [ -s "$TMP/wq.txt" ] || flag NOQUERY
fi

if [ "$IZLE" -eq 0 ]; then
h "1) IPv6 — modem IPv6 dağıtıyor mu?"
echo "(Dağıtıyorsa telefon IPv6 trafiğini Pi'yi atlayıp doğrudan modemden gönderir; tünel yalnız IPv4 taşır.)"
for i in $LAN_IFS; do
  printf '%-6s disable_ipv6=%s accept_ra=%s forwarding=%s\n' "$i" "$(sysctl -n net.ipv6.conf.$i.disable_ipv6 2>/dev/null)" \
    "$(sysctl -n net.ipv6.conf.$i.accept_ra 2>/dev/null)" "$(sysctl -n net.ipv6.conf.$i.forwarding 2>/dev/null)"
done
echo "(forwarding=1 iken accept_ra=1 yok sayılır: Pi'de global IPv6 olmaması modemin dağıtmadığını göstermez.)"
# Router Solicitation gönderip Router Advertisement dinler (yalnız okuma; Pi'nin adres/rota ayarına dokunmaz).
python3 - $LAN_IFS > "$TMP/ra.txt" 2>&1 <<'PY'
import select, socket, struct, sys, time
SO_BINDTODEVICE = getattr(socket, 'SO_BINDTODEVICE', 25)
def short(p):  # gizlilik: önekin yalnız ilk iki grubu
    return ':'.join(p.split(':')[:2]) + ':…'
def is_global(p):
    try: return (int(p.split(':')[0] or '0', 16) & 0xe000) == 0x2000
    except ValueError: return False
for ifn in sys.argv[1:]:
    try:
        idx = socket.if_nametoindex(ifn)
        s = socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_ICMPV6)
        s.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, ifn.encode())
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_HOPS, 255)
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_MULTICAST_IF, idx)
        s.sendto(struct.pack('!BBHI', 133, 0, 0, 0), ('ff02::2', 0, 0, idx))
    except OSError as e:
        print(f'{ifn}: tarama yapılamadı ({e.strerror or e})')
        continue
    end, seen = time.time() + 6, set()
    while True:
        left = end - time.time()
        if left <= 0 or not select.select([s], [], [], left)[0]:
            break
        data, addr = s.recvfrom(4096)
        src = addr[0].split('%')[0]
        if len(data) < 16 or data[0] != 134 or src in seen:
            continue
        seen.add(src)
        flags, life = data[5], struct.unpack('!H', data[6:8])[0]
        prefixes, dns, usable = [], [], bool(flags & 0x80)
        i = 16
        while i + 2 <= len(data):
            t, l = data[i], data[i + 1] * 8
            if l == 0 or i + l > len(data):
                break
            o = data[i:i + l]
            if t == 3 and l >= 32:
                p, slaac = socket.inet_ntop(socket.AF_INET6, o[16:32]), bool(o[3] & 0x40)
                prefixes.append(f"{short(p)}/{o[2]} {'SLAAC' if slaac else 'SLAAC yok'}{'' if is_global(p) else ' (yerel önek)'}")
                usable = usable or (slaac and is_global(p))
            elif t == 25 and l >= 24:
                dns += [short(socket.inet_ntop(socket.AF_INET6, o[k:k + 16])) for k in range(8, l - 15, 16)]
            i += l
        print(f"{ifn}: RA VAR — yönlendirici {src}, varsayılan rota ömrü {life} sn, DHCPv6 adres={'evet' if flags & 0x80 else 'hayır'}")
        for p in prefixes:
            print(f"   önek {p}")
        if dns:
            print(f"   IPv6 DNS: {', '.join(dns)}")
        if life > 0 and usable:
            print('@@RA6')
    if not seen:
        print(f'{ifn}: 6 sn içinde RA gelmedi')
PY
grep -v '^@@' "$TMP/ra.txt"
grep -q '^@@RA6' "$TMP/ra.txt" && flag RA6
fi

h "2) Alan adları — kural, DNS cevabı, ipset"
echo "([rt_mN] = adres cihazın sorgusuyla tünel setine girmiş; [sette yok] = girmemiş)"
[ -n "$SNAP" ] || snapset
for d in "${DOMAINS[@]}"; do
  rule=$(rule_for "$d")
  printf '\n%s\n' "$d"
  if [ -n "$rule" ]; then echo "  kural : $rule"; else echo "  kural : YOK — listede değil, normal hattan çıkar"; flag "NORULE $d"; fi
  A=$(dig +short +time=2 +tries=1 @127.0.0.1 A "$d" 2>/dev/null | grep -E '^[0-9.]+$')
  AAAA=$(dig +short +time=2 +tries=1 @127.0.0.1 AAAA "$d" 2>/dev/null | grep ':')
  HT=$(dig +short +time=2 +tries=1 @127.0.0.1 HTTPS "$d" 2>/dev/null)
  line=""
  for ip in $A; do
    echo "$ip $d ${rule:+1}" >> "$TMP/ipmap.txt"
    st=$(awk -v ip="$ip" '$1==ip {print $2; exit}' "$TMP/set.txt")
    line="$line $ip[${st:-sette yok}]"
  done
  echo "  A     :${line:- (yok)}"
  if [ -n "$AAAA" ]; then
    echo "  AAAA  : $(echo $AAAA | cut -c1-90)  ← IPv6 adresi VAR"
    [ -n "$rule" ] && flag "V6RULED $d"
  else
    echo "  AAAA  : (yok)"
  fi
  grep -q ipv6hint <<<"$HT" && echo "  HTTPS : ipv6hint VAR (tarayıcı IPv6 ipucunu da kullanabilir)"
done

h "3) İstemcinin DNS sorguları (son 60 dk)"
Q=(pihole-FTL sqlite3 -readonly -cmd '.timeout 5000' "$FTLDB")
command -v pihole-FTL >/dev/null || Q=(sqlite3 -readonly -cmd '.timeout 5000' "$FTLDB")
T="CASE type WHEN 1 THEN 'A' WHEN 2 THEN 'AAAA' WHEN 15 THEN 'SVCB' WHEN 16 THEN 'HTTPS' ELSE 'tür'||type END"
R="CASE reply_type WHEN 0 THEN '-' WHEN 1 THEN 'NODATA' WHEN 2 THEN 'NXDOMAIN' WHEN 3 THEN 'CNAME' WHEN 4 THEN 'IP' ELSE 'r'||reply_type END"
SINCE="strftime('%s','now') - 3600"
"${Q[@]}" "SELECT 'Toplam: A=' || IFNULL(SUM(type=1),0) || '  AAAA=' || IFNULL(SUM(type=2),0) || ' (adresli cevap ' || IFNULL(SUM(type=2 AND reply_type IN (3,4)),0) || ')  HTTPS=' || IFNULL(SUM(type=16),0) FROM queries WHERE client='$CLIENT' AND timestamp > $SINCE;"
echo "(iPhone AAAA sorgusunu ancak kendisinde IPv6 bağlantısı varsa gönderir.)"
COND=""
for d in "${DOMAINS[@]}"; do COND="$COND OR domain='$d' OR domain LIKE '%.$d'"; done
if [ -n "$COND" ]; then
  echo "saat | alan adı | tür | cevap | adet"
  "${Q[@]}" -separator ' | ' "SELECT strftime('%H:%M:%S', MAX(timestamp), 'unixepoch', 'localtime'), domain, $T, $R, COUNT(*) FROM queries WHERE client='$CLIENT' AND timestamp > $SINCE AND (0 $COND) GROUP BY domain, type, reply_type ORDER BY MAX(timestamp) DESC LIMIT 40;"
fi

h "4) İstemcinin Pi üzerinden geçen bağlantıları"
# Kernel bağlantı tablosunu netlink ile okur (conntrack aracı gerekmez); yalnız okuma.
python3 - "$CLIENT" "$SELF" "$WGADDR" "$TMP/ipmap.txt" "$TMP/set.txt" > "$TMP/ct.txt" 2>&1 <<'PY'
import socket, struct, sys
from collections import Counter
client, self_ips = sys.argv[1], set(filter(None, sys.argv[2].split(',')))
wg_ips = set(filter(None, sys.argv[3].split(',')))
ipmap = {}  # ip -> (alan adı, kurallı mı); paylaşılan adreste (CDN) kurallı ad öncelikli
for line in open(sys.argv[4]):
    p = line.split()
    if len(p) >= 2 and (p[0] not in ipmap or (len(p) > 2 and not ipmap[p[0]][1])):
        ipmap[p[0]] = (p[1], len(p) > 2)
inset = {l.split()[0] for l in open(sys.argv[5]) if l.strip()}  # tünel setlerindeki adresler
def attrs(b):
    out, i = {}, 0
    while i + 4 <= len(b):
        ln, ty = struct.unpack_from('=HH', b, i)
        if ln < 4:
            break
        out[ty & 0x7fff] = b[i + 4:i + ln]
        i += (ln + 3) & ~3
    return out
def tup(b):
    a = attrs(b); ip = attrs(a.get(1, b'')); pr = attrs(a.get(2, b''))
    v4 = lambda k: socket.inet_ntoa(ip[k]) if len(ip.get(k, b'')) == 4 else '?'
    port = lambda k: struct.unpack('!H', pr[k])[0] if len(pr.get(k, b'')) == 2 else 0
    return v4(1), v4(2), (pr.get(1) or b'\0')[0], port(3)
try:
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)  # NETLINK_NETFILTER
    s.bind((0, 0))
    body = struct.pack('BBH', socket.AF_INET, 0, 0)
    s.sendall(struct.pack('=IHHII', 16 + len(body), (1 << 8) | 1, 0x301, 1, 0) + body)  # CTNETLINK GET, DUMP
except OSError as e:
    print(f'bağlantı tablosu okunamadı: {e}'); sys.exit()
flows, done = [], False
while not done:
    data = s.recv(1 << 20)
    if not data:
        break
    i = 0
    while i + 16 <= len(data):
        ln, ty = struct.unpack_from('=IH', data, i)
        if ln < 16 or ty == 3:  # NLMSG_DONE
            done = True; break
        if ty == 2:  # NLMSG_ERROR
            err = struct.unpack_from('=i', data, i + 16)[0]
            if err:
                print(f'bağlantı tablosu okunamadı: hata {-err}'); done = True; break
        else:
            a = attrs(data[i + 20:i + ln])
            if 1 in a:
                mark = struct.unpack('!I', a[8])[0] if len(a.get(8, b'')) == 4 else 0
                flows.append((tup(a[1]), tup(a[2]) if 2 in a else ('?', '?', 0, 0), mark))
        i += (ln + 3) & ~3
PROTO = {6: 'tcp', 17: 'udp', 1: 'icmp'}
direct = fwd = tun = 0
matched, others, miss = [], Counter(), 0
for (osrc, odst, proto, dport), (_, rdst, _, _), mark in flows:
    if osrc != client:
        continue
    if odst in self_ips:
        direct += 1; continue
    fwd += 1
    path = 'TÜNEL' if rdst in wg_ips else 'MODEM' if rdst in self_ips else 'NAT yok'
    tun += path == 'TÜNEL'
    if odst in ipmap or odst in inset:
        dom, ruled = ipmap.get(odst, ('?', False))
        leak = (ruled or odst in inset) and path != 'TÜNEL'
        miss += leak
        tag = ' [tünel setinde]' if odst in inset else ''
        matched.append(f"  {PROTO.get(proto, proto)} {odst}:{dport}  {dom}{tag}  → {path} (işaret {mark}){'   ← KAÇAK' if leak else ''}")
    else:
        others[(odst, dport, path)] += 1
print(f"Pi'ye doğrudan (DNS vb.): {direct} bağlantı")
print(f"Pi üzerinden yönlendirilen: {fwd} bağlantı — tünelden {tun}, modemden {fwd - tun}")
if matched:
    print('Denetlenen alan adlarına / tünel setindeki adreslere giden bağlantılar:')
    print('\n'.join(sorted(set(matched))[:30]))
if others:
    print('Diğer hedefler (en çok 12):')
    for (dst, port, path), n in others.most_common(12):
        print(f'  {dst}:{port}  {n} bağlantı → {path}')
print(f'@@FWD={fwd}'); print(f'@@MISS={miss}')
PY
grep -v '^@@' "$TMP/ct.txt"
FWD=$(sed -n 's/^@@FWD=//p' "$TMP/ct.txt"); MISS=$(sed -n 's/^@@MISS=//p' "$TMP/ct.txt")
[ "${FWD:-1}" = 0 ] && flag NOFWD
[ "${MISS:-0}" -gt 0 ] 2>/dev/null && flag "MISS $MISS"

h "5) Yönlendirme zinciri ve sayaçlar"
echo "Pi açılışı: $(uptime -s 2>/dev/null) | panel başlangıcı: $(systemctl show -p ActiveEnterTimestamp --value pi5-backend 2>/dev/null)"
echo "(işaret sayaçları her routing uygulamasında — panel başlangıcı dahil — sıfırlanır)"
awk '/^Ip:/ { if (!n) { for (i = 1; i <= NF; i++) k[i] = $i; n = 1; next } for (i = 1; i <= NF; i++) if (k[i] == "ForwDatagrams") print "Pi üzerinden yönlendirilen paket (açılıştan beri):", $i }' /proc/net/snmp
echo "PREROUTING → PI5_ROUTING: $(iptables -t mangle -S PREROUTING 2>/dev/null | grep -c -- '-j PI5_ROUTING') bağlantı"
iptables -t mangle -L PI5_ROUTING -v -n -x 2>/dev/null | sed -n '3,10p'
ip rule show 2>/dev/null | grep fwmark | head -4
for i in $WG_IFS; do
  echo "$i rota: $(ip route show table all 2>/dev/null | grep -E "^default dev $i " | head -2 | paste -sd';' -)"
  wg show "$i" latest-handshakes 2>/dev/null | awk -v now="$(date +%s)" '{print "  el sıkışma yaşı:", ($2 > 0 ? now - $2 " sn" : "HİÇ")}'
  echo "  arayüz kurulduğundan beri: gönderilen $(( $(cat /sys/class/net/$i/statistics/tx_bytes) / 1024 )) KB, alınan $(( $(cat /sys/class/net/$i/statistics/rx_bytes) / 1024 )) KB"
done

if [ "$IZLE" -eq 0 ]; then
h "6) Çıkış IP'leri (sitelerin gördüğü adres)"
geo(){
  curl -4 -s --max-time 8 "$@" https://ipinfo.io/json | python3 -c '
import json, sys
try: j = json.load(sys.stdin)
except Exception: print("(cevap yok)"); sys.exit()
print(j.get("ip", "?"), "|", j.get("city", "?"), j.get("country", "?"), "|", j.get("org", "?"))'
}
for i in $WG_IFS; do echo "Tünel $i : $(geo --interface "$i")"; done
isp=$(geo); ip0=${isp%% *}
echo "Normal hat: $(mask4 "$ip0")${isp#"$ip0"}"
fi

h "SONUÇ"
grep -q '^RA6' "$TMP/flags" && echo "• Modem IPv6 dağıtıyor. Telefon, IPv6 adresi olan sitelere Pi'yi atlayıp doğrudan modemden gider (tünel yalnız IPv4 taşır) — site yerel IPv6 adresinizi ve ülkenizi görür."
V6=$(sed -n 's/^V6RULED //p' "$TMP/flags" | paste -sd' ' -)
[ -n "$V6" ] && echo "• Yönlendirilen ama IPv6 adresi de olan alan adları: $V6"
grep -q '^NOFWD' "$TMP/flags" && echo "• $CLIENT'in Pi üzerinden geçen bağlantısı yok → cihaz Pi'yi ağ geçidi olarak kullanmıyor (Wi-Fi → Yönlendirici Pi'nin IP'si olmalı) ya da son dakikalarda trafik yok."
M=$(sed -n 's/^MISS //p' "$TMP/flags")
[ -n "$M" ] && echo "• Kurallı / tünel setindeki adreslere $M bağlantı tünel yerine modemden çıkmış → bağlantı adres sete girmeden kurulmuş (eski DNS cevabı ya da açık kalmış bağlantı: uçak modunu aç/kapa) ya da işaretleme çalışmıyor."
grep -q '^NOQUERY' "$TMP/flags" && echo "• İzleme süresinde cihazdan hiç DNS sorgusu gelmedi → sayfa açılmadı ya da cihaz DNS olarak Pi'yi kullanmıyor."
WR=0; grep -q '^WRULED' "$TMP/flags" && WR=1
WM=0; grep -q '^WMARK' "$TMP/flags" && WM=1
[ $WR = 1 ] && [ $WM = 0 ] && echo "• Kurallı alan adları soruldu ama tünele tek paket işaretlenmedi → cihaz bu adreslere Pi üzerinden bağlanmıyor ya da işaretleme çalışmıyor (4. ve 5. bölüm)."
[ $WM = 1 ] && echo "• İzleme süresinde trafik tünele yönlendi (işaret sayacı arttı) → Pi tarafında yönlendirme çalışıyor."
NR=$(sed -n 's/^NORULE //p' "$TMP/flags" | paste -sd' ' -)
[ -n "$NR" ] && echo "• Listede olmayan alan adları: $NR → normal hattan çıkar; gerekliyse Routing → Özel Domain'ler'e ekleyin."
grep -qE '^(RA6|V6RULED|NOFWD|MISS|NORULE|NOQUERY)' "$TMP/flags" || [ $WR = 1 -a $WM = 0 ] || echo "• Belirgin bir kaçak bulunmadı."
exit 0

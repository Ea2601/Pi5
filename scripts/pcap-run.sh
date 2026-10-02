#!/bin/bash
# Klyrix Gate — paket kaydı (Ağ Araçları → Paket Kaydı; backend/src/pcap.ts). Seçilen cihazın 10/30/60 sn trafiği .pcap
# (Wireshark) dosyasına yazılır. Backend bu betiği pi5-backend'in DIŞINDA, tekil geçici birimde başlatır (systemd-run
# --unit=pi5-pcap, RuntimeMaxSec=90, MemoryMax, Nice=10): panel servisi yeniden başlasa da (güncelleme, depolama işi)
# kayıt sürer ve dosya tamamlanır.
#   pcap-run.sh <arayüz> <ether|host> <adres> <saniye> <snaplen> <azami_bayt> <id>
#   pcap-run.sh --expire <id>   (10 dk silme zamanlayıcısı pi5-pcap-expire; panel servisi kapalıyken de çalışır)
# Argümanlar argv ile gelir (kabuk yorumlaması yok) ve burada YENİDEN doğrulanır. Süzgeç burada kurulur ve yalnız
# "ether host <MAC>" ya da "host <IPv4>" olabilir. -p: kart karışık kipe (promiscuous) alınmaz — kartın ve köprünün
# davranışı değişmez. tcpdump çıktısı stdout borusundan dosyaya gider (-w -), hata çıktısı da borudan (cat) dosyaya:
# Debian tcpdump'ının yetki düşürmesi (-Z tcpdump) ve AppArmor profili (/run/pi5-pcap'e izin vermez; exec anında izinsiz
# dosya tanımlayıcısını /dev/null'a çevirir) dosyalara karışmaz. head -c boyut tavanını uygular; tavana değildiyse yarım
# kalan son paket python3 ile kesilir (Wireshark "dosya yarıda kesilmiş" demesin).
# Sonuç: /run/pi5-pcap/<id>.rc (KEY=VALUE: rc, bytes, packets, dropped, capped, note, error); kayıt <id>.part → <id>.pcap.
# Dizin 0700, dosyalar 0600 (umask 077).
set -u
umask 077
export LC_ALL=C
DIR=/run/pi5-pcap

# Silme: durum dosyası hâlâ bu kaydı gösteriyorsa dizin tümüyle (durum dahil), göstermiyorsa (kayıt silinip yenisi
# başlamış) yalnız bu kaydın dosyaları silinir.
if [ "${1:-}" = --expire ]; then
  ID=${2:-}
  if ! [[ $ID =~ ^[0-9a-f]{32}$ ]]; then echo "pcap-run: geçersiz kayıt kimliği" >&2; exit 2; fi
  if grep -qx "id=$ID" "$DIR/state" 2>/dev/null; then rm -rf "$DIR"; else rm -f "$DIR/$ID".*; fi
  exit 0
fi

IF=${1:-}; KIND=${2:-}; ADDR=${3:-}; SECS=${4:-}; SNAP=${5:-}; MAX=${6:-}; ID=${7:-}

# Kimlik önce: sonuç dosyasının adı ona bağlı. Geçersizse hiçbir dosya yazılmaz.
if ! [[ $ID =~ ^[0-9a-f]{32}$ ]]; then echo "pcap-run: geçersiz kayıt kimliği" >&2; exit 2; fi
if ! { mkdir -p "$DIR" && chmod 700 "$DIR"; }; then echo "pcap-run: $DIR oluşturulamadı" >&2; exit 2; fi
RC_FILE=$DIR/$ID.rc
PART=$DIR/$ID.part
OUT=$DIR/$ID.pcap
ERR=$DIR/$ID.err

# finish <rc> <hata> [bayt] [paket] [düşen] [tavan] [not] — sonuç dosyası atomik yazılır (backend yarım dosya okumasın).
finish() {
  printf 'rc=%s\nbytes=%s\npackets=%s\ndropped=%s\ncapped=%s\nnote=%s\nerror=%s\n' \
    "$1" "${3:-0}" "${4:-}" "${5:-}" "${6:-0}" "${7:-}" "$2" > "$RC_FILE.tmp" && mv -f "$RC_FILE.tmp" "$RC_FILE"
  exit "$1"
}
fail() { rm -f "$PART" "$OUT"; finish 1 "$1"; }

# Doğrulama — hata metnine kullanıcı girdisi konmaz (sonuç dosyası satır tabanlı).
[[ $IF =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}$ ]] || fail "geçersiz arayüz adı"
[ -e "/sys/class/net/$IF" ] || fail "arayüz $IF bulunamadı"
IPV4_RE='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
case $KIND in
  ether) [[ $ADDR =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] || fail "geçersiz MAC adresi"; FILTER="ether host $ADDR" ;;
  host) [[ $ADDR =~ $IPV4_RE ]] || fail "geçersiz IPv4 adresi"; FILTER="host $ADDR" ;;
  *) fail "geçersiz süzgeç türü" ;;
esac
case $SECS in 10|30|60) ;; *) fail "geçersiz süre" ;; esac
case $SNAP in 128|0) ;; *) fail "geçersiz paket kesme boyu" ;; esac
{ [[ $MAX =~ ^[1-9][0-9]{0,8}$ ]] && [ "$MAX" -le 104857600 ]; } || fail "geçersiz boyut tavanı"
command -v tcpdump >/dev/null 2>&1 || fail "tcpdump kurulu değil — panel güncellemesi kurar"

rm -f "$PART" "$OUT" "$RC_FILE" "$ERR"
# head çıktısı stdio tamponludur (8 KB dolmadan dosyada görünmez): stdbuf -o0 ile her okuma hemen yazılır — panel kaydın
# büyüklüğünü sürerken gösterir. stdbuf yoksa (coreutils'te hep vardır) düz head.
HEAD=(head -c "$MAX")
if command -v stdbuf >/dev/null 2>&1; then HEAD=(stdbuf -o0 head -c "$MAX"); fi
# timeout süre dolunca tcpdump'a SIGINT gönderir: tcpdump son paketi yazıp sayaçları basar ve temiz çıkar (çıkış 124).
# Hata çıktısı borudan: cat dosyayı tcpdump'ın profili dışında yazar (açamazsa okuyup atar — tcpdump SIGPIPE almasın).
exec 3> >(cat > "$ERR" || cat > /dev/null)
ERR_PID=$!
timeout -s INT "$SECS" tcpdump -i "$IF" -p -n -U -s "$SNAP" -w - "$FILTER" 2>&3 3>&- | "${HEAD[@]}" 3>&- > "$PART"
st=("${PIPESTATUS[@]}")
tstat=${st[0]}; hstat=${st[1]}
exec 3>&-
wait "$ERR_PID" 2>/dev/null || true

bytes=$(stat -c %s "$PART" 2>/dev/null || echo 0)
capped=0
[ "$bytes" -ge "$MAX" ] && capped=1
packets=$(sed -n 's/^\([0-9][0-9]*\) packets* captured$/\1/p' "$ERR" 2>/dev/null | head -n 1)
dropped=$(sed -n 's/^\([0-9][0-9]*\) packets* dropped by kernel$/\1/p' "$ERR" 2>/dev/null | head -n 1)
# tcpdump'ın kendi hata satırı (bilgi satırları ayıklanır), tek satır ve kısa.
errmsg=$(grep -v -e 'listening on' -e 'packets* captured' -e 'received by filter' -e 'dropped by kernel' \
  -e 'verbose output suppressed' "$ERR" 2>/dev/null | head -n 2 | tr -d '\r' | tr '\n' ' ' | cut -c1-300)
rm -f "$ERR"

# pcap genel başlığı 24 bayttır: daha azı tcpdump'ın hiç başlamadığı anlamına gelir.
if [ "$bytes" -lt 24 ]; then fail "tcpdump başlatılamadı${errmsg:+: $errmsg}"; fi
[ "$hstat" = 0 ] || fail "kayıt dosyası yazılamadı (RAM diski dolu olabilir)"

note=''
if [ "$capped" = 1 ]; then
  note="boyut tavanına ulaşıldı — kayıt erken bitti"
  # Yarım kalan son paketi kes; bütün paketleri say. python3 yoksa dosya olduğu gibi kalır (Wireshark yine açar).
  if command -v python3 >/dev/null 2>&1; then
    n=$(python3 - "$PART" <<'PY' 2>/dev/null
import os, struct, sys
p = sys.argv[1]
size = os.path.getsize(p)
with open(p, 'r+b') as f:
    h = f.read(24)
    if h[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1'):
        e = '<'
    elif h[:4] in (b'\xa1\xb2\xc3\xd4', b'\xa1\xb2\x3c\x4d'):
        e = '>'
    else:
        sys.exit(1)
    off, n = 24, 0
    while True:
        f.seek(off)
        r = f.read(16)
        if len(r) < 16:
            break
        incl = struct.unpack(e + 'I', r[8:12])[0]
        if off + 16 + incl > size:
            break
        off += 16 + incl
        n += 1
    f.truncate(off)
print(n)
PY
)
    if [[ $n =~ ^[0-9]+$ ]]; then packets=$n; bytes=$(stat -c %s "$PART" 2>/dev/null || echo "$bytes"); fi
  fi
elif [ "$tstat" != 0 ] && [ "$tstat" != 124 ]; then
  # Süre dolmadan bitti (ör. arayüz kapandı): o ana kadarki kayıt korunur, neden not edilir.
  note="kayıt erken bitti${errmsg:+: $errmsg}"
fi

mv -f "$PART" "$OUT" || fail "kayıt dosyası taşınamadı"
finish 0 '' "$bytes" "$packets" "$dropped" "$capped" "$note"

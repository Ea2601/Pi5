#!/usr/bin/env bash
# Klyrix Gate — Zapret blockcheck'ini arka planda çalıştırır (systemd-run ile ayrık birim pi5-blockcheck).
#   zapret-blockcheck.sh <alan_adı> [günlük_dosyası] [manual|auto]
# Hangi DPI atlatma stratejisinin bu hatta çalıştığını dener; çıktı günlük dosyasına yazılır (panel izler ve "* SUMMARY"
# bölümünden çalışan stratejiyi okur — zapret.ts). auto: panelin otomatik yöntem öğrenmesi (yalnız HTTPS, daha kısa).
# Zapret DURDURULMAZ (v2.24.82): blockcheck kendi nfqws'ini ayrı kuyrukta ve yalnız sitenin adreslerine çalıştırır; ana
# Zapret'in sonucu karıştırmaması için o adresler test süresince Zapret'in muafiyet setine (inet zapret nozapret) eklenir
# ve test bitince (yarıda kesilse de) çıkarılır. Eskiden Zapret dakikalarca durduruluyor, diğer DPI'lı siteler açılmıyordu.
# Hızlı tarama (SCANLEVEL=quick), yalnız IPv4, HTTPS/TLS1.2 (+ manual'da HTTP).
set -u
domain=${1:-}
log=${2:-/opt/pi5-gateway/core/blockcheck.log}
mode=${3:-manual}
if ! [[ $domain =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
  echo "geçersiz alan adı: $domain" > "$log"
  exit 2
fi
[ -f /opt/zapret/blockcheck.sh ] || { echo "Zapret kurulu değil (/opt/zapret/blockcheck.sh yok)" > "$log"; exit 3; }

exec > "$log" 2>&1
added=()
restore() {
  local ip
  for ip in "${added[@]}"; do nft delete element inet zapret nozapret "{ $ip }" 2>/dev/null; done
  [ ${#added[@]} -gt 0 ] && echo "Zapret muafiyeti kaldırıldı (${added[*]})"
  added=()
}
trap restore EXIT
trap 'echo "test durduruldu"; exit 143' TERM INT

echo "== blockcheck ($mode): $domain — $(date '+%Y-%m-%d %H:%M:%S')"
# blockcheck ad çözümü için nslookup ya da host ister; yoksa "please install" deyip hemen çıkar (zapret-install.sh de kurar).
if ! command -v nslookup >/dev/null 2>&1 && ! command -v host >/dev/null 2>&1; then
  echo "host / nslookup yok — bind9-host kuruluyor"
  bash "${PI5_BASE:-/opt/pi5-gateway}/scripts/pkg-ensure.sh" bind9-host
fi
if nft list set inet zapret nozapret >/dev/null 2>&1; then
  for ip in $(getent ahostsv4 "$domain" | awk '{print $1}' | sort -u); do
    nft get element inet zapret nozapret "{ $ip }" >/dev/null 2>&1 && continue # zaten muaf
    nft add element inet zapret nozapret "{ $ip }" 2>/dev/null && added+=("$ip")
  done
  echo "Zapret çalışıyor: test süresince bu adresler ana Zapret'ten muaf: ${added[*]:-—}"
fi
http=1; [ "$mode" = auto ] && http=0
cd /opt/zapret || exit 3
BATCH=1 DOMAINS="$domain" IPVS=4 ENABLE_HTTP=$http ENABLE_HTTPS_TLS12=1 ENABLE_HTTPS_TLS13=0 ENABLE_HTTP3=0 \
  SCANLEVEL=quick SKIP_TPWS=1 /bin/sh ./blockcheck.sh
rc=$?
restore
echo "== bitti (çıkış kodu $rc) — $(date '+%Y-%m-%d %H:%M:%S')"

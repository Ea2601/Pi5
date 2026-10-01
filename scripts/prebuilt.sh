#!/bin/bash
# Klyrix Gate — hazır paket: GitHub Actions'ın (.github/workflows/prebuilt.yml) her master commit'i için derlediği
# backend/dist + frontend/dist. Az bellekli cihaz tsc / vite çalıştırmaz (frontend tsc -b ~410 MB, vite build ~390 MB
# ister; 256 MB'ta bellek yetmeyip düşer). Paket commit'e bağlıdır: scripts/, post-update.sh ve version.json yine git'ten
# gelir, paket yalnız aynı commit'in derlemesidir. update.sh ve install.sh çağırır; panel (update.ts) yalnız mode'u okur.
#   prebuilt.sh mode               KEY=VALUE: mode (ayar), effective (local|prebuilt), auto (otomatikte ne olurdu),
#                                  mem_class, local_ok (hazır paket alınamazsa Pi'de derlenebilir mi)
#   prebuilt.sh fetch <sha> <dizin>
#                                  <sha> commit'inin paketini indirir, doğrular ve <dizin>/backend/dist.next +
#                                  <dizin>/frontend/dist.next olarak koyar (canlı dist'e dokunmaz; takas update.sh'de).
#                                  Çıktı: result=ok + tag (0) | result=missing + tag (3: paket yok) | result=error + reason (1)
# Ayar: /etc/pi5-gateway/build-mode ("mode=auto|local|prebuilt", role dosyasıyla aynı biçim; yoksa auto). KLYRIX_BUILD
# ortam değişkeni ayarı ezer (install.sh). auto: bellek sınıfı (scripts/platform.sh) 1 GB ve altıysa hazır paket, üstünde
# Pi'de derleme (canlı Pi 5 bugünkü gibi derler). Bellek okunamazsa (sınıf 0) platform.sh gibi kısıt yok: Pi'de derle.
# Cihazda GitHub REST API kullanılmaz (saatte 60 istek sınırı): /releases/download/<etiket>/<dosya> adresi sınırsızdır.
# İlerleme satırları stderr'e (PI5_PREBUILT_LOG verilirse o dosyaya da), sonuç stdout'a.
# Test kancaları: PI5_PREBUILT_BASE (https://github.com/<sahip>/<depo> yerine), PI5_PLATFORM_ROOT (platform.sh ile aynı kök).
set -u
export LC_ALL=C
R=${PI5_PLATFORM_ROOT:-}
R=${R%/}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAX_GZ=52428800    # indirilen paket en çok 50 MB
MAX_RAW=157286400  # açılmış içerik en çok 150 MB
MIN_FREE_KB=51200  # dizinin dosya sisteminde en az 50 MB boş yer
STAGE=""

mode() {
  local conf plat mem_class auto effective local_ok
  conf=$(sed -n 's/^mode=\([a-z]*\)[[:space:]]*$/\1/p' "$R/etc/pi5-gateway/build-mode" 2>/dev/null | head -1)
  case "$conf" in auto|local|prebuilt) ;; *) conf=auto ;; esac
  case "${KLYRIX_BUILD:-}" in auto|local|prebuilt) conf=$KLYRIX_BUILD ;; esac
  plat=$(bash "$HERE/platform.sh" detect 2>/dev/null) || plat=""
  mem_class=$(printf '%s\n' "$plat" | sed -n 's/^mem_class=//p' | head -1)
  case "$mem_class" in ''|*[!0-9]*) mem_class=0 ;; esac
  # Bellek sınıfları platform.sh'den (512, 1024, 2048 …): 1 GB sınıfı ve altında derleme (~410 MB tepe) DNS / Pi-hole /
  # backend ile birlikte sığmaz; 2 GB sınıfı ve üstünde yedek yol olarak Pi'de derlenebilir.
  auto=local; local_ok=1
  if [ "$mem_class" -gt 0 ] && [ "$mem_class" -le 1024 ]; then auto=prebuilt; local_ok=0; fi
  case "$conf" in auto) effective=$auto ;; *) effective=$conf ;; esac
  printf '%s\n' "mode=$conf" "effective=$effective" "auto=$auto" "mem_class=$mem_class" "local_ok=$local_ok"
}

say() {
  local l
  l="$(date '+%H:%M:%S') $*"
  printf '%s\n' "$l" >&2
  if [ -n "${PI5_PREBUILT_LOG:-}" ]; then { printf '%s\n' "$l" >> "$PI5_PREBUILT_LOG"; } 2>/dev/null || true; fi
}
fail() { say "Hazır paket: $1"; printf 'result=error\nreason=%s\n' "$1"; exit 1; }

# url dosya en_çok_bayt → HTTP kodu stdout'ta; dönüş curl'ün çıkış kodu. Yalnız https (yönlendirmeler dahil: GitHub
# indirmeyi release-assets.githubusercontent.com'a yönlendirir). 404'te yeniden denemez (curl yalnız geçici hatada dener).
# Süre sınırı dosya başına: --max-time her denemeye ayrı uygulanır ve zaman aşımı da yeniden denenir; --retry-max-time
# 300 sn'den sonra yeni deneme başlatmaz, 60 sn boyunca 1 kB/sn'nin altı (takılan / damlayan bağlantı) denemeyi keser.
dl() {
  curl -fsSL --proto =https --proto-redir =https --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 300 \
    --retry-max-time 300 --speed-limit 1024 --speed-time 60 \
    --max-filesize "$3" -o "$2" -w '%{http_code}' "$1" 2>>"$STAGE/curl.err"
}

fetch() {
  local sha=${1:-} base=${2:-} url origin slug build sha7 tag asset free code rc ct now waited=0 want sum size raw list vlist n bad mc bid
  case "$sha" in ''|*[!0-9a-f]*) fail "geçersiz commit: ${sha:-boş}" ;; esac
  [ "${#sha}" = 40 ] || fail "geçersiz commit: $sha"
  [ -n "$base" ] && [ -d "$base/backend" ] && [ -d "$base/frontend" ] || fail "kurulum dizini yok: ${base:-boş}"
  base=$(cd "$base" && pwd)
  # Paketler deponun kendi sürümlerinde: çatal (fork) kendi derlemesini kullanır. Yalnız https://github.com/<sahip>/<depo>.
  if [ -n "${PI5_PREBUILT_BASE:-}" ]; then
    url=${PI5_PREBUILT_BASE%/}
  else
    origin=$(git -c safe.directory="$base" -C "$base" remote get-url origin 2>/dev/null) || origin=""
    [[ $origin =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "depo adresi GitHub değil: ${origin:-yok}"
    slug=${origin#https://github.com/}
    slug=${slug%.git}
    case "/$slug/" in */./*|*/../*|*//*) fail "depo adresi geçersiz: $origin" ;; esac
    url="https://github.com/$slug"
  fi
  build=$(sed -n 's/^[[:space:]]*"build"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$base/version.json" 2>/dev/null | head -1)
  [ -n "$build" ] || fail "version.json'da build numarası yok"
  sha7=${sha:0:7}
  tag="b$build-$sha7"
  asset="klyrix-dist-$sha7.tar.gz"
  url="$url/releases/download/$tag"

  free=$(df -Pk "$base" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$free" in ''|*[!0-9]*) fail "boş yer okunamadı (df $base)" ;; esac
  [ "$free" -ge "$MIN_FREE_KB" ] || fail "diskte yer yok ($((free / 1024)) MB boş, en az $((MIN_FREE_KB / 1024)) MB gerekir)"

  # Geçici klasör aynı dosya sisteminde (dist.next'e taşıma tek rename); her çıkışta silinir. Öldürülmüş (SIGKILL) eski
  # bir çalıştırmanın kalıntısı 1 saatten eskiyse silinir (süren başka bir indirmeninkine dokunulmaz).
  find "$base" -maxdepth 1 -type d -name '.prebuilt.*' -mmin +60 -exec rm -rf {} + 2>/dev/null
  STAGE=$(mktemp -d "$base/.prebuilt.XXXXXX" 2>/dev/null) || { STAGE=""; fail "geçici klasör açılamadı ($base)"; }
  trap 'rm -rf "$STAGE"' EXIT
  say "Hazır paket: $tag indiriliyor"

  # 404 = paket henüz yok. Commit 45 dk'dan yeniyse GitHub derlemesi sürüyordur: 20 sn arayla en çok 10 dk beklenir
  # (güncelleme işinin 30 dk sınırı içinde). Eski commit'te beklenmez (derleme düşmüş ya da Actions kapalı).
  ct=$(git -c safe.directory="$base" -C "$base" log -1 --format=%ct "$sha" 2>/dev/null) || ct=""
  case "$ct" in ''|*[!0-9]*) ct=0 ;; esac
  while :; do
    rm -f "$STAGE/SHA256SUMS" "$STAGE/$asset"
    rc=0; code=$(dl "$url/SHA256SUMS" "$STAGE/SHA256SUMS" 1048576) || rc=$?
    if [ "$rc" = 0 ]; then
      rc=0; code=$(dl "$url/$asset" "$STAGE/$asset" "$MAX_GZ") || rc=$?
      [ "$rc" = 0 ] && break
    fi
    [ "$rc" = 63 ] && fail "paket $((MAX_GZ / 1048576)) MB sınırını aşıyor"
    [ "$code" = 404 ] || fail "indirilemedi (HTTP ${code:-000}, curl $rc: $(tail -1 "$STAGE/curl.err" 2>/dev/null))"
    now=$(date +%s)
    if [ "$ct" -gt 0 ] && [ $((now - ct)) -lt 2700 ] && [ "$waited" -lt 600 ]; then
      [ "$waited" = 0 ] && say "Hazır paket bekleniyor (GitHub derlemesi sürüyor) — $tag, en çok 10 dk"
      sleep 20
      waited=$((waited + 20))
      continue
    fi
    say "Hazır paket bulunamadı: $tag (GitHub derlemesi bitmemiş, düşmüş ya da Actions kapalı)"
    printf 'result=missing\ntag=%s\n' "$tag"
    exit 3
  done
  [ "$waited" = 0 ] || say "Hazır paket yayımlandı — indirildi ($tag)"

  # Bütünlük: SHA256SUMS'taki özet (yarım / bozuk indirme burada düşer). Boyut sınırları: sıkıştırılmış ve açılmış.
  want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$STAGE/SHA256SUMS")
  [[ $want =~ ^[0-9a-f]{64}$ ]] || fail "SHA256SUMS'ta $asset yok"
  sum=$(sha256sum "$STAGE/$asset" 2>/dev/null | cut -d' ' -f1)
  [ "$sum" = "$want" ] || fail "SHA256 tutmuyor (indirme bozuk ya da yarım)"
  size=$(stat -c %s "$STAGE/$asset" 2>/dev/null || echo 0)
  [ "$size" -le "$MAX_GZ" ] || fail "paket $((MAX_GZ / 1048576)) MB sınırını aşıyor"
  raw=$( { gzip -dc "$STAGE/$asset" 2>/dev/null || true; } | head -c $((MAX_RAW + 1)) | wc -c)
  [ "$raw" -le "$MAX_RAW" ] || fail "açılmış paket $((MAX_RAW / 1048576)) MB sınırını aşıyor"

  # Tar güvenliği: yalnız manifest.json ve backend/dist, frontend/dist altı; '.' / '..' parçası yok; yalnız düz dosya ve
  # klasör (sembolik / sert bağlantı, aygıt yok). Açarken sahiplik ve izinler paketten alınmaz. Ayrıntılı liste sayısal
  # sahiple (--numeric-owner): sahip adı boşluk içerirse boyut başka sütuna kayar, toplam 0 sayılıp sınır aşılırdı.
  list=$(tar -tzf "$STAGE/$asset" 2>/dev/null) || fail "paket okunamadı (tar)"
  vlist=$(tar --numeric-owner -tvzf "$STAGE/$asset" 2>/dev/null) || fail "paket okunamadı (tar)"
  n=$(printf '%s\n' "$list" | grep -c .)
  [ "$n" -gt 0 ] && [ "$n" = "$(printf '%s\n' "$vlist" | grep -c .)" ] || fail "paket listesi okunamadı"
  bad=$(printf '%s\n' "$list" | grep -vE '^(manifest\.json|(backend|frontend)/dist(/[A-Za-z0-9._@+-]+)*/?)$' | head -1)
  [ -z "$bad" ] || fail "pakette izin verilmeyen yol: $bad"
  bad=$(printf '%s\n' "$list" | grep -E '(^|/)\.\.?(/|$)' | head -1)
  [ -z "$bad" ] || fail "pakette '.' / '..' içeren yol: $bad"
  bad=$(printf '%s\n' "$vlist" | grep -v '^[-d]' | head -1)
  [ -z "$bad" ] || fail "pakette düz dosya / klasör dışında üye (bağlantı ya da aygıt): $bad"
  # Üyelerin (seyrek / sparse olanlar dahil) mantıksal boyut toplamı; sayı olmayan boyut sütunu sınırı aşmış sayılır.
  n=$(printf '%s\n' "$vlist" | awk '$3 !~ /^[0-9]+$/ { bad = 1 } { s += $3 } END { if (bad) print 999999999999; else printf "%d", s }')
  [ "$n" -le "$MAX_RAW" ] || fail "açılmış paket $((MAX_RAW / 1048576)) MB sınırını aşıyor"
  mkdir "$STAGE/x" || fail "geçici klasör yazılamadı"
  tar -xzf "$STAGE/$asset" -C "$STAGE/x" --no-same-owner --no-same-permissions 2>"$STAGE/tar.err" \
    || fail "paket açılamadı: $(tail -1 "$STAGE/tar.err" 2>/dev/null)"

  # İçerik: paket bu commit'in (manifest) ve arayüz kimliği bu commit'in ilk 7 hanesi (build.json, vite.config.ts).
  mc=$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$STAGE/x/manifest.json" 2>/dev/null | head -1)
  [ "$mc" = "$sha" ] || fail "paket başka bir commit'in (manifest: ${mc:-yok}, beklenen: $sha)"
  [ -f "$STAGE/x/backend/dist/index.js" ] || fail "pakette backend/dist/index.js yok"
  for f in index.html kiosk.html build.json; do
    [ -f "$STAGE/x/frontend/dist/$f" ] || fail "pakette frontend/dist/$f yok"
  done
  bid=$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STAGE/x/frontend/dist/build.json" 2>/dev/null | head -1)
  [ "$bid" = "$sha7" ] || fail "arayüz kimliği tutmuyor (build.json: ${bid:-yok}, beklenen: $sha7)"

  rm -rf "$base/backend/dist.next" "$base/frontend/dist.next"
  if ! { mv "$STAGE/x/backend/dist" "$base/backend/dist.next" && mv "$STAGE/x/frontend/dist" "$base/frontend/dist.next"; }; then
    rm -rf "$base/backend/dist.next" "$base/frontend/dist.next"
    fail "paket dist.next'e taşınamadı"
  fi
  say "Hazır paket doğrulandı: $tag ($((size / 1024)) kB, sha256 ${sum:0:12}…)"
  printf 'result=ok\ntag=%s\n' "$tag"
}

case "${1:-}" in
  mode) mode; exit 0 ;;
  fetch) fetch "${2:-}" "${3:-}"; exit 0 ;;
  *) echo "Kullanım: prebuilt.sh mode | fetch <commit-sha> <kurulum-dizini>" >&2; exit 2 ;;
esac

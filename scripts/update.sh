#!/bin/bash
# System update script — called by backend update endpoint
# Handles all permission issues automatically
set -e
set -o pipefail  # `npm run build | tail` gibi pipeline'larda build hatası maskelenmesin

BASE="/opt/pi5-gateway"
LOGFILE="$BASE/core/update.log"
# systemd servisinden (pi5-backend, User= yok) çağrılınca HOME tanımsız: git ~/.gitconfig'teki safe.directory'yi göremiyor
# ("dubious ownership" → her güncellemede sudo yedeğine düşüp "Git OK: unknown" yazıyordu). Betik root olarak koşar.
export HOME="${HOME:-/root}"

# Log yazılamazsa (core salt-okunur vb.) set -e ile scripti öldürme
log() { echo "$(date '+%H:%M:%S') $1" | tee -a "$LOGFILE" 2>/dev/null || echo "$(date '+%H:%M:%S') $1"; }

# Düşülen adımı backend'e bildiren tek satırlık işaret (set -e / pipefail davranışı ve çıkış kodu aynen kalır).
STEP=hazirlik
trap 'rc=$?; log "@@STEP_FAILED=$STEP rc=$rc"' ERR

# Tek güncelleme: panel (update-job.sh), gece güncellemesi ve elle çalıştırma aynı anda koşmasın (ikisi aynı depoyu
# sıfırlayıp aynı klasörleri derlerdi). Kilit bu süreç bitince kendiliğinden bırakılır. 2>/dev/null yalnız grubun içinde:
# `exec 8>… 2>/dev/null` stderr'i betiğin sonuna kadar kapatırdı (derleme / geçiş hataları görünmezdi).
if { exec 8>/run/lock/pi5-update.lock; } 2>/dev/null && ! flock -n 8; then
  log "Başka bir güncelleme sürüyor — bu çalıştırma atlandı"
  exit 75
fi
# Bellek darlığında çekirdek önce güncellemeyi öldürsün, DNS'i (pihole-FTL, Unbound) değil: git, npm, tsc ve vite bu
# değeri devralır (servisler systemd'den başladığı için devralmaz). Düşen derleme aşağıda geri alınır. Yazılamazsa önemsiz.
{ echo 500 > /proc/self/oom_score_adj; } 2>/dev/null || true

log "=== Güncelleme başlatıldı ==="
log "Kullanıcı: $(whoami), UID: $(id -u)"

# Fix ALL permission issues upfront
# Make entire repo writable by current user (777 yerine u+rwX — dünya-yazılabilir yapma)
chmod -R u+rwX "$BASE" 2>/dev/null || sudo chmod -R u+rwX "$BASE" 2>/dev/null || true

# Depo için sistem geneli safe.directory (/etc/gitconfig — HOME'dan bağımsız okunur). İdempotent: eski --add satırı
# her güncellemede ~/.gitconfig'e yeni bir kopya ekliyordu. grep -q değil: pipefail altında git SIGPIPE almasın.
git config --system --get-all safe.directory 2>/dev/null | grep -xF "$BASE" >/dev/null \
  || git config --system --add safe.directory "$BASE" 2>/dev/null \
  || sudo git config --system --add safe.directory "$BASE" 2>/dev/null || true

# Git fetch + reset
STEP=git
cd "$BASE"
# Derleme başarısız olursa kaynak bu commit'e döner: çalışan panelin derlemesi (dist) hiç değişmediği için kaynak,
# betikler ve sürüm numarası da onunla aynı kalır (eskiden yeni kaynak + bozuk / yarım derleme bir sonraki yeniden
# başlatmada canlıya geçiyordu).
PREV=$(git rev-parse HEAD 2>/dev/null || sudo git rev-parse HEAD 2>/dev/null || echo "")
log "Git fetch..."
GIT_TERMINAL_PROMPT=0 git fetch origin master 2>&1 || {
  log "Normal fetch başarısız, sudo ile deneniyor..."
  sudo git fetch origin master 2>&1
}
log "Git reset..."
git reset --hard origin/master 2>&1 || sudo git reset --hard origin/master 2>&1
log "Git OK: $(git rev-parse --short HEAD 2>/dev/null || sudo git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

# Derleme yöntemi (scripts/prebuilt.sh mode; ayar /etc/pi5-gateway/build-mode): local = Pi'de derle (bugünkü yol),
# prebuilt = GitHub'ın bu commit için derlediği hazır paket (1 GB sınıfı ve altında otomatik — tsc / vite orada sığmaz).
# Betik yoksa / okunamazsa Pi'de derlenir. LOCAL_OK: hazır paket alınamazsa Pi'de derlemeye düşülebilir mi (2 GB sınıfı+).
BUILD_MODE=local
LOCAL_OK=1
if [ -f "$BASE/scripts/prebuilt.sh" ]; then
  PB_MODE=$(bash "$BASE/scripts/prebuilt.sh" mode 2>/dev/null) || PB_MODE=""
  if [ "$(printf '%s\n' "$PB_MODE" | sed -n 's/^effective=//p' | head -1)" = prebuilt ]; then BUILD_MODE=prebuilt; fi
  if [ "$(printf '%s\n' "$PB_MODE" | sed -n 's/^local_ok=//p' | head -1)" = 0 ]; then LOCAL_OK=0; fi
fi
log "@@BUILD_MODE=$BUILD_MODE"

# Post-update iki parça: bağımlılıklar (npm; az bellekli cihazda zram) derlemeden önce, sistem değişiklikleri (servis birimleri, kiosk, ağ, cron …)
# ancak iki derleme de başarılıysa. Derleme düşünce kaynak geri alınır ve yeni sürümün sistem değişiklikleri hiç yapılmamış
# olur (eskiden derlemeden önce yapılıyordu: geri alınan kaynakta olmayan betiklere işaret eden birimler kalabilirdi).
# Başarısızlığı güncellemeyi durdurmaz; çıkış kodu işaretlenir. PI5_BUILD_MODE: hazır pakette yalnız backend'in üretim
# bağımlılıkları kurulur (frontend'de npm yok).
post_update() { # deps | system
  [ -f "$BASE/scripts/post-update.sh" ] || return 0
  PI5_BUILD_MODE="$BUILD_MODE" bash "$BASE/scripts/post-update.sh" "$1" 2>&1 || log "@@POSTUPDATE_RC=$?"
}
# Hazır pakette bağımlılıklar paket indirildikten SONRA: paket yoksa / alınamazsa yeni sürümün paketleri canlı
# node_modules'a hiç kurulmaz (geri almada yeniden kurmak da gerekmez — DEPS_RAN, build_failed).
DEPS_RAN=0
deps_sync() {
  STEP=postupdate
  log "Bağımlılıklar denetleniyor (npm)..."
  post_update deps
  DEPS_RAN=1
}
if [ "$BUILD_MODE" = local ]; then deps_sync; fi

# Derleme geçici klasörlere (dist.next): canlı dist'lere (çalışan backend, nginx'in sunduğu arayüz) derleme sırasında
# dokunulmaz — eskiden tsc hata verse de canlı dist'e yazıyordu, Vite de her derlemede nginx'in klasörünü boşaltıyordu.
# İkisi de başarılıysa yer değiştirir (eski sürüm dist.prev); biri düşerse hiçbir şey değişmez ve kaynak geri alınır.
# Derleme çıktısının tamamı update.log'a (eskiden yalnız son 3 satırı panele), son satırları panele.
build_step() { # dizin komut...
  local dir=$1 out rc=0
  shift
  out=$(cd "$dir" && "$@" 2>&1) || rc=$?
  { printf '%s\n' "$out" >> "$LOGFILE"; } 2>/dev/null || true
  printf '%s\n' "$out" | tail -5
  return "$rc"
}
build_failed() { # adım çıkış_kodu
  rm -rf "$BASE/backend/dist.next" "$BASE/frontend/dist.next" "$BASE"/.prebuilt.*
  if [ -n "$PREV" ] && [ "$(git -C "$BASE" rev-parse HEAD 2>/dev/null)" != "$PREV" ]; then
    if git -C "$BASE" reset --hard "$PREV" >/dev/null 2>&1 || sudo git -C "$BASE" reset --hard "$PREV" >/dev/null 2>&1; then
      log "Derleme başarısız — kaynak önceki sürüme ($(git -C "$BASE" rev-parse --short HEAD 2>/dev/null)) döndü; çalışan panel değişmedi"
      # yeni sürüm paketleri değiştirdiyse önceki sürümünkiler geri kurulur (git diff HEAD@{1}); bağımlılık adımı hiç
      # koşmadıysa (hazır paket alınamadı) node_modules zaten önceki sürümün
      if [ "$DEPS_RAN" = 1 ]; then post_update deps; fi
    else
      log "UYARI: derleme başarısız ve kaynak önceki sürüme döndürülemedi — çalışan panel değişmedi"
    fi
  fi
  log "@@STEP_FAILED=$1 rc=$2"
  exit "$2"
}
# dist.next → dist (eski dist → dist.prev). mv -T --exchange (coreutils ≥ 9.5, tek atomik işlem; -T şart: yoksa dist
# hedef klasör sayılır, dist/dist.next ile değiş tokuş denenip düşer); desteklenmezse iki ardışık mv.
swap_dist() {
  local d=$1
  rm -rf "$d/dist.prev"
  if [ ! -d "$d/dist" ]; then mv "$d/dist.next" "$d/dist"; return; fi
  if mv -T --exchange "$d/dist.next" "$d/dist" 2>/dev/null; then
    mv "$d/dist.next" "$d/dist.prev"
  else
    mv "$d/dist" "$d/dist.prev" || return 1
    mv "$d/dist.next" "$d/dist" || { mv "$d/dist.prev" "$d/dist"; return 1; } # dist boş kalmasın: eskisi geri
  fi
}

# Hazır paket: bu commit'in GitHub derlemesi dist.next'lere indirilir (scripts/prebuilt.sh: commit bağı, sha256, tar
# güvenliği); doğrulama, takas ve geri alma yerel derlemeyle aynı yol. Alınamazsa belleği yeten cihaz (LOCAL_OK=1) Pi'de
# derler; yetmeyende güncelleme yapılmaz (kaynak önceki sürüme döner, çalışan panel değişmez). İndirme en çok 15 dk
# (GitHub derlemesini bekleme 10 dk + indirme): güncelleme işinin 30 dk sınırına (RuntimeMaxSec) takılıp geri almadan
# öldürülmesin; süre dolarsa (timeout → 124) paket alınamamış sayılır.
if [ "$BUILD_MODE" = prebuilt ]; then
  STEP=artifact
  log "Hazır paket indiriliyor (GitHub)..."
  rc=0; PB_OUT=$(PI5_PREBUILT_LOG="$LOGFILE" timeout 900 bash "$BASE/scripts/prebuilt.sh" fetch "$(git -C "$BASE" rev-parse HEAD 2>/dev/null)" "$BASE") || rc=$?
  if [ "$rc" = 124 ]; then log "Hazır paket: 15 dk süre sınırı aşıldı"; fi
  if [ "$rc" = 0 ]; then
    log "@@PREBUILT=$(printf '%s\n' "$PB_OUT" | sed -n 's/^tag=//p' | head -1)"
    deps_sync # yalnız backend'in üretim bağımlılıkları (PI5_BUILD_MODE=prebuilt)
  elif [ "$LOCAL_OK" = 1 ]; then
    log "Hazır paket alınamadı — Pi'de derleniyor"
    BUILD_MODE=local
    log "@@BUILD_MODE=local"
    deps_sync # Pi'de derleme için devDependencies (tsc, vite) ve frontend paketleri
  else
    log "Hazır paket alınamadı — bu cihazın belleği Pi'de derlemeye yetmez, güncelleme yapılmadı"
    build_failed artifact "$rc"
  fi
fi

if [ "$BUILD_MODE" = local ]; then
  STEP=backend
  log "Backend build..."
  rm -rf "$BASE/backend/dist.next"
  rc=0; build_step "$BASE/backend" ./node_modules/.bin/tsc --noEmitOnError --outDir dist.next || rc=$?
  [ "$rc" = 0 ] || build_failed backend "$rc"

  STEP=frontend
  log "Frontend build..."
  rm -rf "$BASE/frontend/dist.next"
  rc=0; build_step "$BASE/frontend" bash -c './node_modules/.bin/tsc -b && ./node_modules/.bin/vite build --outDir dist.next --emptyOutDir' || rc=$?
  [ "$rc" = 0 ] || build_failed frontend "$rc"
fi

# Hazır paket takastan ÖNCE denenir: backend'in söz dizimi, yerel sqlite3 modülünün bu cihazda (mimari / Node sürümü)
# yüklendiği ve üretim bağımlılıklarının tam olduğu. Bozuk paket canlıya geçip pi5-backend'i çökertmesin. Bağımlılık:
# post-update'in npm install'u düşerse yalnız uyarır; Pi'de derlemede eksik paketi tsc yakalar (TS2307), hazır pakette
# npm ls (post-update.sh ile aynı ölçüt: yalnız "missing:" / "invalid:", fazladan paket engel değil).
if [ "$BUILD_MODE" = prebuilt ]; then
  STEP=verify
  log "Paket doğrulanıyor (node --check, sqlite3, npm ls)..."
  rc=0; build_step "$BASE/backend" node --check dist.next/index.js || rc=$?
  if [ "$rc" = 0 ]; then build_step "$BASE/backend" node -e "require('sqlite3')" || rc=$?; fi
  if [ "$rc" = 0 ]; then build_step "$BASE/backend" bash -c 'npm ls --omit=dev --depth=0 2>&1 | grep -E "missing:|invalid:" && exit 1; exit 0' || rc=$?; fi
  [ "$rc" = 0 ] || build_failed verify "$rc"
fi

STEP=postupdate
log "Kurulum adımları çalıştırılıyor (post-update)..."
post_update system

STEP=swap
swap_dist "$BASE/backend"
swap_dist "$BASE/frontend"
log "Yeni derleme devrede (önceki: backend/dist.prev, frontend/dist.prev)"

log "=== Güncelleme tamamlandı ==="

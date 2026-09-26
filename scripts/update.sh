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
log "Git fetch..."
GIT_TERMINAL_PROMPT=0 git fetch origin master 2>&1 || {
  log "Normal fetch başarısız, sudo ile deneniyor..."
  sudo git fetch origin master 2>&1
}
log "Git reset..."
git reset --hard origin/master 2>&1 || sudo git reset --hard origin/master 2>&1
log "Git OK: $(git rev-parse --short HEAD 2>/dev/null || sudo git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

# Post-update (başarısızlığı güncellemeyi durdurmaz; çıkış kodu işaretlenir)
STEP=postupdate
if [ -f "$BASE/scripts/post-update.sh" ]; then
  log "Post-update çalıştırılıyor..."
  bash "$BASE/scripts/post-update.sh" 2>&1 || log "@@POSTUPDATE_RC=$?"
fi

# Backend build
STEP=backend
log "Backend build..."
cd "$BASE/backend"
npm run build 2>&1 | tail -3

# Frontend build
STEP=frontend
log "Frontend build..."
cd "$BASE/frontend"
npm run build 2>&1 | tail -3

log "=== Güncelleme tamamlandı ==="

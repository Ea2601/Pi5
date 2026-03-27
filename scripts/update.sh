#!/bin/bash
# System update script — called by backend update endpoint
# Handles all permission issues automatically
set -e

BASE="/opt/pi5-gateway"
LOGFILE="$BASE/core/update.log"

log() { echo "$(date '+%H:%M:%S') $1" | tee -a "$LOGFILE" 2>/dev/null; }

log "=== Güncelleme başlatıldı ==="
log "Kullanıcı: $(whoami), UID: $(id -u)"

# Fix ALL permission issues upfront
# Make entire repo writable by current user
chmod -R u+rwX "$BASE" 2>/dev/null || sudo chmod -R a+rwX "$BASE" 2>/dev/null || true
# Fix .git specifically
chmod -R 777 "$BASE/.git" 2>/dev/null || true

# Safe directory (both for current user and root)
git config --global --add safe.directory "$BASE" 2>/dev/null || true
HOME=/root git config --global --add safe.directory "$BASE" 2>/dev/null || true

# Git fetch + reset
cd "$BASE"
log "Git fetch..."
GIT_TERMINAL_PROMPT=0 git fetch origin master 2>&1 || {
  log "Normal fetch başarısız, sudo ile deneniyor..."
  sudo git fetch origin master 2>&1
}
log "Git reset..."
git reset --hard origin/master 2>&1 || sudo git reset --hard origin/master 2>&1
log "Git OK: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

# Post-update
if [ -f "$BASE/scripts/post-update.sh" ]; then
  log "Post-update çalıştırılıyor..."
  bash "$BASE/scripts/post-update.sh" 2>&1 || true
fi

# Backend build
log "Backend build..."
cd "$BASE/backend"
npm run build 2>&1 | tail -3

# Frontend build
log "Frontend build..."
cd "$BASE/frontend"
npm run build 2>&1 | tail -3

log "=== Güncelleme tamamlandı ==="

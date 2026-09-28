#!/usr/bin/env bash
# Klyrix Gate — Zapret blockcheck'ini arka planda çalıştırır (panel → Zapret → Blockcheck; systemd-run ile ayrık birim).
#   zapret-blockcheck.sh <alan_adı> [günlük_dosyası]
# Hangi DPI atlatma stratejisinin bu hatta çalıştığını dener; çıktı günlük dosyasına yazılır (panel izler).
# Zapret çalışıyorsa test süresince durdurulur ve sonra (test yarıda kesilse de) eski durumuna getirilir: blockcheck,
# çalışan DPI atlatma süreçleriyle yanıltıcı sonuç verir. Hızlı tarama (SCANLEVEL=quick), yalnız IPv4, HTTP + HTTPS/TLS1.2.
set -u
domain=${1:-}
log=${2:-/opt/pi5-gateway/core/blockcheck.log}
if ! [[ $domain =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
  echo "geçersiz alan adı: $domain" > "$log"
  exit 2
fi
[ -f /opt/zapret/blockcheck.sh ] || { echo "Zapret kurulu değil (/opt/zapret/blockcheck.sh yok)" > "$log"; exit 3; }

exec > "$log" 2>&1
was_active=0
systemctl is-active --quiet zapret && was_active=1
restore() {
  if [ "$was_active" = 1 ]; then
    systemctl start zapret && echo "Zapret yeniden başlatıldı" || echo "UYARI: Zapret yeniden başlatılamadı"
    was_active=0
  fi
}
trap restore EXIT
trap 'echo "test durduruldu"; exit 143' TERM INT

echo "== blockcheck: $domain — $(date '+%Y-%m-%d %H:%M:%S')"
if [ "$was_active" = 1 ]; then echo "Zapret test süresince durduruluyor"; systemctl stop zapret; fi
cd /opt/zapret || exit 3
BATCH=1 DOMAINS="$domain" IPVS=4 ENABLE_HTTP=1 ENABLE_HTTPS_TLS12=1 ENABLE_HTTPS_TLS13=0 ENABLE_HTTP3=0 \
  SCANLEVEL=quick SKIP_TPWS=1 /bin/sh ./blockcheck.sh
rc=$?
restore
echo "== bitti (çıkış kodu $rc) — $(date '+%Y-%m-%d %H:%M:%S')"

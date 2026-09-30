#!/bin/bash
# Klyrix Gate — HDMI ekranı (kiosk). pi5-kiosk.service → xinit (root) → openbox --startup → bu betik (root).
# Tek kaynak: install.sh ve post-update.sh bu dosyayı artık yazmaz (eskiden iki ayrışmış kopya vardı; güncelleme her
# seferinde "chromium-browser" sabitli kopyayı geri yazıyordu, trixie'de o ad yok).
#
# Chromium root olarak ÇALIŞTIRILMAZ: root'ta sandbox'sız açılmayı reddeder ("Running as root without --no-sandbox is
# not supported"). Ayrı sistem kullanıcısıyla (klyrix-kiosk) açılır; X sunucusu root'ta kalır, kullanıcıya yalnız bu
# ekrana bağlanma izni verilir (xhost SI:localuser). Çekirdek kullanıcı ad alanına izin vermiyorsa Chromium'un kendi
# sandbox'ı kurulamaz: o zaman --no-sandbox ile açılır (yine root değil) ve günlüğe yazılır.
# Chromium kapanırsa yeniden açılır; 30 sn'den kısa sürede 5 kez üst üste kapanırsa vazgeçilir ve oturum kapatılır
# (servis durur; panel "kiosk açılamadı" der). Günlük: journalctl -u pi5-kiosk ("[kiosk]" satırları).
set -u
export DISPLAY=${DISPLAY:-:0}
URL=${PI5_KIOSK_URL:-http://localhost/kiosk.html}
KUSER=klyrix-kiosk
KHOME=/var/lib/klyrix-kiosk

log() { echo "[kiosk] $*"; }
give_up() { log "HATA: $*"; command -v openbox >/dev/null 2>&1 && openbox --exit 2>/dev/null; exit 1; }

BIN=$(command -v chromium || command -v chromium-browser || true)
[ -n "$BIN" ] || give_up "Chromium kurulu değil (sudo apt install chromium)"

# Kullanıcı: yoksa oluşturulur (ev dizini Chromium profilini tutar); ekran kartı için video / render grupları
if ! id "$KUSER" >/dev/null 2>&1; then
  useradd --system --home-dir "$KHOME" --create-home --shell /usr/sbin/nologin "$KUSER" \
    || give_up "$KUSER kullanıcısı oluşturulamadı"
  log "$KUSER kullanıcısı oluşturuldu"
fi
for g in video render; do getent group "$g" >/dev/null && usermod -aG "$g" "$KUSER" 2>/dev/null; done
mkdir -p "$KHOME" && chown "$KUSER" "$KHOME" && chmod 700 "$KHOME"

# Ekran koruyucu ve güç yönetimi kapalı; Chromium kullanıcısına bu ekrana bağlanma izni
xset s off 2>/dev/null; xset s noblank 2>/dev/null; xset -dpms 2>/dev/null
xhost "+SI:localuser:$KUSER" >/dev/null 2>&1 || log "UYARI: xhost izni verilemedi (x11-xserver-utils kurulu mu?)"

SANDBOX=()
if ! runuser -u "$KUSER" -- unshare --user true 2>/dev/null; then
  # --test-type: "desteklenmeyen seçenek" uyarı çubuğunu gizler (kiosk ekranında kalıcı sarı şerit olurdu)
  SANDBOX=(--no-sandbox --test-type)
  log "UYARI: kullanıcı ad alanı açılamıyor — Chromium sandbox'sız açılıyor (root değil: $KUSER)"
fi

log "Chromium: $BIN → $URL (kullanıcı $KUSER)"
fails=0
while :; do
  started=$(date +%s)
  runuser -u "$KUSER" -- env DISPLAY="$DISPLAY" HOME="$KHOME" "$BIN" \
    --kiosk \
    --user-data-dir="$KHOME/profile" \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-translate \
    --no-first-run \
    --password-store=basic \
    --disable-features=TranslateUI \
    --check-for-update-interval=31536000 \
    --disable-component-update \
    --overscroll-history-navigation=0 \
    "${SANDBOX[@]}" \
    "$URL"
  rc=$?
  if [ $(( $(date +%s) - started )) -lt 30 ]; then fails=$((fails + 1)); else fails=0; fi
  log "Chromium kapandı (rc=$rc, üst üste $fails)"
  [ "$fails" -ge 5 ] && give_up "Chromium üst üste açılamadı — kiosk durduruldu"
  sleep $((2 + fails * 3))
done

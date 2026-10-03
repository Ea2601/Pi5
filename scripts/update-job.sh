#!/bin/bash
# Klyrix Gate — panelden başlatılan güncelleme işi. Backend (backend/src/update.ts) bunu pi5-backend'in DIŞINDA başlatır:
#   systemd-run --unit=pi5-update --collect --service-type=exec -p RuntimeMaxSec=1800 /bin/bash update-job.sh <kimlik>
# Tarayıcı bağlantısına ve backend'in yeniden başlatılmasına bağlı değildir: eskiden update.sh panelin isteği içinde
# 5 dk'ya kadar bekletiliyordu; bağlantı koparsa panel "Failed to fetch" gösteriyordu. Çıktı /run/pi5-update/output'a,
# sonuç /run/pi5-update/state'e (KEY=VALUE) yazılır; panel /api/system/update/status ile izler. Başarılıysa yeni kod
# devreye girsin diye backend'i yeniden başlatır. Elle güncelleme (bu iş olmadan) değişmedi:
#   sudo bash /opt/pi5-gateway/scripts/update.sh && sudo systemctl restart pi5-backend
set -u
BASE=/opt/pi5-gateway
DIR=/run/pi5-update
ID=${1:-$(date +%s)}
STARTED=$(date +%s)
mkdir -p "$DIR" || exit 1

# Durum dosyası geçici dosya + mv ile yazılır: panel yarım dosya okumasın.
put_state() {
  local st=$1 tmp="$DIR/state.$$" kv
  shift
  {
    printf 'id=%s\nstate=%s\nstarted=%s\n' "$ID" "$st" "$STARTED"
    [ "$st" = running ] || printf 'finished=%s\n' "$(date +%s)"
    for kv in "$@"; do printf '%s\n' "$kv"; done
  } > "$tmp" && mv -f "$tmp" "$DIR/state"
}

# systemd durdurursa (30 dk sınırı ya da systemctl stop) sonuç "sürüyor" diye kalmasın.
trap 'put_state failed rc=143 reason=stopped; exit 143' TERM

# Depolama işi (pi5-storage: disk hazırlama / veri taşıma — panel servisini durdurur) sürerken güncelleme başlamaz: bitince
# pi5-backend'i yeniden başlatır, iş ortasında panel verisini açabilirdi. Gece çalıştırması ertesi geceye kalır.
if systemctl is-active --quiet pi5-storage.service 2>/dev/null; then
  put_state failed rc=0 reason=storage
  exit 0
fi
# Uygulama işi (pi5-apps: motor kurulumu / imaj indirme — apt ve veri diski) sürerken de ertelenir.
if systemctl is-active --quiet pi5-apps.service 2>/dev/null; then
  put_state failed rc=0 reason=apps
  exit 0
fi

put_state running
bash "$BASE/scripts/update.sh" > "$DIR/output" 2>&1 < /dev/null
rc=$?
if [ "$rc" -ne 0 ]; then
  put_state failed "rc=$rc"
  exit "$rc"
fi
# Yeni kod devreye girsin. Bu birim pi5-backend'in dışında: yeniden başlatma işi yarıda kesmez. "done" ancak yeniden
# başlatma komutu başarılıysa yazılır (panel o ana kadar "Servis yeniden başlatılıyor" görür).
if ! systemctl restart pi5-backend; then
  put_state failed rc=0 restart=failed
  exit 1
fi
put_state 'done' rc=0

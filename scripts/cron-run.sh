#!/usr/bin/env bash
# Klyrix Gate — panelden yönetilen cron görevinin çalıştırıcısı (/etc/cron.d/pi5-panel çağırır).
#   cron-run.sh <id>
# Komut /opt/pi5-gateway/core/cron-jobs/<id>.sh dosyasındadır (panel yazar; komut cron satırına gömülmez — '%' ve
# tırnaklar sorun olmaz). Aynı görev bir önceki çalışması sürerken yeniden başlamaz (flock). Sonuç <id>.status'a
# "çıkış_kodu epoch" olarak yazılır (panel "son çalışma"yı buradan gösterir); hata olursa çıktının son 40 satırı sistem
# günlüğüne (core/system.log) "CRON:" önekiyle eklenir. Başarılı çalışma günlüğe yazılmaz (sık görevler günlüğü şişirmesin).
set -u
id=${1:-}
[[ $id =~ ^[0-9]+$ ]] || exit 2
dir=/opt/pi5-gateway/core/cron-jobs
job=$dir/$id.sh
log=/opt/pi5-gateway/core/system.log
[ -f "$job" ] || exit 3

exec 9>"$dir/$id.lock"
flock -n 9 || exit 0

name=$(sed -n 's/^# name: //p' "$job" | head -n 1)
out=$(/bin/bash "$job" 2>&1 9>&-)
rc=$?
printf '%s %s\n' "$rc" "$(date +%s)" > "$dir/$id.status.tmp" && mv -f "$dir/$id.status.tmp" "$dir/$id.status"
if [ "$rc" -ne 0 ]; then
  {
    printf '[%s] CRON: "%s" (görev %s) hata verdi, çıkış kodu %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$name" "$id" "$rc"
    printf '%s\n' "$out" | tail -n 40 | sed 's/^/    /'
  } >> "$log" 2>/dev/null
fi
exit "$rc"

#!/bin/sh
# SunFounder pironman5'in OLED ve RGB modüllerini bırakmasını sağlar; fan ve güç
# yönetimi pironman5'te kalır. Böylece kasa OLED'ini yalnız pi5-lcd, kasa RGB'sini
# yalnız led_control.py sürer (iki proses aynı donanıma yazınca ekran üst üste
# biniyor, LED rengi eziliyordu).
#
# ÖNEMLİ: pironman5 config dosyasını YALNIZCA başlangıçta okur. "pironman5 -oe 0 -re 0"
# dosyayı doğru günceller ama çalışan servis bunu görmez — v2.10.1'den beri unit'te
# duran "-oe 0" bu yüzden hiç etkili olmamıştı. Config gerçekten değiştiyse servisi de
# yeniliyoruz; değişmediyse dokunmuyoruz (gereksiz fan kesintisi olmasın).
#
# restart --no-block: bu script pi5-lcd unit'inin ExecStartPre'sinden de çağrılıyor;
# oradan senkron "systemctl restart" systemd iş kuyruğunda kilitlenmeye yol açabilir.
#
# Her yoldan 0 ile çıkar: pironman5 kurulu olmayan kasalarda sessizce atlanmalı.
set -u

P="$(command -v pironman5 2>/dev/null || echo /usr/local/bin/pironman5)"
[ -x "$P" ] || exit 0

BEFORE="$("$P" -c 2>/dev/null || true)"
"$P" -oe 0 -re 0 >/dev/null 2>&1 || exit 0
AFTER="$("$P" -c 2>/dev/null || true)"

if [ "$BEFORE" != "$AFTER" ]; then
  systemctl restart --no-block pironman5 >/dev/null 2>&1 || true
fi
exit 0

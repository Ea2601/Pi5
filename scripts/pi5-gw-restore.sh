#!/usr/bin/env bash
# Klyrix Gate — açılışta ağ geçidi kurallarını panelden (Node) bağımsız yükler: nftables.service'ten sonra çalışır
# (pi5-gw-restore.service). Pi tüm evin ağ geçidiyken backend ayağa kalkana kadar istemci trafiği düşmesin:
#   - /etc/nftables.d/pi5-wgnat.conf  : tek bacaklı hairpin NAT + tünel masquerade
#   - /opt/pi5-gateway/core/pi5-gw.nft: eski 'inet filter' forward (policy drop) içindeki pi5_gw izin zinciri
#   - /etc/nftables.d/device-block.conf: cihaz engelleri
# Dosyaları backend yazar ve her açılışta yeniden yazar; bu betik yalnız son hallerini erkenden yükler. Hatalar
# günlüğe yazılır, açılışı durdurmaz.
set -u
log() { logger -t pi5-gw-restore "$*" 2>/dev/null || true; }
for f in /etc/nftables.d/pi5-wgnat.conf /etc/nftables.d/device-block.conf; do
  [ -s "$f" ] || continue
  out=$(nft -f "$f" 2>&1) || log "yüklenemedi: $f: $out"
done
# Domain/uygulama yönlendirme zinciri (iptables-nft mangle PI5_ROUTING): nftables restart'ı (ör. gece apt yükseltmesi)
# `flush ruleset` ile bunu da siler. Kural dosyasını backend yazar; setler (rt_m*) kernel ipset'idir, silinmez.
# Açılışta setler henüz yoksa yükleme başarısız olur (atomik) — backend birazdan kendisi kurar.
RULES=/opt/pi5-gateway/core/pi5-routing.rules
if [ -s "$RULES" ] && command -v iptables-restore >/dev/null 2>&1; then
  if out=$(iptables-restore -w 5 --noflush "$RULES" 2>&1); then
    for ch in PREROUTING OUTPUT; do
      iptables -w 5 -t mangle -C "$ch" -j PI5_ROUTING 2>/dev/null || iptables -w 5 -t mangle -A "$ch" -j PI5_ROUTING 2>/dev/null \
        || log "mangle $ch → PI5_ROUTING eklenemedi"
    done
  else
    log "PI5_ROUTING şimdilik yüklenmedi (backend kuracak): $out"
  fi
fi
GW=/opt/pi5-gateway/core/pi5-gw.nft
if [ -s "$GW" ] && nft list chain inet filter forward >/dev/null 2>&1; then
  # Dosyadaki "insert … jump" satırı yalnız yazıldığı anda eksikse vardır → zinciri kur, atlamayı ayrıca garanti et.
  out=$(grep -v '^insert rule inet filter forward jump pi5_gw' "$GW" | nft -f - 2>&1) || log "pi5_gw yüklenemedi: $out"
  if nft list chain inet filter pi5_gw >/dev/null 2>&1 && ! nft list chain inet filter forward | grep -q 'jump pi5_gw'; then
    nft insert rule inet filter forward jump pi5_gw 2>/dev/null || log "forward → pi5_gw atlaması eklenemedi"
  fi
fi
exit 0

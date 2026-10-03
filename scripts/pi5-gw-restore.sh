#!/usr/bin/env bash
# Klyrix Gate — açılışta ağ geçidi kurallarını panelden (Node) bağımsız yükler: nftables.service'ten sonra çalışır
# (pi5-gw-restore.service). Pi tüm evin ağ geçidiyken backend ayağa kalkana kadar istemci trafiği düşmesin:
#   - /etc/nftables.d/pi5-wgnat.conf  : tek bacaklı hairpin NAT + tünel masquerade
#   - /opt/pi5-gateway/core/pi5-gw.nft: eski 'inet filter' forward (policy drop) içindeki pi5_gw izin zinciri
#   - /opt/pi5-gateway/core/pi5-in.nft: eski 'inet filter' input (policy drop) içindeki pi5_in izin zinciri (DHCP, ping)
#   - /etc/nftables.d/device-block.conf: cihaz engelleri
#   - /etc/nftables.d/pi5-ap.conf     : kurulum Wi-Fi'ı (80/tcp giriş sayfasına, bu ağdan / bu ağa iletim yok)
#   - /etc/nftables.d/pi5-relay.conf  : uzaktan yönetim süzgeci (yalnız panel erişimi açık VPS istemcileri; özellik
#                                       kapalıyken dosya yoktur — backend/src/remoteAccess.ts)
#   - /etc/nftables.d/pi5-wgext.conf  : hazır yapılandırmayla kurulan tünellerden gelen yeni bağlantıları düşürür (böyle
#                                       tünel yokken dosya yoktur — backend/src/wgImport.ts)
#   - /opt/pi5-gateway/core/pi5-geo.nft: Geo-IP / tehdit engeli (yalnız panelde "Kalıcı yap" denince yazılır; özellik
#                                       kapalıyken ya da denemedeyken dosya yoktur — backend/src/geoBlock.ts)
# Dosyaları backend yazar ve her açılışta yeniden yazar (pi5-ap.conf'u net-mode.sh yazar, pi5-net-guard her açılışta
# yeniden yükler); bu betik yalnız son hallerini erkenden yükler. Hatalar günlüğe yazılır, açılışı durdurmaz.
set -u
log() { logger -t pi5-gw-restore "$*" 2>/dev/null || true; }
for f in /etc/nftables.d/pi5-wgnat.conf /etc/nftables.d/device-block.conf /etc/nftables.d/pi5-ap.conf /etc/nftables.d/pi5-relay.conf \
  /etc/nftables.d/pi5-wgext.conf; do
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
# Pi DHCP sunucusu (udp 67) ve ping izni: Pi evin DHCP sunucusuyken backend beklenmeden adres dağıtılabilsin.
IN=/opt/pi5-gateway/core/pi5-in.nft
if [ -s "$IN" ] && nft list chain inet filter input >/dev/null 2>&1; then
  # pi5_gw ile aynı: "insert … jump" satırı ayıklanır, atlama ayrıca (yalnız eksikse) eklenir.
  out=$(grep -v '^insert rule inet filter input jump pi5_in' "$IN" | nft -f - 2>&1) || log "pi5_in yüklenemedi: $out"
  if nft list chain inet filter pi5_in >/dev/null 2>&1 && ! nft list chain inet filter input | grep -q 'jump pi5_in'; then
    nft insert rule inet filter input jump pi5_in 2>/dev/null || log "input → pi5_in atlaması eklenemedi"
  fi
fi
# nftables yeniden başlatıldı / yüklendiyse `flush ruleset` Fail2Ban'ın ve Zapret'in kurallarını da sildi (panelinkiler
# yukarıda geri yüklendi). Fail2Ban: yasaklı IP var ama hiçbiri kurallarda yoksa yeniden başlatılır (yasakları kendi
# veritabanından geri yükler). Zapret: nftables'tan ÖNCE başlamış ve çalışıyorsa yeniden başlatılır. Açılışta ikisi de
# nftables'tan sonra başlar → dokunulmaz. --no-block: oneshot birimden beklemeli systemctl çağrısı kilitlenmesin.
if [ "$(systemctl is-active fail2ban 2>/dev/null)" = active ] && command -v fail2ban-client >/dev/null 2>&1; then
  banned=$(fail2ban-client banned 2>/dev/null | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | sort -u)
  if [ -n "$banned" ]; then
    # Geo-IP tablosu (pi5_geo) sayılmaz: tehdit kümesinde yasaklı bir IP bulunması "yasaklar duruyor" sanılmasın
    ruleset=$(nft list ruleset 2>/dev/null | sed '/^table inet pi5_geo {/,/^}/d')
    lost=1
    for ip in $banned; do
      if printf '%s' "$ruleset" | grep -qwF -- "$ip"; then lost=0; break; fi  # tam adres (11.2.3.45 içindeki 1.2.3.4 sayılmaz)
    done
    if [ "$lost" = 1 ]; then
      systemctl --no-block restart fail2ban && log "fail2ban yeniden başlatıldı (yasakları nftables yüklemesiyle silinmişti)"
    fi
  fi
fi
nft_at=$(systemctl show -p ActiveEnterTimestampMonotonic --value nftables 2>/dev/null)
z_at=$(systemctl show -p ActiveEnterTimestampMonotonic --value zapret 2>/dev/null)
if [ "$(systemctl is-active zapret 2>/dev/null)" = active ] && [[ $nft_at =~ ^[0-9]+$ ]] && [[ $z_at =~ ^[0-9]+$ ]] \
  && [ "$z_at" -gt 0 ] && [ "$z_at" -lt "$nft_at" ]; then
  systemctl --no-block restart zapret && log "zapret yeniden başlatıldı (kuralları nftables yeniden başlatılınca silinmişti)"
fi
# Geo-IP / tehdit engeli: kendi tablosu (inet pi5_geo), /etc/nftables.d dışında — bozuk dosya pi5_filter'ın yüklemesini
# bozmasın. En sonda: yukarıdaki Fail2Ban denetimi kümelerdeki (ör. AbuseIPDB) yasaklı IP'yi görüp yanılmasın, büyük
# kümeler `nft list ruleset` dökümüne girmesin.
GEO=/opt/pi5-gateway/core/pi5-geo.nft
if [ -s "$GEO" ]; then
  out=$(nft -f "$GEO" 2>&1) || log "yüklenemedi: $GEO: $out"
fi
exit 0

#!/usr/bin/env bash
# Klyrix Gate — salt okunur canlı doğrulama. Hiçbir şeyi değiştirmez (DB'ler read-only açılır).
# Çalıştırma: sudo bash /opt/pi5-gateway/scripts/pi5-check.sh 2>&1 | tee /tmp/pi5-check.txt
set +e
export LC_ALL=C
h(){ printf '\n===== %s =====\n' "$*"; }
# Günlük satırlarındaki sırları maskele (DDNS token, parola vb. — çıktı paylaşılabilir kalsın)
redact(){ sed -E -e 's/((token|password|passwd|pass|key|secret|apikey|api_key)=)[^&[:space:]"]+/\1***/Ig' \
  -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+)[^[:space:]"]+/\1***/Ig' \
  -e 's#(//[^/[:space:]:@]+:)[^@[:space:]/]+@#\1***@#g'; }
DB=/opt/pi5-gateway/core/pi5router.sqlite
LANIP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')

h "Sürümler"
grep PRETTY_NAME /etc/os-release; pihole -v 2>/dev/null; unbound -V 2>/dev/null | head -1
fail2ban-client version 2>/dev/null; node -v 2>/dev/null; head -4 /opt/pi5-gateway/version.json 2>/dev/null

h "Topoloji: arayüzler, varsayılan rota, IPv6, yönlendirme"
ip -br addr; ip -4 route show default; ip -6 route show default; ip -6 addr show scope global | grep inet6
echo "Pi LAN IP (internet çıkış kaynağı; sabit IP'de modem tarafı): $LANIP"; GW=$(ip -4 route show default | awk '{print $3; exit}'); echo "Varsayılan ağ geçidi: $GW"
sysctl net.ipv4.ip_forward net.ipv4.conf.all.send_redirects net.ipv6.conf.all.forwarding
grep '^Ip:' /proc/net/snmp   # ForwDatagrams > 0 ise Pi üzerinden yönlendirilen istemci var
nmcli -t -f NAME,DEVICE,TYPE con show --active 2>/dev/null
for d in $(ip -o -4 route show default | awk '{print $5}' | sort -u); do
  echo "$d ipv4.method: $(nmcli -g ipv4.method connection show "$(nmcli -g GENERAL.CONNECTION device show "$d" 2>/dev/null)" 2>/dev/null)"
done

h "Servis durumları (ActiveState / UnitFileState)"
for u in pihole-FTL unbound nftables fail2ban zapret nginx pi5-backend pi5-lcd pi5-kiosk pironman5 getty@tty1; do
  printf '%-20s %s / %s\n' "$u" "$(systemctl show -p ActiveState --value "$u" 2>/dev/null)" "$(systemctl show -p UnitFileState --value "$u" 2>/dev/null)"
done
systemctl list-units 'wg-quick@*' --all --no-legend --no-pager

h "WireGuard tünelleri ve el sıkışma yaşı"
wg show interfaces
wg show all latest-handshakes | awk -v now="$(date +%s)" '{printf "%s peer=%s... yas=%s\n", $1, substr($2,1,8), ($3==0 ? "HIC" : (now-$3) "s")}'

h "Pi-hole v6: web sunucusu, parola, DNS, DHCP"
for k in webserver.port dns.upstreams dns.listeningMode dns.blocking.active misc.etc_dnsmasq_d misc.privacylevel dhcp.active dhcp.start dhcp.end dhcp.router dhcp.hosts; do
  printf '%-22s %s\n' "$k" "$(pihole-FTL --config "$k" 2>/dev/null)"
done
if [ -n "$(pihole-FTL --config webserver.api.pwhash 2>/dev/null)" ]; then echo "webserver.api.pwhash: AYARLI"; else echo "webserver.api.pwhash: BOS (parolasız API)"; fi
echo -n "FTL API :443 -> "; curl -sk --max-time 3 https://127.0.0.1/api/auth; echo
echo -n "FTL API :8080 -> "; curl -s --max-time 3 http://127.0.0.1:8080/api/auth; echo
ss -ltnp | grep -E ':(80|443|8080|53|5335) '; ss -lunp | grep -E ':(53|67|547|5353) '
ls -l /etc/pihole/setupVars.conf /etc/pihole/pihole.toml /etc/pihole/dhcp.leases 2>&1
ls -l /etc/dnsmasq.d/ 2>&1

h "Unbound"
ls /etc/unbound/unbound.conf.d/
grep -rnE 'forward-zone|extended-statistics|num-threads|control-enable' /etc/unbound/ 2>/dev/null
unbound-control status 2>&1 | head -5
echo -n "Unbound 5335 test: "; dig +short +time=2 @127.0.0.1 -p 5335 example.com 2>&1 | head -1

h "nftables / iptables / policy routing"
nft list tables; head -3 /etc/nftables.conf; grep -n include /etc/nftables.conf; ls -l /etc/nftables.d/ 2>/dev/null
nft list chain inet pi5_filter input 2>/dev/null | grep -E 'policy|dport'
for c in iptables ipset nft; do printf '%-9s %s\n' "$c" "$(command -v "$c" || echo YOK)"; done
iptables -V 2>&1; ipset version 2>&1 | head -1
echo "--- mangle PI5_ROUTING:"; iptables -t mangle -S PI5_ROUTING 2>&1 | head -20
echo "--- tünel + ağ geçidi NAT (nft pi5_wgnat):"; nft list table ip pi5_wgnat 2>&1 | grep -E 'masquerade|Error'
echo "--- ağ geçidi izni (eski 'inet filter' forward → pi5_gw):"
echo "forward başında jump pi5_gw: $(nft list chain inet filter forward 2>/dev/null | grep -c 'jump pi5_gw') adet"
nft list chain inet filter pi5_gw 2>&1 | grep -E 'accept|maxseg|Error'
echo "--- eski yerli 'table ip nat':"; nft list table ip nat 2>&1 | grep -vE '^\s*$' | head -10
echo "--- çekirdek modülleri:"; lsmod | awk '{print $1}' | grep -E '^(ip_set|ip_set_hash_ip|xt_set|nft_compat|xt_connmark|xt_mark)$' | tr '\n' ' '; echo
echo "--- pihole-FTL CAP_NET_ADMIN (ipset'e yazabilmek için): $(systemctl show -p AmbientCapabilities --value pihole-FTL | grep -qi net_admin && echo VAR || echo YOK)"
echo "--- FTL ipset hataları:"; grep -i ipset /var/log/pihole/FTL.log 2>/dev/null | tail -3
echo "--- ipset'ler:"; for s in $(ipset list -n 2>/dev/null | grep '^rt_m'); do echo "$s: $(ipset list "$s" | sed '1,/^Members:/d' | grep -c .) IP"; done
echo "--- ip rule (fwmark, tekrar sayısıyla):"; ip rule show | grep fwmark | sed -E 's/^[0-9]+:\s*//' | sort | uniq -c
for t in $(ip rule show | grep -o 'lookup [0-9]*' | awk '{print $2}' | sort -u); do echo "tablo $t: $(ip route show table "$t" 2>&1 | tr '\n' ' ')"; done
# Hazır liste (Yetişkin / Kumar) VPS'e yönlendirilince dosyada ~52 bin `server=/…/127.0.0.1#5390` satırı olur: sayılır,
# geri kalanı (kurallar, ipset satırları, "# klyrix-list:" yorumları) en çok 200 satır gösterilir.
DR=/etc/dnsmasq.d/05-domain-routing.conf
echo "--- 05-domain-routing.conf:"
if [ -f "$DR" ]; then
  grep -v '127\.0\.0\.1#5390' "$DR" | head -n 200
  echo "(hazır liste satırı — server=/…/127.0.0.1#5390: $(grep -c '127\.0\.0\.1#5390' "$DR"); dosya toplam $(wc -l < "$DR") satır)"
fi

h "Fail2Ban"
fail2ban-client status 2>/dev/null
for o in ignoreip bantime maxretry findtime; do printf '%-9s %s\n' "$o" "$(fail2ban-client get sshd "$o" 2>/dev/null | tr '\n' ' ')"; done

h "Zapret"
systemctl cat zapret 2>/dev/null | grep -E '^(ExecStart|ExecStop)='; ls -d /opt/zapret/binaries 2>&1
grep -E '^(FWTYPE|MODE_FILTER|NFQWS_ENABLE|TPWS_ENABLE|DESYNC_MARK)=' /opt/zapret/config 2>/dev/null
pgrep -a nfqws; pgrep -a tpws

h "Panel erişimi (nginx Basic Auth / giriş ekranı)"
bash /opt/pi5-gateway/scripts/panel-auth.sh status 2>/dev/null | grep -E '^(state|password_set|trial_ends|mode|mode_trial_ends)='
grep -rnE 'auth_basic|satisfy|include' /etc/nginx/sites-enabled/ /etc/nginx/snippets/ /etc/nginx/conf.d/ 2>/dev/null
curl -s -o /dev/null -w "LAN IP'den /api/status: HTTP %{http_code} (200 = korumasız, 401 = korumalı)\n" --max-time 3 "http://$LANIP/api/status"

h "Sabit IP (net-mode.sh) ve Pi DHCP (pi-dhcp.sh) — salt okunur durum"
printf 'pi5-net-guard: %s / %s\n' "$(systemctl show -p ActiveState --value pi5-net-guard 2>/dev/null)" "$(systemctl show -p UnitFileState --value pi5-net-guard 2>/dev/null)"
bash /opt/pi5-gateway/scripts/net-mode.sh status 2>/dev/null | grep -E '^(stage|trial_ends|iface|transit|client|gw|dns|nm|active_conn|method|addrs|carrier|profile_ok|planned_iface|planned_transit|planned_gw|wifi|wifi_off|wlan_addrs|guard_result|guard_at|guard_detail|pi_dhcp)=' | sed 's/^/net-mode: /'
bash /opt/pi5-gateway/scripts/pi-dhcp.sh status 2>/dev/null | grep -E '^(stage|trial_ends|active|start|end|router|netmask|lease_time|ipv6|hosts|listening_mode|port67|leases|input_ok|ftl)=' | sed 's/^/pi-dhcp: /'

h "Kasa / kiosk / donanım"
for c in chromium chromium-browser; do printf '%-16s %s\n' "$c" "$(command -v "$c" || echo YOK)"; done
grep -nE 'chromium|no-sandbox' /opt/pi5-gateway/scripts/kiosk.sh 2>/dev/null
grep -nE '^(User|ExecStart)=' /etc/systemd/system/pi5-kiosk.service 2>/dev/null
journalctl -u pi5-kiosk -n 15 --no-pager 2>/dev/null
for hw in /sys/class/hwmon/hwmon*; do echo "$hw $(cat "$hw/name" 2>/dev/null) fan1_input=$(cat "$hw/fan1_input" 2>/dev/null || echo yok)"; done

h "Araçlar, saat dilimi, bakım"
for c in dig etherwake wakeonlan speedtest-cli qrencode conntrack nmcli wg; do printf '%-14s %s\n' "$c" "$(command -v "$c" || echo YOK)"; done
echo "Saat dilimi: $(timedatectl show -p Timezone --value)"; cat /etc/cron.d/pi5-maintenance 2>/dev/null
echo "dpkg sağlığı: yarım işlem (journal) $(find /var/lib/dpkg/updates -maxdepth 1 -regex '.*/[0-9]+$' 2>/dev/null | wc -l) dosya, 'dpkg --audit' $(dpkg --audit 2>/dev/null | grep -c .) satır, çalışan pi5-pkg birimi $(systemctl list-units --no-legend 'pi5-pkg-*' 2>/dev/null | grep -c .)"
grep '\[pkg\]' /opt/pi5-gateway/core/update.log 2>/dev/null | tail -5

h "Panel son hatalar (pi5-backend, son 30 satır routing/hata)"
journalctl -u pi5-backend --since '-1 day' --no-pager 2>/dev/null | grep -iE 'routing|error|hata|failed|tunnel|wg ' | grep -v 'X-Forwarded-For' | redact | tail -30

h "Panel ve gravity veritabanları (salt okunur)"
python3 - "$DB" <<'PY'
import sqlite3, sys
try: c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
except Exception as e: print("Panel DB açılamadı:", e); c = None
checks = [
 ("cron_jobs (ad, adet)", "SELECT name, COUNT(*) FROM cron_jobs GROUP BY name ORDER BY 2 DESC"),
 ("vps_servers", "SELECT id, ip, location, status FROM vps_servers"),
 ("ddns_configs", "SELECT id, provider, enabled, status, last_update FROM ddns_configs"),
 ("cihazlar (toplam, engelli)", "SELECT COUNT(*), SUM(blocked) FROM devices"),
 ("routing: app kuralları (VPS/DPI)", "SELECT app_name, exit_node, dpi_bypass FROM traffic_routing WHERE enabled=1 AND (exit_node<>'isp' OR dpi_bypass=1)"),
 ("routing: domain kuralları", "SELECT domain, exit_node, dpi_bypass, enabled FROM domain_routing"),
 ("panel Pi-hole listeleri (yalnız DB)", "SELECT list_type, COUNT(*) FROM pihole_lists GROUP BY list_type"),
 ("statik DHCP (yalnız DB)", "SELECT COUNT(*) FROM dhcp_leases WHERE is_static=1"),
 ("ebeveyn kuralı / cihaz hız-kota sınırı (etkin)", "SELECT (SELECT COUNT(*) FROM parental_rules), (SELECT COUNT(*) FROM bandwidth_limits WHERE enabled=1)"),
]
if c:
    for label, sql in checks:
        try: print(f"{label}: {c.execute(sql).fetchall()}")
        except Exception as e: print(f"{label}: HATA {e}")
try:
    g = sqlite3.connect("file:/etc/pihole/gravity.db?mode=ro", uri=True)
    print("gravity adlist (toplam, etkin):", g.execute("SELECT COUNT(*), SUM(enabled) FROM adlist").fetchall())
    print("gravity domainlist (type, adet):", g.execute("SELECT type, COUNT(*) FROM domainlist GROUP BY type").fetchall())
except Exception as e: print("gravity.db:", e)
PY

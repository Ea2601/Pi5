#!/usr/bin/env bash
# Klyrix Gate — panel erişim koruması (nginx Basic Auth). Root olarak çalışır; aynı anda tek işlem (flock).
#   ensure           güncelleme/kurulum/açılış: durumu kurar, açık korumayı onarır, süresi geçen denemeyi geri alır.
#                    Korumayı ASLA kendiliğinden açmaz.
#   status           durum satırları (şifre ya da özet yazmaz)
#   set-password     yeni şifre stdin'in ilk satırından (12-128 karakter). Düz metin saklanmaz: yalnız SHA-512 crypt özeti.
#   on [--trial SN]  korumayı açar; --trial ile SN saniye içinde "confirm" gelmezse kendiliğinden geri alınır
#   confirm          denemeyi kalıcı yapar
#   rollback         yalnız deneme sürüyorsa korumayı kapatır (zamanlayıcı / açılış çağırır)
#   off              korumayı kapatır — kurtarma:  sudo bash /opt/pi5-gateway/scripts/panel-auth.sh off
#   reset            terminalde yeni şifre sorar — kurtarma: sudo bash /opt/pi5-gateway/scripts/panel-auth.sh reset
# Pi'nin kendisi (127.0.0.1, ::1: kiosk, OLED, yerel betikler) her istekte muaftır; LAN'daki herkes şifre girer.
# Tek istisna kurulum Wi-Fi'ının giriş sayfasıdır: /portal.html ve /api/captive herkese şifresiz (telefonun "ağa giriş"
# ekranı şifre soramaz; ikisi de gizli bilgi taşımaz).
# nginx site dosyasına dokunulmaz: koruma http seviyesindeki conf.d/pi5-auth.conf ile gelir (certbot / eski sürüm
# değişiklikleri sorun olmaz). Her değişiklik: yedek → atomik yazım → nginx -t → reload (restart değil) → erişim testi
# → sorun varsa otomatik geri alma.
set -u
export LC_ALL=C
umask 077
DIR=/etc/pi5-gateway
STATE_FILE=$DIR/panel-auth.state
HTPASSWD=/etc/nginx/pi5-gateway.htpasswd
CONF=/etc/nginx/conf.d/pi5-auth.conf
LEGACY_SNIPPET=/etc/nginx/snippets/pi5-auth.conf
TIMER_UNIT=pi5-auth-rollback
LOCK=/run/pi5-panel-auth.lock
USER_NAME=admin
SELF=$(readlink -f "$0")

die() { echo "error=$*"; exit 1; }

nginx_user() {
  local u
  u=$(awk '/^[[:space:]]*user[[:space:]]/ { gsub(/;/, "", $2); print $2; exit }' /etc/nginx/nginx.conf 2>/dev/null)
  echo "${u:-www-data}"
}

read_state() {
  STATE=pending; TRIAL_END=0
  if [ -f "$STATE_FILE" ]; then read -r STATE TRIAL_END < "$STATE_FILE" || true; fi
  STATE=${STATE:-pending}; TRIAL_END=${TRIAL_END:-0}
  [[ $TRIAL_END =~ ^[0-9]+$ ]] || TRIAL_END=0
  # Eski yöntem snippet'i artık koruma içermiyorsa kayıtlı 'legacy' geçersizdir (bant yeniden görünsün).
  if [ "$STATE" = legacy ] && ! legacy_active; then STATE=pending; fi
}
write_state() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  printf '%s %s\n' "$1" "${2:-0}" > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}

password_set() { [ -s "$HTPASSWD" ] && grep -q "^$USER_NAME:" "$HTPASSWD"; }
legacy_active() { [ -f "$LEGACY_SNIPPET" ] && grep -qE '^[[:space:]]*auth_basic[[:space:]]' "$LEGACY_SNIPPET"; }
conf_enabled() { grep -qE '^[[:space:]]*auth_basic[[:space:]]' "$CONF" 2>/dev/null; }
# Dosya birebir güncel koruma metni mi? (ensure eski sürümün metnini — ör. giriş sayfası muafiyeti olmayanı — yeniler.)
conf_current() { conf_enabled_text | cmp -s - "$CONF" 2>/dev/null; }

conf_enabled_text() {
  cat <<'EOF'
# Klyrix Gate panel koruması — scripts/panel-auth.sh yönetir, elle düzenlemeyin.
# Pi'nin kendisi (127.0.0.1, ::1: kiosk, OLED, yerel betikler) muaf; diğer herkes Basic Auth.
# Kurulum Wi-Fi'ının giriş sayfası (/portal.html) ve captive API'si (/api/captive) herkese şifresiz — yalnız normalize
# yol ($uri) VE istek satırındaki ham yol tam olarak bu ikisiyse: arka uca ham yol gider; kodlanmış ya da ../ içeren bir
# yol normalize edilince bu ikisine denk gelse de başka bir API ucuna şifresiz ulaşamasın.
geo $pi5_auth_geo {
    default "Klyrix Gate";
    127.0.0.0/8 off;
    ::1 off;
}
map $request_uri $pi5_auth_raw {
    default $pi5_auth_geo;
    ~^/portal\.html(\?|$) off;
    ~^/api/captive(\?|$) off;
}
map $uri $pi5_auth_realm {
    default $pi5_auth_geo;
    /portal.html $pi5_auth_raw;
    /api/captive $pi5_auth_raw;
}
auth_basic $pi5_auth_realm;
auth_basic_user_file /etc/nginx/pi5-gateway.htpasswd;
EOF
}
conf_disabled_text() {
  echo "# Klyrix Gate panel koruması KAPALI — scripts/panel-auth.sh yönetir (açmak: paneldeki üst bant)"
}

# htpasswd'yi satırlarla atomik yazar (sahip root:<nginx kullanıcısı>, 0640: işçi okuyabilsin, diğerleri okuyamasın).
write_htpasswd() {
  local tmp
  tmp=$(mktemp /etc/nginx/.pi5-htpasswd.XXXXXX) || return 1
  if [ $# -gt 0 ]; then printf '%s\n' "$@" > "$tmp"; else : > "$tmp"; fi
  chown root:"$(nginx_user)" "$tmp" 2>/dev/null || true
  chmod 640 "$tmp"
  mv -f "$tmp" "$HTPASSWD"
}
htpasswd_lines_without() { [ -f "$HTPASSWD" ] && grep -v "^$1:" "$HTPASSWD" || true; }

# nginx çalışmıyorsa (açılışta henüz başlamadıysa) yalnız sözdizimi denetlenir: dosya nginx açılınca geçerli olur.
nginx_reload() {
  nginx -t >/dev/null 2>&1 || return 1
  if systemctl is-active --quiet nginx 2>/dev/null; then systemctl reload nginx >/dev/null 2>&1 || return 1; fi
  return 0
}

# $1 = enabled | disabled.
# enabled: başarısızlıkta önceki dosya geri konur ve 1 döner.
# disabled: kapalı dosya (yalnız yorum) nginx -t'yi bozamaz → her durumda yerinde kalır. Yükleme başka bir yapılandırma
#   hatası ya da eşzamanlı yazım yüzünden olmazsa birkaç kez denenir; olmazsa uyarı verilir ve nginx'in bir sonraki
#   yüklemesinde/açılışında koruma kalkar (geri alma ve kurtarma "off" hiçbir zaman korumayı geri getirmez).
apply_conf() {
  local bak="" tmp i
  mkdir -p /etc/nginx/conf.d
  tmp=$(mktemp /etc/nginx/.pi5-auth-new.XXXXXX) || return 1
  if [ "$1" = disabled ]; then
    conf_disabled_text > "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" "$CONF"
    for i in 1 2 3; do nginx_reload && return 0; sleep 1; done
    echo "warning=nginx yeniden yüklenemedi (başka bir yapılandırma hatası: nginx -t) — koruma nginx'in bir sonraki yüklemesinde kalkar"
    return 0
  fi
  if [ -f "$CONF" ]; then bak=$(mktemp /etc/nginx/.pi5-auth-bak.XXXXXX) && cp -p "$CONF" "$bak"; fi
  conf_enabled_text > "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" "$CONF"
  if nginx_reload; then [ -n "$bak" ] && rm -f "$bak"; return 0; fi
  if [ -n "$bak" ]; then mv -f "$bak" "$CONF"; else conf_disabled_text > "$CONF"; chmod 644 "$CONF"; fi
  nginx_reload || true
  return 1
}

lan_ip() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'; }
http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$@" 2>/dev/null; }

# Koruma açıkken erişim testi: Pi'nin kendisi şifresiz (200), LAN şifresiz 401, LAN doğru şifreyle 200. Doğru şifre
# testi geçici bir sonda kullanıcısıyla yapılır (kullanıcının şifresi bilinmez) — dosya izni / özet biçimi / nginx
# okuma sorunları (500/403/sürekli 401) burada yakalanır. Reload eşzamansız olduğundan birkaç kez denenir.
# Giriş sayfası ve /api/captive LAN'dan şifresiz 401 OLMAMALI (200; dosya/arka uç henüz güncellenmemişse 404 de kabul).
verify_enabled() {
  local ip probe_pw probe_hash a c d p k i ok=1
  ip=$(lan_ip)
  [ -n "$ip" ] || { echo "detail=LAN IP bulunamadı"; return 1; }
  probe_pw=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  probe_hash=$(printf '%s' "$probe_pw" | openssl passwd -6 -stdin 2>/dev/null) || return 1
  mapfile -t keep < <(htpasswd_lines_without pi5probe)
  write_htpasswd "${keep[@]}" "pi5probe:$probe_hash" || return 1
  for i in 1 2 3 4 5 6 7 8 9 10; do
    a=$(http_code http://127.0.0.1/kiosk.html)
    c=$(http_code "http://$ip/")
    d=$(printf 'user = "pi5probe:%s"\n' "$probe_pw" | http_code -K - "http://$ip/")
    p=$(http_code "http://$ip/portal.html")
    k=$(http_code "http://$ip/api/captive")
    if [ "$a" = 200 ] && [ "$c" = 401 ] && [ "$d" = 200 ] && [ "$p" != 401 ] && [ "$k" != 401 ]; then ok=0; break; fi
    sleep 0.5
  done
  mapfile -t keep < <(htpasswd_lines_without pi5probe)
  write_htpasswd "${keep[@]}" || true
  [ "$ok" = 0 ] || echo "detail=erişim testi: yerel=$a LAN-şifresiz=$c LAN-şifreli=$d giriş-sayfası=$p captive=$k (beklenen 200/401/200, giriş sayfası ve captive 401 olmamalı)"
  return "$ok"
}

# on/confirm/off: zamanlayıcıyı ve (varsa) biten geri alma servisini temizler. Geri alma işi KENDİ servisinde çalışır —
# rollback bunu çağırmaz: kendi servisini durdurmak systemd'nin tüm cgroup'u (bu betik dahil) sonlandırmasına yol açardı.
stop_timer() {
  systemctl stop "$TIMER_UNIT.timer" "$TIMER_UNIT.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$TIMER_UNIT.timer" "$TIMER_UNIT.service" >/dev/null 2>&1 || true
}
timer_active() { systemctl is-active --quiet "$TIMER_UNIT.timer" 2>/dev/null; }

cmd_status() {
  read_state
  legacy_active && [ "$STATE" != on ] && [ "$STATE" != trial ] && STATE=legacy
  echo "state=$STATE"
  echo "trial_ends=$TRIAL_END"
  if password_set; then echo "password_set=1"; else echo "password_set=0"; fi
  echo "user=$USER_NAME"
  echo "now=$(date +%s)"
}

cmd_set_password() {
  local pw hash keep
  IFS= read -r pw || true
  pw=${pw%$'\r'}
  # LC_ALL=C: uzunluk BAYT sayısıdır (Türkçe harf 2 bayt). Karakter sınırını (12-128) panel denetler; burada bayt.
  [ ${#pw} -ge 12 ] || die "şifre en az 12 karakter olmalı"
  [ ${#pw} -le 512 ] || die "şifre çok uzun"
  legacy_active && die "koruma eski yöntemle (snippets/pi5-auth.conf) açılmış — panelden yönetilmiyor"
  command -v openssl >/dev/null 2>&1 || die "openssl kurulu değil"
  hash=$(printf '%s' "$pw" | openssl passwd -6 -stdin 2>/dev/null) || die "şifre özeti üretilemedi"
  [ -n "$hash" ] || die "şifre özeti üretilemedi"
  mapfile -t keep < <(htpasswd_lines_without "$USER_NAME" | grep -v '^pi5probe:' || true)
  write_htpasswd "${keep[@]}" "$USER_NAME:$hash" || die "şifre dosyası yazılamadı"
  read_state
  [ -f "$STATE_FILE" ] || write_state pending
  echo "ok=1"
}

cmd_on() {
  local trial=0 end
  if [ "${1:-}" = "--trial" ]; then trial=${2:-300}; fi
  [[ $trial =~ ^[0-9]+$ ]] || die "geçersiz deneme süresi"
  legacy_active && die "koruma eski yöntemle (snippets/pi5-auth.conf) açılmış — panelden yönetilmiyor"
  password_set || die "önce panel şifresini belirleyin"
  for bin in nginx curl openssl; do command -v "$bin" >/dev/null 2>&1 || die "$bin kurulu değil"; done
  stop_timer
  apply_conf enabled || die "nginx yeni yapılandırmayı kabul etmedi (nginx -t) — değişiklik geri alındı"
  if ! verify_enabled; then
    apply_conf disabled || true
    write_state pending
    die "erişim testi başarısız — koruma geri alındı"
  fi
  if [ "$trial" -gt 0 ]; then
    end=$(( $(date +%s) + trial ))
    write_state trial "$end"
    # Zamanlayıcı kurulamazsa deneme güvenli değildir → hemen geri al. Kilit tanımlayıcısı (9) devredilmez: geri alma
    # işi kilidi kendisi alır, miras kalan tanımlayıcı onu kendi kendine kilitlerdi.
    if ! systemd-run --quiet --collect --unit="$TIMER_UNIT" --on-active="$trial" --timer-property=AccuracySec=1s \
         /bin/bash "$SELF" rollback >/dev/null 2>&1 9>&-; then
      apply_conf disabled || true
      write_state pending
      die "geri alma zamanlayıcısı kurulamadı — koruma açılmadı"
    fi
    echo "trial_ends=$end"
  else
    write_state on
  fi
  echo "ok=1"
}

cmd_confirm() {
  read_state
  [ "$STATE" = trial ] || die "deneme sürmüyor (süre dolduysa koruma geri alınmıştır — yeniden açın)"
  stop_timer
  write_state on
  echo "ok=1"
}

# Zamanlayıcının kendisi de bunu çalıştırır: yalnız .timer durdurulur, servise dokunulmaz (bkz. stop_timer).
cmd_rollback() {
  read_state
  if [ "$STATE" = trial ]; then
    systemctl stop "$TIMER_UNIT.timer" >/dev/null 2>&1 || true
    apply_conf disabled
    write_state pending
    echo "rolled_back=1"
  fi
  echo "ok=1"
}

cmd_off() {
  legacy_active && die "koruma eski yöntemle (snippets/pi5-auth.conf) açılmış — o dosyayı düzenleyin"
  stop_timer
  apply_conf disabled
  write_state pending
  echo "ok=1"
}

cmd_reset() {
  local a b
  [ -t 0 ] || die "reset terminalde çalıştırılmalı (yeni şifre sorulur)"
  read -rsp "Yeni panel şifresi (en az 12 karakter): " a; echo
  read -rsp "Tekrar: " b; echo
  [ "$a" = "$b" ] || die "şifreler eşleşmedi"
  printf '%s\n' "$a" | cmd_set_password
}

cmd_ensure() {
  mkdir -p "$DIR" && chmod 700 "$DIR"
  # Yarıda kalmış bir erişim testinden kalan sonda kullanıcısı silinir.
  if [ -f "$HTPASSWD" ] && grep -q '^pi5probe:' "$HTPASSWD"; then
    mapfile -t keep < <(htpasswd_lines_without pi5probe)
    write_htpasswd "${keep[@]}" || true
  fi
  if legacy_active; then
    [ -f "$STATE_FILE" ] || write_state legacy
    echo "state=legacy"; return 0
  fi
  read_state
  # Kayıtlı 'legacy' ama snippet artık koruma içermiyor → pending'e döner.
  if [ -f "$STATE_FILE" ] && grep -q '^legacy' "$STATE_FILE"; then write_state pending; fi
  case "$STATE" in
    trial)
      # Süre dolduysa ya da geri alma zamanlayıcısı yoksa (Pi yeniden başladı: geçici zamanlayıcı /run'daydı; ya da
      # zamanlayıcı kurulamadan süreç öldü) deneme geri alınır — onaylayacak tarayıcı oturumu zaten yok.
      if [ "$TRIAL_END" -le "$(date +%s)" ] || ! timer_active; then cmd_rollback; fi ;;
    on)
      if ! password_set; then
        # Şifre özeti kaybolmuş: kimse giremez → koruma kapatılır (panel şifresiz açılır, bant yeniden sorar).
        apply_conf disabled || true
        write_state pending
        echo "warning=şifre dosyası yok — koruma kapatıldı"
      elif ! conf_current; then
        # Eksik, kapalı ya da eski sürümün metni → yeniden yazılır (nginx -t + reload); geçmezse önceki dosya geri konur.
        apply_conf enabled || echo "warning=koruma dosyası onarılamadı"
      fi ;;
    *)
      [ -f "$STATE_FILE" ] || write_state pending
      # Kapalı olması gereken koruma açık kalmışsa (yarım işlem) kapatılır; pending'den asla açılmaz.
      if conf_enabled; then apply_conf disabled || echo "warning=koruma dosyası kapatılamadı"; fi ;;
  esac
  if [ ! -f "$CONF" ]; then conf_disabled_text > "$CONF"; chmod 644 "$CONF"; fi
  echo "ok=1"
}

[ "$(id -u)" = 0 ] || die "root olarak çalıştırın (sudo)"
cmd=${1:-status}
shift || true
if [ "$cmd" = status ]; then cmd_status; exit 0; fi
exec 9>"$LOCK"
flock -w 30 9 || die "başka bir koruma işlemi sürüyor"
case "$cmd" in
  ensure) cmd_ensure ;;
  set-password) cmd_set_password ;;
  on) cmd_on "$@" ;;
  confirm) cmd_confirm ;;
  rollback) cmd_rollback ;;
  off) cmd_off ;;
  reset) cmd_reset ;;
  *) die "bilinmeyen komut: $cmd (ensure|status|set-password|on|confirm|rollback|off|reset)" ;;
esac

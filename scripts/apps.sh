#!/usr/bin/env bash
# Klyrix Gate — uygulama mağazası (G3.3): Podman konteyner uygulamaları (Home Assistant, Vaultwarden). Root olarak çalışır.
# Backend (backend/src/apps.ts) kural dosyasını ve uygulama birimlerini üretir; bu betik motoru kurar / kaldırır, ağı ve
# güvenlik duvarını yükler, imajı çeker, birimleri yönetir. Uzun işler pi5-backend'in DIŞINDA koşar:
#   systemd-run --unit=pi5-apps … /bin/bash apps.sh <komut>     (durum /run/pi5-apps/state KEY=VALUE, çıktı …/output)
#
# VARSAYILAN KAPALI: /etc/pi5-gateway/apps/state yoksa ensure / fw / jumps hiçbir şey yapmaz; paket kurulmaz.
#
# Komutlar:
#   status                     durum satırları (salt okunur)
#   enable --trial SN          (iş) Podman'ı kurar, yapılandırır, klx-apps ağını ve pi5_apps tablosunu açar; SN saniye
#                              içinde "confirm" gelmezse pi5-apps-rollback motoru kapatır (geri alma zamanlayıcısı
#                              değişiklikten ÖNCE kurulur)
#   confirm                    denemeyi kalıcı yapar (iş kilidi altında; süresi dolmuş deneme reddedilir)
#   rollback                   yalnız deneme sürüyorsa disable (zamanlayıcı / açılış); panele /run/pi5-apps/rolled_back
#   disable                    (iş) uygulamalar durur, birimler kenara alınır, ağ / tablolar / yapılandırma kaldırılır;
#                              veriler ve imajlar /mnt/klyrix-data/apps'ta kalır. Paket kaldırılmaz (daemon yok).
#   ensure                     post-update / açılış: açıksa yapılandırmayı, ağı, güvenlik duvarını ve birimleri onarır
#   fw                         backend'in ürettiği kural dosyasını sınar (nft -c) ve yükler + atlama zincirleri
#   jumps [remove]             politikası drop olan inet filter / inet pi5_filter'a izin zincirleri (pi5_apps_fwd/_in)
#   install ID [--disk-mb N] [--lan-ip IP]...   (iş) imajı çeker, (gerekirse) sertifika üretir, birimi kurar, sağlığı bekler
#   uninstall ID [--purge]     (iş) birimi ve imajı kaldırır; --purge: uygulama verileri de silinir
#   start [ID] / stop [ID]     kurulu uygulamayı (ID yoksa hepsini) başlatır / durdurur; yalnız motor açıkken, başlatma
#                              yalnız veri diski bağlıyken. Durdurma kalıcıdır (<id>.stopped: açılışta / onarımda başlamaz)
#
# Kurtarma (SSH):  sudo bash /opt/pi5-gateway/scripts/apps.sh disable
set -uo pipefail
export LC_ALL=C
SELF=$(readlink -f "$0")
SCRIPTS=$(dirname "$SELF")
CONF_DIR=/etc/pi5-gateway/apps
STATE_FILE=$CONF_DIR/state
NFT_STAGE=$CONF_DIR/pi5-apps.nft
NFT_FILE=/etc/nftables.d/pi5-apps.conf
QUADLET_DIR=/etc/containers/systemd
PARKED=$CONF_DIR/parked          # motor kapalıyken kurulu uygulamaların birimleri (yeniden açılınca geri gelir)
CC_FILE=/etc/containers/containers.conf.d/90-klyrix.conf
ST_FILE=/etc/containers/storage.conf
MARK='# klyrix-apps'
DATA=/mnt/klyrix-data
APPS_DATA=$DATA/apps
NET=klx-apps
SUBNET=198.18.64.0/24
GW=198.18.64.1
JOB_DIR=/run/pi5-apps
JSTATE=$JOB_DIR/state
OUT=$JOB_DIR/output
LOCK=/run/pi5-apps.lock
FW_LOCK=/run/pi5-apps-fw.lock
TIMER_UNIT=pi5-apps-rollback
PKGS=(podman ca-certificates)   # ca-certificates: kayıt defterine TLS (Podman'ın "önerilen"i; kurulu değilse)
ID_RE='^[a-z][a-z0-9]{1,23}$'

# ── yardımcılar ──────────────────────────────────────────────────────────────
JOB=0
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | { if [ "$JOB" = 1 ]; then tee -a "$OUT"; else cat; fi; } >&2; }
kv() { printf '%s=%s\n' "$1" "$2"; }
setstate() {
  [ "$JOB" = 1 ] || return 0
  local tmp="$JSTATE.tmp.$$" k v line kvp
  declare -A cur=()
  if [ -f "$JSTATE" ]; then
    while IFS= read -r line; do k=${line%%=*}; [ -n "$k" ] && [ "$k" != "$line" ] && cur[$k]=${line#*=}; done < "$JSTATE"
  fi
  for kvp in "$@"; do k=${kvp%%=*}; v=${kvp#*=}; cur[$k]=$v; done
  : > "$tmp"
  for k in "${!cur[@]}"; do printf '%s=%s\n' "$k" "${cur[$k]}" >> "$tmp"; done
  mv -f "$tmp" "$JSTATE"
}
step() { log "▶ $2"; setstate "pct=$1" "step=$2"; }
die() {
  log "HATA: $*"
  setstate state=failed "error=$*" "finished=$(date +%s)"
  kv error "$*"
  exit 1
}
done_ok() { setstate state=done "msg=$1" pct=100 "finished=$(date +%s)"; kv result ok; }
have() { command -v "$1" >/dev/null 2>&1; }
is_mountpoint() { findmnt -n --mountpoint "$1" >/dev/null 2>&1; }
state_get() { [ -f "$STATE_FILE" ] && sed -n "s/^$1=//p" "$STATE_FILE" | tail -1; }
state_put() { # stage trial_ends
  mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
  printf 'stage=%s\ntrial_ends=%s\n' "$1" "$2" > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}
enabled() { case "$(state_get stage)" in trial|on) return 0;; *) return 1;; esac; }
ours() { [ ! -e "$1" ] || grep -qF "$MARK" "$1" 2>/dev/null; }
app_ids() { local f; for f in "$QUADLET_DIR"/pi5-app-*.container; do [ -f "$f" ] || continue; f=${f##*/pi5-app-}; echo "${f%.container}"; done; }

# ── geri alma zamanlayıcısı ──────────────────────────────────────────────────
# Yalnız zamanlayıcı durdurulur: geri alma servisi (pi5-apps-rollback.service) bu betiği çalıştırırken kendini durdurmasın
# (servis durdurulursa disable yarıda kalırdı — g33 e2e'de yakalandı). Süren bir geri alma iş kilidiyle sıralanır.
stop_timer() {
  systemctl stop "$TIMER_UNIT.timer" >/dev/null 2>&1 || true
  systemctl reset-failed "$TIMER_UNIT.timer" "$TIMER_UNIT.service" >/dev/null 2>&1 || true
}
arm_timer() { # saniye
  stop_timer
  systemd-run --quiet --collect --unit="$TIMER_UNIT" --on-active="$1" --timer-property=AccuracySec=1s \
    /bin/bash "$SELF" rollback >/dev/null 2>&1 9>&-
}

# ── motor yapılandırması (yalnız dosya yoksa ya da bizimse yazılır) ─────────
write_conf() {
  ours "$CC_FILE" || { log "UYARI: $CC_FILE bize ait değil — yazılmadı"; return 1; }
  ours "$ST_FILE" || { log "UYARI: $ST_FILE bize ait değil — yazılmadı"; return 1; }
  mkdir -p "$(dirname "$CC_FILE")"
  # Depo klasörleri yalnız veri diski bağlıyken (bağlı değilken bağlama noktasının altı SD karttır)
  if is_mountpoint "$DATA"; then
    mkdir -p "$APPS_DATA/storage" "$APPS_DATA/tmp" && chmod 700 "$APPS_DATA" "$APPS_DATA/storage" "$APPS_DATA/tmp"
  fi
  # firewall_driver=none: netavark nft / iptables'a hiç kural yazmaz (nftables sürücüsü tüm iletime 'ct state invalid drop'
  # ekliyordu); NAT, port yayını ve yalıtım pi5_apps'te. default_subnet: yanlışlıkla ağsız çalıştırılan bir konteyner de
  # 10.88/16'yı (SD-WAN aralığı) değil uygulama aralığını alır (ve pi5_apps izinleri dışında kalır).
  # image_copy_tmp_dir: imaj indirilirken katmanlar önce buraya yazılır (varsayılanı /var/tmp — SD kart).
  printf '%s\n%s\n%s\n\n%s\n%s\n%s\n' "$MARK — backend/src/apps.ts (G3.3); apps.sh disable kaldırır" '[engine]' \
    "image_copy_tmp_dir = \"$APPS_DATA/tmp\"" '[network]' 'firewall_driver = "none"' 'default_subnet = "198.18.65.0/24"' \
    > "$CC_FILE.tmp" && mv -f "$CC_FILE.tmp" "$CC_FILE"
  # İmajlar ve konteyner katmanları NVMe veri diskinde (SD karta yazılmaz)
  printf '%s\n%s\n%s\n%s\n%s\n' "$MARK — apps.sh disable kaldırır" '[storage]' 'driver = "overlay"' \
    "graphroot = \"$APPS_DATA/storage\"" 'runroot = "/run/containers/storage"' > "$ST_FILE.tmp" && mv -f "$ST_FILE.tmp" "$ST_FILE"
}

net_ensure() {
  podman network exists "$NET" >/dev/null 2>&1 && return 0
  podman network create --interface-name "$NET" --subnet "$SUBNET" --gateway "$GW" --disable-dns "$NET" >/dev/null
}

# ── güvenlik duvarı ──────────────────────────────────────────────────────────
# Politikası drop olan tablolar (Debian inet filter, panelin inet pi5_filter'ı): izin zincirleri. Tablo/zincir yoksa ya da
# politika accept ise zincirlerimiz kaldırılır. Drop'lar pi5_apps'te (öncelik -8, kesin); buradakiler yalnız izin.
# Çağıran FW_LOCK'u tutar (cmd_fw, fw_remove, "jumps" girişi): aynı anda iki çağrı atlamayı iki kez eklemesin. Yine de
# yinelenmiş atlama (eski bir yarıştan) bulunursa fazlası silinir; kaldırırken hepsi silinir (yoksa zincir silinemez).
jumps() { # [remove]
  local t c own listing handles h script rc=0
  for t in filter pi5_filter; do
    for c in input forward; do
      listing=$(nft -a list chain inet "$t" "$c" 2>/dev/null) || continue
      own=pi5_apps_in; [ "$c" = forward ] && own=pi5_apps_fwd
      handles=$(printf '%s\n' "$listing" | sed -n "s/.*jump $own # handle \([0-9]*\).*/\1/p")
      script=""
      if [ "${1:-}" != remove ] && enabled && [[ $listing == *'policy drop;'* ]]; then
        script="add chain inet $t $own
flush chain inet $t $own
"
        if [ "$c" = forward ]; then
          script+="add rule inet $t $own iifname \"$NET\" ip saddr $SUBNET accept
add rule inet $t $own oifname \"$NET\" ip daddr $SUBNET ct state established,related accept
add rule inet $t $own oifname \"$NET\" ip daddr $SUBNET ct status dnat accept
"
        else
          script+="add rule inet $t $own iifname \"$NET\" ct state established,related accept
add rule inet $t $own iifname \"$NET\" ip saddr $SUBNET meta l4proto { tcp, udp } th dport 53 accept
"
        fi
        if [ -z "$handles" ]; then
          script+="insert rule inet $t $c jump $own
"
        else
          for h in $(printf '%s\n' "$handles" | tail -n +2); do script+="delete rule inet $t $c handle $h
"; done
        fi
      else
        for h in $handles; do script+="delete rule inet $t $c handle $h
"; done
        nft list chain inet "$t" "$own" >/dev/null 2>&1 && script+="delete chain inet $t $own
"
      fi
      if [ -n "$script" ]; then
        printf '%s' "$script" | nft -f - 2>&1 | sed 's/^/    /' >&2
        [ "${PIPESTATUS[1]}" = 0 ] || { log "UYARI: $t $c → $own uygulanamadı"; rc=1; }
      fi
    done
  done
  return $rc
}

cmd_fw() {
  enabled || { kv result off; return 0; }
  exec 8>"$FW_LOCK"
  flock -w 30 8 || die "güvenlik duvarı kilidi alınamadı"
  # Kilit beklenirken motor kapatıldıysa (do_disable: durum dosyası, tablo ve kural dosyası silindi) yeniden yüklenmez
  enabled || { exec 8>&-; kv result off; return 0; }
  [ -s "$NFT_STAGE" ] || die "kural dosyası yok ($NFT_STAGE) — panel yeniden üretir"
  local out
  out=$(nft -c -f "$NFT_STAGE" 2>&1) || die "pi5_apps sınamadan geçmedi: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
  out=$(nft -f "$NFT_STAGE" 2>&1) || die "pi5_apps yüklenemedi: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
  mkdir -p "$(dirname "$NFT_FILE")"
  install -m 0644 "$NFT_STAGE" "$NFT_FILE.tmp" && mv -f "$NFT_FILE.tmp" "$NFT_FILE"
  jumps || true
  exec 8>&-
  kv result ok
}

# Güvenlik duvarı kilidi altında (alt kabukta: kilit çıkınca bırakılır; süren bir "fw" / "jumps" bitince kaldırılır —
# 30 sn'de alınamazsa yine kaldırılır)
fw_remove() {
  (
    exec 8>"$FW_LOCK"
    flock -w 30 8 || log "UYARI: güvenlik duvarı kilidi alınamadı — yine de kaldırılıyor"
    printf 'table inet pi5_apps {}\ndelete table inet pi5_apps\n' | nft -f - >/dev/null 2>&1 || true
    rm -f "$NFT_FILE" "$NFT_FILE.tmp"
    jumps remove || true
  )
}

# Kullanıcının «Durdur» dediği uygulama (<id>.stopped) başlatılmaz (birimin ConditionPathExists'i de açılışta engeller)
start_apps() {
  local id
  is_mountpoint "$DATA" || { log "veri diski bağlı değil — uygulamalar başlatılmadı"; return 0; }
  for id in $(app_ids); do
    [ -e "$CONF_DIR/$id.stopped" ] && continue
    systemctl start --no-block "pi5-app-$id.service" >/dev/null 2>&1 || log "UYARI: pi5-app-$id başlatılamadı"
  done
}

# ── disable: her şey geri (veriler kalır) ───────────────────────────────────
do_disable() {
  local id f
  stop_timer
  for id in $(app_ids); do
    systemctl stop "pi5-app-$id.service" >/dev/null 2>&1 || true
    mkdir -p "$PARKED" && mv -f "$QUADLET_DIR/pi5-app-$id.container" "$PARKED/" 2>/dev/null || true
  done
  systemctl daemon-reload >/dev/null 2>&1 || true
  # Durdurulurken hata koduyla çıkan birim "failed" olarak listede kalmasın (birim dosyası artık yok)
  systemctl reset-failed 'pi5-app-*' >/dev/null 2>&1 || true
  # Podman yalnız veri diski bağlıyken çağrılır (deposu bağlama noktasının altında: bağlı değilken SD karta depo açardı);
  # bağlı değilken ağ tanımı (netavark, kök dosya sistemi) elle silinir
  if have podman && is_mountpoint "$DATA"; then
    for f in $(podman ps -a --format '{{.Names}}' 2>/dev/null | grep '^pi5-app-'); do podman rm -f -t 10 "$f" >/dev/null 2>&1 || true; done
    podman network rm -f "$NET" >/dev/null 2>&1 || true
  fi
  rm -f "/etc/containers/networks/$NET.json"
  ip link del "$NET" >/dev/null 2>&1 || true
  rm -f "$STATE_FILE"
  fw_remove
  ours "$CC_FILE" && rm -f "$CC_FILE"
  ours "$ST_FILE" && rm -f "$ST_FILE"
  rm -f "$NFT_STAGE"
  return 0
}

# ── enable ───────────────────────────────────────────────────────────────────
cmd_enable() {
  local trial=300 arch src pk tran f aptc prc
  while [ $# -gt 0 ]; do case "$1" in --trial) trial=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  [[ $trial =~ ^[0-9]+$ ]] && [ "$trial" -ge 60 ] && [ "$trial" -le 3600 ] || die "deneme süresi 60–3600 sn olmalı"
  enabled && die "uygulama motoru zaten açık"
  step 5 "Uygunluk denetleniyor"
  arch=$(dpkg --print-architecture 2>/dev/null)
  case "$arch" in arm64|amd64) ;; *) die "işlemci mimarisi desteklenmiyor: ${arch:-bilinmiyor}";; esac
  is_mountpoint "$DATA" || die "veri diski (klyrix-data) bağlı değil"
  src=$(findmnt -n -o SOURCE --mountpoint "$DATA" | sed 's/\[.*\]$//'); pk=$(lsblk -ndo PKNAME "$src" 2>/dev/null | head -1)
  tran=$(lsblk -ndo TRAN "/dev/$pk" 2>/dev/null | head -1)
  [ "$tran" = nvme ] || [ "${PI5_APPS_TEST:-0}" = 1 ] || die "veri diski NVMe değil: uygulamalar SD karta / USB diske kurulmaz"
  [ -s "$NFT_STAGE" ] || die "kural dosyası yok ($NFT_STAGE)"
  nft -c -f "$NFT_STAGE" >/dev/null 2>&1 || die "pi5_apps kuralları sınamadan geçmedi"
  ours "$CC_FILE" || die "$CC_FILE başka bir yapılandırmaya ait — dokunulmadı"
  ours "$ST_FILE" || die "$ST_FILE başka bir yapılandırmaya ait — dokunulmadı"
  rm -f "$JOB_DIR/rolled_back" "$JOB_DIR/rolled_back.noted"   # önceki denemenin geri alındı uyarısı

  # Geri alma zamanlayıcısı DEĞİŞİKLİKTEN ÖNCE: paket kurulumu uzun sürebilir (40 dk pay); motor açılınca denemeye kurulur.
  step 8 "Geri alma zamanlayıcısı kuruluyor"
  state_put trial $(( $(date +%s) + trial + 2400 ))
  arm_timer $(( trial + 2400 )) || { rm -f "$STATE_FILE"; die "geri alma zamanlayıcısı kurulamadı (systemd-run)"; }
  fail() { log "geri alınıyor: $1"; do_disable; die "$1"; }

  step 10 "Konteyner motoru (Podman) kuruluyor"
  if ! have podman; then
    # Önerilen paketler kurulmaz (buildah, criu + derleyici, dbus-user-session, uidmap, slirp4netns …): kök (rootful) Podman
    # + netavark yeter; dbus-user-session gibi oturum paketleri ağ geçidine (HDMI paneli kullanıcısı) taşınmasın.
    # pkg-ensure.sh ortak işçidir: ayar APT_CONFIG ile (ek yapılandırma dosyası) yalnız bu kuruluma verilir.
    # pkg-ensure.sh depoda adayı görünmeyen paketi atlar: paket listesi hiç yoksa (temizlenmiş) önce liste yenilenir
    if ! grep -Eq 'Candidate: [^(]' <<< "$(apt-cache policy podman 2>/dev/null)"; then
      log "paket listesi yenileniyor (podman adayı görünmüyor)"
      timeout 180 apt-get -q update < /dev/null >> "$OUT" 2>&1 || log "UYARI: apt-get update başarısız"
    fi
    if ! aptc=$(mktemp) || ! printf 'APT::Install-Recommends "false";\n' > "$aptc"; then fail "geçici apt ayarı yazılamadı"; fi
    APT_CONFIG=$aptc bash "$SCRIPTS/pkg-ensure.sh" "${PKGS[@]}" >> "$OUT" 2>&1; prc=$?
    rm -f "$aptc"
    # netavark paketi DHCP vekilini (macvlan ağlarında DHCP için) açılışta etkinleştirir: köprü ağında sabit adres
    # kullanıldığı için gerekmez — kapatılır, arka planda süreç / soket kalmaz (kurulum yarıda kalsa da). firewalld
    # yeniden yükleme birimi de (firewalld yok; güvenlik duvarı sürücüsü none). Paket güncellemesi kapatılanı yeniden açmaz.
    for f in netavark-dhcp-proxy.socket netavark-dhcp-proxy.service netavark-firewalld-reload.service; do
      systemctl disable --now "$f" >/dev/null 2>&1 || true
    done
    [ "$prc" = 0 ] || fail "Podman kurulamadı (ayrıntı günlükte)"
  fi
  have podman || fail "Podman kurulamadı"
  log "$(podman --version 2>/dev/null) · netavark $(dpkg-query -W -f='${Version}' netavark 2>/dev/null)"
  step 60 "Motor yapılandırması yazılıyor"
  write_conf || fail "motor yapılandırması yazılamadı"
  if [ -d "$PARKED" ]; then
    mkdir -p "$QUADLET_DIR"
    for f in "$PARKED"/pi5-app-*.container; do [ -f "$f" ] && mv -f "$f" "$QUADLET_DIR/"; done
  fi
  step 70 "Uygulama ağı (klx-apps 198.18.64.0/24) kuruluyor"
  net_ensure || fail "klx-apps ağı kurulamadı"
  step 80 "Güvenlik duvarı (pi5_apps) yükleniyor"
  ( JOB=0; cmd_fw ) >/dev/null || fail "pi5_apps yüklenemedi"
  step 90 "Kurulu uygulamalar başlatılıyor"
  systemctl daemon-reload >/dev/null 2>&1 || true
  start_apps
  state_put trial $(( $(date +%s) + trial ))
  arm_timer "$trial" || fail "geri alma zamanlayıcısı kurulamadı"
  done_ok "Uygulama motoru deneme kipinde açıldı — $((trial / 60)) dk içinde «Kalıcı yap» denmezse geri alınır"
}

# İş kilidi altında (giriş): süren geri alma bitmeden durum yazılmaz; süresi dolmuş deneme kalıcı yapılmaz (geri alma
# zamanlayıcısı tetiklenmiştir ya da tetiklenmek üzeredir)
cmd_confirm() {
  local ends
  [ "$(state_get stage)" = trial ] || { kv error "deneme sürmüyor"; exit 1; }
  ends=$(state_get trial_ends)
  [[ $ends =~ ^[0-9]+$ ]] && [ "$ends" -gt "$(date +%s)" ] || { kv error "deneme süresi doldu — motor geri alınıyor; yeniden etkinleştirin"; exit 1; }
  stop_timer
  state_put on 0
  kv result ok
}

cmd_rollback() {
  [ "$(state_get stage)" = trial ] || { kv result none; return 0; }
  log "deneme onaylanmadı — uygulama motoru kapatılıyor"
  do_disable
  logger -t pi5-apps "deneme süresi doldu: uygulama motoru geri alındı" 2>/dev/null || true
  # Panel işareti: sayfa uyarısı + zile bir kez olay (backend apps.ts noteRollback); yeni etkinleştirme / kapatma siler
  mkdir -p "$JOB_DIR" && chmod 700 "$JOB_DIR" && printf 'at=%s\n' "$(date +%s)" > "$JOB_DIR/rolled_back"
  kv result rolled_back
}

cmd_disable() {
  step 20 "Uygulamalar durduruluyor"
  rm -f "$JOB_DIR/rolled_back" "$JOB_DIR/rolled_back.noted"
  do_disable
  done_ok "Uygulama motoru kapatıldı — uygulama verileri $APPS_DATA'ta duruyor"
}

# ── ensure (post-update / açılış) ─────────────────────────────────────────────
cmd_ensure() {
  [ -f "$STATE_FILE" ] || return 0     # kapalı: hiçbir şey yapılmaz
  local stage ends now
  stage=$(state_get stage); ends=$(state_get trial_ends); now=$(date +%s)
  if [ "$stage" = trial ]; then
    [[ $ends =~ ^[0-9]+$ ]] || ends=0
    if [ "$ends" -le "$now" ]; then cmd_rollback >/dev/null; log "[uygulamalar] süresi geçen deneme geri alındı"; return 0; fi
    systemctl is-active --quiet "$TIMER_UNIT.timer" 2>/dev/null || arm_timer $(( ends - now ))
  fi
  enabled || return 0
  have podman || { log "[uygulamalar] UYARI: podman yok — motor yeniden etkinleştirilmeli"; return 1; }
  # Veri diski bağlı değilken (açılışta gelmedi) motor yapılandırması ve ağ atlanır: podman deposu bağlama noktasının
  # altındadır, SD karta yazılmaz. Güvenlik duvarı yine yüklenir; uygulamalar başlatılmaz (start_apps).
  if is_mountpoint "$DATA"; then
    write_conf || return 1
    net_ensure || log "[uygulamalar] UYARI: klx-apps ağı kurulamadı"
  else
    log "[uygulamalar] veri diski bağlı değil — motor yapılandırması ve uygulama ağı atlandı"
  fi
  [ -s "$NFT_STAGE" ] && { ( cmd_fw ) >/dev/null || log "[uygulamalar] UYARI: pi5_apps yüklenemedi"; }
  systemctl daemon-reload >/dev/null 2>&1 || true
  start_apps
}

# ── install / uninstall ───────────────────────────────────────────────────────
tls_cert() { # dizin ip...
  local dir=$1 san="DNS:klyrix.local" ip
  shift
  [ -s "$dir/cert.pem" ] && [ -s "$dir/key.pem" ] && { log "sertifika mevcut — yeniden kullanılıyor"; return 0; }
  have openssl || { bash "$SCRIPTS/pkg-ensure.sh" openssl >> "$OUT" 2>&1 || return 1; }
  for ip in "$@"; do san+=",IP:$ip"; done
  mkdir -p "$dir" && chmod 700 "$dir"
  ( umask 077
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=Klyrix Gate Vaultwarden" \
      -addext "subjectAltName=$san" -keyout "$dir/key.pem" -out "$dir/cert.pem" >/dev/null 2>&1 ) || return 1
  chmod 600 "$dir/key.pem"; chmod 644 "$dir/cert.pem"
  log "yerel sertifika üretildi ($san)"
}

cmd_install() {
  local id=${1:-} disk_mb=0 ips=() stage_q img vol host before used pid pct i
  shift || true
  [[ $id =~ $ID_RE ]] || die "geçersiz uygulama kimliği"
  while [ $# -gt 0 ]; do case "$1" in
    --disk-mb) disk_mb=$2; shift 2;;
    --lan-ip) [[ $2 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && ips+=("$2"); shift 2;;
    *) die "bilinmeyen seçenek: $1";; esac; done
  [[ $disk_mb =~ ^[0-9]+$ ]] || disk_mb=0
  enabled || die "uygulama motoru kapalı"
  have podman || die "podman yok — motoru yeniden etkinleştirin"
  is_mountpoint "$DATA" || die "veri diski (klyrix-data) bağlı değil"
  stage_q=$CONF_DIR/pi5-app-$id.container
  [ -s "$stage_q" ] || die "uygulama birimi hazırlanmamış ($stage_q)"
  img=$(sed -n 's/^Image=//p' "$stage_q" | head -1)
  [[ $img =~ ^[a-z0-9.:/_-]+@sha256:[0-9a-f]{64}$ ]] || die "imaj dijestle sabitlenmemiş: $img"
  step 5 "Klasörler hazırlanıyor"
  mkdir -p "$APPS_DATA/$id" && chmod 700 "$APPS_DATA/$id"
  while IFS= read -r vol; do
    host=${vol%%:*}
    case "$host" in "$APPS_DATA/$id/"*) mkdir -p "$host";; *) die "hacim uygulama klasörü dışında: $host";; esac
  done < <(sed -n 's/^Volume=//p' "$stage_q")
  if grep -qx '# klyrix-tls' "$stage_q"; then
    step 8 "Yerel HTTPS sertifikası üretiliyor"
    tls_cert "$APPS_DATA/$id/data/tls" "${ips[@]}" || die "sertifika üretilemedi (openssl)"
  fi
  step 10 "İmaj indiriliyor"
  # Motor yapılandırması (depo veri diskinde, indirme ara klasörü) her kurulumda yeniden yazılır: eksikse podman varsayılan
  # depoyu (/var/lib/containers — SD kart) kullanırdı
  write_conf || die "motor yapılandırması yazılamadı"
  # İndirme ara klasörü (containers.conf image_copy_tmp_dir): yarıda kesilmiş eski indirmeden kalanlar silinir (iş kilidi
  # altında — aynı anda başka indirme yok)
  mkdir -p "$APPS_DATA/tmp" && chmod 700 "$APPS_DATA/tmp"
  find "$APPS_DATA/tmp" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system {} + 2>/dev/null || true
  before=$(df --output=used -B1M "$DATA" 2>/dev/null | tail -1 | tr -d ' ')
  podman pull "$img" >> "$OUT" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 3
    used=$(df --output=used -B1M "$DATA" 2>/dev/null | tail -1 | tr -d ' ')
    if [ "$disk_mb" -gt 0 ] && [[ $used =~ ^[0-9]+$ ]] && [[ $before =~ ^[0-9]+$ ]]; then
      pct=$(( 10 + (used - before) * 75 / disk_mb )); [ "$pct" -gt 85 ] && pct=85; [ "$pct" -lt 10 ] && pct=10
      setstate "pct=$pct" "step=İmaj indiriliyor (~$(( used - before )) / $disk_mb MB)"
    fi
  done
  wait "$pid" || die "imaj indirilemedi (ayrıntı günlükte)"
  step 88 "Uygulama başlatılıyor"
  mkdir -p "$QUADLET_DIR"
  install -m 0644 "$stage_q" "$QUADLET_DIR/pi5-app-$id.container.tmp" && mv -f "$QUADLET_DIR/pi5-app-$id.container.tmp" "$QUADLET_DIR/pi5-app-$id.container"
  rm -f "$PARKED/pi5-app-$id.container" "$CONF_DIR/$id.stopped"
  systemctl daemon-reload || die "systemd yeniden yüklenemedi"
  systemctl restart "pi5-app-$id.service" >> "$OUT" 2>&1 || die "uygulama başlatılamadı: $(journalctl -u "pi5-app-$id" -n 3 --no-pager -q 2>/dev/null | tr '\n' ' ' | cut -c1-200)"
  step 92 "Sağlık denetleniyor (ilk açılış birkaç dakika sürebilir)"
  local ip port
  ip=$(sed -n 's/^IP=//p' "$stage_q" | head -1)
  port=$(sed -n 's/^# klyrix-port //p' "$stage_q" | head -1)
  # Port dinlenene kadar (en çok ~6 dk; Home Assistant'ın ilk açılışı uzun sürer). Dinlenmezse iş yine başarılı sayılır:
  # birim çalışıyor, panel sağlığı ayrıca gösterir.
  for i in $(seq 1 120); do
    if ! systemctl is-active --quiet "pi5-app-$id.service"; then
      [ "$i" -gt 10 ] && die "uygulama durdu: $(journalctl -u "pi5-app-$id" -n 3 --no-pager -q 2>/dev/null | tr '\n' ' ' | cut -c1-200)"
    elif [[ $ip =~ ^[0-9.]+$ ]] && [[ $port =~ ^[0-9]+$ ]] && timeout 2 bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null; then
      log "uygulama yanıt veriyor ($ip:$port)"; break
    fi
    sleep 3
  done
  done_ok "Uygulama kuruldu: $id"
}

cmd_uninstall() {
  local id=${1:-} purge=0 img
  shift || true
  [[ $id =~ $ID_RE ]] || die "geçersiz uygulama kimliği"
  while [ $# -gt 0 ]; do case "$1" in --purge) purge=1; shift;; *) die "bilinmeyen seçenek: $1";; esac; done
  # Veri diski bağlı değilken veriler silinemez (bağlama noktası SD karttaki boş klasör): hiçbir şeye dokunulmadan reddedilir
  if [ "$purge" = 1 ] && ! is_mountpoint "$DATA"; then die "veri diski (klyrix-data) bağlı değil — veriler silinemedi; disk bağlanınca yeniden deneyin"; fi
  step 20 "Uygulama durduruluyor"
  img=$(sed -n 's/^Image=//p' "$QUADLET_DIR/pi5-app-$id.container" "$PARKED/pi5-app-$id.container" "$CONF_DIR/pi5-app-$id.container" 2>/dev/null | head -1)
  systemctl stop "pi5-app-$id.service" >/dev/null 2>&1 || true
  rm -f "$QUADLET_DIR/pi5-app-$id.container" "$PARKED/pi5-app-$id.container" "$CONF_DIR/$id.stopped"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed "pi5-app-$id.service" >/dev/null 2>&1 || true
  # Motor kapalıyken storage.conf yoktur: podman'ın varsayılan deposu (/var/lib/containers — SD kart) açılmasın diye depo
  # açıkça veri diskindeki verilir; veri diski bağlı değilse imaj silinmez (diskte kalır)
  if have podman && is_mountpoint "$DATA"; then
    local pm=(podman --root "$APPS_DATA/storage" --runroot /run/containers/storage --storage-driver overlay)
    "${pm[@]}" rm -f -t 10 "pi5-app-$id" >/dev/null 2>&1 || true
    step 50 "İmaj kaldırılıyor"
    [ -n "$img" ] && { "${pm[@]}" rmi "$img" >/dev/null 2>&1 || log "imaj kaldırılamadı (başka bir yerde kullanılıyor olabilir)"; }
  fi
  if [ "$purge" = 1 ]; then
    step 70 "Uygulama verileri siliniyor"
    case "$APPS_DATA/$id" in "$APPS_DATA/"[a-z]*) rm -rf --one-file-system "${APPS_DATA:?}/$id";; esac
    rm -f "$CONF_DIR/$id.env" "$CONF_DIR/$id.conf" "$CONF_DIR/pi5-app-$id.container"
  fi
  done_ok "Uygulama kaldırıldı: $id$([ "$purge" = 1 ] && echo ' (veriler silindi)' || echo " (veriler $APPS_DATA/$id'de duruyor)")"
}

cmd_startstop() { # start|stop [ID]
  local op=$1 id=${2:-} ids u rc=0
  enabled || { kv error "uygulama motoru kapalı"; return 1; }
  if [ -n "$id" ]; then
    [[ $id =~ $ID_RE ]] && [ -f "$QUADLET_DIR/pi5-app-$id.container" ] || { kv error "uygulama kurulu değil: $id"; return 1; }
    ids=$id
  else
    ids=$(app_ids)
  fi
  if [ "$op" = start ]; then
    is_mountpoint "$DATA" || { kv error "veri diski (klyrix-data) bağlı değil"; return 1; }
    nft list table inet pi5_apps >/dev/null 2>&1 || { kv error "güvenlik duvarı (pi5_apps) yüklü değil — panel yeniden kurar"; return 1; }
  fi
  for u in $ids; do
    # «Durdur» kalıcıdır: bayrak açılışta (ConditionPathExists), onarımda (ensure) ve panel yeniden açılınca başlatmayı
    # engeller; «Başlat» siler (önce: koşul başlatmayı engellemesin)
    if [ "$op" = stop ]; then : > "$CONF_DIR/$u.stopped"; else rm -f "$CONF_DIR/$u.stopped"; fi
    systemctl "$op" "pi5-app-$u.service" >/dev/null 2>&1 || {
      kv error "pi5-app-$u: $(journalctl -u "pi5-app-$u" -n 2 --no-pager -q 2>/dev/null | tr '\n' ' ' | cut -c1-200)"; rc=1; }
    # İstenen durdurma: süre içinde kapanmayıp öldürülen konteyner (çıkış 137) birimi "failed" bırakır — panel "Hata" değil
    # "Durduruldu" göstersin
    [ "$op" = stop ] && { systemctl reset-failed "pi5-app-$u.service" >/dev/null 2>&1 || true; }
  done
  [ "$rc" = 0 ] && kv result ok
  return $rc
}

cmd_status() {
  kv stage "$(state_get stage || true)"
  kv podman "$(have podman && podman --version 2>/dev/null | awk '{print $3}')"
  kv table "$(nft list table inet pi5_apps >/dev/null 2>&1 && echo yes || echo no)"
  kv apps "$(app_ids | tr '\n' ' ')"
}

# ── giriş ────────────────────────────────────────────────────────────────────
cmd=${1:-status}; shift || true
case "$cmd" in
  status) cmd_status; exit 0;;
  enable|confirm|rollback|disable|ensure|fw|jumps|install|uninstall|start|stop) ;;
  *) echo "kullanım: apps.sh status|enable|confirm|rollback|disable|ensure|fw|jumps|install|uninstall|start|stop" >&2; exit 2;;
esac
[ "$(id -u)" = 0 ] || { echo "root gerekli" >&2; exit 1; }
# Kapalıyken (durum dosyası yok) ensure / rollback hiçbir şey yazmaz (kilit ve /run dizini dahil)
case "$cmd" in ensure|rollback) [ -f "$STATE_FILE" ] || exit 0;; esac
case "$cmd" in
  fw) cmd_fw; exit $?;;
  # pi5-gw-restore çağırır: süren "fw" / kapatma ile aynı kilit (kapalıyken kilit dosyası da yazılmaz — kalıntı kaldırılır)
  jumps)
    if enabled; then exec 8>"$FW_LOCK"; flock -w 30 8 || { kv error "güvenlik duvarı kilidi alınamadı"; exit 1; }; fi
    jumps "${1:-}"; exit $?;;
  start|stop) cmd_startstop "$cmd" "${1:-}"; exit $?;;
esac
# İşler ve durum değiştiren komutlar tek kilit altında (geri alma zamanlayıcısı süren işi bekler; «Kalıcı yap» süren bir
# geri almayla yarışmaz — kısa bekler, sonra deneme durumunu kilit altında yeniden okur)
mkdir -p "$JOB_DIR" && chmod 700 "$JOB_DIR"
exec 9>"$LOCK"
case "$cmd" in rollback) lockw=900;; confirm) lockw=10;; *) lockw=0;; esac
if ! flock -w "$lockw" 9; then
  if [ -n "${PI5_APPS_ID:-}" ] && grep -qx "id=$PI5_APPS_ID" "$JSTATE" 2>/dev/null; then JOB=1; die "başka bir uygulama işi sürüyor"; fi
  kv error "başka bir uygulama işi sürüyor"; exit 1
fi
case "$cmd" in
  enable|disable|install|uninstall)
    JOB=1
    [ -n "${PI5_APPS_ID:-}" ] || : > "$OUT"
    trap 'die "iş durduruldu (süre sınırı ya da systemctl stop)"' TERM
    setstate state=running "cmd=$cmd" "started=$(date +%s)" "id=${PI5_APPS_ID:-$(date +%s)}" error= msg= step= pct=0 finished=
    ;;
esac
case "$cmd" in
  enable) cmd_enable "$@";;
  confirm) cmd_confirm;;
  disable) cmd_disable;;
  rollback) cmd_rollback;;
  ensure) cmd_ensure;;
  install) cmd_install "$@";;
  uninstall) cmd_uninstall "$@";;
esac

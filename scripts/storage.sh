#!/usr/bin/env bash
# Klyrix Gate — depolama (veri diski). Root olarak çalışır; değiştiren komutlar aynı anda tek (flock).
# İşletim sistemi SD kartta kalır; ek disk varsa panel verileri, Pi-hole sorgu veritabanı ve günlükler diske alınır.
# Disk ETİKETLE tanınır (bölüm sırasıyla değil): LABEL=klyrix-data (sistem verileri), LABEL=klyrix-share (ağ paylaşımı).
#
# Disk varken yerleşim (hepsi fstab'da UUID + nofail: disk yoksa ya da bozuksa açılış takılmaz, SD'deki kopya kullanılır):
#   /mnt/klyrix-data          ← klyrix-data bölümü
#   /mnt/klyrix-share         ← klyrix-share bölümü (varsa)
#   /opt/pi5-gateway/core     ← bind: /mnt/klyrix-data/pi5-data   (altındaki SD kopyası taşıma anındaki anlık görüntü)
#   /var/lib/klyrix/pihole    ← bind: /mnt/klyrix-data/pihole     (Pi-hole files.database buradaki pihole-FTL.db)
#   /var/log                  ← bind: /mnt/klyrix-data/log
#
# Komutlar:
#   status                                  durum satırları (kilitsiz, salt okunur)
#   archive --src BÖLÜM [--dest DİZİN]      eski bir sistem bölümünü salt okunur bağlayıp /home /root /opt /etc /srv
#                                           klasörlerini SD karta kopyalar (varsayılan: /home/<kullanıcı>/eski-sistem-arsivi-TARİH)
#   prepare --disk DİSK --system-gb N [--no-share] --confirm MODEL
#                                           DİSKİ SİLER: GPT, klyrix-data (N GB) + klyrix-share (geri kalan) ya da tek bölüm;
#                                           önce diskte duran panel verileri / Pi-hole veritabanı / günlükler SD'ye alınır,
#                                           sonra yeni diske taşınır. MODEL = diskin model adı (yoksa GB cinsinden boyutu)
#   migrate                                 klyrix-data bağlıyken verileri (panel, Pi-hole, günlükler) diske taşır
#   ensure                                  açılış / güncelleme: klyrix-data varsa fstab ve bağlamaları onarır (veri taşımaz)
#   auto [--force]                          kurulum: TAMAMEN BOŞ bir NVMe varsa hazırlar (≥128 GB: 64 GB + paylaşım, küçükse
#                                           tek bölüm); --force (eski PI5_FORMAT_SSD=1): bölümü olan NVMe'yi de siler
# İş komutları (archive / prepare / migrate) ilerlemeyi /run/pi5-storage/state'e yazar; panel oradan izler. Panel servisi
# iş sırasında durdurulur: iş systemd-run ile panelin DIŞINDA koşar (backend storage.ts).
set -uo pipefail
export LC_ALL=C

BASE=${PI5_BASE:-/opt/pi5-gateway}
CORE=$BASE/core
DATA_LABEL=klyrix-data
SHARE_LABEL=klyrix-share
DATA_MNT=/mnt/klyrix-data
SHARE_MNT=/mnt/klyrix-share
PH_DIR=/var/lib/klyrix/pihole
LEGACY_MNT=/mnt/ssd
FSTAB=${PI5_FSTAB:-/etc/fstab}
MARK='# klyrix-storage'
STATE_DIR=/run/pi5-storage
STATE=$STATE_DIR/state
OUT=$STATE_DIR/output
LOCK=/run/pi5-storage.lock
BACKEND=pi5-backend
FTL=pihole-FTL
SYNC_UNIT=klyrix-sync   # cihaz yedekleme (sync.sh): paylaşım bölümüne ve USB disklere yazar

mkdir -p "$STATE_DIR"

# ── yardımcılar ──────────────────────────────────────────────────────────────
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$OUT" >&2; }
kv() { printf '%s=%s\n' "$1" "$2"; }
JOB=0
# İş durumu: state=running|done|failed, step, pct (0-100), msg, error, cmd, started, finished
setstate() {
  [ "$JOB" = 1 ] || return 0
  local tmp="$STATE.tmp.$$" k v line
  declare -A cur=()
  if [ -f "$STATE" ]; then
    while IFS= read -r line; do k=${line%%=*}; [ -n "$k" ] && [ "$k" != "$line" ] && cur[$k]=${line#*=}; done < "$STATE"
  fi
  for kvp in "$@"; do k=${kvp%%=*}; v=${kvp#*=}; cur[$k]=$v; done
  : > "$tmp"
  for k in "${!cur[@]}"; do printf '%s=%s\n' "$k" "${cur[$k]}" >> "$tmp"; done
  mv -f "$tmp" "$STATE"
}
step() { log "▶ $2"; setstate "pct=$1" "step=$2"; }
die() {
  log "HATA: $*"
  setstate state=failed "error=$*" "finished=$(date +%s)"
  kv error "$*"
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
CLEANUP=()
finish() {
  local c; for c in "${CLEANUP[@]}"; do eval "$c" 2>/dev/null || true; done
  # İş yarıda kalsa da DNS ve (bu işin durdurduğu) panel geri gelsin
  if [ "$JOB" = 1 ]; then
    systemctl start "$FTL" >/dev/null 2>&1 || true
    [ "$BACKEND_WAS" = 1 ] && { systemctl start "$BACKEND" >/dev/null 2>&1 || true; }
  fi
  # Disk ayrılırken durdurulan cihaz yedekleme (iş ya da kısa komut — share.sh usb-remove — yarıda kalsa da) geri gelsin
  [ "$SYNC_WAS" = 1 ] && { systemctl start "$SYNC_UNIT" >/dev/null 2>&1 || true; }
  # Bu işin durdurduğu uygulamalar (apps_stop) geri gelsin; veri diski bağlı değilse birim kendisi bekler (RequiresMountsFor)
  local a; for a in "${APPS_WAS[@]}"; do systemctl start --no-block "$a" >/dev/null 2>&1 || true; done
  return 0
}
svc_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
svc() { systemctl "$@" >/dev/null 2>&1 || true; }

root_disk() {
  local src; src=$(findmnt -n -o SOURCE / 2>/dev/null | sed 's/\[.*\]$//')
  [ -b "$src" ] && lsblk -ndo PKNAME "$src" 2>/dev/null | head -1
}
parts_of() { lsblk -lnpo NAME,TYPE "$1" 2>/dev/null | awk '$2=="part"{print $1}'; }
dev_of_label() { blkid -c /dev/null -L "$1" 2>/dev/null | head -1; }
disk_of_part() { lsblk -ndo PKNAME "$1" 2>/dev/null | head -1; }
uuid_of() { [ -n "$1" ] && blkid -c /dev/null -s UUID -o value "$1" 2>/dev/null; }
mounted_at() { findmnt -n -o SOURCE --target "$1" 2>/dev/null | head -1 | sed 's/\[.*\]$//'; }
is_mountpoint() { findmnt -n --mountpoint "$1" >/dev/null 2>&1; }
# Bind kaynağının (ör. /dev/nvme0n1p1[/pi5-data]) aygıtı
bind_dev() { findmnt -n -o SOURCE --mountpoint "$1" 2>/dev/null | head -1 | sed 's/\[.*\]$//'; }

# Kopyalama: rsync varsa (silinenleri de eşitler), yoksa cp -a. Hedef dizin oluşturulur.
copy_tree() { # KAYNAK_DİZİN HEDEF_DİZİN
  mkdir -p "$2"
  if have rsync; then rsync -aHAX --delete "$1/" "$2/"; else cp -a "$1/." "$2/"; fi
}

# ── fstab: yalnız işaretli (MARK) satırlar yönetilir; yazmadan önce yedek + findmnt --verify ─────────────────
fstab_rewrite() { # stdin: yeni fstab
  local tmp="$FSTAB.klyrix.$$"
  cat > "$tmp"
  # Özet satırı "N parse errors, ...": yalnız ayrıştırma hatası varsa dur (erişilemeyen nofail kaynakları hata sayılmaz)
  if have findmnt && findmnt --verify --tab-file "$tmp" 2>&1 | grep -Eq '^[1-9][0-9]* parse error'; then
    rm -f "$tmp"; return 1
  fi
  [ -f "$FSTAB.klyrix-orig" ] || cp -a "$FSTAB" "$FSTAB.klyrix-orig" 2>/dev/null || true
  cp -a "$FSTAB" "$FSTAB.klyrix-prev" 2>/dev/null || true
  cat "$tmp" > "$FSTAB" && rm -f "$tmp"   # cat >: fstab bind mount / sembolik bağlantı olsa da yerinde yazılır
  svc daemon-reload
}
fstab_drop_managed() { grep -v -- "$MARK" "$FSTAB" 2>/dev/null || true; }
fstab_line_data()  { printf 'UUID=%s %s ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2 %s\n' "$1" "$DATA_MNT" "$MARK"; }
fstab_line_share() { printf 'UUID=%s %s ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2 %s\n' "$1" "$SHARE_MNT" "$MARK"; }
fstab_line_bind()  { # KAYNAK HEDEF [ek seçenek]
  printf '%s %s none bind,nofail,x-systemd.requires-mounts-for=%s%s 0 0 %s\n' "$1" "$2" "$DATA_MNT" "${3:+,$3}" "$MARK"
}
# İşaretli satırları baştan üretir: veri + paylaşım bölümü, işaret dosyasına göre bind'lar.
fstab_apply() {
  local du su
  du=$(uuid_of "$(dev_of_label "$DATA_LABEL")"); su=$(uuid_of "$(dev_of_label "$SHARE_LABEL")")
  {
    fstab_drop_managed
    [ -n "$du" ] && fstab_line_data "$du"
    [ -n "$su" ] && fstab_line_share "$su"
    if [ -n "$du" ]; then
      marker_has core && fstab_line_bind "$DATA_MNT/pi5-data" "$CORE" "x-systemd.before=$BACKEND.service"
      marker_has pihole && fstab_line_bind "$DATA_MNT/pihole" "$PH_DIR" "x-systemd.before=$FTL.service"
      marker_has log && fstab_line_bind "$DATA_MNT/log" /var/log
    fi
    :  # pipefail: son koşulun "yanlış" sonucu boru hattını başarısız saymasın
  } | fstab_rewrite || die "fstab doğrulanamadı; değişiklik yazılmadı"
}
# Silinecek diskin bölümlerine işaret eden eski (işaretsiz) satırlar: UUID / aygıt adı / /mnt/ssd
fstab_drop_disk() { # DİSK
  local p u pat='^klyrix-eslesmez$'
  for p in $(parts_of "$1"); do
    u=$(uuid_of "$p"); [ -n "$u" ] && pat="$pat|UUID=$u|$p "
    pat="$pat|^$p[[:space:]]"
  done
  grep -Ev "$pat" "$FSTAB" | fstab_rewrite || die "fstab doğrulanamadı; değişiklik yazılmadı"
}

# Veri bölümündeki işaret dosyası: hangi veriler diske taşındı (ensure bind'ları buna göre kurar)
MARKER() { printf '%s/.klyrix-storage' "$DATA_MNT"; }
marker_has() { [ -f "$(MARKER)" ] && grep -qx "$1=1" "$(MARKER)"; }
marker_set() { touch "$(MARKER)"; grep -vx "$1=.*" "$(MARKER)" > "$(MARKER).tmp" 2>/dev/null || true; echo "$1=1" >> "$(MARKER).tmp"; mv -f "$(MARKER).tmp" "$(MARKER)"; }

ftl_db() { have "$FTL" && "$FTL" --config files.database 2>/dev/null | tail -1 | tr -d '"' ; }
dns_ok() { # FTL gerçekten yanıt veriyor mu (en çok ~60 sn)
  local i
  for i in $(seq 1 30); do
    if have dig; then dig +time=1 +tries=1 +short localhost @127.0.0.1 >/dev/null 2>&1 && return 0
    else svc_active "$FTL" && return 0; fi
    sleep 2
  done
  return 1
}

# ── status ───────────────────────────────────────────────────────────────────
cmd_status() {
  local dd sd
  dd=$(dev_of_label "$DATA_LABEL"); sd=$(dev_of_label "$SHARE_LABEL")
  kv data_dev "$dd"; kv share_dev "$sd"
  kv data_mounted "$(is_mountpoint "$DATA_MNT" && echo 1 || echo 0)"
  kv share_mounted "$(is_mountpoint "$SHARE_MNT" && echo 1 || echo 0)"
  kv core_bind "$(is_mountpoint "$CORE" && echo 1 || echo 0)"
  kv core_link "$( [ -L "$CORE" ] && readlink "$CORE")"
  kv pihole_db "$(ftl_db)"
  kv log_bind "$(is_mountpoint /var/log && echo 1 || echo 0)"
  kv legacy_ssd "$(is_mountpoint "$LEGACY_MNT" && echo 1 || echo 0)"
  kv root_disk "$(root_disk)"
  local a; for a in /home/*/eski-sistem-arsivi-*; do [ -d "$a" ] && kv archive "$a"; done
  if [ -f "$STATE" ]; then sed 's/^/job_/' "$STATE"; fi
}

# ── archive ─────────────────────────────────────────────────────────────────
cmd_archive() {
  local src='' dest=''
  while [ $# -gt 0 ]; do case "$1" in --src) src=$2; shift 2;; --dest) dest=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  [ -b "$src" ] || die "bölüm bulunamadı: $src"
  [ "$(lsblk -ndo TYPE "$src")" = part ] || die "$src bir bölüm değil"
  local rd; rd=$(root_disk)
  [ -n "$rd" ] && [ "$(disk_of_part "$src")" = "$rd" ] && die "$src sistem diskinde; arşivlenecek bölüm başka bir diskte olmalı"
  findmnt -n --source "$src" >/dev/null 2>&1 && die "$src şu an bağlı; önce ayrılmalı"
  local user; user=$(getent passwd 1000 | cut -d: -f1); user=${user:-admin}
  [ -n "$dest" ] || dest="/home/$user/eski-sistem-arsivi-$(date +%Y%m%d-%H%M)"
  case "$dest" in /home/*|/root/*|/srv/*) ;; *) die "arşiv hedefi /home, /root ya da /srv altında olmalı";; esac
  local m=$STATE_DIR/src
  step 5 "Bölüm salt okunur bağlanıyor ($src)"
  mkdir -p "$m"
  local fs; fs=$(blkid -s TYPE -o value "$src")
  if [ "$fs" = ext4 ] || [ "$fs" = ext3 ]; then mount -o ro,noload "$src" "$m" || die "$src bağlanamadı"
  else mount -o ro "$src" "$m" || die "$src bağlanamadı"; fi
  CLEANUP+=("umount '$m'")
  local dirs=() d
  for d in home root opt etc srv; do [ -d "$m/$d" ] && dirs+=("$d"); done
  [ ${#dirs[@]} -gt 0 ] || die "$src içinde arşivlenecek klasör yok (home, root, opt, etc, srv)"
  step 10 "Boyut hesaplanıyor"
  local need=0 s
  for d in "${dirs[@]}"; do s=$(du -sxB1 "$m/$d" 2>/dev/null | awk '{print $1}'); need=$((need + ${s:-0})); done
  mkdir -p "$dest"
  [ "$(disk_of_part "$(mounted_at "$dest")")" = "$(disk_of_part "$src")" ] && die "arşiv hedefi arşivlenen diskte olamaz"
  local avail; avail=$(df -B1 --output=avail "$dest" | tail -1 | tr -d ' ')
  [ "$((need + 2147483648))" -lt "${avail:-0}" ] || { rmdir "$dest" 2>/dev/null; die "hedefte yer yok: $((need / 1073741824 + 1)) GB gerekli, $((avail / 1073741824)) GB boş"; }
  log "arşivlenecek: ${dirs[*]} ($((need / 1048576)) MB) → $dest"
  local done_b=0 i=0
  for d in "${dirs[@]}"; do
    i=$((i + 1))
    step $((15 + 80 * done_b / (need > 0 ? need : 1))) "Kopyalanıyor: /$d ($i/${#dirs[@]})"
    cp -a "$m/$d" "$dest/" || die "/$d kopyalanamadı"
    s=$(du -sxB1 "$m/$d" 2>/dev/null | awk '{print $1}'); done_b=$((done_b + ${s:-0}))
  done
  local label; label=$(blkid -s LABEL -o value "$src")
  cat > "$dest/BENİOKU.txt" <<EOF
Bu klasör $src bölümündeki (etiket: ${label:-yok}) eski sistemin arşividir.
Arşiv tarihi: $(date '+%Y-%m-%d %H:%M'). Kopyalanan klasörler: ${dirs[*]}.
Klyrix Gate Depolama sayfası tarafından, disk yeniden hazırlanmadan önce oluşturuldu.
EOF
  umount "$m" && CLEANUP=()
  step 100 "Arşiv tamam: $dest"
  setstate state=done "msg=Eski sistem arşivlendi: $dest ($((need / 1048576)) MB)" "finished=$(date +%s)"
  kv archive "$dest"; kv size_mb $((need / 1048576))
}

# ── verileri SD'ye geri al (disk silinmeden önce) ────────────────────────────
# KAYNAK aygıtı DİSK'teyse: panel verileri / Pi-hole / günlükler SD'deki normal yerlerine alınır.
evacuate() { # DİSK
  local disk=$1 d
  d=$(bind_dev "$CORE"); [ -z "$d" ] && [ -L "$CORE" ] && d=$(mounted_at "$(readlink -f "$CORE")")
  if [ -n "$d" ] && [ "$(disk_of_part "$d")" = "$(basename "$disk")" ]; then
    step 12 "Panel verileri SD karta alınıyor"
    local tmp=$BASE/.core-evac
    rm -rf "$tmp"; mkdir -p "$tmp"; cp -a "$CORE/." "$tmp/" || die "panel verileri SD'ye kopyalanamadı"
    if is_mountpoint "$CORE"; then umount "$CORE" || die "$CORE ayrılamadı"; fi
    rm -rf "$CORE"; mv "$tmp" "$CORE"
    log "panel verileri SD'de: $CORE"
  fi
  d=$(bind_dev "$PH_DIR")
  if [ -n "$d" ] && [ "$(disk_of_part "$d")" = "$(basename "$disk")" ]; then
    step 15 "Pi-hole veritabanı SD karta alınıyor"
    svc stop "$FTL"
    local tmp=/var/lib/klyrix/.pihole-evac
    rm -rf "$tmp"; mkdir -p "$tmp"; cp -a "$PH_DIR/." "$tmp/" || die "Pi-hole veritabanı SD'ye kopyalanamadı"
    umount "$PH_DIR" || die "$PH_DIR ayrılamadı"
    rm -rf "$PH_DIR"; mv "$tmp" "$PH_DIR"
    svc start "$FTL"
  fi
  d=$(bind_dev /var/log)
  if [ -n "$d" ] && [ "$(disk_of_part "$d")" = "$(basename "$disk")" ]; then
    step 18 "Günlükler SD karta alınıyor"
    local tmp=/var/.log-evac
    rm -rf "$tmp"; mkdir -p "$tmp"; cp -a /var/log/. "$tmp/" || die "günlükler SD'ye kopyalanamadı"
    umount /var/log || umount -l /var/log || die "/var/log ayrılamadı"
    copy_tree "$tmp" /var/log; rm -rf "$tmp"
    restart_loggers
  fi
}

restart_loggers() {
  svc restart systemd-journald
  local s; for s in rsyslog fail2ban; do svc try-restart "$s"; done
  svc reload nginx
}

# ── verileri diske taşı ──────────────────────────────────────────────────────
migrate_core() {
  if marker_has core && is_mountpoint "$CORE" && [ "$(bind_dev "$CORE")" = "$(dev_of_label "$DATA_LABEL")" ]; then log "panel verileri zaten diskte"; return 0; fi
  step 60 "Panel verileri diske taşınıyor"
  local dst=$DATA_MNT/pi5-data
  rm -rf "$dst.new"; mkdir -p "$dst.new"
  cp -a "$CORE/." "$dst.new/" || die "panel verileri diske kopyalanamadı"
  rm -rf "$dst"; mv "$dst.new" "$dst"
  # SD'deki kopya: sembolik bağlantı yerine gerçek klasör (disk yoksa panel bununla açılır)
  if [ -L "$CORE" ]; then rm -f "$CORE"; mkdir -p "$CORE"; cp -a "$dst/." "$CORE/"; fi
  marker_set core
  fstab_apply
  mount --bind "$dst" "$CORE" || die "panel verileri bağlanamadı"
  log "panel verileri: $dst → $CORE"
}

migrate_pihole() {
  if ! have "$FTL"; then log "Pi-hole yok: atlandı"; return 0; fi
  local cur; cur=$(ftl_db); cur=${cur:-/etc/pihole/pihole-FTL.db}
  local target=$PH_DIR/pihole-FTL.db
  if marker_has pihole && [ "$cur" = "$target" ] && [ "$(bind_dev "$PH_DIR")" = "$(dev_of_label "$DATA_LABEL")" ]; then log "Pi-hole veritabanı zaten diskte"; return 0; fi
  step 72 "Pi-hole sorgu veritabanı diske taşınıyor (DNS kısa süre kesilir)"
  local own; own=$(stat -c '%U:%G' "$cur" 2>/dev/null || echo pihole:pihole)
  svc stop "$FTL"
  local dst=$DATA_MNT/pihole f
  mkdir -p "$dst" "$PH_DIR"
  for f in '' -wal -shm; do
    [ -f "$cur$f" ] && { cp -a "$cur$f" "$dst/pihole-FTL.db$f" || die "Pi-hole veritabanı kopyalanamadı"; }
  done
  # SD'deki anlık görüntü: disk yoksa Pi-hole bununla açılır
  cp -a "$dst/." "$PH_DIR/" 2>/dev/null || true
  chown -R "$own" "$dst" "$PH_DIR" 2>/dev/null || true
  marker_set pihole
  fstab_apply
  mount --bind "$dst" "$PH_DIR" || die "Pi-hole klasörü bağlanamadı"
  "$FTL" --config files.database "$target" >/dev/null 2>&1 || true
  svc start "$FTL"
  if [ "$(ftl_db)" = "$target" ] && dns_ok; then
    [ "$cur" != "$target" ] && [ -f "$cur" ] && mv -f "$cur" "$cur.diske-tasindi" 2>/dev/null
    log "Pi-hole veritabanı: $dst (files.database=$target)"
    return 0
  fi
  # Geri al: eski yol, bind ve işaret kaldırılır
  log "Pi-hole yeni veritabanıyla açılamadı — eski yola dönülüyor"
  svc stop "$FTL"
  "$FTL" --config files.database "$cur" >/dev/null 2>&1 || true
  umount "$PH_DIR" 2>/dev/null || true
  grep -vx 'pihole=1' "$(MARKER)" > "$(MARKER).tmp" 2>/dev/null; mv -f "$(MARKER).tmp" "$(MARKER)"
  fstab_apply
  svc start "$FTL"
  dns_ok || log "UYARI: Pi-hole eski yolla da yanıt vermiyor — 'sudo systemctl restart pihole-FTL'"
  WARN="Pi-hole veritabanı taşınamadı (Pi-hole yeni konumla açılmadı); SD kartta kaldı"
}

migrate_log() {
  if marker_has log && [ "$(bind_dev /var/log)" = "$(dev_of_label "$DATA_LABEL")" ]; then log "günlükler zaten diskte"; return 0; fi
  step 85 "Günlükler diske taşınıyor"
  local dst=$DATA_MNT/log
  rm -rf "$dst.new"; mkdir -p "$dst.new"
  cp -a /var/log/. "$dst.new/" || die "günlükler diske kopyalanamadı"
  rm -rf "$dst"; mv "$dst.new" "$dst"
  marker_set log
  fstab_apply
  mount --bind "$dst" /var/log || die "/var/log bağlanamadı"
  restart_loggers
  svc try-restart "$FTL"
  log "günlükler: $dst → /var/log"
}

WARN=''
do_migrate() {
  is_mountpoint "$DATA_MNT" || die "$DATA_MNT bağlı değil (klyrix-data bölümü yok ya da bağlanamadı)"
  [ "$(mounted_at "$DATA_MNT")" = "$(dev_of_label "$DATA_LABEL")" ] || die "$DATA_MNT klyrix-data bölümü değil"
  migrate_core
  migrate_pihole
  migrate_log
}

# Panel servisi yalnız çalışıyorsa durdurulur ve sonra yeniden başlatılır (kurulumda henüz kurulmamış / durmuş olabilir)
BACKEND_WAS=0
backend_stop() { svc_active "$BACKEND" && BACKEND_WAS=1; svc stop "$BACKEND"; }
backend_start() { [ "$BACKEND_WAS" = 1 ] && svc start "$BACKEND"; return 0; }
# Cihaz yedekleme (Syncthing) diskteki klasörleri açık tutar: ayırmadan önce durdurulur ("kullanımda" olmasın), finish()
# yeniden başlatır. Yalnız çalışıyorsa.
SYNC_WAS=0
sync_stop() {
  svc_active "$SYNC_UNIT" || return 0
  SYNC_WAS=1
  log "cihaz yedekleme duraklatıldı (disk ayrılıyor)"
  svc stop "$SYNC_UNIT"
}
# Uygulamalar (apps.sh, G3.3): konteynerler veri diskindeki klasörleri açık tutar — ayırma / taşıma öncesi durdurulur, finish()
# yeniden başlatır. Yalnız çalışanlar. Uygulama yoksa (özellik kapalı) hiçbir şey yapılmaz.
APPS_WAS=()
APPS_DATA_DIR=/mnt/klyrix-data/apps
apps_stop() {
  local u
  for u in $(systemctl list-units --type=service --state=active,activating --no-legend --plain 'pi5-app-*' 2>/dev/null | awk '{print $1}'); do
    APPS_WAS+=("$u")
  done
  [ ${#APPS_WAS[@]} -gt 0 ] || return 0
  log "uygulamalar duraklatıldı (${#APPS_WAS[@]}; disk ayrılıyor / veriler taşınıyor)"
  svc stop "${APPS_WAS[@]}"
}
# Diskte uygulama verisi var mı (veri bölümü bu diskteyse): <uygulama>/ klasörlerinde dosya (imaj deposu 'storage' ve
# indirme ara klasörü 'tmp' sayılmaz). Bu diskteki klyrix-data bölümü bağlı değilse (açılışta bağlanamadı) salt okunur ve
# günlüğü oynatmadan (noload: diske yazılmaz) geçici olarak bağlanıp bakılır; bağlanamıyorsa veri okunamaz sayılır.
apps_has_data() { [ -d "$1" ] && [ -n "$(find "$1" -mindepth 2 -maxdepth 2 ! -path "$1/storage/*" ! -path "$1/tmp/*" -print -quit 2>/dev/null)" ]; }
apps_data_on() { # disk
  local name src tgt tmp rc=1
  name=$(basename "$1")
  if is_mountpoint "$DATA_MNT"; then
    src=$(mounted_at "$DATA_MNT")
    if [ "$(disk_of_part "$src")" = "$name" ]; then apps_has_data "$APPS_DATA_DIR"; return; fi
  fi
  for src in $(parts_of "$1"); do
    [ "$(blkid -c /dev/null -s LABEL -o value "$src" 2>/dev/null)" = "$DATA_LABEL" ] || continue
    tgt=$(findmnt -n -o TARGET --source "$src" 2>/dev/null | head -1)
    if [ -n "$tgt" ]; then apps_has_data "$tgt/apps" && return 0; continue; fi
    tmp=$(mktemp -d /run/pi5-storage-apps.XXXXXX) || continue
    if mount -o ro,noload "$src" "$tmp" 2>/dev/null; then
      apps_has_data "$tmp/apps" && rc=0
      umount "$tmp" 2>/dev/null || umount -l "$tmp" 2>/dev/null || true
    fi
    rmdir "$tmp" 2>/dev/null || true
    [ "$rc" = 0 ] && return 0
  done
  return 1
}

cmd_migrate() {
  apps_stop
  step 50 "Panel durduruluyor"
  backend_stop
  do_migrate
  step 97 "Panel başlatılıyor"
  backend_start
  step 100 "Tamam"
  setstate state=done "msg=Veriler diske taşındı${WARN:+ — $WARN}" "finished=$(date +%s)"
  kv result ok; [ -n "$WARN" ] && kv warning "$WARN"
}

# ── prepare: DİSKİ SİLER ─────────────────────────────────────────────────────
cmd_prepare() {
  local disk='' gb='' share=1 confirm='' auto=0
  while [ $# -gt 0 ]; do case "$1" in
    --disk) disk=$2; shift 2;; --system-gb) gb=$2; shift 2;; --no-share) share=0; shift;;
    --confirm) confirm=$2; shift 2;; --auto) auto=1; shift;; *) die "bilinmeyen seçenek: $1";; esac; done
  local name; name=$(basename "$disk")
  # RAM diskleri (zram takas alanı dahil) ve loop aygıtları hiçbir zaman hazırlanmaz (loop yalnız testte)
  case "$name" in zram*|ram*) die "$disk bellek diski: hazırlanamaz";; esac
  [ -b "$disk" ] || die "disk bulunamadı: $disk"
  local dtype; dtype=$(lsblk -ndo TYPE "$disk")
  if [ "$dtype" = loop ] && [ "${PI5_STORAGE_TEST:-0}" = 1 ]; then :; else [ "$dtype" = disk ] || die "$disk bir disk değil"; fi
  local rd; rd=$(root_disk)
  [ -n "$rd" ] && [ "$name" = "$rd" ] && die "$disk sistem diski (işletim sistemi burada): hazırlanamaz"
  local p m
  for p in $(parts_of "$disk"); do
    for m in $(findmnt -n -o TARGET --source "$p" 2>/dev/null); do
      case "$m" in /|/boot|/boot/*) die "$disk üzerinde sistem bölümü bağlı ($m): hazırlanamaz";; esac
    done
  done
  local model size_b size_gb
  model=$(lsblk -ndo MODEL "$disk" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  size_b=$(lsblk -bndo SIZE "$disk"); size_gb=$((size_b / 1000000000))
  if [ "$auto" != 1 ]; then
    local expect=${model:-$size_gb}
    [ "$confirm" = "$expect" ] || die "onay eşleşmedi: diski silmek için '$expect' yazılmalı"
  fi
  # Uygulama verileri (Home Assistant ayarları, parola kasası …) sessizce silinmez: önce Uygulamalar sayfasından
  # uygulamalar "verileri de sil" onayıyla kaldırılır.
  apps_data_on "$disk" && die "bu diskte uygulama verileri var ($APPS_DATA_DIR) — önce Uygulamalar sayfasından uygulamaları verileriyle kaldırın"
  local total_gib=$((size_b / 1073741824))
  if [ "$share" = 1 ]; then
    [[ "$gb" =~ ^[0-9]+$ ]] || die "sistem bölümü boyutu (GB) sayı olmalı"
    [ "$gb" -ge 8 ] || die "sistem bölümü en az 8 GB olmalı"
    [ "$((gb + 8))" -le "$total_gib" ] || die "disk ${total_gib} GB: sistem bölümü en çok $((total_gib - 8)) GB olabilir (paylaşıma en az 8 GB kalmalı)"
  fi
  log "disk: $disk (${model:-model yok}, ${size_gb} GB); düzen: $([ "$share" = 1 ] && echo "${gb} GB sistem + paylaşım" || echo 'tek bölüm')"

  step 5 "Panel durduruluyor"
  backend_stop
  evacuate "$disk"

  step 25 "Disk ayrılıyor"
  sync_stop
  apps_stop
  for p in $(parts_of "$disk"); do
    for m in $(findmnt -n -o TARGET --source "$p" 2>/dev/null | sort -r); do
      umount "$m" 2>/dev/null || { die "$m ayrılamadı (kullanımda): $(fuser -vm "$m" 2>&1 | tail -n +2 | awk '{print $NF}' | sort -u | tr '\n' ' ')"; }
    done
    swapoff "$p" 2>/dev/null || true
  done
  fstab_drop_disk "$disk"

  step 30 "Disk siliniyor ve bölümleniyor"
  for p in $(parts_of "$disk"); do wipefs -aq "$p" 2>/dev/null || true; done
  wipefs -aq "$disk" 2>/dev/null || true
  local layout
  if [ "$share" = 1 ]; then
    layout=$(printf 'label: gpt\nsize=%sGiB, type=L, name=%s\ntype=L, name=%s\n' "$gb" "$DATA_LABEL" "$SHARE_LABEL")
  else
    layout=$(printf 'label: gpt\ntype=L, name=%s\n' "$DATA_LABEL")
  fi
  printf '%s\n' "$layout" | sfdisk --quiet --wipe always --wipe-partitions always "$disk" >>"$OUT" 2>&1 \
    || { die "bölümlenemedi (sfdisk)"; }
  partx -u "$disk" 2>/dev/null || true; have partprobe && partprobe "$disk" 2>/dev/null; have udevadm && udevadm settle 2>/dev/null
  local want=$([ "$share" = 1 ] && echo 2 || echo 1) i
  for i in $(seq 1 30); do [ "$(parts_of "$disk" | wc -l)" -ge "$want" ] && [ -b "$(parts_of "$disk" | head -1)" ] && break; sleep 0.5; done
  local p1 p2
  p1=$(parts_of "$disk" | sed -n 1p); p2=$(parts_of "$disk" | sed -n 2p)
  [ -b "$p1" ] || { die "yeni bölüm görünmedi: $disk"; }

  step 38 "Biçimlendiriliyor ($DATA_LABEL)"
  mkfs.ext4 -q -F -L "$DATA_LABEL" "$p1" >>"$OUT" 2>&1 || { die "$p1 biçimlendirilemedi"; }
  if [ "$share" = 1 ]; then
    [ -b "$p2" ] || { die "paylaşım bölümü görünmedi"; }
    step 44 "Biçimlendiriliyor ($SHARE_LABEL)"
    mkfs.ext4 -q -F -m 0 -L "$SHARE_LABEL" "$p2" >>"$OUT" 2>&1 || { die "$p2 biçimlendirilemedi"; }
  fi
  have udevadm && udevadm settle 2>/dev/null
  for i in $(seq 1 20); do [ -n "$(dev_of_label "$DATA_LABEL")" ] && break; sleep 0.5; done

  step 50 "Bölümler bağlanıyor"
  mkdir -p "$DATA_MNT"; [ "$share" = 1 ] && mkdir -p "$SHARE_MNT"
  fstab_apply
  mount "$DATA_MNT" 2>/dev/null || mount "$p1" "$DATA_MNT" || { die "$DATA_MNT bağlanamadı"; }
  if [ "$share" = 1 ]; then
    mount "$SHARE_MNT" 2>/dev/null || mount "$p2" "$SHARE_MNT" || log "UYARI: $SHARE_MNT bağlanamadı"
    mkdir -p "$SHARE_MNT/Paylasim"
  fi
  printf 'created=%s\nsystem_gb=%s\nshare=%s\n' "$(date +%s)" "${gb:-all}" "$share" > "$(MARKER)"

  do_migrate
  step 97 "Panel başlatılıyor"
  backend_start
  step 100 "Tamam"
  setstate state=done "msg=Disk hazırlandı ve veriler taşındı${WARN:+ — $WARN}" "finished=$(date +%s)"
  kv result ok; kv data_dev "$p1"; [ "$share" = 1 ] && kv share_dev "$p2"; [ -n "$WARN" ] && kv warning "$WARN"
}

# ── ensure: açılış / güncelleme onarımı (veri taşımaz) ───────────────────────
cmd_ensure() {
  local dd; dd=$(dev_of_label "$DATA_LABEL")
  if [ -z "$dd" ]; then kv data none; return 0; fi
  mkdir -p "$DATA_MNT"
  [ -n "$(dev_of_label "$SHARE_LABEL")" ] && mkdir -p "$SHARE_MNT"
  is_mountpoint "$DATA_MNT" || mount "$dd" "$DATA_MNT" 2>/dev/null || { kv error "$DATA_MNT bağlanamadı"; return 0; }
  fstab_apply
  if [ -n "$(dev_of_label "$SHARE_LABEL")" ] && ! is_mountpoint "$SHARE_MNT"; then mount "$SHARE_MNT" 2>/dev/null || true; fi
  if marker_has core && ! is_mountpoint "$CORE"; then
    # Bind yokken panel SD'deki kopyayla çalışıyor olabilir: diskteki (asıl) veri üzerine bağlanır, SD kopyası altta kalır
    [ -L "$CORE" ] && { rm -f "$CORE"; mkdir -p "$CORE"; cp -a "$DATA_MNT/pi5-data/." "$CORE/"; }
    mount --bind "$DATA_MNT/pi5-data" "$CORE" 2>/dev/null && kv fixed core
  fi
  if marker_has pihole && ! is_mountpoint "$PH_DIR"; then
    mkdir -p "$PH_DIR"; mount --bind "$DATA_MNT/pihole" "$PH_DIR" 2>/dev/null && { kv fixed pihole; svc try-restart "$FTL"; }
  fi
  if marker_has pihole && have "$FTL" && [ "$(ftl_db)" != "$PH_DIR/pihole-FTL.db" ]; then
    "$FTL" --config files.database "$PH_DIR/pihole-FTL.db" >/dev/null 2>&1 && { kv fixed pihole_config; svc try-restart "$FTL"; }
  fi
  if marker_has log && ! is_mountpoint /var/log; then
    mount --bind "$DATA_MNT/log" /var/log 2>/dev/null && { kv fixed log; restart_loggers; }
  fi
  kv data "$dd"
}

# ── auto: kurulumda tamamen boş NVMe'yi hazırla ─────────────────────────────
cmd_auto() {
  local force=0; [ "${1:-}" = --force ] && force=1
  if [ -n "$(dev_of_label "$DATA_LABEL")" ]; then cmd_ensure; return 0; fi
  local rd d
  rd=$(root_disk)
  for d in $(lsblk -dnpo NAME,TRAN | awk '$2=="nvme"{print $1}'); do
    [ "$(basename "$d")" = "$rd" ] && continue
    local parts sig
    parts=$(parts_of "$d" | wc -l); sig=$(wipefs -n "$d" 2>/dev/null | tail -n +2 | wc -l)
    if [ "$force" != 1 ] && { [ "$parts" -gt 0 ] || [ "$sig" -gt 0 ]; }; then
      kv skipped "$d (bölüm ya da veri var — panelde Depolama sayfasından hazırlanabilir)"; continue
    fi
    local gib=$(( $(lsblk -bndo SIZE "$d") / 1073741824 ))
    if [ "$gib" -ge 128 ]; then cmd_prepare --disk "$d" --system-gb 64 --auto; else cmd_prepare --disk "$d" --no-share --auto; fi
    return $?
  done
  kv data none
}

# ── giriş ────────────────────────────────────────────────────────────────────
# share.sh yardımcıları (günlük, iş durumu, fstab, kilit) buradan alır: STORAGE_LIB=1 ile kaynaklanınca giriş çalışmaz.
if [ "${STORAGE_LIB:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi
cmd=${1:-status}; shift || true
case "$cmd" in
  status) cmd_status; exit 0;;
  archive|prepare|migrate|ensure|auto) ;;
  *) echo "kullanım: storage.sh status|archive|prepare|migrate|ensure|auto" >&2; exit 2;;
esac
[ "$(id -u)" = 0 ] || { echo "root gerekli" >&2; exit 1; }
exec 9>"$LOCK"
if ! flock -n 9; then
  # Panelin başlattığı iş (durumu backend yazdı) kilidi alamadıysa durum "sürüyor" diye kalmasın
  if [ -n "${PI5_STORAGE_ID:-}" ] && grep -qx "id=$PI5_STORAGE_ID" "$STATE" 2>/dev/null; then JOB=1; die "başka bir depolama işi sürüyor"; fi
  kv error "başka bir depolama işi sürüyor"; exit 1
fi
case "$cmd" in
  archive|prepare|migrate)
    JOB=1
    trap finish EXIT
    trap 'die "iş durduruldu (süre sınırı ya da systemctl stop)"' TERM
    [ -n "${PI5_STORAGE_ID:-}" ] || : > "$OUT"
    setstate state=running "cmd=$cmd" "started=$(date +%s)" "id=${PI5_STORAGE_ID:-$(date +%s)}" error= msg= step= pct=0 finished=
    ;;
esac
case "$cmd" in
  archive) cmd_archive "$@";;
  prepare) cmd_prepare "$@";;
  migrate) cmd_migrate;;
  ensure) cmd_ensure;;
  auto) cmd_auto "$@";;
esac

#!/usr/bin/env bash
# Klyrix Gate — ağ paylaşımı (Samba). Root olarak çalışır; storage.sh'nin yardımcılarını kullanır (kilit, iş durumu, fstab).
#
# Paylaşımlar:
#   Paylasim    ← /mnt/klyrix-share/Paylasim (veri diskinin paylaşım bölümü; bölüm bağlı değilse listelenmez)
#   <AD>        ← /mnt/klyrix-usb/<AD>: panelde "Ağda paylaş" denen USB bölümü. Disk silinmez; fstab'a UUID ile
#                 "# klyrix-usb" işaretli satır yazılır (nofail: disk yoksa açılış takılmaz). Bağlı değilken bağlama
#                 noktası 000 izinlidir: disk çıkarılmışken paylaşıma yazılanlar SD karta düşmez.
# Erişim: yalnız kullanıcı adı + şifre (misafir yok, SMB1 kapalı, NetBIOS kapalı). İki katman:
#   - Samba hosts allow: özel ağlar (10/8, 172.16/12, 192.168/16) EXCEPT backend'in verdiği liste (Ev VPN misafirleri,
#     VPS tünel ağları) — apply --except
#   - güvenlik duvarı: backend'in politikası drop olan tablolara eklediği pi5_share_in zinciri (share.ts)
# Ağda görünme: Windows wsdd2 (WS-Discovery), Mac / iPhone avahi (_smb._tcp hizmet dosyası).
#
# Komutlar:
#   status                              durum satırları (kilitsiz, salt okunur)
#   enable --user AD --pwfile DOSYA     (iş) paketleri kurar, kullanıcıyı + şifreyi ayarlar, paylaşımı açar; DOSYA silinir
#   disable                             Samba'yı ve wsdd2'yi durdurur (veriler, kullanıcı ve USB bağlamaları kalır)
#   passwd                              şifre stdin'den (tek satır)
#   apply [--except "IP|AĞ ..."]        dışlama listesini kaydeder, ayarları yeniden üretir (değiştiyse Samba yenilenir)
#   usb-add --part BÖLÜM                USB bölümünü silmeden bağlar ve paylaşır
#   usb-remove --name AD                paylaşımı kaldırır ve bölümü güvenle ayırır (disk olduğu gibi kalır)
#   timemachine --on [--size GB] | --off
#                                       Mac Time Machine hedefi (TimeMachine paylaşımı, paylaşım bölümünde; GB = üst sınır,
#                                       0 = sınırsız). Kapatmak yedekleri silmez.
#   ensure                              açıksa: ayarları yeniden üretir, takılı ama bağlı olmayan USB paylaşımlarını bağlar
set -uo pipefail
export LC_ALL=C
STORAGE_LIB=1
# shellcheck source=storage.sh
. "$(dirname "$(readlink -f "$0")")/storage.sh"

CONF=${PI5_SHARE_CONF:-/etc/pi5-gateway/share.conf}      # enabled=0|1, user=AD
EXCEPT_FILE=${PI5_SHARE_EXCEPT:-/etc/pi5-gateway/share.except}
SMB_DIR=${PI5_SMB_DIR:-/etc/samba}
SMB_CONF=$SMB_DIR/smb.conf
SHARES_CONF=$SMB_DIR/klyrix-shares.conf
AVAHI_SVC=/etc/avahi/services/klyrix-smb.service
USB_MNT=/mnt/klyrix-usb
USB_MARK='# klyrix-usb'
SHARE_DIR=$SHARE_MNT/Paylasim
TM_DIR=$SHARE_MNT/TimeMachine    # Mac Time Machine hedefi (timemachine --on)
BACKUP_DIR=$SHARE_MNT/Yedekler   # cihaz yedekleri (sync.sh, Syncthing yazar): salt okunur paylaşılır (geri yükleme)
SYNC_GROUP=klyrix-sync
SMB_MARK='# Klyrix Gate tarafından yönetilir'
OUR_GECOS='Klyrix Gate ag paylasimi'
PKGS=(samba wsdd2 avahi-daemon)
ALLOW_NETS='127.0.0.1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16'

# ── yardımcılar ──────────────────────────────────────────────────────────────
conf_get() { [ -f "$CONF" ] && sed -n "s/^$1=//p" "$CONF" | tail -1; }
conf_set() { # ANAHTAR DEĞER
  mkdir -p "$(dirname "$CONF")"; touch "$CONF"
  { grep -v "^$1=" "$CONF" 2>/dev/null; echo "$1=$2"; } > "$CONF.tmp"; mv -f "$CONF.tmp" "$CONF"
}
enabled() { [ "$(conf_get enabled)" = 1 ]; }
valid_user() { [[ "$1" =~ ^[a-z][a-z0-9_-]{2,31}$ ]]; }
pkg_ok() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
# fstab'daki USB paylaşımları: "UUID AD DOSYASİSTEMİ" satırları
usb_lines() { grep -F -- "$USB_MARK" "$FSTAB" 2>/dev/null | awk '{u=$1; sub(/^UUID=/, "", u); n=$2; sub(/.*\//, "", n); print u, n, $3}'; }

# ── Samba ayarları ───────────────────────────────────────────────────────────
render_smb() {
  local except allow=$ALLOW_NETS
  except=$(cat "$EXCEPT_FILE" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//')
  [ -n "$except" ] && allow="$allow EXCEPT $except"
  cat <<EOF
$SMB_MARK (scripts/share.sh) — elle yapılan değişiklikler bir sonraki uygulamada silinir. Özgün dosya: smb.conf.klyrix-orig
[global]
   workgroup = WORKGROUP
   server string = Klyrix Gate
   server role = standalone server
   server min protocol = SMB2_10
   smb ports = 445
   disable netbios = yes
   map to guest = never
   restrict anonymous = 2
   usershare max shares = 0
   load printers = no
   printing = bsd
   printcap name = /dev/null
   disable spoolss = yes
   hosts allow = $allow
   hosts deny = ALL
   unix password sync = no
   pam password change = no
   obey pam restrictions = no
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   include = $SHARES_CONF
EOF
}

share_block() { # AD YOL USB(0|1)
  local u; u=$(conf_get user)
  printf '\n[%s]\n   path = %s\n   valid users = %s\n   force user = %s\n   force group = %s\n' "$1" "$2" "$u" "$u" "$u"
  printf '   read only = no\n   browseable = yes\n   create mask = 0664\n   directory mask = 2775\n'
  if [ "$3" = 1 ]; then
    # USB: exFAT / FAT / NTFS genişletilmiş öznitelik tutmaz; Mac eklentileri yalnız dahili (ext4) paylaşımda
    printf '   ea support = no\n   store dos attributes = no\n   map archive = no\n'
  else
    printf '   vfs objects = catia fruit streams_xattr\n   fruit:metadata = stream\n'
  fi
}

# Cihaz yedekleri: yalnız okunur. Dosyalar klyrix-sync'indir (Yedekler 2750): paylaşım kullanıcısı o grupla okur (force
# group). Eski sürümler (.stversions) görünür; Syncthing'in işaret klasörü (.stfolder) hiç listelenmez (veto).
backup_block() {
  local u; u=$(conf_get user)
  printf '\n[Yedekler]\n   path = %s\n   valid users = %s\n   force user = %s\n   force group = %s\n' "$BACKUP_DIR" "$u" "$u" "$SYNC_GROUP"
  printf '   read only = yes\n   browseable = yes\n   hide dot files = no\n   veto files = /.stfolder/\n'
  printf '   vfs objects = catia fruit streams_xattr\n   fruit:metadata = stream\n'
}

# Mac Time Machine: fruit:time machine (FULLSYNC) + isteğe bağlı üst sınır. Mac, ağdaki Time Machine diskini avahi'nin
# _adisk kaydından bulur (render_avahi).
tm_on() { [ "$(conf_get timemachine)" = 1 ] && is_mountpoint "$SHARE_MNT" && [ -d "$TM_DIR" ]; }
tm_block() {
  local u gb; u=$(conf_get user); gb=$(conf_get tm_size)
  printf '\n[TimeMachine]\n   path = %s\n   valid users = %s\n   force user = %s\n   force group = %s\n' "$TM_DIR" "$u" "$u" "$u"
  printf '   read only = no\n   browseable = yes\n   create mask = 0660\n   directory mask = 2770\n'
  printf '   vfs objects = catia fruit streams_xattr\n   fruit:metadata = stream\n   fruit:time machine = yes\n'
  [[ "$gb" =~ ^[1-9][0-9]*$ ]] && printf '   fruit:time machine max size = %sG\n' "$gb"
  return 0
}

render_shares() {
  echo "$SMB_MARK (scripts/share.sh)"
  if is_mountpoint "$SHARE_MNT" && [ -d "$SHARE_DIR" ]; then share_block Paylasim "$SHARE_DIR" 0; fi
  if is_mountpoint "$SHARE_MNT" && [ -d "$BACKUP_DIR" ] && getent group "$SYNC_GROUP" >/dev/null \
     && ! usb_lines | awk '{print tolower($2)}' | grep -qx yedekler; then backup_block; fi
  if tm_on && ! usb_lines | awk '{print tolower($2)}' | grep -qx timemachine; then tm_block; fi
  local uuid name fst
  while read -r uuid name fst; do [ -n "$name" ] && share_block "$name" "$USB_MNT/$name" 1; done < <(usb_lines)
  :
}

render_avahi() {
  cat <<'EOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Klyrix Gate ağ paylaşımı (scripts/share.sh): Mac Finder ve iPhone Dosyalar'da görünür -->
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service><type>_smb._tcp</type><port>445</port></service>
  <service><type>_device-info._tcp</type><port>0</port><txt-record>model=RackMac</txt-record></service>
EOF
  # Time Machine: Mac'in "Yedekleme Diski Seç" listesinde görünür (dk0 = paylaşım adı; adVF=0x82 Time Machine diski)
  if tm_on; then
    printf '  <service><type>_adisk._tcp</type><port>9</port><txt-record>sys=waMa=0,adVF=0x100</txt-record><txt-record>dk0=adVN=TimeMachine,adVF=0x82</txt-record></service>\n'
  fi
  echo '</service-group>'
}

# Ayarları yeniden üretir; bir şey değiştiyse yazar, doğrular ve (çalışıyorsa) Samba'ya yeniden okutur. 0 = değişti.
refresh_confs() {
  local t1 t2 changed=1
  t1=$(mktemp); t2=$(mktemp)
  render_smb > "$t1"; render_shares > "$t2"
  mkdir -p "$SMB_DIR"
  if [ -f "$SMB_CONF" ] && ! head -1 "$SMB_CONF" | grep -qF "$SMB_MARK"; then
    [ -f "$SMB_CONF.klyrix-orig" ] || cp -a "$SMB_CONF" "$SMB_CONF.klyrix-orig"
  fi
  if ! cmp -s "$t1" "$SMB_CONF" || ! cmp -s "$t2" "$SHARES_CONF"; then
    install -m 0644 "$t2" "$SHARES_CONF"; install -m 0644 "$t1" "$SMB_CONF"
    changed=0
    if have testparm && ! testparm -s "$SMB_CONF" >/dev/null 2>>"$OUT"; then rm -f "$t1" "$t2"; die "Samba ayarı geçersiz (testparm) — ayrıntı günlükte"; fi
    svc_active smbd && { smbcontrol smbd reload-config >/dev/null 2>&1 || true; }
  fi
  rm -f "$t1" "$t2"
  if [ -d "$(dirname "$AVAHI_SVC")" ] && enabled; then
    t1=$(mktemp); render_avahi > "$t1"
    cmp -s "$t1" "$AVAHI_SVC" || { install -m 0644 "$t1" "$AVAHI_SVC"; have avahi-daemon && avahi-daemon --reload >/dev/null 2>&1; }
    rm -f "$t1"
  fi
  return $changed
}

# ── kurulum, kullanıcı, servisler ────────────────────────────────────────────
install_pkgs() {
  local missing=() p
  for p in "${PKGS[@]}"; do pkg_ok "$p" || missing+=("$p"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  step 10 "Paketler kuruluyor: ${missing[*]} (birkaç dakika sürebilir)"
  # Kurulum sırasında servisler Debian'ın varsayılan ayarıyla ([homes], misafir eşlemesi) başlamasın
  local prc=/usr/sbin/policy-rc.d
  if [ ! -e "$prc" ]; then printf '#!/bin/sh\nexit 101\n' > "$prc"; chmod +x "$prc"; CLEANUP+=("rm -f $prc"); fi
  local apt=(apt-get install -y -q --no-install-recommends -o DPkg::Lock::Timeout=300)
  if ! DEBIAN_FRONTEND=noninteractive "${apt[@]}" "${missing[@]}" >>"$OUT" 2>&1; then
    log "paket listesi yenileniyor (apt-get update)"
    apt-get update -q >>"$OUT" 2>&1
    DEBIAN_FRONTEND=noninteractive "${apt[@]}" "${missing[@]}" >>"$OUT" 2>&1 || die "paketler kurulamadı: ${missing[*]} — ayrıntı günlükte"
  fi
  [ -e "$prc" ] && grep -qx 'exit 101' "$prc" && rm -f "$prc"
  log "kuruldu: ${missing[*]}"
}

ensure_user() { # AD
  if id "$1" >/dev/null 2>&1; then
    [ "$(getent passwd "$1" | cut -d: -f5)" = "$OUR_GECOS" ] || die "'$1' adı sistemde başka bir hesap için kullanılıyor; başka bir ad seçin"
  else
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment "$OUR_GECOS" "$1" \
      || die "kullanıcı oluşturulamadı: $1"
    log "paylaşım kullanıcısı oluşturuldu: $1"
  fi
}

set_pw() { # AD — şifre stdin'den (tek satır)
  local pw=''
  IFS= read -r pw || true
  [ ${#pw} -ge 8 ] && [ ${#pw} -le 64 ] || die "şifre 8-64 karakter olmalı"
  printf '%s\n%s\n' "$pw" "$pw" | smbpasswd -s -a "$1" >/dev/null 2>>"$OUT" || die "Samba şifresi ayarlanamadı"
  smbpasswd -e "$1" >/dev/null 2>&1 || true
}

start_services() {
  systemctl unmask smbd >/dev/null 2>&1 || true
  systemctl enable smbd >/dev/null 2>&1 || true
  systemctl restart smbd >/dev/null 2>>"$OUT" || true
  # NetBIOS kapalı: nmbd gereksiz; Debian'ın AD denetleyicisi birimi kullanılmaz
  systemctl disable --now nmbd samba-ad-dc >/dev/null 2>&1 || true
  systemctl mask nmbd >/dev/null 2>&1 || true
  if pkg_ok wsdd2; then
    systemctl enable wsdd2 >/dev/null 2>&1 || true
    systemctl restart wsdd2 >/dev/null 2>&1 || log "UYARI: wsdd2 başlamadı — Windows'ta Ağ altında görünmeyebilir, adresle bağlanılır"
  fi
  if have avahi-daemon; then
    systemctl enable avahi-daemon >/dev/null 2>&1 || true
    systemctl start avahi-daemon >/dev/null 2>&1 || true
  fi
}

# ── komutlar ─────────────────────────────────────────────────────────────────
cmd_status() {
  kv installed "$(have smbd && echo 1 || echo 0)"
  kv enabled "$(enabled && echo 1 || echo 0)"
  kv user "$(conf_get user)"
  kv smbd "$(svc_active smbd && echo 1 || echo 0)"
  kv wsdd "$(svc_active wsdd2 && echo 1 || echo 0)"
  kv avahi "$( [ -f "$AVAHI_SVC" ] && svc_active avahi-daemon && echo 1 || echo 0)"
  kv share_dir "$( is_mountpoint "$SHARE_MNT" && [ -d "$SHARE_DIR" ] && echo "$SHARE_DIR")"
  kv timemachine "$(conf_get timemachine | grep -qx 1 && echo 1 || echo 0)"
  kv tm_size "$(conf_get tm_size)"
  kv tm_dir "$(tm_on && echo "$TM_DIR")"
  kv backup_dir "$( is_mountpoint "$SHARE_MNT" && [ -d "$BACKUP_DIR" ] && getent group "$SYNC_GROUP" >/dev/null && echo "$BACKUP_DIR")"
  local uuid name fst dev
  while read -r uuid name fst; do
    [ -n "$name" ] || continue
    dev=$(blkid -c /dev/null -U "$uuid" 2>/dev/null)
    kv usb "$name|$uuid|$fst|$(is_mountpoint "$USB_MNT/$name" && echo 1 || echo 0)|$dev"
  done < <(usb_lines)
  kv except "$(cat "$EXCEPT_FILE" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
}

cmd_enable() {
  local user='' pwfile=''
  while [ $# -gt 0 ]; do case "$1" in --user) user=$2; shift 2;; --pwfile) pwfile=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  [ -n "$pwfile" ] && CLEANUP+=("rm -f '$pwfile'")
  valid_user "$user" || die "kullanıcı adı 3-32 karakter olmalı: küçük harfle başlar; küçük harf, rakam, - ve _ içerir"
  local cur; cur=$(conf_get user)
  [ -n "$cur" ] && [ "$cur" != "$user" ] && die "kullanıcı adı değiştirilemez (mevcut: $cur)"
  [ -f "$pwfile" ] || die "şifre dosyası bulunamadı"
  install_pkgs
  step 60 "Kullanıcı ve şifre ayarlanıyor"
  ensure_user "$user"
  set_pw "$user" < "$pwfile"
  rm -f "$pwfile"
  conf_set user "$user"
  if is_mountpoint "$SHARE_MNT"; then
    mkdir -p "$SHARE_DIR"; chown "$user:$user" "$SHARE_DIR"; chmod 2775 "$SHARE_DIR"
  else
    log "UYARI: paylaşım bölümü ($SHARE_MNT) bağlı değil — yalnız USB diskler paylaşılabilir"
  fi
  step 75 "Ayarlar yazılıyor"
  conf_set enabled 1
  refresh_confs || true
  step 85 "Servisler başlatılıyor"
  start_services
  step 95 "Denetleniyor"
  local i; for i in 1 2 3 4 5; do svc_active smbd && break; sleep 1; done
  svc_active smbd || die "Samba (smbd) başlamadı — ayrıntı: journalctl -u smbd"
  step 100 "Tamam"
  setstate state=done "msg=Ağ paylaşımı açıldı (kullanıcı: $user)" "finished=$(date +%s)"
  kv result ok
}

cmd_disable() {
  conf_set enabled 0
  systemctl disable --now smbd wsdd2 >/dev/null 2>&1 || true
  if [ -f "$AVAHI_SVC" ]; then rm -f "$AVAHI_SVC"; have avahi-daemon && avahi-daemon --reload >/dev/null 2>&1; fi
  log "ağ paylaşımı kapatıldı"
  kv result ok
}

cmd_passwd() {
  local u; u=$(conf_get user)
  [ -n "$u" ] && have smbpasswd || die "önce ağ paylaşımını açın"
  set_pw "$u"
  kv result ok
}

cmd_apply() {
  local except='' t
  while [ $# -gt 0 ]; do case "$1" in --except) except=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  for t in $except; do
    [[ "$t" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || die "geçersiz adres: $t"
  done
  mkdir -p "$(dirname "$EXCEPT_FILE")"
  printf '%s\n' $except > "$EXCEPT_FILE.tmp"; mv -f "$EXCEPT_FILE.tmp" "$EXCEPT_FILE"
  if enabled; then refresh_confs && kv changed 1; fi
  kv result ok
}

# Paylaşım adı: etiketten (yoksa diskin adı), Windows / Samba için güvenli karakterler; çakışırsa -2, -3 ...
usb_name() { # ETİKET YEDEK
  local base n i
  base=$(printf '%s' "${1:-$2}" | tr -c 'A-Za-z0-9_-' '-' | sed 's/--*/-/g; s/^-//; s/-$//' | cut -c1-24)
  [ -n "$base" ] || base=USB
  case "$(printf '%s' "$base" | tr 'A-Z' 'a-z')" in paylasim|yedekler|timemachine|global|homes|printers|ipc) base="USB-$base";; esac
  n=$base; i=2
  while [ -e "$USB_MNT/$n" ] || usb_lines | awk '{print $2}' | grep -qix -- "$n"; do n="$base-$i"; i=$((i + 1)); done
  printf '%s' "$n"
}

cmd_usb_add() {
  local part=''
  while [ $# -gt 0 ]; do case "$1" in --part) part=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  [ -b "$part" ] || die "bölüm bulunamadı: $part"
  local u; u=$(conf_get user)
  enabled && [ -n "$u" ] || die "önce ağ paylaşımını açın"
  local type disk
  type=$(lsblk -ndo TYPE "$part")
  case "$type" in part) disk=$(disk_of_part "$part");; disk) disk=$(basename "$part");; *) die "$part bir bölüm değil";; esac
  if [ "$(lsblk -ndo TRAN "/dev/$disk" 2>/dev/null | tr -d ' ')" != usb ]; then
    [ "${PI5_STORAGE_TEST:-0}" = 1 ] && [[ $disk == loop* ]] || die "yalnız USB diskler bu yolla paylaşılır"
  fi
  [ "$disk" = "$(root_disk)" ] && die "sistem diski paylaşılamaz"
  if findmnt -n --source "$part" >/dev/null 2>&1; then die "$part şu an bağlı ($(findmnt -n -o TARGET --source "$part" | head -1)); önce ayırın"; fi
  local fst uuid label
  fst=$(blkid -c /dev/null -s TYPE -o value "$part"); uuid=$(uuid_of "$part"); label=$(blkid -c /dev/null -s LABEL -o value "$part")
  [ -n "$uuid" ] || die "bölümde dosya sistemi yok (biçimlendirilmemiş)"
  grep -q "^UUID=$uuid[[:space:]]" "$FSTAB" 2>/dev/null && die "bu bölüm zaten fstab'da (paylaşılıyor ya da sistem kullanıyor)"
  local uid gid vfs=$fst opts="defaults,noatime,nofail,x-systemd.device-timeout=5s"
  uid=$(id -u "$u"); gid=$(id -g "$u")
  case "$fst" in
    ext2|ext3|ext4|btrfs|xfs) ;;
    vfat) opts="$opts,uid=$uid,gid=$gid,umask=0002,utf8=1,shortname=mixed";;
    exfat) opts="$opts,uid=$uid,gid=$gid,umask=0002";;
    ntfs|ntfs3)
      vfs=ntfs3
      modprobe ntfs3 2>/dev/null
      if ! grep -qw ntfs3 /proc/filesystems; then have ntfs-3g && vfs=ntfs-3g || die "NTFS desteği yok (çekirdekte ntfs3 yok, ntfs-3g kurulu değil)"; fi
      opts="$opts,uid=$uid,gid=$gid,umask=0002";;
    *) die "desteklenmeyen dosya sistemi: ${fst:-bilinmiyor} (ext4, exFAT, FAT32 ve NTFS desteklenir)";;
  esac
  local name mp
  name=$(usb_name "$label" "$(lsblk -ndo MODEL "/dev/$disk" 2>/dev/null)")
  mp=$USB_MNT/$name
  mkdir -p "$mp"; chmod 000 "$mp"   # bağlı değilken yazılamaz: paylaşıma yazılanlar SD karta düşmesin
  { cat "$FSTAB"; printf 'UUID=%s %s %s %s 0 0 %s\n' "$uuid" "$mp" "$vfs" "$opts" "$USB_MARK"; } | fstab_rewrite || die "fstab doğrulanamadı; değişiklik yazılmadı"
  # 9>&-: FUSE (ntfs-3g) arka plan süreci kilit dosyasını devralmasın (yoksa bağlı kaldıkça kilit tutulur)
  if ! mount "$mp" 2>>"$OUT" 9>&- && ! mount -t "$vfs" -o "$opts" "UUID=$uuid" "$mp" 2>>"$OUT" 9>&-; then
    grep -v "^UUID=$uuid[[:space:]]" "$FSTAB" | fstab_rewrite
    rmdir "$mp" 2>/dev/null
    die "$part bağlanamadı ($fst) — ayrıntı günlükte"
  fi
  case "$fst" in ext2|ext3|ext4|btrfs|xfs) chown "$u:$u" "$mp"; chmod 2775 "$mp";; esac
  refresh_confs || true
  log "USB paylaşımı: $part ($fst) → $mp"
  kv result ok; kv name "$name"
}

cmd_usb_remove() {
  local name=''
  while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  [[ "$name" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || die "geçersiz paylaşım adı"
  local mp=$USB_MNT/$name
  grep -F -- "$USB_MARK" "$FSTAB" 2>/dev/null | awk '{print $2}' | grep -qx -- "$mp" || die "paylaşım bulunamadı: $name"
  # Önce Samba bağlantıları kapanır; ayırma başarılı olmadan hiçbir şey değişmez
  have smbcontrol && svc_active smbd && { smbcontrol smbd close-share "$name" >/dev/null 2>&1 || true; }
  if is_mountpoint "$mp"; then
    sync_stop   # cihaz yedekleme bu diske yazıyor olabilir; finish() yeniden başlatır
    sync
    umount "$mp" 2>>"$OUT" || { sleep 2; umount "$mp" 2>>"$OUT"; } || die "$name ayrılamadı (kullanımda) — açık dosyaları kapatıp yeniden deneyin"
  fi
  awk -v mp="$mp" -v mark="$USB_MARK" 'index($0, mark) && $2 == mp {next} {print}' "$FSTAB" | fstab_rewrite || die "fstab doğrulanamadı"
  rmdir "$mp" 2>/dev/null
  refresh_confs || true
  log "USB paylaşımı kaldırıldı: $name"
  kv result ok
}

cmd_timemachine() {
  local on='' size=''
  while [ $# -gt 0 ]; do case "$1" in --on) on=1; shift;; --off) on=0; shift;; --size) size=$2; shift 2;; *) die "bilinmeyen seçenek: $1";; esac; done
  [ -n "$on" ] || die "--on ya da --off gerekli"
  local u; u=$(conf_get user)
  if [ "$on" = 1 ]; then
    enabled && [ -n "$u" ] || die "önce ağ paylaşımını açın"
    is_mountpoint "$SHARE_MNT" || die "Time Machine paylaşım bölümüne yazılır: veri diskinin paylaşım bölümü bağlı değil"
    [ -z "$size" ] || [[ "$size" =~ ^[0-9]{1,6}$ ]] || die "üst sınır GB cinsinden tam sayı olmalı (0 = sınırsız)"
    mkdir -p "$TM_DIR"; chown "$u:$u" "$TM_DIR"; chmod 2770 "$TM_DIR"
    [ -n "$size" ] && conf_set tm_size "$((10#$size))"
    conf_set timemachine 1
    log "Time Machine açıldı ($TM_DIR, üst sınır: $( [ "$(conf_get tm_size)" -gt 0 ] 2>/dev/null && echo "$(conf_get tm_size) GB" || echo yok))"
  else
    conf_set timemachine 0
    log "Time Machine kapatıldı (yedekler $TM_DIR içinde kaldı)"
  fi
  refresh_confs || true
  # Kapatınca avahi kaydından _adisk kalksın (refresh_confs yalnız paylaşım açıkken avahi dosyasını yazar)
  kv result ok
}

cmd_ensure() {
  if ! enabled; then kv enabled 0; return 0; fi
  local uuid name fst
  while read -r uuid name fst; do
    [ -n "$uuid" ] || continue
    if [ -n "$(blkid -c /dev/null -U "$uuid" 2>/dev/null)" ] && ! is_mountpoint "$USB_MNT/$name"; then
      mount "$USB_MNT/$name" 2>>"$OUT" 9>&- && kv mounted "$name"
    fi
  done < <(usb_lines)
  refresh_confs && kv fixed conf
  if have smbd && ! svc_active smbd; then systemctl start smbd >/dev/null 2>&1 && kv fixed smbd; fi
  kv enabled 1
}

# ── giriş ────────────────────────────────────────────────────────────────────
cmd=${1:-status}; shift || true
case "$cmd" in
  status) cmd_status; exit 0;;
  enable|disable|passwd|apply|usb-add|usb-remove|timemachine|ensure) ;;
  *) echo "kullanım: share.sh status|enable|disable|passwd|apply|usb-add|usb-remove|timemachine|ensure" >&2; exit 2;;
esac
[ "$(id -u)" = 0 ] || { echo "root gerekli" >&2; exit 1; }
exec 9>"$LOCK"
if [ "$cmd" = enable ]; then
  if ! flock -n 9; then
    if [ -n "${PI5_STORAGE_ID:-}" ] && grep -qx "id=$PI5_STORAGE_ID" "$STATE" 2>/dev/null; then JOB=1; die "başka bir depolama işi sürüyor"; fi
    kv error "başka bir depolama işi sürüyor"; exit 1
  fi
  JOB=1
  trap finish EXIT
  trap 'die "iş durduruldu (süre sınırı ya da systemctl stop)"' TERM
  [ -n "${PI5_STORAGE_ID:-}" ] || : > "$OUT"
  setstate state=running cmd=share started="$(date +%s)" "id=${PI5_STORAGE_ID:-$(date +%s)}" error= msg= step= pct=0 finished=
else
  # Kısa komutlar iş günlüğünü (panelin ilerleme şeridi) kirletmez
  OUT=$STATE_DIR/share.log
  flock -w 30 9 || { kv error "başka bir depolama işi sürüyor — birazdan yeniden deneyin"; exit 1; }
  trap finish EXIT
fi
case "$cmd" in
  enable) cmd_enable "$@";;
  disable) cmd_disable;;
  passwd) cmd_passwd;;
  apply) cmd_apply "$@";;
  usb-add) cmd_usb_add "$@";;
  usb-remove) cmd_usb_remove "$@";;
  timemachine) cmd_timemachine "$@";;
  ensure) cmd_ensure;;
esac

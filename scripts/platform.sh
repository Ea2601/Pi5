#!/bin/bash
# Klyrix Gate — donanım profili (tek kaynak). Eşikler YALNIZ burada: install.sh, post-update.sh ve backend (hardware.ts)
# bu betiğin çıktısını okur. Profil saklanmaz, her seferinde gerçeklerden çıkarılır (SD kart başka karta takılabilir).
#   platform.sh detect        KEY=VALUE satırları; salt okunur, her zaman 0 ile çıkar
#   platform.sh swap-ensure   takas alanı hiç yoksa ve işletim sisteminin takas yöneticisi de yoksa zram açar
#                             (yalnız kendi işaretli dosyasını yazar; rpi-swap / dphys / diğer ayarlara ASLA dokunmaz)
# Bellek sınıfı: MemTotal'dan büyük ya da eşit ilk 2'nin kuvveti (en az 256 MB). MemTotal firmware / GPU payı kadar azdır:
# Pi Zero 2 W (~430 MB) → 512, 1 GB'lık kartlar (~900-980 MB) → 1024, Pi 5 8 GB → 8192.
#   profile: lite (512 MB sınıfı ve altı) | standard. Elle: /etc/pi5-gateway/profile ("profile=lite|standard", role
#            dosyasıyla aynı biçim) ya da KLYRIX_PROFILE; ikisi de forced=1 yazar.
#   kiosk:   no (lite) | no-display (ekran çıkışı yok) | warn (1 GB sınıfı) | ok
#   arch:    dpkg --print-architecture (kullanıcı alanı); kernel_arch yalnız gösterim (Pi 5'te 32 bit sistem aarch64 der).
# Test kancaları: PI5_PLATFORM_ROOT (/proc, /sys, /etc, /usr/lib ve /var/lib/dpkg okumaları için sahte kök), KLYRIX_PROFILE,
# KLYRIX_ZRAM=0 (yalnız bu çalıştırmada zram'ı kapatır; kalıcısı /etc/pi5-gateway/zram.off — install.sh onu yazar).
set -u
R=${PI5_PLATFORM_ROOT:-}
R=${R%/}
MARK='# Klyrix Gate'
ZRAM_CONF=$R/etc/systemd/zram-generator.conf
ZRAM_GEN=$R/usr/lib/systemd/system-generators/zram-generator

# Tek satır, baştaki / sondaki boşluklar ve NUL'lar atılmış (device-tree model NUL ile biter)
oneline() { [ -r "$1" ] || return 0; tr -d '\000' < "$1" 2>/dev/null | tr '\n\r\t' '   ' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
# DMI alanı; üreticinin doldurmadığı yer tutucular boş sayılır (AMI firmware'li x86 mini PC'ler "Default string",
# "To Be Filled By O.E.M." yazar — kart adı yerine onu göstermektense backend makine adına düşer)
dmi() {
  local v
  v=$(oneline "$R/sys/class/dmi/id/$1")
  case "${v,,}" in
    'to be filled by o.e.m.'|'default string'|'system manufacturer'|'system product name'|'o.e.m.'|'oem'|'not applicable'|'not specified'|'none'|'unknown') v= ;;
  esac
  printf '%s' "$v"
}

detect_vars() {
  local model vendor product c f l pkgs sum
  # Kart: device-tree modeli (Pi ve diğer ARM kartlar), yoksa DMI üretici + ürün (x86); yer tutucuysa anakart üretici /
  # adı; hiçbiri yoksa boş
  model=$(oneline "$R/proc/device-tree/model")
  board=$model
  if [ -z "$board" ]; then
    vendor=$(dmi sys_vendor); [ -n "$vendor" ] || vendor=$(dmi board_vendor)
    product=$(dmi product_name); [ -n "$product" ] || product=$(dmi board_name)
    board=$(printf '%s %s' "$vendor" "$product" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  fi
  case "$model" in "Raspberry Pi"*) rpi=1 ;; *) rpi=0 ;; esac

  kernel_arch=$(uname -m 2>/dev/null)
  arch=$(dpkg --print-architecture 2>/dev/null)
  if [ -z "$arch" ]; then # dpkg yok: çekirdekten tahmin (yalnız gösterim; kurulum Debian ister)
    case "$kernel_arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; armv7l|armv8l) arch=armhf ;; *) arch=unknown ;; esac
  fi
  cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)

  mem_mib=$(awk '/^MemTotal:/ { print int($2 / 1024); exit }' "$R/proc/meminfo" 2>/dev/null)
  case "$mem_mib" in ''|*[!0-9]*) mem_mib=0 ;; esac
  # Okunamadıysa 0: sınıf da 0 olur ve hiçbir kısıtlama uygulanmaz (bugünkü davranış)
  mem_class=0
  if [ "$mem_mib" -gt 0 ]; then mem_class=256; while [ "$mem_class" -lt "$mem_mib" ]; do mem_class=$((mem_class * 2)); done; fi

  profile=standard; forced=0
  if [ "$mem_class" -gt 0 ] && [ "$mem_class" -le 512 ]; then profile=lite; fi
  f=$(sed -n 's/^profile=\([a-z]*\)[[:space:]]*$/\1/p' "$R/etc/pi5-gateway/profile" 2>/dev/null | head -1)
  case "${KLYRIX_PROFILE:-}" in lite|standard) f=$KLYRIX_PROFILE ;; esac
  case "$f" in lite|standard) profile=$f; forced=1 ;; esac

  # Ekran çıkışı: DRM bağlayıcısı (card1-HDMI-A-1, card0-DP-1 …; takılı olması gerekmez). Writeback gerçek çıkış değil.
  # DRM bağlayıcısı olmayan çerçeve arabelleği (fb0: eski Pi firmware yığını vc4-kms'siz, x86'da modeset'siz sürücü /
  # efifb) de ekran sayılır — X orada da açılır; emin olunamayınca bugünkü davranış (kurulur / açılır) sürer.
  display=0
  for c in "$R"/sys/class/drm/card*-*; do
    [ -e "$c" ] || continue
    case "${c##*/}" in *-Writeback-*) continue ;; esac
    display=1; break
  done
  if [ "$display" = 0 ] && [ -e "$R/sys/class/graphics/fb0" ]; then display=1; fi

  if [ "$profile" = lite ]; then kiosk=no
  elif [ "$display" != 1 ]; then kiosk=no-display
  elif [ "$mem_class" -gt 0 ] && [ "$mem_class" -le 1024 ]; then kiosk=warn
  else kiosk=ok; fi

  # Takas: /proc/swaps (Filename Type Size Used Priority; boyut kB). zram aygıtının türü "partition" görünür.
  local kb=0 name type size
  swap_zram=0; swap_file=0
  if [ -r "$R/proc/swaps" ]; then
    while read -r name type size _; do
      case "$size" in ''|*[!0-9]*) continue ;; esac
      kb=$((kb + size))
      case "$name" in /dev/zram*) swap_zram=1 ;; esac
      if [ "$type" = file ]; then swap_file=1; fi
    done < "$R/proc/swaps"
  fi
  swap_mib=$((kb / 1024))

  # Takas yöneticisi (ayar dosyası ya da kurulu paket). Sıra önemli: rpi-swap kendi zram/dosya düzenini kurar (ve
  # systemd-zram-generator'a bağımlıdır). Debian'ın systemd-zram-generator paketinin kendi varsayılanı
  # (/usr/lib/systemd/zram-generator.conf) yönetici sayılmaz: paketi swap-ensure öncesinde kurulum kurar; /etc'deki dosya
  # onu ezer. Başka paketlerin /usr/lib/.../zram-generator.conf.d ekleri yönetici sayılır.
  # Bookworm'un paketi (1.1.x) varsayılanı /etc/systemd/zram-generator.conf olarak kurar (işaretsiz dpkg conffile) ve
  # kurulunca başlatmaz: dosya paket kaydındaki md5 ile aynıysa o da yönetici sayılmaz (pkgdefault — swap-ensure dosyaya
  # dokunmadan yalnız başlatır). Elle değiştirilmişse yöneticidir.
  pkgs=$(awk '$1 == "Package:" { cur = $2 }
    $1 == "Status:" && $NF == "installed" && (cur == "rpi-swap" || cur == "dphys-swapfile" || cur == "zram-tools") { print cur }' \
    "$R/var/lib/dpkg/status" 2>/dev/null)
  l=$(head -1 "$ZRAM_CONF" 2>/dev/null)
  case "$l" in "$MARK"*) l=ours ;; *) l=foreign ;; esac
  if [ "$l" = foreign ] && [ -e "$ZRAM_CONF" ]; then
    sum=$(md5sum < "$ZRAM_CONF" 2>/dev/null | cut -d' ' -f1)
    if [ -n "$sum" ] && [ "$sum" = "$(awk '$1 == "Package:" { p = ($2 == "systemd-zram-generator") }
         p && $1 == "/etc/systemd/zram-generator.conf" { print $2; exit }' "$R/var/lib/dpkg/status" 2>/dev/null)" ]; then
      l=pkgdefault
    fi
  fi
  zram_cfg=$l; [ -e "$ZRAM_CONF" ] || zram_cfg=none
  if printf '%s\n' "$pkgs" | grep -qx rpi-swap || [ -e "$R/etc/rpi/swap.conf" ] || [ -n "$(ls -A "$R/etc/rpi/swap.conf.d" 2>/dev/null)" ]; then
    swap_mgr='rpi-swap'
  elif printf '%s\n' "$pkgs" | grep -qx dphys-swapfile || [ -e "$R/etc/dphys-swapfile" ]; then
    swap_mgr='dphys-swapfile'
  elif { [ -e "$ZRAM_CONF" ] && [ "$l" = foreign ]; } || [ -n "$(ls -A "$R/etc/systemd/zram-generator.conf.d" 2>/dev/null)" ] \
       || [ -n "$(ls -A "$R/usr/lib/systemd/zram-generator.conf.d" 2>/dev/null)" ]; then
    swap_mgr='zram-generator'
  elif printf '%s\n' "$pkgs" | grep -qx zram-tools || [ -e "$R/etc/default/zramswap" ]; then
    swap_mgr='zram-tools'
  elif [ "$l" = ours ]; then
    swap_mgr=klyrix
  else
    swap_mgr=none
  fi

  zram_off=0
  if [ "${KLYRIX_ZRAM:-}" = 0 ] || [ -e "$R/etc/pi5-gateway/zram.off" ]; then zram_off=1; fi
  need_zram=0
  if [ "$swap_mib" = 0 ] && [ "$swap_mgr" = none ] && [ "$mem_class" -gt 0 ] && [ "$mem_class" -le 1024 ] && [ "$zram_off" = 0 ]; then
    need_zram=1
  fi

  # Node.js 22 (NodeSource) yalnız amd64 / arm64 / armhf (ARMv7+) için var. 32 bit Raspberry Pi OS armv6 kartlarda da
  # "armhf" der (Pi Zero W / Pi 1): çekirdek armv6 ise desteklenmez.
  supported=1; reason=
  case "$arch" in
    amd64|arm64) ;;
    armhf) case "$kernel_arch" in armv6*) supported=0; reason="armv6 işlemci: Node.js 22 bu işlemcide çalışmaz (ARMv7 / 64 bit gerekir)" ;; esac ;;
    *) supported=0; reason="mimari ${arch:-bilinmiyor} desteklenmiyor (amd64, arm64 ya da armhf gerekir)" ;;
  esac
}

detect() {
  detect_vars
  printf '%s\n' "board=$board" "rpi=$rpi" "kernel_arch=$kernel_arch" "arch=$arch" "cpus=$cpus" \
    "mem_mib=$mem_mib" "mem_class=$mem_class" "profile=$profile" "forced=$forced" "display=$display" "kiosk=$kiosk" \
    "swap_mib=$swap_mib" "swap_zram=$swap_zram" "swap_file=$swap_file" "swap_mgr=$swap_mgr" "need_zram=$need_zram" \
    "supported=$supported" "reason=$reason"
}

# zram yalnız şu durumda açılır: hiç takas yok, takas yöneticisi yok, bellek 1 GB sınıfı ya da altı, kapatılmamış ve
# systemd-zram-generator kurulu. Yazılan tek dosya işaretli /etc/systemd/zram-generator.conf (yalnız yoksa; paketin
# varsayılanını ezer). Takas başlamazsa dosya kalır (paketin varsayılanı da aynı aygıtı açmaya çalışırdı), sonuç
# result=error olur ve dosya bir daha yazılmaz. Bookworm'da paketin kendi /etc dosyası (değiştirilmemiş conffile) yerinde
# bırakılır ve yalnız başlatılır (reason=package-default; başlamazsa sonraki güncellemede yeniden denenir).
# Çıktı: result=created|skip|error + reason.
swap_ensure() {
  detect_vars
  local why=""
  if [ "$need_zram" != 1 ]; then
    if [ "$zram_off" = 1 ]; then why=opt-out
    elif [ "$swap_mib" != 0 ]; then why=swap-active
    elif [ "$swap_mgr" != none ]; then why="manager:$swap_mgr"
    else why=memory; fi
    printf 'result=skip\nreason=%s\n' "$why"; return 0
  fi
  if [ ! -x "$ZRAM_GEN" ]; then printf 'result=skip\nreason=no-generator\n'; return 0; fi
  if [ "$zram_cfg" = pkgdefault ]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    if systemctl start dev-zram0.swap >/dev/null 2>&1; then printf 'result=created\nreason=package-default\n'; return 0; fi
    printf 'result=error\nreason=start-failed\n'; return 1
  fi
  if [ -e "$ZRAM_CONF" ]; then printf 'result=skip\nreason=config-exists\n'; return 0; fi
  if ! { mkdir -p "${ZRAM_CONF%/*}" && printf '%s\n' "$MARK — scripts/platform.sh swap-ensure yazdı: takas yöneticisi olmayan, belleği az cihazda sıkıştırılmış bellek takası." \
           "# Kapatmak için: /etc/pi5-gateway/zram.off oluşturun ve bu dosyanın içini boşaltın (paketin varsayılanı da kapanır)." \
           '[zram0]' 'zram-size = ram / 2' 'compression-algorithm = zstd' > "$ZRAM_CONF.tmp.$$" \
         && mv -f "$ZRAM_CONF.tmp.$$" "$ZRAM_CONF"; } 2>/dev/null; then
    rm -f "$ZRAM_CONF.tmp.$$" 2>/dev/null
    printf 'result=error\nreason=write-failed\n'; return 1
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if systemctl start dev-zram0.swap >/dev/null 2>&1; then
    printf 'result=created\nreason=\n'; return 0
  fi
  printf 'result=error\nreason=start-failed\n'; return 1
}

case "${1:-}" in
  detect) detect; exit 0 ;;
  swap-ensure) swap_ensure; exit $? ;;
  *) echo "Kullanım: platform.sh detect | swap-ensure" >&2; exit 2 ;;
esac

#!/bin/bash
# Klyrix Gate — Zapret (DPI atlatma) kurulumu / onarımı. Zapret'in git deposunda hazır program yoktur (binaries/ boş):
# nfqws kaynaktan derlenir (make → binaries/my, nfq/nfqws bağlantısı), servis birimi kurulur. Servis AÇILMAZ ve
# etkinleştirilmez — panel açar (Zapret DPI → aç/kapa); kurulum tamsa hiçbir şey yapılmaz (hızlı çıkar).
# post-update.sh (system) ve install.sh çağırır; elle: sudo bash /opt/pi5-gateway/scripts/zapret-install.sh
# Eskiden install.sh Zapret'in etkileşimli install_easy.sh'ine körlemesine "1\n1" veriyor, hatayı gizliyordu: canlı Pi'de
# servis birimi ve nfqws hiç kurulmamıştı, panelin "aç" düğmesi "Unit zapret.service does not exist" ile düşüyordu.
# Çıktı satırları "[zapret]" önekli; çıkış kodu 0 = kurulum tam.
set -u
export LC_ALL=C
Z=${ZAPRET_DIR:-/opt/zapret}
BASE=${PI5_BASE:-/opt/pi5-gateway}
REPO=https://github.com/bol-van/zapret.git
UNIT_DIR=/lib/systemd/system
[ -d "$UNIT_DIR" ] || UNIT_DIR=/usr/lib/systemd/system
UNIT="$UNIT_DIR/zapret.service"
BUILD_LOG=/tmp/pi5-zapret-build.log
# Derleme bağımlılıkları (Zapret'in install_bin.sh'inin Debian listesi; libsystemd-dev yalnız `make systemd` içindir —
# servis birimi sysv betiğini çalıştırdığı için gerekmez).
DEPS=(make gcc zlib1g-dev libcap-dev libnetfilter-queue-dev libmnl-dev)

log() { echo "$(date '+%H:%M:%S') [zapret] $*"; }
indent() { sed 's/^/    /'; }
nfqws_ok() { [ -x "$Z/nfq/nfqws" ] && "$Z/nfq/nfqws" --version >/dev/null 2>&1; }
unit_ok() { [ -f "$Z/init.d/systemd/zapret.service" ] && cmp -s "$Z/init.d/systemd/zapret.service" "$UNIT"; }

# 1) Kaynak: yoksa indirilir (yeni kurulum). Var olan klasöre dokunulmaz (panelin config'i ve listeleri orada).
if [ ! -d "$Z" ]; then
  log "kaynak indiriliyor ($REPO)"
  git clone -q --depth=1 "$REPO" "$Z" 2>&1 | indent
  [ -f "$Z/Makefile" ] || { log "HATA: Zapret indirilemedi"; exit 1; }
fi
[ -f "$Z/Makefile" ] && [ -f "$Z/init.d/sysv/zapret" ] || { log "HATA: $Z eksik (Makefile / init.d yok) — klasörü silip yeniden çalıştırın"; exit 1; }
# Panelin yönettiği ayar dosyası (zapret.ts); yoksa Zapret'in varsayılanından.
[ -f "$Z/config" ] || cp "$Z/config.default" "$Z/config" || { log "HATA: $Z/config oluşturulamadı"; exit 1; }

# Blockcheck (panelin otomatik yöntem araması, zapret-blockcheck.sh) ad çözümü için nslookup ya da host ister.
if ! command -v nslookup >/dev/null 2>&1 && ! command -v host >/dev/null 2>&1; then
  log "Blockcheck için host kuruluyor (bind9-host)"
  bash "$BASE/scripts/pkg-ensure.sh" bind9-host 2>&1 | indent
  [ "${PIPESTATUS[0]}" = 0 ] || log "UYARI: bind9-host kurulamadı — Blockcheck kendisi yeniden dener"
fi

if nfqws_ok && unit_ok; then exit 0; fi

# 2) nfqws: çalışan program yoksa derlenir. `make` önce binaries/my'yi temizler, programları oraya taşır ve
#    nfq/nfqws, tpws/tpws, ip2net/ip2net, mdig/mdig bağlantılarını kurar; install_bin.sh mimariyi sınayıp doğrular.
if ! nfqws_ok; then
  log "nfqws yok — derleniyor (derleme paketleri gerekirse kurulur)"
  # pkg-ensure.sh paket listesinde adayı olmayanı atlar; listeler hiç inmemişse (yeni sistem) bir kez yenilenip denenir.
  if ! bash "$BASE/scripts/pkg-ensure.sh" "${DEPS[@]}"; then
    log "paket listeleri yenileniyor (apt-get update) ve yeniden deneniyor"
    timeout 180 apt-get -q update </dev/null >/dev/null 2>&1 || log "UYARI: apt-get update başarısız ya da zaman aşımı"
    if ! bash "$BASE/scripts/pkg-ensure.sh" "${DEPS[@]}"; then
      log "HATA: derleme paketleri kurulamadı (${DEPS[*]})"; exit 1
    fi
  fi
  if ! make -C "$Z" >"$BUILD_LOG" 2>&1; then
    log "HATA: derleme başarısız (ayrıntı: $BUILD_LOG)"; tail -n 15 "$BUILD_LOG" | indent; exit 1
  fi
  if ! (cd "$Z" && sh ./install_bin.sh) >>"$BUILD_LOG" 2>&1; then
    log "HATA: install_bin.sh derlenen programı doğrulayamadı (ayrıntı: $BUILD_LOG)"; tail -n 8 "$BUILD_LOG" | indent; exit 1
  fi
  nfqws_ok || { log "HATA: derleme bitti ama $Z/nfq/nfqws çalışmıyor"; exit 1; }
  log "nfqws derlendi: $("$Z/nfq/nfqws" --version 2>&1 | head -n 1)"
fi

# 3) Servis birimi: Zapret'in kendi birimi (sysv betiğini çalıştırır). Yalnız kopyalanır + daemon-reload; enable / start
#    panelin işi. Birim değişmişse (Zapret güncellendi) yenisi yazılır.
if ! unit_ok; then
  if cp -f "$Z/init.d/systemd/zapret.service" "$UNIT"; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    log "servis birimi kuruldu ($UNIT) — kapalı; panelden açılır"
  else
    log "HATA: $UNIT yazılamadı"; exit 1
  fi
fi

# 4) Çekirdek: nfqws paketleri nftables 'queue' ile alır (nft_queue + nfnetlink_queue). Yoksa servis açılır ama DPI
#    çalışmaz — kurulumu düşürmez, uyarır.
for m in nft_queue nfnetlink_queue; do
  if ! modinfo "$m" >/dev/null 2>&1 && ! grep -qs "/$m.ko" "/lib/modules/$(uname -r)/modules.builtin"; then
    log "UYARI: çekirdekte $m modülü bulunamadı — Zapret paketleri işleyemeyebilir"
  fi
done
log "Zapret hazır (servis kapalı; Zapret DPI sayfasından açılır)"
exit 0

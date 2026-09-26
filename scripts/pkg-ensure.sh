#!/usr/bin/env bash
# Klyrix Gate — sistem paketi kurulum/onarım işçisi.
# post-update.sh bunu pi5-backend cgroup'unun DIŞINDA (systemd-run) başlatır: güncellemenin 300 sn exec sınırı ya da
# backend yeniden başlatması dpkg'yi yarıda kesemesin. Yarıda kesilen dpkg "dpkg was interrupted" bırakır ve apt
# hiçbir paketi kurmaz (canlıda yaşandı).
# Kullanım: bash pkg-ensure.sh paket1 [paket2 ...]
#   elle:   sudo bash /opt/pi5-gateway/scripts/pkg-ensure.sh ipset iptables
# Çıkış kodu, tanımlıysa $PI5_PKG_RC dosyasına da yazılır. Çıktı satırları "[pkg]" önekli.
set -u
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
trap 'rc=$?; if [ -n "${PI5_PKG_RC:-}" ]; then echo "$rc" > "$PI5_PKG_RC" 2>/dev/null; fi' EXIT

log(){ echo "$(date '+%H:%M:%S') [pkg] $*"; }
indent(){ sed 's/^/    /'; }
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold
          -o DPkg::Lock::Timeout=120 -o Dpkg::Use-Pty=0)
LOCK_RE='locked by another process|Could not get lock|frontend lock'
APT_LOG=/tmp/pi5-pkg-apt.log

# Yalnız tam kurulu ("installed") paket sayılır: `dpkg -s` rc/unpacked/half-configured için de 0 döner.
installed(){ [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = installed ]; }
# apt'nin "dpkg was interrupted" dediği durum: /var/lib/dpkg/updates altında numaralı journal dosyası.
journal_dirty(){ find /var/lib/dpkg/updates -maxdepth 1 -regex '.*/[0-9]+$' 2>/dev/null | grep -q .; }

need=()
for p in "$@"; do installed "$p" || need+=("$p"); done

# 1) Yarıda kalmış dpkg → yapılandırmayı etkileşimsiz tamamla (yerel olarak değiştirilmiş conf'lar korunur).
#    Kilit başka bir apt/dpkg'deyse yalnız kurulacak paket varken ~2 dk bekle; yoksa bu turu atla.
repair(){
  local tries=1 i out
  if [ ${#need[@]} -gt 0 ]; then tries=24; fi
  for ((i = 1; i <= tries; i++)); do
    if out=$(dpkg --force-confdef --force-confold --configure -a 2>&1 </dev/null); then
      log "yarıda kalmış dpkg işlemi tamamlandı"; return 0
    fi
    if printf '%s\n' "$out" | grep -Eq "$LOCK_RE"; then
      if [ "$i" -lt "$tries" ]; then sleep 5; continue; fi
      log "dpkg kilidi başka bir işlemde — onarım sonraki tura ertelendi"; return 1
    fi
    log "UYARI: dpkg --configure -a başarısız:"; printf '%s\n' "$out" | tail -n 15 | indent
    return 1
  done
}
if journal_dirty; then log "dpkg yarıda kalmış (journal dolu) — onarılıyor"; repair || true; fi

if [ ${#need[@]} -eq 0 ]; then exit 0; fi

# 2) Depoda adayı olmayanları ele (ör. trixie'de chromium-browser yok): tek bir ad tüm işlemi düşürmesin.
cand=()
for p in "${need[@]}"; do
  if apt-cache policy "$p" 2>/dev/null | grep -Eq 'Candidate: [^(]'; then cand+=("$p"); else log "atlandı (depoda aday yok): $p"; fi
done
if [ ${#cand[@]} -eq 0 ]; then log "kurulabilecek paket yok"; exit 1; fi

# 3) Yarıda kesilmiş çok paketli işlemden kalan bozuk bağımlılık → önce onar (--no-remove: paket silmek yerine dur).
if ! apt-get check >/dev/null 2>&1 </dev/null; then
  log "bozuk bağımlılıklar onarılıyor (apt-get -f install)"
  apt-get "${APT_OPTS[@]}" --no-remove -f install </dev/null 2>&1 | tail -n 5 | indent
fi

log "kuruluyor: ${cand[*]}"
if apt-get "${APT_OPTS[@]}" install "${cand[@]}" </dev/null >"$APT_LOG" 2>&1; then
  log "kuruldu: ${cand[*]}"; exit 0
fi
log "ilk deneme başarısız — paket listeleri yenilenip bir kez daha denenecek"; tail -n 6 "$APT_LOG" | indent
if journal_dirty; then repair || true; fi
timeout 90 apt-get -q update </dev/null >/dev/null 2>&1 || log "UYARI: apt-get update başarısız ya da zaman aşımı"
if apt-get "${APT_OPTS[@]}" --no-remove -f install "${cand[@]}" </dev/null >"$APT_LOG" 2>&1; then
  log "kuruldu: ${cand[*]}"; exit 0
fi
log "HATA: kurulamadı: ${cand[*]}"; tail -n 12 "$APT_LOG" | indent
exit 1

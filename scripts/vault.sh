#!/usr/bin/env bash
# Klyrix Gate — bulut yedeği (restic). Yedek kullanıcının KENDİ S3 uyumlu kovasına gider (Cloudflare R2, Backblaze B2,
# AWS S3, MinIO / özel): Klyrix hiçbir hesabı ve anahtarı görmez. Root olarak çalışır.
# storage.sh'yi KAYNAKLAMAZ: onun finish()'i işin sonunda Pi-hole'u ve panel servisini başlatır, kilidi de disk işleriyle
# ortaktır. Kendi kilidi (/run/pi5-vault.lock), kendi durum dosyası (/run/pi5-vault/state, KEY=VALUE — storage.sh ile aynı
# biçim) ve kendi birimi (pi5-vault) vardır; backend (vault.ts) betiği /run/pi5-vault/vault-job.sh'ye kopyalayıp oradan
# çalıştırır (güncellemenin git reset'i çalışan betiği değiştiremesin).
#
# Depolar (aynı anahtarlarla iki ayrı restic deposu):
#   s3:<uç nokta>/<kova>/<ön ek>/config   panel ayarları (her gece; küçük — yeni cihazda listelemek hızlı ve az bellekli)
#   s3:<uç nokta>/<kova>/<ön ek>/files    seçilen klasörler (isteğe bağlı)
# Şifreleme istemci tarafında (restic: AES-256-CTR + Poly1305-AES). Kullanıcının parolası yalnız bağlanırken kullanılır
# (/run/pi5-vault/user.pass, iş bitince silinir) ve cihazda hiç saklanmaz; cihaz depoya rastgele cihaz anahtarıyla erişir
# (device.key — depoya ek restic anahtarı). Erişim anahtarı (S3) vault.conf'tadır; ikisi de yalnız root'a açıktır.
# Yapılandırma: /etc/pi5-gateway/vault/vault.conf (0600, KEY=VALUE; panel yazar, bu betik okur — kaynaklanmaz). Erişim
# anahtarı yalnız restic süreçlerinin ortamına verilir (komut satırına hiç).
#
# Komutlar:
#   status                                  durum satırları (kilitsiz, salt okunur)
#   connect --mode new|existing             (iş) bağlantı bilgisi /run/pi5-vault/pending.conf, parola .../user.pass:
#                                           new = iki depoyu oluşturur; existing = parolayla açar. Sonra cihaz anahtarını
#                                           ekler (key add), vault.conf + device.key'i yerine koyar
#   check                                   cihaz anahtarıyla depoya erişim (kısa)
#   snapshots --repo config|files           anlık görüntü listesi (JSON, kısa)
#   backup [--config-dir D] [--files] [--forget]
#                                           (iş) D: backend'in hazırladığı ayar klasörü (/run/pi5-vault altında; iş sonunda
#                                           silinir); --files: seçilen klasörler (yedek hattayken atlanır); --forget:
#                                           saklama politikası (forget --prune, yalnız bu cihazın anlık görüntüleri)
#   disconnect --remove-key                 (iş) bu cihazın anahtarını iki depodan da siler (kullanıcının parolasıyla —
#                                           restic kullanımdaki anahtarı silmez), sonra yerel bağlantıyı kaldırır
# Ortam (testler için): PI5_VAULT_DIR, PI5_VAULT_RUN, PI5_VAULT_LOCK, PI5_FAILOVER_STATUS, PI5_BASE, PI5_VAULT_T_STEP,
# PI5_VAULT_LINE_POLL.
set -uo pipefail
export LC_ALL=C
umask 077

VDIR=${PI5_VAULT_DIR:-/etc/pi5-gateway/vault}
CONF=$VDIR/vault.conf
DEVKEY=$VDIR/device.key
RUN=${PI5_VAULT_RUN:-/run/pi5-vault}
STATE=$RUN/state
OUT=$RUN/output
PENDING=$RUN/pending.conf
USERPASS=$RUN/user.pass
LOCK=${PI5_VAULT_LOCK:-/run/pi5-vault.lock}
BASE=${PI5_BASE:-/opt/pi5-gateway}
FAILOVER_STATUS=${PI5_FAILOVER_STATUS:-/run/pi5-gateway/failover.status}
DATA_MNT=/mnt/klyrix-data
# Etkileşimli adımların üst sınırı (sn): restic ulaşılamayan uç noktayı / olmayan kovayı 15 dk'ya kadar yeniden dener.
T_STEP=${PI5_VAULT_T_STEP:-90}
# Kilit bekleyen adımlar (--retry-lock 2m): başka cihazın süren yedeğinin kilidi kalkana kadar
T_LOCK=$((T_STEP + 150))
T_CONFIG=600
T_SHORT=45
# Dosya yedeği sürerken yedek hattına geçiş denetimi (sn)
LINE_POLL=${PI5_VAULT_LINE_POLL:-30}
# Eski sistem arşivlerinin (storage.sh archive: /home/<kullanıcı>/eski-sistem-arsivi-*) sistem klasörleri: eski /etc,
# /root, /opt kopyaları (parola özetleri, SSH / WireGuard anahtarları, eski panelin veritabanı) klasör yedeğine girmez
ARCHIVE_EXCLUDES=(--exclude '/home/*/eski-sistem-arsivi-*/etc' --exclude '/home/*/eski-sistem-arsivi-*/root'
                  --exclude '/home/*/eski-sistem-arsivi-*/opt')

mkdir -p "$RUN"
chmod 700 "$RUN" 2>/dev/null || true

# ── yardımcılar (storage.sh ile aynı biçim, ayrı yollar) ─────────────────────
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$OUT" >&2; }
kv() { printf '%s=%s\n' "$1" "$2"; }
JOB=0
# İş durumu: state=running|done|failed, step, pct (0-100), msg, error, cmd, started, finished (+ işin sonuç anahtarları)
setstate() {
  [ "$JOB" = 1 ] || return 0
  local tmp="$STATE.tmp.$$" k v line kvp
  declare -A cur=()
  if [ -f "$STATE" ]; then
    while IFS= read -r line; do k=${line%%=*}; [ -n "$k" ] && [ "$k" != "$line" ] && cur[$k]=${line#*=}; done < "$STATE"
  fi
  for kvp in "$@"; do k=${kvp%%=*}; v=${kvp#*=}; cur[$k]=${v//$'\n'/ }; done
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

# İş sonunda (kilit bu işteyken): parola, bekleyen bağlantı bilgisi ve yeni cihaz anahtarı /run'da kalmaz; yarım yazılmış
# geçici dosyalar ve ayar klasörü (gizli anahtarlar olabilir) silinir. SIGKILL / elektrik kesintisinde bu tuzak çalışmaz:
# /run'dakileri backend (vault.ts) iş bitince, /etc'deki yarım dosyaları açılışta siler.
STAGE=''
WATCH=''
RP=''
NEWKEY=$RUN/device.key.new
stop_watch() { # izleyicinin önce sleep'i (yoksa yetim kalır), sonra kendisi
  if [ -n "$WATCH" ]; then pkill -P "$WATCH" 2>/dev/null; kill "$WATCH" 2>/dev/null; WATCH=''; fi
  return 0
}
# Arka planda süren dosya yedeği (TERM ile iş kesildiyse): restic de durdurulur ve beklenir — iş restic'ten önce bitmesin
stop_restic() {
  if [ -n "$RP" ] && kill -0 "$RP" 2>/dev/null; then
    pkill -TERM -P "$RP" -x restic 2>/dev/null || kill -TERM "$RP" 2>/dev/null
    wait "$RP" 2>/dev/null
  fi
  RP=''
  return 0
}
cleanup() {
  stop_watch
  stop_restic
  rm -f "$USERPASS" "$PENDING" "$NEWKEY" "$CONF.tmp.$$" "$DEVKEY.tmp.$$" "$RUN/restic.err.$$" "$RUN/restic.sum.$$" \
    "$RUN/restic.fifo.$$" "$RUN/restic.fskip.$$" 2>/dev/null
  if [ -n "$STAGE" ]; then rm -rf "$STAGE" 2>/dev/null; fi
  return 0
}

# ── yapılandırma (KEY=VALUE; kaynaklanmaz, yalnız bilinen anahtarlar) ────────
declare -A C=()
read_conf() { # DOSYA
  local line k
  C=()
  [ -f "$1" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    k=${line%%=*}
    [ "$k" = "$line" ] && continue
    case "$k" in
      provider|endpoint|region|bucket|prefix|key_id|secret|host|schedule|include_secrets|folders|keep_daily|keep_weekly|keep_monthly|upload_kbps)
        C[$k]=${line#*=};;
    esac
  done < "$1"
  return 0
}
# backend (vault.ts) aynı kuralları uygular; burada yeniden denetlenir (elle düzenlenmiş dosya)
valid_conf() {
  [[ "${C[endpoint]:-}" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "uç nokta adresi geçersiz"
  [[ "${C[bucket]:-}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "kova adı geçersiz"
  [[ "${C[prefix]:-}" =~ ^([a-z0-9-]+(/[a-z0-9-]+)*)?$ ]] || die "ön ek geçersiz"
  [[ "${C[host]:-}" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "cihaz kimliği (host) geçersiz"
  [[ "${C[region]:-}" =~ ^[a-z0-9-]{0,32}$ ]] || die "bölge geçersiz"
  [[ "${C[key_id]:-}" =~ ^[A-Za-z0-9._-]{3,128}$ ]] || die "erişim anahtarı kimliği geçersiz"
  [[ "${C[secret]:-}" =~ ^[A-Za-z0-9/+=._-]{8,128}$ ]] || die "gizli erişim anahtarı geçersiz"
}
repo() { # config|files
  local p=${C[prefix]:-}
  printf 's3:%s/%s/%s%s' "${C[endpoint]}" "${C[bucket]}" "${p:+$p/}" "$1"
}
num_or() { if [[ "${1:-}" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

# restic önbelleği: veri diski bağlıysa orada (SD kart yıpranmasın), değilse /var/cache. Önbellekte yalnız şifreli veri var.
cache_dir() {
  if findmnt -n --mountpoint "$DATA_MNT" >/dev/null 2>&1; then printf '%s/vault-cache' "$DATA_MNT"; else printf '/var/cache/klyrix-vault'; fi
}
CACHE=''
PWFILE=$DEVKEY
RO=()
use_conf() { # yapılandırma okunduktan sonra: bölge seçeneği ve önbellek
  RO=()
  if [ -n "${C[region]:-}" ]; then RO=(-o "s3.region=${C[region]}"); fi
  CACHE=$(cache_dir)
}
# restic'i depo ortamıyla çalıştırır. Erişim anahtarı yalnız bu çocuk sürecin ortamındadır (komut satırında değil); ortam
# dosyası (/proc/<pid>/environ) yalnız root'a açıktır. SÜRE > 0: o kadar saniyede kesilir (timeout → çıkış 124).
rx() { # SÜRE restic-argümanları...
  local t=$1 pre=()
  shift
  if [ "$t" -gt 0 ]; then pre=(timeout "$t"); fi
  # Bellek sınırında çekirdek önce restic'i öldürsün (bu betiği değil): iş "Bellek yetmedi" diye biter, takılı kalmaz
  if have choom; then pre+=(choom -n 1000 --); fi
  AWS_ACCESS_KEY_ID=${C[key_id]} AWS_SECRET_ACCESS_KEY=${C[secret]} RESTIC_PASSWORD_FILE=$PWFILE \
    RESTIC_CACHE_DIR=$CACHE GOGC=20 RESTIC_PROGRESS_FPS=0.2 "${pre[@]}" restic "${RO[@]}" "$@"
}

# restic hatası → kullanıcıya açık Türkçe neden (ham metin günlükte kalır). restic çıkış kodları: 10 depo yok, 11 kilit
# alınamadı, 12 parola yanlış; 124 = timeout (restic ulaşamadığı yeri sessizce yeniden dener — "retrying after ..."
# satırları asıl nedeni taşır); 137 = SIGKILL (birimin bellek sınırı: OOMPolicy=continue ile yalnız restic ölür).
# restic 0.16 öncesi (Debian 12: 0.14) depo yok / kilit / parola için ayrı çıkış kodu vermez (hepsi 1): metinden
# 10 / 11 / 12'ye çevrilir, böylece aynı karar dalları eski sürümde de çalışır.
norm_rc() { # ERRDOSYASI ÇIKIŞKODU
  if [ "$2" = 1 ] && [ -s "$1" ]; then
    # Ağ / sertifika hatası 0.14'te de "Is there a repository…" satırıyla gelir: önce bunlar (explain_text açıklar)
    if grep -qE 'no such host|dial tcp|connection refused|i/o timeout|network is unreachable|server misbehaving|x509|certificate' "$1"; then echo "$2"; return; fi
    if grep -q 'wrong password or no key found' "$1"; then echo 12; return; fi
    if grep -qE 'Is there a repository at the following location|repository does not exist' "$1"; then echo 10; return; fi
    if grep -q 'repository is already locked' "$1"; then echo 11; return; fi
  fi
  echo "$2"
}
explain() { # ERRDOSYASI ÇIKIŞKODU
  local t
  t=$(tr -d '\r' < "$1" 2>/dev/null | tail -n 40)
  case "$(norm_rc "$1" "$2")" in
    12) echo "Parola yanlış (bu depoyu açan bir anahtar yok)"; return 0;;
    10) echo "Bu konumda depo yok — «Yeni depo» seçin ya da kova adını / ön eki denetleyin"; return 0;;
    11) echo "Depo başka bir işlem tarafından kilitli — birazdan yeniden deneyin"; return 0;;
    124) explain_text "$t"; return 0;;
    137) echo "Bellek yetmedi (restic) — klasör sayısını azaltın ya da yalnız ayarları yedekleyin"; return 0;;
  esac
  case "$t" in
    *'wrong password or no key found'*) echo "Parola yanlış (bu depoyu açan bir anahtar yok)";;
    *'master key and config already initialized'*|*'config file already exists'*)
      echo "Bu konumda zaten bir depo var — «Var olan depoya bağlan» seçin ya da başka bir ön ek yazın";;
    *'repository does not exist'*) echo "Bu konumda depo yok — «Yeni depo» seçin ya da kova adını / ön eki denetleyin";;
    *) explain_text "$t";;
  esac
}
# S3 hataları: restic çoğu zaman kodu (SignatureDoesNotMatch) değil S3'ün iletisini yazar — ikisi de aranır. "retrying
# after" satırlarındaki asıl neden "zamanında yanıt vermedi"den (son dal) önce eşleşir.
explain_text() {
  local last
  case "$1" in
    *'specified bucket does not exist'*|*NoSuchBucket*) echo "Kova bulunamadı — kova adını ve uç noktayı denetleyin";;
    *'signature we calculated does not match'*|*SignatureDoesNotMatch*|*RequestTimeTooSkewed*|*'difference between the request time and the current time'*)
      echo "İstek imzası reddedildi — gizli anahtar yanlış ya da cihazın saati kaymış";;
    *InvalidAccessKeyId*|*'Access Key Id you provided does not exist'*|*'Access Denied'*|*AccessDenied*|*Forbidden*|*Unauthorized*)
      echo "Erişim reddedildi — erişim anahtarı / gizli anahtar ya da kova izni yanlış";;
    *'no such host'*|*'server misbehaving'*|*'connection refused'*|*'network is unreachable'*|*'i/o timeout'*|*'dial tcp'*)
      echo "Bulut deposuna ulaşılamadı — uç nokta adresini ve internet bağlantısını denetleyin";;
    *x509*|*certificate*) echo "Güvenli bağlantı kurulamadı (sertifika) — uç nokta adresini ve cihazın saatini denetleyin";;
    *'context canceled'*|*'context deadline exceeded'*|'') echo "Bulut deposu zamanında yanıt vermedi — bağlantıyı denetleyip yeniden deneyin";;
    *) last=$(printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -n 1 | cut -c1-200)
       echo "restic hatası: ${last:-bilinmeyen hata}";;
  esac
}
fail_restic() { # ADIM ERRDOSYASI ÇIKIŞKODU
  sed 's/^/    /' "$2" >> "$OUT" 2>/dev/null
  die "$1: $(explain "$2" "$3")"
}

# SigV4 imzası doğru saat ister: ilk açılışta (RTC yok) NTP eşitlenmeden istek reddedilir.
clock_check() {
  local v
  [ "$(date +%Y)" -ge 2025 ] || die "Cihazın saati yanlış ($(date '+%Y-%m-%d')) — internet saati (NTP) eşitlenince yeniden deneyin"
  have timedatectl || return 0
  v=$(timedatectl show -p NTPSynchronized --value 2>/dev/null) || return 0
  [ "$v" != no ] || die "Cihazın saati henüz internet saatiyle (NTP) eşitlenmedi — bulut deposu doğru saat ister; birkaç dakika sonra yeniden deneyin"
}

ensure_restic() { # PCT
  if have restic; then restic_caps; return 0; fi
  step "$1" "restic kuruluyor (ilk kullanım, birkaç dakika sürebilir)"
  bash "$BASE/scripts/pkg-ensure.sh" restic >>"$OUT" 2>&1 </dev/null
  if ! have restic; then
    # Paket listesi hiç yoksa pkg-ensure paketi "depoda aday yok" diye atlar: liste bir kez yenilenip yeniden denenir
    log "paket listesi yenileniyor (apt-get update)"
    timeout 180 apt-get -q -o DPkg::Lock::Timeout=120 update >>"$OUT" 2>&1 </dev/null || log "UYARI: apt-get update başarısız"
    bash "$BASE/scripts/pkg-ensure.sh" restic >>"$OUT" 2>&1 </dev/null
  fi
  have restic || die "restic kurulamadı — ayrıntı günlükte"
  restic_caps
}

# Sürüme göre seçenekler: Debian 12 (bookworm) restic 0.14 --retry-lock (0.16+) ve backup --read-concurrency (0.15+)
# tanımaz; desteklenmeyen seçenek hiç verilmez (kilit beklemesi yerine yalnız bayat kilit temizliği, varsayılan okuma).
RL=(); RCONC=()
restic_caps() {
  local v maj min
  RL=(); RCONC=()
  # Tek çağrı (bellek sınırlı birimde fazladan restic süreci açılmasın): "restic 0.18.0 compiled with ..."
  v=$(restic version 2>/dev/null); v=${v#restic }; v=${v%% *}
  maj=${v%%.*}; min=${v#*.}; min=${min%%.*}
  if [[ "$maj" =~ ^[0-9]+$ ]] && [[ "$min" =~ ^[0-9]+$ ]]; then
    if [ "$maj" -gt 0 ] || [ "$min" -ge 16 ]; then RL=(--retry-lock 2m); fi
    if [ "$maj" -gt 0 ] || [ "$min" -ge 15 ]; then RCONC=(--read-concurrency 1); fi
  fi
  log "restic ${v:-?} (kilit bekleme: ${RL[*]:-yok})"
}

# Klasör kökü izin listesi (gerçek yol; backend aynısını denetler): paylaşım alanı, ağda paylaşılan USB diskler, ev
# dizinleri, /srv. /etc, /root, /var/log, panel verileri ve Pi-hole veritabanı bu köklerin dışındadır (ayarlar zaten
# config.json'da). Eski sistem arşivi ya da içindeki bir klasör kök olamaz (bkz. ARCHIVE_EXCLUDES).
allowed_root() {
  case "$1" in
    */eski-sistem-arsivi-*) return 1;;
  esac
  case "$1" in
    /mnt/klyrix-share/Paylasim|/mnt/klyrix-share/Paylasim/*) return 0;;
    /mnt/klyrix-usb/?*|/home/?*|/srv/?*) return 0;;
  esac
  return 1
}

human() { # BAYT → "1.2 GB" / "35 MB" / "4 KB"
  awk -v b="${1:-0}" 'BEGIN { if (b >= 1e9) printf "%.1f GB", b / 1e9; else if (b >= 1e6) printf "%.0f MB", b / 1e6; else printf "%.0f KB", b / 1e3 }'
}
pair() { # YAPILAN TOPLAM → "12.3/30.0 GB" (birim toplamınki)
  awk -v d="${1:-0}" -v t="${2:-0}" 'BEGIN { if (t >= 1e9) printf "%.1f/%.1f GB", d / 1e9, t / 1e9; else if (t >= 1e6) printf "%.0f/%.0f MB", d / 1e6, t / 1e6; else printf "%.0f/%.0f KB", d / 1e3, t / 1e3 }'
}
jnum() { # ALAN JSON-SATIRI → sayı (yoksa boş)
  if [[ "$2" =~ \"$1\":(-?[0-9][0-9.eE+-]*) ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}
jstr() { # ALAN JSON-SATIRI → kısa dize değeri (yoksa boş)
  if [[ "$2" =~ \"$1\":\"([^\"]*)\" ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}

# restic backup --json akışı (stdin): durum satırları → pct/step (P0..P1 aralığında), özet satırı → ÖZETDOSYASI.
progress() { # ETİKET P0 P1 ÖZETDOSYASI
  local label=$1 p0=$2 p1=$3 sumf=$4 line pd tb bd pct shown
  while IFS= read -r line; do
    case "$line" in
      *'"message_type":"status"'*)
        pd=$(jnum percent_done "$line"); tb=$(jnum total_bytes "$line"); bd=$(jnum bytes_done "$line")
        pct=$(awk -v a="$p0" -v b="$p1" -v p="${pd:-0}" 'BEGIN { if (p > 1) p = 1; printf "%d", a + (b - a) * p }')
        shown=$(awk -v p="${pd:-0}" 'BEGIN { if (p > 1) p = 1; printf "%d", p * 100 }')
        setstate "pct=$pct" "step=$label: $shown% · $(pair "${bd:-0}" "${tb:-0}")"
        ;;
      *'"message_type":"summary"'*) printf '%s\n' "$line" > "$sumf";;
    esac
  done
}
summary_msg() { # ÖZETDOSYASI → "3 yeni, 2 değişen dosya, 1.2 MB eklendi"
  local s n c a
  s=$(cat "$1" 2>/dev/null) || return 0
  n=$(jnum files_new "$s"); c=$(jnum files_changed "$s"); a=$(jnum data_added "$s")
  printf '%s yeni, %s değişen dosya, %s eklendi' "${n:-0}" "${c:-0}" "$(human "${a:-0}")"
}

# Yedek hattında (failover active=backup — çoğu zaman kotalı mobil hat) dosyalar yüklenmez; ayarlar yine yedeklenir.
on_backup_line() { grep -qx 'active=backup' "$FAILOVER_STATUS" 2>/dev/null; }
# Dosya yedeği sürerken (saatlerce sürebilir) yedek hattına geçilirse yükleme durdurulur: restic'e SIGINT (anlık görüntü
# yazılmaz, yüklenen parçalar sonraki yedekte kullanılır). İşaret dosyası çağırana "hat değişti" der.
line_watch() { # RESTIC_PID İŞARET_DOSYASI
  while sleep "$LINE_POLL"; do
    kill -0 "$1" 2>/dev/null || return 0
    if on_backup_line; then
      : > "$2"
      pkill -INT -P "$1" -x restic 2>/dev/null || kill -INT "$1" 2>/dev/null
      return 0
    fi
  done
}

# ── komutlar ─────────────────────────────────────────────────────────────────
cmd_status() {
  local v=''
  if have restic; then v=$(restic version 2>/dev/null | awk '{print $2; exit}'); fi
  kv restic "$v"
  if [ -f "$CONF" ] && [ -s "$DEVKEY" ]; then kv configured 1; else kv configured 0; fi
  if [ -e "$LOCK" ] && ! flock -n "$LOCK" true 2>/dev/null; then kv running 1; else kv running 0; fi
  kv cache "$(cache_dir)"
}

# Kısa komutlar (check / snapshots): hata stdout'ta error=... (backend share.ts deseniyle okur)
load_conf_short() {
  read_conf "$CONF" || { kv error "Bulut yedeği bağlı değil"; exit 1; }
  [ -s "$DEVKEY" ] || { kv error "Cihaz anahtarı yok — bağlantıyı kaldırıp yeniden kurun"; exit 1; }
  have restic || { kv error "restic kurulu değil — ilk yedekte kurulur"; exit 1; }
  use_conf
  PWFILE=$DEVKEY
}
short_fail() { # ERRDOSYASI ÇIKIŞKODU
  kv error "$(explain "$1" "$2")"
  rm -f "$1"
  exit 1
}

cmd_check() {
  load_conf_short
  local e="$RUN/restic.err.$$" rc
  rx "$T_SHORT" -r "$(repo config)" --no-lock cat config >/dev/null 2>"$e"; rc=$?
  [ "$rc" = 0 ] || short_fail "$e" "$rc"
  rm -f "$e"
  kv ok 1
}

cmd_snapshots() {
  local r='' o rc e="$RUN/restic.err.$$"
  while [ $# -gt 0 ]; do case "$1" in --repo) r=${2:-}; shift 2;; *) shift;; esac; done
  [ "$r" = config ] || [ "$r" = files ] || { kv error "depo config ya da files olmalı"; exit 2; }
  load_conf_short
  o=$(rx "$T_SHORT" -r "$(repo "$r")" --no-lock snapshots --json 2>"$e"); rc=$?
  [ "$rc" = 0 ] || short_fail "$e" "$rc"
  rm -f "$e"
  printf '%s\n' "$o"
}

cmd_connect() {
  local mode='' e="$RUN/restic.err.$$" rc how
  while [ $# -gt 0 ]; do case "$1" in --mode) mode=${2:-}; shift 2;; *) shift;; esac; done
  [ "$mode" = new ] || [ "$mode" = existing ] || die "geçersiz bağlantı kipi"
  [ -f "$CONF" ] && die "Bulut yedeği zaten bağlı — önce bağlantıyı kaldırın"
  read_conf "$PENDING" || die "bağlantı bilgisi bulunamadı"
  valid_conf
  [ -s "$USERPASS" ] || die "parola dosyası bulunamadı"
  use_conf
  step 5 "Ön denetim (saat, restic)"
  clock_check
  ensure_restic 8
  PWFILE=$USERPASS
  if [ "$mode" = new ]; then
    step 20 "Depolar oluşturuluyor (ayarlar)"
    rx "$T_STEP" -r "$(repo config)" init >>"$OUT" 2>"$e"; rc=$?
    [ "$rc" = 0 ] || fail_restic "Ayar deposu oluşturulamadı" "$e" "$rc"
    step 35 "Depolar oluşturuluyor (dosyalar)"
    rx "$T_STEP" -r "$(repo files)" init >>"$OUT" 2>"$e"; rc=$?
    [ "$rc" = 0 ] || fail_restic "Dosya deposu oluşturulamadı" "$e" "$rc"
  else
    step 20 "Parola denetleniyor (ayar deposu)"
    rx "$T_STEP" -r "$(repo config)" --no-lock cat config >/dev/null 2>"$e"; rc=$?
    [ "$rc" = 0 ] || fail_restic "Ayar deposu açılamadı" "$e" "$rc"
    step 35 "Parola denetleniyor (dosya deposu)"
    rx "$T_STEP" -r "$(repo files)" --no-lock cat config >/dev/null 2>"$e"; rc=$?; rc=$(norm_rc "$e" "$rc")
    if [ "$rc" = 10 ]; then
      # Ayar deposu var, dosya deposu yok (ör. yarıda kalmış bir "Yeni depo"): aynı parolayla oluşturulur
      log "dosya deposu yok — oluşturuluyor"
      rx "$T_STEP" -r "$(repo files)" init >>"$OUT" 2>"$e"; rc=$?
      [ "$rc" = 0 ] || fail_restic "Dosya deposu oluşturulamadı" "$e" "$rc"
    elif [ "$rc" != 0 ]; then
      fail_restic "Dosya deposu açılamadı" "$e" "$rc"
    fi
    # Var olan depoda yarıda kalmış bir işin (elektrik kesintisi, başka cihazın ölen budaması) bayat kilidi anahtar
    # eklemeyi engellemesin: unlock yalnız bayat kilitleri siler; canlı kilit için key add --retry-lock ile bekler
    step 45 "Depo kilitleri denetleniyor"
    rx "$T_STEP" -r "$(repo config)" unlock >>"$OUT" 2>"$e" || log "ayar deposu kilidi denetlenemedi: $(explain "$e" 1)"
    rx "$T_STEP" -r "$(repo files)" unlock >>"$OUT" 2>"$e" || log "dosya deposu kilidi denetlenemedi: $(explain "$e" 1)"
  fi
  # Cihaz anahtarı: 32 rastgele bayt (hex). Önce /run'da (tmpfs, 0700) üretilir: iş elektrik kesintisinde ya da SIGKILL'le
  # yarıda kalırsa kalıcı diskte depoyu açan bir anahtar kalmaz. Depoya ek restic anahtarı olarak eklenir; insan parolası
  # depoda geçerli kalır (kurtarma kiti + parola ile başka bir cihazdan açılır).
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$NEWKEY" || die "cihaz anahtarı üretilemedi"
  chmod 600 "$NEWKEY"
  [ "$(wc -c < "$NEWKEY")" -eq 64 ] || die "cihaz anahtarı üretilemedi"
  step 55 "Cihaz anahtarı ekleniyor (ayarlar)"
  rx "$T_LOCK" -r "$(repo config)" "${RL[@]}" key add --host "${C[host]}" --new-password-file "$NEWKEY" >>"$OUT" 2>"$e"; rc=$?
  [ "$rc" = 0 ] || fail_restic "Cihaz anahtarı eklenemedi" "$e" "$rc"
  step 70 "Cihaz anahtarı ekleniyor (dosyalar)"
  rx "$T_LOCK" -r "$(repo files)" "${RL[@]}" key add --host "${C[host]}" --new-password-file "$NEWKEY" >>"$OUT" 2>"$e"; rc=$?
  [ "$rc" = 0 ] || fail_restic "Cihaz anahtarı eklenemedi" "$e" "$rc"
  step 85 "Cihaz anahtarı doğrulanıyor"
  PWFILE=$NEWKEY
  rx "$T_STEP" -r "$(repo config)" --no-lock cat config >/dev/null 2>"$e"; rc=$?
  [ "$rc" = 0 ] || fail_restic "Cihaz anahtarı doğrulanamadı" "$e" "$rc"
  # Yerine koy (0700 klasörde 0600 dosyalar): önce anahtar, sonra yapılandırma (yapılandırma varsa anahtar da vardır)
  { mkdir -p "$VDIR" && chmod 700 "$VDIR"; } || die "$VDIR oluşturulamadı"
  { install -m 600 "$NEWKEY" "$DEVKEY.tmp.$$" && mv -f "$DEVKEY.tmp.$$" "$DEVKEY"; } || die "cihaz anahtarı kaydedilemedi"
  { install -m 600 "$PENDING" "$CONF.tmp.$$" && mv -f "$CONF.tmp.$$" "$CONF"; } || die "yapılandırma kaydedilemedi"
  rm -f "$NEWKEY" "$e"
  how="yeni depolar oluşturuldu"
  [ "$mode" = existing ] && how="var olan depoya bağlanıldı"
  log "bağlandı: ${C[endpoint]}/${C[bucket]}/${C[prefix]:-} (cihaz: ${C[host]})"
  setstate state=done pct=100 "step=Tamamlandı" "msg=Bulut yedeği bağlandı: $how (${C[bucket]}/${C[prefix]:-})" "finished=$(date +%s)"
}

cmd_backup() {
  local cfgdir='' files=0 forget=0 real runreal f skipped='' fskip=''
  local folders=() list=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --config-dir) cfgdir=${2:-}; shift 2;;
      --files) files=1; shift;;
      --forget) forget=1; shift;;
      *) shift;;
    esac
  done
  if [ -n "$cfgdir" ]; then
    # Yalnız /run/pi5-vault altındaki hazırlık klasörü kabul edilir (iş sonunda silinir)
    real=$(realpath -e "$cfgdir" 2>/dev/null) || die "ayar klasörü bulunamadı: $cfgdir"
    runreal=$(realpath -e "$RUN")
    case "$real" in "$runreal"/?*) STAGE=$real;; *) die "ayar klasörü $RUN altında olmalı";; esac
    [ -f "$STAGE/config.json" ] || die "ayar dosyası (config.json) hazırlanmamış"
  fi
  read_conf "$CONF" || die "Bulut yedeği bağlı değil"
  valid_conf
  [ -s "$DEVKEY" ] || die "cihaz anahtarı yok — bağlantıyı kaldırıp yeniden kurun"
  use_conf
  PWFILE=$DEVKEY
  step 2 "Ön denetim (saat, restic)"
  clock_check
  ensure_restic 4

  # Klasörler (| ile ayrılmış): izin listesindeki var olan dizinler (gerçek yol). Kaybolan / izinsiz olan atlanır.
  if [ "$files" = 1 ]; then
    IFS='|' read -r -a list <<< "${C[folders]:-}"
    for f in "${list[@]}"; do
      [ -n "$f" ] || continue
      real=$(realpath -e "$f" 2>/dev/null) || { log "klasör yok, atlandı: $f"; continue; }
      if [ -d "$real" ] && allowed_root "$real"; then folders+=("$real"); else log "izin verilmeyen klasör, atlandı: $f"; fi
    done
    if on_backup_line; then
      skipped='yedek hattayken dosyalar atlandı'
      fskip=backup
      log "$skipped (kotalı hat; ayarlar yine yedeklenir)"
      files=0
    elif [ ${#folders[@]} -eq 0 ]; then
      log "yedeklenecek klasör yok"
      files=0
    fi
  fi
  if [ -z "$STAGE" ] && [ "$files" = 0 ] && [ "$forget" = 0 ]; then
    if [ -n "$skipped" ]; then
      setstate state=done pct=100 "step=Tamamlandı" "msg=Yedeklenecek bir şey kalmadı: $skipped" "files_skipped=$fskip" "finished=$(date +%s)"
      return 0
    fi
    die "yedeklenecek bir şey yok"
  fi

  local e="$RUN/restic.err.$$" sumf="$RUN/restic.sum.$$" rc limit=() msg='' up snap fsum fsnap unread keep p_cfg_end=90
  up=$(num_or "${C[upload_kbps]:-}" 0)
  if [ "$up" -gt 0 ]; then limit=(--limit-upload "$up"); fi
  local host=${C[host]}

  # Yarıda kesilmiş bir işin (elektrik kesintisi, SIGKILL) bıraktığı eski kilitler: restic unlock yalnız bayatları siler
  step 5 "Depo kilitleri denetleniyor"
  rx "$T_STEP" -r "$(repo config)" unlock >>"$OUT" 2>"$e" || log "ayar deposu kilidi denetlenemedi: $(explain "$e" 1)"
  # Dosya deposu: klasör seçiliyse yalnız-ayarlar turunda da (yedek hattı, «Yalnız ayarlar») — yarıda kesilmiş bir dosya
  # yedeğinin bayat kilidi aksi hâlde bir sonraki dosya yedeğine ya da bağlantıyı kaldırmaya kadar kalırdı
  if [ "$files" = 1 ] || [ -n "${C[folders]:-}" ]; then
    rx "$T_STEP" -r "$(repo files)" unlock >>"$OUT" 2>"$e" || log "dosya deposu kilidi denetlenemedi: $(explain "$e" 1)"
  fi

  [ "$files" = 1 ] && p_cfg_end=15
  if [ -n "$STAGE" ]; then
    step 8 "Ayarlar yükleniyor"
    rm -f "$sumf"
    rx "$T_CONFIG" -r "$(repo config)" "${RL[@]}" backup --json --host "$host" --tag config "${limit[@]}" "$STAGE" \
      2>"$e" | progress "Ayarlar" 8 "$p_cfg_end" "$sumf"
    rc=${PIPESTATUS[0]}
    [ "$rc" = 0 ] || fail_restic "Ayarlar yedeklenemedi" "$e" "$rc"
    snap=$(jstr snapshot_id "$(cat "$sumf" 2>/dev/null)")
    msg="Ayarlar yedeklendi (${snap:0:8})"
    log "$msg — $(summary_msg "$sumf")"
    setstate cfg_ok=1 "cfg_snap=${snap:0:8}" "cfg_added=$(jnum data_added "$(cat "$sumf" 2>/dev/null)")"
  fi

  if [ "$files" = 1 ]; then
    step "$p_cfg_end" "Dosyalar taranıyor: ${folders[*]}"
    rm -f "$sumf"
    # restic arka planda (FIFO üzerinden ilerleme okuyucusuna): line_watch yedek hattına geçişte onu durdurabilsin, TERM
    # tuzağı da restic bitmeden çalışsın (wait kesilebilir)
    local fifo="$RUN/restic.fifo.$$" fskipf="$RUN/restic.fskip.$$" pp
    rm -f "$fifo" "$fskipf"
    mkfifo -m 600 "$fifo" || die "geçici dosya oluşturulamadı ($fifo)"
    # Okuyucu ve izleyici iş kilidini (fd 9) devralmaz: iş bitince kilit hemen bırakılsın
    progress "Dosyalar" "$p_cfg_end" 90 "$sumf" < "$fifo" 9>&- &
    pp=$!
    rx 0 -r "$(repo files)" "${RL[@]}" backup --json --host "$host" --tag files --exclude-caches \
      "${RCONC[@]}" --exclude "$CACHE" --exclude "$RUN" "${ARCHIVE_EXCLUDES[@]}" "${limit[@]}" "${folders[@]}" \
      2>"$e" > "$fifo" &
    RP=$!
    line_watch "$RP" "$fskipf" 9>&- &
    WATCH=$!
    wait "$RP"; rc=$?
    RP=''
    stop_watch
    wait "$pp"
    rm -f "$fifo"
    if [ -f "$fskipf" ]; then
      # Yükleme sırasında yedek hattına geçildi: dosyalar bu turda atlanır (ayarlar yüklendi; budama da dosya deposunu atlar)
      rm -f "$fskipf"
      fskip=backup
      skipped="${skipped:+$skipped; }yedek hattına geçildi: dosya yüklemesi durduruldu, sonraki yedekte kaldığı yerden sürer"
      log "$skipped (restic çıkış kodu $rc)"
      files=0
    else
      if [ "$rc" = 3 ]; then
        # Anlık görüntü alındı ama bazı dosyalar okunamadı (izin, yarıda silinen dosya): uyarıyla başarı
        unread=$(grep -c '"message_type":"error"' "$e")
        tail -n 20 "$e" | sed 's/^/    /' >> "$OUT"
        skipped="${skipped:+$skipped; }${unread} dosya okunamadı (ayrıntı günlükte)"
      elif [ "$rc" != 0 ]; then
        fail_restic "Dosyalar yedeklenemedi" "$e" "$rc"
      fi
      fsum=$(cat "$sumf" 2>/dev/null)
      fsnap=$(jstr snapshot_id "$fsum")
      msg="${msg:+$msg · }Dosyalar: $(summary_msg "$sumf")"
      log "dosyalar yedeklendi (${fsnap:0:8}) — $(summary_msg "$sumf"), taranan $(human "$(jnum total_bytes_processed "$fsum")")"
      setstate files_ok=1 "files_snap=${fsnap:0:8}" "files_added=$(jnum data_added "$fsum")" "files_total=$(jnum total_bytes_processed "$fsum")"
    fi
  fi

  if [ "$forget" = 1 ]; then
    # Saklama: yalnız BU cihazın (host) anlık görüntüleri; her etiket ayrı grup. Dosya deposu yalnız dosyalar bu turda
    # yüklendiyse budanır (budama veri indirip yükleyebilir — yedek hattında yapılmaz).
    keep=(--keep-daily "$(num_or "${C[keep_daily]:-}" 7)" --keep-weekly "$(num_or "${C[keep_weekly]:-}" 4)"
          --keep-monthly "$(num_or "${C[keep_monthly]:-}" 6)")
    step 92 "Eski anlık görüntüler temizleniyor (ayarlar)"
    rx "$T_CONFIG" -r "$(repo config)" "${RL[@]}" forget --host "$host" --group-by host,tags --tag config \
      "${keep[@]}" --prune >>"$OUT" 2>"$e"; rc=$?
    [ "$rc" = 0 ] || fail_restic "Eski ayar yedekleri temizlenemedi" "$e" "$rc"
    if [ "$files" = 1 ]; then
      step 95 "Eski anlık görüntüler temizleniyor (dosyalar)"
      rx 0 -r "$(repo files)" "${RL[@]}" forget --host "$host" --group-by host,tags --tag files \
        "${keep[@]}" --prune >>"$OUT" 2>"$e"; rc=$?
      [ "$rc" = 0 ] || fail_restic "Eski dosya yedekleri temizlenemedi" "$e" "$rc"
    fi
    setstate forget_ok=1
    msg="${msg:+$msg · }eski anlık görüntüler temizlendi"
  fi
  if [ -n "$skipped" ]; then msg="${msg:+$msg · }$skipped"; fi
  rm -f "$e" "$sumf"
  if [ -n "$fskip" ]; then setstate "files_skipped=$fskip"; fi
  setstate state=done pct=100 "step=Tamamlandı" "msg=${msg:-Yedek tamamlandı}" "finished=$(date +%s)"
}

# Bağlantıyı kaldırırken bu cihazın anahtarını depodan silmek: anahtarın kimliği, cihaz anahtarıyla açılınca "current"
# olandır; silme kullanıcının parolasıyla yapılır. Yerel yapılandırma ancak iki depoda da silinince kaldırılır.
#  1) Önce iki depodaki kimlik bulunur (silmeden önce; cihaz anahtarı silinen depoyu bir daha açamaz).
#  2) Bayat kilitler (yarıda kalmış yedek) silinir; canlı kilit için (başka cihazın gecelik yedeği) --retry-lock bekler.
#  3) Önce dosya deposundan, EN SON ayar deposundan silinir: yarıda kalırsa gecelik ayar yedeği çalışmaya devam eder.
#  Yeniden denemede anahtarı zaten silinmiş depo (cihaz anahtarı açamıyor: çıkış 12) atlanır.
KEY_RE='\{"current":true,"id":"([0-9a-f]{8,64})"'  # restic 0.14 kısa (8 hane) kimlik verir; key remove önek kabul eder
cmd_disconnect() {
  local rm_key=0 r keys id e="$RUN/restic.err.$$" rc pct=10 gone=0
  local -A kid=()
  while [ $# -gt 0 ]; do case "$1" in --remove-key) rm_key=1; shift;; *) shift;; esac; done
  [ "$rm_key" = 1 ] || die "kullanım: disconnect --remove-key"
  read_conf "$CONF" || die "Bulut yedeği bağlı değil"
  valid_conf
  [ -s "$DEVKEY" ] || die "cihaz anahtarı yok"
  [ -s "$USERPASS" ] || die "parola dosyası bulunamadı"
  use_conf
  step 5 "Ön denetim (saat, restic)"
  clock_check
  have restic || die "restic kurulu değil"
  restic_caps
  PWFILE=$DEVKEY
  for r in files config; do
    step "$pct" "Cihaz anahtarı bulunuyor ($r)"
    keys=$(rx "$T_STEP" -r "$(repo "$r")" --no-lock key list --json 2>"$e"); rc=$?; rc=$(norm_rc "$e" "$rc")
    if [ "$rc" = 12 ]; then
      log "cihaz anahtarı bu depoda zaten yok ($r) — atlandı"
      kid[$r]=''
      gone=$((gone + 1))
    else
      [ "$rc" = 0 ] || fail_restic "Anahtar listesi okunamadı" "$e" "$rc"
      id=''
      if [[ "$keys" =~ $KEY_RE ]]; then id=${BASH_REMATCH[1]}; fi
      [ -n "$id" ] || die "Bu cihazın anahtarı listede bulunamadı ($r)"
      kid[$r]=$id
      rx "$T_STEP" -r "$(repo "$r")" unlock >>"$OUT" 2>"$e" || log "kilit denetlenemedi ($r): $(explain "$e" 1)"
    fi
    pct=$((pct + 10))
  done
  PWFILE=$USERPASS
  for r in files config; do
    [ -n "${kid[$r]}" ] || continue
    step "$pct" "Cihaz anahtarı siliniyor ($r)"
    rx "$T_LOCK" -r "$(repo "$r")" "${RL[@]}" key remove "${kid[$r]}" >>"$OUT" 2>"$e"; rc=$?
    if [ "$rc" != 0 ]; then
      if [ "$r" = files ]; then fail_restic "Cihaz anahtarı dosya deposundan silinemedi" "$e" "$rc"; fi
      fail_restic "Cihaz anahtarı ayar deposundan silinemedi (dosya deposundan silindi; yeniden deneyin)" "$e" "$rc"
    fi
    log "cihaz anahtarı silindi ($r): ${kid[$r]:0:8}"
    pct=$((pct + 30))
  done
  rm -f "$CONF" "$DEVKEY" "$e"
  rm -rf /var/cache/klyrix-vault "$DATA_MNT/vault-cache" 2>/dev/null
  if [ "$gone" = 2 ]; then
    setstate state=done pct=100 "step=Tamamlandı" "msg=Bulut yedeği bağlantısı kaldırıldı; bu cihazın anahtarı depoda zaten yoktu" "finished=$(date +%s)"
  else
    setstate state=done pct=100 "step=Tamamlandı" "msg=Bulut yedeği bağlantısı kaldırıldı; bu cihazın anahtarı depodan silindi" "finished=$(date +%s)"
  fi
}

# ── giriş ────────────────────────────────────────────────────────────────────
# Betiğin kendisi bellek sınırında en son öldürülsün (restic rx içinde choom ile en önce): böylece restic belleği
# aşınca iş "Bellek yetmedi" diye biter. -500 öldürülemez değildir; başka süreç kalmazsa çekirdek yine seçebilir.
{ echo -500 > /proc/self/oom_score_adj; } 2>/dev/null || true
cmd=${1:-status}; shift || true
case "$cmd" in
  status) cmd_status; exit 0;;
  check|snapshots|connect|backup|disconnect) ;;
  *) echo "kullanım: vault.sh status|connect|check|snapshots|backup|disconnect" >&2; exit 2;;
esac
[ "$(id -u)" = 0 ] || { kv error "root gerekli"; exit 1; }
case "$cmd" in
  check) cmd_check; exit 0;;
  snapshots) cmd_snapshots "$@"; exit 0;;
esac
exec 9>"$LOCK"
if ! flock -n 9; then
  # Panelin başlattığı iş (durumu backend yazdı) kilidi alamadıysa durum "sürüyor" diye kalmasın. Kilitteki işin
  # dosyalarına (parola, hazırlık) dokunulmaz.
  if [ -n "${PI5_VAULT_ID:-}" ] && grep -qx "id=$PI5_VAULT_ID" "$STATE" 2>/dev/null; then JOB=1; die "başka bir bulut yedeği işi sürüyor"; fi
  kv error "başka bir bulut yedeği işi sürüyor"; exit 1
fi
JOB=1
trap cleanup EXIT
trap 'die "iş durduruldu (süre sınırı ya da systemctl stop)"' TERM
if [ -n "${PI5_VAULT_ID:-}" ]; then
  # Panelin işi: durum dosyasını backend yeni yazdı (yalnız bu işin anahtarları — ör. files_skipped=backup kalır)
  setstate state=running "cmd=$cmd" "started=$(date +%s)" "id=$PI5_VAULT_ID" error= msg= step= pct=0 finished=
else
  : > "$OUT"
  setstate state=running "cmd=$cmd" "started=$(date +%s)" "id=$(date +%s)" error= msg= step= pct=0 finished= \
    cfg_ok= cfg_snap= cfg_added= files_ok= files_snap= files_added= files_total= files_skipped= forget_ok=
fi
case "$cmd" in
  connect) cmd_connect "$@";;
  backup) cmd_backup "$@";;
  disconnect) cmd_disconnect "$@";;
esac

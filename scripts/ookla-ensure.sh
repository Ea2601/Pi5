#!/bin/bash
# Klyrix Gate — hız testi motoru: Ookla Speedtest CLI (resmi). En yakın sunucuyu gecikmeye göre kendisi seçer, çoklu
# bağlantı kullanır, jitter ve paket kaybını gerçekten ölçer. Eski Python speedtest-cli, sunucu listesini Speedtest'in
# eski servisinden alıyordu; o servis BAE bağlantısına yalnız Almanya/Polonya sunucuları döndürüyordu (2026-09-28).
# post-update.sh ve install.sh çağırır; elle: sudo bash /opt/pi5-gateway/scripts/ookla-ensure.sh
# Resmi paket (install.speedtest.net) sabit sürüm + paket ve program SHA256'sıyla doğrulanır. Debian'ın speedtest-cli
# paketi de /usr/bin/speedtest adını kullandığından program /usr/local/bin/ookla-speedtest adıyla kurulur. Kurulamazsa
# panel speedtest-cli'ye düşer (backend/src/speedtest.ts). Çıktı satırları "[ookla]" önekli.
set -u
VER=1.2.0
DEST=/usr/local/bin/ookla-speedtest
case "$(uname -m)" in
  aarch64|arm64)
    ARCH=aarch64
    PKG_SUM=3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3
    BIN_SUM=d99fa13293f658b53eaa79fe81f4b210db39fdfc1e9698f33da3f234a6008df7 ;;
  armv7l|armv6l)
    ARCH=armhf
    PKG_SUM=e45fcdebbd8a185553535533dd032d6b10bc8c64eee4139b1147b9c09835d08d
    BIN_SUM=66ad57568664e6f8580e14ad67316a57038fd22b30548bef98531df4ebcc8956 ;;
  x86_64)
    ARCH=x86_64
    PKG_SUM=5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7
    BIN_SUM=31f1124c5ab8acdae6b9fe1741e704df420f9f2e7d429679fabe62075453c051 ;;
  *)
    echo "[ookla] desteklenmeyen mimari: $(uname -m) — hız testi speedtest-cli ile sürer"
    exit 0 ;;
esac

sum_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Kurulu program doğru sürümse (özeti tutuyorsa) bir şey yapılmaz; bozuk ya da değiştirilmişse yeniden kurulur.
if [ -x "$DEST" ] && [ "$(sum_of "$DEST")" = "$BIN_SUM" ]; then exit 0; fi

TMP=$(mktemp -d) || { echo "[ookla] HATA: geçici dizin açılamadı"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
URL="https://install.speedtest.net/app/cli/ookla-speedtest-$VER-linux-$ARCH.tgz"
if ! curl -fsSL --max-time 90 -o "$TMP/o.tgz" "$URL"; then
  echo "[ookla] HATA: indirilemedi ($URL)"; exit 1
fi
if [ "$(sum_of "$TMP/o.tgz")" != "$PKG_SUM" ]; then
  echo "[ookla] HATA: paket özeti tutmuyor — kurulmadı"; exit 1
fi
if ! tar -xzf "$TMP/o.tgz" -C "$TMP" speedtest || [ "$(sum_of "$TMP/speedtest")" != "$BIN_SUM" ]; then
  echo "[ookla] HATA: paket açılamadı ya da program özeti tutmuyor — kurulmadı"; exit 1
fi
if ! { install -m 0755 "$TMP/speedtest" "$DEST.new" && mv -f "$DEST.new" "$DEST"; }; then
  echo "[ookla] HATA: $DEST yazılamadı"; exit 1
fi
echo "[ookla] Speedtest CLI $VER kuruldu ($DEST)"

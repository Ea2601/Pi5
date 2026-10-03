#!/usr/bin/env bash
# wgbridge'i Android kütüphanesine derler (Docker — makinede Go / Android NDK gerekmez): gomobile bind → .aar; içindeki
# classes.jar ve libgojni.so'lar yerel Expo modülüne (gate/modules/klyrix-wg/android) yerleştirilir: EAS derlemesi Go'suz
# kalır. Go kodu (wgbridge) değişince yeniden çalıştırın ve çıktıyı commit'leyin. Yalnız arm64-v8a (bugünkü telefonların
# tamamı; her mimari ~10 MB): emülatör için ANDROID_ABIS="arm64 amd64" verilebilir (x86_64 commit'lenmez).
#   bash gate/wg/build-android.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
# Docker'a giden yollar: Windows'ta (Git Bash) C:/... biçiminde, Linux'ta olduğu gibi
HERE=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))
GATE=$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))
IMG=klyrix-gomobile:1
docker build -q -t "$IMG" -f "$HERE/android.Dockerfile" "$HERE" >/dev/null
TARGETS=$(for a in ${ANDROID_ABIS:-arm64}; do printf 'android/%s,' "$a"; done)
docker run --rm -v "$GATE:/gate" -v klyrix-gomod:/go/pkg/mod -w /gate/wg -e TARGETS="${TARGETS%,}" "$IMG" sh -euc '
  gomobile bind -target="$TARGETS" -androidapi 24 -javapkg=com.klyrix.wg -trimpath -ldflags="-s -w" \
    -o /tmp/klyrixwg.aar ./wgbridge
  cd /tmp && unzip -q -o klyrixwg.aar classes.jar "jni/*"
  M=/gate/modules/klyrix-wg/android
  rm -rf $M/src/main/jniLibs && mkdir -p $M/libs $M/src/main/jniLibs
  cp classes.jar $M/libs/klyrixwg.jar
  cp -r jni/* $M/src/main/jniLibs/
  ls -la $M/libs/klyrixwg.jar $M/src/main/jniLibs/*/libgojni.so
'

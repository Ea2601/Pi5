# wgbridge → Android kütüphanesi (gomobile bind) derleme imajı: Go + JDK + Android SDK komut satırı araçları + NDK.
# Kullanım: gate/wg/build-android.sh (imajı kurar, derler, çıktıyı gate/modules/klyrix-wg/android'e yerleştirir).
FROM golang:1.26-bookworm

RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openjdk-17-jdk-headless unzip >/dev/null \
 && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -sSLo /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
 && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools \
 && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm /tmp/tools.zip \
 && yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
 && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-34" "ndk;27.2.12479018" >/dev/null

ENV ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
# gomobile Go açıklamalarını (Türkçe) Java'ya taşır: javac UTF-8 okusun
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8
# gomobile sürümü go.mod'daki golang.org/x/mobile ile aynı olmalı (build-android.sh denetler)
ARG MOBILE_VERSION=v0.0.0-20260908204917-8b95e45f8d3e
RUN go install golang.org/x/mobile/cmd/gomobile@$MOBILE_VERSION \
 && go install golang.org/x/mobile/cmd/gobind@$MOBILE_VERSION

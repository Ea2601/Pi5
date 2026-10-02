import type { ExpoConfig } from 'expo/config';

// Mağaza kimlikleri kullanıcının Apple / Google geliştirici hesabına göre ortam değişkeniyle verilir (eas.json ya da kabuk).
const IOS_ID = process.env.KLYRIX_IOS_BUNDLE_ID || 'com.klyrix.gatebackup';
const ANDROID_ID = process.env.KLYRIX_ANDROID_PACKAGE || 'com.klyrix.gatebackup';

const config: ExpoConfig = {
  name: 'Klyrix Yedek',
  slug: 'klyrix-backup',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0b1120',
  ios: {
    bundleIdentifier: IOS_ID,
    supportsTablet: true,
    infoPlist: {
      // Pi ev ağında: yerel ağ izni (iOS 14+) ve şifresiz HTTP yalnız yerel adreslere (Pi'nin paneli de böyle)
      NSLocalNetworkUsageDescription: 'Fotoğraflarınızı evinizdeki Klyrix Gate cihazına yedeklemek için yerel ağa erişilir.',
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: { 'yedek.lan': { NSExceptionAllowsInsecureHTTPLoads: true } },
      },
    },
  },
  android: {
    package: ANDROID_ID,
  },
  plugins: [
    ['expo-camera', { cameraPermission: 'Pi panelindeki eşleştirme QR kodunu okumak için kamera kullanılır.', microphonePermission: false, recordAudioAndroid: false, barcodeScannerEnabled: true }],
    ['expo-media-library', { photosPermission: 'Fotoğraf ve videolarınızı Klyrix Gate\'e yedeklemek için okunur; hiçbiri silinmez ya da değiştirilmez.', savePhotosPermission: false, isAccessMediaLocationEnabled: true, granularPermissions: ['photo', 'video'] }],
    // Android 9+ şifresiz HTTP'yi varsayılan olarak engeller; Pi ev ağında HTTP ile konuşur
    ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    'expo-background-task',
    'expo-secure-store',
  ],
};

export default config;

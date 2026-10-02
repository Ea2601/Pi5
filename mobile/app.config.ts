import type { ConfigContext, ExpoConfig } from 'expo/config';

// Sabit ayarlar app.json'da: EAS ilk derlemede proje kimliğini (extra.eas.projectId) oraya yazar — TypeScript yapılandırmaya
// yazamaz. Burada yalnız mağaza kimlikleri: kullanıcının Apple / Google geliştirici hesabına göre ortam değişkeniyle.
// Pi ev ağında HTTP ile konuşur: iOS'ta yerel ağ izni + NSAllowsLocalNetworking, Android'de usesCleartextTraffic (app.json).
const IOS_ID = process.env.KLYRIX_IOS_BUNDLE_ID || 'com.klyrix.gatebackup';
const ANDROID_ID = process.env.KLYRIX_ANDROID_PACKAGE || 'com.klyrix.gatebackup';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name || 'Klyrix/Gate Sync',
  slug: config.slug || 'klyrix-backup',
  ios: { ...config.ios, bundleIdentifier: IOS_ID },
  android: { ...config.android, package: ANDROID_ID },
});

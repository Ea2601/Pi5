import type { ConfigContext, ExpoConfig } from 'expo/config';

// Sabit ayarlar app.json'da: EAS ilk derlemede proje kimliğini (extra.eas.projectId) oraya yazar — commit'lenmez (depo
// açık). Burada yalnız mağaza kimlikleri: kullanıcının Apple / Google geliştirici hesabına göre ortam değişkeniyle.
// Pi ev ağında HTTP ile konuşur (eşleşme), panel uygulama içindeki 127.0.0.1 vekilinden açılır: Android'de
// usesCleartextTraffic, iOS'ta NSAllowsLocalNetworking + yerel ağ izni (app.json).
const IOS_ID = process.env.KLYRIX_GATE_IOS_BUNDLE_ID || 'com.klyrix.gate';
const ANDROID_ID = process.env.KLYRIX_GATE_ANDROID_PACKAGE || 'com.klyrix.gate';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name || 'Klyrix/Gate',
  slug: config.slug || 'klyrix-gate',
  ios: { ...config.ios, bundleIdentifier: IOS_ID },
  android: { ...config.android, package: ANDROID_ID },
});

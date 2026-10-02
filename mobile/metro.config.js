// Metro: Expo'nun varsayılan yapılandırması. Yalnız KLYRIX_PREVIEW=1 ile web'e derlenirken (geliştirme önizlemesi,
// scripts/preview.mjs) telefona özgü modüller tarayıcıda çalışan sahtelerle (preview/) değiştirilir: ekranlar telefonsuz,
// sahte Pi verisiyle görüntülenip ekran görüntüsü alınabilir. Telefon derlemeleri bundan etkilenmez.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (process.env.KLYRIX_PREVIEW) {
  const mocks = {
    'expo-secure-store': 'secure-store', 'expo-media-library': 'media-library', 'expo-camera': 'camera',
    'expo-background-task': 'background-task', 'expo-task-manager': 'task-manager', 'expo-network': 'network',
    'expo-device': 'device', 'expo-file-system': 'file-system', 'expo-contacts': 'contacts', 'expo-calendar': 'calendar',
  };
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (ctx, name, platform) => {
    if (platform === 'web') {
      const m = mocks[name] || (/platform[\\/]http\.ts$/.test(name) ? 'http' : null);
      if (m) return { type: 'sourceFile', filePath: path.join(__dirname, 'preview', `${m}.ts`) };
    }
    return upstream ? upstream(ctx, name, platform) : ctx.resolveRequest(ctx, name, platform);
  };
}

module.exports = config;

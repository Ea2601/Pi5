import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Kalınlıklar tek tek: paketin kökünden alınca Metro 34 yazı tipi dosyasının (7,8 MB) hepsini uygulamaya koyuyordu
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import type { Pairing } from './src/core/protocol.ts';
import { DEFAULT_SETTINGS, loadPairing, loadSettings, saveSettings, type Settings, type ThemePref } from './src/platform/store.ts';
import { Main } from './src/ui/Main.tsx';
import { Onboarding } from './src/ui/Onboarding.tsx';
import { ThemeProvider, useTheme } from './src/ui/ThemeContext.tsx';

// Yazı tipleri (panelle aynı: Inter, kodlar JetBrains Mono) ve kayıtlı durum yüklenene kadar açılış ekranı kalır
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [fontsOk, fontErr] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, JetBrainsMono_500Medium });
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void Promise.all([loadPairing(), loadSettings()]).then(([pr, st]) => { setPairing(pr); setSettings(st); });
  }, []);
  const ready = (fontsOk || !!fontErr) && pairing !== undefined && settings !== null;
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => {}); }, [ready]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => {
      const next = { ...(prev ?? DEFAULT_SETTINGS), ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);
  const setPref = useCallback((theme: ThemePref) => update({ theme }), [update]);

  if (!ready || !settings) return null;
  return (
    <SafeAreaProvider>
      <ThemeProvider pref={settings.theme} setPref={setPref}>
        <Root pairing={pairing ?? null} onPaired={setPairing} settings={settings} onSettings={update} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Root({ pairing, onPaired, settings, onSettings }: {
  pairing: Pairing | null; onPaired: (p: Pairing | null) => void; settings: Settings; onSettings: (patch: Partial<Settings>) => void;
}) {
  const { p } = useTheme();
  // Sistem arka planı (klavye açılırken, ekran dönerken görünen kök) temayla aynı
  useEffect(() => { void SystemUI.setBackgroundColorAsync(p.bg).catch(() => {}); }, [p.bg]);
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar style={p.scheme === 'dark' ? 'light' : 'dark'} />
      {pairing
        ? <Main pairing={pairing} settings={settings} onSettings={onSettings} onForget={() => onPaired(null)} />
        : <Onboarding onDone={onPaired} />}
    </View>
  );
}

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
import type { Pairing2 } from './src/core/api.ts';
import { DEFAULT_SETTINGS, hasLegacyPairing, loadKey, loadPairing, loadSettings, saveSettings, type Settings, type ThemePref } from './src/platform/store.ts';
import { Main } from './src/ui/Main.tsx';
import { Onboarding } from './src/ui/Onboarding.tsx';
import { ThemeProvider, useTheme } from './src/ui/ThemeContext.tsx';

// Yazı tipleri (panelle aynı: Inter, kodlar JetBrains Mono) ve kayıtlı durum yüklenene kadar açılış ekranı kalır
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [fontsOk, fontErr] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, JetBrainsMono_500Medium });
  // Eşleşme + anahtar varsa ana ekran; eşleşme var ama anahtar yoksa kurulum anahtar adımından sürer
  const [boot, setBoot] = useState<{ pairing: Pairing2 | null; ready: boolean; legacy: boolean } | undefined>(undefined);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void (async () => {
      const [pr, st, legacy] = await Promise.all([loadPairing(), loadSettings(), hasLegacyPairing()]);
      const key = pr ? await loadKey(pr.profileId) : null;
      setBoot({ pairing: pr, ready: !!(pr && key), legacy });
      setSettings(st);
    })();
  }, []);
  const ready = (fontsOk || !!fontErr) && boot !== undefined && settings !== null;
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => {}); }, [ready]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings(prev => {
      const next = { ...(prev ?? DEFAULT_SETTINGS), ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);
  const setPref = useCallback((theme: ThemePref) => update({ theme }), [update]);

  if (!ready || !settings || !boot) return null;
  return (
    <SafeAreaProvider>
      <ThemeProvider pref={settings.theme} setPref={setPref}>
        <Root boot={boot} onBoot={setBoot} settings={settings} onSettings={update} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Root({ boot, onBoot, settings, onSettings }: {
  boot: { pairing: Pairing2 | null; ready: boolean; legacy: boolean }; onBoot: (b: { pairing: Pairing2 | null; ready: boolean; legacy: boolean }) => void;
  settings: Settings; onSettings: (patch: Partial<Settings>) => void;
}) {
  const { p } = useTheme();
  // Sistem arka planı (klavye açılırken, ekran dönerken görünen kök) temayla aynı
  useEffect(() => { void SystemUI.setBackgroundColorAsync(p.bg).catch(() => {}); }, [p.bg]);
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar style={p.scheme === 'dark' ? 'light' : 'dark'} />
      {boot.pairing && boot.ready
        ? <Main pairing={boot.pairing} settings={settings} onSettings={onSettings} onForget={() => onBoot({ pairing: null, ready: false, legacy: false })} />
        : <Onboarding initial={boot.pairing} legacy={boot.legacy} onDone={pr => onBoot({ pairing: pr, ready: true, legacy: false })} />}
    </View>
  );
}

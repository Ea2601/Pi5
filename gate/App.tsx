import { useCallback, useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Kalınlıklar tek tek: paketin kökünden alınca Metro tüm yazı tipi dosyalarını uygulamaya koyardı
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import { connect, subscribeConn, type ConnState } from './src/connection.ts';
import { DEFAULT_SETTINGS, loadDevices, loadSettings, saveDevices, saveSettings, type SavedDevice, type Settings, type ThemePref } from './src/platform/store.ts';
import { AddDeviceScreen } from './src/ui/AddDeviceScreen.tsx';
import { DeviceScreen } from './src/ui/DeviceScreen.tsx';
import { DevicesScreen } from './src/ui/DevicesScreen.tsx';
import { PanelScreen } from './src/ui/PanelScreen.tsx';
import { ThemeProvider, useTheme } from './src/ui/ThemeContext.tsx';

// Yazı tipleri (panelle aynı: Inter, kodlar JetBrains Mono) ve kayıtlı cihazlar yüklenene kadar açılış ekranı kalır
SplashScreen.preventAutoHideAsync().catch(() => {});

type Screen = { name: 'devices' } | { name: 'add' } | { name: 'panel'; piId: string } | { name: 'device'; piId: string };

export default function App() {
  const [fontsOk, fontErr] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, JetBrainsMono_500Medium });
  const [devices, setDevices] = useState<SavedDevice[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void Promise.all([loadDevices(), loadSettings()]).then(([d, st]) => { setDevices(d); setSettings(st); });
  }, []);
  const ready = (fontsOk || !!fontErr) && devices !== null && settings !== null;
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => {}); }, [ready]);
  const setPref = useCallback((theme: ThemePref) => {
    setSettings(prev => {
      const next = { ...(prev ?? DEFAULT_SETTINGS), theme };
      void saveSettings(next);
      return next;
    });
  }, []);

  if (!ready || !settings || !devices) return null;
  return (
    <SafeAreaProvider>
      <ThemeProvider pref={settings.theme} setPref={setPref}>
        <Root devices={devices} onDevices={d => { setDevices(d); void saveDevices(d); }} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Root({ devices, onDevices }: { devices: SavedDevice[]; onDevices: (d: SavedDevice[]) => void }) {
  const { p } = useTheme();
  const [screen, setScreen] = useState<Screen>(devices.length ? { name: 'devices' } : { name: 'add' });
  const [conn, setConn] = useState<ConnState | null>(null);
  useEffect(() => subscribeConn(setConn), []);
  // Sistem arka planı (klavye açılırken, ekran dönerken görünen kök) temayla aynı
  useEffect(() => { void SystemUI.setBackgroundColorAsync(p.bg).catch(() => {}); }, [p.bg]);
  // Açılınca ilk cihaza bağlan (karar: uygulama açıkken bağlı)
  useEffect(() => {
    if (devices[0]) void connect(devices[0]);
    // yalnız açılışta
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Android geri tuşu: alt ekranlardan cihazlara (panel kendi geri geçmişini önce kullanır)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'devices' || screen.name === 'panel') return false;
      if (screen.name === 'add' && !devices.length) return false;
      setScreen({ name: 'devices' });
      return true;
    });
    return () => sub.remove();
  }, [screen, devices.length]);

  const find = (piId: string) => devices.find(d => d.piId === piId);
  const open = (d: SavedDevice) => {
    if (!conn || conn.piId !== d.piId || conn.status !== 'connected') void connect(d);
    setScreen({ name: 'panel', piId: d.piId });
  };
  const added = (d: SavedDevice) => {
    onDevices([d, ...devices.filter(x => x.piId !== d.piId)]);
    void connect(d);
    setScreen({ name: 'panel', piId: d.piId });
  };
  const removed = (piId: string) => {
    const rest = devices.filter(x => x.piId !== piId);
    onDevices(rest);
    setScreen(rest.length ? { name: 'devices' } : { name: 'add' });
  };

  if (!conn) return null;
  const back = () => setScreen(devices.length ? { name: 'devices' } : { name: 'add' });
  const cur = 'piId' in screen ? find(screen.piId) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <StatusBar style={p.scheme === 'dark' ? 'light' : 'dark'} />
      {screen.name === 'add' ? <AddDeviceScreen onDone={added} onBack={back} />
        : screen.name === 'panel' && cur ? <PanelScreen device={cur} conn={conn} onBack={back} />
        : screen.name === 'device' && cur ? <DeviceScreen device={cur} conn={conn} onBack={back} onRemoved={removed} />
        : <DevicesScreen devices={devices} conn={conn} onOpen={open} onDetails={d => setScreen({ name: 'device', piId: d.piId })}
            onAdd={() => setScreen({ name: 'add' })} />}
    </View>
  );
}

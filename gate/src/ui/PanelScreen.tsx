// Panel: Pi'nin panelinin kendisi, uygulama içinde (WebView) — yerel vekilden (127.0.0.1) tünelle; panel şifresi sorulmaz
// (kimlik eşli telefonun tüneli). Panel dışı bağlantılar telefonun tarayıcısında açılır. Android geri tuşu önce panelde geri
// gider. Dosya indirme (yedek dışa aktarma vb.) uygulamada henüz yok.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { connect, type ConnState } from '../connection.ts';
import type { SavedDevice } from '../platform/store.ts';
import { connChip } from './DevicesScreen.tsx';
import { Header } from './Header.tsx';
import { RefreshCw } from './icons.ts';
import { Btn, Card, Chip } from './kit.tsx';
import { useTheme } from './ThemeContext.tsx';

export function PanelScreen({ device, conn, onBack }: { device: SavedDevice; conn: ConnState; onBack: () => void }) {
  const { s, p } = useTheme();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const canBack = useRef(false);
  const [loadErr, setLoadErr] = useState('');
  const ready = conn.piId === device.piId && conn.status === 'connected' && !!conn.panelUrl;
  const chip = connChip(conn, device.piId);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canBack.current && web.current) { web.current.goBack(); return true; }
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <Header title={device.piName || 'Klyrix Gate'} onBack={onBack} right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Chip text={chip.text} tone={chip.tone} />
          <Pressable accessibilityRole="button" accessibilityLabel="Yenile" hitSlop={8} onPress={() => { setLoadErr(''); web.current?.reload(); }}>
            <RefreshCw size={20} color={p.textSecondary} />
          </Pressable>
        </View>
      } />
      {ready ? (
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>
          {loadErr ? <Text style={[s.err, { padding: 12 }]}>{loadErr}</Text> : null}
          <WebView ref={web} source={{ uri: conn.panelUrl! }} style={{ flex: 1, backgroundColor: p.bg }}
            originWhitelist={['http://127.0.0.1:*']} setSupportMultipleWindows={false} javaScriptEnabled domStorageEnabled
            startInLoadingState renderLoading={() => (
              <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: p.bg }}>
                <ActivityIndicator color={p.textSecondary} />
              </View>
            )}
            onNavigationStateChange={n => { canBack.current = n.canGoBack; }}
            onError={e => setLoadErr(`Panel açılamadı: ${e.nativeEvent.description}`)}
            onLoadEnd={() => setLoadErr('')}
            onRenderProcessGone={() => web.current?.reload()} />
        </View>
      ) : (
        <View style={[s.scroll, { flex: 1 }]}>
          <Card>
            {conn.piId === device.piId && conn.status === 'connecting' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color={p.textSecondary} />
                <Text style={s.p}>Pi'ye bağlanılıyor…</Text>
              </View>
            ) : <>
              <Text style={s.err}>{conn.piId === device.piId && conn.error ? conn.error : "Pi'ye bağlı değil"}</Text>
              <Text style={s.small}>
                Evdeyken Pi'nin ev ağı adresinden, dışarıdayken dış adresinden (DDNS) bağlanılır. Dışarıdan bağlanamıyorsanız
                panelde Ev VPN'i → «Dışarıdan erişim testi»ne bakın.
              </Text>
              <Btn kind="on" icon={RefreshCw} label="Yeniden bağlan" onPress={() => void connect(device)} />
            </>}
          </Card>
        </View>
      )}
    </View>
  );
}

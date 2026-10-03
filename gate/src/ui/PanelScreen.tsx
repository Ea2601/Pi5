// Panel: Pi'nin panelinin kendisi, uygulama içinde (WebView) — yerel vekilden (127.0.0.1) tünelle; panel şifresi sorulmaz
// (kimlik eşli telefonun tüneli). Uygulamanın ayrı başlık çubuğu yok: dönüş düğmesi ve bağlantı durumu panelin kendi üst
// çubuğunda (frontend/src/gateApp.ts — durum window.__klyrixGateApp ile gider, dönüş ReactNativeWebView.postMessage ile
// gelir). Panel bunu bilmiyorsa (eski sürüm) altta küçük bir dönüş düğmesi kalır. Panel dışı bağlantılar telefonun
// tarayıcısında açılır; Android geri hareketi önce panelde geri gider. Dosya indirme (yedek dışa aktarma vb.) henüz yok.
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { connect, type ConnState } from '../connection.ts';
import type { SavedDevice } from '../platform/store.ts';
import { connChip } from './DevicesScreen.tsx';
import { Header } from './Header.tsx';
import { ChevronLeft, RefreshCw } from './icons.ts';
import { Btn, Card, Chip } from './kit.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

export function PanelScreen({ device, conn, onBack }: { device: SavedDevice; conn: ConnState; onBack: () => void }) {
  const { s, p } = useTheme();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const canBack = useRef(false);
  const [loadErr, setLoadErr] = useState('');
  const [integrated, setIntegrated] = useState(false); // panel üst çubuğunda dönüş düğmesini gösteriyor
  const [fallback, setFallback] = useState(false);
  const mine = conn.piId === device.piId;
  const ready = mine && conn.status === 'connected' && !!conn.panelUrl;
  const info = JSON.stringify({ status: mine ? conn.status : 'idle', via: conn.via, ms: conn.ms });
  const inject = `window.__klyrixGateAppInfo=${info};window.__klyrixGateApp&&window.__klyrixGateApp(${info});true;`;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canBack.current && web.current) { web.current.goBack(); return true; }
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  // Bağlantı durumu panelin üst çubuğuna
  useEffect(() => { web.current?.injectJavaScript(inject); }, [inject]);

  // Bağlantı geri gelince yüklenemeyen panel kendiliğinden yenilenir
  const prev = useRef(conn.status);
  useEffect(() => {
    if (prev.current !== 'connected' && conn.status === 'connected' && loadErr) { setLoadErr(''); web.current?.reload(); }
    prev.current = conn.status;
  }, [conn.status, loadErr]);

  // Panel eski sürümse (dönüş düğmesini bildirmezse) yüklendikten 4 sn sonra alttaki dönüş düğmesi
  const loaded = () => {
    setLoadErr('');
    web.current?.injectJavaScript(inject);
    setTimeout(() => setFallback(true), 4000);
  };

  if (!ready) {
    const chip = connChip(conn, device.piId);
    return (
      <View style={[s.screen, { paddingTop: insets.top }]}>
        <Header title={device.piName || 'Klyrix Gate'} onBack={onBack} right={<Chip text={chip.text} tone={chip.tone} />} />
        <View style={s.scroll}>
          <Card>
            {mine && conn.status === 'connecting' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color={p.textSecondary} />
                <Text style={s.p}>Pi'ye bağlanılıyor…</Text>
              </View>
            ) : <>
              <Text style={s.err}>{mine && conn.error ? conn.error : "Pi'ye bağlı değil"}</Text>
              <Text style={s.small}>
                Evdeyken Pi'nin ev ağı adresinden, dışarıdayken dış adresinden (DDNS) bağlanılır. Dışarıdan bağlanamıyorsanız
                panelde Ev VPN'i → «Dışarıdan erişim testi»ne bakın.
              </Text>
              <Btn kind="on" icon={RefreshCw} label="Yeniden bağlan" onPress={() => void connect(device)} />
            </>}
          </Card>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {loadErr ? <Text style={[s.err, { padding: 12 }]}>{loadErr}</Text> : null}
      <WebView ref={web} source={{ uri: conn.panelUrl! }} style={{ flex: 1, backgroundColor: p.bg }}
        originWhitelist={['http://127.0.0.1:*']} setSupportMultipleWindows={false} javaScriptEnabled domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={inject}
        onMessage={e => {
          let m: { type?: unknown } = {};
          try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
          if (m.type === 'back') onBack();
          else if (m.type === 'ready') setIntegrated(true);
        }}
        startInLoadingState renderLoading={() => (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: p.bg }}>
            <ActivityIndicator color={p.textSecondary} />
          </View>
        )}
        onNavigationStateChange={n => { canBack.current = n.canGoBack; }}
        onError={e => setLoadErr(`Panel açılamadı: ${e.nativeEvent.description} — bağlantı gelince kendiliğinden yenilenir`)}
        onLoadEnd={loaded}
        onRenderProcessGone={() => web.current?.reload()} />
      {fallback && !integrated ? (
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Cihazlara dön"
          style={({ pressed }) => ({
            position: 'absolute', left: 12, bottom: insets.bottom + 12, flexDirection: 'row', alignItems: 'center', gap: 4,
            paddingVertical: 8, paddingLeft: 8, paddingRight: 14, borderRadius: 999, borderWidth: 1, borderColor: p.border,
            backgroundColor: p.card, opacity: pressed ? 0.8 : 0.95,
          })}>
          <ChevronLeft size={18} color={p.text} />
          <Text style={{ color: p.text, fontFamily: FONT.semibold, fontSize: 13 }}>Cihazlar</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

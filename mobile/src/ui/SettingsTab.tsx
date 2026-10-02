// Ayarlar sekmesi: yedekleme tercihleri, görünüm (Sistem / Koyu / Açık — panelin iki teması), Pi bağlantısı, hakkında,
// eşleştirmeyi kaldırma (kırmızı).
import { Alert, Platform, ScrollView, Text } from 'react-native';
import Constants from 'expo-constants';
import { HardDriveUpload, Info, Monitor, Moon, Palette, RefreshCw, Smartphone, Sun, Unlink } from './icons.ts';
import type { Pairing } from '../core/protocol.ts';
import { forgetPairing, type Settings, type ThemePref } from '../platform/store.ts';
import { setAutoBackup } from '../platform/task.ts';
import { APP_NAME } from './Header.tsx';
import { Btn, Card, KV, Segmented, ToggleRow } from './kit.tsx';
import type { PiState } from './Main.tsx';
import { useTheme } from './ThemeContext.tsx';

export function SettingsTab({ pairing, settings, onSettings, pi, onForget }: {
  pairing: Pairing; settings: Settings; onSettings: (patch: Partial<Settings>) => void; pi: PiState; onForget: () => void;
}) {
  const { s, p, pref, setPref } = useTheme();
  const forget = () => Alert.alert('Eşleştirmeyi kaldır', 'Bu telefon Pi\'ye bir daha yükleyemez (yeniden eşleştirene kadar). Pi\'deki yedekler kalır.', [
    { text: 'Vazgeç', style: 'cancel' },
    { text: 'Kaldır', style: 'destructive', onPress: () => void (async () => { await setAutoBackup(false).catch(() => {}); await forgetPairing(); onForget(); })() },
  ]);
  const ic = p.textSecondary;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Card title="Yedekleme" icon={<HardDriveUpload size={18} color={ic} />}>
        <ToggleRow label="Kendiliğinden yedekle" hint="Arka planda, sistemin uygun gördüğü zamanlarda" value={settings.auto} onChange={v => onSettings({ auto: v })} />
        <ToggleRow label="Yalnız Wi-Fi'da" value={settings.wifiOnly} onChange={v => onSettings({ wifiOnly: v })} />
        <ToggleRow label="Videoları da yedekle" value={settings.videos} onChange={v => onSettings({ videos: v })} />
        <Text style={s.small}>
          {Platform.OS === 'ios'
            ? 'iOS arka planda yedeklemeyi sistemin seçtiği zamanlarda (çoğunlukla gece, şarjdayken) kısa süreler için çalıştırır; büyük arşivler için uygulamayı açık tutun.'
            : 'Android arka planda en sık 15 dakikada bir yedekler; pil tasarrufu uygulamayı kısıtlarsa açık tutun.'}
        </Text>
      </Card>

      <Card title="Görünüm" icon={<Palette size={18} color={ic} />}>
        <Segmented<ThemePref> value={pref} onChange={setPref} options={[
          { value: 'system', label: 'Sistem', icon: Monitor },
          { value: 'dark', label: 'Koyu', icon: Moon },
          { value: 'light', label: 'Açık', icon: Sun },
        ]} />
        <Text style={s.small}>Panelle aynı iki tema; «Sistem» telefonun görünümünü izler.</Text>
      </Card>

      <Card title="Bağlantı" icon={<Smartphone size={18} color={ic} />}>
        <KV label="Pi" value={pairing.piName || '—'} />
        <KV label="Bu cihaz" value={pairing.deviceName} />
        <KV label="Adres" value={`${pairing.host}:${pairing.port}`} mono />
        <KV label="Durum" value={pi.status ? (pi.status.ok ? 'Bağlı' : 'Pi\'de kapalı') : pi.checking ? 'Bağlanıyor…' : 'Ulaşılamıyor'} tone={pi.status?.ok ? 'ok' : pi.status || pi.checking ? undefined : 'bad'} />
        {pi.error && !pi.status ? <Text style={s.err}>{pi.error}</Text> : null}
        <Btn kind="neutral" icon={RefreshCw} label="Bağlantıyı denetle" busy={pi.checking} onPress={() => void pi.refresh()} />
      </Card>

      <Card title="Hakkında" icon={<Info size={18} color={ic} />}>
        <KV label="Uygulama" value={APP_NAME} />
        <KV label="Sürüm" value={Constants.expoConfig?.version || '—'} mono />
        <Text style={s.small}>Verileriniz yalnız evinizdeki Klyrix/gate cihazına gider; hiçbir buluta ya da üçüncü tarafa gönderilmez.</Text>
      </Card>

      <Btn kind="off" icon={Unlink} label="Eşleştirmeyi kaldır" onPress={forget} />
    </ScrollView>
  );
}

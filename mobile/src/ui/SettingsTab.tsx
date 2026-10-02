// Ayarlar sekmesi: yedekleme tercihleri, görünüm (Sistem / Koyu / Açık — panelin iki teması), kişi ve telefonları,
// şifreleme (kurtarma anahtarını gösterme), Pi bağlantısı, hakkında, eşleştirmeyi kaldırma (kırmızı).
import { useState } from 'react';
import { Alert, Platform, ScrollView, Text } from 'react-native';
import Constants from 'expo-constants';
import { Eye, HardDriveUpload, Info, Monitor, Moon, Palette, RefreshCw, Share2, ShieldCheck, Smartphone, Sun, Unlink, User } from './icons.ts';
import type { Pairing2 } from '../core/api.ts';
import { encodeRecoveryKey } from '../core/crypto.ts';
import { dropIdCache } from '../platform/idcache.ts';
import { forgetPairing, loadKey, type Settings, type ThemePref } from '../platform/store.ts';
import { setAutoBackup } from '../platform/task.ts';
import { when } from './BackupTab.tsx';
import { APP_NAME } from './Header.tsx';
import { Btn, Card, KV, Segmented, ToggleRow } from './kit.tsx';
import type { PiState } from './Main.tsx';
import { KeyGrid, shareKey } from './Onboarding.tsx';
import { useTheme } from './ThemeContext.tsx';

const platformName = (p: string) => (p === 'ios' ? 'iPhone / iPad' : p === 'android' ? 'Android' : 'Telefon');

export function SettingsTab({ pairing, settings, onSettings, pi, onForget }: {
  pairing: Pairing2; settings: Settings; onSettings: (patch: Partial<Settings>) => void; pi: PiState; onForget: () => void;
}) {
  const { s, p, pref, setPref } = useTheme();
  const [groups, setGroups] = useState<string[] | null>(null);
  const reveal = () => Alert.alert('Kurtarma anahtarı', 'Anahtarı gören herkes bu kişinin yedeklerini açabilir. Yanınızda kimse yokken gösterin.', [
    { text: 'Vazgeç', style: 'cancel' },
    {
      text: 'Göster', onPress: () => void (async () => {
        const k = await loadKey(pairing.profileId);
        if (k) setGroups(encodeRecoveryKey(k).split('-'));
        else Alert.alert('Anahtar yok', 'Bu telefonda şifreleme anahtarı bulunamadı — eşleştirmeyi kaldırıp yeniden kurun.');
      })(),
    },
  ]);
  const forget = () => Alert.alert('Eşleştirmeyi kaldır',
    'Bu telefon Pi\'ye bir daha yedekleyemez ve telefondaki şifreleme anahtarı silinir: yedekleri bu telefonda yeniden açmak için kurtarma anahtarı gerekir. Pi\'deki yedekler kalır.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Kaldır', style: 'destructive', onPress: () => void (async () => {
          await setAutoBackup(false).catch(() => {});
          dropIdCache(pairing.profileId);
          await forgetPairing();
          onForget();
        })(),
      },
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

      <Card title={`Kişi — ${pairing.profileName}`} icon={<User size={18} color={ic} />}>
        <Text style={s.small}>Bu kişinin telefonları birbirinin yedeğini görür ve geri yükleyebilir; başka kişiler göremez.</Text>
        {(pi.profile?.devices || []).map(d => (
          <KV key={d.id} label={d.me ? `${d.name} (bu telefon)` : d.name} value={d.me ? platformName(d.platform) : d.lastSeen ? when(d.lastSeen) : 'henüz bağlanmadı'} />
        ))}
      </Card>

      <Card title="Şifreleme" icon={<ShieldCheck size={18} color={ic} />}>
        <Text style={s.p}>
          Yedekler bu telefonda, kişinin anahtarıyla şifrelenip Pi'ye gönderilir: Pi ve ağdaki başkaları içeriği göremez. Anahtar
          Pi'de yoktur; yeni telefon kurtarma anahtarıyla eklenir.
        </Text>
        {groups ? (
          <>
            <KeyGrid groups={groups} />
            <Btn kind="neutral" icon={Share2} label="Paylaş / kaydet" onPress={() => void shareKey(pairing.profileName, groups)} />
            <Btn kind="neutral" label="Gizle" onPress={() => setGroups(null)} />
          </>
        ) : <Btn kind="neutral" icon={Eye} label="Kurtarma anahtarını göster" onPress={reveal} />}
      </Card>

      <Card title="Bağlantı" icon={<Smartphone size={18} color={ic} />}>
        <KV label="Pi" value={pairing.piName || '—'} />
        <KV label="Bu cihaz" value={pairing.deviceName} />
        <KV label="Adres" value={`${pairing.host}:${pairing.port}`} mono />
        <KV label="Durum" value={pi.profile ? 'Bağlı' : pi.checking ? 'Bağlanıyor…' : 'Ulaşılamıyor'} tone={pi.profile ? 'ok' : pi.checking ? undefined : 'bad'} />
        {pi.error && !pi.profile ? <Text style={s.err}>{pi.error}</Text> : null}
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

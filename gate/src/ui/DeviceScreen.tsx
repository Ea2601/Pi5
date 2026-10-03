// Cihaz ayrıntısı: bağlantı (evden / dışarıdan, gecikme), adresler; «Yeniden bağlan»; kırmızı «Bu telefonu Pi'den kaldır»
// (Pi'deki kaydı silinir — tünel hemen kapanır; Pi'ye ulaşılamıyorsa yalnız telefondan silinir, kayıt panelden kaldırılır).
import { useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect, forgetCurrent, piRequest, type ConnState } from '../connection.ts';
import { dropKey, type SavedDevice } from '../platform/store.ts';
import { connChip } from './DevicesScreen.tsx';
import { Header } from './Header.tsx';
import { RefreshCw, Router, Trash, Unplug } from './icons.ts';
import { Btn, Card, Chip, KV } from './kit.tsx';
import { useTheme } from './ThemeContext.tsx';

const when = (t: number) => new Date(t).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

export function DeviceScreen({ device, conn, onBack, onRemoved }: {
  device: SavedDevice; conn: ConnState; onBack: () => void; onRemoved: (piId: string) => void;
}) {
  const { s, p } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const chip = connChip(conn, device.piId);
  const connected = conn.piId === device.piId && conn.status === 'connected';

  const removeLocal = async () => {
    await forgetCurrent(device.piId);
    await dropKey(device.piId);
    onRemoved(device.piId);
  };
  const remove = () => {
    if (!connected) {
      Alert.alert("Pi'ye bağlı değil", "Cihaz yalnız bu telefondan silinsin mi? Pi'deki kaydı panelde Ev VPN'i → Klyrix/Gate uygulaması → «Kaldır» ile silebilirsiniz.", [
        { text: 'Vazgeç', style: 'cancel' },
        { text: 'Telefondan sil', style: 'destructive', onPress: () => void removeLocal() },
      ]);
      return;
    }
    Alert.alert('Bu telefonu Pi\'den kaldır', 'Bu telefon Pi\'yi artık yönetemez; yeniden eklemek için yeniden eşleştirmek gerekir.', [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Kaldır', style: 'destructive', onPress: () => void (async () => {
          setBusy(true);
          try {
            const r = await piRequest(`/api/app/devices/${device.deviceId}`, { method: 'DELETE' });
            if (r.status !== 200 && r.status !== 404) throw new Error(r.json?.error || `HTTP ${r.status}`);
            await removeLocal();
          } catch (e) {
            Alert.alert('Kaldırılamadı', e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        })(),
      },
    ]);
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <Header title={device.piName || 'Klyrix Gate'} subtitle="Ayrıntılar" onBack={onBack} right={<Chip text={chip.text} tone={chip.tone} />} />
      <ScrollView contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <Card title="Bağlantı" icon={<Router size={18} color={p.textSecondary} />}>
          <KV label="Durum" value={chip.text} tone={connected ? 'ok' : conn.status === 'error' && conn.piId === device.piId ? 'bad' : undefined} />
          {connected ? <KV label="Gecikme" value={`${conn.ms} ms`} /> : null}
          {conn.piId === device.piId && conn.status === 'error' && conn.error ? <Text style={s.err}>{conn.error}</Text> : null}
          <KV label="Bu telefonun tünel adresi" value={device.address} mono />
          <KV label="Ev ağı adresi" value={device.lan.join(', ') || '—'} mono />
          <KV label="Dış adres" value={device.remote || '—'} mono />
          <KV label="Eklenme" value={when(device.addedAt)} />
          <Text style={s.small}>
            Telefon ile Pi arasındaki bağlantı şifrelidir ve yalnız bu uygulamanın içinde çalışır: telefonda VPN açılmaz, öbür
            uygulamaların trafiği etkilenmez.
          </Text>
          <Btn kind="neutral" icon={RefreshCw} label="Yeniden bağlan" disabled={busy} onPress={() => void connect(device)} />
        </Card>
        <View style={{ gap: 8 }}>
          <Btn kind="off" icon={connected ? Trash : Unplug} label="Bu telefonu Pi'den kaldır" busy={busy} onPress={remove} />
        </View>
      </ScrollView>
    </View>
  );
}

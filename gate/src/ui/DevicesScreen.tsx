// Cihazlar: eşli Pi'ler — her biri için bağlantı durumu (evden / dışarıdan / bağlanıyor / ulaşılamıyor), «Paneli aç»,
// «Ayrıntılar»; yeşil «Cihaz ekle»; görünüm (Sistem / Koyu / Açık — panelin iki teması).
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ConnState } from '../connection.ts';
import type { SavedDevice, ThemePref } from '../platform/store.ts';
import { Header } from './Header.tsx';
import { Globe, House, Info, Monitor, Moon, Palette, Plus, Router, Sun } from './icons.ts';
import { Btn, Card, Chip, Segmented } from './kit.tsx';
import { useTheme } from './ThemeContext.tsx';

export function connChip(conn: ConnState, piId: string): { text: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' } {
  if (conn.piId !== piId || conn.status === 'idle') return { text: 'Bağlı değil', tone: 'neutral' };
  if (conn.status === 'connecting') return { text: 'Bağlanıyor…', tone: 'warn' };
  if (conn.status === 'error') return { text: 'Ulaşılamıyor', tone: 'bad' };
  return { text: conn.via === 'lan' ? 'Bağlı · evden' : 'Bağlı · dışarıdan', tone: 'ok' };
}

export function DevicesScreen({ devices, conn, onOpen, onDetails, onAdd }: {
  devices: SavedDevice[]; conn: ConnState; onOpen: (d: SavedDevice) => void; onDetails: (d: SavedDevice) => void; onAdd: () => void;
}) {
  const { s, p, pref, setPref } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <Header subtitle="Klyrix Gate cihazlarınızı yönetin" />
      <ScrollView contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 24 }]}>
        {devices.map(d => {
          const chip = connChip(conn, d.piId);
          const mine = conn.piId === d.piId;
          return (
            <Card key={d.piId}>
              <View style={s.row}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                  <Router size={22} color={p.textSecondary} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.h} numberOfLines={1}>{d.piName || 'Klyrix Gate'}</Text>
                    <Text style={s.small} numberOfLines={1}>
                      {mine && conn.status === 'connected' ? `${conn.ms} ms · ` : ''}{d.remote || d.lan[0] || ''}
                    </Text>
                  </View>
                </View>
                <Chip text={chip.text} tone={chip.tone} />
              </View>
              {mine && conn.status === 'error' && conn.error ? <Text style={s.err}>{conn.error}</Text> : null}
              <Btn kind="primary" icon={mine && conn.via === 'remote' ? Globe : House} label="Paneli aç" onPress={() => onOpen(d)} />
              <Btn kind="neutral" icon={Info} label="Ayrıntılar" onPress={() => onDetails(d)} />
            </Card>
          );
        })}
        {!devices.length ? (
          <Card>
            <Text style={s.p}>
              Henüz cihaz yok. Telefon evin Wi-Fi'ındayken «Cihaz ekle»ye basın: uygulama Pi'yi ağda kendisi bulur. Panelin
              QR koduyla ya da panel şifresiyle eşleşir; sonra Pi'yi evin dışından da yönetirsiniz.
            </Text>
          </Card>
        ) : null}
        <Btn kind="on" icon={Plus} label="Cihaz ekle" onPress={onAdd} />
        <Card title="Görünüm" icon={<Palette size={18} color={p.textSecondary} />}>
          <Segmented<ThemePref> value={pref} onChange={setPref} options={[
            { value: 'system', label: 'Sistem', icon: Monitor },
            { value: 'dark', label: 'Koyu', icon: Moon },
            { value: 'light', label: 'Açık', icon: Sun },
          ]} />
          <Text style={s.small}>Uygulamanın görünümü; panelin kendi teması paneldeki ayardan.</Text>
        </Card>
      </ScrollView>
    </View>
  );
}

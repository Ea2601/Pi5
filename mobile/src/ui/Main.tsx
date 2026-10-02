// Ana ekran: üstte logo + ad + Pi bağlantı durumu, altta sekmeler (Yedekleme · Ayarlar; Senkronizasyon S3'te gelir).
// Pi'nin durumu burada tutulur (sekmeler ve başlık aynı veriyi gösterir); uygulama öne gelince yenilenir.
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HardDriveUpload, SettingsIcon } from './icons.ts';
import { connect, type PiStatus } from '../core/client.ts';
import type { Pairing } from '../core/protocol.ts';
import { http } from '../platform/http.ts';
import type { Settings } from '../platform/store.ts';
import { setAutoBackup } from '../platform/task.ts';
import { BackupTab } from './BackupTab.tsx';
import { Header } from './Header.tsx';
import { Chip } from './kit.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

type Tab = 'backup' | 'settings';
export interface PiState { status: PiStatus | null; error: string; checking: boolean; refresh: () => Promise<void> }

export function Main({ pairing, settings, onSettings, onForget }: {
  pairing: Pairing; settings: Settings; onSettings: (patch: Partial<Settings>) => void; onForget: () => void;
}) {
  const { p, s } = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('backup');
  const [status, setStatus] = useState<PiStatus | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const c = await connect(http, pairing);
      setStatus(await c.status());
      setError('');
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, [pairing]);

  useEffect(() => { void setAutoBackup(settings.auto).catch(() => {}); }, [settings.auto]);
  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', a => { if (a === 'active') void refresh(); });
    return () => sub.remove();
  }, [refresh]);

  const pi: PiState = { status, error, checking, refresh };
  const chip = status ? <Chip text={status.ok ? 'Bağlı' : 'Kapalı'} tone={status.ok ? 'ok' : 'warn'} />
    : checking ? <Chip text="Bağlanıyor…" /> : <Chip text="Ulaşılamıyor" tone="bad" />;
  const tabs: { id: Tab; label: string; icon: typeof HardDriveUpload }[] = [
    { id: 'backup', label: 'Yedekleme', icon: HardDriveUpload },
    { id: 'settings', label: 'Ayarlar', icon: SettingsIcon },
  ];
  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <Header subtitle={pairing.piName || pairing.host} right={chip} />
      <View style={{ flex: 1 }}>
        {tab === 'backup'
          ? <BackupTab pairing={pairing} settings={settings} pi={pi} />
          : <SettingsTab pairing={pairing} settings={settings} onSettings={onSettings} pi={pi} onForget={onForget} />}
      </View>
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.card, paddingBottom: insets.bottom }}>
        {tabs.map(t => {
          const on = t.id === tab;
          return (
            <Pressable key={t.id} onPress={() => setTab(t.id)} accessibilityRole="tab" accessibilityState={{ selected: on }}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 9, gap: 3 }}>
              <t.icon size={22} color={on ? p.text : p.textMuted} />
              <Text style={{ fontFamily: on ? FONT.semibold : FONT.medium, fontSize: 12, color: on ? p.text : p.textMuted }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

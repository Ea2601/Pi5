// Ana ekran: üstte logo + ad + Pi bağlantı durumu, altta sekmeler (Yedekleme · Yedekler · Ayarlar; Senkronizasyon S3'te).
// Pi'nin durumu (kişi, telefonlar, kullanım, yedek listesi) burada tutulur; sekmeler ve başlık aynı veriyi gösterir,
// uygulama öne gelince yenilenir.
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Archive, HardDriveUpload, SettingsIcon } from './icons.ts';
import { connect2, type Pairing2, type Profile, type Snapshot, type Usage } from '../core/api.ts';
import { http } from '../platform/http.ts';
import type { Settings } from '../platform/store.ts';
import { setAutoBackup } from '../platform/task.ts';
import { BackupTab } from './BackupTab.tsx';
import { Header } from './Header.tsx';
import { Chip } from './kit.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { SnapshotsTab } from './SnapshotsTab.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

type Tab = 'backup' | 'snapshots' | 'settings';
export interface PiState {
  profile: Profile | null; usage: Usage | null; snapshots: Snapshot[] | null;
  error: string; checking: boolean; refresh: () => Promise<void>;
}

export function Main({ pairing, settings, onSettings, onForget }: {
  pairing: Pairing2; settings: Settings; onSettings: (patch: Partial<Settings>) => void; onForget: () => void;
}) {
  const { p, s } = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('backup');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const api = await connect2(http, pairing);
      const [pr, us, sn] = await Promise.all([api.profile(), api.usage(), api.snapshots()]);
      setProfile(pr); setUsage(us); setSnapshots(sn);
      setError('');
    } catch (e) {
      setProfile(null);
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

  const pi: PiState = { profile, usage, snapshots, error, checking, refresh };
  const chip = profile ? <Chip text={usage?.mounted === false ? 'Disk yok' : 'Bağlı'} tone={usage?.mounted === false ? 'warn' : 'ok'} />
    : checking ? <Chip text="Bağlanıyor…" /> : <Chip text="Ulaşılamıyor" tone="bad" />;
  const tabs: { id: Tab; label: string; icon: typeof HardDriveUpload }[] = [
    { id: 'backup', label: 'Yedekleme', icon: HardDriveUpload },
    { id: 'snapshots', label: 'Yedekler', icon: Archive },
    { id: 'settings', label: 'Ayarlar', icon: SettingsIcon },
  ];
  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <Header subtitle={pairing.profileName} right={chip} />
      {/* Sekmeler kapatılmaz, gizlenir: süren geri yükleme / açık yedek ayrıntısı / kaydırma yeri sekme değişince kaybolmaz */}
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1, display: tab === 'backup' ? 'flex' : 'none' }}>
          <BackupTab pairing={pairing} pi={pi} onOpenSnapshots={() => setTab('snapshots')} />
        </View>
        <View style={{ flex: 1, display: tab === 'snapshots' ? 'flex' : 'none' }}>
          <SnapshotsTab pairing={pairing} pi={pi} />
        </View>
        <View style={{ flex: 1, display: tab === 'settings' ? 'flex' : 'none' }}>
          <SettingsTab pairing={pairing} settings={settings} onSettings={onSettings} pi={pi} onForget={onForget} />
        </View>
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

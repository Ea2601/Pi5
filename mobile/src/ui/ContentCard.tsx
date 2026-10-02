// Ayarlar → Yedeklenecekler: fotoğraflar hep; videolar, ses (Android), kişiler, takvim ve klasörler isteğe bağlı. İzin isteyen
// tür açılırken izin sorulur; verilmezse kapalı kalır. Klasörler: Android'de seçilen klasörler (kalıcı izin), iOS'ta
// uygulamanın Dosyalar'daki klasörü (iOS kalıcı klasör izni vermez).
import { useState } from 'react';
import { Alert, Platform, Pressable, Text, View } from 'react-native';
import { Archive, Plus, Trash } from './icons.ts';
import { calendarAccess } from '../platform/calendar.ts';
import { contactsAccess } from '../platform/contacts.ts';
import { APP_FOLDER, folderReachable, pickFolder, type FolderPick } from '../platform/folders.ts';
import { audioAccess } from '../platform/media.ts';
import type { Settings } from '../platform/store.ts';
import { APP_NAME } from './Header.tsx';
import { Btn, Card, KV, ToggleRow } from './kit.tsx';
import { useTheme } from './ThemeContext.tsx';

export function ContentCard({ settings, onSettings }: { settings: Settings; onSettings: (patch: Partial<Settings>) => void }) {
  const { s, p } = useTheme();
  const [busy, setBusy] = useState(false);
  const android = Platform.OS === 'android';
  const withPermission = async (patch: Partial<Settings>, on: boolean, ask: () => Promise<boolean>, what: string) => {
    if (on && !(await ask().catch(() => false))) {
      Alert.alert('İzin verilmedi', `${what} yedeklemek için izin gerekir. Telefonun Ayarlar → Uygulamalar → ${APP_NAME} → İzinler bölümünden verebilirsiniz.`);
      return;
    }
    onSettings(patch);
  };
  const addFolder = async () => {
    setBusy(true);
    try {
      const f = await pickFolder();
      if (!f) return;
      if (settings.folders.some(x => x.uri === f.uri)) { Alert.alert('Zaten ekli', `«${f.name}» klasörü zaten yedekleniyor.`); return; }
      onSettings({ folders: [...settings.folders, f] });
    } finally {
      setBusy(false);
    }
  };
  const removeFolder = (f: FolderPick) => Alert.alert('Klasörü çıkar', `«${f.name}» bundan sonra yedeklenmez. Pi'deki eski yedeklerde durur; telefondaki dosyalara dokunulmaz.`, [
    { text: 'Vazgeç', style: 'cancel' },
    { text: 'Çıkar', style: 'destructive', onPress: () => onSettings({ folders: settings.folders.filter(x => x.uri !== f.uri) }) },
  ]);
  const appFolder = settings.folders.some(x => x.uri === APP_FOLDER.uri);
  return (
    <Card title="Yedeklenecekler" icon={<Archive size={18} color={p.textSecondary} />}>
      <KV label="Fotoğraflar" value="her zaman" />
      <ToggleRow label="Videolar" value={settings.videos} onChange={v => onSettings({ videos: v })} />
      {android ? (
        <ToggleRow label="Ses kayıtları ve müzik" value={settings.audio}
          onChange={v => void withPermission({ audio: v }, v, () => audioAccess(true), 'Ses dosyalarını')} />
      ) : null}
      <ToggleRow label="Kişiler" hint="Rehberin tamamı (kişi fotoğrafları hariç)" value={settings.contacts}
        onChange={v => void withPermission({ contacts: v }, v, () => contactsAccess(true), 'Kişileri')} />
      <ToggleRow label="Takvim" hint="Sizin takvimleriniz: 5 yıl geri, 2 yıl ileri (resmî tatil gibi abonelikler hariç)" value={settings.calendar}
        onChange={v => void withPermission({ calendar: v }, v, () => calendarAccess(true), 'Takvimi')} />

      <Text style={[s.h, { marginTop: 4 }]}>Klasörler</Text>
      {android ? (
        <>
          {settings.folders.length ? settings.folders.map(f => {
            const ok = folderReachable(f);
            return (
              <View key={f.uri} style={s.row}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[s.p, { color: p.text }]} numberOfLines={1}>{f.name}</Text>
                  {ok ? null : <Text style={[s.small, { color: p.offText }]}>Erişilemiyor — çıkarıp yeniden ekleyin</Text>}
                </View>
                <Pressable onPress={() => removeFolder(f)} accessibilityRole="button" accessibilityLabel={`${f.name} klasörünü çıkar`}
                  style={({ pressed }) => ({ padding: 9, borderRadius: 8, borderWidth: 1, borderColor: p.danger, backgroundColor: p.offSoft, opacity: pressed ? 0.8 : 1 })}>
                  <Trash size={16} color={p.offText} />
                </Pressable>
              </View>
            );
          }) : <Text style={s.small}>Henüz klasör yok. Belgeler, İndirilenler ya da WhatsApp gibi bir klasör ekleyin: içindeki dosyalar alt klasörleriyle yedeklenir.</Text>}
          <Btn kind="on" icon={Plus} label="Klasör ekle" busy={busy} onPress={() => void addFolder()} />
        </>
      ) : (
        <>
          <ToggleRow label="Dosyalar'daki uygulama klasörü" value={appFolder}
            onChange={v => onSettings({ folders: v ? [...settings.folders, APP_FOLDER] : settings.folders.filter(x => x.uri !== APP_FOLDER.uri) })} />
          <Text style={s.small}>
            iOS uygulamalara başka klasörlere kalıcı erişim vermez: yedeklenecek dosyaları Dosyalar uygulamasında «Bu iPhone'da → {APP_NAME}» klasörüne koyun.
          </Text>
        </>
      )}
    </Card>
  );
}

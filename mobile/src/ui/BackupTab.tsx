// Yedekleme sekmesi: bu telefonun Pi'deki son yedeği, son tur, "Şimdi yedekle" (yeşil) / ilerleme + "Durdur" (kırmızı).
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, ScrollView, Text, View } from 'react-native';
import { Archive, HardDriveUpload, ImageIcon, Play, Square } from './icons.ts';
import type { Pairing2 } from '../core/api.ts';
import type { SnapshotProgress } from '../core/snapshot.ts';
import { fmtBytes } from '../core/protocol.ts';
import { backupOnce, isRunning, requestStop, Skip } from '../backup.ts';
import { mediaAccess, widenAccess, type Access } from '../platform/media.ts';
import { loadLast, type LastRun } from '../platform/store.ts';
import { APP_NAME } from './Header.tsx';
import { Btn, Card, KV } from './kit.tsx';
import type { PiState } from './Main.tsx';
import { useTheme } from './ThemeContext.tsx';

export const when = (t: number | string) => new Date(t).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
const phaseText = (p: SnapshotProgress | null) =>
  !p || p.phase === 'scan' ? `Taranıyor… ${p?.scanned ?? 0}`
    : p.phase === 'upload' ? `Şifreleniyor ve yükleniyor ${p.done + p.failed} / ${p.pending}`
    : p.phase === 'save' ? 'Yedek kaydediliyor…' : 'Bitti';

export function BackupTab({ pairing, pi, onOpenSnapshots }: { pairing: Pairing2; pi: PiState; onOpenSnapshots: () => void }) {
  const { s, p } = useTheme();
  const [last, setLast] = useState<LastRun | null>(null);
  const [access, setAccess] = useState<Access>('all');
  const [progress, setProgress] = useState<SnapshotProgress | null>(null);
  const [running, setRunning] = useState(isRunning());

  const reload = useCallback(async () => {
    setLast(await loadLast());
    setAccess(await mediaAccess(false));
  }, []);
  useEffect(() => {
    void reload();
    const sub = AppState.addEventListener('change', a => { if (a === 'active') void reload(); });
    return () => sub.remove();
  }, [reload]);

  const start = async () => {
    if ((await mediaAccess(true)) === 'none') {
      Alert.alert('İzin gerekli', `Fotoğraflara erişim izni olmadan yedeklenemez. Telefonun Ayarlar → Uygulamalar → ${APP_NAME} → İzinler bölümünden açın.`);
      return;
    }
    setRunning(true); setProgress(null);
    try {
      const r = await backupOnce({ onProgress: setProgress });
      if (r.failed) Alert.alert('Yedekleme bitti', `${r.failed} dosya yüklenemedi; yedek yüklenebilenlerle yazıldı.${r.error ? `\n${r.error}` : ''}`);
    } catch (e) {
      Alert.alert(e instanceof Skip ? 'Yedeklenmedi' : 'Yedekleme durdu', e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setProgress(null);
      void reload();
      void pi.refresh();
    }
  };

  const mine = pi.snapshots?.find(x => x.deviceId === pairing.deviceId) ?? null;
  const pct = progress?.phase === 'upload' && progress.pending ? Math.round(((progress.done + progress.failed) / progress.pending) * 100)
    : progress?.phase === 'save' || progress?.phase === 'done' ? 100 : 0;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Card title="Bu telefonun son yedeği" icon={<HardDriveUpload size={18} color={p.textSecondary} />}>
        {pi.profile ? (
          <>
            {mine ? (
              <>
                <Text style={s.big}>{when(mine.createdAt)}</Text>
                <KV label="Fotoğraf" value={String(mine.stats.photos)} />
                <KV label="Video" value={String(mine.stats.videos)} />
                <KV label="Boyut" value={fmtBytes(mine.stats.bytes)} />
              </>
            ) : <Text style={s.p}>Henüz yedek yok.</Text>}
            {pi.usage ? <KV label="Pi'de kullanılan (kişi)" value={fmtBytes(pi.usage.bytes)} /> : null}
            {pi.usage?.free != null ? <KV label="Boş yer" value={fmtBytes(pi.usage.free)} /> : null}
            {pi.usage && !pi.usage.mounted ? <Text style={s.err}>Pi'de yedek diski bağlı değil.</Text> : null}
            <Btn kind="neutral" icon={Archive} label="Tüm yedekler" onPress={onOpenSnapshots} />
          </>
        ) : pi.error ? <Text style={s.err}>{pi.error}</Text> : <Text style={s.p}>Pi'ye bağlanılıyor…</Text>}
      </Card>

      {access === 'limited' ? (
        <Card>
          <Text style={s.p}>Yalnız seçtiğiniz fotoğraflara izin verdiniz: yalnız onlar yedeklenir.</Text>
          <Btn kind="neutral" icon={ImageIcon} label="Seçimi değiştir" onPress={() => void widenAccess()} />
        </Card>
      ) : null}

      <Card title={running ? undefined : 'Son tur'}>
        {running ? (
          <>
            <Text style={s.h}>{phaseText(progress)}</Text>
            <View style={s.bar}><View style={[s.barFill, { width: `${pct}%` }]} /></View>
            {progress?.current ? <Text style={s.small} numberOfLines={1}>{progress.current}</Text> : null}
            <Btn kind="off" icon={Square} label="Durdur" onPress={requestStop} />
          </>
        ) : (
          <>
            {last ? (
              <>
                <KV label="Tarih" value={when(last.at)} />
                {last.error && !last.uploaded && !last.snapshotId ? <Text style={s.err}>{last.error}</Text> : (
                  <>
                    {last.unchanged ? <Text style={s.p}>Değişiklik yok — son yedek güncel.</Text> : null}
                    {last.snapshotId ? <KV label="Yeni yedek" value={`${last.items ?? 0} öğe`} tone="ok" /> : null}
                    {last.uploaded ? <KV label="Yüklenen" value={`${last.uploaded} dosya · ${fmtBytes(last.bytes)}`} /> : null}
                    {last.failed ? <KV label="Yüklenemeyen" value={String(last.failed)} tone="bad" /> : null}
                    {last.failed && last.error ? <Text style={s.small}>{last.error}</Text> : null}
                    {last.stopped ? <Text style={s.small}>Yarıda kaldı; bir sonraki turda kaldığı yerden sürer.</Text> : null}
                    {!last.snapshotId && !last.unchanged && !last.stopped && !last.error ? <Text style={s.p}>Yedeklenecek fotoğraf yok.</Text> : null}
                  </>
                )}
              </>
            ) : <Text style={s.p}>Henüz yedeklenmedi.</Text>}
            <Btn kind="on" icon={Play} label="Şimdi yedekle" onPress={() => void start()} />
          </>
        )}
      </Card>
    </ScrollView>
  );
}

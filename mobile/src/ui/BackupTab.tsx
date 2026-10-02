// Yedekleme sekmesi: Pi'deki yedeğin özeti, son tur, "Şimdi yedekle" (yeşil) / ilerleme + "Durdur" (kırmızı).
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, ScrollView, Text, View } from 'react-native';
import { HardDriveUpload, ImageIcon, Play, Square } from './icons.ts';
import type { Progress } from '../core/engine.ts';
import { fmtBytes, type Pairing } from '../core/protocol.ts';
import { backupOnce, isRunning, requestStop, Skip } from '../backup.ts';
import { mediaAccess, widenAccess, type Access } from '../platform/media.ts';
import { loadLast, type LastRun, type Settings } from '../platform/store.ts';
import { APP_NAME } from './Header.tsx';
import { Btn, Card, KV } from './kit.tsx';
import type { PiState } from './Main.tsx';
import { useTheme } from './ThemeContext.tsx';

const when = (ms: number) => new Date(ms).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

export function BackupTab({ pi }: { pairing: Pairing; settings: Settings; pi: PiState }) {
  const { s, p } = useTheme();
  const [last, setLast] = useState<LastRun | null>(null);
  const [access, setAccess] = useState<Access>('all');
  const [progress, setProgress] = useState<Progress | null>(null);
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
      if (r.failed) Alert.alert('Yedekleme bitti', `${r.uploaded} dosya yüklendi, ${r.failed} dosya yüklenemedi.${r.error ? `\n${r.error}` : ''}`);
    } catch (e) {
      Alert.alert(e instanceof Skip ? 'Yedeklenmedi' : 'Yedekleme durdu', e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setProgress(null);
      void reload();
      void pi.refresh();
    }
  };

  const st = pi.status;
  const pct = progress && progress.phase === 'upload' && progress.pending ? Math.round(((progress.done + progress.failed) / progress.pending) * 100) : 0;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Card title="Pi'deki yedek" icon={<HardDriveUpload size={18} color={p.textSecondary} />}>
        {st ? (
          <>
            <Text style={s.big}>{st.device.files} dosya</Text>
            <KV label="Boyut" value={fmtBytes(st.device.bytes)} />
            {st.target ? <KV label="Hedef disk" value={st.target.name} /> : null}
            {st.target?.free != null ? <KV label="Boş yer" value={fmtBytes(st.target.free)} /> : null}
            {!st.ok ? <Text style={s.err}>Pi'de mobil yedekleme kapalı — panelden açın.</Text> : null}
            {st.target && !st.target.mounted ? <Text style={s.err}>Pi'de yedek diski bağlı değil.</Text> : null}
          </>
        ) : pi.error ? <Text style={s.err}>{pi.error}</Text> : <Text style={s.p}>Pi'ye bağlanılıyor…</Text>}
      </Card>

      {access === 'limited' ? (
        <Card>
          <Text style={s.p}>Yalnız seçtiğiniz fotoğraflara izin verdiniz: yalnız onlar yedeklenir.</Text>
          <Btn kind="neutral" icon={ImageIcon} label="Seçimi değiştir" onPress={() => void widenAccess()} />
        </Card>
      ) : null}

      <Card title={running ? undefined : 'Son yedekleme'}>
        {running ? (
          <>
            <Text style={s.h}>
              {progress?.phase === 'upload' ? `Yükleniyor ${progress.done + progress.failed} / ${progress.pending}` : `Taranıyor… ${progress?.scanned ?? 0}`}
            </Text>
            <View style={s.bar}><View style={[s.barFill, { width: `${pct}%` }]} /></View>
            {progress?.current ? <Text style={s.small} numberOfLines={1}>{progress.current}</Text> : null}
            <Btn kind="off" icon={Square} label="Durdur" onPress={requestStop} />
          </>
        ) : (
          <>
            {last ? (
              <>
                <KV label="Tarih" value={when(last.at)} />
                {last.error && !last.uploaded ? <Text style={s.err}>{last.error}</Text> : (
                  <>
                    <KV label="Yeni dosya" value={String(last.uploaded)} />
                    {last.failed ? <KV label="Hata" value={String(last.failed)} tone="bad" /> : null}
                    {last.stopped ? <Text style={s.small}>Yarıda kaldı; bir sonraki turda kaldığı yerden sürer.</Text> : null}
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

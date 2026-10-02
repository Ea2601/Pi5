import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { connect, type PiStatus } from '../core/client.ts';
import type { Progress } from '../core/engine.ts';
import { fmtBytes, type Pairing } from '../core/protocol.ts';
import { backupOnce, isRunning, requestStop, Skip } from '../backup.ts';
import { http } from '../platform/http.ts';
import { mediaAccess, widenAccess, type Access } from '../platform/media.ts';
import { forgetPairing, loadLast, loadSettings, saveSettings, type LastRun, type Settings, DEFAULT_SETTINGS } from '../platform/store.ts';
import { setAutoBackup } from '../platform/task.ts';
import { C, s } from './theme.ts';

const when = (ms: number) => new Date(ms).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

export function HomeScreen({ pairing, onForget }: { pairing: Pairing; onForget: () => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<PiStatus | null>(null);
  const [statusErr, setStatusErr] = useState('');
  const [last, setLast] = useState<LastRun | null>(null);
  const [access, setAccess] = useState<Access>('all');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(isRunning());

  const refresh = useCallback(async () => {
    setLast(await loadLast());
    setAccess(await mediaAccess(false));
    try {
      const c = await connect(http, pairing);
      setStatus(await c.status()); setStatusErr('');
    } catch (e) {
      setStatus(null); setStatusErr(e instanceof Error ? e.message : String(e));
    }
  }, [pairing]);

  useEffect(() => {
    void loadSettings().then(st => { setSettings(st); void setAutoBackup(st.auto).catch(() => {}); });
    void refresh();
    const sub = AppState.addEventListener('change', a => { if (a === 'active') void refresh(); });
    return () => sub.remove();
  }, [refresh]);

  const change = (k: keyof Settings, v: boolean) => {
    const next = { ...settings, [k]: v };
    setSettings(next);
    void saveSettings(next);
    if (k === 'auto') void setAutoBackup(v).catch(() => {});
  };

  const start = async () => {
    if ((await mediaAccess(true)) === 'none') {
      Alert.alert('İzin gerekli', 'Fotoğraflara erişim izni olmadan yedeklenemez. Ayarlar → Klyrix Yedek → Fotoğraflar\'dan izin verin.');
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
      void refresh();
    }
  };

  const forget = () => Alert.alert('Eşleştirmeyi kaldır', 'Bu telefon Pi\'ye bir daha yükleyemez (yeniden eşleştirene kadar). Pi\'deki yedekler kalır.', [
    { text: 'Vazgeç', style: 'cancel' },
    { text: 'Kaldır', style: 'destructive', onPress: () => void (async () => { await setAutoBackup(false).catch(() => {}); await forgetPairing(); onForget(); })() },
  ]);

  const pct = progress && progress.phase === 'upload' && progress.pending ? Math.round(((progress.done + progress.failed) / progress.pending) * 100) : 0;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Text style={s.title}>Klyrix Yedek</Text>
      <Text style={s.subtitle}>{pairing.piName || 'Klyrix Gate'} · {pairing.deviceName}</Text>

      <View style={s.card}>
        <Text style={s.h}>Pi'deki yedek</Text>
        {status ? (
          <>
            <Text style={s.big}>{status.device.files} dosya</Text>
            <Text style={s.p}>{fmtBytes(status.device.bytes)}{status.target ? ` · ${status.target.name}${status.target.free != null ? `, ${fmtBytes(status.target.free)} boş` : ''}` : ''}</Text>
            {!status.ok ? <Text style={s.err}>Pi'de mobil yedekleme kapalı — panelden açın.</Text> : null}
            {status.target && !status.target.mounted ? <Text style={s.err}>Pi'de yedek diski bağlı değil.</Text> : null}
          </>
        ) : statusErr ? <Text style={s.err}>{statusErr}</Text> : <ActivityIndicator color={C.text} />}
      </View>

      {access === 'limited' ? (
        <View style={s.card}>
          <Text style={s.p}>Yalnız seçtiğiniz fotoğraflara izin verdiniz: yalnız onlar yedeklenir.</Text>
          <Pressable style={s.btnOutline} onPress={() => void widenAccess()}><Text style={s.btnOutlineText}>Seçimi değiştir</Text></Pressable>
        </View>
      ) : null}

      <View style={s.card}>
        {running ? (
          <>
            <Text style={s.h}>{progress?.phase === 'upload' ? `Yükleniyor ${progress.done + progress.failed} / ${progress.pending}` : `Taranıyor… ${progress?.scanned ?? 0}`}</Text>
            <View style={s.bar}><View style={[s.barFill, { width: `${pct}%` }]} /></View>
            {progress?.current ? <Text style={s.p} numberOfLines={1}>{progress.current}</Text> : null}
            <Pressable style={s.btnOutline} onPress={requestStop}><Text style={s.btnOutlineText}>Durdur</Text></Pressable>
          </>
        ) : (
          <>
            <Text style={s.h}>Son yedekleme</Text>
            <Text style={s.p}>
              {last ? `${when(last.at)} — ${last.error && !last.uploaded ? last.error : `${last.uploaded} yeni dosya${last.failed ? `, ${last.failed} hata` : ''}${last.stopped ? ' (yarıda kaldı, sürecek)' : ''}`}` : 'Henüz yedeklenmedi'}
            </Text>
            <Pressable style={s.btn} onPress={() => void start()}><Text style={s.btnText}>Şimdi yedekle</Text></Pressable>
          </>
        )}
      </View>

      <View style={s.card}>
        <View style={s.row}><Text style={s.p}>Kendiliğinden yedekle (arka planda)</Text><Switch value={settings.auto} onValueChange={v => change('auto', v)} /></View>
        <View style={s.row}><Text style={s.p}>Yalnız Wi-Fi'da</Text><Switch value={settings.wifiOnly} onValueChange={v => change('wifiOnly', v)} /></View>
        <View style={s.row}><Text style={s.p}>Videoları da yedekle</Text><Switch value={settings.videos} onValueChange={v => change('videos', v)} /></View>
        <Text style={[s.p, { fontSize: 12 }]}>
          {Platform.OS === 'ios'
            ? 'iOS arka planda yedeklemeyi sistemin uygun gördüğü zamanlarda (çoğunlukla gece, şarjdayken) kısa süreler için çalıştırır; büyük arşivler için uygulamayı açık tutun.'
            : 'Android arka planda en sık 15 dakikada bir yedekler; pil tasarrufu uygulamayı kısıtlarsa açık tutun.'}
        </Text>
      </View>

      <Pressable style={s.btnOutline} onPress={forget}><Text style={[s.btnOutlineText, { color: C.bad }]}>Eşleştirmeyi kaldır</Text></Pressable>
    </ScrollView>
  );
}

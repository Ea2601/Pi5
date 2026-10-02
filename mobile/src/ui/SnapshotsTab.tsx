// Yedekler sekmesi: kişinin yedekleri (bu telefonun ve kişinin diğer telefonlarının), ayrıntı, telefona geri yükleme,
// çöpe taşıma; çöpte 30 gün içinde geri alma. Pi eski yedekleri seyreltir (backend mobileStore.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Archive, ArchiveRestore, ChevronLeft, Film, ImageIcon, RotateCcw, Square, Trash } from './icons.ts';
import type { Pairing2, Snapshot } from '../core/api.ts';
import { fmtBytes } from '../core/protocol.ts';
import { loadManifest, restoreItems, type RestoreProgress, type RestoreResult } from '../core/restore.ts';
import type { ManifestItem } from '../core/snapshot.ts';
import { gallerySink, RESTORE_ALBUM } from '../platform/media.ts';
import { openSession, type Session } from '../session.ts';
import { when } from './BackupTab.tsx';
import { Btn, Card, Chip, KV, Segmented } from './kit.tsx';
import type { PiState } from './Main.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000)) : 0);

export function SnapshotsTab({ pairing, pi }: { pairing: Pairing2; pi: PiState }) {
  const { s, p } = useTheme();
  const [view, setView] = useState<'live' | 'trash'>('live');
  const [trash, setTrash] = useState<Snapshot[] | null>(null);
  const [trashErr, setTrashErr] = useState('');
  const [open, setOpen] = useState<Snapshot | null>(null);

  const loadTrash = useCallback(async () => {
    try {
      setTrash(await (await openSession()).api.snapshots(true));
      setTrashErr('');
    } catch (e) {
      setTrashErr(msg(e));
    }
  }, []);
  useEffect(() => { if (view === 'trash') void loadTrash(); }, [view, loadTrash]);

  if (open) {
    return <SnapshotDetail snap={open} pairing={pairing} onBack={() => setOpen(null)}
      onChanged={() => { setOpen(null); void pi.refresh(); void loadTrash(); }} />;
  }
  const list = view === 'live' ? pi.snapshots : trash;
  const err = view === 'live' ? pi.error : trashErr;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Segmented<'live' | 'trash'> value={view} onChange={setView} options={[
        { value: 'live', label: 'Yedekler', icon: Archive },
        { value: 'trash', label: 'Çöp', icon: Trash },
      ]} />
      {list === null ? (err ? <Text style={s.err}>{err}</Text> : <Text style={s.p}>Yükleniyor…</Text>)
        : !list.length ? (
          <Card>
            <Text style={s.p}>
              {view === 'live' ? 'Henüz yedek yok. Yedekleme sekmesinde «Şimdi yedekle»ye basın.' : 'Çöp boş.'}
            </Text>
          </Card>
        ) : list.map(x => <SnapRow key={x.id} snap={x} mine={x.deviceId === pairing.deviceId} onPress={() => setOpen(x)} />)}
      <Text style={s.small}>
        {view === 'live'
          ? 'Telefonda bir şey değiştiğinde yeni yedek yazılır. Pi eski yedekleri seyreltir: son 14 günün her günü, son 8 haftanın her haftası ve son 12 ayın her ayı için bir yedek kalır. Yedekler şifreli; Pi içeriği göremez.'
          : 'Çöpe taşınan yedek 30 gün sonra kalıcı olarak silinir; o zamana kadar geri alınabilir.'}
      </Text>
      {view === 'live' && list?.length ? <Text style={[s.small, { color: p.textMuted }]}>Bir yedeğe dokunarak ayrıntısını açın.</Text> : null}
    </ScrollView>
  );
}

function SnapRow({ snap, mine, onPress }: { snap: Snapshot; mine: boolean; onPress: () => void }) {
  const { s, p } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [s.card, { gap: 8, opacity: pressed ? 0.85 : 1 }]}>
      <View style={s.row}>
        <Text style={[s.h, { flex: 1 }]}>{when(snap.createdAt)}</Text>
        <Chip text={mine ? 'Bu telefon' : snap.device} />
      </View>
      {/* Hizalı sütunlar: fotoğraf | video | boyut */}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <ImageIcon size={15} color={p.textSecondary} />
          <Text style={s.p}>{snap.stats.photos}</Text>
        </View>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Film size={15} color={p.textSecondary} />
          <Text style={s.p}>{snap.stats.videos}</Text>
        </View>
        <Text style={[s.p, { flex: 1, textAlign: 'right', fontFamily: FONT.medium, color: p.text }]}>{fmtBytes(snap.stats.bytes)}</Text>
      </View>
      {snap.deletedAt ? <Text style={s.small}>{daysLeft(snap.purgeAt)} gün sonra kalıcı olarak silinir</Text> : null}
    </Pressable>
  );
}

type Phase = 'idle' | 'opening' | 'counting' | 'ready' | 'running' | 'done';
function SnapshotDetail({ snap, pairing, onBack, onChanged }: { snap: Snapshot; pairing: Pairing2; onBack: () => void; onChanged: () => void }) {
  const { s, p } = useTheme();
  const mine = snap.deviceId === pairing.deviceId;
  const [phase, setPhase] = useState<Phase>('idle');
  const [total, setTotal] = useState(0);
  const [missing, setMissing] = useState<ManifestItem[]>([]);
  const [prog, setProg] = useState<RestoreProgress | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const stop = useRef(false);
  const session = useRef<Session | null>(null);
  const sink = useRef(gallerySink({ sameDevice: mine }));
  const sess = async () => (session.current ??= await openSession());

  const prepare = async () => {
    setErr(''); setPhase('opening');
    try {
      const ss = await sess();
      const m = await loadManifest(ss.api, ss.cipher, snap);
      setTotal(m.items.length);
      setPhase('counting');
      const out: ManifestItem[] = [];
      for (const it of m.items) if (!(await sink.current.exists(it))) out.push(it);
      setMissing(out);
      setPhase('ready');
    } catch (e) {
      setErr(msg(e));
      setPhase('idle');
    }
  };
  const run = async () => {
    stop.current = false; setErr(''); setProg(null); setPhase('running');
    try {
      const ss = await sess();
      setResult(await restoreItems(ss.api, ss.cipher, missing, sink.current, { onlyMissing: false, shouldStop: () => stop.current, onProgress: setProg }));
      setPhase('done');
    } catch (e) {
      setErr(msg(e));
      setPhase('ready');
    }
  };
  const act = async (f: (ss: Session) => Promise<void>) => {
    setBusy(true); setErr('');
    try {
      await f(await sess());
      onChanged();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const toTrash = () => Alert.alert('Yedeği çöpe taşı', `${when(snap.createdAt)} yedeği çöpe taşınsın mı? 30 gün içinde çöpten geri alabilirsiniz; sonra kalıcı olarak silinir.`, [
    { text: 'Vazgeç', style: 'cancel' },
    { text: 'Çöpe taşı', style: 'destructive', onPress: () => void act(ss => ss.api.deleteSnapshot(snap.id)) },
  ]);

  const running = phase === 'running';
  const pct = prog && prog.total ? Math.round(((prog.done + prog.skipped + prog.failed) / prog.total) * 100) : 0;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Btn kind="neutral" icon={ChevronLeft} label="Yedekler" disabled={running} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <Card title={when(snap.createdAt)} icon={<Archive size={18} color={p.textSecondary} />}>
        <KV label="Telefon" value={mine ? `${snap.device} (bu telefon)` : snap.device} />
        <KV label="Fotoğraf" value={String(snap.stats.photos)} />
        <KV label="Video" value={String(snap.stats.videos)} />
        <KV label="Boyut" value={fmtBytes(snap.stats.bytes)} />
      </Card>

      {snap.deletedAt ? (
        <Card title="Çöpte">
          <Text style={s.p}>{daysLeft(snap.purgeAt)} gün sonra kalıcı olarak silinir ({snap.purgeAt ? when(snap.purgeAt) : ''}).</Text>
          <Btn kind="on" icon={RotateCcw} label="Çöpten geri al" busy={busy} onPress={() => void act(ss => ss.api.undeleteSnapshot(snap.id))} />
          {err ? <Text style={s.err}>{err}</Text> : null}
        </Card>
      ) : (
        <>
          <Card title="Telefona geri yükle" icon={<ArchiveRestore size={18} color={p.textSecondary} />}>
            <Text style={s.p}>
              {mine
                ? `Bu telefonda artık olmayan fotoğraf ve videolar «${RESTORE_ALBUM}» albümüne eklenir; telefonda duranlar yinelenmez.`
                : `Başka bir telefonun (${snap.device}) yedeği: öğelerin hepsi bu telefonun «${RESTORE_ALBUM}» albümüne eklenir.`}
            </Text>
            {phase === 'idle' ? <Btn kind="on" icon={ArchiveRestore} label="Geri yüklemeyi hazırla" onPress={() => void prepare()} /> : null}
            {phase === 'opening' ? <Text style={s.h}>Yedeğin içerik listesi açılıyor…</Text> : null}
            {phase === 'counting' ? <Text style={s.h}>Telefondakiler karşılaştırılıyor…</Text> : null}
            {phase === 'ready' ? (
              <>
                <Text style={s.h}>{mine ? `${total} öğeden ${missing.length} tanesi bu telefonda yok.` : `${total} öğe geri yüklenecek.`}</Text>
                <Btn kind="on" icon={ArchiveRestore} label={missing.length ? `${missing.length} öğeyi geri yükle` : 'Geri yüklenecek öğe yok'}
                  disabled={!missing.length} onPress={() => void run()} />
              </>
            ) : null}
            {running ? (
              <>
                <Text style={s.h}>Geri yükleniyor {prog ? prog.done + prog.failed : 0} / {missing.length}</Text>
                <View style={s.bar}><View style={[s.barFill, { width: `${pct}%` }]} /></View>
                {prog?.current ? <Text style={s.small} numberOfLines={1}>{prog.current}</Text> : null}
                <Text style={s.small}>Geri yükleme sürerken uygulamayı açık tutun.</Text>
                <Btn kind="off" icon={Square} label="Durdur" onPress={() => { stop.current = true; }} />
              </>
            ) : null}
            {phase === 'done' && result ? (
              <>
                <KV label="Geri yüklenen" value={`${result.restored} öğe`} tone="ok" />
                {result.failed ? <KV label="Geri yüklenemeyen" value={String(result.failed)} tone="bad" /> : null}
                {result.error ? <Text style={s.small}>{result.error}</Text> : null}
                {result.stopped ? <Text style={s.small}>Durduruldu; yeniden hazırlayınca kalanlar geri yüklenir.</Text> : null}
                <Text style={s.small}>Fotoğraflar uygulamasında «{RESTORE_ALBUM}» albümüne bakın.</Text>
                <Btn kind="neutral" label="Yeniden hazırla" onPress={() => { setResult(null); void prepare(); }} />
              </>
            ) : null}
            {err ? <Text style={s.err}>{err}</Text> : null}
          </Card>
          <Btn kind="off" icon={Trash} label="Çöpe taşı" busy={busy} disabled={running} onPress={toTrash} />
        </>
      )}
    </ScrollView>
  );
}

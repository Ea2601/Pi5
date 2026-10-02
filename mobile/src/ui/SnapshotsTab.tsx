// Yedekler sekmesi: kişinin yedekleri (bu telefonun ve kişinin diğer telefonlarının), ayrıntı, telefona geri yükleme
// (RestorePanel: her tür ayrı), çöpe taşıma; çöpte 30 gün içinde geri alma. Pi eski yedekleri seyreltir (backend mobileStore.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Archive, ChevronLeft, Film, ImageIcon, RotateCcw, Trash } from './icons.ts';
import type { Pairing2, Snapshot, SnapshotStats } from '../core/api.ts';
import { fmtBytes } from '../core/protocol.ts';
import { openSession, type Session } from '../session.ts';
import { when } from './BackupTab.tsx';
import { Btn, Card, Chip, KV, Segmented } from './kit.tsx';
import type { PiState } from './Main.tsx';
import { RestorePanel } from './RestorePanel.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000)) : 0);
// Fotoğraf / video dışındaki türler (varsa): "Ses 12 · Dosya 340 · Kişi 312 · Etkinlik 85"
const extras = (st: SnapshotStats) => [
  st.audio ? `Ses ${st.audio}` : '', st.files ? `Dosya ${st.files}` : '', st.contacts ? `Kişi ${st.contacts}` : '', st.events ? `Etkinlik ${st.events}` : '',
].filter(Boolean).join(' · ');

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
  const more = extras(snap.stats);
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
      {more ? <Text style={s.small}>{more}</Text> : null}
      {snap.deletedAt ? <Text style={s.small}>{daysLeft(snap.purgeAt)} gün sonra kalıcı olarak silinir</Text> : null}
    </Pressable>
  );
}

function SnapshotDetail({ snap, pairing, onBack, onChanged }: { snap: Snapshot; pairing: Pairing2; onBack: () => void; onChanged: () => void }) {
  const { s, p } = useTheme();
  const mine = snap.deviceId === pairing.deviceId;
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(0);
  const [err, setErr] = useState('');
  const session = useRef<Session | null>(null);
  const sess = async () => (session.current ??= await openSession());
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
  const st = snap.stats;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll}>
      <Btn kind="neutral" icon={ChevronLeft} label="Yedekler" disabled={restoring > 0} onPress={onBack} style={{ alignSelf: 'flex-start' }} />
      <Card title={when(snap.createdAt)} icon={<Archive size={18} color={p.textSecondary} />}>
        <KV label="Telefon" value={mine ? `${snap.device} (bu telefon)` : snap.device} />
        <KV label="Fotoğraf" value={String(st.photos)} />
        <KV label="Video" value={String(st.videos)} />
        {st.audio ? <KV label="Ses" value={String(st.audio)} /> : null}
        {st.files ? <KV label="Dosya" value={String(st.files)} /> : null}
        {st.contacts ? <KV label="Kişi" value={String(st.contacts)} /> : null}
        {st.events ? <KV label="Takvim etkinliği" value={String(st.events)} /> : null}
        <KV label="Boyut" value={fmtBytes(st.bytes)} />
      </Card>

      {snap.deletedAt ? (
        <Card title="Çöpte">
          <Text style={s.p}>{daysLeft(snap.purgeAt)} gün sonra kalıcı olarak silinir ({snap.purgeAt ? when(snap.purgeAt) : ''}).</Text>
          <Btn kind="on" icon={RotateCcw} label="Çöpten geri al" busy={busy} onPress={() => void act(ss => ss.api.undeleteSnapshot(snap.id))} />
          {err ? <Text style={s.err}>{err}</Text> : null}
        </Card>
      ) : (
        <>
          <RestorePanel snap={snap} mine={mine} session={sess} onBusy={b => setRestoring(n => Math.max(0, n + (b ? 1 : -1)))} />
          <Btn kind="off" icon={Trash} label="Çöpe taşı" busy={busy} disabled={restoring > 0} onPress={toTrash} />
          {err ? <Text style={s.err}>{err}</Text> : null}
        </>
      )}
    </ScrollView>
  );
}

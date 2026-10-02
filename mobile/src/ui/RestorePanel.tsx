// Yedekten geri yükleme (Yedekler → ayrıntı): içerik listesi açılır, her tür kendi kartında geri yüklenir. Telefonda hiçbir
// şey silinmez ya da üzerine yazılmaz; yalnız eksikler eklenir:
//  - Fotoğraf ve video / ses: galeriye ("Klyrix Gate Sync" albümleri); yedek bu telefonunsa telefonda duranlar atlanır
//  - Dosyalar: seçilen hedef klasöre, yedekteki alt klasörleriyle
//  - Kişiler / takvim: telefonda olmayanlar (ad + telefon / e-posta; başlık + başlangıç eşleşmesi) — sayı önce gösterilir
import { useRef, useState, type ReactNode } from 'react';
import { Alert, Text, View } from 'react-native';
import { ArchiveRestore, CalendarDays, Contact, FolderOpen, ImageIcon, Music, Square } from './icons.ts';
import type { Snapshot } from '../core/api.ts';
import { downloadItem, loadManifest, restoreItems, type RestoreProgress, type RestoreResult, type Sink } from '../core/restore.ts';
import type { Manifest, ManifestItem } from '../core/snapshot.ts';
import { addEvents, calendarAccess, planCalendar, RESTORE_CALENDAR } from '../platform/calendar.ts';
import { addContacts, contactsAccess, planContacts } from '../platform/contacts.ts';
import { folderSink, pickRestoreFolder } from '../platform/folders.ts';
import { gallerySink, RESTORE_ALBUM, RESTORE_AUDIO_ALBUM } from '../platform/media.ts';
import type { Session } from '../session.ts';
import { Btn, Card, KV } from './kit.tsx';
import { useTheme } from './ThemeContext.tsx';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// onBusy: geri yükleme sürerken ayrıntı ekranı geri / çöpe taşı düğmelerini kilitler
export function RestorePanel({ snap, mine, session, onBusy }: {
  snap: Snapshot; mine: boolean; session: () => Promise<Session>; onBusy: (busy: boolean) => void;
}) {
  const { s, p } = useTheme();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = async () => {
    setBusy(true); setErr('');
    try {
      const ss = await session();
      setManifest(await loadManifest(ss.api, ss.cipher, snap));
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  if (!manifest) {
    return (
      <Card title="Telefona geri yükle" icon={<ArchiveRestore size={18} color={p.textSecondary} />}>
        <Text style={s.p}>Yedeğin içerik listesi açılır; sonra her türü ayrı ayrı geri yükleyebilirsiniz. Telefonda hiçbir şey silinmez.</Text>
        <Btn kind="on" icon={ArchiveRestore} label="Geri yüklemeyi hazırla" busy={busy} onPress={() => void open()} />
        {err ? <Text style={s.err}>{err}</Text> : null}
      </Card>
    );
  }
  const of = (...kinds: ManifestItem['kind'][]) => manifest.items.filter(x => kinds.includes(x.kind));
  const visual = of('photo', 'video');
  const audio = of('audio');
  const files = of('file');
  const contacts = of('contacts')[0];
  const calendar = of('calendar')[0];
  return (
    <>
      {visual.length ? (
        <StreamGroup title="Fotoğraf ve videolar" icon={ImageIcon} items={visual} session={session} onBusy={onBusy} mine={mine}
          note={mine ? `Bu telefonda artık olmayanlar «${RESTORE_ALBUM}» albümüne eklenir; telefonda duranlar yinelenmez.`
            : `Başka bir telefonun (${snap.device}) yedeği: hepsi «${RESTORE_ALBUM}» albümüne eklenir.`}
          sink={async () => gallerySink({ sameDevice: mine })} />
      ) : null}
      {audio.length ? (
        <StreamGroup title="Ses kayıtları ve müzik" icon={Music} items={audio} session={session} onBusy={onBusy} mine={mine}
          note={`${mine ? 'Bu telefonda olmayanlar' : 'Hepsi'} «${RESTORE_AUDIO_ALBUM}» albümüne eklenir.`}
          sink={async () => gallerySink({ sameDevice: mine, audio: true })} />
      ) : null}
      {files.length ? (
        <StreamGroup title="Dosyalar" icon={FolderOpen} items={files} session={session} onBusy={onBusy} mine={false}
          note="Bir hedef klasör seçin: dosyalar yedekteki klasör adları ve alt klasörleriyle oraya yazılır (var olanların üzerine yazılmaz)."
          sink={async () => {
            const dir = await pickRestoreFolder();
            return dir ? folderSink(dir) : null;
          }} />
      ) : null}
      {contacts ? (
        <RecordsGroup title="Kişiler" icon={Contact} item={contacts} session={session} onBusy={onBusy} unit="kişi"
          ask={() => contactsAccess(true)} plan={async b => { const r = await planContacts(b); return { total: r.contacts.length, missing: r.missing }; }}
          add={(list, cb) => addContacts(list as Parameters<typeof addContacts>[0], cb)}
          note="Telefonda olmayan kişiler eklenir: adı ve telefonu (ya da e-postası) aynı olan kişi atlanır." />
      ) : null}
      {calendar ? (
        <RecordsGroup title="Takvim" icon={CalendarDays} item={calendar} session={session} onBusy={onBusy} unit="etkinlik"
          ask={() => calendarAccess(true)} plan={async b => { const r = await planCalendar(b); return { total: r.events.length, missing: r.missing }; }}
          add={(list, cb) => addEvents(list as Parameters<typeof addEvents>[0], cb)}
          note={`Telefonda olmayan etkinlikler «${RESTORE_CALENDAR}» takvimine eklenir: başlığı ve başlangıcı aynı olan atlanır.`} />
      ) : null}
      {!visual.length && !audio.length && !files.length && !contacts && !calendar ? <Card><Text style={s.p}>Bu yedekte öğe yok.</Text></Card> : null}
    </>
  );
}

type Icon = (props: { size: number; color: string }) => ReactNode;
type Phase = 'idle' | 'counting' | 'ready' | 'running' | 'done';

// Akışlı geri yükleme (galeri, klasör): eksikleri bul → parça parça indir, çöz, yaz
function StreamGroup({ title, icon: I, items, session, onBusy, mine, note, sink }: {
  title: string; icon: Icon; items: ManifestItem[]; session: () => Promise<Session>; onBusy: (b: boolean) => void; mine: boolean;
  note: string; sink: () => Promise<Sink | null>;
}) {
  const { s, p } = useTheme();
  const [phase, setPhase] = useState<Phase>('idle');
  const [missing, setMissing] = useState<ManifestItem[]>([]);
  const [prog, setProg] = useState<RestoreProgress | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [err, setErr] = useState('');
  const stop = useRef(false);
  const sk = useRef<Sink | null>(null);

  const count = async () => {
    setErr(''); setResult(null);
    const k = await sink().catch(e => { setErr(msg(e)); return null; });
    if (!k) return;
    sk.current = k;
    setPhase('counting');
    try {
      const out: ManifestItem[] = [];
      for (const it of items) if (!(mine && await k.exists(it).catch(() => false))) out.push(it);
      setMissing(out);
      setPhase('ready');
    } catch (e) {
      setErr(msg(e));
      setPhase('idle');
    }
  };
  const run = async () => {
    if (!sk.current) return;
    stop.current = false; setErr(''); setProg(null); setPhase('running');
    onBusy(true);
    try {
      const ss = await session();
      setResult(await restoreItems(ss.api, ss.cipher, missing, sk.current, { onlyMissing: false, shouldStop: () => stop.current, onProgress: setProg }));
      setPhase('done');
    } catch (e) {
      setErr(msg(e));
      setPhase('ready');
    } finally {
      onBusy(false);
    }
  };
  const pct = prog && prog.total ? Math.round(((prog.done + prog.failed) / prog.total) * 100) : 0;
  return (
    <Card title={title} icon={<I size={18} color={p.textSecondary} />}>
      <KV label="Yedekte" value={String(items.length)} />
      <Text style={s.small}>{note}</Text>
      {phase === 'idle' ? <Btn kind="on" icon={ArchiveRestore} label="Geri yüklemeyi hazırla" onPress={() => void count()} /> : null}
      {phase === 'counting' ? <Text style={s.h}>Telefondakiler karşılaştırılıyor…</Text> : null}
      {phase === 'ready' ? (
        <>
          <Text style={s.h}>{mine ? `${items.length} öğeden ${missing.length} tanesi bu telefonda yok.` : `${missing.length} öğe geri yüklenecek.`}</Text>
          <Btn kind="on" icon={ArchiveRestore} label={missing.length ? `${missing.length} öğeyi geri yükle` : 'Geri yüklenecek öğe yok'}
            disabled={!missing.length} onPress={() => void run()} />
        </>
      ) : null}
      {phase === 'running' ? (
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
          <KV label="Geri yüklenen" value={String(result.restored)} tone="ok" />
          {result.failed ? <KV label="Geri yüklenemeyen" value={String(result.failed)} tone="bad" /> : null}
          {result.error ? <Text style={s.small}>{result.error}</Text> : null}
          {result.stopped ? <Text style={s.small}>Durduruldu; yeniden hazırlayınca kalanlar geri yüklenir.</Text> : null}
          <Btn kind="neutral" label="Yeniden hazırla" onPress={() => void count()} />
        </>
      ) : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
    </Card>
  );
}

// Kayıt geri yükleme (kişiler, takvim): tek öğe indirilir, telefondakiyle karşılaştırılır, eksikler eklenir
function RecordsGroup({ title, icon: I, item, session, onBusy, unit, ask, plan, add, note }: {
  title: string; icon: Icon; item: ManifestItem; session: () => Promise<Session>; onBusy: (b: boolean) => void; unit: string; note: string;
  ask: () => Promise<boolean>; plan: (b: Uint8Array) => Promise<{ total: number; missing: unknown[] }>;
  add: (list: unknown[], onProgress: (n: number) => void) => Promise<{ added: number; failed: number }>;
}) {
  const { s, p } = useTheme();
  const [phase, setPhase] = useState<Phase>('idle');
  const [total, setTotal] = useState(0);
  const [missing, setMissing] = useState<unknown[]>([]);
  const [done, setDone] = useState(0);
  const [result, setResult] = useState<{ added: number; failed: number } | null>(null);
  const [err, setErr] = useState('');
  const prepare = async () => {
    setErr(''); setResult(null);
    if (!(await ask().catch(() => false))) { setErr(`${title} izni verilmedi — telefonun Ayarlar bölümünden verebilirsiniz.`); return; }
    setPhase('counting');
    try {
      const ss = await session();
      const r = await plan(await downloadItem(ss.api, ss.cipher, item));
      setTotal(r.total); setMissing(r.missing); setPhase('ready');
    } catch (e) {
      setErr(msg(e));
      setPhase('idle');
    }
  };
  const run = () => Alert.alert(`${title} geri yüklensin mi?`, `${missing.length} ${unit} telefona eklenecek.`, [
    { text: 'Vazgeç', style: 'cancel' },
    {
      text: 'Ekle', onPress: () => void (async () => {
        setPhase('running'); setDone(0);
        onBusy(true);
        try {
          setResult(await add(missing, setDone));
          setPhase('done');
        } catch (e) {
          setErr(msg(e));
          setPhase('ready');
        } finally {
          onBusy(false);
        }
      })(),
    },
  ]);
  return (
    <Card title={title} icon={<I size={18} color={p.textSecondary} />}>
      <KV label="Yedekte" value={`${item.count ?? 0} ${unit}`} />
      <Text style={s.small}>{note}</Text>
      {phase === 'idle' ? <Btn kind="on" icon={ArchiveRestore} label="Geri yüklemeyi hazırla" onPress={() => void prepare()} /> : null}
      {phase === 'counting' ? <Text style={s.h}>Telefondakiyle karşılaştırılıyor…</Text> : null}
      {phase === 'ready' ? (
        <>
          <Text style={s.h}>{total} {unit} içinden {missing.length} tanesi telefonda yok.</Text>
          <Btn kind="on" icon={ArchiveRestore} label={missing.length ? `${missing.length} ${unit} ekle` : `Eklenecek ${unit} yok`} disabled={!missing.length} onPress={run} />
        </>
      ) : null}
      {phase === 'running' ? <Text style={s.h}>Ekleniyor {done} / {missing.length}</Text> : null}
      {phase === 'done' && result ? (
        <>
          <KV label="Eklenen" value={`${result.added} ${unit}`} tone="ok" />
          {result.failed ? <KV label="Eklenemeyen" value={String(result.failed)} tone="bad" /> : null}
        </>
      ) : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
    </Card>
  );
}

// İlk kurulum (panel sihirbaz kuralı): adımlar sırayla, her biri doğrulanınca sıradaki açılır; yalnız sıradaki vurgulu.
//  1. Pi'ye bağlan — panelde kişinin «Telefon ekle» QR'ı ya da Pi'nin adresi + kod (tek kullanımlık, 10 dk)
//  2. Şifreleme anahtarı — kişinin ilk telefonu anahtar üretir: kurtarma anahtarı gösterilir, iki grubu yazılarak doğrulanır,
//     sınaması Pi'ye yazılır. Kişinin başka telefonu varsa kurtarma anahtarı girilir, Pi'deki sınamayla doğrulanır.
//  3. Fotoğraflara erişim — izin (sonra da verilebilir: "Şimdilik geç")
//  4. Hazır — ana ekrana geç
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Share, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { Check, ImageIcon, Keyboard, Play, QrCode, Share2, Square, Unlink } from './icons.ts';
import { connect2, pair2, type Pairing2, type Profile } from '../core/api.ts';
import { PiError } from '../core/client.ts';
import { encodeRecoveryKey, makeKeyCheck, parseRecoveryKey, verifyKeyCheck } from '../core/crypto.ts';
import { manualPayload, parsePayload, type PairPayload } from '../core/protocol.ts';
import { makeCipher, newKey } from '../platform/cipher.ts';
import { http } from '../platform/http.ts';
import { mediaAccess } from '../platform/media.ts';
import { dropLegacyPairing, forgetPairing, savePairing, saveKey } from '../platform/store.ts';
import { Btn, Step } from './kit.tsx';
import { Logo, Wordmark } from './Header.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Onboarding({ initial, legacy, onDone }: { initial: Pairing2 | null; legacy: boolean; onDone: (p: Pairing2) => void }) {
  const { s, p } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, askPerm] = useCameraPermissions();
  const [paired, setPaired] = useState<Pairing2 | null>(initial);
  const [keyOk, setKeyOk] = useState(false);
  const [mediaDone, setMediaDone] = useState<'' | 'granted' | 'skipped'>('');
  const [scan, setScan] = useState(false);
  const [manual, setManual] = useState(false);
  const [addr, setAddr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const handled = useRef(false);

  const go = async (pl: PairPayload) => {
    setBusy(true); setErr(''); setScan(false);
    try {
      const name = (Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android')).slice(0, 40);
      const { pairing } = await pair2(http, pl, name, Platform.OS === 'ios' ? 'ios' : 'android');
      await savePairing(pairing);
      await dropLegacyPairing();
      setPaired(pairing);
    } catch (e) {
      setErr(msg(e));
      handled.current = false;
    } finally {
      setBusy(false);
    }
  };
  const startScan = async () => {
    setErr('');
    if (!perm?.granted && !(await askPerm()).granted) { setErr('Kamera izni verilmedi — kodu elle girebilirsiniz'); return; }
    handled.current = false;
    setScan(true);
  };
  const askMedia = async () => {
    const a = await mediaAccess(true);
    if (a === 'none') setErr('Fotoğraf izni verilmedi — telefonun Ayarlar → Uygulamalar bölümünden açabilir ya da şimdilik geçebilirsiniz');
    else { setErr(''); setMediaDone('granted'); }
  };
  const unpair = async () => { await forgetPairing(); setPaired(null); setKeyOk(false); setErr(''); };

  const step1 = paired ? 'done' : 'current';
  const step2 = !paired ? 'locked' : keyOk ? 'done' : 'current';
  const step3 = !keyOk ? 'locked' : mediaDone ? 'done' : 'current';
  const step4 = keyOk && mediaDone ? 'current' : 'locked';
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.scroll, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Logo size={64} />
        <Wordmark size={24} />
        <Text style={[s.p, { textAlign: 'center' }]}>
          Fotoğraflarınız ve videolarınız evinizdeki Klyrix/gate cihazına uçtan uca şifreli yedeklenir: içeriği yalnız sizin
          telefonlarınız açabilir. Telefondan hiçbir şey silinmez.
        </Text>
      </View>
      {legacy && !paired ? (
        <View style={[s.card, { borderColor: p.warning }]}>
          <Text style={s.p}>
            Uygulama güncellendi: yedekler artık uçtan uca şifreli ve kişiye bağlı. Panelde kişinizi seçip «Telefon ekle» ile bu
            telefonu yeniden eşleştirin. Eski yedekleriniz Pi'de duruyor.
          </Text>
        </View>
      ) : null}

      <Step n={1} title={paired ? `Pi'ye bağlandı — ${paired.profileName}` : "Pi'ye bağlan"} state={step1}>
        {paired ? null : <>
          <Text style={s.p}>
            Pi panelinde Yedekleme → Cihaz Yedekleme → «Telefon ve tablet» bölümünde kişinizi ekleyin (ya da kişinizde «Telefon
            ekle»ye basın) ve QR kodu okutun. Telefon Pi ile aynı ev Wi-Fi'ında olmalı.
          </Text>
          {scan ? (
            <View style={{ height: 300, borderRadius: 8, overflow: 'hidden' }}>
              <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={r => {
                  if (handled.current) return;
                  handled.current = true;
                  const pl = parsePayload(r.data);
                  if (pl) { void go(pl); return; }
                  // Başka bir kod (barkod, başka QR) yakalandı: söyle, taramayı açık tut — 2 sn sonra yeniden okur
                  setErr('Bu QR Klyrix/gate eşleştirme kodu değil — panelde «Telefon ekle»deki QR\'ı okutun');
                  setTimeout(() => { handled.current = false; }, 2000);
                }} />
            </View>
          ) : null}
          <Btn kind={scan ? 'off' : 'primary'} icon={scan ? Square : QrCode} label={scan ? 'Taramayı durdur' : 'QR kodu okut'} disabled={busy}
            onPress={() => (scan ? setScan(false) : void startScan())} />
          <Btn kind="neutral" icon={Keyboard} label="Kodu elle gir" disabled={busy} onPress={() => setManual(m => !m)} />
          {manual ? (
            <View style={{ gap: 8 }}>
              <TextInput style={s.input} placeholder="Pi'nin adresi (ör. 192.168.1.153)" placeholderTextColor={p.textMuted}
                autoCapitalize="none" autoCorrect={false} keyboardType="url" value={addr} onChangeText={setAddr} />
              <TextInput style={[s.input, { fontFamily: FONT.mono }]} placeholder="Kod (ör. ABCD-EFGH)" placeholderTextColor={p.textMuted}
                autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} />
              <Btn kind="on" icon={Check} label="Bağlan" busy={busy} onPress={() => {
                const m = manualPayload(addr, code);
                if (typeof m === 'string') setErr(m); else void go(m);
              }} />
            </View>
          ) : null}
          {err ? <Text style={s.err}>{err}</Text> : null}
        </>}
      </Step>

      <Step n={2} title="Şifreleme anahtarı" state={step2}>
        {paired ? <KeyStep pairing={paired} onDone={() => setKeyOk(true)} onUnpair={() => void unpair()} /> : null}
      </Step>

      <Step n={3} title="Fotoğraflara erişim" state={step3}>
        <Text style={s.p}>Yedeklemek için fotoğraf ve videolarınızı okuma izni gerekir. Uygulama hiçbir şeyi silmez ya da değiştirmez.</Text>
        <Btn kind="on" icon={ImageIcon} label="İzin ver" onPress={() => void askMedia()} />
        <Btn kind="neutral" label="Şimdilik geç" onPress={() => { setErr(''); setMediaDone('skipped'); }} />
        {err && keyOk ? <Text style={s.err}>{err}</Text> : null}
      </Step>

      <Step n={4} title="Hazır" state={step4}>
        <Text style={s.p}>
          {mediaDone === 'skipped'
            ? 'İzin vermediğiniz için yedekleme şimdilik çalışmaz; Ayarlar\'dan ya da «Şimdi yedekle»ye basınca izin verebilirsiniz.'
            : 'Yedekleme hazır. Ana ekranda «Şimdi yedekle» ile başlatabilirsiniz; arka planda da kendiliğinden sürer.'}
        </Text>
        {paired ? <Btn kind="on" icon={Play} label="Başla" onPress={() => onDone(paired)} /> : null}
      </Step>
    </ScrollView>
  );
}

// İki farklı grup (doğrulamada sorulur)
function pickTwo(n: number): [number, number] {
  const a = Math.floor(Math.random() * n);
  let b = Math.floor(Math.random() * (n - 1));
  if (b >= a) b++;
  return a < b ? [a, b] : [b, a];
}
const norm = (x: string) => x.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

function KeyStep({ pairing, onDone, onUnpair }: { pairing: Pairing2; onDone: () => void; onUnpair: () => void }) {
  const { s, p } = useTheme();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [mode, setMode] = useState<'new' | 'join' | null>(null);
  const [key] = useState(newKey);
  const [groups] = useState(() => encodeRecoveryKey(key).split('-'));
  const [ask] = useState(() => pickTwo(9));
  const [stage, setStage] = useState<'show' | 'verify'>('show');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const prof = await (await connect2(http, pairing)).profile();
      setProfile(prof);
      setMode(prof.keyCheck ? 'join' : 'new');
    } catch (e) {
      setErr(msg(e));
    }
  }, [pairing]);
  useEffect(() => { void load(); }, [load]);

  const finishNew = async () => {
    if (norm(a) !== groups[ask[0]] || norm(b) !== groups[ask[1]]) { setErr('Gruplar tutmadı — yazdığınız anahtarı kontrol edin'); return; }
    setBusy(true); setErr('');
    try {
      const api = await connect2(http, pairing);
      await api.setKeyCheck(await makeKeyCheck(await makeCipher(key)));
      await saveKey(pairing.profileId, key);
      onDone();
    } catch (e) {
      if (e instanceof PiError && e.status === 409) {
        setErr('Bu kişinin anahtarı az önce başka bir telefonda oluşturuldu — o telefondaki kurtarma anahtarını girin.');
        await load();
      } else setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const finishJoin = async () => {
    const k = parseRecoveryKey(typed);
    if (!k) { setErr('Kurtarma anahtarı 9 gruplu 54 karakterdir; bir harfi yanlış ya da eksik'); return; }
    setBusy(true); setErr('');
    try {
      if (!profile?.keyCheck || !(await verifyKeyCheck(await makeCipher(k), profile.keyCheck))) {
        setErr(`Bu anahtar ${profile?.name ?? 'bu kişinin'} anahtarı değil`);
        return;
      }
      await saveKey(pairing.profileId, k);
      onDone();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mode) {
    return (
      <>
        {err ? <Text style={s.err}>{err}</Text> : <Text style={s.p}>Pi'ye soruluyor…</Text>}
        {err ? <Btn kind="neutral" label="Yeniden dene" onPress={() => void load()} /> : null}
      </>
    );
  }
  const cancel = <Btn kind="off" icon={Unlink} label="Eşleştirmeyi iptal et" disabled={busy} onPress={onUnpair} />;
  if (mode === 'join') {
    return (
      <>
        <Text style={s.p}>
          {profile?.name} kişisinin yedekleri şifreli. Kurtarma anahtarını girin: kişinin diğer telefonunda Ayarlar → Şifreleme →
          «Kurtarma anahtarını göster» ya da ilk kurulumda kaydettiğiniz anahtar.
        </Text>
        <TextInput style={[s.input, { fontFamily: FONT.mono, minHeight: 72, textAlignVertical: 'top' }]} multiline autoCapitalize="characters"
          autoCorrect={false} placeholder="XXXXXX-XXXXXX-…" placeholderTextColor={p.textMuted} value={typed} onChangeText={setTyped} />
        <Btn kind="on" icon={Check} label="Anahtarı doğrula" busy={busy} onPress={() => void finishJoin()} />
        {err ? <Text style={s.err}>{err}</Text> : null}
        {cancel}
      </>
    );
  }
  if (stage === 'show') {
    return (
      <>
        <Text style={s.p}>
          Bu kişinin yedekleri bu anahtarla şifrelenir. Telefon kaybolursa ya da yeni telefona geçerseniz yedekler yalnız
          <Text style={{ fontFamily: FONT.semibold, color: p.text }}> kurtarma anahtarıyla</Text> açılır — Pi'de ve panelde yoktur.
          Yazın ya da şifre yöneticinize kaydedin.
        </Text>
        <KeyGrid groups={groups} />
        <Btn kind="neutral" icon={Share2} label="Paylaş / kaydet" onPress={() => void shareKey(pairing.profileName, groups)} />
        <Btn kind="on" icon={Check} label="Kaydettim, doğrula" onPress={() => { setErr(''); setStage('verify'); }} />
        {cancel}
      </>
    );
  }
  return (
    <>
      <Text style={s.p}>Kaydettiğiniz anahtarın {ask[0] + 1}. ve {ask[1] + 1}. grubunu yazın.</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[s.input, { flex: 1, minWidth: 0, fontFamily: FONT.mono }]} autoCapitalize="characters" autoCorrect={false} maxLength={8}
          placeholder={`${ask[0] + 1}. grup`} placeholderTextColor={p.textMuted} value={a} onChangeText={setA} />
        <TextInput style={[s.input, { flex: 1, minWidth: 0, fontFamily: FONT.mono }]} autoCapitalize="characters" autoCorrect={false} maxLength={8}
          placeholder={`${ask[1] + 1}. grup`} placeholderTextColor={p.textMuted} value={b} onChangeText={setB} />
      </View>
      <Btn kind="on" icon={Check} label="Doğrula ve kaydet" busy={busy} onPress={() => void finishNew()} />
      <Btn kind="neutral" label="Anahtarı yeniden göster" disabled={busy} onPress={() => { setErr(''); setStage('show'); }} />
      {err ? <Text style={s.err}>{err}</Text> : null}
    </>
  );
}

// Kurtarma anahtarı: 9 numaralı grup, üçlü sıralar (Ayarlar → Şifreleme de kullanır)
export function KeyGrid({ groups }: { groups: string[] }) {
  const { s, p } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', paddingVertical: 4 }}>
      {groups.map((g, i) => (
        <View key={i} style={{ width: '30%', alignItems: 'center', paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: p.border, backgroundColor: p.input }}>
          <Text style={[s.small, { fontSize: 11 }]}>{i + 1}</Text>
          <Text style={[s.mono, { fontSize: 16, letterSpacing: 1 }]} selectable>{g}</Text>
        </View>
      ))}
    </View>
  );
}
export const shareKey = (person: string, groups: string[]) =>
  Share.share({ message: `Klyrix/Gate Sync kurtarma anahtarı (${person}): ${groups.join('-')}` }).catch(() => {});

// İlk kurulum (panel sihirbaz kuralı): adımlar sırayla, her biri doğrulanınca sıradaki açılır; yalnız sıradaki vurgulu.
//  1. Pi'ye bağlan — paneldeki «Telefon ekle» QR'ı ya da Pi'nin adresi + kod (tek kullanımlık, 10 dk)
//  2. Fotoğraflara erişim — izin (sonra da verilebilir: "Şimdilik geç")
//  3. Hazır — ana ekrana geç
import { useRef, useState } from 'react';
import { Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { Check, ImageIcon, Keyboard, Play, QrCode, Square } from './icons.ts';
import { pair } from '../core/client.ts';
import { manualPayload, parsePayload, type PairPayload, type Pairing } from '../core/protocol.ts';
import { http } from '../platform/http.ts';
import { mediaAccess } from '../platform/media.ts';
import { savePairing } from '../platform/store.ts';
import { Btn, Step } from './kit.tsx';
import { Logo, Wordmark } from './Header.tsx';
import { useTheme } from './ThemeContext.tsx';

export function Onboarding({ onDone }: { onDone: (p: Pairing) => void }) {
  const { s, p } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, askPerm] = useCameraPermissions();
  const [paired, setPaired] = useState<Pairing | null>(null);
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
      const pr = await pair(http, pl, name, Platform.OS === 'ios' ? 'ios' : 'android');
      await savePairing(pr);
      setPaired(pr);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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

  const step1 = paired ? 'done' : 'current';
  const step2 = !paired ? 'locked' : mediaDone ? 'done' : 'current';
  const step3 = paired && mediaDone ? 'current' : 'locked';
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.scroll, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Logo size={64} />
        <Wordmark size={24} />
        <Text style={[s.p, { textAlign: 'center' }]}>
          Fotoğraflarınız, videolarınız ve seçtiğiniz içerikler evinizdeki Klyrix/gate cihazına yedeklenir. Telefondan hiçbir şey
          silinmez; verileriniz yalnız sizin cihazlarınızda kalır.
        </Text>
      </View>

      <Step n={1} title={paired ? `Pi'ye bağlandı — ${paired.piName || paired.host}` : "Pi'ye bağlan"} state={step1}>
        <Text style={s.p}>
          Pi panelinde Yedekleme → Cihaz Yedekleme → «Telefon ve tablet» bölümünde «Telefon ekle»ye basın ve QR kodu okutun.
          Telefon Pi ile aynı ev Wi-Fi'ında olmalı.
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
            <TextInput style={[s.input, { fontFamily: 'JetBrainsMono_500Medium' }]} placeholder="Kod (ör. ABCD-EFGH)" placeholderTextColor={p.textMuted}
              autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} />
            <Btn kind="on" icon={Check} label="Bağlan" busy={busy} onPress={() => {
              const m = manualPayload(addr, code);
              if (typeof m === 'string') setErr(m); else void go(m);
            }} />
          </View>
        ) : null}
        {err && !paired ? <Text style={s.err}>{err}</Text> : null}
      </Step>

      <Step n={2} title="Fotoğraflara erişim" state={step2}>
        <Text style={s.p}>Yedeklemek için fotoğraf ve videolarınızı okuma izni gerekir. Uygulama hiçbir şeyi silmez ya da değiştirmez.</Text>
        <Btn kind="on" icon={ImageIcon} label="İzin ver" onPress={() => void askMedia()} />
        <Btn kind="neutral" label="Şimdilik geç" onPress={() => { setErr(''); setMediaDone('skipped'); }} />
        {err && paired ? <Text style={s.err}>{err}</Text> : null}
      </Step>

      <Step n={3} title="Hazır" state={step3}>
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

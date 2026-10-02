import { useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { pair } from '../core/client.ts';
import { manualPayload, parsePayload, type PairPayload, type Pairing } from '../core/protocol.ts';
import { http } from '../platform/http.ts';
import { savePairing } from '../platform/store.ts';
import { C, s } from './theme.ts';

// Eşleştirme: Pi panelinde Yedekleme → Cihaz Yedekleme → Telefon ve tablet → «Telefon ekle»nin QR'ı okutulur ya da
// Pi'nin adresi + kod elle yazılır. Kod tek kullanımlık (10 dk).
export function PairScreen({ onPaired }: { onPaired: (p: Pairing) => void }) {
  const [perm, askPerm] = useCameraPermissions();
  const [scan, setScan] = useState(false);
  const [manual, setManual] = useState(false);
  const [addr, setAddr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const handled = useRef(false);

  const go = async (p: PairPayload) => {
    setBusy(true); setErr(''); setScan(false);
    try {
      const name = (Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android')).slice(0, 40);
      const pr = await pair(http, p, name, Platform.OS === 'ios' ? 'ios' : 'android');
      await savePairing(pr);
      onPaired(pr);
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

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>Klyrix Yedek</Text>
      <Text style={s.subtitle}>
        Telefonunuzun fotoğraf ve videoları evinizdeki Klyrix Gate'e (Raspberry Pi) yedeklenir. Telefondan hiçbir şey silinmez;
        dosyalar yalnız sizin cihazınızda kalır.
      </Text>
      <View style={s.card}>
        <Text style={s.h}>Pi'ye bağlan</Text>
        <Text style={s.p}>
          Pi panelinde Yedekleme → Cihaz Yedekleme → «Telefon ve tablet» bölümünde «Telefon ekle»ye basın ve ekrandaki QR kodu
          okutun. Telefon Pi ile aynı ev Wi-Fi'ında olmalı.
        </Text>
        {scan ? (
          <View style={{ height: 300, borderRadius: 12, overflow: 'hidden' }}>
            <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={r => {
                if (handled.current) return;
                handled.current = true;
                const p = parsePayload(r.data);
                if (p) { void go(p); return; }
                // Başka bir kod (barkod, başka QR) yakalandı: söyle, taramayı açık tut — 2 sn sonra yeniden okur
                setErr('Bu QR Klyrix Gate eşleştirme kodu değil — panelde Yedekleme → Cihaz Yedekleme → «Telefon ekle»deki QR\'ı okutun');
                setTimeout(() => { handled.current = false; }, 2000);
              }} />
          </View>
        ) : null}
        <Pressable style={s.btn} disabled={busy} onPress={() => (scan ? setScan(false) : void startScan())}>
          <Text style={s.btnText}>{scan ? 'Taramayı durdur' : 'QR kodu okut'}</Text>
        </Pressable>
        <Pressable style={s.btnOutline} disabled={busy} onPress={() => setManual(m => !m)}>
          <Text style={s.btnOutlineText}>Kodu elle gir</Text>
        </Pressable>
        {manual ? (
          <View style={{ gap: 8 }}>
            <TextInput style={s.input} placeholder="Pi'nin adresi (ör. 192.168.0.153)" placeholderTextColor={C.muted}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" value={addr} onChangeText={setAddr} />
            <TextInput style={s.input} placeholder="Kod (ör. ABCD-EFGH)" placeholderTextColor={C.muted}
              autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} />
            <Pressable style={s.btn} disabled={busy} onPress={() => {
              const m = manualPayload(addr, code);
              if (typeof m === 'string') setErr(m); else void go(m);
            }}>
              <Text style={s.btnText}>Bağlan</Text>
            </Pressable>
          </View>
        ) : null}
        {busy ? <ActivityIndicator color={C.text} /> : null}
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>
    </ScrollView>
  );
}

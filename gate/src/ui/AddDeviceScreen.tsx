// Cihaz ekle: ev ağındaki Klyrix cihazları kendiliğinden bulunur (NSD); QR (panel → Ev VPN'i → Klyrix/Gate uygulaması →
// Telefon ekle) ya da adres de olur. Sahiplik panel kodu ya da panel şifresiyle kanıtlanır. Pi'de Ev VPN'i kapalıysa
// açılması için onay istenir. Telefonun WireGuard gizli anahtarı burada üretilir ve telefondan çıkmaz.
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WG, { type FoundDevice } from '../../modules/klyrix-wg/index.ts';
import { errText, GateError, hello, normCode, pair, parseQr, validHost, type Hello, type QrPayload } from '../core/gate.ts';
import { http } from '../platform/http.ts';
import { saveKey, type SavedDevice } from '../platform/store.ts';
import { Header } from './Header.tsx';
import { Check, Keyboard, KeyRound, QrCode, Radar, Router, ShieldCheck, Square } from './icons.ts';
import { Btn, Card, Segmented, Step } from './kit.tsx';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

interface Candidate { host: string; port: number; hello: Hello }
interface Target extends Candidate { qr?: QrPayload }

export function AddDeviceScreen({ onDone, onBack }: { onDone: (d: SavedDevice) => void; onBack: () => void }) {
  const { s, p } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, askPerm] = useCameraPermissions();
  const [found, setFound] = useState<Candidate[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [mode, setMode] = useState<'code' | 'password'>('code');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [addr, setAddr] = useState('');
  const [scan, setScan] = useState(false);
  const [needTunnel, setNeedTunnel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const handled = useRef(false);
  // Eşleşme denemeleri boyunca aynı anahtar (Ev VPN'i onayından sonra yeniden denemede de)
  const keyRef = useRef<string | null>(null);

  // Keşif: bulunan her aday Pi'nin kimlik yanıtıyla doğrulanır (mDNS duyurusu doğrulanmamıştır)
  useEffect(() => {
    const wg = WG;
    if (!wg) return;
    const seen = new Set<string>();
    const sub = wg.addListener('onDeviceFound', (d: FoundDevice) => {
      if (seen.has(d.host)) return;
      seen.add(d.host);
      void hello(http, d.host, d.port || 80).then(h => {
        setFound(f => (f.some(x => x.host === d.host) ? f : [...f, { host: d.host, port: d.port || 80, hello: h }]));
      }).catch(() => { seen.delete(d.host); });
    });
    wg.startDiscovery();
    return () => { sub.remove(); wg.stopDiscovery(); };
  }, []);

  const choose = (c: Candidate, qr?: QrPayload) => {
    setErr(''); setNeedTunnel(false);
    setTarget({ ...c, qr });
    if (qr) { setMode('code'); setCode(qr.code); }
    else setMode(c.hello.code || !c.hello.password ? 'code' : 'password');
  };

  // QR'daki adreslerden yanıt veren ilki; yanıt QR'daki cihazdan gelmeli (sunucu anahtarı eşleşmede ayrıca denetlenir)
  const fromQr = async (qr: QrPayload) => {
    setBusy(true); setErr(''); setScan(false);
    try {
      for (const h of qr.hosts) {
        const he = await hello(http, h, qr.port).catch(() => null);
        if (he) { choose({ host: h, port: qr.port, hello: he }, qr); return; }
      }
      setErr("QR'daki adreslerde Pi'ye ulaşılamadı — telefon Pi ile aynı ev Wi-Fi'ında mı?");
    } finally {
      setBusy(false);
      handled.current = false;
    }
  };

  const byAddress = async () => {
    const h = addr.trim();
    if (!validHost(h)) { setErr('Geçerli bir adres yazın (ör. 192.168.0.153)'); return; }
    setBusy(true); setErr('');
    try { choose({ host: h, port: 80, hello: await hello(http, h, 80) }); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  const startScan = async () => {
    setErr('');
    if (!perm?.granted && !(await askPerm()).granted) { setErr('Kamera izni verilmedi — kodu elle girebilirsiniz'); return; }
    handled.current = false;
    setScan(true);
  };

  const submit = async (enableTunnel = false) => {
    if (!target || !WG) return;
    if (target.hello.role === 'satellite') { setErr('Bu cihaz uydu — uygulamayı ana cihazla eşleştirin'); return; }
    const c = normCode(code);
    if (mode === 'code' && c.length !== 8) { setErr('Kod 8 karakter (ör. ABCD-EFGH)'); return; }
    if (mode === 'password' && !password) { setErr('Panel şifresini yazın'); return; }
    setBusy(true); setErr('');
    try {
      keyRef.current ??= WG.generatePrivateKey();
      const name = (Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Android')).slice(0, 40);
      const r = await pair(http, target.host, target.port, {
        name, platform: Platform.OS === 'ios' ? 'ios' : 'android', publicKey: WG.publicKey(keyRef.current),
        ...(mode === 'code' ? { code: c } : { password }), ...(enableTunnel ? { enableTunnel: true } : {}),
      });
      if (target.qr && r.tunnel.serverPublicKey !== target.qr.serverKey) {
        throw new Error("Yanıt QR'daki Pi'den gelmedi (anahtar farklı) — eşleşme durduruldu; panelden yeni kod alın");
      }
      const piId = r.pi.id || r.tunnel.serverPublicKey;
      await saveKey(piId, keyRef.current);
      onDone({
        piId, piName: r.pi.name || target.hello.name, deviceId: r.device.id, address: r.tunnel.address,
        serverPublicKey: r.tunnel.serverPublicKey, port: r.tunnel.port, lan: r.tunnel.lan, remote: r.tunnel.remote, addedAt: Date.now(),
      });
    } catch (e) {
      if (e instanceof GateError && e.needTunnel) setNeedTunnel(true);
      else setErr(e instanceof GateError && e.retryAfter ? `${e.message}` : errText(e));
    } finally {
      setBusy(false);
    }
  };

  const proofs = target ? [
    ...(target.hello.code || target.qr ? [{ value: 'code' as const, label: 'Panel kodu', icon: KeyRound }] : []),
    ...(target.hello.password ? [{ value: 'password' as const, label: 'Panel şifresi', icon: ShieldCheck }] : []),
  ] : [];

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <Header title="Cihaz ekle" onBack={onBack} />
      <ScrollView contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Step n={1} title={target ? `Cihaz: ${target.hello.name} (${target.host})` : 'Cihazı seçin'} state={target ? 'done' : 'current'}>
          {!WG ? <Text style={s.err}>Bu telefonda desteklenmiyor (şimdilik yalnız Android).</Text> : null}
          <Card title="Yakındaki cihazlar" icon={<Radar size={18} color={p.textSecondary} />} style={{ padding: 10 }}>
            {found.length ? found.map(c => (
              <View key={c.host} style={s.row}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <Router size={18} color={p.textSecondary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.p, { color: p.text }]} numberOfLines={1}>{c.hello.name}</Text>
                    <Text style={s.small}>{c.host}{c.hello.role === 'satellite' ? ' · uydu' : ''}</Text>
                  </View>
                </View>
                <Btn kind="on" label="Seç" disabled={busy || c.hello.role === 'satellite'} onPress={() => choose(c)} style={{ minHeight: 38 }} />
              </View>
            )) : <Text style={s.small}>Aranıyor… Telefon Pi ile aynı ev Wi-Fi'ında olmalı.</Text>}
          </Card>
          {scan ? (
            <View style={{ height: 300, borderRadius: 8, overflow: 'hidden' }}>
              <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={r => {
                  if (handled.current) return;
                  handled.current = true;
                  const qr = parseQr(r.data);
                  if (qr) { void fromQr(qr); return; }
                  setErr('Bu QR Klyrix/Gate eşleştirme kodu değil — panelde Ev VPN\'i → Klyrix/Gate uygulaması → «Telefon ekle»deki QR\'ı okutun');
                  setTimeout(() => { handled.current = false; }, 2000);
                }} />
            </View>
          ) : null}
          <Btn kind={scan ? 'off' : 'primary'} icon={scan ? Square : QrCode} label={scan ? 'Taramayı durdur' : 'Paneldeki QR kodu okut'} disabled={busy}
            onPress={() => (scan ? setScan(false) : void startScan())} />
          <View style={{ gap: 8 }}>
            <TextInput style={s.input} placeholder="ya da Pi'nin adresi (ör. 192.168.0.153)" placeholderTextColor={p.textMuted}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" value={addr} onChangeText={setAddr} />
            <Btn kind="neutral" icon={Keyboard} label="Adresle bul" busy={busy && !target} disabled={busy || !addr.trim()} onPress={() => void byAddress()} />
          </View>
        </Step>

        <Step n={2} title="Sahipliği kanıtlayın" state={target ? 'current' : 'locked'} lockedHint="Önce cihazı seçin">
          {target ? <>
            {proofs.length > 1 ? <Segmented value={mode} onChange={setMode} options={proofs} /> : null}
            {mode === 'code' ? <>
              <Text style={s.p}>
                Panelde Ev VPN'i → Klyrix/Gate uygulaması → «Telefon ekle» ile açılan kodu yazın{target.qr ? ' (QR\'dan alındı)' : ''}.
              </Text>
              <TextInput style={[s.input, { fontFamily: FONT.mono, letterSpacing: 2 }]} placeholder="ABCD-EFGH" placeholderTextColor={p.textMuted}
                autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} maxLength={9} />
            </> : <>
              <Text style={s.p}>Panelin giriş şifresini yazın (yalnız eşleşmede kullanılır, telefonda saklanmaz).</Text>
              <TextInput style={s.input} placeholder="Panel şifresi" placeholderTextColor={p.textMuted} secureTextEntry
                autoCapitalize="none" autoCorrect={false} value={password} onChangeText={setPassword} />
            </>}
            {needTunnel ? (
              <View style={[s.card, { borderColor: p.warning }]}>
                <Text style={s.p}>
                  Pi'de Ev VPN'i kapalı. Uygulamanın Pi ile şifreli bağlantısı onun kanalını (UDP 51820) kullanır; telefonda VPN
                  açılmaz ve kanaldan yalnız eşli cihazlar bağlanabilir. Ev VPN'i açılsın mı?
                </Text>
                <Btn kind="on" icon={Check} label="Aç ve eşleştir" busy={busy} onPress={() => void submit(true)} />
                <Btn kind="neutral" label="Vazgeç" disabled={busy} onPress={() => setNeedTunnel(false)} />
              </View>
            ) : (
              <Btn kind="on" icon={Check} label="Eşleştir" busy={busy} onPress={() => void submit(false)} />
            )}
            <Btn kind="neutral" label="Başka cihaz seç" disabled={busy} onPress={() => { setTarget(null); setNeedTunnel(false); setErr(''); }} />
          </> : null}
        </Step>
        {err ? <Text style={s.err}>{err}</Text> : null}
      </ScrollView>
    </View>
  );
}

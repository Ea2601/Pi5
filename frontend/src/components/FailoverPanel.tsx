import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { LifeBuoy, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { getApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';

// Yedek hat (failover): ikinci internet bağlantısı — Ethernet kartı / VLAN (ikinci modem, 4G-5G router, ikinci operatör;
// DHCP / sabit / PPPoE), USB 4G modem ya da telefonun USB paylaşımı, telefon hotspot'u. Kurulum hemen sınanır, olmazsa
// geri alınır (ana hat ve ev ağı değişmez). İzleyici ana hat düşünce yedek hatta geçer, ana hat 60 sn sağlam kalınca
// döner. WAN router (internet kartı) ve LAN router (modem arkası, Pi DHCP açık) modlarında. Backend: /api/failover*
// (/api/backup sistem yedeklemesine aittir), net-mode.sh backup.

type Kind = 'eth' | 'usb' | 'wifi';
type BakType = 'dhcp' | 'static' | 'pppoe';
interface Uplink { via: 'primary' | 'backup'; dev: string; ip: string; gateway: string; public: boolean }
interface FailoverState {
  supported: boolean; error?: string; satellite?: boolean; now?: number;
  stage?: string; pi_dhcp?: boolean; iface?: string; wan_stage?: string; wan_port?: string; wan_dev?: string;
  ap_stage?: string; home_stage?: string; ap_iface?: string; home_iface?: string;
  bak_stage?: 'none' | 'on'; bak_kind?: Kind | ''; bak_type?: BakType | ''; bak_port?: string; bak_dev?: string; bak_vlan?: string;
  bak_mtu?: string; bak_user?: string; bak_ssid?: string; bak_ip?: string; bak_gateway?: string;
  bak_up?: boolean; bak_fw?: boolean; bak_watch?: boolean; bak_active?: 'primary' | 'backup'; bak_since?: number; bak_switches?: number;
  bak_reason?: string; bak_primary_ok?: boolean; bak_backup_ok?: boolean; bak_checked?: number; bak_force_until?: number;
  bak_rx?: number; bak_tx?: number; bak_conntrack?: boolean; bak_usb_candidates?: string; uplink?: Uplink | null;
  wifi_roles?: string;
}
export interface FailoverEthPort { name: string; driver: string; bus: 'usb' | 'onboard'; carrier: boolean | null }

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>;
const KIND_TEXT: Record<Kind, string> = { eth: 'Ethernet', usb: 'USB modem / telefon', wifi: "Telefon hotspot'u" };
const TYPE_TEXT: Record<BakType, string> = { dhcp: 'Otomatik adres (DHCP)', static: 'Sabit IP', pppoe: 'PPPoE' };
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// USB modem / telefon paylaşımı sürücüleri (net-mode.sh BAK_USB_DRIVERS): bu kartlar Ethernet türünde listelenmez.
const USB_DRIVERS = ['rndis_host', 'cdc_ether', 'cdc_ncm', 'ipheth'];
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const fmtAgo = (sec: number) => (sec < 90 ? `${sec} sn` : sec < 5400 ? `${Math.round(sec / 60)} dk` : `${Math.round(sec / 3600)} sa`);

function Alert({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'info' ? 'ok' : kind} hw-alert-${kind}`}>
      {kind === 'err' ? <AlertTriangle size={14} /> : kind === 'ok' ? <CheckCircle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

// initialKind / initialPort: tak-çalıştır sihirbazı paneli bu tür ve kart seçili açar (yalnız form ön seçimi).
export function FailoverPanel({ ports, onChange, initialKind = 'eth', initialPort = '' }: { ports: FailoverEthPort[]; onChange?: () => void; initialKind?: Kind; initialPort?: string }) {
  const [st, setSt] = useState<FailoverState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>(initialKind);
  const [port, setPort] = useState(initialPort);
  const [type, setType] = useState<BakType>('dhcp');
  const [vlan, setVlan] = useState('');
  const [mtu, setMtu] = useState('');
  const [addr, setAddr] = useState('');
  const [gw, setGw] = useState('');
  const [dns, setDns] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [ssid, setSsid] = useState('');

  const load = useCallback(async () => {
    try { setSt(await getApi<FailoverState>('/failover')); setLoadErr(null); }
    catch (e) { setLoadErr(errText(e, 'durum okunamadı')); }
  }, []);
  const onBackup = st?.bak_active === 'backup';
  const testing = !!st?.bak_force_until && !!st?.now && st.bak_force_until > st.now;
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, onBackup || testing ? 5000 : 15000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, onBackup, testing]);

  const title = 'Yedek hat';
  const icon = <LifeBuoy size={18} style={{ marginRight: 8 }} />;
  if (!st) return loadErr ? <Panel title={title} icon={icon}><p className="rl-muted">Durum okunamadı: {loadErr}</p></Panel> : null;
  if (!st.supported || st.satellite) return null;

  const isStatic = st.stage === 'static';
  const wanOn = !!st.wan_stage && st.wan_stage !== 'none';
  const lanPort = st.iface || '';
  // Hotspot radyosu: başka işte olmayan ilk Wi-Fi kartı (net-mode.sh wifi_roles "kart=rol"; iki radyoda ev Wi-Fi'ı yayını
  // öbür kartta sürer). Eski durum çıktısında (wifi_roles yok) ilk kart ve yayın aşamaları.
  const wifiRoles = (st.wifi_roles || '').split(',').filter(Boolean).map(x => ({ dev: x.slice(0, x.indexOf('=')), role: x.slice(x.indexOf('=') + 1) }));
  const wifiFree = wifiRoles.find(r => !r.role)?.dev || '';
  // Tak-çalıştır sihirbazının seçtiği yeni Wi-Fi kartı boşsa hotspot onunla kurulur (yoksa eskisi gibi ilk boş kart).
  const wifiPick = initialKind === 'wifi' && initialPort && wifiRoles.some(r => r.dev === initialPort && !r.role) ? initialPort : '';
  const wifiDev = wifiRoles.length ? wifiPick || wifiFree || wifiRoles[0].dev : st.home_iface || st.ap_iface || '';
  const wifiBusy = wifiRoles.length ? !wifiFree : st.ap_stage !== 'none' || st.home_stage !== 'none';
  const wifiBusyRole = wifiRoles.length ? wifiRoles[0].role : "kurulum Wi-Fi'ı ya da ev Wi-Fi'ı yayını";
  // Ethernet kartları: ana hattın kartı ve USB modem / telefon sürücülü arayüzler hariç; ev ağı kartı yalnız VLAN ile (sonda).
  const cands = ports.filter(p => p.name !== lanPort && p.name !== st.wan_port && !USB_DRIVERS.includes(p.driver));
  const lanInfo = lanPort ? ports.find(p => p.name === lanPort) : undefined;
  const options = lanInfo ? [...cands, lanInfo] : cands;
  const chosen = port && options.some(p => p.name === port) ? port : cands.find(p => p.carrier)?.name || cands[0]?.name || lanInfo?.name || '';
  const onLanCard = kind === 'eth' && !!chosen && chosen === lanPort;
  const usbFound = (st.bak_usb_candidates || '').split(',').filter(Boolean);
  const mtuMax = onLanCard ? (type === 'pppoe' ? 1492 : 1500) : type === 'pppoe' ? 1500 : 9000;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy(null);
    await load();
    onChange?.();
  };

  const t = kind === 'eth' ? type : 'dhcp';
  const formErr =
    kind === 'eth' && vlan && !(/^\d{1,4}$/.test(vlan) && Number(vlan) >= 1 && Number(vlan) <= 4094) ? 'VLAN numarası 1-4094'
      : kind === 'eth' && mtu && !(/^\d{3,4}$/.test(mtu) && Number(mtu) >= 576 && Number(mtu) <= mtuMax) ? `MTU 576-${mtuMax}${onLanCard ? ' (ev ağı kartında)' : ''}`
        : t === 'static' && addr && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(addr) ? 'Sabit IP adres/önek biçiminde olmalı (ör. 203.0.113.10/24)'
          : t === 'static' && gw && !IPV4.test(gw) ? 'Ağ geçidi geçersiz'
            : t === 'static' && dns && !dns.split(',').every(d => IPV4.test(d.trim())) ? 'DNS adresleri virgülle ayrılmış IPv4 olmalı'
              : t === 'pppoe' && user && !/^[!-~]{1,64}$/.test(user) ? 'Kullanıcı adında boşluk ve Türkçe harf olmaz'
                : t === 'pppoe' && pw && (/\\/.test(pw) || pw !== pw.trim() || !/^[ -~]+$/.test(pw)) ? 'Şifrede Türkçe harf ve ters bölü (\\) olmaz, başta/sonda boşluk olmaz'
                  : kind === 'wifi' && ssid && new TextEncoder().encode(ssid).length > 32 ? 'Hotspot adı en çok 32 bayt'
                    : kind === 'wifi' && pw && (pw.length < 8 || pw.length > 63 || /\\/.test(pw) || pw !== pw.trim() || !/^[ -~]+$/.test(pw)) ? 'Hotspot parolası 8-63 karakter; Türkçe harf ve ters bölü (\\) olmaz'
                      : '';
  const fieldsOk = kind === 'eth'
    ? !!chosen && (!onLanCard || !!vlan) && (t === 'dhcp' || (t === 'static' ? !!addr && !!gw : !!user && !!pw))
    : kind === 'usb' ? usbFound.length > 0 : !!ssid && !!pw && !!wifiDev && !wifiBusy;
  const blocked = !isStatic ? 'Önce sabit adres' : !st.pi_dhcp ? "Önce Pi DHCP'sini açın"
    : st.home_stage === 'trial' || st.wan_stage === 'trial' ? 'Bir deneme sürüyor'
      : kind === 'usb' && !usbFound.length ? 'USB modem / telefon bulunamadı'
        : kind === 'wifi' && !wifiDev ? 'Wi-Fi kartı yok'
          : kind === 'wifi' && wifiBusy ? 'Wi-Fi kartı yayında'
            : kind === 'eth' && onLanCard && !vlan ? 'Ev ağı kartında VLAN numarası gerekli' : '';
  const canStart = !blocked && !formErr && fieldsOk;

  const start = () => {
    const where = kind === 'eth' ? `${chosen}${vlan ? ` · VLAN ${vlan}` : ''} (${TYPE_TEXT[t]})` : kind === 'usb' ? usbFound.join(', ') : `"${ssid}" hotspot'u (${wifiDev})`;
    if (!window.confirm(
      `Yedek hat kurulacak: ${KIND_TEXT[kind]} — ${where}.\n\n` +
      '• Ana hat ve ev ağı değişmez; yedek hat hemen sınanır, internet gelmezse kurulum geri alınır\n' +
      '• Ana hat çalışmazsa Pi 15-30 sn içinde yedek hatta geçer, ana hat 60 sn sağlam kalınca geri döner\n' +
      '• Yedek hattan gelen bağlantılar engellenir\n\nDevam edilsin mi?',
    )) return;
    void act('on', async () => {
      toast.info('Yedek hat kuruluyor ve sınanıyor — PPPoE / hotspot bir dakikaya kadar sürebilir');
      const r = await postApi('/failover', {
        kind, type: t,
        ...(kind === 'eth' ? { port: chosen, ...(vlan ? { vlan } : {}), ...(mtu ? { mtu } : {}) } : {}),
        ...(kind === 'wifi' ? { port: wifiDev, ssid, password: pw } : {}),
        ...(t === 'static' ? { addr, gw, dns } : {}),
        ...(t === 'pppoe' ? { user, password: pw } : {}),
      });
      setPw('');
      toast.success(`Yedek hat hazır: ${r?.bak_dev || ''} ${r?.bak_ip || ''}`.trim());
      if (r?.warning) toast.info(r.warning);
    });
  };
  const test = (s: number) => act('test', async () => {
    await postApi('/failover/test', { seconds: s });
    toast.info(s ? `Geçiş denemesi: ${s} sn yedek hattan — ev ağındaki bir cihazda bir site açın` : 'Geçiş denemesi bitirildi');
  });
  const off = () => {
    if (!window.confirm(onBackup
      ? 'Şu an yedek hattan çıkılıyor (ana hat çalışmıyor). Yedek hat kapatılırsa ana hat dönene kadar internet olmaz. Devam edilsin mi?'
      : 'Yedek hat kapatılacak: profil, güvenlik duvarı ve izleyici kaldırılır; ana hat düşerse yedeğe geçilmez. Devam edilsin mi?')) return;
    void act('off', async () => { await postApi('/failover/off', {}); toast.info('Yedek hat kapatıldı'); });
  };

  const on = st.bak_stage === 'on';
  const healthy = !!st.bak_up && !!st.bak_fw && !!st.bak_watch;
  const state = !on ? <Badge variant="neutral">Kapalı</Badge>
    : !healthy ? <Badge variant="warning">Sorun var</Badge>
      : onBackup ? <Badge variant="warning">{testing ? 'Deneme · yedek hatta' : 'Yedek hatta'}</Badge> : <Badge variant="success">Hazır bekliyor</Badge>;
  const bakKind = (st.bak_kind || 'eth') as Kind;
  const bakWhere = `${KIND_TEXT[bakKind]}${bakKind === 'wifi' && st.bak_ssid ? ` · ${st.bak_ssid}` : ''}${st.bak_vlan ? ` · VLAN ${st.bak_vlan}` : ''}${st.bak_type && st.bak_type !== 'dhcp' ? ` · ${TYPE_TEXT[st.bak_type as BakType]}` : ''}`;
  const since = st.bak_since && st.now ? fmtAgo(Math.max(0, st.now - st.bak_since)) : '';
  const okText = (v?: boolean) => (v === undefined ? '—' : v ? 'yanıt veriyor' : 'yanıt yok');

  return (
    <Panel title={title} icon={icon} actions={state} className="wn-panel bk-panel"
      subtitle="İkinci internet bağlantısı: ana hat düşünce Pi kendiliğinden yedek hatta geçer, ana hat dönünce geri alır.">
      <div className="hw-body">
        {!on && (
          <>
            {!isStatic && <Alert kind="info">Önce menü → DHCP Ayarları sihirbazında Pi'ye sabit adres verip kalıcı yapın.</Alert>}
            {isStatic && !st.pi_dhcp && <Alert kind="info">Önce DHCP Ayarları'ndan Pi DHCP sunucusunu açın: yedek hat, ev ağındaki cihazlar Pi'yi ağ geçidi kullanırken çalışır.</Alert>}
            <dl className="hw-facts">
              <div><dt>Ne olur</dt><dd>Ana hat {wanOn ? `(internet kartı ${st.wan_dev || st.wan_port})` : '(modem)'} yanıt vermezse Pi 15-30 sn içinde yedek hatta geçer; açık bağlantılar yeni hatta yeniden kurulur. Ana hat 60 sn sağlam kalınca dönülür.</dd></div>
              <div><dt>Güvenlik</dt><dd>Yedek hattan gelen bağlantılar engellenir; ev ağı ve panel değişmez. <EN>IPv6</EN> kapalı.</dd></div>
              <div><dt>Kota</dt><dd>4G / telefon hattı kotalıysa yedek hattayken büyük indirmelerden kaçının; panel geçişi zile yazar.</dd></div>
            </dl>
            <div className="hw-form">
              <label className="hw-field">
                <span>Yedek hat türü</span>
                <select value={kind} onChange={e => setKind(e.target.value as Kind)}>
                  <option value="eth">Ethernet — ikinci modem / 4G router / ikinci operatör</option>
                  <option value="usb">USB 4G modem ya da telefonun USB paylaşımı</option>
                  <option value="wifi">Telefon hotspot'u (Wi-Fi)</option>
                </select>
              </label>
              {kind === 'eth' && (
                <>
                  <label className="hw-field">
                    <span>Kart</span>
                    <select value={chosen} onChange={e => setPort(e.target.value)} disabled={!options.length}>
                      {cands.map(p => <option key={p.name} value={p.name}>{p.name} · {p.bus === 'usb' ? 'USB' : 'dahili'} · {p.carrier ? 'kablo takılı' : p.carrier === false ? 'kablo yok' : '—'}</option>)}
                      {lanInfo && <option value={lanInfo.name}>{lanInfo.name} · ev ağı kartı (VLAN anahtarı)</option>}
                    </select>
                  </label>
                  <label className="hw-field">
                    <span>Bağlantı türü</span>
                    <select value={type} onChange={e => setType(e.target.value as BakType)}>
                      <option value="dhcp">Otomatik adres (DHCP)</option>
                      <option value="pppoe">PPPoE — kullanıcı adı + şifre</option>
                      <option value="static">Sabit IP</option>
                    </select>
                  </label>
                  {onLanCard && (
                    <label className="hw-field hw-field-sm"><span>Yedek hat VLAN'ı</span>
                      <input className="config-input" inputMode="numeric" value={vlan} onChange={e => setVlan(e.target.value.trim())} placeholder="ör. 40" required aria-required="true" /></label>
                  )}
                </>
              )}
              {kind === 'wifi' && (
                <>
                  <label className="hw-field"><span>Hotspot adı</span>
                    <input className="config-input" value={ssid} maxLength={32} onChange={e => setSsid(e.target.value)} placeholder="telefondaki hotspot adı" spellCheck={false} /></label>
                  <label className="hw-field"><span>Hotspot parolası</span>
                    <input className="config-input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" /></label>
                </>
              )}
              {kind === 'eth' && t === 'pppoe' && (
                <>
                  <label className="hw-field"><span>Kullanıcı adı</span>
                    <input className="config-input" value={user} onChange={e => setUser(e.target.value)} autoComplete="off" spellCheck={false} /></label>
                  <label className="hw-field"><span>Şifre</span>
                    <input className="config-input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" /></label>
                </>
              )}
              {kind === 'eth' && t === 'static' && (
                <>
                  <label className="hw-field"><span>IP adresi / önek</span>
                    <input className="config-input" value={addr} onChange={e => setAddr(e.target.value)} placeholder="203.0.113.10/24" spellCheck={false} /></label>
                  <label className="hw-field"><span>Ağ geçidi</span>
                    <input className="config-input" value={gw} onChange={e => setGw(e.target.value)} placeholder="203.0.113.1" spellCheck={false} /></label>
                  <label className="hw-field"><span>DNS (isteğe bağlı)</span>
                    <input className="config-input" value={dns} onChange={e => setDns(e.target.value)} placeholder="1.1.1.1,9.9.9.9" spellCheck={false} /></label>
                </>
              )}
            </div>
            {kind === 'eth' && (
              <details className="wn-adv">
                <summary>Gelişmiş: VLAN, <EN>MTU</EN> (operatör isterse)</summary>
                <div className="hw-form">
                  {!onLanCard && (
                    <label className="hw-field hw-field-sm"><span>VLAN numarası</span>
                      <input className="config-input" inputMode="numeric" value={vlan} onChange={e => setVlan(e.target.value.trim())} placeholder="ör. 35" /></label>
                  )}
                  <label className="hw-field hw-field-sm"><span><EN>MTU</EN></span>
                    <input className="config-input" inputMode="numeric" value={mtu} onChange={e => setMtu(e.target.value.trim())} placeholder={t === 'pppoe' ? '1492' : '1500'} /></label>
                </div>
              </details>
            )}
            {kind === 'usb' && (usbFound.length
              ? <Alert kind="ok">Bulunan: <strong className="rl-mono">{usbFound.join(', ')}</strong> — yedek hat bu aygıttan kurulur; aygıt çıkarılıp takılsa (adı değişse) de tanınır.</Alert>
              : <Alert kind="info">USB modem ya da telefon bulunamadı. Modemi takın (web arayüzlü "HiLink" modemler, ör. Huawei E3372h) ya da telefonu USB ile bağlayıp "USB ile internet paylaşımı"nı açın; birkaç saniye sonra bu bölüm yenilenir. SIM'li, arayüzsüz modemler (APN / PIN isteyen) şimdilik desteklenmez.</Alert>)}
            {kind === 'wifi' && (!wifiDev
              ? <Alert kind="err">Pi'de Wi-Fi kartı bulunamadı.</Alert>
              : wifiBusy ? <Alert kind="err">Wi-Fi kartı ({wifiDev}) şu an {wifiBusyRole} için kullanılıyor — hotspot yedek hattı için boş bir Wi-Fi kartı gerekir (ör. ikinci bir USB Wi-Fi).</Alert>
                : <Alert kind="info">Telefonun hotspot'u açıkken kurun (hemen sınanır). Sonra hotspot kapalı kalabilir: ana hat düşünce hotspot'u açın, Pi birkaç saniyede bağlanır ve geçer.</Alert>)}
            {onLanCard && <Alert kind="info">Ev ağı kartı: yedek hat (ör. 4G router) VLAN destekli yönetilebilir anahtara takılır; anahtar yedek hattı Pi'nin portuna bu VLAN'da etiketli verir, ev ağı etiketsiz kalır.</Alert>}
            {formErr && <span className="hw-form-err" role="alert">{formErr}</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={start} disabled={!!busy || !canStart} title={blocked || undefined}>
                {busy === 'on' ? 'Kuruluyor…' : 'Yedek hattı kur (hemen sınanır)'}
              </button>
            </div>
          </>
        )}
        {on && (
          <>
            {onBackup && (
              <Alert kind="err">
                {testing
                  ? <>Geçiş denemesi: <strong>{since}</strong>'dir yedek hattan çıkılıyor — ev ağındaki bir cihazda bir site açın.</>
                  : <><strong>Ana hat çalışmıyor</strong> — {since}'dir yedek hattan çıkılıyor ({st.bak_reason}). Ana hat 60 sn sağlam kalınca dönülür.</>}
              </Alert>
            )}
            {!healthy && (
              <Alert kind="err">
                {!st.bak_fw ? 'Yedek hat güvenlik duvarı yüklü değil' : !st.bak_watch ? 'Yedek hat izleyicisi çalışmıyor — ana hat düşerse geçiş yapılamaz' : `Yedek hat bağlı değil (${st.bak_dev || 'arayüz yok'})`}
                {bakKind === 'wifi' && !st.bak_up ? " — telefonun hotspot'u kapalıysa bu beklenen durum; ana hat düşünce hotspot'u açın." : '.'}
              </Alert>
            )}
            {onBackup && st.uplink && !st.uplink.public && (
              <Alert kind="info">Yedek hat bir modemin / operatörün paylaşımlı adresinin arkasında ({st.uplink.ip}): yedek hattayken Ev VPN'ine ve port yönlendirmelerine dışarıdan erişilemez.</Alert>
            )}
            {!st.bak_conntrack && <Alert kind="info">conntrack aracı kurulu değil: geçişte açık bağlantılar hemen taşınamaz (panel güncellemesi kurar — Ayarlar → Güncelle).</Alert>}
            <dl className="hw-facts">
              <div><dt>Yedek hat</dt><dd className="rl-mono">{bakWhere} · {st.bak_dev || '—'}</dd></div>
              <div><dt>Adres / ağ geçidi</dt><dd className="rl-mono">{st.bak_ip || '—'} · {st.bak_gateway || '—'}</dd></div>
              <div><dt>Hatlar</dt><dd>Ana hat {okText(st.bak_primary_ok)} · yedek hat {okText(st.bak_backup_ok)}</dd></div>
              <div><dt>Geçiş</dt><dd>{st.bak_switches ? `${st.bak_switches} kez (açılıştan beri) · son: ${st.bak_reason || '—'}` : 'açılıştan beri geçiş yok'}</dd></div>
              <div><dt>Yedek hatta veri</dt><dd className="rl-mono">{fmtBytes((st.bak_rx || 0) + (st.bak_tx || 0))} (bağlandığından beri)</dd></div>
            </dl>
            <div className="panel-auth-actions">
              {testing
                ? <button className="btn-outline btn-sm" onClick={() => test(0)} disabled={!!busy}>{busy === 'test' ? 'Bitiriliyor…' : 'Denemeyi bitir'}</button>
                : <button className="btn-outline btn-sm" onClick={() => test(60)} disabled={!!busy || onBackup || !st.bak_backup_ok}
                    title={onBackup ? 'Zaten yedek hattan çıkılıyor' : !st.bak_backup_ok ? 'Yedek hat yanıt vermiyor' : undefined}>
                    {busy === 'test' ? 'Başlatılıyor…' : 'Geçişi dene (60 sn)'}
                  </button>}
              <button className="btn-outline btn-sm" onClick={off} disabled={!!busy}>{busy === 'off' ? 'Kapatılıyor…' : 'Yedek hattı kapat'}</button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

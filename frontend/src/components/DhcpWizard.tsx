import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle } from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Badge } from './ui';

// Faz 2 sihirbazı: Pi'ye sabit adres → istemci testi → Pi'nin Wi-Fi'si (kurulum Wi-Fi'ına çevir ya da yalnız ayır) →
// modemin DHCP'sini kapat → Pi DHCP'sini aç. Riskli adımlar (1, 3'teki kurulum Wi-Fi'ı ve 5) denemedir: "Kalıcı yap"a
// basılmazsa Pi kendi zamanlayıcısıyla geri döner (panel kapalı olsa da).
export interface LanInfo {
  iface: string; ip: string; prefix: number; gateway: string; network: string;
  secondary: { iface: string; ip: string; net?: 'transit' | 'client' }[];
  transit?: { ip: string; prefix: number; network: string };
  client?: { ip: string; prefix: number; network: string; source: 'config' | 'transit' };
  dualSubnet?: boolean;
}
export interface PiDhcpStatus {
  error?: string; stage?: 'off' | 'trial' | 'on'; trial_ends?: number; now?: number; active?: boolean;
  start?: string; end?: string; router?: string; netmask?: string; lease_time?: string; leases?: number;
  port67?: boolean; input_ok?: boolean; listening_mode?: string; ftl?: string;
  modem_warn?: number; // Pi DHCP'si modemin DHCP'si kapalıyken kapandı/açılamadı (epoch; 0 = yok) — Pi'de kalıcı
}
export interface DhcpStatus {
  supported: boolean; error?: string; pi_dhcp_active?: boolean; start?: string; end?: string; router?: string;
  lease_time?: string; leases?: number; lan?: LanInfo | null; pi?: PiDhcpStatus | null;
  netmode_stage?: 'none' | 'trial' | 'static';
}
export interface NetModeStatus {
  supported: boolean; error?: string; stage?: 'none' | 'trial' | 'static'; trial_ends?: number; now?: number;
  iface?: string; transit?: string; client?: string; gw?: string; dns?: string; wifi_off?: boolean; nm?: boolean;
  active_conn?: string; method?: string; addrs?: string; carrier?: boolean; profile_ok?: boolean;
  planned_iface?: string; planned_transit?: string; planned_gw?: string; planned_client?: string;
  planned_type?: string; planned_mac?: string; mac?: string; lease_until?: number;
  wifi?: string; wlan_addrs?: string; guard_result?: string; guard_at?: number; guard_detail?: string; pi_dhcp?: boolean;
  // Kurulum Wi-Fi'ı: Pi'nin kendi Wi-Fi kartından yayınladığı yönetim ağı (Pi 192.168.50.1, internet yok).
  ap_stage?: 'none' | 'trial' | 'on'; ap_trial_ends?: number; ap_ssid?: string; ap_iface?: string; ap_capable?: boolean;
  ap_active?: boolean; ap_addr?: string; ap_guard_result?: string; ap_guard_detail?: string;
  // Ev Wi-Fi'ı (Cihaz Rolleri → erişim noktası): eth0 + Wi-Fi kartı tek köprüde (lan_if = br0), adresler köprüde.
  lan_if?: string; home_stage?: 'none' | 'trial' | 'on'; home_trial_ends?: number; home_ssid?: string; home_iface?: string;
  home_band?: 'bg' | 'a'; home_channel?: number; home_capable?: boolean; home_active?: boolean; br_active?: boolean;
  // İnternet kartı (Cihaz Rolleri → WAN router): açıkken sabit adres ve Pi DHCP'si bu sihirbazdan değiştirilemez.
  wan_stage?: 'none' | 'trial' | 'on'; wan_port?: string;
  // Wi-Fi kartları ve rolleri ("kart=rol,…", NetworkManager'dan); wifi_cards: çekirdeğin gördüğü Wi-Fi kartları ("kart,…";
  // boş = bu cihazda Wi-Fi kartı yok). nm_unmanaged: varsayılan rotanın kartı NetworkManager'ın yönetiminde değil
  // (ifupdown / netplan); nm_external: NetworkManager dışında yapılandırılmış (systemd-networkd / dhcpcd / elle).
  // ifaces_missing / missing_hint: kayıtlı kart bulunamadı ("rol:ad,…" / "rol:eski->yeni").
  wifi_roles?: string; wifi_cards?: string; nm_unmanaged?: string; nm_external?: string; ifaces_missing?: string;
  missing_hint?: string;
}
interface ProbeResult { servers: string[]; own: string[] }

export const AP_DEFAULT_SSID = 'Klyrix-Kurulum';
export const AP_DEFAULT_IP = '192.168.50.1';
// Betik ve backend ile aynı kurallar: ağ adı harf/rakam/boşluk/_.- (1–32); WPA2 şifresi 8–63 yazdırılabilir ASCII, ters
// bölü yok; ikisinde de başta/sonda boşluk yok.
const validApSsid = (s: string) => /^[A-Za-z0-9 _.-]{1,32}$/.test(s) && !/^ | $/.test(s);
const validApPassword = (s: string) => /^[\x20-\x5b\x5d-\x7e]{8,63}$/.test(s) && !/^ | $/.test(s);

// ip/önek → ağ adresi + n (ör. 192.168.0.1/24, 50 → 192.168.0.50). Biçim dışıysa boş.
function hostOf(cidr: string | undefined, n: number): string {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr || '');
  if (!m) return '';
  const size = 2 ** (32 - Number(m[2]));
  const v = Math.floor(m[1].split('.').reduce((a, o) => a * 256 + Number(o), 0) / size) * size + n;
  return [24, 16, 8, 0].map(s => Math.floor(v / 2 ** s) % 256).join('.');
}
const ipOf = (cidr?: string) => (cidr || '').split('/')[0];
const maskOf = (cidr?: string) => {
  const p = Number((cidr || '').split('/')[1]);
  if (!(p >= 0 && p <= 32)) return '';
  const v = 2 ** 32 - 2 ** (32 - p);
  return [24, 16, 8, 0].map(s => Math.floor(v / 2 ** s) % 256).join('.');
};
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
// postApi gibi; hata yanıtındaki warning alanını da taşır (Pi DHCP denemesi düştüyse "modemin DHCP'sini açın" uyarısı).
type WarnError = Error & { warning?: string };
async function postWithWarning(endpoint: string): Promise<{ warning?: string }> {
  const res = await fetch(`/api${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const json: { error?: string; warning?: string } = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: WarnError = new Error(json.error || `HTTP ${res.status}`);
    e.warning = json.warning;
    throw e;
  }
  return json;
}
const fmtLeft = (left: number | null) => (left === null ? '…' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);

// Deneme geri sayımı (sunucu saatine göre kalan saniye; tarayıcı saati kaymış olabilir).
function useCountdown(ends: number, now: number): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!ends) return;
    const startedAt = performance.now();
    const base = now ? now * 1000 : Date.now();
    const update = () => setLeft(Math.max(0, Math.round(ends - (base + performance.now() - startedAt) / 1000)));
    const first = setTimeout(update, 0);
    const tick = setInterval(update, 1000);
    return () => { clearTimeout(first); clearInterval(tick); };
  }, [ends, now]);
  return ends ? left : null;
}

type StepState = 'done' | 'active' | 'todo';
function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  return (
    <div className={`dhcp-step dhcp-step-${state}`}>
      <div className="dhcp-step-head">
        <span className="dhcp-step-num">{state === 'done' ? <Check size={12} /> : n}</span>
        <strong>{title}</strong>
      </div>
      {children && <div className="dhcp-step-body">{children}</div>}
    </div>
  );
}

function Alert({ kind, children }: { kind: 'ok' | 'err'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind}`}>
      {kind === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
      <span>{children}</span>
    </div>
  );
}

interface Props {
  dhcp: DhcpStatus;
  net: NetModeStatus | null;
  netErr: string | null;
  reload: () => Promise<void>;
}

export function DhcpWizard({ dhcp, net, netErr, reload }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const netLeft = useCountdown(net?.stage === 'trial' ? net.trial_ends || 0 : 0, net?.now || 0);
  const pi = dhcp.pi && !dhcp.pi.error ? dhcp.pi : null;
  const piLeft = useCountdown(pi?.stage === 'trial' ? pi.trial_ends || 0 : 0, pi?.now || 0);
  const apLeft = useCountdown(net?.ap_stage === 'trial' ? net.ap_trial_ends || 0 : 0, net?.now || 0);
  // Kurulum Wi-Fi'ı formu (şifre yalnız bu bileşende tutulur; başarılı açılıştan sonra silinir).
  const [apSsid, setApSsid] = useState(AP_DEFAULT_SSID);
  const [apPw, setApPw] = useState('');
  const [apPw2, setApPw2] = useState('');

  if (!net) {
    return <p className="subtitle dhcp-note">{netErr ? `Sabit adres durumu okunamadı: ${netErr}` : 'Sihirbaz yükleniyor…'}</p>;
  }
  if (!net.supported) {
    return <p className="subtitle dhcp-note">DHCP sihirbazı bu kurulumda yok (net-mode.sh bulunamadı) — paneli güncelleyin.</p>;
  }

  const stage = net.stage || 'none';
  const isStatic = stage === 'static';
  const clientCidr = (stage !== 'none' && net.client) || net.planned_client || '192.168.0.1/24';
  const clientIp = ipOf(clientCidr);
  const transitIp = ipOf(stage !== 'none' ? net.transit : net.planned_transit);
  const gw = (stage !== 'none' ? net.gw : net.planned_gw) || dhcp.lan?.gateway || '';
  // Kurulum Wi-Fi'ı (deneme ya da kalıcı): yayın açıkken wlan0'daki yayın adresi (192.168.50.1) ev ağı adresi sayılmaz.
  const apStage = net.ap_stage || 'none';
  const apOn = apStage === 'on';
  const apTrial = apStage === 'trial';
  const apIp = ipOf(net.ap_addr) || AP_DEFAULT_IP;
  const apSsidLive = net.ap_ssid || AP_DEFAULT_SSID;
  const wlanAddrs = (net.wlan_addrs || '').split(',').map(s => s.trim()).filter(Boolean)
    .filter(a => apStage === 'none' || ipOf(a) !== apIp);
  // Pi DHCP yalnız Pi'nin Wi-Fi'si ev ağından ayrılmışken açılır: Wi-Fi kapalı (nmcli radio wifi off) ya da kurulum
  // Wi-Fi'ı kalıcı. Adresi olmayan ama açık Wi-Fi'yi NetworkManager modeme kendiliğinden yeniden bağlayabilir (Pi aynı ağa
  // iki yoldan bağlanır); kurulum Wi-Fi'ının profili ev ağı bağlantısından önceliklidir.
  const wifiOff = net.wifi === 'disabled';
  // Ev Wi-Fi'ı açıkken kart yayındadır (köprünün portu, modem ağına istemci olarak bağlanmaz).
  const homeStage = net.home_stage || 'none';
  // Wi-Fi kartı olmayan cihaz (ör. Wi-Fi'sız x86 / Pi'de kart yok): ayrılacak bağlantı yok — 3. adım tamam sayılır. Çekirdeğin
  // kart listesine bakılır (wifi_cards); NetworkManager listesi bir yoklamada boş gelse de Wi-Fi'lı cihaz Wi-Fi'sız sayılmaz.
  // Eski betik (wifi_cards yok): eski davranış.
  const noWifi = !!net.nm && net.wifi_cards !== undefined && !net.wifi_cards && !net.wifi_roles;
  const wifiReady = noWifi || wifiOff || apOn || homeStage === 'on';
  const viaWifi = wlanAddrs.some(a => ipOf(a) === window.location.hostname);
  // Panel şu an kurulum Wi-Fi'ından açılmış (yayın kapanınca bu tarayıcının bağlantısı kopar).
  const viaAp = apStage !== 'none' && window.location.hostname === apIp;
  const piStage = pi?.stage || 'off';
  const piOn = piStage === 'on' || !!dhcp.pi_dhcp_active;
  // Durum kaydı kapalı ama Pi-hole DHCP'si açık (kayıt kaybı / geri alma dhcp.active'i kapatamadı / Pi-hole arayüzünden
  // açılmış): açma düğmesi her zaman reddedilir → "Modeme geri dön" gösterilir (betik bu durumda yalnız DHCP'yi kapatır).
  const piMismatch = piStage === 'off' && (!!pi?.active || !!dhcp.pi_dhcp_active);
  const modemWarn = !!pi?.modem_warn;
  const poolStart = hostOf(clientCidr, 20);
  const poolEnd = hostOf(clientCidr, 139);
  // Kart kablolu mu (eski betik planned_type vermezse modem tarafı adresinin varlığına bakılır).
  const wired = net.planned_type ? net.planned_type === 'ethernet' : !!net.planned_transit;
  const piMac = (stage !== 'none' ? net.mac : net.planned_mac) || '';
  const reserveHint = transitIp
    ? `Modemde bu Pi'nin kablolu MAC adresine${piMac ? ` (${piMac.toUpperCase()})` : ''} ${transitIp} için DHCP rezervasyonu yapın — modemin DHCP'si açık kaldıkça (4. adıma kadar ve modeme geri dönüldüğünde) bu adres başka bir cihaza verilmesin.`
    : '';
  // Pi'nin dağıttığı kiralar sürüyorsa cihaz tarafı adresi kaldırılamaz (cihazlar onu ağ geçidi/DNS bilir).
  const leaseUntil = net.lease_until && net.lease_until > (net.now || 0) ? net.lease_until : 0;
  const leaseUntilText = leaseUntil ? new Date(leaseUntil * 1000).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const settingsPath = 'menü → DHCP Ayarları';

  // Ortak eylem sarmalayıcısı: meşgul durumu, hata tostu, sonunda durumu yenile.
  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy(null);
    await reload();
  };
  const runProbe = async (): Promise<ProbeResult | null> => {
    setProbeErr(null);
    try {
      const r: ProbeResult = await postApi('/dhcp/pi/probe', {});
      setProbe(r);
      return r;
    } catch (e) {
      setProbe(null);
      setProbeErr(errText(e, 'Tarama yapılamadı'));
      return null;
    }
  };

  const giveStatic = () => {
    if (!window.confirm(
      'Pi\'ye sabit adres verilecek (3 dakikalık deneme):\n\n' +
      `• Kart: ${net.planned_iface || '?'}\n` +
      `• Modem tarafı: ${net.planned_transit || '?'} (modem ${net.planned_gw || '?'}) — panel bu adreste kalır\n` +
      `• Cihazlar için: ${net.planned_client || clientCidr}\n` +
      `• Pi'nin DNS'i: 127.0.0.1, ${net.planned_gw || '?'}\n\n` +
      (reserveHint ? `${reserveHint}\n\n` : '') +
      'Bağlantı birkaç saniye kopabilir. 3 dakika içinde "Çalışıyor, kalıcı yap"a basılmazsa Pi eski ayarına kendiliğinden döner.\n\n' +
      'Devam edilsin mi?',
    )) return;
    void act('static', async () => {
      toast.info('Sabit adres deneniyor — bir dakikaya kadar sürebilir');
      await postApi('/netmode/static', {});
      toast.success('Sabit adres deneme olarak açık — panel ve internet çalışıyorsa kalıcı yapın');
    });
  };
  const confirmStatic = () => act('static-confirm', async () => {
    await postApi('/netmode/confirm', {});
    toast.success('Sabit adres kalıcı');
  });
  const rollbackStatic = () => act('static-rollback', async () => {
    await postApi('/netmode/rollback', {});
    toast.info('Sabit adres geri alındı — Pi yeniden otomatik adres alıyor');
  });
  const backToAuto = () => {
    if (!window.confirm(
      `Pi yeniden adresini modemden otomatik alacak; cihaz tarafı adresi (${clientCidr}) kalkar.\n\n` +
      'Modemin DHCP\'si açık olmalı. Pi\'den adres almış cihaz kalmadığından emin olun (Pi, dağıttığı kiralar bitene kadar reddeder).\n\n' +
      'Devam edilsin mi?',
    )) return;
    void act('static-dhcp', async () => {
      await postApi('/netmode/dhcp', {});
      toast.info('Pi otomatik adrese döndü');
    });
  };
  const setWifi = (enabled: boolean) => {
    if (!enabled && !window.confirm(
      'Pi\'nin Wi-Fi\'si modem ağından ayrılacak (Wi-Fi kapatılır). Pi yalnız kabloyla bağlı kalır.\n\n' +
      (transitIp ? `Paneli bundan sonra kablolu adresten açın: http://${transitIp}\n\n` : '') +
      'Devam edilsin mi?',
    )) return;
    void act('wifi', async () => {
      await postApi('/netmode/wifi', { enabled });
      toast.success(enabled ? 'Pi\'nin Wi-Fi\'si yeniden açıldı' : 'Pi\'nin Wi-Fi bağlantısı ayrıldı');
    });
  };
  const startAp = () => {
    const ssid = apSsid.trim() || AP_DEFAULT_SSID;
    if (!validApSsid(ssid)) {
      toast.error('Ağ adı 1-32 karakter olmalı: harf (Türkçe harf olmadan), rakam, boşluk, _ . -');
      return;
    }
    if (!validApPassword(apPw)) {
      toast.error('Wi-Fi şifresi 8-63 karakter olmalı: Türkçe harf (ç ğ ı ö ş ü) ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan');
      return;
    }
    if (apPw !== apPw2) { toast.error('Şifreler eşleşmiyor'); return; }
    if (!window.confirm(
      'Pi\'nin Wi-Fi\'si kurulum Wi-Fi\'ına çevrilecek (5 dakikalık deneme):\n\n' +
      `• Pi'nin Wi-Fi'si ev ağından ayrılır ve "${ssid}" adlı ayrı bir ağ yayınlar (2,4 GHz, Pi ${apIp}). Bu ağda internet yok — yalnız panele erişim içindir; Pi'nin interneti kablodan gelmeye devam eder.\n` +
      `• Telefonun Wi-Fi ayarlarından "${ssid}" ağına bu şifreyle bağlanın. "Ağa giriş yap" sayfası kendiliğinden açılır → "Paneli aç" (panel şifresi sorulur, kullanıcı admin). Açılmazsa telefonun tarayıcısında http://${apIp} adresini açın.\n` +
      `• 5 dakika içinde TELEFONDAN, bu ağa bağlıyken ${settingsPath} → 3. adım → "Kalıcı yap"a basın. Onay yalnız bu ağa bağlı telefondan kabul edilir.\n\n` +
      '5 dakika içinde onaylanmazsa Pi kurulum Wi-Fi\'ını kapatır ve Wi-Fi\'si eski ayarına kendiliğinden döner.\n\n' +
      'Devam edilsin mi?',
    )) return;
    void act('ap', async () => {
      toast.info('Kurulum Wi-Fi\'ı açılıyor — bir dakikaya kadar sürebilir');
      await postApi('/netmode/ap', { ssid, password: apPw });
      setApPw(''); setApPw2('');
      toast.success(`Kurulum Wi-Fi'ı deneme olarak açık — telefonu "${ssid}" ağına bağlayıp oradan kalıcı yapın`);
    });
  };
  const confirmAp = () => act('ap-confirm', async () => {
    await postApi('/netmode/ap/confirm', {});
    toast.success('Kurulum Wi-Fi\'ı kalıcı — Pi yeniden başlasa da yayınlar');
  });
  const rollbackAp = () => act('ap-rollback', async () => {
    if (viaAp) toast.info('Kurulum Wi-Fi\'ı kapanıyor — bu cihazın bağlantısı kopacak');
    await postApi('/netmode/ap/rollback', {});
    toast.info('Kurulum Wi-Fi\'ı kapatıldı — Pi\'nin Wi-Fi\'si eski ayarına döndü');
  });
  const turnOffAp = () => {
    if (!window.confirm(
      'Kurulum Wi-Fi\'ı kapatılacak.\n\n' +
      `• Modemin DHCP'si kapalıyken ya da bir sorun çıktığında panele "${apSsidLive}" ağından ulaşma yolu kalmaz — o zaman panele yalnız kablolu ya da elle IP verilmiş bir cihazdan ulaşılır.\n` +
      '• Pi\'nin Wi-Fi\'si kapalı kalır (ev ağına kendiliğinden yeniden bağlanmaz).\n' +
      (viaAp ? '• Paneli şu an bu ağdan açtınız — bağlantı kopacak.\n' : '') +
      '\nDevam edilsin mi?',
    )) return;
    void act('ap-off', async () => {
      if (viaAp) toast.info('Kurulum Wi-Fi\'ı kapanıyor — bu cihazın bağlantısı kopacak');
      const r: { warning?: string } = await postApi('/netmode/ap/off', {});
      // Yayın kalktı ama Wi-Fi kapatılamadıysa betiğin uyarısı gösterilir (Pi'nin Wi-Fi'si ev ağına dönebilir).
      if (r.warning) toast.error(`Kurulum Wi-Fi'ı kapatıldı, ancak: ${r.warning}`);
      else toast.info('Kurulum Wi-Fi\'ı kapatıldı — Pi\'nin Wi-Fi\'si kapalı');
    });
  };
  const check = () => act('probe', async () => {
    const r = await runProbe();
    if (r) toast.info(r.servers.length ? 'Başka bir DHCP sunucusu yanıt veriyor' : 'Başka DHCP sunucusu yok');
  });
  const enablePi = () => {
    if (!window.confirm(
      'Pi DHCP sunucusu 5 dakikalık deneme olarak açılacak:\n\n' +
      `• Havuz: ${poolStart}–${poolEnd}, ağ geçidi ve DNS: ${clientIp}\n` +
      '• Modemin DHCP\'si kapalı olmalı (4. adım)\n\n' +
      `Sonra telefonun Wi-Fi'ını kapatıp açın; ${hostOf(clientCidr, 0).replace(/\.0$/, '.x')} almalı${apStage !== 'none' ? ' (telefon ev Wi-Fi\'ına bağlı olmalı, kurulum Wi-Fi\'ına değil)' : ''}. Telefondan http://${clientIp}/#dhcp adresini (${settingsPath}) açıp "Kalıcı yap"a basın.\n` +
      '5 dakika içinde onaylanmazsa Pi DHCP\'si kendiliğinden kapanır — o zaman modemin DHCP\'sini hemen geri açın.\n\n' +
      'Devam edilsin mi?',
    )) return;
    void act('pi-enable', async () => {
      toast.info('Pi DHCP açılıyor — Pi-hole yeniden başlatılıyor, 1-2 dakika sürebilir');
      // Deneme başladıktan sonra düşerse Pi uyarıyı kendisi kaydeder (pi.modem_warn); durum yenilenince bant görünür.
      await postWithWarning('/dhcp/pi/enable');
      toast.success('Pi DHCP deneme olarak açık — telefonla deneyip kalıcı yapın');
    });
  };
  const confirmPi = () => act('pi-confirm', async () => {
    await postWithWarning('/dhcp/pi/confirm');
    toast.success('Pi DHCP kalıcı — kira süresi 12 saat');
  });
  const rollbackPi = () => act('pi-rollback', async () => {
    await postApi('/dhcp/pi/rollback', {});
    toast.info('Pi DHCP kapatıldı — modemin DHCP\'sini hemen geri açın');
  });
  const ackModemWarn = () => act('ack', async () => {
    await postApi('/dhcp/pi/ack', {});
  });
  const disablePi = () => {
    if (!window.confirm(
      'Modeme geri dönülecek: Pi DHCP sunucusu kapanır.\n\n' +
      `Önce modemin arayüzünden (http://${gw || 'modem'}) DHCP'yi açtığınızdan emin olun — Pi, modemin yanıt verdiğini doğrulamadan kapatmaz.\n\n` +
      'Devam edilsin mi?',
    )) return;
    void act('pi-disable', async () => {
      try {
        await postApi('/dhcp/pi/disable', {});
      } catch (e) {
        // Zorla kapatma yalnız "modemin DHCP'si doğrulanamadı" reddinde önerilir; diğer hatalar olduğu gibi gösterilir.
        const msg = errText(e, 'Pi DHCP kapatılamadı');
        if (!/modemin DHCP/.test(msg)) throw e;
        if (!window.confirm(
          `${msg}\n\n` +
          'Modemin DHCP\'si yanıt vermiyor. Yine de Pi DHCP\'si kapatılsın mı? Kapatılırsa modemin DHCP\'si açılana kadar cihazlar adres alamaz.',
        )) return;
        await postApi('/dhcp/pi/disable', { force: true });
        toast.info('Pi DHCP kapatıldı — modemin DHCP\'sini hemen açın');
        return;
      }
      toast.success('Pi DHCP kapatıldı — adresleri yeniden modem dağıtıyor');
    });
  };

  const guardEmergency = net.guard_result === 'emergency';
  // Kayıtlı ağ kartı bulunamadı (çıkarılmış ya da adı değişmiş): Pi yalnız bildirir, ayara dokunmaz. Koruma sonucu bir
  // sonraki denetime kadar eski kalır: kart geri geldiyse (ifaces_missing'de yok) uyarı gösterilmez.
  const missingNow = (net.ifaces_missing || '').split(',').map(s => s.trim()).filter(Boolean);
  const guardMissing = net.guard_result === 'missing' && !!net.iface && missingNow.includes(`lan:${net.iface}`);
  // Varsayılan rotanın kartı NetworkManager'ın dışında (yönetilmiyor / dışarıdan yapılandırılmış): roller o kartta açılmaz.
  const nmCard = net.nm_unmanaged || net.nm_external || '';
  const lanMovedTo = (net.missing_hint || '').split(',').map(h => h.trim()).find(h => h.startsWith('lan:'))?.split('->')[1] || '';
  // İnternet kartı açıkken Pi evin router'ıdır: ev ağında başka DHCP sunucusu yok, eth0'da modem tarafı adres yok.
  const wanOn = !!net.wan_stage && net.wan_stage !== 'none';
  const wanLock = "İnternet kartı (WAN router) açık — önce Cihaz Rolleri → İnternet bağlantısı'ndan kapatın";
  const step1: StepState = isStatic ? 'done' : 'active';
  const step3: StepState = wifiReady ? 'done' : isStatic || apTrial ? 'active' : 'todo';
  const step4: StepState = piOn || (probe && !probe.servers.length) ? 'done' : isStatic && wifiReady ? 'active' : 'todo';
  const step5: StepState = piStage === 'on' ? 'done' : isStatic && wifiReady ? 'active' : 'todo';

  return (
    <div className="dhcp-wizard">
      <div className="dhcp-wizard-title">Pi'yi evin DHCP sunucusu yapma</div>

      {modemWarn && (
        <div className="routing-apply routing-apply-err">
          <AlertTriangle size={14} />
          <span>
            <strong>Modemin DHCP'sini hemen geri açın</strong>{gw ? ` (http://${gw})` : ''} — Pi DHCP'si kapandı ya da açılamadı;
            modemin DHCP'si de kapalıysa cihazlar adres alamaz. "Kontrol et" modemin yanıt verdiğini görünce bu uyarı kalkar.
          </span>
          <button className="dhcp-ack" onClick={check} disabled={!!busy}>{busy === 'probe' ? 'Taranıyor…' : 'Kontrol et'}</button>
          <button className="dhcp-ack" onClick={ackModemWarn} disabled={!!busy}>Tamam, açtım</button>
        </div>
      )}
      {netErr && <span className="dhcp-muted">Sabit adres durumu yenilenemedi: {netErr}</span>}
      {net.nm === false && (
        <Alert kind="err">
          NetworkManager gerekli — bu cihazda kurulu değil ya da çalışmıyor. Sabit adres ve ağ rolleri NetworkManager ile
          yönetilir; panel güncellemesi eksikse kurar.
        </Alert>
      )}
      {!!nmCard && (
        <Alert kind="err">
          Bu kart (<span className="rl-mono">{nmCard}</span>){' '}
          {net.nm_unmanaged
            ? "NetworkManager tarafından yönetilmiyor (ör. /etc/network/interfaces ya da netplan'da tanımlı)."
            : 'NetworkManager dışında yapılandırılmış (systemd-networkd / dhcpcd / elle); NetworkManager yalnız izliyor.'}
          {' '}Ağ rolleri için kartı NetworkManager'a taşıyın:{' '}
          {net.planned_type === 'ethernet' ? (
            <>
              önce profil oluşturun (
              <span className="rl-mono">sudo nmcli connection add type ethernet ifname {nmCard} con-name {nmCard} ipv4.method auto</span>
              {' '}— adres elle verilmişse aynı adresle <span className="rl-mono">ipv4.method manual</span>), sonra kartı eski
              ayarından çıkarıp yeniden başlatın. Klyrix NetworkManager'ın kendiliğinden profil açmasını kapattı: bu sıra
              atlanırsa kart açılışta adressiz kalır.
            </>
          ) : 'kartı eski ayarından çıkarıp yeniden başlatın.'}
        </Alert>
      )}
      {wanOn && (
        <Alert kind="ok">
          İnternet kartı (<span className="rl-mono">{net.wan_port || 'WAN'}</span>) açık: Pi evin router'ı. Sabit adres ve Pi DHCP'si bu
          modda değiştirilemez; önce Cihaz Rolleri → İnternet bağlantısı'ndan kapatın.
        </Alert>
      )}

      <Step n={1} title="Pi'ye sabit adres ver" state={step1}>
        {guardEmergency && (
          <Alert kind="err">
            Sabit IP profili yüklenemedi — Pi adresini acil modda (yalnız bu açılış için) tutuyor
            {net.guard_detail ? ` (${net.guard_detail})` : ''}. Pi bir sonraki açılışta profili yedekten yeniden yüklemeyi dener.
          </Alert>
        )}
        {guardMissing && (
          <Alert kind="err">
            Ağ kartı bulunamadı{net.iface ? ` (${net.iface})` : ''} — kart çıkarılmış ya da adı değişmiş olabilir. Pi sabit adres
            ayarına dokunmadı; kartı yeniden takın{lanMovedTo ? ` (aynı kart şimdi ${lanMovedTo} adıyla görünüyor)` : ''}.
          </Alert>
        )}
        {stage === 'none' && (
          <>
            <span>
              {net.method === 'manual' ? 'Pi\'nin adresi şu an elle ayarlı' : 'Pi şu an adresini modemden otomatik alıyor'}
              {net.addrs ? ` (${net.iface || net.planned_iface || ''} ${net.addrs})` : ''}.
              Sabit adreste aynı karta iki adres verilir: modem tarafı <code>{net.planned_transit || '?'}</code> (modem{' '}
              <code>{net.planned_gw || '?'}</code>, panel bu adreste kalır) ve cihazlar için <code>{net.planned_client || clientCidr}</code>.
            </span>
            {!wired && (
              <Alert kind="err">
                Pi kabloyla bağlı görünmüyor{net.planned_iface ? ` (internet ${net.planned_iface} üzerinden geliyor)` : ''} — sabit adres
                yalnız kablolu bağlantıda verilir; Pi'yi modeme kabloyla bağlayın.
              </Alert>
            )}
            {wired && net.carrier === false && <Alert kind="err">Kablo bağlantısı yok (carrier yok).</Alert>}
            {wired && reserveHint && <span className="dhcp-muted">Önce: {reserveHint}</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={giveStatic} disabled={!!busy || !wired || !net.planned_transit || net.carrier === false}>
                {busy === 'static' ? 'Uygulanıyor…' : 'Pi\'ye sabit adres ver (3 dk deneme)'}
              </button>
            </div>
          </>
        )}
        {stage === 'trial' && (
          <>
            <span>
              <strong>Deneme sürüyor</strong> — kalan {fmtLeft(netLeft)}. Adresler: {net.addrs || `${net.transit}, ${net.client}`}.
              Panel açılıyor ve internet çalışıyorsa kalıcı yapın; yapmazsanız süre dolunca Pi otomatik adrese döner.
            </span>
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={confirmStatic} disabled={!!busy}>Çalışıyor, kalıcı yap</button>
              <button className="btn-outline btn-sm" onClick={rollbackStatic} disabled={!!busy}>Geri al</button>
            </div>
          </>
        )}
        {isStatic && (
          <>
            <span>
              <Badge variant="success">Sabit</Badge>{' '}
              Cihazlar için <code>{net.client}</code>, modem tarafı <code>{net.transit}</code> → modem <code>{net.gw}</code>
              {net.active_conn === 'pi5-br0' ? ` — adresler ev Wi-Fi köprüsünde (${net.lan_if || 'br0'})`
                : net.active_conn && net.active_conn !== 'pi5-eth0' ? ` — etkin profil: ${net.active_conn}` : ''}.
            </span>
            {net.profile_ok === false && !guardEmergency && (
              <Alert kind="err">Sabit IP profil dosyası eksik — Pi açılışta yedekten geri yükler; sorun sürerse otomatik adrese dönün.</Alert>
            )}
            {!piOn && leaseUntil > 0 && (
              <span className="dhcp-muted">
                Pi'nin dağıttığı kiralar {leaseUntilText} saatine kadar sürüyor — o zamana kadar bu cihazlar ağ geçidi olarak{' '}
                {ipOf(net.client)} adresini kullanır; otomatik adrese bu saatten sonra dönülebilir.
              </span>
            )}
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={backToAuto} disabled={!!busy || piOn || leaseUntil > 0 || wanOn}
                title={wanOn ? wanLock : piOn ? 'Pi DHCP sunucusu açıkken otomatik adrese dönülemez — önce modeme geri dönün'
                  : leaseUntil > 0 ? `Pi'nin dağıttığı kiralar ${leaseUntilText} saatine kadar sürüyor` : undefined}>
                {busy === 'static-dhcp' ? 'Uygulanıyor…' : 'Otomatik adrese dön'}
              </button>
            </div>
          </>
        )}
      </Step>

      <Step n={2} title="İstemci testi (önerilen)" state={stage === 'none' ? 'todo' : 'active'}>
        <span>
          Bir bilgisayar ya da telefonda ağ ayarını elle yapın: IP <code>{hostOf(clientCidr, 50)}</code>, maske{' '}
          <code>{maskOf(clientCidr)}</code>, ağ geçidi ve DNS <code>{clientIp}</code>. Sonra kontrol edin:
        </span>
        <ul>
          <li>internet açılıyor mu,</li>
          <li>engelli bir reklam alan adı (ör. <code>doubleclick.net</code>) açılmıyor mu,</li>
          <li>modemin arayüzü <code>http://{gw || '192.168.1.1'}</code> açılıyor mu,</li>
          <li>panel <code>http://{clientIp}</code> adresinden açılıyor mu.</li>
        </ul>
        <span>Bitince cihazı yeniden otomatik (DHCP) ayara alın.</span>
      </Step>

      <Step n={3} title="Pi'nin Wi-Fi'si" state={step3}>
        {homeStage !== 'none' && (
          <span>
            {/* Rozet büyük harfle yazılır: lang="tr"de "Wi-Fi" → "Wİ-Fİ" olmasın. Tek span: rozet inline-flex, parçalar
                ayrı öğe olunca aradaki boşluk düşer. */}
            {homeStage === 'on' ? <><Badge variant="success"><span>Ev <span lang="en">Wi-Fi</span>'ı</span></Badge>{' '}</> : null}
            Pi'nin Wi-Fi'si ev Wi-Fi'ını yayınlıyor{net.home_ssid ? ` (${net.home_ssid})` : ''}
            {homeStage === 'trial' ? ' — deneme sürüyor' : ''}: kart kablolu ağla aynı köprüde, modem ağına istemci olarak
            bağlanmaz. Ayarlar: menü → Cihaz Rolleri.
          </span>
        )}
        {noWifi && apStage === 'none' && homeStage === 'none' && (
          <span>Bu cihazda Wi-Fi kartı yok — Pi yalnız kabloyla bağlı, ayrılacak Wi-Fi bağlantısı yok.</span>
        )}
        {!noWifi && apStage === 'none' && homeStage === 'none' && (
          <>
            <span>
              {wifiOff
                ? 'Pi\'nin Wi-Fi\'si kapalı — Pi yalnız kabloyla bağlı.'
                : wlanAddrs.length > 0
                  ? `Pi'nin Wi-Fi'si de modem ağına bağlı (${wlanAddrs.join(', ')}). DHCP açılmadan önce bu bağlantı ayrılır — Pi aynı ağa iki yoldan bağlıyken cihazlara yanlış karttan yanıt verebilir.`
                  : 'Pi\'nin Wi-Fi\'si açık ama şu an bir ağa bağlı değil — kendiliğinden modeme yeniden bağlanabilir. DHCP açılmadan önce ev ağından ayrılır.'}
            </span>
            {viaWifi && (
              <Alert kind="err">
                Paneli Pi'nin Wi-Fi adresinden açtınız — Wi-Fi ev ağından ayrılınca bağlantı kopar. Önce kablolu adresi açın: http://{transitIp || net.transit}
              </Alert>
            )}
            <div className="dhcp-option dhcp-option-main">
              <strong>Kurulum Wi-Fi'ına çevir (önerilen)</strong>
              <span>
                Pi'nin Wi-Fi'si ev ağından ayrılır ve kendi ağını yayınlar (2,4 GHz, Pi <code>{apIp}</code>). Telefon bu ağa
                bağlanınca "ağa giriş yap" sayfası kendiliğinden açılır ve panele götürür — modemin DHCP'si kapalıyken de. Bu ağda
                internet yok, yalnız panel içindir; açık kaldıkça panele her zaman bu yoldan ulaşılır.
              </span>
              {net.ap_capable === false && (
                <Alert kind="err">
                  Pi'nin Wi-Fi kartı bulunamadı ya da yayın (erişim noktası) kipini desteklemiyor — "Yalnız ayır"ı kullanın.
                </Alert>
              )}
              <div className="panel-auth-form">
                <input className="config-input" type="text" autoComplete="off" spellCheck={false} maxLength={32}
                  placeholder={`Ağ adı (${AP_DEFAULT_SSID})`} aria-label="Kurulum Wi-Fi'ının adı"
                  value={apSsid} onChange={e => setApSsid(e.target.value)} />
                {/* maxLength yok: yapıştırılan uzun şifre sessizce kesilmesin (telefon tam şifreyle bağlanamazdı); 8-63 kuralını
                    doğrulama gösterir. */}
                <input className="config-input" type="password" autoComplete="new-password"
                  placeholder="Wi-Fi şifresi" aria-label="Kurulum Wi-Fi'ının şifresi (8-63 karakter)"
                  value={apPw} onChange={e => setApPw(e.target.value)} />
                <input className="config-input" type="password" autoComplete="new-password"
                  placeholder="Şifre (tekrar)" aria-label="Kurulum Wi-Fi'ının şifresi (tekrar)"
                  value={apPw2} onChange={e => setApPw2(e.target.value)} />
              </div>
              <span className="dhcp-muted">
                Şifre 8-63 karakter: İngilizce harf, rakam, boşluk ve işaretler; Türkçe harf (ç ğ ı ö ş ü) ve ters bölü (\) olmaz,
                başta/sonda boşluk olmaz. Telefona da aynı şifreyi yazacaksınız. Ağ adı en çok 32 karakter: harf, rakam, boşluk, _ . -
              </span>
              <div className="panel-auth-actions">
                <button className="btn-primary btn-sm" onClick={startAp}
                  disabled={!!busy || !isStatic || viaWifi || net.ap_capable === false || !apPw || !apPw2}
                  title={!isStatic ? 'Önce 1. adımı tamamlayın' : undefined}>
                  {busy === 'ap' ? 'Açılıyor…' : 'Kurulum Wi-Fi\'ını aç (5 dk deneme)'}
                </button>
              </div>
            </div>
            <div className="dhcp-option">
              <strong>Yalnız ayır</strong>
              {wifiOff ? (
                <>
                  <span>
                    Seçili: Pi'nin Wi-Fi'si kapalı. Modemin DHCP'si kapalıyken panele yalnız kablolu ya da elle IP verilmiş bir
                    cihazdan ulaşılır.
                  </span>
                  <div className="panel-auth-actions">
                    <button className="btn-outline btn-sm" onClick={() => setWifi(true)} disabled={!!busy || piOn}
                      title={piOn ? 'Pi DHCP sunucusu açıkken Pi\'nin Wi-Fi\'si modeme bağlanamaz' : undefined}>
                      {busy === 'wifi' ? 'Uygulanıyor…' : 'Wi-Fi\'yi geri bağla'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span>
                    Wi-Fi kapatılır, Pi yalnız kabloyla bağlı kalır. Modemin DHCP'si kapalıyken panele yalnız kablolu ya da elle IP
                    verilmiş bir cihazdan ulaşılır.
                  </span>
                  <div className="panel-auth-actions">
                    <button className="btn-outline btn-sm" onClick={() => setWifi(false)} disabled={!!busy || !isStatic || viaWifi}
                      title={!isStatic ? 'Önce 1. adımı tamamlayın' : undefined}>
                      {busy === 'wifi' ? 'Uygulanıyor…' : 'Wi-Fi bağlantısını ayır'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
        {apTrial && (
          <>
            <span>
              <strong>Kurulum Wi-Fi'ı deneniyor</strong> — kalan {fmtLeft(apLeft)}. Ağ <code>{apSsidLive}</code>, Pi{' '}
              <code>{apIp}</code>{net.ap_active === false ? ' (yayın şu an görünmüyor)' : ''}.
            </span>
            <ol>
              <li>Telefonun Wi-Fi ayarlarından <code>{apSsidLive}</code> ağına bağlanın (panelde yazdığınız şifreyle).</li>
              <li>
                "Ağa giriş yap" sayfası kendiliğinden açılır → "Paneli aç" (panel şifresi sorulur, kullanıcı <code>admin</code>).
                Açılmazsa telefonun tarayıcısında <code>http://{apIp}</code> adresini açın.
              </li>
              <li>Telefonda {settingsPath} → 3. adım → "Kalıcı yap".</li>
            </ol>
            <span className="dhcp-muted">
              "Kalıcı yap" yalnız bu ağa bağlı telefondan kabul edilir. Süre dolarsa Pi kurulum Wi-Fi'ını kapatır ve Wi-Fi'si eski
              ayarına döner.
            </span>
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={confirmAp} disabled={!!busy}>Kalıcı yap</button>
              <button className="btn-outline btn-sm" onClick={rollbackAp} disabled={!!busy}>Geri al</button>
            </div>
          </>
        )}
        {apOn && (
          <>
            <span>
              <Badge variant="success">Açık</Badge>{' '}
              Kurulum Wi-Fi'ı <code>{apSsidLive}</code> — panel <code>http://{apIp}</code>; bu ağda internet yok, yalnız yönetim.
              {net.ap_active ? ' Yayında.' : ''}
            </span>
            {net.ap_active === false && (
              <Alert kind="err">
                Yayın şu an kapalı — Pi bir sonraki açılışta ya da NetworkManager yeniden başlayınca yeniden açmayı dener.
              </Alert>
            )}
            {net.ap_guard_result === 'failed' && (
              <Alert kind="err">
                Kurulum Wi-Fi'ı kendiliğinden yeniden açılamadı{net.ap_guard_detail ? ` (${net.ap_guard_detail})` : ''}.
              </Alert>
            )}
            <span className="dhcp-muted">
              Modemin DHCP'si kapalıyken ya da bir sorun çıktığında telefonu <code>{apSsidLive}</code> ağına bağlayıp panele
              buradan ulaşın.
            </span>
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={turnOffAp} disabled={!!busy}>
                {busy === 'ap-off' ? 'Kapatılıyor…' : 'Kurulum Wi-Fi\'ını kapat'}
              </button>
            </div>
          </>
        )}
      </Step>

      <Step n={4} title="Modemin DHCP'sini kapat" state={step4}>
        <span>
          Modemin arayüzünde (<code>http://{gw || '192.168.1.1'}</code>) LAN / DHCP ayarından <strong>DHCP sunucusunu kapatın</strong>;
          modemin Wi-Fi yayını açık kalsın. Sonra "Kontrol et"e basın ve hemen 5. adıma geçin — arada yeni bağlanan cihazlar adres
          alamaz (bağlı olanlar kira süresince çalışır). Modemin misafir Wi-Fi'si açıksa, modemin DHCP'si kapanınca adres veremeyebilir.
        </span>
        {probe && !probe.servers.length && (
          <Alert kind="ok">
            Başka DHCP sunucusu yok{probe.own.length ? ` (yanıt veren yalnız Pi: ${probe.own.join(', ')})` : ''}.
          </Alert>
        )}
        {probe && probe.servers.length > 0 && (
          <Alert kind="err">Yanıt veren DHCP sunucusu: {probe.servers.join(', ')} — modemin DHCP'si hâlâ açık.</Alert>
        )}
        {probeErr && <Alert kind="err">Tarama yapılamadı: {probeErr}</Alert>}
        <div className="panel-auth-actions">
          <button className="btn-outline btn-sm" onClick={check} disabled={!!busy || !dhcp.pi}>
            {busy === 'probe' ? 'Taranıyor…' : 'Kontrol et'}
          </button>
        </div>
      </Step>

      <Step n={5} title="Pi DHCP'sini aç" state={step5}>
        {!dhcp.pi && <span>Pi DHCP betiği (pi-dhcp.sh) bulunamadı — paneli güncelleyin.</span>}
        {dhcp.pi?.error && <Alert kind="err">Pi DHCP durumu okunamadı: {dhcp.pi.error}</Alert>}
        {pi && piMismatch && (
          <>
            <Alert kind="err">
              Pi-hole DHCP'si açık ama sihirbazın kaydı kapalı görünüyor (Pi-hole arayüzünden açılmış ya da bir geri alma yarım
              kalmış olabilir). Modeme dönmek için önce modemin DHCP'sini açın, sonra "Modeme geri dön"e basın.
            </Alert>
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={disablePi} disabled={!!busy || wanOn} title={wanOn ? wanLock : undefined}>
                {busy === 'pi-disable' ? 'Kapatılıyor…' : 'Modeme geri dön'}
              </button>
            </div>
          </>
        )}
        {pi && piStage === 'off' && !piMismatch && (
          <>
            <span>
              Pi-hole cihazlara <code>{poolStart}–{poolEnd}</code> arası adres dağıtır; ağ geçidi ve DNS <code>{clientIp}</code>.
              İlk 5 dakika denemedir (kira 5 dk). Paneldeki statik IP rezervasyonları henüz Pi-hole'a aktarılmıyor (yalnız panel
              veritabanında duruyor).
            </span>
            {!isStatic && <span className="dhcp-muted">Önce 1. adım (sabit adres, kalıcı) tamamlanmalı.</span>}
            {isStatic && !wifiReady && (
              <span className="dhcp-muted">Önce 3. adım: Pi'nin Wi-Fi'sini kurulum Wi-Fi'ına çevirip kalıcı yapın ya da yalnız ayırın.</span>
            )}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={enablePi} disabled={!!busy || !isStatic || !wifiReady}>
                {busy === 'pi-enable' ? 'Açılıyor…' : 'Pi DHCP\'sini aç (5 dk deneme)'}
              </button>
            </div>
          </>
        )}
        {pi && piStage === 'trial' && (
          <>
            <span>
              <strong>Deneme sürüyor</strong> — kalan {fmtLeft(piLeft)}; şu ana kadar {pi.leases ?? 0} kira verildi.
              Telefonun Wi-Fi'ını kapatıp açın; <code>{hostOf(clientCidr, 0).replace(/\.0$/, '.x')}</code> almalı. Sonra telefondan{' '}
              <code>http://{clientIp}/#dhcp</code> adresini ({settingsPath}) açıp "Kalıcı yap"a basın.
            </span>
            {apStage !== 'none' && (
              <span className="dhcp-muted">
                Bu onay için telefon ev Wi-Fi'ına (modemin ağına) bağlı olmalı — kurulum Wi-Fi'ından ({apSsidLive}) verilen onay kabul
                edilmez.
              </span>
            )}
            {pi.port67 === false && <Alert kind="err">Pi-hole DHCP portunu (67) dinlemiyor.</Alert>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={confirmPi} disabled={!!busy}>Kalıcı yap</button>
              <button className="btn-outline btn-sm" onClick={rollbackPi} disabled={!!busy}>Geri al</button>
            </div>
          </>
        )}
        {pi && piStage === 'on' && (
          <>
            <span>
              <Badge variant="success">Açık</Badge>{' '}
              Havuz <code>{pi.start}–{pi.end}</code>, kira {pi.lease_time || '?'}, {pi.leases ?? 0} kira.
            </span>
            {pi.port67 === false && <Alert kind="err">DHCP sunucusu (Pi-hole) dinlemiyor — cihazlar adres alamayabilir.</Alert>}
            <span className="dhcp-muted">
              Modeme geri dönmek için önce modemin DHCP'sini açın, sonra "Modeme geri dön"e basın.{reserveHint ? ` ${reserveHint}` : ''}
            </span>
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={disablePi} disabled={!!busy || wanOn} title={wanOn ? wanLock : undefined}>
                {busy === 'pi-disable' ? 'Kapatılıyor…' : 'Modeme geri dön'}
              </button>
            </div>
          </>
        )}
      </Step>
    </div>
  );
}

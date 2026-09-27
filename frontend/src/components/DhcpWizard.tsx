import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, CheckCircle } from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Badge } from './ui';

// Faz 2 sihirbazı: Pi'ye sabit adres → istemci testi → Pi'nin Wi-Fi'sini ayır → modemin DHCP'sini kapat → Pi DHCP'sini aç.
// Riskli adımlar (1 ve 5) denemedir: "Kalıcı yap"a basılmazsa Pi kendi zamanlayıcısıyla geri döner (panel kapalı olsa da).
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
}
interface ProbeResult { servers: string[]; own: string[] }

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
  const wlanAddrs = (net.wlan_addrs || '').split(',').map(s => s.trim()).filter(Boolean);
  // Pi DHCP yalnız Wi-Fi kapalıyken (nmcli radio wifi off) açılır: adresi olmayan ama açık Wi-Fi'yi NetworkManager
  // modeme kendiliğinden yeniden bağlayabilir (Pi aynı ağa iki yoldan bağlanır).
  const wifiOff = net.wifi === 'disabled';
  const viaWifi = wlanAddrs.some(a => ipOf(a) === window.location.hostname);
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
  const settingsPath = 'Pi-hole → Ayarlar → DHCP kartı';

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
  const check = () => act('probe', async () => {
    const r = await runProbe();
    if (r) toast.info(r.servers.length ? 'Başka bir DHCP sunucusu yanıt veriyor' : 'Başka DHCP sunucusu yok');
  });
  const enablePi = () => {
    if (!window.confirm(
      'Pi DHCP sunucusu 5 dakikalık deneme olarak açılacak:\n\n' +
      `• Havuz: ${poolStart}–${poolEnd}, ağ geçidi ve DNS: ${clientIp}\n` +
      '• Modemin DHCP\'si kapalı olmalı (4. adım)\n\n' +
      `Sonra telefonun Wi-Fi'ını kapatıp açın; ${hostOf(clientCidr, 0).replace(/\.0$/, '.x')} almalı. Telefondan http://${clientIp} adresini açıp ${settingsPath} içinde "Kalıcı yap"a basın.\n` +
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
  const step1: StepState = isStatic ? 'done' : 'active';
  const step3: StepState = wifiOff ? 'done' : isStatic ? 'active' : 'todo';
  const step4: StepState = piOn || (probe && !probe.servers.length) ? 'done' : isStatic && wifiOff ? 'active' : 'todo';
  const step5: StepState = piStage === 'on' ? 'done' : isStatic && wifiOff ? 'active' : 'todo';

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

      <Step n={1} title="Pi'ye sabit adres ver" state={step1}>
        {guardEmergency && (
          <Alert kind="err">
            Sabit IP profili yüklenemedi — Pi adresini acil modda (yalnız bu açılış için) tutuyor
            {net.guard_detail ? ` (${net.guard_detail})` : ''}. Pi bir sonraki açılışta profili yedekten yeniden yüklemeyi dener.
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
              {net.active_conn && net.active_conn !== 'pi5-eth0' ? ` — etkin profil: ${net.active_conn}` : ''}.
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
              <button className="btn-outline btn-sm" onClick={backToAuto} disabled={!!busy || piOn || leaseUntil > 0}
                title={piOn ? 'Pi DHCP sunucusu açıkken otomatik adrese dönülemez — önce modeme geri dönün'
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

      <Step n={3} title="Pi'nin Wi-Fi bağlantısını ayır" state={step3}>
        {wifiOff ? (
          <>
            <span>Pi'nin Wi-Fi'si kapalı — Pi yalnız kabloyla bağlı.</span>
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
              {wlanAddrs.length > 0
                ? `Pi'nin Wi-Fi'si de modem ağına bağlı (${wlanAddrs.join(', ')}). DHCP açılmadan önce bu bağlantı ayrılır — Pi aynı ağa iki yoldan bağlıyken cihazlara yanlış karttan yanıt verebilir.`
                : 'Pi\'nin Wi-Fi\'si açık ama şu an bir ağa bağlı değil — kendiliğinden modeme yeniden bağlanabilir. DHCP açılmadan önce Wi-Fi kapatılır.'}
              {' '}Pi'nin kendi Wi-Fi yayını sonraki adımda gelecek.
            </span>
            {viaWifi && (
              <Alert kind="err">
                Paneli Pi'nin Wi-Fi adresinden açtınız — ayırınca bağlantı kopar. Önce kablolu adresi açın: http://{transitIp || net.transit}
              </Alert>
            )}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={() => setWifi(false)} disabled={!!busy || !isStatic || viaWifi}
                title={!isStatic ? 'Önce 1. adımı tamamlayın' : undefined}>
                {busy === 'wifi' ? 'Uygulanıyor…' : 'Wi-Fi bağlantısını ayır'}
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
              <button className="btn-outline btn-sm" onClick={disablePi} disabled={!!busy}>
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
            {isStatic && !wifiOff && <span className="dhcp-muted">Önce 3. adım: Pi'nin Wi-Fi bağlantısını ayırın.</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={enablePi} disabled={!!busy || !isStatic || !wifiOff}>
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
              <code>http://{clientIp}</code> adresini açıp {settingsPath} içinde "Kalıcı yap"a basın.
            </span>
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
              <button className="btn-outline btn-sm" onClick={disablePi} disabled={!!busy}>
                {busy === 'pi-disable' ? 'Kapatılıyor…' : 'Modeme geri dön'}
              </button>
            </div>
          </>
        )}
      </Step>
    </div>
  );
}

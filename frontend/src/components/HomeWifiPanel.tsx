import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Wifi, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { getApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';
import type { NetModeStatus } from './DhcpWizard';

// Erişim noktası rolü (R1): Pi'nin Wi-Fi kartı ev Wi-Fi'ını yayınlar, eth0 ile tek köprüde (br0) birleşir — kablosuz
// cihazlar kablolularla aynı ağa katılır, adreslerini evin DHCP sunucusundan (modem ya da Pi) alır. Açma 5 dk'lık
// denemedir; "Kalıcı yap" yalnız bu yayına bağlı bir telefondan kabul edilir (backend: /api/netmode/home*,
// net-mode.sh home). Durum /api/netmode/status'un home_* alanlarından.

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>;
// DhcpWizard ile aynı kurallar (betik ve backend de aynısını uygular).
const validSsid = (s: string) => /^[A-Za-z0-9 _.-]{1,32}$/.test(s) && !/^ | $/.test(s);
const validPassword = (s: string) => /^[\x20-\x5b\x5d-\x7e]{8,63}$/.test(s) && !/^ | $/.test(s);
const CHANNELS: Record<'bg' | 'a', number[]> = { bg: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], a: [36, 40, 44, 48] };
const DEFAULT_CH: Record<'bg' | 'a', number> = { bg: 6, a: 36 };
const ipOf = (cidr?: string) => (cidr || '').split('/')[0];
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const fmtLeft = (left: number | null) => (left === null ? '…' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
const bandText = (b?: string) => (b === 'a' ? '5 GHz' : '2,4 GHz');

// Deneme geri sayımı (sunucu saatine göre; DhcpWizard'daki gibi).
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

function Alert({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'info' ? 'ok' : kind} hw-alert-${kind}`}>
      {kind === 'err' ? <AlertTriangle size={14} /> : kind === 'ok' ? <CheckCircle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

export function HomeWifiPanel({ onChange }: { onChange?: () => void }) {
  const [net, setNet] = useState<NetModeStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ssid, setSsid] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [band, setBand] = useState<'bg' | 'a'>('bg');
  const [channel, setChannel] = useState(DEFAULT_CH.bg);

  const load = useCallback(async () => {
    try { setNet(await getApi<NetModeStatus>('/netmode/status')); setLoadErr(null); }
    catch (e) { setLoadErr(errText(e, 'durum okunamadı')); }
  }, []);
  const stage = net?.home_stage || 'none';
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    // Deneme sürerken sık (süre dolunca geri alındığı görünsün), değilse seyrek yenilenir.
    const id = setInterval(() => { void load(); }, stage === 'trial' ? 5000 : 30000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, stage]);
  const left = useCountdown(stage === 'trial' ? net?.home_trial_ends || 0 : 0, net?.now || 0);

  if (!net) return loadErr ? <Panel title="Ev Wi-Fi'ı" icon={<Wifi size={18} style={{ marginRight: 8 }} />}><p className="rl-muted">Durum okunamadı: {loadErr}</p></Panel> : null;
  if (!net.supported) return null;

  const isStatic = net.stage === 'static';
  const setupOn = (net.ap_stage || 'none') !== 'none';
  const panelIp = ipOf(net.transit);
  // Panel Pi'nin ev Wi-Fi'ı istemcisi adresinden açıldıysa (wlan0 modem ağına bağlı) yayın açılınca bu bağlantı kopar.
  const wlanAddrs = (net.wlan_addrs || '').split(',').map(s => ipOf(s.trim())).filter(Boolean);
  const viaWifiClient = wlanAddrs.includes(window.location.hostname);
  const liveSsid = net.home_ssid || ssid;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy(null);
    await load();
    onChange?.();
  };
  const pwMismatch = !!pw2 && pw !== pw2;
  const formErr = ssid && !validSsid(ssid) ? 'Ağ adı 1-32 karakter: harf (Türkçe harf olmadan), rakam, boşluk, _ . -'
    : pw && !validPassword(pw) ? 'Şifre 8-63 karakter: Türkçe harf ve ters bölü (\\) olmadan, başta/sonda boşluk olmadan'
      : pwMismatch ? 'Şifreler aynı değil' : '';
  const canStart = isStatic && !setupOn && net.home_capable !== false && !viaWifiClient && validSsid(ssid) && validPassword(pw) && pw === pw2;

  const start = () => {
    if (!window.confirm(
      `Ev Wi-Fi'ı açılacak (5 dakikalık deneme):\n\n` +
      `• Ağ adı: ${ssid} · ${bandText(band)}, kanal ${channel}\n` +
      `• Pi'nin kablosu ve Wi-Fi kartı tek köprüde birleşir; adresler köprüye taşınır\n` +
      `• Kablosuz cihazlar adreslerini evin DHCP sunucusundan alır (ayrı ağ yok)\n\n` +
      'Kablolu bağlantı birkaç saniye kopabilir. 5 dakika içinde bu ağa bağlı bir telefondan "Kalıcı yap"a basılmazsa Pi eski ayarına kendiliğinden döner.\n\n' +
      'Devam edilsin mi?',
    )) return;
    void act('on', async () => {
      toast.info("Ev Wi-Fi'ı açılıyor — bir dakikaya kadar sürebilir");
      await postApi('/netmode/home', { ssid, password: pw, band, channel });
      setPw(''); setPw2('');
      toast.success(`'${ssid}' yayında — telefonu bu ağa bağlayıp kalıcı yapın`);
    });
  };
  const confirm = () => act('confirm', async () => {
    await postApi('/netmode/home/confirm', {});
    toast.success("Ev Wi-Fi'ı kalıcı");
  });
  const rollback = () => act('rollback', async () => {
    await postApi('/netmode/home/rollback', {});
    toast.info("Ev Wi-Fi'ı denemesi geri alındı");
  });
  const off = () => {
    if (!window.confirm(`Ev Wi-Fi'ı (${net.home_ssid || '—'}) kapatılacak; bu ağa bağlı kablosuz cihazların bağlantısı kopar. Pi kablolu sabit adresle çalışmayı sürdürür.\n\nDevam edilsin mi?`)) return;
    void act('off', async () => {
      const r = await postApi('/netmode/home/off', {});
      if (r?.warning) toast.info(`Ev Wi-Fi'ı kapatıldı — ${r.warning}`); else toast.info("Ev Wi-Fi'ı kapatıldı");
    });
  };

  const state = stage === 'on'
    ? (net.home_active && net.br_active ? <Badge variant="success">Yayında</Badge> : <Badge variant="warning">Sorun var</Badge>)
    : stage === 'trial' ? <Badge variant="info">Deneme · {fmtLeft(left)}</Badge> : <Badge variant="neutral">Kapalı</Badge>;

  return (
    <Panel title="Ev Wi-Fi'ı" icon={<Wifi size={18} style={{ marginRight: 8 }} />} actions={state}
      subtitle="Erişim noktası rolü: kablosuz cihazlar Pi üzerinden, kablolularla aynı ağa bağlanır.">
      <div className="hw-body">
        {stage === 'none' && (
          <>
            {!isStatic && <Alert kind="info">Önce menü → DHCP Ayarları sihirbazında Pi'ye sabit adres verip kalıcı yapın (1. adım).</Alert>}
            {setupOn && <Alert kind="err">Kurulum <EN>Wi-Fi</EN>'ı açık: ev <EN>Wi-Fi</EN>'ı aynı kartı kullanır — önce DHCP Ayarları → 3. adımdan kurulum <EN>Wi-Fi</EN>'ını kapatın.</Alert>}
            {net.home_capable === false && <Alert kind="err">Pi'nin <EN>Wi-Fi</EN> kartı bulunamadı ya da yayın (erişim noktası) kipini desteklemiyor.</Alert>}
            {viaWifiClient && (
              <Alert kind="err">
                Paneli Pi'nin <EN>Wi-Fi</EN> adresinden ({window.location.hostname}) açtınız — yayın açılınca bu bağlantı kopar. Önce kablolu adresi açın: http://{panelIp}
              </Alert>
            )}
            <dl className="hw-facts">
              <div><dt>Nasıl çalışır</dt><dd>Pi'nin kablosu ve <EN>Wi-Fi</EN> kartı tek köprüde birleşir; Pi'nin adresleri değişmez.</dd></div>
              <div><dt>Adres dağıtımı</dt><dd>{net.pi_dhcp ? 'Pi DHCP sunucusu (açık)' : 'Modemin DHCP sunucusu'} — ayrı ağ ya da ikinci NAT yok.</dd></div>
              <div><dt>Güvenlik</dt><dd>WPA2 (AES). Şifre yalnız Pi'de saklanır.</dd></div>
            </dl>
            <div className="hw-form">
              <label className="hw-field">
                <span>Ağ adı</span>
                <input className="config-input" type="text" autoComplete="off" spellCheck={false} maxLength={32}
                  placeholder="ör. Klyrix" value={ssid} onChange={e => setSsid(e.target.value)} />
              </label>
              <label className="hw-field">
                <span>Şifre</span>
                <input className="config-input" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
              </label>
              <label className="hw-field">
                <span>Şifre (tekrar)</span>
                <input className="config-input" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
              </label>
              <label className="hw-field hw-field-sm">
                <span>Bant</span>
                <select value={band} onChange={e => { const b = e.target.value === 'a' ? 'a' : 'bg'; setBand(b); setChannel(DEFAULT_CH[b]); }}>
                  <option value="bg">2,4 GHz</option>
                  <option value="a">5 GHz</option>
                </select>
              </label>
              <label className="hw-field hw-field-sm">
                <span>Kanal</span>
                <select value={channel} onChange={e => setChannel(Number(e.target.value))}>
                  {CHANNELS[band].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            <span className="dhcp-muted">
              2,4 GHz daha uzağa ulaşır, 5 GHz daha hızlıdır (Pi'nin dahili kartında 5 GHz'te 36-48 kanalları kullanılır). Şifre 8-63
              karakter; Türkçe harf ve ters bölü olmaz.
            </span>
            {formErr && <span className="hw-form-err" role="alert">{formErr}</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={start} disabled={!!busy || !canStart}
                title={!isStatic ? 'Önce sabit adres' : setupOn ? "Önce kurulum Wi-Fi'ını kapatın" : undefined}>
                {busy === 'on' ? 'Açılıyor…' : "Ev Wi-Fi'ını aç (5 dk deneme)"}
              </button>
            </div>
          </>
        )}
        {stage === 'trial' && (
          <>
            <Alert kind={net.home_active && net.br_active ? 'ok' : 'err'}>
              {net.home_active && net.br_active
                ? <><strong>'{liveSsid}' yayında</strong> ({bandText(net.home_band)}, kanal {net.home_channel || '—'}) — kalan {fmtLeft(left)}.</>
                : <>Deneme sürüyor ama {net.br_active ? 'yayın' : 'köprü'} etkin görünmüyor — geri alıp yeniden deneyin.</>}
            </Alert>
            <ol className="hw-steps">
              <li>Telefonu <strong>{liveSsid}</strong> ağına bağlayın (girdiğiniz şifreyle).</li>
              <li>Telefonda paneli açın: <code>http://{panelIp}/#roles</code></li>
              <li>Bu karttan <strong>Çalışıyor, kalıcı yap</strong>'a basın. İnternet de açılıyorsa her şey yolunda.</li>
            </ol>
            <span className="dhcp-muted">Kalıcı yapma yalnız bu ağa bağlı bir cihazdan kabul edilir. Süre dolarsa Pi eski ayarına kendiliğinden döner.</span>
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={confirm} disabled={!!busy}>{busy === 'confirm' ? 'Onaylanıyor…' : 'Çalışıyor, kalıcı yap'}</button>
              <button className="btn-outline btn-sm" onClick={rollback} disabled={!!busy}>{busy === 'rollback' ? 'Geri alınıyor…' : 'Geri al'}</button>
            </div>
          </>
        )}
        {stage === 'on' && (
          <>
            {!(net.home_active && net.br_active) && (
              <Alert kind="err">
                {net.br_active ? 'Yayın şu an kapalı' : 'Köprü kurulamadı — Pi kablolu, köprüsüz çalışıyor; ev Wi-Fi\'ı yayında değil'}
                {net.guard_detail ? ` (${net.guard_detail})` : ''}. Pi bir sonraki açılışta ya da NetworkManager yeniden başlayınca onarmayı dener.
              </Alert>
            )}
            <dl className="hw-facts">
              <div><dt>Ağ adı</dt><dd>{net.home_ssid || '—'}</dd></div>
              <div><dt>Bant / kanal</dt><dd>{bandText(net.home_band)} · kanal {net.home_channel || '—'}</dd></div>
              <div><dt>Köprü</dt><dd className="rl-mono">{net.lan_if || '—'} ({net.iface} + {net.home_iface})</dd></div>
              <div><dt>Adres dağıtımı</dt><dd>{net.pi_dhcp ? 'Pi DHCP sunucusu' : 'Modemin DHCP sunucusu'}</dd></div>
            </dl>
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={off} disabled={!!busy}>{busy === 'off' ? 'Kapatılıyor…' : "Ev Wi-Fi'ını kapat"}</button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

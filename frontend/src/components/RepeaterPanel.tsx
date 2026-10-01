import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Repeat, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { getApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';
import type { WanRadio } from './WanPanel';

// Wi-Fi köprüsü (aynı ağ, R4 C): Pi üst Wi-Fi'a (modem / router) istemci olarak bağlanır; kalıcı yapılınca eth0'a takılan
// cihazlar modemle AYNI ağda olur (ARP vekili, NAT yok). Adresi modem (Pi aktarır) ya da Pi (modem ağında ayrı aralık)
// dağıtır; cihazların DNS'i Pi-hole'a çekilir, VPS yönlendirmesi onlara da uygulanır. Deneme yalnız üst Wi-Fi'ı sınar
// (eth0 modemde kalır, panel açık); kalıcı yap Pi'nin YENİ adresinden yapılır, sonra eth0 kablosu arkadaki cihaza takılır.
// Backend: /api/repeater*, net-mode.sh rep.

type Dhcp = 'relay' | 'pi';
interface RepState {
  supported: boolean; error?: string; satellite?: boolean; now?: number;
  stage?: string; pi_dhcp?: boolean; iface?: string; sat_stage?: string; ap_stage?: string; home_stage?: string;
  wan_stage?: string; bak_stage?: string; wifi_roles?: string;
  rep_stage?: 'none' | 'trial' | 'on'; rep_trial_ends?: number; rep_port?: string; rep_lan?: string; rep_ssid?: string;
  rep_dhcp?: Dhcp; rep_range?: string; rep_old_name?: string; rep_ip?: string; rep_gw?: string; rep_up?: boolean;
  rep_signal?: number; rep_lan_state?: string; rep_lan_since?: number; rep_clients?: number; rep_mdns?: string;
  rep_missing_relay?: string; rep_missing_pi?: string; rep_guard_result?: string; rep_guard_detail?: string;
  lan?: { iface: string; ip: string; prefix: number; network: string; gateway: string } | null;
}

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const fmtLeft = (left: number | null) => (left === null ? '…' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
const fmtAgo = (sec: number) => (sec < 90 ? `${sec} sn` : sec < 5400 ? `${Math.round(sec / 60)} dk` : `${Math.round(sec / 3600)} sa`);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const numIp = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
// Ev tarafının durumu; lanIf: ev tarafı kartının gerçek adı (eth0, end0, enp1s0 …).
const LAN_TEXT = (lanIf: string): Record<string, string> => ({
  active: 'açık — cihazlar modemle aynı ağda', modem: `kapalı — ${lanIf} kablosu hâlâ modemde`, no_carrier: 'kablo takılı değil',
  no_uplink: "kapalı — üst Wi-Fi'da adres yok", missing: 'ev tarafı kartı yok',
});

function Alert({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'info' ? 'ok' : kind} hw-alert-${kind}`}>
      {kind === 'err' ? <AlertTriangle size={14} /> : kind === 'ok' ? <CheckCircle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

// Deneme geri sayımı (sunucu saatine göre; WanPanel'deki gibi).
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

export function RepeaterPanel({ radios = [], onChange }: { radios?: WanRadio[]; onChange?: () => void }) {
  const [st, setSt] = useState<RepState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [port, setPort] = useState('');
  const [ssid, setSsid] = useState('');
  const [pw, setPw] = useState('');
  const [dhcp, setDhcp] = useState<Dhcp>('relay');
  const [rStart, setRStart] = useState('');
  const [rEnd, setREnd] = useState('');
  const [offForce, setOffForce] = useState(false);

  const load = useCallback(async () => {
    try { setSt(await getApi<RepState>('/repeater')); setLoadErr(null); }
    catch (e) { setLoadErr(errText(e, 'durum okunamadı')); }
  }, []);
  const stage = st?.rep_stage || 'none';
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, stage === 'none' ? 20000 : 5000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, stage]);
  const left = useCountdown(stage === 'trial' ? st?.rep_trial_ends || 0 : 0, st?.now || 0);

  const title = 'Wi-Fi köprüsü (aynı ağ)';
  const icon = <Repeat size={18} style={{ marginRight: 8 }} />;
  if (!st) return loadErr ? <Panel title={title} icon={icon}><p className="rl-muted">Durum okunamadı: {loadErr}</p></Panel> : null;
  if (!st.supported || st.satellite) return null;

  // Üst Wi-Fi radyosu: başka işte olmayan (net-mode.sh wifi_roles "kart=rol") ve istemci olabilen kartlar.
  const roleOf = new Map((st.wifi_roles || '').split(',').filter(Boolean).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)] as [string, string]));
  const wifiOpts = radios.filter(r => r.sta && r.ifaces[0] && !roleOf.get(r.ifaces[0])).map(r => ({ name: r.ifaces[0], bus: r.bus }));
  const chosen = port && wifiOpts.some(w => w.name === port) ? port : wifiOpts[0]?.name || '';
  const lan = st.lan;
  // "Pi dağıtır" aralık önerisi: Pi'nin şu anki ağının (modem tarafı, kurulum kabloyla) sonlarına doğru 50 adres.
  const suggest = (() => {
    if (!lan || !IPV4.test(lan.ip) || lan.prefix < 16 || lan.prefix > 28) return null;
    const size = 2 ** (32 - lan.prefix);
    const net = Math.floor(ipNum(lan.ip) / size) * size;
    const n = Math.min(50, Math.floor(size / 4));
    const end = net + size - 6;
    return { start: numIp(end - n + 1), end: numIp(end) };
  })();
  const range = dhcp === 'pi' ? `${rStart || suggest?.start || ''}-${rEnd || suggest?.end || ''}` : '';
  const missing = (dhcp === 'pi' ? st.rep_missing_pi : st.rep_missing_relay) || '';

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy(null);
    await load();
    onChange?.();
  };

  const blocked = st.stage === 'static' || st.stage === 'trial'
    ? "Pi'de sabit adres var — önce DHCP Ayarları'ndan otomatik adrese dönün (Wi-Fi köprüsünde adresi modem verir)"
    : st.pi_dhcp ? "Pi DHCP sunucusu açık — önce DHCP Ayarları'ndan kapatın"
      : st.sat_stage && st.sat_stage !== 'none' ? 'Bu cihaz uydu olarak çalışıyor'
        : st.ap_stage && st.ap_stage !== 'none' ? "Kurulum Wi-Fi'ı açık — önce kapatın"
          : st.home_stage && st.home_stage !== 'none' ? "Ev Wi-Fi'ı açık — önce kapatın"
            : st.wan_stage && st.wan_stage !== 'none' ? 'İnternet kartı (WAN router) açık — önce kapatın'
              : st.bak_stage && st.bak_stage !== 'none' ? 'Yedek hat açık — önce kapatın'
                : !chosen ? 'Boşta Wi-Fi kartı yok'
                  : missing ? `Gerekli bileşenler kurulu değil (${missing}) — Ayarlar → Güncelle`
                    : !lan ? 'Pi modeme kabloyla bağlı değil' : '';
  const [ra, rb] = range.split('-');
  const formErr =
    ssid && new TextEncoder().encode(ssid).length > 32 ? "Üst Wi-Fi'ın adı en çok 32 bayt"
      : pw && (pw.length < 8 || pw.length > 63 || /\\/.test(pw) || pw !== pw.trim() || !/^[ -~]+$/.test(pw)) ? 'Wi-Fi parolası 8-63 karakter; Türkçe harf ve ters bölü (\\) olmaz, başta/sonda boşluk olmaz'
        : dhcp === 'pi' && (!IPV4.test(ra || '') || !IPV4.test(rb || '')) ? 'Adres aralığının başı ve sonu IPv4 olmalı'
          : dhcp === 'pi' && ipNum(ra) > ipNum(rb) ? 'Aralığın başı sonundan büyük olamaz'
            : '';
  const canStart = !blocked && !formErr && !!ssid && !!pw;

  const start = () => {
    if (!window.confirm(
      `Pi "${ssid}" Wi-Fi'ına ${chosen} ile bağlanacak — Wi-Fi köprüsü, aynı ağ (10 dakikalık deneme):\n\n` +
      `• Deneme boyunca ${lan?.iface || 'eth0'} modemde kalır, bu sayfa açık kalır; Pi Wi-Fi'dan yeni bir adres alır\n` +
      "• Kalıcı yapmayı Pi'nin YENİ adresinden yaparsınız (panel yeni adresi gösterir)\n" +
      `• Sonra ${lan?.iface || 'eth0'} kablosunu modemden çıkarıp arkadaki cihaza / anahtara takarsınız: o cihazlar modemle aynı ağda olur\n` +
      `• Adresi ${dhcp === 'pi' ? `Pi verir (${range}; modemin DHCP havuzuyla çakışmamalı)` : 'modem verir (Pi aktarır)'}; DNS Pi-hole'dan geçer\n\n` +
      "Süre içinde 'Kalıcı yap'a basılmazsa Pi eski ayara kendiliğinden döner.\n\nDevam edilsin mi?",
    )) return;
    void act('on', async () => {
      toast.info(`${chosen} "${ssid}" Wi-Fi'ına bağlanıyor — bir dakikaya kadar sürebilir`);
      const r = await postApi('/repeater', { port: chosen, ssid, password: pw, dhcp, ...(dhcp === 'pi' ? { range } : {}) });
      setPw('');
      toast.success(`Pi Wi-Fi'a bağlandı — yeni adres ${String(r?.rep_ip || '').split('/')[0] || '?'}: oradan kalıcı yapın`);
    });
  };
  const repIp = (st.rep_ip || '').split('/')[0];
  const onNewAddr = !!repIp && window.location.hostname === repIp;
  const confirm = () => act('confirm', async () => {
    const r = await postApi('/repeater/confirm', {});
    toast.success(r?.rep_lan_state === 'modem'
      ? `Wi-Fi köprüsü kalıcı — şimdi ${st.rep_lan || 'eth0'} kablosunu modemden çıkarıp arkadaki cihaza takın`
      : 'Wi-Fi köprüsü kalıcı');
  });
  const rollback = () => act('rollback', async () => { await postApi('/repeater/rollback', {}); toast.info('Wi-Fi köprüsü denemesi geri alındı'); });
  const off = (force: boolean) => {
    if (!window.confirm(force
      ? `Wi-Fi köprüsü ZORLA kapatılacak: ${st.rep_lan || 'eth0'} modeme bağlı değilse Pi'ye erişim kesilir (Pi Wi-Fi'dan ayrılır, kablodan adres alamaz). Pi'ye yeniden ulaşmak için kabloyu modeme takmanız gerekir.\n\nDevam edilsin mi?`
      : `Wi-Fi köprüsü kapatılacak: Pi Wi-Fi'dan ayrılır, ${st.rep_lan || 'eth0'} eski profiline (modemden adres) döner.\n\nÖnce ${st.rep_lan || 'eth0'} kablosunu modeme takın — Pi yalnız kabloyla erişilir.\n\nDevam edilsin mi?`,
    )) return;
    void act('off', async () => {
      try {
        const r = await postApi('/repeater/off', force ? { force: true } : {});
        setOffForce(false);
        if (r?.warning) toast.info(`Wi-Fi köprüsü kapatıldı — ${r.warning}`); else toast.info('Wi-Fi köprüsü kapatıldı');
      } catch (e) {
        if (!force && /kablosuyla modeme bağlayın/.test(errText(e, ''))) setOffForce(true);
        throw e;
      }
    });
  };

  const lanState = st.rep_lan_state || '';
  const badge = stage === 'on'
    ? (st.rep_up && lanState === 'active' ? <Badge variant="success">Açık</Badge>
      : st.rep_up ? <Badge variant="warning">Ev tarafı kapalı</Badge> : <Badge variant="warning">Sorun var</Badge>)
    : stage === 'trial' ? <Badge variant="info">Deneme · {fmtLeft(left)}</Badge> : <Badge variant="neutral">Kapalı</Badge>;
  const lanIf = st.rep_lan || lan?.iface || 'eth0';

  return (
    <Panel title={title} icon={icon} actions={badge} className="wn-panel rp-panel"
      subtitle={`Pi Wi-Fi ile modeme bağlanır; ${lanIf}'a takılan cihazlar (bilgisayar, konsol, anahtar) modemle aynı ağda olur, Pi-hole ve VPS yönlendirmesi onlara da uygulanır.`}>
      <div className="hw-body">
        {stage === 'none' && (
          <>
            {blocked && <Alert kind="info">{blocked}</Alert>}
            <dl className="hw-facts">
              <div><dt>Nasıl bağlanır</dt><dd>Pi {chosen || "Wi-Fi kartı"} ile modemin / router'ın Wi-Fi'ına bağlanır; {lanIf}'a takılan cihazlar modemle aynı ağda olur (adresleri ve ağ geçitleri modemin ağından, NAT yok).</dd></div>
              <div><dt>Kurulum</dt><dd>Pi kabloyla modemdeyken denenir; kalıcı yaptıktan sonra {lanIf} kablosu arkadaki cihaza / anahtara takılır ve Pi yerine taşınır.</dd></div>
              <div><dt>Klyrix</dt><dd>Cihazların DNS'i Pi-hole'a çekilir (engelleme, alan adı yönlendirmesi); VPS yönlendirmesi ve cihaz engelleme çalışır. Port yönlendirme modemde, doğrudan cihazın adresine.</dd></div>
            </dl>
            <div className="hw-form">
              <label className="hw-field"><span><EN>Wi-Fi</EN> kartı</span>
                <select value={chosen} onChange={e => setPort(e.target.value)} disabled={!wifiOpts.length}>
                  {wifiOpts.map(w => <option key={w.name} value={w.name}>{w.name} · {w.bus === 'usb' ? 'USB' : 'dahili'}</option>)}
                  {!wifiOpts.length && <option value="">boşta kart yok</option>}
                </select></label>
              <label className="hw-field"><span>Cihazların adresi</span>
                <select value={dhcp} onChange={e => setDhcp(e.target.value as Dhcp)}>
                  <option value="relay">Modem verir (Pi aktarır) — önerilen</option>
                  <option value="pi">Pi verir (modemin ağında ayrı aralık)</option>
                </select></label>
              <label className="hw-field"><span>Üst Wi-Fi'ın adı</span>
                <input className="config-input" value={ssid} maxLength={32} onChange={e => setSsid(e.target.value)} placeholder="modemin Wi-Fi adı" spellCheck={false} /></label>
              <label className="hw-field"><span>Wi-Fi parolası</span>
                <input className="config-input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" /></label>
            </div>
            {dhcp === 'pi' && (
              <>
                <div className="hw-form">
                  <label className="hw-field hw-field-sm"><span>Aralık başı</span>
                    <input className="config-input" value={rStart} onChange={e => setRStart(e.target.value.trim())} placeholder={suggest?.start || '192.168.1.200'} spellCheck={false} /></label>
                  <label className="hw-field hw-field-sm"><span>Aralık sonu</span>
                    <input className="config-input" value={rEnd} onChange={e => setREnd(e.target.value.trim())} placeholder={suggest?.end || '192.168.1.249'} spellCheck={false} /></label>
                </div>
                <span className="dhcp-muted">
                  Aralık modemin ağında ({lan?.network || '—'}) olmalı ve modemin kendi DHCP havuzuyla çakışmamalı (havuz modemin ayarında yazar).
                  Pi her adresi vermeden önce kullanımda mı diye sınar. Modem aktarılan istekleri yanıtlamıyorsa bu kip kullanılır.
                </span>
              </>
            )}
            {formErr && <span className="hw-form-err" role="alert">{formErr}</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={start} disabled={!!busy || !canStart} title={blocked || undefined}>
                {busy === 'on' ? 'Bağlanıyor…' : "Wi-Fi köprüsünü dene (10 dk)"}
              </button>
            </div>
          </>
        )}
        {stage === 'trial' && (
          <>
            <Alert kind={st.rep_up ? 'ok' : 'err'}>
              {st.rep_up
                ? <><strong>Pi "{st.rep_ssid}" Wi-Fi'ına bağlandı</strong> — yeni adresi <span className="rl-mono">{repIp}</span> · kalan {fmtLeft(left)}.</>
                : <>Deneme sürüyor ama üst Wi-Fi bağlı görünmüyor — geri alıp ağ adını / parolayı kontrol edin.</>}
            </Alert>
            <ol className="hw-steps">
              <li>Bu bilgisayarda Pi'nin yeni adresini açın: <a href={`http://${repIp}/#roles`} className="rl-mono">http://{repIp}</a></li>
              <li>Orada <strong>Çalışıyor, kalıcı yap</strong>'a basın (sayfa açılmıyorsa bilgisayar ile Pi aynı ağda değildir — geri alın).</li>
              <li>Sonra {lanIf} kablosunu modemden çıkarıp arkadaki cihaza / anahtara takın.</li>
            </ol>
            {!onNewAddr && <Alert kind="info">Bu sayfa eski adresten açık: kalıcı yapma yalnız yeni adresten (<span className="rl-mono">{repIp}</span>) yapılabilir.</Alert>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={confirm} disabled={!!busy || !onNewAddr || !st.rep_up}
                title={onNewAddr ? undefined : `http://${repIp} adresinden açın`}>{busy === 'confirm' ? 'Onaylanıyor…' : 'Çalışıyor, kalıcı yap'}</button>
              <button className="btn-outline btn-sm" onClick={rollback} disabled={!!busy}>{busy === 'rollback' ? 'Geri alınıyor…' : 'Geri al'}</button>
            </div>
          </>
        )}
        {stage === 'on' && (
          <>
            {!st.rep_up && (
              <Alert kind="err">Üst Wi-Fi'a ({st.rep_ssid}) bağlı değil — ev tarafındaki cihazların interneti yok. Modem açık mı, Pi sinyal alıyor mu?{st.rep_guard_detail ? ` (${st.rep_guard_detail})` : ''}</Alert>
            )}
            {st.rep_up && lanState === 'modem' && (
              <Alert kind="err">{lanIf} kablosu hâlâ modeme bağlı: ev tarafı kapalı (aynı ağda iki yol olmasın diye). Kabloyu modemden çıkarıp arkadaki cihaza / anahtara takın.</Alert>
            )}
            {st.rep_up && lanState === 'no_carrier' && <Alert kind="info">{lanIf}'a cihaz ya da anahtar takılı değil — takılınca ev tarafı kendiliğinden açılır.</Alert>}
            <dl className="hw-facts">
              <div><dt>Üst Wi-Fi</dt><dd>{st.rep_ssid} · <span className="rl-mono">{st.rep_port}</span>{st.rep_signal ? ` · sinyal %${st.rep_signal}` : ''}{st.rep_signal && st.rep_signal < 40 ? " (zayıf — Pi'yi modeme yaklaştırın)" : ''}</dd></div>
              <div><dt>Pi'nin adresi</dt><dd><span className="rl-mono">{repIp || '—'}</span>{st.rep_mdns ? <> · <span className="rl-mono">{st.rep_mdns}</span></> : null} — değişmemesi için modemde Pi'ye adres ayırın</dd></div>
              <div><dt>Ev tarafı ({lanIf})</dt><dd>{LAN_TEXT(lanIf)[lanState] || 'denetleniyor…'}{lanState && st.rep_lan_since && st.now ? ` · ${fmtAgo(Math.max(0, st.now - st.rep_lan_since))}` : ''}</dd></div>
              <div><dt>Cihazlar</dt><dd>{st.rep_clients || 0}</dd></div>
              <div><dt>Adres dağıtımı</dt><dd>{st.rep_dhcp === 'pi' ? <>Pi verir · <span className="rl-mono">{st.rep_range}</span></> : 'Modem verir (Pi aktarır)'} · <EN>DNS</EN> Pi-hole</dd></div>
            </dl>
            {offForce && (
              <Alert kind="err">{lanIf} modeme bağlı görünmüyor: kapatınca Pi'ye erişim kesilir. Önce kabloyu modeme takın; bunu yapamıyorsanız zorla kapatabilirsiniz.</Alert>
            )}
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={() => off(false)} disabled={!!busy}>{busy === 'off' ? 'Kapatılıyor…' : 'Wi-Fi köprüsünü kapat'}</button>
              {offForce && <button className="btn-outline btn-sm" onClick={() => off(true)} disabled={!!busy}>Yine de kapat</button>}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, AlertTriangle, CheckCircle, Info, Trash2 } from 'lucide-react';
import { getApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';

// WAN router rolü (R3): ikinci Ethernet kartı (ör. USB adaptör) internete bağlanır — modem arkasında DHCP, sabit IP ya
// da PPPoE; operatör isterse VLAN (öncelikli), MAC kopyalama, MTU. eth0 / br0 yalnız ev ağı olur (192.168.0.1 kalır).
// Açma 5 dk'lık denemedir; "Kalıcı yap" internet çalışıyorsa ev ağındaki bir cihazdan. Güvenlik duvarı internetten
// gelen her şeyi düşürür (Ev VPN'i ve port yönlendirmeleri hariç). Backend: /api/wan*, net-mode.sh wan, wan.ts.

type WanType = 'dhcp' | 'static' | 'pppoe';
type Proto = 'tcp' | 'udp' | 'both';
interface Forward { id: number; name: string; proto: Proto; ext_from: number; ext_to: number; dest_ip: string; dest_port: number | null; enabled: number }
interface WanStatus {
  supported: boolean; error?: string; satellite?: boolean; now?: number;
  stage?: string; home_stage?: string; sat_stage?: string; pi_dhcp?: boolean; iface?: string; lan_if?: string; client?: string;
  wan_stage?: 'none' | 'trial' | 'on'; wan_trial_ends?: number; wan_port?: string; wan_dev?: string; wan_type?: WanType | '';
  wan_vlan?: string; wan_prio?: string; wan_mac?: string; wan_mtu?: string; wan_user?: string;
  wan_static_addr?: string; wan_static_gw?: string; wan_static_dns?: string;
  wan_ip?: string; wan_gateway?: string; wan_carrier?: boolean; wan_up?: boolean; wan_fw?: boolean;
  wan_guard_result?: string; wan_guard_detail?: string; ppp_ok?: boolean; wan_public?: boolean; forwards?: Forward[];
}
export interface WanEthPort { name: string; bus: 'usb' | 'onboard'; usbSpeedMbps: number | null; carrier: boolean | null }

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>;
const TYPE_TEXT: Record<WanType, string> = { dhcp: 'Otomatik adres (DHCP)', static: 'Sabit IP', pppoe: 'PPPoE' };
const PROTO_TEXT: Record<Proto, string> = { tcp: 'TCP', udp: 'UDP', both: 'TCP + UDP' };
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ipOf = (cidr?: string) => (cidr || '').split('/')[0];
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const fmtLeft = (left: number | null) => (left === null ? '…' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
const portText = (f: Forward) => (f.ext_from === f.ext_to ? `${f.ext_from}` : `${f.ext_from}-${f.ext_to}`);
const busText = (p: WanEthPort) => (p.bus === 'onboard' ? 'dahili' : p.usbSpeedMbps && p.usbSpeedMbps >= 5000 ? 'USB 3' : p.usbSpeedMbps ? 'USB 2' : 'USB');

// Deneme geri sayımı (sunucu saatine göre; HomeWifiPanel'deki gibi).
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

export function WanPanel({ ports, onChange }: { ports: WanEthPort[]; onChange?: () => void }) {
  const [st, setSt] = useState<WanStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bağlantı formu
  const [port, setPort] = useState('');
  const [type, setType] = useState<WanType>('dhcp');
  const [addr, setAddr] = useState('');
  const [gw, setGw] = useState('');
  const [dns, setDns] = useState('');
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [vlan, setVlan] = useState('');
  const [prio, setPrio] = useState('');
  const [mac, setMac] = useState('');
  const [mtu, setMtu] = useState('');
  // Port yönlendirme formu
  const [fName, setFName] = useState('');
  const [fProto, setFProto] = useState<Proto>('tcp');
  const [fExt, setFExt] = useState('');
  const [fIp, setFIp] = useState('');
  const [fPort, setFPort] = useState('');

  const load = useCallback(async () => {
    try { setSt(await getApi<WanStatus>('/wan')); setLoadErr(null); }
    catch (e) { setLoadErr(errText(e, 'durum okunamadı')); }
  }, []);
  const stage = st?.wan_stage || 'none';
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, stage === 'trial' ? 5000 : 30000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, stage]);
  const left = useCountdown(stage === 'trial' ? st?.wan_trial_ends || 0 : 0, st?.now || 0);

  const title = 'İnternet bağlantısı (WAN)';
  const icon = <Globe size={18} style={{ marginRight: 8 }} />;
  if (!st) return loadErr ? <Panel title={title} icon={icon}><p className="rl-muted">Durum okunamadı: {loadErr}</p></Panel> : null;
  if (!st.supported || st.satellite) return null;

  const isStatic = st.stage === 'static';
  const lanPort = st.iface || '';
  const candidates = ports.filter(p => p.name !== lanPort);
  const chosen = port && candidates.some(p => p.name === port) ? port : candidates.find(p => p.carrier)?.name || candidates[0]?.name || '';
  const chosenPort = candidates.find(p => p.name === chosen);
  const lanIp = ipOf(st.client);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy(null);
    await load();
    onChange?.();
  };

  const formErr = !chosen ? '' :
    type === 'static' && addr && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(addr) ? 'Sabit IP adres/önek biçiminde olmalı (ör. 203.0.113.10/24)'
      : type === 'static' && gw && !IPV4.test(gw) ? 'Ağ geçidi geçersiz'
        : type === 'static' && dns && !dns.split(',').every(d => IPV4.test(d.trim())) ? 'DNS adresleri virgülle ayrılmış IPv4 olmalı'
          : type === 'pppoe' && user && !/^[!-~]{1,64}$/.test(user) ? 'Kullanıcı adında boşluk ve Türkçe harf olmaz'
            : type === 'pppoe' && pw && (/\\/.test(pw) || pw !== pw.trim()) ? 'Şifrede ters bölü (\\) olmaz, başta/sonda boşluk olmaz'
              : vlan && !(/^\d{1,4}$/.test(vlan) && Number(vlan) >= 1 && Number(vlan) <= 4094) ? 'VLAN numarası 1-4094'
                : prio && !vlan ? 'Öncelik yalnız VLAN numarasıyla'
                  : mac && !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac) ? 'MAC adresi 00:11:22:33:44:55 biçiminde'
                    : mtu && !(/^\d{3,4}$/.test(mtu) && Number(mtu) >= 576 && Number(mtu) <= (type === 'pppoe' ? 1492 : 9000)) ? `MTU 576-${type === 'pppoe' ? 1492 : 9000}`
                      : '';
  const fieldsOk = type === 'dhcp' || (type === 'static' ? !!addr && !!gw : !!user && !!pw);
  const blocked = !isStatic ? 'Önce sabit adres' : !st.pi_dhcp ? "Önce Pi DHCP'sini açın" : st.home_stage === 'trial' ? "Ev Wi-Fi'ı denemesi sürüyor"
    : !chosen ? 'İkinci Ethernet kartı yok' : chosenPort && chosenPort.carrier === false ? 'Kartta kablo yok'
      : type === 'pppoe' && !st.ppp_ok ? 'PPPoE bileşeni kurulu değil' : '';
  const canStart = !blocked && !formErr && fieldsOk;

  const start = () => {
    if (!window.confirm(
      `İnternet bağlantısı ${chosen} kartına geçecek (5 dakikalık deneme):\n\n` +
      `• Bağlantı: ${TYPE_TEXT[type]}${vlan ? ` · VLAN ${vlan}${prio ? ` (öncelik ${prio})` : ''}` : ''}\n` +
      `• ${lanPort || 'eth0'} yalnız ev ağı olur (${lanIp || '192.168.0.1'} kalır, panel açık kalır)\n` +
      '• İnternetten gelen bağlantılar engellenir (Ev VPN\'i ve port yönlendirmeleri hariç)\n\n' +
      "İnternet çalışıyorsa 5 dakika içinde 'Kalıcı yap'a basın; basılmazsa Pi eski ayara kendiliğinden döner.\n\n" +
      'Devam edilsin mi?',
    )) return;
    void act('on', async () => {
      toast.info('İnternet kartı bağlanıyor — PPPoE bir dakikaya kadar sürebilir');
      const r = await postApi('/wan', {
        port: chosen, type, ...(type === 'static' ? { addr, gw, dns } : {}), ...(type === 'pppoe' ? { user, password: pw } : {}),
        ...(vlan ? { vlan } : {}), ...(vlan && prio ? { prio } : {}), ...(mac ? { mac } : {}), ...(mtu ? { mtu } : {}),
      });
      setPw('');
      toast.success(`İnternet ${chosen} üzerinden (${r?.wan_ip || 'adres alındı'}) — çalışıyorsa kalıcı yapın`);
    });
  };
  const confirm = () => act('confirm', async () => { await postApi('/wan/confirm', {}); toast.success('İnternet kartı kalıcı'); });
  const rollback = () => act('rollback', async () => { await postApi('/wan/rollback', {}); toast.info('İnternet kartı denemesi geri alındı'); });
  const off = () => {
    if (!window.confirm(
      `İnternet kartı (${st.wan_port}) kapatılacak; Pi eski (tek kablolu) düzene döner: internet yeniden ${lanPort || 'eth0'} üzerinden modemden gelir.\n\n` +
      `Modem kablosunu ${lanPort || 'eth0'}'dan internet kartına taşıdıysanız, kabloyu geri takana kadar Pi'nin interneti olmaz (ev ağı ve panel çalışır).\n\nDevam edilsin mi?`,
    )) return;
    void act('off', async () => {
      const r = await postApi('/wan/off', {});
      if (r?.warning) toast.info(`İnternet kartı kapatıldı — ${r.warning}`); else toast.info('İnternet kartı kapatıldı');
    });
  };

  // Port yönlendirme
  const extOk = /^\d{1,5}(-\d{1,5})?$/.test(fExt.trim());
  const fErr = fExt && !extOk ? 'Dış port tek (ör. 8080) ya da aralık (ör. 27015-27030)'
    : fIp && !IPV4.test(fIp.trim()) ? 'Hedef cihaz adresi geçersiz'
      : fPort && (!/^\d{1,5}$/.test(fPort) || fExt.includes('-')) ? 'İç port yalnız tek port için, 1-65535'
        : '';
  const addForward = () => act('fwd-add', async () => {
    const [a, b] = fExt.trim().split('-');
    await postApi('/wan/forwards', {
      name: fName.trim(), proto: fProto, ext_from: Number(a), ext_to: b ? Number(b) : Number(a), dest_ip: fIp.trim(),
      ...(fPort ? { dest_port: Number(fPort) } : {}),
    });
    setFName(''); setFExt(''); setFPort('');
    toast.success('Port yönlendirme eklendi');
  });
  const toggleForward = (f: Forward) => act(`fwd-${f.id}`, async () => { await putApi(`/wan/forwards/${f.id}`, { enabled: !f.enabled }); });
  const removeForward = (f: Forward) => {
    if (!window.confirm(`${PROTO_TEXT[f.proto]} ${portText(f)} → ${f.dest_ip} yönlendirmesi silinsin mi?`)) return;
    void act(`fwd-${f.id}`, async () => { await deleteApi(`/wan/forwards/${f.id}`); });
  };

  const state = stage === 'on'
    ? (st.wan_up && st.wan_fw ? <Badge variant="success">Bağlı</Badge> : <Badge variant="warning">Sorun var</Badge>)
    : stage === 'trial' ? <Badge variant="info">Deneme · {fmtLeft(left)}</Badge> : <Badge variant="neutral">Kapalı</Badge>;
  const forwards = st.forwards || [];
  const typeLine = st.wan_type ? `${TYPE_TEXT[st.wan_type as WanType]}${st.wan_vlan ? ` · VLAN ${st.wan_vlan}${st.wan_prio ? ` (öncelik ${st.wan_prio})` : ''}` : ''}` : '—';

  return (
    <Panel title={title} icon={icon} actions={state} className="wn-panel"
      subtitle="WAN router rolü: modem ya da ONT ikinci Ethernet kartına bağlanır, ev ağı ayrı kartta kalır.">
      <div className="hw-body">
        {stage === 'none' && (
          <>
            {!isStatic && <Alert kind="info">Önce menü → DHCP Ayarları sihirbazında Pi'ye sabit adres verip kalıcı yapın.</Alert>}
            {isStatic && !st.pi_dhcp && <Alert kind="info">Önce DHCP Ayarları'ndan Pi DHCP sunucusunu açın: internet kartına geçince ev ağındaki cihazlara adresi yalnız Pi verir.</Alert>}
            {!candidates.length && <Alert kind="err">İkinci bir Ethernet kartı bulunamadı — USB 3 Gigabit Ethernet adaptörü takın (ör. TP-Link UE300).</Alert>}
            {chosenPort && chosenPort.carrier === false && <Alert kind="err">{chosen} kartında kablo takılı değil — modemi / ONT'yi bu karta bağlayın.</Alert>}
            {type === 'pppoe' && !st.ppp_ok && <Alert kind="err">PPPoE bileşeni (ppp) kurulu değil — panel güncellemesiyle kurulur (Ayarlar → Güncelle).</Alert>}
            <dl className="hw-facts">
              <div><dt>Nasıl bağlanır</dt><dd>Modem / ONT kablosu internet kartına; {lanPort || 'eth0'} ev ağında (anahtar, erişim noktası) kalır.</dd></div>
              <div><dt>Ev ağı</dt><dd>{lanIp || '192.168.0.1'} değişmez; cihazlar adresini Pi'den almayı sürdürür.</dd></div>
              <div><dt>Güvenlik</dt><dd>İnternetten gelen bağlantılar engellenir; yalnız Ev VPN'i ve eklediğiniz port yönlendirmeleri açık. <EN>IPv6</EN> kapalı.</dd></div>
            </dl>
            <div className="hw-form">
              <label className="hw-field">
                <span>İnternet kartı</span>
                <select value={chosen} onChange={e => setPort(e.target.value)} disabled={!candidates.length}>
                  {candidates.map(p => <option key={p.name} value={p.name}>{p.name} · {busText(p)} · {p.carrier ? 'kablo takılı' : p.carrier === false ? 'kablo yok' : '—'}</option>)}
                </select>
              </label>
              <label className="hw-field">
                <span>Bağlantı türü</span>
                <select value={type} onChange={e => setType(e.target.value as WanType)}>
                  <option value="dhcp">Otomatik adres (DHCP) — modem arkası</option>
                  <option value="pppoe">PPPoE — kullanıcı adı + şifre</option>
                  <option value="static">Sabit IP — operatörün verdiği</option>
                </select>
              </label>
              {type === 'static' && (
                <>
                  <label className="hw-field"><span>IP adresi / önek</span>
                    <input className="config-input" value={addr} onChange={e => setAddr(e.target.value)} placeholder="203.0.113.10/24" spellCheck={false} /></label>
                  <label className="hw-field"><span>Ağ geçidi</span>
                    <input className="config-input" value={gw} onChange={e => setGw(e.target.value)} placeholder="203.0.113.1" spellCheck={false} /></label>
                  <label className="hw-field"><span>DNS (isteğe bağlı)</span>
                    <input className="config-input" value={dns} onChange={e => setDns(e.target.value)} placeholder="1.1.1.1,9.9.9.9" spellCheck={false} /></label>
                </>
              )}
              {type === 'pppoe' && (
                <>
                  <label className="hw-field"><span>Kullanıcı adı</span>
                    <input className="config-input" value={user} onChange={e => setUser(e.target.value)} autoComplete="off" spellCheck={false} /></label>
                  <label className="hw-field"><span>Şifre</span>
                    <input className="config-input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" /></label>
                </>
              )}
            </div>
            <details className="wn-adv">
              <summary>Gelişmiş: VLAN, MAC kopyalama, MTU (operatör isterse)</summary>
              <div className="hw-form">
                <label className="hw-field hw-field-sm"><span>VLAN numarası</span>
                  <input className="config-input" inputMode="numeric" value={vlan} onChange={e => setVlan(e.target.value.trim())} placeholder="ör. 35" /></label>
                <label className="hw-field hw-field-sm"><span>VLAN önceliği</span>
                  <select value={prio} onChange={e => setPrio(e.target.value)} disabled={!vlan}>
                    <option value="">—</option>
                    {[0, 1, 2, 3, 4, 5, 6, 7].map(p => <option key={p} value={p}>{p}</option>)}
                  </select></label>
                <label className="hw-field"><span>MAC adresi (kopyala)</span>
                  <input className="config-input" value={mac} onChange={e => setMac(e.target.value.trim())} placeholder="eski router'ın MAC'i" spellCheck={false} /></label>
                <label className="hw-field hw-field-sm"><span><EN>MTU</EN></span>
                  <input className="config-input" inputMode="numeric" value={mtu} onChange={e => setMtu(e.target.value.trim())} placeholder={type === 'pppoe' ? '1492' : '1500'} /></label>
              </div>
              <span className="dhcp-muted">
                VLAN'ı operatör fiber hatlarda ister (numarası sözleşmede ya da operatörün modem ayarında yazar). MAC kopyalama, operatör
                bağlantıyı eski router'ın MAC'ine bağladıysa gerekir. Boş bırakılanlar otomatik.
              </span>
            </details>
            {formErr && <span className="hw-form-err" role="alert">{formErr}</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={start} disabled={!!busy || !canStart} title={blocked || undefined}>
                {busy === 'on' ? 'Bağlanıyor…' : 'İnternet kartına geç (5 dk deneme)'}
              </button>
            </div>
          </>
        )}
        {stage === 'trial' && (
          <>
            <Alert kind={st.wan_up ? 'ok' : 'err'}>
              {st.wan_up
                ? <><strong>İnternet {st.wan_port} üzerinden</strong> — adres {st.wan_ip || '—'}, ağ geçidi {st.wan_gateway || '—'} · kalan {fmtLeft(left)}.</>
                : <>Deneme sürüyor ama internet kartı bağlı görünmüyor — geri alıp ayarları kontrol edin.</>}
            </Alert>
            <ol className="hw-steps">
              <li>Bu cihazda bir web sitesi açın: internet çalışıyor mu?</li>
              <li>Çalışıyorsa <strong>Çalışıyor, kalıcı yap</strong>'a basın. Süre dolarsa Pi eski ayarına kendiliğinden döner.</li>
            </ol>
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={confirm} disabled={!!busy}>{busy === 'confirm' ? 'Onaylanıyor…' : 'Çalışıyor, kalıcı yap'}</button>
              <button className="btn-outline btn-sm" onClick={rollback} disabled={!!busy}>{busy === 'rollback' ? 'Geri alınıyor…' : 'Geri al'}</button>
            </div>
          </>
        )}
        {stage === 'on' && (
          <>
            {!(st.wan_up && st.wan_fw) && (
              <Alert kind="err">
                {!st.wan_fw ? 'Güvenlik duvarı yüklü değil — internet kartı güvenlik için kapatıldı'
                  : st.wan_carrier === false ? `${st.wan_port} kartında kablo yok` : 'İnternet kartı bağlanamadı'}
                {st.wan_guard_detail ? ` (${st.wan_guard_detail})` : ''}. Ev ağı ve panel çalışıyor.
              </Alert>
            )}
            {st.wan_up && !st.wan_public && (
              <Alert kind="info">
                Pi bir modemin arkasında (adres {st.wan_ip}): Ev VPN'i ve port yönlendirmeleri için modemde de aynı portları Pi'nin internet
                kartı adresine ({ipOf(st.wan_ip)}) yönlendirin — ya da modemi köprü (<EN>bridge</EN>) kipine alıp PPPoE'yi Pi'de kurun.
              </Alert>
            )}
            <dl className="hw-facts">
              <div><dt>İnternet kartı</dt><dd className="rl-mono">{st.wan_port}{st.wan_dev && st.wan_dev !== st.wan_port ? ` → ${st.wan_dev}` : ''}</dd></div>
              <div><dt>Bağlantı</dt><dd>{typeLine}{st.wan_user ? ` · ${st.wan_user}` : ''}</dd></div>
              <div><dt>Adres / ağ geçidi</dt><dd className="rl-mono">{st.wan_ip || '—'} · {st.wan_gateway || '—'}</dd></div>
              <div><dt>Ev ağı</dt><dd className="rl-mono">{st.lan_if || lanPort} · {lanIp || '—'}</dd></div>
            </dl>
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={off} disabled={!!busy}>{busy === 'off' ? 'Kapatılıyor…' : 'İnternet kartını kapat'}</button>
            </div>
          </>
        )}

        {stage !== 'none' && (
          <section className="wn-fwd" aria-labelledby="wn-fwd-h">
            <h4 id="wn-fwd-h" className="rl-sub">Port yönlendirme</h4>
            <span className="dhcp-muted">
              İnternetten gelen bağlantıyı ev ağındaki bir cihaza iletir (oyun konsolu, NAS, kamera). Otomatik port açma (UPnP) yoktur;
              portlar yalnız buradan açılır. UDP 51820 Ev VPN'ine ayrılmıştır.
            </span>
            {forwards.length > 0 && (
              <table className="rl-table">
                <thead><tr><th>Ad</th><th>Protokol</th><th className="rl-num">Dış port</th><th>Hedef</th><th>Durum</th><th /></tr></thead>
                <tbody>
                  {forwards.map(f => (
                    <tr key={f.id}>
                      <td data-label="Ad">{f.name || '—'}</td>
                      <td data-label="Protokol">{PROTO_TEXT[f.proto]}</td>
                      <td data-label="Dış port" className="rl-num rl-mono">{portText(f)}</td>
                      <td data-label="Hedef" className="rl-mono">{f.dest_ip}{f.dest_port ? `:${f.dest_port}` : ''}</td>
                      <td data-label="Durum">
                        <button className={`toggle-btn ${f.enabled ? 'toggle-on' : 'toggle-off'}`} onClick={() => toggleForward(f)}
                          disabled={!!busy} aria-label={f.enabled ? 'Kapat' : 'Aç'} title={f.enabled ? 'Açık — kapat' : 'Kapalı — aç'}>
                          <div className="toggle-knob" />
                        </button>
                      </td>
                      <td data-label="">
                        <button className="icon-btn" onClick={() => removeForward(f)} disabled={!!busy} aria-label="Sil" title="Sil"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="hw-form wn-fwd-form">
              <label className="hw-field"><span>Ad (isteğe bağlı)</span>
                <input className="config-input" value={fName} maxLength={40} onChange={e => setFName(e.target.value)} placeholder="ör. PS5" /></label>
              <label className="hw-field hw-field-sm"><span>Protokol</span>
                <select value={fProto} onChange={e => setFProto(e.target.value as Proto)}>
                  <option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP + UDP</option>
                </select></label>
              <label className="hw-field hw-field-sm"><span>Dış port</span>
                <input className="config-input" value={fExt} onChange={e => setFExt(e.target.value.trim())} placeholder="8080 / 27015-27030" /></label>
              <label className="hw-field"><span>Hedef cihaz</span>
                <input className="config-input" value={fIp} onChange={e => setFIp(e.target.value.trim())} placeholder={lanIp ? `${lanIp.split('.').slice(0, 3).join('.')}.50` : '192.168.0.50'} /></label>
              <label className="hw-field hw-field-sm"><span>İç port</span>
                <input className="config-input" value={fPort} onChange={e => setFPort(e.target.value.trim())} placeholder="aynı" disabled={fExt.includes('-')} /></label>
            </div>
            {fErr && <span className="hw-form-err" role="alert">{fErr}</span>}
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" onClick={addForward} disabled={!!busy || !!fErr || !extOk || !IPV4.test(fIp.trim())}>
                {busy === 'fwd-add' ? 'Ekleniyor…' : 'Yönlendirme ekle'}
              </button>
            </div>
            <span className="dhcp-muted">Hedef cihaza DHCP Ayarları'ndan sabit adres (rezervasyon) verin: adresi değişirse yönlendirme boşa düşer.</span>
          </section>
        )}
      </div>
    </Panel>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, Info, Lock, X } from 'lucide-react';
import { getApi, postApi, putApi } from '../hooks/useApi';
import { effectivePoll } from '../prefs';
import { toast } from '../toast';
import { fmtDbTime } from '../time';
import { Badge } from './ui';
import { KIND_TEXT, WIZARD_KEY, portBus, notifyPortsChanged, onPortsChanged, type PortKind, type PortRow, type PortsResp } from '../ports';
import './PortWizard.css';

// Tak-çalıştır (G1.4-A) — Cihaz Rolleri'ndeki bölüm: algılamayı açma / kapatma, bekleyen yeni kartlar ve rol sihirbazı.
// Sihirbaz sıralı ve adım adım: ① kart bilgisi + uyarılar (okundu onayı) ② rol seçenekleri — her biri ön koşuluyla,
// karşılanmayan soluk + "önce …". HİÇBİR ROL KENDİLİĞİNDEN ATANMAZ: seçim yalnız mevcut onaylı paneli (İnternet bağlantısı
// (WAN) / Yedek hat) kart seçili açar; ayar orada deneme + "Kalıcı yap" ile uygulanır. IoT portu / DMZ bölgeler gelince.
// Backend: /api/ports (portWatch.ts).

export type PortPick = { role: 'wan' | 'failover'; port: string; kind: 'eth' | 'usb' | 'wifi' };
type OptionId = 'wan' | 'failover' | 'iot' | 'ignore';
interface Option { id: OptionId; ok: boolean; why: string; bakKind?: 'eth' | 'usb' | 'wifi' }
interface Card {
  name: string; kind: PortKind; driver: string; bus: 'usb' | 'onboard'; usbSpeedMbps: number | null;
  speedMbps: number | null; carrier: boolean | null; mac: string;
}
interface Detail {
  // idFromUsb: kartın adresi her takışta değişir, kimlik USB aygıtından türetildi (eski arka uçta yok).
  port: PortRow; card: Card | null; idFromUsb?: boolean; net: { conn: string; ipv4: string[]; defaultRoute: boolean };
  role: string; warnings: { kind: 'warn' | 'info'; text: string }[]; options: Option[];
}

// Banttan gelen kart (ports.ts openPortWizard): okuma ve silme ayrı — ilk durum okunur, bölüm yerleşince silinir
// (geliştirme kipindeki çift çağrı kartı kaybetmesin). Sayfa açıkken aynı adlı olayla gelir.
function peekPortWizard(): string {
  try { return sessionStorage.getItem(WIZARD_KEY) || ''; } catch { return ''; }
}
function clearPortWizard(): void {
  try { sessionStorage.removeItem(WIZARD_KEY); } catch { /* depolama yok */ }
}
function onPortWizard(cb: (mac: string) => void): () => void {
  const h = (e: Event) => { clearPortWizard(); cb((e as CustomEvent<string>).detail); };
  window.addEventListener(WIZARD_KEY, h);
  return () => window.removeEventListener(WIZARD_KEY, h);
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const busLong = (c: { bus: string; usbSpeedMbps: number | null }) =>
  c.bus !== 'usb' ? 'Dahili' : c.usbSpeedMbps === null ? 'USB' : c.usbSpeedMbps >= 5000 ? `USB 3 · ${c.usbSpeedMbps / 1000} Gbps` : `USB 2 · ${c.usbSpeedMbps} Mbps`;
const speedText = (mbps: number | null) => (mbps ? (mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`) : '—');
const OPTION_TEXT: Record<OptionId, string> = {
  wan: 'İnternet kartı (WAN router)', failover: 'Yedek hat', iot: 'IoT portu / DMZ', ignore: 'Yoksay',
};

type StepState = 'done' | 'active' | 'todo';
function Step({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  return (
    <div className={`dhcp-step dhcp-step-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
      <div className="dhcp-step-head">
        <span className="dhcp-step-num">{state === 'done' ? <Check size={12} /> : n}</span>
        <strong>{title}</strong>
      </div>
      {children && <div className="dhcp-step-body">{children}</div>}
    </div>
  );
}
const Locked = ({ text }: { text: string }) => <span className="dhcp-step-lock"><Lock size={12} /> {text}</span>;
function Note({ kind, children }: { kind: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'warn' ? 'err' : 'ok'} pw-note`}>
      {kind === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

// Detay ucunun hata metni (409 kapalı, 404 kart yok) gösterilsin diye getApi yerine.
async function getDetail(mac: string): Promise<Detail> {
  const r = await fetch(`/api/ports/${encodeURIComponent(mac)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j as Detail;
}

export function PortWizard({ mac, onClose, onPick }: { mac: string; onClose: () => void; onPick: (p: PortPick) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState('');
  const box = useRef<HTMLElement>(null);
  // Banttan açılınca sayfa aşağıdaysa sihirbaz görünür alana gelir.
  useEffect(() => { box.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, []);

  const load = useCallback(async () => {
    try { setD(await getDetail(mac)); setErr(''); } catch (e) { setErr(errText(e, 'kart bilgisi okunamadı')); }
  }, [mac]);
  // Kablo / hız değişebilir (kart yeni takıldı): açıkken 10 sn'de bir yenilenir (Ayarlar → Performans'a uyar).
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const ms = effectivePoll(10000);
    const id = ms ? setInterval(() => { void load(); }, ms) : undefined;
    return () => { clearTimeout(first); if (id) clearInterval(id); };
  }, [load]);

  const card = d?.card || null;
  const name = card?.name || d?.port.name || mac;
  const step1: StepState = ack && card ? 'done' : 'active';
  const step2: StepState = step1 === 'done' ? 'active' : 'todo';

  const choose = async (o: Option) => {
    if (!card) return;
    setBusy(o.id);
    try {
      if (o.id === 'ignore') {
        await postApi(`/ports/${encodeURIComponent(mac)}/dismiss`, {});
        toast.info(`${name} yoksayıldı — kart bugünkü gibi davranır`);
        notifyPortsChanged();
        onClose();
        return;
      }
      await postApi(`/ports/${encodeURIComponent(mac)}/known`, {});
      notifyPortsChanged();
      onPick({ role: o.id === 'wan' ? 'wan' : 'failover', port: card.name, kind: o.bakKind || 'eth' });
    } catch (e) {
      toast.error(errText(e, 'İşlem başarısız'));
    } finally {
      setBusy('');
    }
  };

  const desc = (o: Option): ReactNode => {
    if (o.id === 'wan') {
      return card?.kind === 'wifi'
        ? <>Repeater (ayrı ağ): Pi bu kartla üst Wi-Fi'a bağlanır, ev ağı kablolu kartta kalır. İnternet bağlantısı (WAN) paneli bu kart seçili açılır; 5 dk deneme, çalışıyorsa "Kalıcı yap".</>
        : <>Modem / ONT bu karta takılır, ev ağı ayrı kartta kalır. İnternet bağlantısı (WAN) paneli bu kart seçili açılır; bağlantı türünü girip 5 dk denemeyi başlatırsınız, çalışıyorsa "Kalıcı yap".</>;
    }
    if (o.id === 'failover') {
      const what = o.bakKind === 'usb' ? 'USB 4G modem / telefonun USB paylaşımı' : o.bakKind === 'wifi' ? "telefon hotspot'u (bu Wi-Fi kartıyla)" : 'ikinci modem / 4G router / ikinci operatör (bu karttan)';
      return <>Ana hat düşünce Pi {what} üzerinden çıkar. Yedek hat paneli bu tür seçili açılır; kurulum hemen sınanır, olmazsa geri alınır.</>;
    }
    if (o.id === 'iot') return <>Kartı ayrı, yalıtılmış bir bölge yapmak (akıllı ev cihazları, sunucu). Bölgeler (VLAN / segment) gelince açılır.</>;
    return <>Bant ve liste bu kartı bir daha göstermez; kart bugünkü gibi davranır. Cihaz Rolleri'nden yine rol verilebilir.</>;
  };

  return (
    <section ref={box} className="dhcp-wizard pw-wizard" aria-labelledby="pw-title">
      <div className="pw-wizard-head">
        <div id="pw-title" className="dhcp-wizard-title">Yeni ağ kartı: <span className="rl-mono">{name}</span></div>
        <button className="icon-btn" onClick={onClose} title="Sihirbazı kapat (kart bekleyen kalır)" aria-label="Sihirbazı kapat"><X size={14} /></button>
      </div>
      <span className="dhcp-muted">
        Rol kendiliğinden atanmaz: seçtiğiniz panel kart seçili açılır, ayar orada deneme + "Kalıcı yap" ile uygulanır. Seçene kadar Pi'de hiçbir şey değişmez.
      </span>
      {err && <Note kind="warn">{err}</Note>}
      {!d && !err && <span className="dhcp-muted">Kart bilgisi okunuyor…</span>}
      {d && (
        <>
          <Step n={1} title="Kart bilgisi ve uyarılar" state={step1}>
            {card ? (
              <dl className="hw-facts pw-facts">
                <div><dt>Tür</dt><dd>{KIND_TEXT[card.kind]}</dd></div>
                <div><dt>Bağlantı</dt><dd>{busLong(card)}</dd></div>
                <div><dt>Sürücü</dt><dd className="rl-mono">{card.driver || '—'}</dd></div>
                {card.kind !== 'wifi' && <div><dt>Hız / kablo</dt><dd>{speedText(card.speedMbps)} · {card.carrier === true ? 'kablo takılı' : card.carrier === false ? 'kablo takılı değil' : 'kablo durumu bilinmiyor'}</dd></div>}
                {d.idFromUsb
                  ? <div><dt>Kimlik</dt><dd><span className="rl-mono">{d.port.mac}</span> · USB aygıtından (kartın adresi her takışta değişir)</dd></div>
                  : <div><dt>Kalıcı MAC</dt><dd className="rl-mono">{d.port.mac}</dd></div>}
                <div><dt>İlk görülme</dt><dd>{fmtDbTime(d.port.firstSeen)}</dd></div>
                {(d.net.conn || d.net.ipv4.length > 0) && (
                  <div><dt>Şu anki bağlantı</dt><dd className="rl-mono">{d.net.conn || 'profil yok'}{d.net.ipv4.length ? ` · ${d.net.ipv4.join(', ')}` : ''}{d.net.defaultRoute ? ' · varsayılan rota' : ''}</dd></div>
                )}
              </dl>
            ) : null}
            {d.warnings.map((w, i) => <Note key={i} kind={w.kind}>{w.text}</Note>)}
            {card && !d.warnings.length && <span className="dhcp-muted">Uyarı yok.</span>}
            {step1 !== 'done' && (
              <div className="panel-auth-actions">
                {card
                  ? <button className="btn-primary btn-sm btn-on" onClick={() => setAck(true)}>Okudum, rol seçeneklerine geç</button>
                  : <button className="btn-outline btn-sm" onClick={() => { void load(); }}>Yeniden denetle</button>}
              </div>
            )}
          </Step>
          <Step n={2} title="Rol seç" state={step2}>
            {step2 === 'todo' ? <Locked text={card ? 'Önce 1. adım: kart bilgisini ve uyarıları okuyun' : 'Önce 1. adım: kartı takın'} /> : (
              <div className="pw-options">
                {d.options.map(o => (
                  <div key={o.id} className={`dhcp-option pw-opt${o.ok ? '' : ' pw-opt-locked'}`} data-opt={o.id}>
                    <strong>{OPTION_TEXT[o.id]}</strong>
                    <span className="pw-opt-desc">{desc(o)}</span>
                    {!o.ok ? <Locked text={o.why} /> : (
                      <div className="panel-auth-actions">
                        {o.id === 'ignore'
                          ? <button className="btn-outline btn-sm btn-off" onClick={() => { void choose(o); }} disabled={!!busy}>{busy === 'ignore' ? 'Yoksayılıyor…' : 'Yoksay'}</button>
                          : <button className="btn-primary btn-sm btn-on" onClick={() => { void choose(o); }} disabled={!!busy}>
                              {busy === o.id ? 'Açılıyor…' : o.id === 'wan' ? 'İnternet bağlantısı panelinde aç' : 'Yedek hat panelinde aç'}
                            </button>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Step>
        </>
      )}
    </section>
  );
}

// Cihaz Rolleri → "Tak-çalıştır algılama": aç / kapat, bekleyen kartlar, sihirbaz. Uyduda / eski arka uçta gizli.
export function PortWatchCard({ onPick }: { onPick: (p: PortPick) => void }) {
  const [data, setData] = useState<PortsResp | null>(null);
  const [busy, setBusy] = useState('');
  const [wizard, setWizard] = useState<string>(peekPortWizard);

  const load = useCallback(async () => {
    setData(await getApi<PortsResp>('/ports').catch(() => null));
  }, []);
  const enabled = !!data?.enabled;
  useEffect(() => {
    clearPortWizard();
    const first = setTimeout(() => { void load(); }, 0);
    const ms = enabled ? effectivePoll(15000) : null;
    const id = ms ? setInterval(() => { void load(); }, ms) : undefined;
    const offChanged = onPortsChanged(() => { void load(); });
    const offWizard = onPortWizard(mac => setWizard(mac));
    return () => { clearTimeout(first); if (id) clearInterval(id); offChanged(); offWizard(); };
  }, [load, enabled]);

  if (!data?.supported) return null;
  const pending = enabled ? data.pending : [];

  const toggle = async (on: boolean) => {
    setBusy('toggle');
    try {
      const r = await putApi('/ports/settings', { enabled: on });
      toast.success(!on ? 'Tak-çalıştır algılama kapatıldı'
        : `Tak-çalıştır algılama açıldı — ${r?.baseline ? `takılı ${r.baseline} kart bilinen sayıldı` : 'bilinen sayılacak yeni kart yok'}`);
      if (!on) setWizard('');
    } catch (e) {
      toast.error(errText(e, 'Ayar değiştirilemedi'));
    }
    setBusy('');
    notifyPortsChanged();
  };
  const dismiss = async (p: PortRow) => {
    setBusy(p.mac);
    try {
      await postApi(`/ports/${encodeURIComponent(p.mac)}/dismiss`, {});
      toast.info(`${p.name} yoksayıldı`);
      if (wizard === p.mac) setWizard('');
    } catch (e) {
      toast.error(errText(e, 'Yoksayılamadı'));
    }
    setBusy('');
    notifyPortsChanged();
  };

  return (
    <section className="pw-card" aria-labelledby="pw-card-h">
      <div className="pw-card-head">
        <h4 id="pw-card-h" className="rl-sub">Tak-çalıştır algılama</h4>
        <Badge variant={enabled ? 'success' : 'neutral'}>{enabled ? 'Açık' : 'Kapalı'}</Badge>
        {pending.length > 0 && <Badge variant="info">{pending.length} yeni kart</Badge>}
        <span className="pw-card-act">
          {enabled
            ? <button className="btn-outline btn-sm pb-off" onClick={() => { void toggle(false); }} disabled={!!busy}>{busy === 'toggle' ? 'Kapatılıyor…' : 'Algılamayı kapat'}</button>
            : <button className="btn-primary btn-sm pb-on" onClick={() => { void toggle(true); }} disabled={!!busy}>{busy === 'toggle' ? 'Açılıyor…' : 'Algılamayı aç'}</button>}
        </span>
      </div>
      <p className="pw-card-desc">
        Yeni takılan ağ kartını (USB Ethernet, 4G modem / telefon, USB Wi-Fi) bulur ve rolünü sorar. Yalnız algılar: rol kendiliğinden
        atanmaz, ağ ayarı değişmez. Açıkken 10 sn'de bir kart listesi okunur; açarken takılı kartlar bilinen sayılır (bildirim gelmez).
      </p>
      {enabled && pending.length > 0 && (
        <ul className="pw-list" aria-label="Bekleyen yeni kartlar">
          {pending.map(p => (
            <li key={p.mac} className="pw-item">
              <span className="pw-item-main">
                <strong className="rl-mono">{p.name}</strong>
                <span className="pw-item-meta">{KIND_TEXT[p.kind]} · {portBus(p)}{p.driver ? ` · ${p.driver}` : ''} · {fmtDbTime(p.firstSeen, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                {!p.present && <Badge variant="neutral">takılı değil</Badge>}
              </span>
              <span className="panel-auth-actions">
                <button className="btn-outline btn-sm" onClick={() => setWizard(p.mac)} disabled={!!busy}>Rolünü seç</button>
                <button className="btn-outline btn-sm pb-off" onClick={() => { void dismiss(p); }} disabled={!!busy}>Yoksay</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {enabled && !pending.length && <p className="pw-card-desc">Bekleyen yeni kart yok.</p>}
      {enabled && wizard && (
        <PortWizard key={wizard} mac={wizard} onClose={() => setWizard('')} onPick={p => { setWizard(''); onPick(p); }} />
      )}
    </section>
  );
}

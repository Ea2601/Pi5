import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, FileSearch, Info, Loader2, Lock, Play, RefreshCw, Scale, Square, Trash2 } from 'lucide-react';
import { getApi, postApi, deleteApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge, Select, SelectOption } from './ui';
import { PCAP_TARGET_KEY, peekLink, clearLink } from '../pcapLink';
import './PcapTool.css';

// Ağ Araçları → Paket Kaydı (backend pcap.ts, /api/pcap): seçilen cihazın 10 / 30 / 60 sn trafiği .pcap (Wireshark) olarak
// indirilir. Yalnız panel koruması kalıcı açıkken; yasal uyarı onayı zorunlu; varsayılan yalnız başlıklar (128 B), tam paket ek
// uyarıyla. Dosya indirilince ya da en geç 10 dk sonra Pi'den silinir. Ayrı parça (React.lazy): ana paket büyümesin.

type Mode = 'headers' | 'full';
interface Target { key: string; mac: string; ip: string; name: string; iface: string; vpn: boolean }
interface Job {
  id: string; state: 'running' | 'done' | 'failed';
  target: { label: string; mac: string; ip: string; iface: string; vpn: boolean };
  seconds: number; mode: Mode; startedAt: number; expiresAt: number; maxBytes: number;
  bytes: number; packets: number | null; dropped: number | null; capped: boolean; note: string; error: string;
}
interface Status {
  supported: boolean; panelAuth: boolean; tcpdump: boolean; profile: 'lite' | 'standard' | null; maxBytes: number;
  seconds: number[]; keepSeconds: number; now: number; job: Job | null;
}

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const MODE_TEXT: Record<Mode, string> = { headers: 'yalnız başlıklar', full: 'tam paket' };
const targetLine = (t: Job['target']) => [t.ip, t.mac, t.vpn ? "Ev VPN'i" : t.iface].filter(Boolean).join(' · ');

export function PcapTool() {
  const [st, setSt] = useState<Status | null>(null);
  const [recvAt, setRecvAt] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const [err, setErr] = useState('');
  const [targets, setTargets] = useState<Target[] | null>(null);
  // Cihaz Yönetimi'ndeki kısayoldan gelen cihaz (tek seferlik)
  const [want] = useState(() => peekLink(PCAP_TARGET_KEY).toLowerCase());
  const [target, setTarget] = useState(want);
  useEffect(() => { clearLink(PCAP_TARGET_KEY); }, []);
  const [seconds, setSeconds] = useState(30);
  const [mode, setMode] = useState<Mode>('headers');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  // Panel koruması kapalıyken bandın durumu (PanelAuthBanner ile aynı kaynak): 'legacy' = eski yöntemle korunuyor, bant yok.
  const [authState, setAuthState] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getApi<Status>('/pcap/status');
      setSt(s);
      setRecvAt(Date.now());
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Durum okunamadı');
    }
  }, []);
  const loadTargets = useCallback(async () => {
    try {
      setTargets((await getApi<{ targets: Target[] }>('/pcap/targets')).targets || []);
    } catch {
      setTargets([]);
    }
  }, []);

  const job = st?.job ?? null;
  const running = job?.state === 'running';
  const hasJob = !!job;
  // Kayıt sürerken saniyede bir, bekleyen kayıt varken 5 sn'de bir (indirme / 10 dk silme başka sekmede olabilir).
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const ms = running ? 1000 : hasJob ? 5000 : 0;
    const id = ms ? setInterval(() => { void load(); }, ms) : undefined;
    return () => { clearTimeout(first); if (id) clearInterval(id); };
  }, [load, running, hasJob]);
  useEffect(() => {
    const first = setTimeout(() => { void loadTargets(); }, 0);
    return () => clearTimeout(first);
  }, [loadTargets]);
  // Geri sayım / ilerleme: sunucu saatine göre (yanıttan bu yana geçen süre eklenir)
  useEffect(() => {
    if (!hasJob) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasJob]);
  const serverNow = st ? st.now + Math.max(0, (nowMs || recvAt) - recvAt) / 1000 : 0;
  const needAuth = !!st && st.supported && !st.panelAuth;
  useEffect(() => {
    if (!needAuth) return;
    let live = true;
    getApi<{ state?: string }>('/panel-auth/status').then(r => { if (live) setAuthState(r.state || null); }, () => { if (live) setAuthState(null); });
    return () => { live = false; };
  }, [needAuth]);
  // Bant içerik alanının dışında (masaüstünde pencere kaymaz): banda kaydırılır ve ilk alanı / düğmesi odaklanır.
  const goBanner = () => {
    const b = document.querySelector<HTMLElement>('.panel-auth-banner');
    if (!b) { toast.info('Panel koruması bandı görünmüyor — sayfayı yenileyin'); return; }
    b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    b.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
  };

  const chosen = targets?.find(t => t.key === target) || null;
  const canStart = !!st?.panelAuth && !!st.tcpdump && !!chosen && consent && !busy && (!job || job.state === 'failed');

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await postApi('/pcap/start', { ...(chosen.vpn ? { ip: chosen.ip } : { mac: chosen.mac }), seconds, mode, consent: true });
      setConsent(false);
      toast.success(`Kayıt başladı — ${seconds} sn`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kayıt başlatılamadı');
    }
    await load();
    setBusy(false);
  };

  const remove = async () => {
    if (!job) return;
    const q = job.state === 'running'
      ? 'Kayıt durdurulup silinsin mi? Şu ana kadar kaydedilenler de silinir.'
      : "Kayıt Pi'den silinsin mi?";
    if (!confirm(q)) return;
    setBusy(true);
    try {
      await deleteApi(`/pcap/${job.id}`);
      toast.info(job.state === 'running' ? 'Kayıt durduruldu ve silindi' : 'Kayıt silindi');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Silinemedi');
    }
    await load();
    setBusy(false);
  };

  // İndirme: dosya tarayıcıya alınır, tamamı gönderilince Pi'deki kopya silinir (tek indirme).
  const download = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/pcap/download/${job.id}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'klyrix-paket-kaydi.pcap';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast.success("Kayıt indirildi — Pi'deki kopya silindi");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İndirilemedi');
    }
    await load();
    setBusy(false);
  };

  const body = () => {
    if (err === 'HTTP 409') {
      return <p className="pk-note"><Info size={15} /><span>Bu cihaz mesh uydusu — paket kaydı ana cihazdadır.</span></p>;
    }
    if (!st) {
      return err
        ? <p className="pk-note pk-note-bad"><AlertTriangle size={15} /><span>Durum okunamadı ({err}).</span></p>
        : <div className="pk-loading"><Loader2 size={20} className="spin" /></div>;
    }
    if (!st.supported) return <p className="pk-note"><Info size={15} /><span>Paket kaydı yalnız Pi üzerinde çalışır.</span></p>;
    if (!st.panelAuth) {
      // Eski yöntem (nginx snippets/pi5-auth.conf): panel bu korumayı yönetemez, üstte bant da yoktur.
      if (authState === 'legacy') {
        return (
          <div className="pk-lock">
            <Lock size={18} />
            <div>
              <strong>Panel koruması gerekli</strong>
              <p>
                Paket kaydı yalnız panelden yönetilen panel koruması kalıcı açıkken kullanılabilir. Bu panel eski yöntemle
                (nginx snippets/pi5-auth.conf) korunuyor; panel bu korumayı denetleyemez. Dosyadaki eski auth_basic satırlarını
                kaldırın, sonra sayfanın üstünde açılan banttan şifreyi belirleyip korumayı açın ve "Kalıcı yap"a basın.
              </p>
            </div>
          </div>
        );
      }
      return (
        <div className="pk-lock">
          <Lock size={18} />
          <div>
            <strong>Panel koruması gerekli</strong>
            <p>
              Paket kaydı yalnız panel koruması (panel şifresi) kalıcı açıkken kullanılabilir: başkasının trafiğini kaydetmek
              hassastır ve şifresiz panele ev ağındaki herkes ulaşabilir. Sayfanın üstündeki banttan şifreyi belirleyip korumayı
              açın, sonra "Kalıcı yap"a basın.
            </p>
            {authState !== 'unsupported' && authState !== 'error' && (
              <button className="btn-primary btn-sm btn-on" onClick={goBanner}>
                <Lock size={14} /> Panel korumasını aç
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <>
        {!st.tcpdump && (
          <p className="pk-note pk-note-warn">
            <AlertTriangle size={15} /><span>Kayıt aracı (tcpdump) kurulu değil — panel güncellemesi kurar: Ayarlar → Güncelle.</span>
          </p>
        )}
        {job && <JobCard job={job} serverNow={serverNow} busy={busy} onDownload={download} onRemove={remove} />}
        {(!job || job.state === 'failed') && (
          <div className="pk-form">
            <section className="pk-step">
              <h4><span className="pk-num">1</span> Cihaz</h4>
              <div className="pk-row">
                <Select className="config-input pk-select" value={target} onChange={e => setTarget(e.target.value)} columns={['text', 'mono', 'mono']}
                  aria-label="Kaydı alınacak cihaz">
                  <option value="">{targets === null ? 'Cihazlar okunuyor…' : 'Cihaz seçin…'}</option>
                  {(targets || []).map(t => (
                    <SelectOption key={t.key} value={t.key} cols={[t.name || 'Adsız cihaz', t.ip, t.vpn ? "Ev VPN'i" : t.mac]} />
                  ))}
                </Select>
                <button className="btn-outline btn-sm" onClick={() => { void loadTargets(); }} title="Listeyi yenile" aria-label="Cihaz listesini yenile">
                  <RefreshCw size={14} />
                </button>
              </div>
              {want && target === want && targets !== null && !targets.some(t => t.key === want) && (
                <p className="pk-help pk-bad">Cihaz Yönetimi'nden seçilen cihaz ({want}) şu an listede yok: ağda görünmüyor ya da kaydı alınamaz (modem, Pi, internet tarafı).</p>
              )}
              {targets !== null && targets.length === 0 && <p className="pk-help">Şu an ağda kaydı alınabilecek cihaz görünmüyor.</p>}
            </section>

            <section className="pk-step">
              <h4><span className="pk-num">2</span> Süre ve kapsam</h4>
              <div className="pk-seg" role="radiogroup" aria-label="Süre">
                {(st.seconds || [10, 30, 60]).map(s => (
                  <button key={s} role="radio" aria-checked={seconds === s} className={`pk-seg-btn${seconds === s ? ' pk-seg-on' : ''}`} onClick={() => setSeconds(s)}>
                    {s} sn
                  </button>
                ))}
              </div>
              <div className="pk-modes" role="radiogroup" aria-label="Kayıt kapsamı">
                <label className={`pk-mode${mode === 'headers' ? ' pk-mode-on' : ''}`}>
                  <input type="radio" name="pk-mode" checked={mode === 'headers'} onChange={() => setMode('headers')} />
                  <span className="pk-mode-title">Yalnız başlıklar <Badge variant="success">önerilen</Badge></span>
                  <span className="pk-mode-desc">Her paketin ilk 128 baytı: adresler, portlar, protokol ve zamanlama. Sayfa ve mesaj içeriği kaydedilmez.</span>
                </label>
                <label className={`pk-mode${mode === 'full' ? ' pk-mode-on' : ''}`}>
                  <input type="radio" name="pk-mode" checked={mode === 'full'} onChange={() => setMode('full')} />
                  <span className="pk-mode-title">Tam paket</span>
                  <span className="pk-mode-desc">Paketlerin tamamı. Şifrelenmemiş içerik dosyada okunabilir.</span>
                </label>
              </div>
              {mode === 'full' && (
                <p className="pk-note pk-note-warn">
                  <AlertTriangle size={15} />
                  <span>
                    Tam paket kipinde şifrelenmemiş trafiğin içeriği (HTTP sayfaları, düz metin parolalar, DNS sorguları) dosyaya olduğu
                    gibi yazılır. Yalnız gerçekten gerekiyorsa seçin ve dosyayı kimseyle paylaşmayın.
                  </span>
                </p>
              )}
              <p className="pk-help">Dosya en çok {fmtSize(st.maxBytes)} (Pi'nin belleğine göre); dolarsa kayıt erken biter.</p>
            </section>

            <section className="pk-step">
              <h4><span className="pk-num">3</span> Yasal uyarı</h4>
              <div className="pk-legal">
                <Scale size={16} />
                <p>
                  Bu kayıt seçilen cihazı kullanan kişinin internet trafiğini içerir ve kişisel veridir (6698 sayılı KVKK). Yalnız kendi
                  cihazınızın ya da açık izni olan kişinin trafiğini, arıza teşhisi için kaydedin. Kayıt Bildirimler'e denetim izi olarak
                  yazılır (kim, hangi cihaz, süre, kapsam); dosya indirilince ya da en geç {Math.round((st.keepSeconds || 600) / 60)} dakika
                  sonra Pi'den silinir.
                </p>
              </div>
              <label className="pk-check">
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                <span>Okudum; bu cihazın trafiğini kaydetmeye yetkiliyim.</span>
              </label>
            </section>

            <div className="pk-actions">
              <button className="btn-primary btn-sm btn-on" onClick={start} disabled={!canStart}>
                {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Kaydı başlat ({seconds} sn)
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="pk">
      <Panel title="Paket Kaydı" icon={<FileSearch size={18} style={{ marginRight: 8 }} />}
        subtitle="Seçilen cihazın 10, 30 ya da 60 saniyelik trafiği Wireshark'ta açılan .pcap dosyası olarak indirilir.">
        {body()}
        <p className="pk-note pk-scope">
          <Info size={15} />
          <span>
            Cihazın tüm trafiği ancak Pi o cihazın ağ geçidiyse görünür; değilse yalnız Pi'ye giden trafik (DNS, panel) kaydedilir.
            Ev Wi-Fi köprüsünde cihazdan cihaza (köprü içi) trafik görünmez.
          </span>
        </p>
      </Panel>
    </div>
  );
}

function JobCard({ job, serverNow, busy, onDownload, onRemove }: {
  job: Job; serverNow: number; busy: boolean; onDownload: () => void; onRemove: () => void;
}) {
  const elapsed = Math.min(job.seconds, Math.max(0, Math.floor(serverNow - job.startedAt)));
  const left = Math.max(0, Math.floor(job.expiresAt - serverNow));
  return (
    <div className={`pk-job pk-job-${job.state}`}>
      <div className="pk-job-head">
        {job.state === 'running' && <Badge variant="info">Kaydediliyor</Badge>}
        {job.state === 'done' && <Badge variant="success">Hazır</Badge>}
        {job.state === 'failed' && <Badge variant="error">Başarısız</Badge>}
        <strong>{job.target.label}</strong>
        <span className="pk-mono">{targetLine(job.target)}</span>
      </div>
      <div className="pk-job-meta">{job.seconds} sn · {MODE_TEXT[job.mode]}</div>
      {job.state === 'running' && (
        <>
          <div className="pk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={job.seconds} aria-valuenow={elapsed}>
            <div className="pk-bar-fill" style={{ width: `${Math.round((elapsed / job.seconds) * 100)}%` }} />
          </div>
          <div className="pk-job-meta">{elapsed} / {job.seconds} sn · {fmtSize(job.bytes)}</div>
        </>
      )}
      {job.state === 'done' && (
        <>
          <div className="pk-job-meta">
            {fmtSize(job.bytes)}{job.packets !== null ? ` · ${job.packets} paket` : ''}
            {job.dropped ? ` · ${job.dropped} paket yoğunluktan kaydedilemedi` : ''}
          </div>
          {job.note && <p className="pk-help pk-warn">{job.note}{job.capped ? ` (en çok ${fmtSize(job.maxBytes)})` : ''}</p>}
          {job.packets === 0 && (
            <p className="pk-help pk-warn">Kayıtta paket yok: cihaz bu sürede trafik üretmedi ya da trafiği Pi'den geçmiyor.</p>
          )}
          <p className="pk-help">Pi'den silinmesine kalan: {mmss(left)} — indirince hemen silinir.</p>
        </>
      )}
      {job.state === 'failed' && <p className="pk-help pk-bad">{job.error}</p>}
      <div className="pk-actions">
        {job.state === 'done' && (
          <button className="btn-primary btn-sm btn-on" onClick={onDownload} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />} İndir (.pcap)
          </button>
        )}
        <button className="btn-outline btn-sm btn-off" onClick={onRemove} disabled={busy}>
          {job.state === 'running' ? <><Square size={13} /> Durdur ve sil</> : <><Trash2 size={13} /> Sil</>}
        </button>
      </div>
    </div>
  );
}

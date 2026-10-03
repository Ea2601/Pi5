import { useState } from 'react';
import type { FormEvent } from 'react';
import { Cloud, Loader2, AlertTriangle, ShieldCheck, Eye, EyeOff, KeyRound, LogOut, Pause, Play, Check, X, Clock, Info } from 'lucide-react';
import { useApi, postApi, putApi } from '../hooks/useApi';
import { Panel, Select } from './ui';
import { relativeTime } from '../alerts';
import { toast } from '../toast';
import './FleetPanel.css';

// Filo (G4.1; backend fleet.ts, /api/fleet): cihazı yönetilen bulut denetleyicisine bağlar. Panel internete açılmaz — cihaz
// yalnız dışa doğru bağlanır (yoklama). Buluttan yalnız rapor, güncelleme başlatma ve sınırlı politika (DNS listeleri, Fail2Ban
// süreleri, arayüz ayarları) gelir; güvenlik duvarı, yönlendirme, rol, ağ ayarı, terminal ve panel koruması asla değişmez.
type CmdType = 'report.inventory' | 'update.start' | 'policy.apply';
type Consent = 'minimal' | 'standard' | 'detailed';
interface HistItem { id: string; seq: number; type: string; summary: string; status: string; detail: string; at: number }
interface AwaitItem { id: string; seq: number; type: CmdType; summary: string; receivedAt: number; notAfter: number; details?: string[] }
interface PendingPolicy { id: string; applied_at: number; deadline: number; ok_poll: boolean; ok_dns: boolean; summary: string }
interface FleetResp {
  supported: boolean; enrolled: boolean; proto: string; types: { id: CmdType; label: string }[]; pollRange: { min: number; max: number };
  state?: string; host?: string; server?: string; allowPrivate?: boolean; tenant?: { id: string; name: string }; deviceId?: string; site?: string;
  keyFingerprint?: string | null; enrolledAt?: number; pollS?: number; pollOverride?: number | null; serverPollS?: number;
  enabled?: boolean; consent?: Consent; approve?: Record<CmdType, boolean>; lastPollAt?: number | null; lastOkAt?: number | null;
  lastError?: string | null; failures?: number; awaiting?: AwaitItem[]; history?: HistItem[]; pendingPolicy?: PendingPolicy | null; outbox?: number;
}
const EMPTY: FleetResp = { supported: true, enrolled: false, proto: 'klx-fleet/1', types: [], pollRange: { min: 60, max: 900 } };

const STATE: Record<string, { cls: string; t: string; hint?: string }> = {
  active: { cls: 'is-ok', t: 'Bağlı' },
  starting: { cls: 'is-run', t: 'Başlıyor…', hint: 'İlk yoklama birkaç saniye içinde.' },
  paused: { cls: 'is-off', t: 'Duraklatıldı', hint: 'Cihaz sunucuya bağlanmıyor; komut almaz, rapor göndermez.' },
  clock: { cls: 'is-warn', t: 'Saat bekleniyor', hint: "Pi'nin saati internetle eşitlenmeden (RTC yok) imzalı istek gönderilmez." },
  rebind: { cls: 'is-bad', t: 'Yeniden kayıt gerekli', hint: 'Bu SD kart başka bir cihazdan kopyalanmış görünüyor: kimlik bu donanıma ait değil, cihaz sunucuyla hiç konuşmuyor. «Filodan ayrıl» yalnız bu kopyadaki kaydı siler (asıl cihaz filoda kalır); sonra yeni bir kayıt anahtarıyla kaydolun.' },
  revoked: { cls: 'is-bad', t: 'Sunucu cihazı kaldırdı', hint: 'Denetleyici bu cihazı tanımıyor. Filodan ayrılıp gerekirse yeni bir kayıt anahtarıyla yeniden kaydolun.' },
  error: { cls: 'is-bad', t: 'Bağlantı sorunu', hint: 'Yeniden denenecek (hata sürdükçe aralık uzar, en çok 1 saat).' },
  standby: { cls: 'is-off', t: 'Beklemede', hint: 'Yedekli kurulumda filo bağlantısını yalnız etkin cihaz kurar; bu cihaz etkin olunca bağlanır.' },
  off: { cls: 'is-off', t: 'Kapalı' },
};
const RESULT: Record<string, { cls: string; t: string }> = {
  ok: { cls: 'is-ok', t: 'Tamam' }, applied: { cls: 'is-run', t: 'Uygulandı' }, failed: { cls: 'is-bad', t: 'Başarısız' },
  rejected: { cls: 'is-off', t: 'Reddedildi' }, expired: { cls: 'is-off', t: 'Süresi doldu' }, awaiting_approval: { cls: 'is-warn', t: 'Onay bekliyor' },
  rolled_back: { cls: 'is-bad', t: 'Geri alındı' },
};
const CONSENT: { id: Consent; t: string; d: string }[] = [
  { id: 'minimal', t: 'En az (önerilen)', d: 'Sürüm, rol, donanım profili, sağlık özeti (servis ve uyarı sayıları), çalışma süresi. IP, MAC, cihaz listesi YOK.' },
  { id: 'standard', t: 'Standart', d: 'En aza ek olarak: kart modeli, işlemci / bellek kullanımı, servis adları ve durumları, güncelleme durumu. IP / MAC yok.' },
  { id: 'detailed', t: 'Ayrıntılı', d: "Standarda ek olarak: Pi'nin ağ kartları, IP ve MAC adresleri, bilinen cihaz sayısı, cihaz adı. Ev ağınızın yapısı buluta gider." },
];
const POLLS = [60, 120, 300, 600, 900];
const URL_OK = /^https:\/\/[^\s/?#]+[^\s?#]*$/i;
const ago = (s?: number | null) => (s ? relativeTime(new Date(s * 1000)) : null);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FleetPanel() {
  const { data, error, loading, refetch } = useApi<FleetResp>('/fleet', EMPTY, 10000);
  const [busy, setBusy] = useState<string | null>(null);
  const ready = !loading || !!error;

  if (error === 'HTTP 409') {
    return (
      <Panel title="Filo" icon={<Cloud size={20} style={{ marginRight: 8 }} />}>
        <p className="flt-empty">Bu cihaz mesh uydusu — filo bağlantısı ana cihazdadır.</p>
      </Panel>
    );
  }
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flt-page">
      <Panel title="Filo — bulut denetleyici" icon={<Cloud size={20} style={{ marginRight: 8 }} />} className="flt-panel"
        subtitle="Birden çok Klyrix cihazını tek bir yönetilen bulut panelinden izlemek için isteğe bağlı bağlantı. Kapalıyken cihaz dışarıya hiçbir şey göndermez.">
        <div className="flt-note is-info">
          <ShieldCheck size={15} />
          <span>
            <b>Panel internete açılmaz:</b> cihaz yalnız dışa doğru bağlanır (birkaç dakikada bir sunucuya «yeni komut var mı?» diye sorar);
            gelen bağlantı, açık port ya da ters tünel yoktur. Buluttan yalnız <b>durum raporu</b>, <b>panel güncellemesini başlatma</b> ve
            <b> sınırlı politika</b> (DNS liste kayıtları, Fail2Ban süreleri, görünüm ayarları) gelebilir. Güvenlik duvarı, yönlendirme, cihaz rolü,
            ağ ayarları, terminal ve panel koruması buluttan <b>asla</b> değiştirilemez.
          </span>
        </div>
        {error && <div className="flt-note is-bad"><AlertTriangle size={14} /><span>Filo durumu alınamadı ({error}).</span></div>}
        {!ready && <p className="flt-empty"><Loader2 size={13} className="spin" /> Yükleniyor…</p>}
        {/* Geçici bir yenileme hatasında form kalır (yazılanlar silinmez); ilk yükleme hatasında kayıt durumu bilinmez */}
        {ready && !data.enrolled && (!error || data !== EMPTY) && <EnrollForm busy={busy} run={run} />}
        {ready && data.enrolled && <Status data={data} busy={busy} run={run} />}
      </Panel>
      {ready && data.enrolled && (
        <>
          <Approvals data={data} busy={busy} run={run} />
          <Settings data={data} busy={busy} run={run} />
          <History data={data} />
        </>
      )}
    </div>
  );
}

type Run = (key: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function EnrollForm({ busy, run }: { busy: string | null; run: Run }) {
  const [server, setServer] = useState('');
  const [key, setKey] = useState('');
  const [site, setSite] = useState('');
  const [priv, setPriv] = useState(false);
  const [show, setShow] = useState(false);
  const urlBad = server.trim() !== '' && !URL_OK.test(server.trim());
  const keyOk = key.trim().length >= 8 && key.trim().length <= 256 && !/\s/.test(key.trim());
  const canSave = !urlBad && server.trim() !== '' && keyOk && [...site.trim()].length <= 40;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    void run('enroll', async () => {
      const r = await postApi('/fleet/enroll', { server: server.trim(), enroll_key: key.trim(), allow_private: priv, site: site.trim() }) as { tenant?: string };
      setKey('');
      toast.success(`Filoya kaydolundu — kiracı «${r.tenant ?? ''}»`);
    });
  };
  return (
    <form className="flt-form" onSubmit={submit} aria-label="Filoya kaydol">
      <h4>Filoya kaydol</h4>
      <p className="flt-hint">Denetleyicinin size verdiği sunucu adresini ve <b>tek kullanımlık</b> kayıt anahtarını girin. Cihaz kendi imza anahtarını
        burada üretir; anahtarın gizli yarısı Pi'den hiç çıkmaz.</p>
      <div className="form-group">
        <label htmlFor="flt-server">Sunucu adresi</label>
        <input id="flt-server" value={server} onChange={e => setServer(e.target.value)} placeholder="https://filo.ornek.com" spellCheck={false}
          autoComplete="off" aria-invalid={urlBad || undefined} inputMode="url" />
        {urlBad && <p className="flt-hint is-bad">Adres https:// ile başlamalı (sorgu ya da # olmadan).</p>}
      </div>
      <div className="form-group">
        <label htmlFor="flt-key"><KeyRound size={13} /> Kayıt anahtarı (gizli)</label>
        <div className="flt-inline">
          <input id="flt-key" type={show ? 'text' : 'password'} value={key} onChange={e => setKey(e.target.value)} spellCheck={false}
            name="fleet-enroll-key" autoComplete="new-password" data-1p-ignore data-lpignore="true" placeholder="denetleyicideki «Cihaz ekle» ekranından" />
          <button type="button" className="btn-outline btn-sm" onClick={() => setShow(!show)} aria-pressed={show} aria-label={show ? 'Anahtarı gizle' : 'Anahtarı göster'}>
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        {key.trim() !== '' && !keyOk && <p className="flt-hint is-bad">Anahtar 8–256 karakter olmalı, boşluk içermemeli.</p>}
        <p className="flt-hint">Anahtar yalnız kayıt isteğinde sunucuya gider; Pi'de saklanmaz, yedeğe ve günlüklere girmez.</p>
      </div>
      <div className="form-group">
        <label htmlFor="flt-site">Konum etiketi (isteğe bağlı)</label>
        <input id="flt-site" value={site} maxLength={40} onChange={e => setSite(e.target.value)} placeholder="ör. Merkez ofis, Ev" autoComplete="off" />
      </div>
      <label className="flt-check">
        <input type="checkbox" checked={priv} onChange={e => setPriv(e.target.checked)} />
        <span>Sunucu ev ağımda (özel IP adresi) — izin ver. İnternetteki bir sunucu için kapalı bırakın.</span>
      </label>
      <div className="flt-note is-warn">
        <Info size={14} />
        <span>Kayıttan sonra varsayılanlar: rapor düzeyi <b>en az</b> (IP / MAC / cihaz listesi gönderilmez), politika komutları <b>yerel onayınızı</b> bekler.
          İkisini de buradan değiştirebilir, istediğiniz an <b>Filodan ayrıl</b> ile bağlantıyı kesebilirsiniz.</span>
      </div>
      <div className="flt-actions">
        <button type="submit" className="btn-primary btn-sm btn-on" disabled={!canSave || !!busy}>
          {busy === 'enroll' ? <Loader2 size={13} className="spin" /> : <Cloud size={13} />} Filoya kaydol
        </button>
      </div>
    </form>
  );
}

function Status({ data, busy, run }: { data: FleetResp; busy: string | null; run: Run }) {
  const st = STATE[data.state || 'off'] || STATE.off;
  const pp = data.pendingPolicy;
  const clone = data.state === 'rebind';
  const leave = () => {
    const msg = clone
      ? 'Bu kopyadaki filo kaydı silinsin mi?\n\nBu SD kart başka bir cihazdan kopyalanmış: sunucuya hiçbir şey gönderilmez, asıl cihaz filoda kalır.'
        + ' Bu cihazı filoya eklemek için denetleyiciden yeni bir kayıt anahtarı alın.'
      : 'Filodan ayrılınsın mı?\n\nCihazın imza anahtarı silinir, yoklama durur, sunucuya ayrılma bildirilir. Bekleyen bir politika varsa önce geri alınır.'
        + ' Yeniden bağlanmak için denetleyiciden yeni bir kayıt anahtarı gerekir.';
    if (!window.confirm(msg)) return;
    void run('leave', async () => {
      const r = await postApi('/fleet/leave', {}) as { notified?: boolean; clone?: boolean; error?: string };
      if (r.notified) toast.success('Filodan ayrılındı — cihaz anahtarı silindi');
      else if (r.clone) toast.success('Kopya karttaki filo kaydı silindi — asıl cihaz filoda kalır');
      else toast.info(`Filodan ayrılındı (cihazda) — sunucuya bildirilemedi${r.error ? `: ${r.error}` : ''}; denetleyicide cihazı elle kaldırın`);
    });
  };
  const pause = (on: boolean) => {
    // Sağlık penceresinde duraklatmak = sunucuya yoklama yok = pencere sonunda politika kesin geri alınır
    if (!on && pp && !pp.ok_poll && !window.confirm('Yoklama duraklatılsın mı?\n\nSağlık denetimindeki politika sunucuya başarılı yoklama alamayacağı için pencere sonunda geri alınır.')) return;
    void run('pause', () => putApi('/fleet/settings', { enabled: on }), on ? 'Yoklama sürdürüldü' : 'Yoklama duraklatıldı');
  };
  return (
    <div className="flt-status">
      <div className="flt-head">
        <b className="flt-name">{data.tenant?.name}</b>
        <span className={`flt-state ${st.cls}`}>{data.state === 'starting' && <Loader2 size={11} className="spin" />}{st.t}</span>
      </div>
      {st.hint && <p className="flt-hint">{st.hint}</p>}
      <dl className="flt-meta">
        <div><dt>Sunucu</dt><dd className="flt-mono">{data.host}</dd></div>
        {data.site && <div><dt>Konum</dt><dd>{data.site}</dd></div>}
        <div><dt>Cihaz kimliği</dt><dd className="flt-mono">{data.deviceId}</dd></div>
        <div><dt>Anahtar parmak izi</dt><dd className="flt-mono">{data.keyFingerprint || '—'}</dd></div>
        <div><dt>Son başarılı yoklama</dt><dd>{ago(data.lastOkAt) || 'henüz yok'}</dd></div>
        <div><dt>Yoklama aralığı</dt><dd>~{data.pollS} sn (±%20)</dd></div>
        {data.outbox ? <div><dt>Gönderilmeyi bekleyen sonuç</dt><dd>{data.outbox}</dd></div> : null}
      </dl>
      {data.lastError && data.state !== 'paused' && (
        <div className="flt-note is-bad"><AlertTriangle size={14} /><span>Son hata: {data.lastError}{data.failures ? ` (${data.failures} kez üst üste)` : ''}</span></div>
      )}
      {pp && (
        <div className="flt-note is-warn">
          <Clock size={14} />
          <span><b>Politika sağlık denetiminde:</b> {pp.summary}. Denetim saat {new Date(pp.deadline * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} itibarıyla biter: o ana kadar
            sunucuya başarılı yoklama ({pp.ok_poll ? 'alındı' : 'bekleniyor'}) ve Pi'nin DNS'inden yanıt ({pp.ok_dns ? 'alındı' : 'bekleniyor'}) gelmezse
            değişiklik kendiliğinden geri alınır.</span>
        </div>
      )}
      <div className="flt-actions">
        {data.enabled ? (
          <button className="btn-outline btn-sm btn-off" onClick={() => pause(false)} disabled={!!busy}>
            {busy === 'pause' ? <Loader2 size={13} className="spin" /> : <Pause size={13} />} Duraklat
          </button>
        ) : (
          <button className="btn-primary btn-sm btn-on" onClick={() => pause(true)} disabled={!!busy}>
            {busy === 'pause' ? <Loader2 size={13} className="spin" /> : <Play size={13} />} Sürdür
          </button>
        )}
        <button className="btn-outline btn-sm btn-off" onClick={leave} disabled={!!busy}>
          {busy === 'leave' ? <Loader2 size={13} className="spin" /> : <LogOut size={13} />} Filodan ayrıl
        </button>
      </div>
    </div>
  );
}

function Approvals({ data, busy, run }: { data: FleetResp; busy: string | null; run: Run }) {
  const list = data.awaiting || [];
  if (!list.length) return null;
  // Cihaz sunucuyla konuşamıyorken onay kilitli (backend de 409 döner): uygulanan politika yoklamasız kalıp geri alınırdı
  const lock = data.state === 'rebind' ? 'bu SD kart başka bir cihazdan kopyalanmış.'
    : data.state === 'revoked' ? 'sunucu bu cihazı kaldırmış.'
      : !data.enabled ? 'yoklama duraklatılmış — önce «Sürdür».'
        : data.state === 'standby' ? 'bu cihaz şu an filo için etkin değil.' : '';
  const decide = (a: AwaitItem, ok: boolean) => run(`${ok ? 'ok' : 'no'}:${a.id}`, async () => {
    const r = await postApi(`/fleet/commands/${a.id}/${ok ? 'approve' : 'reject'}`, {}) as { result?: { status: string; detail: string } };
    const res = r.result;
    if (!ok) toast.success(lock ? 'Komut yerelde reddedildi' : 'Komut reddedildi — sunucuya bildirildi');
    else if (res?.status === 'ok' || res?.status === 'applied') toast.success(`Uygulandı: ${res.detail}`);
    else toast.error(`${RESULT[res?.status || '']?.t || 'Sonuç'}: ${res?.detail || ''}`);
  });
  return (
    <Panel title="Onay bekleyen komutlar" icon={<AlertTriangle size={20} style={{ marginRight: 8 }} />} className="flt-panel flt-await"
      subtitle="Bu komut türleri için yerel onay istediniz. Onaylamazsanız komutun süresi dolunca kendiliğinden düşer.">
      {lock && <div className="flt-note is-warn flt-lock"><AlertTriangle size={14} /><span>Şu an onaylanamaz: {lock} Reddetmek her zaman mümkün.</span></div>}
      <div className="flt-list">
        {list.map(a => {
          const b = busy?.endsWith(`:${a.id}`) ? busy.split(':')[0] : null;
          return (
            <div key={a.id} className="flt-item">
              <div className="flt-head"><b className="flt-name">{a.summary}</b><span className="flt-state is-warn">Onay bekliyor</span></div>
              <p className="flt-hint">Geldi {ago(a.receivedAt)} · son geçerlilik {new Date(a.notAfter * 1000).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · sıra {a.seq}</p>
              {!!a.details?.length && (
                <ul className="flt-detail" aria-label="Uygulanacak değişiklikler">
                  {a.details.map((d, i) => <li key={`${i}:${d}`}>{d}</li>)}
                </ul>
              )}
              {a.type === 'policy.apply' && <p className="flt-hint">Uygulanınca 10 dk sağlık denetimi başlar; sunucuya ulaşılamaz ya da DNS yanıt vermezse değişiklik geri alınır.</p>}
              <div className="flt-actions">
                <button className="btn-primary btn-sm btn-on" onClick={() => { void decide(a, true); }} disabled={!!busy || !!lock}
                  title={lock ? `Şu an onaylanamaz: ${lock}` : undefined}>
                  {b === 'ok' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Onayla ve uygula
                </button>
                <button className="btn-outline btn-sm btn-off" onClick={() => { void decide(a, false); }} disabled={!!busy}>
                  {b === 'no' ? <Loader2 size={13} className="spin" /> : <X size={13} />} Reddet
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Settings({ data, busy, run }: { data: FleetResp; busy: string | null; run: Run }) {
  const save = (body: Record<string, unknown>, ok: string) => run('settings', () => putApi('/fleet/settings', body), ok);
  const consent = data.consent || 'minimal';
  const pollVal = data.pollOverride == null ? 'server' : String(data.pollOverride);
  const polls = data.pollOverride != null && !POLLS.includes(data.pollOverride) ? [...POLLS, data.pollOverride].sort((a, b) => a - b) : POLLS;
  return (
    <Panel title="Filo ayarları" icon={<ShieldCheck size={20} style={{ marginRight: 8 }} />} className="flt-panel"
      subtitle="Buluta ne kadar bilgi gideceğini ve hangi komutların sizin onayınızı bekleyeceğini siz seçersiniz.">
      <fieldset className="flt-field" disabled={!!busy}>
        <legend>Rapor düzeyi</legend>
        <div className="flt-radios" role="radiogroup" aria-label="Rapor düzeyi">
          {CONSENT.map(c => (
            <label key={c.id} className={`flt-radio${consent === c.id ? ' is-on' : ''}`}>
              <input type="radio" name="flt-consent" checked={consent === c.id}
                onChange={() => { void save({ consent: c.id }, `Rapor düzeyi: ${c.t.replace(' (önerilen)', '')}`); }} />
              <span><b>{c.t}</b><small>{c.d}</small></span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="flt-field" disabled={!!busy}>
        <legend>Filodan gelen komutları onayla</legend>
        {data.types.map(t => (
          <label key={t.id} className="flt-check">
            <input type="checkbox" checked={!!data.approve?.[t.id]}
              onChange={e => { void save({ approve: { [t.id]: e.target.checked } }, `${t.label}: ${e.target.checked ? 'onayınızı bekleyecek' : 'onaysız uygulanacak'}`); }} />
            <span>{t.label} — {data.approve?.[t.id] ? 'onayınızı bekler' : 'onaysız uygulanır'}</span>
          </label>
        ))}
        <p className="flt-hint">İzin verilmeyen bir komut türü (güvenlik duvarı, yönlendirme, ağ, rol, terminal…) sunucudan gelse bile cihaz onu tanımaz ve reddeder.</p>
      </fieldset>
      <div className="form-group flt-poll">
        <label htmlFor="flt-poll">Yoklama aralığı</label>
        <Select id="flt-poll" value={pollVal} disabled={!!busy}
          onChange={e => { void save({ poll_s: e.target.value === 'server' ? null : Number(e.target.value) }, 'Yoklama aralığı kaydedildi'); }}>
          <option value="server">Sunucunun önerisi ({data.serverPollS} sn)</option>
          {polls.map(p => <option key={p} value={String(p)}>{p < 120 ? `${p} sn` : `${p / 60} dk`}</option>)}
        </Select>
      </div>
    </Panel>
  );
}

function History({ data }: { data: FleetResp }) {
  const list = data.history || [];
  return (
    <Panel title="Son komutlar" icon={<Clock size={20} style={{ marginRight: 8 }} />} className="flt-panel">
      {!list.length ? <p className="flt-empty">Henüz komut gelmedi.</p> : (
        <ul className="flt-hist">
          {list.map(h => {
            const r = RESULT[h.status] || { cls: 'is-off', t: h.status };
            return (
              <li key={`${h.id}:${h.status}`}>
                <div className="flt-head">
                  <b className="flt-name">{h.summary || h.type}</b>
                  <span className={`flt-state ${r.cls}`}>{r.t}</span>
                </div>
                <p className="flt-hint">{ago(h.at)} · sıra {h.seq}{h.detail ? ` · ${h.detail}` : ''}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

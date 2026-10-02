import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, Info, Lock, MessageSquare, Pencil, Plus, Radar, Send, Trash2, Webhook, X } from 'lucide-react';
import { postApi, putApi, deleteApi } from '../hooks/useApi';
import { effectivePoll } from '../prefs';
import { toast } from '../toast';
import { fmtDbTime } from '../time';
import { Badge, Panel, Select } from './ui';
import './NotifyChannels.css';

// Bildirimler → "Dış kanallar" (G2.1, backend notify.ts / deviceWatch.ts): uyarıları kullanıcının KENDİ Telegram botuna,
// Discord kanalına ya da webhook adresine iletme ve yeni cihaz bildirimi. Varsayılan kapalı; Klyrix'e hiçbir şey gitmez.
// Kanal sihirbazı sıralı ve adım adım: ① tür ② bağlantı bilgileri ③ "Test mesajı gönder" (nötr) ④ ne gönderilsin +
// "Kaydet ve aç" (yeşil). Test başarılı olmadan kaydedilemez; bağlantı bilgisi değişince test yeniden istenir. Kapatma ve
// silme kırmızı. Gizli alanlar (token, webhook adresi, HMAC sırrı) sunucudan maskeli gelir: düzenlemede alan boş kalırsa
// maske gönderilir ve saklı değer korunur (DDNS deseni).

type Kind = 'telegram' | 'discord' | 'webhook';
type Sev = 'info' | 'warning' | 'critical';
type Rule = 'always' | 'never';
interface Quiet { enabled: boolean; start: string; end: string }
interface ChannelView {
  id: string; kind: Kind; name: string; enabled: boolean; minSeverity: Sev; sources: Record<string, Rule>; quiet: Quiet;
  content: 'short' | 'full'; allowPrivate: boolean; created: string; target: string;
  botToken?: string; chatId?: string; webhookUrl?: string; url?: string; hmacSecret?: string; hasHmac?: boolean;
  status: { failures: number; lastError: string; lastOkAt: number; retryAt: number; rateUntil: number; limited: boolean };
}
interface NotifyResp {
  supported: boolean; running: boolean; maxChannels: number; channels: ChannelView[];
  deviceWatch: { enabled: boolean; randomMac: 'tag' | 'suppress'; running: boolean; supported: boolean };
  sources: { id: string; label: string }[]; defaultSources: Record<string, Rule>;
}
interface Delivery {
  id: number; alert_id: number | null; channel_id: string; channel: string; ok: boolean; http_status: number | null;
  error_redacted: string; label: string; items: number; ts: string;
}

const MASK = '••••••••';
const KIND: Record<Kind, { label: string; icon: ReactNode; desc: string }> = {
  telegram: { label: 'Telegram', icon: <Send size={16} />, desc: 'Kendi botunuzdan kendi sohbetinize (BotFather ile kurulur).' },
  discord: { label: 'Discord', icon: <MessageSquare size={16} />, desc: 'Sunucunuzdaki bir kanalın webhook adresi.' },
  webhook: { label: 'Webhook', icon: <Webhook size={16} />, desc: 'Kendi adresiniz (Home Assistant, n8n …): JSON gövde, isteğe bağlı HMAC imzası.' },
};
const SEV_TEXT: Record<Sev, string> = { critical: 'Yalnız kritik', warning: 'Uyarı ve kritik', info: 'Tümü (bilgi dahil)' };
const TG_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const TG_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// Hata metni (409 uydu, 400 doğrulama) gösterilsin diye getApi yerine.
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j as T;
}
// Sihirbaz testi: HTTP durumu da döner — 429 (10 sn kapısı / yazma sınırı) "denenmedi"dir, "başarısız" değil.
class TestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function postTest(body: Record<string, unknown>): Promise<void> {
  const r = await fetch('/api/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new TestError(j.error || `HTTP ${r.status}`, r.status);
}

function Note({ kind, children }: { kind: 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'warn' ? 'err' : 'ok'} nc-note`}>
      {kind === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

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

// Gizli alanlar (token, webhook adresi, HMAC sırrı) düzenlemede boş başlar: boş = saklı değer (maske gönderilir).
interface Form {
  kind: Kind | ''; name: string; botToken: string; chatId: string; webhookUrl: string; url: string; hmacSecret: string; hmacClear: boolean;
  allowPrivate: boolean; minSeverity: Sev; content: 'short' | 'full'; sources: Record<string, Rule>; quiet: Quiet;
}
// Teslimi etkileyen alanlar: değişince test yeniden istenir.
const connSig = (f: Form) => JSON.stringify([f.kind, f.botToken, f.chatId, f.webhookUrl, f.url, f.hmacSecret, f.hmacClear, f.allowPrivate]);
function connProblem(f: Form, editing: boolean): string {
  const kept = (v: string) => editing && !v.trim();
  if (f.kind === 'telegram') {
    if (!kept(f.botToken) && !TG_TOKEN.test(f.botToken.trim())) return "Bot token BotFather'ın verdiği 123456:ABC… biçiminde olmalı";
    if (!TG_CHAT.test(f.chatId.trim())) return 'Sohbet kimliği sayı (grupta -100…) ya da @kanaladı olmalı';
  } else if (f.kind === 'discord') {
    if (!kept(f.webhookUrl) && !/^https:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\//.test(f.webhookUrl.trim())) return 'Discord webhook adresi https://discord.com/api/webhooks/… ile başlamalı';
  } else if (f.kind === 'webhook') {
    if (!kept(f.url) && !/^https?:\/\/\S+$/.test(f.url.trim())) return 'Adres http:// ya da https:// ile başlamalı';
  }
  return '';
}
function body(f: Form, edit: ChannelView | null) {
  const secret = (v: string) => v.trim() || (edit ? MASK : '');
  return {
    kind: f.kind, name: f.name.trim() || (f.kind ? KIND[f.kind].label : ''), minSeverity: f.minSeverity, content: f.content,
    sources: f.sources, quiet: f.quiet,
    ...(f.kind === 'telegram' ? { botToken: secret(f.botToken), chatId: f.chatId.trim() } : {}),
    ...(f.kind === 'discord' ? { webhookUrl: secret(f.webhookUrl) } : {}),
    ...(f.kind === 'webhook' ? {
      url: secret(f.url), allowPrivate: f.allowPrivate,
      hmacSecret: f.hmacClear ? '' : f.hmacSecret || (edit?.hasHmac ? MASK : ''),
    } : {}),
  };
}
const SAVED = 'saklı — değiştirmek için yazın';

function ChannelWizard({ edit, resp, onClose, onSaved }: { edit: ChannelView | null; resp: NotifyResp; onClose: () => void; onSaved: () => void }) {
  const init: Form = edit ? {
    kind: edit.kind, name: edit.name, botToken: '', chatId: edit.chatId || '', webhookUrl: '', url: '', hmacSecret: '', hmacClear: false,
    allowPrivate: edit.allowPrivate, minSeverity: edit.minSeverity, content: edit.content, sources: { ...edit.sources }, quiet: { ...edit.quiet },
  } : {
    kind: '', name: '', botToken: '', chatId: '', webhookUrl: '', url: '', hmacSecret: '', hmacClear: false, allowPrivate: false,
    minSeverity: 'warning', content: 'short', sources: { ...resp.defaultSources }, quiet: { enabled: false, start: '23:00', end: '07:00' },
  };
  const [f, setF] = useState<Form>(init);
  const [connDone, setConnDone] = useState(!!edit);
  // Son başarılı testin bağlantı imzası (düzenlemede saklı bağlantı sınanmış sayılır).
  const [tested, setTested] = useState(edit ? connSig(init) : '');
  const [testErr, setTestErr] = useState('');
  const [busy, setBusy] = useState('');
  const set = (p: Partial<Form>) => setF(prev => ({ ...prev, ...p }));
  const problem = f.kind ? connProblem(f, !!edit) : '';
  const s1: StepState = f.kind ? 'done' : 'active';
  const s2: StepState = !f.kind ? 'todo' : connDone && !problem ? 'done' : 'active';
  const testOk = tested === connSig(f);
  const s3: StepState = s2 !== 'done' ? 'todo' : testOk ? 'done' : 'active';
  const s4: StepState = s3 === 'done' ? 'active' : 'todo';
  const unchanged = !!edit && connSig(f) === connSig(init);

  const runTest = async () => {
    setBusy('test');
    setTestErr('');
    const sig = connSig(f);
    try {
      await postTest({ ...body(f, edit), ...(edit ? { id: edit.id } : {}) });
      setTested(sig);
      toast.success('Test mesajı gönderildi — kanalda göründüğünü denetleyin');
    } catch (e) {
      setTestErr(errText(e, 'Test mesajı gönderilemedi'));
      // Bu bilgilerle test başarısız: önceki başarılı test (ya da düzenlemede saklı bağlantı) geçersiz — Kaydet kilitlenir.
      // 429 test gönderilmedi demektir (10 sn'de bir): önceki sonuç geçerli kalır.
      if (!(e instanceof TestError && e.status === 429)) setTested(prev => (prev === sig ? '' : prev));
    }
    setBusy('');
  };
  const save = async () => {
    setBusy('save');
    try {
      if (edit) await putApi(`/notify/${edit.id}`, body(f, edit));
      else await postApi('/notify', { ...body(f, null), enabled: true });
      toast.success(edit ? 'Kanal kaydedildi' : `${f.name.trim() || KIND[f.kind as Kind].label} kanalı açıldı — yeni uyarılar buraya gelecek (geçmiş gönderilmez)`);
      onSaved();
    } catch (e) {
      toast.error(errText(e, 'Kaydedilemedi'));
    }
    setBusy('');
  };
  const rules = Object.values(f.sources);

  return (
    <section className="dhcp-wizard nc-wizard" aria-labelledby="nc-wiz-title">
      <div className="nc-wizard-head">
        <div id="nc-wiz-title" className="dhcp-wizard-title">{edit ? `Kanalı düzenle: ${edit.name}` : 'Yeni dış bildirim kanalı'}</div>
        <button className="icon-btn" onClick={onClose} title="Sihirbazı kapat (kaydedilmez)" aria-label="Sihirbazı kapat"><X size={14} /></button>
      </div>
      <Step n={1} title="Kanal türü" state={s1}>
        {edit ? <span>{KIND[edit.kind].label} (tür değiştirilemez — başka tür için yeni kanal ekleyin)</span> : (
          <div className="nc-kinds" role="radiogroup" aria-label="Kanal türü">
            {(Object.keys(KIND) as Kind[]).map(k => (
              <button key={k} role="radio" aria-checked={f.kind === k} className={`nc-kind${f.kind === k ? ' nc-kind-on' : ''}`}
                onClick={() => { set({ kind: k }); setConnDone(false); setTestErr(''); }}>
                <span className="nc-kind-title">{KIND[k].icon} {KIND[k].label}</span>
                <span className="nc-kind-desc">{KIND[k].desc}</span>
              </button>
            ))}
          </div>
        )}
      </Step>
      <Step n={2} title="Bağlantı bilgileri" state={s2}>
        {s2 === 'todo' ? <Locked text="Önce 1. adım: kanal türünü seçin" /> : (
          <>
            {f.kind === 'telegram' && (
              <p className="nc-help">
                Telegram'da @BotFather → /newbot → verdiği token'ı yapıştırın. Sonra botunuza bir mesaj yazın (bot size kendiliğinden yazamaz).
                Sohbet kimliği için tarayıcıda <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> adresini açıp <code>"chat":{'{'}"id": …{'}'}</code> değerini
                girin; grupta kimlik -100… ile başlar.
              </p>
            )}
            {f.kind === 'discord' && (
              <p className="nc-help">
                Discord: Sunucu ayarları → Entegrasyonlar → Webhook'lar → Yeni webhook → kanalı seçin → "Webhook URL'sini kopyala". Mesajlar kimseyi
                etiketlemez (@everyone dahil).
              </p>
            )}
            {f.kind === 'webhook' && (
              <p className="nc-help">
                Pi her bildirim için JSON gönderir (POST): <code>{'{v, device, alertId, severity, source, sourceLabel, message, createdAt}'}</code>. HMAC sırrı
                verirseniz <code>X-Klyrix-Signature: sha256=&lt;hex&gt;</code> başlığı eklenir. İnternetteki adres yalnız https; yönlendirme (30x) izlenmez.
              </p>
            )}
            <div className="nc-grid">
              <div className="form-group">
                <label htmlFor="nc-name">Kanal adı</label>
                <input id="nc-name" className="config-input" value={f.name} maxLength={40} placeholder={f.kind ? KIND[f.kind].label : ''}
                  onChange={e => set({ name: e.target.value })} />
              </div>
              {f.kind === 'telegram' && (
                <>
                  <div className="form-group">
                    <label htmlFor="nc-token">Bot token</label>
                    <input id="nc-token" className="config-input" type="password" autoComplete="off" value={f.botToken} placeholder={edit ? SAVED : '123456789:AA…'}
                      onChange={e => set({ botToken: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="nc-chat">Sohbet kimliği (chat id)</label>
                    <input id="nc-chat" className="config-input" value={f.chatId} placeholder="987654321" onChange={e => set({ chatId: e.target.value })} />
                  </div>
                </>
              )}
              {f.kind === 'discord' && (
                <div className="form-group nc-wide">
                  <label htmlFor="nc-dc">Webhook adresi</label>
                  <input id="nc-dc" className="config-input" type="password" autoComplete="off" value={f.webhookUrl} placeholder={edit ? SAVED : 'https://discord.com/api/webhooks/…'}
                    onChange={e => set({ webhookUrl: e.target.value })} />
                </div>
              )}
              {f.kind === 'webhook' && (
                <>
                  <div className="form-group nc-wide">
                    <label htmlFor="nc-url">Adres</label>
                    <input id="nc-url" className="config-input" type="password" autoComplete="off" value={f.url} placeholder={edit ? `${SAVED} (${edit.target})` : 'https://ornek.com/hook/…'}
                      onChange={e => set({ url: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="nc-hmac">HMAC sırrı (isteğe bağlı)</label>
                    <input id="nc-hmac" className="config-input" type="password" autoComplete="off" value={f.hmacSecret} maxLength={200}
                      placeholder={edit?.hasHmac ? SAVED : 'boş: imza yok'} disabled={f.hmacClear}
                      onChange={e => set({ hmacSecret: e.target.value })} />
                    {edit?.hasHmac && (
                      <label className="nc-check">
                        <input type="checkbox" checked={f.hmacClear} onChange={e => set({ hmacClear: e.target.checked, hmacSecret: '' })} />
                        <span>İmzayı kaldır</span>
                      </label>
                    )}
                  </div>
                  <label className="nc-check nc-wide">
                    <input type="checkbox" checked={f.allowPrivate} onChange={e => set({ allowPrivate: e.target.checked })} />
                    <span>Ev ağındaki hedefe izin ver (ör. <code>http://192.168.1.20:8123/api/webhook/…</code> Home Assistant). Kapalıyken yalnız internetteki https adresine
                      gönderilir; Pi'nin kendisine (127.0.0.1, kendi adresleri) hiçbir zaman gönderilmez.</span>
                  </label>
                </>
              )}
            </div>
            {problem && connDone && <Note kind="warn">{problem}</Note>}
            {!connDone && (
              <div className="panel-auth-actions">
                <button className="btn-primary btn-sm" onClick={() => setConnDone(true)} disabled={!!problem} title={problem || undefined}>Devam</button>
                {problem && <span className="dhcp-muted">{problem}</span>}
              </div>
            )}
          </>
        )}
      </Step>
      <Step n={3} title="Test mesajı" state={s3}>
        {s3 === 'todo' ? <Locked text="Önce 2. adım: bağlantı bilgilerini girin" /> : (
          <>
            <span>{unchanged ? 'Bağlantı bilgisi değişmedi — test isteğe bağlı.' : "Kaydetmeden önce kanala bir test mesajı gönderin; mesaj kanalda görünmeli."} Test 10 sn'de bir gönderilebilir.</span>
            {testErr && <Note kind="warn">Test başarısız: {testErr}</Note>}
            {testOk && !unchanged && !testErr && <Note kind="info">Test mesajı gönderildi — kanalda göründüyse kaydedebilirsiniz.</Note>}
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" onClick={() => { void runTest(); }} disabled={!!busy}>
                <Send size={13} /> {busy === 'test' ? 'Gönderiliyor…' : 'Test mesajı gönder'}
              </button>
            </div>
          </>
        )}
      </Step>
      <Step n={4} title="Ne gönderilsin" state={s4}>
        {s4 === 'todo' ? <Locked text={s3 === 'active' ? 'Önce 3. adım: test mesajı başarılı olmalı' : 'Önce önceki adımlar'} /> : (
          <>
            <div className="nc-grid">
              <div className="form-group">
                <label>Önem eşiği</label>
                <Select className="config-select" value={f.minSeverity} onChange={e => set({ minSeverity: e.target.value as Sev })}>
                  {(['warning', 'critical', 'info'] as Sev[]).map(s => <option key={s} value={s}>{SEV_TEXT[s]}{s === 'warning' ? ' (önerilen)' : ''}</option>)}
                </Select>
              </div>
              <div className="form-group">
                <label>İçerik</label>
                <Select className="config-select" value={f.content} onChange={e => set({ content: e.target.value as 'short' | 'full' })}>
                  <option value="short">Kısa (önerilen): ne oldu — ayrıntı panelde</option>
                  <option value="full">Tam metin: cihaz adı, IP, MAC dahil</option>
                </Select>
              </div>
            </div>
            {f.content === 'full' && (
              <Note kind="warn">Tam metinde kayıt olduğu gibi (cihaz adı, IP ve MAC dahil) {f.kind === 'webhook' ? 'kendi adresinize' : `${KIND[f.kind as Kind].label} sunucularından geçerek`} gider.</Note>
            )}
            <label className="nc-check">
              <input type="checkbox" checked={f.quiet.enabled} onChange={e => set({ quiet: { ...f.quiet, enabled: e.target.checked } })} />
              <span>Sessiz saatler: bu aralıkta yalnız kritik kayıtlar gider, diğerleri bitince tek özet olarak gelir.</span>
            </label>
            {f.quiet.enabled && (
              <div className="nc-time">
                <input className="config-input" type="time" aria-label="Sessiz saat başlangıcı" value={f.quiet.start} onChange={e => set({ quiet: { ...f.quiet, start: e.target.value } })} />
                <span>–</span>
                <input className="config-input" type="time" aria-label="Sessiz saat bitişi" value={f.quiet.end} onChange={e => set({ quiet: { ...f.quiet, end: e.target.value } })} />
              </div>
            )}
            <details className="nc-sources">
              <summary>Kaynak süzgeci — {rules.filter(r => r === 'always').length} her zaman, {rules.filter(r => r === 'never').length} hiç</summary>
              <p className="nc-help">
                "Eşiğe göre" olan kaynak önem eşiğine göre gider; "Her zaman" önemden bağımsız gider, "Hiç" gönderilmez. Varsayılanda yeni cihaz, hat
                kalitesi, yedek hat geçişi ve yeni ağ kartı her zaman gider; 5 dk'lık tek ping denetimi gönderilmez. Bu özelliğin kendi kayıtları hiç gönderilmez.
              </p>
              <div className="nc-src-list">
                {resp.sources.map(s => (
                  <div key={s.id} className="nc-src-row">
                    <span>{s.label}</span>
                    <Select className="config-select nc-src-sel" aria-label={`${s.label} kuralı`} value={f.sources[s.id] || ''}
                      onChange={e => {
                        const v = e.target.value;
                        const next = { ...f.sources };
                        if (v === 'always' || v === 'never') next[s.id] = v; else delete next[s.id];
                        set({ sources: next });
                      }}>
                      <option value="">Eşiğe göre</option>
                      <option value="always">Her zaman</option>
                      <option value="never">Hiç</option>
                    </Select>
                  </div>
                ))}
              </div>
              <button className="btn-outline btn-sm" onClick={() => set({ sources: { ...resp.defaultSources } })}>Varsayılana dön</button>
            </details>
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm btn-on" onClick={() => { void save(); }} disabled={!!busy || !testOk}>
                <Check size={13} /> {busy === 'save' ? 'Kaydediliyor…' : edit ? 'Kaydet' : 'Kaydet ve aç'}
              </button>
            </div>
          </>
        )}
      </Step>
    </section>
  );
}

function DeviceWatchCard({ resp, reload }: { resp: NotifyResp; reload: () => void }) {
  const [busy, setBusy] = useState('');
  const dw = resp.deviceWatch;
  const put = async (p: { enabled?: boolean; randomMac?: 'tag' | 'suppress' }) => {
    setBusy(p.enabled === undefined ? 'mode' : 'toggle');
    try {
      const r = await putApi('/notify/device-watch', p);
      if (p.enabled === true) {
        toast.success(r?.baselinePending ? 'Yeni cihaz bildirimi açıldı — bağlı cihazlar ilk başarılı taramada bilinen sayılacak'
          : `Yeni cihaz bildirimi açıldı — şu an bağlı ${r?.baseline ?? 0} cihaz bilinen sayıldı`);
      }
      else if (p.enabled === false) toast.success('Yeni cihaz bildirimi kapatıldı');
      else toast.success('Kaydedildi');
    } catch (e) {
      toast.error(errText(e, 'Ayar değiştirilemedi'));
    }
    setBusy('');
    reload();
  };
  return (
    <Panel title="Yeni cihaz bildirimi" icon={<Radar size={18} style={{ marginRight: 8 }} />}
      badge={<Badge variant={dw.enabled ? 'success' : 'neutral'}>{dw.enabled ? 'Açık' : 'Kapalı'}</Badge>}
      actions={dw.supported ? (dw.enabled
        ? <button className="btn-outline btn-sm nc-off" onClick={() => { void put({ enabled: false }); }} disabled={!!busy}>{busy === 'toggle' ? 'Kapatılıyor…' : 'Kapat'}</button>
        : <button className="btn-primary btn-sm nc-on" onClick={() => { void put({ enabled: true }); }} disabled={!!busy}>{busy === 'toggle' ? 'Açılıyor…' : 'Aç'}</button>) : undefined}>
      <p className="nc-desc">
        Ağa ilk kez bağlanan cihazı panel kapalıyken de bulur ve Bildirimler'e yazar; açık bir dış kanal varsa oraya da gider. Açıkken 60 sn'de bir
        komşu tablosu okunur; açarken bağlı cihazlar ve DHCP kirası süren (uyuyan) cihazlar bilinen sayılır (bildirim gelmez). Yeni cihaz için bir
        dakika beklenir (DHCP adı gelsin). Otomatik engel yok — "Tanıyorum" listesi Cihaz Yönetimi'nde. Ev VPN istemcileri kapsam dışı (komşu
        tablosunda görünmezler).
      </p>
      {!dw.supported && <Note kind="info">Yeni cihaz algılama yalnız Pi üzerinde çalışır.</Note>}
      <div className="nc-row">
        <span>Gizli (rastgele) Wi-Fi adresli cihazlar</span>
        <Select className="config-select nc-src-sel" value={dw.randomMac} disabled={!!busy} aria-label="Gizli Wi-Fi adresli cihazlar"
          onChange={e => { void put({ randomMac: e.target.value as 'tag' | 'suppress' }); }}>
          <option value="tag">Bildir, etiketle</option>
          <option value="suppress">Bildirme</option>
        </Select>
      </div>
      <p className="nc-desc">Telefonlar her ağda (bazı ayarlarda her bağlanışta) farklı adres kullanabilir; bu cihazlar sık "yeni" görünebilir.</p>
    </Panel>
  );
}

function Deliveries() {
  const [rows, setRows] = useState<Delivery[]>([]);
  const load = useCallback(async () => {
    try { setRows((await getJson<{ deliveries: Delivery[] }>('/api/notify/deliveries?limit=20')).deliveries); } catch { /* sekme açık kalsın */ }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const ms = effectivePoll(15000);
    const id = ms ? setInterval(() => { void load(); }, ms) : undefined;
    return () => { clearTimeout(first); if (id) clearInterval(id); };
  }, [load]);
  return (
    <Panel title="Son gönderimler" subtitle="Dış kanallara giden mesajlar ve test mesajları — 30 gün tutulur">
      {!rows.length ? <div className="empty-state" style={{ padding: 16 }}>Henüz gönderim yok.</div> : (
        <ul className="nc-deliv" aria-label="Son gönderimler">
          {rows.map(r => (
            <li key={r.id} className="nc-deliv-row">
              <span className="nc-deliv-time">{fmtDbTime(r.ts, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="nc-deliv-main"><strong>{r.channel}</strong> · {r.label}</span>
              {r.ok ? <Badge variant="success">gitti</Badge> : <Badge variant="error">{r.http_status ? `HTTP ${r.http_status}` : 'gitmedi'}</Badge>}
              {!r.ok && r.error_redacted && <span className="nc-deliv-err">{r.error_redacted}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function NotifyChannels() {
  const [data, setData] = useState<NotifyResp | null>(null);
  const [err, setErr] = useState('');
  const [wizard, setWizard] = useState<{ edit: ChannelView | null } | null>(null);
  const [busy, setBusy] = useState('');
  const [confirmDel, setConfirmDel] = useState('');

  const load = useCallback(async () => {
    try { setData(await getJson<NotifyResp>('/api/notify')); setErr(''); } catch (e) { setErr(errText(e, 'Dış kanallar okunamadı')); }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const ms = effectivePoll(15000);
    const id = ms ? setInterval(() => { void load(); }, ms) : undefined;
    return () => { clearTimeout(first); if (id) clearInterval(id); };
  }, [load]);
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(''), 5000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy('');
    void load();
  };

  if (err && !data) return <div className="nc-page"><Panel title="Dış kanallar"><Note kind="warn">{err}</Note></Panel></div>;
  if (!data) return <div className="nc-page"><Panel title="Dış kanallar"><span className="text-muted">Okunuyor…</span></Panel></div>;
  const full = data.channels.length >= data.maxChannels;

  return (
    <div className="nc-page">
      <Panel title="Dış kanallar" icon={<Send size={18} style={{ marginRight: 8 }} />}
        subtitle="Uyarıları kendi Telegram botunuza, Discord kanalınıza ya da webhook adresinize gönderir"
        badge={<Badge variant={data.channels.some(c => c.enabled) ? 'success' : 'neutral'}>{data.channels.filter(c => c.enabled).length} açık kanal</Badge>}
        actions={!wizard && !full ? (
          <button className="btn-primary btn-sm" onClick={() => setWizard({ edit: null })}><Plus size={14} /> Kanal ekle</button>
        ) : undefined}>
        <Note kind="info">
          Yalnız sizin açtığınız kanala gider, varsayılan kapalı; Klyrix'e hiçbir şey gönderilmez. Kısa kipte (varsayılan) mesajda cihaz adı, IP ya da MAC
          yer almaz — ayrıntı panelde kalır. Kanal açılınca yalnız yeni kayıtlar gider (geçmiş gönderilmez); aynı tür kayıt 10 dk'da bir, birikince tek özet.
        </Note>
        <p className="nc-desc">
          Bildirim Pi'nin kendi bağlantısından çıkar: Telegram ya da Discord'u Yönlendirme'de VPS'e aldıysanız istek de o tünelden gider; ana hat düşüp
          yedek hatta geçildiyse yedek hattan. Yedek hat yokken "ana hat kesildi" iletilemez — hat dönünce "geri geldi" bildirimi gelir. Panel yeni bir
          yönlendirme kuralı kurmaz.
        </p>
        {err && <Note kind="warn">{err}</Note>}
        {data.channels.length > 0 && (
          <ul className="nc-list" aria-label="Kanallar">
            {data.channels.map(c => (
              <li key={c.id} className={`nc-item${c.enabled ? '' : ' nc-item-off'}`}>
                <div className="nc-item-head">
                  <span className="nc-item-icon">{KIND[c.kind].icon}</span>
                  <strong>{c.name}</strong>
                  <Badge variant="neutral">{KIND[c.kind].label}</Badge>
                  <Badge variant={c.enabled ? 'success' : 'neutral'}>{c.enabled ? 'Açık' : 'Kapalı'}</Badge>
                </div>
                <span className="nc-item-meta">
                  {c.target} · {SEV_TEXT[c.minSeverity]} · {c.content === 'short' ? 'kısa içerik' : 'tam metin'}
                  {c.quiet.enabled ? ` · sessiz ${c.quiet.start}–${c.quiet.end}` : ''}{c.kind === 'webhook' && c.hasHmac ? ' · HMAC imzalı' : ''}
                </span>
                {c.enabled && c.status.failures > 0 && (
                  <Note kind="warn">Son gönderim başarısız ({c.status.failures} kez): {c.status.lastError} — yeniden denenecek.</Note>
                )}
                {c.enabled && !c.status.failures && c.status.limited && (
                  <Note kind="info">Hız sınırı: kanal kısa süre bekletiliyor ({c.status.lastError || 'HTTP 429'}).</Note>
                )}
                <div className="panel-auth-actions nc-item-act">
                  <button className="btn-outline btn-sm" onClick={() => { void act(`t${c.id}`, () => postApi(`/notify/${c.id}/test`, {}), 'Test mesajı gönderildi'); }} disabled={!!busy}>
                    <Send size={13} /> {busy === `t${c.id}` ? 'Gönderiliyor…' : 'Test mesajı gönder'}
                  </button>
                  <button className="btn-outline btn-sm" onClick={() => setWizard({ edit: c })} disabled={!!busy || !!wizard}><Pencil size={13} /> Düzenle</button>
                  {c.enabled
                    ? <button className="btn-outline btn-sm nc-off" onClick={() => { void act(`e${c.id}`, () => putApi(`/notify/${c.id}`, { enabled: false }), `${c.name} kapatıldı`); }} disabled={!!busy}>Kapat</button>
                    : <button className="btn-primary btn-sm nc-on" onClick={() => { void act(`e${c.id}`, () => putApi(`/notify/${c.id}`, { enabled: true }), `${c.name} açıldı — yalnız yeni kayıtlar gider`); }} disabled={!!busy}>Aç</button>}
                  {confirmDel === c.id
                    ? <button className="btn-outline btn-sm nc-off" onClick={() => { setConfirmDel(''); void act(`d${c.id}`, () => deleteApi(`/notify/${c.id}`), `${c.name} silindi`); }} disabled={!!busy}><Trash2 size={13} /> Silmeyi onayla</button>
                    : <button className="btn-outline btn-sm nc-off" onClick={() => setConfirmDel(c.id)} disabled={!!busy}><Trash2 size={13} /> Sil</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!data.channels.length && !wizard && <p className="nc-desc">Henüz kanal yok — hiçbir şey dışarı gönderilmiyor.</p>}
        {full && !wizard && <p className="nc-desc">En çok {data.maxChannels} kanal eklenebilir.</p>}
        {wizard && (
          <ChannelWizard key={wizard.edit?.id || 'new'} edit={wizard.edit} resp={data} onClose={() => setWizard(null)}
            onSaved={() => { setWizard(null); void load(); }} />
        )}
      </Panel>
      <DeviceWatchCard resp={data} reload={() => { void load(); }} />
      <Deliveries />
    </div>
  );
}

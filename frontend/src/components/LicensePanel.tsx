import { useState } from 'react';
import { KeyRound, Copy, Info, AlertTriangle, Loader2, RefreshCw, ShieldCheck, Trash2, CheckCircle } from 'lucide-react';
import { useApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { copyText } from '../clipboard';
import { toast } from '../toast';
import './LicensePanel.css';

// Lisans (backend license.ts + licenseRoutes.ts, /api/license): imzalı lisans anahtarı Pi'de çevrimdışı doğrulanır. Şu an tüm
// özellikler Topluluk'tur — lisans olmadan hiçbir şey kapanmaz. Akış: cihaz kodunu kopyala → anahtarı yapıştır → Etkinleştir
// (yeşil); Kaldır (kırmızı) Topluluk'a döner. Uyduda yalnız bilgi. Ham seri numarası hiçbir zaman gelmez (yalnız özet kodu).
type State = 'none' | 'active' | 'grace' | 'expired' | 'invalid' | 'other-device' | 'unverified';
interface LicenseResp {
  plan: string; state: State; reason: string | null; licensedPlan: string | null; lid: string | null; feat: string[];
  bound: boolean; nbf: number | null; exp: number | null; graceUntil: number | null; now: number;
  deviceCode: string; token: string | null; clockSynced: boolean | null;
  supported: boolean; satellite: boolean; allCommunity: boolean; warnDays: number[];
}
const EMPTY: LicenseResp = {
  plan: 'community', state: 'none', reason: null, licensedPlan: null, lid: null, feat: [], bound: false, nbf: null, exp: null,
  graceUntil: null, now: 0, deviceCode: '', token: null, clockSynced: null, supported: true, satellite: false, allCommunity: true,
  warnDays: [14, 3],
};

const PLAN_LABEL: Record<string, string> = { community: 'Topluluk' };
const planLabel = (p: string | null) => (p ? PLAN_LABEL[p] || p.charAt(0).toUpperCase() + p.slice(1) : '—');
const STATE: Record<State, { label: string; variant: 'success' | 'error' | 'info' | 'neutral' | 'warning' }> = {
  none: { label: 'Lisans yok', variant: 'neutral' },
  active: { label: 'Etkin', variant: 'success' },
  grace: { label: 'Ek sürede', variant: 'warning' },
  expired: { label: 'Süresi bitti', variant: 'error' },
  invalid: { label: 'Geçersiz', variant: 'error' },
  'other-device': { label: 'Başka cihaz', variant: 'error' },
  unverified: { label: 'Doğrulanamadı', variant: 'warning' },
};
const REASON: Record<string, string> = {
  format: 'Anahtar biçimi tanınmadı.',
  schema: 'Anahtarın içeriği geçersiz.',
  kid: 'Anahtar bu panel sürümünün tanımadığı bir imza anahtarıyla üretilmiş — paneli güncelleyin.',
  signature: 'Anahtarın imzası doğrulanamadı (değiştirilmiş ya da eksik).',
  'not-yet': 'Lisans henüz başlamadı — cihazın saatini denetleyin.',
};
const fmtDate = (s: number | null) =>
  (s ? new Date(s * 1000).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const daysLeft = (to: number | null, now: number) => (to && now ? Math.ceil((to - now) / 86400) : null);
const TOKEN_RE = /^KLX1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function LicensePanel() {
  const { data, loading, error, refetch } = useApi<LicenseResp>('/license', EMPTY);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'' | 'put' | 'delete'>('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [formError, setFormError] = useState('');

  const d = data;
  const st = STATE[d.state] || STATE.none;
  const hasToken = d.state !== 'none';
  const cleaned = token.replace(/\s+/g, '');
  const canWrite = d.supported && !d.satellite;
  const left = d.state === 'grace' ? daysLeft(d.graceUntil, d.now) : daysLeft(d.exp, d.now);

  const copyCode = async () => {
    if (!d.deviceCode) return;
    if (await copyText(d.deviceCode)) toast.success('Cihaz kodu kopyalandı');
    else toast.error('Kopyalanamadı — kodu seçip elle kopyalayın');
  };
  const activate = async () => {
    setFormError('');
    if (!TOKEN_RE.test(cleaned)) { setFormError('Anahtar KLX1. ile başlamalı ve eksiksiz yapıştırılmalı'); return; }
    setBusy('put');
    try {
      await putApi('/license', { token: cleaned });
      setToken('');
      toast.success('Lisans etkinleştirildi');
      await refetch();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Etkinleştirilemedi');
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await deleteApi('/license');
      setConfirmRemove(false);
      toast.success('Lisans kaldırıldı — Topluluk sürümü');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kaldırılamadı');
    } finally {
      setBusy('');
    }
  };

  return (
    <Panel title="Lisans" icon={<KeyRound size={20} style={{ marginRight: 8 }} />} className="lic-panel"
      subtitle="İmzalı lisans anahtarı Pi'de çevrimdışı doğrulanır — Pi hiçbir lisans sunucusuna bağlanmaz"
      actions={
        <button className="btn-outline btn-sm" onClick={() => void refetch()} disabled={loading || !!busy} aria-label="Yenile">
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Yenile
        </button>
      }>
      {d.allCommunity && (
        <div className="lic-note is-info">
          <Info size={15} />
          <span>Şu an <b>tüm özellikler herkese açık</b> (Topluluk). Ücretli katmanlar sonra belirlenecek; lisans olmadan, süresi bitince
            ya da kaldırılınca hiçbir özellik kapanmaz ve çalışan hiçbir şey kesilmez.</span>
        </div>
      )}
      {error && <div className="lic-note is-error"><AlertTriangle size={15} /><span>Lisans durumu okunamadı: {error}</span></div>}

      <div className="lic-grid">
        <section className="lic-card" aria-label="Durum">
          <div className="lic-card-head">
            <span className="lic-plan">{d.state === 'active' || d.state === 'grace' ? planLabel(d.plan) : 'Topluluk'}</span>
            <Badge variant={st.variant}>{st.label}</Badge>
          </div>
          <dl className="lic-rows">
            {hasToken && <><dt>Lisanstaki katman</dt><dd>{planLabel(d.licensedPlan)}</dd></>}
            {d.lid && <><dt>Lisans no</dt><dd className="lic-mono">{d.lid}</dd></>}
            {d.exp !== null && (
              <><dt>Bitiş</dt><dd>{fmtDate(d.exp)}{d.state === 'active' && left !== null && <span className="lic-muted"> · {left} gün kaldı</span>}</dd></>
            )}
            {d.graceUntil !== null && d.graceUntil !== d.exp && (
              <><dt>Ek süre sonu</dt><dd>{fmtDate(d.graceUntil)}{d.state === 'grace' && left !== null && <span className="lic-muted"> · {left} gün kaldı</span>}</dd></>
            )}
            {hasToken && <><dt>Cihaz bağı</dt><dd>{d.bound ? 'Bu cihaz koduna bağlı' : 'Bağsız (her cihazda geçerli)'}</dd></>}
            {d.token && <><dt>Anahtar</dt><dd className="lic-mono">{d.token}</dd></>}
            {hasToken && d.clockSynced === false && (
              <><dt>Saat</dt><dd>Eşitli değil — son görülen zaman kullanılıyor</dd></>
            )}
          </dl>
          {d.state === 'invalid' && d.reason && <p className="lic-msg is-error">{REASON[d.reason] || 'Anahtar geçersiz.'} Topluluk sürümü geçerli.</p>}
          {d.state === 'other-device' && <p className="lic-msg is-error">Bu lisans başka bir cihaz için üretilmiş. Topluluk sürümü geçerli.</p>}
          {d.state === 'unverified' && <p className="lic-msg is-warn">Lisans cihaza bağlı ama bu cihazın kodu okunamadı. Topluluk sürümü geçerli.</p>}
          {d.state === 'expired' && <p className="lic-msg is-warn">Süre bitti — Topluluk sürümüne dönüldü. Yenilemek için yeni anahtarı yapıştırın.</p>}
          {d.state === 'grace' && <p className="lic-msg is-warn">Süre doldu; ek süre boyunca lisans geçerli. Yenilemek için yeni anahtarı yapıştırın.</p>}
          {d.state === 'none' && <p className="lic-msg">Lisans yüklü değil. Panelin tamamı Topluluk sürümüyle çalışır.</p>}
        </section>

        <section className="lic-card" aria-label="Cihaz kodu">
          <div className="lic-card-head"><span className="lic-card-title"><ShieldCheck size={15} /> Cihaz kodu</span></div>
          {d.deviceCode ? (
            <>
              <div className="lic-code-row">
                <code className="lic-code" aria-label="Cihaz kodu">{d.deviceCode}</code>
                <button className="btn-outline btn-sm" onClick={() => void copyCode()}><Copy size={13} /> Kopyala</button>
              </div>
              <p className="lic-muted lic-small">Lisansı bu cihaza bağlamak için kodu anahtarı aldığınız yere verin. Kod, seri numarasından
                türetilen bir özettir; seri numarasının kendisi gösterilmez. Seri numarası kısa olan cihazlarda koddan bulunabilir: kodu
                yalnız anahtarı aldığınız yerle paylaşın.</p>
            </>
          ) : (
            <p className="lic-msg is-warn">{loading ? 'Okunuyor…' : 'Cihaz kodu okunamadı — yalnız cihaza bağsız lisans kullanılabilir.'}</p>
          )}
        </section>
      </div>

      {d.satellite && (
        <div className="lic-note is-info"><Info size={15} /><span>Bu cihaz uydu — lisans ana cihazda yönetilir; burada yalnız gösterilir.</span></div>
      )}
      {!d.supported && (
        <div className="lic-note is-info"><Info size={15} /><span>Lisans yalnız Pi üzerinde etkinleştirilir.</span></div>
      )}

      {canWrite && (
        <section className="lic-card lic-form" aria-label="Lisans anahtarı">
          <label className="lic-label" htmlFor="lic-token">{hasToken ? 'Yeni lisans anahtarı (yenileme)' : 'Lisans anahtarı'}</label>
          <textarea id="lic-token" className="lic-input" rows={3} spellCheck={false} autoComplete="off" placeholder="KLX1.…"
            value={token} onChange={e => { setToken(e.target.value); setFormError(''); }} disabled={!!busy} />
          {formError && <p className="lic-msg is-error" role="alert">{formError}</p>}
          <div className="lic-actions">
            <button className="btn-primary btn-sm lic-on" onClick={() => void activate()} disabled={!!busy || !cleaned}>
              {busy === 'put' ? <Loader2 size={13} className="spin" /> : <CheckCircle size={13} />} {busy === 'put' ? 'Doğrulanıyor…' : 'Etkinleştir'}
            </button>
            {hasToken && !confirmRemove && (
              <button className="btn-outline btn-sm lic-off" onClick={() => setConfirmRemove(true)} disabled={!!busy}><Trash2 size={13} /> Kaldır</button>
            )}
          </div>
          {hasToken && confirmRemove && (
            <div className="lic-confirm" role="group" aria-label="Kaldırmayı onayla">
              <span>Anahtar silinecek ve Topluluk sürümüne dönülecek. Çalışan hiçbir şey kesilmez.</span>
              <div className="lic-actions">
                <button className="btn-outline btn-sm lic-off" onClick={() => void remove()} disabled={!!busy}>
                  {busy === 'delete' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Evet, kaldır
                </button>
                <button className="btn-outline btn-sm" onClick={() => setConfirmRemove(false)} disabled={!!busy}>Vazgeç</button>
              </div>
            </div>
          )}
        </section>
      )}

      <details className="lic-details">
        <summary>Nasıl çalışır, sınırları</summary>
        <ul>
          <li>Anahtar Pi'de Ed25519 imzasıyla doğrulanır; Pi hiçbir sunucuya bağlanmaz. Yenileme yeni anahtarı yapıştırarak yapılır;
            bitime {d.warnDays.join(' ve ')} gün kala Bildirimler'e yazılır.</li>
          <li>Anahtar /etc/pi5-gateway/license dosyasında yalnız root'un okuyabildiği biçimde durur; panel ayarlarına ve yedeğe girmez.</li>
          <li>Pi'de pil destekli saat yoktur: saat eşitliyken görülen zaman saklanır ve saat eşitli değilken kullanılır; saati geri almak
            süreyi uzatmaz.</li>
          <li>Dürüst sınır: kaynak açıktır ve cihazda yönetici sizsiniz; bu denetim kırılmaz bir koruma değildir. Ayrıntı: Dokümantasyon → Lisans.</li>
        </ul>
      </details>
    </Panel>
  );
}

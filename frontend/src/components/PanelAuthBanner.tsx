import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, KeyRound, LogIn } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';

// Panel erişim koruması (nginx Basic Auth) bandı. Şifreyi kullanıcı belirler; açma her zaman 5 dk'lık denemedir:
// şifreyle girip "Kalıcı yap"a basılmazsa Pi korumayı kendiliğinden geri kapatır (kilitlenme olmaz).
// Koruma kalıcıyken giriş yöntemi de buradan değişir: tarayıcı şifre penceresi (basic) → panelin kendi giriş ekranı (form).
// Geçiş de 5 dk'lık denemedir: yeni ekrandan girip "Kalıcı yap"a basılmazsa şifre penceresine kendiliğinden dönülür.
interface PanelAuthStatus {
  state: 'pending' | 'trial' | 'on' | 'legacy' | 'unsupported' | 'error';
  user?: string; password_set?: boolean; trial_ends?: number; now?: number; error?: string;
  mode?: 'basic' | 'form'; mode_trial_ends?: number;
}

const MIN_LEN = 12;
const OFFER_KEY = 'pi5-login-offer-dismissed';
const offerDismissed = () => { try { return localStorage.getItem(OFFER_KEY) === '1'; } catch { return false; } };

export function PanelAuthBanner() {
  // Durum okunamazsa (eski backend, ağ hatası) veri null kalır ve bant gizlenir — panel etkilenmez.
  const { data: st, refetch } = useApi<PanelAuthStatus | null>('/panel-auth/status', null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(offerDismissed);
  const load = refetch;

  // Deneme sırasında geri sayım (sunucu saatine göre kalan) + 10 sn'de bir durum (süre dolunca bant "hazır"a döner).
  // İki deneme türü: korumanın açılması (state=trial) ve giriş ekranına geçiş (mode=form, mode_trial_ends).
  const modeTrial = st?.state === 'on' && st.mode === 'form' && (st.mode_trial_ends || 0) > 0;
  const trialEnds = st?.state === 'trial' ? st.trial_ends || 0 : modeTrial ? st?.mode_trial_ends || 0 : 0;
  const skew = st?.now ? st.now * 1000 : 0;
  useEffect(() => {
    if (!trialEnds) return;
    const startedAt = performance.now();
    const update = () => setLeft(Math.max(0, Math.round(trialEnds - (skew + performance.now() - startedAt) / 1000)));
    const first = setTimeout(update, 0);
    const tick = setInterval(update, 1000);
    const poll = setInterval(() => { void refetch(); }, 10000);
    return () => { clearTimeout(first); clearInterval(tick); clearInterval(poll); };
  }, [trialEnds, skew, refetch]);

  if (!st || st.state === 'unsupported' || st.state === 'error' || st.state === 'legacy') return null;
  // Koruma kalıcı: yalnız giriş ekranı önerisi (şifre penceresindeyken, kapatılmadıysa) ya da geçiş denemesi gösterilir.
  if (st.state === 'on' && !modeTrial && (st.mode === 'form' || dismissed)) return null;

  const fmtLeft = () => {
    const rem = left ?? 0;
    return left === null ? '…' : `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
  };

  const switchToForm = async () => {
    if (!confirm(
      'Panelin kendi giriş ekranı 5 dakikalık deneme olarak açılacak.\n\n' +
      '• Sayfa yenilenecek ve giriş ekranı açılacak.\n' +
      '• Aynı kullanıcı adı (admin) ve şifreyle gir, sonra üstteki "Kalıcı yap" düğmesine bas.\n' +
      '• 5 dakika içinde basmazsan tarayıcının şifre penceresine kendiliğinden dönülür.\n\nDevam edilsin mi?',
    )) return;
    setBusy(true);
    try {
      await postApi('/panel-auth/mode', { mode: 'form' });
      toast.success('Giriş ekranı deneme olarak açıldı — sayfa yenileniyor');
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Giriş ekranına geçilemedi');
      setBusy(false);
    }
  };

  const dismissOffer = () => {
    try { localStorage.setItem(OFFER_KEY, '1'); } catch { /* depolama erişilemez: yalnız bu oturumda gizlenir */ }
    setDismissed(true);
  };

  const confirmMode = async () => {
    setBusy(true);
    try {
      await postApi('/panel-auth/mode/confirm', {});
      toast.success('Giriş ekranı kalıcı olarak açık');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Onaylanamadı');
      await load();
    }
    setBusy(false);
  };

  const rollbackMode = async () => {
    setBusy(true);
    try {
      await postApi('/panel-auth/mode/rollback', {});
      toast.info('Tarayıcının şifre penceresine dönüldü — sayfa yenileniyor');
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Geri alınamadı');
      setBusy(false);
    }
  };

  if (st.state === 'on' && modeTrial) {
    return (
      <div className="panel-auth-banner panel-auth-trial" role="status">
        <LogIn size={16} />
        <span>
          <strong>Yeni giriş ekranı deneniyor</strong> — kalan {fmtLeft()}. Giriş ekranından girebildiysen kalıcı yap; yapmazsan süre dolunca tarayıcının şifre penceresine dönülür.
        </span>
        <div className="panel-auth-actions">
          <button className="btn-primary btn-sm" onClick={confirmMode} disabled={busy}>Giriş çalıştı — kalıcı yap</button>
          <button className="btn-outline btn-sm" onClick={rollbackMode} disabled={busy}>Şifre penceresine dön</button>
        </div>
      </div>
    );
  }

  if (st.state === 'on') {
    return (
      <div className="panel-auth-banner panel-auth-offer" role="status">
        <LogIn size={16} />
        <span>
          <strong>Yeni giriş ekranı hazır.</strong> Tarayıcının şifre penceresi yerine panelin kendi giriş sayfası: çıkış düğmesi ve hatalı deneme sınırıyla. Geçiş 5 dakikalık denemedir.
        </span>
        <div className="panel-auth-actions">
          <button className="btn-primary btn-sm" onClick={switchToForm} disabled={busy}>Yeni girişe geç (5 dk deneme)</button>
          <button className="btn-outline btn-sm" onClick={dismissOffer} disabled={busy}>Şimdi değil</button>
        </div>
      </div>
    );
  }

  const savePassword = async () => {
    if (pw.length < MIN_LEN) { toast.error(`Şifre en az ${MIN_LEN} karakter olmalı`); return; }
    if (pw !== pw2) { toast.error('Şifreler eşleşmiyor'); return; }
    setBusy(true);
    try {
      await postApi('/panel-auth/password', { password: pw });
      setPw(''); setPw2(''); setEditing(false);
      toast.success('Panel şifresi kaydedildi');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Şifre kaydedilemedi');
    }
    setBusy(false);
  };

  const activate = async () => {
    if (!confirm(
      'Koruma 5 dakikalık deneme olarak açılacak.\n\n' +
      '• Sayfa yenilenecek ve tarayıcı kullanıcı adı (admin) ile şifreni soracak.\n' +
      '• Girebilirsen üstteki "Kalıcı yap" düğmesine bas.\n' +
      '• 5 dakika içinde basmazsan koruma kendiliğinden kapanır.\n\nDevam edilsin mi?',
    )) return;
    setBusy(true);
    try {
      await postApi('/panel-auth/activate', {});
      toast.success('Koruma deneme olarak açıldı — sayfa yenileniyor, şifreni gir');
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Koruma açılamadı');
      setBusy(false);
    }
  };

  const confirmOn = async () => {
    setBusy(true);
    try {
      await postApi('/panel-auth/confirm', {});
      toast.success('Panel koruması kalıcı olarak açık');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Onaylanamadı');
      await load();
    }
    setBusy(false);
  };

  const rollback = async () => {
    setBusy(true);
    try {
      await postApi('/panel-auth/rollback', {});
      toast.info('Koruma kapatıldı');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Geri alınamadı');
    }
    setBusy(false);
  };

  if (st.state === 'trial') {
    return (
      <div className="panel-auth-banner panel-auth-trial" role="status">
        <ShieldCheck size={16} />
        <span>
          <strong>Koruma deneniyor</strong> — kalan {fmtLeft()}. Şifreyle girebildiysen kalıcı yap; yapmazsan süre dolunca koruma kendiliğinden kapanır.
        </span>
        <div className="panel-auth-actions">
          <button className="btn-primary btn-sm" onClick={confirmOn} disabled={busy}>Giriş çalıştı — kalıcı yap</button>
          <button className="btn-outline btn-sm" onClick={rollback} disabled={busy}>Geri al</button>
        </div>
      </div>
    );
  }

  const showForm = !st.password_set || editing;
  return (
    <div className="panel-auth-banner" role="status">
      <ShieldAlert size={16} />
      <div className="panel-auth-body">
        <span>
          <strong>Panel şifresiz.</strong> Ev ağındaki herhangi bir cihaz paneli açıp Pi'de komut çalıştırabilir.
          {st.password_set && !editing && <> Şifren kayıtlı; hazır olduğunda korumayı aç (kullanıcı adı: <code>{st.user || 'admin'}</code>).</>}
        </span>
        {showForm ? (
          <div className="panel-auth-form">
            <KeyRound size={14} />
            <input className="config-input" type="password" autoComplete="new-password" placeholder={`Yeni şifre (en az ${MIN_LEN} karakter)`}
              value={pw} onChange={e => setPw(e.target.value)} />
            <input className="config-input" type="password" autoComplete="new-password" placeholder="Şifre (tekrar)"
              value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && savePassword()} />
            <button className="btn-primary btn-sm" onClick={savePassword} disabled={busy || !pw || !pw2}>Şifreyi kaydet</button>
            {editing && <button className="btn-outline btn-sm" onClick={() => { setEditing(false); setPw(''); setPw2(''); }}>İptal</button>}
          </div>
        ) : (
          <div className="panel-auth-actions">
            <button className="btn-primary btn-sm" onClick={activate} disabled={busy}>Korumayı aç (5 dk deneme)</button>
            <button className="btn-outline btn-sm" onClick={() => setEditing(true)} disabled={busy}>Şifreyi değiştir</button>
          </div>
        )}
      </div>
    </div>
  );
}

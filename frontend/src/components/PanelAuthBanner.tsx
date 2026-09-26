import { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, KeyRound } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';

// Panel erişim koruması (nginx Basic Auth) bandı. Şifreyi kullanıcı belirler; açma her zaman 5 dk'lık denemedir:
// şifreyle girip "Kalıcı yap"a basılmazsa Pi korumayı kendiliğinden geri kapatır (kilitlenme olmaz).
interface PanelAuthStatus {
  state: 'pending' | 'trial' | 'on' | 'legacy' | 'unsupported' | 'error';
  user?: string; password_set?: boolean; trial_ends?: number; now?: number; error?: string;
}

const MIN_LEN = 12;

export function PanelAuthBanner() {
  // Durum okunamazsa (eski backend, ağ hatası) veri null kalır ve bant gizlenir — panel etkilenmez.
  const { data: st, refetch } = useApi<PanelAuthStatus | null>('/panel-auth/status', null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const load = refetch;

  // Deneme sırasında geri sayım (sunucu saatine göre kalan) + 10 sn'de bir durum (süre dolunca bant "hazır"a döner).
  const trialEnds = st?.state === 'trial' ? st.trial_ends || 0 : 0;
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

  if (!st || st.state === 'on' || st.state === 'unsupported' || st.state === 'error' || st.state === 'legacy') return null;

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
    const rem = left ?? 0;
    const m = Math.floor(rem / 60);
    const s = String(rem % 60).padStart(2, '0');
    return (
      <div className="panel-auth-banner panel-auth-trial" role="status">
        <ShieldCheck size={16} />
        <span>
          <strong>Koruma deneniyor</strong> — kalan {left === null ? '…' : `${m}:${s}`}. Şifreyle girebildiysen kalıcı yap; yapmazsan süre dolunca koruma kendiliğinden kapanır.
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

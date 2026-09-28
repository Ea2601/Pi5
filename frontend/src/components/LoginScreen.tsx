import { useEffect, useRef, useState } from 'react';
import { User, Lock, Eye, EyeOff, LogIn, AlertCircle, Loader2 } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { BRAND } from '../brand';
import { login } from '../auth';

// Panelin kendi giriş ekranı (panel-auth "mode form"). Kullanıcı adı ve şifre panel koruması ile aynıdır (htpasswd);
// başarıda arka uç HttpOnly oturum çerezi yazar. Mobile-first: telefonda tam ekran kart, geniş ekranda ortalı.
export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => { pwRef.current?.focus(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    const r = await login(username.trim(), password, remember);
    setBusy(false);
    if (r.ok) { setPassword(''); onSuccess(); return; }
    setError(r.error);
    setPassword('');
    if (r.reload) { setTimeout(() => window.location.reload(), 1500); return; }
    pwRef.current?.focus();
  };

  return (
    <div className="login-screen">
      <div className="login-bg" aria-hidden="true">
        <svg viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
          <line x1="120" y1="140" x2="360" y2="260" /><line x1="360" y1="260" x2="600" y2="400" />
          <line x1="600" y1="400" x2="880" y2="250" /><line x1="880" y1="250" x2="1080" y2="360" />
          <line x1="600" y1="400" x2="820" y2="620" /><line x1="600" y1="400" x2="330" y2="600" />
          <line x1="330" y1="600" x2="140" y2="520" /><line x1="820" y1="620" x2="1060" y2="660" />
          <line x1="880" y1="250" x2="960" y2="90" /><line x1="360" y1="260" x2="300" y2="80" />
          <line className="login-flow" x1="120" y1="140" x2="600" y2="400" />
          <line className="login-flow login-flow-b" x1="600" y1="400" x2="1080" y2="360" />
          <line className="login-flow login-flow-b" x1="140" y1="520" x2="600" y2="400" />
          <line className="login-flow" x1="600" y1="400" x2="1060" y2="660" />
          <circle cx="120" cy="140" r="3" /><circle cx="360" cy="260" r="3.5" /><circle cx="880" cy="250" r="3.5" />
          <circle cx="1080" cy="360" r="3" /><circle cx="820" cy="620" r="3" /><circle cx="330" cy="600" r="3" />
          <circle cx="140" cy="520" r="2.5" /><circle cx="1060" cy="660" r="2.5" /><circle cx="960" cy="90" r="2.5" />
          <circle cx="300" cy="80" r="2.5" />
          <circle className="login-hub" cx="600" cy="400" r="6" />
        </svg>
      </div>

      <main className="glass-panel login-card">
        <div className="login-brand">
          <BrandMark size={52} />
          <div>
            <div className="login-wordmark">{BRAND.wordmarkPrimary}<span>{BRAND.wordmarkSecondary}</span></div>
            <div className="login-tagline">{BRAND.tagline}</div>
          </div>
        </div>

        <h1 className="login-title">Yönetim paneline giriş</h1>
        <p className="login-lead">Devam etmek için panel kullanıcı adınızı ve şifrenizi girin.</p>

        <form className="login-form" onSubmit={submit} autoComplete="on">
          {error && (
            <div className="login-error" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <label className="login-label">
            Kullanıcı adı
            <span className="login-field">
              <User size={18} />
              <input className="login-input" type="text" name="username" value={username}
                onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none"
                spellCheck={false} required />
            </span>
          </label>

          <label className="login-label">
            Şifre
            <span className="login-field">
              <Lock size={18} />
              <input ref={pwRef} className={`login-input ${error ? 'login-input-error' : ''}`}
                type={reveal ? 'text' : 'password'} name="password" value={password}
                onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
              <button type="button" className="login-reveal" onClick={() => setReveal(v => !v)}
                aria-label={reveal ? 'Şifreyi gizle' : 'Şifreyi göster'} title={reveal ? 'Şifreyi gizle' : 'Şifreyi göster'}>
                {reveal ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>

          <label className="login-check">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Bu cihazda 30 gün hatırla
          </label>

          <button className="login-submit" type="submit" disabled={busy || !username.trim() || !password}>
            {busy ? <Loader2 size={18} className="spin" /> : <LogIn size={18} />}
            {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>

        <div className="login-meta">
          <span className="login-status"><span className="login-dot" /> Pi çevrimiçi</span>
          <code>{window.location.host}</code>
        </div>
        <details className="login-help">
          <summary>Şifremi unuttum</summary>
          <p>
            Pi'ye SSH ile bağlanıp (kullanıcı <code>admin</code>) yeni şifre belirleyin:{' '}
            <code>sudo bash /opt/pi5-gateway/scripts/panel-auth.sh reset</code>
          </p>
        </details>
      </main>
      <footer className="login-footer">{BRAND.name} — yalnız yetkili yönetici erişimi</footer>
    </div>
  );
}

// Panel giriş ekranı (panel-auth "mode form"): arka uç oturumsuz /api isteğine 401 + "X-Pi5-Auth: required" döner.
// Yakalayıcı bunu tek yerde görür (useApi, postApi ve bileşenlerdeki doğrudan fetch'ler dahil) ve olay yayınlar;
// App giriş ekranını açar. "basic" modda (tarayıcı şifre penceresi) bu yol hiç devreye girmez.
export const AUTH_REQUIRED_EVENT = 'pi5:auth-required';

export interface AuthStatus {
  mode: 'basic' | 'form';
  trial_ends: number;
  authenticated: boolean;
  loopback: boolean;
  user?: string;
  now: number;
}

let installed = false;
export function installAuthInterceptor(): void {
  if (installed) return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    if (res.status === 401 && res.headers.get('X-Pi5-Auth') === 'required') {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      // Gövdesiz iletilir: res.ok'a bakmadan .json() okuyan çağrılar (şifre penceresi modunda nginx'in HTML 401'inde
      // olduğu gibi) hata alır ve {error} gövdesini veri sanıp bileşeni çökertmez.
      return new Response(null, { status: 401, statusText: res.statusText, headers: res.headers });
    }
    return res;
  }) as typeof window.fetch;
}

// Eski arka uç (uç yok) ya da ağ hatası → null: panel eskisi gibi açılır.
export async function fetchAuthStatus(): Promise<AuthStatus | null> {
  try {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return json && (json.mode === 'form' || json.mode === 'basic') ? json as AuthStatus : null;
  } catch {
    return null;
  }
}

export type LoginResult = { ok: true } | { ok: false; error: string; reload?: boolean };

export async function login(username: string, password: string, remember: boolean): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, remember }),
    });
  } catch {
    return { ok: false, error: 'Pi\'ye ulaşılamadı — bağlantınızı kontrol edip yeniden deneyin' };
  }
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (res.ok) return { ok: true };
  if (res.status === 401) {
    const left = typeof json.remaining === 'number' ? json.remaining : null;
    const tail = left === null ? ''
      : left > 0 ? ` ${left} deneme hakkınız kaldı; sonra bu cihaz 15 dakika bekletilir.`
        : ' Bu cihaz 15 dakika bekletilecek.';
    return { ok: false, error: `Kullanıcı adı ya da şifre hatalı.${tail}` };
  }
  if (res.status === 409) return { ok: false, error: 'Giriş ekranı kapatılmış — sayfa yenileniyor…', reload: true };
  return { ok: false, error: typeof json.error === 'string' ? json.error : `Giriş yapılamadı (HTTP ${res.status})` };
}

export async function logout(): Promise<void> {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* çerez yine de süresi dolunca geçersizleşir */ }
}

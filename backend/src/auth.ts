// Panel giriş ekranı (panel-auth.sh "mode form"): nginx şifre sormaz; /api isteklerini burası oturum çereziyle denetler.
// Mod dosyası yoksa ya da "basic" ise hiçbir şey yapılmaz (nginx Basic Auth eskisi gibi korur).
//  - Şifre: panel-auth.sh'nin yazdığı htpasswd'deki SHA-512 crypt özeti (openssl passwd -6); düz metin tutulmaz.
//  - Oturum: durumsuz imzalı çerez. İmza anahtarı = gizli anahtar + kullanıcının özet satırı → şifre değişince (reset) ya da
//    kullanıcı silinince (sonda kullanıcısı) o kullanıcının tüm oturumları geçersiz olur.
//  - Deneme sınırı: IP başına 15 dk'da 5 yanlış → 15 dk bekleme; tüm IP'ler toplamı dakikada 20 yanlış.
//  - Muaf: Pi'nin kendisi (loopback: kiosk, OLED, yerel betikler), giriş uçları ve kurulum Wi-Fi'ının /api/captive'i.
// Mod dosyası var ama okunamıyorsa (izin vb.) denetim AÇIK sayılır (kapalı kalmaktansa giriş istemek güvenli taraftır).
import type express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';

const MODE_FILE = '/etc/pi5-gateway/panel-auth.mode';
const KEY_FILE = '/etc/pi5-gateway/panel-session.key';
const HTPASSWD = '/etc/nginx/pi5-gateway.htpasswd';
const COOKIE = 'pi5_session';
const SESSION_TTL_S = 12 * 3600;
const REMEMBER_TTL_S = 30 * 24 * 3600;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 5;
const GLOBAL_FAIL_MAX_PER_MIN = 20;
// Oturumsuz erişilebilen uçlar (req.originalUrl'ün yolu birebir). Kodlanmış/../ içeren yollar bunlara denk sayılmaz.
// /api/mesh/pair ve /api/mesh/sync: uydular (R2) ana cihaza oturumsuz gelir; kimliği 6 haneli kod / uyduya özel anahtar
// kanıtlar (mesh.ts). /api/app/pair: Klyrix/Gate uygulaması eşleşmesi; sahipliği panel şifresi ya da paneldeki kod kanıtlar
// (gateApp.ts). panel-auth.sh'nin nginx haritası da aynı yolları muaf tutar.
const EXEMPT = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/captive', '/api/mesh/pair', '/api/mesh/sync', '/api/app/pair']);

export type LoginMode = 'basic' | 'form';

// Pi'nin kendisi (nginx arkasında trust proxy=loopback ile req.ip gerçek istemcidir; LAN'dan sahte X-Forwarded-For işe yaramaz).
export const isLoopbackIp = (ip: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || ''));

// Önbellek dosyanın kimliğine (inode + değişiklik zamanı + boyut) bağlıdır, süreye değil: panel-auth.sh dosyayı
// "yaz → taşı" ile değiştirir; her istekte stat yapılır ve değişiklik aynı istekte görülür. (Süreli önbellek, form'a
// geçişte nginx şifreyi bıraktığı anda arka ucun eski modu görüp API'yi kısa süre açık bırakmasına yol açardı.)
const fileSig = (st: fs.Stats) => `${st.ino}:${st.mtimeMs}:${st.size}`;

let modeCache: { sig: string; mode: LoginMode; trialEnds: number } | null = null;
export function readLoginMode(): { mode: LoginMode; trialEnds: number } {
  let sig: string;
  try {
    sig = fileSig(fs.statSync(MODE_FILE));
  } catch (err) {
    // Dosya yok → şifre penceresi modu (eski davranış). Başka bir hata → denetim açık.
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { mode: 'basic', trialEnds: 0 } : { mode: 'form', trialEnds: 0 };
  }
  if (modeCache && modeCache.sig === sig) return modeCache;
  let mode: LoginMode = 'form';
  let trialEnds = 0;
  try {
    const [m, e] = fs.readFileSync(MODE_FILE, 'utf8').trim().split(/\s+/);
    mode = m === 'basic' ? 'basic' : 'form';
    trialEnds = Number(e) || 0;
  } catch {
    return { mode: 'form', trialEnds: 0 };
  }
  modeCache = { sig, mode, trialEnds };
  return modeCache;
}

// htpasswd: "kullanıcı:özet" satırları (dosya kimliğine göre önbellekli).
let pwCache: { sig: string; users: Map<string, string> } | null = null;
function readUsers(): Map<string, string> {
  try {
    const st = fs.statSync(HTPASSWD);
    if (pwCache && pwCache.sig === fileSig(st)) return pwCache.users;
    const users = new Map<string, string>();
    for (const line of fs.readFileSync(HTPASSWD, 'utf8').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) users.set(line.slice(0, i), line.slice(i + 1).trim());
    }
    pwCache = { sig: fileSig(st), users };
    return users;
  } catch {
    return new Map();
  }
}

let secretCache: Buffer | null = null;
function sessionSecret(): Buffer {
  if (secretCache) return secretCache;
  try {
    secretCache = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    fs.mkdirSync('/etc/pi5-gateway', { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    secretCache = key;
  }
  if (secretCache.length < 32) throw new Error('oturum anahtarı bozuk');
  return secretCache;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function sign(user: string, hashLine: string, payload: string): Buffer {
  const key = crypto.createHmac('sha256', sessionSecret()).update(`${user}:${hashLine}`).digest();
  return crypto.createHmac('sha256', key).update(payload).digest();
}

function issueToken(user: string, hashLine: string, ttl: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ u: user, iat: now, exp: now + ttl }));
  return `v1.${payload}.${b64url(sign(user, hashLine, payload))}`;
}

function verifyToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  let data: { u?: unknown; exp?: unknown };
  try { data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (typeof data.u !== 'string' || typeof data.exp !== 'number' || data.exp <= Math.floor(Date.now() / 1000)) return null;
  const hashLine = readUsers().get(data.u);
  if (!hashLine) return null;
  let expected: Buffer;
  try { expected = sign(data.u, hashLine, parts[1]); } catch { return null; }
  const got = Buffer.from(parts[2], 'base64url');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected) ? data.u : null;
}

function readCookie(req: express.Request, name: string): string | null {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionUser(req: express.Request): string | null {
  const t = readCookie(req, COOKIE);
  return t ? verifyToken(t) : null;
}

// SHA-512 crypt ($6$tuz$özet) doğrulaması: aynı tuzla openssl'e yeniden özetletilir, sabit sürede karşılaştırılır.
// Şifre stdin'den verilir (argv'ye/loga girmez).
const CRYPT6 = /^\$6\$([./0-9A-Za-z]{1,16})\$[./0-9A-Za-z]{86}$/;
function cryptSha512(password: string, salt: string): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn('openssl', ['passwd', '-6', '-salt', salt, '-stdin'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.on('data', d => { if (out.length < 512) out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? out.trim() : null); });
    child.stdin.on('error', () => { /* openssl stdin'i okumadan çıktı */ });
    child.stdin.end(`${password}\n`);
  });
}
async function checkPassword(user: string, password: string): Promise<string | null> {
  const hashLine = readUsers().get(user);
  const m = hashLine ? CRYPT6.exec(hashLine) : null;
  // Kullanıcı yoksa da aynı iş yapılır (yanıt süresi kullanıcının varlığını ele vermesin).
  const computed = await cryptSha512(password, m ? m[1] : 'pi5dummysalt0000');
  if (!hashLine || !m || !computed) return null;
  const a = Buffer.from(computed);
  const b = Buffer.from(hashLine);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? hashLine : null;
}

// Deneme sınırı (bellekte; yeniden başlatmada sıfırlanır).
const fails = new Map<string, { count: number; first: number; blockedUntil: number }>();
const globalFails: number[] = [];
function blockedFor(ip: string): number {
  const now = Date.now();
  const f = fails.get(ip);
  if (f && f.blockedUntil > now) return Math.ceil((f.blockedUntil - now) / 1000);
  while (globalFails.length && now - globalFails[0] > 60000) globalFails.shift();
  if (globalFails.length >= GLOBAL_FAIL_MAX_PER_MIN) return 60;
  return 0;
}
function recordFail(ip: string): number {
  const now = Date.now();
  globalFails.push(now);
  let f = fails.get(ip);
  if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now, blockedUntil: 0 };
  f.count += 1;
  if (f.count >= FAIL_MAX) f.blockedUntil = now + FAIL_WINDOW_MS;
  fails.set(ip, f);
  if (fails.size > 5000) for (const [k, v] of fails) if (now - v.first > FAIL_WINDOW_MS && v.blockedUntil < now) fails.delete(k);
  return Math.max(0, FAIL_MAX - f.count);
}

// Uygulama kapısından gelen istek işareti (gateApp.ts koyar): yalnız sunucu tarafında, istek nesnesinin kendi alanı
export const GATE_APP = Symbol('klyrix-gate-app');
export function isGateAppRequest(req: unknown): boolean {
  return !!(req as Record<symbol, unknown>)[GATE_APP];
}

// Panel şifresi kurulu mu (htpasswd'de kullanıcı var mı): Klyrix/Gate uygulaması eşleşme ekranında şifre seçeneği
export function panelPasswordSet(): boolean {
  return readUsers().size > 0;
}

// Panel şifresi (htpasswd'deki herhangi bir kullanıcının şifresi) — Klyrix/Gate uygulaması eşleşmesinde sahiplik kanıtı.
// Giriş ekranıyla aynı deneme sınırı (IP başına 15 dk'da 5 yanlış). Panel koruması hiç kurulmadıysa (kullanıcı yok) 'none'.
export async function verifyPanelPassword(password: unknown, ip: string): Promise<'ok' | 'bad' | 'none' | { wait: number }> {
  const wait = blockedFor(ip);
  if (wait > 0) return { wait };
  const users = [...readUsers().keys()];
  if (!users.length) return 'none';
  const pw = typeof password === 'string' ? password : '';
  const valid = pw.length > 0 && Buffer.byteLength(pw, 'utf8') <= 512 && !/[\r\n\0]/.test(pw);
  for (const u of users) {
    if (valid && await checkPassword(u, pw)) {
      fails.delete(ip);
      return 'ok';
    }
  }
  recordFail(ip);
  await new Promise(r => setTimeout(r, 400));
  return 'bad';
}

const cookieAttrs = 'Path=/; HttpOnly; SameSite=Strict';
const originalPath = (req: express.Request) => String(req.originalUrl || '').split('?')[0];

// /api kapısı: giriş ekranı modunda oturumsuz istekler 401 (+ X-Pi5-Auth: required → arayüz giriş ekranını açar).
export const authGate: express.RequestHandler = (req, res, next) => {
  if (readLoginMode().mode !== 'form') return next();
  if (EXEMPT.has(originalPath(req)) || isLoopbackIp(req.ip)) return next();
  // Klyrix/Gate uygulama kapısı (gateApp.ts): isteği kendi dinleyicisi, eşleşmiş WireGuard eşinden geldiği doğrulanınca
  // işaretler (istemci bunu başlıkla koyamaz — nesnenin sembol alanıdır)
  if (isGateAppRequest(req)) return next();
  const user = sessionUser(req);
  if (user) { res.locals.pi5User = user; return next(); }
  res.set('Cache-Control', 'no-store');
  res.set('X-Pi5-Auth', 'required');
  res.status(401).json({ error: 'Oturum açmanız gerekiyor', auth: 'required' });
};

export function registerAuthRoutes(app: express.Express): void {
  app.use('/api/auth', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/auth/status', (req, res) => {
    const { mode, trialEnds } = readLoginMode();
    const loopback = isLoopbackIp(req.ip);
    const user = mode === 'form' ? sessionUser(req) : null;
    // Klyrix/Gate uygulaması: kimliği eşleşmiş telefonun tünelidir — giriş ekranı ve çıkış düğmesi yok
    const app = isGateAppRequest(req);
    res.json({
      mode, trial_ends: trialEnds, loopback,
      // basic: nginx zaten doğruladı (buraya ulaştıysa). form: geçerli çerez, Pi'nin kendisi ya da uygulama kapısı.
      authenticated: mode === 'basic' || loopback || app || !!user,
      ...(app ? { app: true } : {}),
      user: user || undefined,
      now: Math.floor(Date.now() / 1000),
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    if (readLoginMode().mode !== 'form') return res.status(409).json({ error: 'Giriş ekranı kapalı — sayfayı yenileyin' });
    const ip = String(req.ip || '');
    const wait = blockedFor(ip);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Çok fazla hatalı deneme — ${Math.ceil(wait / 60)} dk sonra yeniden deneyin`, retry_after: wait });
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const remember = req.body?.remember === true;
    const valid = username.length > 0 && username.length <= 64 && /^[A-Za-z0-9._-]+$/.test(username)
      && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 512 && !/[\r\n\0]/.test(password);
    const hashLine = valid ? await checkPassword(username, password) : null;
    if (!hashLine) {
      const remaining = recordFail(ip);
      // Kısa gecikme: tahmin denemelerini yavaşlatır.
      await new Promise(r => setTimeout(r, 400));
      return res.status(401).json({ error: 'Kullanıcı adı ya da şifre hatalı', remaining });
    }
    fails.delete(ip);
    let token: string;
    try {
      token = issueToken(username, hashLine, remember ? REMEMBER_TTL_S : SESSION_TTL_S);
    } catch (e) {
      console.error('[auth] oturum anahtarı:', e instanceof Error ? e.message : e);
      return res.status(500).json({ error: 'Oturum oluşturulamadı' });
    }
    res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs}${remember ? `; Max-Age=${REMEMBER_TTL_S}` : ''}`);
    res.json({ success: true, user: username });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.append('Set-Cookie', `${COOKIE}=; ${cookieAttrs}; Max-Age=0`);
    res.json({ success: true });
  });
}

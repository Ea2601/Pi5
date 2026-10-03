// Bağlantı yöneticisi: seçili cihaz için uygulama içi WireGuard tüneli (telefonda VPN yok) + yerel vekil (panel).
//  - Uygulama açılınca bağlanır; arka plana geçince 60 sn sonra tünel kapanır, öne gelince yeniden kurulur (karar: arka
//    planda bağlı kalmaz).
//  - Uç adresler sırayla: evdeyken (Wi-Fi / kablo) önce Pi'nin ev ağı adresleri, sonra dış adres (DDNS / dış IP).
//  - 15 sn'de bir kapı yoklanır; yanıt yoksa (ağ değişti, Pi'de Ev VPN'i yeniden başladı) uç adresler yeniden denenir.
//  - Vekil uygulama süreci boyunca açık kalır: panel (WebView) tünel yeniden kurulunca aynı adresle sürer.
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import WG from '../modules/klyrix-wg/index.ts';
import { endpoints, errText } from './core/gate.ts';
import { loadKey, type SavedDevice } from './platform/store.ts';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'error';
export interface ConnState {
  piId: string | null; status: ConnStatus; via: 'lan' | 'remote' | null; ms: number; error: string;
  panelUrl: string | null; // http://127.0.0.1:<port>/?k=<sır> (WebView'ın ilk adresi)
}
let state: ConnState = { piId: null, status: 'idle', via: null, ms: 0, error: '', panelUrl: null };
const listeners = new Set<(s: ConnState) => void>();
function publish(patch: Partial<ConnState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}
export function subscribeConn(l: (s: ConnState) => void): () => void {
  listeners.add(l);
  l(state);
  return () => { listeners.delete(l); };
}
export const wgSupported = !!WG;

let current: SavedDevice | null = null;
let gen = 0;
let health: ReturnType<typeof setInterval> | null = null;
let bgTimer: ReturnType<typeof setTimeout> | null = null;

async function onLan(): Promise<boolean> {
  const n = await Network.getNetworkStateAsync().catch(() => null);
  return n?.type === Network.NetworkStateType.WIFI || n?.type === Network.NetworkStateType.ETHERNET;
}

// İlk el sıkışma birkaç yüz ms sürebilir: kısa aralıklarla birkaç deneme
async function probeFew(n: number, ms: number): Promise<number> {
  let last: unknown = new Error("Pi'ye ulaşılamadı");
  for (let i = 0; i < n; i++) {
    try { return await WG!.probe(ms); } catch (e) { last = e; }
  }
  throw last;
}

function stopHealth(): void {
  if (health) clearInterval(health);
  health = null;
}

async function check(): Promise<void> {
  if (!WG || !current || state.status !== 'connected') return;
  try {
    publish({ ms: await WG.probe(3000) });
  } catch {
    if (current) void connect(current);
  }
}

export async function connect(d: SavedDevice): Promise<void> {
  const my = ++gen;
  current = d;
  stopHealth();
  if (!WG) { publish({ piId: d.piId, status: 'error', via: null, error: 'Bu telefonda desteklenmiyor (şimdilik yalnız Android)' }); return; }
  publish({ piId: d.piId, status: 'connecting', via: null, error: '' });
  const key = await loadKey(d.piId);
  if (!key) { publish({ status: 'error', error: 'Bu cihazın anahtarı telefonda yok — cihazı kaldırıp yeniden ekleyin' }); return; }
  const eps = endpoints(d, await onLan());
  let lastErr = eps.length ? "Pi'ye ulaşılamadı" : "Pi'nin adresi yok";
  let started = false;
  for (const ep of eps) {
    if (my !== gen) return;
    try {
      if (!started) {
        await WG.start(key, d.address, d.serverPublicKey, ep.endpoint);
        started = true;
      } else {
        await WG.setEndpoint(ep.endpoint);
      }
      const ms = await probeFew(3, 1500);
      if (my !== gen) return;
      publish({ status: 'connected', via: ep.via, ms, error: '', panelUrl: await WG.proxyStart() });
      health = setInterval(() => { void check(); }, 15_000);
      return;
    } catch (e) {
      lastErr = errText(e);
    }
  }
  if (my === gen) publish({ status: 'error', error: lastErr });
}

export async function disconnect(): Promise<void> {
  gen++;
  stopHealth();
  await WG?.stop().catch(() => {});
  publish({ status: 'idle', via: null, ms: 0, error: '' });
}

// Cihaz silinince: bağlıysa kopar ve unut
export async function forgetCurrent(piId: string): Promise<void> {
  if (current?.piId !== piId) return;
  await disconnect();
  current = null;
  publish({ piId: null });
}

// Vekilden Pi'ye istek (uygulamanın yerel ekranları; sır başlıkta, çerez WebView'da)
export async function piRequest(path: string, init: { method: string; body?: string } = { method: 'GET' }): Promise<{ status: number; json: any }> {
  const m = state.panelUrl ? /^(http:\/\/127\.0\.0\.1:\d+)\/\?k=([0-9a-f]+)$/.exec(state.panelUrl) : null;
  if (!m || state.status !== 'connected') throw new Error("Pi'ye bağlı değil");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(`${m[1]}${path}`, {
      method: init.method, body: init.body, signal: ctl.signal,
      headers: { 'X-Klyrix-Key': m[2], ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* düz metin */ }
    return { status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

AppState.addEventListener('change', s => {
  if (s === 'active') {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    if (current && (state.status !== 'connected' || !WG?.running())) void connect(current);
    else void check();
  } else if (s === 'background') {
    if (bgTimer) clearTimeout(bgTimer);
    bgTimer = setTimeout(() => { bgTimer = null; void disconnect(); }, 60_000);
  }
});

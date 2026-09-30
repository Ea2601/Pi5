// Kiosk veri katmanı: düzenli yoklama (sekme gizliyken durur), bağlantı kopması sayacı ve biçimlendiriciler.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ── API yanıt türleri (yalnız kioskun kullandığı alanlar; birimler yorumlarda) ──
export interface TopoExit {
  id: string; kind: 'local' | 'dpi' | 'vps'; label: string; detail?: string; vpsId?: number; up?: boolean;
  handshakeAgeS?: number | null; downBps: number; upBps: number; devices: number; // *Bps = BAYT/sn
}
export interface TopoDevice {
  mac: string; ip: string; hostname: string; type?: string; blocked?: boolean; online?: boolean; downBps: number; upBps: number;
}
export interface TopologyLive { gateway?: { lanIp?: string; hostname?: string }; exits?: TopoExit[]; devices?: TopoDevice[]; accounting?: boolean; sampledAt?: string }
export interface SystemStats {
  cpuTemp: number; cpuUsage: number; memoryTotal: number; memoryUsed: number; // bellek MiB
  diskTotal: number; diskUsed: number; uptime: number; loadAvg?: number[]; fanSpeed?: number; // disk GiB, uptime sn
}
export interface MetricPoint { ts: number; cpuTemp: number; cpuUsage: number; memoryUsage: number; networkIn: number; networkOut: number } // ağ Mbit/s
export interface ServiceRow { name: string; status: 'running' | 'stopped' | 'error' | 'restarting' | 'not_installed'; boot_enabled?: boolean }
export interface AlertRow { id: number; type: string; severity: 'info' | 'warning' | 'critical'; message: string; source: string; acknowledged: number; created_at: string }

// Ardışık başarısız istek sayısı: 2 ve üstünde ekranın üstünde "bağlantı yok" şeridi çıkar (tek ıskalama çıkarmaz).
let failStreak = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
export function useOffline(): boolean {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => failStreak >= 2);
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`/api${path}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as T;
    if (failStreak) { failStreak = 0; emit(); }
    return j;
  } catch {
    failStreak++;
    if (failStreak === 2) emit();
    return null;
  }
}

// Ortak yoklama: aynı uç birden çok panoda kullanılsa da tek istek gider (en kısa aralık geçerli). Hata olursa son iyi
// veri korunur (ekran boşalmaz). Sekme gizliyken istek atılmaz. null = henüz hiç gelmedi.
interface Feed {
  data: unknown; history: unknown[]; subs: Map<symbol, number>; timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>; busy: boolean;
}
const HISTORY_MAX = 150; // 5 sn aralıkta ~12 dk
const feeds = new Map<string, Feed>();
const interval = (f: Feed) => Math.min(...f.subs.values());
function schedule(path: string, f: Feed, delay: number) {
  if (f.timer) clearTimeout(f.timer);
  f.timer = setTimeout(async () => {
    if (!f.subs.size) return;
    if (!document.hidden && !f.busy) {
      f.busy = true;
      const d = await getJson<unknown>(path);
      f.busy = false;
      if (d != null) {
        f.data = d;
        f.history.push(d);
        if (f.history.length > HISTORY_MAX) f.history.splice(0, f.history.length - HISTORY_MAX);
        f.listeners.forEach(l => l());
      }
    }
    if (f.subs.size) schedule(path, f, interval(f));
  }, delay);
}

export function usePoll<T>(path: string | null, ms: number): T | null {
  const [, force] = useState(0);
  const key = useRef(Symbol(path ?? ''));
  useEffect(() => {
    if (!path) return;
    let f = feeds.get(path);
    if (!f) { f = { data: null, history: [], subs: new Map(), timer: null, listeners: new Set(), busy: false }; feeds.set(path, f); }
    const fresh = !f.subs.size;
    f.subs.set(key.current, ms);
    const l = () => force(n => n + 1);
    f.listeners.add(l);
    if (fresh) schedule(path, f, 0);
    const feed = f;
    const k = key.current;
    return () => {
      feed.subs.delete(k);
      feed.listeners.delete(l);
      if (!feed.subs.size && feed.timer) clearTimeout(feed.timer);
    };
  }, [path, ms]);
  return (path ? feeds.get(path)?.data ?? null : null) as T | null;
}

// Bu kioskun açıldığından beri gelen yanıtlar (en çok ~12 dk; eskiden yeniye). usePoll ile aynı uç için kullanılır.
export const feedHistory = <T,>(path: string): T[] => (feeds.get(path)?.history ?? []) as T[];

// Dakikalık/saniyelik yenilenen "şimdi" (render içinde Date.now çağrılmasın)
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ── Biçimlendiriciler ──
const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
export const num = (v: number | null | undefined, digits = 0) =>
  v == null || !isFinite(v) ? '—' : (digits ? nf1 : nf0).format(v);

// bit/sn → [değer, birim] (ağ hızı insanlar için bit cinsinden: Mbps)
export function bitRate(bitsPerSec: number | null | undefined): [string, string] {
  const v = Number(bitsPerSec) || 0;
  if (v >= 1e9) return [nf1.format(v / 1e9), 'Gbps'];
  if (v >= 1e6) return [nf1.format(v / 1e6), 'Mbps'];
  if (v >= 1e3) return [nf0.format(v / 1e3), 'kbps'];
  return [nf0.format(v), 'bps'];
}
export const bitRateText = (bps: number | null | undefined) => bitRate(bps).join(' ');

// SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) ya da ISO → Date
export function parseTime(s: string | number | null | undefined): Date | null {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return new Date(s < 1e12 ? s * 1000 : s);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function ago(d: Date | null): string {
  if (!d) return '';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}

export function duration(sec: number | null | undefined): string {
  const s = Math.max(0, Number(sec) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} gün ${h} sa`;
  if (h) return `${h} sa ${m} dk`;
  return `${m} dk`;
}

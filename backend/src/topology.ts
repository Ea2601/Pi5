import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { IpCounters } from './bandwidth';

// Canlı ağ topolojisi: cihaz → Pi → çıkış (yerel / DPI / VPS tüneli) → internet. Trafik bandwidth.ts'in ct mark'a göre
// ayrılmış sayaçlarından gelir; sınıflar system.ts getFwmark şemasıyla aynı:
//   0 → yerel çıkış (ISP), 200 → ISP + DPI (istenen; Zapret kendi hostlist'iyle çalışır),
//   100+id → wg_vps<id> tüneli, 300+id → tünel + DPI (DPI tünel içinde etkisiz → tünel sayılır, işaretlenir).
// Başka işaretler (şemada yok) yerel sayılır: forward yolundan ISP'ye çıkarlar.

const execFileP = promisify(execFile);

export type ExitId = 'local' | 'dpi' | `vps:${number}`;
export type MarkClass = { exit: ExitId; dpiRequested: boolean };

export function classifyMark(mark: number): MarkClass {
  const m = mark & 0xffff;
  if (m >= 100 && m < 200) return { exit: `vps:${m - 100}`, dpiRequested: false };
  if (m === 200) return { exit: 'dpi', dpiRequested: true };
  if (m >= 300 && m < 400) return { exit: `vps:${m - 300}`, dpiRequested: true };
  return { exit: 'local', dpiRequested: false };
}

export type Neighbor = { mac: string; state: string; confirmed: number | null };

// `ip -j -s -4 neigh show` → IP başına MAC, durum ve son doğrulamadan bu yana geçen saniye.
export function parseNeighbors(json: string): Map<string, Neighbor> {
  const out = new Map<string, Neighbor>();
  let rows: any[] = [];
  try { rows = JSON.parse(json); } catch { return out; }
  if (!Array.isArray(rows)) return out;
  for (const n of rows) {
    if (typeof n?.dst !== 'string' || typeof n?.lladdr !== 'string') continue;
    const state = Array.isArray(n.state) ? String(n.state[0] || '') : String(n.state || '');
    out.set(n.dst, { mac: n.lladdr.toLowerCase(), state, confirmed: Number.isFinite(n.confirmed) ? Number(n.confirmed) : null });
  }
  return out;
}

// `wg show all latest-handshakes` → arayüz başına en yeni el sıkışma (unix sn; 0 = hiç).
export function parseHandshakes(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [iface, , ts] = line.trim().split(/\s+/);
    if (!iface || !/^\d+$/.test(ts || '')) continue;
    out.set(iface, Math.max(out.get(iface) || 0, Number(ts)));
  }
  return out;
}

// Çevrimiçi: komşu tablosu cihazı doğruluyorsa (REACHABLE…) ya da son 10 dk içinde doğrulandıysa ya da trafiği varsa.
// STALE kayıtlar kapanmış cihazlar için saatlerce kalabilir → yalnız son doğrulama yakınsa sayılır.
const LIVE_STATES = new Set(['REACHABLE', 'DELAY', 'PROBE', 'PERMANENT', 'NOARP']);
export const ONLINE_CONFIRM_S = 600;
export function isOnline(n: Neighbor | undefined, recentTraffic: boolean): boolean {
  if (recentTraffic) return true;
  if (!n) return false;
  if (LIVE_STATES.has(n.state)) return true;
  return n.state === 'STALE' && n.confirmed !== null && n.confirmed <= ONLINE_CONFIRM_S;
}

export type Flow = { exit: ExitId; dpiRequested: boolean; downBps: number; upBps: number; bytesDown: number; bytesUp: number };
export type TopoDevice = {
  // routed: sayaçlarda izi var (trafiği Pi'den geçiyor); yoksa cihaz modemin ağında ve Pi'yi ağ geçidi olarak kullanmıyor.
  mac: string; ip: string; hostname: string | null; type: string; blocked: boolean; online: boolean; routed: boolean;
  downBps: number; upBps: number; bytesDown: number; bytesUp: number; flows: Flow[];
};
export type TopoExit = {
  id: ExitId; kind: 'local' | 'dpi' | 'vps'; label: string; detail: string;
  vpsId?: number; ip?: string; iface?: string; up?: boolean; handshakeAgeS?: number | null; known?: boolean;
  downBps: number; upBps: number; bytesDown: number; bytesUp: number; devices: number;
};
export type Topology = {
  gateway: { lanIp: string; hostname: string };
  modem: { ip: string; dev: string } | null;
  exits: TopoExit[];
  devices: TopoDevice[];
  accounting: boolean;
  sampledAt: string;
};

export type TopoInput = {
  devices: { mac_address: string; ip_address: string | null; hostname: string | null; device_type?: string | null; blocked?: number | null }[];
  vps: { id: number; ip: string; location: string | null; status?: string | null }[];
  neighbors: Map<string, Neighbor>;
  markCounters: IpCounters;
  markRates: Map<string, { downBps: number; upBps: number }>;
  recentIps: Set<string>;
  handshakes: Map<string, number>;
  ifacesUp: Set<string>;
  lanIp: string;
  hostname: string;
  modem: { ip: string; dev: string } | null;
  localIps: Set<string>;
  accounting: boolean;
  nowS: number;
};

const byExitOrder = (a: ExitId) => (a === 'local' ? 0 : a === 'dpi' ? 1 : 2 + Number(a.slice(4)));

export function buildTopology(inp: TopoInput): Topology {
  // IP → cihaz. Komşu tablosundaki MAC öncelikli (listedeki IP eskimiş olabilir); listede olmayan ama trafiği/komşusu
  // olan IP'ler MAC'le (yoksa IP'yle) ayrı cihaz olur. Pi'nin kendi adresleri ve modem cihaz değildir.
  const devByMac = new Map<string, TopoDevice>();
  const ensure = (mac: string, ip: string) => {
    let d = devByMac.get(mac);
    if (!d) {
      d = { mac, ip, hostname: null, type: 'unknown', blocked: false, online: false, routed: false, downBps: 0, upBps: 0, bytesDown: 0, bytesUp: 0, flows: [] };
      devByMac.set(mac, d);
    }
    return d;
  };
  const skipIp = (ip: string) => inp.localIps.has(ip) || (!!inp.modem && ip === inp.modem.ip);
  const modemMac = inp.modem ? inp.neighbors.get(inp.modem.ip)?.mac : undefined;
  const macOfIp = new Map<string, string>();
  for (const d of inp.devices) {
    const mac = String(d.mac_address || '').toLowerCase();
    if (!mac) continue;
    if (d.ip_address && !skipIp(d.ip_address)) macOfIp.set(d.ip_address, mac);
  }
  for (const [ip, n] of inp.neighbors) if (!skipIp(ip)) macOfIp.set(ip, n.mac);
  for (const d of inp.devices) {
    const mac = String(d.mac_address || '').toLowerCase();
    if (!mac || mac === modemMac || (d.ip_address && skipIp(d.ip_address))) continue;
    const e = ensure(mac, d.ip_address || '');
    e.hostname = d.hostname || null;
    e.type = d.device_type || 'unknown';
    e.blocked = !!d.blocked;
  }
  // Cihazın güncel IP'si: komşu tablosundaki.
  for (const [ip, n] of inp.neighbors) {
    if (skipIp(ip)) continue;
    const d = devByMac.get(n.mac);
    if (d) d.ip = ip;
  }

  const flowsOf = new Map<TopoDevice, Map<ExitId, Flow>>();
  for (const [key, c] of inp.markCounters) {
    const bar = key.lastIndexOf('|');
    const ip = key.slice(0, bar);
    const mark = Number(key.slice(bar + 1));
    if (!ip || skipIp(ip)) continue;
    const mac = macOfIp.get(ip);
    const d = mac ? ensure(mac, ip) : ensure(ip, ip);
    const cls = classifyMark(mark);
    const r = inp.markRates.get(key) || { downBps: 0, upBps: 0 };
    let fm = flowsOf.get(d);
    if (!fm) { fm = new Map(); flowsOf.set(d, fm); }
    let f = fm.get(cls.exit);
    if (!f) { f = { exit: cls.exit, dpiRequested: false, downBps: 0, upBps: 0, bytesDown: 0, bytesUp: 0 }; fm.set(cls.exit, f); }
    f.dpiRequested = f.dpiRequested || cls.dpiRequested;
    f.downBps += r.downBps; f.upBps += r.upBps; f.bytesDown += c.down; f.bytesUp += c.up;
  }

  const exits = new Map<ExitId, TopoExit>();
  const addExit = (e: Omit<TopoExit, 'downBps' | 'upBps' | 'bytesDown' | 'bytesUp' | 'devices'>) =>
    exits.set(e.id, { ...e, downBps: 0, upBps: 0, bytesDown: 0, bytesUp: 0, devices: 0 });
  addExit({ id: 'local', kind: 'local', label: 'Yerel çıkış', detail: inp.modem ? `Modem ${inp.modem.ip} · ${inp.modem.dev}` : 'ISP' });
  addExit({ id: 'dpi', kind: 'dpi', label: 'DPI (istenen)', detail: 'Zapret · ISP üzerinden' });
  const vpsExit = (id: number, v?: TopoInput['vps'][number]) => {
    const iface = `wg_vps${id}`;
    const hs = inp.handshakes.get(iface);
    addExit({
      id: `vps:${id}`, kind: 'vps', vpsId: id, known: !!v,
      label: v ? (v.location?.trim() || v.ip) : `VPS #${id}`,
      detail: v ? v.ip : 'panelde kayıtlı değil',
      ip: v?.ip, iface, up: inp.ifacesUp.has(iface),
      handshakeAgeS: hs ? Math.max(0, inp.nowS - hs) : null,
    });
  };
  for (const v of [...inp.vps].sort((a, b) => a.id - b.id)) vpsExit(Number(v.id), v);

  const devices: TopoDevice[] = [];
  for (const d of devByMac.values()) {
    const fm = flowsOf.get(d);
    if (fm) {
      d.flows = [...fm.values()].sort((a, b) => byExitOrder(a.exit) - byExitOrder(b.exit));
      for (const f of d.flows) {
        d.downBps += f.downBps; d.upBps += f.upBps; d.bytesDown += f.bytesDown; d.bytesUp += f.bytesUp;
        if (!exits.has(f.exit)) vpsExit(Number(f.exit.slice(4)));
        const x = exits.get(f.exit)!;
        x.downBps += f.downBps; x.upBps += f.upBps; x.bytesDown += f.bytesDown; x.bytesUp += f.bytesUp;
        if (f.downBps + f.upBps > 0) x.devices++;
      }
    }
    d.routed = d.bytesDown + d.bytesUp > 0;
    d.online = isOnline(inp.neighbors.get(d.ip), d.downBps + d.upBps > 0 || inp.recentIps.has(d.ip));
    devices.push(d);
  }
  const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + (Number(o) || 0), 0);
  devices.sort((a, b) => Number(b.online) - Number(a.online) || ipNum(a.ip) - ipNum(b.ip) || a.mac.localeCompare(b.mac));

  return {
    gateway: { lanIp: inp.lanIp, hostname: inp.hostname },
    modem: inp.modem,
    exits: [...exits.values()].sort((a, b) => byExitOrder(a.id) - byExitOrder(b.id)),
    devices,
    accounting: inp.accounting,
    sampledAt: new Date(inp.nowS * 1000).toISOString(),
  };
}

// ─── Canlı okumalar (Linux) ───

export async function readNeighbors(): Promise<Map<string, Neighbor>> {
  try {
    const { stdout } = await execFileP('ip', ['-j', '-s', '-4', 'neigh', 'show'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return parseNeighbors(stdout);
  } catch { return new Map(); }
}

export async function readHandshakes(): Promise<Map<string, number>> {
  try {
    const { stdout } = await execFileP('wg', ['show', 'all', 'latest-handshakes'], { timeout: 5000 });
    return parseHandshakes(stdout);
  } catch { return new Map(); } // wg yok ya da tünel yok
}

export async function readDefaultRoute(): Promise<{ ip: string; dev: string } | null> {
  try {
    const { stdout } = await execFileP('ip', ['-j', '-4', 'route', 'show', 'default'], { timeout: 5000 });
    const r = (JSON.parse(stdout) as any[]).find(x => typeof x?.gateway === 'string');
    return r ? { ip: r.gateway, dev: String(r.dev || '') } : null;
  } catch { return null; }
}

export function readIfaces(): Set<string> {
  try { return new Set(fs.readdirSync('/sys/class/net')); } catch { return new Set(); }
}

// Pi'nin kendi IPv4 adresleri (cihaz sayılmaz).
export async function readLocalIps(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { stdout } = await execFileP('ip', ['-j', '-4', 'addr', 'show'], { timeout: 5000 });
    for (const l of JSON.parse(stdout) as any[]) for (const a of l?.addr_info || []) if (a?.local) out.add(String(a.local));
  } catch { /* boş */ }
  return out;
}

// Son 10 dk'da trafiği görülen IP'ler (STALE komşu kaydıyla uyuyan cihazı "çevrimiçi" tutar).
const lastActive = new Map<string, number>();
export function noteActivity(markRates: Map<string, { downBps: number; upBps: number }>, nowMs: number): Set<string> {
  for (const [key, r] of markRates) {
    if (r.downBps + r.upBps > 0) lastActive.set(key.slice(0, key.lastIndexOf('|')), nowMs);
  }
  const recent = new Set<string>();
  for (const [ip, t] of lastActive) {
    if (nowMs - t <= ONLINE_CONFIRM_S * 1000) recent.add(ip); else lastActive.delete(ip);
  }
  return recent;
}

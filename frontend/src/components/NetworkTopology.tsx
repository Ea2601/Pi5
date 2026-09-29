import { Router, Smartphone, Laptop, Tv, CircleDot, Tablet, RefreshCw, Wifi, Globe, Plus, Minus, Maximize, Eye, EyeOff, X, Cable, RadioTower, CircleHelp } from 'lucide-react';
import type { ReactNode, PointerEvent as RPointerEvent, KeyboardEvent as RKeyboardEvent, MouseEvent as RMouseEvent } from 'react';
import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { computeLayout, joinPaths, pointAt, level, type ExitId, type AccessId, type AccessGroup, type Layout, type LayoutMode, type PathGeom, type Box } from './topologyLayout';

// Canlı ağ haritası: cihaz → erişim (kablolu / Wi-Fi) → Pi → çıkış (yerel / DPI / VPS tüneli) → internet. Veri /api/topology/live (3 sn):
// cihaz başı, bağlantı türü başı gerçek sayaçlar. Hareketli parçacıklar gerçek trafiktir (hızla yoğunlaşır); boştaki
// yollar kesikli çizilir. "Önizleme" tüm yolları temsili akışla gösterir ve bunu açıkça belirtir.

type Flow = { exit: ExitId; dpiRequested: boolean; downBps: number; upBps: number; bytesDown: number; bytesUp: number };
// Bağlantı türü (arka uç linkProbe.ts): ARP yanıt süresi + gizli MAC / cihaz türü ipuçları; Kurulum Wi-Fi'ı kesin.
type LinkInfo = {
  kind: 'wired' | 'wifi' | 'setup' | 'unknown'; basis: 'latency' | 'random-mac' | 'device-type' | 'setup-wifi' | 'pi-wifi' | 'none';
  certain: boolean; medMs: number | null; p90Ms: number | null; baseMs: number | null; samples: number;
};
type TopoDevice = {
  mac: string; ip: string; hostname: string | null; type: string; blocked: boolean; online: boolean; routed: boolean;
  downBps: number; upBps: number; bytesDown: number; bytesUp: number; flows: Flow[];
  link?: LinkInfo;
};
type TopoExit = {
  id: ExitId; kind: 'local' | 'dpi' | 'vps'; label: string; detail: string;
  vpsId?: number; ip?: string; iface?: string; up?: boolean; handshakeAgeS?: number | null; known?: boolean;
  downBps: number; upBps: number; bytesDown: number; bytesUp: number; devices: number;
};
type Topology = {
  gateway: { lanIp: string; hostname: string }; modem: { ip: string; dev: string } | null;
  exits: TopoExit[]; devices: TopoDevice[]; accounting: boolean; sampledAt: string;
};
type View = { x: number; y: number; k: number };
type Sel = { kind: 'device'; id: string } | { kind: 'exit'; id: ExitId } | { kind: 'access'; id: AccessId } | null;
type Cls = 'local' | 'dpi' | 'vps' | 'none';
type AccStats = { count: number; online: number; down: number; up: number; measuring: boolean };

const K_MIN = 0.2, K_MAX = 4;
const PAD_TOP = 48, PAD_BOTTOM = 44;
const HS_FRESH_S = 180; // WireGuard 2 dk'da bir el sıkışır; 3 dk'dan eskiyse tünel çalışmıyor sayılır
const MAX_PARTICLES = 260;
// Ayrıntı düzeyi (yakınlaştırma): 0 = yalnız ad, 1 = ad + IP + hız, 2 = tam ayrıntı. Dar ekranda kartlar geniş olduğundan eşikler düşük.
const LOD_AT: Record<LayoutMode, [number, number]> = { wide: [0.7, 1.55], narrow: [0.6, 1.25] };

const clsOf = (exit: ExitId): Cls => (exit === 'local' ? 'local' : exit === 'dpi' ? 'dpi' : 'vps');
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// DeviceControlPanel.deviceLabel ile aynı kural: MAC'in yerel yönetimli biti = telefonların rastgele (gizli) adresi.
const isRandomMac = (mac: string) => /^[0-9a-f]([26ae])/i.test(mac);
const deviceName = (d: TopoDevice) => d.hostname || (/^\d+\.\d+\.\d+\.\d+$/.test(d.mac) ? d.mac : isRandomMac(d.mac) ? 'Adsız cihaz (gizli MAC)' : 'Adsız cihaz');
const TYPE_LABEL: Record<string, string> = { phone: 'Telefon', laptop: 'Dizüstü', tv: 'TV', tablet: 'Tablet', iot: 'IoT', desktop: 'Masaüstü' };

function fmtRate(Bps: number): string {
  const b = Bps * 8;
  if (b < 1000) return `${Math.round(b)} bps`;
  if (b < 1e6) return `${(b / 1e3).toFixed(b < 1e4 ? 1 : 0)} kbps`;
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} Mbps`;
  return `${(b / 1e9).toFixed(1)} Gbps`;
}
const fmtBytes = (n: number) =>
  n >= 1099511627776 ? `${(n / 1099511627776).toFixed(1)} TB`
    : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB`
      : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
        : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
const fmtAge = (s: number) => (s < 60 ? `${s} sn` : s < 3600 ? `${Math.floor(s / 60)} dk` : `${Math.floor(s / 3600)} sa`);
const rates = (down: number, up: number) => (down + up > 0 ? `↓ ${fmtRate(down)} ↑ ${fmtRate(up)}` : 'boşta');

// SVG metni kendiliğinden kısalmaz: yaklaşık karakter genişliğiyle (Inter ≈ 0.56 em) sığdırılır.
function fitText(text: string, maxW: number, size: number): string {
  const max = Math.floor(maxW / (size * 0.56));
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

const deviceIcon = (type: string, size: number) => {
  const p = { size, strokeWidth: 1.8 };
  switch (type) {
    case 'phone': return <Smartphone {...p} />;
    case 'laptop': return <Laptop {...p} />;
    case 'tv': return <Tv {...p} />;
    case 'tablet': return <Tablet {...p} />;
    case 'iot': return <Wifi {...p} />;
    default: return <CircleDot {...p} />;
  }
};

type VpsHealth = 'ok' | 'stale' | 'down';
function vpsHealth(x: TopoExit): VpsHealth {
  if (!x.up) return 'down';
  return x.handshakeAgeS != null && x.handshakeAgeS <= HS_FRESH_S ? 'ok' : 'stale';
}
function exitStatus(x: TopoExit): string {
  if (x.kind === 'local') return 'Doğrudan ISP';
  if (x.kind === 'dpi') return 'Zapret listesindeki alan adları';
  const h = vpsHealth(x);
  if (h === 'down') return `${x.iface} · tünel kapalı`;
  return `${x.iface} · ${x.handshakeAgeS == null ? 'el sıkışma yok' : `el sıkışma ${fmtAge(x.handshakeAgeS)} önce`}`;
}
const exitShort = (x: TopoExit | undefined, id: ExitId) => (x ? (x.kind === 'local' ? 'Yerel' : x.kind === 'dpi' ? 'DPI' : `VPS ${x.label}`) : id);

// ─── Erişim katmanı (kablolu / Wi-Fi) ───
const ACCESS_ORDER: AccessId[] = ['acc:wired', 'acc:wifi', 'acc:setup', 'acc:unknown'];
const accessOf = (d: TopoDevice): AccessId => {
  const k = d.link?.kind;
  return k === 'wired' ? 'acc:wired' : k === 'wifi' ? 'acc:wifi' : k === 'setup' ? 'acc:setup' : 'acc:unknown';
};
const ACCESS_LABEL: Record<AccessId, string> = { 'acc:wired': 'Kablolu', 'acc:wifi': 'Wi-Fi', 'acc:setup': "Kurulum Wi-Fi'ı", 'acc:unknown': 'Belirsiz' };
const accessDetail = (id: AccessId, st: AccStats) =>
  id === 'acc:wired' ? 'modem / anahtar portu' : id === 'acc:wifi' ? 'erişim noktası üzerinden' : id === 'acc:setup' ? "Pi'nin kendi yayını"
    : st.measuring ? 'yanıt süresi ölçülüyor' : 'kablo ile Wi-Fi arasında';
const accessIcon = (id: AccessId) => {
  const p = { size: 24, strokeWidth: 1.8 };
  return id === 'acc:wired' ? <Cable {...p} /> : id === 'acc:wifi' ? <Wifi {...p} /> : id === 'acc:setup' ? <RadioTower {...p} /> : <CircleHelp {...p} />;
};
const fmtMs = (v: number | null) => (v == null ? '—' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);
function linkText(l?: LinkInfo): string {
  if (!l) return 'Bağlantı türü bilinmiyor';
  if (l.kind === 'setup') return "Kurulum Wi-Fi'ı (Pi'nin kendi yayını)";
  if (l.kind === 'unknown') return l.samples >= 3 ? `Belirsiz — yanıt ${fmtMs(l.medMs)}, kablo ile Wi-Fi arasında` : 'Belirsiz — yanıt süresi ölçülüyor';
  if (l.basis === 'pi-wifi') return "Wi-Fi — Pi'nin ev Wi-Fi'ına bağlı";
  const why = l.basis === 'latency' ? `yanıt ${fmtMs(l.medMs)}${l.baseMs != null ? `, modem ${fmtMs(l.baseMs)}` : ''}`
    : l.basis === 'random-mac' ? 'gizli MAC adresi' : 'cihaz türü';
  return `${l.kind === 'wired' ? 'Kablolu' : 'Wi-Fi'} — ${l.certain ? '' : 'tahmini, '}${why}`;
}
const linkShort = (l?: LinkInfo) =>
  !l || l.kind === 'unknown' ? '' : l.kind === 'setup' ? "Kurulum Wi-Fi'ı" : `${l.kind === 'wired' ? 'Kablolu' : 'Wi-Fi'}${l.certain ? '' : ' (tahmini)'}`;

// Cihaz bağlantısının rengi: şu an en çok trafik taşıyan sınıf; boştaysa toplamda en çok kullanılan.
function dominantCls(d: TopoDevice): Cls {
  let best: Flow | null = null;
  for (const f of d.flows) if (f.downBps + f.upBps > 0 && (!best || f.downBps + f.upBps > best.downBps + best.upBps)) best = f;
  if (!best) for (const f of d.flows) if (f.bytesDown + f.bytesUp > 0 && (!best || f.bytesDown + f.bytesUp > best.bytesDown + best.bytesUp)) best = f;
  return best ? clsOf(best.exit) : 'none';
}

// ─── Düğüm çizimleri ───

type DeviceNodeProps = { d: TopoDevice; b: Box; lod: 0 | 1 | 2; mode: LayoutMode; exitsById: Map<ExitId, TopoExit>; onPick: (d: TopoDevice) => void; hl: boolean };
function DeviceNode({ d, b, lod, mode, exitsById, onPick, hl }: DeviceNodeProps) {
  const cy = b.y + b.h / 2;
  const name = deviceName(d);
  const active = d.downBps + d.upBps > 0;
  const big = mode === 'narrow';
  const label = `${name}, ${d.ip || 'IP yok'}, ${d.online ? 'çevrimiçi' : 'çevrimdışı'}, ${rates(d.downBps, d.upBps)}`;
  let body: ReactNode;
  if (lod === 0) {
    body = <text x={b.x + 40} y={cy + 5} className="topo-t-name" fontSize={14}>{fitText(name, b.w - 50, 14)}</text>;
  } else if (lod === 1) {
    const sub = !d.online ? `${d.ip || '—'} · çevrimdışı` : !d.routed ? `${d.ip} · trafik görülmedi` : `${d.ip} · ${rates(d.downBps, d.upBps)}`;
    body = <>
      <text x={b.x + 40} y={cy - 2} className="topo-t-name" fontSize={11.5}>{fitText(name, b.w - 52, 11.5)}</text>
      <text x={b.x + 40} y={cy + 11} className="topo-t-sub" fontSize={big ? 9 : 8.5}>{fitText(sub, b.w - 48, big ? 9 : 8.5)}</text>
    </>;
  } else {
    const fs = big ? 7 : 6, fn = big ? 10 : 8.5, x0 = b.x + 30, w = b.w - 36;
    const flows = d.flows.filter(f => f.bytesDown + f.bytesUp > 0);
    let fx = x0;
    const chips: ReactNode[] = [];
    for (const f of flows) {
      const t = `${exitShort(exitsById.get(f.exit), f.exit)} ${f.downBps + f.upBps > 0 ? `↓${fmtRate(f.downBps)} ↑${fmtRate(f.upBps)}` : 'boşta'}`;
      const tw = t.length * fs * 0.56 + fs * 1.6;
      if (fx + tw > x0 + w) { chips.push(<text key="more" x={fx} y={b.y + 31.5} className="topo-t-sub" fontSize={fs}>…</text>); break; }
      chips.push(<g key={f.exit} className={`topo-c-${clsOf(f.exit)}`}>
        <circle cx={fx + fs * 0.35} cy={b.y + 31.5 - fs * 0.33} r={fs * 0.33} className="topo-dot" />
        <text x={fx + fs * 0.95} y={b.y + 31.5} className="topo-t-sub" fontSize={fs}>{t}</text>
      </g>);
      fx += tw;
    }
    const meta = [`Toplam ↓ ${fmtBytes(d.bytesDown)} ↑ ${fmtBytes(d.bytesUp)}`, linkShort(d.link), TYPE_LABEL[d.type], d.blocked ? 'Engelli' : '', !d.online ? 'çevrimdışı' : ''].filter(Boolean).join(' · ');
    body = <>
      <text x={x0} y={b.y + 12.5} className="topo-t-name" fontSize={fn}>{fitText(name, w - 8, fn)}</text>
      <text x={x0} y={b.y + 22} className="topo-t-mono" fontSize={fs}>{fitText(`${d.ip || '—'} · ${d.mac}`, w, fs)}</text>
      {chips.length ? chips : <text x={x0} y={b.y + 31.5} className="topo-t-sub" fontSize={fs}>{d.routed ? 'şu an trafik yok' : 'Pi üzerinden trafik görülmedi'}</text>}
      <text x={x0} y={b.y + 40.5} className="topo-t-sub" fontSize={fs}>{fitText(meta, w, fs)}</text>
    </>;
  }
  const iconR = lod === 2 ? 9 : 13, icx = lod === 2 ? b.x + 16 : b.x + 21, icy = lod === 2 ? b.y + 14 : cy;
  return (
    <g className={`topo-node topo-dev${d.online ? '' : ' is-off'}${d.blocked ? ' is-blocked' : ''}${hl ? ' is-hl' : ''}`}
      data-node="1" role="button" tabIndex={0} aria-label={label}
      onClick={() => onPick(d)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(d); } }}>
      <title>{label}</title>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} className="topo-card" />
      <circle cx={icx} cy={icy} r={iconR} className={`topo-icon-bg topo-c-${dominantCls(d)}`} />
      <svg x={icx - iconR * 0.6} y={icy - iconR * 0.6} width={iconR * 1.2} height={iconR * 1.2} viewBox="0 0 24 24" className="topo-icon" overflow="visible">
        {deviceIcon(d.type, 24)}
      </svg>
      <circle cx={b.x + b.w - 9} cy={b.y + 9} r={3} className={`topo-status ${d.blocked ? 'is-blocked' : active ? 'is-active' : d.online ? 'is-on' : 'is-off'}`} />
      {body}
    </g>
  );
}

type AccessNodeProps = { id: AccessId; b: Box; lod: 0 | 1 | 2; mode: LayoutMode; st: AccStats; onPick: (id: AccessId) => void; hl: boolean };
function AccessNode({ id, b, lod, mode, st, onPick, hl }: AccessNodeProps) {
  const label = ACCESS_LABEL[id], detail = accessDetail(id, st);
  const count = `${st.count} cihaz`;
  const aria = `${label}: ${count}, ${rates(st.down, st.up)}`;
  const cy = b.y + b.h / 2;
  let body: ReactNode, icon: { x: number; y: number; s: number };
  if (mode === 'narrow') {
    // Dar düzen: grubun başlık kartı — ad + cihaz sayısı solda, toplam hız sağda.
    icon = { x: b.x + 10, y: cy - 8, s: 16 };
    body = lod === 2 ? <>
      <text x={b.x + 32} y={b.y + 14} className="topo-t-name" fontSize={10}>{label} · {count}</text>
      <text x={b.x + 32} y={b.y + 26} className="topo-t-sub" fontSize={7}>{fitText(detail, b.w - 150, 7)}</text>
      <text x={b.x + b.w - 10} y={cy + 3} textAnchor="end" className="topo-t-rate" fontSize={7}>{rates(st.down, st.up)}</text>
    </> : <>
      <text x={b.x + 32} y={cy + 4} className="topo-t-name" fontSize={11}>{label}<tspan className="topo-t-sub" fontSize={9} dx={6}>{count}</tspan></text>
      {st.down + st.up > 0 && <text x={b.x + b.w - 10} y={cy + 3.5} textAnchor="end" className="topo-t-rate" fontSize={8.5}>{rates(st.down, st.up)}</text>}
    </>;
  } else if (lod === 0) {
    icon = { x: b.x + 10, y: cy - 8, s: 16 };
    body = <text x={b.x + 34} y={cy + 4.5} className="topo-t-name" fontSize={13}>{fitText(label, b.w - 40, 13)}</text>;
  } else if (lod === 1) {
    icon = { x: b.x + 10, y: b.y + 8, s: 14 };
    body = <>
      <text x={b.x + 32} y={b.y + 18} className="topo-t-name" fontSize={11.5}>{fitText(label, b.w - 40, 11.5)}</text>
      <text x={b.x + 12} y={b.y + 32} className="topo-t-sub" fontSize={8}>{fitText(detail, b.w - 20, 8)}</text>
      <text x={b.x + 12} y={b.y + 45} className="topo-t-rate" fontSize={8.5}>{fitText(`${count} · ${rates(st.down, st.up)}`, b.w - 20, 8.5)}</text>
    </>;
  } else {
    icon = { x: b.x + 10, y: b.y + 6, s: 11 };
    body = <>
      <text x={b.x + 26} y={b.y + 14} className="topo-t-name" fontSize={8.5}>{fitText(label, b.w - 34, 8.5)}</text>
      <text x={b.x + 12} y={b.y + 24} className="topo-t-sub" fontSize={6}>{fitText(detail, b.w - 20, 6)}</text>
      <text x={b.x + 12} y={b.y + 32.5} className="topo-t-sub" fontSize={6}>{fitText(`${count} · ${st.online} çevrimiçi`, b.w - 20, 6)}</text>
      <text x={b.x + 12} y={b.y + 41} className="topo-t-rate" fontSize={6}>{fitText(rates(st.down, st.up), b.w - 20, 6)}</text>
      <text x={b.x + 12} y={b.y + 49} className="topo-t-sub" fontSize={5.5}>{fitText(id === 'acc:setup' ? 'kesin: Pi yayınına bağlı' : 'yanıt süresine göre ayrılır', b.w - 20, 5.5)}</text>
    </>;
  }
  return (
    <g className={`topo-node topo-access${hl ? ' is-hl' : ''}`} data-node="1" role="button" tabIndex={0} aria-label={aria}
      onClick={() => onPick(id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(id); } }}>
      <title>{aria}</title>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={mode === 'narrow' ? 9 : 10} className="topo-card" />
      <svg x={icon.x} y={icon.y} width={icon.s} height={icon.s} viewBox="0 0 24 24" className="topo-icon">{accessIcon(id)}</svg>
      {body}
    </g>
  );
}

type ExitNodeProps = { x: TopoExit; b: Box; lod: 0 | 1 | 2; mode: LayoutMode; onPick: (x: TopoExit) => void; hl: boolean };
function ExitNode({ x, b, lod, mode, onPick, hl }: ExitNodeProps) {
  const cls = clsOf(x.id);
  const health = x.kind === 'vps' ? vpsHealth(x) : 'ok';
  const cy = b.y + b.h / 2, x0 = b.x + 14, w = b.w - 26;
  const big = mode === 'narrow';
  const label = `${x.kind === 'vps' ? 'VPS ' : ''}${x.label}: ${rates(x.downBps, x.upBps)}${x.kind === 'vps' ? `, ${exitStatus(x)}` : ''}`;
  let body: ReactNode;
  if (big) {
    // Dar düzen: çıkışlar tek sırada küçük kartlar (ad + iki satır hız); tam ayrıntı dokununca açılan panelde.
    const nx = b.x + 12, nw = b.w - 18;
    const short = x.kind === 'local' ? 'Yerel' : x.kind === 'dpi' ? 'DPI' : x.label;
    const idle = x.downBps + x.upBps <= 0;
    const state = health === 'down' ? 'tünel kapalı' : idle ? 'boşta' : '';
    const st2 = x.kind === 'local' ? 'ISP' : x.kind === 'dpi' ? 'Zapret' : health === 'down' ? 'kapalı'
      : x.handshakeAgeS == null ? 'el sıkışma yok' : `el sık. ${fmtAge(x.handshakeAgeS)}`;
    body = lod === 0
      ? <text x={nx} y={cy + 4} className="topo-t-name" fontSize={11}>{fitText(short, nw, 11)}</text>
      : lod === 1 ? <>
        <text x={nx} y={b.y + 15} className="topo-t-name" fontSize={10}>{fitText(short, nw - 4, 10)}</text>
        {state
          ? <text x={nx} y={b.y + 30} className="topo-t-sub" fontSize={7.5}>{fitText(state, nw, 7.5)}</text>
          : <>
            <text x={nx} y={b.y + 27} className="topo-t-rate" fontSize={7.5}>{fitText(`↓ ${fmtRate(x.downBps)}`, nw, 7.5)}</text>
            <text x={nx} y={b.y + 37.5} className="topo-t-rate" fontSize={7.5}>{fitText(`↑ ${fmtRate(x.upBps)}`, nw, 7.5)}</text>
          </>}
      </> : <>
        <text x={nx} y={b.y + 11.5} className="topo-t-name" fontSize={8}>{fitText(short, nw - 4, 8)}</text>
        <text x={nx} y={b.y + 20} className="topo-t-sub" fontSize={5.5}>{fitText(st2, nw, 5.5)}</text>
        <text x={nx} y={b.y + 29.5} className="topo-t-rate" fontSize={6}>{fitText(`↓ ${fmtRate(x.downBps)}`, nw, 6)}</text>
        <text x={nx} y={b.y + 38.5} className="topo-t-rate" fontSize={6}>{fitText(`↑ ${fmtRate(x.upBps)}`, nw, 6)}</text>
      </>;
  } else if (lod === 0) {
    body = <text x={x0} y={cy + 4.5} className="topo-t-name" fontSize={13}>{fitText(x.label, w, 13)}</text>;
  } else if (lod === 1) {
    body = <>
      <text x={x0} y={b.y + 17} className="topo-t-name" fontSize={11.5}>{fitText(x.label, w - 8, 11.5)}</text>
      <text x={x0} y={b.y + 30} className="topo-t-sub" fontSize={8}>{fitText(x.kind === 'vps' ? exitStatus(x) : x.detail, w, 8)}</text>
      <text x={x0} y={b.y + 45} className="topo-t-rate" fontSize={8.5}>{rates(x.downBps, x.upBps)}</text>
    </>;
  } else {
    const fs = 6, fn = 8.5;
    body = <>
      <text x={x0} y={b.y + 12} className="topo-t-name" fontSize={fn}>{fitText(x.label, w - 8, fn)}</text>
      <text x={x0} y={b.y + 21} className="topo-t-sub" fontSize={fs}>{fitText(x.detail, w, fs)}</text>
      <text x={x0} y={b.y + 29.5} className="topo-t-sub" fontSize={fs}>{fitText(exitStatus(x), w, fs)}</text>
      <text x={x0} y={b.y + 38} className="topo-t-rate" fontSize={fs}>{fitText(`${rates(x.downBps, x.upBps)} · ${x.devices} aktif cihaz`, w, fs)}</text>
      <text x={x0} y={b.y + 46.5} className="topo-t-sub" fontSize={fs}>{fitText(`Toplam ↓ ${fmtBytes(x.bytesDown)} ↑ ${fmtBytes(x.bytesUp)}`, w, fs)}</text>
    </>;
  }
  return (
    <g className={`topo-node topo-exit topo-c-${cls}${hl ? ' is-hl' : ''}${health === 'down' ? ' is-off' : ''}`}
      data-node="1" role="button" tabIndex={0} aria-label={label}
      onClick={() => onPick(x)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(x); } }}>
      <title>{label}</title>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} className="topo-card" />
      <rect x={b.x + 5} y={b.y + 9} width={3} height={b.h - 18} rx={1.5} className="topo-bar" />
      {x.kind === 'vps' && <circle cx={b.x + b.w - (big ? 7 : 9)} cy={b.y + (big ? 7 : 9)} r={big ? 2.5 : 3} className={`topo-status is-${health}`} />}
      {body}
    </g>
  );
}

// Parçacık: gerçek (ya da önizleme) akışın bir "paketi". Rota = cihaz → Pi → çıkış → internet; indirme ters yönde.
type Emitter = { mac: string; exit: ExitId; cls: Cls; down: number; up: number; speed: number; size: number; accD: number; accU: number };
type Particle = { el: SVGCircleElement; route: PathGeom; s: number; dir: 1 | -1; speed: number; size: number; mac: string; exit: ExitId; acc: AccessId | undefined; dim: boolean };
const emitRate = (bps: number) => (bps < 64 ? 0 : 0.5 + 6.5 * level(bps));

export function NetworkTopology() {
  const { data, error, loading, refetch } = useApi<Topology | null>('/topology/live', null, 3000);
  const stageRef = useRef<HTMLDivElement>(null);
  const partRef = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [showOffline, setShowOffline] = useState(false);
  const [preview, setPreview] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [view, setView] = useState<View | null>(null);
  const [userMoved, setUserMoved] = useState(false);
  const [fitFor, setFitFor] = useState('');

  const mode: LayoutMode = size.w > 0 && size.w < 720 ? 'narrow' : 'wide';
  const devices = useMemo(() => data?.devices || [], [data]);
  const exits = useMemo(() => data?.exits || [], [data]);
  const shown = useMemo(() => devices.filter(d => d.online || showOffline), [devices, showOffline]);
  const offlineCount = devices.length - devices.filter(d => d.online).length;
  // Erişim grupları (kablolu / Wi-Fi / Kurulum Wi-Fi'ı / belirsiz); anahtar metni yerleşimi yalnız gruplar değişince yeniler.
  const groupKey = ACCESS_ORDER.map(id => `${id}=${shown.filter(d => accessOf(d) === id).map(d => d.mac).join(',')}`).join('|');
  const exitKeys = exits.map(x => x.id).join(',');
  // Geniş ekranda sütun sayısı sahne boyutuna göre seçilir (sığdırmayla aynı kullanılabilir alan).
  const vpW = mode === 'wide' ? size.w - 24 : 0, vpH = mode === 'wide' ? size.h - PAD_TOP - PAD_BOTTOM : 0;
  const layout = useMemo(
    () => computeLayout(
      mode,
      groupKey.split('|').map(g => { const [id, keys] = g.split('='); return { id: id as AccessId, keys: keys ? keys.split(',') : [] } as AccessGroup; }),
      (exitKeys ? exitKeys.split(',') : []) as ExitId[], { w: vpW, h: vpH },
    ),
    [mode, groupKey, exitKeys, vpW, vpH],
  );
  const exitsById = useMemo(() => new Map(exits.map(x => [x.id, x])), [exits]);
  const accStats = useMemo(() => {
    const m = new Map<AccessId, AccStats>();
    for (const d of shown) {
      const id = accessOf(d);
      const st = m.get(id) || { count: 0, online: 0, down: 0, up: 0, measuring: false };
      st.count++; if (d.online) st.online++;
      st.down += d.downBps; st.up += d.upBps;
      if (id === 'acc:unknown' && (d.link?.samples ?? 0) < 6) st.measuring = true;
      m.set(id, st);
    }
    return m;
  }, [shown]);

  const fitView = useCallback((lay: Layout, w: number, h: number): View => {
    const b = lay.bounds;
    const availH = Math.max(80, h - PAD_TOP - PAD_BOTTOM);
    if (lay.mode === 'wide') {
      const k = clamp(Math.min((w - 24) / b.w, availH / b.h, 1.25), K_MIN, K_MAX);
      return { k, x: (w - b.w * k) / 2 - b.x * k, y: PAD_TOP + (availH - b.h * k) / 2 - b.y * k };
    }
    const k = clamp(Math.min((w - 8) / b.w, 1.3), K_MIN, K_MAX);
    const y = b.h * k < availH ? PAD_TOP + (availH - b.h * k) / 2 - b.y * k : PAD_TOP - b.y * k;
    return { k, x: (w - b.w * k) / 2 - b.x * k, y };
  }, []);

  // Görünümü sığdırma: ilk çizimde, ekran düzeni (geniş/dar) değişince ve kullanıcı haritayı oynatmadıysa cihaz listesi
  // ya da boyut değişince. Render sırasında önceki değerle karşılaştırılır (effect içinde setState yerine).
  const fitKey = size.w ? (userMoved ? `${mode}` : `${mode}#${groupKey}#${exitKeys}#${size.w}x${size.h}`) : '';
  if (fitKey && data && fitKey !== fitFor) {
    const modeChanged = fitFor.split('#')[0] !== mode;
    setFitFor(modeChanged ? `${mode}#${groupKey}#${exitKeys}#${size.w}x${size.h}` : fitKey);
    if (modeChanged || !userMoved || !view) {
      setView(fitView(layout, size.w, size.h));
      if (modeChanged && userMoved) setUserMoved(false);
    }
  }

  const viewRef = useRef<View | null>(null);
  const layoutRef = useRef<Layout>(layout);
  const selRef = useRef<Sel>(null);
  const accOfRef = useRef(new Map<string, AccessId>());
  useLayoutEffect(() => { viewRef.current = view; }, [view]);
  useLayoutEffect(() => { layoutRef.current = layout; }, [layout]);
  useLayoutEffect(() => { selRef.current = sel; }, [sel]);
  useLayoutEffect(() => { accOfRef.current = new Map(shown.map(d => [d.mac, accessOf(d)])); }, [shown]);

  // Boyut: ResizeObserver ilk gözlemde de çağırır.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      setSize(s => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ─── Görünüm değiştirme (yakınlaştır / kaydır / animasyon) ───
  const animRef = useRef(0);
  const setViewNow = useCallback((v: View) => {
    cancelAnimationFrame(animRef.current);
    viewRef.current = v;
    setView(v);
  }, []);
  const animateTo = useCallback((to: View, ms = 320) => {
    const from = viewRef.current;
    cancelAnimationFrame(animRef.current);
    if (!from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { viewRef.current = to; setView(to); return; }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
      const v = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      viewRef.current = v;
      setView(v);
      if (t < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(animRef.current), []);

  const zoomAt = useCallback((sx: number, sy: number, factor: number, animate = false) => {
    const v = viewRef.current;
    if (!v) return;
    const k = clamp(v.k * factor, K_MIN, K_MAX);
    const next = { k, x: sx - (sx - v.x) * (k / v.k), y: sy - (sy - v.y) * (k / v.k) };
    setUserMoved(true);
    if (animate) animateTo(next, 220); else setViewNow(next);
  }, [animateTo, setViewNow]);

  const zoomCenter = (factor: number) => zoomAt(size.w / 2, size.h / 2, factor, true);
  const fitNow = () => {
    setUserMoved(false);
    setFitFor(`${mode}#${groupKey}#${exitKeys}#${size.w}x${size.h}`); // render sırasındaki sığdırma animasyonu ezmesin
    animateTo(fitView(layout, size.w, size.h));
  };

  // Tekerlek: React'in wheel dinleyicisi pasif (preventDefault çalışmaz) → yerel dinleyici.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Sürükleme (tek parmak/fare) ve iki parmakla yakınlaştırma. İşaretçi yakalama yalnız sürükleme başlayınca:
  // yoksa tıklama düğüme değil sahneye gider.
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ sx: number; sy: number; v: View; moved: boolean; pinch?: { d: number; k: number; mx: number; my: number; v: View } } | null>(null);
  const dragged = useRef(false);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.isPrimary) ptrs.current.clear(); // yakalanmadan dışarıda bırakılmış eski işaretçi pinch sanılmasın
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const v = viewRef.current;
    if (!v) return;
    dragged.current = false;
    if (ptrs.current.size === 1) gesture.current = { sx: p.x, sy: p.y, v, moved: false };
    else if (ptrs.current.size === 2 && gesture.current) {
      const [a, b] = [...ptrs.current.values()];
      gesture.current.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: v.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v };
      gesture.current.moved = true;
      stageRef.current?.setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!ptrs.current.has(e.pointerId) || !gesture.current) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g.pinch && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const k = clamp(g.pinch.k * (d / g.pinch.d), K_MIN, K_MAX);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const pv = g.pinch.v;
      setUserMoved(true);
      setViewNow({ k, x: mx - (g.pinch.mx - pv.x) * (k / pv.k), y: my - (g.pinch.my - pv.y) * (k / pv.k) });
      return;
    }
    const dx = p.x - g.sx, dy = p.y - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    if (!g.moved) { g.moved = true; stageRef.current?.setPointerCapture(e.pointerId); }
    dragged.current = true;
    setUserMoved(true);
    setViewNow({ k: g.v.k, x: g.v.x + dx, y: g.v.y + dy });
  };
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size === 0) gesture.current = null;
    else if (gesture.current) {
      // Pinch bitti, kalan parmakla kaydırmaya devam
      const [p] = [...ptrs.current.values()];
      gesture.current = { sx: p.x, sy: p.y, v: viewRef.current!, moved: true };
    }
  };
  const isNode = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-node]');
  const onStageClick = (e: RMouseEvent) => {
    if (dragged.current) { dragged.current = false; return; }
    if (!isNode(e.target) && !(e.target instanceof Element && e.target.closest('.topo-ui'))) setSel(null);
  };
  const onDoubleClick = (e: RMouseEvent) => {
    if (isNode(e.target) || (e.target instanceof Element && e.target.closest('.topo-ui'))) return;
    const p = local(e);
    zoomAt(p.x, p.y, 1.8, true);
  };
  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    const v = viewRef.current;
    if (!v) return;
    const pan = (dx: number, dy: number) => { e.preventDefault(); setUserMoved(true); animateTo({ ...v, x: v.x + dx, y: v.y + dy }, 140); };
    switch (e.key) {
      case '+': case '=': e.preventDefault(); zoomCenter(1.4); break;
      case '-': case '_': e.preventDefault(); zoomCenter(1 / 1.4); break;
      case '0': e.preventDefault(); fitNow(); break;
      case 'ArrowLeft': pan(80, 0); break;
      case 'ArrowRight': pan(-80, 0); break;
      case 'ArrowUp': pan(0, 80); break;
      case 'ArrowDown': pan(0, -80); break;
      case 'Escape': setSel(null); break;
    }
  };

  // Seçim: cihaza tıklayınca üzerine yakınlaşır (ayrıntı düzeyi 2) ve yolları vurgulanır.
  const focusBox = useCallback((b: Box) => {
    const v = viewRef.current;
    if (!v || !size.w) return;
    const [, lod2] = LOD_AT[layout.mode];
    const k = layout.mode === 'narrow'
      ? clamp(Math.max(v.k, lod2 + 0.05), K_MIN, Math.max(lod2 + 0.05, (size.w - 8) / b.w))
      : clamp(Math.max(v.k, lod2 + 0.25), K_MIN, K_MAX);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    // Kart ekrandan genişse sola hizalanır: yazılar soldan başlar, sağda yalnız durum noktası kalır.
    const x = b.w * k > size.w - 16 ? 8 - b.x * k : size.w / 2 - cx * k;
    setUserMoved(true);
    animateTo({ k, x, y: Math.min(size.h / 2, (size.h - 150) / 2 + 40) - cy * k });
  }, [animateTo, layout.mode, size.w, size.h]);
  const pickDevice = (d: TopoDevice) => {
    if (dragged.current) return;
    setSel({ kind: 'device', id: d.mac });
    const b = layout.devices.get(d.mac);
    if (b) focusBox(b);
  };
  const pickExit = (x: TopoExit) => {
    if (dragged.current) return;
    setSel({ kind: 'exit', id: x.id });
    const b = layout.exits.get(x.id);
    if (b) focusBox(b);
  };

  const pickAccess = (id: AccessId) => {
    if (dragged.current) return;
    setSel({ kind: 'access', id });
    const b = layout.access.get(id);
    if (b) focusBox(b);
  };

  // Vurgulanan yollar
  const hl = useMemo(() => {
    const devs = new Set<string>(), exs = new Set<ExitId>(), accs = new Set<AccessId>();
    const used = (d: TopoDevice) => d.flows.forEach(f => { if (f.bytesDown + f.bytesUp > 0) exs.add(f.exit); });
    if (sel?.kind === 'device') {
      devs.add(sel.id);
      const d = devices.find(x => x.mac === sel.id);
      if (d) { used(d); accs.add(accessOf(d)); }
    } else if (sel?.kind === 'exit') {
      exs.add(sel.id);
      devices.forEach(d => { if (d.flows.some(f => f.exit === sel.id && f.bytesDown + f.bytesUp > 0)) { devs.add(d.mac); accs.add(accessOf(d)); } });
    } else if (sel?.kind === 'access') {
      accs.add(sel.id);
      shown.forEach(d => { if (accessOf(d) === sel.id) { devs.add(d.mac); used(d); } });
    }
    return { devs, exs, accs };
  }, [sel, devices, shown]);

  // ─── Parçacık motoru (DOM'a doğrudan; React yeniden çizimi yok) ───
  const emitters = useRef(new Map<string, Emitter>());
  const particles = useRef<Particle[]>([]);
  const pool = useRef<SVGCircleElement[]>([]);
  const routes = useRef(new Map<string, PathGeom>());
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Düzen değişince eski rotalardaki parçacıklar silinir.
  useEffect(() => {
    routes.current.clear();
    for (const p of particles.current) { p.el.style.display = 'none'; pool.current.push(p.el); }
    particles.current = [];
  }, [layout]);

  useEffect(() => {
    const next = new Map<string, Emitter>();
    const shownMacs = new Set(shown.map(d => d.mac));
    const add = (mac: string, exit: ExitId, down: number, up: number, speed: number, size: number) => {
      const key = `${mac}|${exit}`;
      const prev = emitters.current.get(key);
      next.set(key, { mac, exit, cls: clsOf(exit), down, up, speed, size, accD: prev?.accD ?? Math.random(), accU: prev?.accU ?? Math.random() });
    };
    if (preview) {
      const usable = exits.filter(x => x.kind !== 'vps' || vpsHealth(x) !== 'down');
      for (const d of shown) if (d.online) for (const x of usable) add(d.mac, x.id, 0.35, 0.3, 190, 0.35);
    } else {
      for (const d of devices) {
        if (!shownMacs.has(d.mac)) continue;
        for (const f of d.flows) {
          if (f.downBps + f.upBps <= 0) continue;
          const lv = level(Math.max(f.downBps, f.upBps));
          add(d.mac, f.exit, emitRate(f.downBps), emitRate(f.upBps), 170 + 150 * lv, lv);
        }
      }
    }
    emitters.current = next;
  }, [devices, exits, shown, preview]);

  const svgReady = !!(data && view);
  useEffect(() => {
    const layer = partRef.current;
    if (!layer || reduced) return;
    let raf = 0, last = performance.now(), lastK = -1, lastSel = '';
    const routeFor = (mac: string, exit: ExitId): PathGeom | null => {
      const key = `${mac}|${exit}`;
      let r = routes.current.get(key);
      if (!r) {
        const lay = layoutRef.current;
        const acc = accOfRef.current.get(mac);
        const a = lay.devLink.get(mac), m = acc ? lay.accessLink.get(acc) : undefined, b = lay.exitLink.get(exit), c = lay.netLink.get(exit);
        if (!a || !m || !b || !c) return null;
        r = joinPaths([a, m, b, c]);
        routes.current.set(key, r);
      }
      return r;
    };
    const spawn = (em: Emitter, dir: 1 | -1) => {
      if (particles.current.length >= MAX_PARTICLES) return;
      const route = routeFor(em.mac, em.exit);
      if (!route) return;
      let el = pool.current.pop();
      if (!el) { el = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); layer.appendChild(el); }
      el.setAttribute('class', `topo-p topo-c-${em.cls}`);
      el.style.display = '';
      el.style.opacity = '';
      particles.current.push({ el, route, s: dir === 1 ? 0 : route.len, dir, speed: em.speed * (0.9 + Math.random() * 0.2), size: em.size, mac: em.mac, exit: em.exit, acc: accOfRef.current.get(em.mac), dim: false });
      lastK = -1; // yeni parçacığa boyut/soluklaştırma uygulansın
    };
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      for (const em of emitters.current.values()) {
        em.accD += em.down * dt;
        em.accU += em.up * dt;
        while (em.accD >= 1) { em.accD -= 1; spawn(em, -1); }
        while (em.accU >= 1) { em.accU -= 1; spawn(em, 1); }
      }
      const k = viewRef.current?.k || 1;
      const s = selRef.current;
      const selKey = s ? `${s.kind}:${s.id}` : '';
      const restyle = k !== lastK || selKey !== lastSel;
      const alive: Particle[] = [];
      for (const p of particles.current) {
        p.s += p.dir * p.speed * dt;
        if (p.s < 0 || p.s > p.route.len) { p.el.style.display = 'none'; pool.current.push(p.el); continue; }
        const pt = pointAt(p.route, p.s);
        p.el.setAttribute('cx', pt.x.toFixed(1));
        p.el.setAttribute('cy', pt.y.toFixed(1));
        if (restyle) {
          p.el.setAttribute('r', ((1.9 + 1.7 * p.size) / Math.sqrt(k)).toFixed(2));
          const dim = !!s && (s.kind === 'device' ? p.mac !== s.id : s.kind === 'exit' ? p.exit !== s.id : p.acc !== s.id);
          if (dim !== p.dim) { p.dim = dim; p.el.style.opacity = dim ? '0.12' : ''; }
        }
        alive.push(p);
      }
      particles.current = alive;
      lastK = k; lastSel = selKey;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      layer.replaceChildren();
      particles.current = [];
      pool.current = [];
    };
  }, [reduced, svgReady]);

  // ─── Çizim ───
  const lod: 0 | 1 | 2 = !view ? 1 : view.k < LOD_AT[layout.mode][0] ? 0 : view.k < LOD_AT[layout.mode][1] ? 1 : 2;
  const onlineCount = devices.filter(d => d.online).length;
  const activeCount = devices.filter(d => d.downBps + d.upBps > 0).length;
  const total = devices.reduce((a, d) => ({ down: a.down + d.downBps, up: a.up + d.upBps }), { down: 0, up: 0 });
  const selDevice = sel?.kind === 'device' ? devices.find(d => d.mac === sel.id) : undefined;
  const selExit = sel?.kind === 'exit' ? exitsById.get(sel.id) : undefined;
  const selAccess = sel?.kind === 'access' && accStats.has(sel.id) ? sel.id : undefined;
  const hasSel = !!(selDevice || selExit || selAccess);
  const linkW = (bps: number) => (bps > 0 ? 1.3 + 2.4 * level(bps) : 1);
  const pi = layout.pi, net = layout.internet;

  return (
    <div className="fade-in">
      <Panel title="Canlı Ağ Topolojisi"
        subtitle="Her cihazın ağa nasıl bağlandığı (kablolu / Wi-Fi) ve internete hangi yoldan çıktığı: yerel, DPI ya da VPS tüneli. Tekerlek ya da iki parmakla yakınlaştırın — ayrıntılar yakınlaştıkça açılır; bir cihaza dokunmak onu büyütür."
        badge={<Badge variant="info">{onlineCount} çevrimiçi</Badge>}
        actions={<button className="icon-btn" onClick={refetch} title="Yenile" aria-label="Yenile"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>}>

        <div ref={stageRef} className={`topo-stage topo-${layout.mode}${hasSel ? ' has-sel' : ''}`} tabIndex={0}
          role="application" aria-roledescription="ağ haritası"
          aria-label={`Ağ haritası: ${onlineCount} çevrimiçi cihaz, ${activeCount} aktif. Yakınlaştırmak için + ve −, sığdırmak için 0, kaydırmak için ok tuşları.`}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onClick={onStageClick} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}>

          {!data && (
            <div className="topo-empty">
              {error ? <>Harita verisi alınamadı ({error}). <button className="btn-outline btn-sm" onClick={refetch}>Tekrar dene</button></> : 'Harita yükleniyor…'}
            </div>
          )}

          {data && view && (
            <svg className="topo-svg" width={size.w} height={size.h}>
              <defs>
                <pattern id="topo-grid" width={24} height={24} patternUnits="userSpaceOnUse">
                  <circle cx={1} cy={1} r={0.9} className="topo-grid-dot" />
                </pattern>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                <rect x={layout.bounds.x - 2000} y={layout.bounds.y - 2000} width={layout.bounds.w + 4000} height={layout.bounds.h + 4000} fill="url(#topo-grid)" />
                {layout.tiers.map(t => <text key={t.text} x={t.x} y={t.y} textAnchor={t.anchor} className="topo-tier" fontSize={9}>{t.text}</text>)}

                <g className="topo-links">
                  {exits.map(x => {
                    const a = layout.exitLink.get(x.id), b = layout.netLink.get(x.id);
                    const bps = x.downBps + x.upBps;
                    const cls = `topo-link topo-c-${clsOf(x.id)} ${bps > 0 ? 'is-active' : 'is-idle'}${hl.exs.has(x.id) ? ' is-hl' : ''}`;
                    return <g key={x.id}>
                      {a && <path d={a.d} className={cls} strokeWidth={linkW(bps)} />}
                      {b && <path d={b.d} className={cls} strokeWidth={linkW(bps)} />}
                    </g>;
                  })}
                  {ACCESS_ORDER.map(id => {
                    const p = layout.accessLink.get(id), st = accStats.get(id);
                    if (!p || !st) return null;
                    const bps = st.down + st.up;
                    return <path key={id} d={p.d} strokeWidth={linkW(bps)}
                      className={`topo-link topo-c-mix ${bps > 0 ? 'is-active' : 'is-idle'}${hl.accs.has(id) ? ' is-hl' : ''}`} />;
                  })}
                  {shown.map(d => {
                    const p = layout.devLink.get(d.mac);
                    if (!p) return null;
                    const bps = d.downBps + d.upBps;
                    return <path key={d.mac} d={p.d} strokeWidth={linkW(bps)}
                      className={`topo-link topo-c-${dominantCls(d)} ${bps > 0 ? 'is-active' : d.routed ? 'is-idle' : 'is-none'}${hl.devs.has(d.mac) ? ' is-hl' : ''}`} />;
                  })}
                </g>

                <g ref={partRef} className="topo-particles" />

                <g className="topo-nodes">
                  <g className="topo-node topo-net is-hl">
                    <rect x={net.x} y={net.y} width={net.w} height={net.h} rx={net.h / 2} className="topo-card" />
                    <svg x={net.x + 12} y={net.y + net.h / 2 - 8} width={16} height={16} viewBox="0 0 24 24" className="topo-icon"><Globe size={24} strokeWidth={1.8} /></svg>
                    <text x={net.x + 34} y={net.y + net.h / 2 + (lod === 2 ? -1 : 4)} className="topo-t-name" fontSize={lod === 2 ? 9 : 11.5}>İnternet</text>
                    {lod === 2 && <text x={net.x + 34} y={net.y + net.h / 2 + 8} className="topo-t-rate" fontSize={6}>{rates(total.down, total.up)}</text>}
                  </g>
                  {exits.map(x => { const b = layout.exits.get(x.id); return b ? <ExitNode key={x.id} x={x} b={b} lod={lod} mode={layout.mode} onPick={pickExit} hl={hl.exs.has(x.id)} /> : null; })}
                  {ACCESS_ORDER.map(id => {
                    const b = layout.access.get(id), st = accStats.get(id);
                    return b && st ? <AccessNode key={id} id={id} b={b} lod={lod} mode={layout.mode} st={st} onPick={pickAccess} hl={hl.accs.has(id)} /> : null;
                  })}
                  <g className="topo-node topo-pi is-hl" aria-label={`Klyrix Gate ${data.gateway.lanIp}`}>
                    <rect x={pi.x} y={pi.y} width={pi.w} height={pi.h} rx={12} className="topo-card" />
                    <svg x={pi.x + 12} y={pi.y + pi.h / 2 - 10} width={20} height={20} viewBox="0 0 24 24" className="topo-icon"><Router size={24} strokeWidth={1.8} /></svg>
                    <text x={pi.x + 40} y={pi.y + pi.h / 2 - (lod === 0 ? -4 : 3)} className="topo-t-name" fontSize={lod === 0 ? 13 : 11.5}>Klyrix Gate</text>
                    {lod > 0 && <text x={pi.x + 40} y={pi.y + pi.h / 2 + 10} className="topo-t-mono" fontSize={lod === 2 ? 7 : 8.5}>{data.gateway.lanIp || '—'}</text>}
                    {lod === 2 && <text x={pi.x + 40} y={pi.y + pi.h / 2 + 19} className="topo-t-rate" fontSize={6}>{rates(total.down, total.up)}</text>}
                  </g>
                  {shown.map(d => { const b = layout.devices.get(d.mac); return b ? <DeviceNode key={d.mac} d={d} b={b} lod={lod} mode={layout.mode} exitsById={exitsById} onPick={pickDevice} hl={hl.devs.has(d.mac)} /> : null; })}
                </g>
              </g>
            </svg>
          )}

          {data && (
            <>
              <div className="topo-ui topo-ui-tl" onPointerDown={e => e.stopPropagation()}>
                {/* Dar ekranda sayı zaten panel başlığında; yer çevrimdışı düğmesine kalır. */}
                <span className="topo-chip topo-wide-only">{onlineCount} çevrimiçi · {activeCount} aktif</span>
                {offlineCount > 0 && (
                  <button className={`topo-chip topo-chip-btn${showOffline ? ' is-on' : ''}`} onClick={() => setShowOffline(v => !v)} aria-pressed={showOffline}>
                    {showOffline ? `Çevrimdışıları gizle (${offlineCount})` : `+${offlineCount} çevrimdışı`}
                  </button>
                )}
              </div>
              <div className="topo-ui topo-ui-tr" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                <button className={`topo-tool${preview ? ' is-on' : ''}`} onClick={() => setPreview(v => !v)} aria-pressed={preview}
                  title={preview ? 'Canlı trafiğe dön' : 'Rota önizlemesi: tüm bağlantı türlerini temsili akışla göster'}>
                  {preview ? <EyeOff size={14} /> : <Eye size={14} />}<span className="topo-tool-label">{preview ? 'Canlı' : 'Önizleme'}</span>
                </button>
                <span className="topo-tool-sep" />
                <button className="topo-tool" onClick={() => zoomCenter(1 / 1.4)} title="Uzaklaştır (−)" aria-label="Uzaklaştır"><Minus size={14} /></button>
                <span className="topo-zoom topo-wide-only" aria-live="polite">{Math.round((view?.k || 1) * 100)}%</span>
                <button className="topo-tool" onClick={() => zoomCenter(1.4)} title="Yakınlaştır (+)" aria-label="Yakınlaştır"><Plus size={14} /></button>
                <button className="topo-tool" onClick={fitNow} title="Sığdır (0)" aria-label="Haritayı sığdır"><Maximize size={14} /></button>
              </div>
              <div className="topo-ui topo-banners" role="status">
                {preview && <div className="topo-banner">Önizleme: tüm rotalar temsili akışla gösteriliyor — gerçek trafik değil</div>}
                {!preview && !data.accounting && <div className="topo-banner is-warn">Trafik sayaçları okunamadı — hızlar gösterilemiyor</div>}
                {devices.length === 0 && <div className="topo-banner">Henüz cihaz görünmüyor</div>}
              </div>

              {!hasSel && (
                <div className="topo-ui topo-legend" onPointerDown={e => e.stopPropagation()}>
                  <span className="topo-c-local"><i />Yerel</span>
                  <span className="topo-c-dpi"><i />DPI (istenen)</span>
                  <span className="topo-c-vps"><i />VPS tüneli</span>
                  <span className="topo-legend-note">{reduced ? 'Kalın çizgi = trafik var' : 'Akan noktalar = gerçek trafik'}{lod < 2 ? ' · ayrıntı için yakınlaştırın' : ''}</span>
                </div>
              )}

              {hasSel && (
                <div className="topo-ui topo-drawer" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} role="dialog" aria-label="Ayrıntılar">
                  <button className="topo-drawer-close" onClick={() => setSel(null)} aria-label="Kapat"><X size={14} /></button>
                  {selDevice && (
                    <>
                      <div className="topo-drawer-title">{deviceName(selDevice)}</div>
                      <div className="topo-drawer-sub">
                        {selDevice.ip || '—'} · <span className="mono">{selDevice.mac}</span>
                        {TYPE_LABEL[selDevice.type] ? ` · ${TYPE_LABEL[selDevice.type]}` : ''}
                        {' · '}{selDevice.online ? 'çevrimiçi' : 'çevrimdışı'}{selDevice.blocked ? ' · engelli' : ''}
                      </div>
                      <div className="topo-drawer-sub">Bağlantı: {linkText(selDevice.link)}</div>
                      {selDevice.flows.length === 0
                        ? <div className="topo-drawer-empty">Bu cihazın Pi üzerinden geçen trafiği görülmedi{selDevice.online ? ' (modemin ağında olabilir ya da henüz bağlantı kurmadı)' : ''}.</div>
                        : (
                          <table className="topo-flows">
                            <thead><tr><th>Yol</th><th>↓ İndirme</th><th>↑ Yükleme</th><th>Toplam</th></tr></thead>
                            <tbody>
                              {selDevice.flows.map(f => {
                                const x = exitsById.get(f.exit);
                                return (
                                  <tr key={f.exit} className={`topo-c-${clsOf(f.exit)}`}>
                                    <td><i className="topo-swatch" />{exitShort(x, f.exit)}{f.dpiRequested && x?.kind === 'vps' && <span className="topo-note" title="Bu kurallarda DPI de istendi; tünel içinde etkisizdir"> +DPI (tünelde etkisiz)</span>}</td>
                                    <td>{fmtRate(f.downBps)}</td>
                                    <td>{fmtRate(f.upBps)}</td>
                                    <td>{fmtBytes(f.bytesDown + f.bytesUp)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                    </>
                  )}
                  {selAccess && (
                    <>
                      <div className="topo-drawer-title">{ACCESS_LABEL[selAccess]} · {accStats.get(selAccess)!.count} cihaz</div>
                      <div className="topo-drawer-sub">
                        {selAccess === 'acc:setup'
                          ? "Pi'nin kendi Kurulum Wi-Fi'ına bağlı cihazlar (kesin)."
                          : 'Pi her cihaza ara sıra ARP ile sorar: kablolu cihaz modeme göre 1 ms içinde ve sabit yanıt verir, Wi-Fi\'daki cihaz radyo yüzünden dalgalı ve yavaş. Gizli MAC ve telefon/tablet de Wi-Fi ipucudur.'}
                      </div>
                      <table className="topo-flows">
                        <thead><tr><th>Cihaz</th><th>Neye göre</th><th>↓ İndirme</th><th>↑ Yükleme</th></tr></thead>
                        <tbody>
                          {shown.filter(d => accessOf(d) === selAccess).slice(0, 12).map(d => (
                            <tr key={d.mac}>
                              <td>{deviceName(d)}</td>
                              <td className="topo-note">{linkText(d.link).replace(/^[^—]*— /, '')}</td>
                              <td>{fmtRate(d.downBps)}</td>
                              <td>{fmtRate(d.upBps)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  {selExit && (
                    <>
                      <div className="topo-drawer-title"><i className={`topo-swatch topo-c-${clsOf(selExit.id)}`} />{selExit.kind === 'vps' ? `VPS · ${selExit.label}` : selExit.label}</div>
                      <div className="topo-drawer-sub">{selExit.detail} · {exitStatus(selExit)}</div>
                      <div className="topo-drawer-sub">{rates(selExit.downBps, selExit.upBps)} · Toplam ↓ {fmtBytes(selExit.bytesDown)} ↑ {fmtBytes(selExit.bytesUp)}</div>
                      {(() => {
                        const users = devices
                          .map(d => ({ d, f: d.flows.find(f => f.exit === selExit.id) }))
                          .filter((u): u is { d: TopoDevice; f: Flow } => !!u.f && u.f.bytesDown + u.f.bytesUp > 0)
                          .sort((a, b) => (b.f.downBps + b.f.upBps) - (a.f.downBps + a.f.upBps) || (b.f.bytesDown + b.f.bytesUp) - (a.f.bytesDown + a.f.bytesUp));
                        if (!users.length) return <div className="topo-drawer-empty">Bu yoldan geçen cihaz trafiği görülmedi.</div>;
                        return (
                          <table className="topo-flows">
                            <thead><tr><th>Cihaz</th><th>↓ İndirme</th><th>↑ Yükleme</th><th>Toplam</th></tr></thead>
                            <tbody>
                              {users.slice(0, 8).map(({ d, f }) => (
                                <tr key={d.mac}><td>{deviceName(d)}</td><td>{fmtRate(f.downBps)}</td><td>{fmtRate(f.upBps)}</td><td>{fmtBytes(f.bytesDown + f.bytesUp)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}

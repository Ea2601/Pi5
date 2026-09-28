// Ağ haritasının geometrisi (saf; DOM yok): katmanlı yerleşim ve akış parçacıklarının izlediği yollar.
// Geniş ekran: soldan sağa Cihazlar → Pi → Çıkışlar → İnternet. Dar ekran (telefon): yukarıdan aşağı İnternet → çıkışlar
// (tek sıra) → Pi → cihazlar (liste; bağlantılar soldaki gövde çizgisinden). Hiçbir bağlantı bir kartın üstünden geçmez.

export type ExitId = 'local' | 'dpi' | `vps:${number}`;
export type LayoutMode = 'wide' | 'narrow';
export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
type Seg = { k: 'L'; to: Pt } | { k: 'Q'; c: Pt; to: Pt } | { k: 'C'; c1: Pt; c2: Pt; to: Pt };
export type PathGeom = { d: string; pts: Pt[]; cum: number[]; len: number };

const STEPS = 14;
const f = (n: number) => Math.round(n * 10) / 10;

export function buildPath(start: Pt, segs: Seg[]): PathGeom {
  let d = `M${f(start.x)} ${f(start.y)}`;
  const pts: Pt[] = [start];
  let p = start;
  for (const s of segs) {
    if (s.k === 'L') {
      d += ` L${f(s.to.x)} ${f(s.to.y)}`;
      pts.push(s.to);
    } else if (s.k === 'Q') {
      d += ` Q${f(s.c.x)} ${f(s.c.y)} ${f(s.to.x)} ${f(s.to.y)}`;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        pts.push({ x: u * u * p.x + 2 * u * t * s.c.x + t * t * s.to.x, y: u * u * p.y + 2 * u * t * s.c.y + t * t * s.to.y });
      }
    } else {
      d += ` C${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.to.x)} ${f(s.to.y)}`;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        pts.push({
          x: u * u * u * p.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
          y: u * u * u * p.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
        });
      }
    }
    p = s.to;
  }
  return withLengths(d, pts);
}

function withLengths(d: string, pts: Pt[]): PathGeom {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { d, pts, cum, len: cum[cum.length - 1] };
}

// Yolları uç uca ekler; aradaki boşluk (kartın içi) düz çizgiyle geçilir — parçacık kartın arkasından geçer.
export function joinPaths(paths: PathGeom[]): PathGeom {
  const pts: Pt[] = [];
  for (const p of paths) pts.push(...p.pts);
  return withLengths('', pts);
}

// Yol üzerinde baştan s uzaklıktaki nokta (s sınırlanır).
export function pointAt(p: PathGeom, s: number): Pt {
  if (p.pts.length === 1 || s <= 0) return p.pts[0];
  if (s >= p.len) return p.pts[p.pts.length - 1];
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = p.cum[hi] - p.cum[lo] || 1;
  const t = (s - p.cum[lo]) / seg;
  return { x: p.pts[lo].x + (p.pts[hi].x - p.pts[lo].x) * t, y: p.pts[lo].y + (p.pts[hi].y - p.pts[lo].y) * t };
}

export type TierLabel = { text: string; x: number; y: number; anchor: 'start' | 'middle' };
export type Layout = {
  mode: LayoutMode;
  devices: Map<string, Box>;
  exits: Map<ExitId, Box>;
  pi: Box;
  internet: Box;
  devLink: Map<string, PathGeom>;   // cihaz → Pi
  exitLink: Map<ExitId, PathGeom>;  // Pi → çıkış
  netLink: Map<ExitId, PathGeom>;   // çıkış → internet
  tiers: TierLabel[];
  bounds: Box;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const cubicH = (a: Pt, b: Pt) => buildPath(a, [{ k: 'C', c1: { x: (a.x + b.x) / 2, y: a.y }, c2: { x: (a.x + b.x) / 2, y: b.y }, to: b }]);

export const WIDE = { devW: 220, devH: 44, row: 56, piW: 156, piH: 64, exitW: 184, exitH: 56, exitRow: 72, netW: 112, netH: 44 };
export const NARROW = { W: 340, devW: 292, devH: 44, row: 54, piW: 170, piH: 52, exitW: 76, exitH: 46, exitGap: 8, netW: 120, netH: 36 };

// Geniş ekranda kalabalık ağ tek sütunda okunmaz hale gelir: cihazlar ekrana en iyi sığan sütun sayısına bölünür
// (fazla sütun ancak ölçeği belirgin büyütüyorsa). vp = sığdırma için kullanılabilir alan (px).
export function computeLayout(mode: LayoutMode, deviceKeys: string[], exitIds: ExitId[], vp?: { w: number; h: number }): Layout {
  if (mode === 'narrow') return narrowLayout(deviceKeys, exitIds);
  let best = wideLayout(deviceKeys, exitIds, 1);
  if (!vp || vp.w <= 0 || vp.h <= 0 || deviceKeys.length <= 6) return best;
  const scale = (l: Layout) => Math.min(1.1, vp.w / l.bounds.w, vp.h / l.bounds.h);
  let bestK = scale(best);
  for (let c = 2; c <= Math.min(6, Math.ceil(deviceKeys.length / 3)); c++) {
    const lay = wideLayout(deviceKeys, exitIds, c);
    const k = scale(lay);
    if (k > bestK * 1.04) { best = lay; bestK = k; }
  }
  return best;
}

const CHAN = 40; // sütunlar arası kanal: uzak sütunların bağlantıları buradan geçer

function wideLayout(deviceKeys: string[], exitIds: ExitId[], cols: number): Layout {
  const L = WIDE;
  const n = deviceKeys.length, m = exitIds.length;
  const C = Math.max(1, Math.min(cols, n || 1));
  const R = n ? Math.ceil(n / C) : 0;
  const colX = (c: number) => -c * (L.devW + CHAN);
  const piCx = L.devW + (C > 1 ? 190 : 160);
  const exitX = piCx + L.piW / 2 + 130;
  const netCx = exitX + L.exitW + 110;
  const pi: Box = { x: piCx - L.piW / 2, y: -L.piH / 2, w: L.piW, h: L.piH };
  const internet: Box = { x: netCx - L.netW / 2, y: -L.netH / 2, w: L.netW, h: L.netH };
  const gridTop = -(R * L.row) / 2, gridBot = (R * L.row) / 2;
  const busTop = gridTop - 10, busBot = gridBot + 10, rr = 8;
  const entry = (y: number) => clamp(y * 0.12, -L.piH / 2 + 10, L.piH / 2 - 10);
  const devices = new Map<string, Box>();
  const devLink = new Map<string, PathGeom>();
  deviceKeys.forEach((k, i) => {
    const c = Math.floor(i / R), r = i % R;
    const x = colX(c), cy = (r - (R - 1) / 2) * L.row;
    devices.set(k, { x, y: cy - L.devH / 2, w: L.devW, h: L.devH });
    if (c === 0) {
      // En yakın sütun: doğrudan Pi'ye; giriş noktaları Pi'nin sol kenarına yayılır.
      devLink.set(k, cubicH({ x: L.devW, y: cy }, { x: pi.x, y: entry(cy) }));
      return;
    }
    // Uzak sütun: sağındaki kanaldan ızgaranın üstündeki/altındaki yola, oradan Pi'ye (kartların üstünden geçmez).
    const chX = x + L.devW + CHAN / 2;
    const up = cy <= 0, busY = up ? busTop : busBot, s = up ? -1 : 1;
    const busEnd = { x: L.devW + 24, y: busY };
    const bus = buildPath({ x: x + L.devW, y: cy }, [
      { k: 'L', to: { x: chX - rr, y: cy } }, { k: 'Q', c: { x: chX, y: cy }, to: { x: chX, y: cy + s * rr } },
      { k: 'L', to: { x: chX, y: busY - s * rr } }, { k: 'Q', c: { x: chX, y: busY }, to: { x: chX + rr, y: busY } },
      { k: 'L', to: busEnd },
    ]);
    const tail = cubicH(busEnd, { x: pi.x, y: entry(busY) });
    devLink.set(k, { ...joinPaths([bus, tail]), d: `${bus.d} ${tail.d.replace(/^M[^C]*/, '')}` });
  });
  const exits = new Map<ExitId, Box>();
  const exitLink = new Map<ExitId, PathGeom>();
  const netLink = new Map<ExitId, PathGeom>();
  exitIds.forEach((id, j) => {
    const cy = (j - (m - 1) / 2) * L.exitRow;
    exits.set(id, { x: exitX, y: cy - L.exitH / 2, w: L.exitW, h: L.exitH });
    exitLink.set(id, cubicH({ x: pi.x + pi.w, y: clamp(cy * 0.2, -L.piH / 2 + 10, L.piH / 2 - 10) }, { x: exitX, y: cy }));
    netLink.set(id, cubicH({ x: exitX + L.exitW, y: cy }, { x: internet.x, y: clamp(cy * 0.2, -L.netH / 2 + 8, L.netH / 2 - 8) }));
  });
  const top = Math.min(C > 1 ? busTop : gridTop, -(m * L.exitRow) / 2, pi.y);
  const bottom = Math.max(C > 1 ? busBot : gridBot, (m * L.exitRow) / 2, pi.y + pi.h);
  const labelY = top - 14;
  const left = colX(C - 1);
  const tiers: TierLabel[] = [
    { text: 'CİHAZLAR', x: left, y: labelY, anchor: 'start' },
    { text: 'AĞ GEÇİDİ', x: piCx, y: labelY, anchor: 'middle' },
    { text: 'ÇIKIŞ', x: exitX, y: labelY, anchor: 'start' },
    { text: 'İNTERNET', x: netCx, y: labelY, anchor: 'middle' },
  ];
  return {
    mode: 'wide', devices, exits, pi, internet, devLink, exitLink, netLink, tiers,
    bounds: { x: left - 16, y: labelY - 18, w: internet.x + internet.w + 16 - (left - 16), h: bottom + 16 - (labelY - 18) },
  };
}

function narrowLayout(deviceKeys: string[], exitIds: ExitId[]): Layout {
  const L = NARROW;
  const m = exitIds.length;
  const rowW = m * L.exitW + Math.max(0, m - 1) * L.exitGap;
  const W = Math.max(L.W, rowW + 16);
  const cx = W / 2, XL = 16, r = 10, cardX = 40;
  const internet: Box = { x: cx - L.netW / 2, y: 4, w: L.netW, h: L.netH };
  const exitTop = internet.y + L.netH + 34;
  const exits = new Map<ExitId, Box>();
  const exitLink = new Map<ExitId, PathGeom>();
  const netLink = new Map<ExitId, PathGeom>();
  const pi: Box = { x: cx - L.piW / 2, y: exitTop + (m ? L.exitH : 0) + 36, w: L.piW, h: L.piH };
  const piY = pi.y + L.piH / 2;
  const cubicV = (a: Pt, b: Pt) => buildPath(a, [{ k: 'C', c1: { x: a.x, y: (a.y + b.y) / 2 }, c2: { x: b.x, y: (a.y + b.y) / 2 }, to: b }]);
  exitIds.forEach((id, j) => {
    const b: Box = { x: cx - rowW / 2 + j * (L.exitW + L.exitGap), y: exitTop, w: L.exitW, h: L.exitH };
    exits.set(id, b);
    const ex = b.x + b.w / 2;
    // Pi'nin üst kenarından yukarı yelpaze; çıkışın üstünden internete.
    exitLink.set(id, cubicV({ x: clamp(cx + (ex - cx) * 0.3, pi.x + 14, pi.x + pi.w - 14), y: pi.y }, { x: ex, y: b.y + b.h }));
    netLink.set(id, cubicV({ x: ex, y: b.y }, { x: clamp(cx + (ex - cx) * 0.25, internet.x + 14, internet.x + internet.w - 14), y: internet.y + L.netH }));
  });
  const firstDevTop = pi.y + L.piH + 34;
  const devices = new Map<string, Box>();
  const devLink = new Map<string, PathGeom>();
  deviceKeys.forEach((k, i) => {
    const b: Box = { x: cardX, y: firstDevTop + i * L.row, w: L.devW, h: L.devH };
    devices.set(k, b);
    const y = b.y + L.devH / 2;
    // Kartın solundan gövde çizgisine, gövdeden yukarı Pi'nin sol kenarına.
    devLink.set(k, buildPath({ x: cardX, y }, [
      { k: 'L', to: { x: XL + r, y } }, { k: 'Q', c: { x: XL, y }, to: { x: XL, y: y - r } },
      { k: 'L', to: { x: XL, y: piY + r } }, { k: 'Q', c: { x: XL, y: piY }, to: { x: XL + r, y: piY } },
      { k: 'L', to: { x: pi.x, y: piY } },
    ]));
  });
  const bottom = deviceKeys.length ? firstDevTop + (deviceKeys.length - 1) * L.row + L.devH : pi.y + L.piH;
  const tiers: TierLabel[] = deviceKeys.length ? [{ text: 'CİHAZLAR', x: cardX, y: firstDevTop - 10, anchor: 'start' }] : [];
  return {
    mode: 'narrow', devices, exits, pi, internet, devLink, exitLink, netLink, tiers,
    bounds: { x: 0, y: 0, w: W, h: bottom + 12 },
  };
}

// Bayt/sn → görsel yoğunluk 0..1 (100 B/sn → 0, 10 MB/sn → 1; logaritmik).
export function level(bps: number): number {
  if (!(bps > 0)) return 0;
  return clamp(Math.log10(bps / 100) / 5, 0, 1);
}

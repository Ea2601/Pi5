// Ağ haritasının geometrisi (saf; DOM yok): katmanlı yerleşim ve akış parçacıklarının izlediği yollar.
// Geniş ekran: soldan sağa Cihazlar → Erişim (kablolu / Wi-Fi) → Pi → Çıkışlar → İnternet. Dar ekran (telefon): yukarıdan
// aşağı İnternet → çıkışlar (tek sıra) → Pi → erişim grupları ve altlarında cihazlar. Hiçbir bağlantı bir kartın üstünden geçmez.

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

// Yolları uç uca ekler; aradaki boşluk (kartın içi) düz çizgiyle geçilir — parçacık orada gizlenir, kartın ledi yanar
// (NetworkTopology parçacık motoru).
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
// Erişim katmanı: cihazın Pi'ye hangi yoldan geldiği (kablolu / Wi-Fi / Pi'nin Kurulum Wi-Fi'ı / Ev VPN'i / belirsiz).
export type AccessId = 'acc:wired' | 'acc:wifi' | 'acc:setup' | 'acc:vpn' | 'acc:unknown';
export type AccessGroup = { id: AccessId; keys: string[] };
export type Layout = {
  mode: LayoutMode;
  devices: Map<string, Box>;
  access: Map<AccessId, Box>;
  exits: Map<ExitId, Box>;
  pi: Box;
  internet: Box;
  devLink: Map<string, PathGeom>;       // cihaz → erişim
  accessLink: Map<AccessId, PathGeom>;  // erişim → Pi
  exitLink: Map<ExitId, PathGeom>;      // Pi → çıkış
  netLink: Map<ExitId, PathGeom>;       // çıkış → internet
  tiers: TierLabel[];
  bounds: Box;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const cubicH = (a: Pt, b: Pt) => buildPath(a, [{ k: 'C', c1: { x: (a.x + b.x) / 2, y: a.y }, c2: { x: (a.x + b.x) / 2, y: b.y }, to: b }]);

export const WIDE = {
  devW: 220, devH: 44, row: 56, accW: 170, accH: 52, piW: 156, piH: 64, exitW: 184, exitH: 56, exitRow: 72, netW: 112, netH: 44,
};
export const NARROW = { W: 340, devW: 268, devH: 44, row: 54, hdrH: 34, piW: 170, piH: 52, exitW: 76, exitH: 46, exitGap: 8, netW: 120, netH: 36 };

// Geniş ekranda kalabalık ağ tek sütunda okunmaz hale gelir: cihazlar ekrana en iyi sığan sütun sayısına bölünür
// (fazla sütun ancak ölçeği belirgin büyütüyorsa). vp = sığdırma için kullanılabilir alan (px).
export function computeLayout(mode: LayoutMode, groups: AccessGroup[], exitIds: ExitId[], vp?: { w: number; h: number }): Layout {
  const live = groups.filter(g => g.keys.length);
  if (mode === 'narrow') return narrowLayout(live, exitIds);
  let best = wideLayout(live, exitIds, 1);
  const n = live.reduce((a, g) => a + g.keys.length, 0);
  if (!vp || vp.w <= 0 || vp.h <= 0 || n <= 6) return best;
  const scale = (l: Layout) => Math.min(1.1, vp.w / l.bounds.w, vp.h / l.bounds.h);
  let bestK = scale(best);
  for (let c = 2; c <= Math.min(6, Math.ceil(n / 3)); c++) {
    const lay = wideLayout(live, exitIds, c);
    const k = scale(lay);
    if (k > bestK * 1.04) { best = lay; bestK = k; }
  }
  return best;
}

const CHAN = 40;      // sütunlar arası kanal: uzak sütunların bağlantıları buradan geçer
const BLOCK_GAP = 40; // erişim grupları arası boşluk (grup yolları birbirine karışmasın)

function wideLayout(groups: AccessGroup[], exitIds: ExitId[], cols: number): Layout {
  const L = WIDE;
  const m = exitIds.length;
  const colX = (c: number) => -c * (L.devW + CHAN);
  const accX = L.devW + 110;
  const piCx = accX + L.accW + 120 + L.piW / 2;
  const exitX = piCx + L.piW / 2 + 120;
  const netCx = exitX + L.exitW + 100;
  const pi: Box = { x: piCx - L.piW / 2, y: -L.piH / 2, w: L.piW, h: L.piH };
  const internet: Box = { x: netCx - L.netW / 2, y: -L.netH / 2, w: L.netW, h: L.netH };
  // Gruplar alt alta bloklar; her blok C sütun (cihaz sayısı azsa daha az). Tüm cihaz alanı y=0'a ortalanır.
  const blocks = groups.map(g => {
    const C = Math.max(1, Math.min(cols, g.keys.length));
    const R = Math.ceil(g.keys.length / C);
    return { g, C, R, h: R * L.row };
  });
  const totalH = blocks.reduce((a, b) => a + b.h, 0) + Math.max(0, blocks.length - 1) * BLOCK_GAP;
  const devices = new Map<string, Box>();
  const devLink = new Map<string, PathGeom>();
  const access = new Map<AccessId, Box>();
  const accessLink = new Map<AccessId, PathGeom>();
  let y0 = -totalH / 2;
  let maxC = 1, gridTop = 0, gridBot = 0, anyBus = false;
  const rr = 8;
  blocks.forEach((bl, bi) => {
    const top = y0, bot = y0 + bl.h, cyBlock = (top + bot) / 2;
    if (bi === 0) gridTop = top;
    gridBot = bot;
    maxC = Math.max(maxC, bl.C);
    // Erişim kartı bloğun ortasında; önceki kartla çakışmasın (en az 64 aralık).
    const prev = bi > 0 ? access.get(blocks[bi - 1].g.id)! : null;
    const accCy = prev ? Math.max(cyBlock, prev.y + L.accH + 12 + L.accH / 2) : cyBlock;
    const acc: Box = { x: accX, y: accCy - L.accH / 2, w: L.accW, h: L.accH };
    access.set(bl.g.id, acc);
    const entry = (y: number) => accCy + clamp((y - accCy) * 0.15, -L.accH / 2 + 8, L.accH / 2 - 8);
    const busTop = top - 10, busBot = bot + 10;
    bl.g.keys.forEach((k, i) => {
      const c = Math.floor(i / bl.R), r = i % bl.R;
      const x = colX(c), cy = top + r * L.row + L.row / 2;
      devices.set(k, { x, y: cy - L.devH / 2, w: L.devW, h: L.devH });
      if (c === 0) {
        devLink.set(k, cubicH({ x: L.devW, y: cy }, { x: accX, y: entry(cy) }));
        return;
      }
      // Uzak sütun: sağındaki kanaldan bloğun üstündeki/altındaki yola, oradan erişim kartına (kartların üstünden geçmez).
      anyBus = true;
      const chX = x + L.devW + CHAN / 2;
      const up = cy <= cyBlock, busY = up ? busTop : busBot, s = up ? -1 : 1;
      const busEnd = { x: L.devW + 24, y: busY };
      const bus = buildPath({ x: x + L.devW, y: cy }, [
        { k: 'L', to: { x: chX - rr, y: cy } }, { k: 'Q', c: { x: chX, y: cy }, to: { x: chX, y: cy + s * rr } },
        { k: 'L', to: { x: chX, y: busY - s * rr } }, { k: 'Q', c: { x: chX, y: busY }, to: { x: chX + rr, y: busY } },
        { k: 'L', to: busEnd },
      ]);
      const tail = cubicH(busEnd, { x: accX, y: entry(busY) });
      devLink.set(k, { ...joinPaths([bus, tail]), d: `${bus.d} ${tail.d.replace(/^M[^C]*/, '')}` });
    });
    accessLink.set(bl.g.id, cubicH({ x: accX + L.accW, y: accCy }, { x: pi.x, y: clamp(accCy * 0.12, -L.piH / 2 + 10, L.piH / 2 - 10) }));
    y0 = bot + BLOCK_GAP;
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
  const accBoxes = [...access.values()];
  const top = Math.min(anyBus ? gridTop - 10 : gridTop, -(m * L.exitRow) / 2, pi.y, ...accBoxes.map(b => b.y));
  const bottom = Math.max(anyBus ? gridBot + 10 : gridBot, (m * L.exitRow) / 2, pi.y + pi.h, ...accBoxes.map(b => b.y + b.h));
  const labelY = top - 14;
  const left = colX(maxC - 1);
  const tiers: TierLabel[] = [
    { text: 'CİHAZLAR', x: left, y: labelY, anchor: 'start' },
    { text: 'ERİŞİM', x: accX, y: labelY, anchor: 'start' },
    { text: 'AĞ GEÇİDİ', x: piCx, y: labelY, anchor: 'middle' },
    { text: 'ÇIKIŞ', x: exitX, y: labelY, anchor: 'start' },
    { text: 'İNTERNET', x: netCx, y: labelY, anchor: 'middle' },
  ];
  return {
    mode: 'wide', devices, access, exits, pi, internet, devLink, accessLink, exitLink, netLink, tiers,
    bounds: { x: left - 16, y: labelY - 18, w: internet.x + internet.w + 16 - (left - 16), h: bottom + 16 - (labelY - 18) },
  };
}

function narrowLayout(groups: AccessGroup[], exitIds: ExitId[]): Layout {
  const L = NARROW;
  const m = exitIds.length;
  const rowW = m * L.exitW + Math.max(0, m - 1) * L.exitGap;
  const W = Math.max(L.W, rowW + 16);
  const cx = W / 2, XA = 14, XD = 48, r = 10, hdrX = 32, devX = 64;
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
  // Pi'nin altında her erişim grubu: başlık kartı (erişim düğümü) + girintili cihaz listesi. Cihazlar grubun gövde
  // çizgisinden başlığa, başlıklar en soldaki gövdeden Pi'ye bağlanır — hiçbir çizgi kartın üstünden geçmez.
  const devices = new Map<string, Box>();
  const devLink = new Map<string, PathGeom>();
  const access = new Map<AccessId, Box>();
  const accessLink = new Map<AccessId, PathGeom>();
  let y = pi.y + L.piH + 30;
  const hdrW = W - 8 - hdrX;
  for (const g of groups) {
    const hdr: Box = { x: hdrX, y, w: hdrW, h: L.hdrH };
    access.set(g.id, hdr);
    const hy = hdr.y + L.hdrH / 2;
    accessLink.set(g.id, buildPath({ x: hdrX, y: hy }, [
      { k: 'L', to: { x: XA + r, y: hy } }, { k: 'Q', c: { x: XA, y: hy }, to: { x: XA, y: hy - r } },
      { k: 'L', to: { x: XA, y: piY + r } }, { k: 'Q', c: { x: XA, y: piY }, to: { x: XA + r, y: piY } },
      { k: 'L', to: { x: pi.x, y: piY } },
    ]));
    y = hdr.y + L.hdrH + 10;
    for (const k of g.keys) {
      const b: Box = { x: devX, y, w: Math.min(L.devW, W - 8 - devX), h: L.devH };
      devices.set(k, b);
      const dy = b.y + L.devH / 2;
      devLink.set(k, buildPath({ x: devX, y: dy }, [
        { k: 'L', to: { x: XD + r, y: dy } }, { k: 'Q', c: { x: XD, y: dy }, to: { x: XD, y: dy - r } },
        { k: 'L', to: { x: XD, y: hdr.y + L.hdrH } },
      ]));
      y += L.row;
    }
    y += 14;
  }
  const bottom = groups.length ? y - 14 - (L.row - L.devH) : pi.y + L.piH;
  return {
    mode: 'narrow', devices, access, exits, pi, internet, devLink, accessLink, exitLink, netLink, tiers: [],
    bounds: { x: 0, y: 0, w: W, h: bottom + 12 },
  };
}

// Bayt/sn → görsel yoğunluk 0..1 (100 B/sn → 0, 10 MB/sn → 1; logaritmik).
export function level(bps: number): number {
  if (!(bps > 0)) return 0;
  return clamp(Math.log10(bps / 100) / 5, 0, 1);
}

// Giriş ekranı ile panelin ortak arka planı: ekranı kaplayan dijital ağ (üçgenlerden örülü mesh) + iki renk halkası.
// Salt süs: ekran okuyucuya kapalı, dokunma almaz. Ağ sabit tohumla bir kez üretilir (her açılışta aynı desen) ve tek
// birkaç <path> olarak çizilir (binlerce öğe değil). 'login' hareketlidir: ağ üzerinde ilerleyen ışık izleri + yanıp
// sönen düğümler. 'panel' hareketsizdir: panelde onlarca cam kart (backdrop-filter: blur) var; arkalarında hareket olursa
// tarayıcı bulanıklığı her karede yeniden hesaplar (telefonda ısınma / takılma). Girişte tek kart olduğu için orada sorun yok.

const W = 1600, H = 1000, CELL = 66;

// Tohumlu rastgele (mulberry32): desen her yüklemede aynı kalır.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = { x: number; y: number };
type Mesh = {
  lines: [string, string, string];   // soluk / orta / belirgin kenarlar
  nodes: [string, string, string];
  accents: Pt[];                     // öne çıkan düğümler (hafif parıltılı)
  pulses: { d: string; tone: 'a' | 'b'; dur: number; delay: number }[];
};

// Görünürlük alanı: kenarlara doğru belirgin, ortada (içeriğin arkası) soluk; üstüne yumuşak dalgalanma → düz ızgara
// yerine derinliği olan bir yüzey hissi.
function intensity(x: number, y: number): number {
  const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
  const edge = Math.min(1, Math.hypot(dx, dy) / 1.25);
  const wave = 0.5 + 0.28 * Math.sin(x / 190 + 1.3) * Math.cos(y / 140 - 0.7) + 0.22 * Math.sin((x + y) / 280);
  return 0.55 * edge + 0.45 * wave;
}
const bucket = (v: number) => (v < 0.42 ? 0 : v < 0.62 ? 1 : 2);
const dot = (p: Pt, r: number) => `M${p.x - r} ${p.y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

function buildMesh(): Mesh {
  const rand = rng(20260929);
  const cols = Math.ceil(W / CELL) + 2, rows = Math.ceil(H / CELL) + 2;
  // Titreşimli ızgara (bir hücre taşar: kırpılan kenarlarda boşluk kalmasın)
  const P: Pt[][] = [];
  for (let j = 0; j <= rows; j++) {
    const row: Pt[] = [];
    for (let i = 0; i <= cols; i++) {
      const jx = (rand() - 0.5) * CELL * 0.72, jy = (rand() - 0.5) * CELL * 0.72;
      row.push({ x: Math.round((i - 1) * CELL + jx), y: Math.round((j - 1) * CELL + jy) });
    }
    P.push(row);
  }
  const lines: [string[], string[], string[]] = [[], [], []];
  const adj = new Map<Pt, Pt[]>();
  const link = (a: Pt, b: Pt) => {
    lines[bucket(intensity((a.x + b.x) / 2, (a.y + b.y) / 2))].push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
    (adj.get(a) || adj.set(a, []).get(a)!).push(b);
    (adj.get(b) || adj.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const a = P[j][i];
      if (i < cols) link(a, P[j][i + 1]);
      if (j < rows) link(a, P[j + 1][i]);
      // Her hücre rastgele köşegenle iki üçgene bölünür
      if (i < cols && j < rows) { if (rand() < 0.5) link(a, P[j + 1][i + 1]); else link(P[j][i + 1], P[j + 1][i]); }
    }
  }
  const nodes: [string[], string[], string[]] = [[], [], []];
  const accents: Pt[] = [];
  for (const row of P) {
    for (const p of row) {
      if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
      const v = intensity(p.x, p.y), b = bucket(v);
      nodes[b].push(dot(p, b === 2 ? 1.6 : 1.2));
      if (v > 0.5 && rand() < 0.09) accents.push(p);
    }
  }
  // Işık izleri (yalnız girişte): öne çıkan düğümlerden başlayıp komşudan komşuya, geri dönmeden ilerleyen yollar.
  const pulses: Mesh['pulses'] = [];
  for (let k = 0; k < 9 && accents.length; k++) {
    let cur = accents[Math.floor(rand() * accents.length)];
    let prev: Pt | null = null;
    let d = `M${cur.x} ${cur.y}`;
    for (let s = 0; s < 9; s++) {
      const next = (adj.get(cur) || []).filter(q => q !== prev);
      if (!next.length) break;
      prev = cur;
      cur = next[Math.floor(rand() * next.length)];
      d += `L${cur.x} ${cur.y}`;
    }
    pulses.push({ d, tone: k % 3 === 2 ? 'b' : 'a', dur: 5 + rand() * 4, delay: -rand() * 8 });
  }
  return {
    lines: lines.map(l => l.join('')) as Mesh['lines'],
    nodes: nodes.map(n => n.join('')) as Mesh['nodes'],
    accents,
    pulses,
  };
}

const MESH = buildMesh();
const ACCENT_PATH = MESH.accents.map(p => dot(p, 2.2)).join('');
const GLOW_PATH = MESH.accents.map(p => dot(p, 7)).join('');

export function NetworkBackdrop({ variant = 'login' }: { variant?: 'login' | 'panel' }) {
  const live = variant === 'login';
  return (
    <div className={`net-bg net-bg-${variant}`} aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <path className="net-mesh net-mesh-1" d={MESH.lines[0]} />
        <path className="net-mesh net-mesh-2" d={MESH.lines[1]} />
        <path className="net-mesh net-mesh-3" d={MESH.lines[2]} />
        <path className="net-node net-node-1" d={MESH.nodes[0]} />
        <path className="net-node net-node-2" d={MESH.nodes[1]} />
        <path className="net-node net-node-3" d={MESH.nodes[2]} />
        {live && MESH.pulses.map((p, i) => (
          <path key={i} className={`net-pulse net-pulse-${p.tone}`} d={p.d} pathLength={100}
            style={{ animationDuration: `${p.dur.toFixed(1)}s`, animationDelay: `${p.delay.toFixed(1)}s` }} />
        ))}
        <path className="net-glow" d={GLOW_PATH} />
        {live
          ? MESH.accents.map((p, i) => (
            <circle key={i} className="net-acc net-twinkle" cx={p.x} cy={p.y} r={2.2} style={{ animationDelay: `${-((i * 0.73) % 4).toFixed(2)}s` }} />
          ))
          : <path className="net-acc" d={ACCENT_PATH} />}
      </svg>
    </div>
  );
}

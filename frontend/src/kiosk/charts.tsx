// Kiosk grafikleri: kütüphanesiz, hafif SVG (Pi'nin tarayıcısı 7/24 çizer — recharts'ın ölçüm/animasyon yükü yok).
// Çizgiler vector-effect=non-scaling-stroke: viewBox esnese de kalınlık sabit. Renkler CSS değişkeni olarak gelir →
// panel temasına ve vurgu rengine uyar.
import { useId } from 'react';

// Halka gösterge (0–100). Değer yoksa boş halka. Boyut CSS'ten (.k-ring genişliği) gelir.
export function Ring({ value, color, stroke = 9, children }: {
  value: number | null; color: string; stroke?: number; children?: React.ReactNode;
}) {
  const r = 50 - stroke / 2;
  const c = 2 * Math.PI * r;
  const v = value == null || !isFinite(value) ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div className="k-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--k-track)" strokeWidth={stroke} />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 50 50)" className="k-ring-arc" />
      </svg>
      <div className="k-ring-center">{children}</div>
    </div>
  );
}

// Alan grafiği: bir ya da iki seri, ortak ölçek (en büyük değer + %15 pay). Izgara 3 yatay çizgi.
export function AreaChart({ series, height = 120, max, grid = true }: {
  series: { values: number[]; color: string }[]; height?: number; max?: number; grid?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const W = 300;
  const H = 100;
  const n = Math.max(0, ...series.map(s => s.values.length));
  const top = max ?? Math.max(1e-9, ...series.flatMap(s => s.values.filter(isFinite))) * 1.15;
  const x = (i: number, len: number) => (len <= 1 ? W : (i / (len - 1)) * W);
  const y = (v: number) => H - (Math.max(0, v) / top) * (H - 4) - 2;
  return (
    <svg className="k-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <defs>
        {series.map((s, k) => (
          <linearGradient key={k} id={`${uid}-g${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={s.color} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {grid && [0.25, 0.5, 0.75].map(f => (
        <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--k-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      {n >= 2 && series.map((s, k) => {
        const v = s.values;
        if (v.length < 2) return null;
        const line = v.map((p, i) => `${i ? 'L' : 'M'}${x(i, v.length).toFixed(2)} ${y(p).toFixed(2)}`).join(' ');
        return (
          <g key={k}>
            <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${uid}-g${k})`} />
            <path d={line} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke"
              strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}

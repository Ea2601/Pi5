import { BRAND } from '../brand';

interface BrandMarkProps {
  size?: number;
  /** Kutu + gradient + kenarlık göster (false → yalnız beyaz sembol) */
  boxed?: boolean;
  className?: string;
}

/**
 * klyrix/gate marka sembolü — beyaz "K" + dört köşe düğümü.
 * Sembol kuralı: sembol her zaman saf beyaz; renk yalnızca arka plan kutusuna uygulanır.
 * Köşe yarıçapı marka kuralı gereği boyutun 0.21875 katı (36px → ~8px).
 */
export function BrandMark({ size = 36, boxed = true, className }: BrandMarkProps) {
  // viewBox 128 tüm SVG'yi size'a ölçeklediği için köşe yarıçapı da otomatik
  // orantılı kalır (36px → 28 × 36/128 ≈ 8px), ayrıca hesaba gerek yok.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="img"
      aria-label={BRAND.name}
      className={className}
      style={{ display: 'block', flexShrink: 0 }}
    >
      {boxed && (
        <defs>
          <linearGradient id="kg-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={BRAND.colors.bgFrom} stopOpacity="0.95" />
            <stop offset="100%" stopColor={BRAND.colors.bgTo} stopOpacity="0.85" />
          </linearGradient>
          <linearGradient id="kg-shine" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {boxed && (
        <>
          <rect x="0" y="0" width="128" height="128" rx="28" fill="url(#kg-bg)" />
          <rect x="0" y="0" width="128" height="64" rx="28" fill="url(#kg-shine)" />
          <rect x="0.5" y="0.5" width="127" height="127" rx="27.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.18" strokeWidth="1" />
        </>
      )}
      <g transform="translate(64,64)">
        <rect x="-27" y="-36" width="11" height="72" rx="2.5" fill="#FFFFFF" />
        <path d="M -8 0 L 19 -27" fill="none" stroke="#FFFFFF" strokeWidth="8" strokeLinecap="round" />
        <path d="M -8 0 L 19 27" fill="none" stroke="#FFFFFF" strokeWidth="8" strokeLinecap="round" />
        <rect x="16" y="-37" width="14" height="14" rx="3" fill="#FFFFFF" />
        <rect x="16" y="23" width="14" height="14" rx="3" fill="#FFFFFF" />
      </g>
    </svg>
  );
}

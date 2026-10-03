// Üst çubuk: panelin logosu (frontend/public/klyrix-gate-icon-512.svg ile aynı çizim) + "Klyrix/Gate" kelime işareti (panel
// gibi iki tonlu) + solda isteğe bağlı geri düğmesi, sağda durum.
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { ChevronLeft } from './icons.ts';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#94A3B8" stop-opacity="0.95"/><stop offset="100%" stop-color="#1E293B" stop-opacity="0.85"/></linearGradient>
<linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.32"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
</defs>
<rect x="0" y="0" width="512" height="512" rx="112" fill="url(#bg)"/>
<rect x="0" y="0" width="512" height="256" rx="112" fill="url(#shine)"/>
<rect x="1" y="1" width="510" height="510" rx="111" fill="none" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="2"/>
<g transform="translate(256,256) scale(4)">
<rect x="-27" y="-36" width="11" height="72" rx="2.5" fill="#FFFFFF"/>
<path d="M -8 0 L 19 -27" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round"/>
<path d="M -8 0 L 19 27" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round"/>
<rect x="16" y="-37" width="14" height="14" rx="3" fill="#FFFFFF"/>
<rect x="16" y="23" width="14" height="14" rx="3" fill="#FFFFFF"/>
</g>
</svg>`;

export const APP_NAME = 'Klyrix/Gate';

export function Logo({ size = 32 }: { size?: number }) {
  return <SvgXml xml={LOGO_SVG} width={size} height={size} />;
}

export function Wordmark({ size = 18 }: { size?: number }) {
  const { p } = useTheme();
  return (
    <Text style={{ fontFamily: FONT.bold, fontSize: size, color: p.text }} accessibilityLabel={APP_NAME}>
      Klyrix<Text style={{ fontFamily: FONT.semibold, color: p.accent }}>/Gate</Text>
    </Text>
  );
}

export function Header({ title, subtitle, right, onBack }: { title?: string; subtitle?: string; right?: ReactNode; onBack?: () => void }) {
  const { p, s } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.border }}>
      {onBack ? (
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Geri" hitSlop={10} style={{ padding: 4, marginLeft: -6 }}>
          <ChevronLeft size={26} color={p.text} />
        </Pressable>
      ) : <Logo size={34} />}
      <View style={{ flex: 1 }}>
        {title ? <Text style={[s.h, { fontSize: 17 }]} numberOfLines={1}>{title}</Text> : <Wordmark />}
        {subtitle ? <Text style={s.small} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

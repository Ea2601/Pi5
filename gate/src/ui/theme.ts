// Panelin teması (frontend/src/index.css :root ve :root.light-theme belirteçleri): aynı renkler, aynı yazı tipi (Inter;
// kodlar JetBrains Mono). Kartlar panelin cam panelinin zemin üstündeki karşılığı (--panel-bg, --bg-color üstünde).
// Düğme rengi = eylem (panel .btn-on / .btn-off): başlatan / onaylayan yeşil, durduran / kaldıran kırmızı, durumu
// değiştirmeyen nötr. Dolu yeşil ve kırmızı, beyaz yazı okunsun diye panel gibi koyulaştırılır (color-mix %65 + siyah).
import { StyleSheet } from 'react-native';

export type Scheme = 'dark' | 'light';
export interface Palette {
  scheme: Scheme;
  bg: string; card: string; border: string; text: string; textSecondary: string; textMuted: string;
  accent: string; accentText: string; input: string;
  success: string; danger: string; warning: string;
  onFill: string; onText: string; onSoft: string;
  offFill: string; offText: string; offSoft: string;
}

export const PALETTES: Record<Scheme, Palette> = {
  dark: {
    scheme: 'dark',
    bg: '#0a0e14', card: '#0f161d', border: 'rgba(255,255,255,0.08)',
    text: '#e2e8f0', textSecondary: '#94a3b8', textMuted: '#64748b',
    accent: '#94a3b8', accentText: '#0f172a', input: 'rgba(0,0,0,0.4)',
    success: '#22c55e', danger: '#ef4444', warning: '#f59e0b',
    onFill: '#16803d', onText: '#5cd08a', onSoft: 'rgba(34,197,94,0.08)',
    offFill: '#9b2c2c', offText: '#ec6d6f', offSoft: 'rgba(239,68,68,0.08)',
  },
  light: {
    scheme: 'light',
    bg: '#eef2f6', card: '#f9fafc', border: 'rgba(15,23,42,0.08)',
    text: '#283548', textSecondary: '#566375', textMuted: '#7b8798',
    accent: '#475569', accentText: '#ffffff', input: 'rgba(15,23,42,0.04)',
    success: '#16a34a', danger: '#dc2626', warning: '#d97706',
    onFill: '#0e6a30', onText: '#1b8249', onSoft: 'rgba(22,163,74,0.08)',
    offFill: '#8f1919', offText: '#af2a2f', offSoft: 'rgba(220,38,38,0.08)',
  },
};

export const FONT = {
  regular: 'Inter_400Regular', medium: 'Inter_500Medium', semibold: 'Inter_600SemiBold', bold: 'Inter_700Bold',
  mono: 'JetBrainsMono_500Medium',
};

export function makeStyles(p: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.bg },
    scroll: { padding: 16, paddingBottom: 32, gap: 12 },
    card: { backgroundColor: p.card, borderColor: p.border, borderWidth: 1, borderRadius: 8, padding: 14, gap: 10 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    h: { color: p.text, fontFamily: FONT.semibold, fontSize: 15 },
    p: { color: p.textSecondary, fontFamily: FONT.regular, fontSize: 14, lineHeight: 20 },
    small: { color: p.textMuted, fontFamily: FONT.regular, fontSize: 12, lineHeight: 17 },
    big: { color: p.text, fontFamily: FONT.bold, fontSize: 26 },
    mono: { color: p.text, fontFamily: FONT.mono, fontSize: 14 },
    err: { color: p.offText, fontFamily: FONT.regular, fontSize: 14, lineHeight: 20 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    // Hizalı iki sütun (etiket | değer): birleşik "ad · değer" metni yerine (panel açılır liste kuralı)
    kvLabel: { color: p.textSecondary, fontFamily: FONT.regular, fontSize: 14, flex: 1 },
    kvValue: { color: p.text, fontFamily: FONT.medium, fontSize: 14, textAlign: 'right' },
    input: { backgroundColor: p.input, borderColor: p.border, borderWidth: 1, borderRadius: 8, color: p.text, fontFamily: FONT.regular, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
    bar: { height: 6, borderRadius: 3, backgroundColor: p.border, overflow: 'hidden' },
    barFill: { height: 6, backgroundColor: p.accent },
  });
}
export type Styles = ReturnType<typeof makeStyles>;

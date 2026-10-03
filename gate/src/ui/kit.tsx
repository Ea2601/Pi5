// Ortak bileşenler — panelin görünümü: kart (cam panel), düğmeler (eyleme göre renk), hizalı değer satırları, anahtar,
// bölümlü seçim, durum çipi, sıralı kurulum adımı.
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Check, Lock } from './icons.ts';
import { FONT } from './theme.ts';
import { useTheme } from './ThemeContext.tsx';

export function Card({ title, icon, children, style }: { title?: string; icon?: ReactNode; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { s } = useTheme();
  return (
    <View style={[s.card, style]}>
      {title ? <View style={s.cardHead}>{icon}<Text style={s.h}>{title}</Text></View> : null}
      {children}
    </View>
  );
}

// primary: panelin ana düğmesi (nötr vurgu). on: başlatan / onaylayan (yeşil). off: durduran / kaldıran (kırmızı çerçeve).
// offFill: geri alınamaz onay (dolu kırmızı). neutral: durumu değiştirmeyen (çerçeve).
export type BtnKind = 'primary' | 'on' | 'off' | 'offFill' | 'neutral';
export function Btn({ label, icon: Icon, kind = 'neutral', onPress, disabled, busy, style }: {
  label: string; icon?: (props: { size: number; color: string }) => ReactNode; kind?: BtnKind;
  onPress?: () => void; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const { p } = useTheme();
  const look: Record<BtnKind, { bg: string; fg: string; border: string }> = {
    primary: { bg: p.accent, fg: p.accentText, border: p.accent },
    on: { bg: p.onFill, fg: '#ffffff', border: p.onFill },
    off: { bg: p.offSoft, fg: p.offText, border: p.danger },
    offFill: { bg: p.offFill, fg: '#ffffff', border: p.offFill },
    neutral: { bg: 'transparent', fg: p.textSecondary, border: p.border },
  };
  const c = look[kind];
  const off = disabled || busy;
  return (
    <Pressable onPress={onPress} disabled={off} accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 46,
        paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, backgroundColor: c.bg, borderColor: c.border,
        opacity: off ? 0.5 : pressed ? 0.85 : 1,
      }, style]}>
      {busy ? <ActivityIndicator size="small" color={c.fg} /> : Icon ? <Icon size={18} color={c.fg} /> : null}
      <Text style={{ color: c.fg, fontFamily: FONT.semibold, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

// Etiket | değer — iki sütun hizalı (birleşik metin yerine)
export function KV({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'ok' | 'bad' }) {
  const { s, p } = useTheme();
  return (
    <View style={s.row}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={[s.kvValue, mono && { fontFamily: FONT.mono }, tone === 'ok' && { color: p.onText }, tone === 'bad' && { color: p.offText }]} selectable>{value}</Text>
    </View>
  );
}

export function ToggleRow({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  const { s, p } = useTheme();
  return (
    <View style={s.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.p, { color: p.text }]}>{label}</Text>
        {hint ? <Text style={s.small}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: p.border, true: p.onFill }} thumbColor={value ? '#ffffff' : p.textMuted} />
    </View>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string; icon?: (props: { size: number; color: string }) => ReactNode }[]; onChange: (v: T) => void;
}) {
  const { p } = useTheme();
  return (
    <View style={{ flexDirection: 'row', borderWidth: 1, borderColor: p.border, borderRadius: 8, padding: 3, gap: 3, backgroundColor: p.input }}>
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="button" accessibilityState={{ selected: on }}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 6, backgroundColor: on ? p.card : 'transparent', borderWidth: on ? 1 : 0, borderColor: p.border }}>
            {o.icon ? <o.icon size={15} color={on ? p.text : p.textMuted} /> : null}
            <Text style={{ color: on ? p.text : p.textMuted, fontFamily: on ? FONT.semibold : FONT.medium, fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ text, tone = 'neutral' }: { text: string; tone?: 'ok' | 'bad' | 'warn' | 'neutral' }) {
  const { p } = useTheme();
  const c = tone === 'ok' ? { fg: p.onText, bg: p.onSoft } : tone === 'bad' ? { fg: p.offText, bg: p.offSoft }
    : tone === 'warn' ? { fg: p.warning, bg: 'rgba(245,158,11,0.10)' } : { fg: p.textSecondary, bg: p.input };
  return (
    <View style={{ paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: c.bg }}>
      <Text style={{ color: c.fg, fontFamily: FONT.semibold, fontSize: 12 }}>{text}</Text>
    </View>
  );
}

// Kurulum adımı (panel sihirbaz kuralı): yalnız sıradaki adım vurgulu; biten sönük + ✓; kilitli soluk + "Önce N. adım"
export function Step({ n, title, state, lockedHint, children }: {
  n: number; title: string; state: 'done' | 'current' | 'locked'; lockedHint?: string; children?: ReactNode;
}) {
  const { s, p } = useTheme();
  const current = state === 'current';
  return (
    <View style={[s.card, current ? { borderColor: p.accent } : { opacity: 0.6 }]}>
      <View style={s.cardHead}>
        <View style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: state === 'done' ? p.onFill : current ? p.accent : p.input }}>
          {state === 'done' ? <Check size={14} color="#ffffff" /> : state === 'locked' ? <Lock size={12} color={p.textMuted} />
            : <Text style={{ color: p.accentText, fontFamily: FONT.bold, fontSize: 13 }}>{n}</Text>}
        </View>
        <Text style={[s.h, { flex: 1 }]}>{title}</Text>
      </View>
      {state === 'locked' ? <Text style={s.small}>{lockedHint || `Önce ${n - 1}. adım`}</Text> : children}
    </View>
  );
}

import { StyleSheet } from 'react-native';

// Klyrix Gate panelinin koyu teması (düşük kromalı arduvaz)
export const C = {
  bg: '#0b1120', card: '#111a2e', border: '#1f2b45', text: '#e2e8f0', muted: '#94a3b8', accent: '#94a3b8',
  primary: '#cbd5e1', primaryText: '#0b1120', ok: '#4ade80', warn: '#fbbf24', bad: '#f87171',
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 16, paddingBottom: 40, gap: 12 },
  title: { color: C.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: C.muted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  h: { color: C.text, fontSize: 16, fontWeight: '600' },
  p: { color: C.muted, fontSize: 14, lineHeight: 20 },
  big: { color: C.text, fontSize: 28, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  btn: { backgroundColor: C.primary, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  btnText: { color: C.primaryText, fontSize: 16, fontWeight: '600' },
  btnOutline: { borderColor: C.border, borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  btnOutlineText: { color: C.text, fontSize: 15, fontWeight: '500' },
  input: { backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 10, color: C.text, fontSize: 16, padding: 12 },
  err: { color: C.bad, fontSize: 14, lineHeight: 20 },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.border, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: C.primary },
});

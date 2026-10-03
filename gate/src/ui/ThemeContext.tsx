// Tema bağlamı: kullanıcının seçimi (Sistem / Koyu / Açık) + telefonun görünümü → panelin paleti ve stilleri.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import type { ThemePref } from '../platform/store.ts';
import { makeStyles, PALETTES, type Palette, type Styles } from './theme.ts';

export interface Theme { p: Palette; s: Styles; pref: ThemePref; setPref: (t: ThemePref) => void }
const Ctx = createContext<Theme | null>(null);

export function ThemeProvider({ pref, setPref, children }: { pref: ThemePref; setPref: (t: ThemePref) => void; children: ReactNode }) {
  const sys = useColorScheme();
  const scheme = pref === 'system' ? (sys === 'light' ? 'light' : 'dark') : pref;
  const value = useMemo(() => ({ p: PALETTES[scheme], s: makeStyles(PALETTES[scheme]), pref, setPref }), [scheme, pref, setPref]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(Ctx);
  if (!t) throw new Error('ThemeProvider eksik');
  return t;
}

import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { Pairing } from './src/core/protocol.ts';
import { loadPairing } from './src/platform/store.ts';
import { HomeScreen } from './src/ui/HomeScreen.tsx';
import { PairScreen } from './src/ui/PairScreen.tsx';
import { C } from './src/ui/theme.ts';

export default function App() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  useEffect(() => { void loadPairing().then(setPairing); }, []);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: 48 }}>
      <StatusBar style="light" />
      {pairing === undefined
        ? <ActivityIndicator style={{ marginTop: 80 }} color={C.text} />
        : pairing
          ? <HomeScreen pairing={pairing} onForget={() => setPairing(null)} />
          : <PairScreen onPaired={setPairing} />}
    </View>
  );
}

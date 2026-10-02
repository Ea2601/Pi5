// expo-camera önizleme sahtesi: kamera yerine düz bir alan
import { createElement } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

export function CameraView(props: { style?: StyleProp<ViewStyle> }) {
  return createElement(View, { style: [{ backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }, props.style] },
    createElement(Text, { style: { color: '#94a3b8' } }, 'Kamera (önizleme)'));
}
export function useCameraPermissions() {
  const p = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' };
  return [p, async () => p] as const;
}

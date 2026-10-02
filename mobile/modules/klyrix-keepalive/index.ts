// Yerel Android modülü (android/): yedekleme turu sürerken ön plan hizmeti + ilerleme bildirimi. iOS ve web'de yok → null.
import { NativeModule, requireOptionalNativeModule } from 'expo';

type KeepAliveEvents = {
  onStopRequest: () => void; // bildirimdeki «Durdur»
  onTimeout: () => void;     // Android 15+: günlük dataSync süresi doldu
};

declare class KlyrixKeepAliveModule extends NativeModule<KeepAliveEvents> {
  start(title: string, text: string): boolean;
  update(title: string, text: string, progress: number, max: number): void;
  stop(): void;
  isRunning(): boolean;
}

export default requireOptionalNativeModule<KlyrixKeepAliveModule>('KlyrixKeepAlive');

// Yerel Android modülü (android/): uygulama içi WireGuard (gate/wg — wireguard-go + netstack; telefonda VPN yok) ve ev
// ağındaki Klyrix cihazlarının keşfi (NSD). iOS ve web'de yok → null (iOS: A5).
import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface FoundDevice { name: string; host: string; port: number; id: string; role: string; app: string }

type WgEvents = {
  onDeviceFound: (d: FoundDevice) => void;
  onDeviceLost: (d: { name: string }) => void;
};

declare class KlyrixWgModule extends NativeModule<WgEvents> {
  generatePrivateKey(): string;
  publicKey(privateKey: string): string;
  start(privateKey: string, address: string, serverPublicKey: string, endpoint: string): Promise<void>;
  setEndpoint(endpoint: string): Promise<void>;
  rehandshake(): Promise<void>;
  probe(timeoutMs: number): Promise<number>;
  lastHandshake(): number;
  running(): boolean;
  stop(): Promise<void>;
  // Panelin ilk adresi: http://127.0.0.1:<port>/?k=<açılışa özel sır>
  proxyStart(): Promise<string>;
  proxyStop(): Promise<void>;
  startDiscovery(): void;
  stopDiscovery(): void;
}

export default requireOptionalNativeModule<KlyrixWgModule>('KlyrixWg');

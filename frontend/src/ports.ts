// Tak-çalıştır ağ kartı algılama (backend portWatch.ts, /api/ports): üstteki bant (PortBanner), Cihaz Rolleri'ndeki liste
// ve sihirbaz (PortWizard) için ortak tipler ve küçük olay yayını. Bant ana pakettedir: bu dosya küçük kalır.
export type PortKind = 'ethernet' | 'usb-modem' | 'wwan' | 'wifi';
export interface PortRow {
  mac: string; name: string; driver: string; kind: PortKind; bus: string; usbSpeedMbps: number | null;
  firstSeen: string; lastSeen: string; state: 'pending' | 'known' | 'dismissed'; present: boolean;
}
export interface PortsResp { supported: boolean; enabled: boolean; ports: PortRow[]; pending: PortRow[] }

export const KIND_TEXT: Record<PortKind, string> = { ethernet: 'Ethernet', 'usb-modem': 'USB modem / telefon', wwan: "SIM'li modem", wifi: 'Wi-Fi' };
export const portBus = (p: { bus: string; usbSpeedMbps: number | null }) =>
  p.bus !== 'usb' ? 'dahili' : p.usbSpeedMbps === null ? 'USB' : p.usbSpeedMbps >= 5000 ? 'USB 3' : 'USB 2';

// Liste değişti (aç / kapat, yoksay, rol akışına gönderildi): bant ve Cihaz Rolleri beklemeden yenilenir.
const CHANGED = 'klx-ports-changed';
export const notifyPortsChanged = () => window.dispatchEvent(new Event(CHANGED));
export function onPortsChanged(cb: () => void): () => void {
  window.addEventListener(CHANGED, cb);
  return () => window.removeEventListener(CHANGED, cb);
}

// Banttan sihirbaza: kart sekme oturumuna yazılır ve Cihaz Rolleri açılır (sayfa açıksa olayla, değilse açılınca okur —
// okuyan taraf PortWizard.tsx'te; ana paket küçük kalsın).
export const WIZARD_KEY = 'klx-port-wizard';
export function openPortWizard(mac: string): void {
  try { sessionStorage.setItem(WIZARD_KEY, mac); } catch { /* depolama yok: sayfa açıksa olay yeter */ }
  window.dispatchEvent(new CustomEvent<string>(WIZARD_KEY, { detail: mac }));
  if (window.location.hash !== '#roles') window.location.hash = 'roles';
}

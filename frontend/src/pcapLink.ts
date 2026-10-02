// Ağ Araçları → Paket Kaydı'na başka sayfadan geçiş (Cihaz Yönetimi satırındaki kısayol, bildirimin "git" düğmesi). Seçim
// sekme oturumuna yazılır, sayfa açılınca bir kez okunur (okuyan taraf NetworkToolsPanel / PcapTool; ana paket küçük kalsın).
export const NETTOOLS_TAB_KEY = 'klx-nettools-tab';
// Ağ Araçları zaten açıkken (sayfa yeniden kurulmaz) sekme değişimi pencere olayıyla: detail = sekme kimliği ('pcap').
export const NETTOOLS_TAB_EVENT = 'klx-nettools-tab';
export const PCAP_TARGET_KEY = 'klx-pcap-target';

export function openPacketCapture(mac?: string): void {
  try {
    sessionStorage.setItem(NETTOOLS_TAB_KEY, 'pcap');
    if (mac) sessionStorage.setItem(PCAP_TARGET_KEY, mac);
  } catch { /* depolama yok: Ağ Araçları ilk sekmesiyle açılır */ }
  window.location.hash = '#nettools';
}

// Tek seferlik okuma: değer ilk çizimde okunur (peekLink), bileşen yerleşince silinir (clearLink, useEffect içinde) — React'in
// yarıda bırakıp yeniden başlattığı bir çizim değeri tüketmesin.
export function peekLink(key: string): string {
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}
export function clearLink(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* depolama yok */ }
}

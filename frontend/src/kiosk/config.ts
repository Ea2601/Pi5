// Kiosk (HDMI ekran) yapılandırması — kiosk sayfası ve paneldeki "HDMI Ekran" ayarları ortak kullanır.
// Backend /api/case/kiosk bu nesneyi olduğu gibi saklar. v2: tek ekranlı gösterge paneli; eski (v1, döngülü sayfalar)
// kayıtların pano seçimleri anlamını yitirdiği için yok sayılır ve varsayılanlar kullanılır.
// 'traffic' kimliği tarihsel: pano artık hız testlerini gösterir (kayıtlı seçim bozulmasın diye kimlik aynı).
export type KioskTileId = 'traffic' | 'system' | 'dns' | 'internet' | 'tunnels' | 'devices' | 'security' | 'alerts';
export type KioskThemeMode = 'panel' | 'dark' | 'light';

export interface KioskTile { id: KioskTileId; label: string; enabled: boolean }
export interface KioskConfig {
  version: 2;
  enabled: boolean;
  theme: KioskThemeMode;
  shift: boolean; // ekran koruma: birkaç dakikada bir tüm görüntüyü 1-2 piksel kaydır (TV / OLED'de iz kalmasın)
  tiles: KioskTile[];
}

export const TILES: KioskTile[] = [
  { id: 'traffic', label: 'İnternet hızı (son hız testi, 7 günlük ölçüm grafiği)', enabled: true },
  { id: 'system', label: 'Sistem (işlemci, sıcaklık, bellek, disk)', enabled: true },
  { id: 'dns', label: 'DNS kalkanı (Pi-hole engelleme, Unbound önbellek, DNSSEC)', enabled: true },
  { id: 'internet', label: 'İnternet (dış IP, ana / yedek hat, DDNS, anlık kullanım)', enabled: true },
  { id: 'tunnels', label: 'Tüneller (VPS bağlantıları, Ev VPN istemcileri)', enabled: true },
  { id: 'devices', label: 'Cihazlar (çevrimiçi sayısı, son görülenler)', enabled: true },
  { id: 'security', label: 'Güvenlik uygulamaları ve durumları (Pi-hole, Unbound, Zapret, Fail2Ban, güvenlik duvarı, VPN)', enabled: true },
  { id: 'alerts', label: 'Bildirim şeridi (son uyarılar, alt satırda)', enabled: true },
];

export const DEFAULT_CONFIG: KioskConfig = { version: 2, enabled: true, theme: 'panel', shift: true, tiles: TILES };

// Kayıtla kod tarafını birleştir: yalnız açık/kapalı seçimi kayıttan gelir; etiket ve sıra koddan (düzen sabittir).
export function normalizeConfig(raw: unknown): KioskConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<KioskConfig> & { version?: number };
  const v2 = c.version === 2;
  const saved = new Map((v2 && Array.isArray(c.tiles) ? c.tiles : []).map(t => [t.id, !!t.enabled]));
  return {
    version: 2,
    enabled: c.enabled !== false,
    theme: v2 && (c.theme === 'dark' || c.theme === 'light') ? c.theme : 'panel',
    shift: v2 ? c.shift !== false : true,
    tiles: TILES.map(t => ({ ...t, enabled: saved.has(t.id) ? saved.get(t.id)! : t.enabled })),
  };
}

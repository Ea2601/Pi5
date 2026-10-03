import type { TunnelInfo } from './vpsTunnel';

export type TabId =
  | 'dashboard' | 'topology' | 'pihole' | 'dhcp' | 'zapret' | 'firewall' | 'routing' | 'vps'
  | 'unbound' | 'fail2ban' | 'maintenance' | 'docs'
  | 'bandwidth' | 'dnslog' | 'visits' | 'speedtest' | 'ddns' | 'alerts' | 'nettools'
  | 'parental' | 'devicecontrol' | 'trafficcontrol' | 'backup' | 'settings' | 'terminal'
  | 'casecontrol' | 'kiosk' | 'roles' | 'storage' | 'agenda' | 'license' | 'templates' | 'fleet' | 'geo' | 'sdwan';

export interface ServiceStatus {
  name: string;
  enabled: number;          // 1 = şu an çalışıyor
  status: string;           // running | stopped | error | restarting | not_installed
  last_check: string;
  unit?: string;
  active_state?: string;
  sub_state?: string;
  boot_enabled?: boolean;   // açılışta başlatılır mı
  restarts?: number;
  detail?: string;
  checked_at?: string;
}

export interface Device {
  mac_address: string;
  ip_address: string;
  hostname: string;
  device_type: string;
  route_profile: string;
  blocked?: number;
  last_seen: string;
}

export interface VpsServer {
  id: number;
  ip: string;
  username: string;
  location: string;
  status: string;
  created_at: string;
  // Pi ↔ VPS tünelinin canlı durumu (el sıkışma yaşı); Pi dışında (geliştirme) null.
  tunnel?: TunnelInfo | null;
  // Uzaktan yönetim: panel erişimi açık istemci sayısı (yalnız tek VPS'te > 0 olabilir).
  panel_access?: number;
  // 'import': hazır WireGuard yapılandırmasıyla kurulan tünel (backend wgImport.ts) — sunucu panelin değil: SSH, istemci (QR)
  // ve VPS denetimi yok. Eski backend alanı göndermez: 'ssh' sayılır.
  kind?: 'ssh' | 'import';
  import_info?: VpsImportInfo | null;
}

// İçe aktarılan tünelin gizli olmayan özeti (backend wgConf.ts importSummary; null = kayıt okunamadı).
export interface VpsImportInfo {
  address: string;       // Pi'nin tünel adresi (/32)
  endpoint: string;      // sunucu adres:port
  allowed_ips: string[]; // tünelin taşıdığı IPv4 aralıkları
  full_tunnel: boolean;  // internet trafiğini taşıyabilir (bölünmüş tünel değil)
  mtu: number | null;
}

export interface TrafficRule {
  id: number;
  app_name: string;
  category: string;
  route_type: string;
  exit_node: string;
  dpi_bypass: number;
  // VPS çıkışında tünel düşerse: engelle (varsayılan) ya da operatörden devam.
  vps_fallback?: 'block' | 'isp';
  domains: string;
  vps_id: number | null;
  vps_ip: string | null;
  vps_location: string | null;
  enabled: number;
}

export interface PiholeStats {
  domainsBlocked: number;
  dnsQueriesToday: number;
  adsBlockedToday: number;
  adsPercentageToday: number;
  uniqueClients: number;
  queriesForwarded: number;
  queriesCached: number;
  topBlockedDomains: { domain: string; count: number }[];
  queryTypes: Record<string, number>;
}

export interface FirewallRule {
  port?: number;
  protocol?: string;
  action: string;
  label: string;
  from?: string;
  to?: string;
  interface?: string;
}

export interface SystemStats {
  cpuTemp: number;
  cpuUsage: number;
  memoryTotal: number;
  memoryUsed: number;
  diskTotal: number;
  diskUsed: number;
  uptime: number;
  loadAvg: number[];
  diskRead?: number;
  diskWrite?: number;
  fanSpeed?: number;
}

export interface HealthStatus {
  isFailOpen: boolean;
  lastCheckTime: string;
  lastCheckResult: string;
  checksTotal: number;
  checksFailed: number;
  uptimePercent: number;
}

// Service config types
export interface ConfigItem {
  key: string;
  value: string;
  label: string;
  description: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options: string;
}

export interface ServiceConfig {
  service: string;
  config: Record<string, ConfigItem[]>;
}

export interface PiholeListItem {
  id: number;
  list_type: 'adlist' | 'whitelist' | 'blacklist' | 'localdns';
  value: string;
  comment: string;
  enabled: number;
}

export interface ZapretDomain {
  id: number;
  list_type: 'hostlist' | 'exclude';
  domain: string;
  enabled: number;
}

export interface CronJob {
  id: number;
  name: string;
  schedule: string;
  command: string;
  description: string;
  enabled: number;
  last_run: string;
  next_run: string;
  status: 'idle' | 'running' | 'success' | 'error';
  schedule_error?: string; // zamanlama geçersiz: zamanlayıcıya yazılmıyor (yalnız bu görev çalışmaz)
}

export interface AlertItem {
  id: number;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  source: string;
  acknowledged: number;
  created_at: string;
}

export interface DhcpLease {
  mac_address: string;
  ip_address: string;
  hostname: string;
  lease_start: string;
  lease_end: string;
  is_static: number;
}

export interface SpeedTestResult {
  id: number;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  // null = ölçülmedi (eski speedtest-cli yolu jitter / paket kaybı ölçmez)
  jitter_ms: number | null;
  packet_loss: number | null;
  server: string;
  isp: string;
  timestamp: string;
  // 1 = akıllı kuyruk açıkken ölçüldü (kısılmış: hattın gerçek hızı değil, ayarlanan bant); eski kayıt / sürümde yok ya da 0
  shaped?: number | null;
  // yük altındaki gecikme (ms; Ookla) — yoksa null
  loaded_ms?: number | null;
}

export interface ParentalRule {
  id: number;
  device_mac_or_group: string;
  rule_type: 'time_restrict' | 'category_block' | 'site_block';
  value: string;
  schedule_start: string;
  schedule_end: string;
  days_of_week: string;
  enabled: number;
}

export interface DeviceGroup {
  id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  members?: Device[];
}

export interface TrafficSchedule {
  id: number;
  traffic_routing_id: number;
  schedule_route_type: string;
  schedule_vps_id: number | null;
  time_start: string;
  time_end: string;
  days_of_week: string;
  enabled: number;
  schedule_exit_node?: string;
  schedule_dpi_bypass?: number;
  active?: boolean;      // pencere şu an açık (routing'de uygulanıyor)
  unsupported?: boolean; // eski "Engelle" penceresi: zamanlayıcı engelleyemez (Ebeveyn Kontrolü)
  app_name?: string;
}

export interface ConnectionEvent {
  id: number;
  device_mac: string;
  event_type: 'connect' | 'disconnect';
  timestamp: string;
}

export interface MetricSnapshot {
  time: string;
  cpuTemp: number;
  cpuUsage: number;
  memoryUsage: number;
  networkIn: number;
  networkOut: number;
  diskRead: number;
  diskWrite: number;
  fanSpeed: number;
}

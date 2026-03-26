export type TabId =
  | 'dashboard' | 'topology' | 'pihole' | 'zapret' | 'firewall' | 'routing' | 'vps'
  | 'unbound' | 'fail2ban' | 'maintenance' | 'docs'
  | 'bandwidth' | 'dnslog' | 'speedtest' | 'ddns' | 'alerts' | 'nettools'
  | 'parental' | 'devicecontrol' | 'trafficcontrol' | 'deviceservices' | 'backup' | 'settings' | 'terminal'
  | 'casecontrol' | 'kiosk';

export interface ServiceStatus {
  name: string;
  enabled: number;
  status: string;
  last_check: string;
}

export interface Device {
  mac_address: string;
  ip_address: string;
  hostname: string;
  device_type: string;
  route_profile: string;
  last_seen: string;
}

export interface VpsServer {
  id: number;
  ip: string;
  username: string;
  location: string;
  status: string;
  created_at: string;
}

export interface TrafficRule {
  id: number;
  app_name: string;
  category: string;
  route_type: string;
  exit_node: string;
  dpi_bypass: number;
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
  jitter_ms: number;
  packet_loss: number;
  server: string;
  isp: string;
  timestamp: string;
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

export interface ThrottleRule {
  id: number;
  target_type: 'device' | 'app' | 'group';
  target_value: string;
  max_download_kbps: number;
  max_upload_kbps: number;
  enabled: number;
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

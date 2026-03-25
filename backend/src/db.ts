import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = path.resolve(__dirname, '../../core/pi5router.sqlite');

export const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the pi5router SQLite database.');
  }
});

export function dbAll(sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export function dbRun(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function dbGet(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export const initDb = () => {
  db.serialize(() => {

    // ═══════════════════ CORE TABLES ═══════════════════

    db.run(`CREATE TABLE IF NOT EXISTS vps_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL, username TEXT NOT NULL, password TEXT DEFAULT '',
      location TEXT DEFAULT '', status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, enabled INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS traffic_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'voip',
      route_type TEXT DEFAULT 'direct', vps_id INTEGER, enabled INTEGER DEFAULT 1,
      FOREIGN KEY(vps_id) REFERENCES vps_servers(id)
    )`);

    // Default app routing rules (real app list — not mock data)
    const trafficRules: [number, string, string, string][] = [
      [1, 'WhatsApp', 'voip', 'direct'],
      [2, 'Telegram', 'voip', 'direct'],
      [3, 'Discord', 'voip', 'direct'],
      [4, 'Signal', 'voip', 'direct'],
      [5, 'YouTube', 'streaming', 'direct'],
      [6, 'Netflix', 'streaming', 'direct'],
      [7, 'Twitch', 'streaming', 'direct'],
      [8, 'Instagram', 'social', 'direct'],
      [9, 'Twitter/X', 'social', 'direct'],
      [10, 'TikTok', 'social', 'direct'],
      [11, 'Steam', 'gaming', 'direct'],
      [12, 'Epic Games', 'gaming', 'direct'],
      [13, 'Spotify', 'streaming', 'direct'],
      [14, 'Google', 'web', 'direct'],
      [15, 'GitHub', 'web', 'direct'],
    ];
    trafficRules.forEach(([id, app, cat, route]) => {
      db.run(`INSERT OR IGNORE INTO traffic_routing (id, app_name, category, route_type) VALUES (?, ?, ?, ?)`, [id, app, cat, route]);
    });

    db.run(`CREATE TABLE IF NOT EXISTS devices (
      mac_address TEXT PRIMARY KEY, ip_address TEXT, hostname TEXT,
      device_type TEXT DEFAULT 'unknown', route_profile TEXT DEFAULT 'default',
      blocked INTEGER DEFAULT 0, last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS service_status (
      name TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, status TEXT DEFAULT 'stopped',
      last_check DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Seed services (these are real service names — not fake data)
    const services = ['pihole', 'zapret', 'nftables', 'wireguard', 'unbound', 'fail2ban'];
    services.forEach(s => {
      db.run(`INSERT OR IGNORE INTO service_status (name, enabled, status) VALUES (?, 0, 'stopped')`, [s]);
    });

    // ═══════════════════ CONFIG TABLES ═══════════════════
    // These contain real configurable settings, not mock data

    db.run(`CREATE TABLE IF NOT EXISTS service_config (
      service TEXT NOT NULL, category TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT DEFAULT '', label TEXT DEFAULT '', description TEXT DEFAULT '',
      type TEXT DEFAULT 'text', options TEXT DEFAULT '',
      PRIMARY KEY (service, key)
    )`);

    // Pi-hole config
    const piholeConfigs: [string, string, string, string, string, string, string][] = [
      ['pihole', 'dns', 'upstream_dns_1', '127.0.0.1#5335', 'Birincil DNS', 'Unbound recursive resolver', 'text'],
      ['pihole', 'dns', 'upstream_dns_2', '1.1.1.1', 'Ikincil DNS', 'Cloudflare yedek DNS', 'text'],
      ['pihole', 'dns', 'dnssec', 'true', 'DNSSEC', 'DNS guvenlik dogrulamasi', 'boolean'],
      ['pihole', 'dns', 'cache_size', '10000', 'Onbellek Boyutu', 'DNS onbellek kayit sayisi', 'number'],
      ['pihole', 'blocking', 'blocking_enabled', 'true', 'Engelleme Aktif', 'DNS reklam engelleme durumu', 'boolean'],
      ['pihole', 'dhcp', 'dhcp_active', 'false', 'DHCP Sunucu', 'Pi-hole DHCP sunucu', 'boolean'],
      ['pihole', 'dhcp', 'dhcp_start', '192.168.1.100', 'Baslangic IP', 'DHCP IP araligi baslangici', 'text'],
      ['pihole', 'dhcp', 'dhcp_end', '192.168.1.250', 'Bitis IP', 'DHCP IP araligi sonu', 'text'],
      ['pihole', 'dhcp', 'dhcp_router', '192.168.1.1', 'Gateway', 'Varsayilan ag gecidi', 'text'],
      ['pihole', 'privacy', 'query_logging', 'true', 'Sorgu Kayitlari', 'DNS sorgu loglamasi', 'boolean'],
      ['pihole', 'privacy', 'privacy_level', '0', 'Gizlilik Seviyesi', '0=Her sey, 3=Anonim', 'select'],
      ['pihole', 'ratelimit', 'rate_limit_count', '1000', 'Limit (sorgu/dk)', 'Dakikadaki maks sorgu', 'number'],
    ];
    piholeConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [svc, cat, key, val, label, desc, type]);
    });

    // Zapret config
    const zapretConfigs: [string, string, string, string, string, string, string][] = [
      ['zapret', 'general', 'mode', 'nfqws', 'Bypass Modu', 'DPI atlatma yontemi', 'select'],
      ['zapret', 'general', 'qnum', '200', 'Queue Numarasi', 'NFQWS kuyruk numarasi', 'number'],
      ['zapret', 'nfqws', 'desync_mode', 'fake,split2', 'Desync Modu', 'Paket manipulasyon stratejisi', 'text'],
      ['zapret', 'nfqws', 'desync_ttl', '6', 'TTL Degeri', 'Sahte paket TTL', 'number'],
      ['zapret', 'nfqws', 'desync_fooling', 'md5sig,badseq', 'Fooling Yontemi', 'DPI kandirma parametreleri', 'text'],
      ['zapret', 'nfqws', 'hostcase', 'true', 'Host Case Mixing', 'Host header harf karistirma', 'boolean'],
    ];
    zapretConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [svc, cat, key, val, label, desc, type]);
    });

    // Unbound config
    const unboundConfigs: [string, string, string, string, string, string, string][] = [
      ['unbound', 'server', 'port', '5335', 'Port', 'Dinleme portu', 'number'],
      ['unbound', 'server', 'interface', '127.0.0.1', 'Arayuz', 'Dinleme adresi', 'text'],
      ['unbound', 'performance', 'num_threads', '2', 'Thread Sayisi', 'Islemci thread sayisi', 'number'],
      ['unbound', 'performance', 'cache_min_ttl', '3600', 'Min TTL (sn)', 'Minimum cache TTL', 'number'],
      ['unbound', 'performance', 'prefetch', 'true', 'Prefetch', 'Suresi dolan kayitlari onceden yenile', 'boolean'],
      ['unbound', 'security', 'hide_identity', 'true', 'Kimlik Gizle', 'Sunucu kimligini gizle', 'boolean'],
      ['unbound', 'security', 'harden_dnssec_stripped', 'true', 'DNSSEC Koruma', 'DNSSEC cikarma saldirilarina karsi', 'boolean'],
    ];
    unboundConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [svc, cat, key, val, label, desc, type]);
    });

    // WireGuard config
    const wgConfigs: [string, string, string, string, string, string, string][] = [
      ['wireguard', 'interface', 'address', '10.66.66.1/24', 'Arayuz Adresi', 'WireGuard arayuz IP/subnet', 'text'],
      ['wireguard', 'interface', 'listen_port', '51820', 'Dinleme Portu', 'WireGuard UDP port', 'number'],
      ['wireguard', 'interface', 'mtu', '1420', 'MTU', 'Maximum Transmission Unit', 'number'],
      ['wireguard', 'peer_defaults', 'persistent_keepalive', '25', 'Keepalive (sn)', 'NAT arkasi canli tutma', 'number'],
    ];
    wgConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [svc, cat, key, val, label, desc, type]);
    });

    // Fail2ban config
    const f2bConfigs: [string, string, string, string, string, string, string][] = [
      ['fail2ban', 'default', 'bantime', '3600', 'Ban Suresi (sn)', 'IP engelleme suresi', 'number'],
      ['fail2ban', 'default', 'findtime', '600', 'Bulma Suresi (sn)', 'Hata sayma penceresi', 'number'],
      ['fail2ban', 'default', 'maxretry', '5', 'Maks Deneme', 'Ban oncesi deneme sayisi', 'number'],
      ['fail2ban', 'default', 'ignoreip', '127.0.0.1/8 192.168.1.0/24', 'Muaf IPler', 'Ban uygulanmayacak IP listesi', 'text'],
      ['fail2ban', 'sshd', 'sshd_enabled', 'true', 'SSH Korumasi', 'SSH brute-force korumasi', 'boolean'],
      ['fail2ban', 'sshd', 'sshd_maxretry', '3', 'SSH Maks Deneme', 'SSH ban oncesi deneme', 'number'],
    ];
    f2bConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [svc, cat, key, val, label, desc, type]);
    });

    // nftables config
    const nftConfigs: [string, string, string, string, string, string, string][] = [
      ['nftables', 'policy', 'input_policy', 'drop', 'Input Politikasi', 'Gelen trafik varsayilan politikasi', 'select'],
      ['nftables', 'policy', 'forward_policy', 'drop', 'Forward Politikasi', 'Yonlendirme varsayilan politikasi', 'select'],
      ['nftables', 'nat', 'masquerade_iface', 'wlan0', 'NAT Arayuzu', 'Masquerade cikis arayuzu', 'text'],
      ['nftables', 'nat', 'nat_enabled', 'true', 'NAT Aktif', 'Network Address Translation', 'boolean'],
      ['nftables', 'forwarding', 'lan_iface', 'eth0', 'LAN Arayuzu', 'Yerel ag arayuzu', 'text'],
      ['nftables', 'forwarding', 'wan_iface', 'wlan0', 'WAN Arayuzu', 'Internet cikis arayuzu', 'text'],
    ];
    nftConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [svc, cat, key, val, label, desc, type]);
    });

    // ═══════════════════ LIST TABLES (empty — user fills) ═══════════════════

    db.run(`CREATE TABLE IF NOT EXISTS pihole_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL, value TEXT NOT NULL, comment TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      UNIQUE(list_type, value)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS zapret_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_type TEXT NOT NULL DEFAULT 'hostlist', domain TEXT NOT NULL, enabled INTEGER DEFAULT 1,
      UNIQUE(list_type, domain)
    )`);

    // ═══════════════════ CRON JOBS ═══════════════════

    db.run(`CREATE TABLE IF NOT EXISTS cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, schedule TEXT NOT NULL, command TEXT NOT NULL,
      description TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      last_run TEXT DEFAULT '', next_run TEXT DEFAULT '', status TEXT DEFAULT 'idle'
    )`);

    // Real cron jobs (these are actual maintenance tasks)
    const cronJobs: [string, string, string, string][] = [
      ['OS Guncelleme', '0 3 * * *', 'apt update -qq && apt upgrade -y -qq', 'Gunluk sistem paket guncellemesi'],
      ['Pi-hole Gravity', '0 4 * * *', 'pihole -g', 'Reklam engelleme listelerini guncelle'],
      ['Log Temizligi', '0 2 * * 1', 'journalctl --vacuum-time=7d', 'Eski loglari temizle'],
      ['DNS Saglik Kontrolu', '*/10 * * * *', 'dig @127.0.0.1 -p 5335 google.com +short', 'DNS resolver kontrolu'],
    ];
    cronJobs.forEach(([name, schedule, command, desc]) => {
      db.run(`INSERT OR IGNORE INTO cron_jobs (name, schedule, command, description) VALUES (?, ?, ?, ?)`,
        [name, schedule, command, desc]);
    });

    // ═══════════════════ FEATURE TABLES (empty — real data from system) ═══════════════════

    db.run(`CREATE TABLE IF NOT EXISTS ddns_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL, hostname TEXT NOT NULL,
      username TEXT DEFAULT '', password TEXT DEFAULT '', token TEXT DEFAULT '', domain TEXT DEFAULT '',
      update_interval_min INTEGER DEFAULT 5, enabled INTEGER DEFAULT 1,
      last_update TEXT DEFAULT '', last_ip TEXT DEFAULT '', status TEXT DEFAULT 'idle',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ddns_ip_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL, detected_at DATETIME DEFAULT CURRENT_TIMESTAMP, source TEXT DEFAULT 'auto'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bandwidth_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_mac TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      bytes_in INTEGER DEFAULT 0, bytes_out INTEGER DEFAULT 0, interval_sec INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bandwidth_limits (
      device_mac TEXT PRIMARY KEY, daily_limit_mb INTEGER DEFAULT 0,
      monthly_limit_mb INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS speed_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      download_mbps REAL, upload_mbps REAL, ping_ms REAL, server TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL, source TEXT DEFAULT '',
      acknowledged INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS dhcp_leases (
      mac_address TEXT PRIMARY KEY, ip_address TEXT, hostname TEXT,
      lease_start TEXT, lease_end TEXT, is_static INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS parental_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_mac_or_group TEXT, rule_type TEXT, value TEXT,
      schedule_start TEXT DEFAULT '', schedule_end TEXT DEFAULT '',
      days_of_week TEXT DEFAULT '', enabled INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS traffic_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      traffic_routing_id INTEGER, schedule_route_type TEXT, schedule_vps_id INTEGER,
      time_start TEXT, time_end TEXT, days_of_week TEXT, enabled INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS device_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT DEFAULT '#3B82F6', icon TEXT DEFAULT ''
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS device_group_members (
      group_id INTEGER, device_mac TEXT,
      PRIMARY KEY(group_id, device_mac)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS connection_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_mac TEXT, event_type TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS known_devices (
      mac_address TEXT PRIMARY KEY, first_seen DATETIME DEFAULT CURRENT_TIMESTAMP, approved INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS throttle_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT, target_value TEXT,
      max_download_kbps INTEGER DEFAULT 0, max_upload_kbps INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY, value TEXT DEFAULT ''
    )`);

    // Default app settings
    const defaultSettings: [string, string][] = [
      ['theme', 'dark'], ['language', 'tr'], ['notification_sound', 'true'],
      ['auto_refresh', 'true'], ['refresh_interval', '5000'],
    ];
    defaultSettings.forEach(([k, v]) => {
      db.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`, [k, v]);
    });

    db.run(`CREATE TABLE IF NOT EXISTS device_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_mac TEXT NOT NULL, service_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1, config_json TEXT DEFAULT '{}',
      UNIQUE(device_mac, service_name)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS wg_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vps_id INTEGER NOT NULL, name TEXT NOT NULL, ip TEXT NOT NULL,
      public_key TEXT NOT NULL, config TEXT NOT NULL, qr_data TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(vps_id) REFERENCES vps_servers(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS device_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_mac TEXT NOT NULL, app_name TEXT NOT NULL,
      route_type TEXT DEFAULT 'direct', vps_id INTEGER, tunnel_name TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1
    )`);

    // Legacy compat
    db.run(`CREATE TABLE IF NOT EXISTS voip_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL, route_type TEXT DEFAULT 'vps', vps_id INTEGER
    )`);

  });
};

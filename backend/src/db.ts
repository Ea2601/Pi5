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
    db.run(`
      CREATE TABLE IF NOT EXISTS vps_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT DEFAULT '',
        location TEXT DEFAULT '',
        status TEXT DEFAULT 'disconnected',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        target TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER DEFAULT 1
      )
    `);

    // Generalized traffic routing (replaces voip_routing)
    db.run(`
      CREATE TABLE IF NOT EXISTS traffic_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'voip',
        route_type TEXT DEFAULT 'direct',
        vps_id INTEGER,
        enabled INTEGER DEFAULT 1,
        FOREIGN KEY(vps_id) REFERENCES vps_servers(id)
      )
    `);

    // Keep legacy table for migration compatibility
    db.run(`
      CREATE TABLE IF NOT EXISTS voip_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL,
        route_type TEXT DEFAULT 'vps',
        vps_id INTEGER,
        FOREIGN KEY(vps_id) REFERENCES vps_servers(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        mac_address TEXT PRIMARY KEY,
        ip_address TEXT,
        hostname TEXT,
        device_type TEXT DEFAULT 'unknown',
        route_profile TEXT DEFAULT 'default',
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS service_status (
        name TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        status TEXT DEFAULT 'stopped',
        last_check DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Service configuration store
    db.run(`
      CREATE TABLE IF NOT EXISTS service_config (
        service TEXT NOT NULL,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT DEFAULT '',
        label TEXT DEFAULT '',
        description TEXT DEFAULT '',
        type TEXT DEFAULT 'text',
        options TEXT DEFAULT '',
        PRIMARY KEY (service, key)
      )
    `);

    // Seed services
    const services = ['pihole', 'zapret', 'nftables', 'wireguard', 'unbound', 'fail2ban'];
    services.forEach(s => {
      db.run(`INSERT OR IGNORE INTO service_status (name, enabled, status) VALUES (?, 0, 'stopped')`, [s]);
    });

    // Seed Pi-hole config
    const piholeConfigs: [string, string, string, string, string, string, string][] = [
      // DNS Settings
      ['pihole', 'dns', 'upstream_dns_1', '127.0.0.1#5335', 'Birincil DNS', 'Unbound recursive resolver', 'text'],
      ['pihole', 'dns', 'upstream_dns_2', '1.1.1.1', 'İkincil DNS', 'Cloudflare yedek DNS', 'text'],
      ['pihole', 'dns', 'dnssec', 'true', 'DNSSEC', 'DNS güvenlik doğrulaması', 'boolean'],
      ['pihole', 'dns', 'conditional_forwarding', 'false', 'Koşullu Yönlendirme', 'Yerel ağ reverse DNS', 'boolean'],
      ['pihole', 'dns', 'conditional_forwarding_ip', '192.168.1.1', 'Yönlendirme IP', 'Yerel DNS sunucu IP', 'text'],
      ['pihole', 'dns', 'conditional_forwarding_domain', 'lan', 'Yerel Domain', 'Yerel ağ domain adı', 'text'],
      ['pihole', 'dns', 'cache_size', '10000', 'Önbellek Boyutu', 'DNS önbellek kayıt sayısı', 'number'],
      // Blocking
      ['pihole', 'blocking', 'blocking_enabled', 'true', 'Engelleme Aktif', 'DNS reklam engelleme durumu', 'boolean'],
      ['pihole', 'blocking', 'blockingmode', 'NULL', 'Engelleme Modu', 'Engellenen domainlere verilen yanıt tipi', 'select'],
      // DHCP
      ['pihole', 'dhcp', 'dhcp_active', 'false', 'DHCP Sunucu', 'Pi-hole DHCP sunucu aktifliği', 'boolean'],
      ['pihole', 'dhcp', 'dhcp_start', '192.168.1.100', 'Başlangıç IP', 'DHCP IP aralığı başlangıcı', 'text'],
      ['pihole', 'dhcp', 'dhcp_end', '192.168.1.250', 'Bitiş IP', 'DHCP IP aralığı sonu', 'text'],
      ['pihole', 'dhcp', 'dhcp_router', '192.168.1.1', 'Gateway', 'Varsayılan ağ geçidi', 'text'],
      ['pihole', 'dhcp', 'dhcp_leasetime', '24', 'Kira Süresi (saat)', 'DHCP lease süresi', 'number'],
      ['pihole', 'dhcp', 'dhcp_ipv6', 'false', 'IPv6 DHCP', 'SLAAC + RA desteği', 'boolean'],
      // Privacy & Logging
      ['pihole', 'privacy', 'query_logging', 'true', 'Sorgu Kayıtları', 'DNS sorgu loglaması', 'boolean'],
      ['pihole', 'privacy', 'privacy_level', '0', 'Gizlilik Seviyesi', '0=Her şey, 1=Domain gizle, 2=Domain+Client gizle, 3=Anonim', 'select'],
      ['pihole', 'privacy', 'log_retention', '30', 'Log Saklama (gün)', 'Kayıtların saklanma süresi', 'number'],
      // Rate Limiting
      ['pihole', 'ratelimit', 'rate_limit_count', '1000', 'Limit (sorgu/dk)', 'Dakikadaki maksimum sorgu sayısı', 'number'],
      ['pihole', 'ratelimit', 'rate_limit_interval', '60', 'Aralık (saniye)', 'Rate limit periyodu', 'number'],
    ];
    piholeConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config (service, category, key, value, label, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc, cat, key, val, label, desc, type]);
    });

    // Seed Pi-hole lists (blocklists, whitelist, blacklist, local DNS)
    db.run(`
      CREATE TABLE IF NOT EXISTS pihole_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_type TEXT NOT NULL,
        value TEXT NOT NULL,
        comment TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        UNIQUE(list_type, value)
      )
    `);

    const piholeLists: [string, string, string, number][] = [
      ['adlist', 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', 'StevenBlack Unified', 1],
      ['adlist', 'https://adaway.org/hosts.txt', 'AdAway Default', 1],
      ['adlist', 'https://v.firebog.net/hosts/Easyprivacy.txt', 'EasyPrivacy', 1],
      ['adlist', 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Alternate%20versions%20Anti-Malware%20List/AntiMalwareHosts.txt', 'Anti-Malware', 1],
      ['adlist', 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext', 'Peter Lowe Ad Servers', 1],
      ['whitelist', 's.youtube.com', 'YouTube tracking izni', 1],
      ['whitelist', 'www.googleadservices.com', 'Google Ads tıklama izleme', 1],
      ['whitelist', 'clients4.google.com', 'Google Chrome güncelleme', 1],
      ['blacklist', 'telemetry.microsoft.com', 'Windows telemetri engelle', 1],
      ['blacklist', 'data.microsoft.com', 'Microsoft veri toplama', 1],
      ['localdns', '192.168.1.1 router.lan', 'Router', 1],
      ['localdns', '192.168.1.5 pihole.lan', 'Pi-hole', 1],
      ['localdns', '192.168.1.10 nas.lan', 'NAS Sunucu', 1],
    ];
    piholeLists.forEach(([type, val, comment, enabled]) => {
      db.run(`INSERT OR IGNORE INTO pihole_lists (list_type, value, comment, enabled) VALUES (?, ?, ?, ?)`,
        [type, val, comment, enabled]);
    });

    // Seed Zapret config
    const zapretConfigs: [string, string, string, string, string, string, string][] = [
      ['zapret', 'general', 'mode', 'nfqws', 'Bypass Modu', 'DPI atlatma yöntemi', 'select'],
      ['zapret', 'general', 'qnum', '200', 'Queue Numarası', 'NFQWS kuyruk numarası', 'number'],
      ['zapret', 'general', 'bind_iface', 'eth0', 'Ağ Arayüzü', 'Dinlenecek arayüz', 'text'],
      ['zapret', 'nfqws', 'desync_mode', 'fake,split2', 'Desync Modu', 'Paket manipülasyon stratejisi', 'text'],
      ['zapret', 'nfqws', 'desync_ttl', '6', 'TTL Değeri', 'Sahte paket TTL', 'number'],
      ['zapret', 'nfqws', 'desync_fooling', 'md5sig,badseq', 'Fooling Yöntemi', 'DPI kandırma parametreleri', 'text'],
      ['zapret', 'nfqws', 'split_pos', '2', 'Split Pozisyonu', 'Paket bölme konumu', 'number'],
      ['zapret', 'nfqws', 'hostcase', 'true', 'Host Case Mixing', 'Host header büyük/küçük harf karıştırma', 'boolean'],
      ['zapret', 'nfqws', 'hostnospace', 'true', 'Host No Space', 'Host: header boşluk kaldırma', 'boolean'],
      ['zapret', 'nfqws', 'domcase', 'true', 'Domain Case Mixing', 'Domain adı case mixing', 'boolean'],
      ['zapret', 'tproxy', 'tproxy_port', '12345', 'TPROXY Port', 'Transparent proxy portu', 'number'],
      ['zapret', 'autohostlist', 'autohostlist_enabled', 'true', 'Otomatik Liste', 'Otomatik engelli domain algılama', 'boolean'],
      ['zapret', 'autohostlist', 'autohostlist_fail_threshold', '3', 'Hata Eşiği', 'Otomatik listeye ekleme için hata sayısı', 'number'],
      ['zapret', 'autohostlist', 'autohostlist_fail_time', '60', 'Hata Süresi (sn)', 'Hata sayma periyodu', 'number'],
    ];
    zapretConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config (service, category, key, value, label, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc, cat, key, val, label, desc, type]);
    });

    // Seed Zapret domain lists
    db.run(`
      CREATE TABLE IF NOT EXISTS zapret_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_type TEXT NOT NULL DEFAULT 'hostlist',
        domain TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        UNIQUE(list_type, domain)
      )
    `);

    const zapretDomains: [string, string, number][] = [
      ['hostlist', 'discord.com', 1], ['hostlist', 'youtube.com', 1],
      ['hostlist', 'instagram.com', 1], ['hostlist', 'twitter.com', 1],
      ['hostlist', 'reddit.com', 1], ['hostlist', 'medium.com', 1],
      ['exclude', 'google.com', 1], ['exclude', 'microsoft.com', 1],
    ];
    zapretDomains.forEach(([type, domain, enabled]) => {
      db.run(`INSERT OR IGNORE INTO zapret_domains (list_type, domain, enabled) VALUES (?, ?, ?)`,
        [type, domain, enabled]);
    });

    // Seed Unbound config
    const unboundConfigs: [string, string, string, string, string, string, string][] = [
      ['unbound', 'server', 'port', '5335', 'Port', 'Dinleme portu', 'number'],
      ['unbound', 'server', 'interface', '127.0.0.1', 'Arayüz', 'Dinleme adresi', 'text'],
      ['unbound', 'server', 'do_ip4', 'true', 'IPv4', 'IPv4 desteği', 'boolean'],
      ['unbound', 'server', 'do_ip6', 'false', 'IPv6', 'IPv6 desteği', 'boolean'],
      ['unbound', 'server', 'do_udp', 'true', 'UDP', 'UDP sorgu desteği', 'boolean'],
      ['unbound', 'server', 'do_tcp', 'true', 'TCP', 'TCP sorgu desteği', 'boolean'],
      ['unbound', 'performance', 'num_threads', '2', 'Thread Sayısı', 'İşlemci thread sayısı', 'number'],
      ['unbound', 'performance', 'msg_cache_size', '50m', 'Mesaj Önbelleği', 'DNS mesaj cache boyutu', 'text'],
      ['unbound', 'performance', 'rrset_cache_size', '100m', 'RRset Önbelleği', 'RRset cache boyutu', 'text'],
      ['unbound', 'performance', 'cache_min_ttl', '3600', 'Min TTL (sn)', 'Minimum cache TTL', 'number'],
      ['unbound', 'performance', 'cache_max_ttl', '86400', 'Max TTL (sn)', 'Maksimum cache TTL', 'number'],
      ['unbound', 'performance', 'prefetch', 'true', 'Prefetch', 'Süresi dolan kayıtları önceden yenile', 'boolean'],
      ['unbound', 'security', 'hide_identity', 'true', 'Kimlik Gizle', 'Sunucu kimlik bilgisini gizle', 'boolean'],
      ['unbound', 'security', 'hide_version', 'true', 'Sürüm Gizle', 'Unbound sürümünü gizle', 'boolean'],
      ['unbound', 'security', 'harden_glue', 'true', 'Glue Sıkılaştırma', 'Glue kayıtlarını doğrula', 'boolean'],
      ['unbound', 'security', 'harden_dnssec_stripped', 'true', 'DNSSEC Koruma', 'DNSSEC çıkarma saldırılarını engelle', 'boolean'],
      ['unbound', 'security', 'use_caps_for_id', 'true', 'Caps-for-ID', '0x20 kodlama ile DNS spoofing koruması', 'boolean'],
      ['unbound', 'security', 'unwanted_reply_threshold', '10000', 'İstenmeyen Yanıt Eşiği', 'Şüpheli yanıt eşiği', 'number'],
      ['unbound', 'security', 'val_clean_additional', 'true', 'Ek Kayıt Temizleme', 'Güvenilmeyen ek kayıtları temizle', 'boolean'],
    ];
    unboundConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config (service, category, key, value, label, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc, cat, key, val, label, desc, type]);
    });

    // Seed WireGuard config
    const wgConfigs: [string, string, string, string, string, string, string][] = [
      ['wireguard', 'interface', 'address', '10.66.66.1/24', 'Arayüz Adresi', 'WireGuard arayüz IP/subnet', 'text'],
      ['wireguard', 'interface', 'listen_port', '51820', 'Dinleme Portu', 'WireGuard UDP port', 'number'],
      ['wireguard', 'interface', 'dns', '127.0.0.1', 'DNS Sunucu', 'Tünel içi DNS', 'text'],
      ['wireguard', 'interface', 'mtu', '1420', 'MTU', 'Maximum Transmission Unit', 'number'],
      ['wireguard', 'interface', 'post_up', 'iptables -A FORWARD -i wg0 -j ACCEPT', 'Post-Up Komutu', 'Tünel açıldıktan sonra çalıştırılacak komut', 'text'],
      ['wireguard', 'interface', 'post_down', 'iptables -D FORWARD -i wg0 -j ACCEPT', 'Post-Down Komutu', 'Tünel kapandıktan sonra çalıştırılacak komut', 'text'],
      ['wireguard', 'peer_defaults', 'persistent_keepalive', '25', 'Keepalive (sn)', 'NAT arkası bağlantı canlı tutma', 'number'],
      ['wireguard', 'peer_defaults', 'allowed_ips', '0.0.0.0/0', 'İzin Verilen IP', 'Tünelden geçirilecek trafik', 'text'],
    ];
    wgConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config (service, category, key, value, label, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc, cat, key, val, label, desc, type]);
    });

    // Seed Fail2ban config
    const f2bConfigs: [string, string, string, string, string, string, string][] = [
      ['fail2ban', 'default', 'bantime', '3600', 'Ban Süresi (sn)', 'IP engelleme süresi', 'number'],
      ['fail2ban', 'default', 'findtime', '600', 'Bulma Süresi (sn)', 'Hata sayma penceresi', 'number'],
      ['fail2ban', 'default', 'maxretry', '5', 'Maks Deneme', 'Ban öncesi izin verilen deneme', 'number'],
      ['fail2ban', 'default', 'ignoreip', '127.0.0.1/8 192.168.1.0/24', 'Muaf IP\'ler', 'Ban uygulanmayacak IP/subnet listesi', 'text'],
      ['fail2ban', 'default', 'backend', 'systemd', 'Backend', 'Log okuma yöntemi', 'select'],
      ['fail2ban', 'sshd', 'sshd_enabled', 'true', 'SSH Koruması', 'SSH brute-force koruması', 'boolean'],
      ['fail2ban', 'sshd', 'sshd_port', '22', 'SSH Port', 'SSH servis portu', 'number'],
      ['fail2ban', 'sshd', 'sshd_maxretry', '3', 'SSH Maks Deneme', 'SSH ban öncesi deneme sayısı', 'number'],
      ['fail2ban', 'sshd', 'sshd_bantime', '86400', 'SSH Ban Süresi (sn)', 'SSH ban süresi (24 saat)', 'number'],
      ['fail2ban', 'webserver', 'nginx_enabled', 'false', 'Nginx Koruması', 'Nginx HTTP auth koruması', 'boolean'],
      ['fail2ban', 'webserver', 'nginx_maxretry', '5', 'Nginx Maks Deneme', 'HTTP auth deneme limiti', 'number'],
      ['fail2ban', 'recidive', 'recidive_enabled', 'true', 'Tekrar Cezası', 'Tekrar ban alan IP için uzun süreli ban', 'boolean'],
      ['fail2ban', 'recidive', 'recidive_bantime', '604800', 'Tekrar Ban Süresi (sn)', '1 hafta ban', 'number'],
      ['fail2ban', 'recidive', 'recidive_findtime', '86400', 'Tekrar Bulma Süresi', '24 saat içinde tekrar eden banlar', 'number'],
    ];
    f2bConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config (service, category, key, value, label, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc, cat, key, val, label, desc, type]);
    });

    // Seed nftables config
    const nftConfigs: [string, string, string, string, string, string, string][] = [
      ['nftables', 'policy', 'input_policy', 'drop', 'Input Politikası', 'Gelen trafik varsayılan politikası', 'select'],
      ['nftables', 'policy', 'forward_policy', 'drop', 'Forward Politikası', 'Yönlendirme varsayılan politikası', 'select'],
      ['nftables', 'policy', 'output_policy', 'accept', 'Output Politikası', 'Giden trafik varsayılan politikası', 'select'],
      ['nftables', 'nat', 'masquerade_iface', 'wlan0', 'NAT Arayüzü', 'Masquerade yapılacak çıkış arayüzü', 'text'],
      ['nftables', 'nat', 'nat_enabled', 'true', 'NAT Aktif', 'Network Address Translation', 'boolean'],
      ['nftables', 'forwarding', 'ip_forward', 'true', 'IP Forwarding', 'Kernel IP yönlendirme', 'boolean'],
      ['nftables', 'forwarding', 'lan_iface', 'eth0', 'LAN Arayüzü', 'Yerel ağ arayüzü', 'text'],
      ['nftables', 'forwarding', 'wan_iface', 'wlan0', 'WAN Arayüzü', 'İnternet çıkış arayüzü', 'text'],
      ['nftables', 'forwarding', 'wg_iface', 'wg0', 'WireGuard Arayüzü', 'VPN tünel arayüzü', 'text'],
    ];
    nftConfigs.forEach(([svc, cat, key, val, label, desc, type]) => {
      db.run(`INSERT OR IGNORE INTO service_config (service, category, key, value, label, description, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [svc, cat, key, val, label, desc, type]);
    });

    // Cron jobs table
    db.run(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        command TEXT NOT NULL,
        description TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        last_run TEXT DEFAULT '',
        next_run TEXT DEFAULT '',
        status TEXT DEFAULT 'idle'
      )
    `);

    const cronJobs: [string, string, string, string][] = [
      ['OS Güncelleme', '0 3 * * *', 'apt update -qq && apt upgrade -y -qq', 'Günlük sistem paket güncellemesi (03:00)'],
      ['Pi-hole Gravity', '0 4 * * *', 'pihole -g', 'Reklam engelleme listelerini güncelle (04:00)'],
      ['Pi-hole Güncelleme', '0 4 * * 0', 'pihole -up', 'Pi-hole yazılım güncellemesi (Pazar 04:00)'],
      ['Unbound Root Hints', '0 5 1 * *', 'curl -o /var/lib/unbound/root.hints https://www.internic.net/domain/named.cache && systemctl restart unbound', 'Root hints dosyasını güncelle (Ayın 1i)'],
      ['Sistem Yeniden Başlat', '0 5 * * *', 'reboot', 'Günlük planlı yeniden başlatma (05:00)'],
      ['Log Temizliği', '0 2 * * 1', 'journalctl --vacuum-time=7d && find /var/log -name "*.gz" -mtime +30 -delete', 'Eski logları temizle (Pazartesi 02:00)'],
      ['Zapret Liste Güncelle', '30 3 * * *', '/opt/zapret/ipset/get_config.sh', 'Zapret IP ve domain listelerini güncelle (03:30)'],
      ['WireGuard Handshake Kontrol', '*/5 * * * *', 'wg show wg0 latest-handshakes', 'VPN tünel bağlantı kontrolü (5dk aralık)'],
      ['Fail2Ban Status', '0 * * * *', 'fail2ban-client status', 'Saatlik jail durum kontrolü'],
      ['Disk Sağlık Kontrolü', '0 6 * * *', 'df -h && vcgencmd measure_temp', 'Günlük disk ve sıcaklık raporu (06:00)'],
      ['SSL Sertifika Yenile', '0 12 1 */2 *', 'certbot renew --quiet', 'SSL sertifika yenilemesi (2 ayda bir)'],
      ['DNS Çözüm Testi', '*/10 * * * *', 'dig @127.0.0.1 -p 5335 google.com +short', 'DNS recursive resolver sağlık kontrolü (10dk)'],
    ];
    cronJobs.forEach(([name, schedule, command, desc]) => {
      db.run(`INSERT OR IGNORE INTO cron_jobs (name, schedule, command, description) VALUES (?, ?, ?, ?)`,
        [name, schedule, command, desc]);
    });

    // DDNS configs
    db.run(`
      CREATE TABLE IF NOT EXISTS ddns_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        hostname TEXT NOT NULL,
        username TEXT DEFAULT '',
        password TEXT DEFAULT '',
        token TEXT DEFAULT '',
        domain TEXT DEFAULT '',
        update_interval_min INTEGER DEFAULT 5,
        enabled INTEGER DEFAULT 1,
        last_update TEXT DEFAULT '',
        last_ip TEXT DEFAULT '',
        status TEXT DEFAULT 'idle',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS ddns_ip_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        source TEXT DEFAULT 'auto'
      )
    `);

    // Seed DDNS config
    db.run(`INSERT OR IGNORE INTO ddns_configs (id, provider, hostname, token, domain, update_interval_min, enabled, last_ip, status, last_update)
      VALUES (1, 'duckdns', 'pi5gateway', 'abc123-mock-token', 'pi5gateway.duckdns.org', 5, 1, '85.102.45.178', 'active', datetime('now'))`);

    // Seed DDNS IP history
    const ddnsIps: [string, string, string][] = [
      ['85.102.45.178', "datetime('now', '-1 hour')", 'auto'],
      ['85.102.44.210', "datetime('now', '-2 days')", 'auto'],
      ['85.102.43.95', "datetime('now', '-3 days')", 'auto'],
      ['85.102.42.17', "datetime('now', '-5 days')", 'auto'],
      ['85.102.41.203', "datetime('now', '-7 days')", 'auto'],
    ];
    ddnsIps.forEach(([ip, , source], idx) => {
      const dayOffset = [0, 2, 3, 5, 7][idx];
      db.run(`INSERT OR IGNORE INTO ddns_ip_history (id, ip, detected_at, source) VALUES (?, ?, datetime('now', '-${dayOffset} days'), ?)`,
        [idx + 1, ip, source]);
    });

    // Seed traffic routing rules (all categories)
    const trafficRules: [number, string, string, string][] = [
      [1, 'WhatsApp', 'voip', 'vps'],
      [2, 'Telegram', 'voip', 'direct'],
      [3, 'Discord', 'voip', 'vps'],
      [4, 'Signal', 'voip', 'direct'],
      [5, 'YouTube', 'streaming', 'direct'],
      [6, 'Netflix', 'streaming', 'vps'],
      [7, 'Twitch', 'streaming', 'direct'],
      [8, 'Instagram', 'social', 'zapret'],
      [9, 'Twitter/X', 'social', 'zapret'],
      [10, 'TikTok', 'social', 'vps'],
      [11, 'Steam', 'gaming', 'direct'],
      [12, 'Epic Games', 'gaming', 'direct'],
      [13, 'Spotify', 'streaming', 'direct'],
      [14, 'Google', 'web', 'direct'],
      [15, 'GitHub', 'web', 'direct'],
    ];
    trafficRules.forEach(([id, app, cat, route]) => {
      db.run(`INSERT OR IGNORE INTO traffic_routing (id, app_name, category, route_type) VALUES (?, ?, ?, ?)`, [id, app, cat, route]);
    });

    // Seed devices with route profiles
    const devices: [string, string, string, string, string][] = [
      ['AA:BB:CC:11:22:33', '192.168.1.10', 'iPhone 14', 'phone', 'default'],
      ['DD:EE:FF:44:55:66', '192.168.1.11', 'MacBook Pro', 'laptop', 'developer'],
      ['11:22:33:AA:BB:CC', '192.168.1.12', 'Smart TV', 'tv', 'streaming'],
      ['44:55:66:DD:EE:FF', '192.168.1.13', 'IoT Sensor', 'iot', 'restricted'],
      ['77:88:99:AA:BB:CC', '192.168.1.14', 'iPad Air', 'tablet', 'default'],
    ];
    devices.forEach(([mac, ip, host, type, profile]) => {
      db.run(`INSERT OR IGNORE INTO devices (mac_address, ip_address, hostname, device_type, route_profile) VALUES (?, ?, ?, ?, ?)`,
        [mac, ip, host, type, profile]);
    });

    // ─── Bandwidth Monitor ───
    db.run(`
      CREATE TABLE IF NOT EXISTS bandwidth_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_mac TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        bytes_in INTEGER DEFAULT 0,
        bytes_out INTEGER DEFAULT 0,
        interval_sec INTEGER DEFAULT 60
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS bandwidth_limits (
        device_mac TEXT PRIMARY KEY,
        daily_limit_mb INTEGER DEFAULT 0,
        monthly_limit_mb INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 0
      )
    `);

    // Seed bandwidth limits
    const bwLimits: [string, number, number, number][] = [
      ['AA:BB:CC:11:22:33', 5000, 100000, 1],
      ['11:22:33:AA:BB:CC', 10000, 200000, 1],
      ['44:55:66:DD:EE:FF', 500, 5000, 1],
    ];
    bwLimits.forEach(([mac, daily, monthly, enabled]) => {
      db.run(`INSERT OR IGNORE INTO bandwidth_limits (device_mac, daily_limit_mb, monthly_limit_mb, enabled) VALUES (?, ?, ?, ?)`,
        [mac, daily, monthly, enabled]);
    });

    // ─── Speed Tests ───
    db.run(`
      CREATE TABLE IF NOT EXISTS speed_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        download_mbps REAL NOT NULL,
        upload_mbps REAL NOT NULL,
        ping_ms REAL NOT NULL,
        server TEXT DEFAULT '',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed speed tests
    const speedTests: [number, number, number, string, string][] = [
      [94.5, 47.2, 12.3, 'Türk Telekom - İstanbul', '2026-03-24 10:30:00'],
      [89.1, 44.8, 14.1, 'Türk Telekom - Ankara', '2026-03-23 15:45:00'],
      [102.3, 51.0, 11.8, 'Vodafone - İstanbul', '2026-03-22 09:15:00'],
      [78.6, 39.4, 16.5, 'Türk Telekom - İzmir', '2026-03-21 20:00:00'],
    ];
    speedTests.forEach(([dl, ul, ping, server, ts]) => {
      db.run(`INSERT OR IGNORE INTO speed_tests (download_mbps, upload_mbps, ping_ms, server, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [dl, ul, ping, server, ts]);
    });

    // ─── Alerts ───
    db.run(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        source TEXT DEFAULT '',
        acknowledged INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed alerts
    const alerts: [string, string, string, string, string][] = [
      ['security', 'critical', 'Bilinmeyen cihaz ağa bağlandı: MAC FF:EE:DD:CC:BB:AA', 'device_monitor', '2026-03-25 08:15:00'],
      ['security', 'warning', 'Fail2Ban: 3 başarısız SSH girişi tespit edildi (IP: 45.33.32.156)', 'fail2ban', '2026-03-25 07:45:00'],
      ['network', 'critical', 'WireGuard tüneli koptu - VPS bağlantısı kesildi', 'wireguard', '2026-03-25 06:30:00'],
      ['network', 'warning', 'DNS çözümleme süresi normalin üstünde (>200ms)', 'unbound', '2026-03-25 05:00:00'],
      ['system', 'info', 'Pi-hole gravity listesi güncellendi (174,892 domain)', 'pihole', '2026-03-25 04:00:00'],
      ['system', 'warning', 'CPU sıcaklığı 65°C - termal izleme aktif', 'system_monitor', '2026-03-24 22:30:00'],
      ['bandwidth', 'warning', 'Smart TV günlük bant genişliği limitinin %90\'ına ulaştı', 'bandwidth_monitor', '2026-03-24 21:00:00'],
      ['system', 'info', 'Sistem otomatik yeniden başlatma tamamlandı', 'cron', '2026-03-24 05:00:00'],
    ];
    alerts.forEach(([type, severity, message, source, created]) => {
      db.run(`INSERT OR IGNORE INTO alerts (type, severity, message, source, created_at) VALUES (?, ?, ?, ?, ?)`,
        [type, severity, message, source, created]);
    });

    // ─── DHCP Leases ───
    db.run(`
      CREATE TABLE IF NOT EXISTS dhcp_leases (
        mac_address TEXT PRIMARY KEY,
        ip_address TEXT NOT NULL,
        hostname TEXT DEFAULT '',
        lease_start DATETIME DEFAULT CURRENT_TIMESTAMP,
        lease_end DATETIME,
        is_static INTEGER DEFAULT 0
      )
    `);

    // Seed DHCP leases
    const dhcpLeases: [string, string, string, string, string, number][] = [
      ['AA:BB:CC:11:22:33', '192.168.1.10', 'iPhone 14', '2026-03-25 06:00:00', '2026-03-26 06:00:00', 0],
      ['DD:EE:FF:44:55:66', '192.168.1.11', 'MacBook Pro', '2026-03-25 08:00:00', '2026-03-26 08:00:00', 1],
      ['11:22:33:AA:BB:CC', '192.168.1.12', 'Smart TV', '2026-03-24 20:00:00', '2026-03-25 20:00:00', 1],
      ['44:55:66:DD:EE:FF', '192.168.1.13', 'IoT Sensor', '2026-03-25 00:00:00', '2026-03-26 00:00:00', 1],
      ['77:88:99:AA:BB:CC', '192.168.1.14', 'iPad Air', '2026-03-25 09:00:00', '2026-03-26 09:00:00', 0],
      ['AB:CD:EF:12:34:56', '192.168.1.20', 'Samsung Galaxy S24', '2026-03-25 07:30:00', '2026-03-26 07:30:00', 0],
      ['12:34:56:AB:CD:EF', '192.168.1.21', 'Xbox Series X', '2026-03-24 18:00:00', '2026-03-25 18:00:00', 0],
    ];
    dhcpLeases.forEach(([mac, ip, host, start, end, isStatic]) => {
      db.run(`INSERT OR IGNORE INTO dhcp_leases (mac_address, ip_address, hostname, lease_start, lease_end, is_static) VALUES (?, ?, ?, ?, ?, ?)`,
        [mac, ip, host, start, end, isStatic]);
    });

    // ─── Parental Controls ───
    db.run(`
      CREATE TABLE IF NOT EXISTS parental_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_mac_or_group TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        value TEXT NOT NULL,
        schedule_start TEXT DEFAULT '',
        schedule_end TEXT DEFAULT '',
        days_of_week TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1
      )
    `);

    // Seed parental rules
    const parentalRules: [string, string, string, string, string, string, number][] = [
      ['77:88:99:AA:BB:CC', 'time_restrict', 'internet_access', '08:00', '22:00', 'mon,tue,wed,thu,fri', 1],
      ['77:88:99:AA:BB:CC', 'category_block', 'adult_content', '', '', '', 1],
      ['77:88:99:AA:BB:CC', 'site_block', 'tiktok.com', '', '', '', 1],
      ['cocuklar', 'time_restrict', 'internet_access', '09:00', '21:00', 'sat,sun', 1],
      ['cocuklar', 'category_block', 'gambling', '', '', '', 1],
    ];
    parentalRules.forEach(([target, ruleType, value, start, end, days, enabled]) => {
      db.run(`INSERT OR IGNORE INTO parental_rules (device_mac_or_group, rule_type, value, schedule_start, schedule_end, days_of_week, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [target, ruleType, value, start, end, days, enabled]);
    });

    // ─── Traffic Schedules ───
    db.run(`
      CREATE TABLE IF NOT EXISTS traffic_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        traffic_routing_id INTEGER,
        schedule_route_type TEXT NOT NULL,
        schedule_vps_id INTEGER,
        time_start TEXT NOT NULL,
        time_end TEXT NOT NULL,
        days_of_week TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        FOREIGN KEY(traffic_routing_id) REFERENCES traffic_routing(id)
      )
    `);

    // Seed traffic schedules
    const trafficSchedules: [number, string, number | null, string, string, string, number][] = [
      [5, 'vps', 1, '20:00', '02:00', 'mon,tue,wed,thu,fri,sat,sun', 1],
      [6, 'direct', null, '08:00', '18:00', 'mon,tue,wed,thu,fri', 1],
      [11, 'vps', 1, '19:00', '23:00', 'sat,sun', 1],
    ];
    trafficSchedules.forEach(([routingId, routeType, vpsId, start, end, days, enabled]) => {
      db.run(`INSERT OR IGNORE INTO traffic_schedules (traffic_routing_id, schedule_route_type, schedule_vps_id, time_start, time_end, days_of_week, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [routingId, routeType, vpsId, start, end, days, enabled]);
    });

    // ─── Device Groups ───
    db.run(`
      CREATE TABLE IF NOT EXISTS device_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        color TEXT DEFAULT '#3B82F6',
        icon TEXT DEFAULT 'devices'
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS device_group_members (
        group_id INTEGER NOT NULL,
        device_mac TEXT NOT NULL,
        PRIMARY KEY (group_id, device_mac),
        FOREIGN KEY(group_id) REFERENCES device_groups(id)
      )
    `);

    // Seed device groups
    const deviceGroups: [number, string, string, string, string][] = [
      [1, 'Aile', 'Aile üyelerinin cihazları', '#3B82F6', 'family_restroom'],
      [2, 'Çocuklar', 'Çocuk cihazları - ebeveyn kontrolü aktif', '#F59E0B', 'child_care'],
      [3, 'IoT Cihazları', 'Akıllı ev ve sensör cihazları', '#10B981', 'sensors'],
    ];
    deviceGroups.forEach(([id, name, desc, color, icon]) => {
      db.run(`INSERT OR IGNORE INTO device_groups (id, name, description, color, icon) VALUES (?, ?, ?, ?, ?)`,
        [id, name, desc, color, icon]);
    });

    const groupMembers: [number, string][] = [
      [1, 'AA:BB:CC:11:22:33'],
      [1, 'DD:EE:FF:44:55:66'],
      [2, '77:88:99:AA:BB:CC'],
      [3, '44:55:66:DD:EE:FF'],
    ];
    groupMembers.forEach(([gid, mac]) => {
      db.run(`INSERT OR IGNORE INTO device_group_members (group_id, device_mac) VALUES (?, ?)`, [gid, mac]);
    });

    // ─── Connection History ───
    db.run(`
      CREATE TABLE IF NOT EXISTS connection_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_mac TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed connection history
    const connHistory: [string, string, string][] = [
      ['AA:BB:CC:11:22:33', 'connect', '2026-03-25 08:00:00'],
      ['AA:BB:CC:11:22:33', 'disconnect', '2026-03-25 01:30:00'],
      ['AA:BB:CC:11:22:33', 'connect', '2026-03-24 18:00:00'],
      ['DD:EE:FF:44:55:66', 'connect', '2026-03-25 09:00:00'],
      ['DD:EE:FF:44:55:66', 'disconnect', '2026-03-25 02:00:00'],
      ['11:22:33:AA:BB:CC', 'connect', '2026-03-24 20:00:00'],
      ['44:55:66:DD:EE:FF', 'connect', '2026-03-25 00:00:00'],
      ['77:88:99:AA:BB:CC', 'connect', '2026-03-25 09:30:00'],
      ['77:88:99:AA:BB:CC', 'disconnect', '2026-03-25 00:00:00'],
      ['77:88:99:AA:BB:CC', 'connect', '2026-03-24 15:00:00'],
    ];
    connHistory.forEach(([mac, event, ts]) => {
      db.run(`INSERT OR IGNORE INTO connection_history (device_mac, event_type, timestamp) VALUES (?, ?, ?)`,
        [mac, event, ts]);
    });

    // ─── Known Devices (New Device Alerts) ───
    db.run(`
      CREATE TABLE IF NOT EXISTS known_devices (
        mac_address TEXT PRIMARY KEY,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        approved INTEGER DEFAULT 0
      )
    `);

    // Seed known devices
    const knownDevices: [string, string, number][] = [
      ['AA:BB:CC:11:22:33', '2026-01-15 10:00:00', 1],
      ['DD:EE:FF:44:55:66', '2026-01-15 10:00:00', 1],
      ['11:22:33:AA:BB:CC', '2026-02-01 14:00:00', 1],
      ['44:55:66:DD:EE:FF', '2026-02-10 09:00:00', 1],
      ['77:88:99:AA:BB:CC', '2026-02-20 16:00:00', 1],
      ['FF:EE:DD:CC:BB:AA', '2026-03-25 08:10:00', 0],
      ['AB:CD:EF:99:88:77', '2026-03-24 22:00:00', 0],
    ];
    knownDevices.forEach(([mac, firstSeen, approved]) => {
      db.run(`INSERT OR IGNORE INTO known_devices (mac_address, first_seen, approved) VALUES (?, ?, ?)`,
        [mac, firstSeen, approved]);
    });

    // ─── Throttle Rules ───
    db.run(`
      CREATE TABLE IF NOT EXISTS throttle_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_value TEXT NOT NULL,
        max_download_kbps INTEGER DEFAULT 0,
        max_upload_kbps INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1
      )
    `);

    // Seed throttle rules
    const throttleRules: [string, string, number, number, number][] = [
      ['device', '44:55:66:DD:EE:FF', 1024, 512, 1],
      ['group', 'Çocuklar', 5120, 2048, 1],
      ['app', 'TikTok', 2048, 1024, 1],
      ['device', '11:22:33:AA:BB:CC', 10240, 5120, 0],
    ];
    throttleRules.forEach(([type, value, dl, ul, enabled]) => {
      db.run(`INSERT OR IGNORE INTO throttle_rules (target_type, target_value, max_download_kbps, max_upload_kbps, enabled) VALUES (?, ?, ?, ?, ?)`,
        [type, value, dl, ul, enabled]);
    });

    // ─── App Settings ───
    db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT DEFAULT ''
      )
    `);

    // Seed app settings
    const appSettings: [string, string][] = [
      ['theme', 'dark'],
      ['language', 'tr'],
      ['notification_sound', 'true'],
      ['auto_refresh', 'true'],
      ['refresh_interval', '5000'],
    ];
    appSettings.forEach(([key, value]) => {
      db.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
    });

    // ─── Device Service Assignments ───
    db.run(`CREATE TABLE IF NOT EXISTS device_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_mac TEXT NOT NULL,
      service_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config_json TEXT DEFAULT '{}',
      UNIQUE(device_mac, service_name)
    )`);

    // Seed device services
    const deviceSvcs: [string, string, number, string][] = [
      ['AA:BB:CC:11:22:33', 'pihole', 1, '{"upstream":"unbound","blocking":true}'],
      ['AA:BB:CC:11:22:33', 'unbound', 1, '{"port":5335}'],
      ['AA:BB:CC:11:22:33', 'zapret', 1, '{"mode":"nfqws"}'],
      ['AA:BB:CC:11:22:33', 'wireguard', 0, '{}'],
      ['AA:BB:CC:11:22:33', 'fail2ban', 1, '{}'],
      ['DD:EE:FF:44:55:66', 'pihole', 1, '{"upstream":"unbound","blocking":true}'],
      ['DD:EE:FF:44:55:66', 'unbound', 1, '{"port":5335}'],
      ['DD:EE:FF:44:55:66', 'zapret', 1, '{"mode":"nfqws","desync":"fake,split2"}'],
      ['DD:EE:FF:44:55:66', 'wireguard', 1, '{"tunnel":"wg0","vps_id":1}'],
      ['DD:EE:FF:44:55:66', 'fail2ban', 1, '{}'],
      ['11:22:33:AA:BB:CC', 'pihole', 1, '{"upstream":"cloudflare","blocking":true}'],
      ['11:22:33:AA:BB:CC', 'unbound', 0, '{}'],
      ['11:22:33:AA:BB:CC', 'zapret', 0, '{}'],
      ['11:22:33:AA:BB:CC', 'wireguard', 0, '{}'],
      ['11:22:33:AA:BB:CC', 'fail2ban', 0, '{}'],
      ['44:55:66:DD:EE:FF', 'pihole', 1, '{"upstream":"unbound","blocking":true}'],
      ['44:55:66:DD:EE:FF', 'unbound', 1, '{}'],
      ['44:55:66:DD:EE:FF', 'zapret', 0, '{}'],
      ['44:55:66:DD:EE:FF', 'wireguard', 0, '{}'],
      ['44:55:66:DD:EE:FF', 'fail2ban', 0, '{}'],
      ['77:88:99:AA:BB:CC', 'pihole', 1, '{"upstream":"unbound","blocking":true}'],
      ['77:88:99:AA:BB:CC', 'unbound', 1, '{}'],
      ['77:88:99:AA:BB:CC', 'zapret', 1, '{"mode":"nfqws"}'],
      ['77:88:99:AA:BB:CC', 'wireguard', 0, '{}'],
      ['77:88:99:AA:BB:CC', 'fail2ban', 1, '{}'],
    ];
    deviceSvcs.forEach(([mac, svc, enabled, config]) => {
      db.run('INSERT OR IGNORE INTO device_services (device_mac, service_name, enabled, config_json) VALUES (?, ?, ?, ?)',
        [mac, svc, enabled, config]);
    });

    // ─── WireGuard Clients ───
    db.run(`CREATE TABLE IF NOT EXISTS wg_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vps_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      public_key TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(vps_id) REFERENCES vps_servers(id)
    )`);

    // Seed WireGuard clients
    const wgClients: [number, string, string, string, string][] = [
      [1, 'iPhone-Ahmet', '10.66.66.2', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC=',
        '[Interface]\nPrivateKey = cK1lM3nO5pQ7rS9tU1vW3xY5zA7bCdE5fG7hI9jK1l=\nAddress = 10.66.66.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25'],
      [1, 'MacBook-Ofis', '10.66.66.3', 'xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=',
        '[Interface]\nPrivateKey = dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xYaB3dE5fG7h=\nAddress = 10.66.66.3/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25'],
      [1, 'iPad-Ev', '10.66.66.4', 'fG3hI5jK7lM9nO1pQ3rS5tU7vW9xYaB3dE5fG7hI9j=',
        '[Interface]\nPrivateKey = hI5jK7lM9nO1pQ3rS5tU7vW9xYaB3dE5fG7hI9jK1l=\nAddress = 10.66.66.4/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY=\nEndpoint = 203.0.113.10:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25'],
    ];
    wgClients.forEach(([vpsId, name, ip, pubkey, config]) => {
      db.run('INSERT OR IGNORE INTO wg_clients (vps_id, name, ip, public_key, config) VALUES (?, ?, ?, ?, ?)',
        [vpsId, name, ip, pubkey, config]);
    });

    // ─── Device Routing (per-device app routing) ───
    db.run(`
      CREATE TABLE IF NOT EXISTS device_routing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_mac TEXT NOT NULL,
        app_name TEXT NOT NULL,
        route_type TEXT NOT NULL DEFAULT 'direct',
        vps_id INTEGER,
        tunnel_name TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        FOREIGN KEY(vps_id) REFERENCES vps_servers(id)
      )
    `);

    // Seed device routing
    const deviceRoutingRules: [string, string, string, number | null, string, number][] = [
      ['AA:BB:CC:11:22:33', 'Discord', 'vps', 1, 'wg0', 1],
      ['AA:BB:CC:11:22:33', 'YouTube', 'zapret', null, '', 1],
      ['AA:BB:CC:11:22:33', 'Instagram', 'zapret', null, '', 1],
      ['DD:EE:FF:44:55:66', 'Steam', 'direct', null, '', 1],
      ['DD:EE:FF:44:55:66', 'Discord', 'vps', 1, 'wg0', 1],
      ['DD:EE:FF:44:55:66', 'TikTok', 'blocked', null, '', 1],
      ['11:22:33:AA:BB:CC', 'Netflix', 'vps', 1, 'wg0', 1],
      ['11:22:33:AA:BB:CC', 'Spotify', 'direct', null, '', 1],
    ];
    deviceRoutingRules.forEach(([mac, app, route, vps, tunnel, enabled]) => {
      db.run(`INSERT OR IGNORE INTO device_routing (device_mac, app_name, route_type, vps_id, tunnel_name, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
        [mac, app, route, vps, tunnel, enabled]);
    });
  });
};

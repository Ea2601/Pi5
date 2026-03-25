import {
  BookOpen, ShieldBan, Zap, Flame, Globe, Server, ShieldAlert,
  Clock, Network, Route, ChevronDown, ChevronRight, Terminal,
  AlertTriangle, CheckCircle, Info, Cpu
} from 'lucide-react';
import { useState } from 'react';
import { Panel, Badge } from './ui';

interface DocSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  badge?: string;
  content: React.ReactNode;
}

export function DocsPanel() {
  const [activeSection, setActiveSection] = useState<string>('overview');
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);

  const sections: DocSection[] = [
    {
      id: 'overview',
      title: 'Genel Bakış',
      icon: <BookOpen size={15} />,
      content: <OverviewDoc />,
    },
    {
      id: 'architecture',
      title: 'Sistem Mimarisi',
      icon: <Cpu size={15} />,
      content: <ArchitectureDoc />,
    },
    {
      id: 'pihole',
      title: 'Pi-hole DNS',
      icon: <ShieldBan size={15} />,
      badge: 'DNS',
      content: <PiholeDoc />,
    },
    {
      id: 'unbound',
      title: 'Unbound DNS',
      icon: <Globe size={15} />,
      badge: 'DNS',
      content: <UnboundDoc />,
    },
    {
      id: 'zapret',
      title: 'Zapret DPI Bypass',
      icon: <Zap size={15} />,
      badge: 'DPI',
      content: <ZapretDoc />,
    },
    {
      id: 'firewall',
      title: 'nftables Firewall',
      icon: <Flame size={15} />,
      badge: 'Güvenlik',
      content: <FirewallDoc />,
    },
    {
      id: 'wireguard',
      title: 'WireGuard VPN',
      icon: <Server size={15} />,
      badge: 'VPN',
      content: <WireguardDoc />,
    },
    {
      id: 'fail2ban',
      title: 'Fail2Ban',
      icon: <ShieldAlert size={15} />,
      badge: 'Güvenlik',
      content: <Fail2banDoc />,
    },
    {
      id: 'routing',
      title: 'Trafik Yönlendirme',
      icon: <Route size={15} />,
      content: <RoutingDoc />,
    },
    {
      id: 'network',
      title: 'Ağ Topolojisi',
      icon: <Network size={15} />,
      content: <NetworkDoc />,
    },
    {
      id: 'cron',
      title: 'Cron & Bakım',
      icon: <Clock size={15} />,
      content: <CronDoc />,
    },
    {
      id: 'troubleshooting',
      title: 'Sorun Giderme',
      icon: <AlertTriangle size={15} />,
      badge: 'SSS',
      content: <TroubleshootingDoc expandedFaq={expandedFaq} setExpandedFaq={setExpandedFaq} />,
    },
    {
      id: 'cli',
      title: 'CLI Referansı',
      icon: <Terminal size={15} />,
      content: <CliDoc />,
    },
  ];

  const active = sections.find(s => s.id === activeSection) || sections[0];

  return (
    <div className="fade-in">
      <Panel title="Teknik Dokümantasyon & Kullanım Kılavuzu"
        icon={<BookOpen size={20} style={{ marginRight: 8 }} />}
        subtitle="Pi5 Secure Gateway — Tüm servis ve ayarların detaylı açıklamaları">
        <div className="docs-layout">
          <nav className="docs-nav">
            {sections.map(section => (
              <button key={section.id}
                className={`docs-nav-item ${activeSection === section.id ? 'docs-nav-active' : ''}`}
                onClick={() => setActiveSection(section.id)}>
                {section.icon}
                <span>{section.title}</span>
                {section.badge && <Badge variant="info">{section.badge}</Badge>}
              </button>
            ))}
          </nav>
          <div className="docs-content">
            {active.content}
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ────────────── Doc Sections ────────────── */

function DocBlock({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="doc-block">
      {title && <h4 className="doc-block-title">{title}</h4>}
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return <pre className="doc-code">{children}</pre>;
}

function DocTip({ type = 'info', children }: { type?: 'info' | 'warning' | 'success'; children: React.ReactNode }) {
  const icons = { info: <Info size={14} />, warning: <AlertTriangle size={14} />, success: <CheckCircle size={14} /> };
  return <div className={`doc-tip doc-tip-${type}`}>{icons[type]}<div>{children}</div></div>;
}

function OverviewDoc() {
  return (
    <div className="doc-page">
      <h3>Pi5 Secure Gateway — Genel Bakış</h3>
      <p>Bu web paneli, Raspberry Pi 5 üzerinde çalışan ağ güvenliği ve yönlendirme servislerinin merkezi yönetim arayüzüdür.</p>

      <DocBlock title="Sistem Bileşenleri">
        <div className="doc-grid">
          <div className="doc-card">
            <ShieldBan size={20} /><strong>Pi-hole</strong>
            <p>DNS tabanlı reklam ve tracker engelleme. Ağdaki tüm cihazlar için koruma sağlar.</p>
          </div>
          <div className="doc-card">
            <Globe size={20} /><strong>Unbound</strong>
            <p>Özyinelemeli DNS çözücü. Üçüncü taraf DNS bağımlılığını ortadan kaldırır.</p>
          </div>
          <div className="doc-card">
            <Zap size={20} /><strong>Zapret</strong>
            <p>DPI (Deep Packet Inspection) atlatma motoru. ISP engellemelerini aşar.</p>
          </div>
          <div className="doc-card">
            <Flame size={20} /><strong>nftables</strong>
            <p>Linux kernel güvenlik duvarı. Port filtreleme, NAT ve paket yönlendirme.</p>
          </div>
          <div className="doc-card">
            <Server size={20} /><strong>WireGuard</strong>
            <p>Modern VPN protokolü. Düşük gecikme, yüksek güvenlik tünel bağlantıları.</p>
          </div>
          <div className="doc-card">
            <ShieldAlert size={20} /><strong>Fail2Ban</strong>
            <p>Brute-force saldırı koruması. Tekrarlayan başarısız giriş denemelerini engeller.</p>
          </div>
        </div>
      </DocBlock>

      <DocBlock title="Trafik Akışı">
        <CodeBlock>{`İstemci → Pi5 (eth0) → Pi-hole DNS (port 53)
                          → Unbound (port 5335) → Root DNS
                          → nftables (filtreleme)
                          → Zapret (DPI bypass) / WireGuard (VPN tünel)
                          → İnternet (wlan0)`}</CodeBlock>
      </DocBlock>

      <DocTip>Tüm ayarlar bu panel üzerinden yapılabilir. Her servisin kendi sayfasında "Ayarlar" sekmesi bulunur.</DocTip>
    </div>
  );
}

function ArchitectureDoc() {
  return (
    <div className="doc-page">
      <h3>Sistem Mimarisi</h3>

      <DocBlock title="Donanım">
        <table className="doc-table">
          <tbody>
            <tr><td>Platform</td><td>Raspberry Pi 5 (8GB RAM)</td></tr>
            <tr><td>İşletim Sistemi</td><td>Raspberry Pi OS (64-bit, Debian Bookworm)</td></tr>
            <tr><td>Depolama</td><td>128GB microSD / NVMe SSD</td></tr>
            <tr><td>Ağ Arayüzleri</td><td>eth0 (LAN), wlan0 (WAN), wg0 (VPN)</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Yazılım Mimarisi">
        <table className="doc-table">
          <tbody>
            <tr><td>Frontend</td><td>React 19 + Vite 8 + TypeScript</td></tr>
            <tr><td>Backend</td><td>Express 5 + TypeScript + SQLite</td></tr>
            <tr><td>Veritabanı</td><td>SQLite (yerel dosya tabanlı)</td></tr>
            <tr><td>SSH Bağlantı</td><td>node-ssh (VPS otomasyonu)</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Port Haritası">
        <table className="doc-table">
          <thead><tr><th>Port</th><th>Servis</th><th>Protokol</th></tr></thead>
          <tbody>
            <tr><td>22</td><td>SSH</td><td>TCP</td></tr>
            <tr><td>53</td><td>Pi-hole DNS</td><td>TCP/UDP</td></tr>
            <tr><td>3000</td><td>Web Panel (Frontend)</td><td>TCP</td></tr>
            <tr><td>3001</td><td>API Backend</td><td>TCP</td></tr>
            <tr><td>5335</td><td>Unbound DNS</td><td>TCP/UDP</td></tr>
            <tr><td>51820</td><td>WireGuard VPN</td><td>UDP</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Fail-Open Mekanizması">
        <p>Sistem her 10 saniyede bir DNS sağlık kontrolü yapar. DNS çözümlemesi başarısız olursa, <strong>fail-open</strong> modu devreye girer ve trafik doğrudan ISP'ye yönlendirilir. Bu sayede DNS arızası internet erişimini kesmez.</p>
        <DocTip type="warning">Fail-open modunda reklam engelleme ve DPI bypass devre dışıdır.</DocTip>
      </DocBlock>
    </div>
  );
}

function PiholeDoc() {
  return (
    <div className="doc-page">
      <h3>Pi-hole DNS Reklam Engelleme</h3>
      <p>Pi-hole, ağ düzeyinde DNS tabanlı reklam ve tracker engelleyicidir. Cihaz bazlı kurulum gerektirmez — tüm ağ trafiği otomatik olarak filtrelenir.</p>

      <DocBlock title="Ayar Kategorileri">
        <table className="doc-table">
          <thead><tr><th>Kategori</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td><strong>DNS Ayarları</strong></td><td>Upstream DNS sunucuları, DNSSEC, koşullu yönlendirme, önbellek boyutu</td></tr>
            <tr><td><strong>Engelleme</strong></td><td>Engelleme modu (NULL/NXDOMAIN/IP), engelleme durumu</td></tr>
            <tr><td><strong>DHCP</strong></td><td>Dahili DHCP sunucu: IP aralığı, gateway, kira süresi, IPv6</td></tr>
            <tr><td><strong>Gizlilik</strong></td><td>Sorgu kayıtları, gizlilik seviyesi (0-3), log saklama süresi</td></tr>
            <tr><td><strong>Hız Limitleme</strong></td><td>Dakikadaki maksimum sorgu sayısı, rate limit periyodu</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Liste Yönetimi">
        <p><strong>Bloklisteleri (Adlists):</strong> Reklam ve tracker domain listelerinin URL'leri. Gravity güncellemesinde indirilir.</p>
        <p><strong>Beyaz Liste:</strong> Engellenmemesi gereken domainler (yanlış pozitif düzeltme).</p>
        <p><strong>Kara Liste:</strong> Ek olarak engellenmesi istenen domainler.</p>
        <p><strong>Yerel DNS:</strong> Özel IP-domain eşlemeleri (ör: 192.168.1.5 pihole.lan).</p>
      </DocBlock>

      <DocTip>Gravity güncellemesi (pihole -g) yeni eklenen adlist'leri indirir ve uygular. Cron görevlerinden otomatik çalışır.</DocTip>
    </div>
  );
}

function UnboundDoc() {
  return (
    <div className="doc-page">
      <h3>Unbound Recursive DNS</h3>
      <p>Unbound, özyinelemeli DNS çözücüdür. Cloudflare, Google gibi üçüncü taraf DNS sunucularına bağımlılığı ortadan kaldırır.</p>

      <DocBlock title="Nasıl Çalışır?">
        <CodeBlock>{`1. Pi-hole sorguyu 127.0.0.1:5335'e yönlendirir
2. Unbound, root DNS sunucularından başlayarak çözümler:
   → Root (.): "com nerede?" → TLD (.com): "google.com nerede?" → Authoritative: "142.250.x.x"
3. Sonuç önbelleğe alınır (cache_min_ttl ~ cache_max_ttl)
4. Tekrar sorulduğunda önbellekten döner`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Güvenlik Özellikleri">
        <table className="doc-table">
          <thead><tr><th>Özellik</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td>DNSSEC</td><td>DNS yanıtlarının kriptografik doğrulaması</td></tr>
            <tr><td>Caps-for-ID (0x20)</td><td>DNS spoofing koruması — sorgu adını büyük/küçük harf karıştırarak doğrular</td></tr>
            <tr><td>Kimlik gizleme</td><td>Sunucu versiyonu ve kimliğini dış sorgulara gizler</td></tr>
            <tr><td>Glue sıkılaştırma</td><td>Sahte glue kayıtlarını reddeder</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocTip type="success">Unbound + Pi-hole kombinasyonu hem gizlilik hem güvenlik için en iyi uygulamadır.</DocTip>
    </div>
  );
}

function ZapretDoc() {
  return (
    <div className="doc-page">
      <h3>Zapret DPI Bypass Motoru</h3>
      <p>Zapret, ISP'lerin Deep Packet Inspection (DPI) ile uyguladığı engellemeleri aşmak için paket manipülasyonu yapar.</p>

      <DocBlock title="Bypass Modları">
        <table className="doc-table">
          <thead><tr><th>Mod</th><th>Açıklama</th><th>Kullanım</th></tr></thead>
          <tbody>
            <tr><td><strong>NFQWS</strong></td><td>Netfilter Queue ile paket manipülasyonu</td><td>Çoğu DPI engeli için önerilen</td></tr>
            <tr><td><strong>TPROXY</strong></td><td>Transparent proxy üzerinden yönlendirme</td><td>NFQWS işe yaramadığında</td></tr>
            <tr><td><strong>Sing-box</strong></td><td>Gelişmiş protokol tabanlı routing</td><td>Karmaşık engelleme senaryoları</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="NFQWS Parametreleri">
        <table className="doc-table">
          <thead><tr><th>Parametre</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td>desync_mode</td><td>Paket manipülasyon stratejisi (fake, split, split2, disorder)</td></tr>
            <tr><td>desync_ttl</td><td>Sahte paketin TTL değeri (ISP DPI'ını kandırmak için düşük tutulur)</td></tr>
            <tr><td>desync_fooling</td><td>DPI kandırma yöntemi (md5sig, badseq, datanoack)</td></tr>
            <tr><td>split_pos</td><td>TLS ClientHello'nun bölünme pozisyonu</td></tr>
            <tr><td>hostcase</td><td>Host header'da büyük/küçük harf karıştırma</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Blockcheck Kullanımı">
        <p>Blockcheck, belirli bir domain için hangi DPI bypass parametrelerinin çalıştığını otomatik test eder.</p>
        <CodeBlock>{`# Zapret panelinden: Test domaini girin → "Blockcheck Başlat"
# CLI: /opt/zapret/blockcheck.sh --domain discord.com
# Sonuç: Çalışan strateji otomatik uygulanır`}</CodeBlock>
      </DocBlock>

      <DocTip type="warning">ISP'ler DPI yöntemlerini değiştirebilir. Periyodik blockcheck çalıştırmanız önerilir.</DocTip>
    </div>
  );
}

function FirewallDoc() {
  return (
    <div className="doc-page">
      <h3>nftables Güvenlik Duvarı</h3>
      <p>nftables, Linux kernel'deki paket filtreleme altyapısıdır. iptables'ın modern halefidir.</p>

      <DocBlock title="Zincir Yapısı">
        <table className="doc-table">
          <thead><tr><th>Zincir</th><th>Amaç</th><th>Varsayılan Politika</th></tr></thead>
          <tbody>
            <tr><td><strong>Input</strong></td><td>Pi5'e gelen trafik</td><td>DROP (sadece izin verilenler geçer)</td></tr>
            <tr><td><strong>Forward</strong></td><td>Pi5 üzerinden yönlendirilen trafik</td><td>DROP</td></tr>
            <tr><td><strong>Output</strong></td><td>Pi5'ten çıkan trafik</td><td>ACCEPT</td></tr>
            <tr><td><strong>NAT Postrouting</strong></td><td>Çıkış trafiği masquerade</td><td>—</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Ayarlar">
        <p><strong>Politikalar:</strong> Her zincirin varsayılan davranışını belirler (accept/drop).</p>
        <p><strong>NAT:</strong> Masquerade yapılacak çıkış arayüzü ve NAT etkinliği.</p>
        <p><strong>Yönlendirme:</strong> LAN/WAN/WireGuard arayüz atamaları ve IP forwarding.</p>
      </DocBlock>
    </div>
  );
}

function WireguardDoc() {
  return (
    <div className="doc-page">
      <h3>WireGuard VPN</h3>
      <p>WireGuard, modern, hızlı ve güvenli bir VPN protokolüdür. Pi5'ten uzak VPS sunucularına şifreli tüneller kurar.</p>

      <DocBlock title="Kurulum Akışı">
        <CodeBlock>{`1. VPS IP ve SSH bilgilerini girin
2. "Deploy Secure Tunnel" butonuna basın
3. Sistem otomatik olarak:
   → SSH ile VPS'e bağlanır
   → WireGuard'ı kurar (angristan script)
   → Client config'i oluşturur
   → wg0 arayüzünü aktifleştirir
4. Bağlantı durumu panelde görünür`}</CodeBlock>
      </DocBlock>

      <DocBlock title="WireGuard Ayarları">
        <table className="doc-table">
          <thead><tr><th>Ayar</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td>Arayüz Adresi</td><td>WireGuard tünel IP (ör: 10.66.66.1/24)</td></tr>
            <tr><td>Dinleme Portu</td><td>UDP port (varsayılan: 51820)</td></tr>
            <tr><td>MTU</td><td>Maksimum iletim birimi (1420 önerilen)</td></tr>
            <tr><td>Keepalive</td><td>NAT arkasında bağlantı canlılığı (25sn)</td></tr>
            <tr><td>Post-Up/Down</td><td>Tünel açılış/kapanış komutları</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocTip>Birden fazla VPS ekleyerek farklı trafik tiplerini farklı tünellerden yönlendirebilirsiniz.</DocTip>
    </div>
  );
}

function Fail2banDoc() {
  return (
    <div className="doc-page">
      <h3>Fail2Ban Saldırı Koruması</h3>
      <p>Fail2Ban, log dosyalarını izleyerek brute-force saldırılarını tespit eder ve saldırgan IP'leri otomatik engeller.</p>

      <DocBlock title="Jail Türleri">
        <table className="doc-table">
          <thead><tr><th>Jail</th><th>Koruduğu Servis</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td><strong>sshd</strong></td><td>SSH</td><td>Başarısız SSH giriş denemelerini izler</td></tr>
            <tr><td><strong>nginx-http-auth</strong></td><td>Web sunucu</td><td>HTTP Basic Auth denemelerini izler</td></tr>
            <tr><td><strong>recidive</strong></td><td>Tüm jail'ler</td><td>Tekrar ban alan IP'lere uzun süreli ban uygular</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Temel Ayarlar">
        <p><strong>bantime:</strong> IP'nin engellenme süresi (varsayılan: 1 saat).</p>
        <p><strong>findtime:</strong> Hata sayma penceresi (bu sürede maxretry aşılırsa ban).</p>
        <p><strong>maxretry:</strong> Ban öncesi izin verilen başarısız deneme sayısı.</p>
        <p><strong>ignoreip:</strong> Ban uygulanmayacak IP/subnet listesi (yerel ağ dahil).</p>
      </DocBlock>

      <DocTip type="warning">Recidive jail'i, kısa süreli banlardan sonra tekrar yakalanan IP'lere 1 haftalık ban uygular.</DocTip>
    </div>
  );
}

function RoutingDoc() {
  return (
    <div className="doc-page">
      <h3>Trafik Yönlendirme</h3>
      <p>Uygulama bazlı trafik yönlendirme sistemi. Her uygulamayı farklı bir yoldan internete çıkarabilirsiniz.</p>

      <DocBlock title="Yönlendirme Tipleri">
        <table className="doc-table">
          <thead><tr><th>Tip</th><th>Açıklama</th><th>Kullanım</th></tr></thead>
          <tbody>
            <tr><td><Badge variant="neutral">Direct</Badge></td><td>ISP üzerinden doğrudan</td><td>Engelsiz servisler, düşük gecikme</td></tr>
            <tr><td><Badge variant="success">VPS</Badge></td><td>WireGuard tüneli üzerinden</td><td>Engellenmiş veya gizlilik gerektiren</td></tr>
            <tr><td><Badge variant="info">Zapret</Badge></td><td>DPI bypass ile doğrudan</td><td>DPI ile engellenen ama VPN gerektirmeyen</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Cihaz Profilleri">
        <table className="doc-table">
          <thead><tr><th>Profil</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td><strong>Varsayılan</strong></td><td>Zapret DPI + Pi-hole DNS koruması</td></tr>
            <tr><td><strong>Geliştirici</strong></td><td>VPS tünel + tam erişim</td></tr>
            <tr><td><strong>Streaming</strong></td><td>Direkt ISP + düşük gecikme (video akışı için)</td></tr>
            <tr><td><strong>Kısıtlı</strong></td><td>Sadece yerel ağ erişimi (IoT cihazları için)</td></tr>
          </tbody>
        </table>
      </DocBlock>
    </div>
  );
}

function NetworkDoc() {
  return (
    <div className="doc-page">
      <h3>Ağ Topolojisi</h3>
      <p>Ağ haritası, Pi5'e bağlı tüm cihazları ve bunların yönlendirme profillerini görselleştirir.</p>

      <DocBlock title="Cihaz Yönetimi">
        <p>Her cihaz MAC adresiyle tanımlanır. Ağ haritasından cihaza tıklayarak profilini değiştirebilirsiniz.</p>
        <CodeBlock>{`Profil değiştirme: Cihaz kartı → Profil seçici → Yeni profil seç
Trafik izleme: Her cihazın anlık download/upload hızı gösterilir`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Ağ Arayüzleri">
        <table className="doc-table">
          <thead><tr><th>Arayüz</th><th>Rol</th><th>IP Aralığı</th></tr></thead>
          <tbody>
            <tr><td>eth0</td><td>LAN (cihazlar buraya bağlanır)</td><td>192.168.1.0/24</td></tr>
            <tr><td>wlan0</td><td>WAN (internet çıkışı)</td><td>DHCP / ISP</td></tr>
            <tr><td>wg0</td><td>VPN tüneli</td><td>10.66.66.0/24</td></tr>
          </tbody>
        </table>
      </DocBlock>
    </div>
  );
}

function CronDoc() {
  return (
    <div className="doc-page">
      <h3>Cron Görevleri & Bakım</h3>
      <p>Sistemde periyodik olarak çalışan otomatik bakım görevleri.</p>

      <DocBlock title="Cron Formatı">
        <CodeBlock>{`┌───────────── dakika (0-59)
│ ┌─────────── saat (0-23)
│ │ ┌───────── gün (1-31)
│ │ │ ┌─────── ay (1-12)
│ │ │ │ ┌───── haftanın günü (0-7, 0=7=Pazar)
│ │ │ │ │
* * * * *`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Örnekler">
        <table className="doc-table">
          <thead><tr><th>İfade</th><th>Anlamı</th></tr></thead>
          <tbody>
            <tr><td><code>0 3 * * *</code></td><td>Her gün 03:00</td></tr>
            <tr><td><code>*/5 * * * *</code></td><td>Her 5 dakikada bir</td></tr>
            <tr><td><code>0 4 * * 0</code></td><td>Her Pazar 04:00</td></tr>
            <tr><td><code>0 5 1 * *</code></td><td>Her ayın 1'i 05:00</td></tr>
            <tr><td><code>0 12 1 */2 *</code></td><td>Her 2 ayda bir</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Varsayılan Görevler">
        <p>Sistem kurulduğunda aşağıdaki görevler otomatik eklenir:</p>
        <ul className="doc-list">
          <li>OS paket güncellemesi (günlük)</li>
          <li>Pi-hole gravity güncelleme (günlük)</li>
          <li>Pi-hole yazılım güncelleme (haftalık)</li>
          <li>Unbound root hints güncelleme (aylık)</li>
          <li>Zapret liste güncelleme (günlük)</li>
          <li>Log temizliği (haftalık)</li>
          <li>DNS sağlık kontrolü (10 dakika)</li>
          <li>WireGuard handshake kontrolü (5 dakika)</li>
        </ul>
      </DocBlock>

      <DocTip>Cron görevlerini "Sistem & Log" sayfasından yönetebilir, yeni görev ekleyebilir veya mevcut görevleri düzenleyebilirsiniz.</DocTip>
    </div>
  );
}

function TroubleshootingDoc({ expandedFaq, setExpandedFaq }: { expandedFaq: string | null; setExpandedFaq: (id: string | null) => void }) {
  const faqs = [
    { id: 'dns-fail', q: 'DNS çözümlemesi çalışmıyor', a: 'Pi-hole ve Unbound servislerinin aktif olduğundan emin olun. "dig @127.0.0.1 google.com" komutuyla test edin. Fail-open modu aktif ise DNS arızası var demektir.' },
    { id: 'dpi-block', q: 'Zapret bypass çalışmıyor, site hâlâ engelli', a: 'ISP DPI yöntemini değiştirmiş olabilir. Zapret panelinden blockcheck çalıştırarak yeni parametreler test edin. desync_mode ve desync_ttl değerlerini değiştirmeyi deneyin.' },
    { id: 'wg-fail', q: 'WireGuard tüneli bağlanmıyor', a: 'VPS\'in erişilebilir olduğundan emin olun (ping). UDP 51820 portunun VPS firewall\'unda açık olduğunu kontrol edin. "wg show" komutuyla handshake durumunu kontrol edin.' },
    { id: 'high-cpu', q: 'CPU kullanımı çok yüksek', a: 'Zapret NFQWS modunda paket işleme CPU yoğundur. TPROXY moduna geçmeyi deneyin. Ayrıca Unbound thread sayısını CPU çekirdek sayısıyla eşleştirin.' },
    { id: 'blocked-site', q: 'Bir site Pi-hole tarafından yanlışlıkla engelleniyor', a: 'Pi-hole → Beyaz Liste sekmesinden domaini ekleyin. Alternatif olarak "pihole -w example.com" komutuyla CLI\'dan ekleyebilirsiniz.' },
    { id: 'ssh-locked', q: 'SSH ile bağlanamıyorum, Fail2Ban engelledi', a: 'Fiziksel erişimle "fail2ban-client set sshd unbanip <IP>" çalıştırın. Yerel ağınızı ignoreip listesine ekleyin.' },
    { id: 'slow-dns', q: 'DNS sorguları yavaş', a: 'Unbound önbellek boyutunu artırın (msg_cache_size, rrset_cache_size). Prefetch özelliğini aktifleştirin. cache_min_ttl değerini yükseltin.' },
    { id: 'gravity-fail', q: 'Pi-hole Gravity güncellemesi başarısız', a: 'İnternet bağlantısını kontrol edin. Bloklistelerindeki URL\'lerin erişilebilir olduğunu doğrulayın. Erişilemeyen listeleri devre dışı bırakın.' },
  ];

  return (
    <div className="doc-page">
      <h3>Sorun Giderme & Sıkça Sorulan Sorular</h3>

      <div className="faq-list">
        {faqs.map(faq => (
          <div key={faq.id} className="faq-item">
            <button className="faq-question" onClick={() => setExpandedFaq(expandedFaq === faq.id ? null : faq.id)}>
              {expandedFaq === faq.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <span>{faq.q}</span>
            </button>
            {expandedFaq === faq.id && (
              <div className="faq-answer">{faq.a}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CliDoc() {
  return (
    <div className="doc-page">
      <h3>CLI Komut Referansı</h3>
      <p>Pi5 üzerinde SSH ile kullanabileceğiniz temel komutlar.</p>

      <DocBlock title="Pi-hole">
        <CodeBlock>{`pihole status              # Servis durumu
pihole -g                  # Gravity güncelleme (adlist indir)
pihole -up                 # Pi-hole güncelleme
pihole -w example.com      # Beyaz listeye ekle
pihole -b example.com      # Kara listeye ekle
pihole restartdns          # DNS servisini yeniden başlat
pihole -q example.com      # Domain sorgula (engelli mi?)`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Unbound">
        <CodeBlock>{`systemctl status unbound    # Servis durumu
unbound-control stats      # İstatistikler
unbound-control dump_cache # Önbellek içeriği
dig @127.0.0.1 -p 5335 google.com  # Test sorgusu`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Zapret">
        <CodeBlock>{`/opt/zapret/blockcheck.sh --domain discord.com  # Blockcheck
systemctl status zapret    # Servis durumu
nfqws --help               # NFQWS parametreleri`}</CodeBlock>
      </DocBlock>

      <DocBlock title="WireGuard">
        <CodeBlock>{`wg show                    # Tünel durumu
wg show wg0 latest-handshakes   # Son handshake
wg-quick up wg0            # Tüneli başlat
wg-quick down wg0          # Tüneli durdur`}</CodeBlock>
      </DocBlock>

      <DocBlock title="nftables & Ağ">
        <CodeBlock>{`nft list ruleset           # Tüm kurallar
nft list chain inet filter input  # Input zinciri
systemctl restart nftables # Kuralları yeniden yükle
ip addr show               # Ağ arayüzleri
ss -tulnp                  # Açık portlar`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Fail2Ban">
        <CodeBlock>{`fail2ban-client status      # Genel durum
fail2ban-client status sshd # SSH jail detayı
fail2ban-client set sshd unbanip 1.2.3.4  # IP ban kaldır
fail2ban-client set sshd banip 1.2.3.4    # IP manuel banla`}</CodeBlock>
      </DocBlock>

      <DocBlock title="Sistem">
        <CodeBlock>{`vcgencmd measure_temp      # CPU sıcaklığı
df -h                      # Disk kullanımı
free -h                    # Bellek kullanımı
uptime                     # Çalışma süresi
journalctl -f              # Canlı log izleme`}</CodeBlock>
      </DocBlock>
    </div>
  );
}

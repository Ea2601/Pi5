import {
  BookOpen, ShieldBan, Zap, Flame, Globe, Server, ShieldAlert,
  Clock, Network, Route, ChevronDown, ChevronRight, Terminal,
  AlertTriangle, CheckCircle, Info, Cpu, Smartphone, Cloud, Bell, Timer, KeyRound, ShieldCheck
} from 'lucide-react';
import { useState } from 'react';
import { Panel, Badge } from './ui';
import { BRAND } from '../brand';

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
      id: 'remote',
      title: 'Uzaktan yönetim (CGNAT arkasından)',
      icon: <Smartphone size={15} />,
      badge: 'VPN',
      content: <RemoteAccessDoc />,
    },
    {
      id: 'fail2ban',
      title: 'Fail2Ban',
      icon: <ShieldAlert size={15} />,
      badge: 'Güvenlik',
      content: <Fail2banDoc />,
    },
    {
      id: 'templates',
      title: 'Koruma Şablonları',
      icon: <ShieldCheck size={15} />,
      badge: 'Güvenlik',
      content: <TemplatesDoc />,
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
      id: 'notify',
      title: 'Dış Bildirimler',
      icon: <Bell size={15} />,
      content: <NotifyDoc />,
    },
    {
      id: 'sqm',
      title: 'Akıllı Kuyruk (Gecikme)',
      icon: <Timer size={15} />,
      badge: 'SQM',
      content: <SqmDoc />,
    },
    {
      id: 'cron',
      title: 'Cron & Bakım',
      icon: <Clock size={15} />,
      content: <CronDoc />,
    },
    {
      id: 'vault',
      title: 'Bulut Yedeği',
      icon: <Cloud size={15} />,
      badge: 'Yedek',
      content: <VaultDoc />,
    },
    {
      id: 'license',
      title: 'Lisans',
      icon: <KeyRound size={15} />,
      content: <LicenseDoc />,
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
        subtitle={`${BRAND.fullName} — Tüm servis ve ayarların detaylı açıklamaları`}>
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
      <h3>{BRAND.fullName} — Genel Bakış</h3>
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
        <CodeBlock>{`İstemci → Pi (ev ağı kartı) → Pi-hole DNS (port 53)
                          → Unbound (port 5335) → Root DNS
                          → nftables (filtreleme)
                          → Zapret (DPI bypass) / WireGuard (VPS tünelleri wg_vps*)
                          → İnternet (modem; ya da isteğe bağlı internet kartı)`}</CodeBlock>
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
            <tr><td>Platform</td><td>Raspberry Pi 5 / 4 / 3, Pi Zero 2 W (USB Ethernet adaptörüyle) ya da NetworkManager'lı x86_64 Debian</td></tr>
            <tr><td>İşletim Sistemi</td><td>Debian 13 (trixie) / Raspberry Pi OS</td></tr>
            <tr><td>Depolama</td><td>microSD kart ya da SSD; isteğe bağlı veri diski (NVMe / USB)</td></tr>
            <tr><td>Ağ Düzeni</td><td>Tek bacaklı: ev ağı kartı (kablolu) hem modem tarafı adresini hem cihazların ağ geçidi adresini taşır; isteğe bağlı internet kartı (WAN router rolü)</td></tr>
            <tr><td>Ağ Arayüzleri</td><td>Kart adları cihaza göre değişir (eth0, end0, enp1s0 …); rol verilirken algılanır ve kaydedilir. VPS tünelleri wg_vps*, ev VPN'i wg_pi</td></tr>
          </tbody>
        </table>
        <p>
          <strong>Bellek sınıfı otomatik:</strong> kurulum ve panel belleği 512 MB, 1 GB, 2 GB … sınıflarından birine koyar
          (Cihaz Rolleri sayfasında görünür). 512 MB sınıfında (Pi Zero 2 W, Pi 3A+) HDMI ekranı (kiosk) açılmaz ve X11 /
          Chromium kurulmaz; Unbound için küçük önbellek önerilir. 1 GB sınıfı ve altında panel cihazda derlenmez: kurulum ve
          güncelleme, GitHub'ın aynı commit için derlediği <strong>hazır paketi</strong> indirir (özet bozuk indirmeyi, içerik
          denetimi başka commit'in paketini yakalar; paketin kendisi GitHub Actions'a ve depoda sürüm yayımlayabilenlere
          güvenir; Ayarlar → Sistem Güncellemesi → Güncelleme Yöntemi ile değiştirilir). 1 GB sınıfında HDMI ekranı yalnız uyarıyla
          açılır. 1 GB sınıfı ve altında takas alanı hiç yoksa ve işletim sisteminin takas yöneticisi de yoksa (Raspberry Pi
          OS'ta rpi-swap vardır) kurulum / güncelleme sırasında zram açılır; kapatmak için <code>/etc/pi5-gateway/zram.off</code> dosyası. Elle seçmek
          için: <code>/etc/pi5-gateway/profile</code> dosyasına <code>profile=lite</code> ya da <code>profile=standard</code>.
        </p>
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
            <tr><td><strong>DHCP</strong></td><td>Ayrı sayfada (menü → DHCP Ayarları): Pi'nin DHCP sunucusu, IP havuzu, ağ geçidi, kira süresi ve modemden geçiş sihirbazı</td></tr>
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

      <DocBlock title="Kurallar ve ayarlar">
        <p><strong>Özel kurallar:</strong> sırayla ve sabit izinlerden (SSH, DNS, panel) ÖNCE değerlendirilir — "düşür" kuralı gerçekten engeller. Kaynak IP kuralında port boşsa cihazın Pi'ye tüm erişimi (DNS dahil), doluysa yalnız o port etkilenir. Panele eriştiğiniz cihazı dışarıda bırakan kural kabul edilmez.</p>
        <p><strong>Uygulama:</strong> kurallar önce sınanır (<code>nft -c</code>), sonra yüklenir ve kaydedilir; sınamadan geçmezse hiçbir şey değişmez. Kurallar sekmesindeki önizleme yüklenecek gerçek kurallardır.</p>
        <p><strong>Politika ve NAT:</strong> gelen ve iletilen trafik varsayılan olarak düşürülür; adres çevirisi ağ düzenine göre (tek bacak, internet kartı, Wi-Fi köprüsü) kendiliğinden kurulur.</p>
        <p><strong>Arayüzler:</strong> LAN/WAN ataması yalnız iki kartlı eski düzende kullanılır.</p>
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

      <DocBlock title="Hazır yapılandırmayla bağlanma">
        <p>VPN sağlayıcınızın (Mullvad, Proton …), başkasının ya da şirketinizin WireGuard sunucusu için sunucuya bir şey kurulmaz:
          WireGuard → Sunucular → <strong>Config ile bağlan</strong>'da sağlayıcının verdiği <code>.conf</code> içeriği yapıştırılır ya da
          dosyadan yüklenir. Tünel bir VPS gibi kart olarak görünür ve Routing'de çıkış olarak seçilir; "tünel düşerse" seçimi, durum
          uyarıları ve açılışta yeniden bağlanma aynı şekilde çalışır.</p>
        <table className="doc-table">
          <thead><tr><th>Yapılandırmada</th><th>Pi'de</th></tr></thead>
          <tbody>
            <tr><td>AllowedIPs = 0.0.0.0/0</td><td>Pi'nin trafiği tünele kendiliğinden verilmez; hangi trafiğin çıkacağını Routing kuralları seçer</td></tr>
            <tr><td>Yalnız bazı aralıklar (ör. şirket ağı)</td><td>Bölünmüş tünel: yalnız o aralıklara giden trafik bu tünelden çıkabilir</td></tr>
            <tr><td>DNS</td><td>Uygulanmaz — Pi'nin DNS'i (Pi-hole) değişmez</td></tr>
            <tr><td>PreUp / PostUp / PreDown / PostDown</td><td>Uygulanmaz — Pi'de komut çalıştırılmaz</td></tr>
            <tr><td>Address (ör. /24)</td><td>İlk IPv4 adres /32 olarak; ev ağıyla çakışan adres reddedilir</td></tr>
            <tr><td>IPv6 adres ve aralıklar</td><td>Uygulanmaz (yönlendirme IPv4)</td></tr>
            <tr><td>PersistentKeepalive</td><td>25 sn (tünel durumu el sıkışmayla ölçülür)</td></tr>
          </tbody>
        </table>
        <p>Sunucu panelin olmadığı için bu tünellerden Pi'ye ve ev ağına <strong>yeni bağlantı açılamaz</strong> (giden trafik ve yanıtları
          geçer); kendi VPS'lerinizin tünellerinde bu kısıt yoktur. İstemci (QR), SSH denetimi ve otomatik onarım yalnız kendi
          VPS'lerinizdedir. Sağlayıcıda sunucu değişince kartta <strong>Yapılandırmayı değiştir</strong> ile yenisi yapıştırılır, tünele
          yönlenen kurallar korunur. Tek sunuculu (<code>[Peer]</code>) standart WireGuard yapılandırması gerekir; AmneziaWG desteklenmez.</p>
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

// Uzaktan yönetim (backend remoteAccess.ts): kendi VPS'inizin VPN istemcileriyle panele ev dışından erişim.
function RemoteAccessDoc() {
  return (
    <div className="doc-page">
      <h3>Uzaktan yönetim (CGNAT arkasından)</h3>
      <p>Ev hattı operatörün paylaşımlı IP'sinin (CGNAT) arkasındaysa — ya da arka arkaya iki modemden birinin (ör. operatör
        modemi) port yönlendirmesine erişemiyorsanız — dışarıdan eve bağlanılamaz ve Ev VPN'i çalışmaz. Pi zaten kendi VPS'inize
        dışarı doğru bir WireGuard tüneli kurduğu için panel bu tünelden açılabilir: telefonunuz ya da dizüstünüz aynı VPS'e VPN
        istemcisi olarak bağlanır, panel <code>http://10.66.66.2</code> adresinde açılır. (Eve dışarıdan ulaşılabiliyorsa Ev
        VPN'inin yönetici cihazları paneli zaten açar; bu yol Ev VPN'i olmadan da çalışır.)</p>

      <DocBlock title="Nasıl çalışır">
        <table className="doc-table">
          <tbody>
            <tr><td>İstek</td><td>Telefon (VPS istemcisi, 10.66.66.X) → VPS (wg0) → Pi (wg_vps tüneli, 10.66.66.2) → panel</td></tr>
            <tr><td>Yanıt</td><td>Pi → yalnız işaretli istemcinin /32 dönüş rotası → aynı tünel → VPS → telefon</td></tr>
          </tbody>
        </table>
        <p>Açmak: WireGuard → VPS kartı → İstemciler → istemcinin altındaki <strong>Panel erişimi (yönetici)</strong> anahtarı
          (ya da Client Yönetimi kartı). Telefon VPS'e bağlıyken tarayıcıda <code>http://10.66.66.2</code> açılır.</p>
      </DocBlock>

      <DocBlock title="Kim neye ulaşır">
        <table className="doc-table">
          <thead><tr><th>Kim</th><th>Ulaştığı yer</th></tr></thead>
          <tbody>
            <tr><td>Panel erişimi açık istemci</td><td>Panel (şifreyle, 80), Pi'nin SSH'ı (22), DNS'i (53) ve ping. Pi'deki diğer
              hizmetlere (ağ paylaşımı vb.) ve ev ağındaki cihazlara ulaşmaz — süzgeç düşürür; panelin güvenlik duvarı kurulu
              olmasa da.</td></tr>
            <tr><td>Diğer VPS istemcileri</td><td>Pi'ye yeni bağlantı açamaz (süzgeç düşürür); internete VPS üzerinden çıkmaya devam eder.</td></tr>
            <tr><td>VPS'in kendisi (yöneticisi / sağlayıcısı)</td><td>Kendi adresiyle Pi'ye bağlantı açamaz. Ama VPS'te tam yetkisi olan
              biri panel erişimi açık bir cihazın adresini kullanabilir ve tünelden geçen panel trafiğini — panel bu yolda şifrelenmemiş
              HTTP olduğu için panel şifresi dahil — görebilir. Bu yüzden yalnız kendi yönettiğiniz VPS'te açın.</td></tr>
            <tr><td>Ev ağındaki cihazlar</td><td>Değişmez. Panel erişimi açık istemciye ev ağından bağlantı açılamaz (iki yönde de).</td></tr>
            <tr><td>İnternet</td><td>Panel internete açılmaz: alan adı, sertifika, açık port, ters vekil yoktur.</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Koşullar ve sınırlar">
        <p><strong>Panel şifresi zorunlu:</strong> panel koruması kalıcı açık değilse anahtar açılmaz; koruma sonradan kapatılırsa
          erişim 30 sn içinde geri çekilir, koruma açılınca kendiliğinden döner. Tünelden açılan panel de evdeki gibi şifre ister.</p>
        <p><strong>Tek VPS:</strong> istemci adresleri VPS başına numaralanır (10.66.66.3 iki VPS'te ayrı cihazdır); panel erişimi
          aynı anda yalnız bir VPS'in istemcilerinde açık olabilir.</p>
        <p><strong>Tünel gerekir:</strong> Pi ↔ VPS tüneli kapalıyken panele uzaktan ulaşılamaz; tünel yeniden kurulunca dönüş rotası
          en geç 30 sn içinde geri gelir.</p>
        <p><strong>Ev ağı çakışması:</strong> ev ağınız (ya da Pi'nin VPS tüneli dışındaki herhangi bir kartının ağı) 10.66.66.0/24
          ile çakışıyorsa özellik açılmaz; sonradan çakışırsa erişim durdurulur (Bildirimler'e yazılır) ve çakışma kalkınca döner.</p>
        <p><strong>Uzaktayken dikkat:</strong> panel tünelden açıkken 'Tüneli kes', VPS'i silmek ya da kullandığınız cihazın
          erişimini kapatmak / istemcisini silmek bağlantınızı keser — panel önce sorar. Kesilen tünel kendiliğinden geri gelmez,
          ancak ev ağından yeniden bağlanır.</p>
      </DocBlock>

      <DocTip type="warning">Panel erişimini yalnız kendi cihazlarınızda ve kendi yönettiğiniz VPS'te açın: cihaz Pi'nin SSH ve
        DNS'ine de ulaşır; VPS'i yöneten panel trafiğini görebilir. Panel şifresini başka yerde kullanmayın, işiniz bitince anahtarı
        kapatın. Telefon kaybolursa istemciyi WireGuard sayfasından silin — VPS'ten de kaldırılır.</DocTip>
      <DocTip>Özellik kapalıyken (hiçbir istemcide açık değilken) Pi'de hiçbir rota ya da kural eklenmez.</DocTip>
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
          <thead><tr><th lang="en">Jail</th><th>Koruduğu Servis</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td><strong>sshd</strong></td><td>SSH</td><td>Başarısız SSH giriş denemelerini izler (sistem günlüğünden)</td></tr>
            <tr><td><strong>recidive</strong></td><td>Tüm portlar</td><td>1 günde 5 kez yasaklanan adresi 1 hafta tüm portlardan engeller (Ayarlar'dan kapatılabilir)</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Ayarlar (Fail2Ban → Ayarlar)">
        <p>Ayarlar Fail2Ban'a gerçekten uygulanır: <code>/etc/fail2ban/jail.d/klyrix-panel.local</code> yazılır, sınanır ve Fail2Ban yeniden yüklenir; sınamadan geçmezse eski ayarlar kalır. <code>jail.local</code>'e dokunulmaz.</p>
        <p><strong>SSH deneme hakkı / yasak süresi:</strong> varsayılan 3 hatalı giriş → 2 saat.</p>
        <p><strong>Hata penceresi:</strong> denemelerin sayıldığı süre (varsayılan 10 dk).</p>
        <p><strong>Ev ağı muaf:</strong> Pi'nin ev ağı, kurulum Wi-Fi'ı ve yerel adresler yasaklanmaz — evdeki bir cihazdan yanlış şifre SSH'ı kilitlemez. Ev ağı değişirse liste kendiliğinden güncellenir.</p>
        <p><strong>Ek muaf adresler:</strong> ev dışında güvendiğiniz adresler.</p>
      </DocBlock>

      <DocTip type="info">Yasaklı bir adresi Genel Bakış'taki jail satırından "Yasağı kaldır" ile hemen açabilirsiniz.</DocTip>
    </div>
  );
}

function RoutingDoc() {
  return (
    <div className="doc-page">
      <h3>Trafik Yönlendirme</h3>
      <p>Composable (birleştirilebilir) yönlendirme sistemi. Her kural iki bağımsız ayardan oluşur: çıkış noktası ve DPI bypass.</p>

      <DocBlock title="Sistem Bileşenleri">
        <table className="doc-table">
          <thead><tr><th>Bileşen</th><th>Durum</th><th>Açıklama</th></tr></thead>
          <tbody>
            <tr><td><Badge variant="success"><span lang="en">Pi-hole</span></Badge></td><td>Her zaman aktif (global)</td><td>DNS seviyesinde reklam ve izleyici engelleme — tüm trafiğe uygulanır</td></tr>
            <tr><td><Badge variant="neutral">Çıkış Noktası</Badge></td><td>ISP veya VPS</td><td>Trafiğin internete hangi yoldan çıkacağı. Birden fazla VPS sunucusu desteklenir</td></tr>
            <tr><td><Badge variant="warning">DPI Bypass</Badge></td><td>Bağımsız açılıp kapatılabilir</td><td>Zapret ile DPI atlatma — herhangi bir çıkış noktasıyla birlikte kullanılabilir</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Örnek Kombinasyonlar">
        <table className="doc-table">
          <thead><tr><th>Çıkış</th><th>DPI</th><th>Sonuç</th><th>Kullanım Senaryosu</th></tr></thead>
          <tbody>
            <tr><td><Badge variant="neutral">ISP</Badge></td><td>Kapalı</td><td>Direkt ISP çıkışı</td><td>Engelsiz servisler, düşük gecikme</td></tr>
            <tr><td><Badge variant="warning">ISP + DPI</Badge></td><td>Açık</td><td>ISP + Zapret DPI bypass</td><td>DPI ile engellenen siteler (VPN gereksiz)</td></tr>
            <tr><td><Badge variant="info">VPS Frankfurt</Badge></td><td>Kapalı</td><td>VPN tüneli üzerinden</td><td>Coğrafi engel aşma, gizlilik</td></tr>
            <tr><td><Badge variant="error">VPS Frankfurt + DPI</Badge></td><td>Açık</td><td>VPN + DPI bypass</td><td>Maksimum engel aşma</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Önemli Notlar">
        <p><strong>Pi-hole:</strong> Tüm trafik Pi-hole üzerinden geçer — ayrıca açıp kapatmaya gerek yoktur.</p>
        <p><strong>Çıkış noktası:</strong> Her kural veya cihaz için bağımsız olarak ISP veya herhangi bir VPS sunucusu seçilebilir.</p>
        <p><strong>DPI Bypass:</strong> Çıkış noktasından bağımsız olarak etkinleştirilebilir. ISP ile kullanıldığında direkt bağlantıda DPI atlatma, VPS ile kullanıldığında tünel üzerinde DPI atlatma sağlar.</p>
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
            <tr><td>Ev ağı kartı (kablolu)</td><td>Tek bacaklı: modem tarafı adres + cihazların ağ geçidi (aynı kart)</td><td>Modem ağı (ör. 192.168.1.0/24) + cihaz ağı (ör. 192.168.0.0/24)</td></tr>
            <tr><td>İnternet kartı (isteğe bağlı)</td><td>WAN router rolü: internet bu karttan (DHCP / sabit / PPPoE, VLAN)</td><td>Operatör / modem</td></tr>
            <tr><td>wg_vps*</td><td>VPS tünelleri (yönlendirme profilleri)</td><td>10.66.66.0/24</td></tr>
            <tr><td>wg_pi</td><td>Ev VPN'i (dışarıdan eve bağlanma)</td><td>10.77.77.0/24</td></tr>
          </tbody>
        </table>
      </DocBlock>
    </div>
  );
}

function LicenseDoc() {
  return (
    <div className="doc-page">
      <h3>Lisans</h3>
      <p>Altyapı → Lisans: imzalı bir lisans anahtarını (KLX1. ile başlar) çevrimdışı doğrular. Şu an tüm özellikler herkese açıktır
        (Topluluk); ücretli katmanlar sonra belirlenecek. Lisans olmadan, süresi bitince ya da kaldırılınca hiçbir özellik kapanmaz ve
        çalışan hiçbir şey kesilmez.</p>

      <DocBlock title="Etkinleştirme (çevrimdışı)">
        <ul>
          <li>Sayfadaki 32 haneli <strong>cihaz kodu</strong>nu kopyalayın; anahtarı aldığınız yere verin. Kod, Pi'nin seri numarasından
            türetilen bir özettir; seri numarasının kendisi panelde gösterilmez. Seri numarası kısa ya da tahmin edilebilir olan
            cihazlarda (ör. eski Pi modelleri) koddan seri numarası bulunabilir — kodu yalnız anahtarı aldığınız yerle paylaşın.</li>
          <li>Aldığınız anahtarı yapıştırıp <strong>Etkinleştir</strong>'e basın. İmza, cihaz kodu ve süre Pi'de denetlenir; geçersizse
            kaydedilmez. Anahtar /etc/pi5-gateway/license dosyasında yalnız root'un okuyabildiği biçimde durur; panel ayarlarına ve
            yedeğe girmez, ekranda maskeli görünür.</li>
          <li>Pi hiçbir lisans sunucusuna bağlanmaz ve hiçbir şey göndermez. Yenileme yeni anahtarı yapıştırarak yapılır; bitime 14 ve
            3 gün kala Bildirimler'e yazılır.</li>
          <li><strong>Kaldır</strong> anahtarı siler ve Topluluk sürümüne döner. Uydu cihazlarda lisans yalnız gösterilir; ana cihazda
            yönetilir.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Saat">
        <p>Pi'de pil destekli saat yoktur. Saat eşitliyken (NTP) süre gerçek saate göre değerlendirilir ve o an
          /etc/pi5-gateway/license.seen dosyasına yazılır. Saat eşitli değilken (ör. açılışta, internet yokken) şimdiki saatle son
          görülen zamanın büyüğü kullanılır; saati geri almak süreyi uzatmaz.</p>
      </DocBlock>

      <DocTip type="info">
        Dürüst sınır: Klyrix Gate'in kaynağı açıktır ve cihazda yönetici (root) sizsiniz. Lisans denetimi kırılmaz bir koruma değildir;
        kod değiştirilerek atlanabilir. Amacı dürüst kullanıcıyı doğru katmana yönlendirmektir.
      </DocTip>
    </div>
  );
}

function TemplatesDoc() {
  return (
    <div className="doc-page">
      <h3>Koruma Şablonları ve güvenli arama</h3>
      <p>Koruma Şablonları sayfası hazır koruma demetleri sunar. Şablon yeni bir engelleme motoru değildir: Ebeveyn Kontrol kuralını, tüm ağda
        şifreli DNS engelini ve güvenli aramayı sizin için birlikte kurar. Sıra her zaman aynı: seç → <strong>Önizle</strong> (hiçbir şey
        değişmez, yapılacaklar listelenir) → <strong>Uygula</strong>. Bunlar uyuma yardımcı kontrollerdir; panel bir mevzuata ya da
        standarda «uyumlu» olduğunu söylemez.</p>

      <DocBlock title="Okul / Aile">
        <ul>
          <li><strong>Hedef:</strong> tüm ağ (Pi-hole'u DNS olarak kullanan, Pi-hole'un Default grubundaki her cihaz) ya da seçili cihazlar ve
            Cihaz Yönetimi grupları. Tüm ağda yalnız «her zaman» engeli vardır; saat aralığı yalnız cihaz / grup hedefinde.</li>
          <li><strong>Kategoriler:</strong> Yetişkin içerik ve Kumar (StevenBlack hazır listeleri) varsayılan; sosyal medya ve oyun isteğe bağlı,
            her zaman ya da bir saat aralığında (ör. hafta içi 08:00–16:00).</li>
          <li><strong>Güvenli arama</strong> (varsayılan açık) ve <strong>tüm ağda şifreli DNS engeli</strong> (isteğe bağlı, varsayılan kapalı —
            Android'de «Özel DNS» sabitlenmiş telefonların internetini keser).</li>
          <li>Oluşan kurallar Ebeveyn Kontrol sayfasında «Koruma Şablonları oluşturdu» notuyla görünür.</li>
          <li>Tüm ağ kuralının güvenlik duvarı kuralı yoktur: kendi DNS'ini (ör. 8.8.8.8) ya da şifreli DNS kullanan cihaz onu atlatır — tüm ağda
            şifreli DNS engeli bunu kapatır (yalnız IPv4). Cihaz / grup hedefinde seçilen cihazların dış DNS'i ve bilinen DoH sunucuları kuralla kesilir.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Geri al">
        <p>Uygulanmış şablonun kartındaki <strong>Geri al</strong> yalnız şablonun kurduklarını kaldırır: eklediği kurallar silinir, açtığı
          ayarlar önceki değerine döner (güvenli arama kapanır, 09 dosyası silinir; şifreli DNS engeli kapanır). Sonradan değiştirdiğiniz kural
          ya da ayar <strong>silinmez</strong> — sıradan bir kural olarak kalır ve size söylenir. Eski bir yedekten geri yüklemede şablonun
          kuralı yoksa şablon «bozuk» görünür; Geri al kalanları temizler, aynı numaralı başka bir kurala dokunmaz.</p>
      </DocBlock>

      <DocBlock title="Güvenli arama (SafeSearch)">
        <p>Google (Güvenli Arama), YouTube (Sıkı kısıtlı mod), Bing ve DuckDuckGo'nun adları Pi-hole'da sağlayıcının kısıtlı sunucusunun adresine
          yerel kayıt olur (<code>/etc/dnsmasq.d/09-pi5-safesearch.conf</code>, <code>host-record</code>). CNAME bilerek kullanılmaz: aynı ad için
          sonradan eklenen bir Pi-hole CNAME'i DNS'i düşürmez, sizin kaydınız kazanır. Kullanıcı tarayıcıda kapatamaz. Tüm ağ içindir.</p>
        <ul>
          <li>Açma / kapama / sağlayıcı değişikliği hemen uygulanır: Pi-hole bir kez yeniden başlar (DNS birkaç saniye kesilir). Kapatınca 09
            silinir; /etc/dnsmasq.d okumasını güvenli arama açtırdıysa ve orada yüklenecek başka satır yoksa o da geri kapatılır.</li>
          <li>Sağlayıcı adresleri 6 saatte bir Unbound'dan yeniden çözülür. Değişirse dosya yalnız gece 03–06'da yazılır; gündüz son geçerli
            adres kullanılır. Çözülemezse son geçerli kayıt korunur ve Bildirimler'e uyarı düşer.</li>
          <li>Aynı ad için başka bir kayıt ya da yönlendirme varsa o ad atlanır ve listelenir — sizin kaydınız geçerli kalır: Routing → alan adı
            yönlendirmesi ya da VPS / DPI çıkışı (yerel yanıt yönlendirme setine girmez, trafik VPS / Zapret yerine operatörden çıkardı), Pi-hole
            Yerel DNS / CNAME kaydı, /etc/hosts, /etc/dnsmasq.d'deki başka bir dosya. Yeni eklenen kayıt en geç 30 dakikada, gece beklenmeden
            uygulanır (tek yeniden başlatma); kaldırılan kaydın adı gece ya da «Şimdi uygula» ile geri gelir.</li>
          <li>Yeniden başlatmadan sonra DNS yanıt vermezse güvenlik ağı dosyayı boşaltır ve güvenli arama <strong>askıya alınır</strong>: kayıtlar
            ne gece ne başka bir DNS yenilemesinde yeniden yazılır (aynı kesinti tekrarlanmasın). Kartta «Şimdi uygula» ile yeniden denenir.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Bu panelin karşılamadığı denetimler">
        <p>Şablonlar bu yüzden «uyumlu» değil, «uyuma yardımcı» diye anılır:</p>
        <ul>
          <li>Tek ortak yönetici hesabı (kişi başına hesap ve yetki yok).</li>
          <li>Panel yalnız HTTP (80) üzerinden sunulur — TLS (HTTPS) yok.</li>
          <li>İki aşamalı doğrulama (MFA) yok.</li>
          <li>Olay geçmişi 30 gün tutulur.</li>
          <li>Panel koruması (şifre) kurulumda kapalı gelir — panelin üst bandından açılır.</li>
        </ul>
      </DocBlock>

      <DocTip type="warning">
        Atlatılabilir: şifreli DNS (DoH / DoT) kullanan, Pi-hole'u kullanmayan ya da IPv6 üzerinden başka bir DNS alan cihaz. Tüm ağda şifreli
        DNS engeli bunu büyük ölçüde kapatır (yalnız IPv4). Gizli (rastgele) Wi-Fi adresi kullanan telefon cihaz hedefli kurala girmeyebilir.
        Acil durumda SSH: <code>sudo rm /etc/dnsmasq.d/09-pi5-safesearch.conf &amp;&amp; sudo systemctl restart pihole-FTL</code> — bu komut
        geçicidir: ayar açık kaldığı için dosya gece 03–06'da ya da sonraki DNS yenilemesinde yeniden yazılır. Kalıcı kapatmak için ardından
        panelde Koruma Şablonları → Güvenli arama → <strong>Kapat</strong> (ya da şablonu Geri al).
      </DocTip>
    </div>
  );
}

function NotifyDoc() {
  return (
    <div className="doc-page">
      <h3>Dış Bildirimler (Telegram / Discord / webhook)</h3>
      <p>Bildirimler → Dış kanallar: uyarıları yalnız sizin açtığınız kanala gönderir — varsayılan kapalı. Kanal yokken hiçbir şey dışarı
        gitmez; Klyrix'e hiçbir zaman bir şey gönderilmez.</p>

      <DocBlock title="Kanal ekleme">
        <ul>
          <li><strong>Telegram:</strong> @BotFather ile bot kurun, token'ı ve sohbet kimliğini girin (botunuza önce bir mesaj yazın).</li>
          <li><strong>Discord:</strong> kanalın webhook adresi. Mesajlar kimseyi etiketlemez (@everyone dahil).</li>
          <li><strong>Webhook:</strong> kendi adresiniz; JSON gövde (<code>v, device, alertId, severity, source, sourceLabel, message, createdAt</code>),
            isteğe bağlı <code>X-Klyrix-Signature</code> (HMAC-SHA256). İnternetteki adres yalnız https; ev ağındaki hedef (Home Assistant) açık onayla.</li>
        </ul>
        <p>Sihirbaz sırası: tür → bilgiler → "Test mesajı gönder" → "Kaydet ve aç". Test başarılı olmadan kaydedilmez. Token ve adresler
          /etc/pi5-gateway/notify altında yalnız root'un okuyabildiği dosyada durur; panel ayarlarına, yedeğe ve günlüklere girmez.</p>
      </DocBlock>

      <DocBlock title="Ne gider">
        <ul>
          <li>Varsayılan: uyarı ve kritik kayıtlar + önemden bağımsız yeni cihaz, hat kalitesi (kesildi / geri geldi), yedek hat geçişi, yeni ağ kartı.
            Aynı ana hat olayı hem yedek hat geçişinden hem hat kalitesinden gelirse Telegram / Discord'a tek bildirim gider.</li>
          <li>5 dk'lık tek ping denetimi ("İnternet") varsayılan gönderilmez; kaynak süzgecinden değiştirilebilir.</li>
          <li>Kanal açılınca yalnız yeni kayıtlar gider (geçmiş gönderilmez). Aynı tür kayıt 10 dk'da bir; birikirse (20'den çok) tek özet.</li>
          <li>Kısa kip (varsayılan): ne olduğu yazar, cihaz adı / IP / MAC yazmaz — ayrıntı panelde. Tam metin kipinde kayıt olduğu gibi gider.</li>
          <li>Sessiz saatler (isteğe bağlı): aralıkta yalnız kritik gider, diğerleri bitince tek özet.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Yeni cihaz bildirimi">
        <p>Açıkken 60 sn'de bir komşu tablosu okunur; açarken bağlı cihazlar ve DHCP kirası süren (uyuyan) cihazlar bilinen sayılır. Pi DHCP
          dağıtmıyorsa, açarken kapalı olan ve cihaz listesinde hiç görünmemiş bir cihaz ilk bağlanışında bir kez "yeni" sayılabilir. Yeni cihaz bir dakika sonra (DHCP adıyla)
          Bildirimler'e yazılır; otomatik engel yoktur. Gizli (rastgele) Wi-Fi adresli cihazlar etiketlenir ya da isteğe göre bildirilmez.
          Ev VPN istemcileri komşu tablosunda görünmediği için kapsam dışıdır.</p>
      </DocBlock>

      <DocTip type="warning">
        "Ana hat kesildi" bildirimi kopuk hattan gönderilemez: yedek hat açıksa hemen yedek hattan gider, yoksa hat dönünce "geri geldi"
        bildirimi gelir. Bildirim Pi'nin kendi bağlantısından çıkar (Telegram / Discord'u VPS'e yönlendirdiyseniz tünelden).
      </DocTip>
    </div>
  );
}

function SqmDoc() {
  return (
    <div className="doc-page">
      <h3>Akıllı Kuyruk (SQM: CAKE)</h3>
      <p>Bant Genişliği → Gecikme (Akıllı Kuyruk) — varsayılan kapalı. Biri büyük bir dosya indirirken ya da yüklerken (yedek, video
        gönderme) oyunda, görüntülü görüşmede ping'in yüzlerce ms'ye fırlamasına <em>bufferbloat</em> denir: paketler modemin /
        operatörün büyük tamponunda bekler. Akıllı kuyruk hattı ölçülen hızın biraz altında Pi'de kuyruklar; kuyruk Pi'de oluştuğu
        için CAKE gecikmeyi düşük tutar ve hattı cihazlar arasında adil paylaştırır (bir cihazın indirmesi diğerlerini boğmaz).</p>

      <DocBlock title="Nasıl açılır">
        <ol>
          <li><strong>Hat ve ön koşullar:</strong> internet arayüzü ve çekirdek modülleri (sch_cake, ifb, act_mirred, cls_matchall, sch_ingress; tek bacakta
            ayrıca sch_prio, cls_flower, sch_fq_codel) denetlenir.</li>
          <li><strong>Bant:</strong> elle girin (hız testindeki değerin %90–95'i iyi bir başlangıçtır) ya da "Ölç" (Ookla) — hattın gerçek
            hızının %90'ı önerilir: hız testi yalnız veriyi sayar, kuyruk paket başlıklarını da sayar; öneri bunu hesaba katar, sonuçta
            ölçülen hızın ~%90'ı kullanılır. Ölçüm boyunca kuyruk geçici kaldırılır, evde 30–60 sn gecikme artabilir; ana hat yedek
            hattayken ölçülmez (yedek hat kendi bölümünde ölçülür). Bağlantı türü paket başına ek yükü belirler: Ethernet / fiber (önerilen), kablo internet (DOCSIS), VDSL, ADSL; VLAN
            (+4 bayt) ve PPPoE (+8 bayt) hattan kendiliğinden eklenir (tek portta VLAN payı ihtiyatlıdır: etiket çoğu zaman yalnız Pi ile
            anahtar arasındadır — ~%0,3 fazla sayar, zararsız).</li>
          <li><strong>Dene (5 dk):</strong> kuyruk takılır; 5 dk içinde "Kalıcı yap"a basılmazsa Pi'deki zamanlayıcı kuyruğu kendiliğinden
            kaldırır — panel kapansa da. "Kalıcı yap" ev ağındaki bir cihazdan kabul edilir (Pi'nin kendi ekranından değil).</li>
        </ol>
      </DocBlock>

      <DocBlock title="Neyi çözer, neyi çözmez">
        <ul>
          <li><strong>Çözer:</strong> hat doluyken gecikmenin artması (hedef: doygun indirme / yüklemede ping artışı kablolu hatta ~15 ms'nin altında),
            tek cihazın tüm hattı kaplaması (adalet cihaz başınadır; öncelik sınıfı / DSCP işareti kullanılmaz — tüm trafik tek sınıf).</li>
          <li><strong>Bedeli:</strong> hızın %5–15'i feda edilir (bant ölçülen hızın altında ayarlanır). Hız testi kuyruk açıkken ayarlanan
            bandı gösterir — geçmişte "kısılmış" işaretlidir; otomatik ölçüm kuyruğu kaldırmaz.</li>
          <li><strong>Çözmez:</strong> operatörün kendi gecikmesi ve kaybı, Wi-Fi'ın (ayrı erişim noktasının) kendi kuyruğu, uzak sunucu
            yavaşlığı. Hızı değişen hatlarda (4G, uydu) sabit bant ya israf ya yetersizdir. VPS tüneli kullanan cihazlar hatta tek akış görünür.</li>
          <li><strong>Hız:</strong> çok hızlı hatlarda (yüzlerce Mbps) Pi'nin işlemcisi yetmeyebilir — denemede "Kuyrukla hız testi"
            beklenenin (bant × paket verimi) %85'inin altındaysa bandı düşürün ya da kapatın. USB 2 portundaki kart ~300 Mbps ile sınırlıdır.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Hangi kurulumlarda">
        <ul>
          <li>Ayrı internet kartı (WAN router: DHCP, sabit, PPPoE, VLAN), tek port VLAN (kuyruk yalnız VLAN / PPPoE arayüzüne, ev ağı kartına asla),
            Wi-Fi ile internet (repeater A) ve Wi-Fi köprüsü (aynı ağ, repeater C).</li>
          <li>Tek bacaklı kurulum (modem ile ev ağı aynı kartta; Pi'nin sabit adresi kalıcı olmalı) ve ev Wi-Fi köprüsü (br0) — aşağıda.</li>
          <li>Yedek hat: kendi bandıyla (aşağıda).</li>
          <li>İnternet hattı değişirse (başka kart, PPPoE / VLAN değişti, modem değişti) kuyruk takılmaz ve uyarı çıkar: bandı yeniden ölçün.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Tek bacak ve ev Wi-Fi köprüsü (br0)">
        <ul>
          <li>Modem ile ev cihazları aynı kartta olduğu için kuyruk <strong>sınıflıdır</strong>: yalnız modemin MAC adresine giden (yükleme) ve ondan gelen
            (indirme) çerçeveler bant sınırına girer. Pi ile ev cihazları arasındaki trafik — panel, Samba / Time Machine, Syncthing, Pi-hole DNS,
            segmentler (VLAN etiketli) — kısıtsız ayrı bantta kalır; hızı değişmez.</li>
          <li>Ev Wi-Fi köprüsünde (br0) kuyruk köprünün modeme bakan portuna (modemin MAC'inin öğrenildiği kart, ör. eth0) takılır; br0'a ve Wi-Fi
            portuna takılmaz.</li>
          <li>Modemin MAC adresi Pi'nin komşu tablosundan okunur ve sayfada gösterilir. <strong>Öğrenilemezse hiçbir şey takılmaz</strong> (hat bugünkü
            gibi çalışır). Kuyruk takılıyken modem bir süre yanıt vermezse (ör. yedek hatta geçildi) takılı kuyruk korunur. Modem değişirse (yeni
            MAC) kuyruk kaldırılır, uyarı çıkar: bandı yeniden ölçüp kaydedin.</li>
          <li>Ağ geçidi olarak doğrudan modemi kullanan cihazlar (ör. modemin Wi-Fi'ına bağlı olanlar) Pi'den geçmediği için kuyruğa girmez.</li>
          <li><strong>IPv6:</strong> modem ev ağına IPv6 dağıtıyorsa (RA / SLAAC) cihazlar IPv6 trafiğini Pi'ye uğramadan doğrudan modeme gönderir — bu
            trafik kuyruğa girmez ve büyük bir IPv6 indirmesi gecikmeyi yine artırır (ev Wi-Fi köprüsünde yalnız modemle aynı anahtardaki kablolu
            cihazlar için). Sayfa bunu yoklar ve uyarır: modemde ev ağı IPv6'sını kapatın.</li>
          <li>Pi üzerinden modemin kendi hizmetlerine (modeme takılı USB disk, medya sunucusu) giden trafik internet bandında sayılır.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Yedek hat">
        <ul>
          <li>Yedek hat (USB modem / telefon, ikinci kart, hotspot) kendi bandıyla kuyruklanır: Bant Genişliği → Gecikme → "Yedek hat kuyruğu". Yedek
            profil hep bağlı olduğundan kuyruk önceden takılır; geçişte kuyruklara dokunulmaz, yalnız rota değişir.</li>
          <li>Bandı elle girin (4G'de kötü saatteki hızın biraz altı). "Ölç" yalnız yedek hattayken çalışır: Ookla Pi'nin o an kullandığı hattı ölçer.</li>
          <li>USB modemin adı her takışta değişebilir: kuyruk aynı modeme (sürücü ve USB kimliği: üretici / model / seri no) göre yeni arayüze
            kendiliğinden yeniden takılır. Başka bir yedek hat kurulursa — başka bir USB modem / telefon, başka bir hotspot (ağ adı) ya da kart — eski
            bant kullanılmaz, uyarı çıkar: bandı yeniden girin.</li>
          <li>Yedek hattayken ana hattın modemi yanıt vermese de (tek bacak) yedek hat bandı kaydedilip denenebilir: deneme yedek hat kuyruğunu sınar,
            ana hattın takılı kuyruğuna dokunulmaz.</li>
          <li>Akıllı kuyruk açıkken yedek hat bandını kaydetmek iki hat için 5 dk'lık yeni deneme başlatır. "Kaldır" yalnız yedek hat kuyruğunu kaldırır
            (deneme gerekmez).</li>
        </ul>
      </DocBlock>

      <DocBlock title="Canlı Pi'de ilk deneme (önerilen sıra)">
        <ol>
          <li>Sayfada hattı ve (tek bacakta) modemin MAC adresini doğrulayın; 1. adımda modüller "hazır" olmalı. Tek bacakta "Modem ev ağına
            IPv6 dağıtıyor" uyarısı varsa önce modemde ev ağı IPv6'sını kapatın (yoklama sayfa açıkken 10 dk'da bir yenilenir).</li>
          <li>"Ölç" ile bant önerisini alın, "Kaydet", sonra "Dene (5 dk)".</li>
          <li>Deneme sürerken: "Kuyrukla hız testi" (beklenenin %85'i üstü), bir cihazda büyük indirme + ping (artış birkaç ms olmalı; tek bacakta
            ping'i IPv4 ile atın — <code>ping -4</code> — ve cihazın IPv4 ile Pi üzerinden çıktığından emin olun), Pi'den bir dosyayı Samba ile
            kopyalayın ve panelin hızına bakın (kuyruktan önceki hızla aynı olmalı).</li>
          <li>Hepsi düzgünse ev ağındaki bir cihazdan "Kalıcı yap"; değilse "Geri al" ya da 5 dk bekleyin (Pi kendiliğinden geri alır).</li>
        </ol>
      </DocBlock>

      <DocTip type="info">
        Kapatma: panelde "Kapat" ya da SSH'tan <code>sudo bash /opt/pi5-gateway/scripts/sqm.sh off</code> — kuyruğu hemen kaldırır ve panel
        ayarını da kapatır (backend durmuşsa açılışta). (<code>sqm.sh clear</code> yalnız kuyruğu kaldırır: ayar açıksa 15 sn içinde geri
        takılır.) Yalnız akıllı kuyruğun kendi kuyrukları (kök ca1e: — tek bacakta altındaki ca11: / ca12: ile —, ca1f:, ifb-klx0 / ifb-klx1…,
        süzgeç 4910; giriş kuyruğu yalnız onu kendisi eklediyse) kaldırılır; cihaz hız sınırları ve kotalar etkilenmez. Ayar yedekten geri
        yüklenmez (hatta özgüdür): yeni cihazda bant yeniden ölçülür.
      </DocTip>
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

function VaultDoc() {
  return (
    <div className="doc-page">
      <h3>Bulut Yedeği</h3>
      <p>Yedekleme sayfasındaki «Bulut Yedeği», panel ayarlarınızı (isterseniz seçtiğiniz klasörleri de) <strong>kendi</strong> S3
        uyumlu depolama hesabınıza şifreli olarak yükler: Cloudflare R2, Backblaze B2, AWS S3 ya da MinIO gibi bir özel depo.
        Klyrix'in sunucusu yoktur; hesabınızı, anahtarlarınızı ve yedeklerinizi görmez. Bağlamadığınız sürece cihazdan hiçbir
        şey çıkmaz.</p>

      <DocBlock title="Ne yedeklenir">
        <table className="doc-table">
          <tbody>
            <tr><td>Ayarlar (her gün)</td><td>İndirilen yedek dosyasının aynısı: servis ayarları, yönlendirme ve güvenlik duvarı kuralları, listeler, cihaz kuralları, Cron görevleri, statik DHCP kayıtları + panel sürümü ve cihaz bilgisi</td></tr>
            <tr><td>Klasörler (isteğe bağlı)</td><td>Paylaşım alanı, ağda paylaşılan USB diskler, ev dizinleri ve /srv altından seçtikleriniz. Sistem klasörleri ve eski sistem arşivleri seçilemez; ev dizinindeki bir eski sistem arşivinin etc / root / opt klasörleri yedeğe girmez</td></tr>
            <tr><td>Gizli anahtarlar (varsayılan kapalı)</td><td>VPS SSH bilgileri ve tünel anahtarları, VPN istemcileri, Ev VPN'i anahtarları, DDNS anahtarları — yalnız ayarlardan açarsanız. Sonradan kapatırsanız önceki anlık görüntülerde saklama süresi dolana kadar kalırlar</td></tr>
          </tbody>
        </table>
      </DocBlock>

      <DocBlock title="Şifreleme ve anahtarlar">
        <p>Yedekler <strong>restic</strong> ile cihazda şifrelenir (AES-256), sonra yüklenir; depo sağlayıcısı içeriği göremez.
          Bağlanırken yazdığınız parola cihazda saklanmaz: cihaz depoya rastgele bir cihaz anahtarıyla erişir. Bulut deposunun
          erişim anahtarı ve cihaz anahtarı cihazda yalnız root'un okuyabileceği dosyalardadır — cihaz (SD kart) ele geçirilirse
          yedekler okunabilir ya da silinebilir, bu yüzden yalnız o kovaya yetkili bir erişim anahtarı kullanın. Anlık görüntüler
          sürümlüdür (günlük / haftalık / aylık saklama); silinen ya da bozulan bir dosyanın eski hâli geri alınabilir.</p>
        <DocTip type="warning">Kurtarma için <strong>kurtarma kiti + parola</strong> birlikte gerekir. Bağlanırken gösterilen kiti ve
          parolanızı güvenli bir yerde saklayın: parolayı kaybederseniz yedekler hiç kimse tarafından açılamaz.</DocTip>
      </DocBlock>

      <DocBlock title="Zamanlama ve trafik">
        <p>Yedek her gün seçtiğiniz saatte (varsayılan 04:30) alınır; cihaz kapalıysa açılışta, saat internetten eşitlenince
          yakalanır. Geçici bir sorunda (internet yok, depoya ulaşılamadı) aynı gün yarım saat arayla üç kez daha denenir. Yükleme
          sınırı koyabilirsiniz (son hız testinin yarısı önerilir). Yedek hattındayken (mobil hat) klasörler yüklenmez, yalnız
          ayarlar yedeklenir; klasör yüklemesi sürerken yedek hattına geçilirse yükleme durur ve sonraki yedekte kaldığı yerden
          sürer. Disk hazırlama / veri taşıma ile bulut yedeği aynı anda çalışmaz; panel güncellemesi yedeği kesmez.</p>
      </DocBlock>

      <DocBlock title="Ücret">
        <p>Depolama ücreti ve hesap tamamen sizindir. Yalnız ayar yedeği birkaç MB'tır; klasör yedeğinin maliyeti boyutuna göre
          değişir. Güncel fiyatlar için sağlayıcınızın sayfasına bakın. Backblaze B2'de kova ayarındaki yaşam döngüsünü «Keep
          only the last version of the file» yapın: yoksa temizlenen eski yedekler gizlenir ama ücretlendirilmeye devam eder.</p>
      </DocBlock>

      <DocBlock title="Buluttan geri yükleme (yeni cihaza kurtarma)">
        <ol className="doc-list">
          <li>Yeni cihaza Klyrix Gate'i kurun (kurulum betiği, rol, panel parolası).</li>
          <li>Yedekleme → Bulut Yedeği → <strong>Buluttan geri yükle</strong>: kurtarma kitini yapıştırın, parolanızı yazın. Cihaz
            depoya bağlanır; otomatik yedek, siz «Bu cihazdan yedeklemeye devam» diyene kadar duraklatılır (yeni cihazın boş ayarları
            iyi yedeklerin yanına eklenmez).</li>
          <li>Ayar yedeklerini listeleyin, birini <strong>Getir</strong>in. Önizleme yedeğin tarihini, panel sürümünü, tablo ve kayıt
            sayılarını, gizli anahtar olup olmadığını (yalnız sayılar) ve uyarıları gösterir: kayıtlı olmayan VPS'e yönlenen kurallar,
            root olarak çalışacak Cron komutları.</li>
          <li><strong>Uygula</strong>: indirilen yedek dosyasıyla aynı yol (kurallar ve listeler değişir, ayarlar birleşir, güvenlik
            duvarı sizi panelden kesecekse geri yüklenmez). Gizli anahtarlar (VPS ve tünelleri, Ev VPN'i, DDNS) yalnız siz seçerseniz
            ve «Eski cihaz kapalı / artık kullanılmıyor» onayıyla gelir — aynı WireGuard anahtarları iki cihazda çalışırsa ikisi de bozulur.
            Bu cihazda zaten VPS kaydı varsa VPS bölümü atlanır ve yedekteki kurallar bu cihazın aynı numaralı VPS'ini kullanır (önizleme
            hangi kuralın hangi sunucuya gideceğini gösterir). Ev VPN'i ve (yedekte varsa) DDNS bu cihazdakilerin yerine geçer. Yedekte
            geçersiz bir bölüm (ör. DDNS) yalnız kendisi atlanır; diğerleri geri yüklenir.</li>
        </ol>
      </DocBlock>

      <DocBlock title="Geri yüklemeden sonra">
        <ul className="doc-list">
          <li>Ağ kurulumunu sihirbazlarla yeniden yapın (sabit adres, Pi DHCP, internet kartı, Wi-Fi, yedek hat), port yönlendirmelerini
            yeniden ekleyin ve uyduları yeniden eşleştirin.</li>
          <li>Gizli anahtarlar gelmediyse: VPS'leri WireGuard sayfasından yeniden kurun ve Routing'de kuralların VPS seçimini denetleyin —
            VPS kayıtlı olana kadar bu kurallar (yedek yolu «engelle» olanlar da) operatör hattından çıkar. Ev VPN'ini açıp telefon /
            dizüstü profillerini yeniden dağıtın, DDNS'i yeniden ekleyin.</li>
          <li>Ev VPN'i kullanıyorsanız modemdeki UDP 51820 yönlendirmesini yeni cihazın adresine çevirin.</li>
          <li>Güvenlik duvarı eski cihazda kuruluysa Firewall sayfasında kuralları denetleyip «Deploy Et» ile kurun.</li>
          <li>Ağ paylaşımını parolayla yeniden açın; klasör yedeğini isterseniz bir diske <strong>yeni bir klasöre</strong>
            (geri-yuklenen-…) indirin — var olan dosyaların üzerine yazılmaz, klasörün sahibi paylaşımın kullanıcısı olur.</li>
          <li>«Depo anahtarları»ndan eski cihazın anahtarını kaldırın (parola + yazılı onay): eski cihaz ya da SD kartı başkasının eline
            geçse de depoyu açamaz.</li>
          <li>Bulut yedeğinin kendi ayarlarını yeniden yapın: yedeklenecek klasörler, gizli anahtar yedeği, saat ve saklama geri yüklenmez
            (bu cihazda varsayılandır: klasör yok, gizli anahtarlar kapalı).</li>
          <li>Her şey yerindeyse «Bu cihazdan yedeklemeye devam».</li>
        </ul>
        <DocTip type="warning">Hiç geri yüklenmez: ağ kurulumu ve NetworkManager profilleri (eski donanımın arayüz adlarını ve adreslerini
          taşırlar, açılışta erişimi kesebilirlerdi), uydu eşleşmeleri, panel ve ağ paylaşımı parolaları, cihaz listesi, port
          yönlendirmeleri ve bulut yedeğinin kendi ayarları. Panel olmadan da açılabilir: kurtarma kiti dosyasındaki <code>restic … snapshots</code> /
          <code> restore latest</code> komutları parolanızla herhangi bir bilgisayarda çalışır.</DocTip>
      </DocBlock>
    </div>
  );
}

function TroubleshootingDoc({ expandedFaq, setExpandedFaq }: { expandedFaq: string | null; setExpandedFaq: (id: string | null) => void }) {
  const faqs = [
    { id: 'dns-fail', q: 'DNS çözümlemesi çalışmıyor', a: 'Pi-hole ve Unbound servislerinin aktif olduğundan emin olun. "dig @127.0.0.1 google.com" komutuyla test edin. Fail-open modu aktif ise DNS arızası var demektir.' },
    { id: 'dpi-block', q: 'Zapret bypass çalışmıyor, site hâlâ engelli', a: 'ISP DPI yöntemini değiştirmiş olabilir. Zapret panelinden blockcheck çalıştırarak yeni parametreler test edin. desync_mode ve desync_ttl değerlerini değiştirmeyi deneyin.' },
    { id: 'homevpn-fail', q: "Ev VPN'ine dışarıdan bağlanılamıyor", a: "WireGuard → Ev VPN'i (Pi) sekmesinde Dışarıdan bağlantı → Testi başlat'a basın. Test evin dış adresini, DDNS'i, evde kaç modem/router olduğunu (arka arkaya iki cihaz = her birinde port yönlendirmesi) ve operatörün paylaşımlı IP (CGNAT) kullanıp kullanmadığını bulur; bağlı bir VPS tüneli varsa dışarıdan deneme paketi gönderip modem ayarını doğrular. Sonuca göre yapılacakları adım adım gösterir. Telefonla denerken Wi-Fi kapalı olmalı." },
    { id: 'wg-fail', q: 'WireGuard tüneli bağlanmıyor', a: 'VPS\'in erişilebilir olduğundan emin olun (ping). UDP 51820 portunun VPS firewall\'unda açık olduğunu kontrol edin. "wg show" komutuyla handshake durumunu kontrol edin.' },
    { id: 'high-cpu', q: 'CPU kullanımı çok yüksek', a: 'Zapret NFQWS modunda paket işleme CPU yoğundur. TPROXY moduna geçmeyi deneyin. Ayrıca Unbound thread sayısını CPU çekirdek sayısıyla eşleştirin.' },
    { id: 'blocked-site', q: 'Bir site Pi-hole tarafından yanlışlıkla engelleniyor', a: 'Pi-hole → Beyaz Liste sekmesinden domaini ekleyin. Alternatif olarak "pihole allow example.com" komutuyla CLI\'dan ekleyebilirsiniz.' },
    { id: 'ssh-locked', q: 'SSH ile bağlanamıyorum, Fail2Ban engelledi', a: 'Ev ağı varsayılan olarak muaftır. Dışarıdan (ör. Ev VPN\'i ile) yasaklandıysanız panelde Fail2Ban → Genel Bakış → "Yasağı kaldır". Panele de erişemiyorsanız Pi\'de "fail2ban-client unban <IP>" çalıştırın.' },
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
pihole allow example.com   # Beyaz listeye ekle
pihole deny example.com    # Kara listeye ekle
systemctl restart pihole-FTL  # DNS servisini yeniden başlat (v6'da 'pihole restartdns' yok)
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
nft list table inet pi5_filter  # Panelin güvenlik duvarı (yeniden yüklemek: panel → Güvenlik Duvarı → Ayarlar → Kuralları yeniden uygula)
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

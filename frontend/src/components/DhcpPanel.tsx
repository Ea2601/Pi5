import { Radio, ShieldBan, ChevronLeft } from 'lucide-react';
import { Panel } from './ui';
import { DhcpModeCard } from './DhcpModeCard';

// DHCP Ayarları — Pi-hole'un alt sayfası (eskiden Pi-hole → Ayarlar sekmesindeki kart). Canlı durum + Faz 2 sihirbazı
// DhcpModeCard'da; bu sayfa yalnız başlık ve Pi-hole'a dönüş bağlantısı ekler. Doğrudan adres: http://<pi>/#dhcp
export function DhcpPanel() {
  return (
    <div className="fade-in page-stack">
      <Panel
        title="DHCP Ayarları"
        icon={<Radio size={20} style={{ marginRight: 8 }} />}
        subtitle="Pi-hole'un DHCP sunucusu: cihazlara IP adresi, ağ geçidi ve DNS dağıtımı. Modemden Pi'ye geçiş adım adım sihirbazla yapılır."
        actions={
          <a className="crumb-link" href="#pihole">
            <ChevronLeft size={14} /><ShieldBan size={14} /><span>Pi-hole DNS</span>
          </a>
        }
      >
        {null}
      </Panel>
      <DhcpModeCard />
    </div>
  );
}

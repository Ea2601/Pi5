import { Radio } from 'lucide-react';
import { Panel } from './ui';
import { DhcpModeCard } from './DhcpModeCard';

// DHCP Ayarları — menüde kendi başına bir sayfa (eskiden Pi-hole → Ayarlar sekmesindeki kart, sonra Pi-hole'un alt
// sayfası). Canlı durum + Faz 2 sihirbazı DhcpModeCard'da; bu sayfa yalnız başlık ekler. Doğrudan adres: http://<pi>/#dhcp
export function DhcpPanel() {
  return (
    <div className="fade-in page-stack">
      <Panel
        title="DHCP Ayarları"
        icon={<Radio size={20} style={{ marginRight: 8 }} />}
        subtitle="Pi-hole'un DHCP sunucusu: cihazlara IP adresi, ağ geçidi ve DNS dağıtımı. Modemden Pi'ye geçiş adım adım sihirbazla yapılır."
      >
        {null}
      </Panel>
      <DhcpModeCard />
    </div>
  );
}

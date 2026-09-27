import { Radio, AlertTriangle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';

// Gerçek DHCP / ağ geçidi durumu (salt okunur). Eski "DHCP Sunucu" ayar alanları yalnız panel veritabanına yazıyordu;
// DHCP'yi açma/kapatma sihirbazı Faz 2'nin sonraki adımlarında (sabit IP → modem DHCP'si → Pi DHCP) gelecek.
interface DhcpStatus {
  supported: boolean; pi_dhcp_active?: boolean; start?: string; end?: string; router?: string; lease_time?: string;
  leases?: number;
  lan?: { iface: string; ip: string; prefix: number; gateway: string; network: string; secondary: { iface: string; ip: string }[] } | null;
}

export function DhcpModeCard() {
  const { data } = useApi<DhcpStatus | null>('/dhcp/status', null, 30000);
  if (!data || !data.supported) return null;
  const lan = data.lan;
  return (
    <Panel title="DHCP ve Ağ Geçidi (canlı)" icon={<Radio size={18} style={{ marginRight: 8 }} />}>
      <div className="list-items">
        <div className="list-item">
          <div className="list-item-content">
            <span className="list-item-value">IP adreslerini dağıtan (DHCP)</span>
            <span className="list-item-comment">
              {data.pi_dhcp_active
                ? `Pi — havuz ${data.start}–${data.end}, ağ geçidi ${data.router}${data.lease_time ? `, kira ${data.lease_time}` : ''}, ${data.leases ?? 0} kira`
                : 'Modem (Pi\'nin DHCP sunucusu kapalı)'}
            </span>
          </div>
          <Badge variant={data.pi_dhcp_active ? 'success' : 'neutral'}>{data.pi_dhcp_active ? 'Pi' : 'Modem'}</Badge>
        </div>
        {lan && (
          <div className="list-item">
            <div className="list-item-content">
              <span className="list-item-value">Pi'nin ev ağı adresi</span>
              <span className="list-item-comment">{lan.ip} ({lan.iface}) — ağ {lan.network}, modem {lan.gateway || '?'}</span>
            </div>
          </div>
        )}
        {lan && lan.secondary.length > 0 && (
          <div className="list-item">
            <AlertTriangle size={16} style={{ color: 'var(--warning-color)', flexShrink: 0 }} />
            <div className="list-item-content">
              <span className="list-item-value">Aynı ağda ikinci bağlantı</span>
              <span className="list-item-comment">
                {lan.secondary.map(s => `${s.iface} ${s.ip}`).join(', ')} — Pi aynı ağa iki yoldan bağlı. DHCP açılmadan önce bu bağlantı
                Pi'nin kendi Wi-Fi yayınına dönüştürülecek.
              </span>
            </div>
          </div>
        )}
        {!data.pi_dhcp_active && (
          <p className="subtitle" style={{ margin: '4px 2px 0' }}>
            Şu an yalnız Pi'yi elle ağ geçidi/DNS olarak ayarlayan cihazlar yönlendirme ve cihaz engellemesinden geçer.
          </p>
        )}
      </div>
    </Panel>
  );
}

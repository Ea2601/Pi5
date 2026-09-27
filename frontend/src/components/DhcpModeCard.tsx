import { useCallback, useEffect, useRef, useState } from 'react';
import { Radio, AlertTriangle, RefreshCw } from 'lucide-react';
import { Panel, Badge } from './ui';
import { DhcpWizard } from './DhcpWizard';
import type { DhcpStatus, NetModeStatus } from './DhcpWizard';

// Gerçek DHCP / ağ geçidi durumu + Faz 2 sihirbazı (sabit IP → Pi'nin Wi-Fi'si → modem DHCP'si → Pi DHCP). Eski "DHCP
// Sunucu" ayar alanları yalnız panel veritabanına yazıyordu. Kart hiçbir durumda sessizce kaybolmaz: yükleniyor / hata
// satırı gösterilir. Deneme sürerken 5 sn'de, yoksa 30 sn'de bir yenilenir.
type Fetched<T> = { data: T | null; error: string | null };
async function fetchStatus<T extends { error?: string }>(endpoint: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`/api${endpoint}`, { cache: 'no-store' });
    const json: unknown = await res.json().catch(() => null);
    const obj = json && typeof json === 'object' ? (json as T) : null;
    if (!res.ok) return { data: null, error: obj?.error || `HTTP ${res.status}` };
    if (!obj) return { data: null, error: 'geçersiz yanıt' };
    if (obj.error) return { data: null, error: obj.error };
    return { data: obj, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'bağlantı hatası' };
  }
}

export function DhcpModeCard() {
  const [dhcp, setDhcp] = useState<DhcpStatus | null>(null);
  const [dhcpErr, setDhcpErr] = useState<string | null>(null);
  const [net, setNet] = useState<NetModeStatus | null>(null);
  const [netErr, setNetErr] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const my = ++reqId.current;
    const [d, n] = await Promise.all([fetchStatus<DhcpStatus>('/dhcp/status'), fetchStatus<NetModeStatus>('/netmode/status')]);
    if (my !== reqId.current) return; // eski/yarış yanıtı
    // Ağ değişirken tek bir okuma kopabilir: son iyi veri ekranda kalır, hata yanında yazılır.
    if (d.data) setDhcp(d.data);
    setDhcpErr(d.error);
    if (n.data) setNet(n.data);
    setNetErr(n.error);
    // "Modemin DHCP'sini geri açın" uyarısı Pi'de kalıcıdır (pi.modem_warn): sayfa o an açık olmasa da görünür.
  }, []);

  const trial = net?.stage === 'trial' || dhcp?.pi?.stage === 'trial';
  const interval = trial ? 5000 : 30000;
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, interval);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, interval]);

  const lan = dhcp?.lan;
  const pi = dhcp?.pi && !dhcp.pi.error ? dhcp.pi : null;
  const piTrial = pi?.stage === 'trial';
  return (
    <Panel title="DHCP ve Ağ Geçidi (canlı)" icon={<Radio size={18} style={{ marginRight: 8 }} />}>
      {!dhcp && !dhcpErr && <p className="subtitle dhcp-note">yükleniyor…</p>}
      {dhcpErr && (
        <div className="routing-apply routing-apply-err" style={{ marginTop: 0, marginBottom: 8 }}>
          <AlertTriangle size={14} />
          <span>durum okunamadı: {dhcpErr}</span>
          <button onClick={() => { void load(); }} title="Yeniden dene" aria-label="Yeniden dene"><RefreshCw size={14} /></button>
        </div>
      )}
      {dhcp && !dhcp.supported && <p className="subtitle dhcp-note">Canlı DHCP durumu yalnız Pi üzerinde okunur.</p>}
      {dhcp?.supported && (
        <div className="list-items">
          <div className="list-item">
            <div className="list-item-content">
              <span className="list-item-value">IP adreslerini dağıtan (DHCP)</span>
              <span className="list-item-comment">
                {dhcp.pi_dhcp_active
                  ? `Pi${piTrial ? ' (deneme)' : ''} — havuz ${dhcp.start}–${dhcp.end}, ağ geçidi ${dhcp.router}${dhcp.lease_time ? `, kira ${dhcp.lease_time}` : ''}, ${dhcp.leases ?? 0} kira`
                  : 'Modem (Pi\'nin DHCP sunucusu kapalı)'}
              </span>
            </div>
            <Badge variant={dhcp.pi_dhcp_active ? (piTrial ? 'warning' : 'success') : 'neutral'}>
              {dhcp.pi_dhcp_active ? (piTrial ? 'Pi (deneme)' : 'Pi') : 'Modem'}
            </Badge>
          </div>
          {lan && lan.dualSubnet && lan.client && lan.transit ? (
            <div className="list-item">
              <div className="list-item-content">
                <span className="list-item-value">Pi'nin adresleri ({lan.iface})</span>
                <span className="list-item-comment">Cihazlar için: {lan.client.ip}/{lan.client.prefix}</span>
                <span className="list-item-comment">Modem tarafı: {lan.transit.ip} → modem {lan.gateway || '?'}</span>
              </div>
            </div>
          ) : lan ? (
            <div className="list-item">
              <div className="list-item-content">
                <span className="list-item-value">Pi'nin ev ağı adresi</span>
                <span className="list-item-comment">{lan.ip} ({lan.iface}) — ağ {lan.network}, modem {lan.gateway || '?'}</span>
              </div>
            </div>
          ) : (
            <div className="list-item">
              <div className="list-item-content">
                <span className="list-item-value">Pi'nin ev ağı adresi</span>
                <span className="list-item-comment">bulunamadı (varsayılan rota yok)</span>
              </div>
            </div>
          )}
          {lan && lan.secondary.length > 0 && (
            <div className="list-item">
              <AlertTriangle size={16} style={{ color: 'var(--warning-color)', flexShrink: 0 }} />
              <div className="list-item-content">
                <span className="list-item-value">Aynı ağda ikinci bağlantı</span>
                <span className="list-item-comment">
                  {lan.secondary.map(s => `${s.iface} ${s.ip}`).join(', ')} — Pi aynı ağa iki yoldan bağlı. DHCP açılmadan önce Pi'nin
                  Wi-Fi bağlantısı ayrılacak.
                </span>
              </div>
            </div>
          )}
          {!dhcp.pi_dhcp_active && (
            <p className="subtitle" style={{ margin: '4px 2px 0' }}>
              Şu an yalnız Pi'yi elle ağ geçidi/DNS olarak ayarlayan cihazlar yönlendirme ve cihaz engellemesinden geçer.
            </p>
          )}
          <DhcpWizard dhcp={dhcp} net={net} netErr={netErr} reload={load} />
        </div>
      )}
    </Panel>
  );
}

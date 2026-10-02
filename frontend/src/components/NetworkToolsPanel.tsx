import { Wrench, Power, Search, Server, Plus, Loader, Trash2 } from 'lucide-react';
import { useApi, postApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Badge, Select, SelectOption } from './ui';
import { toast } from '../toast';
import type { Device } from '../types';

type ToolTab = 'wol' | 'portscan' | 'dhcp';

interface PortScanResult {
  port: number;
  state: 'open' | 'closed' | 'filtered';
  service: string;
}

interface DhcpLease {
  mac_address: string;
  ip_address: string;
  hostname: string;
  lease_end: string;
  is_static: number;
  has_reservation?: number; // dinamik kira: bu cihazın sabit rezervasyonu da var
}

interface DhcpData {
  leases: DhcpLease[];
}

export function NetworkToolsPanel() {
  const [activeTab, setActiveTab] = useState<ToolTab>('wol');
  const { data: devicesData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const { data: dhcpData, refetch: refetchDhcp } = useApi<DhcpData>('/dhcp/leases', { leases: [] });

  // WoL state
  const [wolTarget, setWolTarget] = useState('');
  const [wolSending, setWolSending] = useState(false);

  // Port scanner state
  const [scanIp, setScanIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<PortScanResult[]>([]);

  // DHCP reservation state
  const [newResMac, setNewResMac] = useState('');
  const [newResIp, setNewResIp] = useState('');
  const [newResHostname, setNewResHostname] = useState('');
  const [addingRes, setAddingRes] = useState(false);

  const tabs: { id: ToolTab; label: string; icon: React.ReactNode }[] = [
    { id: 'wol', label: 'WoL', icon: <Power size={14} /> },
    { id: 'portscan', label: 'Port Tarayici', icon: <Search size={14} /> },
    { id: 'dhcp', label: 'DHCP', icon: <Server size={14} /> },
  ];

  const handleWol = async () => {
    if (!wolTarget) return;
    setWolSending(true);
    try {
      const r = await postApi('/wol/send', { mac_address: wolTarget });
      toast.success(r?.message || 'Wake-on-LAN paketi gönderildi');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gönderim başarısız oldu');
    }
    setWolSending(false);
  };

  const handleScan = async () => {
    if (!scanIp) return;
    setScanning(true);
    setScanResults([]);
    try {
      const result = await postApi('/network/portscan', { ip: scanIp });
      setScanResults(result.ports || []);
    } catch {
      setScanResults([]);
    }
    setScanning(false);
  };

  const handleAddReservation = async () => {
    if (!newResMac || !newResIp) return;
    setAddingRes(true);
    try {
      await postApi('/dhcp/static', {
        mac_address: newResMac,
        ip_address: newResIp,
        hostname: newResHostname,
      });
      setNewResMac('');
      setNewResIp('');
      setNewResHostname('');
      toast.success('Rezervasyon Pi-hole\'a uygulandı');
      await refetchDhcp();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rezervasyon eklenemedi');
    }
    setAddingRes(false);
  };

  const handleDeleteReservation = async (mac: string) => {
    if (!confirm(`${mac} için sabit IP rezervasyonu kaldırılsın mı? Cihaz sonraki kira yenilemesinde havuzdan adres alır.`)) return;
    try {
      await deleteApi(`/dhcp/static/${encodeURIComponent(mac)}`);
      toast.success('Rezervasyon kaldırıldı');
      await refetchDhcp();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rezervasyon kaldırılamadı');
    }
  };

  return (
    <div className="fade-in">
      <Panel title="Ag Araclari" icon={<Wrench size={20} style={{ marginRight: 8 }} />}
        subtitle="Wake-on-LAN, port tarama ve DHCP yonetimi">
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'wol' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Wake-on-LAN" icon={<Power size={18} style={{ marginRight: 8 }} />}>
            <div className="list-add-form">
              <div className="list-add-row">
                <Select className="config-input" value={wolTarget}
                  onChange={e => setWolTarget(e.target.value)}
                  style={{ flex: 2 }}>
                  <option value="">Cihaz secin...</option>
                  {devicesData.devices.map(d => (
                    <SelectOption key={d.mac_address} value={d.mac_address}
                      cols={[d.hostname || 'Adsız cihaz', d.ip_address, d.mac_address]} />
                  ))}
                </Select>
                <button className="btn-primary btn-sm" onClick={handleWol}
                  disabled={wolSending || !wolTarget}>
                  {wolSending ? <><Loader size={14} className="spin-icon" /> Gonderiliyor...</> : <><Power size={14} /> Uyandir</>}
                </button>
              </div>
            </div>
            <div className="blocked-list" style={{ marginTop: 12 }}>
              <p className="text-muted" style={{ padding: '8px 0', fontSize: '0.8rem' }}>
                Wake-on-LAN, kapalı cihazlari ag uzerinden uzaktan baslatmanizi saglar. Hedef cihazin WoL destekli olmasi gerekir.
              </p>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 'portscan' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Port Tarayici" icon={<Search size={18} style={{ marginRight: 8 }} />}>
            <div className="list-add-form">
              <div className="list-add-row">
                <input className="config-input" type="text"
                  placeholder="IP adresi (orn: 192.168.1.1)"
                  value={scanIp}
                  onChange={e => setScanIp(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleScan()}
                  style={{ flex: 2 }} />
                <button className="btn-primary btn-sm" onClick={handleScan}
                  disabled={scanning || !scanIp}>
                  {scanning ? <><Loader size={14} className="spin-icon" /> Taraniyor...</> : <><Search size={14} /> Tara</>}
                </button>
              </div>
            </div>

            {scanResults.length > 0 && (
              <div className="blocked-list" style={{ marginTop: 12 }}>
                <div className="ban-row" style={{ opacity: 0.6 }}>
                  <span style={{ flex: 0.5 }}>Port</span>
                  <span style={{ flex: 1 }}>Durum</span>
                  <span style={{ flex: 1 }}>Servis</span>
                </div>
                {scanResults.map(port => (
                  <div key={port.port} className="ban-row">
                    <span style={{ flex: 0.5, fontFamily: 'monospace' }}>{port.port}</span>
                    <span style={{ flex: 1 }}>
                      <Badge variant={port.state === 'open' ? 'success' : port.state === 'filtered' ? 'warning' : 'error'}>
                        {port.state === 'open' ? 'Acik' : port.state === 'filtered' ? 'Filtreli' : 'Kapali'}
                      </Badge>
                    </span>
                    <span style={{ flex: 1 }}>{port.service || '-'}</span>
                  </div>
                ))}
              </div>
            )}

            {scanning && (
              <div className="empty-state" style={{ padding: '20px' }}>
                <Loader size={20} className="spin-icon" /> Portlar taraniyor...
              </div>
            )}

            {!scanning && scanResults.length === 0 && (
              <div className="empty-state" style={{ padding: '20px' }}>
                Taramak icin bir IP adresi girin.
              </div>
            )}
          </Panel>
        </div>
      )}

      {activeTab === 'dhcp' && (
        <div style={{ marginTop: 14 }}>
          <Panel title="DHCP Kiralama Tablosu" icon={<Server size={18} style={{ marginRight: 8 }} />}>
            <div className="blocked-list">
              <div className="ban-row" style={{ opacity: 0.6 }}>
                <span style={{ flex: 1 }}>MAC Adresi</span>
                <span style={{ flex: 1 }}>IP Adresi</span>
                <span style={{ flex: 1 }}>Hostname</span>
                <span style={{ flex: 1 }}>Bitis</span>
                <span style={{ flex: 0.5 }}>Tip</span>
                <span style={{ width: 28 }} />
              </div>
              {dhcpData.leases.length === 0 && (
                <div className="empty-state" style={{ padding: '20px' }}>DHCP kiralamalari bulunamadi.</div>
              )}
              {dhcpData.leases.map(lease => (
                <div key={`${lease.is_static ? 's' : 'd'}-${lease.mac_address}`} className="ban-row">
                  <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}>{lease.mac_address}</span>
                  <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}>{lease.ip_address}</span>
                  <span style={{ flex: 1 }}>{lease.hostname || '-'}</span>
                  <span style={{ flex: 1, fontSize: '0.75rem' }} className="text-muted">
                    {lease.is_static ? 'Statik' : (lease.lease_end ? new Date(lease.lease_end).toLocaleString('tr-TR') : '-')}
                  </span>
                  <span style={{ flex: 0.5 }}>
                    <Badge variant={lease.is_static ? 'info' : 'neutral'}>
                      {lease.is_static ? 'Rezervasyon' : lease.has_reservation ? 'Kira (rezerveli)' : 'Dinamik'}
                    </Badge>
                  </span>
                  <span style={{ width: 28, display: 'flex', justifyContent: 'flex-end' }}>
                    {lease.is_static ? (
                      <button className="icon-btn icon-btn-sm cron-delete" title="Rezervasyonu kaldır" aria-label={`${lease.mac_address} rezervasyonunu kaldır`}
                        onClick={() => void handleDeleteReservation(lease.mac_address)}>
                        <Trash2 size={13} />
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <div style={{ marginTop: 14 }}>
            <Panel title="Statik Rezervasyon Ekle" icon={<Plus size={18} style={{ marginRight: 8 }} />}
              subtitle="Pi'nin DHCP sunucusu (Pi-hole) bu cihaza her zaman aynı adresi verir. Adres Pi'nin dağıttığı ağda olmalı; Pi DHCP'si kapalıyken de kaydedilir, açılınca geçerli olur. Cihaz yeni adresi bir sonraki kira yenilemesinde alır.">
              <div className="list-add-form">
                <div className="list-add-row">
                  <input className="config-input" type="text"
                    placeholder="MAC adresi (AA:BB:CC:DD:EE:FF)"
                    value={newResMac}
                    onChange={e => setNewResMac(e.target.value)} />
                  <input className="config-input" type="text"
                    placeholder="IP adresi"
                    value={newResIp}
                    onChange={e => setNewResIp(e.target.value)} />
                  <input className="config-input" type="text"
                    placeholder="Hostname (istege bagli)"
                    value={newResHostname}
                    onChange={e => setNewResHostname(e.target.value)} />
                  <button className="btn-primary btn-sm" onClick={handleAddReservation}
                    disabled={addingRes || !newResMac || !newResIp}>
                    <Plus size={14} /> Ekle
                  </button>
                </div>
              </div>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

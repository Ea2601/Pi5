import { Wrench, Power, Search, Server, Plus, Loader, Wifi } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Badge } from './ui';
import type { Device } from '../types';

type ToolTab = 'wol' | 'portscan' | 'dhcp';

interface PortScanResult {
  port: number;
  state: 'open' | 'closed' | 'filtered';
  service: string;
}

interface DhcpLease {
  mac: string;
  ip: string;
  hostname: string;
  expires: string;
  static: boolean;
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
  const [wolResult, setWolResult] = useState('');

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
    setWolResult('');
    try {
      await postApi('/wol/wake', { mac: wolTarget });
      setWolResult('Wake-on-LAN paketi gonderildi!');
    } catch {
      setWolResult('Gonderim basarisiz oldu.');
    }
    setWolSending(false);
  };

  const handleScan = async () => {
    if (!scanIp) return;
    setScanning(true);
    setScanResults([]);
    try {
      const result = await postApi('/portscan/scan', { ip: scanIp });
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
      await postApi('/dhcp/reservations', {
        mac: newResMac,
        ip: newResIp,
        hostname: newResHostname,
      });
      setNewResMac('');
      setNewResIp('');
      setNewResHostname('');
      await refetchDhcp();
    } catch { /* */ }
    setAddingRes(false);
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
                <select className="config-input" value={wolTarget}
                  onChange={e => setWolTarget(e.target.value)}
                  style={{ flex: 2 }}>
                  <option value="">Cihaz secin...</option>
                  {devicesData.devices.map(d => (
                    <option key={d.mac_address} value={d.mac_address}>
                      {d.hostname || d.ip_address} ({d.mac_address})
                    </option>
                  ))}
                </select>
                <button className="btn-primary btn-sm" onClick={handleWol}
                  disabled={wolSending || !wolTarget}>
                  {wolSending ? <><Loader size={14} className="spin-icon" /> Gonderiliyor...</> : <><Power size={14} /> Uyandir</>}
                </button>
              </div>
            </div>
            {wolResult && (
              <div className="pihole-flow" style={{ marginTop: 8 }}>
                <Wifi size={14} />
                <span>{wolResult}</span>
              </div>
            )}
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
              </div>
              {dhcpData.leases.length === 0 && (
                <div className="empty-state" style={{ padding: '20px' }}>DHCP kiralamalari bulunamadi.</div>
              )}
              {dhcpData.leases.map(lease => (
                <div key={lease.mac} className="ban-row">
                  <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}>{lease.mac}</span>
                  <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}>{lease.ip}</span>
                  <span style={{ flex: 1 }}>{lease.hostname || '-'}</span>
                  <span style={{ flex: 1, fontSize: '0.75rem' }} className="text-muted">
                    {lease.static ? 'Statik' : new Date(lease.expires).toLocaleString('tr-TR')}
                  </span>
                  <span style={{ flex: 0.5 }}>
                    <Badge variant={lease.static ? 'info' : 'neutral'}>
                      {lease.static ? 'Statik' : 'Dinamik'}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <div style={{ marginTop: 14 }}>
            <Panel title="Statik Rezervasyon Ekle" icon={<Plus size={18} style={{ marginRight: 8 }} />}>
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

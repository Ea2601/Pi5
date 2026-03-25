import { useState } from 'react';
import {
  Users, Shield, Clock, AlertTriangle, Plus, ChevronDown, ChevronRight,
  Wifi, WifiOff, Check, X, Monitor, Smartphone, HardDrive, Palette
} from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import type { Device } from '../types';

type DeviceTab = 'groups' | 'blocking' | 'history' | 'unknown';

interface DeviceGroup {
  id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  members: Device[];
}

interface ConnectionEvent {
  timestamp: string;
  type: 'connect' | 'disconnect';
  ip_address: string;
  hostname: string;
}

interface UnknownDevice {
  mac_address: string;
  ip_address: string;
  hostname: string;
  first_seen: string;
  last_seen: string;
}

export function DeviceControlPanel() {
  const [activeTab, setActiveTab] = useState<DeviceTab>('groups');

  const tabs: { id: DeviceTab; label: string; icon: React.ReactNode }[] = [
    { id: 'groups', label: 'Gruplar', icon: <Users size={14} /> },
    { id: 'blocking', label: 'Engelleme', icon: <Shield size={14} /> },
    { id: 'history', label: 'Bağlantı Geçmişi', icon: <Clock size={14} /> },
    { id: 'unknown', label: 'Bilinmeyen Cihazlar', icon: <AlertTriangle size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel
        title="Cihaz Yönetimi"
        icon={<Monitor size={20} style={{ marginRight: 8 }} />}
        subtitle="Ağ cihazlarını grupla, engelle ve izle"
      >
        <div className="service-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'groups' && <GroupsView />}
      {activeTab === 'blocking' && <BlockingView />}
      {activeTab === 'history' && <HistoryView />}
      {activeTab === 'unknown' && <UnknownView />}
    </div>
  );
}

function GroupsView() {
  const { data, refetch } = useApi<{ groups: DeviceGroup[] }>('/devices/groups', { groups: [] });
  const { data: devicesData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [addingMember, setAddingMember] = useState<number | null>(null);
  const [selectedMac, setSelectedMac] = useState('');
  const [newGroup, setNewGroup] = useState({ name: '', description: '', color: '#3b82f6', icon: 'monitor' });

  const handleCreate = async () => {
    if (!newGroup.name) return;
    try {
      await postApi('/devices/groups', newGroup as unknown as Record<string, unknown>);
      setNewGroup({ name: '', description: '', color: '#3b82f6', icon: 'monitor' });
      setShowAdd(false);
      await refetch();
    } catch { /* */ }
  };

  const handleAddMember = async (groupId: number) => {
    if (!selectedMac) return;
    try {
      await postApi(`/devices/groups/${groupId}/members`, { mac_address: selectedMac });
      setAddingMember(null);
      setSelectedMac('');
      await refetch();
    } catch { /* */ }
  };

  const colorOptions = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#ec4899'];
  const iconOptions = [
    { value: 'monitor', label: 'Bilgisayar' },
    { value: 'smartphone', label: 'Telefon' },
    { value: 'hard-drive', label: 'Sunucu' },
    { value: 'wifi', label: 'IoT' },
  ];

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Users size={18} style={{ marginRight: 8 }} />Cihaz Grupları</h3>
          <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Yeni Grup
          </button>
        </div>

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label>Grup Adı</label>
                <input className="config-input" type="text" placeholder="Ev Cihazları"
                  value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Açıklama</label>
                <input className="config-input" type="text" placeholder="Evdeki tüm cihazlar"
                  value={newGroup.description} onChange={e => setNewGroup({ ...newGroup, description: e.target.value })} />
              </div>
              <div className="form-group">
                <label><Palette size={12} /> Renk</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {colorOptions.map(c => (
                    <button key={c}
                      style={{
                        width: 28, height: 28, borderRadius: 6, background: c, border: newGroup.color === c ? '2px solid #fff' : '2px solid transparent',
                        cursor: 'pointer'
                      }}
                      onClick={() => setNewGroup({ ...newGroup, color: c })}
                    />
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label>Simge</label>
                <select className="config-select" value={newGroup.icon}
                  onChange={e => setNewGroup({ ...newGroup, icon: e.target.value })}>
                  {iconOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="cron-add-actions">
              <button className="btn-primary btn-sm" onClick={handleCreate} disabled={!newGroup.name}>
                <Check size={13} /> Oluştur
              </button>
              <button className="btn-outline btn-sm" onClick={() => setShowAdd(false)}>
                <X size={13} /> İptal
              </button>
            </div>
          </div>
        )}

        <div className="list-items">
          {data.groups.map(group => (
            <div key={group.id}>
              <div className="list-item" style={{ cursor: 'pointer' }}
                onClick={() => setExpanded(expanded === group.id ? null : group.id)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 8, background: group.color + '22',
                    border: `2px solid ${group.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {group.icon === 'smartphone' ? <Smartphone size={16} style={{ color: group.color }} /> :
                     group.icon === 'hard-drive' ? <HardDrive size={16} style={{ color: group.color }} /> :
                     group.icon === 'wifi' ? <Wifi size={16} style={{ color: group.color }} /> :
                     <Monitor size={16} style={{ color: group.color }} />}
                  </div>
                  <div>
                    <strong>{group.name}</strong>
                    <div className="text-muted" style={{ fontSize: 12 }}>{group.description}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Badge variant="info">{group.members.length} cihaz</Badge>
                  {expanded === group.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
              </div>
              {expanded === group.id && (
                <div style={{ padding: '8px 16px 16px 56px' }}>
                  {group.members.map(m => (
                    <div key={m.mac_address} className="list-item" style={{ padding: '6px 10px', fontSize: 13 }}>
                      <span>{m.hostname || m.mac_address}</span>
                      <span className="text-muted">{m.ip_address}</span>
                    </div>
                  ))}
                  {group.members.length === 0 && (
                    <span className="text-muted" style={{ fontSize: 13 }}>Bu grupta henüz cihaz yok</span>
                  )}
                  {addingMember === group.id ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <select className="config-select" value={selectedMac}
                        onChange={e => setSelectedMac(e.target.value)}>
                        <option value="">Cihaz seçin...</option>
                        {devicesData.devices.map(d => (
                          <option key={d.mac_address} value={d.mac_address}>
                            {d.hostname || d.mac_address} ({d.ip_address})
                          </option>
                        ))}
                      </select>
                      <button className="btn-primary btn-sm" onClick={() => handleAddMember(group.id)}>
                        <Check size={13} />
                      </button>
                      <button className="btn-outline btn-sm" onClick={() => setAddingMember(null)}>
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <button className="btn-outline btn-sm" style={{ marginTop: 8 }}
                      onClick={() => setAddingMember(group.id)}>
                      <Plus size={13} /> Üye Ekle
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {data.groups.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Users size={32} />
              <p>Henüz cihaz grubu oluşturulmadı</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BlockingView() {
  const { data, refetch } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const [blocking, setBlocking] = useState<string | null>(null);

  const handleToggleBlock = async (mac: string, currentlyBlocked: boolean) => {
    setBlocking(mac);
    try {
      await postApi(`/devices/${mac}/block`, { blocked: !currentlyBlocked });
      await refetch();
    } catch { /* */ }
    setBlocking(null);
  };

  const isBlocked = (device: Device) => device.route_profile === 'blocked';

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Shield size={18} style={{ marginRight: 8 }} />Cihaz Engelleme</h3>
          <Badge variant="info">{data.devices.length} cihaz</Badge>
        </div>

        <div className="list-items">
          {data.devices.map(device => {
            const blocked = isBlocked(device);
            return (
              <div key={device.mac_address} className="list-item"
                style={blocked ? { borderLeft: '3px solid #ef4444', background: 'rgba(239,68,68,0.06)' } : {}}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  {blocked ? <WifiOff size={16} style={{ color: '#ef4444' }} /> : <Wifi size={16} style={{ color: '#10b981' }} />}
                  <div>
                    <strong>{device.hostname || 'Bilinmeyen'}</strong>
                    <div className="text-muted" style={{ fontSize: 12 }}>
                      {device.ip_address} &middot; {device.mac_address}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {blocked && <Badge variant="error">Engelli</Badge>}
                  <button
                    className={`toggle-btn ${blocked ? 'toggle-off' : 'toggle-on'}`}
                    onClick={() => handleToggleBlock(device.mac_address, blocked)}
                    disabled={blocking === device.mac_address}
                    title={blocked ? 'Engeli Kaldır' : 'Engelle'}
                  >
                    <div className="toggle-knob" />
                  </button>
                </div>
              </div>
            );
          })}
          {data.devices.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Monitor size={32} />
              <p>Kayıtlı cihaz bulunamadı</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryView() {
  const { data: devicesData } = useApi<{ devices: Device[] }>('/devices', { devices: [] });
  const [selectedMac, setSelectedMac] = useState('');
  const { data: historyData } = useApi<{ events: ConnectionEvent[] }>(
    selectedMac ? `/devices/${selectedMac}/history` : '/devices/unknown',
    { events: [] }
  );

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Clock size={18} style={{ marginRight: 8 }} />Bağlantı Geçmişi</h3>
        </div>

        <div style={{ padding: '12px 0' }}>
          <select className="config-select" value={selectedMac}
            onChange={e => setSelectedMac(e.target.value)}
            style={{ maxWidth: 400 }}>
            <option value="">Cihaz seçin...</option>
            {devicesData.devices.map(d => (
              <option key={d.mac_address} value={d.mac_address}>
                {d.hostname || d.mac_address} ({d.ip_address})
              </option>
            ))}
          </select>
        </div>

        {selectedMac ? (
          <div className="list-items">
            {historyData.events.map((event, i) => (
              <div key={i} className="list-item" style={{ gap: 12 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: event.type === 'connect' ? '#10b981' : '#ef4444',
                  flexShrink: 0
                }} />
                <div style={{ flex: 1 }}>
                  <strong>{event.type === 'connect' ? 'Bağlandı' : 'Bağlantı Kesildi'}</strong>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    {event.ip_address} &middot; {event.hostname}
                  </div>
                </div>
                <span className="text-muted" style={{ fontSize: 12 }}>{event.timestamp}</span>
              </div>
            ))}
            {historyData.events.length === 0 && (
              <div className="empty-state" style={{ padding: 30 }}>
                <Clock size={32} />
                <p>Bu cihaz için geçmiş kaydı bulunamadı</p>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state" style={{ padding: 30 }}>
            <Monitor size={32} />
            <p>Geçmişi görüntülemek için bir cihaz seçin</p>
          </div>
        )}
      </div>
    </div>
  );
}

function UnknownView() {
  const { data, refetch } = useApi<{ devices: UnknownDevice[] }>('/devices/unknown', { devices: [] });
  const [approving, setApproving] = useState<string | null>(null);

  const handleApprove = async (mac: string) => {
    setApproving(mac);
    try {
      await postApi(`/devices/${mac}/approve`, {});
      await refetch();
    } catch { /* */ }
    setApproving(null);
  };

  return (
    <div style={{ marginTop: 14 }}>
      {data.devices.length > 0 && (
        <div style={{
          background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10
        }}>
          <AlertTriangle size={18} style={{ color: '#f59e0b' }} />
          <span style={{ color: '#f59e0b', fontWeight: 500 }}>
            {data.devices.length} bilinmeyen cihaz tespit edildi
          </span>
        </div>
      )}

      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><AlertTriangle size={18} style={{ marginRight: 8 }} />Bilinmeyen Cihazlar</h3>
          <Badge variant="warning">{data.devices.length} cihaz</Badge>
        </div>

        <div className="list-items">
          {data.devices.map(device => (
            <div key={device.mac_address} className="list-item"
              style={{ borderLeft: '3px solid #f59e0b', background: 'rgba(245,158,11,0.04)' }}>
              <div style={{ flex: 1 }}>
                <strong>{device.hostname || 'Bilinmeyen Cihaz'}</strong>
                <div className="text-muted" style={{ fontSize: 12 }}>
                  {device.ip_address} &middot; {device.mac_address}
                </div>
                <div className="text-muted" style={{ fontSize: 11 }}>
                  İlk görülme: {device.first_seen} &middot; Son görülme: {device.last_seen}
                </div>
              </div>
              <button className="btn-primary btn-sm" onClick={() => handleApprove(device.mac_address)}
                disabled={approving === device.mac_address}>
                <Check size={13} /> {approving === device.mac_address ? 'Onaylanıyor...' : 'Onayla'}
              </button>
            </div>
          ))}
          {data.devices.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Check size={32} />
              <p>Tüm cihazlar onaylanmış durumda</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

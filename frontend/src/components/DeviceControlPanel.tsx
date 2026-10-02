import { useEffect, useState } from 'react';
import {
  Users, Shield, Clock, AlertTriangle, Plus, ChevronDown, ChevronRight,
  Wifi, WifiOff, Check, X, Monitor, Smartphone, HardDrive, Palette, Trash2, Pencil
} from 'lucide-react';
import { useApi, getApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge, Select } from './ui';
import type { Device } from '../types';
import { toast } from '../toast';

// Arka uç ad bilgisini Pi-hole DHCP kiralarından ya da elle verilen addan doldurur (name_manual=1: elle).
type Dev = Device & { name_manual?: number };

// MAC'in "yerel yönetimli" biti (ilk baytın 2. biti): telefon/tabletlerin Wi-Fi'da kullandığı rastgele (gizli) adres.
const isRandomMac = (mac: string) => /^[0-9a-f]([26ae])/i.test(mac);
// Ad yoksa "Bilinmeyen" yerine ne olduğu hakkında ipucu veren etiket.
function deviceLabel(d: { hostname?: string | null; mac_address: string }): string {
  if (d.hostname) return d.hostname;
  return isRandomMac(d.mac_address) ? 'Adsız cihaz (gizli MAC)' : 'Adsız cihaz';
}

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
  id?: number;
  device_mac: string;
  timestamp: string;
  event_type: string;
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

  const handleDeleteGroup = async (group: DeviceGroup) => {
    if (!confirm(`"${group.name}" grubu silinsin mi? Cihazlar silinmez, yalnız grup ve üyelik kaydı kalkar.`)) return;
    try {
      await deleteApi(`/devices/groups/${group.id}`);
      if (expanded === group.id) setExpanded(null);
      toast.success('Grup silindi');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Grup silinemedi');
    }
  };

  const handleRemoveMember = async (groupId: number, mac: string) => {
    try {
      await deleteApi(`/devices/groups/${groupId}/members/${encodeURIComponent(mac)}`);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Üye çıkarılamadı');
    }
  };

  const handleAddMember = async (groupId: number) => {
    if (!selectedMac) return;
    try {
      await postApi(`/devices/groups/${groupId}/members`, { device_mac: selectedMac });
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
                        width: 28, height: 28, borderRadius: 8, background: c, border: newGroup.color === c ? '2px solid #fff' : '2px solid transparent',
                        cursor: 'pointer'
                      }}
                      onClick={() => setNewGroup({ ...newGroup, color: c })}
                    />
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label>Simge</label>
                <Select className="config-select" value={newGroup.icon}
                  onChange={e => setNewGroup({ ...newGroup, icon: e.target.value })}>
                  {iconOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
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
                  <button className="icon-btn icon-btn-sm" title="Grubu sil" aria-label={`${group.name} grubunu sil`}
                    onClick={e => { e.stopPropagation(); void handleDeleteGroup(group); }}>
                    <Trash2 size={13} />
                  </button>
                  {expanded === group.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
              </div>
              {expanded === group.id && (
                <div style={{ padding: '8px 16px 16px 56px' }}>
                  {group.members.map(m => (
                    <div key={m.mac_address} className="list-item" style={{ padding: '6px 10px', fontSize: 13 }}>
                      <span style={{ flex: 1, minWidth: 0 }}>{deviceLabel(m)}</span>
                      <span className="text-muted">{m.ip_address}</span>
                      <button className="icon-btn icon-btn-sm" title="Gruptan çıkar" aria-label="Gruptan çıkar"
                        onClick={() => handleRemoveMember(group.id, m.mac_address)}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  {group.members.length === 0 && (
                    <span className="text-muted" style={{ fontSize: 13 }}>Bu grupta henüz cihaz yok</span>
                  )}
                  {addingMember === group.id ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <Select className="config-select" value={selectedMac}
                        onChange={e => setSelectedMac(e.target.value)}>
                        <option value="">Cihaz seçin...</option>
                        {devicesData.devices.map(d => (
                          <option key={d.mac_address} value={d.mac_address}>
                            {deviceLabel(d)} ({d.ip_address})
                          </option>
                        ))}
                      </Select>
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
  const { data, refetch } = useApi<{ devices: Dev[] }>('/devices', { devices: [] });
  const [blocking, setBlocking] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const startRename = (d: Dev) => { setEditing(d.mac_address); setNameDraft(d.hostname || ''); };
  const saveName = async (mac: string) => {
    try {
      await putApi(`/devices/${encodeURIComponent(mac)}/name`, { name: nameDraft.trim() });
      setEditing(null);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ad kaydedilemedi');
    }
  };

  const handleToggleBlock = async (mac: string, currentlyBlocked: boolean) => {
    setBlocking(mac);
    try {
      await postApi(`/devices/${mac}/block`, { blocked: !currentlyBlocked });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Engel değiştirilemedi');
      await refetch();
    }
    setBlocking(null);
  };

  const isBlocked = (device: Device) => !!device.blocked;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Shield size={18} style={{ marginRight: 8 }} />Cihaz Engelleme</h3>
          <Badge variant="info">{data.devices.length} cihaz</Badge>
        </div>
        <p className="subtitle">
          Engel, internete Pi üzerinden çıkan cihazlarda çalışır (Pi ağ geçidi/DHCP olduğunda tüm cihazlar). Modem ve Pi'nin kendisi engellenemez.
          Adlar Pi'nin DHCP kayıtlarından gelir; adı gelmeyen cihaza kalem düğmesiyle ad verebilirsiniz. "Gizli MAC" genellikle
          Wi-Fi'da rastgele adres kullanan bir telefon ya da tablettir.
        </p>

        <div className="list-items">
          {data.devices.map(device => {
            const blocked = isBlocked(device);
            return (
              <div key={device.mac_address} className="list-item"
                style={blocked ? { borderLeft: '3px solid var(--danger-color)', background: 'color-mix(in srgb, var(--danger-color) 6%, transparent)' } : {}}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                  {blocked ? <WifiOff size={16} style={{ color: 'var(--danger-color)' }} /> : <Wifi size={16} style={{ color: '#10b981' }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    {editing === device.mac_address ? (
                      <div className="dev-rename">
                        <input className="config-input" value={nameDraft} maxLength={40} autoFocus
                          placeholder="Ad (boş = otomatik)" onChange={e => setNameDraft(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') void saveName(device.mac_address); if (e.key === 'Escape') setEditing(null); }} />
                        <button className="btn-primary btn-sm" onClick={() => saveName(device.mac_address)} title="Kaydet"><Check size={13} /></button>
                        <button className="btn-outline btn-sm" onClick={() => setEditing(null)} title="Vazgeç"><X size={13} /></button>
                      </div>
                    ) : (
                      <div className="dev-name">
                        <strong className={device.hostname ? '' : 'text-muted'}>{deviceLabel(device)}</strong>
                        <button className="icon-btn icon-btn-sm" onClick={() => startRename(device)}
                          title="Ad ver" aria-label="Ad ver"><Pencil size={12} /></button>
                      </div>
                    )}
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

// Arka uç olayı 'connected' diye kaydeder: cihaz ağda ilk kez ya da 5 dk'dan uzun aradan sonra yeniden görüldüğünde.
// Kopma anı kaydedilmez. (Eski arayüz 'connect' bekliyordu → her kayıt "Bağlantı Kesildi" görünüyordu.)
const EVENT_LABEL: Record<string, string> = {
  connected: 'Ağda görüldü', connect: 'Ağda görüldü', disconnected: 'Bağlantı kesildi', disconnect: 'Bağlantı kesildi',
};

function HistoryView() {
  const { data: devicesData } = useApi<{ devices: Dev[] }>('/devices', { devices: [] });
  const [selectedMac, setSelectedMac] = useState('');
  // Sonuçlar cihaz başına tutulur: seçim değiştiği anda eski yanıtın başka biçimdeki verisi (ör. {devices}) hiç
  // okunmaz — önceki sürüm bu yüzden seçim anında "events.map" ile çöküyordu.
  const [byMac, setByMac] = useState<Record<string, ConnectionEvent[] | 'error'>>({});

  useEffect(() => {
    if (!selectedMac) return;
    let alive = true;
    getApi<{ events?: ConnectionEvent[] }>(`/devices/${encodeURIComponent(selectedMac)}/history`)
      .then(d => { if (alive) setByMac(m => ({ ...m, [selectedMac]: Array.isArray(d.events) ? d.events : [] })); })
      .catch(() => { if (alive) setByMac(m => ({ ...m, [selectedMac]: 'error' })); });
    return () => { alive = false; };
  }, [selectedMac]);

  const result = selectedMac ? byMac[selectedMac] : undefined;
  const events = Array.isArray(result) ? result : [];

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Clock size={18} style={{ marginRight: 8 }} />Bağlantı Geçmişi</h3>
        </div>
        <p className="subtitle">
          Kayıt, cihaz ağda ilk kez ya da 5 dakikadan uzun aradan sonra yeniden görüldüğünde tutulur; kopma anı kaydedilmez.
        </p>

        <div style={{ padding: '0 0 12px' }}>
          <Select className="config-select" value={selectedMac}
            onChange={e => setSelectedMac(e.target.value)}
            style={{ maxWidth: 400 }}>
            <option value="">Cihaz seçin...</option>
            {devicesData.devices.map(d => (
              <option key={d.mac_address} value={d.mac_address}>
                {deviceLabel(d)} ({d.ip_address})
              </option>
            ))}
          </Select>
        </div>

        {!selectedMac ? (
          <div className="empty-state" style={{ padding: 30 }}>
            <Monitor size={32} />
            <p>Geçmişi görüntülemek için bir cihaz seçin</p>
          </div>
        ) : result === undefined ? (
          <div className="empty-state" style={{ padding: 30 }}><p>Yükleniyor…</p></div>
        ) : result === 'error' ? (
          <div className="empty-state" style={{ padding: 30 }}>
            <AlertTriangle size={32} />
            <p>Geçmiş okunamadı — sayfayı yenileyip yeniden deneyin</p>
          </div>
        ) : (
          <div className="list-items">
            {events.map((event, i) => {
              const up = event.event_type === 'connected' || event.event_type === 'connect';
              return (
                <div key={event.id ?? i} className="list-item" style={{ gap: 12 }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: up ? '#10b981' : 'var(--danger-color)',
                    flexShrink: 0
                  }} />
                  <div style={{ flex: 1 }}>
                    <strong>{EVENT_LABEL[event.event_type] || event.event_type}</strong>
                  </div>
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    {event.timestamp ? new Date(/[zZ]|[+]/.test(event.timestamp) ? event.timestamp : event.timestamp.replace(' ', 'T') + 'Z').toLocaleString('tr-TR') : ''}
                  </span>
                </div>
              );
            })}
            {events.length === 0 && (
              <div className="empty-state" style={{ padding: 30 }}>
                <Clock size={32} />
                <p>Bu cihaz için geçmiş kaydı bulunamadı</p>
              </div>
            )}
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
          background: 'color-mix(in srgb, var(--warning-color) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warning-color) 30%, transparent)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10
        }}>
          <AlertTriangle size={18} style={{ color: 'var(--warning-color)' }} />
          <span style={{ color: 'var(--warning-ink)', fontWeight: 500 }}>
            {data.devices.length} bilinmeyen cihaz tespit edildi
          </span>
        </div>
      )}

      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><AlertTriangle size={18} style={{ marginRight: 8 }} />Bilinmeyen Cihazlar</h3>
          <Badge variant="warning">{data.devices.length} cihaz</Badge>
        </div>
        <p className="subtitle">
          Ağda ilk kez görülen ve henüz "tanıyorum" demediğiniz cihazlar. Bu yalnız bir farkındalık listesidir: "Tanıyorum" demek
          cihazı listeden çıkarır, internet erişimini değiştirmez. Tanımadığınız bir cihazı Engelleme sekmesinden engelleyebilirsiniz.
        </p>

        <div className="list-items">
          {data.devices.map(device => (
            <div key={device.mac_address} className="list-item"
              style={{ borderLeft: '3px solid var(--warning-color)', background: 'color-mix(in srgb, var(--warning-color) 4%, transparent)' }}>
              <div style={{ flex: 1 }}>
                <strong>{deviceLabel(device)}</strong>
                <div className="text-muted" style={{ fontSize: 12 }}>
                  {device.ip_address} &middot; {device.mac_address}
                </div>
                <div className="text-muted" style={{ fontSize: 11 }}>
                  İlk görülme: {device.first_seen} &middot; Son görülme: {device.last_seen}
                </div>
              </div>
              <button className="btn-primary btn-sm" onClick={() => handleApprove(device.mac_address)}
                disabled={approving === device.mac_address}>
                <Check size={13} /> {approving === device.mac_address ? 'Kaydediliyor...' : 'Tanıyorum'}
              </button>
            </div>
          ))}
          {data.devices.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Check size={32} />
              <p>Tanımadığınız yeni cihaz yok</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

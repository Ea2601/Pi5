import { Bell, AlertTriangle, AlertCircle, Info, CheckCircle, Filter } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState, useMemo } from 'react';
import { Panel, Badge } from './ui';

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';

interface AlertItem {
  id: number;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: string;
  acknowledged: boolean;
  source: string;
}

interface AlertsData {
  alerts: AlertItem[];
}

export function AlertsPanel() {
  const { data, refetch } = useApi<AlertsData>('/alerts', { alerts: [] }, 10000);
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [acknowledging, setAcknowledging] = useState<number | null>(null);

  const unacknowledgedCount = useMemo(() =>
    data.alerts.filter(a => !a.acknowledged).length,
    [data.alerts]
  );

  const filteredAlerts = useMemo(() => {
    if (filter === 'all') return data.alerts;
    return data.alerts.filter(a => a.severity === filter);
  }, [data.alerts, filter]);

  const handleAcknowledge = async (id: number) => {
    setAcknowledging(id);
    try {
      await postApi(`/alerts/acknowledge/${id}`, {});
      await refetch();
    } catch { /* */ }
    setAcknowledging(null);
  };

  const severityIcon = (severity: string) => {
    switch (severity) {
      case 'critical': return <AlertCircle size={16} />;
      case 'warning': return <AlertTriangle size={16} />;
      default: return <Info size={16} />;
    }
  };

  const severityBadge = (severity: string): 'error' | 'warning' | 'info' => {
    switch (severity) {
      case 'critical': return 'error';
      case 'warning': return 'warning';
      default: return 'info';
    }
  };

  const severityLabel = (severity: string) => {
    switch (severity) {
      case 'critical': return 'Kritik';
      case 'warning': return 'Uyari';
      default: return 'Bilgi';
    }
  };

  const tabs: { id: SeverityFilter; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: 'Tumunu', icon: <Filter size={14} /> },
    { id: 'critical', label: 'Kritik', icon: <AlertCircle size={14} /> },
    { id: 'warning', label: 'Uyari', icon: <AlertTriangle size={14} /> },
    { id: 'info', label: 'Bilgi', icon: <Info size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel title="Uyari Merkezi" icon={<Bell size={20} style={{ marginRight: 8 }} />}
        subtitle="Sistem uyarilari ve bildirimler"
        badge={
          unacknowledgedCount > 0 ? (
            <Badge variant="error">{unacknowledgedCount} yeni</Badge>
          ) : (
            <Badge variant="success">Temiz</Badge>
          )
        }>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${filter === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setFilter(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      <div style={{ marginTop: 14 }}>
        <Panel title="Uyarilar">
          <div className="blocked-list">
            {filteredAlerts.length === 0 && (
              <div className="empty-state" style={{ padding: '20px' }}>Uyari bulunamadi.</div>
            )}
            {filteredAlerts.map(alert => (
              <div key={alert.id}
                className={`ban-row ${alert.acknowledged ? '' : 'list-item'}`}
                style={{ opacity: alert.acknowledged ? 0.6 : 1 }}>
                <span className={`stat-icon-${severityBadge(alert.severity) === 'error' ? 'orange' : severityBadge(alert.severity) === 'warning' ? 'orange' : 'blue'}`}
                  style={{ display: 'flex', alignItems: 'center' }}>
                  {severityIcon(alert.severity)}
                </span>
                <Badge variant={severityBadge(alert.severity)}>
                  {severityLabel(alert.severity)}
                </Badge>
                <div style={{ flex: 2 }}>
                  <span style={{ fontSize: '0.85rem' }}>{alert.message}</span>
                  <br />
                  <span className="text-muted" style={{ fontSize: '0.7rem' }}>
                    {alert.source} &middot; {new Date(alert.timestamp).toLocaleString('tr-TR')}
                  </span>
                </div>
                {!alert.acknowledged && (
                  <button className="btn-outline btn-sm"
                    onClick={() => handleAcknowledge(alert.id)}
                    disabled={acknowledging === alert.id}>
                    <CheckCircle size={12} />
                    {acknowledging === alert.id ? 'Isleniyor...' : 'Onayla'}
                  </button>
                )}
                {alert.acknowledged && (
                  <span className="text-muted" style={{ fontSize: '0.7rem' }}>
                    <CheckCircle size={12} /> Onaylandi
                  </span>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

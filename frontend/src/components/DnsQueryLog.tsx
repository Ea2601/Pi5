import { Search, Shield, ShieldOff, Monitor, Filter } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useState, useMemo } from 'react';
import { Panel, Badge } from './ui';

type FilterType = 'all' | 'blocked' | 'allowed';

interface DnsQuery {
  id: number;
  timestamp: string;
  clientIp: string;
  domain: string;
  queryType: string;
  status: 'blocked' | 'allowed';
}

interface DnsQueryData {
  queries: DnsQuery[];
  totalBlocked: number;
  totalAllowed: number;
}

export function DnsQueryLog() {
  const { data } = useApi<DnsQueryData>('/dns/queries', {
    queries: [], totalBlocked: 0, totalAllowed: 0,
  }, 3000);

  const [filter, setFilter] = useState<FilterType>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');

  const uniqueClients = useMemo(() => {
    const ips = new Set(data.queries.map(q => q.clientIp));
    return Array.from(ips).sort();
  }, [data.queries]);

  const filteredQueries = useMemo(() => {
    return data.queries.filter(q => {
      if (filter === 'blocked' && q.status !== 'blocked') return false;
      if (filter === 'allowed' && q.status !== 'allowed') return false;
      if (deviceFilter && q.clientIp !== deviceFilter) return false;
      if (searchTerm && !q.domain.toLowerCase().includes(searchTerm.toLowerCase())) return false;
      return true;
    });
  }, [data.queries, filter, searchTerm, deviceFilter]);

  const filterTabs: { id: FilterType; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: 'Tumunu', icon: <Filter size={14} /> },
    { id: 'blocked', label: 'Engellenen', icon: <ShieldOff size={14} /> },
    { id: 'allowed', label: 'Izin Verilen', icon: <Shield size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel title="DNS Sorgu Kayitlari" icon={<Monitor size={20} style={{ marginRight: 8 }} />}
        subtitle="Gercek zamanli DNS sorgu izleme"
        badge={
          <>
            <Badge variant="error">{data.totalBlocked} engellenen</Badge>
            <Badge variant="success">{data.totalAllowed} izin verilen</Badge>
          </>
        }>
        <div className="service-tabs">
          {filterTabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${filter === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setFilter(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      <div style={{ marginTop: 14 }}>
        <Panel title="Sorgular">
          <div className="list-add-form">
            <div className="list-add-row">
              <div className="config-input-wrapper" style={{ flex: 2 }}>
                <Search size={14} className="text-muted" />
                <input className="config-input" type="text"
                  placeholder="Domain ara..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)} />
              </div>
              <select className="config-input" value={deviceFilter}
                onChange={e => setDeviceFilter(e.target.value)}
                style={{ flex: 1 }}>
                <option value="">Tum Cihazlar</option>
                {uniqueClients.map(ip => (
                  <option key={ip} value={ip}>{ip}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="log-container" style={{ maxHeight: '500px', overflowY: 'auto' }}>
            <div className="blocked-list">
              {filteredQueries.length === 0 && (
                <div className="empty-state" style={{ padding: '20px' }}>Sorgu bulunamadi.</div>
              )}
              {filteredQueries.map(query => (
                <div key={query.id} className="ban-row">
                  <span className="text-muted" style={{ fontSize: '0.7rem', minWidth: '70px' }}>
                    {new Date(query.timestamp).toLocaleTimeString('tr-TR')}
                  </span>
                  <span className="ban-ip" style={{ minWidth: '110px' }}>{query.clientIp}</span>
                  <span style={{ flex: 2, fontFamily: 'monospace', fontSize: '0.8rem' }}>{query.domain}</span>
                  <Badge variant="neutral">{query.queryType}</Badge>
                  <Badge variant={query.status === 'blocked' ? 'error' : 'success'}>
                    {query.status === 'blocked' ? 'Engellendi' : 'Izin Verildi'}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

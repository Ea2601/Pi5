import {
  ShieldCheck, Wifi, Activity, BarChart3,
  Thermometer, Cpu, MemoryStick, HardDrive, Clock, ArrowUpDown, Fan, Server, Globe
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart
} from 'recharts';
import { useApi } from '../hooks/useApi';
import { useMetricHistory } from '../hooks/useMetricHistory';
import { Panel, StatCard, ProgressMetric, Badge } from './ui';
import type { SystemStats, ServiceStatus, HealthStatus, VpsServer } from '../types';

// Her 20. noktada bir zaman etiketi göster (120 nokta → 6 etiket)
const LABEL_INTERVAL = 20;

// Zaman etiketini HH:MM formatına kısalt (saniyeyi tooltip'te göster)
function shortTime(time: string) {
  // "14:32:05" → "14:32"
  const parts = time.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : time;
}

const tooltipStyle = {
  background: '#111820',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  fontSize: 12,
};

const axisTickStyle = { fill: '#64748b', fontSize: 10 };

export function Dashboard() {
  const { data: stats } = useApi<SystemStats>('/system/stats', {
    cpuTemp: 0, cpuUsage: 0, memoryTotal: 0, memoryUsed: 0,
    diskTotal: 0, diskUsed: 0, uptime: 0, loadAvg: [0, 0, 0],
  }, 5000);

  const { data: health } = useApi<HealthStatus>('/system/health', {
    isFailOpen: false, lastCheckTime: '', lastCheckResult: 'pending',
    checksTotal: 0, checksFailed: 0, uptimePercent: 100,
  }, 10000);

  const { data: svcData } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const { data: piholeData } = useApi<{ adsBlockedToday: number; dnsQueriesToday: number; uniqueClients: number }>(
    '/pihole/stats', { adsBlockedToday: 0, dnsQueriesToday: 0, uniqueClients: 0 }
  );
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] }, 30000);

  // 3s aralık, 120 nokta, son 20 verinin hareketli ortalaması uygulanmış
  const history = useMetricHistory(3000);

  const formatUptime = (s: number) => s <= 0 ? '—' : `${Math.floor(s / 86400)}g ${Math.floor((s % 86400) / 3600)}s`;
  const memPercent = stats.memoryTotal > 0 ? Math.round((stats.memoryUsed / stats.memoryTotal) * 100) : 0;
  const diskPercent = stats.diskTotal > 0 ? Math.round((stats.diskUsed / stats.diskTotal) * 100) : 0;
  const activeServices = svcData.services.filter(s => s.enabled).length;
  const latest = history[history.length - 1];

  return (
    <div className="fade-in">
      <Panel title="Sistem Genel Bakış" subtitle="Pi 5 Secure Gateway — Tüm ağ arayüzleri korumalı"
        badge={<Badge variant={health.isFailOpen ? 'error' : 'success'}>{health.isFailOpen ? 'FAIL-OPEN' : 'Korumalı'}</Badge>}>
        <div className="stats-grid stats-grid-4">
          <StatCard icon={<ShieldCheck size={20} />} label="Engellenen Reklam" value={piholeData.adsBlockedToday.toLocaleString('tr-TR')} color="blue" />
          <StatCard icon={<Wifi size={20} />} label="Aktif Cihaz" value={piholeData.uniqueClients} color="green" />
          <StatCard icon={<Activity size={20} />} label="DNS Sorguları" value={piholeData.dnsQueriesToday.toLocaleString('tr-TR')} color="emerald" />
          <StatCard icon={<BarChart3 size={20} />} label="Aktif Servis" value={`${activeServices}/${svcData.services.length}`} color="purple" />
        </div>
      </Panel>

      {/* Gerçek zamanlı grafikler — 6 dakikalık pencere, 3sn güncelleme, yumuşatılmış */}
      <div className="panel-row" style={{ marginTop: 14 }}>
        <div className="glass-panel widget-medium">
          <h4 className="widget-title"><Thermometer size={14} /> CPU Sıcaklık & Fan <span className="chart-time">Son 6 dk — 3sn aralık</span></h4>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={history}>
              <defs>
                <linearGradient id="gradTemp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={axisTickStyle} axisLine={false} tickLine={false}
                interval={LABEL_INTERVAL} tickFormatter={shortTime} />
              <YAxis domain={[30, 80]} tick={axisTickStyle} axisLine={false} tickLine={false} width={30}
                tickFormatter={(v: number) => `${v}°`} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#94a3b8' }}
                formatter={(v: any) => [`${v.toFixed(2)}°C`, 'Sıcaklık']} />
              <Area type="monotone" dataKey="cpuTemp" stroke="#f97316" fill="url(#gradTemp)"
                name="Sıcaklık °C" strokeWidth={2} dot={false} animationDuration={300} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div className="chart-legend">
            <span><Fan size={12} /> Fan: {latest ? Math.round(latest.fanSpeed) : 0} RPM</span>
            <span><Thermometer size={12} /> {latest ? latest.cpuTemp.toFixed(2) : '0.00'}°C</span>
          </div>
        </div>

        <div className="glass-panel widget-medium">
          <h4 className="widget-title"><Activity size={14} /> Ağ Trafiği (Mbps) <span className="chart-time">Son 6 dk</span></h4>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={history}>
              <defs>
                <linearGradient id="gradIn" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradOut" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={axisTickStyle} axisLine={false} tickLine={false}
                interval={LABEL_INTERVAL} tickFormatter={shortTime} />
              <YAxis tick={axisTickStyle} axisLine={false} tickLine={false} width={30} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#94a3b8' }}
                formatter={(v: any, name: any) => [`${Number(v).toFixed(2)} Mbps`, name]} />
              <Area type="monotone" dataKey="networkIn" stroke="#22c55e" fill="url(#gradIn)"
                name="↓ Download" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="networkOut" stroke="#3b82f6" fill="url(#gradOut)"
                name="↑ Upload" strokeWidth={2} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel-row" style={{ marginTop: 14 }}>
        <div className="glass-panel widget-medium">
          <h4 className="widget-title"><Cpu size={14} /> CPU & Bellek Kullanımı <span className="chart-time">Son 6 dk</span></h4>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={history}>
              <XAxis dataKey="time" tick={axisTickStyle} axisLine={false} tickLine={false}
                interval={LABEL_INTERVAL} tickFormatter={shortTime} />
              <YAxis domain={[0, 100]} tick={axisTickStyle} axisLine={false} tickLine={false} width={30}
                tickFormatter={(v: number) => `${v}%`} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#94a3b8' }}
                formatter={(v: any, name: any) => [`${Number(v).toFixed(2)}%`, name]} />
              <Line type="monotone" dataKey="cpuUsage" stroke="#3b82f6" name="CPU" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="memoryUsage" stroke="#a855f7" name="Bellek" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-panel widget-medium">
          <h4 className="widget-title"><HardDrive size={14} /> Disk I/O (MB/s) <span className="chart-time">Son 6 dk</span></h4>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={history}>
              <defs>
                <linearGradient id="gradRead" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradWrite" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={axisTickStyle} axisLine={false} tickLine={false}
                interval={LABEL_INTERVAL} tickFormatter={shortTime} />
              <YAxis tick={axisTickStyle} axisLine={false} tickLine={false} width={30} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#94a3b8' }}
                formatter={(v: any, name: any) => [`${Number(v).toFixed(2)} MB/s`, name]} />
              <Area type="monotone" dataKey="diskRead" stroke="#06b6d4" fill="url(#gradRead)"
                name="Read" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="diskWrite" stroke="#f59e0b" fill="url(#gradWrite)"
                name="Write" strokeWidth={2} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Donanım & Servisler */}
      <div className="panel-row" style={{ marginTop: 14 }}>
        <Panel title="Donanım" size="medium">
          <div className="hw-stats">
            <ProgressMetric icon={<Thermometer size={14} />} label="CPU Sıcaklık" value={`${stats.cpuTemp}°C`}
              percent={stats.cpuTemp / 85 * 100} variant="temp"
              valueClass={stats.cpuTemp > 70 ? 'text-danger' : stats.cpuTemp > 55 ? 'text-warning' : ''} />
            <ProgressMetric icon={<Cpu size={14} />} label="CPU Kullanım" value={`${stats.cpuUsage}%`} percent={stats.cpuUsage} variant="cpu" />
            <ProgressMetric icon={<MemoryStick size={14} />} label="Bellek" value={`${memPercent}%`} percent={memPercent} variant="mem" />
            <ProgressMetric icon={<HardDrive size={14} />} label="Disk" value={`${stats.diskUsed}/${stats.diskTotal} GB`} percent={diskPercent} variant="disk" />
          </div>
        </Panel>

        <Panel title="Servis Durumu" size="medium">
          <div className="service-list">
            {svcData.services.map(svc => (
              <div key={svc.name} className="service-row">
                <span className={`svc-dot ${svc.enabled ? 'svc-on' : 'svc-off'}`} />
                <span className="svc-name">{svc.name}</span>
                <span className={`svc-status ${svc.enabled ? 'text-success' : ''}`}>
                  {svc.enabled ? 'Çalışıyor' : 'Durduruldu'}
                </span>
              </div>
            ))}
          </div>
          <div className="hw-stat" style={{ marginTop: 16 }}>
            <div className="hw-stat-header"><Clock size={14} /><span>Uptime</span><span className="hw-val">{formatUptime(stats.uptime)}</span></div>
            <div className="hw-stat-header" style={{ marginTop: 6 }}><ArrowUpDown size={14} /><span>Load Avg</span><span className="hw-val">{stats.loadAvg.map(l => l.toFixed(2)).join(' / ')}</span></div>
          </div>
        </Panel>
      </div>

      {/* Aktif VPN Tünelleri */}
      {vpsData.servers.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="VPN Tünelleri" size="full"
            badge={<Badge variant="info">{vpsData.servers.filter(s => s.status === 'connected').length} aktif</Badge>}>
            <div className="vpn-grid">
              {vpsData.servers.map(vps => {
                const isConnected = vps.status === 'connected';
                return (
                  <div key={vps.id} className={`vpn-card ${isConnected ? 'vpn-connected' : 'vpn-disconnected'}`}>
                    <div className="vpn-card-header">
                      <Server size={16} />
                      <span className={`svc-dot ${isConnected ? 'svc-on' : 'svc-off'}`} />
                    </div>
                    <div className="vpn-card-location">
                      <Globe size={13} />
                      <strong>{vps.location || 'VPS'}</strong>
                    </div>
                    <div className="vpn-card-ip">{vps.ip}</div>
                    <Badge variant={isConnected ? 'success' : 'neutral'}>
                      {isConnected ? 'Bağlı' : vps.status === 'error' ? 'Hata' : 'Bağlı Değil'}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

import { Gauge, Play, ArrowDown, ArrowUp, Clock, Loader } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard } from './ui';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { SpeedTestResult } from '../types';

export function SpeedTestPanel() {
  const { data, refetch } = useApi<{ tests: SpeedTestResult[] }>('/speedtest/history', { tests: [] });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');

  const handleRun = async () => {
    setRunning(true);
    setProgress('Test baslatiliyor...');
    try {
      setProgress('Hiz olculuyor...');
      await postApi('/speedtest/run', {});
      setProgress('Tamamlandi!');
      await refetch();
    } catch {
      setProgress('Test basarisiz oldu.');
    }
    setRunning(false);
  };

  const latest = data.tests.length > 0 ? data.tests[0] : null;

  const chartData = data.tests.slice().reverse().map(r => ({
    date: new Date(r.timestamp).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }),
    indirme: r.download_mbps,
    yukleme: r.upload_mbps,
    ping: r.ping_ms,
  }));

  return (
    <div className="fade-in">
      <Panel title="Hiz Testi" icon={<Gauge size={20} style={{ marginRight: 8 }} />}
        subtitle="Internet baglanti hizini olc ve gecmisi goruntule"
        actions={
          <button className="btn-primary btn-sm" onClick={handleRun} disabled={running}>
            {running ? <><Loader size={14} className="spin-icon" /> Test Yapiliyor...</> : <><Play size={14} /> Test Baslat</>}
          </button>
        }>
        {running && progress && (
          <div className="pihole-flow">
            <Loader size={14} className="spin-icon" />
            <span>{progress}</span>
          </div>
        )}
      </Panel>

      <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
        <StatCard icon={<ArrowDown size={20} />} label="Indirme Hizi"
          value={latest ? `${latest.download_mbps.toFixed(1)} Mbps` : '---'} color="blue" />
        <StatCard icon={<ArrowUp size={20} />} label="Yukleme Hizi"
          value={latest ? `${latest.upload_mbps.toFixed(1)} Mbps` : '---'} color="green" />
        <StatCard icon={<Clock size={20} />} label="Ping"
          value={latest ? `${latest.ping_ms.toFixed(0)} ms` : '---'} color="orange" />
        <StatCard icon={<Gauge size={20} />} label="Sunucu"
          value={latest?.server || '---'} color="purple" />
      </div>

      {latest && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Son Test Sonucu">
            <div className="speed-gauge-container" style={{ textAlign: 'center', padding: '20px 0' }}>
              <div className="stats-grid" style={{ maxWidth: '500px', margin: '0 auto' }}>
                <div className="stat-card">
                  <div className="stat-icon stat-icon-blue"><ArrowDown size={28} /></div>
                  <div className="stat-info">
                    <span className="stat-label">Indirme</span>
                    <span className="stat-value" style={{ fontSize: '2rem' }}>{latest.download_mbps.toFixed(1)}</span>
                    <span className="stat-label">Mbps</span>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-icon-green"><ArrowUp size={28} /></div>
                  <div className="stat-info">
                    <span className="stat-label">Yukleme</span>
                    <span className="stat-value" style={{ fontSize: '2rem' }}>{latest.upload_mbps.toFixed(1)}</span>
                    <span className="stat-label">Mbps</span>
                  </div>
                </div>
              </div>
              <p className="text-muted" style={{ marginTop: 12, fontSize: '0.8rem' }}>
                {new Date(latest.timestamp).toLocaleString('tr-TR')} &middot; {latest.server}
              </p>
            </div>
          </Panel>
        </div>
      )}

      {chartData.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Hiz Gecmisi">
            <div style={{ width: '100%', height: 260 }}>
              <ResponsiveContainer>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="downloadGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="uploadGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 11 }} />
                  <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: 'rgba(15,20,35,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }}
                    labelStyle={{ color: 'rgba(255,255,255,0.7)' }} />
                  <Area type="monotone" dataKey="indirme" stroke="#3b82f6" fill="url(#downloadGrad)" strokeWidth={2} />
                  <Area type="monotone" dataKey="yukleme" stroke="#10b981" fill="url(#uploadGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
      )}

      {data.tests.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Test Gecmisi">
            <div className="blocked-list">
              {data.tests.map(result => (
                <div key={result.id} className="ban-row">
                  <span className="text-muted" style={{ fontSize: '0.75rem', minWidth: '120px' }}>
                    {new Date(result.timestamp).toLocaleString('tr-TR')}
                  </span>
                  <span style={{ flex: 1 }}>
                    <ArrowDown size={12} /> {result.download_mbps.toFixed(1)} Mbps
                  </span>
                  <span style={{ flex: 1 }}>
                    <ArrowUp size={12} /> {result.upload_mbps.toFixed(1)} Mbps
                  </span>
                  <span style={{ flex: 0.5 }}>
                    <Clock size={12} /> {result.ping_ms.toFixed(0)} ms
                  </span>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>{result.server}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

import { Gauge, Play, ArrowDown, ArrowUp, Clock, Loader2, AlertTriangle } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { SpeedTestResult } from '../types';

export function SpeedTestPanel() {
  const { data, refetch } = useApi<{ tests: SpeedTestResult[] }>('/speedtest/history', { tests: [] });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);

  const handleRun = async () => {
    setRunning(true);
    setProgress('Baglanti hazirlaniyor...');
    setError('');
    setElapsed(0);

    // Gercek sure sayaci
    const startTime = Date.now();
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      setElapsed(secs);
      if (secs < 15) setProgress('Indirme hizi olculuyor...');
      else if (secs < 40) setProgress('Yukleme hizi olculuyor...');
      else setProgress('Sonuclar hesaplaniyor...');
    }, 1000);

    try {
      const result = await postApi('/speedtest/run', {});
      clearInterval(timer);
      if (result.error) {
        setError(result.error);
        setProgress('');
      } else {
        setProgress(`Tamamlandi! (${Math.floor((Date.now() - startTime) / 1000)} saniye)`);
        await refetch();
      }
    } catch (e: any) {
      clearInterval(timer);
      const msg = e?.message || '';
      if (msg.includes('503') || msg.includes('speedtest-cli')) {
        setError('speedtest-cli kurulu degil. Pi5 uzerinde: sudo apt install speedtest-cli');
      } else if (msg.includes('gelistirme')) {
        setError('Hiz testi sadece Pi5 uzerinde calisir.');
      } else {
        setError(msg || 'Test basarisiz oldu.');
      }
      setProgress('');
    }
    setRunning(false);
  };

  const latest = data.tests.length > 0 ? data.tests[0] : null;

  const chartData = data.tests.slice().reverse().map(r => ({
    date: new Date(r.timestamp).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    indirme: r.download_mbps,
    yukleme: r.upload_mbps,
  }));

  return (
    <div className="fade-in">
      <Panel title="Hiz Testi" icon={<Gauge size={20} style={{ marginRight: 8 }} />}
        subtitle="Internet baglanti hizini olcun — gercek speedtest-cli ile (30-60 saniye surer)"
        actions={
          <button className="btn-primary btn-sm" onClick={handleRun} disabled={running}>
            {running ? <><Loader2 size={14} className="spin" /> Test Yapiliyor ({elapsed}s)...</> : <><Play size={14} /> Test Baslat</>}
          </button>
        }>

        {running && progress && (
          <div className="alert alert-success" style={{ marginTop: 8 }}>
            <Loader2 size={14} className="spin" />
            <span>{progress}</span>
          </div>
        )}

        {error && (
          <div className="alert alert-error" style={{ marginTop: 8 }}>
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {!running && !error && !latest && data.tests.length === 0 && (
          <div className="empty-state" style={{ padding: 30, marginTop: 8 }}>
            <Gauge size={40} />
            <p>Henuz hiz testi yapilmadi</p>
            <p className="text-muted" style={{ fontSize: 12 }}>
              "Test Baslat" butonuna basin. Test 30-60 saniye surer.
              <br />Pi5 uzerinde speedtest-cli kurulu olmali: <code>sudo apt install speedtest-cli</code>
            </p>
          </div>
        )}
      </Panel>

      {latest && (
        <>
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<ArrowDown size={20} />} label="Indirme" value={`${latest.download_mbps.toFixed(2)} Mbps`} color="blue" />
            <StatCard icon={<ArrowUp size={20} />} label="Yukleme" value={`${latest.upload_mbps.toFixed(2)} Mbps`} color="green" />
            <StatCard icon={<Clock size={20} />} label="Ping" value={`${latest.ping_ms.toFixed(2)} ms`} color="orange" />
            <StatCard icon={<Gauge size={20} />} label="Sunucu" value={latest.server || '---'} color="purple" />
          </div>

          <div style={{ marginTop: 14 }}>
            <Panel title="Son Test" subtitle={new Date(latest.timestamp).toLocaleString('tr-TR') + ' — ' + latest.server}>
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div className="stats-grid" style={{ maxWidth: 500, margin: '0 auto' }}>
                  <div className="stat-card">
                    <div className="stat-icon stat-icon-blue"><ArrowDown size={28} /></div>
                    <div className="stat-info">
                      <span className="stat-label">Indirme</span>
                      <span className="stat-value" style={{ fontSize: '2rem' }}>{latest.download_mbps.toFixed(2)}</span>
                      <span className="stat-label">Mbps</span>
                    </div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-icon stat-icon-green"><ArrowUp size={28} /></div>
                    <div className="stat-info">
                      <span className="stat-label">Yukleme</span>
                      <span className="stat-value" style={{ fontSize: '2rem' }}>{latest.upload_mbps.toFixed(2)}</span>
                      <span className="stat-label">Mbps</span>
                    </div>
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        </>
      )}

      {chartData.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Hiz Gecmisi" badge={<Badge variant="info">{data.tests.length} test</Badge>}>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="dlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="ulGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} />
                  <YAxis stroke="rgba(255,255,255,0.4)" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#111820', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="indirme" stroke="#3b82f6" fill="url(#dlGrad)" strokeWidth={2} name="Indirme Mbps" />
                  <Area type="monotone" dataKey="yukleme" stroke="#10b981" fill="url(#ulGrad)" strokeWidth={2} name="Yukleme Mbps" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>
      )}

      {data.tests.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Test Gecmisi">
            <div className="list-items">
              {data.tests.map(t => (
                <div key={t.id} className="list-item">
                  <div className="list-item-content">
                    <span className="list-item-value">
                      <ArrowDown size={12} /> {t.download_mbps.toFixed(2)} Mbps &nbsp;
                      <ArrowUp size={12} /> {t.upload_mbps.toFixed(2)} Mbps &nbsp;
                      <Clock size={12} /> {t.ping_ms.toFixed(2)} ms
                    </span>
                    <span className="list-item-comment">
                      {new Date(t.timestamp).toLocaleString('tr-TR')} — {t.server}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

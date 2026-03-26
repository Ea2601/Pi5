import { Gauge, Play, ArrowDown, ArrowUp, Clock, Loader2, AlertTriangle, Zap, Wifi, Server } from 'lucide-react';
import { useApi, postApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { SpeedTestResult } from '../types';

type Period = '24h' | '7d' | '30d';

export function SpeedTestPanel() {
  const [period, setPeriod] = useState<Period>('7d');
  const { data, refetch } = useApi<{ tests: SpeedTestResult[] }>(`/speedtest/history?period=${period}`, { tests: [] });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);

  const handleRun = async () => {
    setRunning(true);
    setProgress('Bağlantı hazırlanıyor...');
    setError('');
    setElapsed(0);

    const startTime = Date.now();
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      setElapsed(secs);
      if (secs < 15) setProgress('İndirme hızı ölçülüyor...');
      else if (secs < 40) setProgress('Yükleme hızı ölçülüyor...');
      else setProgress('Sonuçlar hesaplanıyor...');
    }, 1000);

    try {
      const result = await postApi('/speedtest/run', {});
      clearInterval(timer);
      if (result.error) {
        setError(result.error);
        setProgress('');
      } else {
        setProgress(`Tamamlandı! (${Math.floor((Date.now() - startTime) / 1000)} saniye)`);
        await refetch();
      }
    } catch (e: any) {
      clearInterval(timer);
      setError(e?.message || 'Test başarısız oldu.');
      setProgress('');
    }
    setRunning(false);
  };

  const latest = data.tests.length > 0 ? data.tests[0] : null;

  const chartData = data.tests.slice().reverse().map(r => ({
    date: new Date(r.timestamp).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    indirme: r.download_mbps,
    yukleme: r.upload_mbps,
    ping: r.ping_ms,
    jitter: r.jitter_ms || 0,
  }));

  const avgDown = data.tests.length > 0 ? (data.tests.reduce((s, t) => s + t.download_mbps, 0) / data.tests.length).toFixed(1) : '0';
  const avgUp = data.tests.length > 0 ? (data.tests.reduce((s, t) => s + t.upload_mbps, 0) / data.tests.length).toFixed(1) : '0';
  const avgPing = data.tests.length > 0 ? (data.tests.reduce((s, t) => s + t.ping_ms, 0) / data.tests.length).toFixed(1) : '0';

  return (
    <div className="fade-in">
      <Panel title="Hız Testi" icon={<Gauge size={20} style={{ marginRight: 8 }} />}
        subtitle="Her 10 dakikada otomatik ölçüm — jitter, packet loss dahil"
        actions={
          <button className="btn-primary btn-sm" onClick={handleRun} disabled={running}>
            {running ? <><Loader2 size={14} className="spin" /> Test ({elapsed}s)...</> : <><Play size={14} /> Manuel Test</>}
          </button>
        }>

        {running && progress && (
          <div className="alert alert-success" style={{ marginTop: 8 }}>
            <Loader2 size={14} className="spin" /><span>{progress}</span>
          </div>
        )}
        {error && (
          <div className="alert alert-error" style={{ marginTop: 8 }}>
            <AlertTriangle size={14} /><span>{error}</span>
          </div>
        )}
      </Panel>

      {/* Son test detaylı sonuç */}
      {latest && (
        <div className="stats-grid stats-grid-4" style={{ marginTop: 14, gap: 10 }}>
          <StatCard icon={<ArrowDown size={20} />} label="İndirme" value={`${latest.download_mbps.toFixed(1)} Mbps`} color="blue" />
          <StatCard icon={<ArrowUp size={20} />} label="Yükleme" value={`${latest.upload_mbps.toFixed(1)} Mbps`} color="green" />
          <StatCard icon={<Clock size={20} />} label="Ping" value={`${latest.ping_ms.toFixed(1)} ms`} color="orange" />
          <StatCard icon={<Zap size={20} />} label="Jitter" value={`${(latest.jitter_ms || 0).toFixed(1)} ms`} color="purple" />
        </div>
      )}

      {latest && (
        <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="glass-panel" style={{ flex: 1, minWidth: 200, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wifi size={14} style={{ color: 'var(--accent-color)' }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Packet Loss:</span>
            <strong style={{ fontSize: 13 }}>{(latest.packet_loss || 0).toFixed(2)}%</strong>
          </div>
          <div className="glass-panel" style={{ flex: 1, minWidth: 200, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Server size={14} style={{ color: 'var(--accent-color)' }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sunucu:</span>
            <strong style={{ fontSize: 12 }}>{latest.server}</strong>
          </div>
          <div className="glass-panel" style={{ flex: 1, minWidth: 200, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Gauge size={14} style={{ color: 'var(--accent-color)' }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ISP:</span>
            <strong style={{ fontSize: 12 }}>{latest.isp || '—'}</strong>
          </div>
        </div>
      )}

      {/* Grafik + filtreleme */}
      {chartData.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Hız Geçmişi"
            badge={<Badge variant="info">{data.tests.length} test</Badge>}
            actions={
              <div style={{ display: 'flex', gap: 4 }}>
                {(['24h', '7d', '30d'] as Period[]).map(p => (
                  <button key={p}
                    className={`btn-sm ${period === p ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setPeriod(p)}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    {p === '24h' ? '24 Saat' : p === '7d' ? '7 Gün' : '30 Gün'}
                  </button>
                ))}
              </div>
            }>
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
                  <Area type="monotone" dataKey="indirme" stroke="#3b82f6" fill="url(#dlGrad)" strokeWidth={2} name="İndirme Mbps" />
                  <Area type="monotone" dataKey="yukleme" stroke="#10b981" fill="url(#ulGrad)" strokeWidth={2} name="Yükleme Mbps" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Ortalamalar */}
            <div style={{ display: 'flex', gap: 16, marginTop: 10, justifyContent: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
              <span>Ort. İndirme: <strong style={{ color: '#3b82f6' }}>{avgDown} Mbps</strong></span>
              <span>Ort. Yükleme: <strong style={{ color: '#10b981' }}>{avgUp} Mbps</strong></span>
              <span>Ort. Ping: <strong style={{ color: '#f59e0b' }}>{avgPing} ms</strong></span>
            </div>
          </Panel>
        </div>
      )}

      {/* Detaylı tablo */}
      {data.tests.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Panel title="Test Geçmişi">
            <div className="list-items">
              <div className="routing-row routing-header-row">
                <span style={{ flex: 1 }}>Tarih</span>
                <span style={{ width: 80 }}>İndirme</span>
                <span style={{ width: 80 }}>Yükleme</span>
                <span style={{ width: 60 }}>Ping</span>
                <span style={{ width: 60 }}>Jitter</span>
                <span style={{ width: 60 }}>P.Loss</span>
                <span style={{ flex: 1 }}>Sunucu</span>
              </div>
              {data.tests.slice(0, 100).map(t => (
                <div key={t.id} className="routing-row" style={{ fontSize: 12 }}>
                  <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {new Date(t.timestamp).toLocaleString('tr-TR')}
                  </span>
                  <span style={{ width: 80, color: '#3b82f6', fontWeight: 600 }}>{t.download_mbps.toFixed(1)}</span>
                  <span style={{ width: 80, color: '#10b981', fontWeight: 600 }}>{t.upload_mbps.toFixed(1)}</span>
                  <span style={{ width: 60 }}>{t.ping_ms.toFixed(1)}</span>
                  <span style={{ width: 60 }}>{(t.jitter_ms || 0).toFixed(1)}</span>
                  <span style={{ width: 60, color: (t.packet_loss || 0) > 1 ? 'var(--danger-color)' : '' }}>
                    {(t.packet_loss || 0).toFixed(2)}%
                  </span>
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>{t.server}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

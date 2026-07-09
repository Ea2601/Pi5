import { useState, useEffect, useRef, useCallback } from 'react';
import type { MetricSnapshot } from '../types';

// Gerçek metrik geçmişi — backend'den (/system/stats + /bandwidth/live) periyodik örnekleme.
// Mock/rastgele veri YOK; kaynak olmayan metrikler 0 döner.
const MAX_POINTS = 120; // 120 nokta × 3sn = 6 dakikalık pencere

function formatTime(date: Date): string {
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function fetchJSON(url: string): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export function useMetricHistory(intervalMs = 3000) {
  const [history, setHistory] = useState<MetricSnapshot[]>([]);
  const rawRef = useRef<MetricSnapshot[]>([]);

  const tick = useCallback(async () => {
    const [stats, bw] = await Promise.all([
      fetchJSON('/api/system/stats'),
      fetchJSON('/api/bandwidth/live'),
    ]);

    const memoryUsage = stats && stats.memoryTotal > 0
      ? Math.round((stats.memoryUsed / stats.memoryTotal) * 1000) / 10
      : 0;

    // Ağ hızı: tüm arayüzlerin toplam rx/tx (bytes/s) → Mbps
    let rxBps = 0, txBps = 0;
    if (bw && Array.isArray(bw.interfaces)) {
      for (const i of bw.interfaces) {
        rxBps += i.rx_speed_bps || 0;
        txBps += i.tx_speed_bps || 0;
      }
    }

    const snapshot: MetricSnapshot = {
      time: formatTime(new Date()),
      cpuTemp: stats?.cpuTemp ?? 0,
      cpuUsage: stats?.cpuUsage ?? 0,
      memoryUsage,
      networkIn: Math.round((rxBps * 8 / 1_000_000) * 100) / 100,  // Mbps
      networkOut: Math.round((txBps * 8 / 1_000_000) * 100) / 100, // Mbps
      diskRead: stats?.diskRead ?? 0,
      diskWrite: stats?.diskWrite ?? 0,
      fanSpeed: stats?.fanSpeed ?? 0,
    };

    rawRef.current = [...rawRef.current, snapshot].slice(-MAX_POINTS);
    setHistory(rawRef.current);
  }, []);

  useEffect(() => {
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [tick, intervalMs]);

  return history;
}

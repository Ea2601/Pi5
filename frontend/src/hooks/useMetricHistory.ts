import { useState, useEffect, useRef, useCallback } from 'react';
import type { MetricSnapshot } from '../types';

// Metrik geçmişi artık backend tarafında diske yazılıyor (her ~5sn bir örnek) ve son 10 dk
// buradan okunuyor. Böylece sayfa yenilense bile grafik sıfırlanmaz — geçmiş veriler görünür.
// Mock/rastgele veri YOK; kaynak olmayan metrikler 0 döner.

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

export function useMetricHistory(intervalMs = 5000) {
  const [history, setHistory] = useState<MetricSnapshot[]>([]);
  const reqIdRef = useRef(0);

  const tick = useCallback(async () => {
    const myId = ++reqIdRef.current;
    const d = await fetchJSON('/api/system/metrics/history?minutes=10');
    if (myId !== reqIdRef.current) return; // yarış koruması: yalnız son isteğin yanıtı yazılır
    if (d && Array.isArray(d.history)) {
      setHistory(d.history.map((r: any) => ({
        time: formatTime(new Date(r.ts)),
        cpuTemp: r.cpuTemp ?? 0,
        cpuUsage: r.cpuUsage ?? 0,
        memoryUsage: r.memoryUsage ?? 0,
        networkIn: r.networkIn ?? 0,
        networkOut: r.networkOut ?? 0,
        diskRead: r.diskRead ?? 0,
        diskWrite: r.diskWrite ?? 0,
        fanSpeed: r.fanSpeed ?? 0,
      })));
    }
  }, []);

  useEffect(() => {
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [tick, intervalMs]);

  return history;
}

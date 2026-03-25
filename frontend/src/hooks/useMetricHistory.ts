import { useState, useEffect, useCallback, useRef } from 'react';
import type { MetricSnapshot } from '../types';

// 3 saniye aralık — GPU/CPU zorlamadan akıcı animasyon sağlar
// 120 nokta = 6 dakikalık pencere
const MAX_POINTS = 120;
const SMOOTHING_WINDOW = 20; // Son 20 verinin hareketli ortalaması

// Her metrik için "gerçekçi" baz değerler ve sürüklenme (drift) tutuyoruz
// Böylece sert zıplamalar yerine doğal yükseliş-düşüş oluyor
interface DriftState {
  cpuTemp: number;
  cpuUsage: number;
  memoryUsage: number;
  networkIn: number;
  networkOut: number;
  diskRead: number;
  diskWrite: number;
  fanSpeed: number;
}

function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

// Drift-based: önceki değere küçük rastgele delta ekle
function drift(prev: number, min: number, max: number, maxDelta: number): number {
  const delta = (Math.random() - 0.5) * 2 * maxDelta;
  return clamp(prev + delta, min, max);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function generateDrifted(prev: DriftState): DriftState {
  return {
    cpuTemp: drift(prev.cpuTemp, 36, 72, 0.8),
    cpuUsage: drift(prev.cpuUsage, 5, 65, 2.5),
    memoryUsage: drift(prev.memoryUsage, 45, 78, 0.6),
    networkIn: drift(prev.networkIn, 1, 80, 3),
    networkOut: drift(prev.networkOut, 0.5, 35, 1.5),
    diskRead: drift(prev.diskRead, 0, 20, 1.2),
    diskWrite: drift(prev.diskWrite, 0, 15, 1),
    fanSpeed: drift(prev.fanSpeed, 1200, 2800, 40),
  };
}

// Hareketli ortalama (Simple Moving Average) uygula
function applyMovingAverage(data: MetricSnapshot[], window: number): MetricSnapshot[] {
  if (data.length <= window) return data;

  const numericKeys: (keyof Omit<MetricSnapshot, 'time'>)[] = [
    'cpuTemp', 'cpuUsage', 'memoryUsage', 'networkIn', 'networkOut', 'diskRead', 'diskWrite', 'fanSpeed'
  ];

  return data.map((point, idx) => {
    // İlk 'window' nokta için mevcut veriyi kullan (yeterli geçmiş yok)
    if (idx < window) return point;

    const smoothed: MetricSnapshot = { ...point };
    for (const key of numericKeys) {
      let sum = 0;
      for (let i = idx - window + 1; i <= idx; i++) {
        sum += data[i][key];
      }
      (smoothed as any)[key] = sum / window;
    }
    return smoothed;
  });
}

export function useMetricHistory(intervalMs = 3000) {
  const driftRef = useRef<DriftState>({
    cpuTemp: 45, cpuUsage: 20, memoryUsage: 58,
    networkIn: 25, networkOut: 8,
    diskRead: 3, diskWrite: 2, fanSpeed: 2000,
  });

  const rawRef = useRef<MetricSnapshot[]>([]);

  const [history, setHistory] = useState<MetricSnapshot[]>(() => {
    // Seed: 120 geçmiş nokta oluştur (drift ile gerçekçi)
    const initial: MetricSnapshot[] = [];
    let state = driftRef.current;
    for (let i = MAX_POINTS; i > 0; i--) {
      state = generateDrifted(state);
      const d = new Date(Date.now() - i * intervalMs);
      initial.push({ ...state, time: formatTime(d) });
    }
    driftRef.current = state;
    rawRef.current = initial;
    return applyMovingAverage(initial, SMOOTHING_WINDOW);
  });

  const tick = useCallback(() => {
    driftRef.current = generateDrifted(driftRef.current);
    const snapshot: MetricSnapshot = {
      ...driftRef.current,
      time: formatTime(new Date()),
    };

    rawRef.current = [...rawRef.current, snapshot];
    if (rawRef.current.length > MAX_POINTS) {
      rawRef.current = rawRef.current.slice(-MAX_POINTS);
    }

    setHistory(applyMovingAverage(rawRef.current, SMOOTHING_WINDOW));
  }, []);

  useEffect(() => {
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [tick, intervalMs]);

  return history;
}

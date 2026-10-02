import { useState, useEffect, useCallback, useRef } from 'react';
import { effectivePoll, onPrefsChange } from '../prefs';

const API_BASE = '/api';

export function useApi<T>(endpoint: string, initialData: T, pollInterval?: number) {
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Yarış koruması: yalnızca en son isteğin yanıtı state'e yazılır.
  const reqIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const myId = ++reqIdRef.current;
    try {
      const res = await fetch(`${API_BASE}${endpoint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (myId !== reqIdRef.current) return; // eski/yarış yanıtı — yoksay
      setData(json);
      setError(null);
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    // Endpoint değişince eski veriyi göstermeyi bırak, yükleniyor durumuna dön.
    setData(initialData);
    setLoading(true);
    setError(null);
    fetchData();
    if (!pollInterval) return;
    // Ayarlar → Performans: otomatik yenileme kapalıysa yoklama yok, yenileme hızı aralığı ölçekler (prefs.ts); tercih
    // değişince (ya da açılışta yüklenince) aralık yeniden kurulur.
    let id: ReturnType<typeof setInterval> | undefined;
    const arm = () => {
      if (id) clearInterval(id);
      const ms = effectivePoll(pollInterval);
      id = ms ? setInterval(fetchData, ms) : undefined;
    };
    arm();
    const off = onPrefsChange(arm);
    return () => { if (id) clearInterval(id); off(); };
    // initialData bilerek bağımlılık dışı (her render yeni referans olur)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchData, pollInterval]);

  return { data, loading, error, refetch: fetchData };
}

export async function getApi<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function postApi(endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function putApi(endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function deleteApi(endpoint: string) {
  const res = await fetch(`${API_BASE}${endpoint}`, { method: 'DELETE' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

import { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api';

export function useApi<T>(endpoint: string, initialData: T, pollInterval?: number) {
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}${endpoint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    fetchData();
    if (pollInterval) {
      const id = setInterval(fetchData, pollInterval);
      return () => clearInterval(id);
    }
  }, [fetchData, pollInterval]);

  return { data, loading, error, refetch: fetchData };
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

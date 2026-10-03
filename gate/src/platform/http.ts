// Ağ bağdaştırıcısı (core/gate.ts'in Fetch'i): eşleşme ve kimlik istekleri ev ağında, zaman aşımıyla.
import type { Fetch } from '../core/gate.ts';

export const http: Fetch = async (url, init) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs);
  try {
    const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: ctl.signal });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    throw new Error(ctl.signal.aborted ? 'Pi yanıt vermedi (zaman aşımı)' : `Pi'ye ulaşılamadı: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(t);
  }
};

// Uygulamanın ağ bağdaştırıcısı: kısa JSON istekleri fetch ile; şifreli parçalar (bellekteki bayt dizisi, en çok ~4 MiB)
// expo/fetch ile — gövde yerel tarafa doğrudan geçer (base64'e çevrilmez), Content-Length belli; indirmede yanıt bayt olarak.
import { fetch as nativeFetch } from 'expo/fetch';
import type { Http } from '../core/client.ts';

async function withTimeout<T>(ms: number, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(ctl.signal);
  } finally {
    clearTimeout(t);
  }
}

export const http: Http = {
  request: (url, init) => withTimeout(init.timeoutMs ?? 15000, async signal => {
    const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal });
    return { status: r.status, text: await r.text() };
  }),
  uploadBytes: (url, bytes, headers) => withTimeout(120_000, async signal => {
    const r = await nativeFetch(url, { method: 'PUT', headers, body: bytes as Uint8Array<ArrayBuffer>, signal });
    return { status: r.status, text: await r.text() };
  }),
  requestBytes: (url, init) => withTimeout(init.timeoutMs ?? 120_000, async signal => {
    const r = await nativeFetch(url, { method: 'GET', headers: init.headers, signal });
    return { status: r.status, bytes: await r.bytes() };
  }),
};

// Ağ bağdaştırıcısı önizleme sahtesi: Pi'nin yanıtları sabit (?pi=down → Pi'ye ulaşılamıyor)
import type { Http } from '../src/core/client.ts';
import { previewQuery } from './state.ts';

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
export const http: Http = {
  async request(url) {
    if (previewQuery.get('pi') === 'down') throw new Error('Network request failed');
    const u = new URL(url);
    if (u.pathname === '/v1/hello') return json(200, { app: 'klyrix-gate', v: 1, name: 'pi5' });
    if (u.pathname === '/v1/status') {
      return json(200, { ok: true, device: { name: 'Hakan\'ın Telefonu', files: 1234, bytes: 5.6e9 }, target: { name: 'Dahili disk', mounted: true, free: 2.1e11, size: 5e11 } });
    }
    if (u.pathname === '/v1/check') return json(200, { have: [] });
    return json(404, { error: 'önizlemede yok' });
  },
  async uploadFile() { return json(200, { done: true, received: 0 }); },
  async uploadRange() { return json(200, { done: true, received: 0 }); },
};

// Ağ bağdaştırıcısı önizleme sahtesi: Pi'nin v2 yanıtları sabit (?pi=down → Pi'ye ulaşılamıyor). Kişi "Hakan": iki
// telefon, dört yedek, çöpte bir yedek. ?paired=key → kişinin anahtarı henüz yok (ilk telefon), ?paired=join → var.
import type { Http } from '../src/core/client.ts';
import { previewQuery } from './state.ts';

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
const stats = (photos: number, videos: number, bytes: number) => ({ photos, videos, audio: 0, files: 0, contacts: 0, events: 0, items: photos + videos, bytes });
const snap = (id: number, device: string, deviceId: number, createdAt: string, st: ReturnType<typeof stats>, deletedAt: string | null = null) => ({
  id, device, deviceId, createdAt, deletedAt, purgeAt: deletedAt ? new Date(Date.parse(deletedAt) + 30 * 86_400_000).toISOString() : null,
  manifest: 'ab'.repeat(32), stats: st, bytes: st.bytes,
});
const PHONE = 'Hakan\'ın Telefonu';
const live = [
  snap(31, PHONE, 7, '2026-10-02T09:05:00Z', stats(1234, 87, 5.6e9)),
  snap(28, PHONE, 7, '2026-10-01T21:40:00Z', stats(1230, 87, 5.58e9)),
  snap(25, 'iPad', 9, '2026-09-30T19:10:00Z', stats(412, 12, 1.2e9)),
  snap(19, PHONE, 7, '2026-09-24T08:00:00Z', stats(1198, 84, 5.41e9)),
];
const trash = [snap(22, PHONE, 7, '2026-09-27T08:00:00Z', stats(1205, 85, 5.45e9), '2026-09-29T10:00:00Z')];

export const http: Http = {
  async request(url) {
    if (previewQuery.get('pi') === 'down') throw new Error('Network request failed');
    const u = new URL(url);
    if (u.pathname === '/v1/hello') return json(200, { app: 'klyrix-gate', v: 1, v2: true, name: 'pi5' });
    if (u.pathname === '/v2/profile') {
      return json(200, {
        id: 'a1b2c3d4e5f6', name: 'Hakan', keyCheck: previewQuery.get('paired') === 'key' ? null : 'x'.repeat(68),
        devices: [
          { id: 7, name: PHONE, platform: 'android', lastSeen: '2026-10-02T09:05:00Z', me: true },
          { id: 9, name: 'iPad', platform: 'ios', lastSeen: '2026-09-30T19:10:00Z', me: false },
        ],
      });
    }
    if (u.pathname === '/v2/profile/keycheck') return json(200, {});
    if (u.pathname === '/v2/usage') return json(200, { bytes: 6.9e9, objects: 1745, free: 2.1e11, size: 5e11, target: 'Dahili disk', mounted: true });
    if (u.pathname === '/v2/snapshots') return json(200, { snapshots: u.searchParams.get('trash') === '1' ? trash : live });
    return json(404, { error: 'önizlemede yok' });
  },
  async uploadBytes() { return json(200, { done: true, received: 0 }); },
  async requestBytes() { return { status: 404, bytes: new Uint8Array() }; },
};

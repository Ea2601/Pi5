// Ağ bağdaştırıcısı önizleme sahtesi: Pi'nin v2 yanıtları sabit (?pi=down → Pi'ye ulaşılamıyor). Kişi "Hakan": iki
// telefon, dört yedek, çöpte bir yedek. ?paired=key → kişinin anahtarı henüz yok (ilk telefon), ?paired=join → var.
// En yeni yedeğin içerik listesi ve kişi / takvim öğeleri önizleme anahtarıyla gerçekten şifrelenir (uygulamanın kendi
// şifrelemesiyle): Yedekler → ayrıntı → «Geri yüklemeyi hazırla» türleri gösterir.
import type { Http } from '../src/core/client.ts';
import { fromBase64, sealBytes, utf8 } from '../src/core/crypto.ts';
import { makeCipher } from '../src/platform/cipher.ts';
import { previewQuery } from './state.ts';

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
const stats = (photos: number, videos: number, bytes: number, more: { audio?: number; files?: number; contacts?: number; events?: number } = {}) => ({
  photos, videos, audio: more.audio ?? 0, files: more.files ?? 0, contacts: more.contacts ?? 0, events: more.events ?? 0,
  items: photos + videos + (more.audio ?? 0) + (more.files ?? 0) + (more.contacts ? 1 : 0) + (more.events ? 1 : 0), bytes,
});
const MANIFEST = 'ab'.repeat(32);
const CONTACTS = 'cd'.repeat(32);
const CALENDAR = 'ef'.repeat(32);
const snap = (id: number, device: string, deviceId: number, createdAt: string, st: ReturnType<typeof stats>, deletedAt: string | null = null) => ({
  id, device, deviceId, createdAt, deletedAt, purgeAt: deletedAt ? new Date(Date.parse(deletedAt) + 30 * 86_400_000).toISOString() : null,
  manifest: MANIFEST, stats: st, bytes: st.bytes,
});
const PHONE = 'Hakan\'ın Telefonu';
const live = [
  snap(31, PHONE, 7, '2026-10-02T09:05:00Z', stats(1234, 87, 5.62e9, { audio: 2, files: 3, contacts: 3, events: 2 })),
  snap(28, PHONE, 7, '2026-10-01T21:40:00Z', stats(1230, 87, 5.58e9)),
  snap(25, 'iPad', 9, '2026-09-30T19:10:00Z', stats(412, 12, 1.2e9)),
  snap(19, PHONE, 7, '2026-09-24T08:00:00Z', stats(1198, 84, 5.41e9)),
];
const trash = [snap(22, PHONE, 7, '2026-09-27T08:00:00Z', stats(1205, 85, 5.45e9), '2026-09-29T10:00:00Z')];

// Önizleme anahtarı (state.ts ile aynı) ile şifreli nesneler — ilk istekte bir kez
let objects: Map<string, Uint8Array> | null = null;
async function sealed(): Promise<Map<string, Uint8Array>> {
  if (objects) return objects;
  const c = await makeCipher(fromBase64('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='));
  const contacts = utf8(JSON.stringify({ v: 1, contacts: [
    { givenName: 'Ayşe', familyName: 'Yılmaz', phones: [{ label: 'mobile', number: '+90 532 000 00 01' }] },
    { givenName: 'Mehmet', familyName: 'Kaya', emails: [{ label: 'home', address: 'mehmet@example.com' }] },
    { givenName: 'Zeynep', phones: [{ label: 'mobile', number: '+90 555 000 00 02' }] },
  ] }));
  const calendar = utf8(JSON.stringify({ v: 1, events: [
    { title: 'Diş hekimi', location: null, notes: '', startDate: '2026-10-10T07:00:00Z', endDate: '2026-10-10T08:00:00Z', allDay: false, timeZone: 'Europe/Istanbul', recurrenceRule: null, alarms: [], calendar: 'Kişisel' },
    { title: 'Annemin doğum günü', location: null, notes: '', startDate: '2026-11-03T00:00:00Z', endDate: '2026-11-04T00:00:00Z', allDay: true, timeZone: 'Europe/Istanbul', recurrenceRule: { frequency: 'yearly' }, alarms: [], calendar: 'Kişisel' },
  ] }));
  const item = (kind: string, n: number, name: string, extra: Record<string, unknown> = {}) =>
    ({ kind, src: `onizleme/${kind}/${n}`, name, created: Date.UTC(2026, 8, n), modified: null, id: `${n}`.padStart(64, '0'), size: 2_000_000, ...extra });
  const manifest = { v: 1, device: PHONE, platform: 'android', at: Date.UTC(2026, 9, 2, 9, 5), items: [
    ...[1, 2, 3, 4].map(n => item('photo', n, `IMG_00${n}.JPG`)), item('video', 5, 'VID_001.MP4'),
    item('audio', 6, 'Kayıt 1.m4a'), item('audio', 7, 'Şarkı.mp3'),
    item('file', 8, 'Fatura.pdf', { path: 'Belgeler/Fatura.pdf' }), item('file', 9, 'Not.txt', { path: 'Belgeler/Notlar/Not.txt' }),
    item('file', 10, 'Sohbet.zip', { path: 'WhatsApp/Sohbet.zip' }),
    { kind: 'contacts', src: 'contacts:onizleme', name: 'Kişiler.json', created: null, modified: null, id: CONTACTS, size: contacts.length, count: 3 },
    { kind: 'calendar', src: 'calendar:onizleme', name: 'Takvim.json', created: null, modified: null, id: CALENDAR, size: calendar.length, count: 2 },
  ] };
  objects = new Map([
    [MANIFEST, await sealBytes(c, MANIFEST, utf8(JSON.stringify(manifest)))],
    [CONTACTS, await sealBytes(c, CONTACTS, contacts)],
    [CALENDAR, await sealBytes(c, CALENDAR, calendar)],
  ]);
  return objects;
}

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
    if (u.pathname === '/v2/objects/check') return json(200, { have: {}, partial: {} });
    const st = /^\/v2\/objects\/([0-9a-f]{64})\/state$/.exec(u.pathname);
    if (st) {
      const o = (await sealed()).get(st[1]);
      return o ? json(200, { received: o.length, size: o.length, done: true }) : json(200, { received: 0, size: 0, done: false });
    }
    return json(404, { error: 'önizlemede yok' });
  },
  async uploadBytes() { return json(200, { done: true, received: 0 }); },
  async requestBytes(url, init) {
    const id = /\/v2\/objects\/([0-9a-f]{64})$/.exec(new URL(url).pathname)?.[1];
    const o = id ? (await sealed()).get(id) : undefined;
    if (!o) return { status: 404, bytes: new Uint8Array() };
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers?.Range || '');
    return { status: 206, bytes: m ? o.slice(Number(m[1]), Number(m[2]) + 1) : o };
  },
};

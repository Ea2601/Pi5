// Çekirdek birim testleri: node --test test/ (Node tür ayıklamasıyla .ts doğrudan çalışır)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetKey, chunkPlan, KEY_RE, manualPayload, parsePayload, CHUNK, WHOLE_MAX } from '../src/core/protocol.ts';
import { PiError, type Client, type UploadMeta } from '../src/core/client.ts';
import { runBackup, type Media, type MediaItem } from '../src/core/engine.ts';

test('QR içeriği: geçerli / geçersiz', () => {
  const p = parsePayload(JSON.stringify({ t: 'klyrix-backup', v: 1, h: ['192.168.0.153', 'yedek.lan', 'http://kotu/x', 5], p: 8095, c: 'abcd-efgh', n: 'pi5' }));
  assert.deepEqual(p, { hosts: ['192.168.0.153', 'yedek.lan'], port: 8095, code: 'ABCDEFGH', name: 'pi5' });
  assert.equal(parsePayload('ABCD-EFGH'), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'baska', v: 1, h: ['1.2.3.4'], c: 'ABCDEFGH' })), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'klyrix-backup', v: 1, h: [], c: 'ABCDEFGH' })), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'klyrix-backup', v: 1, h: ['1.2.3.4'], c: 'KISA' })), null);
});

test('elle giriş', () => {
  assert.deepEqual(manualPayload(' 192.168.0.153 ', 'abcd efgh'), { hosts: ['192.168.0.153'], port: 8095, code: 'ABCDEFGH', name: '' });
  assert.equal(manualPayload('192.168.0.153:9000', 'ABCD-EFGH')?.port, 9000);
  assert.equal(manualPayload('http://pi/', 'ABCD-EFGH'), null);
  assert.equal(manualPayload('192.168.0.153', 'ABC'), null);
});

test('dosya anahtarı Pi\'nin biçimine uyar', () => {
  const ios = assetKey('ph://ED7AC36B-A150-4C38-BB8C-B6D696F4F2ED/L0/001', 1718445600123, 1718445000000);
  assert.equal(ios, 'ph://ED7AC36B-A150-4C38-BB8C-B6D696F4F2ED/L0/001:1718445600');
  assert.match(ios, KEY_RE);
  const odd = assetKey('content://media/../ext ernal/ä?=12', null, 1000);
  assert.match(odd, KEY_RE);
  assert.ok(!odd.includes('..'));
  const long = assetKey('x'.repeat(400), 5000, null);
  assert.equal(long.length, 200);
  assert.match(long, KEY_RE);
});

test('parça planı', () => {
  assert.deepEqual(chunkPlan(20, 0, 8), [[0, 8], [8, 8], [16, 4]]);
  assert.deepEqual(chunkPlan(20, 16, 8), [[16, 4]]);
  assert.deepEqual(chunkPlan(20, 20, 8), []);
});

// Sahte istemci: Pi'nin davranışı bellekte
function fakePi(opts: { fail?: Set<string>; fatalAt?: string } = {}) {
  const have = new Map<string, number>();
  const parts = new Map<string, number>();
  const calls: string[] = [];
  const client: Client = {
    host: 'pi',
    status: async () => ({ ok: true, device: { name: 't', files: have.size, bytes: 0 }, target: { name: 'Dahili disk', mounted: true, free: 1e12, size: 2e12 } }),
    have: async keys => new Set(keys.filter(k => have.has(k))),
    state: async key => ({ received: parts.get(key) || 0, done: have.has(key) }),
    putWhole: async (q: UploadMeta) => {
      calls.push(`whole ${q.name}`);
      if (opts.fatalAt === q.name) throw new PiError(507, 'Yedek diskinde yer yok');
      if (opts.fail?.has(q.name)) throw new PiError(400, 'bozuk');
      have.set(q.key, q.size);
      return { done: true, received: q.size };
    },
    putChunk: async (q: UploadMeta, _uri: string, offset: number, length: number) => {
      calls.push(`chunk ${q.name} ${offset}`);
      assert.equal(offset, parts.get(q.key) || 0);
      parts.set(q.key, offset + length);
      if (offset + length === q.size) have.set(q.key, q.size);
      return { done: offset + length === q.size, received: offset + length };
    },
  };
  return { client, have, parts, calls };
}
function fakeMedia(items: (MediaItem & { size: number })[]): Media {
  return {
    page: async (off, lim) => items.slice(off, off + lim),
    file: async it => ({ uri: `file:///${it.filename}`, size: items.find(x => x.id === it.id)!.size }),
  };
}
const item = (n: number, size = 1000, video = false) => ({ id: `id${n}`, filename: `IMG_${n}.JPG`, created: n * 1000, modified: null, video, size });

test('yalnız Pi\'de olmayanlar yüklenir; videolar ayara göre', async () => {
  const pi = fakePi();
  const media = fakeMedia([item(1), item(2), item(3, 5000, true)]);
  let r = await runBackup(pi.client, media, { videos: false, pageSize: 2 });
  assert.equal(r.uploaded, 2);
  assert.deepEqual(pi.calls, ['whole IMG_1.JPG', 'whole IMG_2.JPG']);
  r = await runBackup(pi.client, media, { videos: true, pageSize: 2 });
  assert.equal(r.uploaded, 1);
  assert.equal(r.skipped, 2);
});

test('büyük dosya parçalarla, kaldığı yerden', async () => {
  const pi = fakePi();
  const big = item(9, WHOLE_MAX + 2 * CHUNK + 5);
  const media = fakeMedia([big]);
  let n = 0;
  let r = await runBackup(pi.client, media, { videos: true, shouldStop: () => pi.calls.length >= 3 && ++n > 0 });
  assert.equal(r.stopped, true);
  const sent = pi.parts.get(assetKey(big.id, null, big.created));
  assert.ok(sent && sent > 0 && sent < big.size);
  r = await runBackup(pi.client, media, { videos: true });
  assert.equal(r.uploaded, 1);
  assert.equal(pi.have.get(assetKey(big.id, null, big.created)), big.size);
  assert.equal(pi.calls.filter(c => c.endsWith(' 0')).length, 1, 'baştan bir kez başlandı');
});

test('tek dosya hatası atlanır, Pi hatası turu bitirir', async () => {
  const pi = fakePi({ fail: new Set(['IMG_2.JPG']) });
  let r = await runBackup(pi.client, fakeMedia([item(1), item(2), item(3)]), { videos: true });
  assert.equal(r.uploaded, 2);
  assert.equal(r.failed, 1);
  assert.match(r.error || '', /IMG_2/);
  const pi2 = fakePi({ fatalAt: 'IMG_2.JPG' });
  await assert.rejects(runBackup(pi2.client, fakeMedia([item(1), item(2), item(3)]), { videos: true }), /yer yok/);
  assert.equal(pi2.have.size, 1);
});

test('süre dolunca durur', async () => {
  const pi = fakePi();
  const r = await runBackup(pi.client, fakeMedia([item(1), item(2)]), { videos: true, deadline: Date.now() - 1 });
  assert.equal(r.stopped, true);
  assert.equal(pi.calls.length, 0);
});

// v2 çekirdek testleri: uçtan uca şifreleme, kurtarma anahtarı, anlık görüntü (yedekleme), geri yükleme.
// Şifreleme node:crypto AES-256-GCM ile (uygulamadaki expo-crypto ile aynı biçim: nonce 12 + şifreli + etiket 16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chunkAad, chunkAt, encodeRecoveryKey, hmacSha256, makeKeyCheck, openBytes, parseRecoveryKey, PLAIN_CHUNK, plainSizeOf, sealBytes,
  sealedSize, verifyKeyCheck, type Cipher,
} from '../src/core/crypto.ts';
import type { Api, Snapshot } from '../src/core/api.ts';
import { runSnapshot, type Source, type SourceItem } from '../src/core/snapshot.ts';
import { downloadItem, loadManifest, restoreItems, type Sink } from '../src/core/restore.ts';

export function nodeCipher(key: Uint8Array): Cipher {
  return {
    async seal(plain, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return new Uint8Array(Buffer.concat([iv, ct, c.getAuthTag()]));
    },
    async open(sealed, aad) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(sealed.subarray(sealed.length - 16));
      return new Uint8Array(Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]));
    },
    async hmac(data) { return new Uint8Array(crypto.createHmac('sha256', key).update(data).digest()); },
  };
}
const key = () => new Uint8Array(crypto.randomBytes(32));

test('kurtarma anahtarı: gidiş-dönüş, küçük harf / I-L-O, yazım hatası yakalanır', () => {
  const k = key();
  const s = encodeRecoveryKey(k);
  assert.match(s, /^([0-9A-HJKMNP-TV-Z]{6}-){8}[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.deepEqual(parseRecoveryKey(s), k);
  assert.deepEqual(parseRecoveryKey(s.toLowerCase().replace(/-/g, ' ')), k);
  const typo = s.slice(0, 3) + (s[3] === 'A' ? 'B' : 'A') + s.slice(4);
  assert.equal(parseRecoveryKey(typo), null);
  assert.equal(parseRecoveryKey(s.slice(0, -1)), null);
});

test('anahtar doğrulama: doğru anahtar açar, yanlışı açamaz', async () => {
  const k = key();
  const kc = await makeKeyCheck(nodeCipher(k));
  assert.equal(await verifyKeyCheck(nodeCipher(k), kc), true);
  assert.equal(await verifyKeyCheck(nodeCipher(key()), kc), false);
});

test('HMAC-SHA256 (saf) node ile aynı — kısa ve uzun anahtar', async () => {
  const sha = async (b: Uint8Array) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
  for (const k of [key(), new Uint8Array(crypto.randomBytes(100))]) {
    const data = new Uint8Array(crypto.randomBytes(77));
    assert.deepEqual(await hmacSha256(k, data, sha), new Uint8Array(crypto.createHmac('sha256', k).update(data).digest()));
  }
});

test('şifreli nesne: boyutlar, gidiş-dönüş, değiştirme ve parça yer değiştirme yakalanır', async () => {
  const c = nodeCipher(key());
  for (const n of [0, 10, PLAIN_CHUNK, PLAIN_CHUNK + 1, 2 * PLAIN_CHUNK + 5]) {
    const plain = new Uint8Array(crypto.randomBytes(n));
    const sealed = await sealBytes(c, 'o1', plain);
    assert.equal(sealed.length, sealedSize(n));
    assert.equal(plainSizeOf(sealed.length), n);
    assert.deepEqual(await openBytes(c, 'o1', sealed), plain);
  }
  const plain = new Uint8Array(crypto.randomBytes(2 * PLAIN_CHUNK + 5));
  const sealed = await sealBytes(c, 'o2', plain);
  const bad = sealed.slice(); bad[100] ^= 1;
  await assert.rejects(openBytes(c, 'o2', bad));
  await assert.rejects(openBytes(c, 'başka-kimlik', sealed)); // AAD nesneye bağlı
  const a = chunkAt(0, plain.length), b = chunkAt(1, plain.length);
  const swapped = sealed.slice();
  swapped.set(sealed.subarray(b.sealedOffset, b.sealedOffset + b.sealedLength), a.sealedOffset);
  swapped.set(sealed.subarray(a.sealedOffset, a.sealedOffset + a.sealedLength), b.sealedOffset);
  await assert.rejects(openBytes(c, 'o2', swapped));
  assert.deepEqual(chunkAad('x', 1, 3), new TextEncoder().encode('x:1:3'));
});

// Bellek içi Pi (mobile.ts v2 anlamı: offset ≤ alınan, küçükse kesilip yeniden yazılır)
export function fakePi() {
  const objs = new Map<string, { size: number; data: Uint8Array; received: number }>();
  const snaps: (Snapshot & { objects: string[] })[] = [];
  const calls: string[] = [];
  const api: Api = {
    host: 'pi',
    profile: async () => ({ id: 'p', name: 'Test', keyCheck: null, devices: [] }),
    setKeyCheck: async () => {},
    objects: async ids => {
      const have = new Map<string, number>(); const partial = new Map<string, number>();
      for (const id of ids) { const o = objs.get(id); if (!o) continue; if (o.received === o.size) have.set(id, o.size); else partial.set(id, o.received); }
      return { have, partial };
    },
    objectState: async id => { const o = objs.get(id); return o ? { received: o.received, size: o.size, done: o.received === o.size } : { received: 0, size: 0, done: false }; },
    putChunk: async (id, size, offset, bytes) => {
      calls.push(`${id.slice(0, 6)}@${offset}`);
      let o = objs.get(id);
      if (!o || o.size !== size) { o = { size, data: new Uint8Array(size), received: 0 }; objs.set(id, o); }
      assert.ok(offset <= o.received, `offset ${offset} > alınan ${o.received}`);
      o.data.set(bytes, offset); o.received = offset + bytes.length;
      return { received: o.received, done: o.received === o.size };
    },
    getRange: async (id, offset, length) => objs.get(id)!.data.slice(offset, offset + length),
    snapshots: async () => snaps.map(({ objects: _o, ...s }) => s),
    createSnapshot: async s => {
      for (const id of s.objects) assert.ok(objs.get(id)?.received === objs.get(id)?.size, `anlık görüntüde eksik nesne ${id}`);
      const id = snaps.length + 1;
      snaps.push({ id, device: 'dev', deviceId: 1, createdAt: new Date().toISOString(), deletedAt: null, purgeAt: null, manifest: s.manifest, stats: s.stats, bytes: s.stats.bytes, objects: s.objects });
      return { id };
    },
    deleteSnapshot: async () => {}, undeleteSnapshot: async () => {},
    usage: async () => ({ bytes: 0, objects: objs.size, free: null, size: null, target: 'x', mounted: true }),
  };
  return { api, objs, snaps, calls };
}
export function memSource(files: { item: SourceItem; data: Uint8Array }[]): Source {
  return {
    async *pages() { yield files.map(f => f.item); },
    async open(it) {
      const f = files.find(x => x.item.src === it.src)!;
      return { size: f.data.length, read: async (o, l) => f.data.slice(o, o + l) };
    },
  };
}
const photo = (n: number, size: number, kind: SourceItem['kind'] = 'photo') => ({
  item: { kind, src: `ph://${n}`, name: `IMG_${n}.HEIC`, created: 1_700_000_000_000 + n, modified: null } as SourceItem,
  data: new Uint8Array(crypto.randomBytes(size)),
});

test('anlık görüntü: yükle, ikinci tur yalnız manifest, değişen dosya yeni nesne', async () => {
  const c = nodeCipher(key());
  const pi = fakePi();
  const files = [photo(1, 1000), photo(2, 2 * PLAIN_CHUNK + 123, 'video'), photo(3, 0)];
  const r1 = await runSnapshot(pi.api, c, [memSource(files)], { device: 'Telefon', platform: 'android' });
  assert.equal(r1.uploaded, 3);
  assert.equal(r1.items, 3);
  assert.equal(pi.snaps[0].stats.photos, 2);
  assert.equal(pi.snaps[0].stats.videos, 1);
  assert.equal(pi.snaps[0].stats.bytes, 1000 + 2 * PLAIN_CHUNK + 123);
  const n1 = pi.objs.size; // 3 dosya + 1 manifest
  assert.equal(n1, 4);
  const r2 = await runSnapshot(pi.api, c, [memSource(files)], { device: 'Telefon', platform: 'android' });
  assert.equal(r2.uploaded, 0);
  assert.equal(pi.objs.size, n1 + 1); // yalnız yeni manifest
  files[0].item.modified = 1_800_000_000_000;
  const r3 = await runSnapshot(pi.api, c, [memSource(files)], { device: 'Telefon', platform: 'android' });
  assert.equal(r3.uploaded, 1);
  assert.equal(pi.snaps.length, 3);
});

test('kimlik önbelleği ve değişiklik yoksa yeni anlık görüntü yazılmaz', async () => {
  const c = nodeCipher(key());
  const pi = fakePi();
  const files = [photo(1, 1000), photo(2, 3000)];
  const cache = new Map<string, string>();
  let hmacs = 0;
  const counted: Cipher = { ...c, hmac: d => { hmacs++; return c.hmac(d); } };
  let last = '';
  const opts = { device: 'T', platform: 'android', ids: cache, unchanged: async (h: string) => h === last };
  const r1 = await runSnapshot(pi.api, counted, [memSource(files)], opts);
  assert.ok(r1.snapshotId && r1.hash);
  last = r1.hash!;
  assert.equal(cache.size, 2);
  const before = hmacs;
  const r2 = await runSnapshot(pi.api, counted, [memSource(files)], opts);
  assert.equal(r2.unchanged, true);
  assert.equal(r2.snapshotId, null);
  assert.equal(pi.snaps.length, 1);
  assert.equal(hmacs - before, 1); // yalnız durum özeti; öğe kimlikleri önbellekten
  files.pop();
  const r3 = await runSnapshot(pi.api, counted, [memSource(files)], opts);
  assert.ok(r3.snapshotId);
  assert.notEqual(r3.hash, last);
  const r4 = await runSnapshot(pi.api, c, [memSource([])], { device: 'T', platform: 'android' });
  assert.equal(r4.empty, true);
  assert.equal(r4.snapshotId, null);
});

test('kişiler / takvim: tek öğede kayıt sayısı istatistiğe girer, küçük öğe bütün olarak indirilir', async () => {
  const c = nodeCipher(key());
  const pi = fakePi();
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, contacts: [{ givenName: 'Ayşe' }, { givenName: 'Ali' }] }));
  const files = [
    { item: { kind: 'contacts', src: 'contacts:abc', name: 'Kişiler.json', created: null, modified: null, count: 2 } as SourceItem, data: json },
    { item: { kind: 'calendar', src: 'calendar:def', name: 'Takvim.json', created: null, modified: null, count: 40 } as SourceItem, data: new Uint8Array(10) },
    { item: { kind: 'file', src: 'content://x/1', name: 'a.pdf', path: 'Belgeler/alt/a.pdf', created: null, modified: 5 } as SourceItem, data: new Uint8Array(3) },
  ];
  await runSnapshot(pi.api, c, [memSource(files)], { device: 'T', platform: 'android' });
  const s = pi.snaps[0].stats;
  assert.deepEqual([s.contacts, s.events, s.files, s.items], [2, 40, 1, 3]);
  const m = await loadManifest(pi.api, c, (await pi.api.snapshots())[0]);
  const ci = m.items.find(x => x.kind === 'contacts')!;
  assert.equal(ci.count, 2);
  assert.equal(m.items.find(x => x.kind === 'file')!.path, 'Belgeler/alt/a.pdf');
  assert.deepEqual(await downloadItem(pi.api, c, ci), json);
});

test('yarıda kalınca anlık görüntü yazılmaz; sonraki tur kaldığı parçadan sürer', async () => {
  const c = nodeCipher(key());
  const pi = fakePi();
  const files = [photo(9, 3 * PLAIN_CHUNK + 7, 'video')];
  let puts = 0;
  const orig = pi.api.putChunk;
  pi.api.putChunk = async (...a) => { puts++; return orig(...a); };
  const r1 = await runSnapshot(pi.api, c, [memSource(files)], { device: 'T', platform: 'ios', shouldStop: () => puts >= 2 });
  assert.equal(r1.stopped, true);
  assert.equal(pi.snaps.length, 0);
  puts = 0;
  const r2 = await runSnapshot(pi.api, c, [memSource(files)], { device: 'T', platform: 'ios' });
  assert.equal(r2.uploaded, 1);
  assert.equal(puts, 2 /* kalan 2 parça */ + 1 /* manifest */);
});

test('geri yükleme: manifest açılır, içerik birebir, telefonda olan atlanır, yanlış anahtar açamaz', async () => {
  const k = key();
  const c = nodeCipher(k);
  const pi = fakePi();
  const files = [photo(1, 50_000), photo(2, PLAIN_CHUNK + 9, 'video')];
  await runSnapshot(pi.api, c, [memSource(files)], { device: 'T', platform: 'android' });
  const snap = (await pi.api.snapshots())[0];
  const m = await loadManifest(pi.api, c, snap);
  assert.equal(m.items.length, 2);
  const got = new Map<string, Uint8Array[]>();
  const sink: Sink = {
    exists: async it => it.src === 'ph://1',
    begin: async it => {
      const parts: Uint8Array[] = [];
      return { write: async b => { parts.push(b); }, finish: async () => { got.set(it.src, parts); }, abort: async () => {} };
    },
  };
  const r = await restoreItems(pi.api, c, m.items, sink);
  assert.equal(r.restored, 1);
  assert.equal(r.skipped, 1);
  assert.deepEqual(Buffer.concat(got.get('ph://2')!), Buffer.from(files[1].data));
  const all = await restoreItems(pi.api, c, m.items, sink, { onlyMissing: false });
  assert.equal(all.restored, 2);
  await assert.rejects(loadManifest(pi.api, nodeCipher(key()), snap), /anahtar/);
});

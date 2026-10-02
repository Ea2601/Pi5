// Gerçek Pi'ye (ya da test kabına) karşı v2 uçtan uca: panelde kişi + eşleştirme kodu → eşleş → anahtar (sınama Pi'ye) →
// şifreli yedek (küçük, boş ve 4 MiB'tan büyük dosya) → Pi'de düz içerik yok → değişmeyince yeni yedek yok → yarıda kesip
// sürdür → geri yükleme birebir → ikinci telefon kurtarma anahtarıyla aynı kişiye → başka kişi göremez → çöp / geri al →
// eski sürüm ayrımı → telefon ve kişi kaldırma.
// Çalıştırma: PANEL=http://127.0.0.1:3001 STORE=/mnt/klyrix-share/.klyrix-mobil node test/pi-v2.ts   (mobil yedekleme açık olmalı)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { PiError, type Http } from '../src/core/client.ts';
import { connect2, pair2, type Api } from '../src/core/api.ts';
import { encodeRecoveryKey, makeKeyCheck, parseRecoveryKey, PLAIN_CHUNK, verifyKeyCheck, type Cipher } from '../src/core/crypto.ts';
import { runSnapshot, type Source, type SourceItem } from '../src/core/snapshot.ts';
import { loadManifest, restoreItems, type Sink } from '../src/core/restore.ts';
import type { PairPayload } from '../src/core/protocol.ts';

const PANEL = process.env.PANEL || 'http://127.0.0.1:3001';
const STORE = process.env.STORE || '/mnt/klyrix-share/.klyrix-mobil';
const H = { 'Content-Type': 'application/json', Origin: PANEL, Host: new URL(PANEL).host };
const panel = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${PANEL}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) as any };
};
const http: Http = {
  request: async (url, init) => {
    const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as any, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
    return { status: r.status, text: await r.text() };
  },
  uploadBytes: async (url, bytes, headers) => {
    const r = await fetch(url, { method: 'PUT', headers, body: bytes });
    return { status: r.status, text: await r.text() };
  },
  requestBytes: async (url, init) => {
    const r = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  },
};
function nodeCipher(key: Uint8Array): Cipher {
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
const MARK = 'KLYRIX-DUZ-METIN-ISARETI';
const files: { item: SourceItem; data: Uint8Array }[] = [];
const add = (name: string, data: Uint8Array, kind: SourceItem['kind'] = 'photo') =>
  files.push({ item: { kind, src: `ph://${files.length}`, name, created: Date.UTC(2025, 6, 1) + files.length * 60_000, modified: null }, data });
const src = (list = files): Source => ({
  async *pages() { yield list.map(f => f.item); },
  async open(it) {
    const f = list.find(x => x.item.src === it.src)!;
    return { size: f.data.length, read: async (o, l) => f.data.slice(o, o + l) };
  },
});
const withMark = (n: number) => { const b = new Uint8Array(crypto.randomBytes(n)); b.set(new TextEncoder().encode(MARK), 100); return b; };
add('IMG_0001.HEIC', withMark(300_000));
add('IMG_0002.JPG', withMark(5000));
add('BOS.JPG', new Uint8Array(0));
add('VID_0001.MOV', withMark(2 * PLAIN_CHUNK + 777), 'video');

let pass = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); pass++; console.log(`  OK   ${m}`); };
const payload = (r: any): PairPayload => {
  const j = JSON.parse(r.j.payload);
  return { hosts: j.h, port: j.p, code: j.c, name: j.n };
};
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const status = (e: unknown) => (e instanceof PiError ? e.status : -1);

(async () => {
  // ── kişi + eşleştirme + anahtar
  let r = await panel('POST', '/mobile/pair', { person: 'Ayşe' });
  ok(r.status === 200 && r.j.person === 'Ayşe', `kişi için kod (${r.j.code})`);
  r = await panel('POST', '/mobile/pair', { person: 'ayşe' });
  const dup = await panel('GET', '/mobile');
  ok(dup.j.profiles.length === 0, 'kod üretmek kişiyi oluşturmaz (telefon eşleşince oluşur)');
  const { pairing, profile } = await pair2(http, payload(r), 'Ayşe Telefon', 'android');
  ok(profile.name === 'ayşe' && profile.keyCheck === null && pairing.v === 2, 'v2 eşleşme: yeni kişi, anahtar henüz yok');
  r = await panel('POST', '/mobile/pair', { person: 'AYŞE' });
  ok(r.status === 400 && /zaten var/.test(r.j.error), `aynı adda ikinci kişi yok (${r.j.error})`);
  const key = new Uint8Array(crypto.randomBytes(32));
  const c = nodeCipher(key);
  const api: Api = await connect2(http, pairing);
  await api.setKeyCheck(await makeKeyCheck(c));
  await api.setKeyCheck(await makeKeyCheck(c)).then(() => ok(false, 'ikinci sınama'), e => ok(status(e) === 409, 'anahtar sınaması bir kez yazılır (409)'));
  const prof = await api.profile();
  ok(prof.keyCheck && await verifyKeyCheck(c, prof.keyCheck) && prof.devices.length === 1 && prof.devices[0].me, 'profil: sınama doğru anahtarla açılır, cihaz listesi');

  // ── yedek
  let puts = 0;
  const counting: Api = { ...api, putChunk: (...a) => { puts++; return api.putChunk(...a); } };
  const r1 = await runSnapshot(counting, c, [src()], { device: 'Ayşe Telefon', platform: 'android', ids: new Map() });
  ok(r1.snapshotId && r1.uploaded === 4 && r1.failed === 0, `ilk yedek: 4 dosya (${JSON.stringify({ id: r1.snapshotId, up: r1.uploaded, err: r1.error })})`);
  const st = fs.statSync(STORE);
  ok((st.mode & 0o777) === 0o700 && st.uid === 0, `özel alan root 0700 (${(st.mode & 0o777).toString(8)})`);
  const all = walk(STORE);
  ok(all.every(f => !fs.readFileSync(f).includes(MARK)), `Pi'deki ${all.length} dosyada düz içerik yok`);
  ok(all.some(f => /\/s\/\d+\.ids$/.test(f)), 'anlık görüntünün nesne listesi diskte');
  const snaps = await api.snapshots();
  ok(snaps.length === 1 && snaps[0].stats.photos === 3 && snaps[0].stats.videos === 1 && snaps[0].stats.bytes === 305_000 + 2 * PLAIN_CHUNK + 777, 'liste: sayılar ve boyut');
  const last = r1.hash!;
  const r2 = await runSnapshot(api, c, [src()], { device: 'Ayşe Telefon', platform: 'android', unchanged: async h => h === last });
  ok(r2.unchanged && r2.uploaded === 0 && (await api.snapshots()).length === 1, 'değişiklik yok: yükleme yok, yeni yedek yok');

  // ── yarıda kes, sürdür
  add('VID_0002.MOV', withMark(3 * PLAIN_CHUNK + 5), 'video');
  let n = 0;
  const r3 = await runSnapshot({ ...api, putChunk: (...a) => { n++; return api.putChunk(...a); } }, c, [src()], { device: 'Ayşe Telefon', platform: 'android', shouldStop: () => n >= 2 });
  ok(r3.stopped && (await api.snapshots()).length === 1, 'yarıda kesildi: yedek yazılmadı');
  n = 0;
  const r4 = await runSnapshot({ ...api, putChunk: (...a) => { n++; return api.putChunk(...a); } }, c, [src()], { device: 'Ayşe Telefon', platform: 'android' });
  ok(r4.snapshotId && n === 2 + 1, `kaldığı parçadan sürdü (${n} istek: 2 parça + içerik listesi)`);

  // ── geri yükleme
  const s2 = (await api.snapshots())[0];
  const m = await loadManifest(api, c, s2);
  ok(m.items.length === 5, 'içerik listesi açıldı (5 öğe)');
  const got = new Map<string, Buffer>();
  const sink: Sink = {
    exists: async () => false,
    begin: async it => {
      const parts: Uint8Array[] = [];
      return { write: async b => { parts.push(b); }, finish: async () => { got.set(it.src, Buffer.concat(parts)); }, abort: async () => {} };
    },
  };
  const rr = await restoreItems(api, c, m.items, sink);
  ok(rr.restored === 5 && files.every(f => Buffer.from(f.data).equals(got.get(f.item.src)!)), 'geri yükleme birebir (boş dosya ve 3 parçalı video dahil)');
  await loadManifest(api, nodeCipher(new Uint8Array(crypto.randomBytes(32))), s2).then(() => ok(false, 'yanlış anahtar'), e => ok(/anahtar/.test(e.message), 'yanlış anahtar yedeği açamaz'));

  // ── ikinci telefon: kurtarma anahtarıyla aynı kişi
  const rk = encodeRecoveryKey(key);
  const p2 = (await panel('GET', '/mobile')).j.profiles[0];
  r = await panel('POST', '/mobile/pair', { profile: p2.id });
  const second = await pair2(http, payload(r), 'Ayşe Tablet', 'ios');
  ok(second.profile.id === p2.id && second.profile.keyCheck, 'ikinci telefon aynı kişiye: sınama var (anahtar istenir)');
  const typed = parseRecoveryKey(rk.toLowerCase().replace(/-/g, ' '))!;
  const api2 = await connect2(http, second.pairing);
  ok(await verifyKeyCheck(nodeCipher(typed), second.profile.keyCheck!), 'kurtarma anahtarı doğrulandı');
  const fromTablet = await loadManifest(api2, nodeCipher(typed), (await api2.snapshots())[0]);
  ok(fromTablet.items.length === 5, 'tablet telefonun yedeğini görür ve açar');

  // ── başka kişi göremez
  r = await panel('POST', '/mobile/pair', { person: 'Mehmet' });
  const other = await pair2(http, payload(r), 'Mehmet Telefon', 'android');
  const api3 = await connect2(http, other.pairing);
  ok((await api3.snapshots()).length === 0, 'başka kişinin yedek listesi boş');
  await api3.getRange(s2.manifest, 0, 10).then(() => ok(false, 'başka kişi okudu'), e => ok(status(e) === 404, 'başka kişi nesneyi okuyamaz (404)'));
  ok((await api3.objects([s2.manifest])).have.size === 0, 'başka kişi nesnenin varlığını göremez');

  // ── eski sürüm ayrımı (v1 kişisiz, şifresiz; v2 deposuna giremez, v2 anahtarı v1 ucuna giremez)
  r = await panel('POST', '/mobile/pair', { person: 'Eski' });
  const lp = payload(r);
  const base = `http://${pairing.host}:${pairing.port}`;
  const lr = await fetch(`${base}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: lp.code, name: 'Eski Telefon', platform: 'android' }) });
  const lj = await lr.json() as any;
  ok(lr.status === 200 && lj.token, 'eski sürüm de eşleşir (kişisiz)');
  ok((await fetch(`${base}/v2/snapshots`, { headers: { Authorization: `Bearer ${lj.token}` } })).status === 409, 'eski sürüm anahtarı v2 deposuna giremez (409)');
  ok((await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${pairing.token}` } })).status === 409, 'v2 anahtarı v1 ucuna giremez (409)');
  const st2 = await panel('GET', '/mobile');
  ok(st2.j.legacy.length === 1 && st2.j.profiles.every((p: any) => p.name !== 'Eski'), 'eski sürüm telefonu ayrı listede, kişi oluşmadı');

  // ── çöp
  await api2.deleteSnapshot(s2.id);
  ok(!(await api.snapshots()).some(s => s.id === s2.id), 'silinen yedek listeden çıkar');
  const trash = await api.snapshots(true);
  ok(trash.length === 1 && trash[0].purgeAt && Date.parse(trash[0].purgeAt) - Date.parse(trash[0].deletedAt!) === 30 * 86_400_000, 'çöpte, 30 gün sonra silinecek');
  await api.undeleteSnapshot(s2.id);
  ok((await api.snapshots()).some(s => s.id === s2.id) && !(await api.snapshots(true)).length, 'çöpten geri alındı');
  await api.deleteSnapshot(999999).then(() => ok(false, 'olmayan'), e => ok(status(e) === 404, 'olmayan yedek 404'));

  // ── kullanım + panel
  const u = await api.usage();
  ok(u.objects >= 7 && u.mounted, `kullanım: ${u.objects} nesne, ${u.bytes} bayt`);
  r = await panel('GET', '/mobile');
  const ay = r.j.profiles.find((p: any) => p.id === p2.id);
  ok(ay.devices.length === 2 && ay.snapshots === 2 && ay.keySet && ay.bytes === u.bytes, 'panel: kişi, iki telefon, iki yedek, kullanım');

  // ── telefon kaldır: anahtarı geçersiz, kişi ve yedekler durur
  r = await panel('POST', '/mobile/devices/remove', { id: second.pairing.deviceId });
  await api2.snapshots().then(() => ok(false, 'kaldırılan telefon'), e => ok(status(e) === 401, 'kaldırılan telefon 401'));
  ok((await api.snapshots()).length === 2, 'kişinin yedekleri duruyor');

  // ── kişiyi kaldır: tüm telefonlar ve şifreli yedekler
  const dir = path.join(STORE, p2.id);
  ok(fs.existsSync(dir), 'kişinin klasörü var');
  r = await panel('POST', '/mobile/people/remove', { id: p2.id });
  ok(r.status === 200 && r.j.filesKept === false && !fs.existsSync(dir), 'kişi kaldırıldı, klasörü silindi');
  await api.snapshots().then(() => ok(false, 'kişisi silinen telefon'), e => ok(status(e) === 401, 'kişisi kaldırılan telefon 401'));
  console.log(`SONUÇ: ${pass} geçti`);
})().catch(e => { console.error('  FAIL', e?.stack || e); process.exit(1); });

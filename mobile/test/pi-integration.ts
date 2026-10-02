// Gerçek Pi'ye (ya da test kabına) karşı uçtan uca: panelden eşleştirme kodu al → eşleş → yedekle (küçük dosyalar tek
// istekte, büyük video parçalarla) → kesip sürdür → yeniden çalıştır (hepsi atlanır) → cihaz kaldırılınca 401.
// Çalıştırma: PANEL=http://127.0.0.1:3001 node test/pi-integration.ts   (mobil yedekleme panelde açık olmalı)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { connect, pair, PiError, type Http } from '../src/core/client.ts';
import { runBackup, type Media, type MediaItem } from '../src/core/engine.ts';
import { parsePayload, WHOLE_MAX, CHUNK } from '../src/core/protocol.ts';

const PANEL = process.env.PANEL || 'http://127.0.0.1:3001';
const H = { 'Content-Type': 'application/json', Origin: PANEL, Host: new URL(PANEL).host };
const panel = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${PANEL}/api${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) as any };
};
let ranges = 0;
const http: Http = {
  request: async (url, init) => {
    const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as any, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
    return { status: r.status, text: await r.text() };
  },
  uploadFile: async (url, fileUri, headers) => {
    const r = await fetch(url, { method: 'PUT', headers, body: fs.readFileSync(new URL(fileUri)) });
    return { status: r.status, text: await r.text() };
  },
  uploadRange: async (url, fileUri, offset, length, headers) => {
    ranges++;
    const fd = fs.openSync(new URL(fileUri), 'r');
    const buf = Buffer.alloc(length);
    try { fs.readSync(fd, buf, 0, length, offset); } finally { fs.closeSync(fd); }
    const r = await fetch(url, { method: 'PUT', headers, body: buf });
    return { status: r.status, text: await r.text() };
  },
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klyrix-media-'));
const items: (MediaItem & { file: string })[] = [];
const add = (name: string, bytes: number, created: number, video = false) => {
  const file = path.join(dir, `${items.length}-${name}`);
  const fd = fs.openSync(file, 'w');
  for (let left = bytes; left > 0; left -= 1 << 20) fs.writeSync(fd, crypto.randomBytes(Math.min(left, 1 << 20)));
  fs.closeSync(fd);
  items.push({ id: `test/${items.length}`, filename: name, created, modified: null, video, file });
};
const media: Media = {
  page: async (off, lim) => items.slice(off, off + lim),
  file: async it => { const f = items.find(x => x.id === it.id)!; return { uri: `file:///${f.file.replace(/\\/g, '/')}`, size: fs.statSync(f.file).size }; },
};
const md5 = (f: string) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
let pass = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); pass++; console.log(`  OK   ${m}`); };

const t0 = Date.UTC(2025, 6, 1, 9, 0, 0);
add('IMG_1001.HEIC', 300_000, t0);
add('IMG_1002.JPG', 120_000, t0 + 60_000);
add('IMG_1002.JPG', 90_000, t0 + 120_000);              // aynı ad, başka fotoğraf
add('VID_2001.MOV', WHOLE_MAX + 2 * CHUNK + 12345, t0 + 180_000, true);

const st = await panel('GET', '/mobile');
if (!st.j.enabled) assert.equal((await panel('POST', '/mobile/settings', { enabled: true, target: 'internal' })).status, 200);
const code = await panel('POST', '/mobile/pair');
const payload = parsePayload(code.j.payload);
ok(payload, `panelden QR içeriği (${code.j.code})`);
// Test kabı ev ağı adresi yerine bu makineden 127.0.0.1 ile ulaşılır
const pr = await pair(http, { ...payload!, hosts: ['10.255.255.1', '127.0.0.1'] }, 'Entegrasyon Telefonu', 'android');
ok(pr.token && pr.host === '127.0.0.1', 'eşleşti (ulaşılamayan ilk adres atlandı)');
const client = await connect(http, pr);

const r1 = await runBackup(client, media, { videos: true });
ok(r1.uploaded === 4 && r1.failed === 0 && ranges === Math.ceil(items[3].file && fs.statSync(items[3].file).size / CHUNK), `4 dosya yüklendi, video ${ranges} parça`);
const s1 = await client.status();
ok(s1.device.files === 4, `Pi'de 4 dosya (${s1.device.files})`);

// Kesip sürdür: ikinci büyük video, iki parçadan sonra dur
add('VID_2002.MOV', WHOLE_MAX + 3 * CHUNK, t0 + 240_000, true);
ranges = 0;
const r2 = await runBackup(client, media, { videos: true, shouldStop: () => ranges >= 2 });
ok(r2.stopped && r2.uploaded === 0, 'iki parçadan sonra durdu');
ranges = 0;
const r3 = await runBackup(client, media, { videos: true });
const total = Math.ceil(fs.statSync(items[4].file).size / CHUNK);
ok(r3.uploaded === 1 && r3.skipped === 4 && ranges === total - 2, `kaldığı yerden sürdü (${ranges}/${total} parça)`);

const r4 = await runBackup(client, media, { videos: true });
ok(r4.uploaded === 0 && r4.skipped === 5, 'yeniden çalıştırma: hepsi atlandı');

// İçerik doğrulaması için yerel özetler (Pi tarafı kabuk betiğinde karşılaştırılır)
fs.writeFileSync(path.join(os.tmpdir(), 'klyrix-md5.txt'), items.map(i => `${md5(i.file)}  ${i.filename}`).join('\n') + '\n');

const dev = (await panel('GET', '/mobile')).j.devices.find((d: any) => d.name === 'Entegrasyon Telefonu');
await panel('POST', '/mobile/devices/remove', { id: dev.id });
await assert.rejects(runBackup(client, media, { videos: true }), (e: unknown) => e instanceof PiError && e.status === 401);
pass++; console.log('  OK   kaldırılan telefon: 401');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`entegrasyon: ${pass} geçti`);

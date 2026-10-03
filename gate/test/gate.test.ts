// Çekirdek birim testleri (npm test): QR çözümü, eşleşme yanıtı doğrulaması, uç adres sırası, hata metni.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPairResult, endpoints, errText, GateError, hello, pair, parseQr, type Fetch } from '../src/core/gate.ts';

const KEY = 'EX2o+2L8xhQgtIccCMDAQvIK03mszHMyh6DfleKtYiI=';

test('QR: geçerli içerik', () => {
  const q = parseQr(JSON.stringify({ t: 'klyrix-gate-app', v: 1, h: ['192.168.0.153', '192.168.0.1'], p: 80, c: 'ABCD-EFGH', n: 'klyrix', i: 'abc', k: KEY }));
  assert.deepEqual(q, { hosts: ['192.168.0.153', '192.168.0.1'], port: 80, code: 'ABCDEFGH', name: 'klyrix', id: 'abc', serverKey: KEY });
});

test('QR: başka türler ve bozuk alanlar reddedilir', () => {
  assert.equal(parseQr('merhaba'), null);
  assert.equal(parseQr(JSON.stringify({ t: 'klyrix-backup', v: 1, h: ['1.2.3.4'], c: 'ABCD-EFGH', k: KEY })), null);
  assert.equal(parseQr(JSON.stringify({ t: 'klyrix-gate-app', v: 1, h: [], c: 'ABCD-EFGH', k: KEY })), null);
  assert.equal(parseQr(JSON.stringify({ t: 'klyrix-gate-app', v: 1, h: ['1.2.3.4'], c: 'ABC', k: KEY })), null);
  assert.equal(parseQr(JSON.stringify({ t: 'klyrix-gate-app', v: 1, h: ['1.2.3.4'], c: 'ABCD-EFGH', k: 'kısa' })), null);
  assert.equal(parseQr(JSON.stringify({ t: 'klyrix-gate-app', v: 1, h: ['kötü ad/'], c: 'ABCD-EFGH', k: KEY })), null);
});

const good = {
  device: { id: 3, name: 'Pixel' }, pi: { id: 'pi-1', name: 'klyrix' },
  tunnel: { address: '10.77.77.254', serverPublicKey: KEY, port: 51820, gate: '10.77.77.1:8097', lan: ['192.168.0.153', 'x'], remote: 'ev.duckdns.org' },
};

test('eşleşme yanıtı: geçerli → temizlenmiş', () => {
  const r = checkPairResult(good);
  assert.deepEqual(r.tunnel.lan, ['192.168.0.153']);
  assert.equal(r.tunnel.remote, 'ev.duckdns.org');
  assert.equal(r.device.id, 3);
});

test('eşleşme yanıtı: tünel ağı dışı adres, bozuk anahtar, adressiz yanıt reddedilir', () => {
  assert.throws(() => checkPairResult({ ...good, tunnel: { ...good.tunnel, address: '192.168.0.5' } }), GateError);
  assert.throws(() => checkPairResult({ ...good, tunnel: { ...good.tunnel, address: '10.77.77.1' } }), GateError);
  assert.throws(() => checkPairResult({ ...good, tunnel: { ...good.tunnel, serverPublicKey: 'x' } }), GateError);
  assert.throws(() => checkPairResult({ ...good, tunnel: { ...good.tunnel, lan: [], remote: '' } }), GateError);
});

test('uç adresler: evde önce ev ağı, dışarıda yalnız dış adres', () => {
  const t = { lan: ['192.168.0.153'], remote: 'ev.duckdns.org', port: 51820 };
  assert.deepEqual(endpoints(t, true).map(e => e.endpoint), ['192.168.0.153:51820', 'ev.duckdns.org:51820']);
  assert.deepEqual(endpoints(t, false), [{ endpoint: 'ev.duckdns.org:51820', via: 'remote' }]);
});

test('hata metni: Expo sarmalı ayıklanır', () => {
  assert.equal(errText(new Error("Call to function 'KlyrixWg.start' has been rejected.\n→ Caused by: java.lang.Exception: ev.duckdns.org çözülemedi")), 'ev.duckdns.org çözülemedi');
  assert.equal(errText(new Error('düz')), 'düz');
});

test('hello / pair: istekler ve hata ayrıntıları', async () => {
  const calls: string[] = [];
  const f: Fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === 'GET') return { status: 200, text: JSON.stringify({ app: 'klyrix-gate', v: 1, id: 'pi-1', name: 'klyrix', role: 'main', code: true, password: true, tunnel: false }) };
    const b = JSON.parse(init.body || '{}');
    if (!b.enableTunnel) return { status: 409, text: JSON.stringify({ error: 'Ev VPN kapalı', needTunnel: true }) };
    return { status: 200, text: JSON.stringify(good) };
  };
  const h = await hello(f, '192.168.0.153');
  assert.equal(h.tunnel, false);
  await assert.rejects(pair(f, '192.168.0.153', 80, { name: 'P', platform: 'android', publicKey: KEY, code: 'ABCDEFGH' }),
    (e: unknown) => e instanceof GateError && e.needTunnel && e.status === 409);
  const r = await pair(f, '192.168.0.153', 8080, { name: 'P', platform: 'android', publicKey: KEY, code: 'ABCDEFGH', enableTunnel: true });
  assert.equal(r.tunnel.address, '10.77.77.254');
  assert.deepEqual(calls, ['GET http://192.168.0.153/api/app/pair', 'POST http://192.168.0.153/api/app/pair', 'POST http://192.168.0.153:8080/api/app/pair']);
});

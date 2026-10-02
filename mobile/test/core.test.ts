// Çekirdek birim testleri: node --test test/ (Node tür ayıklamasıyla .ts doğrudan çalışır)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualPayload, parsePayload } from '../src/core/protocol.ts';
import { PiError, findHost } from '../src/core/client.ts';

test('QR içeriği: geçerli / geçersiz', () => {
  const p = parsePayload(JSON.stringify({ t: 'klyrix-backup', v: 1, h: ['192.168.0.153', 'yedek.lan', 'http://kotu/x', 5], p: 8095, c: 'abcd-efgh', n: 'pi5' }));
  assert.deepEqual(p, { hosts: ['192.168.0.153', 'yedek.lan'], port: 8095, code: 'ABCDEFGH', name: 'pi5' });
  assert.equal(parsePayload('ABCD-EFGH'), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'baska', v: 1, h: ['1.2.3.4'], c: 'ABCDEFGH' })), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'klyrix-backup', v: 1, h: [], c: 'ABCDEFGH' })), null);
  assert.equal(parsePayload(JSON.stringify({ t: 'klyrix-backup', v: 1, h: ['1.2.3.4'], c: 'KISA' })), null);
});

test('elle giriş', () => {
  const ok = (a: string, c = 'ABCD-EFGH') => { const m = manualPayload(a, c); assert.equal(typeof m, 'object', `${a}: ${String(m)}`); return m as Exclude<typeof m, string>; };
  assert.deepEqual(ok(' 192.168.0.153 ', 'abcd efgh'), { hosts: ['192.168.0.153'], port: 8095, code: 'ABCDEFGH', name: '' });
  assert.equal(ok('192.168.0.153:9000').port, 9000);
  // Panelin adresi gibi yazılan: şema / yol atılır, panel portu mobil porta çevrilir
  assert.deepEqual([ok('http://192.168.1.153/').hosts, ok('http://192.168.1.153/').port], [['192.168.1.153'], 8095]);
  assert.equal(ok('192.168.1.153:80').port, 8095);
  assert.equal(ok('HTTPS://yedek.lan:443/#dashboard').hosts[0], 'yedek.lan');
  // Geçersiz: neyin yanlış olduğu yazar
  assert.match(String(manualPayload('192.168.0.153', 'ABC')), /Kod 8 karakter/);
  assert.match(String(manualPayload('pi adresi', 'ABCD-EFGH')), /adresi geçersiz/);
  assert.match(String(manualPayload('', 'ABCD-EFGH')), /adresi geçersiz/);
});

test('Pi bulunamazsa her adresin nedeni yazar', async () => {
  const http = {
    request: async (url: string) => {
      if (url.includes('10.0.0.9')) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      if (url.includes('10.0.0.8')) throw new TypeError('Network request failed');
      return { status: 200, text: '{"app":"baska"}' };
    },
    uploadBytes: async () => ({ status: 500, text: '' }),
    requestBytes: async () => ({ status: 500, bytes: new Uint8Array() }),
  };
  await assert.rejects(findHost(http, ['10.0.0.9', '10.0.0.8', '10.0.0.7'], 8095), (e: unknown) =>
    e instanceof PiError && e.status === 0 && /10\.0\.0\.9: zaman aşımı · 10\.0\.0\.8: bağlanılamadı · 10\.0\.0\.7: Klyrix Gate değil/.test(e.message));
});

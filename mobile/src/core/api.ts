// Pi protokolü v2 (backend/src/mobile.ts /v2): kişi profili, şifreli nesneler, anlık görüntüler (yedekler).
// Pi içerik görmez: nesneler uygulamada şifrelenir (crypto.ts), Pi yalnız opak kimlik + boyut + zaman saklar.
import { check, findHost, net, PiError, type Http } from './client.ts';
import type { PairPayload } from './protocol.ts';

export interface Profile { id: string; name: string; keyCheck: string | null; devices: { id: number; name: string; platform: string; lastSeen: string; me: boolean }[] }
export interface Pairing2 { hosts: string[]; port: number; token: string; piName: string; deviceName: string; host: string; deviceId: number; profileId: string; profileName: string; v: 2 }
export interface SnapshotStats { photos: number; videos: number; audio: number; files: number; contacts: number; events: number; items: number; bytes: number }
// purgeAt: çöpteyse kalıcı silinme zamanı (Pi 30 gün sonra siler)
export interface Snapshot { id: number; device: string; deviceId: number; createdAt: string; deletedAt: string | null; purgeAt: string | null; manifest: string; stats: SnapshotStats; bytes: number }
export interface Usage { bytes: number; objects: number; free: number | null; size: number | null; target: string; mounted: boolean }

// Eşleştirme: kod panelde ya yeni bir kişi için ya da var olan bir kişiye üretilir. Yanıttaki profil keyCheck taşıyorsa
// profilin anahtarı başka bir cihazda vardır (kurtarma anahtarı / QR gerekir); yoksa bu cihaz anahtarı üretir.
export async function pair2(http: Http, p: PairPayload, deviceName: string, platform: string): Promise<{ pairing: Pairing2; profile: Profile }> {
  const host = await findHost(http, p.hosts, p.port);
  const j = check(await http.request(`http://${host}:${p.port}/v2/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: p.code, name: deviceName, platform }), timeoutMs: 10000,
  }));
  if (typeof j.token !== 'string' || !j.profile?.id) throw new PiError(500, 'Pi eşleştirme yanıtı eksik');
  return {
    pairing: { hosts: p.hosts, port: p.port, token: j.token, piName: p.name, deviceName: j.device?.name || deviceName, host, deviceId: j.device?.id, profileId: j.profile.id, profileName: j.profile.name, v: 2 },
    profile: j.profile as Profile,
  };
}

export interface Api {
  host: string;
  profile(): Promise<Profile>;
  setKeyCheck(keyCheck: string): Promise<void>;
  // Pi'de tam olan nesneler (kimlik → şifreli boyut) ve yarım olanların alınmış baytı
  objects(ids: string[]): Promise<{ have: Map<string, number>; partial: Map<string, number> }>;
  objectState(id: string): Promise<{ received: number; size: number; done: boolean }>;
  // Şifreli parça: offset nesnedeki yer, size nesnenin toplam (şifreli) boyutu
  putChunk(id: string, size: number, offset: number, bytes: Uint8Array): Promise<{ received: number; done: boolean }>;
  getRange(id: string, offset: number, length: number): Promise<Uint8Array>;
  snapshots(trash?: boolean): Promise<Snapshot[]>;
  createSnapshot(s: { manifest: string; objects: string[]; stats: SnapshotStats }): Promise<{ id: number }>;
  deleteSnapshot(id: number): Promise<void>;
  undeleteSnapshot(id: number): Promise<void>;
  usage(): Promise<Usage>;
}

const BATCH = 500;
export async function connect2(http0: Http, pr: Pairing2): Promise<Api> {
  const host = await findHost(http0, pr.hosts, pr.port, pr.host);
  const base = `http://${host}:${pr.port}/v2`;
  const auth = { Authorization: `Bearer ${pr.token}` };
  const json = { ...auth, 'Content-Type': 'application/json' };
  const req = (method: string, p: string, body?: unknown, timeoutMs = 15000) =>
    net(() => http0.request(`${base}${p}`, { method, headers: body === undefined ? auth : json, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs })).then(check);
  return {
    host,
    profile: () => req('GET', '/profile') as Promise<Profile>,
    setKeyCheck: async keyCheck => { await req('PUT', '/profile/keycheck', { keyCheck }); },
    objects: async ids => {
      const have = new Map<string, number>();
      const partial = new Map<string, number>();
      for (let i = 0; i < ids.length; i += BATCH) {
        const j = await req('POST', '/objects/check', { ids: ids.slice(i, i + BATCH) });
        for (const [id, n] of Object.entries(j.have || {})) have.set(id, Number(n));
        for (const [id, n] of Object.entries(j.partial || {})) partial.set(id, Number(n));
      }
      return { have, partial };
    },
    objectState: id => req('GET', `/objects/${id}/state`),
    putChunk: async (id, size, offset, bytes) =>
      check(await net(() => http0.uploadBytes(`${base}/objects/${id}?size=${size}&offset=${offset}`, bytes, { ...auth, 'Content-Type': 'application/octet-stream' }))),
    getRange: async (id, offset, length) => {
      const r = await net(() => http0.requestBytes(`${base}/objects/${id}`, { headers: { ...auth, Range: `bytes=${offset}-${offset + length - 1}` }, timeoutMs: 120000 }));
      if (r.status !== 206 && r.status !== 200) throw new PiError(r.status, `Nesne indirilemedi (${r.status})`);
      if (r.bytes.length !== length) throw new PiError(0, 'Nesne eksik indi');
      return r.bytes;
    },
    snapshots: async trash => (await req('GET', `/snapshots${trash ? '?trash=1' : ''}`)).snapshots as Snapshot[],
    createSnapshot: s => req('POST', '/snapshots', s, 60000),
    deleteSnapshot: async id => { await req('DELETE', `/snapshots/${id}`); },
    undeleteSnapshot: async id => { await req('POST', `/snapshots/${id}/restore`); },
    usage: () => req('GET', '/usage'),
  };
}

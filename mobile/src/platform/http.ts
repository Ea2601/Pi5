// Uygulamanın ağ bağdaştırıcısı: kısa JSON istekleri fetch ile; dosya yüklemeleri expo-file-system'in yerel yükleyicisiyle
// (Content-Length dosyadan gelir; iOS'ta arka plan oturumu, uygulama arka plana geçse de sürer).
import { File, Paths } from 'expo-file-system';
import type { Http } from '../core/client.ts';

export const http: Http = {
  async request(url, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15000);
    try {
      const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, signal: ctl.signal });
      return { status: r.status, text: await r.text() };
    } finally {
      clearTimeout(t);
    }
  },
  async uploadFile(url, fileUri, headers, onProgress) {
    const r = await new File(fileUri).upload(url, {
      httpMethod: 'PUT', headers, sessionType: 'background',
      onProgress: onProgress ? d => onProgress(d.bytesSent) : undefined,
    });
    return { status: r.status, text: r.body };
  },
  // Parça: aralık önbellekte geçici dosyaya yazılır, o dosya yüklenir, sonra silinir
  async uploadRange(url, fileUri, offset, length, headers) {
    const tmp = new File(Paths.cache, `klyrix-part-${Date.now()}.bin`);
    const h = new File(fileUri).open();
    try {
      h.offset = offset;
      const bytes = h.readBytes(length);
      tmp.write(bytes);
    } finally {
      h.close();
    }
    try {
      const r = await tmp.upload(url, { httpMethod: 'PUT', headers, sessionType: 'foreground' });
      return { status: r.status, text: r.body };
    } finally {
      try { tmp.delete(); } catch { /* önbellek: sistem de temizler */ }
    }
  },
};

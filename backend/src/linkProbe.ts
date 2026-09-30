import { execFile } from 'child_process';
import { promisify } from 'util';

// Cihaz kablolu mu, Wi-Fi'da mı? Pi bunu doğrudan göremez: kablolu da Wi-Fi da olsa bütün trafik modem/erişim noktası
// üzerinden aynı kablodan (eth0) gelir, çerçevede "radyo" izi yoktur. Modemin arayüzüne bağlanmak modele özgü olacağından
// yerine her ağda çalışan ölçüm kullanılır: ARP yanıt süresi. Kablolu cihaz anahtardan (switch) 1 ms'nin altında ve sabit
// yanıt verir; Wi-Fi'daki cihaza istek radyo üzerinden gider (ortam erişimi, güç tasarrufunda DTIM beklemesi) → yavaş ve
// dalgalı. Ölçüm aracının kendi gecikmesi (arping ~0.5 ms) donanıma göre değiştiği için süreler Pi'nin kabloyla bağlı olduğu
// varsayılan ağ geçidine (modem) göre değerlendirilir: taban çizgisi. ARP'yi telefonların Wi-Fi yongası çoğunlukla kendisi
// yanıtlar (işlemciyi uyandırmaz) → pil etkisi ihmal edilebilir. Destekleyen ipuçları: gizli (rastgele) MAC yalnız Wi-Fi'da
// kullanılır, telefon/tabletin kablosu olmaz. Pi'nin kendi Kurulum Wi-Fi'ına (192.168.50.0/24) bağlananlar kesin bilinir.

const execFileP = promisify(execFile);

// vpn: Ev VPN'i (wg_pi) istemcisi — ölçülmez, panelin istemci kaydından kesin bilinir (topology.ts).
export type LinkKind = 'wired' | 'wifi' | 'setup' | 'vpn' | 'unknown';
export type LinkBasis = 'latency' | 'random-mac' | 'device-type' | 'setup-wifi' | 'pi-wifi' | 'wg-peer' | 'none';
export type LinkInfo = {
  kind: LinkKind; basis: LinkBasis; certain: boolean;
  medMs: number | null; p90Ms: number | null; baseMs: number | null; samples: number;
};

// iputils arping: "Unicast reply from 192.168.0.23 [AA:BB:..]  0.687ms"
export function parseArping(out: string): number[] {
  const r: number[] = [];
  for (const m of out.matchAll(/reply from \S+ \[[0-9A-Fa-f:]+\]\s+([\d.]+)ms/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) r.push(v);
  }
  return r;
}
// iputils ping: "64 bytes from 10.5.0.2: icmp_seq=1 ttl=64 time=3.27 ms" (çok hızlı yanıtta "time<1 ms" olabilir)
export function parsePing(out: string): number[] {
  const r: number[] = [];
  for (const m of out.matchAll(/time[=<]([\d.]+) ms/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) r.push(v);
  }
  return r;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
export const isRandomMac = (mac: string) => /^[0-9a-f]([26ae])/i.test(mac);
const WIRELESS_NAME = /(iphone|ipad|ipod|android|galaxy|pixel|redmi|xiaomi|poco|oneplus|huawei|honor|oppo|vivo|realme|tablet|telefon|phone|watch)/i;
export const wirelessHint = (hostname: string | null, type: string | null) =>
  type === 'phone' || type === 'tablet' || (!!hostname && WIRELESS_NAME.test(hostname));

// Eşikler taban çizgisinin ÜSTÜNDEKİ fark (ms) üzerinden. Kablolu: ortanca ≤ +0.5, %90'lık ≤ +1.0.
// Wi-Fi: ortanca ≥ +1.0 ya da %90'lık ≥ +2.5 (güç tasarrufundaki cihazda yüzlerce ms). Arası belirsiz → ipuçlarına bakılır.
// onPiWifi: cihaz Pi'nin kendi ev Wi-Fi yayınına bağlı (homeWifi.ts, istasyon listesi) — kesin Wi-Fi.
export function classifyLink(inp: {
  samples: number[]; baseMs: number | null; randomMac: boolean; wirelessHint: boolean; onSetupWifi: boolean; onPiWifi?: boolean;
}): LinkInfo {
  const n = inp.samples.length;
  const s = [...inp.samples].sort((a, b) => a - b);
  const med = n ? quantile(s, 0.5) : null, p90 = n ? quantile(s, 0.9) : null;
  const out = (kind: LinkKind, basis: LinkBasis, certain: boolean): LinkInfo =>
    ({ kind, basis, certain, medMs: med, p90Ms: p90, baseMs: inp.baseMs, samples: n });
  if (inp.onSetupWifi) return out('setup', 'setup-wifi', true);
  if (inp.onPiWifi) return out('wifi', 'pi-wifi', true);
  if (n >= 3 && med !== null && p90 !== null) {
    const base = inp.baseMs ?? 0.5;
    const me = med - base, pe = p90 - base;
    if (n >= 6 && me <= 0.5 && pe <= 1.0) return out('wired', 'latency', n >= 15 && !inp.randomMac && !inp.wirelessHint);
    if ((n >= 4 && (me >= 1.0 || pe >= 2.5)) || me >= 2.5 || pe >= 8) return out('wifi', 'latency', n >= 12 && (me >= 1.5 || pe >= 4));
    if (n < 6 && me <= 0.3 && pe <= 0.5 && !inp.randomMac && !inp.wirelessHint) return out('wired', 'latency', false);
  }
  if (inp.randomMac) return out('wifi', 'random-mac', false);
  if (inp.wirelessHint) return out('wifi', 'device-type', false);
  return out('unknown', 'none', false);
}

// ─── Arka plan ölçümü ───

export type ProbeTarget = { ip: string; mac: string; dev: string };
type Sample = { t: number; ms: number };
const WINDOW_MS = 30 * 60 * 1000, MAX_SAMPLES = 40;
const samples = new Map<string, Sample[]>(); // mac → son ölçümler
let baseline: Sample[] = [];
let lastView = 0;
let running = false;
let arpingOk: boolean | null = null;

function push(list: Sample[], ms: number[], now: number): Sample[] {
  const next = [...list.filter(x => now - x.t <= WINDOW_MS), ...ms.map(v => ({ t: now, ms: v }))];
  return next.slice(-MAX_SAMPLES);
}

async function probe(t: ProbeTarget): Promise<number[]> {
  if (arpingOk === null) {
    try {
      const { stdout, stderr } = await execFileP('arping', ['-V'], { timeout: 3000 });
      arpingOk = /iputils/i.test(stdout + stderr);
    } catch (e: any) { arpingOk = /iputils/i.test(String(e?.stdout || '') + String(e?.stderr || '')); }
  }
  if (arpingOk && /^[\w.-]+$/.test(t.dev)) {
    try {
      const { stdout } = await execFileP('arping', ['-c', '3', '-w', '4', '-I', t.dev, t.ip], { timeout: 6000 });
      const r = parseArping(stdout);
      if (r.length) return r;
    } catch (e: any) {
      const r = parseArping(String(e?.stdout || '')); // yanıtsız kalan deneme varsa arping 1 ile çıkar
      if (r.length) return r;
    }
  }
  // arping yok ya da yanıt yok → ICMP (bazı cihazlar kapatır; o zaman ölçüm olmaz)
  try {
    const { stdout } = await execFileP('ping', ['-n', '-c', '3', '-i', '0.3', '-W', '1', t.ip], { timeout: 5000 });
    return parsePing(stdout);
  } catch (e: any) { return parsePing(String(e?.stdout || '')); }
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Bir tur: taban çizgisi (ağ geçidi) + her hedef. Aynı anda en çok 6 ölçüm; tur üst üste binmez.
export async function probeRound(targets: ProbeTarget[], gateway: ProbeTarget | null): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    if (gateway) baseline = push(baseline, await probe(gateway), now);
    await pool(targets, 6, async t => { samples.set(t.mac, push(samples.get(t.mac) || [], await probe(t), Date.now())); });
  } finally { running = false; }
}

export function probeSamples(mac: string): number[] {
  const now = Date.now();
  return (samples.get(mac.toLowerCase()) || []).filter(x => now - x.t <= WINDOW_MS).map(x => x.ms);
}
export function probeBaseline(): number | null {
  const now = Date.now();
  const b = baseline.filter(x => now - x.t <= WINDOW_MS).map(x => x.ms).sort((a, c) => a - c);
  return b.length >= 3 ? quantile(b, 0.5) : null;
}
// Harita açıkken ölçüm sıklaşır (30 sn); kapalıyken 5 dk'da bir (sınıflandırma hazır beklesin).
export function noteTopologyView(): void { lastView = Date.now(); }

export function startLinkProbe(getTargets: () => Promise<{ targets: ProbeTarget[]; gateway: ProbeTarget | null }>): void {
  let last = 0;
  const tick = async () => {
    const now = Date.now();
    const every = now - lastView < 2 * 60 * 1000 ? 30000 : 5 * 60 * 1000;
    if (now - last < every) return;
    last = now;
    try {
      const { targets, gateway } = await getTargets();
      await probeRound(targets, gateway);
    } catch (e: any) {
      console.warn(`[link-probe] ölçüm turu başarısız: ${String(e?.message || e)}`);
    }
  };
  setTimeout(() => { void tick(); setInterval(() => { void tick(); }, 10000); }, 20000);
}

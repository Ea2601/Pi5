// VPS tünellerinin gerçek durumu. Eskiden "Tünel açık" yalnız wg_vps<ID> arayüzünün varlığına bakıyordu: VPS kapansa ya da
// UDP 51820 kesilse de açık görünüyordu. Şimdi son el sıkışmanın yaşı ölçülür:
//  - up: el sıkışma ≤180 sn önce (Pi yapılandırması PersistentKeepalive=25 → oturum ~2 dk'da bir yenilenir; WireGuard 180
//    sn'den eski oturumu zaten kullanmaz),
//  - connecting: arayüz yeni (≤90 sn) ve henüz taze el sıkışma yok — yeni kurulan / yeniden bağlanan tünele tolerans,
//  - stale: arayüz ayakta ama VPS yanıt vermiyor (trafik tünele girer, karşıya ulaşmaz),
//  - down: arayüz yok (kesilmiş ya da açılamamış).
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isLinux } from './system';
import { parseHandshakes } from './topology';

const execFileP = promisify(execFile);

export type TunnelState = 'up' | 'connecting' | 'stale' | 'down';
export const HANDSHAKE_FRESH_S = 180;
export const NEW_TUNNEL_GRACE_S = 90;

export interface VpsTunnel { vpsId: number; iface: string; state: TunnelState; handshakeAge: number | null }

// lastHandshake: unix sn (0 = hiç); upForS: arayüzün kaç sn'dir ayakta olduğu (bu süreç gördüğünden beri).
export function classifyTunnel(present: boolean, lastHandshake: number, upForS: number, nowS: number):
  { state: TunnelState; handshakeAge: number | null } {
  // Saat geri alınırsa (NTP) yaş eksiye düşer → 0 sayılır.
  const handshakeAge = lastHandshake > 0 ? Math.max(0, nowS - lastHandshake) : null;
  if (!present) return { state: 'down', handshakeAge };
  if (handshakeAge !== null && handshakeAge <= HANDSHAKE_FRESH_S) return { state: 'up', handshakeAge };
  return { state: upForS < NEW_TUNNEL_GRACE_S ? 'connecting' : 'stale', handshakeAge };
}

// Arayüzün ne zamandan beri ayakta olduğu: ilk görüldüğü an. ifindex değişirse (wg-quick down/up → yeni arayüz) yeniden
// başlar; panel yeniden başlayınca da (açılış) — ikisinde de tünel yeni sayılır.
const seen = new Map<string, { ifindex: string; since: number }>();
function upSince(iface: string, nowS: number): number | null {
  let ifindex: string;
  try { ifindex = fs.readFileSync(`/sys/class/net/${iface}/ifindex`, 'utf8').trim(); } catch { seen.delete(iface); return null; }
  const s = seen.get(iface);
  if (s && s.ifindex === ifindex) return s.since;
  seen.set(iface, { ifindex, since: nowS });
  return nowS;
}

// İzleyicinin (index.ts, 30 sn) iki ardışık ölçümle onayladığı "yanıt vermiyor" tüneller: rotaları yönlendirme
// tablolarından çıkarılır (engelle kuralları hemen hata alır, operatörden devam kuralları ISP'ye döner). Tek ölçümlük
// sapma (ör. saat düzeltmesi) rota değiştirmez. Tünel yeniden açık / yeni kuruluyor görünce düşer.
const staleConfirmed = new Set<number>();
export const staleTunnels = (): ReadonlySet<number> => staleConfirmed;
// Değiştiyse true.
export function setTunnelStale(vpsId: number, stale: boolean): boolean {
  if (stale === staleConfirmed.has(vpsId)) return false;
  if (stale) staleConfirmed.add(vpsId); else staleConfirmed.delete(vpsId);
  return true;
}

export const vpsIface = (vpsId: number) => `wg_vps${vpsId}`;
export const validVpsId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// `wg show all latest-handshakes`. Okuma sırasında bir arayüz kaybolursa wg 1 ile çıkar ama öbürlerini yazmıştır → o çıktı
// kullanılır. Hiç okunamazsa (zaman aşımı, wg yok) hata fırlatılır: boş sonuç her tüneli "yanıt vermiyor" gösterirdi.
async function readHandshakesStrict(): Promise<Map<string, number>> {
  try {
    const { stdout } = await execFileP('wg', ['show', 'all', 'latest-handshakes'], { timeout: 5000 });
    return parseHandshakes(stdout);
  } catch (e: any) {
    if (e?.stdout) return parseHandshakes(String(e.stdout));
    throw new Error(`wg el sıkışmaları okunamadı: ${e?.message || e}`);
  }
}

// `wg show <arayüz> transfer` → tünelden alınan / gönderilen toplam bayt (eş: VPS). Arayüz yoksa ya da okunamazsa null.
// VPS kartı iki okumanın farkından anlık hızı hesaplar.
export function parseTransfer(text: string): { rx: number; tx: number } {
  let rx = 0, tx = 0;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 3 && /^\d+$/.test(f[1]) && /^\d+$/.test(f[2])) { rx += Number(f[1]); tx += Number(f[2]); }
  }
  return { rx, tx };
}
export async function readTunnelTransfer(iface: string): Promise<{ rx: number; tx: number } | null> {
  if (!isLinux || !/^wg_vps\d+$/.test(iface)) return null;
  try {
    const { stdout } = await execFileP('wg', ['show', iface, 'transfer'], { timeout: 5000 });
    return parseTransfer(stdout);
  } catch { return null; }
}

export async function readVpsTunnels(vpsIds: number[]): Promise<Map<number, VpsTunnel>> {
  const out = new Map<number, VpsTunnel>();
  const ids = vpsIds.filter(id => validVpsId(id) !== null);
  if (!isLinux || !ids.length) return out;
  const hs = await readHandshakesStrict();
  const nowS = Math.floor(Date.now() / 1000);
  for (const vpsId of ids) {
    const iface = vpsIface(vpsId);
    const since = upSince(iface, nowS);
    out.set(vpsId, { vpsId, iface, ...classifyTunnel(since !== null, hs.get(iface) || 0, since === null ? 0 : nowS - since, nowS) });
  }
  return out;
}

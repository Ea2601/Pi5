// Yönlendirme işaretleri (fwmark; VPS işaretinde aynı zamanda ip rule tablo numarası). v2.24.55 şeması:
//   0             → ISP (işaretsiz)
//   200           → ISP + DPI istendi (Zapret kendi listesiyle çalışır; kural/tablo yok)
//   0x8000 | id   → wg_vps<id> tüneli (id 1–8191)
//     + 0x4000    → DPI de istendi (tünel içinde etkisiz; sayaçlarda gösterilir)
//     + 0x2000    → tünel yoksa / yanıt vermiyorsa operatörden devam; bit yoksa ENGELLE (tabloda kalıcı unreachable)
// Eski şema (≤ v2.24.54): 100+id tünel, 300+id tünel + DPI — id ≥ 100'de 200 ve 300+id ile çakışıyordu, tünel düşünce
// ne olacağını da taşımıyordu. Sayaçlar (topology.ts) ve geçiş (system.ts) için hâlâ çözülür.
export const DPI_ONLY_MARK = 200;
export const VPS_MARK_BIT = 0x8000;
export const DPI_MARK_BIT = 0x4000;
export const ISP_FALLBACK_BIT = 0x2000;
export const VPS_ID_MAX = 0x1fff;

// Kural başına: tünel düşünce trafik engellensin (varsayılan) ya da operatörden devam etsin.
export type VpsFallback = 'block' | 'isp';
export const normFallback = (v: unknown): VpsFallback => (v === 'isp' ? 'isp' : 'block');

// exitNode: 'isp' ya da VPS kimliği ('7'). Geçersiz / aralık dışı kimlik ISP sayılır (null döner: çağıran günlüğe yazar).
export function encodeRouteMark(exitNode: string, dpi: boolean, fallback: VpsFallback): number | null {
  if (exitNode === 'isp') return dpi ? DPI_ONLY_MARK : 0;
  const id = /^\d{1,10}$/.test(exitNode) ? Number(exitNode) : NaN;
  if (!Number.isInteger(id) || id < 1 || id > VPS_ID_MAX) return null;
  return VPS_MARK_BIT | (dpi ? DPI_MARK_BIT : 0) | (fallback === 'isp' ? ISP_FALLBACK_BIT : 0) | id;
}

export interface VpsMark { vpsId: number; dpi: boolean; ispFallback: boolean }
export function decodeVpsMark(mark: number): VpsMark | null {
  if (!Number.isInteger(mark) || mark < 0 || mark > 0xffff || !(mark & VPS_MARK_BIT)) return null;
  const vpsId = mark & VPS_ID_MAX;
  return vpsId ? { vpsId, dpi: !!(mark & DPI_MARK_BIT), ispFallback: !!(mark & ISP_FALLBACK_BIT) } : null;
}

// Eski şemanın VPS işareti (100+id / 300+id, id 1–99; 200–299 aralığı DPI ile çakıştığı için tanınmaz).
export function decodeLegacyVpsMark(mark: number): { vpsId: number; dpi: boolean } | null {
  if (mark >= 101 && mark <= 199) return { vpsId: mark - 100, dpi: false };
  if (mark >= 301 && mark <= 399) return { vpsId: mark - 300, dpi: true };
  return null;
}

// Panelin yönettiği "fwmark N lookup N" kuralları: yeni şemanın VPS işaretleri ve eski şemanın 100–999 aralığı.
export const isManagedRuleMark = (mark: number) => decodeVpsMark(mark) !== null || (mark >= 100 && mark <= 999);

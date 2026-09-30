// Pi ↔ VPS tünelinin canlı durumu (backend vpsTunnel.ts): el sıkışma yaşına göre. VPS Yönetimi kartı ve Dashboard aynı
// rozeti gösterir.
export type TunnelState = 'up' | 'connecting' | 'stale' | 'down';
export interface TunnelInfo { state: TunnelState; handshakeAge: number | null }

const fmtAge = (s: number) => (s < 120 ? `${s} sn` : s < 7200 ? `${Math.floor(s / 60)} dk` : `${Math.floor(s / 3600)} sa`);

export function tunnelBadge(t: TunnelInfo): { variant: 'success' | 'info' | 'warning' | 'neutral'; label: string; title: string } {
  const hs = t.handshakeAge === null ? 'el sıkışma yok' : `son el sıkışma ${fmtAge(t.handshakeAge)} önce`;
  switch (t.state) {
    case 'up': return { variant: 'success', label: 'Tünel açık', title: `Pi ↔ VPS WireGuard tüneli çalışıyor — ${hs}` };
    case 'connecting': return { variant: 'info', label: 'Tünel bağlanıyor', title: 'Tünel yeni açıldı, VPS ile el sıkışma bekleniyor' };
    case 'stale': return { variant: 'warning', label: 'Tünel yanıt vermiyor',
      title: `Tünel Pi'de açık ama VPS yanıt vermiyor (${hs}) — VPS kapalı ya da UDP 51820 erişilemiyor olabilir` };
    default: return { variant: 'neutral', label: 'Tünel kapalı', title: 'Pi ↔ VPS WireGuard tüneli kapalı' };
  }
}

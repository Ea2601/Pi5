// Olay geçmişi (Bildirimler sayfası): panelde yapılan önemli işlemler ve sonuçları alerts tablosuna type='event' olarak
// yazılır. Eskiden tabloya yalnız sağlık denetiminin uyarı/kritik satırları düşüyordu; Pi sorunsuzken sayfa boş kalıyordu.
//  - Bilgi olayları okunmuş (acknowledged=1) yazılır: zildeki okunmamış sayısı ve OLED'deki uyarı yalnız uyarı/kritik için.
//  - Kayıt işlemi hiçbir zaman fırlatmaz: olay yazılamaması asıl işlemi bozmaz.
//  - Sağlık uyarıları (type='health') ayrı kalır; onların tekrar önleme sorguları type ile süzülür.
import fs from 'fs';
import path from 'path';
import { dbGet, dbRun } from './db';

export type EventSeverity = 'info' | 'warning' | 'critical';

const SERVICE_LABEL: Record<string, string> = {
  pihole: 'Pi-hole', unbound: 'Unbound', zapret: 'Zapret', fail2ban: 'Fail2Ban', nftables: 'nftables', wireguard: 'WireGuard',
};
export const serviceLabel = (name: string) => SERVICE_LABEL[name] || name;

export async function recordEvent(source: string, message: string, severity: EventSeverity = 'info'): Promise<void> {
  try {
    await dbRun('INSERT INTO alerts (type, severity, message, source, acknowledged) VALUES (?, ?, ?, ?, ?)',
      ['event', severity, String(message).slice(0, 500), source, severity === 'info' ? 1 : 0]);
  } catch (e: any) {
    console.error('[olay] kaydedilemedi:', e?.message || e);
  }
}

// Aynı olay (kaynak + mesaj) son `windowMin` dakikada yazıldıysa yeniden yazılmaz (0 = hiç yazılmadıysa). Kendiliğinden
// tekrarlayan işlemlerin (ör. her routing uygulamasındaki Zapret hatası) sayfayı doldurmaması için.
export async function recordEventOnce(source: string, message: string, severity: EventSeverity, windowMin = 60): Promise<void> {
  try {
    const msg = String(message).slice(0, 500);
    const seen = await dbGet(
      `SELECT id FROM alerts WHERE type = 'event' AND source = ? AND message = ?${windowMin ? ` AND created_at > datetime('now', '-${Math.floor(windowMin)} minutes')` : ''} LIMIT 1`,
      [source, msg]);
    if (!seen) await recordEvent(source, msg, severity);
  } catch (e: any) {
    console.error('[olay] kaydedilemedi:', e?.message || e);
  }
}

// Açılışta: sürüm değiştiyse (elle ya da gece otomatik güncellemesiyle) bir kez "Panel güncellendi" olayı.
export async function recordVersionChange(versionFile = path.resolve(__dirname, '../../version.json')): Promise<void> {
  try {
    const v = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    const now = `v${v.version} (build ${v.build})`;
    const row = await dbGet(`SELECT value FROM app_settings WHERE key = 'last_seen_version'`);
    if (row?.value && row.value !== now) await recordEvent('update', `Panel güncellendi: ${row.value} → ${now}`);
    if (row?.value !== now) await dbRun(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_seen_version', ?)`, [now]);
  } catch (e: any) {
    console.error('[olay] sürüm denetlenemedi:', e?.message || e);
  }
}

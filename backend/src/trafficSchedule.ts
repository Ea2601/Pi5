// Trafik Kontrolü → Zamanlayıcı: bir uygulama kuralının çıkışını (operatör / VPS) ve DPI atlatmasını belirli gün ve saatlerde
// değiştirir. Etkin pencere routing motorunda (index.ts applyAllRoutingRulesNow) ve Zapret listesinde (zapret.ts
// collectDpiDomains) kuralın kendi değerinin yerine geçer; pencere başlayıp bitince (30 sn'de bir denetim) routing yeniden
// uygulanır. Eskiden zamanlayıcı yalnız veritabanına yazılıyor, hiçbir şey değişmiyordu.
//  - Saatler Pi'nin yerel saati (HH:MM). Bitiş başlangıçtan küçükse pencere gece yarısını aşar (22:00–06:00: başladığı
//    günün akşamı ve ertesi sabah); başlangıç = bitiş bütün gün. Gün yoksa her gün.
//  - Aynı kurala aynı anda birden çok pencere uyarsa sonuncusu (en büyük id) geçerlidir.
//  - "Engelle" uygulanmaz: routing motorunda engel çıkışı yok. Zamanlı engel Ebeveyn Kontrolü'ndedir (kime × neyi × ne
//    zaman, nft + Pi-hole); eski "Engelle" pencereleri arayüzde "uygulanmıyor" görünür.
import { dbAll } from './db';
import { isLinux } from './system';
import { isSatellite } from './role';

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export interface Schedule {
  id: number; traffic_routing_id: number; schedule_exit_node: string | null; schedule_dpi_bypass: number | null;
  time_start: string; time_end: string; days_of_week: string | null; enabled: number;
}
export interface Override { exit_node: string; dpi_bypass: number }

const toMin = (t: string): number | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const supported = (s: Pick<Schedule, 'schedule_exit_node'>) => (s.schedule_exit_node || 'isp') !== 'blocked';

export function scheduleActive(s: Schedule, now: Date): boolean {
  if (!s.enabled) return false;
  const st = toMin(s.time_start), en = toMin(s.time_end);
  if (st === null || en === null) return false;
  const days = String(s.days_of_week || '').split(',').map(d => d.trim()).filter(Boolean);
  const dayOk = (d: number) => !days.length || days.includes(DAY_KEYS[d]);
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  if (st === en) return dayOk(today);
  if (st < en) return dayOk(today) && mins >= st && mins < en;
  return (dayOk(today) && mins >= st) || (dayOk(yesterday) && mins < en);
}

// Kural id → etkin pencerenin çıkışı / DPI'ı (uygulanmayan "Engelle" pencereleri hariç)
export function activeOverrides(schedules: Schedule[], now: Date): Map<number, Override> {
  const out = new Map<number, Override>();
  for (const s of [...schedules].sort((a, b) => a.id - b.id)) {
    if (!supported(s) || !scheduleActive(s, now)) continue;
    out.set(Number(s.traffic_routing_id), { exit_node: String(s.schedule_exit_node || 'isp'), dpi_bypass: s.schedule_dpi_bypass ? 1 : 0 });
  }
  return out;
}

export function applyOverrides<T extends { id: number; exit_node: unknown; dpi_bypass: unknown }>(rules: T[], ov: Map<number, Override>): T[] {
  return rules.map(r => {
    const o = ov.get(Number(r.id));
    return o ? { ...r, exit_node: o.exit_node, dpi_bypass: o.dpi_bypass } : r;
  });
}

export const overrideSig = (ov: Map<number, Override>) => JSON.stringify([...ov.entries()].sort((a, b) => a[0] - b[0]));

export async function loadSchedules(): Promise<Schedule[]> {
  try {
    return await dbAll('SELECT id, traffic_routing_id, schedule_exit_node, schedule_dpi_bypass, time_start, time_end, days_of_week, enabled FROM traffic_schedules WHERE enabled = 1') as Schedule[];
  } catch {
    return []; // tablo yok (eski veritabanı)
  }
}
export async function loadOverrides(now = new Date()): Promise<Map<number, Override>> {
  return activeOverrides(await loadSchedules(), now);
}

// Doğrulama (POST / PUT): saat HH:MM, gün mon..sun, çıkış 'isp' ya da kayıtlı VPS kimliği.
export function checkSchedule(body: { time_start?: unknown; time_end?: unknown; days_of_week?: unknown; schedule_exit_node?: unknown }, vpsIds: string[], partial = false): string | null {
  if (!partial || body.time_start !== undefined) if (toMin(String(body.time_start ?? '')) === null) return 'Başlangıç saati SS:DD olmalı (ör. 09:00)';
  if (!partial || body.time_end !== undefined) if (toMin(String(body.time_end ?? '')) === null) return 'Bitiş saati SS:DD olmalı (ör. 17:00)';
  if (body.days_of_week !== undefined && body.days_of_week !== '') {
    const days = String(body.days_of_week).split(',').map(d => d.trim());
    if (days.some(d => !(DAY_KEYS as readonly string[]).includes(d))) return 'Geçersiz gün';
  }
  if (!partial || body.schedule_exit_node !== undefined) {
    const e = String(body.schedule_exit_node ?? 'isp');
    if (e === 'blocked') return 'Zamanlayıcı engelleyemez: belirli saatlerde engellemek için Ebeveyn Kontrolü\'nü kullanın';
    if (e !== 'isp' && !vpsIds.includes(e)) return 'Çıkış noktası operatör (ISP) ya da kayıtlı bir VPS olmalı';
  }
  return null;
}

// Pencere başlayıp bitince routing yeniden uygulanır. appliedSig, routing'in en son hangi pencere kümesiyle uygulandığıdır
// (index.ts applyAllRoutingRulesNow bildirir); açılıştaki ilk uygulamadan önce denetim yapılmaz.
let appliedSig: string | null = null;
export function noteScheduleApplied(sig: string): void { appliedSig = sig; }
export function startScheduleWatch(apply: () => Promise<void>): void {
  if (!isLinux || isSatellite()) return;
  let busy = false;
  setInterval(() => {
    if (busy || appliedSig === null) return;
    busy = true;
    loadOverrides().then(ov => {
      if (overrideSig(ov) === appliedSig) return;
      console.log('[zamanlayıcı] pencere değişti — routing yeniden uygulanıyor');
      return apply();
    }).catch(e => console.error('[zamanlayıcı]', e?.message || e)).finally(() => { busy = false; });
  }, 30000);
}

// Takvim yedeği: kullanıcının düzenleyebildiği takvimlerdeki etkinlikler (5 yıl geri, 2 yıl ileri) tek bir JSON öğesi.
// Salt okunur takvimler (resmî tatiller, rehberden doğum günleri) alınmaz. Yinelenen etkinliğin tek kaydı tutulur (tekrar
// kuralıyla). Kaynak kimliği içeriğin özeti: takvim değişmedikçe yeniden yüklenmez. Geri yükleme "Klyrix Gate Sync" adlı
// yerel takvime yalnız eksikleri ekler (başlık + başlangıç dakikası bir takvimde zaten varsa atlanır).
import { Platform } from 'react-native';
import {
  CalendarAccessLevel, createCalendar, EntityTypes, getCalendarPermissions, getCalendars, getDefaultCalendarSync, listEvents,
  requestCalendarPermissions, type Alarm, type RecurrenceRule,
} from 'expo-calendar';
import { fromUtf8, toHex, utf8 } from '../core/crypto.ts';
import type { Source } from '../core/snapshot.ts';
import { sha256 } from './cipher.ts';

export const RESTORE_CALENDAR = 'Klyrix Gate Sync';
const YEAR = 365 * 86_400_000;
interface SavedEvent {
  title: string; location: string | null; notes: string; startDate: string; endDate: string; allDay: boolean;
  timeZone: string; endTimeZone?: string; url?: string; recurrenceRule: RecurrenceRule | null; alarms: Alarm[]; calendar: string;
}
const iso = (d: string | Date) => new Date(d).toISOString();

export async function calendarAccess(ask: boolean): Promise<boolean> {
  const p = ask ? await requestCalendarPermissions() : await getCalendarPermissions();
  return p.granted;
}

async function readEvents(): Promise<SavedEvent[]> {
  const cals = (await getCalendars(EntityTypes.EVENT)).filter(c => c.allowsModifications && c.title !== RESTORE_CALENDAR);
  if (!cals.length) return [];
  const now = Date.now();
  const events = await listEvents(cals.map(c => c.id), new Date(now - 5 * YEAR), new Date(now + 2 * YEAR));
  const title = new Map(cals.map(c => [c.id, c.title]));
  const seen = new Set<string>();
  const out: SavedEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue; // yinelenen etkinliğin sonraki tekrarları
    seen.add(e.id);
    out.push({
      title: e.title, location: e.location, notes: e.notes, startDate: iso(e.startDate), endDate: iso(e.endDate), allDay: e.allDay,
      timeZone: e.timeZone, endTimeZone: e.endTimeZone, url: e.url, recurrenceRule: e.recurrenceRule, alarms: e.alarms || [],
      calendar: title.get(e.calendarId) || '',
    });
  }
  return out;
}

export function calendarSource(): Source {
  let bytes: Uint8Array | null = null;
  return {
    async *pages() {
      if (!(await calendarAccess(false))) throw new Error('Takvime erişim izni yok — Ayarlar\'dan izin verin ya da takvimi kapatın');
      const list = await readEvents();
      bytes = utf8(JSON.stringify({ v: 1, events: list }));
      const hash = toHex(await sha256(bytes)).slice(0, 32);
      yield [{ kind: 'calendar', src: `calendar:${hash}`, name: 'Takvim.json', created: null, modified: null, count: list.length }];
    },
    async open() {
      const b = bytes;
      return b ? { size: b.length, read: async (o, l) => b.subarray(o, o + l) } : null;
    },
  };
}

const keyOf = (title: string, start: string | Date) => `${title.toLocaleLowerCase('tr').trim()}|${Math.floor(new Date(start).getTime() / 60_000)}`;
export interface CalendarPlan { events: SavedEvent[]; missing: SavedEvent[] }
export async function planCalendar(data: Uint8Array): Promise<CalendarPlan> {
  const j = JSON.parse(fromUtf8(data)) as { v: number; events: SavedEvent[] };
  if (j?.v !== 1 || !Array.isArray(j.events)) throw new Error('Takvim yedeği tanınmadı');
  const cals = await getCalendars(EntityTypes.EVENT);
  const now = Date.now();
  const have = new Set((cals.length ? await listEvents(cals.map(c => c.id), new Date(now - 6 * YEAR), new Date(now + 3 * YEAR)) : [])
    .map(e => keyOf(e.title, e.startDate)));
  return { events: j.events, missing: j.events.filter(e => !have.has(keyOf(e.title, e.startDate))) };
}

async function restoreCalendar() {
  const found = (await getCalendars(EntityTypes.EVENT)).find(c => c.title === RESTORE_CALENDAR && c.allowsModifications);
  if (found) return found;
  const source = Platform.OS === 'ios' ? getDefaultCalendarSync().source : { isLocalAccount: true, name: RESTORE_CALENDAR, type: 'LOCAL' };
  return createCalendar({
    title: RESTORE_CALENDAR, color: '#475569', entityType: EntityTypes.EVENT, sourceId: source.id, source,
    name: 'klyrix-gate-sync', ownerAccount: 'personal', accessLevel: CalendarAccessLevel.OWNER,
  });
}
export async function addEvents(list: SavedEvent[], onProgress?: (done: number) => void): Promise<{ added: number; failed: number }> {
  const cal = await restoreCalendar();
  let added = 0;
  let failed = 0;
  for (const e of list) {
    try {
      await cal.createEvent({
        title: e.title, location: e.location, notes: e.notes, startDate: new Date(e.startDate), endDate: new Date(e.endDate),
        allDay: e.allDay, timeZone: e.timeZone, endTimeZone: e.endTimeZone, url: e.url, recurrenceRule: e.recurrenceRule, alarms: e.alarms,
      });
      added++;
    } catch {
      failed++;
    }
    onProgress?.(added + failed);
  }
  return { added, failed };
}

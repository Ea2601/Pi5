// expo-calendar önizleme sahtesi: izin verilmiş, takvim boş
export const EntityTypes = { EVENT: 'event', REMINDER: 'reminder' } as const;
export const CalendarAccessLevel = { OWNER: 'owner' } as const;
const cal = { id: 'onizleme', title: 'Klyrix Gate Sync', allowsModifications: true, source: { id: 'yerel', name: 'Yerel', type: 'local' }, async createEvent() { return {}; } };
export async function getCalendars() { return []; }
export async function listEvents() { return []; }
export async function createCalendar() { return cal; }
export function getDefaultCalendarSync() { return cal; }
const granted = { granted: true, status: 'granted', canAskAgain: true, expires: 'never' };
export async function getCalendarPermissions() { return granted; }
export async function requestCalendarPermissions() { return granted; }

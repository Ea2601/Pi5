// Sunucudan gelen zaman: SQLite CURRENT_TIMESTAMP / datetime() "YYYY-MM-DD HH:MM:SS" UTC'dir ama saat dilimi yazmaz —
// new Date() bunu yerel saat sanar (Türkiye'de 3 saat geri gösterir). Z / +03:00 taşıyan ISO metni olduğu gibi okunur.
// (Arka uçtaki eşi: backend/src/db.ts dbTimeMs.) Okunamazsa null.
export function parseDbTime(s: string | null | undefined): Date | null {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t) ? `${t.replace(' ', 'T')}Z` : t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDbTime(s: string | null | undefined, opts?: Intl.DateTimeFormatOptions, empty = '—'): string {
  const d = parseDbTime(s);
  return d ? d.toLocaleString('tr-TR', opts) : empty;
}

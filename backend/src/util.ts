// Shell-safety and input-validation helpers.
// Used to eliminate command-injection in shell/SSH command construction.

/** Wrap a value in single quotes, escaping embedded single quotes — safe for POSIX sh. */
export function shq(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/** Escape characters that are special inside a sed BRE address/pattern. */
export function sedEscape(value: string): string {
  return value.replace(/[\\/&.*[\]^$]/g, '\\$&');
}

export function isValidMac(s: unknown): boolean {
  return typeof s === 'string' && /^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}$/.test(s.trim());
}

/** Domain or keyword (routing/zapret). Blocks any shell metacharacter. */
export function isValidDomain(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 253 && /^[a-zA-Z0-9._*-]+$/.test(s.trim());
}

/** IANA timezone name (e.g. Europe/Istanbul). */
export function isValidTimezone(s: unknown): boolean {
  return typeof s === 'string' && s.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(s);
}

export function isValidHexColor(s: unknown): boolean {
  return typeof s === 'string' && /^#?[0-9a-fA-F]{6}$/.test(s.trim());
}

export const LED_ANIMATIONS = ['static', 'breathe', 'pulse', 'blink', 'rainbow', 'off'] as const;
export function isValidAnimation(s: unknown): boolean {
  return typeof s === 'string' && (LED_ANIMATIONS as readonly string[]).includes(s);
}

/** Safe WireGuard/client display name — alnum, space, dot, dash, underscore. */
export function sanitizeName(s: unknown, max = 64): string {
  return String(s ?? '').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, max).trim();
}

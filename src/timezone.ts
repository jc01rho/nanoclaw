/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  // SQLite datetime('now') stores UTC without a trailing 'Z'. Without
  // appending 'Z', new Date() on a non-UTC host interprets the naive string
  // as local wall-clock time — toLocaleString then round-trips to the same
  // value instead of converting to the target zone.
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(utcIso.trim());
  const date = new Date(hasOffset ? utcIso : utcIso + 'Z');
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

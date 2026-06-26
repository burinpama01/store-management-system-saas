// Store-timezone helpers. Timestamps are persisted as UTC; anything shown to or typed by staff must
// be rendered/parsed in the store's IANA timezone, otherwise a 09:00 Bangkok time shows as 02:00.

export const DEFAULT_TIME_ZONE = "Asia/Bangkok";

function safeZone(timeZone: string | undefined): string {
  return timeZone || DEFAULT_TIME_ZONE;
}

/** "HH:MM" wall-clock time of a UTC instant rendered in the store's timezone. */
export function formatStoreTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: safeZone(timeZone),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Components of a UTC instant in the store timezone, for `<input type="datetime-local">`. */
export function toStoreDateTimeLocal(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: safeZone(timeZone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return iso.slice(0, 16);
  }
}

/** Milliseconds the timezone is ahead of UTC at the given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - instant.getTime();
}

/**
 * Interpret a "YYYY-MM-DDTHH:MM" wall-clock value (from a datetime-local input) as a time in the
 * store's timezone and return the matching UTC ISO instant. Returns null if the value is malformed.
 * Without this, a value typed as 09:00 (meaning Bangkok) on a UTC server would be stored as 09:00Z
 * (= 16:00 Bangkok).
 */
export function storeDateTimeToUtc(wall: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(utcGuess)) return null;
  const offset = tzOffsetMs(new Date(utcGuess), safeZone(timeZone));
  return new Date(utcGuess - offset).toISOString();
}

import { DEFAULT_TIME_ZONE } from "@/shared/utils/datetime";

// Re-exported for existing callers; the implementations live in the shared datetime utils.
export { formatStoreTime, toStoreDateTimeLocal, storeDateTimeToUtc } from "@/shared/utils/datetime";

const DEFAULT_ATTENDANCE_TIME_ZONE = DEFAULT_TIME_ZONE;

function formatLocalDate(timeZone: string, now: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
}

export function getStoreLocalDate(timeZone: string, now = new Date()): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatLocalDate(timeZone || DEFAULT_ATTENDANCE_TIME_ZONE, now);
  } catch {
    parts = formatLocalDate(DEFAULT_ATTENDANCE_TIME_ZONE, now);
  }

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return now.toISOString().split("T")[0];
  }
  return `${year}-${month}-${day}`;
}

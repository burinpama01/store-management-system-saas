const DEFAULT_TIME_ZONE = "Asia/Bangkok";

export interface GenerateOrderNumberInput {
  now?: Date;
  timeZone?: string | null;
}

function getTimeParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === "24" ? "00" : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function getSafeTimeParts(now: Date, timeZone?: string | null) {
  try {
    return getTimeParts(now, timeZone || DEFAULT_TIME_ZONE);
  } catch {
    return getTimeParts(now, DEFAULT_TIME_ZONE);
  }
}

export function generateOrderNumber(input: GenerateOrderNumberInput = {}): string {
  const now = input.now ?? new Date();
  const parts = getSafeTimeParts(now, input.timeZone);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const date = `${parts.year.slice(2)}${parts.month}${parts.day}`;
  const time = `${parts.hour}${parts.minute}${parts.second}`;
  return `${date}-${time}-${suffix}`;
}

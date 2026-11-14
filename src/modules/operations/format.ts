/** เวลาตามเขตเวลาร้าน เช่น "21:42" */
export function formatStoreTime(iso: string | null, timeZone: string): string {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("th-TH", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** วันที่+เวลาตามเขตเวลาร้าน เช่น "15 ต.ค. 21:42" */
export function formatStoreDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return "-";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      timeZone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** "HH:MM" ปัจจุบันตามเขตเวลาร้าน */
export function getStoreLocalTime(timeZone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    return `${hour === "24" ? "00" : hour}:${minute}`;
  } catch {
    return now.toISOString().slice(11, 16);
  }
}

/** วันที่ "YYYY-MM-DD" → "พ. 15 ต.ค. 2569" */
export function formatShiftDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

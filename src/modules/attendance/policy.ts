import type { GeoPoint } from "./geo";
import { isWithinRadius } from "./geo";

export interface ClockLocationInput {
  lat?: string | null;
  lng?: string | null;
  locationLabel?: string | null;
  /** Reported GPS accuracy in metres (radius of 68% confidence). */
  accuracy?: string | null;
}

export interface ParsedClockLocation {
  lat?: number;
  lng?: number;
  locationLabel?: string;
  accuracy?: number;
}

export interface AttendanceGpsPolicy {
  gpsEnabled: boolean;
  center?: GeoPoint;
  radiusMeters?: number;
}

/**
 * How much of the device's reported GPS accuracy we add to the geofence radius, capped so a
 * device without real GPS (coarse network/IP location, accuracy of km) still cannot pass.
 * Typical phone GPS accuracy is ~5–65m (up to ~165m indoors), so 200m comfortably covers a
 * staff member standing at the store whose fix drifted just outside the circle.
 */
const GPS_ACCURACY_TOLERANCE_M = 200;

function parseCoordinate(value: string | null | undefined, min: number, max: number) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

export function parseClockLocation(
  input: ClockLocationInput,
  locationAllowed: boolean,
): ParsedClockLocation {
  if (!locationAllowed) return {};

  const lat = parseCoordinate(input.lat, -90, 90);
  const lng = parseCoordinate(input.lng, -180, 180);
  if (lat === undefined || lng === undefined) return {};

  const locationLabel = input.locationLabel?.trim().slice(0, 120);
  const accuracyRaw = input.accuracy ? Number(input.accuracy) : Number.NaN;
  const accuracy = Number.isFinite(accuracyRaw) && accuracyRaw >= 0 ? accuracyRaw : undefined;
  return {
    lat,
    lng,
    ...(locationLabel ? { locationLabel } : {}),
    ...(accuracy !== undefined ? { accuracy } : {}),
  };
}

export function validateAttendanceGpsPolicy(
  location: ParsedClockLocation,
  policy: AttendanceGpsPolicy,
): string | null {
  if (!policy.gpsEnabled) return null;
  // When GPS is on, a real captured location is mandatory before clocking in/out.
  if (location.lat === undefined || location.lng === undefined) {
    return "กรุณาอนุญาตตำแหน่งเพื่อบันทึกเวลา";
  }
  // No geofence radius configured → a captured location is enough.
  if (!policy.center || policy.radiusMeters === undefined) return null;
  // Allow for the device's reported GPS error margin (capped) so a staff member who is at the
  // store but whose fix drifted just outside the circle is not wrongly rejected.
  const tolerance = Math.min(location.accuracy ?? 0, GPS_ACCURACY_TOLERANCE_M);
  return isWithinRadius(
    { lat: location.lat, lng: location.lng },
    policy.center,
    policy.radiusMeters + tolerance,
  )
    ? null
    : "ตำแหน่งอยู่นอกพื้นที่ที่กำหนด สัญญาณ GPS อาจไม่แม่น ลองใหม่อีกครั้งหรือใช้มือถือ";
}

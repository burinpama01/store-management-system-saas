import type { GeoPoint } from "./geo";
import { isWithinRadius } from "./geo";

export interface ClockLocationInput {
  lat?: string | null;
  lng?: string | null;
  locationLabel?: string | null;
}

export interface ParsedClockLocation {
  lat?: number;
  lng?: number;
  locationLabel?: string;
}

export interface AttendanceGpsPolicy {
  gpsEnabled: boolean;
  center?: GeoPoint;
  radiusMeters?: number;
}

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
  return {
    lat,
    lng,
    ...(locationLabel ? { locationLabel } : {}),
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
  return isWithinRadius(
    { lat: location.lat, lng: location.lng },
    policy.center,
    policy.radiusMeters,
  )
    ? null
    : "ตำแหน่งอยู่นอกพื้นที่ที่กำหนด";
}

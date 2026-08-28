// Task 9/D (v0.34.0) — PII redaction for AI inputs.
// The ONLY path into the AI provider is this allowlist: unknown keys are dropped,
// enum values are coerced to safe defaults, free-text is capped and sanitised.
// The plan forbids sending store names, user names, phone numbers, full IPs,
// tokens or raw logs — tests in ai-boundary.test.ts enforce it.
export type RedactedDeviceInput = Readonly<{
  errorCode: ErrorCode;
  platform: Platform;
  channel: Channel;
  printerModel?: string;
  testPattern?: "blank" | "garbled-thai" | "cropped";
}>;

type ErrorCode = "timeout" | "disconnected" | "unknown";
type Platform = "windows" | "android" | "ios" | "other";
type Channel = "usb" | "ble" | "hub" | "ip" | "browser";
type TestPattern = "blank" | "garbled-thai" | "cropped";

const ERROR_CODES: ReadonlySet<ErrorCode> = new Set(["timeout", "disconnected", "unknown"]);
const PLATFORMS: ReadonlySet<Platform> = new Set(["windows", "android", "ios", "other"]);
const CHANNELS: ReadonlySet<Channel> = new Set(["usb", "ble", "hub", "ip", "browser"]);
const TEST_PATTERNS: ReadonlySet<TestPattern> = new Set(["blank", "garbled-thai", "cropped"]);

function pickEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return typeof value === "string" && (allowed as ReadonlySet<string>).has(value) ? (value as T) : fallback;
}

function sanitizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9 .\-()]/g, "").trim().slice(0, 40);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function redactDeviceDiagnosisInput(raw: Record<string, unknown>): RedactedDeviceInput {
  const out: { errorCode: ErrorCode; platform: Platform; channel: Channel; printerModel?: string; testPattern?: TestPattern } = {
    errorCode: pickEnum(raw.errorCode, ERROR_CODES, "unknown"),
    platform: pickEnum(raw.platform, PLATFORMS, "other"),
    channel: pickEnum(raw.channel, CHANNELS, "browser"),
  };
  const model = sanitizeModel(raw.printerModel);
  if (model) out.printerModel = model;
  if (typeof raw.testPattern === "string" && TEST_PATTERNS.has(raw.testPattern as TestPattern)) {
    out.testPattern = raw.testPattern as TestPattern;
  }
  return out;
}

/** Keep the network prefix only — a full IP must never reach the provider. */
export function maskIp(ip: string): string {
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  return "x.x.x.x";
}
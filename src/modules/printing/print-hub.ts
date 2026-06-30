import crypto from "node:crypto";
import { isAllowedNetworkPrinterHost } from "@/modules/printing/network-printer";

/** Receipts can be raster bitmaps, so allow the same ceiling as the IP route. */
export const MAX_PRINT_JOB_BYTES = 256 * 1024;
export const MAX_PRINT_JOB_BASE64_CHARS = Math.ceil((MAX_PRINT_JOB_BYTES * 4) / 3) + 4;

/** A Hub that has not polled within this window is shown as offline. */
export const HUB_OFFLINE_THRESHOLD_MS = 90 * 1000;
export const HUB_DEFAULT_POLL_INTERVAL_MS = 2500;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** A high-entropy secret the Hub presents on every poll/ack call. */
export function generateHubToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashHubToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison so a wrong token cannot be discovered by timing. */
export function verifyHubToken(token: string, expectedHash: string | null | undefined): boolean {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashHubToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export interface HubStatusSummary {
  online: boolean;
  lastSeen: string | null;
  secondsAgo: number | null;
}

export function summarizeHubStatus(
  lastSeen: string | Date | null | undefined,
  now: Date = new Date(),
  offlineThresholdMs: number = HUB_OFFLINE_THRESHOLD_MS,
): HubStatusSummary {
  if (!lastSeen) return { online: false, lastSeen: null, secondsAgo: null };
  const seenAt = lastSeen instanceof Date ? lastSeen : new Date(lastSeen);
  const ms = now.getTime() - seenAt.getTime();
  if (Number.isNaN(ms)) return { online: false, lastSeen: null, secondsAgo: null };
  return {
    online: ms >= 0 && ms <= offlineThresholdMs,
    lastSeen: seenAt.toISOString(),
    secondsAgo: Math.max(0, Math.round(ms / 1000)),
  };
}

export interface ValidatedPrintTarget {
  host: string;
  port: number;
}

/** Validates a LAN print target the same way the synchronous bridge does. */
export function validatePrintTarget(input: {
  host: unknown;
  port?: unknown;
}): { target?: ValidatedPrintTarget; error?: string } {
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!isAllowedNetworkPrinterHost(host)) {
    return { error: "Invalid or disallowed IP address" };
  }
  const port = input.port === undefined || input.port === null ? 9100 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "Invalid port number" };
  }
  return { target: { host, port } };
}

/** Windows Bluetooth SPP ports are COM1..COM999. Strict so it is safe to pass
 *  to the cashier PC's `mode` command / device path without injection risk. */
const COM_PORT_RE = /^COM([1-9]\d{0,2})$/;

/**
 * Validates + normalizes a cashier-PC Bluetooth COM port (e.g. " com5 " →
 * "COM5"). This is the target for a Hub-routed Bluetooth printer.
 */
export function validateHubBluetoothPort(value: unknown): { device?: string; error?: string } {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!raw) return { error: "Missing Bluetooth COM port" };
  if (!COM_PORT_RE.test(raw)) {
    return { error: "พอร์ต Bluetooth ไม่ถูกต้อง ต้องเป็นรูปแบบ COM1–COM999 (เช่น COM5)" };
  }
  return { device: raw };
}

/** Ensures a base64 print payload is well-formed and within size limits. */
export function validatePrintPayloadBase64(value: unknown): { payload?: string; error?: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { error: "Missing print job" };
  }
  if (value.length > MAX_PRINT_JOB_BASE64_CHARS || !BASE64_RE.test(value)) {
    return { error: "Invalid print job" };
  }
  const byteLength = Buffer.from(value, "base64").length;
  if (byteLength === 0 || byteLength > MAX_PRINT_JOB_BYTES) {
    return { error: "Print job too large" };
  }
  return { payload: value };
}

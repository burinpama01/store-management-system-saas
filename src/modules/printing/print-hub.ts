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

/**
 * Windows printer names are free text, but the Hub agent interpolates the name
 * into a PowerShell script, so only a conservative set of characters is
 * accepted: Thai/Latin letters, digits, spaces and the punctuation vendors
 * actually use in printer names. Quotes, backticks, `$` and `;` are rejected
 * outright rather than escaped, so no injection can reach the cashier PC.
 */
const USB_PRINTER_NAME_RE = /^[\p{L}\p{M}\p{N} _.\-()#+\/&,:]{1,128}$/u;

/**
 * Validates a cashier-PC Windows printer name for a Hub-routed USB print job.
 * An empty value is valid and means "ให้ Hub ตรวจจับเครื่องพิมพ์เอง" — the agent
 * then picks the USB printer it finds, so moving the cable to another port (or
 * to another PC) needs no reconfiguration.
 */
export function validateHubUsbPrinterName(value: unknown): { device?: string | null; error?: string } {
  if (value === null || value === undefined) return { device: null };
  if (typeof value !== "string") return { error: "ชื่อเครื่องพิมพ์ไม่ถูกต้อง" };
  const raw = value.trim();
  if (!raw) return { device: null };
  if (!USB_PRINTER_NAME_RE.test(raw)) {
    return { error: "ชื่อเครื่องพิมพ์ไม่ถูกต้อง (ห้ามมีเครื่องหมายคำพูดหรืออักขระพิเศษ และยาวไม่เกิน 128 ตัวอักษร)" };
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

/**
 * เวอร์ชัน protocol ระหว่างเซิร์ฟเวอร์กับ Hub agent (แผน v3 Task 2).
 * agent รุ่นก่อนหน้าไม่ส่งเลข → นับเป็น LEGACY และยังทำงานได้ในช่วง compatibility
 * window เพราะร้านอัปเดต Hub เองไม่พร้อมกัน การตัดร้านเก่าออกทันทีวัน deploy
 * เท่ากับทำให้ร้านหยุดพิมพ์พร้อมกัน จึงยกระดับขั้นต่ำเมื่อร้านอัปเดตครบแล้วเท่านั้น
 */
export const PRINT_HUB_PROTOCOL_VERSION = 1;
export const PRINT_HUB_LEGACY_PROTOCOL_VERSION = 0;
export const PRINT_HUB_MIN_PROTOCOL_VERSION = PRINT_HUB_LEGACY_PROTOCOL_VERSION;

/** เวลาที่ agent มีให้ ack หนึ่งงานก่อนถูกนับเป็น unknown (วินาที) */
export const PRINT_JOB_LEASE_SECONDS = 120;

/**
 * คิวงานพิมพ์เริ่มใหม่ทุกเที่ยงคืนตามเวลาของร้าน — งานที่ค้างข้ามคืนถูกปิดเป็น failed
 * และไม่ถูกแจกให้ agent อีก (บิลเก่าสั่งพิมพ์ย้อนหลังจากประวัติได้อยู่แล้ว)
 * ตัวตัดสินอยู่ในฐานข้อมูล: store_day_start() / expire_old_print_jobs()
 */
export const PRINT_QUEUE_RESETS_AT_STORE_MIDNIGHT = true;

/** ผลของงานพิมพ์หนึ่งใบตามที่ agent รายงานกลับ */
export type PrintJobOutcome = "printed" | "failed" | "unknown";

/**
 * แปลง body ของ ack ให้เป็นผลลัพธ์เดียว รองรับทั้ง agent ใหม่ (outcome) และ
 * agent เดิมที่ส่งแค่ ok: boolean — "ไม่รู้ผล" ต้องไม่ถูกกลืนเป็น failed เพราะ
 * failed แปลว่า "รู้แน่ว่ายังไม่ออก" ซึ่งเปิดทางให้พิมพ์ซ้ำได้ ส่วน unknown ห้าม
 */
export function normalizeAckOutcome(body: { outcome?: unknown; ok?: unknown }): PrintJobOutcome {
  const outcome = typeof body.outcome === "string" ? body.outcome.trim().toLowerCase() : "";
  if (outcome === "printed" || outcome === "failed" || outcome === "unknown") return outcome;
  if (body.ok === true) return "printed";
  if (body.ok === false) return "failed";
  // ไม่มีทั้ง outcome และ ok = agent บอกไม่ได้ว่าเกิดอะไรขึ้น → fail closed เป็น unknown
  return "unknown";
}

const AGENT_VERSION_RE = /^[A-Za-z0-9 ._\-+]{1,32}$/;

/** เวอร์ชัน agent เป็นข้อความจากเครื่องร้าน — ตัดให้อยู่ในชุดอักขระที่ปลอดภัยก่อนเก็บ/แสดง */
export function sanitizeAgentVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || !AGENT_VERSION_RE.test(raw)) return null;
  return raw;
}

/**
 * ตรวจว่า agent ที่ poll เข้ามาใช้ protocol ที่ยังรองรับอยู่ไหม
 * agent ที่ไม่ส่งเลข = รุ่นก่อน v3 → นับเป็น LEGACY (ยังผ่านตราบใดที่ min = 0)
 * การยกระดับ min ต้องทำหลังร้านอัปเดต Hub ครบแล้วเท่านั้น ไม่งั้นร้านจะหยุดพิมพ์พร้อมกัน
 */
export function checkAgentProtocol(value: unknown): { version: number; supported: boolean; message?: string } {
  const version =
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : PRINT_HUB_LEGACY_PROTOCOL_VERSION;
  if (version < PRINT_HUB_MIN_PROTOCOL_VERSION) {
    return {
      version,
      supported: false,
      message:
        "Print Hub บนเครื่องแคชเชียร์เป็นเวอร์ชันเก่าเกินไป — ดาวน์โหลดตัวติดตั้งใหม่จากหน้าตั้งค่า Print Hub แล้วติดตั้งทับ",
    };
  }
  return { version, supported: true };
}

/** ระดับที่ร้านอนุญาตให้ Hub เลือกเครื่องพิมพ์เอง (ตรงกับ printers.hub_usb_binding_policy) */
export type HubUsbBindingPolicy = "auto_single" | "confirm_multi" | "manual";

export const HUB_USB_BINDING_POLICIES: ReadonlyArray<{
  readonly value: HubUsbBindingPolicy;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "auto_single",
    label: "ตรวจจับอัตโนมัติ (แนะนำสำหรับร้านที่มีเครื่องพิมพ์ตัวเดียว)",
    hint: "เสียบสาย USB แล้วพิมพ์ได้เลย ย้ายพอร์ตหรือเปลี่ยนสายก็ไม่ต้องตั้งค่าใหม่",
  },
  {
    value: "confirm_multi",
    label: "ให้ยืนยันก่อนทุกครั้งที่เปลี่ยนเครื่อง",
    hint: "เหมาะกับร้านที่มีเครื่องพิมพ์หลายตัว — ระบบจะไม่เดาให้ ต้องเลือกเองก่อนพิมพ์",
  },
  {
    value: "manual",
    label: "ใช้เฉพาะเครื่องที่เลือกไว้เท่านั้น",
    hint: "ถ้าเครื่องที่ผูกไว้หายไป จะไม่พิมพ์ออกเครื่องอื่นเด็ดขาด",
  },
];

/** ค่าจากฟอร์ม/ฐานข้อมูลอาจเป็นอะไรก็ได้ — ตกลงมาที่ค่าที่ปลอดภัยที่สุดเสมอ */
export function parseUsbBindingPolicy(value: unknown): HubUsbBindingPolicy {
  return value === "confirm_multi" || value === "manual" ? value : "auto_single";
}

/** claim token เป็น uuid ที่เซิร์ฟเวอร์ออกให้ต่อการเคลมหนึ่งครั้ง */
const CLAIM_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeClaimToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  return CLAIM_TOKEN_RE.test(raw) ? raw : null;
}

/**
 * รับ log จาก StoreOS Launcher บนเครื่องแคชเชียร์ของร้าน
 *
 * ทำไมต้องมี: ปัญหาของ Launcher/Print Hub เกิดบน "เครื่องคนอื่น" ที่เราเข้าไปดูไม่ได้
 * (ไดรเวอร์คนละรุ่น, Windows คนละ build, ไม่มี Node, WebView2 เก่า) ถ้าไม่ส่ง log กลับมา
 * การไล่ปัญหาต้องอาศัยการถามร้านทางโทรศัพท์ซึ่งได้ข้อมูลไม่ครบเสมอ
 *
 * ข้อกำหนดความปลอดภัย/ความเป็นส่วนตัวของ payload นี้ (ตรงกับ privacy contract ของแผน):
 *   - เป็น "ข้อมูล ไม่ใช่คำสั่ง" — ทุกฟิลด์ถูกตรวจรูปทรงและตัดความยาวก่อนบันทึกเสมอ
 *   - ห้ามมีเนื้องานพิมพ์ (payload base64), โทเค็น, เสียง หรือ transcript
 *   - ถ้าเผลอมีอะไรที่ดูเหมือนโทเค็นหลุดมา ต้องถูกกลบก่อนลงฐานข้อมูล (ดู redactSensitive)
 */

export type LauncherLogLevel = "info" | "warn" | "error";

export interface LauncherLogEntry {
  /** เวลาที่เครื่องร้านบันทึก (ISO 8601) — null ถ้าค่าที่ส่งมาใช้ไม่ได้ */
  at: string | null;
  level: LauncherLogLevel;
  /** รหัสเหตุการณ์แบบสั้น เช่น hub_start_requested, webview2_missing */
  code: string;
  message: string;
  context: Record<string, string | number | boolean> | null;
}

export interface LauncherLogBatch {
  entries: LauncherLogEntry[];
  /** จำนวนรายการที่ถูกทิ้งเพราะรูปทรงไม่ผ่านหรือเกินเพดาน (บันทึกไว้ให้เห็นว่ามีของหาย) */
  dropped: number;
}

/** เพดานต่อหนึ่ง request — Launcher ต้องรวมเป็นก้อนแล้วส่ง ไม่ใช่ยิงทีละบรรทัด */
export const MAX_LAUNCHER_LOG_ENTRIES = 50;
export const MAX_LAUNCHER_MESSAGE_CHARS = 300;
export const MAX_LAUNCHER_CODE_CHARS = 64;
export const MAX_LAUNCHER_CONTEXT_KEYS = 12;
export const MAX_LAUNCHER_CONTEXT_VALUE_CHARS = 120;

const CODE_RE = /^[a-z0-9_.\-]{1,64}$/i;

/**
 * กลบค่าที่ดูเหมือนความลับก่อนบันทึก — กันเคสที่ข้อความ error ของ Windows/HTTP
 * ดันมีโทเค็นติดมาด้วย (เช่น URL ที่มี query token) ซึ่งเป็นเหตุผลว่าทำไม log ฝั่งเรา
 * ต้องกลบซ้ำอีกชั้น ไม่ใช่เชื่อว่าฝั่งเครื่องร้านกลบมาแล้ว
 */
export function redactSensitive(text: string): string {
  return text
    // token=..., hubToken: ..., "authorization": "Bearer ..." (กิน Bearer/Basic ที่คั่นกลางด้วย)
    .replace(
      /((?:hub)?token|authorization|bearer|password|secret|apikey|api_key)([\s"':=]+)(?:(?:bearer|basic)[\s"':=]+)?[^\s"',;]{6,}/gi,
      (_match, key: string, sep: string) => `${key}${sep}[ซ่อนไว้]`,
    )
    // สตริงยาวแบบ base64/hex ที่ไม่มีช่องว่าง (โทเค็นของ Hub ยาว >= 40)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[ซ่อนไว้]");
}

function normalizeLevel(value: unknown): LauncherLogLevel {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "error" || raw === "warn" || raw === "warning") return raw === "warning" ? "warn" : raw;
  if (raw === "info" || raw === "information") return "info";
  // ไม่รู้ระดับ = info (ไม่ยกระดับความรุนแรงให้เอง เพราะจะกลบ error จริงในหน้ารายงาน)
  return "info";
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // นาฬิกาเครื่องร้านอาจเพี้ยน — ยอมรับได้ แต่ไม่ให้ล้ำอนาคตเกิน 1 วัน (กันกราฟเพี้ยน)
  const maxFuture = Date.now() + 24 * 60 * 60 * 1000;
  return parsed > maxFuture ? null : new Date(parsed).toISOString();
}

function normalizeContext(value: unknown): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean> = {};
  let keys = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (keys >= MAX_LAUNCHER_CONTEXT_KEYS) break;
    if (!CODE_RE.test(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === "boolean") out[key] = raw;
    else if (typeof raw === "string") out[key] = redactSensitive(raw.slice(0, MAX_LAUNCHER_CONTEXT_VALUE_CHARS));
    else continue;
    keys += 1;
  }
  return keys > 0 ? out : null;
}

/** ตรวจ + ตัด + กลบ ก้อน log ที่ Launcher ส่งมา (pure → ทดสอบได้ทั้งหมด) */
export function sanitizeLauncherLogBatch(value: unknown): LauncherLogBatch {
  if (!Array.isArray(value)) return { entries: [], dropped: 0 };

  const entries: LauncherLogEntry[] = [];
  let dropped = 0;

  for (const raw of value) {
    if (entries.length >= MAX_LAUNCHER_LOG_ENTRIES) {
      dropped += 1;
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      dropped += 1;
      continue;
    }
    const row = raw as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code.trim().slice(0, MAX_LAUNCHER_CODE_CHARS) : "";
    if (!code || !CODE_RE.test(code)) {
      dropped += 1;
      continue;
    }
    const message = typeof row.message === "string" ? row.message.trim() : "";
    entries.push({
      at: normalizeTimestamp(row.at),
      level: normalizeLevel(row.level),
      code,
      message: redactSensitive(message).slice(0, MAX_LAUNCHER_MESSAGE_CHARS),
      context: normalizeContext(row.context),
    });
  }

  return { entries, dropped };
}

const VERSION_RE = /^[A-Za-z0-9 ._\-+]{1,32}$/;

/** เวอร์ชันของ Launcher/agent เป็นข้อความจากเครื่องร้าน — จำกัดชุดอักขระก่อนเก็บ */
export function sanitizeLauncherVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  return VERSION_RE.test(raw) ? raw : null;
}

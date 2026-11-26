// ล็อกอินเครื่องร้านด้วย QR + รหัสพนักงาน (แผน POS Launcher Direct IP Printing v2 — เฟส D2b)
//
// ความปลอดภัย:
//   * QR มีแค่ id คำขอ (uuid) + รหัสสั้น — ไม่มีอะไรที่ใช้เข้าระบบได้
//   * รหัสลับของเครื่อง (32 ไบต์) อยู่ในหน้าเว็บบนเครื่องร้านเท่านั้น เก็บใน DB เป็น sha256
//   * คนอนุมัติต้องล็อกอินอยู่แล้วบนมือถือ + กรอกรหัสพนักงานของตัวเองให้ตรง (ยืนยันซ้ำ ไม่ใช่ความลับ)
//   * หน้าอนุมัติบอกว่ามือถือกับเครื่องที่ขออยู่เครือข่ายเดียวกันไหม (กันส่ง QR หลอกทาง LINE)
//   * ผิด 5 ครั้ง = ยกเลิกคำขอ / หมดอายุ 5 นาที / ตั๋วแลก session ใช้ได้ครั้งเดียวภายใน 2 นาที
//   * จำกัดคำขอใหม่ต่อ IP (endpoint ขอ QR เป็น public)
//   * session ที่ได้ = ของพนักงานคนนั้น สิทธิ์เท่าบัญชีเขาเท่านั้น

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const DEVICE_LOGIN_TTL_MS = 5 * 60_000;
export const DEVICE_LOGIN_TICKET_TTL_MS = 2 * 60_000;
export const DEVICE_LOGIN_MAX_ATTEMPTS = 5;
/** คำขอใหม่ต่อ IP ใน 10 นาที — ร้านจริงสร้างไม่กี่ครั้ง (หมดอายุ 5 นาทีสร้างใหม่ ≈ 2 ครั้ง/10 นาที/เครื่อง) */
export const DEVICE_LOGIN_MAX_PER_IP = 20;
const RATE_WINDOW_MS = 10 * 60_000;
/** ไม่มีตัวที่สับสนกัน (0/O, 1/I/L) — พนักงานพิมพ์ตามจอได้ */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type DeviceLoginStatus = "pending" | "approved" | "completed" | "cancelled" | "expired";

export interface DeviceLoginPublicView {
  readonly id: string;
  readonly shortCode: string;
  readonly deviceLabel: string | null;
  readonly status: DeviceLoginStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface Row {
  id: string;
  short_code: string;
  device_secret_hash: string;
  device_label: string | null;
  requester_ip_hash: string | null;
  status: DeviceLoginStatus;
  failed_attempts: number;
  approved_by: string | null;
  approved_store_id: string | null;
  ticket_hash: string | null;
  ticket_expires_at: string | null;
  expires_at: string;
  created_at: string;
}

export class DeviceLoginRateLimitError extends Error {}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function generateShortCode(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(6);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 3).join("")}-${chars.slice(3).join("")}`;
}

/** IP จาก header ของ Vercel (x-forwarded-for ตัวแรก) → sha256 — ไม่เก็บ/ไม่ส่ง IP ดิบ */
export function hashClientIp(forwardedFor: string | null | undefined, realIp?: string | null): string | null {
  const ip = (forwardedFor?.split(",")[0] ?? realIp ?? "").trim();
  return ip ? sha256Hex(`device-login:${ip}`) : null;
}

/** "somchai@gmail.com" → "so*****@gmail.com" */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "บัญชีนี้";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}${"*".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

export function normalizeEmployeeCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function cleanLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // ตัดอักขระควบคุม (กันข้อความแปลก ๆ ไหลเข้า log/หน้าอนุมัติ)
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่ยังไม่อยู่ใน database.types
async function db(): Promise<any> {
  return createSupabaseServiceClient();
}

function toPublic(row: Row): DeviceLoginPublicView {
  const expired = row.status === "pending" && Date.parse(row.expires_at) <= Date.now();
  return {
    id: row.id,
    shortCode: row.short_code,
    deviceLabel: row.device_label,
    status: expired ? "expired" : row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function createDeviceLoginRequest(input: { deviceLabel?: unknown; userAgent?: unknown; ipHash?: string | null }) {
  const client = await db();
  // เก็บกวาดคำขอที่หมดอายุเกิน 1 ชม. (เก็บไว้สั้น ๆ ให้หน้าอนุมัติบอกได้ว่า "หมดอายุ") — ไม่มี cron ว่าง
  await client.from("device_login_requests").delete().lt("expires_at", new Date(Date.now() - 3_600_000).toISOString());

  // จำกัดจำนวนคำขอต่อ IP (endpoint นี้ public) — กันสร้างแถวไม่จำกัด
  if (input.ipHash) {
    const { count } = await client
      .from("device_login_requests")
      .select("id", { count: "exact", head: true })
      .eq("requester_ip_hash", input.ipHash)
      .gt("created_at", new Date(Date.now() - RATE_WINDOW_MS).toISOString());
    if ((count ?? 0) >= DEVICE_LOGIN_MAX_PER_IP) throw new DeviceLoginRateLimitError("ขอ QR บ่อยเกินไป รอสักครู่แล้วลองใหม่");
  }

  const secret = randomBytes(32).toString("base64url");
  const row = {
    short_code: generateShortCode(),
    device_secret_hash: sha256Hex(secret),
    device_label: cleanLabel(input.deviceLabel, 80),
    user_agent: cleanLabel(input.userAgent, 300),
    requester_ip_hash: input.ipHash ?? null,
    expires_at: new Date(Date.now() + DEVICE_LOGIN_TTL_MS).toISOString(),
  };
  const { data, error } = await client.from("device_login_requests").insert(row).select("id, short_code, expires_at").single();
  if (error || !data) throw new Error(error?.message ?? "สร้างคำขอเข้าใช้ไม่สำเร็จ");
  return { requestId: data.id as string, code: data.short_code as string, secret, expiresAt: data.expires_at as string };
}

export async function getDeviceLoginRequest(
  id: string,
  viewerIpHash?: string | null,
): Promise<(DeviceLoginPublicView & { sameNetwork: boolean | null }) | null> {
  if (!isUuid(id)) return null;
  const client = await db();
  const { data } = await client
    .from("device_login_requests")
    .select("id, short_code, device_label, status, expires_at, created_at, requester_ip_hash")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const row = data as Row;
  // มือถือใช้ WiFi ร้าน = IP สาธารณะเดียวกับเครื่องร้าน; ใช้เน็ตมือถือจะต่างกัน (ไม่ใช่หลักฐานว่าโดนหลอก แต่ต้องเตือน)
  const sameNetwork = row.requester_ip_hash && viewerIpHash ? row.requester_ip_hash === viewerIpHash : null;
  return { ...toPublic(row), sameNetwork };
}

export type ApproveResult =
  | { ok: true; deviceLabel: string | null }
  | { ok: false; error: string; attemptsLeft?: number };

/**
 * พนักงานอนุมัติจากมือถือ — ผู้เรียก (server action) ต้องตรวจแล้วว่าล็อกอินอยู่ ไม่ได้ลาออก
 * และมีสิทธิ์ใช้ POS ในสาขา storeId
 */
export async function approveDeviceLoginRequest(input: {
  requestId: string;
  shortCode: string;
  employeeCode: string;
  userId: string;
  storeId: string;
}): Promise<ApproveResult> {
  if (!isUuid(input.requestId)) return { ok: false, error: "ไม่พบคำขอเข้าใช้" };
  const client = await db();
  const { data: row } = await client.from("device_login_requests").select("*").eq("id", input.requestId).maybeSingle();
  if (!row) return { ok: false, error: "ไม่พบคำขอเข้าใช้" };
  const view = toPublic(row as Row);
  if (view.status !== "pending") {
    return { ok: false, error: view.status === "expired" ? "คำขอหมดอายุแล้ว — ให้เครื่องร้านสร้าง QR ใหม่" : "คำขอนี้ใช้ไปแล้วหรือถูกยกเลิก" };
  }
  if (row.short_code !== input.shortCode.trim().toUpperCase()) {
    return { ok: false, error: "รหัสบนจอไม่ตรงกับคำขอ — สแกน QR จากเครื่องร้านอีกครั้ง" };
  }

  const { data: profiles } = await client
    .from("employee_profiles")
    .select("employee_code, store_id")
    .eq("user_id", input.userId)
    .not("employee_code", "is", null);
  const codes = ((profiles ?? []) as { employee_code: string | null }[])
    .map((p) => normalizeEmployeeCode(p.employee_code ?? ""))
    .filter(Boolean);
  if (codes.length === 0) {
    return { ok: false, error: "บัญชีนี้ยังไม่มีรหัสพนักงาน — ให้เจ้าของร้านตั้งให้ที่หน้า พนักงาน ก่อน" };
  }

  if (!codes.includes(normalizeEmployeeCode(input.employeeCode))) {
    const attempts = (row.failed_attempts as number) + 1;
    const cancel = attempts >= DEVICE_LOGIN_MAX_ATTEMPTS;
    await client
      .from("device_login_requests")
      .update({ failed_attempts: attempts, ...(cancel ? { status: "cancelled" } : {}) })
      .eq("id", input.requestId)
      .eq("status", "pending");
    return cancel
      ? { ok: false, error: "รหัสพนักงานผิดเกิน 5 ครั้ง — คำขอถูกยกเลิก ให้เครื่องร้านสร้าง QR ใหม่" }
      : { ok: false, error: "รหัสพนักงานไม่ถูกต้อง", attemptsLeft: DEVICE_LOGIN_MAX_ATTEMPTS - attempts };
  }

  // อัปเดตแบบมีเงื่อนไข: กันสองเครื่องกดอนุมัติพร้อมกัน / คำขอหมดอายุระหว่างนั้น
  const { data: updated } = await client
    .from("device_login_requests")
    .update({ status: "approved", approved_by: input.userId, approved_store_id: input.storeId, approved_at: new Date().toISOString() })
    .eq("id", input.requestId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id, device_label");
  if (!updated || updated.length === 0) return { ok: false, error: "คำขอหมดอายุหรือถูกใช้ไปแล้ว" };
  return { ok: true, deviceLabel: (updated[0] as { device_label: string | null }).device_label };
}

export async function cancelDeviceLoginRequest(requestId: string): Promise<void> {
  if (!isUuid(requestId)) return;
  const client = await db();
  await client.from("device_login_requests").update({ status: "cancelled" }).eq("id", requestId).eq("status", "pending");
}

export type PollResult =
  | { status: "pending" | "expired" | "cancelled" | "completed" | "invalid" }
  | { status: "approved"; ticket: string };

/** เครื่องร้านถามผล — ต้องมีรหัสลับของเครื่อง; อนุมัติแล้ว = ออกตั๋วครั้งเดียวให้ไปแลก session */
export async function pollDeviceLoginRequest(requestId: string, secret: string): Promise<PollResult> {
  if (!isUuid(requestId) || typeof secret !== "string" || secret.length < 20 || secret.length > 100) return { status: "invalid" };
  const client = await db();
  const { data: row } = await client.from("device_login_requests").select("*").eq("id", requestId).maybeSingle();
  if (!row || !sameHash(row.device_secret_hash, sha256Hex(secret))) return { status: "invalid" };
  const view = toPublic(row as Row);
  if (view.status !== "approved") return { status: view.status };

  // ออกตั๋วครั้งเดียว — ถ้าออกไปแล้วและยังไม่หมดอายุ (poll สองรอบซ้อนกัน) ไม่ออกใหม่ทับ
  // รอบที่สองตอบ pending แทน ตั๋วใบแรกยังใช้ได้; ตั๋วหมดอายุแล้วค่อยออกใบใหม่
  const now = new Date().toISOString();
  const ticket = randomBytes(32).toString("base64url");
  const { data: updated } = await client
    .from("device_login_requests")
    .update({ ticket_hash: sha256Hex(ticket), ticket_expires_at: new Date(Date.now() + DEVICE_LOGIN_TICKET_TTL_MS).toISOString() })
    .eq("id", requestId)
    .eq("status", "approved")
    .or(`ticket_hash.is.null,ticket_expires_at.lt."${now}"`)
    .select("id");
  if (!updated || updated.length === 0) return { status: "pending" };
  return { status: "approved", ticket };
}

export interface VerifiedTicket {
  readonly userId: string;
  readonly storeId: string | null;
  readonly deviceLabel: string | null;
  readonly ticketHash: string;
}

/**
 * ขั้น 1: ตรวจตั๋ว (ยังไม่ใช้) — route สร้าง session ก่อน แล้วค่อย mark completed
 * ถ้าสร้าง session ล้ม (auth สะดุด) ตั๋วยังใช้ได้จนหมดอายุ เครื่องลองใหม่ได้ไม่ต้องให้พนักงานอนุมัติซ้ำ
 */
export async function verifyDeviceLoginTicket(requestId: string, ticket: string): Promise<VerifiedTicket | null> {
  if (!isUuid(requestId) || typeof ticket !== "string" || ticket.length < 20 || ticket.length > 100) return null;
  const client = await db();
  const { data: row } = await client.from("device_login_requests").select("*").eq("id", requestId).maybeSingle();
  if (!row || row.status !== "approved" || !row.ticket_hash || !row.approved_by) return null;
  if (!sameHash(row.ticket_hash, sha256Hex(ticket))) return null;
  if (!row.ticket_expires_at || Date.parse(row.ticket_expires_at) <= Date.now()) return null;
  return {
    userId: row.approved_by as string,
    storeId: (row.approved_store_id as string | null) ?? null,
    deviceLabel: row.device_label as string | null,
    ticketHash: row.ticket_hash as string,
  };
}

/** ขั้น 2: mark completed แบบมีเงื่อนไข (ตั๋วใบนี้ใช้ได้ครั้งเดียวจริง แม้ยิงพร้อมกัน) — false = ถูกใช้ไปแล้ว */
export async function markDeviceLoginCompleted(requestId: string, ticketHash: string): Promise<boolean> {
  const client = await db();
  const { data: updated } = await client
    .from("device_login_requests")
    .update({ status: "completed", completed_at: new Date().toISOString(), ticket_hash: null })
    .eq("id", requestId)
    .eq("status", "approved")
    .eq("ticket_hash", ticketHash)
    .select("id");
  return Boolean(updated && updated.length > 0);
}

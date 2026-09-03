/**
 * Minimal transactional email sender backed by Resend (https://resend.com).
 * Configured via env: RESEND_API_KEY + ENTERPRISE_FROM_EMAIL (verified sender).
 * When unconfigured it skips silently so flows never fail just because email is off.
 */

import { logSystemEvent } from "@/modules/system/event-log";

/** โดเมนของผู้ส่ง — พอสำหรับหาสาเหตุ โดยไม่เก็บอีเมลเต็มลง log */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).replace(/>$/, "") : "unknown";
}

/** อ่านเนื้อคำตอบตอนพลาดแบบไม่ให้พังซ้ำ และตัดความยาวก่อนบันทึก */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.trim().slice(0, 300);
  } catch {
    return "อ่านคำตอบจากผู้ให้บริการไม่ได้";
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Overrides the env sender. Used by the super-admin-configured Enterprise sender. */
  from?: string;
}

export interface SendEmailResult {
  ok: boolean;
  skipped: boolean;
  message: string;
  /** รายละเอียดจากผู้ให้บริการ — สำหรับบันทึก log เท่านั้น ไม่เอาไปโชว์ผู้ใช้ */
  detail?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_DELIVERY_TIMEOUT_MS = 8_000;

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && (process.env.ENTERPRISE_FROM_EMAIL || process.env.EMAIL_FROM));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("email_delivery_timeout"));
    }, EMAIL_DELIVERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = input.from?.trim() || process.env.ENTERPRISE_FROM_EMAIL || process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    // เส้นทาง "สำเร็จแบบเงียบ" ที่อันตรายที่สุดของโมดูลนี้ — ผู้เรียกได้ ok:true
    // แล้วเดินต่อเหมือนส่งแล้ว ทั้งที่ไม่มีอีเมลออกไปเลย ต้องมีร่องรอยเสมอ
    await logSystemEvent({
      level: "warn",
      source: "notifications.email",
      action: "sendTransactionalEmail",
      message: "ข้ามการส่งอีเมล: ยังไม่ได้ตั้งค่า Resend",
      context: {
        hasApiKey: Boolean(apiKey),
        hasFrom: Boolean(from),
        subject: input.subject,
      },
    });
    return { ok: true, skipped: true, message: "อีเมลยังไม่พร้อมใช้งาน (ไม่ได้ตั้งค่า Resend)" };
  }
  if (!input.to.trim()) {
    return { ok: false, skipped: false, message: "ไม่มีอีเมลปลายทาง" };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [input.to.trim()],
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    await logSystemEvent({
      level: "error",
      source: "notifications.email",
      action: "sendTransactionalEmail",
      message: "ส่งอีเมลไม่สำเร็จ: เชื่อมต่อผู้ให้บริการอีเมลไม่ได้",
      context: { subject: input.subject, detail, fromDomain: domainOf(from) },
    });
    return { ok: false, skipped: false, message: "ส่งอีเมลไม่สำเร็จ: เชื่อมต่อผู้ให้บริการอีเมลไม่ได้", detail };
  }

  if (!response.ok) {
    // Resend บอกสาเหตุจริงในเนื้อคำตอบ (โดเมนยังไม่ verified / ผู้ส่งไม่ได้รับอนุญาต /
    // คีย์ผิด) รหัสสถานะอย่างเดียวหาสาเหตุไม่ได้ — เก็บลง log ไม่ส่งต่อให้ผู้ใช้อ่าน
    const detail = await readErrorDetail(response);
    await logSystemEvent({
      level: "error",
      source: "notifications.email",
      action: "sendTransactionalEmail",
      message: `ส่งอีเมลไม่สำเร็จ (${response.status})`,
      errorCode: String(response.status),
      context: { subject: input.subject, detail, fromDomain: domainOf(from) },
    });
    return { ok: false, skipped: false, message: `ส่งอีเมลไม่สำเร็จ (${response.status})`, detail };
  }

  await logSystemEvent({
    level: "info",
    source: "notifications.email",
    action: "sendTransactionalEmail",
    message: "ส่งอีเมลสำเร็จ",
    context: { subject: input.subject, fromDomain: domainOf(from) },
  });
  return { ok: true, skipped: false, message: "ส่งอีเมลสำเร็จ" };
}

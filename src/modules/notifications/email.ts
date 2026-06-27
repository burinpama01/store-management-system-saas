/**
 * Minimal transactional email sender backed by Resend (https://resend.com).
 * Configured via env: RESEND_API_KEY + ENTERPRISE_FROM_EMAIL (verified sender).
 * When unconfigured it skips silently so flows never fail just because email is off.
 */

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
  } catch {
    return { ok: false, skipped: false, message: "ส่งอีเมลไม่สำเร็จ: เชื่อมต่อผู้ให้บริการอีเมลไม่ได้" };
  }

  if (!response.ok) {
    return { ok: false, skipped: false, message: `ส่งอีเมลไม่สำเร็จ (${response.status})` };
  }
  return { ok: true, skipped: false, message: "ส่งอีเมลสำเร็จ" };
}

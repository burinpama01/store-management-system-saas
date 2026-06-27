import { sendTransactionalEmail } from "@/modules/notifications/email";
import { getEnterpriseFromEmail } from "@/modules/billing/platform-settings";
import type { EnterpriseRequestStatus } from "./repository";

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

const STATUS_HEADLINE: Record<EnterpriseRequestStatus, string> = {
  new: "เราได้รับคำขอของคุณแล้ว",
  contacted: "ทีมงานกำลังติดต่อกลับ",
  closed: "คำขอ Enterprise ของคุณดำเนินการเสร็จสิ้น",
};

const STATUS_BODY: Record<EnterpriseRequestStatus, string> = {
  new: "เราได้รับคำขอใช้งานแบบ Enterprise ของคุณแล้ว ทีมงาน StoreOS จะติดต่อกลับโดยเร็วที่สุด",
  contacted: "ทีมงาน StoreOS กำลังติดต่อกลับเพื่อพูดคุยรายละเอียดแพ็กเกจ Enterprise ของคุณ",
  closed: "คำขอ Enterprise ของคุณถูกปิดแล้ว หากต้องการความช่วยเหลือเพิ่มเติม สามารถส่งคำขอใหม่ได้ตลอดเวลา",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrapHtml(headline: string, body: string): string {
  return [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">`,
    `<h2 style="color:#111827">${escapeHtml(headline)}</h2>`,
    `<p style="font-size:15px;line-height:1.6">${escapeHtml(body)}</p>`,
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />`,
    `<p style="font-size:12px;color:#6b7280">StoreOS · ระบบจัดการร้าน</p>`,
    `</div>`,
  ].join("");
}

/** Confirmation email sent right after a request is submitted. Pure. */
export function buildEnterpriseSubmittedEmail(input: { companyName: string }): BuiltEmail {
  const headline = STATUS_HEADLINE.new;
  const body = `${STATUS_BODY.new} (บริษัท: ${input.companyName})`;
  return {
    subject: "StoreOS — ได้รับคำขอใช้งาน Enterprise แล้ว",
    html: wrapHtml(headline, body),
    text: `${headline}\n\n${body}\n\nStoreOS`,
  };
}

/** Status-change email sent when the super-admin updates a request. Pure. */
export function buildEnterpriseStatusEmail(input: {
  companyName: string;
  status: EnterpriseRequestStatus;
}): BuiltEmail {
  const headline = STATUS_HEADLINE[input.status];
  const body = `${STATUS_BODY[input.status]} (บริษัท: ${input.companyName})`;
  return {
    subject: `StoreOS — อัปเดตคำขอ Enterprise: ${headline}`,
    html: wrapHtml(headline, body),
    text: `${headline}\n\n${body}\n\nStoreOS`,
  };
}

/** Email used by the super-admin "test send" button. Pure. */
export function buildEnterpriseTestEmail(): BuiltEmail {
  const headline = "ทดสอบส่งอีเมล Enterprise สำเร็จ ✅";
  const body = "นี่คืออีเมลทดสอบจากระบบคำขอ Enterprise ของ StoreOS หากคุณได้รับอีเมลนี้ แสดงว่าการตั้งค่าผู้ส่งถูกต้องและพร้อมใช้งาน";
  return {
    subject: "StoreOS — ทดสอบส่งอีเมล Enterprise",
    html: wrapHtml(headline, body),
    text: `${headline}\n\n${body}\n\nStoreOS`,
  };
}

export async function sendEnterpriseTestEmail(input: { to: string }) {
  const from = (await getEnterpriseFromEmail()) ?? undefined;
  const email = buildEnterpriseTestEmail();
  return sendTransactionalEmail({ to: input.to, from, ...email });
}

export async function sendEnterpriseSubmittedEmail(input: { to: string; companyName: string }) {
  const from = (await getEnterpriseFromEmail()) ?? undefined;
  const email = buildEnterpriseSubmittedEmail({ companyName: input.companyName });
  return sendTransactionalEmail({ to: input.to, from, ...email });
}

export async function sendEnterpriseStatusEmail(input: {
  to: string;
  companyName: string;
  status: EnterpriseRequestStatus;
}) {
  const from = (await getEnterpriseFromEmail()) ?? undefined;
  const email = buildEnterpriseStatusEmail({ companyName: input.companyName, status: input.status });
  return sendTransactionalEmail({ to: input.to, from, ...email });
}

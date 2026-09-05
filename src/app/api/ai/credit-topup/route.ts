// POST /api/ai/credit-topup (multipart: packId + slip)
// เติมเครดิตโทเคน AI ด้วยสลิป PromptPay — ใช้ด่านสิทธิ์เดียวกับการชำระค่าแพ็กเกจ
import { NextResponse } from "next/server";
import { logActionError } from "@/modules/system/event-log";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { submitCreditTopup } from "@/modules/ai/credits";
import { getQuotaStatus } from "@/modules/ai/quota";

export const dynamic = "force-dynamic";

/** สลิปเป็นรูปถ่าย/แคปหน้าจอ — จำกัด 5 MB เท่ากับรูปเมนู */
const MAX_SLIP_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const perms = await getOptionalResolvedCurrentPermissions();
    if (!perms) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!perms.resolved.can("billing.manage")) {
      return NextResponse.json({ error: "ไม่มีสิทธิ์จัดการการชำระเงิน" }, { status: 403 });
    }

    const form = await req.formData();
    const packId = form.get("packId");
    const slip = form.get("slip");
    if (typeof packId !== "string" || !packId) {
      return NextResponse.json({ error: "กรุณาเลือกแพ็กเติมเงิน" }, { status: 400 });
    }
    if (!(slip instanceof File) || slip.size === 0) {
      return NextResponse.json({ error: "กรุณาแนบสลิป" }, { status: 400 });
    }
    if (slip.size > MAX_SLIP_BYTES) {
      return NextResponse.json({ error: "ไฟล์สลิปใหญ่เกิน 5 MB" }, { status: 413 });
    }

    const base64 = Buffer.from(await slip.arrayBuffer()).toString("base64");
    const result = await submitCreditTopup({
      organizationId: perms.ctx.organizationId,
      packId,
      submittedByUserId: perms.user.id,
      slipImageBase64: base64,
      slipImageContentType: slip.type || "image/jpeg",
    });

    const quota = await getQuotaStatus({ organizationId: perms.ctx.organizationId });
    return NextResponse.json({ ...result, ok: result.status === "verified", quota });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    logActionError({ source: "ai.credit-topup", action: "POST", error: e });
    return NextResponse.json({ error: "เกิดข้อผิดพลาดระหว่างเติมเครดิต" }, { status: 500 });
  }
}

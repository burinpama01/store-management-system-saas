import { NextResponse } from "next/server";
import { logActionError } from "@/modules/system/event-log";
import { getCurrentUser } from "@/modules/auth/session";
import { isSystemAdmin } from "@/modules/auth/guards";
import { decodeQrPayloadFromImage } from "@/modules/billing/qr-decode";
import { looksLikePromptPayPayload } from "@/modules/billing/promptpay-provider";
import { getPlatformSettings, updatePlatformPromptPay } from "@/modules/billing/platform-settings";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await isSystemAdmin())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const form = await req.formData();
    const file = form.get("qrImage");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "กรุณาแนบรูป QR" }, { status: 400 });
    }

    const decoded = await decodeQrPayloadFromImage(Buffer.from(await file.arrayBuffer()));
    if (!decoded) {
      return NextResponse.json({ error: "อ่าน QR Code จากรูปไม่สำเร็จ กรุณาใช้รูปที่ชัดเจน" }, { status: 422 });
    }
    if (!looksLikePromptPayPayload(decoded)) {
      return NextResponse.json({ error: "รูปนี้ไม่ใช่ QR PromptPay/EMVCo ที่ถูกต้อง" }, { status: 422 });
    }

    // Preserve other platform fields; only update the decoded static payload.
    const current = await getPlatformSettings();
    const res = await updatePlatformPromptPay(
      {
        billingProvider: current.billingProvider,
        promptpayId: current.promptpayId,
        promptpayName: current.promptpayName,
        promptpayStaticPayload: decoded,
      },
      user.id,
    );
    if (!res.ok) {
      return NextResponse.json({ error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, payload: decoded });
  } catch (e) {
    logActionError({ source: "system.promptpay-qr", action: "GET", error: e });
    console.error("[system/promptpay-qr]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

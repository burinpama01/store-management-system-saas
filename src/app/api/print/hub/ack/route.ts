import { NextRequest, NextResponse } from "next/server";
import { verifyHubToken } from "@/modules/printing/print-hub";
import { ackPrintJob, getStoreHubAuth } from "@/modules/printing/print-hub-repository";
import { logSystemEvent } from "@/modules/system/event-log";

/**
 * The Print Hub reports the result of a claimed job (printed or failed).
 * Authenticated by the per-store Hub token.
 */
export async function POST(req: NextRequest) {
  let body: {
    storeId?: string;
    hubToken?: string;
    jobId?: string;
    ok?: boolean;
    error?: string;
    /** ช่องทางที่ Hub ใช้พิมพ์จริง (ip/bt/usb) — ใช้ในบันทึกการทำงาน */
    kind?: string;
    /** เป้าหมายที่ Hub เลือกจริง เช่น ชื่อเครื่องพิมพ์ Windows ที่ตรวจจับได้ */
    target?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  const hubToken = typeof body.hubToken === "string" ? body.hubToken : "";
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!storeId || !hubToken || !jobId) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const auth = await getStoreHubAuth(storeId);
  if (auth.error || !auth.data || !verifyHubToken(hubToken, auth.data.tokenHash)) {
    return NextResponse.json({ error: "Invalid Hub credentials" }, { status: 401 });
  }

  const result = await ackPrintJob({
    jobId,
    storeId,
    ok: body.ok === true,
    error: typeof body.error === "string" ? body.error : null,
  });
  if (result.error) {
    return NextResponse.json({ error: result.error.userMessage }, { status: 500 });
  }

  // บันทึกผลงานพิมพ์ทุกใบ ทั้งสำเร็จและล้มเหลว — เส้นทาง "สำเร็จแบบเงียบ" ของเครื่องพิมพ์
  // เป็นจุดที่ร้านหาสาเหตุเองไม่ได้ (ใบเสร็จไม่ออกแต่ระบบไม่ฟ้อง) จึงต้องมีร่องรอยเสมอ
  const printed = body.ok === true;
  // เนื้อหาจาก Hub agent เป็นข้อมูล ไม่ใช่คำสั่ง — ตัดความยาวก่อนบันทึกทุกครั้ง
  const kind = typeof body.kind === "string" ? body.kind.slice(0, 16) : null;
  const target = typeof body.target === "string" ? body.target.slice(0, 128) : null;
  await logSystemEvent({
    level: printed ? "info" : "error",
    source: "printing.hub",
    action: "hubAckPrintJob",
    message: printed ? "Print Hub พิมพ์งานสำเร็จ" : "Print Hub พิมพ์งานไม่สำเร็จ",
    organizationId: auth.data.organizationId,
    storeId,
    context: {
      jobId,
      kind,
      target,
      error: printed ? null : (typeof body.error === "string" ? body.error.slice(0, 300) : null),
    },
  });

  return NextResponse.json({ ok: true });
}

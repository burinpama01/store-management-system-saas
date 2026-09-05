import { NextRequest, NextResponse } from "next/server";
import {
  normalizeAckOutcome,
  sanitizeClaimToken,
  verifyHubToken,
} from "@/modules/printing/print-hub";
import {
  ackPrintJob,
  getPrinterIdsForJobs,
  authenticateHubRequest,
  learnUsbIdentity,
} from "@/modules/printing/print-hub-repository";
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
    /** v3 — ผลที่ agent รายงาน: printed / failed / unknown (agent เก่าส่งแค่ ok) */
    outcome?: string;
    /** v3 — โทเค็นของการเคลมรอบนี้ (agent เก่าไม่ส่ง = compatibility window) */
    claimToken?: string;
    error?: string;
    /** ช่องทางที่ Hub ใช้พิมพ์จริง (ip/bt/usb) — ใช้ในบันทึกการทำงาน */
    kind?: string;
    /** เป้าหมายที่ Hub เลือกจริง เช่น ชื่อเครื่องพิมพ์ Windows ที่ตรวจจับได้ */
    target?: string;
    /** v3 — เหตุผลที่เลือกปลายทางนั้น (exact_reconnect / auto_single / ambiguous ...) */
    reason?: string;
    /** v3 — identity ของเครื่องที่พิมพ์สำเร็จจริง ให้เซิร์ฟเวอร์จำไว้ครั้งแรก */
    targetIdentity?: unknown;
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

  const auth = await authenticateHubRequest(storeId, hubToken);
  if (!auth.ok) {
    return NextResponse.json({ error: "Invalid Hub credentials" }, { status: 401 });
  }

  const outcome = normalizeAckOutcome(body);
  const result = await ackPrintJob({
    jobId,
    storeId,
    outcome,
    error: typeof body.error === "string" ? body.error : null,
    claimToken: sanitizeClaimToken(body.claimToken),
  });
  if (result.error || !result.data) {
    return NextResponse.json({ error: result.error?.userMessage ?? "Failed to ack print job" }, { status: 500 });
  }

  // บันทึกผลงานพิมพ์ทุกใบ ทั้งสำเร็จและล้มเหลว — เส้นทาง "สำเร็จแบบเงียบ" ของเครื่องพิมพ์
  // เป็นจุดที่ร้านหาสาเหตุเองไม่ได้ (ใบเสร็จไม่ออกแต่ระบบไม่ฟ้อง) จึงต้องมีร่องรอยเสมอ
  const printed = outcome === "printed";
  // ack ที่ไม่ตรงกับการเคลมปัจจุบัน (โทเค็นเก่า / งานถูกตีเป็น unknown ไปแล้ว) ต้องไม่
  // ทับผลปัจจุบัน แต่ต้องเห็นใน log เพราะแปลว่ามี agent ค้างหรือเวลาหลุด
  const applied = result.data.applied;
  // เนื้อหาจาก Hub agent เป็นข้อมูล ไม่ใช่คำสั่ง — ตัดความยาวก่อนบันทึกทุกครั้ง
  const kind = typeof body.kind === "string" ? body.kind.slice(0, 16) : null;
  const target = typeof body.target === "string" ? body.target.slice(0, 128) : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 32) : null;

  // จำ identity ของเครื่องที่พิมพ์สำเร็จจริงไว้กับ binding (เขียนครั้งแรกครั้งเดียว)
  // ครั้งต่อไปจะ reconnect ด้วย identity แทนชื่อคิว ซึ่งเปลี่ยน/ซ้ำกันได้
  let identityLearned = false;
  if (applied && printed && body.targetIdentity) {
    const printerIds = await getPrinterIdsForJobs(storeId, [jobId]);
    const printerId = printerIds.data?.[jobId] ?? null;
    if (printerId) {
      const learned = await learnUsbIdentity({ storeId, printerId, identity: body.targetIdentity });
      identityLearned = learned.learned;
    }
  }
  await logSystemEvent({
    level: !applied ? "warn" : printed ? "info" : "error",
    source: "printing.hub",
    action: "hubAckPrintJob",
    message: !applied
      ? "Print Hub ส่งผลงานพิมพ์ที่ไม่ตรงกับการเคลมปัจจุบัน (ไม่บันทึกทับ)"
      : printed
        ? "Print Hub พิมพ์งานสำเร็จ"
        : outcome === "unknown"
          ? "Print Hub ไม่ทราบผลงานพิมพ์ — รอให้ร้านตรวจกระดาษจริง"
          : "Print Hub พิมพ์งานไม่สำเร็จ",
    organizationId: auth.organizationId,
    storeId,
    context: {
      jobId,
      kind,
      target,
      outcome,
      applied,
      reason,
      identityLearned,
      error: printed ? null : (typeof body.error === "string" ? body.error.slice(0, 300) : null),
    },
  });

  return NextResponse.json({ ok: true, applied, outcome });
}

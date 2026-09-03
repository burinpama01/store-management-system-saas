import { NextRequest, NextResponse } from "next/server";
import { verifyHubToken } from "@/modules/printing/print-hub";
import {
  claimPendingPrintJobs,
  getStoreHubAuth,
  saveHubDevices,
  touchHubHeartbeat,
} from "@/modules/printing/print-hub-repository";

/**
 * Called by the StoreOS Print Hub agent running on the store's cashier PC.
 * Authenticated by the per-store Hub token (no user session). Records a
 * heartbeat and returns claimed pending jobs for the Hub to print over LAN.
 */
export async function POST(req: NextRequest) {
  let body: { storeId?: string; hubToken?: string; limit?: number; devices?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  const hubToken = typeof body.hubToken === "string" ? body.hubToken : "";
  if (!storeId || !hubToken) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }

  const auth = await getStoreHubAuth(storeId);
  if (auth.error || !auth.data || !verifyHubToken(hubToken, auth.data.tokenHash)) {
    return NextResponse.json({ error: "Invalid Hub credentials" }, { status: 401 });
  }

  await touchHubHeartbeat(storeId);

  // Agent รายงานเครื่องพิมพ์ที่สแกนเจอบนพีซีแคชเชียร์มาพร้อมทุก poll — เก็บไว้ให้หน้า
  // Settings แสดงรายการ USB ที่เสียบอยู่ ผู้ใช้กดเลือกได้เลยโดยไม่ต้องพิมพ์ชื่อเครื่องเอง
  // (เนื้อหาเป็นข้อมูล ไม่ใช่คำสั่ง — saveHubDevices ตรวจรูปทรง/ตัดจำนวนก่อนบันทึก)
  if (body.devices !== undefined) {
    await saveHubDevices(storeId, body.devices);
  }

  const limit = Number.isInteger(body.limit) && body.limit! > 0 ? Math.min(body.limit!, 20) : 5;
  const claimed = await claimPendingPrintJobs(storeId, limit);
  if (claimed.error || !claimed.data) {
    return NextResponse.json({ error: claimed.error?.userMessage ?? "Failed to claim jobs" }, { status: 500 });
  }

  const jobs = claimed.data.map((job) => ({
    id: job.id,
    kind: job.targetKind,
    host: job.targetHost,
    port: job.targetPort,
    device: job.targetDevice,
    printJobBase64: job.payloadB64,
  }));
  return NextResponse.json({ ok: true, jobs });
}

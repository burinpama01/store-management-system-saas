import { NextRequest, NextResponse } from "next/server";
import {
  checkAgentProtocol,
  PRINT_HUB_MIN_PROTOCOL_VERSION,
  PRINT_HUB_PROTOCOL_VERSION,
  PRINT_JOB_LEASE_SECONDS,
  sanitizeAgentVersion,
  verifyHubToken,
} from "@/modules/printing/print-hub";
import {
  claimPendingPrintJobs,
  getPrinterIdsForJobs,
  getStoreHubAuth,
  getUsbBindings,
  reconcileStalePrintJobs,
  saveHubDevices,
  touchHubHeartbeat,
  type HubUsbBinding,
} from "@/modules/printing/print-hub-repository";
import { logSystemEvent } from "@/modules/system/event-log";

/**
 * Called by the StoreOS Print Hub agent running on the store's cashier PC.
 * Authenticated by the per-store Hub token (no user session). Records a
 * heartbeat and returns claimed pending jobs for the Hub to print over LAN.
 */
export async function POST(req: NextRequest) {
  let body: {
    storeId?: string;
    hubToken?: string;
    limit?: number;
    devices?: unknown;
    /** v3 — เวอร์ชัน agent ที่ poll (agent เก่าไม่ส่ง) */
    agentVersion?: unknown;
    /** v3 — protocol ที่ agent พูดได้ (agent เก่าไม่ส่ง = legacy) */
    protocolVersion?: unknown;
  };
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

  // ปฏิเสธ agent ที่เก่ากว่าขั้นต่ำอย่างชัดเจน (426) พร้อมวิธีแก้ — ดีกว่าปล่อยให้มัน
  // เคลมงานแล้ว ack กลับด้วย error ที่ผู้ใช้ตีความไม่ออก
  const protocol = checkAgentProtocol(body.protocolVersion);
  if (!protocol.supported) {
    await logSystemEvent({
      level: "warn",
      source: "printing.hub",
      action: "hubProtocolRejected",
      message: "ปฏิเสธ Print Hub เวอร์ชันเก่า",
      organizationId: auth.data.organizationId,
      storeId,
      context: { agentProtocol: protocol.version, minimum: PRINT_HUB_MIN_PROTOCOL_VERSION },
    });
    return NextResponse.json({ error: protocol.message, minProtocolVersion: PRINT_HUB_MIN_PROTOCOL_VERSION }, { status: 426 });
  }

  await touchHubHeartbeat(storeId);

  // Agent รายงานเครื่องพิมพ์ที่สแกนเจอบนพีซีแคชเชียร์มาพร้อมทุก poll — เก็บไว้ให้หน้า
  // Settings แสดงรายการ USB ที่เสียบอยู่ ผู้ใช้กดเลือกได้เลยโดยไม่ต้องพิมพ์ชื่อเครื่องเอง
  // (เนื้อหาเป็นข้อมูล ไม่ใช่คำสั่ง — saveHubDevices ตรวจรูปทรง/ตัดจำนวนก่อนบันทึก)
  if (body.devices !== undefined) {
    await saveHubDevices(storeId, body.devices);
  }

  // ปิดงานที่ agent รอบก่อนเคลมไปแล้วไม่ ack ให้เป็น unknown ก่อนแจกงานรอบใหม่ —
  // ทำตรงนี้เพราะโควตา cron เต็มแล้ว จึงไม่มี scheduled job ให้ใช้ (แผน v3 §3)
  const reconciled = await reconcileStalePrintJobs(storeId);
  if (reconciled.data && reconciled.data.reconciled > 0) {
    await logSystemEvent({
      level: "warn",
      source: "printing.hub",
      action: "hubReconcileStaleJobs",
      message: "พบงานพิมพ์ที่ Hub เคลมไปแล้วไม่รายงานผล — ตั้งเป็นรอตรวจสอบ",
      organizationId: auth.data.organizationId,
      storeId,
      context: { reconciled: reconciled.data.reconciled },
    });
  }

  const agentVersion = sanitizeAgentVersion(body.agentVersion);
  const limit = Number.isInteger(body.limit) && body.limit! > 0 ? Math.min(body.limit!, 20) : 5;
  const claimed = await claimPendingPrintJobs(storeId, limit, {
    leaseSeconds: PRINT_JOB_LEASE_SECONDS,
    agentVersion,
  });
  if (claimed.error || !claimed.data) {
    return NextResponse.json({ error: claimed.error?.userMessage ?? "Failed to claim jobs" }, { status: 500 });
  }

  // งาน USB เลือกปลายทางจาก binding ล่าสุดของเครื่องพิมพ์ (server-first) ไม่ใช่ไฟล์บนเครื่องร้าน
  // แนบไปกับงานเลย เพื่อให้ agent ตัดสินได้โดยไม่ต้องถามเซิร์ฟเวอร์เพิ่ม
  const usbJobIds = claimed.data.filter((job) => job.targetKind === "usb").map((job) => job.id);
  const bindingByJob = new Map<string, HubUsbBinding>();
  if (usbJobIds.length > 0) {
    const printerIds = await getPrinterIdsForJobs(storeId, usbJobIds);
    const idMap = printerIds.data ?? {};
    const bindings = await getUsbBindings(storeId, Object.values(idMap).filter((id): id is string => !!id));
    const byPrinter = new Map((bindings.data ?? []).map((binding) => [binding.printerId, binding]));
    for (const jobId of usbJobIds) {
      const printerId = idMap[jobId];
      const binding = printerId ? byPrinter.get(printerId) : undefined;
      if (binding) bindingByJob.set(jobId, binding);
    }
  }

  const jobs = claimed.data.map((job) => ({
    id: job.id,
    kind: job.targetKind,
    host: job.targetHost,
    port: job.targetPort,
    device: job.targetDevice,
    printJobBase64: job.payloadB64,
    // agent ต้องส่งโทเค็นนี้กลับตอน ack — ack ที่ไม่มี/ไม่ตรงจะไม่ถูกบันทึกทับ
    claimToken: job.claimToken,
    attempt: job.attempts,
    ...(job.targetKind === "usb"
      ? {
          usb: {
            printerId: bindingByJob.get(job.id)?.printerId ?? null,
            name: bindingByJob.get(job.id)?.name ?? job.targetDevice ?? null,
            identity: bindingByJob.get(job.id)?.identity ?? null,
            policy: bindingByJob.get(job.id)?.policy ?? "auto_single",
          },
        }
      : {}),
  }));
  return NextResponse.json({
    ok: true,
    jobs,
    protocolVersion: PRINT_HUB_PROTOCOL_VERSION,
    minProtocolVersion: PRINT_HUB_MIN_PROTOCOL_VERSION,
    leaseSeconds: PRINT_JOB_LEASE_SECONDS,
  });
}

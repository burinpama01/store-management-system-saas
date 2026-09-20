import { NextRequest, NextResponse } from "next/server";
import {
  checkAgentProtocol,
  PRINT_HUB_MIN_PROTOCOL_VERSION,
  PRINT_HUB_PROTOCOL_VERSION,
  PRINT_JOB_LEASE_SECONDS,
  sanitizeAgentVersion,
} from "@/modules/printing/print-hub";
import {
  claimPendingPrintJobs,
  expireOldPrintJobs,
  getPrinterIdsForJobs,
  authenticateHubRequest,
  getStoreActivitySignals,
  getUsbBindings,
  reconcileStalePrintJobs,
  saveHubDevices,
  touchHubHeartbeat,
  type HubUsbBinding,
} from "@/modules/printing/print-hub-repository";
import {
  RECENT_ORDER_WINDOW_MS,
  STAFF_SHIFT_MAX_MS,
  resolveHubPollPacing,
} from "@/modules/printing/hub-poll-pacing";
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

  const auth = await authenticateHubRequest(storeId, hubToken);
  if (!auth.ok) {
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
      organizationId: auth.organizationId,
      storeId,
      context: { agentProtocol: protocol.version, minimum: PRINT_HUB_MIN_PROTOCOL_VERSION },
    });
    return NextResponse.json({ error: protocol.message, minProtocolVersion: PRINT_HUB_MIN_PROTOCOL_VERSION }, { status: 426 });
  }

  await touchHubHeartbeat(storeId);

  // Device inventory is independent of claim — run it alongside reconcile/expire so
  // the Hub's queue→print path is not blocked on an extra round-trip to stores.
  // (เนื้อหาเป็นข้อมูล ไม่ใช่คำสั่ง — saveHubDevices ตรวจรูปทรง/ตัดจำนวนก่อนบันทึก)
  const saveDevicesPromise =
    body.devices !== undefined ? saveHubDevices(storeId, body.devices) : Promise.resolve({ error: null });

  // ปิดงานค้าง (stale lease / ข้ามวัน) ก่อนเคลม — ทำคู่ขนานกันได้เพราะคนละชุดสถานะ
  // ทำตรงนี้เพราะโควตา cron เต็มแล้ว จึงไม่มี scheduled job ให้ใช้ (แผน v3 §3)
  const [reconciled, expired] = await Promise.all([
    reconcileStalePrintJobs(storeId),
    expireOldPrintJobs(storeId),
  ]);
  if (reconciled.data && reconciled.data.reconciled > 0) {
    await logSystemEvent({
      level: "warn",
      source: "printing.hub",
      action: "hubReconcileStaleJobs",
      message: "พบงานพิมพ์ที่ Hub เคลมไปแล้วไม่รายงานผล — ตั้งเป็นรอตรวจสอบ",
      organizationId: auth.organizationId,
      storeId,
      context: { reconciled: reconciled.data.reconciled },
    });
  }
  if (expired.data && expired.data.expired > 0) {
    await logSystemEvent({
      level: "warn",
      source: "printing.hub",
      action: "hubExpireOldJobs",
      message: "ปิดงานพิมพ์ที่ค้างในคิวเกินเพดานเวลา — ไม่พิมพ์ย้อนหลัง",
      organizationId: auth.organizationId,
      storeId,
      context: { expired: expired.data.expired },
    });
  }

  const agentVersion = sanitizeAgentVersion(body.agentVersion);
  const limit = Number.isInteger(body.limit) && body.limit! > 0 ? Math.min(body.limit!, 20) : 5;
  // Claim does not wait on device inventory write — that finishes before we respond.
  const claimed = await claimPendingPrintJobs(storeId, limit, {
    leaseSeconds: PRINT_JOB_LEASE_SECONDS,
    agentVersion,
  });
  if (claimed.error || !claimed.data) {
    await saveDevicesPromise.catch(() => null);
    return NextResponse.json({ error: claimed.error?.userMessage ?? "Failed to claim jobs" }, { status: 500 });
  }

  // งาน USB เลือกปลายทางจาก binding ล่าสุดของเครื่องพิมพ์ (server-first) ไม่ใช่ไฟล์บนเครื่องร้าน
  // แนบไปกับงานเลย เพื่อให้ agent ตัดสินได้โดยไม่ต้องถามเซิร์ฟเวอร์เพิ่ม
  const usbJobIds = claimed.data.filter((job) => job.targetKind === "usb").map((job) => job.id);
  const bindingByJob = new Map<string, HubUsbBinding>();
  const loadUsbBindings = async () => {
    if (usbJobIds.length === 0) return;
    const printerIds = await getPrinterIdsForJobs(storeId, usbJobIds);
    const idMap = printerIds.data ?? {};
    const bindings = await getUsbBindings(storeId, Object.values(idMap).filter((id): id is string => !!id));
    const byPrinter = new Map((bindings.data ?? []).map((binding) => [binding.printerId, binding]));
    for (const jobId of usbJobIds) {
      const printerId = idMap[jobId];
      const binding = printerId ? byPrinter.get(printerId) : undefined;
      if (binding) bindingByJob.set(jobId, binding);
    }
  };
  await Promise.all([loadUsbBindings(), saveDevicesPromise]);

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
  // จังหวะ poll รอบถัดไป — server สั่งจากสัญญาณว่าร้านเปิดจริงไหม เพื่อไม่ให้
  // Hub ยิงทุก 1.5 วินาทีข้ามคืนจนกินโควตา Vercel หมด (ดู hub-poll-pacing.ts)
  // agent เก่าที่ไม่รู้จัก field นี้จะเมินไปเอง = พฤติกรรมเดิมทุกอย่าง
  const activity =
    jobs.length > 0
      ? null
      : await getStoreActivitySignals(storeId, {
          recentOrderWindowMs: RECENT_ORDER_WINDOW_MS,
          staffShiftMaxMs: STAFF_SHIFT_MAX_MS,
        }).catch(() => null);
  const pacing = resolveHubPollPacing({
    claimedJobs: jobs.length,
    staffOnDuty: activity?.staffOnDuty ?? false,
    cashSessionOpen: activity?.cashSessionOpen ?? false,
    recentOrder: activity?.recentOrder ?? false,
    // jobs > 0 ไม่ต้องถามสัญญาณ (ถี่อยู่แล้ว); ถ้าถามแล้วล้ม ต้องถือว่าร้านเปิด
    signalsUnavailable: jobs.length === 0 && (activity === null || activity.signalsUnavailable),
  });

  return NextResponse.json({
    ok: true,
    jobs,
    protocolVersion: PRINT_HUB_PROTOCOL_VERSION,
    minProtocolVersion: PRINT_HUB_MIN_PROTOCOL_VERSION,
    leaseSeconds: PRINT_JOB_LEASE_SECONDS,
    nextPollMs: pacing.nextPollMs,
    pollReason: pacing.reason,
  });
}

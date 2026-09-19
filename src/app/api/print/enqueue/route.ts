import { NextRequest, NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  summarizeHubStatus,
  validateHubBluetoothPort,
  validateHubUsbPrinterName,
  validatePrintPayloadBase64,
  validatePrintTarget,
} from "@/modules/printing/print-hub";
import {
  enqueuePrintJob,
  getHubStatus,
  resolveStationTicketSource,
  type EnqueuedPrintJob,
} from "@/modules/printing/print-hub-repository";
import { parseStationTicketSourceKey } from "@/modules/printing/station-routing";
import { logSystemEvent } from "@/modules/system/event-log";
import { getPrinter } from "@/modules/stores/repository";

/** True when the store's Print Hub has polled recently (else jobs wait in queue). */
async function isHubOnline(storeId: string): Promise<boolean> {
  const status = await getHubStatus(storeId);
  return summarizeHubStatus(status.data?.lastSeen ?? null).online;
}

/** log ตั๋วสถานีทุกใบ (รวมเส้นทางสำเร็จ/ถูก dedupe/requeue) — ไม่ log ใบเสร็จทั่วไปเพื่อไม่ให้ท่วม */
function logStationTicket(
  ctx: { organizationId: string; storeId: string; userId: string },
  sourceKey: string | null,
  job: EnqueuedPrintJob,
) {
  if (!sourceKey) return;
  const action = job.requeued ? "requeued_failed" : job.deduped ? "deduped" : "enqueued";
  const message = job.requeued
    ? "ตั๋วสถานีเดิมพิมพ์ไม่ออก — ส่งแถวเดิมกลับเข้าคิว"
    : job.deduped
      ? `ตั๋วสถานีมีงานอยู่แล้ว (สถานะ ${job.status}) — ไม่สร้างซ้ำ`
      : "ส่งตั๋วสถานีเข้าคิว Hub";
  void logSystemEvent({
    level: job.deduped && job.status === "unknown" ? "warn" : "info",
    source: "printing.station-ticket",
    action,
    message,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: { sourceKey, jobId: job.id, status: job.status },
  });
}

function logStationTicketRejected(
  ctx: { organizationId: string; storeId: string; userId: string },
  action: string,
  message: string,
  context: Record<string, unknown>,
) {
  void logSystemEvent({
    level: action === "skip_table_bill" ? "info" : "warn",
    source: "printing.station-ticket",
    action,
    message,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context,
  });
}

/** คำตอบของงานที่ enqueue/ใช้งานเดิม — client ต้องรู้สถานะจริง (ไม่นับ unknown/failed เป็นสำเร็จ) */
async function enqueuedResponse(
  ctx: { organizationId: string; storeId: string; userId: string },
  sourceKey: string | null,
  job: EnqueuedPrintJob,
) {
  logStationTicket(ctx, sourceKey, job);
  return NextResponse.json({
    ok: true,
    jobId: job.id,
    jobStatus: job.status,
    deduped: Boolean(job.deduped),
    requeued: Boolean(job.requeued),
    hubOnline: await isHubOnline(ctx.storeId),
  });
}

/**
 * Enqueues a print job for the store's Print Hub. Used by tablet/iPad POS that
 * cannot reach the LAN printer directly (HTTPS page → HTTP printer is blocked);
 * the Hub on the cashier PC long-polls and prints the claimed job.
 */
export async function POST(req: NextRequest) {
  let authz: Awaited<ReturnType<typeof getOptionalResolvedCurrentPermissions>>;
  try {
    authz = await getOptionalResolvedCurrentPermissions();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  if (!authz) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ctx, resolved } = authz;
  if (!resolved.can("pos.use") && !resolved.can("settings.manage_printer")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { printerId?: string; printJobBase64?: string; sourceKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { printJobBase64 } = body;
  let printerId = body.printerId;

  // ตั๋วสถานี: คีย์ (ออเดอร์, สถานี) → enqueue ซ้ำจากจออื่นได้ job เดิม (print_jobs_source_key_uq)
  // เครื่องพิมพ์ resolve ฝั่ง server จาก kitchen_stations.printer_id — ไม่เชื่อ printerId ของ client
  let sourceKey: string | null = null;
  if (body.sourceKey !== undefined && body.sourceKey !== null) {
    const parsed = parseStationTicketSourceKey(body.sourceKey);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid source key" }, { status: 400 });
    }
    const logContext = { orderId: parsed.orderId, stationId: parsed.stationId, clientPrinterId: printerId ?? null };
    const source = await resolveStationTicketSource(ctx.storeId, parsed.orderId, parsed.stationId);
    if (source.error || !source.data) {
      // อ่านสถานะไม่ได้ → fail closed (ไม่ enqueue แบบไม่มีคีย์ ซึ่งจะกลายเป็นตั๋วซ้ำ)
      logStationTicketRejected(ctx, "resolve_failed", "ตรวจตั๋วสถานีไม่สำเร็จ", logContext);
      return NextResponse.json({ error: "ตรวจตั๋วครัวไม่สำเร็จ ลองใหม่อีกครั้ง" }, { status: 503 });
    }
    const resolvedSource = source.data;
    if (resolvedSource.status === "table_bill") {
      logStationTicketRejected(ctx, "skip_table_bill", "ข้ามตั๋วสถานีของบิลรวมโต๊ะ", logContext);
      return NextResponse.json({ ok: true, jobId: null, deduped: true, skipped: "table_bill" });
    }
    if (resolvedSource.status !== "ok") {
      const reasons = {
        not_found: { status: 404, error: "ไม่พบออเดอร์หรือสถานีครัวของร้านนี้" },
        no_items: { status: 409, error: "ออเดอร์นี้ไม่มีรายการของสถานีนี้" },
        no_printer: { status: 409, error: "สถานีนี้ยังไม่ได้ผูกเครื่องพิมพ์" },
      } as const;
      const reason = reasons[resolvedSource.status];
      logStationTicketRejected(ctx, `reject_${resolvedSource.status}`, reason.error, logContext);
      return NextResponse.json({ error: reason.error }, { status: reason.status });
    }
    if (printerId && printerId !== resolvedSource.printerId) {
      // จอที่ค้าง config เก่า — ส่งไปเครื่องที่สถานีผูกอยู่ตอนนี้แทน
      logStationTicketRejected(ctx, "printer_mismatch", "printerId ของ client ไม่ตรงกับเครื่องของสถานี — ใช้เครื่องของสถานี", {
        ...logContext,
        stationPrinterId: resolvedSource.printerId,
      });
    }
    printerId = resolvedSource.printerId;
    sourceKey = `station_ticket:${parsed.orderId}:${parsed.stationId}`;
  }
  if (!printerId) {
    return NextResponse.json({ error: "Missing printer ID" }, { status: 400 });
  }
  const dedupeFields = sourceKey
    ? { sourceKey, jobKind: "station_ticket" as const, requeueFailed: true, actorUserId: ctx.userId }
    : {};

  const payloadCheck = validatePrintPayloadBase64(printJobBase64);
  if (payloadCheck.error || !payloadCheck.payload) {
    return NextResponse.json({ error: payloadCheck.error ?? "Invalid print job" }, { status: 400 });
  }

  const printerRes = await getPrinter(printerId, ctx.storeId, ctx.organizationId);
  if (printerRes.error) {
    return NextResponse.json({ error: printerRes.error.userMessage }, { status: 500 });
  }
  const printer = printerRes.data;
  if (!printer) {
    return NextResponse.json({ error: "Printer not found" }, { status: 404 });
  }
  // A Bluetooth printer paired to the cashier PC prints through the Hub over a
  // COM port — the path that lets iPad/iOS POS (no Web Bluetooth) print to BT.
  if (printer.type === "bluetooth") {
    if (!printer.hubBluetoothPort) {
      return NextResponse.json(
        { error: "เครื่องพิมพ์ Bluetooth นี้ยังไม่ได้ตั้งค่าพอร์ต COM ของเครื่องแคชเชียร์" },
        { status: 400 },
      );
    }
    const btCheck = validateHubBluetoothPort(printer.hubBluetoothPort);
    if (btCheck.error || !btCheck.device) {
      return NextResponse.json({ error: btCheck.error ?? "Invalid Bluetooth COM port" }, { status: 400 });
    }
    const enqueuedBt = await enqueuePrintJob({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      printerId,
      kind: "bt",
      device: btCheck.device,
      payloadB64: payloadCheck.payload,
      ...dedupeFields,
    });
    if (enqueuedBt.error || !enqueuedBt.data) {
      return NextResponse.json({ error: enqueuedBt.error?.userMessage ?? "Failed to enqueue print job" }, { status: 500 });
    }
    return enqueuedResponse(ctx, sourceKey, enqueuedBt.data);
  }

  // เครื่องพิมพ์ USB ที่เสียบกับพีซีแคชเชียร์: พิมพ์ผ่าน Hub เข้า Windows spooler
  // (WebUSB ใช้ไม่ได้บน Windows เมื่อไดรเวอร์ usbprint.sys ยึดอุปกรณ์ไว้) — และเส้นทางนี้
  // ทำให้แท็บเล็ต/iPad ในร้านสั่งพิมพ์เข้าเครื่องพิมพ์ตัวเดียวกันได้ด้วย
  if (printer.type === "usb" && printer.hubUsbEnabled) {
    const usbCheck = validateHubUsbPrinterName(printer.hubUsbName ?? null);
    if (usbCheck.error) {
      return NextResponse.json({ error: usbCheck.error }, { status: 400 });
    }
    const enqueuedUsb = await enqueuePrintJob({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      printerId,
      kind: "usb",
      // null = ให้ Hub ตรวจจับเครื่องพิมพ์ USB ที่เสียบอยู่เอง
      device: usbCheck.device ?? null,
      payloadB64: payloadCheck.payload,
      ...dedupeFields,
    });
    if (enqueuedUsb.error || !enqueuedUsb.data) {
      return NextResponse.json({ error: enqueuedUsb.error?.userMessage ?? "Failed to enqueue print job" }, { status: 500 });
    }
    return enqueuedResponse(ctx, sourceKey, enqueuedUsb.data);
  }

  if (printer.type !== "ip" && printer.type !== "escpos") {
    return NextResponse.json({ error: "Printer type does not support network printing" }, { status: 400 });
  }
  if (!printer.ipAddress) {
    return NextResponse.json({ error: "Missing printer IP address" }, { status: 400 });
  }

  const targetCheck = validatePrintTarget({ host: printer.ipAddress, port: printer.port });
  if (targetCheck.error || !targetCheck.target) {
    return NextResponse.json({ error: targetCheck.error ?? "Invalid printer target" }, { status: 400 });
  }

  const enqueued = await enqueuePrintJob({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    printerId,
    kind: "ip",
    host: targetCheck.target.host,
    port: targetCheck.target.port,
    payloadB64: payloadCheck.payload,
    ...dedupeFields,
  });
  if (enqueued.error || !enqueued.data) {
    return NextResponse.json({ error: enqueued.error?.userMessage ?? "Failed to enqueue print job" }, { status: 500 });
  }

  return enqueuedResponse(ctx, sourceKey, enqueued.data);
}

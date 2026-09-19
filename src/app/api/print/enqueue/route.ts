import { NextRequest, NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  summarizeHubStatus,
  validateHubBluetoothPort,
  validateHubUsbPrinterName,
  validatePrintPayloadBase64,
  validatePrintTarget,
} from "@/modules/printing/print-hub";
import { checkStationTicketSource, enqueuePrintJob, getHubStatus } from "@/modules/printing/print-hub-repository";
import { parseStationTicketSourceKey } from "@/modules/printing/station-routing";
import { logSystemEvent } from "@/modules/system/event-log";
import { getPrinter } from "@/modules/stores/repository";

/** True when the store's Print Hub has polled recently (else jobs wait in queue). */
async function isHubOnline(storeId: string): Promise<boolean> {
  const status = await getHubStatus(storeId);
  return summarizeHubStatus(status.data?.lastSeen ?? null).online;
}

/** log ตั๋วสถานีทุกใบ (รวมเส้นทางสำเร็จ/ถูก dedupe) — ไม่ log ใบเสร็จทั่วไปเพื่อไม่ให้ท่วม */
function logStationTicket(
  ctx: { organizationId: string; storeId: string; userId: string },
  sourceKey: string | null,
  job: { id: string; deduped?: boolean },
) {
  if (!sourceKey) return;
  void logSystemEvent({
    level: "info",
    source: "printing.station-ticket",
    action: job.deduped ? "deduped" : "enqueued",
    message: job.deduped ? "ตั๋วสถานีถูกส่งจากจออื่นแล้ว (ใช้งานเดิม)" : "ส่งตั๋วสถานีเข้าคิว Hub",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: { sourceKey, jobId: job.id },
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

  const { printerId, printJobBase64 } = body;
  if (!printerId) {
    return NextResponse.json({ error: "Missing printer ID" }, { status: 400 });
  }

  // ตั๋วสถานี: คีย์ (ออเดอร์, สถานี) → enqueue ซ้ำจากจออื่นได้ job เดิม (print_jobs_source_key_uq)
  let sourceKey: string | null = null;
  if (body.sourceKey !== undefined && body.sourceKey !== null) {
    const parsed = parseStationTicketSourceKey(body.sourceKey);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid source key" }, { status: 400 });
    }
    const check = await checkStationTicketSource(ctx.storeId, parsed.orderId, parsed.stationId);
    if (check === "not_found") {
      return NextResponse.json({ error: "ไม่พบออเดอร์หรือสถานีครัวของร้านนี้" }, { status: 404 });
    }
    if (check === "table_bill") {
      void logSystemEvent({
        level: "info",
        source: "printing.station-ticket",
        action: "skip_table_bill",
        message: "ข้ามตั๋วสถานีของบิลรวมโต๊ะ",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        context: { orderId: parsed.orderId, stationId: parsed.stationId },
      });
      return NextResponse.json({ ok: true, jobId: null, deduped: true, skipped: "table_bill" });
    }
    sourceKey = `station_ticket:${parsed.orderId}:${parsed.stationId}`;
  }
  const dedupeFields = sourceKey ? { sourceKey, jobKind: "station_ticket" as const } : {};

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
    logStationTicket(ctx, sourceKey, enqueuedBt.data);
    return NextResponse.json({
      ok: true,
      jobId: enqueuedBt.data.id,
      deduped: Boolean(enqueuedBt.data.deduped),
      hubOnline: await isHubOnline(ctx.storeId),
    });
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
    logStationTicket(ctx, sourceKey, enqueuedUsb.data);
    return NextResponse.json({
      ok: true,
      jobId: enqueuedUsb.data.id,
      deduped: Boolean(enqueuedUsb.data.deduped),
      hubOnline: await isHubOnline(ctx.storeId),
    });
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

  logStationTicket(ctx, sourceKey, enqueued.data);
    return NextResponse.json({
      ok: true,
      jobId: enqueued.data.id,
      deduped: Boolean(enqueued.data.deduped),
      hubOnline: await isHubOnline(ctx.storeId),
    });
}

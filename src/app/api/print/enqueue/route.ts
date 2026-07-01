import { NextRequest, NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  summarizeHubStatus,
  validateHubBluetoothPort,
  validatePrintPayloadBase64,
  validatePrintTarget,
} from "@/modules/printing/print-hub";
import { enqueuePrintJob, getHubStatus } from "@/modules/printing/print-hub-repository";
import { getPrinter } from "@/modules/stores/repository";

/** True when the store's Print Hub has polled recently (else jobs wait in queue). */
async function isHubOnline(storeId: string): Promise<boolean> {
  const status = await getHubStatus(storeId);
  return summarizeHubStatus(status.data?.lastSeen ?? null).online;
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

  let body: { printerId?: string; printJobBase64?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { printerId, printJobBase64 } = body;
  if (!printerId) {
    return NextResponse.json({ error: "Missing printer ID" }, { status: 400 });
  }

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
    });
    if (enqueuedBt.error || !enqueuedBt.data) {
      return NextResponse.json({ error: enqueuedBt.error?.userMessage ?? "Failed to enqueue print job" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, jobId: enqueuedBt.data.id, hubOnline: await isHubOnline(ctx.storeId) });
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
  });
  if (enqueued.error || !enqueued.data) {
    return NextResponse.json({ error: enqueued.error?.userMessage ?? "Failed to enqueue print job" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, jobId: enqueued.data.id, hubOnline: await isHubOnline(ctx.storeId) });
}

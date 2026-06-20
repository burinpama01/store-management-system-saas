import { NextRequest, NextResponse } from "next/server";
import net from "net";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { buildEscPosReceipt } from "@/modules/printing/escpos";
import { isAllowedNetworkPrinterHost } from "@/modules/printing/network-printer";
import { getPrinter } from "@/modules/stores/repository";
import type { ReceiptData } from "@/modules/printing/types";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RECEIPT_BYTES = 256 * 1024; // Raster receipts can exceed text ESC/POS size.
const MAX_PRINT_JOB_BASE64_CHARS = Math.ceil((MAX_RECEIPT_BYTES * 4) / 3) + 4;

function sendToSocket(host: string, port: number, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection timed out (${DEFAULT_TIMEOUT_MS}ms)`));
    }, DEFAULT_TIMEOUT_MS);

    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        clearTimeout(timer);
        socket.end();
        if (err) reject(err);
        else resolve();
      });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function decodePrintJobBase64(printJobBase64: unknown): { bytes?: Uint8Array; error?: string } {
  if (printJobBase64 === undefined || printJobBase64 === null || printJobBase64 === "") {
    return {};
  }
  if (typeof printJobBase64 !== "string") {
    return { error: "Invalid print job" };
  }
  if (printJobBase64.length > MAX_PRINT_JOB_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(printJobBase64)) {
    return { error: "Invalid print job" };
  }
  const bytes = new Uint8Array(Buffer.from(printJobBase64, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    return { error: "Receipt too large" };
  }
  return { bytes };
}

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
  if (!resolved.can("pos.use")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { receiptData: ReceiptData; printerId: string; printJobBase64?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { receiptData, printerId, printJobBase64 } = body;
  if (!printerId) {
    return NextResponse.json({ error: "Missing printer ID" }, { status: 400 });
  }

  const printerRes = await getPrinter(printerId, ctx.storeId, ctx.organizationId);
  if (printerRes.error) {
    return NextResponse.json({ error: printerRes.error.userMessage }, { status: 500 });
  }

  const printer = printerRes.data;
  if (!printer) {
    return NextResponse.json({ error: "Printer not found" }, { status: 404 });
  }

  if (printer.type !== "ip" && printer.type !== "escpos") {
    return NextResponse.json({ error: "Printer type does not support network printing" }, { status: 400 });
  }

  if (!printer?.ipAddress) {
    return NextResponse.json({ error: "Missing printer IP address" }, { status: 400 });
  }

  const host = printer.ipAddress;
  const port = printer.port ?? 9100;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: "Invalid port number" }, { status: 400 });
  }

  if (!isAllowedNetworkPrinterHost(host)) {
    return NextResponse.json({ error: "Invalid or disallowed IP address" }, { status: 400 });
  }

  const decodedPrintJob = decodePrintJobBase64(printJobBase64);
  if (decodedPrintJob.error) {
    return NextResponse.json({ error: decodedPrintJob.error }, { status: 400 });
  }

  const bytes = decodedPrintJob.bytes ?? buildEscPosReceipt({
    ...receiptData,
    items: receiptData.items,
    payments: receiptData.payments,
  });

  if (bytes.length > MAX_RECEIPT_BYTES) {
    return NextResponse.json({ error: "Receipt too large" }, { status: 400 });
  }

  try {
    await sendToSocket(host, port, bytes);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Print failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

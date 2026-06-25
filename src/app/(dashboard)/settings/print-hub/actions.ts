"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { buildEscPosReceipt } from "@/modules/printing/escpos";
import { enqueuePrintJob, rotateHubToken } from "@/modules/printing/print-hub-repository";
import { validatePrintTarget } from "@/modules/printing/print-hub";
import { listPrinters } from "@/modules/stores/repository";
import type { ReceiptData } from "@/modules/printing/types";

async function requirePrinterAccess() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    throw new Error("ไม่มีสิทธิ์จัดการเครื่องพิมพ์");
  }
  return ctx;
}

/** Generates a fresh Hub token and returns it once for the operator to copy. */
export async function rotateHubTokenAction(): Promise<{ error: string | null; token?: string }> {
  try {
    const ctx = await requirePrinterAccess();
    const result = await rotateHubToken(ctx.storeId);
    if (result.error || !result.data) return { error: result.error?.userMessage ?? "สร้างโทเค็นไม่สำเร็จ" };
    revalidatePath("/settings/print-hub");
    return { error: null, token: result.data.token };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
  }
}

function buildHubTestReceipt(storeName: string, paperWidth: "58mm" | "80mm"): ReceiptData {
  return {
    storeName,
    showTaxId: false,
    orderNumber: "PRINT-HUB-TEST",
    items: [{ name: "ทดสอบ Print Hub", quantity: 1, unitPrice: 1, totalPrice: 1, modifierNames: [] }],
    subtotal: 1,
    discount: 0,
    total: 1,
    payments: [{ method: "test", amount: 1 }],
    paymentStatus: "paid",
    footerText: "ทดสอบส่งงานพิมพ์ผ่าน StoreOS Print Hub",
    showQrPayment: false,
    paperWidth,
    printedAt: new Date().toISOString(),
  };
}

/** Enqueues a test receipt for the store's default network printer via the Hub. */
export async function enqueueTestPrintAction(): Promise<{ error: string | null; queued?: boolean }> {
  try {
    const ctx = await requirePrinterAccess();
    const printersRes = await listPrinters(ctx.storeId, ctx.organizationId);
    if (printersRes.error) return { error: printersRes.error.userMessage };

    const networkPrinters = (printersRes.data ?? []).filter(
      (printer) => (printer.type === "ip" || printer.type === "escpos") && printer.ipAddress,
    );
    const printer = networkPrinters.find((p) => p.isDefault) ?? networkPrinters[0];
    if (!printer || !printer.ipAddress) {
      return { error: "ยังไม่มีเครื่องพิมพ์ IP/WiFi ที่บันทึกไว้ — เพิ่มในแท็บ 'เครื่องพิมพ์' ก่อน" };
    }

    const target = validatePrintTarget({ host: printer.ipAddress, port: printer.port });
    if (target.error || !target.target) return { error: target.error ?? "IP เครื่องพิมพ์ไม่ถูกต้อง" };

    const receipt = buildHubTestReceipt(ctx.storeName, printer.paperWidth ?? "80mm");
    const bytes = buildEscPosReceipt(receipt);
    const payloadB64 = Buffer.from(bytes).toString("base64");

    const enqueued = await enqueuePrintJob({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      printerId: printer.id,
      host: target.target.host,
      port: target.target.port,
      payloadB64,
    });
    if (enqueued.error) return { error: enqueued.error.userMessage };

    revalidatePath("/settings/print-hub");
    return { error: null, queued: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
  }
}

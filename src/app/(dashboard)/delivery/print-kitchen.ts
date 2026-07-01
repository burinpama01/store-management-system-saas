import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { buildStationTicketJobs } from "@/modules/printing/station-routing";
import { enqueueStationTickets } from "@/modules/printing/station-print-client";
import { autoPrintReceipt } from "@/modules/printing/receipt-printer";
import type { EscPosReceiptInput } from "@/modules/printing/escpos";
import type { ReceiptData } from "@/modules/printing/types";
import type { Printer } from "@/modules/stores/types";
import type { Json } from "@/server/integrations/supabase/database.types";

export interface StationPrinter {
  id: string;
  name: string;
  printerId: string;
}

export interface KitchenPrintOptions {
  storeName: string;
  stationPrinters: StationPrinter[];
  paperWidth: "58mm" | "80mm";
  billNumber: string;
  printers: Printer[];
}

function extractModifierNames(value: Json): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const option = (m as { option?: { name?: unknown } }).option;
      return typeof option?.name === "string" ? option.name : null;
    })
    .filter((n): n is string => Boolean(n));
}

/** พิมพ์ตั๋วครัวของออเดอร์เดลิเวอรี — แยกตามสถานี ถ้าตั้งครัวไว้; ไม่งั้นพิมพ์ตั๋วรวมทั้งบิล */
export async function printKitchenForOrder(
  internalOrderId: string,
  opts: KitchenPrintOptions,
): Promise<string> {
  const client = getSupabaseBrowserClient();
  const { data } = await client
    .from("order_items")
    .select("product_name, variant_name, kitchen_station_id, modifiers, quantity, unit_price, total_price, note")
    .eq("order_id", internalOrderId);
  const rows = data ?? [];
  if (rows.length === 0) return "ไม่พบรายการสินค้าสำหรับพิมพ์";

  const items = rows.map((r) => ({
    name: r.product_name,
    variantName: r.variant_name ?? undefined,
    modifierNames: extractModifierNames(r.modifiers),
    quantity: r.quantity,
    unitPrice: r.unit_price,
    totalPrice: r.total_price,
    note: r.note ?? undefined,
    kitchenStationId: r.kitchen_station_id ?? undefined,
  }));

  const hasStations = opts.stationPrinters.some((s) => s.printerId);
  const itemsHaveStation = items.some((i) => i.kitchenStationId);

  // มีครัว + สินค้าผูกสถานี → แยกตั๋วตามสถานี ส่งเข้า Print Hub
  if (hasStations && itemsHaveStation) {
    const { jobs } = buildStationTicketJobs({
      orderNumber: opts.billNumber,
      tableNumber: "เดลิเวอรี",
      paperWidth: opts.paperWidth,
      printedAt: new Date().toISOString(),
      items: items.map((i) => ({
        name: i.name,
        variantName: i.variantName,
        modifierNames: i.modifierNames,
        quantity: i.quantity,
        note: i.note,
        kitchenStationId: i.kitchenStationId,
      })),
      stations: opts.stationPrinters,
    });
    if (jobs.length > 0) {
      const res = await enqueueStationTickets(jobs);
      return res.failed.length === 0
        ? `พิมพ์ตั๋วครัว ${res.printed} สถานีแล้ว`
        : `พิมพ์ตั๋ว ${res.printed} สำเร็จ, ล้มเหลว ${res.failed.length}`;
    }
  }

  // ไม่มีครัว/ไม่ผูกสถานี → พิมพ์ตั๋วรวมทั้งบิล (Hub → BT/USB/PDF)
  const receipt: ReceiptData & EscPosReceiptInput = {
    storeName: opts.storeName,
    orderNumber: opts.billNumber,
    tableNumber: "เดลิเวอรี",
    items: items.map((i) => ({
      name: i.name,
      variantName: i.variantName,
      modifierNames: i.modifierNames,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      totalPrice: i.totalPrice,
      note: i.note,
    })),
    subtotal: items.reduce((s, i) => s + i.totalPrice, 0),
    discount: 0,
    total: items.reduce((s, i) => s + i.totalPrice, 0),
    payments: [],
    paymentStatus: "unpaid",
    showTaxId: false,
    showQrPayment: false,
    paperWidth: opts.paperWidth,
    printCopies: 1,
    printedAt: new Date().toISOString(),
  };
  const printed = await autoPrintReceipt({ printers: opts.printers, escpos: receipt, browser: receipt });
  if (!printed.printer) return "สั่งพิมพ์ตั๋วครัว (รวมทั้งบิล) แล้ว";
  return printed.hubOnline === false
    ? "ส่งเข้าคิวแล้ว แต่ Hub (เครื่องแคชเชียร์) ออฟไลน์ — จะพิมพ์เมื่อเปิดเครื่อง"
    : "ส่งตั๋วครัว (รวมทั้งบิล) เข้าคิว Hub แล้ว";
}

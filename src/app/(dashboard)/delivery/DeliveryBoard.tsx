"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { buildStationTicketJobs } from "@/modules/printing/station-routing";
import { enqueueStationTickets } from "@/modules/printing/station-print-client";
import { printReceiptAuto } from "@/modules/printing/print-router";
import type { EscPosReceiptInput } from "@/modules/printing/escpos";
import type { ReceiptData } from "@/modules/printing/types";
import type { Json } from "@/server/integrations/supabase/database.types";
import { updateDeliveryOrderStatusAction } from "./actions";

type FulfillmentStatus =
  | "received"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled";

interface ItemVM {
  name: string;
  qty: number;
  price: number;
  note: string | null;
  options: { name: string; price: number }[];
}

export interface DeliveryOrderVM {
  id: string;
  internalOrderId: string | null;
  billNumber: string;
  fulfillmentStatus: FulfillmentStatus;
  lastStatusOrigin: string | null;
  shopAmount: number;
  customerName: string | null;
  receivedAt: string;
  items: ItemVM[];
}

interface StationPrinter {
  id: string;
  name: string;
  printerId: string;
}

const STATUS_LABEL: Record<FulfillmentStatus, string> = {
  received: "รับเข้าใหม่",
  accepted: "รับออเดอร์แล้ว",
  preparing: "กำลังทำ",
  ready: "พร้อมรับ",
  completed: "เสร็จสิ้น (คนขับรับแล้ว)",
  cancelled: "ยกเลิก",
};

const STATUS_COLOR: Record<FulfillmentStatus, string> = {
  received: "bg-orange-100 text-orange-700",
  accepted: "bg-blue-100 text-blue-700",
  preparing: "bg-indigo-100 text-indigo-700",
  ready: "bg-green-100 text-green-700",
  completed: "bg-gray-200 text-gray-700",
  cancelled: "bg-red-100 text-red-700",
};

const NEXT_ACTIONS: Record<FulfillmentStatus, { next: FulfillmentStatus; label: string; danger?: boolean }[]> = {
  received: [
    { next: "accepted", label: "รับออเดอร์" },
    { next: "cancelled", label: "ยกเลิก", danger: true },
  ],
  accepted: [{ next: "preparing", label: "กำลังทำ" }],
  preparing: [{ next: "ready", label: "พร้อมรับ" }],
  ready: [],
  completed: [],
  cancelled: [],
};

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

/** พิมพ์ตั๋วครัวตอนรับออเดอร์ — แยกตามสถานี ถ้าตั้งครัวไว้; ไม่งั้นพิมพ์ตั๋วรวมทั้งบิล */
async function printKitchenForOrder(
  internalOrderId: string,
  opts: { storeName: string; stationPrinters: StationPrinter[]; paperWidth: "58mm" | "80mm"; billNumber: string },
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

  // ไม่มีครัว/ไม่ผูกสถานี → พิมพ์ตั๋วรวมทั้งบิล (BT→USB→PDF)
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
  await printReceiptAuto(receipt, receipt);
  return "สั่งพิมพ์ตั๋วครัว (รวมทั้งบิล) แล้ว";
}

function OrderCard({
  order,
  canManage,
  printOpts,
}: {
  order: DeliveryOrderVM;
  canManage: boolean;
  printOpts: { storeName: string; stationPrinters: StationPrinter[]; paperWidth: "58mm" | "80mm" };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const actions = NEXT_ACTIONS[order.fulfillmentStatus];

  function run(next: FulfillmentStatus) {
    setMsg(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("connectOrderId", order.id);
      fd.set("next", next);
      const res = await updateDeliveryOrderStatusAction({ error: null }, fd);
      if (res.error) {
        setMsg(res.error);
        return;
      }
      // auto-print ตั๋วครัวตอนรับออเดอร์
      if (next === "accepted" && order.internalOrderId) {
        try {
          const printMsg = await printKitchenForOrder(order.internalOrderId, {
            ...printOpts,
            billNumber: order.billNumber,
          });
          setMsg(printMsg);
        } catch (e) {
          setMsg(`รับออเดอร์แล้ว แต่พิมพ์ไม่สำเร็จ: ${e instanceof Error ? e.message : ""}`);
        }
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="text-base font-bold text-gray-900">{order.billNumber}</span>
          {order.customerName && (
            <span className="ml-2 text-sm text-gray-500">· {order.customerName}</span>
          )}
          <div className="mt-1">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[order.fulfillmentStatus]}`}>
              {STATUS_LABEL[order.fulfillmentStatus]}
            </span>
            {order.lastStatusOrigin && (
              <span className="ml-1 text-[10px] text-gray-400">({order.lastStatusOrigin})</span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">ยอดที่ร้านได้รับ</div>
          <div className="text-lg font-bold text-emerald-700">฿{order.shopAmount.toLocaleString()}</div>
        </div>
      </div>

      <ul className="space-y-1.5 border-t border-gray-100 pt-2">
        {order.items.map((it, idx) => (
          <li key={idx} className="text-sm">
            <div className="flex justify-between gap-3">
              <span className="font-medium text-gray-800">
                {it.qty}× {it.name}
              </span>
              <span className="text-gray-500">฿{(it.qty * it.price).toLocaleString()}</span>
            </div>
            {it.options.length > 0 && (
              <div className="ml-4 text-xs text-gray-500">
                {it.options.map((o) => o.name).join(", ")}
              </div>
            )}
            {it.note && <div className="ml-4 text-xs italic text-gray-500">หมายเหตุ: {it.note}</div>}
          </li>
        ))}
        {order.items.length === 0 && (
          <li className="text-xs text-gray-400">ไม่มีรายการ (ตรวจการผูกเมนู)</li>
        )}
      </ul>

      {canManage && actions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-2">
          {actions.map((a) => (
            <button
              key={a.next}
              type="button"
              disabled={pending}
              onClick={() => run(a.next)}
              className={`rounded px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 ${
                a.danger ? "bg-red-500 hover:bg-red-600" : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {pending ? "..." : a.label}
            </button>
          ))}
        </div>
      )}
      {msg && <p className="text-xs text-gray-600">{msg}</p>}
    </div>
  );
}

export function DeliveryBoard({
  orders,
  canManage,
  storeName,
  stationPrinters,
  paperWidth,
}: {
  orders: DeliveryOrderVM[];
  canManage: boolean;
  storeName: string;
  stationPrinters: StationPrinter[];
  paperWidth: "58mm" | "80mm";
}) {
  const active = orders.filter(
    (o) => o.fulfillmentStatus !== "completed" && o.fulfillmentStatus !== "cancelled",
  );
  const closed = orders.filter(
    (o) => o.fulfillmentStatus === "completed" || o.fulfillmentStatus === "cancelled",
  );
  const printOpts = { storeName, stationPrinters, paperWidth };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">ออเดอร์เดลิเวอรี (JDC)</h1>
        <p className="text-sm text-gray-500">
          กดรับออเดอร์ → พิมพ์ตั๋วครัวอัตโนมัติ → กำลังทำ → พร้อมรับ · ยอดที่แสดง = ยอดที่ร้านได้รับจากคนขับ
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">กำลังดำเนินการ ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-xs text-gray-400">ยังไม่มีออเดอร์ที่ต้องจัดการ</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {active.map((o) => (
              <OrderCard key={o.id} order={o} canManage={canManage} printOpts={printOpts} />
            ))}
          </div>
        )}
      </section>

      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500">ปิดแล้ว ({closed.length})</h2>
          <div className="grid gap-3 md:grid-cols-2 opacity-70">
            {closed.slice(0, 20).map((o) => (
              <OrderCard key={o.id} order={o} canManage={false} printOpts={printOpts} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

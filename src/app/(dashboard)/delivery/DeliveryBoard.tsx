"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import type { Printer } from "@/modules/stores/types";
import { updateDeliveryOrderStatusAction } from "./actions";
import { printKitchenForOrder, type StationPrinter } from "./print-kitchen";

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

function OrderCard({
  order,
  canManage,
  printOpts,
  autoPrintOnArrival,
}: {
  order: DeliveryOrderVM;
  canManage: boolean;
  printOpts: { storeName: string; stationPrinters: StationPrinter[]; paperWidth: "58mm" | "80mm"; printers: Printer[] };
  autoPrintOnArrival: boolean;
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
      // auto-print ตั๋วครัวตอนรับออเดอร์ (ข้ามถ้าตั้งพิมพ์อัตโนมัติตอนออเดอร์เข้าไว้แล้ว = กันซ้ำ)
      if (next === "accepted" && order.internalOrderId && !autoPrintOnArrival) {
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
  storeId,
  storeName,
  stationPrinters,
  paperWidth,
  printers,
  autoPrintOnArrival,
}: {
  orders: DeliveryOrderVM[];
  canManage: boolean;
  storeId: string;
  storeName: string;
  stationPrinters: StationPrinter[];
  paperWidth: "58mm" | "80mm";
  printers: Printer[];
  autoPrintOnArrival: boolean;
}) {
  const router = useRouter();
  // KDS แบบ live (แยกระบบจาก QR): ออเดอร์เดลิเวอรีใหม่/สถานะเปลี่ยน → รีเฟรชบอร์ดสด
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    return managedRealtimeSubscription<{ order_number: string | null }>({
      client,
      table: "orders",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        const num =
          (payload.new as { order_number?: string | null } | null)?.order_number ??
          (payload.old as { order_number?: string | null } | null)?.order_number ??
          null;
        if (num?.startsWith("JDC-")) router.refresh();
      },
    });
  }, [router, storeId]);

  const active = orders.filter(
    (o) => o.fulfillmentStatus !== "completed" && o.fulfillmentStatus !== "cancelled",
  );
  const closed = orders.filter(
    (o) => o.fulfillmentStatus === "completed" || o.fulfillmentStatus === "cancelled",
  );
  const printOpts = { storeName, stationPrinters, paperWidth, printers };

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
              <OrderCard
                key={o.id}
                order={o}
                canManage={canManage}
                printOpts={printOpts}
                autoPrintOnArrival={autoPrintOnArrival}
              />
            ))}
          </div>
        )}
      </section>

      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500">ปิดแล้ว ({closed.length})</h2>
          <div className="grid gap-3 md:grid-cols-2 opacity-70">
            {closed.slice(0, 20).map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                canManage={false}
                printOpts={printOpts}
                autoPrintOnArrival={autoPrintOnArrival}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

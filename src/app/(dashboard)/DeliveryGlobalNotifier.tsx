"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import type { Printer } from "@/modules/stores/types";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import { printKitchenForOrder, type StationPrinter } from "./delivery/print-kitchen";

type OrderInsertPayload = Pick<
  Database["public"]["Tables"]["orders"]["Row"],
  "id" | "order_number" | "total" | "created_at"
>;

interface IncomingItem {
  id: string;
  name: string;
  quantity: number;
  optionNames: string[];
  note?: string;
}

interface IncomingDeliveryOrder {
  id: string;
  billNumber: string;
  shopAmount: number;
  items: IncomingItem[];
}

function playOrderSound() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    // บี๊บสองครั้งให้ต่างจากเสียง QR
    [0, 0.28].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 660;
      gain.gain.value = 0.14;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
    window.setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio may be blocked before user interaction */
  }
}

function extractOptionNames(value: Json): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const option = (m as { option?: { name?: unknown } }).option;
      return typeof option?.name === "string" ? option.name : null;
    })
    .filter((n): n is string => Boolean(n));
}

export function DeliveryGlobalNotifier({
  storeId,
  canManage,
  storeName,
  stationPrinters,
  paperWidth,
  printers,
  autoPrintOnArrival,
}: {
  storeId: string;
  canManage: boolean;
  storeName: string;
  stationPrinters: StationPrinter[];
  paperWidth: "58mm" | "80mm";
  printers: Printer[];
  autoPrintOnArrival: boolean;
}) {
  const router = useRouter();
  const seen = useRef(new Set<string>());
  const [orders, setOrders] = useState<IncomingDeliveryOrder[]>([]);
  const current = orders[0] ?? null;

  const loadDetail = useCallback(async (row: OrderInsertPayload): Promise<IncomingDeliveryOrder> => {
    const client = getSupabaseBrowserClient();
    const { data } = await client
      .from("order_items")
      .select("id, product_name, modifiers, quantity, note")
      .eq("order_id", row.id);
    const items: IncomingItem[] = (data ?? []).map((r) => ({
      id: r.id,
      name: r.product_name,
      quantity: r.quantity,
      optionNames: extractOptionNames(r.modifiers),
      note: r.note ?? undefined,
    }));
    return { id: row.id, billNumber: row.order_number, shopAmount: row.total, items };
  }, []);

  useEffect(() => {
    if (!canManage) return;
    const client = getSupabaseBrowserClient();
    const unsubscribe = managedRealtimeSubscription<OrderInsertPayload>({
      client,
      table: "orders",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        if (payload.eventType !== "INSERT") return;
        const row = payload.new;
        // เฉพาะออเดอร์เดลิเวอรี JDC (เลขขึ้นต้น JDC-)
        if (!row?.order_number?.startsWith("JDC-")) return;
        if (seen.current.has(row.id)) return;
        seen.current.add(row.id);
        playOrderSound();
        void loadDetail(row).then((order) => setOrders((prev) => [...prev, order]));
        // auto-print ตั๋วครัวตอนออเดอร์เข้า (ครอบคลุม auto-accept) — เมื่อร้านเปิดพิมพ์อัตโนมัติ
        if (autoPrintOnArrival) {
          void printKitchenForOrder(row.id, {
            storeName,
            stationPrinters,
            paperWidth,
            printers,
            billNumber: row.order_number,
          }).catch(() => {});
        }
      },
    });
    return unsubscribe;
  }, [
    autoPrintOnArrival,
    canManage,
    loadDetail,
    paperWidth,
    printers,
    stationPrinters,
    storeId,
    storeName,
  ]);

  if (!canManage || !current) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-orange-200 bg-white p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-orange-700">🛵 ออเดอร์เดลิเวอรีใหม่ (JDC)</h2>
            <p className="mt-1 text-sm text-gray-600">#{current.billNumber}</p>
          </div>
          {orders.length > 1 && (
            <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700">
              +{orders.length - 1}
            </span>
          )}
        </div>

        {current.items.length > 0 && (
          <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto text-sm">
            {current.items.map((item) => (
              <li key={item.id} className="rounded-lg bg-gray-50 px-3 py-2">
                <span className="font-medium text-gray-800">
                  {item.quantity}× {item.name}
                </span>
                {item.optionNames.length > 0 && (
                  <div className="mt-0.5 text-xs text-gray-500">{item.optionNames.join(", ")}</div>
                )}
                {item.note && <p className="mt-0.5 text-xs italic text-gray-500">{item.note}</p>}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2">
          <span className="text-sm text-gray-600">ยอดที่ร้านได้รับ</span>
          <span className="text-lg font-bold text-emerald-700">฿{current.shopAmount.toLocaleString()}</span>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn-secondary min-h-11 px-4 text-sm"
            onClick={() => setOrders((prev) => prev.slice(1))}
          >
            ปิด
          </button>
          <button
            type="button"
            className="btn-primary min-h-11 px-4 text-sm"
            onClick={() => {
              setOrders([]);
              router.push("/delivery");
            }}
          >
            ไปรับออเดอร์
          </button>
        </div>
      </section>
    </div>
  );
}

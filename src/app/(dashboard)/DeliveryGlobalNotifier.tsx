"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Printer } from "@/modules/stores/types";
import { printKitchenForOrder, type StationPrinter } from "./delivery/print-kitchen";

interface IncomingItem {
  name: string;
  quantity: number;
  optionNames: string[];
  note?: string | null;
}

interface IncomingDeliveryOrder {
  id: string;
  internalOrderId: string | null;
  billNumber: string;
  shopAmount: number;
  items: IncomingItem[];
}

const POLL_MS = 12000;

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

/**
 * แจ้งเตือนออเดอร์เดลิเวอรีใหม่ (popup + เสียง) ทุกหน้า — ใช้ polling ผ่าน API (service client)
 * เลี่ยงข้อจำกัด RLS ของ orders (staff อ่าน delivery ผ่าน realtime ไม่ได้)
 */
export function DeliveryGlobalNotifier({
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
  const baselined = useRef(false);
  const [orders, setOrders] = useState<IncomingDeliveryOrder[]>([]);
  const current = orders[0] ?? null;

  const poll = useCallback(async () => {
    let list: IncomingDeliveryOrder[];
    try {
      const res = await fetch("/api/connect/pending", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { orders: IncomingDeliveryOrder[] };
      list = json.orders ?? [];
    } catch {
      return;
    }

    const fresh: IncomingDeliveryOrder[] = [];
    for (const o of list) {
      if (seen.current.has(o.id)) continue;
      seen.current.add(o.id);
      if (baselined.current) fresh.push(o);
    }
    // โหลดครั้งแรก = ตั้ง baseline (ไม่เด้งของที่มีอยู่ก่อน)
    if (!baselined.current) {
      baselined.current = true;
      return;
    }
    if (fresh.length === 0) return;

    playOrderSound();
    setOrders((prev) => [...prev, ...fresh]);
    router.refresh(); // อัปเดตบอร์ด /delivery ถ้ากำลังเปิดอยู่

    if (autoPrintOnArrival) {
      for (const o of fresh) {
        if (!o.internalOrderId) continue;
        void printKitchenForOrder(o.internalOrderId, {
          storeName,
          stationPrinters,
          paperWidth,
          printers,
          billNumber: o.billNumber,
        }).catch(() => {});
      }
    }
  }, [autoPrintOnArrival, paperWidth, printers, router, stationPrinters, storeName]);

  useEffect(() => {
    if (!canManage) return;
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(id);
  }, [canManage, poll]);

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
            {current.items.map((item, idx) => (
              <li key={idx} className="rounded-lg bg-gray-50 px-3 py-2">
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

"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/server/integrations/supabase/client";
import { managedRealtimeSubscription } from "@/shared/realtime/realtime-client";
import {
  PREP_STATUS_LABEL,
  SERVICE_REQUEST_LABEL,
  type QrOrderView,
  type PrepStatus,
  type ServiceRequest,
} from "@/modules/qr-ordering/types";
import { updatePrepStatusAction, resolveServiceRequestAction } from "./actions";

interface Props {
  storeId: string;
  currency: string;
  initialActiveOrders: QrOrderView[];
  initialHistory: QrOrderView[];
  initialRequests: ServiceRequest[];
}

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "เมื่อสักครู่";
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} ชม. ${mins % 60} นาทีที่แล้ว`;
}

const PREP_FLOW: Record<PrepStatus, { next: PrepStatus; label: string } | null> = {
  new: { next: "preparing", label: "เริ่มเตรียม" },
  preparing: { next: "served", label: "เสิร์ฟแล้ว" },
  served: { next: "done", label: "เสร็จสิ้น" },
  done: null,
};

const PREP_BADGE: Record<PrepStatus, string> = {
  new: "bg-orange-100 text-orange-700",
  preparing: "bg-blue-100 text-blue-700",
  served: "bg-green-100 text-green-700",
  done: "bg-gray-100 text-gray-500",
};

function beep() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => ctx.close();
  } catch {
    /* ignore */
  }
}

export function QrOrdersBoard({
  storeId,
  currency,
  initialActiveOrders,
  initialHistory,
  initialRequests,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [live, setLive] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime: refresh data (debounced) and chime when new work arrives.
  useEffect(() => {
    const client = getSupabaseBrowserClient();
    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 400);
    };

    const unsubOrders = managedRealtimeSubscription<{ qr_order_source: boolean }>({
      client,
      table: "orders",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        if (payload.eventType === "INSERT" && payload.new?.qr_order_source) beep();
        scheduleRefresh();
      },
      onError: () => setLive(false),
    });
    const unsubRequests = managedRealtimeSubscription({
      client,
      table: "service_requests",
      filter: `store_id=eq.${storeId}`,
      onEvent: (payload) => {
        if (payload.eventType === "INSERT") beep();
        scheduleRefresh();
      },
      onError: () => setLive(false),
    });

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unsubOrders();
      unsubRequests();
    };
  }, [storeId, router]);

  // Fallback poll every 20s in case realtime is unavailable.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 20000);
    return () => clearInterval(id);
  }, [router]);

  function advance(order: QrOrderView) {
    const flow = PREP_FLOW[order.prepStatus];
    if (!flow) return;
    setError(null);
    startTransition(async () => {
      const res = await updatePrepStatusAction(order.id, flow.next);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  function resolveRequest(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await resolveServiceRequestAction(id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="text-xl font-bold text-[var(--ink)]">QR Order</h1>
          <p className="text-sm text-[var(--muted)]">จัดการออร์เดอร์จากลูกค้าและคำขอบริการแบบเรียลไทม์</p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            live ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${live ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
          {live ? "เรียลไทม์" : "ออฟไลน์"}
        </span>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-600">{error}</p>}

      {/* Service requests */}
      {initialRequests.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-[var(--ink)]">คำขอบริการ ({initialRequests.length})</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {initialRequests.map((req) => (
              <div
                key={req.id}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                  req.type === "request_bill"
                    ? "border-purple-200 bg-purple-50"
                    : "border-amber-200 bg-amber-50"
                }`}
              >
                <div className="min-w-0">
                  <p className="font-bold text-gray-900">
                    โต๊ะ {req.tableNumber} · {req.note ? req.note : SERVICE_REQUEST_LABEL[req.type]}
                  </p>
                  <p className="text-xs text-gray-500">
                    {SERVICE_REQUEST_LABEL[req.type]} · {timeAgo(req.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => resolveRequest(req.id)}
                  disabled={isPending}
                  className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
                >
                  รับเรื่อง
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Active orders */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-[var(--ink)]">ออร์เดอร์ที่กำลังดำเนินการ ({initialActiveOrders.length})</h2>
        {initialActiveOrders.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
            ยังไม่มีออร์เดอร์ QR ที่ค้างอยู่
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {initialActiveOrders.map((order) => {
              const flow = PREP_FLOW[order.prepStatus];
              return (
                <article key={order.id} className="flex flex-col rounded-lg border border-gray-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-gray-900">โต๊ะ {order.tableNumber ?? "-"}</p>
                      <p className="text-xs text-gray-400">
                        #{order.orderNumber} · {timeAgo(order.createdAt)}
                      </p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${PREP_BADGE[order.prepStatus]}`}>
                      {PREP_STATUS_LABEL[order.prepStatus]}
                    </span>
                  </div>

                  <ul className="mt-3 space-y-1.5 text-sm">
                    {order.items.map((it) => (
                      <li key={it.id} className="flex justify-between gap-2">
                        <span className="text-gray-700">
                          <span className="font-semibold">{it.quantity}×</span> {it.productName}
                          {it.variantName ? ` (${it.variantName})` : ""}
                          {it.modifiers.length > 0 && (
                            <span className="block text-xs text-gray-400">
                              {it.modifiers.map((m) => m.option.name).join(", ")}
                            </span>
                          )}
                          {it.note && <span className="block text-xs italic text-gray-400">“{it.note}”</span>}
                        </span>
                        <span className="shrink-0 text-gray-500">{fmt(it.totalPrice, currency)}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
                    <span className="text-sm font-bold text-gray-900">{fmt(order.total, currency)}</span>
                    <div className="flex gap-2">
                      {flow && (
                        <button
                          onClick={() => advance(order)}
                          disabled={isPending}
                          className="btn-primary min-h-11 px-3 text-xs"
                        >
                          {flow.label}
                        </button>
                      )}
                      <Link href="/pos" className="btn-secondary min-h-11 px-3 text-xs">
                        ชำระเงิน
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* History */}
      <section className="space-y-2">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="text-sm font-bold text-[var(--ink)] hover:underline"
        >
          {showHistory ? "▼" : "▶"} ประวัติออร์เดอร์ QR ({initialHistory.length})
        </button>
        {showHistory && (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            {initialHistory.length === 0 ? (
              <p className="p-6 text-center text-sm text-gray-400">ยังไม่มีประวัติ</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-4 py-2 font-medium">ออร์เดอร์</th>
                    <th className="px-4 py-2 font-medium">โต๊ะ</th>
                    <th className="px-4 py-2 font-medium">สถานะ</th>
                    <th className="px-4 py-2 font-medium text-right">ยอด</th>
                    <th className="px-4 py-2 font-medium">เวลา</th>
                  </tr>
                </thead>
                <tbody>
                  {initialHistory.map((o) => (
                    <tr key={o.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-4 py-2 text-gray-700">#{o.orderNumber}</td>
                      <td className="px-4 py-2 text-gray-700">{o.tableNumber ?? "-"}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            o.status === "paid" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                          }`}
                        >
                          {o.status === "paid" ? "ชำระแล้ว" : o.status === "voided" ? "ยกเลิก" : o.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">{fmt(o.total, currency)}</td>
                      <td className="px-4 py-2 text-gray-500">
                        {new Date(o.paidAt ?? o.createdAt).toLocaleString("th-TH", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

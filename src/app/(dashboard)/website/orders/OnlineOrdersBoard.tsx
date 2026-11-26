"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Printer } from "@/modules/stores/types";
import { useConfirm } from "@/shared/components/ui/useConfirm";
import { STATUS_LABEL, nextStatuses, type OnlineOrderStatus } from "@/modules/online-orders/core";
import { printKitchenForOrder, type StationPrinter } from "../../delivery/print-kitchen";
import { acceptOnlineOrderAction, listOnlineOrdersAction, updateOnlineOrderStatusAction, type OnlineOrderVM } from "./actions";

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "-";

const COLOR: Partial<Record<OnlineOrderStatus, string>> = {
  paid: "bg-orange-100 text-orange-800",
  accepted: "bg-blue-100 text-blue-800",
  preparing: "bg-indigo-100 text-indigo-800",
  ready: "bg-green-100 text-green-800",
  out_for_delivery: "bg-green-100 text-green-800",
  completed: "bg-gray-100 text-gray-700",
  refund_pending: "bg-red-100 text-red-800",
  refunded: "bg-gray-100 text-gray-700",
};

const BUTTON_LABEL: Partial<Record<OnlineOrderStatus, string>> = {
  preparing: "กำลังทำ",
  ready: "พร้อมรับ",
  out_for_delivery: "ออกไปส่ง",
  completed: "สำเร็จ",
  refund_pending: "ยกเลิก (คืนเงิน)",
  refunded: "คืนเงินแล้ว",
};

export function OnlineOrdersBoard(props: {
  initialOrders: OnlineOrderVM[];
  canCancel: boolean;
  storeName: string;
  stationPrinters: StationPrinter[];
  paperWidth: "58mm" | "80mm";
  printers: Printer[];
}) {
  const [orders, setOrders] = useState(props.initialOrders);
  const [filter, setFilter] = useState<"active" | "done">("active");
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const { confirm, confirmDialog } = useConfirm();
  const router = useRouter();
  const [cancelling, setCancelling] = useState<{ id: string; reason: string } | null>(null);

  const reload = useCallback(async () => {
    const res = await listOnlineOrdersAction();
    if (!res.error) setOrders(res.orders);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 15000);
    return () => window.clearInterval(id);
  }, [reload]);

  const active = orders.filter((o) => !["completed", "refunded"].includes(o.status));
  const shown = filter === "active" ? active : orders.filter((o) => ["completed", "refunded"].includes(o.status));
  const waiting = orders.filter((o) => o.status === "paid").length;

  const accept = (o: OnlineOrderVM) => {
    setBusyId(o.id);
    setMessage(null);
    startTransition(async () => {
      const res = await acceptOnlineOrderAction(o.id);
      if (!res.ok || !res.orderId) {
        setMessage(res.error ?? "รับออเดอร์ไม่สำเร็จ");
      } else {
        const printed = await printKitchenForOrder(res.orderId, {
          storeName: props.storeName,
          stationPrinters: props.stationPrinters,
          paperWidth: props.paperWidth,
          billNumber: res.orderNumber ?? o.orderCode,
          printers: props.printers,
          fulfillment: o.fulfillment,
        }).catch(() => "พิมพ์ตั๋วครัวไม่สำเร็จ");
        setMessage(`รับออเดอร์ ${o.orderCode} แล้ว · ${printed}`);
        // R1: รับแล้วเด้งเข้าตั๋วออนไลน์ในหน้าขาย (ค้างจนส่งเสร็จ)
        setBusyId(null);
        router.push(`/pos?online=${o.id}`);
        return;
      }
      setBusyId(null);
      await reload();
    });
  };

  const move = async (o: OnlineOrderVM, to: OnlineOrderStatus, reason?: string) => {
    if (to === "refund_pending" && reason === undefined) {
      setCancelling({ id: o.id, reason: "ของหมด" });
      return;
    }
    if (
      to === "refunded" &&
      !(await confirm({ title: "ยืนยันคืนเงิน", message: `โอนคืน ${baht(o.total)} ให้ ${o.customerName} แล้วใช่ไหม?`, confirmLabel: "คืนเงินแล้ว", cancelLabel: "ยัง" }))
    ) {
      return;
    }
    setBusyId(o.id);
    setMessage(null);
    setCancelling(null);
    startTransition(async () => {
      const res = await updateOnlineOrderStatusAction(o.id, to, reason);
      if (!res.ok) setMessage(res.error);
      setBusyId(null);
      await reload();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setFilter("active")} className={filter === "active" ? "btn-primary" : "btn-secondary"}>
          กำลังดำเนินการ ({active.length})
        </button>
        <button type="button" onClick={() => setFilter("done")} className={filter === "done" ? "btn-primary" : "btn-secondary"}>
          เสร็จแล้ว
        </button>
        <button type="button" onClick={() => void reload()} className="btn-secondary">โหลดใหม่</button>
        {waiting > 0 && <span className="rounded-full bg-orange-600 px-3 py-1 text-sm font-semibold text-white">รอรับ {waiting}</span>}
      </div>
      {message && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">{message}</p>}
      {shown.length === 0 && <div className="panel p-6 text-center text-sm text-[var(--muted)]">ยังไม่มีออเดอร์ออนไลน์</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((o) => (
          <article key={o.id} className="panel space-y-2 p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-lg font-bold">{o.orderCode}</p>
                <p className="text-xs text-[var(--muted)]">
                  {o.fulfillment === "pickup" ? `รับที่ร้าน · นัด ${time(o.pickupAt)}` : `ส่งถึงบ้าน${o.distanceKm !== null ? ` · ${o.distanceKm.toFixed(1)} กม.` : ""}`} · จ่าย {time(o.paidAt)}
                </p>
              </div>
              <span className={`rounded-full px-2 py-1 text-xs ${COLOR[o.status] ?? ""}`}>{STATUS_LABEL[o.status]}</span>
            </div>
            <div>
              <p className="font-medium">
                {o.customerName} · <a href={`tel:${o.customerPhone}`} className="text-blue-700 underline">{o.customerPhone}</a>
              </p>
              {o.address && <p className="text-[var(--muted)]">{o.address}{o.addressNote ? ` (${o.addressNote})` : ""}</p>}
              {o.mapUrl && (
                <a href={o.mapUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">นำทาง (Google Maps)</a>
              )}
            </div>
            <ul className="divide-y rounded-lg border">
              {o.items.map((item, i) => (
                <li key={i} className="flex justify-between gap-2 px-2 py-1">
                  <span>
                    {item.quantity}× {item.name}
                    {item.detail && <span className="block text-xs text-[var(--muted)]">{item.detail}</span>}
                  </span>
                  <span>{baht(item.totalPrice)}</span>
                </li>
              ))}
            </ul>
            {o.note && <p className="rounded bg-yellow-50 px-2 py-1">📝 {o.note}</p>}
            <p className="flex justify-between font-semibold">
              <span>รวม{o.deliveryFee > 0 ? ` (ค่าส่ง ${baht(o.deliveryFee)})` : ""}</span>
              <span>{baht(o.total)}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {o.status === "paid" || (o.status === "accepted" && !o.billClosed) ? (
                <button type="button" disabled={busyId === o.id} onClick={() => accept(o)} className="btn-primary">
                  {busyId === o.id ? "กำลังรับ..." : o.status === "paid" ? "รับออเดอร์" : "ปิดบิลอีกครั้ง"}
                </button>
              ) : null}
              {nextStatuses(o.status, o.fulfillment)
                .filter((to) => to !== "accepted")
                .filter((to) => props.canCancel || to !== "refund_pending")
                .map((to) => (
                  <button
                    key={to}
                    type="button"
                    disabled={busyId === o.id}
                    onClick={() => void move(o, to)}
                    className={to === "refund_pending" ? "btn-secondary text-red-700" : "btn-secondary"}
                  >
                    {BUTTON_LABEL[to] ?? STATUS_LABEL[to]}
                  </button>
                ))}
            </div>
            {cancelling?.id === o.id && (
              <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-2">
                <p className="text-red-800">ยกเลิก {o.orderCode} — ลูกค้าจ่ายแล้ว {baht(o.total)} ร้านต้องโอนคืนเอง</p>
                <input
                  className="input w-full"
                  maxLength={200}
                  value={cancelling.reason}
                  onChange={(e) => setCancelling({ id: o.id, reason: e.target.value })}
                  placeholder="เหตุผล"
                  aria-label="เหตุผลที่ยกเลิก"
                />
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary text-red-700" onClick={() => void move(o, "refund_pending", cancelling.reason)}>
                    ยืนยันยกเลิก
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setCancelling(null)}>
                    ไม่ยกเลิก
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {confirmDialog}
    </div>
  );
}

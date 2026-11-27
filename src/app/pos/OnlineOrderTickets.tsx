"use client";

// ตั๋วออนไลน์ใน POS (แผน Online Delivery v3 — R1)
// ออเดอร์จากเว็บร้านจ่าย Beam แล้ว จึงไม่ใช่ "ตะกร้า" แบบตั๋วเดิม — แสดงเป็นตั๋วอ่านอย่างเดียว + ปุ่มสถานะ
// ไม่มีปุ่มเก็บเงินที่นี่ (กันเก็บเงินซ้ำ) · ยกเลิก/คืนเงินทำที่หน้า สั่งออนไลน์ เท่านั้น

import { useCallback, useEffect, useRef, useState } from "react";
import { nextStatuses, type CodCollectMethod, type OnlineOrderStatus } from "@/modules/online-orders/core";
import type { Printer } from "@/modules/stores/types";
import { printKitchenForOrder, type StationPrinter } from "../(dashboard)/delivery/print-kitchen";
import { RiderPicker } from "../(dashboard)/website/orders/RiderPicker";
import { CodBeamQrPanel, CodCollectPicker, CodFailButton } from "../(dashboard)/website/orders/CodControls";
import {
  pendingOnlineOrdersAction,
  acceptOnlineOrderAction,
  checkCodQrAction,
  settleCodCashAction,
  startCodQrAction,
  listOnlineOrdersAction,
  updateOnlineOrderStatusAction,
  type OnlineOrderVM,
} from "../(dashboard)/website/orders/actions";

import { ONLINE_ORDER_REFRESH_EVENT } from "./online-order-events";

/** สถานะที่ยังต้องอยู่ในแถบตั๋ว (รอรับ → ก่อนสำเร็จ) */
export const POS_ONLINE_STATUSES: readonly OnlineOrderStatus[] = ["paid", "cod_pending", "accepted", "preparing", "ready", "out_for_delivery"];

/** ถามว่ามีออเดอร์รอรับใหม่ไหม (query เบา) — ทุก 15 วิ แม้หน้าต่างอยู่เบื้องหลัง (POS ต้องดังเสมอ) */
const PENDING_POLL_MS = 15_000;
/** มีตั๋วค้าง = ถามทุก 30 วิ · ไม่มี = 2 นาที (เผื่อไม่มีสิทธิ์เห็นแจ้งเตือน) · แท็บซ่อนอยู่ไม่ถาม */
const POLL_ACTIVE_MS = 30_000;
const POLL_IDLE_MS = 120_000;

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "-";

const STATUS_TONE: Partial<Record<OnlineOrderStatus, string>> = {
  paid: "border-orange-300 bg-orange-50",
  accepted: "border-blue-200 bg-blue-50",
  preparing: "border-indigo-200 bg-indigo-50",
  ready: "border-green-200 bg-green-50",
  out_for_delivery: "border-green-200 bg-green-50",
};

const BUTTON_LABEL: Partial<Record<OnlineOrderStatus, string>> = {
  preparing: "กำลังทำ",
  ready: "พร้อมรับ",
  out_for_delivery: "ออกไปส่ง",
  completed: "สำเร็จ",
};

/** ป้ายการเงินของตั๋ว: จ่าย Beam แล้ว / เก็บปลายทาง / เงินค้างที่คนส่ง */
function moneyLabel(o: OnlineOrderVM): string {
  if (o.paymentMethod !== "cod") return `จ่ายแล้ว ${baht(o.total)}`;
  if (o.codCashPending) return `💵 เงินค้างที่คนส่ง ${baht(o.codCashPending)}`;
  return `เก็บปลายทาง ${baht(o.total)}`;
}

export function useOnlineOrderTickets(enabled: boolean) {
  const [orders, setOrders] = useState<OnlineOrderVM[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** ออเดอร์ที่รอร้านกดรับ (จากการถามทุก 15 วิ) — ใช้เตือนเสียง/แถบบนหน้าขาย */
  const [awaiting, setAwaiting] = useState<{ id: string; orderCode: string }[]>([]);
  /** เวลาที่ถามล่าสุด — ใช้คิดว่า "แตะดูแล้ว" หมดอายุหรือยัง (ไม่เรียก Date.now ระหว่าง render) */
  const [awaitingAt, setAwaitingAt] = useState(0);
  const activeRef = useRef(0);
  const knownAwaitingRef = useRef<string>("");

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const res = await listOnlineOrdersAction().catch(() => ({ orders: [] as OnlineOrderVM[], error: "โหลดออเดอร์ออนไลน์ไม่สำเร็จ" }));
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
    // + ส่งสำเร็จแล้วแต่เงินสดเก็บปลายทางยังไม่คืนร้าน (ต้องกด "รับเงินคืน")
    const active = res.orders.filter((o) => POS_ONLINE_STATUSES.includes(o.status) || o.codCashPending);
    activeRef.current = active.length;
    setOrders(active);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let cancelled = false;
    let first = true;
    const loop = async () => {
      // รอบแรกโหลดเสมอ (หน้าเปิดจากลิงก์ขณะหน้าต่างอยู่เบื้องหลังต้องมีข้อมูลทันที) · รอบถัดไปเฉพาะตอนเห็นหน้า
      if (first || document.visibilityState === "visible") await refresh();
      first = false;
      if (cancelled) return;
      timer = window.setTimeout(loop, activeRef.current > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    // setTimeout(0): setState เกิดหลัง effect จบ (กติกา react-hooks/set-state-in-effect)
    timer = window.setTimeout(loop, 0);
    const onEvent = () => void refresh();
    // กลับมาที่หน้าขาย (เปิดหน้าต่างโปรแกรมขึ้นมา) → โหลดทันที ไม่ต้องรอรอบ 2 นาที
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    // ออเดอร์รอรับ: ถามทุก 15 วิ — เจอชุดใหม่ (มีใบเพิ่ม/ลด) โหลดรายการเต็มใหม่ทันที
    const pollPending = async () => {
      const res = await pendingOnlineOrdersAction().catch(() => null);
      if (cancelled || !res || res.error) return;
      setAwaiting(res.orders);
      setAwaitingAt(Date.now());
      const key = res.orders.map((o) => o.id).join(",");
      if (key !== knownAwaitingRef.current) {
        knownAwaitingRef.current = key;
        void refresh();
      }
    };
    const pendingTimer = window.setInterval(() => void pollPending(), PENDING_POLL_MS);
    const firstPending = window.setTimeout(() => void pollPending(), 0);
    window.addEventListener(ONLINE_ORDER_REFRESH_EVENT, onEvent);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(pendingTimer);
      window.clearTimeout(firstPending);
      window.removeEventListener(ONLINE_ORDER_REFRESH_EVENT, onEvent);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  return { orders, error, refresh, awaiting, awaitingAt };
}

/** หมวด "ออนไลน์" ในแถบตั๋ว */
export function OnlineOrderTicketList({ orders, onOpen }: { orders: OnlineOrderVM[]; onOpen: (id: string) => void }) {
  if (orders.length === 0) return null;
  const waiting = orders.filter((o) => o.status === "paid" || o.status === "cod_pending").length;
  return (
    <div className="space-y-2" data-testid="online-order-tickets">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-gray-500">🌐 ออนไลน์ ({orders.length})</p>
        {waiting > 0 && (
          <span className="rounded-full bg-orange-600 px-2 py-0.5 text-[10px] font-semibold text-white">รอรับ {waiting}</span>
        )}
      </div>
      <ul className="space-y-2">
        {orders.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onOpen(o.id)}
              className={`min-h-11 w-full rounded-lg border px-3 py-2 text-left text-xs text-gray-700 ${STATUS_TONE[o.status] ?? "border-gray-200 bg-white"}`}
            >
              <span className="flex items-center justify-between gap-2 font-semibold">
                <span className="truncate">🌐 {o.orderCode}</span>
                <span className="shrink-0 text-[10px] font-medium">{o.statusLabel}</span>
              </span>
              <span className="mt-1 block text-[11px] text-gray-500">
                {o.fulfillment === "pickup" ? "รับที่ร้าน" : "ส่งถึงบ้าน"} · {moneyLabel(o)} · {o.items.length} รายการ
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-gray-500">
                {o.customerName} · สั่ง {time(o.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface OnlineTicketPrintOptions {
  storeName: string;
  stationPrinters: StationPrinter[];
  paperWidth: "58mm" | "80mm";
  printers: Printer[];
}

/** ตั๋วออนไลน์ที่เปิดอยู่: รายละเอียด + รับออเดอร์ (พิมพ์ตั๋วครัว) + เลื่อนสถานะ */
export function OnlineOrderTicketDialog({
  order,
  print,
  onClose,
  onChanged,
}: {
  order: OnlineOrderVM;
  print: OnlineTicketPrintOptions;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pickingRider, setPickingRider] = useState(false);
  const [pickingCod, setPickingCod] = useState(false);
  const [beamOpen, setBeamOpen] = useState(false);
  const isCod = order.paymentMethod === "cod";

  const printKitchen = async (orderId: string, billNumber: string) =>
    printKitchenForOrder(orderId, { ...print, billNumber, fulfillment: order.fulfillment }).catch(() => "พิมพ์ตั๋วครัวไม่สำเร็จ");

  const run = async (task: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await task());
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  const accept = () =>
    run(async () => {
      const res = await acceptOnlineOrderAction(order.id);
      if (!res.ok || !res.orderId) return res.error ?? "รับออเดอร์ไม่สำเร็จ";
      const printed = await printKitchen(res.orderId, res.orderNumber ?? order.orderCode);
      return `รับออเดอร์ ${order.orderCode} แล้ว · ${printed}`;
    });

  const move = (to: OnlineOrderStatus, riderUserId?: string, codMethod?: CodCollectMethod, reason?: string) => {
    // R2: ส่งถึงบ้าน → เลือกคนส่งก่อนออกไปส่ง
    if (to === "out_for_delivery" && order.fulfillment === "delivery" && !riderUserId) {
      setPickingRider(true);
      return;
    }
    // R3: เก็บปลายทาง → เลือกวิธีรับเงินก่อนสำเร็จ
    if (to === "completed" && isCod && !codMethod) {
      setPickingCod(true);
      return;
    }
    setPickingRider(false);
    setPickingCod(false);
    if (to === "completed" && codMethod === "beam") {
      setBeamOpen(true);
      return;
    }
    return run(async () => {
      const res = await updateOnlineOrderStatusAction(order.id, to, reason, riderUserId, codMethod);
      if (!res.ok) return res.error;
      return res.error ?? `เปลี่ยนเป็น "${to === "delivery_failed" ? "ส่งไม่สำเร็จ" : (BUTTON_LABEL[to] ?? to)}" แล้ว`;
    });
  };

  const settleCash = () =>
    run(async () => {
      const res = await settleCodCashAction(order.id);
      return res.ok ? `รับเงินสด ${baht(order.codCashPending ?? order.total)} คืนจากคนส่งแล้ว — ปิดบิลเข้าลิ้นชัก` : res.error;
    });

  const reprint = () =>
    run(async () => (order.orderId ? printKitchen(order.orderId, order.orderCode) : "ยังไม่มีบิล — กดรับออเดอร์ก่อน"));

  // POS ไม่ยกเลิก/คืนเงิน — ทำที่หน้า สั่งออนไลน์ (ต้องยืนยันโอนคืน)
  // บิล POS ยังไม่ปิด (ขั้นปิดบิลล้มตอนรับ) = ห้ามเลื่อนสถานะ — ไม่งั้นกด "สำเร็จ" แล้วยอดขายไม่เข้า POS
  // ปิดบิลซ้ำได้เฉพาะสถานะ "รับแล้ว" (acceptOnlineOrderAction รับแค่ paid/accepted)
  // เก็บปลายทาง: บิลเปิดค้างจนรับเงินเป็นเรื่องปกติ — ใช้กติกานี้กับออเดอร์จ่าย Beam เท่านั้น
  const awaitingAccept = order.status === "paid" || order.status === "cod_pending";
  const billPending = !isCod && order.status !== "paid" && !order.billClosed;
  const needsBillRetry = billPending && order.status === "accepted";
  const statusButtons =
    awaitingAccept || billPending ? [] : nextStatuses(order.status, order.fulfillment, order.paymentMethod).filter((to) => BUTTON_LABEL[to]);
  const canFail = isCod && nextStatuses(order.status, order.fulfillment, order.paymentMethod).includes("delivery_failed");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={`ออเดอร์ออนไลน์ ${order.orderCode}`}>
      <div className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-bold text-gray-900">🌐 {order.orderCode}</p>
            <p className="text-xs text-gray-500">
              {order.fulfillment === "pickup" ? "รับที่ร้าน" : "ส่งถึงบ้าน"} · {order.statusLabel} · สั่ง {time(order.createdAt)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-lg text-xl text-gray-500" aria-label="ปิด">
            ×
          </button>
        </div>

        <p className="mt-2 inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
          {isCod
            ? order.codCashPending
              ? `💵 เงินสดค้างที่คนส่ง ${baht(order.codCashPending)} — กด “รับเงินคืน” เมื่อได้เงิน`
              : order.status === "completed"
                ? `เก็บเงินปลายทางแล้ว (${order.codCollectedMethod === "bank_transfer" ? "โอน" : "เงินสด"})`
                : `เก็บเงินปลายทาง ${baht(order.total)} — รับเงินตอนส่งของ`
            : `จ่ายแล้ว (Beam) ${baht(order.total)} — ไม่ต้องเก็บเงิน`}
        </p>

        <ul className="mt-3 divide-y divide-gray-100 text-sm">
          {order.items.map((line, index) => (
            <li key={`${index}-${line.name}`} className="flex justify-between gap-3 py-1.5">
              <span>
                {line.name} ×{line.quantity}
                {line.detail && <span className="block text-xs text-gray-500">{line.detail}</span>}
              </span>
              <span className="shrink-0 tabular-nums">{baht(line.totalPrice)}</span>
            </li>
          ))}
          {order.deliveryFee > 0 && (
            <li className="flex justify-between py-1.5 text-gray-600">
              <span>ค่าส่ง{order.distanceKm !== null ? ` (${order.distanceKm.toFixed(1)} กม.)` : ""}</span>
              <span className="tabular-nums">{baht(order.deliveryFee)}</span>
            </li>
          )}
        </ul>

        <div className="mt-3 space-y-1 rounded-lg bg-gray-50 p-3 text-sm">
          <p>
            <b>{order.customerName}</b> ·{" "}
            <a href={`tel:${order.customerPhone}`} className="text-[var(--tenant-primary)] underline">
              {order.customerPhone}
            </a>
          </p>
          {order.address && <p className="text-gray-700">{order.address}</p>}
          {order.addressNote && <p className="text-xs text-gray-500">{order.addressNote}</p>}
          {order.pickupAt && <p className="text-xs text-gray-500">รับเวลา {time(order.pickupAt)}</p>}
          {order.note && <p className="text-xs text-amber-800">หมายเหตุ: {order.note}</p>}
          {order.mapUrl && (
            <a href={order.mapUrl} target="_blank" rel="noreferrer" className="inline-block text-xs font-semibold text-[var(--tenant-primary)] underline">
              เปิดแผนที่นำทาง
            </a>
          )}
        </div>

        {billPending && !needsBillRetry && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 p-2 text-sm text-red-800">
            บิลของออเดอร์นี้ยังไม่ปิด (ยอดยังไม่เข้า POS) — แจ้งผู้ดูแลตรวจที่หน้า สั่งออนไลน์ ก่อนเลื่อนสถานะ
          </p>
        )}
        {order.riderName && (
          <p className="mt-3 rounded-lg bg-sky-50 p-2 text-sm text-sky-900">
            🛵 คนส่ง: <b>{order.riderName}</b>
            {order.riderPayAmount ? ` · รายได้พิเศษ ${baht(order.riderPayAmount)} (เข้าเงินเดือนเมื่อสำเร็จ)` : ""}
          </p>
        )}
        {message && (
          <p role="status" className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {message}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {order.codCashPending ? (
            <button type="button" disabled={busy} onClick={settleCash} className="btn-primary min-h-11 flex-1 px-4 text-sm">
              รับเงินคืน {baht(order.codCashPending)}
            </button>
          ) : null}
          {awaitingAccept && (
            <button type="button" disabled={busy} onClick={accept} className="btn-primary min-h-11 flex-1 px-4 text-sm">
              {busy ? "กำลังรับ…" : "รับออเดอร์ + พิมพ์ตั๋วครัว"}
            </button>
          )}
          {needsBillRetry && (
            <button type="button" disabled={busy} onClick={accept} className="btn-secondary min-h-11 px-4 text-sm">
              ปิดบิลอีกครั้ง
            </button>
          )}
          {statusButtons.map((to) => (
            <button key={to} type="button" disabled={busy} onClick={() => move(to)} className="btn-primary min-h-11 px-4 text-sm">
              {BUTTON_LABEL[to]}
            </button>
          ))}
          {order.orderId && order.status !== "completed" && (
            <button type="button" disabled={busy} onClick={reprint} className="btn-secondary min-h-11 px-4 text-sm">
              พิมพ์ตั๋วครัวซ้ำ
            </button>
          )}
          {canFail && (
            <CodFailButton
              busy={busy}
              label={order.status === "cod_pending" ? "ปฏิเสธออเดอร์" : "ส่งไม่สำเร็จ"}
              onConfirm={(reason) => void move("delivery_failed", undefined, undefined, reason)}
            />
          )}
        </div>
        <p className="mt-3 text-[11px] text-gray-400">ยกเลิก/คืนเงิน ทำที่หน้า สั่งออนไลน์ (ต้องยืนยันการโอนคืน)</p>
        {beamOpen && (
          <CodBeamQrPanel
            orderCode={order.orderCode}
            total={order.total}
            start={() => startCodQrAction(order.id)}
            check={(gw) => checkCodQrAction(order.id, gw)}
            onDone={() => {
              setBeamOpen(false);
              setMessage(`ได้รับเงิน Beam ${order.orderCode} แล้ว — ปิดบิลและส่งสำเร็จ`);
              void onChanged();
            }}
            onClose={() => setBeamOpen(false)}
          />
        )}
        {pickingCod && (
          <CodCollectPicker
            orderCode={order.orderCode}
            total={order.total}
            busy={busy}
            onPick={(method) => void move("completed", undefined, method)}
            onClose={() => setPickingCod(false)}
          />
        )}
        {pickingRider && (
          <RiderPicker
            orderCode={order.orderCode}
            subtotal={order.subtotal}
            deliveryFee={order.deliveryFee}
            busy={busy}
            onPick={(riderUserId) => void move("out_for_delivery", riderUserId)}
            onClose={() => setPickingRider(false)}
          />
        )}
      </div>
    </div>
  );
}

/** แถบเตือนออเดอร์ออนไลน์ใหม่บนหน้าขาย (ดังซ้ำจนกว่าจะแตะเปิด — แคชเชียร์ไม่เห็นแจ้งเตือนกลาง) */
export function OnlineOrderAlertBanner({ orders, onOpen }: { orders: { id: string; orderCode: string }[]; onOpen: (id: string) => void }) {
  if (orders.length === 0) return null;
  const first = orders[0];
  return (
    <button
      type="button"
      onClick={() => onOpen(first.id)}
      className="fixed left-1/2 top-3 z-[45] flex min-h-12 -translate-x-1/2 items-center gap-2 rounded-full bg-orange-600 px-5 text-sm font-bold text-white shadow-2xl ring-4 ring-orange-200 animate-pulse"
      data-testid="online-order-alert"
    >
      🌐 ออเดอร์ออนไลน์ใหม่ {first.orderCode}
      {orders.length > 1 ? ` (+${orders.length - 1})` : ""} — แตะเพื่อเปิด
    </button>
  );
}

"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { QrCode } from "@/shared/components/ui/QrCode";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import type { QrOrderView } from "@/modules/qr-ordering/types";
import { listOpenQrOrdersAction, collectPaymentAction, closeTableAction } from "./actions";

interface Props {
  currency: string;
  promptpayId?: string;
  onClose: () => void;
  onSettled: () => void;
}

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

export function TableBillModal({ currency, promptpayId, onClose, onSettled }: Props) {
  const [orders, setOrders] = useState<QrOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settle, setSettle] = useState<QrOrderView | null>(null);
  const [method, setMethod] = useState<"cash" | "qr_promptpay">("cash");
  const [received, setReceived] = useState("");
  const [qrPaymentVerified, setQrPaymentVerified] = useState(false);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      setLoading(true);
      const res = await listOpenQrOrdersAction();
      if (res.error) setError(res.error);
      else setOrders(res.orders);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const receivedNum = parseFloat(received) || 0;
  const change = settle ? receivedNum - settle.total : 0;
  const cashReady = method !== "cash" || receivedNum >= (settle?.total ?? 0);

  let payload: string | null = null;
  if (settle && method === "qr_promptpay" && promptpayId && settle.total > 0) {
    try {
      payload = buildPromptPayPayload({ recipientId: promptpayId, amount: settle.total });
    } catch {
      payload = null;
    }
  }
  const qrReady = method !== "qr_promptpay" || (!!payload && qrPaymentVerified);

  function confirmPayment() {
    if (!settle) return;
    const tableId = settle.tableId;
    const tableLabel = settle.tableNumber ?? "";
    setError(null);
    startTransition(async () => {
      const res = await collectPaymentAction(settle.id, {
        method,
        amount: settle.total,
        receivedAmount: method === "cash" ? receivedNum : undefined,
        changeAmount: method === "cash" ? Math.max(0, receivedNum - settle.total) : undefined,
        qrPaymentVerified: method === "qr_promptpay" ? qrPaymentVerified : undefined,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setSettle(null);
      setReceived("");
      setMethod("cash");
      setQrPaymentVerified(false);
      onSettled();

      // Refresh and, if this table has no remaining unpaid bills, offer to free the table.
      setLoading(true);
      const fresh = await listOpenQrOrdersAction();
      if (!fresh.error) setOrders(fresh.orders);
      setLoading(false);

      if (tableId) {
        const remaining = (fresh.orders ?? []).filter((o) => o.tableId === tableId).length;
        if (remaining === 0) {
          const ok = window.confirm(`เช็คบิลโต๊ะ ${tableLabel} ครบแล้ว — คืนโต๊ะว่าง (ปิดโต๊ะ) เลยไหม?`);
          if (ok) {
            const c = await closeTableAction(tableId);
            if (c.error) setError(c.error);
          }
        }
      }
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={isPending ? undefined : onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-base font-bold text-gray-900">
            {settle ? `เช็คบิลโต๊ะ ${settle.tableNumber ?? "-"}` : "เช็คบิลโต๊ะ (QR Order)"}
          </h2>
          <button onClick={onClose} className="min-h-9 min-w-9 text-gray-400">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          {settle ? (
            <div className="space-y-3">
              <ul className="space-y-1 text-sm">
                {settle.items.map((it) => (
                  <li key={it.id} className="flex justify-between text-gray-600">
                    <span>{it.quantity}× {it.productName}{it.variantName ? ` (${it.variantName})` : ""}</span>
                    <span>{fmt(it.totalPrice, currency)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex justify-between border-t border-gray-100 pt-2 text-base font-bold text-gray-900">
                <span>รวม</span>
                <span>{fmt(settle.total, currency)}</span>
              </div>

              <div className="flex gap-2">
                {(["cash", "qr_promptpay"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMethod(m);
                      setQrPaymentVerified(false);
                    }}
                    className={`flex-1 min-h-11 rounded-lg border text-sm font-semibold ${
                      method === m ? "border-orange-400 bg-orange-50 text-orange-700" : "border-gray-200 text-gray-600"
                    }`}
                  >
                    {m === "cash" ? "เงินสด" : "QR พร้อมเพย์"}
                  </button>
                ))}
              </div>

              {method === "cash" ? (
                <div>
                  <label className="text-xs font-medium text-gray-600">รับเงินมา</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                    placeholder={String(settle.total)}
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                  />
                  {receivedNum > 0 && (
                    <p className="mt-1 text-xs text-gray-500">เงินทอน {fmt(Math.max(0, change), currency)}</p>
                  )}
                </div>
              ) : payload ? (
                <div className="flex flex-col items-center gap-2 py-2">
                  <QrCode value={payload} size={190} />
                  <p className="text-sm font-semibold text-gray-700">ให้ลูกค้าสแกนชำระ {fmt(settle.total, currency)}</p>
                  <p className="text-xs text-gray-400">PromptPay: {promptpayId}</p>
                  <label className="mt-2 flex min-h-11 items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 text-xs font-semibold text-green-700">
                    <input
                      type="checkbox"
                      checked={qrPaymentVerified}
                      onChange={(event) => setQrPaymentVerified(event.target.checked)}
                    />
                    ยืนยันว่าได้รับเงิน QR แล้ว
                  </label>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-center text-xs text-amber-700">
                  ยังไม่ได้ตั้งเลข PromptPay ของร้าน (ตั้งค่า › ใบเสร็จ)
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button onClick={() => { setSettle(null); setError(null); setQrPaymentVerified(false); }} disabled={isPending} className="btn-secondary min-h-11 flex-1 text-sm">
                  ย้อนกลับ
                </button>
                <button
                  onClick={confirmPayment}
                  disabled={isPending || !cashReady || !qrReady || (method === "qr_promptpay" && !payload)}
                  className="btn-primary min-h-11 flex-1 text-sm disabled:opacity-40"
                >
                  {isPending ? "กำลังชำระ..." : "ยืนยันชำระ"}
                </button>
              </div>
            </div>
          ) : loading ? (
            <p className="py-8 text-center text-sm text-gray-400">กำลังโหลด...</p>
          ) : orders.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">ไม่มีบิล QR ที่ค้างชำระ</p>
          ) : (
            <ul className="space-y-2">
              {orders.map((o) => (
                <li key={o.id}>
                  <button
                    onClick={() => { setSettle(o); setError(null); setQrPaymentVerified(false); }}
                    className="flex w-full items-center justify-between rounded-xl border border-gray-200 p-3 text-left active:bg-gray-50"
                  >
                    <span>
                      <span className="block text-sm font-bold text-gray-900">โต๊ะ {o.tableNumber ?? "-"}</span>
                      <span className="block text-xs text-gray-400">#{o.orderNumber} · {o.items.length} รายการ</span>
                    </span>
                    <span className="text-sm font-bold text-gray-900">{fmt(o.total, currency)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

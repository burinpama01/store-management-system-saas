"use client";

// U11 — Bills panel ของ unified shell (v0.37.2)
// บิลมาจาก server เสมอ (fetchUnifiedPosTableBillAction — รายการ non-voided + payments
// + orders.total) และการชำระใช้เส้นทาง governed เดียวกับ surfaces เดิม (settleUnifiedPosBillAction
// → RPC U7) พร้อม print intent "หลัง commit" ที่คืน receipt reference + print job ids
//
// กฎ replay-safety (สัญญา U11):
//   - client สร้าง idempotency key ต่อ "คำขอ" หนึ่งครั้ง (แก้ฟอร์ม/เปลี่ยนโต๊ะ = คำขอใหม่)
//     และส่งคีย์เดิมซ้ำเมื่อกดปุ่มระหว่างรอ/หลัง timeout → server ตอบ replay ด้วย
//     ผลเดิม + job id เดิม (ไม่มีใบเสร็จ/ตั๋วซ้ำ)
//   - panel นี้ไม่เคย browser-auto-print (ไม่เรียก /api/print/enqueue และไม่ window.print)
//     — การพิมพ์ซ้ำทำผ่านปุ่ม "พิมพ์ซ้ำ" เท่านั้น (explicit + audited ฝั่ง server)

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchUnifiedPosTableBillAction,
  reprintUnifiedPosReceiptAction,
  settleUnifiedPosBillAction,
  type UnifiedPosSettleBillResult,
} from "./actions";
import type { UnifiedPosBillOrderView, UnifiedPosTableBillView } from "./bill-types";
import type { UnifiedTableSummary } from "./types";

type Notice = { tone: "error" | "info"; message: string } | null;
type SettleMethod = "cash" | "qr_promptpay" | "other";

const METHOD_LABEL: Record<SettleMethod, string> = {
  cash: "เงินสด",
  qr_promptpay: "QR PromptPay",
  other: "อื่น ๆ",
};

function formatBaht(amount: number): string {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface BillsPanelProps {
  /** บริบทร่วมของ shell — โต๊ะที่เลือกจากแท็บโต๊ะ (บิลแสดงเฉพาะเมื่อเลือกโต๊ะ) */
  readonly selectedTable: UnifiedTableSummary | null;
}

export function BillsPanel({ selectedTable }: BillsPanelProps) {
  const tableId = selectedTable?.id ?? null;
  const [bill, setBill] = useState<UnifiedPosTableBillView | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [method, setMethod] = useState<SettleMethod>("qr_promptpay");
  const [receivedText, setReceivedText] = useState("");
  const [qrConfirmed, setQrConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [settleResult, setSettleResult] = useState<Extract<UnifiedPosSettleBillResult, { ok: true }> | null>(null);
  const [reprintJobId, setReprintJobId] = useState<string | null>(null);
  const [reprintPending, setReprintPending] = useState(false);

  /**
   * idempotency key ต่อ "คำขอ" — คำขอนิยามด้วย semantic (tableId + mode + orderIds):
   *   - กดปุ่มเดิมซ้ำ (ระหว่างรอ/หลัง timeout) = คำขอเดิม → ใช้คีย์เดิม → server replay
   *   - แก้ฟอร์ม / กดปุ่มคนละบิลหรือคนละโหมด = คำขอใหม่ → คีย์ใหม่ (กัน key รั่วข้ามคำขอ)
   * ref นี้ถูกแตะใน event handler เท่านั้น (lint react-hooks/refs ห้ามแตะตอน render)
   */
  const attemptKeyRef = useRef<{ semantic: string; key: string } | null>(null);

  const refetchBill = useCallback(
    async (targetTableId: string) => {
      setLoading(true);
      try {
        const result = await fetchUnifiedPosTableBillAction(targetTableId);
        if (result.error) {
          setNotice({ tone: "error", message: result.error });
          return;
        }
        setBill(result.bill);
      } catch {
        setNotice({ tone: "error", message: "โหลดบิลไม่สำเร็จ กรุณาลองอีกครั้ง" });
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // เปลี่ยนโต๊ะ = คำขอ/บริบทใหม่ทั้งหมด — reset state ตอน render (pattern "adjusting
  // state when props change" ตาม React docs); การ reset ของ attempt key อยู่ใน settle
  // (event handler) โดยเทียบ tableId — ไม่แตะ ref ระหว่าง render
  const [renderedTableId, setRenderedTableId] = useState(tableId);
  if (renderedTableId !== tableId) {
    setRenderedTableId(tableId);
    setBill(null);
    setSettleResult(null);
    setReprintJobId(null);
    setNotice(null);
    setQrConfirmed(false);
    setReceivedText("");
  }

  // โหลดบิลของโต๊ะที่เลือก (server truth) — refetch เมื่อเปลี่ยนโต๊ะ/หลังชำระ/stale;
  // fetch รันใน timer callback (external trigger) ไม่ใช่ sync ในตัว effect ตามหลัก React
  useEffect(() => {
    if (!tableId) return;
    const timer = setTimeout(() => {
      void refetchBill(tableId);
    }, 0);
    return () => clearTimeout(timer);
  }, [tableId, refetchBill]);

  const resetAttempt = useCallback(() => {
    attemptKeyRef.current = null; // แก้ฟอร์ม = semantic ของคำขอเปลี่ยน → คีย์ใหม่
  }, []);

  const settle = useCallback(
    async (mode: "partial" | "whole_table", order?: UnifiedPosBillOrderView) => {
      if (!tableId || !bill) return;
      const orderIds = mode === "partial" && order ? [order.orderId] : undefined;
      const amount = mode === "partial" && order ? order.total : bill.grandTotal;
      if (method === "cash") {
        const received = Number(receivedText);
        if (!Number.isFinite(received) || received < amount) {
          setNotice({ tone: "error", message: "กรุณาระบุเงินสดที่รับให้ไม่น้อยกว่ายอดชำระ" });
          return;
        }
      }
      if (method === "qr_promptpay" && !qrConfirmed) {
        setNotice({ tone: "error", message: "กรุณายืนยันว่าได้รับเงิน QR แล้ว" });
        return;
      }

      // retry ของคำขอเดิมใช้คีย์เดิมเสมอ (replay → ผล + job เดิม); คำขอใหม่ = คีย์ใหม่ —
      // คำขอนิยามด้วย semantic (table+mode+orderIds): กดปุ่มบิลอื่น/อีกโหมดระหว่างรอ
      // ต้องได้คีย์ใหม่ ไม่ใช่ replay ของคำขอเก่า
      const semantic = `${tableId}|${mode}|${(mode === "partial" && order ? order.orderId : "")}`;
      let attempt = attemptKeyRef.current;
      if (!attempt || attempt.semantic !== semantic) {
        attempt = {
          semantic,
          key:
            typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `bill-${Date.now()}`,
        };
        attemptKeyRef.current = attempt;
      }
      const idempotencyKey = attempt.key;
      const receivedAmount =
        method === "cash" ? Number(receivedText) : null;
      const changeAmount =
        method === "cash" ? Math.round((Number(receivedText) - amount) * 100) / 100 : null;

      setPending(true);
      setNotice(null);
      try {
        const result = await settleUnifiedPosBillAction({
          tableId,
          mode,
          orderIds,
          method,
          amount: mode === "partial" ? amount : null, // whole_table: RPC คิดยอดจาก server เอง
          receivedAmount,
          changeAmount,
          reference: null,
          idempotencyKey,
        });
        if (!result.ok) {
          setNotice({
            tone: "error",
            message: result.stale ? `${result.error} — โหลดบิลล่าสุดจากระบบแล้ว` : result.error,
          });
          if (result.stale) void refetchBill(tableId);
          return;
        }
        setSettleResult(result);
        setReprintJobId(null);
        setQrConfirmed(false);
        attemptKeyRef.current = null; // คำขอสำเร็จ — การชำระถัดไปเป็นคำขอใหม่
        void refetchBill(tableId);
      } catch {
        setNotice({ tone: "error", message: "ชำระเงินไม่สำเร็จ กรุณาลองอีกครั้ง (คำขอเดิมจะถูก replay อย่างปลอดภัย)" });
      } finally {
        setPending(false);
      }
    },
    [bill, method, qrConfirmed, receivedText, refetchBill, tableId],
  );

  const reprint = useCallback(async () => {
    if (!settleResult) return;
    setReprintPending(true);
    setNotice(null);
    try {
      const result = await reprintUnifiedPosReceiptAction(settleResult.receipt.reference);
      if (!result.ok) {
        setNotice({ tone: "error", message: result.error });
        return;
      }
      setReprintJobId(result.jobId);
    } catch {
      setNotice({ tone: "error", message: "พิมพ์ซ้ำไม่สำเร็จ กรุณาลองอีกครั้ง" });
    } finally {
      setReprintPending(false);
    }
  }, [settleResult]);

  return (
    <section aria-label="บิลและการพิมพ์">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">บิลและการพิมพ์</h2>

      <div role="status" aria-live="polite" className="sr-only">
        {notice?.message ?? ""}
      </div>
      {notice && (
        <div
          className={`mb-2 rounded-lg px-3 py-2 text-sm ${
            notice.tone === "error" ? "bg-red-50 text-red-700" : "bg-orange-50 text-orange-800"
          }`}
        >
          {notice.message}
        </div>
      )}

      {!tableId && (
        <p className="rounded-lg bg-white px-3 py-4 text-sm text-gray-500 ring-1 ring-gray-200">
          เลือกโต๊ะจากแท็บโต๊ะเพื่อดูบิลและชำระเงิน
        </p>
      )}

      {tableId && (
        <div className="space-y-3">
          <div className="rounded-lg bg-white p-3 ring-1 ring-gray-200" data-testid="unified-bill-view">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-800">
                โต๊ะ {selectedTable?.number}
                {bill?.tableNumber && selectedTable?.number !== bill.tableNumber ? ` (${bill.tableNumber})` : ""}
              </h3>
              <span className="text-xs text-gray-500">{loading ? "กำลังโหลด…" : "ข้อมูลจากระบบ"}</span>
            </div>

            {bill && bill.orders.length === 0 && (
              <p className="text-sm text-gray-500">โต๊ะนี้ไม่มีบิลค้างชำระ</p>
            )}

            {bill &&
              bill.orders.map((order) => (
                <div
                  key={order.orderId}
                  data-bill-order={order.orderId}
                  data-bill-total={order.total}
                  className="mb-2 rounded-md border border-gray-200 p-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="text-sm font-medium text-gray-800">บิล {order.orderNumber}</span>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                      {order.source === "qr" ? "QR" : "พนักงาน"}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-0.5 text-sm text-gray-700">
                    {order.items.map((item) => (
                      <li key={item.itemId}>
                        x{item.quantity} {item.productName}
                        {item.variantName ? ` (${item.variantName})` : ""}
                        {item.modifierNames.length > 0 ? ` · ${item.modifierNames.join(", ")}` : ""} —{" "}
                        {formatBaht(item.totalPrice)} บาท
                      </li>
                    ))}
                  </ul>
                  {order.discount > 0 && (
                    <p className="mt-1 text-xs text-gray-500">ส่วนลดบิล: -{formatBaht(order.discount)} บาท</p>
                  )}
                  <p className="mt-1 text-sm font-semibold text-gray-900">ยอดชำระ: {formatBaht(order.total)} บาท</p>
                  {order.payments.length > 0 && (
                    <p className="text-xs text-gray-500">
                      ชำระแล้ว: {order.payments.map((p) => `${METHOD_LABEL[p.method as SettleMethod] ?? p.method} ${formatBaht(p.amount)}`).join(", ")}
                    </p>
                  )}
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => void settle("partial", order)}
                      // retry ของคำขอเดิมต้องกดซ้ำได้ (idempotency key เดิม → replay)
                      // จึงไม่ disable ระหว่างรอ — server dedupe ให้อยู่แล้ว
                      aria-busy={pending}
                      data-testid="settle-order"
                      className="min-h-11 rounded-md bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-700 transition-colors motion-reduce:transition-none"
                    >
                      ชำระบิลนี้ ({formatBaht(order.total)} บาท)
                    </button>
                  </div>
                </div>
              ))}

            {bill && bill.orders.length > 0 && (
              <div className="mt-2 rounded-md bg-orange-50 p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-900">
                    ยอดรวมทั้งโต๊ะ: {formatBaht(bill.grandTotal)} บาท
                  </span>
                  <button
                    type="button"
                    onClick={() => void settle("whole_table")}
                    aria-busy={pending}
                    data-testid="settle-whole-table"
                    className="min-h-11 rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors motion-reduce:transition-none"
                  >
                    {pending ? "กำลังชำระ…" : "ชำระทั้งโต๊ะ"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {bill && bill.orders.length > 0 && (
            <div className="rounded-lg bg-white p-3 ring-1 ring-gray-200">
              <h3 className="mb-2 text-sm font-semibold text-gray-800">วิธีชำระเงิน</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="unified-bill-method" className="block text-xs text-gray-600">
                    วิธีชำระ
                  </label>
                  <select
                    id="unified-bill-method"
                    value={method}
                    onChange={(e) => {
                      setMethod(e.target.value as SettleMethod);
                      resetAttempt();
                    }}
                    className="mt-1 min-h-11 rounded-md border border-gray-300 px-2 py-2 text-sm"
                  >
                    <option value="qr_promptpay">QR PromptPay</option>
                    <option value="cash">เงินสด</option>
                    <option value="other">อื่น ๆ</option>
                  </select>
                </div>
                {method === "cash" && (
                  <div>
                    <label htmlFor="unified-bill-received" className="block text-xs text-gray-600">
                      เงินสดที่รับ (บาท)
                    </label>
                    <input
                      id="unified-bill-received"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={receivedText}
                      onChange={(e) => {
                        setReceivedText(e.target.value);
                        resetAttempt();
                      }}
                      className="mt-1 min-h-11 w-32 rounded-md border border-gray-300 px-2 py-2 text-sm"
                    />
                    {Number(receivedText) >= bill.grandTotal && (
                      <p className="text-xs text-gray-500">
                        เงินทอน: {formatBaht(Math.round((Number(receivedText) - bill.grandTotal) * 100) / 100)} บาท
                      </p>
                    )}
                  </div>
                )}
                {method === "qr_promptpay" && (
                  <label className="flex min-h-11 items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={qrConfirmed}
                      onChange={(e) => setQrConfirmed(e.target.checked)}
                      className="size-4"
                    />
                    ยืนยันว่าได้รับเงิน QR แล้ว
                  </label>
                )}
              </div>
            </div>
          )}

          {settleResult && (
            <div
              className="rounded-lg bg-white p-3 ring-1 ring-green-200"
              data-testid="settle-result"
              data-receipt-reference={settleResult.receipt.reference}
              data-receipt-job-id={settleResult.receipt.receiptJobId ?? ""}
              data-replayed={settleResult.replayed ? "true" : "false"}
            >
              <h3 className="text-sm font-semibold text-green-700">
                {settleResult.replayed ? "ส่งคำขอซ้ำ — ผลลัพธ์เดิมจากระบบ" : "ชำระเงินสำเร็จ"}
              </h3>
              <p className="mt-1 text-sm text-gray-700">
                ยอดรวม: {formatBaht(settleResult.result.grand_total)} บาท ·{" "}
                {settleResult.result.mode === "whole_table" ? "ชำระทั้งโต๊ะ" : `ชำระ ${settleResult.result.order_ids.length} บิล`}
                {settleResult.result.table_closed ? " · ปิดโต๊ะแล้ว" : ""}
              </p>
              {settleResult.replayed && (
                <p className="mt-1 text-sm text-orange-700">
                  คำขอนี้ถูกส่งซ้ำ (replay) — ระบบใช้ผลลัพธ์เดิมของคำขอเดิม (job เดิมถูกอ้างอิง ไม่สร้างงานพิมพ์ซ้ำ)
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                อ้างอิงใบเสร็จ: <span className="font-mono">{settleResult.receipt.reference}</span>
              </p>
              {settleResult.receipt.receiptJobId ? (
                <p className="text-xs text-gray-600">
                  ใบเสร็จ: ส่งพิมพ์ผ่าน Print Hub (งาน <span className="font-mono">{settleResult.receipt.receiptJobId}</span>)
                </p>
              ) : (
                settleResult.receipt.receiptNotice && (
                  <p className="text-xs text-gray-500">{settleResult.receipt.receiptNotice}</p>
                )
              )}
              {settleResult.receipt.stationJobIds.length > 0 && (
                <p className="text-xs text-gray-600">
                  ตั๋วครัว: {settleResult.receipt.stationJobIds.length} งาน (งาน{" "}
                  <span className="font-mono">{settleResult.receipt.stationJobIds.join(", ")}</span>)
                </p>
              )}
              {settleResult.receipt.stationNotice && (
                <p className="text-xs text-gray-500">{settleResult.receipt.stationNotice}</p>
              )}
              {settleResult.receipt.receiptJobId && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => void reprint()}
                    disabled={reprintPending}
                    data-testid="reprint-receipt"
                    className="min-h-11 rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors motion-reduce:transition-none"
                  >
                    {reprintPending ? "กำลังส่งพิมพ์ซ้ำ…" : "พิมพ์ใบเสร็จซ้ำ"}
                  </button>
                  {reprintJobId && (
                    <p className="mt-1 text-xs text-green-700" data-testid="reprint-done">
                      พิมพ์ซ้ำแล้ว: งาน <span className="font-mono">{reprintJobId}</span> (บันทึกประวัติการตรวจสอบแล้ว)
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

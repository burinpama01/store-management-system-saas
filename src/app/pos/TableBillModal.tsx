"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { QrCode } from "@/shared/components/ui/QrCode";
import { Button } from "@/shared/components/ui";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { printReceiptWithFallback } from "@/modules/printing/receipt-printer";
import type { ReceiptData } from "@/modules/printing/types";
import type { Printer, ReceiptSettings } from "@/modules/stores/types";
import { listTableBillsAction, settleWholeTableAction, type TableBill } from "./actions";

interface Props {
  currency: string;
  promptpayId?: string;
  storeName: string;
  receiptSettings: ReceiptSettings | null;
  printers: Printer[];
  preferredPrinterId: string | null;
  /** เปิดมาที่โต๊ะนี้เลย (จาก deep link /pos?tableBill=<id>) */
  initialTableId?: string | null;
  /** เลขโต๊ะของ initialTableId (ถ้ารู้ — ใช้ตอนโต๊ะยังไม่มีบิล) */
  initialTableNumber?: string | null;
  onClose: () => void;
  onSettled: () => void;
  /** กด "เพิ่มรายการ" ในบิลโต๊ะ → ให้ POS เข้าโหมดเพิ่มรายการผูกโต๊ะ */
  onAddItems?: (tableId: string, tableNumber: string) => void;
}

type TableBillPrintMode =
  | { status: "unpaid" }
  | {
      status: "paid";
      method: "cash" | "qr_promptpay";
      receivedAmount?: number;
      changeAmount?: number;
    };

/** สร้างข้อมูลใบเสร็จรวมของโต๊ะ (QR orders + ตั๋ว POS) — ใบแจ้งยอด (unpaid, มี QR ชำระ) หรือใบเสร็จรับเงิน */
function buildTableBillReceipt(
  bill: TableBill,
  settings: ReceiptSettings | null,
  storeName: string,
  mode: TableBillPrintMode,
): ReceiptData {
  const items = [
    ...bill.qrOrders.flatMap((order) =>
      order.items
        .filter((item) => !item.voided)
        .map((item) => ({
          name: item.productName,
          variantName: item.variantName,
          modifierNames: item.modifiers.map((m) => m.option.name),
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          note: item.note,
        })),
    ),
    ...bill.tickets.flatMap((ticket) => ticket.items.map((item) => ({ ...item }))),
  ];
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.totalPrice, 0) * 100) / 100;
  const total = bill.grandTotal;
  const discount = Math.max(0, Math.round((subtotal - total) * 100) / 100);
  const unpaid = mode.status === "unpaid";
  return {
    storeName: settings?.storeName || storeName,
    address: settings?.address,
    phone: settings?.phone,
    taxId: settings?.taxId,
    showTaxId: settings?.showTaxId ?? false,
    orderNumber: `TABLE-${bill.tableNumber}`,
    tableNumber: bill.tableNumber,
    items,
    subtotal,
    discount,
    total,
    payments: unpaid
      ? []
      : [
          {
            method: mode.method,
            amount: total,
            receivedAmount: mode.receivedAmount,
            changeAmount: mode.changeAmount,
          },
        ],
    paymentStatus: mode.status,
    vatRate:
      settings && settings.showVatBreakdown && settings.vatRate > 0 ? settings.vatRate : undefined,
    footerText: settings?.footerText,
    headerText: settings?.headerText,
    logoUrl: settings?.logoUrl,
    footerImageUrl: settings?.footerImageUrl,
    // ใบแจ้งยอด: โชว์ QR PromptPay ล็อกยอดให้ลูกค้าสแกนจ่ายที่โต๊ะ; ใบเสร็จรับเงิน: ไม่ต้อง
    showQrPayment: unpaid,
    promptpayId: settings?.promptpayId,
    paperWidth: settings?.paperWidth ?? "80mm",
    printCopies: unpaid ? 1 : settings?.printCopies ?? 1,
    printedAt: new Date().toISOString(),
  };
}

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

export function TableBillModal({
  currency,
  promptpayId,
  storeName,
  receiptSettings,
  printers,
  preferredPrinterId,
  initialTableId,
  initialTableNumber,
  onClose,
  onSettled,
  onAddItems,
}: Props) {
  const [bills, setBills] = useState<TableBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [printMsg, setPrintMsg] = useState<string | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(initialTableId ?? null);
  const [method, setMethod] = useState<"cash" | "qr_promptpay">("cash");
  const [received, setReceived] = useState("");
  const [qrPaymentVerified, setQrPaymentVerified] = useState(false);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      setLoading(true);
      const res = await listTableBillsAction();
      if (res.error) setError(res.error);
      else setBills(res.bills);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Derive the selected table's bill from the latest list (stays fresh after reloads).
  const selected = selectedTableId ? bills.find((b) => b.tableId === selectedTableId) ?? null : null;

  const receivedNum = parseFloat(received) || 0;
  const grandTotal = selected?.grandTotal ?? 0;
  const change = receivedNum - grandTotal;
  const cashReady = method !== "cash" || receivedNum >= grandTotal;

  let payload: string | null = null;
  if (selected && method === "qr_promptpay" && promptpayId && grandTotal > 0) {
    try {
      payload = buildPromptPayPayload({ recipientId: promptpayId, amount: grandTotal });
    } catch {
      payload = null;
    }
  }
  const qrReady = method !== "qr_promptpay" || (!!payload && qrPaymentVerified);

  function resetPay() {
    setMethod("cash");
    setReceived("");
    setQrPaymentVerified(false);
  }

  /** พิมพ์บิลของโต๊ะ — ใบแจ้งยอด (unpaid + QR ชำระ) หรือใบเสร็จรับเงิน (paid) */
  async function printBill(bill: TableBill, mode: TableBillPrintMode) {
    setPrintMsg(null);
    setIsPrinting(true);
    try {
      const data = buildTableBillReceipt(bill, receiptSettings, storeName, mode);
      await printReceiptWithFallback({
        printers,
        preferredPrinterId,
        escpos: data,
        browser: data,
      });
      setPrintMsg(mode.status === "unpaid" ? "พิมพ์ใบแจ้งยอดแล้ว" : "พิมพ์ใบเสร็จรับเงินแล้ว");
    } catch (e) {
      setPrintMsg(e instanceof Error ? `พิมพ์ไม่สำเร็จ: ${e.message}` : "พิมพ์ไม่สำเร็จ");
    } finally {
      setIsPrinting(false);
    }
  }

  function settleTable() {
    if (!selected) return;
    // snapshot ก่อนยิง action — หลังชำระสำเร็จรายการจะหายจากลิสต์ แต่ต้องใช้พิมพ์ใบเสร็จ
    const billSnapshot = selected;
    const tableLabel = selected.tableNumber;
    const paidReceived = method === "cash" ? (receivedNum || billSnapshot.grandTotal) : undefined;
    const paidChange =
      method === "cash" ? Math.max(0, (receivedNum || billSnapshot.grandTotal) - billSnapshot.grandTotal) : undefined;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await settleWholeTableAction(selected.tableId, method, {
        qrPaymentVerified: method === "qr_promptpay" ? qrPaymentVerified : undefined,
      });
      if (res.error) {
        setError(res.error);
        load();
        return;
      }
      onSettled();
      setSelectedTableId(null);
      resetPay();
      setNotice(
        `เช็คบิลโต๊ะ ${tableLabel} ครบแล้ว (${res.settledCount} บิล · ${fmt(res.total, currency)})${
          res.closed ? " · คืนโต๊ะว่างแล้ว" : ""
        }`,
      );
      load();
      // พิมพ์ใบเสร็จรับเงินอัตโนมัติหลังเช็คบิล (best-effort — พังแค่โชว์ข้อความ ไม่กระทบการชำระ)
      await printBill(billSnapshot, {
        status: "paid",
        method,
        receivedAmount: paidReceived,
        changeAmount: paidChange,
      });
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={isPending ? undefined : onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-base font-bold text-gray-900">
            {selected ? `เช็คบิลรวมโต๊ะ ${selected.tableNumber}` : "เช็คบิลโต๊ะ (รวมทั้งโต๊ะ)"}
          </h2>
          <button onClick={onClose} className="min-h-9 min-w-9 text-gray-400">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          {notice && !selected && (
            <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
          )}
          {printMsg && (
            <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-700" aria-live="polite">
              {printMsg}
            </p>
          )}

          {selected ? (
            <div className="space-y-3">
              {/* Breakdown */}
              {selected.qrOrders.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-400">ออร์เดอร์ QR</p>
                  <ul className="space-y-1 text-sm">
                    {selected.qrOrders.map((o) => (
                      <li key={o.id} className="flex justify-between text-gray-600">
                        <span>#{o.orderNumber} · {o.items.length} รายการ</span>
                        <span>{fmt(o.total, currency)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.tickets.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-400">ตั๋ว POS (พักบิล)</p>
                  <ul className="space-y-1 text-sm">
                    {selected.tickets.map((t) => (
                      <li key={t.id} className="flex justify-between text-gray-600">
                        <span>{t.label} · {t.itemCount} รายการ</span>
                        <span>{fmt(t.total, currency)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex justify-between border-t border-gray-100 pt-2 text-base font-bold text-gray-900">
                <span>ยอดรวมทั้งโต๊ะ</span>
                <span>{fmt(grandTotal, currency)}</span>
              </div>

              <button
                onClick={() => void printBill(selected, { status: "unpaid" })}
                disabled={isPending || isPrinting}
                className="w-full min-h-11 rounded-lg border border-gray-300 bg-white text-sm font-semibold text-gray-700 active:bg-gray-50 disabled:opacity-50"
              >
                {isPrinting ? "กำลังพิมพ์..." : "🖨️ พิมพ์ใบแจ้งยอด (มี QR ให้สแกนจ่าย)"}
              </button>

              {onAddItems && (
                <button
                  onClick={() => onAddItems(selected.tableId, selected.tableNumber)}
                  disabled={isPending}
                  className="w-full min-h-11 rounded-lg border border-teal-300 bg-teal-50 text-sm font-semibold text-teal-700 active:bg-teal-100 disabled:opacity-50"
                >
                  ➕ เพิ่มรายการเข้าโต๊ะ (ส่งเข้าครัว)
                </button>
              )}

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
                    placeholder={String(grandTotal)}
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                  />
                  {receivedNum > 0 && (
                    <p className="mt-1 text-xs text-gray-500">เงินทอน {fmt(Math.max(0, change), currency)}</p>
                  )}
                </div>
              ) : payload ? (
                <div className="flex flex-col items-center gap-2 py-2">
                  <QrCode value={payload} size={190} />
                  <p className="text-sm font-semibold text-gray-700">ให้ลูกค้าสแกนชำระ {fmt(grandTotal, currency)}</p>
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
                <button
                  onClick={() => { setSelectedTableId(null); setError(null); resetPay(); }}
                  disabled={isPending}
                  className="btn-secondary min-h-11 flex-1 text-sm"
                >
                  ย้อนกลับ
                </button>
                <Button
                  variant="primary"
                  loading={isPending}
                  loadingText="กำลังชำระ..."
                  onClick={settleTable}
                  disabled={!cashReady || !qrReady || (method === "qr_promptpay" && !payload)}
                  className="min-h-11 flex-1 text-sm disabled:opacity-40"
                >
                  ชำระรวมทั้งโต๊ะ
                </Button>
              </div>
            </div>
          ) : loading ? (
            <p className="py-8 text-center text-sm text-gray-400">กำลังโหลด...</p>
          ) : selectedTableId ? (
            /* เปิดมาที่โต๊ะที่ยังไม่มีบิล (เช่น เพิ่งเปิดโต๊ะ ลูกค้าไม่สะดวกสแกน QR) */
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-gray-500">
                โต๊ะ{initialTableNumber ? ` ${initialTableNumber}` : "นี้"}ยังไม่มีบิลค้างชำระ
              </p>
              {onAddItems && (
                <button
                  onClick={() => onAddItems(selectedTableId, initialTableNumber ?? "-")}
                  className="mx-auto block min-h-11 w-full max-w-xs rounded-lg border border-teal-300 bg-teal-50 text-sm font-semibold text-teal-700 active:bg-teal-100"
                >
                  ➕ เพิ่มรายการเข้าโต๊ะ (ส่งเข้าครัว)
                </button>
              )}
              <button
                onClick={() => setSelectedTableId(null)}
                className="mx-auto block min-h-10 text-xs text-gray-400 hover:text-gray-600"
              >
                ดูบิลโต๊ะอื่น
              </button>
            </div>
          ) : bills.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">ไม่มีบิลค้างชำระ</p>
          ) : (
            <ul className="space-y-2">
              {bills.map((b) => (
                <li key={b.tableId}>
                  <button
                    onClick={() => { setSelectedTableId(b.tableId); setError(null); resetPay(); }}
                    className="flex w-full items-center justify-between rounded-xl border border-gray-200 p-3 text-left active:bg-gray-50"
                  >
                    <span>
                      <span className="block text-sm font-bold text-gray-900">โต๊ะ {b.tableNumber}</span>
                      <span className="block text-xs text-gray-400">
                        {b.qrOrders.length > 0 && `${b.qrOrders.length} ออร์เดอร์ QR`}
                        {b.qrOrders.length > 0 && b.tickets.length > 0 && " · "}
                        {b.tickets.length > 0 && `${b.tickets.length} ตั๋วพักบิล`}
                      </span>
                    </span>
                    <span className="text-sm font-bold text-gray-900">{fmt(b.grandTotal, currency)}</span>
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

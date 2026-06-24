"use client";

import { useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { CashSession } from "@/modules/cashflow/types";
import { openCashSessionAction, closeCashSessionAction } from "./cash-actions";

interface Props {
  session: CashSession | null;
  /** POS cash collected since the session opened (preview of expected drawer). */
  cashSalesPreview: number;
  currency: string;
  forceOpenPrompt?: boolean;
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function CashSessionPanel({ session, cashSalesPreview, currency, forceOpenPrompt = false }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<"open" | "close" | null>(() => forceOpenPrompt && !session ? "open" : null);
  const [floatInput, setFloatInput] = useState("");
  const [countInput, setCountInput] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CashSession | null>(null);
  const [isPending, startTransition] = useTransition();

  const expectedCash = session ? session.openingFloat + cashSalesPreview : 0;
  const countNum = parseFloat(countInput);
  const variancePreview = !isNaN(countNum) ? countNum - expectedCash : null;
  const forcedOpen = forceOpenPrompt && !session;

  function close(force = false) {
    if (!force && forcedOpen && modal === "open") return;
    setModal(null);
    setError(null);
    setFloatInput("");
    setCountInput("");
    setNote("");
    setResult(null);
  }

  function handleOpen() {
    setError(null);
    const amount = parseFloat(floatInput);
    if (isNaN(amount) || amount < 0) {
      setError("กรุณากรอกยอดเงินเปิดร้าน");
      return;
    }
    startTransition(async () => {
      const res = await openCashSessionAction(amount, note);
      if (res.error) {
        setError(res.error);
        return;
      }
      close(true);
      router.refresh();
    });
  }

  function handleClose() {
    if (!session) return;
    setError(null);
    const amount = parseFloat(countInput);
    if (isNaN(amount) || amount < 0) {
      setError("กรุณากรอกยอดเงินที่นับได้");
      return;
    }
    startTransition(async () => {
      const res = await closeCashSessionAction(session.id, amount, note);
      if (res.error) {
        setError(res.error);
        return;
      }
      setResult(res.session);
      router.refresh();
    });
  }

  return (
    <>
      {session ? (
        <button
          type="button"
          onClick={() => setModal("close")}
          className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
          title={`เปิดรอบเมื่อ ${new Date(session.openedAt).toLocaleString("th-TH")}`}
          aria-label="ปิดรอบเงินสด"
        >
          🟢 <span className="hidden sm:inline">ปิดรอบเงินสด</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setModal("open")}
          className="btn-secondary min-h-11 shrink-0 px-3 text-xs"
          aria-label="เปิดรอบเงินสด"
        >
          💰 <span className="hidden sm:inline">เปิดรอบเงินสด</span>
        </button>
      )}

      {modal && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={isPending || forcedOpen ? undefined : () => close()} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            {/* Close result screen */}
            {result ? (
              <div className="text-center">
                <h2 className="text-lg font-bold text-gray-900">ปิดรอบเงินสดแล้ว</h2>
                <dl className="mt-4 space-y-2 text-left text-sm">
                  <Row label="เงินเปิดร้าน" value={formatMoney(result.openingFloat, currency)} />
                  <Row label="ยอดขายเงินสด (POS)" value={formatMoney(result.cashSales ?? 0, currency)} />
                  <Row label="เงินที่ควรมี" value={formatMoney(result.expectedCash ?? 0, currency)} />
                  <Row label="เงินที่นับได้" value={formatMoney(result.closingCount ?? 0, currency)} />
                  <div className="my-2 border-t border-gray-100" />
                  <Row
                    label="ส่วนต่าง"
                    value={formatMoney(result.variance ?? 0, currency)}
                    highlight={
                      (result.variance ?? 0) === 0
                        ? "ok"
                        : (result.variance ?? 0) > 0
                          ? "over"
                          : "short"
                    }
                  />
                </dl>
                <button onClick={() => close()} className="btn-primary mt-5 min-h-11 w-full text-sm">
                  เสร็จสิ้น
                </button>
              </div>
            ) : modal === "open" ? (
              <>
                <h2 className="text-lg font-bold text-gray-900">เปิดรอบเงินสด</h2>
                <p className="mt-1 text-xs text-gray-500">
                  {forcedOpen
                    ? "ต้องเปิดรอบเงินสดก่อนเริ่มรับเงินสดใน POS วันนี้"
                    : "บันทึกเงินสดตั้งต้นในลิ้นชัก (opening float)"}
                </p>
                <label className="mt-4 block text-sm font-medium text-gray-700">
                  เงินเปิดร้าน
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    autoFocus
                    value={floatInput}
                    onChange={(e) => setFloatInput(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none"
                  />
                </label>
                <label className="mt-3 block text-sm font-medium text-gray-700">
                  หมายเหตุ (ไม่บังคับ)
                  <input
                    type="text"
                    value={note}
                    maxLength={200}
                    onChange={(e) => setNote(e.target.value)}
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none"
                  />
                </label>
                {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
                <div className="mt-5 flex gap-2">
                  {!forcedOpen && (
                    <button onClick={() => close()} disabled={isPending} className="btn-secondary min-h-11 flex-1 text-sm">
                      ยกเลิก
                    </button>
                  )}
                  <button onClick={handleOpen} disabled={isPending} className="btn-primary min-h-11 flex-1 text-sm">
                    {isPending ? "กำลังเปิด..." : "เปิดรอบ"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-bold text-gray-900">ปิดรอบเงินสด</h2>
                <p className="mt-1 text-xs text-gray-500">นับเงินสดในลิ้นชักแล้วกระทบยอดกับ POS</p>
                <dl className="mt-4 space-y-2 text-sm">
                  <Row label="เงินเปิดร้าน" value={formatMoney(session?.openingFloat ?? 0, currency)} />
                  <Row label="ยอดขายเงินสด (POS)" value={formatMoney(cashSalesPreview, currency)} />
                  <Row label="เงินที่ควรมี" value={formatMoney(expectedCash, currency)} />
                </dl>
                <label className="mt-4 block text-sm font-medium text-gray-700">
                  เงินที่นับได้จริง
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    autoFocus
                    value={countInput}
                    onChange={(e) => setCountInput(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none"
                  />
                </label>
                {variancePreview !== null && (
                  <p
                    className={`mt-2 text-sm font-medium ${
                      variancePreview === 0
                        ? "text-green-600"
                        : variancePreview > 0
                          ? "text-blue-600"
                          : "text-red-600"
                    }`}
                  >
                    ส่วนต่าง: {formatMoney(variancePreview, currency)}
                    {variancePreview > 0 ? " (เกิน)" : variancePreview < 0 ? " (ขาด)" : " (พอดี)"}
                  </p>
                )}
                <label className="mt-3 block text-sm font-medium text-gray-700">
                  หมายเหตุ (ไม่บังคับ)
                  <input
                    type="text"
                    value={note}
                    maxLength={200}
                    onChange={(e) => setNote(e.target.value)}
                    className="mt-1 w-full min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none"
                  />
                </label>
                {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
                <div className="mt-5 flex gap-2">
                  <button onClick={() => close()} disabled={isPending} className="btn-secondary min-h-11 flex-1 text-sm">
                    ยกเลิก
                  </button>
                  <button onClick={handleClose} disabled={isPending} className="btn-primary min-h-11 flex-1 text-sm">
                    {isPending ? "กำลังปิด..." : "ปิดรอบ"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "ok" | "over" | "short";
}) {
  const color =
    highlight === "ok"
      ? "text-green-600"
      : highlight === "over"
        ? "text-blue-600"
        : highlight === "short"
          ? "text-red-600"
          : "text-gray-900";
  return (
    <div className="flex items-center justify-between">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`font-semibold ${color}`}>{value}</dd>
    </div>
  );
}

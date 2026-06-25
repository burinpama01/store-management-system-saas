"use client";

import { useRouter } from "next/navigation";
import { useActionState, useTransition, useState } from "react";
import type { Transaction, AccountingCategory, TransactionType } from "@/modules/accounting/types";
import type { CashflowSummary } from "@/modules/accounting/types";
import { ModalDialog, Button } from "@/shared/components/ui";
import {
  createAccountingCategoryAction,
  createTransactionAction,
  deleteTransactionAction,
} from "./actions";

const TYPE_LABEL: Record<TransactionType, string> = {
  income: "รายรับ",
  expense: "รายจ่าย",
  cash_adjustment: "ปรับเงินสด",
};

const TYPE_COLOR: Record<TransactionType, string> = {
  income: "bg-green-100 text-green-800",
  expense: "bg-red-100 text-red-800",
  cash_adjustment: "bg-yellow-100 text-yellow-800",
};

function fmt(n: number) {
  return n.toLocaleString("th-TH", { minimumFractionDigits: 2 });
}

interface Props {
  storeId: string;
  canManage: boolean;
  canRecord: boolean;
  canViewTotals: boolean;
  initialTransactions: Transaction[];
  totalCount: number;
  categories: AccountingCategory[];
  summary: CashflowSummary;
  cashBalance: number;
  dateFrom: string;
  dateTo: string;
  typeFilter: string;
  page: number;
}

export function AccountingManager({
  canManage,
  canRecord,
  canViewTotals,
  initialTransactions,
  totalCount,
  categories,
  summary,
  cashBalance,
  dateFrom,
  dateTo,
  typeFilter,
  page,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);

  // Filter state (local before submit)
  const [localDateFrom, setLocalDateFrom] = useState(dateFrom);
  const [localDateTo, setLocalDateTo] = useState(dateTo);
  const [localType, setLocalType] = useState(typeFilter);

  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  function applyFilters() {
    const params = new URLSearchParams({
      dateFrom: localDateFrom,
      dateTo: localDateTo,
      type: localType,
      page: "1",
    });
    startTransition(() => router.push(`/accounting?${params}`));
  }

  function goToPage(p: number) {
    const params = new URLSearchParams({
      dateFrom,
      dateTo,
      type: typeFilter,
      page: String(p),
    });
    startTransition(() => router.push(`/accounting?${params}`));
  }

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("ลบรายการนี้? ระบบจะสร้างรายการยกเลิกในบัญชีเงินสด")) return;
    setDeletingId(id);
    setDeleteError(null);
    const result = await deleteTransactionAction(id);
    setDeletingId(null);
    if (result.error) {
      setDeleteError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="page-shell">
      <h1 className="text-xl font-semibold text-gray-900">บัญชี / รายรับ-จ่าย</h1>

      {/* Summary strip — รายรับ/รายจ่าย/กำไร-ขาดทุน เป็นข้อมูลระดับ manager+; ต่ำกว่านั้นเห็นเฉพาะเงินสดในลิ้นชัก */}
      <div className={`grid gap-3 ${canViewTotals ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1"}`}>
        {canViewTotals && (
          <>
            <SummaryCard label="รายรับ (เลือก)" value={summary.totalIncome} color="text-green-600" />
            <SummaryCard label="รายจ่าย (เลือก)" value={summary.totalExpense} color="text-red-600" />
            <SummaryCard
              label="กำไร/ขาดทุน"
              value={summary.netCashflow}
              color={summary.netCashflow >= 0 ? "text-green-600" : "text-red-600"}
            />
          </>
        )}
        <SummaryCard label="เงินสดปัจจุบัน" value={cashBalance} color="text-blue-600" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {(canRecord || canManage) && (
          <>
            <div className="xl:col-span-1 space-y-3">
              {canRecord && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="font-medium text-gray-800 mb-2">เพิ่มรายการ</h2>
                  <p className="mb-4 text-sm text-gray-500">
                    เพิ่มรายรับหรือรายจ่ายผ่าน dialog เพื่อไม่เบียดพื้นที่ตารางรายการ
                  </p>
                  <button
                    type="button"
                    onClick={() => setEntryDialogOpen(true)}
                    className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                  >
                    เพิ่มรายการ
                  </button>
                </div>
              )}

              {canManage && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="font-medium text-gray-800 mb-2">หมวดหมู่รายรับ-จ่าย</h2>
                  <p className="mb-3 text-sm text-gray-500">
                    ใช้กับการบันทึกรายรับรายจ่ายและยอดขาย POS
                  </p>
                  <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
                    <CategoryCount
                      label="รายรับ"
                      value={categories.filter((category) => category.type === "income").length}
                      color="text-green-700"
                    />
                    <CategoryCount
                      label="รายจ่าย"
                      value={categories.filter((category) => category.type === "expense").length}
                      color="text-red-700"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setCategoryDialogOpen(true)}
                    className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    เพิ่มหมวดหมู่
                  </button>
                </div>
              )}
            </div>

            {entryDialogOpen && (
              <AccountingEntryDialog
                categories={categories}
                onClose={() => setEntryDialogOpen(false)}
                onSaved={() => {
                  setEntryDialogOpen(false);
                  router.refresh();
                }}
              />
            )}

            {categoryDialogOpen && (
              <AccountingCategoryDialog
                onClose={() => setCategoryDialogOpen(false)}
                onSaved={() => {
                  setCategoryDialogOpen(false);
                  router.refresh();
                }}
              />
            )}
          </>
        )}

        {/* Transaction table (right columns) */}
        <div className={`${canRecord || canManage ? "xl:col-span-2" : "xl:col-span-3"} space-y-3`}>
          {/* Filter bar */}
          <div className="bg-white rounded-lg border border-gray-200 p-3 flex flex-wrap gap-2 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">ตั้งแต่</label>
              <input
                type="date"
                value={localDateFrom}
                onChange={(e) => setLocalDateFrom(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ถึง</label>
              <input
                type="date"
                value={localDateTo}
                onChange={(e) => setLocalDateTo(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ประเภท</label>
              <select
                value={localType}
                onChange={(e) => setLocalType(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm"
              >
                <option value="all">ทั้งหมด</option>
                <option value="income">รายรับ</option>
                <option value="expense">รายจ่าย</option>
                {canManage && <option value="cash_adjustment">ปรับเงินสด</option>}
              </select>
            </div>
            <button
              onClick={applyFilters}
              disabled={isPending}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? "กำลังโหลด..." : "ค้นหา"}
            </button>
          </div>

          {deleteError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {deleteError}
            </p>
          )}

          {/* Table */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">วันที่</th>
                  <th className="px-3 py-2 text-left">ประเภท</th>
                  <th className="px-3 py-2 text-left">หมวดหมู่</th>
                  <th className="px-3 py-2 text-left">หมายเหตุ</th>
                  <th className="px-3 py-2 text-right">จำนวน</th>
                  {canManage && <th className="px-3 py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {initialTransactions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canManage ? 6 : 5}
                      className="px-3 py-8 text-center text-gray-400"
                    >
                      ไม่มีรายการในช่วงเวลานี้
                    </td>
                  </tr>
                ) : (
                  initialTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{tx.date}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLOR[tx.type]}`}
                        >
                          {TYPE_LABEL[tx.type]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{tx.categoryName}</td>
                      <td className="px-3 py-2 text-gray-500 truncate max-w-[160px]">
                        {tx.note ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium tabular-nums ${
                          tx.type === "income" ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {tx.type === "income" ? "+" : "-"}
                        {fmt(tx.amount)}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => handleDelete(tx.id)}
                            disabled={deletingId === tx.id}
                            className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-40 transition-colors"
                          >
                            {deletingId === tx.id ? "กำลังลบ..." : "ลบ"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-gray-500">
              <span>
                {totalCount} รายการ / หน้า {page} จาก {totalPages}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => goToPage(page - 1)}
                  disabled={page <= 1 || isPending}
                  className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  ก่อนหน้า
                </button>
                <button
                  onClick={() => goToPage(page + 1)}
                  disabled={page >= totalPages || isPending}
                  className="px-2 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  ถัดไป
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountingEntryDialog({
  categories,
  onClose,
  onSaved,
}: {
  categories: AccountingCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [addType, setAddType] = useState<"income" | "expense">("income");
  const filteredCats = categories.filter((c) => c.type === addType);
  const [formState, formAction, isPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const result = await createTransactionAction(prev, fd);
      if (!result.error) onSaved();
      return result;
    },
    { error: null },
  );

  return (
    <ModalDialog
      open
      title="เพิ่มรายการบัญชี"
      onClose={onClose}
      size="md"
    >
      <div className="flex border border-gray-200 rounded overflow-hidden">
        {(["income", "expense"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setAddType(t)}
            className={`flex-1 py-1.5 text-sm font-medium transition-colors ${
              addType === t
                ? t === "income"
                  ? "bg-green-600 text-white"
                  : "bg-red-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <form action={formAction} className="space-y-3">
        <input type="hidden" name="type" value={addType} />

        <div>
          <label className="block text-xs text-gray-500 mb-1">วันที่</label>
          <input
            type="date"
            name="date"
            defaultValue={new Date().toISOString().split("T")[0]}
            required
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">หมวดหมู่</label>
          <select
            name="categoryId"
            required
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">เลือกหมวดหมู่</option>
            {filteredCats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">จำนวนเงิน (บาท)</label>
          <input
            type="number"
            name="amount"
            min="0.01"
            step="0.01"
            required
            placeholder="0.00"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">หมายเหตุ</label>
          <input
            type="text"
            name="note"
            maxLength={200}
            placeholder="(ไม่บังคับ)"
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {formState.error && (
          <p className="text-xs text-red-600">{formState.error}</p>
        )}

        <Button
          type="submit"
          loading={isPending}
          className={`w-full py-2 text-sm font-medium text-white rounded transition-colors ${
            addType === "income"
              ? "bg-green-600 hover:bg-green-700"
              : "bg-red-600 hover:bg-red-700"
          }`}
        >
          บันทึก{TYPE_LABEL[addType]}
        </Button>
      </form>
    </ModalDialog>
  );
}

function AccountingCategoryDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryType, setCategoryType] = useState<"income" | "expense">("income");
  const [formState, formAction, isPending] = useActionState(
    async (prev: { error: string | null }, fd: FormData) => {
      const result = await createAccountingCategoryAction(prev, fd);
      if (!result.error) onSaved();
      return result;
    },
    { error: null },
  );

  return (
    <ModalDialog
      open
      title="เพิ่มหมวดหมู่"
      onClose={onClose}
      size="sm"
    >
      <div className="flex border border-gray-200 rounded overflow-hidden">
        {(["income", "expense"] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setCategoryType(type)}
            className={`flex-1 py-1.5 text-sm font-medium transition-colors ${
              categoryType === type
                ? type === "income"
                  ? "bg-green-600 text-white"
                  : "bg-red-600 text-white"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      <form action={formAction} className="space-y-3">
        <input type="hidden" name="categoryType" value={categoryType} />

        <div>
          <label className="block text-xs text-gray-500 mb-1">ชื่อหมวดหมู่</label>
          <input
            type="text"
            name="categoryName"
            maxLength={60}
            required
            placeholder={categoryType === "income" ? "เช่น ค่าส่ง / รายรับอื่น" : "เช่น วัตถุดิบ / ค่าแรง"}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {formState.error && (
          <p className="text-xs text-red-600">{formState.error}</p>
        )}

        <Button
          type="submit"
          loading={isPending}
          className={`w-full py-2 text-sm font-medium text-white rounded transition-colors ${
            categoryType === "income"
              ? "bg-green-600 hover:bg-green-700"
              : "bg-red-600 hover:bg-red-700"
          }`}
        >
          บันทึกหมวด{TYPE_LABEL[categoryType]}
        </Button>
      </form>
    </ModalDialog>
  );
}

function CategoryCount({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5">
      <span className="block text-gray-500">{label}</span>
      <span className={`font-semibold tabular-nums ${color}`}>{value} หมวด</span>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${color}`}>฿{fmt(value)}</p>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import type { PayoutMethod, SettleCycle, Supplier, SupplierInput } from "@/modules/inventory/types";
import { branchLabel } from "@/shared/utils/thai-tax-id";
import { saveSupplierAction } from "../inventory-actions";

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";

interface Draft {
  id: string | null;
  name: string;
  taxId: string;
  branchCode: string;
  contactName: string;
  phone: string;
  lineId: string;
  address: string;
  note: string;
  leadDays: string;
  paymentTermsDays: string;
  isActive: boolean;
  payoutMethod: PayoutMethod;
  payoutAccount: string;
  settleCycle: SettleCycle;
}

const EMPTY: Draft = {
  id: null,
  name: "",
  taxId: "",
  branchCode: "",
  contactName: "",
  phone: "",
  lineId: "",
  address: "",
  note: "",
  leadDays: "1",
  paymentTermsDays: "0",
  isActive: true,
  payoutMethod: "cash",
  payoutAccount: "",
  settleCycle: "restock",
};

const PAYOUT_LABEL: Record<PayoutMethod, string> = { cash: "รับเงินสด", transfer: "รับโอน" };
const CYCLE_LABEL: Record<SettleCycle, string> = { daily: "เคลียร์ทุกวันตอนปิดรอบ", restock: "เคลียร์ตอนเติมของ" };

type SaveSupplier = (input: SupplierInput) => Promise<{ error: string | null }>;

function toDraft(s: Supplier): Draft {
  return {
    id: s.id,
    name: s.name,
    taxId: s.taxId ?? "",
    branchCode: s.branchCode ?? "",
    contactName: s.contactName ?? "",
    phone: s.phone ?? "",
    lineId: s.lineId ?? "",
    address: s.address ?? "",
    note: s.note ?? "",
    leadDays: String(s.leadDays),
    paymentTermsDays: String(s.paymentTermsDays),
    isActive: s.isActive,
    payoutMethod: s.payoutMethod,
    payoutAccount: s.payoutAccount ?? "",
    settleCycle: s.settleCycle,
  };
}

export function SuppliersManager({
  suppliers,
  canEdit,
  saveAction = saveSupplierAction,
  showConsignment = false,
}: {
  suppliers: Supplier[];
  canEdit: boolean;
  /** หน้าฝากขายส่งแอ็กชันของตัวเอง (ด่านสิทธิ์ Enterprise) */
  saveAction?: SaveSupplier;
  /** แสดง/ส่งช่องฝากขาย (วิธีรับเงิน + รอบเคลียร์) */
  showConsignment?: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function field<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function save() {
    if (!draft) return;
    startTransition(async () => {
      const result = await saveAction({
        id: draft.id,
        name: draft.name,
        taxId: draft.taxId || null,
        branchCode: draft.branchCode || null,
        contactName: draft.contactName || null,
        phone: draft.phone || null,
        lineId: draft.lineId || null,
        address: draft.address || null,
        note: draft.note || null,
        leadDays: Number(draft.leadDays),
        paymentTermsDays: Number(draft.paymentTermsDays),
        isActive: draft.isActive,
        consignment: showConsignment
          ? { payoutMethod: draft.payoutMethod, payoutAccount: draft.payoutAccount || null, settleCycle: draft.settleCycle }
          : null,
      });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({ tone: "ok", text: `บันทึก ${draft.name.trim()} แล้ว` });
      setDraft(null);
    });
  }

  return (
    <div className="space-y-4">
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}

      {canEdit && !draft && (
        <button type="button" className="btn-primary min-h-11" onClick={() => { setMessage(null); setDraft(EMPTY); }}>
          + เพิ่มผู้ขาย
        </button>
      )}

      {draft && (
        <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">{draft.id ? "แก้ผู้ขาย" : "เพิ่มผู้ขาย"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm sm:col-span-2">
              <span className="text-[var(--muted)]">ชื่อร้าน/บริษัท *</span>
              <input className={inputClass} maxLength={120} value={draft.name} onChange={(e) => field("name", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">เลขประจำตัวผู้เสียภาษี (ถ้ามี)</span>
              <input className={inputClass} inputMode="numeric" maxLength={17} value={draft.taxId} onChange={(e) => field("taxId", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">เลขสาขา (00000 = สำนักงานใหญ่)</span>
              <input className={inputClass} inputMode="numeric" maxLength={5} value={draft.branchCode} onChange={(e) => field("branchCode", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">ผู้ติดต่อ</span>
              <input className={inputClass} maxLength={120} value={draft.contactName} onChange={(e) => field("contactName", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">โทร</span>
              <input className={inputClass} inputMode="tel" maxLength={40} value={draft.phone} onChange={(e) => field("phone", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-[var(--muted)]">LINE ID</span>
              <input className={inputClass} maxLength={80} value={draft.lineId} onChange={(e) => field("lineId", e.target.value)} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-[var(--muted)]">วันรอของ</span>
                <input className={inputClass} inputMode="numeric" value={draft.leadDays} onChange={(e) => field("leadDays", e.target.value)} />
              </label>
              <label className="block text-sm">
                <span className="text-[var(--muted)]">เครดิต (วัน)</span>
                <input className={inputClass} inputMode="numeric" value={draft.paymentTermsDays} onChange={(e) => field("paymentTermsDays", e.target.value)} />
              </label>
            </div>
            <label className="block text-sm sm:col-span-2">
              <span className="text-[var(--muted)]">ที่อยู่ (ใช้ในรายงานภาษีซื้อ)</span>
              <textarea className={`${inputClass} min-h-20 py-2`} maxLength={500} value={draft.address} onChange={(e) => field("address", e.target.value)} />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="text-[var(--muted)]">หมายเหตุ</span>
              <input className={inputClass} maxLength={500} value={draft.note} onChange={(e) => field("note", e.target.value)} />
            </label>
            {showConsignment && (
              <fieldset className="space-y-3 rounded-lg border border-[var(--border)] p-3 sm:col-span-2">
                <legend className="px-1 text-sm font-semibold text-[var(--ink)]">ฝากขาย: การจ่ายเงินเจ้าของ</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">วิธีรับเงิน</span>
                    <select className={inputClass} value={draft.payoutMethod} onChange={(e) => field("payoutMethod", e.target.value as PayoutMethod)}>
                      <option value="cash">เงินสด (ตัดจากลิ้นชัก)</option>
                      <option value="transfer">โอน</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">รอบเคลียร์เงิน</span>
                    <select className={inputClass} value={draft.settleCycle} onChange={(e) => field("settleCycle", e.target.value as SettleCycle)}>
                      <option value="restock">ตอนเจ้าของมาเติมของ</option>
                      <option value="daily">ทุกวันตอนปิดรอบเงินสด</option>
                    </select>
                  </label>
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-[var(--muted)]">พร้อมเพย์ / เลขบัญชี (ไว้ดูตอนโอน)</span>
                    <input className={inputClass} maxLength={120} value={draft.payoutAccount} onChange={(e) => field("payoutAccount", e.target.value)} />
                  </label>
                </div>
              </fieldset>
            )}
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => field("isActive", e.target.checked)} />
              ใช้งานอยู่
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={save}>บันทึก</button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setDraft(null)}>ยกเลิก</button>
          </div>
        </div>
      )}

      {suppliers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">ยังไม่มีผู้ขาย</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {suppliers.map((s) => (
            <li key={s.id} className={`flex flex-wrap items-center justify-between gap-3 p-3 ${s.isActive ? "" : "opacity-60"}`}>
              <div className="min-w-0">
                <p className="font-semibold text-[var(--ink)]">{s.name}{!s.isActive && " (ปิดใช้งาน)"}</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {(showConsignment
                    ? [PAYOUT_LABEL[s.payoutMethod], CYCLE_LABEL[s.settleCycle], s.phone, s.lineId ? `LINE ${s.lineId}` : null]
                    : [s.taxId ? `เลขผู้เสียภาษี ${s.taxId} ${branchLabel(s.branchCode)}` : "ไม่มีเลขผู้เสียภาษี", s.phone, `รอของ ${s.leadDays} วัน`, s.paymentTermsDays > 0 ? `เครดิต ${s.paymentTermsDays} วัน` : "จ่ายสด"])
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {canEdit && (
                <button type="button" className="btn-secondary min-h-10 text-sm" disabled={isPending} onClick={() => { setMessage(null); setDraft(toDraft(s)); }}>
                  แก้
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

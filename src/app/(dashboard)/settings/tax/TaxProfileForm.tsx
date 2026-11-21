"use client";

import { useState, useTransition } from "react";
import type { StoreTaxProfile } from "@/modules/tax/types";
import { saveTaxProfileAction } from "./actions";

const inputClass = "min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-[16px] text-gray-900";

export function TaxProfileForm({ profile }: { profile: StoreTaxProfile | null }) {
  const [form, setForm] = useState({
    legalName: profile?.legalName ?? "",
    taxId: profile?.taxId ?? "",
    branchCode: profile?.branchCode ?? "00000",
    address: profile?.address ?? "",
    vatRegistered: profile?.vatRegistered ?? false,
    vatRegisteredAt: profile?.vatRegisteredAt ?? "",
    posApprovalNo: profile?.posApprovalNo ?? "",
    pricesIncludeVat: profile?.pricesIncludeVat ?? true,
    vatRate: String(profile?.vatRate ?? 7),
  });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveTaxProfileAction({
        legalName: form.legalName,
        taxId: form.taxId,
        branchCode: form.branchCode,
        address: form.address,
        vatRegistered: form.vatRegistered,
        vatRegisteredAt: form.vatRegisteredAt || null,
        posApprovalNo: form.posApprovalNo || null,
        pricesIncludeVat: form.pricesIncludeVat,
        vatRate: Number(form.vatRate),
      });
      setMessage(result.error ? { tone: "error", text: result.error } : { tone: "ok", text: "บันทึกข้อมูลภาษีแล้ว" });
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="text-gray-600">ชื่อผู้ประกอบการ / นิติบุคคล (ตามใบ ภ.พ.20 หรือหนังสือรับรอง)</span>
          <input className={inputClass} maxLength={200} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">เลขประจำตัวผู้เสียภาษี 13 หลัก</span>
          <input className={inputClass} inputMode="numeric" maxLength={17} value={form.taxId} onChange={(e) => set("taxId", e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">เลขสาขา (สำนักงานใหญ่ = 00000)</span>
          <input className={inputClass} inputMode="numeric" maxLength={5} value={form.branchCode} onChange={(e) => set("branchCode", e.target.value)} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-gray-600">ที่อยู่ตามที่จดทะเบียน</span>
          <textarea className={`${inputClass} min-h-20 py-2`} maxLength={500} value={form.address} onChange={(e) => set("address", e.target.value)} />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={form.vatRegistered} onChange={(e) => set("vatRegistered", e.target.checked)} />
          จดทะเบียนภาษีมูลค่าเพิ่ม (VAT) แล้ว
        </label>
        {form.vatRegistered && (
          <>
            <label className="block text-sm">
              <span className="text-gray-600">วันที่จดทะเบียน VAT</span>
              <input type="date" className={inputClass} value={form.vatRegisteredAt} onChange={(e) => set("vatRegisteredAt", e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">อัตรา VAT (%)</span>
              <input className={inputClass} inputMode="decimal" value={form.vatRate} onChange={(e) => set("vatRate", e.target.value)} />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="text-gray-600">เลขอนุมัติเครื่องบันทึกการเก็บเงิน / POS ID (ภ.พ.06) — เว้นว่างถ้ายังไม่ได้รับอนุมัติ</span>
              <input className={inputClass} maxLength={60} value={form.posApprovalNo} onChange={(e) => set("posApprovalNo", e.target.value)} />
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={form.pricesIncludeVat} onChange={(e) => set("pricesIncludeVat", e.target.checked)} />
              ราคาขายรวม VAT แล้ว (ร้านอาหารส่วนใหญ่)
            </label>
          </>
        )}
      </div>
      <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={save}>
        บันทึกข้อมูลภาษี
      </button>
    </div>
  );
}

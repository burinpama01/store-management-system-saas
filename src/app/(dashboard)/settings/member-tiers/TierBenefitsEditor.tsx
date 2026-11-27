"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TierBenefit } from "@/modules/member-tiers/repository";
import { describeBenefit, validateTierBenefit, type TierDefinition } from "@/modules/member-tiers/rules";
import { saveTierBenefitsAction } from "./actions";

function blank(minRank: number): TierBenefit {
  return { id: "", minRank, name: "", discountType: "amount", discountValue: 20, minSubtotal: 0, usesPerMonth: 1, isActive: true };
}

/** สิทธิ์ตามระดับ = โค้ดพิเศษรายเดือน (แบบ Shopee) — ระบบสร้างคูปองให้ทุกสาขาทุกเดือน */
export function TierBenefitsEditor({ benefits, tiers }: { benefits: TierBenefit[]; tiers: TierDefinition[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<TierBenefit[]>(benefits);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const upper = tiers.filter((tier) => tier.rank > 0).sort((a, b) => a.rank - b.rank);
  const maxRank = upper.length ? upper[upper.length - 1].rank : 0;

  function update(index: number, patch: Partial<TierBenefit>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function save() {
    for (const row of rows) {
      const invalid = validateTierBenefit(row, maxRank);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    setError(null);
    startTransition(async () => {
      const result = await saveTierBenefitsAction(rows);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("บันทึกสิทธิ์แล้ว — โค้ดของเดือนนี้พร้อมใช้ทุกสาขา");
      router.refresh();
    });
  }

  if (upper.length === 0) return null;

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div>
        <p className="font-semibold text-gray-900">สิทธิ์ตามระดับ (โค้ดพิเศษรายเดือน)</p>
        <p className="text-xs text-gray-600">
          ระบบสร้างโค้ดส่วนลดใหม่ทุกต้นเดือนให้ทุกสาขา ใช้ได้เฉพาะสมาชิกที่ระดับถึงและยืนยันรหัส 5 นาทีที่ POS แล้ว ·
          ระดับสูงกว่าได้สิทธิ์ของระดับต่ำกว่าด้วย · ส่วนลดเปอร์เซ็นต์ยังไม่มีเพดาน ให้ตั้งยอดขั้นต่ำช่วยคุม
        </p>
      </div>
      {notice && <p className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-sm text-emerald-800">{notice}</p>}
      {rows.length === 0 && <p className="text-sm text-gray-500">ยังไม่มีสิทธิ์</p>}
      {rows.map((row, index) => (
        <div key={row.id || `new-${index}`} className="grid gap-2 rounded border border-gray-100 p-3 sm:grid-cols-6">
          <label className="text-xs sm:col-span-2">
            ชื่อสิทธิ์
            <input className="input mt-1 w-full" style={{ fontSize: 16 }} value={row.name} maxLength={80}
              placeholder="ส่วนลดสมาชิก Gold" onChange={(e) => update(index, { name: e.target.value })} />
          </label>
          <label className="text-xs">
            ตั้งแต่ระดับ
            <select className="input mt-1 w-full" style={{ fontSize: 16 }} value={row.minRank} onChange={(e) => update(index, { minRank: Number(e.target.value) })}>
              {upper.map((tier) => (
                <option key={tier.rank} value={tier.rank}>{tier.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            ส่วนลด
            <div className="mt-1 flex gap-1">
              <input className="input w-20" style={{ fontSize: 16 }} inputMode="decimal" value={String(row.discountValue)}
                onChange={(e) => update(index, { discountValue: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} />
              <select className="input" style={{ fontSize: 16 }} value={row.discountType} onChange={(e) => update(index, { discountType: e.target.value as "amount" | "percentage" })}>
                <option value="amount">บาท</option>
                <option value="percentage">%</option>
              </select>
            </div>
          </label>
          <label className="text-xs">
            ยอดขั้นต่ำ (บาท)
            <input className="input mt-1 w-full" style={{ fontSize: 16 }} inputMode="decimal" value={String(row.minSubtotal)}
              onChange={(e) => update(index, { minSubtotal: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} />
          </label>
          <label className="text-xs">
            ครั้ง/เดือน
            <input className="input mt-1 w-full" style={{ fontSize: 16 }} inputMode="numeric" value={String(row.usesPerMonth)}
              onChange={(e) => update(index, { usesPerMonth: Number(e.target.value.replace(/[^0-9]/g, "")) || 1 })} />
          </label>
          <div className="flex items-center justify-between gap-2 text-xs text-gray-500 sm:col-span-6">
            <span>{describeBenefit(row)} · ใช้ได้ {row.usesPerMonth} ครั้ง/เดือน</span>
            <button type="button" className="text-red-600 hover:underline" onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
              เอาออก
            </button>
          </div>
        </div>
      ))}
      {error && <p className="alert-danger text-sm" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary text-sm" disabled={rows.length >= 30} onClick={() => setRows((current) => [...current, blank(upper[0].rank)])}>
          + เพิ่มสิทธิ์
        </button>
        <button type="button" className="btn-primary text-sm" disabled={pending} onClick={save}>
          {pending ? "กำลังบันทึก…" : "บันทึกสิทธิ์"}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PassPlan } from "@/modules/prepaid-passes/types";
import { passUnitValue, validatePassPlanInput, type PassPlanInput } from "@/modules/prepaid-passes/rules";
import { savePassPlanAction } from "./actions";

interface MenuOption {
  id: string;
  name: string;
  price: number;
}

interface Draft {
  id: string | null;
  name: string;
  credits: string;
  price: string;
  validDays: string;
  noExpiry: boolean;
  redeemScope: "store" | "org";
  terms: string;
  productIds: string[];
  isActive: boolean;
}

function emptyDraft(defaultTerms: string): Draft {
  return {
    id: null,
    name: "",
    credits: "10",
    price: "",
    validDays: "90",
    noExpiry: false,
    redeemScope: "store",
    terms: defaultTerms,
    productIds: [],
    isActive: true,
  };
}

function draftFromPlan(plan: PassPlan): Draft {
  return {
    id: plan.id,
    name: plan.name,
    credits: String(plan.credits),
    price: String(plan.price),
    validDays: plan.validDays ? String(plan.validDays) : "90",
    noExpiry: plan.validDays === null,
    redeemScope: plan.redeemScope,
    terms: plan.terms,
    productIds: plan.productIds,
    isActive: plan.isActive,
  };
}

function toInput(draft: Draft): PassPlanInput {
  return {
    name: draft.name,
    credits: Number(draft.credits),
    price: Number(draft.price),
    validDays: draft.noExpiry ? null : Number(draft.validDays),
    redeemScope: draft.redeemScope,
    terms: draft.terms,
    productIds: draft.productIds,
    isActive: draft.isActive,
  };
}

const money = (value: number) => new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value);

export function PassPlanManager({
  plans,
  menu,
  defaultTerms,
}: {
  plans: PassPlan[];
  menu: MenuOption[];
  defaultTerms: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const menuById = new Map(menu.map((item) => [item.id, item]));

  function save() {
    if (!draft) return;
    const input = toInput(draft);
    const invalid = validatePassPlanInput(input);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await savePassPlanAction(draft.id, input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(draft.id ? "บันทึกแพ็กแล้ว" : "สร้างแพ็กแล้ว — สินค้าขายแพ็กอยู่ในหมวด แพ็กล่วงหน้า ของ POS");
      setDraft(null);
      router.refresh();
    });
  }

  function toggleProduct(id: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      productIds: draft.productIds.includes(id) ? draft.productIds.filter((x) => x !== id) : [...draft.productIds, id],
    });
  }

  const unit = draft ? passUnitValue(Number(draft.price) || 0, Number(draft.credits) || 0) : 0;
  const filteredMenu = menu.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}

      {!draft && (
        <button type="button" className="btn-primary" onClick={() => { setNotice(null); setDraft(emptyDraft(defaultTerms)); }}>
          + สร้างแพ็กใหม่
        </button>
      )}

      {draft && (
        <div className="space-y-4 rounded-lg border border-violet-200 bg-white p-4">
          <h2 className="text-lg font-bold text-gray-900">{draft.id ? "แก้แพ็ก" : "แพ็กใหม่"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-semibold text-gray-800">ชื่อแพ็ก (แสดงในเมนู POS และใบเสร็จ)</span>
              <input className="input mt-1 w-full" style={{ fontSize: 16 }} value={draft.name} maxLength={120}
                placeholder="แพ็กอเมริกาโน่ 10 แก้ว" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="font-semibold text-gray-800">จำนวนสิทธิ์</span>
                <input className="input mt-1 w-full" style={{ fontSize: 16 }} inputMode="numeric" value={draft.credits}
                  onChange={(e) => setDraft({ ...draft, credits: e.target.value.replace(/[^0-9]/g, "") })} />
              </label>
              <label className="block text-sm">
                <span className="font-semibold text-gray-800">ราคาแพ็ก (บาท)</span>
                <input className="input mt-1 w-full" style={{ fontSize: 16 }} inputMode="decimal" value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/[^0-9.]/g, "") })} />
              </label>
            </div>
          </div>
          {unit > 0 && <p className="text-sm text-gray-600">ตกสิทธิ์ละ ฿{money(unit)}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="text-sm">
              <span className="font-semibold text-gray-800">อายุแพ็ก</span>
              <div className="mt-1 flex items-center gap-2">
                <input className="input w-24" style={{ fontSize: 16 }} inputMode="numeric" disabled={draft.noExpiry}
                  value={draft.validDays} onChange={(e) => setDraft({ ...draft, validDays: e.target.value.replace(/[^0-9]/g, "") })} />
                <span>วันนับจากวันซื้อ</span>
              </div>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={draft.noExpiry} onChange={(e) => setDraft({ ...draft, noExpiry: e.target.checked })} />
                ไม่หมดอายุ
              </label>
            </div>
            <div className="text-sm">
              <span className="font-semibold text-gray-800">ใช้ที่สาขาไหนได้</span>
              <label className="mt-1 flex items-center gap-2">
                <input type="radio" checked={draft.redeemScope === "store"} onChange={() => setDraft({ ...draft, redeemScope: "store" })} />
                เฉพาะสาขานี้
              </label>
              <label className="mt-1 flex items-center gap-2">
                <input type="radio" checked={draft.redeemScope === "org"} onChange={() => setDraft({ ...draft, redeemScope: "org" })} />
                ทุกสาขา (เมนูต้องผูกเมนูข้ามสาขาไว้)
              </label>
            </div>
          </div>

          <div className="text-sm">
            <span className="font-semibold text-gray-800">เมนูที่ใช้แพ็กได้ ({draft.productIds.length} รายการ)</span>
            <p className="text-xs text-gray-500">เลือก 1 เมนู = แพ็กเมนูเดียว · หลายเมนู = ลูกค้าเลือกเมนูได้ตอนใช้ (นับ 1 สิทธิ์ต่อ 1 แก้ว/ชิ้น)</p>
            <input className="input mt-2 w-full" style={{ fontSize: 16 }} placeholder="ค้นเมนู" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mt-2 grid max-h-64 gap-1 overflow-y-auto rounded-lg border border-gray-200 p-2 sm:grid-cols-2">
              {filteredMenu.map((item) => (
                <label key={item.id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50">
                  <input type="checkbox" checked={draft.productIds.includes(item.id)} onChange={() => toggleProduct(item.id)} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="text-xs text-gray-500">฿{money(item.price)}</span>
                </label>
              ))}
              {filteredMenu.length === 0 && <p className="text-xs text-gray-500">ไม่พบเมนู</p>}
            </div>
          </div>

          <label className="block text-sm">
            <span className="font-semibold text-gray-800">เงื่อนไขแพ็ก (แสดงให้ลูกค้าก่อนซื้อ และเก็บสำเนาไว้กับแพ็กทุกใบ)</span>
            <textarea className="input mt-1 w-full" style={{ fontSize: 16 }} rows={8} value={draft.terms}
              onChange={(e) => setDraft({ ...draft, terms: e.target.value })} />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
            เปิดขาย (ปิดแล้วแพ็กที่ลูกค้าซื้อไว้ยังใช้ได้ตามปกติ)
          </label>

          {error && <p className="alert-danger text-sm" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={pending} onClick={save}>
              {pending ? "กำลังบันทึก…" : "บันทึก"}
            </button>
            <button type="button" className="btn-secondary" disabled={pending} onClick={() => { setDraft(null); setError(null); }}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {plans.length === 0 && !draft && <p className="text-sm text-gray-500">ยังไม่มีแพ็ก</p>}
        {plans.map((plan) => (
          <div key={plan.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4">
            <div className="min-w-0">
              <p className="font-semibold text-gray-900">
                🎟️ {plan.name} {!plan.isActive && <span className="ml-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">ปิดขาย</span>}
              </p>
              <p className="text-sm text-gray-600">
                {plan.credits} สิทธิ์ · ฿{money(plan.price)} (สิทธิ์ละ ฿{money(passUnitValue(plan.price, plan.credits))}) ·{" "}
                {plan.validDays ? `อายุ ${plan.validDays} วัน` : "ไม่หมดอายุ"} · {plan.redeemScope === "org" ? "ใช้ได้ทุกสาขา" : "เฉพาะสาขานี้"}
              </p>
              <p className="text-xs text-gray-500">
                เมนู: {plan.productIds.map((id) => menuById.get(id)?.name ?? "เมนูที่ปิดแล้ว").join(", ")}
              </p>
              <p className="text-xs text-gray-500">ขายแล้ว {plan.soldCount} แพ็ก</p>
            </div>
            <button type="button" className="btn-secondary text-sm" disabled={pending || draft !== null}
              onClick={() => { setNotice(null); setError(null); setDraft(draftFromPlan(plan)); }}>
              แก้ไข
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

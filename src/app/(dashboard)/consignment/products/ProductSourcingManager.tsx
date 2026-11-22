"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  SOURCING_LABEL,
  type ConsignPricing,
  type ResaleProduct,
  type SourcingMode,
  type StockLevel,
} from "@/modules/consignment/types";
import { unitEconomics } from "@/modules/consignment/validate";
import type { Supplier } from "@/modules/inventory/types";
import { saveProductSourcingAction } from "../operations-actions";
import { baht, inputClass } from "../ConsignmentChrome";

interface Draft {
  productId: string;
  mode: SourcingMode;
  supplierId: string;
  pricing: ConsignPricing;
  storePct: string;
  unitCost: string;
  optionGroupId: string;
  optionCosts: Record<string, string>;
}

function toDraft(p: ResaleProduct): Draft {
  const optionCosts: Record<string, string> = {};
  for (const g of p.groups) for (const o of g.options) optionCosts[o.id] = o.resaleUnitCost === null ? "" : String(o.resaleUnitCost);
  return {
    productId: p.id,
    mode: p.sourcingMode,
    supplierId: p.supplierId ?? "",
    pricing: p.consignPricing ?? "per_unit",
    storePct: p.consignStorePct === null ? "" : String(p.consignStorePct),
    unitCost: p.resaleUnitCost === null ? "" : String(p.resaleUnitCost),
    optionGroupId: p.resaleOptionGroupId ?? "",
    optionCosts,
  };
}

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

export function ProductSourcingManager({
  products,
  suppliers,
  stock,
  initialProductId,
}: {
  products: ResaleProduct[];
  suppliers: Supplier[];
  stock: StockLevel[];
  initialProductId: string | null;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "sourced">("sourced");
  const [query, setQuery] = useState("");
  const initial = initialProductId ? products.find((p) => p.id === initialProductId) : undefined;
  const [draft, setDraft] = useState<Draft | null>(initial ? toDraft(initial) : null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const supplierName = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);
  const onHand = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of stock) map.set(s.productId, (map.get(s.productId) ?? 0) + s.onHand);
    return map;
  }, [stock]);

  const sourcedCount = products.filter((p) => p.sourcingMode !== "made").length;
  const shown = products
    .filter((p) => (filter === "sourced" && sourcedCount > 0 ? p.sourcingMode !== "made" : true))
    .filter((p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const current = draft ? products.find((p) => p.id === draft.productId) : undefined;
  const group = current?.groups.find((g) => g.id === draft?.optionGroupId);

  function save() {
    if (!draft || !current) return;
    startTransition(async () => {
      const result = await saveProductSourcingAction({
        productId: draft.productId,
        mode: draft.mode,
        supplierId: draft.mode === "made" ? null : draft.supplierId || null,
        pricing: draft.mode === "consignment" ? draft.pricing : null,
        storePct: draft.mode === "consignment" && draft.pricing === "percent" ? numOrNull(draft.storePct) : null,
        unitCost: numOrNull(draft.unitCost),
        optionGroupId: draft.optionGroupId || null,
        optionCosts: group ? group.options.map((o) => ({ optionId: o.id, unitCost: numOrNull(draft.optionCosts[o.id] ?? "") })) : [],
      });
      if (result.error) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setMessage({
        tone: "ok",
        text:
          draft.mode === "made"
            ? `${current.name}: กลับเป็นทำเองแล้ว`
            : `${current.name}: บันทึกแล้ว${draft.optionGroupId ? " (ตั้งกลุ่มรสเป็น ต้องเลือก 1 ให้แล้ว)" : ""} — ต่อไปรับของที่แท็บ รับของ / เติมของ`,
      });
      setDraft(null);
      router.refresh();
    });
  }

  const price = current?.basePrice ?? 0;
  const econ = draft
    ? unitEconomics({
        price,
        mode: draft.mode,
        pricing: draft.mode === "consignment" ? draft.pricing : null,
        storePct: numOrNull(draft.storePct),
        unitCost: numOrNull(draft.unitCost),
      })
    : null;

  return (
    <div className="space-y-4">
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}
        </p>
      )}
      {suppliers.length === 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          ยังไม่มีเจ้าของสินค้า — เพิ่มที่แท็บ <Link href="/consignment" className="underline">ภาพรวม</Link> ก่อน
        </p>
      )}

      {draft && current && (
        <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-[var(--ink)]">{current.name}</h2>
            <span className="text-sm text-[var(--muted)]">ราคาขาย {baht(price)} บาท{onHand.get(current.id) ? ` · คงเหลือ ${onHand.get(current.id)} ชิ้น` : ""}</span>
          </div>
          <div>
            <p className="mb-1 text-sm text-[var(--muted)]">ที่มาของสินค้า</p>
            <div className="grid grid-cols-3 gap-2">
              {(["made", "resale", "consignment"] as SourcingMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={current.usesVariantStock && m !== "made"}
                  onClick={() => setDraft({ ...draft, mode: m })}
                  className={`min-h-12 rounded-lg border px-2 text-sm font-semibold ${draft.mode === m ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)] bg-white text-[var(--ink)]"} disabled:opacity-40`}
                >
                  {SOURCING_LABEL[m]}
                </button>
              ))}
            </div>
            {current.usesVariantStock && (
              <p className="mt-1 text-xs text-amber-800">เมนูนี้ใช้สต็อกแบบเดิม (นับสต็อก/Stock Pool) — ปิดที่หน้าเมนู/สต็อกก่อนจึงตั้งเป็นซื้อมาขายได้</p>
            )}
          </div>

          {draft.mode !== "made" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-[var(--muted)]">เจ้าของสินค้า *</span>
                <select className={inputClass} value={draft.supplierId} onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })}>
                  <option value="">เลือก</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              {draft.mode === "consignment" && (
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">วิธีคิดเงินกับเจ้าของ</span>
                  <select className={inputClass} value={draft.pricing} onChange={(e) => setDraft({ ...draft, pricing: e.target.value as ConsignPricing })}>
                    <option value="per_unit">ราคาต่อชิ้น (จ่ายเจ้าของชิ้นละเท่าไร)</option>
                    <option value="percent">หัก % จากราคาขาย (ร้านได้กี่ %)</option>
                  </select>
                </label>
              )}
              {draft.mode === "consignment" && draft.pricing === "percent" ? (
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">ร้านได้ (%)</span>
                  <input className={inputClass} inputMode="decimal" value={draft.storePct} onChange={(e) => setDraft({ ...draft, storePct: e.target.value })} />
                </label>
              ) : (
                <label className="block text-sm">
                  <span className="text-[var(--muted)]">{draft.mode === "resale" ? "ราคาซื้อต่อชิ้น" : "จ่ายเจ้าของต่อชิ้น"} (ค่าเริ่มต้น)</span>
                  <input className={inputClass} inputMode="decimal" value={draft.unitCost} onChange={(e) => setDraft({ ...draft, unitCost: e.target.value })} />
                </label>
              )}
              <label className="block text-sm">
                <span className="text-[var(--muted)]">นับสต็อกแยกรส (กลุ่มตัวเลือก)</span>
                <select className={inputClass} value={draft.optionGroupId} onChange={(e) => setDraft({ ...draft, optionGroupId: e.target.value })}>
                  <option value="">ไม่แยกรส (นับทั้งเมนู)</option>
                  {current.groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.options.length} ตัวเลือก)</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {draft.mode !== "made" && group && !(draft.mode === "consignment" && draft.pricing === "percent") && (
            <div className="space-y-2">
              <p className="text-sm text-[var(--muted)]">ราคาต่อชิ้นรายรส (เว้นว่าง = ใช้ค่าเริ่มต้นด้านบน)</p>
              <div className="overflow-hidden rounded-lg border border-[var(--border)]">
                {group.options.map((o) => {
                  const sell = price + o.priceAdjustment;
                  const cost = numOrNull(draft.optionCosts[o.id] ?? "") ?? numOrNull(draft.unitCost);
                  return (
                    <div key={o.id} className="grid grid-cols-[minmax(0,1fr)_110px_90px] items-center gap-2 border-b border-[var(--border)] p-2 last:border-b-0 text-sm">
                      <span>{o.name} <span className="text-xs text-[var(--muted)]">ขาย {baht(sell)}</span></span>
                      <input
                        aria-label={`ต่อชิ้น ${o.name}`}
                        className={`${inputClass} min-h-10`}
                        inputMode="decimal"
                        placeholder={draft.unitCost || "-"}
                        value={draft.optionCosts[o.id] ?? ""}
                        onChange={(e) => setDraft({ ...draft, optionCosts: { ...draft.optionCosts, [o.id]: e.target.value } })}
                      />
                      <span className={`text-right ${cost !== null && sell - cost < 0 ? "text-red-700" : "text-green-700"}`}>
                        {cost === null ? "-" : `กำไร ${baht(sell - cost)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-[var(--muted)]">บันทึกแล้วระบบตั้งกลุ่ม &quot;{group.name}&quot; เป็น ต้องเลือก 1 ให้อัตโนมัติ · รสที่ของหมดจะถูกซ่อนจาก POS เอง และกลับมาเมื่อรับของ</p>
            </div>
          )}

          {econ && econ.cost !== null && (
            <p className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-sm">
              ต่อชิ้น: ต้นทุน {baht(econ.cost)} · กำไร <span className={econ.profit !== null && econ.profit < 0 ? "font-semibold text-red-700" : "font-semibold text-green-700"}>{baht(econ.profit ?? 0)}</span>
              {econ.marginPct !== null ? ` (${econ.marginPct}%)` : ""}
            </p>
          )}

          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={save}>บันทึก</button>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={() => setDraft(null)}>ยกเลิก</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputClass} max-w-xs`} placeholder="ค้นหาเมนู" value={query} onChange={(e) => setQuery(e.target.value)} />
        {sourcedCount > 0 && (
          <div className="flex gap-1">
            {(["sourced", "all"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={`min-h-10 rounded-full border px-3 text-sm ${filter === f ? "border-[var(--tenant-primary)] bg-[var(--tenant-primary)] text-white" : "border-[var(--border)]"}`}>
                {f === "sourced" ? `ซื้อมาขาย/ฝากขาย (${sourcedCount})` : "ทุกเมนู"}
              </button>
            ))}
          </div>
        )}
      </div>

      <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        {shown.length === 0 && <li className="p-4 text-center text-sm text-[var(--muted)]">ไม่พบเมนู</li>}
        {shown.map((p) => (
          <li key={p.id} className={`flex flex-wrap items-center justify-between gap-2 p-3 ${p.isActive ? "" : "opacity-60"}`}>
            <div className="min-w-0">
              <p className="font-semibold text-[var(--ink)]">{p.name}</p>
              <p className="text-xs text-[var(--muted)]">
                {SOURCING_LABEL[p.sourcingMode]}
                {p.supplierId ? ` · ${supplierName.get(p.supplierId) ?? "เจ้าของที่ปิดใช้งาน"}` : ""}
                {p.sourcingMode === "consignment" ? (p.consignPricing === "percent" ? ` · ร้านได้ ${p.consignStorePct}%` : " · ราคาต่อชิ้น") : ""}
                {p.resaleOptionGroupId ? " · นับแยกรส" : ""}
                {onHand.get(p.id) ? ` · คงเหลือ ${onHand.get(p.id)}` : ""}
              </p>
            </div>
            <button type="button" className="btn-secondary min-h-10 text-sm" disabled={isPending} onClick={() => { setMessage(null); setDraft(toDraft(p)); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
              ตั้งค่า
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

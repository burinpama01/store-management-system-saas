"use client";

// U10 — Item card ของคิวครัว (v0.37.1)
// การ์ด 1 ใบ = 1 order_item พร้อมบริบทออร์เดอร์ (โต๊ะ/เวลา/source/version)
// ข้อมูลทุกอย่างเป็น view-model จาก server (UnifiedKitchenItem) — component ไม่เคยเดา state
// สถานะที่แสดงคือ effectiveItemState (U1: voided=true ชนะเสมอ — voided render แยกชัด)
// ปุ่ม action จะ disabled ขณะ transition กำลังค้าง (pending — กันกดซ้ำ/ดับเบิ้ล action)

import { effectiveItemState, type FulfillmentStatus } from "@/modules/unified-pos/contracts";
import {
  KITCHEN_STATE_BADGE_CLASS,
  KITCHEN_STATE_LABEL,
  kitchenOrderTimeAgo,
  kitchenSourceLabel,
  nextKitchenItemTransition,
  type UnifiedKitchenItem,
} from "./kitchen-types";

export interface KitchenItemCardProps {
  readonly item: UnifiedKitchenItem;
  /** transition กำลังค้างอยู่ (optimistic ยังไม่จบ) — ปิดปุ่ม กันกดซ้ำ */
  readonly pending: boolean;
  readonly onAdvance: (item: UnifiedKitchenItem, to: FulfillmentStatus) => void;
}

export function KitchenItemCard({ item, pending, onAdvance }: KitchenItemCardProps) {
  const state = effectiveItemState(item); // "voided" | fulfillment status
  const isVoided = state === "voided";
  const transition = nextKitchenItemTransition(item);
  const sourceLabel = kitchenSourceLabel(item.source);

  return (
    <li
      data-kitchen-item={item.itemId}
      data-kitchen-state={state}
      data-kitchen-version={item.fulfillmentVersion}
      className={`flex flex-col gap-2 rounded-xl border bg-white p-3 ${
        isVoided ? "border-gray-100 bg-gray-50 opacity-70" : "border-gray-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className={`min-w-0 truncate text-sm font-semibold ${
              isVoided ? "text-gray-400 line-through" : "text-gray-900"
            }`}
          >
            <span className="font-bold">{item.quantity}×</span> {item.productName}
            {item.variantName ? ` (${item.variantName})` : ""}
          </p>
          {item.note ? (
            <p className="mt-0.5 truncate text-xs italic text-gray-400">“{item.note}”</p>
          ) : null}
          {isVoided && item.voidedReason ? (
            <p className="mt-0.5 text-xs text-red-500">{item.voidedReason}</p>
          ) : null}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${KITCHEN_STATE_BADGE_CLASS[state]}`}
        >
          {KITCHEN_STATE_LABEL[state]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
        <span
          className={`rounded px-1.5 py-0.5 font-semibold ${
            item.source === "qr" ? "bg-sky-100 text-sky-700" : "bg-gray-100 text-gray-600"
          }`}
        >
          {sourceLabel}
        </span>
        <span>โต๊ะ {item.tableNumber ?? "—"}</span>
        <span>· {kitchenOrderTimeAgo(item.orderCreatedAt)}</span>
        <span className="ml-auto font-mono text-gray-400" title="fulfillment version (กันเขียนทับ)">
          v{item.fulfillmentVersion}
        </span>
      </div>

      {transition && !isVoided ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAdvance(item, transition.to)}
          aria-busy={pending}
          className={`min-h-10 w-full rounded-lg px-3 py-1.5 text-sm font-semibold border transition-colors motion-reduce:transition-none ${
            pending
              ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
              : "border-orange-500 bg-orange-500 text-white hover:bg-orange-600"
          }`}
        >
          {pending ? "กำลังบันทึก…" : transition.label}
        </button>
      ) : null}
    </li>
  );
}

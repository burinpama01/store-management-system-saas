"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";

/** ร้าน Enterprise ที่เปิดฝากขาย: หน้าแก้เมนูมีลิงก์ไปตั้ง "ซื้อมาขาย/รับฝากขาย" ของเมนูนั้น */
const ConsignmentLinkContext = createContext(false);

export function ConsignmentLinkProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <ConsignmentLinkContext.Provider value={enabled}>{children}</ConsignmentLinkContext.Provider>;
}

export function ConsignmentSourcingLink({ productId }: { productId: string }) {
  const enabled = useContext(ConsignmentLinkContext);
  if (!enabled) return null;
  return (
    <>
      <hr className="border-gray-100" />
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <span className="text-amber-900">ซื้อมาขาย / รับฝากขาย: ตั้งเจ้าของ ราคาต่อชิ้นรายรส และนับสต็อก</span>
        <Link href={`/consignment/products?product=${productId}`} className="font-semibold text-amber-900 underline">
          ตั้งค่า ›
        </Link>
      </div>
    </>
  );
}

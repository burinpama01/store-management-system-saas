"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import type { Product } from "@/modules/catalog/types";
import type { StockPoolLink, StockPoolView } from "@/modules/stock/pool-repository";
import { Button } from "@/shared/components/ui";
import { AddStockDialog } from "./AddStockDialog";
import { StockPoolCard } from "./StockPoolCard";
import { setStockAction, type StockState } from "./actions";

const INITIAL: StockState = { error: null, ok: false };
const LOW = 5;

export function StockManager({
  products,
  pools,
  links,
  canManageStock,
  canManageCatalog,
  stockDataError,
}: {
  products: Product[];
  pools: StockPoolView[];
  links: StockPoolLink[];
  canManageStock: boolean;
  canManageCatalog: boolean;
  stockDataError: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const router = useRouter();
  const linkedNames = (poolId: string) => links.filter((link) => link.stockPoolId === poolId).flatMap((link) => {
    for (const product of products) {
      const variant = product.variants.find((item) => item.id === link.variantId);
      if (variant) return [`${product.name} ${variant.name} (ตัด ${link.consumptionQuantity})`];
    }
    return [];
  });

  const activePools = pools.filter((pool) => pool.isActive);
  const linkedVariantIds = new Set(links.map((link) => link.variantId));
  // Variant ที่ยังไม่ผูก Pool ยังใช้สต๊อกรายตัวแบบเดิม — ต้องมีที่ให้แก้ ไม่งั้นข้อมูลเก่า
  // ที่ track_stock อยู่จะปรับจำนวนไม่ได้เลยหลังหน้านี้เปลี่ยนมาเป็น Pool
  const legacyRows = products.flatMap((product) =>
    product.variants
      .filter((variant) => variant.isActive && variant.trackStock && !linkedVariantIds.has(variant.id))
      .map((variant) => ({ productName: product.name, variant })),
  );

  return (
    <div className="page-shell space-y-6">
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="page-title">สต็อกสินค้า</h1>
          <p className="page-kicker">จัดการ Stock Pool และจำนวนคงเหลือ โดยไม่ต้องออกจากหน้านี้</p>
        </div>
        <Button variant="primary" onClick={() => setDialogOpen(true)} disabled={!canManageStock || stockDataError} className="min-h-11 w-full sm:w-auto">เพิ่มสต๊อกสินค้า</Button>
      </div>
      {!canManageStock && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">ไม่มีสิทธิ์จัดการสต๊อก</p>}
      {stockDataError && <div role="alert" className="flex flex-col gap-3 rounded-md bg-red-50 p-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between"><span>โหลดข้อมูลสินค้า หรือ Stock Pool ไม่สำเร็จ จึงยังไม่เปิดการเพิ่มหรือเชื่อมสต๊อกเพื่อป้องกันข้อมูลซ้ำ</span><Button variant="secondary" onClick={() => router.refresh()} className="min-h-11">ลองโหลดใหม่</Button></div>}

      <section aria-labelledby="stock-pools-heading" className="space-y-3">
        <div><h2 id="stock-pools-heading" className="text-base font-semibold text-[var(--ink)]">Stock Pool ที่ใช้งานอยู่</h2><p className="text-sm text-[var(--muted)]">ยอดสต๊อกกลางที่หลาย Variant ใช้ร่วมกันได้</p></div>
        {activePools.length === 0 ? <p className="panel p-4 text-sm text-[var(--muted)]">ยังไม่มี Stock Pool — เพิ่มผ่านปุ่ม “เพิ่มสต๊อกสินค้า”</p> : <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{activePools.map((pool) => <StockPoolCard key={pool.id} pool={pool} linkedItems={linkedNames(pool.id)} />)}</div>}
      </section>

      {legacyRows.length > 0 && (
        <section aria-labelledby="legacy-stock-heading" className="space-y-3">
          <div>
            <h2 id="legacy-stock-heading" className="text-base font-semibold text-[var(--ink)]">สต๊อกรายตัวเลือก (ยังไม่ได้ใช้ Stock Pool)</h2>
            <p className="text-sm text-[var(--muted)]">ตัวเลือกสินค้าที่ติดตามสต๊อกแบบเดิม · สีแดง = หมด, เหลือง = ใกล้หมด · ผูกเข้า Stock Pool ได้จากปุ่ม “เพิ่มสต๊อกสินค้า”</p>
          </div>
          <div className="panel overflow-x-auto p-0">
            <table className="min-w-[560px] w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                  <th className="px-4 py-3 font-bold">สินค้า</th>
                  <th className="px-4 py-3 font-bold">ตัวเลือก</th>
                  <th className="px-4 py-3 text-right font-bold">คงเหลือ</th>
                  {canManageStock && <th className="px-4 py-3 font-bold">ปรับจำนวน</th>}
                </tr>
              </thead>
              <tbody>
                {legacyRows.map(({ productName, variant }) => {
                  const qty = typeof variant.stockQuantity === "number" ? variant.stockQuantity : null;
                  const tone = qty == null
                    ? "text-[var(--muted)]"
                    : qty <= 0
                      ? "text-red-600"
                      : qty <= LOW
                        ? "text-amber-600"
                        : "text-[var(--ink)]";
                  return (
                    <tr key={variant.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-4 py-2 font-bold text-[var(--ink)]">{productName}</td>
                      <td className="px-4 py-2 text-[var(--ink-2)]">{variant.name}</td>
                      <td className={`px-4 py-2 text-right font-mono ${tone}`}>{qty ?? "—"}</td>
                      {canManageStock && (
                        <td className="px-4 py-2">
                          <StockRow variantId={variant.id} current={qty ?? 0} />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <AddStockDialog open={dialogOpen} onClose={() => setDialogOpen(false)} products={products} pools={pools} links={links} canManageStock={canManageStock} canManageCatalog={canManageCatalog} />
    </div>
  );
}

function StockRow({ variantId, current }: { variantId: string; current: number }) {
  const [state, action, pending] = useActionState(setStockAction, INITIAL);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="variantId" value={variantId} />
      <input
        type="number"
        name="quantity"
        defaultValue={current}
        min={0}
        step={1}
        className="form-input w-24 tabular-nums"
        aria-label="จำนวนคงเหลือ"
      />
      <Button type="submit" variant="secondary" loading={pending} loadingText="..." className="text-xs disabled:opacity-40">
        บันทึก
      </Button>
      {state.error && <span className="text-xs text-red-600">{state.error}</span>}
      {state.ok && <span className="text-xs text-emerald-700">✓</span>}
    </form>
  );
}

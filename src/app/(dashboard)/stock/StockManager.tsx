"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Product, ProductVariant } from "@/modules/catalog/types";
import type { StockPoolLink, StockPoolView } from "@/modules/stock/pool-repository";
import { Button } from "@/shared/components/ui";
import { AddStockDialog } from "./AddStockDialog";
import { StockPoolCard } from "./StockPoolCard";
import { removeFromStockAction, setStockAction, shareStockAction, type StockState } from "./actions";

const INITIAL: StockState = { error: null, ok: false };
const LOW = 5;

/**
 * แถวในตารางสต็อกแบบง่าย — ร้านไม่ต้องเห็นคำว่า Stock Pool
 * - own: นับสต็อกของตัวเอง (แบบเดิม)
 * - main: ใช้สต็อกร่วมและตัดครั้งละ 1 → แก้ยอดที่แถวนี้ = แก้ยอดกลาง
 * - shared: ตัดจากสินค้าอื่นครั้งละ N (เช่น โปร 3 ขวด) → คงเหลือ = ยอดกลาง ÷ N
 */
export type StockRowKind = "own" | "main" | "shared";
export interface StockRowView {
  variant: ProductVariant;
  productId: string;
  productName: string;
  label: string;
  kind: StockRowKind;
  quantity: number | null;
  pool: StockPoolView | null;
  consumption: number;
  sourceLabels: string[];
  siblingCount: number;
}

export function buildStockRows(
  products: Product[],
  pools: StockPoolView[],
  links: StockPoolLink[],
): StockRowView[] {
  const linkByVariant = new Map(links.map((link) => [link.variantId, link]));
  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  const labelByVariant = new Map<string, string>();
  for (const product of products) {
    for (const variant of product.variants) labelByVariant.set(variant.id, `${product.name} ${variant.name}`.trim());
  }
  const rows: StockRowView[] = [];
  for (const product of products) {
    const activeVariants = product.variants.filter((variant) => variant.isActive);
    for (const variant of activeVariants) {
      const link = linkByVariant.get(variant.id);
      if (!variant.trackStock && !link) continue;
      const pool = link ? poolById.get(link.stockPoolId) ?? null : null;
      const consumption = link?.consumptionQuantity ?? 1;
      const kind: StockRowKind = !link ? "own" : consumption === 1 ? "main" : "shared";
      const quantity = !link
        ? (typeof variant.stockQuantity === "number" ? variant.stockQuantity : null)
        : pool ? Math.floor(pool.quantity / consumption) : null;
      const sourceLabels = link
        ? links
            .filter((other) => other.stockPoolId === link.stockPoolId && other.consumptionQuantity === 1 && other.variantId !== variant.id)
            .map((other) => labelByVariant.get(other.variantId) ?? "")
            .filter(Boolean)
        : [];
      rows.push({
        variant,
        productId: product.id,
        productName: product.name,
        label: labelByVariant.get(variant.id) ?? product.name,
        kind,
        quantity,
        pool,
        consumption,
        sourceLabels,
        siblingCount: activeVariants.length,
      });
    }
  }
  return rows;
}

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
  const rows = useMemo(() => buildStockRows(products, pools, links), [products, pools, links]);
  // ตัวเลือกต้นทางของ "ตัดสต็อกจาก": แถวที่ขายทีละ 1 (นับเองหรือเป็นตัวหลักของสต็อกร่วม)
  const sourceOptions = rows.filter((row) => row.kind !== "shared");
  const trackedIds = new Set(rows.map((row) => row.variant.id));
  const untracked = products.flatMap((product) =>
    product.variants
      .filter((variant) => variant.isActive && !trackedIds.has(variant.id))
      .map((variant) => ({ id: variant.id, label: `${product.name} ${variant.name}`.trim() })),
  );

  const linkedNames = (poolId: string) => links.filter((link) => link.stockPoolId === poolId).flatMap((link) => {
    for (const product of products) {
      const variant = product.variants.find((item) => item.id === link.variantId);
      if (variant) return [`${product.name} ${variant.name} (ตัด ${link.consumptionQuantity})`];
    }
    return [];
  });
  const activePools = pools.filter((pool) => pool.isActive);
  const disabled = !canManageStock || stockDataError;

  return (
    <div className="page-shell space-y-6">
      <div className="page-header">
        <h1 className="page-title">สต็อกสินค้า</h1>
        <p className="page-kicker">ใส่จำนวนคงเหลือ แล้วกดบันทึก · ขายแล้วระบบตัดให้เอง</p>
      </div>
      {!canManageStock && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">ไม่มีสิทธิ์จัดการสต๊อก</p>}
      {stockDataError && <div role="alert" className="flex flex-col gap-3 rounded-md bg-red-50 p-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between"><span>โหลดข้อมูลสินค้าหรือสต็อกไม่สำเร็จ จึงยังไม่เปิดให้แก้ไขเพื่อป้องกันข้อมูลซ้ำ</span><Button variant="secondary" onClick={() => router.refresh()} className="min-h-11">ลองโหลดใหม่</Button></div>}

      <section aria-labelledby="stock-rows-heading" className="space-y-3">
        <div>
          <h2 id="stock-rows-heading" className="text-base font-semibold text-[var(--ink)]">สินค้าที่นับสต็อก</h2>
          <p className="text-sm text-[var(--muted)]">สีแดง = หมด (ขายไม่ได้), เหลือง = ใกล้หมด · โปรหลายชิ้น เช่น “3 ขวด” กด “ตัดสต็อกจาก” แล้วเลือกสินค้าเดี่ยว ระบบจะตัดจากยอดเดียวกัน</p>
        </div>
        {rows.length === 0 ? (
          <p className="panel p-4 text-sm text-[var(--muted)]">ยังไม่มีสินค้าที่นับสต็อก — เพิ่มได้จากช่องด้านล่าง</p>
        ) : (
          <div className="panel divide-y divide-[var(--border)] p-0">
            {rows.map((row) => (
              <StockRowItem
                key={row.variant.id}
                row={row}
                sourceOptions={sourceOptions.filter((option) => option.variant.id !== row.variant.id)}
                canManageStock={canManageStock && !stockDataError}
                canManageCatalog={canManageCatalog}
              />
            ))}
          </div>
        )}
        {canManageStock && untracked.length > 0 && <StartTrackingForm options={untracked} disabled={disabled} />}
      </section>

      <details className="panel p-4">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--ink)]">ตั้งค่าขั้นสูง (Stock Pool)</summary>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-[var(--muted)]">ยอดสต๊อกกลางที่หลาย Variant ใช้ร่วมกันได้ — ปกติไม่ต้องใช้ ระบบสร้างให้เองเมื่อกด “ตัดสต็อกจาก”</p>
          <Button variant="secondary" onClick={() => setDialogOpen(true)} disabled={!canManageStock || stockDataError} className="min-h-11 w-full sm:w-auto">เพิ่มสต๊อกสินค้า</Button>
          {activePools.length > 0 && <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{activePools.map((pool) => <StockPoolCard key={pool.id} pool={pool} linkedItems={linkedNames(pool.id)} />)}</div>}
        </div>
      </details>

      <AddStockDialog open={dialogOpen} onClose={() => setDialogOpen(false)} products={products} pools={pools} links={links} canManageStock={canManageStock} canManageCatalog={canManageCatalog} />
    </div>
  );
}

function quantityTone(qty: number | null): string {
  if (qty == null) return "text-[var(--muted)]";
  if (qty <= 0) return "text-red-600";
  if (qty <= LOW) return "text-amber-600";
  return "text-[var(--ink)]";
}

function StockRowItem({
  row,
  sourceOptions,
  canManageStock,
  canManageCatalog,
}: {
  row: StockRowView;
  sourceOptions: StockRowView[];
  canManageStock: boolean;
  canManageCatalog: boolean;
}) {
  const [mode, setMode] = useState<null | "share" | "remove">(null);
  // ยอดจอง QR: แถวนับเองอยู่ที่ variant, แถวสต็อกร่วมอยู่ที่ยอดกลาง
  const reserved = row.kind === "own"
    ? row.variant.reservedQuantity ?? 0
    : row.kind === "main" ? row.pool?.reservedUnits ?? 0 : 0;
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-[var(--ink)]">{row.productName} <span className="font-normal text-[var(--ink-2)]">· {row.variant.name}</span></p>
          {row.kind === "shared" && (
            <p className="text-xs text-[var(--muted)]">ตัดจาก {row.sourceLabels.join(", ") || "สต็อกร่วม"} ครั้งละ {row.consumption}{row.pool ? ` · ยอดกลาง ${row.pool.quantity}` : ""}</p>
          )}
          {row.kind === "main" && row.pool && (
            <p className="text-xs text-[var(--muted)]">ใช้ยอดร่วมกับโปร/ชุดที่ตัดจากสินค้านี้</p>
          )}
        </div>
        <div className={`text-right font-mono text-lg sm:w-24 ${quantityTone(row.quantity)}`}>
          {row.quantity ?? "—"}
          {row.kind === "shared" && <span className="block text-[11px] font-normal text-[var(--muted)]">ชุด</span>}
          {reserved > 0 && <span className="block text-[11px] font-normal text-amber-600">จอง {reserved} · พร้อมขาย {(row.quantity ?? 0) - reserved}</span>}
        </div>
        {canManageStock && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {row.kind === "shared" ? (
              <span className="text-xs text-[var(--muted)]">แก้ยอดที่สินค้าหลัก</span>
            ) : (
              <SetQuantityForm variantId={row.variant.id} current={row.kind === "main" ? row.pool?.quantity ?? 0 : row.quantity ?? 0} />
            )}
            {row.kind === "own" && sourceOptions.length > 0 && (
              <Button variant="secondary" className="min-h-11 text-xs" onClick={() => setMode(mode === "share" ? null : "share")}>ตัดสต็อกจาก…</Button>
            )}
            <Button variant="secondary" className="min-h-11 text-xs text-red-700" onClick={() => setMode(mode === "remove" ? null : "remove")}>ลบ</Button>
          </div>
        )}
      </div>
      {mode === "share" && <ShareForm row={row} sourceOptions={sourceOptions} onDone={() => setMode(null)} />}
      {mode === "remove" && <RemoveForm row={row} canManageCatalog={canManageCatalog} onCancel={() => setMode(null)} />}
    </div>
  );
}

function SetQuantityForm({ variantId, current }: { variantId: string; current: number }) {
  const [state, action, pending] = useActionState(setStockAction, INITIAL);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="variantId" value={variantId} />
      <input
        key={current}
        type="number"
        name="quantity"
        defaultValue={current}
        min={0}
        step={1}
        inputMode="numeric"
        className="form-input w-24 tabular-nums"
        style={{ fontSize: 16 }}
        aria-label="จำนวนคงเหลือ"
      />
      <Button type="submit" variant="secondary" loading={pending} loadingText="..." className="min-h-11 text-xs">บันทึก</Button>
      {state.error && <span role="alert" className="text-xs text-red-600">{state.error}</span>}
      {state.ok && !pending && <span className="text-xs text-emerald-700">✓</span>}
    </form>
  );
}

function ShareForm({ row, sourceOptions, onDone }: { row: StockRowView; sourceOptions: StockRowView[]; onDone: () => void }) {
  const [state, action, pending] = useActionState(shareStockAction, INITIAL);
  const guess = /(\d+)/.exec(row.variant.name)?.[1] ?? "1";
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);
  return (
    <form action={action} className="flex flex-col gap-2 rounded-md bg-[var(--surface-2,#f7f3ee)] p-3 sm:flex-row sm:items-end">
      <input type="hidden" name="targetVariantId" value={row.variant.id} />
      <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--muted)]">
        ขาย “{row.label}” 1 ครั้ง ตัดสต็อกจาก
        <select name="sourceVariantId" required className="form-input min-h-11" style={{ fontSize: 16 }} defaultValue="">
          <option value="" disabled>เลือกสินค้า</option>
          {sourceOptions.map((option) => (
            <option key={option.variant.id} value={option.variant.id}>{option.label} (เหลือ {option.kind === "main" ? option.pool?.quantity ?? 0 : option.quantity ?? 0})</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        จำนวนที่ตัด
        <input type="number" name="consumptionQuantity" min={1} step={1} defaultValue={guess} inputMode="numeric" className="form-input min-h-11 w-24" style={{ fontSize: 16 }} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={pending} loadingText="..." className="min-h-11">บันทึก</Button>
        <Button type="button" variant="secondary" onClick={onDone} className="min-h-11">ยกเลิก</Button>
      </div>
      {state.error && <p role="alert" className="text-xs text-red-600 sm:basis-full">{state.error}</p>}
    </form>
  );
}

function RemoveForm({ row, canManageCatalog, onCancel }: { row: StockRowView; canManageCatalog: boolean; onCancel: () => void }) {
  const [state, action, pending] = useActionState(removeFromStockAction, INITIAL);
  const canDeleteVariant = canManageCatalog && row.siblingCount > 1;
  return (
    <form action={action} className="space-y-2 rounded-md bg-red-50 p-3">
      <input type="hidden" name="variantId" value={row.variant.id} />
      <p className="text-sm text-red-800">ลบ “{row.label}” ออกจากรายการสต็อก? เมนูยังขายได้ตามปกติ แต่จะไม่นับจำนวนแล้ว</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="deleteVariant" value="0" variant="secondary" loading={pending} loadingText="..." className="min-h-11 text-red-700">เลิกนับสต็อก</Button>
        {canDeleteVariant && (
          <Button type="submit" name="deleteVariant" value="1" variant="secondary" loading={pending} loadingText="..." className="min-h-11 text-red-700">ลบตัวเลือก “{row.variant.name}” ออกจากเมนูด้วย</Button>
        )}
        <Button type="button" variant="secondary" onClick={onCancel} className="min-h-11">ยกเลิก</Button>
      </div>
      {state.error && <p role="alert" className="text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

function StartTrackingForm({ options, disabled }: { options: Array<{ id: string; label: string }>; disabled: boolean }) {
  const [state, action, pending] = useActionState(setStockAction, INITIAL);
  return (
    <form action={action} className="panel flex flex-col gap-2 p-3 sm:flex-row sm:items-end">
      <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--muted)]">
        เพิ่มสินค้าที่ต้องนับสต็อก
        <select name="variantId" required className="form-input min-h-11" style={{ fontSize: 16 }} defaultValue="">
          <option value="" disabled>เลือกสินค้า</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
        จำนวนคงเหลือ
        <input type="number" name="quantity" min={0} step={1} defaultValue={0} inputMode="numeric" className="form-input min-h-11 w-28" style={{ fontSize: 16 }} />
      </label>
      <Button type="submit" variant="primary" disabled={disabled} loading={pending} loadingText="..." className="min-h-11">เพิ่ม</Button>
      {state.error && <p role="alert" className="text-xs text-red-600 sm:basis-full">{state.error}</p>}
    </form>
  );
}

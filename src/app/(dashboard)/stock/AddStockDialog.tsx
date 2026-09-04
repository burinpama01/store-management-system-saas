"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Product, ProductVariant } from "@/modules/catalog/types";
import type { StockPoolLink, StockPoolView } from "@/modules/stock/pool-repository";
import { Button, ModalDialog } from "@/shared/components/ui";
import { adjustStockPoolAction, createStockPoolAndLinkVariantAction, createVariantFromStockAction, linkVariantToStockPoolAction } from "./actions";
import { StockPoolCard } from "./StockPoolCard";
import { StockPoolAdjustmentForm } from "./StockPoolAdjustmentForm";

export type AddStockStep = "choose_product" | "ensure_variant" | "choose_pool" | "adjust";

type ProductForStep = { id: string; variants: Array<Pick<ProductVariant, "id">> };
const MISSING_LINKED_POOL_ERROR = "โหลด Stock Pool ที่เชื่อมกับ Variant ไม่สำเร็จ";

export function createInitialAddStockDraft() {
  return {
    step: "choose_product" as AddStockStep,
    query: "",
    product: null as Product | null,
    variant: null as ProductVariant | null,
    pool: null as StockPoolView | null,
    consumptionQuantity: "1",
    newPool: { name: "", unitLabel: "ชิ้น", lowStockThreshold: "0" },
    error: null as string | null,
  };
}

export function resolveVariantStockPool<T extends { id: string }>(
  variantId: string,
  links: ReadonlyArray<Pick<StockPoolLink, "variantId" | "stockPoolId">>,
  pools: readonly T[],
): { ok: true; pool: T | null } | { ok: false; error: string } {
  const link = links.find((candidate) => candidate.variantId === variantId);
  if (!link) return { ok: true, pool: null };
  const pool = pools.find((candidate) => candidate.id === link.stockPoolId);
  return pool ? { ok: true, pool } : { ok: false, error: MISSING_LINKED_POOL_ERROR };
}

export function nextStockStep(product: ProductForStep, variantId?: string, poolId?: string): AddStockStep {
  if (!variantId || !product.variants.some((variant) => variant.id === variantId)) return "ensure_variant";
  return poolId ? "adjust" : "choose_pool";
}

export function validateConsumptionQuantity(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    return { ok: false, error: "จำนวนที่ตัดต้องเป็นจำนวนเต็มมากกว่า 0" };
  }
  return { ok: true, value: Number(raw) };
}

export function adjustmentPreview(current: number, mode: "receive" | "set_balance", quantity: number): string {
  return mode === "receive"
    ? `${current} + ${quantity} = ${current + quantity}`
    : `${current} → ${quantity} (ต่าง ${quantity - current >= 0 ? "+" : ""}${quantity - current})`;
}

function activeVariants(product: Product | null): ProductVariant[] {
  return product?.variants.filter((variant) => variant.isActive) ?? [];
}

export function AddStockDialog({
  open,
  onClose,
  products,
  pools,
  links,
  canManageStock,
  canManageCatalog,
}: {
  open: boolean;
  onClose: () => void;
  products: Product[];
  pools: StockPoolView[];
  links: StockPoolLink[];
  canManageStock: boolean;
  canManageCatalog: boolean;
}) {
  const initialDraft = createInitialAddStockDraft();
  const [step, setStep] = useState<AddStockStep>(initialDraft.step);
  const [query, setQuery] = useState(initialDraft.query);
  const [product, setProduct] = useState<Product | null>(initialDraft.product);
  const [variant, setVariant] = useState<ProductVariant | null>(initialDraft.variant);
  const [pool, setPool] = useState<StockPoolView | null>(initialDraft.pool);
  const [consumptionQuantity, setConsumptionQuantity] = useState(initialDraft.consumptionQuantity);
  const [newPool, setNewPool] = useState(initialDraft.newPool);
  const [error, setError] = useState<string | null>(initialDraft.error);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const stepFocusRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => stepFocusRef.current?.focus());
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [open, step]);

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? products.filter((item) => item.name.toLowerCase().includes(normalized)) : products;
  }, [products, query]);
  // ผูกใหม่ได้เฉพาะ Pool ที่เปิดใช้งาน แต่ `pools` ยังรวมตัวที่ปิดไว้ด้วย เพื่อให้
  // variant ที่ผูกกับ Pool ที่ถูกปิดไปแล้วยังเปิดหน้าปรับยอดได้ (ไม่กลายเป็นทางตัน)
  const selectablePools = useMemo(() => pools.filter((pool) => pool.isActive), [pools]);
  function closeAndReset() {
    const initial = createInitialAddStockDraft();
    setStep(initial.step); setQuery(initial.query); setProduct(initial.product); setVariant(initial.variant); setPool(initial.pool);
    setConsumptionQuantity(initial.consumptionQuantity); setNewPool(initial.newPool); setError(initial.error);
    onClose();
  }
  const safeClose = () => { if (!pending) closeAndReset(); };
  const linkedNames = (poolId: string) => links.filter((link) => link.stockPoolId === poolId).flatMap((link) => {
    for (const item of products) {
      const found = item.variants.find((candidate) => candidate.id === link.variantId);
      if (found) return [`${item.name} ${found.name} (ตัด ${link.consumptionQuantity})`];
    }
    return [];
  });

  function selectProduct(selected: Product) {
    setError(null); setProduct(selected); setVariant(null); setPool(null);
    setStep("ensure_variant");
  }

  function selectVariant(selected: ProductVariant) {
    setError(null); setVariant(selected);
    const resolvedPool = resolveVariantStockPool(selected.id, links, pools);
    if (!resolvedPool.ok) {
      setPool(null); setError(resolvedPool.error);
      return;
    }
    setPool(resolvedPool.pool);
    setStep(nextStockStep(product!, selected.id, resolvedPool.pool?.id));
  }

  function createVariant() {
    if (!product) return;
    const form = new FormData();
    const name = (document.getElementById("stock-variant-name") as HTMLInputElement | null)?.value ?? "";
    const price = (document.getElementById("stock-variant-price") as HTMLInputElement | null)?.value ?? "0";
    form.set("productId", product.id); form.set("variantName", name); form.set("priceAdjustment", price);
    startTransition(async () => {
      setError(null);
      const result = await createVariantFromStockAction(form);
      if (!result.ok) { setError(result.error); return; }
      setVariant(result.variant); setStep("choose_pool"); router.refresh();
    });
  }

  function linkPool(selectedPool: StockPoolView) {
    if (!variant) return;
    const consumption = validateConsumptionQuantity(consumptionQuantity);
    if (!consumption.ok) { setError(consumption.error); return; }
    const form = new FormData(); form.set("variantId", variant.id); form.set("poolId", selectedPool.id); form.set("consumptionQuantity", String(consumption.value));
    startTransition(async () => {
      setError(null);
      const result = await linkVariantToStockPoolAction(form);
      if (!result.ok) { setError(result.error); return; }
      setPool(selectedPool); setStep("adjust"); router.refresh();
    });
  }

  function createAndLinkPool() {
    if (!variant) return;
    const consumption = validateConsumptionQuantity(consumptionQuantity);
    if (!consumption.ok) { setError(consumption.error); return; }
    const form = new FormData();
    form.set("variantId", variant.id); form.set("name", newPool.name); form.set("unitLabel", newPool.unitLabel); form.set("lowStockThreshold", newPool.lowStockThreshold); form.set("consumptionQuantity", String(consumption.value));
    startTransition(async () => {
      setError(null);
      const created = await createStockPoolAndLinkVariantAction(form);
      if (!created.ok) { setError(created.error); return; }
      setPool(created.pool); setStep("adjust"); router.refresh();
    });
  }

  async function adjust(data: { mode: "receive" | "set_balance"; quantity: string; reason: string }) {
    if (!pool) return;
    const form = new FormData(); form.set("poolId", pool.id); form.set("mode", data.mode); form.set("quantity", data.quantity); form.set("reason", data.reason);
    startTransition(async () => {
      setError(null);
      const result = await adjustStockPoolAction({ ok: false, error: null }, form);
      if (!result.ok) { setError(result.error); return; }
      router.refresh(); closeAndReset();
    });
  }

  return (
    <ModalDialog open={open} title="เพิ่มสต๊อกสินค้า" description="เลือกสินค้า Variant และ Stock Pool เพื่อเพิ่มหรือกำหนดยอดสต๊อก โดยไม่ออกจากหน้านี้" size="lg" onClose={safeClose} closeLabel={pending ? "กำลังบันทึก" : "ปิด dialog เพิ่มสต๊อก"}>
      <fieldset disabled={pending} className="contents">
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {error === MISSING_LINKED_POOL_ERROR && <Button variant="secondary" onClick={() => router.refresh()} className="min-h-11">ลองโหลดใหม่</Button>}
      {step === "choose_product" && <section className="space-y-4">
        <h3 ref={stepFocusRef} tabIndex={-1} className="font-semibold outline-none">เลือกสินค้า</h3>
        <p className="text-sm text-[var(--muted)]">ค้นหาและเลือกสินค้าที่ต้องการตั้งสต๊อก โดยไม่ออกจากหน้านี้</p>
        <label className="block text-sm font-medium">ค้นหาสินค้า<input className="form-input mt-1 min-h-11 w-full" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></label>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {filteredProducts.map((item) => <button key={item.id} type="button" onClick={() => selectProduct(item)} className="min-h-11 w-full rounded-md border border-[var(--border)] p-3 text-left hover:border-teal-700"><strong>{item.name}</strong><span className="ml-2 text-xs text-[var(--muted)]">{activeVariants(item).length} Variant</span></button>)}
        </div>
      </section>}

      {step === "ensure_variant" && product && <section className="space-y-4">
        <h3 ref={stepFocusRef} tabIndex={-1} className="font-semibold outline-none">เลือกหรือสร้าง Variant</h3>
        <p className="rounded-md bg-teal-50 p-3 text-sm text-teal-950">Variant = รูปแบบย่อย/หน่วยขายของสินค้า เช่น <strong>1 ขวด</strong> และ <strong>3 ขวด</strong>; แต่ละ Variant มีราคา/หน่วยขายของตัวเอง.</p>
        {activeVariants(product).length > 0 && <div className="space-y-2"><p className="text-sm font-medium">เลือก Variant ที่จะตั้งสต๊อก</p>{activeVariants(product).map((item) => <button key={item.id} type="button" onClick={() => selectVariant(item)} className="min-h-11 w-full rounded-md border border-[var(--border)] p-3 text-left hover:border-teal-700">{item.name} <span className="text-xs text-[var(--muted)]">ราคาเพิ่ม {item.priceAdjustment}</span></button>)}</div>}
        {activeVariants(product).length === 0 && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">สินค้านี้ยังไม่มี Variant จึงต้องสร้างก่อนจึงจะตั้งสต๊อกได้</div>}
        {!canManageCatalog ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">ต้องมีสิทธิ์จัดการเมนูสินค้าและสต๊อก</p> : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-sm font-medium">ชื่อ Variant<input id="stock-variant-name" className="form-input mt-1 min-h-11 w-full" placeholder="เช่น 1 ขวด" /></label><label className="text-sm font-medium">ปรับราคา<input id="stock-variant-price" className="form-input mt-1 min-h-11 w-full" type="number" defaultValue="0" step="0.01" /></label><div className="sm:col-span-2"><Button variant="secondary" onClick={createVariant} loading={pending} loadingText="กำลังสร้าง Variant..." className="min-h-11">สร้าง Variant แล้วไปต่อ</Button></div></div>}
      </section>}

      {step === "choose_pool" && variant && <section className="space-y-4">
        <h3 ref={stepFocusRef} tabIndex={-1} className="font-semibold outline-none">เลือก Stock Pool</h3>
        <p className="rounded-md bg-teal-50 p-3 text-sm text-teal-950">Stock Pool คือยอดสต๊อกกลางที่หลาย Variant ใช้ร่วมกันได้ โดยขายแต่ละ Variant แล้วระบบจะตัดตามจำนวนที่ตั้งไว้</p>
        <p className="text-sm text-[var(--muted)]">หลาย Variant จากคนละสินค้าสามารถใช้ Stock Pool เดียวกันได้ แต่ Variant หนึ่งเชื่อมได้กับ Stock Pool เพียงหนึ่งรายการเท่านั้น</p>
        <label className="block text-sm font-medium">ขาย Variant นี้ 1 รายการ ตัดกี่หน่วยจาก Stock Pool<input className="form-input mt-1 min-h-11 w-full" type="number" inputMode="numeric" min={1} step={1} value={consumptionQuantity} onChange={(event) => setConsumptionQuantity(event.target.value)} /><span className="mt-1 block text-xs text-[var(--muted)]">ตัวอย่าง Singha 1 bottle ใช้ 1; Singha 3 bottles ใช้ 3</span></label>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-[var(--border)] p-4"><h3 className="font-semibold">สร้างสต๊อกกลางใหม่</h3><label className="block text-sm">ชื่อ Stock Pool<input className="form-input mt-1 min-h-11 w-full" value={newPool.name} onChange={(event) => setNewPool({ ...newPool, name: event.target.value })} /></label><label className="block text-sm">หน่วย<input className="form-input mt-1 min-h-11 w-full" value={newPool.unitLabel} onChange={(event) => setNewPool({ ...newPool, unitLabel: event.target.value })} /></label><label className="block text-sm">เตือนเมื่อเหลือ<input className="form-input mt-1 min-h-11 w-full" type="number" min={0} value={newPool.lowStockThreshold} onChange={(event) => setNewPool({ ...newPool, lowStockThreshold: event.target.value })} /></label><Button variant="secondary" onClick={createAndLinkPool} loading={pending} loadingText="กำลังสร้าง..." className="min-h-11">สร้างสต๊อกกลางใหม่</Button></div>
          <div className="space-y-3"><h3 className="font-semibold">ใช้สต๊อกกลางที่มีอยู่</h3>{selectablePools.length === 0 ? <p className="text-sm text-[var(--muted)]">ยังไม่มี Stock Pool ในร้านนี้</p> : selectablePools.map((item) => <StockPoolCard key={item.id} pool={item} linkedItems={linkedNames(item.id)} onSelect={() => linkPool(item)} />)}</div>
        </div>
      </section>}

      {step === "adjust" && pool && <section className="space-y-4"><h3 ref={stepFocusRef} tabIndex={-1} className="font-semibold outline-none">ปรับยอด Stock Pool</h3><StockPoolAdjustmentForm pool={pool} pending={pending} onSubmit={adjust} /></section>}
      {!canManageStock && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">ไม่มีสิทธิ์จัดการสต๊อก</p>}
      </fieldset>
    </ModalDialog>
  );
}

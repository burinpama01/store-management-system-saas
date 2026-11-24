"use server";

import { revalidatePath } from "next/cache";
import {
  AuthorizationError,
  getResolvedCurrentPermissions,
  requireFeature,
  requirePermission,
} from "@/modules/auth/guards";
import { createVariant, deleteVariant, getProduct } from "@/modules/catalog/repository";
import type { ProductVariant } from "@/modules/catalog/types";
import { adjustStockPool, createStockPoolAndLinkVariant, linkVariantToSourceVariant, linkVariantToStockPool, listStockPoolLinks, removeVariantFromStock, type StockPoolView } from "@/modules/stock/pool-repository";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { setVariantStock } from "@/modules/stock/repository";
import type { StockPoolAdjustmentMode } from "@/modules/stock/types";
import { logSystemEvent } from "@/modules/system/event-log";

/**
 * ทุกเส้นทางของ Stock Pool ต้องทิ้ง log ไว้ ทั้งสำเร็จและล้มเหลว (กฎประจำโปรเจกต์:
 * ฟีเจอร์ใหม่ห้าม "สำเร็จแบบเงียบ") — ยอดสต๊อกเป็นตัวเลขที่ร้านใช้ตรวจของจริง
 * ถ้าเพี้ยนแล้วไม่มีร่องรอยว่าใครปรับเมื่อไร จะไล่ย้อนไม่ได้เลย
 */
async function logStockPoolEvent(input: {
  action: string;
  ok: boolean;
  message: string;
  organizationId?: string | null;
  storeId?: string | null;
  actorUserId?: string | null;
  context?: Record<string, unknown>;
}): Promise<void> {
  await logSystemEvent({
    level: input.ok ? "info" : "warn",
    source: "stock.pool",
    action: input.action,
    message: input.message,
    organizationId: input.organizationId ?? null,
    storeId: input.storeId ?? null,
    actorUserId: input.actorUserId ?? null,
    context: input.context,
  });
}

export interface StockState {
  error: string | null;
  ok: boolean;
}

const INTEGER_QUANTITY_ERROR = "กรุณากรอกจำนวนเต็มตั้งแต่ 0 ขึ้นไป";
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MONEY_LIMIT = 9_999_999.99;

type StockActionResult = { ok: true; error: null } | { ok: false; error: string };
type PoolActionResult = { ok: true; pool: StockPoolView; error: null } | { ok: false; error: string };

function parseRawQuantity(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const quantity = Number(trimmed);
  return Number.isSafeInteger(quantity) && quantity <= POSTGRES_INTEGER_MAX ? quantity : null;
}

function parseAdjustmentMode(raw: FormDataEntryValue | null): StockPoolAdjustmentMode | null {
  return raw === "receive" || raw === "set_balance" ? raw : null;
}

function parsePositiveQuantity(raw: FormDataEntryValue | null): number | null {
  const quantity = parseRawQuantity(raw);
  return quantity !== null && quantity > 0 ? quantity : null;
}

function readTrimmed(fd: FormData, key: string): string {
  const value = fd.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof AuthorizationError ? "ต้องมีสิทธิ์จัดการเมนูสินค้าและสต๊อก" : fallback;
}

export async function createVariantFromStockAction(fd: FormData): Promise<{ ok: true; variant: ProductVariant; error: null } | { ok: false; error: string }> {
  try {
    await requirePermission("stock.manage");
    await requirePermission("catalog.manage");
    await requireFeature("stockManagement");
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage") || !resolved.can("catalog.manage")) return { ok: false, error: "ต้องมีสิทธิ์จัดการเมนูสินค้าและสต๊อก" };
    const productId = readTrimmed(fd, "productId");
    const name = readTrimmed(fd, "variantName");
    const rawPriceAdjustment = readTrimmed(fd, "priceAdjustment");
    const priceAdjustment = Number(rawPriceAdjustment);
    if (!productId || !name || !rawPriceAdjustment || !Number.isFinite(priceAdjustment) || Math.abs(priceAdjustment) > MONEY_LIMIT) {
      return { ok: false, error: "ข้อมูล Variant ไม่ถูกต้อง" };
    }
    const product = await getProduct(productId);
    if (!product.data || product.data.storeId !== ctx.storeId) return { ok: false, error: "ไม่มีสิทธิ์" };
    const created = await createVariant({ productId, name, priceAdjustment, trackStock: true, stockQuantity: 0 });
    if (created.error || !created.data) {
      await logStockPoolEvent({
        action: "createVariantFromStock", ok: false, message: "สร้าง Variant จากหน้าสต๊อกไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { productId, name, error: created.error?.message ?? null },
      });
      return { ok: false, error: "ไม่สามารถสร้าง Variant ได้" };
    }
    await logStockPoolEvent({
      action: "createVariantFromStock", ok: true, message: `สร้าง Variant "${name}" จากหน้าสต๊อก`,
      organizationId: ctx.organizationId, storeId: ctx.storeId,
      context: { productId, variantId: created.data.id },
    });
    revalidatePath("/stock");
    return { ok: true, variant: created.data, error: null };
  } catch (error) { return { ok: false, error: safeError(error, "ไม่สามารถสร้าง Variant ได้") }; }
}

export async function createStockPoolAndLinkVariantAction(fd: FormData): Promise<PoolActionResult> {
  try {
    await requirePermission("stock.manage");
    await requireFeature("stockManagement");
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการสต๊อก" };
    const name = readTrimmed(fd, "name");
    const unitLabel = readTrimmed(fd, "unitLabel");
    const variantId = readTrimmed(fd, "variantId");
    const lowStockThreshold = parseRawQuantity(fd.get("lowStockThreshold"));
    const consumptionQuantity = parsePositiveQuantity(fd.get("consumptionQuantity"));
    if (!name || !unitLabel || !variantId || lowStockThreshold === null || consumptionQuantity === null) return { ok: false, error: "ข้อมูล Stock Pool ไม่ถูกต้อง" };
    const created = await createStockPoolAndLinkVariant({ variantId, storeId: ctx.storeId, name, unitLabel, lowStockThreshold, consumptionQuantity });
    if (!created.ok) {
      await logStockPoolEvent({
        action: "createStockPool", ok: false, message: "สร้าง Stock Pool ไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { variantId, name, consumptionQuantity, error: created.error.message },
      });
      return { ok: false, error: "ไม่สามารถสร้าง Stock Pool ได้" };
    }
    await logStockPoolEvent({
      action: "createStockPool", ok: true, message: `สร้าง Stock Pool "${name}" และเชื่อมกับ Variant`,
      organizationId: ctx.organizationId, storeId: ctx.storeId,
      context: { poolId: created.data.id, variantId, unitLabel, lowStockThreshold, consumptionQuantity },
    });
    revalidatePath("/stock");
    return { ok: true, pool: created.data, error: null };
  } catch (error) { return { ok: false, error: safeError(error, "ไม่สามารถสร้าง Stock Pool ได้") }; }
}

export async function linkVariantToStockPoolAction(fd: FormData): Promise<StockActionResult> {
  try {
    await requirePermission("stock.manage");
    await requireFeature("stockManagement");
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการสต๊อก" };
    const variantId = readTrimmed(fd, "variantId");
    const poolId = readTrimmed(fd, "poolId");
    const consumptionQuantity = parsePositiveQuantity(fd.get("consumptionQuantity"));
    if (!variantId || !poolId || consumptionQuantity === null) return { ok: false, error: "จำนวนที่ตัดต้องเป็นจำนวนเต็มมากกว่า 0" };
    const linked = await linkVariantToStockPool({ variantId, poolId, storeId: ctx.storeId, consumptionQuantity });
    if (!linked.ok) {
      await logStockPoolEvent({
        action: "linkVariantToStockPool", ok: false, message: "เชื่อม Variant กับ Stock Pool ไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { variantId, poolId, consumptionQuantity, error: linked.error.message },
      });
      return { ok: false, error: "ไม่สามารถเชื่อม Stock Pool ได้" };
    }
    await logStockPoolEvent({
      action: "linkVariantToStockPool", ok: true, message: "เชื่อม Variant กับ Stock Pool แล้ว",
      organizationId: ctx.organizationId, storeId: ctx.storeId,
      context: { variantId, poolId, consumptionQuantity },
    });
    revalidatePath("/stock");
    return { ok: true, error: null };
  } catch (error) { return { ok: false, error: safeError(error, "ไม่สามารถเชื่อม Stock Pool ได้") }; }
}

export async function adjustStockPoolAction(_prev: StockState, fd: FormData): Promise<StockState> {
  try {
    await requirePermission("stock.manage");
    await requireFeature("stockManagement");
    const { ctx } = await getResolvedCurrentPermissions();

    const poolId = fd.get("poolId");
    const mode = parseAdjustmentMode(fd.get("mode"));
    const quantity = parseRawQuantity(fd.get("quantity"));
    const rawReason = fd.get("reason");
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";

    if (typeof poolId !== "string" || !poolId.trim()) {
      return { ok: false, error: "ไม่พบ Stock Pool" };
    }
    if (quantity === null) return { ok: false, error: INTEGER_QUANTITY_ERROR };
    if (!mode) return { ok: false, error: "โหมดการปรับสต็อกไม่ถูกต้อง" };
    if (mode === "receive" && quantity <= 0) {
      return { ok: false, error: "จำนวนรับเข้าต้องมากกว่า 0" };
    }
    if (mode === "set_balance" && !reason) {
      return { ok: false, error: "กรุณาระบุเหตุผลในการตั้งยอดคงเหลือ" };
    }

    const result = await adjustStockPool({
      poolId: poolId.trim(),
      storeId: ctx.storeId,
      mode,
      quantity,
      reason: reason || null,
    });
    if (!result.ok) {
      await logStockPoolEvent({
        action: "adjustStockPool", ok: false, message: "ปรับยอด Stock Pool ไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { poolId, mode, quantity, error: result.error?.message ?? null },
      });
      return { ok: false, error: result.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
    }
    await logStockPoolEvent({
      action: "adjustStockPool",
      ok: true,
      message: mode === "receive"
        ? `รับสต๊อกเข้า Pool ${quantity} หน่วย (คงเหลือ ${result.data?.quantity ?? "?"})`
        : `ตั้งยอด Pool เป็น ${quantity} หน่วย`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      context: { poolId: result.data?.id ?? poolId, mode, quantity, after: result.data?.quantity ?? null, reason: reason || null },
    });
    revalidatePath("/stock");
    return { ok: true, error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ไม่มีสิทธิ์" };
    return { ok: false, error: "ไม่สามารถปรับสต็อกได้" };
  }
}

export async function setStockAction(_prev: StockState, fd: FormData): Promise<StockState> {
  try {
    await requirePermission("stock.manage");
    await requireFeature("stockManagement");
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการสต็อก" };

    const variantId = (fd.get("variantId") as string | null) ?? "";
    const quantity = parseRawQuantity(fd.get("quantity"));
    if (!variantId) return { ok: false, error: "ไม่พบตัวเลือกสินค้า" };
    if (quantity === null) return { ok: false, error: INTEGER_QUANTITY_ERROR };

    // ตัวที่ใช้สต็อกร่วม: ตัวหลัก (ตัดครั้งละ 1) แก้ยอดกลางแทน, ตัวที่ตัดจากตัวอื่นแก้ยอดเองไม่ได้
    const links = await listStockPoolLinks(ctx.storeId, [variantId]);
    if (links.error) return { ok: false, error: "โหลดข้อมูลสต็อกไม่สำเร็จ" };
    const link = links.data[0];
    if (link) {
      if (link.consumptionQuantity !== 1) {
        return { ok: false, error: "สินค้านี้ตัดสต็อกจากสินค้าอื่น — แก้ยอดที่สินค้าหลัก" };
      }
      const adjusted = await adjustStockPool({
        poolId: link.stockPoolId, storeId: ctx.storeId, mode: "set_balance", quantity,
        reason: "ตั้งยอดจากหน้าสต็อก",
      });
      if (!adjusted.ok) {
        await logStockPoolEvent({
          action: "setSharedStock", ok: false, message: "ตั้งยอดสต็อกร่วมไม่สำเร็จ",
          organizationId: ctx.organizationId, storeId: ctx.storeId,
          context: { variantId, poolId: link.stockPoolId, quantity, error: adjusted.error.message },
        });
        return { ok: false, error: adjusted.error.userMessage ?? "บันทึกไม่สำเร็จ" };
      }
      await logStockPoolEvent({
        action: "setSharedStock", ok: true, message: `ตั้งยอดสต็อกร่วมเป็น ${quantity}`,
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { variantId, poolId: link.stockPoolId, quantity },
      });
      revalidatePath("/stock");
      return { ok: true, error: null };
    }

    const res = await setVariantStock(variantId, ctx.storeId, quantity);
    if (!res.ok) {
      await logStockPoolEvent({
        action: "setVariantStock", ok: false, message: "ตั้งยอดสต๊อกรายตัวเลือกไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { variantId, quantity, error: res.error?.message ?? null },
      });
      return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
    }
    await logStockPoolEvent({
      action: "setVariantStock", ok: true, message: `ตั้งยอดสต๊อกตัวเลือกสินค้าเป็น ${quantity}`,
      organizationId: ctx.organizationId, storeId: ctx.storeId,
      context: { variantId, quantity },
    });
    revalidatePath("/stock");
    return { ok: true, error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ไม่มีสิทธิ์" };
    throw e;
  }
}

/** แบบง่าย: "ตัดสต็อกจาก [สินค้าอื่น] × จำนวน" — ร้านไม่ต้องสร้าง Stock Pool เอง */
export async function shareStockAction(_prev: StockState, fd: FormData): Promise<StockState> {
  try {
    await requirePermission("stock.manage");
    await requireFeature("stockManagement");
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการสต็อก" };
    const targetVariantId = readTrimmed(fd, "targetVariantId");
    const sourceVariantId = readTrimmed(fd, "sourceVariantId");
    const consumptionQuantity = parsePositiveQuantity(fd.get("consumptionQuantity"));
    if (!targetVariantId || !sourceVariantId) return { ok: false, error: "เลือกสินค้าที่จะตัดสต็อกจาก" };
    if (consumptionQuantity === null) return { ok: false, error: "จำนวนที่ตัดต้องเป็นจำนวนเต็มมากกว่า 0" };
    const result = await linkVariantToSourceVariant({ targetVariantId, sourceVariantId, storeId: ctx.storeId, consumptionQuantity });
    if (!result.ok) {
      await logStockPoolEvent({
        action: "shareStock", ok: false, message: "ตั้งค่าตัดสต็อกจากสินค้าอื่นไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { targetVariantId, sourceVariantId, consumptionQuantity, error: result.error.message },
      });
      return { ok: false, error: result.error.userMessage ?? "ตั้งค่าตัดสต็อกไม่สำเร็จ" };
    }
    await logStockPoolEvent({
      action: "shareStock", ok: true, message: `ตั้งให้ตัดสต็อกจากสินค้าอื่นครั้งละ ${consumptionQuantity}`,
      organizationId: ctx.organizationId, storeId: ctx.storeId,
      context: { targetVariantId, sourceVariantId, consumptionQuantity, poolId: result.poolId },
    });
    revalidatePath("/stock");
    return { ok: true, error: null };
  } catch (error) { return { ok: false, error: safeError(error, "ตั้งค่าตัดสต็อกไม่สำเร็จ") }; }
}

/**
 * ปุ่มลบในหน้าสต็อก: เลิกนับสต็อกรายการนี้ (เมนูยังขายได้) และถ้าส่ง deleteVariant=1
 * จะลบตัวเลือกนี้ออกจากเมนูด้วย — ทำได้เฉพาะเมื่อสินค้ายังเหลือตัวเลือกอื่น
 */
export async function removeFromStockAction(_prev: StockState, fd: FormData): Promise<StockState> {
  try {
    await requirePermission("stock.manage");
    await requireFeature("stockManagement");
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการสต็อก" };
    const variantId = readTrimmed(fd, "variantId");
    const alsoDeleteVariant = readTrimmed(fd, "deleteVariant") === "1";
    if (!variantId) return { ok: false, error: "ไม่พบสินค้า" };
    if (alsoDeleteVariant && !resolved.can("catalog.manage")) {
      return { ok: false, error: "ต้องมีสิทธิ์จัดการเมนูจึงจะลบตัวเลือกออกจากเมนูได้" };
    }
    if (alsoDeleteVariant) {
      const owner = await countActiveSiblingVariants(variantId, ctx.storeId);
      if (!owner || owner.activeVariantCount <= 1) {
        return { ok: false, error: "สินค้านี้เหลือตัวเลือกเดียว ลบออกจากเมนูที่หน้าเมนูสินค้าแทน" };
      }
    }
    const removed = await removeVariantFromStock({ variantId, storeId: ctx.storeId });
    if (!removed.ok) {
      await logStockPoolEvent({
        action: "removeFromStock", ok: false, message: "ลบออกจากรายการสต็อกไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId,
        context: { variantId, alsoDeleteVariant, error: removed.error.message },
      });
      return { ok: false, error: removed.error.userMessage ?? "ลบไม่สำเร็จ" };
    }
    if (alsoDeleteVariant) {
      const deleted = await deleteVariant(variantId, ctx.storeId);
      if (!deleted.ok) {
        await logStockPoolEvent({
          action: "removeFromStock", ok: false, message: "เลิกนับสต็อกแล้ว แต่ลบตัวเลือกออกจากเมนูไม่สำเร็จ",
          organizationId: ctx.organizationId, storeId: ctx.storeId,
          context: { variantId, error: deleted.error?.message ?? null },
        });
        revalidatePath("/stock");
        return { ok: false, error: "เลิกนับสต็อกแล้ว แต่ลบตัวเลือกออกจากเมนูไม่สำเร็จ" };
      }
    }
    await logStockPoolEvent({
      action: "removeFromStock", ok: true,
      message: alsoDeleteVariant ? "ลบตัวเลือกออกจากเมนูและรายการสต็อก" : "เลิกนับสต็อกรายการนี้",
      organizationId: ctx.organizationId, storeId: ctx.storeId,
      context: { variantId, variantDeleted: alsoDeleteVariant },
    });
    revalidatePath("/stock");
    if (alsoDeleteVariant) revalidatePath("/catalog");
    return { ok: true, error: null };
  } catch (error) { return { ok: false, error: safeError(error, "ลบไม่สำเร็จ") }; }
}

async function countActiveSiblingVariants(variantId: string, storeId: string): Promise<{ activeVariantCount: number } | null> {
  const supabase = await createSupabaseServerClient();
  const { data: variant } = await supabase.from("product_variants").select("product_id").eq("id", variantId).maybeSingle();
  if (!variant) return null;
  const { data: product } = await supabase.from("products").select("store_id").eq("id", variant.product_id).maybeSingle();
  if (!product || product.store_id !== storeId) return null;
  const { count } = await supabase
    .from("product_variants")
    .select("id", { count: "exact", head: true })
    .eq("product_id", variant.product_id)
    .eq("is_active", true);
  return { activeVariantCount: count ?? 0 };
}

"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { setVariantStock } from "@/modules/stock/repository";

export interface StockState {
  error: string | null;
  ok: boolean;
}

export async function setStockAction(_prev: StockState, fd: FormData): Promise<StockState> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("stock.manage")) return { ok: false, error: "ไม่มีสิทธิ์จัดการสต็อก" };

    const variantId = (fd.get("variantId") as string | null) ?? "";
    const quantity = Number(fd.get("quantity"));
    if (!variantId) return { ok: false, error: "ไม่พบตัวเลือกสินค้า" };
    if (!Number.isFinite(quantity) || quantity < 0) return { ok: false, error: "จำนวนไม่ถูกต้อง" };

    const res = await setVariantStock(variantId, ctx.storeId, quantity);
    if (!res.ok) return { ok: false, error: res.error?.userMessage ?? "บันทึกไม่สำเร็จ" };
    revalidatePath("/stock");
    return { ok: true, error: null };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "ไม่มีสิทธิ์" };
    throw e;
  }
}

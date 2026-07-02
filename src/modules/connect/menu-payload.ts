// ฟังก์ชันบริสุทธิ์สำหรับสร้าง payload เมนู + คำนวณ sync hash (แยกจาก DB เพื่อทดสอบง่าย)
import { createHash } from "node:crypto";
import type { ConnectMenuItemPayload, ConnectMenuOptionGroupPayload } from "./types";

export interface VariantForDelivery {
  name: string;
  price_adjustment: number;
  is_active: boolean;
  sort_order: number;
}

export interface ModifierOptionForDelivery {
  name: string;
  price_adjustment: number;
  is_active: boolean;
  sort_order: number;
}

export interface ModifierGroupForDelivery {
  name: string;
  selection_type: "single" | "multiple";
  is_required: boolean;
  min_selections: number;
  max_selections: number;
  sort_order: number;
  options: ModifierOptionForDelivery[];
}

export interface ProductForDelivery {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  base_price: number;
  delivery_price: number | null;
  is_active: boolean;
  available_for_delivery: boolean;
  delivery_out_of_stock: boolean;
  /** #12: ตัวเลือกยิบย่อย — ไม่ส่งมา = ไม่มี (เมนูเดี่ยว) */
  variants?: VariantForDelivery[];
  modifier_groups?: ModifierGroupForDelivery[];
}

/** ชื่อกลุ่มตัวเลือกที่สร้างจาก product_variants (StoreOS ไม่มีชื่อกลุ่มระดับ variant) */
export const VARIANT_GROUP_NAME = "ตัวเลือก";

/** ราคาเดลิเวอรี = delivery_price ถ้าตั้งไว้ ไม่งั้นใช้ base_price */
export function resolveDeliveryPrice(p: Pick<ProductForDelivery, "base_price" | "delivery_price">): number {
  return p.delivery_price != null ? p.delivery_price : p.base_price;
}

/**
 * #12: แปลง variants + modifier groups → กลุ่มตัวเลือกสำหรับ JDC
 * - variants ≥ 2 ตัว (active) → กลุ่มบังคับเลือก 1 (min=1,max=1); ตัวเดียว = default ไม่ต้องส่ง
 * - modifier_groups → ตามกฎของกลุ่ม (single → max 1); ข้ามกลุ่มที่ไม่มีตัวเลือก active
 */
export function buildOptionGroups(
  product: Pick<ProductForDelivery, "variants" | "modifier_groups">,
): ConnectMenuOptionGroupPayload[] {
  const groups: ConnectMenuOptionGroupPayload[] = [];

  const activeVariants = (product.variants ?? [])
    .filter((v) => v.is_active)
    .sort((a, b) => a.sort_order - b.sort_order);
  if (activeVariants.length >= 2) {
    groups.push({
      name: VARIANT_GROUP_NAME,
      min_selection: 1,
      max_selection: 1,
      options: activeVariants.map((v) => ({
        name: v.name,
        price: v.price_adjustment,
        is_available: true,
      })),
    });
  }

  const modifierGroups = [...(product.modifier_groups ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  );
  for (const g of modifierGroups) {
    const activeOptions = g.options
      .filter((o) => o.is_active)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (activeOptions.length === 0) continue;
    const maxSelection = g.selection_type === "single" ? 1 : Math.max(g.max_selections, 1);
    groups.push({
      name: g.name,
      min_selection: g.is_required ? Math.max(g.min_selections, 1) : Math.max(g.min_selections, 0),
      max_selection: maxSelection,
      options: activeOptions.map((o) => ({
        name: o.name,
        price: o.price_adjustment,
        is_available: true,
      })),
    });
  }

  return groups;
}

/** สร้าง payload เมนู 1 รายการสำหรับส่งไป JDC */
export function buildMenuItemPayload(
  product: ProductForDelivery,
  categoryName: string | null,
): ConnectMenuItemPayload {
  return {
    external_ref: product.id,
    name: product.name,
    description: product.description,
    price: resolveDeliveryPrice(product),
    image_url: product.image_url,
    is_available: product.is_active && !product.delivery_out_of_stock, // ร้านกดของหมด → false
    category: categoryName,
    preparation_time: null,
    option_groups: buildOptionGroups(product),
  };
}

/** hash เสถียรของ payload (กันดันซ้ำเมื่อข้อมูลไม่เปลี่ยน) */
export function computeMenuSyncHash(payload: ConnectMenuItemPayload): string {
  const stable = JSON.stringify([
    payload.external_ref,
    payload.name,
    payload.description ?? "",
    payload.price,
    payload.image_url ?? "",
    payload.is_available,
    payload.category ?? "",
    payload.preparation_time ?? "",
    payload.option_groups.map((g) => [
      g.name,
      g.min_selection,
      g.max_selection,
      g.options.map((o) => [o.name, o.price, o.is_available]),
    ]),
  ]);
  return createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 32);
}

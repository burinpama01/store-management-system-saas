import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { CartLine, PricedLine } from "./core";

/**
 * เมนูสำหรับสั่งออนไลน์ + คิดราคาฝั่ง server (service client — ผู้เรียกตรวจว่าร้านเปิดสั่งออนไลน์แล้ว)
 * กติกาเมนู: สินค้าเปิดขาย, ไม่หมด, ไม่ใช่สินค้าขายแพ็ก (แพ็กขายที่ร้าน)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่/คอลัมน์ใหม่ยังไม่อยู่ใน database.types
type LooseClient = any;

export interface OnlineMenuOption {
  id: string;
  name: string;
  priceAdjustment: number;
}
export interface OnlineMenuGroup {
  id: string;
  name: string;
  selectionType: "single" | "multiple";
  minSelections: number;
  maxSelections: number;
  options: OnlineMenuOption[];
}
export interface OnlineMenuProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  categoryName: string;
  variants: { id: string; name: string; priceAdjustment: number }[];
  groups: OnlineMenuGroup[];
}

interface ProductRow {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  base_price: number;
  image_url: string | null;
  category_id: string | null;
  kitchen_station_id: string | null;
  is_active: boolean;
  out_of_stock: boolean;
}
interface VariantRow {
  id: string;
  product_id: string;
  name: string;
  price_adjustment: number;
}
interface GroupRow {
  id: string;
  product_id: string;
  name: string;
  selection_type: string;
  is_required: boolean;
  min_selections: number;
  max_selections: number;
  sort_order?: number | null;
}
interface OptionRow {
  id: string;
  modifier_group_id: string;
  name: string;
  price_adjustment: number;
}

const minOf = (g: GroupRow) => (g.is_required ? Math.max(1, g.min_selections) : g.min_selections);

async function loadCatalog(db: LooseClient, storeId: string, productIds: string[] | null) {
  let productQuery = db
    .from("products")
    .select("id, store_id, name, description, base_price, image_url, category_id, kitchen_station_id, is_active, out_of_stock")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .eq("out_of_stock", false);
  productQuery = productIds ? productQuery.in("id", productIds) : productQuery.order("sort_order").order("name").limit(300);
  const [productsRes, passRes] = await Promise.all([
    productQuery,
    db.from("prepaid_pass_plans").select("sale_product_id").eq("store_id", storeId),
  ]);
  const passProducts = new Set(((passRes.data ?? []) as { sale_product_id: string | null }[]).map((p) => p.sale_product_id));
  const products = ((productsRes.data ?? []) as ProductRow[]).filter((p) => !passProducts.has(p.id));
  const ids = products.map((p) => p.id);
  if (ids.length === 0) return { products, variants: [] as VariantRow[], groups: [] as GroupRow[], options: [] as OptionRow[] };
  const [variantsRes, groupsRes] = await Promise.all([
    db.from("product_variants").select("id, product_id, name, price_adjustment").in("product_id", ids).eq("is_active", true),
    db
      .from("modifier_groups")
      .select("id, product_id, name, selection_type, is_required, min_selections, max_selections")
      .in("product_id", ids),
  ]);
  const groups = (groupsRes.data ?? []) as GroupRow[];
  const optionsRes = groups.length
    ? await db
        .from("modifier_options")
        .select("id, modifier_group_id, name, price_adjustment")
        .in("modifier_group_id", groups.map((g) => g.id))
        .eq("is_active", true)
    : { data: [] };
  return {
    products,
    variants: (variantsRes.data ?? []) as VariantRow[],
    groups,
    options: (optionsRes.data ?? []) as OptionRow[],
  };
}

export async function loadOnlineMenu(storeId: string): Promise<OnlineMenuProduct[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const [{ products, variants, groups, options }, categoriesRes] = await Promise.all([
    loadCatalog(db, storeId, null),
    db.from("categories").select("id, name").eq("store_id", storeId),
  ]);
  const categoryNames = new Map(((categoriesRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    price: Number(p.base_price),
    imageUrl: p.image_url ?? null,
    categoryName: (p.category_id && categoryNames.get(p.category_id)) || "",
    variants: variants
      .filter((v) => v.product_id === p.id)
      .map((v) => ({ id: v.id, name: v.name, priceAdjustment: Number(v.price_adjustment) })),
    groups: groups
      .filter((g) => g.product_id === p.id)
      .map((g) => ({
        id: g.id,
        name: g.name,
        selectionType: g.selection_type === "single" ? ("single" as const) : ("multiple" as const),
        minSelections: minOf(g),
        maxSelections: g.max_selections,
        options: options
          .filter((o) => o.modifier_group_id === g.id)
          .map((o) => ({ id: o.id, name: o.name, priceAdjustment: Number(o.price_adjustment) })),
      }))
      .filter((g) => g.options.length > 0),
  }));
}

export type PriceCartResult = { ok: true; lines: PricedLine[]; subtotal: number } | { ok: false; error: string };

/** คิดราคาตะกร้าจากฐานข้อมูล — ไม่ใช้ราคาจากเบราว์เซอร์เลย */
export async function priceCart(storeId: string, items: CartLine[]): Promise<PriceCartResult> {
  const db: LooseClient = await createSupabaseServiceClient();
  const productIds = [...new Set(items.map((i) => i.productId))];
  const { products, variants, groups, options } = await loadCatalog(db, storeId, productIds);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const optionMap = new Map(options.map((o) => [o.id, o]));
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const stationIds = [...new Set(products.map((p) => p.kitchen_station_id).filter((id): id is string => Boolean(id)))];
  const stationsRes = stationIds.length
    ? await db.from("kitchen_stations").select("id, name").eq("store_id", storeId).eq("is_active", true).in("id", stationIds)
    : { data: [] };
  const stationNames = new Map(((stationsRes.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s.name]));

  const lines: PricedLine[] = [];
  let subtotal = 0;
  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) return { ok: false, error: "มีเมนูที่หมดหรือปิดขายแล้ว — ลองโหลดหน้าใหม่" };
    let unitPrice = Number(product.base_price);

    const productVariants = variants.filter((v) => v.product_id === product.id);
    let variantName: string | null = null;
    if (item.variantId) {
      const variant = variantMap.get(item.variantId);
      if (!variant || variant.product_id !== product.id) return { ok: false, error: `ตัวเลือกขนาดของ ${product.name} ไม่ถูกต้อง` };
      unitPrice += Number(variant.price_adjustment);
      variantName = variant.name;
    } else if (productVariants.length > 0) {
      return { ok: false, error: `เลือกขนาดของ ${product.name}` };
    }

    if (new Set(item.modifierOptionIds).size !== item.modifierOptionIds.length) {
      return { ok: false, error: `ตัวเลือกของ ${product.name} ซ้ำกัน` };
    }
    const selectedByGroup = new Map<string, number>();
    const modifiers: PricedLine["modifiers"] = [];
    for (const optionId of item.modifierOptionIds) {
      const option = optionMap.get(optionId);
      const group = option ? groupMap.get(option.modifier_group_id) : undefined;
      if (!option || !group || group.product_id !== product.id) return { ok: false, error: `ตัวเลือกของ ${product.name} ไม่ถูกต้อง` };
      selectedByGroup.set(group.id, (selectedByGroup.get(group.id) ?? 0) + 1);
      unitPrice += Number(option.price_adjustment);
      modifiers.push({
        modifierGroupId: group.id,
        modifierGroupName: group.name,
        option: { id: option.id, name: option.name, priceAdjustment: Number(option.price_adjustment) },
      });
    }
    for (const group of groups.filter((g) => g.product_id === product.id)) {
      const count = selectedByGroup.get(group.id) ?? 0;
      const hasOptions = options.some((o) => o.modifier_group_id === group.id);
      if (hasOptions && count < minOf(group)) return { ok: false, error: `เลือก "${group.name}" ของ ${product.name}` };
      if (count > group.max_selections || (group.selection_type === "single" && count > 1)) {
        return { ok: false, error: `เลือก "${group.name}" ของ ${product.name} เกินจำนวน` };
      }
    }

    unitPrice = Math.round(unitPrice * 100) / 100;
    if (unitPrice < 0) return { ok: false, error: `ราคาของ ${product.name} ไม่ถูกต้อง` };
    const totalPrice = Math.round(unitPrice * item.quantity * 100) / 100;
    subtotal += totalPrice;
    const stationId = product.kitchen_station_id && stationNames.has(product.kitchen_station_id) ? product.kitchen_station_id : null;
    lines.push({
      productId: product.id,
      productName: product.name,
      variantId: item.variantId,
      variantName,
      modifiers,
      quantity: item.quantity,
      unitPrice,
      totalPrice,
      note: item.note?.trim() || null,
      kitchenStationId: stationId,
      kitchenStationName: stationId ? (stationNames.get(stationId) ?? null) : null,
    });
  }
  return { ok: true, lines, subtotal: Math.round(subtotal * 100) / 100 };
}

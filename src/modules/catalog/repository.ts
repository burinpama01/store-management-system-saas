import { randomUUID } from "node:crypto";
import { withDataClient } from "@/shared/services/data-client";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type {
  Category,
  Product,
  ProductVariant,
  VariantTemplate,
  ModifierGroupTemplate,
  ModifierOptionTemplate,
  ModifierGroup,
  ModifierOption,
} from "@/modules/catalog/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];
type ProductRow = Database["public"]["Tables"]["products"]["Row"];
type VariantTemplateRow = Database["public"]["Tables"]["catalog_variant_templates"]["Row"];
type ModifierGroupTemplateRow = Database["public"]["Tables"]["catalog_modifier_group_templates"]["Row"];
type ModifierOptionTemplateRow = Database["public"]["Tables"]["catalog_modifier_option_templates"]["Row"];
type VariantRow = Database["public"]["Tables"]["product_variants"]["Row"];
type ModGroupRow = Database["public"]["Tables"]["modifier_groups"]["Row"];
type ModOptionRow = Database["public"]["Tables"]["modifier_options"]["Row"];

function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description ?? undefined,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVariant(row: VariantRow): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    barcode: row.barcode ?? undefined,
    priceAdjustment: row.price_adjustment,
    sku: row.sku ?? undefined,
    stockQuantity: row.stock_quantity ?? undefined,
    trackStock: row.track_stock,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function mapVariantTemplate(row: VariantTemplateRow): VariantTemplate {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    priceAdjustment: row.price_adjustment,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModifierOptionTemplate(row: ModifierOptionTemplateRow): ModifierOptionTemplate {
  return {
    id: row.id,
    modifierGroupTemplateId: row.group_template_id,
    name: row.name,
    priceAdjustment: row.price_adjustment,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModifierGroupTemplate(
  row: ModifierGroupTemplateRow,
  options: ModifierOptionTemplateRow[],
): ModifierGroupTemplate {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    selectionType: row.selection_type,
    isRequired: row.is_required,
    minSelections: row.min_selections,
    maxSelections: row.max_selections,
    sortOrder: row.sort_order,
    options: options
      .filter((option) => option.group_template_id === row.id)
      .map(mapModifierOptionTemplate)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModifierOption(row: ModOptionRow): ModifierOption {
  return {
    id: row.id,
    modifierGroupId: row.modifier_group_id,
    name: row.name,
    priceAdjustment: row.price_adjustment,
    isDefault: row.is_default,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

function mapModifierGroup(
  row: ModGroupRow,
  options: ModOptionRow[],
): ModifierGroup {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    selectionType: row.selection_type,
    isRequired: row.is_required,
    minSelections: row.min_selections,
    maxSelections: row.max_selections,
    sortOrder: row.sort_order,
    options: options
      .filter((o) => o.modifier_group_id === row.id)
      .map(mapModifierOption)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function mapProduct(
  row: ProductRow,
  variants: VariantRow[],
  modGroups: ModGroupRow[],
  modOptions: ModOptionRow[],
): Product {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    menuLinkId: row.menu_link_id ?? undefined,
    kitchenStationId: row.kitchen_station_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    barcode: row.barcode ?? undefined,
    imageUrl: row.image_url ?? undefined,
    basePrice: row.base_price,
    isActive: row.is_active,
    availableForPos: row.available_for_pos,
    availableForQr: row.available_for_qr,
    availableForDelivery: row.available_for_delivery,
    deliveryPrice: row.delivery_price,
    sortOrder: row.sort_order,
    variants: variants
      .filter((v) => v.product_id === row.id)
      .map(mapVariant)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    modifierGroups: modGroups
      .filter((g) => g.product_id === row.id)
      .map((g) => mapModifierGroup(g, modOptions))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Categories ---

export async function listCategories(storeId: string) {
  return withDataClient<Category[]>(
    async (supabase) => {
      const { data, error } = await supabase
        .from("categories")
        .select("*")
        .eq("store_id", storeId)
        .eq("is_active", true)
        .order("sort_order");
      return { data: data ? data.map(mapCategory) : null, error };
    },
    { defaultData: [] },
  );
}

export async function createCategory(
  input: Database["public"]["Tables"]["categories"]["Insert"],
) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("categories")
    .insert(input)
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapCategory(data), error: null };
}

export async function updateCategory(
  id: string,
  storeId: string,
  input: Partial<Pick<Category, "name" | "description" | "sortOrder" | "isActive">>,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("categories")
    .update({
      name: input.name,
      description: input.description,
      sort_order: input.sortOrder,
      is_active: input.isActive,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deleteCategory(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("categories").delete().eq("id", id).eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// --- Products ---

export async function listProducts(storeId: string, opts?: { includeInactive?: boolean }) {
  return withDataClient<Product[]>(
    async (supabase) => {
      let q = supabase.from("products").select("*").eq("store_id", storeId);
      if (!opts?.includeInactive) q = q.eq("is_active", true);
      q = q.order("sort_order");

      const productsRes = await q;
      if (productsRes.error) return { data: null, error: productsRes.error };

      const productRows = productsRes.data ?? [];
      if (productRows.length === 0) return { data: [], error: null };

      const productIds = productRows.map((p) => p.id);

      const [variantsRes, groupsRes] = await Promise.all([
        supabase.from("product_variants").select("*").in("product_id", productIds).eq("is_active", true),
        supabase.from("modifier_groups").select("*").in("product_id", productIds),
      ]);
      if (variantsRes.error) return { data: null, error: variantsRes.error };
      if (groupsRes.error) return { data: null, error: groupsRes.error };

      const groupIds = (groupsRes.data ?? []).map((g) => g.id);
      const optionsRes =
        groupIds.length > 0
          ? await supabase
              .from("modifier_options")
              .select("*")
              .in("modifier_group_id", groupIds)
              .eq("is_active", true)
          : { data: [], error: null };
      if (optionsRes.error) return { data: null, error: optionsRes.error };

      const products = productRows.map((row) =>
        mapProduct(
          row,
          variantsRes.data ?? [],
          groupsRes.data ?? [],
          optionsRes.data ?? [],
        ),
      );
      return { data: products, error: null };
    },
    { defaultData: [] },
  );
}

export interface BarcodeProductMatch {
  product: Product;
  variant: ProductVariant | null;
  barcode: string;
  source: "product_barcode" | "variant_barcode" | "variant_sku";
}

export function normalizeCatalogBarcode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  return value;
}

export async function findProductByBarcode(storeId: string, input: string) {
  const barcode = normalizeCatalogBarcode(input);
  if (!barcode) return { data: null, error: null };

  const productsRes = await listProducts(storeId, { includeInactive: false });
  if (productsRes.error || !productsRes.data) return { data: null, error: productsRes.error };

  const normalized = barcode.toLowerCase();
  const matches: BarcodeProductMatch[] = [];

  for (const product of productsRes.data) {
    if (product.barcode?.toLowerCase() === normalized) {
      matches.push({ product, variant: null, barcode, source: "product_barcode" });
    }

    for (const variant of product.variants) {
      if (variant.barcode?.toLowerCase() === normalized) {
        matches.push({ product, variant, barcode, source: "variant_barcode" });
      } else if (variant.sku?.toLowerCase() === normalized) {
        matches.push({ product, variant, barcode, source: "variant_sku" });
      }
    }
  }

  if (matches.length > 1) {
    return { data: null, error: mapError(new Error("พบบาร์โค้ดซ้ำในร้านนี้")) };
  }

  return { data: matches[0] ?? null, error: null };
}

export async function getProduct(productId: string) {
  return withDataClient<Product>(async (supabase) => {
    const productRes = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .single();
    if (productRes.error) return { data: null, error: productRes.error };

    const [variantsRes, groupsRes] = await Promise.all([
      supabase.from("product_variants").select("*").eq("product_id", productId),
      supabase.from("modifier_groups").select("*").eq("product_id", productId),
    ]);
    if (variantsRes.error) return { data: null, error: variantsRes.error };
    if (groupsRes.error) return { data: null, error: groupsRes.error };

    const groupIds = (groupsRes.data ?? []).map((g) => g.id);
    const optionsRes =
      groupIds.length > 0
        ? await supabase
            .from("modifier_options")
            .select("*")
            .in("modifier_group_id", groupIds)
        : { data: [], error: null };
    if (optionsRes.error) return { data: null, error: optionsRes.error };

    return {
      data: mapProduct(
        productRes.data,
        variantsRes.data ?? [],
        groupsRes.data ?? [],
        optionsRes.data ?? [],
      ),
      error: null,
    };
  });
}

export interface CreateProductInput {
  storeId: string;
  organizationId: string;
  categoryId: string;
  menuLinkId?: string;
  name: string;
  description?: string;
  barcode?: string;
  imageUrl?: string;
  basePrice?: number;
  availableForPos?: boolean;
  availableForQr?: boolean;
  availableForDelivery?: boolean;
  deliveryPrice?: number | null;
  kitchenStationId?: string | null;
  sortOrder?: number;
}

export async function createProduct(input: CreateProductInput) {
  const supabase = await createSupabaseServerClient();
  const productId = randomUUID();
  const { data, error } = await supabase
    .from("products")
    .insert({
      id: productId,
      store_id: input.storeId,
      organization_id: input.organizationId,
      category_id: input.categoryId,
      menu_link_id: input.menuLinkId ?? productId,
      name: input.name,
      description: input.description,
      barcode: input.barcode ?? null,
      image_url: input.imageUrl,
      base_price: input.basePrice ?? 0,
      available_for_pos: input.availableForPos ?? true,
      available_for_qr: input.availableForQr ?? false,
      available_for_delivery: input.availableForDelivery ?? false,
      delivery_price: input.deliveryPrice ?? null,
      kitchen_station_id: input.kitchenStationId ?? null,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return {
    data: mapProduct(data, [], [], []),
    error: null,
  };
}

export async function updateProduct(
  id: string,
  storeId: string,
  input: Partial<
    Pick<
      Product,
      | "name"
      | "description"
      | "barcode"
      | "imageUrl"
      | "basePrice"
      | "isActive"
      | "availableForPos"
      | "availableForQr"
      | "availableForDelivery"
      | "deliveryPrice"
      | "sortOrder"
      | "categoryId"
    >
  > & { kitchenStationId?: string | null },
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("products")
    .update({
      name: input.name,
      description: input.description,
      barcode: input.barcode,
      image_url: input.imageUrl,
      base_price: input.basePrice,
      is_active: input.isActive,
      available_for_pos: input.availableForPos,
      available_for_qr: input.availableForQr,
      available_for_delivery: input.availableForDelivery,
      delivery_price: input.deliveryPrice,
      kitchen_station_id: input.kitchenStationId,
      sort_order: input.sortOrder,
      category_id: input.categoryId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deleteProduct(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("products").delete().eq("id", id).eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// --- Variant templates ---

export interface CreateVariantTemplateInput {
  storeId: string;
  name: string;
  priceAdjustment: number;
  sortOrder?: number;
}

export async function listVariantTemplates(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("catalog_variant_templates")
    .select("*")
    .eq("store_id", storeId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapVariantTemplate), error: null };
}

export async function createVariantTemplate(input: CreateVariantTemplateInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("catalog_variant_templates")
    .insert({
      store_id: input.storeId,
      name: input.name,
      price_adjustment: input.priceAdjustment,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapVariantTemplate(data), error: null };
}

export async function getVariantTemplate(id: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("catalog_variant_templates")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapVariantTemplate(data), error: null };
}

export async function deleteVariantTemplate(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("catalog_variant_templates")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// --- Modifier group templates ---

export interface CreateModifierGroupTemplateInput {
  storeId: string;
  name: string;
  selectionType: "single" | "multiple";
  isRequired?: boolean;
  minSelections?: number;
  maxSelections?: number;
  sortOrder?: number;
}

export async function listModifierGroupTemplates(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: groups, error } = await supabase
    .from("catalog_modifier_group_templates")
    .select("*")
    .eq("store_id", storeId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) return { data: null, error: mapError(error) };

  const groupIds = (groups ?? []).map((group) => group.id);
  const { data: options, error: optionsError } = groupIds.length
    ? await supabase
        .from("catalog_modifier_option_templates")
        .select("*")
        .in("group_template_id", groupIds)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true })
    : { data: [], error: null };
  if (optionsError) return { data: null, error: mapError(optionsError) };

  return {
    data: (groups ?? []).map((group) => mapModifierGroupTemplate(group, options ?? [])),
    error: null,
  };
}

export async function createModifierGroupTemplate(input: CreateModifierGroupTemplateInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("catalog_modifier_group_templates")
    .insert({
      store_id: input.storeId,
      name: input.name,
      selection_type: input.selectionType,
      is_required: input.isRequired ?? false,
      min_selections: input.minSelections ?? 0,
      max_selections: input.maxSelections ?? 1,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapModifierGroupTemplate(data, []), error: null };
}

export async function getModifierGroupTemplate(id: string) {
  const supabase = await createSupabaseServerClient();
  const { data: group, error } = await supabase
    .from("catalog_modifier_group_templates")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return { data: null, error: mapError(error) };

  const { data: options, error: optionsError } = await supabase
    .from("catalog_modifier_option_templates")
    .select("*")
    .eq("group_template_id", id)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (optionsError) return { data: null, error: mapError(optionsError) };

  return { data: mapModifierGroupTemplate(group, options ?? []), error: null };
}

export async function deleteModifierGroupTemplate(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("catalog_modifier_group_templates")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface CreateModifierOptionTemplateInput {
  groupTemplateId: string;
  name: string;
  priceAdjustment?: number;
  isDefault?: boolean;
  sortOrder?: number;
}

export async function createModifierOptionTemplate(input: CreateModifierOptionTemplateInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("catalog_modifier_option_templates")
    .insert({
      group_template_id: input.groupTemplateId,
      name: input.name,
      price_adjustment: input.priceAdjustment ?? 0,
      is_default: input.isDefault ?? false,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapModifierOptionTemplate(data), error: null };
}

export async function deleteModifierOptionTemplate(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: option, error: optionError } = await supabase
    .from("catalog_modifier_option_templates")
    .select("group_template_id")
    .eq("id", id)
    .single();
  if (optionError) return { ok: false, error: mapError(optionError) };
  if (!option) return { ok: false, error: mapError(new Error("Modifier option template not found")) };

  const { data: group, error: groupError } = await supabase
    .from("catalog_modifier_group_templates")
    .select("store_id")
    .eq("id", option.group_template_id)
    .single();
  if (groupError) return { ok: false, error: mapError(groupError) };
  if (!group || group.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };

  const { error } = await supabase.from("catalog_modifier_option_templates").delete().eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function setModifierOptionTemplateDefault(id: string, storeId: string, isDefault: boolean) {
  const supabase = await createSupabaseServerClient();
  const { data: option, error: optionError } = await supabase
    .from("catalog_modifier_option_templates")
    .select("group_template_id")
    .eq("id", id)
    .single();
  if (optionError) return { ok: false, error: mapError(optionError) };
  if (!option) return { ok: false, error: mapError(new Error("Modifier option template not found")) };

  const { data: group, error: groupError } = await supabase
    .from("catalog_modifier_group_templates")
    .select("store_id")
    .eq("id", option.group_template_id)
    .single();
  if (groupError) return { ok: false, error: mapError(groupError) };
  if (!group || group.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };

  const updatedAt = new Date().toISOString();
  const { error } = await supabase
    .from("catalog_modifier_option_templates")
    .update({ is_default: isDefault, updated_at: updatedAt })
    .eq("id", id);
  if (error) return { ok: false, error: mapError(error) };

  return { ok: true, error: null };
}

// --- Variants ---

export interface CreateVariantInput {
  productId: string;
  name: string;
  priceAdjustment: number;
  barcode?: string;
  sku?: string;
  trackStock?: boolean;
  sortOrder?: number;
}

export async function createVariant(input: CreateVariantInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("product_variants")
    .insert({
      product_id: input.productId,
      name: input.name,
      price_adjustment: input.priceAdjustment,
      barcode: input.barcode ?? null,
      sku: input.sku ?? null,
      track_stock: input.trackStock ?? false,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapVariant(data), error: null };
}

export async function updateVariant(
  id: string,
  storeId: string,
  input: Partial<Pick<ProductVariant, "name" | "priceAdjustment" | "barcode" | "sku" | "trackStock" | "isActive" | "sortOrder">>,
) {
  const supabase = await createSupabaseServerClient();
  const { data: variant } = await supabase
    .from("product_variants")
    .select("product_id")
    .eq("id", id)
    .single();
  if (!variant) return { ok: false, error: mapError(new Error("Variant not found")) };
  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", variant.product_id)
    .single();
  if (!product || product.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };
  const { error } = await supabase
    .from("product_variants")
    .update({
      name: input.name,
      price_adjustment: input.priceAdjustment,
      barcode: input.barcode,
      sku: input.sku,
      track_stock: input.trackStock,
      is_active: input.isActive,
      sort_order: input.sortOrder,
    })
    .eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deleteVariant(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: variant } = await supabase
    .from("product_variants")
    .select("product_id")
    .eq("id", id)
    .single();
  if (!variant) return { ok: false, error: mapError(new Error("Variant not found")) };
  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", variant.product_id)
    .single();
  if (!product || product.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };
  const { error } = await supabase.from("product_variants").delete().eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// --- Modifier Groups ---

export interface CreateModifierGroupInput {
  productId: string;
  name: string;
  selectionType: "single" | "multiple";
  isRequired?: boolean;
  minSelections?: number;
  maxSelections?: number;
  sortOrder?: number;
}

export async function createModifierGroup(input: CreateModifierGroupInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("modifier_groups")
    .insert({
      product_id: input.productId,
      name: input.name,
      selection_type: input.selectionType,
      is_required: input.isRequired ?? false,
      min_selections: input.minSelections ?? 0,
      max_selections: input.maxSelections ?? 1,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapModifierGroup(data, []), error: null };
}

export async function updateModifierGroup(
  id: string,
  storeId: string,
  input: Partial<Pick<ModifierGroup, "name" | "selectionType" | "isRequired" | "minSelections" | "maxSelections" | "sortOrder">>,
) {
  const supabase = await createSupabaseServerClient();
  const { data: group } = await supabase
    .from("modifier_groups")
    .select("product_id")
    .eq("id", id)
    .single();
  if (!group) return { ok: false, error: mapError(new Error("Modifier group not found")) };
  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", group.product_id)
    .single();
  if (!product || product.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };
  const { error } = await supabase
    .from("modifier_groups")
    .update({
      name: input.name,
      selection_type: input.selectionType,
      is_required: input.isRequired,
      min_selections: input.minSelections,
      max_selections: input.maxSelections,
      sort_order: input.sortOrder,
    })
    .eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deleteModifierGroup(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: group } = await supabase
    .from("modifier_groups")
    .select("product_id")
    .eq("id", id)
    .single();
  if (!group) return { ok: false, error: mapError(new Error("Modifier group not found")) };
  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", group.product_id)
    .single();
  if (!product || product.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };
  const { error } = await supabase.from("modifier_groups").delete().eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// --- Modifier Options ---

export async function getModifierGroupStoreId(groupId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data: group } = await supabase
    .from("modifier_groups")
    .select("product_id")
    .eq("id", groupId)
    .single();
  if (!group) return null;
  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", group.product_id)
    .single();
  return product?.store_id ?? null;
}

export interface CreateModifierOptionInput {
  modifierGroupId: string;
  name: string;
  priceAdjustment?: number;
  isDefault?: boolean;
  sortOrder?: number;
}

export async function createModifierOption(input: CreateModifierOptionInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("modifier_options")
    .insert({
      modifier_group_id: input.modifierGroupId,
      name: input.name,
      price_adjustment: input.priceAdjustment ?? 0,
      is_default: input.isDefault ?? false,
      sort_order: input.sortOrder ?? 0,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapModifierOption(data), error: null };
}

export async function deleteModifierOption(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: option } = await supabase
    .from("modifier_options")
    .select("modifier_group_id")
    .eq("id", id)
    .single();
  if (!option) return { ok: false, error: mapError(new Error("Modifier option not found")) };
  const { data: group } = await supabase
    .from("modifier_groups")
    .select("product_id")
    .eq("id", option.modifier_group_id)
    .single();
  if (!group) return { ok: false, error: mapError(new Error("Modifier group not found")) };
  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", group.product_id)
    .single();
  if (!product || product.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };
  const { error } = await supabase.from("modifier_options").delete().eq("id", id);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function setModifierOptionDefault(id: string, storeId: string, isDefault: boolean) {
  const supabase = await createSupabaseServerClient();
  const { data: option } = await supabase
    .from("modifier_options")
    .select("modifier_group_id")
    .eq("id", id)
    .single();
  if (!option) return { ok: false, error: mapError(new Error("Modifier option not found")) };

  const { data: group } = await supabase
    .from("modifier_groups")
    .select("product_id")
    .eq("id", option.modifier_group_id)
    .single();
  if (!group) return { ok: false, error: mapError(new Error("Modifier group not found")) };

  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", group.product_id)
    .single();
  if (!product || product.store_id !== storeId)
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };

  const { error } = await supabase
    .from("modifier_options")
    .update({ is_default: isDefault })
    .eq("id", id);
  if (error) return { ok: false, error: mapError(error) };

  return { ok: true, error: null };
}

export type CatalogCopyPriceMode = "copy" | "preserve";
export type CatalogCopyDuplicateMode = "skip" | "update";

export interface CopyProductsAcrossBranchesInput {
  organizationId: string;
  sourceStoreId: string;
  targetStoreIds: string[];
  productIds: string[];
  priceMode: CatalogCopyPriceMode;
  duplicateMode: CatalogCopyDuplicateMode;
}

export interface CopyProductsAcrossBranchesSummary {
  created: number;
  updated: number;
  skipped: number;
}

function normalizeNameKey(value: string) {
  return value.trim().toLocaleLowerCase("th-TH");
}

function normalizePriceKey(value: number | string | null | undefined) {
  const numericValue = Number(value ?? 0);
  return Number.isFinite(numericValue) ? numericValue.toFixed(2) : String(value ?? 0);
}

function catalogTemplateKey(template: { name: string; price_adjustment: number | string | null }) {
  return `${normalizeNameKey(template.name)}::${normalizePriceKey(template.price_adjustment)}`;
}

function existingVariantPriceByName(product?: Product) {
  return new Map((product?.variants ?? []).map((variant) => [normalizeNameKey(variant.name), variant.priceAdjustment]));
}

function existingModifierPriceByName(product?: Product) {
  const prices = new Map<string, number>();
  for (const group of product?.modifierGroups ?? []) {
    for (const option of group.options) {
      prices.set(`${normalizeNameKey(group.name)}::${normalizeNameKey(option.name)}`, option.priceAdjustment);
    }
  }
  return prices;
}

async function deleteProductChildren(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  productId: string,
) {
  const { data: groups, error: groupsError } = await supabase
    .from("modifier_groups")
    .select("id")
    .eq("product_id", productId);
  if (groupsError) return groupsError;

  const groupIds = (groups ?? []).map((group) => group.id);
  if (groupIds.length > 0) {
    const { error: optionsError } = await supabase
      .from("modifier_options")
      .delete()
      .in("modifier_group_id", groupIds);
    if (optionsError) return optionsError;

    const { error: modifierGroupsError } = await supabase
      .from("modifier_groups")
      .delete()
      .in("id", groupIds);
    if (modifierGroupsError) return modifierGroupsError;
  }

  const { error: variantsError } = await supabase
    .from("product_variants")
    .delete()
    .eq("product_id", productId);
  return variantsError;
}

async function restoreExistingProductSnapshot(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  product: Product,
) {
  await deleteProductChildren(supabase, product.id);
  await supabase
    .from("products")
    .update({
      category_id: product.categoryId,
      name: product.name,
      description: product.description ?? null,
      barcode: product.barcode ?? null,
      image_url: product.imageUrl ?? null,
      base_price: product.basePrice,
      is_active: product.isActive,
      available_for_pos: product.availableForPos,
      available_for_qr: product.availableForQr,
      sort_order: product.sortOrder,
      updated_at: product.updatedAt,
    })
    .eq("id", product.id)
    .eq("store_id", product.storeId);

  for (const variant of product.variants) {
    await supabase.from("product_variants").insert({
      id: variant.id,
      product_id: product.id,
      name: variant.name,
      barcode: variant.barcode ?? null,
      sku: variant.sku ?? null,
      price_adjustment: variant.priceAdjustment,
      track_stock: variant.trackStock,
      stock_quantity: variant.stockQuantity ?? null,
      is_active: variant.isActive,
      sort_order: variant.sortOrder,
    });
  }

  for (const group of product.modifierGroups) {
    await supabase.from("modifier_groups").insert({
      id: group.id,
      product_id: product.id,
      name: group.name,
      selection_type: group.selectionType,
      is_required: group.isRequired,
      min_selections: group.minSelections,
      max_selections: group.maxSelections,
      sort_order: group.sortOrder,
    });

    for (const option of group.options) {
      await supabase.from("modifier_options").insert({
        id: option.id,
        modifier_group_id: group.id,
        name: option.name,
        price_adjustment: option.priceAdjustment,
        is_default: option.isDefault,
        is_active: option.isActive,
        sort_order: option.sortOrder,
      });
    }
  }
}

async function deleteCopiedProduct(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  productId: string,
) {
  await deleteProductChildren(supabase, productId);
  await supabase.from("products").delete().eq("id", productId);
}

async function runRollbackSteps(rollbackSteps: Array<() => Promise<void>>) {
  for (const rollback of rollbackSteps.slice().reverse()) {
    try {
      await rollback();
    } catch {
      // Best-effort rollback; the original write error is returned to the caller.
    }
  }
}

async function cloneProductChildren(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  sourceProduct: Product,
  targetProductId: string,
  input: {
    priceMode: CatalogCopyPriceMode;
    existingProduct?: Product;
  },
) {
  const variantPrices = existingVariantPriceByName(input.existingProduct);
  const modifierPrices = existingModifierPriceByName(input.existingProduct);

  for (const variant of sourceProduct.variants) {
    const { error } = await supabase.from("product_variants").insert({
      product_id: targetProductId,
      name: variant.name,
      barcode: variant.barcode ?? null,
      sku: variant.sku ?? null,
      price_adjustment:
        input.priceMode === "preserve"
          ? (variantPrices.get(normalizeNameKey(variant.name)) ?? variant.priceAdjustment)
          : variant.priceAdjustment,
      track_stock: variant.trackStock,
      stock_quantity: variant.stockQuantity ?? null,
      is_active: variant.isActive,
      sort_order: variant.sortOrder,
    });
    if (error) return error;
  }

  for (const group of sourceProduct.modifierGroups) {
    const { data: createdGroup, error: groupError } = await supabase
      .from("modifier_groups")
      .insert({
        product_id: targetProductId,
        name: group.name,
        selection_type: group.selectionType,
        is_required: group.isRequired,
        min_selections: group.minSelections,
        max_selections: group.maxSelections,
        sort_order: group.sortOrder,
      })
      .select()
      .single();
    if (groupError) return groupError;

    for (const option of group.options) {
      const priceKey = `${normalizeNameKey(group.name)}::${normalizeNameKey(option.name)}`;
      const { error } = await supabase.from("modifier_options").insert({
        modifier_group_id: createdGroup.id,
        name: option.name,
        price_adjustment:
          input.priceMode === "preserve"
            ? (modifierPrices.get(priceKey) ?? option.priceAdjustment)
            : option.priceAdjustment,
        is_default: option.isDefault,
        is_active: option.isActive,
        sort_order: option.sortOrder,
      });
      if (error) return error;
    }
  }

  return null;
}

async function copyCatalogTemplateLibrary(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  input: {
    sourceStoreId: string;
    targetStoreId: string;
    rollbackSteps: Array<() => Promise<void>>;
  },
) {
  const { data: sourceVariantTemplates, error: sourceVariantTemplatesError } = await supabase
    .from("catalog_variant_templates")
    .select("*")
    .eq("store_id", input.sourceStoreId);
  if (sourceVariantTemplatesError) return sourceVariantTemplatesError;

  const { data: targetVariantTemplates, error: targetVariantTemplatesError } = await supabase
    .from("catalog_variant_templates")
    .select("*")
    .eq("store_id", input.targetStoreId);
  if (targetVariantTemplatesError) return targetVariantTemplatesError;

  const targetVariantKeys = new Set(
    (targetVariantTemplates ?? []).map((template) => catalogTemplateKey(template)),
  );
  for (const template of sourceVariantTemplates ?? []) {
    if (targetVariantKeys.has(catalogTemplateKey(template))) continue;

    const { data: createdTemplate, error } = await supabase
      .from("catalog_variant_templates")
      .insert({
        store_id: input.targetStoreId,
        name: template.name,
        price_adjustment: template.price_adjustment,
        sort_order: template.sort_order,
      })
      .select("id")
      .single();
    if (error) return error;

    targetVariantKeys.add(catalogTemplateKey(template));
    input.rollbackSteps.push(async () => {
      await supabase
        .from("catalog_variant_templates")
        .delete()
        .eq("id", createdTemplate.id)
        .eq("store_id", input.targetStoreId);
    });
  }

  const { data: sourceGroupTemplates, error: sourceGroupTemplatesError } = await supabase
    .from("catalog_modifier_group_templates")
    .select("*")
    .eq("store_id", input.sourceStoreId);
  if (sourceGroupTemplatesError) return sourceGroupTemplatesError;

  const sourceGroupTemplateIds = (sourceGroupTemplates ?? []).map((template) => template.id);
  const { data: sourceOptionTemplates, error: sourceOptionTemplatesError } = sourceGroupTemplateIds.length
    ? await supabase
        .from("catalog_modifier_option_templates")
        .select("*")
        .in("group_template_id", sourceGroupTemplateIds)
    : { data: [], error: null };
  if (sourceOptionTemplatesError) return sourceOptionTemplatesError;

  const { data: targetGroupTemplates, error: targetGroupTemplatesError } = await supabase
    .from("catalog_modifier_group_templates")
    .select("*")
    .eq("store_id", input.targetStoreId);
  if (targetGroupTemplatesError) return targetGroupTemplatesError;

  const targetGroupTemplateIds = (targetGroupTemplates ?? []).map((template) => template.id);
  const { data: targetOptionTemplates, error: targetOptionTemplatesError } = targetGroupTemplateIds.length
    ? await supabase
        .from("catalog_modifier_option_templates")
        .select("*")
        .in("group_template_id", targetGroupTemplateIds)
    : { data: [], error: null };
  if (targetOptionTemplatesError) return targetOptionTemplatesError;

  const targetGroupsByName = new Map(
    (targetGroupTemplates ?? []).map((template) => [normalizeNameKey(template.name), template]),
  );
  const targetOptionsByGroupId = new Map<string, Set<string>>();
  for (const option of targetOptionTemplates ?? []) {
    const optionKeys = targetOptionsByGroupId.get(option.group_template_id) ?? new Set<string>();
    optionKeys.add(catalogTemplateKey(option));
    targetOptionsByGroupId.set(option.group_template_id, optionKeys);
  }

  for (const sourceGroup of sourceGroupTemplates ?? []) {
    let targetGroup = targetGroupsByName.get(normalizeNameKey(sourceGroup.name));
    if (!targetGroup) {
      const { data: createdGroup, error } = await supabase
        .from("catalog_modifier_group_templates")
        .insert({
          store_id: input.targetStoreId,
          name: sourceGroup.name,
          selection_type: sourceGroup.selection_type,
          is_required: sourceGroup.is_required,
          min_selections: sourceGroup.min_selections,
          max_selections: sourceGroup.max_selections,
          sort_order: sourceGroup.sort_order,
        })
        .select()
        .single();
      if (error) return error;

      targetGroup = createdGroup;
      targetGroupsByName.set(normalizeNameKey(createdGroup.name), createdGroup);
      targetOptionsByGroupId.set(createdGroup.id, new Set<string>());
      input.rollbackSteps.push(async () => {
        await supabase
          .from("catalog_modifier_group_templates")
          .delete()
          .eq("id", createdGroup.id)
          .eq("store_id", input.targetStoreId);
      });
    }

    const targetOptionKeys = targetOptionsByGroupId.get(targetGroup.id) ?? new Set<string>();
    for (const sourceOption of (sourceOptionTemplates ?? []).filter(
      (option) => option.group_template_id === sourceGroup.id,
    )) {
      if (targetOptionKeys.has(catalogTemplateKey(sourceOption))) continue;

      const { data: createdOption, error } = await supabase
        .from("catalog_modifier_option_templates")
        .insert({
          group_template_id: targetGroup.id,
          name: sourceOption.name,
          price_adjustment: sourceOption.price_adjustment,
          is_default: sourceOption.is_default,
          sort_order: sourceOption.sort_order,
        })
        .select("id")
        .single();
      if (error) return error;

      targetOptionKeys.add(catalogTemplateKey(sourceOption));
      targetOptionsByGroupId.set(targetGroup.id, targetOptionKeys);
      input.rollbackSteps.push(async () => {
        await supabase
          .from("catalog_modifier_option_templates")
          .delete()
          .eq("id", createdOption.id)
          .eq("group_template_id", targetGroup.id);
      });
    }
  }

  return null;
}

export async function copyProductsAcrossBranches(input: CopyProductsAcrossBranchesInput) {
  const supabase = await createSupabaseServerClient();
  const targetStoreIds = [...new Set(input.targetStoreIds)].filter((id) => id !== input.sourceStoreId);
  const productIds = [...new Set(input.productIds)];

  if (targetStoreIds.length === 0) {
    return { data: null, error: mapError(new Error("กรุณาเลือกสาขาปลายทาง")) };
  }
  if (productIds.length === 0) {
    return { data: null, error: mapError(new Error("กรุณาเลือกสินค้า")) };
  }

  const { data: stores, error: storesError } = await supabase
    .from("stores")
    .select("id")
    .eq("organization_id", input.organizationId)
    .in("id", [input.sourceStoreId, ...targetStoreIds])
    .eq("is_active", true);
  if (storesError) return { data: null, error: mapError(storesError) };

  const allowedStoreIds = new Set((stores ?? []).map((store) => store.id));
  if (!allowedStoreIds.has(input.sourceStoreId) || targetStoreIds.some((id) => !allowedStoreIds.has(id))) {
    return { data: null, error: mapError(new Error("พบสาขาที่ไม่อยู่ในองค์กรนี้")) };
  }

  const { data: productRows, error: productRowsError } = await supabase
    .from("products")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("store_id", input.sourceStoreId)
    .in("id", productIds);
  if (productRowsError) return { data: null, error: mapError(productRowsError) };
  if (!productRows?.length) return { data: null, error: mapError(new Error("ไม่พบสินค้าที่เลือก")) };

  const sourceProductIds = productRows.map((product) => product.id);
  const sourceCategoryIds = [...new Set(productRows.map((product) => product.category_id))];
  const { data: variants, error: variantsError } = await supabase
    .from("product_variants")
    .select("*")
    .in("product_id", sourceProductIds);
  if (variantsError) return { data: null, error: mapError(variantsError) };

  const { data: groups, error: groupsError } = await supabase
    .from("modifier_groups")
    .select("*")
    .in("product_id", sourceProductIds);
  if (groupsError) return { data: null, error: mapError(groupsError) };

  const groupIds = (groups ?? []).map((group) => group.id);
  const { data: options, error: optionsError } = groupIds.length
    ? await supabase.from("modifier_options").select("*").in("modifier_group_id", groupIds)
    : { data: [], error: null };
  if (optionsError) return { data: null, error: mapError(optionsError) };

  const { data: sourceCategories, error: categoriesError } = await supabase
    .from("categories")
    .select("*")
    .eq("organization_id", input.organizationId)
    .in("id", sourceCategoryIds);
  if (categoriesError) return { data: null, error: mapError(categoriesError) };

  const categoriesById = new Map((sourceCategories ?? []).map((category) => [category.id, category]));
  const sourceProducts = productRows.map((row) => mapProduct(row, variants ?? [], groups ?? [], options ?? []));
  const summary: CopyProductsAcrossBranchesSummary = { created: 0, updated: 0, skipped: 0 };
  const rollbackSteps: Array<() => Promise<void>> = [];
  async function rollbackAndReturn(error: unknown) {
    await runRollbackSteps(rollbackSteps);
    return { data: null, error: mapError(error instanceof Error ? error : (error as { message?: string })) };
  }

  for (const targetStoreId of targetStoreIds) {
    const menuLinkIds = sourceProducts.map((product) => product.menuLinkId ?? product.id);
    const { data: targetProductRows, error: targetProductsError } = await supabase
      .from("products")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("store_id", targetStoreId)
      .in("menu_link_id", menuLinkIds);
    if (targetProductsError) return rollbackAndReturn(targetProductsError);

    const targetProductIds = (targetProductRows ?? []).map((product) => product.id);
    const { data: targetVariants, error: targetVariantsError } = targetProductIds.length
      ? await supabase.from("product_variants").select("*").in("product_id", targetProductIds)
      : { data: [], error: null };
    if (targetVariantsError) return rollbackAndReturn(targetVariantsError);

    const { data: targetGroups, error: targetGroupsError } = targetProductIds.length
      ? await supabase.from("modifier_groups").select("*").in("product_id", targetProductIds)
      : { data: [], error: null };
    if (targetGroupsError) return rollbackAndReturn(targetGroupsError);

    const targetGroupIds = (targetGroups ?? []).map((group) => group.id);
    const { data: targetOptions, error: targetOptionsError } = targetGroupIds.length
      ? await supabase.from("modifier_options").select("*").in("modifier_group_id", targetGroupIds)
      : { data: [], error: null };
    if (targetOptionsError) return rollbackAndReturn(targetOptionsError);

    const existingProducts = new Map(
      (targetProductRows ?? []).map((row) => [
        row.menu_link_id,
        mapProduct(row, targetVariants ?? [], targetGroups ?? [], targetOptions ?? []),
      ]),
    );

    const { data: targetCategories, error: targetCategoriesError } = await supabase
      .from("categories")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("store_id", targetStoreId);
    if (targetCategoriesError) return rollbackAndReturn(targetCategoriesError);

    const targetCategoriesByName = new Map(
      (targetCategories ?? []).map((category) => [normalizeNameKey(category.name), category]),
    );

    const templateCopyError = await copyCatalogTemplateLibrary(supabase, {
      sourceStoreId: input.sourceStoreId,
      targetStoreId,
      rollbackSteps,
    });
    if (templateCopyError) return rollbackAndReturn(templateCopyError);

    for (const sourceProduct of sourceProducts) {
      const menuLinkId = sourceProduct.menuLinkId ?? sourceProduct.id;
      const existingProduct = existingProducts.get(menuLinkId) ?? undefined;
      if (existingProduct && input.duplicateMode === "skip") {
        summary.skipped += 1;
        continue;
      }

      const sourceCategory = categoriesById.get(sourceProduct.categoryId);
      if (!sourceCategory) {
        return rollbackAndReturn(new Error(`ไม่พบหมวดหมู่ของ ${sourceProduct.name}`));
      }

      let targetCategory = targetCategoriesByName.get(normalizeNameKey(sourceCategory.name));
      if (!targetCategory) {
        const { data: createdCategory, error: categoryCreateError } = await supabase
          .from("categories")
          .insert({
            store_id: targetStoreId,
            organization_id: input.organizationId,
            name: sourceCategory.name,
            description: sourceCategory.description,
            sort_order: sourceCategory.sort_order,
            is_active: sourceCategory.is_active,
          })
          .select()
          .single();
        if (categoryCreateError) return rollbackAndReturn(categoryCreateError);
        targetCategory = createdCategory;
        targetCategoriesByName.set(normalizeNameKey(createdCategory.name), createdCategory);
        rollbackSteps.push(async () => {
          await supabase
            .from("categories")
            .delete()
            .eq("id", createdCategory.id)
            .eq("store_id", targetStoreId);
        });
      }

      const productPayload = {
        organization_id: input.organizationId,
        store_id: targetStoreId,
        category_id: targetCategory.id,
        menu_link_id: menuLinkId,
        name: sourceProduct.name,
        description: sourceProduct.description ?? null,
        barcode: sourceProduct.barcode ?? null,
        image_url: sourceProduct.imageUrl ?? null,
        base_price:
          input.priceMode === "preserve" && existingProduct
            ? existingProduct.basePrice
            : sourceProduct.basePrice,
        is_active: sourceProduct.isActive,
        available_for_pos: sourceProduct.availableForPos,
        available_for_qr: sourceProduct.availableForQr,
        sort_order: sourceProduct.sortOrder,
      };

      let targetProductId = existingProduct?.id;
      if (existingProduct) {
        const { error: updateError } = await supabase
          .from("products")
          .update({
            ...productPayload,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingProduct.id)
          .eq("store_id", targetStoreId);
        if (updateError) return rollbackAndReturn(updateError);

        rollbackSteps.push(async () => restoreExistingProductSnapshot(supabase, existingProduct));
        const childrenError = await deleteProductChildren(supabase, existingProduct.id);
        if (childrenError) return rollbackAndReturn(childrenError);
        summary.updated += 1;
      } else {
        const { data: createdProduct, error: createError } = await supabase
          .from("products")
          .insert(productPayload)
          .select()
          .single();
        if (createError) return rollbackAndReturn(createError);
        targetProductId = createdProduct.id;
        rollbackSteps.push(async () => deleteCopiedProduct(supabase, createdProduct.id));
        summary.created += 1;
      }

      if (!targetProductId) {
        return rollbackAndReturn(new Error("สร้างสินค้าปลายทางไม่สำเร็จ"));
      }

      const cloneError = await cloneProductChildren(supabase, sourceProduct, targetProductId, {
        priceMode: input.priceMode,
        existingProduct,
      });
      if (cloneError) return rollbackAndReturn(cloneError);
    }
  }

  return { data: summary, error: null };
}

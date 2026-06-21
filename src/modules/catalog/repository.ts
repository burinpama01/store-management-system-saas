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
    name: row.name,
    description: row.description ?? undefined,
    barcode: row.barcode ?? undefined,
    imageUrl: row.image_url ?? undefined,
    basePrice: row.base_price,
    isActive: row.is_active,
    availableForPos: row.available_for_pos,
    availableForQr: row.available_for_qr,
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
  name: string;
  description?: string;
  barcode?: string;
  imageUrl?: string;
  basePrice?: number;
  availableForPos?: boolean;
  availableForQr?: boolean;
  sortOrder?: number;
}

export async function createProduct(input: CreateProductInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("products")
    .insert({
      store_id: input.storeId,
      organization_id: input.organizationId,
      category_id: input.categoryId,
      name: input.name,
      description: input.description,
      barcode: input.barcode ?? null,
      image_url: input.imageUrl,
      base_price: input.basePrice ?? 0,
      available_for_pos: input.availableForPos ?? true,
      available_for_qr: input.availableForQr ?? false,
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
      | "sortOrder"
      | "categoryId"
    >
  >,
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

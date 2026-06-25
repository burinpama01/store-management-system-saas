import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { DEFAULT_THEME } from "@/modules/theme/presets";
import { mapError } from "@/shared/utils/error";
import type { Store, Table } from "@/modules/stores/types";
import type { Category, Product, ProductVariant, ModifierGroup, ModifierOption } from "@/modules/catalog/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type StoreRow = Database["public"]["Tables"]["stores"]["Row"];
type TableRow = Database["public"]["Tables"]["tables"]["Row"];
type CategoryRow = Database["public"]["Tables"]["categories"]["Row"];
type ProductRow = Database["public"]["Tables"]["products"]["Row"];
type VariantRow = Database["public"]["Tables"]["product_variants"]["Row"];
type ModGroupRow = Database["public"]["Tables"]["modifier_groups"]["Row"];
type ModOptionRow = Database["public"]["Tables"]["modifier_options"]["Row"];

export function mapStore(row: StoreRow): Store {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    logoUrl: row.logo_url ?? undefined,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    locale: row.locale,
    isActive: row.is_active,
    buffetEnabled: row.buffet_enabled,
    qrOrderingEnabled: row.qr_ordering_enabled,
    dineInDurationMinutes: row.dine_in_duration_minutes,
    themePresetId: row.theme_preset_id ?? DEFAULT_THEME.presetId,
    themePrimaryColor: row.theme_primary_color ?? DEFAULT_THEME.primaryColor,
    themePrimaryStrongColor: row.theme_primary_strong_color ?? DEFAULT_THEME.primaryStrongColor,
    themePrimarySoftColor: row.theme_primary_soft_color ?? DEFAULT_THEME.primarySoftColor,
    themeAccentColor: row.theme_accent_color ?? DEFAULT_THEME.accentColor,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTable(row: TableRow): Table {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    number: row.number,
    label: row.label ?? undefined,
    seats: row.seats ?? undefined,
    isActive: row.is_active,
    qrEnabled: row.qr_enabled,
    currentSessionId: row.current_session_id ?? undefined,
    sessionStartedAt: row.session_started_at ?? undefined,
    sessionExpiresAt: row.session_expires_at ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
    priceAdjustment: row.price_adjustment,
    sku: row.sku ?? undefined,
    stockQuantity: row.stock_quantity ?? undefined,
    trackStock: row.track_stock,
    isActive: row.is_active,
    sortOrder: row.sort_order,
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

function mapModifierGroup(row: ModGroupRow, options: ModOptionRow[]): ModifierGroup {
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
    imageUrl: row.image_url ?? undefined,
    basePrice: row.base_price,
    isActive: row.is_active,
    availableForPos: row.available_for_pos,
    availableForQr: row.available_for_qr,
    kitchenStationId: row.kitchen_station_id ?? undefined,
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

export async function getStoreBySlug(slug: string, options: { requireQrOrdering?: boolean } = {}) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("stores")
    .select("*")
    .eq("slug", slug)
    .eq("is_active", true);
  if (options.requireQrOrdering ?? true) query = query.eq("qr_ordering_enabled", true);

  const { data, error } = await query.single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapStore(data), error: null };
}

export async function getTableById(tableId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .select("*")
    .eq("id", tableId)
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapTable(data), error: null };
}

export async function listPublicTables(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .select("*")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .eq("qr_enabled", true)
    .order("number");
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapTable), error: null };
}

export async function listPublicMenu(storeId: string) {
  const supabase = await createSupabaseServerClient();

  const [categoriesRes, productsRes] = await Promise.all([
    supabase.from("categories").select("*").eq("store_id", storeId).eq("is_active", true).order("sort_order"),
    supabase
      .from("products")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .eq("available_for_qr", true)
      .not("kitchen_station_id", "is", null)
      .order("sort_order"),
  ]);

  if (categoriesRes.error) return { data: null, error: mapError(categoriesRes.error) };
  if (productsRes.error) return { data: null, error: mapError(productsRes.error) };

  const productRows = productsRes.data ?? [];
  const categories = (categoriesRes.data ?? []).map(mapCategory);

  if (productRows.length === 0) {
    return { data: { categories, products: [] as Product[] }, error: null };
  }

  const kitchenStationIds = [
    ...new Set(productRows.map((p) => p.kitchen_station_id).filter((id): id is string => Boolean(id))),
  ];
  const stationsRes = kitchenStationIds.length > 0
    ? await supabase
        .from("kitchen_stations")
        .select("id")
        .eq("store_id", storeId)
        .eq("is_active", true)
        .in("id", kitchenStationIds)
    : { data: [], error: null };
  if (stationsRes.error) return { data: null, error: mapError(stationsRes.error) };

  const activeKitchenStationIds = new Set((stationsRes.data ?? []).map((station) => station.id));
  const routableProductRows = productRows.filter(
    (product) =>
      product.kitchen_station_id !== null &&
      activeKitchenStationIds.has(product.kitchen_station_id),
  );

  if (routableProductRows.length === 0) {
    return { data: { categories, products: [] as Product[] }, error: null };
  }

  const productIds = routableProductRows.map((p) => p.id);

  const [variantsRes, groupsRes] = await Promise.all([
    supabase.from("product_variants").select("*").in("product_id", productIds).eq("is_active", true),
    supabase.from("modifier_groups").select("*").in("product_id", productIds),
  ]);

  if (variantsRes.error) return { data: null, error: mapError(variantsRes.error) };
  if (groupsRes.error) return { data: null, error: mapError(groupsRes.error) };

  const groupIds = (groupsRes.data ?? []).map((g) => g.id);
  const optionsRes =
    groupIds.length > 0
      ? await supabase.from("modifier_options").select("*").in("modifier_group_id", groupIds).eq("is_active", true)
      : { data: [], error: null };

  if (optionsRes.error) return { data: null, error: mapError(optionsRes.error) };

  const products = routableProductRows.map((row) =>
    mapProduct(row, variantsRes.data ?? [], groupsRes.data ?? [], optionsRes.data ?? []),
  );

  return { data: { categories, products }, error: null };
}

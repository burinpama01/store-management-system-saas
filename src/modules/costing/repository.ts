/**
 * Store Cost Engine — Supabase queries (ใช้ client ของผู้ใช้ → ผ่าน RLS ระดับ manager)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import {
  DEFAULT_STORE_COST_SETTINGS,
  type AllocationPcts,
  type AllocationTemplate,
  type Ingredient,
  type IngredientInput,
  type PriceRounding,
  type ProductCostSetting,
  type RecipeLine,
  type StoreCostSettings,
} from "./types";

interface StoreScope {
  organizationId: string;
  storeId: string;
}

export interface CostingWorkspace {
  ingredients: Ingredient[];
  recipeLines: RecipeLine[];
  productSettings: ProductCostSetting[];
  templates: AllocationTemplate[];
  settings: StoreCostSettings;
  /** GP สูงสุดของช่องทางเดลิเวอรีที่เปิดอยู่ (null = ไม่ได้เชื่อม) */
  deliveryCommissionPct: number | null;
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));

export async function loadCostingWorkspace(storeId: string): Promise<{ data: CostingWorkspace | null; error: string | null }> {
  const supabase = await createSupabaseServerClient();
  const [ingredientsRes, linesRes, productRes, templatesRes, settingsRes, channelRes] = await Promise.all([
    supabase.from("ingredients").select("*").eq("store_id", storeId).order("name"),
    supabase.from("recipe_lines").select("id, product_id, variant_id, ingredient_id, quantity").eq("store_id", storeId),
    supabase.from("product_cost_settings").select("product_id, packaging_cost, target_food_cost_pct").eq("store_id", storeId),
    supabase.from("cost_allocation_templates").select("*").eq("store_id", storeId).order("effective_from", { ascending: false }),
    supabase.from("store_cost_settings").select("*").eq("store_id", storeId).maybeSingle(),
    // เลือกเฉพาะคอลัมน์ที่ต้องใช้ — ตารางนี้มี webhook_secret
    supabase.from("connect_channel_links").select("commission_rate, status").eq("store_id", storeId).eq("status", "active"),
  ]);
  const firstError = [ingredientsRes, linesRes, productRes, templatesRes, settingsRes].find((r) => r.error)?.error;
  if (firstError) return { data: null, error: mapError(firstError).userMessage };

  const settingsRow = settingsRes.data;
  const commissions = (channelRes.data ?? []).map((row) => num(row.commission_rate)).filter((v) => v > 0);
  return {
    data: {
      ingredients: (ingredientsRes.data ?? []).map((row) => ({
        id: row.id,
        storeId: row.store_id,
        name: row.name,
        purchaseUnit: row.purchase_unit,
        usageUnit: row.usage_unit,
        usagePerPurchase: num(row.usage_per_purchase),
        purchasePrice: num(row.purchase_price),
        yieldPct: num(row.yield_pct),
        isActive: row.is_active,
      })),
      recipeLines: (linesRes.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        variantId: row.variant_id,
        ingredientId: row.ingredient_id,
        quantity: num(row.quantity),
      })),
      productSettings: (productRes.data ?? []).map((row) => ({
        productId: row.product_id,
        packagingCost: num(row.packaging_cost),
        targetFoodCostPct: row.target_food_cost_pct === null ? null : num(row.target_food_cost_pct),
      })),
      templates: (templatesRes.data ?? []).map((row) => ({
        id: row.id,
        productId: row.product_id,
        effectiveFrom: row.effective_from,
        pcts: {
          ingredient: num(row.ingredient_pct),
          packaging: num(row.packaging_pct),
          labor: num(row.labor_pct),
          overhead: num(row.overhead_pct),
          profit: num(row.profit_pct),
        },
      })),
      settings: settingsRow
        ? {
            openDaysPerMonth: settingsRow.open_days_per_month,
            targetProfitMonthly: num(settingsRow.target_profit_monthly),
            targetFoodCostPct: num(settingsRow.target_food_cost_pct),
            otherVariablePct: num(settingsRow.other_variable_pct),
            priceRounding: settingsRow.price_rounding as PriceRounding,
            cashReserve: settingsRow.cash_reserve === null ? null : num(settingsRow.cash_reserve),
          }
        : DEFAULT_STORE_COST_SETTINGS,
      deliveryCommissionPct: commissions.length > 0 ? Math.max(...commissions) : null,
    },
    error: null,
  };
}

/** บันทึกวัตถุดิบ — ราคาซื้อเปลี่ยนให้เก็บประวัติด้วย */
export async function saveIngredient(scope: StoreScope, input: IngredientInput, userId: string) {
  const supabase = await createSupabaseServerClient();
  const payload = {
    organization_id: scope.organizationId,
    store_id: scope.storeId,
    name: input.name.trim(),
    purchase_unit: input.purchaseUnit.trim(),
    usage_unit: input.usageUnit.trim(),
    usage_per_purchase: input.usagePerPurchase,
    purchase_price: input.purchasePrice,
    yield_pct: input.yieldPct,
    updated_at: new Date().toISOString(),
  };

  let previousPrice: number | null = null;
  if (input.id) {
    const existing = await supabase.from("ingredients").select("purchase_price").eq("id", input.id).eq("store_id", scope.storeId).maybeSingle();
    if (existing.error) return { data: null, error: mapError(existing.error).userMessage };
    if (!existing.data) return { data: null, error: "ไม่พบวัตถุดิบนี้" };
    previousPrice = num(existing.data.purchase_price);
  }

  const result = input.id
    ? await supabase.from("ingredients").update(payload).eq("id", input.id).eq("store_id", scope.storeId).select("id").single()
    : await supabase.from("ingredients").insert(payload).select("id").single();
  if (result.error) {
    if (result.error.code === "23505") return { data: null, error: "มีวัตถุดิบชื่อนี้อยู่แล้ว" };
    return { data: null, error: mapError(result.error).userMessage };
  }

  if (previousPrice === null || previousPrice !== input.purchasePrice) {
    // ประวัติราคาเป็นข้อมูลประกอบ — บันทึกไม่ได้ไม่ควรทำให้การแก้วัตถุดิบล้ม
    await supabase.from("ingredient_price_history").insert({
      ingredient_id: result.data.id,
      purchase_price: input.purchasePrice,
      recorded_by: userId,
    });
  }
  return { data: { id: result.data.id, priceChanged: previousPrice !== null && previousPrice !== input.purchasePrice }, error: null };
}

export async function deleteIngredient(storeId: string, ingredientId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("ingredients").delete().eq("id", ingredientId).eq("store_id", storeId);
  if (error) {
    // FK restrict จาก recipe_lines
    if (error.code === "23503") return { error: "วัตถุดิบนี้ยังอยู่ในสูตรเมนู — เอาออกจากสูตรก่อน" };
    return { error: mapError(error).userMessage };
  }
  return { error: null };
}

/**
 * แทนที่สูตรของเมนูทั้งชุด — ใส่บรรทัดใหม่ก่อน แล้วค่อยลบชุดเดิม
 * (ใส่ไม่ผ่านจะไม่เสียสูตรเดิม)
 */
export async function replaceRecipe(
  scope: StoreScope,
  productId: string,
  lines: Array<{ variantId: string | null; ingredientId: string; quantity: number }>,
) {
  const supabase = await createSupabaseServerClient();
  const existing = await supabase.from("recipe_lines").select("id").eq("store_id", scope.storeId).eq("product_id", productId);
  if (existing.error) return { error: mapError(existing.error).userMessage };
  if (lines.length > 0) {
    const inserted = await supabase.from("recipe_lines").insert(
      lines.map((line) => ({
        organization_id: scope.organizationId,
        store_id: scope.storeId,
        product_id: productId,
        variant_id: line.variantId,
        ingredient_id: line.ingredientId,
        quantity: line.quantity,
      })),
    );
    if (inserted.error) return { error: mapError(inserted.error).userMessage };
  }
  const oldIds = (existing.data ?? []).map((row) => row.id);
  if (oldIds.length > 0) {
    const removed = await supabase.from("recipe_lines").delete().in("id", oldIds).eq("store_id", scope.storeId);
    if (removed.error) return { error: mapError(removed.error).userMessage };
  }
  return { error: null };
}

export async function saveProductCostSetting(
  scope: StoreScope,
  productId: string,
  input: { packagingCost: number; targetFoodCostPct: number | null },
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("product_cost_settings").upsert({
    product_id: productId,
    organization_id: scope.organizationId,
    store_id: scope.storeId,
    packaging_cost: input.packagingCost,
    target_food_cost_pct: input.targetFoodCostPct,
    updated_at: new Date().toISOString(),
  });
  return { error: error ? mapError(error).userMessage : null };
}

/** สัดส่วนใหม่ = แถวใหม่ (ประวัติเดิมไม่เปลี่ยน รายงานย้อนหลังใช้ค่าที่มีผล ณ วันขาย) */
export async function insertAllocationTemplate(scope: StoreScope, productId: string | null, pcts: AllocationPcts, userId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("cost_allocation_templates").insert({
    organization_id: scope.organizationId,
    store_id: scope.storeId,
    product_id: productId,
    ingredient_pct: pcts.ingredient,
    packaging_pct: pcts.packaging,
    labor_pct: pcts.labor,
    overhead_pct: pcts.overhead,
    profit_pct: pcts.profit,
    created_by: userId,
  });
  return { error: error ? mapError(error).userMessage : null };
}

/** เลิกใช้สัดส่วนเฉพาะเมนู → กลับไปใช้ของร้าน */
export async function clearProductAllocation(storeId: string, productId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("cost_allocation_templates").delete().eq("store_id", storeId).eq("product_id", productId);
  return { error: error ? mapError(error).userMessage : null };
}

export async function saveStoreCostSettings(scope: StoreScope, input: Pick<StoreCostSettings, "targetFoodCostPct" | "priceRounding">) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_cost_settings").upsert({
    store_id: scope.storeId,
    organization_id: scope.organizationId,
    target_food_cost_pct: input.targetFoodCostPct,
    price_rounding: input.priceRounding,
    updated_at: new Date().toISOString(),
  });
  return { error: error ? mapError(error).userMessage : null };
}

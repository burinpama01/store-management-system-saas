/**
 * จุดคุ้มทุน — Supabase queries (client ของผู้ใช้ → ผ่าน RLS)
 * store_cost_budgets: manager · accounting_categories เขียน: cashflow.manage · payroll_periods อ่าน: attendance manager
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import { groupActualExpenses, isCostType, summarizeFixedCosts, type ActualFixedCosts, type BudgetKind, type CostBudget, type CostType } from "./break-even";
import type { PriceRounding, StoreCostSettings } from "./types";

interface StoreScope {
  organizationId: string;
  storeId: string;
}

const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const PAGE = 1000;

export async function listCostBudgets(storeId: string): Promise<{ data: CostBudget[]; error: string | null }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("store_cost_budgets")
    .select("id, kind, cost_type, name, amount, useful_life_months, is_active")
    .eq("store_id", storeId)
    .order("kind")
    .order("created_at")
    .limit(500);
  if (error) return { data: [], error: mapError(error).userMessage };
  return {
    data: (data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind as BudgetKind,
      costType: (isCostType(row.cost_type) ? row.cost_type : "other") as CostType,
      name: row.name,
      amount: num(row.amount),
      usefulLifeMonths: row.useful_life_months === null ? null : num(row.useful_life_months),
      isActive: row.is_active,
    })),
    error: null,
  };
}

export async function saveCostBudget(
  scope: StoreScope,
  input: { id: string | null; kind: BudgetKind; costType: CostType; name: string; amount: number; usefulLifeMonths: number | null; isActive: boolean },
) {
  const supabase = await createSupabaseServerClient();
  const payload = {
    organization_id: scope.organizationId,
    store_id: scope.storeId,
    kind: input.kind,
    cost_type: input.costType,
    name: input.name,
    amount: input.amount,
    useful_life_months: input.kind === "startup" ? input.usefulLifeMonths : null,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  const result = input.id
    ? await supabase.from("store_cost_budgets").update(payload).eq("id", input.id).eq("store_id", scope.storeId).select("id")
    : await supabase.from("store_cost_budgets").insert(payload).select("id");
  if (result.error) return { id: null, error: mapError(result.error).userMessage };
  // RLS ปฏิเสธแบบเงียบ = 0 แถว (บทเรียน transaction delete)
  const id = result.data?.[0]?.id ?? null;
  if (!id) return { id: null, error: "บันทึกไม่สำเร็จ — ไม่มีสิทธิ์หรือไม่พบรายการ" };
  return { id, error: null };
}

export async function deleteCostBudget(storeId: string, id: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("store_cost_budgets").delete().eq("id", id).eq("store_id", storeId).select("id");
  if (error) return { error: mapError(error).userMessage };
  if (!data || data.length === 0) return { error: "ลบไม่สำเร็จ — ไม่มีสิทธิ์หรือไม่พบรายการ" };
  return { error: null };
}

/** บันทึกค่าตั้งจุดคุ้มทุน (คอลัมน์ที่มีอยู่แล้วใน store_cost_settings) — ไม่แตะ food cost/การปัดราคา */
export async function saveBreakEvenSettings(
  scope: StoreScope,
  input: Pick<StoreCostSettings, "openDaysPerMonth" | "targetProfitMonthly" | "otherVariablePct">,
  current: Pick<StoreCostSettings, "targetFoodCostPct" | "priceRounding">,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_cost_settings").upsert({
    store_id: scope.storeId,
    organization_id: scope.organizationId,
    open_days_per_month: input.openDaysPerMonth,
    target_profit_monthly: input.targetProfitMonthly,
    other_variable_pct: input.otherVariablePct,
    // upsert แถวใหม่ต้องมีค่าครบ — ใช้ค่าปัจจุบัน (หรือค่าเริ่มต้น) ไม่เปลี่ยนของเดิม
    target_food_cost_pct: current.targetFoodCostPct,
    price_rounding: current.priceRounding as PriceRounding,
    updated_at: new Date().toISOString(),
  });
  return { error: error ? mapError(error).userMessage : null };
}

export interface ExpenseCategory {
  id: string;
  name: string;
  costType: CostType | null;
}

export async function listExpenseCategories(storeId: string): Promise<{ data: ExpenseCategory[]; error: string | null }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_categories")
    .select("id, name, cost_type")
    .eq("store_id", storeId)
    .eq("type", "expense")
    .order("sort_order")
    .limit(300);
  if (error) return { data: [], error: mapError(error).userMessage };
  return { data: (data ?? []).map((row) => ({ id: row.id, name: row.name, costType: isCostType(row.cost_type) ? row.cost_type : null })), error: null };
}

export async function setCategoryCostType(storeId: string, categoryId: string, costType: CostType | null) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_categories")
    .update({ cost_type: costType, updated_at: new Date().toISOString() })
    .eq("id", categoryId)
    .eq("store_id", storeId)
    .eq("type", "expense")
    .select("id");
  if (error) return { error: mapError(error).userMessage };
  if (!data || data.length === 0) return { error: "บันทึกไม่สำเร็จ — ต้องมีสิทธิ์จัดการบัญชีรายรับรายจ่าย" };
  return { error: null };
}

/** รายจ่ายจริงช่วงหนึ่ง รวมตามประเภทต้นทุนของหมวด (ดึงทีละหน้า กันเพดาน 1,000 แถว) */
export async function loadActualFixedCosts(
  storeId: string,
  range: { from: string; to: string },
  categories: ExpenseCategory[],
): Promise<{ data: Pick<ActualFixedCosts, "byType" | "unmapped"> & { count: number }; error: string | null }> {
  const supabase = await createSupabaseServerClient();
  const typeByCategory = new Map(categories.map((c) => [c.id, c.costType]));
  const rows: Array<{ amount: number; costType: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("transactions")
      .select("id, amount, category_id")
      .eq("store_id", storeId)
      .eq("type", "expense")
      .gte("date", range.from)
      .lte("date", range.to)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) return { data: { byType: {}, unmapped: 0, count: 0 }, error: mapError(error).userMessage };
    for (const row of data ?? []) rows.push({ amount: num(row.amount), costType: typeByCategory.get(row.category_id) ?? null });
    if (!data || data.length < PAGE) break;
  }
  return { data: { ...groupActualExpenses(rows), count: rows.length }, error: null };
}

/** งวดเงินเดือนล่าสุดที่ปิดแล้ว (อ่านไม่ได้ = ไม่มีสิทธิ์/ไม่ได้ใช้ระบบเงินเดือน → null)
 *  งวด reopened = กำลังแก้ ยอดยังไม่นิ่ง → ข้าม */
export async function loadLatestPayroll(storeId: string): Promise<{ netPay: number; periodStart: string; periodEnd: string } | null> {
  const supabase = await createSupabaseServerClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payroll_periods ยังไม่อยู่ใน database.types
  const db = supabase as any;
  const { data, error } = await db
    .from("payroll_periods")
    .select("period_start, period_end, total_net_pay")
    .eq("store_id", storeId)
    .eq("status", "closed")
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { netPay: num(data.total_net_pay), periodStart: String(data.period_start), periodEnd: String(data.period_end) };
}

/**
 * ฐานจุดคุ้มทุนสำหรับคำแนะนำในรายงานเชิงลึก — อ่านผ่าน RLS (manager) ผู้ใช้ที่ไม่มีสิทธิ์ได้ null
 * ไม่ log เมื่ออ่านไม่ได้ เพราะเป็นข้อมูลเสริม (หน้า /costing/break-even log อยู่แล้ว)
 */
export async function loadBreakEvenBasis(storeId: string): Promise<{ fixedMonthly: number; openDaysPerMonth: number; otherVariablePct: number } | null> {
  const [budgets, settingsRes] = await Promise.all([
    listCostBudgets(storeId),
    (await createSupabaseServerClient()).from("store_cost_settings").select("open_days_per_month, other_variable_pct").eq("store_id", storeId).maybeSingle(),
  ]);
  if (budgets.error || budgets.data.length === 0) return null;
  const fixed = summarizeFixedCosts(budgets.data);
  if (!(fixed.total > 0)) return null;
  return {
    fixedMonthly: fixed.total,
    openDaysPerMonth: settingsRes.data?.open_days_per_month ?? 26,
    otherVariablePct: settingsRes.data ? num(settingsRes.data.other_variable_pct) : 0,
  };
}

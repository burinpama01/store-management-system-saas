import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canSettleAtDailyClose } from "@/modules/consignment/access-policy";
import { consignmentErrorMessage } from "@/modules/consignment/repository";
import {
  unitEconomics,
  validateAdjust,
  validateReceive,
  validateReportRange,
  validateSourcing,
} from "@/modules/consignment/validate";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
const c12 = norm(read("supabase/migrations/20261204120000_consignment_c1_c2.sql"));
const c34 = norm(read("supabase/migrations/20261205120000_consignment_c3_c4.sql"));

const P = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const G = "33333333-3333-4333-8333-333333333333";
const O1 = "44444444-4444-4444-8444-444444444444";
const O2 = "55555555-5555-4555-8555-555555555555";

describe("unit economics", () => {
  it("per unit / resale uses the unit cost", () => {
    expect(unitEconomics({ price: 35, mode: "consignment", pricing: "per_unit", storePct: null, unitCost: 25 })).toEqual({ cost: 25, profit: 10, marginPct: 28.6 });
    expect(unitEconomics({ price: 40, mode: "resale", pricing: null, storePct: null, unitCost: 30 })).toEqual({ cost: 30, profit: 10, marginPct: 25 });
  });
  it("percent: owner gets price × (100 − store%)", () => {
    expect(unitEconomics({ price: 20, mode: "consignment", pricing: "percent", storePct: 20, unitCost: null })).toEqual({ cost: 16, profit: 4, marginPct: 20 });
  });
  it("made / missing cost → nothing", () => {
    expect(unitEconomics({ price: 50, mode: "made", pricing: null, storePct: null, unitCost: 10 }).cost).toBeNull();
    expect(unitEconomics({ price: 50, mode: "resale", pricing: null, storePct: null, unitCost: null }).profit).toBeNull();
  });
});

describe("sourcing validation", () => {
  const base = { productId: P, mode: "consignment" as const, supplierId: S, pricing: "per_unit" as const, storePct: null, unitCost: 25, optionGroupId: null, optionCosts: [] };

  it("made clears everything", () => {
    const r = validateSourcing({ ...base, mode: "made" });
    expect("value" in r && r.value).toMatchObject({ mode: "made", supplierId: null, unitCost: null, optionCosts: [] });
  });
  it("requires an owner and a pricing for consignment", () => {
    expect(validateSourcing({ ...base, supplierId: null })).toEqual({ error: "เลือกเจ้าของสินค้า" });
    expect(validateSourcing({ ...base, pricing: null })).toEqual({ error: "เลือกวิธีคิดเงินกับเจ้าของ" });
  });
  it("percent needs 0 < pct < 100 and no unit cost", () => {
    expect(validateSourcing({ ...base, pricing: "percent", storePct: 100, unitCost: null })).toHaveProperty("error");
    const ok = validateSourcing({ ...base, pricing: "percent", storePct: 20, unitCost: null });
    expect("value" in ok && ok.value.storePct).toBe(20);
  });
  it("needs a cost unless every flavor has one", () => {
    expect(validateSourcing({ ...base, unitCost: null })).toEqual({ error: "ใส่ราคาจ่ายเจ้าของต่อชิ้น" });
    const flavors = validateSourcing({ ...base, unitCost: null, optionGroupId: G, optionCosts: [{ optionId: O1, unitCost: 25 }, { optionId: O2, unitCost: 28 }] });
    expect("value" in flavors).toBe(true);
    expect(validateSourcing({ ...base, mode: "resale", pricing: null, unitCost: null })).toEqual({ error: "ใส่ราคาซื้อต่อชิ้น" });
  });
  it("drops option costs when no flavor group", () => {
    const r = validateSourcing({ ...base, optionCosts: [{ optionId: O1, unitCost: 1 }] });
    expect("value" in r && r.value.optionCosts).toEqual([]);
  });
});

describe("receive validation", () => {
  const base = { supplierId: S, mode: "consignment" as const, lines: [{ productId: P, optionId: O1, qty: 3, unitCost: 25 }], expiresOn: null, note: null, paymentMethod: null };
  it("sums total and ignores zero-qty rows", () => {
    const r = validateReceive({ ...base, lines: [...base.lines, { productId: P, optionId: O2, qty: 0, unitCost: 28 }] });
    expect("value" in r && r.value.total).toBe(75);
    expect("value" in r && r.value.lines.length).toBe(1);
  });
  it("rejects duplicates, decimals and missing payment for resale", () => {
    expect(validateReceive({ ...base, lines: [base.lines[0], base.lines[0]] })).toEqual({ error: "มีเมนู/รสซ้ำในรายการรับของ" });
    expect(validateReceive({ ...base, lines: [{ ...base.lines[0], qty: 1.5 }] })).toHaveProperty("error");
    expect(validateReceive({ ...base, mode: "resale" })).toEqual({ error: "เลือกจ่ายเงินสดหรือโอน" });
  });
  it("consignment never sends a payment method", () => {
    const r = validateReceive({ ...base, paymentMethod: "cash" });
    expect("value" in r && r.value.paymentMethod).toBeNull();
  });
});

describe("adjust + report range validation", () => {
  it("only count_adjust may be negative", () => {
    expect(validateAdjust({ lotId: P, kind: "damage", qty: -1, note: null })).toHaveProperty("error");
    expect("value" in validateAdjust({ lotId: P, kind: "count_adjust", qty: -1, note: null })).toBe(true);
    expect(validateAdjust({ lotId: P, kind: "return_owner", qty: 0, note: null })).toHaveProperty("error");
  });
  it("report range ≤ 92 days, ordered", () => {
    expect(validateReportRange("2026-11-01", "2026-11-22")).toEqual({ from: "2026-11-01", to: "2026-11-22" });
    expect(validateReportRange("2026-11-22", "2026-11-01")).toHaveProperty("error");
    expect(validateReportRange("2026-01-01", "2026-12-31")).toHaveProperty("error");
  });
});

describe("daily close access", () => {
  it("cashier and up, only when enterprise + enabled", () => {
    expect(canSettleAtDailyClose({ hasConsignment: true, role: "cashier", enabled: true })).toBe(true);
    expect(canSettleAtDailyClose({ hasConsignment: true, role: "staff", enabled: true })).toBe(false);
    expect(canSettleAtDailyClose({ hasConsignment: true, role: "owner", enabled: false })).toBe(false);
    expect(canSettleAtDailyClose({ hasConsignment: false, role: "owner", enabled: true })).toBe(false);
  });
});

describe("error messages", () => {
  it("maps RPC errors to Thai without leaking SQL", () => {
    expect(consignmentErrorMessage("settlement amount changed")).toContain("ยอดเปลี่ยน");
    expect(consignmentErrorMessage("product still has resale stock")).toContain("ของคงเหลือ");
    expect(consignmentErrorMessage("syntax error at or near")).toBe("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("C1+C2 migration contracts", () => {
  it("sourcing columns can only change through the RPC", () => {
    expect(c12).toContain("resale settings must be changed via consignment_save_product");
    expect(c12).toContain("create trigger products_resale_guard before insert or update on public.products");
    expect(c12).toContain("create trigger modifier_options_resale_guard before insert or update on public.modifier_options");
  });
  it("made products exit the order-item trigger immediately and the sale never fails", () => {
    expect(c12).toContain("if v_mode is null or v_mode = 'made' then return new;");
    expect(c12).toMatch(/exception when others then raise warning 'resale stock failed/);
  });
  it("runs after the cost snapshot trigger and covers insert/update/delete + order status", () => {
    expect(c12).toContain("create trigger zz_order_items_resale_insert after insert on public.order_items");
    expect(c12).toContain("after update of voided, quantity on public.order_items");
    expect(c12).toContain("create trigger zz_order_items_resale_delete before delete on public.order_items");
    expect(c12).toContain("create trigger zz_orders_resale_status after update of status on public.orders");
    expect(c12).toContain("and new.merged_into_order_id is null");
  });
  it("FIFO lock on lots and auto hide/show only what the system hid", () => {
    expect(c12).toContain("order by received_at, id for update");
    expect(c12).toContain("where id = p_option_id and resale_auto_hidden");
    expect(c12).toContain("where id = p_product_id and resale_auto_oos");
  });
  it("all writing RPCs check manager + enterprise + store switch", () => {
    expect(c12).toContain("public.organization_has_consignment(p_org)");
    expect(c12).toContain("consignment is not enabled for this store");
    for (const fn of ["consignment_save_product", "consignment_receive_lots", "consignment_assign_flavor"]) {
      expect(c12).toContain(`revoke all on function public.${fn}(`);
    }
    expect(c12).toContain("revoke all on function public.resale_deduct(uuid, uuid, uuid, uuid, int, numeric, boolean) from public, anon, authenticated");
  });
  it("ledger tables are read-only to clients", () => {
    expect(c12).toContain("create policy \"resale_lots_manager_select\" on public.resale_lots for select");
    expect(c12).toContain("create policy \"resale_movements_manager_select\" on public.resale_movements for select");
    expect(c12).not.toMatch(/on public\.resale_(lots|movements) for (insert|update|delete|all)/);
  });
  it("restores latest-taken rows first by a deterministic sequence (created_at ties in one transaction)", () => {
    expect(c12).toContain("seq bigint generated always as identity");
    expect(c12).toContain("order by m.seq desc for update");
  });
  it("cash payouts are checked against the drawer inside the DB (direct RPC cannot overdraw)", () => {
    expect(c12).toContain("raise exception 'insufficient cash in drawer'");
    expect(c12).toContain("raise exception 'cash session is not open'");
  });
  it("item cost is recomputed after every deduct/restore (qty increase too)", () => {
    expect((c12.match(/perform public\.resale_refresh_item_cost\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("flavor group cannot switch A→B while stock remains", () => {
    expect(c12).toContain("mo.modifier_group_id = v_group");
  });
  it("cash expense locks the ledger per store", () => {
    expect(c12).toContain("pg_advisory_xact_lock(hashtext('cash_ledger:' || p_store::text))");
  });
});

describe("C3+C4 migration contracts", () => {
  it("only paid, non-voided sales are billable; unpaid wait; cancelled close at 0", () => {
    expect(c34).toContain("when o.status = 'paid' then 'billable'");
    expect(c34).toContain("when o.status in ('voided', 'cancelled', 'refunded') then 'dead'");
    expect(c34).toContain("else 'pending'");
  });
  it("settle locks the owner, rechecks the expected total and claws back refunds", () => {
    expect(c34).toContain("from public.suppliers where id = p_supplier_id for update");
    expect(c34).toContain("raise exception 'settlement amount changed'");
    expect(c34).toContain("clawback_settlement_id = v_id");
    expect(c34).toContain("greatest(-v_total, 0)");
  });
  it("cashier may only settle daily_close in cash", () => {
    expect(c34).toContain("case when p_trigger = 'daily_close' and p_method = 'cash' then 'cashier' else 'manager' end");
  });
  it("liability: resale → store, consignment → owner; return/buyout only for consignment", () => {
    expect(c34).toContain("v_liab := case when v_l.mode = 'resale' then 'store' else 'owner' end");
    expect(c34).toContain("raise exception 'only consignment lots'");
  });
  it("settle totals only the rows it locked (no race with concurrent sales)", () => {
    expect(c34).toContain("order by m.seq for update");
    expect(c34).toContain("v_total := round(v_due - v_claw - v_carry, 2)");
  });
  it("read RPCs also require enterprise", () => {
    expect((c34.match(/raise exception 'consignment requires enterprise plan'/g) ?? []).length).toBe(2);
  });
  it("percent buyout pays price × (100 − store%)", () => {
    expect(c34).toContain("(p.base_price + coalesce(o.price_adjustment, 0)) * (100 - p.consign_store_pct) / 100 * p_qty");
  });
  it("daily report is manager-only and bounded", () => {
    expect(c34).toContain("p_to - p_from > 92");
    expect(c34).toContain("at time zone 'asia/bangkok'");
  });
});

describe("wiring", () => {
  it("every operation action goes through the access gate and logs", () => {
    const src = read("src/app/(dashboard)/consignment/operations-actions.ts");
    const exported = src.match(/export async function \w+/g) ?? [];
    expect(exported.length).toBe(8);
    expect(src).toContain('source: "consignment"');
    expect((src.match(/await operator\(\)/g) ?? []).length).toBe(5);
  });
  it("cash payouts check the drawer first", () => {
    const src = read("src/app/(dashboard)/consignment/operations-actions.ts");
    expect(src).toContain("await cashShortage(");
  });
  it("cash close shows the consignment step", () => {
    expect(read("src/app/pos/CashSessionPanel.tsx")).toContain("<ConsignmentCloseStep onSettled={() => router.refresh()} />");
  });
});

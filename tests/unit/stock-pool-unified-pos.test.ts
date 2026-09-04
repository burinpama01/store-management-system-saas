import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

const UNIFIED = "supabase/migrations/20260905000006_stock_pool_unified_pos.sql";
const ORDER_RPCS = "supabase/migrations/20260905000004_stock_pool_order_rpcs.sql";

/** ตัดเอาเฉพาะตัวฟังก์ชันหนึ่งตัวจากไฟล์ migration (จบที่ $$; ของตัวเอง) */
function fn(sql: string, header: string): string {
  const start = sql.indexOf(header);
  expect(start, `not found: ${header}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end === -1 ? undefined : end);
}

describe("Stock Pool × Unified POS", () => {
  const sql = normalized(read(UNIFIED));

  it("ไม่ทับฟังก์ชันที่ Unified POS เขียนใหม่ไว้แล้วด้วย body เก่า", () => {
    // 20260901000004 เปลี่ยน void_qr_order_item เป็น wrapper ของ Unified POS
    // migration ของ Stock Pool ที่เลขน้อยกว่าห้ามนิยามทับ (จะรันทีหลังแล้วย้อนของใหม่)
    const orderRpcs = normalized(read(ORDER_RPCS));
    expect(orderRpcs).not.toContain("create or replace function public.void_qr_order_item(");

    // ตัว wrapper ตัวจริงถูกยกมาไว้ที่ 000006 พร้อมเส้นทาง unified ครบ
    expect(sql).toContain("create or replace function public.void_qr_order_item(");
    expect(sql).toContain("public.unified_pos_reject_order_item(");
    expect(sql).toContain("v_operation_key := 'legacy_void:'");
  });

  it("submit: ตรวจ Pool ก่อนเขียน, snapshot ทุกเส้นทาง, หักเฉพาะ qr", () => {
    const submit = fn(sql, "create or replace function public.unified_pos_submit_table_order");

    // ตรวจก่อน insert เพื่อให้คืน error แบบมีโครงสร้างได้ (ยังไม่มีอะไรต้อง rollback)
    expect(submit).toContain("public.unified_pos_items_stock_pool_shortfall(");
    expect(submit).toContain("up_stock_insufficient");
    expect(submit.indexOf("unified_pos_items_stock_pool_shortfall"))
      .toBeLessThan(submit.indexOf("insert into orders"));

    // staff ต้อง snapshot ไว้ตั้งแต่ตอนสร้าง แล้วค่อยหักตอน settle
    expect(submit).toContain("perform public.snapshot_order_item_stock_pools(v_order_id, p_store_id, p_organization_id);");
    expect(submit).toContain("if p_source = 'qr' then perform public.deduct_order_stock_pools(");
  });

  it("settle: หัก Pool ของบิลพนักงานในกิ่งเดียวกับ variant stock", () => {
    const settle = fn(sql, "create or replace function public.unified_pos_settle_table_order");
    expect(settle).toContain("if not v_order.qr_order_source then");
    expect(settle).toContain("public.unified_pos_order_stock_pool_shortfall(v_order.id)");
    expect(settle).toContain("perform public.deduct_order_stock_pools( v_order.id, p_store_id, p_organization_id, p_actor_user_id );");
  });

  it("reject/cancel: คืน Pool และห้ามคืน variant stock ซ้ำ", () => {
    const reject = fn(sql, "create or replace function public.unified_pos_reject_order_item");
    expect(reject).toContain("v_pool_managed := public.restore_voided_order_item_stock_pool(");
    expect(reject).toContain("if v_item.variant_id is not null and not v_pool_managed then");
    expect(reject.indexOf("restore_voided_order_item_stock_pool"))
      .toBeLessThan(reject.indexOf("update public.product_variants pv"));

    const cancel = fn(sql, "create or replace function public.unified_pos_cancel_table_order");
    expect(cancel).toContain("perform public.restore_cancelled_order_stock_pools(");
    expect(cancel).toContain("and stock_pool_id is null");

    const voidFn = fn(sql, "create or replace function public.void_qr_order_item");
    expect(voidFn).toContain("v_pool_managed := public.restore_voided_order_item_stock_pool(");
    expect(voidFn).toContain("if v_variant is not null and not v_pool_managed then");
  });

  it("variant ที่ผูก Pool ต้องไม่ถูกตัด/คืนจาก product_variants.stock_quantity", () => {
    const submit = fn(sql, "create or replace function public.unified_pos_submit_table_order");
    // ลูป variant stock ต้องกรอง variant ที่ผูก Pool ออก มิฉะนั้นจะตัดสองที่
    expect(submit).toContain("select 1 from variant_stock_links l where l.variant_id = item.variant_id");

    const settle = fn(sql, "create or replace function public.unified_pos_settle_table_order");
    expect(settle).toContain("and item.stock_pool_id is null");
  });

  it("helper ตรวจสต๊อกล็อก Pool ตามลำดับ id และผูก tenant ไว้", () => {
    const shortfall = fn(sql, "create or replace function public.unified_pos_items_stock_pool_shortfall");
    expect(shortfall).toContain("order by l.stock_pool_id");
    expect(shortfall).toContain("for update");
    expect(shortfall).toContain("v_pool.store_id is distinct from p_store_id");
    expect(shortfall).toContain("v_pool.organization_id is distinct from p_organization_id");
    expect(sql).toContain("revoke execute on function public.unified_pos_items_stock_pool_shortfall(uuid, uuid, jsonb) from anon, authenticated;");
  });
});

describe("Stock Pool เป็นแหล่งความจริงเดียวของสต๊อกฝั่งแอป", () => {
  it("catalog แนบ Pool มากับ variant ทุกครั้งที่โหลดสินค้า", () => {
    const repo = read("src/modules/catalog/repository.ts");
    const types = read("src/modules/catalog/types.ts");

    expect(types).toContain("export interface VariantStockPool");
    expect(types).toContain("stockPool?: VariantStockPool");
    expect(repo).toContain("export async function loadVariantStockPools");
    expect(repo).toContain('.from("variant_stock_links")');
    expect(repo).toContain('.from("stock_pools")');
    // ทั้ง listProducts และ getProduct ต้องแนบ Pool (POS/QR อ่านจากสองทางนี้)
    expect(repo.match(/loadVariantStockPools\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("ตะกร้า POS ใช้ยอด Pool ไม่ใช่ stock_quantity ที่ค้างอยู่", () => {
    const cart = read("src/modules/pos/server-cart.ts");
    expect(cart).toContain("const pool = variant.stockPool;");
    expect(cart).toContain("`pool:${pool.poolId}`");
    expect(cart).toContain("quantity * pool.consumptionQuantity");
    expect(cart).toContain("สต๊อก ${pool.poolName} เหลือไม่พอ");
  });

  it("ด่านสั่งอาหาร QR ใช้ยอด Pool เช่นกัน", () => {
    const qr = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(qr).toContain("loadVariantStockPools");
    expect(qr).toContain("const pool = poolByVariant.get(variant.id);");
    expect(qr).toContain("item.quantity * pool.consumptionQuantity");
  });

  it("ทุก action ของ Stock Pool เขียน log ลง system_event_logs", () => {
    const actions = read("src/app/(dashboard)/stock/actions.ts");
    expect(actions).toContain("logSystemEvent");
    expect(actions).toContain('source: "stock.pool"');
    for (const action of [
      "createStockPool",
      "linkVariantToStockPool",
      "adjustStockPool",
      "createVariantFromStock",
      "setVariantStock",
    ]) {
      expect(actions).toContain(`action: "${action}"`);
    }
    // ต้อง log ทั้งทางสำเร็จและทางล้มเหลว (ห้าม "สำเร็จแบบเงียบ")
    expect(actions.match(/ok: true,/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(actions.match(/ok: false, message:/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("สิทธิ์ระดับ DB หมดอายุพร้อมแพ็กเกจเหมือนฝั่งแอป", () => {
    const entitlement = normalized(read("supabase/migrations/20260905000002_stock_pool_adjustment_rpc.sql"));
    expect(entitlement).toContain("(s.plan = 'enterprise' and s.current_period_end > now())");
    expect(entitlement).not.toContain("or s.plan = 'enterprise' or (");
  });
});

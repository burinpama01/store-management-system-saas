import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { passLineExtraPrice } from "@/modules/prepaid-passes/rules";
import { replaceCartItems, emptyCart } from "@/modules/pos/cart";

const read = (path: string) => readFileSync(path, "utf8");
const ICED = { id: "iced", priceAdjustment: 5 };
const SHOT = { id: "shot", priceAdjustment: 10 };
const LARGE = { id: "large", priceAdjustment: 10 };

describe("แพ็กครอบคลุมตัวเลือก (อเมริกาโน่เย็น 10 แก้ว ฿350, เย็น +5)", () => {
  it("ตัวเลือกที่รวมในแพ็กไม่คิดเงิน", () => {
    expect(passLineExtraPrice({ variant: null, modifierOptions: [ICED], coveredVariantIds: [], coveredOptionIds: ["iced"] })).toBe(0);
  });

  it("แพ็กไม่รวมตัวเลือก → ลูกค้าจ่ายส่วนต่าง (เย็น +5)", () => {
    expect(passLineExtraPrice({ variant: null, modifierOptions: [ICED], coveredVariantIds: [], coveredOptionIds: [] })).toBe(5);
  });

  it("รวมเย็นแต่เพิ่มช็อต (ไม่รวม) → จ่ายเฉพาะช็อต; ขนาดใหญ่ที่ไม่รวมก็จ่ายเพิ่ม", () => {
    expect(passLineExtraPrice({ variant: null, modifierOptions: [ICED, SHOT], coveredVariantIds: [], coveredOptionIds: new Set(["iced"]) })).toBe(10);
    expect(passLineExtraPrice({ variant: LARGE, modifierOptions: [ICED], coveredVariantIds: [], coveredOptionIds: ["iced"] })).toBe(10);
    expect(passLineExtraPrice({ variant: LARGE, modifierOptions: [ICED], coveredVariantIds: ["large"], coveredOptionIds: ["iced"] })).toBe(0);
  });

  it("ตัวเลือกลดราคา (ติดลบ) ไม่ทำให้ยอดติดลบ", () => {
    expect(passLineExtraPrice({ variant: null, modifierOptions: [{ id: "less", priceAdjustment: -5 }], coveredVariantIds: [], coveredOptionIds: [] })).toBe(0);
  });

  it("เพิ่มบรรทัดแพ็กที่มีส่วนต่างแล้วยอดตะกร้าคำนวณใหม่", () => {
    const cart = replaceCartItems(emptyCart("s1"), [
      { key: "p", productId: "a", productName: "อเมริกาโน่", categoryId: "c", variant: null, modifiers: [], quantity: 2, unitPrice: 5, totalPrice: 0, prepaidPassId: "pass" },
    ]);
    expect(cart.total).toBe(10);
  });
});

describe("ฐานข้อมูล + เส้นทางราคา", () => {
  const sql = read("supabase/migrations/20261122120000_prepaid_pass_covered_options.sql");
  const actions = read("src/app/pos/actions.ts");
  it("ตารางตัวเลือก/ขนาดของแพ็ก + ตรวจว่าเป็นของเมนูในแพ็ก + RPC ตัวเลือกที่ครอบคลุม", () => {
    expect(sql).toContain("create table if not exists public.prepaid_pass_plan_modifier_options");
    expect(sql).toContain("create table if not exists public.prepaid_pass_plan_variants");
    expect(sql).toContain("ตัวเลือกที่รวมในแพ็กต้องเป็นของเมนูที่เลือก");
    expect(sql).toContain("create or replace function public.prepaid_pass_covered_options");
    expect(sql).toContain("revoke all on table public.prepaid_pass_plan_modifier_options from anon, authenticated;");
    expect(sql).toContain("'covered_option_ids'");
  });
  it("server คิดราคาบรรทัดแพ็กจาก catalog + ตัวเลือกที่แพ็กครอบคลุม (ไม่เชื่อราคาจาก POS)", () => {
    expect(actions).toContain("await getPassCoveredOptions(item.prepaidPassId!, ctx.storeId, product.id)");
    expect(actions).toContain("const extra = passLineExtraPrice({");
    expect(actions).toContain("resolveModifiers(product, item.modifiers.map((modifier) => modifier.option.id))");
  });
  it("POS เปิดหน้าต่างตัวเลือกตอนใช้แพ็ก และคำนวณยอดใหม่ทุกครั้ง", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("pass,\n      });");
    expect(pos).toContain("commitCart(replaceCartItems(cartRef.current, [...cartRef.current.items, passLine]));");
  });
});

describe("หลังรีวิว", () => {
  const sql = read("supabase/migrations/20261122120000_prepaid_pass_covered_options.sql");
  it("RPC ตัวเลือกที่ครอบคลุมตรวจสมาชิกสาขา + องค์กรเดียวกับแพ็ก", () => {
    expect(sql).toContain("p_store_id not in (select auth_user_store_ids())");
    expect(sql).toContain("raise exception 'ไม่มีสิทธิ์ดูข้อมูลแพ็กนี้';");
  });
  it("รายการแพ็กใน POS เรียกตัวเลือกที่ครอบคลุมครั้งเดียวต่อเมนู", () => {
    expect(sql).toContain("select p.id as pid, public.prepaid_pass_covered_options(ps.id, p_store_id, p.id) as cov");
  });
});

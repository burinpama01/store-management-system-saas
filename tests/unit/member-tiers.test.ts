import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIERS,
  cycleEnd,
  cycleStart,
  meetsTier,
  rankFor,
  tierProgress,
  validateTierProgram,
  type TierProgramInput,
} from "@/modules/member-tiers/rules";
import { buildSettingsTabs } from "@/app/(dashboard)/settings/settings-tabs";
import { resolvePermissions } from "@/modules/auth/permission-resolver";
import type { BillingPlan, BillingState } from "@/modules/billing/types";

const read = (path: string) => readFileSync(path, "utf8");
const MIGRATION = "supabase/migrations/20261118120000_member_tiers.sql";

function program(overrides: Partial<TierProgramInput> = {}): TierProgramInput {
  return { metricMode: "both", cycleMonths: 6, downgradeOneStep: false, tiers: DEFAULT_TIERS, ...overrides };
}

describe("ตั้งค่าระดับ", () => {
  it("ค่าเริ่มต้นแบบ Shopee ผ่านการตรวจ", () => {
    expect(validateTierProgram(program())).toBeNull();
    expect(DEFAULT_TIERS.map((t) => t.name)).toEqual(["Classic", "Silver", "Gold", "Platinum"]);
  });

  it("เกณฑ์ระดับสูงต้องไม่ต่ำกว่าระดับก่อนหน้า และมี 2–6 ระดับ", () => {
    const broken = DEFAULT_TIERS.map((t) => (t.rank === 2 ? { ...t, minSpend: 100 } : t));
    expect(validateTierProgram(program({ tiers: broken }))).toContain("ต้องไม่ต่ำกว่า");
    expect(validateTierProgram(program({ tiers: [DEFAULT_TIERS[0]] }))).toContain("2–6");
  });

  it("โหมดต้องถึงทั้งคู่ ห้ามเกณฑ์ 0 ข้อใดข้อหนึ่ง (review MINOR-2); either ตั้งข้อเดียวพอ", () => {
    const zeroOrders = DEFAULT_TIERS.map((t) => (t.rank === 1 ? { ...t, minOrders: 0 } : t));
    expect(validateTierProgram(program({ tiers: zeroOrders }))).toContain("ต้องถึงทั้งคู่");
    expect(validateTierProgram(program({ metricMode: "either", tiers: zeroOrders }))).toBeNull();
    expect(read(MIGRATION)).toContain("โหมดต้องถึงทั้งคู่ ต้องตั้งยอดซื้อและจำนวนบิลของทุกระดับให้มากกว่า 0");
  });

  it("บันทึกเกณฑ์ล็อกโปรแกรม และครบรอบรอด้วย for share (review MAJOR-1) + index ย้อนหลัง", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("from public.member_tier_programs where organization_id = v_org for update;");
    expect(sql).toContain("where organization_id = v_status.organization_id for share;");
    expect(sql).toContain("create index if not exists orders_org_paid_at_idx");
  });

  it("โหมดยอดซื้ออย่างเดียวต้องตั้งยอดซื้อ", () => {
    const noSpend = DEFAULT_TIERS.map((t) => (t.rank === 1 ? { ...t, minSpend: 0 } : t));
    expect(validateTierProgram(program({ metricMode: "spend", tiers: noSpend }))).toContain("ยอดซื้อ");
  });
});

describe("วัดระดับ 4 แบบ (T1) — ตรงกับ SQL member_tier_rank_for", () => {
  const gold = DEFAULT_TIERS[2]; // 7,500 บาท / 24 บิล
  it("both = ต้องถึงทั้งคู่ (แบบ Shopee)", () => {
    expect(meetsTier("both", 8000, 30, gold)).toBe(true);
    expect(meetsTier("both", 8000, 10, gold)).toBe(false);
  });
  it("either = ถึงอย่างใดอย่างหนึ่ง", () => {
    expect(meetsTier("either", 8000, 10, gold)).toBe(true);
    expect(meetsTier("either", 100, 30, gold)).toBe(true);
    expect(meetsTier("either", 100, 10, gold)).toBe(false);
  });
  it("spend / orders อย่างเดียว", () => {
    expect(meetsTier("spend", 7500, 0, gold)).toBe(true);
    expect(meetsTier("orders", 0, 24, gold)).toBe(true);
  });
  it("rankFor คืนระดับสูงสุดที่ถึง", () => {
    expect(rankFor("both", DEFAULT_TIERS, 39, 1)).toBe(0);
    expect(rankFor("both", DEFAULT_TIERS, 1500, 6)).toBe(1);
    expect(rankFor("both", DEFAULT_TIERS, 31000, 60)).toBe(3);
  });
});

describe("รอบตามเวลาไทย (T2)", () => {
  it("ครึ่งปี: ม.ค.–มิ.ย. / ก.ค.–ธ.ค.", () => {
    expect(cycleStart(new Date("2026-11-15T03:00:00Z"), 6)).toBe("2026-07-01");
    expect(cycleStart(new Date("2026-03-01T03:00:00Z"), 6)).toBe("2026-01-01");
    expect(cycleEnd("2026-07-01", 6)).toBe("2026-12-31");
  });
  it("ขอบวัน: 30 มิ.ย. 23:30 เวลาไทย ยังเป็นรอบแรก, 1 ก.ค. 00:30 เวลาไทยเป็นรอบสอง", () => {
    expect(cycleStart(new Date("2026-06-30T16:30:00Z"), 6)).toBe("2026-01-01");
    expect(cycleStart(new Date("2026-06-30T17:30:00Z"), 6)).toBe("2026-07-01");
  });
  it("ไตรมาสและรายปี", () => {
    expect(cycleStart(new Date("2026-11-15T03:00:00Z"), 3)).toBe("2026-10-01");
    expect(cycleEnd("2026-10-01", 3)).toBe("2026-12-31");
    expect(cycleStart(new Date("2026-11-15T03:00:00Z"), 12)).toBe("2026-01-01");
  });
});

describe("ความคืบหน้าแบบหน้าจอ Shopee", () => {
  it("Gold มียอด 1 บิล ฿39 → เพื่อรักษา 1/24 และ ฿39/7,500; ถัดไป Platinum", () => {
    const p = tierProgress("both", DEFAULT_TIERS, 2, 39, 1);
    expect(p.keep).toEqual([
      { label: "จำนวนบิล", current: 1, target: 24, unit: "orders" },
      { label: "ยอดซื้อ", current: 39, target: 7500, unit: "baht" },
    ]);
    expect(p.next?.tier.name).toBe("Platinum");
  });
  it("ระดับแรกไม่มีเกณฑ์รักษา และระดับสูงสุดไม่มีระดับถัดไป", () => {
    expect(tierProgress("both", DEFAULT_TIERS, 0, 0, 0).keep).toEqual([]);
    expect(tierProgress("both", DEFAULT_TIERS, 3, 0, 0).next).toBeNull();
  });
});

describe("migration ระดับสมาชิก", () => {
  const sql = read(MIGRATION);

  it("trigger บนออเดอร์ไม่ทำให้การชำระ/void ล้ม (จับ exception เป็น warning)", () => {
    const trig = sql.slice(sql.indexOf("function public.member_tiers_on_order_status"), sql.indexOf("drop trigger if exists member_tiers_on_order_status"));
    expect(trig).toContain("exception when others then");
    expect(trig).toContain("raise warning");
    expect(trig).not.toMatch(/raise exception/);
    expect(trig).toContain("coalesce(new.total, 0) > 0");
  });

  it("บันทึกยอดครั้งเดียวต่อบิล/คำสั่งซื้อ (idempotent)", () => {
    expect(sql).toContain("unique (source_type, source_id, kind)");
    expect(sql).toContain("on conflict (source_type, source_id, kind) do nothing");
  });

  it("ขึ้นระดับทันที แต่ void ไม่ลดระดับทันที (ไปตัดสินตอนครบรอบ)", () => {
    expect(sql).toContain("if p_kind = 'sale' and not v_status.locked then");
    expect(sql).toContain("'ยอดถึงเกณฑ์ ขึ้นระดับทันที'");
  });

  it("ครบรอบ: ถึงเกณฑ์เดิม = คง, ไม่ถึง = ลด (ทีละขั้นถ้าเลือก), ล็อกไม่ถูกประเมิน", () => {
    const roll = sql.slice(sql.indexOf("function public.member_tier_rollover"), sql.indexOf("function public.record_member_tier_activity"));
    expect(roll).toContain("if v_met >= v_new then");
    expect(roll).toContain("greatest(v_met, v_new - 1)");
    expect(roll).toContain("if not v_status.locked then");
    expect(roll).toContain("while v_cycle < v_current loop");
  });

  it("รอบคิดตามเวลาไทย และ cron ทุกวัน 00:15", () => {
    expect(sql).toContain("(p_at at time zone 'Asia/Bangkok')");
    expect(sql).toContain("select cron.schedule('rollover-member-tiers', '15 17 * * *'");
  });

  it("ตั้งค่า/เปิดใช้/ตั้งระดับเองได้เฉพาะ owner/admin และฟังก์ชันภายในปิดสิทธิ์", () => {
    expect(sql.match(/auth_user_role_in_store\(v_org, p_store_id, 'admin'\)/g)?.length).toBe(4);
    expect(sql).toContain("revoke all on function public.record_member_tier_activity(uuid, text, uuid, text, numeric, integer, timestamptz) from public, anon, authenticated;");
    expect(sql).toContain("revoke all on table public.member_tier_activity from anon, authenticated;");
  });

  it("เปิดใช้ครั้งแรกมีโหมดดูตัวอย่าง (dry run) และย้อนหลังใช้ยอดรอบที่แล้ว + รอบนี้", () => {
    expect(sql).toContain("if not p_dry_run then");
    expect(sql).toContain("= v_previous), 0)");
    expect(sql).toContain("'counts', v_counts");
  });
});

describe("ทางเข้า", () => {
  function state(plan: BillingPlan): BillingState {
    return { plan, status: "active", currentPeriodEnd: "2099-01-01T00:00:00Z", cancelAtPeriodEnd: false, trialEnd: null };
  }
  it("แท็บระดับสมาชิกเฉพาะ owner/admin ของร้าน Enterprise", () => {
    const hrefs = (role: "owner" | "manager", plan: BillingPlan) =>
      buildSettingsTabs(resolvePermissions(role, [], "org", "store"), state(plan)).map((tab) => tab.href);
    expect(hrefs("owner", "enterprise")).toContain("/settings/member-tiers");
    expect(hrefs("manager", "enterprise")).not.toContain("/settings/member-tiers");
    expect(hrefs("owner", "premium")).not.toContain("/settings/member-tiers");
  });

  it("หน้าสมาชิกแสดงระดับเฉพาะร้าน Enterprise และ POS แสดงระดับหลังยืนยันรหัส", () => {
    expect(read("src/app/member/[storeSlug]/page.tsx")).toContain("portalData.store && portalData.customer && portalData.memberPrivileges");
    const actions = read("src/app/pos/actions.ts");
    expect(actions).toContain("const tierView = access.privileges");
  });
});

describe("P2b สิทธิ์ตามระดับ = โค้ดพิเศษรายเดือน", () => {
  const sql = read("supabase/migrations/20261118130000_member_tier_benefits.sql");

  it("ตรวจสิทธิ์ก่อนบันทึก", async () => {
    const { validateTierBenefit, describeBenefit } = await import("@/modules/member-tiers/rules");
    const base = { minRank: 2, name: "ส่วนลด Gold", discountType: "amount" as const, discountValue: 20, minSubtotal: 100, usesPerMonth: 2 };
    expect(validateTierBenefit(base, 3)).toBeNull();
    expect(validateTierBenefit({ ...base, minRank: 0 }, 3)).toContain("ระดับ");
    expect(validateTierBenefit({ ...base, minRank: 4 }, 3)).toContain("ระดับ");
    expect(validateTierBenefit({ ...base, discountType: "percentage", discountValue: 120 }, 3)).toContain("100%");
    expect(validateTierBenefit({ ...base, usesPerMonth: 0 }, 3)).toContain("1–31");
    expect(describeBenefit(base)).toBe("ลด ฿20 ขั้นต่ำ ฿100");
    expect(describeBenefit({ discountType: "percentage", discountValue: 10, minSubtotal: 0 })).toBe("ลด 10%");
  });

  it("T3: ใช้โค้ดระดับต้องผูกสมาชิก ยืนยันรหัสที่ยังไม่หมดอายุในสาขานั้น และระดับถึง — บังคับใน DB ทุกช่องทาง", () => {
    const trig = sql.slice(sql.indexOf("function public.enforce_member_tier_coupon"), sql.indexOf("drop trigger if exists enforce_member_tier_coupon"));
    expect(trig).toContain("if new.customer_id is null then");
    expect(trig).toContain("v.customer_id = new.customer_id and v.store_id = new.store_id and v.expires_at > now()");
    expect(trig).toContain("if coalesce(v_rank, 0) < v_benefit.min_rank then");
    expect(trig).toContain("return new; -- คูปองธรรมดา");
    expect(sql).toContain("before insert on public.coupon_redemptions");
  });

  it("คูปองรายเดือน: รหัสสุ่ม ใช้ได้เฉพาะเดือนนั้น จำกัดครั้งต่อคน และสร้างครั้งเดียวต่อสาขาต่อเดือน", () => {
    expect(sql).toContain("v_code := 'TR' || upper(substr(md5(gen_random_uuid()::text), 1, 8));");
    expect(sql).toContain("primary key (benefit_id, store_id, month_start)");
    expect(sql).toContain("v_starts, v_ends, null, v_row.uses_per_month");
    expect(sql).toContain("select cron.schedule('ensure-member-tier-coupons', '20 17 * * *'");
  });

  it("กันสร้างคูปองซ้ำพร้อมกัน + ซ่อน/ล็อกคูปองระดับจากหน้าคูปองปกติ (review MAJOR-1/2)", () => {
    expect(sql).toContain("perform pg_advisory_xact_lock(hashtextextended(v_row.id::text || ':' || v_row.store_id::text || ':' || v_month::text, 0));");
    expect(sql).toContain("create index if not exists member_verifications_customer_store_active_idx");
    const promo = read("src/modules/promotions/repository.ts");
    expect(promo).toContain('.is("member_tier_benefit_id" as never, null)');
    expect(promo).toContain("tier_coupon_locked");
  });

  it("แก้มูลค่าสิทธิ์ → ปิดคูปองเดือนนี้แล้วสร้างใหม่; เอาสิทธิ์ออก = ปิด ไม่ลบ", () => {
    expect(sql).toContain("update public.coupons set is_active = false, updated_at = now()");
    expect(sql).toContain("where organization_id = v_org and not (id = any(v_keep)) and is_active;");
  });

  it("บันทึกสิทธิ์ได้เฉพาะ owner/admin และฟังก์ชันภายในปิดสิทธิ์", () => {
    expect(sql).toContain("auth_user_role_in_store(v_org, p_store_id, 'admin')");
    expect(sql).toContain("revoke all on function public.enforce_member_tier_coupon() from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.ensure_member_tier_coupons(uuid) from public, anon, authenticated;");
  });

  it("POS แสดงโค้ดระดับหลังยืนยันรหัส และใช้ทางคูปองเดิม", () => {
    const actions = read("src/app/pos/actions.ts");
    expect(actions).toContain("listMemberTierCoupons(ctx.storeId, verified.data.customerId, tierView.rank)");
    const ui = read("src/app/pos/PosTerminal.tsx");
    expect(ui).toContain("onUseTierCoupon: (code: string) => handleApplyCoupon(code)");
  });
});

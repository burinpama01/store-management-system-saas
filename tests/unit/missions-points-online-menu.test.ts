import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MISSION_INPUT,
  MISSION_TEMPLATES,
  countOrderTowardMission,
  missionPayload,
  missionProgressText,
  missionRemainingText,
  rewardLabel,
  validateMissionInput,
  type MissionInput,
} from "@/modules/missions/rules";
import { missionReceiptRows } from "@/modules/printing/mission-lines";
import { buildMissionSms, SMS_MAX_CHARS } from "@/modules/missions/sms";

const read = (p: string) => readFileSync(p, "utf8");
const SQL = read("supabase/migrations/20261126120000_missions_points_spend_online_menu.sql");
const base: MissionInput = { ...EMPTY_MISSION_INPUT, name: "ภารกิจ", rewardType: "points", rewardPoints: 30 };
const lines = [
  { productId: "a", categoryId: "drink", quantity: 2, totalPrice: 130.5 },
  { productId: "b", categoryId: "cake", quantity: 1, totalPrice: 60 },
  { productId: "c", categoryId: "drink", quantity: 1, totalPrice: 0 },
];
const all = { scope: "all" as const, categoryIds: [], productIds: [], maxPerOrder: null };

describe("วิธีนับใหม่: ยอดซื้อ / จำนวนบิล", () => {
  it("ยอดซื้อนับเป็นบาทปัดลง ไม่นับบรรทัด ฿0 · ไม่เกินที่เหลือ", () => {
    expect(countOrderTowardMission(lines, { ...all, countMode: "spend" }, 10_000)).toBe(190);
    expect(countOrderTowardMission(lines, { ...all, countMode: "spend" }, 50)).toBe(50);
    expect(countOrderTowardMission(lines, { scope: "categories", categoryIds: ["drink"], productIds: [], maxPerOrder: null, countMode: "spend" }, 999)).toBe(130);
  });
  it("นับบิล: 1 ครั้งเมื่อยอดในขอบเขตถึงขั้นต่ำ · ขั้นต่ำ 0 = ซื้อครั้งแรก", () => {
    expect(countOrderTowardMission(lines, { ...all, countMode: "orders", minOrderTotal: 120 }, 5)).toBe(1);
    expect(countOrderTowardMission(lines, { ...all, countMode: "orders", minOrderTotal: 500 }, 5)).toBe(0);
    expect(countOrderTowardMission(lines, { ...all, countMode: "orders", minOrderTotal: 0 }, 5)).toBe(1);
    expect(countOrderTowardMission([], { ...all, countMode: "orders", minOrderTotal: 0 }, 5)).toBe(0);
  });
  it("ข้อความหน่วยตามวิธีนับ", () => {
    expect(missionProgressText("spend", 1580, 2000)).toBe("฿1,580/฿2,000");
    expect(missionProgressText("orders", 2, 5)).toBe("2/5 ครั้ง");
    expect(missionRemainingText("spend", 420)).toBe("อีก ฿420");
    expect(missionRemainingText(undefined, 2)).toBe("อีก 2 ชิ้น");
  });
  it("ตรวจข้อมูล: ยอดซื้อเป้าได้ถึง 1,000,000 · ชิ้น/บิลไม่เกิน 100 · แต้ม 1–100,000", () => {
    expect(validateMissionInput({ ...base, countMode: "spend", targetCount: 4400 })).toBeNull();
    expect(validateMissionInput({ ...base, countMode: "orders", targetCount: 101 })).not.toBeNull();
    expect(validateMissionInput({ ...base, rewardPoints: 0 })).not.toBeNull();
    expect(validateMissionInput({ ...base, rewardPoints: 200_000 })).not.toBeNull();
    const p = missionPayload(null, { ...base, countMode: "spend", targetCount: 1000, maxPerOrder: 2 });
    expect(p.max_per_order).toBeNull();
    expect(p.reward_points).toBe(30);
    expect(rewardLabel({ ...base, rewardPoints: 30 })).toBe("โบนัส 30 แต้ม");
    for (const t of MISSION_TEMPLATES) expect(validateMissionInput({ ...EMPTY_MISSION_INPUT, rewardProductId: "11111111-1111-4111-8111-111111111111", ...t.input } as MissionInput) === null || t.key === "try-new").toBe(true);
  });
});

describe("migration M3", () => {
  it("นับยอด/บิลใน trigger + snapshot ลงรอบตอนกดรับ", () => {
    expect(SQL).toContain("v_qty := floor(v_spend)::int;");
    expect(SQL).toContain("v_qty := case when v_spend > 0 and v_spend >= coalesce(v_e.min_order_total, 0) then 1 else 0 end;");
    expect(SQL).toContain("v_mission.count_mode, v_mission.min_order_total");
    expect(SQL).toContain("check (target_count between 1 and 1000000)");
  });
  it("รางวัลแต้ม: บวกเข้าบัญชี + ledger · กันออกซ้ำ · void หักคืนไม่ติดลบ · retry ไม่ให้ซ้ำ", () => {
    expect(SQL).toContain("if coalesce(v_e.reward_points_awarded, 0) > 0 then return null; end if;");
    expect(SQL).toContain("'โบนัสภารกิจ: ' || v_m.name");
    expect(SQL).toContain("least(points_balance, v_p.reward_points_awarded)");
    expect(SQL).toContain("where status = 'completed' and reward_redemption_id is null and reward_points_awarded = 0");
  });
  it("SMS: ใกล้ครบเฉพาะชิ้น/บิล · แจ้งรางวัลแต้มครั้งเดียว · claim คืนแต้ม", () => {
    expect(SQL).toContain("new.count_mode in ('items', 'orders')");
    expect(SQL).toContain("where kind = 'reward' and redemption_id is null and status in ('queued', 'sending', 'sent');");
    expect(SQL).toContain("drop function if exists public.claim_store_mission_sms(integer);");
    expect(SQL).toContain("reward_points := case when v_q.redemption_id is null then v_q.e_points else null end;");
    const msg = buildMissionSms({ kind: "reward", storeName: "each other II", storeSlug: "each-other-ii-f62fc0", missionName: "x", voucherExpiresAt: null, rewardPoints: 30 });
    expect(msg).toContain("ได้โบนัส 30 แต้ม");
    expect(msg.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
  });
  it("ใบเสร็จแสดงหน่วยตามวิธีนับ และรางวัลแต้ม", () => {
    const rows = missionReceiptRows([
      { name: "สะสมยอด", progress: 1580, targetCount: 2000, completed: false, countMode: "spend" },
      { name: "บิลแรก", progress: 1, targetCount: 1, completed: true, countMode: "orders", pointsReward: true },
    ]);
    expect(rows[0]).toEqual({ name: "สะสมยอด", progress: "฿1,580/฿2,000", note: "อีก ฿420 ได้รางวัล!" });
    expect(rows[1].note).toBe("ครบแล้ว! แต้มโบนัสเข้าบัญชีแล้ว");
  });
});

describe("สวิตช์ขายออนไลน์รายสินค้า", () => {
  it("คอลัมน์ค่าเริ่มต้นเปิด · หน้าสั่งออนไลน์กรอง (ทั้งเมนูและคิดราคา) · หลังร้านมีช่องติ๊ก", () => {
    expect(SQL).toContain("add column if not exists online_enabled boolean not null default true;");
    expect(read("src/modules/online-orders/menu.ts")).toContain('.eq("online_enabled", true);');
    expect(read("src/app/(dashboard)/catalog/CatalogManager.tsx")).toContain('name="availableOnline"');
    const actions = read("src/app/(dashboard)/catalog/actions.ts");
    expect(actions.split('availableOnline: formData.get("availableOnline") === "on"').length - 1).toBe(2);
    expect(read("src/modules/catalog/repository.ts")).toContain("availableOnline: row.online_enabled ?? true,");
  });
});

describe("หลังรีวิว M3", () => {
  it("สร้างภารกิจแต้มได้: insert/update หลักใส่ reward_points พร้อม reward_type (constraint ตรวจทันที)", () => {
    expect(SQL).toContain("count_mode, min_order_total, reward_points\n    ) values (");
    expect(SQL).toContain("v_mode, v_min_order, v_points\n    )");
    expect(SQL).toContain("count_mode = v_mode, min_order_total = v_min_order, reward_points = v_points,");
  });
  it("SMS แต้มที่ถูกหักคืนแล้วไม่ส่ง · key แต้มรางวัล deterministic", () => {
    expect(SQL).toContain("v_reason := 'แต้มโบนัสถูกยกเลิกแล้ว';");
    expect(SQL).not.toContain("'mission-points:' || v_e.id::text || ':' || gen_random_uuid()");
  });
  it("แต้มรางวัลต้องเป็นจำนวนเต็ม · copy ข้ามสาขาพาค่า online_enabled ไปด้วย", () => {
    expect(validateMissionInput({ ...base, rewardPoints: 30.5 })).not.toBeNull();
    const repo = read("src/modules/catalog/repository.ts");
    expect(repo).toContain("online_enabled: sourceProduct.availableOnline ?? true,");
    expect(repo).toContain("online_enabled: product.availableOnline ?? true,");
  });
});

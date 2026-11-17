import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MISSION_INPUT,
  MISSION_TEMPLATES,
  countOrderTowardMission,
  missionPayload,
  rewardLabel,
  validateMissionInput,
  type MissionInput,
} from "@/modules/missions/rules";

const read = (path: string) => readFileSync(path, "utf8");
const SQL = "supabase/migrations/20261125120000_store_missions.sql";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
const base: MissionInput = { ...EMPTY_MISSION_INPUT, name: "ดื่มครบ 6 แก้ว", rewardProductId: PRODUCT };

describe("ตรวจข้อมูลภารกิจ", () => {
  it("ภารกิจตั้งต้นที่กรอกครบผ่าน", () => {
    expect(validateMissionInput(base)).toBeNull();
  });
  it("ต้องมีชื่อ, ขอบเขตที่เลือกต้องไม่ว่าง, เป้า 1–100, เพดานต่อบิล 1–100 หรือว่าง", () => {
    expect(validateMissionInput({ ...base, name: "  " })).not.toBeNull();
    expect(validateMissionInput({ ...base, scope: "categories", categoryIds: [] })).not.toBeNull();
    expect(validateMissionInput({ ...base, scope: "products", productIds: [] })).not.toBeNull();
    expect(validateMissionInput({ ...base, targetCount: 0 })).not.toBeNull();
    expect(validateMissionInput({ ...base, targetCount: 101 })).not.toBeNull();
    expect(validateMissionInput({ ...base, maxPerOrder: 0 })).not.toBeNull();
    expect(validateMissionInput({ ...base, maxPerOrder: null })).toBeNull();
  });
  it("ต้องมีระยะเวลาหรือวันปิดอย่างน้อยหนึ่งอย่าง (ไม่ให้ภารกิจค้างตลอดไป)", () => {
    expect(validateMissionInput({ ...base, durationDays: null, joinEndsAt: null })).not.toBeNull();
    expect(validateMissionInput({ ...base, durationDays: null, joinEndsAt: "2026-12-31T16:59:59.000Z" })).toBeNull();
  });
  it("รางวัลสินค้าต้องเลือกเมนู · ส่วนลด % ไม่เกิน 100", () => {
    expect(validateMissionInput({ ...base, rewardProductId: null })).not.toBeNull();
    const discount = { ...base, rewardType: "discount" as const, rewardDiscountKind: "percentage" as const };
    expect(validateMissionInput({ ...discount, rewardDiscountValue: 120 })).not.toBeNull();
    expect(validateMissionInput({ ...discount, rewardDiscountValue: 20 })).toBeNull();
  });
  it("payload ล้างค่าที่ไม่ใช้ตามชนิดรางวัล/ขอบเขต", () => {
    const p = missionPayload(null, { ...base, scope: "all", productIds: [PRODUCT], rewardDiscountValue: 50 });
    expect(p.product_ids).toEqual([]);
    expect(p.reward_discount_value).toBeNull();
    expect(p.reward_product_id).toBe(PRODUCT);
  });
  it("เทมเพลตทุกตัวเติมชื่อ/เป้าไว้แล้ว", () => {
    for (const t of MISSION_TEMPLATES) {
      expect(t.input.name).toBeTruthy();
      expect(t.input.targetCount).toBeGreaterThan(0);
    }
    expect(rewardLabel({ rewardType: "discount", rewardDiscountKind: "amount", rewardDiscountValue: 30, rewardMinSubtotal: 100 })).toContain("฿100");
  });
});

describe("นับชิ้นของบิล (POS แสดง “บิลนี้ +N”) ตามกติกาเดียวกับ trigger", () => {
  const lines = [
    { productId: "a", categoryId: "drink", quantity: 3, totalPrice: 150 },
    { productId: "b", categoryId: "cake", quantity: 1, totalPrice: 80 },
    { productId: "c", categoryId: "drink", quantity: 1, totalPrice: 0 }, // คูปองสินค้าฟรี / ใช้แพ็ก
  ];
  it("ไม่นับบรรทัด ฿0 · เคารพขอบเขต", () => {
    expect(countOrderTowardMission(lines, { scope: "all", categoryIds: [], productIds: [], maxPerOrder: null }, 99)).toBe(4);
    expect(countOrderTowardMission(lines, { scope: "categories", categoryIds: ["drink"], productIds: [], maxPerOrder: null }, 99)).toBe(3);
    expect(countOrderTowardMission(lines, { scope: "products", categoryIds: [], productIds: ["b"], maxPerOrder: null }, 99)).toBe(1);
  });
  it("เพดานต่อบิล และไม่เกินที่เหลือของเป้า", () => {
    expect(countOrderTowardMission(lines, { scope: "all", categoryIds: [], productIds: [], maxPerOrder: 2 }, 99)).toBe(2);
    expect(countOrderTowardMission(lines, { scope: "all", categoryIds: [], productIds: [], maxPerOrder: null }, 1)).toBe(1);
  });
});

describe("migration ภารกิจ", () => {
  const sql = read(SQL);
  it("นับเฉพาะบิลที่จ่ายหลังกดรับ + ยังไม่หมดเขต + ร้านเปิดภารกิจ + ไม่นับบิลซ้ำ", () => {
    expect(sql).toContain("and e.joined_at <= v_paid_at");
    expect(sql).toContain("and (e.expires_at is null or e.expires_at > v_paid_at)");
    expect(sql).toContain("join public.stores s on s.id = e.store_id and s.missions_enabled");
    expect(sql).toContain("unique (enrollment_id, order_id, kind)");
  });
  it("ไม่นับบรรทัด ฿0 / สินค้าขายแพ็ก · เพดานต่อบิลจาก snapshot ของรอบ", () => {
    expect(sql).toContain("and oi.total_price > 0");
    expect(sql).toContain("pl.sale_product_id = oi.product_id");
    expect(sql).toContain("v_qty := least(v_qty, v_e.max_per_order)");
  });
  it("รอบใหม่ต้องกดรับเอง: ทำได้ทีละรอบ + ไม่ทำซ้ำถ้าร้านปิด repeatable", () => {
    expect(sql).toContain("where status = 'active';");
    expect(sql).toContain("if v_round > 0 and not v_mission.repeatable then");
    // trigger ครบแล้วไม่สร้างรอบใหม่ให้อัตโนมัติ
    expect(sql).not.toMatch(/store_missions_on_order_status[\s\S]*insert into public\.store_mission_enrollments/);
  });
  it("รางวัล = ของรางวัลซ่อน (แลกด้วยแต้มไม่ได้) + คูปองผูกลูกค้า + ใช้ต้องยืนยันรหัส 5 นาที", () => {
    expect(sql).toContain("1, false, true, v_reward_type, v_kind, v_value, v_reward_product");
    expect(sql).toContain("v_expires, 1, 1, true, array[v_e.customer_id], v_m.id");
    expect(sql).toContain("check (points_spent > 0 or (points_spent = 0 and mission_enrollment_id is not null))");
    expect(sql).toContain("before update of used_at on public.loyalty_reward_redemptions");
    expect(sql).toContain("before insert on public.coupon_redemptions");
    expect(sql.match(/v\.expires_at > now\(\)/g)?.length).toBe(2);
  });
  it("void หลังครบ: คูปองยังไม่ใช้ → ยกเลิกคูปองและกลับไปทำต่อ · ใช้แล้วไม่ยกเลิกย้อนหลัง", () => {
    expect(sql).toContain("if v_red.id is not null and v_red.used_at is null and v_red.status = 'pending' then");
    expect(sql).toContain("update public.coupons set is_active = false, updated_at = now() where id = v_red.coupon_id;");
  });
  it("หลังรีวิว: ออกคูปองพลาดไม่ทำให้บิลล้ม (log + cron ออกซ้ำ) · ต้องมีวันจบ · void หลังหมดเขตไม่กลับเป็นกำลังทำ", () => {
    expect(sql).toMatch(/begin\s+perform public\.store_mission_issue_reward\(v_e\.id\);\s+exception when others then/);
    expect(sql).toContain("select public.retry_store_mission_rewards();");
    expect(sql).toContain("check (duration_days is not null or join_ends_at is not null)");
    expect(sql).toContain("when v_p.expires_at is not null and v_p.expires_at <= now() then 'expired'");
  });
  it("สิทธิ์: กดรับผ่าน service role เท่านั้น · บันทึกภารกิจเฉพาะ owner/admin · ตารางเขียนตรงไม่ได้", () => {
    expect(sql).toContain("grant execute on function public.join_store_mission(uuid, uuid, boolean) to service_role;");
    expect(sql).toContain("revoke all on function public.join_store_mission(uuid, uuid, boolean) from public, anon, authenticated;");
    expect(sql).toContain("auth_user_role_in_store(v_org, p_store_id, 'admin')");
    expect(sql).toContain("revoke all on table public.store_missions from anon, authenticated;");
  });
});

describe("ต่อสายในแอป", () => {
  it("หน้าสมาชิกโหลดภารกิจเฉพาะ Enterprise ที่ล็อกอิน + action กดรับมี log", () => {
    const page = read("src/app/member/[storeSlug]/page.tsx");
    expect(page).toContain("portalData.store && portalData.customer && portalData.memberPrivileges");
    expect(page).toContain("getMemberMissionsView(");
    const actions = read("src/app/member/[storeSlug]/actions.ts");
    expect(actions).toContain('source: "missions.member"');
    expect(actions).toContain("if (!portalData.customer) return { error: \"กรุณาเข้าสู่ระบบก่อนรับภารกิจ\" };");
  });
  it("หลังร้านตรวจ Enterprise + owner/admin และ log การบันทึก/สวิตช์", () => {
    const actions = read("src/app/(dashboard)/customers/missions/actions.ts");
    expect(actions).toContain("canUseMemberPrivileges(billing)");
    expect(actions).toContain("isOpsManagerRole(resolved.role)");
    expect(actions).toContain('action: "saveMission"');
    expect(actions).toContain('action: "setMissionsEnabled"');
  });
  it("POS แสดงความคืบหน้าภารกิจของลูกค้าในบิล", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("listPosMissionProgressAction(customerId)");
    expect(pos).toContain("missions={visibleMissions}");
    const actions = read("src/app/pos/actions.ts");
    expect(actions).toMatch(/listPosMissionProgressAction[\s\S]{0,200}await requirePermission\("pos\.use"\)/);
    expect(actions).toContain("listPosMissionProgress(ctx.storeId, customerId)");
    expect(actions).toContain('"ต้องยืนยันรหัสสมาชิกก่อนใช้คูปองรางวัลภารกิจ"');
  });
  it("หน้าสมาชิกไม่แสดง “-0 แต้ม” สำหรับรางวัลภารกิจ", () => {
    expect(read("src/app/member/[storeSlug]/MemberPortal.tsx")).toContain('"รางวัลภารกิจ"');
  });
});

describe("M1b ใบเสร็จพิมพ์ความคืบหน้าภารกิจ", () => {
  it("ข้อความ: ยังไม่ครบ = อีก X ชิ้น · ครบ = รับคูปองในหน้าสมาชิก · สูงสุด 3 ภารกิจ", async () => {
    const { missionReceiptRows } = await import("@/modules/printing/mission-lines");
    const rows = missionReceiptRows([
      { name: "ดื่มครบ 6 แก้ว", progress: 5, targetCount: 6, completed: false },
      { name: "ลองมัทฉะ", progress: 3, targetCount: 3, completed: true },
    ]);
    expect(rows[0]).toEqual({ name: "ดื่มครบ 6 แก้ว", progress: "5/6", note: "อีก 1 ชิ้น ได้รางวัล!" });
    expect(rows[1].note).toContain("ครบแล้ว");
    expect(missionReceiptRows(undefined)).toEqual([]);
    expect(missionReceiptRows(Array.from({ length: 5 }, () => ({ name: "x", progress: 1, targetCount: 2, completed: false })))).toHaveLength(3);
  });
  it("ใบเสร็จแบบรูป/HTML มีหัวข้อภารกิจเมื่อมีข้อมูล และไม่มีเมื่อไม่มี", async () => {
    const { buildReceiptLines } = await import("@/modules/printing/receipt-lines");
    const base = {
      storeName: "ร้าน", showTaxId: false, orderNumber: "A-1",
      items: [{ name: "ลาเต้", modifierNames: [], quantity: 1, unitPrice: 60, totalPrice: 60 }],
      subtotal: 60, discount: 0, total: 60, payments: [{ method: "cash", amount: 60 }],
      paymentStatus: "paid", showQrPayment: false, paperWidth: "80mm", printedAt: "2026-11-17T10:00:00.000Z",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withMission = buildReceiptLines({ ...base, missionProgress: [{ name: "ดื่มครบ 6 แก้ว", progress: 5, targetCount: 6, completed: false }] } as any);
    const texts = withMission.lines.map((l) => l.text).join("\n");
    expect(texts).toContain("ภารกิจสะสม");
    expect(texts).toContain("อีก 1 ชิ้น ได้รางวัล!");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildReceiptLines(base as any).lines.map((l) => l.text).join("\n")).not.toContain("ภารกิจสะสม");
  });
  it("ข้อมูลไหลครบ: getOrder → ReceiptData → ESC/POS + POS ส่งต่อทั้งพิมพ์ปกติและพิมพ์ซ้ำ", () => {
    expect(read("src/modules/pos/order-repository.ts")).toContain("order.missionProgress = await loadOrderMissionProgress(orderId);");
    expect(read("src/modules/printing/types.ts")).toContain("missionProgress: order.missionProgress,");
    expect(read("src/modules/printing/escpos.ts")).toContain("missionReceiptRows(receipt.missionProgress)");
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("missionProgress: paidOrder?.missionProgress,");
    expect(pos).toContain("missionProgress: receiptData.missionProgress,");
    expect(pos.split("missionProgress: order.missionProgress,").length - 1).toBe(2);
  });
});

describe("M2 SMS ภารกิจ", () => {
  const sql = read("supabase/migrations/20261125130000_store_mission_sms.sql");
  it("ข้อความไม่เกิน 2 เครดิต (134 ตัว) และมีลิงก์สั้นครบเสมอ แม้ชื่อร้าน/ภารกิจยาว", async () => {
    const { buildMissionSms, smsCredits, SMS_MAX_CHARS } = await import("@/modules/missions/sms");
    const long = "ร้านกาแฟชื่อยาวมากมากมากเพื่อทดสอบการตัดข้อความให้พอดีกับเครดิต";
    for (const kind of ["near", "reward", "expiring"] as const) {
      const msg = buildMissionSms({ kind, storeName: long, storeSlug: "eachother", missionName: long, voucherExpiresAt: "2026-12-30T10:00:00Z" });
      expect(msg.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
      expect(msg).toContain("store-os.online/m/eachother");
      expect(smsCredits(msg)).toBeLessThanOrEqual(2);
    }
    expect(buildMissionSms({ kind: "near", storeName: "each other II", storeSlug: "eachother", missionName: "ดื่มครบ 6 แก้ว", voucherExpiresAt: null })).toContain("each other II: อีก 1 ชิ้น");
  });
  it("ยินยอม/ยกเลิก + เพดานร้าน/ลูกค้า + เวลาส่ง ตรวจที่ claim ที่เดียว", () => {
    expect(sql).toContain("add column if not exists sms_opt_in boolean not null default true");
    expect(sql).toContain("add column if not exists mission_sms_opt_out boolean not null default false");
    expect(sql).toContain("if v_hour < 9 or v_hour >= 20 then");
    expect(sql).toContain("if v_store_sent >= v_q.mission_sms_monthly_limit then");
    expect(sql).toContain("if v_customer_sent >= 3 then");
    expect(sql).toContain("for update of q skip locked");
  });
  it("ใส่คิวพลาดไม่กระทบบิล · แต่ละจังหวะส่งครั้งเดียว · cron ยิง API เฉพาะเมื่อมีคิว ด้วยกุญแจ Vault", () => {
    expect(sql).toMatch(/enqueue_store_mission_sms[\s\S]*exception when others then/);
    expect(sql).toContain("on public.store_mission_sms_queue (enrollment_id) where kind = 'near'");
    expect(sql).toContain("where exists (select 1 from public.store_mission_sms_queue where status = 'queued');");
    expect(sql).toContain("'mission_sms_cron_key'");
    const route = read("src/app/api/missions/cron/sms/route.ts");
    expect(route).toContain('db.rpc("verify_mission_sms_cron_key"');
    const mw = read("src/server/integrations/supabase/middleware.ts");
    expect(mw).toContain('request.nextUrl.pathname === "/api/missions/cron/sms" ||');
    expect(mw).toContain('request.nextUrl.pathname.startsWith("/m/") ||');
  });
  it("หน้าสมาชิกมีช่องยินยอมตอนกดรับ + ปุ่มหยุดรับ SMS (มี log)", () => {
    const card = read("src/app/member/[storeSlug]/MemberMissionsCard.tsx");
    expect(card).toContain('fd.set("smsOptIn"');
    expect(card).toContain("หยุดรับ SMS ภารกิจจากร้านนี้");
    expect(read("src/app/member/[storeSlug]/actions.ts")).toContain('action: "setMissionSmsOptOutAction"');
    expect(read("src/modules/notifications/smskub.ts")).toContain("return sendSmskubMessage(phone, buildOtpMessage(code), \"StoreOS OTP\");");
  });
});

describe("รีวิวรอบ 2 (SMS)", () => {
  it("ความยินยอม SMS บันทึกพร้อมกดรับใน RPC เดียว (ไม่มี update แยก)", () => {
    const sql = read(SQL);
    expect(sql).toContain("create or replace function public.join_store_mission(p_customer_id uuid, p_mission_id uuid, p_sms_opt_in boolean default true)");
    expect(sql).toContain("coalesce(p_sms_opt_in, true)");
    const repo = read("src/modules/missions/repository.ts");
    expect(repo).toContain("p_sms_opt_in: smsOptIn,");
    expect(repo).not.toContain(".update({ sms_opt_in: false })");
  });
  it("ข้อความที่ถูกข้าม/ล้มเหลว ใส่คิวใหม่ได้ (unique เฉพาะ queued/sending/sent)", () => {
    const sms = read("supabase/migrations/20261125130000_store_mission_sms.sql");
    expect(sms).toContain("where kind = 'near' and status in ('queued', 'sending', 'sent');");
    expect(sms).toContain("where redemption_id is not null and status in ('queued', 'sending', 'sent');");
  });
  it("ข้อความเพดานบอก “ทุก 7 วัน” ตรงกับที่นับจริง", () => {
    expect(read("src/app/member/[storeSlug]/MemberMissionsCard.tsx")).toContain("ไม่เกิน 3 ข้อความทุก 7 วัน");
  });
});

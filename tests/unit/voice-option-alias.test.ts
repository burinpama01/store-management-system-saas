import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ModifierOptionSlotsSchema,
  decideOptionAliasProposal,
  isOptionOwnedByStore,
  type ProposalCandidate,
} from "@/modules/voice-pos/alias-proposal";
import { VOICE_ALIAS_INTENT_TYPES } from "@/modules/voice-pos/alias-repository";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const OPTION = "33333333-3333-4333-8333-333333333333";

const candidate = (over: Partial<ProposalCandidate> = {}): ProposalCandidate => ({
  phrase: "หวานน้อย",
  productId: PRODUCT,
  productName: "ชาเย็น",
  modifierGroupId: GROUP,
  optionId: OPTION,
  optionName: "25%",
  chosenByHuman: true,
  canManageStore: true,
  existingAliases: [],
  ...over,
});

describe("P9 — ข้อเสนอคำเรียกตัวเลือก", () => {
  it("เสนอได้เมื่อคนเลือกเองและมีสิทธิ์", () => {
    const decision = decideOptionAliasProposal(candidate());
    expect(decision).toMatchObject({
      status: "propose",
      proposal: { phrase: "หวานน้อย", optionId: OPTION, optionName: "25%" },
    });
  });

  it("ห้าม auto-learning: ระบบเดาเองแล้วเสนอไม่ได้", () => {
    expect(decideOptionAliasProposal(candidate({ chosenByHuman: false }))).toEqual({
      status: "skip",
      reason: "not_human_choice",
    });
  });

  it("ไม่มีสิทธิ์ = ไม่เสนอเลย (ไม่ใช่แค่ซ่อนปุ่ม)", () => {
    expect(decideOptionAliasProposal(candidate({ canManageStore: false }))).toEqual({
      status: "skip",
      reason: "no_permission",
    });
  });

  it("คำที่ตรงกับชื่อตัวเลือกอยู่แล้ว หรือมี alias เดิม = ไม่เสนอซ้ำ", () => {
    expect(decideOptionAliasProposal(candidate({ phrase: "25%" })).status).toBe("skip");
    expect(decideOptionAliasProposal(candidate({ existingAliases: ["หวานน้อย"] }))).toEqual({
      status: "skip",
      reason: "duplicate",
    });
    // เทียบแบบ normalize ช่องว่าง/ตัวพิมพ์
    expect(decideOptionAliasProposal(candidate({ existingAliases: ["  หวานน้อย  "] })).status).toBe("skip");
  });

  it("คำว่าง/ยาวเกิน/id ไม่ใช่ uuid = ไม่เสนอ", () => {
    expect(decideOptionAliasProposal(candidate({ phrase: "   " })).status).toBe("skip");
    expect(decideOptionAliasProposal(candidate({ phrase: "ก".repeat(61) })).status).toBe("skip");
    expect(decideOptionAliasProposal(candidate({ optionId: "not-a-uuid" }))).toEqual({
      status: "skip",
      reason: "invalid",
    });
  });

  it("slots ต้องเป็น uuid ครบสามตัวและไม่มีคีย์เกิน", () => {
    expect(ModifierOptionSlotsSchema.safeParse({ productId: PRODUCT, modifierGroupId: GROUP, optionId: OPTION }).success).toBe(true);
    expect(
      ModifierOptionSlotsSchema.safeParse({ productId: PRODUCT, modifierGroupId: GROUP, optionId: OPTION, storeId: "x" }).success,
    ).toBe(false);
  });
});

describe("P9 — ownership ของตัวเลือก", () => {
  const catalog = [
    { id: PRODUCT, modifierGroups: [{ id: GROUP, options: [{ id: OPTION }] }] },
  ];

  it("ผูกได้เฉพาะตัวเลือกที่อยู่ในสินค้าของร้านนี้", () => {
    expect(isOptionOwnedByStore({ productId: PRODUCT, modifierGroupId: GROUP, optionId: OPTION }, catalog)).toBe(true);
  });

  it("สินค้า/กลุ่ม/ตัวเลือกที่ไม่ใช่ของร้าน = ปฏิเสธ", () => {
    const other = "44444444-4444-4444-8444-444444444444";
    expect(isOptionOwnedByStore({ productId: other, modifierGroupId: GROUP, optionId: OPTION }, catalog)).toBe(false);
    expect(isOptionOwnedByStore({ productId: PRODUCT, modifierGroupId: other, optionId: OPTION }, catalog)).toBe(false);
    expect(isOptionOwnedByStore({ productId: PRODUCT, modifierGroupId: GROUP, optionId: other }, catalog)).toBe(false);
    expect(isOptionOwnedByStore({ productId: PRODUCT, modifierGroupId: GROUP, optionId: OPTION }, [])).toBe(false);
  });
});

describe("P9 — สัญญาฝั่ง repository/action", () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("intent_type รองรับ modifier_option แล้ว", () => {
    expect(VOICE_ALIAS_INTENT_TYPES).toContain("modifier_option");
  });

  it("action บันทึกได้เฉพาะผู้มีสิทธิ์ และตรวจ ownership ก่อนเขียนเสมอ", () => {
    const actions = read("src/app/(dashboard)/settings/voice/actions.ts");
    const save = actions.slice(actions.indexOf("export async function saveOptionAliasAction"));
    expect(save).toContain('requirePermission("settings.manage_store")');
    expect(save).toContain("isOptionOwnedByStore");
    expect(save).toContain("ModifierOptionSlotsSchema.safeParse");
    // ต้องตรวจสิทธิ์และ ownership ก่อนถึงบรรทัดที่เขียนจริง
    expect(save.indexOf("isOptionOwnedByStore")).toBeLessThan(save.indexOf("createVoiceAlias("));
  });

  it("ไม่มีเส้นทางไหนสร้าง alias จาก transcript โดยอัตโนมัติ", () => {
    const proposal = read("src/modules/voice-pos/alias-proposal.ts");
    // โมดูลนี้ตัดสินใจอย่างเดียว ไม่มีการเขียนฐานข้อมูล
    expect(proposal).not.toContain("supabase");
    expect(proposal).not.toContain("insert(");
    const review = read("src/app/(dashboard)/settings/voice/VoiceOptionAliasReview.tsx");
    // บันทึกได้ทางเดียวคือผู้ใช้กด submit ฟอร์มนี้
    expect(review).toContain("saveOptionAliasAction");
    expect(review).toContain("บันทึกคำเรียกนี้");
  });
});

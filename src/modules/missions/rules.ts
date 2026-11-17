/**
 * ภารกิจสะสม (Missions) · M1 — กติกาฝั่งแอป (ฐานข้อมูลบังคับซ้ำใน save_store_mission/trigger)
 * ข้อกำหนดผู้ใช้ 2026-11-17: นับหลังกดรับ, นับชิ้น + เพดานต่อบิลตั้งได้ต่อภารกิจ,
 * ทำซ้ำได้ถ้าร้านเปิดแต่ลูกค้าต้องกดรับเอง, แต้มคิดปกติ, Enterprise
 */

export type MissionScope = "all" | "categories" | "products";
export type MissionRewardType = "product" | "discount";
export type MissionStatus = "active" | "ended";
export type EnrollmentStatus = "active" | "completed" | "expired" | "cancelled";

export interface MissionInput {
  name: string;
  description: string;
  scope: MissionScope;
  categoryIds: string[];
  productIds: string[];
  targetCount: number;
  /** เพดานชิ้นที่นับได้ต่อบิล — null = ไม่จำกัด */
  maxPerOrder: number | null;
  /** จำนวนวันหลังกดรับ — null = ถึงวันปิดรับภารกิจ */
  durationDays: number | null;
  /** วันสุดท้ายที่รับ/นับภารกิจ (ISO) — null = ไม่มีกำหนด */
  joinEndsAt: string | null;
  repeatable: boolean;
  maxParticipants: number | null;
  rewardType: MissionRewardType;
  rewardProductId: string | null;
  rewardDiscountKind: "amount" | "percentage" | null;
  rewardDiscountValue: number | null;
  rewardMinSubtotal: number;
  rewardValidDays: number;
  status: MissionStatus;
}

export interface Mission extends MissionInput {
  id: string;
  storeId: string;
  joinStartsAt: string;
  createdAt: string;
}

export interface MissionStats {
  joined: number;
  active: number;
  completed: number;
  rewardsUsed: number;
}

const isInt = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function validateMissionInput(input: MissionInput): string | null {
  if (!input.name.trim()) return "ตั้งชื่อภารกิจก่อน";
  if (input.name.trim().length > 80) return "ชื่อภารกิจยาวเกิน 80 ตัวอักษร";
  if (input.description.length > 300) return "คำอธิบายยาวเกิน 300 ตัวอักษร";
  if (input.scope === "categories" && input.categoryIds.length === 0) return "เลือกหมวดที่นับอย่างน้อย 1 หมวด";
  if (input.scope === "products" && input.productIds.length === 0) return "เลือกสินค้าที่นับอย่างน้อย 1 รายการ";
  if (!isInt(input.targetCount, 1, 100)) return "เป้าหมายต้องเป็น 1–100 ชิ้น";
  if (input.maxPerOrder !== null && !isInt(input.maxPerOrder, 1, 100)) return "เพดานต่อบิลต้องเป็น 1–100 ชิ้น";
  if (input.durationDays !== null && !isInt(input.durationDays, 1, 365)) return "ระยะเวลาต้องเป็น 1–365 วัน";
  if (input.durationDays === null && input.joinEndsAt === null) return "กำหนดระยะเวลาหลังกดรับ หรือวันปิดภารกิจ อย่างน้อยหนึ่งอย่าง";
  if (input.joinEndsAt !== null && Number.isNaN(Date.parse(input.joinEndsAt))) return "วันปิดภารกิจไม่ถูกต้อง";
  if (input.maxParticipants !== null && !isInt(input.maxParticipants, 1, 100000)) return "จำนวนผู้รับสูงสุดไม่ถูกต้อง";
  if (!isInt(input.rewardValidDays, 1, 365)) return "อายุคูปองรางวัลต้องเป็น 1–365 วัน";
  if (input.rewardType === "product") {
    if (!input.rewardProductId) return "เลือกสินค้าที่เป็นรางวัล";
  } else if (input.rewardType === "discount") {
    if (input.rewardDiscountKind !== "amount" && input.rewardDiscountKind !== "percentage") return "เลือกชนิดส่วนลด";
    const value = input.rewardDiscountValue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "ตั้งมูลค่าส่วนลดให้ถูกต้อง";
    if (input.rewardDiscountKind === "percentage" && value > 100) return "ส่วนลดเปอร์เซ็นต์ต้องไม่เกิน 100";
    if (!Number.isFinite(input.rewardMinSubtotal) || input.rewardMinSubtotal < 0) return "ยอดขั้นต่ำไม่ถูกต้อง";
  } else {
    return "เลือกชนิดรางวัล";
  }
  return null;
}

/** payload ของ RPC save_store_mission */
export function missionPayload(id: string | null, input: MissionInput): Record<string, unknown> {
  const isProduct = input.rewardType === "product";
  return {
    id,
    name: input.name.trim(),
    description: input.description.trim(),
    scope: input.scope,
    category_ids: input.scope === "categories" ? input.categoryIds : [],
    product_ids: input.scope === "products" ? input.productIds : [],
    target_count: input.targetCount,
    max_per_order: input.maxPerOrder,
    duration_days: input.durationDays,
    join_ends_at: input.joinEndsAt,
    repeatable: input.repeatable,
    max_participants: input.maxParticipants,
    reward_type: input.rewardType,
    reward_product_id: isProduct ? input.rewardProductId : null,
    reward_discount_kind: isProduct ? null : input.rewardDiscountKind,
    reward_discount_value: isProduct ? null : input.rewardDiscountValue,
    reward_min_subtotal: isProduct ? 0 : input.rewardMinSubtotal,
    reward_valid_days: input.rewardValidDays,
    status: input.status,
  };
}

/** นับชิ้นของบิลนี้ตามกติกาเดียวกับ trigger (ใช้แสดง “บิลนี้ +N” ที่ POS) */
export function countOrderTowardMission(
  lines: { productId: string; categoryId: string | null; quantity: number; totalPrice: number }[],
  mission: { scope: MissionScope; categoryIds: string[]; productIds: string[]; maxPerOrder: number | null },
  remaining: number,
): number {
  let qty = 0;
  for (const line of lines) {
    if (line.totalPrice <= 0 || line.quantity <= 0) continue;
    const match =
      mission.scope === "all" ||
      (mission.scope === "categories" && line.categoryId !== null && mission.categoryIds.includes(line.categoryId)) ||
      (mission.scope === "products" && mission.productIds.includes(line.productId));
    if (match) qty += line.quantity;
  }
  if (mission.maxPerOrder !== null) qty = Math.min(qty, mission.maxPerOrder);
  return Math.max(0, Math.min(qty, remaining));
}

export function rewardLabel(mission: Pick<MissionInput, "rewardType" | "rewardDiscountKind" | "rewardDiscountValue" | "rewardMinSubtotal">, productName?: string | null): string {
  if (mission.rewardType === "product") return `${productName ?? "สินค้า"} ฟรี 1 ชิ้น`;
  const value = mission.rewardDiscountValue ?? 0;
  const base = mission.rewardDiscountKind === "percentage" ? `ลด ${value}%` : `ลด ฿${value.toLocaleString("th-TH")}`;
  return mission.rewardMinSubtotal > 0 ? `${base} เมื่อซื้อครบ ฿${mission.rewardMinSubtotal.toLocaleString("th-TH")}` : base;
}

/** เทมเพลตตั้งต้นในหน้าสร้างภารกิจ (ร้านแก้ได้ทุกช่อง) */
export const MISSION_TEMPLATES: { key: string; label: string; input: Partial<MissionInput> }[] = [
  {
    key: "six-get-one",
    label: "สะสม 6 แก้ว ฟรี 1 แก้ว (30 วัน)",
    input: { name: "ดื่มครบ 6 แก้ว รับฟรี 1 แก้ว", targetCount: 6, maxPerOrder: 2, durationDays: 30, repeatable: true, rewardType: "product" },
  },
  {
    key: "ten-get-one",
    label: "สะสม 10 แก้ว ฟรี 1 แก้ว (60 วัน)",
    input: { name: "สะสมครบ 10 แก้ว รับฟรี 1 แก้ว", targetCount: 10, maxPerOrder: 3, durationDays: 60, repeatable: true, rewardType: "product" },
  },
  {
    key: "try-new",
    label: "ลองเมนูใหม่ 3 ครั้ง รับส่วนลด",
    input: {
      name: "ลองเมนูใหม่ 3 ครั้ง",
      scope: "products",
      targetCount: 3,
      maxPerOrder: 1,
      durationDays: 21,
      repeatable: false,
      rewardType: "discount",
      rewardDiscountKind: "amount",
      rewardDiscountValue: 20,
    },
  },
];

export const EMPTY_MISSION_INPUT: MissionInput = {
  name: "",
  description: "",
  scope: "all",
  categoryIds: [],
  productIds: [],
  targetCount: 6,
  maxPerOrder: 2,
  durationDays: 30,
  joinEndsAt: null,
  repeatable: true,
  maxParticipants: null,
  rewardType: "product",
  rewardProductId: null,
  rewardDiscountKind: "amount",
  rewardDiscountValue: null,
  rewardMinSubtotal: 0,
  rewardValidDays: 30,
  status: "active",
};

/**
 * ภารกิจสะสม (Missions) · M1 — กติกาฝั่งแอป (ฐานข้อมูลบังคับซ้ำใน save_store_mission/trigger)
 * ข้อกำหนดผู้ใช้ 2026-11-17: นับหลังกดรับ, นับชิ้น + เพดานต่อบิลตั้งได้ต่อภารกิจ,
 * ทำซ้ำได้ถ้าร้านเปิดแต่ลูกค้าต้องกดรับเอง, แต้มคิดปกติ, Enterprise
 */

export type MissionScope = "all" | "categories" | "products";
export type MissionRewardType = "product" | "discount" | "points";
/** ชิ้น · ยอดซื้อเป็นบาท · จำนวนบิลที่ยอดถึงขั้นต่ำ */
export type MissionCountMode = "items" | "spend" | "orders";
export type MissionStatus = "active" | "ended";
export type EnrollmentStatus = "active" | "completed" | "expired" | "cancelled";

export interface MissionInput {
  name: string;
  description: string;
  scope: MissionScope;
  countMode: MissionCountMode;
  /** นับบิล: ยอดสินค้าในขอบเขตต่อบิลต้องถึงเท่านี้ (บาท) */
  minOrderTotal: number;
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
  /** รางวัลแต้มโบนัส */
  rewardPoints: number | null;
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
  if (input.countMode !== "items" && input.countMode !== "spend" && input.countMode !== "orders") return "เลือกวิธีนับ";
  if (input.countMode === "spend") {
    if (!isInt(input.targetCount, 1, 1_000_000)) return "ยอดซื้อเป้าหมายต้องเป็น 1–1,000,000 บาท";
  } else if (!isInt(input.targetCount, 1, 100)) {
    return input.countMode === "orders" ? "เป้าหมายต้องเป็น 1–100 ครั้ง" : "เป้าหมายต้องเป็น 1–100 ชิ้น";
  }
  if (input.countMode === "items" && input.maxPerOrder !== null && !isInt(input.maxPerOrder, 1, 100)) return "เพดานต่อบิลต้องเป็น 1–100 ชิ้น";
  if (input.countMode === "orders" && (!Number.isFinite(input.minOrderTotal) || input.minOrderTotal < 0)) return "ยอดขั้นต่ำต่อบิลไม่ถูกต้อง";
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
  } else if (input.rewardType === "points") {
    const pts = input.rewardPoints;
    if (typeof pts !== "number" || !Number.isInteger(pts) || pts <= 0 || pts > 100_000) return "ตั้งแต้มรางวัลเป็นจำนวนเต็ม 1–100,000 แต้ม";
  } else {
    return "เลือกชนิดรางวัล";
  }
  return null;
}

/** payload ของ RPC save_store_mission */
export function missionPayload(id: string | null, input: MissionInput): Record<string, unknown> {
  const isProduct = input.rewardType === "product";
  const isPoints = input.rewardType === "points";
  return {
    id,
    name: input.name.trim(),
    description: input.description.trim(),
    scope: input.scope,
    count_mode: input.countMode,
    min_order_total: input.countMode === "orders" ? input.minOrderTotal : 0,
    category_ids: input.scope === "categories" ? input.categoryIds : [],
    product_ids: input.scope === "products" ? input.productIds : [],
    target_count: input.targetCount,
    max_per_order: input.countMode === "items" ? input.maxPerOrder : null,
    duration_days: input.durationDays,
    join_ends_at: input.joinEndsAt,
    repeatable: input.repeatable,
    max_participants: input.maxParticipants,
    reward_type: input.rewardType,
    reward_product_id: isProduct ? input.rewardProductId : null,
    reward_discount_kind: isProduct || isPoints ? null : input.rewardDiscountKind,
    reward_discount_value: isProduct || isPoints ? null : input.rewardDiscountValue,
    reward_min_subtotal: isProduct || isPoints ? 0 : input.rewardMinSubtotal,
    reward_points: isPoints ? input.rewardPoints : null,
    reward_valid_days: input.rewardValidDays,
    status: input.status,
  };
}

/** นับชิ้นของบิลนี้ตามกติกาเดียวกับ trigger (ใช้แสดง “บิลนี้ +N” ที่ POS) */
export function countOrderTowardMission(
  lines: { productId: string; categoryId: string | null; quantity: number; totalPrice: number }[],
  mission: {
    scope: MissionScope;
    categoryIds: string[];
    productIds: string[];
    maxPerOrder: number | null;
    countMode?: MissionCountMode;
    minOrderTotal?: number;
  },
  remaining: number,
): number {
  let qty = 0;
  let spend = 0;
  for (const line of lines) {
    if (line.totalPrice <= 0 || line.quantity <= 0) continue;
    const match =
      mission.scope === "all" ||
      (mission.scope === "categories" && line.categoryId !== null && mission.categoryIds.includes(line.categoryId)) ||
      (mission.scope === "products" && mission.productIds.includes(line.productId));
    if (match) {
      qty += line.quantity;
      spend += line.totalPrice;
    }
  }
  const mode = mission.countMode ?? "items";
  if (mode === "spend") qty = Math.floor(spend);
  else if (mode === "orders") qty = spend > 0 && spend >= (mission.minOrderTotal ?? 0) ? 1 : 0;
  else if (mission.maxPerOrder !== null) qty = Math.min(qty, mission.maxPerOrder);
  return Math.max(0, Math.min(qty, remaining));
}

/** หน่วยของเป้าหมายตามวิธีนับ */
export function missionUnit(mode: MissionCountMode | undefined): string {
  return mode === "spend" ? "บาท" : mode === "orders" ? "ครั้ง" : "ชิ้น";
}

/** "4/6 ชิ้น" · "฿1,580/฿2,000" · "2/5 ครั้ง" */
export function missionProgressText(mode: MissionCountMode | undefined, progress: number, target: number): string {
  if (mode === "spend") return `฿${progress.toLocaleString("th-TH")}/฿${target.toLocaleString("th-TH")}`;
  return `${progress}/${target} ${missionUnit(mode)}`;
}

/** "อีก 2 ชิ้น" · "อีก ฿420" · "อีก 1 ครั้ง" */
export function missionRemainingText(mode: MissionCountMode | undefined, remaining: number): string {
  if (mode === "spend") return `อีก ฿${remaining.toLocaleString("th-TH")}`;
  return `อีก ${remaining} ${missionUnit(mode)}`;
}

export function rewardLabel(
  mission: Pick<MissionInput, "rewardType" | "rewardDiscountKind" | "rewardDiscountValue" | "rewardMinSubtotal"> & { rewardPoints?: number | null },
  productName?: string | null,
): string {
  if (mission.rewardType === "product") return `${productName ?? "สินค้า"} ฟรี 1 ชิ้น`;
  if (mission.rewardType === "points") return `โบนัส ${(mission.rewardPoints ?? 0).toLocaleString("th-TH")} แต้ม`;
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
    key: "spend-bonus",
    label: "สะสมยอด ฿1,000 ใน 30 วัน รับ 50 แต้ม",
    input: {
      name: "สะสมยอดครบ ฿1,000 รับโบนัส 50 แต้ม",
      countMode: "spend",
      targetCount: 1000,
      maxPerOrder: null,
      durationDays: 30,
      repeatable: true,
      rewardType: "points",
      rewardPoints: 50,
    },
  },
  {
    key: "bill-bonus",
    label: "ซื้อครบ ฿120/บิล รับ 30 แต้ม",
    input: {
      name: "ซื้อครบ ฿120 ต่อบิล รับเพิ่ม 30 แต้ม",
      countMode: "orders",
      minOrderTotal: 120,
      targetCount: 1,
      maxPerOrder: null,
      durationDays: 14,
      repeatable: false,
      rewardType: "points",
      rewardPoints: 30,
    },
  },
  {
    key: "first-visit",
    label: "ซื้อครั้งแรกไม่มีขั้นต่ำ รับ 20 แต้ม",
    input: {
      name: "ซื้อครั้งแรก รับฟรี 20 แต้ม",
      countMode: "orders",
      minOrderTotal: 0,
      targetCount: 1,
      maxPerOrder: null,
      durationDays: 30,
      repeatable: false,
      rewardType: "points",
      rewardPoints: 20,
    },
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
  countMode: "items",
  minOrderTotal: 0,
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
  rewardPoints: null,
  rewardValidDays: 30,
  status: "active",
};

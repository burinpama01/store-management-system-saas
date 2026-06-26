import { roundPoints } from "@/shared/utils/points";

export type LoyaltyLedgerEntryType = "earn" | "redeem" | "reversal";

export interface LoyaltyLedgerEntry {
  accountId: string;
  orderId: string;
  type: LoyaltyLedgerEntryType;
  pointsDelta: number;
  idempotencyKey: string;
  reason?: string;
  reversedEntryId?: string;
}

function assertIdempotencyKey(idempotencyKey: string) {
  if (!idempotencyKey.trim()) {
    throw new Error("ต้องมี idempotency key สำหรับรายการแต้ม");
  }
}

/** Points accrue to 2 decimals; reject non-positive amounts after rounding. */
function assertPositivePoints(points: number, message: string): number {
  const rounded = roundPoints(points);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new Error(message);
  }
  return rounded;
}

export function computeLoyaltyBalance(entries: LoyaltyLedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.pointsDelta, 0);
}

export function createEarnPointsEntry(input: {
  accountId: string;
  orderId: string;
  paidTotal: number;
  pointsPerCurrency: number;
  idempotencyKey: string;
}): LoyaltyLedgerEntry {
  assertIdempotencyKey(input.idempotencyKey);
  if (!Number.isFinite(input.paidTotal) || input.paidTotal <= 0) {
    throw new Error("ยอดชำระเงินไม่ถูกต้อง");
  }
  if (!Number.isFinite(input.pointsPerCurrency) || input.pointsPerCurrency <= 0) {
    throw new Error("อัตราสะสมแต้มไม่ถูกต้อง");
  }

  const points = assertPositivePoints(
    input.paidTotal * input.pointsPerCurrency,
    "ยอดนี้ยังไม่เกิดแต้มสะสม",
  );

  return {
    accountId: input.accountId,
    orderId: input.orderId,
    type: "earn",
    pointsDelta: points,
    idempotencyKey: input.idempotencyKey,
  };
}

export function createRedeemPointsEntry(input: {
  accountId: string;
  orderId: string;
  points: number;
  currentBalance: number;
  idempotencyKey: string;
}): LoyaltyLedgerEntry {
  assertIdempotencyKey(input.idempotencyKey);
  const points = assertPositivePoints(input.points, "จำนวนแต้มที่ใช้ไม่ถูกต้อง");
  if (points > input.currentBalance) {
    throw new Error("แต้มสะสมไม่พอ");
  }

  return {
    accountId: input.accountId,
    orderId: input.orderId,
    type: "redeem",
    pointsDelta: -points,
    idempotencyKey: input.idempotencyKey,
  };
}

export function createReversalEntry(input: {
  original: LoyaltyLedgerEntry;
  reason: string;
  idempotencyKey: string;
}): LoyaltyLedgerEntry {
  assertIdempotencyKey(input.idempotencyKey);
  if (!input.reason.trim()) {
    throw new Error("ต้องระบุเหตุผลการ reverse แต้ม");
  }

  return {
    accountId: input.original.accountId,
    orderId: input.original.orderId,
    type: "reversal",
    pointsDelta: -input.original.pointsDelta,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    reversedEntryId: input.original.idempotencyKey,
  };
}

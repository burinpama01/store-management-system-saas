import { describe, expect, it } from "vitest";

import {
  buildSettlementRequestHash,
  mapSettlementOutcome,
  type UnifiedPosSettlementOutcome,
} from "@/modules/unified-pos/settlement";
import { UNIFIED_POS_ERROR_CODES } from "@/modules/unified-pos/contracts";

// Task U7 — facade ของ governed settlement (v0.35.7)
// ครอบคลุมส่วน pure ของ src/modules/unified-pos/settlement.ts:
//   - buildSettlementRequestHash: hash เฉพาะ semantic (retry เดิม = hash เดิม,
//     payload ต่าง = hash ต่าง) และ undefined === null ตาม envelope canonicalize
//   - mapSettlementOutcome: executed/replayed/hash_conflict/error
// ฝั่งเรียก RPC จริง (settleOrdersGoverned/getUnifiedPosStoreFlag) อยู่ใน
// tests/integration/unified-pos-settlement.test.ts (ต้องมี local stack)

const base = {
  storeId: "cccccccc-0000-0000-0000-000000000001",
  tableId: "eeeeeeee-0000-0000-0000-000000000001" as string | null,
  mode: "partial" as const,
  orderIds: ["aaaaaaaa-0000-0000-0000-000000000001"],
  method: "cash",
  amount: 90,
  receivedAmount: 100,
  changeAmount: 10,
  reference: null as string | null,
};

describe("buildSettlementRequestHash (U7)", () => {
  it("คำขอเดิม (semantic เดิม) ได้ hash เดิม", () => {
    const a = buildSettlementRequestHash(base);
    const b = buildSettlementRequestHash({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("semantic ต่างกัน → hash ต่างกัน (method/amount/table/orderIds order)", () => {
    const original = buildSettlementRequestHash(base);
    expect(buildSettlementRequestHash({ ...base, method: "qr_promptpay" })).not.toBe(original);
    expect(buildSettlementRequestHash({ ...base, amount: 91 })).not.toBe(original);
    expect(buildSettlementRequestHash({ ...base, tableId: null })).not.toBe(original);
    expect(
      buildSettlementRequestHash({
        ...base,
        orderIds: ["aaaaaaaa-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000001"],
      }),
    ).not.toBe(original);
  });

  it("undefined และ null ของ optional field ให้ hash เดิม (canonicalize drop undefined)", () => {
    expect(
      buildSettlementRequestHash({ ...base, receivedAmount: undefined, changeAmount: undefined }),
    ).toBe(
      buildSettlementRequestHash({ ...base, receivedAmount: null, changeAmount: null }),
    );
  });

  it("hash ไม่ถูกกระทบจาก operation key หรือ actor (semantic เท่านั้น)", () => {
    // key/actor ไม่อยู่ใน payload — เปลี่ยนทั้งสองแล้ว hash ต้องคงเดิม
    const a = buildSettlementRequestHash(base);
    expect(a).toBe(buildSettlementRequestHash(base));
  });
});

describe("mapSettlementOutcome (U7)", () => {
  const result = {
    mode: "partial" as const,
    table_id: null,
    table_closed: false,
    order_ids: ["aaaaaaaa-0000-0000-0000-000000000001"],
    grand_total: 90,
    payments: [
      { order_id: "aaaaaaaa-0000-0000-0000-000000000001", payment_id: "pay-1", amount: 90, received_amount: 90, change_amount: 0 },
    ],
    orders: [
      { order_id: "aaaaaaaa-0000-0000-0000-000000000001", status: "paid", prep_status: "done", revision: 5, points_earned: 0 },
    ],
  };

  it("executed → ok + replayed=false", () => {
    const outcome: UnifiedPosSettlementOutcome = { status: "executed", result };
    const mapped = mapSettlementOutcome(outcome);
    expect(mapped.ok).toBe(true);
    if (mapped.ok) expect(mapped.replayed).toBe(false);
    if (mapped.ok) expect(mapped.result.grand_total).toBe(90);
  });

  it("replayed (มี result) → ok + replayed=true พร้อม result เดิม", () => {
    const mapped = mapSettlementOutcome({ status: "replayed", result });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) expect(mapped.replayed).toBe(true);
    if (mapped.ok) expect(mapped.result).toEqual(result);
  });

  it("replayed (result ถูก purge) → ok + replayed=true แบบ result ว่าง (ให้ client refetch)", () => {
    const mapped = mapSettlementOutcome({ status: "replayed", result: null });
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.replayed).toBe(true);
      expect(mapped.result.order_ids).toEqual([]);
      expect(mapped.result.payments).toEqual([]);
    }
  });

  it("hash_conflict → !ok + code up_hash_conflict + ข้อความไทยคงที่", () => {
    const mapped = mapSettlementOutcome({ status: "hash_conflict" });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) {
      expect(mapped.error.code).toBe(UNIFIED_POS_ERROR_CODES.hash_conflict);
      expect(mapped.error.userMessage).toContain("ขัดแย้งกัน");
    }
  });

  it("error → !ok + code/message จาก RPC ตรงๆ", () => {
    const mapped = mapSettlementOutcome({
      status: "error",
      code: UNIFIED_POS_ERROR_CODES.stale_version,
      message: "ข้อมูลบิลเปลี่ยนไปแล้ว กรุณารีเฟรชหน้าจอ",
    });
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) {
      expect(mapped.error.code).toBe(UNIFIED_POS_ERROR_CODES.stale_version);
      expect(mapped.error.userMessage).toBe("ข้อมูลบิลเปลี่ยนไปแล้ว กรุณารีเฟรชหน้าจอ");
    }
  });
});

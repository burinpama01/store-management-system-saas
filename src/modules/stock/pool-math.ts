import type { PoolDemandInput, StockAdjustment } from "./pool-types";

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ต้องเป็นจำนวนเต็มบวกที่ปลอดภัย`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} ต้องเป็นจำนวนเต็มศูนย์ขึ้นไปที่ปลอดภัย`);
  }
}

export function aggregatePoolDemand(
  items: readonly PoolDemandInput[],
): Map<string, number> {
  const demandByPool = new Map<string, number>();

  for (const item of items) {
    const trimmedPoolId = item.poolId.trim();
    if (!trimmedPoolId || trimmedPoolId !== item.poolId) {
      throw new Error("รหัส Stock Pool ต้องไม่ว่างและห้ามมีช่องว่างนำหน้าหรือต่อท้าย");
    }

    assertPositiveSafeInteger(item.orderQuantity, "จำนวนรายการสั่งซื้อ");
    assertPositiveSafeInteger(item.unitsPerItem, "จำนวนหน่วยต่อรายการ");

    const itemDemand = item.orderQuantity * item.unitsPerItem;
    if (!Number.isSafeInteger(itemDemand)) {
      throw new Error("จำนวนความต้องการ Stock Pool ต้องเป็นจำนวนเต็มที่ปลอดภัย");
    }

    const nextDemand = (demandByPool.get(item.poolId) ?? 0) + itemDemand;
    if (!Number.isSafeInteger(nextDemand)) {
      throw new Error("ยอดรวมความต้องการ Stock Pool ต้องเป็นจำนวนเต็มที่ปลอดภัย");
    }

    demandByPool.set(item.poolId, nextDemand);
  }

  return demandByPool;
}

export function nextStockQuantity(
  current: number,
  input: StockAdjustment,
): number {
  assertNonNegativeSafeInteger(current, "จำนวนสต็อกปัจจุบัน");

  if (input.mode === "receive") {
    assertPositiveSafeInteger(input.quantity, "จำนวนที่รับเข้า");

    const nextQuantity = current + input.quantity;
    if (!Number.isSafeInteger(nextQuantity)) {
      throw new Error("จำนวนสต็อกหลังรับเข้าต้องเป็นจำนวนเต็มที่ปลอดภัย");
    }

    return nextQuantity;
  }

  if (input.mode === "set_balance") {
    assertNonNegativeSafeInteger(input.quantity, "จำนวนที่ตั้งยอด");
    if (!input.reason.trim()) {
      throw new Error("การตั้งยอดสต็อกต้องระบุเหตุผล");
    }

    return input.quantity;
  }

  throw new Error("โหมดการปรับสต็อกไม่ถูกต้อง");
}

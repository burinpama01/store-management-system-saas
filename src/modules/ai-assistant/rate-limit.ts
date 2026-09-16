// PR2 — rate limit ระดับ route (residual risk จาก PR1: attacker สร้าง assistant session ใหม่ได้เรื่อย ๆ
// เพื่อเติม global idempotency backstop — ต้องกันที่ route ก่อนแตะ dispatcher/provider)
//
// แบบ fixed window ในหน่วยความจำของ process เดียว: เรียบง่าย ไม่มี dependency
// ข้อจำกัด MVP (บันทึกใน checkpoint): serverless หลาย instance = เพดานต่อ instance,
// การ evict ตัวเก่าเมื่อเกิน maxKeys เป็นการคุมหน่วยความจำ ไม่ใช่สัญญาเรื่องความแม่นยำของโควตา

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** มิลลิวินาทีที่ควรรอก่อนลองใหม่ (เฉพาะเมื่อไม่อนุญาต) */
  readonly retryAfterMs: number;
}

export interface FixedWindowRateLimiterOptions {
  /** จำนวนครั้งสูงสุดต่อหน้าต่างเวลา */
  readonly limitPerWindow: number;
  readonly windowMs: number;
  /** เพดานจำนวน key ที่เก็บได้ — เกินแล้ว evict หน้าต่างเก่าที่สุดก่อนเสมอ */
  readonly maxKeys?: number;
  readonly clock?: () => number;
}

export interface FixedWindowRateLimiter {
  readonly check: (key: string) => RateLimitDecision;
  readonly size: () => number;
}

export function createFixedWindowRateLimiter(
  options: FixedWindowRateLimiterOptions,
): FixedWindowRateLimiter {
  const { limitPerWindow, windowMs } = options;
  const maxKeys = options.maxKeys ?? 1000;
  const clock = options.clock ?? (() => Date.now());
  if (!Number.isSafeInteger(limitPerWindow) || limitPerWindow < 1) throw new Error("Invalid rate limit");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("Invalid rate window");
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error("Invalid rate limiter capacity");

  const buckets = new Map<string, { windowStart: number; count: number }>();

  function evictOverflow(now: number): void {
    // กวาดหน้าต่างที่หมดอายุออกทั้งหมดก่อนเสมอ แล้วค่อย evict หน้าต่างเก่าสุดถ้ายังเกินเพดาน
    for (const [key, bucket] of buckets) {
      if (bucket.windowStart + windowMs <= now) buckets.delete(key);
    }
    if (buckets.size <= maxKeys) return;
    while (buckets.size > maxKeys) {
      let oldestKey: string | null = null;
      let oldestStart = Infinity;
      for (const [key, bucket] of buckets) {
        if (bucket.windowStart < oldestStart) {
          oldestStart = bucket.windowStart;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      buckets.delete(oldestKey);
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const now = clock();
      const existing = buckets.get(key);
      const bucket = !existing || existing.windowStart + windowMs <= now
        ? { windowStart: now, count: 0 }
        : existing;
      bucket.count += 1;
      buckets.set(key, bucket);
      evictOverflow(now);
      if (bucket.count > limitPerWindow) {
        return { allowed: false, retryAfterMs: Math.max(1, bucket.windowStart + windowMs - now) };
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    size: () => buckets.size,
  };
}

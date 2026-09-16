import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter } from "@/modules/ai-assistant/rate-limit";

// PR2 — rate limit ระดับ route: กันเติม idempotency ledger ผ่าน session ใหม่เรื่อย ๆ (residual risk จาก PR1)

describe("fixed window rate limiter", () => {
  it("allows up to the limit then denies with retry-after", () => {
    let now = 1_000;
    const limiter = createFixedWindowRateLimiter({ limitPerWindow: 3, windowMs: 60_000, clock: () => now });
    expect(limiter.check("k")).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.check("k")).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(limiter.check("k")).toEqual({ allowed: true, retryAfterMs: 0 });
    const denied = limiter.check("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(60_000);
    now += 59_999;
    expect(limiter.check("k").allowed).toBe(false);
    now += 1;
    expect(limiter.check("k")).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("isolates keys so one noisy user never consumes another's quota", () => {
    const limiter = createFixedWindowRateLimiter({ limitPerWindow: 1, windowMs: 60_000, clock: () => 1_000 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(true);
  });

  it("keeps memory bounded by evicting expired then oldest windows", () => {
    let now = 1_000;
    const limiter = createFixedWindowRateLimiter({ limitPerWindow: 1, windowMs: 100, maxKeys: 3, clock: () => now });
    limiter.check("k1");
    limiter.check("k2");
    limiter.check("k3");
    expect(limiter.size()).toBe(3);
    // เกิน maxKeys แต่ยัง live → evict หน้าต่างเก่าสุด เพื่อไม่ให้ memory โตไม่จำกัด
    limiter.check("k4");
    expect(limiter.size()).toBe(3);
    now += 200;
    limiter.check("k5");
    expect(limiter.size()).toBe(1);
  });

  it("validates its options", () => {
    expect(() => createFixedWindowRateLimiter({ limitPerWindow: 0, windowMs: 1000 })).toThrow();
    expect(() => createFixedWindowRateLimiter({ limitPerWindow: 5, windowMs: 0 })).toThrow();
    expect(() => createFixedWindowRateLimiter({ limitPerWindow: 5, windowMs: 1000, maxKeys: 0 })).toThrow();
  });
});

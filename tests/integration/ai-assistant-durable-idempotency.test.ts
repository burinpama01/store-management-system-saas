import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DurableIdempotencyStore } from "@/modules/ai-assistant/durable-idempotency";
import type { IdempotencyClaimMeta, Result } from "@/modules/ai-assistant/foundation";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// PR3 — DB contract ของ durable idempotency (ตาราง ai_assistant_actions)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้อง apply migration 20260916000000 กับ local DB แล้ว (supabase migration up --local)
//  รวมถึง seed org/store มาตรฐานเดียวกับ print-hub test (ORG_A/STORE_A)
//
// สิ่งที่ต้องพิสูจน์กับ DB จริง (unit test ใช้ fake ไม่พอ):
//   1. atomic claim ข้าม connection จริง — คีย์เดียว execute ได้ครั้งเดียวด้วย unique constraint
//   2. replay หลัง "restart" — store instance ใหม่จาก client ใหม่อ่านผลจากแถวเดิมได้
//   3. fingerprint ต่างกันบนคีย์เดิม = IDEMPOTENCY_CONFLICT
//   4. pending ที่ยังไม่หมดอายุ fail-closed (IDEMPOTENCY_PENDING) และหมดอายุแล้ว reclaim ได้
//   5. sweepExpired กวาดเฉพาะแถวหมดอายุ

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const USER_A = "eeeeeeee-0000-0000-0000-000000000001";
const SESSION_A = "session-integration-0001";
// หน่วย retention สั้น ๆ เพื่อให้ทดสอบ reclaim/กวาดได้เร็ว (ของจริง default 24 ชม.)
// ปิด opportunistic sweep (interval ใหญ่สุด) เพื่อให้แต่ละ test ทดสอบเส้นทางของตัวเอง
// แบบ deterministic — sweep ถูกเรียกตรง ๆ เฉพาะ test ของ sweep
const STORE_OPTIONS = { retentionGraceMs: 60_000, sweepIntervalMs: Number.MAX_SAFE_INTEGER } as const;

const usedKeys: string[] = [];

describe.skipIf(!envReady)("ai assistant durable idempotency (local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;

  const meta = (idempotencyKey: string, overrides: Partial<IdempotencyClaimMeta> = {}): IdempotencyClaimMeta => ({
    scope: JSON.stringify([ORG_A, STORE_A, USER_A, SESSION_A]),
    expiresAt: Date.now() + 60_000,
    tool: "pos.add_item",
    identity: { organizationId: ORG_A, storeId: STORE_A, userId: USER_A, sessionId: SESSION_A },
    ...overrides,
  });
  const fingerprint = (tag: string) => createHash("sha256").update(tag).digest("hex");
  const ok = (data: unknown): Result => ({ ok: true, data });

  /** connection ใหม่แยกจาก service client — จำลอง process/instance อื่น */
  function newConnection(): SupabaseClient {
    return createClient(local.url, local.serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }

  beforeAll(() => {
    local = getLocalSupabase();
    service = local.client;
  });

  afterAll(async () => {
    if (usedKeys.length > 0) {
      await service.from("ai_assistant_actions").delete().eq("organization_id", ORG_A).in("idempotency_key", usedKeys);
    }
  });

  it("เคลมพร้อมกันจากสอง connection คีย์เดียว execute ได้ครั้งเดียว (atomic unique)", async () => {
    const key = "atomic-claim-01";
    usedKeys.push(key);
    const connectionA = newConnection();
    const connectionB = newConnection();
    let executions = 0;
    const slowExecute = async (): Promise<Result> => {
      executions += 1;
      await new Promise(resolve => setTimeout(resolve, 400));
      return ok({ applied: true });
    };

    const claimA = new DurableIdempotencyStore(connectionA, STORE_OPTIONS).claim(key, fingerprint("args-1"), meta(key), slowExecute);
    // ระหว่าง A กำลัง execute (แถว pending) B เคลมคีย์เดิมจากอีก connection → fail-closed
    await new Promise(resolve => setTimeout(resolve, 100));
    const storeB = new DurableIdempotencyStore(connectionB, STORE_OPTIONS);
    const whilePending = await storeB.claim(key, fingerprint("args-1"), meta(key), async () => ok({ applied: "double" }));
    expect(whilePending).toEqual({ ok: false, code: "IDEMPOTENCY_PENDING" });

    const resultA = await claimA;
    expect(resultA).toEqual({ ok: true, data: { applied: true } });
    expect(executions).toBe(1);

    // หลัง A จบ การเรียกซ้ำจาก connection อื่นได้ replay ไม่ execute ซ้ำ
    const replay = await storeB.claim(key, fingerprint("args-1"), meta(key), async () => ok({ applied: "double" }));
    expect(replay).toEqual({ ok: true, data: { applied: true } });
    expect(executions).toBe(1);
  });

  it("replay หลัง restart: instance ใหม่จาก client ใหม่อ่านผลจากแถวเดิม", async () => {
    const key = "replay-restart-01";
    usedKeys.push(key);
    let executions = 0;
    const execute = async (): Promise<Result> => {
      executions += 1;
      return ok({ count: 7 });
    };
    await new DurableIdempotencyStore(newConnection(), STORE_OPTIONS).claim(key, fingerprint("args-2"), meta(key), execute);
    expect(executions).toBe(1);

    // "restart" — store ใหม่ทั้งหมดจาก connection ใหม่
    const afterRestart = await new DurableIdempotencyStore(newConnection(), STORE_OPTIONS).claim(key, fingerprint("args-2"), meta(key), execute);
    expect(afterRestart).toEqual({ ok: true, data: { count: 7 } });
    expect(executions).toBe(1);
  });

  it("fingerprint ต่างกันบนคีย์เดิม = IDEMPOTENCY_CONFLICT ไม่ execute", async () => {
    const key = "conflict-01";
    usedKeys.push(key);
    const store = new DurableIdempotencyStore(newConnection(), STORE_OPTIONS);
    let executions = 0;
    const execute = async (): Promise<Result> => { executions += 1; return ok({ v: 1 }); };
    await store.claim(key, fingerprint("args-a"), meta(key), execute);
    const conflict = await store.claim(key, fingerprint("args-b"), meta(key), execute);
    expect(conflict).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(executions).toBe(1);
  });

  it("pending ที่ยังไม่หมดอายุ fail-closed และหมดอายุแล้ว reclaim ได้ (handler ตายกลางทาง)", async () => {
    const key = "pending-reclaim-01";
    usedKeys.push(key);
    const fp = fingerprint("args-3");
    const claimMeta = meta(key);

    // จำลอง handler ตายกลางทาง: insert pending เองแล้วทิ้ง (ไม่มีใครปิดผล)
    const deadRow = {
      organization_id: ORG_A,
      store_id: STORE_A,
      user_id: USER_A,
      session_id: SESSION_A,
      idempotency_key: key,
      tool: "pos.add_item",
      fingerprint: fp,
      status: "pending",
      result: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const inserted = await service.from("ai_assistant_actions").insert(deadRow);
    expect(inserted.error).toBeNull();

    // ยังไม่หมดอายุ = ปฏิเสธ ไม่ execute ซ้ำ
    let executions = 0;
    const execute = async (): Promise<Result> => { executions += 1; return ok({ reclaimed: true }); };
    const store = new DurableIdempotencyStore(newConnection(), STORE_OPTIONS);
    expect(await store.claim(key, fp, claimMeta, execute)).toEqual({ ok: false, code: "IDEMPOTENCY_PENDING" });
    expect(executions).toBe(0);

    // จำลองเวลาผ่านไป: ลบแถว pending เดิมแล้วแทงแถว pending หมดอายุ (guard trigger บล็อกการแก้
    // expires_at ของแถว pending โดยตรง — ตาม design "pending หมดอายุตามกำหนดเดิมเท่านั้น")
    await service.from("ai_assistant_actions").delete().eq("organization_id", ORG_A).eq("idempotency_key", key);
    const expired = await service.from("ai_assistant_actions").insert({
      ...deadRow,
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(expired.error).toBeNull();

    // หมดอายุแล้ว = reclaim ได้ (ลบแบบมีเงื่อนไขแล้วจองใหม่) และ execute ได้ตามปกติ
    expect(await store.claim(key, fp, claimMeta, execute)).toEqual({ ok: true, data: { reclaimed: true } });
    expect(executions).toBe(1);
    const { data: row } = await service.from("ai_assistant_actions").select("status, result").eq("organization_id", ORG_A).eq("idempotency_key", key).maybeSingle();
    expect(row?.status).toBe("completed");
  });

  it("sweepExpired กวาดเฉพาะแถวหมดอายุ ไม่แตะแถวที่ยังมีชีวิต", async () => {
    const liveKey = "sweep-live-01";
    const expiredKey = "sweep-expired-01";
    usedKeys.push(liveKey, expiredKey);
    const store = new DurableIdempotencyStore(newConnection(), STORE_OPTIONS);
    await store.claim(liveKey, fingerprint("live"), meta(liveKey), async () => ok({ v: 1 }));
    await service.from("ai_assistant_actions").insert({
      organization_id: ORG_A,
      store_id: STORE_A,
      user_id: USER_A,
      session_id: SESSION_A,
      idempotency_key: expiredKey,
      tool: "pos.add_item",
      fingerprint: fingerprint("expired"),
      status: "completed",
      result: { ok: true, data: { v: 0 } },
      expires_at: new Date(Date.now() - 5_000).toISOString(),
    });

    expect(await store.sweepExpired()).toBeGreaterThanOrEqual(1);
    const { data: remaining } = await service.from("ai_assistant_actions").select("idempotency_key").eq("organization_id", ORG_A).in("idempotency_key", [liveKey, expiredKey]);
    expect((remaining ?? []).map(row => row.idempotency_key)).toEqual([liveKey]);
  });
});

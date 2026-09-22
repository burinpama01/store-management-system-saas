// PR3 — unit tests ของ DurableIdempotencyStore ด้วย scripted fake supabase client (ไม่แตะ DB จริง)
// fake จำลองพฤติกรรมที่ design พึ่งพา: unique constraint (23505), filter eq/lte/in,
// maybeSingle, delete คืนรายการ id ที่ลบได้ และ inject error ราย operation ผ่าน script
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/integrations/supabase/database.types";
import { z } from "zod";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { DurableIdempotencyStore } from "@/modules/ai-assistant/durable-idempotency";
import { createDispatcher, ToolRegistry, type IdempotencyClaimMeta, type Result, type TrustedContext } from "@/modules/ai-assistant/foundation";

type FakeRow = {
  id: string;
  organization_id: string;
  store_id: string;
  user_id: string;
  session_id: string;
  idempotency_key: string;
  tool: string;
  fingerprint: string;
  status: string;
  result: unknown;
  created_at: string;
  expires_at: string;
};

interface FakeError { code?: string; message: string }

/** ตารางในหน่วยความจำ + unique (organization_id, idempotency_key) + จุด inject error ราย operation */
function createFakeDb() {
  const rows: FakeRow[] = [];
  const script = { failInsert: 0, failUpdate: 0, failSelect: 0, failDelete: 0 };

  type Filter = { op: "eq" | "lte" | "in"; col: string; val: unknown };
  const cell = (row: FakeRow, col: string): unknown => (row as unknown as Record<string, unknown>)[col];
  const matches = (row: FakeRow, filters: Filter[]): boolean => filters.every(filter => {
    if (filter.op === "eq") return cell(row, filter.col) === filter.val;
    if (filter.op === "in") return Array.isArray(filter.val) && (filter.val as unknown[]).includes(cell(row, filter.col));
    // lte ใช้กับ timestamp — เทียบแบบเดียวกับ Postgres (แปลงเป็นเวลาก่อนเทียบ)
    return Date.parse(String(cell(row, filter.col))) <= Date.parse(String(filter.val));
  });

  function makeChain(state: { op: "select" | "insert" | "update" | "delete"; values?: Partial<FakeRow>; filters: Filter[]; selected: boolean; single: boolean; maybeSingle: boolean; limitCount?: number }) {
    const run = async (): Promise<{ data: unknown; error: FakeError | null }> => {
      if (state.op === "insert") {
        if (script.failInsert > 0) { script.failInsert -= 1; return { data: null, error: { code: "XX000", message: "fake insert outage" } }; }
        const values = state.values as FakeRow;
        if (rows.some(row => row.organization_id === values.organization_id && row.idempotency_key === values.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint ai_assistant_actions_org_key_unique" } };
        }
        rows.push({ ...values });
        return { data: null, error: null };
      }
      if (state.op === "update") {
        if (script.failUpdate > 0) { script.failUpdate -= 1; return { data: null, error: { code: "XX000", message: "fake update outage" } }; }
        for (const row of rows) if (matches(row, state.filters)) Object.assign(row, state.values);
        return { data: null, error: null };
      }
      if (state.op === "delete") {
        if (script.failDelete > 0) { script.failDelete -= 1; return { data: null, error: { code: "XX000", message: "fake delete outage" } }; }
        const doomed = rows.filter(row => matches(row, state.filters));
        const limited = state.limitCount !== undefined ? doomed.slice(0, state.limitCount) : doomed;
        for (const row of limited) rows.splice(rows.indexOf(row), 1);
        return { data: state.selected ? limited.map(row => ({ id: row.id })) : null, error: null };
      }
      if (script.failSelect > 0) { script.failSelect -= 1; return { data: null, error: { code: "XX000", message: "fake select outage" } }; }
      const found = rows.filter(row => matches(row, state.filters));
      const limited = state.limitCount !== undefined ? found.slice(0, state.limitCount) : found;
      if (state.single || state.maybeSingle) return { data: limited[0] ?? null, error: null };
      return { data: limited, error: null };
    };
    const chain = {
      select: () => { state.selected = true; return chain; },
      eq: (col: string, val: unknown) => { state.filters.push({ op: "eq", col, val }); return chain; },
      lte: (col: string, val: unknown) => { state.filters.push({ op: "lte", col, val }); return chain; },
      in: (col: string, val: unknown[]) => { state.filters.push({ op: "in", col, val }); return chain; },
      limit: (n: number) => { state.limitCount = n; return chain; },
      single: () => { state.single = true; return chain; },
      maybeSingle: () => { state.maybeSingle = true; return chain; },
      then: (onFulfilled?: (value: { data: unknown; error: FakeError | null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve().then(run).then(onFulfilled, onRejected),
    };
    return chain;
  }

  const client = {
    from(table: string) {
      if (table !== "ai_assistant_actions") throw Error(`fake db: unexpected table ${table}`);
      const state: { op: "select" | "insert" | "update" | "delete"; values: Partial<FakeRow> | undefined; filters: Filter[]; selected: boolean; single: boolean; maybeSingle: boolean; limitCount: number | undefined } = { op: "select", values: undefined, filters: [], selected: false, single: false, maybeSingle: false, limitCount: undefined };
      const chain = makeChain(state);
      return {
        select: () => chain.select(),
        insert: (values: FakeRow) => { state.op = "insert"; state.values = values; return chain; },
        update: (values: Partial<FakeRow>) => { state.op = "update"; state.values = values; return chain; },
        delete: () => { state.op = "delete"; return chain; },
      };
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, rows, script };
}

const IDENTITY = { organizationId: "org", storeId: "store", userId: "user", sessionId: "session" };
const meta = (overrides: Partial<IdempotencyClaimMeta> = {}): IdempotencyClaimMeta => ({
  scope: JSON.stringify([IDENTITY.organizationId, IDENTITY.storeId, IDENTITY.userId, IDENTITY.sessionId]),
  expiresAt: Date.now() + 60_000,
  tool: "test.write",
  identity: IDENTITY,
  ...overrides,
});
const ok = (data: unknown): Result => ({ ok: true, data });
const denied = (): Result => ({ ok: false, code: "EXECUTION_FAILED" });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (value: Result) => void;
  const promise = new Promise<Result>(r => { resolve = r; });
  return { promise, resolve };
}
const options = { sweepIntervalMs: 3_600_000 };

describe("DurableIdempotencyStore", () => {
  it("executes once, stores the result and replays it from a fresh store instance (restart)", async () => {
    const db = createFakeDb();
    const execute = vi.fn(async () => ok({ count: 1 }));
    const first = await new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), execute);
    expect(first).toEqual({ ok: true, data: { count: 1 } });
    // instance ใหม่จาก DB เดิม = จำลอง restart
    const second = await new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), execute);
    expect(second).toEqual({ ok: true, data: { count: 1 } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe("completed");
    // replay ที่ได้มาแก้ไม่ได้และไม่กระทบรอบถัดไป
    if (second.ok && !("kind" in second)) (second.data as { count: number }).count = 99;
    expect(await new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), execute)).toEqual({ ok: true, data: { count: 1 } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed fingerprint on the same key", async () => {
    const db = createFakeDb();
    const store = new DurableIdempotencyStore(db.client, options);
    const execute = vi.fn(async () => ok({ count: 1 }));
    await store.claim("k1", "f1", meta(), execute);
    expect(await store.claim("k1", "f2", meta(), execute)).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a same-key claim from a different identity without leaking the stored result", async () => {
    const db = createFakeDb();
    const store = new DurableIdempotencyStore(db.client, options);
    const execute = vi.fn(async () => ok({ count: 1 }));
    await store.claim("k1", "f1", meta(), execute);
    const otherSession = meta({ identity: { ...IDENTITY, sessionId: "session-2" }, scope: "other-scope" });
    expect(await store.claim("k1", "f1", otherSession, execute)).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed with IDEMPOTENCY_PENDING while another instance holds the claim", async () => {
    const db = createFakeDb();
    const gate = deferred();
    const firstPromise = new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), () => gate.promise);
    await flush();
    expect(db.rows[0].status).toBe("pending");
    const executeB = vi.fn(async () => ok({ count: 2 }));
    expect(await new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), executeB)).toEqual({ ok: false, code: "IDEMPOTENCY_PENDING" });
    expect(executeB).not.toHaveBeenCalled();
    gate.resolve(ok({ done: true }));
    expect(await firstPromise).toEqual({ ok: true, data: { done: true } });
    // หลังตัวที่ถือ claim จบ การเรียกซ้ำได้ replay ไม่ execute ซ้ำ
    expect(await new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), executeB)).toEqual({ ok: true, data: { done: true } });
    expect(executeB).not.toHaveBeenCalled();
  });

  it("reclaims an expired pending row left by a dead handler and executes the new claim", async () => {
    const db = createFakeDb();
    const gate = deferred();
    // จำลอง handler ตายกลางทาง: claim แรกค้าง pending ตลอดไป
    void new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), () => gate.promise);
    await flush();
    db.rows[0].expires_at = new Date(Date.now() - 1_000).toISOString();
    const executeB = vi.fn(async () => ok({ count: 3 }));
    const reclaimed = await new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), executeB);
    expect(reclaimed).toEqual({ ok: true, data: { count: 3 } });
    expect(executeB).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe("completed");
    gate.resolve(denied()); // ตัวเก่ากลับมาจบทีหลัง — ต้องไม่ทับผลใหม่
    await flush();
    expect(db.rows[0].status).toBe("completed");
  });

  it("replays a stored failure without re-executing", async () => {
    const db = createFakeDb();
    const execute = vi.fn(async () => denied());
    const store = new DurableIdempotencyStore(db.client, options);
    expect(await store.claim("k1", "f1", meta(), execute)).toEqual({ ok: false, code: "EXECUTION_FAILED" });
    expect(await store.claim("k1", "f1", meta(), execute)).toEqual({ ok: false, code: "EXECUTION_FAILED" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.rows[0].status).toBe("failed");
  });

  it("keeps the row pending when the result write fails so replays stay closed", async () => {
    const db = createFakeDb();
    db.script.failUpdate = 1;
    const store = new DurableIdempotencyStore(db.client, options);
    const execute = vi.fn(async () => ok({ count: 1 }));
    // DB สะดุดตอนบันทึกผล — ผู้เรียกได้ผลจริง แต่แถวค้าง pending
    expect(await store.claim("k1", "f1", meta(), execute)).toEqual({ ok: true, data: { count: 1 } });
    expect(db.rows[0].status).toBe("pending");
    const executeB = vi.fn(async () => ok({ count: 2 }));
    expect(await store.claim("k1", "f1", meta(), executeB)).toEqual({ ok: false, code: "IDEMPOTENCY_PENDING" });
    expect(executeB).not.toHaveBeenCalled();
  });

  it("sweeps only expired rows, frees their keys and keeps live rows", async () => {
    const db = createFakeDb();
    const store = new DurableIdempotencyStore(db.client, options);
    await store.claim("k-old", "f1", meta(), async () => ok({ count: 1 }));
    await store.claim("k-live", "f2", meta(), async () => ok({ count: 2 }));
    db.rows[0].expires_at = new Date(Date.now() - 1_000).toISOString();
    // แถวหมดอายุของ org อื่นถูกกวาดด้วย (retention เป็นระดับ infrastructure)
    db.rows.push({ ...db.rows[0], id: "row-other-org", organization_id: "org-2", idempotency_key: "k-other" });
    expect(await store.sweepExpired()).toBe(2);
    expect(db.rows.map(row => row.idempotency_key)).toEqual(["k-live"]);
    // คีย์ที่ถูกกวาดแล้วจองใหม่ได้
    const execute = vi.fn(async () => ok({ count: 9 }));
    expect(await store.claim("k-old", "f1", meta(), execute)).toEqual({ ok: true, data: { count: 9 } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps storage outages to thrown errors (dispatcher turns them into CONTEXT_UNAVAILABLE)", async () => {
    const db = createFakeDb();
    db.script.failInsert = 1;
    await expect(new DurableIdempotencyStore(db.client, options).claim("k1", "f1", meta(), async () => ok({ count: 1 }))).rejects.toThrow();
  });

  it("requires identity metadata and valid options", async () => {
    const db = createFakeDb();
    const store = new DurableIdempotencyStore(db.client, options);
    await expect(store.claim("k1", "f1", { scope: "s", expiresAt: Date.now() + 1_000 }, async () => ok(null))).rejects.toThrow();
    expect(() => new DurableIdempotencyStore(db.client, { retentionGraceMs: -1 })).toThrow();
    expect(() => new DurableIdempotencyStore(db.client, { sweepBatchSize: 0 })).toThrow();
  });
});

// PR3 — wiring ของ dispatcher: production safe_write ปลดได้เฉพาะเมื่อ wire durable store
// และเปิด mutation switch เท่านั้น — ค่า default (memory) ยังติด DURABLE_STORAGE_REQUIRED เหมือนเดิม
describe("dispatcher wired with durable idempotency", () => {
  const context = (): TrustedContext => ({ organizationId: "org", storeId: "store", userId: "user", sessionId: "session", role: "owner", expiresAt: Date.now() + 60000, allowedTools: ["test.write"], billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" }, can: () => true });
  const write = (idempotencyKey = "key1") => ({ tool: "test.write", args: { value: "hello" }, idempotencyKey });
  function setup(overrides: { mutationsEnabled?: boolean } = {}) {
    const db = createFakeDb();
    const execute = vi.fn(async () => ({ count: 1 }));
    const audit = vi.fn(async () => {});
    const registry = new ToolRegistry("production");
    registry.register({ name: "test.write", risk: "safe_write", permissions: ["pos.use"], args: z.object({ value: z.string() }).strict(), result: z.object({ count: z.number() }), execute });
    const ctx = context();
    const dispatch = createDispatcher({
      registry, enabled: true, environment: "production", mutationsEnabled: overrides.mutationsEnabled,
      resolveContext: async () => ctx, audit,
      idempotencyStore: new DurableIdempotencyStore(db.client, { sweepIntervalMs: 3_600_000 }),
    });
    return { db, execute, audit, dispatch };
  }

  it("passes production safe_write through a durable store when mutations are enabled", async () => {
    const s = setup({ mutationsEnabled: true });
    expect(await s.dispatch(write())).toEqual({ ok: true, data: { count: 1 } });
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.db.rows).toHaveLength(1);
    expect(s.db.rows[0].status).toBe("completed");
    expect(s.db.rows[0].tool).toBe("test.write");
    expect(s.db.rows[0].session_id).toBe("session");
    // replay ข้าม request ผ่าน durable store — execute ครั้งเดียว
    expect(await s.dispatch(write())).toEqual({ ok: true, data: { count: 1 } });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("still requires the mutation switch even when a durable store is wired", async () => {
    const s = setup();
    expect(await s.dispatch(write())).toEqual({ ok: false, code: "MUTATIONS_DISABLED" });
    expect(s.execute).not.toHaveBeenCalled();
    // ปฏิเสธก่อนแตะ store — ไม่มีแถวค้างในตาราง
    expect(s.db.rows).toHaveLength(0);
  });

  it("maps durable storage outages to CONTEXT_UNAVAILABLE without executing", async () => {
    const s = setup({ mutationsEnabled: true });
    s.db.script.failInsert = 1;
    expect(await s.dispatch(write())).toEqual({ ok: false, code: "CONTEXT_UNAVAILABLE" });
    expect(s.execute).not.toHaveBeenCalled();
  });
});

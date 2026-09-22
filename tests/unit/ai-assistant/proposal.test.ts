// P1 — ชั้นยืนยัน: เสนอ → รอยืนยัน → ค่อยทำ
//
// สิ่งที่เทสชุดนี้ต้องพิสูจน์ ไล่ตามเหตุผลที่ชั้นนี้มีอยู่:
//   1. จังหวะแรกต้อง "ไม่เขียนอะไรเลย" จริง ๆ
//   2. ยืนยันแล้วต้องทำด้วย args ชุดที่เก็บไว้ ไม่ใช่ชุดที่ client ส่งมาใหม่
//   3. โลกเปลี่ยนระหว่างที่ผู้ใช้ดูการ์ด = ต้องล้ม ไม่ใช่เขียนทับเงียบ ๆ
//   4. "ไม่มีให้เพิ่ม ไม่ใช่ข้าม" — เหลือสิ่งที่ขาดแม้ข้อเดียวก็ commit ไม่ได้
//   5. กดยืนยันรัวต้องทำงานรอบเดียว

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createDispatcher, ToolRegistry, type Result, type TrustedContext } from "@/modules/ai-assistant/foundation";
import {
  fingerprintDraft,
  unresolvedPrerequisites,
  type Prerequisite,
  type ProposalDraft,
  type ProposalRecord,
  type ProposalStore,
} from "@/modules/ai-assistant/proposal";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";

const ctx = (): TrustedContext => ({
  organizationId: "org-1",
  storeId: "store-1",
  userId: "user-1",
  sessionId: "sess-1",
  expiresAt: Date.now() + 30 * 60 * 1000,
  allowedTools: ["catalog.update_product"],
  billing: { ...DEFAULT_BILLING_STATE, plan: "enterprise", status: "active" },
  can: () => true,
});

function memoryProposalStore(): ProposalStore & { rows: Map<string, ProposalRecord & { used: boolean }> } {
  const rows = new Map<string, ProposalRecord & { used: boolean }>();
  return {
    rows,
    save: async (record) => { rows.set(record.id, { ...record, used: false }); },
    load: async (id) => {
      const row = rows.get(id);
      return row && !row.used ? row : null;
    },
    consume: async (id) => {
      const row = rows.get(id);
      if (!row || row.used) return false;
      row.used = true;
      return true;
    },
  };
}

describe("ชั้นยืนยัน (P1)", () => {
  let writes: string[];
  let draft: ProposalDraft;
  let proposals: ReturnType<typeof memoryProposalStore>;
  let registry: ToolRegistry;
  let dispatch: (request: unknown) => Promise<Result>;
  let idSeq: number;

  const baseDraft = (prerequisites: readonly Prerequisite[] = []): ProposalDraft => ({
    summary: "เปลี่ยนราคาอเมริกาโน่เย็น 55 → 60 บาท",
    changes: [{ label: "ราคา", before: "55", after: "60" }],
    affectedCount: 1,
    warnings: [],
    prerequisites,
  });

  beforeEach(() => {
    writes = [];
    idSeq = 0;
    draft = baseDraft();
    proposals = memoryProposalStore();
    registry = new ToolRegistry("test");
    registry.register({
      name: "catalog.update_product",
      risk: "sensitive",
      permissions: [],
      args: z.object({ productId: z.string(), price: z.number() }).strict(),
      result: z.object({ updated: z.boolean() }).strict(),
      plan: async () => draft,
      execute: async (args) => {
        writes.push(JSON.stringify(args));
        return { updated: true };
      },
    });
    dispatch = createDispatcher({
      registry,
      enabled: true,
      mutationsEnabled: true,
      environment: "test",
      resolveContext: async () => ctx(),
      audit: async () => {},
      proposals,
      newProposalId: () => `prop-${++idSeq}`,
    });
  });

  const command = (extra: Record<string, unknown> = {}) => ({
    tool: "catalog.update_product",
    args: { productId: "p1", price: 60 },
    idempotencyKey: "key-1",
    ...extra,
  });

  it("จังหวะแรกคืนการ์ดและไม่เขียนอะไรเลย", async () => {
    const result = await dispatch(command());
    expect(result).toMatchObject({ ok: true, kind: "proposal" });
    expect((result as { proposal: { summary: string; id: string } }).proposal.summary).toContain("55 → 60");
    expect(writes).toEqual([]);
  });

  it("ยืนยันแล้วจึงเขียน และใช้ args ชุดที่เก็บไว้ ไม่ใช่ชุดที่ client ส่งมาใหม่", async () => {
    await dispatch(command());
    // client แอบเปลี่ยนราคาตอนกดยืนยัน — ต้องไม่มีผล เพราะ commit ใช้ args ที่เก็บไว้
    const result = await dispatch(command({
      args: { productId: "p1", price: 999 },
      idempotencyKey: "key-2",
      confirm: { proposalId: "prop-1" },
    }));
    expect(result).toMatchObject({ ok: true });
    expect(writes).toEqual([JSON.stringify({ productId: "p1", price: 60 })]);
  });

  it("โลกเปลี่ยนระหว่างที่ผู้ใช้ดูการ์ด = PROPOSAL_STALE ไม่ใช่เขียนทับ", async () => {
    await dispatch(command());
    // ราคาเดิมของเมนูเปลี่ยนไประหว่างที่ผู้ใช้ดูการ์ด (คนอื่นแก้) — before คือค่าจากโลก
    draft = { ...baseDraft(), changes: [{ label: "ราคา", before: "70", after: "60" }] };
    const result = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1" } }));
    expect(result).toEqual({ ok: false, code: "PROPOSAL_STALE" });
    expect(writes).toEqual([]);
  });

  it("คำเตือนที่เปลี่ยนไม่ทำให้ยืนยันไม่ได้ (ร้านที่ยุ่งต้องยังกดได้)", async () => {
    await dispatch(command());
    draft = { ...baseDraft(), warnings: ["เมนูนี้อยู่ในตะกร้าที่เปิดอยู่ 2 ใบ"] };
    const result = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1" } }));
    expect(result).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
  });

  it("เหลือสิ่งที่ขาดแม้ข้อเดียวก็ commit ไม่ได้ — ไม่มีให้เพิ่ม ไม่ใช่ข้าม", async () => {
    draft = baseDraft([{
      kind: "choose",
      need: "สถานีครัว",
      subjects: [{ id: "p1", label: "อเมริกาโน่เย็น" }, { id: "p2", label: "ลาเต้" }],
      options: [{ id: "st1", label: "บาร์" }],
    }]);
    await dispatch(command());
    // ตอบไม่ครบ (ขาด p2)
    const partial = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1", answers: { p1: "st1" } } }));
    expect(partial).toEqual({ ok: false, code: "PREREQUISITE_REQUIRED" });
    expect(writes).toEqual([]);
  });

  it("ตอบครบแล้วยืนยันผ่าน", async () => {
    draft = baseDraft([{
      kind: "choose",
      need: "สถานีครัว",
      subjects: [{ id: "p1", label: "อเมริกาโน่เย็น" }],
      options: [{ id: "st1", label: "บาร์" }],
    }]);
    await dispatch(command());
    const result = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1", answers: { p1: "st1" } } }));
    expect(result).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
  });

  it("prerequisite แบบ create/blocked ตอบด้วยคำตอบไม่ได้", async () => {
    for (const prerequisite of [
      { kind: "create", need: "สถานีครัว", createTool: "kitchen.create_station", reason: "ร้านยังไม่มีสถานี" },
      { kind: "blocked", need: "QR Ordering", feature: "qrOrdering" },
    ] as Prerequisite[]) {
      expect(unresolvedPrerequisites([prerequisite], { anything: "yes" })).toHaveLength(1);
    }
  });

  it("กดยืนยันรัวทำงานรอบเดียว", async () => {
    await dispatch(command());
    const first = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1" } }));
    const second = await dispatch(command({ idempotencyKey: "key-3", confirm: { proposalId: "prop-1" } }));
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    expect(writes).toHaveLength(1);
  });

  it("proposal หมดอายุแล้วยืนยันไม่ได้", async () => {
    await dispatch(command());
    const row = proposals.rows.get("prop-1")!;
    proposals.rows.set("prop-1", { ...row, expiresAt: Date.now() - 1 });
    const result = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1" } }));
    expect(result).toEqual({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    expect(writes).toEqual([]);
  });

  it("session อื่นยื่น proposalId เข้ามาไม่ผ่าน", async () => {
    await dispatch(command());
    const row = proposals.rows.get("prop-1")!;
    proposals.rows.set("prop-1", { ...row, userId: "user-2" });
    const result = await dispatch(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-1" } }));
    expect(result).toEqual({ ok: false, code: "PROPOSAL_NOT_FOUND" });
    expect(writes).toEqual([]);
  });

  it("ยืนยันข้าม tool ไม่ผ่าน", async () => {
    await dispatch(command());
    registry.register({
      name: "catalog.delete_product",
      risk: "critical",
      permissions: [],
      args: z.object({ productId: z.string(), price: z.number() }).strict(),
      result: z.object({ updated: z.boolean() }).strict(),
      plan: async () => draft,
      execute: async () => { writes.push("deleted"); return { updated: true }; },
    });
    const result = await dispatch({
      tool: "catalog.delete_product",
      args: { productId: "p1", price: 60 },
      idempotencyKey: "key-2",
      confirm: { proposalId: "prop-1" },
    });
    // allowedTools ไม่มี tool นี้ = ถูกปฏิเสธก่อนถึงชั้นยืนยันด้วยซ้ำ
    expect(result).toEqual({ ok: false, code: "PERMISSION_DENIED" });
    expect(writes).toEqual([]);
  });

  it("tool ระดับ sensitive ที่ไม่มี plan() ยังถูกบล็อกเหมือนเดิม", async () => {
    const bare = new ToolRegistry("test");
    bare.register({
      name: "catalog.risky",
      risk: "sensitive",
      permissions: [],
      args: z.object({}).strict(),
      result: z.object({}).strict(),
      execute: async () => ({}),
    });
    const d = createDispatcher({
      registry: bare, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ({ ...ctx(), allowedTools: ["catalog.risky"] }),
      audit: async () => {}, proposals,
    });
    expect(await d({ tool: "catalog.risky", args: {}, idempotencyKey: "k" })).toEqual({ ok: false, code: "RISK_BLOCKED" });
  });

  it("ไม่มีที่เก็บ proposal = ปฏิเสธ ไม่ใช่ข้ามการยืนยัน", async () => {
    const d = createDispatcher({
      registry, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {},
    });
    expect(await d(command())).toEqual({ ok: false, code: "PROPOSAL_UNAVAILABLE" });
    expect(writes).toEqual([]);
  });

  it("mutation ปิดอยู่ = ไม่เสนอการ์ดที่กดยืนยันไม่ได้", async () => {
    const d = createDispatcher({
      registry, enabled: true, mutationsEnabled: false, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {}, proposals,
    });
    expect(await d(command())).toEqual({ ok: false, code: "MUTATIONS_DISABLED" });
  });

  it("ลายนิ้วมือนับสภาพของโลก ไม่นับสิ่งที่ผู้ใช้เลือก", () => {
    const base = baseDraft();
    // โลกเปลี่ยน = ต้องต่าง
    expect(fingerprintDraft({ ...base, affectedCount: 2 })).not.toBe(fingerprintDraft(base));
    expect(fingerprintDraft({ ...base, changes: [{ label: "ราคา", before: "70", after: "60" }] })).not.toBe(fingerprintDraft(base));
    // summary เป็นข้อความสำหรับคนอ่าน ขยับตามคำตอบผู้ใช้ได้ จึงไม่นับ
    expect(fingerprintDraft({ ...base, summary: "อย่างอื่น" })).toBe(fingerprintDraft(base));
    // ผู้ใช้เปลี่ยนใจ / เสียงรบกวนจากงานหน้าร้าน = ต้องเหมือนเดิม
    expect(fingerprintDraft({ ...base, warnings: ["a"] })).toBe(fingerprintDraft({ ...base, warnings: ["b"] }));
    expect(fingerprintDraft({ ...base, changes: [{ label: "ราคา", before: "55", after: "61" }] })).toBe(fingerprintDraft(base));
    expect(fingerprintDraft(baseDraft([{ kind: "blocked", need: "x", feature: "y" }]))).toBe(fingerprintDraft(base));
  });

  it("ตอบ prerequisite แล้วค่าที่เลือกถึงมือ execute", async () => {
    let seen: Record<string, string> | null = null;
    const reg = new ToolRegistry("test");
    reg.register({
      name: "catalog.update_product",
      risk: "sensitive",
      permissions: [],
      args: z.object({ productId: z.string(), price: z.number() }).strict(),
      result: z.object({ updated: z.boolean() }).strict(),
      plan: async (_args, _ctx, answers) => baseDraft(
        answers.p1 ? [] : [{ kind: "choose", need: "สถานีครัว", subjects: [{ id: "p1", label: "อเมริกาโน่เย็น" }], options: [{ id: "st1", label: "บาร์" }] }],
      ),
      execute: async (_args, _ctx, _cart, answers) => { seen = { ...answers }; return { updated: true }; },
    });
    const d = createDispatcher({
      registry: reg, enabled: true, mutationsEnabled: true, environment: "test",
      resolveContext: async () => ctx(), audit: async () => {}, proposals,
      newProposalId: () => "prop-x",
    });
    await d(command());
    const result = await d(command({ idempotencyKey: "key-2", confirm: { proposalId: "prop-x", answers: { p1: "st1" } } }));
    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual({ p1: "st1" });
  });
});

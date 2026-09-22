import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canUseFeature, type BillingState } from "@/modules/billing/types";
import {
  belongsToContext,
  fingerprintDraft,
  unresolvedPrerequisites,
  PROPOSAL_TTL_MS,
  type PrerequisiteAnswers,
  type ProposalDraft,
  type ProposalStore,
} from "./proposal";
import type { PermissionKey } from "@/modules/tenants/types";

export type Environment = "development" | "test" | "production";
export type Risk = "read" | "safe_write" | "sensitive" | "critical";
export type ErrorCode = "INVALID_REQUEST" | "UNKNOWN_TOOL" | "INVALID_ARGS" | "PERMISSION_DENIED" | "FEATURE_DISABLED" | "MUTATIONS_DISABLED" | "RISK_BLOCKED" | "CONTEXT_UNAVAILABLE" | "DURABLE_STORAGE_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_PENDING" | "CAPACITY_EXCEEDED" | "EXECUTION_FAILED"
  // P1 — ชั้นยืนยัน
  | "PROPOSAL_UNAVAILABLE" | "PROPOSAL_NOT_FOUND" | "PROPOSAL_STALE" | "PREREQUISITE_REQUIRED";

/** การ์ดยืนยันที่ส่งกลับให้ผู้ใช้ดูก่อนลงมือ — ยังไม่มีอะไรถูกเขียน ณ จุดนี้ */
export interface ProposalView extends ProposalDraft {
  readonly id: string;
  readonly tool: string;
  readonly expiresAt: number;
}

export type Result =
  | { ok: true; data: unknown }
  /** kind แยกไว้ให้ผู้เรียกบังคับจัดการทั้งสองทาง — ลืมจัดการแล้ว tsc ฟ้อง */
  | { ok: true; kind: "proposal"; proposal: ProposalView }
  | { ok: false; code: ErrorCode };
/** ส่งมาจาก server resolver เท่านั้น ห้ามสร้างจาก model/client request */
export interface TrustedContext {
  organizationId: string;
  storeId: string;
  userId: string;
  sessionId: string;
  expiresAt: number;
  allowedTools: readonly string[];
  billing: BillingState;
  can: (permission: PermissionKey) => boolean;
}
/**
 * binding ของตะกร้าที่ server ตรวจแล้วเท่านั้น (PR2) — tool ที่ requiresActiveCart ได้รับ
 * ค่านี้จาก dispatcher ผ่าน resolveCartBinding ซึ่งต้อง derive จาก session ฝั่ง server
 * ห้ามสร้างจาก model หรือเชื่อ activeCartId จาก request โดยตรง
 */
export interface CartBinding {
  readonly activeCartId: string;
  readonly cartVersion: number;
}
export interface ToolDefinition {
  name: string;
  risk: Risk;
  permissions: readonly PermissionKey[];
  args: z.ZodType;
  result: z.ZodType;
  developmentOnly?: boolean;
  requiresActiveCart?: boolean;
  /**
   * P1 — มี plan() = tool นี้ "ต้องยืนยันก่อนลงมือ"
   *
   * ต้องคำนวณผลที่จะเกิดโดย **ไม่เขียนอะไรเลย** และคืน prerequisite ให้ครบในรอบเดียว
   * tool ที่ไม่มี plan() ทำงานทันทีเหมือนเดิม (เส้นทางหน้าขายที่ต้องเร็วยังไม่ถูกแตะ)
   */
  plan?: (args: unknown, context: TrustedContext, answers: PrerequisiteAnswers) => Promise<ProposalDraft>;
  /**
   * `answers` คือคำตอบของ prerequisite ที่ผู้ใช้เลือกในการ์ด (เช่นหมวดบัญชี/สถานีครัว)
   * tool ที่ไม่มี plan() ไม่เคยได้รับค่านี้ จึงประกาศพารามิเตอร์นี้หรือไม่ก็ได้
   */
  execute: (args: unknown, context: TrustedContext, cartBinding: CartBinding | null, answers: PrerequisiteAnswers) => Promise<unknown>;
}
const nameSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(80);
const envelope = z.object({
  tool: nameSchema,
  args: z.unknown(),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  // P1 — กดยืนยันส่งมาแค่ id ของ proposal (+ คำตอบของสิ่งที่ขาด) ไม่ส่ง args กลับมา
  // เพราะ args ที่เชื่อถือได้คือชุดที่ผ่าน Zod ตอน plan และถูกเก็บไว้ฝั่ง server แล้ว
  confirm: z.object({
    proposalId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    answers: z.record(z.string().max(128), z.string().max(128)).optional(),
  }).strict().optional(),
}).strict();

export class ToolRegistry {
  private readonly tools = new Map<string, Readonly<ToolDefinition>>();
  constructor(readonly environment: Environment) {}
  register(tool: ToolDefinition): void {
    if (!nameSchema.safeParse(tool.name).success || this.tools.has(tool.name)) throw new Error("Invalid or duplicate tool");
    if (this.environment === "production" && (tool.developmentOnly || tool.name === "system.echo")) throw new Error("Development tool unavailable");
    this.tools.set(tool.name, Object.freeze({ ...tool, permissions: Object.freeze([...tool.permissions]) }));
  }
  get(name: string): Readonly<ToolDefinition> | undefined { return this.tools.get(name); }
}

/** Audit เป็น allowlist metadata เท่านั้น ไม่มี args/results/error text */
export interface AuditMetadata {
  organizationId: string;
  storeId: string;
  actorUserId: string;
  tool: string;
  risk: Risk;
  outcome: "success" | ErrorCode;
}
interface DispatcherOptions {
  registry: ToolRegistry;
  enabled?: boolean | (() => boolean);
  /** สวิตช์เปิด tool ที่เขียนข้อมูล ปิดเป็นค่าเริ่มต้นและ re-check ทุกครั้งรวมถึงตอน replay */
  mutationsEnabled?: boolean | (() => boolean);
  environment: Environment;
  resolveContext: () => Promise<TrustedContext>;
  audit: (metadata: AuditMetadata) => Promise<void>;
  capacity?: number;
  /** โควตา idempotency ต่อ scope (organization|store|user|session) — session เดียวเต็มแล้ว fail เฉพาะตัวเอง ไม่กระทบ session อื่น */
  scopeCapacity?: number;
  /**
   * PR3 — store idempotency ภายนอก (เช่น DurableIdempotencyStore) ไม่ให้ = memory store เดิม
   * production จะปลด safe_write ได้ก็ต่อเมื่อ store ที่ให้มามี durability แบบ durable เท่านั้น
   * (memory เสมอ → ติด DURABLE_STORAGE_REQUIRED เหมือนเดิม)
   */
  idempotencyStore?: IdempotencyStore;
  /** P1 — ที่เก็บ proposal; ไม่ให้ = tool ที่ต้องยืนยันใช้ไม่ได้ (ปฏิเสธ ไม่ใช่ข้ามการยืนยัน) */
  proposals?: ProposalStore;
  /** P1 — ตัวสร้าง id ของ proposal (แทนที่ได้ในเทส) */
  newProposalId?: () => string;
  /**
   * ตรวจ cart binding ให้ tool ที่ requiresActiveCart (PR2) — derive จาก session ฝั่ง server เท่านั้น
   * คืน null / throw = ปฏิเสธด้วย CONTEXT_UNAVAILABLE ก่อนถึง execute เสมอ
   * ไม่ให้ option นี้ = tool ที่ต้องการ binding ถูกปฏิเสธทั้งหมด (fail closed เหมือน PR1)
   */
  resolveCartBinding?: (context: TrustedContext, args: unknown) => Promise<CartBinding | null>;
}
function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    // NaN/Infinity กลายเป็น null ตอน JSON.stringify จึงต้องปฏิเสธ ไม่ให้ fingerprint ชนกัน
    if (!Number.isFinite(value)) throw Error("Non JSON argument");
    return JSON.stringify(value);
  }
  // undefined/function/symbol/bigint ไม่ใช่ JSON
  if (typeof value !== "object") throw Error("Non JSON argument");
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const proto = Object.getPrototypeOf(value);
  // Date/Map/instance ของคลาสยอมให้ JSON.stringify แปลงเงียบ ๆ จึงต้องปฏิเสธก่อน
  if (proto !== Object.prototype && proto !== null) throw Error("Non JSON argument");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export const fail = (code: ErrorCode): Result => ({ ok: false, code });

/** ขอบเขตโควตาของแต่ละ claim — store แยก ledger ตาม scope และใช้ expiresAt หา entry ที่ evict ได้ */
export interface IdempotencyClaimMeta {
  /** กลุ่มโควตา เช่น organization|store|user|session — ต่างกันคือคนละ ledger ไม่แชร์ key และไม่แชร์ capacity */
  scope: string;
  /** เวลาหมดอายุของ session เจ้าของ claim (epoch ms) — entry ที่ expiresAt <= now evict ได้ทุกเมื่อ */
  expiresAt: number;
  /** PR3 — ชื่อ tool ที่ถูกเรียก สำหรับบันทึกลง ai_assistant_actions (memory store ไม่ใช้) */
  tool?: string;
  /** PR3 — identity ของ scope สำหรับ durable store ตัดสิน replay/conflict ว่าเป็นของ session เดิม (memory store ไม่ใช้) */
  identity?: {
    readonly organizationId: string;
    readonly storeId: string;
    readonly userId: string;
    readonly sessionId: string;
  };
}

/**
 * durability "memory" = อยู่เฉพาะ process (dev/test), "supabase" = อยู่รอด restart
 * และปลอดภัยข้าม process — เกต production safe_write ของ dispatcher ยอมรับเฉพาะเจ้าหลัง
 */
export interface IdempotencyStore {
  readonly durability: "memory" | "supabase";
  claim(key: string, fingerprint: string, meta: IdempotencyClaimMeta, execute: () => Promise<Result>): Promise<Result>;
}

interface IdempotencyEntry {
  fingerprint: string;
  result: Promise<Result>;
  expiresAt: number;
}

/**
 * Ledger แยกตาม scope (organization|store|user|session): session เดียวเติมเต็มโควตาตัวเองแล้ว fail-closed
 * เฉพาะ scope นั้น ไม่ลาก session อื่น ส่วน global backstop จำกัดหน่วยความจำรวมเมื่อมี session เยอะ
 * ทั้งสองชั้นต้อง evict entry ที่หมดอายุ (expiresAt <= now) ก่อนตัดสินว่าเต็ม
 * Evict ได้เฉพาะ entry ที่ expiresAt <= now เท่านั้น เพราะ dispatcher ปัด context หมดอายุด้วย
 * CONTEXT_UNAVAILABLE ก่อนถึง store แล้ว และ replay ที่ผ่าน gate จะต่ออายุ entry ด้วย expiresAt ใหม่ทุกครั้ง
 * จึงไม่มี replay ของ session ที่ยังผ่าน gate ไปเจอ entry ที่ถูก evict (ยกเว้นหน้าต่างที่ session ถูกต่ออายุ
 * แต่ยังไม่มี replay เลยระหว่างนั้น — ผู้เรียก store ตรง ๆ ต้องรักษากฎนี้เอง)
 * ยังไม่มี retry อัตโนมัติ เพราะ handler ที่ throw อาจทำ side effect ไปแล้ว
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly durability = "memory" as const;
  private readonly ledgers = new Map<string, Map<string, IdempotencyEntry>>();
  constructor(private readonly capacity = 1000, private readonly scopeCapacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid capacity");
    if (!Number.isSafeInteger(scopeCapacity) || scopeCapacity < 1) throw Error("Invalid scope capacity");
  }
  async claim(key: string, fingerprint: string, meta: IdempotencyClaimMeta, execute: () => Promise<Result>): Promise<Result> {
    // expiresAt แบบ NaN/Infinity จะไม่มีวันหมดอายุและรั่วถาวร จึงต้องปฏิเสธ (dispatcher ตรวจ finite มาก่อนแล้ว)
    if (typeof meta?.scope !== "string" || meta.scope.length === 0 || !Number.isFinite(meta.expiresAt)) throw Error("Invalid idempotency claim");
    const existing = this.ledgers.get(meta.scope)?.get(key);
    // replay/conflict ตรวจก่อนเสมอ แม้ entry หมดอายุแล้ว — ห้าม execute ซ้ำเมื่อ key+fingerprint เดิม
    if (existing) {
      if (existing.fingerprint !== fingerprint) return fail("IDEMPOTENCY_CONFLICT");
      // replay ผ่าน gate มาได้แปลว่า session ยังมีชีวิตถึง meta.expiresAt จึงต่ออายุ entry กันโดน evict ก่อนเวลา (delete+set คง insertion order)
      const ledger = this.ledgers.get(meta.scope);
      if (ledger && meta.expiresAt > existing.expiresAt) {
        ledger.delete(key);
        ledger.set(key, { ...existing, expiresAt: meta.expiresAt });
      }
      return structuredClone(await existing.result);
    }
    const ledger = this.ledgers.get(meta.scope) ?? new Map<string, IdempotencyEntry>();
    if (ledger.size >= this.scopeCapacity) this.evictExpired(ledger);
    if (this.totalSize() >= this.capacity) this.evictExpiredAll();
    if (ledger.size >= this.scopeCapacity || this.totalSize() >= this.capacity) {
      if (ledger.size === 0) this.ledgers.delete(meta.scope);
      return fail("CAPACITY_EXCEEDED");
    }
    // จองก่อน callback เริ่ม จึงไม่มีช่องว่างระหว่าง check กับ insert
    const result = Promise.resolve().then(execute).catch(() => fail("EXECUTION_FAILED"));
    ledger.set(key, { fingerprint, result, expiresAt: meta.expiresAt });
    this.ledgers.set(meta.scope, ledger);
    return structuredClone(await result);
  }
  private totalSize(): number {
    let total = 0;
    for (const ledger of this.ledgers.values()) total += ledger.size;
    return total;
  }
  private evictExpired(ledger: Map<string, IdempotencyEntry>): void {
    const now = Date.now();
    for (const [key, entry] of ledger) if (entry.expiresAt <= now) ledger.delete(key);
  }
  private evictExpiredAll(): void {
    const now = Date.now();
    for (const [scope, ledger] of this.ledgers) {
      for (const [key, entry] of ledger) if (entry.expiresAt <= now) ledger.delete(key);
      if (ledger.size === 0) this.ledgers.delete(scope);
    }
  }
}

/** In-memory ledger: capacity ต่อ scope + evict session หมดอายุ + global backstop — เต็มจริงแล้วจึงปฏิเสธ แทนเสี่ยง execute write ซ้ำ */
export function createDispatcher(options: DispatcherOptions): (request: unknown) => Promise<Result> {
  // PR3 — รับ external store ได้แล้ว แต่ไม่ให้ = memory store เดิมเสมอ (พฤติกรรม dev/test/production คงเดิม)
  const store: IdempotencyStore = options.idempotencyStore ?? new MemoryIdempotencyStore(options.capacity, options.scopeCapacity);
  return async request => {
    const parsed = envelope.safeParse(request);
    if (!parsed.success) return fail("INVALID_REQUEST");
    try {
      if ((typeof options.enabled === "function" ? options.enabled() : options.enabled) !== true) return fail("FEATURE_DISABLED");
    } catch { return fail("FEATURE_DISABLED"); }
    let ctx: TrustedContext;
    try {
      ctx = await options.resolveContext();
      if (!ctx || ![ctx.organizationId, ctx.storeId, ctx.userId, ctx.sessionId].every(id => typeof id === "string" && id.length > 0 && id.length <= 128)
        || !Number.isFinite(ctx.expiresAt) || ctx.expiresAt <= Date.now() || !Array.isArray(ctx.allowedTools) || typeof ctx.can !== "function" || !ctx.billing) return fail("CONTEXT_UNAVAILABLE");
    } catch { return fail("CONTEXT_UNAVAILABLE"); }
    const tool = options.registry.get(parsed.data.tool);
    if (!tool) return fail("UNKNOWN_TOOL");
    const audit = async (result: Result) => {
      try { await options.audit({ organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: ctx.userId, tool: tool.name, risk: tool.risk, outcome: result.ok ? "success" : result.code }); } catch { /* audit outage ไม่เปลี่ยน execution result */ }
      return result;
    };
    try {
      if (!canUseFeature(ctx.billing, "aiAssistant")) return audit(fail("FEATURE_DISABLED"));
      if (!ctx.allowedTools.includes(tool.name) || !tool.permissions.every(permission => ctx.can(permission))) return audit(fail("PERMISSION_DENIED"));
      if (options.environment === "production" && (tool.developmentOnly || tool.name === "system.echo")) return audit(fail("RISK_BLOCKED"));
      // P1 — sensitive/critical เปิดได้เฉพาะ tool ที่มีชั้นยืนยัน: ไม่มี plan() หรือไม่มีที่เก็บ
      // proposal = ปฏิเสธ ไม่ใช่ปล่อยให้ทำทันที (ชั้นยืนยันคือเหตุผลเดียวที่ยอมให้ระดับนี้ผ่าน)
      const needsConfirmation = typeof tool.plan === "function";
      if (tool.risk !== "read" && tool.risk !== "safe_write" && !needsConfirmation) return audit(fail("RISK_BLOCKED"));
      if (needsConfirmation && !options.proposals) return audit(fail("PROPOSAL_UNAVAILABLE"));
      const args = tool.args.safeParse(parsed.data.args);
      if (!args.success) return audit(fail("INVALID_ARGS"));
      // PR2 (M4 review) — เกต mutation ต้องมาก่อนการผูกตะกร้า: คำสั่งเขียนที่ถูกปฏิเสธ
      // ต้องไม่ทำให้ session ผูก cartId (binding เป็น side effect ของ session store)
      // PR3 — production ปลดได้เฉพาะเมื่อ store ที่ wire เป็น durable (durability != "memory")
      if (tool.risk !== "read" && options.environment === "production" && store.durability === "memory") return audit(fail("DURABLE_STORAGE_REQUIRED"));
      if (tool.risk !== "read") {
        let mutationsEnabled: boolean;
        try { mutationsEnabled = (typeof options.mutationsEnabled === "function" ? options.mutationsEnabled() : options.mutationsEnabled) === true; } catch { mutationsEnabled = false; }
        if (!mutationsEnabled) return audit(fail("MUTATIONS_DISABLED"));
      }
      // ── P1 ชั้นยืนยัน ───────────────────────────────────────────────────────
      // จังหวะที่ 1 (ไม่มี confirm): plan() แล้วคืนการ์ดให้ดู — ไม่แตะ idempotency/execute เลย
      // จังหวะที่ 2 (มี confirm): โหลด proposal, plan() ใหม่เทียบว่าโลกยังเหมือนเดิม,
      //                          เคลียร์ prerequisite ครบ, แล้วจึงใช้ args ที่เก็บไว้ไปทำจริง
      let executeArgs: unknown = args.data;
      let confirmedAnswers: PrerequisiteAnswers = {};
      if (needsConfirmation) {
        const proposals = options.proposals!;
        const confirm = parsed.data.confirm;
        if (!confirm) {
          let draft: ProposalDraft;
          try { draft = await tool.plan!(args.data, ctx, {}); } catch { return audit(fail("EXECUTION_FAILED")); }
          const id = (options.newProposalId ?? randomUUID)();
          const expiresAt = Math.min(Date.now() + PROPOSAL_TTL_MS, ctx.expiresAt);
          try {
            await proposals.save({
              id,
              organizationId: ctx.organizationId,
              storeId: ctx.storeId,
              userId: ctx.userId,
              sessionId: ctx.sessionId,
              tool: tool.name,
              args: args.data,
              draftFingerprint: fingerprintDraft(draft),
              expiresAt,
            });
          } catch { return audit(fail("PROPOSAL_UNAVAILABLE")); }
          return audit({ ok: true, kind: "proposal", proposal: { ...draft, id, tool: tool.name, expiresAt } });
        }

        const answers: PrerequisiteAnswers = confirm.answers ?? {};
        let record: Awaited<ReturnType<ProposalStore["load"]>>;
        try { record = await proposals.load(confirm.proposalId); } catch { return audit(fail("PROPOSAL_UNAVAILABLE")); }
        // หมดอายุ / ไม่ใช่ของ session นี้ / ยืนยันข้าม tool = ปฏิเสธด้วยรหัสเดียวกัน
        // ไม่บอกว่าแพ้ข้อไหน เพราะผู้เรียกทำอย่างเดียวกันหมด (เสนอใหม่) และไม่คายว่ามี id นี้อยู่จริง
        if (!record || record.tool !== tool.name || record.expiresAt <= Date.now()
          || !belongsToContext(record, ctx)) return audit(fail("PROPOSAL_NOT_FOUND"));

        let draft: ProposalDraft;
        try { draft = await tool.plan!(record.args, ctx, answers); } catch { return audit(fail("EXECUTION_FAILED")); }
        // โลกเปลี่ยนไประหว่างที่ผู้ใช้ดูการ์ดอยู่ — ห้ามเขียนทับเงียบ ๆ ให้เสนอใหม่
        if (fingerprintDraft(draft) !== record.draftFingerprint) return audit(fail("PROPOSAL_STALE"));
        // "ไม่มีให้เพิ่ม ไม่ใช่ข้าม": เหลือสิ่งที่ขาดแม้ข้อเดียวก็ commit ไม่ได้
        if (unresolvedPrerequisites(draft.prerequisites, answers).length > 0) {
          return audit(fail("PREREQUISITE_REQUIRED"));
        }
        // ใช้ครั้งเดียว — กดยืนยันรัวไม่ทำให้ทำงานสองรอบ (idempotency key ยังกันอีกชั้น)
        let consumed = false;
        try { consumed = await proposals.consume(record.id); } catch { consumed = false; }
        if (!consumed) return audit(fail("PROPOSAL_NOT_FOUND"));
        executeArgs = record.args;
        confirmedAnswers = answers;
      }
      // ───────────────────────────────────────────────────────────────────────

      // PR2 — tool ที่ต้องมี active cart: ไม่มี trusted resolver หรือตรวจไม่ผ่าน = ปฏิเสธก่อน execute เสมอ
      let cartBinding: CartBinding | null = null;
      if (tool.requiresActiveCart) {
        if (!options.resolveCartBinding) return audit(fail("CONTEXT_UNAVAILABLE"));
        try { cartBinding = await options.resolveCartBinding(ctx, executeArgs); } catch { cartBinding = null; }
        if (!cartBinding) return audit(fail("CONTEXT_UNAVAILABLE"));
      }
      let fingerprint: string;
      try { fingerprint = createHash("sha256").update(canonical({ tool: tool.name, args: executeArgs })).digest("hex"); } catch { return audit(fail("INVALID_ARGS")); }
      // tool อยู่ใน fingerprint เพื่อให้ reuse key ข้าม tool เป็น conflict; scope แยกโควตา/eviction ต่อ org|store|user|session
      const scope = JSON.stringify([ctx.organizationId, ctx.storeId, ctx.userId, ctx.sessionId]);
      const result = await store.claim(parsed.data.idempotencyKey, fingerprint, {
        scope,
        expiresAt: ctx.expiresAt,
        // PR3 — durable store ใช้บันทึกแถวและตัดสิน replay/conflict ว่าเป็นของ session เดิม
        tool: tool.name,
        identity: { organizationId: ctx.organizationId, storeId: ctx.storeId, userId: ctx.userId, sessionId: ctx.sessionId },
      }, async (): Promise<Result> => {
        try {
          const raw = await tool.execute(executeArgs, ctx, cartBinding, confirmedAnswers);
          const output = tool.result.safeParse(raw);
          return output.success ? { ok: true, data: structuredClone(output.data) } : fail("EXECUTION_FAILED");
        } catch { return fail("EXECUTION_FAILED"); }
      });
      return audit(result);
    } catch { return audit(fail("CONTEXT_UNAVAILABLE")); }
  };
}

export function registerDevelopmentEcho(registry: ToolRegistry): void {
  registry.register({ name: "system.echo", risk: "read", permissions: [], developmentOnly: true,
    args: z.object({ message: z.string().max(200) }).strict(), result: z.object({ message: z.string().max(200) }),
    execute: async args => args,
  });
}

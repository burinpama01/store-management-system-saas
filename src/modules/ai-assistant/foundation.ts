import { createHash } from "node:crypto";
import { z } from "zod";
import { canUseFeature, type BillingState } from "@/modules/billing/types";
import type { PermissionKey } from "@/modules/tenants/types";

export type Environment = "development" | "test" | "production";
export type Risk = "read" | "safe_write" | "sensitive" | "critical";
export type ErrorCode = "INVALID_REQUEST" | "UNKNOWN_TOOL" | "INVALID_ARGS" | "PERMISSION_DENIED" | "FEATURE_DISABLED" | "MUTATIONS_DISABLED" | "RISK_BLOCKED" | "CONTEXT_UNAVAILABLE" | "DURABLE_STORAGE_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "CAPACITY_EXCEEDED" | "EXECUTION_FAILED";
export type Result = { ok: true; data: unknown } | { ok: false; code: ErrorCode };
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
export interface ToolDefinition {
  name: string;
  risk: Risk;
  permissions: readonly PermissionKey[];
  args: z.ZodType;
  result: z.ZodType;
  developmentOnly?: boolean;
  requiresActiveCart?: boolean;
  execute: (args: unknown, context: TrustedContext) => Promise<unknown>;
}
const nameSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(80);
const envelope = z.object({ tool: nameSchema, args: z.unknown(), idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();

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
const fail = (code: ErrorCode): Result => ({ ok: false, code });

export interface IdempotencyStore {
  readonly durability: "memory";
  claim(key: string, fingerprint: string, execute: () => Promise<Result>): Promise<Result>;
}

/** ไม่มี eviction/retry อัตโนมัติ เพราะ handler ที่ throw อาจทำ side effect ไปแล้ว */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly durability = "memory" as const;
  private readonly ledger = new Map<string, { fingerprint: string; result: Promise<Result> }>();
  constructor(private readonly capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid capacity");
  }
  async claim(key: string, fingerprint: string, execute: () => Promise<Result>): Promise<Result> {
    const existing = this.ledger.get(key);
    if (existing) return existing.fingerprint === fingerprint ? structuredClone(await existing.result) : fail("IDEMPOTENCY_CONFLICT");
    if (this.ledger.size >= this.capacity) return fail("CAPACITY_EXCEEDED");
    // จองก่อน callback เริ่ม จึงไม่มีช่องว่างระหว่าง check กับ insert
    const result = Promise.resolve().then(execute).catch(() => fail("EXECUTION_FAILED"));
    this.ledger.set(key, { fingerprint, result });
    return structuredClone(await result);
  }
}

/** In-memory ledger ไม่มี eviction: เต็มแล้วปฏิเสธ แทนเสี่ยง execute write ซ้ำ */
export function createDispatcher(options: DispatcherOptions): (request: unknown) => Promise<Result> {
  // PR1 ไม่รับ durable:true หรือ external store เพื่อปลด production write
  const store: IdempotencyStore = new MemoryIdempotencyStore(options.capacity);
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
      if (tool.risk !== "read" && tool.risk !== "safe_write") return audit(fail("RISK_BLOCKED"));
      if (tool.requiresActiveCart) return audit(fail("CONTEXT_UNAVAILABLE"));
      if (tool.risk === "safe_write" && options.environment === "production") return audit(fail("DURABLE_STORAGE_REQUIRED"));
      if (tool.risk === "safe_write") {
        let mutationsEnabled: boolean;
        try { mutationsEnabled = (typeof options.mutationsEnabled === "function" ? options.mutationsEnabled() : options.mutationsEnabled) === true; } catch { mutationsEnabled = false; }
        if (!mutationsEnabled) return audit(fail("MUTATIONS_DISABLED"));
      }
      const args = tool.args.safeParse(parsed.data.args);
      if (!args.success) return audit(fail("INVALID_ARGS"));
      let fingerprint: string;
      try { fingerprint = createHash("sha256").update(canonical({ tool: tool.name, args: args.data })).digest("hex"); } catch { return audit(fail("INVALID_ARGS")); }
      // tool อยู่ใน fingerprint เพื่อให้ reuse key ข้าม tool เป็น conflict
      const key = JSON.stringify([ctx.organizationId, ctx.storeId, ctx.userId, ctx.sessionId, parsed.data.idempotencyKey]);
      const result = await store.claim(key, fingerprint, async (): Promise<Result> => {
        try {
          const raw = await tool.execute(args.data, ctx);
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

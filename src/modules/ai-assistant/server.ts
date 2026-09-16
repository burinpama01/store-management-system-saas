import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { logSystemEvent } from "@/modules/system/event-log";
import { readAssistantConfig } from "./config";
import { createDispatcher, type AuditMetadata, type CartBinding, type ToolRegistry, type TrustedContext } from "./foundation";

/** identity ที่ derive จาก server session เท่านั้น ห้ามรับจาก model หรือ caller */
export interface AssistantIdentity {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
}

/** session ฝั่ง server ที่ resolver เชื่อถือได้คืน ต้องเป็นของ identity เดียวกันเสมอ */
export interface AssistantServerSession extends AssistantIdentity {
  readonly id: string;
  readonly expiresAt: number;
  readonly allowedTools: readonly string[];
}

export interface ServerAssistantDispatcherOptions {
  registry: ToolRegistry;
  /** resolver ที่เชื่อถือได้ เช่น ตาราง assistant session ฝั่ง server — ห้ามสร้างจาก request */
  resolveSession: (identity: AssistantIdentity) => Promise<AssistantServerSession>;
  /**
   * PR2 — ตรวจ active cart binding ให้ tool ที่ requiresActiveCart ผ่าน session store ฝั่ง server
   * args ที่ได้รับคือ args ที่ผ่าน Zod แล้วเท่านั้น; คืน null/throw = ปฏิเสธ CONTEXT_UNAVAILABLE
   */
  resolveCartBinding?: (context: TrustedContext, args: unknown) => Promise<CartBinding | null>;
}

/** Audit เขียนผ่าน logSystemEvent เฉพาะ allowlist metadata ไม่มี args/result/error/raw text */
export async function writeAssistantAudit(metadata: AuditMetadata): Promise<void> {
  await logSystemEvent({
    level: metadata.outcome === "success" ? "info" : "warn",
    source: "ai.assistant",
    action: "toolDispatch",
    message: metadata.outcome === "success"
      ? `AI assistant เรียก tool ${metadata.tool} สำเร็จ`
      : `AI assistant เรียก tool ${metadata.tool} ถูกปฏิเสธ`,
    errorCode: metadata.outcome === "success" ? null : metadata.outcome,
    organizationId: metadata.organizationId,
    storeId: metadata.storeId,
    actorUserId: metadata.actorUserId,
    context: { tool: metadata.tool, risk: metadata.risk, outcome: metadata.outcome },
  });
}

async function resolveServerContext(options: ServerAssistantDispatcherOptions): Promise<TrustedContext> {
  // ปฏิเสธ browser runtime ก่อนแตะ auth เสมอ
  if (typeof window !== "undefined") throw new Error("Assistant requires a server runtime");
  const auth = await getResolvedCurrentPermissions();
  const { organizationId, storeId, can } = auth.resolved;
  const userId = auth.user.id;
  if (!organizationId || !storeId || !userId) throw new Error("Assistant identity incomplete");
  const identity: AssistantIdentity = { organizationId, storeId, userId };
  const session = await options.resolveSession(identity);
  // session ต้องเป็นของ identity เดียวกันเสมอ ป้องกัน cross-tenant session injection
  if (!session || session.organizationId !== identity.organizationId
    || session.storeId !== identity.storeId || session.userId !== identity.userId) throw new Error("Assistant session identity mismatch");
  const billing = await getOrganizationBillingState(identity.organizationId);
  if (!billing) throw new Error("Assistant billing unavailable");
  return {
    organizationId: session.organizationId,
    storeId: session.storeId,
    userId: session.userId,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    allowedTools: session.allowedTools,
    billing,
    can,
  };
}

/** dispatcher ที่ derive context จาก server session เท่านั้น และอ่าน kill switch ใหม่ทุกครั้ง */
export function createServerAssistantDispatcher(options: ServerAssistantDispatcherOptions) {
  return createDispatcher({
    registry: options.registry,
    // re-read env ทุก dispatch เพื่อให้ kill switch มีผลทันทีแม้ยัง replay อยู่
    enabled: () => readAssistantConfig(process.env).enabled,
    environment: readAssistantConfig(process.env).environment,
    // PR1 config ล็อก false ไว้ แต่ต้อง wire ผ่าน config เดียวกันเสมอ กัน config drift ตอน PR2+
    mutationsEnabled: () => readAssistantConfig(process.env).mutationsEnabled,
    resolveContext: () => resolveServerContext(options),
    resolveCartBinding: options.resolveCartBinding,
    audit: writeAssistantAudit,
  });
}

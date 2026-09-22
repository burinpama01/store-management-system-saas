import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { logSystemEvent } from "@/modules/system/event-log";
import { readAssistantConfig } from "./config";
import { createDispatcher, type AuditMetadata, type CartBinding, type IdempotencyStore, type ToolRegistry, type TrustedContext } from "./foundation";
import type { ProposalStore } from "./proposal";

/** identity ที่ derive จาก server session เท่านั้น ห้ามรับจาก model หรือ caller */
export interface AssistantIdentity {
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  /**
   * เครื่อง/แท็บที่ยิงคำสั่งมา (opaque id ที่ client สร้างและเก็บไว้เอง)
   *
   * มีเพื่อให้ session store แยก session ต่อเครื่องได้ — คนเดียวเปิดสองแท็บต้องผูก
   * ตะกร้าคนละใบได้ ไม่ใช่แท็บที่สองโดนปฏิเสธ ไม่ส่งมา = ถือเป็นเครื่องเดียวต่อผู้ใช้
   * (พฤติกรรมเดิมก่อนมี registry)
   */
  readonly deviceId?: string;
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
  /**
   * PR3 — store idempotency แบบ durable (DurableIdempotencyStore) สำหรับปลด safe_write ใน production;
   * ไม่ให้ = memory store เดิม และ production safe_write ยังโดน DURABLE_STORAGE_REQUIRED ตามเกตเดิม
   */
  idempotencyStore?: IdempotencyStore;
  /** P1 — ที่เก็บข้อเสนอรอยืนยัน; ไม่ให้ = tool ที่มี plan() ถูกปฏิเสธ (ไม่ใช่ข้ามการยืนยัน) */
  proposals?: ProposalStore;
}

/** Audit เขียนผ่าน logSystemEvent เฉพาะ allowlist metadata ไม่มี args/result/error/raw text */
const AUDIT_MESSAGES: Record<string, string> = {
  success: "เรียกใช้สำเร็จ",
  proposed: "เสนอรายการรอยืนยัน (ยังไม่เขียนข้อมูล)",
  refined: "เสนอรายการใหม่หลังผู้ใช้เลือกข้อมูลที่ขาด (ยังไม่เขียนข้อมูล)",
};

/**
 * บันทึกทุกเส้นทางที่ออกจาก dispatcher รวมเส้นทางที่สำเร็จแบบเงียบ ๆ
 *
 * แยกระดับ log ตามว่า "ข้อมูลของร้านถูกแก้จริงหรือยัง" ไม่ใช่ตามว่า request สำเร็จไหม —
 * การ์ดที่เสนอไปแล้วไม่มีใครกดยืนยันเป็นเรื่องปกติ ไม่ใช่ปัญหา จึงเป็น info เหมือนกัน
 * แต่ต้องแยกออกจากการเขียนจริงให้ได้ ไม่งั้นตอบคำถาม "AI ไปแก้อะไรของร้านบ้างเมื่อวาน"
 * ไม่ได้เลย
 *
 * context เก็บเฉพาะ allowlist — ไม่มี args/ผลลัพธ์/ข้อความดิบของผู้ใช้
 */
export async function writeAssistantAudit(metadata: AuditMetadata): Promise<void> {
  const informational = metadata.outcome === "success" || metadata.outcome === "proposed" || metadata.outcome === "refined";
  const wrote = metadata.outcome === "success";
  await logSystemEvent({
    level: informational ? "info" : "warn",
    source: "ai.assistant",
    action: wrote && metadata.confirmed ? "toolCommitted" : wrote ? "toolDispatch" : informational ? "toolProposed" : "toolRejected",
    message: `AI assistant · ${metadata.tool} · ${AUDIT_MESSAGES[metadata.outcome] ?? "ถูกปฏิเสธ"}`,
    errorCode: informational ? null : metadata.outcome,
    organizationId: metadata.organizationId,
    storeId: metadata.storeId,
    actorUserId: metadata.actorUserId,
    context: {
      tool: metadata.tool,
      risk: metadata.risk,
      outcome: metadata.outcome,
      /** ตอบได้ทันทีว่าแถวนี้ทำให้ข้อมูลของร้านเปลี่ยนไปหรือไม่ */
      dataChanged: wrote,
      ...(metadata.confirmed ? { confirmed: true } : {}),
      ...(metadata.proposalId ? { proposalId: metadata.proposalId } : {}),
    },
  });
}

/** header ที่ client ใส่ id ของเครื่อง/แท็บมา — ชื่อเดียวกับที่ฝั่ง UI ส่ง */
export const ASSISTANT_DEVICE_HEADER = "x-storeos-assistant-device";

/**
 * อ่าน device id จาก header — อ่านไม่ได้ (นอก request scope / ไม่ได้ส่งมา) = undefined
 *
 * ค่าที่อ่านมาไม่ได้รับความเชื่อถือในเชิงสิทธิ์เลย มันเป็นแค่ตัวแบ่ง session ภายใน
 * identity เดิมที่ auth เป็นคนกำหนด — ปลอมค่าได้อย่างมากก็ไปใช้ session ของเครื่องอื่น
 * ของตัวเอง ซึ่งไม่ข้ามเขตไปหาใคร
 */
async function readDeviceId(): Promise<string | undefined> {
  try {
    return (await headers()).get(ASSISTANT_DEVICE_HEADER) ?? undefined;
  } catch {
    return undefined;
  }
}

async function resolveServerContext(options: ServerAssistantDispatcherOptions): Promise<TrustedContext> {
  // ปฏิเสธ browser runtime ก่อนแตะ auth เสมอ
  if (typeof window !== "undefined") throw new Error("Assistant requires a server runtime");
  const auth = await getResolvedCurrentPermissions();
  const { organizationId, storeId, can } = auth.resolved;
  const role = auth.ctx.role;
  const userId = auth.user.id;
  if (!organizationId || !storeId || !userId) throw new Error("Assistant identity incomplete");
  // device id มาจาก header ของ request (ไม่ใช่ body) — เป็นข้อมูลของ "เครื่อง" ไม่ใช่ของคำสั่ง
  // และอ่านที่นี่ทำให้ dispatcher ซึ่งเป็น singleton ต่อ process ไม่ต้องรับค่าต่อ request
  const identity: AssistantIdentity = {
    organizationId,
    storeId,
    userId,
    deviceId: await readDeviceId(),
  };
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
    role,
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
    idempotencyStore: options.idempotencyStore,
    proposals: options.proposals,
    audit: writeAssistantAudit,
  });
}

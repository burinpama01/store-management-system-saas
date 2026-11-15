import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import {
  MEMBER_REDEEM_CODE_TTL_SECONDS,
  MEMBER_VERIFICATION_TTL_SECONDS,
  generateMemberRedeemCode,
  hashMemberRedeemCode,
  issueStatusMessage,
  verifyStatusMessage,
  type IssueRedeemCodeStatus,
  type VerifyRedeemCodeStatus,
} from "./redeem-code";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ operations/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

const MAX_COLLISION_RETRIES = 4;

export interface IssuedRedeemCode {
  code: string;
  expiresAt: string;
}

export interface MemberVerification {
  verificationId: string;
  customerId: string;
  memberIdentityId: string;
  /** สาขาที่ลูกค้าเปิดรหัส — ต่างจากสาขาที่ยืนยัน = ใช้ข้ามสาขา */
  issuedStoreId: string;
  expiresAt: string;
}

export async function isMemberCodeEnabled(storeId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("stores").select("member_code_enabled").eq("id", storeId).maybeSingle();
  if (error || !data) return false;
  return data.member_code_enabled === true;
}

/** เปลี่ยนสวิตช์ด้วยสิทธิ์ของผู้ใช้เอง (RLS ตรวจ) — 0 แถว = ไม่มีสิทธิ์ */
export async function setMemberCodeEnabled(storeId: string, enabled: boolean): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("stores")
    .update({ member_code_enabled: enabled })
    .eq("id", storeId)
    .select("id");
  if (error) return { data: null, error: error.message };
  if (!data || data.length === 0) return { data: null, error: "ไม่มีสิทธิ์เปลี่ยนการตั้งค่าร้าน" };
  return { data: true, error: null };
}

/**
 * ออกรหัส 6 หลักให้ลูกค้าที่ล็อกอินหน้าสมาชิกแล้ว — ผู้เรียกต้องยืนยันเซสชันลูกค้ามาก่อน
 * รหัสชนกับรหัสอื่นที่ยังใช้ได้ในองค์กร → สุ่มใหม่ (โอกาสต่ำมาก)
 */
export async function issueMemberRedeemCode(input: {
  organizationId: string;
  storeId: string;
  customerId: string;
}): Promise<Result<IssuedRedeemCode> & { status?: IssueRedeemCodeStatus }> {
  const db: LooseClient = await createSupabaseServiceClient();
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
    const code = generateMemberRedeemCode();
    const { data, error } = await db.rpc("issue_member_redeem_code", {
      p_store_id: input.storeId,
      p_customer_id: input.customerId,
      p_code_hash: hashMemberRedeemCode(input.organizationId, code),
      p_ttl_seconds: MEMBER_REDEEM_CODE_TTL_SECONDS,
    });
    if (error) return { data: null, error: error.message };
    const status = (data?.status ?? "collision") as IssueRedeemCodeStatus;
    if (status === "ok") {
      return { data: { code, expiresAt: String(data.expires_at) }, error: null, status };
    }
    if (status !== "collision") {
      return { data: null, error: issueStatusMessage(status), status };
    }
  }
  return { data: null, error: issueStatusMessage("collision"), status: "collision" };
}

/** ยืนยันรหัสที่ POS — ผู้เรียกต้องตรวจสิทธิ์ pos.use และแพ็กเกจมาก่อน */
export async function verifyMemberRedeemCode(input: {
  organizationId: string;
  storeId: string;
  userId: string;
  code: string;
}): Promise<Result<MemberVerification> & { status?: VerifyRedeemCodeStatus }> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.rpc("verify_member_redeem_code", {
    p_store_id: input.storeId,
    p_user_id: input.userId,
    p_code_hash: hashMemberRedeemCode(input.organizationId, input.code),
    p_verification_ttl_seconds: MEMBER_VERIFICATION_TTL_SECONDS,
  });
  if (error) return { data: null, error: error.message };
  const status = (data?.status ?? "invalid") as VerifyRedeemCodeStatus;
  if (status !== "ok") {
    const attemptsLeft = typeof data?.attempts_left === "number" ? data.attempts_left : null;
    return { data: null, error: verifyStatusMessage(status, attemptsLeft), status };
  }
  return {
    data: {
      verificationId: String(data.verification_id),
      customerId: String(data.customer_id),
      memberIdentityId: String(data.member_identity_id),
      issuedStoreId: String(data.issued_store_id),
      expiresAt: String(data.expires_at),
    },
    error: null,
    status,
  };
}

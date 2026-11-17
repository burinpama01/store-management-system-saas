import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { missionPayload, type EnrollmentStatus, type Mission, type MissionInput, type MissionStats } from "./rules";

type Result<T> = { data: T; error: null } | { data: null; error: string };

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ member-tiers/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

function rpcMessage(error: { message?: string } | null | undefined, fallback: string): string {
  const message = error?.message?.trim();
  return message ? message : fallback;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapMission(row: any): Mission {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    description: row.description ?? "",
    scope: row.scope,
    categoryIds: row.category_ids ?? [],
    productIds: row.product_ids ?? [],
    targetCount: Number(row.target_count),
    maxPerOrder: row.max_per_order === null ? null : Number(row.max_per_order),
    durationDays: row.duration_days === null ? null : Number(row.duration_days),
    joinStartsAt: row.join_starts_at,
    joinEndsAt: row.join_ends_at,
    repeatable: row.repeatable === true,
    maxParticipants: row.max_participants === null ? null : Number(row.max_participants),
    rewardType: row.reward_type,
    rewardProductId: row.reward_product_id,
    rewardDiscountKind: row.reward_discount_kind,
    rewardDiscountValue: row.reward_discount_value === null ? null : Number(row.reward_discount_value),
    rewardMinSubtotal: Number(row.reward_min_subtotal ?? 0),
    rewardValidDays: Number(row.reward_valid_days),
    status: row.status,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// สวิตช์สาขา
// ---------------------------------------------------------------------------
export async function isMissionsEnabled(storeId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("stores").select("missions_enabled").eq("id", storeId).maybeSingle();
  if (error || !data) return false;
  return data.missions_enabled === true;
}

/** เปลี่ยนด้วยสิทธิ์ของผู้ใช้เอง (RLS stores ตรวจ) — 0 แถว = ไม่มีสิทธิ์ */
export async function setMissionsEnabled(storeId: string, enabled: boolean): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.from("stores").update({ missions_enabled: enabled }).eq("id", storeId).select("id");
  if (error) return { data: null, error: error.message };
  if (!data || data.length === 0) return { data: null, error: "ไม่มีสิทธิ์เปลี่ยนการตั้งค่าร้าน" };
  return { data: true, error: null };
}

// ---------------------------------------------------------------------------
// หลังร้าน
// ---------------------------------------------------------------------------
export async function listStoreMissions(storeId: string): Promise<Result<{ mission: Mission; stats: MissionStats }[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data: missions, error } = await db
    .from("store_missions")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { data: null, error: error.message };
  const rows = (missions ?? []) as any[];
  if (rows.length === 0) return { data: [], error: null };

  const { data: enrollments, error: enrollErr } = await db
    .from("store_mission_enrollments")
    .select("id, mission_id, member_identity_id, status")
    .eq("store_id", storeId)
    .in("mission_id", rows.map((row) => row.id))
    .limit(20000);
  if (enrollErr) return { data: null, error: enrollErr.message };

  const service: LooseClient = await createSupabaseServiceClient();
  const { data: used, error: usedErr } = await service
    .from("loyalty_reward_redemptions")
    .select("mission_enrollment_id")
    .eq("store_id", storeId)
    .not("mission_enrollment_id", "is", null)
    .not("used_at", "is", null)
    .limit(20000);
  if (usedErr) return { data: null, error: usedErr.message };

  const missionOfEnrollment = new Map<string, string>();
  const stats = new Map<string, MissionStats & { members: Set<string> }>();
  for (const row of rows) stats.set(row.id, { joined: 0, active: 0, completed: 0, rewardsUsed: 0, members: new Set() });
  for (const e of (enrollments ?? []) as any[]) {
    missionOfEnrollment.set(e.id, e.mission_id);
    const s = stats.get(e.mission_id);
    if (!s) continue;
    s.members.add(e.member_identity_id);
    if (e.status === "active") s.active += 1;
    if (e.status === "completed") s.completed += 1;
  }
  for (const r of (used ?? []) as any[]) {
    const missionId = missionOfEnrollment.get(r.mission_enrollment_id);
    const s = missionId ? stats.get(missionId) : undefined;
    if (s) s.rewardsUsed += 1;
  }

  return {
    data: rows.map((row) => {
      const s = stats.get(row.id)!;
      return { mission: mapMission(row), stats: { joined: s.members.size, active: s.active, completed: s.completed, rewardsUsed: s.rewardsUsed } };
    }),
    error: null,
  };
}

export async function saveStoreMission(storeId: string, id: string | null, input: MissionInput): Promise<Result<string>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("save_store_mission", { p_store_id: storeId, p_payload: missionPayload(id, input) });
  if (error) return { data: null, error: rpcMessage(error, "บันทึกภารกิจไม่สำเร็จ") };
  return { data: String(data), error: null };
}

// ---------------------------------------------------------------------------
// หน้าสมาชิก (service role — ผู้เรียกต้องตรวจเซสชันลูกค้ามาก่อน)
// ---------------------------------------------------------------------------
export interface MemberMissionCard {
  missionId: string;
  name: string;
  description: string;
  targetCount: number;
  maxPerOrder: number | null;
  rewardText: string;
  repeatable: boolean;
  joinEndsAt: string | null;
  durationDays: number | null;
  scopeText: string;
  /** รอบล่าสุดของลูกค้า (ถ้าเคยรับ) */
  enrollment: {
    id: string;
    round: number;
    progress: number;
    targetCount: number;
    status: EnrollmentStatus;
    joinedAt: string;
    expiresAt: string | null;
    completedAt: string | null;
  } | null;
  /** กดรับ/รับรอบใหม่ได้ตอนนี้ */
  canJoin: boolean;
}

export interface MemberMissionsView {
  enabled: boolean;
  missions: MemberMissionCard[];
  /** ลูกค้ายกเลิกรับ SMS ภารกิจของสาขานี้แล้ว */
  smsOptOut: boolean;
}

function scopeText(row: any, categoryNames: Map<string, string>, productNames: Map<string, string>): string {
  if (row.scope === "categories") {
    const names = (row.category_ids ?? []).map((id: string) => categoryNames.get(id)).filter(Boolean);
    return names.length > 0 ? `หมวด ${names.join(", ")}` : "บางหมวด";
  }
  if (row.scope === "products") {
    const names = (row.product_ids ?? []).map((id: string) => productNames.get(id)).filter(Boolean);
    return names.length > 0 ? names.slice(0, 4).join(", ") + (names.length > 4 ? ` และอีก ${names.length - 4} เมนู` : "") : "บางเมนู";
  }
  return "ทุกเมนู";
}

function rewardTextFromRow(row: any, productNames: Map<string, string>): string {
  if (row.reward_type === "product") return `${productNames.get(row.reward_product_id) ?? "เมนู"} ฟรี 1 ชิ้น`;
  const value = Number(row.reward_discount_value ?? 0);
  const base = row.reward_discount_kind === "percentage" ? `ลด ${value}%` : `ลด ฿${value.toLocaleString("th-TH")}`;
  const min = Number(row.reward_min_subtotal ?? 0);
  return min > 0 ? `${base} เมื่อซื้อครบ ฿${min.toLocaleString("th-TH")}` : base;
}

export async function getMemberMissionsView(storeId: string, customerId: string): Promise<MemberMissionsView> {
  const db: LooseClient = await createSupabaseServiceClient();
  const enabled = await isMissionsEnabled(storeId);
  if (!enabled) return { enabled: false, missions: [], smsOptOut: false };

  const { data: customer } = await db
    .from("customers")
    .select("member_identity_id, mission_sms_opt_out")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .maybeSingle();
  const identity: string | null = customer?.member_identity_id ?? null;
  const smsOptOut = customer?.mission_sms_opt_out === true;

  const nowIso = new Date().toISOString();
  const [missionsRes, enrollRes] = await Promise.all([
    db.from("store_missions").select("*").eq("store_id", storeId).order("created_at", { ascending: false }).limit(50),
    identity
      ? db
          .from("store_mission_enrollments")
          .select("*")
          .eq("store_id", storeId)
          .eq("member_identity_id", identity)
          .order("round", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (missionsRes.error || enrollRes.error) return { enabled: true, missions: [], smsOptOut };

  const latest = new Map<string, any>();
  for (const e of (enrollRes.data ?? []) as any[]) if (!latest.has(e.mission_id)) latest.set(e.mission_id, e);

  const rows = ((missionsRes.data ?? []) as any[]).filter((row) => {
    const mine = latest.get(row.id);
    const open = row.status === "active" && row.join_starts_at <= nowIso && (!row.join_ends_at || row.join_ends_at > nowIso);
    // ภารกิจที่ปิดแล้ว ยังแสดงถ้าลูกค้ามีรอบที่ครบแล้ว/กำลังทำ (ดูประวัติได้)
    return open || (mine && (mine.status === "active" || mine.status === "completed"));
  });

  const categoryIds = [...new Set(rows.flatMap((row) => row.category_ids ?? []))];
  const productIds = [...new Set(rows.flatMap((row) => [...(row.product_ids ?? []), row.reward_product_id].filter(Boolean)))];
  const [catRes, prodRes] = await Promise.all([
    categoryIds.length ? db.from("categories").select("id, name").in("id", categoryIds) : Promise.resolve({ data: [] }),
    productIds.length ? db.from("products").select("id, name").in("id", productIds) : Promise.resolve({ data: [] }),
  ]);
  const categoryNames = new Map<string, string>(((catRes.data ?? []) as any[]).map((r) => [r.id, r.name]));
  const productNames = new Map<string, string>(((prodRes.data ?? []) as any[]).map((r) => [r.id, r.name]));

  const missions: MemberMissionCard[] = rows.map((row) => {
    const mine = latest.get(row.id);
    const open = row.status === "active" && row.join_starts_at <= nowIso && (!row.join_ends_at || row.join_ends_at > nowIso);
    const activeExpired = mine?.status === "active" && mine.expires_at && mine.expires_at <= nowIso;
    const status: EnrollmentStatus | null = mine ? (activeExpired ? "expired" : mine.status) : null;
    const canJoin = Boolean(identity) && open && (!mine || ((status !== "active") && row.repeatable));
    return {
      missionId: row.id,
      name: row.name,
      description: row.description ?? "",
      targetCount: Number(row.target_count),
      maxPerOrder: row.max_per_order === null ? null : Number(row.max_per_order),
      rewardText: rewardTextFromRow(row, productNames),
      repeatable: row.repeatable === true,
      joinEndsAt: row.join_ends_at,
      durationDays: row.duration_days === null ? null : Number(row.duration_days),
      scopeText: scopeText(row, categoryNames, productNames),
      enrollment: mine
        ? {
            id: mine.id,
            round: Number(mine.round),
            progress: Number(mine.progress),
            targetCount: Number(mine.target_count),
            status: status as EnrollmentStatus,
            joinedAt: mine.joined_at,
            expiresAt: mine.expires_at,
            completedAt: mine.completed_at,
          }
        : null,
      canJoin,
    };
  });
  return { enabled: true, missions, smsOptOut };
}

export async function joinStoreMission(
  customerId: string,
  missionId: string,
  smsOptIn = true,
): Promise<Result<{ enrollmentId: string; round: number; already: boolean }>> {
  const db: LooseClient = await createSupabaseServiceClient();
  // ความยินยอมรับ SMS บันทึกพร้อมการกดรับใน transaction เดียว (PDPA — ไม่มีจังหวะที่ค้างเป็น "ยินยอม")
  const { data, error } = await db.rpc("join_store_mission", {
    p_customer_id: customerId,
    p_mission_id: missionId,
    p_sms_opt_in: smsOptIn,
  });
  if (error) return { data: null, error: rpcMessage(error, "รับภารกิจไม่สำเร็จ") };
  return { data: { enrollmentId: data.enrollment_id, round: Number(data.round), already: data.already === true }, error: null };
}

/** ลูกค้าเปิด/ปิดรับ SMS ภารกิจของสาขานี้ (ผู้เรียกตรวจเซสชันแล้ว) */
export async function setMissionSmsOptOut(storeId: string, customerId: string, optOut: boolean): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("customers")
    .update({ mission_sms_opt_out: optOut })
    .eq("id", customerId)
    .eq("store_id", storeId)
    .select("id");
  if (error) return { data: null, error: error.message };
  if (!data || data.length === 0) return { data: null, error: "ไม่พบสมาชิก" };
  return { data: true, error: null };
}

// ---------------------------------------------------------------------------
// POS — ภารกิจที่ลูกค้าในบิลกำลังทำ
// ---------------------------------------------------------------------------
export interface PosMissionProgress {
  enrollmentId: string;
  name: string;
  progress: number;
  targetCount: number;
  scope: "all" | "categories" | "products";
  categoryIds: string[];
  productIds: string[];
  maxPerOrder: number | null;
  expiresAt: string | null;
}

export async function listPosMissionProgress(storeId: string, customerId: string): Promise<Result<PosMissionProgress[]>> {
  const db: LooseClient = await createSupabaseServiceClient();
  if (!(await isMissionsEnabled(storeId))) return { data: [], error: null };
  const { data: customer, error: custErr } = await db
    .from("customers")
    .select("member_identity_id")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (custErr) return { data: null, error: custErr.message };
  if (!customer?.member_identity_id) return { data: [], error: null };
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("store_mission_enrollments")
    .select("id, progress, target_count, max_per_order, expires_at, store_missions!inner(name, scope, category_ids, product_ids, status)")
    .eq("store_id", storeId)
    .eq("member_identity_id", customer.member_identity_id)
    .eq("status", "active")
    .eq("store_missions.status", "active")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .limit(10);
  if (error) return { data: null, error: error.message };
  return {
    data: ((data ?? []) as any[]).map((row) => ({
      enrollmentId: row.id,
      name: row.store_missions.name,
      progress: Number(row.progress),
      targetCount: Number(row.target_count),
      scope: row.store_missions.scope,
      categoryIds: row.store_missions.category_ids ?? [],
      productIds: row.store_missions.product_ids ?? [],
      maxPerOrder: row.max_per_order === null ? null : Number(row.max_per_order),
      expiresAt: row.expires_at,
    })),
    error: null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** SMS ภารกิจเดือนนี้ของสาขา (ส่งแล้ว/โควตา) — แพลตฟอร์มออกค่า SMS ช่วงทดลอง */
export async function getMissionSmsUsage(storeId: string): Promise<{ sent: number; limit: number; skippedQuota: number }> {
  const db: LooseClient = await createSupabaseServiceClient();
  const now = new Date();
  const bangkok = new Date(now.getTime() + 7 * 3_600_000);
  const monthStart = new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), 1) - 7 * 3_600_000).toISOString();
  const [storeRes, sentRes, skippedRes] = await Promise.all([
    db.from("stores").select("mission_sms_monthly_limit").eq("id", storeId).maybeSingle(),
    // นับเหมือนเพดานใน claim_store_mission_sms: ส่งแล้ว + กำลังส่ง
    db
      .from("store_mission_sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .in("status", ["sent", "sending"])
      .or(`sent_at.gte.${monthStart},claimed_at.gte.${monthStart}`),
    db
      .from("store_mission_sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("status", "skipped")
      .eq("skip_reason", "เกินโควตา SMS ของร้านเดือนนี้")
      .gte("created_at", monthStart),
  ]);
  return {
    sent: sentRes.count ?? 0,
    limit: Number(storeRes.data?.mission_sms_monthly_limit ?? 200),
    skippedQuota: skippedRes.count ?? 0,
  };
}

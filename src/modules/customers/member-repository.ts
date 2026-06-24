import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { getStoreBySlug } from "@/modules/stores/public-repository";
import type { Store } from "@/modules/stores/types";
import type { LoyaltyReward } from "@/modules/loyalty/repository";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { mapError } from "@/shared/utils/error";

type PortalLinkRow = Database["public"]["Tables"]["customer_member_portal_links"]["Row"];
type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];
type LoyaltyAccountRow = Database["public"]["Tables"]["loyalty_accounts"]["Row"];
type LoyaltyRewardRow = Database["public"]["Tables"]["loyalty_rewards"]["Row"];
type RewardRedemptionRow = Database["public"]["Tables"]["loyalty_reward_redemptions"]["Row"];
type MemberOtpRow = Database["public"]["Tables"]["customer_member_otps"]["Row"];

export type OtpSender = (phone: string, code: string) => Promise<unknown>;

const ENTERPRISE_MEMBER_PORTAL_LOCK_MESSAGE =
  "ระบบสมัครสมาชิก สะสมแต้ม และคูปองอยู่ในแพ็กเกจ Enterprise เท่านั้น";

export interface CustomerMemberProfile {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  pointsBalance: number;
}

export interface CustomerRewardRedemption {
  id: string;
  rewardId: string;
  rewardName: string;
  pointsSpent: number;
  status: "pending" | "fulfilled" | "cancelled";
  createdAt: string;
}

export interface CustomerPortalData {
  store: Store | null;
  portalCode: string;
  portalValid: boolean;
  customer: CustomerMemberProfile | null;
  rewards: LoyaltyReward[];
  redemptions: CustomerRewardRedemption[];
  error: string | null;
}

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function getMemberSessionCookieName(storeId: string) {
  return `storeos_member_session_${storeId}`;
}

function normalizeEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? "";
  return email && email.includes("@") ? email : "";
}

function normalizePhone(value: string | null | undefined) {
  return (value ?? "").trim().replace(/[\s()-]/g, "");
}

function normalizeIdentifier(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed.includes("@") ? normalizeEmail(trimmed) : normalizePhone(trimmed);
}

function maskPhone(phone: string) {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

function mapReward(row: LoyaltyRewardRow): LoyaltyReward {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    name: row.name,
    description: row.description ?? undefined,
    pointsCost: row.points_cost,
    stockQuantity: row.stock_quantity,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCustomer(customer: CustomerRow, account?: LoyaltyAccountRow | null): CustomerMemberProfile {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone ?? undefined,
    email: customer.email ?? undefined,
    pointsBalance: account?.points_balance ?? 0,
  };
}

async function resolvePortalLink(storeSlug: string, portalCode: string) {
  const cleanCode = portalCode.trim();
  if (!cleanCode) return { store: null, link: null, error: "ต้องเปิดจาก QR ของร้าน" };

  const storeRes = await getStoreBySlug(storeSlug, { requireQrOrdering: false });
  if (storeRes.error || !storeRes.data || !storeRes.data.isActive) {
    return { store: null, link: null, error: "ไม่พบร้านนี้" };
  }

  const billingState =
    (await getOrganizationBillingState(storeRes.data.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "loyaltyPoints")) {
    return {
      store: storeRes.data,
      link: null,
      error: ENTERPRISE_MEMBER_PORTAL_LOCK_MESSAGE,
    };
  }

  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("customer_member_portal_links")
    .select("*")
    .eq("store_id", storeRes.data.id)
    .eq("token", cleanCode)
    .eq("is_active", true)
    .maybeSingle();

  if (error) return { store: storeRes.data, link: null, error: mapError(error).userMessage };
  if (!data) return { store: storeRes.data, link: null, error: "ต้องเปิดจาก QR ของร้าน" };
  return { store: storeRes.data, link: data, error: null };
}

async function listActiveRewards(storeId: string) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("loyalty_rewards")
    .select("*")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .order("points_cost", { ascending: true });

  if (error) return { data: [] as LoyaltyReward[], error: mapError(error).userMessage };
  return { data: (data ?? []).map(mapReward), error: null };
}

async function getActiveSessionCustomer(store: Store) {
  const cookieStore = await cookies();
  const token = cookieStore.get(getMemberSessionCookieName(store.id))?.value;
  if (!token) return { customer: null, error: null };

  const supabase = await createSupabaseServiceClient();
  const { data: session, error: sessionError } = await supabase
    .from("customer_member_sessions")
    .select("*")
    .eq("store_id", store.id)
    .eq("session_token_hash", hashValue(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (sessionError) return { customer: null, error: mapError(sessionError).userMessage };
  if (!session) return { customer: null, error: null };

  const [customerRes, accountRes] = await Promise.all([
    supabase
      .from("customers")
      .select("*")
      .eq("store_id", store.id)
      .eq("id", session.customer_id)
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("loyalty_accounts")
      .select("*")
      .eq("store_id", store.id)
      .eq("customer_id", session.customer_id)
      .maybeSingle(),
    supabase
      .from("customer_member_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", session.id),
  ]);

  if (customerRes.error) return { customer: null, error: mapError(customerRes.error).userMessage };
  if (accountRes.error) return { customer: null, error: mapError(accountRes.error).userMessage };
  if (!customerRes.data) return { customer: null, error: null };
  return { customer: mapCustomer(customerRes.data, accountRes.data), error: null };
}

async function listRewardRedemptions(storeId: string, customerId: string) {
  const supabase = await createSupabaseServiceClient();
  const { data: redemptions, error } = await supabase
    .from("loyalty_reward_redemptions")
    .select("*")
    .eq("store_id", storeId)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return { data: [] as CustomerRewardRedemption[], error: mapError(error).userMessage };
  const rows = redemptions ?? [];
  if (rows.length === 0) return { data: [] as CustomerRewardRedemption[], error: null };

  const rewardIds = [...new Set(rows.map((row) => row.reward_id))];
  const rewardsRes = await supabase.from("loyalty_rewards").select("id, name").in("id", rewardIds);
  if (rewardsRes.error) return { data: [] as CustomerRewardRedemption[], error: mapError(rewardsRes.error).userMessage };

  const rewardsById = new Map((rewardsRes.data ?? []).map((reward) => [reward.id, reward.name]));
  return {
    data: rows.map((row: RewardRedemptionRow) => ({
      id: row.id,
      rewardId: row.reward_id,
      rewardName: rewardsById.get(row.reward_id) ?? "ของรางวัล",
      pointsSpent: row.points_spent,
      status: row.status,
      createdAt: row.created_at,
    })),
    error: null,
  };
}

export async function getCustomerPortalData(storeSlug: string, portalCode: string): Promise<CustomerPortalData> {
  const portal = await resolvePortalLink(storeSlug, portalCode);
  if (!portal.store || !portal.link) {
    return {
      store: portal.store,
      portalCode,
      portalValid: false,
      customer: null,
      rewards: [],
      redemptions: [],
      error: portal.error,
    };
  }

  const [sessionRes, rewardsRes] = await Promise.all([
    getActiveSessionCustomer(portal.store),
    listActiveRewards(portal.store.id),
  ]);
  const redemptionsRes = sessionRes.customer
    ? await listRewardRedemptions(portal.store.id, sessionRes.customer.id)
    : { data: [] as CustomerRewardRedemption[], error: null };

  return {
    store: portal.store,
    portalCode,
    portalValid: true,
    customer: sessionRes.customer,
    rewards: rewardsRes.data,
    redemptions: redemptionsRes.data,
    error: sessionRes.error ?? rewardsRes.error ?? redemptionsRes.error,
  };
}

async function findCustomerByIdentifier(storeId: string, identifier: string) {
  const supabase = await createSupabaseServiceClient();
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) return { data: null, error: null };

  const query = supabase.from("customers").select("*").eq("store_id", storeId).eq("is_active", true);
  const result = normalized.includes("@")
    ? await query.ilike("email", normalized).maybeSingle()
    : await query.eq("phone", normalized).maybeSingle();

  if (result.error) return { data: null, error: mapError(result.error).userMessage };
  return { data: result.data, error: null };
}

async function findCustomerByEmail(storeId: string, email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { data: null, error: null };

  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("store_id", storeId)
    .ilike("email", normalized)
    .eq("is_active", true)
    .maybeSingle();

  if (error) return { data: null, error: mapError(error).userMessage };
  return { data, error: null };
}

export async function createOrFindMemberCustomer(input: {
  organizationId: string;
  storeId: string;
  name: string;
  phone: string;
  email?: string | null;
}) {
  const supabase = await createSupabaseServiceClient();
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);

  const existingByPhone = phone
    ? await supabase
        .from("customers")
        .select("*")
        .eq("store_id", input.storeId)
        .eq("phone", phone)
        .eq("is_active", true)
        .maybeSingle()
    : { data: null, error: null };
  if (existingByPhone.error) return { data: null, error: mapError(existingByPhone.error).userMessage };
  if (existingByPhone.data) return { data: existingByPhone.data.id, error: null };

  const created = await supabase
    .from("customers")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      name: input.name.trim(),
      phone,
      email: email || null,
      is_active: true,
    })
    .select("id")
    .single();

  if (created.error) return { data: null, error: mapError(created.error).userMessage };

  await supabase.from("loyalty_accounts").upsert(
    {
      organization_id: input.organizationId,
      store_id: input.storeId,
      customer_id: created.data.id,
    },
    { onConflict: "store_id,customer_id" },
  );
  return { data: created.data.id, error: null };
}

export async function requestMemberOtp(
  input: {
    storeSlug: string;
    portalCode: string;
    mode: "register" | "login";
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    identifier?: string | null;
  },
  sendOtp: OtpSender,
) {
  const portal = await resolvePortalLink(input.storeSlug, input.portalCode);
  if (!portal.store || !portal.link) return { data: null, error: portal.error ?? "ต้องเปิดจาก QR ของร้าน" };

  let customerId: string | null = null;
  let name = input.name?.trim() ?? "";
  let phone = normalizePhone(input.phone);
  let email = normalizeEmail(input.email);

  if (input.mode === "login") {
    const customerRes = await findCustomerByIdentifier(portal.store.id, input.identifier ?? "");
    if (customerRes.error) return { data: null, error: customerRes.error };
    if (!customerRes.data) return { data: null, error: "ไม่พบสมาชิกของร้านนี้" };
    customerId = customerRes.data.id;
    name = customerRes.data.name;
    phone = normalizePhone(customerRes.data.phone);
    email = normalizeEmail(customerRes.data.email);
  }

  if (!phone) return { data: null, error: "ต้องมีเบอร์โทรศัพท์เพื่อรับ OTP" };
  if (input.mode === "register" && !name) return { data: null, error: "กรุณาระบุชื่อสำหรับสมัครสมาชิก" };
  if (input.mode === "register" && email) {
    const emailOwner = await findCustomerByEmail(portal.store.id, email);
    if (emailOwner.error) return { data: null, error: emailOwner.error };
    if (emailOwner.data && normalizePhone(emailOwner.data.phone) !== phone) {
      return { data: null, error: "กรุณาเข้าสู่ระบบหรือแจ้งร้านเพื่อยืนยันข้อมูลสมาชิก" };
    }
  }

  const supabase = await createSupabaseServiceClient();
  const recentOtpCount = await supabase
    .from("customer_member_otps")
    .select("id", { count: "exact", head: true })
    .eq("store_id", portal.store.id)
    .eq("phone", phone)
    .gte("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

  if (recentOtpCount.error) return { data: null, error: mapError(recentOtpCount.error).userMessage };
  if ((recentOtpCount.count ?? 0) >= 5) return { data: null, error: "ขอ OTP บ่อยเกินไป กรุณารอสักครู่" };

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const otp = await supabase
    .from("customer_member_otps")
    .insert({
      organization_id: portal.store.organizationId,
      store_id: portal.store.id,
      portal_link_id: portal.link.id,
      customer_id: customerId,
      purpose: input.mode,
      phone,
      email: email || null,
      name: name || null,
      code_hash: hashValue(`${phone}:${code}`),
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (otp.error) return { data: null, error: mapError(otp.error).userMessage };

  await sendOtp(phone, code);
  return { data: { otpId: otp.data.id, maskedPhone: maskPhone(phone) }, error: null };
}

async function createMemberSession(store: Store, customerId: string) {
  const supabase = await createSupabaseServiceClient();
  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const { error } = await supabase.from("customer_member_sessions").insert({
    organization_id: store.organizationId,
    store_id: store.id,
    customer_id: customerId,
    session_token_hash: hashValue(rawToken),
    expires_at: expiresAt.toISOString(),
  });
  if (error) return { error: mapError(error).userMessage };

  const cookieStore = await cookies();
  cookieStore.set(getMemberSessionCookieName(store.id), rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/member/${store.slug}`,
    expires: expiresAt,
  });
  return { error: null };
}

export async function verifyMemberOtp(input: {
  storeSlug: string;
  portalCode: string;
  otpId: string;
  code: string;
}) {
  const portal = await resolvePortalLink(input.storeSlug, input.portalCode);
  if (!portal.store || !portal.link) return { data: null, error: portal.error ?? "ต้องเปิดจาก QR ของร้าน" };

  const supabase = await createSupabaseServiceClient();
  const { data: otp, error } = await supabase
    .from("customer_member_otps")
    .select("*")
    .eq("id", input.otpId)
    .eq("store_id", portal.store.id)
    .eq("portal_link_id", portal.link.id)
    .maybeSingle();

  if (error) return { data: null, error: mapError(error).userMessage };
  if (!otp) return { data: null, error: "รหัส OTP ไม่ถูกต้อง" };

  const typedOtp: MemberOtpRow = otp;
  if (typedOtp.consumed_at) return { data: null, error: "OTP นี้ถูกใช้แล้ว" };
  if (new Date(typedOtp.expires_at).getTime() < Date.now()) return { data: null, error: "OTP หมดอายุแล้ว" };
  if (typedOtp.attempts >= 5) return { data: null, error: "กรอก OTP ผิดเกินจำนวนที่กำหนด" };

  const code = input.code.trim();
  if (hashValue(`${typedOtp.phone}:${code}`) !== typedOtp.code_hash) {
    await supabase
      .from("customer_member_otps")
      .update({ attempts: typedOtp.attempts + 1 })
      .eq("id", typedOtp.id);
    return { data: null, error: "รหัส OTP ไม่ถูกต้อง" };
  }

  const customerId = typedOtp.customer_id
    ? { data: typedOtp.customer_id, error: null }
    : await createOrFindMemberCustomer({
        organizationId: portal.store.organizationId,
        storeId: portal.store.id,
        name: typedOtp.name ?? "สมาชิก",
        phone: typedOtp.phone,
        email: typedOtp.email,
      });

  if (customerId.error || !customerId.data) return { data: null, error: customerId.error ?? "ไม่สามารถสร้างสมาชิกได้" };

  const consumed = await supabase
    .from("customer_member_otps")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", typedOtp.id);
  if (consumed.error) return { data: null, error: mapError(consumed.error).userMessage };

  const session = await createMemberSession(portal.store, customerId.data);
  if (session.error) return { data: null, error: session.error };

  return { data: { customerId: customerId.data }, error: null };
}

export async function getActiveMemberPortalLinkForStore(storeId: string) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("customer_member_portal_links")
    .select("*")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  return { data, error: null };
}

export async function generateMemberPortalLink(input: {
  organizationId: string;
  storeId: string;
  label?: string | null;
}) {
  const activeLink = await getActiveMemberPortalLinkForStore(input.storeId);
  if (activeLink.error) return { data: null, error: activeLink.error };
  if (activeLink.data) return { data: activeLink.data, error: null };

  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("customer_member_portal_links")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      token: randomUUID().replace(/-/g, ""),
      label: input.label?.trim() || "QR สมัครสมาชิก",
      is_active: true,
    })
    .select("*")
    .single();

  if (error) return { data: null, error: mapError(error) };
  return { data: data as PortalLinkRow, error: null };
}

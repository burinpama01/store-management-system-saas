import { withDataClient } from "@/shared/services/data-client";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Organization, Membership, MembershipPermissionOverride, PermissionKey } from "@/modules/tenants/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type OrgRow = Database["public"]["Tables"]["organizations"]["Row"];
type MembershipRow = Database["public"]["Tables"]["memberships"]["Row"];
type OverrideRow = Database["public"]["Tables"]["membership_permission_overrides"]["Row"];

// NOTE: subscriptionPlan/Status are placeholder defaults until Package D2 (Stripe) joins
// the subscriptions table. Do not rely on these values for billing logic.
function mapOrg(row: OrgRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerId: row.owner_id,
    subscriptionPlan: "free",
    subscriptionStatus: "active",
    logoUrl: row.logo_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    userId: row.user_id,
    role: row.role,
    invitedAt: row.invited_at,
    joinedAt: row.joined_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOverride(row: OverrideRow): MembershipPermissionOverride {
  return {
    id: row.id,
    membershipId: row.membership_id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    permissionKey: row.permission_key as PermissionKey,
    granted: row.granted,
    reason: row.reason,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getOrganization(id: string) {
  return withDataClient<Organization>(async (supabase) => {
    const { data, error } = await supabase
      .from("organizations")
      .select("*")
      .eq("id", id)
      .single();
    return { data: data ? mapOrg(data) : null, error };
  });
}

export async function listUserOrganizations() {
  return withDataClient<Organization[]>(
    async (supabase) => {
      const { data, error } = await supabase.from("organizations").select("*").order("name");
      return { data: data ? data.map(mapOrg) : null, error };
    },
    { defaultData: [] },
  );
}

export async function listUserMemberships() {
  return withDataClient<Membership[]>(
    async (supabase) => {
      const { data, error } = await supabase
        .from("memberships")
        .select("*")
        .not("joined_at", "is", null);
      return { data: data ? data.map(mapMembership) : null, error };
    },
    { defaultData: [] },
  );
}

export async function getMembershipPermissionOverrides(membershipId: string) {
  return withDataClient<MembershipPermissionOverride[]>(
    async (supabase) => {
      const { data, error } = await supabase
        .from("membership_permission_overrides")
        .select("*")
        .eq("membership_id", membershipId);
      return { data: data ? data.map(mapOverride) : null, error };
    },
    { defaultData: [] },
  );
}

export interface UpsertPermissionOverrideInput {
  membershipId: string;
  organizationId: string;
  storeId: string | null;
  permissionKey: PermissionKey;
  granted: boolean;
  reason: string;
  grantedByUserId: string;
}

export async function upsertPermissionOverride(input: UpsertPermissionOverrideInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("membership_permission_overrides").upsert(
    {
      membership_id: input.membershipId,
      organization_id: input.organizationId,
      store_id: input.storeId,
      permission_key: input.permissionKey,
      granted: input.granted,
      reason: input.reason,
      granted_by_user_id: input.grantedByUserId,
    },
    { onConflict: "membership_id,permission_key" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface AppendAuditLogInput {
  organizationId: string;
  storeId: string | null;
  actorUserId: string;
  targetUserId: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

export async function removePermissionOverride(
  membershipId: string,
  organizationId: string,
  permissionKey: PermissionKey,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("membership_permission_overrides")
    .delete()
    .eq("membership_id", membershipId)
    .eq("organization_id", organizationId)
    .eq("permission_key", permissionKey);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function appendAuditLog(input: AppendAuditLogInput) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("audit_logs").insert({
    organization_id: input.organizationId,
    store_id: input.storeId,
    actor_user_id: input.actorUserId,
    target_user_id: input.targetUserId,
    action: input.action,
    before: input.before as Database["public"]["Tables"]["audit_logs"]["Insert"]["before"],
    after: input.after as Database["public"]["Tables"]["audit_logs"]["Insert"]["after"],
    reason: input.reason,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

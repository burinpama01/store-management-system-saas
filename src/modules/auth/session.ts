import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { DEFAULT_THEME } from "@/modules/theme/presets";
import { cookies } from "next/headers";
import type { Database } from "@/server/integrations/supabase/database.types";

type MembershipRow = Database["public"]["Tables"]["memberships"]["Row"];
type OrganizationRow = Database["public"]["Tables"]["organizations"]["Row"];
type StoreRow = Database["public"]["Tables"]["stores"]["Row"];

export interface StoreContext {
  userId: string;
  organizationId: string;
  storeId: string;
  storeName: string;
  storeTimezone: string;
  themePresetId: string;
  themePrimaryColor: string;
  themePrimaryStrongColor: string;
  themePrimarySoftColor: string;
  themeAccentColor: string;
  orgName: string;
  role: MembershipRow["role"];
}

export function pickMembershipForStore(
  memberships: MembershipRow[],
  input: { userId: string; organizationId: string; storeId: string },
): MembershipRow | null {
  const ownMemberships = memberships.filter(
    (m) => m.user_id === input.userId && m.organization_id === input.organizationId,
  );
  return (
    ownMemberships.find((m) => m.store_id === input.storeId) ??
    ownMemberships.find((m) => m.store_id === null) ??
    null
  );
}

export function filterAccessibleStores(
  stores: StoreRow[],
  memberships: MembershipRow[],
  userId: string | null,
): StoreRow[] {
  if (!userId || memberships.length === 0) return [];

  const ownMemberships = memberships.filter((m) => m.user_id === userId);
  const orgWideOrganizationIds = new Set(
    ownMemberships.filter((m) => m.store_id === null).map((m) => m.organization_id),
  );
  const storeSpecificIds = new Set(
    ownMemberships.flatMap((m) => (m.store_id ? [m.store_id] : [])),
  );

  return stores.filter(
    (store) =>
      orgWideOrganizationIds.has(store.organization_id) || storeSpecificIds.has(store.id),
  );
}

export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

export async function getUserStores(): Promise<{
  userId: string | null;
  organizations: OrganizationRow[];
  stores: StoreRow[];
  memberships: MembershipRow[];
}> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const membershipsResult = user
    ? await supabase.from("memberships").select("*").eq("user_id", user.id).not("joined_at", "is", null)
    : { data: [] as MembershipRow[] };

  const memberships = membershipsResult.data ?? [];
  const organizationIds = Array.from(new Set(memberships.map((m) => m.organization_id)));

  if (organizationIds.length === 0) {
    return {
      userId: user?.id ?? null,
      memberships,
      organizations: [],
      stores: [],
    };
  }

  const [organizationsResult, storesResult] = await Promise.all([
    supabase.from("organizations").select("*").in("id", organizationIds),
    supabase.from("stores").select("*").eq("is_active", true).in("organization_id", organizationIds),
  ]);
  const stores = filterAccessibleStores(storesResult.data ?? [], memberships, user?.id ?? null);

  return {
    userId: user?.id ?? null,
    memberships,
    organizations: organizationsResult.data ?? [],
    stores,
  };
}

export async function resolveCurrentStore(
  stores: StoreRow[],
  organizations: OrganizationRow[],
  memberships: MembershipRow[],
  userId?: string | null,
): Promise<StoreContext | null> {
  if (stores.length === 0) return null;

  const cookieStore = await cookies();
  const selectedStoreId = cookieStore.get("selected_store_id")?.value;

  const store =
    (selectedStoreId ? stores.find((s) => s.id === selectedStoreId) : null) ?? stores[0];
  const org = organizations.find((o) => o.id === store.organization_id);
  if (!org) return null;

  const membership = pickMembershipForStore(memberships, {
    userId: userId ?? memberships[0]?.user_id ?? "",
    organizationId: org.id,
    storeId: store.id,
  });

  // Fail closed: no membership = no access
  if (!membership) return null;

  return {
    userId: membership.user_id,
    organizationId: org.id,
    storeId: store.id,
    storeName: store.name,
    storeTimezone: store.timezone,
    themePresetId: store.theme_preset_id ?? DEFAULT_THEME.presetId,
    themePrimaryColor: store.theme_primary_color ?? DEFAULT_THEME.primaryColor,
    themePrimaryStrongColor: store.theme_primary_strong_color ?? DEFAULT_THEME.primaryStrongColor,
    themePrimarySoftColor: store.theme_primary_soft_color ?? DEFAULT_THEME.primarySoftColor,
    themeAccentColor: store.theme_accent_color ?? DEFAULT_THEME.accentColor,
    orgName: org.name,
    role: membership.role,
  };
}

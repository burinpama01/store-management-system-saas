import { redirect } from "next/navigation";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { isOpsManagerRole } from "@/modules/operations/access";
import { isOperationsEnabled } from "@/modules/operations/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import type { Readiness } from "@/modules/operations/types";

export const READINESS_TONE: Record<Readiness, string> = {
  READY: "border-emerald-300 bg-emerald-50 text-emerald-800",
  LIMITED: "border-amber-300 bg-amber-50 text-amber-800",
  NOT_READY: "border-red-300 bg-red-50 text-red-800",
  UNKNOWN: "border-gray-300 bg-gray-50 text-gray-700",
};

export async function loadOpsPageContext() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) redirect("/dashboard");
  const enabled = await isOperationsEnabled(ctx.storeId);
  return { user, ctx, enabled, isManager: isOpsManagerRole(ctx.role) };
}

/** ใช้ได้เฉพาะเจ้าของ/admin (listStoreMemberships อ่านอีเมลผ่าน service client) */
export async function loadMemberNames(organizationId: string, storeId: string): Promise<Map<string, string>> {
  const result = await listStoreMemberships(organizationId, storeId);
  const names = new Map<string, string>();
  for (const member of result.data ?? []) names.set(member.userId, member.email);
  return names;
}

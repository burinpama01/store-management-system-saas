"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  assignProductKitchenStation,
  deleteKitchenStation,
  replaceKitchenStationStaffAssignments,
  saveKitchenStation,
} from "@/modules/qr-ordering/kitchen-stations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedStation =
  | { error: string }
  | {
      name: string;
      description?: string;
      sortOrder: number;
      isActive: boolean;
      printerId: string | null;
    };

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("No active store");
  return ctx;
}

function revalidateKitchen() {
  revalidatePath("/settings/kitchen", "page");
  revalidatePath("/qr-orders", "page");
}

function parseStation(formData: FormData): ParsedStation {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Kitchen station name is required" };
  if (name.length > 80) return { error: "Kitchen station name is too long" };

  const description = String(formData.get("description") ?? "").trim();
  const sortRaw = String(formData.get("sortOrder") ?? "0").trim();
  const sortOrder = sortRaw ? Number.parseInt(sortRaw, 10) : 0;
  if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 999) {
    return { error: "Sort order must be 0-999" };
  }

  const printerRaw = String(formData.get("printerId") ?? "").trim();
  if (printerRaw && !UUID_RE.test(printerRaw)) return { error: "Invalid printer" };

  return {
    name,
    description: description || undefined,
    sortOrder,
    isActive: true,
    printerId: printerRaw || null,
  };
}

export async function saveStationAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const ctx = await getStoreContext();
    const parsed = parseStation(formData);
    if ("error" in parsed) return { error: parsed.error };

    const id = String(formData.get("id") ?? "").trim();
    if (id && !UUID_RE.test(id)) return { error: "Invalid kitchen station" };

    const result = await saveKitchenStation({
      id: id || undefined,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      ...parsed,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidateKitchen();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected error" };
  }
}

export async function deleteStationAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const ctx = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "Invalid kitchen station" };
    const result = await deleteKitchenStation(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidateKitchen();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected error" };
  }
}

export async function assignProductStationAction(
  productId: string,
  kitchenStationId: string | null,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const ctx = await getStoreContext();
    if (!UUID_RE.test(productId)) return { error: "Invalid product" };
    if (kitchenStationId && !UUID_RE.test(kitchenStationId)) {
      return { error: "Invalid kitchen station" };
    }

    const result = await assignProductKitchenStation(productId, ctx.storeId, kitchenStationId);
    if (result.error) return { error: result.error.userMessage };
    revalidateKitchen();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected error" };
  }
}

export async function assignStationStaffAction(
  kitchenStationId: string,
  userIds: string[],
): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const ctx = await getStoreContext();
    if (!UUID_RE.test(kitchenStationId)) return { error: "Invalid kitchen station" };
    const staffUserIds = [...new Set(userIds)].filter((userId) => UUID_RE.test(userId));
    if (staffUserIds.length !== userIds.length) return { error: "Invalid staff member" };

    const result = await replaceKitchenStationStaffAssignments({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      kitchenStationId,
      userIds: staffUserIds,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidateKitchen();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Unexpected error" };
  }
}

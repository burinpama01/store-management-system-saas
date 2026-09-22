import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Product } from "@/modules/catalog/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type KitchenStationRow = Database["public"]["Tables"]["kitchen_stations"]["Row"];
type KitchenStationStaffRow = Database["public"]["Tables"]["kitchen_station_staff"]["Row"];
type ProductRow = Database["public"]["Tables"]["products"]["Row"];

export const KITCHEN_ASSIGNABLE_ROLES: readonly Database["public"]["Tables"]["memberships"]["Row"]["role"][] = ["staff", "cashier", "manager"];

export interface KitchenStation {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  description?: string;
  sortOrder: number;
  isActive: boolean;
  printerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveKitchenStationInput {
  id?: string;
  organizationId: string;
  storeId: string;
  name: string;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
  printerId?: string | null;
}

export interface KitchenStationStaffAssignment {
  id: string;
  organizationId: string;
  storeId: string;
  kitchenStationId: string;
  userId: string;
  createdAt: string;
}

export interface ReplaceKitchenStationStaffAssignmentsInput {
  organizationId: string;
  storeId: string;
  kitchenStationId: string;
  userIds: string[];
}

function mapStation(row: KitchenStationRow): KitchenStation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    name: row.name,
    description: row.description ?? undefined,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    printerId: row.printer_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStaffAssignment(row: KitchenStationStaffRow): KitchenStationStaffAssignment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    kitchenStationId: row.kitchen_station_id,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

export function mapProductKitchenStation(row: ProductRow): Pick<Product, "kitchenStationId"> {
  return { kitchenStationId: row.kitchen_station_id ?? undefined };
}

export async function listKitchenStations(storeId: string, opts: { includeInactive?: boolean } = {}) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("kitchen_stations")
    .select("*")
    .eq("store_id", storeId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!opts.includeInactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map((row) => mapStation(row as KitchenStationRow)), error: null };
}

export async function listKitchenStationStaffAssignments(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("kitchen_station_staff")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map((row) => mapStaffAssignment(row as KitchenStationStaffRow)), error: null };
}

export async function listAssignedKitchenStationIdsForUser(storeId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("kitchen_station_staff")
    .select("kitchen_station_id")
    .eq("store_id", storeId)
    .eq("user_id", userId);
  if (error) return { data: null, error: mapError(error) };
  return { data: [...new Set((data ?? []).map((row) => row.kitchen_station_id))], error: null };
}

export interface KitchenStationScope {
  /** true = เห็นทุกสถานีครัว (ปุ่มทั้งออเดอร์ รับ/ปฏิเสธ ใช้ได้) */
  canSeeAll: boolean;
  /** สถานีที่ผูกกับผู้ใช้ — ใช้กรองเมื่อ canSeeAll เป็น false */
  stationIds: string[];
}

/**
 * ขอบเขตสถานีครัวที่ผู้ใช้เห็นในหน้า QR Order / dialog ออเดอร์เข้า
 *
 * - ถูกผูกสถานีไว้ (staff / cashier / manager) → เห็นเฉพาะสถานีของตัวเอง
 * - staff ที่ยังไม่ผูกสถานี → ไม่เห็นอะไร (เหมือนเดิม)
 * - cashier / manager ที่ไม่ได้ผูก และ owner → เห็นทุกสถานี
 *
 * เดิมกรองเฉพาะ role staff ทำให้แคชเชียร์/ผู้จัดการที่ถูกผูกสถานี (เปิดให้ผูกได้ใน PR#90)
 * ยังเห็นออเดอร์ของสถานีอื่นปนมา
 */
export async function resolveKitchenStationScope(
  storeId: string,
  userId: string,
  role: string,
): Promise<KitchenStationScope> {
  if (!(KITCHEN_ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    return { canSeeAll: true, stationIds: [] };
  }
  const assigned = await listAssignedKitchenStationIdsForUser(storeId, userId);
  const stationIds = assigned.data ?? [];
  if (role === "staff") return { canSeeAll: false, stationIds };
  // อ่านการผูกไม่ได้ = คงสิทธิ์เดิมของแคชเชียร์/ผู้จัดการ (เห็นทั้งหมด) ไม่ให้หน้าว่างเปล่า
  if (assigned.error || stationIds.length === 0) return { canSeeAll: true, stationIds: [] };
  return { canSeeAll: false, stationIds };
}

export async function replaceKitchenStationStaffAssignments(
  input: ReplaceKitchenStationStaffAssignmentsInput,
) {
  const supabase = await createSupabaseServerClient();
  const { data: station, error: stationError } = await supabase
    .from("kitchen_stations")
    .select("id, is_active")
    .eq("id", input.kitchenStationId)
    .eq("store_id", input.storeId)
    .single();
  if (stationError || !station) {
    return { error: mapError(stationError ?? new Error("Kitchen station not found")) };
  }
  if (!station.is_active) {
    return { error: mapError(new Error("Inactive kitchen station cannot be assigned")) };
  }

  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (userIds.length > 0) {
    const { data: staffRows, error: staffError } = await supabase
      .from("memberships")
      .select("user_id, role")
      .eq("organization_id", input.organizationId)
      .in("role", KITCHEN_ASSIGNABLE_ROLES)
      .in("user_id", userIds)
      .or(`store_id.eq.${input.storeId},store_id.is.null`)
      .not("joined_at", "is", null);
    if (staffError) return { error: mapError(staffError) };
    const validStaffIds = new Set((staffRows ?? []).map((row) => row.user_id));
    const invalidUserId = userIds.find((userId) => !validStaffIds.has(userId));
    if (invalidUserId) {
      return { error: mapError(new Error("Kitchen station members must be joined Staff, Cashier or Manager members of this store")) };
    }
  }

  const { error: deleteError } = await supabase
    .from("kitchen_station_staff")
    .delete()
    .eq("store_id", input.storeId)
    .eq("kitchen_station_id", input.kitchenStationId);
  if (deleteError) return { error: mapError(deleteError) };

  if (userIds.length === 0) return { error: null };

  const { error: insertError } = await supabase.from("kitchen_station_staff").insert(
    userIds.map((userId) => ({
      organization_id: input.organizationId,
      store_id: input.storeId,
      kitchen_station_id: input.kitchenStationId,
      user_id: userId,
    })),
  );
  if (insertError) return { error: mapError(insertError) };
  return { error: null };
}

export async function saveKitchenStation(input: SaveKitchenStationInput) {
  const supabase = await createSupabaseServerClient();
  const payload = {
    organization_id: input.organizationId,
    store_id: input.storeId,
    name: input.name,
    description: input.description ?? null,
    sort_order: input.sortOrder ?? 0,
    is_active: input.isActive ?? true,
    printer_id: input.printerId ?? null,
  };

  if (input.id) {
    const { data: existing, error: existingError } = await supabase
      .from("kitchen_stations")
      .select("id, is_active")
      .eq("id", input.id)
      .eq("store_id", input.storeId)
      .single();
    if (existingError) return { data: null, error: mapError(existingError) };
    if (!existing.is_active) {
      return {
        data: null,
        error: mapError(new Error("Inactive kitchen station cannot be edited")),
      };
    }

    const { data, error } = await supabase
      .from("kitchen_stations")
      .update(payload)
      .eq("id", input.id)
      .eq("store_id", input.storeId)
      .eq("is_active", true)
      .select("*")
      .single();
    if (error) return { data: null, error: mapError(error) };
    return { data: mapStation(data as KitchenStationRow), error: null };
  }

  const { data, error } = await supabase.from("kitchen_stations").insert(payload).select("*").single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapStation(data as KitchenStationRow), error: null };
}

export async function deleteKitchenStation(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error: productError } = await supabase
    .from("products")
    .update({ kitchen_station_id: null })
    .eq("store_id", storeId)
    .eq("kitchen_station_id", id);
  if (productError) return { error: mapError(productError) };

  const { error } = await supabase
    .from("kitchen_stations")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { error: mapError(error) };
  return { error: null };
}

export async function assignProductKitchenStation(
  productId: string,
  storeId: string,
  kitchenStationId: string | null,
) {
  const supabase = await createSupabaseServerClient();
  if (kitchenStationId) {
    const { data: station, error: stationError } = await supabase
      .from("kitchen_stations")
      .select("id")
      .eq("id", kitchenStationId)
      .eq("store_id", storeId)
      .eq("is_active", true)
      .single();
    if (stationError || !station) {
      return { error: mapError(stationError ?? { message: "Kitchen station not found" }) };
    }
  }

  const { error } = await supabase
    .from("products")
    .update({ kitchen_station_id: kitchenStationId })
    .eq("id", productId)
    .eq("store_id", storeId);
  if (error) return { error: mapError(error) };
  return { error: null };
}

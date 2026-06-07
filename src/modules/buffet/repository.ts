import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { BuffetSession, BuffetPackage } from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type PackageRow = Database["public"]["Tables"]["buffet_packages"]["Row"];

function mapPackage(row: PackageRow): BuffetPackage {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    name: row.name,
    pricePerGuest: Number(row.price_per_guest),
    durationMinutes: row.duration_minutes,
    active: row.active,
    sortOrder: row.sort_order,
  };
}

export async function listBuffetPackages(storeId: string, includeInactive = false): Promise<BuffetPackage[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase.from("buffet_packages").select("*").eq("store_id", storeId).order("sort_order");
  if (!includeInactive) query = query.eq("active", true);
  const { data } = await query;
  return (data ?? []).map(mapPackage);
}

export async function createBuffetPackage(input: {
  organizationId: string;
  storeId: string;
  name: string;
  pricePerGuest: number;
  durationMinutes: number | null;
}) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("buffet_packages").insert({
    organization_id: input.organizationId,
    store_id: input.storeId,
    name: input.name,
    price_per_guest: input.pricePerGuest,
    duration_minutes: input.durationMinutes,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function setBuffetPackageActive(id: string, storeId: string, active: boolean) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("buffet_packages")
    .update({ active })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

type SessionRow = Database["public"]["Tables"]["buffet_sessions"]["Row"];
type TableRow = Database["public"]["Tables"]["tables"]["Row"];

export type StoreTable = Pick<TableRow, "id" | "number" | "label" | "status">;

function mapSession(row: SessionRow): BuffetSession {
  // Integer arithmetic to avoid IEEE 754 float errors on money multiplication.
  const totalCharge = (Math.round(row.price_per_guest * 100) * row.guest_count) / 100;
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    tableId: row.table_id,
    packageName: row.package_name,
    pricePerGuest: row.price_per_guest,
    guestCount: row.guest_count,
    totalCharge,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    orderId: row.order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListSessionsOpts {
  status?: "open" | "closed";
  startedAfter?: string;
}

export async function listBuffetSessions(storeId: string, opts: ListSessionsOpts = {}) {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("buffet_sessions")
    .select("*")
    .eq("store_id", storeId)
    .order("started_at", { ascending: false });
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.startedAfter) q = q.gte("started_at", opts.startedAfter);
  const { data, error } = await q;
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapSession), error: null };
}

export async function getBuffetSession(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("buffet_sessions")
    .select("*")
    .eq("id", id)
    .eq("store_id", storeId)
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapSession(data), error: null };
}

export interface CreateSessionInput {
  organizationId: string;
  storeId: string;
  tableId?: string;
  packageName: string;
  pricePerGuest: number;
  guestCount: number;
}

export async function createBuffetSession(input: CreateSessionInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("buffet_sessions")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      table_id: input.tableId ?? null,
      package_name: input.packageName,
      price_per_guest: input.pricePerGuest,
      guest_count: input.guestCount,
      status: "open",
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapSession(data), error: null };
}

export async function updateGuestCount(id: string, storeId: string, guestCount: number) {
  const supabase = await createSupabaseServerClient();
  // updated_at is managed by the DB trigger; no manual assignment needed.
  const { data, error } = await supabase
    .from("buffet_sessions")
    .update({ guest_count: guestCount })
    .eq("id", id)
    .eq("store_id", storeId)
    .eq("status", "open")
    .select()
    .single();
  if (error || !data)
    return { data: null, error: mapError(error ?? new Error("ไม่พบเซสชันที่เปิดอยู่")) };
  return { data: mapSession(data), error: null };
}

export async function closeBuffetSession(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const now = new Date().toISOString();
  // Atomic close: only succeeds if status is still "open".
  const { data, error } = await supabase
    .from("buffet_sessions")
    .update({ status: "closed", ended_at: now })
    .eq("id", id)
    .eq("store_id", storeId)
    .eq("status", "open")
    .select()
    .single();
  if (error || !data)
    return { data: null, error: mapError(error ?? new Error("ไม่พบเซสชันที่เปิดอยู่")) };
  return { data: mapSession(data), error: null };
}

export async function listStoreTables(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tables")
    .select("id, number, label, status")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .order("number");
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []) as StoreTable[], error: null };
}

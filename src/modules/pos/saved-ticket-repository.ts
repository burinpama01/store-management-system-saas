import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database, Json } from "@/server/integrations/supabase/database.types";
import type { Cart, SavedOrderTicket } from "./types";

type PosSavedTicketRow = Database["public"]["Tables"]["pos_saved_tickets"]["Row"];

function mapSavedTicket(row: PosSavedTicketRow): SavedOrderTicket {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    label: row.label,
    cart: row.cart_snapshot as unknown as Cart,
    tableId: row.table_id ?? undefined,
    tableNumber: row.table_number ?? undefined,
    customerName: row.customer_name ?? undefined,
    note: row.note ?? undefined,
    buffetSessionId: row.buffet_session_id ?? undefined,
    ticketSource: row.ticket_source === "table_auto" ? "table_auto" : "manual",
    syncState: "synced",
    lastSyncedAt: row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSavedTickets(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pos_saved_tickets")
    .select("*")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(30);

  if (error) return { data: null, error: mapError(error) };
  return {
    data: (data ?? [])
      .map(mapSavedTicket)
      .filter((ticket) => ticket.cart.storeId === storeId && Array.isArray(ticket.cart.items)),
    error: null,
  };
}

/**
 * ตั๋วที่ผูกโต๊ะทั้งหมดของร้าน — ใช้กับตรรกะเงิน/บิล (ไม่ติด limit 30 ของรายการตั๋วใน UI)
 * tableId = เฉพาะโต๊ะนั้น
 */
export async function listTableSavedTickets(storeId: string, tableId?: string) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("pos_saved_tickets")
    .select("*")
    .eq("store_id", storeId)
    .not("table_id", "is", null);
  if (tableId) query = query.eq("table_id", tableId);
  const { data, error } = await query.order("created_at", { ascending: true });

  if (error) return { data: null, error: mapError(error) };
  return {
    data: (data ?? [])
      .map(mapSavedTicket)
      .filter((ticket) => ticket.cart.storeId === storeId && Array.isArray(ticket.cart.items)),
    error: null,
  };
}

/** ตั๋วอัตโนมัติของโต๊ะ: สร้างถ้ายังไม่มี / คืนใบเดิม (atomic ใน DB — เปิดโต๊ะพร้อมกันได้ 1 ใบ) */
export async function ensureTableAutoTicket(input: {
  organizationId: string;
  storeId: string;
  ticket: SavedOrderTicket;
}) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("ensure_table_auto_ticket", {
    p_ticket_id: input.ticket.id,
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_table_id: input.ticket.tableId ?? "",
    p_ticket_number: input.ticket.ticketNumber,
    p_label: input.ticket.label,
    p_table_number: input.ticket.tableNumber ?? "",
    p_cart: input.ticket.cart as unknown as Json,
  });
  if (error) return { data: null, error: mapError(error) };
  const row = (data ?? [])[0];
  if (!row) return { data: null, error: mapError(new Error("เปิดตั๋วของโต๊ะไม่สำเร็จ")) };
  return { data: mapSavedTicket(row), error: null };
}

export async function getSavedTicket(ticketId: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pos_saved_tickets")
    .select("*")
    .eq("id", ticketId)
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapSavedTicket(data) : null, error: null };
}

export interface SaveSavedTicketInput {
  organizationId: string;
  storeId: string;
  userId: string;
  ticket: SavedOrderTicket;
}

export async function saveSavedTicket(input: SaveSavedTicketInput) {
  const supabase = await createSupabaseServerClient();
  const { data: existing, error: existingError } = await supabase
    .from("pos_saved_tickets")
    .select("id")
    .eq("id", input.ticket.id)
    .eq("store_id", input.storeId)
    .maybeSingle();

  if (existingError) return { data: null, error: mapError(existingError) };

  const payload = {
    ticket_number: input.ticket.ticketNumber,
    label: input.ticket.label,
    cart_snapshot: input.ticket.cart as unknown as Json,
    table_id: input.ticket.tableId ?? null,
    table_number: input.ticket.tableNumber ?? null,
    customer_name: input.ticket.customerName ?? null,
    note: input.ticket.note ?? null,
    buffet_session_id: input.ticket.buffetSessionId ?? null,
    updated_by_user_id: input.userId,
    updated_at: input.ticket.updatedAt,
  };

  const mutation = existing
    ? supabase
      .from("pos_saved_tickets")
      .update(payload)
      .eq("id", input.ticket.id)
      .eq("store_id", input.storeId)
    : supabase
      .from("pos_saved_tickets")
      .insert({
        id: input.ticket.id,
        organization_id: input.organizationId,
        store_id: input.storeId,
        ...payload,
        created_by_user_id: input.userId,
        created_at: input.ticket.createdAt,
      });

  const { data, error } = await mutation
    .select("*")
    .single();

  if (error || !data) return { data: null, error: mapError(error ?? new Error("ไม่สามารถบันทึกตั๋วได้")) };
  return { data: mapSavedTicket(data), error: null };
}

export async function deleteSavedTicket(ticketId: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pos_saved_tickets")
    .delete()
    .eq("id", ticketId)
    .eq("store_id", storeId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: mapError(error) };
  if (!data) return { ok: false, error: mapError(new Error("ไม่พบตั๋วที่ต้องการลบ")) };
  return { ok: true, error: null };
}

export async function deleteSavedTicketAndCloseTable(ticketId: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("delete_pos_saved_ticket_and_close_table", {
    p_ticket_id: ticketId,
    p_store_id: storeId,
  });

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

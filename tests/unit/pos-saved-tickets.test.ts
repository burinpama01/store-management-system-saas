import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("POS server-backed saved tickets", () => {
  it("adds a store-scoped Supabase table with RLS for saved POS tickets", () => {
    const migration = read("supabase/migrations/20260617000003_pos_saved_tickets.sql");

    expect(migration).toContain("create table if not exists pos_saved_tickets");
    expect(migration).toMatch(/organization_id\s+uuid not null references organizations\(id\) on delete cascade/);
    expect(migration).toMatch(/store_id\s+uuid not null references stores\(id\) on delete cascade/);
    expect(migration).toContain("constraint pos_saved_tickets_store_org_match");
    expect(migration).toContain("foreign key (store_id, organization_id) references stores(id, organization_id)");
    expect(migration).toMatch(/cart_snapshot\s+jsonb not null/);
    expect(migration).toMatch(/created_by_user_id\s+uuid not null references auth\.users\(id\)/);
    expect(migration).toMatch(/updated_by_user_id\s+uuid not null references auth\.users\(id\)/);
    expect(migration).toContain("alter table pos_saved_tickets enable row level security");
    expect(migration).toContain("cart_snapshot->>'storeId' = store_id::text");
    expect(migration).toContain("jsonb_typeof(cart_snapshot->'items') = 'array'");
    expect(migration).toContain("auth_user_store_ids()");
    expect(migration).toContain("store_id in (select auth_user_store_ids())");
    expect(migration).toContain("auth_user_role_in_store(organization_id, store_id, 'cashier')");
    expect(migration).toContain("created_by_user_id = auth.uid()");
    expect(migration).toContain("updated_by_user_id = auth.uid()");
    expect(migration).toContain("prevent_pos_saved_ticket_creator_change");
    expect(migration).toContain("create trigger set_updated_at before update on pos_saved_tickets");
  });

  it("stores and loads tickets through a POS repository scoped by store", () => {
    const repository = read("src/modules/pos/saved-ticket-repository.ts");

    expect(repository).toContain('Database["public"]["Tables"]["pos_saved_tickets"]["Row"]');
    expect(repository).toContain('.from("pos_saved_tickets")');
    expect(repository).toContain('.eq("store_id", storeId)');
    expect(repository).toContain("cart_snapshot: input.ticket.cart");
    expect(repository).toContain("created_by_user_id: input.userId");
    expect(repository).toContain("updated_by_user_id: input.userId");
    expect(repository).toContain("ticket.cart.storeId === storeId");
    expect(repository).toContain("Array.isArray(ticket.cart.items)");
    expect(repository).toContain('.select("id")');
    expect(repository).toContain("ไม่พบตั๋วที่ต้องการลบ");
  });

  it("extends saved tickets with restaurant context metadata", () => {
    const migration = read("supabase/migrations/20260617000004_pos_saved_tickets_ux_metadata.sql");
    const types = read("src/modules/pos/types.ts");
    const repository = read("src/modules/pos/saved-ticket-repository.ts");
    const databaseTypes = read("src/server/integrations/supabase/database.types.ts");

    expect(migration).toContain("alter table pos_saved_tickets");
    expect(migration).toContain("add column if not exists table_id");
    expect(migration).toContain("add column if not exists table_number");
    expect(migration).toContain("add column if not exists customer_name");
    expect(migration).toContain("add column if not exists note");
    expect(migration).toContain("add column if not exists buffet_session_id");
    expect(migration).toContain("pos_saved_tickets_store_table_idx");
    expect(migration).toContain("validate_pos_saved_ticket_table_store");
    expect(migration).toContain("delete_pos_saved_ticket_and_close_table");

    expect(types).toContain("tableId?: string");
    expect(types).toContain("tableNumber?: string");
    expect(types).toContain("customerName?: string");
    expect(types).toContain("note?: string");
    expect(types).toContain("buffetSessionId?: string");
    expect(types).toContain("syncState?:");
    expect(types).toContain("lastSyncedAt?: string");

    expect(repository).toContain("tableId: row.table_id ?? undefined");
    expect(repository).toContain("table_id: input.ticket.tableId ?? null");
    expect(repository).toContain("deleteSavedTicketAndCloseTable");
    expect(repository).toContain('supabase.rpc("delete_pos_saved_ticket_and_close_table"');
    expect(databaseTypes).toContain("table_id: string | null");
    expect(databaseTypes).toContain("customer_name: string | null");
  });

  it("exposes server actions that validate permission, store boundary, and trusted cart data", () => {
    const actions = read("src/app/pos/actions.ts");

    expect(actions).toContain("listSavedTicketsAction");
    expect(actions).toContain("saveSavedTicketAction");
    expect(actions).toContain("deleteSavedTicketAction");
    expect(actions).toContain('await requirePermission("pos.use")');
    expect(actions).toContain("ticket.cart.storeId !== ctx.storeId");
    expect(actions).toContain("if (ticket.tableId)");
    expect(actions).toContain("await getTable(ticket.tableId, ctx.storeId)");
    expect(actions).toContain("return { ticket: null, error: \"ไม่พบโต๊ะนี้ในร้านค้า\" }");
    expect(actions).toContain("buildTrustedCartFromCatalog(ticket.cart");
    expect(actions).toContain("saveSavedTicket({");
    expect(actions).toContain("deleteSavedTicket(ticketId, ctx.storeId)");
    expect(actions).toContain("payment.method === \"qr_promptpay\" && payment.qrPaymentVerified !== true");
  });

  it("exposes order history and safe table lifecycle actions for ticket UX", () => {
    const actions = read("src/app/pos/actions.ts");
    const repository = read("src/modules/pos/order-repository.ts");

    expect(actions).toContain("listTodayOrdersAction");
    expect(actions).toContain("listTodayOrders(ctx.storeId, ctx.storeTimezone)");
    expect(actions).toContain("deleteSavedTicketAction(ticketId: string, opts?: { closeRelatedTableSession?: boolean })");
    expect(actions).toContain("opts?.closeRelatedTableSession");
    expect(actions).toContain("deleteSavedTicketAndCloseTable(ticketId, ctx.storeId)");
    expect(repository).toContain("export async function listTodayOrders");
    expect(repository).toContain("getStoreLocalDate(storeTimezone");
    expect(repository).toContain(".order(\"created_at\", { ascending: false })");
  });
});

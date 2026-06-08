import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("QR order fulfillment (#6)", () => {
  const migration = read("supabase/migrations/20260607000002_qr_order_fulfillment.sql");

  it("adds an independent kitchen prep_status to orders", () => {
    expect(migration).toContain("alter table orders");
    expect(migration).toContain("add column if not exists prep_status");
    expect(migration).toContain("check (prep_status in ('new','preparing','served','done'))");
  });

  it("defines service_requests with one-pending-per-table-type guard and RLS", () => {
    expect(migration).toContain("create table if not exists service_requests");
    expect(migration).toContain("type in ('call_staff','request_bill')");
    expect(migration).toContain("status in ('pending','resolved')");
    expect(migration).toContain("service_requests_one_pending_per_table_type");
    expect(migration).toContain("alter table service_requests enable row level security");
    expect(migration).toContain("service_requests: store member can read");
    expect(migration).toContain("service_requests: deny client insert");
    expect(migration).toContain("service_requests: cashier+ can update");
  });

  it("exposes an anon-callable RPC that validates the QR table before inserting", () => {
    expect(migration).toContain("create or replace function create_service_request");
    expect(migration).toContain("p_type not in ('call_staff','request_bill')");
    expect(migration).toContain("qr_ordering_enabled = true");
    expect(migration).toContain("qr_enabled = true");
    expect(migration).toContain("on conflict (table_id, type) where (status = 'pending')");
    expect(migration).toContain("grant execute on function create_service_request(uuid, uuid, text, text) to anon, authenticated, service_role");
  });

  it("enables realtime for orders and service_requests", () => {
    expect(migration).toContain("alter publication supabase_realtime add table orders");
    expect(migration).toContain("alter publication supabase_realtime add table service_requests");
  });

  it("wires customer + restaurant flows to the new APIs", () => {
    const customerActions = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(customerActions).toContain("getTableOrdersAction");
    expect(customerActions).toContain("requestServiceAction");
    expect(customerActions).toContain('supabase.rpc("create_service_request"');

    const repo = read("src/modules/qr-ordering/repository.ts");
    expect(repo).toContain("listActiveQrOrders");
    expect(repo).toContain("listPendingServiceRequests");
    expect(repo).toContain("updateOrderPrepStatus");
    expect(repo).toContain("resolveServiceRequest");

    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("managedRealtimeSubscription");
    expect(board).toContain('table: "orders"');
    expect(board).toContain('table: "service_requests"');
  });
});

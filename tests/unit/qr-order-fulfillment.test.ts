import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canTransitionItemFulfillment,
  UNIFIED_POS_ERROR_CODES,
} from "@/modules/unified-pos/contracts";
import {
  planOrderPrepAdvance,
  type PrepAdvanceItemInput,
} from "@/modules/unified-pos/prep-advance";

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

// ============================================================
// U5 (v0.35.5) — Item fulfillment + order prep derive (facade)
// ============================================================

describe("U5 prep-advance facade mapping", () => {
  const item = (id: string, fulfillmentStatus: PrepAdvanceItemInput["fulfillmentStatus"], voided = false): PrepAdvanceItemInput => ({
    id,
    voided,
    fulfillmentStatus,
  });

  it("target preparing: เลื่อนเฉพาะ item ที่เป็น new ทีละขั้น (preparing)", () => {
    const plan = planOrderPrepAdvance(
      [item("a", "new"), item("b", "new"), item("c", "preparing")],
      "preparing",
    );
    expect(plan).toEqual({
      kind: "advance",
      moves: [
        { itemId: "a", from: "new", to: "preparing" },
        { itemId: "b", from: "new", to: "preparing" },
      ],
    });
  });

  it("target ready: item new ต้องเลื่อนเป็น preparing เท่านั้น (ห้าม skip ข้ามขั้น)", () => {
    const plan = planOrderPrepAdvance(
      [item("a", "new"), item("b", "preparing"), item("c", "ready")],
      "ready",
    );
    expect(plan).toEqual({
      kind: "advance",
      moves: [
        { itemId: "a", from: "new", to: "preparing" },
        { itemId: "b", from: "preparing", to: "ready" },
      ],
    });
  });

  it("target served: เลื่อนทีละขั้นจากทุกสถานะก่อนหน้า (new→preparing, preparing→ready, ready→served)", () => {
    const plan = planOrderPrepAdvance(
      [item("a", "new"), item("b", "preparing"), item("c", "ready"), item("d", "served")],
      "served",
    );
    expect(plan).toEqual({
      kind: "advance",
      moves: [
        { itemId: "a", from: "new", to: "preparing" },
        { itemId: "b", from: "preparing", to: "ready" },
        { itemId: "c", from: "ready", to: "served" },
      ],
    });
  });

  it("item ที่ voided ถูกข้ามเสมอ และ item อยู่หลัง target แล้วไม่ถูกแตะ", () => {
    const plan = planOrderPrepAdvance(
      [item("v", "new", true), item("s", "served"), item("r", "ready")],
      "served",
    );
    expect(plan).toEqual({ kind: "advance", moves: [{ itemId: "r", from: "ready", to: "served" }] });
  });

  it("ทุก move ต้องผ่าน canTransitionItemFulfillment (กัน skip ที่ผิดพลาด)", () => {
    const plan = planOrderPrepAdvance([item("a", "new"), item("b", "preparing")], "served");
    expect(plan.kind).toBe("advance");
    if (plan.kind === "advance") {
      for (const move of plan.moves) {
        expect(canTransitionItemFulfillment(move.from, move.to)).toBe(true);
      }
    }
  });

  it("noop: ทุก item อยู่ที่/หลัง target แล้ว (ไม่ต้องส่ง RPC)", () => {
    expect(planOrderPrepAdvance([item("a", "served"), item("b", "ready")], "ready")).toEqual({
      kind: "noop",
    });
    expect(planOrderPrepAdvance([], "served")).toEqual({ kind: "noop" });
  });

  it("rejected: target new (ย้อนกลับ) และ target done (derive อัตโนมัติจากชำระ/ยกเลิก)", () => {
    const reverse = planOrderPrepAdvance([item("a", "preparing")], "new");
    expect(reverse.kind).toBe("rejected");
    if (reverse.kind === "rejected") {
      expect(reverse.code).toBe(UNIFIED_POS_ERROR_CODES.invalid_state_transition);
    }

    const done = planOrderPrepAdvance([item("a", "served")], "done");
    expect(done.kind).toBe("rejected");
    if (done.kind === "rejected") {
      expect(done.code).toBe(UNIFIED_POS_ERROR_CODES.invalid_state_transition);
    }
  });
});

describe("U5 transition validation (canTransitionItemFulfillment)", () => {
  it("forward chain new→preparing→ready→served เท่านั้น", () => {
    expect(canTransitionItemFulfillment("new", "preparing")).toBe(true);
    expect(canTransitionItemFulfillment("preparing", "ready")).toBe(true);
    expect(canTransitionItemFulfillment("ready", "served")).toBe(true);
  });

  it("reject reverse / skip / same / served ต่อ", () => {
    expect(canTransitionItemFulfillment("served", "ready")).toBe(false);
    expect(canTransitionItemFulfillment("ready", "preparing")).toBe(false);
    expect(canTransitionItemFulfillment("new", "ready")).toBe(false);
    expect(canTransitionItemFulfillment("new", "served")).toBe(false);
    expect(canTransitionItemFulfillment("preparing", "preparing")).toBe(false);
    expect(canTransitionItemFulfillment("served", "served")).toBe(false);
  });
});

describe("U5 governed fulfillment backend wiring", () => {
  const migration = read("supabase/migrations/20260901000003_unified_pos_fulfillment.sql");

  it("migration ใหม่เพิ่ม RPC ครบ + CHECK prep_status มี ready โดยคง done", () => {
    expect(migration).toContain("unified_pos_derive_order_prep_status");
    expect(migration).toContain("unified_pos_update_item_fulfillment");
    expect(migration).toContain("unified_pos_cancel_table_order");
    expect(migration).toContain("'ready'");
    expect(migration).toContain("'done'");
    expect(migration).toContain("orders_prep_status_ready_check");
  });

  it("RPC ต้อง grant เฉพาะ service_role (ห้าม anon/authenticated)", () => {
    expect(migration).toContain("grant execute on function public.unified_pos_update_item_fulfillment");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("revoke execute on function public.unified_pos_update_item_fulfillment");
  });

  it("types + repository: PrepStatus มี ready และ updateOrderPrepStatus route ผ่าน governed RPC", () => {
    const types = read("src/modules/qr-ordering/types.ts");
    expect(types).toContain('"ready"');

    const repo = read("src/modules/qr-ordering/repository.ts");
    expect(repo).toContain("unified_pos_enabled");
    expect(repo).toContain('rpc("unified_pos_update_item_fulfillment"');

    const action = read("src/app/(dashboard)/qr-orders/actions.ts");
    expect(action).toContain('"ready"');

    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain('ready:');
  });
});

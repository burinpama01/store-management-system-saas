import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readMaybe = (path: string) => {
  const fullPath = join(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
};

describe("cash session (open/close) RPC", () => {
  const migration = read("supabase/migrations/20260607000001_cash_sessions.sql");

  it("defines the cash_sessions table with one-open-per-store guard and RLS", () => {
    expect(migration).toContain("create table if not exists cash_sessions");
    expect(migration).toContain("status in ('open','closed')");
    expect(migration).toContain("cash_sessions_one_open_per_store");
    expect(migration).toContain("where status = 'open'");
    expect(migration).toContain("alter table cash_sessions enable row level security");
    expect(migration).toContain("cash_sessions: deny client insert");
    expect(migration).toContain("cash_sessions: deny client update");
  });

  it("opens a session with cashier guard and rejects a second open session", () => {
    expect(migration).toContain("create or replace function open_cash_session");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("auth_user_role_in_store(v_org_id, p_store_id, 'cashier')");
    expect(migration).toContain("p_opening_float is null or p_opening_float < 0");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("มีรอบเงินสดที่เปิดอยู่แล้ว");
  });

  it("closes a session reconciling counted cash against opening float + POS cash sales", () => {
    expect(migration).toContain("create or replace function close_cash_session");
    expect(migration).toContain("v_session.status <> 'open'");
    expect(migration).toContain("from payments p");
    expect(migration).toContain("join orders o on o.id = p.order_id");
    expect(migration).toContain("p.method = 'cash'");
    expect(migration).toContain("p.status = 'completed'");
    expect(migration).toContain("p.processed_at >= v_session.opened_at");
    expect(migration).toContain("v_session.opening_float + v_cash_sales");
    expect(migration).toContain("round(p_closing_count, 2) - v_expected");
    expect(migration).toContain("status        = 'closed'");
  });

  it("reconciles cash drawer sales from received cash minus change", () => {
    const fixMigration = readMaybe("supabase/migrations/20260623000001_cash_session_net_cash_and_pos_gate.sql");
    const repo = read("src/modules/cashflow/repository.ts");

    expect(`${migration}\n${fixMigration}`).toContain("p.received_amount - p.change_amount");
    expect(`${migration}\n${fixMigration}`).toContain("else p.amount");
    expect(repo).toContain("cashIntoDrawer");
    expect(repo).toContain("payment.received_amount - payment.change_amount");
  });

  it("enforces cashflow.record permission in cash session RPCs", () => {
    const fixMigration = readMaybe("supabase/migrations/20260623000001_cash_session_net_cash_and_pos_gate.sql");

    expect(fixMigration).toContain("create or replace function auth_user_has_permission");
    expect(fixMigration).toContain("membership_permission_overrides");
    expect(fixMigration).toContain("permission_key = p_permission_key");
    expect(fixMigration).toContain("auth_user_has_permission(v_org_id, p_store_id, 'cashflow.record')");
    expect(fixMigration).toContain("auth_user_has_permission(v_session.organization_id, p_store_id, 'cashflow.record')");
  });

  it("requires an open cash session inside the POS cash payment RPC", () => {
    const fixMigration = readMaybe("supabase/migrations/20260623000001_cash_session_net_cash_and_pos_gate.sql");

    expect(fixMigration).toContain("create or replace function close_pos_order_payment");
    expect(fixMigration).toContain("auth_user_has_permission(v_order.organization_id, p_store_id, 'pos.use')");
    expect(fixMigration).toContain("auth_user_has_permission(v_order.organization_id, p_store_id, 'cashflow.record')");
    expect(fixMigration).toContain("v_open_cash_session_id");
    expect(fixMigration).toContain("from cash_sessions");
    expect(fixMigration).toContain("status = 'open'");
    expect(fixMigration).toContain("for update");
    expect(fixMigration).toContain("ต้องเปิดรอบเงินสดก่อนรับเงินสด");
  });

  it("locks RPC execution to authenticated callers only", () => {
    expect(migration).toContain("revoke execute on function open_cash_session(uuid, numeric, text) from public, anon");
    expect(migration).toContain("grant execute on function open_cash_session(uuid, numeric, text) to authenticated");
    expect(migration).toContain("revoke execute on function close_cash_session(uuid, uuid, numeric, text) from public, anon");
    expect(migration).toContain("grant execute on function close_cash_session(uuid, uuid, numeric, text) to authenticated");
  });

  it("wires repository + actions to the RPCs", () => {
    const repo = read("src/modules/cashflow/repository.ts");
    expect(repo).toContain('supabase.rpc("open_cash_session"');
    expect(repo).toContain('supabase.rpc("close_cash_session"');

    const actions = read("src/app/pos/cash-actions.ts");
    expect(actions).toContain('requirePermission("cashflow.record")');
    expect(actions).toContain("openCashSession");
    expect(actions).toContain("closeCashSession");
  });

  it("forces cashiers to open a cash session before taking cash in POS", () => {
    const terminal = read("src/app/pos/PosTerminal.tsx");
    const panel = read("src/app/pos/CashSessionPanel.tsx");
    const page = read("src/app/pos/page.tsx");
    const actions = read("src/app/pos/actions.ts");

    expect(page).toContain('canRecordCashflow={resolved.can("cashflow.record")}');
    expect(terminal).toContain("canRecordCashflow");
    expect(terminal).toContain("cashSessionRequired");
    expect(terminal).toContain("ต้องเปิดรอบเงินสดก่อนรับเงินสด");
    expect(terminal).toContain("forceOpenPrompt={!cashSession && canRecordCashflow}");
    expect(panel).toContain("forceOpenPrompt?: boolean");
    expect(actions).toContain("getOpenCashSession");
    expect(actions).toContain("ต้องเปิดรอบเงินสดก่อนรับเงินสด");
  });
});

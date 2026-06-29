import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("QR customer self-open table (v2)", () => {
  it("migration adds table_open_policy + a guarded, idempotent self-open RPC", () => {
    const sql = read("supabase/migrations/20260629190000_table_open_policy.sql");
    expect(sql).toContain("add column if not exists table_open_policy text not null default 'staff_only'");
    expect(sql).toContain("check (table_open_policy in ('staff_only', 'customer_self'))");
    expect(sql).toContain("create or replace function open_table_session_self");
    // Enforces policy + mode at the DB level.
    expect(sql).toContain("v_mode <> 'table_bound' or v_policy <> 'customer_self'");
    // Idempotent: reuse a still-valid session instead of opening a second one.
    expect(sql).toContain("if v_expires is not null and v_expires > now() then");
    expect(sql).toContain("for update");
    // Must not WRITE current_session_id (FK to buffet_sessions) — à la carte only.
    expect(sql).not.toContain("current_session_id =");
    expect(sql).not.toContain("current_session_id,");
    // Customers never call it directly; only the server (service_role).
    expect(sql).toContain("revoke execute on function open_table_session_self(uuid, uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function open_table_session_self(uuid, uuid) to service_role");
  });

  it("submit action auto-opens the session only for table_bound + customer_self", () => {
    const action = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    // Reads the policy/mode it needs to decide.
    expect(action).toContain("qr_ordering_mode, table_open_policy");
    expect(action).toContain('store.qr_ordering_mode === "table_bound" && store.table_open_policy === "customer_self"');
    // Self-open path calls the RPC; staff_only still rejects when no session.
    expect(action).toContain('supabase.rpc("open_table_session_self"');
    expect(action).toContain("หมดเวลาสั่งอาหารของโต๊ะนี้แล้ว กรุณาแจ้งพนักงาน");
  });

  it("public QR page lets self-open stores browse the menu without a session", () => {
    const page = read("src/app/qr/[storeSlug]/[tableId]/page.tsx");
    expect(page).toContain('store.qrOrderingMode === "table_bound" && store.tableOpenPolicy === "customer_self"');
    expect(page).toContain("sessionActive || canSelfOpen");
    // Don't full-block when the customer can open the table themselves.
    expect(page).toContain("!sessionActive && !musicEligibility.canViewQueue && !canSelfOpen");
    expect(page).toContain("canSelfOpen={canSelfOpen}");
  });

  it("client app shows the self-open CTA and keeps the menu usable", () => {
    const app = read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx");
    expect(app).toContain("const foodTabUsable = foodOrderingEnabled || canSelfOpen");
    expect(app).toContain('!foodOrderingEnabled && canSelfOpen ? "สั่งและเปิดโต๊ะ" : "ส่งออร์เดอร์"');
    expect(app).toContain("!foodTabUsable ?");
  });

  it("store settings validate the policy (table_bound, non-buffet) before saving", () => {
    const action = read("src/app/(dashboard)/settings/store/actions.ts");
    expect(action).toContain('formData.get("tableOpenPolicy") === "customer_self"');
    expect(action).toContain('requestedSelfOpen && qrOrderingMode !== "table_bound"');
    expect(action).toContain("requestedSelfOpen && buffetEnabled");
    expect(action).toContain('const tableOpenPolicy = requestedSelfOpen ? "customer_self" : "staff_only"');
    expect(action).toContain("tableOpenPolicy,");
  });
});

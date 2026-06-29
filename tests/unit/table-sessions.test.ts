import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("timed table sessions (buffet + à la carte QR)", () => {
  const migration = read("supabase/migrations/20260607000005_table_sessions.sql");

  it("adds session window to tables + default duration to stores + RPCs", () => {
    expect(migration).toContain("add column if not exists session_started_at");
    expect(migration).toContain("add column if not exists session_expires_at");
    expect(migration).toContain("add column if not exists dine_in_duration_minutes");
    expect(migration).toContain("create or replace function open_table_session");
    expect(migration).toContain("create or replace function close_table_session");
    expect(migration).toContain("auth_user_role_in_store(v_org_id, p_store_id, 'cashier')");
    expect(migration).toContain("make_interval(mins => p_minutes)");
    expect(migration).toContain("grant execute on function open_table_session(uuid, uuid, integer) to authenticated");
  });

  it("customer QR page + submit action gate ordering on an active session", () => {
    const page = read("src/app/qr/[storeSlug]/[tableId]/page.tsx");
    expect(page).toContain("sessionExpiresAt");
    expect(page).toContain("หมดเวลาสั่งอาหารแล้ว");
    expect(page).toContain("ยังไม่ได้เปิดโต๊ะ");

    const actions = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(actions).toContain("session_expires_at");
    expect(actions).toContain("หมดเวลาสั่งอาหารของโต๊ะนี้แล้ว");
  });

  it("POS opens à la carte tables and buffet sets the window from package duration", () => {
    const posActions = read("src/app/pos/actions.ts");
    expect(posActions).toContain("openTableAction");
    expect(posActions).toContain("closeTableAction");
    expect(posActions).toContain("dineInDurationMinutes");

    const buffet = read("src/app/(dashboard)/buffet/actions.ts");
    expect(buffet).toContain("openTableSession");
    expect(buffet).toContain("durationMinutes");
  });

  it("table-open receipt page renders a QR + valid-until", () => {
    const receipt = read("src/app/table-receipt/page.tsx");
    expect(receipt).toContain("QrCode");
    expect(receipt).toContain("ใช้ได้ถึง");
    // QR URL is built via buildTableQrUrl so session_printed stores embed ?s=<session>.
    expect(receipt).toContain("buildTableQrUrl");
    expect(receipt).toContain("sessionId: table.currentSessionId");
  });
});

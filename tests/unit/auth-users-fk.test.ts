import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = () =>
  readFileSync(join(root, "supabase/migrations/20260601000008_auth_users_foreign_keys.sql"), "utf8");

describe("auth.users foreign keys", () => {
  it("adds explicit auth.users references with the expected delete behavior", () => {
    const sql = migration();

    const expected = [
      ["organizations", "organizations_owner_id_auth_users_fk", "owner_id", "restrict"],
      ["memberships", "memberships_user_id_auth_users_fk", "user_id", "restrict"],
      [
        "membership_permission_overrides",
        "membership_permission_overrides_granted_by_user_id_auth_users_fk",
        "granted_by_user_id",
        "restrict",
      ],
      ["audit_logs", "audit_logs_actor_user_id_auth_users_fk", "actor_user_id", "restrict"],
      ["audit_logs", "audit_logs_target_user_id_auth_users_fk", "target_user_id", "set null"],
      ["orders", "orders_cashier_id_auth_users_fk", "cashier_id", "restrict"],
      ["orders", "orders_voided_by_user_id_auth_users_fk", "voided_by_user_id", "set null"],
      ["payments", "payments_processed_by_user_id_auth_users_fk", "processed_by_user_id", "restrict"],
      ["transactions", "transactions_created_by_user_id_auth_users_fk", "created_by_user_id", "restrict"],
      [
        "cash_ledger_entries",
        "cash_ledger_entries_created_by_user_id_auth_users_fk",
        "created_by_user_id",
        "restrict",
      ],
      ["attendance_records", "attendance_records_user_id_auth_users_fk", "user_id", "restrict"],
      [
        "attendance_records",
        "attendance_records_adjusted_by_user_id_auth_users_fk",
        "adjusted_by_user_id",
        "set null",
      ],
    ];

    for (const [table, constraint, column, onDelete] of expected) {
      expect(sql).toMatch(
        new RegExp(
          `alter table ${table}\\s+add constraint ${constraint}\\s+foreign key \\(${column}\\) references auth\\.users\\(id\\) on delete ${onDelete}`,
          "i",
        ),
      );
    }
  });
});

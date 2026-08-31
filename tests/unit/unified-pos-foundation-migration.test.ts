import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Task U2 — Unified POS Foundation (v0.35.2)
// เป็น lint-level gate เท่านั้น: ตรวจว่า migration + regenerated DB types มี identifier
// ครบตามแผน (Plan/QR Order Voice Unified POS Implementation Plan v2.html — Task U2)
// behavior gate จริงอยู่ที่ pgTAP: supabase/tests/001_unified_pos_foundation.sql (ตามแผน review #17)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const migrationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260831000001_unified_pos_foundation.sql",
);
const typesPath = path.join(repoRoot, "src", "server", "integrations", "supabase", "database.types.ts");

describe("unified-pos-foundation-migration (U2)", () => {
  const migration = readFileSync(migrationPath, "utf8").replace(/\s+/g, " ");

  it("migration มีไฟล์จริงและระบุ task/version ไว้ในหัวไฟล์", () => {
    expect(migration).toContain("Task U2 (v0.35.2)");
  });

  it("มี store flags 3 ตัว (unified_pos_enabled / kitchen_queue_enabled / voice_command_enabled)", () => {
    expect(migration).toContain("unified_pos_enabled");
    expect(migration).toContain("kitchen_queue_enabled");
    expect(migration).toContain("voice_command_enabled");
    expect(migration).toContain("boolean not null default false");
  });

  it("มี orders.revision และ order_items.fulfillment_status / fulfillment_version", () => {
    expect(migration).toContain("revision bigint not null default 0");
    expect(migration).toContain("fulfillment_status text not null default 'new'");
    expect(migration).toContain("fulfillment_version bigint not null default 0");
  });

  it("มี CHECK constraint ของ fulfillment_status ตรงกับ FULFILLMENT_STATUSES ของ U1 contracts", () => {
    expect(migration).toContain("order_items_fulfillment_status_check");
    expect(migration).toContain("fulfillment_status in ('new','preparing','ready','served')");
  });

  it("ห้ามมี 'voided' ใน enum ของ fulfillment_status (canonical void คือ order_items.voided เดิม)", () => {
    expect(migration).not.toMatch(/fulfillment_status in \('new','preparing','ready','served','voided'\)/);
  });

  it("มี trigger 3 ตัวของ unified_pos ครบ (revision / version / parent bump)", () => {
    expect(migration).toContain("unified_pos_orders_revision_bu");
    expect(migration).toContain("unified_pos_items_version_bu");
    expect(migration).toContain("unified_pos_items_parent_bump");
    // trigger function ทุกตัว set search_path = public ตาม convention ของ repo
    const triggerFunctions = migration.match(/create or replace function public\.[a-z_]+\([\s\S]*?\$\$/g) ?? [];
    expect(triggerFunctions.length).toBeGreaterThanOrEqual(3);
    for (const fn of triggerFunctions) {
      expect(fn).toContain("set search_path = public");
    }
  });

  it("มีตาราง unified_pos_operation_receipts + unique (store_id, operation_key)", () => {
    expect(migration).toContain("unified_pos_operation_receipts");
    expect(migration).toContain("unique (store_id, operation_key)");
  });

  it("มี purge function แบบ tombstone (คืน integer, security definer, set search_path)", () => {
    expect(migration).toContain("purge_expired_unified_pos_receipt_payloads()");
    expect(migration).toMatch(/purge_expired_unified_pos_receipt_payloads\(\)[\s\S]*?returns integer/);
    expect(migration).toMatch(/security definer\s*set search_path = public/);
  });

  it("มีตาราง voice_aliases + unique index บน lower(alias_text) ต่อ store", () => {
    expect(migration).toContain("voice_aliases");
    expect(migration).toContain("voice_aliases_store_alias_text_lower_unique");
    expect(migration).toContain("lower(alias_text)");
  });

  it("ห้ามสร้างตารางเก็บ captured phrase/transcript", () => {
    expect(migration).not.toMatch(/create table[^;]*voice_transcripts/);
  });

  it("RLS ตามแผน: receipts อ่านเฉพาะ store member, voice_aliases เขียนเฉพาะ manager+", () => {
    expect(migration).toContain("unified_pos_operation_receipts: store member can read");
    expect(migration).toContain("voice_aliases: store member can read");
    expect(migration).toContain("voice_aliases: manager+ can insert");
    expect(migration).toContain("voice_aliases: manager+ can update");
    expect(migration).toContain("voice_aliases: manager+ can delete");
  });

  it("GRANT: purge เฉพาะ service_role, receipts ไม่ให้ anon", () => {
    expect(migration).toContain("revoke all on public.unified_pos_operation_receipts from anon;");
    expect(migration).toContain(
      "grant execute on function public.purge_expired_unified_pos_receipt_payloads() to service_role;",
    );
  });
});

describe("unified-pos-foundation-database-types (U2)", () => {
  const types = readFileSync(typesPath, "utf8");

  it("database.types.ts มีตารางใหม่ 2 ตารางของ U2", () => {
    expect(types).toContain("unified_pos_operation_receipts: {");
    expect(types).toContain("voice_aliases: {");
  });

  it("database.types.ts มี orders.revision และ store flags 3 ตัว", () => {
    expect(types).toContain("revision: number;");
    expect(types).toContain("unified_pos_enabled: boolean;");
    expect(types).toContain("kitchen_queue_enabled: boolean;");
    expect(types).toContain("voice_command_enabled: boolean;");
  });

  it("database.types.ts มี order_items.fulfillment_status / fulfillment_version", () => {
    expect(types).toContain('fulfillment_status: "new" | "preparing" | "ready" | "served";');
    expect(types).toContain("fulfillment_version: number;");
  });

  it("database.types.ts มี purge function ใน Functions section", () => {
    expect(types).toContain("purge_expired_unified_pos_receipt_payloads: {");
  });
});

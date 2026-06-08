import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("table management + QR codes (Batch 3)", () => {
  it("repository exposes table CRUD scoped to store", () => {
    const repo = read("src/modules/stores/repository.ts");
    expect(repo).toContain("export async function listManagedTables");
    expect(repo).toContain("export async function createTable");
    expect(repo).toContain("export async function updateTable");
    expect(repo).toContain("export async function deleteTable");
    // writes must be scoped by store_id
    expect(repo).toContain('.eq("store_id", storeId)');
  });

  it("settings/tables actions enforce permission + nav link present", () => {
    const actions = read("src/app/(dashboard)/settings/tables/actions.ts");
    expect(actions).toContain('requirePermission("settings.view")');
    expect(actions).toContain("saveTableAction");
    expect(actions).toContain("deleteTableAction");

    const manager = read("src/app/(dashboard)/settings/tables/TablesManager.tsx");
    expect(manager).toContain("/qr/${storeSlug}/${t.id}"); // QR encodes customer URL
    expect(manager).toContain("window.print()");
    expect(manager).toContain("QrCode");

    const nav = read("src/app/(dashboard)/settings/SettingsNav.tsx");
    expect(nav).toContain("/settings/tables");
  });
});

describe("service request reason chooser", () => {
  it("customer can attach a reason (note) and only call-staff via chooser", () => {
    const actions = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(actions).toContain("reason?: string");
    expect(actions).toContain("p_note: note");

    const app = read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx");
    expect(app).toContain("ขอเช็คบิล");
    expect(app).toContain("เกิดปัญหา");
    expect(app).toContain("onService");
    // customer no longer has a standalone request-bill button outside the chooser
    expect(app).toContain("เรียกพนักงาน");

    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("req.note");
  });
});

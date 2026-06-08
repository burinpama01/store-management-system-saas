import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const functionBody = (source: string, name: string) => {
  const start = source.indexOf(`function ${name}`);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
};

describe("public table status monitor", () => {
  it("exposes a store slug based public table route", () => {
    const page = read("src/app/qr/[storeSlug]/tables/page.tsx");

    expect(page).toContain("getStoreBySlug");
    expect(page).toContain("listPublicTables");
    expect(page).toContain("TableStatusBoard");
    expect(page).toContain("storeSlug.length > 100");
  });

  it("public repository limits table monitor to active tables", () => {
    const source = read("src/modules/stores/public-repository.ts");
    const listPublicTables = functionBody(source, "listPublicTables");

    expect(listPublicTables).toContain('.eq("store_id", storeId)');
    expect(listPublicTables).toContain('.eq("is_active", true)');
    expect(listPublicTables).toContain('.eq("qr_enabled", true)');
  });

  it("public QR reads use anon/RLS instead of service role", () => {
    const source = read("src/modules/stores/public-repository.ts");
    const migration = read("supabase/migrations/20260601000002_public_qr_read_policies.sql");
    const getStoreBySlug = functionBody(source, "getStoreBySlug");

    expect(source).toContain("createSupabaseServerClient");
    expect(source).not.toContain("createSupabaseServiceClient");
    expect(getStoreBySlug).toContain('.eq("is_active", true)');
    expect(getStoreBySlug).toContain('.eq("qr_ordering_enabled", true)');
    expect(migration).toContain("to anon");
    expect(migration).toContain("to anon, authenticated");
    expect(migration).toContain('"stores: anon can read active QR stores"');
    expect(migration).toContain('"tables: anon can read active QR tables"');
    expect(migration).toContain('"products: anon can read active QR products"');
    expect(migration).toContain('"modifier_options: anon can read active QR options"');
  });

  it("table status board renders all supported statuses", () => {
    const source = read("src/app/qr/[storeSlug]/tables/TableStatusBoard.tsx");

    for (const status of ["available", "occupied", "reserved", "cleaning"]) {
      expect(source).toContain(status);
    }
    expect(source).toContain("อัปเดตล่าสุด");
  });
});

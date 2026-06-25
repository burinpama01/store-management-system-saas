import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("grocery POS barcode migration", () => {
  it("adds store-scoped product and variant barcode columns for scanner lookup", () => {
    const migration = read("supabase/migrations/20260621010000_grocery_pos_barcode.sql");
    const types = read("src/server/integrations/supabase/database.types.ts");

    expect(migration).toContain("alter table products add column if not exists barcode text");
    expect(migration).toContain("alter table product_variants add column if not exists barcode text");
    expect(migration).toContain("alter table product_variants add column if not exists store_id uuid");
    expect(migration).toContain("set_product_variant_store_id");
    expect(migration).toContain("products_store_barcode_active_idx");
    expect(migration).toContain("product_variants_store_barcode_active_idx");
    expect(migration).toContain("ensure_store_barcode_unique");
    expect(migration).toContain("create table if not exists catalog_barcodes");
    expect(migration).toContain("catalog_barcodes_store_normalized_barcode_idx");
    expect(migration).toContain("sync_store_barcode_registry");
    expect(migration).toContain("alter table catalog_barcodes enable row level security");
    expect(migration).toContain("catalog_barcodes: store member can read");
    expect(migration).toContain("revoke insert, update, delete on catalog_barcodes from authenticated");
    expect(migration).toContain("products_store_barcode_cross_check");
    expect(migration).toContain("product_variants_store_barcode_cross_check");
    expect(types).toContain("barcode: string | null;");
    expect(types).toContain("store_id: string;");
  });
});

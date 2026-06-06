import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readIfExists = (path: string) => {
  try {
    return read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

describe("storage policies", () => {
  it("guards staff-evidence upload path shape before reading user id segment", () => {
    const initial = read("supabase/migrations/20260518000003_storage_buckets.sql");
    const corrective = read("supabase/migrations/20260601000009_storage_policy_path_guards.sql");
    const combined = `${initial}\n${corrective}`;

    expect(combined).toContain("staff-evidence path: <organizationId>/<storeId>/<userId>/<fileName>");
    expect(combined).toContain("array_length(storage.foldername(name), 1) = 3");
    expect(combined).toContain("(storage.foldername(name))[3] = auth.uid()::text");
    expect(corrective).toContain('drop policy if exists "staff-evidence: staff can upload own"');
    expect(corrective).toContain('create policy "staff-evidence: staff can upload own"');
  });

  it("allows store-scoped managers to write product images only for their store path", () => {
    const initial = read("supabase/migrations/20260518000003_storage_buckets.sql");
    const corrective = readIfExists("supabase/migrations/20260601000010_product_images_store_policies.sql");
    const combined = `${initial}\n${corrective}`;
    const productPolicies = combined.slice(
      combined.indexOf("-- product-images policies"),
      combined.indexOf("-- receipt-assets policies"),
    );

    expect(combined).toContain("Object paths: organizationId/storeId/productId/filename");
    expect(combined).toContain("array_length(storage.foldername(name), 1) = 3");
    expect(combined).toContain("from stores s");
    expect(combined).toContain("s.organization_id::text = (storage.foldername(name))[1]");
    expect(combined).toContain("s.id::text = (storage.foldername(name))[2]");
    expect(combined).toContain("auth_user_role_in_store(s.organization_id, s.id, 'manager')");
    expect(corrective).toContain('drop policy if exists "product-images: manager+ can upload"');
    expect(corrective).toContain('drop policy if exists "product-images: manager+ can update"');
    expect(corrective).toContain('drop policy if exists "product-images: manager+ can delete"');
    expect(productPolicies).not.toContain("where auth_user_role_in_org(o.id, 'manager')");
  });
});

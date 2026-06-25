import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("shared ImageUpload uploads server-side (avoids fragile browser storage RLS)", () => {
  it("ImageUpload calls the server action instead of the browser storage client", () => {
    const comp = read("src/shared/components/ui/ImageUpload.tsx");
    expect(comp).toContain("uploadStoreImageAction");
    // no longer uploads directly from the browser (which hit storage RLS failures)
    expect(comp).not.toContain("getSupabaseBrowserClient");
    expect(comp).not.toContain('.from("product-images")');
  });

  it("the server action uses the service client + session-derived path + permission check", () => {
    const action = read("src/modules/storage/image-actions.ts");
    expect(action).toContain('"use server"');
    expect(action).toContain("createSupabaseServiceClient");
    expect(action).toContain('requirePermission("catalog.manage")');
    expect(action).toContain("resolveCurrentStore");
    // path derived from the resolved store context, never trusted from the client
    expect(action).toContain("`${ctx.organizationId}/${ctx.storeId}/");
    expect(action).toContain('.from("product-images")');
    expect(action).toContain("getPublicUrl");
  });
});

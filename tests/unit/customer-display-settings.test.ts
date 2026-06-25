import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("customer display ad settings", () => {
  it("adds a gated customer display settings tab and page", () => {
    const layout = read("src/app/(dashboard)/settings/layout.tsx");
    const page = read("src/app/(dashboard)/settings/customer-display/page.tsx");
    const actions = read("src/app/(dashboard)/settings/customer-display/actions.ts");
    const form = read("src/app/(dashboard)/settings/customer-display/CustomerDisplaySettingsForm.tsx");

    expect(layout).toContain("/settings/customer-display");
    expect(layout).toContain("customerDisplay");
    expect(layout).toContain("getOrganizationBillingState");
    expect(layout).toContain("canUseFeature(billingState, tab.featureKey)");
    expect(page).toContain("getCustomerDisplaySettings");
    expect(page).toContain("requireFeature(\"customerDisplay\")");
    expect(actions).toContain("upsertCustomerDisplaySettingsAction");
    expect(actions).toContain("requirePermission(\"settings.manage_store\")");
    expect(form).toContain("แบ่งครึ่งบน/ล่าง");
    expect(form).toContain("ภาพสไลด์");
    expect(form).toContain("วิดีโอ / ภาพเคลื่อนไหว");
    expect(form).toContain("topSlidesJson");
    expect(form).toContain("bottomSlidesJson");
    expect(form).toContain("CUSTOMER_DISPLAY_SLIDE_LIMIT");
    expect(form).toContain("slides.length >= CUSTOMER_DISPLAY_SLIDE_LIMIT");
    expect(form).toContain("ขนาดรูปภาพที่แนะนำ");
    expect(form).toContain("1080 x 1920 px");
    expect(form).toContain("1200 x 900 px");
    expect(form).toContain("cover");
    expect(form).toContain("contain");
  });

  it("lets customer display slides upload image and video files into store-scoped storage", () => {
    const page = read("src/app/(dashboard)/settings/customer-display/page.tsx");
    const actions = read("src/app/(dashboard)/settings/customer-display/actions.ts");
    const form = read("src/app/(dashboard)/settings/customer-display/CustomerDisplaySettingsForm.tsx");
    const policy = read("supabase/migrations/20260601000010_product_images_store_policies.sql");
    const customerDisplayStoragePolicy = read("supabase/migrations/20260624235900_customer_display_storage_permission_policy.sql");

    expect(page).toContain("organizationId={ctx.organizationId}");
    expect(page).toContain("storeId={ctx.storeId}");
    expect(actions).toContain("createCustomerDisplayMediaUploadAction");
    expect(actions).toContain("requirePermission(\"settings.manage_store\")");
    expect(actions).toContain("createSupabaseServiceClient");
    expect(actions).toContain("createSignedUploadUrl(path)");
    expect(actions).toContain("input.organizationId !== ctx.organizationId || input.storeId !== ctx.storeId");
    expect(form).toContain("getSupabaseBrowserClient");
    expect(form).toContain("createCustomerDisplayMediaUploadAction");
    expect(form).toContain('accept="image/*,video/*"');
    expect(form).toContain('.from("product-images")');
    expect(form).toContain("uploadToSignedUrl(signedUpload.path, signedUpload.token");
    expect(form).not.toContain(".upload(path, uploadBody");
    expect(form).toContain("customer-display");
    expect(policy).toContain("array_length(storage.foldername(name), 1) = 3");
    expect(actions).toContain("const fileName = `${randomUUID()}.${extension}`;");
    expect(actions).toContain("const path = `${ctx.organizationId}/${ctx.storeId}/customer-display/${fileName}`;");
    expect(form).not.toContain("customer-display/${crypto.randomUUID()}/media");
    expect(form).toContain("URL จะถูกเติมหลังอัพโหลดสำเร็จ");
    expect(form).toContain("const [uploadingCount, setUploadingCount]");
    expect(form).toContain("const isUploading = uploadingCount > 0");
    expect(form).toContain("loading={isPending || isUploading}");
    expect(form).toContain("onUploadStart");
    expect(form).toContain("onUploadFinish");
    expect(form).toContain("กำลังอัพโหลดไฟล์...");
    expect(form).toContain('const mediaType: CustomerDisplayMediaType = file.type.startsWith("video/") ? "video" : "image"');
    expect(form).toContain("shouldCompressCustomerDisplayImage(file)");
    expect(form).toContain('file.name.toLowerCase().endsWith(".apng")');
    expect(form).toContain('case "image/apng":');
    expect(form).toContain('return "apng";');
    expect(form).toContain('id: `${slot}-${crypto.randomUUID()}`');
    expect(customerDisplayStoragePolicy).toContain('"product-images: settings managers can upload customer display"');
    expect(customerDisplayStoragePolicy).toContain("(storage.foldername(name))[3] = 'customer-display'");
    expect(customerDisplayStoragePolicy).toContain("auth_user_has_permission(s.organization_id, s.id, 'settings.manage_store')");
  });

  it("stores customer display media settings as store-scoped typed config", () => {
    const repository = read("src/modules/settings/repository.ts");
    const types = read("src/modules/settings/customer-display.ts");
    const migration = read("supabase/migrations/20260624143000_customer_display_settings.sql");
    const dbTypes = read("src/server/integrations/supabase/database.types.ts");

    expect(types).toContain("CustomerDisplayAdLayout");
    expect(types).toContain("CustomerDisplayAdSlide");
    expect(types).toContain("CustomerDisplayMediaType");
    expect(types).toContain("normalizeCustomerDisplaySettingsInput");
    expect(types).toContain("mediaType: CustomerDisplayMediaType");
    expect(types).toContain("slot: CustomerDisplayAdSlot");

    expect(repository).toContain("getCustomerDisplaySettings");
    expect(repository).toContain("upsertCustomerDisplaySettings");
    expect(repository).toContain(".from(\"customer_display_settings\")");
    expect(repository).toContain("store_id: storeId");
    expect(repository).toContain("organization_id: organizationId");

    expect(migration).toContain("create table if not exists customer_display_settings");
    expect(migration).toContain("unique (store_id)");
    expect(migration).toContain("ad_layout text not null default 'single'");
    expect(migration).toContain("top_slides jsonb not null default '[]'");
    expect(migration).toContain("bottom_slides jsonb not null default '[]'");
    expect(migration).toContain("customer_display_settings: manager+ can write");
    expect(migration).toContain("auth_user_has_permission(organization_id, store_id, 'settings.manage_store')");
    expect(migration).not.toContain("auth_user_role_in_store(organization_id, store_id, 'manager')");
    expect(dbTypes).toContain("customer_display_settings:");
  });

  it("renders configured split slots, slides, images, and video on the customer display", () => {
    const normalDisplayPage = read("src/app/pos/display/page.tsx");
    const groceryDisplayPage = read("src/app/pos/grocery/display/page.tsx");
    const screen = read("src/app/pos/grocery/display/CustomerDisplayScreen.tsx");
    const actions = read("src/app/(dashboard)/settings/customer-display/actions.ts");

    expect(normalDisplayPage).toContain("getCustomerDisplaySettings");
    expect(normalDisplayPage).toContain("adSettings={settingsRes.data");
    expect(groceryDisplayPage).toContain("getCustomerDisplaySettings");
    expect(groceryDisplayPage).toContain("adSettings={settingsRes.data");

    expect(screen).toContain("adSettings");
    expect(screen).toContain("customer-display-ad-split");
    expect(screen).toContain("customer-display-ad-slot");
    expect(screen).toContain("<video");
    expect(screen).toContain("<img");
    expect(screen).toContain("setInterval");
    expect(screen).toContain("slideIntervalSeconds");
    expect(screen).toContain("if (slides.length === 0) return [];");
    expect(screen).toContain("slot.slides.length > 0");
    expect(actions).toContain("topSlides.length > CUSTOMER_DISPLAY_SLIDE_LIMIT");
    expect(actions).toContain("bottomSlides.length > CUSTOMER_DISPLAY_SLIDE_LIMIT");
  });
});

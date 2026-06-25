"use server";

import { randomUUID } from "node:crypto";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Upload a store image (logo / product / receipt footer) to the public product-images bucket.
 *
 * Runs server-side with the service client so it is not subject to the fragile browser-session
 * storage RLS check — authorization is enforced here via the session + permission, and the path
 * is derived from the resolved store context (never trusted from the client).
 */
export async function uploadStoreImageAction(
  formData: FormData,
): Promise<{ url: string | null; error: string | null }> {
  try {
    // manager+ — every surface that renders an image upload is already manager+/owner gated.
    await requirePermission("catalog.manage");
    const user = await getCurrentUser();
    if (!user) return { url: null, error: "ไม่มีสิทธิ์เข้าถึง" };
    const { organizations, stores, memberships } = await getUserStores();
    const ctx = await resolveCurrentStore(stores, organizations, memberships);
    if (!ctx) return { url: null, error: "ไม่พบร้านค้าที่ใช้งาน" };

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { url: null, error: "ไม่พบไฟล์รูป" };
    if (file.size > MAX_BYTES) return { url: null, error: "ไฟล์รูปใหญ่เกินไป (เกิน 5MB)" };
    const contentType = file.type && file.type.startsWith("image/") ? file.type : "image/jpeg";

    const buffer = Buffer.from(await file.arrayBuffer());
    const path = `${ctx.organizationId}/${ctx.storeId}/${randomUUID()}/image.jpg`;
    const supabase = await createSupabaseServiceClient();
    const { error } = await supabase.storage
      .from("product-images")
      .upload(path, buffer, { contentType, upsert: false });
    if (error) return { url: null, error: error.message };

    const { data } = supabase.storage.from("product-images").getPublicUrl(path);
    return { url: data.publicUrl, error: null };
  } catch (e) {
    return { url: null, error: e instanceof Error ? e.message : "อัปโหลดไม่สำเร็จ" };
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions, requireFeature } from "@/modules/auth/guards";
import { createApiKey, revokeApiKey } from "@/modules/api-keys/repository";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createApiKeyAction(
  name: string,
): Promise<{ plaintext: string | null; error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("settings.manage_store")) return { plaintext: null, error: "ไม่มีสิทธิ์" };
    await requireFeature("apiIntegration");

    const trimmed = (name ?? "").trim();
    if (!trimmed) return { plaintext: null, error: "กรุณาตั้งชื่อ API key" };
    if (trimmed.length > 80) return { plaintext: null, error: "ชื่อยาวเกินไป" };

    const result = await createApiKey(ctx.organizationId, trimmed, user.id);
    if (!result.ok) return { plaintext: null, error: result.error };
    revalidatePath("/settings/integrations");
    return { plaintext: result.plaintext, error: null };
  } catch (e) {
    return { plaintext: null, error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function revokeApiKeyAction(id: string): Promise<{ error: string | null }> {
  try {
    const { ctx, resolved } = await getResolvedCurrentPermissions();
    if (!resolved.can("settings.manage_store")) return { error: "ไม่มีสิทธิ์" };
    await requireFeature("apiIntegration");
    if (!UUID_RE.test(id)) return { error: "ID ไม่ถูกต้อง" };

    const result = await revokeApiKey(ctx.organizationId, id);
    if (!result.ok) return { error: result.error };
    revalidatePath("/settings/integrations");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

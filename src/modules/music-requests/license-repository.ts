import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { MusicLicenseStatus } from "@/modules/stores/types";
import type { Database } from "@/server/integrations/supabase/database.types";

type StoreUpdate = Database["public"]["Tables"]["stores"]["Update"];

export interface MusicLicenseView {
  storeId: string;
  storeName: string;
  organizationId: string;
  musicRequestEnabled: boolean;
  musicLicenseStatus: MusicLicenseStatus;
  musicLicenseApprovedAt?: string;
  musicLicenseNote?: string;
}

/** Platform-admin view of every active store's music license state. */
export async function listMusicLicenses() {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("stores")
    .select(
      "id, name, organization_id, music_request_enabled, music_license_status, music_license_approved_at, music_license_note",
    )
    .eq("is_active", true)
    .order("music_license_status", { ascending: true })
    .order("name", { ascending: true });
  if (error) return { data: [] as MusicLicenseView[], error: mapError(error) };
  const rows: MusicLicenseView[] = (data ?? []).map((row) => ({
    storeId: row.id,
    storeName: row.name,
    organizationId: row.organization_id,
    musicRequestEnabled: row.music_request_enabled,
    musicLicenseStatus: row.music_license_status,
    musicLicenseApprovedAt: row.music_license_approved_at ?? undefined,
    musicLicenseNote: row.music_license_note ?? undefined,
  }));
  return { data: rows, error: null };
}

/**
 * Platform admin sets a store's music license. Approving stamps the approval
 * time; any non-approved status also force-disables the store music toggle so
 * customers can't submit while unlicensed.
 */
export async function updateMusicLicense(
  storeId: string,
  status: MusicLicenseStatus,
  note: string | null,
) {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const patch: StoreUpdate = {
    music_license_status: status,
    music_license_note: note,
    music_license_approved_at: status === "approved" ? now : null,
    updated_at: now,
  };
  if (status !== "approved") patch.music_request_enabled = false;

  const { error } = await supabase.from("stores").update(patch).eq("id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

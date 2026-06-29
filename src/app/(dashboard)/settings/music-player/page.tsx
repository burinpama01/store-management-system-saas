import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getStore } from "@/modules/stores/repository";
import { getMusicPlayerSettings } from "@/modules/music-requests/repository";
import { MusicPlayerSettingsForm } from "./MusicPlayerSettingsForm";

export const dynamic = "force-dynamic";

export default async function MusicPlayerSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const billing =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const storeRes = await getStore(ctx.storeId);
  const store = storeRes.data;

  // Same gate as the music feature: Enterprise + approved license.
  if (!getPlanFeatures(billing).musicRequest || !store || store.musicLicenseStatus !== "approved") {
    redirect("/settings");
  }

  const settingsRes = await getMusicPlayerSettings(ctx.storeId, ctx.organizationId);

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">เครื่องเล่นเพลง</h1>
          <p className="page-kicker">ตั้งค่า auto-player, เพลงพื้นฐาน, โดเนทแซงคิว</p>
        </div>
      </div>
      <MusicPlayerSettingsForm
        settings={settingsRes.data!}
        storeSlug={store.slug}
        canEdit={resolved.can("settings.manage_store")}
      />
    </div>
  );
}

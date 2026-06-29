import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getStore } from "@/modules/stores/repository";
import { listStoreMusicQueue } from "@/modules/music-requests/repository";
import { MusicRequestsBoard } from "./MusicRequestsBoard";

export const dynamic = "force-dynamic";

export default async function MusicRequestsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("orders.manage_qr")) redirect("/dashboard");

  const storeRes = await getStore(ctx.storeId);
  const store = storeRes.data;
  const billing =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billing);

  // Enterprise + approved license + store music toggle (mirrors the nav gate).
  if (!features.musicRequest || !store || store.musicLicenseStatus !== "approved") {
    redirect("/dashboard");
  }

  const res = await listStoreMusicQueue(ctx.storeId);

  return (
    <MusicRequestsBoard
      initialRequests={res.data ?? []}
      musicEnabled={store.musicRequestEnabled}
    />
  );
}

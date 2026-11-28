import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCustomerDisplaySettings } from "@/modules/settings/repository";
import { withLiveStoreAds } from "@/modules/ad-self-serve/server";
import { CustomerDisplayScreen } from "../grocery/display/CustomerDisplayScreen";

export const dynamic = "force-dynamic";

export default async function PosCustomerDisplayPage() {
  const { ctx } = await getResolvedCurrentPermissions();
  await requirePermission("pos.use");
  await requireFeature("customerDisplay");
  const settingsRes = await getCustomerDisplaySettings(ctx.storeId, ctx.organizationId);
  // โฆษณาที่ลูกค้าลงผ่าน QR (กำลังแสดง) สลับกับโฆษณาร้าน 1:1
  const adSettings = await withLiveStoreAds(settingsRes.data, ctx.storeId, ctx.organizationId);
  return <CustomerDisplayScreen adSettings={adSettings} />;
}

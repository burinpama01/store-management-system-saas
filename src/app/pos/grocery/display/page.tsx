import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCustomerDisplaySettings } from "@/modules/settings/repository";
import { CustomerDisplayScreen } from "./CustomerDisplayScreen";

export default async function GroceryCustomerDisplayPage() {
  const { ctx } = await getResolvedCurrentPermissions();
  await requirePermission("pos.use");
  await requireFeature("customerDisplay");

  const settingsRes = await getCustomerDisplaySettings(ctx.storeId, ctx.organizationId);
  return <CustomerDisplayScreen adSettings={settingsRes.data} />;
}

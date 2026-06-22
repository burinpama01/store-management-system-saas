import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { CustomerDisplayScreen } from "../grocery/display/CustomerDisplayScreen";

export const dynamic = "force-dynamic";

export default async function PosCustomerDisplayPage() {
  await requirePermission("pos.use");
  await requireFeature("customerDisplay");
  return <CustomerDisplayScreen />;
}

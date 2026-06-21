import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { CustomerDisplayScreen } from "./CustomerDisplayScreen";

export default async function GroceryCustomerDisplayPage() {
  await requirePermission("pos.use");
  await requireFeature("customerDisplay");

  return <CustomerDisplayScreen />;
}

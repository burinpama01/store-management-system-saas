import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { listBuffetPackages } from "@/modules/buffet/repository";
import { BuffetPackageSettings } from "./BuffetPackageSettings";

export const dynamic = "force-dynamic";

export default async function BuffetSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!getPlanFeatures(billingState).buffetManagement) {
    return (
      <div className="page-shell">
        <div className="panel max-w-xl p-6">
          <h1 className="page-title">ตั้งค่าบุฟเฟต์</h1>
          <p className="page-kicker">โหมดบุฟเฟต์ถูกจำกัดในแพ็กเกจปัจจุบัน — อัปเกรดเป็น Standard ขึ้นไปเพื่อใช้งาน</p>
        </div>
      </div>
    );
  }

  const packages = await listBuffetPackages(ctx.storeId, true);
  return <BuffetPackageSettings packages={packages} canManage={resolved.can("settings.manage_store")} />;
}

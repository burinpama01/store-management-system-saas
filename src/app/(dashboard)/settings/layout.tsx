import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { SettingsNav } from "./SettingsNav";
import { buildSettingsTabs } from "./settings-tabs";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  const billingState = await getOrganizationBillingState(resolved.organizationId) ?? DEFAULT_BILLING_STATE;
  const settingsTabs = buildSettingsTabs(resolved, billingState);
  if (settingsTabs.length === 0) redirect("/dashboard");

  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">ตั้งค่า</h1>
          <p className="page-kicker">จัดการร้านค้า ทีมงาน ใบเสร็จ และสิทธิ์การใช้งาน</p>
        </div>
      </div>
      <SettingsNav tabs={settingsTabs} />
      {children}
    </div>
  );
}

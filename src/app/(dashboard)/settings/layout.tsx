import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import type { ResolvedPermissions } from "@/modules/tenants/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, canUseFeature, type BillingState } from "@/modules/billing/types";
import { SettingsNav, type SettingsTab } from "./SettingsNav";

export const dynamic = "force-dynamic";

export function buildSettingsTabs(resolved: ResolvedPermissions, billingState: BillingState = DEFAULT_BILLING_STATE): SettingsTab[] {
  const tabs: SettingsTab[] = [];

  if (resolved.can("settings.manage_store")) {
    tabs.push({ href: "/settings/store", label: "ร้านค้า" });
    tabs.push({ href: "/settings/branches", label: "สาขา" });
  }
  if (resolved.can("users.manage") || resolved.can("permissions.manage")) {
    tabs.push({ href: "/settings/team", label: "ทีมงาน" });
  }
  if (resolved.can("settings.manage_store")) {
    tabs.push(
      { href: "/settings/tables", label: "โต๊ะ & QR" },
      { href: "/settings/kitchen", label: "Kitchen" },
      { href: "/settings/buffet", label: "บุฟเฟต์" },
      { href: "/settings/customer-display", label: "จอลูกค้า", featureKey: "customerDisplay" },
    );
  }
  if (resolved.can("settings.manage_store") || resolved.can("settings.manage_printer")) {
    tabs.push({ href: "/settings/receipt", label: "เครื่องพิมพ์" });
  }
  if (resolved.can("billing.manage")) {
    tabs.push({ href: "/settings/billing", label: "แพ็กเกจ" });
  }
  if (resolved.can("notifications.manage")) {
    tabs.push({ href: "/settings/notifications", label: "Notifications" });
  }

  return tabs.filter((tab) => !tab.featureKey || canUseFeature(billingState, tab.featureKey));
}

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

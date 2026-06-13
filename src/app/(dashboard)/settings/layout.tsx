import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import type { ResolvedPermissions } from "@/modules/tenants/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { SettingsNav, type SettingsTab } from "./SettingsNav";

export const dynamic = "force-dynamic";

export function buildSettingsTabs(resolved: ResolvedPermissions): SettingsTab[] {
  const tabs: SettingsTab[] = [{ href: "/settings/store", label: "ร้านค้า" }];

  if (resolved.can("users.manage") || resolved.can("permissions.manage")) {
    tabs.push({ href: "/settings/team", label: "ทีมงาน" });
  }
  if (resolved.can("settings.manage_store")) {
    tabs.push(
      { href: "/settings/tables", label: "โต๊ะ & QR" },
      { href: "/settings/receipt", label: "ใบเสร็จ" },
      { href: "/settings/buffet", label: "บุฟเฟต์" },
    );
  }
  if (resolved.can("billing.manage")) {
    tabs.push({ href: "/settings/billing", label: "แพ็กเกจ" });
  }
  if (resolved.can("notifications.manage")) {
    tabs.push({ href: "/settings/notifications", label: "Notifications" });
  }

  return tabs;
}

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  const settingsTabs = buildSettingsTabs(resolved);

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

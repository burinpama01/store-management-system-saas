import type { ResolvedPermissions } from "@/modules/tenants/types";
import { DEFAULT_BILLING_STATE, canUseFeature, type BillingState } from "@/modules/billing/types";
import type { SettingsTab } from "./SettingsNav";

export function buildSettingsTabs(
  resolved: ResolvedPermissions,
  billingState: BillingState = DEFAULT_BILLING_STATE,
): SettingsTab[] {
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
      { href: "/settings/voice", label: "สั่งงานด้วยเสียง" },
      { href: "/settings/buffet", label: "บุฟเฟต์" },
      { href: "/settings/customer-display", label: "จอลูกค้า", featureKey: "customerDisplay" },
      { href: "/settings/music-player", label: "เครื่องเล่นเพลง", featureKey: "musicRequest" },
      { href: "/settings/integrations", label: "API", featureKey: "apiIntegration" },
      { href: "/settings/connect", label: "เดลิเวอรี (JDC)", featureKey: "apiIntegration" },
    );
  }
  if (resolved.can("settings.manage_store") || resolved.can("settings.manage_printer")) {
    tabs.push({ href: "/settings/receipt", label: "เครื่องพิมพ์" });
    tabs.push({ href: "/settings/print-hub", label: "Print Hub" });
    tabs.push({ href: "/settings/devices", label: "อุปกรณ์นี้" });
  }
  if (resolved.can("billing.manage")) {
    tabs.push({ href: "/settings/billing", label: "แพ็กเกจ" });
  }
  if (resolved.can("notifications.manage")) {
    tabs.push({ href: "/settings/notifications", label: "Notifications" });
  }

  return tabs.filter((tab) => !tab.featureKey || canUseFeature(billingState, tab.featureKey));
}

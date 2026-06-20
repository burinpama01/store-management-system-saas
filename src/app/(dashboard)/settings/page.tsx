import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { buildSettingsTabs } from "./layout";

export default async function SettingsPage() {
  const { resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const [firstTab] = buildSettingsTabs(resolved);
  redirect(firstTab?.href ?? "/dashboard");
}

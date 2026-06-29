import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { listApiKeys } from "@/modules/api-keys/repository";
import { IntegrationsManager } from "./IntegrationsManager";

export const dynamic = "force-dynamic";

export default async function IntegrationsSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "apiIntegration")) {
    return (
      <div className="panel p-4">
        <p className="text-sm font-bold text-[var(--color-text-primary)]">API Integration</p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          การเชื่อมต่อ API ใช้ได้เฉพาะแพ็กเกจ Enterprise — ติดต่อทีมงานเพื่ออัปเกรด
        </p>
      </div>
    );
  }

  const keys = await listApiKeys(ctx.organizationId);
  return <IntegrationsManager keys={keys} />;
}

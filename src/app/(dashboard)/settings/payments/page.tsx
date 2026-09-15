import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { listProviderConfigsPublic } from "@/modules/payments/repository";
import { PaymentIntegrationsManager } from "./PaymentIntegrationsManager";

export const dynamic = "force-dynamic";

export default async function PaymentsSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  if (!canUseFeature(billingState, "byoPaymentGateway")) {
    return (
      <div className="panel p-4">
        <p className="text-sm font-bold text-[var(--color-text-primary)]">
          ชำระเงินลูกค้า (Payment Gateway)
        </p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          ฟีเจอร์นี้ใช้ได้ตั้งแต่แพ็กเกจ Premium / Business (เลือกฟีเจอร์) / Enterprise
          — ไม่เกี่ยวกับการชำระค่าสมาชิก StoreOS ที่หน้าแพ็กเกจ
        </p>
      </div>
    );
  }

  const configsRes = await listProviderConfigsPublic(ctx.storeId);
  return <PaymentIntegrationsManager configs={configsRes.data ?? []} />;
}

import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { listProviderConfigsPublic } from "@/modules/payments/repository";
import {
  buildTrueMoneyWebhookUrl,
  listTrueMoneyManualPaymentsForStore,
} from "@/modules/payments/service";
import { buildBeamWebhookUrl, listBeamPaymentsForStore } from "@/modules/payments/beam-service";
import { BeamIntegrationCard } from "./BeamIntegrationCard";
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

  const [configsRes, paymentsRes, beamHistory] = await Promise.all([
    listProviderConfigsPublic(ctx.storeId),
    listTrueMoneyManualPaymentsForStore(ctx.storeId, { limit: 30 }),
    listBeamPaymentsForStore(ctx.storeId, 30),
  ]);
  const configs = configsRes.data ?? [];
  const beamConfig = configs.find((c) => c.providerKey === "beam" && c.mode === "open_api") ?? null;
  return (
    <div className="space-y-4">
      <BeamIntegrationCard
        config={beamConfig}
        webhookUrl={buildBeamWebhookUrl(ctx.storeId)}
        history={beamHistory}
      />
      <PaymentIntegrationsManager
        configs={configs}
        recentPayments={paymentsRes.data ?? []}
        storeId={ctx.storeId}
        webhookUrl={buildTrueMoneyWebhookUrl(ctx.storeId)}
      />
    </div>
  );
}

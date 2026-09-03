import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { hasBillingAccess } from "@/modules/billing/pricing";
import { isExpiringState } from "@/modules/billing/types";
import { getBusinessPriceMap, getFreeTrialEligibility, listBillingPrices } from "@/modules/billing/pricing-repository";
import { isSlip2goConfigured } from "@/modules/billing/slip2go";
import { listEnterpriseRequestsForOrg } from "@/modules/enterprise/repository";
import { BillingManager } from "./BillingManager";

export const dynamic = "force-dynamic";

export default async function BillingSettingsPage() {
  const { ctx, user, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) {
    // ห้าม redirect ไป /dashboard: ด่านบิลใน guards จะเด้งกลับมาที่นี่ทันที
    // กลายเป็นวนไม่จบ = จอขาวสำหรับพนักงานทุกครั้งที่แพ็กเกจหมดอายุ
    const state = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (hasBillingAccess(state)) redirect("/dashboard");
    return <BillingLockedNotice orgName={ctx.orgName} />;
  }

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const settings = await getPlatformSettings();
  const prices = await listBillingPrices();
  const businessPrices = await getBusinessPriceMap();
  const freeTrial = await getFreeTrialEligibility(ctx.organizationId, user.id);
  const enterpriseRequests = await listEnterpriseRequestsForOrg(ctx.organizationId);
  const latestEnterpriseRequest = enterpriseRequests[0] ?? null;

  const active = hasBillingAccess(billingState);

  return (
    <BillingManager
      orgName={ctx.orgName}
      plan={billingState.plan}
      currentPeriodEnd={billingState.currentPeriodEnd}
      isActive={active}
      prices={prices}
      businessPrices={businessPrices}
      currentBusiness={billingState.business ?? null}
      canManage={resolved.can("billing.manage")}
      paymentConfigured={Boolean(settings.promptpayId || settings.promptpayStaticPayload)}
      recipientName={settings.promptpayName}
      slipVerificationReady={isSlip2goConfigured()}
      promoTrial={billingState.promoTrial === true}
      expires={isExpiringState(billingState)}
      freeTrialAvailable={freeTrial.available}
      freeTrialEndsAt={freeTrial.campaignEndsAt}
      enterpriseRequest={
        latestEnterpriseRequest
          ? { status: latestEnterpriseRequest.status, createdAt: latestEnterpriseRequest.createdAt }
          : null
      }
    />
  );
}

/** พนักงานที่ไม่มีสิทธิ์ดูการเรียกเก็บเงิน แต่แพ็กเกจหมดอายุ — บอกให้ไปตามเจ้าของร้าน */
function BillingLockedNotice({ orgName }: Readonly<{ orgName: string }>) {
  return (
    <div className="page-shell">
      <div className="page-header">
        <div>
          <h1 className="page-title">แพ็กเกจหมดอายุ</h1>
          <p className="page-kicker">{orgName}</p>
        </div>
      </div>
      <section className="panel max-w-xl p-5">
        <p className="text-sm text-[var(--ink-2)]">
          แพ็กเกจของร้านหมดอายุหรือยังไม่ได้ชำระเงิน จึงใช้งานระบบต่อไม่ได้ชั่วคราว
        </p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          บัญชีของคุณไม่มีสิทธิ์จัดการการชำระเงิน กรุณาแจ้งเจ้าของร้านหรือผู้จัดการให้ต่ออายุแพ็กเกจ
        </p>
      </section>
    </div>
  );
}

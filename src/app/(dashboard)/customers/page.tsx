import { redirect } from "next/navigation";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { getActiveMemberPortalLinkForStore } from "@/modules/customers/member-repository";
import { listCustomersForStore } from "@/modules/customers/repository";
import { getLoyaltySettingsForStore, listLoyaltyRewardsForStore } from "@/modules/loyalty/repository";
import { listProducts } from "@/modules/catalog/repository";
import { listCouponsForStore } from "@/modules/promotions/repository";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { CustomerLoyaltyManager } from "./CustomerLoyaltyManager";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const customerSearch = (q ?? "").trim().slice(0, 80);
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  // Customer/loyalty management is a manager+ surface; cashiers still use customers at POS checkout.
  if (!resolved.can("catalog.manage")) redirect("/dashboard");

  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  const canManageCustomers = resolved.can("pos.use") && features.loyaltyPoints;
  const canManageCoupons = resolved.can("catalog.manage") && features.couponManagement;
  const canManageLoyaltySettings = resolved.can("settings.manage_store") && features.loyaltyPoints;
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await createSupabaseServerClient();

  const [customersRes, couponsRes, loyaltySettingsRes, rewardsRes, portalLinkRes, productsRes, storeRes] =
    await Promise.all([
      features.loyaltyPoints
        ? listCustomersForStore(ctx.storeId, {
            includeInactive: true,
            search: customerSearch,
            // ค้นหาแล้วเจาะจงกว่า จึงคืนได้มากขึ้นโดยไม่ทำให้หน้าหนัก
            limit: customerSearch ? 250 : 100,
          })
        : Promise.resolve({ data: [], error: null, total: 0, truncated: false }),
      features.couponManagement
        ? listCouponsForStore(ctx.storeId, { includeInactive: true })
        : Promise.resolve({ data: [], error: null }),
      features.loyaltyPoints
        ? getLoyaltySettingsForStore(ctx.storeId, ctx.organizationId)
        : Promise.resolve({ data: null, error: null }),
      features.loyaltyPoints
        ? listLoyaltyRewardsForStore(ctx.storeId, { includeInactive: true })
        : Promise.resolve({ data: [], error: null }),
      features.loyaltyPoints
        ? getActiveMemberPortalLinkForStore(ctx.storeId)
        : Promise.resolve({ data: null, error: null }),
      features.loyaltyPoints
        ? listProducts(ctx.storeId)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("stores").select("slug").eq("id", ctx.storeId).maybeSingle(),
    ]);
  const rewardProducts = (productsRes.data ?? [])
    .filter((product) => product.isActive)
    .map((product) => ({
      id: product.id,
      name: product.name,
      basePrice: product.basePrice,
      hasVariants: product.variants.length > 0,
    }));
  const storeSlug = storeRes.data?.slug ?? null;
  const memberPortalUrl =
    origin && storeSlug && portalLinkRes.data
      ? `${origin}/member/${storeSlug}?code=${encodeURIComponent(portalLinkRes.data.token)}`
      : null;
  const memberPortalQrDataUrl = memberPortalUrl
    ? await QRCode.toDataURL(memberPortalUrl, { width: 220, margin: 1, errorCorrectionLevel: "M" }).catch(() => null)
    : null;

  return (
    <CustomerLoyaltyManager
      customers={customersRes.data ?? []}
      customerSearch={customerSearch}
      customerTotal={customersRes.total}
      customersTruncated={customersRes.truncated}
      coupons={couponsRes.data ?? []}
      loyaltySettings={loyaltySettingsRes.data ?? null}
      rewards={rewardsRes.data ?? []}
      memberPortalUrl={memberPortalUrl}
      memberPortalQrDataUrl={memberPortalQrDataUrl}
      organizationId={ctx.organizationId}
      storeId={ctx.storeId}
      rewardProducts={rewardProducts}
      planName={billingState.plan}
      loyaltyEnabled={features.loyaltyPoints}
      couponEnabled={features.couponManagement}
      canManageCustomers={canManageCustomers}
      canManageCoupons={canManageCoupons}
      canManageLoyaltySettings={canManageLoyaltySettings}
      storeTimezone={ctx.storeTimezone}
      errors={[
        customersRes.error?.userMessage,
        couponsRes.error?.userMessage,
        loyaltySettingsRes.error?.userMessage,
        rewardsRes.error?.userMessage,
        portalLinkRes.error?.userMessage,
        storeRes.error?.message,
      ].filter((message): message is string => Boolean(message))}
    />
  );
}

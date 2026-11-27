import { notFound } from "next/navigation";
import { getCustomerPortalData } from "@/modules/customers/member-repository";
import { getMemberPassesView } from "@/modules/prepaid-passes/member-portal";
import { getMemberTierForCustomer, listMemberTierCoupons } from "@/modules/member-tiers/repository";
import { getMemberMissionsView } from "@/modules/missions/repository";
import { MemberPortal } from "./MemberPortal";
import { resolveOrderingStore, websiteSlugForStoreSlug } from "@/modules/online-orders/public";

export const dynamic = "force-dynamic";

export default async function CustomerMemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeSlug: string }>;
  searchParams: Promise<{ code?: string; claim?: string }>;
}) {
  const { storeSlug } = await params;
  const { code, claim } = await searchParams;
  const portalCode = String(code ?? "");

  if (storeSlug.length > 100) notFound();

  const portalData = await getCustomerPortalData(storeSlug, portalCode);
  // แพ็กของฉัน + ซื้อออนไลน์ (Enterprise) — โหลดเฉพาะคนที่ล็อกอินแล้ว
  const passesView =
    portalData.store && portalData.customer
      ? await getMemberPassesView({
          storeId: portalData.store.id,
          customerId: portalData.customer.id,
          canSell: portalData.memberPrivileges,
        })
      : null;
  // ระดับสมาชิก (Enterprise + ร้านเปิดใช้) — null = ไม่แสดง
  const tierView =
    portalData.store && portalData.customer && portalData.memberPrivileges
      ? await getMemberTierForCustomer(portalData.store.id, portalData.customer.id)
      : null;
  const tierCoupons =
    tierView && portalData.store && portalData.customer
      ? await listMemberTierCoupons(portalData.store.id, portalData.customer.id, tierView.rank)
      : [];

  // ภารกิจสะสม (Enterprise + ร้านเปิดภารกิจ) — โหลดเฉพาะคนที่ล็อกอินแล้ว
  const missionsView =
    portalData.store && portalData.customer && portalData.memberPrivileges
      ? await getMemberMissionsView(portalData.store.id, portalData.customer.id)
      : null;

  // สั่งออนไลน์จากหน้าสมาชิก (ร้านเปิดสั่งออนไลน์ + ล็อกอินแล้ว) — ชื่อ/เบอร์กรอกให้ เก็บปลายทางไม่ต้อง OTP ซ้ำ
  let onlineOrderHref: string | null = null;
  if (portalData.store && portalData.customer) {
    const site = await websiteSlugForStoreSlug(storeSlug).catch(() => null);
    const ordering = site ? await resolveOrderingStore(site.websiteSlug).catch(() => null) : null;
    if (ordering?.ok) onlineOrderHref = `/member/${encodeURIComponent(storeSlug)}/order`;
  }

  return (
    <MemberPortal
      onlineOrderHref={onlineOrderHref}
      orderHistoryHref={onlineOrderHref ? `/member/${encodeURIComponent(storeSlug)}/orders` : null}
      storeSlug={storeSlug}
      portalCode={portalCode}
      claimCode={typeof claim === "string" ? claim.trim().toUpperCase() : null}
      data={portalData}
      passesView={passesView}
      tierView={tierView}
      tierCoupons={tierCoupons}
      missionsView={missionsView}
    />
  );
}

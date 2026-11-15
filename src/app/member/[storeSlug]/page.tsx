import { notFound } from "next/navigation";
import { getCustomerPortalData } from "@/modules/customers/member-repository";
import { getMemberPassesView } from "@/modules/prepaid-passes/member-portal";
import { MemberPortal } from "./MemberPortal";

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

  return (
    <MemberPortal
      storeSlug={storeSlug}
      portalCode={portalCode}
      claimCode={typeof claim === "string" ? claim.trim().toUpperCase() : null}
      data={portalData}
      passesView={passesView}
    />
  );
}

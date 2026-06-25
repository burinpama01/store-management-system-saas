import { notFound } from "next/navigation";
import { getCustomerPortalData } from "@/modules/customers/member-repository";
import { MemberPortal } from "./MemberPortal";

export const dynamic = "force-dynamic";

export default async function CustomerMemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeSlug: string }>;
  searchParams: Promise<{ code?: string }>;
}) {
  const { storeSlug } = await params;
  const { code } = await searchParams;
  const portalCode = String(code ?? "");

  if (storeSlug.length > 100) notFound();

  const portalData = await getCustomerPortalData(storeSlug, portalCode);

  return (
    <MemberPortal
      storeSlug={storeSlug}
      portalCode={portalCode}
      data={portalData}
    />
  );
}

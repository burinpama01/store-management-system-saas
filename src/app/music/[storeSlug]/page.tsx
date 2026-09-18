import { notFound } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { resolveQrMusicEligibility } from "@/modules/music-requests/gates";
import { getPublicMusicStoreBySlug } from "@/modules/music-requests/repository";
import type { MusicLicenseStatus } from "@/modules/stores/types";
import { MusicTab } from "@/app/qr/[storeSlug]/[tableId]/MusicTab";

// QR ขอเพลงของร้าน (2026-09-18) — ร้านที่ไม่ได้เปิด QR Order ก็ให้ลูกค้าสแกนขอเพลงได้
// ไม่ผูกโต๊ะ/รอบบิล: ใช้กติกาเดียวกับ table_bound (ขอได้โดยไม่ต้องเปิดโต๊ะ)
// ด่านเดิมครบ: Enterprise + ใบอนุญาตเพลง approved + ร้านเปิดรับขอเพลง (ตรวจซ้ำใน action และ RPC)

export const dynamic = "force-dynamic";

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center bg-white p-8 text-center">
      <div className="mb-4 text-4xl">🎵</div>
      <p className="text-lg font-semibold text-gray-700">{title}</p>
      <p className="mt-2 text-sm text-gray-400">{detail}</p>
    </main>
  );
}

export default async function StoreMusicRequestPage({ params }: { params: Promise<{ storeSlug: string }> }) {
  const { storeSlug } = await params;
  const store = await getPublicMusicStoreBySlug(storeSlug);
  if (!store) notFound();

  const billingState = (await getOrganizationBillingState(store.organizationId)) ?? DEFAULT_BILLING_STATE;
  const eligibility = resolveQrMusicEligibility({
    qrMode: "table_bound",
    querySessionId: null,
    currentSessionId: null,
    sessionActive: false,
    isEnterprise: getPlanFeatures(billingState).musicRequest,
    musicLicenseStatus: store.musicLicenseStatus as MusicLicenseStatus,
    musicRequestEnabled: store.musicRequestEnabled,
  });
  if (!eligibility.canViewQueue) {
    return <Notice title="ยังขอเพลงที่ร้านนี้ไม่ได้" detail={eligibility.reason ?? "กรุณาสอบถามพนักงาน"} />;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-white">
      <header className="border-b border-gray-100 px-4 py-3">
        <p className="text-xs text-gray-400">ขอเพลง</p>
        <h1 className="text-lg font-bold text-gray-900">{store.name}</h1>
      </header>
      <MusicTab storeId={store.id} tableId={null} querySessionId={null} eligibility={eligibility} />
    </main>
  );
}

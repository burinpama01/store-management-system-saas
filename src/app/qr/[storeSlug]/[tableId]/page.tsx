import { notFound } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import {
  getStoreBySlug,
  getTableById,
  listPublicMenu,
} from "@/modules/stores/public-repository";
import QrOrderingApp from "./QrOrderingApp";

export const dynamic = "force-dynamic";

interface QrOrderPageProps {
  params: Promise<{ storeSlug: string; tableId: string }>;
}

export default async function QrOrderPage({ params }: QrOrderPageProps) {
  const { storeSlug, tableId } = await params;

  if (storeSlug.length > 100 || tableId.length > 100) notFound();

  const [storeRes, tableRes] = await Promise.all([
    getStoreBySlug(storeSlug),
    getTableById(tableId),
  ]);

  if (storeRes.error || !storeRes.data) notFound();
  if (tableRes.error || !tableRes.data) notFound();

  const store = storeRes.data;
  const table = tableRes.data;

  if (!store.isActive) {
    return (
      <main className="min-h-screen bg-white flex flex-col items-center justify-center p-8 max-w-sm mx-auto text-center">
        <p className="text-lg font-semibold text-gray-700">ร้านปิดอยู่ในขณะนี้</p>
        <p className="text-sm text-gray-400 mt-2">กรุณาลองใหม่อีกครั้งภายหลัง</p>
      </main>
    );
  }

  const billingState =
    (await getOrganizationBillingState(store.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);

  if (!features.qrOrdering) {
    return (
      <main className="min-h-screen bg-white flex flex-col items-center justify-center p-8 max-w-sm mx-auto text-center">
        <p className="text-lg font-semibold text-gray-700">
          แพ็กเกจของร้านนี้ยังไม่เปิดใช้ QR Ordering
        </p>
        <p className="text-sm text-gray-400 mt-2">
          กรุณาแจ้งพนักงานเพื่อรับออร์เดอร์ที่โต๊ะ
        </p>
      </main>
    );
  }

  if (!store.qrOrderingEnabled) {
    return (
      <main className="min-h-screen bg-white flex flex-col items-center justify-center p-8 max-w-sm mx-auto text-center">
        <p className="text-lg font-semibold text-gray-700">ยังไม่เปิดรับออร์เดอร์ผ่าน QR</p>
        <p className="text-sm text-gray-400 mt-2">กรุณาแจ้งพนักงานเพื่อรับออร์เดอร์ที่โต๊ะ</p>
      </main>
    );
  }

  if (table.storeId !== store.id || !table.isActive || !table.qrEnabled) {
    return (
      <main className="min-h-screen bg-white flex flex-col items-center justify-center p-8 max-w-sm mx-auto text-center">
        <p className="text-lg font-semibold text-gray-700">โต๊ะนี้ยังไม่พร้อมรับออร์เดอร์</p>
        <p className="text-sm text-gray-400 mt-2">กรุณาแจ้งพนักงานเพื่อช่วยตรวจสอบ</p>
      </main>
    );
  }

  const menuRes = await listPublicMenu(store.id);
  if (menuRes.error || !menuRes.data) {
    return (
      <main className="min-h-screen bg-white flex flex-col items-center justify-center p-8 max-w-sm mx-auto text-center">
        <p className="text-lg font-semibold text-gray-700">ยังไม่สามารถโหลดเมนูได้</p>
        <p className="text-sm text-gray-400 mt-2">กรุณาลองใหม่หรือแจ้งพนักงาน</p>
      </main>
    );
  }

  const { categories, products } = menuRes.data;

  return (
    <QrOrderingApp
      store={store}
      table={table}
      categories={categories}
      products={products}
    />
  );
}

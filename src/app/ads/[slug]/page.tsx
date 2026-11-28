import type { Metadata } from "next";
import { resolveAdStore } from "@/modules/ad-self-serve/server";
import { AdOrderForm } from "./AdOrderForm";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolveAdStore(slug);
  return {
    title: resolved.ok ? `ลงโฆษณาบนจอ · ${resolved.store.storeName}` : "ลงโฆษณาบนจอร้าน",
    robots: { index: false, follow: false },
  };
}

/** หน้าสาธารณะสำหรับผู้ลงโฆษณา (สแกนจาก QR ของร้าน) — ไม่ต้องล็อกอิน */
export default async function StoreAdPublicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveAdStore(slug);
  if (!resolved.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-2 bg-white p-6 text-center text-stone-800">
        <p className="text-4xl" aria-hidden>
          📺
        </p>
        <p className="text-lg font-semibold">{resolved.reason}</p>
        <p className="text-sm text-stone-500">สอบถามพนักงานร้านได้เลย</p>
      </main>
    );
  }
  const { store } = resolved;
  return (
    <AdOrderForm
      slug={store.slug}
      storeName={store.storeName}
      packages={store.offer.packages}
      terms={store.offer.terms}
      allowVideo={store.offer.allowVideo}
      allowImage={store.offer.allowImage}
      maxVideoSeconds={store.offer.maxVideoSeconds}
      autoPublish={store.offer.autoPublish}
      slotsInUse={store.slotsInUse}
      maxConcurrent={store.offer.maxConcurrent}
      nextFreeAt={store.nextFreeAt}
      payMode={store.beam ? "beam" : "slip"}
    />
  );
}

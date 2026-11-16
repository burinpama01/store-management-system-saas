import type { Metadata } from "next";
import Link from "next/link";
import { loadOnlineMenu } from "@/modules/online-orders/menu";
import { resolveOrderingStore } from "@/modules/online-orders/public";
import { OrderApp } from "./OrderApp";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolveOrderingStore(slug);
  return {
    title: resolved.ok ? `สั่งออนไลน์ · ${resolved.store.storeName}` : "สั่งออนไลน์",
    robots: { index: false },
  };
}

export default async function OnlineOrderPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolveOrderingStore(slug);
  if (!resolved.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">{resolved.reason}</p>
        <Link href={`/s/${encodeURIComponent(slug)}`} className="text-sm text-orange-700 underline">
          กลับหน้าร้าน
        </Link>
      </main>
    );
  }
  const { store } = resolved;
  const menu = await loadOnlineMenu(store.storeId);
  return (
    <OrderApp
      slug={store.slug}
      storeName={store.storeName}
      storePhone={store.phone}
      menu={menu}
      pickupEnabled={store.settings.pickupEnabled}
      deliveryEnabled={store.settings.deliveryEnabled}
      minOrder={store.settings.minOrder}
      prepMinutes={store.settings.prepMinutes}
      deliveryRadiusKm={store.settings.deliveryRadiusKm}
    />
  );
}

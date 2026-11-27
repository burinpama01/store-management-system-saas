import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getMemberSessionByStoreId } from "@/modules/customers/member-repository";
import { loadOnlineMenu } from "@/modules/online-orders/menu";
import { resolveOrderingStore, websiteSlugForStoreSlug } from "@/modules/online-orders/public";
import { OrderApp } from "../../../s/[slug]/order/OrderApp";
import { orderAppStoreProps } from "../../../s/[slug]/order/order-props";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สั่งออนไลน์ (สมาชิก)", robots: { index: false } };

/**
 * สั่งออนไลน์จากหน้าสมาชิก — อยู่ใต้ /member/<slug> เพื่อให้ cookie สมาชิก (path นี้) ถูกส่งมา
 * กรอกชื่อ/เบอร์ให้ · เก็บเงินปลายทางไม่ต้องขอ OTP ซ้ำถ้าใช้เบอร์สมาชิก (ยืนยันตอนเข้าสมาชิกแล้ว — ตรวจซ้ำฝั่ง server)
 */
export default async function MemberOnlineOrderPage({ params }: { params: Promise<{ storeSlug: string }> }) {
  const { storeSlug } = await params;
  if (storeSlug.length > 100) redirect("/");
  const site = await websiteSlugForStoreSlug(storeSlug);
  if (!site) redirect(`/member/${encodeURIComponent(storeSlug)}`);
  const member = await getMemberSessionByStoreId(site.storeId);
  // ยังไม่ได้ล็อกอินสมาชิก → กลับหน้าสมาชิก (เข้าสู่ระบบด้วย OTP ที่นั่น)
  if (!member) redirect(`/member/${encodeURIComponent(storeSlug)}`);
  const resolved = await resolveOrderingStore(site.websiteSlug);
  if (!resolved.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">{resolved.reason}</p>
        <Link href={`/member/${encodeURIComponent(storeSlug)}`} className="text-sm text-orange-700 underline">
          กลับหน้าสมาชิก
        </Link>
      </main>
    );
  }
  const menu = await loadOnlineMenu(resolved.store.storeId);
  return (
    <OrderApp
      {...orderAppStoreProps(resolved.store)}
      menu={menu}
      member={{ name: member.name, phone: member.phone ?? "", backHref: `/member/${encodeURIComponent(storeSlug)}` }}
    />
  );
}

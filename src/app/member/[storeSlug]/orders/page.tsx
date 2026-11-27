import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getMemberSessionByStoreId } from "@/modules/customers/member-repository";
import { listMemberOnlineOrders } from "@/modules/online-orders/member-history";
import { websiteSlugForStoreSlug } from "@/modules/online-orders/public";
import { logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ประวัติสั่งซื้อ (สมาชิก)", robots: { index: false } };

const baht = (n: number) => `฿${n.toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;
const ACTIVE = new Set(["awaiting_payment", "paid", "cod_pending", "accepted", "preparing", "ready", "out_for_delivery"]);

/** ประวัติสั่งออนไลน์ของสมาชิก + สั่งอีกครั้ง — อยู่ใต้ /member/<slug> ให้ cookie สมาชิกถูกส่งมา */
export default async function MemberOrderHistoryPage({ params }: { params: Promise<{ storeSlug: string }> }) {
  const { storeSlug } = await params;
  if (storeSlug.length > 100) redirect("/");
  const memberHref = `/member/${encodeURIComponent(storeSlug)}`;
  const site = await websiteSlugForStoreSlug(storeSlug);
  if (!site) redirect(memberHref);
  const member = await getMemberSessionByStoreId(site.storeId);
  if (!member) redirect(memberHref);

  let orders: Awaited<ReturnType<typeof listMemberOnlineOrders>> = [];
  let loadError = false;
  try {
    orders = member.phone ? await listMemberOnlineOrders(site.storeId, member.phone) : [];
  } catch (error) {
    loadError = true;
    void logSystemEvent({
      level: "error",
      source: "online-orders",
      action: "memberOrderHistory",
      message: `โหลดประวัติสั่งออนไลน์ของสมาชิกไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`,
      storeId: site.storeId,
    });
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-stone-50 p-4 pb-16">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">ประวัติสั่งซื้อ</h1>
        <Link href={memberHref} className="text-sm text-orange-700">หน้าสมาชิก</Link>
      </header>
      {loadError && <p className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">โหลดประวัติไม่สำเร็จ ลองใหม่อีกครั้ง</p>}
      {!loadError && orders.length === 0 && (
        <div className="rounded-xl border bg-white p-6 text-center text-sm text-stone-600">
          ยังไม่มีประวัติสั่งออนไลน์
          <div className="mt-3">
            <Link href={`${memberHref}/order`} className="inline-block rounded-lg bg-orange-600 px-4 py-2 font-semibold text-white">สั่งออนไลน์</Link>
          </div>
        </div>
      )}
      <ul className="space-y-3">
        {orders.map((o) => (
          <li key={o.id} className="rounded-xl border bg-white p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{o.orderCode}</p>
                <p className="text-xs text-stone-500">
                  {new Date(o.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" })}
                  {" · "}
                  {o.fulfillment === "delivery" ? "ส่งถึงบ้าน" : "รับที่ร้าน"}
                  {o.paymentMethod === "cod" ? " · เก็บปลายทาง" : ""}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${ACTIVE.has(o.status) ? "bg-orange-100 text-orange-800" : o.status === "completed" ? "bg-green-100 text-green-800" : "bg-stone-100 text-stone-600"}`}>
                {o.statusLabel}
              </span>
            </div>
            <p className="mt-2 line-clamp-2 text-stone-700">{o.itemsText}</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-bold">{baht(o.total)}</span>
              <div className="flex gap-2">
                <Link href={`/s/${encodeURIComponent(site.websiteSlug)}/order/t/${encodeURIComponent(o.publicToken)}`} className="rounded-lg border px-3 py-1.5">
                  รายละเอียด
                </Link>
                <Link href={`${memberHref}/order?reorder=${encodeURIComponent(o.id)}`} className="rounded-lg bg-orange-600 px-3 py-1.5 font-semibold text-white">
                  สั่งอีกครั้ง
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

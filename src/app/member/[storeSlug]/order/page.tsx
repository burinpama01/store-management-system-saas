import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getMemberSessionByStoreId } from "@/modules/customers/member-repository";
import { getMemberOrderLines } from "@/modules/online-orders/member-history";
import { loadOnlineMenu } from "@/modules/online-orders/menu";
import { buildReorderCart, type ReorderResult } from "@/modules/online-orders/reorder";
import { logSystemEvent } from "@/modules/system/event-log";
import { resolveOrderingStore, websiteSlugForStoreSlug } from "@/modules/online-orders/public";
import { OrderApp } from "../../../s/[slug]/order/OrderApp";
import { orderAppStoreProps } from "../../../s/[slug]/order/order-props";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สั่งออนไลน์ (สมาชิก)", robots: { index: false } };

/**
 * สั่งออนไลน์จากหน้าสมาชิก — อยู่ใต้ /member/<slug> เพื่อให้ cookie สมาชิก (path นี้) ถูกส่งมา
 * กรอกชื่อ/เบอร์ให้ · เก็บเงินปลายทางไม่ต้องขอ OTP ซ้ำถ้าใช้เบอร์สมาชิก (ยืนยันตอนเข้าสมาชิกแล้ว — ตรวจซ้ำฝั่ง server)
 */
export default async function MemberOnlineOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeSlug: string }>;
  searchParams: Promise<{ reorder?: string | string[] }>;
}) {
  const { storeSlug } = await params;
  const { reorder } = await searchParams;
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
  // สั่งอีกครั้ง: ออเดอร์ต้องเป็นของร้านนี้ + เบอร์ของสมาชิกที่ล็อกอิน (ตรวจฝั่ง server)
  let reorderResult: ReorderResult | null = null;
  let reorderNotFound = false;
  const reorderId = typeof reorder === "string" ? reorder : null;
  if (reorderId && member.phone) {
    const lines = await getMemberOrderLines(site.storeId, member.phone, reorderId).catch((error) => {
      void logSystemEvent({
        level: "error",
        source: "online-orders",
        action: "memberReorder",
        message: `สั่งอีกครั้ง: โหลดออเดอร์เดิมไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`,
        storeId: site.storeId,
        context: { orderId: reorderId },
      });
      return null;
    });
    reorderNotFound = !lines;
    reorderResult = lines ? buildReorderCart(lines, menu) : { cart: [], skipped: 0 };
    void logSystemEvent({
      level: lines ? "info" : "warn",
      source: "online-orders",
      action: "memberReorder",
      message: lines
        ? `สมาชิกสั่งอีกครั้งจากออเดอร์เดิม: ใส่ตะกร้า ${reorderResult.cart.length} รายการ ข้าม ${reorderResult.skipped}`
        : "สมาชิกสั่งอีกครั้ง: ไม่พบออเดอร์เดิมของสมาชิกคนนี้",
      storeId: site.storeId,
      context: { orderId: reorderId },
    });
  }
  return (
    <OrderApp
      {...orderAppStoreProps(resolved.store)}
      menu={menu}
      initialCart={reorderResult?.cart}
      reorderNotice={reorderNotFound ? "ไม่พบออเดอร์เดิม — เลือกเมนูใหม่ได้เลย" : reorderResult ? (reorderResult.cart.length === 0 ? "สั่งอีกครั้งไม่ได้ — เมนูเดิมไม่มีขายแล้ว" : reorderResult.skipped > 0 ? `ใส่ตะกร้าจากออเดอร์เดิมแล้ว (${reorderResult.skipped} รายการไม่มีขายแล้ว — ข้ามไป)` : "ใส่ตะกร้าจากออเดอร์เดิมแล้ว — ราคาเป็นราคาปัจจุบัน") : null}
      member={{ name: member.name, phone: member.phone ?? "", backHref: `/member/${encodeURIComponent(storeSlug)}` }}
    />
  );
}

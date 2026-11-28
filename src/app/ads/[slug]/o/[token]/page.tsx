import type { Metadata } from "next";
import { AdOrderStatus } from "./AdOrderStatus";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "สถานะโฆษณา",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** ลิงก์สถานะของผู้ลงโฆษณา (มี token สุ่ม) — จ่ายเงิน / ดูวันหมดอายุ */
export default async function StoreAdOrderStatusPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  return <AdOrderStatus slug={slug} token={token} />;
}

import type { Metadata } from "next";
import { TrackingClient } from "./TrackingClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ติดตามคำสั่งซื้อ",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function OnlineOrderTrackingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; token: string }>;
  searchParams: Promise<{ back?: string | string[] }>;
}) {
  const { slug, token } = await params;
  const { back } = await searchParams;
  // รับเฉพาะลิงก์ภายในหน้าสมาชิก กัน open redirect
  const backHref = typeof back === "string" && /^\/member\/[A-Za-z0-9%_-]+\/order\?[A-Za-z0-9%_=&-]*$/.test(back) && back.length <= 300 ? back : null;
  return <TrackingClient slug={slug} token={token} backHref={backHref} />;
}

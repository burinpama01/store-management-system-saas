import type { Metadata } from "next";
import { TrackingClient } from "./TrackingClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ติดตามคำสั่งซื้อ",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function OnlineOrderTrackingPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  return <TrackingClient slug={slug} token={token} />;
}

import { NextResponse } from "next/server";
import { processBeamWebhook } from "@/modules/payments/webhook-beam";

export const dynamic = "force-dynamic";

/**
 * Beam webhook — register in Lighthouse → Developers → Webhooks
 * (events: charge.succeeded, charge.failed). The signature covers the raw
 * bytes, so the body is read as text, never re-serialised JSON.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const rawBody = await req.text();
  const result = await processBeamWebhook({
    storeId: url.searchParams.get("storeId"),
    rawBody,
    signature: req.headers.get("x-beam-signature"),
    eventName: req.headers.get("x-beam-event"),
  });
  return NextResponse.json(result.body, { status: result.status });
}

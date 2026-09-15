import { NextResponse } from "next/server";
import { processTrueMoneyOpenApiWebhook } from "@/modules/payments/webhook-truemoney";

export const dynamic = "force-dynamic";

/**
 * TrueMoney Wallet Open API incoming-payment webhook.
 * Register this URL in the TrueMoney app webhook settings (after eligibility).
 * Provisional: pass ?storeId=<uuid> until official merchant-id routing is confirmed.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const storeId = url.searchParams.get("storeId");
  let rawBody: unknown = null;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const result = await processTrueMoneyOpenApiWebhook({ rawBody, storeId });
  return NextResponse.json(result.body, { status: result.status });
}

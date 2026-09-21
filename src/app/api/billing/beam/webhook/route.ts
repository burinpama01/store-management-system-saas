import { NextResponse } from "next/server";
import { processPlatformBeamWebhook } from "@/modules/billing/beam-billing";

export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!req.headers.get("x-beam-signature")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 64 * 1024) return NextResponse.json({ error: "too_large" }, { status: 413 });
  try {
    await processPlatformBeamWebhook(raw, req.headers.get("x-beam-signature"));
    return NextResponse.json({ ok: true });
  } catch {
    // Non-2xx asks Beam to retry, including transient DB or lookup failures.
    return NextResponse.json({ error: "verification_failed" }, { status: 503 });
  }
}

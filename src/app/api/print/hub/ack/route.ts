import { NextRequest, NextResponse } from "next/server";
import { verifyHubToken } from "@/modules/printing/print-hub";
import { ackPrintJob, getStoreHubAuth } from "@/modules/printing/print-hub-repository";

/**
 * The Print Hub reports the result of a claimed job (printed or failed).
 * Authenticated by the per-store Hub token.
 */
export async function POST(req: NextRequest) {
  let body: { storeId?: string; hubToken?: string; jobId?: string; ok?: boolean; error?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  const hubToken = typeof body.hubToken === "string" ? body.hubToken : "";
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  if (!storeId || !hubToken || !jobId) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const auth = await getStoreHubAuth(storeId);
  if (auth.error || !auth.data || !verifyHubToken(hubToken, auth.data.tokenHash)) {
    return NextResponse.json({ error: "Invalid Hub credentials" }, { status: 401 });
  }

  const result = await ackPrintJob({
    jobId,
    storeId,
    ok: body.ok === true,
    error: typeof body.error === "string" ? body.error : null,
  });
  if (result.error) {
    return NextResponse.json({ error: result.error.userMessage }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

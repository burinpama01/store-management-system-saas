import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getCurrentUser } from "@/modules/auth/session";
import { createLineAccountLinkSession } from "@/modules/notifications/repository";

export const dynamic = "force-dynamic";

const LINE_LINK_SESSION_TTL_MS = 10 * 60 * 1000;

function hashNonce(nonce: string) {
  return createHash("sha256").update(nonce).digest("hex");
}

function settingsRedirect(request: NextRequest, reason: string) {
  const url = new URL("/settings/notifications", request.nextUrl.origin);
  url.searchParams.set("lineLink", "1");
  url.searchParams.set("lineError", reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  if (!process.env.LINE_ACCOUNT_LINK_BASE_URL) {
    return settingsRedirect(request, "provider");
  }

  const linkToken = request.nextUrl.searchParams.get("linkToken");
  if (!linkToken) {
    return settingsRedirect(request, "token");
  }

  const { ctx } = await getResolvedCurrentPermissions();
  if (ctx.role !== "owner") {
    return settingsRedirect(request, "owner");
  }

  const nonce = randomBytes(32).toString("base64url");
  const result = await createLineAccountLinkSession(
    ctx.organizationId,
    user.id,
    hashNonce(nonce),
    new Date(Date.now() + LINE_LINK_SESSION_TTL_MS).toISOString(),
  );
  if (result.error) {
    return settingsRedirect(request, "session");
  }

  const lineUrl = new URL("https://access.line.me/dialog/bot/accountLink");
  lineUrl.searchParams.set("linkToken", linkToken);
  lineUrl.searchParams.set("nonce", nonce);
  return NextResponse.redirect(lineUrl);
}

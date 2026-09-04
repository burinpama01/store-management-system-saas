import { NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { summarizeHubStatus } from "@/modules/printing/print-hub";
import { getHubStatus } from "@/modules/printing/print-hub-repository";

/** Live Print Hub status (online + pending depth) for the Settings UI card. */
export async function GET() {
  let authz: Awaited<ReturnType<typeof getOptionalResolvedCurrentPermissions>>;
  try {
    authz = await getOptionalResolvedCurrentPermissions();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  if (!authz) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ctx, resolved } = authz;
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getHubStatus(ctx.storeId);
  if (status.error || !status.data) {
    return NextResponse.json({ error: status.error?.userMessage ?? "Failed to load Hub status" }, { status: 500 });
  }

  const summary = summarizeHubStatus(status.data.lastSeen);
  return NextResponse.json({
    ok: true,
    online: summary.online,
    lastSeen: summary.lastSeen,
    secondsAgo: summary.secondsAgo,
    pendingJobs: status.data.pendingJobs,
    claimedJobs: status.data.claimedJobs,
    unknownJobs: status.data.unknownJobs,
    failedJobs: status.data.failedJobs,
    unknownJobList: status.data.unknownJobList,
    devices: status.data.devices,
    devicesAt: status.data.devicesAt,
  });
}

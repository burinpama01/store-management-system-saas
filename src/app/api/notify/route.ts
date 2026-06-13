import { NextResponse } from "next/server";
import { getResolvedCurrentPermissions, requireFeature } from "@/modules/auth/guards";
import {
  dispatchNotification,
  isNotificationPayload,
} from "@/modules/notifications/dispatcher";

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof getResolvedCurrentPermissions>>;
  try {
    context = await getResolvedCurrentPermissions();
    if (!context.resolved.can("notifications.manage")) {
      throw new Error("Missing permission: notifications.manage");
    }
    await requireFeature("lineNotify");
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Forbidden" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!isNotificationPayload(body)) {
    return NextResponse.json({ ok: false, error: "Invalid notification payload" }, { status: 400 });
  }

  const { ctx } = context;
  const result = await dispatchNotification({
    ...body,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.message }, { status: 400 });
  }
  return NextResponse.json(result);
}

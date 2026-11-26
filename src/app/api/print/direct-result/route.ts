// POST /api/print/direct-result — โปรแกรม StoreOS POS รายงานผลพิมพ์ตรงของตั๋วครัวที่จองไว้ (เฟส D3)
// failed = ปล่อยการจอง (ลองใหม่ได้) / printed, unknown = เก็บไว้กันพิมพ์ซ้ำ
import { NextRequest, NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { parseStationTicketSourceKey } from "@/modules/printing/station-routing";
import { finishDirectStationTicket } from "@/modules/printing/direct-print-repository";
import { logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let authz: Awaited<ReturnType<typeof getOptionalResolvedCurrentPermissions>>;
  try {
    authz = await getOptionalResolvedCurrentPermissions();
  } catch (error) {
    if (error instanceof AuthorizationError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
  if (!authz) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { ctx, resolved } = authz;
  if (!resolved.can("pos.use")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { sourceKey?: unknown; outcome?: unknown; error?: unknown };
  const parsed = parseStationTicketSourceKey(body.sourceKey);
  const outcome = body.outcome === "printed" || body.outcome === "failed" || body.outcome === "unknown" ? body.outcome : null;
  if (!parsed || !outcome) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const sourceKey = `station_ticket:${parsed.orderId}:${parsed.stationId}`;
  const error = typeof body.error === "string" ? body.error.slice(0, 300) : null;
  await finishDirectStationTicket({ storeId: ctx.storeId, sourceKey, userId: ctx.userId, outcome, error });
  void logSystemEvent({
    level: outcome === "printed" ? "info" : "warn",
    source: "printing.direct",
    action: `station_${outcome}`,
    message: outcome === "printed" ? "พิมพ์ตั๋วครัวตรงสำเร็จ" : `พิมพ์ตั๋วครัวตรงไม่สำเร็จ (${outcome}): ${error ?? "-"}`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: { sourceKey, outcome },
  });
  return NextResponse.json({ ok: true });
}

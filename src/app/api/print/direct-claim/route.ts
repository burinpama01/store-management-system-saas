// POST /api/print/direct-claim — โปรแกรม StoreOS POS จองตั๋วครัว (ออเดอร์+สถานี) ก่อนพิมพ์ตรง (เฟส D3)
//
// ร้านโหมด "hub" → ตอบ { mode: "hub" } ให้จอไปทางคิวคลาวด์เดิม (กันซ้ำด้วย print_jobs.source_key)
// ร้านโหมด "direct" → ตรวจออเดอร์/สถานี/เครื่องพิมพ์ฝั่ง server (ไม่เชื่อ printerId ของ client) แล้วจอง:
//   claim "mine"  = จอนี้พิมพ์ (ได้ IP เครื่องพิมพ์ของสถานีกลับไป)
//   claim "taken" = จออื่นจอง/พิมพ์ไปแล้ว → ไม่พิมพ์ซ้ำ
import { NextRequest, NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { resolveStationTicketSource } from "@/modules/printing/print-hub-repository";
import { parseStationTicketSourceKey } from "@/modules/printing/station-routing";
import { claimDirectStationTicket, getStorePrintMode } from "@/modules/printing/direct-print-repository";
import { getPrinter } from "@/modules/stores/repository";
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

  if ((await getStorePrintMode(ctx.storeId)) !== "direct") return NextResponse.json({ mode: "hub" });

  const body = (await req.json().catch(() => ({}))) as { sourceKey?: unknown };
  const parsed = parseStationTicketSourceKey(body.sourceKey);
  if (!parsed) return NextResponse.json({ error: "Invalid source key" }, { status: 400 });

  const source = await resolveStationTicketSource(ctx.storeId, parsed.orderId, parsed.stationId);
  if (source.error || !source.data) {
    return NextResponse.json({ error: "ตรวจตั๋วครัวไม่สำเร็จ ลองใหม่อีกครั้ง" }, { status: 503 });
  }
  if (source.data.status === "table_bill") return NextResponse.json({ mode: "direct", claim: "skip" });
  if (source.data.status !== "ok") {
    const reasons = {
      not_found: { status: 404, error: "ไม่พบออเดอร์หรือสถานีครัวของร้านนี้" },
      no_items: { status: 409, error: "ออเดอร์นี้ไม่มีรายการของสถานีนี้" },
      no_printer: { status: 409, error: "สถานีนี้ยังไม่ได้ผูกเครื่องพิมพ์" },
    } as const;
    const reason = reasons[source.data.status];
    return NextResponse.json({ error: reason.error }, { status: reason.status });
  }

  const printerRes = await getPrinter(source.data.printerId, ctx.storeId, ctx.organizationId);
  const printer = printerRes.data;
  if (printerRes.error || !printer) return NextResponse.json({ error: "ไม่พบเครื่องพิมพ์ของสถานี" }, { status: 404 });
  if ((printer.type !== "ip" && printer.type !== "escpos") || !printer.ipAddress) {
    return NextResponse.json({ error: `เครื่องพิมพ์ของสถานี "${printer.name}" ไม่ใช่เครื่องพิมพ์ IP — โหมดพิมพ์ตรงใช้ได้เฉพาะเครื่องพิมพ์ IP/WiFi` }, { status: 409 });
  }

  const sourceKey = `station_ticket:${parsed.orderId}:${parsed.stationId}`;
  const claim = await claimDirectStationTicket({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    sourceKey,
    printerId: printer.id,
    userId: ctx.userId,
  });
  void logSystemEvent({
    level: "info",
    source: "printing.direct",
    action: claim.claim === "mine" ? "station_claimed" : "station_already_claimed",
    message: claim.claim === "mine" ? "จองตั๋วครัวพิมพ์ตรง" : "ตั๋วครัวนี้ถูกจองพิมพ์ไปแล้ว — ข้าม",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: ctx.userId,
    context: { sourceKey, ...(claim.claim === "taken" ? { status: claim.status } : {}) },
  });
  return NextResponse.json({
    mode: "direct",
    ...claim,
    sourceKey,
    printer: { id: printer.id, host: printer.ipAddress, port: printer.port ?? 9100 },
  });
}

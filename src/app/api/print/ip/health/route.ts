import { NextRequest, NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions, requireFeature, requireRole } from "@/modules/auth/guards";
import { normalizeNetworkPrinterEndpoint, probeNetworkPrinter } from "@/modules/printing/network-printer";
import { getPrinter } from "@/modules/stores/repository";

export async function POST(req: NextRequest) {
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
  if (!resolved.can("pos.use")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    await requireRole("manager");
    await requireFeature("advancedPrinting");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  let body: { printerId?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { printerId } = body;
  if (!printerId) {
    return NextResponse.json({ error: "Missing printer ID" }, { status: 400 });
  }

  const printerRes = await getPrinter(printerId, ctx.storeId, ctx.organizationId);
  if (printerRes.error) {
    return NextResponse.json({ error: printerRes.error.userMessage }, { status: 500 });
  }
  const printer = printerRes.data;
  if (!printer) {
    return NextResponse.json({ error: "Printer not found" }, { status: 404 });
  }
  if (printer.type !== "ip" && printer.type !== "escpos") {
    return NextResponse.json({ error: "Printer type does not support network health checks" }, { status: 400 });
  }
  if (!printer.ipAddress) {
    return NextResponse.json({ error: "Missing printer IP address" }, { status: 400 });
  }

  try {
    const endpoint = normalizeNetworkPrinterEndpoint({ host: printer.ipAddress, port: printer.port });
    const result = await probeNetworkPrinter({ ...endpoint, timeoutMs: 1500 });
    return NextResponse.json({ ok: true, latencyMs: result.latencyMs });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Printer health check failed" },
      { status: 502 },
    );
  }
}

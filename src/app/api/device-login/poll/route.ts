// POST /api/device-login/poll — เครื่องร้านถามว่ามีคนอนุมัติหรือยัง (public; ต้องมีรหัสลับของเครื่อง)
import { NextResponse } from "next/server";
import { pollDeviceLoginRequest } from "@/modules/auth/device-login";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { requestId?: unknown; secret?: unknown };
  const result = await pollDeviceLoginRequest(String(body.requestId ?? ""), String(body.secret ?? ""));
  return NextResponse.json(result, {
    status: result.status === "invalid" ? 404 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { verifyHubToken } from "@/modules/printing/print-hub";
import { authenticateHubRequest } from "@/modules/printing/print-hub-repository";
import {
  MAX_LAUNCHER_LOG_ENTRIES,
  sanitizeLauncherLogBatch,
  sanitizeLauncherVersion,
} from "@/modules/launcher/log-intake";
import { logSystemEvent } from "@/modules/system/event-log";

/**
 * รับ log จาก StoreOS Launcher บนเครื่องแคชเชียร์ เพื่อให้ไล่ปัญหาบนเครื่องร้านอื่นได้
 * โดยไม่ต้องขอให้ร้านอ่านหน้าจอให้ฟังทางโทรศัพท์
 *
 * การยืนยันตัวตนใช้ Hub token ของร้านเดิม (ไม่สร้างความลับใหม่) — Launcher กับ Print Hub
 * อยู่บนเครื่องเดียวกันและอ่านไฟล์ config เดียวกันอยู่แล้ว การออกโทเค็นชุดที่สองให้
 * โปรแกรมบนเครื่องเดียวกันไม่ได้เพิ่มความปลอดภัยจริง แต่เพิ่มของที่ต้องหมุนเวียน/หลุดได้อีกชิ้น
 *
 * เนื้อหาที่ส่งมาเป็นข้อมูล ไม่ใช่คำสั่ง: ตรวจรูปทรง ตัดความยาว และกลบค่าที่ดูเหมือน
 * ความลับซ้ำอีกชั้นก่อนบันทึกเสมอ (sanitizeLauncherLogBatch)
 */
export async function POST(req: NextRequest) {
  let body: {
    storeId?: string;
    hubToken?: string;
    launcherVersion?: unknown;
    entries?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
  const hubToken = typeof body.hubToken === "string" ? body.hubToken : "";
  if (!storeId || !hubToken) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }

  const auth = await authenticateHubRequest(storeId, hubToken);
  if (!auth.ok) {
    return NextResponse.json({ error: "Invalid Hub credentials" }, { status: 401 });
  }

  const launcherVersion = sanitizeLauncherVersion(body.launcherVersion);
  const batch = sanitizeLauncherLogBatch(body.entries);
  if (batch.entries.length === 0) {
    // ไม่มีอะไรใช้ได้เลย = ตอบ 200 พร้อมบอกจำนวนที่ทิ้ง (ไม่ให้ Launcher วนส่งซ้ำ)
    return NextResponse.json({ ok: true, accepted: 0, dropped: batch.dropped });
  }

  for (const entry of batch.entries) {
    await logSystemEvent({
      level: entry.level,
      source: "launcher.windows",
      action: entry.code,
      message: entry.message || entry.code,
      organizationId: auth.organizationId,
      storeId,
      context: {
        ...(entry.context ?? {}),
        launcherVersion,
        // เวลาที่เครื่องร้านบันทึก อาจต่างจากเวลาที่เซิร์ฟเวอร์ได้รับ (ส่งเป็นก้อน/เน็ตหลุด)
        clientAt: entry.at,
      },
    });
  }

  if (batch.dropped > 0) {
    await logSystemEvent({
      level: "warn",
      source: "launcher.windows",
      action: "launcherLogDropped",
      message: "log จาก Launcher บางรายการถูกทิ้งเพราะรูปแบบไม่ผ่านหรือเกินเพดาน",
      organizationId: auth.organizationId,
      storeId,
      context: { dropped: batch.dropped, limit: MAX_LAUNCHER_LOG_ENTRIES, launcherVersion },
    });
  }

  return NextResponse.json({ ok: true, accepted: batch.entries.length, dropped: batch.dropped });
}

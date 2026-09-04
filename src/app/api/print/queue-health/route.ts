import { NextResponse } from "next/server";
import { AuthorizationError, getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getHubStatus } from "@/modules/printing/print-hub-repository";

/**
 * สภาพคิวงานพิมพ์สำหรับ "คนที่ยืนอยู่หน้าเครื่องพิมพ์" (แคชเชียร์) — ไม่ใช่ผู้ดูแลระบบ
 *
 * ทำไมต้องมีแยกจาก /api/print/hub/status: อันนั้นต้องมีสิทธิ์ตั้งค่าเครื่องพิมพ์ และคืน
 * รายชื่ออุปกรณ์บนพีซีด้วย ซึ่งแคชเชียร์ไม่ต้องใช้และไม่ควรเห็น. งานที่ระบบไม่รู้ผล
 * (unknown) ต้องให้คนที่เห็นกระดาษจริงตัดสิน ซึ่งคือแคชเชียร์ ไม่ใช่เจ้าของร้านที่อยู่บ้าน
 * ถ้าโชว์เฉพาะในหน้าตั้งค่า ร้านเล็กจะไม่มีวันเห็นเลย
 */
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
  if (!resolved.can("pos.use") && !resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = await getHubStatus(ctx.storeId);
  if (status.error || !status.data) {
    return NextResponse.json({ error: status.error?.userMessage ?? "โหลดสถานะคิวงานพิมพ์ไม่สำเร็จ" }, { status: 500 });
  }

  // คืนเฉพาะสภาพคิว — ไม่ส่งรายชื่ออุปกรณ์/สถานะ Hub ที่แคชเชียร์ไม่ได้ใช้
  return NextResponse.json({
    ok: true,
    pendingJobs: status.data.pendingJobs,
    unknownJobs: status.data.unknownJobs,
    unknownJobList: status.data.unknownJobList,
  });
}

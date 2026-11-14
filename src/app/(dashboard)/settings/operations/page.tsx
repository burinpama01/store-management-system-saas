import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { isOperationsEnabled, listChecklistTemplates } from "@/modules/operations/repository";
import { isOpsManagerRole } from "@/modules/operations/access";
import { OperationsToggle } from "../../ops/OperationsToggle";

export const dynamic = "force-dynamic";

export default async function OperationsSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!isOpsManagerRole(ctx.role)) redirect("/settings/store");

  const [enabled, templatesRes] = await Promise.all([
    isOperationsEnabled(ctx.storeId),
    listChecklistTemplates(ctx.storeId, { includeInactive: true }),
  ]);
  const templates = templatesRes.data ?? [];
  const active = templates.filter((template) => template.isActive);
  const unassigned = active.filter((template) => template.assigneeUserIds.length === 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">งานหน้าร้าน (เช็กลิสต์)</h2>
        <p className="text-sm text-gray-600">
          เช็กลิสต์เปิด-ปิดร้านของครัว บาร์ หรือหน้าร้าน — ผู้รับผิดชอบต้องส่งก่อนออกงาน และเจ้าของได้รับแจ้งเมื่อข้อสำคัญไม่ผ่านหรือเลยกำหนด
        </p>
      </div>

      <OperationsToggle enabled={enabled} hasActiveTemplate={active.length > 0} />

      {templatesRes.error && <p className="alert-danger" role="alert">โหลดเช็กลิสต์ไม่สำเร็จ: {templatesRes.error}</p>}

      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <p className="text-sm text-gray-800">
          เช็กลิสต์ทั้งหมด {templates.length} ชุด · ใช้งาน {active.length} ชุด
          {unassigned.length > 0 && <span className="text-amber-700"> · ยังไม่มีผู้รับผิดชอบ {unassigned.length} ชุด</span>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="btn-primary" href="/ops/templates">ตั้งค่าเช็กลิสต์</Link>
          <Link className="btn-secondary" href="/ops/templates/library">เลือกแม่แบบตามประเภทร้าน</Link>
          {enabled && <Link className="btn-secondary" href="/ops/history">ประวัติ</Link>}
        </div>
      </div>
    </div>
  );
}

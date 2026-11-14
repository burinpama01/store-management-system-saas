import Link from "next/link";
import { redirect } from "next/navigation";
import { listChecklistTemplates } from "@/modules/operations/repository";
import { CHECKLIST_PHASE_LABELS, DAY_LABELS } from "@/modules/operations/types";
import { loadMemberNames, loadOpsPageContext } from "../shared";
import { OperationsToggle } from "../OperationsToggle";

export const dynamic = "force-dynamic";

export default async function ChecklistTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; skipped?: string }>;
}) {
  const { ctx, enabled, isManager } = await loadOpsPageContext();
  const query = await searchParams;
  const createdCount = Number(query.created ?? "");
  const skippedCount = Number(query.skipped ?? "");
  if (!isManager) redirect("/ops");

  const [templatesRes, names] = await Promise.all([
    listChecklistTemplates(ctx.storeId, { includeInactive: true }),
    loadMemberNames(ctx.organizationId, ctx.storeId),
  ]);
  const templates = templatesRes.data ?? [];

  return (
    <section className="page-shell max-w-3xl">
      <div className="page-header">
        <div>
          <p className="text-xs text-gray-500"><Link href="/ops" className="underline">งานหน้าร้าน</Link></p>
          <h1 className="page-title">ตั้งค่าเช็กลิสต์</h1>
          <p className="page-kicker">กำหนดข้อ เวลา ผู้รับผิดชอบ และข้อที่ต้องเสร็จก่อนออกงาน</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn-secondary" href="/ops/templates/library">เพิ่มจากแม่แบบ</Link>
          <Link className="btn-primary" href="/ops/templates/new">+ เช็กลิสต์ใหม่</Link>
        </div>
      </div>

      {Number.isFinite(createdCount) && query.created !== undefined && (
        <p className="alert-success" aria-live="polite">
          สร้างเช็กลิสต์จากแม่แบบ {createdCount} ชุด{skippedCount > 0 ? ` (ข้ามชื่อซ้ำ ${skippedCount})` : ""} — ตรวจข้อ เวลา และผู้รับผิดชอบ แล้วเปิด “ใช้งาน” ทีละชุด
        </p>
      )}

      {templatesRes.error && <p className="alert-danger" role="alert">โหลดไม่สำเร็จ: {templatesRes.error}</p>}

      <OperationsToggle enabled={enabled} hasActiveTemplate={templates.some((template) => template.isActive)} />

      {templates.length === 0 && (
        <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-700">
          <p>ยังไม่มีเช็กลิสต์ — เลือกแม่แบบตามประเภทร้าน (ร้านอาหาร กาแฟ เหล้า ของชำ สะดวกซื้อ หลายครัว ของสด สินค้ามีวันหมดอายุ) แล้วแก้ให้ตรงกับร้าน</p>
          <div className="mt-3"><Link className="btn-primary" href="/ops/templates/library">เลือกแม่แบบ</Link></div>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {templates.map((template) => (
          <Link
            key={template.id}
            href={`/ops/templates/${template.id}`}
            className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-400"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-gray-900">{template.name}</p>
              {template.area && <span className="text-xs text-gray-500">{template.area}</span>}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${template.isActive ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-600"}`}>
                {template.isActive ? "ใช้งาน" : "ปิดใช้"}
              </span>
              {template.requireBeforeClockOut && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">ต้องเสร็จก่อนออกงาน</span>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-600">
              {CHECKLIST_PHASE_LABELS[template.phase]} · {template.items.length} ข้อ ({template.items.filter((item) => item.critical).length} สำคัญ)
              {template.dueTime ? ` · กำหนด ${template.dueTime} น.` : " · ไม่มีกำหนดเวลา"}
              {" · "}
              {template.daysOfWeek.length === 7 ? "ทุกวัน" : template.daysOfWeek.map((day) => DAY_LABELS[day]).join(" ")}
              {" · ฉบับที่ "}{template.version}
            </p>
            <p className="mt-1 text-xs text-gray-600">
              ผู้รับผิดชอบ: {template.assigneeUserIds.length === 0
                ? <span className="text-amber-700">ยังไม่กำหนด (จะไม่บล็อกการออกงานของใคร)</span>
                : template.assigneeUserIds.map((id) => names.get(id) ?? "ไม่พบบัญชี").join(", ")}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getChecklistTemplate } from "@/modules/operations/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import type { TemplateInput } from "@/modules/operations/types";
import { loadOpsPageContext } from "../../shared";
import { TemplateEditor } from "./TemplateEditor";

export const dynamic = "force-dynamic";

const EMPTY_TEMPLATE: TemplateInput = {
  name: "",
  area: "",
  phase: "close",
  dueTime: null,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  requireBeforeClockOut: true,
  assigneeUserIds: [],
  isActive: true,
  sortOrder: 0,
  items: [
    {
      label: "",
      description: null,
      critical: false,
      valueType: "check",
      unit: null,
      minValue: null,
      maxValue: null,
      photoRule: "never",
    },
  ],
};

export default async function ChecklistTemplateEditPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  const { ctx, isManager } = await loadOpsPageContext();
  if (!isManager) redirect("/ops");

  const isNew = templateId === "new";
  const [templateRes, membersRes] = await Promise.all([
    isNew ? Promise.resolve({ data: null, error: null }) : getChecklistTemplate(ctx.storeId, templateId),
    listStoreMemberships(ctx.organizationId, ctx.storeId),
  ]);
  if (templateRes.error) {
    return <section className="page-shell max-w-3xl"><p className="alert-danger" role="alert">โหลดไม่สำเร็จ: {templateRes.error}</p></section>;
  }
  if (!isNew && !templateRes.data) notFound();
  const template = templateRes.data;

  const initial: TemplateInput = template
    ? {
        name: template.name,
        area: template.area,
        phase: template.phase,
        dueTime: template.dueTime,
        daysOfWeek: template.daysOfWeek,
        requireBeforeClockOut: template.requireBeforeClockOut,
        assigneeUserIds: template.assigneeUserIds,
        isActive: template.isActive,
        sortOrder: template.sortOrder,
        items: template.items.map((item) => ({
          label: item.label,
          description: item.description,
          critical: item.critical,
          valueType: item.valueType,
          unit: item.unit,
          minValue: item.minValue,
          maxValue: item.maxValue,
          photoRule: item.photoRule,
        })),
      }
    : EMPTY_TEMPLATE;

  const members = (membersRes.data ?? [])
    .filter((member) => member.role !== "super_admin")
    .map((member) => ({ userId: member.userId, label: member.email, role: member.role }));

  return (
    <section className="page-shell max-w-3xl">
      <div className="page-header">
        <div>
          <p className="text-xs text-gray-500"><Link href="/ops/templates" className="underline">ตั้งค่าเช็กลิสต์</Link></p>
          <h1 className="page-title">{isNew ? "เช็กลิสต์ใหม่" : `แก้ไข: ${template?.name}`}</h1>
          {!isNew && (
            <p className="page-kicker">ฉบับที่ {template?.version} — บันทึกแล้วเป็นฉบับใหม่ รอบที่ทำไปแล้วยังเก็บข้อเดิมไว้</p>
          )}
        </div>
      </div>
      <TemplateEditor templateId={isNew ? null : templateId} initial={initial} members={members} />
    </section>
  );
}

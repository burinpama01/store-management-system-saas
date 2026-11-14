import Link from "next/link";
import { redirect } from "next/navigation";
import { listChecklistTemplates } from "@/modules/operations/repository";
import { suggestPacks } from "@/modules/operations/starter-packs";
import { getStore } from "@/modules/stores/repository";
import { loadOpsPageContext } from "../../shared";
import { StarterPackPicker } from "./StarterPackPicker";

export const dynamic = "force-dynamic";

export default async function ChecklistLibraryPage() {
  const { ctx, isManager } = await loadOpsPageContext();
  if (!isManager) redirect("/ops");

  const [templatesRes, storeRes] = await Promise.all([
    listChecklistTemplates(ctx.storeId, { includeInactive: true }),
    getStore(ctx.storeId),
  ]);

  return (
    <section className="page-shell max-w-3xl">
      <div className="page-header">
        <div>
          <p className="text-xs text-gray-500"><Link href="/ops/templates" className="underline">ตั้งค่าเช็กลิสต์</Link></p>
          <h1 className="page-title">เลือกแม่แบบตามประเภทร้าน</h1>
          <p className="page-kicker">เลือกรวมกันได้ เช่น อาหาร + กาแฟ + ของสด — ไม่ฝังค่าอุณหภูมิ ร้านกำหนดเองตามวิธีปฏิบัติของร้าน</p>
        </div>
      </div>
      {templatesRes.error && <p className="alert-danger" role="alert">โหลดเช็กลิสต์เดิมไม่สำเร็จ: {templatesRes.error}</p>}
      <StarterPackPicker
        initialPacks={suggestPacks(storeRes.data?.setupProfile?.businessMode)}
        existingNames={(templatesRes.data ?? []).map((template) => template.name)}
      />
    </section>
  );
}

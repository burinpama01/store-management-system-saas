import { getInventoryAccess } from "@/modules/inventory/access";
import { listSuppliers } from "@/modules/inventory/repository";
import { listEvidence } from "@/modules/purchasing/repository";
import { CostingHeader, CostingLocked } from "../../CostingChrome";
import { EvidenceExport } from "./EvidenceExport";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function monthRange(): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

/** ส่งออกหลักฐานบิลซื้อ (รูป + ดัชนี CSV) สำหรับยื่นภาษี — ผู้จัดการขึ้นไป (Plan v5) */
export default async function PurchaseEvidencePage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return <CostingLocked message={decision.message} />;
  const sp = await searchParams;
  const def = monthRange();
  let from = sp.from && DATE_RE.test(sp.from) ? sp.from : def.from;
  let to = sp.to && DATE_RE.test(sp.to) ? sp.to : def.to;
  if (from > to) [from, to] = [to, from];

  const [evidence, suppliers] = await Promise.all([listEvidence(ctx.storeId, from, to), listSuppliers(ctx.storeId)]);
  if (evidence.error !== null || !evidence.data) return <CostingLocked message={evidence.error ?? "โหลดข้อมูลไม่สำเร็จ"} />;

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <CostingHeader
        active="/costing/purchases"
        title="ส่งออกหลักฐานบิลซื้อ"
        description="รูปบิลทุกใบที่อัปโหลดถูกเก็บไว้ (ไม่ลบ แม้บิลถูกยกเลิก/ไม่อนุมัติ) · ดาวน์โหลด ZIP พร้อมดัชนี CSV เพื่อยื่นภาษี"
      />
      <EvidenceExport
        from={from}
        to={to}
        bills={evidence.data.bills}
        orphanImages={evidence.data.orphanImages}
        supplierNames={Object.fromEntries((suppliers.data ?? []).map((s) => [s.id, s.name]))}
      />
    </section>
  );
}

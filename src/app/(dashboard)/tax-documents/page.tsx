import Link from "next/link";
import { getTaxDocumentsAccess } from "@/modules/tax/access";
import { listSalesDocuments } from "@/modules/tax/documents-repository";
import { TaxDocumentsManager } from "./TaxDocumentsManager";

export const dynamic = "force-dynamic";

export default async function TaxDocumentsPage() {
  const { ctx, decision } = await getTaxDocumentsAccess();
  if (!decision.allowed) {
    return (
      <section className="page-shell max-w-3xl">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
          <p className="text-sm font-bold text-amber-900">ใบกำกับภาษียังใช้ไม่ได้</p>
          <p className="mt-2 text-sm text-amber-800">{decision.message}</p>
        </div>
      </section>
    );
  }
  const docsRes = await listSalesDocuments(ctx.storeId, 150);

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-[var(--ink)]">ใบกำกับภาษี</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          ออกใบเสร็จรับเงิน/ใบกำกับภาษีเต็มรูปจากบิลที่ชำระแล้ว · คืนเงินหลังออกใบ = ออกใบลดหนี้ ·
          ระบบเตรียมเอกสารให้ ไม่ใช่คำปรึกษาภาษี
        </p>
      </header>

      {!decision.canIssue && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {!decision.vatRegistered
            ? "ยังออกเอกสารไม่ได้ — ตั้งค่าข้อมูลภาษีว่าจด VAT แล้วก่อน"
            : "ยังออกเอกสารไม่ได้ — สาขานี้ยังไม่ได้เปิดใช้ใบกำกับภาษี"}{" "}
          (<Link href="/settings/tax" className="font-semibold underline">ตั้งค่า › ข้อมูลภาษี</Link>)
        </div>
      )}

      {docsRes.error && <p className="alert-danger" role="alert">โหลดเอกสารไม่สำเร็จ: {docsRes.error}</p>}

      <TaxDocumentsManager documents={docsRes.data ?? []} canIssue={decision.canIssue} canVoid={decision.canVoid} />
    </section>
  );
}

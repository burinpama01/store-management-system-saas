import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/modules/auth/session";
import { getTaxDocumentsAccess } from "@/modules/tax/access";
import { SALES_DOCUMENT_TITLES, type SalesDocument } from "@/modules/tax/documents";
import { getSalesDocument } from "@/modules/tax/documents-repository";
import { bahtText } from "@/shared/utils/baht-text";
import { branchLabel } from "@/shared/utils/thai-tax-id";
import { PrintButton } from "@/app/payslip/PrintButton";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(value: number) {
  return new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function thaiDate(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00+07:00`);
  return d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric" });
}

function DocumentSheet({ doc, refDoc, copyLabel }: { doc: SalesDocument; refDoc: SalesDocument | null; copyLabel: string }) {
  const isCredit = doc.docType === "credit_note";
  return (
    <article className="mx-auto mb-8 w-full max-w-[210mm] bg-white p-8 text-[13px] leading-relaxed text-gray-900 shadow print:mb-0 print:max-w-none print:break-after-page print:p-0 print:shadow-none">
      <div className="flex items-start justify-between gap-4 border-b border-gray-300 pb-4">
        <div>
          <p className="text-base font-bold">{doc.seller.legalName}</p>
          <p className="whitespace-pre-line">{doc.seller.address}</p>
          <p>เลขประจำตัวผู้เสียภาษี {doc.seller.taxId} · {branchLabel(doc.seller.branchCode)}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold">{SALES_DOCUMENT_TITLES[doc.docType]}</p>
          <p className="text-sm font-semibold">{copyLabel}</p>
          {doc.status === "cancelled" && <p className="mt-1 text-base font-bold text-red-700">*** ยกเลิก ***</p>}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_auto] gap-4">
        <div>
          <p className="font-semibold">{isCredit ? "ลูกค้า" : "ผู้ซื้อ"}</p>
          <p>{doc.buyer.name}</p>
          {doc.buyer.address && <p className="whitespace-pre-line">{doc.buyer.address}</p>}
          {doc.buyer.taxId && (
            <p>
              เลขประจำตัวผู้เสียภาษี {doc.buyer.taxId}
              {doc.buyer.branchCode ? ` · ${branchLabel(doc.buyer.branchCode)}` : ""}
            </p>
          )}
        </div>
        <div className="text-right">
          <p>เลขที่ <b>{doc.docNo}</b></p>
          <p>วันที่ {thaiDate(doc.issueDate)}</p>
          {doc.orderNumber && <p>อ้างอิงบิลขาย {doc.orderNumber}</p>}
          {isCredit && refDoc && (
            <p>อ้างอิงใบกำกับภาษี {refDoc.docNo} ลงวันที่ {thaiDate(refDoc.issueDate)}</p>
          )}
        </div>
      </div>

      <table className="mt-4 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-y border-gray-400 bg-gray-50">
            <th className="w-10 p-1.5 text-left">ลำดับ</th>
            <th className="p-1.5 text-left">รายการ</th>
            <th className="w-20 p-1.5 text-right">จำนวน</th>
            <th className="w-28 p-1.5 text-right">ราคาต่อหน่วย</th>
            <th className="w-28 p-1.5 text-right">จำนวนเงิน</th>
          </tr>
        </thead>
        <tbody>
          {(doc.lines ?? []).map((line) => (
            <tr key={line.lineNo} className="border-b border-gray-200 align-top">
              <td className="p-1.5">{line.lineNo}</td>
              <td className="p-1.5">{line.description}</td>
              <td className="p-1.5 text-right">{line.quantity.toLocaleString("th-TH")} {line.unitLabel ?? ""}</td>
              <td className="p-1.5 text-right">{money(line.unitPrice)}</td>
              <td className="p-1.5 text-right">{money(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 grid grid-cols-[1fr_auto] gap-6">
        <div className="text-[12px]">
          <p className="rounded border border-gray-300 px-2 py-1 font-semibold">({bahtText(doc.totalAmount)})</p>
          {isCredit && doc.reason && <p className="mt-2">เหตุที่ลดหนี้: {doc.reason}</p>}
          {doc.pricesIncludeVat && !isCredit && <p className="mt-2 text-gray-600">ราคาสินค้ารวมภาษีมูลค่าเพิ่มแล้ว</p>}
        </div>
        <table className="text-[13px]">
          <tbody>
            {isCredit ? (
              <>
                <tr><td className="pr-4">มูลค่าสินค้าตามใบกำกับภาษีเดิม (ก่อนภาษี)</td><td className="text-right">{money(doc.originalTotal ?? 0)}</td></tr>
                <tr><td className="pr-4">มูลค่าสินค้าที่ถูกต้อง (ก่อนภาษี)</td><td className="text-right">{money(doc.correctedTotal ?? 0)}</td></tr>
                <tr><td className="pr-4">ผลต่าง</td><td className="text-right">{money(doc.vatBase)}</td></tr>
                <tr><td className="pr-4">ภาษีมูลค่าเพิ่ม {doc.vatRate}%</td><td className="text-right">{money(doc.vatAmount)}</td></tr>
                <tr className="font-bold"><td className="pr-4">รวมลดหนี้ทั้งสิ้น</td><td className="text-right">{money(doc.totalAmount)}</td></tr>
              </>
            ) : (
              <>
                <tr><td className="pr-4">รวมเป็นเงิน</td><td className="text-right">{money(doc.grossAmount)}</td></tr>
                {doc.discountAmount > 0 && <tr><td className="pr-4">ส่วนลด</td><td className="text-right">-{money(doc.discountAmount)}</td></tr>}
                <tr><td className="pr-4">มูลค่าสินค้าก่อนภาษี</td><td className="text-right">{money(doc.vatBase)}</td></tr>
                <tr><td className="pr-4">ภาษีมูลค่าเพิ่ม {doc.vatRate}%</td><td className="text-right">{money(doc.vatAmount)}</td></tr>
                <tr className="font-bold"><td className="pr-4">จำนวนเงินรวมทั้งสิ้น</td><td className="text-right">{money(doc.totalAmount)}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-16 grid grid-cols-2 gap-10 text-center text-[12px]">
        <div><div className="border-t border-gray-400 pt-1">ผู้รับเอกสาร</div></div>
        <div><div className="border-t border-gray-400 pt-1">ผู้มีอำนาจลงนาม / ผู้รับเงิน</div></div>
      </div>
    </article>
  );
}

export default async function TaxDocumentPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { ctx, decision } = await getTaxDocumentsAccess();
  if (!decision.allowed) redirect("/tax-documents");

  const docRes = await getSalesDocument(ctx.storeId, id);
  if (!docRes.data) notFound();
  const doc = docRes.data;
  const refDoc = doc.refDocumentId ? (await getSalesDocument(ctx.storeId, doc.refDocumentId)).data : null;

  return (
    <main className="min-h-screen bg-gray-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] items-center justify-between px-2 print:hidden">
        <p className="text-sm text-gray-600">พิมพ์ 2 แผ่น: ต้นฉบับให้ผู้ซื้อ · สำเนาเก็บไว้ที่ร้าน</p>
        <PrintButton />
      </div>
      <DocumentSheet doc={doc} refDoc={refDoc} copyLabel="ต้นฉบับ (ลูกค้า)" />
      <DocumentSheet doc={doc} refDoc={refDoc} copyLabel="สำเนา" />
      <style>{"@page { size: A4; margin: 12mm; }"}</style>
    </main>
  );
}

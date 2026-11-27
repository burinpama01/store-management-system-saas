import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { isOpsManagerRole } from "@/modules/operations/access";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { isTaxDocumentsEnabled } from "@/modules/tax/documents-repository";
import { getStoreTaxProfile, listDocumentSequences } from "@/modules/tax/repository";
import { canIssueAbbreviatedTaxInvoice, canIssueFullTaxInvoice } from "@/modules/tax/rules";
import { DOCUMENT_LABELS } from "@/modules/tax/types";
import { TaxDocumentsToggle } from "./TaxDocumentsToggle";
import { TaxProfileForm } from "./TaxProfileForm";

export const dynamic = "force-dynamic";

export default async function TaxSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!isOpsManagerRole(ctx.role)) redirect("/settings/store");

  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasTaxDocuments = canUseFeature(billing, "taxDocuments");
  const [profileRes, sequencesRes, docsEnabled] = await Promise.all([
    getStoreTaxProfile(ctx.storeId),
    listDocumentSequences(ctx.storeId),
    hasTaxDocuments ? isTaxDocumentsEnabled(ctx.storeId) : Promise.resolve(false),
  ]);
  const profile = profileRes.data ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">ข้อมูลภาษีของสาขา</h2>
        <p className="text-sm text-gray-600">
          ชื่อ ที่อยู่ เลขผู้เสียภาษี และสาขา ตามที่จดทะเบียน — ใช้พิมพ์บนใบกำกับภาษี ใบลดหนี้ และ 50 ทวิ
          (ระบบเตรียมเอกสารและตัวเลขให้ ไม่ได้ยื่นแบบแทน และไม่ใช่คำปรึกษาภาษี)
        </p>
      </div>

      {profileRes.error && <p className="alert-danger" role="alert">โหลดข้อมูลภาษีไม่สำเร็จ: {profileRes.error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
          <p className="font-semibold text-gray-900">ใบกำกับภาษีเต็มรูป</p>
          <p className={canIssueFullTaxInvoice(profile) ? "text-green-700" : "text-gray-600"}>
            {!hasTaxDocuments
              ? "มีในแพ็กเกจ Enterprise"
              : canIssueFullTaxInvoice(profile)
                ? docsEnabled
                  ? "เปิดใช้แล้ว — ออกได้ที่เมนู ใบกำกับภาษี"
                  : "พร้อมเปิด (จด VAT แล้ว)"
                : "ยังไม่พร้อม — ต้องตั้งค่าว่าจด VAT แล้ว"}
          </p>
          {hasTaxDocuments && (
            <TaxDocumentsToggle enabled={docsEnabled} ready={canIssueFullTaxInvoice(profile)} />
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
          <p className="font-semibold text-gray-900">ใบกำกับภาษีอย่างย่อจาก POS</p>
          <p className={canIssueAbbreviatedTaxInvoice(profile) ? "text-green-700" : "text-gray-600"}>
            {canIssueAbbreviatedTaxInvoice(profile)
              ? "มีเลขอนุมัติเครื่องแล้ว"
              : "ต้องได้รับอนุมัติเครื่องบันทึกการเก็บเงิน (ภ.พ.06) จากกรมสรรพากรก่อน — ระหว่างนี้ใบเสร็จพิมพ์เป็นใบเสร็จธรรมดา"}
          </p>
        </div>
      </div>

      <TaxProfileForm profile={profile} />

      {sequencesRes.data && sequencesRes.data.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-900">เลขที่เอกสารที่ออกไปแล้ว</p>
          <ul className="mt-2 space-y-1 text-sm text-gray-700">
            {sequencesRes.data.map((s) => (
              <li key={`${s.docType}-${s.period}`}>
                {DOCUMENT_LABELS[s.docType]} · งวด {s.period} · ล่าสุดเลขที่ {s.lastIssuedNo}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

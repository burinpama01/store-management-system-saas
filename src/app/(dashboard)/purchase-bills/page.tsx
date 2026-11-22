import { getPurchaseSubmitAccess } from "@/modules/purchasing/access";
import { listMyPurchaseBills, listSubmitOptions } from "@/modules/purchasing/repository";
import { SubmitBillForm } from "./SubmitBillForm";

export const dynamic = "force-dynamic";

/** ส่งบิลซื้อ (พนักงานทุกระดับ) — บิลตลาด/เขียนมือ ต้องแนบรูป และรออนุมัติ (Plan v5) */
export default async function PurchaseBillsSubmitPage() {
  const { user, ctx, decision } = await getPurchaseSubmitAccess();
  if (!decision.allowed) {
    return (
      <section className="page-shell max-w-3xl">
        <h1 className="text-xl font-bold text-[var(--ink)]">ส่งบิลซื้อ</h1>
        <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">{decision.message}</p>
      </section>
    );
  }
  const [options, mine] = await Promise.all([listSubmitOptions(ctx.storeId), listMyPurchaseBills(ctx.storeId, user.id)]);
  const error = options.error ?? mine.error;
  return (
    <section className="page-shell max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[var(--ink)]">ส่งบิลซื้อ</h1>
        <p className="text-sm text-[var(--muted)]">
          ซื้อของตลาด/ไม่มีใบเสร็จ: เขียนบิลเงินสด ถ่ายรูปแนบ แล้วส่ง — ผู้จัดการหรือเจ้าของอนุมัติก่อนเข้าคลัง · รูปทุกใบเก็บไว้เป็นหลักฐาน
        </p>
      </div>
      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : (
        <SubmitBillForm
          ingredients={options.data?.ingredients ?? []}
          categories={options.data?.categories ?? []}
          myBills={mine.data ?? []}
          role={ctx.role}
        />
      )}
    </section>
  );
}

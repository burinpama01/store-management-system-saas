import { getConsignmentAccess } from "@/modules/consignment/access";
import { listSuppliers } from "@/modules/inventory/repository";
import { SuppliersManager } from "../costing/suppliers/SuppliersManager";
import { saveConsignmentSupplierAction } from "./actions";
import { ConsignmentToggle } from "./ConsignmentToggle";

export const dynamic = "force-dynamic";

function Locked({ message }: { message: string }) {
  return (
    <section className="page-shell max-w-3xl">
      <div className="rounded-md border border-amber-200 bg-amber-50 p-5">
        <p className="text-sm font-bold text-amber-900">สินค้าซื้อขาด/ฝากขาย ยังใช้ไม่ได้</p>
        <p className="mt-2 text-sm text-amber-800">{message}</p>
      </div>
    </section>
  );
}

export default async function ConsignmentPage() {
  const { ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return <Locked message={decision.message} />;
  const suppliersRes = await listSuppliers(ctx.storeId);
  if (suppliersRes.error) return <Locked message={suppliersRes.error} />;

  return (
    <section className="page-shell max-w-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-bold text-[var(--ink)]">สินค้าซื้อขาด / ฝากขาย</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          รับขนมหรือสินค้าจากร้านอื่นมาขาย · ซื้อขาดจ่ายตอนรับของ · ฝากขายจ่ายเจ้าของเฉพาะที่ขายได้
        </p>
      </header>

      <ConsignmentToggle enabled={decision.enabled} canToggle={decision.canToggle} />

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-[var(--ink)]">เจ้าของสินค้า / ผู้ขาย</h2>
        <p className="text-sm text-[var(--muted)]">
          ตั้งวิธีรับเงิน (เงินสด/โอน) และรอบเคลียร์เงิน (ทุกวันตอนปิดรอบ หรือตอนมาเติมของ) ของแต่ละราย · ใช้ทะเบียนเดียวกับผู้ขายวัตถุดิบ
        </p>
      </div>
      <SuppliersManager
        suppliers={suppliersRes.data ?? []}
        canEdit={decision.canManageSuppliers}
        saveAction={saveConsignmentSupplierAction}
        showConsignment
      />
    </section>
  );
}

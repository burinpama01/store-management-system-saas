// deps จริงของ tool บัญชี — แยกจากไฟล์ tool เพื่อให้ตัว tool ทดสอบได้โดยไม่ต้องมี DB
//
// เรียกชั้น repository เดียวกับที่หน้าเว็บใช้ ไม่ลง query เอง — กติกาทางธุรกิจที่อยู่
// ในชั้นนั้น (เช่นค่าเริ่มต้นของช่องทางชำระ) จึงเป็นชุดเดียวกันทั้งสองทาง

import {
  createTransaction,
  listAccountingCategories,
  listTransactions,
} from "@/modules/accounting/repository";
import type { AccountingToolDeps } from "./accounting-tools";

export function createServerAccountingToolDeps(): AccountingToolDeps {
  return {
    async listCategories(storeId) {
      const result = await listAccountingCategories(storeId);
      if (result.error) throw new Error("Assistant accounting categories unavailable");
      return result.data ?? [];
    },
    async listRecentTransactions(storeId, limit) {
      // ดึงหน้าเดียวพอ — ใช้เดาหมวดจากรายการล่าสุด ไม่ได้ทำรายงาน
      // (Supabase egress ยังเกินโควตาอยู่ อย่าดึงประวัติทั้งร้านมาเดาหมวดเด็ดขาด)
      const result = await listTransactions(storeId, { pageSize: Math.min(100, limit), page: 1 });
      if (result.error) throw new Error("Assistant accounting history unavailable");
      return result.data ?? [];
    },
    async createTransaction(input) {
      const result = await createTransaction({
        storeId: input.storeId,
        organizationId: input.organizationId,
        type: input.type,
        categoryId: input.categoryId,
        categoryName: input.categoryName,
        amount: input.amount,
        note: input.note,
        date: input.date,
        createdByUserId: input.createdByUserId,
      });
      if (result.error || !result.data) throw new Error("Assistant accounting write failed");
      return { id: result.data.id };
    },
  };
}

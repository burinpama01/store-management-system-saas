"use server";

/**
 * เจ้าของ/ผู้จัดการ: อนุมัติ+จ่าย, ไม่อนุมัติ, บันทึกเบิกแทนพนักงาน (B3, B4)
 * attendance.manage + แพ็กมีสิทธิ์ + เปิดสวิตช์ · ตรวจเพดานซ้ำทุกครั้ง · log + แจ้งพนักงาน
 */
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { listStoreMemberships } from "@/modules/settings/repository";
import { logSystemEvent } from "@/modules/system/event-log";
import { getAdvanceAvailability } from "@/modules/hr/advanced/salary-advance-service";
import { getAdvancedPayrollAccess } from "@/modules/hr/advanced/store-payroll";
import {
  getSalaryAdvance,
  insertSalaryAdvance,
  recordAdvanceExpense,
  updateSalaryAdvanceFrom,
} from "@/modules/hr/advanced/repository";
import { formatBaht, pushPayrollNotification } from "@/modules/hr/advanced/notify";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context() {
  await requirePermission("attendance.manage");
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  const access = await getAdvancedPayrollAccess(ctx.organizationId, ctx.storeId);
  if (!access.entitled || !access.settings.switches.salaryAdvance) throw new Error("ต้องเปิด \"พนักงานเบิกเงินล่วงหน้า\" ก่อน");
  return { user, ctx };
}

function done() {
  revalidatePath("/staff", "page");
  revalidatePath("/my-advance", "page");
  revalidatePath("/accounting", "page");
}

function parseAmount(raw: FormDataEntryValue | null): number {
  return Math.round(parseFloat(String(raw ?? "").replace(/,/g, "")) * 100) / 100;
}

async function payAndRecord(input: {
  ctx: { organizationId: string; storeId: string };
  actorUserId: string;
  advanceId: string;
  userId: string;
  employeeName: string;
  amount: number;
  payMethod: "cash" | "transfer";
  today: string;
}): Promise<string | null> {
  const expense = await recordAdvanceExpense({
    storeId: input.ctx.storeId,
    organizationId: input.ctx.organizationId,
    amount: input.amount,
    payMethod: input.payMethod,
    date: input.today,
    note: `เบิกเงิน: ${input.employeeName}`,
    actorUserId: input.actorUserId,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ผูก/ย้อนรายจ่ายของคำขอ
  const db: any = await createSupabaseServiceClient();
  if (expense.error) {
    // บันทึกไม่ครบ = ย้อนรายจ่ายที่ค้างครึ่งทาง (ลบรายการ) ให้ผู้เรียกย้อนสถานะคำขอ
    if (expense.transactionId) {
      const c1 = await db.from("cash_ledger_entries").delete().eq("transaction_id", expense.transactionId).eq("store_id", input.ctx.storeId);
      const c2 = await db.from("transactions").delete().eq("id", expense.transactionId).eq("store_id", input.ctx.storeId);
      if (c1.error || c2.error) {
        await logSystemEvent({
          level: "error",
          source: "hr.salary-advance",
          action: "payAndRecordCleanupFailed",
          message: `ย้อนรายจ่ายเบิกเงินที่ค้างไม่สำเร็จ — ตรวจรายการ ${expense.transactionId} ที่หน้าบัญชี`,
          organizationId: input.ctx.organizationId,
          storeId: input.ctx.storeId,
          actorUserId: input.actorUserId,
          context: { transactionId: expense.transactionId, ledgerError: c1.error?.message ?? null, txError: c2.error?.message ?? null },
        });
      }
    }
    await logSystemEvent({
      level: "error",
      source: "hr.salary-advance",
      action: "recordAdvanceExpense",
      message: `อนุมัติเบิกเงินแล้ว แต่บันทึกรายจ่าย/เงินสดไม่ครบ: ${expense.error}`,
      organizationId: input.ctx.organizationId,
      storeId: input.ctx.storeId,
      actorUserId: input.actorUserId,
      context: { advanceId: input.advanceId, amount: input.amount, payMethod: input.payMethod },
    });
    return `บันทึกรายจ่าย/เงินสดไม่สำเร็จ: ${expense.error}`;
  }
  await db.from("salary_advances").update({ transaction_id: expense.transactionId }).eq("id", input.advanceId).eq("store_id", input.ctx.storeId);
  return null;
}

export async function approveSalaryAdvanceAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const { user, ctx } = await context();
    const id = String(formData.get("id") ?? "");
    if (!UUID_RE.test(id)) return { error: "คำขอไม่ถูกต้อง" };
    const payMethod = formData.get("payMethod") === "transfer" ? "transfer" : "cash";
    const adv = await getSalaryAdvance(ctx.storeId, id);
    if (!adv || adv.status !== "pending") return { error: "คำขอนี้ถูกดำเนินการไปแล้ว" };
    const amount = formData.has("amount") ? parseAmount(formData.get("amount")) : adv.requestedAmount;
    if (!(amount > 0) || amount > adv.requestedAmount) return { error: `ยอดอนุมัติต้องมากกว่า 0 และไม่เกินยอดที่ขอ (${formatBaht(adv.requestedAmount)})` };

    const av = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: adv.userId, excludeAdvanceId: id });
    if (amount > av.cap.available) {
      return { error: `ตอนนี้เบิกได้สูงสุด ${formatBaht(av.cap.available)} ตามค่าแรงจากวันที่มาแล้ว — ปรับยอดลงก่อนอนุมัติ` };
    }
    const claimed = await updateSalaryAdvanceFrom(ctx.storeId, id, "pending", {
      status: "paid",
      approved_amount: amount,
      pay_method: payMethod,
      paid_date: av.today,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decision_note: String(formData.get("note") ?? "").trim().slice(0, 200) || null,
    });
    if (claimed.error) return { error: "อนุมัติไม่สำเร็จ" };
    if (!claimed.data) return { error: "คำขอนี้ถูกดำเนินการไปแล้ว" };
    const revert = () =>
      updateSalaryAdvanceFrom(ctx.storeId, id, "paid", {
        status: "pending",
        approved_amount: null,
        pay_method: null,
        paid_date: null,
        decided_by: null,
        decided_at: null,
        decision_note: null,
      });
    // ตรวจซ้ำหลังอนุมัติ: อนุมัติคำขออื่นของคนเดียวกันพร้อมกันจนเกินเพดาน = ย้อนกลับเป็นรออนุมัติ
    const after = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId: adv.userId });
    if (after.cap.overLimit) {
      await revert();
      return { error: "มีการอนุมัติ/เบิกอื่นพร้อมกันจนเกินเพดาน — ลองใหม่อีกครั้ง" };
    }

    const failed = await payAndRecord({ ctx, actorUserId: user.id, advanceId: id, userId: adv.userId, employeeName: av.employeeName, amount, payMethod, today: av.today });
    if (failed) {
      await revert();
      return { error: `ยังไม่ได้อนุมัติ — ${failed}` };
    }
    await logSystemEvent({
      level: "info",
      source: "hr.salary-advance",
      action: "approveSalaryAdvanceAction",
      message: `อนุมัติเบิกเงิน ${av.employeeName} ${formatBaht(amount)} (${payMethod === "cash" ? "เงินสด" : "โอน"})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { advanceId: id, employeeUserId: adv.userId, requested: adv.requestedAmount, approved: amount, payMethod },
    });
    await pushPayrollNotification({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userIds: [adv.userId],
      kind: "advance_paid",
      dedupeKey: id,
      title: `อนุมัติเบิกเงิน ${formatBaht(amount)} แล้ว`,
      message: `${payMethod === "cash" ? "รับเงินสดที่ร้าน" : "โอนเข้าบัญชี"} · หักจากเงินเดือนรอบนี้อัตโนมัติ`,
    }).catch(() => undefined);
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function rejectSalaryAdvanceAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const { user, ctx } = await context();
    const id = String(formData.get("id") ?? "");
    if (!UUID_RE.test(id)) return { error: "คำขอไม่ถูกต้อง" };
    const note = String(formData.get("note") ?? "").trim().slice(0, 200);
    const adv = await getSalaryAdvance(ctx.storeId, id);
    if (!adv) return { error: "ไม่พบคำขอ" };
    const r = await updateSalaryAdvanceFrom(ctx.storeId, id, "pending", {
      status: "rejected",
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decision_note: note || null,
    });
    if (r.error) return { error: "บันทึกไม่สำเร็จ" };
    if (!r.data) return { error: "คำขอนี้ถูกดำเนินการไปแล้ว" };
    await logSystemEvent({
      level: "info",
      source: "hr.salary-advance",
      action: "rejectSalaryAdvanceAction",
      message: `ไม่อนุมัติคำขอเบิก ${formatBaht(adv.requestedAmount)}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { advanceId: id, employeeUserId: adv.userId },
    });
    await pushPayrollNotification({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userIds: [adv.userId],
      kind: "advance_rejected",
      dedupeKey: id,
      title: "คำขอเบิกเงินไม่ได้รับอนุมัติ",
      message: `ยอด ${formatBaht(adv.requestedAmount)}${note ? ` · ${note}` : ""}`,
    }).catch(() => undefined);
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** ผู้จัดการบันทึกการเบิกแทนพนักงาน (เบิกหน้าร้าน) — จ่ายทันที ภายใต้เพดานเดียวกัน */
export async function recordSalaryAdvanceForEmployeeAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    const { user, ctx } = await context();
    const userId = String(formData.get("userId") ?? "");
    if (!UUID_RE.test(userId)) return { error: "เลือกพนักงาน" };
    // ผู้จัดการบันทึกเบิกให้ตัวเองไม่ได้ (ต้องขอผ่านเมนูเบิกเงินให้คนอื่นอนุมัติ)
    if (userId === user.id) return { error: "บันทึกเบิกให้ตัวเองไม่ได้ — ขอผ่านเมนู \"เบิกเงิน\" ให้เจ้าของ/ผู้จัดการคนอื่นอนุมัติ" };
    const { data: members } = await listStoreMemberships(ctx.organizationId, ctx.storeId);
    if (!(members ?? []).some((m) => m.userId === userId && m.role !== "super_admin")) return { error: "ไม่พบพนักงานในสาขานี้" };
    const amount = parseAmount(formData.get("amount"));
    if (!(amount > 0)) return { error: "ใส่จำนวนเงิน" };
    const payMethod = formData.get("payMethod") === "transfer" ? "transfer" : "cash";
    const reason = String(formData.get("reason") ?? "").trim().slice(0, 200);

    const av = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId });
    if (!av.hasProfile) return { error: "พนักงานคนนี้ยังไม่ได้ตั้งค่าจ้าง" };
    if (av.cap.blockedReason) return { error: av.cap.blockedReason };
    if (amount > av.cap.available) return { error: `เบิกได้ไม่เกิน ${formatBaht(av.cap.available)} ตามค่าแรงจากวันที่มาแล้ว` };

    const created = await insertSalaryAdvance({
      organization_id: ctx.organizationId,
      store_id: ctx.storeId,
      user_id: userId,
      status: "paid",
      requested_amount: amount,
      approved_amount: amount,
      reason: reason || null,
      cycle_start: av.cycle.start,
      requested_by: user.id,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      pay_method: payMethod,
      paid_date: av.today,
    });
    if (created.error || !created.data) return { error: "บันทึกไม่สำเร็จ" };
    const cancel = (note: string) => updateSalaryAdvanceFrom(ctx.storeId, created.data!.id, "paid", { status: "cancelled", decision_note: note });
    const after = await getAdvanceAvailability({ organizationId: ctx.organizationId, storeId: ctx.storeId, userId });
    if (after.cap.overLimit) {
      await cancel("เกินเพดาน (บันทึกซ้อนกัน)");
      return { error: "มีการเบิกอื่นพร้อมกันจนเกินเพดาน — ตรวจยอดแล้วลองใหม่" };
    }
    const failed = await payAndRecord({ ctx, actorUserId: user.id, advanceId: created.data.id, userId, employeeName: av.employeeName, amount, payMethod, today: av.today });
    if (failed) {
      await cancel("บันทึกรายจ่ายไม่สำเร็จ");
      return { error: `ยังไม่ได้บันทึกการเบิก — ${failed}` };
    }
    await logSystemEvent({
      level: "info",
      source: "hr.salary-advance",
      action: "recordSalaryAdvanceForEmployeeAction",
      message: `บันทึกเบิกเงินแทน ${av.employeeName} ${formatBaht(amount)} (${payMethod === "cash" ? "เงินสด" : "โอน"})`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { advanceId: created.data.id, employeeUserId: userId, amount, payMethod },
    });
    await pushPayrollNotification({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userIds: [userId],
      kind: "advance_paid",
      dedupeKey: created.data.id,
      title: `บันทึกการเบิกเงิน ${formatBaht(amount)}`,
      message: "หักจากเงินเดือนรอบนี้อัตโนมัติ",
    }).catch(() => undefined);
    done();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
